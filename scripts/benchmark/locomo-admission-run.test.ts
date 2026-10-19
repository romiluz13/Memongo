import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { testOperationRunContext } from "../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import { generateAnswer } from "../mongodb-e2e-qa.js"
import {
	type BenchmarkJudgedAnswerMaterial,
	buildJudgedAnswerCases,
	runBenchmarkJudgedAnswers,
} from "./benchmark-answer-quality.js"
import { qa, sample, turn } from "./locomo-admission.fixture.js"
import { buildOfficialDatedAnswerMessages } from "./longmemeval-official-scoring.js"
import type { BenchmarkCheckpoint } from "./mongodb-benchmark-checkpoint.js"
import type { ConversationReplayBatchTurn } from "./mongodb-benchmark-harness.js"
import { loadBenchmarkDataset } from "./mongodb-benchmark-dataset.js"
import {
	MongoDBManagerBenchmarkOps,
	attachBenchmarkOperationsReport,
} from "./mongodb-manager-benchmark.js"

// Ticket #95 at the run seam: the real loader feeds the real scenario loop and
// the real ingest replay; only the database-facing manager methods are fakes.
// Category-5 bait must never reach a write, a search, retrieval evidence or a
// reader prompt, and the abstention flag and rejections must survive resume.

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

const ADVERSARIAL_BAIT = "zq9-adversarial-bait"
const REFERENCE_BAIT = "zq9-reference-bait"
const BAIT = new RegExp(`${ADVERSARIAL_BAIT}|${REFERENCE_BAIT}`)

/** s1: a scored item, a category-5 trap and an evidence-less item; s2: one turn and one QA rejection. */
const DOCUMENT = [
	sample("s1", {
		conversation: {
			session_1: [
				turn("Alice", "D1:1", "Alice adopted a beagle named Pico"),
				turn("Bob", "D1:2", "Bob visited Lisbon in spring"),
			],
		},
		qa: [
			qa({ question: "What dog did Alice adopt?", answer: "a beagle" }),
			qa({
				question: "What dog did Bob adopt?",
				answer: REFERENCE_BAIT,
				adversarial_answer: ADVERSARIAL_BAIT,
				category: 5,
				evidence: ["D1:1"],
			}),
			qa({
				question: "Would Alice enjoy a dog park?",
				answer: "likely",
				category: 3,
				evidence: [],
			}),
		],
	}),
	sample("s2", {
		conversation: {
			session_1: [
				turn("Alice", "D1:1", "Alice paints watercolors"),
				turn("Mallory", "D1:2", "a stranger spoke"),
			],
		},
		qa: [
			qa({ question: "What does Alice paint?", answer: "watercolors" }),
			qa({ question: "What did the stranger say?", evidence: ["D1:2"] }),
		],
	}),
]

const dirs: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true })
})

async function runLoCoMo() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "locomo-run-"))
	dirs.push(dir)
	const datasetPath = path.join(dir, "locomo.json")
	await writeFile(datasetPath, JSON.stringify(DOCUMENT))
	const dataset = await loadBenchmarkDataset(datasetPath)
	const writes: ConversationReplayBatchTurn[] = []
	const queries: string[] = []
	const manager = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db: {
			collection: () => ({
				aggregate: () => ({ toArray: async () => [] }),
				deleteMany: async () => ({ acknowledged: true, deletedCount: 0 }),
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
	record.createBenchmarkScenarioManager = async (agentId: string) => {
		const scenarioWrites: ConversationReplayBatchTurn[] = []
		return {
			agentId,
			close: async () => {},
			writeConversationEventsBatch: async (
				turns: ConversationReplayBatchTurn[],
			) => {
				scenarioWrites.push(...turns)
				writes.push(...turns)
				return turns.map(() => ({ ok: true as const }))
			},
			// Every ingested turn comes back, so any leak into ingest would reach the prompt.
			search: async (query: string): Promise<MemorySearchResult[]> => {
				queries.push(query)
				return scenarioWrites.map((write, index) => ({
					path: `memory://${agentId}/${index}`,
					startLine: 1,
					endLine: 1,
					score: 0.9 - index / 100,
					snippet: write.body,
					text: write.body,
					source: "conversation",
					sessionId: write.sessionId,
					role: write.role === "assistant" ? "assistant" : "user",
				}))
			},
		}
	}
	record.settleBenchmarkScenarioManager = async () => {}
	record.listBenchmarkEventEvidence = async () => ({
		sessionIds: new Map(),
		turnIds: new Map(),
		dialogIds: new Map(),
	})
	record.waitForBenchmarkSearchConvergence = async () => {}
	const checkpointPath = path.join(dir, "checkpoint.json")
	const run = (resumeCheckpoint?: BenchmarkCheckpoint) =>
		ops.runScenarioBenchmarkDataset({
			datasetPath,
			dataset,
			datasetVersion: "locomo-fixture",
			maxResults: 10,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testOperationRunContext("run-locomo"),
			checkpointPath,
			datasetSha256: "a".repeat(64),
			executableDigest: "d".repeat(64),
			...(resumeCheckpoint ? { resumeCheckpoint } : {}),
		})
	const checkpoint = async () =>
		JSON.parse(await readFile(checkpointPath, "utf8")) as BenchmarkCheckpoint
	const material = () =>
		vi.mocked(runBenchmarkJudgedAnswers).mock.calls.at(-1)?.[0]
			.materialByCaseId ?? new Map<string, BenchmarkJudgedAnswerMaterial>()
	return { dataset, run, checkpoint, writes, queries, material }
}

type RunOutcome = Awaited<
	ReturnType<Awaited<ReturnType<typeof runLoCoMo>>["run"]>
>

const completeness = (result: RunOutcome["result"]) =>
	attachBenchmarkOperationsReport(result).benchmarkReport?.releaseGates.find(
		(gate) => gate.gate === "execution-completeness",
	)

/** Both reader prompts the harness can build from captured pass-0 material. */
async function builtReaderPrompts(
	materialByCaseId: Map<string, BenchmarkJudgedAnswerMaterial>,
): Promise<string[]> {
	const prompts: string[] = []
	const provider = {
		name: "capture",
		chatCompletion: async (params: {
			messages: Array<{ role: string; content: string }>
		}) => {
			prompts.push(params.messages.map((m) => m.content).join("\n"))
			return { content: '{"answer":""}' }
		},
	}
	for (const testCase of buildJudgedAnswerCases(materialByCaseId).cases)
		await generateAnswer({
			provider: provider as unknown as Parameters<
				typeof generateAnswer
			>[0]["provider"],
			model: "capture",
			question: testCase.question,
			contextPassages: testCase.contextPassages,
		})
	for (const material of materialByCaseId.values())
		prompts.push(
			buildOfficialDatedAnswerMessages(material)
				.map((m) => m.content)
				.join("\n"),
		)
	return prompts
}

describe("LoCoMo category-5 bait never reaches ingest, retrieval or a reader prompt (decision 5)", () => {
	it("carries the bait only as reference metadata", async () => {
		const h = await runLoCoMo()
		const trap = h.dataset.evaluations?.find((e) => e.abstention)
		expect(trap?.metadata).toMatchObject({
			locomoAdversarialAnswer: ADVERSARIAL_BAIT,
			locomoReferenceAnswer: REFERENCE_BAIT,
		})
		const { metadata: _reference, ...rest } = trap ?? {}
		expect(JSON.stringify(rest)).not.toMatch(BAIT)
		expect(JSON.stringify(h.dataset.conversations)).not.toMatch(BAIT)
	})

	it("searches the written payloads, the queries, the run result, the checkpoint and the built prompts", async () => {
		const h = await runLoCoMo()
		const { result } = await h.run()

		expect(h.writes.map((write) => write.body)).toContain(
			"Alice adopted a beagle named Pico",
		)
		expect(JSON.stringify(h.writes)).not.toMatch(BAIT)
		expect(h.queries).toContain("What dog did Bob adopt?")
		expect(h.queries.join("\n")).not.toMatch(BAIT)
		expect(JSON.stringify(result)).not.toMatch(BAIT)
		expect(JSON.stringify(await h.checkpoint())).not.toMatch(BAIT)

		const material = h.material()
		const trap = material.get("s1::qa_2")
		expect(trap).toMatchObject({ abstention: true, goldAnswer: "" })
		expect(trap?.contextPassages).toContain("Alice adopted a beagle named Pico")
		expect(JSON.stringify([...material.values()])).not.toMatch(BAIT)
		const prompts = await builtReaderPrompts(material)
		expect(prompts.some((p) => p.includes("What dog did Bob adopt?"))).toBe(
			true,
		)
		expect(prompts.join("\n")).not.toMatch(BAIT)
	})
})

describe("LoCoMo results carry the abstention flag and are never scored QA (decision 5)", () => {
	it("labels the trap as abstention and the evidence-less item as unscored, by category not id", async () => {
		const h = await runLoCoMo()
		const { result } = await h.run()
		const executions = new Map(
			(await h.checkpoint()).completedScenarios
				.flatMap((scenario) => scenario.executionsByPass[0] ?? [])
				.map((execution) => [execution.caseId, execution]),
		)
		expect(executions.get("s1::qa_2")).toMatchObject({
			abstention: true,
			scoreEligibility: "abstention",
			scored: false,
		})
		expect(executions.get("s1::qa_2")?.loCoMo).toBeUndefined()
		expect(executions.get("s1::qa_3")).toMatchObject({ scored: false })
		expect(executions.get("s1::qa_3")?.loCoMo).toBeUndefined()
		expect(executions.get("s1::qa_1")?.loCoMo).toBeDefined()
		expect(result.officialMetrics?.loCoMo).toMatchObject({
			retrievalCases: 2,
			abstentionCases: 1,
		})
		expect(result.officialMetrics?.longMemEval).toBeUndefined()
	})

	it("produces no judged answer envelope", async () => {
		const h = await runLoCoMo()
		const outcome = await h.run()
		expect(outcome.e2eQa).toBeUndefined()
		expect(
			attachBenchmarkOperationsReport(
				outcome.result,
			).benchmarkReport?.releaseGates.find(
				(gate) => gate.gate === "e2e-answer-quality",
			)?.status,
		).not.toBe("passed")
	})

	it("refuses the durable official QA protocol before any write", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "official")
		const h = await runLoCoMo()
		await expect(h.run()).rejects.toThrow(/requires a LongMemEval dataset/)
		expect(h.writes).toHaveLength(0)
	})
})

describe("LoCoMo rejections and the abstention flag survive checkpoints and resume (decision 7)", () => {
	it("stays incomplete and keeps the flag after resume", async () => {
		const h = await runLoCoMo()
		expect(h.dataset.adapterDiagnostics?.totals).toMatchObject({
			rejectedTurns: 1,
			rejectedQaItems: 1,
		})
		const first = await h.run()
		expect(completeness(first.result)).toMatchObject({
			status: "failed",
			evidence: expect.stringContaining(
				"1 dataset conversations were rejected",
			),
		})
		const stored = await h.checkpoint()
		expect(stored.adapterDiagnosticsTotals).toEqual(
			h.dataset.adapterDiagnostics?.totals,
		)
		expect(stored).toMatchObject({ rejectedTurns: 1, rejectedConversations: 1 })
		const storedTrap = stored.completedScenarios
			.flatMap((s) => s.executionsByPass.flat())
			.find((execution) => execution.caseId === "s1::qa_2")
		expect(storedTrap).toMatchObject({ abstention: true })

		const writesBefore = h.writes.length
		const resumed = await h.run(stored)
		expect(h.writes).toHaveLength(writesBefore)
		expect(completeness(resumed.result)).toMatchObject({
			status: "failed",
			evidence: expect.stringContaining("1 dataset turns were rejected"),
		})
		expect(resumed.result.officialMetrics?.loCoMo).toMatchObject({
			retrievalCases: 2,
			abstentionCases: 1,
		})
	})

	it("fails resume when the stored LoCoMo totals contradict the loaded dataset", async () => {
		const h = await runLoCoMo()
		await h.run()
		const stored = await h.checkpoint()
		if (!stored.adapterDiagnosticsTotals) throw new Error("expected totals")
		stored.adapterDiagnosticsTotals.rejectedQaItems = 0
		await expect(h.run(stored)).rejects.toThrow(
			"benchmark checkpoint rejection counts do not match loaded dataset",
		)
	})
})
