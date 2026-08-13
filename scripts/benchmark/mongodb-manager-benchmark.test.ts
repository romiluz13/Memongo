/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"
import {
	ingestBenchmarkConversations,
	ingestBenchmarkDataset,
} from "./mongodb-benchmark-harness.js"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	mocked,
	fakeDb,
	fakePrefix,
} from "../../packages/memory-engine/src/test-helpers/manager-test-kit.js"

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
		"flushBenchmarkQueryCache",
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

vi.mock("./mongodb-benchmark-readiness.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkReadinessModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-telemetry.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).telemetryModuleMock(),
)

const { eventsCollection, chunksCollection, sessionChunksCollection } =
	await import("../../packages/memory-engine/src/mongodb-schema.js")

describe("benchmarkIngest", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves workspace-relative benchmark datasets before replay", async () => {
		mocked(ingestBenchmarkDataset).mockResolvedValue({
			datasetPath: "/workspace/benchmarks/dataset.jsonl",
			datasetName: "dataset.jsonl",
			conversationsIngested: 1,
			turnsIngested: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-09T00:00:00.000Z"),
			completedAt: new Date("2026-04-09T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-workspace-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.jsonl")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, "")
			const expectedDatasetPath = await realpath(datasetPath)
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(datasetDir, "default.jsonl"),
							},
						},
					},
				},
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await benchmarkOps(manager).benchmarkIngest({
				datasetPath: "benchmarks/dataset.jsonl",
			})

			expect(ingestBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: expectedDatasetPath,
					allowedRoots: expect.arrayContaining([workspaceDir, datasetDir]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("routes benchmark ingest through writeConversationEventsBatch", async () => {
		mocked(ingestBenchmarkDataset).mockResolvedValue({
			datasetPath: "/workspace/benchmarks/dataset.jsonl",
			datasetName: "dataset.jsonl",
			conversationsIngested: 1,
			turnsIngested: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-09T00:00:00.000Z"),
			completedAt: new Date("2026-04-09T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-workspace-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.jsonl")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, "")
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
								datasetPath: path.join(datasetDir, "default.jsonl"),
							},
						},
					},
				},
				writeConversationEventsBatch,
			} as unknown as MongoDBMemoryManager

			await benchmarkOps(manager).benchmarkIngest({
				datasetPath: "benchmarks/dataset.jsonl",
			})

			const harnessParams = mocked(ingestBenchmarkDataset).mock.calls[0]?.[0]
			expect(harnessParams?.writeTurns).toBeTypeOf("function")
			await harnessParams?.writeTurns?.([
				{
					role: "user",
					body: "benchmark turn",
					sessionId: "conv-1",
					scope: "agent",
					idempotencyKey: "key-1",
				},
			])
			expect(writeConversationEventsBatch).toHaveBeenCalledTimes(1)
			expect(writeConversationEventsBatch).toHaveBeenCalledWith([
				expect.objectContaining({
					body: "benchmark turn",
					idempotencyKey: "key-1",
				}),
			])
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("rejects benchmark datasets outside allowed roots", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-workspace-"),
		)
		const outsideDir = await mkdtemp(path.join(os.tmpdir(), "memongo-outside-"))
		const outsideFile = path.join(outsideDir, "dataset.jsonl")
		try {
			await writeFile(outsideFile, "")
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(
									workspaceDir,
									"benchmarks",
									"default.jsonl",
								),
							},
						},
					},
				},
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await expect(
				benchmarkOps(manager).benchmarkIngest({
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

	it("allows explicit benchmark dataset roots from the environment", async () => {
		mocked(ingestBenchmarkDataset).mockResolvedValue({
			datasetPath: "/outside/dataset.jsonl",
			datasetName: "dataset.jsonl",
			conversationsIngested: 1,
			turnsIngested: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-09T00:00:00.000Z"),
			completedAt: new Date("2026-04-09T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-workspace-"),
		)
		const outsideDir = await mkdtemp(path.join(os.tmpdir(), "memongo-outside-"))
		const outsideFile = path.join(outsideDir, "dataset.jsonl")
		const previous = process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS
		try {
			await writeFile(outsideFile, "")
			process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS = outsideDir
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(
									workspaceDir,
									"benchmarks",
									"default.jsonl",
								),
							},
						},
					},
				},
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await benchmarkOps(manager).benchmarkIngest({
				datasetPath: outsideFile,
			})

			expect(ingestBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: await realpath(outsideFile),
					allowedRoots: expect.arrayContaining([outsideDir]),
				}),
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS
			} else {
				process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS = previous
			}
			await rm(workspaceDir, { recursive: true, force: true })
			await rm(outsideDir, { recursive: true, force: true })
		}
	})
})

describe("scenario benchmark ingestion", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("routes shipped-profile scenario turns through the canonical batch writer", async () => {
		mocked(ingestBenchmarkConversations).mockResolvedValue({
			datasetPath: "/workspace/benchmarks/dataset.jsonl",
			datasetName: "dataset.jsonl",
			conversationsIngested: 1,
			turnsIngested: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-09T00:00:00.000Z"),
			completedAt: new Date("2026-04-09T00:00:01.000Z"),
		})
		const runContext = { accounting: {} } as never
		const writeConversationEventsBatch = vi
			.fn()
			.mockResolvedValue([{ ok: true, eventId: "event-1", chunkCreated: true }])
		const scenarioManager = {
			agentId: "benchmark-scenario-agent",
			writeConversationEventsBatch,
			stopMemoryJobWorker: vi.fn(async () => {
				throw new Error("stop after ingestion")
			}),
		} as unknown as MongoDBMemoryManager
		const manager = {
			agentId: "benchmark-root-agent",
			createBenchmarkScenarioManager: vi.fn(() => scenarioManager),
			settleBenchmarkScenarioManager: vi.fn(async () => {
				throw new Error("stop after ingestion")
			}),
		} as unknown as MongoDBMemoryManager

		await expect(
			benchmarkOps(manager).runScenarioBenchmarkDataset({
				datasetPath: "/workspace/benchmarks/dataset.jsonl",
				dataset: {
					name: "dataset.jsonl",
					datasetKind: "longmemeval",
					scenarios: [
						{
							scenarioId: "scenario-1",
							conversations: [
								{
									sessionId: "session-1",
									turns: [
										{ role: "user", body: "Remember this" },
										{ role: "assistant", body: "Remembered" },
									],
								},
							],
							evaluations: [],
						},
					],
				} as never,
				datasetVersion: "dataset-version",
				maxResults: 5,
				minScore: 0,
				executionProfile: "shipped",
				runContext,
			}),
		).rejects.toThrow("stop after ingestion")

		const harnessParams = mocked(ingestBenchmarkConversations).mock
			.calls[0]?.[0]
		expect(harnessParams?.writeTurns).toBeTypeOf("function")
		expect(harnessParams?.writeTurn).toBeUndefined()
		const turns = [
			{
				role: "user" as const,
				body: "Remember this",
				sessionId: "session-1",
				scope: "agent" as const,
				idempotencyKey: "key-1",
			},
		]
		await harnessParams?.writeTurns?.(turns)
		expect(writeConversationEventsBatch).toHaveBeenCalledWith(turns, runContext)
	})

	it("fails a publication run when scenario ingest drops any turns", async () => {
		mocked(ingestBenchmarkConversations).mockResolvedValue({
			datasetPath: "/workspace/benchmarks/dataset.jsonl",
			datasetName: "dataset.jsonl",
			conversationsIngested: 1,
			turnsIngested: 1,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 1,
			startedAt: new Date("2026-04-09T00:00:00.000Z"),
			completedAt: new Date("2026-04-09T00:00:01.000Z"),
		})
		const scenarioManager = {
			agentId: "benchmark-scenario-agent",
			writeConversationEventsBatch: vi.fn(),
			stopMemoryJobWorker: vi.fn(async () => {}),
		} as unknown as MongoDBMemoryManager
		const manager = {
			agentId: "benchmark-root-agent",
			db: {
				collection: vi.fn(() => ({
					aggregate: vi.fn(() => ({
						toArray: vi.fn(async () => []),
					})),
				})),
			},
			prefix: "test_",
			createBenchmarkScenarioManager: vi.fn(() => scenarioManager),
			settleBenchmarkScenarioManager: vi.fn(async () => {
				throw new Error("continued after incomplete ingest")
			}),
			cleanupBenchmarkScenarioData: vi.fn(async () => {}),
		} as unknown as MongoDBMemoryManager

		await expect(
			benchmarkOps(manager).runScenarioBenchmarkDataset({
				datasetPath: "/workspace/benchmarks/dataset.jsonl",
				dataset: {
					name: "dataset.jsonl",
					datasetKind: "longmemeval",
					scenarios: [
						{
							scenarioId: "scenario-1",
							conversations: [
								{
									sessionId: "session-1",
									turns: [{ role: "user", body: "Remember this" }],
								},
							],
							evaluations: [],
						},
					],
				} as never,
				datasetVersion: "dataset-version",
				maxResults: 50,
				minScore: 0.01,
				executionProfile: "shipped",
				publicationRun: true,
				runContext: { accounting: {} } as never,
			}),
		).rejects.toThrow(
			"publication benchmark scenario ingest incomplete: scenario=scenario-1 failedTurns=1",
		)
	})
})

describe("benchmark event search convergence", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const makeSearchConvergenceManager = () =>
		Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-benchmark",
			config: {
				mongodb: {
					embeddingMode: "automated",
				},
			},
			capabilities: { textSearch: true, vectorSearch: true },
		}) as MongoDBMemoryManager
	const makeSearchableFind = (values = ["alpha", "beta"]) =>
		vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue(values.map((body) => ({ body }))),
		})
	const makeSearchableTextFind = (values = ["alpha", "beta"]) =>
		vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue(values.map((text) => ({ text }))),
		})

	it("performs exactly one measured raw-session retrieval attempt", async () => {
		const previousAttempts =
			process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS
		const previousDelay = process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS
		process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS = "10"
		process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS = "0"
		try {
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			})
			mocked(sessionChunksCollection).mockReturnValue({ aggregate } as never)
			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).searchBenchmarkRawSession("missing result", {
					maxResults: 5,
					minScore: 0,
				}),
			).resolves.toEqual([])

			expect(aggregate).toHaveBeenCalledTimes(1)
		} finally {
			if (previousAttempts === undefined) {
				delete process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS
			} else {
				process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS = previousAttempts
			}
			if (previousDelay === undefined) {
				delete process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS
			} else {
				process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS = previousDelay
			}
		}
	})

	it("bounds each MongoDB Search convergence probe with maxTimeMS", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "60000"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1234"
		try {
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await benchmarkOps(manager).waitForBenchmarkEventSearchConvergence(
				"agent-1",
			)

			expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
				maxTimeMS: 1234,
				signal: expect.any(AbortSignal),
			})
			const [pipeline] = aggregate.mock.calls[0]
			expect(pipeline[0].$searchMeta.compound.must).toEqual([
				{
					wildcard: {
						path: "body",
						query: "*",
						allowAnalyzedField: true,
					},
				},
			])
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
		}
	})

	it("narrows MongoDB Search convergence probes to scope filters", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1234"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "events_text",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			const find = makeSearchableFind()
			const manager = makeSearchConvergenceManager()

			await benchmarkOps(manager).waitForBenchmarkSearchCollectionConvergence({
				agentId: "agent-1",
				scope: "user",
				scopeRef: "user:bench-17",
				sessionId: "bench-17",
				label: "events",
				collection: { find, aggregate },
				collectionName: "test_events",
				indexName: "test_events_text",
				textPath: "body",
			})

			expect(find).toHaveBeenCalledWith(
				{
					agentId: "agent-1",
					scope: "user",
					scopeRef: "user:bench-17",
					sessionId: "bench-17",
					body: { $type: "string", $ne: "" },
				},
				{ projection: { body: 1 } },
			)
			const [pipeline] = aggregate.mock.calls[0]
			expect(pipeline[0].$searchMeta.compound.filter).toEqual([
				{ equals: { path: "agentId", value: "agent-1" } },
				{ equals: { path: "scope", value: "user" } },
				{ equals: { path: "scopeRef", value: "user:bench-17" } },
				{ equals: { path: "sessionId", value: "bench-17" } },
			])
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
		}
	})

	// Task 1.5 — readSearchIndexStatus delegation tests.
	// The readSearchIndexStatus helper is mocked at module scope; each test
	// overrides the return value for that test.
	it("still probes document visibility when readiness helper reports queryable=true", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const prevSettle =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		const { readSearchIndexStatus } = await import(
			"./mongodb-benchmark-readiness.js"
		)
		try {
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "events_text",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).waitForBenchmarkEventSearchConvergence(
					"agent-ready",
				),
			).resolves.toBeUndefined()
			expect(aggregate).toHaveBeenCalled()
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
			if (prevSettle === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					prevSettle
		}
	})

	it("waits for actual text terms after wildcard document visibility", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const prevSettle =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const prevProbe =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "3000"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1000"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "events_text",
			})
			const textCounts = [0, 1]
			const aggregate = vi
				.fn()
				.mockImplementation((pipeline: Array<unknown>) => {
					const firstStage = pipeline[0] as {
						$searchMeta?: {
							compound?: { must?: Array<Record<string, unknown>> }
						}
					}
					const must = firstStage.$searchMeta?.compound?.must ?? []
					const isTextProbe = Boolean(must[0]?.text)
					return {
						toArray: vi
							.fn()
							.mockResolvedValue([
								{ count: isTextProbe ? (textCounts.shift() ?? 1) : 2 },
							]),
					}
				})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(["alpha", "beta"]),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).waitForBenchmarkEventSearchConvergence(
					"agent-ready",
				),
			).resolves.toBeUndefined()
			expect(aggregate).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({
						$searchMeta: expect.objectContaining({
							compound: expect.objectContaining({
								must: [
									{
										text: {
											path: "body",
											query: "beta",
										},
									},
								],
							}),
						}),
					}),
				]),
				expect.any(Object),
			)
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
			if (prevSettle === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					prevSettle
			if (prevProbe === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = prevProbe
		}
	})

	it("does not wait for non-searchable control-character text", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		const aggregate = vi.fn()
		try {
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(["\u200b"]),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).waitForBenchmarkEventSearchConvergence(
					"agent-zero-width",
				),
			).resolves.toBeUndefined()
			expect(aggregate).not.toHaveBeenCalled()
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("aborts on STALE in strict mode even when queryable=true (Task 1.5)", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "STALE",
				queryable: true,
				indexName: "events_text",
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).waitForBenchmarkEventSearchConvergence(
					"agent-stale",
				),
			).rejects.toThrow(/index-not-ready|STALE/)
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("aborts on queryable=false in strict mode (Task 1.5)", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "BUILDING",
				queryable: false,
				indexName: "events_text",
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).waitForBenchmarkEventSearchConvergence(
					"agent-building",
				),
			).rejects.toThrow(/index-not-ready|queryable=false|BUILDING/)
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("falls back to aggregate probe when helper signals fallback (Task 1.5)", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const prevSettle =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const prevProbe =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		// Use a short settle window so this test stays fast even under the
		// aggregate probe loop.
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1000"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "fallback",
				reason: "command-not-found",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			const start = Date.now()
			await benchmarkOps(manager).waitForBenchmarkEventSearchConvergence(
				"agent-fallback",
			)
			// Aggregate-probe fallback must still bound itself under the
			// configured probeMaxTime — this completes well under 2s.
			expect(Date.now() - start).toBeLessThan(3000)
			expect(aggregate).toHaveBeenCalled()
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
			if (prevSettle === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					prevSettle
			if (prevProbe === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = prevProbe
		}
	})

	it("probes raw-session readiness through the session_chunks vector index", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS = "1234"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind(),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await benchmarkOps(manager).waitForBenchmarkSearchConvergence({
				agentId: "agent-raw",
				retrievalLane: "raw-session",
				scope: "user",
				scopeRef: "user:bench-17",
				sessionId: "bench-17",
			})

			expect(aggregate).toHaveBeenCalledWith(
				[
					{
						$vectorSearch: expect.objectContaining({
							exact: true,
							filter: {
								agentId: "agent-raw",
								scope: "user",
								scopeRef: "user:bench-17",
								sessionId: "bench-17",
							},
							index: "test_session_chunks_vector",
							model: "voyage-4-lite",
							path: "text",
							query: { text: "benchmark vector readiness probe" },
						}),
					},
					{ $count: "count" },
				],
				{ maxTimeMS: 1234, signal: expect.any(AbortSignal) },
			)
			expect(
				(
					mocked(sessionChunksCollection).mock.results[0]?.value as {
						find: ReturnType<typeof vi.fn>
					}
				).find,
			).toHaveBeenCalledWith(
				{
					agentId: "agent-raw",
					scope: "user",
					scopeRef: "user:bench-17",
					sessionId: "bench-17",
					text: { $type: "string", $ne: "" },
				},
				{ projection: { text: 1 } },
			)
			expect(eventsCollection).not.toHaveBeenCalled()
			expect(chunksCollection).not.toHaveBeenCalled()
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
		}
	})

	it("uses longer strict defaults for raw-session vector probes", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		const previousFallbackTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
		const previousFallbackProbeTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
		delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind(),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await benchmarkOps(manager).waitForBenchmarkSearchConvergence({
				agentId: "agent-defaults",
				retrievalLane: "raw-session",
			})

			expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
				maxTimeMS: 30000,
				signal: expect.any(AbortSignal),
			})
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousFallbackTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					previousFallbackTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
			if (previousFallbackProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS =
					previousFallbackProbeTimeout
			}
		}
	})

	it("waits through pending raw-session vector readiness when aggregate results are visible", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "PENDING",
				queryable: false,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind(),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).waitForBenchmarkSearchConvergence({
					agentId: "agent-pending",
					retrievalLane: "raw-session",
				}),
			).resolves.toBeUndefined()
			expect(aggregate).toHaveBeenCalled()
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
		}
	})

	it("fails strict raw-session convergence when no session evidence documents exist", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn()
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind([]),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await expect(
				benchmarkOps(manager).waitForBenchmarkSearchConvergence({
					agentId: "agent-missing-session-evidence",
					retrievalLane: "raw-session",
				}),
			).rejects.toThrow(
				"benchmark session_chunks vector convergence has no searchable documents",
			)
			expect(aggregate).not.toHaveBeenCalled()
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
		}
	})
})
