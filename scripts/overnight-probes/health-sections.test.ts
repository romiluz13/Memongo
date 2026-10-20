import { describe, expect, it } from "vitest"
import { evaluateRouteHealth, type RouteId } from "./health.ts"
import type { Observation } from "./types.ts"

const ok = (route: RouteId, body: unknown): Observation => ({
	kind: "response",
	route,
	body,
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

describe("evaluateRouteHealth: malformed outcomes", () => {
	it.each([
		["a string", "complete"],
		["a number", 5],
		["an array", []],
		["null", null],
	])("search and searchKB: outcomes that is %s is an issue, not healthy", (_label, outcomes) => {
		for (const route of ["search", "searchKB"] as const) {
			const h = evaluateRouteHealth(route, ok(route, { results: [], outcomes }))
			expect(h).toMatchObject({ healthy: false, evaluable: false })
			expect(h.issues).toContain("malformed:outcomes")
		}
	})

	it("search: lanes that is not an array is an issue", () => {
		const h = evaluateRouteHealth(
			"search",
			ok("search", {
				results: [],
				outcomes: { status: "complete", lanes: "none" },
			}),
		)
		expect(h).toMatchObject({ healthy: false, evaluable: false })
		expect(h.issues).toContain("malformed:outcome-lanes")
	})
})

describe("evaluateRouteHealth: traceChain completeness", () => {
	const chain = (overrides: Record<string, unknown> = {}) =>
		ok("traceChain", {
			nodes: [{ type: "fact", id: "f1", collection: "c", depth: 0 }],
			chainComplete: true,
			maxDepthReached: false,
			...overrides,
		})

	it("is healthy and evaluable when the chain is complete", () => {
		expect(evaluateRouteHealth("traceChain", chain())).toMatchObject({
			healthy: true,
			evaluable: true,
			issues: [],
		})
	})

	it.each([
		[
			"an incomplete chain",
			{ chainComplete: false },
			"partial:chain-incomplete",
		],
		[
			"a chain that does not say it is complete",
			{ chainComplete: undefined },
			"partial:chain-incomplete",
		],
		[
			"a chain cut at the depth limit",
			{ maxDepthReached: true },
			"partial:max-depth",
		],
		[
			"a gap node",
			{
				nodes: [
					{ type: "fact", id: "f1", collection: "c", depth: 0 },
					{
						type: "gap",
						id: "g1",
						collection: "c",
						depth: 1,
						reason: "missing",
					},
				],
			},
			"partial:gap-node",
		],
	])("%s is partial, so not healthy", (_label, overrides, issue) => {
		const h = evaluateRouteHealth("traceChain", chain(overrides))
		expect(h).toMatchObject({ healthy: false, evaluable: false })
		expect(h.issues).toContain(issue)
	})
})
