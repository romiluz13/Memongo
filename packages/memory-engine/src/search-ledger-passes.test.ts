// #101 decision 18, the 1204 E scenario at the request seam: pass 1, the
// exact-evidence follow-up and the corrective pass share ONE request ledger
// (the searchDetailed composition: one budget around the real executor,
// whose passes call the real searchV2). Lanes are mocked and charge the real
// ledger what their real counterparts charge on these capabilities.
//
// Before the ledger, the corrective pass re-ran every lane of pass 1 and its
// required lanes were starved of embeds. Now pass 1's required lanes spend
// the whole embed cap, the follow-up's and the corrective's required lanes
// are equivalent retrievals and are reused, and the corrective pass's
// optional hybrid backstop (new work) is the work that is denied.
import type { Db } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

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
	kbCollection: vi.fn(() => ({})),
	kbChunksCollection: vi.fn(() => ({})),
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
vi.mock("./mongodb-events.js", async (original) => ({
	...(await original<typeof import("./mongodb-events.js")>()),
	getEventsByTimeRange: vi.fn(async () => []),
}))
vi.mock("./mongodb-graph.js", async (original) => ({
	...(await original<typeof import("./mongodb-graph.js")>()),
	searchEntitiesAutocomplete: vi.fn(async () => []),
	expandGraph: vi.fn(async () => null),
}))
vi.mock("./mongodb-search.js", async (original) => ({
	...(await original<typeof import("./mongodb-search.js")>()),
	mongoSearch: vi.fn(),
}))
vi.mock("./mongodb-search-lanes.js", async (original) => ({
	...(await original<typeof import("./mongodb-search-lanes.js")>()),
	searchConversationEvidenceEvents: vi.fn(),
}))

import { searchKB } from "./mongodb-kb-search.js"
import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import { searchProcedures } from "./mongodb-procedures.js"
import {
	planRetrieval,
	type RetrievalPath,
} from "./mongodb-retrieval-planner.js"
import { mongoSearch } from "./mongodb-search.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	consumeSearchWorkOrThrow,
	DEFAULT_SEARCH_BUDGET,
	runWithSearchBudget,
	type SearchWorkCost,
} from "./mongodb-search-budget.js"
import { executeMongoSearchPlan } from "./mongodb-search-executor.js"
import { searchConversationEvidenceEvents } from "./mongodb-search-lanes.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import type { MemorySearchResult } from "./types.js"

const db = {} as Db
// Vector and text, merged in JS (each fused retrieval is a vector and a text
// aggregate); only procedures_text is a queryable $search tier, so
// structured and active-critical stop at their vector tier.
const capabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: true,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
	queryableSearchIndexes: ["test_procedures_text"],
}
const VECTOR = { aggregations: 1, embeds: 1 }
const TEXT = { aggregations: 1, embeds: 0 }
const calls: string[] = []
const PLANNER_ORDER: RetrievalPath[] = [
	"active-critical",
	"structured",
	"kb",
	"procedural",
	"raw-window",
	"graph",
	"hybrid",
]

/** A derived (non-exact) hit, so exact evidence rejects it and passes go on. */
function derivedHit(lane: string): MemorySearchResult {
	return {
		path: `${lane}:summary`,
		canonicalId: `${lane}:summary`,
		startLine: 0,
		endLine: 0,
		snippet: "a summary of the deploy runbook",
		score: 0.7,
		source: "structured",
		derivation: "derived",
	}
}

function charging(lane: string, tiers: SearchWorkCost[]) {
	return async () => {
		calls.push(lane)
		for (const tier of tiers) {
			await Promise.resolve()
			consumeSearchWorkOrThrow("vector", tier)
		}
		return [derivedHit(lane)]
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	calls.length = 0
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_EVIDENCE_MIRROR_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())

	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.mocked(getLaneCoverage).mockResolvedValue({
		agentId: "agent-1",
		updatedAt: new Date(),
		lanes: { hybrid: { hasData: true, count: 1, lastUpdated: new Date() } },
	} as never)
	// The planner ranks the offered paths and searchV2 runs the top three:
	// pass 1 and the corrective pass get active-critical, structured and kb;
	// the exact-evidence follow-up gets procedural and the conversation lanes.
	vi.mocked(planRetrieval).mockImplementation((_query, options) => ({
		paths: PLANNER_ORDER.filter((path) => options.availablePaths.has(path)),
		confidence: "high",
		reasoning: "1204 E fixture",
	}))
	vi.mocked(searchStructuredMemory).mockImplementation(async (...args) =>
		charging(args[3].filter?.salience ? "active-critical" : "structured", [
			VECTOR,
		])(),
	)
	vi.mocked(searchProcedures).mockImplementation(
		charging("procedural", [VECTOR, TEXT]),
	)
	vi.mocked(searchKB).mockImplementation(charging("kb", [VECTOR, TEXT]))
	vi.mocked(mongoSearch).mockImplementation(charging("hybrid", [VECTOR, TEXT]))
	vi.mocked(searchConversationEvidenceEvents).mockImplementation(
		async (params) => {
			calls.push("conversation-evidence")
			for (const tier of [VECTOR, TEXT]) {
				await Promise.resolve()
				if (!params.budgetReservation?.tryConsumeWork(tier)) {
					consumeSearchWorkOrThrow("turn-vector", tier)
				}
			}
			return []
		},
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

it("1204 E: three passes on one ledger run every required lane and deny the optional backstop", async () => {
	const { value: response, budget } = await runWithSearchBudget(
		DEFAULT_SEARCH_BUDGET,
		() =>
			executeMongoSearchPlan({
				request: {
					query: "what did I say about the deploy runbook",
					searchMode: "agentic",
					needExactEvidence: true,
					maxPasses: 3,
				},
				// No hybrid path on the deployment: only the corrective
				// hybrid-evidence-relaxed pass adds it, so its backstop is the
				// one retrieval the request has not already completed.
				availablePaths: new Set([
					"active-critical",
					"structured",
					"procedural",
					"kb",
					"raw-window",
					"graph",
				]),
				executePass: ({ query, availablePaths }) =>
					searchV2(db, "test_", query, "agent-1", {
						availablePaths,
						maxResults: 20,
						searchOptions: {
							capabilities,
							fusionMethod: "js-merge",
							embeddingMode: "automated",
							conversationEvidenceMode: "parallel",
							needExactEvidence: true,
							allowHybridBackstop: true,
						},
					}),
			}),
	)
	const rows = response.metadata.laneOutcomes ?? []
	const required: Record<number, string[]> = {
		0: ["active-critical", "structured", "kb", "conversation-evidence"],
		1: ["procedural", "raw-window", "graph", "conversation-evidence"],
		2: ["active-critical", "structured", "kb", "conversation-evidence"],
	}
	expect(response.metadata.passes.map((pass) => pass.reason)).toEqual([
		"original query",
		"exact-evidence follow-up",
		"corrective: hybrid-evidence-relaxed",
	])
	// Every required lane of every pass ran (or was reused) successfully,
	// and none was budget-denied anywhere in the request.
	for (const [pass, lanes] of Object.entries(required)) {
		for (const lane of lanes) {
			expect(rows).toContainEqual(
				expect.objectContaining({
					lane,
					stage: "lane",
					outcome: expect.stringMatching(/^ok/),
					pass: Number(pass),
				}),
			)
			expect(rows).not.toContainEqual(
				expect.objectContaining({
					lane,
					outcome: "budget-denied",
					pass: Number(pass),
				}),
			)
		}
	}
	// Each charged retrieval executed once in the whole request: the
	// follow-up's evidence and the corrective's lanes were equivalent.
	expect(calls.sort()).toEqual(
		[
			"active-critical",
			"conversation-evidence",
			"kb",
			"procedural",
			"structured",
		].sort(),
	)
	// The corrective pass's optional hybrid backstop is new work, and the
	// required lanes of the first two passes hold every embed: its retrieval is denied, typed, and
	// never reaches the database.
	expect(rows).toContainEqual({
		lane: "hybrid",
		stage: "reservation",
		outcome: "budget-denied",
		reason: "budget-reservation",
		pass: 2,
	})
	expect(mongoSearch).not.toHaveBeenCalled()
	expect(budget).toMatchObject({
		accounting: "engine-query-work",
		aggregations: 8,
		embeds: 5,
	})
	expect(budget.equivalentSkips).toBeGreaterThanOrEqual(6)
	expect(budget.aggregations).toBeLessThanOrEqual(12)
})
