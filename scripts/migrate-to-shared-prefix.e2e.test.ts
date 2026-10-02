/**
 * Loopback e2e for the W16 server-copy shared-prefix migration.
 *
 * Spawns the real script under bun against an owned, uniquely named,
 * disposable database on a loopback MongoDB, with an explicit URI and
 * database name. The database is checked absent before use and dropped with
 * an absence proof afterward. Fixtures are synthesized up front; each case
 * selects its agent with --agent, so the shared target accumulates
 * unrelated rows from other agents exactly like the real shared-collection
 * deployment.
 *
 * Observation pins persisted BSON facts without trusting any client decode
 * setting: $type and $objectToArray are evaluated by the server, and regex
 * values are read back with the per-operation bsonRegExp option (a
 * lossless BSONRegExp decode — a JS RegExp decode would drop the x/l
 * flags the copy exists to preserve).
 *
 * Native vs unit-injected coverage: the uncertain copy outcome IS
 * reproduced natively (a non-_id unique index on the target aborts the
 * $merge mid-copy, leaving a partial landing). Raw-cursor read errors and
 * non-buffer rows are unit-injected only: reproducing them natively
 * requires server failpoints, which this environment must not toggle.
 * Byte-identical duplicate rows (true multiset duplicates) cannot exist in
 * a plain collection (unique _id); the unit oracle exercises multiset
 * counting directly.
 *
 * Gated on MIGRATE_E2E_MONGODB_URI, which must point at a loopback host
 * (localhost / 127.0.0.1 / ::1). Refuses anything else rather than touching
 * a shared or remote database.
 *
 * Run (from the repo root):
 *   MIGRATE_E2E_MONGODB_URI=mongodb://127.0.0.1:27017/?directConnection=true \
 *     vitest run --config scripts/vitest.e2e.config.ts \
 *     scripts/migrate-to-shared-prefix.e2e.test.ts
 *
 * directConnection is required for the local Docker-hosted preview
 * replica set: it advertises itself as memongo-preview:27017, which only
 * resolves inside the Docker network, so replica-set discovery from the
 * host fails on DNS while a direct connection to the mapped port works.
 */
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { BSON, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const uri = process.env.MIGRATE_E2E_MONGODB_URI?.trim() ?? ""

function isLoopback(candidate: string): boolean {
	try {
		const url = new URL(candidate)
		return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
	} catch {
		return false
	}
}

const SCRIPT = fileURLToPath(
	new URL("./migrate-to-shared-prefix.ts", import.meta.url),
)
const DATABASE = `w16_migrate_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`
const TARGET_PREFIX = "probe_"

/** This suite's fixture rows carry string _ids (the lone UUID row aside),
 *  while the default Document handle infers an ObjectId _id; typed handles
 *  keep the fixtures' faithful shapes on every read and write. */
type StringIdRow = { _id: string; [key: string]: unknown }

/** The one fixture row whose _id is a BSON UUID. */
type UuidIdRow = { _id: BSON.UUID; [key: string]: unknown }

function runMigration(args: string[]) {
	const result = spawnSync("bun", [SCRIPT, ...args], {
		env: {
			...process.env,
			MEMONGO_MONGODB_URI: uri,
			MEMONGO_MONGODB_DATABASE: DATABASE,
			MEMONGO_MONGODB_TARGET_PREFIX: TARGET_PREFIX,
		},
		encoding: "utf8",
		// External timeout: a hung CLI run must not hang the suite.
		timeout: 120_000,
	})
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout,
		stderr: result.stderr,
	}
}

describe.skipIf(!uri || !isLoopback(uri))(
	"migrate-to-shared-prefix loopback e2e (owned disposable db)",
	() => {
		let client: MongoClient
		let bsonUuid: BSON.UUID

		const db = () => {
			if (!client) {
				throw new Error("client not connected")
			}
			return client.db(DATABASE)
		}

		// Fixture-typed handles (StringIdRow/UuidIdRow above): every read and
		// write of a string-_id fixture goes through one of these.
		const stringCollection = (name: string) =>
			db().collection<StringIdRow>(name)
		const uuidCollection = (name: string) => db().collection<UuidIdRow>(name)

		const collectionNames = async () =>
			(await db().listCollections().toArray()).map((info) => info.name)

		// Server-side observation of the persisted BSON type of `v`, immune
		// to any client decode settings: $type is evaluated by the server.
		const typesOf = async (coll: string, ids: string[]) => {
			const rows = await db()
				.collection(coll)
				.aggregate<{ _id: string; t: string }>([
					{ $match: { _id: { $in: ids } } },
					{ $project: { t: { $type: "$v" } } },
				])
				.toArray()
			return Object.fromEntries(rows.map((row) => [row._id, row.t]))
		}

		// Server-side observation of the persisted field order of an embedded
		// document ($objectToArray preserves stored order; JS enumeration
		// would reorder integer-like keys).
		const keyOrderOf = async (coll: string, id: string, field: string) => {
			const rows = await db()
				.collection(coll)
				.aggregate([
					{ $match: { _id: id } },
					{
						$project: {
							keys: {
								$map: {
									input: { $objectToArray: `$${field}` },
									in: "$$this.k",
								},
							},
						},
					},
				])
				.toArray()
			return (rows[0]?.keys as string[]) ?? []
		}

		beforeAll(async () => {
			client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 })
			await client.connect()
			// Absence before use: the disposable database must not exist.
			const before = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true })
			if (before.databases.some((entry) => entry.name === DATABASE)) {
				throw new Error(`owned database ${DATABASE} already exists; refusing`)
			}
			const database = db()
			// Wrong same-_id target payload (root's original repro): the
			// target keeps its row; the source must be retained and flagged.
			await stringCollection("probe_repro_events").insertOne({
				_id: "same-id",
				eventId: "source-intent",
				body: "source payload requiring preservation",
			})
			await stringCollection("probe_events").insertOne({
				_id: "same-id",
				eventId: "different-intent",
				body: "different target payload",
			})
			// Genuinely matching interrupted retry: identical bytes both sides.
			const identical = {
				_id: "retry-id",
				eventId: "same-intent",
				body: "identical payload",
				at: new Date("2024-01-01T00:00:00.000Z"),
			}
			await stringCollection("probe_retry_events").insertOne(identical)
			await stringCollection("probe_events").insertOne({ ...identical })
			// Clean migration: source only.
			await stringCollection("probe_clean_events").insertMany([
				{
					_id: "clean-1",
					body: "one",
					at: new Date("2024-05-01T00:00:00.000Z"),
				},
				{ _id: "clean-2", body: "two" },
			])
			// Typed numerics whose default-promoted decode would erase the
			// persisted BSON type (int64 -> int32, integral double -> int32).
			// Writes are unaffected by promotion; the BSON instances below
			// persist their exact types.
			await stringCollection("probe_codec_events").insertMany([
				{ _id: "c-long", v: BSON.Long.fromNumber(1) },
				{ _id: "c-double", v: new BSON.Double(1) },
				{ _id: "c-negzero", v: new BSON.Double(-0) },
				{ _id: "c-int", v: 7 },
				{ _id: "c-biglong", v: BSON.Long.fromString("9223372036854775807") },
			])
			// Same numeric value, different persisted BSON type: source int32
			// vs target int64 (decoded values compare equal; digests differ).
			await stringCollection("probe_tconf_events").insertOne({
				_id: "tc",
				v: 1,
			})
			await stringCollection("probe_events").insertOne({
				_id: "tc",
				v: BSON.Long.fromNumber(1),
			})
			// Literal {$date: {$numberLong: "0"}} subdocument vs Date(0):
			// identical Extended JSON, different persisted BSON.
			await stringCollection("probe_litdoc_events").insertOne({
				_id: "lw",
				v: { $date: { $numberLong: "0" } },
			})
			await stringCollection("probe_events").insertOne({
				_id: "lw",
				v: new Date(0),
			})
			// BSON structures a decoded client copy cannot round-trip: regex
			// flags x/i/l/u, a DBRef-ordered subdocument ($id before $ref),
			// an embedded document whose integer-like key must not be
			// reordered, and a UUID _id. Maps pin the persisted field order.
			await stringCollection("probe_bson_access_events").insertMany([
				{ _id: "rx", v: new BSON.BSONRegExp("alpha-", "x") },
				{ _id: "ri", v: new BSON.BSONRegExp("beta", "i") },
				{ _id: "rl", v: new BSON.BSONRegExp("epsilon-", "l") },
				{ _id: "ru", v: new BSON.BSONRegExp("zeta-", "u") },
				{
					_id: "db",
					d: new Map<string, unknown>([
						["$id", new BSON.ObjectId()],
						["$ref", "entities"],
					]),
				},
				{
					_id: "nkq",
					sub: new Map([
						["a", 1],
						["0", 2],
					]),
				},
			])
			bsonUuid = new BSON.UUID()
			await uuidCollection("probe_bson_access_events").insertOne({
				_id: bsonUuid,
				v: new BSON.BSONRegExp("gamma-", "x"),
			})
			// Equal-content rows with distinct _ids; only the first landed in
			// a previous interrupted run (partial retry + occurrence count).
			await stringCollection("probe_mult_relations").insertMany([
				{ _id: "mult-1", body: "equal content", n: 1 },
				{ _id: "mult-2", body: "equal content", n: 2 },
			])
			await stringCollection("probe_relations").insertOne({
				_id: "mult-1",
				body: "equal content",
				n: 1,
			})
			// Non-_id unique index on the target: the second $merge insert
			// aborts the aggregate mid-copy (native uncertain outcome with a
			// partial landing).
			await stringCollection("probe_uniq_meta").insertMany([
				{ _id: "uq-1", traceId: "same-trace", body: "first" },
				{ _id: "uq-2", traceId: "same-trace", body: "second" },
			])
			await stringCollection("probe_meta").createIndex(
				{ traceId: 1 },
				{ unique: true },
			)
			// Shape guard fixtures: time-series source, capped source, TTL
			// index on the source, TTL index on the target, view target.
			// The TTL dates sit far in the future / on absent fields so no
			// expiry can fire during the run.
			await database.createCollection("probe_shape_memory_telemetry", {
				timeseries: { timeField: "ts" },
			})
			// A time-series row has no client _id (the server rejects one),
			// so this lone fixture stays on the untyped handle.
			await database
				.collection("probe_shape_memory_telemetry")
				.insertOne({ ts: new Date(), meta: { agentId: "shape" }, value: 1 })
			await database.createCollection("probe_cap_entities", {
				capped: true,
				size: 4096,
			})
			await stringCollection("probe_cap_entities").insertOne({
				_id: "cap-1",
				body: "capped row",
			})
			await stringCollection("probe_ttl_episodes").insertOne({
				_id: "ttl-1",
				purgeAt: new Date("2099-01-01T00:00:00.000Z"),
				body: "ttl row",
			})
			await stringCollection("probe_ttl_episodes").createIndex(
				{ purgeAt: 1 },
				{ expireAfterSeconds: 3600 },
			)
			await stringCollection("probe_ttlt_files").insertOne({
				_id: "ttlt-1",
				body: "plain source row",
			})
			await stringCollection("probe_files").createIndex(
				{ expiresAt: 1 },
				{ expireAfterSeconds: 60 },
			)
			await stringCollection("probe_view_chunks").insertOne({
				_id: "view-1",
				body: "row targeting a view",
			})
			await database.createCollection("probe_chunks", {
				viewOn: "probe_events",
				pipeline: [],
			})
			// W16 ledger-discovery fixtures: per-agent cost ledgers, the
			// collection the schema initializer creates (C-017) but the
			// discovery suffix list used to omit. Rows mirror the writer's
			// upsert shape (mongodb-cost-ledger.ts): one document per
			// (agentId, UTC day, kind) with token/unit counters. `disca` and
			// `discb` back the dry-run discovery proofs and are never
			// dropped; `led` backs the real copy/verify/drop/retry cycle.
			await database.collection("probe_disca_memory_cost_ledger").insertOne({
				agentId: "disca",
				day: "2025-01-14",
				kind: "llm",
				inputTokens: 1200,
				outputTokens: 340,
				createdAt: new Date("2025-01-14T10:00:00.000Z"),
				updatedAt: new Date("2025-01-14T10:05:00.000Z"),
			})
			await database.collection("probe_discb_memory_cost_ledger").insertOne({
				agentId: "discb",
				day: "2025-01-14",
				kind: "llm",
				inputTokens: 55,
				outputTokens: 21,
				createdAt: new Date("2025-01-14T11:00:00.000Z"),
				updatedAt: new Date("2025-01-14T11:05:00.000Z"),
			})
			await database.collection("probe_led_memory_cost_ledger").insertOne({
				agentId: "led",
				day: "2025-01-15",
				kind: "llm",
				inputTokens: 800,
				outputTokens: 160,
				embedUnits: 12,
				createdAt: new Date("2025-01-15T09:00:00.000Z"),
				updatedAt: new Date("2025-01-15T09:05:00.000Z"),
			})
		})

		afterAll(async () => {
			if (!client) {
				return
			}
			await client.db(DATABASE).dropDatabase()
			const names = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true })
			const stillThere = names.databases.some(
				(entry) => entry.name === DATABASE,
			)
			await client.close()
			if (stillThere) {
				throw new Error(`owned database ${DATABASE} survived cleanup`)
			}
		})

		it("rejects a wrong same-_id target payload, reports unmatched, and keeps both sides", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "repro"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("scanned=1 unmatched=1")
			expect(run.stdout).toContain("verified=false")
			expect(run.stdout).not.toContain("verified=false dropped")
			expect(run.stdout).toContain("dropped=0")
			expect(await collectionNames()).toContain("probe_repro_events")
			const target = await stringCollection("probe_events").findOne({
				_id: "same-id",
			})
			expect(target?.eventId).toBe("different-intent")
			const source = await stringCollection("probe_repro_events").findOne({
				_id: "same-id",
			})
			expect(source?.eventId).toBe("source-intent")
		})

		it("verifies and drops a genuinely matching interrupted retry", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "retry"])
			expect(run.status, run.stdout + run.stderr).toBe(0)
			expect(run.stdout).toContain(
				"scanned=1 unmatched=0 verified=true dropped",
			)
			expect(await collectionNames()).not.toContain("probe_retry_events")
			const target = await stringCollection("probe_events").findOne({
				_id: "retry-id",
			})
			expect(target?.body).toBe("identical payload")
		})

		it("migrates a clean plain collection, allows unrelated shared-target rows, and drops the source", async () => {
			// probe_events already holds unrelated rows (same-id, retry-id,
			// tc, lw) belonging to no clean-agent source: extras are allowed.
			const run = runMigration(["--apply", "--drop", "--agent", "clean"])
			expect(run.status, run.stdout + run.stderr).toBe(0)
			expect(run.stdout).toContain(
				"scanned=2 unmatched=0 verified=true dropped",
			)
			expect(await collectionNames()).not.toContain("probe_clean_events")
			const docs = await stringCollection("probe_events")
				.find({ _id: { $in: ["clean-1", "clean-2"] } })
				.toArray()
			expect(docs.map((doc) => doc._id).toSorted()).toEqual([
				"clean-1",
				"clean-2",
			])
		})

		it("preserves persisted BSON types through the copy (server-observed)", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "codec"])
			expect(run.status, run.stdout + run.stderr).toBe(0)
			expect(run.stdout).toContain(
				"scanned=5 unmatched=0 verified=true dropped",
			)
			expect(await collectionNames()).not.toContain("probe_codec_events")
			// The migrated rows must carry the exact persisted BSON types of
			// the source: int64 stays int64, integral double stays double,
			// -0 stays a double with its sign.
			expect(
				await typesOf("probe_events", [
					"c-long",
					"c-double",
					"c-negzero",
					"c-int",
					"c-biglong",
				]),
			).toEqual({
				"c-long": "long",
				"c-double": "double",
				"c-negzero": "double",
				"c-int": "int",
				"c-biglong": "long",
			})
			const negZero = await stringCollection("probe_events").findOne({
				_id: "c-negzero",
			})
			expect(Object.is(negZero?.v, -0)).toBe(true)
		})

		it("copies regex flags x/i/l/u, DBRef subdoc order, integer-like key order, and a UUID _id byte-exactly", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "bson"])
			expect(run.status, run.stdout + run.stderr).toBe(0)
			expect(run.stdout).toContain(
				"scanned=7 unmatched=0 verified=true dropped",
			)
			expect(await collectionNames()).not.toContain("probe_bson_access_events")
			// Server-side: all four regex rows persist as BSON regex.
			expect(
				await typesOf("probe_access_events", ["rx", "ri", "rl", "ru"]),
			).toEqual({
				rx: "regex",
				ri: "regex",
				rl: "regex",
				ru: "regex",
			})
			// Lossless BSONRegExp decode (bsonRegExp option): the x/l/u flags
			// a JS RegExp cannot hold survived the copy.
			const rows = await stringCollection("probe_access_events")
				.find({ _id: { $in: ["rx", "ri", "rl", "ru"] } }, { bsonRegExp: true })
				.toArray()
			expect(
				Object.fromEntries(
					rows.map((row) => {
						const regex = row.v as BSON.BSONRegExp
						return [row._id, `${regex.pattern}/${regex.options}`]
					}),
				),
			).toEqual({
				rx: "alpha-/x",
				ri: "beta/i",
				rl: "epsilon-/l",
				ru: "zeta-/u",
			})
			// Server-side stored field order: $id precedes $ref (non-canonical
			// DBRef order), and the integer-like key "0" stays after "a".
			expect(await keyOrderOf("probe_access_events", "db", "d")).toEqual([
				"$id",
				"$ref",
			])
			expect(await keyOrderOf("probe_access_events", "nkq", "sub")).toEqual([
				"a",
				"0",
			])
			// The UUID _id survives as binary subtype 4 and still matches the
			// original UUID server-side (find matched on the stored bytes).
			// bsonRegExp keeps the x-flag value decodable losslessly.
			const uuidRow = await uuidCollection("probe_access_events").findOne(
				{ _id: bsonUuid },
				{ bsonRegExp: true },
			)
			expect(uuidRow?._id).toBeInstanceOf(BSON.Binary)
			expect(uuidRow?._id?.sub_type).toBe(4)
			expect((uuidRow?.v as BSON.BSONRegExp)?.options).toBe("x")
		})

		it("rejects a same-value different-type conflicting target and keeps the source", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "tconf"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("scanned=1 unmatched=1")
			expect(run.stdout).toContain("verified=false")
			expect(run.stdout).toContain("dropped=0")
			expect(await collectionNames()).toContain("probe_tconf_events")
			// The conflicting target row is untouched and still int64.
			expect(await typesOf("probe_events", ["tc"])).toEqual({ tc: "long" })
		})

		it("rejects the literal-$date/Date collision that Extended JSON cannot see", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "litdoc"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("scanned=1 unmatched=1")
			expect(run.stdout).toContain("verified=false")
			expect(await collectionNames()).toContain("probe_litdoc_events")
			// Both sides keep their real persisted types: the source holds an
			// embedded document, the target a datetime.
			expect(await typesOf("probe_litdoc_events", ["lw"])).toEqual({
				lw: "object",
			})
			expect(await typesOf("probe_events", ["lw"])).toEqual({ lw: "date" })
		})

		it("completes a partial retry of equal-content rows and consumes every occurrence", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "mult"])
			expect(run.status, run.stdout + run.stderr).toBe(0)
			expect(run.stdout).toContain(
				"scanned=2 unmatched=0 verified=true dropped",
			)
			expect(await collectionNames()).not.toContain("probe_mult_relations")
			const docs = await stringCollection("probe_relations")
				.find({ _id: { $in: ["mult-1", "mult-2"] } })
				.toArray()
			expect(docs.map((doc) => doc._id).toSorted()).toEqual([
				"mult-1",
				"mult-2",
			])
		})

		it("retains the source when a non-_id unique index aborts the $merge mid-copy", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "uniq"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("scanned=2 unmatched=1")
			expect(run.stdout).toContain("verified=false")
			expect(run.stdout).toMatch(/uncertain="copy aggregate outcome unknown/)
			expect(await collectionNames()).toContain("probe_uniq_meta")
			// The receipt reflects durable state: exactly one row landed
			// before the unique-index conflict aborted the aggregate.
			expect(await stringCollection("probe_meta").countDocuments()).toBe(1)
		})

		it("flags time-series sources as unsupported in dry-run and apply", async () => {
			const dry = runMigration(["--agent", "shape"])
			expect(dry.status, dry.stdout + dry.stderr).toBe(0)
			expect(dry.stdout).toContain("UNSUPPORTED")
			expect(dry.stdout).toContain("timeseries")
			const run = runMigration(["--apply", "--drop", "--agent", "shape"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("unsupported")
			expect(run.stdout).toContain("source is a timeseries collection")
			expect(await collectionNames()).toContain("probe_shape_memory_telemetry")
		})

		it("flags capped sources as unsupported in dry-run and apply", async () => {
			const dry = runMigration(["--agent", "cap"])
			expect(dry.status, dry.stdout + dry.stderr).toBe(0)
			expect(dry.stdout).toContain("UNSUPPORTED")
			expect(dry.stdout).toContain("capped")
			const run = runMigration(["--apply", "--drop", "--agent", "cap"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("source is a capped collection")
			expect(await collectionNames()).toContain("probe_cap_entities")
		})

		it("flags an active TTL index on the source, naming the index", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "ttl"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("source has active TTL index(es) purgeAt_1")
			expect(run.stdout).toContain("intermediate guard")
			expect(await collectionNames()).toContain("probe_ttl_episodes")
		})

		it("flags an active TTL index on the target, naming the index", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "ttlt"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain(
				"target has active TTL index(es) expiresAt_1",
			)
			expect(await collectionNames()).toContain("probe_ttlt_files")
		})

		it("flags a view target as unsupported", async () => {
			const run = runMigration(["--apply", "--drop", "--agent", "view"])
			expect(run.status, run.stdout + run.stderr).not.toBe(0)
			expect(run.stdout).toContain("target is a view collection")
			expect(await collectionNames()).toContain("probe_view_chunks")
		})

		it("discovers the cost ledger for a filtered agent and excludes other agents (dry-run)", async () => {
			const run = runMigration(["--agent", "disca"])
			expect(run.status, run.stdout + run.stderr).toBe(0)
			expect(run.stdout).toContain(
				"dry-run probe_disca_memory_cost_ledger -> probe_memory_cost_ledger docs=1",
			)
			// The other agent's ledger is excluded by the filter...
			expect(run.stdout).not.toContain("discb")
			// ...and the already-shared target is never itself a source.
			expect(run.stdout).not.toContain("dry-run probe_memory_cost_ledger ->")
			expect(await collectionNames()).toContain(
				"probe_disca_memory_cost_ledger",
			)
		})

		it("unfiltered dry-run discovers both agents' cost ledgers but never the shared target", async () => {
			const run = runMigration([])
			expect(run.status, run.stdout + run.stderr).toBe(0)
			expect(run.stdout).toContain(
				"dry-run probe_disca_memory_cost_ledger -> probe_memory_cost_ledger",
			)
			expect(run.stdout).toContain(
				"dry-run probe_discb_memory_cost_ledger -> probe_memory_cost_ledger",
			)
			expect(run.stdout).not.toContain("dry-run probe_memory_cost_ledger ->")
		})

		it("copies, verifies, drops, and idempotently re-verifies a real cost-ledger row", async () => {
			// First pass applies without dropping: keepExisting makes the
			// retry a no-op copy that still verifies byte-exactly.
			const first = runMigration(["--apply", "--agent", "led"])
			expect(first.status, first.stdout + first.stderr).toBe(0)
			expect(first.stdout).toContain(
				"copy probe_led_memory_cost_ledger -> probe_memory_cost_ledger scanned=1 unmatched=0 verified=true",
			)
			// No per-collection drop happened (the totals line's dropped=0
			// counter is expected; the dropped flag on the receipt is not).
			expect(first.stdout).not.toContain("verified=true dropped")
			expect(await collectionNames()).toContain("probe_led_memory_cost_ledger")
			// Retry: the same copy verifies idempotently, then drops.
			const retry = runMigration(["--apply", "--drop", "--agent", "led"])
			expect(retry.status, retry.stdout + retry.stderr).toBe(0)
			expect(retry.stdout).toContain(
				"scanned=1 unmatched=0 verified=true dropped",
			)
			expect(await collectionNames()).not.toContain(
				"probe_led_memory_cost_ledger",
			)
			// The shared ledger holds the row with its tenant key, day bucket,
			// and counters intact.
			const row = await db()
				.collection("probe_memory_cost_ledger")
				.findOne({ agentId: "led", day: "2025-01-15", kind: "llm" })
			expect(row).toMatchObject({
				agentId: "led",
				day: "2025-01-15",
				kind: "llm",
				inputTokens: 800,
				outputTokens: 160,
				embedUnits: 12,
			})
			// A further filtered run has nothing left to discover.
			const drained = runMigration(["--agent", "led"])
			expect(drained.status, drained.stdout + drained.stderr).toBe(0)
			expect(drained.stdout).toContain(
				"no per-agent probe_<agent>_* collections found",
			)
		})
	},
)
