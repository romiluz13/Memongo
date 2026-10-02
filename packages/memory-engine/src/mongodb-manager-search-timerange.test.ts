/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
// RET-02 (wave 3b): the resolved explicit time range must survive the
// manager→V2 seam. These tests drive the REAL executor pass machinery
// (executeMongoSearchPlan) through manager.searchDetailed with a captured
// searchV2 module — the audit's mandated shape: "test via the actual
// manager callback into V2 pipeline construction, not an executePass stub
// that honors bounds by assumption."
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import type { MemorySearchResult } from "./types.js"
import {
	mocked,
	buildMockManager,
	captureManagerPrototype,
} from "./test-helpers/manager-test-kit.js"

captureManagerPrototype(MongoDBMemoryManager)

const capture = vi.hoisted(() => ({
	calls: [] as Array<{
		query: string
		agentId: string
		searchOptions: Record<string, unknown> | undefined
	}>,
}))

vi.mock("./mongodb-search-v2.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-search-v2.js")>()
	return {
		...actual,
		searchV2: vi.fn(
			async (
				_db: unknown,
				_prefix: string,
				query: string,
				agentId: string,
				context: { searchOptions?: Record<string, unknown> },
			) => {
				capture.calls.push({
					query,
					agentId,
					searchOptions: context.searchOptions,
				})
				return {
					results: captureNextResults(),
					metadata: {
						plan: { paths: [], confidence: "high", reasoning: "captured" },
						pathsExecuted: ["hybrid"],
						resultsByPath: { hybrid: 0 },
					},
				}
			},
		),
	}
})

// Scripted results per searchV2 invocation (reset per test).
const scripted: MemorySearchResult[][] = []
function captureNextResults(): MemorySearchResult[] {
	return scripted.shift() ?? []
}

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

const RANGE_START = new Date("2026-08-01T00:00:00.000Z")
const RANGE_END = new Date("2026-08-10T00:00:00.000Z")
// 9-day window: the corrective pass widens 3x around the same center.
const WIDENED_START = new Date("2026-07-23T00:00:00.000Z")
const WIDENED_END = new Date("2026-08-19T00:00:00.000Z")

const inRangeResult: MemorySearchResult = {
	path: "conversation/session-1",
	startLine: 1,
	endLine: 1,
	snippet: "deployed the payment service on Aug 5",
	score: 0.9,
	source: "conversation",
	timestamp: new Date("2026-08-05T00:00:00.000Z"),
}

const outOfRangeResult: MemorySearchResult = {
	path: "conversation/session-0",
	startLine: 1,
	endLine: 1,
	snippet: "stood up the payments prototype in July",
	score: 0.8,
	source: "conversation",
	timestamp: new Date("2026-07-20T00:00:00.000Z"),
}

describe("manager detailed search forwards the resolved time range into V2 (RET-02)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capture.calls.length = 0
		scripted.length = 0
	})

	it("carries the executor-resolved explicit bounds as first-class V2 input", async () => {
		scripted.push([inRangeResult])
		const manager = buildMockManager()

		await manager.searchDetailed({
			query: "payment service deployment notes",
			timeRange: {
				start: "2026-08-01T00:00:00.000Z",
				end: "2026-08-10T00:00:00.000Z",
			},
		})

		expect(capture.calls.length).toBeGreaterThanOrEqual(1)
		const first = capture.calls[0]
		expect(first?.agentId).toBe("agent-1")
		// The pass-level resolved range — the exact Date bounds the executor
		// derives — reaches the V2 searchOptions (was dropped at this seam
		// before RET-02: only the raw normalized form was forwarded).
		expect(first?.searchOptions?.resolvedTimeRange).toEqual({
			start: RANGE_START,
			end: RANGE_END,
		})
	})

	it("carries the widened corrective window on the corrective pass", async () => {
		// Pass 1 returns an out-of-range hit: the executor's hard-constraint
		// check rejects it ("outside requested time range"), coverage is
		// empty, and the CRAG corrective pass re-fetches with the 3x-widened
		// window. searchMode "direct" keeps the agentic follow-up planner out
		// of the way so the corrective pass is the one that consumes pass 2.
		scripted.push([outOfRangeResult])
		scripted.push([inRangeResult])
		const manager = buildMockManager()

		await manager.searchDetailed({
			query: "payment service deployment notes",
			searchMode: "direct",
			maxPasses: 2,
			timeRange: {
				start: "2026-08-01T00:00:00.000Z",
				end: "2026-08-10T00:00:00.000Z",
			},
		})

		expect(capture.calls.length).toBeGreaterThanOrEqual(2)
		expect(capture.calls[0]?.searchOptions?.resolvedTimeRange).toEqual({
			start: RANGE_START,
			end: RANGE_END,
		})
		const corrective = capture.calls
			.slice(1)
			.find((call) => call.searchOptions?.resolvedTimeRange !== undefined)
		// The corrective fetch is widened 3x around the same center — and the
		// executor still re-validates its output against the ORIGINAL
		// constraints (wave 3a), so the widening only broadens retrieval.
		expect(corrective?.searchOptions?.resolvedTimeRange).toEqual({
			start: WIDENED_START,
			end: WIDENED_END,
		})
	})

	it("omits resolvedTimeRange entirely when the request carries no range", async () => {
		scripted.push([])
		const manager = buildMockManager()

		await manager.searchDetailed({ query: "payment service notes" })

		expect(capture.calls.length).toBeGreaterThanOrEqual(1)
		expect(capture.calls[0]?.searchOptions?.resolvedTimeRange).toBeUndefined()
	})
})

vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
)
