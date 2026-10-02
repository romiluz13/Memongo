import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { MongoOperationTimeoutError, MongoServerError } from "mongodb"
import { API_ERROR_OPENAPI_REF, MEMONGO_API_ROUTES } from "@memongo/lib"
const engineSource = new URL(
	"../../../packages/memory-engine/src/mongodb-structured-memory.ts",
	import.meta.url,
).href
const { MemoryLifecycleConflictError, StructuredMemoryRevisionConflictError } =
	(await import(engineSource)) as {
		MemoryLifecycleConflictError: new (params: {
			reason: "stale-revision"
			expectedRevision: number
			actualRevision: number
		}) => Error
		StructuredMemoryRevisionConflictError: new (
			message: string,
		) => MongoServerError
	}
const bridge = vi.hoisted(() => ({
	memongoBridgeWriteStructuredMemory: vi.fn(),
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
import { createApp } from "./app.js"
import { openApiSpec } from "./openapi-spec.js"
const handle = {
	family: "structured",
	id: "memory",
	agentId: "owner",
	scope: "agent",
	scopeRef: "agent:owner",
	revision: 1,
	state: "active",
	structured: { type: "fact", key: "key" },
}
const cases = [
	{
		path: "/v1/write-structured",
		body: { entry: { type: "fact", key: "key", value: "synthetic" } },
		mock: bridge.memongoBridgeWriteStructuredMemory,
	},
	{
		path: "/v1/lifecycle/update",
		body: { handle, patch: { value: "synthetic" } },
		mock: bridge.memongoBridgeUpdateLifecycleItem,
	},
	{
		path: "/v1/lifecycle/delete",
		body: { handle },
		mock: bridge.memongoBridgeDeleteLifecycleItem,
	},
	{
		path: "/v1/memory/feedback",
		body: { handle, signal: "confirm" },
		mock: bridge.memongoBridgeApplyMemoryFeedback,
	},
] as const
const message =
	"structured memory revision conflict; fetch current state before retrying"
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv("MEMONGO_API_KEY", "fixture-admin")
	vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "")
	vi.stubEnv("MEMONGO_API_RATE_LIMIT", "0")
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})
function request(path: string, body: unknown, token = "fixture-admin") {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			agentId: "owner",
			...(body as Record<string, unknown>),
		}),
	})
}
it.each(
	cases,
)("$path classifies a real structured revision conflict without raw detail or a delay", async ({
	path,
	body,
	mock,
}) => {
	const error = new StructuredMemoryRevisionConflictError(
		"private key canary 98765",
	)
	expect(error.hasErrorLabel("TransientTransactionError")).toBe(true)
	mock.mockRejectedValue(error)
	const res = await request(path, body)
	expect(res.status).toBe(409)
	expect(await res.json()).toEqual({
		error: { code: "STRUCTURED_MEMORY_REVISION_CONFLICT", message },
	})
	expect(res.headers.get("Retry-After")).toBeNull()
	expect(mock).toHaveBeenCalledTimes(1)
	expect(console.error).not.toHaveBeenCalled()
})
it.each(
	cases,
)("$path preserves generic transient, unknown commit, timeout and non-Error handling", async ({
	path,
	body,
	mock,
}) => {
	const transient = new MongoServerError({
		message: "native WriteConflict",
		code: 112,
	})
	transient.addErrorLabel("TransientTransactionError")
	const commit = new MongoServerError({ message: "unknown commit" })
	commit.addErrorLabel("UnknownTransactionCommitResult")
	const timeout = new MongoOperationTimeoutError("timeout", {
		cause: new StructuredMemoryRevisionConflictError("cause only"),
	})
	timeout.addErrorLabel("TransientTransactionError")
	for (const reason of [
		transient,
		commit,
		timeout,
		new Error("ordinary"),
		{ name: "StructuredMemoryRevisionConflictError" },
		Object.assign(new Error("near miss"), {
			name: "StructuredMemoryRevisionConflictError ",
		}),
	]) {
		mock.mockRejectedValueOnce(reason)
		expect((await request(path, body)).status).toBe(500)
	}
	expect(mock).toHaveBeenCalledTimes(6)
})
it.each(
	cases,
)("$path preserves authentication, validation and success", async ({
	path,
	body,
	mock,
}) => {
	expect((await request(path, body, "wrong")).status).toBe(401)
	expect((await request(path, {})).status).toBe(400)
	expect(mock).not.toHaveBeenCalled()
	mock.mockResolvedValueOnce({ id: "memory", upserted: true })
	expect((await request(path, body)).status).toBe(200)
	expect(mock).toHaveBeenCalledTimes(1)
})
it.each(
	cases,
)("$path documents the structured conflict in the generated specification", ({
	path,
}) => {
	const operation = (
		openApiSpec.paths as unknown as Record<
			string,
			{
				post: {
					responses: Record<
						string,
						{
							description?: string
							content?: { "application/json"?: { schema?: { $ref?: string } } }
							headers?: unknown
						}
					>
				}
			}
		>
	)[path].post
	expect(operation.responses["409"]?.description).toContain(
		"STRUCTURED_MEMORY_REVISION_CONFLICT",
	)
	expect(
		operation.responses["409"]?.content?.["application/json"]?.schema?.$ref,
	).toBe(API_ERROR_OPENAPI_REF)
	expect(operation.responses["409"]?.headers).toBeUndefined()
})
it("keeps the permanent lifecycle conflict code and quarantine disposition", async () => {
	for (const { path, body, mock } of cases.slice(1)) {
		mock.mockRejectedValueOnce(
			new MemoryLifecycleConflictError({
				reason: "stale-revision",
				expectedRevision: 1,
				actualRevision: 2,
			}),
		)
		const res = await request(path, body)
		expect(res.status).toBe(409)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"MEMORY_LIFECYCLE_CONFLICT",
		)
	}
	for (const item of [cases[1], cases[3]]) {
		item.mock.mockRejectedValueOnce(
			Object.assign(new Error("held"), {
				name: "MemoryQuarantinedWriteError",
				quarantineId: "q",
				matchedPatterns: ["synthetic"],
			}),
		)
		const res = await request(item.path, item.body)
		expect(res.status).toBe(202)
		expect(await res.json()).toEqual({
			quarantined: true,
			quarantineId: "q",
			matchedPatterns: ["synthetic"],
		})
	}
})
it("declares structured-write 409 alongside the existing operation statuses", () => {
	expect(
		MEMONGO_API_ROUTES.find((r) => r.path === "/v1/write-structured")
			?.errorStatuses,
	).toEqual([400, 409, 500])
})
