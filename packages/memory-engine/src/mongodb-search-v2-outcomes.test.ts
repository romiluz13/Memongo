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
import type { Entity } from "./mongodb-graph.js"
import { mongoSearch } from "./mongodb-search.js"
import {
	searchConversationEvidenceEvents,
	searchTemporalCoverageEvents,
} from "./mongodb-search-lanes.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { searchV2 } from "./mongodb-search-v2.js"
import type { SearchLaneOutcome } from "./search-outcomes.js"
import { HEALTHY_TEST_CAPABILITIES } from "./test-helpers/search-capabilities.js"

const db = {} as Db
const noCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

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

describe("searchV2 outcome rows (#101 section 1b)", () => {
	it("V1: a coverage read failure is a planner row, partial, and never arms a backstop", async () => {
		plan(["structured"])
		vi.mocked(getLaneCoverage).mockRejectedValue(new Error("coverage down"))
		const result = await run("what did we decide", ["structured", "hybrid"], {
			allowHybridBackstop: true,
		})
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "planner",
			stage: "plan",
			outcome: "failed",
			reason: "internal-error",
		})
		expect(result.metadata.outcomeStatus).toBe("partial")
		// Unknown coverage no longer makes the hybrid backstop permissive.
		expect(mongoSearch).not.toHaveBeenCalled()
		expect(rowsFor(result.metadata.laneOutcomes, "backstop:hybrid")).toEqual([])
	})

	it("V2/V3: a failed lane records one value-free failed row and never also ok", async () => {
		plan(["structured"])
		vi.mocked(searchStructuredMemory).mockRejectedValue(
			new Error("PRIVATE provider text"),
		)
		const result = await run("what did we decide", ["structured"])
		expect(rowsFor(result.metadata.laneOutcomes, "structured")).toEqual([
			{
				lane: "structured",
				stage: "lane",
				outcome: "failed",
				reason: "internal-error",
			},
		])
		expect(JSON.stringify(result.metadata)).not.toContain("PRIVATE")
		expect(result.metadata.outcomeStatus).toBe("failed")
	})

	it("V5: a path beyond the three-lane cap is a not-planned row", async () => {
		plan(["structured", "episodic", "procedural", "raw-window"])
		const result = await run("what did we decide", [
			"structured",
			"episodic",
			"procedural",
			"raw-window",
		])
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "raw-window",
			stage: "plan",
			outcome: "not-applicable",
			reason: "not-planned",
		})
		expect(result.metadata.pathsExecuted).not.toContain("raw-window")
	})

	it("V5: zero runnable lanes is a failed request, never a silent empty", async () => {
		plan([])
		const result = await run("what did we decide", ["structured"])
		expect(result.results).toEqual([])
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "search",
			stage: "plan",
			outcome: "failed",
			reason: "lane-unavailable",
		})
		expect(result.metadata.outcomeStatus).toBe("failed")
	})

	it("V6: graph with no entity candidates is not-applicable, with no lane ok row", async () => {
		plan(["graph"])
		const result = await run("is it ok", ["graph"])
		expect(rowsFor(result.metadata.laneOutcomes, "graph")).toEqual([
			{
				lane: "graph",
				stage: "entity-lookup",
				outcome: "not-applicable",
				reason: "no-candidates",
			},
		])
		expect(searchEntitiesAutocomplete).not.toHaveBeenCalled()
		expect(result.metadata.outcomeStatus).toBe("complete")
	})

	it("V7: graph with candidates but no entity match is ok-empty at entity-lookup", async () => {
		plan(["graph"])
		const result = await run(
			"Alice",
			["graph"],
			{},
			{
				knownEntityNames: ["Alice"],
			},
		)
		expect(rowsFor(result.metadata.laneOutcomes, "graph")).toEqual([
			{
				lane: "graph",
				stage: "entity-lookup",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
			{
				lane: "graph",
				stage: "lane",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("V8: a matched entity whose graph is missing is ok-empty at graph-expand", async () => {
		plan(["graph"])
		vi.mocked(searchEntitiesAutocomplete).mockResolvedValue([
			{
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				updatedAt: new Date(),
			} as unknown as Entity,
		])
		const result = await run(
			"Alice",
			["graph"],
			{},
			{
				knownEntityNames: ["Alice"],
			},
		)
		expect(expandGraph).toHaveBeenCalledOnce()
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "graph",
			stage: "graph-expand",
			outcome: "ok-empty",
			reason: "zero-hits",
			resultCount: 0,
		})
	})

	it("V9: vector-only hybrid with neither capability is lane-unavailable, not ok 0", async () => {
		plan(["hybrid"])
		const result = await run("what did we decide", ["hybrid"], {
			capabilities: noCapabilities,
			searchConfig: { hybridMode: "vector-only" },
		})
		expect(rowsFor(result.metadata.laneOutcomes, "hybrid")).toEqual([
			{
				lane: "hybrid",
				stage: "lane",
				outcome: "failed",
				reason: "lane-unavailable",
			},
		])
		expect(result.metadata.outcomeStatus).toBe("failed")
	})

	it("V11/V12: disabled hybrid sub-lanes are mode-disabled rows; hybrid aggregates its sub-lanes", async () => {
		plan(["hybrid"])
		const result = await run("what did we decide", ["hybrid"])
		const rows = result.metadata.laneOutcomes ?? []
		expect(rows).toContainEqual({
			lane: "hybrid:session_chunks",
			stage: "lane",
			outcome: "not-applicable",
			reason: "mode-disabled",
		})
		expect(rows).toContainEqual({
			lane: "hybrid:memory_evidence",
			stage: "lane",
			outcome: "not-applicable",
			reason: "mode-disabled",
		})
		expect(rowsFor(rows, "hybrid")).toEqual([
			{
				lane: "hybrid",
				stage: "lane",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("V3: hybrid fails only when every launched sub-lane failed", async () => {
		plan(["hybrid"])
		vi.mocked(mongoSearch).mockRejectedValue(new Error("chunks down"))
		const result = await run("what did we decide", ["hybrid"])
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "hybrid:chunks",
			stage: "lane",
			outcome: "failed",
			reason: "internal-error",
		})
		expect(rowsFor(result.metadata.laneOutcomes, "hybrid")).toEqual([
			{
				lane: "hybrid",
				stage: "lane",
				outcome: "failed",
				reason: "internal-error",
			},
		])
		expect(result.metadata.outcomeStatus).toBe("failed")
	})

	it("V13: a failed serial conversation-evidence lane is a failed row; planned lanes stand", async () => {
		plan(["raw-window"])
		vi.mocked(searchConversationEvidenceEvents).mockRejectedValue(
			new Error("evidence down"),
		)
		const result = await run("what did we discuss", ["raw-window"], {
			conversationEvidenceMode: "serial",
		})
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "conversation-evidence",
			stage: "lane",
			outcome: "failed",
			reason: "internal-error",
		})
		expect(result.metadata.outcomeStatus).toBe("partial")
	})

	it.each([
		["parallel", "capability-absent"],
		["serial", "capability-absent"],
		["disabled", "mode-disabled"],
	] as const)("V15: conversation-evidence in %s mode without a conversation lane is %s", async (mode, reason) => {
		plan(["structured"])
		const result = await run("what did we decide", ["structured"], {
			conversationEvidenceMode: mode,
		})
		expect(
			rowsFor(result.metadata.laneOutcomes, "conversation-evidence"),
		).toEqual([
			{
				lane: "conversation-evidence",
				stage: "plan",
				outcome: "not-applicable",
				reason,
			},
		])
		expect(searchConversationEvidenceEvents).not.toHaveBeenCalled()
	})

	it("V17: the exact procedural backstop records ok-empty after a healthy zero", async () => {
		plan(["structured"])
		const result = await run("deploy runbook", ["structured", "procedural"])
		expect(findExactProcedureMatches).toHaveBeenCalledOnce()
		expect(
			rowsFor(result.metadata.laneOutcomes, "backstop:procedural-exact"),
		).toEqual([
			{
				lane: "backstop:procedural-exact",
				stage: "lane",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("V17/V18: no backstop runs after a planned lane failed", async () => {
		plan(["structured"])
		coverage({ procedural: true, hybrid: true })
		vi.mocked(searchStructuredMemory).mockRejectedValue(new Error("down"))
		const result = await run(
			"deploy runbook",
			["structured", "procedural", "hybrid"],
			{ allowHybridBackstop: true },
		)
		expect(findExactProcedureMatches).not.toHaveBeenCalled()
		expect(searchProcedures).not.toHaveBeenCalled()
		expect(mongoSearch).not.toHaveBeenCalled()
		expect(
			(result.metadata.laneOutcomes ?? []).some((row) =>
				row.lane.startsWith("backstop:"),
			),
		).toBe(false)
	})

	it("V18: the procedural backstop runs after a healthy zero and records its lane row", async () => {
		plan(["structured"])
		coverage({ procedural: true })
		const result = await run("deploy runbook", ["structured", "procedural"])
		expect(searchProcedures).toHaveBeenCalledOnce()
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "backstop:procedural",
			stage: "lane",
			outcome: "ok-empty",
			reason: "zero-hits",
			resultCount: 0,
		})
	})

	it("V19: the hybrid backstop merges the inner search's rows into the parent ledger", async () => {
		plan(["structured"])
		coverage({ hybrid: true })
		vi.mocked(planRetrieval)
			.mockReturnValueOnce({
				paths: ["structured"],
				confidence: "high",
				reasoning: "outer",
			})
			.mockReturnValueOnce({
				paths: ["hybrid"],
				confidence: "high",
				reasoning: "inner",
			})
		vi.mocked(mongoSearch).mockRejectedValue(new Error("chunks down"))
		const result = await run("what did we decide", ["structured", "hybrid"], {
			allowHybridBackstop: true,
		})
		const rows = result.metadata.laneOutcomes ?? []
		expect(rows).toContainEqual({
			lane: "hybrid:chunks",
			stage: "lane",
			outcome: "failed",
			reason: "internal-error",
		})
		expect(rowsFor(rows, "backstop:hybrid")).toEqual([
			{
				lane: "backstop:hybrid",
				stage: "lane",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
		// The backstop's inner failure makes the request partial, not failed.
		expect(result.metadata.outcomeStatus).toBe("partial")
	})

	it("V20: a failed temporal-coverage phase is a failed row; off is mode-disabled", async () => {
		plan(["structured"])
		const off = await run("what did we decide", ["structured"])
		expect(rowsFor(off.metadata.laneOutcomes, "temporal-coverage")).toEqual([
			{
				lane: "temporal-coverage",
				stage: "plan",
				outcome: "not-applicable",
				reason: "mode-disabled",
			},
		])
		vi.stubEnv("MEMONGO_TEMPORAL_COVERAGE_MODE", "enabled")
		vi.mocked(searchTemporalCoverageEvents).mockRejectedValue(new Error("down"))
		const on = await run("what did we decide", ["structured"])
		expect(rowsFor(on.metadata.laneOutcomes, "temporal-coverage")).toEqual([
			{
				lane: "temporal-coverage",
				stage: "lane",
				outcome: "failed",
				reason: "internal-error",
			},
		])
		expect(on.metadata.outcomeStatus).toBe("partial")
	})

	it("V21: turn-precision off is a mode-disabled row", async () => {
		plan(["structured"])
		const result = await run("what did we decide", ["structured"])
		expect(rowsFor(result.metadata.laneOutcomes, "turn-precision")).toEqual([
			{
				lane: "turn-precision",
				stage: "plan",
				outcome: "not-applicable",
				reason: "mode-disabled",
			},
		])
	})
})
