/**
 * M2 startup contract against a real, keyless atlas-local (CI job
 * `boot-control`). Keyless on purpose: nothing here embeds, and keyless
 * mongot refuses autoEmbed definitions, which is itself one of the controls.
 *
 *   - no Search: a mongod without mongot fails typed (needs
 *     MEMONGO_BOOT_CONTROL_NO_SEARCH_URI, which the CI job starts);
 *   - repair: boot creates a missing manifest index; keyless, the first
 *     autoEmbed create is then refused typed (autoembed-unavailable);
 *   - unrepaired: a wrong-type index fails boot typed before any write, and
 *     the built API exits 1 without ever binding its port;
 *   - denied privileges: a read-only user fails fast, before any write.
 *
 * FAILED and STALE cannot be provoked on demand on a real server; they are
 * covered by the fake-Db controls in mongodb-boot-contract.test.ts, which the
 * same CI job runs.
 *
 * Run: MEMONGO_BOOT_CONTROL=1 MEMONGO_TEST_MONGODB_URI=... bunx vitest run --config vitest.e2e.config.ts src/mongodb-boot-contract.e2e.test.ts
 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { enforceBootContract } from "./mongodb-boot-contract.js"
import { isMemongoBootError } from "./mongodb-boot-errors.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"

// Explicit URIs only: this suite never discovers a local container.
const TEST_URI = process.env.MEMONGO_TEST_MONGODB_URI?.trim() ?? ""
const NO_SEARCH_URI = process.env.MEMONGO_BOOT_CONTROL_NO_SEARCH_URI
const RUN = randomUUID().slice(0, 8)
const API_SERVER = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../apps/api/dist/server.js",
)
const ENV = {} as NodeJS.ProcessEnv

let client: MongoClient
const databases: Db[] = []

function freshDb(label: string): Db {
	const db = client.db(`memongo_bootctl_${label}_${RUN}`)
	databases.push(db)
	return db
}

async function bootFailure(promise: Promise<unknown>) {
	const err = await promise.then(
		() => undefined,
		(error: unknown) => error,
	)
	expect(isMemongoBootError(err), String(err)).toBe(true)
	return err as import("./mongodb-boot-errors.js").MemongoBootError
}

async function searchIndexNames(db: Db, collection: string): Promise<string[]> {
	const indexes = await db
		.collection(collection)
		.aggregate([{ $listSearchIndexes: {} }])
		.toArray()
	return indexes.map((index) => String(index.name))
}

async function createWrongTypeChunksText(db: Db, prefix: string) {
	await db.createCollection(`${prefix}chunks`)
	await db.collection(`${prefix}chunks`).createSearchIndex({
		name: `${prefix}chunks_text`,
		type: "vectorSearch",
		definition: {
			fields: [
				{
					type: "vector",
					path: "embedding",
					numDimensions: 4,
					similarity: "cosine",
				},
			],
		},
	})
}

beforeAll(async () => {
	if (process.env.MEMONGO_BOOT_CONTROL !== "1") return
	if (!TEST_URI) throw new Error("MEMONGO_TEST_MONGODB_URI is required")
	client = new MongoClient(TEST_URI)
	await client.connect()
})

afterAll(async () => {
	for (const db of databases) await db.dropDatabase().catch(() => undefined)
	await client
		?.db("admin")
		.command({ dropUser: `bootctl_reader_${RUN}` })
		.catch(() => undefined)
	await client?.close()
})

describe.skipIf(process.env.MEMONGO_BOOT_CONTROL !== "1")(
	"startup contract on a real keyless deployment (MEMONGO_BOOT_CONTROL=1)",
	() => {
		it.skipIf(!NO_SEARCH_URI)(
			"fails typed when the deployment has no Search",
			async () => {
				const noSearch = new MongoClient(NO_SEARCH_URI as string)
				await noSearch.connect()
				try {
					const err = await bootFailure(
						enforceBootContract(
							noSearch.db(`memongo_bootctl_nosearch_${RUN}`),
							{
								prefix: "bootctl_",
								env: ENV,
								mode: "repair",
								deadlineMs: 30_000,
							},
						),
					)
					expect(err.code).toBe("search-management-unavailable")
				} finally {
					await noSearch.close()
				}
			},
			60_000,
		)

		it("repairs a missing manifest index, then refuses keyless autoEmbed typed", async () => {
			const db = freshDb("repair")
			// The manager runs ensureCollections before the contract; mirror it.
			for (const name of new Set(
				buildRequiredIndexManifest({ prefix: "bootctl_", env: ENV }).map(
					(entry) => entry.collectionName,
				),
			)) {
				await db.createCollection(name)
			}
			const err = await bootFailure(
				enforceBootContract(db, {
					prefix: "bootctl_",
					env: ENV,
					mode: "repair",
					deadlineMs: 180_000,
				}),
			)
			// Keyless mongot either refuses the autoEmbed create, fails the build,
			// or never makes it READY within the deadline; each is typed.
			expect([
				"autoembed-unavailable",
				"index-failed",
				"index-not-ready",
			]).toContain(err.code)
			expect(
				err.failures.every((failure) => failure.index?.endsWith("_vector")),
			).toBe(true)
			expect(err.index).toMatch(/_vector$/)
			expect(await searchIndexNames(db, "bootctl_chunks")).toContain(
				"bootctl_chunks_text",
			)
		}, 240_000)

		it("fails typed on a wrong-type index before any repair write", async () => {
			const db = freshDb("unrepaired")
			await createWrongTypeChunksText(db, "bootctl_")
			const err = await bootFailure(
				enforceBootContract(db, {
					prefix: "bootctl_",
					env: ENV,
					mode: "repair",
					deadlineMs: 60_000,
				}),
			)
			expect(err.code).toBe("index-type-mismatch")
			expect(err.index).toBe("bootctl_chunks_text")
			expect(await searchIndexNames(db, "bootctl_chunks")).toEqual([
				"bootctl_chunks_text",
			])
		}, 120_000)

		it("the built API exits 1 on an unrepaired index and never binds its port", async () => {
			expect(existsSync(API_SERVER), `${API_SERVER} (run bun run build)`).toBe(
				true,
			)
			const db = freshDb("api")
			await createWrongTypeChunksText(db, "bootctl_")
			const port = 39_000 + Math.floor(Math.random() * 1_000)
			const child = spawn(process.execPath, [API_SERVER], {
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					MEMONGO_MONGODB_URI: TEST_URI,
					MEMONGO_MONGODB_DATABASE: db.databaseName,
					MEMONGO_MONGODB_COLLECTION_PREFIX: "bootctl_",
					MEMONGO_AGENT_ID: `bootctl-${RUN}`,
					MEMONGO_API_HOST: "127.0.0.1",
					MEMONGO_API_PORT: String(port),
					MEMONGO_API_KEY: randomUUID(),
				},
				stdio: ["ignore", "pipe", "pipe"],
			})
			let output = ""
			child.stdout.on("data", (chunk) => {
				output += String(chunk)
			})
			child.stderr.on("data", (chunk) => {
				output += String(chunk)
			})
			let answered = false
			const poll = setInterval(() => {
				fetch(`http://127.0.0.1:${port}/health`).then(
					() => {
						answered = true
					},
					() => undefined,
				)
			}, 250)
			const code = await new Promise<number | null>((resolve) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL")
					resolve(null)
				}, 120_000)
				child.on("exit", (exitCode) => {
					clearTimeout(timer)
					resolve(exitCode)
				})
			})
			clearInterval(poll)
			expect(code, output).toBe(1)
			expect(output).toContain("boot failure index-type-mismatch")
			expect(output).not.toContain("listening on")
			expect(answered).toBe(false)
		}, 150_000)

		it("fails fast for a user without Search index management privileges, before any write", async () => {
			const db = freshDb("denied")
			const user = `bootctl_reader_${RUN}`
			const password = randomUUID()
			await client.db("admin").command({
				createUser: user,
				pwd: password,
				roles: [{ role: "read", db: db.databaseName }],
			})
			const uri = new URL(TEST_URI)
			uri.username = user
			uri.password = password
			uri.searchParams.set("authSource", "admin")
			const reader = new MongoClient(uri.toString())
			await reader.connect()
			const started = Date.now()
			try {
				const err = await bootFailure(
					enforceBootContract(reader.db(db.databaseName), {
						prefix: "bootctl_",
						env: ENV,
						mode: "repair",
						deadlineMs: 180_000,
					}),
				)
				expect(err.code).toBe("search-privileges-denied")
				expect(Date.now() - started).toBeLessThan(30_000)
			} finally {
				await reader.close()
			}
			expect(await db.listCollections().toArray()).toEqual([])
		}, 60_000)
	},
)
