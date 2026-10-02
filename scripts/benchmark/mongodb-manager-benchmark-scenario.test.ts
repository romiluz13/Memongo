/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi } from "vitest"
import type { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"
import type { BenchmarkCheckpoint } from "./mongodb-benchmark-checkpoint.js"
import { readBenchmarkCheckpoint } from "./mongodb-benchmark-checkpoint.js"
import { createOperationRunContext } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import {
	prepareOfficialQa,
	scoreOfficialScenario,
	summarizeOfficialBenchmarkQaRun,
} from "./longmemeval-official-scoring.js"
import type { OfficialQaContext } from "./longmemeval-official-scoring.js"
import { OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION } from "./longmemeval-official-qa.js"
import { createOfficialPredictionSidecar } from "./longmemeval-prediction-sidecar.js"
import type { OfficialPredictionSidecarIdentity } from "./longmemeval-prediction-sidecar.js"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Mock provider resolution for both benchmark and answer-quality callers.
// Routing by prompt shape (no dataset content, no network):
//   - official anscheck judge prompt (Slice A, byte-exact): contains
//     "Model Response:" and expects a plain yes/no verdict;
//   - custom-v1 judge prompt: contains "GOLD ANSWER:" and expects JSON;
//   - answer-generation prompts (both protocols) expect {"answer":"..."}.
const { enrichmentProbe } = vi.hoisted(() => {
	let chatCompletions = 0
	let officialJudgeFailuresRemaining = 0
	const provider = {
		name: "synthetic-deterministic",
		chatCompletion: async (params: {
			messages: Array<{ role: string; content: string }>
		}) => {
			chatCompletions += 1
			// Official anscheck judge: plain yes/no verdict.
			if (
				params.messages
					.find((m) => m.role === "user")
					?.content.includes("Model Response:")
			) {
				if (officialJudgeFailuresRemaining > 0) {
					officialJudgeFailuresRemaining -= 1
					throw new Error("synthetic official judge transport failure")
				}
				const user =
					params.messages.find((message) => message.role === "user")?.content ??
					""
				const candidate = /Model Response: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
				if (user.includes("unanswerable")) {
					return {
						content: candidate.toLowerCase().includes("not") ? "yes" : "no",
					}
				}
				const gold = /Correct Answer: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
				return { content: candidate === gold ? "yes" : "no" }
			}
			const user =
				params.messages.find((message) => message.role === "user")?.content ??
				""
			// generation prompt: QUESTION + context, no "GOLD ANSWER:"
			if (!user.includes("GOLD ANSWER:")) {
				const answer = user.includes("case one") ? "violet" : "emerald"
				return { content: JSON.stringify({ answer }) }
			}
			// judge prompt: QUESTION + GOLD ANSWER + CANDIDATE ANSWER
			const isCaseOne = user.includes("case one")
			const candidate = /CANDIDATE ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
			const gold = isCaseOne ? "violet" : "emerald"
			return {
				content: JSON.stringify({
					correct: candidate === gold,
					rationale:
						candidate === gold ? "candidate matches gold" : "wrong fact",
				}),
			}
		},
	}
	return {
		enrichmentProbe: {
			provider,
			get chatCompletions() {
				return chatCompletions
			},
			/** Inject N official-judge transport failures (crash simulation). */
			failNextOfficialJudges(count: number) {
				officialJudgeFailuresRemaining = count
			},
			reset() {
				chatCompletions = 0
				officialJudgeFailuresRemaining = 0
			},
		},
	}
})

vi.mock(
	"../../packages/memory-engine/src/mongodb-llm-enrichment.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../packages/memory-engine/src/mongodb-llm-enrichment.js")
			>()
		return {
			...actual,
			resolveEnrichmentProvider: vi.fn(() => enrichmentProbe.provider),
			// Slice B round 2: the official judge provider is built through
			// createHttpProvider from MEMONGO_BENCHMARK_JUDGE_* env vars, so the
			// real-pipeline tests route it to the synthetic probe as well.
			createHttpProvider: vi.fn(() => enrichmentProbe.provider),
		}
	},
)

// Slice B: spy on the official scoring seams the manager wires in. Every spy
// delegates to the real implementation by default, so custom-v1 runs (all
// pre-existing tests) are unaffected; official-mode tests override per call.
vi.mock("./longmemeval-official-scoring.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./longmemeval-official-scoring.js")>()
	return {
		...actual,
		prepareOfficialQa: vi.fn(actual.prepareOfficialQa),
		scoreOfficialScenario: vi.fn(actual.scoreOfficialScenario),
		summarizeOfficialBenchmarkQaRun: vi.fn(
			actual.summarizeOfficialBenchmarkQaRun,
		),
	}
})

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

vi.mock("./mongodb-benchmark-readiness.js", async (importOriginal) =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkReadinessModuleMock(importOriginal),
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

describe("benchmark run configuration identity", () => {
	it("records query model and conversation evidence mode", () => {
		vi.stubEnv("MEMONGO_SEARCH_MAX_TIME_MS", "4321")
		const host = {
			config: {
				mongodb: {
					uri: "mongodb+srv://user:secret@example.mongodb.net",
					database: "benchmark_db",
					collectionPrefix: "benchmark_",
					deploymentProfile: "atlas-managed",
					numCandidates: 500,
					fusionMethod: "rankFusion",
					embeddingMode: "automated",
					queryEmbeddingModel: "voyage-4-lite",
					conversationEvidenceMode: "parallel",
					numDimensions: 1024,
					quantization: "none",
					cache: {
						enabled: false,
						conversationTtlSec: 300,
						kbTtlSec: 600,
						similarityThreshold: 0.92,
					},
					reranking: {
						enabled: false,
						model: "rerank-2.5",
						topN: 20,
						minScore: 0.01,
					},
					queryRewriting: {
						enabled: false,
						method: "rules",
						maxTokens: 128,
					},
					sources: {
						conversation: { enabled: true },
						reference: { enabled: true },
						structured: { enabled: true },
					},
					kb: { enabled: true },
					graph: {
						enabled: false,
						maxGraphDepth: 2,
						entityExtraction: {
							method: "regex",
							timeoutMs: 1_000,
						},
					},
					episodes: { enabled: true, minEventsForEpisode: 6 },
				},
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				scoreFusion: false,
				rankFusion: true,
			},
		} as unknown as MongoDBManagerHost
		try {
			const configuration = new MongoDBManagerBenchmarkScenarioOps(
				host,
			).snapshotBenchmarkRunConfiguration({
				executionProfile: "shipped",
				retrievalLane: "native",
				maxResults: 50,
				minScore: 0.01,
			})

			expect(configuration.settings).toEqual(
				expect.objectContaining({
					queryEmbeddingModel: "voyage-4-lite",
					conversationEvidenceMode: "parallel",
					deploymentIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
					collectionPrefix: "benchmark_",
					searchBudgetMaxAggregations: 12,
					searchBudgetMaxEmbeds: 5,
					userSearchMaxTimeMs: 4321,
					// B12: the recorded weights come from the benchmark override
					// (always 0), not the host reranking config.
					rerankerRecencyBoost: 0,
					rerankerAccessBoost: 0,
				}),
			)
			expect(JSON.stringify(configuration)).not.toContain("secret")
		} finally {
			vi.unstubAllEnvs()
		}
	})
})

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
			runContext: createOperationRunContext({
				runId: "run-shipped-engine",
				configuration: {
					executionProfile: "shipped",
					retrievalLane: "native",
					maxResults: 10,
					minScore: 0.1,
					settings: {},
				},
			}),
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

	it("restores completed scenarios and runs only the remaining work", async () => {
		const runContext = createOperationRunContext({
			runId: "run-resume",
			configuration: {
				executionProfile: "shipped",
				retrievalLane: "native",
				maxResults: 10,
				minScore: 0.1,
				settings: {},
			},
		})
		const search = vi.fn().mockResolvedValue([
			{
				path: "memory://second",
				startLine: 1,
				endLine: 1,
				score: 0.9,
				snippet: "second memory",
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
		const resumeCheckpoint: BenchmarkCheckpoint = {
			version: 1,
			runId: runContext.runId,
			datasetSha256: "a".repeat(64),
			configurationHash: runContext.configurationHash,
			totalScenarios: 2,
			scenarioIds: ["scenario-1", "scenario-2"],
			completedScenarios: [
				{
					index: 0,
					scenarioId: "scenario-1",
					executionsByPass: [
						[
							{
								caseId: "case-1",
								datasetKind: "locomo",
								executionStatus: "succeeded",
								scoreEligibility: "retrieval",
								retrievalOutcome: "hit",
								empty: false,
								topScore: 0.9,
								latencyMs: 10,
								scored: true,
								hit: true,
								rAt5: 1,
								rAt10: 1,
								ndcgAt10: 1,
							},
						],
					],
					ingest: {
						conversationsIngested: 0,
						turnsIngested: 0,
						skippedConversations: 0,
						failedTurns: 0,
					},
					expectedSessionEntries: [["case-1", ["session-1"]]],
					expectedTurnEntries: [["case-1", []]],
					storageCollections: [],
					storageFailure:
						"scenario-1: scenario did not use an isolated benchmark agent",
				},
			],
			accounting: runContext.accounting.snapshot(),
			updatedAt: new Date().toISOString(),
		}

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
							},
						],
					},
					{
						scenarioId: "scenario-2",
						conversations: [],
						evaluations: [
							{
								caseId: "case-2",
								query: "Second question",
								expectedSessionIds: ["session-2"],
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
			executionProfile: "shipped",
			resumeCheckpoint,
			runContext,
		})

		expect(search).toHaveBeenCalledOnce()
		expect(search).toHaveBeenCalledWith(
			"Second question",
			expect.any(Object),
			runContext,
		)
		expect(result.result.cases).toBe(2)
		expect(result.result.scoredCases).toBe(2)
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

describe("runScenarioBenchmarkDataset judged answers vs checkpoint state (F1)", () => {
	// Synthetic provider routing: "case one" answers violet, the other case
	// emerald; the judge grades candidate === gold. No dataset content, no
	// question identifiers from any real benchmark, no network.
	function buildSearchStub() {
		return vi.fn(async (query: string) => {
			if (query.includes("sky")) {
				return [
					{
						path: "memory://sky",
						startLine: 1,
						endLine: 1,
						score: 0.9,
						snippet: "passage one says the sky is violet",
						source: "conversation",
						sessionId: "session-1",
					},
				] satisfies MemorySearchResult[]
			}
			return [
				{
					path: "memory://grass",
					startLine: 1,
					endLine: 1,
					score: 0.9,
					snippet: "passage two says the grass is emerald",
					source: "conversation",
					sessionId: "session-2",
				},
			] satisfies MemorySearchResult[]
		})
	}

	function buildProbeManager(search: ReturnType<typeof buildSearchStub>) {
		return {
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
	}

	function syntheticLongMemEvalDataset() {
		return {
			name: "synthetic judged-answer checkpoint fixture",
			datasetKind: "longmemeval" as const,
			scenarios: [
				{
					scenarioId: "scenario-1",
					conversations: [],
					evaluations: [
						{
							caseId: "case-1",
							query: "What color is the sky in case one?",
							expectedSessionIds: ["session-1"],
							answer: "violet",
							questionType: "single-session",
						},
					],
				},
				{
					scenarioId: "scenario-2",
					conversations: [],
					evaluations: [
						{
							caseId: "case-2",
							query: "What color is the grass in case two?",
							expectedSessionIds: ["session-2"],
							answer: "emerald",
							questionType: "single-session",
						},
					],
				},
			],
			evaluations: [],
			conversations: [],
		}
	}

	function probeRunContext(runId: string) {
		return createOperationRunContext({
			runId,
			configuration: {
				executionProfile: "shipped",
				retrievalLane: "native",
				maxResults: 10,
				minScore: 0.1,
				settings: {},
			},
		})
	}

	function checkpointSkeleton(
		runContext: ReturnType<typeof probeRunContext>,
		completedScenarios: BenchmarkCheckpoint["completedScenarios"],
	): BenchmarkCheckpoint {
		return {
			version: 1,
			runId: runContext.runId,
			datasetSha256: "a".repeat(64),
			configurationHash: runContext.configurationHash,
			totalScenarios: 2,
			scenarioIds: ["scenario-1", "scenario-2"],
			completedScenarios,
			accounting: runContext.accounting.snapshot(),
			updatedAt: new Date().toISOString(),
		}
	}

	it("fresh run with checkpointPath (CLI default) measures judged answers", async () => {
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-model")
		vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "synthetic-judge-model")
		enrichmentProbe.reset()
		const checkpointDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-w5-harness-fresh-"),
		)
		try {
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
				datasetPath: "/tmp/benchmark.json",
				dataset: syntheticLongMemEvalDataset(),
				datasetVersion: "w5-harness-v1",
				datasetSha256: "a".repeat(64),
				maxResults: 10,
				minScore: 0.1,
				executionProfile: "shipped",
				checkpointPath: path.join(checkpointDir, "checkpoint.json"),
				// resumeCheckpoint intentionally ABSENT — this is a fresh run.
				runContext: probeRunContext("run-fresh-checkpoint"),
			})

			// Both scenarios actually ran in THIS process (nothing was restored).
			expect(search).toHaveBeenCalledTimes(2)
			expect(result.result.cases).toBe(2)
			expect(result.result.scoredCases).toBe(2)

			// F1 fix: a fresh run measures judged answers even though the
			// checkpoint array accumulated this run's completions.
			expect(result.e2eQa?.unavailableReason).toBeUndefined()
			expect(result.e2eQa?.accuracy).toBe(1)
			expect(result.e2eQa?.answerModel).toBe("synthetic-model")
			expect(result.e2eQa?.cases).toEqual({
				eligible: 2,
				attempted: 2,
				completed: 2,
				failed: 0,
			})
			expect(result.e2eQa?.judgeFalsePositiveRate).toBe(0)
			// 2 generations + 2 answer judgments + 2 decoy judgments
			expect(enrichmentProbe.chatCompletions).toBe(6)

			// Checkpoint accumulation still happens, so a later crash can resume.
			const checkpoint = JSON.parse(
				await readFile(path.join(checkpointDir, "checkpoint.json"), "utf8"),
			) as BenchmarkCheckpoint
			expect(
				checkpoint.completedScenarios.map((entry) => entry.scenarioId),
			).toEqual(["scenario-1", "scenario-2"])
		} finally {
			vi.unstubAllEnvs()
			await rm(checkpointDir, { recursive: true, force: true })
		}
	})

	it("empty restored checkpoint (nothing restored) behaves as a fresh run", async () => {
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-model")
		vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "synthetic-judge-model")
		enrichmentProbe.reset()
		const checkpointDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-w5-harness-empty-resume-"),
		)
		try {
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			const runContext = probeRunContext("run-empty-resume")
			const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
				datasetPath: "/tmp/benchmark.json",
				dataset: syntheticLongMemEvalDataset(),
				datasetVersion: "w5-harness-v1",
				datasetSha256: "a".repeat(64),
				maxResults: 10,
				minScore: 0.1,
				executionProfile: "shipped",
				checkpointPath: path.join(checkpointDir, "checkpoint.json"),
				resumeCheckpoint: checkpointSkeleton(runContext, []),
				runContext,
			})

			// Zero scenarios were restored, so all retrieval ran here and the
			// pass-0 passages ARE replayable — judged answers must be measured.
			expect(search).toHaveBeenCalledTimes(2)
			expect(result.e2eQa?.unavailableReason).toBeUndefined()
			expect(result.e2eQa?.accuracy).toBe(1)
			expect(result.e2eQa?.cases).toEqual({
				eligible: 2,
				attempted: 2,
				completed: 2,
				failed: 0,
			})
			expect(enrichmentProbe.chatCompletions).toBe(6)
		} finally {
			vi.unstubAllEnvs()
			await rm(checkpointDir, { recursive: true, force: true })
		}
	})

	it("genuine restored checkpoint keeps the unavailable judged-answer envelope and merges state", async () => {
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-model")
		enrichmentProbe.reset()
		const checkpointDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-w5-harness-resume-"),
		)
		try {
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			const runContext = probeRunContext("run-resume")
			const resumeCheckpoint = checkpointSkeleton(runContext, [
				{
					index: 0,
					scenarioId: "scenario-1",
					executionsByPass: [
						[
							{
								caseId: "case-1",
								datasetKind: "longmemeval",
								executionStatus: "succeeded",
								scoreEligibility: "retrieval",
								retrievalOutcome: "hit",
								empty: false,
								topScore: 0.9,
								latencyMs: 10,
								scored: true,
								hit: true,
								rAt5: 1,
								rAt10: 1,
								ndcgAt10: 1,
								officialMetric: { status: "scored" },
							},
						],
					],
					ingest: {
						conversationsIngested: 0,
						turnsIngested: 0,
						skippedConversations: 0,
						failedTurns: 0,
					},
					expectedSessionEntries: [["case-1", ["session-1"]]],
					expectedTurnEntries: [["case-1", []]],
					storageCollections: [],
				},
			])
			const checkpointPath = path.join(checkpointDir, "checkpoint.json")
			const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
				datasetPath: "/tmp/benchmark.json",
				dataset: syntheticLongMemEvalDataset(),
				datasetVersion: "w5-harness-v1",
				datasetSha256: "a".repeat(64),
				maxResults: 10,
				minScore: 0.1,
				executionProfile: "shipped",
				checkpointPath,
				resumeCheckpoint,
				runContext,
			})

			// Only scenario-2 ran in this process; scenario-1 was restored.
			expect(search).toHaveBeenCalledOnce()
			expect(search.mock.calls[0]?.[0]).toContain("grass")
			expect(result.result.cases).toBe(2)
			expect(result.result.scoredCases).toBe(2)

			// Correct behavior for a genuine resume: the pass-0 passages of the
			// restored scenario are not replayable, so accuracy stays unmeasured.
			expect(result.e2eQa?.accuracy).toBeNull()
			expect(result.e2eQa?.unavailableReason).toContain(
				"resumed from checkpoint",
			)
			// Only the newly-run scenario's case contributed QA material.
			expect(result.e2eQa?.cases).toEqual({
				eligible: 1,
				attempted: 0,
				completed: 0,
				failed: 0,
			})
			expect(enrichmentProbe.chatCompletions).toBe(0)

			// Checkpoint accumulation on a genuine resume: restored scenario-1
			// plus newly completed scenario-2, ordered by index.
			const checkpoint = JSON.parse(
				await readFile(checkpointPath, "utf8"),
			) as BenchmarkCheckpoint
			expect(
				checkpoint.completedScenarios.map((entry) => entry.scenarioId),
			).toEqual(["scenario-1", "scenario-2"])
			expect(checkpoint.completedScenarios.map((entry) => entry.index)).toEqual(
				[0, 1],
			)
		} finally {
			vi.unstubAllEnvs()
			await rm(checkpointDir, { recursive: true, force: true })
		}
	})

	it("control: fresh run without checkpointPath also measures judged answers", async () => {
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-model")
		vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "synthetic-judge-model")
		enrichmentProbe.reset()
		try {
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
				datasetPath: "/tmp/benchmark.json",
				dataset: syntheticLongMemEvalDataset(),
				datasetVersion: "w5-harness-v1",
				maxResults: 10,
				minScore: 0.1,
				executionProfile: "shipped",
				// no checkpointPath — the --no-checkpoint escape hatch
				runContext: probeRunContext("run-fresh-no-checkpoint"),
			})

			expect(result.e2eQa?.unavailableReason).toBeUndefined()
			expect(result.e2eQa?.accuracy).toBe(1)
			expect(result.e2eQa?.cases).toEqual({
				eligible: 2,
				attempted: 2,
				completed: 2,
				failed: 0,
			})
			expect(enrichmentProbe.chatCompletions).toBe(6)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	describe("official QA protocol (Slice B)", () => {
		it("unknown protocol value fails preflight before any scenario work", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "banana")
			enrichmentProbe.reset()
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			await expect(
				benchmarkOps(manager).runScenarioBenchmarkDataset({
					datasetPath: "/tmp/benchmark.json",
					dataset: syntheticLongMemEvalDataset(),
					datasetVersion: "w5-harness-v1",
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped",
					runContext: probeRunContext("run-protocol-invalid"),
				}),
			).rejects.toThrow(/MEMONGO_BENCHMARK_QA_PROTOCOL/)
			expect(search).not.toHaveBeenCalled()
			expect(enrichmentProbe.chatCompletions).toBe(0)
		})

		it("official mode rejects non-LongMemEval datasets before any work", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "official")
			enrichmentProbe.reset()
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			await expect(
				benchmarkOps(manager).runScenarioBenchmarkDataset({
					datasetPath: "/tmp/benchmark.json",
					dataset: {
						...syntheticLongMemEvalDataset(),
						datasetKind: "locomo" as const,
					},
					datasetVersion: "w5-harness-v1",
					datasetSha256: "a".repeat(64),
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped",
					checkpointPath: "/tmp/unused-official-checkpoint.json",
					runContext: probeRunContext("run-official-kind"),
				}),
			).rejects.toThrow(/requires a LongMemEval dataset/)
			expect(search).not.toHaveBeenCalled()
			expect(enrichmentProbe.chatCompletions).toBe(0)
		})

		it("official mode requires checkpointPath before any provider work", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "official")
			enrichmentProbe.reset()
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			await expect(
				benchmarkOps(manager).runScenarioBenchmarkDataset({
					datasetPath: "/tmp/benchmark.json",
					dataset: syntheticLongMemEvalDataset(),
					datasetVersion: "w5-harness-v1",
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped",
					// no checkpointPath — official preflight must refuse
					runContext: probeRunContext("run-official-no-checkpoint"),
				}),
			).rejects.toThrow(/requires checkpointPath/)
			expect(search).not.toHaveBeenCalled()
			expect(enrichmentProbe.chatCompletions).toBe(0)
		})

		it("official mode scores each scenario and publishes the official envelope", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "official")
			enrichmentProbe.reset()
			const checkpointDir = await mkdtemp(
				path.join(os.tmpdir(), "memongo-official-harness-"),
			)
			try {
				const search = buildSearchStub()
				const manager = buildProbeManager(search)
				const runContext = probeRunContext("run-official")
				const checkpointPath = path.join(checkpointDir, "checkpoint.json")
				const identity: OfficialPredictionSidecarIdentity = {
					runId: runContext.runId,
					datasetSha256: "a".repeat(64),
					configurationHash: runContext.configurationHash,
					answerModel: "synthetic-answer-model",
					judgeModel: "synthetic-judge-model",
					judgeProtocol: "official-anscheck",
					promptVersion: OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
					answerPromptVersion: "dated-v2",
					answerTemperature: "0",
					answerMaxTokens: "4096",
				}
				const officialContext: OfficialQaContext = {
					protocol: "official",
					answerProvider: enrichmentProbe.provider,
					judgeProvider: enrichmentProbe.provider,
					answerModel: "synthetic-answer-model",
					judgeModel: "synthetic-judge-model",
					sidecarPath: `${checkpointPath}.predictions.json`,
					sidecar: createOfficialPredictionSidecar(identity),
					stats: {
						attempts: { answerGeneration: 0, answerJudge: 0 },
						successes: { answerGeneration: 0, answerJudge: 0 },
						failures: { answerGeneration: 0, answerJudge: 0 },
					},
					unavailable: [],
				}
				vi.mocked(prepareOfficialQa).mockResolvedValueOnce(officialContext)
				const scoreOnce = vi.fn(
					async (
						params: Parameters<typeof scoreOfficialScenario>[0],
					): ReturnType<typeof scoreOfficialScenario> => {
						params.onProviderCall?.("answer-generation", "attempted", undefined)
						params.onProviderCall?.("answer-judge", "succeeded", {
							inputTokens: 5,
							outputTokens: 2,
						})
						return {
							scenarioId: params.scenarioId,
							complete: true,
							judgedCaseIds: [...params.declaredCaseIds],
							unavailable: [],
						}
					},
				)
				vi.mocked(scoreOfficialScenario).mockImplementationOnce(scoreOnce)
				vi.mocked(scoreOfficialScenario).mockImplementationOnce(scoreOnce)
				const officialSummary = {
					protocol: "official-anscheck" as const,
					coverage: "full" as const,
					overallAccuracy: 1,
					taskAveragedAccuracy: 1,
					abstentionAccuracy: null,
					abstentionCount: 0,
					perType: [{ questionType: "single-session", accuracy: 1, count: 2 }],
					missingQuestionIds: [],
					lostPreCheckpointQuestionIds: [],
					accountingCompleteness: "complete" as const,
				}
				vi.mocked(summarizeOfficialBenchmarkQaRun).mockResolvedValueOnce({
					envelope: {
						answerModel: "synthetic-answer-model",
						judge: "synthetic-judge-model",
						judgeVersion: "official-anscheck",
						accuracy: 1,
						latencyMs: null,
						judgeFalsePositiveRate: 0,
						cases: { eligible: 2, attempted: 2, completed: 2, failed: 0 },
						attempts: { answerGeneration: 2, answerJudge: 2, decoyJudge: 0 },
						caseResults: [],
						official: officialSummary,
					},
					metrics: null,
				})

				const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
					datasetPath: "/tmp/benchmark.json",
					dataset: syntheticLongMemEvalDataset(),
					datasetVersion: "w5-harness-v1",
					datasetSha256: "a".repeat(64),
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped",
					checkpointPath,
					runContext,
				})

				// Retrieval still ran for both scenarios.
				expect(search).toHaveBeenCalledTimes(2)
				// Each scenario was scored exactly once, in dataset order, with
				// its declared case ids and the preflight context.
				expect(vi.mocked(scoreOfficialScenario)).toHaveBeenCalledTimes(2)
				expect(
					vi
						.mocked(scoreOfficialScenario)
						.mock.calls.map((call) => call[0]?.scenarioId),
				).toEqual(["scenario-1", "scenario-2"])
				expect(
					vi.mocked(scoreOfficialScenario).mock.calls[0]?.[0]?.declaredCaseIds,
				).toEqual(["case-1"])
				expect(
					vi.mocked(scoreOfficialScenario).mock.calls[1]?.[0]?.declaredCaseIds,
				).toEqual(["case-2"])
				expect(
					vi.mocked(scoreOfficialScenario).mock.calls[0]?.[0]?.context,
				).toBe(officialContext)
				// The summary saw every covered case (both scenarios completed).
				expect(
					vi.mocked(summarizeOfficialBenchmarkQaRun).mock.calls[0]?.[0]
						?.coveredCaseIds,
				).toEqual(new Set(["case-1", "case-2"]))
				// The published envelope is the official one; the custom-v1
				// judged-answers path never ran (no provider chat calls).
				expect(result.e2eQa?.official).toEqual(officialSummary)
				expect(result.e2eQa?.accuracy).toBe(1)
				expect(enrichmentProbe.chatCompletions).toBe(0)
				// Provider calls flowed into run accounting with per-role
				// attribution and forwarded token usage.
				const operations = runContext.accounting.snapshot().operations
				expect(
					operations.find((entry) => entry.operation === "answer-generation"),
				).toMatchObject({
					attempted: 2,
					provider: "synthetic-deterministic",
					model: "synthetic-answer-model",
				})
				expect(
					operations.find((entry) => entry.operation === "answer-judge"),
				).toMatchObject({
					succeeded: 2,
					inputTokens: 10,
					outputTokens: 4,
					provider: "synthetic-deterministic",
					model: "synthetic-judge-model",
				})
				// Scoring ran before the checkpoint write, so both scenarios
				// are checkpointed as complete.
				const checkpoint = JSON.parse(
					await readFile(checkpointPath, "utf8"),
				) as BenchmarkCheckpoint
				expect(
					checkpoint.completedScenarios.map((entry) => entry.scenarioId),
				).toEqual(["scenario-1", "scenario-2"])
			} finally {
				vi.unstubAllEnvs()
				await rm(checkpointDir, { recursive: true, force: true })
			}
		})

		// Slice B round 2: real-pipeline tests (real prepare/score/summarize,
		// real checkpoint + sidecar files, only the providers are synthetic).
		function stubOfficialEnv() {
			vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "official")
			vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
			vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-answer-model")
			// The judge provider is built from MEMONGO_BENCHMARK_JUDGE_* env
			// vars; createHttpProvider is mocked to the synthetic probe, so the
			// key/base URL values are placeholders, but the model must be the
			// pinned official judge model.
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_API_KEY", "synthetic")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_BASE_URL", "http://synthetic.local")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "gpt-4o-2024-08-06")
		}

		function officialLongMemEvalDataset(noGoldSecondScenario = false) {
			return {
				name: "synthetic official QA fixture",
				datasetKind: "longmemeval" as const,
				scenarios: [
					{
						scenarioId: "scenario-1",
						conversations: [],
						evaluations: [
							{
								caseId: "case-1",
								query: "What color is the sky in case one?",
								expectedSessionIds: ["session-1"],
								answer: "violet",
								questionType: "single-session-user",
							},
						],
					},
					{
						scenarioId: "scenario-2",
						conversations: [],
						evaluations: [
							{
								caseId: "case-2",
								query: "What color is the grass in case two?",
								expectedSessionIds: ["session-2"],
								// A no-gold case is honestly unavailable: judged
								// never, billed never, and the scenario is incomplete.
								answer: noGoldSecondScenario ? "" : "emerald",
								questionType: "single-session-user",
							},
						],
					},
				],
				evaluations: [],
				conversations: [],
			}
		}

		it("real scoring: seeded checkpoint exists before the first scenario and scoring precedes each checkpoint write (round 2)", async () => {
			stubOfficialEnv()
			enrichmentProbe.reset()
			const checkpointDir = await mkdtemp(
				path.join(os.tmpdir(), "memongo-official-real-seed-"),
			)
			try {
				const search = buildSearchStub()
				const manager = buildProbeManager(search)
				const runContext = probeRunContext("run-official-real-seed")
				const checkpointPath = path.join(checkpointDir, "checkpoint.json")
				// Wrap the real scoring to snapshot the checkpoint exactly when
				// each scenario's scoring finished.
				const actualScoring = await vi.importActual<
					typeof import("./longmemeval-official-scoring.js")
				>("./longmemeval-official-scoring.js")
				const checkpointAtScoring: Array<string[] | null> = []
				vi.mocked(scoreOfficialScenario).mockImplementation(async (params) => {
					const outcome = await actualScoring.scoreOfficialScenario(params)
					const raw = await readFile(checkpointPath, "utf8").catch(() => null)
					checkpointAtScoring.push(
						raw
							? (JSON.parse(raw) as BenchmarkCheckpoint).completedScenarios.map(
									(entry) => entry.scenarioId,
								)
							: null,
					)
					return outcome
				})
				const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
					datasetPath: "/tmp/benchmark.json",
					dataset: officialLongMemEvalDataset(),
					datasetVersion: "w5-harness-v1",
					datasetSha256: "a".repeat(64),
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped",
					checkpointPath,
					runContext,
				})
				expect(result.e2eQa?.official?.coverage).toBe("full")
				expect(result.e2eQa?.official?.accountingCompleteness).toBe("complete")
				expect(result.e2eQa?.accuracy).toBe(1)
				// Correction 3: when each scenario's scoring finished, its own
				// checkpoint write had not happened yet. Correction 7: the seed
				// checkpoint exists before the first scenario, so the first
				// snapshot is the empty seed (never a missing file).
				expect(checkpointAtScoring).toEqual([[], ["scenario-1"]])
				const checkpoint = JSON.parse(
					await readFile(checkpointPath, "utf8"),
				) as BenchmarkCheckpoint
				expect(
					checkpoint.completedScenarios.map((entry) => entry.scenarioId),
				).toEqual(["scenario-1", "scenario-2"])
			} finally {
				vi.mocked(scoreOfficialScenario).mockRestore()
				vi.unstubAllEnvs()
				await rm(checkpointDir, { recursive: true, force: true })
			}
		})

		it("real scoring: an incomplete scenario (missing gold) never reaches the checkpoint and is reported missing (round 2)", async () => {
			stubOfficialEnv()
			enrichmentProbe.reset()
			const checkpointDir = await mkdtemp(
				path.join(os.tmpdir(), "memongo-official-real-incomplete-"),
			)
			try {
				const search = buildSearchStub()
				const manager = buildProbeManager(search)
				const runContext = probeRunContext("run-official-real-incomplete")
				const checkpointPath = path.join(checkpointDir, "checkpoint.json")
				const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
					datasetPath: "/tmp/benchmark.json",
					dataset: officialLongMemEvalDataset(true),
					datasetVersion: "w5-harness-v1",
					datasetSha256: "a".repeat(64),
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped",
					checkpointPath,
					runContext,
				})
				expect(result.e2eQa?.official?.coverage).toBe("partial")
				expect(result.e2eQa?.official?.missingQuestionIds).toEqual(["case-2"])
				expect(result.e2eQa?.accuracy).toBeNull()
				// Correction 1: scenario-2 is incomplete, so the checkpoint keeps
				// only scenario-1 — an incomplete scenario must re-run on resume.
				const checkpoint = JSON.parse(
					await readFile(checkpointPath, "utf8"),
				) as BenchmarkCheckpoint
				expect(
					checkpoint.completedScenarios.map((entry) => entry.scenarioId),
				).toEqual(["scenario-1"])
				// The missing-gold case was never billed: the B8-2 preflight
				// probe plus case-1 answered and judged.
				expect(enrichmentProbe.chatCompletions).toBe(3)
			} finally {
				vi.unstubAllEnvs()
				await rm(checkpointDir, { recursive: true, force: true })
			}
		})

		it("real scoring: seeded checkpoint survives a mid-scenario crash; resume completes with honestly incomplete accounting (round 2)", async () => {
			stubOfficialEnv()
			enrichmentProbe.reset()
			const checkpointDir = await mkdtemp(
				path.join(os.tmpdir(), "memongo-official-real-crash-"),
			)
			try {
				const search = buildSearchStub()
				const manager = buildProbeManager(search)
				const runContext = probeRunContext("run-official-real-crash")
				const checkpointPath = path.join(checkpointDir, "checkpoint.json")
				const runParams = {
					datasetPath: "/tmp/benchmark.json",
					dataset: officialLongMemEvalDataset(),
					datasetVersion: "w5-harness-v1",
					datasetSha256: "a".repeat(64),
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped" as const,
					checkpointPath,
					runContext,
				}

				// Phase 1: fresh run; the first official judge call fails after
				// the answer row was staged to the sidecar (mid-scenario crash).
				enrichmentProbe.failNextOfficialJudges(1)
				await expect(
					benchmarkOps(manager).runScenarioBenchmarkDataset(runParams),
				).rejects.toThrow(/official judging failed for question case-1/)
				// Correction 7: the seed checkpoint exists (empty) even though
				// no scenario completed — a crash after preflight still resumes.
				const seeded = JSON.parse(
					await readFile(checkpointPath, "utf8"),
				) as BenchmarkCheckpoint
				expect(seeded.completedScenarios).toEqual([])
				// The sidecar kept the answered row, so the crash never re-pays
				// the answer generation.
				const sidecarAfterCrash = JSON.parse(
					await readFile(`${checkpointPath}.predictions.json`, "utf8"),
				) as { rows: Record<string, { stage: string }> }
				expect(sidecarAfterCrash.rows["case-1"]?.stage).toBe("answered")

				// Phase 2: resume through the real readBenchmarkCheckpoint path;
				// the run completes with full coverage but honestly incomplete
				// accounting (correction 6: resume never reads as complete).
				enrichmentProbe.reset()
				const restored = await readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: runContext.configurationHash,
					scenarioIds: ["scenario-1", "scenario-2"],
				})
				const resumed = await benchmarkOps(manager).runScenarioBenchmarkDataset(
					{ ...runParams, resumeCheckpoint: restored },
				)
				// Phase-1 scenario-1 retrieval + phase-2 scenario-1 re-run +
				// phase-2 scenario-2 (the seed checkpoint restored nothing).
				expect(search).toHaveBeenCalledTimes(3)
				expect(resumed.e2eQa?.official?.coverage).toBe("full")
				expect(resumed.e2eQa?.official?.accountingCompleteness).toBe(
					"incomplete",
				)
				expect(resumed.e2eQa?.official?.lostPreCheckpointQuestionIds).toEqual(
					[],
				)
				expect(resumed.e2eQa?.accuracy).toBe(1)
				// B8-2 preflight probe + case-1 judge only (answered row
				// reused) + case-2 answer+judge.
				expect(enrichmentProbe.chatCompletions).toBe(4)

				// Phase 3: a later repeat resume restores both scenarios, makes
				// zero search and zero scoring calls, and still reports
				// incomplete accounting — recovery never silently clears the
				// uncertainty. Only the B8-2 preflight probe is billed anew.
				const restoredAgain = await readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: runContext.configurationHash,
					scenarioIds: ["scenario-1", "scenario-2"],
				})
				const repeated = await benchmarkOps(
					manager,
				).runScenarioBenchmarkDataset({
					...runParams,
					resumeCheckpoint: restoredAgain,
				})
				// No additional retrieval: both scenarios were restored.
				expect(search).toHaveBeenCalledTimes(3)
				expect(repeated.e2eQa?.official?.coverage).toBe("full")
				expect(repeated.e2eQa?.official?.accountingCompleteness).toBe(
					"incomplete",
				)
				// Phase-2 total (4) plus one more B8-2 preflight probe.
				expect(enrichmentProbe.chatCompletions).toBe(5)
			} finally {
				vi.unstubAllEnvs()
				await rm(checkpointDir, { recursive: true, force: true })
			}
		})
	})

	describe("custom-judge QA protocol (Luna integration)", () => {
		it("custom-judge mode requires checkpointPath before any provider work", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "custom-judge")
			vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
			vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-answer-model")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_API_KEY", "synthetic")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_BASE_URL", "http://synthetic.local")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "synthetic-luna")
			enrichmentProbe.reset()
			const search = buildSearchStub()
			const manager = buildProbeManager(search)
			try {
				await expect(
					benchmarkOps(manager).runScenarioBenchmarkDataset({
						datasetPath: "/tmp/benchmark.json",
						dataset: syntheticLongMemEvalDataset(),
						datasetVersion: "w5-harness-v1",
						maxResults: 10,
						minScore: 0.1,
						executionProfile: "shipped",
						// no checkpointPath — custom-judge preflight must refuse
						runContext: probeRunContext("run-custom-judge-no-checkpoint"),
					}),
				).rejects.toThrow(/requires checkpointPath/)
				expect(search).not.toHaveBeenCalled()
				expect(enrichmentProbe.chatCompletions).toBe(0)
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("custom-judge mode scores each scenario through the same durable scoring path and publishes a customJudge envelope without official", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "custom-judge")
			vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
			vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-answer-model")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_API_KEY", "synthetic")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_BASE_URL", "http://synthetic.local")
			vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "synthetic-luna")
			enrichmentProbe.reset()
			// The scoring seams are file-level spies shared with the official-mode
			// tests above; clear their histories so this test's call-count and
			// call-args assertions see only this run.
			vi.mocked(prepareOfficialQa).mockClear()
			vi.mocked(scoreOfficialScenario).mockClear()
			vi.mocked(summarizeOfficialBenchmarkQaRun).mockClear()
			const checkpointDir = await mkdtemp(
				path.join(os.tmpdir(), "memongo-custom-judge-harness-"),
			)
			try {
				const search = buildSearchStub()
				const manager = buildProbeManager(search)
				const runContext = probeRunContext("run-custom-judge")
				const checkpointPath = path.join(checkpointDir, "checkpoint.json")
				const identity: OfficialPredictionSidecarIdentity = {
					runId: runContext.runId,
					datasetSha256: "a".repeat(64),
					configurationHash: runContext.configurationHash,
					answerModel: "synthetic-answer-model",
					judgeModel: "synthetic-luna",
					judgeProtocol: "custom-judge-anscheck",
					promptVersion: OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
					answerPromptVersion: "dated-v2",
					answerTemperature: "0",
					answerMaxTokens: "4096",
				}
				const customJudgeContext: OfficialQaContext = {
					answerProvider: enrichmentProbe.provider,
					judgeProvider: enrichmentProbe.provider,
					answerModel: "synthetic-answer-model",
					judgeModel: "synthetic-luna",
					protocol: "custom-judge",
					sidecarPath: `${checkpointPath}.predictions.json`,
					sidecar: createOfficialPredictionSidecar(identity),
					stats: {
						attempts: { answerGeneration: 0, answerJudge: 0 },
						successes: { answerGeneration: 0, answerJudge: 0 },
						failures: { answerGeneration: 0, answerJudge: 0 },
					},
					unavailable: [],
				}
				vi.mocked(prepareOfficialQa).mockResolvedValueOnce(customJudgeContext)
				const scoreOnce = vi.fn(
					async (
						params: Parameters<typeof scoreOfficialScenario>[0],
					): ReturnType<typeof scoreOfficialScenario> => {
						params.onProviderCall?.("answer-generation", "attempted", undefined)
						params.onProviderCall?.("answer-judge", "succeeded", {
							inputTokens: 5,
							outputTokens: 2,
						})
						return {
							scenarioId: params.scenarioId,
							complete: true,
							judgedCaseIds: [...params.declaredCaseIds],
							unavailable: [],
						}
					},
				)
				vi.mocked(scoreOfficialScenario).mockImplementationOnce(scoreOnce)
				vi.mocked(scoreOfficialScenario).mockImplementationOnce(scoreOnce)
				const customJudgeSummary = {
					protocol: "custom-judge-anscheck" as const,
					judgeModel: "synthetic-luna",
					coverage: "full" as const,
					overallAccuracy: 1,
					taskAveragedAccuracy: 1,
					abstentionAccuracy: null,
					abstentionCount: 0,
					perType: [{ questionType: "single-session", accuracy: 1, count: 2 }],
					missingQuestionIds: [],
					lostPreCheckpointQuestionIds: [],
					accountingCompleteness: "complete" as const,
				}
				vi.mocked(summarizeOfficialBenchmarkQaRun).mockResolvedValueOnce({
					envelope: {
						answerModel: "synthetic-answer-model",
						judge: "synthetic-luna",
						judgeVersion: "custom-judge-anscheck",
						accuracy: 1,
						latencyMs: null,
						judgeFalsePositiveRate: 0,
						cases: { eligible: 2, attempted: 2, completed: 2, failed: 0 },
						attempts: { answerGeneration: 2, answerJudge: 2, decoyJudge: 0 },
						caseResults: [],
						customJudge: customJudgeSummary,
					},
					metrics: null,
				})

				const result = await benchmarkOps(manager).runScenarioBenchmarkDataset({
					datasetPath: "/tmp/benchmark.json",
					dataset: syntheticLongMemEvalDataset(),
					datasetVersion: "w5-harness-v1",
					datasetSha256: "a".repeat(64),
					maxResults: 10,
					minScore: 0.1,
					executionProfile: "shipped",
					checkpointPath,
					runContext,
				})

				// Retrieval still ran for both scenarios.
				expect(search).toHaveBeenCalledTimes(2)
				// Each scenario was scored exactly once, in dataset order,
				// through the same durable scoring path with the preflight
				// context.
				expect(vi.mocked(scoreOfficialScenario)).toHaveBeenCalledTimes(2)
				expect(
					vi
						.mocked(scoreOfficialScenario)
						.mock.calls.map((call) => call[0]?.scenarioId),
				).toEqual(["scenario-1", "scenario-2"])
				expect(
					vi.mocked(scoreOfficialScenario).mock.calls[0]?.[0]?.context,
				).toBe(customJudgeContext)
				// The published envelope is the customJudge one; no official
				// block is fabricated for a non-official run, and the
				// custom-v1 judged-answers path never ran.
				expect(result.e2eQa?.customJudge).toEqual(customJudgeSummary)
				expect(result.e2eQa?.official).toBeUndefined()
				expect(result.e2eQa?.accuracy).toBe(1)
				expect(enrichmentProbe.chatCompletions).toBe(0)
				// Scoring ran before each checkpoint write: both scenarios are
				// checkpointed as complete through the same gating.
				const checkpoint = JSON.parse(
					await readFile(checkpointPath, "utf8"),
				) as BenchmarkCheckpoint
				expect(
					checkpoint.completedScenarios.map((entry) => entry.scenarioId),
				).toEqual(["scenario-1", "scenario-2"])
			} finally {
				vi.unstubAllEnvs()
				await rm(checkpointDir, { recursive: true, force: true })
			}
		})
	})
})
