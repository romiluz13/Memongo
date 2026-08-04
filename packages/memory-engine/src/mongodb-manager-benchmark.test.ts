/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	ingestBenchmarkDataset,
	importConversationDataset,
} from "./mongodb-benchmark-harness.js"
import type { RelevanceBenchmarkResult } from "./mongodb-relevance.js"
import type { MemoryBenchmarkDataset, MemorySearchResult } from "./types.js"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	mocked,
	testBenchmarkRunContext,
	fakeDb,
	fakePrefix,
} from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkQualityContractsModuleMock(importOriginal),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-benchmark-harness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkHarnessModuleMock(),
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

vi.mock("./mongodb-benchmark-readiness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkReadinessModuleMock(),
)

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

const { eventsCollection, chunksCollection, sessionChunksCollection } =
	await import("./mongodb-schema.js")

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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.benchmarkIngest.call(manager, {
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEventsBatch,
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.benchmarkIngest.call(manager, {
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await expect(
				MongoDBMemoryManager.prototype.benchmarkIngest.call(manager, {
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.benchmarkIngest.call(manager, {
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						searchBenchmarkRawSession: (
							this: MongoDBMemoryManager,
							query: string,
							opts: { maxResults: number; minScore: number },
						) => Promise<MemorySearchResult[]>
					}
				).searchBenchmarkRawSession.call(manager, "missing result", {
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

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkEventSearchConvergence: (
						this: MongoDBMemoryManager,
						agentId: string,
					) => Promise<void>
				}
			).waitForBenchmarkEventSearchConvergence.call(manager, "agent-1")

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

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkSearchCollectionConvergence: (
						this: MongoDBMemoryManager,
						params: {
							agentId: string
							scope?:
								| "session"
								| "user"
								| "agent"
								| "workspace"
								| "tenant"
								| "global"
							scopeRef?: string
							sessionId?: string
							label: string
							collection: unknown
							collectionName: string
							indexName: string
							textPath: string
						},
					) => Promise<void>
				}
			).waitForBenchmarkSearchCollectionConvergence.call(manager, {
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(manager, "agent-ready"),
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(manager, "agent-ready"),
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(
					manager,
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(manager, "agent-stale"),
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(
					manager,
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
			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkEventSearchConvergence: (
						this: MongoDBMemoryManager,
						agentId: string,
					) => Promise<void>
				}
			).waitForBenchmarkEventSearchConvergence.call(manager, "agent-fallback")
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

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkSearchConvergence: (
						this: MongoDBMemoryManager,
						params: {
							agentId: string
							retrievalLane?: "native" | "raw-session"
							scope?:
								| "session"
								| "user"
								| "agent"
								| "workspace"
								| "tenant"
								| "global"
							scopeRef?: string
							sessionId?: string
						},
					) => Promise<void>
				}
			).waitForBenchmarkSearchConvergence.call(manager, {
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
							model: "voyage-4-large",
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

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkSearchConvergence: (
						this: MongoDBMemoryManager,
						params: {
							agentId: string
							retrievalLane?: "native" | "raw-session"
						},
					) => Promise<void>
				}
			).waitForBenchmarkSearchConvergence.call(manager, {
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkSearchConvergence: (
							this: MongoDBMemoryManager,
							params: {
								agentId: string
								retrievalLane?: "native" | "raw-session"
							},
						) => Promise<void>
					}
				).waitForBenchmarkSearchConvergence.call(manager, {
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
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkSearchConvergence: (
							this: MongoDBMemoryManager,
							params: {
								agentId: string
								retrievalLane?: "native" | "raw-session"
							},
						) => Promise<void>
					}
				).waitForBenchmarkSearchConvergence.call(manager, {
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
			} as unknown as MongoDBMemoryManager

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						settleBenchmarkScenarioManager: (
							this: MongoDBMemoryManager,
							manager: MongoDBMemoryManager,
						) => Promise<void>
					}
				).settleBenchmarkScenarioManager.call(manager, manager),
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

	// Task 1.3 — complete queue-settle timeout coverage (plan Harness Checklist #3).
	const callSettle = async (manager: MongoDBMemoryManager) =>
		(
			MongoDBMemoryManager.prototype as unknown as {
				settleBenchmarkScenarioManager: (
					this: MongoDBMemoryManager,
					manager: MongoDBMemoryManager,
				) => Promise<void>
			}
		).settleBenchmarkScenarioManager.call(manager, manager)

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
			} as unknown as MongoDBMemoryManager
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
			} as unknown as MongoDBMemoryManager
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
			} as unknown as MongoDBMemoryManager
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
			} as unknown as MongoDBMemoryManager
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
			} as MongoDBMemoryManager & {
				derivationSchedulingQueue: Promise<void>
				derivationQueue: Promise<void>
			}
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
			} as unknown as MongoDBMemoryManager
			await expect(callSettle(manager)).resolves.toBeUndefined()
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("stops an isolated durable worker before measuring and cleaning its scenario", async () => {
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
			startedAt: new Date("2026-04-09T12:00:00.000Z"),
			completedAt: new Date("2026-04-09T12:00:01.000Z"),
		})
		const scenarioManager = {
			agentId: "benchmark-isolated-worker",
			stopMemoryJobWorker: vi.fn(async () => {
				order.push("stop")
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
								return []
							}),
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
				cleanupBenchmarkScenarioData: vi.fn(async () => {
					order.push("cleanup")
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

		await (
			MongoDBMemoryManager.prototype as unknown as {
				runScenarioBenchmarkDataset: (
					this: MongoDBMemoryManager,
					params: {
						datasetPath: string
						dataset: MemoryBenchmarkDataset
						datasetVersion: string
						maxResults: number
						minScore: number
						retrievalLane: "native"
						executionProfile: "shipped"
						runContext: ReturnType<typeof testBenchmarkRunContext>
					},
				) => Promise<unknown>
			}
		).runScenarioBenchmarkDataset.call(manager, {
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testBenchmarkRunContext("worker-cleanup"),
		})

		expect(order[0]).toBe("stop")
		expect(order.at(-1)).toBe("cleanup")
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
			stopMemoryJobWorker: vi.fn(async () => {}),
		} as unknown as MongoDBMemoryManager
		const flushBenchmarkQueryCache = vi.fn(async () => {
			order.push("flush")
		})
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
				flushBenchmarkQueryCache,
				cleanupBenchmarkScenarioData: vi.fn(async () => {
					order.push("cleanup")
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

		const result = (await (
			MongoDBMemoryManager.prototype as unknown as {
				runScenarioBenchmarkDataset: (
					this: MongoDBMemoryManager,
					params: {
						datasetPath: string
						dataset: MemoryBenchmarkDataset
						datasetVersion: string
						maxResults: number
						minScore: number
						retrievalLane: "native"
						executionProfile: "shipped"
						runContext: ReturnType<typeof testBenchmarkRunContext>
					},
				) => Promise<{ result: RelevanceBenchmarkResult }>
			}
		).runScenarioBenchmarkDataset.call(manager, {
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testBenchmarkRunContext("measurement-passes"),
		})) as { result: RelevanceBenchmarkResult }

		// Ingest, convergence, and cleanup happen once; only the eval loop repeats.
		expect(order).toEqual([
			"ingest",
			"converge",
			"search",
			"flush",
			"search",
			"flush",
			"search",
			"cleanup",
		])
		expect(flushBenchmarkQueryCache).toHaveBeenCalledWith(
			"benchmark-measurement-passes",
		)
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
			startedAt: new Date("2026-04-09T12:00:00.000Z"),
			completedAt: new Date("2026-04-09T12:00:01.000Z"),
		})
		const search = vi.fn(async () => [] as MemorySearchResult[])
		const scenarioManager = {
			agentId: "benchmark-single-pass",
			search,
			stopMemoryJobWorker: vi.fn(async () => {}),
		} as unknown as MongoDBMemoryManager
		const flushBenchmarkQueryCache = vi.fn(async () => {})
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
				flushBenchmarkQueryCache,
				cleanupBenchmarkScenarioData: vi.fn(async () => {}),
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

		const result = (await (
			MongoDBMemoryManager.prototype as unknown as {
				runScenarioBenchmarkDataset: (
					this: MongoDBMemoryManager,
					params: {
						datasetPath: string
						dataset: MemoryBenchmarkDataset
						datasetVersion: string
						maxResults: number
						minScore: number
						retrievalLane: "native"
						executionProfile: "shipped"
						runContext: ReturnType<typeof testBenchmarkRunContext>
					},
				) => Promise<{ result: RelevanceBenchmarkResult }>
			}
		).runScenarioBenchmarkDataset.call(manager, {
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testBenchmarkRunContext("single-pass"),
		})) as { result: RelevanceBenchmarkResult }

		expect(search).toHaveBeenCalledTimes(1)
		expect(flushBenchmarkQueryCache).not.toHaveBeenCalled()
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.importConversations.call(manager, {
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await expect(
				MongoDBMemoryManager.prototype.importConversations.call(manager, {
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.importConversations.call(manager, {
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEventsBatch,
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.importConversations.call(manager, {
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
