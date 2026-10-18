import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => ({
	memongoBridgeAdd: vi.fn(),
	memongoBridgeWriteConversationEvent: vi.fn(),
	memongoBridgeWriteConversationEventsBatch: vi.fn(),
	memongoBridgeWriteStructuredMemory: vi.fn(),
	memongoBridgeWriteProcedure: vi.fn(),
	memongoBridgeUpdateLifecycleItem: vi.fn(),
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

const SEARCHABLE = {
	committed: true,
	status: "searchable",
	targets: [{ index: "events_text", status: "confirmed", attempts: 1 }],
}

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

function post(path: string, body: Record<string, unknown>) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		body: JSON.stringify({ agentId: "owner", ...body }),
	})
}

const ROUTES = [
	{
		path: "/v1/add",
		body: { content: "synthetic" },
		mock: bridge.memongoBridgeAdd,
		receipt: { eventId: "evt-1", chunkCreated: true },
	},
	{
		path: "/v1/write-event",
		body: { role: "user", body: "synthetic" },
		mock: bridge.memongoBridgeWriteConversationEvent,
		receipt: { eventId: "evt-1", chunkCreated: true },
	},
	{
		path: "/v1/write-structured",
		body: { entry: { type: "fact", key: "k", value: "v" } },
		mock: bridge.memongoBridgeWriteStructuredMemory,
		receipt: { upserted: true, id: "k" },
	},
	{
		path: "/v1/write-procedure",
		body: { entry: { procedureId: "p", name: "P", steps: ["a"] } },
		mock: bridge.memongoBridgeWriteProcedure,
		receipt: { upserted: true, id: "p" },
	},
] as const

describe("search barrier on write routes", () => {
	it.each(
		ROUTES,
	)("$path forwards the barrier request and returns the result", async ({
		path,
		body,
		mock,
		receipt,
	}) => {
		mock.mockResolvedValue({ ...receipt, searchBarrier: SEARCHABLE })
		const res = await post(path, {
			...body,
			searchBarrier: { timeoutMs: 2_000 },
		})
		expect(res.status).toBe(200)
		const json = (await res.json()) as Record<string, unknown>
		expect(json.searchBarrier).toEqual(SEARCHABLE)
		const forwarded = mock.mock.calls[0]?.[0] as {
			searchBarrier?: { timeoutMs?: number; signal?: unknown }
		}
		expect(forwarded.searchBarrier?.timeoutMs).toBe(2_000)
		expect(forwarded.searchBarrier?.signal).toBeInstanceOf(AbortSignal)
	})

	it.each(
		ROUTES,
	)("$path returns a committed not-yet-searchable outcome with its normal status", async ({
		path,
		body,
		mock,
		receipt,
	}) => {
		const pending = {
			committed: true,
			status: "not-yet-searchable",
			reason: "timeout",
			targets: [],
		}
		mock.mockResolvedValue({ ...receipt, searchBarrier: pending })
		const res = await post(path, { ...body, searchBarrier: {} })
		expect(res.status).toBe(200)
		expect(
			((await res.json()) as Record<string, unknown>).searchBarrier,
		).toEqual(pending)
	})

	it.each(ROUTES)("$path leaves an ordinary write unchanged", async ({
		path,
		body,
		mock,
		receipt,
	}) => {
		mock.mockResolvedValue(receipt)
		const res = await post(path, body)
		expect(res.status).toBe(200)
		expect(await res.json()).not.toHaveProperty("searchBarrier")
		expect(mock.mock.calls[0]?.[0]).not.toHaveProperty("searchBarrier")
	})

	it.each(
		ROUTES,
	)("$path maps barrier-unsupported to 400 with its bounded reason", async ({
		path,
		body,
		mock,
	}) => {
		mock.mockRejectedValue(
			Object.assign(new Error("search barrier unsupported: target-missing"), {
				name: "SearchBarrierUnsupportedError",
				code: "BARRIER_UNSUPPORTED",
				reason: "target-missing",
			}),
		)
		const res = await post(path, { ...body, searchBarrier: {} })
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({
			error: {
				code: "BARRIER_UNSUPPORTED",
				message: "search barrier unsupported: target-missing",
				reason: "target-missing",
			},
		})
	})

	it.each([
		["an array", []],
		["a string", "yes"],
		["null", null],
		["a non-numeric timeout", { timeoutMs: "fast" }],
		["an unknown field", { timeoutMs: 1_000, mode: "ann" }],
	])("rejects %s as a validation error before the write", async (_label, value) => {
		const res = await post("/v1/write-event", {
			role: "user",
			body: "synthetic",
			searchBarrier: value,
		})
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		})
		expect(bridge.memongoBridgeWriteConversationEvent).not.toHaveBeenCalled()
	})

	it.each([
		{
			path: "/v1/write-events",
			body: { events: [{ role: "user", body: "synthetic" }] },
			mock: bridge.memongoBridgeWriteConversationEventsBatch,
		},
		{
			path: "/v1/lifecycle/update",
			body: { handle: {}, patch: {} },
			mock: bridge.memongoBridgeUpdateLifecycleItem,
		},
	])("$path rejects a barrier request as write-family-unsupported before the write", async ({
		path,
		body,
		mock,
	}) => {
		const res = await post(path, { ...body, searchBarrier: {} })
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({
			error: {
				code: "BARRIER_UNSUPPORTED",
				message: "search barrier unsupported: write-family-unsupported",
				reason: "write-family-unsupported",
			},
		})
		expect(mock).not.toHaveBeenCalled()
	})

	it("marks an uncertain commit on the error body without claiming a commit", async () => {
		bridge.memongoBridgeWriteConversationEvent.mockRejectedValue(
			Object.assign(new Error("connection reset"), {
				name: "MongoNetworkError",
				commitState: "unknown",
			}),
		)
		const res = await post("/v1/write-event", {
			role: "user",
			body: "synthetic",
			searchBarrier: {},
		})
		expect(res.status).toBe(503)
		const json = (await res.json()) as {
			error: Record<string, unknown>
		} & Record<string, unknown>
		expect(json.error.commitState).toBe("unknown")
		expect(json).not.toHaveProperty("searchBarrier")
		expect(json).not.toHaveProperty("ok")
	})
})
