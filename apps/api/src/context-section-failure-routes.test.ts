import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 T8 (#117): /v1/hydrate-active-slate, /v1/discovery-projection and
// /v1/context-bundle. A total failure is a typed non-2xx through the search
// failure mapping; a partial answer is a 200 that carries the typed
// `failures` rows the engine produced. Tested at the HTTP seam.

const bridge = vi.hoisted(() => ({
	memongoBridgeHydrateActiveSlate: vi.fn(),
	memongoBridgeBuildDiscoveryProjection: vi.fn(),
	memongoBridgeBuildContextBundle: vi.fn(),
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

const SECRET_QUERY = "violet launch SECRETTAIL"

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

function post(path: string, body: Record<string, unknown> = {}) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		body: JSON.stringify({ agentId: "owner", ...body }),
	})
}

const failure = (section: string, reason: string, stage = "lane") => ({
	section,
	stage,
	outcome: "failed",
	reason,
})

const ROUTES = [
	{
		path: "/v1/hydrate-active-slate",
		body: {},
		mock: bridge.memongoBridgeHydrateActiveSlate,
		okBody(failures: unknown[]) {
			return {
				agentId: "owner",
				scope: "agent",
				scopeRef: "agent:owner",
				items: [],
				metadata: {
					maxItems: 6,
					truncated: false,
					partial: failures.length > 0,
					failures,
					countsByKind: {},
					sourceCounts: {},
				},
				hydratedAt: "2026-10-19T00:00:00.000Z",
			}
		},
		fallbackCode: "ACTIVE_SLATE_FAILED",
	},
	{
		path: "/v1/discovery-projection",
		body: { kind: "topic-brief", query: SECRET_QUERY },
		mock: bridge.memongoBridgeBuildDiscoveryProjection,
		okBody(failures: unknown[]) {
			return {
				kind: "topic-brief",
				query: SECRET_QUERY,
				title: "Topic brief",
				summary: "",
				scope: "agent",
				scopeRef: "agent:owner",
				sections: [],
				metadata: {
					partial: failures.length > 0,
					failures,
					evidenceCount: 0,
					sourceCounts: {},
				},
				builtAt: "2026-10-19T00:00:00.000Z",
			}
		},
		fallbackCode: "DISCOVERY_PROJECTION_FAILED",
	},
	{
		path: "/v1/context-bundle",
		body: { query: SECRET_QUERY },
		mock: bridge.memongoBridgeBuildContextBundle,
		okBody(failures: unknown[]) {
			return {
				agentId: "owner",
				query: SECRET_QUERY,
				scope: "agent",
				scopeRef: "agent:owner",
				rendered: "",
				sections: [],
				metadata: {
					tokenBudget: 1000,
					estimatedTokensUsed: 0,
					partial: failures.length > 0,
					failures,
					truncated: false,
					pathsExecuted: [],
					sectionsIncluded: [],
				},
				builtAt: "2026-10-19T00:00:00.000Z",
			}
		},
		fallbackCode: "CONTEXT_BUNDLE_FAILED",
	},
] as const

describe.each(ROUTES)("$path typed section failures", (route) => {
	it("passes the typed failure rows through a 200 partial answer", async () => {
		const failures = [
			failure("episodes", "index-missing", "atlas-search"),
			{
				section: "query-evidence",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		]
		route.mock.mockResolvedValue(route.okBody(failures))

		const res = await post(route.path, route.body)

		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			metadata: { partial: boolean; failures: unknown[] }
		}
		expect(json.metadata.partial).toBe(true)
		expect(json.metadata.failures).toEqual(failures)
	})

	it("keeps a healthy answer free of failure rows", async () => {
		route.mock.mockResolvedValue(route.okBody([]))

		const res = await post(route.path, route.body)

		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			metadata: { partial: boolean; failures: unknown[] }
		}
		expect(json.metadata.partial).toBe(false)
		expect(json.metadata.failures).toEqual([])
	})

	it.each([
		{
			name: "an unavailable lane",
			err: {
				name: "SearchLaneError",
				lane: "episodic",
				stage: "atlas-search",
				reason: "index-missing",
			},
			status: 503,
			code: "SEARCH_LANES_UNAVAILABLE",
			row: {
				lane: "episodic",
				stage: "atlas-search",
				outcome: "failed",
				reason: "index-missing",
			},
		},
		{
			name: "a query defect",
			err: {
				name: "SearchLaneError",
				lane: "structured",
				stage: "atlas-search",
				reason: "query-error",
			},
			status: 500,
			code: "SEARCH_LANES_FAILED",
			row: {
				lane: "structured",
				stage: "atlas-search",
				outcome: "failed",
				reason: "query-error",
			},
		},
		{
			name: "a budget denial",
			err: {
				name: "SearchBudgetDeniedError",
				lane: "hybrid",
				stage: "request",
				reason: "budget-reservation",
			},
			status: 503,
			code: "SEARCH_BUDGET_EXHAUSTED",
			row: {
				lane: "hybrid",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		},
	])("maps $name to a typed $status $code, never an empty 200", async ({
		err,
		status,
		code,
		row,
	}) => {
		const typed = Object.assign(new Error(`bad regex ${SECRET_QUERY}`), err)
		route.mock.mockRejectedValue(typed)

		const res = await post(route.path, route.body)

		expect(res.status).toBe(status)
		const text = await res.text()
		expect(text).not.toContain("SECRETTAIL")
		const json = JSON.parse(text) as {
			error: { code: string }
			outcomes: { status: string; lanes: unknown[] }
		}
		expect(json.error.code).toBe(code)
		expect(json.outcomes).toEqual({ status: "failed", lanes: [row] })
	})

	it("keeps the route's internal error code for an untyped failure", async () => {
		route.mock.mockRejectedValue(new Error(`boom ${SECRET_QUERY}`))

		const res = await post(route.path, route.body)

		expect(res.status).toBe(500)
		const text = await res.text()
		expect(text).not.toContain("SECRETTAIL")
		expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(
			route.fallbackCode,
		)
	})
})

// M2 T13 (#120) gates the Search sections of these two routes on the request's
// index snapshot, so a STALE or missing index reaches the HTTP seam as the
// engine's typed `index-stale` / `index-unavailable` failure. The active slate
// reads no Search index and is not gated, so it has no case here.
describe.each(
	ROUTES.filter((route) => route.path !== "/v1/hydrate-active-slate"),
)("$path index-health failures", (route) => {
	it.each([
		{
			name: "an index-stale section failure",
			reason: "index-stale",
			lane: "episodic",
		},
		{
			name: "an index-unavailable section failure",
			reason: "index-unavailable",
			lane: "structured",
		},
	])("maps $name to a typed 503 SEARCH_LANES_UNAVAILABLE with its failure row, never an empty 200", async ({
		reason,
		lane,
	}) => {
		const typed = Object.assign(new Error(`stale ${SECRET_QUERY}`), {
			name: "SearchLaneError",
			lane,
			stage: "index-health",
			reason,
		})
		route.mock.mockRejectedValue(typed)

		const res = await post(route.path, route.body)

		expect(res.status).toBe(503)
		const text = await res.text()
		expect(text).not.toContain("SECRETTAIL")
		const json = JSON.parse(text) as {
			error: { code: string }
			outcomes: { status: string; lanes: unknown[] }
		}
		expect(json.error.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(json.outcomes).toEqual({
			status: "failed",
			lanes: [{ lane, stage: "index-health", outcome: "failed", reason }],
		})
	})
})
