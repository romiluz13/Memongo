import { describe, expect, it } from "vitest"
import { createOperationRunContext } from "./mongodb-operation-accounting.js"

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
})
