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
	getAccessSummaries,
	getAccessTrends,
} from "./mongodb-access-tracker.js"

const PREFIX = "test_"

function createMockDb() {
	const accessInsertMany = vi.fn().mockResolvedValue({ insertedCount: 0 })
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

		tracker.recordAccess("evt-1", "events")
		tracker.recordAccess("evt-2", "events")
		tracker.recordAccess("evt-3", "events")

		expect(accessInsertMany).not.toHaveBeenCalled()
		expect(eventsBulkWrite).not.toHaveBeenCalled()
	})

	it("flushes time-series events and computed summaries when threshold is reached", async () => {
		const { db, accessInsertMany, eventsBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 3 })

		tracker.recordAccess("evt-1", "events")
		tracker.recordAccess("evt-2", "events")
		tracker.recordAccess("evt-3", "events")
		await tracker.flush()

		expect(accessInsertMany).toHaveBeenCalledTimes(1)
		expect(eventsBulkWrite).toHaveBeenCalledTimes(1)
	})

	it("accumulates counts for the same document before flush", async () => {
		const { db, accessInsertMany, eventsBulkWrite } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 100 })

		for (let i = 0; i < 5; i++) {
			tracker.recordAccess("evt-1", "events")
		}

		await tracker.flush()

		expect(accessInsertMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					meta: {
						agentId: "agent-1",
						collection: "events",
						memoryId: "evt-1",
					},
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
						filter: { eventId: "evt-1" },
						update: {
							$inc: { accessCount: 5 },
							$set: { lastAccessedAt: expect.any(Date) },
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

		tracker.recordAccess("evt-1", "events")
		tracker.recordAccess("fact-1", "structured_mem")
		tracker.recordAccess("proc-1", "procedures")

		await tracker.flush()

		expect(accessInsertMany).toHaveBeenCalledTimes(1)
		expect(eventsBulkWrite).toHaveBeenCalledTimes(1)
		expect(structuredBulkWrite).toHaveBeenCalledTimes(1)
		expect(proceduresBulkWrite).toHaveBeenCalledTimes(1)
	})

	it("close() clears the timer and flushes remaining events", async () => {
		const { db, accessInsertMany } = createMockDb()
		tracker = new AccessTracker(db, PREFIX, "agent-1", { flushThreshold: 100 })

		tracker.recordAccess("evt-1", "events")
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
			tracker.recordAccess("evt-1", "events")
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

		tracker.recordAccess("evt-1", "events")
		tracker.recordAccess("evt-1", "events")
		tracker.recordAccess("evt-2", "events")

		// First flush fails — counts MUST be retained in the buffer.
		await tracker.flush()
		expect(attempts).toBe(1)

		// Second flush succeeds — exactly the same counts must be written.
		await tracker.flush()
		expect(attempts).toBe(2)

		const retriedDocs = accessInsertMany.mock.calls[1]?.[0] as Array<{
			meta: { memoryId: string }
			count: number
		}>
		// Sort by memoryId so the assertion is order-independent.
		retriedDocs.sort((a, b) => a.meta.memoryId.localeCompare(b.meta.memoryId))
		expect(retriedDocs).toEqual([
			expect.objectContaining({
				meta: expect.objectContaining({ memoryId: "evt-1" }),
				count: 2,
			}),
			expect.objectContaining({
				meta: expect.objectContaining({ memoryId: "evt-2" }),
				count: 1,
			}),
		])

		vi.useFakeTimers()
	}, 5_000)

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
							localTracker.recordAccess(call.id, call.collection)
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
