import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { testOperationRunContext } from "../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
import type { MemoryBenchmarkDataset } from "../../packages/memory-engine/src/types.js"
import { runBenchmarkJudgedAnswers } from "./benchmark-answer-quality.js"
import type { BenchmarkCheckpoint } from "./mongodb-benchmark-checkpoint.js"
import {
	BENCHMARK_SCENARIO_COLLECTION_SUFFIXES,
	MongoDBManagerBenchmarkOps,
	attachBenchmarkOperationsReport,
} from "./mongodb-manager-benchmark.js"

vi.mock("../../packages/memory-engine/src/mongodb-events.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).eventsModuleMock(),
)

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkQualityContractsModuleMock(importOriginal),
)

vi.mock("./benchmark-answer-quality.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./benchmark-answer-quality.js")>()
	return {
		...actual,
		runBenchmarkJudgedAnswers: vi.fn(actual.runBenchmarkJudgedAnswers),
	}
})

vi.mock("./benchmark-relevance.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./benchmark-relevance.js")>()),
	persistBenchmarkRegression: vi.fn().mockResolvedValue([]),
}))

vi.mock(
	"../../packages/memory-engine/src/mongodb-conversation-recall.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).conversationRecallModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-ops.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).opsModuleMock(),
)

vi.mock("./mongodb-benchmark-harness.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkHarnessModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-retrieval-planner.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).retrievalPlannerModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-episodes.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).episodesModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-graph.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).graphModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-schema.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).schemaModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-query-cache.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).queryCacheModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-query-rewriter.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).queryRewriterModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-reranker.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).rerankerModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-lane-coverage.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).laneCoverageModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-memory-jobs.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).memoryJobsModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-consolidator.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).consolidatorModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-derived-memory.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).derivedMemoryModuleMock(),
)

vi.mock("./mongodb-benchmark-readiness.js", async (importOriginal) =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkReadinessModuleMock(importOriginal),
)

vi.mock("../../packages/memory-engine/src/mongodb-telemetry.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).telemetryModuleMock(),
)

// B08:C03: the real scenario cleanup runs inside the real scenario loop
// against a fake db; only collection deletes and storage aggregates exist.
const CANARY = "mongodb+srv://cnryUser:cnryPass@cleanup.invalid"
const RUN_ID = "run-cleanup"

type Failure = "none" | "late" | "close"

function driverError() {
	const error = new Error(CANARY) as Error & { code?: number }
	error.name = "MongoServerError"
	error.code = 11600
	return error
}

const dirs: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true })
})

function scenario(id: string) {
	return {
		scenarioId: id,
		conversations: [
			{
				sessionId: `${id}-session`,
				turns: [{ role: "user" as const, body: "x" }],
			},
		],
		evaluations: [],
	}
}

type Harness = Awaited<ReturnType<typeof harness>>

async function harness(params: {
	rejectedSuffixes?: string[]
	failure?: Failure
	scenarioIds?: string[]
	cleanupThrows?: boolean
	failedTurns?: number
}) {
	const { ingestBenchmarkConversations } = await import(
		"./mongodb-benchmark-harness.js"
	)
	vi.mocked(ingestBenchmarkConversations).mockResolvedValue({
		datasetPath: "/tmp/benchmark.jsonl",
		datasetName: "cleanup",
		conversationsIngested: 1,
		turnsIngested: 1,
		skippedConversations: 0,
		failedLines: 0,
		failedTurns: params.failedTurns ?? 0,
		startedAt: new Date("2026-10-14T12:00:00.000Z"),
		completedAt: new Date("2026-10-14T12:00:01.000Z"),
	})
	const deletes: string[] = []
	const primary = new Error(`${params.failure} failure`)
	const manager = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db: {
			collection: (name: string) => ({
				aggregate: () => ({ toArray: async () => [] }),
				deleteMany: async () => {
					deletes.push(name)
					if (
						params.rejectedSuffixes?.some((suffix) => name === `test_${suffix}`)
					)
						throw driverError()
					return { acknowledged: true, deletedCount: 2 }
				},
			}),
		},
		prefix: "test_",
		agentId: "benchmark-parent",
		config: { mongodb: {} },
		relevance: { persistRegression: vi.fn(async () => []) },
	}) as MongoDBMemoryManager
	const ops = new MongoDBManagerBenchmarkOps(
		manager as unknown as MongoDBManagerHost,
	)
	const record = ops as unknown as Record<string, unknown>
	record.createBenchmarkScenarioManager = async (agentId: string) => ({
		agentId,
		close: async () => {
			if (params.failure === "close") throw primary
		},
	})
	record.settleBenchmarkScenarioManager = async () => {
		if (params.failure === "late") throw primary
	}
	record.listBenchmarkEventEvidence = async () => ({
		sessionIds: new Map(),
		turnIds: new Map(),
		dialogIds: new Map(),
	})
	record.waitForBenchmarkSearchConvergence = async () => {}
	if (params.cleanupThrows)
		record.cleanupBenchmarkScenarioData = async () => {
			throw driverError()
		}
	const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-cleanup-"))
	dirs.push(dir)
	const checkpointPath = path.join(dir, "checkpoint.json")
	const dataset: MemoryBenchmarkDataset = {
		name: "cleanup",
		datasetKind: "generic",
		conversations: [],
		scenarios: (params.scenarioIds ?? ["scenario-1"]).map(scenario),
	}
	const run = (resumeCheckpoint?: BenchmarkCheckpoint) =>
		ops.runScenarioBenchmarkDataset({
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testOperationRunContext(RUN_ID),
			checkpointPath,
			datasetSha256: "a".repeat(64),
			executableDigest: "d".repeat(64),
			...(resumeCheckpoint ? { resumeCheckpoint } : {}),
		})
	const checkpoint = async () =>
		JSON.parse(await readFile(checkpointPath, "utf8")) as BenchmarkCheckpoint
	return { run, deletes, primary, checkpoint }
}

describe("scenario cleanup evidence reaches the run result and checkpoint", () => {
	it("records acknowledged cleanup bound to run, scenario and agent", async () => {
		const h = await harness({})
		const { result } = await h.run()
		expect(result.scenarioCleanup).toMatchObject({
			version: 1,
			status: "acknowledged",
			coverage: "registered-scenario-collections",
			scenarios: [
				{
					version: 1,
					runId: RUN_ID,
					scenarioId: "scenario-1",
					agentId: expect.stringMatching(
						/^benchmark-benchmark-parent-[0-9a-f]{8}-[0-9a-f]{12}$/,
					),
					status: "acknowledged",
					registry: {
						version: 1,
						collections: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.length,
					},
				},
			],
		})
		expect(h.deletes).toHaveLength(
			BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.length,
		)
		const stored = await h.checkpoint()
		expect(stored.completedScenarios[0]?.cleanup).toMatchObject({
			status: "acknowledged",
		})
		const reported = attachBenchmarkOperationsReport(result)
		expect(
			reported.benchmarkReport?.releaseGates.find(
				(gate) => gate.gate === "scenario-cleanup",
			)?.status,
		).toBe("passed")
	})

	it("keeps a rejected delete as a failed run outcome and checkpoint record", async () => {
		const h = await harness({ rejectedSuffixes: ["events"] })
		const { result } = await h.run()
		expect(result.scenarioCleanup?.status).toBe("failed")
		const [outcome] = result.scenarioCleanup?.scenarios ?? []
		expect(outcome?.status).toBe("failed")
		expect(
			outcome && "collections" in outcome
				? outcome.collections.filter((entry) => entry.status !== "acknowledged")
				: [],
		).toEqual([
			{
				suffix: "events",
				status: "rejected",
				errorName: "MongoServerError",
				errorCode: 11600,
			},
		])
		const stored = await h.checkpoint()
		expect(stored.completedScenarios[0]?.cleanup?.status).toBe("failed")
		expect(JSON.stringify(stored)).not.toContain("cnry")
		const reported = attachBenchmarkOperationsReport(result)
		expect(reported.benchmarkReport?.scenarioCleanup?.status).toBe("failed")
		expect(reported.benchmarkReport?.publicationDecision.failedGates).toContain(
			"scenario-cleanup",
		)
		expect(JSON.stringify(reported)).not.toContain("cnry")
	})

	it("reports KEEP_SCENARIO_DATA as retained, never acknowledged", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA", "1")
		const h = await harness({})
		const { result } = await h.run()
		expect(h.deletes).toEqual([])
		expect(result.scenarioCleanup?.status).toBe("incomplete")
		expect(result.scenarioCleanup?.scenarios[0]).toMatchObject({
			status: "retained",
			collections: [],
		})
	})

	it.each([
		"late",
		"close",
	] as const)("keeps the %s error primary and adds the sanitized cleanup failure", async (failure) => {
		const h = await harness({ failure, rejectedSuffixes: ["memory_jobs"] })
		const error = await h.run().then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBe(h.primary)
		const message = (error as Error).message
		expect(message).toContain(`${failure} failure`)
		expect(message).toContain(
			"benchmark scenario cleanup failed: scenario=scenario-1 collections=memory_jobs=MongoServerError(11600)",
		)
		expect(message).not.toContain("cnry")
	})

	it("keeps the primary error when the cleanup call itself throws", async () => {
		const h = await harness({ failure: "late", cleanupThrows: true })
		const error = await h.run().then(
			() => undefined,
			(caught: unknown) => caught,
		)
		expect(error).toBe(h.primary)
		expect((error as Error).message).toContain(
			"benchmark scenario cleanup failed: scenario=scenario-1 error=MongoServerError",
		)
		expect((error as Error).message).not.toContain("cnry")
	})

	it("R4: a cleanup-only throw fails the run with a sanitized error", async () => {
		const h = await harness({ cleanupThrows: true })
		const error = (await h.run().then(
			() => undefined,
			(caught: unknown) => caught,
		)) as Error
		expect(error).toBeInstanceOf(Error)
		expect(error.message).toBe(
			"benchmark scenario cleanup failed: scenario=scenario-1 error=MongoServerError",
		)
		expect(error.cause).toBeUndefined()
		expect(
			JSON.stringify(error, Object.getOwnPropertyNames(error)),
		).not.toContain("cnry")
	})

	it("leaves an acknowledged cleanup out of a propagating error", async () => {
		const h = await harness({ failure: "late" })
		const error = (await h.run().then(
			() => undefined,
			(caught: unknown) => caught,
		)) as Error
		expect(error.message).toBe("late failure")
	})
})

describe("resumed cleanup evidence", () => {
	async function firstScenarioCheckpoint(rejectedSuffixes?: string[]) {
		const first = await harness({ rejectedSuffixes })
		await first.run()
		return first.checkpoint()
	}

	function resumable(stored: BenchmarkCheckpoint): BenchmarkCheckpoint {
		return {
			...stored,
			totalScenarios: 2,
			scenarioIds: ["scenario-1", "scenario-2"],
		}
	}

	it("replays an acknowledged checkpoint outcome", async () => {
		const stored = resumable(await firstScenarioCheckpoint())
		const h = await harness({ scenarioIds: ["scenario-1", "scenario-2"] })
		const { result } = await h.run(stored)
		expect(result.scenarioCleanup?.status).toBe("acknowledged")
		expect(result.scenarioCleanup?.scenarios.map((s) => s.scenarioId)).toEqual([
			"scenario-1",
			"scenario-2",
		])
	})

	it("replays a failed checkpoint outcome as failed", async () => {
		const stored = resumable(await firstScenarioCheckpoint(["events"]))
		const h = await harness({ scenarioIds: ["scenario-1", "scenario-2"] })
		const { result } = await h.run(stored)
		expect(result.scenarioCleanup?.status).toBe("failed")
	})

	it.each([
		["missing (legacy checkpoint)", undefined],
		["for another run", { runId: "run-other" }],
		["claiming acknowledged with no collections", { collections: [] }],
		[
			"from another collection registry",
			{ registry: { version: 1, digest: "0".repeat(64), collections: 22 } },
		],
	])("treats a cleanup record %s as unknown", async (_name, change) => {
		const stored = resumable(await firstScenarioCheckpoint())
		const [first] = stored.completedScenarios
		if (!first?.cleanup) throw new Error("expected a recorded cleanup")
		if (change === undefined) delete first.cleanup
		else Object.assign(first.cleanup, change)
		const h = await harness({ scenarioIds: ["scenario-1", "scenario-2"] })
		const { result } = await h.run(stored)
		expect(result.scenarioCleanup?.status).toBe("incomplete")
		expect(result.scenarioCleanup?.scenarios[0]).toEqual({
			scenarioId: "scenario-1",
			status: "unknown",
		})
	})
})

describe("B08 measurement evidence through the real scenario loop", () => {
	const completeness = (
		result: Awaited<ReturnType<Harness["run"]>>["result"],
	) =>
		attachBenchmarkOperationsReport(result).benchmarkReport?.releaseGates.find(
			(gate) => gate.gate === "execution-completeness",
		)

	it("passes completeness on a full ingest and names an empty scored-case latency", async () => {
		const h = await harness({})
		const { result } = await h.run()
		expect(completeness(result)?.status).toBe("passed")
		expect(result.scoredLatency).toMatchObject({
			denominator: "scored-cases",
			samples: 0,
			p95Basis: "no-samples",
		})
		expect(
			attachBenchmarkOperationsReport(result).benchmarkReport?.metrics.internal
				.scoredLatency?.denominator,
		).toBe("scored-cases")
	})

	it("keeps a partially ingested run out of complete evidence, also after resume", async () => {
		const h = await harness({ failedTurns: 3 })
		const { result } = await h.run()
		expect(result.ingest?.failedTurns).toBe(3)
		expect(completeness(result)).toMatchObject({
			status: "failed",
			evidence: expect.stringContaining("3 turns failed ingest"),
		})
		const resumed = await harness({})
		const replay = await resumed.run(await h.checkpoint())
		expect(replay.result.ingest?.failedTurns).toBe(3)
		expect(completeness(replay.result)?.status).toBe("failed")
	})

	it("hands run-level ingest failures to the QA builder, also after resume (B08:C06)", async () => {
		const qaIngest = () =>
			vi.mocked(runBenchmarkJudgedAnswers).mock.calls.at(-1)?.[0].ingest
		const h = await harness({ failedTurns: 3 })
		await h.run()
		expect(qaIngest()).toMatchObject({ failedTurns: 3, failedLines: 0 })
		const resumed = await harness({})
		await resumed.run(await h.checkpoint())
		expect(qaIngest()).toMatchObject({ failedTurns: 3, failedLines: 0 })
		const clean = await harness({})
		await clean.run()
		expect(qaIngest()).toMatchObject({ failedTurns: 0, failedLines: 0 })
	})
})

describe("B08 legacy query benchmark latency label", () => {
	it("names the scored-case denominator for the legacy p95", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-legacy-"))
		dirs.push(dir)
		const datasetPath = path.join(dir, "legacy.jsonl")
		await writeFile(
			datasetPath,
			Array.from({ length: 7 }, (_, i) =>
				JSON.stringify({ query: `synthetic query ${i}` }),
			).join("\n"),
		)
		let call = 0
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {},
				prefix: "test_",
				agentId: "benchmark-parent",
				relevanceExplain: async () => {
					call += 1
					return {
						results: [
							{ path: "p", score: 0.9, snippet: "s", source: "memory" },
						],
						latencyMs: call * 10,
					}
				},
			},
		) as MongoDBMemoryManager
		const ops = new MongoDBManagerBenchmarkOps(
			manager as unknown as MongoDBManagerHost,
		)
		const { result } = await ops.runLegacyRelevanceBenchmark({
			datasetPath,
			maxResults: 5,
			minScore: 0,
		})
		expect(result.p95LatencyMs).toBe(70)
		expect(result.scoredLatency).toEqual({
			denominator: "scored-cases",
			samples: 7,
			p50Ms: 40,
			p95Ms: 70,
			p95Basis: "sample-maximum",
		})
	})
})
