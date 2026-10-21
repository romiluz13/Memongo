import { afterEach, describe, expect, it, vi } from "vitest"
import { applyLaneAwareResultControls } from "./mongodb-search-executor.js"
import type { MemorySearchResult } from "./types.js"

// The per-session cap of the lane controls (3 turns per session, 1 for
// multi-session breadth questions). Over-cap turns are "session-capped".

function turn(
	id: string,
	sessionId: string,
	score: number,
): MemorySearchResult {
	return {
		path: `events/${id}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: `turn ${id}`,
		source: "conversation",
		canonicalId: `event:${id}`,
		sessionId,
		sourceEventIds: [id],
	}
}

// Session s-a holds five turns above every other session's best turn, so
// with topK 4 and three turns per session, a4 and a5 are over the cap.
const fixture = [
	turn("a1", "s-a", 1.0),
	turn("a2", "s-a", 0.99),
	turn("a3", "s-a", 0.98),
	turn("a4", "s-a", 0.97),
	turn("a5", "s-a", 0.96),
	turn("b1", "s-b", 0.9),
	turn("c1", "s-c", 0.8),
	turn("d1", "s-d", 0.7),
]

function control(results: MemorySearchResult[] = fixture) {
	return applyLaneAwareResultControls({
		query: "What did I tell you about my apartment lease?",
		results,
		classification: "direct",
		planPaths: ["hybrid"],
		topK: 4,
	})
}

const ids = (results: MemorySearchResult[]) =>
	results.map((result) => result.canonicalId?.replace("event:", ""))

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("session cap with turn recall unset (characterization)", () => {
	it("appends over-cap turns after every lower-scored result", () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "")
		const controlled = control()
		expect(ids(controlled.results)).toEqual([
			"a1",
			"a2",
			"a3",
			"b1",
			"c1",
			"d1",
			"a4",
			"a5",
		])
		expect(controlled.summary.sessionCapped).toBe(2)
	})
})
