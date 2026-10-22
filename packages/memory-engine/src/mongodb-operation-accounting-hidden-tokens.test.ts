import { describe, expect, it } from "vitest"
import { createOperationRunContext } from "./mongodb-operation-accounting.js"

const configuration = {
	executionProfile: "shipped" as const,
	retrievalLane: "native" as const,
	maxResults: 50,
	minScore: 0.01,
	settings: {},
}

function answerEntry(
	context: ReturnType<typeof createOperationRunContext>,
) {
	return context.accounting
		.snapshot()
		.operations.find((entry) => entry.operation === "answer-generation")
}

describe("operation accounting hidden output tokens", () => {
	it("accumulates the caller's figures and resumes them from a checkpoint", () => {
		const context = createOperationRunContext({ runId: "run", configuration })
		context.accounting.recordSuccess("answer-generation", {
			inputTokens: 6,
			outputTokens: 0,
			totalTokens: 18,
			hiddenOutputTokens: 12,
		})
		context.accounting.recordFailure("answer-generation", {
			hiddenOutputTokensUnavailable: "usage-not-reported",
		})
		const snapshot = context.accounting.snapshot()
		const entry = answerEntry(context)
		expect(entry).toMatchObject({
			totalTokens: 18,
			hiddenOutputTokens: 12,
			hiddenOutputTokensUnavailableCounts: { "usage-not-reported": 1 },
		})
		if (entry?.hiddenOutputTokensUnavailableCounts) {
			entry.hiddenOutputTokensUnavailableCounts["usage-not-reported"] = 99
		}
		expect(
			answerEntry(context)?.hiddenOutputTokensUnavailableCounts,
		).toEqual({ "usage-not-reported": 1 })

		const resumed = createOperationRunContext({
			runId: "run",
			configuration,
			initialAccounting: snapshot,
		})
		resumed.accounting.recordSuccess("answer-generation", {
			hiddenOutputTokensUnavailable: "usage-not-reported",
		})
		expect(answerEntry(resumed)).toMatchObject({
			totalTokens: 18,
			hiddenOutputTokens: 12,
			hiddenOutputTokensUnavailableCounts: { "usage-not-reported": 2 },
		})
		expect(
			snapshot.operations.find(
				(candidate) => candidate.operation === "answer-generation",
			)?.hiddenOutputTokensUnavailableCounts,
		).toEqual({ "usage-not-reported": 1 })
	})
})
