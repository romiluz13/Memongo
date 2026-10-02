// Manager-boundary tenant erasure gate e2e — RED anchor T2 of the
// production erasure integration grant, adapted per the construction
// review rulings G1-G4 (URI hard-reject; try/finally latch release and
// attempt settlement; manager/public-boundary acceptance with the real
// writer; early settlement race on the park signal).
//
// T2 discriminates the granted deleteAllForAgent from the current unfenced
// sweep with one scenario driven through the PUBLIC manager boundary:
//
//   1. seed tenant rows for agent A (direct inserts)
//   2. OLD attempt: manager.deleteAllForAgent() — the REAL manager facade
//      (drain included: the real stopMemoryJobWorker runs and touches no
//      collection, so the latch schedule is unchanged from the engine
//      seam; the accessTracker flush leg is skipped because the mock
//      manager carries no tracker) over a latch-wrapped db. A one-shot
//      latch parks the FIRST parkable op (find terminal OR deleteMany) on
//      the events collection:
//        - on MAIN (unfenced sweep) the park point is the events
//          deleteMany inside the parallel sweep
//        - on the granted flow the park point is the between-batches
//          id-fetch find — no transaction is open while parked
//   3. SUCCESSOR: manager.deleteAllForAgent({ recovery: "takeover" }) over
//      the real db — on the grant recovery threads through the manager to
//      the engine and dispatches to takeoverErasure DIRECTLY (never a
//      fresh begin), replaces the old run, sweeps, finalizes. On MAIN the
//      argument is ignored at runtime and the legacy unfenced sweep runs.
//   4. fresh write: the REAL public writer writeConversationEvent
//      (admission captured at the call boundary; fenced event persist +
//      extraction job) inserts new post-takeover tenant data for A
//   5. release the latch — the displaced old attempt resumes
//
// RED expectations, stated accurately for MAIN: the displaced attempt on
// MAIN reports status "partial", NOT "complete" — the successor's
// memory_mutations audit row surfaces as tenant residual in the displaced
// attempt's post-sweep verification. The discriminating rows are
// therefore:
//   - headline row 1 (RED on MAIN) — irreversible-effect invariant: the
//     fresh post-takeover write must survive the displaced attempt. On
//     MAIN the released unfenced deleteMany({agentId}) matches it and
//     deletes it (count 0 != 1). On the grant the released id-fetch WILL
//     return the fresh row's id — the protection is the fence check
//     between fetch and delete conflicting on the stale token.
//   - headline row 2 (RED on MAIN) — receipt honesty: the displaced
//     attempt must report ownershipLost: true and NO gateState claim. On
//     MAIN ownershipLost is absent (undefined != true). The soft status
//     assertion ("partial") PASSES on MAIN for the wrong reason (residual
//     detection, not ownership loss); both headline rows stay soft so one
//     RED run surfaces both failures.
//
// Earlier evidence, preserved honestly with its actual target: the first
// execution of this scenario (engine-boundary variant — engine
// deleteAllForAgent driven directly, fresh write via raw
// captureAdmissionToken + withFencedWrite) ran against a LOCAL Docker
// Atlas Local 8.3.8 stack (replica set memongo-preview, 127.0.0.1:27017),
// NOT Atlas. It observed row 1 RED (fresh count 0 != 1), row 2 RED
// (ownershipLost undefined != true), displaced receipt "partial" via the
// memory_mutations residual, and gateState already absent; its disposable
// database was dropped and verified absent after the run (no stray
// databases, no stray processes). That engine-level result counts only as
// a core diagnostic; this manager-boundary adaptation is the acceptance
// mechanism. The authorized RED run targets a temporary Atlas M10 cluster
// whose exact hostname and server version are pinned by the PRIVATE
// validation launcher for that run — never by this file.
//
// Target gating (G1): MEMONGO_TEST_MONGODB_URI is REQUIRED — there is no
// default URI (not even localhost) and no silent skip; it must parse as
// mongodb:// or mongodb+srv:// (helper-e2e parse pattern with a hard
// throw instead of its skipIf). The suite is target-neutral: it runs
// against whatever replica-set target the operator deliberately
// configures. Target identity for the authorized run — approved
// hostname, server version, credential construction — is owned by the
// PRIVATE validation launcher that spawns this suite, never by this file.
// The credential travels only via the environment; nothing here prints
// the URI or its userinfo.
//
// Runs against a replica set (fenced writes use transactions). Unique
// disposable database per run; teardown drops it, asserts absence, and
// closes the client.

import { randomUUID } from "node:crypto"
import type { Collection, Db, Document, FindCursor } from "mongodb"
import { MongoClient, MongoServerError } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { TenantErasureReceipt } from "./mongodb-erasure.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { ensureTimeseriesOrPlain } from "./mongodb-schema-collections.js"
import {
	captureAdmissionToken,
	isErasureGateConflictError,
	readErasureGate,
} from "./mongodb-write-fence.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

// ---------------------------------------------------------------------------
// Growth note: this file is growing into the granted production matrix
// (§6: T1-T7 + T2b + F10 pins + T5 F8 injections) incrementally. T2 (the
// RED anchor, now the GREEN target) and T1 are landed below; later cases
// append in matrix order with their file-local helpers.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Target gating (G1)
// ---------------------------------------------------------------------------

const URI = process.env.MEMONGO_TEST_MONGODB_URI?.trim() ?? ""

function parsesAsMongoUri(candidate: string): boolean {
	if (!/^mongodb(\+srv)?:\/\//.test(candidate)) return false
	try {
		new URL(candidate)
		return true
	} catch {
		return false
	}
}

// This suite's evidence depends on actual execution against a declared
// target: a missing or unparsable URI is a hard collection-time error —
// there is no default URI and no silent skip.
if (!URI || !parsesAsMongoUri(URI)) {
	throw new Error(
		"MEMONGO_TEST_MONGODB_URI is required for this e2e suite: set it " +
			"explicitly to the deliberately configured run target " +
			"(mongodb:// or mongodb+srv://, replica set — fenced writes use " +
			"transactions). There is no default URI and no silent skip.",
	)
}

const DB_NAME = `memongo_erasure_gate_e2e_${randomUUID().replaceAll("-", "")}`
const PREFIX = "test_"
const EVENTS = `${PREFIX}events`
const STRUCTURED = `${PREFIX}structured_mem`
const TELEMETRY = `${PREFIX}memory_telemetry`
const ACCESS_EVENTS = `${PREFIX}access_events`
const MUTATIONS = `${PREFIX}memory_mutations`
const META = `${PREFIX}meta`
const RUNS = `${PREFIX}relevance_runs`
const ARTIFACTS = `${PREFIX}relevance_artifacts`
const TIMEOUT = 60_000

let client: MongoClient
let db: Db

// ---------------------------------------------------------------------------
// Manager boundary
// ---------------------------------------------------------------------------

captureManagerPrototype(MongoDBMemoryManager)

/**
 * Real manager methods over a real (or latch-wrapped) db — the proven
 * buildMockManager-over-real-db pattern from mongodb-erasure-fence.e2e.test.ts.
 * The facade runs for real: adminOpsOf binds the admin ops to these host
 * fields, so deleteAllForAgent drains (the real stopMemoryJobWorker; the
 * accessTracker flush leg is a no-op without a tracker) and then calls the
 * engine eraser with this db/prefix/agentId.
 */
function tenantManager(agent: string, managerDb: Db): MongoDBMemoryManager {
	return buildMockManager({
		client,
		db: managerDb,
		prefix: PREFIX,
		agentId: agent,
		agentScopeRef: `agent:${agent}`,
		workspaceScopeRef: `workspace:${agent}`,
		workspaceDir: "/tmp/memongo-erasure-gate-e2e",
		config: kitMongoConfig({
			episodes: { enabled: false, minEventsForEpisode: 6 },
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

/**
 * MAIN's manager signature is deleteAllForAgent() with no parameters; the
 * grant adds an optional opts bag carrying recovery: "takeover" and
 * threads it to the engine recovery dispatch. Cast through a permissive
 * call signature so this file compiles on BOTH byte sets and the RED
 * stays behavioral, not type-level: MAIN ignores the argument at runtime;
 * the grant reads it.
 */
type ManagerErasureEntry = (opts?: {
	recovery?: "takeover"
}) => Promise<TenantErasureReceipt>

function erasureEntry(manager: MongoDBMemoryManager): ManagerErasureEntry {
	return manager.deleteAllForAgent.bind(
		manager,
	) as unknown as ManagerErasureEntry
}

// ---------------------------------------------------------------------------
// One-shot park latch
// ---------------------------------------------------------------------------

type ParkLatch = {
	/** Resolves once the first parkable operation has parked (its caller is blocked). */
	parked: Promise<void>
	/** Unblocks the parked operation; every later operation passes through. */
	release: () => void
}

const CURSOR_CHAIN_METHODS = new Set([
	"limit",
	"sort",
	"skip",
	"project",
	"batchSize",
	"maxTimeMS",
	"collation",
	"hint",
	"addCursorFlag",
])
const CURSOR_TERMINAL_METHODS = new Set([
	"toArray",
	"next",
	"forEach",
	"tryNext",
	"hasNext",
])

/**
 * Wraps `db` so the FIRST parkable operation against `collectionName`
 * blocks until `latch.release()`. Parkable ops: `deleteMany` and the
 * terminal read (`toArray`/`next`/...) of a `find` cursor, including
 * chained cursors. Everything else — and every op after the first park —
 * hits the real database untouched.
 */
function latchDb(
	realDb: Db,
	collectionName: string,
): { db: Db; latch: ParkLatch } {
	let armed = true
	let signalParked: () => void = () => {}
	const parked = new Promise<void>((resolve) => {
		signalParked = resolve
	})
	let openGate: () => void = () => {}
	const released = new Promise<void>((resolve) => {
		openGate = resolve
	})

	async function maybePark(): Promise<void> {
		if (!armed) {
			return
		}
		armed = false
		signalParked()
		await released
	}

	function wrapCursor(real: FindCursor<Document>): FindCursor<Document> {
		return new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (typeof value !== "function") {
					return value
				}
				if (CURSOR_CHAIN_METHODS.has(prop as string)) {
					return (...args: unknown[]) =>
						wrapCursor(
							(value as (...a: unknown[]) => FindCursor<Document>).apply(
								target,
								args,
							),
						)
				}
				if (CURSOR_TERMINAL_METHODS.has(prop as string)) {
					return async (...args: unknown[]) => {
						await maybePark()
						return (value as (...a: unknown[]) => unknown).apply(target, args)
					}
				}
				return (value as (...a: unknown[]) => unknown).bind(target)
			},
		}) as unknown as FindCursor<Document>
	}

	function wrapCollection(real: Collection<Document>): Collection<Document> {
		return new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (prop === "find" && typeof value === "function") {
					return (...args: unknown[]) =>
						wrapCursor(
							(value as (...a: unknown[]) => FindCursor<Document>).apply(
								target,
								args,
							),
						)
				}
				if (prop === "deleteMany" && typeof value === "function") {
					return async (...args: unknown[]) => {
						await maybePark()
						return (value as (...a: unknown[]) => unknown).apply(target, args)
					}
				}
				if (typeof value === "function") {
					return (value as (...a: unknown[]) => unknown).bind(target)
				}
				return value
			},
		}) as unknown as Collection<Document>
	}

	const wrapped = new Proxy(realDb, {
		get(target, prop, receiver) {
			if (prop === "collection") {
				return (name: string) =>
					name === collectionName
						? wrapCollection(target.collection(name))
						: target.collection(name)
			}
			return Reflect.get(target, prop, receiver)
		},
	}) as Db

	return {
		db: wrapped,
		latch: {
			parked,
			release: () => {
				openGate()
			},
		},
	}
}

// ---------------------------------------------------------------------------
// Fault-injection park latch (T2b and later fault-injected cases)
// ---------------------------------------------------------------------------

/**
 * A queued fault: fires ONCE on the first matching wrapped call AFTER the
 * latch has been released. Pre-release calls always pass through — the
 * parked attempt's begin/takeover gate reads must not be disturbed.
 */
type QueuedFault = {
	collection: string
	method: string
	error: Error
	/**
	 * deleteMany-only (F8b commit-ambiguous): perform the REAL delete
	 * WITHOUT the session — the effect lands immediately and survives the
	 * caller's transaction abort — and then throw `error`. Ignored by
	 * other wrapped methods.
	 */
	deleteFirst?: boolean
}

/**
 * Park latch with per-call fault injection. Three modes:
 *
 * - park + parkError: the FIRST parkable operation (find cursor terminal
 *   or deleteMany) on `parkCollection` parks; on release it REJECTS with
 *   `parkError` instead of executing — the parked attempt observes a
 *   non-conflict failure at its next ordinary read (T2b).
 * - park without parkError: identical park, but the parked op passes
 *   through on release; `afterRelease` faults arm at the release (later
 *   barrier cases).
 * - no park: `afterRelease` faults are armed from construction (T3, and
 *   any case whose attempt runs to settlement without a pause).
 *
 * Each fault in `afterRelease` throws once on the first matching
 * (collection, method) call once armed; everything else passes through to
 * the real database. A plain Error aborts `withTransaction` on the first
 * attempt (the driver never retries the callback, and the fault is
 * consumed exactly once); a transient-LABELED MongoServerError (F8a) makes
 * the driver retry the callback, whose matching call then passes through —
 * again consumed exactly once. `calls` records every wrapped invocation in
 * order (park and fault collections only), so a test can assert on retry
 * and re-read behavior.
 */
function faultDb(
	realDb: Db,
	params: {
		parkCollection?: string
		parkError?: Error
		afterRelease: QueuedFault[]
	},
): {
	db: Db
	latch: ParkLatch
	calls: Array<{ collection: string; method: string }>
} {
	const { parkCollection, parkError, afterRelease } = params
	const pending: QueuedFault[] = afterRelease.map((fault) => ({ ...fault }))
	const calls: Array<{ collection: string; method: string }> = []

	// No park configured: faults arm from construction — there is no
	// parked attempt whose pre-release reads must pass through.
	let armed = parkCollection !== undefined
	let releasedFlag = parkCollection === undefined
	let signalParked: () => void = () => {}
	const parked = new Promise<void>((resolve) => {
		signalParked = resolve
	})
	let openGate: () => void = () => {}
	const released = new Promise<void>((resolve) => {
		openGate = resolve
	})

	function recordCall(collection: string, method: string): void {
		calls.push({ collection, method })
	}

	/**
	 * Parks (once) on the park collection's first parkable op; once
	 * released, the parked op rejects with parkError (if given) or passes
	 * through.
	 */
	async function maybePark(collection: string): Promise<void> {
		if (collection !== parkCollection || !armed) {
			return
		}
		armed = false
		signalParked()
		await released
		if (parkError) {
			throw parkError
		}
	}

	/** Consumes the first queued post-release fault matching this call. */
	function takeFault(
		collection: string,
		method: string,
	): QueuedFault | undefined {
		if (!releasedFlag) {
			return undefined
		}
		const index = pending.findIndex(
			(fault) => fault.collection === collection && fault.method === method,
		)
		if (index < 0) {
			return undefined
		}
		const [fault] = pending.splice(index, 1)
		return fault
	}

	/** Throws the first queued post-release fault matching this call, if any. */
	function throwIfFaulted(collection: string, method: string): void {
		const fault = takeFault(collection, method)
		if (fault) {
			throw fault.error
		}
	}

	function wrapCursor(
		real: FindCursor<Document>,
		collection: string,
	): FindCursor<Document> {
		return new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (typeof value !== "function") {
					return value
				}
				if (CURSOR_CHAIN_METHODS.has(prop as string)) {
					return (...args: unknown[]) =>
						wrapCursor(
							(value as (...a: unknown[]) => FindCursor<Document>).apply(
								target,
								args,
							),
							collection,
						)
				}
				if (CURSOR_TERMINAL_METHODS.has(prop as string)) {
					return async (...args: unknown[]) => {
						recordCall(collection, "find")
						await maybePark(collection)
						throwIfFaulted(collection, "find")
						return (value as (...a: unknown[]) => unknown).apply(target, args)
					}
				}
				return (value as (...a: unknown[]) => unknown).bind(target)
			},
		}) as unknown as FindCursor<Document>
	}

	function wrapCollection(
		real: Collection<Document>,
		collection: string,
	): Collection<Document> {
		return new Proxy(real, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (prop === "find" && typeof value === "function") {
					return (...args: unknown[]) =>
						wrapCursor(
							(value as (...a: unknown[]) => FindCursor<Document>).apply(
								target,
								args,
							),
							collection,
						)
				}
				// Parkable (MAIN's unfenced sweep park point) and injectable
				// (a fenced batch delete — T3, T5, F8).
				if (prop === "deleteMany" && typeof value === "function") {
					return async (...args: unknown[]) => {
						recordCall(collection, "deleteMany")
						await maybePark(collection)
						const fault = takeFault(collection, "deleteMany")
						if (fault) {
							if (fault.deleteFirst) {
								// F8b commit-ambiguous: the REAL delete runs
								// WITHOUT the session — the effect lands
								// immediately and survives the caller's
								// abort — while the caller observes the
								// error.
								await (value as (...a: unknown[]) => unknown).apply(target, [
									args[0],
								])
							}
							throw fault.error
						}
						return (value as (...a: unknown[]) => unknown).apply(target, args)
					}
				}
				// Injectable single read — readErasureGate's gate read (the
				// partial audit's ownership check, T2b fault 2).
				if (prop === "findOne" && typeof value === "function") {
					return async (...args: unknown[]) => {
						recordCall(collection, "findOne")
						throwIfFaulted(collection, "findOne")
						return (value as (...a: unknown[]) => unknown).apply(target, args)
					}
				}
				if (typeof value === "function") {
					return (value as (...a: unknown[]) => unknown).bind(target)
				}
				return value
			},
		}) as unknown as Collection<Document>
	}

	const wrappedNames = new Set<string>([
		...(parkCollection ? [parkCollection] : []),
		...afterRelease.map((fault) => fault.collection),
	])
	const wrapped = new Proxy(realDb, {
		get(target, prop, receiver) {
			if (prop === "collection") {
				return (name: string) =>
					wrappedNames.has(name)
						? wrapCollection(target.collection(name), name)
						: target.collection(name)
			}
			return Reflect.get(target, prop, receiver)
		},
	}) as Db

	return {
		db: wrapped,
		latch: {
			parked,
			release: () => {
				releasedFlag = true
				openGate()
			},
		},
		calls,
	}
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

beforeAll(async () => {
	client = new MongoClient(URI)
	await client.connect()
	db = client.db(DB_NAME)
}, TIMEOUT)

afterAll(async () => {
	try {
		if (db) {
			await db.dropDatabase()
			const listed = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true, filter: { name: DB_NAME } })
			expect(
				listed.databases.length,
				"disposable database must be absent after teardown",
			).toBe(0)
		}
	} finally {
		await client?.close()
	}
}, TIMEOUT)

// ---------------------------------------------------------------------------
// T2 — RED anchor: displaced attempt vs post-takeover write
// ---------------------------------------------------------------------------

describe("tenant erasure gate — manager boundary (real replica set)", () => {
	it(
		"T2: a displaced erasure attempt cannot delete post-takeover writes or claim ownership",
		async () => {
			const agent = `agent-t2-${randomUUID().slice(0, 8)}`

			// Old tenant data the OLD attempt will legitimately sweep.
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)
			await db.collection(STRUCTURED).insertMany(
				["seed-a", "seed-b"].map((content) => ({
					agentId: agent,
					content,
					createdAt: new Date(),
				})),
			)

			// OLD attempt — the real manager facade (drain included) over a
			// latch-wrapped db; parks on the first parkable events op (MAIN:
			// the unfenced deleteMany; grant: the between-batches id-fetch).
			const old = latchDb(db, EVENTS)
			const oldAttempt = erasureEntry(tenantManager(agent, old.db))()

			// G4: race the park against the attempt settling — a pre-park
			// error surfaces here instead of hanging to the test timeout.
			const firstSignal = await Promise.race([
				old.latch.parked.then(() => ({ kind: "parked" as const })),
				oldAttempt.then(
					(receipt) => ({ kind: "settled" as const, receipt }),
					(error) => ({ kind: "failed" as const, error }),
				),
			])
			if (firstSignal.kind === "failed") {
				throw firstSignal.error
			}
			if (firstSignal.kind === "settled") {
				throw new Error(
					`old erasure attempt settled before parking on ${EVENTS}: ` +
						JSON.stringify(firstSignal.receipt),
				)
			}

			// G2: everything from here to the finally runs while the old
			// attempt is parked, and the finally releases the latch and
			// settles the attempt even when a step below throws — otherwise
			// the parked attempt burns the full test timeout and afterAll
			// drops the database under a still-pending attempt, and the RED
			// run reports a timeout instead of the discriminator rows.
			let oldOutcome: PromiseSettledResult<TenantErasureReceipt>
			try {
				// SUCCESSOR — deliberate recovery through the manager
				// boundary. On the grant recovery threads to the engine and
				// dispatches to takeoverErasure DIRECTLY (open/absent/raced
				// gates are typed conflicts, never a fresh begin).
				const successor = await erasureEntry(tenantManager(agent, db))({
					recovery: "takeover",
				})
				expect(successor.status).toBe("complete")

				// Fresh post-takeover write — the REAL public writer:
				// admission is captured at the call boundary and the event +
				// extraction job persist through the fenced write path.
				const fresh = await tenantManager(agent, db).writeConversationEvent({
					role: "user",
					body: "fresh post-takeover tenant write",
					scope: "agent",
				})
				const freshRow = await db
					.collection(EVENTS)
					.findOne({ eventId: fresh.eventId, agentId: agent })
				expect(freshRow).not.toBeNull()
				expect(
					await db.collection(EVENTS).countDocuments({ agentId: agent }),
					"exactly the fresh post-takeover write remains while the old attempt is parked",
				).toBe(1)
			} finally {
				// Displace the old attempt past the takeover — always.
				old.latch.release()
				oldOutcome = await oldAttempt.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
			}

			if (oldOutcome.status === "rejected") {
				throw oldOutcome.reason
			}
			const oldReceipt = oldOutcome.value as TenantErasureReceipt & {
				ownershipLost?: boolean
				gateState?: string
			}

			// Headline row 1 (RED on MAIN) — irreversible-effect invariant:
			// the fresh post-takeover write must survive the displaced attempt.
			expect
				.soft(
					await db.collection(EVENTS).countDocuments({ agentId: agent }),
					"fresh post-takeover write must survive the displaced attempt",
				)
				.toBe(1)

			// Headline row 2 (RED on MAIN) — receipt honesty: the displaced
			// attempt reports ownership loss. The status assertion passes on
			// MAIN for the wrong reason (residual detection, not ownership
			// loss); ownershipLost is the discriminating component.
			expect.soft(oldReceipt.status).toBe("partial")
			expect.soft(oldReceipt.ownershipLost).toBe(true)

			// F2 honesty: no gateState claim — the displaced owner cannot
			// prove the gate's true state, so it must not assert one.
			expect(oldReceipt.gateState).toBeUndefined()

			// The gate is left open by the successor's finalize; the
			// displaced attempt must not re-close or re-own it. (This reads
			// the PARSED gate doc — erase is present only while state is
			// erasing — so it pins the parsed contract.)
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("open")
			expect(gate?.erase).toBeUndefined()
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T1 — admission closed for the whole erasure window (inv 1)
	// -------------------------------------------------------------------------

	it(
		"T1: admission stays closed while an erasure owns the gate; completion reopens only via the attempt's own finalize",
		async () => {
			const agent = `agent-t1-${randomUUID().slice(0, 8)}`

			// Seed tenant rows across the sweep's path, INCLUDING both
			// diagnostic sinks. On a fresh deployment both sinks are ordinary
			// collections (verified initializer bytes) — the pinned branch
			// (F10 probe, §8): the fenced sweep covers them uniformly and no
			// time-series fail-closed branch may fire here.
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)
			await db.collection(STRUCTURED).insertMany(
				["seed-a", "seed-b"].map((content) => ({
					agentId: agent,
					content,
					createdAt: new Date(),
				})),
			)
			await db.collection(TELEMETRY).insertMany(
				[1, 2, 3].map((ms) => ({
					meta: { agentId: agent },
					ts: new Date(),
					ms,
				})),
			)
			await db.collection(ACCESS_EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					meta: { agentId: agent },
					ts: new Date(),
					op: `seed-op-${i}`,
				})),
			)

			// Pinned branch (F10 probe): both sinks are ORDINARY collections
			// on this fresh database — type "collection", not "timeseries".
			for (const sink of [TELEMETRY, ACCESS_EVENTS]) {
				const [info] = await db
					.listCollections({ name: sink }, { nameOnly: false })
					.toArray()
				expect(info?.type ?? "collection", `${sink} must be ordinary`).toBe(
					"collection",
				)
			}

			// Park the attempt mid-sweep on the events id-fetch — the grant
			// park point (between fenced batches, no transaction open), the
			// same one-shot latch as T2.
			const latched = latchDb(db, EVENTS)
			const attempt = erasureEntry(tenantManager(agent, latched.db))()
			const firstSignal = await Promise.race([
				latched.latch.parked.then(() => ({ kind: "parked" as const })),
				attempt.then(
					(receipt) => ({ kind: "settled" as const, receipt }),
					(error) => ({ kind: "failed" as const, error }),
				),
			])
			if (firstSignal.kind === "failed") {
				throw firstSignal.error
			}
			if (firstSignal.kind === "settled") {
				throw new Error(
					`erasure attempt settled before parking on ${EVENTS}: ` +
						JSON.stringify(firstSignal.receipt),
				)
			}

			let outcome: PromiseSettledResult<TenantErasureReceipt>
			try {
				// While the parked attempt owns it, the gate is erasing.
				const midGate = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agent,
				})
				expect(midGate?.state).toBe("erasing")
				expect(midGate?.erase?.runId).toBeTruthy()

				// Admission is CLOSED for the whole window: the REAL public
				// writer rejects with the typed gate conflict — the error the
				// API write route's existing 409 mapping consumes (the
				// route-level translation is covered by the app suites; this
				// suite pins the typed error at the manager boundary).
				await expect(
					tenantManager(agent, db).writeConversationEvent({
						role: "user",
						body: "must not be admitted mid-erasure",
						scope: "agent",
					}),
				).rejects.toSatisfy(isErasureGateConflictError)

				// The raw admission primitive rejects as well.
				await expect(
					captureAdmissionToken({ db, prefix: PREFIX, agentId: agent }),
				).rejects.toSatisfy(isErasureGateConflictError)
			} finally {
				// G2: always release the latch and settle the attempt — a
				// thrown assertion above must not park it to the timeout.
				latched.latch.release()
				outcome = await attempt.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
			}
			if (outcome.status === "rejected") {
				throw outcome.reason
			}
			const receipt = outcome.value

			// Release → complete: every fenced batch succeeded, both
			// verification stages were clean, the proof-of-erasure audit was
			// written, and the attempt's OWN finalize reopened the gate —
			// gateState "open" is established only there.
			expect(receipt.status).toBe("complete")
			expect(receipt.gateState).toBe("open")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.epochError).toBeUndefined()
			expect(receipt.ownershipLost).toBeUndefined()
			expect(receipt.verification?.residual ?? []).toHaveLength(0)

			// Both diagnostic sinks were swept by the FENCED sweep (pinned
			// branch): their seeded rows are gone.
			expect(
				await db
					.collection(TELEMETRY)
					.countDocuments({ "meta.agentId": agent }),
			).toBe(0)
			expect(
				await db
					.collection(ACCESS_EVENTS)
					.countDocuments({ "meta.agentId": agent }),
			).toBe(0)

			// The rest of the seeded tenant data is gone.
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(0)
			expect(
				await db.collection(STRUCTURED).countDocuments({ agentId: agent }),
			).toBe(0)

			// The gate is open with no erase record, and the proof-of-erasure
			// audit row — written INSIDE finalize, after the memory_mutations
			// sweep had already passed — survived the erase as the durable
			// receipt.
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("open")
			expect(gate?.erase).toBeUndefined()
			expect(receipt.mutationId).toBeTruthy()
			expect(
				await db.collection(MUTATIONS).countDocuments({
					agentId: agent,
					"meta.status": "complete",
					"meta.runId": receipt.runId,
				}),
			).toBe(1)

			// Post-finalize fresh write succeeds: the new generation is
			// admitted and lands.
			const fresh = await tenantManager(agent, db).writeConversationEvent({
				role: "user",
				body: "fresh post-erasure write",
				scope: "agent",
			})
			expect(
				await db
					.collection(EVENTS)
					.countDocuments({ eventId: fresh.eventId, agentId: agent }),
			).toBe(1)
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T2b — C-1 audit-evidence discriminator (fault-injected)
	// -------------------------------------------------------------------------

	it(
		"T2b: an unacknowledged partial audit omits gateState — begin success and an unobserved conflict are not ownership evidence (C-1)",
		async () => {
			const agent = `agent-t2b-${randomUUID().slice(0, 8)}`

			// Old tenant data: events rows the OLD attempt sweeps BEFORE
			// parking (it still owns the gate then), and access_events rows —
			// access_events is the LAST sweep target, so the old attempt parks
			// on its id-fetch and these survive for the successor to sweep.
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)
			await db.collection(ACCESS_EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					meta: { agentId: agent },
					ts: new Date(),
					op: `seed-op-${i}`,
				})),
			)

			// OLD attempt over the fault latch: it parks on the access_events
			// id-fetch (between fenced batches, no transaction open). On
			// release, that read rejects with fault 1 (non-conflict — the old
			// attempt lands on the partial path WITHOUT observing the
			// successor's conflict; the sweep loop ends at its last target, so
			// no later fenced write can observe it either), and the partial
			// audit's gate read on meta rejects with fault 2 (non-conflict —
			// the audit cannot confirm ownership).
			const barrier = faultDb(db, {
				parkCollection: ACCESS_EVENTS,
				parkError: new Error(
					"injected access_events id-fetch failure (non-conflict)",
				),
				afterRelease: [
					{
						collection: META,
						method: "findOne",
						error: new Error(
							"injected partial-audit gate read failure (non-conflict)",
						),
					},
				],
			})
			const oldAttempt = erasureEntry(tenantManager(agent, barrier.db))()

			// G4: race the park against the attempt settling.
			const firstSignal = await Promise.race([
				barrier.latch.parked.then(() => ({ kind: "parked" as const })),
				oldAttempt.then(
					(receipt) => ({ kind: "settled" as const, receipt }),
					(error) => ({ kind: "failed" as const, error }),
				),
			])
			if (firstSignal.kind === "failed") {
				throw firstSignal.error
			}
			if (firstSignal.kind === "settled") {
				throw new Error(
					`old erasure attempt settled before parking on ${ACCESS_EVENTS}: ` +
						JSON.stringify(firstSignal.receipt),
				)
			}

			// G2: release and settle in the finally, always.
			let oldOutcome: PromiseSettledResult<TenantErasureReceipt>
			let successorRunId: string | undefined
			try {
				// While parked, the old attempt owns the gate.
				const midGate = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agent,
				})
				expect(midGate?.state).toBe("erasing")
				expect(midGate?.erase?.runId).toBeTruthy()

				// SUCCESSOR — deliberate recovery over the real db; it
				// replaces the old run, sweeps the surviving access_events
				// rows, verifies, and finalizes (gate open).
				const successor = await erasureEntry(tenantManager(agent, db))({
					recovery: "takeover",
				})
				expect(successor.status).toBe("complete")
				expect(successor.gateState).toBe("open")
				expect(successor.runId).toBeTruthy()
				expect(successor.mutationId).toBeTruthy()
				successorRunId = successor.runId
			} finally {
				barrier.latch.release()
				oldOutcome = await oldAttempt.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
			}
			if (oldOutcome.status === "rejected") {
				throw oldOutcome.reason
			}
			const oldReceipt = oldOutcome.value

			// The displaced attempt never observed the successor: its next
			// ordinary read failed first and its partial audit's gate read
			// failed too. C-1: begin/takeover success and an unobserved
			// conflict are NOT ownership evidence — the receipt is partial
			// with runId + auditError, gateState OMITTED (the true state is
			// open and must not be claimed "erasing"), ownershipLost ABSENT
			// (no conflict was observed), and no finalizeIndeterminate (this
			// path never finalized).
			expect(oldReceipt.status).toBe("partial")
			expect(oldReceipt.runId).toBeTruthy()
			expect(oldReceipt.auditError).toContain(
				"injected partial-audit gate read failure",
			)
			expect(oldReceipt.gateState).toBeUndefined()
			expect(oldReceipt.ownershipLost).toBeUndefined()
			expect(oldReceipt.finalizeIndeterminate).toBeUndefined()

			// The sweep failure that forced the partial is the injected
			// access_events id-fetch read (fault 1).
			const accessReceipt = oldReceipt.receipts.find(
				(receipt) => receipt.collection === "access_events",
			)
			expect(accessReceipt?.error).toContain(
				"injected access_events id-fetch failure",
			)

			// Stage-1 verification DID run (expected on the partial path —
			// not a post-loss scan) and surfaced the successor's durable
			// audit row as residual: honest partial evidence, never a
			// completion claim.
			expect(oldReceipt.verification?.residual ?? []).toContainEqual({
				collection: "memory_mutations",
				count: 1,
			})

			// No extra reads after the failed audit: the last wrapped calls
			// are the parked access_events find (fault 1) then the audit's
			// meta gate read (fault 2); nothing follows the audit failure.
			expect(barrier.calls.slice(-2)).toEqual([
				{ collection: ACCESS_EVENTS, method: "find" },
				{ collection: META, method: "findOne" },
			])

			// The unacknowledged audit was never persisted: the ONLY durable
			// audit row for this agent is the successor's complete one.
			expect(successorRunId).toBeTruthy()
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.status": "partial" }),
			).toBe(0)
			expect(
				await db.collection(MUTATIONS).countDocuments({
					agentId: agent,
					"meta.status": "complete",
					"meta.runId": successorRunId,
				}),
			).toBe(1)

			// The successor's complete receipt and the open gate stand.
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("open")
			expect(gate?.erase).toBeUndefined()
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T3 — partial stays closed (inv 3) + begin-failure sub-case
	// -------------------------------------------------------------------------

	it(
		"T3: an injected batch failure ends the attempt partial while STILL OWNING the gate — gateState erasing, admissions closed, recovery then completes",
		async () => {
			const agent = `agent-t3-${randomUUID().slice(0, 8)}`

			// Tenant data: events (whose fenced batch delete fails) and
			// structured (swept normally — a failed collection ends only
			// that collection, never the whole sweep).
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)
			await db.collection(STRUCTURED).insertMany(
				["seed-a", "seed-b"].map((content) => ({
					agentId: agent,
					content,
					createdAt: new Date(),
				})),
			)

			// No park: the attempt runs to settlement with ONE injected
			// non-conflict fault on the events fenced batch delete.
			const barrier = faultDb(db, {
				afterRelease: [
					{
						collection: EVENTS,
						method: "deleteMany",
						error: new Error(
							"injected fenced batch delete failure (non-conflict)",
						),
					},
				],
			})

			const receipt = await erasureEntry(tenantManager(agent, barrier.db))()

			// Still-owned partial (F2-corrected): the fenced partial audit
			// ACKNOWLEDGED — its own transaction re-validated ownership —
			// so the receipt may cite gateState "erasing" and its runId.
			expect(receipt.status).toBe("partial")
			expect(receipt.gateState).toBe("erasing")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.mutationId).toBeTruthy()
			expect(receipt.epochError).toBeUndefined()
			expect(receipt.ownershipLost).toBeUndefined()
			expect(receipt.auditError).toBeUndefined()
			expect(receipt.finalizeIndeterminate).toBeUndefined()

			// The events failure is named on its receipt; structured swept
			// normally despite it.
			const eventsReceipt = receipt.receipts.find(
				(entry) => entry.collection === "events",
			)
			expect(eventsReceipt?.error).toContain(
				"injected fenced batch delete failure",
			)
			expect(eventsReceipt?.deleted).toBe(0)
			expect(
				receipt.receipts.find((entry) => entry.collection === "structured_mem"),
			).toEqual({ collection: "structured_mem", deleted: 2 })

			// Stage-1 verification surfaced the un-deleted events rows as
			// residual — the reason "partial" is honest.
			expect(receipt.verification?.residual ?? []).toContainEqual({
				collection: "events",
				count: 3,
			})

			// The gate is STILL erasing under this attempt's run (no
			// reopen, no complete-audit): a direct gate read asserts it,
			// and admissions stay closed.
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("erasing")
			expect(gate?.erase?.runId).toBe(receipt.runId)
			await expect(
				captureAdmissionToken({ db, prefix: PREFIX, agentId: agent }),
			).rejects.toSatisfy(isErasureGateConflictError)
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.status": "complete" }),
			).toBe(0)
			expect(
				await db.collection(MUTATIONS).countDocuments({
					agentId: agent,
					"meta.status": "partial",
					"meta.runId": receipt.runId,
				}),
			).toBe(1)

			// Deliberate recovery completes the stuck erasing gate: it
			// takes over the run, sweeps the residual rows (including the
			// first attempt's partial audit row — memory_mutations is a
			// sweep target), verifies clean, and finalizes.
			const recovery = await erasureEntry(tenantManager(agent, db))({
				recovery: "takeover",
			})
			expect(recovery.status).toBe("complete")
			expect(recovery.gateState).toBe("open")
			expect(recovery.runId).toBeTruthy()
			expect(recovery.runId).not.toBe(receipt.runId)
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(0)
			expect(
				await db.collection(STRUCTURED).countDocuments({ agentId: agent }),
			).toBe(0)
			const finalGate = await readErasureGate({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			expect(finalGate?.state).toBe("open")
			expect(finalGate?.erase).toBeUndefined()
		},
		TIMEOUT,
	)

	it(
		"T3 begin-failure sub-case: a non-conflict begin error yields a receipt with runId and gateState BOTH absent and no deletes run",
		async () => {
			const agent = `agent-t3-begin-${randomUUID().slice(0, 8)}`

			// Seeded rows that must SURVIVE: a failed gate entry means no
			// token and NO deletes ran.
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			// No park: the very first meta read of beginErasure (the
			// session-bound gate findOne) rejects with a non-conflict
			// error, before any gate write.
			const barrier = faultDb(db, {
				afterRelease: [
					{
						collection: META,
						method: "findOne",
						error: new Error("injected begin gate read failure (non-conflict)"),
					},
				],
			})

			const receipt = await erasureEntry(tenantManager(agent, barrier.db))()

			// Gate-entry failure: epochError only — nothing about the gate
			// is proven from this seat, so runId AND gateState are both
			// omitted, no audit row exists, and no deletes ran.
			expect(receipt.status).toBe("partial")
			expect(receipt.epochError).toContain("injected begin gate read failure")
			expect(receipt.runId).toBeUndefined()
			expect(receipt.gateState).toBeUndefined()
			expect(receipt.mutationId).toBeUndefined()
			expect(receipt.ownershipLost).toBeUndefined()
			expect(receipt.finalizeIndeterminate).toBeUndefined()
			expect(receipt.receipts).toHaveLength(0)
			expect(
				await db.collection(MUTATIONS).countDocuments({ agentId: agent }),
			).toBe(0)
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(3)

			// The begin failed before any gate write: no gate document
			// exists for this agent at all.
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate).toBeNull()
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T4 — no auto reacquisition (inv 4)
	// -------------------------------------------------------------------------

	it(
		"T4: a displaced attempt aborts at its next fence check with NO auto reacquisition — ownershipLost, no gateState claim, gate untouched",
		async () => {
			const agent = `agent-t4-${randomUUID().slice(0, 8)}`

			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			// OLD attempt — parks on the events id-fetch (between fenced
			// batches, no transaction open). No injected faults: the
			// displacement itself produces the conflict at the next fence
			// check.
			const old = latchDb(db, EVENTS)
			const oldAttempt = erasureEntry(tenantManager(agent, old.db))()

			// G4: race the park against the attempt settling.
			const firstSignal = await Promise.race([
				old.latch.parked.then(() => ({ kind: "parked" as const })),
				oldAttempt.then(
					(receipt) => ({ kind: "settled" as const, receipt }),
					(error) => ({ kind: "failed" as const, error }),
				),
			])
			if (firstSignal.kind === "failed") {
				throw firstSignal.error
			}
			if (firstSignal.kind === "settled") {
				throw new Error(
					`old erasure attempt settled before parking on ${EVENTS}: ` +
						JSON.stringify(firstSignal.receipt),
				)
			}

			// G2: release and settle in the finally, always.
			let oldOutcome: PromiseSettledResult<TenantErasureReceipt>
			let successorRunId: string | undefined
			let midRunId: string | undefined
			let beforeAbort: Record<string, unknown> | null
			try {
				// The old attempt owns the gate while parked.
				const midGate = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agent,
				})
				expect(midGate?.state).toBe("erasing")
				midRunId = midGate?.erase?.runId

				// EXTERNAL takeover while paused — the successor completes
				// and reopens the gate.
				const successor = await erasureEntry(tenantManager(agent, db))({
					recovery: "takeover",
				})
				expect(successor.status).toBe("complete")
				expect(successor.gateState).toBe("open")
				expect(successor.runId).toBeTruthy()
				successorRunId = successor.runId

				// Raw gate doc immediately after the successor: the abort
				// below must leave it byte-for-byte untouched.
				beforeAbort = await db.collection(META).findOne({ agentId: agent })
				expect(beforeAbort?.state).toBe("open")
			} finally {
				old.latch.release()
				oldOutcome = await oldAttempt.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
			}
			if (oldOutcome.status === "rejected") {
				throw oldOutcome.reason
			}
			const oldReceipt = oldOutcome.value

			// The displaced attempt aborted at its next fence check (the
			// resumed id-fetch ran, the fenced batch conflicted on the
			// open gate): partial with ownershipLost:true and its OWN
			// displaced runId, NO gateState claim (F2: the true state is
			// open — never claim "erasing"), no finalizeIndeterminate, no
			// auditError, no epochError.
			expect(oldReceipt.status).toBe("partial")
			expect(oldReceipt.ownershipLost).toBe(true)
			expect(oldReceipt.runId).toBeTruthy()
			expect(oldReceipt.runId).toBe(midRunId)
			expect(oldReceipt.runId).not.toBe(successorRunId)
			expect(oldReceipt.gateState).toBeUndefined()
			expect(oldReceipt.finalizeIndeterminate).toBeUndefined()
			expect(oldReceipt.auditError).toBeUndefined()
			expect(oldReceipt.epochError).toBeUndefined()

			// No auto reacquisition: the abort performed NO gate writes —
			// epoch, serial, and updatedAt are unchanged, the gate is
			// still open with no erase record (a re-begin or re-takeover
			// would have written one of them).
			const afterAbort = await db.collection(META).findOne({ agentId: agent })
			expect(afterAbort?.state).toBe("open")
			expect(afterAbort?.erase).toBeUndefined()
			expect(afterAbort?.epoch).toBe(beforeAbort?.epoch)
			expect(afterAbort?.serial).toBe(beforeAbort?.serial)
			expect(afterAbort?.updatedAt).toEqual(beforeAbort?.updatedAt)

			// The terminal abort wrote no audit row for the displaced run;
			// the successor's complete receipt stands.
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.runId": oldReceipt.runId }),
			).toBe(0)
			expect(successorRunId).toBeTruthy()
			expect(
				await db.collection(MUTATIONS).countDocuments({
					agentId: agent,
					"meta.status": "complete",
					"meta.runId": successorRunId,
				}),
			).toBe(1)

			// The successor's data outcome stands: the seeded rows are gone
			// (the aborted attempt deleted nothing after losing ownership).
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(0)
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T5a — W02 observed live: children before parents (inv 5)
	// -------------------------------------------------------------------------

	it(
		"T5a (W02): relevance_artifacts sweeps BEFORE the relevance_runs parents are deleted — observed live from a mid-sweep barrier",
		async () => {
			const agent = `agent-t5a-${randomUUID().slice(0, 8)}`

			// Two parent runs, each with two LEGACY artifact children keyed
			// by runId alone (no agentId — reachable ONLY through their
			// parent), plus events rows so phase 2 has real work.
			await db.collection(RUNS).insertMany(
				[1, 2].map((i) => ({
					agentId: agent,
					runId: `run-${i}`,
					status: "done",
					createdAt: new Date(),
				})),
			)
			await db.collection(ARTIFACTS).insertMany(
				[1, 2].flatMap((run) =>
					["a", "b"].map((tag) => ({
						runId: `run-${run}`,
						kind: `artifact-${tag}`,
						createdAt: new Date(),
					})),
				),
			)
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			// The ordering observation parks on the EVENTS id-fetch — the
			// FIRST phase-2 read. (A latch on relevance_runs itself would
			// park phase 1's id-collection find, which runs BEFORE the
			// artifact sweep and observes nothing about ordering.) At this
			// park point the artifact sweep (phase 1.5) has already
			// committed while the relevance_runs parents are ALL still
			// present — children-before-parents observed LIVE.
			const latched = latchDb(db, EVENTS)
			const attempt = erasureEntry(tenantManager(agent, latched.db))()
			const firstSignal = await Promise.race([
				latched.latch.parked.then(() => ({ kind: "parked" as const })),
				attempt.then(
					(receipt) => ({ kind: "settled" as const, receipt }),
					(error) => ({ kind: "failed" as const, error }),
				),
			])
			if (firstSignal.kind === "failed") {
				throw firstSignal.error
			}
			if (firstSignal.kind === "settled") {
				throw new Error(
					`erasure attempt settled before parking on ${EVENTS}: ` +
						JSON.stringify(firstSignal.receipt),
				)
			}

			// G2: release and settle in the finally, always.
			let outcome: PromiseSettledResult<TenantErasureReceipt>
			try {
				// W02 observed live: the legacy artifact children are GONE
				// (swept via their parent run ids in phase 1.5) while the
				// relevance_runs parents are ALL still present (phase 2 has
				// not reached them — parents sweep only AFTER children).
				expect(
					await db
						.collection(ARTIFACTS)
						.countDocuments({ runId: { $in: ["run-1", "run-2"] } }),
				).toBe(0)
				expect(
					await db.collection(RUNS).countDocuments({ agentId: agent }),
				).toBe(2)
			} finally {
				latched.latch.release()
				outcome = await attempt.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
			}
			if (outcome.status === "rejected") {
				throw outcome.reason
			}
			const receipt = outcome.value

			// Release → complete: children AND parents swept, both
			// verification stages clean, the attempt's own finalize
			// reopened the gate.
			expect(receipt.status).toBe("complete")
			expect(receipt.gateState).toBe("open")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.verification?.residual ?? []).toHaveLength(0)
			expect(
				receipt.receipts.find(
					(entry) => entry.collection === "relevance_artifacts",
				)?.deleted,
			).toBe(4)
			expect(
				receipt.receipts.find((entry) => entry.collection === "relevance_runs")
					?.deleted,
			).toBe(2)
			expect(
				await db
					.collection(ARTIFACTS)
					.countDocuments({ runId: { $in: ["run-1", "run-2"] } }),
			).toBe(0)
			expect(await db.collection(RUNS).countDocuments({ agentId: agent })).toBe(
				0,
			)
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(0)
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("open")
			expect(gate?.erase).toBeUndefined()
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T5b — W02 retention: artifact failure retains the parents; recovery
	// resolves children first (inv 5)
	// -------------------------------------------------------------------------

	it(
		"T5b (W02): an artifact batch failure retains relevance_runs, explains the retention, and ends partial — recovery then resolves the children FIRST and completes",
		async () => {
			const agent = `agent-t5b-${randomUUID().slice(0, 8)}`

			await db.collection(RUNS).insertMany(
				[1, 2].map((i) => ({
					agentId: agent,
					runId: `run-${i}`,
					status: "done",
					createdAt: new Date(),
				})),
			)
			await db.collection(ARTIFACTS).insertMany(
				[1, 2].flatMap((run) =>
					["a", "b"].map((tag) => ({
						runId: `run-${run}`,
						kind: `artifact-${tag}`,
						createdAt: new Date(),
					})),
				),
			)

			// No park: the fault arms from construction. The artifact batch
			// delete fails with a plain (non-conflict) error — an attempt
			// that could not resolve the children must NEVER delete their
			// parents.
			const barrier = faultDb(db, {
				afterRelease: [
					{
						collection: ARTIFACTS,
						method: "deleteMany",
						error: new Error("injected artifact batch failure (non-conflict)"),
					},
				],
			})
			const receipt = await erasureEntry(tenantManager(agent, barrier.db))()

			// Partial, STILL OWNING: the partial audit acknowledged →
			// gateState "erasing", runId + mutationId present, no loss, no
			// audit error.
			expect(receipt.status).toBe("partial")
			expect(receipt.gateState).toBe("erasing")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.mutationId).toBeTruthy()
			expect(receipt.ownershipLost).toBeUndefined()
			expect(receipt.auditError).toBeUndefined()
			expect(receipt.epochError).toBeUndefined()

			// The artifact receipt carries the injected failure.
			const artifactReceipt = receipt.receipts.find(
				(entry) => entry.collection === "relevance_artifacts",
			)
			expect(artifactReceipt?.deleted).toBe(0)
			expect(artifactReceipt?.error).toContain(
				"injected artifact batch failure",
			)

			// The parents were RETAINED: relevance_runs stayed OUT of the
			// sweep, its receipt explains WHY, and the rows survive for the
			// retry to re-resolve their children.
			const runsReceipt = receipt.receipts.find(
				(entry) => entry.collection === "relevance_runs",
			)
			expect(runsReceipt?.deleted).toBe(0)
			expect(runsReceipt?.error).toContain("retained for artifact retry")
			expect(await db.collection(RUNS).countDocuments({ agentId: agent })).toBe(
				2,
			)
			// The failed batch left the children in place too.
			expect(
				await db
					.collection(ARTIFACTS)
					.countDocuments({ runId: { $in: ["run-1", "run-2"] } }),
			).toBe(4)

			// Stage-1 surfaced the surviving children as residual (the
			// retained parents are expected survivors, excluded from the
			// check) — honest partial evidence.
			expect(receipt.verification?.residual ?? []).toContainEqual({
				collection: "relevance_artifacts",
				count: 4,
			})

			// Recovery: the next attempt re-resolves the children from the
			// RETAINED parents (phase 1), sweeps them FIRST (phase 1.5),
			// then deletes the parents (phase 2) — and completes.
			const recovery = await erasureEntry(tenantManager(agent, db))({
				recovery: "takeover",
			})
			expect(recovery.status).toBe("complete")
			expect(recovery.gateState).toBe("open")
			expect(recovery.runId).toBeTruthy()
			expect(recovery.verification?.residual ?? []).toHaveLength(0)
			expect(
				recovery.receipts.find(
					(entry) => entry.collection === "relevance_artifacts",
				)?.deleted,
			).toBe(4)
			expect(
				recovery.receipts.find((entry) => entry.collection === "relevance_runs")
					?.deleted,
			).toBe(2)
			expect(
				await db
					.collection(ARTIFACTS)
					.countDocuments({ runId: { $in: ["run-1", "run-2"] } }),
			).toBe(0)
			expect(await db.collection(RUNS).countDocuments({ agentId: agent })).toBe(
				0,
			)
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("open")
			expect(gate?.erase).toBeUndefined()
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T5c — mid-erase resurrection caught by verification (inv 5)
	// -------------------------------------------------------------------------

	it(
		"T5c: an unfenced resurrection mid-erase is caught by stage-1 verification — partial, no finalize, the gate stays erasing",
		async () => {
			const agent = `agent-t5c-${randomUUID().slice(0, 8)}`

			// events rows (swept before the park point) and access_events
			// rows — access_events is the LAST sweep target, so the attempt
			// parks on its id-fetch with every earlier target already gone.
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)
			await db.collection(ACCESS_EVENTS).insertMany(
				[1, 2].map((i) => ({
					meta: { agentId: agent },
					ts: new Date(),
					op: `seed-op-${i}`,
				})),
			)

			const latched = latchDb(db, ACCESS_EVENTS)
			const attempt = erasureEntry(tenantManager(agent, latched.db))()
			const firstSignal = await Promise.race([
				latched.latch.parked.then(() => ({ kind: "parked" as const })),
				attempt.then(
					(receipt) => ({ kind: "settled" as const, receipt }),
					(error) => ({ kind: "failed" as const, error }),
				),
			])
			if (firstSignal.kind === "failed") {
				throw firstSignal.error
			}
			if (firstSignal.kind === "settled") {
				throw new Error(
					`erasure attempt settled before parking on ${ACCESS_EVENTS}: ` +
						JSON.stringify(firstSignal.receipt),
				)
			}

			// G2: release and settle in the finally, always.
			let outcome: PromiseSettledResult<TenantErasureReceipt>
			try {
				// While the attempt is parked on the LAST target's id-fetch,
				// an UNFENCED write resurrects a row into events — a
				// collection the sweep has already passed. Only the
				// post-sweep recount can catch it.
				await db.collection(EVENTS).insertOne({
					agentId: agent,
					kind: "resurrected",
					ts: new Date(),
				})
			} finally {
				latched.latch.release()
				outcome = await attempt.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
			}
			if (outcome.status === "rejected") {
				throw outcome.reason
			}
			const receipt = outcome.value

			// Partial: stage-1 counted the resurrected row as residual —
			// the attempt may NOT claim completion over data that appeared
			// after its sweep passed.
			expect(receipt.status).toBe("partial")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.mutationId).toBeTruthy()
			expect(receipt.ownershipLost).toBeUndefined()
			expect(receipt.auditError).toBeUndefined()
			expect(receipt.verification?.residual ?? []).toContainEqual({
				collection: "events",
				count: 1,
			})

			// The sweep itself finished its last target normally — the
			// residual is the resurrection, not a sweep failure.
			const accessReceipt = receipt.receipts.find(
				(entry) => entry.collection === "access_events",
			)
			expect(accessReceipt?.deleted).toBe(2)
			expect(accessReceipt?.error).toBeUndefined()

			// STILL OWNING the gate (the partial audit acknowledged) →
			// gateState "erasing"; NO finalize: the gate keeps erasing and
			// no complete audit row exists.
			expect(receipt.gateState).toBe("erasing")
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("erasing")
			expect(gate?.erase?.runId).toBe(receipt.runId)
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.status": "complete" }),
			).toBe(0)
			expect(
				await db.collection(MUTATIONS).countDocuments({
					agentId: agent,
					"meta.status": "partial",
					"meta.runId": receipt.runId,
				}),
			).toBe(1)

			// The resurrected row itself survives the attempt: the engine
			// REPORTS it for the next attempt; it never chases post-sweep
			// rows with unfenced deletes.
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(1)
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// F8a — transient batch failure retries inside the driver and counts
	// the batch exactly once
	// -------------------------------------------------------------------------

	it(
		"F8a: a transient-labeled batch failure retries INSIDE withTransaction — the retry commits and the per-collection delta counts the batch exactly ONCE",
		async () => {
			const agent = `agent-f8a-${randomUUID().slice(0, 8)}`

			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			// Transient-LABELED fault: withTransaction sees the
			// TransientTransactionError label, aborts the transaction, and
			// RETRIES the whole callback. The fault was consumed exactly
			// once, so the retry's deleteMany passes through to the real
			// database and the batch commits on the second attempt.
			const transient = new MongoServerError({
				message: "injected transient batch failure (TransientTransactionError)",
				errorLabels: ["TransientTransactionError"],
			})
			const barrier = faultDb(db, {
				afterRelease: [
					{ collection: EVENTS, method: "deleteMany", error: transient },
				],
			})
			const receipt = await erasureEntry(tenantManager(agent, barrier.db))()

			// The retry committed: the attempt COMPLETES with a clean
			// recount and its own finalize reopened the gate.
			expect(receipt.status).toBe("complete")
			expect(receipt.gateState).toBe("open")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.verification?.residual ?? []).toHaveLength(0)

			// Retry-safe delta accounting: the per-collection receipt counts
			// the batch EXACTLY ONCE — 3 rows, not 6. The aborted first
			// attempt's deletedCount never reached the engine; only the
			// committed attempt's return does.
			const eventsReceipt = receipt.receipts.find(
				(entry) => entry.collection === "events",
			)
			expect(eventsReceipt?.deleted).toBe(3)
			expect(eventsReceipt?.error).toBeUndefined()

			// The callback ran twice — the transient fault, then the retry
			// that committed — visible in the wrapped-call trace.
			expect(
				barrier.calls.filter(
					(call) => call.collection === EVENTS && call.method === "deleteMany",
				),
			).toHaveLength(2)

			// The data is gone and the gate is open with no erase record.
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(0)
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("open")
			expect(gate?.erase).toBeUndefined()
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// F8b — commit-ambiguous batch delete fails closed
	// -------------------------------------------------------------------------

	it(
		"F8b: a commit-ambiguous batch delete fails closed — the data IS gone yet the verdict stays partial with no finalize",
		async () => {
			const agent = `agent-f8b-${randomUUID().slice(0, 8)}`

			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			// Commit-ambiguous fault (deleteFirst): the wrapper performs the
			// REAL delete WITHOUT the session — the effect lands immediately
			// and SURVIVES the transaction's abort — and then throws a
			// generic error. The caller cannot know whether its transaction
			// delete committed.
			const barrier = faultDb(db, {
				afterRelease: [
					{
						collection: EVENTS,
						method: "deleteMany",
						error: new Error(
							"injected commit-ambiguous batch failure (generic)",
						),
						deleteFirst: true,
					},
				],
			})
			const receipt = await erasureEntry(tenantManager(agent, barrier.db))()

			// Fail closed: the verdict is PARTIAL — no completion claim may
			// rest on a delete whose commit state is unknown.
			expect(receipt.status).toBe("partial")
			expect(receipt.ownershipLost).toBeUndefined()
			expect(receipt.auditError).toBeUndefined()
			expect(receipt.epochError).toBeUndefined()

			// The effect DID land: the data is gone and the post-sweep
			// recount (stage-1) was CLEAN — yet the verdict is partial. A
			// clean recount never upgrades an unverified batch delete.
			expect(receipt.verification?.residual ?? []).toHaveLength(0)
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(0)

			// The events receipt carries the injected error, not a delta
			// claim — the engine cannot count a delete it did not observe
			// committing.
			const eventsReceipt = receipt.receipts.find(
				(entry) => entry.collection === "events",
			)
			expect(eventsReceipt?.deleted).toBe(0)
			expect(eventsReceipt?.error).toContain(
				"injected commit-ambiguous batch failure",
			)

			// STILL OWNING: the partial audit acknowledged → gateState
			// "erasing", runId + mutationId present, and NO finalize — the
			// gate keeps erasing and no complete audit row exists.
			expect(receipt.gateState).toBe("erasing")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.mutationId).toBeTruthy()
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("erasing")
			expect(gate?.erase?.runId).toBe(receipt.runId)
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.status": "complete" }),
			).toBe(0)
			expect(
				await db.collection(MUTATIONS).countDocuments({
					agentId: agent,
					"meta.status": "partial",
					"meta.runId": receipt.runId,
				}),
			).toBe(1)
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T6 — unresolvable artifact ownership (inv 6)
	// -------------------------------------------------------------------------

	it(
		"T6: a relevance_runs row with a non-string runId leaves artifact ownership UNRESOLVED — every attempt retains the parents and ends partial with the reason on the receipt",
		async () => {
			const agent = `agent-t6-${randomUUID().slice(0, 8)}`

			// One GOOD parent (string runId, two reachable children) and one
			// BAD parent (numeric runId) whose children can NEVER be resolved
			// through the run join.
			await db.collection(RUNS).insertMany([
				{
					agentId: agent,
					runId: "run-good",
					status: "done",
					createdAt: new Date(),
				},
				{
					agentId: agent,
					runId: 42,
					status: "done",
					createdAt: new Date(),
				},
			])
			await db.collection(ARTIFACTS).insertMany(
				["a", "b"].map((tag) => ({
					runId: "run-good",
					kind: `child-${tag}`,
					createdAt: new Date(),
				})),
			)

			const first = await erasureEntry(tenantManager(agent, db))()

			// Partial, still owning: the reachable children WERE swept (the
			// run join resolved them) and the ONLY reason for partial is the
			// retention — the residual check is clean.
			expect(first.status).toBe("partial")
			expect(first.gateState).toBe("erasing")
			expect(first.runId).toBeTruthy()
			expect(first.mutationId).toBeTruthy()
			expect(first.ownershipLost).toBeUndefined()
			expect(
				first.receipts.find(
					(entry) => entry.collection === "relevance_artifacts",
				)?.deleted,
			).toBe(2)
			expect(first.verification?.residual ?? []).toHaveLength(0)

			// The parents were RETAINED with the unresolvable-ownership
			// reason on the receipt.
			const runsReceipt = first.receipts.find(
				(entry) => entry.collection === "relevance_runs",
			)
			expect(runsReceipt?.deleted).toBe(0)
			expect(runsReceipt?.error).toContain("retained for artifact retry")
			expect(runsReceipt?.error).toContain("no usable runId")
			expect(await db.collection(RUNS).countDocuments({ agentId: agent })).toBe(
				2,
			)

			// EVERY attempt retains: a deliberate recovery hits the same
			// unresolvable row and fails the same way — inv 6 never deletes
			// parents it cannot resolve children for.
			const second = await erasureEntry(tenantManager(agent, db))({
				recovery: "takeover",
			})
			expect(second.status).toBe("partial")
			expect(second.gateState).toBe("erasing")
			const secondRuns = second.receipts.find(
				(entry) => entry.collection === "relevance_runs",
			)
			expect(secondRuns?.deleted).toBe(0)
			expect(secondRuns?.error).toContain("no usable runId")
			expect(await db.collection(RUNS).countDocuments({ agentId: agent })).toBe(
				2,
			)

			// No complete audit row was ever written for this agent.
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.status": "complete" }),
			).toBe(0)
		},
		TIMEOUT,
	)

	it(
		"T6 transient phase-1 variant: a failed run-id read retains the parents once; recovery then resolves the children and completes",
		async () => {
			const agent = `agent-t6t-${randomUUID().slice(0, 8)}`

			await db.collection(RUNS).insertMany([
				{
					agentId: agent,
					runId: "run-9",
					status: "done",
					createdAt: new Date(),
				},
			])
			// One legacy child (runId-keyed — reachable ONLY via the parent)
			// and one agent-keyed child (reachable via the agentId arm even
			// when phase 1 fails).
			await db.collection(ARTIFACTS).insertMany([
				{ runId: "run-9", kind: "legacy-child", createdAt: new Date() },
				{ agentId: agent, kind: "agent-child", createdAt: new Date() },
			])

			// Phase 1's run-id read fails with a plain (non-conflict) error:
			// artifact ownership is unresolved THIS attempt.
			const barrier = faultDb(db, {
				afterRelease: [
					{
						collection: RUNS,
						method: "find",
						error: new Error(
							"injected phase-1 run-id read failure (non-conflict)",
						),
					},
				],
			})
			const first = await erasureEntry(tenantManager(agent, barrier.db))()

			// Partial, still owning; the agentId arm is INDEPENDENT of the
			// run join, so the agent-keyed child was swept even though
			// phase 1 failed.
			expect(first.status).toBe("partial")
			expect(first.gateState).toBe("erasing")
			expect(
				first.receipts.find(
					(entry) => entry.collection === "relevance_artifacts",
				)?.deleted,
			).toBe(1)

			// The legacy child (runId-keyed) was NOT reachable: it survives
			// this attempt. The stage-1 scan CANNOT see it either — its
			// filter is the same resolvable agentId arm (phase 1 failed, so
			// there is no run-id arm) — so the honest partial evidence is
			// the RETENTION on the runs receipt, not a residual row.
			expect(first.verification?.residual ?? []).toEqual([])
			expect(
				await db.collection(ARTIFACTS).countDocuments({ runId: "run-9" }),
			).toBe(1)

			// The parents were retained with the OBSERVED phase-1 error on
			// the receipt.
			const runsReceipt = first.receipts.find(
				(entry) => entry.collection === "relevance_runs",
			)
			expect(runsReceipt?.error).toContain("retained for artifact retry")
			expect(runsReceipt?.error).toContain(
				"injected phase-1 run-id read failure",
			)
			expect(await db.collection(RUNS).countDocuments({ agentId: agent })).toBe(
				1,
			)

			// Recovery: phase 1 succeeds (the fault is consumed), the legacy
			// child resolves through the retained parent and sweeps FIRST,
			// then the parent deletes — complete.
			const recovery = await erasureEntry(tenantManager(agent, db))({
				recovery: "takeover",
			})
			expect(recovery.status).toBe("complete")
			expect(recovery.gateState).toBe("open")
			expect(
				recovery.receipts.find(
					(entry) => entry.collection === "relevance_artifacts",
				)?.deleted,
			).toBe(1)
			expect(
				recovery.receipts.find((entry) => entry.collection === "relevance_runs")
					?.deleted,
			).toBe(1)
			expect(
				await db.collection(ARTIFACTS).countDocuments({ runId: "run-9" }),
			).toBe(0)
			expect(await db.collection(RUNS).countDocuments({ agentId: agent })).toBe(
				0,
			)
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("open")
			expect(gate?.erase).toBeUndefined()
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// T7 — tenant-B control throughout A's erasure window (inv 7)
	// -------------------------------------------------------------------------

	it(
		"T7: tenant B writes, reads, and keeps its data untouched throughout tenant A's erasure window — no cross-tenant interference",
		async () => {
			const agentA = `agent-t7a-${randomUUID().slice(0, 8)}`
			const agentB = `agent-t7b-${randomUUID().slice(0, 8)}`

			// A and B both have seeded events rows on the SAME database.
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agentA,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)
			await db.collection(EVENTS).insertMany(
				[1, 2].map((i) => ({
					agentId: agentB,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			// B writes NORMALLY before the window (the full admission path).
			const bWrite1 = await tenantManager(agentB, db).writeConversationEvent({
				role: "user",
				body: "tenant B writes normally",
				scope: "agent",
			})
			expect(
				await db
					.collection(EVENTS)
					.countDocuments({ eventId: bWrite1.eventId, agentId: agentB }),
			).toBe(1)
			const bTotalBefore = await db
				.collection(EVENTS)
				.countDocuments({ agentId: agentB })

			// A's erasure parks mid-sweep on the events id-fetch.
			const latched = latchDb(db, EVENTS)
			const attemptA = erasureEntry(tenantManager(agentA, latched.db))()
			const firstSignal = await Promise.race([
				latched.latch.parked.then(() => ({ kind: "parked" as const })),
				attemptA.then(
					(receipt) => ({ kind: "settled" as const, receipt }),
					(error) => ({ kind: "failed" as const, error }),
				),
			])
			if (firstSignal.kind === "failed") {
				throw firstSignal.error
			}
			if (firstSignal.kind === "settled") {
				throw new Error(
					`A erasure settled before parking on ${EVENTS}: ` +
						JSON.stringify(firstSignal.receipt),
				)
			}

			// G2: release and settle in the finally, always.
			let outcomeA: PromiseSettledResult<TenantErasureReceipt>
			try {
				// The window is genuinely open: A's gate is erasing.
				const gateA = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agentA,
				})
				expect(gateA?.state).toBe("erasing")

				// B's gate is untouched by A's erasure: B's own admission
				// initialized its gate document (open, epoch 0) — it exists,
				// but it was never closed: state "open", no erase block.
				const gateB = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agentB,
				})
				expect(gateB?.state).toBe("open")
				expect(gateB?.erase).toBeUndefined()

				// B writes normally DURING A's window — B's admission is not
				// gated by A's erasure (the gate is per-agent).
				const bWrite2 = await tenantManager(agentB, db).writeConversationEvent({
					role: "user",
					body: "tenant B writes during A's erasure window",
					scope: "agent",
				})
				expect(
					await db
						.collection(EVENTS)
						.countDocuments({ eventId: bWrite2.eventId, agentId: agentB }),
				).toBe(1)

				// B's manager-level read runs normally as well.
				await tenantManager(agentB, db).listQuarantined()

				// B's counts grew ONLY by its own write; its seeded rows are
				// untouched by A's mid-sweep window.
				expect(
					await db.collection(EVENTS).countDocuments({ agentId: agentB }),
				).toBe(bTotalBefore + 1)
				expect(
					await db
						.collection(EVENTS)
						.countDocuments({ agentId: agentB, kind: "seed" }),
				).toBe(2)
			} finally {
				latched.latch.release()
				outcomeA = await attemptA.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
			}
			if (outcomeA.status === "rejected") {
				throw outcomeA.reason
			}
			const receiptA = outcomeA.value

			// A completed: A's rows are gone; B is INTACT — same counts, its
			// gate still open with no erase block — and B can still write
			// after A's finalize.
			expect(receiptA.status).toBe("complete")
			expect(receiptA.gateState).toBe("open")
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agentA }),
			).toBe(0)
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agentB }),
			).toBe(bTotalBefore + 1)
			expect(
				await db
					.collection(EVENTS)
					.countDocuments({ agentId: agentB, kind: "seed" }),
			).toBe(2)
			const gateBFinal = await readErasureGate({
				db,
				prefix: PREFIX,
				agentId: agentB,
			})
			expect(gateBFinal?.state).toBe("open")
			expect(gateBFinal?.erase).toBeUndefined()
			const bWrite3 = await tenantManager(agentB, db).writeConversationEvent({
				role: "user",
				body: "tenant B writes after A completed",
				scope: "agent",
			})
			expect(
				await db
					.collection(EVENTS)
					.countDocuments({ eventId: bWrite3.eventId, agentId: agentB }),
			).toBe(1)
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agentB }),
			).toBe(bTotalBefore + 2)
		},
		TIMEOUT,
	)

	// -------------------------------------------------------------------------
	// F10 — fail-closed pins: no unfenced path exists at all
	// -------------------------------------------------------------------------

	it(
		"F10 pin (real time-series sink): a retained time-series diagnostic sink fails closed BEFORE the sweep — partial, ZERO deletes across all targets, the sink named with the migration-required reason",
		async () => {
			const agent = `agent-f10i-${randomUUID().slice(0, 8)}`

			// Earlier cases created TELEMETRY as an ordinary collection
			// (insertMany auto-create). Drop it and recreate as a REAL
			// time-series instance — the legacy shape the pre-sweep type
			// check must catch (the diagnostics-schema e2e creation idiom).
			const [existing] = await db.listCollections({ name: TELEMETRY }).toArray()
			if (existing) {
				await db.collection(TELEMETRY).drop()
			}
			await ensureTimeseriesOrPlain(db, TELEMETRY, {
				timeField: "ts",
				metaField: "meta",
				granularity: "seconds",
				expireAfterSeconds: 7 * 24 * 3600,
			})
			const [info] = await db
				.listCollections({ name: TELEMETRY }, { nameOnly: false })
				.toArray()
			expect(info?.type).toBe("timeseries")

			// Tenant rows in the time-series sink AND in events — if the
			// type check failed to fire, the sweep would delete both.
			await db.collection(TELEMETRY).insertMany(
				[1, 2].map((ms) => ({
					meta: { agentId: agent },
					ts: new Date(),
					ms,
				})),
			)
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			const receipt = await erasureEntry(tenantManager(agent, db))()

			// Fail closed BEFORE the sweep: partial, the sink named with the
			// migration-required reason, ZERO deletes.
			expect(receipt.status).toBe("partial")
			expect(receipt.receipts).toHaveLength(1)
			const sinkReceipt = receipt.receipts.find(
				(entry) => entry.collection === "memory_telemetry",
			)
			expect(sinkReceipt?.deleted).toBe(0)
			expect(sinkReceipt?.error).toContain("time-series collection")
			expect(sinkReceipt?.error).toContain("migration to ordinary")

			// ZERO deletes across ALL targets: both the sink rows and the
			// ordinary events rows survive — nothing half-erased, and NO
			// unfenced delete was ever attempted.
			expect(
				await db
					.collection(TELEMETRY)
					.countDocuments({ "meta.agentId": agent }),
			).toBe(2)
			expect(
				await db.collection(EVENTS).countDocuments({ agentId: agent }),
			).toBe(3)

			// Still owning: gateState "erasing", runId + mutationId present,
			// the gate keeps erasing, admissions rejecting, no finalize.
			expect(receipt.gateState).toBe("erasing")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.mutationId).toBeTruthy()
			expect(receipt.ownershipLost).toBeUndefined()
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("erasing")
			expect(gate?.erase?.runId).toBe(receipt.runId)
			await expect(
				captureAdmissionToken({ db, prefix: PREFIX, agentId: agent }),
			).rejects.toSatisfy(isErasureGateConflictError)
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.status": "complete" }),
			).toBe(0)
		},
		TIMEOUT,
	)

	it(
		"F10 pin (tx-illegal backstop): a transaction-illegal error on a fenced sink delete fails closed with the same migration-required reason — the sink data SURVIVES (no unfenced delete was ever attempted)",
		async () => {
			const agent = `agent-f10ii-${randomUUID().slice(0, 8)}`

			// Return the sink to an ORDINARY collection (the F10-i case left
			// it a time-series instance) and seed it plus events rows.
			const [existing] = await db.listCollections({ name: TELEMETRY }).toArray()
			if (existing?.type === "timeseries") {
				await db.collection(TELEMETRY).drop()
			}
			await db.collection(TELEMETRY).insertMany(
				[1, 2].map((ms) => ({
					meta: { agentId: agent },
					ts: new Date(),
					ms,
				})),
			)
			await db.collection(EVENTS).insertMany(
				[1, 2, 3].map((i) => ({
					agentId: agent,
					kind: "seed",
					i,
					ts: new Date(),
				})),
			)

			// The sink is ORDINARY (the pre-sweep type check passes), but the
			// FENCED batch delete throws a transaction-illegal, time-series-
			// class error — the backstop for a sink whose shape changed
			// between the type check and the delete.
			const barrier = faultDb(db, {
				afterRelease: [
					{
						collection: TELEMETRY,
						method: "deleteMany",
						error: new MongoServerError({
							message:
								"injected OperationNotPermittedInTransaction: cannot delete from time-series collection within a transaction",
						}),
					},
				],
			})
			const receipt = await erasureEntry(tenantManager(agent, barrier.db))()

			// Fail closed: partial, the sink named with the SAME
			// migration-required reason (the raw server text is replaced by
			// the actionable reason).
			expect(receipt.status).toBe("partial")
			expect(receipt.ownershipLost).toBeUndefined()
			const sinkReceipt = receipt.receipts.find(
				(entry) => entry.collection === "memory_telemetry",
			)
			expect(sinkReceipt?.deleted).toBe(0)
			expect(sinkReceipt?.error).toContain("time-series collection")
			expect(sinkReceipt?.error).toContain("migration to ordinary")

			// Other collections swept normally — a failed collection ends
			// only that collection, never the whole sweep.
			expect(
				receipt.receipts.find((entry) => entry.collection === "events")
					?.deleted,
			).toBe(3)

			// NO unfenced delete was ever attempted: the sink rows SURVIVE —
			// the injected error surfaced from the FENCED path only (exactly
			// ONE deleteMany attempt on the sink in the call trace, never a
			// second, unfenced one).
			expect(
				await db
					.collection(TELEMETRY)
					.countDocuments({ "meta.agentId": agent }),
			).toBe(2)
			expect(
				barrier.calls.filter(
					(call) =>
						call.collection === TELEMETRY && call.method === "deleteMany",
				),
			).toHaveLength(1)

			// Stage-1 surfaced the surviving sink rows as residual — honest
			// partial evidence; still owning, no finalize.
			expect(receipt.verification?.residual ?? []).toContainEqual({
				collection: "memory_telemetry",
				count: 2,
			})
			expect(receipt.gateState).toBe("erasing")
			expect(receipt.runId).toBeTruthy()
			expect(receipt.mutationId).toBeTruthy()
			const gate = await readErasureGate({ db, prefix: PREFIX, agentId: agent })
			expect(gate?.state).toBe("erasing")
			expect(gate?.erase?.runId).toBe(receipt.runId)
			expect(
				await db
					.collection(MUTATIONS)
					.countDocuments({ agentId: agent, "meta.status": "complete" }),
			).toBe(0)
		},
		TIMEOUT,
	)
})
