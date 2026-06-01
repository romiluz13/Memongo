/* eslint-disable @typescript-eslint/unbound-method */

import type { Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	isSearchIndexWarmupError,
	vectorSearch,
	keywordSearch,
	hybridSearchRankFusion,
	hybridSearchJSFallback,
	mongoSearch,
	splitAtlasSearchFilter,
	buildVectorSearchStage,
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
}

const NO_CAPS: DetectedCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
}

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
		expect(pipeline[0].$scoreFusion.scoreDetails).toBe(true)
		expect(pipeline.at(-2).$addFields.scoreDetails).toEqual({
			$meta: "scoreDetails",
		})
		expect(projectStage.score).toBe("$scoreDetails.value")
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
		expect(pipeline[0].$rankFusion.scoreDetails).toBe(true)
		expect(pipeline.at(-2).$addFields.scoreDetails).toEqual({
			$meta: "scoreDetails",
		})
		expect(projectStage.score).toBe("$scoreDetails.value")
	})

	it("keeps low RRF-scale $rankFusion scores instead of applying raw minScore", async () => {
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
		expect(results[0]?.score).toBe(0.004918)
	})

	it("enables and surfaces $rankFusion scoreDetails for explain traces", async () => {
		const scoreDetails = {
			value: 0.032,
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
				minScore: 0.1,
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
		expect(pipeline.at(-1).$project.score).toBe("$scoreDetails.value")
		expect(results[0]?.score).toBe(0.032)
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

	it("falls back when $scoreFusion returns empty results", async () => {
		let callCount = 0
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					callCount++
					if (callCount === 1) {
						return []
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

		expect(col.aggregate).toHaveBeenCalledTimes(2)
		expect(results).toHaveLength(2)
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
