/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
// RET-16: searchDetailed owns the REQUEST-level search budget. These tests
// drive the REAL executor pass machinery (executeMongoSearchPlan) through
// manager.searchDetailed with a captured searchV2 mock that records whether
// a budget is active on every pass — the request boundary is observable only
// from inside the per-pass callback.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	hasActiveSearchBudget,
	tryConsumeSearchAggregation,
} from "./mongodb-search-budget.js"
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
		budgetActive: boolean
		aggregationGranted: boolean
	}>,
	// Per-test metadata override for the searchV2 response.
	metadataOverride: null as Record<string, unknown> | null,
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
				_agentId: string,
				_context: unknown,
			) => {
				// Observed from inside the pass: under the RET-16 wrapper the
				// request budget must be active on EVERY pass, and a consume
				// from inside the pass draws on the REQUEST ledger.
				const budgetActive = hasActiveSearchBudget()
				const aggregationGranted = tryConsumeSearchAggregation()
				capture.calls.push({ query, budgetActive, aggregationGranted })
				const results = captureNextResults()
				return {
					results,
					metadata: {
						plan: { paths: [], confidence: "high", reasoning: "captured" },
						pathsExecuted: ["hybrid"],
						resultsByPath: {},
						...capture.metadataOverride,
						// One lane outcome per pass lets the RET-13 merge
						// seam be observed across passes: the response
						// metadata must carry every pass's entries.
						laneOutcomes: [
							{
								lane: `captured:call-${capture.calls.length - 1}`,
								status: "ok",
								resultCount: results.length,
							},
						],
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

describe("searchDetailed request budget boundary (RET-16)", () => {
	const originalRpm = process.env.MEMONGO_SEARCH_ADMISSION_RPM

	/** Two-pass detailed search: pass 1 hits outside the hard range and the
	 * executor runs the corrective pass (same shape as the RET-02 suite). */
	async function runTwoPassSearch(): Promise<
		Awaited<ReturnType<MongoDBMemoryManager["searchDetailed"]>>
	> {
		scripted.push([outOfRangeResult])
		scripted.push([inRangeResult])
		const base = buildMockManager()
		const baseCfg = (
			base as unknown as { config: { mongodb: Record<string, unknown> } }
		).config.mongodb
		const manager = buildMockManager({
			config: {
				mongodb: {
					...baseCfg,
					// A tight, distinctive ledger so the request snapshot is
					// attributable to the wrapper, not per-pass defaults.
					searchBudget: { maxAggregations: 5, maxEmbeds: 5 },
				},
			},
		})
		return manager.searchDetailed({
			query: "payment service deployment notes",
			searchMode: "direct",
			maxPasses: 2,
			timeRange: {
				start: "2026-08-01T00:00:00.000Z",
				end: "2026-08-10T00:00:00.000Z",
			},
		})
	}

	beforeEach(() => {
		vi.clearAllMocks()
		capture.calls.length = 0
		capture.metadataOverride = null
		scripted.length = 0
		// RPM=1 makes the refill rate ~0 for the test duration (mirrors the
		// WS-11 envelope suite).
		process.env.MEMONGO_SEARCH_ADMISSION_RPM = "1"
		resetSearchAdmissionForTests(Date.now())
	})

	afterEach(() => {
		if (originalRpm === undefined) {
			delete process.env.MEMONGO_SEARCH_ADMISSION_RPM
		} else {
			process.env.MEMONGO_SEARCH_ADMISSION_RPM = originalRpm
		}
		// Re-fill the bucket for whatever describe runs next in this worker.
		resetSearchAdmissionForTests(Date.now())
	})

	it("one request budget spans every pass and lands on the response metadata", async () => {
		const response = await runTwoPassSearch()

		// The corrective pass really ran — the boundary claim is about
		// multi-pass requests, not a single pass.
		expect(capture.calls.length).toBeGreaterThanOrEqual(2)
		// EVERY pass (including the corrective one) ran inside the shared
		// request budget, and every pass drew on the SAME ledger.
		for (const call of capture.calls) {
			expect(call.budgetActive).toBe(true)
			expect(call.aggregationGranted).toBe(true)
		}
		expect(response.metadata.throttled).toBeUndefined()
		// The request-level snapshot: the wrapper's limits (5/5, from the
		// config surface) plus consumption totals across ALL passes (one
		// mock consume per pass).
		expect(response.metadata.budget).toEqual({
			maxAggregations: 5,
			maxEmbeds: 5,
			aggregations: capture.calls.length,
			embeds: 0,
			exhausted: false,
		})
		// RET-13 merge seam: every pass's lane outcome survives into the
		// response metadata, in attempt order.
		expect(response.metadata.laneOutcomes).toEqual(
			capture.calls.map((_, index) => ({
				lane: `captured:call-${index}`,
				status: "ok",
				resultCount: expect.any(Number),
			})),
		)
	})

	it("one admission token admits the whole multi-pass request", async () => {
		// Pin the burst at 2: the first two-pass request must spend exactly
		// ONE token at the boundary (per-pass admission would spend two and
		// starve the second request below), and the second request takes
		// the last token.
		const originalBurst = process.env.MEMONGO_SEARCH_ADMISSION_BURST
		process.env.MEMONGO_SEARCH_ADMISSION_BURST = "2"
		try {
			resetSearchAdmissionForTests(Date.now())

			const first = await runTwoPassSearch()
			expect(first.metadata.throttled).toBeUndefined()
			expect(capture.calls.length).toBeGreaterThanOrEqual(2)

			const passesInFirstRequest = capture.calls.length
			const second = await runTwoPassSearch()
			expect(second.metadata.throttled).toBeUndefined()
			expect(capture.calls.length).toBe(passesInFirstRequest * 2)

			// The bucket is now dry: a third request is throttled at the
			// boundary without running any pass.
			const third = await runTwoPassSearch()
			expect(third.results).toEqual([])
			expect(third.metadata.throttled).toBeDefined()
			expect(capture.calls.length).toBe(passesInFirstRequest * 2)
		} finally {
			if (originalBurst === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_BURST = originalBurst
			}
		}
	})

	it("exhausts the shared ledger across passes, not per pass", async () => {
		// maxAggregations 1 with a consume-per-pass mock: pass 1 draws the
		// only aggregation, the corrective pass is refused by the REQUEST
		// ledger (budget-denied degrade, empty ≠ error) — no fresh per-pass
		// budget resets the counter.
		scripted.push([outOfRangeResult])
		scripted.push([inRangeResult])
		const base = buildMockManager()
		const baseCfg = (
			base as unknown as { config: { mongodb: Record<string, unknown> } }
		).config.mongodb
		const manager = buildMockManager({
			config: {
				mongodb: {
					...baseCfg,
					searchBudget: { maxAggregations: 1, maxEmbeds: 5 },
				},
			},
		})

		const response = await manager.searchDetailed({
			query: "payment service deployment notes",
			searchMode: "direct",
			maxPasses: 2,
			timeRange: {
				start: "2026-08-01T00:00:00.000Z",
				end: "2026-08-10T00:00:00.000Z",
			},
		})

		expect(capture.calls.length).toBeGreaterThanOrEqual(1)
		expect(capture.calls[0]?.aggregationGranted).toBe(true)
		for (const call of capture.calls.slice(1)) {
			expect(call.aggregationGranted).toBe(false)
		}
		expect(response.metadata.budget?.exhausted).toBe(true)
		expect(response.metadata.budget?.aggregations).toBe(1)
	})
})

vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
)
