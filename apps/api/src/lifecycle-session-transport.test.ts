import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeProfile: vi.fn(async (_params: Record<string, unknown>) => ({})),
	memongoBridgeHydrateActiveSlate: vi.fn(
		async (_params: Record<string, unknown>) => ({}),
	),
	memongoBridgeBuildDiscoveryProjection: vi.fn(
		async (_params: Record<string, unknown>) => ({}),
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
const routes = [
	{ path: "profile", mock: bridge.memongoBridgeProfile },
	{
		path: "hydrate-active-slate",
		mock: bridge.memongoBridgeHydrateActiveSlate,
	},
	{
		path: "discovery-projection",
		mock: bridge.memongoBridgeBuildDiscoveryProjection,
	},
] as const
async function request(path: string, body: Record<string, unknown>) {
	return new Hono().route("/v1", createV1Router()).request(`/v1/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			agentId: "agent1",
			scope: "session",
			kind: "what-changed",
			...body,
		}),
	})
}
describe.each(routes)("$path session transport", ({ path, mock }) => {
	it.each([
		"body",
		"entry",
	])("maps %s sessionKey to sessionId", async (location) => {
		expect(
			(
				await request(
					path,
					location === "body"
						? { sessionKey: "session-one" }
						: { entry: { sessionKey: "session-one" } },
				)
			).status,
		).toBe(200)
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-one" }),
		)
	})
	it("keeps containerTag as an explicit reference", async () => {
		expect((await request(path, { containerTag: "session:one" })).status).toBe(
			200,
		)
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({
				scopeRef: "session:one",
				sessionId: undefined,
			}),
		)
	})
	it("forwards a session coordinate alongside an explicit reference", async () => {
		expect(
			(
				await request(path, {
					scopeRef: "session:explicit",
					sessionId: "session-one",
					sessionKey: "ignored-key",
				})
			).status,
		).toBe(200)
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({
				scopeRef: "session:explicit",
				sessionId: "session-one",
			}),
		)
	})
	it("preserves explicit agent scope with a session hint", async () => {
		expect(
			(await request(path, { scope: "agent", sessionId: "session-one" }))
				.status,
		).toBe(200)
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "agent", sessionId: "session-one" }),
		)
	})
	it("rejects unsupported nesting", async () => {
		expect(
			(await request(path, { request: { sessionId: "session-one" } })).status,
		).toBe(400)
		expect(mock).not.toHaveBeenCalled()
	})
	it.each([
		"body",
		"entry",
		"params",
		"memory",
		"handle",
		"query",
	])("forwards %s sessionId", async (location) => {
		const coordinate = { sessionId: "session-one" }
		const body = {
			agentId: "agent1",
			scope: "session",
			kind: "what-changed",
			...(location === "body"
				? coordinate
				: location === "query"
					? {}
					: { [location]: coordinate }),
		}
		const response = await new Hono()
			.route("/v1", createV1Router())
			.request(
				`/v1/${path}${location === "query" ? "?sessionId=session-one" : ""}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			)
		expect(response.status).toBe(200)
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "session", sessionId: "session-one" }),
		)
	})
})
