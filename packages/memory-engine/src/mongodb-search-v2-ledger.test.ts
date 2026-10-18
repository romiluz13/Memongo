// #101 decision 18 at the searchV2 seam: a fake-budget request with mocked
// lanes goes in; lane order, reservations, outcomes and ledger counts come
// out. The mocked lanes charge the real ledger exactly what the cost table
// says their real counterparts charge on zero hits.
import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
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
	kbChunksCollection: vi.fn(() => ({})),
	kbCollection: vi.fn(() => ({})),
}))
vi.mock("./mongodb-structured-memory.js", async (original) => ({
	...(await original<typeof import("./mongodb-structured-memory.js")>()),
	searchStructuredMemory: vi.fn(),
}))
vi.mock("./mongodb-procedures.js", async (original) => ({
	...(await original<typeof import("./mongodb-procedures.js")>()),
	findExactProcedureMatches: vi.fn(async () => []),
	searchProcedures: vi.fn(),
}))
vi.mock("./mongodb-kb-search.js", async (original) => ({
	...(await original<typeof import("./mongodb-kb-search.js")>()),
	searchKB: vi.fn(),
}))
vi.mock("./mongodb-search.js", async (original) => ({
	...(await original<typeof import("./mongodb-search.js")>()),
	mongoSearch: vi.fn(),
	vectorSearch: vi.fn(),
}))
vi.mock("./mongodb-search-lanes.js", async (original) => ({
	...(await original<typeof import("./mongodb-search-lanes.js")>()),
	searchConversationEvidenceEvents: vi.fn(),
}))

import { searchKB } from "./mongodb-kb-search.js"
import { searchProcedures } from "./mongodb-procedures.js"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	consumeSearchWorkOrThrow,
	DEFAULT_SEARCH_BUDGET,
	runWithSearchBudget,
	type SearchWorkCost,
	tryConsumeSearchWork,
} from "./mongodb-search-budget.js"
import { searchConversationEvidenceEvents } from "./mongodb-search-lanes.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import type { SearchLaneOutcome } from "./search-outcomes.js"
import type { MemorySearchResult } from "./types.js"

const db = {} as Db
const capabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: true,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
	queryableSearchIndexes: ["test_structured_mem_text", "test_procedures_text"],
}
const VECTOR = { aggregations: 1, embeds: 1 }
const TEXT = { aggregations: 1, embeds: 0 }
// The cost table for these capabilities (search-lane-cost.test.ts proves
// each real lane charges exactly this on zero hits).
const STRUCTURED_TIERS = [VECTOR, TEXT]
const KB_TIERS = [VECTOR, VECTOR, VECTOR, TEXT]
const EVIDENCE_TIERS = [VECTOR, TEXT]

const order: string[] = []

/** A mocked lane that charges its tiers in turn, yielding between them. */
function charging(
	lane: string,
	tiers: SearchWorkCost[],
	results: MemorySearchResult[] = [],
) {
	return async () => {
		order.push(`start:${lane}`)
		for (const tier of tiers) {
			await Promise.resolve()
			consumeSearchWorkOrThrow("vector", tier)
		}
		order.push(`end:${lane}`)
		return results.map((result) => ({ ...result }))
	}
}

function plan(paths: RetrievalPath[]) {
	vi.mocked(planRetrieval).mockReturnValue({
		paths,
		confidence: "high",
		reasoning: "owned fixture",
	})
}

function rowsFor(rows: SearchLaneOutcome[] | undefined, lane: string) {
	return (rows ?? []).filter((row) => row.lane === lane)
}

function run(
	query: string,
	paths: RetrievalPath[],
	searchOptions: Record<string, unknown> = {},
) {
	return searchV2(db, "test_", query, "agent-1", {
		availablePaths: new Set(paths),
		searchOptions: {
			allowHybridBackstop: false,
			capabilities,
			fusionMethod: "scoreFusion",
			embeddingMode: "automated",
			conversationEvidenceMode: "disabled",
			...searchOptions,
		},
	})
}

const decision: MemorySearchResult = {
	path: "structured:decision-1",
	startLine: 0,
	endLine: 0,
	snippet: "we chose the blue plan",
	score: 0.8,
	source: "structured",
}

beforeEach(() => {
	vi.clearAllMocks()
	order.length = 0
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_EVIDENCE_MIRROR_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.mocked(searchStructuredMemory).mockImplementation(
		charging("structured", STRUCTURED_TIERS),
	)
	vi.mocked(searchProcedures).mockImplementation(
		charging("procedural", STRUCTURED_TIERS),
	)
	vi.mocked(searchKB).mockImplementation(charging("kb", KB_TIERS))
	vi.mocked(searchConversationEvidenceEvents).mockImplementation(
		async (params) => {
			order.push("start:conversation-evidence")
			for (const tier of EVIDENCE_TIERS) {
				await Promise.resolve()
				if (!params.budgetReservation?.tryConsumeWork(tier)) {
					consumeSearchWorkOrThrow("turn-vector", tier)
				}
			}
			order.push("end:conversation-evidence")
			return []
		},
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("searchV2 request ledger (#101 decision 18)", () => {
	it("keeps today's caps: 12 aggregations and 5 embeds", () => {
		expect(DEFAULT_SEARCH_BUDGET).toEqual({ maxAggregations: 12, maxEmbeds: 5 })
	})

	it("reserves concurrent required paths first; optional evidence never pre-empts them", async () => {
		plan(["kb", "structured", "procedural"])
		const result = await run(
			"what did I say about the deploy runbook",
			["kb", "structured", "procedural", "hybrid"],
			{ conversationEvidenceMode: "parallel" },
		)
		const rows = result.metadata.laneOutcomes ?? []
		for (const lane of ["kb", "structured", "procedural"]) {
			expect(rowsFor(rows, lane)).toContainEqual(
				expect.objectContaining({ lane, stage: "lane", outcome: "ok-empty" }),
			)
		}
		// The optional evidence phase gets only the unreserved remainder:
		// nothing, so it is a typed reservation denial and never runs.
		expect(rowsFor(rows, "conversation-evidence")).toEqual([
			{
				lane: "conversation-evidence",
				stage: "reservation",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		])
		expect(searchConversationEvidenceEvents).not.toHaveBeenCalled()
		expect(result.metadata.outcomeStatus).toBe("partial")
		expect(result.metadata.budget).toMatchObject({
			aggregations: 8,
			embeds: 5,
		})
	})

	it("required exact evidence is reserved with the paths and runs", async () => {
		plan(["structured", "procedural"])
		const result = await run(
			"what did I say about the deploy runbook",
			["structured", "procedural", "hybrid"],
			{ conversationEvidenceMode: "parallel", needExactEvidence: true },
		)
		expect(
			rowsFor(result.metadata.laneOutcomes, "conversation-evidence"),
		).toContainEqual(
			expect.objectContaining({ stage: "lane", outcome: "ok-empty" }),
		)
		expect(result.metadata.outcomeStatus).toBe("complete")
		expect(result.metadata.budget).toMatchObject({
			aggregations: 6,
			embeds: 3,
		})
	})

	it("an unschedulable required lane is a typed reservation denial, never spent and never run", async () => {
		plan(["structured", "procedural"])
		const { value: result, budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				// Earlier passes of this request spent four of the five embeds.
				tryConsumeSearchWork({ aggregations: 4, embeds: 4 })
				return run("what did we decide", ["structured", "procedural"])
			},
		)
		expect(rowsFor(result.metadata.laneOutcomes, "procedural")).toEqual([
			{
				lane: "procedural",
				stage: "reservation",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		])
		expect(order).toEqual(["start:structured", "end:structured"])
		expect(result.metadata.outcomeStatus).toBe("partial")
		expect(budget).toMatchObject({ aggregations: 6, embeds: 5 })
	})

	it("when no required lane can be scheduled the request fails typed, not empty", async () => {
		plan(["structured", "procedural"])
		const { value: result, budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				tryConsumeSearchWork({ aggregations: 3, embeds: 5 })
				return run("what did we decide", ["structured", "procedural"])
			},
		)
		expect(result.results).toEqual([])
		expect(result.metadata.outcomeStatus).toBe("failed")
		for (const lane of ["structured", "procedural"]) {
			expect(rowsFor(result.metadata.laneOutcomes, lane)).toEqual([
				{
					lane,
					stage: "reservation",
					outcome: "budget-denied",
					reason: "budget-reservation",
				},
			])
		}
		expect(order).toEqual([])
		expect(budget).toMatchObject({ aggregations: 3, embeds: 5 })
	})

	it("skips an equivalent completed retrieval and reuses its results", async () => {
		plan(["structured"])
		vi.mocked(searchStructuredMemory).mockImplementation(
			charging("structured", STRUCTURED_TIERS, [decision]),
		)
		const { value, budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				const first = await run("what did we decide", ["structured"])
				const second = await run("what did we decide", ["structured"])
				return { first, second }
			},
		)
		expect(searchStructuredMemory).toHaveBeenCalledOnce()
		expect(value.second.results.map((result) => result.path)).toEqual([
			decision.path,
		])
		expect(rowsFor(value.second.metadata.laneOutcomes, "structured")).toEqual([
			{ lane: "structured", stage: "lane", outcome: "ok", resultCount: 1 },
		])
		expect(budget).toMatchObject({
			aggregations: 2,
			embeds: 1,
			equivalentSkips: 1,
		})
	})

	it("keys the resolved result limit, so an omitted limit equals its default", async () => {
		plan(["structured"])
		const { budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				await run("what did we decide", ["structured"])
				await searchV2(db, "test_", "what did we decide", "agent-1", {
					availablePaths: new Set(["structured"]),
					maxResults: 20,
					searchOptions: {
						allowHybridBackstop: false,
						capabilities,
						fusionMethod: "scoreFusion",
						embeddingMode: "automated",
						conversationEvidenceMode: "disabled",
					},
				})
			},
		)
		expect(searchStructuredMemory).toHaveBeenCalledOnce()
		expect(budget).toMatchObject({ equivalentSkips: 1 })
	})

	it.each([
		[
			"a different time range",
			{
				timeRange: {
					start: "2026-08-01T00:00:00.000Z",
					end: "2026-08-10T00:00:00.000Z",
				},
			},
		],
		["a different hard constraint", { structuredScope: { type: "decision" } }],
		["a different scope", { scope: "user", scopeRef: "user:u-1" }],
	])("runs a same-named retrieval with %s", async (_label, change) => {
		plan(["structured"])
		const { budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				await run("what did we decide", ["structured"])
				await run("what did we decide", ["structured"], change)
			},
		)
		expect(searchStructuredMemory).toHaveBeenCalledTimes(2)
		expect(budget).toMatchObject({
			aggregations: 4,
			embeds: 2,
			equivalentSkips: 0,
		})
	})

	it("never treats a failed retrieval as completed", async () => {
		plan(["structured"])
		vi.mocked(searchStructuredMemory)
			.mockRejectedValueOnce(new Error("down"))
			.mockImplementation(charging("structured", STRUCTURED_TIERS))
		const { budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				await run("what did we decide", ["structured"])
				await run("what did we decide", ["structured"])
			},
		)
		expect(searchStructuredMemory).toHaveBeenCalledTimes(2)
		expect(budget).toMatchObject({ equivalentSkips: 0 })
	})
})
