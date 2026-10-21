import { describe, expect, it } from "vitest"
import { createOperationRunContext } from "./mongodb-operation-accounting.js"

const RUN_CONFIGURATION = {
	executionProfile: "diagnostic",
	retrievalLane: "native",
	maxResults: 20,
	minScore: 0,
	settings: {},
} as const

const ANSWERER = { provider: "fixture", model: "fixture-answer-model" }
const JUDGE = { provider: "fixture", model: "fixture-judge-model" }

function entryFor(
	context: ReturnType<typeof createOperationRunContext>,
	operation: string,
) {
	return context.accounting
		.snapshot()
		.operations.find((entry) => entry.operation === operation)
}

describe("per-operation outcome counters (B5)", () => {
	it("counts ended calls by status and by finish reason, per operation", () => {
		const context = createOperationRunContext({
			runId: "run-outcomes",
			configuration: RUN_CONFIGURATION,
		})
		const { accounting } = context
		accounting.recordSuccess("answer-generation", {
			...ANSWERER,
			status: "answer",
			finishReason: "stop",
		})
		accounting.recordSuccess("answer-generation", {
			...ANSWERER,
			status: "truncated",
			finishReason: "length",
		})
		accounting.recordSuccess("answer-generation", {
			...ANSWERER,
			status: "invalid-json",
			finishReason: "stop",
		})
		accounting.recordFailure("answer-generation", {
			...ANSWERER,
			status: "transport-failure",
		})
		accounting.recordSuccess("answer-judge", {
			...JUDGE,
			status: "verdict",
			finishReason: "stop",
		})
		accounting.recordSuccess("answer-judge", {
			...JUDGE,
			status: "truncated",
			finishReason: "max_tokens",
		})
		accounting.recordSuccess("decoy-judge", {
			...JUDGE,
			status: "missing-verdict",
			finishReason: "safety",
		})

		expect(entryFor(context, "answer-generation")).toMatchObject({
			succeeded: 3,
			failed: 1,
			statusCounts: {
				answer: 1,
				truncated: 1,
				"invalid-json": 1,
				"transport-failure": 1,
			},
			finishReasonCounts: { stop: 2, length: 1 },
		})
		expect(entryFor(context, "answer-judge")).toMatchObject({
			statusCounts: { verdict: 1, truncated: 1 },
			finishReasonCounts: { stop: 1, max_tokens: 1 },
		})
		expect(entryFor(context, "decoy-judge")).toMatchObject({
			statusCounts: { "missing-verdict": 1 },
			finishReasonCounts: { safety: 1 },
		})
	})

	it("leaves the counters absent when no call reported an outcome", () => {
		const context = createOperationRunContext({
			runId: "run-no-outcomes",
			configuration: RUN_CONFIGURATION,
		})
		context.accounting.recordSuccess("enrichment", {
			provider: "fixture",
			model: "fixture-model",
		})
		const entry = entryFor(context, "enrichment")
		expect(entry).not.toHaveProperty("statusCounts")
		expect(entry).not.toHaveProperty("finishReasonCounts")
	})

	it("keeps the counters across a resume without sharing them with the checkpoint", () => {
		const first = createOperationRunContext({
			runId: "run-resume",
			configuration: RUN_CONFIGURATION,
		})
		first.accounting.recordSuccess("answer-judge", {
			...JUDGE,
			status: "truncated",
			finishReason: "length",
		})
		const checkpoint = first.accounting.snapshot()
		const resumed = createOperationRunContext({
			runId: "run-resume",
			configuration: RUN_CONFIGURATION,
			initialAccounting: checkpoint,
		})
		resumed.accounting.recordSuccess("answer-judge", {
			...JUDGE,
			status: "truncated",
			finishReason: "length",
		})
		expect(entryFor(resumed, "answer-judge")).toMatchObject({
			statusCounts: { truncated: 2 },
			finishReasonCounts: { length: 2 },
		})
		expect(
			checkpoint.operations.find((entry) => entry.operation === "answer-judge"),
		).toMatchObject({
			statusCounts: { truncated: 1 },
			finishReasonCounts: { length: 1 },
		})
	})
})
