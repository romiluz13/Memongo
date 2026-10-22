import { describe, expect, it } from "vitest"
import {
	createOperationRunContext,
	type OperationRunContext,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { judgedAnswerCallObserver } from "./benchmark-answer-quality.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"

// Run cost operations: total and hidden tokens beside input and output.

function entry(context: OperationRunContext, operation: string) {
	return context.accounting
		.snapshot()
		.operations.find((candidate) => candidate.operation === operation)
}

describe("run cost operations hidden output tokens", () => {
	it("totals each operation's total and hidden tokens and names why any are missing", () => {
		const context = createOperationRunContext({
			runId: "hidden-tokens",
			configuration: producedRunConfiguration().configuration,
		})
		const observe = judgedAnswerCallObserver(
			{
				provider: {
					name: "synthetic",
					chatCompletion: async () => ({ content: "" }),
				},
				model: "answer-model",
				judgeModel: "judge-model",
			},
			context.accounting,
		)
		observe("answer-generation", "attempted")
		observe(
			"answer-generation",
			"succeeded",
			{ inputTokens: 6, outputTokens: 0, totalTokens: 18 },
			{ status: "truncated", finishReason: "length" },
		)
		observe("answer-generation", "attempted")
		observe(
			"answer-generation",
			"succeeded",
			{ inputTokens: 6, outputTokens: 2, totalTokens: 20 },
			{ status: "answer", finishReason: "stop" },
		)
		observe("answer-judge", "attempted")
		observe(
			"answer-judge",
			"succeeded",
			{ inputTokens: 40, outputTokens: 9 },
			{ status: "verdict", finishReason: "stop" },
		)
		observe("decoy-judge", "attempted")
		observe("decoy-judge", "failed", undefined, {
			status: "transport-failure",
		})

		expect(entry(context, "answer-generation")).toMatchObject({
			inputTokens: 12,
			outputTokens: 2,
			totalTokens: 38,
			hiddenOutputTokens: 24,
			finishReasonCounts: { length: 1, stop: 1 },
		})
		expect(entry(context, "answer-generation")).not.toHaveProperty(
			"hiddenOutputTokensUnavailableCounts",
		)
		const judge = entry(context, "answer-judge")
		expect(judge).toMatchObject({
			hiddenOutputTokensUnavailableCounts: { "total-tokens-not-reported": 1 },
		})
		expect(judge).not.toHaveProperty("totalTokens")
		expect(judge).not.toHaveProperty("hiddenOutputTokens")
		expect(entry(context, "decoy-judge")).toMatchObject({
			hiddenOutputTokensUnavailableCounts: { "usage-not-reported": 1 },
		})
	})
})
