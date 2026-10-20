import { describe, expect, it } from "vitest"
import {
	caseOf,
	invalidatedOld,
	newItem,
	OLD,
	oldItem,
	PAST,
	read,
	supersedeFacts,
	updateFacts,
	withRead,
} from "./probe-c-fixtures.ts"
import {
	evaluateProbeC,
	PROBE_C_RULE,
	PROBE_C_VERSION,
	requiredCaseIdsC,
} from "./probe-c-model.ts"
import { routeBody } from "./probe-g-fixtures.ts"

describe("evaluateProbeC clean sequences", () => {
	it("passes both explicit sequences and derives six required ids", () => {
		const result = evaluateProbeC([updateFacts(), supersedeFacts()])
		expect(result.cases.filter((item) => item.outcome !== "pass")).toEqual([])
		expect(result.outcome).toBe("pass")
		expect(requiredCaseIdsC()).toHaveLength(6)
	})

	it("prints a rule and a version", () => {
		expect(PROBE_C_RULE).toMatch(/strictly above/)
		expect(PROBE_C_RULE).toMatch(/whatever the health/)
		expect(PROBE_C_VERSION).toBe("C-2")
	})
})

describe("evaluateProbeC ranking", () => {
	it("passes when both values are eligible and the new one ranks strictly higher", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", routeBody("search", [newItem, oldItem])),
		)
		expect(caseOf(evaluateProbeC([facts]), "C/update/search").outcome).toBe(
			"pass",
		)
	})

	it("fails when the old value ranks above the new one", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", routeBody("search", [oldItem, newItem])),
		)
		const failed = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("old-ranked-at-or-above-new")
		expect(failed.evidence?.response).toBeDefined()
	})

	it("fails a tie, because the new value must rank strictly above the old one", () => {
		const both = {
			value: `${oldItem.value} and ${newItem.value}`,
			revision: 2,
			state: "active",
		} as const
		const facts = withRead(
			updateFacts(),
			read("search", "post", routeBody("search", [both])),
		)
		const failed = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("old-ranked-at-or-above-new")
	})

	it("fails when the old value is served and the new one is missing after the update settled", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", routeBody("search", [oldItem])),
		)
		const failed = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("old-served-new-missing")
	})

	it("is inconclusive, not failed, when the async update was never observed", () => {
		const facts = withRead(
			updateFacts({ settled: false }),
			read("search", "post", routeBody("search", [oldItem])),
		)
		const result = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toMatch(/async-update-unobserved/)
	})

	it("is inconclusive when both values are absent", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", routeBody("search", [])),
		)
		const result = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toMatch(/both-absent/)
	})

	it("passes with the new value alone, and with an old value labelled historical", () => {
		const labelled = withRead(
			updateFacts(),
			read(
				"searchDetailed",
				"post",
				routeBody("searchDetailed", [invalidatedOld, newItem]),
			),
		)
		expect(
			caseOf(evaluateProbeC([labelled]), "C/update/searchDetailed").outcome,
		).toBe("pass")
	})

	it("is inconclusive when a detailed row carries no currentness field", () => {
		const body = {
			results: [
				{ snippet: oldItem.value },
				{ snippet: newItem.value, state: "active" },
			],
			metadata: { outcomeStatus: "complete", laneOutcomes: [] },
		}
		const facts = withRead(updateFacts(), read("searchDetailed", "post", body))
		const result = caseOf(evaluateProbeC([facts]), "C/update/searchDetailed")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toMatch(/unassessable/)
	})

	it("is inconclusive when the post read was degraded and shows no violation", () => {
		const body = {
			...(routeBody("search", [newItem]) as object),
			outcomes: {
				status: "partial",
				lanes: [
					{
						lane: "vector",
						stage: "x",
						outcome: "failed",
						reason: "query-timeout",
					},
				],
			},
		}
		const facts = withRead(updateFacts(), read("search", "post", body))
		expect(caseOf(evaluateProbeC([facts]), "C/update/search").outcome).toBe(
			"inconclusive",
		)
	})
})

describe("evaluateProbeC preconditions", () => {
	it("is inconclusive when the old value was not retrievable before the mutation", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "pre", routeBody("search", [])),
		)
		const result = evaluateProbeC([facts])
		expect(caseOf(result, "C/update/search").reason).toMatch(
			/precondition:old-not-retrievable/,
		)
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive when the replacement was not ready before the supersession", () => {
		const facts = withRead(
			supersedeFacts(),
			read("search", "pre", routeBody("search", [oldItem])),
		)
		expect(
			caseOf(evaluateProbeC([facts]), "C/supersede/search").reason,
		).toMatch(/precondition:new-not-ready/)
	})

	it("is inconclusive on every case when the mutation was not applied or was quarantined", () => {
		const result = evaluateProbeC([
			updateFacts({ ack: { ok: false, reason: "quarantined" } }),
		])
		const own = result.cases.filter((item) =>
			item.caseId.startsWith("C/update/"),
		)
		expect(own.every((item) => item.outcome === "inconclusive")).toBe(true)
		expect(own[0]?.reason).toMatch(/mutation-not-applied/)
	})
})

describe("evaluateProbeC lifecycle evidence", () => {
	it("fails when the lifecycle record still shows the old value after an acknowledged update", () => {
		const facts = withRead(
			updateFacts(),
			read("lifecycleGet", "post", routeBody("lifecycleGet", [oldItem])),
		)
		const failed = caseOf(evaluateProbeC([facts]), "C/update/lifecycle")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("update-not-visible")
	})

	it("fails when history keeps no revision entry for the old value", () => {
		const facts = withRead(
			updateFacts(),
			read(
				"lifecycleHistory",
				"post",
				routeBody("lifecycleHistory", [], { current: newItem, revisions: [] }),
			),
		)
		const failed = caseOf(evaluateProbeC([facts]), "C/update/lifecycle")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("history-missing-old-revision")
	})

	it("fails when the superseded record is still active", () => {
		const text = `type: fact\nkey: k\nvalue: ${oldItem.value}\nrevision: 1\nstate: active`
		const facts = withRead(supersedeFacts(), read("readFile", "post", { text }))
		const failed = caseOf(evaluateProbeC([facts]), "C/supersede/lifecycle")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("old-still-active")
	})

	it("fails when the invalidation does not link to the replacement", () => {
		const text = `type: fact\nkey: k\nvalue: ${oldItem.value}\nrevision: 2\nstate: invalidated\nvalidTo: ${PAST}\ninvalidatedBy: ${JSON.stringify({ reason: "lifecycle" })}`
		const facts = withRead(supersedeFacts(), read("readFile", "post", { text }))
		const failed = caseOf(evaluateProbeC([facts]), "C/supersede/lifecycle")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("supersession-link-missing")
	})

	it("is inconclusive when the lifecycle evidence could not be read", () => {
		const facts = withRead(supersedeFacts(), {
			...read("readFile", "post", { text: "" }),
			observation: {
				kind: "transport-error",
				route: "readFile",
				message: "ECONNRESET",
			},
			health: {
				route: "readFile",
				completed: false,
				healthy: false,
				evaluable: false,
				issues: ["transport-error"],
			},
		})
		expect(
			caseOf(evaluateProbeC([facts]), "C/supersede/lifecycle").outcome,
		).toBe("inconclusive")
	})

	it("is inconclusive when a required case was never executed", () => {
		const result = evaluateProbeC([updateFacts()])
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons.join(" ")).toContain("C/supersede/search")
	})
})

describe("evaluateProbeC baseline revision", () => {
	it("does not call the update lifecycle advanced when the pre-read carried no revision", () => {
		const body = routeBody("lifecycleGet", [oldItem]) as {
			handle: Record<string, unknown>
		}
		const facts = withRead(
			updateFacts(),
			read("lifecycleGet", "pre", {
				...body,
				handle: { ...body.handle, revision: undefined },
			}),
		)
		const found = caseOf(evaluateProbeC([facts]), "C/update/lifecycle")
		expect(found.outcome).toBe("inconclusive")
		expect(found.reason).toBe("unverified:baseline-revision-missing")
	})
})

describe("evaluateProbeC echoed query fields are not returned content", () => {
	const echoed = (marker: string) => ({
		results: [],
		outcomes: { status: "complete", lanes: [] },
		query: `what is ${marker}`,
		metadata: { passes: [{ pass: 1, query: `what is ${marker}` }] },
	})

	it("does not call the old value served when only the echoed query carries it", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", {
				...(routeBody("search", [newItem]) as object),
				...echoed(OLD),
				results: [{ snippet: newItem.value }],
			}),
		)
		const found = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(found.outcome).toBe("pass")
	})

	it("does not take the old value in an echoed query for a satisfied precondition", () => {
		const facts = withRead(updateFacts(), read("search", "pre", echoed(OLD)))
		const found = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(found.outcome).toBe("inconclusive")
		expect(found.reason).toBe("precondition:old-not-retrievable")
	})
})
