/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi } from "vitest"
import type { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function benchmarkOps(
	manager: MongoDBMemoryManager,
): MongoDBManagerBenchmarkOps {
	const ops = new MongoDBManagerBenchmarkOps(
		manager as unknown as MongoDBManagerHost,
	)
	const managerRecord = manager as unknown as Record<string, unknown>
	const opsRecord = ops as unknown as Record<string, unknown>
	for (const method of [
		"listBenchmarkEventEvidence",
		"collectBenchmarkResultSourceEventIds",
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

vi.mock("./benchmark-relevance.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./benchmark-relevance.js")>()),
	persistBenchmarkRegression: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../packages/memory-engine/src/mongodb-telemetry.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).telemetryModuleMock(),
)

describe("runScenarioBenchmarkDataset", () => {
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
		} as unknown as MongoDBMemoryManager

		const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
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
		})

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

			const datasetVersion = await benchmarkOps(
				{} as MongoDBMemoryManager,
			).buildBenchmarkDatasetVersion(datasetPath)

			expect(datasetVersion).toBe(
				createHash("sha256").update(datasetText).digest("hex"),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})
