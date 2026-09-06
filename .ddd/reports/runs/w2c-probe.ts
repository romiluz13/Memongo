/**
 * Wave 2c live probe — W06 workspace identity, W11 batchId-guarded
 * exactly-once tracker flush, W13 tenant stats separation, against the live
 * memongo-preview MongoDB (replica set 127.0.0.1:27019), using PRODUCTION
 * code on a disposable scratch database (dropped in finally).
 *
 * W06 (identity): with the manager's workspace directory configured and
 * MEMONGO_DEFAULT_SCOPE=workspace, an explicit `scope: "workspace"` write
 * and an unscoped (workspace-default) write BOTH land in the hashed
 * workspace partition `workspace:<hash16(realpath)>` — never the
 * `workspace:<agentId>` fallback — and the persisted idempotency
 * fingerprint equals computeIdempotencyFingerprint(..., workspaceDir), so
 * replay/conflict identity keys to the same partition the write lands in.
 * An idempotencyKey replay returns the original eventId without a second
 * document. A workspace-default search finds the written event; an
 * agent-scoped search does not (write/read partition agreement).
 * W11 (exactly-once): two recorded accesses flushed with an INJECTED
 * canonical bulkWrite failure (first bulkWrite on the events collection
 * rejects) re-buffer the whole snapshot; the retry flush applies exactly
 * once at BOTH layers — raw access_events carries ONE document (count 2,
 * batchId) and the canonical event shows accessCount 2 with
 * appliedBatches [batchId]. A fresh batch increments separately (window
 * grows to 2 ids). 33 further single-access batches keep appliedBatches
 * bounded at the last 32 ids ($slice). The W11 read-reconcile index
 * idx_access_events_batch_id exists on the real time-series collection and
 * serves the reconcile read shape (hinted explain → IXSCAN).
 * W13 (tenancy): two agents' memory files synced into the SAME shared
 * database+prefix; getMemoryStats and the production manager.stats() surface
 * report only the requesting agent's rows (2 files, not 5).
 *
 * W16 live evidence lives in the e2e battery (mongodb-e2e "E2E v2: health
 * semantics" stranded-obligation assertions and real-e2e-v2 projectionLag /
 * projectionLastRun payload assertions against this same stack), not in this
 * probe.
 *
 * Exit 0 = all checks pass; any failure prints and exits 1.
 */

import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MongoClient, type Db, type Collection, type Document } from "mongodb"
import { MongoDBMemoryManager } from "../../../packages/memory-engine/src/mongodb-manager.ts"
import { resolveMemoryBackendConfig } from "../../../packages/memory-engine/src/backend-config.ts"
import { resolveScopeIdentity } from "../../../packages/memory-engine/src/mongodb-scope.ts"
import { computeIdempotencyFingerprint } from "../../../packages/memory-engine/src/mongodb-idempotency-fingerprint.ts"
import { writeEvent } from "../../../packages/memory-engine/src/mongodb-events.ts"
import { AccessTracker } from "../../../packages/memory-engine/src/mongodb-access-tracker.ts"
import { syncToMongoDB } from "../../../packages/memory-engine/src/mongodb-sync.ts"
import { getMemoryStats } from "../../../packages/memory-engine/src/mongodb-analytics.ts"
import {
	eventsCollection,
	accessEventsCollection,
} from "../../../packages/memory-engine/src/mongodb-schema-collections.ts"

// ---------------------------------------------------------------------------
// Environment + scratch setup
// ---------------------------------------------------------------------------

const URI = "mongodb://127.0.0.1:27019/?directConnection=true"
const database = `ddd_w2c_${randomUUID().replaceAll("-", "")}`
const PREFIX = "probe_"
const AGENT = "w2c-agent"
const AGENT_B = "w2c-agent-b"
const TOKEN = "wqhxenob"

// W06: the unified default scope moves BOTH unscoped writes and unscoped
// searches onto the workspace partition.
process.env.MEMONGO_DEFAULT_SCOPE = "workspace"
// Deterministic scratch target regardless of an ambient environment.
process.env.MEMONGO_MONGODB_DATABASE = database
process.env.MEMONGO_MONGODB_COLLECTION_PREFIX = PREFIX

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 })

let passed = 0
let failed = 0
function check(cond: boolean, label: string): void {
	if (cond) {
		passed += 1
		console.log(`  ok ${passed}: ${label}`)
	} else {
		failed += 1
		console.log(`  FAIL ${failed}: ${label}`)
	}
}

const workspaces: string[] = []
function makeWorkspace(files: Array<{ name: string; body: string }>): string {
	const dir = mkdtempSync(join(tmpdir(), "w2c-probe-"))
	workspaces.push(dir)
	mkdirSync(join(dir, "memory"), { recursive: true })
	for (const f of files) {
		writeFileSync(join(dir, "memory", f.name), f.body)
	}
	return dir
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
	console.log(`probe database: ${database}`)
	await client.connect()
	const db = client.db(database)

	// W13 arrangement: two tenants' memory files in two workspaces, synced
	// into the SAME shared database + prefix.
	const wsA = makeWorkspace([
		{ name: "alpha-1.md", body: "alpha tenant file one, w2c probe.\n" },
		{ name: "alpha-2.md", body: "alpha tenant file two, w2c probe.\n" },
	])
	const wsB = makeWorkspace([
		{ name: "beta-1.md", body: "beta tenant file one, w2c probe.\n" },
		{ name: "beta-2.md", body: "beta tenant file two, w2c probe.\n" },
		{ name: "beta-3.md", body: "beta tenant file three, w2c probe.\n" },
	])

	// -----------------------------------------------------------------------
	// Production manager on the scratch deployment (runs ensureCollections,
	// search indexes + readiness waits, standard indexes incl. the W11
	// batchId index, then the full startup ladder).
	// -----------------------------------------------------------------------
	console.log("creating production MongoDBMemoryManager (workspace default scope)...")
	const cfg = {
		memory: {
			backend: "mongodb" as const,
			mongodb: { uri: URI },
		},
		agents: { defaults: { workspace: wsA } },
	}
	const resolved = resolveMemoryBackendConfig({ cfg, agentId: AGENT })
	const manager = await MongoDBMemoryManager.create({ cfg, agentId: AGENT, resolved })
	console.log("manager created")

	// =======================================================================
	// W06 — one complete identity at the manager boundary
	// =======================================================================
	console.log("\n=== W06: workspace identity ===")
	const wsReal = realpathSync(wsA)
	const expected = resolveScopeIdentity({
		scope: "workspace",
		agentId: AGENT,
		workspaceDir: wsReal,
	})
	check(
		/^workspace:[0-9a-f]{16}$/.test(expected.scopeRef),
		`resolver yields the hashed workspace partition (${expected.scopeRef}), not workspace:${AGENT}`,
	)

	const W06_BODY = `W06 workspace round-trip probe token ${TOKEN}. Writes and reads must agree on the hashed workspace partition.`
	const { eventId: explicitEventId } = await manager.writeConversationEvent({
		role: "user",
		body: W06_BODY,
		scope: "workspace",
	})
	const explicitDoc = await eventsCollection(db, PREFIX).findOne({
		eventId: explicitEventId,
	})
	check(explicitDoc !== null, "explicit workspace write persisted a canonical event")
	check(
		explicitDoc?.scope === "workspace" && explicitDoc?.scopeRef === expected.scopeRef,
		`explicit workspace write landed in the hashed partition (${explicitDoc?.scopeRef})`,
	)
	check(
		explicitDoc?.scopeRef !== `workspace:${AGENT}`,
		"explicit workspace write did NOT fall back to workspace:<agentId>",
	)

	const { eventId: defaultEventId } = await manager.writeConversationEvent({
		role: "user",
		body: `Unscoped write under the workspace default scope, token ${TOKEN} too.`,
	})
	const defaultDoc = await eventsCollection(db, PREFIX).findOne({
		eventId: defaultEventId,
	})
	check(
		defaultDoc?.scope === "workspace" && defaultDoc?.scopeRef === expected.scopeRef,
		`unscoped (MEMONGO_DEFAULT_SCOPE=workspace) write landed in the SAME hashed partition (${defaultDoc?.scopeRef})`,
	)

	// Fingerprint keys to the hashed partition: the persisted fingerprint
	// equals the realpath-based computation, not the agentId-fallback one.
	const KEY = "YOUR_IDEMPOTENCY_KEY_HERE"
	const { eventId: fpEventId } = await manager.writeConversationEvent({
		role: "user",
		body: "workspace fingerprint probe event",
		scope: "workspace",
		idempotencyKey: KEY,
	})
	const fpDoc = await eventsCollection(db, PREFIX).findOne({ eventId: fpEventId })
	const expectedFingerprint = computeIdempotencyFingerprint(
		{
			role: "user",
			body: "workspace fingerprint probe event",
			scope: "workspace",
			idempotencyKey: KEY,
		},
		AGENT,
		undefined,
		wsReal,
	)
	check(
		fpDoc?.idempotencyFingerprint === expectedFingerprint,
		"persisted idempotency fingerprint keys to the hashed workspace partition",
	)
	const replay = await manager.writeConversationEvent({
		role: "user",
		body: "workspace fingerprint probe event",
		scope: "workspace",
		idempotencyKey: KEY,
	})
	check(
		replay.eventId === fpEventId,
		"same-payload idempotencyKey replay returns the original eventId",
	)
	const keyCount = await eventsCollection(db, PREFIX).countDocuments({
		idempotencyKey: KEY,
	})
	check(keyCount === 1, `replay produced no second document (${keyCount} doc for the key)`)
	let conflictSeen = false
	try {
		await manager.writeConversationEvent({
			role: "user",
			body: "a DIFFERENT payload reusing the same key",
			scope: "workspace",
			idempotencyKey: KEY,
		})
	} catch (e) {
		conflictSeen = String((e as Error).constructor?.name).includes("IdempotencyConflict")
	}
	check(conflictSeen, "different-payload key reuse raises IdempotencyConflictError")

	// Round-trip: workspace-default search finds the token; agent-scoped
	// search (a different partition) does not.
	async function searchUntilFound(
		query: string,
		opts: { scope?: string; maxResults?: number } | undefined,
		tries = 4,
	): Promise<Array<{ snippet: string }>> {
		let last: Array<{ snippet: string }> = []
		for (let i = 0; i < tries; i += 1) {
			last = (await manager.search(query, opts as never)) as Array<{
				snippet: string
			}>
			if (last.some((r) => r.snippet.includes(TOKEN))) return last
			await sleep(1000)
		}
		return last
	}
	const wsResults = await searchUntilFound(TOKEN, { maxResults: 5 })
	check(
		wsResults.some((r) => r.snippet.includes(TOKEN)),
		`workspace-default search round-trips the workspace-partition write (${wsResults.length} results)`,
	)
	const agentResults = (await manager.search(TOKEN, {
		scope: "agent",
		maxResults: 5,
	})) as Array<{ snippet: string }>
	check(
		!agentResults.some((r) => r.snippet.includes(TOKEN)),
		`agent-scoped search does NOT see the workspace-partition event (${agentResults.length} results)`,
	)

	// =======================================================================
	// W11 — batchId-guarded exactly-once flush with an injected canonical
	// failure (the tracker runs production code; only the driver boundary
	// rejects once)
	// =======================================================================
	console.log("\n=== W11: tracker exactly-once flush ===")
	const EVT = "w2c-evt-tracker-1"
	await writeEvent({
		db,
		prefix: PREFIX,
		event: {
			eventId: EVT,
			agentId: AGENT,
			scope: "agent",
			role: "user",
			body: "w11 probe canonical event row",
		},
	})
	const seedDoc = await eventsCollection(db, PREFIX).findOne({ eventId: EVT })
	check(seedDoc !== null, "canonical event row seeded via production writeEvent")

	let injected = false
	let injectedCalls = 0
	function wrapDbForCanonicalFailure(real: Db): Db {
		return new Proxy(real, {
			get(target, prop, _receiver) {
				if (prop !== "collection") {
					const value = Reflect.get(target, prop, target)
					return typeof value === "function" ? value.bind(target) : value
				}
				return ((name: string, options?: unknown) => {
					const coll: Collection<Document> = (target as Db).collection(
						name,
						options as never,
					)
					if (name !== `${PREFIX}events`) return coll
					return new Proxy(coll, {
						get(t, p, _r) {
							const v = Reflect.get(t, p, t)
							if (p === "bulkWrite" && !injected) {
								injected = true
								injectedCalls += 1
								return () =>
									Promise.reject(
										new Error("probe-injected canonical bulk failure"),
									)
							}
							return typeof v === "function" ? v.bind(t) : v
						},
					})
				}) as never
			},
		}) as Db
	}

	const trackerDb = wrapDbForCanonicalFailure(db)
	const tracker = new AccessTracker(trackerDb, PREFIX, AGENT, {
		flushThreshold: 1000,
		flushIntervalMs: 600_000,
	})
	tracker.recordAccess({ collection: "events", id: EVT })
	tracker.recordAccess({ collection: "events", id: EVT })
	const flush1 = await tracker.flush()
	check(flush1 === 0, `flush with injected canonical failure returns 0 (${flush1})`)
	check(injectedCalls === 1, "canonical bulkWrite failed exactly once (injection armed)")

	const flush2 = await tracker.flush()
	check(flush2 === 1, `retry flush applies exactly one canonical op (${flush2})`)

	const rawDocs = await accessEventsCollection(db, PREFIX)
		.find({ memoryId: EVT })
		.toArray()
	check(rawDocs.length === 1, `raw access_events holds exactly ONE document for the batch (${rawDocs.length})`)
	check(
		rawDocs[0]?.count === 2 && typeof rawDocs[0]?.batchId === "string",
		`raw document carries count 2 and its batchId (${rawDocs[0]?.count}/${rawDocs[0]?.batchId})`,
	)
	const batch1 = String(rawDocs[0]?.batchId)

	const canonicalDoc = await eventsCollection(db, PREFIX).findOne({ eventId: EVT })
	check(
		canonicalDoc?.accessCount === 2,
		`canonical accessCount incremented EXACTLY once by 2 (${canonicalDoc?.accessCount})`,
	)
	check(
		canonicalDoc?.lastAccessedAt instanceof Date,
		"canonical lastAccessedAt set by the same atomic updateOne",
	)
	check(
		Array.isArray(canonicalDoc?.appliedBatches) &&
			(canonicalDoc?.appliedBatches as unknown[]).length === 1 &&
			(canonicalDoc?.appliedBatches as unknown[])[0] === batch1,
		`appliedBatches records the applied batch exactly once (${JSON.stringify(canonicalDoc?.appliedBatches)})`,
	)

	// A FRESH batch increments separately: the $ne guard only excludes the
	// recorded batch ids, never the counter.
	tracker.recordAccess({ collection: "events", id: EVT })
	const flush3 = await tracker.flush()
	const canonicalDoc2 = await eventsCollection(db, PREFIX).findOne({ eventId: EVT })
	check(
		flush3 === 1 &&
			canonicalDoc2?.accessCount === 3 &&
			(canonicalDoc2?.appliedBatches as unknown[]).length === 2,
		`fresh batch increments once more (accessCount 3, window 2 ids: ${JSON.stringify(canonicalDoc2?.appliedBatches)})`,
	)

	// Bounded window ($slice): 33 further single-access batches keep the
	// array at the newest 32 ids.
	for (let i = 0; i < 33; i += 1) {
		tracker.recordAccess({ collection: "events", id: EVT })
		await tracker.flush()
	}
	const canonicalDoc3 = await eventsCollection(db, PREFIX).findOne({ eventId: EVT })
	const batches = (canonicalDoc3?.appliedBatches as string[]) ?? []
	const totalRaw = await accessEventsCollection(db, PREFIX)
		.countDocuments({ memoryId: EVT })
	check(
		batches.length === 32 && !batches.includes(batch1) && batches.length === new Set(batches).size,
		`appliedBatches window bounded at the newest 32 distinct ids (${batches.length})`,
	)
	check(
		canonicalDoc3?.accessCount === 36,
		`every batch incremented exactly once across 36 accesses (${canonicalDoc3?.accessCount})`,
	)
	check(
		totalRaw === 35,
		`raw layer holds exactly one document per batch (${totalRaw})`,
	)

	// The W11 read-reconcile index exists on the real time-series collection
	// and serves the reconcile read shape.
	let indexNames: string[] = []
	try {
		indexNames = (await accessEventsCollection(db, PREFIX).listIndexes().toArray()).map(
			(i) => String(i.name),
		)
	} catch {
		indexNames = (
			await db.collection(`system.buckets.${PREFIX}access_events`).listIndexes().toArray()
		).map((i) => String(i.name))
	}
	check(
		indexNames.includes("idx_access_events_batch_id"),
		`idx_access_events_batch_id exists on access_events (${indexNames.join(", ")})`,
	)
	const hinted = await accessEventsCollection(db, PREFIX)
		.find({ batchId: { $in: [batch1] } }, { hint: "idx_access_events_batch_id" } as never)
		.explain()
	const hintedPlan = JSON.stringify(hinted)
	check(
		hintedPlan.includes("idx_access_events_batch_id"),
		"hinted explain uses idx_access_events_batch_id (IXSCAN) for the reconcile filter",
	)
	const unhinted = await accessEventsCollection(db, PREFIX)
		.find({ batchId: { $in: [batch1] } })
		.explain()
	console.log(
		`  (info) unhinted reconcile-read plan: ${JSON.stringify((unhinted as { queryPlanner?: { winningPlan?: unknown } }).queryPlanner?.winningPlan ?? unhinted).slice(0, 220)}`,
	)

	// =======================================================================
	// W13 — tenant-filtered stats on the shared deployment
	// =======================================================================
	console.log("\n=== W13: tenant stats separation ===")
	await syncToMongoDB({
		db,
		prefix: PREFIX,
		agentId: AGENT,
		workspaceDir: wsA,
		embeddingMode: "automated",
		force: true,
	})
	await syncToMongoDB({
		db,
		prefix: PREFIX,
		agentId: AGENT_B,
		workspaceDir: wsB,
		embeddingMode: "automated",
		force: true,
	})

	const statsA = await getMemoryStats(db, PREFIX, AGENT)
	check(statsA.totalFiles === 2, `agent stats see only the agent's 2 files (${statsA.totalFiles})`)
	const statsB = await getMemoryStats(db, PREFIX, AGENT_B)
	check(statsB.totalFiles === 3, `agent-b stats see only agent-b's 3 files (${statsB.totalFiles})`)
	// Files rows group by their sync lane ("conversation" for memory files),
	// already tenant-filtered; both tenants' rows coexist in the shared
	// collection, so the per-lane counts must split 2 / 3 by agentId.
	const convA = statsA.sources.find((s) => s.source === "conversation")
	const convB = statsB.sources.find((s) => s.source === "conversation")
	check(
		convA?.fileCount === 2 && convB?.fileCount === 3,
		`per-lane source rows split by tenant (conversation lane: ${convA?.fileCount} vs ${convB?.fileCount})`,
	)
	// A third agent with NO data on the shared deployment sees nothing at
	// all — the strongest form of the no-leak claim.
	const statsC = await getMemoryStats(db, PREFIX, "w2c-agent-never")
	check(
		statsC.totalFiles === 0 && statsC.sources.length === 0,
		`a never-synced agent on the shared deployment sees zero rows (${statsC.totalFiles} files, ${statsC.sources.length} source rows)`,
	)
	const managerStats = await manager.stats()
	check(
		managerStats.totalFiles === 2,
		`production manager.stats() is tenant-scoped: 2 files, not the deployment-wide 5 (${managerStats.totalFiles})`,
	)
	check(
		managerStats.collectionSizes.files === 2,
		`manager.stats() files collection size is tenant-scoped (${managerStats.collectionSizes.files})`,
	)

	await tracker.close()
	await manager.close()
	console.log(`\nprobe complete: ${passed} passed, ${failed} failed`)
}

main()
	.catch((err) => {
		console.error("probe error:", err)
		failed += 1
	})
	.finally(async () => {
		try {
			await client.db(database).dropDatabase()
			console.log(`cleanup: dropped ${database}`)
		} catch (err) {
			console.error("cleanup: dropDatabase failed:", err)
		}
		try {
			await client.close()
		} catch {
			// ignore
		}
		for (const dir of workspaces) {
			rmSync(dir, { recursive: true, force: true })
		}
		console.log("cleanup: closed client, removed workspaces")
		if (failed > 0) {
			process.exit(1)
		}
	})
