import { API_ERROR_OPENAPI_REF, MEMONGO_API_ROUTES } from "@memongo/lib"
import { openApiSpec } from "./openapi-spec.js"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { lifecyclePaths } from "./openapi-paths-lifecycle.js"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeUpdateLifecycleItem: vi.fn(),
	memongoBridgeDeleteLifecycleItem: vi.fn(),
	memongoBridgeApplyMemoryFeedback: vi.fn(),
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

const cases = [
	{
		path: "lifecycle/update",
		family: "structured",
		fields: { patch: { value: "updated" } },
		mock: bridge.memongoBridgeUpdateLifecycleItem,
	},
	{
		path: "lifecycle/update",
		family: "procedure",
		fields: { patch: { name: "updated" } },
		mock: bridge.memongoBridgeUpdateLifecycleItem,
	},
	{
		path: "lifecycle/delete",
		family: "structured",
		fields: {},
		mock: bridge.memongoBridgeDeleteLifecycleItem,
	},
	{
		path: "lifecycle/delete",
		family: "procedure",
		fields: {},
		mock: bridge.memongoBridgeDeleteLifecycleItem,
	},
	{
		path: "memory/feedback",
		family: "structured",
		fields: { signal: "confirm" },
		mock: bridge.memongoBridgeApplyMemoryFeedback,
	},
] as const
const conflictMessage =
	"memory handle is stale or invalidated; fetch current state before retrying"
function request(
	path: string,
	family: string,
	fields: Record<string, unknown>,
	revision = 2,
	decoy = false,
) {
	return new Hono().route("/v1", createV1Router()).request(`/v1/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...fields,
			...(decoy ? { agentId: "other" } : {}),
			handle: {
				family,
				id: "memory",
				agentId: "agent",
				scope: "agent",
				scopeRef: "agent",
				revision,
				state: "active",
				...(family === "structured"
					? { structured: { type: "fact", key: "key" } }
					: { procedure: { procedureId: "procedure" } }),
			},
		}),
	})
}
describe.each(cases)("$path $family conflicts", ({
	path,
	family,
	fields,
	mock,
}) => {
	it.each([
		"stale-revision",
		"invalidated",
	])("maps %s to a constant 409 without raw error disclosure", async (reason) => {
		const err = Object.assign(new Error("synthetic private source detail"), {
			name: "MemoryLifecycleConflictError",
			reason,
		})
		mock.mockRejectedValue(err)
		const res = await request(path, family, fields)
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({
			error: { code: "MEMORY_LIFECYCLE_CONFLICT", message: conflictMessage },
		})
		expect(mock).toHaveBeenCalledTimes(1)
		expect(console.error).not.toHaveBeenCalled()
	})
	it("keeps unexpected failures at 500 and Mongo network failures at 503", async () => {
		for (const err of [
			new Error("synthetic"),
			"MemoryLifecycleConflictError",
			{ name: "MemoryLifecycleConflictError" },
		]) {
			mock.mockRejectedValueOnce(err)
			expect((await request(path, family, fields)).status).toBe(500)
		}
		mock.mockRejectedValueOnce(
			Object.assign(new Error("synthetic network"), {
				name: "MongoNetworkError",
			}),
		)
		expect((await request(path, family, fields)).status).toBe(503)
		expect(mock).toHaveBeenCalledTimes(4)
	})
	it("rejects a mismatched authorized owner before dispatch", async () => {
		const res = await request(path, family, fields, 2, true)
		expect(res.status).toBe(403)
		expect(mock).not.toHaveBeenCalled()
	})
	it("preserves success, not found and malformed handle admission", async () => {
		const item = { id: "memory", data: { value: "synthetic" } }
		mock.mockResolvedValueOnce(item)
		const res = await request(path, family, fields)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(item)
		mock.mockResolvedValueOnce(null)
		expect((await request(path, family, fields)).status).toBe(404)
		expect((await request(path, family, fields, 0)).status).toBe(400)
		expect(mock).toHaveBeenCalledTimes(2)
	})
})
it.each([cases[0], cases[4]])("$path preserves quarantine 202", async ({
	path,
	family,
	fields,
	mock,
}) => {
	mock.mockRejectedValue(
		Object.assign(new Error("synthetic"), {
			name: "MemoryQuarantinedWriteError",
			quarantineId: "quarantine",
			matchedPatterns: ["synthetic"],
		}),
	)
	const res = await request(path, family, fields)
	expect(res.status).toBe(202)
	expect(await res.json()).toEqual({
		quarantined: true,
		quarantineId: "quarantine",
		matchedPatterns: ["synthetic"],
	})
	expect(console.error).not.toHaveBeenCalled()
})

it("OpenAPI documents exactly the three lifecycle conflict operations", () => {
	const paths = Object.entries(lifecyclePaths)
		.filter(([, operation]) => "409" in operation.post.responses)
		.map(([path]) => path)
		.sort()
	expect(paths).toEqual([
		"/v1/lifecycle/delete",
		"/v1/lifecycle/update",
		"/v1/memory/feedback",
	])
})

it("assembles the shared lifecycle conflict schema and exact manifest statuses", () => {
	for (const path of [
		"/v1/lifecycle/update",
		"/v1/lifecycle/delete",
		"/v1/memory/feedback",
	]) {
		expect(
			MEMONGO_API_ROUTES.find((route) => route.path === path)?.errorStatuses,
		).toEqual([400, 404, 409, 500])
		const paths = openApiSpec.paths as Record<
			string,
			{
				post?: {
					responses: Record<
						string,
						{
							description?: string
							content?: { "application/json"?: { schema?: { $ref?: string } } }
						}
					>
				}
			}
		>
		expect(
			paths[path].post?.responses["409"].content?.["application/json"]?.schema
				?.$ref,
		).toBe(API_ERROR_OPENAPI_REF)
		expect(paths[path].post?.responses["409"].description).toBe(
			"MEMORY_LIFECYCLE_CONFLICT: stale or invalidated handle; STRUCTURED_MEMORY_REVISION_CONFLICT: concurrent structured revision conflict. Fetch current state before retrying",
		)
	}
})
