import { describe, expect, it } from "vitest"
import {
	clampSearchMaxResults,
	MAX_SEARCH_MAX_RESULTS,
} from "./mongodb-manager.js"

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
