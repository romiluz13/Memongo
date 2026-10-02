import { afterEach, beforeEach, expect, it, vi } from "vitest"
const bridge = vi.hoisted(() => ({
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
					throw new Error("unexpected bridge call")
				})
			},
		}),
)
import { createApp } from "./app.js"
beforeEach(() => {
	vi.stubEnv("MEMONGO_API_KEY", "fixture-admin")
	vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "")
	vi.stubEnv("MEMONGO_API_RATE_LIMIT", "0")
	bridge.memongoBridgeSearchKBWithDegradation.mockReset()
	bridge.memongoBridgeSearchKBWithDegradation.mockResolvedValue({ results: [] })
})
afterEach(() => vi.unstubAllEnvs())
function request(
	body: Record<string, unknown>,
	token = "fixture-admin",
	query = "",
) {
	return createApp().request(`/v1/search-kb${query}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ query: "architecture", agentId: "owner", ...body }),
	})
}
it.each([
	[
		{ scope: "global" },
		{ scope: "global", sessionKey: undefined, scopeRef: undefined },
	],
	[
		{ scope: "global", scopeRef: "explicit" },
		{ scope: "global", sessionKey: undefined, scopeRef: "explicit" },
	],
	[
		{ scope: "session", sessionId: "id" },
		{ scope: "session", sessionKey: "id", scopeRef: undefined },
	],
	[
		{ scope: "session", sessionKey: "key" },
		{ scope: "session", sessionKey: "key", scopeRef: undefined },
	],
	[
		{ scope: "session", sessionId: "id", sessionKey: "key" },
		{ scope: "session", sessionKey: "id", scopeRef: undefined },
	],
] as const)("forwards admin KB identity %j", async (body, expected) => {
	expect((await request(body)).status).toBe(200)
	expect(
		bridge.memongoBridgeSearchKBWithDegradation,
	).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected))
})
it.each([
	{ scope: "user" },
	{ scope: "tenant" },
	{ scope: "session" },
	{ scope: "bogus" },
])("rejects incomplete admin identity %j before bridge", async (body) => {
	expect((await request(body)).status).toBe(400)
	expect(bridge.memongoBridgeSearchKBWithDegradation).not.toHaveBeenCalled()
})
it("preserves scoped-key authorization and the explicit reference", async () => {
	vi.stubEnv(
		"MEMONGO_API_SCOPED_KEYS",
		JSON.stringify([
			{ token: "fixture-scoped", scopes: ["global"], scopeRefs: ["allowed"] },
		]),
	)
	expect(
		(await request({ scope: "global", scopeRef: "allowed" }, "fixture-scoped"))
			.status,
	).toBe(200)
	expect(
		bridge.memongoBridgeSearchKBWithDegradation.mock.calls[0][0].scopeRef,
	).toBe("allowed")
	bridge.memongoBridgeSearchKBWithDegradation.mockClear()
	expect(
		(
			await request(
				{ scope: "global", scopeRef: "forbidden" },
				"fixture-scoped",
			)
		).status,
	).toBe(403)
	expect((await request({ scope: "global" }, "fixture-scoped")).status).toBe(
		403,
	)
	expect(bridge.memongoBridgeSearchKBWithDegradation).not.toHaveBeenCalled()
})
it("preserves rejection of scoped policies without a concrete reference constraint", async () => {
	vi.stubEnv(
		"MEMONGO_API_SCOPED_KEYS",
		JSON.stringify([{ token: "fixture-scoped", scopes: ["global"] }]),
	)
	expect((await request({ scope: "global" }, "fixture-scoped")).status).toBe(
		403,
	)
	expect(bridge.memongoBridgeSearchKBWithDegradation).not.toHaveBeenCalled()
})
it.each([
	{},
	{ scope: 42 },
])("preserves lenient omitted or wrongly typed scope %j", async (body) => {
	expect((await request(body)).status).toBe(200)
	expect(
		bridge.memongoBridgeSearchKBWithDegradation.mock.calls[0][0].scope,
	).toBeUndefined()
})
