import { API_ERROR_OPENAPI_REF, MEMONGO_API_ROUTES } from "@memongo/lib"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openApiSpec } from "./openapi-spec.js"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgePromoteQuarantined: vi.fn(),
	memongoBridgeRejectQuarantined: vi.fn(),
}))
vi.mock(
	"@memongo/memory-bridge",
	() =>
		new Proxy(bridge, {
			get(target, key) {
				if (key === "then") return undefined
				if (key in target) return target[key as keyof typeof target]
				return vi.fn(() => {
					throw new Error("unexpected bridge operation")
				})
			},
		}),
)
beforeEach(() => {
	vi.resetAllMocks()
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
const operations = [
	{
		path: "/v1/admin/quarantine/promote",
		mock: bridge.memongoBridgePromoteQuarantined,
	},
	{
		path: "/v1/admin/quarantine/reject",
		mock: bridge.memongoBridgeRejectQuarantined,
	},
]
async function request(
	path: string,
	body: Record<string, unknown> = {
		quarantineId: "quarantine",
		agentId: "agent",
	},
) {
	const app = new Hono().route("/v1", createV1Router())
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
}
describe("quarantine review HTTP errors", () => {
	it.each([
		{
			path: "/v1/admin/quarantine/reject",
			mock: bridge.memongoBridgeRejectQuarantined,
			status: "rejected",
			fields: { memoryMayRemain: true, auditError: "fixture audit failed" },
		},
		{
			path: "/v1/admin/quarantine/promote",
			mock: bridge.memongoBridgePromoteQuarantined,
			status: "promoted",
			fields: { memoryId: "memory", finalizeError: "fixture finalize failed" },
		},
	])("$path preserves recovery fields on the wire", async ({
		path,
		mock,
		status,
		fields,
	}) => {
		const receipt = {
			quarantineId: "quarantine",
			agentId: "agent",
			status,
			reviewedAt: new Date("2026-10-02T00:00:00.000Z"),
			...fields,
		}
		mock.mockResolvedValueOnce(receipt)
		const response = await request(path)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			...receipt,
			reviewedAt: receipt.reviewedAt.toISOString(),
		})
		expect(mock).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent",
			quarantineId: "quarantine",
			reviewerId: undefined,
			reviewNotes: undefined,
		})
	})
	for (const { path, mock } of operations) {
		it.each([
			{
				reason: "not-found",
				status: 404,
				code: "NOT_FOUND",
				message: "quarantine entry not found",
			},
			{
				reason: "conflict",
				status: 409,
				code: "QUARANTINE_REVIEW_CONFLICT",
				message:
					"quarantine entry was reviewed or is being reviewed; refresh its state before deciding again",
			},
		])(`${path} maps $reason without exposing upstream text`, async ({
			reason,
			status,
			code,
			message,
		}) => {
			mock.mockRejectedValue(
				Object.assign(new Error("upstream sensitive fixture quarantine-id"), {
					name: "QuarantineReviewError",
					reason,
				}),
			)
			const response = await request(path)
			expect(response.status).toBe(status)
			expect(await response.json()).toEqual({ error: { code, message } })
			expect(mock).toHaveBeenCalledTimes(1)
		})
		it(`${path} preserves generic and dependency classification`, async () => {
			for (const error of [
				new Error("not found"),
				"QuarantineReviewError",
				{ name: "QuarantineReviewError", reason: "conflict" },
				Object.assign(new Error("unknown"), {
					name: "QuarantineReviewError",
					reason: "other",
				}),
			]) {
				mock.mockRejectedValueOnce(error)
				expect((await request(path)).status).toBe(500)
			}
			mock.mockRejectedValueOnce(
				Object.assign(new Error("network"), { name: "MongoNetworkError" }),
			)
			expect((await request(path)).status).toBe(503)
		})
		it(`${path} validates before dispatch and keeps successful receipts`, async () => {
			expect((await request(path, { quarantineId: " " })).status).toBe(400)
			expect(mock).not.toHaveBeenCalled()
			const receipt = {
				quarantineId: "quarantine",
				status: path.endsWith("promote") ? "promoted" : "rejected",
				reviewedAt: "2026-10-02T00:00:00.000Z",
			}
			mock.mockResolvedValueOnce(receipt)
			const response = await request(path)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual(receipt)
		})
	}
	it("declares both new statuses with the shared error envelope", () => {
		const paths = openApiSpec.paths as Record<
			string,
			{
				post?: {
					responses: Record<
						string,
						{
							content?: { "application/json"?: { schema?: { $ref?: string } } }
						}
					>
				}
			}
		>
		for (const { path } of operations) {
			const route = MEMONGO_API_ROUTES.find((route) => route.path === path)
			expect(route?.errorStatuses).toEqual([400, 404, 409, 500])
			for (const status of ["404", "409"])
				expect(
					paths[path].post?.responses[status].content?.["application/json"]
						?.schema?.$ref,
				).toBe(API_ERROR_OPENAPI_REF)
		}
	})
})
