import type { Collection, Db } from "mongodb"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))

import {
	AccessTracker,
	accessTargetFromSearchResult,
	getAccessSummaries,
	getAccessTrends,
} from "./mongodb-access-tracker.js"

const PREFIX = "test_"

function createMockDb() {
	const accessInsertMany = vi.fn().mockResolvedValue({ insertedCount: 0 })
	// W11: the raw-layer read-reconcile (`find` by batchId before a retry
	// inserts). Default: no batches present.
	const accessFindToArray = vi.fn(async () => [])
	const accessFind = vi.fn(() => ({ toArray: accessFindToArray }))
	const eventsBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 0 })
	const structuredBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 0 })
	const proceduresBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 0 })
	const episodesBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 0 })
	const entitiesBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 0 })
	const relationsBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 0 })

	const collections = new Map<string, Collection>([
		[
			`${PREFIX}access_events`,
			{
				insertMany: accessInsertMany,
				find: accessFind,
				aggregate: vi.fn(),
			} as unknown as Collection,
		],
		[
			`${PREFIX}events`,
			{ bulkWrite: eventsBulkWrite } as unknown as Collection,
		],
		[
			`${PREFIX}structured_mem`,
			{ bulkWrite: structuredBulkWrite } as unknown as Collection,
		],
		[
			`${PREFIX}procedures`,
			{ bulkWrite: proceduresBulkWrite } as unknown as Collection,
		],
		[
			`${PREFIX}episodes`,
			{ bulkWrite: episodesBulkWrite } as unknown as Collection,
		],
		[
			`${PREFIX}entities`,
			{ bulkWrite: entitiesBulkWrite } as unknown as Collection,
		],
		[
			`${PREFIX}relations`,
			{ bulkWrite: relationsBulkWrite } as unknown as Collection,
		],
	])

	const db = {
		collection: vi.fn((name: string) => collections.get(name)),
	} as unknown as Db

	return {
		db,
		accessInsertMany,
		accessFind,
		accessFindToArray,
		eventsBulkWrite,
		structuredBulkWrite,
		proceduresBulkWrite,
		episodesBulkWrite,
		entitiesBulkWrite,
		relationsBulkWrite,
		accessCollection: collections.get(
			`${PREFIX}access_events`,
		) as unknown as Collection,
	}
}

describe("AccessTracker", () => {
	let tracker: AccessTracker | null = null

	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		if (tracker) {
			return tracker.close().finally(() => {
				tracker = null
			})
		}
		vi.useRealTimers()
	})

	it("buffers access without touching MongoDB", () => {
		const { db, accessInsertMany, eventsBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 10 })

		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-2" })
		tracker.recordAccess({ collection: "events", id: "evt-3" })

		expect(accessInsertMany).not.toHaveBeenCalled()
		expect(eventsBulkWrite).not.toHaveBeenCalled()
	})

	it("flushes time-series events and computed summaries when threshold is reached", async () => {
		const { db, accessInsertMany, eventsBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 3 })

		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-2" })
		tracker.recordAccess({ collection: "events", id: "evt-3" })
		await tracker.flush()

		expect(accessInsertMany).toHaveBeenCalledTimes(1)
		expect(eventsBulkWrite).toHaveBeenCalledTimes(1)
	})

	it("accumulates counts for the same document before flush", async () => {
		const { db, accessInsertMany, eventsBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 100 })

		for (let i = 0; i < 5; i++) {
			tracker.recordAccess({ collection: "events", id: "evt-1" })
		}

		await tracker.flush()

		expect(accessInsertMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					meta: {
						agentId: "agent-1",
						collection: "events",
					},
					memoryId: "evt-1",
					count: 5,
					ts: expect.any(Date),
				}),
			],
			{ ordered: false },
		)
		expect(eventsBulkWrite).toHaveBeenCalledWith(
			[
				{
					updateOne: {
						filter: {
							eventId: "evt-1",
							agentId: "agent-1",
							// W11: per-batch idempotency guard on the canonical op.
							appliedBatches: { $ne: expect.any(String) },
						},
						update: {
							$inc: { accessCount: 5 },
							$set: { lastAccessedAt: expect.any(Date) },
							// W11: batch append rides the same atomic update.
							$push: {
								appliedBatches: {
									$each: [expect.any(String)],
									$slice: -32,
								},
							},
						},
					},
				},
			],
			{ ordered: false },
		)
	})

	it("flushes multiple collections in one batch", async () => {
		const {
			db,
			accessInsertMany,
			eventsBulkWrite,
			structuredBulkWrite,
			proceduresBulkWrite,
		} = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 100 })

		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({
			collection: "structured_mem",
			id: "fact-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			type: "fact",
		})
		tracker.recordAccess({
			collection: "procedures",
			id: "proc-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
		})

		await tracker.flush()

		expect(accessInsertMany).toHaveBeenCalledTimes(1)
		expect(eventsBulkWrite).toHaveBeenCalledTimes(1)
		expect(structuredBulkWrite).toHaveBeenCalledTimes(1)
		expect(proceduresBulkWrite).toHaveBeenCalledTimes(1)
	})

	it("close() clears the timer and flushes remaining events", async () => {
		const { db, accessInsertMany } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 100 })

		tracker.recordAccess({ collection: "events", id: "evt-1" })
		await tracker.close()

		expect(accessInsertMany).toHaveBeenCalled()
		tracker = null
	})

	it("skips flush when the buffer is empty", async () => {
		const { db, accessInsertMany } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1")

		const count = await tracker.flush()

		expect(count).toBe(0)
		expect(accessInsertMany).not.toHaveBeenCalled()
	})

	it("manual flush awaits all auto-triggered flushes", async () => {
		vi.useRealTimers()
		const accessInsertMany = vi
			.fn()
			.mockImplementation(
				(docs: Array<{ count: number }>) =>
					new Promise((resolve) =>
						setTimeout(resolve, 20, { insertedCount: docs.length }),
					),
			)
		const eventsBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 1 })
		const db = {
			collection: vi.fn((name: string) => {
				if (name === `${PREFIX}access_events`) {
					return {
						insertMany: accessInsertMany,
						aggregate: vi.fn(),
					} as unknown as Collection
				}
				return {
					bulkWrite: eventsBulkWrite,
				} as unknown as Collection
			}),
		} as unknown as Db

		tracker = new AccessTracker(db, PREFIX, "agent-1", {
			flushThreshold: 5,
			flushIntervalMs: 600_000,
		})

		for (let i = 0; i < 15; i++) {
			tracker.recordAccess({ collection: "events", id: "evt-1" })
		}

		await tracker.flush()

		const totalCount = accessInsertMany.mock.calls.reduce(
			(sum: number, call: unknown[]) =>
				sum +
				((call[0] as Array<{ count: number }>).reduce(
					(inner, doc) => inner + doc.count,
					0,
				) ?? 0),
			0,
		)
		expect(totalCount).toBe(15)

		vi.useFakeTimers()
	}, 5_000)

	// =========================================================================
	// Access-event durability — re-buffer on flush error (deadletter retry path).
	// Original behavior silently cleared the buffer before insertMany, so a
	// network failure lost the access counts forever. New behavior snapshots
	// the buffer first and, on error, merges the snapshot back into the live
	// buffer so the next flush retries.
	// =========================================================================
	it("re-buffers counts when the access-events insertMany fails (access-event durability)", async () => {
		vi.useRealTimers()
		let attempts = 0
		const accessInsertMany = vi.fn().mockImplementation(async () => {
			attempts++
			if (attempts === 1) {
				throw new Error("simulated network failure")
			}
			return { insertedCount: 1 }
		})
		const eventsBulkWrite = vi.fn().mockResolvedValue({ modifiedCount: 1 })
		const db = {
			collection: vi.fn((name: string) => {
				if (name === `${PREFIX}access_events`) {
					return {
						insertMany: accessInsertMany,
						find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
						aggregate: vi.fn(),
					} as unknown as Collection
				}
				return { bulkWrite: eventsBulkWrite } as unknown as Collection
			}),
		} as unknown as Db

		tracker = new AccessTracker(db, PREFIX, "agent-1", {
			flushThreshold: 100,
			flushIntervalMs: 600_000,
		})

		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-2" })

		// First flush fails — counts MUST be retained in the buffer.
		await tracker.flush()
		expect(attempts).toBe(1)

		// Second flush succeeds — exactly the same counts must be written.
		await tracker.flush()
		expect(attempts).toBe(2)

		const retriedDocs = accessInsertMany.mock.calls[1]?.[0] as Array<{
			memoryId: string
			count: number
		}>
		// Sort by memoryId so the assertion is order-independent.
		retriedDocs.sort((a, b) => a.memoryId.localeCompare(b.memoryId))
		expect(retriedDocs).toEqual([
			expect.objectContaining({
				memoryId: "evt-1",
				count: 2,
			}),
			expect.objectContaining({
				memoryId: "evt-2",
				count: 1,
			}),
		])

		vi.useFakeTimers()
	}, 5_000)

	// =========================================================================
	// W01 — canonical updates must target the owning tenant/scope row.
	// The canonical filter is the collection's unique compound index plus the
	// tracker's agentId; anything less can increment another tenant's row
	// (audit reproduced: recording B's `timezone` incremented A).
	// =========================================================================

	it("W01: structured canonical update filters on the full unique identity", async () => {
		const { db, structuredBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-B", { flushThreshold: 100 })

		tracker.recordAccess({
			collection: "structured_mem",
			id: "timezone",
			scope: "agent",
			scopeRef: "agent:B",
			type: "preference",
		})
		await tracker.flush()

		expect(structuredBulkWrite).toHaveBeenCalledWith(
			[
				{
					updateOne: {
						filter: {
							agentId: "agent-B",
							scope: "agent",
							scopeRef: "agent:B",
							type: "preference",
							key: "timezone",
							appliedBatches: { $ne: expect.any(String) },
						},
						update: {
							$inc: { accessCount: 1 },
							$set: { lastAccessedAt: expect.any(Date) },
							$push: {
								appliedBatches: {
									$each: [expect.any(String)],
									$slice: -32,
								},
							},
						},
					},
				},
			],
			{ ordered: false },
		)
	})

	it("W01: same key in different scopes/types buffers as distinct identities", async () => {
		const { db, structuredBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-B", { flushThreshold: 100 })

		tracker.recordAccess({
			collection: "structured_mem",
			id: "timezone",
			scope: "agent",
			scopeRef: "agent:B",
			type: "preference",
		})
		tracker.recordAccess({
			collection: "structured_mem",
			id: "timezone",
			scope: "user",
			scopeRef: "user:alice",
			type: "preference",
		})
		tracker.recordAccess({
			collection: "structured_mem",
			id: "timezone",
			scope: "agent",
			scopeRef: "agent:B",
			type: "fact",
		})
		await tracker.flush()

		expect(structuredBulkWrite).toHaveBeenCalledTimes(1)
		const ops = structuredBulkWrite.mock.calls[0]?.[0] as Array<{
			updateOne: { filter: Record<string, unknown> }
		}>
		expect(ops).toHaveLength(3)
		const filters = ops.map((op) => op.updateOne.filter)
		expect(filters).toContainEqual({
			agentId: "agent-B",
			scope: "agent",
			scopeRef: "agent:B",
			type: "preference",
			key: "timezone",
			appliedBatches: { $ne: expect.any(String) },
		})
		expect(filters).toContainEqual({
			agentId: "agent-B",
			scope: "user",
			scopeRef: "user:alice",
			type: "preference",
			key: "timezone",
			appliedBatches: { $ne: expect.any(String) },
		})
		expect(filters).toContainEqual({
			agentId: "agent-B",
			scope: "agent",
			scopeRef: "agent:B",
			type: "fact",
			key: "timezone",
			appliedBatches: { $ne: expect.any(String) },
		})
	})

	it("W01: under-specified identity never produces a canonical update (fail-safe)", async () => {
		const { db, accessInsertMany, structuredBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-B", { flushThreshold: 100 })

		// The audit's exact repro shape: key only, no scope/scopeRef/type.
		tracker.recordAccess({ collection: "structured_mem", id: "timezone" })
		await tracker.flush()

		// Raw access history is still recorded (attributed to B)...
		expect(accessInsertMany).toHaveBeenCalledTimes(1)
		expect(accessInsertMany.mock.calls[0]?.[0]).toEqual([
			expect.objectContaining({
				meta: { agentId: "agent-B", collection: "structured_mem" },
				memoryId: "timezone",
				count: 1,
			}),
		])
		// ...but no canonical update is written with a guessable filter.
		expect(structuredBulkWrite).not.toHaveBeenCalled()
	})

	it("W01: partial identity (scope without type) also fails safe", async () => {
		const { db, structuredBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-B", { flushThreshold: 100 })

		tracker.recordAccess({
			collection: "structured_mem",
			id: "timezone",
			scope: "agent",
			scopeRef: "agent:B",
		})
		await tracker.flush()

		expect(structuredBulkWrite).not.toHaveBeenCalled()
	})

	it("W01: procedures, entities, and relations filter on their unique compounds", async () => {
		const { db, proceduresBulkWrite, entitiesBulkWrite, relationsBulkWrite } =
			createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-B", { flushThreshold: 100 })

		tracker.recordAccess({
			collection: "procedures",
			id: "p-1",
			scope: "agent",
			scopeRef: "agent:B",
		})
		tracker.recordAccess({
			collection: "entities",
			id: "e-1",
			scope: "agent",
			scopeRef: "agent:B",
		})
		tracker.recordAccess({
			collection: "relations",
			id: "ent-1:related_to:ent-2",
			scope: "agent",
			scopeRef: "agent:B",
			type: "related_to",
			fromEntityId: "ent-1",
			toEntityId: "ent-2",
		})
		await tracker.flush()

		expect(proceduresBulkWrite).toHaveBeenCalledWith(
			[
				{
					updateOne: {
						filter: {
							procedureId: "p-1",
							agentId: "agent-B",
							scope: "agent",
							scopeRef: "agent:B",
							appliedBatches: { $ne: expect.any(String) },
						},
						update: expect.anything(),
					},
				},
			],
			{ ordered: false },
		)
		expect(entitiesBulkWrite).toHaveBeenCalledWith(
			[
				{
					updateOne: {
						filter: {
							entityId: "e-1",
							agentId: "agent-B",
							scope: "agent",
							scopeRef: "agent:B",
							appliedBatches: { $ne: expect.any(String) },
						},
						update: expect.anything(),
					},
				},
			],
			{ ordered: false },
		)
		expect(relationsBulkWrite).toHaveBeenCalledWith(
			[
				{
					updateOne: {
						filter: {
							agentId: "agent-B",
							scope: "agent",
							scopeRef: "agent:B",
							fromEntityId: "ent-1",
							toEntityId: "ent-2",
							type: "related_to",
							appliedBatches: { $ne: expect.any(String) },
						},
						update: expect.anything(),
					},
				},
			],
			{ ordered: false },
		)
	})

	it("W01: episodes filter on episodeId + agentId", async () => {
		const { db, episodesBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-B", { flushThreshold: 100 })

		tracker.recordAccess({ collection: "episodes", id: "ep-1" })
		await tracker.flush()

		expect(episodesBulkWrite).toHaveBeenCalledWith(
			[
				{
					updateOne: {
						filter: {
							episodeId: "ep-1",
							agentId: "agent-B",
							appliedBatches: { $ne: expect.any(String) },
						},
						update: expect.anything(),
					},
				},
			],
			{ ordered: false },
		)
	})

	it("W01: raw access events carry the identity beyond the short id", async () => {
		const { db, accessInsertMany } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-B", { flushThreshold: 100 })

		tracker.recordAccess({
			collection: "structured_mem",
			id: "timezone",
			scope: "user",
			scopeRef: "user:alice",
			type: "preference",
		})
		await tracker.flush()

		expect(accessInsertMany.mock.calls[0]?.[0]).toEqual([
			expect.objectContaining({
				meta: { agentId: "agent-B", collection: "structured_mem" },
				memoryId: "timezone",
				count: 1,
				scope: "user",
				scopeRef: "user:alice",
				type: "preference",
			}),
		])
	})

	// =========================================================================
	// Access-count durability — fast-check property: no count loss across any
	// sequence of recordAccess calls.
	// Evidence doc:
	// Access-tracking evidence seed: 20260512.
	// =========================================================================
	it("fast-check Property (access-count safety): total flushed $inc count === total recordAccess calls", async () => {
		vi.useRealTimers()
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						id: fc.constantFrom("a", "b", "c", "d", "e"),
						collection: fc.constantFrom(
							"events" as const,
							"structured_mem" as const,
						),
						scope: fc.constantFrom("agent", "user"),
						scopeRef: fc.constantFrom("agent:agent-1", "user:alice"),
						type: fc.constantFrom("fact", "preference"),
					}),
					{ minLength: 0, maxLength: 40 },
				),
				async (calls) => {
					// Per-property run: build a fresh tracker + mock db.
					const eventsBulk = vi.fn().mockResolvedValue({ modifiedCount: 0 })
					const structuredBulk = vi.fn().mockResolvedValue({ modifiedCount: 0 })
					const accessInsertMany = vi
						.fn()
						.mockResolvedValue({ insertedCount: 0 })
					const db = {
						collection: vi.fn((name: string) => {
							if (name === `${PREFIX}access_events`) {
								return {
									insertMany: accessInsertMany,
									aggregate: vi.fn(),
								} as unknown as Collection
							}
							if (name === `${PREFIX}events`) {
								return {
									bulkWrite: eventsBulk,
								} as unknown as Collection
							}
							if (name === `${PREFIX}structured_mem`) {
								return {
									bulkWrite: structuredBulk,
								} as unknown as Collection
							}
							return {
								bulkWrite: vi.fn().mockResolvedValue({}),
							} as unknown as Collection
						}),
					} as unknown as Db

					const localTracker = new AccessTracker(db, PREFIX, "agent-1", {
						flushThreshold: 100_000,
						flushIntervalMs: 600_000,
					})
					try {
						for (const call of calls) {
							// Full identity for structured rows; events need only
							// the id (eventId is globally unique per collection).
							localTracker.recordAccess(
								call.collection === "events"
									? { collection: "events", id: call.id }
									: {
											collection: "structured_mem",
											id: call.id,
											scope: call.scope,
											scopeRef: call.scopeRef,
											type: call.type,
										},
							)
						}
						await localTracker.flush()

						// Sum $inc.accessCount across all bulk write ops. MUST equal
						// calls.length (monotonic, lossless).
						const sumFromBulk = (bulk: ReturnType<typeof vi.fn>): number => {
							let total = 0
							for (const callArgs of bulk.mock.calls) {
								const ops = callArgs[0] as Array<{
									updateOne: {
										update: { $inc: { accessCount: number } }
									}
								}>
								for (const op of ops) {
									total += op.updateOne.update.$inc.accessCount
								}
							}
							return total
						}
						const total = sumFromBulk(eventsBulk) + sumFromBulk(structuredBulk)
						expect(total).toBe(calls.length)
					} finally {
						await localTracker.close()
					}
				},
			),
			{ seed: 20260512, numRuns: 200 },
		)
		vi.useFakeTimers()
	}, 30_000)
})

// ===========================================================================
// W11 — batchId-guarded exactly-once flush.
// A minimal MongoDB-semantics simulation applies the guarded updateOne ops:
// exact-equality filters, $ne against scalars AND arrays (element
// containment, EL-029), $inc/$set/$push with $each + $slice bounding
// (EL-030/EL-031). The invariants under test hold for any sequence of
// partial failures: raw evidence exactly once, canonical counts exactly
// once.
// ===========================================================================
describe("AccessTracker W11 — batchId-guarded exactly-once flush", () => {
	let tracker: AccessTracker | null = null

	afterEach(() => {
		if (tracker) {
			return tracker.close().finally(() => {
				tracker = null
			})
		}
	})

	type StoredDoc = Record<string, unknown>

	function makeGuardedStore(seedDocs: StoredDoc[]) {
		const docs: StoredDoc[] = seedDocs.map((doc) => ({ ...doc }))
		const bulkWrite = vi.fn(
			async (
				ops: Array<{
					updateOne: {
						filter: Record<string, unknown>
						update: Record<string, unknown>
					}
				}>,
			) => {
				let modifiedCount = 0
				for (const op of ops) {
					const { filter, update } = op.updateOne
					const doc = docs.find((candidate) =>
						Object.entries(filter).every(([field, expected]) => {
							if (
								expected !== null &&
								typeof expected === "object" &&
								!Array.isArray(expected) &&
								"$ne" in expected
							) {
								const ne = (expected as { $ne: unknown }).$ne
								const value = candidate[field]
								// EL-029: scalar $ne matches documents without the
								// field; against arrays it matches where the scalar
								// is not an element.
								return Array.isArray(value) ? !value.includes(ne) : value !== ne
							}
							return candidate[field] === expected
						}),
					)
					if (!doc) {
						continue
					}
					const inc = (update.$inc ?? {}) as Record<string, number>
					for (const [field, by] of Object.entries(inc)) {
						doc[field] = (typeof doc[field] === "number" ? doc[field] : 0) + by
					}
					const set = (update.$set ?? {}) as Record<string, unknown>
					for (const [field, value] of Object.entries(set)) {
						doc[field] = value
					}
					const push = (update.$push ?? {}) as Record<
						string,
						{ $each?: unknown[]; $slice?: number }
					>
					for (const [field, mod] of Object.entries(push)) {
						const each = mod.$each ?? []
						const existing = Array.isArray(doc[field])
							? (doc[field] as unknown[])
							: []
						const next = [...existing, ...each]
						doc[field] =
							mod.$slice !== undefined && mod.$slice < 0
								? next.slice(mod.$slice)
								: next
					}
					modifiedCount++
				}
				return { modifiedCount }
			},
		)
		return { docs, bulkWrite }
	}

	function buildRetryDb(params: {
		store: ReturnType<typeof makeGuardedStore>
		eventsBulkWrite: ReturnType<typeof vi.fn>
	}) {
		// The raw layer: inserts append to `rawDocs` (so the retry's
		// read-reconcile finds the first batch present, as a real
		// access_events collection would), find returns them.
		const rawDocs: Array<Record<string, unknown>> = []
		const accessInsertMany = vi.fn(
			async (docs: Array<Record<string, unknown>>) => {
				for (const doc of docs) {
					rawDocs.push({ ...doc })
				}
				return { insertedCount: docs.length }
			},
		)
		const accessFind = vi.fn(() => ({
			toArray: vi.fn(async () => rawDocs),
		}))
		const db = {
			collection: vi.fn((name: string) => {
				if (name === `${PREFIX}access_events`) {
					return {
						insertMany: accessInsertMany,
						find: accessFind,
						aggregate: vi.fn(),
					} as unknown as Collection
				}
				if (name === `${PREFIX}events`) {
					return {
						bulkWrite: params.eventsBulkWrite,
					} as unknown as Collection
				}
				return {
					bulkWrite: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
				} as unknown as Collection
			}),
		} as unknown as Db
		return { db, accessInsertMany, accessFind, rawDocs }
	}

	it("retries a canonical failure exactly once at both layers", async () => {
		vi.useRealTimers()
		const store = makeGuardedStore([
			{ eventId: "evt-1", agentId: "agent-1", accessCount: 0 },
			{ eventId: "evt-2", agentId: "agent-1", accessCount: 0 },
		])
		let bulkCalls = 0
		const eventsBulkWrite = vi.fn(async (ops: unknown[]) => {
			bulkCalls++
			if (bulkCalls === 1) {
				throw new Error("simulated canonical failure")
			}
			return store.bulkWrite(ops as Parameters<typeof store.bulkWrite>[0])
		})
		const { db, accessInsertMany, accessFind } = buildRetryDb({
			store,
			eventsBulkWrite,
		})

		tracker = new AccessTracker(db, PREFIX, "agent-1", {
			flushThreshold: 100,
			flushIntervalMs: 600_000,
		})
		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-2" })

		// First flush: raw insert succeeds, canonical bulkWrite fails — the
		// whole snapshot re-buffers (batchIds preserved).
		await tracker.flush()
		// Second flush: raw read-reconcile finds the first batch present and
		// skips the insert; the canonical retry applies the guarded ops.
		await tracker.flush()

		// Raw layer: exactly one insertMany for the batch.
		expect(accessInsertMany).toHaveBeenCalledTimes(1)
		const inserted = accessInsertMany.mock.calls[0]?.[0] as Array<{
			memoryId: string
			count: number
			batchId: string
		}>
		expect(inserted).toHaveLength(2)
		expect(inserted.every((doc) => typeof doc.batchId === "string")).toBe(true)
		// The reconcile read ran exactly once (on the retry flush only).
		expect(accessFind).toHaveBeenCalledTimes(1)

		// Canonical layer: exactly once despite the retry.
		expect(store.docs.find((doc) => doc.eventId === "evt-1")).toMatchObject({
			accessCount: 2,
		})
		expect(store.docs.find((doc) => doc.eventId === "evt-2")).toMatchObject({
			accessCount: 1,
		})
		expect(
			store.docs.find((doc) => doc.eventId === "evt-1")?.appliedBatches,
		).toHaveLength(1)
		expect(
			store.docs.find((doc) => doc.eventId === "evt-2")?.appliedBatches,
		).toHaveLength(1)

		vi.useFakeTimers()
	}, 5_000)

	it("no-matches already-applied ops when an unordered bulk failed partway", async () => {
		vi.useRealTimers()
		const store = makeGuardedStore([
			{ eventId: "evt-1", agentId: "agent-1", accessCount: 0 },
			{ eventId: "evt-2", agentId: "agent-1", accessCount: 0 },
		])
		let bulkCalls = 0
		const eventsBulkWrite = vi.fn(async (ops: unknown[]) => {
			bulkCalls++
			if (bulkCalls === 1) {
				// Unordered bulk: the first op APPLIES, then the batch fails —
				// the worst case the guard exists for.
				const first = (ops as Parameters<typeof store.bulkWrite>[0])[0]
				await store.bulkWrite([first])
				throw new Error("simulated partial canonical failure")
			}
			return store.bulkWrite(ops as Parameters<typeof store.bulkWrite>[0])
		})
		const { db, accessInsertMany } = buildRetryDb({
			store,
			eventsBulkWrite,
		})

		tracker = new AccessTracker(db, PREFIX, "agent-1", {
			flushThreshold: 100,
			flushIntervalMs: 600_000,
		})
		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-2" })

		await tracker.flush()
		await tracker.flush()

		// Raw exactly once; evt-1's op applied before the failure, evt-2's
		// applied on the guarded retry — neither double-applied.
		expect(accessInsertMany).toHaveBeenCalledTimes(1)
		expect(store.docs.find((doc) => doc.eventId === "evt-1")).toMatchObject({
			accessCount: 1,
		})
		expect(store.docs.find((doc) => doc.eventId === "evt-2")).toMatchObject({
			accessCount: 1,
		})
		expect(
			store.docs.find((doc) => doc.eventId === "evt-1")?.appliedBatches,
		).toHaveLength(1)
		expect(
			store.docs.find((doc) => doc.eventId === "evt-2")?.appliedBatches,
		).toHaveLength(1)

		vi.useFakeTimers()
	}, 5_000)

	it("keeps counts from a re-buffered batch and a fresh batch separate", async () => {
		vi.useRealTimers()
		const store = makeGuardedStore([
			{ eventId: "evt-1", agentId: "agent-1", accessCount: 0 },
		])
		let bulkCalls = 0
		const eventsBulkWrite = vi.fn(async (ops: unknown[]) => {
			bulkCalls++
			if (bulkCalls === 1) {
				throw new Error("simulated canonical failure")
			}
			return store.bulkWrite(ops as Parameters<typeof store.bulkWrite>[0])
		})
		const { db, accessInsertMany, rawDocs } = buildRetryDb({
			store,
			eventsBulkWrite,
		})

		tracker = new AccessTracker(db, PREFIX, "agent-1", {
			flushThreshold: 100,
			flushIntervalMs: 600_000,
		})
		tracker.recordAccess({ collection: "events", id: "evt-1" })
		tracker.recordAccess({ collection: "events", id: "evt-1" })
		await tracker.flush() // raw inserted for batch B; canonical fails

		// A NEW access while the failed batch waits for retry — it must start
		// a fresh entry, not merge into the committed batch B entry.
		tracker.recordAccess({ collection: "events", id: "evt-1" })
		await tracker.flush()

		// Raw: batch B skipped (present), only the fresh batch's doc inserted.
		expect(accessInsertMany).toHaveBeenCalledTimes(2)
		const firstBatchId = (
			accessInsertMany.mock.calls[0]?.[0] as Array<{ batchId: string }>
		)[0]?.batchId
		const secondDocs = accessInsertMany.mock.calls[1]?.[0] as Array<{
			count: number
			batchId: string
		}>
		expect(secondDocs).toHaveLength(1)
		expect(secondDocs[0]?.count).toBe(1)
		expect(secondDocs[0]?.batchId).not.toBe(firstBatchId)
		expect(rawDocs).toHaveLength(2)

		// Canonical: both ops applied — 2 from batch B, 1 from the fresh
		// batch; the counts land exactly once each.
		expect(store.docs.find((doc) => doc.eventId === "evt-1")).toMatchObject({
			accessCount: 3,
		})
		expect(
			store.docs.find((doc) => doc.eventId === "evt-1")?.appliedBatches,
		).toHaveLength(2)

		vi.useFakeTimers()
	}, 5_000)

	it("bounds the appliedBatches window and skips the reconcile read on fresh flushes", async () => {
		vi.useRealTimers()
		const store = makeGuardedStore([
			{ eventId: "evt-1", agentId: "agent-1", accessCount: 0 },
		])
		const eventsBulkWrite = vi.fn((ops: unknown[]) =>
			store.bulkWrite(ops as Parameters<typeof store.bulkWrite>[0]),
		)
		const { db, accessInsertMany, accessFind } = buildRetryDb({
			store,
			eventsBulkWrite,
		})

		tracker = new AccessTracker(db, PREFIX, "agent-1", {
			flushThreshold: 100,
			flushIntervalMs: 600_000,
		})
		// 40 successful single-access flushes: 40 distinct applied batches on
		// one document — the $slice: -32 window must keep only the newest 32.
		for (let i = 0; i < 40; i++) {
			tracker.recordAccess({ collection: "events", id: "evt-1" })
			await tracker.flush()
		}

		const doc = store.docs.find((candidate) => candidate.eventId === "evt-1")
		expect(doc).toMatchObject({ accessCount: 40 })
		expect(doc?.appliedBatches).toHaveLength(32)
		// Steady-state cost is unchanged: a fresh flush (no re-buffered
		// entries) never runs the read-reconcile find.
		expect(accessFind).not.toHaveBeenCalled()
		expect(accessInsertMany).toHaveBeenCalledTimes(40)

		vi.useFakeTimers()
	}, 15_000)
})

// ===========================================================================
// W01 — canonicalId -> full access identity parsing (recordSearchAccess path).
// ===========================================================================
describe("accessTargetFromSearchResult", () => {
	it("parses structured canonicalIds into key + type + scope identity", () => {
		expect(
			accessTargetFromSearchResult({
				canonicalId: "structured:preference:timezone",
				scope: "agent",
				scopeRef: "agent:B",
			}),
		).toEqual({
			collection: "structured_mem",
			id: "timezone",
			type: "preference",
			scope: "agent",
			scopeRef: "agent:B",
		})
	})

	it("parses structured keys that contain colons (readFile convention)", () => {
		expect(
			accessTargetFromSearchResult({
				canonicalId: "structured:fact:tz:UTC:plus:2",
				scope: "user",
				scopeRef: "user:alice",
			}),
		).toEqual({
			collection: "structured_mem",
			id: "tz:UTC:plus:2",
			type: "fact",
			scope: "user",
			scopeRef: "user:alice",
		})
	})

	it("falls back to a ?scope=&scopeRef= canonicalId suffix when result fields are absent", () => {
		expect(
			accessTargetFromSearchResult({
				canonicalId: "structured:preference:timezone?scope=user&scopeRef=alice",
			}),
		).toEqual({
			collection: "structured_mem",
			id: "timezone",
			type: "preference",
			scope: "user",
			scopeRef: "alice",
		})
	})

	it("parses relation canonicalIds into the edge identity", () => {
		expect(
			accessTargetFromSearchResult({
				canonicalId: "relation:ent-1:related_to:ent-2",
				scope: "agent",
				scopeRef: "agent:B",
			}),
		).toEqual({
			collection: "relations",
			id: "ent-1:related_to:ent-2",
			fromEntityId: "ent-1",
			type: "related_to",
			toEntityId: "ent-2",
			scope: "agent",
			scopeRef: "agent:B",
		})
	})

	it("parses event, episode, entity, and procedure canonicalIds", () => {
		expect(
			accessTargetFromSearchResult({ canonicalId: "event:evt-1" }),
		).toEqual({ collection: "events", id: "evt-1" })
		expect(
			accessTargetFromSearchResult({
				canonicalId: "episode:ep-1",
				scope: "agent",
				scopeRef: "agent:B",
			}),
		).toEqual({
			collection: "episodes",
			id: "ep-1",
			scope: "agent",
			scopeRef: "agent:B",
		})
		expect(
			accessTargetFromSearchResult({
				canonicalId: "entity:ent-9",
				scope: "user",
				scopeRef: "user:alice",
			}),
		).toEqual({
			collection: "entities",
			id: "ent-9",
			scope: "user",
			scopeRef: "user:alice",
		})
		expect(
			accessTargetFromSearchResult({
				canonicalId: "procedure:p-1",
				scope: "agent",
				scopeRef: "agent:B",
			}),
		).toEqual({
			collection: "procedures",
			id: "p-1",
			scope: "agent",
			scopeRef: "agent:B",
		})
	})

	it("returns null for unusable identities rather than guessing", () => {
		// No canonicalId at all (pre-fix structured results).
		expect(accessTargetFromSearchResult({})).toBeNull()
		// Unknown prefix.
		expect(accessTargetFromSearchResult({ canonicalId: "banana:1" })).toBeNull()
		// No colon separator.
		expect(accessTargetFromSearchResult({ canonicalId: "event" })).toBeNull()
		// Empty id.
		expect(accessTargetFromSearchResult({ canonicalId: "event:" })).toBeNull()
		// Structured with no key segment.
		expect(
			accessTargetFromSearchResult({ canonicalId: "structured:fact" }),
		).toBeNull()
		// Relation with the wrong segment count.
		expect(
			accessTargetFromSearchResult({
				canonicalId: "relation:ent-1:related_to",
			}),
		).toBeNull()
		expect(
			accessTargetFromSearchResult({
				canonicalId: "relation:ent-1:related_to:ent-2:extra",
			}),
		).toBeNull()
	})
})

describe("access event aggregation helpers", () => {
	it("maps access summaries from time-series aggregation rows", async () => {
		const { db, accessCollection } = createMockDb()
		const toArray = vi.fn().mockResolvedValue([
			{
				_id: "evt-1",
				accessCount: 7,
				lastAccessedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
		;(
			accessCollection.aggregate as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue({ toArray })

		const out = await getAccessSummaries({
			db,
			prefix: PREFIX,
			agentId: "agent-1",
			collection: "events",
			memoryIds: ["evt-1"],
		})

		expect(out).toEqual([
			{
				memoryId: "evt-1",
				collection: "events",
				accessCount: 7,
				lastAccessedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
	})

	it("returns rolling access trends via $setWindowFields aggregation", async () => {
		const { db, accessCollection } = createMockDb()
		const aggregate = accessCollection.aggregate as unknown as ReturnType<
			typeof vi.fn
		>
		aggregate
			.mockReturnValueOnce({
				toArray: vi.fn().mockResolvedValue([
					{
						_id: { collection: "events", memoryId: "evt-1" },
						totalCount: 9,
					},
				]),
			})
			.mockReturnValueOnce({
				toArray: vi.fn().mockResolvedValue([
					{
						collection: "events",
						memoryId: "evt-1",
						day: new Date("2026-04-09T00:00:00.000Z"),
						count: 3,
						rolling7dCount: 9,
						lastAccessedAt: new Date("2026-04-09T10:00:00.000Z"),
					},
				]),
			})

		const out = await getAccessTrends({
			db,
			prefix: PREFIX,
			agentId: "agent-1",
			collection: "events",
			limit: 5,
		})

		expect(out).toEqual([
			{
				collection: "events",
				memoryId: "evt-1",
				day: new Date("2026-04-09T00:00:00.000Z"),
				count: 3,
				rolling7dCount: 9,
				lastAccessedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
		expect(aggregate).toHaveBeenCalledTimes(2)
	})
})
