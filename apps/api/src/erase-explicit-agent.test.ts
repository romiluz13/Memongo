import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"
import { createApp } from "./app.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeDeleteAllForAgent: vi.fn(async () => ({ status: "complete" })),
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
	bridge.memongoBridgeDeleteAllForAgent.mockResolvedValue({
		status: "complete",
	})
	vi.stubEnv("MEMONGO_AGENT_ID", "ambient-default-must-not-erase")
})
afterEach(() => vi.unstubAllEnvs())

function request(body: Record<string, unknown>, query = "") {
	return new Hono()
		.route("/v1", createV1Router())
		.request(`/v1/admin/erase${query}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm: "erase", ...body }),
		})
}

describe("explicit erasure target", () => {
	it.each([
		{},
		{ agentId: "" },
		{ agentId: " \t" },
		{ agentId: null },
		{ agentId: 3 },
	])("rejects absent or blank target %j before bridge dispatch", async (body) => {
		const res = await request(body)
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "agentId must be explicitly provided for erasure",
			},
		})
		expect(bridge.memongoBridgeDeleteAllForAgent).not.toHaveBeenCalled()
	})
	it("preserves normalized body targets", async () => {
		expect((await request({ agentId: " agent-42 " })).status).toBe(200)
		expect(
			bridge.memongoBridgeDeleteAllForAgent,
		).toHaveBeenCalledExactlyOnceWith({ agentId: "agent-42" })
	})
	it("preserves an explicit query target", async () => {
		expect((await request({}, "?agentId=agent-query")).status).toBe(200)
		expect(
			bridge.memongoBridgeDeleteAllForAgent,
		).toHaveBeenCalledExactlyOnceWith({ agentId: "agent-query" })
	})
	it("preserves nested identity and takeover", async () => {
		expect(
			(
				await request({
					entry: { agentId: "agent-nested" },
					recovery: "takeover",
				})
			).status,
		).toBe(200)
		expect(
			bridge.memongoBridgeDeleteAllForAgent,
		).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent-nested",
			recovery: "takeover",
		})
	})
	it("preserves body-over-query identity", async () => {
		expect(
			(await request({ agentId: "body-agent" }, "?agentId=query-agent")).status,
		).toBe(200)
		expect(
			bridge.memongoBridgeDeleteAllForAgent,
		).toHaveBeenCalledExactlyOnceWith({ agentId: "body-agent" })
	})
	it("does not use a shadowed query target when the body is blank", async () => {
		expect(
			(await request({ agentId: " " }, "?agentId=query-agent")).status,
		).toBe(400)
		expect(bridge.memongoBridgeDeleteAllForAgent).not.toHaveBeenCalled()
	})
	it("retains the explicit target in a typed conflict envelope", async () => {
		const conflict = new Error("private upstream message")
		conflict.name = "ErasureGateConflictError"
		bridge.memongoBridgeDeleteAllForAgent.mockRejectedValueOnce(conflict)
		const response = await request({ agentId: " agent-conflict " })
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({
			error: {
				code: "ERASURE_GATE_CONFLICT",
				message: "erase conflicts with the erasure gate state",
			},
			agentId: "agent-conflict",
		})
	})
	it("retains global administrator authorization", async () => {
		vi.stubEnv("MEMONGO_API_KEY", "admin-secret")
		vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "")
		const response = await createApp().request("/v1/admin/erase", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm: "erase", agentId: "agent-42" }),
		})
		expect(response.status).toBe(401)
		expect(bridge.memongoBridgeDeleteAllForAgent).not.toHaveBeenCalled()
	})
	it("retains rejection of scoped credentials on erasure", async () => {
		vi.stubEnv("MEMONGO_API_KEY", "")
		vi.stubEnv(
			"MEMONGO_API_SCOPED_KEYS",
			JSON.stringify([{ token: "scoped", agentIds: ["agent-42"] }]),
		)
		const response = await createApp().request("/v1/admin/erase", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer scoped",
			},
			body: JSON.stringify({ confirm: "erase", agentId: "agent-42" }),
		})
		expect(response.status).toBe(403)
		expect(bridge.memongoBridgeDeleteAllForAgent).not.toHaveBeenCalled()
	})
})
