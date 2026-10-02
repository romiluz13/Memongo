import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeRecallConversation: vi.fn(
		async (_params: Record<string, unknown>) => ({ results: [] }),
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
beforeEach(() => vi.clearAllMocks())
async function request(body: Record<string, unknown>) {
	return new Hono()
		.route("/v1", createV1Router())
		.request("/v1/recall-conversation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: "agent1", ...body }),
		})
}
describe("recall optional primitive input validation", () => {
	it.each([
		["query", 123],
		["query", null],
		["query", {}],
		["startTime", 123],
		["startTime", null],
		["endTime", 123],
		["endTime", null],
		["timezone", 123],
		["timezone", null],
		["includeToolMessages", "true"],
		["includeToolMessages", 123],
		["includeToolMessages", null],
	] as const)("rejects wrong type %s=%j before recall", async (field, value) => {
		const response = await request({ [field]: value })
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: expect.stringContaining(field),
			},
		})
		expect(bridge.memongoBridgeRecallConversation).not.toHaveBeenCalled()
	})
	it.each([
		{},
		{
			query: "",
			startTime: "",
			endTime: "",
			timezone: "",
			includeToolMessages: false,
		},
		{
			query: "meeting",
			startTime: "2020-01-01",
			endTime: "2025-01-01",
			timezone: "UTC",
			includeToolMessages: true,
		},
	])("preserves typed or omitted values %j", async (body) => {
		expect((await request(body)).status).toBe(200)
		const sent = bridge.memongoBridgeRecallConversation.mock.calls[0]?.[0]
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledOnce()
		for (const field of [
			"query",
			"startTime",
			"endTime",
			"timezone",
			"includeToolMessages",
		]) {
			expect(sent?.[field]).toEqual((body as Record<string, unknown>)[field])
		}
	})
	it.each([
		[
			{ query: 123, roles: ["invalid"] },
			"roles must contain only user|assistant|system|tool",
		],
		[{ query: 123, asOf: "not-a-date" }, "asOf must be a valid date"],
		[
			{ query: 123, scope: "invalid" },
			"scope must be session|user|agent|workspace|tenant|global",
		],
	] as const)("preserves earlier validation for %j", async (body, message) => {
		const response = await request(body)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message },
		})
		expect(bridge.memongoBridgeRecallConversation).not.toHaveBeenCalled()
	})
})
