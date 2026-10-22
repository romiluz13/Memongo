import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseBenchmarkArms } from "./benchmark-arms.js"
import type { BenchmarkCheckpoint } from "./mongodb-benchmark-checkpoint.js"
import { projectBenchmarkParityFields } from "./mongodb-benchmark-runner.js"
import { attachBenchmarkOperationsReport } from "./mongodb-manager-benchmark.js"
import {
	armsRunContext,
	runArmsFixture,
} from "./mongodb-manager-benchmark-arms.fixture.js"

// The answerer repeats whatever the context says the answer is; the judge
// grades candidate === gold. Answer calls bill 100/5 tokens, judge calls 50/3.
const { probe } = vi.hoisted(() => {
	const state = {
		log: [] as string[],
		failAnswer: (_user: string) => false,
	}
	const provider = {
		name: "synthetic-deterministic",
		chatCompletion: async (params: {
			messages: Array<{ role: string; content: string }>
		}) => {
			const user =
				params.messages.find((message) => message.role === "user")?.content ??
				""
			if (user.includes("GOLD ANSWER:")) {
				state.log.push("judge")
				const candidate =
					/CANDIDATE ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
				const gold = /GOLD ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
				return {
					content: JSON.stringify({
						correct: candidate === gold,
						rationale: "synthetic",
					}),
					usage: { inputTokens: 50, outputTokens: 3 },
				}
			}
			state.log.push("answer")
			if (state.failAnswer(user)) throw new Error("synthetic transport failure")
			const answer = /answer is (\w+)/.exec(user)?.[1] ?? "unknown"
			return {
				content: JSON.stringify({ answer }),
				usage: { inputTokens: 100, outputTokens: 5 },
			}
		},
	}
	return { probe: { state, provider } }
})

vi.mock(
	"../../packages/memory-engine/src/mongodb-llm-enrichment.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../packages/memory-engine/src/mongodb-llm-enrichment.js")
		>()),
		resolveEnrichmentProvider: vi.fn(() => probe.provider),
		createHttpProvider: vi.fn(() => probe.provider),
	}),
)

const { kit } = vi.hoisted(() => ({
	kit: () =>
		import("../../packages/memory-engine/src/test-helpers/manager-test-kit.js"),
}))
vi.mock("../../packages/memory-engine/src/mongodb-events.js", async () =>
	(await kit()).eventsModuleMock(),
)
vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(await kit()).benchmarkQualityContractsModuleMock(importOriginal),
)
vi.mock("./benchmark-relevance.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./benchmark-relevance.js")>()),
	persistBenchmarkRegression: vi.fn().mockResolvedValue([]),
}))
vi.mock(
	"../../packages/memory-engine/src/mongodb-conversation-recall.js",
	async () => (await kit()).conversationRecallModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-ops.js", async () =>
	(await kit()).opsModuleMock(),
)
vi.mock("./mongodb-benchmark-harness.js", async () =>
	(await kit()).benchmarkHarnessModuleMock(),
)
vi.mock(
	"../../packages/memory-engine/src/mongodb-retrieval-planner.js",
	async () => (await kit()).retrievalPlannerModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-episodes.js", async () =>
	(await kit()).episodesModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-graph.js", async () =>
	(await kit()).graphModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-schema.js", async () =>
	(await kit()).schemaModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-query-cache.js", async () =>
	(await kit()).queryCacheModuleMock(),
)
vi.mock(
	"../../packages/memory-engine/src/mongodb-query-rewriter.js",
	async () => (await kit()).queryRewriterModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-lane-coverage.js", async () =>
	(await kit()).laneCoverageModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-memory-jobs.js", async () =>
	(await kit()).memoryJobsModuleMock(),
)
vi.mock("../../packages/memory-engine/src/mongodb-consolidator.js", async () =>
	(await kit()).consolidatorModuleMock(),
)
vi.mock(
	"../../packages/memory-engine/src/mongodb-derived-memory.js",
	async () => (await kit()).derivedMemoryModuleMock(),
)
vi.mock("./mongodb-benchmark-readiness.js", async (importOriginal) =>
	(await kit()).benchmarkReadinessModuleMock(importOriginal),
)
vi.mock("../../packages/memory-engine/src/mongodb-telemetry.js", async () =>
	(await kit()).telemetryModuleMock(),
)

const ARMS = "a=custom-v1,b=custom-v3+recall,c=custom-v2"

beforeEach(() => {
	probe.state.log = []
	probe.state.failAnswer = () => false
})
afterEach(() => {
	vi.unstubAllEnvs()
})

function run(options: {
	checkpointPath?: string
	resumeCheckpoint?: BenchmarkCheckpoint
}) {
	return runArmsFixture({
		arms: parseBenchmarkArms(ARMS),
		log: probe.state.log,
		runContext: armsRunContext(ARMS),
		...options,
	})
}

describe("paired benchmark arms", () => {
	it("ingests each question once, then searches, answers and judges every arm in order before cleanup", async () => {
		await run({})
		const arm = (recall: boolean, scenarioId: string) => [
			`search:question ${scenarioId}:recall=${recall}`,
			"answer",
			"judge",
			"judge",
		]
		const scenario = (scenarioId: string) => [
			`ingest:${scenarioId}`,
			...arm(false, scenarioId),
			...arm(true, scenarioId),
			...arm(false, scenarioId),
			"cleanup",
		]
		expect(probe.state.log).toEqual([...scenario("s1"), ...scenario("s2")])
	})

	it("hands each search its arm's turn recall mode and nothing else leaks between arms", async () => {
		const { search } = await run({})
		const options = search.mock.calls.map(
			(call) => call[1] as Record<string, unknown>,
		)
		expect(options.map((entry) => entry.sessionTurnRecall)).toEqual([
			false,
			true,
			false,
			false,
			true,
			false,
		])
		expect(options.map((entry) => entry.includeRoundPartner)).toEqual([
			undefined,
			true,
			undefined,
			undefined,
			true,
			undefined,
		])
	})

	it("keeps each arm's metrics, ledgers and answers separate and reports the pairs", async () => {
		const { outcome } = await run({})
		const arms = outcome.result.arms ?? []
		expect(arms.map((entry) => entry.name)).toEqual(["a", "b", "c"])
		expect(arms.map((entry) => entry.result.hitRate)).toEqual([0, 1, 0])
		expect(arms.map((entry) => entry.e2eQa.accuracy)).toEqual([0, 1, 0])
		expect(arms.map((entry) => entry.result.missLedger?.length)).toEqual([
			2, 0, 2,
		])
		expect(arms.map((entry) => entry.e2eQa.judgeVersion)).toEqual([
			"v1",
			"v3",
			"v2",
		])
		expect(arms[1]?.e2eQa.readerBudgetCalibration?.answerCalls).toBe(2)
		expect(arms[1]?.e2eQa.readerPositionTerciles).toBeDefined()
		expect(arms[0]?.e2eQa.readerBudgetCalibration).toBeUndefined()
		expect(arms[0]?.e2eQa.judgeFalsePositiveRate).toBe(0)
		expect(new Set(arms.map((entry) => entry.configurationHash)).size).toBe(3)
		expect(outcome.result.hitRate).toBe(arms[0]?.result.hitRate)
		expect(outcome.e2eQa?.accuracy).toBe(0)

		const report = outcome.result.pairedArms
		expect(report?.baseline).toBe("a")
		expect(report?.comparisons).toMatchObject([
			{ arm: "b", pairs: 2, armOnly: 2, baselineOnly: 0, bothWrong: 0 },
			{ arm: "c", pairs: 2, armOnly: 0, baselineOnly: 0, bothWrong: 2 },
		])
		expect(report?.comparisons[0]?.mcnemar.pTwoSided).toBe(0.5)
		// The fixture reports no total_tokens: one answer call, and a judge and
		// a decoy-judge call, per question, each without a hidden-token figure.
		expect(report?.arms[0]?.tokens).toEqual({
			answer: {
				inputTokens: 200,
				outputTokens: 10,
				callsWithoutUsage: 0,
				totalTokens: 0,
				hiddenOutputTokens: 0,
				hiddenOutputTokensUnavailable: { "total-tokens-not-reported": 2 },
			},
			judge: {
				inputTokens: 200,
				outputTokens: 12,
				callsWithoutUsage: 0,
				totalTokens: 0,
				hiddenOutputTokens: 0,
				hiddenOutputTokensUnavailable: { "total-tokens-not-reported": 4 },
			},
		})
	})

	it("labels the run's operation accounting as pooling every arm's calls", async () => {
		const runContext = armsRunContext(ARMS)
		const { outcome } = await runArmsFixture({
			arms: parseBenchmarkArms(ARMS),
			log: probe.state.log,
			runContext,
		})
		const parity = await projectBenchmarkParityFields({
			db: {
				command: async () => {
					throw new Error("no cluster offline")
				},
			},
			collectionName: "test_events",
			datasetPath: fileURLToPath(import.meta.url),
			mongoEmbeddingConfig: { numDimensions: 8, quantization: "none" },
			latencySamples: [1],
			cost: runContext.accounting.snapshot(),
			runContext,
		})
		const cost = attachBenchmarkOperationsReport(outcome.result, parity)
			.benchmarkReport?.cost
		expect(cost?.pooledArms).toEqual(["a", "b", "c"])
		const answerCalls = cost?.operations.find(
			(entry) => entry.operation === "answer-generation",
		)
		expect(answerCalls?.succeeded).toBe(6)
	})

	it("refuses arms on the raw-session lane and on a dataset without judged answers before any work", async () => {
		await expect(
			runArmsFixture({
				arms: parseBenchmarkArms(ARMS),
				log: probe.state.log,
				runContext: armsRunContext(ARMS),
				retrievalLane: "raw-session",
			}),
		).rejects.toThrow("paired arms require the native retrieval lane")
		await expect(
			runArmsFixture({
				arms: parseBenchmarkArms(ARMS),
				log: probe.state.log,
				runContext: armsRunContext(ARMS),
				datasetKind: "locomo",
			}),
		).rejects.toThrow("paired arms require a LongMemEval dataset")
		expect(probe.state.log).toEqual([])
	})
})

describe("paired arms checkpoint and resume", () => {
	let directory: string
	beforeEach(async () => {
		directory = await mkdtemp(path.join(os.tmpdir(), "memongo-arms-"))
	})
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true })
	})

	const read = async (checkpointPath: string) =>
		JSON.parse(await readFile(checkpointPath, "utf8")) as BenchmarkCheckpoint

	it("checkpoints a question only once every arm has a verdict and resumes the rest", async () => {
		const checkpointPath = path.join(directory, "checkpoint.json")
		probe.state.failAnswer = (user) => user.includes("answer is amber")
		const first = await run({ checkpointPath })
		expect(
			first.outcome.result.pairedArms?.perQuestion.map((row) => row.verdicts),
		).toEqual([
			{ a: "incorrect", b: "correct", c: "incorrect" },
			{ a: "incorrect", b: "missing", c: "incorrect" },
		])
		const afterFirst = await read(checkpointPath)
		expect(
			afterFirst.completedScenarios.map((entry) => entry.scenarioId),
		).toEqual(["s1"])
		expect(
			afterFirst.completedScenarios[0]?.arms?.map((entry) => entry.name),
		).toEqual(["a", "b", "c"])

		probe.state.log = []
		probe.state.failAnswer = () => false
		const second = await run({ checkpointPath, resumeCheckpoint: afterFirst })
		expect(
			probe.state.log.filter((entry) => entry.startsWith("ingest")),
		).toEqual(["ingest:s2"])
		expect(
			second.outcome.result.pairedArms?.perQuestion.map((row) => row.verdicts),
		).toEqual([
			{ a: "incorrect", b: "correct", c: "incorrect" },
			{ a: "incorrect", b: "correct", c: "incorrect" },
		])
		expect(second.outcome.result.arms?.[1]?.e2eQa.accuracy).toBe(1)
		expect(second.outcome.e2eQa?.unavailableReason).toBeUndefined()

		const afterSecond = await read(checkpointPath)
		const tampered = structuredClone(afterSecond)
		const s1 = tampered.completedScenarios.find(
			(entry) => entry.scenarioId === "s1",
		)
		const armC = s1?.arms?.find((entry) => entry.name === "c")
		if (!armC) throw new Error("checkpoint has no arm c for s1")
		armC.qa.caseResults = []
		probe.state.log = []
		await run({ checkpointPath, resumeCheckpoint: tampered })
		expect(
			probe.state.log.filter((entry) => entry.startsWith("ingest")),
		).toEqual(["ingest:s1"])
	})
})
