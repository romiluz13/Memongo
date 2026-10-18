// #101 section 1g: the manager's per-call outcome sinks (onOutcomes on
// search and searchKB), the complete-only legacy re-run, and the typed
// request failure. searchV2 is captured; the manager seams are real.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { chunksCollection } from "./mongodb-schema.js"
import type { MemorySearchResult } from "./types.js"
import {
	SearchLaneError,
	type SearchLaneOutcome,
	type SearchOutcomeStatus,
	type SearchOutcomeSummary,
} from "./search-outcomes.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

captureManagerPrototype(MongoDBMemoryManager)

const searchV2State = vi.hoisted(() => ({
	responses: [] as Array<
		{ results: MemorySearchResult[]; metadata: Record<string, unknown> } | Error
	>,
}))

vi.mock("./mongodb-search-v2.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-search-v2.js")>()
	return {
		...actual,
		searchV2: vi.fn(async () => {
			const next = searchV2State.responses.shift()
			if (next instanceof Error) {
				throw next
			}
			// The default carries a valid plan shape: the real executor
			// (executeMongoSearchPlan) reads metadata.plan.paths on every
			// pass, including unplanned corrective passes.
			return (
				next ?? {
					results: [],
					metadata: {
						plan: { paths: [], confidence: "high", reasoning: "captured" },
						pathsExecuted: [],
						resultsByPath: {},
					},
				}
			)
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

const v2Hit: MemorySearchResult = {
	path: "conversation/session-1",
	startLine: 1,
	endLine: 1,
	snippet: "deployed the payment service",
	score: 0.9,
	source: "conversation",
	timestamp: new Date("2026-08-05T00:00:00.000Z"),
}

const completeEmptyRows: SearchLaneOutcome[] = [
	{
		lane: "hybrid",
		stage: "lane",
		outcome: "ok-empty",
		reason: "zero-hits",
		resultCount: 0,
	},
]

function v2Response(
	outcomeStatus: SearchOutcomeStatus,
	laneOutcomes: SearchLaneOutcome[] = completeEmptyRows,
	extra: Record<string, unknown> = {},
) {
	return {
		results: [] as MemorySearchResult[],
		metadata: {
			plan: { paths: ["hybrid"], confidence: "high", reasoning: "planned" },
			pathsExecuted: ["hybrid"],
			resultsByPath: {},
			laneOutcomes,
			outcomeStatus,
			...extra,
		},
	}
}

function managerWithLegacy(legacySearch: ReturnType<typeof vi.fn>) {
	return buildMockManager({
		recordSearchAccess: vi.fn(),
		config: kitMongoConfig({ legacySearchFallback: true }),
		legacySearch,
	})
}

describe("manager search outcome sink (#101 section 1g)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		searchV2State.responses.length = 0
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("M1: an empty query fires one complete not-applicable summary", async () => {
		const onOutcomes = vi.fn()
		const manager = buildMockManager()
		expect(await manager.search("   ", { onOutcomes })).toEqual([])
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "complete",
			lanes: [
				{
					lane: "search",
					stage: "request",
					outcome: "not-applicable",
					reason: "empty-query",
				},
			],
		})
	})

	it("M2: a complete empty answer emits its rows through the sink once", async () => {
		searchV2State.responses.push(v2Response("complete"))
		const onOutcomes = vi.fn()
		const manager = buildMockManager({ recordSearchAccess: vi.fn() })
		expect(await manager.search("payment notes", { onOutcomes })).toEqual([])
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "complete",
			lanes: completeEmptyRows,
		})
	})

	it("R3: a throttled answer carries the degradation marker, not an outcome summary", async () => {
		searchV2State.responses.push(
			v2Response("complete", [], {
				throttled: { reason: "admission", retryAfterMs: 1000 },
			}),
		)
		const onOutcomes = vi.fn()
		const manager = buildMockManager({ recordSearchAccess: vi.fn() })
		await manager.search("payment notes", { onOutcomes })
		expect(onOutcomes).not.toHaveBeenCalled()
	})

	it("M4: the opt-in legacy re-run follows a complete empty and records its rerun row", async () => {
		searchV2State.responses.push(v2Response("complete"))
		const legacySearch = vi.fn(async () => [v2Hit])
		const onOutcomes = vi.fn()
		const results = await managerWithLegacy(legacySearch).search(
			"payment notes",
			{ onOutcomes },
		)
		expect(results).toEqual([v2Hit])
		expect(legacySearch).toHaveBeenCalledOnce()
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "complete",
			lanes: [
				...completeEmptyRows,
				{ lane: "legacy", stage: "rerun", outcome: "ok", resultCount: 1 },
			],
		})
	})

	it("M4: never re-runs legacy after a partial empty", async () => {
		const partialRows: SearchLaneOutcome[] = [
			...completeEmptyRows,
			{
				lane: "episodic",
				stage: "lane",
				outcome: "failed",
				reason: "query-error",
			},
		]
		searchV2State.responses.push(v2Response("partial", partialRows))
		const legacySearch = vi.fn(async () => [v2Hit])
		const onOutcomes = vi.fn()
		const results = await managerWithLegacy(legacySearch).search(
			"payment notes",
			{ onOutcomes },
		)
		expect(results).toEqual([])
		expect(legacySearch).not.toHaveBeenCalled()
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "partial",
			lanes: partialRows,
		})
	})

	it("M4: a failed legacy re-run keeps the v2 verdict and makes the call partial", async () => {
		searchV2State.responses.push(v2Response("complete"))
		const legacySearch = vi.fn(async () => {
			throw new Error("legacy PRIVATE down")
		})
		const onOutcomes = vi.fn()
		const results = await managerWithLegacy(legacySearch).search(
			"payment notes",
			{ onOutcomes },
		)
		expect(results).toEqual([])
		const summary = onOutcomes.mock.calls[0]?.[0] as SearchOutcomeSummary
		expect(summary.status).toBe("partial")
		expect(summary.lanes).toContainEqual({
			lane: "legacy",
			stage: "rerun",
			outcome: "failed",
			reason: "internal-error",
		})
		expect(JSON.stringify(summary)).not.toContain("PRIVATE")
	})

	it("M5/M6: a searchV2 throw rejects typed, fires a failed summary, and never runs legacy", async () => {
		searchV2State.responses.push(new Error("planner PRIVATE exploded"))
		const legacySearch = vi.fn(async () => [v2Hit])
		const onOutcomes = vi.fn()
		const failure = await managerWithLegacy(legacySearch)
			.search("payment notes", { onOutcomes })
			.catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect((failure as Error).message).not.toContain("PRIVATE")
		expect(legacySearch).not.toHaveBeenCalled()
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "failed",
			lanes: [
				{
					lane: "search",
					stage: "request",
					outcome: "failed",
					reason: "internal-error",
				},
			],
		})
	})

	it("M7: legacy KB and structured failures become value-free rows", async () => {
		vi.mocked(chunksCollection).mockReturnValue({
			aggregate: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		vi.mocked(searchKB).mockRejectedValue(new Error("kb PRIVATE down"))
		const manager = buildMockManager({
			config: kitMongoConfig({ kb: { enabled: true } }),
		})
		const rows: SearchLaneOutcome[] = []
		const legacy = (
			manager as unknown as {
				legacySearch(
					query: string,
					opts: Record<string, unknown> | undefined,
					admission: undefined,
					onOutcome: (row: SearchLaneOutcome) => void,
				): Promise<MemorySearchResult[]>
			}
		).legacySearch.bind(manager)
		expect(
			await legacy("payment notes", undefined, undefined, (row) =>
				rows.push(row),
			),
		).toEqual([])
		expect(rows).toContainEqual({
			lane: "kb",
			stage: "lane",
			outcome: "failed",
			reason: "internal-error",
		})
		// No search capability: the structured lane is unavailable, not empty.
		expect(rows).toContainEqual({
			lane: "structured",
			stage: "lane",
			outcome: "failed",
			reason: "lane-unavailable",
		})
		expect(JSON.stringify(rows)).not.toContain("PRIVATE")
	})

	it("M8: an empty legacy query is a not-applicable row", async () => {
		const rows: SearchLaneOutcome[] = []
		const manager = buildMockManager()
		const legacy = (
			manager as unknown as {
				legacySearch(
					query: string,
					opts: undefined,
					admission: undefined,
					onOutcome: (row: SearchLaneOutcome) => void,
				): Promise<MemorySearchResult[]>
			}
		).legacySearch.bind(manager)
		expect(
			await legacy(" ", undefined, undefined, (row) => rows.push(row)),
		).toEqual([])
		expect(rows).toEqual([
			{
				lane: "legacy",
				stage: "request",
				outcome: "not-applicable",
				reason: "empty-query",
			},
		])
	})

	it("M8: an empty detailed query carries a not-applicable row and complete status", async () => {
		const manager = buildMockManager()
		const response = await manager.searchDetailed({ query: "  " })
		expect(response.metadata.laneOutcomes).toEqual([
			{
				lane: "search",
				stage: "request",
				outcome: "not-applicable",
				reason: "empty-query",
			},
		])
		expect(response.metadata.outcomeStatus).toBe("complete")
	})
})

describe("direct KB search outcome collector (#101 K12)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("K12/M8: an empty KB query fires a complete not-applicable summary", async () => {
		const onOutcomes = vi.fn()
		expect(await buildMockManager().searchKB(" ", { onOutcomes })).toEqual([])
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "complete",
			lanes: [
				{
					lane: "kb",
					stage: "request",
					outcome: "not-applicable",
					reason: "empty-query",
				},
			],
		})
	})

	it("K12: tier rows and the lane row reach the sink on success", async () => {
		vi.mocked(searchKB).mockImplementation(async (_c, _q, _v, opts) => {
			opts.onTierOutcome?.({
				stage: "rank-fusion",
				outcome: "ok",
				resultCount: 1,
			})
			return [v2Hit]
		})
		const onOutcomes = vi.fn()
		const results = await buildMockManager().searchKB("deploy guide", {
			onOutcomes,
		})
		expect(results).toEqual([v2Hit])
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "complete",
			lanes: [
				{ lane: "kb", stage: "rank-fusion", outcome: "ok", resultCount: 1 },
				{ lane: "kb", stage: "lane", outcome: "ok", resultCount: 1 },
			],
		})
	})

	it("K12: a KB failure rejects typed and fires a failed summary, never a log-only empty", async () => {
		vi.mocked(searchKB).mockRejectedValue(
			new SearchLaneError({
				lane: "kb",
				stage: "keyword",
				reason: "query-error",
				cause: new Error("PRIVATE"),
			}),
		)
		const onOutcomes = vi.fn()
		const failure = await buildMockManager()
			.searchKB("deploy guide", { onOutcomes })
			.catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(onOutcomes).toHaveBeenCalledExactlyOnceWith({
			status: "failed",
			lanes: [
				{
					lane: "kb",
					stage: "keyword",
					outcome: "failed",
					reason: "query-error",
				},
			],
		})
	})
})
