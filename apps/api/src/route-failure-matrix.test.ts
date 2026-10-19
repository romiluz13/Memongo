import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 T11 (failure matrix): a route that runs an engine operation answers a
// failure of that operation with a non-2xx envelope under its own code, a
// dependency outage with 503, and a healthy answer with 200. No route turns
// a failed operation into an empty success.

const bridge = vi.hoisted(() => ({
	memongoBridgeStatus: vi.fn(),
	memongoBridgeGetDetailedStatus: vi.fn(),
	memongoBridgeStats: vi.fn(),
	memongoBridgeSync: vi.fn(),
	memongoBridgeAdd: vi.fn(),
	memongoBridgeWriteConversationEvent: vi.fn(),
	memongoBridgeWriteConversationEventsBatch: vi.fn(),
	memongoBridgeWriteStructuredMemory: vi.fn(),
	memongoBridgeWriteProcedure: vi.fn(),
	memongoBridgeTraceChain: vi.fn(),
	memongoBridgeConsolidate: vi.fn(),
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

type RouteCase = {
	row: string
	method: "GET" | "POST"
	path: string
	body?: Record<string, unknown>
	call: keyof typeof bridge
	code: string
}

const ROUTES: RouteCase[] = [
	{
		row: "H-35",
		method: "GET",
		path: "/v1/status?agentId=owner",
		call: "memongoBridgeStatus",
		code: "STATUS_FAILED",
	},
	{
		row: "H-36",
		method: "GET",
		path: "/v1/status/detailed?agentId=owner",
		call: "memongoBridgeGetDetailedStatus",
		code: "DETAILED_STATUS_FAILED",
	},
	{
		row: "H-37",
		method: "GET",
		path: "/v1/stats?agentId=owner",
		call: "memongoBridgeStats",
		code: "STATS_FAILED",
	},
	{
		row: "H-38",
		method: "POST",
		path: "/v1/sync",
		body: {},
		call: "memongoBridgeSync",
		code: "SYNC_FAILED",
	},
	{
		row: "H-41",
		method: "POST",
		path: "/v1/add",
		body: { content: "c" },
		call: "memongoBridgeAdd",
		code: "ADD_FAILED",
	},
	{
		row: "H-42",
		method: "POST",
		path: "/v1/write-event",
		body: { role: "user", body: "b" },
		call: "memongoBridgeWriteConversationEvent",
		code: "WRITE_EVENT_FAILED",
	},
	{
		row: "H-43",
		method: "POST",
		path: "/v1/write-events",
		body: { events: [{ role: "user", body: "b" }] },
		call: "memongoBridgeWriteConversationEventsBatch",
		code: "WRITE_EVENTS_FAILED",
	},
	{
		row: "H-45",
		method: "POST",
		path: "/v1/write-structured",
		body: { entry: { type: "fact", key: "k", value: "v" } },
		call: "memongoBridgeWriteStructuredMemory",
		code: "WRITE_STRUCTURED_FAILED",
	},
	{
		row: "H-46",
		method: "POST",
		path: "/v1/write-procedure",
		body: { entry: { procedureId: "p", name: "n", steps: ["s"] } },
		call: "memongoBridgeWriteProcedure",
		code: "WRITE_PROCEDURE_FAILED",
	},
	{
		row: "H-29",
		method: "POST",
		path: "/v1/chain-trace",
		body: { factId: "f", collection: "structured_mem" },
		call: "memongoBridgeTraceChain",
		code: "CHAIN_TRACE_FAILED",
	},
	{
		row: "H-31",
		method: "POST",
		path: "/v1/consolidate",
		body: {},
		call: "memongoBridgeConsolidate",
		code: "CONSOLIDATE_FAILED",
	},
]

function request({ method, path, body }: RouteCase) {
	return createApp().request(path, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		...(method === "POST"
			? { body: JSON.stringify({ agentId: "owner", ...body }) }
			: {}),
	})
}

describe.each(ROUTES)("$row $method $path", (route) => {
	it("a failed engine operation is a 500 under the route's own code, with no driver text", async () => {
		bridge[route.call].mockRejectedValue(
			new Error("private driver detail at 10.0.0.5:27017"),
		)

		const res = await request(route)

		expect(res.status).toBe(500)
		const text = await res.text()
		expect(JSON.parse(text).error.code).toBe(route.code)
		expect(text).not.toContain("10.0.0.5")
		expect(text).not.toContain("private driver detail")
	})

	it("a dependency outage is a 503", async () => {
		bridge[route.call].mockRejectedValue(
			Object.assign(new Error("down"), { name: "MongoNetworkError" }),
		)

		const res = await request(route)

		expect(res.status).toBe(503)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe("SERVICE_UNAVAILABLE")
	})

	it("a healthy answer is a 200", async () => {
		bridge[route.call].mockResolvedValue(
			route.call === "memongoBridgeWriteConversationEventsBatch"
				? [{ ok: true, eventId: "e", chunkCreated: true }]
				: {},
		)

		const res = await request(route)

		expect(res.status).toBe(200)
	})
})
