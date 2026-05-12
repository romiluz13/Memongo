/**
 * Tests for LLM-powered query decomposition.
 *
 * Verifies prompt construction, sub-query parsing, result merging with RRF,
 * and mode resolution for the query-time counterpart to document-time enrichment.
 */

import { describe, expect, test, vi } from "vitest"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"

// Will import from the module under test once created
import {
	decomposeQuery,
	resolveDecompositionMode,
	mergeMultiQueryResults,
	type DecompositionMode,
} from "./mongodb-query-decomposition.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(responseContent: string): EnrichmentProvider {
	return {
		name: "mock",
		chatCompletion: vi.fn().mockResolvedValue({ content: responseContent }),
	}
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

describe("resolveDecompositionMode", () => {
	test("returns none for undefined", () => {
		expect(resolveDecompositionMode(undefined)).toBe("none")
	})

	test("returns enabled for 'enabled'", () => {
		expect(resolveDecompositionMode("enabled")).toBe("enabled")
	})

	test("returns none for unrecognized values", () => {
		expect(resolveDecompositionMode("foo")).toBe("none")
	})

	test("trims and lowercases", () => {
		expect(resolveDecompositionMode("  Enabled  ")).toBe("enabled")
	})
})

// ---------------------------------------------------------------------------
// decomposeQuery — prompt construction
// ---------------------------------------------------------------------------

describe("decomposeQuery", () => {
	test("sends system prompt with decomposition instructions", async () => {
		const provider = mockProvider(
			JSON.stringify({ sub_queries: ["What does the user grow?"] }),
		)

		await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "suggest dinner with homegrown ingredients",
		})

		const call = vi.mocked(provider.chatCompletion).mock.calls[0][0]
		expect(call.messages[0].role).toBe("system")
		expect(call.messages[0].content).toContain("sub-queries")
		expect(call.messages[1].role).toBe("user")
		expect(call.messages[1].content).toContain(
			"suggest dinner with homegrown ingredients",
		)
		expect(call.responseFormat).toEqual({ type: "json_object" })
	})

	test("includes questionType hint when provided", async () => {
		const provider = mockProvider(JSON.stringify({ sub_queries: ["q1"] }))

		await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "test query",
			questionType: "single-session-preference",
		})

		const call = vi.mocked(provider.chatCompletion).mock.calls[0][0]
		expect(call.messages[1].content).toContain("single-session-preference")
	})

	test("returns parsed sub-queries and original", async () => {
		const provider = mockProvider(
			JSON.stringify({
				sub_queries: [
					"What does the user grow in their garden?",
					"What cooking ingredients does the user have?",
				],
			}),
		)

		const result = await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "suggest dinner with homegrown ingredients",
		})

		expect(result.original).toBe("suggest dinner with homegrown ingredients")
		expect(result.subQueries).toHaveLength(2)
		expect(result.subQueries[0]).toBe(
			"What does the user grow in their garden?",
		)
	})

	test("returns original as sole sub-query on empty response", async () => {
		const provider = mockProvider(JSON.stringify({ sub_queries: [] }))

		const result = await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "test",
		})

		expect(result.subQueries).toEqual(["test"])
	})

	test("returns original as sole sub-query on malformed JSON", async () => {
		const provider = mockProvider("not valid json {{{")

		const result = await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "test",
		})

		expect(result.subQueries).toEqual(["test"])
	})

	test("strips markdown fences before parsing", async () => {
		const provider = mockProvider('```json\n{"sub_queries": ["q1", "q2"]}\n```')

		const result = await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "test",
		})

		expect(result.subQueries).toHaveLength(2)
	})

	test("filters out non-string sub-queries", async () => {
		const provider = mockProvider(
			JSON.stringify({ sub_queries: ["valid", 42, null, "also valid"] }),
		)

		const result = await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "test",
		})

		expect(result.subQueries).toEqual(["valid", "also valid"])
	})

	test("caps sub-queries at 4", async () => {
		const provider = mockProvider(
			JSON.stringify({
				sub_queries: ["q1", "q2", "q3", "q4", "q5", "q6"],
			}),
		)

		const result = await decomposeQuery({
			provider,
			model: "gpt-4o-mini",
			query: "test",
		})

		expect(result.subQueries).toHaveLength(4)
	})
})

// ---------------------------------------------------------------------------
// mergeMultiQueryResults — RRF merge
// ---------------------------------------------------------------------------

describe("mergeMultiQueryResults", () => {
	test("merges results from multiple queries using RRF", () => {
		const resultSets = [
			[
				{ path: "doc-a", score: 0.9, snippet: "a" },
				{ path: "doc-b", score: 0.8, snippet: "b" },
			],
			[
				{ path: "doc-b", score: 0.95, snippet: "b" },
				{ path: "doc-c", score: 0.7, snippet: "c" },
			],
		]

		const merged = mergeMultiQueryResults(resultSets, 5)

		// doc-b appears in both lists → highest RRF score
		expect(merged[0].path).toBe("doc-b")
		expect(merged.length).toBeLessThanOrEqual(5)
	})

	test("deduplicates by path keeping highest score", () => {
		const resultSets = [
			[{ path: "doc-x", score: 0.5, snippet: "x1" }],
			[{ path: "doc-x", score: 0.9, snippet: "x2" }],
		]

		const merged = mergeMultiQueryResults(resultSets, 10)

		expect(merged.filter((r) => r.path === "doc-x")).toHaveLength(1)
	})

	test("does not collapse distinct chunk results with empty paths", () => {
		const resultSets = [
			[
				{
					path: "",
					canonicalId: "userfact-chunk/session-a",
					score: 0.9,
					snippet: "visited the science museum with a friend",
				},
			],
			[
				{
					path: "",
					canonicalId: "qa-chunk/session-b",
					score: 0.8,
					snippet: "planning a trip to the british museum",
				},
			],
		]

		const merged = mergeMultiQueryResults(resultSets, 10)

		expect(merged.map((result) => result.canonicalId)).toEqual([
			"userfact-chunk/session-a",
			"qa-chunk/session-b",
		])
	})

	test("returns empty array for empty input", () => {
		expect(mergeMultiQueryResults([], 5)).toEqual([])
	})

	test("Task 2.R4: RRF constant parity — sole-list rank-1 score equals 1/(60+1)", () => {
		// `$rankFusion` uses sum(weight * (1 / (60 + rank))); manual RRF at
		// mongodb-hybrid.ts must match constant 60 so multi-query merges stay
		// commensurate with the server-side `$rankFusion` baseline. With a
		// single result at rank 1, the merged score must equal 1/(60+1).
		const resultSets = [[{ path: "doc-only", score: 0.99, snippet: "only" }]]
		const merged = mergeMultiQueryResults(resultSets, 1)
		expect(merged).toHaveLength(1)
		const expected = 1 / (60 + 1)
		// merged scores are the RRF sum; a single list at rank 1 = 1/61.
		expect(merged[0].score).toBeCloseTo(expected, 10)
	})

	test("respects topK limit", () => {
		const resultSets = [
			[
				{ path: "a", score: 0.9, snippet: "a" },
				{ path: "b", score: 0.8, snippet: "b" },
				{ path: "c", score: 0.7, snippet: "c" },
			],
		]

		const merged = mergeMultiQueryResults(resultSets, 2)

		expect(merged).toHaveLength(2)
	})

	test("preserves temporal timeline bundles across decomposed-query fusion", () => {
		const resultSets = [
			[
				{
					path: "temporal-coverage/a",
					score: 8,
					snippet: "timeline",
					sourceEventIds: ["evt-1", "evt-2"],
					provenance: {
						temporalTimeline: true,
						sessionIds: ["session-a"],
					},
				},
				{ path: "procedure-a", score: 0.8, snippet: "procedure a" },
			],
			[
				{
					path: "temporal-coverage/b",
					score: 9,
					snippet: "timeline from another sub-query",
					sourceEventIds: ["evt-3"],
					provenance: {
						temporalTimeline: true,
						sessionIds: ["session-b"],
					},
				},
				{ path: "procedure-a", score: 0.95, snippet: "procedure a" },
				{ path: "procedure-b", score: 0.7, snippet: "procedure b" },
			],
			[
				{ path: "procedure-a", score: 0.96, snippet: "procedure a" },
				{ path: "procedure-c", score: 0.7, snippet: "procedure c" },
			],
		]

		const merged = mergeMultiQueryResults(resultSets, 5)

		expect(merged[0].path).toBe("temporal-coverage/b")
		expect(merged[0].sourceEventIds).toEqual(["evt-3", "evt-1", "evt-2"])
		expect(merged[0].provenance).toEqual({
			temporalTimeline: true,
			sessionIds: ["session-b", "session-a"],
		})
		expect(merged[1].path).toBe("procedure-a")
	})
})
