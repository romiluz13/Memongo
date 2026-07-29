/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./mongodb-schema.js", () => ({
	chunksCollection: vi.fn(),
	filesCollection: vi.fn(),
	embeddingCacheCollection: vi.fn(),
	kbChunksCollection: vi.fn(),
	structuredMemCollection: vi.fn(),
}))

import {
	getMemoryStats,
	measureEmbeddingCoverage,
	reconcileEmbeddingStatus,
} from "./mongodb-analytics.js"
import {
	chunksCollection,
	filesCollection,
	embeddingCacheCollection,
	kbChunksCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockCol(overrides: Record<string, unknown> = {}): Collection {
	return {
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		countDocuments: vi.fn(async () => 0),
		distinct: vi.fn(async () => []),
		find: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		...overrides,
	} as unknown as Collection
}

let mockChunks: Collection
let mockFiles: Collection
let mockCache: Collection
let mockKbChunks: Collection
let mockStructuredMem: Collection
const db = {} as Db

beforeEach(() => {
	vi.clearAllMocks()
	mockChunks = createMockCol()
	mockFiles = createMockCol()
	mockCache = createMockCol()
	mockKbChunks = createMockCol()
	mockStructuredMem = createMockCol()
	vi.mocked(chunksCollection).mockReturnValue(mockChunks)
	vi.mocked(filesCollection).mockReturnValue(mockFiles)
	vi.mocked(embeddingCacheCollection).mockReturnValue(mockCache)
	vi.mocked(kbChunksCollection).mockReturnValue(mockKbChunks)
	vi.mocked(structuredMemCollection).mockReturnValue(mockStructuredMem)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getMemoryStats", () => {
	it("returns zero stats for empty collections", async () => {
		const stats = await getMemoryStats(db, "test_")

		expect(stats.totalFiles).toBe(0)
		expect(stats.totalChunks).toBe(0)
		expect(stats.cachedEmbeddings).toBe(0)
		expect(stats.sources).toEqual([])
		expect(stats.staleFiles).toEqual([])
		expect(stats.embeddingCoverage.coveragePercent).toBe(0)
		expect(stats.embeddingStatusCoverage).toEqual({
			total: 0,
			success: 0,
			failed: 0,
			pending: 0,
			unknown: 0,
			basis: "stored-vector",
		})
		expect(stats.collectionSizes.files).toBe(0)
		expect(stats.collectionSizes.chunks).toBe(0)
		expect(stats.collectionSizes.embeddingCache).toBe(0)
	})

	it("#26: derives embedding status coverage from real embedding presence, not the unadvanced field", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) }) // source counts
			.mockReturnValueOnce({
				toArray: vi.fn(async () => [
					{ _id: null, withEmbedding: 8, total: 10 },
				]),
			}) // embeddingCoverage
			.mockReturnValueOnce({
				toArray: vi.fn(async () => [
					{ _id: null, total: 10, withEmbedding: 8 },
				]),
			}) // status coverage (chunks)
		;(mockKbChunks.aggregate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			toArray: vi.fn(async () => [{ _id: null, total: 4, withEmbedding: 1 }]),
		})
		;(
			mockStructuredMem.aggregate as ReturnType<typeof vi.fn>
		).mockReturnValueOnce({
			toArray: vi.fn(async () => [{ _id: null, total: 2, withEmbedding: 2 }]),
		})

		const stats = await getMemoryStats(db, "test_")

		// success reflects docs that actually carry a vector; nothing is
		// fabricated as "pending" from the never-advanced embeddingStatus field.
		expect(stats.embeddingStatusCoverage).toEqual({
			total: 16,
			success: 11,
			failed: 0,
			pending: 5,
			unknown: 0,
			basis: "stored-vector",
		})
	})

	it("#26: derives automated embedding coverage from queryable Search index documents", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(
			10,
		)
		;(
			mockKbChunks.countDocuments as ReturnType<typeof vi.fn>
		).mockResolvedValue(4)
		;(
			mockStructuredMem.countDocuments as ReturnType<typeof vi.fn>
		).mockResolvedValue(2)

		const searchIndexCounts = new Map([
			["test_chunks_vector", 8],
			["test_kb_chunks_vector", 1],
			["test_structured_mem_vector", 2],
		])
		for (const col of [mockChunks, mockKbChunks, mockStructuredMem]) {
			;(col.aggregate as ReturnType<typeof vi.fn>).mockImplementation(
				(pipeline: Array<Record<string, unknown>>) => ({
					toArray: vi.fn(async () => {
						const list = pipeline[0]?.$listSearchIndexes as
							| { name?: string }
							| undefined
						if (list?.name) {
							return [
								{
									name: list.name,
									status: "READY",
									queryable: true,
									numDocs: searchIndexCounts.get(list.name),
									latestDefinition: {
										fields: [{ type: "autoEmbed", path: "text" }],
									},
								},
							]
						}
						return []
					}),
				}),
			)
		}

		const stats = await getMemoryStats(db, "test_", undefined, {
			embeddingMode: "automated",
		})

		expect(stats.embeddingCoverage).toEqual({
			withEmbedding: 8,
			withoutEmbedding: 2,
			unknown: 0,
			total: 10,
			coveragePercent: 80,
			basis: "search-index",
		})
		expect(stats.embeddingStatusCoverage).toEqual({
			total: 16,
			success: 11,
			failed: 0,
			pending: 5,
			unknown: 0,
			basis: "search-index",
		})
	})

	it("#26: reports automated coverage as unknown when Search index counts are not observable", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(
			10,
		)
		;(
			mockKbChunks.countDocuments as ReturnType<typeof vi.fn>
		).mockResolvedValue(4)
		;(
			mockStructuredMem.countDocuments as ReturnType<typeof vi.fn>
		).mockResolvedValue(2)
		for (const col of [mockChunks, mockKbChunks, mockStructuredMem]) {
			;(col.aggregate as ReturnType<typeof vi.fn>).mockImplementation(
				(pipeline: Array<Record<string, unknown>>) => ({
					toArray: vi.fn(async () => {
						if (pipeline[0]?.$listSearchIndexes) {
							return [
								{
									status: "READY",
									queryable: true,
									latestDefinition: {
										fields: [{ type: "autoEmbed", path: "text" }],
									},
								},
							]
						}
						return []
					}),
				}),
			)
		}

		const stats = await getMemoryStats(db, "test_", undefined, {
			embeddingMode: "automated",
		})

		expect(stats.embeddingCoverage).toMatchObject({
			withEmbedding: 0,
			withoutEmbedding: 0,
			unknown: 10,
			total: 10,
			coveragePercent: null,
			basis: "search-index",
		})
		expect(stats.embeddingStatusCoverage).toMatchObject({
			total: 16,
			success: 0,
			failed: 0,
			pending: 0,
			unknown: 16,
			basis: "search-index",
		})
	})

	it("#26: reconcileEmbeddingStatus advances only docs carrying a vector", async () => {
		const updateMany = vi.fn(async () => ({ modifiedCount: 3 }))
		const cols = [mockChunks, mockKbChunks, mockStructuredMem]
		for (const col of cols) {
			;(col as unknown as { updateMany: unknown }).updateMany = updateMany
		}

		const res = await reconcileEmbeddingStatus(db, "test_")

		expect(res.advanced).toBe(9) // 3 per collection × 3 collections
		expect(updateMany).toHaveBeenCalledWith(
			{
				"embedding.0": { $exists: true },
				embeddingStatus: { $ne: "success" },
			},
			{ $set: { embeddingStatus: "success" } },
		)
	})

	it("returns per-source breakdown for memory + sessions", async () => {
		// Mock files aggregate: two sources
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => [
				{ _id: "memory", count: 5, lastSync: new Date("2026-01-01") },
				{ _id: "sessions", count: 3, lastSync: new Date("2026-01-02") },
			]),
		})
		// Mock chunks aggregate for source counts
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({
				// First call: chunk source agg
				toArray: vi.fn(async () => [
					{ _id: "memory", count: 20 },
					{ _id: "sessions", count: 10 },
				]),
			})
			.mockReturnValueOnce({
				// Second call: embedding coverage agg
				toArray: vi.fn(async () => [
					{ _id: null, withEmbedding: 15, total: 30 },
				]),
			})
		;(mockFiles.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(8)

		const stats = await getMemoryStats(db, "test_")

		expect(stats.sources).toHaveLength(2)
		const memorySrc = stats.sources.find((s) => s.source === "memory")
		expect(memorySrc).toBeDefined()
		if (!memorySrc) {
			throw new Error("Expected memory source stats")
		}
		expect(memorySrc.fileCount).toBe(5)
		expect(memorySrc.chunkCount).toBe(20)
		expect(memorySrc.lastSync).toEqual(new Date("2026-01-01"))

		const sessionsSrc = stats.sources.find((s) => s.source === "sessions")
		expect(sessionsSrc).toBeDefined()
		if (!sessionsSrc) {
			throw new Error("Expected sessions source stats")
		}
		expect(sessionsSrc.fileCount).toBe(3)
		expect(sessionsSrc.chunkCount).toBe(10)
	})

	it("calculates embedding coverage percentage", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
			.mockReturnValueOnce({
				toArray: vi.fn(async () => [
					{ _id: null, withEmbedding: 7, total: 10 },
				]),
			})

		const stats = await getMemoryStats(db, "test_")

		expect(stats.embeddingCoverage.withEmbedding).toBe(7)
		expect(stats.embeddingCoverage.withoutEmbedding).toBe(3)
		expect(stats.embeddingCoverage.total).toBe(10)
		expect(stats.embeddingCoverage.coveragePercent).toBe(70)
	})

	it("detects stale files when validPaths is provided", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockFiles.find as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => [
				{ path: "memory/keep.md" },
				{ path: "memory/stale.md" },
				{ path: "sessions/old.jsonl" },
			]),
		})
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })

		const validPaths = new Set(["memory/keep.md"])
		const stats = await getMemoryStats(db, "test_", validPaths)

		expect(stats.staleFiles).toEqual(["memory/stale.md", "sessions/old.jsonl"])
	})

	it("skips stale detection when no validPaths provided", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })

		const stats = await getMemoryStats(db, "test_")

		expect(stats.staleFiles).toEqual([])
		expect(mockFiles.find).not.toHaveBeenCalled()
	})

	it("aggregates embedding coverage across all chunk collections from real presence", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) }) // source agg
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) }) // embedding agg
			.mockReturnValueOnce({
				toArray: vi.fn(async () => [
					{ _id: null, total: 15, withEmbedding: 10 },
				]),
			}) // status coverage for chunks
		;(mockKbChunks.aggregate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			toArray: vi.fn(async () => [{ _id: null, total: 6, withEmbedding: 5 }]),
		})
		;(
			mockStructuredMem.aggregate as ReturnType<typeof vi.fn>
		).mockReturnValueOnce({
			toArray: vi.fn(async () => [{ _id: null, total: 4, withEmbedding: 4 }]),
		})

		const stats = await getMemoryStats(db, "test_")

		// Totals: chunks 15 + kb 6 + structured 4 = 25; embedded 10+5+4 = 19.
		expect(stats.embeddingStatusCoverage.total).toBe(25)
		expect(stats.embeddingStatusCoverage.success).toBe(19)
		expect(stats.embeddingStatusCoverage.failed).toBe(0)
		expect(stats.embeddingStatusCoverage.pending).toBe(6) // 25 - 19
	})

	it("counts documents without an embedding vector as pending, not fabricated", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
			.mockReturnValueOnce({
				toArray: vi.fn(async () => [{ _id: null, total: 8, withEmbedding: 0 }]),
			})
		;(mockKbChunks.aggregate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			toArray: vi.fn(async () => []),
		})
		;(
			mockStructuredMem.aggregate as ReturnType<typeof vi.fn>
		).mockReturnValueOnce({
			toArray: vi.fn(async () => []),
		})

		const stats = await getMemoryStats(db, "test_")

		expect(stats.embeddingStatusCoverage.pending).toBe(8)
		expect(stats.embeddingStatusCoverage.success).toBe(0)
		expect(stats.embeddingStatusCoverage.failed).toBe(0)
	})

	it("counts cached embeddings", async () => {
		;(mockFiles.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		;(mockChunks.aggregate as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
		;(mockCache.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(
			42,
		)

		const stats = await getMemoryStats(db, "test_")

		expect(stats.cachedEmbeddings).toBe(42)
		expect(stats.collectionSizes.embeddingCache).toBe(42)
	})
})

describe("measureEmbeddingCoverage on a server without numDocs", () => {
	// Atlas does not report numDocs on $listSearchIndexes; only the local
	// atlas-local container does. Keying coverage on that field left coverage
	// permanently `unknown` against a real cluster — the deployment that
	// actually matters — while the dev container looked fine.
	const readyAutoEmbedIndex = {
		name: "vec_idx",
		status: "READY",
		queryable: true,
		latestDefinition: {
			fields: [{ type: "autoEmbed", modality: "text", path: "text" }],
		},
	}

	function collectionWith(params: {
		total: number
		index: Record<string, unknown>
		probeCount?: number | null
		onVectorSearch?: (stage: Record<string, unknown>) => void
	}): Collection {
		return {
			countDocuments: vi.fn(async () => params.total),
			aggregate: vi.fn((pipeline: Array<Record<string, unknown>>) => {
				const stage = pipeline[0] ?? {}
				if ("$listSearchIndexes" in stage) {
					return { toArray: vi.fn(async () => [params.index]) }
				}
				if ("$vectorSearch" in stage) {
					params.onVectorSearch?.(
						stage.$vectorSearch as Record<string, unknown>,
					)
					if (params.probeCount === null) {
						throw new Error("probe unavailable")
					}
					return {
						toArray: vi.fn(async () => [{ n: params.probeCount }]),
					}
				}
				return { toArray: vi.fn(async () => []) }
			}),
		} as unknown as Collection
	}

	it("measures what the index will actually return", async () => {
		let seen: Record<string, unknown> | undefined
		const collection = collectionWith({
			total: 3,
			index: readyAutoEmbedIndex,
			probeCount: 3,
			onVectorSearch: (stage) => {
				seen = stage
			},
		})

		const result = await measureEmbeddingCoverage({
			collection,
			indexName: "vec_idx",
			embeddingMode: "automated",
		})

		expect(result).toEqual({
			total: 3,
			success: 3,
			failed: 0,
			pending: 0,
			unknown: 0,
			basis: "search-index",
		})
		// The probe must target the autoEmbed field, or it cannot embed the query.
		expect(seen?.path).toBe("text")
		expect(seen?.index).toBe("vec_idx")
	})

	it("reports the shortfall as pending rather than as covered", async () => {
		const collection = collectionWith({
			total: 5,
			index: readyAutoEmbedIndex,
			probeCount: 2,
		})
		const result = await measureEmbeddingCoverage({
			collection,
			indexName: "vec_idx",
			embeddingMode: "automated",
		})
		expect(result).toMatchObject({
			total: 5,
			success: 2,
			pending: 3,
			unknown: 0,
		})
	})

	it("stays unknown when the probe itself cannot answer", async () => {
		const collection = collectionWith({
			total: 3,
			index: readyAutoEmbedIndex,
			probeCount: null,
		})
		const result = await measureEmbeddingCoverage({
			collection,
			indexName: "vec_idx",
			embeddingMode: "automated",
		})
		expect(result).toMatchObject({ total: 3, success: 0, unknown: 3 })
	})

	it("refuses to guess for a collection larger than one probe can cover", async () => {
		// numCandidates and limit are both server-capped at 10k, so a bigger
		// collection cannot be measured in one query. Reporting the capped count
		// as the total would understate coverage as a hard number.
		let probed = false
		const collection = collectionWith({
			total: 10_001,
			index: readyAutoEmbedIndex,
			probeCount: 10_000,
			onVectorSearch: () => {
				probed = true
			},
		})
		const result = await measureEmbeddingCoverage({
			collection,
			indexName: "vec_idx",
			embeddingMode: "automated",
		})
		expect(result).toMatchObject({ unknown: 10_001, success: 0 })
		expect(probed).toBe(false)
	})

	it("still prefers numDocs when the server does report it", async () => {
		let probed = false
		const collection = collectionWith({
			total: 4,
			index: { ...readyAutoEmbedIndex, numDocs: 4 },
			probeCount: 999,
			onVectorSearch: () => {
				probed = true
			},
		})
		const result = await measureEmbeddingCoverage({
			collection,
			indexName: "vec_idx",
			embeddingMode: "automated",
		})
		expect(result).toMatchObject({ total: 4, success: 4, unknown: 0 })
		// No reason to pay for an ANN query when the cheap field is present.
		expect(probed).toBe(false)
	})

	it("does not probe an index that is not ready", async () => {
		let probed = false
		const collection = collectionWith({
			total: 3,
			index: { ...readyAutoEmbedIndex, status: "BUILDING", queryable: false },
			probeCount: 3,
			onVectorSearch: () => {
				probed = true
			},
		})
		const result = await measureEmbeddingCoverage({
			collection,
			indexName: "vec_idx",
			embeddingMode: "automated",
		})
		expect(result).toMatchObject({ unknown: 3, success: 0 })
		expect(probed).toBe(false)
	})
})
