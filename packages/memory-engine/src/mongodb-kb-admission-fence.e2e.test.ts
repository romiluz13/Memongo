// Native KB admission-fence e2e — plan e5ec10dc §7 (construction grant).
//
// RED ANCHOR N1: a KB auto-refresh attempt parks at the REAL source-path
// dedup read (mongodb-kb.ts — `kb.findOne({"source.path": path, scopeRef})`,
// outside every transaction) AFTER the read resolves and BEFORE the result
// returns to ingest. While the attempt holds its (already captured)
// admission token, the REAL public erasure of the same tenant runs to a
// complete receipt. On release, the attempt must NOT resurrect the erased
// tenant's knowledge base: zero new KB parents, zero chunks, zero ledger
// units, no marker, and the post-erasure cache sentinel must survive.
//
// The assertion set is IDENTICAL on the pre-implementation ("OLD") and
// accepted ("NEW") product bytes. On OLD bytes the unfenced branch commits
// the parent, chunks, and a fire-and-forget ledger upsert after the release
// — the first KB-resurrection assertion is the expected RED. On NEW bytes
// the admission branch revalidates the gate inside the document fence,
// observes the advanced epoch, and aborts the whole attempt closed.
//
// REAL-OPERATION LEDGER SETTLEMENT (harness contract, see
// .orchestrator/evidence/kb-admission-native/corrective-design.md): OLD
// bytes bill the persist fire-and-forget — `incrementLedger(...)` starts
// the real updateOne synchronously, attaches `.catch`, and returns void
// (mongodb-cost-ledger.ts:81-111) — so the refresh promise settling does
// NOT bound the ledger upsert, and a quiet data interval cannot establish
// it. Every db the manager/ingest boundary receives is wrapped by
// `trackLedgerOperations`, which records the EXACT promise the real
// collection method call returns (receiver, arguments, session option and
// return behavior preserved; the product's own `.catch` chain stays
// attached to that same promise); `drainLedgerOperations` then awaits the
// ACTUAL terminal state of every started real operation — after attempt
// settlement, on early-failure paths in each case's finally, and before
// the fixture drop. On NEW bytes the aborted attempt starts no billing
// operation at all (drained === 0); on OLD bytes the drain settles exactly
// the real fire-and-forget resurrection bill (drained >= 1) after the
// already-failed KB-resurrection assertion.
//
// N3 (post-erasure re-admission), N4 (direct-ingest fault cross-product
// rollback, Correction 4: fresh/replacement × chunk/ledger), N5 (cache
// fence fault/conflict), and N6 (foreign-child preservation under the real
// unique indexes) are constructed in this same
// file per plan §7; each keeps this harness contract: explicit URI (no
// default, no skip, never printed), unique disposable database, real
// manager/engine behavior (no fakes), parked promises observed immediately
// and unconditionally released+awaited in a never-throwing finally (primary
// error retained, cleanup failures reported via AggregateError — never
// masked), bounded lifetime with HONEST full-sequential budgets (10s
// selection/connect, 45s client CSOT on every operation and transaction,
// a 45s socketTimeoutMS socket fallback for the CSOT-unreached close
// path's internal commands, 30s latch watchdogs that bound the parked
// interval itself — expiry recorded separately from the case's own
// release and FAILING the case, never a silent self-release — and
// per-case/hook timeouts set ABOVE each body's source-counted
// full-sequential worst-case sum, so the installed Vitest 4.1.10 wrapper
// timeout can never fire before the body, including its finally, has
// settled (see the budget block before beforeAll), and verified teardown
// (drop + absence proof + awaited close).
//
// NOT EXECUTED in the construction grant: this file is validated by static
// diagnostics only (no import, no DB contact).
//
// Target gating — same hard contract as the erasure-gate and
// projection-repair native precedents.
const rawTestUri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	typeof rawTestUri !== "string" ||
	rawTestUri.length === 0 ||
	!(
		rawTestUri.startsWith("mongodb://") ||
		rawTestUri.startsWith("mongodb+srv://")
	)
) {
	throw new Error(
		"mongodb-kb-admission-fence.e2e requires MEMONGO_TEST_MONGODB_URI " +
			"(mongodb:// or mongodb+srv://); no default, no skip",
	)
}
const TEST_URI = rawTestUri

import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { MongoClient } from "mongodb"
import type { CollectionOptions, Db } from "mongodb"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	costLedgerCollection,
	ensureCollections,
	ensureStandardIndexes,
	kbCollection,
	kbChunksCollection,
	metaCollection,
	mutationsCollection,
	queryCacheCollection,
} from "./mongodb-schema.js"
import { costLedgerDay } from "./mongodb-cost-ledger.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"
import { CHUNK_SCHEME_VERSION, hashText } from "./internal.js"
import {
	ingestToKB,
	type KBDocument,
	type KBIngestResult,
} from "./mongodb-kb.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

// ---------------------------------------------------------------------------
// Fixture: one unique, owned, disposable database per run
// ---------------------------------------------------------------------------

const RUN_UUID = randomUUID()
const DB_NAME = `memongo_kb_admission_${RUN_UUID}`
const PREFIX = "kbw_"
const KB_COLLECTION = `${PREFIX}knowledge_base`
const MARKER_ID = (agentId: string) => `kb_last_auto_refresh:${agentId}`

let client: MongoClient
let db: Db

// Correction 3 (corrective-design.md §3 + corrective-design-r2.md
// Refinement A): explicit client-level bounds — 10s server selection and
// connect, and a 45s CSOT `timeoutMS` that propagates through the
// Db/Collection parent chain (`resolveOptions`) into EVERY operation this
// client runs, and — via the ClientSession constructor's
// `defaultTimeoutMS ?? client.s.options?.timeoutMS` inheritance — into the
// whole `withTransaction` callback expiry the product's fences run under
// (the product passes no transaction-level timeoutMS of its own). What no
// driver option bounds is a parked JS callback
// (node_modules/mongodb/src/sessions.ts:678-749: the retry deadline is
// checked only at retry boundaries) — exactly what the 30s latch
// watchdogs below bound instead.
//
// Same-step source clarification (HANDOFF, C3): client CSOT does NOT bound
// `client.close()`'s internal commands. `MongoClient._close`
// (mongo_client.ts:762-823) constructs `EndSessionsOperation` with no
// inherited operation options (operations/end_sessions.ts:22-24), so no
// timeout context — and therefore no CSOT deadline — applies to it. The
// shipped `socketTimeoutMS` bounds socket send/receive per command:
// connection.ts:461-465 falls back to the connection value when a legacy
// timeout context omits one, while CSOT contexts use their own deadlines
// (timeout.ts:342-343,402-403). `socketTimeoutMS: 45_000` is therefore the
// bounded socket FALLBACK for the close path (and any other legacy-context
// command), matching the 45s CSOT bound. Narrower guarantee, stated
// honestly: close is awaited and every underlying socket exchange is
// individually bounded at 45s, but the number of internal close commands
// is driver-chosen, so close's total wall time is bounded per socket
// operation, not by a single CSOT deadline.
// ---------------------------------------------------------------------------
// Honest full-sequential budgets (Correction 3 residual R1, HANDOFF)
// ---------------------------------------------------------------------------
//
// MECHANISM, verified in the installed runner's source: Vitest 4.1.10's
// per-test wrapper (`node_modules/@vitest/runner/dist/chunk-artifact.js`
// `withTimeout`, 2261-2319) rejects an OUTER wrapper promise on expiry
// and only attaches `.then(resolve, reject)` to the still-running body
// promise — it does NOT inject a TimeoutError into the body, does NOT
// run its finally, and `runTest` (same file, 2951-2985) proceeds toward
// afterEach/afterAll while the body may still be running. A wrapper
// timeout firing is therefore NEVER a cleanup mechanism here: if one
// fires, a bound was violated and the run is a failure — the finally
// would have been bypassed, not settled.
//
// The finally-before-teardown guarantee is instead established by
// arithmetic: every budget below is set ABOVE its body's full-sequential
// worst-case sum, counted in these units —
//   * 45s per awaited driver operation (client CSOT through the
//     Db/Collection parent chain) and per withTransaction attempt
//     sequence (the timeout context is created before the callback and
//     shared by every retry, so a whole fenced write, commit included,
//     is ≤ 45s);
//   * 30s per parked interval (the latch watchdogs — the ONLY bound on a
//     parked JS callback; the corrected LATCH_WATCHDOG_MS note explains
//     why no 45s CSOT context covers a park, and why no remaining-budget
//     arithmetic is claimed for a transaction context created before a
//     park);
//   * 10s per bootstrap selection/connect unit;
//   * local fs steps (mkdir/writeFile/rm) and in-process promise
//     plumbing have NO driver bound — the declared residual unbounded
//     class, persisted honestly: under a pathological local-fs hang a
//     wrapper would fire with that step still running. No invented bound
//     is claimed for them.
// Because budget > full-sequential worst case, each body always settles
// (including its never-throwing finally) inside its own wrapper window,
// and the wrapper resolves WITH the body; afterAll therefore starts only
// after every case body has settled — teardown cannot race a running
// case. These are deliberately high ceilings (most units complete in
// milliseconds): the budgets bound worst cases, not averages, and no
// "realistic average" shortcut is used anywhere.
//
// Source-counted worst cases (counting rule: one unit per sequential
// awaited driver step; concurrently started operations, e.g. the tracked
// ledger updateOne, are counted individually for safety). Product-side
// counts are grounded in the installed sources:
//   * `ensureCollections` (mongodb-schema-validators.ts): 1
//     listCollections + ≤29 createCollection + 2 diagnostic sinks (≤4
//     commands each) + 24 collMod ≈ 62 commands.
//   * `ensureStandardIndexes` (mongodb-schema-standard-indexes-{core,
//     graph,operations}.ts): ≤106 createIndex calls (28 + 30 + 48).
//   * A tenant erasure (`deleteAllForAgent`, mongodb-erasure.ts): 1
//     begin transaction + 2 sink listCollections + 1 relevance-runs find
//     + 1 artifact sweep find + ≤26 empty-collection finds + ≤4
//     non-empty sweeps (1 find + 1 fenced batch transaction + 1 find
//     each) + 30 verification counts + 1 finalize transaction ≈ 80
//     units.
//   * A KB auto-refresh (`maybeAutoRefreshKB` + `ingestToKB`, one file):
//     marker read + admission capture + ≤2 dedup reads + document-fence
//     transaction + cache-fence transaction + marker-fence transaction
//     ≈ 7 units (+ a parked interval where a case parks one).
//   * One `ingestDirect` call: capture + dedup + document-fence txn +
//     cache-fence txn ≈ 5 units.
//
// Per-hook/per-case ceilings and budgets (units × 45s + 30s per park,
// rounded up; these replace every prior 180s/240s claim):
//   beforeAll: connect (10s + 10s) + ~170 bootstrap commands → 7,660s
//     → 7,800,000ms.
//   N1: ~107 units + 1 park (seed/snapshot reads + 1 refresh + 1 erasure
//     + gate/sentinel + assertion/drain) → 4,845s → 5,400,000ms.
//   N3: ~118 units (two refreshes, one erasure) → 5,310s → 5,700,000ms.
//   N4: ~90 units (6 ingestDirect sequences across the Correction-4
//     fault cross-product + the clean retries + seed/snapshot/assertion/
//     drain units) → 4,050s → 4,500,000ms.
//   N5: ~150 units + 1 park (three refreshes, one erasure) → 6,780s →
//     7,200,000ms.
//   N6: ~50 units (three ingestDirect, no erasure, no park) → 2,250s →
//     2,700,000ms.
//   afterAll: ledger drain (≤2 units) + dropDatabase + listDatabases
//     absence check + awaited close (driver-internal command count
//     unknown — allowed 10 socket-bounded units) ≈ 14 units → 630s →
//     900,000ms.
const BEFORE_ALL_BUDGET_MS = 7_800_000
const AFTER_ALL_BUDGET_MS = 900_000
const N1_CASE_BUDGET_MS = 5_400_000
const N3_CASE_BUDGET_MS = 5_700_000
const N4_CASE_BUDGET_MS = 4_500_000
const N5_CASE_BUDGET_MS = 7_200_000
const N6_CASE_BUDGET_MS = 2_700_000

beforeAll(async () => {
	client = new MongoClient(TEST_URI, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
		timeoutMS: 45_000,
		socketTimeoutMS: 45_000,
	})
	await client.connect()
	db = client.db(DB_NAME)
	await ensureCollections(db, PREFIX)
	await ensureStandardIndexes(db, PREFIX)
}, BEFORE_ALL_BUDGET_MS)

afterAll(async () => {
	// Verified teardown (Correction 3, corrective-design.md §3): settle,
	// drop, prove absence, close — every failure retained and thrown
	// together, and the close ALWAYS attempted in an unconditional inner
	// finally with its awaited terminal evidence recorded (the vacuous
	// `toHaveProperty("close")` assertion is gone). Works under partial
	// bootstrap failure too: an undefined client/db is reported as a
	// teardown failure, never crashed on. Ordering guarantee (residual
	// R1): every case budget above is set above its body's
	// full-sequential worst-case sum, so each case body — including its
	// never-throwing finally, which releases and awaits its parked
	// attempt and drains its started ledger operations — settles before
	// its wrapper can expire, and this afterAll starts only after every
	// case body has settled. The drain below is the final settlement
	// guard (Correction 2), kept as defense in depth: it ensures no
	// started real ledger write ever races the fixture drop even if a
	// case somehow exited early.
	const teardownErrors: unknown[] = []
	let closeEvidence: "not-attempted" | "closed" | "failed" = "not-attempted"
	try {
		try {
			await drainLedgerOperations()
		} catch (error) {
			teardownErrors.push(error)
		}
		// Truthiness guards, not `!== undefined`: `db`/`client` are typed
		// non-optional (module-level lets), but under partial bootstrap
		// failure they can be unassigned at runtime — the guard covers
		// that without fighting the declared types.
		if (db) {
			try {
				await db.dropDatabase()
				const listed = await client
					.db("admin")
					.command({ listDatabases: 1, nameOnly: true })
				if (
					(listed.databases as Array<{ name: string }>).some(
						(entry) => entry.name === DB_NAME,
					)
				) {
					teardownErrors.push(
						new Error(
							`afterAll: fixture database ${DB_NAME} is still listed after dropDatabase`,
						),
					)
				}
			} catch (error) {
				teardownErrors.push(error)
			}
		} else {
			teardownErrors.push(
				new Error(
					"afterAll: fixture db was never established (bootstrap incomplete); drop and absence not verified",
				),
			)
		}
	} finally {
		// Unconditional awaited close with actual terminal evidence — runs
		// even when the drain/drop/absence steps above failed. Truthiness
		// guard for the same partial-bootstrap reason as `db` above.
		// Narrower guarantee (same-step C3 clarification): CSOT does not
		// reach the close path's internal `EndSessionsOperation` (it is
		// constructed with no inherited options), so what bounds it here
		// is the client-level `socketTimeoutMS: 45_000` socket fallback —
		// each underlying socket send/receive is individually bounded, the
		// close itself is awaited to its actual terminal state, and no
		// single CSOT deadline covers the whole close.
		if (client) {
			try {
				await client.close()
				closeEvidence = "closed"
			} catch (error) {
				closeEvidence = "failed"
				teardownErrors.push(error)
			}
		}
	}
	if (closeEvidence !== "closed") {
		teardownErrors.push(
			new Error(
				`afterAll: client close not confirmed (evidence: ${closeEvidence})`,
			),
		)
	}
	if (teardownErrors.length > 0) {
		throw new AggregateError(
			teardownErrors,
			"kb-admission-fence afterAll teardown failures (drain/drop/absence/close)",
		)
	}
}, AFTER_ALL_BUDGET_MS)

// ---------------------------------------------------------------------------
// Manager facade: real prototype methods over the real (or wrapped) db
// ---------------------------------------------------------------------------

captureManagerPrototype(MongoDBMemoryManager)

function tenantManager(
	agentId: string,
	managerDb: Db,
	workspaceDir: string,
): MongoDBMemoryManager {
	return buildMockManager({
		client,
		db: managerDb,
		prefix: PREFIX,
		agentId,
		agentScopeRef: `agent:${agentId}`,
		workspaceScopeRef: `workspace:${agentId}`,
		workspaceDir,
		config: kitMongoConfig({
			kb: {
				enabled: true,
				autoRefreshHours: 24,
				autoImportPaths: [workspaceDir],
				chunking: { tokens: 512, overlap: 64 },
			},
		}),
		closed: false,
		writeQueue: Promise.resolve(),
		writeQueueDepth: 0,
		memoryJobWorkerStopped: true,
		memoryJobOperationContexts: new Map(),
		startMemoryJobWorker: () => {},
		wakeMemoryJobWorker: () => {},
		schedulePostWriteDerivations: async () => {},
		scheduleQueryCacheInvalidation: () => {},
	})
}

/** The real private KB auto-refresh entry (mongodb-manager-sync.ts). */
function kbAutoRefresh(manager: MongoDBMemoryManager): Promise<void> {
	return (
		manager as unknown as {
			maybeAutoRefreshKB: () => Promise<void>
		}
	).maybeAutoRefreshKB()
}

// ---------------------------------------------------------------------------
// Settlement capture (nonrejecting) — no outcome left pending, ever
// ---------------------------------------------------------------------------

type AttemptOutcome =
	| { settled: "resolved" }
	| { settled: "rejected"; error: unknown }

function captureOutcome(promise: Promise<unknown>): Promise<AttemptOutcome> {
	return promise.then(
		() => ({ settled: "resolved" as const }),
		(error: unknown) => ({ settled: "rejected" as const, error }),
	)
}

// ---------------------------------------------------------------------------
// Failure-preserving case reporting (Correction 3, corrective-design.md §3)
// ---------------------------------------------------------------------------

/**
 * Reports a case's primary, watchdog-expiry, and cleanup failures without
 * masking: failures → AggregateError([primary, watchdogExpiry, ...cleanup],
 * cleanup in order); a single failure of any kind → that error itself,
 * unchanged — an intended OLD-byte RED stays the case's own first
 * assertion failure, and a cleanup failure on its own is still a hard
 * failure, never swallowed. Same-step C3 clarification: watchdog expiry is
 * recorded SEPARATELY from the test's explicit latch release and is its
 * own failure category — a self-released latch must never silently count
 * as proof the intended test-controlled parked schedule occurred.
 * Accepted idiom from the T-R2 precedent
 * (mongodb-projection-repair.e2e.test.ts, AggregateError reporting).
 */
function reportCaseFailures(
	caseLabel: string,
	primaryFailed: boolean,
	primaryError: unknown,
	cleanupErrors: unknown[],
	watchdogExpiry?: unknown,
): void {
	if (
		!primaryFailed &&
		cleanupErrors.length === 0 &&
		watchdogExpiry === undefined
	) {
		return
	}
	const all = [
		...(primaryFailed ? [primaryError] : []),
		...(watchdogExpiry !== undefined ? [watchdogExpiry] : []),
		...cleanupErrors,
	]
	if (all.length === 1) {
		throw all[0]
	}
	throw new AggregateError(
		all,
		`${caseLabel}: primary and/or watchdog-expiry and/or cleanup failures (primary first, then watchdog expiry, then cleanup in order)`,
	)
}

// ---------------------------------------------------------------------------
// Real-operation ledger settlement (Correction 2, corrective-design.md §2)
// ---------------------------------------------------------------------------

const LEDGER_COLLECTION_NAME = `${PREFIX}memory_cost_ledger`

/**
 * File-local live set of every real ledger `updateOne` STARTED through a
 * tracked boundary db. Entries are recorded at start and removed only by a
 * drain; each drain clears the whole set, so an earlier attempt's
 * operations can never contaminate a later attempt's counts.
 */
const liveLedgerOperations = new Set<Promise<unknown>>()

/**
 * Wraps `db` so the `${PREFIX}memory_cost_ledger` collection's `updateOne`
 * records the EXACT promise the real collection method call returns — the
 * delegated method is bound to the collection it was read from, arguments
 * (including any explicit session option) pass through unchanged — and
 * returns that SAME promise object, so the product's own `.catch` chain
 * (mongodb-cost-ledger.ts:81-111) stays attached to the real delegated
 * operation. No fake write, no delay. Only the ledger collection is
 * wrapped; every other collection and method passes through untouched.
 * Compose OUTSIDE the latch/fault wrappers at every manager/ingest
 * boundary — each wrapper overrides only `collection`, so nesting composes
 * (this wrapper's `collection` call flows through the inner wrapper
 * first). Seeding, erasure and all assertions use the unwrapped real db
 * and are never recorded.
 */
function trackLedgerOperations(base: Db): Db {
	return new Proxy(base, {
		get(target, property) {
			if (property === "collection") {
				return (name: string, options?: CollectionOptions) => {
					const collection = target.collection(name, options)
					if (name !== LEDGER_COLLECTION_NAME) {
						return collection
					}
					return new Proxy(collection, {
						get(target, property) {
							if (property === "updateOne") {
								return (...args: unknown[]) => {
									const updateOne = (
										target.updateOne as (...rest: unknown[]) => Promise<unknown>
									).bind(target)
									const operation = updateOne(...args)
									liveLedgerOperations.add(operation)
									return operation
								}
							}
							const value = Reflect.get(target, property, target)
							return typeof value === "function" ? value.bind(target) : value
						},
					})
				}
			}
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

/**
 * ACTUAL terminal-state settlement of every started real ledger operation:
 * snapshots the live tracked set, clears it, and awaits `Promise.allSettled`
 * over it — never a quiet data interval. Each drain counts only operations
 * started since the previous drain (per-attempt isolation). Called after
 * attempt settlement, on early-failure paths in each case's finally, and in
 * afterAll before the fixture drop.
 */
async function drainLedgerOperations(): Promise<{
	drained: number
	rejected: number
}> {
	const started = [...liveLedgerOperations]
	liveLedgerOperations.clear()
	const settled = await Promise.allSettled(started)
	return {
		drained: settled.length,
		rejected: settled.filter((outcome) => outcome.status === "rejected").length,
	}
}

// ---------------------------------------------------------------------------
// Seed helpers (validator-satisfying production shapes)
// ---------------------------------------------------------------------------

async function seedKBDoc(params: {
	agentId: string
	path: string
	content: string
	chunksComplete: boolean
}): Promise<string> {
	const docId = randomUUID()
	const now = new Date()
	await kbCollection(db, PREFIX).insertOne({
		_id: docId,
		agentId: params.agentId,
		scope: "agent",
		scopeRef: `agent:${params.agentId}`,
		title: "Seeded control document",
		content: params.content,
		hash: hashText(params.content),
		source: {
			type: "file",
			path: params.path,
			mimeType: "text/markdown",
			originalName: params.path.split("/").pop() ?? params.path,
			importedBy: "agent",
			importedAt: now,
		},
		tags: [],
		chunkCount: params.chunksComplete ? 1 : 0,
		chunkScheme: CHUNK_SCHEME_VERSION,
		chunksComplete: params.chunksComplete,
		updatedAt: now,
	} as Record<string, unknown>)
	return docId
}

async function seedMarker(agentId: string, at: Date): Promise<void> {
	// String-_id meta writes use the package cast idiom (manager-sync writes
	// the marker through the same accessor with Record<string, unknown>).
	await metaCollection(db, PREFIX).insertOne({
		_id: MARKER_ID(agentId),
		timestamp: at,
	} as Record<string, unknown>)
}

async function seedCacheRow(params: {
	agentId: string
	scopeRef: string
	key: string
}): Promise<void> {
	const now = new Date()
	await queryCacheCollection(db, PREFIX).insertOne({
		_id: randomUUID(),
		agentId: params.agentId,
		scope: "agent",
		scopeRef: params.scopeRef,
		queryHash: randomUUID(),
		queryNorm: `norm-${params.key}`,
		results: [],
		pathUsed: "auto",
		sourceScope: "agent",
		createdAt: now,
		expiresAt: new Date(now.getTime() + 600_000),
		hitCount: 0,
		lastHitAt: now,
	} as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// N1 latch: park the source-path dedup read post-read, pre-return
// ---------------------------------------------------------------------------

/**
 * Correction 3 (corrective-design.md §3 + corrective-design-r2.md
 * Refinement A), corrected per residual R2 (HANDOFF): the self-releasing
 * latch deadline. Its guarantee is exactly this: the parked interval
 * itself is bounded at 30s. It guarantees NO particular remaining
 * operation/transaction budget — MongoDB 7.6.0 sessions.ts:729-745
 * creates a transaction's timeout context and fixes its deadline BEFORE
 * invoking the callback, while this watchdog arms only AFTER the parked
 * read resolves, so elapsed pre-park time counts against that deadline;
 * "30s < 45s therefore ≥ 15s remain" is FALSE arithmetic and is claimed
 * nowhere. If a surrounding transaction's CSOT deadline expires after
 * release, that transaction fails closed on its own deadline (abort) and
 * the attempt settles through the same captured-outcome path — bounded,
 * never a hang. For a park outside every transaction (the N1 park), all
 * post-release work runs under FRESH per-operation/per-transaction 45s
 * contexts. The driver bounds operations and transactions; ONLY this
 * watchdog bounds the parked JS interval — `withTransaction`'s
 * retry/CSOT deadline is checked only at retry boundaries and never
 * interrupts a parked callback (node_modules/mongodb/src/sessions.ts:
 * 678-749). A fired watchdog still FAILS the case (recorded separately
 * from the case's own release) — it is a bound violation, never a silent
 * self-release.
 */
const LATCH_WATCHDOG_MS = 30_000

/**
 * Wraps `db` so the FIRST `findOne` on the knowledge_base collection whose
 * filter carries a `"source.path"` key — the ingest's source-path dedup read
 * (`kb.findOne({"source.path": sourcePath, scopeRef})`, issued OUTSIDE every
 * transaction before any admission work) — parks AFTER the underlying read
 * resolves and BEFORE the result returns to ingest. The same read exists on
 * OLD and NEW bytes (the unfenced branch follows it identically), so the
 * park point is byte-set-neutral. No transaction is open while parked.
 * `readCompleted` resolves once the real read has finished; `release()`
 * un-parks, is idempotent, and must be called in a finally. Correction 3:
 * a self-releasing `LATCH_WATCHDOG_MS` watchdog arms when the park engages
 * and opens the gate itself on deadline if the case's own release has not
 * happened first; `watchdogFired()` reports whether the deadline, not the
 * case, did the releasing.
 */
function parkSourcePathDedupRead(base: Db): {
	db: Db
	readCompleted: Promise<void>
	release: () => void
	watchdogFired: () => boolean
} {
	let openGate: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		openGate = resolve
	})
	let markReadCompleted: (() => void) | undefined
	const readCompleted = new Promise<void>((resolve) => {
		markReadCompleted = resolve
	})
	let parkedOnce = false
	// Correction 3: self-releasing latch watchdog state.
	let watchdogTimer: ReturnType<typeof setTimeout> | undefined
	let watchdogDidFire = false
	const clearWatchdog = () => {
		if (watchdogTimer !== undefined) {
			clearTimeout(watchdogTimer)
			watchdogTimer = undefined
		}
	}
	const wrapped = new Proxy(base, {
		get(target, property) {
			if (property === "collection") {
				return (name: string, options?: CollectionOptions) => {
					const collection = target.collection(name, options)
					if (name !== KB_COLLECTION || parkedOnce) {
						return collection
					}
					return new Proxy(collection, {
						get(target, property) {
							if (property === "findOne") {
								return async (...args: unknown[]) => {
									const filter = args[0] as
										| Record<string, unknown>
										| undefined
										| null
									if (
										parkedOnce ||
										filter === undefined ||
										filter === null ||
										!("source.path" in filter)
									) {
										return await (
											target.findOne as (...rest: unknown[]) => Promise<unknown>
										)(...args)
									}
									parkedOnce = true
									const result = await (
										target.findOne as (...rest: unknown[]) => Promise<unknown>
									)(...args)
									markReadCompleted?.()
									// Correction 3: arm the self-releasing
									// watchdog — it bounds THIS parked
									// interval at 30s (residual R2, HANDOFF:
									// it guarantees no particular remaining
									// operation/transaction budget for a
									// transaction context created before the
									// park; see the corrected
									// LATCH_WATCHDOG_MS note). A fired
									// watchdog FAILS the case. Never holds
									// the process open by itself.
									watchdogTimer = setTimeout(() => {
										watchdogDidFire = true
										openGate?.()
									}, LATCH_WATCHDOG_MS)
									watchdogTimer.unref?.()
									await gate
									clearWatchdog()
									return result
								}
							}
							const value = Reflect.get(target, property, target)
							return typeof value === "function" ? value.bind(target) : value
						},
					})
				}
			}
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
	return {
		db: wrapped,
		readCompleted,
		release: () => {
			clearWatchdog()
			openGate?.()
		},
		watchdogFired: () => watchdogDidFire,
	}
}

// ---------------------------------------------------------------------------
// Fault injection: one-shot RAW error on a matching (collection, method)
// ---------------------------------------------------------------------------

/**
 * Wraps `db` so the FIRST call to `method` on `collection` throws a plain
 * labeled error; every later call (and every other collection/method)
 * passes through untouched. Raw throw semantics matter: inside a fence the
 * error aborts the real transaction (rollback), and outside it degrades to
 * the production best-effort path. N4/N5 faults only — never a fake write.
 */
function faultInjectingDb(
	base: Db,
	fault: { collection: string; method: string; label: string },
): Db {
	let armed = true
	return new Proxy(base, {
		get(target, property) {
			if (property === "collection") {
				return (name: string, options?: CollectionOptions) => {
					const collection = target.collection(name, options)
					if (name !== fault.collection) {
						return collection
					}
					return new Proxy(collection, {
						get(target, property) {
							if (property === fault.method && armed) {
								return async (..._args: unknown[]) => {
									armed = false
									throw new Error(`injected native-e2e fault: ${fault.label}`)
								}
							}
							const value = Reflect.get(target, property, target)
							return typeof value === "function" ? value.bind(target) : value
						},
					})
				}
			}
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

// ---------------------------------------------------------------------------
// N5(iii) latch: park the cache-fence gate read post-read, pre-return
// ---------------------------------------------------------------------------

const GATE_ID = (agentId: string) => `tenant-erasure-epoch:${agentId}`

/**
 * Wraps `db` so the `occurrence`-th `findOne` on the meta collection whose
 * filter `_id` equals the tenant's erasure-gate doc id — with one imported
 * document the refresh attempt issues exactly two such reads through this
 * db: the document fence's (1st) and the cache fence's (2nd; the marker read
 * has a different _id and the admission capture is a findOneAndUpdate, so
 * both pass through) — parks AFTER the underlying read resolves and BEFORE
 * the snapshot returns to the fence. The parked fence transaction has
 * performed no writes yet, so it holds no locks while parked.
 * `readCompleted` resolves once the real read has finished; `release()`
 * un-parks, is idempotent, and must be called in a finally. Correction 3
 * (corrective-design.md §3): a self-releasing `LATCH_WATCHDOG_MS` watchdog
 * arms when the park engages and opens the gate itself on deadline if the
 * case's own release has not happened first; `watchdogFired()` reports
 * whether the deadline, not the case, did the releasing.
 */
function parkGateReadAt(
	base: Db,
	agentId: string,
	occurrence: number,
): {
	db: Db
	readCompleted: Promise<void>
	release: () => void
	watchdogFired: () => boolean
} {
	let openGate: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		openGate = resolve
	})
	let markReadCompleted: (() => void) | undefined
	const readCompleted = new Promise<void>((resolve) => {
		markReadCompleted = resolve
	})
	let gateReads = 0
	// Correction 3: self-releasing latch watchdog state.
	let watchdogTimer: ReturnType<typeof setTimeout> | undefined
	let watchdogDidFire = false
	const clearWatchdog = () => {
		if (watchdogTimer !== undefined) {
			clearTimeout(watchdogTimer)
			watchdogTimer = undefined
		}
	}
	const wrapped = new Proxy(base, {
		get(target, property) {
			if (property === "collection") {
				return (name: string, options?: CollectionOptions) => {
					const collection = target.collection(name, options)
					if (name !== `${PREFIX}meta`) {
						return collection
					}
					return new Proxy(collection, {
						get(target, property) {
							if (property === "findOne") {
								return async (...args: unknown[]) => {
									// Correction 1 (corrective-design.md §1):
									// the receiver is BOUND to the real
									// collection — the previous revision
									// extracted `findOne` unbound (a detached
									// method call).
									const findOne = (
										target.findOne as (...rest: unknown[]) => Promise<unknown>
									).bind(target)
									const filter = args[0] as
										| Record<string, unknown>
										| undefined
										| null
									const isGateRead =
										filter !== undefined &&
										filter !== null &&
										filter._id === GATE_ID(agentId)
									// Correction 1 (corrective-design.md §1):
									// ONLY gate-id reads consume an
									// occurrence (readErasureGate is exactly
									// `metaCollection(db, prefix).findOne(
									// gateIdFilter(agentId))`; the marker read
									// has a different _id and the admission
									// capture is a findOneAndUpdate). The
									// previous always-increment counter let a
									// marker read BE the parked "2nd gate
									// read".
									if (!isGateRead) {
										return await findOne(...args)
									}
									gateReads++
									if (gateReads !== occurrence) {
										return await findOne(...args)
									}
									const result = await findOne(...args)
									markReadCompleted?.()
									// Correction 3: arm the self-releasing
									// watchdog — it bounds THIS parked
									// interval at 30s (residual R2, HANDOFF:
									// it guarantees no particular remaining
									// operation/transaction budget for a
									// transaction context created before the
									// park; see the corrected
									// LATCH_WATCHDOG_MS note). A fired
									// watchdog FAILS the case. Never holds
									// the process open by itself.
									watchdogTimer = setTimeout(() => {
										watchdogDidFire = true
										openGate?.()
									}, LATCH_WATCHDOG_MS)
									watchdogTimer.unref?.()
									await gate
									clearWatchdog()
									return result
								}
							}
							const value = Reflect.get(target, property, target)
							return typeof value === "function" ? value.bind(target) : value
						},
					})
				}
			}
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
	return {
		db: wrapped,
		readCompleted,
		release: () => {
			clearWatchdog()
			openGate?.()
		},
		watchdogFired: () => watchdogDidFire,
	}
}

// ---------------------------------------------------------------------------
// Direct-ingest helpers (N4/N6 boundary — no manager, no marker claim)
// ---------------------------------------------------------------------------

function fileDoc(path: string, content: string): KBDocument {
	const name = path.split("/").pop() ?? path
	return {
		title: name,
		content,
		source: {
			type: "file",
			path,
			mimeType: "text/markdown",
			originalName: name,
			importedBy: "agent",
		},
		tags: [],
		hash: hashText(content),
	}
}

async function ingestDirect(
	ingestDb: Db,
	agentId: string,
	documents: KBDocument[],
): Promise<KBIngestResult> {
	// Fresh admission capture for every direct-ingest call (the boundary
	// under test claims its own token; the manager marker is never involved).
	const admission = await captureAdmissionToken({
		db,
		prefix: PREFIX,
		agentId,
	})
	return await ingestToKB({
		db: ingestDb,
		prefix: PREFIX,
		scope: { agentId, scope: "agent" },
		documents,
		embeddingMode: "automated",
		chunking: { tokens: 512, overlap: 64 },
		client,
		admission,
	})
}

async function seedChunkRow(params: {
	docId: string
	agentId: string
	scopeRef: string
	path: string
	text: string
	startLine: number
	endLine: number
	ordinal: number
}): Promise<void> {
	await kbChunksCollection(db, PREFIX).insertOne({
		docId: params.docId,
		agentId: params.agentId,
		scope: "agent",
		scopeRef: params.scopeRef,
		path: params.path,
		source: "kb",
		text: params.text,
		hash: hashText(params.text),
		startLine: params.startLine,
		endLine: params.endLine,
		ordinal: params.ordinal,
		updatedAt: new Date(),
	} as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// N1 — stale admission across a completed erasure must not resurrect the KB
// ---------------------------------------------------------------------------

describe("kb admission fence (native e2e, plan e5ec10dc §7)", () => {
	it(
		"N1: a KB auto-refresh attempt parked at the source-path dedup read must not resurrect a tenant erased while it was parked",
		async () => {
			const agentA = `kbw-n1-a-${randomUUID()}`
			const agentB = `kbw-n1-b-${randomUUID()}`
			const workspaceDir = join(tmpdir(), `memongo-kb-admission-n1-${RUN_UUID}`)
			const alphaPath = join(workspaceDir, "alpha.md")
			const alphaContent = "Native admission fence N1 alpha line."

			// Tenant-B controls: marker, one complete KB document, one cache
			// row — byte snapshots taken now and re-verified after the run.
			const bPath = `kbw-n1-b-${randomUUID()}.md`
			await seedMarker(agentB, new Date(Date.now() - 3_600_000))
			await seedKBDoc({
				agentId: agentB,
				path: bPath,
				content: "Tenant B control document line.",
				chunksComplete: true,
			})
			const bCacheKey = `n1-b-${randomUUID()}`
			await seedCacheRow({
				agentId: agentB,
				scopeRef: `agent:${agentB}`,
				key: bCacheKey,
			})
			const bMarkerBefore = await metaCollection(db, PREFIX).findOne({
				_id: MARKER_ID(agentB),
			} as Record<string, unknown>)
			const bDocBefore = await kbCollection(db, PREFIX).findOne({
				agentId: agentB,
			})
			const bCacheBefore = await queryCacheCollection(db, PREFIX).findOne({
				agentId: agentB,
			})

			// Correction 3 (corrective-design.md §3): failure-preserving case
			// frame — the primary error is captured, never rethrown from the
			// body; every cleanup step runs in a never-throwing finally and
			// retains its own failures; both are reported together at the end.
			let primaryFailed = false
			let primaryError: unknown
			const cleanupErrors: unknown[] = []
			let watchdogExpiry: unknown
			let parkedDedup: ReturnType<typeof parkSourcePathDedupRead> | undefined
			let refreshOutcome: Promise<AttemptOutcome> | undefined
			try {
				// A's workspace with one fresh markdown file: the refresh's
				// source-path dedup read for it resolves null (fresh import
				// path).
				await mkdir(workspaceDir, { recursive: true })
				await writeFile(alphaPath, `${alphaContent}\n`, "utf-8")

				const latch = parkSourcePathDedupRead(db)
				parkedDedup = latch
				const refreshPromise = kbAutoRefresh(
					tenantManager(agentA, trackLedgerOperations(latch.db), workspaceDir),
				)
				const outcome = captureOutcome(refreshPromise)
				refreshOutcome = outcome

				// Observe the parked attempt immediately. If the attempt
				// settles without ever reaching the dedup read, the case fails
				// on an explicit precondition (honest on either byte set —
				// never a hang, never a silent pass).
				const firstSignal = await Promise.race([
					latch.readCompleted.then(() => "parked" as const),
					outcome.then(() => "settled-first" as const),
				])
				expect(firstSignal).toBe("parked")

				// The attempt holds its admission token (captured before the
				// ingest) and is parked before any KB write. The REAL public
				// erasure of A runs to a complete receipt on the real db.
				const eraseReceipt = await tenantManager(
					agentA,
					db,
					workspaceDir,
				).deleteAllForAgent()
				expect(eraseReceipt).toMatchObject({
					agentId: agentA,
					status: "complete",
				})
				expect(typeof eraseReceipt.epoch).toBe("number")
				expect(eraseReceipt.epoch).toBeGreaterThan(0)

				// The gate persists open at the advanced epoch — the token the
				// parked attempt holds is now stale by construction.
				const gateAfterErase = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agentA,
				})
				expect(gateAfterErase).toMatchObject({
					state: "open",
					epoch: eraseReceipt.epoch,
				})
				expect(
					(gateAfterErase as Record<string, unknown> | null)?.erase,
				).toBeUndefined()

				// New-lifecycle A cache sentinel, seeded AFTER the erasure and
				// BEFORE the release: the namespace the refresh's cache-tail
				// fence would invalidate ({agentId, scope: "agent",
				// scopeRef: agent:A}). Its survival proves the attempt never
				// completed its cache fence.
				const aSentinelKey = `n1-sentinel-${randomUUID()}`
				await seedCacheRow({
					agentId: agentA,
					scopeRef: `agent:${agentA}`,
					key: aSentinelKey,
				})

				// Release + settle INSIDE the try so the displaced attempt's
				// outcome is fully observed before the first assertion runs;
				// the finally repeats both unconditionally (idempotent).
				latch.release()
				const settledOutcome = await outcome

				// ---- Same assertion set on OLD and NEW bytes ----
				// OLD REDs HERE FIRST: the unfenced branch commits A's parent.
				expect(
					await kbCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// Residual C3 (HANDOFF): the displaced attempt's own terminal
				// discriminant, asserted AFTER the unchanged first
				// resurrection oracle above so OLD's first required RED stays
				// first. Expected on both byte sets: the manager degrades an
				// admission abort/conflict to a warn-and-return
				// (mongodb-manager-sync.ts maybeAutoRefreshKB catch), so the
				// attempt resolves — an unexpected rejection fails here.
				expect(settledOutcome.settled).toBe("resolved")
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// Correction 2 (corrective-design.md §2): real-operation
				// settlement AFTER the resurrection assertions. NEW bytes: the
				// admission branch aborted before starting ANY billing
				// operation (drained === 0, nothing rejected). OLD bytes never
				// reach this line — the parent-count assertion above already
				// REDed; the finally's drain settles the real fire-and-forget
				// resurrection bill there instead.
				const ledgerSettlement = await drainLedgerOperations()
				expect(ledgerSettlement.drained).toBe(0)
				expect(ledgerSettlement.rejected).toBe(0)
				expect(
					await costLedgerCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).toBeNull()
				// Post-erasure sentinel survives: the attempt never reached
				// its cache fence.
				expect(
					await queryCacheCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(1)
				// Tenant-B controls byte-identical.
				const bMarkerAfter = await metaCollection(db, PREFIX).findOne({
					_id: MARKER_ID(agentB),
				} as Record<string, unknown>)
				expect(bMarkerAfter).toEqual(bMarkerBefore)
				const bDocAfter = await kbCollection(db, PREFIX).findOne({
					agentId: agentB,
				})
				expect(bDocAfter).toEqual(bDocBefore)
				const bCacheAfter = await queryCacheCollection(db, PREFIX).findOne({
					agentId: agentB,
				})
				expect(bCacheAfter).toEqual(bCacheBefore)
				// Gate open at the receipt epoch after the displaced attempt
				// settled, and the proof-of-erasure audit row is durable.
				const gateAfterAttempt = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agentA,
				})
				expect(gateAfterAttempt).toMatchObject({
					state: "open",
					epoch: eraseReceipt.epoch,
				})
				expect(
					await mutationsCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBeGreaterThan(0)
			} catch (error) {
				// Failure-preserving (Correction 3): the primary error is
				// captured, never rethrown from here — the finally below always
				// runs its full cleanup sequence first.
				primaryFailed = true
				primaryError = error
			} finally {
				// Never-throwing cleanup (Correction 3): unconditional release +
				// awaited actual settlement + the Correction-2 early-failure
				// drain + latch-watchdog expiry recording + workspace removal,
				// on either byte set, whether the case body passed or failed
				// above. On OLD bytes the drain settles exactly the
				// fire-and-forget resurrection bill the already-failed
				// resurrection assertion left in flight. Every cleanup failure
				// is retained — nothing masks the primary error, and this
				// finally itself never throws. Same-step C3 clarification:
				// watchdog expiry is recorded SEPARATELY from the case's own
				// explicit release and FAILS the case via reportCaseFailures —
				// a self-released latch must never silently count as the
				// intended parked schedule.
				try {
					parkedDedup?.release()
					if (refreshOutcome !== undefined) {
						// Residual C3 (HANDOFF): an unexpected rejection of the
						// attempt on an early-failure path is RETAINED as a
						// cleanup failure — never swallowed by a bare await.
						const settled = await refreshOutcome
						if (settled.settled === "rejected") {
							cleanupErrors.push(settled.error)
						}
					}
					await drainLedgerOperations()
					if (parkedDedup?.watchdogFired()) {
						watchdogExpiry = new Error(
							"N1: the dedup-read latch watchdog fired — the park outlived its 30s deadline before the case's own release",
						)
					}
					await rm(workspaceDir, { recursive: true, force: true })
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError)
				}
			}
			reportCaseFailures(
				"N1",
				primaryFailed,
				primaryError,
				cleanupErrors,
				watchdogExpiry,
			)
		},
		N1_CASE_BUDGET_MS,
	)

	it(
		"N3: a completed erasure must not block a later fresh admission — the next refresh re-imports with a new token",
		async () => {
			const agentA = `kbw-n3-a-${randomUUID()}`
			const agentB = `kbw-n3-b-${randomUUID()}`
			const workspaceDir = join(tmpdir(), `memongo-kb-admission-n3-${RUN_UUID}`)
			const alphaPath = join(workspaceDir, "alpha.md")
			const alphaContent = "Native admission fence N3 alpha line."
			// Correction 3 (corrective-design.md §3): failure-preserving case
			// frame — primary error captured, never-throwing finally, both
			// reported together at the end.
			let primaryFailed = false
			let primaryError: unknown
			const cleanupErrors: unknown[] = []
			try {
				// Tenant-B controls: one KB parent + refresh marker, snapshotted.
				await seedKBDoc({
					agentId: agentB,
					path: "n3-b.md",
					content: "Tenant B control document line.",
					chunksComplete: true,
				})
				await seedMarker(agentB, new Date())
				const bMarkerBefore = await metaCollection(db, PREFIX).findOne({
					_id: MARKER_ID(agentB),
				} as Record<string, unknown>)
				const bDocBefore = await kbCollection(db, PREFIX).findOne({
					agentId: agentB,
				})

				// (1) First refresh: fresh import of alpha.md — acknowledged work.
				await mkdir(workspaceDir, { recursive: true })
				await writeFile(alphaPath, `${alphaContent}\n`, "utf-8")
				const firstRefresh = captureOutcome(
					kbAutoRefresh(
						tenantManager(agentA, trackLedgerOperations(db), workspaceDir),
					),
				)
				expect((await firstRefresh).settled).toBe("resolved")
				// Correction 2: actual settlement of the started real billing
				// operations (OLD fire-and-forget or NEW in-session alike), then
				// assert the real row.
				const firstSettlement = await drainLedgerOperations()
				expect(firstSettlement.drained).toBeGreaterThanOrEqual(1)
				expect(firstSettlement.rejected).toBe(0)
				const aDocFirst = await kbCollection(db, PREFIX).findOne({
					agentId: agentA,
				})
				expect(aDocFirst).not.toBeNull()
				expect(aDocFirst?.chunksComplete).toBe(true)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBeGreaterThan(0)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).not.toBeNull()
				const aLedgerFirst = await costLedgerCollection(db, PREFIX).findOne({
					agentId: agentA,
					day: costLedgerDay(),
					kind: "indexing",
				})
				expect(Number(aLedgerFirst?.embedUnits ?? 0)).toBeGreaterThan(0)

				// (2) REAL public erasure of A: complete receipt, epoch advanced.
				const eraseReceipt = await tenantManager(
					agentA,
					db,
					workspaceDir,
				).deleteAllForAgent()
				expect(eraseReceipt).toMatchObject({
					agentId: agentA,
					status: "complete",
				})
				expect(eraseReceipt.epoch).toBeGreaterThan(0)
				expect(
					await kbCollection(db, PREFIX).countDocuments({ agentId: agentA }),
				).toBe(0)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await costLedgerCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).toBeNull()

				// (3) New-lifecycle cache sentinel: the namespace the NEXT
				// refresh's cache-tail fence must invalidate.
				await seedCacheRow({
					agentId: agentA,
					scopeRef: `agent:${agentA}`,
					key: `n3-sentinel-${randomUUID()}`,
				})

				// (4) Second refresh AFTER the erasure: the marker was erased,
				// so the refresh runs again; its admission capture observes the
				// advanced gate open-state and claims fresh work.
				const secondRefresh = captureOutcome(
					kbAutoRefresh(
						tenantManager(agentA, trackLedgerOperations(db), workspaceDir),
					),
				)
				expect((await secondRefresh).settled).toBe("resolved")
				// Correction 2: this attempt's own settlement — the first
				// refresh's operations were already drained and cleared above.
				const secondSettlement = await drainLedgerOperations()
				expect(secondSettlement.drained).toBeGreaterThanOrEqual(1)
				expect(secondSettlement.rejected).toBe(0)
				const aDocSecond = await kbCollection(db, PREFIX).findOne({
					agentId: agentA,
				})
				expect(aDocSecond).not.toBeNull()
				expect(aDocSecond?.chunksComplete).toBe(true)
				expect(aDocSecond?.hash).toBe(hashText(`${alphaContent}\n`))
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBeGreaterThan(0)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).not.toBeNull()
				// The sentinel the new admission's cache fence invalidated.
				expect(
					await queryCacheCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// Gate still open at the erasure epoch (refreshes never move it).
				const gateAfter = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agentA,
				})
				expect(gateAfter).toMatchObject({
					state: "open",
					epoch: eraseReceipt.epoch,
				})
				// Tenant-B controls untouched by both the erasure and both
				// refreshes.
				const bMarkerAfter = await metaCollection(db, PREFIX).findOne({
					_id: MARKER_ID(agentB),
				} as Record<string, unknown>)
				expect(bMarkerAfter).toEqual(bMarkerBefore)
				const bDocAfter = await kbCollection(db, PREFIX).findOne({
					agentId: agentB,
				})
				expect(bDocAfter).toEqual(bDocBefore)
			} catch (error) {
				// Failure-preserving (Correction 3): captured, never rethrown —
				// the finally runs its full cleanup sequence first.
				primaryFailed = true
				primaryError = error
			} finally {
				// Never-throwing cleanup (Correction 3): the Correction-2
				// early-failure ledger settlement (nothing started by an
				// interrupted attempt races the teardown) + workspace removal;
				// every cleanup failure is retained, this finally never throws.
				try {
					await drainLedgerOperations()
					await rm(workspaceDir, { recursive: true, force: true })
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError)
				}
			}
			reportCaseFailures("N3", primaryFailed, primaryError, cleanupErrors)
		},
		N3_CASE_BUDGET_MS,
	)

	it(
		"N4: direct ingest — the Correction-4 fault cross-product (fresh/replacement × chunk/ledger) rolls back the whole fenced write, and the clean retries succeed fully",
		async () => {
			const agentA = `kbw-n4-a-${randomUUID()}`
			const workspaceDir = join(tmpdir(), `memongo-kb-admission-n4-${RUN_UUID}`)
			const alphaPath = "n4-alpha.md"
			const c1Content = "Native admission fence N4 first content line."
			const c2Content = "Native admission fence N4 changed content line."
			// Correction 3 (corrective-design.md §3): failure-preserving case
			// frame — primary error captured, never-throwing finally, both
			// reported together at the end.
			let primaryFailed = false
			let primaryError: unknown
			const cleanupErrors: unknown[] = []
			try {
				// (i) Chunk-bulk fault on a FRESH import: the raw error aborts
				// the real document-fence transaction — parent, chunks, and
				// in-session ledger all roll back together.
				const faultDb = faultInjectingDb(db, {
					collection: `${PREFIX}knowledge_base_chunks`,
					method: "bulkWrite",
					label: "N4(i) chunk bulk write",
				})
				const faulted = await ingestDirect(
					trackLedgerOperations(faultDb),
					agentA,
					[fileDoc(alphaPath, c1Content)],
				)
				expect(faulted.documentsProcessed).toBe(0)
				expect(faulted.chunksCreated).toBe(0)
				expect(faulted.skipped).toBe(0)
				expect(faulted.errors).toHaveLength(1)
				expect(
					await kbCollection(db, PREFIX).countDocuments({ agentId: agentA }),
				).toBe(0)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// Correction 2: the fault aborted the fence BEFORE the in-session
				// ledger write, so no billing operation was ever started (the
				// fault itself was a bulkWrite, never recorded as a ledger op).
				const settlementAfterFault = await drainLedgerOperations()
				expect(settlementAfterFault.drained).toBe(0)
				expect(settlementAfterFault.rejected).toBe(0)
				expect(
					await costLedgerCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)

				// (i-b) Correction 4 (HANDOFF): the fault cross-product's
				// FRESH × ledger cell. The in-session ledger write fails inside
				// the document-fence transaction on a FRESH import — the whole
				// fenced write (parent, chunks, ledger) rolls back together,
				// so nothing persists on the fresh path either.
				const freshLedgerFaultDb = faultInjectingDb(db, {
					collection: `${PREFIX}memory_cost_ledger`,
					method: "updateOne",
					label: "N4(i-b) in-session ledger write (fresh)",
				})
				const freshLedgerFaulted = await ingestDirect(
					trackLedgerOperations(freshLedgerFaultDb),
					agentA,
					[fileDoc(alphaPath, c1Content)],
				)
				expect(freshLedgerFaulted.documentsProcessed).toBe(0)
				expect(freshLedgerFaulted.errors).toHaveLength(1)
				expect(
					await kbCollection(db, PREFIX).countDocuments({ agentId: agentA }),
				).toBe(0)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// Correction 2 (O4 disposition, mirrored from (iii-b) below):
				// the injected ledger fault surfaced as a rejected promise
				// returned into the product's own `updateOne(...).catch` chain
				// — recorded as the real rejected operation it was, settled
				// here, and isolated from the (ii) retry's counts below.
				const settlementFreshLedgerFault = await drainLedgerOperations()
				expect(settlementFreshLedgerFault.drained).toBe(1)
				expect(settlementFreshLedgerFault.rejected).toBe(1)
				expect(
					await costLedgerCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)

				// A cache sentinel: the faulted attempts processed zero documents
				// (per-document failure), so their post-primary cache fence never
				// runs and the sentinel survives.
				const sentinelKey = `n4-sentinel-${randomUUID()}`
				await seedCacheRow({
					agentId: agentA,
					scopeRef: `agent:${agentA}`,
					key: sentinelKey,
				})

				// (ii) Clean retry of the SAME document: fresh admission, full
				// success — parent, chunks, completion, in-session ledger, and
				// the separate post-primary cache fence.
				const first = await ingestDirect(trackLedgerOperations(db), agentA, [
					fileDoc(alphaPath, c1Content),
				])
				expect(first.documentsProcessed).toBe(1)
				expect(first.errors).toHaveLength(0)
				expect(first.chunksCreated).toBeGreaterThan(0)
				// Correction 2: the clean retry's real billing operation(s)
				// settled — this attempt's own count (the faulted attempt's
				// drain above already isolated it).
				const settlementFirst = await drainLedgerOperations()
				expect(settlementFirst.drained).toBeGreaterThanOrEqual(1)
				expect(settlementFirst.rejected).toBe(0)
				const parentFirst = await kbCollection(db, PREFIX).findOne({
					agentId: agentA,
				})
				expect(parentFirst?.chunksComplete).toBe(true)
				expect(parentFirst?.hash).toBe(hashText(c1Content))
				// The cache fence invalidated the sentinel; the boundary claim
				// never wrote a refresh marker (no manager involved).
				expect(
					await queryCacheCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).toBeNull()

				// Byte-identical snapshot before the mid-transaction fault on
				// the REPLACEMENT path (same path, changed content).
				const parentBefore = await kbCollection(db, PREFIX).findOne({
					agentId: agentA,
				})
				const chunksBefore = await kbChunksCollection(db, PREFIX)
					.find({ agentId: agentA })
					.toArray()
				const ledgerBefore = await costLedgerCollection(db, PREFIX).findOne({
					agentId: agentA,
					day: costLedgerDay(),
					kind: "indexing",
				})
				// The parent was seeded with a string _id (product cast idiom).
				const oldParentId = parentBefore?._id as unknown as string
				expect(oldParentId).toBeDefined()

				// (iii-a) Correction 4 (HANDOFF): the fault cross-product's
				// REPLACEMENT × chunk cell. The chunk bulk write fails inside
				// the replacement document-fence transaction — the whole fenced
				// write rolls back and the original parent, chunks, and ledger
				// stay byte-identical against the snapshot above.
				const replacementChunkFaultDb = faultInjectingDb(db, {
					collection: `${PREFIX}knowledge_base_chunks`,
					method: "bulkWrite",
					label: "N4(iii-a) chunk bulk write (replacement)",
				})
				const replacementChunkFaulted = await ingestDirect(
					trackLedgerOperations(replacementChunkFaultDb),
					agentA,
					[fileDoc(alphaPath, c2Content)],
				)
				expect(replacementChunkFaulted.documentsProcessed).toBe(0)
				expect(replacementChunkFaulted.errors).toHaveLength(1)
				expect(
					await kbCollection(db, PREFIX).findOne({ agentId: agentA }),
				).toEqual(parentBefore)
				expect(
					await kbChunksCollection(db, PREFIX)
						.find({ agentId: agentA })
						.toArray(),
				).toEqual(chunksBefore)
				expect(
					await costLedgerCollection(db, PREFIX).findOne({
						agentId: agentA,
						day: costLedgerDay(),
						kind: "indexing",
					}),
				).toEqual(ledgerBefore)
				// Correction 2: the chunk fault aborted the fence BEFORE the
				// in-session ledger write, so no billing operation was started
				// (mirrors (i)'s disposition, on the replacement path).
				const settlementReplacementChunkFault = await drainLedgerOperations()
				expect(settlementReplacementChunkFault.drained).toBe(0)
				expect(settlementReplacementChunkFault.rejected).toBe(0)

				// (iii-b) Ledger fault INSIDE the replacement fence: the
				// in-session ledger write fails, the whole transaction rolls
				// back — original parent, chunks, and ledger stay byte-identical.
				const ledgerFaultDb = faultInjectingDb(db, {
					collection: `${PREFIX}memory_cost_ledger`,
					method: "updateOne",
					label: "N4(iii-b) in-session ledger write",
				})
				const ledgerFaulted = await ingestDirect(
					trackLedgerOperations(ledgerFaultDb),
					agentA,
					[fileDoc(alphaPath, c2Content)],
				)
				expect(ledgerFaulted.documentsProcessed).toBe(0)
				expect(ledgerFaulted.errors).toHaveLength(1)
				expect(
					await kbCollection(db, PREFIX).findOne({ agentId: agentA }),
				).toEqual(parentBefore)
				expect(
					await kbChunksCollection(db, PREFIX)
						.find({ agentId: agentA })
						.toArray(),
				).toEqual(chunksBefore)
				expect(
					await costLedgerCollection(db, PREFIX).findOne({
						agentId: agentA,
						day: costLedgerDay(),
						kind: "indexing",
					}),
				).toEqual(ledgerBefore)
				// Correction 2 (O4 disposition): the injected ledger fault
				// surfaced as a rejected promise returned into the product's
				// own `updateOne(...).catch` chain — recorded as the real
				// rejected operation it was, settled here, and isolated from
				// the (iv) retry's counts below.
				const settlementLedgerFault = await drainLedgerOperations()
				expect(settlementLedgerFault.drained).toBe(1)
				expect(settlementLedgerFault.rejected).toBe(1)

				// (iv) Clean retry of the changed content: the replacement
				// completes — new parent hash, old parent's chunks gone, ledger
				// units strictly grown.
				const second = await ingestDirect(trackLedgerOperations(db), agentA, [
					fileDoc(alphaPath, c2Content),
				])
				expect(second.documentsProcessed).toBe(1)
				expect(second.errors).toHaveLength(0)
				// Correction 2: this attempt's own settlement — the faulted
				// replacement's rejected operation was drained above.
				const settlementSecond = await drainLedgerOperations()
				expect(settlementSecond.drained).toBeGreaterThanOrEqual(1)
				expect(settlementSecond.rejected).toBe(0)
				const parentAfter = await kbCollection(db, PREFIX).findOne({
					agentId: agentA,
					"source.path": alphaPath,
				})
				expect(parentAfter?.hash).toBe(hashText(c2Content))
				expect(parentAfter?.chunksComplete).toBe(true)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						docId: oldParentId,
					}),
				).toBe(0)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBeGreaterThan(0)
				const ledgerAfter = await costLedgerCollection(db, PREFIX).findOne({
					agentId: agentA,
					day: costLedgerDay(),
					kind: "indexing",
				})
				expect(Number(ledgerAfter?.embedUnits ?? 0)).toBeGreaterThan(
					Number(ledgerBefore?.embedUnits ?? 0),
				)
			} catch (error) {
				// Failure-preserving (Correction 3): captured, never rethrown —
				// the finally runs its full cleanup sequence first.
				primaryFailed = true
				primaryError = error
			} finally {
				// Never-throwing cleanup (Correction 3): the Correction-2
				// early-failure ledger settlement (nothing started by an
				// interrupted attempt races the teardown) + workspace removal;
				// every cleanup failure is retained, this finally never throws.
				try {
					await drainLedgerOperations()
					await rm(workspaceDir, { recursive: true, force: true })
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError)
				}
			}
			reportCaseFailures("N4", primaryFailed, primaryError, cleanupErrors)
		},
		N4_CASE_BUDGET_MS,
	)

	it(
		"N5: the cache-tail fence — acknowledged invalidation, best-effort fault degradation, and a gate conflict after an erasure mid-attempt",
		async () => {
			const agentA = `kbw-n5-a-${randomUUID()}`
			const agentB = `kbw-n5-b-${randomUUID()}`
			const workspaceDir = join(tmpdir(), `memongo-kb-admission-n5-${RUN_UUID}`)
			const alphaPath = join(workspaceDir, "alpha.md")
			const alphaContent = "Native admission fence N5 alpha line."
			// Correction 3 (corrective-design.md §3): failure-preserving case
			// frame — primary error captured, never-throwing finallys at BOTH
			// nesting levels, watchdog expiry recorded separately, all
			// failures reported together at the end.
			let primaryFailed = false
			let primaryError: unknown
			const cleanupErrors: unknown[] = []
			let watchdogExpiry: unknown
			try {
				// Tenant-B controls.
				await seedKBDoc({
					agentId: agentB,
					path: "n5-b.md",
					content: "Tenant B control document line.",
					chunksComplete: true,
				})
				await seedMarker(agentB, new Date())
				const bMarkerBefore = await metaCollection(db, PREFIX).findOne({
					_id: MARKER_ID(agentB),
				} as Record<string, unknown>)
				const bDocBefore = await kbCollection(db, PREFIX).findOne({
					agentId: agentB,
				})

				// (i) Acknowledged work: the refresh's post-primary cache fence
				// deletes A's cache rows; B's rows and the marker stay.
				await mkdir(workspaceDir, { recursive: true })
				await writeFile(alphaPath, `${alphaContent}\n`, "utf-8")
				await seedCacheRow({
					agentId: agentA,
					scopeRef: `agent:${agentA}`,
					key: `n5-a1-${randomUUID()}`,
				})
				await seedCacheRow({
					agentId: agentA,
					scopeRef: `agent:${agentA}`,
					key: `n5-a2-${randomUUID()}`,
				})
				const bCacheKey = `n5-b-${randomUUID()}`
				await seedCacheRow({
					agentId: agentB,
					scopeRef: `agent:${agentB}`,
					key: bCacheKey,
				})
				const bCacheBefore = await queryCacheCollection(db, PREFIX).findOne({
					agentId: agentB,
				})
				const acknowledged = captureOutcome(
					kbAutoRefresh(
						tenantManager(agentA, trackLedgerOperations(db), workspaceDir),
					),
				)
				expect((await acknowledged).settled).toBe("resolved")
				const aDocAck = await kbCollection(db, PREFIX).findOne({
					agentId: agentA,
				})
				expect(aDocAck).not.toBeNull()
				expect(aDocAck?.chunksComplete).toBe(true)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBeGreaterThan(0)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).not.toBeNull()
				expect(
					await queryCacheCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await queryCacheCollection(db, PREFIX).findOne({
						agentId: agentB,
					}),
				).toEqual(bCacheBefore)
				// Correction 2: this attempt's own real billing settlement —
				// the acknowledged import billed and settled (fire-and-forget
				// on OLD, in-session on NEW alike), nothing rejected. Draining
				// here isolates the (ii) fault attempt's counts below.
				const settlementAck = await drainLedgerOperations()
				expect(settlementAck.drained).toBeGreaterThanOrEqual(1)
				expect(settlementAck.rejected).toBe(0)

				// Correction 1 (corrective-design.md §1): A's refresh marker is
				// DELETED and its absence ASSERTED before (ii). (i) just wrote a
				// fresh marker, and autoRefreshHours is 24 — without this delete
				// the (ii) refresh would SKIP its import entirely (marker fresh)
				// and (ii)/(iii) would assert against vacuous no-op refreshes.
				await metaCollection(db, PREFIX).deleteOne({
					_id: MARKER_ID(agentA),
				} as Record<string, unknown>)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).toBeNull()

				// (ii) Cache-fence FAULT on the NEXT import: the documents are
				// already committed, so the fault aborts only the cache
				// transaction — the refresh still settles, writes its marker,
				// and A's cache rows survive (best-effort invalidation).
				const betaPath = join(workspaceDir, "beta.md")
				const betaContent = "Native admission fence N5 beta line."
				await writeFile(betaPath, `${betaContent}\n`, "utf-8")
				await seedCacheRow({
					agentId: agentA,
					scopeRef: `agent:${agentA}`,
					key: `n5-fault-${randomUUID()}`,
				})
				const cacheFaultDb = faultInjectingDb(db, {
					collection: `${PREFIX}query_cache`,
					method: "deleteMany",
					label: "N5(ii) cache fence invalidation",
				})
				const cacheFaultRefresh = captureOutcome(
					kbAutoRefresh(
						tenantManager(
							agentA,
							trackLedgerOperations(cacheFaultDb),
							workspaceDir,
						),
					),
				)
				expect((await cacheFaultRefresh).settled).toBe("resolved")
				expect(
					await kbCollection(db, PREFIX).countDocuments({ agentId: agentA }),
				).toBe(2)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBeGreaterThanOrEqual(2)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).not.toBeNull()
				// The faulted invalidation rolled back: A's cache rows survive.
				expect(
					await queryCacheCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(1)
				expect(
					await queryCacheCollection(db, PREFIX).findOne({
						agentId: agentB,
					}),
				).toEqual(bCacheBefore)
				// Correction 2: the faulted attempt's own settlement — the
				// cache fence fault was a deleteMany, never a ledger op; the
				// import still billed and settled, nothing rejected. Draining
				// here isolates the (iii) conflict attempt's counts below.
				const settlementCacheFault = await drainLedgerOperations()
				expect(settlementCacheFault.drained).toBeGreaterThanOrEqual(1)
				expect(settlementCacheFault.rejected).toBe(0)

				// Correction 1 (corrective-design.md §1): same marker delete +
				// absence proof before (iii) — the faulted (ii) refresh wrote a
				// marker too, and a fresh marker would suppress the (iii)
				// refresh's import (the gate-conflict subcase would go vacuous).
				await metaCollection(db, PREFIX).deleteOne({
					_id: MARKER_ID(agentA),
				} as Record<string, unknown>)
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).toBeNull()
				// Pre-attempt ledger snapshot for the gamma growth proof below.
				const ledgerBeforeGamma = await costLedgerCollection(
					db,
					PREFIX,
				).findOne({
					agentId: agentA,
					day: costLedgerDay(),
					kind: "indexing",
				})
				const ledgerUnitsBeforeGamma = Number(
					ledgerBeforeGamma?.embedUnits ?? 0,
				)

				// (iii) Gate conflict: park the attempt's SECOND gate read —
				// the cache-fence revalidation, after the document fence has
				// already committed — then erase the tenant. On release the
				// fence observes the advanced epoch, aborts the attempt (no
				// marker), and the erasure's sweep stays authoritative.
				const gammaPath = join(workspaceDir, "gamma.md")
				const gammaContent = "Native admission fence N5 gamma line."
				await writeFile(gammaPath, `${gammaContent}\n`, "utf-8")
				const latch = parkGateReadAt(db, agentA, 2)
				const conflictRefresh = captureOutcome(
					kbAutoRefresh(
						tenantManager(
							agentA,
							trackLedgerOperations(latch.db),
							workspaceDir,
						),
					),
				)
				try {
					// Parked at the cache-fence gate read, or the case fails on
					// an explicit precondition (honest on either byte set).
					const firstSignal = await Promise.race([
						latch.readCompleted.then(() => "parked" as const),
						conflictRefresh.then(() => "settled-first" as const),
					])
					expect(firstSignal).toBe("parked")

					// Correction 1 (corrective-design.md §1): pre-erasure gamma
					// COMMITTED proof through the UNWRAPPED real db. The park is
					// at the cache-fence revalidation — which only runs AFTER
					// the document fence committed — so while parked: gamma's
					// parent exists and is complete, its chunk rows are present
					// (product chunk rows carry `path`), and the in-session
					// ledger contribution is already committed (embedUnits
					// grown vs the pre-attempt snapshot). This pins the exact
					// ordering the erasure-sweep assertions below depend on.
					const gammaParent = await kbCollection(db, PREFIX).findOne({
						agentId: agentA,
						"source.path": gammaPath,
					})
					expect(gammaParent).not.toBeNull()
					expect(gammaParent?.chunksComplete).toBe(true)
					expect(
						await kbChunksCollection(db, PREFIX).countDocuments({
							agentId: agentA,
							path: gammaPath,
						}),
					).toBeGreaterThan(0)
					const ledgerAtPark = await costLedgerCollection(db, PREFIX).findOne({
						agentId: agentA,
						day: costLedgerDay(),
						kind: "indexing",
					})
					expect(Number(ledgerAtPark?.embedUnits ?? 0)).toBeGreaterThan(
						ledgerUnitsBeforeGamma,
					)

					// Erase A while the cache-fence revalidation is parked: the
					// document fence's committed writes are swept with it.
					const eraseReceipt = await tenantManager(
						agentA,
						db,
						workspaceDir,
					).deleteAllForAgent()
					expect(eraseReceipt).toMatchObject({
						agentId: agentA,
						status: "complete",
					})
					expect(eraseReceipt.epoch).toBeGreaterThan(0)

					latch.release()
					await conflictRefresh
					// The deferred attempt settled normally (the manager warns
					// and returns; the conflict is inside the engine).
					expect((await conflictRefresh).settled).toBe("resolved")
					// The abort claimed no work: no refresh marker for A.
					expect(
						await metaCollection(db, PREFIX).findOne({
							_id: MARKER_ID(agentA),
						} as Record<string, unknown>),
					).toBeNull()
					// The erasure's sweep stays authoritative: zero KB parents
					// and chunks for A.
					expect(
						await kbCollection(db, PREFIX).countDocuments({
							agentId: agentA,
						}),
					).toBe(0)
					expect(
						await kbChunksCollection(db, PREFIX).countDocuments({
							agentId: agentA,
						}),
					).toBe(0)
					// Correction 2: real-operation settlement AFTER the sweep
					// assertions. The gamma attempt's billing (proven committed
					// at park above) is exactly the tracked operation settling
					// here — drained, nothing rejected; its row was already
					// swept, and the ledger zero-count below proves no
					// post-sweep write recreated it.
					const settlementAfterConflict = await drainLedgerOperations()
					expect(settlementAfterConflict.drained).toBeGreaterThanOrEqual(1)
					expect(settlementAfterConflict.rejected).toBe(0)
					expect(
						await costLedgerCollection(db, PREFIX).countDocuments({
							agentId: agentA,
						}),
					).toBe(0)
					expect(
						await queryCacheCollection(db, PREFIX).countDocuments({
							agentId: agentA,
						}),
					).toBe(0)
					// Gate open at the receipt epoch after the abort.
					const gateAfterConflict = await readErasureGate({
						db,
						prefix: PREFIX,
						agentId: agentA,
					})
					expect(gateAfterConflict).toMatchObject({
						state: "open",
						epoch: eraseReceipt.epoch,
					})
					// Tenant-B controls byte-identical throughout.
					const bMarkerAfter = await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentB),
					} as Record<string, unknown>)
					expect(bMarkerAfter).toEqual(bMarkerBefore)
					const bDocAfter = await kbCollection(db, PREFIX).findOne({
						agentId: agentB,
					})
					expect(bDocAfter).toEqual(bDocBefore)
					expect(
						await queryCacheCollection(db, PREFIX).findOne({
							agentId: agentB,
						}),
					).toEqual(bCacheBefore)
				} finally {
					// Never-throwing INNER cleanup (Correction 3): unconditional
					// release + awaited settlement (idempotent) + the
					// Correction-2 drain that settles any started real ledger
					// operation on an early failure inside the conflict window,
					// + latch-watchdog expiry recording. Failures push into the
					// OUTER case's cleanup error set, so nothing masks anything
					// across the nesting — and a primary error (if any)
					// propagates through this finally untouched to the outer
					// catch. Same-step C3 clarification: watchdog expiry is
					// recorded SEPARATELY from the case's own explicit release
					// and FAILS the case via reportCaseFailures — a
					// self-released latch must never silently count as the
					// intended parked schedule.
					try {
						latch.release()
						await conflictRefresh
						await drainLedgerOperations()
						if (latch.watchdogFired()) {
							watchdogExpiry = new Error(
								"N5(iii): the gate-read latch watchdog fired — the park outlived its 30s deadline before the case's own release",
							)
						}
					} catch (innerCleanupError) {
						cleanupErrors.push(innerCleanupError)
					}
				}
			} catch (error) {
				// Failure-preserving (Correction 3): captured, never rethrown —
				// the finally runs its full cleanup sequence first.
				primaryFailed = true
				primaryError = error
			} finally {
				// Never-throwing OUTER cleanup (Correction 3): the Correction-2
				// early-failure ledger settlement (nothing started by an
				// interrupted attempt races the teardown) + workspace removal;
				// every cleanup failure is retained, this finally never throws.
				try {
					await drainLedgerOperations()
					await rm(workspaceDir, { recursive: true, force: true })
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError)
				}
			}
			reportCaseFailures(
				"N5",
				primaryFailed,
				primaryError,
				cleanupErrors,
				watchdogExpiry,
			)
		},
		N5_CASE_BUDGET_MS,
	)

	it(
		"N6: foreign-child preservation — the real unique indexes and ownership revalidation reject cross-tenant chunk rows",
		async () => {
			const agentA = `kbw-n6-a-${randomUUID()}`
			const agentB = `kbw-n6-b-${randomUUID()}`
			// Correction 3 (corrective-design.md §3): the same failure-preserving
			// frame as every other case. N6 has no parked promises and no
			// workspace, but an early failure still gets the early-failure
			// ledger drain, and primary/cleanup failures are still reported
			// together, never masked.
			let primaryFailed = false
			let primaryError: unknown
			const cleanupErrors: unknown[] = []
			try {
				// (a) Repair path: A's own incomplete parent at path P with a
				// B-owned child under it. A's re-import of the same content
				// enters the repair fence, which revalidates ownership of the
				// children BEFORE any write: the B-owned child is foreign, the
				// whole transaction aborts, and both rows stay byte-identical.
				const pathA = "n6-a.md"
				const contentA = "Native admission fence N6 repair line."
				const parentId = await seedKBDoc({
					agentId: agentA,
					path: pathA,
					content: contentA,
					chunksComplete: false,
				})
				const childText = "Seeded foreign child line."
				await seedChunkRow({
					docId: parentId,
					agentId: agentB,
					scopeRef: `agent:${agentA}`,
					path: pathA,
					text: childText,
					startLine: 1,
					endLine: 1,
					ordinal: 0,
				})
				const parentBeforeA = await kbCollection(db, PREFIX).findOne({
					_id: parentId,
				} as Record<string, unknown>)
				const childBeforeA = await kbChunksCollection(db, PREFIX).findOne({
					docId: parentId,
				})
				const repairResult = await ingestDirect(
					trackLedgerOperations(db),
					agentA,
					[fileDoc(pathA, contentA)],
				)
				expect(repairResult.documentsProcessed).toBe(0)
				expect(repairResult.errors).toHaveLength(1)
				expect(repairResult.errors[0]).toContain("foreign child")
				expect(
					await kbCollection(db, PREFIX).findOne({
						_id: parentId,
					} as Record<string, unknown>),
				).toEqual(parentBeforeA)
				expect(
					await kbChunksCollection(db, PREFIX).findOne({
						docId: parentId,
					}),
				).toEqual(childBeforeA)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// Correction 2: the repair aborted before starting ANY billing
				// operation — nothing drained, nothing rejected.
				const settlementA = await drainLedgerOperations()
				expect(settlementA.drained).toBe(0)
				expect(settlementA.rejected).toBe(0)
				expect(
					await costLedgerCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)

				// (b) Fresh path: a B-owned chunk row already occupies A's
				// unique chunk key (same scopeRef/path/lines/ordinal). A's
				// fresh import inserts its parent, then the chunk bulk write
				// hits the REAL unique index (E11000), the transaction aborts,
				// and even the parent insert rolls back.
				const pathB = "n6-b.md"
				const contentB = "Native admission fence N6 fresh line."
				const bRowId = randomUUID()
				await kbChunksCollection(db, PREFIX).insertOne({
					_id: bRowId,
					docId: randomUUID(),
					agentId: agentB,
					scope: "agent",
					scopeRef: `agent:${agentA}`,
					path: pathB,
					source: "kb",
					text: "Seeded unique-key occupant line.",
					hash: hashText("Seeded unique-key occupant line."),
					startLine: 1,
					endLine: 1,
					ordinal: 0,
					updatedAt: new Date(),
				} as Record<string, unknown>)
				const foreignRowBefore = await kbChunksCollection(db, PREFIX).findOne({
					_id: bRowId,
				} as Record<string, unknown>)
				const freshResult = await ingestDirect(
					trackLedgerOperations(db),
					agentA,
					[fileDoc(pathB, contentB)],
				)
				expect(freshResult.documentsProcessed).toBe(0)
				expect(freshResult.errors).toHaveLength(1)
				expect(freshResult.errors[0]).toMatch(/duplicate key/i)
				expect(
					await kbCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await kbChunksCollection(db, PREFIX).findOne({
						_id: bRowId,
					} as Record<string, unknown>),
				).toEqual(foreignRowBefore)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// Correction 2: the E11000 abort rolled the transaction back
				// before starting ANY billing operation — nothing drained,
				// nothing rejected.
				const settlementB = await drainLedgerOperations()
				expect(settlementB.drained).toBe(0)
				expect(settlementB.rejected).toBe(0)
				expect(
					await costLedgerCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)

				// (c) Wrong-namespace control: a child row that carries A's
				// agentId but B's scopeRef under A's incomplete parent. The
				// ownership revalidation is scopeRef-based: the row is foreign
				// to A's namespace, the repair aborts, and the row stays
				// byte-identical (never silently adopted into A's chunk set).
				const pathC = "n6-c.md"
				const contentC = "Native admission fence N6 namespace line."
				const parentCId = await seedKBDoc({
					agentId: agentA,
					path: pathC,
					content: contentC,
					chunksComplete: false,
				})
				const namespaceRowId = randomUUID()
				await kbChunksCollection(db, PREFIX).insertOne({
					_id: namespaceRowId,
					docId: parentCId,
					agentId: agentA,
					scope: "agent",
					scopeRef: `agent:${agentB}`,
					path: pathC,
					source: "kb",
					text: "Seeded wrong-namespace child line.",
					hash: hashText("Seeded wrong-namespace child line."),
					startLine: 1,
					endLine: 1,
					ordinal: 0,
					updatedAt: new Date(),
				} as Record<string, unknown>)
				const namespaceRowBefore = await kbChunksCollection(db, PREFIX).findOne(
					{
						_id: namespaceRowId,
					} as Record<string, unknown>,
				)
				const parentBeforeC = await kbCollection(db, PREFIX).findOne({
					_id: parentCId,
				} as Record<string, unknown>)
				const namespaceResult = await ingestDirect(
					trackLedgerOperations(db),
					agentA,
					[fileDoc(pathC, contentC)],
				)
				expect(namespaceResult.documentsProcessed).toBe(0)
				expect(namespaceResult.errors).toHaveLength(1)
				expect(namespaceResult.errors[0]).toContain("foreign child")
				expect(
					await kbCollection(db, PREFIX).findOne({
						_id: parentCId,
					} as Record<string, unknown>),
				).toEqual(parentBeforeC)
				expect(
					await kbChunksCollection(db, PREFIX).findOne({
						_id: namespaceRowId,
					} as Record<string, unknown>),
				).toEqual(namespaceRowBefore)
				expect(
					await kbChunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
						scopeRef: `agent:${agentA}`,
					}),
				).toBe(0)
				// Correction 2: the namespace abort came before ANY billing
				// operation started — nothing drained, nothing rejected.
				const settlementC = await drainLedgerOperations()
				expect(settlementC.drained).toBe(0)
				expect(settlementC.rejected).toBe(0)
				expect(
					await costLedgerCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				// No refresh marker anywhere in N6 (direct boundary, no
				// manager): A never claimed acknowledged work.
				expect(
					await metaCollection(db, PREFIX).findOne({
						_id: MARKER_ID(agentA),
					} as Record<string, unknown>),
				).toBeNull()
			} catch (error) {
				// Failure-preserving (Correction 3): captured, never rethrown —
				// the finally runs its full cleanup sequence first.
				primaryFailed = true
				primaryError = error
			} finally {
				// Never-throwing cleanup (Correction 3): the Correction-2
				// early-failure ledger settlement (nothing started by an
				// interrupted attempt races the teardown); every cleanup failure
				// is retained, this finally never throws.
				try {
					await drainLedgerOperations()
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError)
				}
			}
			reportCaseFailures("N6", primaryFailed, primaryError, cleanupErrors)
		},
		N6_CASE_BUDGET_MS,
	)
})
