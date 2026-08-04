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
	writeEventsBatch,
	getEventsByTimeRange,
	markEventsConsolidated,
	getUnconsolidatedEvents,
	getSessionEventsWithBound,
	type CanonicalEvent,
} from "./mongodb-events.js"
import { computeIdempotencyFingerprint } from "./mongodb-idempotency-fingerprint.js"
import { eventsCollection } from "./mongodb-schema.js"

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockEventsCol(): Collection {
	return {
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "new-id",
			matchedCount: 1,
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

function _createMockChunksCol(): Collection {
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
			// P4.4.1: expired events are hidden until the TTL sweep runs.
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
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
			// P4.4.1: expired events are hidden until the TTL sweep runs.
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
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

// ---------------------------------------------------------------------------
// P4.4.1: TTL expiration — per-write expiresAt on events
// ---------------------------------------------------------------------------

describe("event TTL expiration (P4.4.1)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function lastSetOnInsertDoc(col: Collection): Record<string, unknown> {
		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		return (update as Record<string, Record<string, unknown>>).$setOnInsert
	}

	it("persists an explicit per-write expiresAt on the event document", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const expiresAt = new Date("2026-09-01T00:00:00.000Z")

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				eventId: "evt-expiring",
				agentId: "agent-1",
				role: "user",
				body: "session fact that expires",
				scope: "session",
				sessionId: "sess-1",
				expiresAt,
			},
		})

		expect(lastSetOnInsertDoc(col).expiresAt).toBe(expiresAt)
	})

	it("omits expiresAt entirely when the write carries none", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				eventId: "evt-durable",
				agentId: "agent-1",
				role: "user",
				body: "durable event",
				scope: "agent",
			},
		})

		expect(lastSetOnInsertDoc(col)).not.toHaveProperty("expiresAt")
	})

	it("rejects an invalid expiresAt date", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: {
					eventId: "evt-bad-expiry",
					agentId: "agent-1",
					role: "user",
					body: "bad expiry",
					scope: "agent",
					expiresAt: new Date(Number.NaN),
				},
			}),
		).rejects.toThrow("invalid event expiresAt")
		expect(col.updateOne).not.toHaveBeenCalled()
	})

	it("carries per-item expiresAt through the batch write", async () => {
		const col = {
			insertMany: vi.fn(async () => ({ acknowledged: true, insertedCount: 2 })),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(col)
		const expiresAt = new Date("2026-09-01T00:00:00.000Z")

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				{
					eventId: "evt-b-exp",
					agentId: "agent-1",
					role: "user",
					body: "expiring batch item",
					scope: "session",
					sessionId: "sess-1",
					expiresAt,
				},
				{
					eventId: "evt-b-durable",
					agentId: "agent-1",
					role: "user",
					body: "durable batch item",
					scope: "agent",
				},
			],
		})

		expect(results.every((r) => r.ok)).toBe(true)
		const [docs] = vi.mocked(col.insertMany).mock.calls[0]
		expect((docs as CanonicalEvent[])[0].expiresAt).toBe(expiresAt)
		expect((docs as CanonicalEvent[])[1]).not.toHaveProperty("expiresAt")
	})

	it("getEventsByTimeRange excludes expired docs via the unexpired $or clause", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))
		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const start = new Date("2026-08-01T00:00:00.000Z")
		const end = new Date("2026-08-03T00:00:00.000Z")
		await getEventsByTimeRange({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			start,
			end,
		})

		const filter = findFn.mock.calls[0][0] as Record<string, unknown>
		expect(filter.$or).toEqual([
			{ expiresAt: { $exists: false } },
			{ expiresAt: { $gt: expect.any(Date) } },
		])
	})

	it("getUnconsolidatedEvents excludes expired docs via the unexpired $or clause", async () => {
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
		})

		const filter = findFn.mock.calls[0][0] as Record<string, unknown>
		expect(filter.$or).toEqual([
			{ expiresAt: { $exists: false } },
			{ expiresAt: { $gt: expect.any(Date) } },
		])
	})
})

describe("computeIdempotencyFingerprint (B4)", () => {
	const BASE = {
		role: "user" as const,
		body: "hello",
		sessionId: "s1",
		timestamp: new Date("2026-04-09T12:00:00.000Z"),
		validAt: new Date("2026-04-09T12:00:00.000Z"),
		invalidAt: new Date("2026-05-09T12:00:00.000Z"),
		metadata: { source: "chat", nested: { b: 2, a: 1 } },
		expiresAt: new Date("2026-06-09T12:00:00.000Z"),
	}

	it("is stable for identical payloads", () => {
		expect(computeIdempotencyFingerprint({ ...BASE }, "agent-1")).toBe(
			computeIdempotencyFingerprint({ ...BASE }, "agent-1"),
		)
	})

	it("normalizes metadata key order recursively", () => {
		const a = computeIdempotencyFingerprint({ ...BASE }, "agent-1")
		const b = computeIdempotencyFingerprint(
			{ ...BASE, metadata: { nested: { a: 1, b: 2 }, source: "chat" } },
			"agent-1",
		)
		expect(b).toBe(a)
	})

	it("treats omitted metadata as equivalent to empty metadata", () => {
		const { metadata: _drop, ...withoutMetadata } = BASE
		const a = computeIdempotencyFingerprint(withoutMetadata, "agent-1")
		const b = computeIdempotencyFingerprint(
			{ ...withoutMetadata, metadata: {} },
			"agent-1",
		)
		expect(b).toBe(a)
	})

	it("normalizes dates to their ISO instant, not the Date object identity", () => {
		const a = computeIdempotencyFingerprint({ ...BASE }, "agent-1")
		const b = computeIdempotencyFingerprint(
			{ ...BASE, timestamp: new Date("2026-04-09T12:00:00.000Z") },
			"agent-1",
		)
		expect(b).toBe(a)
	})

	it("distinguishes an omitted timestamp from an explicit one", () => {
		const { timestamp: _drop, ...omitted } = BASE
		expect(computeIdempotencyFingerprint(omitted, "agent-1")).not.toBe(
			computeIdempotencyFingerprint({ ...BASE }, "agent-1"),
		)
	})

	it.each([
		["timestamp", { timestamp: new Date("2026-04-10T12:00:00.000Z") }],
		["validAt", { validAt: new Date("2026-04-08T12:00:00.000Z") }],
		["invalidAt", { invalidAt: new Date("2026-05-10T12:00:00.000Z") }],
		["expiresAt", { expiresAt: new Date("2026-06-10T12:00:00.000Z") }],
		["metadata", { metadata: { source: "other", nested: { a: 1, b: 2 } } }],
		["body", { body: "hello!" }],
		["role", { role: "assistant" as const }],
		["sessionId", { sessionId: "s2" }],
	])("changes when %s changes", (_label, patch) => {
		expect(
			computeIdempotencyFingerprint({ ...BASE, ...patch }, "agent-1"),
		).not.toBe(computeIdempotencyFingerprint({ ...BASE }, "agent-1"))
	})

	it("resolves scope with the same rule as the write (implicit session ≡ explicit session)", () => {
		const implicit = computeIdempotencyFingerprint(
			{ role: "user", body: "b", sessionId: "s1" },
			"agent-1",
		)
		const explicit = computeIdempotencyFingerprint(
			{
				role: "user",
				body: "b",
				sessionId: "s1",
				scope: "session",
				scopeRef: "session:s1",
			},
			"agent-1",
		)
		expect(explicit).toBe(implicit)
	})

	it("omitting expiresAt is distinct from any explicit expiresAt (TTL default equivalence)", () => {
		const { expiresAt: _drop, ...omitted } = BASE
		// A write that accepted the TTL default must not collide with one that
		// pinned an explicit instant — and must replay against its own retry.
		const a = computeIdempotencyFingerprint(omitted, "agent-1")
		expect(a).toBe(computeIdempotencyFingerprint({ ...omitted }, "agent-1"))
		expect(a).not.toBe(computeIdempotencyFingerprint({ ...BASE }, "agent-1"))
	})
})
