import { describe, expect, it } from "vitest"
import { evaluateRouteHealth } from "./health.ts"
import {
	classifySearch,
	classifyWrite,
	type FKillFacts,
	type FPhaseFacts,
	F_DURATION_MS,
	F_MAX_ERROR_RATE,
	F_PACE_MS,
	F_PHASES,
	F_SEARCHERS,
	F_TICKS,
	evaluateLoadPhase,
	evaluateProbeF,
	PROBE_F_RULE,
	PROBE_F_VERSION,
	requiredCaseIdsF,
	summarizeLatencies,
} from "./probe-f-model.ts"
import type { Observation } from "./types.ts"

function phase(overrides: Partial<FPhaseFacts> = {}): FPhaseFacts {
	const writers = overrides.writers ?? 20
	const scheduledWrites = writers * F_TICKS
	const scheduledSearches = F_SEARCHERS * F_TICKS
	return {
		variant: writers === 20 ? "w20" : "w50",
		writers,
		searchers: F_SEARCHERS,
		durationMs: F_DURATION_MS,
		elapsedMs: F_DURATION_MS,
		startedWriters: writers,
		startedSearchers: F_SEARCHERS,
		scheduledWrites,
		scheduledSearches,
		writes: {
			attempted: scheduledWrites,
			acked: scheduledWrites,
			backpressure: 0,
			errors: 0,
			latenciesMs: [20, 30, 40],
		},
		searches: {
			attempted: scheduledSearches,
			healthy: scheduledSearches,
			healthyMissingControl: 0,
			degraded: 0,
			backpressure: 0,
			errors: 0,
			latenciesMs: [50, 60],
		},
		controlSeeded: true,
		verification: {
			statusTrusted: true,
			eventsCount: scheduledWrites + 1,
			sampled: 10,
			sampledFound: 10,
			sampledUnverified: 0,
		},
		...overrides,
	}
}

describe("fixed schedule", () => {
	it("fixes the workloads before any run", () => {
		expect(F_DURATION_MS).toBe(60_000)
		expect(F_PACE_MS).toBe(2_000)
		expect(F_TICKS).toBe(30)
		expect(F_SEARCHERS).toBe(20)
		expect(F_PHASES.map((item) => item.writers)).toEqual([20, 50])
		expect(F_MAX_ERROR_RATE).toBe(0.01)
	})
})

describe("classifyWrite", () => {
	const response = (body: unknown): Observation => ({
		kind: "response",
		route: "writeEvent",
		body,
	})
	it("separates an acknowledgment, backpressure and an error", () => {
		expect(classifyWrite(response({ ok: true, eventId: "e" }))).toBe("acked")
		expect(classifyWrite(response({ ok: true }))).toBe("error")
		expect(
			classifyWrite({ kind: "http-error", route: "writeEvent", status: 429 }),
		).toBe("backpressure")
		expect(
			classifyWrite({
				kind: "http-error",
				route: "writeEvent",
				status: 503,
				code: "SEARCH_ADMISSION_THROTTLED",
			}),
		).toBe("backpressure")
		expect(
			classifyWrite({ kind: "http-error", route: "writeEvent", status: 500 }),
		).toBe("error")
		expect(
			classifyWrite({
				kind: "transport-error",
				route: "writeEvent",
				message: "x",
			}),
		).toBe("error")
	})
})

describe("classifySearch", () => {
	const marker = "zqfctl"
	const ok = (
		snippet: string,
		extra: Record<string, unknown> = {},
	): Observation => ({
		kind: "response",
		route: "search",
		body: {
			results: [{ snippet }],
			outcomes: { status: "complete", lanes: [] },
			...extra,
		},
	})
	const classify = (observation: Observation) =>
		classifySearch(
			observation,
			evaluateRouteHealth("search", observation),
			marker,
		)

	it("calls a healthy read with the control healthy and without it a silent miss", () => {
		expect(classify(ok(`entry ${marker}`))).toBe("healthy")
		expect(classify(ok("something else"))).toBe("healthy-missing-control")
	})

	it("keeps degraded, throttled and failed reads apart", () => {
		expect(
			classify({
				kind: "response",
				route: "search",
				body: { results: [], outcomes: { status: "partial", lanes: [] } },
			}),
		).toBe("degraded")
		expect(
			classify({
				kind: "response",
				route: "search",
				body: { results: [], degradation: { kind: "throttled" } },
			}),
		).toBe("backpressure")
		expect(classify({ kind: "http-error", route: "search", status: 429 })).toBe(
			"backpressure",
		)
		expect(classify({ kind: "http-error", route: "search", status: 500 })).toBe(
			"error",
		)
		expect(
			classify({ kind: "transport-error", route: "search", message: "x" }),
		).toBe("error")
	})
})

describe("summarizeLatencies", () => {
	it("reports count, median, p95 and max", () => {
		const list = Array.from({ length: 100 }, (_, index) => index + 1)
		expect(summarizeLatencies(list)).toEqual({
			n: 100,
			p50: 50,
			p95: 95,
			max: 100,
		})
		expect(summarizeLatencies([])).toEqual({ n: 0 })
	})
})

describe("evaluateLoadPhase", () => {
	it("passes a complete workload with every acknowledgment accounted for", () => {
		expect(evaluateLoadPhase(phase()).outcome).toBe("pass")
		expect(evaluateLoadPhase(phase({ writers: 50 })).outcome).toBe("pass")
	})

	it("fails an acknowledged write that the store does not hold", () => {
		const result = evaluateLoadPhase(
			phase({ verification: { ...phase().verification, eventsCount: 590 } }),
		)
		expect(result.outcome).toBe("fail")
		expect(result.predicate).toBe("lost-acked-writes")
	})

	it("counts the seeded control record on both sides of the bound", () => {
		const facts = phase()
		const withCount = (eventsCount: number) =>
			evaluateLoadPhase({
				...facts,
				verification: { ...facts.verification, eventsCount },
			})
		expect(withCount(facts.writes.acked).predicate).toBe("lost-acked-writes")
		expect(withCount(facts.writes.acked + 1).outcome).toBe("pass")
		expect(withCount(facts.writes.attempted + 1).outcome).toBe("pass")
		expect(withCount(facts.writes.attempted + 2).predicate).toBe(
			"phantom-writes",
		)
	})

	it("fails more records than writes ever attempted", () => {
		const result = evaluateLoadPhase(
			phase({ verification: { ...phase().verification, eventsCount: 700 } }),
		)
		expect(result.predicate).toBe("phantom-writes")
	})

	it("allows records for writes whose outcome was unknown", () => {
		const facts = phase()
		const result = evaluateLoadPhase({
			...facts,
			writes: { ...facts.writes, acked: 590, errors: 10 },
			verification: { ...facts.verification, eventsCount: 598 },
		})
		expect(result.outcome).not.toBe("fail")
	})

	it("fails when an acknowledged write cannot be found by search", () => {
		const result = evaluateLoadPhase(
			phase({ verification: { ...phase().verification, sampledFound: 9 } }),
		)
		expect(result.predicate).toBe("acked-not-searchable")
	})

	it("is inconclusive, not a fail, when the sample could not be verified", () => {
		const result = evaluateLoadPhase(
			phase({
				verification: {
					...phase().verification,
					sampledFound: 9,
					sampledUnverified: 1,
				},
			}),
		)
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("sample-unverified")
	})

	it("fails a healthy search that lost the seeded control under load", () => {
		const facts = phase()
		const result = evaluateLoadPhase({
			...facts,
			searches: { ...facts.searches, healthy: 599, healthyMissingControl: 1 },
		})
		expect(result.predicate).toBe("silent-miss-under-load")
	})

	it("fails when the error rate exceeds the fixed limit but not at the limit", () => {
		const facts = phase()
		const total = facts.writes.attempted + facts.searches.attempted
		const limit = Math.floor(total * F_MAX_ERROR_RATE)
		const at = evaluateLoadPhase({
			...facts,
			writes: {
				...facts.writes,
				acked: facts.writes.acked - limit,
				errors: limit,
			},
			verification: {
				...facts.verification,
				eventsCount: facts.writes.acked - limit + 1,
			},
		})
		expect(at.outcome).toBe("pass")
		const over = evaluateLoadPhase({
			...facts,
			writes: {
				...facts.writes,
				acked: facts.writes.acked - limit - 1,
				errors: limit + 1,
			},
			verification: {
				...facts.verification,
				eventsCount: facts.writes.acked - limit,
			},
		})
		expect(over.predicate).toBe("server-errors")
	})

	it("does not fail on backpressure but cannot pass when it dominates", () => {
		const facts = phase()
		const result = evaluateLoadPhase({
			...facts,
			writes: { ...facts.writes, acked: 200, backpressure: 400 },
			verification: { ...facts.verification, eventsCount: 201 },
		})
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("backpressure-dominated")
	})

	it("reports a shortened or unstarted workload as inconclusive", () => {
		for (const shortened of [
			{ elapsedMs: 30_000 },
			{ startedWriters: 19 },
			{ startedSearchers: 0 },
		]) {
			const result = evaluateLoadPhase(phase(shortened))
			expect(result.outcome).toBe("inconclusive")
			expect(result.reason).toBe("workload-shortened")
		}
		const facts = phase()
		const thin = evaluateLoadPhase({
			...facts,
			writes: { ...facts.writes, attempted: 100, acked: 100 },
			verification: { ...facts.verification, eventsCount: 101 },
		})
		expect(thin.reason).toBe("workload-shortened")
	})

	it("still fails an observed violation in a shortened workload but marks the control ineligible", () => {
		const result = evaluateLoadPhase(
			phase({
				elapsedMs: 10_000,
				verification: { ...phase().verification, eventsCount: 5 },
			}),
		)
		expect(result.outcome).toBe("fail")
		expect(result.controlEligible).toBe(false)
	})

	it("is inconclusive when the count could not be verified or the control was not seeded", () => {
		expect(
			evaluateLoadPhase(
				phase({
					verification: { ...phase().verification, statusTrusted: false },
				}),
			).reason,
		).toBe("count-unverified")
		expect(evaluateLoadPhase(phase({ controlSeeded: false })).reason).toBe(
			"control-not-seeded",
		)
	})

	it("is inconclusive when the phase was aborted", () => {
		const result = evaluateLoadPhase(phase({ aborted: "budget-refusal:cap" }))
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("aborted:budget-refusal:cap")
	})
})

function kill(overrides: Partial<FKillFacts> = {}): FKillFacts {
	return {
		killed: true,
		interrupted: true,
		reissues: [{ customId: "a", ok: true, eventId: "e1" }],
		dedupe: {
			customId: "b",
			ok: true,
			firstEventId: "e2",
			secondEventId: "e2",
		},
		expectedRecords: 40,
		status: { trusted: true, count: 40 },
		controls: { writeAcked: true, search: "found" },
		...overrides,
	}
}

describe("evaluateProbeF", () => {
	it("requires both workloads and the kill case", () => {
		expect(requiredCaseIdsF()).toEqual([
			"F/load/w20",
			"F/load/w50",
			"F/kill/recovery",
		])
		expect(PROBE_F_RULE).toMatch(/killOp/)
		expect(PROBE_F_VERSION).toBe("F-1")
	})

	it("passes when both workloads and the recovery pass", () => {
		const result = evaluateProbeF([phase(), phase({ writers: 50 })], kill())
		expect(result.outcome).toBe("pass")
		expect(result.cases.map((item) => item.caseId)).toEqual(requiredCaseIdsF())
	})

	it("reports inconclusive, not pass, when the kill is not permitted", () => {
		const denied = kill({
			killed: false,
			notRun: { reason: "permission", detail: "not authorized on admin" },
		})
		const result = evaluateProbeF([phase(), phase({ writers: 50 })], denied)
		expect(result.outcome).toBe("inconclusive")
		expect(
			result.cases.find((item) => item.caseId === "F/kill/recovery")?.outcome,
		).toBe("not-run")
	})

	it("fails when any phase fails and keeps the other cases", () => {
		const lost = phase({
			verification: { ...phase().verification, eventsCount: 1 },
		})
		const result = evaluateProbeF([lost, phase({ writers: 50 })], kill())
		expect(result.outcome).toBe("fail")
		expect(result.cases).toHaveLength(3)
	})

	it("counts every search attempt in the health tally", () => {
		const result = evaluateProbeF([phase(), phase({ writers: 50 })], kill())
		expect(result.counts.attempted).toBe(1200)
	})

	it("leaves unexecuted cases incomplete", () => {
		const result = evaluateProbeF([phase()], undefined)
		expect(result.outcome).not.toBe("pass")
		expect(result.reasons.join(" ")).toContain("F/load/w50")
	})
})
