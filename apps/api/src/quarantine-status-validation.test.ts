import { API_ERROR_OPENAPI_REF, MEMONGO_API_ROUTES } from "@memongo/lib"
import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openApiSpec } from "./openapi-spec.js"
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
					throw new Error("unexpected bridge call")
				})
			},
		}),
)
beforeEach(() => vi.clearAllMocks())
function request(query: string) {
	return new Hono()
		.route("/v1", createV1Router())
		.request(`/v1/admin/quarantine${query}`)
}
describe("HTTP quarantine-list status validation", () => {
	it.each([
		"",
		"42",
		"null",
		"archived",
		" pending-review",
		"Pending-Review",
		"[]",
	])("rejects invalid status %j before the bridge", async (status) => {
		const response = await request(
			`?status=${encodeURIComponent(status)}&agentId=agent`,
		)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "status must be pending-review|promoting|promoted|rejected",
			},
		})
		expect(bridge.memongoBridgeListQuarantined).not.toHaveBeenCalled()
	})
	it.each([
		"pending-review",
		"promoting",
		"promoted",
		"rejected",
	])("preserves valid status %s", async (status) => {
		const response = await request(`?status=${status}&agentId=agent&limit=5`)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual([])
		expect(bridge.memongoBridgeListQuarantined).toHaveBeenCalledExactlyOnceWith(
			{ status, agentId: "agent", limit: 5 },
		)
	})
	it("preserves omitted status as all stages", async () => {
		expect((await request("?agentId=agent&limit=5")).status).toBe(200)
		expect(bridge.memongoBridgeListQuarantined).toHaveBeenCalledExactlyOnceWith(
			{ agentId: "agent", status: undefined, limit: 5 },
		)
	})
	it("preserves Hono's first-value behavior for repeated status parameters", async () => {
		expect((await request("?status=promoted&status=bogus")).status).toBe(200)
		expect(bridge.memongoBridgeListQuarantined).toHaveBeenCalledExactlyOnceWith(
			{ agentId: undefined, status: "promoted", limit: undefined },
		)
	})
	it("documents 400 with the common error envelope", () => {
		expect(
			MEMONGO_API_ROUTES.find((route) => route.path === "/v1/admin/quarantine")
				?.errorStatuses,
		).toEqual([400, 500])
		const paths = openApiSpec.paths as Record<
			string,
			{
				get?: {
					responses?: Record<
						string,
						{ content?: Record<string, { schema?: unknown }> }
					>
				}
			}
		>
		expect(
			paths["/v1/admin/quarantine"]?.get?.responses?.["400"]?.content?.[
				"application/json"
			]?.schema,
		).toEqual({ $ref: API_ERROR_OPENAPI_REF })
	})
})
