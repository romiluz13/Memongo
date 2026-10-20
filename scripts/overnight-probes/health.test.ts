import { describe, expect, it } from "vitest"
import { evaluateRouteHealth, tallyHealth, type RouteId } from "./health.ts"
import type { Observation } from "./types.ts"

const ok = (route: RouteId, body: unknown): Observation => ({
	kind: "response",
	route,
	body,
})
const httpError = (
	route: RouteId,
	status: number,
	code?: string,
): Observation => ({
	kind: "http-error",
	route,
	status,
	...(code ? { code } : {}),
})
const complete = { status: "complete", lanes: [] }

describe("evaluateRouteHealth: shared failure shapes", () => {
	it("marks a transport error as not completed", () => {
		const h = evaluateRouteHealth("search", {
			kind: "transport-error",
			route: "search",
			message: "timeout",
		})
		expect(h).toMatchObject({
			completed: false,
			healthy: false,
			evaluable: false,
		})
		expect(h.issues).toContain("transport-error")
	})

	it("marks a non-2xx as unhealthy and names the status and code", () => {
		const h = evaluateRouteHealth(
			"search",
			httpError("search", 503, "SEARCH_LANES_UNAVAILABLE"),
		)
		expect(h).toMatchObject({
			completed: false,
			healthy: false,
			evaluable: false,
		})
		expect(h.issues).toEqual(
			expect.arrayContaining(["http-503", "code:SEARCH_LANES_UNAVAILABLE"]),
		)
	})

	it("never reads ERASURE_IN_PROGRESS as absence", () => {
		for (const route of ["search", "readFile", "state"] as const) {
			const h = evaluateRouteHealth(
				route,
				httpError(route, 409, "ERASURE_IN_PROGRESS"),
			)
			expect(h.evaluable).toBe(false)
			expect(h.issues).toContain("erasure-in-progress")
			expect(h.denied).toBeUndefined()
		}
	})

	it("flags a server-sent degradation marker even on a 200", () => {
		const h = evaluateRouteHealth(
			"search",
			ok("search", {
				results: [],
				degradation: { kind: "throttled", retryAfterMs: 5 },
			}),
		)
		expect(h).toMatchObject({
			completed: true,
			healthy: false,
			evaluable: false,
		})
		expect(h.issues).toContain("degraded:throttled")
	})

	it("flags a degradation marker from a silent client", () => {
		const h = evaluateRouteHealth(
			"buildContextBundle",
			ok("buildContextBundle", {
				rendered: "",
				sections: [],
				metadata: { partial: true, truncated: false, sectionsIncluded: [] },
				degradation: { kind: "unavailable", status: 503 },
			}),
		)
		expect(h.healthy).toBe(false)
		expect(h.issues).toContain("degraded:unavailable")
	})

	it("treats a body that is not an object as malformed", () => {
		const h = evaluateRouteHealth("search", ok("search", "oops"))
		expect(h).toMatchObject({
			completed: true,
			healthy: false,
			evaluable: false,
		})
		expect(h.issues).toContain("malformed-body")
	})
})

describe("evaluateRouteHealth: search and searchKB", () => {
	it.each([
		"search",
		"searchKB",
	] as const)("%s: complete outcomes are healthy and evaluable", (route) => {
		const h = evaluateRouteHealth(
			route,
			ok(route, { results: [], outcomes: complete }),
		)
		expect(h).toMatchObject({
			completed: true,
			healthy: true,
			evaluable: true,
			issues: [],
		})
	})

	it("treats a missing outcomes block as healthy but records that outcomes were not reported", () => {
		const h = evaluateRouteHealth("search", ok("search", { results: [] }))
		expect(h).toMatchObject({ healthy: true, evaluable: true })
		expect(h.issues).toContain("outcomes-not-reported")
	})

	it("flags a partial 200 and each failed or budget-denied lane", () => {
		const h = evaluateRouteHealth(
			"search",
			ok("search", {
				results: [{ snippet: "x" }],
				outcomes: {
					status: "partial",
					lanes: [
						{
							lane: "vector",
							stage: "search",
							outcome: "failed",
							reason: "index-not-ready",
						},
						{
							lane: "text",
							stage: "search",
							outcome: "budget-denied",
							reason: "budget-embeds",
						},
						{ lane: "kb", stage: "search", outcome: "ok-empty" },
					],
				},
			}),
		)
		expect(h).toMatchObject({
			completed: true,
			healthy: false,
			evaluable: false,
		})
		expect(h.issues).toEqual(
			expect.arrayContaining([
				"outcomes:partial",
				"lane-failed:vector/search:index-not-ready",
				"lane-budget-denied:text/search:budget-embeds",
			]),
		)
	})

	it("ignores a failed explain-stage row because the API treats explain rows as diagnostics", () => {
		const h = evaluateRouteHealth(
			"search",
			ok("search", {
				results: [],
				outcomes: {
					status: "complete",
					lanes: [
						{
							lane: "x",
							stage: "explain",
							outcome: "failed",
							reason: "query-error",
						},
					],
				},
			}),
		)
		expect(h.healthy).toBe(true)
	})

	it("requires a results array", () => {
		const h = evaluateRouteHealth(
			"search",
			ok("search", { outcomes: complete }),
		)
		expect(h.healthy).toBe(false)
		expect(h.issues).toContain("missing:results")
	})
})

describe("evaluateRouteHealth: searchDetailed", () => {
	const meta = { outcomeStatus: "complete", laneOutcomes: [] }

	it("is healthy when metadata reports complete outcomes", () => {
		const h = evaluateRouteHealth(
			"searchDetailed",
			ok("searchDetailed", { results: [], metadata: meta }),
		)
		expect(h).toMatchObject({ healthy: true, evaluable: true })
	})

	it("flags missing metadata, partial status, failed lanes and throttling", () => {
		expect(
			evaluateRouteHealth(
				"searchDetailed",
				ok("searchDetailed", { results: [] }),
			).issues,
		).toContain("missing:metadata")
		const h = evaluateRouteHealth(
			"searchDetailed",
			ok("searchDetailed", {
				results: [],
				metadata: {
					outcomeStatus: "partial",
					laneOutcomes: [
						{
							lane: "graph",
							stage: "x",
							outcome: "failed",
							reason: "query-timeout",
							pass: 1,
						},
					],
					throttled: { retryAfterMs: 100 },
				},
			}),
		)
		expect(h.healthy).toBe(false)
		expect(h.issues).toEqual(
			expect.arrayContaining([
				"outcomes:partial",
				"lane-failed:graph/x:query-timeout",
				"throttled",
			]),
		)
	})
})

describe("evaluateRouteHealth: recallConversation", () => {
	it("is healthy with results and metadata", () => {
		const h = evaluateRouteHealth(
			"recallConversation",
			ok("recallConversation", { results: [], metadata: { totalMatched: 0 } }),
		)
		expect(h).toMatchObject({ healthy: true, evaluable: true })
	})

	it("flags missing metadata and a degradation marker", () => {
		expect(
			evaluateRouteHealth(
				"recallConversation",
				ok("recallConversation", { results: [] }),
			).issues,
		).toContain("missing:metadata")
	})

	it("is not evaluable for absence when more matched than were returned", () => {
		const h = evaluateRouteHealth(
			"recallConversation",
			ok("recallConversation", {
				results: [{}],
				metadata: { totalMatched: 3 },
			}),
		)
		expect(h.healthy).toBe(true)
		expect(h.evaluable).toBe(false)
		expect(h.issues).toContain("truncated")
	})
})

describe("evaluateRouteHealth: sectioned routes", () => {
	it("activeSlate: partial, failures and truncation", () => {
		const base = {
			items: [],
			metadata: {
				maxItems: 5,
				truncated: false,
				partial: false,
				countsByKind: {},
				sourceCounts: {},
			},
		}
		expect(
			evaluateRouteHealth("hydrateActiveSlate", ok("hydrateActiveSlate", base)),
		).toMatchObject({
			healthy: true,
			evaluable: true,
		})
		const partial = evaluateRouteHealth(
			"hydrateActiveSlate",
			ok("hydrateActiveSlate", {
				...base,
				metadata: {
					...base.metadata,
					partial: true,
					failures: [
						{
							section: "structured",
							stage: "s",
							outcome: "failed",
							reason: "query-error",
						},
					],
				},
			}),
		)
		expect(partial.healthy).toBe(false)
		expect(partial.issues).toEqual(
			expect.arrayContaining([
				"partial",
				"section-failed:structured/s:query-error",
			]),
		)
		const truncated = evaluateRouteHealth(
			"hydrateActiveSlate",
			ok("hydrateActiveSlate", {
				...base,
				metadata: { ...base.metadata, truncated: true },
			}),
		)
		expect(truncated).toMatchObject({ healthy: true, evaluable: false })
		expect(truncated.issues).toContain("truncated")
	})

	it("discovery projection: partial and failures", () => {
		const h = evaluateRouteHealth(
			"buildDiscoveryProjection",
			ok("buildDiscoveryProjection", {
				sections: [],
				metadata: {
					partial: true,
					failures: [
						{
							section: "a:b",
							stage: "s",
							outcome: "budget-denied",
							reason: "budget-deadline",
						},
					],
				},
			}),
		)
		expect(h.healthy).toBe(false)
		expect(h.issues).toContain("section-budget-denied:a:b/s:budget-deadline")
	})

	it("context bundle: partial, lane outcomes, truncation and missing expected section", () => {
		const body = {
			rendered: "x",
			sections: [
				{ kind: "summary", items: [], partial: false, truncated: false },
			],
			metadata: {
				partial: false,
				truncated: false,
				outcomeStatus: "complete",
				laneOutcomes: [],
				sectionsIncluded: ["summary"],
			},
		}
		expect(
			evaluateRouteHealth("buildContextBundle", ok("buildContextBundle", body)),
		).toMatchObject({
			healthy: true,
			evaluable: true,
		})
		const missing = evaluateRouteHealth(
			"buildContextBundle",
			ok("buildContextBundle", body),
			{
				sections: ["summary", "query-evidence"],
			},
		)
		expect(missing.healthy).toBe(false)
		expect(missing.issues).toContain("missing-section:query-evidence")
		const withFailure = evaluateRouteHealth(
			"buildContextBundle",
			ok("buildContextBundle", {
				...body,
				metadata: {
					...body.metadata,
					failures: [
						{
							section: "query-evidence",
							stage: "s",
							outcome: "failed",
							reason: "index-missing",
						},
					],
				},
			}),
			{ sections: ["summary", "query-evidence"] },
		)
		expect(withFailure.issues).toContain(
			"section-failed:query-evidence/s:index-missing",
		)
		expect(withFailure.issues).not.toContain("missing-section:query-evidence")
		const truncated = evaluateRouteHealth(
			"buildContextBundle",
			ok("buildContextBundle", {
				...body,
				sections: [
					{ kind: "summary", items: [], partial: false, truncated: true },
				],
			}),
		)
		expect(truncated).toMatchObject({ healthy: true, evaluable: false })
	})

	it("state: a missing section without a failure row is unhealthy", () => {
		const profile = {
			agentId: "a",
			preferences: [],
			decisions: [],
			facts: [],
			todos: [],
		}
		const bundle = {
			rendered: "",
			sections: [],
			metadata: { partial: false, truncated: false, sectionsIncluded: [] },
		}
		const blocks = { blocks: [], totalTokenBudget: 1, totalActualTokens: 0 }
		expect(
			evaluateRouteHealth("state", ok("state", { profile, blocks, bundle })),
		).toMatchObject({
			healthy: true,
			evaluable: true,
		})
		const missing = evaluateRouteHealth(
			"state",
			ok("state", { profile, bundle }),
		)
		expect(missing.healthy).toBe(false)
		expect(missing.issues).toContain("missing-section:blocks")
		const partial = evaluateRouteHealth(
			"state",
			ok("state", {
				profile,
				bundle,
				partial: true,
				failures: [{ section: "blocks", reason: "query-error" }],
			}),
		)
		expect(partial.issues).toEqual(
			expect.arrayContaining(["partial", "section-failed:blocks:query-error"]),
		)
		expect(partial.issues).not.toContain("missing-section:blocks")
	})

	it("state: inherits a nested bundle that is partial", () => {
		const profile = {
			agentId: "a",
			preferences: [],
			decisions: [],
			facts: [],
			todos: [],
		}
		const blocks = { blocks: [], totalTokenBudget: 1, totalActualTokens: 0 }
		const h = evaluateRouteHealth(
			"state",
			ok("state", {
				profile,
				blocks,
				bundle: {
					rendered: "",
					sections: [],
					metadata: { partial: true, truncated: false, sectionsIncluded: [] },
				},
			}),
		)
		expect(h.healthy).toBe(false)
		expect(h.issues).toContain("bundle:partial")
	})

	it("profile: needs its four collections", () => {
		const good = {
			agentId: "a",
			preferences: [],
			decisions: [],
			facts: [],
			todos: [],
		}
		expect(evaluateRouteHealth("profile", ok("profile", good)).healthy).toBe(
			true,
		)
		const bad = evaluateRouteHealth(
			"profile",
			ok("profile", { agentId: "a", facts: [] }),
		)
		expect(bad.healthy).toBe(false)
		expect(bad.issues).toContain("missing-section:preferences")
	})
})

describe("evaluateRouteHealth: handle and locator routes", () => {
	it.each([
		"lifecycleGet",
		"lifecycleHistory",
	] as const)("%s: 404 and 403 are healthy denials, 5xx is not", (route) => {
		expect(
			evaluateRouteHealth(route, httpError(route, 404, "NOT_FOUND")),
		).toMatchObject({
			completed: true,
			healthy: true,
			evaluable: true,
			denied: "not-found",
		})
		expect(
			evaluateRouteHealth(route, httpError(route, 403, "FORBIDDEN")),
		).toMatchObject({
			healthy: true,
			evaluable: true,
			denied: "forbidden",
		})
		expect(
			evaluateRouteHealth(route, httpError(route, 500, "LIFECYCLE_GET_FAILED")),
		).toMatchObject({
			completed: false,
			healthy: false,
			evaluable: false,
		})
		expect(
			evaluateRouteHealth(route, httpError(route, 400, "VALIDATION_ERROR"))
				.healthy,
		).toBe(false)
	})

	it("lifecycleGet returns the item when readable", () => {
		const h = evaluateRouteHealth(
			"lifecycleGet",
			ok("lifecycleGet", { family: "structured", handle: {}, data: {} }),
		)
		expect(h).toMatchObject({ healthy: true, evaluable: true })
		expect(h.denied).toBeUndefined()
	})

	it("lifecycleHistory needs an array", () => {
		expect(
			evaluateRouteHealth("lifecycleHistory", ok("lifecycleHistory", [{}]))
				.healthy,
		).toBe(true)
		expect(
			evaluateRouteHealth("lifecycleHistory", ok("lifecycleHistory", {}))
				.healthy,
		).toBe(false)
	})

	it("readFile: empty text is a healthy not-found denial; an error or disabled flag is unhealthy", () => {
		expect(
			evaluateRouteHealth("readFile", ok("readFile", { text: "", path: "p" })),
		).toMatchObject({
			healthy: true,
			evaluable: true,
			denied: "not-found",
		})
		expect(
			evaluateRouteHealth(
				"readFile",
				ok("readFile", { text: "value: x", path: "p" }),
			).denied,
		).toBeUndefined()
		expect(
			evaluateRouteHealth(
				"readFile",
				ok("readFile", { text: "", path: "p", error: "boom" }),
			).healthy,
		).toBe(false)
		expect(
			evaluateRouteHealth(
				"readFile",
				ok("readFile", { text: "", path: "p", disabled: true }),
			).healthy,
		).toBe(false)
	})
})

describe("evaluateRouteHealth: admin routes", () => {
	it("relevanceExplain: degraded health is unhealthy", () => {
		expect(
			evaluateRouteHealth(
				"relevanceExplain",
				ok("relevanceExplain", { health: "ok", results: [] }),
			).healthy,
		).toBe(true)
		const h = evaluateRouteHealth(
			"relevanceExplain",
			ok("relevanceExplain", { health: "degraded", results: [] }),
		)
		expect(h.healthy).toBe(false)
		expect(h.issues).toContain("health:degraded")
	})

	it("traceChain needs a nodes array", () => {
		expect(
			evaluateRouteHealth(
				"traceChain",
				ok("traceChain", { nodes: [], chainComplete: true }),
			).healthy,
		).toBe(true)
		expect(
			evaluateRouteHealth("traceChain", ok("traceChain", {})).healthy,
		).toBe(false)
	})
})

describe("evaluateRouteHealth: scanNovelty", () => {
	it("needs an events array", () => {
		expect(
			evaluateRouteHealth("scanNovelty", ok("scanNovelty", { events: [] }))
				.healthy,
		).toBe(true)
		expect(
			evaluateRouteHealth("scanNovelty", ok("scanNovelty", {})).issues,
		).toContain("missing:events")
	})
})

describe("tallyHealth", () => {
	it("counts attempted, completed, healthy and evaluable", () => {
		const list = [
			evaluateRouteHealth(
				"search",
				ok("search", { results: [], outcomes: complete }),
			),
			evaluateRouteHealth("search", httpError("search", 503)),
			evaluateRouteHealth(
				"search",
				ok("search", { results: [], degradation: { kind: "auth" } }),
			),
		]
		expect(tallyHealth(list)).toEqual({
			attempted: 3,
			completed: 2,
			healthy: 1,
			evaluable: 1,
		})
	})
})
