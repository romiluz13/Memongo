import { describe, expect, it } from "vitest"
import {
	clampSearchMaxResults,
	clampSearchQuery,
	MAX_SEARCH_MAX_RESULTS,
	MAX_SEARCH_QUERY_LENGTH,
} from "./mongodb-manager.js"
import { normalizeDetailedSearchRequest } from "./mongodb-search-ranking.js"

/**
 * P2.8 defense-in-depth: the manager clamps maxResults at every public
 * search entry point (search, searchDetailed via normalize, searchKB,
 * legacySearch fallback) so non-API callers cannot force unbounded result
 * sets through fusion/rerank. The route layer clamps too; this unit covers
 * the engine-side ceiling without needing a database.
 */
describe("clampSearchMaxResults (P2.8)", () => {
	it("clamps values above the ceiling to 100", () => {
		expect(MAX_SEARCH_MAX_RESULTS).toBe(100)
		expect(clampSearchMaxResults(9999)).toBe(100)
		expect(clampSearchMaxResults(101)).toBe(100)
	})

	it("passes in-range values through", () => {
		expect(clampSearchMaxResults(1)).toBe(1)
		expect(clampSearchMaxResults(25)).toBe(25)
		expect(clampSearchMaxResults(100)).toBe(100)
	})

	it("raises zero and negative values to the floor of 1", () => {
		expect(clampSearchMaxResults(0)).toBe(1)
		expect(clampSearchMaxResults(-5)).toBe(1)
	})

	it("floors fractional values before clamping", () => {
		expect(clampSearchMaxResults(25.9)).toBe(25)
	})

	it("maps non-finite input to the ceiling instead of NaN", () => {
		expect(clampSearchMaxResults(Number.NaN)).toBe(100)
		expect(clampSearchMaxResults(Number.POSITIVE_INFINITY)).toBe(100)
	})
})

/**
 * WS-16 (C-030): queries are clamped at every public search entry point
 * before the hot path consumes them — ahead of autoEmbed, BM25, the
 * query-cache probe, and rerank — so an over-length payload bounds every
 * downstream consumer. normalizeDetailedSearchRequest applies the clamp to
 * the trimmed query, the same defense-in-depth posture as
 * clampSearchMaxResults above.
 */
describe("clampSearchQuery (C-030)", () => {
	it("clamps at the 2,000-character ceiling", () => {
		expect(MAX_SEARCH_QUERY_LENGTH).toBe(2000)
		const long = "x".repeat(MAX_SEARCH_QUERY_LENGTH + 547)
		expect(clampSearchQuery(long)).toHaveLength(2000)
	})

	it("passes queries at or under the ceiling through unchanged", () => {
		expect(clampSearchQuery("")).toBe("")
		expect(clampSearchQuery("hello")).toBe("hello")
		expect(clampSearchQuery("y".repeat(MAX_SEARCH_QUERY_LENGTH))).toHaveLength(
			2000,
		)
	})

	it("keeps the first 2,000 characters (prefix, not suffix)", () => {
		const long = `${"a".repeat(MAX_SEARCH_QUERY_LENGTH)}TAIL`
		expect(clampSearchQuery(long)).toBe("a".repeat(MAX_SEARCH_QUERY_LENGTH))
	})

	it("normalizeDetailedSearchRequest clamps the trimmed query (C-030)", () => {
		const overLength = `${"  q".repeat(700)} `.repeat(1)
		// 2,100 chars before trim, 2,098 after trim — both over the ceiling.
		expect(overLength.trim().length).toBeGreaterThan(MAX_SEARCH_QUERY_LENGTH)
		const normalized = normalizeDetailedSearchRequest({
			query: overLength,
		})
		expect(normalized.query).toHaveLength(MAX_SEARCH_QUERY_LENGTH)
		expect(normalized.query.startsWith("  q  q")).toBe(false)
		// trim happens before the clamp, so the leading spaces are gone.
		expect(normalized.query.startsWith("q")).toBe(true)
	})

	it("normalizeDetailedSearchRequest passes normal queries through unchanged", () => {
		const normalized = normalizeDetailedSearchRequest({
			query: "  deploy helm chart  ",
			maxResults: 5,
		})
		expect(normalized.query).toBe("deploy helm chart")
		expect(normalized.maxResults).toBe(5)
	})
})
