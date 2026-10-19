import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeRecallConversation: vi.fn(
		async (_params: Record<string, unknown>): Promise<unknown> => ({
			results: [],
		}),
	),
}))
vi.mock(
	"@memongo/memory-bridge",
	() =>
		new Proxy(bridge, {
			get(target, key) {
				if (key === "then") return undefined
				if (key in target) return target[key as keyof typeof target]
				return vi.fn(() => {
					throw new Error("Unexpected bridge operation")
				})
			},
		}),
)
beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, "error").mockImplementation(() => {})
})

async function recall(body: Record<string, unknown>) {
	const response = await new Hono()
		.route("/v1", createV1Router())
		.request("/v1/recall-conversation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: "agent1", ...body }),
		})
	return {
		status: response.status,
		body: (await response.json()) as {
			error?: { code: string; message: string }
			outcomes?: { status: string; lanes: unknown[] }
		},
	}
}

function typedError(name: string, reason: string, stage: string) {
	return Object.assign(new Error("private provider detail"), {
		name,
		lane: "recall",
		stage,
		reason,
	})
}

describe("POST /v1/recall-conversation typed failures (M2 T6)", () => {
	it("maps a retryable recall lane failure to 503 with its outcome row", async () => {
		bridge.memongoBridgeRecallConversation.mockRejectedValue(
			typedError("SearchLaneError", "index-not-ready", "rank-fusion"),
		)
		const { status, body } = await recall({ query: "deploy" })
		expect(status).toBe(503)
		expect(body.error?.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(JSON.stringify(body)).not.toContain("private provider detail")
		expect(body.outcomes).toEqual({
			status: "failed",
			lanes: [
				{
					lane: "recall",
					stage: "rank-fusion",
					outcome: "failed",
					reason: "index-not-ready",
				},
			],
		})
	})

	it("maps a recall query error to 500 SEARCH_LANES_FAILED, never an empty 200", async () => {
		bridge.memongoBridgeRecallConversation.mockRejectedValue(
			typedError("SearchLaneError", "query-error", "rank-fusion"),
		)
		const { status, body } = await recall({ query: "deploy" })
		expect(status).toBe(500)
		expect(body.error?.code).toBe("SEARCH_LANES_FAILED")
	})

	it("maps a recall admission denial to 503 SEARCH_BUDGET_EXHAUSTED", async () => {
		bridge.memongoBridgeRecallConversation.mockRejectedValue(
			typedError("SearchBudgetDeniedError", "budget-embeds", "request"),
		)
		const { status, body } = await recall({ query: "deploy" })
		expect(status).toBe(503)
		expect(body.error?.code).toBe("SEARCH_BUDGET_EXHAUSTED")
		expect(body.outcomes?.lanes).toEqual([
			{
				lane: "recall",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-embeds",
			},
		])
	})

	it("maps an invalid timezone to a 400 validation error", async () => {
		bridge.memongoBridgeRecallConversation.mockRejectedValue(
			new Error("invalid timezone"),
		)
		const { status, body } = await recall({
			timezone: "Mars/Olympus",
			startTime: "2026-04-08",
		})
		expect(status).toBe(400)
		expect(body.error).toEqual({
			code: "VALIDATION_ERROR",
			message: "invalid timezone",
		})
	})
})
