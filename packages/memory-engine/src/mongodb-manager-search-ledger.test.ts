// #101 decision 18: the manager entry points own ONE request ledger. The
// opt-in legacy re-run of search() and searchDetailed() draws on the same
// ledger as the v2 search it double-checks, and the direct KB route
// (K12) runs inside a ledger with its lane reserved up front. searchV2 and
// the KB lane are captured; the manager seams and the ledger are real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	consumeSearchWorkOrThrow,
	getSearchBudgetSnapshot,
	hasActiveSearchBudget,
} from "./mongodb-search-budget.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"
import type { MemorySearchResult } from "./types.js"

captureManagerPrototype(MongoDBMemoryManager)

const seen = vi.hoisted(() => ({
	v2: [] as Array<{ active: boolean }>,
}))

vi.mock("./mongodb-search-v2.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-search-v2.js")>()
	return {
		...actual,
		searchV2: vi.fn(async () => {
			seen.v2.push({ active: hasActiveSearchBudget() })
			consumeSearchWorkOrThrow("vector", { aggregations: 1, embeds: 1 })
			return {
				results: [],
				metadata: {
					plan: { paths: ["hybrid"], confidence: "high", reasoning: "planned" },
					pathsExecuted: ["hybrid"],
					resultsByPath: {},
					laneOutcomes: [
						{
							lane: "hybrid",
							stage: "lane",
							outcome: "ok-empty",
							reason: "zero-hits",
							resultCount: 0,
						},
					],
					outcomeStatus: "complete",
					...(getSearchBudgetSnapshot()
						? { budget: getSearchBudgetSnapshot() }
						: {}),
				},
			}
		}),
	}
})

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)
vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)
vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)
vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)
vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)
vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)
vi.mock("./mongodb-schema.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).schemaModuleMock(),
)
vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)
vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)
vi.mock("./mongodb-reranker.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).rerankerModuleMock(),
)
vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)
vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)
vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)
vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)
vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)
vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
)
vi.mock("./mongodb-recall-traces.js", () => ({
	recordRecallTrace: vi.fn(async () => "trace"),
}))
vi.mock("./mongodb-kb-search.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-kb-search.js")>()),
	searchKB: vi.fn(),
}))

const { searchKB } = await import("./mongodb-kb-search.js")

const hit: MemorySearchResult = {
	path: "conversation/session-1",
	startLine: 1,
	endLine: 1,
	snippet: "deployed the payment service",
	score: 0.9,
	source: "conversation",
}

/** A legacy re-run that spends like a fused vector retrieval. */
function chargingLegacy(observed: Array<number | undefined>) {
	return vi.fn(async () => {
		observed.push(getSearchBudgetSnapshot()?.aggregations)
		consumeSearchWorkOrThrow("vector", { aggregations: 1, embeds: 1 })
		return [hit]
	})
}

function managerWith(
	searchBudget: { maxAggregations: number; maxEmbeds: number },
	overrides: Record<string, unknown> = {},
) {
	return buildMockManager({
		recordSearchAccess: vi.fn(),
		config: kitMongoConfig({ legacySearchFallback: true, searchBudget }),
		...overrides,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	seen.v2.length = 0
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	resetSearchAdmissionForTests(Date.now())
})

describe("search(): one ledger for the v2 search and its legacy re-run", () => {
	it("the legacy re-run draws on the ledger the v2 search spent from", async () => {
		const observed: Array<number | undefined> = []
		const legacySearch = chargingLegacy(observed)
		const onOutcomes = vi.fn()
		const results = await managerWith(
			{ maxAggregations: 12, maxEmbeds: 5 },
			{ legacySearch },
		).search("payment notes", { onOutcomes })
		expect(results).toEqual([hit])
		expect(seen.v2).toEqual([{ active: true }])
		expect(observed).toEqual([1])
		expect(onOutcomes).toHaveBeenCalledWith(
			expect.objectContaining({ status: "complete" }),
		)
	})

	it("a legacy re-run past the request caps is budget-denied, typed", async () => {
		const legacySearch = chargingLegacy([])
		const onOutcomes = vi.fn()
		const results = await managerWith(
			{ maxAggregations: 1, maxEmbeds: 5 },
			{ legacySearch },
		).search("payment notes", { onOutcomes })
		expect(results).toEqual([])
		expect(onOutcomes).toHaveBeenCalledWith({
			status: "partial",
			lanes: expect.arrayContaining([
				{
					lane: "legacy",
					stage: "vector",
					outcome: "budget-denied",
					reason: "budget-aggregations",
				},
			]),
		})
	})
})

describe("searchDetailed(): the legacy re-run shares the request ledger", () => {
	it("draws on the request ledger and the response reports the whole request", async () => {
		const observed: Array<number | undefined> = []
		const legacySearch = chargingLegacy(observed)
		const response = await managerWith(
			{ maxAggregations: 12, maxEmbeds: 5 },
			{ legacySearch },
		).searchDetailed({
			query: "payment service deployment notes",
			searchMode: "direct",
			maxPasses: 1,
		})
		expect(response.results).toEqual([hit])
		expect(observed).toEqual([1])
		expect(response.metadata.budget).toMatchObject({
			accounting: "engine-query-work",
			aggregations: 2,
			embeds: 2,
		})
	})

	it("a legacy re-run past the request caps is budget-denied, typed", async () => {
		const response = await managerWith(
			{ maxAggregations: 1, maxEmbeds: 5 },
			{ legacySearch: chargingLegacy([]) },
		).searchDetailed({
			query: "payment service deployment notes",
			searchMode: "direct",
			maxPasses: 1,
		})
		expect(response.results).toEqual([])
		expect(response.metadata.outcomeStatus).toBe("partial")
		expect(response.metadata.laneOutcomes).toContainEqual({
			lane: "legacy",
			stage: "vector",
			outcome: "budget-denied",
			reason: "budget-aggregations",
		})
		expect(response.metadata.budget).toMatchObject({
			aggregations: 1,
			embeds: 1,
		})
	})
})

describe("searchKB() (K12): the direct KB route runs on a request ledger", () => {
	const fusedCapabilities = {
		vectorSearch: true,
		textSearch: true,
		rankFusion: true,
		scoreFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
	}

	it("runs the KB lane inside a ledger with the default caps", async () => {
		const active: boolean[] = []
		vi.mocked(searchKB).mockImplementation(async () => {
			active.push(hasActiveSearchBudget())
			consumeSearchWorkOrThrow("vector", { aggregations: 1, embeds: 1 })
			return [hit]
		})
		const results = await buildMockManager({
			capabilities: fusedCapabilities,
		}).searchKB("deploy guide")
		expect(results).toEqual([hit])
		expect(active).toEqual([true])
	})

	it("reserves one aggregation and one embed for the fused lane, so a one-and-one budget runs it", async () => {
		// The old cascade reserved up to 3 aggregations and 2 embeds, which a
		// 2-aggregation budget refused as a typed reservation denial.
		const onOutcomes = vi.fn()
		const charged: Array<number | undefined> = []
		vi.mocked(searchKB).mockImplementation(async () => {
			consumeSearchWorkOrThrow("vector", { aggregations: 1, embeds: 1 })
			charged.push(getSearchBudgetSnapshot()?.aggregations)
			return [hit]
		})
		const results = await managerWith(
			{ maxAggregations: 1, maxEmbeds: 1 },
			{ capabilities: fusedCapabilities },
		).searchKB("deploy guide", { onOutcomes })
		expect(results).toEqual([hit])
		expect(charged).toEqual([1])
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "complete",
			lanes: [
				{
					lane: "kb",
					stage: "lane",
					outcome: "ok",
					resultCount: 1,
				},
			],
		})
	})
})
