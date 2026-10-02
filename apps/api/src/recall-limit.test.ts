import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"
const bridge = vi.hoisted(() => ({
	memongoBridgeRecallConversation: vi.fn(
		async (_params: Record<string, unknown>) => ({
			results: [],
			metadata: {},
		}),
	),
	memongoBridgeSearchWithDegradation: vi.fn(
		async (_params: Record<string, unknown>) => ({ results: [] }),
	),
	memongoBridgeSearchKBWithDegradation: vi.fn(
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
afterEach(() => vi.restoreAllMocks())
async function post(path: string, body: Record<string, unknown>) {
	return new Hono().route("/v1", createV1Router()).request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
}
describe("recall advertised limit", () => {
	it.each([
		[150, 150],
		[200, 200],
		[201, 200],
		[199.9, 199],
		[0, 1],
		[-1, 1],
		[0.5, 1],
	] as const)("forwards %s as %s", async (limit, expected) => {
		expect(
			(await post("/v1/recall-conversation", { agentId: "agent1", limit }))
				.status,
		).toBe(200)
		expect(
			bridge.memongoBridgeRecallConversation,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ limit: expected }),
		)
	})
	it.each([
		{},
		{ limit: "200" },
		{ limit: null },
	])("preserves default for %j", async (body) => {
		expect((await post("/v1/recall-conversation", body)).status).toBe(200)
		expect(bridge.memongoBridgeRecallConversation.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ limit: undefined }),
		)
	})
	it("keeps ordinary search capped at100", async () => {
		expect(
			(
				await post("/v1/search", {
					agentId: "agent1",
					query: "question",
					limit: 200,
				})
			).status,
		).toBe(200)
		expect(
			bridge.memongoBridgeSearchWithDegradation,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ maxResults: 100 }),
		)
	})
	it.each([
		[{ maxResults: 150 }, 150],
		[{ limit: 120, maxResults: 180 }, 120],
		[{ limit: "5", maxResults: 150 }, 150],
	] as const)("preserves alias and precedence for %j", async (body, expected) => {
		expect((await post("/v1/recall-conversation", body)).status).toBe(200)
		expect(
			bridge.memongoBridgeRecallConversation,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ limit: expected }),
		)
	})
	it("keeps the default after JSON numeric overflow", async () => {
		const response = await new Hono()
			.route("/v1", createV1Router())
			.request("/v1/recall-conversation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: '{"agentId":"agent1","limit":1e400}',
			})
		expect(response.status).toBe(200)
		expect(
			bridge.memongoBridgeRecallConversation,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ limit: undefined }),
		)
	})
	it("keeps the ordinary search alias capped at 100", async () => {
		expect(
			(
				await post("/v1/search", {
					agentId: "agent1",
					query: "question",
					maxResults: 200,
				})
			).status,
		).toBe(200)
		expect(
			bridge.memongoBridgeSearchWithDegradation,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ maxResults: 100 }),
		)
	})
	it("keeps knowledge-base search capped at 100", async () => {
		expect(
			(
				await post("/v1/search-kb", {
					agentId: "agent1",
					query: "question",
					limit: 200,
				})
			).status,
		).toBe(200)
		expect(
			bridge.memongoBridgeSearchKBWithDegradation,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ maxResults: 100 }),
		)
	})
})
