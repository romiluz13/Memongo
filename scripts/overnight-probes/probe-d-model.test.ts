import { describe, expect, it } from "vitest"
import { evaluateRouteHealth } from "./health.ts"
import {
	D_AS_OF,
	D_EVENTS,
	D_GAPS,
	D_QUERIES,
	type DQueryRead,
	evaluateProbeD,
	expectedLabels,
	PROBE_D_RULE,
	PROBE_D_VERSION,
	requiredCaseIdsD,
	zonedDayWindow,
} from "./probe-d-model.ts"
import type { Observation } from "./types.ts"

function spec(id: string) {
	const found = D_QUERIES.find((query) => query.id === id)
	if (!found) throw new Error(`no query ${id}`)
	return found
}

describe("D fixture oracle (hand-derived, independent of the engine)", () => {
	it("orders the full window by timestamp descending with later insertion first on ties", () => {
		expect(expectedLabels(spec("full-window"))).toEqual([
			"E9",
			"E8",
			"V4",
			"E7",
			"E6",
			"E5",
			"E4",
			"E3",
			"E2",
			"E1",
			"S4",
			"S3",
			"S2",
			"S1",
		])
	})

	it("excludes events after asOf, invalidated at or before asOf, and valid only after asOf", () => {
		const labels = expectedLabels(spec("full-window"))
		for (const excluded of ["E10", "T1", "V1", "V2", "V3"]) {
			expect(labels).not.toContain(excluded)
		}
		expect(labels).toContain("E9")
		expect(labels).toContain("V4")
	})

	it("includes both edges of an inclusive UTC day", () => {
		expect(expectedLabels(spec("utc-day"))).toEqual(["E4", "E3", "E2"])
		expect(expectedLabels(spec("iso-edges"))).toEqual(["E4", "E3", "E2"])
	})

	it("computes day offsets from fixed zone offsets", () => {
		expect(expectedLabels(spec("tz-tokyo"))).toEqual(["E9", "E8"])
		expect(expectedLabels(spec("tz-kolkata"))).toEqual(["E5", "E4"])
		expect(expectedLabels(spec("tz-los-angeles"))).toEqual(["E2", "E1"])
	})

	it("treats the daylight-saving day as 23 hours", () => {
		expect(expectedLabels(spec("tz-la-dst-day"))).toEqual(["S3", "S2"])
		const window = zonedDayWindow("2026-03-08", -480, -420)
		expect(window).toEqual({
			start: "2026-03-08T08:00:00.000Z",
			end: "2026-03-09T06:59:59.999Z",
		})
	})

	it("moves validity edges with asOf", () => {
		expect(expectedLabels(spec("asof-early"))).toEqual([
			"V3",
			"V1",
			"E7",
			"E6",
			"E5",
			"E4",
			"E3",
			"E2",
			"E1",
			"S4",
			"S3",
			"S2",
			"S1",
		])
	})

	it("applies the limit after ordering and returns nothing for an inverted window", () => {
		expect(expectedLabels(spec("limit-3"))).toEqual(["E9", "E8", "V4"])
		expect(expectedLabels(spec("inverted-window"))).toEqual([])
	})

	it("uses a fixed fixture clock and fixed zone offsets", () => {
		expect(D_AS_OF).toBe("2026-03-20T12:00:00.000Z")
		expect(D_EVENTS.map((event) => event.label)).toHaveLength(19)
	})
})

const ids: Record<string, string> = Object.fromEntries(
	D_EVENTS.map((event) => [event.label, `ev-${event.label}`]),
)
const labelOf = (eventId: string) =>
	Object.entries(ids).find(([, value]) => value === eventId)?.[0]

function recallBody(labels: string[]) {
	return {
		results: labels.map((label) => ({
			citation: {
				eventId: ids[label],
				timestamp: D_EVENTS.find((event) => event.label === label)?.timestamp,
				preview: `body ${label}`,
			},
			matchType: "filter",
		})),
		metadata: {
			totalMatched: labels.length,
			filtersApplied: [],
			searchMethod: "standard",
		},
	}
}

function read(
	id: string,
	body: unknown,
	observation?: Observation,
): DQueryRead {
	const obs: Observation = observation ?? {
		kind: "response",
		route: "recallConversation",
		body,
	}
	return {
		queryId: id,
		observation: obs,
		health: evaluateRouteHealth("recallConversation", obs),
		request: { queryId: id },
	}
}

function cleanReads(): DQueryRead[] {
	return D_QUERIES.map((query) =>
		read(query.id, recallBody(expectedLabels(query))),
	)
}

function evaluate(reads: DQueryRead[], extra = {}) {
	return evaluateProbeD({
		reads,
		labelOf,
		acknowledged: D_EVENTS.map((event) => event.label),
		...extra,
	})
}

function caseOf(result: ReturnType<typeof evaluate>, id: string) {
	const found = result.cases.find((item) => item.caseId === id)
	if (!found) throw new Error(`missing ${id}`)
	return found
}

describe("evaluateProbeD", () => {
	it("passes when every recall query returns the exact expected sequence", () => {
		const result = evaluate(cleanReads())
		const nonPass = result.cases.filter(
			(item) =>
				item.outcome !== "pass" &&
				!item.caseId.includes("searchDetailed") &&
				!item.caseId.startsWith("D/relative/"),
		)
		expect(nonPass).toEqual([])
	})

	it("tags every case as judged on a code-derived contract", () => {
		const result = evaluate(cleanReads())
		expect(result.cases.length).toBeGreaterThan(10)
		for (const item of result.cases) {
			expect(item.contractBasis, item.caseId).toBe("code-derived")
		}
	})

	it("never passes while a relative-phrase family is a declared gap", () => {
		const result = evaluate(cleanReads())
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons.join(" ")).toContain("D/relative/day-offset")
	})

	it("fails on an out-of-window event and names the extra label", () => {
		const reads = cleanReads().map((item) =>
			item.queryId === "utc-day"
				? read("utc-day", recallBody(["E5", "E4", "E3", "E2"]))
				: item,
		)
		const failed = caseOf(evaluate(reads), "D/recall/utc-day")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("set-mismatch")
		expect(failed.detail).toMatchObject({ extra: ["E5"], missing: [] })
	})

	it("fails on a missing edge event", () => {
		const reads = cleanReads().map((item) =>
			item.queryId === "iso-edges"
				? read("iso-edges", recallBody(["E3", "E2"]))
				: item,
		)
		const failed = caseOf(evaluate(reads), "D/recall/iso-edges")
		expect(failed.predicate).toBe("set-mismatch")
		expect(failed.detail).toMatchObject({ missing: ["E4"] })
	})

	it("fails with an order predicate when the set is right but the order is not", () => {
		const reads = cleanReads().map((item) =>
			item.queryId === "full-window"
				? read(
						"full-window",
						recallBody([...expectedLabels(spec("full-window"))].reverse()),
					)
				: item,
		)
		const failed = caseOf(evaluate(reads), "D/recall/full-window")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("order-mismatch")
	})

	it("fails the tie order when the earlier insertion is returned first", () => {
		const labels = expectedLabels(spec("full-window")).map((label) =>
			label === "E7" ? "E6" : label === "E6" ? "E7" : label,
		)
		const reads = cleanReads().map((item) =>
			item.queryId === "full-window"
				? read("full-window", recallBody(labels))
				: item,
		)
		expect(caseOf(evaluate(reads), "D/recall/full-window").predicate).toBe(
			"tie-order-mismatch",
		)
	})

	it("fails when a returned event carries a different timestamp than the fixture", () => {
		const body = recallBody(expectedLabels(spec("limit-3")))
		;(
			body.results[0] as { citation: { timestamp: string } }
		).citation.timestamp = "2026-03-20T12:00:00.001Z"
		const reads = cleanReads().map((item) =>
			item.queryId === "limit-3" ? read("limit-3", body) : item,
		)
		const failed = caseOf(evaluate(reads), "D/recall/limit-3")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("timestamp-mismatch")
	})

	it("fails an unknown event id as a set mismatch with an unknown label", () => {
		const body = recallBody(["E4", "E3", "E2"])
		body.results.push({
			citation: { eventId: "ev-other", timestamp: D_AS_OF, preview: "x" },
			matchType: "filter",
		})
		const reads = cleanReads().map((item) =>
			item.queryId === "utc-day" ? read("utc-day", body) : item,
		)
		const failed = caseOf(evaluate(reads), "D/recall/utc-day")
		expect(failed.predicate).toBe("set-mismatch")
		expect(failed.detail).toMatchObject({ extra: ["unknown"] })
	})

	it("fails a duplicated event even when the set is right", () => {
		const body = recallBody(["E4", "E3", "E2"])
		body.results.push(body.results[2] as (typeof body.results)[number])
		const reads = cleanReads().map((item) =>
			item.queryId === "utc-day" ? read("utc-day", body) : item,
		)
		expect(caseOf(evaluate(reads), "D/recall/utc-day").predicate).toBe(
			"duplicate-result",
		)
	})

	it("is inconclusive when a result carries no citation or no timestamp", () => {
		const noCitation = recallBody(["E4", "E3", "E2"])
		;(noCitation.results as unknown[])[0] = { matchType: "filter" }
		const noTimestamp = recallBody(["E9", "E8", "V4"])
		delete (noTimestamp.results[1] as { citation: { timestamp?: string } })
			.citation.timestamp
		const reads = cleanReads().map((item) =>
			item.queryId === "utc-day"
				? read("utc-day", noCitation)
				: item.queryId === "limit-3"
					? read("limit-3", noTimestamp)
					: item,
		)
		const result = evaluate(reads)
		expect(caseOf(result, "D/recall/utc-day").outcome).toBe("inconclusive")
		expect(caseOf(result, "D/recall/limit-3").reason).toMatch(
			/citation timestamp/,
		)
	})

	it("passes an empty inverted window and fails when it returns anything", () => {
		const reads = cleanReads().map((item) =>
			item.queryId === "inverted-window"
				? read("inverted-window", recallBody(["E5"]))
				: item,
		)
		const failed = caseOf(evaluate(reads), "D/recall/inverted-window")
		expect(failed.predicate).toBe("set-mismatch")
		expect(
			caseOf(evaluate(cleanReads()), "D/recall/inverted-window").outcome,
		).toBe("pass")
	})

	it("is inconclusive when the recall response is unhealthy or an error", () => {
		const reads = cleanReads().map((item) =>
			item.queryId === "tz-tokyo"
				? read("tz-tokyo", null, {
						kind: "http-error",
						route: "recallConversation",
						status: 400,
						code: "VALIDATION_ERROR",
					})
				: item,
		)
		const result = caseOf(evaluate(reads), "D/recall/tz-tokyo")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toMatch(/http-400/)
	})

	it("is inconclusive when a fixture event was never acknowledged", () => {
		const result = evaluate(cleanReads(), {
			acknowledged: D_EVENTS.map((event) => event.label).filter(
				(label) => label !== "E4",
			),
		})
		const utc = caseOf(result, "D/recall/utc-day")
		expect(utc.outcome).toBe("inconclusive")
		expect(utc.reason).toMatch(/fixture-not-acknowledged:E4/)
	})

	it("marks the control ineligible when the full-window query did not pass", () => {
		const reads = cleanReads().map((item) =>
			item.queryId === "full-window"
				? read("full-window", recallBody(["E9"]))
				: item,
		)
		const result = evaluate(reads)
		expect(caseOf(result, "D/recall/full-window").outcome).toBe("fail")
		const other = result.cases.find(
			(item) => item.caseId === "D/recall/tz-tokyo",
		)
		expect(other?.controlEligible).toBe(false)
	})

	it("requires every query to have run", () => {
		const result = evaluate(cleanReads().slice(1))
		expect(result.outcome).not.toBe("pass")
		expect(result.reasons.join(" ")).toContain("D/recall/full-window")
	})

	it("derives required ids from the query table and lists coverage gaps", () => {
		const required = requiredCaseIdsD()
		expect(required).toContain("D/recall/full-window")
		expect(required).toContain("D/searchDetailed/timeRange")
		expect(required).toContain("D/relative/yesterday")
		expect(required).toContain("D/relative/day-offset")
		expect(D_GAPS.map((gap) => gap.route)).toEqual([
			"recall-with-query",
			"searchDetailed-ordering",
		])
		expect(PROBE_D_RULE).toMatch(/exact sequence/)
		expect(PROBE_D_RULE).toMatch(/text-lane ranks/)
		expect(PROBE_D_RULE).toMatch(/declared gaps that stay inconclusive/)
		expect(PROBE_D_VERSION).toBe("D-2")
	})
})

describe("evaluateProbeD searchDetailed membership", () => {
	const inWindow = ["E2", "E3", "E4"]
	function detailed(
		labels: string[],
		extra: Partial<DQueryRead> = {},
	): DQueryRead {
		const obs: Observation = {
			kind: "response",
			route: "searchDetailed",
			body: {
				results: labels.map((label) => ({
					snippet: `D-event <${label}>`,
				})),
				metadata: { outcomeStatus: "complete", laneOutcomes: [] },
			},
		}
		return {
			queryId: "timeRange",
			observation: obs,
			health: evaluateRouteHealth("searchDetailed", obs),
			request: { queryId: "timeRange" },
			...extra,
		}
	}
	const markers = Object.fromEntries(
		D_EVENTS.map((event) => [event.label, `<${event.label}>`]),
	)
	const everything = D_EVENTS.map((event) => event.label)

	function run(read: DQueryRead, control: DQueryRead = detailed(everything)) {
		return evaluateProbeD({
			reads: cleanReads(),
			labelOf,
			acknowledged: D_EVENTS.map((event) => event.label),
			detailed: { read, control, markers },
		})
	}

	it("passes when only in-window events are returned and at least one is", () => {
		expect(
			caseOf(run(detailed(inWindow)), "D/searchDetailed/timeRange").outcome,
		).toBe("pass")
	})

	it("fails when an out-of-window event is returned", () => {
		const failed = caseOf(
			run(detailed(["E3", "E5"])),
			"D/searchDetailed/timeRange",
		)
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("out-of-window-returned")
	})

	it("is inconclusive when nothing in the window was returned", () => {
		expect(
			caseOf(run(detailed([])), "D/searchDetailed/timeRange").outcome,
		).toBe("inconclusive")
	})

	it("is inconclusive when the unconstrained control never returned an out-of-window event", () => {
		const result = caseOf(
			run(detailed(inWindow), detailed(inWindow)),
			"D/searchDetailed/timeRange",
		)
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("no-out-of-window-control")
	})

	it("still fails a leak when the control is missing but marks it ineligible", () => {
		const failed = caseOf(
			run(detailed(["E3", "E5"]), detailed(inWindow)),
			"D/searchDetailed/timeRange",
		)
		expect(failed.outcome).toBe("fail")
		expect(failed.controlEligible).toBe(false)
	})

	it("does not match a shorter marker inside a longer one", () => {
		const result = caseOf(
			run(detailed(["E3", "E10"])),
			"D/searchDetailed/timeRange",
		)
		expect(result.detail).toMatchObject({ outside: ["E10"] })
	})

	it("is inconclusive when the detailed response was partial", () => {
		const obs: Observation = {
			kind: "response",
			route: "searchDetailed",
			body: {
				results: [{ snippet: "<E5>" }],
				metadata: {
					outcomeStatus: "partial",
					laneOutcomes: [
						{
							lane: "vector",
							stage: "x",
							outcome: "failed",
							reason: "query-timeout",
						},
					],
				},
			},
		}
		const partial: DQueryRead = {
			queryId: "timeRange",
			observation: obs,
			health: evaluateRouteHealth("searchDetailed", obs),
			request: {},
		}
		const result = caseOf(run(partial), "D/searchDetailed/timeRange")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toMatch(/outcomes:partial|lane-failed/)
	})
})
