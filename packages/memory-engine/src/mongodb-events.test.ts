/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Db } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the schema module before imports
vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
	chunksCollection: vi.fn(),
	projectionRunsCollection: vi.fn(() => ({
		insertOne: vi.fn(async () => ({ acknowledged: true })),
	})),
	telemetryCollection: vi.fn(() => ({
		insertOne: vi.fn(async () => ({ acknowledged: true })),
	})),
}))

import {
	writeEvent,
	getEventsByTimeRange,
	getEventsBySession,
	getUnprojectedEvents,
	markEventsProjected,
	markEventsConsolidated,
	getUnconsolidatedEvents,
	projectChunksFromEvents,
	getSessionEventsWithBound,
	isTransientMongoWriteError,
	type CanonicalEvent,
} from "./mongodb-events.js"
import { eventsCollection, chunksCollection } from "./mongodb-schema.js"

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockEventsCol(): Collection {
	return {
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "new-id",
			modifiedCount: 0,
		})),
		updateMany: vi.fn(async () => ({
			modifiedCount: 0,
		})),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		})),
	} as unknown as Collection
}

function createMockChunksCol(): Collection {
	return {
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "chunk-id",
			modifiedCount: 0,
		})),
	} as unknown as Collection
}

function mockDb(): Db {
	return {} as unknown as Db
}

// ---------------------------------------------------------------------------
// Tests: writeEvent
// ---------------------------------------------------------------------------

describe("writeEvent", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("inserts an event and returns the eventId", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(result.eventId).toBeDefined()
		expect(typeof result.eventId).toBe("string")
		expect(result.eventId.length).toBeGreaterThan(0)

		// Verify upsert was called with $setOnInsert
		expect(col.updateOne).toHaveBeenCalledOnce()
		const [filter, update, opts] = vi.mocked(col.updateOne).mock.calls[0]
		expect(filter).toEqual({ eventId: result.eventId })
		expect(update).toHaveProperty("$setOnInsert")
		expect(opts).toEqual({ upsert: true })

		// Verify the doc has correct fields
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.agentId).toBe("agent-1")
		expect(doc.role).toBe("user")
		expect(doc.body).toBe("Hello world")
		expect(doc.scope).toBe("agent")
		expect(doc.timestamp).toBeInstanceOf(Date)
	})

	it("with duplicate eventId is idempotent", async () => {
		const col = createMockEventsCol()
		vi.mocked(col.updateOne).mockResolvedValue({
			upsertedCount: 0,
			upsertedId: null,
			modifiedCount: 0,
			matchedCount: 1,
			acknowledged: true,
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				eventId: "existing-id",
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(result.eventId).toBe("existing-id")
		// updateOne was called (idempotent upsert, not an error)
		expect(col.updateOne).toHaveBeenCalledOnce()
	})

	it("retries transient MongoDB write errors with the same eventId", async () => {
		vi.useFakeTimers()
		const col = createMockEventsCol()
		vi.mocked(col.updateOne)
			.mockRejectedValueOnce(
				Object.assign(
					new Error(
						"Connection to memongo-shard interrupted due to server monitor timeout",
					),
					{ name: "MongoNetworkError" },
				),
			)
			.mockResolvedValueOnce({
				upsertedCount: 1,
				upsertedId: "new-id",
				modifiedCount: 0,
				matchedCount: 0,
				acknowledged: true,
			})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const promise = writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})
		await vi.advanceTimersByTimeAsync(1_000)
		const result = await promise
		vi.useRealTimers()

		expect(result.eventId).toBeDefined()
		expect(col.updateOne).toHaveBeenCalledTimes(2)
		const [firstFilter] = vi.mocked(col.updateOne).mock.calls[0]
		const [secondFilter] = vi.mocked(col.updateOne).mock.calls[1]
		expect(secondFilter).toEqual(firstFilter)
	})

	it("classifies retryable MongoDB write labels as transient", () => {
		const err = {
			hasErrorLabel: (label: string) => label === "NoWritesPerformed",
		}

		expect(isTransientMongoWriteError(err)).toBe(true)
		expect(isTransientMongoWriteError(new Error("getaddrinfo ENOTFOUND"))).toBe(
			true,
		)
		expect(isTransientMongoWriteError(new Error("ReplicaSetNoPrimary"))).toBe(
			true,
		)
		expect(isTransientMongoWriteError(new Error("connect ECONNREFUSED"))).toBe(
			true,
		)
		expect(isTransientMongoWriteError(new Error("duplicate key"))).toBe(false)
	})

	it("defaults scope to agent when not provided", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "assistant",
				body: "Response",
			} as Parameters<typeof writeEvent>[0]["event"],
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.scope).toBe("agent")
	})

	it("preserves optional fields when provided", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Hello",
				scope: "session",
				scopeRef: "session:sess-1",
				sessionId: "sess-123",
				channel: "discord",
				metadata: { key: "value" },
			},
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.sessionId).toBe("sess-123")
		expect(doc.channel).toBe("discord")
		expect(doc.metadata).toEqual({ key: "value" })
	})
})

// ---------------------------------------------------------------------------
// Tests: getEventsByTimeRange
// ---------------------------------------------------------------------------

describe("getEventsByTimeRange", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns events in timestamp order within range", async () => {
		const now = new Date()
		const earlier = new Date(now.getTime() - 60000)
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				role: "user",
				body: "First",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: earlier,
			},
			{
				eventId: "e2",
				agentId: "agent-1",
				role: "assistant",
				body: "Second",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: now,
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const start = new Date(now.getTime() - 120000)
		const end = new Date(now.getTime() + 1000)
		const result = await getEventsByTimeRange({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			start,
			end,
		})

		expect(result).toHaveLength(2)
		expect(result[0].eventId).toBe("e1")
		expect(result[1].eventId).toBe("e2")

		// Verify filter
		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			timestamp: { $gte: start, $lte: end },
		})
		expect(sortFn).toHaveBeenCalledWith({ timestamp: 1, _id: 1 })
		expect(limitFn).toHaveBeenCalledWith(1000) // default limit
	})

	it("applies scope filter when provided", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const start = new Date("2025-01-01")
		const end = new Date("2025-12-31")
		await getEventsByTimeRange({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			start,
			end,
			scope: "session",
			scopeRef: "session:sess-1",
		})

		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			timestamp: { $gte: start, $lte: end },
			scope: "session",
			scopeRef: "session:sess-1",
		})
	})
})

// ---------------------------------------------------------------------------
// Tests: getEventsBySession
// ---------------------------------------------------------------------------

describe("getEventsBySession", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("filters by agentId and sessionId", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				sessionId: "sess-1",
				role: "user",
				body: "Hello",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await getEventsBySession({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			sessionId: "sess-1",
		})

		expect(result).toHaveLength(1)
		expect(result[0].sessionId).toBe("sess-1")
		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			sessionId: "sess-1",
		})
		expect(sortFn).toHaveBeenCalledWith({ timestamp: 1, _id: 1 })
	})
})

// ---------------------------------------------------------------------------
// Tests: getUnprojectedEvents
// ---------------------------------------------------------------------------

describe("getUnprojectedEvents", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns events where projectedAt does not exist", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				role: "user",
				body: "Unprojected",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await getUnprojectedEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result).toHaveLength(1)
		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			projectedAt: { $exists: false },
		})
		expect(limitFn).toHaveBeenCalledWith(500) // default limit
	})
})

// ---------------------------------------------------------------------------
// Tests: markEventsProjected
// ---------------------------------------------------------------------------

describe("markEventsProjected", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("sets projectedAt on given eventIds", async () => {
		const col = createMockEventsCol()
		vi.mocked(col.updateMany).mockResolvedValue({
			modifiedCount: 3,
			matchedCount: 3,
			upsertedCount: 0,
			upsertedId: null,
			acknowledged: true,
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await markEventsProjected({
			db: mockDb(),
			prefix: "test_",
			eventIds: ["e1", "e2", "e3"],
		})

		expect(result).toBe(3)
		expect(col.updateMany).toHaveBeenCalledOnce()
		const [filter, update] = vi.mocked(col.updateMany).mock.calls[0]
		expect(filter).toEqual({ eventId: { $in: ["e1", "e2", "e3"] } })
		expect(update).toHaveProperty("$set")
		const setClause = (update as Record<string, Record<string, unknown>>).$set
		expect(setClause.projectedAt).toBeInstanceOf(Date)
	})

	it("returns 0 for empty eventIds array", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await markEventsProjected({
			db: mockDb(),
			prefix: "test_",
			eventIds: [],
		})

		expect(result).toBe(0)
		expect(col.updateMany).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Tests: projectChunksFromEvents
// ---------------------------------------------------------------------------

describe("projectChunksFromEvents", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("creates chunks and marks events as projected", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "evt-1",
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
			{
				eventId: "evt-2",
				agentId: "agent-1",
				role: "assistant",
				body: "Hi there",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		// Events collection mock
		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(async () => ({
				modifiedCount: 2,
				matchedCount: 2,
				upsertedCount: 0,
				upsertedId: null,
				acknowledged: true,
			})),
			updateOne: vi.fn(async () => ({
				upsertedCount: 1,
				upsertedId: "new-id",
				modifiedCount: 0,
			})),
		} as unknown as Collection

		// Chunks collection mock
		const chunkCol = createMockChunksCol()

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		const result = await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result.eventsProcessed).toBe(2)
		expect(result.chunksCreated).toBe(2)

		// Verify chunks were created with correct path and source
		expect(chunkCol.updateOne).toHaveBeenCalledTimes(2)
		const firstCall = vi.mocked(chunkCol.updateOne).mock.calls[0]
		const firstFilter = firstCall[0] as Record<string, unknown>
		expect(firstFilter.path).toBe("events/evt-1")

		const firstUpdate = firstCall[1] as Record<string, Record<string, unknown>>
		const firstDoc = firstUpdate.$setOnInsert
		expect(firstDoc.source).toBe("conversation")
		expect(firstDoc.text).toBe("User: Hello world")
		expect(typeof firstDoc.hash).toBe("string")

		// Verify events were marked as projected per projected event.
		expect(eventCol.updateMany).toHaveBeenCalledTimes(2)
	})

	it("with zero unprojected events is a no-op", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(),
			updateOne: vi.fn(),
		} as unknown as Collection

		const chunkCol = createMockChunksCol()

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		const result = await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result.eventsProcessed).toBe(0)
		expect(result.chunksCreated).toBe(0)
		expect(chunkCol.updateOne).not.toHaveBeenCalled()
		expect(eventCol.updateMany).not.toHaveBeenCalled()
	})

	it("projected chunks have correct source and path format", async () => {
		const eventTimestamp = new Date("2025-01-01T12:00:00.000Z")
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "abc-def-123",
				agentId: "agent-1",
				role: "user",
				body: "Test content",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: eventTimestamp,
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(async () => ({
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
				acknowledged: true,
			})),
			updateOne: vi.fn(),
		} as unknown as Collection

		const chunkCol = createMockChunksCol()

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		const call = vi.mocked(chunkCol.updateOne).mock.calls[0]
		const filter = call[0] as Record<string, unknown>
		expect(filter.path).toBe("events/abc-def-123")

		const update = call[1] as Record<string, Record<string, unknown>>
		const doc = update.$setOnInsert
		expect(doc.source).toBe("conversation")
		expect(doc.path).toBe("events/abc-def-123")
		expect(doc.agentId).toBe("agent-1")
		expect(doc.timestamp).toEqual(eventTimestamp)
	})

	it("only counts chunksCreated when upsertedCount > 0 (not duplicates)", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "evt-new",
				agentId: "agent-1",
				role: "user",
				body: "New event",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
			{
				eventId: "evt-dup",
				agentId: "agent-1",
				role: "assistant",
				body: "Duplicate event",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(async () => ({
				modifiedCount: 2,
				matchedCount: 2,
				upsertedCount: 0,
				upsertedId: null,
				acknowledged: true,
			})),
			updateOne: vi.fn(),
		} as unknown as Collection

		// First call: upsert (new chunk), second call: no upsert (duplicate)
		const chunkCol = {
			updateOne: vi
				.fn()
				.mockResolvedValueOnce({
					upsertedCount: 1,
					upsertedId: "new-id",
					modifiedCount: 0,
				})
				.mockResolvedValueOnce({
					upsertedCount: 0,
					upsertedId: null,
					modifiedCount: 0,
				}),
		} as unknown as Collection

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		const result = await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result.eventsProcessed).toBe(2)
		// Only 1 chunk was actually created (the other was a duplicate)
		expect(result.chunksCreated).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// Tests: markEventsConsolidated
// ---------------------------------------------------------------------------

describe("markEventsConsolidated", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("marks events with consolidatedAt and episodeId", async () => {
		const col = createMockEventsCol()
		vi.mocked(col.updateMany).mockResolvedValue({
			modifiedCount: 3,
			matchedCount: 3,
			upsertedCount: 0,
			upsertedId: null,
			acknowledged: true,
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await markEventsConsolidated({
			db: mockDb(),
			prefix: "test_",
			eventIds: ["e1", "e2", "e3"],
			episodeId: "ep-123",
		})

		expect(result).toBe(3)
		expect(col.updateMany).toHaveBeenCalledOnce()
		const [filter, update] = vi.mocked(col.updateMany).mock.calls[0]
		expect(filter).toEqual({ eventId: { $in: ["e1", "e2", "e3"] } })
		expect(update).toHaveProperty("$set")
		const setClause = (update as Record<string, Record<string, unknown>>).$set
		expect(setClause.consolidatedAt).toBeInstanceOf(Date)
		expect(setClause.consolidatedIntoEpisodeId).toBe("ep-123")
	})

	it("returns 0 for empty eventIds array", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await markEventsConsolidated({
			db: mockDb(),
			prefix: "test_",
			eventIds: [],
			episodeId: "ep-123",
		})

		expect(result).toBe(0)
		expect(col.updateMany).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Tests: getUnconsolidatedEvents
// ---------------------------------------------------------------------------

describe("getUnconsolidatedEvents", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns events without consolidatedAt field", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				role: "user",
				body: "Unconsolidated",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await getUnconsolidatedEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result).toHaveLength(1)
		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			consolidatedAt: { $exists: false },
		})
		expect(limitFn).toHaveBeenCalledWith(500) // default limit
	})

	it("applies optional scope filter", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await getUnconsolidatedEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			scope: "session",
			scopeRef: "session:sess-1",
		})

		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			consolidatedAt: { $exists: false },
			scope: "session",
			scopeRef: "session:sess-1",
		})
	})

	it("applies optional limit", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await getUnconsolidatedEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			limit: 10,
		})

		expect(limitFn).toHaveBeenCalledWith(10)
	})
})

// ---------------------------------------------------------------------------
// Tests: getSessionEventsWithBound (Phase 6 — Working Memory Bounds)
// ---------------------------------------------------------------------------

describe("getSessionEventsWithBound", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns at most bound events", async () => {
		const mockEvents: CanonicalEvent[] = Array.from({ length: 5 }, (_, i) => ({
			eventId: `e${i}`,
			agentId: "agent-1",
			sessionId: "sess-1",
			role: "user" as const,
			body: `Message ${i}`,
			scope: "agent" as const,
			scopeRef: "agent:agent-1",
			timestamp: new Date(2025, 0, 1, 0, i),
		}))

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await getSessionEventsWithBound({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			sessionId: "sess-1",
			bound: 3,
		})

		expect(limitFn).toHaveBeenCalledWith(3)
	})

	it("defaults bound to 50", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await getSessionEventsWithBound({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			sessionId: "sess-1",
		})

		expect(limitFn).toHaveBeenCalledWith(50)
	})

	it("clamps bound=0 to 1", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await getSessionEventsWithBound({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			sessionId: "sess-1",
			bound: 0,
		})

		expect(limitFn).toHaveBeenCalledWith(1)
	})

	it("returns all events when fewer than bound", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				sessionId: "sess-1",
				role: "user",
				body: "Hello",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(2025, 0, 1, 0, 0),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await getSessionEventsWithBound({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			sessionId: "sess-1",
			bound: 100,
		})

		expect(result).toHaveLength(1)
	})

	it("returns events in chronological order (reversed from desc)", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e3",
				agentId: "agent-1",
				sessionId: "sess-1",
				role: "user",
				body: "Third",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(2025, 0, 1, 0, 2),
			},
			{
				eventId: "e1",
				agentId: "agent-1",
				sessionId: "sess-1",
				role: "user",
				body: "First",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(2025, 0, 1, 0, 0),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await getSessionEventsWithBound({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			sessionId: "sess-1",
			bound: 5,
		})

		// Sort is desc (-1), so the function must reverse to chronological
		expect(sortFn).toHaveBeenCalledWith({ timestamp: -1 })
		// After reversal, e1 (oldest) should come first
		expect(result[0].eventId).toBe("e1")
		expect(result[1].eventId).toBe("e3")
	})

	it("respects agentId filter", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await getSessionEventsWithBound({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-99",
			sessionId: "sess-1",
		})

		expect(findFn).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-99", sessionId: "sess-1" }),
		)
	})
})
