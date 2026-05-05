import type { Collection, Db } from "mongodb"
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
