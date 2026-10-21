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
vi.mock("./mongodb-search-lanes.js", async (original) => ({
	...(await original<typeof import("./mongodb-search-lanes.js")>()),
	searchConversationEvidenceEvents: vi.fn(),
	searchTemporalCoverageEvents: vi.fn(),
	searchTurnEventsWithinSessions: vi.fn(),
	searchRawWindowEvents: vi.fn(async () => []),
}))
vi.mock("./mongodb-round-partner.js", async (original) => ({
	...(await original<typeof import("./mongodb-round-partner.js")>()),
	attachRoundPartners: vi.fn(),
}))

import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
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
import { attachRoundPartners } from "./mongodb-round-partner.js"
import type { MemorySearchResult } from "./types.js"
import { HEALTHY_TEST_CAPABILITIES } from "./test-helpers/search-capabilities.js"

const db = {} as Db

function run(searchOptions: Record<string, unknown> = {}) {
	return searchV2(db, "test_", "what did we decide", "agent-1", {
		availablePaths: new Set(["hybrid"]),
		searchOptions: {
			allowHybridBackstop: false,
			capabilities: HEALTHY_TEST_CAPABILITIES,
			scope: "agent",
			scopeRef: "agent:wren",
			...searchOptions,
		},
	})
}

function turn(
	id: string,
	role: "user" | "assistant",
	score: number,
): MemorySearchResult {
	return {
		path: `events/${id}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: `fictional turn ${id}`,
		text: `fictional turn ${id}`,
		source: "conversation",
		canonicalId: `event:${id}`,
		sessionId: "s-oak",
		role,
		timestamp: new Date("2031-04-02T10:00:00.000Z"),
	}
}

const stageOne = [turn("u1", "user", 0.9), turn("a2", "assistant", 0.6)]

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
	vi.mocked(getLaneCoverage).mockResolvedValue({
		agentId: "agent-1",
		updatedAt: new Date(),
		lanes: {},
	} as never)
	vi.mocked(planRetrieval).mockReturnValue({
		paths: ["hybrid"],
		confidence: "high",
		reasoning: "owned fixture",
	})
	vi.mocked(searchStructuredMemory).mockResolvedValue([])
	vi.mocked(findExactProcedureMatches).mockResolvedValue([])
	vi.mocked(searchProcedures).mockResolvedValue([])
	vi.mocked(searchEpisodes).mockResolvedValue([])
	vi.mocked(searchEntitiesAutocomplete).mockResolvedValue([])
	vi.mocked(expandGraph).mockResolvedValue(null)
	vi.mocked(mongoSearch).mockResolvedValue(stageOne)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("searchV2 round partner option", () => {
	it("characterization: without the option the results are unchanged", async () => {
		const result = await run()
		expect(JSON.stringify(result.results)).toMatchInlineSnapshot(
			`"[{"path":"events/u1","startLine":0,"endLine":0,"score":1,"snippet":"fictional turn u1","text":"fictional turn u1","source":"conversation","canonicalId":"event:u1","sessionId":"s-oak","role":"user","timestamp":"2031-04-02T10:00:00.000Z"},{"path":"events/a2","startLine":0,"endLine":0,"score":0.6666666666666667,"snippet":"fictional turn a2","text":"fictional turn a2","source":"conversation","canonicalId":"event:a2","sessionId":"s-oak","role":"assistant","timestamp":"2031-04-02T10:00:00.000Z"}]"`,
		)
		expect(
			result.metadata.laneOutcomes?.map((row) => `${row.lane}:${row.stage}`),
		).toMatchInlineSnapshot(`
			[
			  "conversation-evidence:plan",
			  "hybrid:session_chunks:lane",
			  "hybrid:memory_evidence:lane",
			  "hybrid:chunks:lane",
			  "hybrid:lane",
			  "temporal-coverage:plan",
			  "turn-precision:plan",
			]
		`)
	})
	it("runs no partner query and records no row when the option is false", async () => {
		const result = await run({ includeRoundPartner: false })
		expect(attachRoundPartners).not.toHaveBeenCalled()
		expect(
			result.metadata.laneOutcomes?.filter(
				(row) => row.lane === "round-partner",
			),
		).toEqual([])
		const unchanged = await run()
		expect(JSON.stringify(result.results)).toBe(
			JSON.stringify(unchanged.results),
		)
	})

	it("attaches partners to the final results in one call, scoped to the search namespace", async () => {
		const questionDate = new Date("2031-04-03T00:00:00.000Z")
		vi.mocked(attachRoundPartners).mockImplementation(async ({ results }) =>
			results.map((result, index) =>
				index === 0
					? {
							...result,
							roundPartner: {
								canonicalId: "event:a1",
								role: "assistant",
								text: "fictional answer",
							},
						}
					: {
							...result,
							roundPartner: null,
							roundPartnerMissing: "session-end",
						},
			),
		)
		const result = await run({ includeRoundPartner: true, questionDate })
		expect(attachRoundPartners).toHaveBeenCalledTimes(1)
		const call = vi.mocked(attachRoundPartners).mock.calls[0]?.[0]
		expect(call?.namespace).toEqual({
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:wren",
		})
		expect(call?.questionDate).toBe(questionDate)
		expect(call?.results.map((r) => [r.canonicalId, r.score])).toEqual([
			["event:u1", 1],
			["event:a2", 0.6666666666666667],
		])
		expect(
			result.results.map((r) => [
				r.roundPartner?.canonicalId ?? null,
				r.roundPartnerMissing,
			]),
		).toEqual([
			["event:a1", undefined],
			[null, "session-end"],
		])
		expect(
			result.metadata.laneOutcomes?.filter(
				(row) => row.lane === "round-partner",
			),
		).toEqual([
			{ lane: "round-partner", stage: "lane", outcome: "ok", resultCount: 1 },
		])
	})

	it("reports a failed partner query as a failed row and marks every turn lookup-failed", async () => {
		vi.mocked(attachRoundPartners).mockRejectedValue(new Error("down"))
		const result = await run({ includeRoundPartner: true })
		expect(
			result.metadata.laneOutcomes?.filter(
				(row) => row.lane === "round-partner",
			),
		).toEqual([
			{
				lane: "round-partner",
				stage: "lane",
				outcome: "failed",
				reason: "internal-error",
			},
		])
		expect(result.metadata.outcomeStatus).toBe("partial")
		expect(
			result.results.map((r) => [
				r.canonicalId,
				r.roundPartner,
				r.roundPartnerMissing,
			]),
		).toEqual([
			["event:u1", null, "lookup-failed"],
			["event:a2", null, "lookup-failed"],
		])
	})
})
