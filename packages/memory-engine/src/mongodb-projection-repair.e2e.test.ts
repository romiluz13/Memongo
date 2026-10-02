// Startup projection repair fence e2e — T-R1 and T-R2 of the five-file
// bulk grant (manager-sync repair, mongodb-events batch session path,
// their unit suites, this native suite).
//
// T-R1 (repopulation window): the repair's event snapshot read parks AFTER
// the underlying read finishes and BEFORE it returns to its caller — a
// point outside any fence or transaction on BOTH the current unfenced
// path (projectChunksFromEvents) and the granted fenced path, which both
// call getUnprojectedEvents with the same full-document find. While the
// repair is parked: tenant B's repair completes normally (isolation
// control), and the PUBLIC erase of tenant A runs to a "complete" receipt
// through the real manager facade. The latch releases in finally; the
// repair promise settles first; then the case asserts a typed erasure-gate
// conflict and that tenant A has NO trailing chunks and NO repair
// diagnostics.
//
// On the CURRENT bytes this case is the intended-assertion RED anchor: the
// released repair re-projects the already-swept event (trailing chunk +
// projection run record, no typed conflict). On the granted bytes it is
// GREEN: the fence validates the pre-erase admission against the reopened
// gate and refuses. No assertion may manifest as a timeout — the latch is
// event-driven and released in finally.
//
// T-R2 (admission refusal): the erase's OWN first events id-fetch find
// (projection {_id:1} — the designed sweep pause seam in
// sweepCollectionFenced, outside any transaction, with the gate durably
// closed at "erasing" by the committed begin) parks post-read pre-return.
// While parked, a SEPARATE manager instance calls A's repair barrier-free
// on the unparked db: the granted admission refuses at state "erasing" —
// a typed conflict before any tenant read, zero chunks; the CURRENT bytes
// re-project A's event mid-erase (the intended-assertion RED anchors).
// Tenant B's repair proceeds concurrently — the refusal is gate-scoped to
// A. Release in finally; the erase completes; A is fully swept; B intact.
//
// T-R2 liveness and cleanup-outcome hardening (Kimi review, Astra
// disposition 2026-09-09): a nonrejecting settlement capture is attached
// the moment the erase starts; the latch races ANY erase settlement — a
// resolved partial receipt as well as a rejection — and the case fails
// EXPLICITLY if the erase settles before the id-fetch parks (no
// unconditional park await, so no hang). The finally always releases and
// awaits the captured settlement, then validates and reports the terminal
// erase error or non-complete receipt even when the primary assertion has
// already failed; the primary intended-RED failure is preserved —
// aggregated with the erase outcome when both fail — never swallowed.
//
// Target gating follows the frozen erasure-gate e2e contract:
// MEMONGO_TEST_MONGODB_URI is REQUIRED — no default URI (not even
// localhost), no silent skip; it must parse as mongodb:// or mongodb+srv://
// and is never printed. Unique disposable database per run; teardown drops
// it, asserts absence, and closes the client. The pre-existing
// localhost-fallback and swallowed dropDatabase cleanup are REMOVED.

import { randomUUID } from "node:crypto"
import type { CollectionOptions, Db } from "mongodb"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { projectChunksFromEvents, writeEvent } from "./mongodb-events.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	chunksCollection,
	ensureCollections,
	eventsCollection,
	projectionRunsCollection,
	telemetryCollection,
} from "./mongodb-schema.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

// ---------------------------------------------------------------------------
// Target gating — required, never defaulted
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

const TEST_DB = `memongo_projection_repair_${randomUUID().replaceAll("-", "")}`
const PREFIX = "repair_"
const TIMEOUT = 60_000

let client: MongoClient

// ---------------------------------------------------------------------------
// Manager boundary — real prototype methods over a real (or parked) db
// ---------------------------------------------------------------------------

captureManagerPrototype(MongoDBMemoryManager)

type RepairResult = { eventsProcessed: number; chunksCreated: number }

function tenantManager(agentId: string, managerDb: Db): MongoDBMemoryManager {
	// The proven buildMockManager-over-real-db pattern from the frozen
	// erasure-gate e2e: real manager methods over a real (or parked) db, with
	// the minimal host fields both facades need. deleteAllForAgent drains
	// (the real stopMemoryJobWorker; the accessTracker leg no-ops without a
	// tracker) and then runs the engine eraser against this db/prefix/agentId.
	return buildMockManager({
		client,
		db: managerDb,
		prefix: PREFIX,
		agentId,
		agentScopeRef: `agent:${agentId}`,
		workspaceScopeRef: `workspace:${agentId}`,
		workspaceDir: "/tmp/memongo-projection-repair-e2e",
		config: kitMongoConfig(),
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

function repairProjections(
	manager: MongoDBMemoryManager,
): Promise<RepairResult> {
	// repairEventProjections is a private startup method (manager.ts:1354);
	// the suite drives it through the real prototype, as the unit suite
	// does, so the fence behavior under test is the production behavior.
	return (
		manager as unknown as {
			repairEventProjections: () => Promise<RepairResult>
		}
	).repairEventProjections()
}

// ---------------------------------------------------------------------------
// T-R1 latch: park the repair's snapshot read post-read, pre-return
// ---------------------------------------------------------------------------

/**
 * Wraps `db` so the FIRST full-document find on the events collection (the
 * repair's unprojected-events snapshot — no projection option; the eraser's
 * sweep id-fetch reads with projection {_id:1} and passes through) parks
 * AFTER the underlying read finishes and BEFORE the documents return to
 * the caller. No fence or transaction is open while parked, on either the
 * current or the granted path. `readCompleted` resolves once the read has
 * finished (safe to start the erase); `release()` un-parks, is idempotent,
 * and must be called in a finally.
 */
function parkSnapshotRead(db: Db): {
	db: Db
	readCompleted: Promise<void>
	release: () => void
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
	const wrapped = new Proxy(db, {
		get(target, property) {
			if (property === "collection") {
				return (name: string, options?: CollectionOptions) => {
					const collection = target.collection(name, options)
					if (name !== `${PREFIX}events` || parkedOnce) {
						return collection
					}
					return new Proxy(collection, {
						get(target, property) {
							if (property === "find") {
								return (...args: Parameters<typeof target.find>) => {
									const options = args[1] as
										| { projection?: unknown }
										| undefined
									// The eraser's id-fetch (projection {_id:1}) and
									// any other projected read pass straight through;
									// only the repair's full-document snapshot parks.
									if (options?.projection) {
										return target.find(...args)
									}
									const cursor = target.find(...args)
									if (parkedOnce) {
										return cursor
									}
									parkedOnce = true
									const toArray = cursor.toArray.bind(cursor)
									cursor.toArray = async () => {
										const docs = await toArray()
										markReadCompleted()
										await gate
										return docs
									}
									return cursor
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
	return { db: wrapped, readCompleted, release: () => openGate?.() }
}

// ---------------------------------------------------------------------------
// T-R2 latch: park the erase's events id-fetch post-read, pre-return
// ---------------------------------------------------------------------------

/**
 * Wraps `db` so the FIRST find on the events collection issued WITH a
 * projection option — the eraser's sweep id-fetch (projection {_id:1},
 * mongodb-erasure.ts sweepCollectionFenced; reached through
 * accessorFor → eventsCollection → db.collection(`${prefix}events`)) —
 * parks AFTER the underlying read finishes and BEFORE the ids return to
 * the caller. The id-fetch runs outside any transaction, and by the time
 * it is issued the committed begin has durably closed the gate at
 * "erasing". Full-document reads (the repair's snapshot) and every other
 * collection pass straight through — the inverse of the T-R1
 * discriminator. `idFetchParked` resolves once the read has finished (the
 * gate is durably closed; safe to call the separate repair);
 * `release()` un-parks, is idempotent, and must be called in a finally.
 */
function parkSweepIdFetch(db: Db): {
	db: Db
	idFetchParked: Promise<void>
	release: () => void
} {
	let openGate: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		openGate = resolve
	})
	let markIdFetchParked: (() => void) | undefined
	const idFetchParked = new Promise<void>((resolve) => {
		markIdFetchParked = resolve
	})
	let parkedOnce = false
	const wrapped = new Proxy(db, {
		get(target, property) {
			if (property === "collection") {
				return (name: string, options?: CollectionOptions) => {
					const collection = target.collection(name, options)
					if (name !== `${PREFIX}events` || parkedOnce) {
						return collection
					}
					return new Proxy(collection, {
						get(target, property) {
							if (property === "find") {
								return (...args: Parameters<typeof target.find>) => {
									const options = args[1] as
										| { projection?: unknown }
										| undefined
									// Inverse of the T-R1 discriminator: only a
									// projected read (the eraser's id-fetch) parks;
									// the repair's full-document snapshot and every
									// unprojected find pass straight through.
									if (!options?.projection) {
										return target.find(...args)
									}
									const cursor = target.find(...args)
									if (parkedOnce) {
										return cursor
									}
									parkedOnce = true
									const toArray = cursor.toArray.bind(cursor)
									cursor.toArray = async () => {
										const docs = await toArray()
										markIdFetchParked()
										await gate
										return docs
									}
									return cursor
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
	return { db: wrapped, idFetchParked, release: () => openGate?.() }
}

// ---------------------------------------------------------------------------
// T-R2 erase settlement capture (nonrejecting, attached at erase start)
// ---------------------------------------------------------------------------

type EraseReceipt = Awaited<
	ReturnType<MongoDBMemoryManager["deleteAllForAgent"]>
>

/**
 * The terminal outcome of the public erase — the TenantErasureReceipt it
 * resolved with (complete or partial) or the error it rejected with —
 * captured through handlers attached the moment the erase starts. The
 * capture itself NEVER rejects, so the settlement can always be awaited
 * (in the liveness race and in the finally) and can never surface as an
 * unhandled rejection.
 */
type EraseOutcome =
	| { settled: "resolved"; receipt: EraseReceipt }
	| { settled: "rejected"; error: unknown }

/** Compact settlement description for the case's failure messages. */
function describeEraseOutcome(outcome: EraseOutcome): string {
	if (outcome.settled === "rejected") {
		const detail =
			outcome.error instanceof Error
				? outcome.error.message
				: String(outcome.error)
		return `rejected: ${detail}`
	}
	return `resolved with receipt status ${outcome.receipt.status}`
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

beforeAll(async () => {
	client = new MongoClient(URI, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
	})
	await client.connect()
	await ensureCollections(client.db(TEST_DB), PREFIX)
}, TIMEOUT)

afterAll(async () => {
	try {
		const db = client?.db(TEST_DB)
		if (db) {
			await db.dropDatabase()
			const listed = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true, filter: { name: TEST_DB } })
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
// Cases
// ---------------------------------------------------------------------------

describe("canonical event projection repair (live replica set)", () => {
	it(
		"recovers an unprojected event and is idempotent on retry",
		async () => {
			const db = client.db(TEST_DB)
			const agentId = `agent-${randomUUID().slice(0, 8)}`
			const written = await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: "evt-repair",
					agentId,
					role: "assistant",
					body: "The deployment requires projection repair.",
					scope: "agent",
				},
			})

			expect(
				await eventsCollection(db, PREFIX).findOne({
					eventId: written.eventId,
				}),
			).not.toHaveProperty("projectedAt")

			await expect(
				projectChunksFromEvents({
					db,
					prefix: PREFIX,
					agentId,
					batchSize: 500,
				}),
			).resolves.toEqual({ eventsProcessed: 1, chunksCreated: 1 })

			const event = await eventsCollection(db, PREFIX).findOne({
				eventId: written.eventId,
			})
			const chunk = await chunksCollection(db, PREFIX).findOne({
				path: `events/${written.eventId}`,
			})
			expect(event?.projectedAt).toBeInstanceOf(Date)
			expect(chunk).toMatchObject({
				path: "events/evt-repair",
				text: "Assistant: The deployment requires projection repair.",
				agentId,
				scope: "agent",
				scopeRef: `agent:${agentId}`,
			})

			await expect(
				projectChunksFromEvents({
					db,
					prefix: PREFIX,
					agentId,
					batchSize: 500,
				}),
			).resolves.toEqual({ eventsProcessed: 0, chunksCreated: 0 })
			expect(
				await chunksCollection(db, PREFIX).countDocuments({
					path: `events/${written.eventId}`,
				}),
			).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"T-R1: a repair admitted before an erase cannot resurrect swept events",
		async () => {
			const db = client.db(TEST_DB)
			const agentA = `agent-a-${randomUUID().slice(0, 8)}`
			const agentB = `agent-b-${randomUUID().slice(0, 8)}`

			// One unprojected event per tenant (writeEvent leaves projectedAt
			// unset) — A is the erase target, B the isolation control.
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: `evt-tr1-a-${randomUUID().slice(0, 8)}`,
					agentId: agentA,
					role: "assistant",
					body: "Tenant A event awaiting projection repair.",
					scope: "agent",
				},
			})
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: `evt-tr1-b-${randomUUID().slice(0, 8)}`,
					agentId: agentB,
					role: "assistant",
					body: "Tenant B event awaiting projection repair.",
					scope: "agent",
				},
			})

			const parked = parkSnapshotRead(db)
			const repairPromise = repairProjections(tenantManager(agentA, parked.db))

			try {
				// The snapshot read has finished; the repair is parked before
				// the documents return, holding no locks.
				await parked.readCompleted

				// Tenant-B control while A's repair is in flight: B's repair
				// completes normally, unaffected by A's upcoming erase.
				await expect(
					repairProjections(tenantManager(agentB, db)),
				).resolves.toEqual({ eventsProcessed: 1, chunksCreated: 1 })

				// Public erase of A through the real facade, to a complete
				// receipt, while the repair holds its stale snapshot.
				const receipt = await tenantManager(agentA, db).deleteAllForAgent()
				expect(receipt).toMatchObject({ agentId: agentA, status: "complete" })

				// Release the stale snapshot; the repair promise settles
				// BEFORE any assertion runs (no outcome is left pending).
				parked.release()
				let repairError: unknown
				await repairPromise.then(
					() => {},
					(err: unknown) => {
						repairError = err
					},
				)
				expect(repairError).toMatchObject({
					code: "ERASURE_GATE_CONFLICT",
				})

				// No resurrection: A's events and chunks stay swept, and the
				// refused repair left no diagnostics behind.
				expect(
					await eventsCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await chunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await projectionRunsCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await telemetryCollection(db, PREFIX).countDocuments({
						"meta.agentId": agentA,
					}),
				).toBe(0)

				// Tenant B remains fully intact.
				expect(
					await chunksCollection(db, PREFIX).countDocuments({
						agentId: agentB,
					}),
				).toBe(1)
				expect(
					await eventsCollection(db, PREFIX).findOne({ agentId: agentB }),
				).toHaveProperty("projectedAt")
			} finally {
				parked.release()
				await repairPromise.catch(() => {})
			}
		},
		TIMEOUT,
	)

	it(
		"T-R2: an erase holding the gate refuses a fresh repair admission without resurrecting anything",
		async () => {
			const db = client.db(TEST_DB)
			const agentA = `agent-a-${randomUUID().slice(0, 8)}`
			const agentB = `agent-b-${randomUUID().slice(0, 8)}`

			// One unprojected event per tenant — A is the erase target (its
			// erase will hold the gate at "erasing"), B the isolation control.
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: `evt-tr2-a-${randomUUID().slice(0, 8)}`,
					agentId: agentA,
					role: "assistant",
					body: "Tenant A event targeted by an in-progress erase.",
					scope: "agent",
				},
			})
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: `evt-tr2-b-${randomUUID().slice(0, 8)}`,
					agentId: agentB,
					role: "assistant",
					body: "Tenant B event untouched by tenant A's erase.",
					scope: "agent",
				},
			})

			// The PUBLIC erase of A through the real facade, on the db whose
			// events id-fetch is parked. The committed begin has durably
			// closed A's gate at "erasing" before the first sweep id-fetch is
			// issued, so the latch can only park against a durably-closed
			// gate. The settlement capture is attached the MOMENT the erase
			// starts: the terminal outcome — a resolved receipt (complete or
			// partial) or a rejection — can never escape observation or
			// surface as an unhandled rejection.
			const parked = parkSweepIdFetch(db)
			const erasePromise = tenantManager(agentA, parked.db).deleteAllForAgent()
			const eraseOutcome = erasePromise.then(
				(receipt): EraseOutcome => ({ settled: "resolved", receipt }),
				(error: unknown): EraseOutcome => ({ settled: "rejected", error }),
			)

			// The primary flow records its own failure; the finally ALWAYS
			// releases the latch and awaits and validates the captured
			// settlement, and the recorded failures are thrown AFTER it —
			// the primary failure aggregated with the erase outcome when
			// both fail — so a primary failure can never mask or swallow the
			// erase outcome.
			let primaryError: unknown
			let primaryFailed = false
			let outcomeError: Error | undefined
			try {
				// Liveness: the latch races ANY erase settlement, and the case
				// fails EXPLICITLY when the erase settles first — there is no
				// unconditional park await, so an erase that settles before
				// the id-fetch parks can never hang the case into a timeout.
				const firstSettler = await Promise.race([
					parked.idFetchParked.then(() => "id-fetch-parked" as const),
					eraseOutcome.then(() => "erase-settled" as const),
				])
				if (firstSettler === "erase-settled") {
					throw new Error(
						`T-R2 precondition failed: the public erase settled ` +
							`before the sweep id-fetch parked ` +
							`(${describeEraseOutcome(await eraseOutcome)}); the ` +
							`mid-window admission cannot be exercised`,
					)
				}

				// The race was won by the latch: the events id-fetch has
				// finished reading and is parked before the ids return; the
				// erase holds the gate at "erasing".

				// A SEPARATE manager instance calls A's repair barrier-free on
				// the unparked db; the repair promise settles BEFORE any
				// assertion runs.
				const repairPromise = repairProjections(tenantManager(agentA, db))
				let repairError: unknown
				await repairPromise.then(
					() => {},
					(err: unknown) => {
						repairError = err
					},
				)
				// The granted admission refuses at state "erasing" with the
				// typed conflict. On the current bytes the repair resolves
				// instead — the intended-assertion RED anchor.
				expect(repairError).toMatchObject({
					code: "ERASURE_GATE_CONFLICT",
				})
				// Refused before any tenant read: no chunk and no repair run
				// record exist for A while the erase still holds the gate.
				expect(
					await chunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await projectionRunsCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)

				// Tenant-B control while A's erase is mid-sweep: B's repair
				// proceeds normally — the refusal is gate-scoped to A.
				await expect(
					repairProjections(tenantManager(agentB, db)),
				).resolves.toEqual({ eventsProcessed: 1, chunksCreated: 1 })

				// Release the id-fetch; the erase runs to a complete receipt.
				parked.release()
				const outcome = await eraseOutcome
				if (outcome.settled !== "resolved") {
					throw new Error(
						`T-R2: the public erase did not run to a receipt after ` +
							`the latch released (${describeEraseOutcome(outcome)})`,
					)
				}
				expect(outcome.receipt).toMatchObject({
					agentId: agentA,
					status: "complete",
				})

				// Zero resurrection: A's events, chunks, runs and telemetry
				// are all gone.
				expect(
					await eventsCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await chunksCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await projectionRunsCollection(db, PREFIX).countDocuments({
						agentId: agentA,
					}),
				).toBe(0)
				expect(
					await telemetryCollection(db, PREFIX).countDocuments({
						"meta.agentId": agentA,
					}),
				).toBe(0)

				// Tenant B remains fully intact (event retained and projected).
				expect(
					await chunksCollection(db, PREFIX).countDocuments({
						agentId: agentB,
					}),
				).toBe(1)
				expect(
					await eventsCollection(db, PREFIX).findOne({ agentId: agentB }),
				).toHaveProperty("projectedAt")
			} catch (error) {
				primaryFailed = true
				primaryError = error
			} finally {
				// ALWAYS release and observe. Even when the primary flow has
				// already failed (the intended-RED anchor on the current
				// bytes), the latch is released so the erase can settle, and
				// the captured settlement is awaited and validated here: a
				// terminal erase error or a non-complete receipt is recorded,
				// never swallowed. Nothing is thrown from the finally itself.
				parked.release()
				const outcome = await eraseOutcome
				if (outcome.settled === "rejected") {
					outcomeError = new Error(
						`T-R2 erase outcome: the public erase rejected ` +
							`(${describeEraseOutcome(outcome)})`,
					)
				} else if (outcome.receipt.status !== "complete") {
					outcomeError = new Error(
						`T-R2 erase outcome: the public erase settled with a ` +
							`non-complete receipt (${describeEraseOutcome(outcome)})`,
					)
				}
			}
			// The finally has released the latch and observed the settlement
			// on every path; what failed fails together now: the primary
			// intended-RED failure is preserved AND the erase outcome is
			// reported — neither masks the other.
			if (primaryFailed && outcomeError) {
				throw new AggregateError(
					[primaryError, outcomeError],
					"T-R2: primary assertion and erase outcome both failed",
				)
			}
			if (outcomeError) throw outcomeError
			if (primaryFailed) throw primaryError
		},
		TIMEOUT,
	)
})
