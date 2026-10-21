import { afterEach, describe, expect, it, vi } from "vitest"
import { applyLaneAwareResultControls } from "./mongodb-search-executor.js"
import { isSessionTurnRecallEnabled } from "./mongodb-session-turn-recall.js"
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
		sessionTurnRecall: isSessionTurnRecallEnabled(),
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

const sessionCapTrace = (result: MemorySearchResult) => ({
	laneControl: result.provenance?.laneControl,
	preControlRank: result.provenance?.preControlRank,
})

describe("session-capped trace (always on)", () => {
	it("flags each over-cap turn with its pre-control rank and keeps the order when recall is unset", () => {
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
		const byId = new Map(
			controlled.results.map((result) => [result.canonicalId, result]),
		)
		expect(sessionCapTrace(byId.get("event:a4") as MemorySearchResult)).toEqual(
			{ laneControl: "session-capped", preControlRank: 4 },
		)
		expect(sessionCapTrace(byId.get("event:a5") as MemorySearchResult)).toEqual(
			{ laneControl: "session-capped", preControlRank: 5 },
		)
		for (const id of ["a1", "a2", "a3", "b1", "c1", "d1"]) {
			expect(byId.get(`event:${id}`)?.provenance).toBeUndefined()
		}
	})

	it("ranks the pre-control position from the controls' input order", () => {
		const shuffled = [
			fixture[7],
			fixture[4],
			...fixture.slice(0, 4),
			...fixture.slice(5, 7),
		]
		const controlled = control(shuffled as MemorySearchResult[])
		const a5 = controlled.results.find((r) => r.canonicalId === "event:a5")
		expect(a5?.provenance?.preControlRank).toBe(2)
	})
})

describe("session-capped demotion with turn recall enabled", () => {
	it("moves over-cap turns right after the top block, in score order", () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "enabled")
		const controlled = control()
		expect(ids(controlled.results)).toEqual([
			"a1",
			"a2",
			"a3",
			"b1",
			"a4",
			"a5",
			"c1",
			"d1",
		])
		expect(
			controlled.results.slice(4, 6).map((result) => result.provenance),
		).toEqual([
			{ laneControl: "session-capped", preControlRank: 4 },
			{ laneControl: "session-capped", preControlRank: 5 },
		])
	})

	it("breaks equal-score over-cap ties by their pre-control order", () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "enabled")
		const tied = [
			turn("a1", "s-a", 1.0),
			turn("a2", "s-a", 0.99),
			turn("a3", "s-a", 0.98),
			turn("a5", "s-a", 0.97),
			turn("a4", "s-a", 0.97),
			turn("b1", "s-b", 0.9),
			turn("c1", "s-c", 0.8),
		]
		const first = ids(control(tied).results)
		const second = ids(control(tied.map((result) => ({ ...result }))).results)
		expect(first).toEqual(["a1", "a2", "a3", "b1", "a5", "a4", "c1"])
		expect(second).toEqual(first)
	})

	it("keeps other values of the flag on the unset order", () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "true")
		expect(ids(control().results)).toEqual([
			"a1",
			"a2",
			"a3",
			"b1",
			"c1",
			"d1",
			"a4",
			"a5",
		])
	})
})
