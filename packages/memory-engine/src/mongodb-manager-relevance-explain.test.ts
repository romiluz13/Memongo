/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
// RET-15 (wave 3h): relevanceExplain must diagnose the pipeline that
// actually answers searches — searchV2 with the same identity, lanes, and
// options as search() — and persist one diagnostic-mode run carrying the
// real V2 metadata. These tests drive the real ops class through the
// manager facade with a captured searchV2 module, replacing the retired
// hand-rolled legacy re-implementation the audit flagged.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import type { MemorySearchResult } from "./types.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
)
const { captureAdmissionToken } = await import("./mongodb-write-fence.js")
captureManagerPrototype(MongoDBMemoryManager)

const capture = vi.hoisted(() => ({
	calls: [] as Array<{
		query: string
		agentId: string
		availablePaths: Set<string>
		searchOptions: Record<string, unknown>
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
				context: {
					availablePaths: Set<string>
					searchOptions?: Record<string, unknown>
				},
			) => {
				capture.calls.push({
					query,
					agentId,
					availablePaths: context.availablePaths,
					searchOptions: context.searchOptions ?? {},
				})
				return {
					results: captureNextResults(),
					metadata: {
						plan: {
							paths: ["hybrid"],
							confidence: "high",
							reasoning: "captured plan",
							constraints: { timeRange: true },
							skippedLanes: ["kb"],
						},
						pathsExecuted: ["hybrid"],
						resultsByPath: { hybrid: 1 },
						laneOutcomes: [{ path: "hybrid", status: "ok", results: 1 }],
						latencyByPath: { hybrid: 12 },
						reranked: true,
						queryRewritten: false,
						budget: { maxTotal: 50 },
					},
				}
			},
		),
	}
})

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

const v2Hit: MemorySearchResult = {
	path: "conversation/session-1",
	startLine: 1,
	endLine: 1,
	snippet: "deployed the payment service",
	score: 0.9,
	source: "conversation",
	timestamp: new Date("2026-08-05T00:00:00.000Z"),
}

function buildRelevanceStub() {
	return {
		shouldSample: vi.fn(() => true),
		evaluateHealth: vi.fn(() => "healthy"),
		recordSignal: vi.fn(),
		persistRun: vi.fn(
			async (_input: Record<string, unknown>) => "relevance-run-1",
		),
		getSampleState: vi.fn(() => ({ current: 0.05 })),
		logTelemetryFailure: vi.fn(),
	}
}

describe("relevanceExplain diagnoses the V2 pipeline (RET-15)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capture.calls.length = 0
		scripted.length = 0
	})

	it("preserves explained results when stale persistence rejects", async () => {
		scripted.push([v2Hit])
		const relevance = buildRelevanceStub(),
			fault = Object.assign(new Error("stale gate"), {
				code: "ERASURE_GATE_CONFLICT",
			})
		relevance.persistRun.mockRejectedValueOnce(fault)
		const manager = buildMockManager({ relevance })
		const result = await manager.relevanceExplain({
			query: "payment service notes",
		})
		expect(result.runId).toBeUndefined()
		expect(result.results[0]?.path).toBe(v2Hit.path)
		expect(relevance.logTelemetryFailure).toHaveBeenCalledWith(fault)
		expect(relevance.persistRun).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
	})
	it("rejects admission failure before executing diagnostic search", async () => {
		const fault = new Error("owned gate fault"),
			manager = buildMockManager({ relevance: buildRelevanceStub() })
		vi.mocked(captureAdmissionToken).mockRejectedValueOnce(fault)
		await expect(
			manager.relevanceExplain({ query: "diagnostic" }),
		).rejects.toBe(fault)
		expect(capture.calls).toEqual([])
	})

	it("executes searchV2 with the full active lane set and persists one diagnostic run", async () => {
		scripted.push([v2Hit])
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		const result = await manager.relevanceExplain({
			query: "payment service deployment notes",
		})

		// The diagnostic runs the live retrieval pipeline.
		expect(capture.calls.length).toBe(1)
		expect(capture.calls[0]?.query).toBe("payment service deployment notes")
		expect(capture.calls[0]?.agentId).toBe("agent-1")
		// Kit config: kb disabled (reference off), graph disabled, episodes
		// on — the full active lane set for all-scope.
		expect(capture.calls[0]?.availablePaths).toEqual(
			new Set([
				"active-critical",
				"procedural",
				"structured",
				"raw-window",
				"hybrid",
				"episodic",
			]),
		)

		expect(relevance.recordSignal).toHaveBeenCalledWith([v2Hit])
		expect(relevance.persistRun).toHaveBeenCalledTimes(1)
		const { searchV2 } = await import("./mongodb-search-v2.js")
		expect(vi.mocked(searchV2)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			"agent-1",
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
		expect(captureAdmissionToken).toHaveBeenCalledTimes(1)

		const run = relevance.persistRun.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(run.admission).toEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})
		expect(run.diagnosticMode).toBe(true)
		expect(run.status).toBe("healthy")
		expect(run.sourceScope).toBe("all")
		const artifact = (run.artifacts as Array<Record<string, unknown>>)[0]
		expect(artifact.artifactType).toBe("trace")
		expect(artifact.summary).toMatchObject({
			pipeline: "v2",
			sourceScope: "all",
			diagnosticDepth: "standard",
			plan: ["hybrid"],
			planConfidence: "high",
			planConstraints: { timeRange: true },
			planReasoning: "captured plan",
			skippedLanes: ["kb"],
			pathsExecuted: ["hybrid"],
			resultsByPath: { hybrid: 1 },
			laneOutcomes: [{ path: "hybrid", status: "ok", results: 1 }],
			latencyByPath: { hybrid: 12 },
			reranked: true,
			queryRewritten: false,
			budget: { maxTotal: 50 },
			topScore: 0.9,
			resultCount: 1,
		})

		expect(result.health).toBe("healthy")
		expect(result.results).toEqual([v2Hit])
		expect(result.runId).toBe("relevance-run-1")
		expect(result.artifacts).toHaveLength(1)
	})

	it("narrows the memory scope to the conversation-derived lanes", async () => {
		scripted.push([v2Hit])
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		await manager.relevanceExplain({
			query: "payment service deployment notes",
			sourceScope: "memory",
		})

		// graph is disabled in the kit config, so the memory family here is
		// raw-window/hybrid/episodic — never the kb or structured lanes.
		expect(capture.calls[0]?.availablePaths).toEqual(
			new Set(["raw-window", "hybrid", "episodic"]),
		)
	})

	it("keeps only the kb lane for kb scope when KB is enabled", async () => {
		scripted.push([])
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({
			relevance,
			config: kitMongoConfig({ kb: { enabled: true } }),
		})

		await manager.relevanceExplain({
			query: "deployment guide",
			sourceScope: "kb",
		})

		expect(capture.calls[0]?.availablePaths).toEqual(new Set(["kb"]))
	})

	it("excludes the kb lane when the request is KB-restricted", async () => {
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({
			relevance,
			config: kitMongoConfig({ kb: { enabled: true } }),
		})

		const result = await manager.relevanceExplain({
			query: "deployment guide",
			sourceScope: "kb",
			kbRestricted: true,
		})

		expect(capture.calls).toHaveLength(0)
		expect(result.health).toBe("insufficient-data")
	})

	it("keeps the structured family for structured scope", async () => {
		scripted.push([])
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		await manager.relevanceExplain({
			query: "payment service procedure",
			sourceScope: "structured",
		})

		expect(capture.calls[0]?.availablePaths).toEqual(
			new Set(["active-critical", "procedural", "structured"]),
		)
	})

	it("answers insufficient-data without executing when the scope has no lanes", async () => {
		// kb scope but the reference source is disabled — nothing measurable,
		// which is NOT the "searched and found nothing" verdict.
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		const result = await manager.relevanceExplain({
			query: "deployment guide",
			sourceScope: "kb",
		})

		expect(capture.calls.length).toBe(0)
		expect(result.health).toBe("insufficient-data")
		expect(result.results).toEqual([])
		expect(result.artifacts).toEqual([])
		expect(relevance.recordSignal).not.toHaveBeenCalled()
		expect(relevance.persistRun).not.toHaveBeenCalled()
	})

	it("treats a throttled diagnostic as insufficient-data, not a signal", async () => {
		scripted.push([])
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })
		// Patch the captured searchV2 to answer with a throttle marker.
		const { searchV2 } = await import("./mongodb-search-v2.js")
		vi.mocked(searchV2).mockResolvedValueOnce({
			results: [],
			metadata: {
				plan: { paths: [], confidence: "low", reasoning: "" },
				pathsExecuted: [],
				resultsByPath: {},
				throttled: { retryAfterMs: 1000 },
			},
		})

		const result = await manager.relevanceExplain({ query: "throttled topic" })

		// A denial is not a retrieval verdict — the sampler must not learn
		// from it, and the health says "no data" instead of "degraded".
		expect(relevance.recordSignal).not.toHaveBeenCalled()
		expect(result.health).toBe("insufficient-data")
		const run = relevance.persistRun.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		const artifact = (run.artifacts as Array<Record<string, unknown>>)[0]
		expect(artifact.summary).toMatchObject({
			throttled: { retryAfterMs: 1000 },
		})
	})

	it("answers insufficient-data for an empty query without executing", async () => {
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		const result = await manager.relevanceExplain({ query: "   " })

		expect(capture.calls.length).toBe(0)
		expect(result.health).toBe("insufficient-data")
		expect(result.artifacts).toEqual([])
	})

	it("throws when the relevance runtime is unavailable", async () => {
		const manager = buildMockManager() // relevance: null

		await expect(
			manager.relevanceExplain({ query: "anything" }),
		).rejects.toThrow("relevance runtime is unavailable")
	})

	it("narrows identity to the session when a sessionKey is given", async () => {
		scripted.push([])
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		await manager.relevanceExplain({
			query: "payment service notes",
			sessionKey: "session-9",
		})

		// Same identity rule as search(): a diagnostic view must never read
		// wider than the search path it explains.
		const options = capture.calls[0]?.searchOptions
		expect(options?.scope).toBe("session")
		expect(options?.scopeRef).toBe("session:session-9")
		expect(options?.sessionKey).toBe("session-9")
	})
})
