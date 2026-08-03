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
		runSearchAggregateWithRetry: vi.fn(async (collection, pipeline, opts) => {
			return await collection
				.aggregate(pipeline, opts?.aggregateOptions)
				.toArray()
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
	serializeKeyParams,
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
		estimatedDocumentCount: vi.fn().mockResolvedValue(1),
		countDocuments: vi.fn().mockResolvedValue(1),
		aggregate: vi
			.fn()
			.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
		updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
		deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
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

	it("skips the semantic tier entirely when the namespace has no live entries", async () => {
		// P2.4 expected-win gate: the tier-2 probe is a $vectorSearch with
		// server-side query embedding — a full provider round-trip spent on a
		// cache that cannot hit. The gate is a bounded countDocuments against
		// the caller's OWN (agentId, scope, scopeRef) namespace.
		vi.mocked(mockCol.findOne).mockResolvedValue(null)
		const countDocuments = vi.fn().mockResolvedValue(0)
		;(mockCol as unknown as Record<string, unknown>).countDocuments =
			countDocuments
		vi.mocked(buildVectorSearchStage).mockReturnValue({
			index: "test_query_cache_vector",
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
		expect(countDocuments).toHaveBeenCalledWith(
			{
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				expiresAt: expect.objectContaining({ $gt: expect.any(Date) }),
			},
			{ limit: 1 },
		)
		expect(mockCol.aggregate).not.toHaveBeenCalled()
	})

	it("caps the semantic probe latency with maxTimeMS", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null)
		;(mockCol as unknown as Record<string, unknown>).countDocuments = vi
			.fn()
			.mockResolvedValue(3)
		vi.mocked(buildVectorSearchStage).mockReturnValue({
			index: "test_query_cache_vector",
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

		expect(mockCol.aggregate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ maxTimeMS: expect.any(Number) }),
		)
	})

	it("splits its reported latency into the exact lookup and the semantic probe", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue(null)
		;(mockCol as unknown as Record<string, unknown>).countDocuments = vi
			.fn()
			.mockResolvedValue(3)
		vi.mocked(buildVectorSearchStage).mockReturnValue({
			index: "test_query_cache_vector",
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

		expect(result.latency?.exactMs).toBeGreaterThanOrEqual(0)
		expect(result.latency?.semanticMs).toBeGreaterThanOrEqual(0)
	})

	it("reports a zero semantic probe cost when the exact tier hits", async () => {
		vi.mocked(mockCol.findOne).mockResolvedValue({
			_id: "doc-1",
			results: [],
			pathUsed: "test",
			sourceScope: "conversation",
			expiresAt: new Date(Date.now() + 60_000),
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

		expect(result.tier).toBe("exact")
		expect(result.latency?.semanticMs).toBe(0)
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
// P2.4 — cache key composition (maxResults/minScore/timeRange fold into hash)
// ---------------------------------------------------------------------------

describe("query cache key composition (P2.4)", () => {
	it("folds maxResults into the hash: same query, different maxResults → distinct keys", () => {
		const h1 = hashQuery(normalizeQuery("deploy runbook"), { maxResults: 10 })
		const h2 = hashQuery(normalizeQuery("deploy runbook"), { maxResults: 20 })
		expect(h1).not.toBe(h2)
	})

	it("folds minScore and timeRange into the hash", () => {
		const base = hashQuery("deploy runbook", { maxResults: 10 })
		expect(
			hashQuery("deploy runbook", { maxResults: 10, minScore: 0.2 }),
		).not.toBe(base)
		expect(
			hashQuery("deploy runbook", {
				maxResults: 10,
				timeRange: { start: "2026-01-01", end: "2026-02-01" },
			}),
		).not.toBe(base)
	})

	it("same effective params share one key regardless of how the request was spelled", () => {
		// The manager resolves defaults BEFORE calling the cache, so an explicit
		// maxResults=10 and a defaulted maxResults=10 arrive with identical
		// keyParams and must produce the identical hash.
		const explicit = hashQuery("deploy runbook", {
			maxResults: 10,
			minScore: 0.01,
		})
		const defaulted = hashQuery("deploy runbook", {
			maxResults: 10,
			minScore: 0.01,
		})
		expect(explicit).toBe(defaulted)
	})

	it("omitting keyParams keeps the legacy hash input (backwards compatible)", () => {
		const expected = createHash("sha256").update("deploy runbook").digest("hex")
		expect(hashQuery("deploy runbook")).toBe(expected)
	})

	it("serializes key params canonically (defined fields only, stable order)", () => {
		expect(serializeKeyParams(undefined)).toBe("")
		expect(serializeKeyParams({})).toBe("")
		expect(
			serializeKeyParams({
				maxResults: 10,
				minScore: 0.01,
				timeRange: { start: "2026-01-01" },
				questionDate: new Date("2026-04-09T00:00:00.000Z"),
			}),
		).toBe("k=10;s=0.01;t=|2026-01-01|;d=2026-04-09T00:00:00.000Z")
	})

	it("checkCache scopes the exact lookup by the folded key", async () => {
		const mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
		const keyParams = { maxResults: 10, minScore: 0.01 }

		await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
			keyParams,
		})

		expect(mockCol.findOne).toHaveBeenCalledWith(
			expect.objectContaining({
				queryHash: hashQuery(normalizeQuery("test query"), keyParams),
			}),
		)
	})

	it("tier 2 rejects a semantic candidate whose stored key params differ", async () => {
		const mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
		vi.mocked(mockCol.findOne).mockResolvedValue(null)
		vi.mocked(buildVectorSearchStage).mockReturnValue({
			index: "test_query_cache_vector",
		} as never)
		// Cached under maxResults=5 ("k=5"), requested with maxResults=10.
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: vi.fn().mockResolvedValue([
				{
					_id: "doc-2",
					results: [],
					pathUsed: "test",
					sourceScope: "conversation",
					expiresAt: new Date(Date.now() + 60_000),
					score: 0.99,
					keySuffix: "k=5",
				},
			]),
		} as never)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
			keyParams: { maxResults: 10 },
		})

		expect(result.hit).toBe(false)
		expect(result.tier).toBe("miss")
	})

	it("tier 2 accepts a semantic candidate whose stored key params match", async () => {
		const mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
		vi.mocked(mockCol.findOne).mockResolvedValue(null)
		vi.mocked(buildVectorSearchStage).mockReturnValue({
			index: "test_query_cache_vector",
		} as never)
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: vi.fn().mockResolvedValue([
				{
					_id: "doc-3",
					results: [{ path: "/a.md", snippet: "x", score: 0.9 }],
					pathUsed: "test",
					sourceScope: "conversation",
					expiresAt: new Date(Date.now() + 60_000),
					score: 0.99,
					keySuffix: serializeKeyParams({ maxResults: 10 }),
				},
			]),
		} as never)

		const result = await checkCache({
			db: {} as Db,
			prefix: PREFIX,
			query: "test query",
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			config: DEFAULT_CONFIG,
			keyParams: { maxResults: 10 },
		})

		expect(result.hit).toBe(true)
		expect(result.tier).toBe("semantic")
	})
})

// ---------------------------------------------------------------------------
// P2.4 — probe concurrency + exactMs attribution
// ---------------------------------------------------------------------------

describe("checkCache probe concurrency (P2.4)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("starts the namespace gate concurrently with the exact lookup", async () => {
		vi.useFakeTimers()
		try {
			const mockCol = createMockCollection()
			vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
			const callOrder: string[] = []
			vi.mocked(mockCol.findOne).mockImplementation(
				() =>
					new Promise((resolve) => {
						callOrder.push("exact")
						setTimeout(() => resolve(null), 100)
					}) as never,
			)
			;(mockCol as unknown as Record<string, unknown>).countDocuments = vi
				.fn()
				.mockImplementation(
					() =>
						new Promise((resolve) => {
							callOrder.push("gate")
							setTimeout(() => resolve(0), 250)
						}),
				)

			const promise = checkCache({
				db: {} as Db,
				prefix: PREFIX,
				query: "test query",
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				config: DEFAULT_CONFIG,
			})
			// Both lanes were dispatched synchronously at t=0 — BEFORE either
			// resolved. A serial implementation (exact → then gate) would leave
			// the gate undispatched until t=100.
			expect(callOrder).toContain("exact")
			expect(callOrder).toContain("gate")
			await vi.advanceTimersByTimeAsync(300)
			const result = await promise

			expect(result.hit).toBe(false)
			expect(mockCol.aggregate).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("an exact hit short-circuits the probe path without waiting for the gate", async () => {
		const mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
		vi.mocked(mockCol.findOne).mockResolvedValue({
			_id: "doc-1",
			results: [],
			pathUsed: "test",
			sourceScope: "conversation",
			expiresAt: new Date(Date.now() + 60_000),
		} as never)
		// The gate never resolves; a correct implementation must not await it
		// once tier 1 has hit.
		;(mockCol as unknown as Record<string, unknown>).countDocuments = vi
			.fn()
			.mockReturnValue(new Promise(() => {}))

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
		expect(mockCol.aggregate).not.toHaveBeenCalled()
		expect(mockCol.findOneAndUpdate).toHaveBeenCalled()
	})

	it("measures exactMs as the tier-1 retrieval span, not setup-inclusive", async () => {
		const mockCol = createMockCollection()
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
		vi.mocked(mockCol.findOne).mockRejectedValue(new Error("boom"))
		const nowSpy = vi
			.spyOn(Date, "now")
			.mockReturnValueOnce(1_000) // cacheStart
			.mockReturnValueOnce(1_050) // exactStart (after normalization setup)
			.mockReturnValueOnce(1_100) // catch: exactMs must be 1100-1050=50
			.mockReturnValue(1_150) // telemetry durationMs

		try {
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
			expect(result.latency?.exactMs).toBe(50)
		} finally {
			nowSpy.mockRestore()
		}
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

	it("folds keyParams into the hash and stores the canonical keySuffix", () => {
		const keyParams = { maxResults: 10, minScore: 0.01 }

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
			keyParams,
		})

		const [filter, update] = vi.mocked(mockCol.updateOne).mock.calls[0]
		expect(filter).toEqual(
			expect.objectContaining({
				queryHash: hashQuery(normalizeQuery("test query"), keyParams),
			}),
		)
		expect((update as Document).$setOnInsert).toEqual(
			expect.objectContaining({
				keySuffix: serializeKeyParams(keyParams),
			}),
		)
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
