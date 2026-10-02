import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isJsonContentType, resolveScopeInput } from "./scope-identity.js"
import { createApp } from "./app.js"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeSync: vi.fn(async () => ({ ok: true })),
	memongoBridgeWriteConversationEvent: vi.fn(async () => ({
		eventId: "event1",
		chunkCreated: false,
	})),
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
	vi.stubEnv("MEMONGO_API_KEY", "admin-secret")
	vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "")
	vi.stubEnv("MEMONGO_API_RATE_LIMIT", "0")
})
afterEach(() => vi.unstubAllEnvs())
const validBody = { agentId: "body-agent", role: "user", body: "event text" }
function headers(contentType?: string, token = "admin-secret") {
	const result: Record<string, string> = { Authorization: `Bearer ${token}` }
	if (contentType !== undefined) result["Content-Type"] = contentType
	return result
}
describe("identity/body content-type parity", () => {
	it.each([
		undefined,
		"text/plain",
		"application/not-json",
		"application/json-patch+json",
		"application/merge-patch+json",
		"application/jsonx",
		'text/plain; x="application/json"',
		"application/x-www-form-urlencoded",
	])("rejects nonempty operation bodies with unsupported media (%s)", async (contentType) => {
		const response = await createApp().request(
			"/v1/write-event?agentId=query-agent",
			{
				method: "POST",
				headers: headers(contentType),
				body: JSON.stringify(validBody),
			},
		)
		expect(response.status).toBe(415)
		expect(await response.json()).toEqual({
			error: {
				code: "UNSUPPORTED_MEDIA_TYPE",
				message:
					"request body must be sent with Content-Type: application/json",
			},
		})
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})
	it.each([
		"application/json",
		"application/json; charset=utf-8",
		"Application/JSON",
		" application/json ; charset=UTF-8",
	])("preserves explicit JSON body-over-query identity (%s)", async (contentType) => {
		const response = await createApp().request(
			"/v1/write-event?agentId=query-agent",
			{
				method: "POST",
				headers: headers(contentType),
				body: JSON.stringify(validBody),
			},
		)
		expect(response.status).toBe(200)
		expect(
			bridge.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ agentId: "body-agent", body: "event text" }),
		)
	})
	it("preserves malformed JSON's explicit error", async () => {
		const response = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: headers("application/json"),
			body: "{",
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: {
				code: "INVALID_JSON",
				message: "request body is not valid JSON",
			},
		})
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})
	it("preserves unauthenticated rejection", async () => {
		const response = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: {},
			body: JSON.stringify(validBody),
		})
		expect(response.status).toBe(401)
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})
	it("does not allow non-JSON bodies to evade a scoped agent grant", async () => {
		vi.stubEnv(
			"MEMONGO_API_SCOPED_KEYS",
			JSON.stringify([{ token: "scoped", agentIds: ["query-agent"] }]),
		)
		const response = await createApp().request(
			"/v1/write-event?agentId=query-agent",
			{
				method: "POST",
				headers: headers("text/plain", "scoped"),
				body: JSON.stringify(validBody),
			},
		)
		expect(response.status).toBe(415)
		expect(await response.json()).toEqual({
			error: {
				code: "UNSUPPORTED_MEDIA_TYPE",
				message:
					"request body must be sent with Content-Type: application/json",
			},
		})
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})
	it("preserves empty-body POSTs without a content type", async () => {
		const response = await createApp().request("/v1/sync", {
			method: "POST",
			headers: headers(),
		})
		expect(response.status).toBe(200)
		expect(bridge.memongoBridgeSync).toHaveBeenCalledTimes(1)
	})
	it("preserves nested JSON identity and forbids mismatched scoped JSON identity", async () => {
		const response = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: headers("application/json"),
			body: JSON.stringify({
				role: "user",
				body: "event text",
				params: { agentId: "nested-agent" },
			}),
		})
		expect(response.status).toBe(200)
		expect(
			bridge.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ agentId: "nested-agent" }),
		)
		bridge.memongoBridgeWriteConversationEvent.mockClear()
		vi.stubEnv(
			"MEMONGO_API_SCOPED_KEYS",
			JSON.stringify([{ token: "scoped", agentIds: ["query-agent"] }]),
		)
		const rejected = await createApp().request(
			"/v1/write-event?agentId=query-agent",
			{
				method: "POST",
				headers: headers("application/json", "scoped"),
				body: JSON.stringify(validBody),
			},
		)
		expect(rejected.status).toBe(403)
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})

	it("also rejects ambiguous bodies through the router alone", async () => {
		const response = await new Hono()
			.route("/v1", createV1Router())
			.request("/v1/write-event", {
				method: "POST",
				body: JSON.stringify(validBody),
			})
		expect(response.status).toBe(415)
		expect(await response.json()).toEqual({
			error: {
				code: "UNSUPPORTED_MEDIA_TYPE",
				message:
					"request body must be sent with Content-Type: application/json",
			},
		})
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})
	it("checks media before syntax and body size before media", async () => {
		const malformed = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: headers("text/plain"),
			body: "{",
		})
		expect(malformed.status).toBe(415)
		vi.stubEnv("MEMONGO_API_MAX_BODY_BYTES", "10")
		const oversized = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: headers("text/plain"),
			body: JSON.stringify(validBody),
		})
		expect(oversized.status).toBe(413)
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})
	it("keeps scoped grant rejection ahead of media rejection", async () => {
		vi.stubEnv(
			"MEMONGO_API_SCOPED_KEYS",
			JSON.stringify([{ token: "scoped", agentIds: ["allowed"] }]),
		)
		const response = await createApp().request(
			"/v1/write-event?agentId=disallowed",
			{
				method: "POST",
				headers: headers("text/plain", "scoped"),
				body: JSON.stringify(validBody),
			},
		)
		expect(response.status).toBe(403)
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})
	it("preserves whitespace-only bodies without JSON media", async () => {
		const response = await createApp().request("/v1/sync", {
			method: "POST",
			headers: headers("text/plain"),
			body: "  ",
		})
		expect(response.status).toBe(200)
		expect(bridge.memongoBridgeSync).toHaveBeenCalledTimes(1)
	})
	it("does not merge unsupported subtype bodies into identity", async () => {
		let input: Record<string, unknown> | undefined
		const app = new Hono().post("/identity", async (c) => {
			input = await resolveScopeInput(c)
			return c.json(input)
		})
		await app.request("/identity?agentId=query-agent", {
			method: "POST",
			headers: { "Content-Type": "application/json-patch+json" },
			body: JSON.stringify({ agentId: "body-agent" }),
		})
		expect(input).toEqual({ agentId: "query-agent" })
	})
	it.each([
		[undefined, false],
		["", false],
		["application/json", true],
		["Application/JSON; charset=UTF-8", true],
		["application/jsonx", false],
		["application/merge-patch+json", false],
		['text/plain; x="application/json"', false],
	] as const)("recognizes only the JSON media essence (%s)", (value, expected) => {
		expect(isJsonContentType(value)).toBe(expected)
	})
})
