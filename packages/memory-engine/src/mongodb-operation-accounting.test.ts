import { describe, expect, it } from "vitest"
import {
	createOperationRunContext,
	instrumentOperationProvider,
} from "./mongodb-operation-accounting.js"

const RUN_CONFIGURATION = {
	executionProfile: "shipped",
	retrievalLane: "native",
	maxResults: 50,
	minScore: 0.01,
	settings: {},
} as const

describe("operation run accounting", () => {
	it("restores measured operation counters when resuming a benchmark run", () => {
		const context = createOperationRunContext({
			runId: "run-resumed",
			configuration: {
				executionProfile: "shipped",
				retrievalLane: "native",
				maxResults: 50,
				minScore: 0.01,
				settings: {},
			},
			initialAccounting: {
				currency: null,
				totalCost: null,
				unavailableReason: "prices unavailable",
				operations: [
					{
						operation: "rerank",
						observability: "measured",
						provider: "voyage",
						model: "rerank-2.5",
						attempted: 2,
						succeeded: 2,
						failed: 0,
					},
				],
			},
		})

		context.accounting.recordAttempt("rerank", {
			provider: "voyage",
			model: "rerank-2.5",
		})
		const rerank = context.accounting
			.snapshot()
			.operations.find((entry) => entry.operation === "rerank")
		expect(rerank).toMatchObject({
			observability: "measured",
			attempted: 3,
			succeeded: 2,
			failed: 0,
		})
	})

	it("accumulates transport-reported tokens per operation entry (C-017)", () => {
		const context = createOperationRunContext({
			runId: "run-tokens",
			configuration: RUN_CONFIGURATION,
		})

		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 120,
			outputTokens: 30,
		})
		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 40,
			outputTokens: 10,
		})

		const enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		expect(enrichment).toMatchObject({
			observability: "measured",
			succeeded: 2,
			failed: 0,
			inputTokens: 160,
			outputTokens: 40,
		})
	})

	it("keeps token fields absent when the transport reports no usage (C-017)", () => {
		const context = createOperationRunContext({
			runId: "run-no-usage",
			configuration: RUN_CONFIGURATION,
		})

		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
		})

		const enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		// Absent means "not reported by the transport", distinct from a
		// measured 0.
		expect(enrichment).not.toHaveProperty("inputTokens")
		expect(enrichment).not.toHaveProperty("outputTokens")
	})

	it("ignores non-finite token counts instead of poisoning the sums (C-017)", () => {
		const context = createOperationRunContext({
			runId: "run-bad-tokens",
			configuration: RUN_CONFIGURATION,
		})

		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 100,
			outputTokens: 20,
		})
		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: Number.NaN,
			outputTokens: Number.POSITIVE_INFINITY,
		})

		const enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		expect(enrichment).toMatchObject({
			inputTokens: 100,
			outputTokens: 20,
		})
	})

	it("downgrades the cost-unavailable note once tokens are measured (C-017)", () => {
		const withoutTokens = createOperationRunContext({
			runId: "run-note-baseline",
			configuration: RUN_CONFIGURATION,
		})
		expect(withoutTokens.accounting.snapshot().unavailableReason).toBe(
			"provider token usage and prices are not instrumented",
		)

		const withTokens = createOperationRunContext({
			runId: "run-note-measured",
			configuration: RUN_CONFIGURATION,
		})
		withTokens.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 10,
		})
		expect(withTokens.accounting.snapshot().unavailableReason).toBe(
			"provider token usage is measured; prices are not configured",
		)
	})

	it("accumulates reasoning tokens only when the gateway reports them (C-017)", () => {
		const context = createOperationRunContext({
			runId: "run-reasoning-tokens",
			configuration: RUN_CONFIGURATION,
		})

		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 10,
			outputTokens: 2,
		})
		let enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		// no reasoning reported → field stays absent (not reported ≠ 0)
		expect(enrichment).not.toHaveProperty("reasoningTokens")

		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 1,
			outputTokens: 1,
			reasoningTokens: 1899,
		})
		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 1,
			outputTokens: 1,
			reasoningTokens: 101,
		})
		context.accounting.recordSuccess("enrichment", {
			provider: "gateway",
			model: "glm-5.3",
			inputTokens: 1,
			outputTokens: 1,
			reasoningTokens: Number.NaN,
		})
		enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		// accumulated when finite; non-finite does not poison the sum
		expect(enrichment).toMatchObject({
			inputTokens: 13,
			outputTokens: 5,
			reasoningTokens: 2000,
		})
	})

	it("threads transport usage through instrumentOperationProvider (C-017)", async () => {
		const context = createOperationRunContext({
			runId: "run-provider-threading",
			configuration: RUN_CONFIGURATION,
		})
		const transport = {
			name: "gateway",
			chatCompletion: async () => ({
				text: "{}",
				usage: { inputTokens: 17, outputTokens: 4 },
			}),
		}
		const provider = instrumentOperationProvider({
			provider: transport,
			runContext: context,
			operation: "enrichment",
		})

		await provider.chatCompletion({
			model: "glm-5.3",
			messages: [{ role: "user", content: "extract" }],
		})

		const enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		expect(enrichment).toMatchObject({
			attempted: 1,
			succeeded: 1,
			failed: 0,
			inputTokens: 17,
			outputTokens: 4,
		})
	})

	it("threads gateway reasoning tokens through the cost wrapper (C-017)", async () => {
		const context = createOperationRunContext({
			runId: "run-reasoning-threading",
			configuration: RUN_CONFIGURATION,
		})
		const transport = {
			name: "gateway",
			chatCompletion: async () => ({
				text: "{}",
				usage: {
					inputTokens: 410,
					outputTokens: 2048,
					reasoningTokens: 1899,
				},
			}),
		}
		const provider = instrumentOperationProvider({
			provider: transport,
			runContext: context,
			operation: "relation-extraction",
		})

		await provider.chatCompletion({
			model: "glm-5.3",
			messages: [{ role: "user", content: "extract" }],
		})

		const extraction = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "relation-extraction" &&
					entry.provider === "gateway",
			)
		expect(extraction).toMatchObject({
			attempted: 1,
			succeeded: 1,
			failed: 0,
			inputTokens: 410,
			outputTokens: 2048,
			reasoningTokens: 1899,
		})
	})

	it("accounts an empty-200 response as a successful paid call (C-017)", async () => {
		const context = createOperationRunContext({
			runId: "run-empty-200",
			configuration: RUN_CONFIGURATION,
		})
		const transport = {
			name: "gateway",
			chatCompletion: async () => ({
				text: "",
				usage: { inputTokens: 9, outputTokens: 2 },
			}),
		}
		const provider = instrumentOperationProvider({
			provider: transport,
			runContext: context,
			operation: "enrichment",
		})

		await provider.chatCompletion({
			model: "glm-5.3",
			messages: [{ role: "user", content: "extract" }],
		})

		const enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		// Empty content is a classification concern at the consumer; the
		// transport call itself succeeded (empty-200 is a paid call), so
		// its usage flows through success accounting with no gap.
		expect(enrichment).toMatchObject({
			attempted: 1,
			succeeded: 1,
			failed: 0,
			inputTokens: 9,
			outputTokens: 2,
		})
	})

	it("records failure without token fields when the transport throws (C-017)", async () => {
		const context = createOperationRunContext({
			runId: "run-provider-failure",
			configuration: RUN_CONFIGURATION,
		})
		const transport = {
			name: "gateway",
			chatCompletion: async () => {
				throw new Error("gateway unavailable")
			},
		}
		const provider = instrumentOperationProvider({
			provider: transport,
			runContext: context,
			operation: "enrichment",
		})

		await expect(
			provider.chatCompletion({
				model: "glm-5.3",
				messages: [{ role: "user", content: "extract" }],
			}),
		).rejects.toThrow("gateway unavailable")

		const enrichment = context.accounting
			.snapshot()
			.operations.find(
				(entry) =>
					entry.operation === "enrichment" && entry.provider === "gateway",
			)
		expect(enrichment).toMatchObject({
			attempted: 1,
			succeeded: 0,
			failed: 1,
		})
		expect(enrichment).not.toHaveProperty("inputTokens")
		expect(enrichment).not.toHaveProperty("outputTokens")
	})

	describe("usage completeness", () => {
		const gateway = { provider: "gateway", model: "glm-5.3" }
		const entryOf = (context: ReturnType<typeof createOperationRunContext>) =>
			context.accounting
				.snapshot()
				.operations.find(
					(entry) =>
						entry.operation === "answer-generation" &&
						entry.provider === "gateway",
				)

		it("marks the usage sum complete when every call reported usage", () => {
			const context = createOperationRunContext({
				runId: "run-usage-present",
				configuration: RUN_CONFIGURATION,
			})
			for (const tokens of [10, 20]) {
				context.accounting.recordAttempt("answer-generation", gateway)
				context.accounting.recordSuccess("answer-generation", {
					...gateway,
					inputTokens: tokens,
					outputTokens: 1,
				})
			}
			expect(entryOf(context)).toMatchObject({
				succeeded: 2,
				inputTokens: 30,
				outputTokens: 2,
				callsWithUsage: 2,
				callsMissingUsage: 0,
				usageComplete: true,
			})
		})

		it("counts every call without usage, failures included, and leaves token sums absent", () => {
			const context = createOperationRunContext({
				runId: "run-usage-absent",
				configuration: RUN_CONFIGURATION,
			})
			context.accounting.recordSuccess("answer-generation", gateway)
			context.accounting.recordFailure("answer-generation", gateway)
			const entry = entryOf(context)
			expect(entry).toMatchObject({
				succeeded: 1,
				failed: 1,
				callsWithUsage: 0,
				callsMissingUsage: 2,
				usageComplete: false,
			})
			expect(entry).not.toHaveProperty("inputTokens")
			const notRun = context.accounting
				.snapshot()
				.operations.find((e) => e.operation === "rerank")
			expect(notRun).not.toHaveProperty("usageComplete")
			expect(notRun).not.toHaveProperty("callsMissingUsage")
		})

		it("records usage once per call on success or failure, marks a mixed sum incomplete, and keeps the counters across resume", () => {
			const context = createOperationRunContext({
				runId: "run-usage-mixed",
				configuration: RUN_CONFIGURATION,
			})
			context.accounting.recordSuccess("answer-generation", {
				...gateway,
				inputTokens: 100,
				outputTokens: 10,
			})
			context.accounting.recordSuccess("answer-generation", gateway)
			context.accounting.recordFailure("answer-generation", {
				...gateway,
				inputTokens: 7,
				outputTokens: 512,
			})
			context.accounting.recordSuccess("answer-generation", {
				...gateway,
				inputTokens: Number.NaN,
				outputTokens: 3,
			})
			expect(entryOf(context)).toMatchObject({
				succeeded: 3,
				failed: 1,
				inputTokens: 107,
				outputTokens: 525,
				callsWithUsage: 2,
				callsMissingUsage: 2,
				usageComplete: false,
			})

			const resumed = createOperationRunContext({
				runId: "run-usage-mixed",
				configuration: RUN_CONFIGURATION,
				initialAccounting: context.accounting.snapshot(),
			})
			resumed.accounting.recordSuccess("answer-generation", {
				...gateway,
				inputTokens: 1,
				outputTokens: 1,
			})
			expect(entryOf(resumed)).toMatchObject({
				callsWithUsage: 3,
				callsMissingUsage: 2,
				usageComplete: false,
			})
		})
	})

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("refuses a non-finite setting that would hash like null (%s)", (value) => {
		const configuration = {
			executionProfile: "shipped" as const,
			retrievalLane: "native" as const,
			maxResults: 10,
			minScore: 0.01,
			settings: { knob: value },
		}
		expect(() =>
			createOperationRunContext({ runId: "run", configuration }),
		).toThrow(RangeError)
	})
})
