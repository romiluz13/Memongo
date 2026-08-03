/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import { searchKB } from "./mongodb-kb-search.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockKBChunksCol(results: Document[] = []): Collection {
	return {
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => results),
		})),
	} as unknown as Collection
}

function mockKBDocsCol(ids: Array<string | number> = []): Collection {
	return {
		find: vi.fn(() => ({
			limit: vi.fn(() => ({
				toArray: vi.fn(async () => ids.map((_id) => ({ _id }))),
			})),
		})),
	} as unknown as Collection
}

const baseCapabilities: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

const noSearchCapabilities: DetectedCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchKB", () => {
	it("returns results from vector search", async () => {
		const col = mockKBChunksCol([
			{
				path: "guide.md",
				startLine: 1,
				endLine: 10,
				text: "KB content about architecture",
				docId: "doc-1",
				score: 0.85,
			},
		])

		const results = await searchKB(col, "architecture", [0.1, 0.2], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(1)
		expect(results[0].source).toBe("reference")
		expect(results[0].score).toBe(0.85)
		expect(results[0].snippet).toContain("KB content about architecture")
	})

	it("returns empty results when no matches", async () => {
		const col = mockKBChunksCol([])

		const results = await searchKB(col, "nonexistent", [0.1, 0.2], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(0)
	})

	it("filters results below minScore threshold", async () => {
		const col = mockKBChunksCol([
			{
				path: "low.md",
				startLine: 1,
				endLine: 5,
				text: "Low score content",
				score: 0.05,
			},
		])

		const results = await searchKB(col, "content", [0.1], {
			maxResults: 5,
			minScore: 0.3,
			scopeRef: "agent:test",
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(0)
	})

	it("falls back to $text search when no vector capabilities", async () => {
		const col = mockKBChunksCol([
			{
				path: "fallback.md",
				startLine: 1,
				endLine: 3,
				text: "Fallback text match",
				score: 1.5,
			},
		])

		const results = await searchKB(col, "fallback", null, {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: noSearchCapabilities,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(1)
		expect(results[0].source).toBe("reference")
	})

	it("caps numCandidates at 10000 in KB search (F1)", async () => {
		const col = mockKBChunksCol([
			{ path: "a.md", startLine: 1, endLine: 5, text: "content", score: 0.9 },
		])

		await searchKB(col, "test", [0.1], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "idx",
			textIndexName: "txt",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
			numCandidates: 15000,
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.numCandidates).toBeLessThanOrEqual(10000)
	})

	it("includes $limit after $vectorSearch in KB search (F7)", async () => {
		const col = mockKBChunksCol([
			{ path: "a.md", startLine: 1, endLine: 5, text: "content", score: 0.9 },
		])

		await searchKB(col, "test", [0.1], {
			maxResults: 3,
			minScore: 0,
			scopeRef: "agent:test",
			vectorIndexName: "idx",
			textIndexName: "txt",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[1].$limit).toBe(3)
	})

	it("tries hybrid search ($rankFusion) before vector-only when rankFusion available (F12)", async () => {
		const hybridCaps: DetectedCapabilities = {
			...baseCapabilities,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		}
		const col = mockKBChunksCol([
			{
				path: "hybrid.md",
				startLine: 1,
				endLine: 5,
				text: "hybrid result",
				score: 0.9,
			},
		])

		const results = await searchKB(col, "test", [0.1], {
			maxResults: 5,
			minScore: 0,
			scopeRef: "agent:test",
			vectorIndexName: "idx",
			textIndexName: "txt",
			capabilities: hybridCaps,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(1)
		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$rankFusion).toBeDefined()
	})

	it("uses automated embedding mode query", async () => {
		const col = mockKBChunksCol([
			{
				path: "auto.md",
				startLine: 1,
				endLine: 5,
				text: "Auto embed result",
				score: 0.9,
			},
		])

		const results = await searchKB(col, "auto embed", null, {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(1)
		// In automated mode, vector search uses query text instead of queryVector
		const aggregateCalls = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls
		expect(aggregateCalls.length).toBeGreaterThan(0)
	})

	it("short-circuits when KB metadata filter resolves to no matching documents", async () => {
		const col = mockKBChunksCol([
			{ path: "never.md", startLine: 1, endLine: 1, text: "nope", score: 0.9 },
		])
		const kbDocs = mockKBDocsCol([])

		const results = await searchKB(col, "vector", [0.1], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			filter: { tags: ["missing"], category: "none", source: "file" },
			kbDocs,
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(0)
		expect(col.aggregate).not.toHaveBeenCalled()
	})

	it("applies KB metadata filter to vector search stage", async () => {
		const col = mockKBChunksCol([
			{
				path: "filtered.md",
				startLine: 1,
				endLine: 3,
				text: "filtered",
				score: 0.8,
			},
		])
		const kbDocs = mockKBDocsCol(["doc-a", "doc-b"])

		await searchKB(col, "filtered", [0.2], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			filter: { tags: ["docs"], category: "architecture", source: "file" },
			kbDocs,
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: baseCapabilities,
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.filter).toEqual({
			scopeRef: "agent:test",
			docId: { $in: ["doc-a", "doc-b"] },
		})
	})

	it("normalizes raw $rankFusion scores into [0,1] before applying minScore (P0.10)", async () => {
		const hybridCaps: DetectedCapabilities = {
			...baseCapabilities,
			rankFusion: true,
		}
		// Raw RRF output ceiling is (0.7+0.3) * rrfScore(1) = 1/61 ≈ 0.0164;
		// half of the ceiling must read as a 0.5 relevance, not 0.008.
		const col = mockKBChunksCol([
			{
				path: "mid.md",
				startLine: 1,
				endLine: 5,
				text: "half-ceiling RRF result",
				score: 0.0082,
			},
		])

		const results = await searchKB(col, "test", [0.1], {
			maxResults: 5,
			minScore: 0.4,
			scopeRef: "agent:test",
			vectorIndexName: "idx",
			textIndexName: "txt",
			capabilities: hybridCaps,
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(1)
		expect(results[0].score).toBeCloseTo(0.5002, 4)
	})

	it("uses $scoreFusion with minMaxScaler when fusionMethod=scoreFusion and capable (P0.10)", async () => {
		const hybridCaps: DetectedCapabilities = {
			...baseCapabilities,
			scoreFusion: true,
			rankFusion: true,
		}
		const col = mockKBChunksCol([
			{
				path: "fused.md",
				startLine: 1,
				endLine: 5,
				text: "score-fused result",
				score: 0.62,
			},
		])

		const results = await searchKB(col, "test", [0.1], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "idx",
			textIndexName: "txt",
			capabilities: hybridCaps,
			embeddingMode: "automated",
			fusionMethod: "scoreFusion",
		})

		expect(results).toHaveLength(1)
		// minMaxScaler yields a native [0,1] fused score — no local rescale.
		expect(results[0].score).toBeCloseTo(0.62, 4)
		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$scoreFusion.input.normalization).toBe("minMaxScaler")
	})

	it("falls back from $scoreFusion to $rankFusion when the server rejects it (P0.10)", async () => {
		const hybridCaps: DetectedCapabilities = {
			...baseCapabilities,
			scoreFusion: true,
			rankFusion: true,
		}
		let call = 0
		const col = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					call += 1
					if (call === 1) {
						throw new Error("$scoreFusion is not supported on this server")
					}
					return [
						{
							path: "rank.md",
							startLine: 1,
							endLine: 5,
							text: "rank-fusion fallback",
							score: 0.9,
						},
					]
				}),
			})),
		} as unknown as Collection

		const results = await searchKB(col, "test", [0.1], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "idx",
			textIndexName: "txt",
			capabilities: hybridCaps,
			embeddingMode: "automated",
			fusionMethod: "scoreFusion",
		})

		expect(results).toHaveLength(1)
		const secondPipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[1][0]
		expect(secondPipeline[0].$rankFusion).toBeDefined()
	})

	it("skips server-side fusion when fusionMethod=js-merge (P0.10)", async () => {
		const hybridCaps: DetectedCapabilities = {
			...baseCapabilities,
			scoreFusion: true,
			rankFusion: true,
		}
		const col = mockKBChunksCol([
			{
				path: "vector.md",
				startLine: 1,
				endLine: 5,
				text: "vector-only lane",
				score: 0.9,
			},
		])

		const results = await searchKB(col, "test", [0.1], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			vectorIndexName: "idx",
			textIndexName: "txt",
			capabilities: hybridCaps,
			embeddingMode: "automated",
			fusionMethod: "js-merge",
		})

		expect(results).toHaveLength(1)
		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$rankFusion).toBeUndefined()
		expect(pipeline[0].$scoreFusion).toBeUndefined()
	})

	it("pushes KB docId filters into the text-side compound.filter", async () => {
		const hybridCaps: DetectedCapabilities = {
			...baseCapabilities,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		}
		const col = mockKBChunksCol([
			{
				path: "filtered.md",
				startLine: 1,
				endLine: 3,
				text: "filtered",
				score: 0.8,
			},
		])
		const kbDocs = mockKBDocsCol(["doc-a", "doc-b"])

		await searchKB(col, "filtered", [0.2], {
			maxResults: 5,
			minScore: 0.1,
			scopeRef: "agent:test",
			filter: { tags: ["docs"], category: "architecture", source: "file" },
			kbDocs,
			vectorIndexName: "test_kb_chunks_vector",
			textIndexName: "test_kb_chunks_text",
			capabilities: hybridCaps,
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const textPipeline = pipeline[0].$rankFusion.input.pipelines.text
		expect(textPipeline[0].$search.compound.filter).toEqual([
			// Tenant isolation pre-filter is always present (issue #27).
			{ equals: { path: "scopeRef", value: "agent:test" } },
			{ in: { path: "docId", value: ["doc-a", "doc-b"] } },
		])
		expect(textPipeline[1]?.$match).toBeUndefined()
	})
})
