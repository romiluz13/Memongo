/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	type MongoDBMemoryManager,
	resolveExplainSources,
} from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"
import { loadBenchmarkDataset } from "./mongodb-benchmark-harness.js"
import { resolveRegisteredBenchmarkQualityContract } from "./benchmark-quality-contracts.js"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	mocked,
	testBenchmarkRunConfiguration,
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
		"snapshotBenchmarkRunConfiguration",
		"runScenarioBenchmarkDataset",
		"runLegacyRelevanceBenchmark",
		"buildBenchmarkParityBundle",
		"buildBenchmarkDatasetVersion",
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

describe("relevanceBenchmark", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("isolates accounting when benchmark runs overlap on one manager", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-overlapping-bench-"),
		)
		const firstPath = path.join(workspaceDir, "first.json")
		const secondPath = path.join(workspaceDir, "second.json")
		let markFirstEntered: (() => void) | undefined
		let releaseFirst: (() => void) | undefined
		const firstEntered = new Promise<void>((resolve) => {
			markFirstEntered = resolve
		})
		const firstCanFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		try {
			await writeFile(firstPath, '{"name":"first"}')
			await writeFile(secondPath, '{"name":"second"}')
			mocked(loadBenchmarkDataset).mockResolvedValue({
				name: "overlap",
				datasetKind: "generic",
				conversations: [],
				evaluations: [],
				scenarios: [
					{
						scenarioId: "scenario-1",
						conversations: [],
						evaluations: [
							{
								caseId: "case-1",
								query: "question",
								expectedSessionIds: ["session-1"],
							},
						],
					},
				],
			})

			const runScenarioBenchmarkDataset = vi.fn(async (params) => {
				if (path.basename(params.datasetPath) === "first.json") {
					params.runContext.accounting.recordAttempt("rerank")
					params.runContext.accounting.recordFailure("rerank")
					markFirstEntered?.()
					await firstCanFinish
				} else {
					params.runContext.accounting.recordAttempt("answer-generation")
					params.runContext.accounting.recordSuccess("answer-generation")
					releaseFirst?.()
				}
				return {
					result: {
						datasetVersion: params.datasetVersion,
						datasetName: path.basename(params.datasetPath),
						datasetKind: "generic" as const,
						scenarios: 1,
						cases: 1,
						scoredCases: 1,
						skippedCases: 0,
						hitRate: 1,
						emptyRate: 0,
						avgTopScore: 0.9,
						p95LatencyMs: 10,
						rAt5: 1,
						rAt10: 1,
						ndcgAt10: 1,
						questionTypeBreakdown: [],
						regressions: [],
					},
					latencySamples: [10],
				}
			})
			const buildBenchmarkParityBundle = vi.fn(async (params) => ({
				runIdentity: {
					datasetSha256: params.datasetSha256Override,
					retrievalUnit: "turn" as const,
				},
				embedding: {
					model: "mongodb-automated",
					dimensions: 1024,
					quantization: "float32" as const,
				},
				reranker: { model: "none", version: null, stage: "none" as const },
				storage: {
					basis: "benchmark-agent-logical-plus-shared-physical" as const,
					tenant: { documents: 0, logicalBytes: 0, collections: [] },
					sharedPhysical: { collections: [] },
				},
				latency: { p50Ms: 10, p95Ms: 10 },
				cost: params.runContext.accounting.snapshot(),
			}))
			const manager = {
				workspaceDir,
				db: { command: vi.fn() },
				prefix: "memongo_bench_",
				config: {
					mongodb: {
						relevance: { benchmark: { enabled: true, datasetPath: firstPath } },
						numDimensions: 1024,
						quantization: "none",
						reranking: {
							enabled: false,
							model: "none",
							topN: 0,
							minScore: 0.01,
						},
					},
				},
				relevance: { loadBenchmarkDataset: vi.fn() },
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark: vi.fn(),
				buildBenchmarkParityBundle,
			} as unknown as MongoDBMemoryManager

			const firstRun = benchmarkOps(manager).relevanceBenchmark({
				datasetPath: firstPath,
			})
			await firstEntered
			const secondRun = benchmarkOps(manager).relevanceBenchmark({
				datasetPath: secondPath,
			})
			const [first, second] = await Promise.all([firstRun, secondRun])

			expect(
				first.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "rerank",
				),
			).toEqual(expect.objectContaining({ attempted: 1, failed: 1 }))
			expect(
				first.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "answer-generation",
				),
			).toEqual(expect.objectContaining({ observability: "not-run" }))
			expect(
				second.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "answer-generation",
				),
			).toEqual(expect.objectContaining({ attempted: 1, succeeded: 1 }))
			expect(
				second.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "rerank",
				),
			).toEqual(expect.objectContaining({ observability: "not-run" }))
			const contexts = runScenarioBenchmarkDataset.mock.calls.map(
				([params]) => params.runContext,
			)
			expect(contexts[0]).not.toBe(contexts[1])
			expect(contexts[0].runId).not.toBe(contexts[1].runId)
		} finally {
			releaseFirst?.()
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("routes scenario datasets through the new scenario benchmark runner", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.json")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, JSON.stringify({ name: "placeholder" }))
			const resolvedDatasetPath = await realpath(datasetPath)
			mocked(loadBenchmarkDataset).mockResolvedValue({
				name: "LongMemEval sample",
				datasetKind: "longmemeval",
				conversations: [],
				evaluations: [],
				scenarios: [
					{
						scenarioId: "scenario-1",
						conversations: [],
						evaluations: [
							{
								caseId: "case-1",
								query: "When is the launch?",
								expectedSessionIds: ["session-1"],
							},
						],
					},
				],
			})

			const runScenarioBenchmarkDataset = vi.fn().mockResolvedValue({
				result: {
					datasetVersion: "dataset-v1",
					datasetName: "LongMemEval sample",
					datasetKind: "longmemeval",
					scenarios: 1,
					cases: 1,
					scoredCases: 1,
					skippedCases: 0,
					hitRate: 1,
					emptyRate: 0,
					avgTopScore: 0.9,
					p95LatencyMs: 10,
					rAt5: 1,
					rAt10: 1,
					ndcgAt10: 1,
					questionTypeBreakdown: [],
					regressions: [],
				},
				latencySamples: [10],
			})

			const manager = {
				workspaceDir,
				db: {
					command: vi.fn().mockResolvedValue({ size: 0, totalIndexSize: 0 }),
				},
				prefix: "memongo_bench_",
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								enabled: true,
								datasetPath: path.join(datasetDir, "default.json"),
							},
						},
						numDimensions: 1024,
						quantization: "none",
						reranking: { enabled: false, model: "rerank-2.5", topN: 20 },
					},
				},
				relevance: {
					loadBenchmarkDataset: vi.fn(),
				},
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark: vi.fn(),
			} as unknown as MongoDBMemoryManager

			const result = await benchmarkOps(manager).relevanceBenchmark({
				datasetPath: "benchmarks/dataset.json",
				qualityThresholds: {
					contractId: "longmemeval-release",
					version: "1",
					datasetKind: "longmemeval",
					minHitRate: 0.8,
					maxEmptyRate: 0.2,
					minRAt5: 0.8,
					minNdcgAt10: 0.8,
					maxP95LatencyMs: 1_000,
					minSessionRecallAnyAt10: 0.8,
					minSessionNdcgAnyAt10: 0.8,
				},
			})

			expect(loadBenchmarkDataset).toHaveBeenCalledWith(
				resolvedDatasetPath,
				expect.objectContaining({
					allowedRoots: expect.arrayContaining([workspaceDir, datasetDir]),
				}),
			)
			expect(resolveRegisteredBenchmarkQualityContract).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetSha256: createHash("sha256")
						.update('{"name":"placeholder"}')
						.digest("hex"),
				}),
			)
			expect(runScenarioBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: resolvedDatasetPath,
					maxResults: 50,
					executionProfile: "shipped",
					datasetVersion: createHash("sha256")
						.update('{"name":"placeholder"}')
						.digest("hex"),
				}),
			)
			expect(result.queryGovernance).toEqual(
				expect.objectContaining({
					status: "advisory-only",
				}),
			)
			expect(result.benchmarkReport).toEqual(
				expect.objectContaining({
					generatedAt: expect.any(Date),
					corpus: expect.objectContaining({
						datasetVersion: "dataset-v1",
						datasetName: "LongMemEval sample",
						datasetKind: "longmemeval",
						cases: 1,
						scoredCases: 1,
					}),
					metrics: expect.objectContaining({
						internal: expect.objectContaining({
							rAt5: 1,
							ndcgAt10: 1,
						}),
					}),
					releaseGates: expect.arrayContaining([
						expect.objectContaining({
							gate: "query-governance",
							status: "advisory-only",
						}),
					]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("rejects a declared dataset digest before benchmark execution", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-sha-"),
		)
		const datasetPath = path.join(workspaceDir, "dataset.json")
		try {
			await writeFile(datasetPath, '{"name":"actual-bytes"}')
			const runScenarioBenchmarkDataset = vi.fn()
			const runLegacyRelevanceBenchmark = vi.fn()
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: { enabled: true, datasetPath },
						},
						reranking: { minScore: 0.01 },
					},
				},
				relevance: { loadBenchmarkDataset: vi.fn() },
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			await expect(
				benchmarkOps(manager).relevanceBenchmark({
					datasetPath,
					datasetSha256: "a".repeat(64),
				}),
			).rejects.toThrow(/does not match dataset bytes/i)
			expect(loadBenchmarkDataset).not.toHaveBeenCalled()
			expect(runScenarioBenchmarkDataset).not.toHaveBeenCalled()
			expect(runLegacyRelevanceBenchmark).not.toHaveBeenCalled()
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("falls back to the legacy benchmark path for query-only datasets", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.jsonl")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, '{"query":"legacy"}\n')
			const resolvedDatasetPath = await realpath(datasetPath)
			mocked(loadBenchmarkDataset).mockRejectedValue(
				new Error("benchmark dataset contains no valid conversations"),
			)
			const runLegacyRelevanceBenchmark = vi.fn().mockResolvedValue({
				result: {
					datasetVersion: "legacy-v1",
					cases: 1,
					hitRate: 1,
					emptyRate: 0,
					avgTopScore: 0.8,
					p95LatencyMs: 12,
					rAt5: 0,
					rAt10: 0,
					ndcgAt10: 0,
					regressions: [],
				},
				latencySamples: [12],
			})

			const manager = {
				workspaceDir,
				db: {
					command: vi.fn().mockResolvedValue({ size: 0, totalIndexSize: 0 }),
				},
				prefix: "memongo_bench_",
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								enabled: true,
								datasetPath: path.join(datasetDir, "default.jsonl"),
							},
						},
						numDimensions: 1024,
						quantization: "none",
						reranking: { enabled: false, model: "rerank-2.5", topN: 20 },
					},
				},
				relevance: {
					loadBenchmarkDataset: vi
						.fn()
						.mockResolvedValue([{ query: "legacy" }]),
				},
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
				runScenarioBenchmarkDataset: vi.fn(),
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			const result = await benchmarkOps(manager).relevanceBenchmark({
				datasetPath: "benchmarks/dataset.jsonl",
			})

			expect(runLegacyRelevanceBenchmark).toHaveBeenCalledWith({
				datasetPath: resolvedDatasetPath,
				maxResults: 10,
				minScore: 0.01,
			})
			expect(result.queryGovernance?.candidates[0]?.source).toBe("benchmark")
			expect(result.benchmarkReport).toEqual(
				expect.objectContaining({
					corpus: expect.objectContaining({
						datasetVersion: "legacy-v1",
						cases: 1,
					}),
					warnings: expect.arrayContaining([
						expect.stringContaining("officialMetrics are absent"),
					]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("does not silently fall back to legacy when scenario execution fails", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.json")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, JSON.stringify({ name: "placeholder" }))
			mocked(loadBenchmarkDataset).mockResolvedValue({
				name: "LongMemEval sample",
				datasetKind: "longmemeval",
				conversations: [],
				evaluations: [],
				scenarios: [
					{
						scenarioId: "scenario-1",
						conversations: [],
						evaluations: [
							{
								caseId: "case-1",
								query: "When is the launch?",
								expectedSessionIds: ["session-1"],
							},
						],
					},
				],
			})

			const runLegacyRelevanceBenchmark = vi.fn()
			const runScenarioBenchmarkDataset = vi
				.fn()
				.mockRejectedValue(new Error("scenario search timeout"))

			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								enabled: true,
								datasetPath: path.join(datasetDir, "default.json"),
							},
						},
					},
				},
				relevance: {
					loadBenchmarkDataset: vi.fn(),
				},
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			await expect(
				benchmarkOps(manager).relevanceBenchmark({
					datasetPath: "benchmarks/dataset.json",
				}),
			).rejects.toThrow("scenario search timeout")
			expect(runLegacyRelevanceBenchmark).not.toHaveBeenCalled()
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})

// ---------------------------------------------------------------------------
// Phase 3 REM-FIX: relevanceExplain source policy filtering
// ---------------------------------------------------------------------------

describe("resolveExplainSources", () => {
	const allActive = { conversation: true, reference: true, structured: true }

	it("allows memory scope when conversation source is active", () => {
		const result = resolveExplainSources("memory", allActive)
		expect(result).toEqual({
			conversation: true,
			reference: false,
			structured: false,
		})
	})

	it("disables memory scope when conversation source is inactive", () => {
		const result = resolveExplainSources("memory", {
			...allActive,
			conversation: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("allows kb scope when reference source is active", () => {
		const result = resolveExplainSources("kb", allActive)
		expect(result).toEqual({
			conversation: false,
			reference: true,
			structured: false,
		})
	})

	it("disables kb scope when reference source is inactive", () => {
		const result = resolveExplainSources("kb", {
			...allActive,
			reference: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("allows structured scope when structured source is active", () => {
		const result = resolveExplainSources("structured", allActive)
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: true,
		})
	})

	it("disables structured scope when structured source is inactive", () => {
		const result = resolveExplainSources("structured", {
			...allActive,
			structured: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("returns all active sources for 'all' scope", () => {
		const result = resolveExplainSources("all", allActive)
		expect(result).toEqual({
			conversation: true,
			reference: true,
			structured: true,
		})
	})

	it("filters inactive sources from 'all' scope", () => {
		const result = resolveExplainSources("all", {
			conversation: true,
			reference: false,
			structured: true,
		})
		expect(result).toEqual({
			conversation: true,
			reference: false,
			structured: true,
		})
	})

	it("returns all disabled for 'all' scope when all sources disabled", () => {
		const result = resolveExplainSources("all", {
			conversation: false,
			reference: false,
			structured: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})
})
