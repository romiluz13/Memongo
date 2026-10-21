import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"

const OWN_EVENT = {
	eventId: "evt-own",
	role: "user",
	body: "the deploy window moved to Thursday",
	timestamp: "2026-10-01T09:30:00.000Z",
	scope: "user",
	scopeRef: "user:alice",
	validAt: "2026-10-01T09:30:00.000Z",
}

const bridge = vi.hoisted(() => ({
	memongoBridgeGetEvent: vi.fn(
		async (_params: Record<string, unknown>): Promise<unknown> => null,
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
	return new Hono().route("/v1", createV1Router()).request("/v1/events/get", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
}

describe("POST /v1/events/get", () => {
	it("returns the caller's event as structured JSON", async () => {
		bridge.memongoBridgeGetEvent.mockResolvedValueOnce(OWN_EVENT)

		const response = await request({
			eventId: "evt-own",
			agentId: "agent-1",
			scope: "user",
			scopeRef: "user:alice",
		})

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual(OWN_EVENT)
		expect(bridge.memongoBridgeGetEvent).toHaveBeenCalledWith({
			eventId: "evt-own",
			agentId: "agent-1",
			scope: "user",
			scopeRef: "user:alice",
			sessionKey: undefined,
		})
	})

	it("forwards the request's session coordinate", async () => {
		await request({ eventId: "evt-1", scope: "session", sessionId: "s-1" })

		expect(bridge.memongoBridgeGetEvent).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "session", sessionKey: "s-1" }),
		)
	})

	it("serves one identical 404 for every event outside the caller's identity", async () => {
		const bodies = new Set<string>()
		for (const body of [
			{ eventId: "evt-missing", agentId: "agent-1" },
			{ eventId: "evt-other-agent", agentId: "agent-1" },
			{ eventId: "evt-other-ref", scope: "user", scopeRef: "user:bob" },
			{ eventId: "evt-other-scope", scope: "tenant", scopeRef: "user:alice" },
			{ eventId: "evt-expired", scope: "user", scopeRef: "user:alice" },
		]) {
			const response = await request(body)
			expect(response.status).toBe(404)
			bodies.add(await response.text())
		}

		expect([...bodies]).toEqual([
			JSON.stringify({
				error: { code: "EVENT_NOT_FOUND", message: "event not found" },
			}),
		])
	})

	it.each([
		["missing", {}],
		["not a string", { eventId: 42 }],
		["blank", { eventId: "   " }],
		["oversized", { eventId: "e".repeat(257) }],
		["carrying a control character", { eventId: "evt\u0000own" }],
	])("rejects an eventId that is %s before any read", async (_label, body) => {
		const response = await request(body)

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message:
					"eventId must be a non-empty string of at most 256 characters without control characters",
			},
		})
		expect(bridge.memongoBridgeGetEvent).not.toHaveBeenCalled()
	})

	it("accepts an eventId at the 256-character bound", async () => {
		const response = await request({ eventId: "e".repeat(256) })

		expect(response.status).toBe(404)
		expect(bridge.memongoBridgeGetEvent).toHaveBeenCalledOnce()
	})

	it.each([
		[
			{ scope: "invalid" },
			"scope must be session|user|agent|workspace|tenant|global",
		],
		[{ scope: "user" }, "user scope requires scopeRef"],
	] as const)("rejects scope input %j before any read", async (scope, message) => {
		const response = await request({ eventId: "evt-own", ...scope })

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message },
		})
		expect(bridge.memongoBridgeGetEvent).not.toHaveBeenCalled()
	})

	it("maps an engine failure to 500 EVENT_GET_FAILED", async () => {
		bridge.memongoBridgeGetEvent.mockRejectedValueOnce(new Error("boom"))

		const response = await request({ eventId: "evt-own" })

		expect(response.status).toBe(500)
		expect(
			((await response.json()) as { error: { code: string } }).error.code,
		).toBe("EVENT_GET_FAILED")
	})
})
