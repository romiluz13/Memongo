import { describe, expect, it } from "vitest"
import {
	caseOf,
	freshNew,
	invalidatedOld,
	newItem,
	oldItem,
	partialOutcomes,
	read,
	supersedeFacts,
	updateFacts,
	withoutRead,
	withRead,
} from "./probe-c-fixtures.ts"
import { evaluateProbeC } from "./probe-c-model.ts"
import { routeBody } from "./probe-g-fixtures.ts"

const degraded = (route: "search", items: Parameters<typeof routeBody>[1]) => ({
	...(routeBody(route, items) as object),
	outcomes: partialOutcomes,
})

describe("evaluateProbeC judges a forbidden observation before health", () => {
	it("fails an old value ranked above the new one even when the response was degraded", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", degraded("search", [oldItem, newItem])),
		)
		const found = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(found.outcome).toBe("fail")
		expect(found.predicate).toBe("old-ranked-at-or-above-new")
		expect(found.controlEligible).toBe(true)
	})

	it("fails an old value served with the new one missing even when the response was degraded", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", degraded("search", [oldItem])),
		)
		const found = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(found.outcome).toBe("fail")
		expect(found.predicate).toBe("old-served-new-missing")
	})

	it("still fails when the pre-read control was not established, but marks the failure control-ineligible", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "pre", routeBody("search", [])),
		)
		const stale = withRead(
			facts,
			read("search", "post", routeBody("search", [oldItem, newItem])),
		)
		const found = caseOf(evaluateProbeC([stale]), "C/update/search")
		expect(found.outcome).toBe("fail")
		expect(found.controlEligible).toBe(false)
	})

	it("stays inconclusive for a degraded response that shows no violation", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "post", degraded("search", [newItem])),
		)
		const found = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(found.outcome).toBe("inconclusive")
		expect(found.reason).toMatch(/^unevaluable/)
	})

	it("does not fail an old value served before the asynchronous update was observed", () => {
		const facts = withRead(
			updateFacts({ settled: false }),
			read("search", "post", degraded("search", [oldItem])),
		)
		const found = caseOf(evaluateProbeC([facts]), "C/update/search")
		expect(found.outcome).toBe("inconclusive")
	})
})

describe("evaluateProbeC searchDetailed has its own pre-read control", () => {
	it("is inconclusive for searchDetailed alone when its own pre-read lacked the old value", () => {
		const facts = withRead(
			updateFacts(),
			read("searchDetailed", "pre", routeBody("searchDetailed", [])),
		)
		const result = evaluateProbeC([facts])
		expect(caseOf(result, "C/update/search").outcome).toBe("pass")
		const detailed = caseOf(result, "C/update/searchDetailed")
		expect(detailed.outcome).toBe("inconclusive")
		expect(detailed.reason).toBe("precondition:old-not-retrievable")
	})

	it("is inconclusive for searchDetailed when it was never pre-read", () => {
		const facts = withoutRead(updateFacts(), "searchDetailed", "pre")
		const result = evaluateProbeC([facts])
		expect(caseOf(result, "C/update/searchDetailed").reason).toBe(
			"precondition:not-run",
		)
		expect(caseOf(result, "C/update/search").outcome).toBe("pass")
	})

	it("is inconclusive for search alone when only the plain pre-read lacked the old value", () => {
		const facts = withRead(
			updateFacts(),
			read("search", "pre", routeBody("search", [])),
		)
		const result = evaluateProbeC([facts])
		expect(caseOf(result, "C/update/search").reason).toBe(
			"precondition:old-not-retrievable",
		)
		expect(caseOf(result, "C/update/searchDetailed").outcome).toBe("pass")
	})

	it("requires the replacement in the detailed pre-read for a supersession", () => {
		const facts = withRead(
			supersedeFacts(),
			read("searchDetailed", "pre", routeBody("searchDetailed", [oldItem])),
		)
		const result = evaluateProbeC([facts])
		expect(caseOf(result, "C/supersede/search").outcome).toBe("pass")
		expect(caseOf(result, "C/supersede/searchDetailed").reason).toBe(
			"precondition:new-not-ready",
		)
	})
})

describe("evaluateProbeC supersession keeps revision and history evidence", () => {
	const lifecycle = (facts: ReturnType<typeof supersedeFacts>) =>
		caseOf(evaluateProbeC([facts]), "C/supersede/lifecycle")

	it("passes when the record is invalidated, its revision advanced and history keeps the old value", () => {
		const found = lifecycle(supersedeFacts())
		expect(found.outcome).toBe("pass")
		expect(found.detail).toMatchObject({ revision: 2, linked: true })
	})

	it("fails when the lifecycle record still shows the old record active", () => {
		const facts = withRead(
			supersedeFacts(),
			read(
				"lifecycleGet",
				"post",
				routeBody("lifecycleGet", [{ ...invalidatedOld, state: "active" }]),
			),
		)
		const found = lifecycle(facts)
		expect(found.outcome).toBe("fail")
		expect(found.predicate).toBe("old-still-active")
	})

	it("is inconclusive when the revision did not advance", () => {
		const facts = withRead(
			supersedeFacts(),
			read(
				"lifecycleGet",
				"post",
				routeBody("lifecycleGet", [{ ...invalidatedOld, revision: 1 }]),
			),
		)
		expect(lifecycle(facts).reason).toBe("unverified:revision-not-advanced")
	})

	it("is inconclusive without a baseline revision from before the mutation", () => {
		const facts = withoutRead(supersedeFacts(), "lifecycleGet", "pre")
		expect(lifecycle(facts).reason).toBe("unverified:baseline-revision-missing")
	})

	it("is inconclusive when the lifecycle record was not read after the mutation", () => {
		const facts = withoutRead(supersedeFacts(), "lifecycleGet", "post")
		expect(lifecycle(facts).reason).toBe("unverified:lifecycle-get")
	})

	it("fails when history keeps no revision entry for the old value", () => {
		const facts = withRead(
			supersedeFacts(),
			read(
				"lifecycleHistory",
				"post",
				routeBody("lifecycleHistory", [], {
					current: invalidatedOld,
					revisions: [],
				}),
			),
		)
		const found = lifecycle(facts)
		expect(found.outcome).toBe("fail")
		expect(found.predicate).toBe("history-missing-old-revision")
	})

	it("is inconclusive when the current history entry does not show the invalidation", () => {
		const facts = withRead(
			supersedeFacts(),
			read(
				"lifecycleHistory",
				"post",
				routeBody("lifecycleHistory", [], {
					current: oldItem,
					revisions: [oldItem],
				}),
			),
		)
		expect(lifecycle(facts).reason).toBe("unverified:history-current")
	})

	it("is inconclusive when history was not read", () => {
		const facts = withoutRead(supersedeFacts(), "lifecycleHistory", "post")
		expect(lifecycle(facts).reason).toBe("unverified:history")
	})

	it("keeps the replacement out of the judgment of the old record", () => {
		const facts = withRead(
			supersedeFacts(),
			read("search", "post", routeBody("search", [freshNew])),
		)
		expect(lifecycle(facts).outcome).toBe("pass")
	})
})
