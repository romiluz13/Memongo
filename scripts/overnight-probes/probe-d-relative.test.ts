import { describe, expect, it } from "vitest"
import { evaluateRouteHealth } from "./health.ts"
import {
	D_AS_OF,
	D_EVENTS,
	type DQueryRead,
	eligibleLabels,
} from "./probe-d-fixture.ts"
import {
	D_RELATIVE,
	D_RELATIVE_BASE_QUERY,
	D_RELATIVE_MIN_GAP_MS,
	D_RELATIVE_UNSUPPORTED,
	relativeCaseIds,
	relativeCases,
	relativeLabels,
} from "./probe-d-relative.ts"
import type { Observation } from "./types.ts"

const ALL = D_EVENTS.map((item) => item.label)
const labelOf = (eventId: string) =>
	D_EVENTS.find((item) => `ev-${item.label}` === eventId)?.label

type Options = {
	searchMethod?: string
	omitDetails?: boolean
	textRank?: (index: number) => unknown
	observation?: Observation
}

function hybridRead(
	queryId: string,
	ranked: readonly string[],
	options: Options = {},
): DQueryRead {
	const body = {
		results: ranked.map((label, index) => ({
			citation: {
				eventId: `ev-${label}`,
				timestamp: D_EVENTS.find((item) => item.label === label)?.timestamp,
				preview: `body ${label}`,
			},
			matchType: "hybrid",
			...(options.omitDetails
				? {}
				: {
						scoreDetails: {
							value: 0.03,
							details: [
								{
									inputPipelineName: "vector",
									rank: 7,
									weight: 1,
									value: 0.01,
								},
								{
									inputPipelineName: "text",
									rank: options.textRank ? options.textRank(index) : index + 1,
									weight: 1,
									value: 0.01,
								},
							],
						},
					}),
		})),
		metadata: {
			totalMatched: ranked.length,
			filtersApplied: [],
			searchMethod: options.searchMethod ?? "hybrid",
		},
	}
	const observation: Observation = options.observation ?? {
		kind: "response",
		route: "recallConversation",
		body,
	}
	return {
		queryId,
		observation,
		health: evaluateRouteHealth("recallConversation", observation),
		request: { queryId },
	}
}

function proximityOrder(origin: string): string[] {
	const at = Date.parse(origin)
	const eligible = eligibleLabels(D_AS_OF)
	return eligible
		.map((label, index) => ({
			label,
			index,
			distance: Math.abs(
				Date.parse(
					D_EVENTS.find((item) => item.label === label)?.timestamp ?? "",
				) - at,
			),
		}))
		.sort(
			(left, right) =>
				left.distance - right.distance || left.index - right.index,
		)
		.map((item) => item.label)
}

const insertionOrder = eligibleLabels(D_AS_OF)

function evaluate(
	reads: Record<string, DQueryRead>,
	control: DQueryRead = hybridRead("relative/control", insertionOrder),
	acknowledged: readonly string[] = ALL,
) {
	return relativeCases({
		control,
		reads: Object.values(reads),
		labelOf,
		acknowledged,
	})
}

function phraseReads(order: (origin: string) => string[] = proximityOrder) {
	return Object.fromEntries(
		D_RELATIVE.map((item) => [
			item.id,
			hybridRead(`relative/${item.id}`, order(item.origin)),
		]),
	)
}

function caseOf(cases: ReturnType<typeof evaluate>, id: string) {
	const found = cases.find((item) => item.caseId === `D/relative/${id}`)
	if (!found) throw new Error(`missing ${id}`)
	return found
}

describe("D relative-phrase oracle (hand-resolved from the fixture clock)", () => {
	it("resolves each phrase to the origin the engine documents for it", () => {
		const origin = (id: string) =>
			new Date(D_RELATIVE.find((item) => item.id === id)?.origin ?? "")
		expect(new Date(D_AS_OF).getUTCDay()).toBe(5)
		for (const id of ["this-week", "last-week"]) {
			expect(origin(id).getUTCDay(), id).toBe(1)
		}
		for (const id of ["this-month", "last-month"]) {
			expect(origin(id).getUTCDate(), id).toBe(1)
		}
		for (const item of D_RELATIVE) {
			expect(item.origin.endsWith("T00:00:00.000Z"), item.id).toBe(true)
		}
		expect(origin("yesterday").getTime()).toBe(
			origin("today").getTime() - 86_400_000,
		)
		expect(origin("this-week").getTime()).toBe(
			origin("last-week").getTime() + 7 * 86_400_000,
		)
		expect(origin("this-month").getUTCMonth()).toBe(2)
		expect(origin("last-month").getUTCMonth()).toBe(1)
	})

	it("lists fourteen eligible events and a fixed ranking floor between compared pairs", () => {
		expect(eligibleLabels(D_AS_OF)).toHaveLength(14)
		expect(D_RELATIVE_MIN_GAP_MS).toBe(3_600_000)
		expect(D_RELATIVE_BASE_QUERY).toBe("Dated archive log entry")
	})

	it("derives one required id per supported phrase and per declared gap", () => {
		expect(relativeCaseIds()).toEqual([
			...D_RELATIVE.map((item) => `D/relative/${item.id}`),
			...D_RELATIVE_UNSUPPORTED.map((item) => `D/relative/${item.id}`),
		])
		expect(relativeCaseIds()).toHaveLength(9)
	})
})

describe("relativeCases passing and failing", () => {
	it("passes every supported phrase when the text lane ranks events by distance from the resolved origin", () => {
		const cases = evaluate(phraseReads())
		for (const item of D_RELATIVE) {
			const found = caseOf(cases, item.id)
			expect(found.outcome, item.id).toBe("pass")
			expect(found.controlEligible).toBe(true)
			expect(
				(found.detail as { discriminating: number }).discriminating,
			).toBeGreaterThan(0)
		}
	})

	it("fails when the text lane keeps the unphrased order, as if the phrase were ignored", () => {
		const cases = evaluate(phraseReads(() => insertionOrder))
		const found = caseOf(cases, "yesterday")
		expect(found.outcome).toBe("fail")
		expect(found.predicate).toBe("relative-origin-not-applied")
		expect(found.controlEligible).toBe(true)
		expect(found.evidence?.request).toEqual({ queryId: "relative/yesterday" })
		expect(found.evidence?.response).toBeDefined()
		const detail = found.detail as { violations: unknown[]; origin: string }
		expect(detail.violations.length).toBeGreaterThan(0)
		expect(detail.origin).toBe("2026-03-19T00:00:00.000Z")
	})

	it("fails when the phrase was resolved against a different clock than asOf", () => {
		const wallClock = "2026-10-19T00:00:00.000Z"
		const cases = evaluate(phraseReads(() => proximityOrder(wallClock)))
		expect(caseOf(cases, "yesterday").outcome).toBe("fail")
		expect(caseOf(cases, "last-week").outcome).toBe("fail")
	})

	it("does not compare events less than an hour apart", () => {
		const swapped = proximityOrder(D_RELATIVE[0]?.origin ?? "")
		const first = swapped.indexOf("E6")
		const second = swapped.indexOf("E7")
		;[swapped[first], swapped[second]] = [
			swapped[second] as string,
			swapped[first] as string,
		]
		const cases = evaluate({
			...phraseReads(),
			yesterday: hybridRead("relative/yesterday", swapped),
		})
		expect(caseOf(cases, "yesterday").outcome).toBe("pass")
	})

	it("ignores events the engine returned that are not valid at asOf", () => {
		const withInvalid = [
			...proximityOrder(D_RELATIVE[0]?.origin ?? ""),
			"V1",
			"T1",
		]
		const cases = evaluate({
			...phraseReads(),
			yesterday: hybridRead("relative/yesterday", withInvalid),
		})
		expect(caseOf(cases, "yesterday").outcome).toBe("pass")
	})
})

describe("relativeCases inconclusive paths", () => {
	it("is inconclusive when the unphrased order already follows proximity", () => {
		const control = hybridRead(
			"relative/control",
			proximityOrder(D_RELATIVE[0]?.origin ?? ""),
		)
		const found = caseOf(evaluate(phraseReads(), control), "yesterday")
		expect(found.outcome).toBe("inconclusive")
		expect(found.reason).toBe("no-discriminating-pair")
	})

	it("is inconclusive when the recall was not a hybrid recall", () => {
		const cases = evaluate({
			...phraseReads(),
			today: hybridRead(
				"relative/today",
				proximityOrder(D_RELATIVE[1]?.origin ?? ""),
				{
					searchMethod: "standard",
				},
			),
		})
		expect(caseOf(cases, "today").reason).toBe("unassessable:not-hybrid")
	})

	it("is inconclusive when rows carry no score details", () => {
		const cases = evaluate({
			...phraseReads(),
			today: hybridRead("relative/today", insertionOrder, {
				omitDetails: true,
			}),
		})
		expect(caseOf(cases, "today").reason).toBe(
			"unassessable:fewer-than-two-text-ranks",
		)
	})

	it("does not count a missing or non-numeric text-lane rank", () => {
		const cases = evaluate({
			...phraseReads(),
			today: hybridRead("relative/today", insertionOrder, {
				textRank: () => null,
			}),
		})
		expect(caseOf(cases, "today").reason).toBe(
			"unassessable:fewer-than-two-text-ranks",
		)
	})

	it("is inconclusive when the control read was unusable", () => {
		const control = hybridRead("relative/control", insertionOrder, {
			observation: {
				kind: "http-error",
				route: "recallConversation",
				status: 503,
				code: "SEARCH_LANES_UNAVAILABLE",
			},
		})
		const found = caseOf(evaluate(phraseReads(), control), "yesterday")
		expect(found.outcome).toBe("inconclusive")
		expect(found.reason).toBe("unevaluable-control")
		expect(found.controlEligible).toBe(false)
	})

	it("is inconclusive when the phrase read was an error", () => {
		const cases = evaluate({
			...phraseReads(),
			today: hybridRead("relative/today", [], {
				observation: {
					kind: "http-error",
					route: "recallConversation",
					status: 500,
					code: "RECALL_CONVERSATION_FAILED",
				},
			}),
		})
		const found = caseOf(cases, "today")
		expect(found.outcome).toBe("inconclusive")
		expect(found.reason).toMatch(/^unevaluable:/)
	})

	it("is inconclusive when a fixture event was never acknowledged", () => {
		const cases = evaluate(
			phraseReads(),
			undefined,
			ALL.filter((label) => label !== "E8"),
		)
		expect(caseOf(cases, "yesterday").reason).toBe(
			"fixture-not-acknowledged:E8",
		)
	})

	it("returns no case for a phrase whose read never happened", () => {
		const reads = phraseReads()
		delete reads["last-month"]
		const ids = evaluate(reads).map((item) => item.caseId)
		expect(ids).not.toContain("D/relative/last-month")
		expect(ids).toContain("D/relative/yesterday")
	})
})

describe("relativeCases declared gaps", () => {
	it("keeps every unsupported phrase family inconclusive, never a pass", () => {
		const cases = evaluate(phraseReads())
		for (const gap of D_RELATIVE_UNSUPPORTED) {
			const found = caseOf(cases, gap.id)
			expect(found.outcome, gap.id).toBe("inconclusive")
			expect(found.reason).toMatch(/^declared-gap:/)
			expect(found.controlEligible).toBe(false)
		}
		expect(D_RELATIVE_UNSUPPORTED.map((gap) => gap.id)).toEqual(
			expect.arrayContaining(["day-offset"]),
		)
	})

	it("keeps the gap cases when no relative read happened at all", () => {
		const cases = relativeCases(undefined)
		expect(cases.map((item) => item.caseId)).toEqual(
			D_RELATIVE_UNSUPPORTED.map((gap) => `D/relative/${gap.id}`),
		)
	})
})

describe("relativeLabels", () => {
	it("maps returned rows to fixture labels and skips rows it cannot label", () => {
		const read = hybridRead("x", ["E1", "E2"])
		expect(relativeLabels(read, labelOf)).toEqual(["E1", "E2"])
		const unknown = relativeLabels(read, () => undefined)
		expect(unknown).toEqual([])
	})
})
