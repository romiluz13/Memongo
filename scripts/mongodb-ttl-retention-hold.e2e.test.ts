/**
 * Gated live e2e for the public TTL retention-hold helper.
 *
 * Target: one collision-resistant, owned, disposable database on the
 * explicitly provided deployment (the provisioned Atlas cluster). The URI
 * arrives ONLY through the HOLD_E2E_MONGODB_URI environment variable, is
 * passed only through the child environment of spawned helper runs, and is
 * never printed, logged, or written anywhere — the same non-echo contract
 * the helper itself keeps. Assertions on output use boolean includes()
 * checks rather than string diffs so a failure can never echo the secret.
 *
 * Safety gate (replaces the earlier loopback-only refusal after validation
 * moved to the owned Atlas cluster):
 *   - the suite is skipped unless HOLD_E2E_MONGODB_URI is set and parses as
 *     a mongodb:// or mongodb+srv:// URL;
 *   - every case runs inside the uniquely named disposable database, which
 *     is checked absent before use and dropped with an absence proof after
 *     the run;
 *   - helper spawns receive the URI only via the child environment;
 *   - the persisted hold file is asserted to contain no connection string.
 *
 * Required least-privilege privileges for the supplied user: readWrite plus
 * dbAdmin on the disposable database (createCollection, createIndex,
 * dropIndex, dropCollection, dropDatabase, listCollections, listIndexes,
 * hello). listDatabases is optional: without it, the empty collection list
 * of the uniquely named database is the absence proxy.
 *
 * The helper is spawned with `node`, the runtime the public guide
 * documents.
 *
 * Run (from the repo root):
 *   HOLD_E2E_MONGODB_URI='<atlas-uri>' \
 *     vitest run --config scripts/vitest.e2e.config.ts \
 *       scripts/mongodb-ttl-retention-hold.e2e.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const uri = process.env.HOLD_E2E_MONGODB_URI?.trim() ?? ""

function parsesAsMongoUri(candidate: string): boolean {
	if (!/^mongodb(\+srv)?:\/\//.test(candidate)) return false
	try {
		new URL(candidate)
		return true
	} catch {
		return false
	}
}

const SCRIPT = fileURLToPath(
	new URL("./mongodb-ttl-retention-hold.mjs", import.meta.url),
)
const DATABASE = `hold_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`

interface RunResult {
	status: number | null
	stdout: string
	stderr: string
}

function runHold(args: string[]): RunResult {
	const result = spawnSync("node", [SCRIPT, ...args], {
		// The URI travels only through the child environment, never argv.
		env: { ...process.env, MEMONGO_MONGODB_URI: uri },
		encoding: "utf8",
		// External timeout: a hung helper must not hang the suite.
		timeout: 120_000,
	})
	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function holdArgs(file: string, command: string, ...namespaces: string[]) {
	return ["--db", DATABASE, "--file", file, command, ...namespaces]
}

function parseOutput(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>
}

function failError(result: RunResult): string {
	const parsed = parseOutput(result.stdout) as { ok: boolean; error: string }
	expect(parsed.ok).toBe(false)
	return parsed.error
}

/** Credential non-echo against the real, credential-bearing URI. Boolean
 *  includes() comparisons only: a failed assertion reports a boolean, so
 *  the secret can never be echoed into the test report. */
function expectNoCredentialEcho(result: RunResult) {
	const schemeAt = uri.indexOf("://")
	const at = uri.indexOf("@")
	if (at < 0) return // URI carries no credentials; nothing to pin
	const userinfo = uri.slice(schemeAt + 3, at + 1)
	expect(result.stdout.includes(uri)).toBe(false)
	expect(result.stderr.includes(uri)).toBe(false)
	expect(result.stdout.includes(userinfo)).toBe(false)
	expect(result.stderr.includes(userinfo)).toBe(false)
}

type CollInfoRow = { name: string; type?: string; info?: { uuid?: unknown } }
type IndexRow = {
	name: string
	key: Record<string, unknown>
	expireAfterSeconds?: number
	partialFilterExpression?: Record<string, unknown>
	collation?: Record<string, unknown>
}

const uuidHexOf = (u: unknown) =>
	Buffer.from((u as { buffer?: Buffer }).buffer ?? (u as Buffer)).toString(
		"hex",
	)

/** Canonical JSON for structural policy comparison (sorted keys). */
function canon(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
			.join(",")}}`
	}
	return JSON.stringify(v) ?? "null"
}

function specOf(i: IndexRow): Record<string, unknown> {
	const spec: Record<string, unknown> = {
		key: i.key,
		name: i.name,
		expireAfterSeconds: i.expireAfterSeconds,
	}
	if (i.partialFilterExpression !== undefined) {
		spec.partialFilterExpression = i.partialFilterExpression
	}
	if (i.collation !== undefined) spec.collation = i.collation
	return spec
}

describe.skipIf(!uri || !parsesAsMongoUri(uri))(
	"mongodb-ttl-retention-hold e2e (owned disposable db)",
	() => {
		let client: MongoClient
		const workDir = mkdtempSync(join(tmpdir(), "hold-e2e-"))
		const holdFile = (label: string) =>
			join(workDir, `hold-${label}-${randomUUID().slice(0, 6)}.json`)

		const db = () => {
			if (!client) throw new Error("client not connected")
			return client.db(DATABASE)
		}

		/** Absence-before-use / cleanup proof for the disposable database.
		 *  Prefers the server-side database listing; a least-privilege user
		 *  scoped to disposable databases may not run listDatabases, in which
		 *  case the empty collection list of the uniquely named database is
		 *  the absence proxy (a collision needs the same 48-bit suffix). */
		async function expectDatabaseAbsent() {
			try {
				const { databases } = await client
					.db("admin")
					.admin()
					.listDatabases({ nameOnly: true })
				expect(databases.some((d) => d.name === DATABASE)).toBe(false)
			} catch {
				const collections = await db().listCollections().toArray()
				expect(collections).toHaveLength(0)
			}
		}

		async function collInfo(name: string): Promise<CollInfoRow | null> {
			const rows = (await db()
				.listCollections({ name })
				.toArray()) as CollInfoRow[]
			return rows[0] ?? null
		}
		async function indexRows(name: string): Promise<IndexRow[]> {
			return (await db().collection(name).listIndexes().toArray()) as IndexRow[]
		}
		async function ttlRows(name: string): Promise<IndexRow[]> {
			return (await indexRows(name)).filter(
				(i) => i.expireAfterSeconds !== undefined,
			)
		}

		/** An ordinary collection with one supported TTL index plus a live
		 *  document (fresh timestamps, retention far beyond test duration, so
		 *  the TTL sweeper never interferes with the case). */
		async function makeTtlCollection(
			name: string,
			indexName: string,
			eas: number,
			pfe?: Record<string, unknown>,
		) {
			await db().createCollection(name)
			await db()
				.collection(name)
				.createIndex(
					{ ts: 1 },
					pfe === undefined
						? { name: indexName, expireAfterSeconds: eas }
						: {
								name: indexName,
								expireAfterSeconds: eas,
								partialFilterExpression: pfe,
							},
				)
			// The document id is server-assigned; no case reads it back.
			await db().collection(name).insertOne({
				ts: new Date(),
				createdAt: new Date(),
				status: "pending-review",
				v: 1,
			})
		}

		const readHold = (file: string) =>
			JSON.parse(readFileSync(file, "utf8")) as {
				version: number
				db: string
				topology: { setName: string | null; isWritablePrimary: boolean }
				namespaces: Array<{
					collection: string
					uuid: string
					state: string
					pausedAt?: string
					ttlIndexes: Array<Record<string, unknown>>
				}>
			}

		beforeAll(async () => {
			client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })
			await client.connect()
			await expectDatabaseAbsent()
		})

		afterAll(async () => {
			rmSync(workDir, { recursive: true, force: true })
			if (!client) return
			try {
				await db().dropDatabase()
				await expectDatabaseAbsent()
			} finally {
				await client.close()
			}
		})

		it("inspect without a hold file reports hold none and topology", () => {
			const result = runHold(holdArgs(holdFile("none"), "inspect"))
			expect(result.status).toBe(0)
			const parsed = parseOutput(result.stdout) as {
				ok: boolean
				hold: string
				holdUsable: null
				live: Record<string, unknown>
				topology: { setName: string | null; isWritablePrimary: boolean }
			}
			expect(parsed.ok).toBe(true)
			expect(parsed.hold).toBe("none")
			expect(parsed.holdUsable).toBeNull()
			expect(parsed.live).toEqual({})
			// setName is a string on replica sets (the Atlas target) and null
			// on standalones; both are legal topology reports.
			expect(
				parsed.topology.setName === null ||
					typeof parsed.topology.setName === "string",
			).toBe(true)
			expect(typeof parsed.topology.isWritablePrimary).toBe("boolean")
		})

		it("rejects an unknown command and a namespace-less inventory (exit 2)", () => {
			const file = holdFile("args")
			const unknown = runHold(holdArgs(file, "bogus"))
			expect(unknown.status).toBe(2)
			expect(failError(unknown)).toBe("unknown command: bogus")
			expectNoCredentialEcho(unknown)

			const noNamespaces = runHold(holdArgs(file, "inventory"))
			expect(noNamespaces.status).toBe(2)
			expect(failError(noNamespaces)).toBe("inventory requires namespaces")
		})

		it("refuses pause, mark-source-dropped, and restore with no hold file (exit 5)", () => {
			const file = holdFile("empty")
			const pause = runHold(holdArgs(file, "pause"))
			expect(pause.status).toBe(5)
			expect(failError(pause)).toBe("no pause file; nothing to pause")
			expectNoCredentialEcho(pause)

			const mark = runHold(holdArgs(file, "mark-source-dropped", "x"))
			expect(mark.status).toBe(5)
			expect(failError(mark)).toBe("no pause file")

			const restore = runHold(holdArgs(file, "restore"))
			expect(restore.status).toBe(5)
			expect(failError(restore)).toBe("no pause file; nothing to restore")
		})

		// The next three cases share one lifecycle hold, in order.
		const sfx = randomUUID().slice(0, 8)
		const nsPartial = `h4_partial_${sfx}`
		const nsSeconds = `h4_seconds_${sfx}`
		const nsQuarantine = `h4_quarantine_${sfx}`
		const nsPlain = `h4_plain_${sfx}`
		const lifecycleFile = holdFile("lifecycle")

		it("inventory persists all three supported TTL forms plus a no-TTL namespace in one hold", async () => {
			await makeTtlCollection(nsPartial, "idx_partial", 604800, {
				ts: { $exists: true },
			})
			await makeTtlCollection(nsSeconds, "idx_seconds", 86400)
			await makeTtlCollection(nsQuarantine, "idx_quarantine", 2592000, {
				status: { $in: ["pending-review", "promoting"] },
			})
			await db().createCollection(nsPlain)
			// An unrelated non-TTL index must survive pause untouched.
			await db()
				.collection(nsSeconds)
				.createIndex({ other: 1 }, { name: "idx_plain_nottl" })

			const result = runHold(
				holdArgs(
					lifecycleFile,
					"inventory",
					nsPartial,
					nsSeconds,
					nsQuarantine,
					nsPlain,
				),
			)
			expect(result.status).toBe(0)
			const parsed = parseOutput(result.stdout) as {
				ok: boolean
				persisted: string
				namespaces: Array<{ collection: string; uuid: string; ttl: string[] }>
			}
			expect(parsed.ok).toBe(true)
			expect(parsed.persisted).toBe(lifecycleFile)
			expect(parsed.namespaces).toHaveLength(4)
			expect(parsed.namespaces.map((n) => n.collection).sort()).toEqual(
				[nsPartial, nsPlain, nsQuarantine, nsSeconds].sort(),
			)
			const byName = Object.fromEntries(
				parsed.namespaces.map((n) => [n.collection, n]),
			)
			expect(byName[nsPartial].ttl).toEqual(["idx_partial"])
			expect(byName[nsSeconds].ttl).toEqual(["idx_seconds"])
			expect(byName[nsQuarantine].ttl).toEqual(["idx_quarantine"])
			expect(byName[nsPlain].ttl).toEqual([])

			// Hold file: version 3, bound to this db, pending states, exact
			// recorded policies, UUIDs matching live identity — and no
			// connection string anywhere in the file.
			const hold = readHold(lifecycleFile)
			expect(hold.version).toBe(3)
			expect(hold.db).toBe(DATABASE)
			expect(hold.namespaces).toHaveLength(4)
			for (const entry of hold.namespaces) {
				expect(entry.state).toBe("pending")
				const info = await collInfo(entry.collection)
				expect(info?.type).toBe("collection")
				expect(entry.uuid).toBe(uuidHexOf(info?.info?.uuid))
				expect(entry.uuid).toMatch(/^[0-9a-f]{32}$/)
			}
			const entries = Object.fromEntries(
				hold.namespaces.map((n) => [n.collection, n]),
			)
			expect(entries[nsPartial].ttlIndexes).toHaveLength(1)
			expect(entries[nsPartial].ttlIndexes[0]).toEqual({
				key: { ts: 1 },
				name: "idx_partial",
				expireAfterSeconds: 604800,
				partialFilterExpression: { ts: { $exists: true } },
				...(entries[nsPartial].ttlIndexes[0].collation !== undefined
					? { collation: { locale: "simple" } }
					: {}),
			})
			expect(entries[nsQuarantine].ttlIndexes[0]).toEqual({
				key: { ts: 1 },
				name: "idx_quarantine",
				expireAfterSeconds: 2592000,
				partialFilterExpression: {
					status: { $in: ["pending-review", "promoting"] },
				},
				...(entries[nsQuarantine].ttlIndexes[0].collation !== undefined
					? { collation: { locale: "simple" } }
					: {}),
			})
			// JSON-native values: the recorded retention is a plain number.
			const secondsSpec = entries[nsSeconds].ttlIndexes[0] as {
				expireAfterSeconds: number
			}
			expect(typeof secondsSpec.expireAfterSeconds).toBe("number")
			expect(secondsSpec.expireAfterSeconds).toBe(86400)
			// Hold-file non-disclosure.
			const holdText = readFileSync(lifecycleFile, "utf8")
			expect(holdText.includes("mongodb://")).toBe(false)
			expect(holdText.includes("mongodb+srv://")).toBe(false)
		})

		it("inspect with the active hold reports every namespace consistent and usable", () => {
			const result = runHold(holdArgs(lifecycleFile, "inspect"))
			expect(result.status).toBe(0)
			const parsed = parseOutput(result.stdout) as {
				ok: boolean
				holdUsable: boolean
				live: Record<
					string,
					{
						state: string
						exists: boolean
						uuidMatches: boolean
						currentTtlIndexes: string[]
						consistent: boolean
					}
				>
			}
			expect(parsed.ok).toBe(true)
			expect(parsed.holdUsable).toBe(true)
			for (const ns of [nsPartial, nsSeconds, nsQuarantine, nsPlain]) {
				expect(parsed.live[ns]).toMatchObject({
					state: "pending",
					exists: true,
					uuidMatches: true,
					consistent: true,
				})
			}
			expect(parsed.live[nsPartial].currentTtlIndexes).toEqual(["idx_partial"])
			expect(parsed.live[nsPlain].currentTtlIndexes).toEqual([])
		})

		it("pause drops every recorded TTL index and preserves unrelated indexes", async () => {
			const result = runHold(holdArgs(lifecycleFile, "pause"))
			expect(result.status).toBe(0)
			const parsed = parseOutput(result.stdout) as {
				ok: boolean
				verified: Array<{ collection: string; state: string }>
				paused: Array<{
					collection: string
					dropped: string[]
					alreadyAbsent: string[]
				}>
			}
			expect(parsed.ok).toBe(true)
			expect(parsed.verified).toHaveLength(4)
			expect(parsed.paused.map((p) => p.collection).sort()).toEqual(
				[nsPartial, nsPlain, nsQuarantine, nsSeconds].sort(),
			)
			const droppedBy = Object.fromEntries(
				parsed.paused.map((p) => [p.collection, p.dropped]),
			)
			expect(droppedBy[nsPartial]).toEqual(["idx_partial"])
			expect(droppedBy[nsSeconds]).toEqual(["idx_seconds"])
			expect(droppedBy[nsQuarantine]).toEqual(["idx_quarantine"])
			expect(droppedBy[nsPlain]).toEqual([])

			// Live state: TTL retention is gone everywhere; the unrelated
			// non-TTL index is untouched.
			for (const ns of [nsPartial, nsSeconds, nsQuarantine, nsPlain]) {
				expect(await ttlRows(ns)).toHaveLength(0)
			}
			expect((await indexRows(nsSeconds)).map((i) => i.name)).toContain(
				"idx_plain_nottl",
			)
			const hold = readHold(lifecycleFile)
			for (const entry of hold.namespaces) {
				expect(entry.state).toBe("paused")
				expect(typeof entry.pausedAt).toBe("string")
			}
		})

		it("pause is two-pass: an unrecorded TTL index refuses before any mutation", async () => {
			const id = randomUUID().slice(0, 8)
			const nsA = `h7_a_${id}`
			const nsB = `h7_b_${id}`
			const file = holdFile("twopass")
			await makeTtlCollection(nsA, "idx_a", 86400)
			await makeTtlCollection(nsB, "idx_b", 86400)
			expect(runHold(holdArgs(file, "inventory", nsA, nsB)).status).toBe(0)
			// An unrecorded TTL index appears on the SECOND namespace after
			// inventory: pass 1 must refuse it before pass 2 drops anything
			// anywhere (the first namespace was fully validated but not
			// mutated). The sneaky index targets a field no document carries,
			// so the TTL sweeper cannot interfere.
			await db()
				.collection(nsB)
				.createIndex(
					{ other: 1 },
					{ name: "idx_sneaky", expireAfterSeconds: 3600 },
				)

			const result = runHold(holdArgs(file, "pause"))
			expect(result.status).toBe(4)
			const error = failError(result)
			expect(error).toContain(`unrecorded TTL index(es) on ${nsB}`)
			expect(error).toContain("idx_sneaky")

			// Zero mutation: every recorded policy and the sneaky index are
			// all still live; the hold states are unchanged.
			expect((await ttlRows(nsA)).map((i) => i.name)).toEqual(["idx_a"])
			expect((await ttlRows(nsB)).map((i) => i.name).sort()).toEqual([
				"idx_b",
				"idx_sneaky",
			])
			for (const entry of readHold(file).namespaces) {
				expect(entry.state).toBe("pending")
			}
		})

		it("pause refuses a changed same-name policy and inspect flags the hold unusable", async () => {
			const id = randomUUID().slice(0, 8)
			const ns = `h8_${id}`
			const file = holdFile("drift")
			await makeTtlCollection(ns, "idx_c", 86400)
			expect(runHold(holdArgs(file, "inventory", ns)).status).toBe(0)
			// The recorded index is replaced by a same-name policy with a
			// different key and retention: pause must refuse to drop it.
			await db().collection(ns).dropIndex("idx_c")
			await db()
				.collection(ns)
				.createIndex({ other: 1 }, { name: "idx_c", expireAfterSeconds: 999 })

			const pause = runHold(holdArgs(file, "pause"))
			expect(pause.status).toBe(4)
			const error = failError(pause)
			expect(error).toContain(`policy drift on ${ns}.idx_c`)
			expect(error).toContain("refusing to drop a changed same-name policy")
			// The drifted policy stays live.
			expect((await ttlRows(ns)).map((i) => i.name)).toEqual(["idx_c"])

			const inspect = runHold(holdArgs(file, "inspect"))
			expect(inspect.status).toBe(0)
			const parsed = parseOutput(inspect.stdout) as {
				holdUsable: boolean
				live: Record<string, { consistent: boolean }>
			}
			expect(parsed.holdUsable).toBe(false)
			expect(parsed.live[ns].consistent).toBe(false)
		})

		it("pause re-entry after an interrupted pass 2 tolerates the already-absent index", async () => {
			const id = randomUUID().slice(0, 8)
			const ns = `h9_${id}`
			const file = holdFile("reentry")
			await makeTtlCollection(ns, "idx_d", 86400)
			expect(runHold(holdArgs(file, "inventory", ns)).status).toBe(0)
			// Simulate a crash after the index drop but before the hold save:
			// the state is still pending while the index is already gone.
			await db().collection(ns).dropIndex("idx_d")

			const result = runHold(holdArgs(file, "pause"))
			expect(result.status).toBe(0)
			const parsed = parseOutput(result.stdout) as {
				ok: boolean
				paused: Array<{
					collection: string
					dropped: string[]
					alreadyAbsent: string[]
				}>
			}
			expect(parsed.ok).toBe(true)
			expect(parsed.paused[0].dropped).toEqual([])
			expect(parsed.paused[0].alreadyAbsent).toEqual(["idx_d"])
			expect(await ttlRows(ns)).toHaveLength(0)
			expect(readHold(file).namespaces[0].state).toBe("paused")
		})

		it("restore repairs a pending hold after an interrupted removal and closes it", async () => {
			const id = randomUUID().slice(0, 8)
			const ns = `h10_${id}`
			const file = holdFile("repair")
			await makeTtlCollection(ns, "idx_e", 86400)
			expect(runHold(holdArgs(file, "inventory", ns)).status).toBe(0)
			const before = specOf((await ttlRows(ns))[0])
			// Interrupted removal: the index is gone while the hold is still
			// pending — restore must recreate it, not report a mismatch.
			await db().collection(ns).dropIndex("idx_e")

			const result = runHold(holdArgs(file, "restore"))
			expect(result.status).toBe(0)
			const parsed = parseOutput(result.stdout) as {
				ok: boolean
				holdClosed: boolean
				results: Array<{
					collection: string
					status: string
					detail: string
					restored?: string[]
				}>
			}
			expect(parsed.ok).toBe(true)
			expect(parsed.holdClosed).toBe(true)
			expect(parsed.results).toHaveLength(1)
			expect(parsed.results[0].status).toBe("terminal")
			expect(parsed.results[0].detail).toContain(
				"missing recorded index(es) recreated after interrupted removal",
			)
			expect(parsed.results[0].restored).toEqual(["idx_e"])
			// Exact round-trip policy parity.
			expect(canon(specOf((await ttlRows(ns))[0]))).toBe(canon(before))
			expect(existsSync(file)).toBe(false)
		})

		it("mark-source-dropped verifies absence, is repeat-safe, refuses a present source, and restore closes the hold", async () => {
			const id = randomUUID().slice(0, 8)
			const nsSource = `h11_src_${id}`
			const nsTarget = `h11_tgt_${id}`
			const file = holdFile("mark")
			await makeTtlCollection(nsSource, "idx_s1", 86400)
			await db().createCollection(nsTarget)
			expect(
				runHold(holdArgs(file, "inventory", nsSource, nsTarget)).status,
			).toBe(0)
			expect(runHold(holdArgs(file, "pause")).status).toBe(0)
			// The migration CLI dropped the source; live absence is verified.
			await db().collection(nsSource).drop()

			const mark = runHold(holdArgs(file, "mark-source-dropped", nsSource))
			expect(mark.status).toBe(0)
			expect(parseOutput(mark.stdout)).toEqual({
				ok: true,
				marked: nsSource,
				verifiedAbsent: true,
			})

			// A repeated mark after an uncertain response is safe.
			const reMark = runHold(holdArgs(file, "mark-source-dropped", nsSource))
			expect(reMark.status).toBe(0)
			expect(parseOutput(reMark.stdout)).toEqual({
				ok: true,
				alreadyMarked: nsSource,
				verifiedAbsent: true,
			})

			// The still-present target must not be markable.
			const markPresent = runHold(
				holdArgs(file, "mark-source-dropped", nsTarget),
			)
			expect(markPresent.status).toBe(5)
			expect(failError(markPresent)).toContain("still present")

			// Argument guards against the live hold.
			const noNs = runHold(holdArgs(file, "mark-source-dropped"))
			expect(noNs.status).toBe(2)
			expect(failError(noNs)).toBe("mark-source-dropped requires a namespace")
			const notInHold = runHold(
				holdArgs(file, "mark-source-dropped", `h11_other_${id}`),
			)
			expect(notInHold.status).toBe(2)
			expect(failError(notInHold)).toContain("namespace not in hold")

			// Restore closes the hold and never recreates the dropped source.
			const restore = runHold(holdArgs(file, "restore"))
			expect(restore.status).toBe(0)
			const parsed = parseOutput(restore.stdout) as {
				ok: boolean
				holdClosed: boolean
				results: Array<{
					collection: string
					status: string
					detail: string
				}>
			}
			expect(parsed.ok).toBe(true)
			expect(parsed.holdClosed).toBe(true)
			const byName = Object.fromEntries(
				parsed.results.map((r) => [r.collection, r]),
			)
			expect(byName[nsSource].status).toBe("terminal")
			expect(byName[nsSource].detail).toBe(
				"dropped by migration; never recreated",
			)
			expect(byName[nsTarget].status).toBe("terminal")
			expect(await collInfo(nsSource)).toBeNull()
			expect(existsSync(file)).toBe(false)
		})

		it("a source that reappears after mark stays unresolved until it is dropped again", async () => {
			const id = randomUUID().slice(0, 8)
			const nsSource = `h12_src_${id}`
			const nsTarget = `h12_tgt_${id}`
			const file = holdFile("reappear")
			await makeTtlCollection(nsSource, "idx_s2", 86400)
			await db().createCollection(nsTarget)
			expect(
				runHold(holdArgs(file, "inventory", nsSource, nsTarget)).status,
			).toBe(0)
			expect(runHold(holdArgs(file, "pause")).status).toBe(0)
			await db().collection(nsSource).drop()
			expect(
				runHold(holdArgs(file, "mark-source-dropped", nsSource)).status,
			).toBe(0)
			// The recorded-dropped name reappears (foreign recreation).
			await db().createCollection(nsSource)

			const first = runHold(holdArgs(file, "restore"))
			expect(first.status).toBe(4)
			const parsed = parseOutput(first.stdout) as {
				ok: boolean
				unresolved: string[]
				holdRetained: string
				results: Array<{ collection: string; status: string }>
			}
			expect(parsed.ok).toBe(false)
			expect(parsed.unresolved).toContain(nsSource)
			expect(parsed.holdRetained).toBe(file)
			expect(existsSync(file)).toBe(true)
			const byName = Object.fromEntries(
				parsed.results.map((r) => [r.collection, r]),
			)
			expect(byName[nsSource].status).toBe("unresolved")
			expect(byName[nsTarget].status).toBe("terminal")

			// Operator drops the reappeared namespace; restore then closes.
			await db().collection(nsSource).drop()
			const second = runHold(holdArgs(file, "restore"))
			expect(second.status).toBe(0)
			const closed = parseOutput(second.stdout) as { holdClosed: boolean }
			expect(closed.holdClosed).toBe(true)
			expect(await collInfo(nsSource)).toBeNull()
			expect(existsSync(file)).toBe(false)
		})

		it("mixed outcomes restore independently, retain the unresolved hold, and close after reconciliation", async () => {
			const id = randomUUID().slice(0, 8)
			const nsM1 = `h13_m1_${id}`
			const nsM2 = `h13_m2_${id}`
			const nsM3 = `h13_m3_${id}`
			const nsM4 = `h13_m4_${id}`
			const file = holdFile("mixed")
			for (const [ns, idx] of [
				[nsM1, "idx_m1"],
				[nsM2, "idx_m2"],
				[nsM3, "idx_m3"],
				[nsM4, "idx_m4"],
			] as const) {
				await makeTtlCollection(ns, idx, 86400)
			}
			expect(
				runHold(holdArgs(file, "inventory", nsM1, nsM2, nsM3, nsM4)).status,
			).toBe(0)
			expect(runHold(holdArgs(file, "pause")).status).toBe(0)
			// M2: dropped without a mark (uncertain receipt). M3: dropped and
			// recreated (foreign reuse). M4: an unrecorded TTL index appears
			// after pause.
			await db().collection(nsM2).drop()
			await db().collection(nsM3).drop()
			await db().createCollection(nsM3)
			await db()
				.collection(nsM4)
				.createIndex(
					{ other: 1 },
					{ name: "idx_sneaky2", expireAfterSeconds: 3600 },
				)

			const first = runHold(holdArgs(file, "restore"))
			expect(first.status).toBe(4)
			const parsed = parseOutput(first.stdout) as {
				ok: boolean
				unresolved: string[]
				holdRetained: string
				results: Array<{
					collection: string
					status: string
					reason?: string
					detail?: string
					restored?: string[]
				}>
			}
			expect(parsed.ok).toBe(false)
			expect(parsed.unresolved.sort()).toEqual([nsM2, nsM3, nsM4].sort())
			expect(parsed.holdRetained).toBe(file)
			const byName = Object.fromEntries(
				parsed.results.map((r) => [r.collection, r]),
			)
			// The healthy namespace restored independently.
			expect(byName[nsM1].status).toBe("terminal")
			expect(byName[nsM1].restored).toEqual(["idx_m1"])
			// The missing namespace is reported unresolved, never recreated.
			expect(byName[nsM2].status).toBe("unresolved")
			expect(byName[nsM2].reason).toContain("namespace missing in state paused")
			expect(byName[nsM2].reason).toContain("NOT recreating it")
			// Foreign reuse is refused.
			expect(byName[nsM3].status).toBe("unresolved")
			expect(byName[nsM3].reason).toContain("UUID mismatch")
			// Unrecorded retention is left untouched, but the recorded policy
			// was still restored on that namespace.
			expect(byName[nsM4].status).toBe("unresolved")
			expect(byName[nsM4].reason).toContain("unrecorded TTL index(es) live")
			expect(byName[nsM4].reason).toContain("idx_sneaky2")
			expect(byName[nsM4].restored).toEqual(["idx_m4"])
			expect((await ttlRows(nsM4)).map((i) => i.name).sort()).toEqual([
				"idx_m4",
				"idx_sneaky2",
			])
			// The hold file is retained with the recorded states unchanged
			// for the unresolved namespaces.
			const holdAfter = readHold(file)
			const statesAfter = Object.fromEntries(
				holdAfter.namespaces.map((n) => [n.collection, n.state]),
			)
			expect(statesAfter[nsM1]).toBe("restored")
			expect(statesAfter[nsM2]).toBe("paused")
			expect(statesAfter[nsM3]).toBe("paused")
			expect(statesAfter[nsM4]).toBe("paused")

			// Pause refuses to act on a hold with a restored namespace.
			const rePause = runHold(holdArgs(file, "pause"))
			expect(rePause.status).toBe(5)
			expect(failError(rePause)).toContain("already restored")

			// Operator reconciliation: mark the proven-absent M2 (a mark on
			// the foreign-reuse M3 must be refused first), drop the foreign
			// M3 and mark it, and drop the unrecorded index on M4.
			expect(runHold(holdArgs(file, "mark-source-dropped", nsM2)).status).toBe(
				0,
			)
			const markForeign = runHold(holdArgs(file, "mark-source-dropped", nsM3))
			expect(markForeign.status).toBe(4)
			expect(failError(markForeign)).toContain("foreign namespace reuse")
			await db().collection(nsM3).drop()
			expect(runHold(holdArgs(file, "mark-source-dropped", nsM3)).status).toBe(
				0,
			)
			await db().collection(nsM4).dropIndex("idx_sneaky2")

			const second = runHold(holdArgs(file, "restore"))
			expect(second.status).toBe(0)
			const closed = parseOutput(second.stdout) as {
				ok: boolean
				holdClosed: boolean
				results: Array<{ collection: string; status: string }>
			}
			expect(closed.ok).toBe(true)
			expect(closed.holdClosed).toBe(true)
			expect(closed.results.every((r) => r.status === "terminal")).toBe(true)
			expect(existsSync(file)).toBe(false)
		})

		it("unsupported inventory forms refuse with exit 3 and zero mutation", async () => {
			const id = randomUUID().slice(0, 8)
			const nsCompound = `h14_compound_${id}`
			const nsUnique = `h14_unique_${id}`
			const nsPfe = `h14_pfe_${id}`
			const nsCollation = `h14_collation_${id}`

			// No supported server can create a compound TTL index: the server
			// rejects expireAfterSeconds on a compound key outright. That live
			// premise is pinned first — if a future server ever admits the
			// form, this guard fails and a live compound-refusal case belongs
			// here. Until then the helper's compound refusal is defensive
			// depth for an index shape no supported server can produce.
			await db().createCollection(nsCompound)
			let compoundTtl: unknown
			try {
				await db()
					.collection(nsCompound)
					.createIndex(
						{ a: 1, b: 1 },
						{ name: "idx_compound_ttl", expireAfterSeconds: 100 },
					)
			} catch (e) {
				compoundTtl = e
			}
			expect(compoundTtl).toBeInstanceOf(Error)
			expect(
				(compoundTtl as { codeName?: string }).codeName ===
					"CannotCreateIndex" ||
					String((compoundTtl as Error).message).includes("single-field"),
			).toBe(true)

			// A compound key WITHOUT expireAfterSeconds is an ordinary index,
			// not TTL retention: inventory records the namespace with zero
			// TTL indexes and neither refuses nor mutates it.
			await db()
				.collection(nsCompound)
				.createIndex({ a: 1, b: 1 }, { name: "idx_compound_nottl" })
			const compoundFile = holdFile("h14a")
			const compound = runHold(holdArgs(compoundFile, "inventory", nsCompound))
			expect(compound.status).toBe(0)
			const compoundParsed = parseOutput(compound.stdout) as {
				ok: boolean
				persisted: string
				namespaces: Array<{ collection: string; ttl: string[] }>
			}
			expect(compoundParsed.ok).toBe(true)
			expect(compoundParsed.persisted).toBe(compoundFile)
			expect(compoundParsed.namespaces).toHaveLength(1)
			expect(compoundParsed.namespaces[0].collection).toBe(nsCompound)
			expect(compoundParsed.namespaces[0].ttl).toEqual([])
			expect(await ttlRows(nsCompound)).toEqual([])
			expect((await indexRows(nsCompound)).map((i) => i.name)).toContain(
				"idx_compound_nottl",
			)

			const uniqueFile = holdFile("h14b")
			await db().createCollection(nsUnique)
			await db()
				.collection(nsUnique)
				.createIndex(
					{ u: 1 },
					{ name: "idx_unique", expireAfterSeconds: 100, unique: true },
				)
			const unique = runHold(holdArgs(uniqueFile, "inventory", nsUnique))
			expect(unique.status).toBe(3)
			expect(failError(unique)).toContain("unsupported option(s) unique")
			// Zero mutation: the refused index is still live and no hold file
			// was persisted.
			expect((await ttlRows(nsUnique)).map((i) => i.name)).toEqual([
				"idx_unique",
			])
			expect(existsSync(uniqueFile)).toBe(false)

			const pfeFile = holdFile("h14c")
			await db().createCollection(nsPfe)
			await db()
				.collection(nsPfe)
				.createIndex(
					{ ts: 1 },
					{
						name: "idx_pfe",
						expireAfterSeconds: 100,
						partialFilterExpression: { ts: { $gt: 5 } },
					},
				)
			const pfe = runHold(holdArgs(pfeFile, "inventory", nsPfe))
			expect(pfe.status).toBe(3)
			expect(failError(pfe)).toContain(
				"partialFilterExpression must be exactly",
			)
			expect((await ttlRows(nsPfe)).map((i) => i.name)).toEqual(["idx_pfe"])
			expect(existsSync(pfeFile)).toBe(false)

			const collationFile = holdFile("h14d")
			await db().createCollection(nsCollation)
			await db()
				.collection(nsCollation)
				.createIndex(
					{ ts: 1 },
					{
						name: "idx_collation",
						expireAfterSeconds: 100,
						collation: { locale: "en" },
					},
				)
			const collation = runHold(
				holdArgs(collationFile, "inventory", nsCollation),
			)
			expect(collation.status).toBe(3)
			expect(failError(collation)).toContain(
				'collation must be exactly {"locale":"simple"}',
			)
			expect((await ttlRows(nsCollation)).map((i) => i.name)).toEqual([
				"idx_collation",
			])
			expect(existsSync(collationFile)).toBe(false)
		})

		it("inventory refuses a missing namespace and a time-series collection (exit 3)", async () => {
			const id = randomUUID().slice(0, 8)
			const nsMissing = `h15_missing_${id}`
			const nsTimeseries = `h15_ts_${id}`
			await db().createCollection(nsTimeseries, {
				timeseries: { timeField: "ts", metaField: "meta" },
			})

			const missingFile = holdFile("h15a")
			const missing = runHold(holdArgs(missingFile, "inventory", nsMissing))
			expect(missing.status).toBe(3)
			expect(failError(missing)).toBe(`namespace not found: ${nsMissing}`)
			expect(existsSync(missingFile)).toBe(false)

			const timeseriesFile = holdFile("h15b")
			const timeseries = runHold(
				holdArgs(timeseriesFile, "inventory", nsTimeseries),
			)
			expect(timeseries.status).toBe(3)
			expect(failError(timeseries)).toContain(
				`not an ordinary collection (type=timeseries): ${nsTimeseries}`,
			)
			expect(existsSync(timeseriesFile)).toBe(false)
		})

		it("guard holds: refuse overwrite, wrong version, wrong database, and non-paused mark (exit 5)", async () => {
			const id = randomUUID().slice(0, 8)
			const ns = `h16_${id}`
			const nsPlain = `h16_plain_${id}`
			const file = holdFile("guards")
			await makeTtlCollection(ns, "idx_g", 86400)
			await db().createCollection(nsPlain)
			expect(runHold(holdArgs(file, "inventory", ns, nsPlain)).status).toBe(0)

			// An active hold is never silently replaced by a new inventory.
			const overwrite = runHold(holdArgs(file, "inventory", nsPlain))
			expect(overwrite.status).toBe(5)
			expect(failError(overwrite)).toContain("pause file already exists")

			// A hold file from another helper version is refused.
			const versioned = holdFile("guards-v2")
			const hold = readHold(file)
			writeVersionTwoHold(versioned, hold)
			const wrongVersion = runHold(holdArgs(versioned, "pause"))
			expect(wrongVersion.status).toBe(5)
			expect(failError(wrongVersion)).toContain(
				"hold file version 2 is not supported",
			)

			// A hold file is bound to the database it was recorded for.
			const foreignDb = runHold(["--db", "admin", "--file", file, "inspect"])
			expect(foreignDb.status).toBe(5)
			expect(failError(foreignDb)).toContain("hold file belongs to db")

			// mark-source-dropped requires the paused state.
			const pendingMark = runHold(holdArgs(file, "mark-source-dropped", ns))
			expect(pendingMark.status).toBe(5)
			expect(failError(pendingMark)).toContain(
				"mark-source-dropped requires paused state",
			)
		})
	},
)

/** Write a copy of a real hold with the version field replaced, standing in
 *  for a hold file produced by another helper version. */
function writeVersionTwoHold(file: string, hold: Record<string, unknown>) {
	writeFileSync(file, `${JSON.stringify({ ...hold, version: 2 }, null, 2)}\n`)
}
