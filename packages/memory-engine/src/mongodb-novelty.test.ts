import type { Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"

vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))

import {
	computeCentroid,
	eventsVectorIndex,
	scanNovelty,
} from "./mongodb-novelty.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"

function createMockFindChain(docs: Document[]): {
	find: ReturnType<typeof vi.fn>
} {
	return {
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					project: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue(docs),
					}),
				}),
			}),
		}),
	}
}

/**
 * Create a mock Db that supports multiple aggregate calls.
 * aggregateResults is called per-invocation to return different results
 * for each candidate event's k-NN query.
 */
function createMockDb(params: {
	findDocs?: Document[]
	aggregateResults?: Document[][]
	aggregateError?: Error
}): Db {
	const findChain = createMockFindChain(params.findDocs ?? [])
	let callIndex = 0

	const aggregateFn = vi.fn().mockImplementation(() => {
		if (params.aggregateError) {
			return {
				toArray: vi.fn().mockRejectedValue(params.aggregateError),
			}
		}
		const results = params.aggregateResults ?? []
		const docs = results[callIndex] ?? []
		callIndex++
		return {
			toArray: vi.fn().mockResolvedValue(docs),
		}
	})

	return {
		collection: vi.fn().mockReturnValue({
			...findChain,
			aggregate: aggregateFn,
		}),
	} as unknown as Db
}

describe("computeCentroid", () => {
	it("computes centroid correctly", () => {
		const embeddings = [
			[1, 2, 3],
			[3, 4, 5],
			[5, 6, 7],
		]
		const result = computeCentroid(embeddings)
		expect(result).toEqual([3, 4, 5])
	})

	it("returns empty array for empty input", () => {
		expect(computeCentroid([])).toEqual([])
	})
})

describe("eventsVectorIndex", () => {
	it("returns prefix-aware index name", () => {
		expect(eventsVectorIndex("test_")).toBe("test_events_vector")
		expect(eventsVectorIndex("memongo_")).toBe("memongo_events_vector")
	})
})

describe("scanNovelty", () => {
	it("returns empty report when no events have body text", async () => {
		const db = createMockDb({
			findDocs: [],
		})

		const result = await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result.events).toEqual([])
		expect(result.scannedCount).toBe(0)
	})

	it("returns empty report when events collection is empty", async () => {
		const db = createMockDb({ findDocs: [] })

		const result = await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result.events).toEqual([])
		expect(result.scannedCount).toBe(0)
	})

	it("runs per-observation k-NN and ranks by surprisal descending", async () => {
		// e1 has high-similarity neighbors → low surprisal (not novel)
		// e2 has low-similarity neighbors → high surprisal (novel)
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "normal event about work",
				role: "user",
				timestamp: new Date("2026-04-07T12:00:00Z"),
			},
			{
				_id: "id2",
				eventId: "e2",
				body: "unusual topic about space travel",
				role: "user",
				timestamp: new Date("2026-04-07T11:00:00Z"),
			},
		]
		// k-NN results for e1: neighbors with high similarity (0.95 avg)
		const knnForE1 = [
			{
				_id: "id1",
				eventId: "e1",
				body: "normal event about work",
				__vs: 1.0,
			},
			{
				_id: "id3",
				eventId: "e3",
				body: "another normal work event",
				__vs: 0.95,
			},
			{
				_id: "id4",
				eventId: "e4",
				body: "normal meeting notes",
				__vs: 0.93,
			},
			{
				_id: "id5",
				eventId: "e5",
				body: "regular status update",
				__vs: 0.92,
			},
			{
				_id: "id6",
				eventId: "e6",
				body: "work planning doc",
				__vs: 0.9,
			},
			{
				_id: "id7",
				eventId: "e7",
				body: "project discussion",
				__vs: 0.88,
			},
		]
		// k-NN results for e2: neighbors with low similarity (0.4 avg)
		const knnForE2 = [
			{
				_id: "id2",
				eventId: "e2",
				body: "unusual topic about space travel",
				__vs: 1.0,
			},
			{
				_id: "id8",
				eventId: "e8",
				body: "somewhat related space topic",
				__vs: 0.45,
			},
			{
				_id: "id9",
				eventId: "e9",
				body: "distant topic",
				__vs: 0.38,
			},
			{
				_id: "id10",
				eventId: "e10",
				body: "unrelated event",
				__vs: 0.35,
			},
			{
				_id: "id11",
				eventId: "e11",
				body: "another unrelated event",
				__vs: 0.32,
			},
			{
				_id: "id12",
				eventId: "e12",
				body: "very different topic",
				__vs: 0.3,
			},
		]

		const db = createMockDb({
			findDocs,
			aggregateResults: [knnForE1, knnForE2],
		})

		const result = await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result.events.length).toBe(2)
		// e2 has lower avg similarity to its neighbors → higher surprisal → ranked first
		expect(result.events[0].eventId).toBe("e2")
		expect(result.events[1].eventId).toBe("e1")
		expect(result.events[0].noveltyScore).toBeGreaterThan(
			result.events[1].noveltyScore,
		)
	})

	it("excludes the event itself from its k-NN neighbor average", async () => {
		// One event: its k-NN returns itself (score 1.0) + 2 real neighbors
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "test event",
				role: "user",
				timestamp: new Date("2026-04-07T12:00:00Z"),
			},
		]
		// k-NN returns self at score 1.0 and two neighbors at 0.6 each
		const knnForE1 = [
			{ _id: "id1", eventId: "e1", body: "test event", __vs: 1.0 },
			{
				_id: "id2",
				eventId: "e2",
				body: "neighbor 1",
				__vs: 0.6,
			},
			{
				_id: "id3",
				eventId: "e3",
				body: "neighbor 2",
				__vs: 0.6,
			},
		]

		const db = createMockDb({
			findDocs,
			aggregateResults: [knnForE1],
		})

		const result = await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			options: { kNeighbors: 2 },
		})

		expect(result.events.length).toBe(1)
		// avgSimilarity should be 0.6 (from the 2 non-self neighbors), not (1.0+0.6+0.6)/3 = 0.73
		// surprisal = 1 - 0.6 = 0.4
		expect(result.events[0].noveltyScore).toBeCloseTo(0.4, 1)
	})

	it("applies limit to results", async () => {
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "first event",
				role: "user",
				timestamp: new Date(),
			},
			{
				_id: "id2",
				eventId: "e2",
				body: "second event",
				role: "user",
				timestamp: new Date(),
			},
			{
				_id: "id3",
				eventId: "e3",
				body: "third event",
				role: "user",
				timestamp: new Date(),
			},
		]
		const knn1 = [
			{ _id: "id1", __vs: 1.0 },
			{ _id: "id4", __vs: 0.9 },
		]
		const knn2 = [
			{ _id: "id2", __vs: 1.0 },
			{ _id: "id5", __vs: 0.5 },
		]
		const knn3 = [
			{ _id: "id3", __vs: 1.0 },
			{ _id: "id6", __vs: 0.3 },
		]
		const db = createMockDb({
			findDocs,
			aggregateResults: [knn1, knn2, knn3],
		})

		const result = await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			options: { limit: 2 },
		})

		expect(result.events.length).toBe(2)
	})

	it("degrades gracefully when vectorSearch fails", async () => {
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "test event body",
				role: "user",
				timestamp: new Date(),
			},
		]
		const db = createMockDb({
			findDocs,
			aggregateError: new Error("$vectorSearch not available"),
		})

		const result = await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result.events).toEqual([])
		expect(result.error).toBe("mongot_unavailable")
	})

	it("filters by agentId in find query", async () => {
		const db = createMockDb({ findDocs: [] })

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		// Verify the collection was called
		expect(db.collection).toHaveBeenCalledWith(`${PREFIX}events`)
		// Verify find was called with agentId filter
		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		expect(col.find).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: AGENT_ID }),
		)
	})

	it("filters by scope in find query when provided", async () => {
		const db = createMockDb({ findDocs: [] })

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			options: { scope: "workspace" },
		})

		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		expect(col.find).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: AGENT_ID,
				scope: "workspace",
			}),
		)
	})

	it("uses per-event body as query text in $vectorSearch (autoEmbed syntax)", async () => {
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "specific event body text",
				role: "user",
				timestamp: new Date(),
			},
		]
		const knn = [
			{
				_id: "id1",
				eventId: "e1",
				body: "specific event body text",
				__vs: 1.0,
			},
			{
				_id: "id2",
				eventId: "e2",
				body: "neighbor",
				__vs: 0.8,
			},
		]
		const db = createMockDb({ findDocs, aggregateResults: [knn] })

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		const aggregateCall = col.aggregate.mock.calls[0][0]
		const vsStage = aggregateCall[0].$vectorSearch

		// Must use prefix-aware index name
		expect(vsStage.index).toBe(`${PREFIX}events_vector`)
		// Must use autoEmbed path (body, not embedding)
		expect(vsStage.path).toBe("body")
		// Must use the INDIVIDUAL event's body as query text (k-NN per observation)
		expect(vsStage.query).toEqual({
			text: "specific event body text",
		})
		expect(vsStage.queryVector).toBeUndefined()
		// Must filter by agentId
		expect(vsStage.filter).toEqual({ agentId: AGENT_ID })
	})

	it("passes scope to $vectorSearch pre-filter", async () => {
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "test event body",
				role: "user",
				timestamp: new Date(),
			},
		]
		const knn = [
			{ _id: "id1", __vs: 1.0 },
			{ _id: "id2", __vs: 0.8 },
		]
		const db = createMockDb({ findDocs, aggregateResults: [knn] })

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			options: { scope: "workspace" },
		})

		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		const aggregateCall = col.aggregate.mock.calls[0][0]
		const vsStage = aggregateCall[0].$vectorSearch
		expect(vsStage.filter).toEqual({
			agentId: AGENT_ID,
			scope: "workspace",
		})
	})

	it("passes timeRange to $vectorSearch pre-filter", async () => {
		const start = new Date("2026-04-01T00:00:00Z")
		const end = new Date("2026-04-08T00:00:00Z")
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "test event body",
				role: "user",
				timestamp: new Date("2026-04-05T00:00:00Z"),
			},
		]
		const knn = [
			{ _id: "id1", __vs: 1.0 },
			{ _id: "id2", __vs: 0.8 },
		]
		const db = createMockDb({ findDocs, aggregateResults: [knn] })

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			options: { timeRange: { start, end } },
		})

		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		const pipeline = col.aggregate.mock.calls[0][0]
		expect(pipeline[0].$vectorSearch.filter).toEqual({
			agentId: AGENT_ID,
			timestamp: { $gte: start, $lte: end },
		})
	})

	it("filters on body existence, not embedding field", async () => {
		const db = createMockDb({ findDocs: [] })

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		const findFilter = col.find.mock.calls[0][0]

		// Must filter on body existence (autoEmbed indexes on body)
		expect(findFilter.body).toEqual({ $exists: true, $ne: "" })
		// Must NOT filter on embedding field (autoEmbed manages embeddings internally)
		expect(findFilter.embedding).toBeUndefined()
	})

	it("runs one $vectorSearch per candidate event (k-NN per observation)", async () => {
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "event one",
				role: "user",
				timestamp: new Date(),
			},
			{
				_id: "id2",
				eventId: "e2",
				body: "event two",
				role: "user",
				timestamp: new Date(),
			},
			{
				_id: "id3",
				eventId: "e3",
				body: "event three",
				role: "user",
				timestamp: new Date(),
			},
		]
		const knn1 = [
			{ _id: "id1", __vs: 1.0 },
			{ _id: "id4", __vs: 0.9 },
		]
		const knn2 = [
			{ _id: "id2", __vs: 1.0 },
			{ _id: "id5", __vs: 0.8 },
		]
		const knn3 = [
			{ _id: "id3", __vs: 1.0 },
			{ _id: "id6", __vs: 0.7 },
		]
		const db = createMockDb({
			findDocs,
			aggregateResults: [knn1, knn2, knn3],
		})

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		// Should have called aggregate once per candidate event
		expect(col.aggregate).toHaveBeenCalledTimes(3)
	})

	it("handles single event with no non-self neighbors as maximally novel", async () => {
		// Single event whose k-NN only returns itself
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "lonely event",
				role: "user",
				timestamp: new Date(),
			},
		]
		const knn = [{ _id: "id1", eventId: "e1", body: "lonely event", __vs: 1.0 }]
		const db = createMockDb({ findDocs, aggregateResults: [knn] })

		const result = await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result.events.length).toBe(1)
		// No non-self neighbors → surprisal = 1.0 (maximally novel)
		expect(result.events[0].noveltyScore).toBe(1.0)
	})

	it("uses kNeighbors option to control neighbor count", async () => {
		const findDocs = [
			{
				_id: "id1",
				eventId: "e1",
				body: "test event",
				role: "user",
				timestamp: new Date(),
			},
		]
		const knn = [
			{ _id: "id1", __vs: 1.0 },
			{ _id: "id2", __vs: 0.8 },
			{ _id: "id3", __vs: 0.7 },
			{ _id: "id4", __vs: 0.6 },
		]
		const db = createMockDb({ findDocs, aggregateResults: [knn] })

		await scanNovelty({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			options: { kNeighbors: 3 },
		})

		const col = (db.collection as ReturnType<typeof vi.fn>).mock.results[0]
			.value
		const pipeline = col.aggregate.mock.calls[0][0]
		// limit should be kNeighbors + 1 (extra slot for self that gets excluded)
		expect(pipeline[0].$vectorSearch.limit).toBe(4)
	})
})
