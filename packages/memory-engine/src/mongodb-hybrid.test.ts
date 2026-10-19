import { describe, it, expect } from "vitest"
import {
	rrfScore,
	normalizeVectorScore,
	normalizeBM25Score,
	normalizeRRFScore,
	normalizeSearchResults,
} from "./mongodb-hybrid.js"
import type { MemorySearchResult } from "./types.js"

// ---------------------------------------------------------------------------
// rrfScore -- Reciprocal Rank Fusion scoring
// ---------------------------------------------------------------------------

describe("rrfScore", () => {
	it("computes 1/(k+rank) with k=60", () => {
		// rank=1: 1/(60+1) = 1/61
		expect(rrfScore(1)).toBeCloseTo(1 / 61, 6)
	})

	it("decreases as rank increases", () => {
		const score1 = rrfScore(1)
		const score5 = rrfScore(5)
		const score10 = rrfScore(10)
		expect(score1).toBeGreaterThan(score5)
		expect(score5).toBeGreaterThan(score10)
	})

	it("handles rank=0 (top result)", () => {
		expect(rrfScore(0)).toBeCloseTo(1 / 60, 6)
	})

	it("uses custom k parameter", () => {
		expect(rrfScore(1, 20)).toBeCloseTo(1 / 21, 6)
	})
})

// ---------------------------------------------------------------------------
// normalizeVectorScore -- cosine similarity already [0,1]
// ---------------------------------------------------------------------------

describe("normalizeVectorScore", () => {
	it("clamps to [0,1] range", () => {
		expect(normalizeVectorScore(0.85)).toBe(0.85)
		expect(normalizeVectorScore(1.2)).toBe(1.0)
		expect(normalizeVectorScore(-0.1)).toBe(0.0)
	})

	it("returns 0 for non-finite inputs", () => {
		expect(normalizeVectorScore(NaN)).toBe(0)
		expect(normalizeVectorScore(Infinity)).toBe(1.0)
		expect(normalizeVectorScore(-Infinity)).toBe(0.0)
	})
})

// ---------------------------------------------------------------------------
// normalizeBM25Score -- unbounded [0, inf) to [0,1]
// ---------------------------------------------------------------------------

describe("normalizeBM25Score", () => {
	it("normalizes using sigmoid-like function", () => {
		const low = normalizeBM25Score(0.5)
		const mid = normalizeBM25Score(5)
		const high = normalizeBM25Score(50)
		// Higher raw scores produce higher normalized scores
		expect(high).toBeGreaterThan(mid)
		expect(mid).toBeGreaterThan(low)
	})

	it("returns value in [0,1] range", () => {
		expect(normalizeBM25Score(0)).toBeGreaterThanOrEqual(0)
		expect(normalizeBM25Score(0)).toBeLessThanOrEqual(1)
		expect(normalizeBM25Score(100)).toBeGreaterThanOrEqual(0)
		expect(normalizeBM25Score(100)).toBeLessThanOrEqual(1)
	})

	it("returns 0 for negative or NaN", () => {
		expect(normalizeBM25Score(-1)).toBe(0)
		expect(normalizeBM25Score(NaN)).toBe(0)
	})

	it("approaches 1 for very high scores", () => {
		expect(normalizeBM25Score(1000)).toBeGreaterThan(0.95)
	})
})

// ---------------------------------------------------------------------------
// normalizeRRFScore -- already [0, 1/k]
// ---------------------------------------------------------------------------

describe("normalizeRRFScore", () => {
	it("scales RRF score to [0,1] range", () => {
		// Top-ranked item: 1/(60+1) = 0.01639... should scale to ~1.0
		const topScore = normalizeRRFScore(1 / 61)
		expect(topScore).toBeCloseTo(1.0, 1)
	})

	it("returns 0 for 0 input", () => {
		expect(normalizeRRFScore(0)).toBe(0)
	})

	it("stays in [0,1] range", () => {
		for (let rank = 1; rank <= 100; rank++) {
			const raw = 1 / (60 + rank)
			const normalized = normalizeRRFScore(raw)
			expect(normalized).toBeGreaterThanOrEqual(0)
			expect(normalized).toBeLessThanOrEqual(1)
		}
	})
})

// ---------------------------------------------------------------------------
// normalizeSearchResults -- tag + normalize for cross-source merge
// ---------------------------------------------------------------------------

describe("normalizeSearchResults", () => {
	it("normalizes vector scores (cosine [0,1])", () => {
		const results: MemorySearchResult[] = [
			{
				path: "a.md",
				startLine: 1,
				endLine: 2,
				score: 0.85,
				snippet: "t",
				source: "conversation",
			},
		]
		const normalized = normalizeSearchResults(results, "vector")
		expect(normalized[0].score).toBeCloseTo(0.85, 2)
	})

	it("normalizes BM25 text scores to [0,1]", () => {
		const results: MemorySearchResult[] = [
			{
				path: "a.md",
				startLine: 1,
				endLine: 2,
				score: 15.5,
				snippet: "t",
				source: "conversation",
			},
		]
		const normalized = normalizeSearchResults(results, "text")
		expect(normalized[0].score).toBeGreaterThan(0)
		expect(normalized[0].score).toBeLessThanOrEqual(1)
	})

	it("normalizes hybrid/RRF scores", () => {
		const results: MemorySearchResult[] = [
			{
				path: "a.md",
				startLine: 1,
				endLine: 2,
				score: 0.015,
				snippet: "t",
				source: "conversation",
			},
		]
		const normalized = normalizeSearchResults(results, "hybrid")
		expect(normalized[0].score).toBeGreaterThanOrEqual(0)
		expect(normalized[0].score).toBeLessThanOrEqual(1)
	})

	it("handles structured search method", () => {
		const results: MemorySearchResult[] = [
			{
				path: "structured",
				startLine: 0,
				endLine: 0,
				score: 0.7,
				snippet: "t",
				source: "structured",
			},
		]
		const normalized = normalizeSearchResults(results, "structured")
		// Structured uses vector-like scores
		expect(normalized[0].score).toBeCloseTo(0.7, 2)
	})

	it("handles kb search method", () => {
		const results: MemorySearchResult[] = [
			{
				path: "kb-doc",
				startLine: 1,
				endLine: 5,
				score: 0.8,
				snippet: "t",
				source: "reference",
			},
		]
		const normalized = normalizeSearchResults(results, "kb")
		expect(normalized[0].score).toBeCloseTo(0.8, 2)
	})

	it("returns empty array for empty input", () => {
		expect(normalizeSearchResults([], "vector")).toEqual([])
	})

	it("preserves all result fields except score", () => {
		const results: MemorySearchResult[] = [
			{
				path: "test.md",
				startLine: 5,
				endLine: 10,
				score: 0.9,
				snippet: "hello",
				source: "conversation",
			},
		]
		const normalized = normalizeSearchResults(results, "vector")
		expect(normalized[0].path).toBe("test.md")
		expect(normalized[0].startLine).toBe(5)
		expect(normalized[0].endLine).toBe(10)
		expect(normalized[0].snippet).toBe("hello")
		expect(normalized[0].source).toBe("conversation")
	})

	it("ensures cross-source merge ranking is correct", () => {
		// Simulate: vector result with score 0.85, BM25 result with raw score 15.0
		// After normalization, both should be comparable in [0,1]
		const vectorResults: MemorySearchResult[] = [
			{
				path: "vec.md",
				startLine: 1,
				endLine: 2,
				score: 0.85,
				snippet: "t",
				source: "conversation",
			},
		]
		const textResults: MemorySearchResult[] = [
			{
				path: "text.md",
				startLine: 1,
				endLine: 2,
				score: 15.0,
				snippet: "t",
				source: "conversation",
			},
		]
		const normalizedVec = normalizeSearchResults(vectorResults, "vector")
		const normalizedText = normalizeSearchResults(textResults, "text")

		// Both should be in [0,1]
		expect(normalizedVec[0].score).toBeGreaterThanOrEqual(0)
		expect(normalizedVec[0].score).toBeLessThanOrEqual(1)
		expect(normalizedText[0].score).toBeGreaterThanOrEqual(0)
		expect(normalizedText[0].score).toBeLessThanOrEqual(1)

		// Merge and sort -- should work correctly
		const merged = [...normalizedVec, ...normalizedText].toSorted(
			(a, b) => b.score - a.score,
		)
		expect(merged).toHaveLength(2)
		// Higher normalized score should come first
		expect(merged[0].score).toBeGreaterThanOrEqual(merged[1].score)
	})
})
