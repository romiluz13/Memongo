import { describe, expect, it } from "vitest"
import {
	caseOf,
	deleteSequence,
	type GItem,
	invalidated,
	newItem,
	oldItem,
	ROUTES,
	routeBody,
	updateSequence,
	withPost,
	withPre,
} from "./probe-g-fixtures.ts"
import {
	evaluateProbeG,
	G_GAPS,
	type GSequenceFacts,
	PROBE_G_RULE,
	PROBE_G_VERSION,
	requiredCaseIdsG,
} from "./probe-g-model.ts"

describe("evaluateProbeG clean sequences", () => {
	it("passes when both sequences behave on every assessable route", () => {
		const result = evaluateProbeG([updateSequence(), deleteSequence()])
		expect(result.cases.filter((item) => item.outcome !== "pass")).toEqual([])
		expect(result.outcome).toBe("pass")
		expect(result.cases).toHaveLength(ROUTES.length * 2)
	})

	it("lists routes it cannot assess as explicit coverage gaps with reasons", () => {
		const result = evaluateProbeG([updateSequence(), deleteSequence()])
		const names = result.gaps.map((gap) => gap.route)
		expect(names).toEqual(G_GAPS.map((gap) => gap.route))
		expect(names).toContain("traceChain")
		expect(names).not.toContain("relevanceExplain")
		expect(result.gaps.every((gap) => gap.reason.length > 15)).toBe(true)
	})

	it("derives required case ids from the route table", () => {
		expect(requiredCaseIdsG()).toHaveLength(ROUTES.length * 2)
		expect(requiredCaseIdsG()).toContain("G/update/search")
	})

	it("requires relevanceExplain on both sequences", () => {
		expect(requiredCaseIdsG()).toContain("G/update/relevanceExplain")
		expect(requiredCaseIdsG()).toContain("G/delete/relevanceExplain")
		const missing = evaluateProbeG([
			{
				...updateSequence(),
				reads: updateSequence().reads.filter(
					(read) => read.route !== "relevanceExplain",
				),
			},
			deleteSequence(),
		])
		expect(missing.outcome).not.toBe("pass")
		expect(missing.reasons.join(" ")).toContain("G/update/relevanceExplain")
	})

	it("prints a rule and a version", () => {
		expect(PROBE_G_RULE).toMatch(/superseded/)
		expect(PROBE_G_VERSION).toBe("G-2")
	})
})

describe("evaluateProbeG stale value as current", () => {
	it("fails a contract route that still returns the old value after an update", () => {
		const facts = withPost(
			updateSequence(),
			"search",
			routeBody("search", [oldItem]),
		)
		const result = evaluateProbeG([facts, deleteSequence()])
		const stale = caseOf(result, "update", "search")
		expect(stale.outcome).toBe("fail")
		expect(stale.predicate).toBe("old-as-current:search")
		expect(stale.controlEligible).toBe(true)
		expect(stale.evidence?.response).toBeDefined()
		expect(result.outcome).toBe("fail")
	})

	it("fails even when the stale response is also partial (stale plus degraded)", () => {
		const body = {
			...(routeBody("search", [oldItem]) as object),
			outcomes: {
				status: "partial",
				lanes: [
					{
						lane: "vector",
						stage: "retrieve",
						outcome: "failed",
						reason: "timeout",
					},
				],
			},
		}
		const result = evaluateProbeG([withPost(updateSequence(), "search", body)])
		expect(caseOf(result, "update", "search").outcome).toBe("fail")
	})

	it("fails when an invalidated value is still served as current after a delete", () => {
		const facts = withPost(
			deleteSequence(),
			"profile",
			routeBody("profile", [oldItem]),
		)
		const stale = caseOf(evaluateProbeG([facts]), "delete", "profile")
		expect(stale.outcome).toBe("fail")
		expect(stale.predicate).toBe("old-as-current:profile")
	})

	it("fails a stale value even when the pre-mutation control did not surface the item", () => {
		const facts = withPre(
			withPost(updateSequence(), "search", routeBody("search", [oldItem])),
			"search",
			routeBody("search", []),
		)
		const stale = caseOf(evaluateProbeG([facts]), "update", "search")
		expect(stale.outcome).toBe("fail")
		expect(stale.controlEligible).toBe(false)
	})

	it("allows the old value on a row that is explicitly labelled historical", () => {
		const facts = withPost(
			deleteSequence(),
			"searchDetailed",
			routeBody("searchDetailed", [invalidated]),
		)
		expect(
			caseOf(evaluateProbeG([facts]), "delete", "searchDetailed").outcome,
		).toBe("pass")
	})

	it("fails a detailed row that carries the old value with an active state", () => {
		const facts = withPost(
			updateSequence(),
			"searchDetailed",
			routeBody("searchDetailed", [oldItem, newItem]),
		)
		expect(
			caseOf(evaluateProbeG([facts]), "update", "searchDetailed").outcome,
		).toBe("fail")
	})

	it("calls a detailed row without any currentness field unassessable, not passed", () => {
		const body = {
			results: [
				{ snippet: oldItem.value },
				{ snippet: newItem.value, state: "active" },
			],
			metadata: { outcomeStatus: "complete", laneOutcomes: [] },
		}
		const result = evaluateProbeG([
			withPost(updateSequence(), "searchDetailed", body),
		])
		const unassessed = caseOf(result, "update", "searchDetailed")
		expect(unassessed.outcome).toBe("inconclusive")
		expect(unassessed.reason).toMatch(/unassessable/)
	})

	it("ignores the rendered text copy when the structured row is labelled historical", () => {
		const body = routeBody("buildContextBundle", [invalidated]) as Record<
			string,
			unknown
		>
		const result = evaluateProbeG([
			withPost(deleteSequence(), "buildContextBundle", body),
		])
		expect(caseOf(result, "delete", "buildContextBundle").outcome).toBe("pass")
	})

	it("treats an unlabelled old value in a bundle item as current", () => {
		const body = {
			...(routeBody("buildContextBundle", [newItem]) as Record<
				string,
				unknown
			>),
			sections: [
				{
					kind: "query-evidence",
					items: [{ summary: oldItem.value }, { summary: newItem.value }],
					partial: false,
					truncated: false,
				},
			],
		}
		const result = evaluateProbeG([
			withPost(updateSequence(), "buildContextBundle", body),
		])
		expect(caseOf(result, "update", "buildContextBundle").outcome).toBe("fail")
	})
})

describe("evaluateProbeG readFile oracle", () => {
	it("passes the new value at a higher revision", () => {
		expect(
			caseOf(evaluateProbeG([updateSequence()]), "update", "readFile").outcome,
		).toBe("pass")
	})

	it("fails the old value on an active record", () => {
		const facts = withPost(
			updateSequence(),
			"readFile",
			routeBody("readFile", [oldItem]),
		)
		expect(caseOf(evaluateProbeG([facts]), "update", "readFile").outcome).toBe(
			"fail",
		)
	})

	it("fails a deleted record that still reads as active", () => {
		const facts = withPost(
			deleteSequence(),
			"readFile",
			routeBody("readFile", [{ ...oldItem, revision: 2 }]),
		)
		expect(caseOf(evaluateProbeG([facts]), "delete", "readFile").outcome).toBe(
			"fail",
		)
	})

	it("is inconclusive when the text carries no state line", () => {
		const facts = withPost(updateSequence(), "readFile", {
			text: `type: fact\nkey: k\nvalue: ${oldItem.value}`,
		})
		const result = evaluateProbeG([facts])
		expect(caseOf(result, "update", "readFile").outcome).toBe("inconclusive")
	})
})

describe("evaluateProbeG lifecycle oracle", () => {
	it("fails lifecycleGet when an acknowledged update is not visible and leaves other routes inconclusive", () => {
		const facts = withPost(
			updateSequence(),
			"lifecycleGet",
			routeBody("lifecycleGet", [oldItem]),
		)
		const result = evaluateProbeG([facts])
		const get = caseOf(result, "update", "lifecycleGet")
		expect(get.outcome).toBe("fail")
		expect(get.predicate).toBe("old-as-current:lifecycleGet")
		const other = caseOf(result, "update", "profile")
		expect(other.outcome).toBe("inconclusive")
		expect(other.reason).toMatch(/mutation-ack-not-visible/)
	})

	it("treats a revision that did not advance as not confirmed", () => {
		const sameRevision: GItem = { ...newItem, revision: 1 }
		const facts = withPost(
			updateSequence(),
			"lifecycleGet",
			routeBody("lifecycleGet", [sameRevision]),
		)
		const result = evaluateProbeG([facts])
		expect(caseOf(result, "update", "lifecycleGet").outcome).toBe(
			"inconclusive",
		)
		expect(caseOf(result, "update", "search").reason).toMatch(
			/mutation-unverified/,
		)
	})

	it("passes lifecycleGet after a delete that answers 404 (gone)", () => {
		const notFound = {
			...deleteSequence(),
			reads: deleteSequence().reads.map((read) =>
				read.route === "lifecycleGet" && read.phase === "post"
					? {
							...read,
							observation: {
								kind: "http-error" as const,
								route: "lifecycleGet",
								status: 404,
							},
							health: {
								route: "lifecycleGet" as const,
								completed: true,
								healthy: true,
								evaluable: true,
								denied: "not-found" as const,
								issues: [],
							},
						}
					: read,
			),
		}
		expect(
			caseOf(evaluateProbeG([notFound]), "delete", "lifecycleGet").outcome,
		).toBe("pass")
	})

	it("fails a history whose current entry still holds the old value", () => {
		const facts = withPost(
			updateSequence(),
			"lifecycleHistory",
			routeBody("lifecycleHistory", [], { current: oldItem, revisions: [] }),
		)
		const stale = caseOf(evaluateProbeG([facts]), "update", "lifecycleHistory")
		expect(stale.outcome).toBe("fail")
		expect(stale.predicate).toBe("old-as-current:lifecycleHistory")
	})

	it("allows the old value in superseded revision entries", () => {
		expect(
			caseOf(evaluateProbeG([updateSequence()]), "update", "lifecycleHistory")
				.outcome,
		).toBe("pass")
	})

	it("is inconclusive when the history has no current entry", () => {
		const facts = withPost(updateSequence(), "lifecycleHistory", [
			{
				historyKind: "revision",
				...(routeBody("lifecycleGet", [oldItem]) as object),
			},
		])
		expect(
			caseOf(evaluateProbeG([facts]), "update", "lifecycleHistory").outcome,
		).toBe("inconclusive")
	})
})

describe("evaluateProbeG inconclusive paths", () => {
	it("is inconclusive on every route when the mutation was not applied", () => {
		const facts: GSequenceFacts = {
			...updateSequence(),
			ack: { ok: false, reason: "http-409" },
		}
		const result = evaluateProbeG([facts])
		expect(result.cases.every((item) => item.outcome === "inconclusive")).toBe(
			true,
		)
		expect(caseOf(result, "update", "search").reason).toMatch(
			/mutation-not-applied/,
		)
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive when the new value is absent from a route", () => {
		const facts = withPost(
			updateSequence(),
			"profile",
			routeBody("profile", []),
		)
		const missing = caseOf(evaluateProbeG([facts]), "update", "profile")
		expect(missing.outcome).toBe("inconclusive")
		expect(missing.reason).toMatch(/new-value-absent/)
	})

	it("is inconclusive when the route could not surface the item before the mutation", () => {
		const facts = withPre(updateSequence(), "state", routeBody("state", []))
		const noControl = caseOf(evaluateProbeG([facts]), "update", "state")
		expect(noControl.outcome).toBe("inconclusive")
		expect(noControl.reason).toMatch(/control-not-established/)
	})

	it("is inconclusive on a transport error and on a truncated slate", () => {
		const transport = evaluateProbeG([
			{
				...updateSequence(),
				reads: updateSequence().reads.map((read) =>
					read.route === "search" && read.phase === "post"
						? {
								...read,
								observation: {
									kind: "transport-error" as const,
									route: "search",
									message: "ECONNRESET",
								},
								health: {
									route: "search" as const,
									completed: false,
									healthy: false,
									evaluable: false,
									issues: ["transport-error"],
								},
							}
						: read,
				),
			},
		])
		expect(caseOf(transport, "update", "search").outcome).toBe("inconclusive")
		const truncated = withPost(updateSequence(), "hydrateActiveSlate", {
			items: [{ summary: newItem.value, state: "active" }],
			metadata: { truncated: true, partial: false },
		})
		expect(
			caseOf(evaluateProbeG([truncated]), "update", "hydrateActiveSlate")
				.outcome,
		).toBe("inconclusive")
	})

	it("is inconclusive when a required post read never ran", () => {
		const facts = updateSequence()
		const trimmed = {
			...facts,
			reads: facts.reads.filter(
				(read) => !(read.route === "profile" && read.phase === "post"),
			),
		}
		const result = evaluateProbeG([trimmed, deleteSequence()])
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons.join(" ")).toContain("G/update/profile")
	})
})
