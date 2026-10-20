/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"
import { importConversationDataset } from "./mongodb-benchmark-harness.js"
import type { RelevanceBenchmarkResult } from "./benchmark-relevance.js"
import type {
	MemoryBenchmarkDataset,
	MemorySearchResult,
} from "../../packages/memory-engine/src/types.js"
import {
	access,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	mocked,
	testOperationRunContext,
} from "../../packages/memory-engine/src/test-helpers/manager-test-kit.js"

// A cleanup attempt whose registered deletes were all acknowledged.
const ACKNOWLEDGED_CLEANUP = {
	status: "acknowledged" as const,
	agentId: "benchmark-test-agent",
	registry: { version: 1 as const, digest: "0".repeat(64), collections: 0 },
	collections: [],
}

function benchmarkOps(
	manager: MongoDBMemoryManager,
): MongoDBManagerBenchmarkOps {
	const ops = new MongoDBManagerBenchmarkOps(
		manager as unknown as MongoDBManagerHost,
	)
	const managerRecord = manager as unknown as Record<string, unknown>
	const opsRecord = ops as unknown as Record<string, unknown>
	for (const method of [
		"createBenchmarkScenarioManager",
		"settleBenchmarkScenarioManager",
		"listBenchmarkEventEvidence",
		"waitForBenchmarkSearchConvergence",
		"cleanupBenchmarkScenarioData",
		"resolveBenchmarkResultSessionIds",
		"resolveBenchmarkResultTurnIds",
		"resolveBenchmarkResultDialogIds",
	]) {
		const override = managerRecord[method]
		if (typeof override === "function") {
			opsRecord[method] = override
		}
	}
	return ops
}

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

const {
	eventsCollection,
	chunksCollection,
	sessionChunksCollection,
	memoryJobsCollection,
} = await import("../../packages/memory-engine/src/mongodb-schema.js")

describe("benchmark scenario queue settling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("fails fast when a benchmark scenario queue does not settle", async () => {
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-1",
				writeQueue: new Promise<void>(() => {}),
				derivationQueue: Promise.resolve(),
			} as MongoDBManagerHost

			await expect(
				new MongoDBManagerBenchmarkOps(manager).settleBenchmarkScenarioManager(
					manager,
				),
			).rejects.toThrow(
				"benchmark scenario manager writeQueue settle timed out after 1ms",
			)
		} finally {
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = previousTimeout
			}
		}
	})

	it("wakes the job worker until the job collection has no outstanding extraction", async () => {
		const outstanding = [374, 0]
		const countDocuments = vi.fn(async (filter: Record<string, unknown>) =>
			"$or" in filter && !("status" in filter) ? (outstanding.shift() ?? 0) : 0,
		)
		const jobs = vi.mocked(memoryJobsCollection)
		const original = jobs.getMockImplementation()
		jobs.mockImplementation(() => ({ countDocuments }) as never)
		try {
			const manager = {
				agentId: "benchmark-agent-drain",
				writeQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
				startMemoryJobWorker: vi.fn(),
			} as unknown as MongoDBManagerHost

			await expect(callSettle(manager)).resolves.toBeUndefined()
			expect(manager.startMemoryJobWorker).toHaveBeenCalledTimes(1)
		} finally {
			if (original) jobs.mockImplementation(original)
		}
	})

	// Task 1.3 — complete queue-settle timeout coverage (plan Harness Checklist #3).
	const callSettle = async (manager: MongoDBManagerHost) =>
		new MongoDBManagerBenchmarkOps(manager).settleBenchmarkScenarioManager(
			manager,
		)

	it("names writeQueue when writeQueue hangs (Task 1.3)", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-write",
				writeQueue: new Promise<void>(() => {}),
				derivationQueue: Promise.resolve(),
			} as MongoDBManagerHost
			await expect(callSettle(manager)).rejects.toThrow(
				/writeQueue settle timed out after 200ms/,
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("names derivationQueue when derivationQueue hangs (Task 1.3)", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-derivation",
				writeQueue: Promise.resolve(),
				derivationQueue: new Promise<void>(() => {}),
			} as MongoDBManagerHost
			await expect(callSettle(manager)).rejects.toThrow(
				/derivationQueue settle timed out after 200ms/,
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("names derivationSchedulingQueue when post-write scheduling hangs", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-scheduling",
				writeQueue: Promise.resolve(),
				derivationSchedulingQueue: new Promise<void>(() => {}),
				derivationQueue: Promise.resolve(),
			} as MongoDBManagerHost
			await expect(callSettle(manager)).rejects.toThrow(
				/derivationSchedulingQueue settle timed out after 200ms/,
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("names memoryJobWorkerPromise when durable extraction hangs", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-durable-worker",
				writeQueue: Promise.resolve(),
				derivationSchedulingQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
				memoryJobWorkerPromise: new Promise<void>(() => {}),
			} as MongoDBManagerHost
			await expect(callSettle(manager)).rejects.toThrow(
				/memoryJobWorkerPromise settle timed out after 200ms/,
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("waits for post-write scheduling that enqueues derived work", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "500"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-scheduling-flush",
				writeQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
			} as MongoDBManagerHost
			manager.derivationSchedulingQueue = new Promise<void>((resolve) => {
				setTimeout(() => {
					manager.derivationQueue = new Promise<void>((resolveDerived) => {
						setTimeout(resolveDerived, 25)
					})
					resolve()
				}, 25)
			})

			await expect(callSettle(manager)).resolves.toBeUndefined()
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("succeeds on slow-but-bounded queue under timeout (Task 1.3)", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "500"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-slow",
				writeQueue: new Promise<void>((resolve) => setTimeout(resolve, 50)),
				derivationQueue: Promise.resolve(),
			} as MongoDBManagerHost
			await expect(callSettle(manager)).resolves.toBeUndefined()
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("fails closed when queue identities never quiesce", async () => {
		const manager = {
			agentId: "benchmark-agent-churning",
			get writeQueue() {
				return Promise.resolve()
			},
			derivationQueue: Promise.resolve(),
		} as MongoDBManagerHost

		await expect(callSettle(manager)).rejects.toThrow(
			"benchmark scenario manager did not fully settle after 8 attempts",
		)
	})

	it.each([
		"success",
		"startup",
		"late",
		"close",
		"cleanup",
		"keep",
		"measurement",
	])("fully closes and removes its workspace on %s", async (failure) => {
		let workspace: string | undefined
		if (failure === "keep")
			vi.stubEnv("MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA", "1")
		const { ingestBenchmarkConversations } = await import(
			"./mongodb-benchmark-harness.js"
		)
		const order: string[] = []
		mocked(ingestBenchmarkConversations).mockResolvedValue({
			datasetPath: "/tmp/benchmark.jsonl",
			datasetName: "worker-cleanup",
			conversationsIngested: 1,
			turnsIngested: 1,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			rejectedTurns: 0,
			rejectedConversations: 0,
			startedAt: new Date("2026-04-09T12:00:00.000Z"),
			completedAt: new Date("2026-04-09T12:00:01.000Z"),
		})
		const scenarioManager = {
			agentId: "benchmark-isolated-worker",
			close: vi.fn(async () => {
				order.push("close")
				if (failure === "close") throw new Error("close failure")
			}),
		} as unknown as MongoDBMemoryManager
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {
					collection: vi.fn(() => ({
						aggregate: vi.fn(() => ({
							toArray: vi.fn(async () => {
								order.push("measure")
								if (failure === "measurement")
									throw new Error("measurement failure")
								return []
							}),
						})),
					})),
				},
				prefix: "test_",
				agentId: "benchmark-parent",
				config: { mongodb: {} },
				relevance: { persistRegression: vi.fn(async () => []) },
				createBenchmarkScenarioManager: vi.fn(
					async (_id: string, dir: string) => {
						workspace = dir
						await access(dir)
						if (failure === "startup") throw new Error("startup failure")
						return scenarioManager
					},
				),
				settleBenchmarkScenarioManager: vi.fn(async () => {
					if (failure === "late") throw new Error("late failure")
				}),
				listBenchmarkEventEvidence: vi.fn(async () => ({
					sessionIds: new Map(),
					turnIds: new Map(),
					dialogIds: new Map(),
				})),
				waitForBenchmarkSearchConvergence: vi.fn(async () => {}),
				cleanupBenchmarkScenarioData: vi.fn(async () => {
					order.push("cleanup")
					if (failure === "cleanup") throw new Error("cleanup failure")
					return ACKNOWLEDGED_CLEANUP
				}),
			},
		) as MongoDBMemoryManager
		const dataset: MemoryBenchmarkDataset = {
			name: "worker-cleanup",
			datasetKind: "generic",
			conversations: [],
			scenarios: [
				{
					scenarioId: "scenario-1",
					conversations: [
						{
							sessionId: "session-1",
							turns: [{ role: "user", body: "remember this" }],
						},
					],
					evaluations: [],
				},
			],
		}

		const run = benchmarkOps(manager).runScenarioBenchmarkDataset({
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testOperationRunContext("worker-cleanup"),
		})

		try {
			if (["startup", "late", "close"].includes(failure))
				await expect(run).rejects.toThrow(`${failure} failure`)
			else if (failure === "cleanup")
				// The raw cleanup error never escapes; a sanitized one does.
				await expect(run).rejects.toThrow(
					"benchmark scenario cleanup failed: scenario=scenario-1 error=unknown",
				)
			else {
				const outcome = await run
				if (failure === "measurement")
					expect(outcome.storage.unavailableReason).toContain(
						"measurement failure",
					)
			}
			expect(workspace).toBeDefined()
			if (!workspace) throw new Error("missing owned workspace")
			await expect(access(workspace)).rejects.toThrow()
			if (failure !== "startup") expect(order[0]).toBe("close")
			if (failure === "keep") expect(order).not.toContain("cleanup")
			else expect(order.at(-1)).toBe("cleanup")
			if (failure === "close" || failure === "startup")
				expect(order).not.toContain("measure")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("repeats only the measurement loop for extra measurement passes", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_MEASUREMENT_PASSES", "3")
		const { ingestBenchmarkConversations } = await import(
			"./mongodb-benchmark-harness.js"
		)
		const order: string[] = []
		mocked(ingestBenchmarkConversations).mockImplementation(async () => {
			order.push("ingest")
			return {
				datasetPath: "/tmp/benchmark.jsonl",
				datasetName: "measurement-passes",
				conversationsIngested: 1,
				turnsIngested: 1,
				skippedConversations: 0,
				failedLines: 0,
				failedTurns: 0,
				rejectedTurns: 0,
				rejectedConversations: 0,
				startedAt: new Date("2026-04-09T12:00:00.000Z"),
				completedAt: new Date("2026-04-09T12:00:01.000Z"),
			}
		})
		const search = vi.fn(async () => {
			order.push("search")
			return [
				{
					path: "memory://hit",
					startLine: 1,
					endLine: 1,
					score: 0.9,
					snippet: "hit",
					source: "conversation",
					sessionId: "session-1",
				},
			] satisfies MemorySearchResult[]
		})
		const scenarioManager = {
			agentId: "benchmark-measurement-passes",
			search,
			close: vi.fn(async () => {}),
		} as unknown as MongoDBMemoryManager
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {
					collection: vi.fn(() => ({
						aggregate: vi.fn(() => ({
							toArray: vi.fn(async () => []),
						})),
					})),
				},
				prefix: "test_",
				agentId: "benchmark-parent",
				config: { mongodb: {} },
				relevance: { persistRegression: vi.fn(async () => []) },
				createBenchmarkScenarioManager: vi.fn(() => scenarioManager),
				settleBenchmarkScenarioManager: vi.fn(async () => {}),
				listBenchmarkEventEvidence: vi.fn(async () => ({
					sessionIds: new Map(),
					turnIds: new Map(),
					dialogIds: new Map(),
				})),
				waitForBenchmarkSearchConvergence: vi.fn(async () => {
					order.push("converge")
				}),
				cleanupBenchmarkScenarioData: vi.fn(async () => {
					order.push("cleanup")
					return ACKNOWLEDGED_CLEANUP
				}),
			},
		) as MongoDBMemoryManager
		const dataset: MemoryBenchmarkDataset = {
			name: "measurement-passes",
			datasetKind: "generic",
			conversations: [],
			scenarios: [
				{
					scenarioId: "scenario-1",
					conversations: [
						{
							sessionId: "session-1",
							turns: [{ role: "user", body: "remember this" }],
						},
					],
					evaluations: [
						{
							caseId: "case-1",
							query: "what did I remember?",
							expectedSessionIds: ["session-1"],
						},
					],
				},
			],
		}

		const result = (await benchmarkOps(manager).runScenarioBenchmarkDataset({
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testOperationRunContext("measurement-passes"),
		})) as { result: RelevanceBenchmarkResult }

		// Ingest, convergence, and cleanup happen once; only the eval loop repeats.
		expect(order).toEqual([
			"ingest",
			"converge",
			"search",
			"search",
			"search",
			"cleanup",
		])
		// The published result is pass 1 only.
		expect(result.result.cases).toBe(1)
		expect(result.result.measurementPasses?.passes).toBe(3)
		expect(result.result.measurementPasses?.gatePass).toBe(1)
		expect(
			result.result.measurementPasses?.samples.map((sample) => sample.pass),
		).toEqual([1, 2, 3])
		vi.unstubAllEnvs()
	})

	it("omits the measurement-pass report for the default single pass", async () => {
		const { ingestBenchmarkConversations } = await import(
			"./mongodb-benchmark-harness.js"
		)
		mocked(ingestBenchmarkConversations).mockResolvedValue({
			datasetPath: "/tmp/benchmark.jsonl",
			datasetName: "single-pass",
			conversationsIngested: 1,
			turnsIngested: 1,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			rejectedTurns: 0,
			rejectedConversations: 0,
			startedAt: new Date("2026-04-09T12:00:00.000Z"),
			completedAt: new Date("2026-04-09T12:00:01.000Z"),
		})
		const search = vi.fn(async () => [] as MemorySearchResult[])
		const scenarioManager = {
			agentId: "benchmark-single-pass",
			search,
			close: vi.fn(async () => {}),
		} as unknown as MongoDBMemoryManager
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {
					collection: vi.fn(() => ({
						aggregate: vi.fn(() => ({
							toArray: vi.fn(async () => []),
						})),
					})),
				},
				prefix: "test_",
				agentId: "benchmark-parent",
				config: { mongodb: {} },
				relevance: { persistRegression: vi.fn(async () => []) },
				createBenchmarkScenarioManager: vi.fn(() => scenarioManager),
				settleBenchmarkScenarioManager: vi.fn(async () => {}),
				listBenchmarkEventEvidence: vi.fn(async () => ({
					sessionIds: new Map(),
					turnIds: new Map(),
					dialogIds: new Map(),
				})),
				waitForBenchmarkSearchConvergence: vi.fn(async () => {}),
				cleanupBenchmarkScenarioData: vi.fn(async () => ACKNOWLEDGED_CLEANUP),
			},
		) as MongoDBMemoryManager
		const dataset: MemoryBenchmarkDataset = {
			name: "single-pass",
			datasetKind: "generic",
			conversations: [],
			scenarios: [
				{
					scenarioId: "scenario-1",
					conversations: [
						{
							sessionId: "session-1",
							turns: [{ role: "user", body: "remember this" }],
						},
					],
					evaluations: [
						{
							caseId: "case-1",
							query: "what did I remember?",
							expectedSessionIds: ["session-1"],
						},
					],
				},
			],
		}

		const result = (await benchmarkOps(manager).runScenarioBenchmarkDataset({
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testOperationRunContext("single-pass"),
		})) as { result: RelevanceBenchmarkResult }

		expect(search).toHaveBeenCalledTimes(1)
		expect(result.result.measurementPasses).toBeUndefined()
	})
})

describe("importConversations", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves workspace-relative conversation imports before replay", async () => {
		mocked(importConversationDataset).mockResolvedValue({
			datasetPath: "/workspace/imports/history.json",
			datasetName: "history.json",
			datasetKind: "generic",
			conversationsImported: 1,
			turnsImported: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-11T00:00:00.000Z"),
			completedAt: new Date("2026-04-11T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-import-workspace-"),
		)
		const importDir = path.join(workspaceDir, "imports")
		const datasetPath = path.join(importDir, "history.json")
		try {
			await mkdir(importDir, { recursive: true })
			await writeFile(datasetPath, JSON.stringify({ conversations: [] }))
			const expectedDatasetPath = await realpath(datasetPath)
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(importDir, "default.json"),
							},
						},
					},
				},
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await benchmarkOps(manager).importConversations({
				datasetPath: "imports/history.json",
			})

			expect(importConversationDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: expectedDatasetPath,
					allowedRoots: expect.arrayContaining([workspaceDir, importDir]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("rejects conversation imports outside allowed roots", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-import-workspace-"),
		)
		const outsideDir = await mkdtemp(path.join(os.tmpdir(), "memongo-outside-"))
		const outsideFile = path.join(outsideDir, "history.json")
		try {
			await writeFile(outsideFile, JSON.stringify({ conversations: [] }))
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(workspaceDir, "imports", "default.json"),
							},
						},
					},
				},
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await expect(
				benchmarkOps(manager).importConversations({
					datasetPath: outsideFile,
				}),
			).rejects.toThrow(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
			await rm(outsideDir, { recursive: true, force: true })
		}
	})

	it("honors MEMONGO_DATASET_ROOT as an additional allowed root", async () => {
		mocked(importConversationDataset).mockResolvedValue({
			datasetPath: "/datasets/history.json",
			datasetName: "history.json",
			datasetKind: "generic",
			conversationsImported: 1,
			turnsImported: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-11T00:00:00.000Z"),
			completedAt: new Date("2026-04-11T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-import-workspace-"),
		)
		const datasetRoot = await mkdtemp(
			path.join(os.tmpdir(), "memongo-dataset-root-"),
		)
		const datasetPath = path.join(datasetRoot, "history.json")
		const prevDatasetRoot = process.env.MEMONGO_DATASET_ROOT
		process.env.MEMONGO_DATASET_ROOT = datasetRoot
		try {
			await writeFile(datasetPath, JSON.stringify({ conversations: [] }))
			const expectedDatasetPath = await realpath(datasetPath)
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(workspaceDir, "imports", "default.json"),
							},
						},
					},
				},
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await benchmarkOps(manager).importConversations({
				datasetPath,
			})

			expect(importConversationDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: expectedDatasetPath,
					allowedRoots: expect.arrayContaining([datasetRoot]),
				}),
			)
		} finally {
			if (prevDatasetRoot === undefined) {
				delete process.env.MEMONGO_DATASET_ROOT
			} else {
				process.env.MEMONGO_DATASET_ROOT = prevDatasetRoot
			}
			await rm(workspaceDir, { recursive: true, force: true })
			await rm(datasetRoot, { recursive: true, force: true })
		}
	})

	it("routes imports through writeConversationEventsBatch with the authorized scope forced on every item", async () => {
		mocked(importConversationDataset).mockResolvedValue({
			datasetPath: "/workspace/imports/history.json",
			datasetName: "history.json",
			datasetKind: "generic",
			conversationsImported: 1,
			turnsImported: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-11T00:00:00.000Z"),
			completedAt: new Date("2026-04-11T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-import-workspace-"),
		)
		const importDir = path.join(workspaceDir, "imports")
		const datasetPath = path.join(importDir, "history.json")
		try {
			await mkdir(importDir, { recursive: true })
			await writeFile(datasetPath, JSON.stringify({ conversations: [] }))
			const writeConversationEventsBatch = vi.fn(
				async (events: Array<Record<string, unknown>>) =>
					events.map(() => ({
						ok: true as const,
						eventId: "evt-1",
						chunkCreated: false,
					})),
			)
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(importDir, "default.json"),
							},
						},
					},
				},
				writeConversationEventsBatch,
			} as unknown as MongoDBMemoryManager

			await benchmarkOps(manager).importConversations({
				datasetPath: "imports/history.json",
				scope: "agent",
				scopeRef: "tenant-1",
			})

			const harnessParams = mocked(importConversationDataset).mock.calls[0]?.[0]
			expect(harnessParams?.writeTurns).toBeTypeOf("function")
			await harnessParams?.writeTurns?.([
				{
					role: "user",
					body: "first imported turn",
					sessionId: "sess-1",
					// A dataset-declared scope must never win over the caller's
					// authorized tenant identity.
					scope: "workspace",
					idempotencyKey: "key-1",
				},
				{
					role: "assistant",
					body: "second imported turn",
					sessionId: "sess-1",
					idempotencyKey: "key-2",
				},
			])
			expect(writeConversationEventsBatch).toHaveBeenCalledTimes(1)
			expect(writeConversationEventsBatch).toHaveBeenCalledWith([
				expect.objectContaining({
					body: "first imported turn",
					scope: "agent",
					scopeRef: "tenant-1",
					idempotencyKey: "key-1",
				}),
				expect.objectContaining({
					body: "second imported turn",
					scope: "agent",
					scopeRef: "tenant-1",
					idempotencyKey: "key-2",
				}),
			])
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})
