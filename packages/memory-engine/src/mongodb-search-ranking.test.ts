import { describe, expect, it } from "vitest"
import { mapEventSearchDocToResult } from "./mongodb-search-ranking.js"

describe("mapEventSearchDocToResult (RET-09 provenance carry)", () => {
	it("carries the event role and its derivation onto the result", () => {
		const result = mapEventSearchDocToResult(
			{
				eventId: "evt-1",
				body: "We deploy on Mondays",
				role: "user",
				score: 0.91,
				sessionId: "session-1",
			},
			"turn-vector",
		)
		expect(result?.role).toBe("user")
		expect(result?.derivation).toBe("user")
		expect(result?.provenance?.eventRole).toBe("user")
	})

	it("labels assistant turns as agent-derived", () => {
		const result = mapEventSearchDocToResult(
			{
				eventId: "evt-2",
				body: "Noted: deploys happen on Mondays",
				role: "assistant",
				score: 0.88,
			},
			"turn-text",
		)
		expect(result?.role).toBe("assistant")
		expect(result?.derivation).toBe("agent")
	})

	it("falls back to derived when the event lane doc carries no role", () => {
		// Legacy event rows (or lanes that drop the projection): no role
		// field → conservative derived default, never user-authored.
		const result = mapEventSearchDocToResult(
			{
				eventId: "evt-3",
				body: "unknown authorship",
				score: 0.8,
			},
			"turn-vector",
		)
		expect(result?.role).toBeUndefined()
		expect(result?.derivation).toBe("derived")
	})

	it("returns null for docs without a usable identity", () => {
		expect(
			mapEventSearchDocToResult({ body: "no id", score: 0.9 }, "turn-vector"),
		).toBeNull()
		expect(
			mapEventSearchDocToResult({ eventId: "evt-4", score: 0.9 }, "turn-text"),
		).toBeNull()
	})

	it("carries the full body as text alongside the 700-char snippet (B5)", () => {
		const longBody = `${"assistant recommendation ".repeat(60)}the 5th item past char 700`
		expect(longBody.length).toBeGreaterThan(700)
		const result = mapEventSearchDocToResult(
			{
				eventId: "evt-5",
				body: longBody,
				role: "assistant",
				score: 0.9,
			},
			"turn-vector",
		)
		// Snippet stays the display preview...
		expect(result?.snippet).toHaveLength(700)
		// ...while the full text keeps the answer past character 700 reachable
		// for the reranker and the reader.
		expect(result?.text).toBe(longBody)
	})

	it("bounds the full text at MAX_RESULT_TEXT_CHARS for pathological turns (B5)", () => {
		const pathologicalBody = "x".repeat(20_000)
		const result = mapEventSearchDocToResult(
			{ eventId: "evt-6", body: pathologicalBody, score: 0.9 },
			"turn-vector",
		)
		expect(result?.text).toHaveLength(16_000)
	})
})
