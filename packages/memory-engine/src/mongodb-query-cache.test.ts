import { createHash } from "node:crypto"
/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock buildVectorSearchStage before importing module under test
// ---------------------------------------------------------------------------

vi.mock("./mongodb-search.js", async () => {
	const actual = await vi.importActual<typeof import("./mongodb-search.js")>(
		"./mongodb-search.js",
	)
	return {
		...actual,
		buildVectorSearchStage: vi.fn(),
		runSearchAggregateWithRetry: vi.fn(async (collection, pipeline) => {
			return await collection.aggregate(pipeline).toArray()
		}),
	}
})

vi.mock("./mongodb-schema.js", () => ({
	queryCacheCollection: vi.fn(),
}))

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import {
	normalizeQuery,
	hashQuery,
	checkCache,
	writeCache,
	DEFAULT_CACHE_CONFIG,
	type QueryCacheConfig,
} from "./mongodb-query-cache.js"
import { queryCacheCollection } from "./mongodb-schema.js"
import { buildVectorSearchStage } from "./mongodb-search.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn().mockResolvedValue(null),
		findOneAndUpdate: vi.fn().mockResolvedValue(null),
		aggregate: vi
			.fn()
			.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
		updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
		...overrides,
	} as unknown as Collection
}

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const SCOPE = "agent" as const
const SCOPE_REF = "agent-scope-ref"

const DEFAULT_CONFIG: QueryCacheConfig = {
	enabled: true,
	conversationTtlSec: 300,
	kbTtlSec: 3600,
	similarityThreshold: 0.95,
}

// ---------------------------------------------------------------------------
// normalizeQuery
// ---------------------------------------------------------------------------

describe("normalizeQuery", () => {
	it("lowercases input", () => {
		expect(normalizeQuery("Hello World")).toBe("hello world")
	})

	it("collapses whitespace", () => {
		expect(normalizeQuery("hello   world   test")).toBe("hello world test")
	})

	it("trims leading and trailing whitespace", () => {
		expect(normalizeQuery("  hello world  ")).toBe("hello world")
	})

	it("handles empty string", () => {
		expect(normalizeQuery("")).toBe("")
	})

	it("handles whitespace-only string", () => {
		expect(normalizeQuery("   ")).toBe("")
	})

	it("normalizes tabs and newlines", () => {
		expect(normalizeQuery("hello\t\nworld")).toBe("hello world")
	})
})

// ---------------------------------------------------------------------------
// hashQuery
// ---------------------------------------------------------------------------

describe("hashQuery", () => {
	it("returns consistent SHA-256 hex digest", () => {
		const expected = createHash("sha256").update("hello world").digest("hex")
		expect(hashQuery("hello world")).toBe(expected)
		// Same input should produce same hash
		expect(hashQuery("hello world")).toBe(expected)
	})

	it("returns different hashes for different queries", () => {
		const hash1 = hashQuery("hello world")
		const hash2 = hashQuery("goodbye world")
		expect(hash1).not.toBe(hash2)
	})

	it("returns 64-character hex string", () => {
		const hash = hashQuery("test")
		expect(hash).toHaveLength(64)
		expect(hash).toMatch(/^[a-f0-9]{64}$/)
	})
})

// ---------------------------------------------------------------------------
// DEFAULT_CACHE_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_CACHE_CONFIG", () => {
	it("has expected default values", () => {
		expect(DEFAULT_CACHE_CONFIG.enabled).toBe(true)
		expect(DEFAULT_CACHE_CONFIG.conversationTtlSec).toBe(300)
		expect(DEFAULT_CACHE_CONFIG.kbTtlSec).toBe(3600)
		expect(DEFAULT_CACHE_CONFIG.similarityThreshold).toBe(0.95)
	})
})

// ---------------------------------------------------------------------------
// checkCache
// ---------------------------------------------------------------------------

describe("checkCache", () => {
	let mockCol: Collection

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
	})

	it("returns miss when disabled", async () => {
		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: { ...DEFAULT_CONFIG, enabled: false },
		})
		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
		expect(result.results).toEqual([])
	})

	it("returns miss for empty query", async () => {
		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "   ",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})
		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
	})

	it("Tier 1 returns exact match", async () => {
		const cachedResults = [
			{
				path: "/a.md",
				snippet: "cached",
				score: 0.9,
				source: "conversation",
				startLine: 1,
				endLine: 1,
			},
		]
		const cachedDoc = {
			_id: "doc-1",
			queryHash: hashQuery(normalizeQuery("test query")),
			results: cachedResults,
			pathUsed: "conversation-vector",
			sourceScope: "conversation",
			expiresAt: new Date(Date.now() + 60_000),
		}
		vi.mocked(mockCol.findOne).mockResolvedValue(cachedDoc as never)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(true)
		expect(result.tier).toBe("exact")
		expect(result.results).toEqual(cachedResults)
		expect(result.pathUsed).toBe("conversation-vector")
		expect(result.sourceScope).toBe("conversation")
	})

	it("Tier 1 skips expired entries", async () => {
		// findOne returns null when expiresAt filter doesn't match (expired)
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)
		vi.mocked(buildVectorSearchStage).mockReturnValue(null)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
		// Verify the findOne was called with expiresAt filter
		expect(mockCol.findOne).toHaveBeenCalledWith(
			expect.objectContaining({
				expiresAt: expect.objectContaining({ $gt: expect.any(Date) }),
			}),
		)
	})

	it("Tier 1 increments hitCount on hit (fire-and-forget)", async () => {
		const cachedDoc = {
			_id: "doc-1",
			results: [],
			pathUsed: "test",
			sourceScope: "conversation",
			expiresAt: new Date(Date.now() + 60_000),
		}
		vi.mocked(mockCol.findOne).mockResolvedValue(cachedDoc as never)

		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(mockCol.findOneAndUpdate).toHaveBeenCalledWith(
			{ _id: "doc-1" },
			expect.objectContaining({
				$inc: { hitCount: 1 },
				$set: expect.objectContaining({ lastHitAt: expect.any(Date) }),
			}),
		)
	})

	it("Tier 2 returns semantic match above threshold", async () => {
		// Tier 1 misses
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)

		const semanticResults = [
			{
				path: "/b.md",
				snippet: "semantic",
				score: 0.8,
				source: "reference",
				startLine: 1,
				endLine: 1,
			},
		]
		const vsStage = { index: "test_query_cache_vector", limit: 1 }
		vi.mocked(buildVectorSearchStage).mockReturnValue(vsStage)

		const toArrayFn = vi.fn().mockResolvedValue([
			{
				_id: "doc-2",
				results: semanticResults,
				pathUsed: "reference-vector",
				sourceScope: "reference",
				expiresAt: new Date(Date.now() + 60_000),
				score: 0.97,
			},
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(true)
		expect(result.tier).toBe("semantic")
		expect(result.results).toEqual(semanticResults)
		expect(result.pathUsed).toBe("reference-vector")
	})

	it("Tier 2 rejects match below threshold", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)

		const vsStage = { index: "test_query_cache_vector", limit: 1 }
		vi.mocked(buildVectorSearchStage).mockReturnValue(vsStage)

		const toArrayFn = vi.fn().mockResolvedValue([
			{
				_id: "doc-2",
				results: [],
				pathUsed: "test",
				sourceScope: "conversation",
				expiresAt: new Date(Date.now() + 60_000),
				score: 0.8, // Below 0.95 threshold
			},
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
	})

	it("Tier 2 rejects expired semantic match", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)

		const vsStage = { index: "test_query_cache_vector", limit: 1 }
		vi.mocked(buildVectorSearchStage).mockReturnValue(vsStage)

		const toArrayFn = vi.fn().mockResolvedValue([
			{
				_id: "doc-2",
				results: [],
				pathUsed: "test",
				sourceScope: "conversation",
				expiresAt: new Date(Date.now() - 60_000), // Expired
				score: 0.99,
			},
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
	})

	it("returns miss when both tiers miss", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)
		vi.mocked(buildVectorSearchStage).mockReturnValue(null)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
		expect(result.results).toEqual([])
	})

	it("handles Tier 1 error gracefully", async () => {
		vi.mocked(mockCol.findOne).mockRejectedValue(
			new Error("DB connection error") as never,
		)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
	})

	it("handles Tier 2 error gracefully (degrades to miss)", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)

		const vsStage = { index: "test_query_cache_vector", limit: 1 }
		vi.mocked(buildVectorSearchStage).mockReturnValue(vsStage)

		const toArrayFn = vi
			.fn()
			.mockRejectedValue(new Error("Vector search unavailable"))
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
	})

	it("uses custom vectorIndexName when provided", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)
		vi.mocked(buildVectorSearchStage).mockReturnValue(null)

		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
			vectorIndexName: "custom_index",
		})

		expect(buildVectorSearchStage).toHaveBeenCalledWith(
			expect.objectContaining({ indexName: "custom_index" }),
		)
	})

	it("Tier 2 increments hitCount on semantic hit (fire-and-forget)", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)

		const vsStage = { index: "test_query_cache_vector", limit: 1 }
		vi.mocked(buildVectorSearchStage).mockReturnValue(vsStage)

		const toArrayFn = vi.fn().mockResolvedValue([
			{
				_id: "doc-semantic",
				results: [],
				pathUsed: "test",
				sourceScope: "conversation",
				expiresAt: new Date(Date.now() + 60_000),
				score: 0.98,
			},
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(mockCol.findOneAndUpdate).toHaveBeenCalledWith(
			{ _id: "doc-semantic" },
			expect.objectContaining({
				$inc: { hitCount: 1 },
				$set: expect.objectContaining({ lastHitAt: expect.any(Date) }),
			}),
		)
	})
})

// ---------------------------------------------------------------------------
// writeCache
// ---------------------------------------------------------------------------

describe("writeCache", () => {
	let mockCol: Collection

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
	})

	it("writes entry with correct fields", () => {
		const results = [
			{
				path: "/a.md",
				snippet: "test",
				score: 0.9,
				source: "conversation" as const,
				startLine: 1,
				endLine: 1,
			},
		]

		writeCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "Test Query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			results,
			pathUsed: "conversation-vector",
			sourceScope: "conversation",
			ttlSec: 300,
		})

		expect(mockCol.updateOne).toHaveBeenCalledOnce()
		const [filter, update, options] = vi.mocked(mockCol.updateOne).mock.calls[0]

		// Filter uses the hash of normalized query
		expect(filter).toEqual(
			expect.objectContaining({
				queryHash: hashQuery(normalizeQuery("Test Query")),
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
			}),
		)

		// $setOnInsert has creation-time fields
		expect((update as Document).$setOnInsert).toEqual(
			expect.objectContaining({
				queryNorm: normalizeQuery("Test Query"),
				createdAt: expect.any(Date),
				hitCount: 0,
			}),
		)

		// $set has mutable fields
		expect((update as Document).$set).toEqual(
			expect.objectContaining({
				results,
				pathUsed: "conversation-vector",
				sourceScope: "conversation",
				expiresAt: expect.any(Date),
				lastHitAt: expect.any(Date),
			}),
		)

		// Upsert enabled
		expect(options).toEqual(expect.objectContaining({ upsert: true }))
	})

	it("skips empty query", () => {
		writeCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "   ",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			results: [
				{
					path: "/a.md",
					snippet: "test",
					score: 0.9,
					source: "conversation",
					startLine: 1,
					endLine: 1,
				},
			],
			pathUsed: "test",
			sourceScope: "conversation",
			ttlSec: 300,
		})

		expect(mockCol.updateOne).not.toHaveBeenCalled()
	})

	it("skips empty results", () => {
		writeCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			results: [],
			pathUsed: "test",
			sourceScope: "conversation",
			ttlSec: 300,
		})

		expect(mockCol.updateOne).not.toHaveBeenCalled()
	})

	it("uses upsert (handles race condition)", () => {
		const results = [
			{
				path: "/a.md",
				snippet: "test",
				score: 0.9,
				source: "conversation" as const,
				startLine: 1,
				endLine: 1,
			},
		]

		writeCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			results,
			pathUsed: "test",
			sourceScope: "conversation",
			ttlSec: 300,
		})

		const [, , options] = vi.mocked(mockCol.updateOne).mock.calls[0]
		expect(options).toEqual(expect.objectContaining({ upsert: true }))
	})

	it("is fire-and-forget (does not throw on updateOne failure)", () => {
		vi.mocked(mockCol.updateOne).mockReturnValue(
			Promise.reject(new Error("Write failed")) as never,
		)

		// Should not throw
		expect(() => {
			writeCache({
				db: {} as Db,
				prefix: PREFIX,
				query: "test query",
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				results: [
					{
						path: "/a.md",
						snippet: "test",
						score: 0.9,
						source: "conversation",
						startLine: 1,
						endLine: 1,
					},
				],
				pathUsed: "test",
				sourceScope: "conversation",
				ttlSec: 300,
			})
		}).not.toThrow()
	})

	it("sets correct expiresAt from ttlSec", () => {
		const beforeTime = Date.now()

		writeCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			results: [
				{
					path: "/a.md",
					snippet: "test",
					score: 0.9,
					source: "conversation",
					startLine: 1,
					endLine: 1,
				},
			],
			pathUsed: "test",
			sourceScope: "conversation",
			ttlSec: 600,
		})

		const afterTime = Date.now()
		const [, update] = vi.mocked(mockCol.updateOne).mock.calls[0]
		const expiresAt = (update as Document).$set.expiresAt as Date
		// expiresAt should be ~600 seconds from now
		expect(expiresAt.getTime()).toBeGreaterThanOrEqual(beforeTime + 600_000)
		expect(expiresAt.getTime()).toBeLessThanOrEqual(afterTime + 600_000)
	})
})

// ---------------------------------------------------------------------------
// Telemetry emission from checkCache
// ---------------------------------------------------------------------------

describe("checkCache telemetry emission", () => {
	let mockCol: Collection

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
	})

	it("emits cache-check telemetry on exact hit", async () => {
		const cachedDoc = {
			_id: "doc-1",
			results: [],
			pathUsed: "test",
			sourceScope: "conversation",
			expiresAt: new Date(Date.now() + 60_000),
		}
		vi.mocked(mockCol.findOne).mockResolvedValue(cachedDoc as never)

		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			{},
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "cache-check" },
				ok: true,
				cacheHit: true,
				durationMs: expect.any(Number),
			}),
		)
	})

	it("emits cache-check telemetry on miss", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null as never)
		vi.mocked(buildVectorSearchStage).mockReturnValue(null)

		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			{},
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "cache-check" },
				ok: true,
				cacheHit: false,
				durationMs: expect.any(Number),
			}),
		)
	})

	it("does not emit telemetry when cache is disabled", async () => {
		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: { ...DEFAULT_CONFIG, enabled: false },
		})

		expect(emitTelemetry).not.toHaveBeenCalled()
	})

	it("does not emit telemetry for empty query", async () => {
		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "   ",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
		})

		expect(emitTelemetry).not.toHaveBeenCalled()
	})
})
