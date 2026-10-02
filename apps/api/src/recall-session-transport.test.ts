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
async function request(body: Record<string, unknown>, query = "") {
	return new Hono()
		.route("/v1", createV1Router())
		.request(`/v1/recall-conversation${query}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: "agent1", scope: "session", ...body }),
		})
}
describe("conversation recall merged session transport", () => {
	it.each([
		"entry",
		"params",
		"memory",
		"handle",
	])("forwards nested %s sessionId", async (key) => {
		expect(
			(await request({ [key]: { sessionId: "session-one" } })).status,
		).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "session", sessionId: "session-one" }),
		)
	})
	it.each([
		"body",
		"entry",
		"query",
	])("maps %s sessionKey to sessionId", async (location) => {
		const response = await request(
			location === "body"
				? { sessionKey: "session-one" }
				: location === "entry"
					? { entry: { sessionKey: "session-one" } }
					: {},
			location === "query" ? "?sessionKey=session-one" : "",
		)
		expect(response.status).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-one" }),
		)
	})
	it("keeps sessionId precedence over sessionKey", async () => {
		expect(
			(await request({ sessionId: "id-one", sessionKey: "key-two" })).status,
		).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "id-one" }),
		)
	})
	it("keeps containerTag as a reference without adding a session filter", async () => {
		expect((await request({ containerTag: "session:one" })).status).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				scopeRef: "session:one",
				sessionId: undefined,
			}),
		)
	})
	it.each([
		{ request: { sessionId: "session-one" } },
		{ entry: { sessionId: "  " } },
	])("rejects unsupported or empty coordinates %j", async (body) => {
		expect((await request(body)).status).toBe(400)
		expect(bridge.memongoBridgeRecallConversation).not.toHaveBeenCalled()
	})
	it("forwards query-only sessionId", async () => {
		expect((await request({}, "?sessionId=session-one")).status).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-one" }),
		)
	})
	it("preserves top-level sessionId precedence", async () => {
		expect(
			(
				await request(
					{ sessionId: "body-session", entry: { sessionId: "nested-session" } },
					"?sessionId=query-session",
				)
			).status,
		).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "body-session" }),
		)
	})
	it("preserves explicit reference-only session recall", async () => {
		expect((await request({ scopeRef: "session:one" })).status).toBe(200)
		expect(bridge.memongoBridgeRecallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				scopeRef: "session:one",
				sessionId: undefined,
			}),
		)
	})
})
