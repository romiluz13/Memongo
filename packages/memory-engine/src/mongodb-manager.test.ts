/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	classifyCanonicalIngestHealth,
	classifyProjectionHealth,
	classifyRetrievalHealth,
	computeOverallV2Health,
	deduplicateSearchResults,
	getActiveSources,
	getActiveSourcesForStatus,
	MongoDBMemoryManager,
	resolveExplainSources,
	writeEventAndProject,
	searchV2,
	getV2Status,
	rerankResults,
} from "./mongodb-manager.js"
import {
	ingestBenchmarkDataset,
	importConversationDataset,
	loadBenchmarkDataset,
} from "./mongodb-benchmark-harness.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { checkCache, writeCache } from "./mongodb-query-cache.js"
import type { MemorySearchResult } from "./types.js"

// ---------------------------------------------------------------------------
// Mocks for v2 module dependencies
// ---------------------------------------------------------------------------

vi.mock("./mongodb-events.js", () => ({
	writeEvent: vi.fn(),
	projectChunksFromEvents: vi.fn(),
	projectEventChunk: vi.fn(),
	getEventsByTimeRange: vi.fn(),
}))

vi.mock("./mongodb-ops.js", () => ({
	recordIngestRun: vi.fn(),
	getProjectionLag: vi.fn(),
	getLatestIngestRun: vi.fn(),
	getLatestProjectionRun: vi.fn(),
}))

vi.mock("./mongodb-benchmark-harness.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-benchmark-harness.js")
	>("./mongodb-benchmark-harness.js")
	return {
		...actual,
		ingestBenchmarkDataset: vi.fn(),
		importConversationDataset: vi.fn(),
		loadBenchmarkDataset: vi.fn(),
	}
})

vi.mock("./mongodb-retrieval-planner.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-retrieval-planner.js")
	>("./mongodb-retrieval-planner.js")
	return {
		...actual,
		planRetrieval: vi.fn(),
	}
})

vi.mock("./mongodb-episodes.js", () => ({
	searchEpisodes: vi.fn(),
}))

vi.mock("./mongodb-graph.js", () => ({
	searchEntitiesAutocomplete: vi.fn(),
	expandGraph: vi.fn(),
	extractAndUpsertEntities: vi.fn(),
}))

vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
	entitiesCollection: vi.fn(),
	relationsCollection: vi.fn(),
	episodesCollection: vi.fn(),
	proceduresCollection: vi.fn(),
	chunksCollection: vi.fn(),
	filesCollection: vi.fn(),
	metaCollection: vi.fn(),
	kbCollection: vi.fn(),
	kbChunksCollection: vi.fn(),
	relevanceRunsCollection: vi.fn(),
	structuredMemCollection: vi.fn(),
	embeddingCacheCollection: vi.fn(),
	detectCapabilities: vi.fn(),
	ensureCollections: vi.fn(),
	ensureSchemaValidation: vi.fn(),
	ensureSearchIndexes: vi.fn(),
	ensureStandardIndexes: vi.fn(),
}))

vi.mock("./mongodb-query-cache.js", () => ({
	checkCache: vi.fn(),
	writeCache: vi.fn(),
}))

vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
	updateLaneCoverage: vi.fn(),
}))

vi.mock("./mongodb-memory-jobs.js", () => ({
	createMemoryJob: vi.fn(),
	getMemoryJob: vi.fn(),
	listMemoryJobs: vi.fn(),
	updateMemoryJob: vi.fn(),
}))

vi.mock("./mongodb-consolidator.js", () => ({
	consolidateMemory: vi.fn(),
}))

vi.mock("./mongodb-derived-memory.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-derived-memory.js")
	>("./mongodb-derived-memory.js")
	return {
		...actual,
		heuristicEpisodeSummarizer: vi.fn(async () => ({
			title: "Thread: synthetic",
			summary: "Synthetic summary",
		})),
		promoteDerivedMemoryFromEvent: vi.fn(),
		resolveStructuredCandidatesForPromotion: vi.fn(async () => []),
		extractProcedureCandidatesFromEvent: vi.fn(() => []),
	}
})

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Phase 3: Result dedup at merge by content hash
// ---------------------------------------------------------------------------

describe("deduplicateSearchResults", () => {
	const makeResult = (
		filePath: string,
		snippet: string,
		score: number,
		source: MemorySearchResult["source"],
	): MemorySearchResult => ({
		filePath,
		path: filePath,
		startLine: 1,
		endLine: 1,
		snippet,
		score,
		source,
	})

	it("removes duplicate results by content, keeping the highest-scoring one", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "same content here", 0.9, "conversation"),
			makeResult("/b.md", "same content here", 0.7, "reference"),
			makeResult("/c.md", "different content", 0.8, "structured"),
		]

		const deduped = deduplicateSearchResults(results)
		expect(deduped).toHaveLength(2)
		// The duplicate "same content here" should keep the one with score 0.9
		const sameContentResult = deduped.find(
			(r) => r.snippet === "same content here",
		)
		expect(sameContentResult?.score).toBe(0.9)
		expect(sameContentResult?.filePath).toBe("/a.md")
	})

	it("returns empty array for empty input", () => {
		const deduped = deduplicateSearchResults([])
		expect(deduped).toHaveLength(0)
	})

	it("keeps all results when no duplicates exist", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "first content", 0.9, "conversation"),
			makeResult("/b.md", "second content", 0.7, "reference"),
			makeResult("/c.md", "third content", 0.5, "structured"),
		]

		const deduped = deduplicateSearchResults(results)
		expect(deduped).toHaveLength(3)
	})

	it("handles multiple duplicates correctly", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "alpha content", 0.3, "conversation"),
			makeResult("/b.md", "alpha content", 0.9, "reference"),
			makeResult("/c.md", "alpha content", 0.5, "structured"),
			makeResult("/d.md", "beta content", 0.8, "conversation"),
			makeResult("/e.md", "beta content", 0.6, "structured"),
		]

		const deduped = deduplicateSearchResults(results)
		expect(deduped).toHaveLength(2)
		const alpha = deduped.find((r) => r.snippet === "alpha content")
		expect(alpha?.score).toBe(0.9)
		const beta = deduped.find((r) => r.snippet === "beta content")
		expect(beta?.score).toBe(0.8)
	})

	it("returns dedupCount in the result when logging is needed", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "dup content", 0.9, "conversation"),
			makeResult("/b.md", "dup content", 0.7, "reference"),
		]

		// The function should return deduped results — the count of removed duplicates
		// can be derived from input.length - output.length
		const deduped = deduplicateSearchResults(results)
		const dedupCount = results.length - deduped.length
		expect(dedupCount).toBe(1)
	})
})

describe("benchmarkIngest", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves workspace-relative benchmark datasets before replay", async () => {
		vi.mocked(ingestBenchmarkDataset).mockResolvedValue({
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
})

describe("importConversations", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves workspace-relative conversation imports before replay", async () => {
		vi.mocked(importConversationDataset).mockResolvedValue({
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
})

describe("relevanceBenchmark", () => {
	beforeEach(() => {
		vi.clearAllMocks()
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
			vi.mocked(loadBenchmarkDataset).mockResolvedValue({
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
			})

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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				buildBenchmarkDatasetVersion:
					MongoDBMemoryManager.prototype.buildBenchmarkDatasetVersion,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark: vi.fn(),
			} as unknown as MongoDBMemoryManager

			const result =
				await MongoDBMemoryManager.prototype.relevanceBenchmark.call(manager, {
					datasetPath: "benchmarks/dataset.json",
				})

			expect(loadBenchmarkDataset).toHaveBeenCalledWith(
				resolvedDatasetPath,
				expect.objectContaining({
					allowedRoots: expect.arrayContaining([workspaceDir, datasetDir]),
				}),
			)
			expect(runScenarioBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: resolvedDatasetPath,
					datasetVersion: createHash("sha256")
						.update('{"name":"placeholder"}')
						.digest("hex")
						.slice(0, 16),
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
			vi.mocked(loadBenchmarkDataset).mockRejectedValue(
				new Error("benchmark dataset contains no valid conversations"),
			)
			const runLegacyRelevanceBenchmark = vi.fn().mockResolvedValue({
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
			})

			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								enabled: true,
								datasetPath: path.join(datasetDir, "default.jsonl"),
							},
						},
					},
				},
				relevance: {
					loadBenchmarkDataset: vi
						.fn()
						.mockResolvedValue([{ query: "legacy" }]),
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				runScenarioBenchmarkDataset: vi.fn(),
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			const result =
				await MongoDBMemoryManager.prototype.relevanceBenchmark.call(manager, {
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
			vi.mocked(loadBenchmarkDataset).mockResolvedValue({
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
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				buildBenchmarkDatasetVersion:
					MongoDBMemoryManager.prototype.buildBenchmarkDatasetVersion,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			await expect(
				MongoDBMemoryManager.prototype.relevanceBenchmark.call(manager, {
					datasetPath: "benchmarks/dataset.json",
				}),
			).rejects.toThrow("scenario search timeout")
			expect(runLegacyRelevanceBenchmark).not.toHaveBeenCalled()
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})

describe("runScenarioBenchmarkDataset", () => {
	it("continues scoring after an individual evaluation query fails", async () => {
		const search = vi
			.fn()
			.mockRejectedValueOnce(new Error("search timeout"))
			.mockResolvedValueOnce([
				{
					path: "memory://result",
					startLine: 1,
					endLine: 1,
					score: 0.9,
					snippet: "memory hit",
					source: "conversation",
					sessionId: "session-2",
				},
			] satisfies MemorySearchResult[])

		const manager = {
			agentId: "agent-1",
			relevance: {
				persistRegression: vi.fn().mockResolvedValue([]),
			},
			search,
			listBenchmarkEventEvidence: vi.fn().mockResolvedValue({
				sessionIds: new Map<string, string>(),
				turnIds: new Map<string, string>(),
				dialogIds: new Map<string, string>(),
			}),
			collectBenchmarkResultSourceEventIds:
				MongoDBMemoryManager.prototype.collectBenchmarkResultSourceEventIds,
			resolveBenchmarkResultSessionIds:
				MongoDBMemoryManager.prototype.resolveBenchmarkResultSessionIds,
			resolveBenchmarkResultTurnIds:
				MongoDBMemoryManager.prototype.resolveBenchmarkResultTurnIds,
			resolveBenchmarkResultDialogIds:
				MongoDBMemoryManager.prototype.resolveBenchmarkResultDialogIds,
		} as unknown as MongoDBMemoryManager

		const result =
			await MongoDBMemoryManager.prototype.runScenarioBenchmarkDataset.call(
				manager,
				{
					datasetPath: "/tmp/benchmark.json",
					dataset: {
						name: "LongMemEval sample",
						datasetKind: "longmemeval",
						scenarios: [
							{
								scenarioId: "scenario-1",
								conversations: [],
								evaluations: [
									{
										caseId: "case-1",
										query: "First question",
										expectedSessionIds: ["session-1"],
										questionType: "single-session",
									},
									{
										caseId: "case-2",
										query: "Second question",
										expectedSessionIds: ["session-2"],
										questionType: "single-session",
									},
								],
							},
						],
						evaluations: [],
						conversations: [],
					},
					datasetVersion: "dataset-v1",
					maxResults: 10,
					minScore: 0.1,
				},
			)

		expect(search).toHaveBeenCalledTimes(2)
		expect(result.cases).toBe(2)
		expect(result.scoredCases).toBe(2)
		expect(result.hitRate).toBe(0.5)
		expect(result.rAt10).toBe(0.5)
	})

	it("hashes the raw dataset file to build scenario datasetVersion", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-benchmark-version-"),
		)
		const datasetPath = path.join(workspaceDir, "dataset.json")
		const datasetText =
			'{"name":"LongMemEval sample","scenarios":[{"scenarioId":"scenario-1"}]}\n'
		try {
			await writeFile(datasetPath, datasetText, "utf8")

			const datasetVersion =
				await MongoDBMemoryManager.prototype.buildBenchmarkDatasetVersion.call(
					{} as MongoDBMemoryManager,
					datasetPath,
				)

			expect(datasetVersion).toBe(
				createHash("sha256").update(datasetText).digest("hex").slice(0, 16),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})

// ---------------------------------------------------------------------------
// Phase 3: Source policy enforcement helpers
// ---------------------------------------------------------------------------

describe("getActiveSources", () => {
	it("returns all sources when all enabled", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, true)
		expect(active.conversation).toBe(true)
		expect(active.reference).toBe(true)
		expect(active.structured).toBe(true)
	})

	it("disables conversation search when conversation.enabled is false", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: false },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, true)
		expect(active.conversation).toBe(false)
		expect(active.reference).toBe(true)
		expect(active.structured).toBe(true)
	})

	it("disables reference (KB) search when reference.enabled is false", () => {
		const sources = {
			reference: { enabled: false },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, true)
		expect(active.reference).toBe(false)
	})

	it("disables reference when kb is disabled even if reference.enabled is true", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, false)
		expect(active.reference).toBe(false)
	})

	it("disables structured search when structured.enabled is false", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: false },
		}
		const active = getActiveSources(sources, true)
		expect(active.structured).toBe(false)
	})

	it("disables all sources when all are disabled", () => {
		const sources = {
			reference: { enabled: false },
			conversation: { enabled: false },
			structured: { enabled: false },
		}
		const active = getActiveSources(sources, true)
		expect(active.conversation).toBe(false)
		expect(active.reference).toBe(false)
		expect(active.structured).toBe(false)
	})
})

describe("getActiveSourcesForStatus", () => {
	it("returns only enabled source names", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: false },
		}
		const names = getActiveSourcesForStatus(sources, true)
		expect(names).toContain("conversation")
		expect(names).toContain("reference")
		expect(names).not.toContain("structured")
	})

	it("returns empty array when all sources disabled", () => {
		const sources = {
			reference: { enabled: false },
			conversation: { enabled: false },
			structured: { enabled: false },
		}
		const names = getActiveSourcesForStatus(sources, true)
		expect(names).toHaveLength(0)
	})

	it("excludes reference when kb is disabled", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const names = getActiveSourcesForStatus(sources, false)
		expect(names).not.toContain("reference")
		expect(names).toContain("conversation")
		expect(names).toContain("structured")
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

// ---------------------------------------------------------------------------
// Phase 8: Wire v2 into MongoDBMemoryManager
// ---------------------------------------------------------------------------

// Dynamic imports for mocked modules
const { writeEvent, projectEventChunk, getEventsByTimeRange } = await import(
	"./mongodb-events.js"
)
const { recordIngestRun, getProjectionLag } = await import("./mongodb-ops.js")
const { planRetrieval } = await import("./mongodb-retrieval-planner.js")
const { searchEpisodes } = await import("./mongodb-episodes.js")
const { searchEntitiesAutocomplete, expandGraph } = await import(
	"./mongodb-graph.js"
)
const {
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	episodesCollection,
	proceduresCollection,
	relevanceRunsCollection,
} = await import("./mongodb-schema.js")

// Fake Db — the real calls are mocked at the module level
const fakeDb = {} as unknown as import("mongodb").Db
const fakePrefix = "test_"

// ---------------------------------------------------------------------------
// 8.1: writeEventAndProject
// ---------------------------------------------------------------------------

// Covered by real-e2e-v2 E2E tests. This unit seam still depends
// on a stale module-mock architecture and should be rewritten around a fake Db.
describe("writeEventAndProject", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls writeEvent + projectEventChunk + recordIngestRun and returns result", async () => {
		vi.mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-03-16T00:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		vi.mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		vi.mocked(recordIngestRun).mockResolvedValue("run-1")

		const result = await writeEventAndProject(fakeDb, fakePrefix, {
			agentId: "agent-1",
			role: "user",
			body: "Hello world",
			scope: "agent",
		})

		expect(result.eventId).toBe("evt-1")
		expect(result.chunksCreated).toBe(1)

		expect(writeEvent).toHaveBeenCalledOnce()
		expect(projectEventChunk).toHaveBeenCalledOnce()
		expect(recordIngestRun).toHaveBeenCalledWith(
			expect.objectContaining({
				db: fakeDb,
				prefix: fakePrefix,
				run: expect.objectContaining({
					agentId: "agent-1",
					source: "event-write",
					status: "ok",
					itemsProcessed: 1,
					itemsFailed: 0,
				}),
			}),
		)
	})

	it("records failed ingest on error and re-throws", async () => {
		const error = new Error("write failed")
		vi.mocked(writeEvent).mockRejectedValue(error)
		vi.mocked(recordIngestRun).mockResolvedValue("run-fail")

		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("write failed")

		// Should record a failed ingest run
		expect(recordIngestRun).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					status: "failed",
					itemsProcessed: 0,
					itemsFailed: 1,
				}),
			}),
		)
	})

	it("swallows recordIngestRun failure in catch path to not mask real error", async () => {
		const realError = new Error("write failed")
		vi.mocked(writeEvent).mockRejectedValue(realError)
		vi.mocked(recordIngestRun).mockRejectedValue(
			new Error("ingest record also failed"),
		)

		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("write failed")
	})

	it("rejects invalid scope values", async () => {
		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "invalid-scope",
			}),
		).rejects.toThrow("Invalid scope: invalid-scope")
	})

	it("rejects invalid role values", async () => {
		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "invalid-role",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("Invalid role: invalid-role")
	})
})

// ---------------------------------------------------------------------------
// 8.2: searchV2
// ---------------------------------------------------------------------------

// The real searchV2 pipeline is covered by src/memory/real-e2e-v2.e2e.test.ts.
// This mock-heavy orchestration block is parked until it is redesigned around
// explicit dependency injection or a fake Db harness.
describe("searchV2", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses retrieval planner and executes paths, returning results + metadata", async () => {
		vi.mocked(planRetrieval).mockReturnValue({
			paths: ["episodic", "hybrid", "raw-window"],
			confidence: "high",
			reasoning: "episodic keywords",
		})

		vi.mocked(searchEpisodes).mockResolvedValue([
			{
				episodeId: "ep-1",
				title: "Morning standup",
				summary: "Discussed sprint goals",
				type: "daily",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timeRange: { start: new Date(), end: new Date() },
				sourceEventCount: 1,
				updatedAt: new Date(),
			},
		])

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"summarize today",
			"agent-1",
			{
				availablePaths: new Set([
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
				]),
				searchOptions: {
					allowHybridBackstop: false,
				},
			},
		)

		expect(planRetrieval).toHaveBeenCalledOnce()
		expect(result.metadata.plan.paths).toContain("episodic")
		expect(result.metadata.pathsExecuted).toContain("episodic")
		expect(result.results.length).toBeGreaterThan(0)
		expect(result.results[0].snippet).toContain("Morning standup")
	})

	it("continues when one path fails (inner try/catch per path)", async () => {
		vi.mocked(planRetrieval).mockReturnValue({
			paths: ["episodic", "raw-window", "hybrid"],
			confidence: "medium",
			reasoning: "test",
		})

		// Episodic fails
		vi.mocked(searchEpisodes).mockRejectedValue(new Error("episodic broke"))

		// Raw-window succeeds
		vi.mocked(getEventsByTimeRange).mockResolvedValue([
			{
				eventId: "e-1",
				body: "recent event",
				role: "user",
				timestamp: new Date(),
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		])

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"what happened recently",
			"agent-1",
			{
				availablePaths: new Set([
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
				]),
				searchOptions: {
					allowHybridBackstop: false,
				},
			},
		)

		// Should still have results from raw-window despite episodic failure
		expect(result.results.length).toBeGreaterThan(0)
		expect(result.metadata.pathsExecuted).toContain("raw-window")
		expect(result.metadata.pathsExecuted).not.toContain("episodic")
	})

	it("ranks raw-window events by query relevance before pure recency", async () => {
		vi.mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "medium",
			reasoning: "conversation scope requested",
		})

		vi.mocked(getEventsByTimeRange).mockResolvedValue([
			{
				eventId: "evt-recent",
				body: "I will keep concise updates and track the Phoenix deploy checklist.",
				role: "assistant",
				timestamp: new Date("2026-04-05T22:39:50.981Z"),
				agentId: "agent-1",
				scope: "session",
				scopeRef: "session:session-1",
				sessionId: "session-1",
			},
			{
				eventId: "evt-marker",
				body: "capability-marker-8c79e671 Alice is handling the Phoenix release blocker.",
				role: "user",
				timestamp: new Date("2026-04-05T22:36:50.981Z"),
				agentId: "agent-1",
				scope: "session",
				scopeRef: "session:session-1",
				sessionId: "session-1",
			},
		])

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"capability-marker-8c79e671",
			"agent-1",
			{
				availablePaths: new Set(["raw-window"]),
				searchOptions: {
					scope: "session",
					scopeRef: "session:session-1",
					conversationScope: { sessionKey: "session-1" },
				},
			},
		)

		expect(result.metadata.pathsExecuted).toContain("raw-window")
		expect(result.results[0]?.path).toBe("events/evt-marker")
		expect(result.results[0]?.sessionId).toBe("session-1")
	})

	it("executes graph path when entity names are provided", async () => {
		vi.mocked(planRetrieval).mockReturnValue({
			paths: ["graph", "hybrid", "raw-window"],
			confidence: "high",
			reasoning: "known entity detected",
		})

		vi.mocked(searchEntitiesAutocomplete).mockResolvedValue([
			{
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date(),
			},
		])
		vi.mocked(expandGraph).mockResolvedValue({
			rootEntity: {
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date(),
			},
			connections: [
				{
					entity: {
						entityId: "ent-2",
						name: "ProjectX",
						type: "project",
						agentId: "agent-1",
						scope: "agent",
						updatedAt: new Date(),
					},
					relation: {
						fromEntityId: "ent-1",
						toEntityId: "ent-2",
						type: "works_on",
						agentId: "agent-1",
						scope: "agent",
						updatedAt: new Date(),
					},
					depth: 0,
				},
			],
		})

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"what does Alice work on",
			"agent-1",
			{
				availablePaths: new Set([
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
				]),
				knownEntityNames: ["Alice"],
				searchOptions: {
					allowHybridBackstop: false,
				},
			},
		)

		expect(searchEntitiesAutocomplete).toHaveBeenCalledOnce()
		expect(expandGraph).toHaveBeenCalledOnce()
		expect(result.metadata.pathsExecuted).toContain("graph")
		expect(result.results.length).toBeGreaterThan(0)
	})

	it("passes the planned time-range end into graph expansion asOf", async () => {
		vi.useFakeTimers()
		try {
			const now = new Date("2026-04-11T12:00:00.000Z")
			vi.setSystemTime(now)
			vi.mocked(planRetrieval).mockReturnValue({
				paths: ["graph"],
				confidence: "high",
				reasoning: "known entity with temporal constraint",
				constraints: {
					timeRange: {
						preset: "last-7d",
						hard: true,
						reason: "explicit last-week constraint",
					},
					entities: { names: ["Alice"] },
				},
			})
			vi.mocked(searchEntitiesAutocomplete).mockResolvedValue([
				{
					entityId: "ent-1",
					name: "Alice",
					type: "person",
					agentId: "agent-1",
					scope: "agent",
					updatedAt: new Date(),
				},
			])
			vi.mocked(expandGraph).mockResolvedValue({
				rootEntity: {
					entityId: "ent-1",
					name: "Alice",
					type: "person",
					agentId: "agent-1",
					scope: "agent",
					updatedAt: new Date(),
				},
				connections: [],
			})

			await searchV2(
				fakeDb,
				fakePrefix,
				"what did Alice work on last week",
				"agent-1",
				{
					availablePaths: new Set(["graph"]),
					knownEntityNames: ["Alice"],
				},
			)

			expect(expandGraph).toHaveBeenCalledWith(
				expect.objectContaining({
					entityId: "ent-1",
					agentId: "agent-1",
					asOf: now,
				}),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("accepts questionDate in searchOptions type for post-retrieval scoring", async () => {
		vi.mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "high",
			reasoning: "temporal query",
		})

		const recentTimestamp = new Date("2024-03-14T00:00:00Z")
		const oldTimestamp = new Date("2023-01-01T00:00:00Z")

		vi.mocked(getEventsByTimeRange).mockResolvedValue([
			{
				_id: "evt-old",
				eventId: "evt-old",
				body: "weather in Paris is nice today",
				role: "user",
				timestamp: oldTimestamp,
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				sessionId: "sess-1",
				channel: "default",
			},
			{
				_id: "evt-recent",
				eventId: "evt-recent",
				body: "Tokyo restaurant was amazing last week",
				role: "user",
				timestamp: recentTimestamp,
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				sessionId: "sess-1",
				channel: "default",
			},
		])

		const questionDate = new Date("2024-03-15T00:00:00Z")
		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"What about the Tokyo restaurant last week",
			"agent-1",
			{
				availablePaths: new Set(["raw-window"]),
				searchOptions: {
					allowHybridBackstop: false,
					questionDate,
				},
			},
		)

		// Post-retrieval scoring with questionDate should execute without error
		// and return results (the scoring is ranking-only)
		expect(result.results.length).toBeGreaterThan(0)
	})
})

// ---------------------------------------------------------------------------
// 8.3: getV2Status
// ---------------------------------------------------------------------------

describe("v2 health classification helpers", () => {
	it("classifies ingest health from the latest ingest run", () => {
		expect(classifyCanonicalIngestHealth(null)).toBe("health-uncertain")
		expect(classifyCanonicalIngestHealth({ status: "ok" })).toBe("ok")
		expect(classifyCanonicalIngestHealth({ status: "failed" })).toBe(
			"canonical-ingest-failed",
		)
	})

	it("classifies projection health from latest run and lag", () => {
		expect(
			classifyProjectionHealth({ latestRun: null, lagSeconds: null }),
		).toBe("health-uncertain")
		expect(
			classifyProjectionHealth({
				latestRun: { status: "failed" },
				lagSeconds: null,
			}),
		).toBe("derived-product-unavailable")
		expect(
			classifyProjectionHealth({
				latestRun: { status: "ok" },
				lagSeconds: 601,
			}),
		).toBe("projection-behind")
		expect(
			classifyProjectionHealth({ latestRun: { status: "ok" }, lagSeconds: 12 }),
		).toBe("ok")
	})

	it("distinguishes degraded retrieval from no relevant results", () => {
		expect(classifyRetrievalHealth({ status: null, hitSources: null })).toEqual(
			{
				state: "health-uncertain",
				recentNoRelevantResults: false,
			},
		)
		expect(
			classifyRetrievalHealth({ status: "ok", hitSources: ["conversation"] }),
		).toEqual({
			state: "ok",
			recentNoRelevantResults: false,
		})
		expect(
			classifyRetrievalHealth({ status: "degraded", hitSources: [] }),
		).toEqual({
			state: "retrieval-degraded",
			recentNoRelevantResults: true,
		})
	})

	it("computes the overall status from retrieval, ingest, and derived-product states", () => {
		expect(
			computeOverallV2Health({
				retrieval: "ok",
				canonicalIngest: "ok",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("ok")
		expect(
			computeOverallV2Health({
				retrieval: "retrieval-degraded",
				canonicalIngest: "ok",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("degraded")
		expect(
			computeOverallV2Health({
				retrieval: "ok",
				canonicalIngest: "health-uncertain",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("health-uncertain")
	})
})

// Covered by real v2 status checks in the live MongoDB gate. This unit block
// still assumes a stale module-mock seam.
describe("getV2Status", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns counts, projection lag, and retrieval paths", async () => {
		const latestDate = new Date("2026-03-15T12:00:00Z")

		const mockCountDocuments = vi.fn().mockResolvedValue(42)
		const eventCol = {
			countDocuments: mockCountDocuments,
			findOne: vi.fn().mockResolvedValue({ timestamp: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const derivedCol = {
			countDocuments: mockCountDocuments,
			findOne: vi.fn().mockResolvedValue({ updatedAt: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const relevanceCol = {
			findOne: vi.fn().mockResolvedValue({ status: "ok", hitSources: ["kb"] }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(entitiesCollection).mockReturnValue(derivedCol)
		vi.mocked(relationsCollection).mockReturnValue(derivedCol)
		vi.mocked(episodesCollection).mockReturnValue(derivedCol)
		vi.mocked(proceduresCollection).mockReturnValue(derivedCol)
		vi.mocked(relevanceRunsCollection).mockReturnValue(relevanceCol)

		vi.mocked(getProjectionLag)
			.mockResolvedValueOnce(10) // chunks lag
			.mockResolvedValueOnce(20) // entities lag
			.mockResolvedValueOnce(30) // relations lag
			.mockResolvedValueOnce(null) // episodes lag (no data)
			.mockResolvedValueOnce(40) // structured lag
			.mockResolvedValueOnce(50) // procedures lag

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		expect(status.events.count).toBe(42)
		expect(status.events.latestTimestamp).toEqual(latestDate)
		expect(status.entities.count).toBe(42)
		expect(status.relations.count).toBe(42)
		expect(status.episodes.count).toBe(42)
		expect(status.procedures.count).toBe(42)
		expect(status.projectionLag.chunks).toBe(10)
		expect(status.projectionLag.entities).toBe(20)
		expect(status.projectionLag.relations).toBe(30)
		expect(status.projectionLag.episodes).toBeNull()
		expect(status.retrievalPaths).toEqual(
			expect.arrayContaining([
				"structured",
				"raw-window",
				"graph",
				"hybrid",
				"kb",
				"episodic",
			]),
		)
	})

	it("returns partial results when some queries fail (Promise.allSettled)", async () => {
		// Events collection works, but entities/relations/episodes reject
		const workingCol = {
			countDocuments: vi.fn().mockResolvedValue(10),
			findOne: vi
				.fn()
				.mockResolvedValue({ timestamp: new Date("2026-03-15T12:00:00Z") }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const failingCol = {
			countDocuments: vi.fn().mockRejectedValue(new Error("connection lost")),
			findOne: vi.fn().mockRejectedValue(new Error("connection lost")),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		vi.mocked(eventsCollection).mockReturnValue(workingCol)
		vi.mocked(entitiesCollection).mockReturnValue(failingCol)
		vi.mocked(relationsCollection).mockReturnValue(failingCol)
		vi.mocked(episodesCollection).mockReturnValue(failingCol)
		vi.mocked(proceduresCollection).mockReturnValue(failingCol)
		vi.mocked(relevanceRunsCollection).mockReturnValue(failingCol)

		vi.mocked(getProjectionLag)
			.mockResolvedValueOnce(5) // chunks lag works
			.mockRejectedValueOnce(new Error("timeout")) // entities lag fails
			.mockResolvedValueOnce(15) // relations lag works
			.mockRejectedValueOnce(new Error("timeout")) // episodes lag fails
			.mockRejectedValueOnce(new Error("timeout")) // structured lag fails
			.mockRejectedValueOnce(new Error("timeout")) // procedures lag fails

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		// Working values preserved
		expect(status.events.count).toBe(10)
		expect(status.events.latestTimestamp).toEqual(
			new Date("2026-03-15T12:00:00Z"),
		)
		expect(status.projectionLag.chunks).toBe(5)
		expect(status.projectionLag.relations).toBe(15)

		// Failed values default to safe fallbacks
		expect(status.entities.count).toBe(0)
		expect(status.relations.count).toBe(0)
		expect(status.episodes.count).toBe(0)
		expect(status.procedures.count).toBe(0)
		expect(status.projectionLag.entities).toBeNull()
		expect(status.projectionLag.episodes).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Tests: rerankResults
// ---------------------------------------------------------------------------

describe("rerankResults", () => {
	const makeResult = (
		path: string,
		snippet: string,
		score: number,
		source: MemorySearchResult["source"],
	): MemorySearchResult => ({
		path,
		filePath: path,
		startLine: 0,
		endLine: 0,
		snippet,
		score,
		source,
	})

	it("returns empty array for empty input", () => {
		const result = rerankResults([], "query")
		expect(result).toHaveLength(0)
	})

	it("applies source diversity penalty (no >2 from same source at top)", () => {
		const results = [
			makeResult("event:1", "text1", 0.95, "conversation"),
			makeResult("event:2", "text2", 0.9, "conversation"),
			makeResult("event:3", "text3", 0.85, "conversation"),
			makeResult("struct:1", "text4", 0.8, "structured"),
		]
		const reranked = rerankResults(results, "query")
		// The 3rd conversation result should be penalized below structured
		const top3Sources = reranked.slice(0, 3).map((r) => r.source)
		expect(top3Sources).toContain("structured")
	})

	it("boosts episode results", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("episode:ep1", "Episode: summary", 0.8, "conversation"),
		]
		const reranked = rerankResults(results, "query")
		// Episode should be boosted above the event (0.80 + 0.12 = 0.92 > 0.90)
		expect(reranked[0].path).toBe("episode:ep1")
	})

	it("respects custom weights", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("episode:ep1", "text2", 0.8, "conversation"),
		]
		// With zero episode boost, original order preserved
		const reranked = rerankResults(results, "query", { episodeBoost: 0 })
		expect(reranked[0].path).toBe("event:1")
	})

	it("does not mutate original array", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("event:2", "text2", 0.85, "conversation"),
		]
		const originalOrder = results.map((r) => r.path)
		rerankResults(results, "query")
		expect(results.map((r) => r.path)).toEqual(originalOrder)
	})
})

// ---------------------------------------------------------------------------
// Telemetry emission from writeEventAndProject
// ---------------------------------------------------------------------------

describe("writeEventAndProject telemetry emission", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("emits event-write telemetry after successful write", async () => {
		const { writeEvent } = await import("./mongodb-events.js")
		const { projectEventChunk } = await import("./mongodb-events.js")
		const { recordIngestRun } = await import("./mongodb-ops.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")

		vi.mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-03-16T00:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		vi.mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		vi.mocked(recordIngestRun).mockResolvedValue("run-1")
		vi.mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})

		const fakeDb = { collection: vi.fn() } as unknown as import("mongodb").Db
		await writeEventAndProject(fakeDb, "test_", {
			agentId: "agent-1",
			role: "user",
			body: "Hello world",
			scope: "agent",
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			fakeDb,
			"test_",
			expect.objectContaining({
				meta: { agentId: "agent-1", operation: "event-write" },
				ok: true,
				eventType: "user",
				projectionTriggered: true,
				durationMs: expect.any(Number),
			}),
		)
	})
})

describe("MongoDBMemoryManager consolidate job tracking", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does not abort consolidation when createMemoryJob fails", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { consolidateMemory } = await import("./mongodb-consolidator.js")

		vi.mocked(createMemoryJob).mockRejectedValue(new Error("job create failed"))
		vi.mocked(consolidateMemory).mockResolvedValue({
			runId: "run-1",
			eventsProcessed: 3,
			factsPromoted: 2,
			factsPruned: 0,
			conflictsResolved: 0,
			durationMs: 25,
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager

		const result = await manager.consolidate({ maxEvents: 10 })

		expect(result.eventsProcessed).toBe(3)
		expect(createMemoryJob).toHaveBeenCalledTimes(1)
		expect(updateMemoryJob).not.toHaveBeenCalled()
	})

	it("preserves the original consolidation error when failed job update also fails", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { consolidateMemory } = await import("./mongodb-consolidator.js")

		vi.mocked(createMemoryJob).mockResolvedValue("job-1")
		vi.mocked(consolidateMemory).mockRejectedValue(new Error("boom"))
		vi.mocked(updateMemoryJob).mockRejectedValue(new Error("job update failed"))

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager

		await expect(manager.consolidate({ scope: "workspace" })).rejects.toThrow(
			"boom",
		)
		expect(updateMemoryJob).toHaveBeenCalledTimes(1)
	})
})

describe("MongoDBMemoryManager background extraction", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("schedules and runs a single-event extraction job", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		vi.mocked(createMemoryJob).mockResolvedValue("extraction-evt-1")
		vi.mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-1",
				agentId: "agent-1",
				role: "assistant",
				body: "Remember this: ship Batch F after tests pass.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			})),
		} as unknown as import("mongodb").Collection)
		vi.mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 1,
			proceduresCreated: 0,
			skipped: false,
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				workspaceDir: "/tmp/memongo",
				derivationQueue: Promise.resolve(),
			},
		) as MongoDBMemoryManager & { derivationQueue: Promise<void> }

		const result = await manager.extractEvent({ eventId: "evt-1" })
		await manager.derivationQueue

		expect(result).toEqual({
			jobId: "extraction-evt-1",
			scheduled: true,
		})
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobId: "extraction-evt-1",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					metadata: { eventId: "evt-1" },
				}),
			}),
		)
		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({
					eventId: "evt-1",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					workspaceDir: "/tmp/memongo",
				}),
			}),
		)
		expect(updateMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-1",
				status: "running",
			}),
		)
		expect(updateMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-1",
				status: "completed",
				inputCount: 1,
				outputCount: 1,
			}),
		)
	})

	it("treats duplicate extraction jobs as already scheduled", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		vi.mocked(createMemoryJob).mockRejectedValue({ code: 11000 })

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				derivationQueue: Promise.resolve(),
			},
		) as MongoDBMemoryManager & { derivationQueue: Promise<void> }

		const result = await manager.extractEvent({ eventId: "evt-1" })
		await manager.derivationQueue

		expect(result).toEqual({
			jobId: "extraction-evt-1",
			scheduled: false,
		})
		expect(promoteDerivedMemoryFromEvent).not.toHaveBeenCalled()
		expect(updateMemoryJob).not.toHaveBeenCalled()
	})

	it("rejects blank event ids at the manager boundary", async () => {
		const { createMemoryJob } = await import("./mongodb-memory-jobs.js")

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				derivationQueue: Promise.resolve(),
			},
		) as MongoDBMemoryManager & { derivationQueue: Promise<void> }

		await expect(manager.extractEvent({ eventId: "   " })).rejects.toThrow(
			"eventId is required",
		)
		expect(createMemoryJob).not.toHaveBeenCalled()
	})

	it("schedules extraction automatically after event writes", async () => {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		vi.mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		vi.mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		vi.mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		vi.mocked(createMemoryJob).mockResolvedValue("extraction-evt-1")
		vi.mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-1",
				agentId: "agent-1",
				role: "assistant",
				body: "Remember this: deployment is blocked by legal review.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			})),
		} as unknown as import("mongodb").Collection)
		vi.mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: true,
			skipReason: "already-promoted",
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: {
					mongodb: {
						embeddingMode: "automated",
						episodes: { enabled: false, minEventsForEpisode: 6 },
					},
				},
				workspaceDir: "/tmp/memongo",
				writeQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
				chunkCount: 0,
				dirty: true,
			},
		) as MongoDBMemoryManager & {
			writeQueue: Promise<void>
			derivationQueue: Promise<void>
		}

		const result = await manager.writeConversationEvent({
			role: "assistant",
			body: "Remember this: deployment is blocked by legal review.",
			scope: "agent",
		})
		await manager.derivationQueue

		expect(result).toEqual({
			eventId: "evt-1",
			chunkCreated: false,
		})
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobId: "extraction-evt-1",
					jobType: "extraction",
				}),
			}),
		)
		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Scope-safe cache writes: search() and searchDetailed() must use the
// resolved search scope, not hard-coded "agent"
// ---------------------------------------------------------------------------

describe("scope-safe cache writes", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function buildMockManager(overrides?: Record<string, unknown>) {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			agentScopeRef: "agent:agent-1",
			workspaceScopeRef: "workspace:agent-1",
			client: undefined,
			capabilities: {
				vectorSearch: false,
				textSearch: false,
				rankFusion: false,
				scoreFusion: false,
			},
			config: {
				mongodb: {
					embeddingMode: "automated",
					fusionMethod: "rankFusion",
					numCandidates: 200,
					cache: {
						enabled: true,
						conversationTtlSec: 300,
						kbTtlSec: 600,
					},
					// sources omitted — getActiveSources defaults to all enabled
					kb: { enabled: false },
					episodes: { enabled: true, minEventsForEpisode: 6 },
					graph: { enabled: false },
					reranking: { enabled: false },
					queryRewriting: { enabled: false },
				},
			},
			extraMemoryPaths: [],
			writeQueue: Promise.resolve(),
			derivationQueue: Promise.resolve(),
			chunkCount: 0,
			dirty: true,
			lastSearchMode: "legacy",
			accessTracker: null,
			relevance: null,
			...overrides,
		}) as MongoDBMemoryManager
	}

	it("search() writes cache with session scope when sessionKey is provided", async () => {
		// Cache miss so the search pipeline runs
		vi.mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: undefined,
			results: [],
		} as never)

		// Planner returns episodic path — which is fully mocked
		vi.mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "test scope cache",
		})

		vi.mocked(searchEpisodes).mockResolvedValue([
			{
				episodeId: "ep-scope-1",
				title: "Scope session episode",
				summary: "Evidence for session",
				type: "daily",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timeRange: { start: new Date(), end: new Date() },
				sourceEventCount: 1,
				updatedAt: new Date(),
			},
		])

		const manager = buildMockManager()
		await manager.search("what did we discuss?", {
			sessionKey: "sess-1",
		})

		expect(writeCache).toHaveBeenCalledTimes(1)
		const writeCacheArgs = vi.mocked(writeCache).mock.calls[0]![0]
		// BUG: currently writes scope: "agent" — should be "session"
		expect(writeCacheArgs.scope).toBe("session")
		expect(writeCacheArgs.scopeRef).toBe("session:sess-1")
	})

	it("search() reads cache with session scope when sessionKey is provided", async () => {
		vi.mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: undefined,
			results: [],
		} as never)

		vi.mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "test scope in cache read",
		})

		vi.mocked(searchEpisodes).mockResolvedValue([])

		const manager = buildMockManager()
		await manager.search("what did we discuss?", {
			sessionKey: "sess-3",
		})

		// BUG: currently reads cache with scope: "agent" — should be "session"
		expect(checkCache).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "session",
				scopeRef: "session:sess-3",
			}),
		)
	})
})
