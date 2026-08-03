/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import type { MemorySearchResult } from "./types.js"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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

describe("runScenarioBenchmarkDataset", () => {
	it("forces production derived work for the shipped benchmark profile", () => {
		vi.stubEnv("MEMONGO_BENCHMARK_DERIVED_WORK_MODE", "disabled")
		const enabled =
			MongoDBMemoryManager.prototype.shouldRunPostWriteDerivedWork.call({
				benchmarkShippedProfile: true,
			} as unknown as MongoDBMemoryManager)
		expect(enabled).toBe(true)
		vi.unstubAllEnvs()
	})

	it("continues after an individual query failure without scoring it as a miss", async () => {
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "")
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
						name: "LoCoMo sample",
						datasetKind: "locomo",
						scenarios: [
							{
								scenarioId: "scenario-1",
								conversations: [],
								evaluations: [
									{
										caseId: "case-1",
										query: "First question",
										expectedSessionIds: ["session-1"],
										answer: "First answer",
										questionType: "single-session",
									},
									{
										caseId: "case-2",
										query: "Second question",
										expectedSessionIds: ["session-2"],
										answer: "Second answer",
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
		// Phase 3 REM-FIX Task 1.A: runScenarioBenchmarkDataset now returns
		// `{ result, latencySamples }` so the caller can project parity fields.
		expect(result.result.cases).toBe(2)
		expect(result.result.scoredCases).toBe(1)
		expect(result.result.hitRate).toBe(1)
		expect(result.result.rAt10).toBe(1)
		expect(result.result.execution).toEqual({
			attemptedCases: 2,
			succeededCases: 1,
			failedCases: 1,
			retrievalEligibleCases: 2,
			abstentionCases: 0,
			missingJudgmentCases: 0,
			retrievalHits: 1,
			retrievalMisses: 0,
			scoredCases: 1,
		})
		expect(result.latencySamples).toHaveLength(2)
		// P4.1: the e2e QA answer+judge producer moved out of the shipped engine
		// (scripts/mongodb-e2e-qa.ts); the manager no longer populates e2eQa.
		expect(result.e2eQa).toBeUndefined()
		vi.unstubAllEnvs()
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
				createHash("sha256").update(datasetText).digest("hex"),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})
