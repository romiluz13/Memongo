import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { API_ERROR_OPENAPI_REF, MEMONGO_API_ROUTES } from "@memongo/lib"
const bridge = vi.hoisted(() => ({
	memongoBridgeAdd: vi.fn(),
	memongoBridgeWriteConversationEvent: vi.fn(),
	memongoBridgeWriteConversationEventsBatch: vi.fn(),
	memongoBridgeImportConversations: vi.fn(),
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
import { openApiSpec } from "./openapi-spec.js"
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
const cases = [
	{
		path: "/v1/add",
		body: { content: "synthetic" },
		mock: bridge.memongoBridgeAdd,
	},
	{
		path: "/v1/write-event",
		body: { role: "user", body: "synthetic" },
		mock: bridge.memongoBridgeWriteConversationEvent,
	},
	{
		path: "/v1/write-events",
		body: { events: [{ role: "user", body: "synthetic" }] },
		mock: bridge.memongoBridgeWriteConversationEventsBatch,
	},
] as const
const queueError = () =>
	Object.assign(new Error("private queue canary depth 98765"), {
		name: "WriteQueueFullError",
		code: "WRITE_QUEUE_FULL",
		queueDepth: 98765,
		maxDepth: 98765,
	})
function request(
	path: string,
	body: Record<string, unknown>,
	token = "fixture-admin",
) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ agentId: "owner", ...body }),
	})
}
it.each(
	cases,
)("$path classifies queue pressure without leaking detail or inventing a delay", async ({
	path,
	body,
	mock,
}) => {
	mock.mockRejectedValue(queueError())
	const res = await request(path, body)
	expect(res.status).toBe(429)
	expect(res.headers.get("Retry-After")).toBeNull()
	expect(await res.json()).toEqual({
		error: {
			code: "WRITE_QUEUE_FULL",
			message: "write queue is full; retry later",
		},
	})
	expect(mock).toHaveBeenCalledTimes(1)
	expect(console.error).not.toHaveBeenCalled()
})
it.each(
	cases,
)("$path preserves ordinary errors, network outage, erasure and impostors", async ({
	path,
	body,
	mock,
}) => {
	for (const err of [
		new Error("private"),
		{ name: "WriteQueueFullError", code: "WRITE_QUEUE_FULL" },
		Object.assign(new Error(), { name: "WriteQueueFullError" }),
		Object.assign(new Error(), { code: "WRITE_QUEUE_FULL" }),
		Object.assign(new Error(), {
			name: "WriteQueueFullError",
			code: "WRITE_QUEUE_FULL ",
		}),
	]) {
		mock.mockRejectedValueOnce(err)
		expect((await request(path, body)).status).toBe(500)
	}
	mock.mockRejectedValueOnce(
		Object.assign(new Error("network"), { name: "MongoNetworkError" }),
	)
	expect((await request(path, body)).status).toBe(503)
	mock.mockRejectedValueOnce(
		Object.assign(new Error("erasure"), { name: "ErasureGateConflictError" }),
	)
	expect((await request(path, body)).status).toBe(409)
})
it.each(
	cases.slice(0, 2),
)("$path retains idempotency conflict and successful receipt", async ({
	path,
	body,
	mock,
}) => {
	mock.mockRejectedValueOnce(
		Object.assign(new Error("payload mismatch"), {
			name: "IdempotencyConflictError",
		}),
	)
	expect((await request(path, body)).status).toBe(422)
	mock.mockResolvedValueOnce({ eventId: "event", chunkCreated: true })
	const res = await request(path, body)
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({
		ok: true,
		eventId: "event",
		chunkCreated: true,
	})
})
it("keeps batch per-item invalid receipts on success, but rejects the whole envelope on queue denial", async () => {
	const body = {
		events: [
			{ role: "invalid", body: "bad" },
			{ role: "user", body: "good" },
		],
	}
	bridge.memongoBridgeWriteConversationEventsBatch.mockResolvedValueOnce([
		{ ok: true, eventId: "event", chunkCreated: true },
	])
	const success = await request("/v1/write-events", body)
	expect(success.status).toBe(200)
	expect(await success.json()).toEqual({
		ok: true,
		receipts: [
			expect.objectContaining({ ok: false, code: "VALIDATION_ERROR" }),
			{ ok: true, eventId: "event", chunkCreated: true },
		],
	})
	expect(
		bridge.memongoBridgeWriteConversationEventsBatch.mock.calls[0][0].events,
	).toHaveLength(1)
	bridge.memongoBridgeWriteConversationEventsBatch.mockRejectedValueOnce(
		queueError(),
	)
	const denied = await request("/v1/write-events", body)
	expect(denied.status).toBe(429)
	expect(await denied.json()).toEqual({
		error: {
			code: "WRITE_QUEUE_FULL",
			message: "write queue is full; retry later",
		},
	})
})
it("retains the import error because earlier batches may already be committed", async () => {
	bridge.memongoBridgeImportConversations.mockRejectedValue(queueError())
	const res = await request("/v1/import/conversations", {
		datasetPath: "fixture.json",
	})
	expect(res.status).toBe(500)
	expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
		"CONVERSATION_IMPORT_FAILED",
	)
	expect(res.headers.get("Retry-After")).toBeNull()
})
it("preserves pre-bridge authorization and input validation", async () => {
	expect(
		(await request("/v1/add", { content: "ok" }, "wrong-key")).status,
	).toBe(401)
	expect((await request("/v1/add", { content: "" })).status).toBe(400)
	expect(bridge.memongoBridgeAdd).not.toHaveBeenCalled()
})
it.each(
	cases,
)("$path declares the operation-level 429 with its error envelope", ({
	path,
}) => {
	expect(
		MEMONGO_API_ROUTES.find((route) => route.path === path)?.errorStatuses,
	).toContain(429)
	const operation = (
		openApiSpec.paths as unknown as Record<
			string,
			{
				post: {
					responses: Record<
						string,
						{
							description: string
							headers?: unknown
							content: Record<string, { schema: { $ref: string } }>
						}
					>
				}
			}
		>
	)[path].post
	expect(operation.responses["429"].description).toContain("write queue")
	expect(
		operation.responses["429"].content["application/json"].schema.$ref,
	).toBe(API_ERROR_OPENAPI_REF)
	expect(operation.responses["429"].headers).toBeUndefined()
})
