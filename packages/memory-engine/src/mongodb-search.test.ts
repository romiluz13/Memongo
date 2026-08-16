/* eslint-disable @typescript-eslint/unbound-method */

import type { Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	isSearchIndexWarmupError,
	vectorSearch,
	keywordSearch,
	hybridSearchRankFusion,
	hybridSearchScoreFusion,
	hybridSearchJSFallback,
	mongoSearch,
	splitAtlasSearchFilter,
	buildVectorSearchStage,
	normalizeAndFilterRankFusionResults,
	runSearchAggregateWithRetry,
} from "./mongodb-search.js"

// ---------------------------------------------------------------------------
// Mock collection factory
// ---------------------------------------------------------------------------

function mockCollectionWithResults(results: Document[]): Collection {
	return {
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => results),
		})),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => results),
				})),
			})),
		})),
	} as unknown as Collection
}

function mockCollectionThatFails(error: string): Collection {
	return {
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => {
				throw new Error(error)
			}),
		})),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error(error)
					}),
				})),
			})),
		})),
	} as unknown as Collection
}

function mockCollectionWithWarmupSequence(
	failuresBeforeSuccess: number,
	error: string,
	results: Document[],
): Collection {
	let attempts = 0
	return {
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => {
				attempts++
				if (attempts <= failuresBeforeSuccess) {
					throw new Error(error)
				}
				return results
			}),
		})),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => results),
				})),
			})),
		})),
	} as unknown as Collection
}

const SAMPLE_DOCS: Document[] = [
	{
		path: "memory/test.md",
		startLine: 1,
		endLine: 10,
		text: "hello world test content",
		source: "conversation",
		score: 0.95,
	},
	{
		path: "memory/other.md",
		startLine: 5,
		endLine: 15,
		text: "another test document",
		source: "conversation",
		score: 0.8,
	},
]

const FULL_CAPS: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: true,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}

const NO_CAPS: DetectedCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

// ---------------------------------------------------------------------------
// runSearchAggregateWithRetry — P3.8 maxTimeMS on user-driven pipelines
// ---------------------------------------------------------------------------

describe("runSearchAggregateWithRetry maxTimeMS (P3.8)", () => {
	it("applies a default maxTimeMS ceiling when the caller passes no options", async () => {
		const aggregate = vi.fn(() => ({
			toArray: vi.fn(async () => SAMPLE_DOCS),
		}))
		const col = { aggregate } as unknown as Collection

		await runSearchAggregateWithRetry(col, [{ $match: {} }])

		expect(aggregate).toHaveBeenCalledOnce()
		const options = aggregate.mock.calls[0][1] as { maxTimeMS?: number }
		expect(typeof options?.maxTimeMS).toBe("number")
		expect(options.maxTimeMS).toBeGreaterThan(0)
	})

	it("respects a caller-provided maxTimeMS over the default", async () => {
		const aggregate = vi.fn(() => ({
			toArray: vi.fn(async () => SAMPLE_DOCS),
		}))
		const col = { aggregate } as unknown as Collection

		await runSearchAggregateWithRetry(col, [{ $match: {} }], {
			aggregateOptions: { maxTimeMS: 1_500 },
		})

		const options = aggregate.mock.calls[0][1] as { maxTimeMS?: number }
		expect(options.maxTimeMS).toBe(1_500)
	})

	it("honors the MEMONGO_SEARCH_MAX_TIME_MS override for the default ceiling", async () => {
		const previous = process.env.MEMONGO_SEARCH_MAX_TIME_MS
		process.env.MEMONGO_SEARCH_MAX_TIME_MS = "4200"
		try {
			const aggregate = vi.fn(() => ({
				toArray: vi.fn(async () => SAMPLE_DOCS),
			}))
			const col = { aggregate } as unknown as Collection

			await runSearchAggregateWithRetry(col, [{ $match: {} }])

			const options = aggregate.mock.calls[0][1] as { maxTimeMS?: number }
			expect(options.maxTimeMS).toBe(4_200)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_SEARCH_MAX_TIME_MS
			} else {
				process.env.MEMONGO_SEARCH_MAX_TIME_MS = previous
			}
		}
	})
})

// ---------------------------------------------------------------------------
// vectorSearch
// ---------------------------------------------------------------------------

describe("vectorSearch", () => {
	it("recognizes transient search index warmup errors", () => {
		expect(
			isSearchIndexWarmupError(
				new Error("cannot query vector index while in state NOT_STARTED"),
			),
		).toBe(true)
		expect(isSearchIndexWarmupError(new Error("pipeline syntax error"))).toBe(
			false,
		)
	})

	it("builds correct pipeline for automated mode", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		const results = await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0.1,
			indexName: "test_vector",
			queryText: "search query",
			embeddingMode: "automated",
		})

		expect(col.aggregate).toHaveBeenCalledTimes(1)
		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.index).toBe("test_vector")
		expect(vsStage.query).toEqual({ text: "search query" })
		expect(vsStage.model).toBe("voyage-4-large")
		expect(vsStage.path).toBe("text")
		expect(vsStage.queryVector).toBeUndefined()
		expect(vsStage.numCandidates).toBeGreaterThanOrEqual(100)
		expect(vsStage.limit).toBe(10)
		expect(results).toHaveLength(2)
	})

	it("keeps ANN numCandidates greater than or equal to limit", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await vectorSearch(col, null, {
			maxResults: 50,
			minScore: 0.1,
			indexName: "test_vector",
			queryText: "search query",
			embeddingMode: "automated",
			numCandidates: 20,
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.limit).toBe(50)
		expect(vsStage.numCandidates).toBe(50)
	})

	it("builds correct pipeline for automated mode", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		const results = await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0.1,
			indexName: "test_vector",
			queryText: "search query",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.query).toEqual({ text: "search query" })
		expect(vsStage.model).toBe("voyage-4-large")
		expect(vsStage.path).toBe("text")
		expect(vsStage.queryVector).toBeUndefined()
		expect(results).toHaveLength(2)
	})

	it("returns empty array when automated mode has no query text", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		const results = await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0.1,
			indexName: "test_vector",
			embeddingMode: "automated",
		})

		expect(col.aggregate).not.toHaveBeenCalled()
		expect(results).toEqual([])
	})

	it("filters results below minScore", async () => {
		const col = mockCollectionWithResults([
			{
				path: "a.md",
				startLine: 1,
				endLine: 2,
				text: "t",
				source: "conversation",
				score: 0.9,
			},
			{
				path: "b.md",
				startLine: 1,
				endLine: 2,
				text: "t",
				source: "conversation",
				score: 0.05,
			},
		])
		const results = await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0.1,
			indexName: "idx",
			queryText: "query",
			embeddingMode: "automated",
		})
		expect(results).toHaveLength(1)
		expect(results[0].path).toBe("a.md")
	})

	it("applies session filter", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0.1,
			indexName: "idx",
			sessionKey: "__memory__",
			queryText: "query",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.filter).toEqual({ source: "memory" })
	})

	it("caps numCandidates at 10000 when maxResults would exceed it", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await vectorSearch(col, null, {
			maxResults: 600, // 600 * 20 = 12000 > 10000
			minScore: 0,
			indexName: "test_vector",
			queryText: "query",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.numCandidates).toBeLessThanOrEqual(10000)
		expect(vsStage.numCandidates).toBe(10000)
	})

	it("caps explicit numCandidates at 10000", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0,
			indexName: "test_vector",
			queryText: "query",
			embeddingMode: "automated",
			numCandidates: 15000,
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.numCandidates).toBe(10000)
	})

	it("includes $limit after $vectorSearch", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await vectorSearch(col, null, {
			maxResults: 5,
			minScore: 0,
			indexName: "idx",
			queryText: "query",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		// Pipeline: $vectorSearch, $limit, $project
		expect(pipeline[1].$limit).toBe(5)
	})

	it("includes $project with vectorSearchScore meta", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0.1,
			indexName: "idx",
			queryText: "query",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		// Pipeline: $vectorSearch, $limit, $project
		const projectStage = pipeline[2].$project
		expect(projectStage.score).toEqual({ $meta: "vectorSearchScore" })
		expect(projectStage._id).toBe(0)
	})

	it("retries transient warmup errors before succeeding", async () => {
		const col = mockCollectionWithWarmupSequence(
			2,
			"cannot query vector index while in state NOT_STARTED",
			SAMPLE_DOCS,
		)
		const results = await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0.1,
			indexName: "test_vector",
			queryText: "search query",
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(2)
		expect(col.aggregate).toHaveBeenCalledTimes(3)
	})

	it("derives event provenance from event-backed chunk paths", async () => {
		const col = mockCollectionWithResults([
			{
				path: "events/evt-123",
				startLine: 1,
				endLine: 2,
				text: "Phoenix launches next Thursday",
				source: "conversation",
				score: 0.91,
				sessionId: "mini-q1::s1",
			},
		])
		const results = await vectorSearch(col, null, {
			maxResults: 10,
			minScore: 0,
			indexName: "idx",
			queryText: "When is the Phoenix launch?",
			embeddingMode: "automated",
		})

		expect(results[0]?.canonicalId).toBe("event:evt-123")
		expect(results[0]?.sourceEventIds).toEqual(["evt-123"])
		expect(results[0]?.sessionId).toBe("mini-q1::s1")
	})
})

// ---------------------------------------------------------------------------
// keywordSearch
// ---------------------------------------------------------------------------

describe("keywordSearch", () => {
	it("builds $search pipeline with compound query", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		const results = await keywordSearch(col, "hello world", {
			maxResults: 10,
			minScore: 0.1,
			indexName: "test_text",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const searchStage = pipeline[0].$search
		expect(searchStage.index).toBe("test_text")
		expect(searchStage.compound.must[0].text.query).toBe("hello world")
		expect(searchStage.compound.must[0].text.path).toBe("text")
		expect(results).toHaveLength(2)
	})

	it("applies session filter as equals clause", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await keywordSearch(col, "test", {
			maxResults: 5,
			minScore: 0,
			indexName: "idx",
			sessionKey: "__sessions__",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const searchStage = pipeline[0].$search
		expect(searchStage.compound.filter).toEqual([
			{ equals: { path: "source", value: "sessions" } },
		])
	})

	it("does not apply source filter for normal session keys", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await keywordSearch(col, "test", {
			maxResults: 5,
			minScore: 0,
			indexName: "idx",
			sessionKey: "agent:main:main",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const searchStage = pipeline[0].$search
		expect(searchStage.compound.filter).toBeUndefined()
	})

	it("includes searchScore meta in $project", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await keywordSearch(col, "test", {
			maxResults: 5,
			minScore: 0,
			indexName: "idx",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const projectStage = pipeline[2].$project
		expect(projectStage.score).toEqual({ $meta: "searchScore" })
		expect(projectStage.canonicalId).toBe(1)
		expect(projectStage["metadata.sourceEventIds"]).toBe(1)
	})

	it("pushes supported hard filters into compound.filter", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await keywordSearch(col, "test", {
			maxResults: 5,
			minScore: 0,
			indexName: "idx",
			filter: {
				agentId: "agent-1",
				scope: "agent",
				source: { $in: ["conversation", "sessions"] },
			},
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$search.compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
			{ equals: { path: "scope", value: "agent" } },
			{ in: { path: "source", value: ["conversation", "sessions"] } },
		])
		expect(pipeline[1]?.$match).toBeUndefined()
	})
})

describe("splitAtlasSearchFilter", () => {
	it("splits supported $and filters into Atlas Search clauses", () => {
		const split = splitAtlasSearchFilter({
			$and: [
				{ agentId: "agent-1" },
				{ scopeRef: "agent:main" },
				{ source: { $in: ["memory"] } },
			],
		})

		expect(split.compoundFilter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
			{ equals: { path: "scopeRef", value: "agent:main" } },
			{ in: { path: "source", value: ["memory"] } },
		])
		expect(split.postMatch).toBeUndefined()
	})

	it("keeps unsupported operators in postMatch", () => {
		const split = splitAtlasSearchFilter({
			updatedAt: { $gte: new Date("2026-03-01T00:00:00.000Z") },
			agentId: "agent-1",
		})

		expect(split.compoundFilter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
		])
		expect(split.postMatch).toEqual({
			updatedAt: { $gte: new Date("2026-03-01T00:00:00.000Z") },
		})
	})
})

// ---------------------------------------------------------------------------
// hybridSearchJSFallback
// ---------------------------------------------------------------------------

describe("hybridSearchJSFallback", () => {
	it("merges vector and keyword results with weights", () => {
		const vecResults = [
			{
				path: "a.md",
				startLine: 1,
				endLine: 2,
				score: 0.9,
				snippet: "vec",
				source: "conversation" as const,
			},
		]
		const kwResults = [
			{
				path: "b.md",
				startLine: 3,
				endLine: 4,
				score: 0.8,
				snippet: "kw",
				source: "conversation" as const,
			},
		]

		const merged = hybridSearchJSFallback(vecResults, kwResults, {
			maxResults: 10,
			vectorWeight: 0.7,
			textWeight: 0.3,
		})

		expect(merged.length).toBeGreaterThanOrEqual(2)
	})

	it("respects maxResults limit", () => {
		const vecResults = Array.from({ length: 20 }, (_, i) => ({
			path: `v${i}.md`,
			startLine: 1,
			endLine: 2,
			score: 0.9 - i * 0.01,
			snippet: "t",
			source: "conversation" as const,
		}))

		const merged = hybridSearchJSFallback(vecResults, [], {
			maxResults: 5,
			vectorWeight: 1,
			textWeight: 0,
		})

		expect(merged).toHaveLength(5)
	})

	it("preserves benchmark metadata across JS hybrid merge", () => {
		const vecResults = [
			{
				path: "events/evt-1",
				startLine: 1,
				endLine: 2,
				score: 0.9,
				snippet: "vector",
				source: "conversation" as const,
				sessionId: "mini-q1::s1",
				canonicalId: "event:evt-1",
				sourceEventIds: ["evt-1"],
			},
		]
		const kwResults = [
			{
				path: "events/evt-1",
				startLine: 1,
				endLine: 2,
				score: 0.8,
				snippet: "keyword",
				source: "conversation" as const,
			},
		]

		const merged = hybridSearchJSFallback(vecResults, kwResults, {
			maxResults: 10,
			vectorWeight: 0.7,
			textWeight: 0.3,
		})

		expect(merged[0]?.sessionId).toBe("mini-q1::s1")
		expect(merged[0]?.canonicalId).toBe("event:evt-1")
		expect(merged[0]?.sourceEventIds).toEqual(["evt-1"])
		expect(merged[0]?.snippet).toBe("keyword")
	})
})

// ---------------------------------------------------------------------------
// mongoSearch (dispatcher)
// ---------------------------------------------------------------------------

describe("mongoSearch dispatcher", () => {
	const baseOpts = {
		maxResults: 10,
		minScore: 0.1,
		fusionMethod: "scoreFusion" as const,
		vectorIndexName: "chunks_vector",
		textIndexName: "chunks_text",
		vectorWeight: 0.7,
		textWeight: 0.3,
	}

	it("uses $scoreFusion when fusionMethod=scoreFusion and capability available", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await mongoSearch(col, "test query", [0.1, 0.2], {
			...baseOpts,
			fusionMethod: "scoreFusion",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$scoreFusion).toBeDefined()
		const projectStage = pipeline.at(-1).$project
		expect(projectStage.canonicalId).toBe(1)
		expect(projectStage["metadata.sourceEventIds"]).toBe(1)
		// The primary score must come from the documented $meta:"score", never
		// from the unstable scoreDetails payload — and scoreDetails must not be
		// requested at all on the hot path.
		expect(pipeline[0].$scoreFusion.scoreDetails).toBeUndefined()
		expect(pipeline.some((stage: Document) => stage.$addFields)).toBe(false)
		expect(projectStage.scoreDetails).toBeUndefined()
		expect(projectStage.score).toEqual({ $meta: "score" })
	})

	it("uses $rankFusion when fusionMethod=rankFusion (skips $scoreFusion)", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await mongoSearch(col, "test query", [0.1, 0.2], {
			...baseOpts,
			fusionMethod: "rankFusion",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		// Should use $rankFusion directly, NOT $scoreFusion
		expect(pipeline[0].$rankFusion).toBeDefined()
		expect(pipeline[0].$scoreFusion).toBeUndefined()
		const projectStage = pipeline.at(-1).$project
		expect(projectStage.canonicalId).toBe(1)
		expect(projectStage["metadata.sourceEventIds"]).toBe(1)
		expect(pipeline[0].$rankFusion.scoreDetails).toBeUndefined()
		expect(pipeline.some((stage: Document) => stage.$addFields)).toBe(false)
		expect(projectStage.scoreDetails).toBeUndefined()
		expect(projectStage.score).toEqual({ $meta: "score" })
	})

	it("rescales low RRF-scale $rankFusion scores instead of discarding them", async () => {
		// This test used to assert the opposite: that minScore 0.1 filtered the
		// result away. That was the S2 defect, not the contract. Raw RRF scores
		// cap at sum(weights)/61 (~0.0164 here), so any caller threshold at or
		// above that emptied the hybrid path for every query and silently
		// demoted every search to the JS-merge fallback. Scores are now rescaled
		// into the [0,1] space the other search paths report in, so the caller's
		// threshold means the same thing on every path.
		const rrfDocs: Document[] = [
			{
				path: "memory/rrf.md",
				startLine: 1,
				endLine: 2,
				text: "rank fusion result",
				source: "conversation",
				score: 0.004918,
			},
		]
		const col = mockCollectionWithResults(rrfDocs)

		// 0.004918 is 30% of the 1/61 ceiling, so it survives a 0.1 threshold.
		const results = await hybridSearchRankFusion(
			col,
			"test query",
			[0.1, 0.2],
			{
				maxResults: 10,
				minScore: 0.1,
				vectorIndexName: "chunks_vector",
				textIndexName: "chunks_text",
				vectorWeight: 0.7,
				textWeight: 0.3,
				embeddingMode: "automated",
			},
		)

		expect(results).toHaveLength(1)
		expect(results[0]?.score).toBeCloseTo(0.3, 3)

		// ...and a threshold above it still filters, so minScore is not inert.
		const results2 = await hybridSearchRankFusion(
			col,
			"test query",
			[0.1, 0.2],
			{
				maxResults: 10,
				minScore: 0.5,
				vectorIndexName: "chunks_vector",
				textIndexName: "chunks_text",
				vectorWeight: 0.7,
				textWeight: 0.3,
				embeddingMode: "automated",
			},
		)

		expect(results2).toHaveLength(0)
	})

	it("rescales sigmoid-domain $scoreFusion scores instead of discarding them", async () => {
		// $scoreFusion sigmoid+avg output shares no scale with the [0,1]
		// minScore callers pass: with 0.7/0.3 weights the raw ceiling is 0.7
		// (max weight), so a raw 0.35 is a mid-strength match. Thresholding it
		// raw against minScore 0.4 silently emptied the lane — the same S2
		// defect class the rankFusion path documents.
		const sigmoidDocs: Document[] = [
			{
				path: "memory/sf.md",
				startLine: 1,
				endLine: 2,
				text: "score fusion result",
				source: "conversation",
				score: 0.35,
			},
		]
		const col = mockCollectionWithResults(sigmoidDocs)

		const results = await hybridSearchScoreFusion(col, "test query", [0.1], {
			maxResults: 10,
			minScore: 0.4,
			vectorIndexName: "chunks_vector",
			textIndexName: "chunks_text",
			vectorWeight: 0.7,
			textWeight: 0.3,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(1)
		expect(results[0]?.score).toBeCloseTo(0.5, 3)

		// ...and a threshold above the rescaled score still filters.
		const results2 = await hybridSearchScoreFusion(col, "test query", [0.1], {
			maxResults: 10,
			minScore: 0.6,
			vectorIndexName: "chunks_vector",
			textIndexName: "chunks_text",
			vectorWeight: 0.7,
			textWeight: 0.3,
			embeddingMode: "automated",
		})

		expect(results2).toHaveLength(0)
	})

	it("enables and surfaces $rankFusion scoreDetails for explain traces", async () => {
		// 0.008 is roughly half the 1/61 ceiling these weights produce, so the
		// rescaled score lands mid-range rather than clamping at 1.
		const scoreDetails = {
			value: 0.008,
			description: "rrf",
			details: [],
		}
		const col = mockCollectionWithResults([
			{
				path: "memory/rrf-details.md",
				startLine: 1,
				endLine: 2,
				text: "rank fusion detail result",
				source: "conversation",
				scoreDetails,
			},
		])

		const results = await hybridSearchRankFusion(
			col,
			"test query",
			[0.1, 0.2],
			{
				maxResults: 10,
				minScore: 0,
				vectorIndexName: "chunks_vector",
				textIndexName: "chunks_text",
				vectorWeight: 0.7,
				textWeight: 0.3,
				embeddingMode: "automated",
				explain: {
					enabled: true,
					includeScoreDetails: true,
				},
			},
		)

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$rankFusion.scoreDetails).toBe(true)
		expect(pipeline.at(-2).$addFields.scoreDetails).toEqual({
			$meta: "scoreDetails",
		})
		expect(pipeline.at(-1).$project.scoreDetails).toBe(1)
		expect(pipeline.at(-1).$project.score).toEqual({ $meta: "score" })
		// The reported score is rescaled out of raw RRF space, but scoreDetails
		// is passed through untouched so explain traces still show what the
		// server actually returned.
		expect(results[0]?.score).toBeCloseTo(0.488, 3)
		expect(results[0]?.scoreDetails).toEqual(scoreDetails)
	})

	it("falls back from $scoreFusion to $rankFusion on error", async () => {
		let callCount = 0
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					callCount++
					if (callCount === 1) {
						throw new Error("$scoreFusion failed")
					}
					return SAMPLE_DOCS
				}),
			})),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => SAMPLE_DOCS),
					})),
				})),
			})),
		} as unknown as Collection

		const results = await mongoSearch(col, "test query", [0.1, 0.2], {
			...baseOpts,
			fusionMethod: "scoreFusion",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		// Should have retried with $rankFusion
		expect(col.aggregate).toHaveBeenCalledTimes(2)
		expect(results).toHaveLength(2)
	})

	it("stops the waterfall when $scoreFusion returns empty results (empty ≠ error, P3.2)", async () => {
		// fix-plan-2026-08-03 Appendix C: an empty result is a valid answer, not
		// a trigger for escalation. The fusion stage includes the vector lane,
		// which returns nearest neighbors for ANY query when documents exist
		// under the filter — an empty fusion proves no retrievable documents,
		// so re-running the same query through more stages is pure cost.
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => SAMPLE_DOCS),
					})),
				})),
			})),
		} as unknown as Collection

		const results = await mongoSearch(col, "test query", [0.1, 0.2], {
			...baseOpts,
			fusionMethod: "scoreFusion",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		expect(col.aggregate).toHaveBeenCalledTimes(1)
		expect(results).toEqual([])
	})

	it("stops the waterfall after a rankFusion empty", async () => {
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		} as unknown as Collection

		const results = await mongoSearch(col, "sparse query", null, {
			...baseOpts,
			fusionMethod: "rankFusion",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		expect(col.aggregate).toHaveBeenCalledTimes(1)
		expect(results).toEqual([])
	})

	it("does not re-run the js-merge vector search as a vector-only fallback (P3.2 dedupe)", async () => {
		// js-merge already ran the identical vectorSearch + keywordSearch; on an
		// empty merge the old waterfall re-ran the SAME vectorSearch, then
		// keyword, then $text — 5 aggregations for one lane on an empty corpus.
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		} as unknown as Collection

		const results = await mongoSearch(col, "sparse query", null, {
			...baseOpts,
			fusionMethod: "js-merge",
			capabilities: {
				...FULL_CAPS,
				scoreFusion: false,
				rankFusion: false,
			},
			embeddingMode: "automated",
		})

		// Exactly the js-merge pair: one vector + one keyword aggregation.
		expect(col.aggregate).toHaveBeenCalledTimes(2)
		expect(results).toEqual([])
	})

	it("still falls back when a stage fails (errors, unlike empties, escalate)", async () => {
		let callCount = 0
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					callCount++
					if (callCount === 1) {
						throw new Error("$rankFusion is not supported on this server")
					}
					return SAMPLE_DOCS
				}),
			})),
		} as unknown as Collection

		const results = await mongoSearch(col, "test query", null, {
			...baseOpts,
			fusionMethod: "rankFusion",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		// rankFusion error (1 call) escalates to the js-merge pair (2 calls).
		expect(col.aggregate).toHaveBeenCalledTimes(3)
		expect(results).toHaveLength(2)
	})

	it("enforces the per-search aggregation budget when stages keep failing", async () => {
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					throw new Error("stage unsupported")
				}),
			})),
		} as unknown as Collection

		const { value, budget } = await runWithSearchBudget(
			{ maxAggregations: 1, maxEmbeds: 5 },
			async () =>
				mongoSearch(col, "sparse query", null, {
					...baseOpts,
					fusionMethod: "scoreFusion",
					capabilities: FULL_CAPS,
					embeddingMode: "automated",
				}),
		)

		// Budget exhausted after the first stage: later stages never reach the
		// server even though every stage error would have escalated.
		expect((col.aggregate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			1,
		)
		expect(value).toEqual([])
		expect(budget.aggregations).toBe(1)
		expect(budget.exhausted).toBe(true)
	})

	it("counts one server-side embed per $vectorSearch stage through the budget", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)

		const { value, budget } = await runWithSearchBudget(
			{ maxAggregations: 12, maxEmbeds: 5 },
			async () =>
				mongoSearch(col, "test query", null, {
					...baseOpts,
					fusionMethod: "rankFusion",
					capabilities: FULL_CAPS,
					embeddingMode: "automated",
				}),
		)

		expect(value).toHaveLength(2)
		expect(budget.embeds).toBe(1)
		expect(budget.aggregations).toBe(1)
	})

	it("returns empty instead of falling back when strictNoFallback sees no hits", async () => {
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => SAMPLE_DOCS),
					})),
				})),
			})),
		} as unknown as Collection

		const results = await mongoSearch(col, "test query", [0.1, 0.2], {
			...baseOpts,
			fusionMethod: "rankFusion",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
			strictNoFallback: true,
		})

		expect(results).toEqual([])
		expect(col.aggregate).toHaveBeenCalledTimes(1)
	})

	it("treats MEMONGO_BENCHMARK_STRICT=true as no-fallback strict mode", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "true"
		try {
			const col = {
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
				find: vi.fn(() => ({
					sort: vi.fn(() => ({
						limit: vi.fn(() => ({
							toArray: vi.fn(async () => SAMPLE_DOCS),
						})),
					})),
				})),
			} as unknown as Collection

			const results = await mongoSearch(col, "test query", [0.1, 0.2], {
				...baseOpts,
				fusionMethod: "rankFusion",
				capabilities: FULL_CAPS,
				embeddingMode: "automated",
			})

			expect(results).toEqual([])
			expect(col.aggregate).toHaveBeenCalledTimes(1)
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
		}
	})

	it("throws instead of falling back when strictNoFallback sees a search failure", async () => {
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					throw new Error("$rankFusion failed")
				}),
			})),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => SAMPLE_DOCS),
					})),
				})),
			})),
		} as unknown as Collection

		await expect(
			mongoSearch(col, "test query", [0.1, 0.2], {
				...baseOpts,
				fusionMethod: "rankFusion",
				capabilities: FULL_CAPS,
				embeddingMode: "automated",
				strictNoFallback: true,
			}),
		).rejects.toThrow("search fallback disabled")
		expect(col.aggregate).toHaveBeenCalledTimes(1)
	})

	it("skips server-side fusion for js-merge fusionMethod", async () => {
		// When fusionMethod is js-merge, should run separate vector + keyword queries
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await mongoSearch(col, "test query", [0.1, 0.2], {
			...baseOpts,
			fusionMethod: "js-merge",
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		// aggregate should be called twice: once for vector, once for keyword
		expect(col.aggregate).toHaveBeenCalledTimes(2)
		const firstPipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const secondPipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[1][0]
		// Neither should be $scoreFusion or $rankFusion
		expect(firstPipeline[0].$scoreFusion).toBeUndefined()
		expect(firstPipeline[0].$rankFusion).toBeUndefined()
		expect(secondPipeline[0].$scoreFusion).toBeUndefined()
		expect(secondPipeline[0].$rankFusion).toBeUndefined()
	})

	it("falls back to vector-only when textSearch is not available", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await mongoSearch(col, "test", [0.1], {
			...baseOpts,
			capabilities: {
				...FULL_CAPS,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$vectorSearch).toBeDefined()
	})

	it("falls back to keyword-only when vectorSearch is unavailable", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await mongoSearch(col, "test", null, {
			...baseOpts,
			capabilities: { ...FULL_CAPS, vectorSearch: false },
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$search).toBeDefined()
	})

	it("falls back to keyword-only when vector search returns empty results", async () => {
		let callCount = 0
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					callCount++
					return callCount === 1 ? [] : SAMPLE_DOCS
				}),
			})),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => SAMPLE_DOCS),
					})),
				})),
			})),
		} as unknown as Collection

		const results = await mongoSearch(col, "test", null, {
			...baseOpts,
			capabilities: {
				...FULL_CAPS,
				textSearch: true,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			embeddingMode: "automated",
		})

		expect(col.aggregate).toHaveBeenCalled()
		expect(results).toHaveLength(2)
		const pipelines = (
			col.aggregate as ReturnType<typeof vi.fn>
		).mock.calls.map((call) => call[0])
		expect(pipelines.some((pipeline) => pipeline[0].$search != null)).toBe(true)
	})

	it("falls back to $text search when all Atlas Search methods fail", async () => {
		// With NO_CAPS, dispatcher skips Atlas Search and goes directly to $text fallback
		const col = mockCollectionWithResults(SAMPLE_DOCS)

		await mongoSearch(col, "test", null, {
			...baseOpts,
			capabilities: NO_CAPS,
			embeddingMode: "automated",
		})

		// Should have used aggregate with $text $match
		expect(col.aggregate).toHaveBeenCalled()
		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$match.$text).toBeDefined()
		expect(pipeline[0].$match.$text.$search).toBe("test")
	})

	it("returns empty when everything fails", async () => {
		const col = mockCollectionThatFails("total failure")

		const results = await mongoSearch(col, "test", null, {
			...baseOpts,
			capabilities: NO_CAPS,
			embeddingMode: "automated",
		})

		expect(results).toEqual([])
	})

	it("enables vector search in automated mode without queryVector", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await mongoSearch(col, "test query", null, {
			...baseOpts,
			capabilities: FULL_CAPS,
			embeddingMode: "automated",
		})

		// In automated mode, vector search works without queryVector
		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		// Should attempt hybrid search (scoreFusion) with automated embedding
		expect(pipeline[0].$scoreFusion).toBeDefined()
	})

	it("disables vector search in automated mode when capability is false", async () => {
		const col = mockCollectionWithResults(SAMPLE_DOCS)
		await mongoSearch(col, "test query", null, {
			...baseOpts,
			capabilities: { ...NO_CAPS, textSearch: true },
			embeddingMode: "automated",
		})

		// Without vectorSearch capability, should fall back to keyword only
		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$search).toBeDefined()
		expect(pipeline[0].$vectorSearch).toBeUndefined()
		expect(pipeline[0].$scoreFusion).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// ENN: exact nearest neighbor vector search
// ---------------------------------------------------------------------------

describe("buildVectorSearchStage ENN", () => {
	it("sets exact: true and omits numCandidates when exact is true", () => {
		const stage = buildVectorSearchStage({
			queryVector: null,
			queryText: "test query",
			embeddingMode: "automated",
			indexName: "test_chunks_vector",
			numCandidates: 200,
			limit: 10,
			exact: true,
		})
		expect(stage).not.toBeNull()
		expect(stage!.exact).toBe(true)
		expect(stage!.numCandidates).toBeUndefined()
		expect(stage!.limit).toBe(10)
		expect(stage!.query).toEqual({ text: "test query" })
		expect(stage!.model).toBe("voyage-4-large")
	})

	it("honors an explicit compatible query model", () => {
		const stage = buildVectorSearchStage({
			queryVector: null,
			queryText: "test query",
			embeddingMode: "automated",
			indexName: "test_chunks_vector",
			model: "voyage-4-large",
			numCandidates: 200,
			limit: 10,
		})
		expect(stage?.model).toBe("voyage-4-large")
	})

	it("preserves filter pushdown in ENN mode", () => {
		const stage = buildVectorSearchStage({
			queryVector: null,
			queryText: "test query",
			embeddingMode: "automated",
			indexName: "test_chunks_vector",
			numCandidates: 200,
			limit: 10,
			filter: { agentId: "agent-1", scope: "agent" },
			exact: true,
		})
		expect(stage).not.toBeNull()
		expect(stage!.exact).toBe(true)
		expect(stage!.filter).toEqual({ agentId: "agent-1", scope: "agent" })
	})

	it("uses ANN (numCandidates) when exact is false or omitted", () => {
		const stage = buildVectorSearchStage({
			queryVector: null,
			queryText: "test query",
			embeddingMode: "automated",
			indexName: "test_chunks_vector",
			numCandidates: 200,
			limit: 10,
		})
		expect(stage).not.toBeNull()
		expect(stage!.numCandidates).toBe(200)
		expect(stage!.exact).toBeUndefined()
	})
})

describe("normalizeAndFilterRankFusionResults", () => {
	// Raw $rankFusion output, as measured on a live cluster with weights
	// 0.7/0.3. The top document is ranked #1 in both pipelines and so sits
	// exactly on the ceiling of (0.7 + 0.3) / (60 + 1).
	const CEILING = 1 / 61
	function raw(scores: number[]) {
		return scores.map((score, i) => ({
			path: `chunk/${i}`,
			startLine: 0,
			endLine: 0,
			score,
			snippet: `doc ${i}`,
			source: "conversation" as const,
		}))
	}

	it("rescales the RRF ceiling to 1", () => {
		const out = normalizeAndFilterRankFusionResults(raw([CEILING]), 0, 0.7, 0.3)
		expect(out).toHaveLength(1)
		expect(out[0].score).toBeCloseTo(1, 5)
	})

	it("returns results at the shipped default minScore of 0.1", () => {
		// S2 regression: these are real scores from a live $rankFusion run. Before
		// rescaling, every one of them was below 0.1, so the whole hybrid path
		// returned [] and silently fell through to the JS-merge fallback.
		const observed = [0.01639344, 0.01612903, 0.01579861, 0.01076923]
		expect(observed.every((s) => s < 0.1)).toBe(true)

		const out = normalizeAndFilterRankFusionResults(
			raw(observed),
			0.1,
			0.7,
			0.3,
		)
		expect(out).toHaveLength(4)
		expect(out[0].score).toBeCloseTo(1, 4)
	})

	it("keeps RRF ordering and stays within [0,1]", () => {
		const out = normalizeAndFilterRankFusionResults(
			raw([0.01639344, 0.01076923, 0.01612903]),
			0,
			0.7,
			0.3,
		)
		expect(out.map((r) => r.snippet)).toEqual(["doc 0", "doc 1", "doc 2"])
		for (const r of out) {
			expect(r.score).toBeGreaterThan(0)
			expect(r.score).toBeLessThanOrEqual(1)
		}
	})

	it("still applies a threshold that is meaningful after rescaling", () => {
		const out = normalizeAndFilterRankFusionResults(
			raw([0.01639344, 0.01076923]),
			0.9,
			0.7,
			0.3,
		)
		expect(out).toHaveLength(1)
		expect(out[0].snippet).toBe("doc 0")
	})

	it("drops zero-score documents", () => {
		const out = normalizeAndFilterRankFusionResults(
			raw([0, CEILING]),
			0,
			0.7,
			0.3,
		)
		expect(out).toHaveLength(1)
		expect(out[0].snippet).toBe("doc 1")
	})

	it("returns nothing when the weights cannot produce a positive ceiling", () => {
		expect(
			normalizeAndFilterRankFusionResults(raw([CEILING]), 0, 0, 0),
		).toEqual([])
	})
})

describe("splitAtlasSearchFilter operator handling", () => {
	it("routes $or to $match instead of inventing a $or field path", () => {
		// S1 regression. This used to emit {in: {path: "$or", value: [{...}]}},
		// which mongot rejects with "compound.filter[N].in.value[0] must be a
		// boolean, objectId, number, string, date, uuid, or null" — verified
		// against a live cluster. That error took down the entire $search
		// pipeline, so any query carrying a $or silently degraded to JS merge.
		const or = [{ scope: "user" }, { scope: "agent" }]
		const out = splitAtlasSearchFilter({ agentId: "a1", $or: or })

		expect(out.compoundFilter).toEqual([
			{ equals: { path: "agentId", value: "a1" } },
		])
		expect(out.postMatch).toEqual({ $or: or })
	})

	it("routes bi-temporal $and-of-$or filters to $match", () => {
		// buildBitemporalFilter emits exactly this shape, so it is the realistic
		// way a $or reaches the Atlas Search path.
		const asOf = new Date("2026-07-26T00:00:00Z")
		const out = splitAtlasSearchFilter({
			agentId: "a1",
			$and: [
				{ $or: [{ validAt: { $exists: false } }, { validAt: { $lte: asOf } }] },
				{
					$or: [
						{ invalidAt: { $exists: false } },
						{ invalidAt: { $gt: asOf } },
					],
				},
			],
		})

		expect(out.compoundFilter).toEqual([
			{ equals: { path: "agentId", value: "a1" } },
		])
		expect(out.postMatch).toEqual({
			$and: [
				{ $or: [{ validAt: { $exists: false } }, { validAt: { $lte: asOf } }] },
				{
					$or: [
						{ invalidAt: { $exists: false } },
						{ invalidAt: { $gt: asOf } },
					],
				},
			],
		})
	})

	it("keeps sibling clauses when an $and cannot be flattened", () => {
		// The old code returned out of the whole visit here, so `agentId` was
		// dropped from both the compound filter and $match — a silently wider
		// query rather than a narrower one.
		const out = splitAtlasSearchFilter({
			$and: ["not-an-object"],
			agentId: "a1",
		})

		expect(out.compoundFilter).toEqual([
			{ equals: { path: "agentId", value: "a1" } },
		])
		expect(out.postMatch).toEqual({ $and: ["not-an-object"] })
	})
})
