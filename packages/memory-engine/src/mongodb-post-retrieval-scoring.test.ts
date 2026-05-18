import { describe, it, expect } from "vitest"
import {
	keywordOverlapBoost,
	temporalProximityBoost,
	entityNameBoost,
	quotedPhraseBoost,
	applyPostRetrievalScoring,
} from "./mongodb-post-retrieval-scoring.js"
import type { MemorySearchResult } from "./types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResult(
	overrides: Partial<MemorySearchResult> & { score: number },
): MemorySearchResult {
	return {
		path: overrides.path ?? "chunks/test",
		startLine: 0,
		endLine: 0,
		score: overrides.score,
		snippet: overrides.snippet ?? "",
		source: overrides.source ?? "conversation",
		timestamp: overrides.timestamp,
	}
}

// ---------------------------------------------------------------------------
// keywordOverlapBoost
// ---------------------------------------------------------------------------

describe("keywordOverlapBoost", () => {
	it("boosts score when query keywords appear in snippet", () => {
		const boosted = keywordOverlapBoost(
			"favorite restaurant in Tokyo",
			"I love that sushi restaurant in Tokyo near the station",
			0.5,
		)
		// "restaurant" and "Tokyo" are non-stop-words that match; "favorite" does not appear
		expect(boosted).toBeGreaterThan(0.5)
	})

	it("returns original score when no keywords match", () => {
		const boosted = keywordOverlapBoost(
			"favorite restaurant in Tokyo",
			"The weather is nice today and I went swimming",
			0.5,
		)
		expect(boosted).toBe(0.5)
	})

	it("returns original score for empty query", () => {
		expect(keywordOverlapBoost("", "some snippet text", 0.5)).toBe(0.5)
	})

	it("returns original score for empty snippet", () => {
		expect(keywordOverlapBoost("favorite restaurant", "", 0.5)).toBe(0.5)
	})

	it("uses custom weight", () => {
		const defaultBoosted = keywordOverlapBoost(
			"Tokyo restaurant",
			"Great restaurant in Tokyo",
			0.5,
		)
		const highWeight = keywordOverlapBoost(
			"Tokyo restaurant",
			"Great restaurant in Tokyo",
			0.5,
			0.6,
		)
		expect(highWeight).toBeGreaterThan(defaultBoosted)
	})

	it("is case-insensitive", () => {
		const boosted = keywordOverlapBoost(
			"TOKYO restaurant",
			"great restaurant in tokyo",
			0.5,
		)
		expect(boosted).toBeGreaterThan(0.5)
	})

	it("bridges general product-domain terms without exact word overlap", () => {
		const boosted = keywordOverlapBoost(
			"photography accessories for my current setup",
			"I use a Sony camera with a Godox flash, padded cases, lens cleaning gear, and spare battery packs.",
			0.5,
		)

		expect(boosted).toBeGreaterThan(0.5)
	})
})

// ---------------------------------------------------------------------------
// temporalProximityBoost
// ---------------------------------------------------------------------------

describe("temporalProximityBoost", () => {
	it("boosts result close in time to parsed question date hint", () => {
		const questionDate = new Date("2024-03-15T00:00:00Z")
		// Result from 2 days before the question date
		const resultTimestamp = new Date("2024-03-13T00:00:00Z")
		const boosted = temporalProximityBoost(
			"what did I eat last week",
			questionDate,
			resultTimestamp,
			0.5,
		)
		expect(boosted).toBeGreaterThan(0.5)
	})

	it("parses 'a week ago' as ~7 day window", () => {
		const questionDate = new Date("2024-03-15T00:00:00Z")
		// 6 days before question date — within the "week ago" window
		const close = temporalProximityBoost(
			"what did I eat a week ago",
			questionDate,
			new Date("2024-03-09T00:00:00Z"),
			0.5,
		)
		// 30 days before — outside
		const far = temporalProximityBoost(
			"what did I eat a week ago",
			questionDate,
			new Date("2024-02-14T00:00:00Z"),
			0.5,
		)
		expect(close).toBeGreaterThan(far)
	})

	it("parses 'last month' as ~30 day window", () => {
		const questionDate = new Date("2024-03-15T00:00:00Z")
		const inWindow = temporalProximityBoost(
			"what happened last month",
			questionDate,
			new Date("2024-02-20T00:00:00Z"),
			0.5,
		)
		expect(inWindow).toBeGreaterThan(0.5)
	})

	it("parses 'recently' as ~14 day window", () => {
		const questionDate = new Date("2024-03-15T00:00:00Z")
		const recent = temporalProximityBoost(
			"what did I recently discuss",
			questionDate,
			new Date("2024-03-05T00:00:00Z"),
			0.5,
		)
		expect(recent).toBeGreaterThan(0.5)
	})

	it("returns original score when no questionDate provided", () => {
		const boosted = temporalProximityBoost(
			"what did I eat",
			undefined,
			new Date("2024-03-13T00:00:00Z"),
			0.5,
		)
		expect(boosted).toBe(0.5)
	})

	it("returns original score when result has no timestamp", () => {
		const boosted = temporalProximityBoost(
			"what did I eat a week ago",
			new Date("2024-03-15T00:00:00Z"),
			undefined,
			0.5,
		)
		expect(boosted).toBe(0.5)
	})

	it("uses custom maxBoost", () => {
		const questionDate = new Date("2024-03-15T00:00:00Z")
		const ts = new Date("2024-03-14T00:00:00Z") // 1 day ago
		const defaultBoost = temporalProximityBoost(
			"what happened recently",
			questionDate,
			ts,
			0.5,
		)
		const highBoost = temporalProximityBoost(
			"what happened recently",
			questionDate,
			ts,
			0.5,
			0.8,
		)
		expect(highBoost).toBeGreaterThan(defaultBoost)
	})
})

// ---------------------------------------------------------------------------
// entityNameBoost
// ---------------------------------------------------------------------------

describe("entityNameBoost", () => {
	it("boosts when capitalized proper nouns from query appear in snippet", () => {
		const boosted = entityNameBoost(
			"What did John Smith recommend",
			"John Smith told me to try the new cafe downtown",
			0.5,
		)
		expect(boosted).toBeGreaterThan(0.5)
	})

	it("returns original score when no proper nouns match", () => {
		const boosted = entityNameBoost(
			"What did John recommend",
			"The weather was nice yesterday and I went hiking",
			0.5,
		)
		expect(boosted).toBe(0.5)
	})

	it("returns original score for query with no proper nouns", () => {
		const boosted = entityNameBoost(
			"what is the weather today",
			"Today the weather is sunny and warm",
			0.5,
		)
		expect(boosted).toBe(0.5)
	})

	it("handles empty query", () => {
		expect(entityNameBoost("", "some text", 0.5)).toBe(0.5)
	})

	it("handles empty snippet", () => {
		expect(entityNameBoost("What did John say", "", 0.5)).toBe(0.5)
	})

	it("uses custom weight", () => {
		const defaultW = entityNameBoost(
			"What did John Smith say",
			"John Smith mentioned the project",
			0.5,
		)
		const highW = entityNameBoost(
			"What did John Smith say",
			"John Smith mentioned the project",
			0.5,
			0.8,
		)
		expect(highW).toBeGreaterThan(defaultW)
	})
})

// ---------------------------------------------------------------------------
// quotedPhraseBoost
// ---------------------------------------------------------------------------

describe("quotedPhraseBoost", () => {
	it("boosts when exact quoted phrase appears in snippet", () => {
		const boosted = quotedPhraseBoost(
			'find the "chocolate cake recipe" I mentioned',
			"I shared a chocolate cake recipe with cream cheese frosting",
			0.5,
		)
		expect(boosted).toBeGreaterThan(0.5)
	})

	it("returns original score when quoted phrase is absent from snippet", () => {
		const boosted = quotedPhraseBoost(
			'find the "chocolate cake recipe" please',
			"I went jogging in the park yesterday morning",
			0.5,
		)
		expect(boosted).toBe(0.5)
	})

	it("returns original score when query has no quoted phrases", () => {
		expect(quotedPhraseBoost("no quotes here", "some snippet text", 0.5)).toBe(
			0.5,
		)
	})

	it("handles multiple quoted phrases", () => {
		const boosted = quotedPhraseBoost(
			'Search for "hello world" and "goodbye world"',
			"She said hello world to everyone and then said goodbye world at the end",
			0.5,
		)
		expect(boosted).toBeGreaterThan(0.5)
	})

	it("is case-insensitive", () => {
		const boosted = quotedPhraseBoost(
			'find "Hello World"',
			"i wrote hello world in the terminal",
			0.5,
		)
		expect(boosted).toBeGreaterThan(0.5)
	})

	it("handles empty query", () => {
		expect(quotedPhraseBoost("", "text", 0.5)).toBe(0.5)
	})

	it("handles empty snippet", () => {
		expect(quotedPhraseBoost('"test phrase"', "", 0.5)).toBe(0.5)
	})

	it("uses custom weight", () => {
		const defaultW = quotedPhraseBoost(
			'"hello world"',
			"hello world is here",
			0.5,
		)
		const highW = quotedPhraseBoost(
			'"hello world"',
			"hello world is here",
			0.5,
			1.0,
		)
		expect(highW).toBeGreaterThan(defaultW)
	})
})

// ---------------------------------------------------------------------------
// applyPostRetrievalScoring (composite)
// ---------------------------------------------------------------------------

describe("applyPostRetrievalScoring", () => {
	it("re-sorts results by composite boosted score", () => {
		const results: MemorySearchResult[] = [
			makeResult({ score: 0.8, snippet: "The weather in Paris is nice" }),
			makeResult({
				score: 0.7,
				snippet: "John mentioned the Tokyo restaurant last week",
				timestamp: new Date("2024-03-10T00:00:00Z"),
			}),
		]

		const scored = applyPostRetrievalScoring(
			"What did John say about Tokyo restaurant",
			results,
			{ questionDate: new Date("2024-03-15T00:00:00Z") },
		)

		// The second result should be boosted above the first due to keyword, entity, and temporal matches
		expect(scored[0].snippet).toContain("Tokyo restaurant")
	})

	it("preserves all results without adding or removing", () => {
		const results: MemorySearchResult[] = [
			makeResult({ score: 0.9, snippet: "first" }),
			makeResult({ score: 0.5, snippet: "second" }),
			makeResult({ score: 0.3, snippet: "third" }),
		]
		const scored = applyPostRetrievalScoring("test query", results)
		expect(scored).toHaveLength(3)
	})

	it("handles empty results", () => {
		const scored = applyPostRetrievalScoring("test", [])
		expect(scored).toHaveLength(0)
	})

	it("works without questionDate", () => {
		const results: MemorySearchResult[] = [
			makeResult({ score: 0.8, snippet: "Some text about coding" }),
		]
		const scored = applyPostRetrievalScoring("coding", results)
		expect(scored).toHaveLength(1)
	})

	it("is ranking-only — does not retrieve new documents", () => {
		const input: MemorySearchResult[] = [
			makeResult({ score: 0.6, snippet: "alpha" }),
			makeResult({ score: 0.4, snippet: "beta" }),
		]
		const inputPaths = new Set(input.map((r) => r.snippet))
		const scored = applyPostRetrievalScoring("query", input)
		const outputPaths = new Set(scored.map((r) => r.snippet))
		expect(outputPaths).toEqual(inputPaths)
	})
})
