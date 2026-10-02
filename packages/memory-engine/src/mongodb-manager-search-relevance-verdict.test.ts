/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
// RET-15 (wave 3h): every V2 answer the manager SERVES must feed the
// relevance runtime — success, empty, constrained-empty, error-empty. The
// non-verdict outcomes (throttle denials, legacy-fallback replacements)
// must NOT pollute the signal. These tests drive the real manager search
// methods with a captured searchV2 module and a scripted relevance runtime,
// asserting the verdict seams by what persistRun/recordSignal observed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { MongoServerError } from "mongodb"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import type { MemorySearchResult } from "./types.js"
import {
	mocked,
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
	fakeDb,
	fakePrefix,
} from "./test-helpers/manager-test-kit.js"

const { emitTelemetry } = await import("./mongodb-telemetry.js")
const { recordRecallTrace } = await import("./mongodb-recall-traces.js")
const { captureAdmissionToken } = await import("./mongodb-write-fence.js")

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

const v2Hit: MemorySearchResult = {
	path: "conversation/session-1",
	startLine: 1,
	endLine: 1,
	snippet: "deployed the payment service",
	score: 0.9,
	source: "conversation",
	timestamp: new Date("2026-08-05T00:00:00.000Z"),
}

const v2Metadata = {
	plan: { paths: ["hybrid"], confidence: "high", reasoning: "planned" },
	pathsExecuted: ["hybrid"],
	resultsByPath: { hybrid: 1 },
}

/** Scripted relevance runtime — the verdict seams observed from below. */
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

describe("manager search feeds the V2 verdict into the relevance runtime (RET-15)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		searchV2State.responses.length = 0
	})

	it("keeps a served search successful when admitted telemetry rejects", async () => {
		searchV2State.responses.push({ results: [v2Hit], metadata: v2Metadata })
		const manager = buildMockManager({
			relevance: buildRelevanceStub(),
			recordSearchAccess: vi.fn(),
		})
		vi.mocked(emitTelemetry).mockRejectedValueOnce(
			new Error("secret driver failure"),
		)
		await expect(
			manager.search("payment service deployment notes"),
		).resolves.toEqual([v2Hit])
	})

	it("passes original search admission to spend accounting and preserves results on rejection", async () => {
		const { recordEmbeddingSpend } = await import("./mongodb-cost-ledger.js")
		vi.mocked(recordEmbeddingSpend).mockRejectedValueOnce(
			new Error("ledger unavailable"),
		)
		searchV2State.responses.push({
			results: [v2Hit],
			metadata: { ...v2Metadata, budget: { embeds: 2 } },
		})
		const manager = buildMockManager({ relevance: buildRelevanceStub() })
		await expect(
			manager.search("payment service deployment notes"),
		).resolves.toEqual([v2Hit])
		expect(recordEmbeddingSpend).toHaveBeenCalledWith(
			fakeDb,
			fakePrefix,
			"agent-1",
			"search",
			2,
			{
				admission: await vi.mocked(captureAdmissionToken).mock.results.at(-1)
					?.value,
			},
		)
	})

	it("records the served success answer as a V2-pipeline run", async () => {
		searchV2State.responses.push({ results: [v2Hit], metadata: v2Metadata })
		const relevance = buildRelevanceStub()
		const recordSearchAccess = vi.fn()
		const manager = buildMockManager({ relevance, recordSearchAccess })

		await manager.search("payment service deployment notes")

		expect(captureAdmissionToken).toHaveBeenCalledTimes(1)
		expect(
			vi.mocked(await import("./mongodb-search-v2.js")).searchV2,
		).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			"agent-1",
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
		expect(emitTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				meta: { agentId: "agent-1", operation: "search" },
			}),
			{ admission: { kind: "admission", agentId: "agent-1", epoch: 0 } },
		)
		expect(recordRecallTrace).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
		expect(recordSearchAccess).toHaveBeenCalledWith(expect.any(Array), {
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})

		expect(relevance.recordSignal).toHaveBeenCalledWith([v2Hit])
		expect(relevance.persistRun).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
		expect(relevance.persistRun).toHaveBeenCalledTimes(1)
		const run = relevance.persistRun.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(run.admission).toEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})
		expect(run.pipeline ?? run.sourceScope).toBeDefined()
		const artifact = (run.artifacts as Array<Record<string, unknown>>)[0]
		expect(artifact.artifactType).toBe("trace")
		expect(artifact.summary).toMatchObject({
			pipeline: "v2",
			plan: ["hybrid"],
			planConfidence: "high",
			pathsExecuted: ["hybrid"],
			resultsByPath: { hybrid: 1 },
			reranked: false,
			topScore: 0.9,
			resultCount: 1,
		})
		expect(run.status).toBe("healthy")
		expect(run.sampled).toBe(true)
	})

	it("records the empty answer as the served verdict when the fallback is off", async () => {
		searchV2State.responses.push({ results: [], metadata: v2Metadata })
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		await manager.search("unknown topic")

		expect(relevance.recordSignal).toHaveBeenCalledWith([])
		const run = relevance.persistRun.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(run.admission).toEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})
		const artifact = (run.artifacts as Array<Record<string, unknown>>)[0]
		expect(artifact.summary).toMatchObject({
			pipeline: "v2",
			resultCount: 0,
			topScore: 0,
		})
	})

	it("does NOT record a verdict when the throttle denies the search", async () => {
		searchV2State.responses.push({
			results: [],
			metadata: {
				...v2Metadata,
				throttled: { reason: "denied", retryAfterMs: 1000 },
			},
		})
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		const served = await manager.search("throttled topic")

		expect(served).toEqual([])
		// A denial is not a retrieval verdict — nothing was searched.
		expect(relevance.recordSignal).not.toHaveBeenCalled()
		expect(relevance.persistRun).not.toHaveBeenCalled()
	})

	it("does NOT record a verdict when the legacy fallback replaces the answer", async () => {
		searchV2State.responses.push({ results: [], metadata: v2Metadata })
		const relevance = buildRelevanceStub()
		const legacyHit = { ...v2Hit, snippet: "legacy lane hit" }
		const manager = buildMockManager({
			relevance,
			config: kitMongoConfig({ legacySearchFallback: true }),
			legacySearch: vi.fn(async () => [legacyHit]),
		})

		const served = await manager.search("legacy fallback topic")

		expect(served).toEqual([legacyHit])
		// The v2 empty answer was REPLACED by the legacy lane — the served
		// answer is not a V2 verdict, so the runtime must not see one.
		expect(relevance.recordSignal).not.toHaveBeenCalled()
		expect(relevance.persistRun).not.toHaveBeenCalled()
	})

	it("records the error-empty answer with the error outcome and no plan", async () => {
		searchV2State.responses.push(new Error("planner exploded"))
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		await manager.search("exploding topic")

		expect(relevance.recordSignal).toHaveBeenCalledWith([])
		const run = relevance.persistRun.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(run.admission).toEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})
		const artifact = (run.artifacts as Array<Record<string, unknown>>)[0]
		expect(artifact.summary).toMatchObject({
			pipeline: "v2",
			outcome: "error",
			resultCount: 0,
		})
		expect(artifact.summary).not.toHaveProperty("plan")
	})
})

describe("manager searchDetailed feeds the V2 verdict into the relevance runtime (RET-15)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		searchV2State.responses.length = 0
	})

	it("records the served success answer with the V2 response metadata", async () => {
		searchV2State.responses.push({ results: [v2Hit], metadata: v2Metadata })
		const relevance = buildRelevanceStub()
		const recordSearchAccess = vi.fn()
		const manager = buildMockManager({ relevance, recordSearchAccess })

		// returnPlan: the merged response metadata only carries the plan
		// when the caller asked for it (mergeMetadata gate).
		await manager.searchDetailed({
			query: "payment service notes",
			returnPlan: true,
		})

		expect(captureAdmissionToken).toHaveBeenCalledTimes(1)
		expect(
			vi.mocked(await import("./mongodb-search-v2.js")).searchV2,
		).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			"agent-1",
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
		expect(emitTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				meta: { agentId: "agent-1", operation: "search" },
			}),
			{ admission: { kind: "admission", agentId: "agent-1", epoch: 0 } },
		)
		expect(recordRecallTrace).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
		expect(recordSearchAccess).toHaveBeenCalledWith(expect.any(Array), {
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})

		// The executor enriches served results (trust scoring), so assert
		// identity, not deep equality.
		const signalArg = relevance.recordSignal.mock.calls[0]?.[0] as
			| MemorySearchResult[]
			| undefined
		expect(signalArg).toHaveLength(1)
		expect(signalArg?.[0]?.path).toBe("conversation/session-1")
		const run = relevance.persistRun.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(run.admission).toEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})
		const artifact = (run.artifacts as Array<Record<string, unknown>>)[0]
		expect(artifact.summary).toMatchObject({
			pipeline: "v2",
			plan: ["hybrid"],
			pathsExecuted: ["hybrid"],
			topScore: 0.9,
		})
	})

	it("records the constrained-empty answer as a distinct served verdict", async () => {
		// Hard constraints (an explicit time range) with zero results — the
		// empty is constraint-filtered, not an unconstrained miss, and the
		// verdict keeps that distinction via the recorded metadata.
		searchV2State.responses.push({ results: [], metadata: v2Metadata })
		const relevance = buildRelevanceStub()
		const manager = buildMockManager({ relevance })

		const response = await manager.searchDetailed({
			query: "payment service notes",
			timeRange: {
				start: "2026-08-01T00:00:00.000Z",
				end: "2026-08-10T00:00:00.000Z",
			},
		})

		expect(response.results).toEqual([])
		expect(relevance.recordSignal).toHaveBeenCalledWith([])
		expect(relevance.persistRun).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
		expect(relevance.persistRun).toHaveBeenCalledTimes(1)
	})
})

vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
)

vi.mock("./mongodb-recall-traces.js", () => ({
	recordRecallTrace: vi.fn(async () => "trace"),
}))

describe("recall-trace failure privacy through manager search paths", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		searchV2State.responses.length = 0
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "0")
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		vi.mocked(recordRecallTrace).mockResolvedValue("trace")
	})
	it.each([
		"success",
		"empty",
		"empty-fallback",
		"error-fallback",
		"detailed",
	])("preserves %s results without logging private trace errors", async (branch) => {
		const privateText = "violet confidential trace CANARY90"
		const traceError = new MongoServerError({
			errmsg: privateText,
			code: 11000,
		})
		const outerError = new MongoServerError({
			errmsg: "public planner fixture",
			code: 2,
		})
		const lines: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args) =>
			lines.push(args.join(" ")),
		)
		vi.mocked(recordRecallTrace).mockRejectedValue(traceError)
		searchV2State.responses.push(
			branch === "error-fallback"
				? outerError
				: {
						results:
							branch === "success" || branch === "detailed" ? [v2Hit] : [],
						metadata: v2Metadata,
					},
		)
		const manager = buildMockManager({
			relevance: buildRelevanceStub(),
			recordSearchAccess: vi.fn(),
			config: kitMongoConfig({
				legacySearchFallback: branch.endsWith("fallback"),
			}),
			legacySearch: vi.fn(async () => [v2Hit]),
		})
		const results =
			branch === "detailed"
				? (await manager.searchDetailed({ query: "public topic" })).results
				: await manager.search("public topic")
		expect(results).toHaveLength(branch === "empty" ? 0 : 1)
		await new Promise<void>((resolve) => setImmediate(resolve))
		const traceLines = lines.filter((line) =>
			line.includes("recall trace write failed"),
		)
		expect(traceLines).toHaveLength(branch === "empty-fallback" ? 2 : 1)
		for (const line of traceLines) {
			expect(line).not.toContain(privateText)
			expect(line).toContain('"code":11000')
			expect(line).not.toContain("queryDigest")
		}
	})
})

const fallbackAdmission = vi.hoisted(() => ({
	decisions: [] as Array<{ ok: true } | { ok: false; retryAfterMs: number }>,
}))
vi.mock("./mongodb-search-admission.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-search-admission.js")>()
	return {
		...actual,
		tryConsumeSearchAdmission: vi.fn(
			() => fallbackAdmission.decisions.shift() ?? { ok: true },
		),
	}
})
describe("remaining original relevance admission connections", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		searchV2State.responses.length = 0
		fallbackAdmission.decisions.length = 0
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "0")
	})
	afterEach(() => vi.unstubAllEnvs())
	it.each([
		"search",
		"detailed",
	])("threads the original token when %s legacy fallback is denied", async (branch) => {
		searchV2State.responses.push({ results: [], metadata: v2Metadata })
		const relevance = buildRelevanceStub(),
			manager = buildMockManager({
				relevance,
				config: kitMongoConfig({ legacySearchFallback: true }),
			})
		if (branch === "detailed") fallbackAdmission.decisions.push({ ok: true })
		fallbackAdmission.decisions.push({ ok: false, retryAfterMs: 1000 })
		if (branch === "search") await manager.search("denied fallback")
		else await manager.searchDetailed({ query: "denied fallback" })
		expect(captureAdmissionToken).toHaveBeenCalledTimes(1)
		expect(relevance.persistRun).toHaveBeenCalledTimes(1)
		expect(relevance.persistRun).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
	})
	it("threads the original token through detailed unconstrained empty", async () => {
		searchV2State.responses.push({ results: [], metadata: v2Metadata })
		const relevance = buildRelevanceStub(),
			manager = buildMockManager({ relevance })
		await manager.searchDetailed({ query: "empty detailed" })
		expect(relevance.persistRun).toHaveBeenCalledTimes(1)
		expect(relevance.persistRun).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
			}),
		)
	})
	it("threads supplied original admission through the actual legacy method", async () => {
		const relevance = buildRelevanceStub(),
			manager = buildMockManager({ relevance })
		const admission = {
			kind: "admission" as const,
			agentId: "agent-1",
			epoch: 17,
		}
		await (
			manager as unknown as {
				legacySearch(
					query: string,
					opts: undefined,
					token: typeof admission,
				): Promise<MemorySearchResult[]>
			}
		).legacySearch("legacy empty", undefined, admission)
		expect(captureAdmissionToken).not.toHaveBeenCalled()
		expect(relevance.persistRun).toHaveBeenCalledTimes(1)
		expect(relevance.persistRun).toHaveBeenCalledWith(
			expect.objectContaining({ admission }),
		)
	})
})

vi.mock("./mongodb-cost-ledger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-cost-ledger.js")>()),
	recordEmbeddingSpend: vi.fn(async () => {}),
}))
