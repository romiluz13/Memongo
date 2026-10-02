import type { Db } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({ emitTelemetry: vi.fn() }))
vi.mock("./mongodb-lane-coverage.js", async (original) => ({
	...(await original<typeof import("./mongodb-lane-coverage.js")>()),
	getLaneCoverage: vi.fn(),
}))
vi.mock("./mongodb-search.js", async (original) => ({
	...(await original<typeof import("./mongodb-search.js")>()),
	mongoSearch: vi.fn(),
}))
vi.mock("./mongodb-structured-memory.js", async (original) => ({
	...(await original<typeof import("./mongodb-structured-memory.js")>()),
	searchStructuredMemory: vi.fn(),
}))
vi.mock("./mongodb-procedures.js", async (original) => ({
	...(await original<typeof import("./mongodb-procedures.js")>()),
	searchProcedures: vi.fn(),
	findExactProcedureMatches: vi.fn(),
}))
import { emptyLaneCoverage, getLaneCoverage } from "./mongodb-lane-coverage.js"
import {
	planRetrieval,
	type RetrievalPath,
} from "./mongodb-retrieval-planner.js"
import { mongoSearch } from "./mongodb-search.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import {
	searchProcedures,
	findExactProcedureMatches,
} from "./mongodb-procedures.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	runWithSearchBudget,
	tryConsumeSearchAggregation,
} from "./mongodb-search-budget.js"
import { searchV2, type SearchV2Context } from "./mongodb-search-v2.js"
import type { MemorySearchResult } from "./types.js"

const query = "what do you remember about my work setup"
const allPaths = new Set<RetrievalPath>([
	"hybrid",
	"active-critical",
	"structured",
	"procedural",
	"raw-window",
	"graph",
	"kb",
	"episodic",
])
const coverage = Object.fromEntries(
	Object.keys(emptyLaneCoverage()).map((lane) => [
		lane,
		{ hasData: true, count: 1, lastUpdated: null },
	]),
)
function hit(
	path: string,
	source: MemorySearchResult["source"] = "structured",
): MemorySearchResult {
	return {
		path,
		canonicalId: path,
		source,
		score: 0.9,
		snippet: query,
		startLine: 0,
		endLine: 0,
	}
}
const normalFact = hit("structured:fact:setup")
const criticalFact = hit("structured:fact:urgent")
function context(overrides: Partial<SearchV2Context> = {}): SearchV2Context {
	return {
		availablePaths: allPaths,
		maxResults: 10,
		searchOptions: {
			conversationEvidenceMode: "disabled",
			allowHybridBackstop: false,
			capabilities: {
				vectorSearch: false,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
		},
		...overrides,
	}
}
function search(overrides: Partial<SearchV2Context> = {}) {
	return searchV2(
		{ collection: vi.fn(() => ({})) } as unknown as Db,
		"test_",
		query,
		"agent-1",
		context(overrides),
	)
}
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_SESSION_EVIDENCE_MODE", "disabled")
	vi.stubEnv("MEMONGO_EVIDENCE_MIRROR_MODE", "false")
	resetSearchAdmissionForTests(Date.now())
	vi.mocked(getLaneCoverage).mockResolvedValue({
		agentId: "agent-1",
		lanes: coverage,
		updatedAt: new Date(),
	})
	vi.mocked(mongoSearch).mockImplementation(async () => {
		return tryConsumeSearchAggregation()
			? [hit("events:irrelevant", "conversation")]
			: []
	})
	vi.mocked(searchStructuredMemory).mockImplementation(
		async (_collection, _query, _vector, opts) => {
			if (!tryConsumeSearchAggregation()) return []
			return opts.filter?.salience ? [criticalFact] : [normalFact]
		},
	)
	vi.mocked(searchProcedures).mockImplementation(async () => {
		tryConsumeSearchAggregation()
		return []
	})
	vi.mocked(findExactProcedureMatches).mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

it("puts ordinary structured facts inside the default three lanes", () => {
	const plan = planRetrieval(query, {
		availablePaths: allPaths,
		laneCoverage: coverage,
	})
	expect(plan.paths.slice(0, 3)).toEqual([
		"hybrid",
		"active-critical",
		"structured",
	])
	expect(plan.constraints).toBeUndefined()
	expect(plan.reasoning).toBe("no strong signals, defaulting to hybrid")
})
it("returns a normal fact while preserving the dedicated high-salience filter", async () => {
	const result = await search()
	expect(result.metadata.pathsExecuted).toEqual(
		expect.arrayContaining(["hybrid", "active-critical", "structured"]),
	)
	expect(result.results.map((item) => item.canonicalId)).toContain(
		normalFact.canonicalId,
	)
	expect(result.results.map((item) => item.canonicalId)).toContain(
		criticalFact.canonicalId,
	)
	const filters = vi
		.mocked(searchStructuredMemory)
		.mock.calls.map((call) => call[3].filter)
	expect(filters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				state: "active",
				salience: ["critical", "high"],
			}),
			expect.objectContaining({
				currentOnly: true,
				agentId: "agent-1",
				scopeRef: "agent:agent-1",
			}),
		]),
	)
	expect(filters.some((filter) => filter?.salience === undefined)).toBe(true)
})
it("retains exact procedures when they are outside the primary lanes", async () => {
	const procedure = hit("procedure:setup")
	vi.mocked(findExactProcedureMatches).mockResolvedValue([procedure])
	const result = await search()
	expect(result.metadata.plan.paths.slice(0, 3)).not.toContain("procedural")
	expect(findExactProcedureMatches).toHaveBeenCalledOnce()
	expect(result.results.map((item) => item.canonicalId)).toContain(
		procedure.canonicalId,
	)
})
it("retains the sparse semantic procedure backstop", async () => {
	vi.mocked(mongoSearch).mockResolvedValue([])
	vi.mocked(searchStructuredMemory).mockResolvedValue([])
	const procedure = hit("procedure:setup")
	vi.mocked(searchProcedures).mockResolvedValue([procedure])
	const result = await search()
	expect(result.metadata.plan.paths.slice(0, 3)).not.toContain("procedural")
	expect(searchProcedures).toHaveBeenCalledOnce()
	expect(result.results.map((item) => item.canonicalId)).toContain(
		procedure.canonicalId,
	)
})
it("keeps three admitted primary reads when rich results suppress the semantic backstop", async () => {
	vi.mocked(mongoSearch).mockImplementation(async () => {
		return tryConsumeSearchAggregation()
			? [hit("events:one", "conversation"), hit("events:two", "conversation")]
			: []
	})
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 3, maxEmbeds: 0 },
		() => search(),
	)
	expect(value.metadata.pathsExecuted).toEqual([
		"hybrid",
		"active-critical",
		"structured",
	])
	expect(budget.aggregations).toBe(3)
	expect(budget.embeds).toBe(0)
	expect(searchProcedures).not.toHaveBeenCalled()
})
it("respects shared exhaustion instead of adding a new allowance", async () => {
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 0, maxEmbeds: 0 },
		() => search(),
	)
	expect(value.results).toEqual([])
	expect(budget.aggregations).toBe(0)
	expect(budget.embeds).toBe(0)
})
it.each([
	false,
	true,
])("skips structured when unavailable or empty (coverage empty=%s)", async (empty) => {
	if (empty)
		vi.mocked(getLaneCoverage).mockResolvedValue({
			agentId: "agent-1",
			lanes: {
				...coverage,
				structured: { hasData: false, count: 0, lastUpdated: null },
			},
			updatedAt: new Date(),
		})
	const result = await search(
		empty
			? {}
			: {
					availablePaths: new Set(
						[...allPaths].filter((path) => path !== "structured"),
					),
				},
	)
	expect(result.metadata.pathsExecuted).not.toContain("structured")
	expect(result.metadata.pathsExecuted).toContain("procedural")
})
it.each([
	["runbook", "procedural"],
	["my preference", "structured"],
	["what matters now", "active-critical"],
] as const)("keeps the signaled first lane for %s", (text, first) => {
	expect(
		planRetrieval(text, { availablePaths: allPaths, laneCoverage: coverage })
			.paths[0],
	).toBe(first)
})
it("keeps explicit procedural scope first", () => {
	expect(
		planRetrieval(query, {
			availablePaths: allPaths,
			laneCoverage: coverage,
			intent: { proceduralScope: { state: "active" } },
		}).paths[0],
	).toBe("procedural")
})
it("keeps family breadth and explicitly includes facts after critical signals", () => {
	expect(
		new Set(
			planRetrieval("which tools", { availablePaths: allPaths }).paths.slice(
				0,
				3,
			),
		),
	).toEqual(new Set(["hybrid", "structured", "procedural"]))
	expect(
		planRetrieval("what matters now", { availablePaths: allPaths }).paths.slice(
			0,
			3,
		),
	).toEqual(["active-critical", "hybrid", "structured"])
})
