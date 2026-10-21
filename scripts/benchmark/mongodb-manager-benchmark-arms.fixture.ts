import { vi } from "vitest"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { createOperationRunContext } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { mocked } from "../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
import type {
	MemoryBenchmarkDataset,
	MemorySearchResult,
} from "../../packages/memory-engine/src/types.js"
import { BENCHMARK_ARMS_ENV, type BenchmarkArm } from "./benchmark-arms.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"
import type { BenchmarkCheckpoint } from "./mongodb-benchmark-checkpoint.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"

/**
 * Offline paired-arms harness: every scenario has one stored conversation
 * and one question. A search with turn recall on finds the gold session and
 * its answer; with recall off it finds a distractor that says "grey".
 */
export const GOLD: Record<string, string> = { s1: "violet", s2: "amber" }
export const queryFor = (scenarioId: string) => `question ${scenarioId}`

const ACKNOWLEDGED_CLEANUP = {
	status: "acknowledged" as const,
	agentId: "benchmark-arms-agent",
	registry: { version: 1 as const, digest: "0".repeat(64), collections: 0 },
	collections: [],
}

function hit(scenarioId: string, recall: boolean): MemorySearchResult {
	const sessionId = `${scenarioId}::${recall ? "gold" : "other"}`
	const text = `the answer is ${recall ? GOLD[scenarioId] : "grey"}`
	return {
		path: `events/${sessionId}`,
		startLine: 1,
		endLine: 1,
		score: 0.9,
		snippet: text,
		text,
		source: "conversation",
		canonicalId: `event:${sessionId}`,
		sessionId,
		role: "user",
	}
}

function dataset(scenarioIds: string[]): MemoryBenchmarkDataset {
	return {
		name: "paired arms fixture",
		datasetKind: "longmemeval",
		conversations: [],
		evaluations: [],
		scenarios: scenarioIds.map((scenarioId) => ({
			scenarioId,
			conversations: [
				{
					conversationId: scenarioId,
					sessionId: `${scenarioId}::gold`,
					turns: [
						{
							role: "user" as const,
							body: `the answer is ${GOLD[scenarioId]}`,
							metadata: { benchmarkTurnId: `${scenarioId}::gold::turn_1` },
						},
					],
				},
			],
			evaluations: [
				{
					caseId: scenarioId,
					query: queryFor(scenarioId),
					expectedSessionIds: [`${scenarioId}::gold`],
					answer: GOLD[scenarioId],
					questionType: "single-session",
				},
			],
		})),
	}
}

export function armsRunContext(arms: string) {
	return createOperationRunContext({
		runId: "run-paired-arms",
		configuration: producedRunConfiguration({ [BENCHMARK_ARMS_ENV]: arms })
			.configuration,
	})
}

export async function runArmsFixture(options: {
	arms: BenchmarkArm[]
	log: string[]
	runContext: ReturnType<typeof armsRunContext>
	checkpointPath?: string
	resumeCheckpoint?: BenchmarkCheckpoint
	retrievalLane?: "native" | "raw-session"
	datasetKind?: "longmemeval" | "locomo"
}) {
	vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
	vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-model")
	vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "synthetic-judge-model")
	const { ingestBenchmarkConversations } = await import(
		"./mongodb-benchmark-harness.js"
	)
	mocked(ingestBenchmarkConversations).mockImplementation(async (params) => {
		options.log.push(`ingest:${String(params.metadata?.benchmarkScenarioId)}`)
		return {
			datasetPath: "/tmp/benchmark.json",
			datasetName: "paired-arms",
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
	const search = vi.fn(
		async (query: string, opts?: { sessionTurnRecall?: boolean }) => {
			options.log.push(`search:${query}:recall=${opts?.sessionTurnRecall}`)
			const scenarioId = query.replace("question ", "")
			return [hit(scenarioId, opts?.sessionTurnRecall === true)]
		},
	)
	const scenarioManager = {
		agentId: "benchmark-arms-agent",
		search,
		close: vi.fn(async () => {}),
	} as unknown as MongoDBMemoryManager
	const manager = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db: {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
			})),
		},
		prefix: "test_",
		agentId: "benchmark-parent",
		config: { mongodb: {} },
		relevance: { persistRegression: vi.fn(async () => []) },
	}) as MongoDBMemoryManager
	const ops = new MongoDBManagerBenchmarkOps(
		manager as unknown as MongoDBManagerHost,
	)
	Object.assign(ops as unknown as Record<string, unknown>, {
		createBenchmarkScenarioManager: vi.fn(async () => scenarioManager),
		settleBenchmarkScenarioManager: vi.fn(async () => {}),
		listBenchmarkEventEvidence: vi.fn(async () => ({
			sessionIds: new Map<string, string>(),
			turnIds: new Map<string, string>(),
			dialogIds: new Map<string, string>(),
		})),
		waitForBenchmarkSearchConvergence: vi.fn(async () => {}),
		cleanupBenchmarkScenarioData: vi.fn(async () => {
			options.log.push("cleanup")
			return ACKNOWLEDGED_CLEANUP
		}),
	})
	const fixture = dataset(["s1", "s2"])
	const outcome = await ops.runScenarioBenchmarkDataset({
		datasetPath: "/tmp/benchmark.json",
		dataset: { ...fixture, datasetKind: options.datasetKind ?? "longmemeval" },
		datasetVersion: "paired-arms-v1",
		datasetSha256: "a".repeat(64),
		maxResults: 10,
		minScore: 0.01,
		retrievalLane: options.retrievalLane ?? "native",
		executionProfile: "shipped",
		runContext: options.runContext,
		arms: options.arms,
		...(options.checkpointPath
			? { checkpointPath: options.checkpointPath }
			: {}),
		...(options.resumeCheckpoint
			? { resumeCheckpoint: options.resumeCheckpoint }
			: {}),
	})
	return { outcome, search }
}
