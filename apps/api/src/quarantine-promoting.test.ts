import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeListQuarantined: vi.fn(
		async (_params: Record<string, unknown>) => [],
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
describe("quarantine promoting list filter", () => {
	it.each([
		"pending-review",
		"promoting",
		"promoted",
		"rejected",
	])("forwards %s", async (status) => {
		const result = await new Hono()
			.route("/v1", createV1Router())
			.request(`/v1/admin/quarantine?agentId=agent1&status=${status}&limit=5`)
		expect(result.status).toBe(200)
		expect(bridge.memongoBridgeListQuarantined).toHaveBeenCalledExactlyOnceWith(
			{ agentId: "agent1", status, limit: 5 },
		)
	})
	it("rejects unsupported status before invoking the bridge", async () => {
		const result = await new Hono()
			.route("/v1", createV1Router())
			.request("/v1/admin/quarantine?agentId=agent1&status=archived&limit=5")
		expect(result.status).toBe(400)
		expect(await result.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "status must be pending-review|promoting|promoted|rejected",
			},
		})
		expect(bridge.memongoBridgeListQuarantined).not.toHaveBeenCalled()
	})
})
