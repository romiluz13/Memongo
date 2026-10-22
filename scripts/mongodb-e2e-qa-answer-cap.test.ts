import { describe, expect, it } from "vitest"
import { OFFICIAL_ANSWER_MAX_TOKENS } from "./benchmark/longmemeval-official-scoring.js"
import { type E2eQaCase, runE2eQa } from "./mongodb-e2e-qa.js"
import {
	CUSTOM_QA_ANSWER_MAX_TOKENS,
	CUSTOM_QA_JUDGE_MAX_TOKENS,
} from "./mongodb-e2e-qa-calls.js"
import {
	heronCase,
	recordingProvider,
} from "./mongodb-e2e-qa-reader-budget.fixture.js"

// A thinking model's hidden thought tokens count against max_tokens, so the
// custom protocols give answer and judge one equal 8192 cap.

const decoySource: E2eQaCase = heronCase({
	caseId: "decoy-source",
	question: "Which river?",
	goldAnswer: "Tagus",
})

describe("custom QA answer cap", () => {
	it.each(["custom-v1", "custom-v2", "custom-v3"] as const)(
		"%s sends 8192 on answer, judge and decoy-judge calls",
		async (protocol) => {
			const { provider, calls } = recordingProvider([])
			await runE2eQa({
				provider,
				model: "fixture-answer-model",
				answerModel: "fixture-answer-model",
				judgeModel: "fixture-judge-model",
				cases: [heronCase({ contextPassages: ["The heron nested"] })],
				decoyPool: [
					{ caseId: "heron", question: "q", goldAnswer: "Quillmarsh" },
					decoySource,
				],
				protocol,
			})
			expect(calls).toHaveLength(3)
			expect(calls.map((call) => call.maxTokens)).toEqual([8192, 8192, 8192])
		},
	)

	it("keeps the caps equal and leaves the official cap at 4096", () => {
		expect(CUSTOM_QA_ANSWER_MAX_TOKENS).toBe(8192)
		expect(CUSTOM_QA_JUDGE_MAX_TOKENS).toBe(8192)
		expect(OFFICIAL_ANSWER_MAX_TOKENS).toBe(4096)
	})
})
