/**
 * End-to-end converter proof against a private MongoDB 9 binary.
 *
 * Boots a disposable single-node replica set from the private build
 * (override the default location with MEMONGO_PRIVATE9_MONGOD; clones
 * without the binary skip this file), seeds time-series sources with
 * duplicate/missing/nested `_id` values and mixed BSON types, then drives
 * the real CLI end to end:
 *
 *   dry run              - plans only, mutates nothing, writes no state
 *   dry run + ack        - reports adopting the canonical TTL where a source
 *                          differs, still mutates nothing
 *   apply                - converts telemetry, stops at the unacknowledged
 *                          access-events retention change, source untouched
 *   abort after install  - refuses (an installation is not undoable), and a
 *                          mismatched database in the environment is refused
 *   apply + ack          - resumes from the recorded state and completes
 *   apply again          - idempotent, no data amplification
 *   abort (separate db)  - drops only the owned candidate, keeps the source
 *   restart-from-copy    - a deleted verified candidate with the owned source
 *                          intact persists a valid restart checkpoint; the
 *                          retry recopies and completes
 *   startup oracle       - the engine's ensureOrdinaryDiagnosticCollection
 *                          accepts the installed TTLs and rejects others
 *
 * Run (from the repo root, with the private binary available):
 *   MEMONGO_MONGODB_URI is set by the test itself; nothing else is required.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BSON, MongoClient, ObjectId, type Db } from "mongodb"
import {
	CANDIDATE_SUFFIX,
	STATE_VERSION,
	digestCollection,
	digestsEqual,
	inspectNamespace,
	runCopyPhase,
	runInstallPhase,
	runVerifyPhase,
	saveState,
	type DigestMultiset,
	type StateFile,
	type SurfaceState,
} from "./migrate-diagnostics-to-ordinary.js"
import { ensureOrdinaryDiagnosticCollection } from "../packages/memory-engine/src/mongodb-schema-collections.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(here, "migrate-diagnostics-to-ordinary.ts")
const mongodPath =
	process.env.MEMONGO_PRIVATE9_MONGOD?.trim() ||
	path.resolve(
		here,
		"..",
		".orchestrator",
		"evidence",
		"mongodb9-root",
		"mongod",
	)

const bunAvailable = (() => {
	try {
		const result = spawnSync("bun", ["--version"], {
			encoding: "utf8",
			timeout: 15_000,
		})
		return result.status === 0
	} catch {
		return false
	}
})()

const telemetryName = "memongo_memory_telemetry"
const accessName = "memongo_access_events"
const telemetryCandidate = `${telemetryName}${CANDIDATE_SUFFIX}`
const accessCandidate = `${accessName}${CANDIDATE_SUFFIX}`

const runId = Math.random().toString(16).slice(2, 12)
const abortDatabase = `migrate_abort_${runId}`
const copiedResumeDatabase = `migrate_copied_resume_${runId}`
const legacyCopiedDatabase = `migrate_legacy_copied_${runId}`
const uncertainOutDatabase = `migrate_uncertain_out_${runId}`
const uncertainOutForeignDatabase = `migrate_uncertain_out_foreign_${runId}`
const uncertainRenameDatabase = `migrate_uncertain_rename_${runId}`
const snapshotBoundaryDatabase = `migrate_snapshot_boundary_${runId}`
const readFailureDatabase = `migrate_read_failure_${runId}`
const foreignCandidateDatabase = `migrate_foreign_candidate_${runId}`
const snapshotTooOldDatabase = `migrate_snapshot_too_old_${runId}`
const foreignCanonicalDatabase = `migrate_foreign_canonical_${runId}`
const literalWrapperDatabase = `migrate_literal_wrapper_${runId}`
const redirectedStateDatabase = `migrate_redirected_state_${runId}`
const uncertainRenameAbortDatabase = `migrate_uncertain_rename_abort_${runId}`
const ttlRetryDatabase = `migrate_ttl_retry_${runId}`
const staleCompleteDatabase = `migrate_stale_complete_${runId}`
const deletedCandidateRestartDatabase = `migrate_deleted_candidate_restart_${runId}`

let workDir = ""
let dbDir = ""
let statePath = ""
let abortStatePath = ""
let uri = ""
let mongod: ReturnType<typeof spawn> | null = null
let client: MongoClient | null = null
let db: Db | null = null
let telemetryDigestBefore: DigestMultiset | null = null
let accessDigestBefore: DigestMultiset | null = null

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo
			server.close(() => resolve(port))
		})
	})
}

function runCli(args: string[], env: Record<string, string> = {}) {
	const result = spawnSync("bun", [scriptPath, ...args], {
		env: { ...process.env, MEMONGO_MONGODB_URI: uri, ...env },
		encoding: "utf8",
		timeout: 120_000,
		cwd: workDir,
	})
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	}
}

function parseReceipt(stdout: string) {
	const start = stdout.indexOf("{\n")
	expect(start).toBeGreaterThanOrEqual(0)
	return JSON.parse(stdout.slice(start)) as {
		mode: string
		server: { version: string; fcv: string }
		surfaces: Array<{
			surface: string
			phase: string
			retentionSeconds: number | null
			documentCount: number | null
			note: string | null
		}>
	}
}

type RawInfo = {
	name: string
	type?: string
	options?: { expireAfterSeconds?: unknown }
	info?: { uuid?: unknown }
}

type SeedDocument = {
	_id?: BSON.Int32 | ObjectId | string | Record<string, string | boolean>
	[key: string]: unknown
}

async function collectionInfo(
	target: Db,
	name: string,
): Promise<RawInfo | undefined> {
	const [raw] = await target.listCollections({ name }).toArray()
	return raw as RawInfo | undefined
}

async function ttlIndex(target: Db, name: string) {
	const indexes = (await target
		.collection(name)
		.listIndexes()
		.toArray()) as Array<{
		key?: unknown
		expireAfterSeconds?: number
	}>
	return indexes.find((index) => index.expireAfterSeconds !== undefined)
}

async function collectionNames(target: Db): Promise<string[]> {
	return (await target.listCollections().toArray()).map((entry) => entry.name)
}

async function createRecoverySource(
	target: Db,
	database: string,
	extraDocuments: SeedDocument[] = [],
): Promise<{
	state: StateFile
	surface: SurfaceState
	digest: DigestMultiset
}> {
	await target.createCollection(telemetryName, {
		timeseries: { timeField: "ts", metaField: "meta", granularity: "seconds" },
		expireAfterSeconds: 604_800,
	})
	await target.collection<SeedDocument>(telemetryName).insertMany([
		{
			_id: new BSON.Int32(71),
			meta: { schedule: database },
			ts: new Date(),
			kind: "duplicate-a",
		},
		{
			_id: new BSON.Int32(71),
			meta: { schedule: database },
			ts: new Date(Date.now() + 1000),
			kind: "duplicate-b",
		},
		{
			meta: { schedule: database },
			ts: new Date(Date.now() + 2000),
			kind: "missing-id",
		},
		...extraDocuments,
	])
	const source = await inspectNamespace(target, telemetryName)
	if (!source?.uuid) throw new Error("recovery source UUID unavailable")
	const digest = await digestCollection(target, telemetryName)
	const surface: SurfaceState = {
		surface: "telemetry",
		canonicalName: telemetryName,
		candidateName: telemetryCandidate,
		phase: "validated",
		skipReason: "source retention 604800s preserved",
		source: { uuid: source.uuid, retentionSeconds: 604_800 },
		plan: { retentionSeconds: 604_800, documentCount: digest.documentCount },
		digest: null,
		candidate: null,
		installed: null,
		updatedAt: new Date().toISOString(),
	}
	const state: StateFile = {
		version: STATE_VERSION,
		database,
		prefix: "memongo_",
		server: { version: "9.0.0-rc0", fcv: "9.0" },
		surfaces: { telemetry: surface },
	}
	return { state, surface, digest }
}

describe.skipIf(!existsSync(mongodPath) || !bunAvailable)(
	"migrate-diagnostics-to-ordinary e2e (private MongoDB 9 build)",
	() => {
		beforeAll(async () => {
			workDir = await mkdtemp(path.join(tmpdir(), "migrate-diagnostics-e2e-"))
			dbDir = path.join(workDir, "db")
			await mkdir(dbDir)
			statePath = path.join(workDir, "migrate-diagnostics-state.json")
			abortStatePath = path.join(workDir, "abort-state.json")

			const port = await freePort()
			const setName = `migrate9_${runId}`
			mongod = spawn(
				mongodPath,
				[
					"--dbpath",
					dbDir,
					"--port",
					String(port),
					"--bind_ip",
					"127.0.0.1",
					"--replSet",
					setName,
					"--wiredTigerCacheSizeGB",
					"0.256",
					"--oplogSize",
					"64",
					"--setParameter",
					"enableTestCommands=1",
					"--logpath",
					path.join(workDir, "mongod.log"),
				],
				{ stdio: "ignore" },
			)
			uri = `mongodb://127.0.0.1:${port}/?directConnection=true`

			client = new MongoClient(uri, {
				serverSelectionTimeoutMS: 1000,
				socketTimeoutMS: 5000,
			})
			const deadline = Date.now() + 45_000
			while (true) {
				try {
					await client.connect()
					await client.db("admin").command({ ping: 1 })
					break
				} catch (error) {
					if (Date.now() >= deadline) throw error
					await delay(250)
				}
			}
			const build = await client.db("admin").command({ buildInfo: 1 })
			expect(String(build.version)).toMatch(/^9\./)
			await client.db("admin").command({
				replSetInitiate: {
					_id: setName,
					members: [{ _id: 0, host: `localhost:${port}` }],
				},
			})
			while (true) {
				const hello = await client.db("admin").command({ hello: 1 })
				if (hello.isWritablePrimary && hello.setName === setName) break
				if (Date.now() >= deadline) {
					throw new Error("owned replica set did not elect a primary in time")
				}
				await delay(250)
			}
			db = client.db("memongo")
		}, 120_000)

		afterAll(async () => {
			await client?.close()
			if (mongod !== null && mongod.exitCode === null) {
				mongod.kill("SIGTERM")
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						mongod?.kill("SIGKILL")
						resolve()
					}, 20_000)
					mongod?.once("exit", () => {
						clearTimeout(timer)
						resolve()
					})
				})
			}
			await rm(workDir, { recursive: true, force: true })
		})

		it("seeds time-series sources with hostile _id shapes and mixed BSON types", async () => {
			if (!db) throw new Error("server fixture unavailable")
			await db.createCollection(telemetryName, {
				timeseries: {
					timeField: "ts",
					metaField: "meta",
					granularity: "seconds",
				},
				expireAfterSeconds: 604_800,
			})
			await db.collection<SeedDocument>(telemetryName).insertMany([
				{
					_id: new BSON.Int32(1),
					meta: { src: "e2e" },
					ts: new Date("2026-09-08T10:00:00Z"),
					kind: "duplicate-a",
					n: new BSON.Int32(7),
					score: new BSON.Double(0.5),
				},
				{
					_id: new BSON.Int32(1),
					meta: { src: "e2e" },
					ts: new Date("2026-09-08T10:01:00Z"),
					kind: "duplicate-b",
					n: new BSON.Int32(8),
					score: new BSON.Double(1.5),
				},
				{
					meta: { src: "e2e" },
					ts: new Date("2026-09-08T10:02:00Z"),
					kind: "missing-a",
					n: new BSON.Int32(9),
					score: new BSON.Double(2.5),
				},
				{
					_id: { nested: "object" },
					meta: { src: "e2e" },
					ts: new Date("2026-09-08T10:03:00Z"),
					kind: "nested-id",
					n: new BSON.Int32(10),
					score: new BSON.Double(3.5),
					tag: new ObjectId(),
					when: new Date("2026-09-08T10:03:00Z"),
					list: ["a", 1, null],
					inner: { deep: { flag: true } },
				},
				{
					_id: new ObjectId(),
					meta: { src: "e2e" },
					ts: new Date("2026-09-08T10:04:00Z"),
					kind: "objectid",
					n: new BSON.Int32(11),
					score: new BSON.Double(4.5),
				},
				{
					meta: { src: "e2e" },
					ts: new Date("2026-09-08T10:05:00Z"),
					kind: "missing-b",
					n: new BSON.Int32(12),
					score: new BSON.Double(5.5),
				},
			])
			await db.createCollection(accessName, {
				timeseries: {
					timeField: "ts",
					metaField: "meta",
					granularity: "minutes",
				},
				// Deliberately non-canonical: exercises retention gating.
				expireAfterSeconds: 3600,
			})
			await db.collection<SeedDocument>(accessName).insertMany([
				{
					_id: "shared",
					meta: { actor: "u1" },
					ts: new Date("2026-09-08T11:00:00Z"),
					action: "read",
				},
				{
					_id: "shared",
					meta: { actor: "u2" },
					ts: new Date("2026-09-08T11:01:00Z"),
					action: "write",
				},
				{
					meta: { actor: "u3" },
					ts: new Date("2026-09-08T11:02:00Z"),
					action: "read",
				},
			])

			expect((await collectionInfo(db, telemetryName))?.type).toBe("timeseries")
			expect((await collectionInfo(db, accessName))?.type).toBe("timeseries")
			expect(await db.collection(telemetryName).countDocuments({})).toBe(6)
			expect(await db.collection(accessName).countDocuments({})).toBe(3)
			expect(await collectionNames(db)).not.toContain(telemetryCandidate)

			telemetryDigestBefore = await digestCollection(db, telemetryName)
			accessDigestBefore = await digestCollection(db, accessName)
			expect(telemetryDigestBefore.documentCount).toBe(6)
			expect(accessDigestBefore.documentCount).toBe(3)
		})

		it("dry run refuses the unacknowledged retention change and mutates nothing", async () => {
			if (!db) throw new Error("server fixture unavailable")
			const run = runCli(["--state", statePath])
			expect(run.status).toBe(1)
			expect(run.stderr).toContain("--accept-retention-change")
			expect(run.stderr).toContain("2592000")

			expect((await collectionInfo(db, telemetryName))?.type).toBe("timeseries")
			expect((await collectionInfo(db, accessName))?.type).toBe("timeseries")
			expect(await collectionNames(db)).not.toContain(telemetryCandidate)
			expect(existsSync(statePath)).toBe(false)
		})

		it("dry run with the acknowledgment reports adopting the canonical TTL", async () => {
			if (!db) throw new Error("server fixture unavailable")
			const run = runCli(["--accept-retention-change", "--state", statePath])
			expect(run.status).toBe(0)
			const receipt = parseReceipt(run.stdout)
			expect(receipt.mode).toBe("dry-run")
			const telemetry = receipt.surfaces.find(
				(entry) => entry.surface === "telemetry",
			)
			const access = receipt.surfaces.find(
				(entry) => entry.surface === "access-events",
			)
			expect(telemetry?.phase).toBe("validated")
			expect(telemetry?.retentionSeconds).toBe(604_800)
			expect(telemetry?.documentCount).toBe(6)
			expect(telemetry?.note).toContain("preserved")
			expect(access?.retentionSeconds).toBe(2_592_000)
			expect(access?.documentCount).toBe(3)
			expect(access?.note).toContain("--accept-retention-change")

			// Still nothing mutated.
			expect((await collectionInfo(db, telemetryName))?.type).toBe("timeseries")
			expect((await collectionInfo(db, accessName))?.type).toBe("timeseries")
			expect(existsSync(statePath)).toBe(false)
		})

		it("apply converts telemetry, then stops at the retention change with the source untouched", async () => {
			if (!db || !telemetryDigestBefore) throw new Error("fixture unavailable")
			const run = runCli(["--apply", "--state", statePath])
			expect(run.status).toBe(1)
			expect(run.stderr).toContain("--accept-retention-change")

			// Telemetry: ordinary, exact canonical TTL, fresh unique _ids,
			// byte-identical application payload.
			const converted = await collectionInfo(db, telemetryName)
			expect(converted?.type).toBe("collection")
			const ttl = await ttlIndex(db, telemetryName)
			expect(ttl?.key).toEqual({ ts: 1 })
			expect(ttl?.expireAfterSeconds).toBe(604_800)
			const docs = (await db
				.collection(telemetryName)
				.find()
				.toArray()) as Array<{
				_id: unknown
			}>
			expect(docs).toHaveLength(6)
			expect(docs.every((doc) => doc._id instanceof ObjectId)).toBe(true)
			expect(new Set(docs.map((doc) => String(doc._id))).size).toBe(6)
			expect(
				digestsEqual(
					await digestCollection(db, telemetryName),
					telemetryDigestBefore,
				),
			).toBe(true)
			expect(await collectionNames(db)).not.toContain(telemetryCandidate)

			// Access events: time-series source untouched at its old TTL.
			const access = await collectionInfo(db, accessName)
			expect(access?.type).toBe("timeseries")
			expect(access?.options?.expireAfterSeconds).toBe(3600)
			expect(await db.collection(accessName).countDocuments({})).toBe(3)

			// State recorded exactly the completed telemetry surface.
			const state = JSON.parse(await readFile(statePath, "utf8")) as {
				version: number
				surfaces: Record<string, { phase: string } | undefined>
			}
			expect(state.version).toBe(STATE_VERSION)
			expect(state.surfaces.telemetry?.phase).toBe("complete")
			expect(state.surfaces["access-events"]).toBeUndefined()
		})

		it("abort after installation is refused, as is a mismatched database", async () => {
			if (!db) throw new Error("server fixture unavailable")
			const mismatched = runCli(["--abort", "--state", statePath], {
				MEMONGO_MONGODB_DATABASE: "some_other_database",
			})
			expect(mismatched.status).toBe(1)
			expect(mismatched.stderr).toContain("refusing to run against")
			expect(existsSync(statePath)).toBe(true)

			const run = runCli(["--abort", "--state", statePath])
			expect(run.status).toBe(1)
			expect(run.stderr).toContain("already installed")
			expect(existsSync(statePath)).toBe(true)
			expect((await collectionInfo(db, telemetryName))?.type).toBe("collection")
		})

		it("apply with the acknowledgment resumes from state and completes both surfaces", async () => {
			if (!db || !accessDigestBefore || !telemetryDigestBefore) {
				throw new Error("fixture unavailable")
			}
			const run = runCli([
				"--apply",
				"--accept-retention-change",
				"--state",
				statePath,
			])
			expect(run.status).toBe(0)
			const receipt = parseReceipt(run.stdout)
			expect(receipt.mode).toBe("apply")
			expect(receipt.server.version).toMatch(/^9\./)
			const access = receipt.surfaces.find(
				(entry) => entry.surface === "access-events",
			)
			expect(access?.phase).toBe("complete")
			expect(access?.retentionSeconds).toBe(2_592_000)

			// Access events: converted with the canonical TTL and exact payload.
			const converted = await collectionInfo(db, accessName)
			expect(converted?.type).toBe("collection")
			const ttl = await ttlIndex(db, accessName)
			expect(ttl?.key).toEqual({ ts: 1 })
			expect(ttl?.expireAfterSeconds).toBe(2_592_000)
			const docs = (await db.collection(accessName).find().toArray()) as Array<{
				_id: unknown
			}>
			expect(docs).toHaveLength(3)
			expect(docs.every((doc) => doc._id instanceof ObjectId)).toBe(true)
			expect(new Set(docs.map((doc) => String(doc._id))).size).toBe(3)
			expect(
				digestsEqual(
					await digestCollection(db, accessName),
					accessDigestBefore,
				),
			).toBe(true)

			// Telemetry was not re-copied: resume does not amplify data.
			expect(await db.collection(telemetryName).countDocuments({})).toBe(6)
			expect(
				digestsEqual(
					await digestCollection(db, telemetryName),
					telemetryDigestBefore,
				),
			).toBe(true)
			expect(await collectionNames(db)).not.toContain(accessCandidate)
			expect(existsSync(`${statePath}.receipt.json`)).toBe(true)
		})

		it("re-running apply is idempotent", async () => {
			if (!db) throw new Error("server fixture unavailable")
			const telemetryBefore = await digestCollection(db, telemetryName)
			const accessBefore = await digestCollection(db, accessName)
			const run = runCli(["--apply", "--state", statePath])
			expect(run.status).toBe(0)
			expect(await db.collection(telemetryName).countDocuments({})).toBe(6)
			expect(await db.collection(accessName).countDocuments({})).toBe(3)
			expect(
				digestsEqual(
					await digestCollection(db, telemetryName),
					telemetryBefore,
				),
			).toBe(true)
			expect(
				digestsEqual(await digestCollection(db, accessName), accessBefore),
			).toBe(true)
		})

		it("resumes the CLI from a real copied checkpoint", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(copiedResumeDatabase)
			const copiedStatePath = path.join(workDir, "copied-resume-state.json")
			const { state, surface, digest } = await createRecoverySource(
				target,
				copiedResumeDatabase,
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(copiedStatePath, state),
			)
			await saveState(copiedStatePath, state)
			const checkpoint = JSON.parse(
				await readFile(copiedStatePath, "utf8"),
			) as StateFile
			expect(checkpoint.surfaces.telemetry?.phase).toBe("copied")
			expect(checkpoint.surfaces.telemetry?.candidate?.uuid).toBeTruthy()

			const run = runCli(["--apply", "--state", copiedStatePath], {
				MEMONGO_MONGODB_DATABASE: copiedResumeDatabase,
			})
			expect(run.status).toBe(0)
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"collection",
			)
			expect(await collectionNames(target)).not.toContain(telemetryCandidate)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
			const completed = JSON.parse(
				await readFile(copiedStatePath, "utf8"),
			) as StateFile
			expect(completed.surfaces.telemetry?.phase).toBe("complete")
		})

		it("adopts a legacy copied checkpoint that omitted candidate identity", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(legacyCopiedDatabase)
			const copiedStatePath = path.join(workDir, "legacy-copied-state.json")
			const { state, surface, digest } = await createRecoverySource(
				target,
				legacyCopiedDatabase,
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(copiedStatePath, state),
			)
			surface.candidate = null
			await saveState(copiedStatePath, state)
			expect(surface.phase).toBe("copied")

			const run = runCli(["--apply", "--state", copiedStatePath], {
				MEMONGO_MONGODB_DATABASE: legacyCopiedDatabase,
			})
			expect(run.status).toBe(0)
			expect(run.stdout).toContain("adopted candidate")
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"collection",
			)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
		})

		it("adopts an exact candidate after an uncertain $out response", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(uncertainOutDatabase)
			const uncertainStatePath = path.join(workDir, "uncertain-out-state.json")
			const { state, surface, digest } = await createRecoverySource(
				target,
				uncertainOutDatabase,
			)

			// Production copy persists phase=copying before $out. Deliberately
			// omit the final copied-state save to model a lost $out response.
			await runCopyPhase(target, surface, undefined, () =>
				saveState(uncertainStatePath, state),
			)
			const checkpoint = JSON.parse(
				await readFile(uncertainStatePath, "utf8"),
			) as StateFile
			expect(checkpoint.surfaces.telemetry?.phase).toBe("copying")
			expect(checkpoint.surfaces.telemetry?.candidate).toBeNull()
			const candidateBefore = await collectionInfo(target, telemetryCandidate)
			expect(candidateBefore?.type).toBe("collection")

			const run = runCli(["--apply", "--state", uncertainStatePath], {
				MEMONGO_MONGODB_DATABASE: uncertainOutDatabase,
			})
			expect(run.status).toBe(0)
			expect(run.stdout).toContain("adopted candidate")
			const canonical = await collectionInfo(target, telemetryName)
			expect(canonical?.type).toBe("collection")
			expect(String(canonical?.info?.uuid)).toBe(
				String(candidateBefore?.info?.uuid),
			)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
		})

		it("refuses a replacement candidate after an uncertain $out response", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(uncertainOutForeignDatabase)
			const uncertainStatePath = path.join(
				workDir,
				"uncertain-out-foreign-state.json",
			)
			const { state, surface } = await createRecoverySource(
				target,
				uncertainOutForeignDatabase,
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(uncertainStatePath, state),
			)
			await target.dropCollection(telemetryCandidate)
			await target.collection(telemetryCandidate).insertOne({
				foreign: true,
				ts: new Date(),
			})
			const foreignBefore = await collectionInfo(target, telemetryCandidate)

			const run = runCli(["--apply", "--state", uncertainStatePath], {
				MEMONGO_MONGODB_DATABASE: uncertainOutForeignDatabase,
			})
			expect(run.status).toBe(1)
			expect(run.stderr).toContain("refusing to erase an unowned collection")
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)
			expect(
				String((await collectionInfo(target, telemetryCandidate))?.info?.uuid),
			).toBe(String(foreignBefore?.info?.uuid))
		})

		it("copies the pinned snapshot despite a source deletion after digest", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(snapshotBoundaryDatabase)
			const snapshotStatePath = path.join(
				workDir,
				"snapshot-boundary-state.json",
			)
			const { state, surface, digest } = await createRecoverySource(
				target,
				snapshotBoundaryDatabase,
			)

			await runCopyPhase(target, surface, undefined, async () => {
				await saveState(snapshotStatePath, state)
				await target.collection(telemetryName).deleteOne({
					kind: "duplicate-a",
				})
			})
			expect(await target.collection(telemetryName).countDocuments({})).toBe(2)
			expect(
				digestsEqual(
					await digestCollection(target, telemetryCandidate),
					digest,
				),
			).toBe(true)
			await saveState(snapshotStatePath, state)

			const run = runCli(["--apply", "--state", snapshotStatePath], {
				MEMONGO_MONGODB_DATABASE: snapshotBoundaryDatabase,
			})
			expect(run.status).toBe(0)
			expect(await target.collection(telemetryName).countDocuments({})).toBe(3)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
		})

		it("leaves the source untouched when the pinned digest read fails", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(readFailureDatabase)
			const failedStatePath = path.join(workDir, "read-failure-state.json")
			const { state, surface } = await createRecoverySource(
				target,
				readFailureDatabase,
			)
			await client.db("admin").command({
				configureFailPoint: "failCommand",
				mode: { times: 1 },
				data: {
					failCommands: ["aggregate"],
					errorCode: 11601,
				},
			})

			await expect(
				runCopyPhase(target, surface, undefined, () =>
					saveState(failedStatePath, state),
				),
			).rejects.toThrow()
			expect(surface.phase).toBe("validated")
			expect(existsSync(failedStatePath)).toBe(false)
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)
			expect(await target.collection(telemetryName).countDocuments({})).toBe(3)
			expect(await collectionNames(target)).not.toContain(telemetryCandidate)
		})

		it("persists copy intent and leaves the source intact when the second aggregate gets SnapshotTooOld", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(snapshotTooOldDatabase)
			const failedStatePath = path.join(workDir, "snapshot-too-old-state.json")
			const { state, surface, digest } = await createRecoverySource(
				target,
				snapshotTooOldDatabase,
			)

			await expect(
				runCopyPhase(target, surface, undefined, async () => {
					await saveState(failedStatePath, state)
					await client?.db("admin").command({
						configureFailPoint: "failCommand",
						mode: { times: 1 },
						data: {
							failCommands: ["aggregate"],
							errorCode: 286,
						},
					})
				}),
			).rejects.toMatchObject({ code: 286 })
			const checkpoint = JSON.parse(
				await readFile(failedStatePath, "utf8"),
			) as StateFile
			expect(checkpoint.surfaces.telemetry?.phase).toBe("copying")
			expect(checkpoint.surfaces.telemetry?.digest).toEqual(digest)
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)
			expect(await target.collection(telemetryName).countDocuments({})).toBe(3)
			expect(await collectionNames(target)).not.toContain(telemetryCandidate)

			const retry = runCli(["--apply", "--state", failedStatePath], {
				MEMONGO_MONGODB_DATABASE: snapshotTooOldDatabase,
			})
			expect(retry.status).toBe(0)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
		})

		it("recovers an uncertain rename response by verified UUID", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(uncertainRenameDatabase)
			const renameStatePath = path.join(workDir, "uncertain-rename-state.json")
			const { state, surface, digest } = await createRecoverySource(
				target,
				uncertainRenameDatabase,
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(renameStatePath, state),
			)
			await runVerifyPhase(target, surface)
			await saveState(renameStatePath, state)
			const verifiedUuid = surface.candidate?.uuid
			expect(surface.phase).toBe("verified")
			expect(verifiedUuid).toBeTruthy()

			// Execute the production rename but do not persist its returned
			// phase, which is the durable state left by a lost response.
			expect(
				await runInstallPhase(target, uncertainRenameDatabase, surface),
			).toBe("renamed")
			const stale = JSON.parse(
				await readFile(renameStatePath, "utf8"),
			) as StateFile
			expect(stale.surfaces.telemetry?.phase).toBe("verified")
			expect(
				String((await collectionInfo(target, telemetryName))?.info?.uuid),
			).toBe(verifiedUuid)

			const run = runCli(["--apply", "--state", renameStatePath], {
				MEMONGO_MONGODB_DATABASE: uncertainRenameDatabase,
			})
			expect(run.status).toBe(0)
			expect(run.stdout).toContain("already installed")
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
			const completed = JSON.parse(
				await readFile(renameStatePath, "utf8"),
			) as StateFile
			expect(completed.surfaces.telemetry?.phase).toBe("complete")
		})

		it("restarts and completes after the verified candidate is deleted with the source intact", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(deletedCandidateRestartDatabase)
			const restartStatePath = path.join(
				workDir,
				"deleted-candidate-restart-state.json",
			)
			const { state, surface, digest } = await createRecoverySource(
				target,
				deletedCandidateRestartDatabase,
			)

			// Create and verify the owned candidate, then persist the verified
			// journal exactly as a crashed install attempt would leave it.
			await runCopyPhase(target, surface, undefined, () =>
				saveState(restartStatePath, state),
			)
			await runVerifyPhase(target, surface)
			await saveState(restartStatePath, state)
			expect(surface.phase).toBe("verified")
			const sourceUuid = surface.source?.uuid
			expect(sourceUuid).toBeTruthy()

			// Hostile deletion: only the owned candidate disappears while the
			// owned time-series source stays intact.
			await target.dropCollection(telemetryCandidate)
			expect(await collectionInfo(target, telemetryCandidate)).toBeUndefined()
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)

			// The next apply must refuse with the recoverable restart
			// checkpoint and persist a journal validation still accepts.
			const first = runCli(["--apply", "--state", restartStatePath], {
				MEMONGO_MONGODB_DATABASE: deletedCandidateRestartDatabase,
			})
			expect(first.status).toBe(1)
			expect(first.stderr).toContain(
				"the verified candidate is gone but the source time-series collection is intact",
			)
			const checkpoint = JSON.parse(
				await readFile(restartStatePath, "utf8"),
			) as StateFile
			const checkpointSurface = checkpoint.surfaces.telemetry
			expect(checkpointSurface?.phase).toBe("validated")
			expect(checkpointSurface?.digest).toBeNull()
			expect(checkpointSurface?.candidate).toBeNull()
			expect(checkpointSurface?.installed).toBeNull()
			expect(checkpointSurface?.source?.uuid).toBe(sourceUuid)
			// The refusal itself mutated nothing on the server.
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)

			// The retry recopies from the intact source and completes the
			// conversion with the source data preserved and the canonical TTL.
			const retry = runCli(["--apply", "--state", restartStatePath], {
				MEMONGO_MONGODB_DATABASE: deletedCandidateRestartDatabase,
			})
			expect(retry.status).toBe(0)
			const converted = await collectionInfo(target, telemetryName)
			expect(converted?.type).toBe("collection")
			const policy = await ttlIndex(target, telemetryName)
			expect(policy?.key).toEqual({ ts: 1 })
			expect(policy?.expireAfterSeconds).toBe(604_800)
			expect(await target.collection(telemetryName).countDocuments({})).toBe(
				digest.documentCount,
			)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
			const completed = JSON.parse(
				await readFile(restartStatePath, "utf8"),
			) as StateFile
			expect(completed.surfaces.telemetry?.phase).toBe("complete")
		})

		it("refuses a candidate that predates copy intent", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(foreignCandidateDatabase)
			await createRecoverySource(target, foreignCandidateDatabase)
			await target.collection(telemetryCandidate).insertOne({
				foreign: true,
				ts: new Date(),
			})
			const candidateBefore = await collectionInfo(target, telemetryCandidate)
			const foreignStatePath = path.join(
				workDir,
				"foreign-candidate-state.json",
			)

			const run = runCli(["--apply", "--state", foreignStatePath], {
				MEMONGO_MONGODB_DATABASE: foreignCandidateDatabase,
			})
			expect(run.status).toBe(1)
			expect(run.stderr).toContain("refusing to erase an unowned collection")
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)
			expect(
				String((await collectionInfo(target, telemetryCandidate))?.info?.uuid),
			).toBe(String(candidateBefore?.info?.uuid))
		})

		it("refuses a foreign ordinary canonical UUID and retains the owned candidate", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(foreignCanonicalDatabase)
			const foreignCanonicalStatePath = path.join(
				workDir,
				"foreign-canonical-state.json",
			)
			const { state, surface } = await createRecoverySource(
				target,
				foreignCanonicalDatabase,
			)
			await runCopyPhase(target, surface, undefined, () =>
				saveState(foreignCanonicalStatePath, state),
			)
			await runVerifyPhase(target, surface)
			await saveState(foreignCanonicalStatePath, state)
			const candidateBefore = await collectionInfo(target, telemetryCandidate)
			expect(candidateBefore?.info?.uuid).toBeTruthy()

			await target.dropCollection(telemetryName)
			await target.collection(telemetryName).insertOne({
				foreign: true,
				ts: new Date(),
			})
			const canonicalBefore = await collectionInfo(target, telemetryName)

			const run = runCli(["--apply", "--state", foreignCanonicalStatePath], {
				MEMONGO_MONGODB_DATABASE: foreignCanonicalDatabase,
			})
			expect(run.status).toBe(1)
			expect(run.stderr).toContain(
				"refusing to overwrite a foreign or replaced namespace",
			)
			expect(
				String((await collectionInfo(target, telemetryName))?.info?.uuid),
			).toBe(String(canonicalBefore?.info?.uuid))
			expect(
				String((await collectionInfo(target, telemetryCandidate))?.info?.uuid),
			).toBe(String(candidateBefore?.info?.uuid))
		})

		it("preserves a literal date-wrapper-shaped object beside a real BSON Date", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(literalWrapperDatabase)
			const literalStatePath = path.join(workDir, "literal-wrapper-state.json")
			const realDate = new Date(0)
			const { state, surface, digest } = await createRecoverySource(
				target,
				literalWrapperDatabase,
				[
					{
						meta: { schedule: literalWrapperDatabase },
						ts: new Date(),
						kind: "literal-wrapper",
						literal: { $date: { $numberLong: "0" } },
						realDate,
					},
				],
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(literalStatePath, state),
			)
			await runVerifyPhase(target, surface)
			expect(
				digestsEqual(
					await digestCollection(target, telemetryCandidate),
					digest,
				),
			).toBe(true)
			const copied = await target
				.collection(telemetryCandidate)
				.findOne({ kind: "literal-wrapper" })
			expect(copied?.literal).toEqual({ $date: { $numberLong: "0" } })
			expect(copied?.realDate).toBeInstanceOf(Date)
			expect((copied?.realDate as Date).getTime()).toBe(0)
			expect(copied?.literal).not.toBeInstanceOf(Date)
		})

		it("rejects a redirected persisted candidate name before abort can inspect or drop it", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(redirectedStateDatabase)
			const redirectedStatePath = path.join(workDir, "redirected-state.json")
			const protectedName = "operator_data"
			const { state, surface } = await createRecoverySource(
				target,
				redirectedStateDatabase,
			)
			await target.collection(protectedName).insertOne({ keep: true })
			const protectedBefore = await collectionInfo(target, protectedName)
			if (!protectedBefore?.info?.uuid) {
				throw new Error("protected collection UUID unavailable")
			}
			surface.candidateName = protectedName
			surface.candidate = {
				uuid: String(protectedBefore.info.uuid),
				documentCount: 1,
			}
			surface.phase = "copied"
			await saveState(redirectedStatePath, state)

			const run = runCli(["--abort", "--state", redirectedStatePath], {
				MEMONGO_MONGODB_DATABASE: redirectedStateDatabase,
			})
			expect(run.status).toBe(1)
			expect(run.stderr).toContain("namespace mismatch")
			expect(
				String((await collectionInfo(target, protectedName))?.info?.uuid),
			).toBe(String(protectedBefore.info.uuid))
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)
		})

		it("abort refuses an uncertain completed rename and preserves the journal", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(uncertainRenameAbortDatabase)
			const renameAbortStatePath = path.join(
				workDir,
				"uncertain-rename-abort-state.json",
			)
			const { state, surface, digest } = await createRecoverySource(
				target,
				uncertainRenameAbortDatabase,
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(renameAbortStatePath, state),
			)
			await runVerifyPhase(target, surface)
			await saveState(renameAbortStatePath, state)
			const verifiedUuid = surface.candidate?.uuid
			expect(surface.phase).toBe("verified")
			expect(verifiedUuid).toBeTruthy()

			// Execute the production rename without persisting the installed
			// phase: the journal still records `verified` while the source was
			// already replaced by the renamed candidate.
			expect(
				await runInstallPhase(target, uncertainRenameAbortDatabase, surface),
			).toBe("renamed")
			expect(
				String((await collectionInfo(target, telemetryName))?.info?.uuid),
			).toBe(verifiedUuid)

			const run = runCli(["--abort", "--state", renameAbortStatePath], {
				MEMONGO_MONGODB_DATABASE: uncertainRenameAbortDatabase,
			})
			expect(run.status).toBe(1)
			expect(run.stderr).toContain(
				"the rename appears to have completed, and abort cannot undo an installation",
			)
			expect(existsSync(renameAbortStatePath)).toBe(true)
			const preserved = JSON.parse(
				await readFile(renameAbortStatePath, "utf8"),
			) as StateFile
			expect(preserved.surfaces.telemetry?.phase).toBe("verified")
			expect(
				String((await collectionInfo(target, telemetryName))?.info?.uuid),
			).toBe(verifiedUuid)
			expect(await collectionNames(target)).not.toContain(telemetryCandidate)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
		})

		it("completes an installed retry when the exact TTL policy already exists and the count drifted", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(ttlRetryDatabase)
			const ttlRetryStatePath = path.join(workDir, "ttl-retry-state.json")
			const { state, surface, digest } = await createRecoverySource(
				target,
				ttlRetryDatabase,
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(ttlRetryStatePath, state),
			)
			await runVerifyPhase(target, surface)
			await saveState(ttlRetryStatePath, state)
			await runInstallPhase(target, ttlRetryDatabase, surface)
			await saveState(ttlRetryStatePath, state)
			expect(surface.phase).toBe("installed")
			const installedUuid = surface.installed?.uuid
			expect(installedUuid).toBeTruthy()

			// Crash after createIndex but before persisting `complete`: the
			// exact canonical TTL policy exists while the journal still records
			// `installed`, and TTL expiry has since deleted a document.
			await target
				.collection(telemetryName)
				.createIndex({ ts: 1 }, { expireAfterSeconds: 604_800 })
			await target.collection(telemetryName).deleteOne({})
			const drifted = await target.collection(telemetryName).countDocuments({})
			expect(drifted).toBeLessThan(digest.documentCount)

			const run = runCli(["--apply", "--state", ttlRetryStatePath], {
				MEMONGO_MONGODB_DATABASE: ttlRetryDatabase,
			})
			expect(run.status).toBe(0)
			expect(run.stdout).toContain("complete — ordinary collection with TTL")
			const completed = JSON.parse(
				await readFile(ttlRetryStatePath, "utf8"),
			) as StateFile
			expect(completed.surfaces.telemetry?.phase).toBe("complete")
			expect(completed.surfaces.telemetry?.installed?.uuid).toBe(installedUuid)
			const policy = await ttlIndex(target, telemetryName)
			expect(policy?.key).toEqual({ ts: 1 })
			expect(policy?.expireAfterSeconds).toBe(604_800)
		})

		it("refuses a stale complete state while the recorded time-series source still exists", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const target = client.db(staleCompleteDatabase)
			const staleCompleteStatePath = path.join(
				workDir,
				"stale-complete-state.json",
			)
			const { state, surface, digest } = await createRecoverySource(
				target,
				staleCompleteDatabase,
			)

			await runCopyPhase(target, surface, undefined, () =>
				saveState(staleCompleteStatePath, state),
			)
			await runVerifyPhase(target, surface)
			// Hand-edit the journal into a stale `complete` claim: the recorded
			// source time-series collection is still intact and owned, so the
			// installation the phase asserts never happened.
			surface.phase = "complete"
			surface.installed = { uuid: surface.candidate?.uuid ?? "stale-uuid" }
			await saveState(staleCompleteStatePath, state)

			const run = runCli(["--apply", "--state", staleCompleteStatePath], {
				MEMONGO_MONGODB_DATABASE: staleCompleteDatabase,
			})
			expect(run.status).toBe(1)
			expect(run.stderr).toContain("recorded phase complete is stale")
			expect((await collectionInfo(target, telemetryName))?.type).toBe(
				"timeseries",
			)
			expect(
				digestsEqual(await digestCollection(target, telemetryName), digest),
			).toBe(true)
			const preserved = JSON.parse(
				await readFile(staleCompleteStatePath, "utf8"),
			) as StateFile
			expect(preserved.surfaces.telemetry?.phase).toBe("complete")
		})

		it("the ordinary startup oracle accepts the converted collections and rejects other TTLs", async () => {
			if (!db) throw new Error("server fixture unavailable")
			await ensureOrdinaryDiagnosticCollection(db, telemetryName, 604_800)
			await ensureOrdinaryDiagnosticCollection(db, accessName, 2_592_000)
			await expect(
				ensureOrdinaryDiagnosticCollection(db, telemetryName, 123_456),
			).rejects.toThrow("incompatible TTL index policy")
			await expect(
				ensureOrdinaryDiagnosticCollection(db, accessName, 123_456),
			).rejects.toThrow("incompatible TTL index policy")
		})

		it("abort drops only the owned candidate and leaves the source untouched", async () => {
			if (!client) throw new Error("server fixture unavailable")
			const abortDb = client.db(abortDatabase)
			const { state, surface } = await createRecoverySource(
				abortDb,
				abortDatabase,
			)
			await runCopyPhase(abortDb, surface, undefined, () =>
				saveState(abortStatePath, state),
			)
			await saveState(abortStatePath, state)
			expect(surface.phase).toBe("copied")

			const run = runCli(["--abort", "--state", abortStatePath], {
				MEMONGO_MONGODB_DATABASE: abortDatabase,
			})
			expect(run.status).toBe(0)
			expect(run.stdout).toContain("dropped owned candidate")

			// Only the candidate is gone; the time-series source is intact.
			expect(await collectionNames(abortDb)).not.toContain(telemetryCandidate)
			const remaining = await collectionInfo(abortDb, telemetryName)
			expect(remaining?.type).toBe("timeseries")
			expect(await abortDb.collection(telemetryName).countDocuments({})).toBe(3)
			expect(existsSync(abortStatePath)).toBe(false)
			expect(existsSync(`${abortStatePath}.receipt.json`)).toBe(true)

			// A second abort has nothing left to act on.
			const again = runCli(["--abort", "--state", abortStatePath], {
				MEMONGO_MONGODB_DATABASE: abortDatabase,
			})
			expect(again.status).toBe(1)
			expect(again.stderr).toContain("no state file")
		})
	},
)
