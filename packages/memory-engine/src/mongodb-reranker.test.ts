/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db } from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock telemetry before importing module under test
// ---------------------------------------------------------------------------

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import { crossEncoderRerank, type RerankConfig } from "./mongodb-reranker.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import type { MemorySearchResult } from "./types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DB = {} as Db
const PREFIX = "test_"
const AGENT_ID = "agent-1"
const QUERY = "how does authentication work"

function makeResult(
	overrides: Partial<MemorySearchResult> & { snippet: string; score: number },
): MemorySearchResult {
	return {
		path: "test/path",
		startLine: 0,
		endLine: 10,
		source: "conversation",
		...overrides,
	}
}

function makeConfig(overrides?: Partial<RerankConfig>): RerankConfig {
	return {
		enabled: true,
		model: "rerank-2.5",
		topN: 20,
		minScore: 0.1,
		voyageApiKey: "test-voyage-key",
		...overrides,
	}
}

function makeResults(count: number): MemorySearchResult[] {
	return Array.from({ length: count }, (_, i) =>
		makeResult({
			snippet: `Result snippet ${i}`,
			score: 0.9 - i * 0.1,
			path: `path/${i}`,
		}),
	)
}

function mockFetchSuccess(
	data: Array<{ index: number; relevance_score: number }>,
) {
	return vi.fn().mockResolvedValue({
		ok: true,
		json: () => Promise.resolve({ object: "list", data, model: "rerank-2.5" }),
	})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("crossEncoderRerank", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		vi.clearAllMocks()
		originalFetch = globalThis.fetch
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	// --- Early returns (no API call) ---

	it("returns input unchanged when disabled", async () => {
		const results = makeResults(3)
		const config = makeConfig({ enabled: false })

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
		expect(out.latencyMs).toBe(0)
	})

	it("returns input unchanged when no results", async () => {
		const config = makeConfig()

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: [],
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toEqual([])
	})

	it("returns input unchanged when no API key", async () => {
		const results = makeResults(3)
		const config = makeConfig({ voyageApiKey: "" })

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	it("returns input unchanged when single result (no reranking benefit)", async () => {
		const results = [makeResult({ snippet: "only one", score: 0.8 })]
		const config = makeConfig()

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	// --- Successful API call ---

	it("calls Voyage API with correct payload", async () => {
		const results = makeResults(3)
		const config = makeConfig()
		const mockFetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.95 },
			{ index: 1, relevance_score: 0.85 },
			{ index: 2, relevance_score: 0.75 },
		])
		globalThis.fetch = mockFetch

		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(mockFetch).toHaveBeenCalledOnce()
		const [url, options] = mockFetch.mock.calls[0]
		expect(url).toBe("https://api.voyageai.com/v1/rerank")
		expect(options.method).toBe("POST")
		expect(options.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer test-voyage-key",
		})
		const body = JSON.parse(options.body as string)
		expect(body.model).toBe("rerank-2.5")
		expect(body.query).toBe(QUERY)
		expect(body.documents).toEqual(results.map((r) => r.snippet))
		expect(body.top_k).toBe(3)
	})

	it("maps scores back onto correct results and re-sorts descending", async () => {
		const results = makeResults(3)
		const config = makeConfig()
		// Voyage returns reversed order: index 2 is highest
		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.3 },
			{ index: 1, relevance_score: 0.5 },
			{ index: 2, relevance_score: 0.9 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(true)
		expect(out.results.length).toBe(3)
		// Sorted by relevance_score descending: index 2 (0.9), index 1 (0.5), index 0 (0.3)
		expect(out.results[0].snippet).toBe("Result snippet 2")
		expect(out.results[0].score).toBe(0.9)
		expect(out.results[1].snippet).toBe("Result snippet 1")
		expect(out.results[1].score).toBe(0.5)
		expect(out.results[2].snippet).toBe("Result snippet 0")
		expect(out.results[2].score).toBe(0.3)
	})

	it("appends below-minScore results at end", async () => {
		const aboveMin = [
			makeResult({ snippet: "high1", score: 0.5, path: "a" }),
			makeResult({ snippet: "high2", score: 0.4, path: "b" }),
		]
		const belowMin = [makeResult({ snippet: "low1", score: 0.05, path: "c" })]
		const results = [...aboveMin, ...belowMin]
		const config = makeConfig({ minScore: 0.1 })

		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.6 },
			{ index: 1, relevance_score: 0.8 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(true)
		// Reranked candidates first (sorted by score), then remainder
		expect(out.results.length).toBe(3)
		expect(out.results[0].snippet).toBe("high2") // 0.8 from reranker
		expect(out.results[1].snippet).toBe("high1") // 0.6 from reranker
		expect(out.results[2].snippet).toBe("low1") // below-minScore, appended
	})

	it("slices candidates to topN", async () => {
		const results = makeResults(5)
		const config = makeConfig({ topN: 3 })

		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.95 },
			{ index: 1, relevance_score: 0.85 },
			{ index: 2, relevance_score: 0.75 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(true)
		// 3 reranked + 2 remainder (below topN threshold but above minScore, these go to remainder)
		const body = JSON.parse(
			(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
				.body as string,
		)
		expect(body.documents.length).toBe(3)
	})

	it("clamps relevance_score to [0,1]", async () => {
		const results = makeResults(2)
		const config = makeConfig()

		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 1.5 },
			{ index: 1, relevance_score: -0.3 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(true)
		expect(out.results[0].score).toBe(1) // clamped from 1.5
		expect(out.results[1].score).toBe(0) // clamped from -0.3
	})

	it("uses correct model from config", async () => {
		const results = makeResults(2)
		const config = makeConfig({ model: "rerank-2.5-lite" })

		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
		])

		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		const body = JSON.parse(
			(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
				.body as string,
		)
		expect(body.model).toBe("rerank-2.5-lite")
	})

	it("prepends instruction to query when config.instruction is set", async () => {
		const results = makeResults(2)
		const config = makeConfig({
			instruction:
				"This is agent conversation memory. Prioritize recent results.",
		})

		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
		])

		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		const body = JSON.parse(
			(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
				.body as string,
		)
		expect(body.query).toBe(
			`This is agent conversation memory. Prioritize recent results.\n${QUERY}`,
		)
	})

	// --- Error handling (fallback to input) ---

	it("falls back on API error (non-OK status)", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			json: () => Promise.resolve({ error: "rate limited" }),
		})

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	it("falls back on network error", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		globalThis.fetch = vi.fn().mockRejectedValue(new Error("network timeout"))

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	it("falls back on JSON parse error", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.reject(new Error("invalid json")),
		})

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	it("falls back on unexpected response shape (no data field)", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ results: [] }), // wrong key: 'results' instead of 'data'
		})

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	// --- Telemetry ---

	it("emits rerank telemetry on success", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
			{ index: 2, relevance_score: 0.7 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(true)
		expect(emitTelemetry).toHaveBeenCalledOnce()
		const [db, prefix, doc] = vi.mocked(emitTelemetry).mock.calls[0]
		expect(db).toBe(DB)
		expect(prefix).toBe(PREFIX)
		expect(doc.meta).toEqual({ agentId: AGENT_ID, operation: "rerank" })
		expect(doc.ok).toBe(true)
		expect(doc.resultCount).toBe(3)
		expect(doc.rerankModel).toBe("rerank-2.5")
		expect(typeof doc.rerankLatencyMs).toBe("number")
		expect(typeof doc.durationMs).toBe("number")
	})

	it("reports reranked:false on fallback and emits failure telemetry", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"))

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		// Should emit failure telemetry (M1 audit fix)
		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "rerank" },
				ok: false,
			}),
		)
	})

	// --- Timeout (C1) ---

	it("aborts on fetch timeout via AbortSignal.timeout", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		// Mock fetch that respects the AbortSignal (like real fetch does)
		globalThis.fetch = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					if (init?.signal) {
						init.signal.addEventListener("abort", () => {
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							)
						})
					}
					// Never resolves — simulates a hanging network request
				})
			},
		) as unknown as typeof fetch

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		// Should fall back gracefully, not hang
		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
		// Verify AbortSignal.timeout was passed
		const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0]
		expect(fetchCall[1].signal).toBeDefined()
	}, 15_000)

	// --- Empty snippet filtering (H5) ---

	it("filters out results with empty/blank snippets before sending to API", async () => {
		const results = [
			makeResult({ snippet: "Alice works on ProjectX", score: 0.9, path: "a" }),
			makeResult({ snippet: "", score: 0.8, path: "b" }),
			makeResult({ snippet: "   ", score: 0.7, path: "c" }),
			makeResult({ snippet: "Bob manages TeamY", score: 0.6, path: "d" }),
		]
		const config = makeConfig()

		// Mock fetch to return reranked indices for non-empty docs only
		globalThis.fetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.95 },
			{ index: 1, relevance_score: 0.85 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(true)
		// Only 2 non-empty snippets should be sent to API
		const body = JSON.parse(
			(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
				.body as string,
		)
		expect(body.documents.length).toBe(2)
		expect(body.documents).toEqual([
			"Alice works on ProjectX",
			"Bob manages TeamY",
		])
		// Empty snippet results should be appended after reranked
		expect(out.results.length).toBe(4)
	})

	it("returns fallback when all non-empty snippets reduce to <= 1 candidate", async () => {
		const results = [
			makeResult({ snippet: "Only valid", score: 0.9, path: "a" }),
			makeResult({ snippet: "", score: 0.8, path: "b" }),
			makeResult({ snippet: "   ", score: 0.7, path: "c" }),
		]
		const config = makeConfig()

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
	})

	// --- Failure telemetry (M1) ---

	it("emits telemetry on failure in catch block", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"))

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		// Should emit telemetry on failure (changed from not emitting)
		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "rerank" },
				ok: false,
			}),
		)
	})

	// --- All below minScore ---

	it("returns input unchanged when all results are below minScore", async () => {
		const results = [
			makeResult({ snippet: "low1", score: 0.05, path: "a" }),
			makeResult({ snippet: "low2", score: 0.08, path: "b" }),
		]
		const config = makeConfig({ minScore: 0.1 })

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})
})
