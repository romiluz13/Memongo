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
describe("recall scope validation", () => {
	it.each([
		[
			{ scope: "invalid" },
			"scope must be session|user|agent|workspace|tenant|global",
		],
		[{ scope: "user" }, "user scope requires scopeRef"],
		[{ scope: "tenant" }, "tenant scope requires scopeRef"],
		[
			{ scope: "session" },
			"session scope requires sessionId, sessionKey, scopeRef, or containerTag",
		],
	] as const)("rejects %j before recall", async (body, message) => {
		const response = await request(body)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message },
		})
		expect(bridge.memongoBridgeRecallConversation).not.toHaveBeenCalled()
	})
	it.each([
		{},
		{ scope: "agent" },
		{ scope: "user", scopeRef: "user:alice" },
		{ scope: "session", sessionId: "session1" },
	])("preserves valid or absent scope %j", async (body) => {
		expect((await request(body)).status).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledOnce()
	})
	it.each([
		[
			{ roles: ["invalid"], scope: "invalid" },
			"roles must contain only user|assistant|system|tool",
		],
		[{ asOf: "not-a-date", scope: "invalid" }, "asOf must be a valid date"],
	] as const)("preserves earlier validation for %j", async (body, message) => {
		const response = await request(body)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message },
		})
		expect(bridge.memongoBridgeRecallConversation).not.toHaveBeenCalled()
	})
	it("forwards a containerTag-only session coordinate", async () => {
		expect(
			(await request({ scope: "session", containerTag: "session:one" })).status,
		).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "session", scopeRef: "session:one" }),
		)
	})
})
