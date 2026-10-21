import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { createOperationRunContext } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import type { BenchmarkJudgedAnswerMaterial } from "./benchmark-answer-quality.js"
import {
	type BenchmarkArm,
	benchmarkArmConfiguration,
} from "./benchmark-arms.js"
import {
	type BenchmarkArmScenarioQa,
	type BenchmarkCheckpointArm,
	createArmRuns,
	restoreCheckpointArms,
	runArmScenarioQa,
	scenarioCheckpointArms,
} from "./benchmark-arms-run.js"
import type { BenchmarkCaseExecution } from "./mongodb-benchmark-runner.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"

const ARMS: BenchmarkArm[] = [
	{ name: "a", protocol: "custom-v1", sessionTurnRecall: false },
	{ name: "b", protocol: "custom-v3", sessionTurnRecall: true },
]
const configuration = producedRunConfiguration().configuration

const execution = (caseId: string): BenchmarkCaseExecution => ({
	caseId,
	executionStatus: "succeeded",
	scoreEligibility: "retrieval",
	retrievalOutcome: "hit",
	empty: false,
	topScore: 1,
	latencyMs: 1,
	scored: true,
	hit: true,
	rAt5: 1,
	rAt10: 1,
	ndcgAt10: 1,
})

const qa = (): BenchmarkArmScenarioQa => ({
	answerModel: "answer-model",
	judge: "judge-model",
	judgeVersion: "v1",
	caseResults: [],
	attempts: { answerGeneration: 0, answerJudge: 0, decoyJudge: 0 },
	decoyProbes: { probes: 0, passes: 0 },
	tokens: {
		answer: { inputTokens: 0, outputTokens: 0, callsWithoutUsage: 0 },
		judge: { inputTokens: 0, outputTokens: 0, callsWithoutUsage: 0 },
	},
})

const entry = (name: string, passes: number): BenchmarkCheckpointArm => ({
	name,
	executionsByPass: Array.from({ length: passes }, (_, pass) => [
		execution(`${name}-${pass}`),
	]),
	qa: qa(),
})

describe("restoreCheckpointArms", () => {
	it("restores every arm's passes and answers in order", () => {
		const runs = createArmRuns(ARMS, 2, configuration)
		restoreCheckpointArms(runs, [entry("a", 2), entry("b", 2)])
		expect(
			runs.map((run) =>
				run.executionsByPass.map((pass) => pass.map((e) => e.caseId)),
			),
		).toEqual([
			[["a-0"], ["a-1"]],
			[["b-0"], ["b-1"]],
		])
		expect(runs.map((run) => run.qa.length)).toEqual([1, 1])
	})

	it("throws when the checkpoint has no entry for an arm", () => {
		const runs = createArmRuns(ARMS, 2, configuration)
		expect(() => restoreCheckpointArms(runs, [entry("a", 2)])).toThrow(
			"benchmark checkpoint has no entry for arm b",
		)
		expect(() => restoreCheckpointArms(runs, undefined)).toThrow(
			"benchmark checkpoint has no entry for arm a",
		)
	})

	it("throws when an arm's entry names another arm", () => {
		const runs = createArmRuns(ARMS, 2, configuration)
		expect(() =>
			restoreCheckpointArms(runs, [entry("a", 2), entry("c", 2)]),
		).toThrow("benchmark checkpoint has no entry for arm b")
	})

	it("throws when an arm's entry holds a different number of passes", () => {
		expect(() =>
			restoreCheckpointArms(createArmRuns(ARMS, 2, configuration), [
				entry("a", 2),
				entry("b", 1),
			]),
		).toThrow(
			"benchmark checkpoint arm b holds 1 measurement passes; the run takes 2",
		)
		expect(() =>
			restoreCheckpointArms(createArmRuns(ARMS, 2, configuration), [
				entry("a", 3),
				entry("b", 2),
			]),
		).toThrow(
			"benchmark checkpoint arm a holds 3 measurement passes; the run takes 2",
		)
	})
})

describe("createArmRuns", () => {
	it("gives each arm the configuration hash of its own arm", () => {
		const runs = createArmRuns(ARMS, 1, configuration)
		expect(runs.map((run) => run.configurationHash)).toEqual(
			ARMS.map(
				(arm) =>
					benchmarkArmConfiguration(configuration, arm).configurationHash,
			),
		)
		expect(new Set(runs.map((run) => run.configurationHash)).size).toBe(2)
	})
})

describe("scenarioCheckpointArms", () => {
	it("records each arm's executions since the scenario began and its answers", () => {
		const runs = createArmRuns(ARMS, 1, configuration)
		runs[0]?.executionsByPass[0]?.push(execution("earlier"))
		const offsets = runs.map((run) =>
			run.executionsByPass.map((pass) => pass.length),
		)
		for (const run of runs) {
			run.executionsByPass[0]?.push(execution(`${run.arm.name}-now`))
		}
		const answers = [qa(), qa()]
		const arms = scenarioCheckpointArms({ runs, offsets, qa: answers })
		expect(arms.map((arm) => arm.name)).toEqual(["a", "b"])
		expect(
			arms.map((arm) => arm.executionsByPass[0]?.map((e) => e.caseId)),
		).toEqual([["a-now"], ["b-now"]])
		expect(arms.map((arm) => arm.qa)).toEqual(answers)
	})

	it("throws when an arm has no answers for the scenario", () => {
		const runs = createArmRuns(ARMS, 1, configuration)
		const offsets = runs.map(() => [0])
		expect(() => scenarioCheckpointArms({ runs, offsets, qa: [qa()] })).toThrow(
			"paired arms: arm b has no answers for this scenario",
		)
	})

	it("throws when an arm has no execution offsets", () => {
		const runs = createArmRuns(ARMS, 1, configuration)
		expect(() =>
			scenarioCheckpointArms({ runs, offsets: [[0]], qa: [qa(), qa()] }),
		).toThrow("paired arms: arm b has no execution offsets for this scenario")
	})
})

describe("runArmScenarioQa decoy probes", () => {
	// Answers repeat the passage; the judge grades candidate === gold.
	const provider: EnrichmentProvider = {
		name: "synthetic",
		chatCompletion: async (call) => {
			const user =
				call.messages.find((message) => message.role === "user")?.content ?? ""
			if (user.includes("GOLD ANSWER:")) {
				const candidate =
					/CANDIDATE ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
				const gold = /GOLD ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
				return {
					content: JSON.stringify({
						correct: candidate === gold,
						rationale: "synthetic",
					}),
				}
			}
			const answer = /answer is (\w+)/.exec(user)?.[1] ?? "unknown"
			return { content: JSON.stringify({ answer }) }
		},
	}
	const setup = { provider, model: "answer-model", judgeModel: "judge-model" }
	const accounting = () =>
		createOperationRunContext({ runId: "arms-run", configuration }).accounting
	const material = (
		caseId: string,
		gold: string,
	): BenchmarkJudgedAnswerMaterial => ({
		caseId,
		question: `question ${caseId}`,
		goldAnswer: gold,
		abstention: false,
		contextPassages: [`the answer is ${gold}`],
	})
	const decoyPool = [
		{ caseId: "s1", question: "question s1", goldAnswer: "violet" },
		{ caseId: "s2", question: "question s2", goldAnswer: "amber" },
	]

	it("reports the probes the judge ran", async () => {
		const qa = await runArmScenarioQa({
			arm: ARMS[0] as BenchmarkArm,
			materials: [material("s1", "violet")],
			decoyPool,
			setup,
			accounting: accounting(),
		})
		expect(qa.decoyProbes).toEqual({ probes: 1, passes: 0 })
	})

	it("reports no probes, not zero probes, when the scenario had no judged question", async () => {
		const qa = await runArmScenarioQa({
			arm: ARMS[0] as BenchmarkArm,
			materials: [],
			decoyPool,
			setup,
			accounting: accounting(),
		})
		expect(qa.judge).toBeNull()
		expect(qa.decoyProbes).toBeNull()
	})
})
