import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 review R8: a route that is not a search route but runs engine Search
// underneath (/v1/consolidate, /v1/probes/vector) answers a typed Search
// failure through the shared outcome/status mapper. An unexpected error stays
// the route's generic internal error and never leaks its message. /v1/sync
// answers a failed KB refresh (R7) as its own typed code.

const bridge = vi.hoisted(() => ({
	memongoBridgeConsolidate: vi.fn(),
	memongoBridgeProbeVector: vi.fn(),
	memongoBridgeSync: vi.fn(),
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

type Body = {
	error?: { code: string; message: string }
	outcomes?: {
		status: string
		lanes: Array<{
			lane: string
			stage: string
			outcome: string
			reason?: string
		}>
	}
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

const AUTH = { Authorization: "Bearer fixture-admin" }

async function call(route: "consolidate" | "probes-vector" | "sync") {
	const app = createApp()
	const response =
		route === "probes-vector"
			? await app.request("/v1/probes/vector?agentId=owner", {
					headers: AUTH,
				})
			: await app.request(`/v1/${route}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...AUTH },
					body: JSON.stringify({ agentId: "owner" }),
				})
	return {
		status: response.status,
		retryAfter: response.headers.get("Retry-After"),
		text: await response.clone().text(),
		body: (await response.json()) as Body,
	}
}

function typed(
	name: string,
	reason: string,
	extra: Record<string, unknown> = {},
) {
	return Object.assign(new Error("private provider detail sk-secret-1"), {
		name,
		lane: "vector",
		stage: "rank-fusion",
		reason,
		...extra,
	})
}

const ROUTES = [
	{
		label: "POST /v1/consolidate",
		route: "consolidate" as const,
		mock: () => bridge.memongoBridgeConsolidate,
		generic: "CONSOLIDATE_FAILED",
	},
	{
		label: "GET /v1/probes/vector",
		route: "probes-vector" as const,
		mock: () => bridge.memongoBridgeProbeVector,
		generic: "PROBE_VECTOR_FAILED",
	},
]

describe.each(
	ROUTES.map((entry) => [entry.label, entry] as const),
)("%s typed Search failures", (_label, { route, mock, generic }) => {
	it.each([
		"index-unavailable",
		"index-stale",
		"index-not-ready",
	])("maps a %s lane failure to 503 SEARCH_LANES_UNAVAILABLE with its outcome row", async (reason) => {
		mock().mockRejectedValue(typed("SearchLaneError", reason))
		const { status, body, text } = await call(route)
		expect(status).toBe(503)
		expect(body.error?.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(body.outcomes).toEqual({
			status: "failed",
			lanes: [
				{
					lane: "vector",
					stage: "rank-fusion",
					outcome: "failed",
					reason,
				},
			],
		})
		expect(text).not.toContain("private provider detail")
		expect(text).not.toContain("sk-secret-1")
	})

	it("maps a query-error lane failure to 500 SEARCH_LANES_FAILED, never the generic code", async () => {
		mock().mockRejectedValue(typed("SearchLaneError", "query-error"))
		const { status, body } = await call(route)
		expect(status).toBe(500)
		expect(body.error?.code).toBe("SEARCH_LANES_FAILED")
		expect(body.outcomes?.lanes[0]?.reason).toBe("query-error")
	})

	it("maps a budget denial to 503 SEARCH_BUDGET_EXHAUSTED with Retry-After", async () => {
		mock().mockRejectedValue(
			typed("SearchBudgetDeniedError", "budget-embeds", {
				stage: "request",
				retryAfterMs: 2500,
			}),
		)
		const { status, body, retryAfter } = await call(route)
		expect(status).toBe(503)
		expect(body.error?.code).toBe("SEARCH_BUDGET_EXHAUSTED")
		expect(retryAfter).toBe("3")
		expect(body.outcomes?.lanes).toEqual([
			{
				lane: "vector",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-embeds",
			},
		])
	})

	it("a per-request budget denial without a retry hint sends no Retry-After", async () => {
		mock().mockRejectedValue(
			typed("SearchBudgetDeniedError", "budget-aggregations", {
				stage: "request",
			}),
		)
		const { status, body, retryAfter } = await call(route)
		expect(status).toBe(503)
		expect(body.error?.code).toBe("SEARCH_BUDGET_EXHAUSTED")
		expect(retryAfter).toBeNull()
	})

	it("an unexpected error stays the generic route code and leaks nothing", async () => {
		mock().mockRejectedValue(new Error("boom: private provider detail"))
		const { status, body, text } = await call(route)
		expect(status).toBe(500)
		expect(body.error?.code).toBe(generic)
		expect(body.outcomes).toBeUndefined()
		expect(text).not.toContain("private provider detail")
	})

	it("an error that only looks typed (unrecognized name or reason) stays generic", async () => {
		mock().mockRejectedValueOnce(typed("SomeOtherError", "index-stale"))
		const unknownName = await call(route)
		expect(unknownName.status).toBe(500)
		expect(unknownName.body.error?.code).toBe(generic)
		expect(unknownName.body.outcomes).toBeUndefined()

		mock().mockRejectedValueOnce(typed("SearchLaneError", "made-up-reason"))
		const unknownReason = await call(route)
		expect(unknownReason.status).toBe(500)
		expect(unknownReason.body.error?.code).toBe(generic)
		expect(unknownReason.body.outcomes).toBeUndefined()
	})
})

describe("POST /v1/sync KB refresh failure (R7)", () => {
	function refreshFailure(reason: string, over: Record<string, unknown> = {}) {
		return Object.assign(
			new Error("KB auto-refresh failed: private provider detail sk-secret-1"),
			{
				name: "KBRefreshError",
				code: "KB_REFRESH_FAILED",
				reason,
				documentsProcessed: 2,
				chunksCreated: 7,
				skipped: 1,
				errors: ["doc.md: private provider detail sk-secret-1"],
				...over,
			},
		)
	}

	it("answers a failed refresh as 500 KB_REFRESH_FAILED naming the reason and the commit counts", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(refreshFailure("import-errors"))
		const { status, body, text } = await call("sync")
		expect(status).toBe(500)
		expect(body.error?.code).toBe("KB_REFRESH_FAILED")
		expect(body.error?.message).toContain("import-errors")
		expect(body.error?.message).toContain("2 documents")
		expect(body.error?.message).toContain("7 chunks")
		expect(text).not.toContain("private provider detail")
		expect(text).not.toContain("sk-secret-1")
		expect(body.outcomes).toBeUndefined()
	})

	it("a rejected import without counts names the reason only", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(
			refreshFailure("import-rejected", {
				documentsProcessed: undefined,
				chunksCreated: undefined,
				skipped: undefined,
				errors: [],
			}),
		)
		const { status, body } = await call("sync")
		expect(status).toBe(500)
		expect(body.error?.code).toBe("KB_REFRESH_FAILED")
		expect(body.error?.message).toContain("import-rejected")
		expect(body.error?.message).not.toContain("undefined")
	})

	it("an unrecognized refresh reason is not echoed", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(
			refreshFailure("sk-secret-2 free text"),
		)
		const { status, body, text } = await call("sync")
		expect(status).toBe(500)
		expect(body.error?.code).toBe("KB_REFRESH_FAILED")
		expect(text).not.toContain("sk-secret-2")
	})

	it("an unexpected sync error stays SYNC_FAILED", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(
			new Error("private provider detail"),
		)
		const { status, body, text } = await call("sync")
		expect(status).toBe(500)
		expect(body.error?.code).toBe("SYNC_FAILED")
		expect(text).not.toContain("private provider detail")
	})
})

describe("OpenAPI documents the typed failures of the non-search routes (R8)", () => {
	type Operation = {
		responses: Record<
			string,
			{ description?: string; headers?: Record<string, unknown> }
		>
	}

	async function operation(
		path: string,
		method: "get" | "post",
	): Promise<Operation> {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as {
			paths: Record<string, Record<string, Operation>>
		}
		return json.paths[path][method]
	}

	it.each([
		["/v1/consolidate", "post"],
		["/v1/probes/vector", "get"],
	] as const)("%s documents the shared 500 and 503 codes and Retry-After", async (path, method) => {
		const op = await operation(path, method)
		expect(op.responses["500"]?.description).toContain("SEARCH_LANES_FAILED")
		expect(op.responses["503"]?.description).toContain(
			"SEARCH_LANES_UNAVAILABLE",
		)
		expect(op.responses["503"]?.description).toContain("index-stale")
		expect(op.responses["503"]?.description).toContain(
			"SEARCH_BUDGET_EXHAUSTED",
		)
		expect(op.responses["503"]?.headers).toHaveProperty("Retry-After")
	})

	it("/v1/sync documents KB_REFRESH_FAILED", async () => {
		const op = await operation("/v1/sync", "post")
		expect(op.responses["500"]?.description).toContain("KB_REFRESH_FAILED")
	})
})
