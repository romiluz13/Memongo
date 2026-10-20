import { describe, expect, it } from "vitest"
import { evaluateRouteHealth } from "./health.ts"
import {
	classifyRead,
	E_BARRIER_N,
	E_DEADLINE_MS,
	E_PRIMARY_N,
	type EControl,
	type EItem,
	type EPoll,
	evaluateProbeE,
	PROBE_E_RULE,
	PROBE_E_VERSION,
	requiredCaseIdsE,
} from "./probe-e-model.ts"
import type { Observation } from "./types.ts"

type Kind =
	| "visible"
	| "empty"
	| "degraded"
	| "not-ready"
	| "error"
	| "http-not-ready"

function poll(atMs: number, kind: Kind, marker = "zqe"): EPoll {
	let observation: Observation
	switch (kind) {
		case "visible":
			observation = {
				kind: "response",
				route: "search",
				body: {
					results: [{ snippet: `shelf holds ${marker}` }],
					outcomes: { status: "complete", lanes: [] },
				},
			}
			break
		case "empty":
			observation = {
				kind: "response",
				route: "search",
				body: { results: [], outcomes: { status: "complete", lanes: [] } },
			}
			break
		case "degraded":
			observation = {
				kind: "response",
				route: "search",
				body: {
					results: [],
					outcomes: {
						status: "partial",
						lanes: [
							{
								lane: "vector",
								stage: "retrieve",
								outcome: "failed",
								reason: "query-timeout",
							},
						],
					},
				},
			}
			break
		case "not-ready":
			observation = {
				kind: "response",
				route: "search",
				body: {
					results: [],
					outcomes: {
						status: "partial",
						lanes: [
							{
								lane: "vector",
								stage: "retrieve",
								outcome: "failed",
								reason: "index-not-ready",
							},
						],
					},
				},
			}
			break
		case "http-not-ready":
			observation = {
				kind: "http-error",
				route: "search",
				status: 503,
				code: "SEARCH_LANES_UNAVAILABLE",
			}
			break
		case "error":
			observation = { kind: "http-error", route: "search", status: 500 }
			break
	}
	return {
		atMs,
		observation,
		health: evaluateRouteHealth("search", observation),
		request: { route: "search" },
	}
}

function visibleAfter(
	index: number,
	variant: EItem["variant"],
	steps: number,
	dispatchAt = 0,
): EItem {
	const polls: EPoll[] = []
	for (let step = 0; step < steps; step += 1) {
		polls.push(poll(dispatchAt + step * 1_000, "empty", `m${index}`))
	}
	polls.push(poll(dispatchAt + steps * 1_000, "visible", `m${index}`))
	return {
		variant,
		index,
		marker: `m${index}`,
		dispatchAt,
		ackAt: dispatchAt + 20,
		ack: { ok: true },
		polls,
	}
}

function neverVisible(
	index: number,
	finalKind: Kind,
	untilMs = E_DEADLINE_MS,
): EItem {
	const polls: EPoll[] = []
	for (let at = 0; at < untilMs; at += 1_000)
		polls.push(poll(at, "empty", `m${index}`))
	polls.push(poll(untilMs, finalKind, `m${index}`))
	return {
		variant: "primary",
		index,
		marker: `m${index}`,
		dispatchAt: 0,
		ackAt: 20,
		ack: { ok: true },
		polls,
	}
}

function barrierItem(index: number, status: string, firstKind: Kind): EItem {
	return {
		variant: "barrier",
		index,
		marker: `b${index}`,
		dispatchAt: 0,
		ackAt: 300,
		ack: { ok: true, barrier: { status } },
		polls: [poll(300, firstKind, `b${index}`)],
	}
}

const control: EControl = {
	marker: "zqe",
	start: poll(0, "visible"),
	end: poll(90_000, "visible"),
}

function cleanItems(): EItem[] {
	return [
		...Array.from({ length: E_PRIMARY_N }, (_v, i) =>
			visibleAfter(i + 1, "primary", 2 + (i % 3)),
		),
		...Array.from({ length: E_BARRIER_N }, (_v, i) =>
			barrierItem(i + 1, "searchable", "visible"),
		),
	]
}

function evaluate(items: EItem[], ctl: EControl = control) {
	return evaluateProbeE({ control: ctl, items })
}

function caseOf(result: ReturnType<typeof evaluate>, caseId: string) {
	const found = result.cases.find((item) => item.caseId === caseId)
	if (!found) throw new Error(`missing ${caseId}`)
	return found
}

describe("classifyRead", () => {
	it("separates visible, silent empty, degraded empty, explicit not-ready and error reads", () => {
		expect(classifyRead(poll(0, "visible"), "zqe")).toBe("visible")
		expect(classifyRead(poll(0, "empty"), "zqe")).toBe("empty-silent")
		expect(classifyRead(poll(0, "degraded"), "zqe")).toBe(
			"empty-with-degradation",
		)
		expect(classifyRead(poll(0, "not-ready"), "zqe")).toBe("explicit-not-ready")
		expect(classifyRead(poll(0, "http-not-ready"), "zqe")).toBe(
			"explicit-not-ready",
		)
		expect(classifyRead(poll(0, "error"), "zqe")).toBe("error")
	})

	it("does not count a marker seen on a degraded read as a healthy visible read", () => {
		const degraded = poll(0, "degraded")
		const withMarker: EPoll = {
			...degraded,
			observation: {
				kind: "response",
				route: "search",
				body: {
					results: [{ snippet: "zqe" }],
					outcomes: { status: "partial", lanes: [] },
				},
			},
		}
		const evaluated = {
			...withMarker,
			health: evaluateRouteHealth("search", withMarker.observation),
		}
		expect(classifyRead(evaluated, "zqe")).toBe("degraded-visible")
	})

	it("labels a transport error as an error", () => {
		const observation: Observation = {
			kind: "transport-error",
			route: "search",
			message: "ECONNRESET",
		}
		expect(
			classifyRead(
				{
					atMs: 0,
					observation,
					health: evaluateRouteHealth("search", observation),
					request: {},
				},
				"zqe",
			),
		).toBe("error")
	})
})

describe("evaluateProbeE", () => {
	it("passes when every item becomes visible and records sampled intervals", () => {
		const result = evaluate(cleanItems())
		expect(result.outcome).toBe("pass")
		const interval = result.metrics.primary.intervals.find(
			(entry) => entry.index === 1,
		)
		expect(interval).toEqual({ index: 1, lowerMs: 1_000, upperMs: 2_000 })
		expect(result.metrics.primary.observed).toBe(E_PRIMARY_N)
		expect(result.metrics.primary.censored).toBe(0)
		expect(result.metrics.primary.n).toBe(E_PRIMARY_N)
	})

	it("uses a lower bound of zero when the first read was already visible", () => {
		const items = cleanItems()
		items[0] = visibleAfter(1, "primary", 0)
		const result = evaluate(items)
		expect(result.metrics.primary.intervals[0]).toEqual({
			index: 1,
			lowerMs: 0,
			upperMs: 0,
		})
	})

	it("ignores unhealthy reads when bounding the lower side of the interval", () => {
		const items = cleanItems()
		const item = visibleAfter(1, "primary", 4)
		items[0] = {
			...item,
			polls: item.polls.map((p, i) =>
				i === 2 || i === 3 ? poll(p.atMs, "degraded", "m1") : p,
			),
		}
		const result = evaluate(items)
		expect(result.metrics.primary.intervals[0]).toEqual({
			index: 1,
			lowerMs: 1_000,
			upperMs: 4_000,
		})
	})

	it("fails an item that stays healthy-empty past the deadline when the control is healthy", () => {
		const items = cleanItems()
		items[3] = neverVisible(4, "empty")
		const result = evaluate(items)
		const missing = caseOf(result, "E/primary/item-4")
		expect(missing.outcome).toBe("fail")
		expect(missing.predicate).toBe("never-visible-within-60s")
		expect(missing.controlEligible).toBe(true)
		expect(missing.evidence?.response).toBeDefined()
		expect(result.metrics.primary.censored).toBe(1)
		expect(result.metrics.primary.observed).toBe(E_PRIMARY_N - 1)
		expect(result.outcome).toBe("fail")
	})

	it("is inconclusive for a censored item whose final read was degraded", () => {
		const items = cleanItems()
		items[3] = neverVisible(4, "degraded")
		const missing = caseOf(evaluate(items), "E/primary/item-4")
		expect(missing.outcome).toBe("inconclusive")
		expect(missing.reason).toMatch(/final-read-unhealthy/)
	})

	it("is inconclusive when polling stopped before the deadline", () => {
		const items = cleanItems()
		items[3] = neverVisible(4, "empty", 30_000)
		const early = caseOf(evaluate(items), "E/primary/item-4")
		expect(early.outcome).toBe("inconclusive")
		expect(early.reason).toMatch(/deadline-not-reached/)
	})

	it("makes a never-visible item inconclusive when the control read failed", () => {
		const items = cleanItems()
		items[3] = neverVisible(4, "empty")
		const bad: EControl = { ...control, start: poll(0, "empty") }
		const result = evaluate(items, bad)
		const missing = caseOf(result, "E/primary/item-4")
		expect(missing.outcome).toBe("inconclusive")
		expect(missing.reason).toMatch(/control-not-established/)
		expect(caseOf(result, "E/control").outcome).toBe("inconclusive")
	})

	it("still passes a visible item when the control failed, because visibility is positive evidence", () => {
		const bad: EControl = { ...control, end: poll(90_000, "error") }
		const result = evaluate(cleanItems(), bad)
		expect(caseOf(result, "E/primary/item-1").outcome).toBe("pass")
		expect(caseOf(result, "E/control").outcome).toBe("inconclusive")
		expect(result.outcome).toBe("inconclusive")
	})

	it("counts pre-visible read classes separately", () => {
		const items = cleanItems()
		const base = visibleAfter(2, "primary", 5)
		items[1] = {
			...base,
			polls: [
				poll(0, "empty", "m2"),
				poll(1_000, "degraded", "m2"),
				poll(2_000, "not-ready", "m2"),
				poll(3_000, "http-not-ready", "m2"),
				poll(4_000, "error", "m2"),
				poll(5_000, "visible", "m2"),
			],
		}
		const result = evaluate(items)
		expect(result.metrics.classes["empty-silent"]).toBeGreaterThanOrEqual(1)
		expect(result.metrics.classes["empty-with-degradation"]).toBe(1)
		expect(result.metrics.classes["explicit-not-ready"]).toBe(2)
		expect(result.metrics.classes.error).toBe(1)
	})

	it("is inconclusive when the write was not acknowledged", () => {
		const items = cleanItems()
		items[0] = {
			...(items[0] as EItem),
			ack: { ok: false, reason: "http-503" },
		}
		expect(caseOf(evaluate(items), "E/primary/item-1").outcome).toBe(
			"inconclusive",
		)
	})

	it("is inconclusive when a required case was never executed", () => {
		const result = evaluate(cleanItems().slice(1))
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons.join(" ")).toContain("E/primary/item-1")
	})

	it("derives the required ids from the fixed sample sizes", () => {
		const ids = requiredCaseIdsE()
		expect(ids).toHaveLength(1 + E_PRIMARY_N + E_BARRIER_N)
		expect(ids).toContain("E/control")
		expect(ids).toContain("E/barrier/item-1")
	})

	it("prints the rule and version", () => {
		expect(PROBE_E_RULE).toMatch(/60 s/)
		expect(PROBE_E_VERSION).toBe("E-1")
	})
})

describe("evaluateProbeE barrier variant", () => {
	it("passes when a searchable barrier is followed by a visible first read", () => {
		const result = evaluate(cleanItems())
		expect(caseOf(result, "E/barrier/item-1").outcome).toBe("pass")
	})

	it("fails when the barrier says searchable but the first healthy read is empty", () => {
		const items = cleanItems()
		items[E_PRIMARY_N] = barrierItem(1, "searchable", "empty")
		const lie = caseOf(evaluate(items), "E/barrier/item-1")
		expect(lie.outcome).toBe("fail")
		expect(lie.predicate).toBe("barrier-searchable-but-invisible")
	})

	it("is inconclusive when the barrier did not confirm", () => {
		const items = cleanItems()
		items[E_PRIMARY_N] = barrierItem(1, "not-yet-searchable", "empty")
		const result = caseOf(evaluate(items), "E/barrier/item-1")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toMatch(/barrier-not-yet-searchable/)
	})

	it("is inconclusive when the first read after a searchable barrier was unhealthy", () => {
		const items = cleanItems()
		items[E_PRIMARY_N] = barrierItem(1, "searchable", "degraded")
		expect(caseOf(evaluate(items), "E/barrier/item-1").outcome).toBe(
			"inconclusive",
		)
	})

	it("keeps the barrier measurements out of the primary statistics", () => {
		const result = evaluate(cleanItems())
		expect(result.metrics.primary.n).toBe(E_PRIMARY_N)
		expect(result.metrics.barrier.n).toBe(E_BARRIER_N)
	})
})
