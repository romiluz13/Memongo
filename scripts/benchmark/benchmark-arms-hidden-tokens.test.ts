import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { createOperationRunContext } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import {
	type ArmCaseResult,
	type ArmTokenTotals,
	buildPairedArmsReport,
} from "./benchmark-arms-report.js"
import type { BenchmarkArm } from "./benchmark-arms.js"
import { runArmScenarioQa } from "./benchmark-arms-run.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"

// Answers report the live probe's usage (prompt 6, completion 0, total 18);
// the judge reports no total_tokens. Fictional strings only.
const provider: EnrichmentProvider = {
	name: "synthetic",
	chatCompletion: async (call) => {
		const user =
			call.messages.find((message) => message.role === "user")?.content ?? ""
		if (user.includes("GOLD ANSWER:")) {
			return {
				content: JSON.stringify({ correct: true, rationale: "synthetic" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
				usage: { inputTokens: 40, outputTokens: 9 },
			}
		}
		return {
			content: JSON.stringify({ answer: "violet" }),
			responseMeta: { shape: "ok", finishReason: "stop" },
			usage: { inputTokens: 6, outputTokens: 0, totalTokens: 18 },
		}
	},
}

const arm: BenchmarkArm = {
	name: "a",
	protocol: "custom-v1",
	sessionTurnRecall: false,
}

describe("arm hidden output tokens", () => {
	it("totals total and hidden tokens, and names why the judge's are missing", async () => {
		const qa = await runArmScenarioQa({
			arm,
			materials: [
				{
					caseId: "s1",
					question: "question s1",
					goldAnswer: "violet",
					abstention: false,
					contextPassages: ["the answer is violet"],
				},
			],
			decoyPool: [
				{ caseId: "s1", question: "question s1", goldAnswer: "violet" },
				{ caseId: "s2", question: "question s2", goldAnswer: "amber" },
			],
			setup: { provider, model: "answer-model", judgeModel: "judge-model" },
			accounting: createOperationRunContext({
				runId: "hidden-tokens",
				configuration: producedRunConfiguration().configuration,
			}).accounting,
		})
		expect(qa.tokens.answer).toEqual({
			inputTokens: 6,
			outputTokens: 0,
			callsWithoutUsage: 0,
			totalTokens: 18,
			hiddenOutputTokens: 12,
			hiddenOutputTokensUnavailable: {},
		})
		expect(qa.tokens.judge).toEqual({
			inputTokens: 80,
			outputTokens: 18,
			callsWithoutUsage: 0,
			totalTokens: 0,
			hiddenOutputTokens: 0,
			hiddenOutputTokensUnavailable: { "total-tokens-not-reported": 2 },
		})
	})
})

describe("arm length-finish count", () => {
	const answered = (
		caseId: string,
		finishReason?: "length" | "max_tokens" | "stop",
	): ArmCaseResult => ({
		caseId,
		candidateAnswer: "",
		correct: false,
		abstention: false,
		latencyMs: 1,
		...(finishReason
			? {
					answerAttempt: {
						layer: "transport",
						status: finishReason === "stop" ? "answer" : "truncated",
						finishReason,
					},
				}
			: {}),
	})
	const totals = {
		inputTokens: 0,
		outputTokens: 0,
		callsWithoutUsage: 0,
		totalTokens: 0,
		hiddenOutputTokens: 0,
		hiddenOutputTokensUnavailable: {},
	}
	const tokens: ArmTokenTotals = { answer: totals, judge: totals }

	it("counts each arm's answers that stopped at the token limit", () => {
		const report = buildPairedArmsReport({
			caseIds: ["q1", "q2", "q3"],
			arms: [
				{
					arm,
					configurationHash: "a".repeat(64),
					caseResults: [
						answered("q1", "length"),
						answered("q2", "stop"),
						answered("q3"),
					],
					tokens,
				},
				{
					arm: { ...arm, name: "b" },
					configurationHash: "b".repeat(64),
					caseResults: [
						answered("q1", "length"),
						answered("q2", "max_tokens"),
						answered("q3", "stop"),
					],
					tokens,
				},
			],
		})
		expect(report.arms.map((summary) => summary.lengthFinishAnswers)).toEqual(
			[1, 2],
		)
	})
})
