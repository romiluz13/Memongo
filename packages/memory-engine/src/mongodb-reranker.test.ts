/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db } from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock telemetry before importing module under test
// ---------------------------------------------------------------------------

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))

import {
	crossEncoderRerank,
	MIN_RERANK_TIMEOUT_MS,
	resolveRerankTimeoutMs,
	RERANK_TIMEOUT_MS,
	type RerankConfig,
} from "./mongodb-reranker.js"
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
	beforeEach(() => {
		vi.clearAllMocks()
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
		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn: mockFetch,
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

	it("sends the full passage text to the reranker when present (B5)", async () => {
		const fullText1 = `${"assistant turn body ".repeat(80)}answer past char 700`
		const fullText2 = `${"second long turn ".repeat(80)}also past char 700`
		const results = [
			makeResult({
				snippet: fullText1.slice(0, 700),
				text: fullText1,
				score: 0.9,
				path: "path/0",
			}),
			makeResult({
				snippet: fullText2.slice(0, 700),
				text: fullText2,
				score: 0.8,
				path: "path/1",
			}),
			makeResult({ snippet: "preview only", score: 0.7, path: "path/2" }),
		]
		const config = makeConfig()
		const mockFetch = mockFetchSuccess([
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
			{ index: 2, relevance_score: 0.7 },
		])
		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn: mockFetch,
		})

		const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
		// Full text for results that carry it; snippet fallback otherwise.
		expect(body.documents).toEqual([fullText1, fullText2, "preview only"])
		expect(body.documents[0].length).toBeGreaterThan(700)
	})

	it("maps scores back onto correct results and re-sorts descending", async () => {
		const results = makeResults(3)
		const config = makeConfig()
		// Voyage returns reversed order: index 2 is highest
		const fetchFn = mockFetchSuccess([
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
			fetchFn,
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

	it("appends CE-below-minScore results at end (B7: minScore gates CE scores)", async () => {
		const results = [
			makeResult({ snippet: "high1", score: 0.5, path: "a" }),
			makeResult({ snippet: "high2", score: 0.4, path: "b" }),
			makeResult({ snippet: "low1", score: 0.05, path: "c" }),
		]
		const config = makeConfig({ minScore: 0.1 })

		// B7: every result is a candidate by rank; the CE scores one of them
		// under minScore, which lands it in the below partition instead of
		// being excluded from the rerank input.
		const fetchFn = mockFetchSuccess([
			{ index: 0, relevance_score: 0.6 },
			{ index: 1, relevance_score: 0.8 },
			{ index: 2, relevance_score: 0.02 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
		})

		expect(out.reranked).toBe(true)
		expect(out.results.length).toBe(3)
		// CE-above-minScore head, sorted by CE score descending.
		expect(out.results[0].snippet).toBe("high2") // 0.8 from reranker
		expect(out.results[1].snippet).toBe("high1") // 0.6 from reranker
		expect(out.results[2].snippet).toBe("low1") // CE 0.02, appended last
		if (!out.reranked) {
			throw new Error("expected reranked: true")
		}
		expect(out.partitions.reranked.map((r) => r.path)).toEqual(["b", "a"])
		expect(out.partitions.below.map((r) => r.path)).toEqual(["c"])
		expect(out.partitions.below.map((r) => r.score)).toEqual([0.02])
	})

	it("returns partition metadata and keeps CE-ranked results ahead of untouched overflow (RET-08)", async () => {
		// Audit proof: CE-scored .2/.1 followed by untouched overflow with
		// higher original scores — the CE decision must survive instead of
		// being displaced by retrieval scores that were never CE-calibrated.
		const results = [
			makeResult({ snippet: "candidate 1", score: 0.9, path: "a" }),
			makeResult({ snippet: "candidate 2", score: 0.85, path: "b" }),
			makeResult({ snippet: "overflow 1", score: 0.8, path: "c" }),
			makeResult({ snippet: "overflow 2", score: 0.75, path: "d" }),
		]
		const config = makeConfig({ topN: 2 })

		const fetchFn = mockFetchSuccess([
			{ index: 0, relevance_score: 0.2 },
			{ index: 1, relevance_score: 0.1 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
		})

		if (!out.reranked) {
			throw new Error("expected reranked: true")
		}
		// Only the topN candidates went to the provider.
		const body = JSON.parse(vi.mocked(fetchFn).mock.calls[0][1].body as string)
		expect(body.documents).toEqual(["candidate 1", "candidate 2"])
		// Partition metadata carries the authoritative split (RET-08).
		expect(out.partitions.reranked.map((r) => r.path)).toEqual(["a", "b"])
		expect(out.partitions.reranked.map((r) => r.score)).toEqual([0.2, 0.1])
		expect(out.partitions.overflow.map((r) => r.path)).toEqual(["c", "d"])
		expect(out.partitions.emptySnippet).toEqual([])
		expect(out.partitions.below).toEqual([])
		// Flat results keep the CE-scored partition first — overflow .8/.75
		// does not displace CE-ranked .2/.1.
		expect(out.results.map((r) => r.path)).toEqual(["a", "b", "c", "d"])
	})

	it("slices candidates to topN", async () => {
		const results = makeResults(5)
		const config = makeConfig({ topN: 3 })

		const fetchFn = mockFetchSuccess([
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
			fetchFn,
		})

		expect(out.reranked).toBe(true)
		// B7: rank-based candidate selection — the first topN results by
		// input rank go to the provider; the rest become overflow.
		const body = JSON.parse(vi.mocked(fetchFn).mock.calls[0][1].body as string)
		expect(body.documents.length).toBe(3)
	})

	it("clamps relevance_score to [0,1]", async () => {
		const results = makeResults(2)
		const config = makeConfig()

		const fetchFn = mockFetchSuccess([
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
			fetchFn,
		})

		expect(out.reranked).toBe(true)
		expect(out.results[0].score).toBe(1) // clamped from 1.5
		expect(out.results[1].score).toBe(0) // clamped from -0.3
	})

	it("uses correct model from config", async () => {
		const results = makeResults(2)
		const config = makeConfig({ model: "rerank-2.5-lite" })

		const fetchFn = mockFetchSuccess([
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
			fetchFn,
		})

		const body = JSON.parse(vi.mocked(fetchFn).mock.calls[0][1].body as string)
		expect(body.model).toBe("rerank-2.5-lite")
	})

	it("prepends instruction to query when config.instruction is set", async () => {
		const results = makeResults(2)
		const config = makeConfig({
			instruction:
				"This is agent conversation memory. Prioritize recent results.",
		})

		const fetchFn = mockFetchSuccess([
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
			fetchFn,
		})

		const body = JSON.parse(vi.mocked(fetchFn).mock.calls[0][1].body as string)
		expect(body.query).toBe(
			`This is agent conversation memory. Prioritize recent results.\n${QUERY}`,
		)
	})

	// --- Error handling (fallback to input) ---

	it("falls back on API error (non-OK status)", async () => {
		const results = makeResults(3)
		const config = makeConfig()
		const providerOutcomes: Array<"attempted" | "succeeded" | "failed"> = []

		const fetchFn = vi.fn().mockResolvedValue({
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
			onProviderCall: (outcome) => providerOutcomes.push(outcome),
			fetchFn,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
		expect(providerOutcomes).toEqual(["attempted", "failed"])
	})

	it("disables automatic redirects on reranker requests", async () => {
		const results = makeResults(3)
		const config = makeConfig()
		const fetchFn = vi.fn().mockResolvedValue({
			ok: false,
			status: 302,
		})

		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
		})

		expect(vi.mocked(fetchFn).mock.calls[0]?.[1]).toMatchObject({
			redirect: "manual",
		})
	})

	it("falls back on network error", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		const fetchFn = vi.fn().mockRejectedValue(new Error("network timeout"))

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	it("falls back on JSON parse error", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		const fetchFn = vi.fn().mockResolvedValue({
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
			fetchFn,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	it("falls back on unexpected response shape (no data field)", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		const fetchFn = vi.fn().mockResolvedValue({
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
			fetchFn,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
	})

	// --- Telemetry ---

	it("emits rerank telemetry on success", async () => {
		const results = makeResults(3)
		const config = makeConfig()

		const fetchFn = mockFetchSuccess([
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
			fetchFn,
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

		const fetchFn = vi.fn().mockRejectedValue(new Error("network down"))

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
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
		const fetchFn = vi.fn(
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
			fetchFn,
		})

		// Should fall back gracefully, not hang
		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
		// Verify AbortSignal.timeout was passed
		const fetchCall = vi.mocked(fetchFn).mock.calls[0]
		expect(fetchCall[1]?.signal).toBeDefined()
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
		const fetchFn = mockFetchSuccess([
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
			fetchFn,
		})

		expect(out.reranked).toBe(true)
		// Only 2 non-empty snippets should be sent to API
		const body = JSON.parse(vi.mocked(fetchFn).mock.calls[0][1].body as string)
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

		const fetchFn = vi.fn().mockRejectedValue(new Error("network error"))

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
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

	it("reranks by rank even when every pre-rerank score is below minScore (B7)", async () => {
		const results = [
			makeResult({ snippet: "low1", score: 0.05, path: "a" }),
			makeResult({ snippet: "low2", score: 0.08, path: "b" }),
		]
		const config = makeConfig({ minScore: 0.1 })

		const fetchFn = mockFetchSuccess([
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.7 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
		})

		// B7: candidates are chosen by rank, so low FIRST-STAGE scores no
		// longer skip the reranker — the CE scores carry the ranking now.
		expect(out.reranked).toBe(true)
		expect(fetchFn).toHaveBeenCalledOnce()
		const body = JSON.parse(vi.mocked(fetchFn).mock.calls[0][1].body as string)
		expect(body.documents).toEqual(["low1", "low2"])
		expect(out.results.map((r) => r.path)).toEqual(["a", "b"])
		expect(out.results.map((r) => r.score)).toEqual([0.9, 0.7])
	})
})

// --- WS-12 (C-019): skip paths are telemetry-visible, not silent ---

describe("crossEncoderRerank skip telemetry (WS-12, C-019)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("emits ok:true with rerankSkipped:'disabled' when the reranker is off", async () => {
		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: makeResults(3),
			config: makeConfig({ enabled: false }),
		})

		expect(out.reranked).toBe(false)
		expect(emitTelemetry).toHaveBeenCalledOnce()
		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({
				ok: true,
				rerankSkipped: "disabled",
			}),
		)
	})

	it("emits ok:true with rerankSkipped:'no-results' when there is nothing to rank", async () => {
		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: [],
			config: makeConfig(),
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({ ok: true, rerankSkipped: "no-results" }),
		)
	})

	it("emits ok:true with rerankSkipped:'no-api-key' when the key is missing", async () => {
		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: makeResults(3),
			config: makeConfig({ voyageApiKey: "" }),
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({ ok: true, rerankSkipped: "no-api-key" }),
		)
	})

	it("emits ok:true with rerankSkipped:'too-few-candidates' for a single candidate", async () => {
		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: [makeResult({ snippet: "only one", score: 0.8 })],
			config: makeConfig(),
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({
				ok: true,
				rerankSkipped: "too-few-candidates",
			}),
		)
	})

	it("emits ok:false with rerankSkipped:'api-error' on a non-OK provider response", async () => {
		const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 429 })

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: makeResults(3),
			config: makeConfig(),
			fetchFn,
		})

		expect(out.reranked).toBe(false)
		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({ ok: false, rerankSkipped: "api-error" }),
		)
	})

	it("emits ok:false with rerankSkipped:'bad-response-shape' on a malformed provider body", async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ results: [] }),
		})

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: makeResults(3),
			config: makeConfig(),
			fetchFn,
		})

		expect(out.reranked).toBe(false)
		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({
				ok: false,
				rerankSkipped: "bad-response-shape",
			}),
		)
	})

	it("emits no rerankSkipped marker when the rerank actually ran (skip vs ran distinguishable)", async () => {
		const fetchFn = mockFetchSuccess([
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
			{ index: 2, relevance_score: 0.7 },
		])

		await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: makeResults(3),
			config: makeConfig(),
			fetchFn,
		})

		const doc = vi.mocked(emitTelemetry).mock.calls[0]?.[2] ?? {}
		expect("rerankSkipped" in doc).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// WS-16 (C-031): the rerank timeout derives from the remaining latency
// budget so one provider call can never stack its full 2s cap on top of an
// already-consumed tail (probe-miss + slow-lane worst cases).
// ---------------------------------------------------------------------------

describe("resolveRerankTimeoutMs (C-031)", () => {
	it("falls back to the fixed 2s cap when no budget is provided", () => {
		expect(resolveRerankTimeoutMs()).toBe(RERANK_TIMEOUT_MS)
		expect(resolveRerankTimeoutMs(undefined)).toBe(RERANK_TIMEOUT_MS)
	})

	it("uses the remaining budget when it is below the cap", () => {
		expect(resolveRerankTimeoutMs(1_000)).toBe(1_000)
		expect(resolveRerankTimeoutMs(400)).toBe(400)
		expect(resolveRerankTimeoutMs(MIN_RERANK_TIMEOUT_MS)).toBe(
			MIN_RERANK_TIMEOUT_MS,
		)
	})

	it("caps at 2s no matter how much budget remains", () => {
		expect(resolveRerankTimeoutMs(5_000)).toBe(RERANK_TIMEOUT_MS)
		expect(resolveRerankTimeoutMs(13_500)).toBe(RERANK_TIMEOUT_MS)
	})

	it("refuses to start a call below the floor (null = skip)", () => {
		expect(resolveRerankTimeoutMs(MIN_RERANK_TIMEOUT_MS - 1)).toBeNull()
		expect(resolveRerankTimeoutMs(0)).toBeNull()
		expect(resolveRerankTimeoutMs(-500)).toBeNull()
		expect(resolveRerankTimeoutMs(Number.NaN)).toBeNull()
		expect(resolveRerankTimeoutMs(Number.POSITIVE_INFINITY)).toBeNull()
	})
})

describe("crossEncoderRerank remaining latency budget (C-031)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("skips the provider call when the remaining budget is below the floor", async () => {
		const results = makeResults(3)
		const fetchFn = vi.fn()

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config: makeConfig(),
			fetchFn,
			remainingBudgetMs: MIN_RERANK_TIMEOUT_MS - 1,
		})

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
		// No provider round-trip is started at all.
		expect(fetchFn).not.toHaveBeenCalled()
		// A deliberate skip, not a failure: ok:true + budget-exhausted marker.
		expect(emitTelemetry).toHaveBeenCalledWith(
			DB,
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "rerank" },
				ok: true,
				rerankSkipped: "budget-exhausted",
			}),
		)
	})

	it("aborts a hanging provider call within the derived timeout, not the 2s cap", async () => {
		const results = makeResults(3)

		// Hanging fetch that respects the AbortSignal, like real fetch.
		const fetchFn = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					if (init?.signal) {
						init.signal.addEventListener("abort", () => {
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							)
						})
					}
				})
			},
		) as unknown as typeof fetch

		const startedAt = Date.now()
		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config: makeConfig(),
			fetchFn,
			remainingBudgetMs: 300,
		})
		const elapsedMs = Date.now() - startedAt

		expect(out.reranked).toBe(false)
		expect(out.results).toBe(results)
		// The call aborted near the 300ms derived timeout — well under the
		// 2s cap this provider call would otherwise be allowed to spend.
		expect(elapsedMs).toBeGreaterThanOrEqual(250)
		expect(elapsedMs).toBeLessThan(1_500)
	}, 10_000)

	it("still reranks successfully when the remaining budget is ample", async () => {
		const fetchFn = mockFetchSuccess([
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
			{ index: 2, relevance_score: 0.7 },
		])

		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results: makeResults(3),
			config: makeConfig(),
			fetchFn,
			remainingBudgetMs: 10_000,
		})

		expect(out.reranked).toBe(true)
		expect(fetchFn).toHaveBeenCalledOnce()
	})
})

describe("original-admission rerank telemetry", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubEnv("MEMONGO_RERANK_STRICT", "0")
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "0")
	})
	afterEach(() => vi.unstubAllEnvs())

	it.each([
		"disabled",
		"too-few-candidates",
		"too-few-valid-candidates",
		"budget-exhausted",
		"api-error",
		"bad-response-shape",
		"success",
		"exception",
	])("keeps %s behavior when original telemetry rejects", async (branch) => {
		const admission = {
			kind: "admission",
			agentId: AGENT_ID,
			epoch: 19,
		} as const
		const results = makeResults(branch === "too-few-candidates" ? 1 : 3)
		if (branch === "too-few-valid-candidates")
			for (const result of results) result.snippet = " "
		const config = makeConfig({ enabled: branch !== "disabled" })
		const fetchFn =
			branch === "api-error"
				? vi.fn().mockResolvedValue({ ok: false, status: 503 })
				: branch === "bad-response-shape"
					? vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
					: branch === "exception"
						? vi.fn().mockRejectedValue(new Error("provider fixture"))
						: mockFetchSuccess([
								{ index: 2, relevance_score: 0.99 },
								{ index: 1, relevance_score: 0.8 },
								{ index: 0, relevance_score: 0.7 },
							])
		vi.mocked(emitTelemetry).mockRejectedValueOnce(
			new Error("telemetry fixture"),
		)
		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config,
			fetchFn,
			admission,
			remainingBudgetMs: branch === "budget-exhausted" ? 0 : undefined,
		})
		expect(emitTelemetry).toHaveBeenCalledExactlyOnceWith(
			DB,
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "rerank" },
			}),
			{ admission },
		)
		const doc = vi.mocked(emitTelemetry).mock.calls[0]?.[2]
		if (branch === "success" || branch === "exception")
			expect(doc).not.toHaveProperty("rerankSkipped")
		else expect(doc?.rerankSkipped).toBe(branch)
		expect(out.reranked).toBe(branch === "success")
		if (branch === "success")
			expect(out.results.map((result) => result.path)).toEqual([
				"path/2",
				"path/1",
				"path/0",
			])
		else expect(out.results).toBe(results)
		if (
			[
				"disabled",
				"too-few-candidates",
				"too-few-valid-candidates",
				"budget-exhausted",
			].includes(branch)
		)
			expect(fetchFn).not.toHaveBeenCalled()
		else expect(fetchFn).toHaveBeenCalledOnce()
	})

	it("rethrows the original strict provider error despite rejected telemetry", async () => {
		vi.stubEnv("MEMONGO_RERANK_STRICT", "1")
		const error = new Error("original provider fixture")
		const admission = {
			kind: "admission",
			agentId: AGENT_ID,
			epoch: 19,
		} as const
		vi.mocked(emitTelemetry).mockRejectedValueOnce(
			new Error("telemetry fixture"),
		)
		await expect(
			crossEncoderRerank({
				db: DB,
				prefix: PREFIX,
				agentId: AGENT_ID,
				query: QUERY,
				results: makeResults(3),
				config: makeConfig(),
				admission,
				fetchFn: vi.fn().mockRejectedValue(error),
			}),
		).rejects.toBe(error)
		expect(emitTelemetry).toHaveBeenCalledWith(DB, PREFIX, expect.any(Object), {
			admission,
		})
	})

	it("returns without waiting for telemetry completion", async () => {
		const admission = {
			kind: "admission",
			agentId: AGENT_ID,
			epoch: 19,
		} as const
		vi.mocked(emitTelemetry).mockImplementationOnce(
			() => new Promise<void>(() => {}),
		)
		const results = makeResults(3)
		const out = await crossEncoderRerank({
			db: DB,
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: QUERY,
			results,
			config: makeConfig({ enabled: false }),
			admission,
		})
		expect(out.results).toBe(results)
	}, 1_000)
})
