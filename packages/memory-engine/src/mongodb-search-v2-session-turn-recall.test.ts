import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn(),
}))
vi.mock("./mongodb-retrieval-planner.js", async (original) => ({
	...(await original<typeof import("./mongodb-retrieval-planner.js")>()),
	planRetrieval: vi.fn(),
}))
vi.mock("./mongodb-schema.js", async (original) => ({
	...(await original<typeof import("./mongodb-schema.js")>()),
	structuredMemCollection: vi.fn(() => ({})),
	proceduresCollection: vi.fn(() => ({})),
	chunksCollection: vi.fn(() => ({})),
}))
vi.mock("./mongodb-structured-memory.js", async (original) => ({
	...(await original<typeof import("./mongodb-structured-memory.js")>()),
	searchStructuredMemory: vi.fn(),
}))
vi.mock("./mongodb-procedures.js", async (original) => ({
	...(await original<typeof import("./mongodb-procedures.js")>()),
	findExactProcedureMatches: vi.fn(),
	searchProcedures: vi.fn(),
}))
vi.mock("./mongodb-episodes.js", async (original) => ({
	...(await original<typeof import("./mongodb-episodes.js")>()),
	searchEpisodes: vi.fn(),
}))
vi.mock("./mongodb-graph.js", async (original) => ({
	...(await original<typeof import("./mongodb-graph.js")>()),
	searchEntitiesAutocomplete: vi.fn(),
	expandGraph: vi.fn(),
}))
vi.mock("./mongodb-events.js", async (original) => ({
	...(await original<typeof import("./mongodb-events.js")>()),
	getEventsByTimeRange: vi.fn(async () => []),
}))
vi.mock("./mongodb-search.js", async (original) => ({
	...(await original<typeof import("./mongodb-search.js")>()),
	mongoSearch: vi.fn(),
	vectorSearch: vi.fn(),
}))
vi.mock("./mongodb-session-turn-recall.js", async (original) => ({
	...(await original<typeof import("./mongodb-session-turn-recall.js")>()),
	recallSessionTurns: vi.fn(),
}))
vi.mock("./mongodb-search-lanes.js", async (original) => ({
	...(await original<typeof import("./mongodb-search-lanes.js")>()),
	searchConversationEvidenceEvents: vi.fn(),
	searchTemporalCoverageEvents: vi.fn(),
	searchTurnEventsWithinSessions: vi.fn(),
	searchRawWindowEvents: vi.fn(async () => []),
}))

import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import {
	findExactProcedureMatches,
	searchProcedures,
} from "./mongodb-procedures.js"
import { searchEpisodes } from "./mongodb-episodes.js"
import { expandGraph, searchEntitiesAutocomplete } from "./mongodb-graph.js"
import { mongoSearch } from "./mongodb-search.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { recallSessionTurns } from "./mongodb-session-turn-recall.js"
import type { MemorySearchResult } from "./types.js"
import type { SearchLaneOutcome } from "./search-outcomes.js"
import { HEALTHY_TEST_CAPABILITIES } from "./test-helpers/search-capabilities.js"

const db = {} as Db
function plan(paths: RetrievalPath[]) {
	vi.mocked(planRetrieval).mockReturnValue({
		paths,
		confidence: "high",
		reasoning: "owned fixture",
	})
}

function coverage(lanes: Record<string, boolean>) {
	vi.mocked(getLaneCoverage).mockResolvedValue({
		agentId: "agent-1",
		updatedAt: new Date(),
		lanes: Object.fromEntries(
			Object.entries(lanes).map(([lane, hasData]) => [
				lane,
				{ hasData, count: hasData ? 1 : 0, lastUpdated: new Date() },
			]),
		),
	} as never)
}

function rowsFor(rows: SearchLaneOutcome[] | undefined, lane: string) {
	return (rows ?? []).filter((row) => row.lane === lane)
}

function run(
	query: string,
	paths: RetrievalPath[],
	searchOptions: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) {
	return searchV2(db, "test_", query, "agent-1", {
		availablePaths: new Set(paths),
		...extra,
		searchOptions: {
			allowHybridBackstop: false,
			capabilities: HEALTHY_TEST_CAPABILITIES,
			...searchOptions,
		},
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_TEMPORAL_COVERAGE_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
	coverage({})
	vi.mocked(searchStructuredMemory).mockResolvedValue([])
	vi.mocked(findExactProcedureMatches).mockResolvedValue([])
	vi.mocked(searchProcedures).mockResolvedValue([])
	vi.mocked(searchEpisodes).mockResolvedValue([])
	vi.mocked(searchEntitiesAutocomplete).mockResolvedValue([])
	vi.mocked(expandGraph).mockResolvedValue(null)
	vi.mocked(mongoSearch).mockResolvedValue([])
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

// C-1 stage 2 wiring: opt-in through MEMONGO_SESSION_TURN_RECALL=enabled,
// after the lane controls and before the final normalize and slice.

function chunk(
	id: string,
	sessionId: string,
	score: number,
): MemorySearchResult {
	return {
		path: `chunks/${id}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: `fictional passage ${id}`,
		source: "memory",
		canonicalId: `chunk:${id}`,
		sessionId,
	}
}

const stageOne = [chunk("a", "s-oak", 0.9), chunk("b", "s-elm", 0.6)]

describe("searchV2 session turn recall", () => {
	it("runs nothing and records no row when the flag is unset", async () => {
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockResolvedValue(stageOne)
		const result = await run("what did we decide", ["hybrid"])
		expect(recallSessionTurns).not.toHaveBeenCalled()
		expect(
			rowsFor(result.metadata.laneOutcomes, "session-turn-recall"),
		).toEqual([])
		expect(result.results.map((r) => r.canonicalId)).toEqual([
			"chunk:a",
			"chunk:b",
		])
	})

	it("hands the lane-controlled results to stage 2 and places its turns after their session", async () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "enabled")
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockResolvedValue(stageOne)
		vi.mocked(recallSessionTurns).mockResolvedValue([
			{
				...chunk("turn", "s-oak", 0.2),
				canonicalId: "event:turn",
				provenance: { lane: "session-turn-recall", inSessionRank: 1 },
			},
		])
		const result = await run("what did we decide", ["hybrid"], {
			scope: "agent",
			scopeRef: "agent:wren",
		})
		expect(recallSessionTurns).toHaveBeenCalledTimes(1)
		const call = vi.mocked(recallSessionTurns).mock.calls[0]?.[0]
		expect(call?.namespace).toEqual({
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:wren",
		})
		expect(call?.results.map((r) => r.canonicalId)).toEqual([
			"chunk:a",
			"chunk:b",
		])
		expect(result.results.map((r) => r.canonicalId)).toEqual([
			"chunk:a",
			"event:turn",
			"chunk:b",
		])
		expect(
			rowsFor(result.metadata.laneOutcomes, "session-turn-recall"),
		).toEqual([
			{
				lane: "session-turn-recall",
				stage: "lane",
				outcome: "ok",
				resultCount: 1,
			},
		])
	})

	it("returns the same results, byte for byte, when the flag is unset and stage 1 overflows maxResults", async () => {
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockResolvedValue([
			chunk("a", "s-oak", 0.9),
			chunk("b", "s-elm", 0.8),
			chunk("c", "s-oak", 0.7),
			chunk("d", "s-ash", 0.6),
		])
		const result = await run(
			"what did we decide",
			["hybrid"],
			{},
			{
				maxResults: 3,
			},
		)
		expect(recallSessionTurns).not.toHaveBeenCalled()
		expect(result.metadata).not.toHaveProperty("sessionTurnRecall")
		expect(result.results).toMatchInlineSnapshot(`
			[
			  {
			    "canonicalId": "chunk:a",
			    "endLine": 0,
			    "path": "chunks/a",
			    "score": 0.9,
			    "sessionId": "s-oak",
			    "snippet": "fictional passage a",
			    "source": "memory",
			    "startLine": 0,
			  },
			  {
			    "canonicalId": "chunk:b",
			    "endLine": 0,
			    "path": "chunks/b",
			    "score": 0.8,
			    "sessionId": "s-elm",
			    "snippet": "fictional passage b",
			    "source": "memory",
			    "startLine": 0,
			  },
			  {
			    "canonicalId": "chunk:c",
			    "endLine": 0,
			    "path": "chunks/c",
			    "provenance": {
			      "heuristicRerankAdjustment": -0.10499999999999998,
			    },
			    "score": 0.595,
			    "sessionId": "s-oak",
			    "snippet": "fictional passage c",
			    "source": "memory",
			    "startLine": 0,
			  },
			]
		`)
	})

	it("keeps every stage-1 session under maxResults and records what the merge dropped", async () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "enabled")
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockResolvedValue([
			chunk("a", "s-oak", 0.9),
			chunk("b", "s-elm", 0.8),
			chunk("c", "s-oak", 0.7),
			chunk("d", "s-ash", 0.6),
		])
		vi.mocked(recallSessionTurns).mockResolvedValue([
			{
				...chunk("turn-1", "s-oak", 0.2),
				canonicalId: "event:turn-1",
				provenance: { lane: "session-turn-recall", inSessionRank: 1 },
			},
			{
				...chunk("turn-2", "s-oak", 0.1),
				canonicalId: "event:turn-2",
				provenance: { lane: "session-turn-recall", inSessionRank: 2 },
			},
		])
		const result = await run(
			"what did we decide",
			["hybrid"],
			{},
			{
				maxResults: 4,
			},
		)
		expect(result.results.map((r) => r.canonicalId)).toEqual([
			"chunk:a",
			"event:turn-1",
			"chunk:b",
			"chunk:d",
		])
		expect(result.metadata.sessionTurnRecall).toEqual({
			recalled: 2,
			inserted: 1,
			stageOneEvicted: 1,
			recalledDroppedForRoom: 1,
			recalledDroppedPastCap: 0,
		})
	})

	it("records a failed stage 2 as a failed row and keeps the stage-1 results", async () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "enabled")
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockResolvedValue(stageOne)
		vi.mocked(recallSessionTurns).mockRejectedValue(new Error("down"))
		const result = await run("what did we decide", ["hybrid"])
		expect(
			rowsFor(result.metadata.laneOutcomes, "session-turn-recall"),
		).toEqual([
			{
				lane: "session-turn-recall",
				stage: "lane",
				outcome: "failed",
				reason: "internal-error",
			},
		])
		expect(result.metadata.outcomeStatus).toBe("partial")
		expect(result.results.map((r) => r.canonicalId)).toEqual([
			"chunk:a",
			"chunk:b",
		])
	})
})

// Paired benchmark arms run in one process, so the mode is a per-search
// option that overrides the env flag; absent, the flag decides.
describe("searchV2 per-search session turn recall", () => {
	// Five turns of one session over a ten-result top block: two are session
	// capped, and only recall mode moves them ahead of the later results.
	const overflowing = [
		...[0.99, 0.98, 0.97, 0.96, 0.95].map((score, index) =>
			chunk(`oak-${index}`, "s-oak", score),
		),
		...[0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4].map((score, index) =>
			chunk(`other-${index}`, `s-${index}`, score),
		),
	]

	it("runs stage 2 when the option is true and the flag is unset", async () => {
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockResolvedValue(stageOne)
		vi.mocked(recallSessionTurns).mockResolvedValue([
			{
				...chunk("turn", "s-oak", 0.2),
				canonicalId: "event:turn",
				provenance: { lane: "session-turn-recall", inSessionRank: 1 },
			},
		])
		const result = await run("what did we decide", ["hybrid"], {
			sessionTurnRecall: true,
		})
		expect(recallSessionTurns).toHaveBeenCalledTimes(1)
		expect(result.results.map((r) => r.canonicalId)).toEqual([
			"chunk:a",
			"event:turn",
			"chunk:b",
		])
	})

	it("runs nothing when the option is false and the flag is enabled", async () => {
		vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", "enabled")
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockResolvedValue(stageOne)
		const result = await run("what did we decide", ["hybrid"], {
			sessionTurnRecall: false,
		})
		expect(recallSessionTurns).not.toHaveBeenCalled()
		expect(
			rowsFor(result.metadata.laneOutcomes, "session-turn-recall"),
		).toEqual([])
	})

	it("orders over-cap turns as the env flag would, in both directions", async () => {
		plan(["hybrid"])
		vi.mocked(recallSessionTurns).mockResolvedValue([])
		const order = async (
			env: string | undefined,
			option: boolean | undefined,
		) => {
			vi.unstubAllEnvs()
			vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
			vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
			if (env) vi.stubEnv("MEMONGO_SESSION_TURN_RECALL", env)
			vi.mocked(mongoSearch).mockResolvedValue(overflowing)
			const result = await run(
				"what did we decide",
				["hybrid"],
				option === undefined ? {} : { sessionTurnRecall: option },
				{ maxResults: 14 },
			)
			return result.results.map((r) => r.canonicalId)
		}
		const flagOn = await order("enabled", undefined)
		const flagOff = await order(undefined, undefined)
		expect(flagOn).not.toEqual(flagOff)
		expect(await order(undefined, true)).toEqual(flagOn)
		expect(await order("enabled", false)).toEqual(flagOff)
	})
})
