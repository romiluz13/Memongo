import type { RouteHealth } from "./health.ts"
import { containsMarker } from "./markers.ts"
import type { CaseResult, Observation, Outcome } from "./types.ts"
import { aggregateRun } from "./verdict.ts"

export const PROBE_E_VERSION = "E-1"
export const E_DEADLINE_MS = 60_000
export const E_POLL_STEP_MS = 1_000
export const E_PRIMARY_N = 10
export const E_BARRIER_N = 5

export const PROBE_E_RULE =
	"Items are written without a search barrier and polled once immediately and then every 1 s until a healthy read contains the item or 60 s have passed since dispatch. An item fails only when it is never visible within 60 s, its final read was healthy and empty, and the already-visible control read healthy at the start and the end. Degraded, not-ready and failed reads never count as visible or as healthy empties and make a missing item inconclusive. A barrier item fails when the barrier reports searchable and the first healthy read after the acknowledgment does not contain it. Latency is reported as a sampled interval, never as a point, and unseen items are right-censored."

export type EPoll = {
	atMs: number
	observation: Observation
	health: RouteHealth
	request: unknown
}

export type EItem = {
	variant: "primary" | "barrier"
	index: number
	marker: string
	dispatchAt: number
	ackAt?: number
	ack: {
		ok: boolean
		reason?: string
		barrier?: { status?: string; reason?: string }
	}
	polls: EPoll[]
}

export type EControl = { marker: string; start?: EPoll; end?: EPoll }

export type ReadClass =
	| "visible"
	| "degraded-visible"
	| "empty-silent"
	| "empty-with-degradation"
	| "explicit-not-ready"
	| "error"

const NOT_READY_REASONS = [
	"index-not-ready",
	"index-missing",
	"index-stale",
	"index-unavailable",
]

function mentionsNotReady(text: string): boolean {
	return NOT_READY_REASONS.some((reason) => text.includes(reason))
}

export function classifyRead(poll: EPoll, marker: string): ReadClass {
	const { observation, health } = poll
	if (observation.kind === "transport-error") return "error"
	if (observation.kind === "http-error") {
		const outcomes = JSON.stringify(observation.outcomes ?? "")
		return observation.code === "SEARCH_LANES_UNAVAILABLE" ||
			mentionsNotReady(outcomes)
			? "explicit-not-ready"
			: "error"
	}
	if (containsMarker(observation.body, marker)) {
		return health.evaluable ? "visible" : "degraded-visible"
	}
	if (health.healthy && health.evaluable) return "empty-silent"
	return mentionsNotReady(health.issues.join(" "))
		? "explicit-not-ready"
		: "empty-with-degradation"
}

export type Interval = { index: number; lowerMs: number; upperMs: number }

export type ProbeEMetrics = {
	primary: {
		n: number
		observed: number
		censored: number
		intervals: Interval[]
		censoredAfterMs: { index: number; afterMs: number }[]
		ackMs: number[]
	}
	barrier: {
		n: number
		statuses: Record<string, number>
		firstReadVisible: number
	}
	classes: Record<ReadClass, number>
}

export type ProbeEEvaluation = {
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	metrics: ProbeEMetrics
}

export function requiredCaseIdsE(): string[] {
	return [
		"E/control",
		...Array.from(
			{ length: E_PRIMARY_N },
			(_v, i) => `E/primary/item-${i + 1}`,
		),
		...Array.from(
			{ length: E_BARRIER_N },
			(_v, i) => `E/barrier/item-${i + 1}`,
		),
	]
}

function emptyClasses(): Record<ReadClass, number> {
	return {
		visible: 0,
		"degraded-visible": 0,
		"empty-silent": 0,
		"empty-with-degradation": 0,
		"explicit-not-ready": 0,
		error: 0,
	}
}

function inconclusive(caseId: string, reason: string): CaseResult {
	return { caseId, outcome: "inconclusive", reason, controlEligible: false }
}

function evaluateControl(control: EControl): {
	result: CaseResult
	ok: boolean
} {
	const start = control.start
		? classifyRead(control.start, control.marker)
		: "missing"
	const end = control.end
		? classifyRead(control.end, control.marker)
		: "missing"
	if (start === "visible" && end === "visible") {
		return {
			ok: true,
			result: { caseId: "E/control", outcome: "pass", controlEligible: true },
		}
	}
	return {
		ok: false,
		result: inconclusive(
			"E/control",
			`control-start:${start},control-end:${end}`,
		),
	}
}

function intervalOf(item: EItem, visibleAt: number): Interval {
	let lowerMs = 0
	for (const poll of item.polls.slice(0, visibleAt)) {
		if (classifyRead(poll, item.marker) === "empty-silent") {
			lowerMs = Math.max(lowerMs, poll.atMs - item.dispatchAt)
		}
	}
	const visible = item.polls[visibleAt] as EPoll
	return { index: item.index, lowerMs, upperMs: visible.atMs - item.dispatchAt }
}

function primaryCase(
	item: EItem,
	controlOk: boolean,
	metrics: ProbeEMetrics,
): CaseResult {
	const caseId = `E/primary/item-${item.index}`
	if (item.ackAt !== undefined)
		metrics.primary.ackMs.push(item.ackAt - item.dispatchAt)
	const classes = item.polls.map((poll) => classifyRead(poll, item.marker))
	const visibleAt = classes.indexOf("visible")
	const before = visibleAt === -1 ? classes : classes.slice(0, visibleAt)
	for (const read of before) metrics.classes[read] += 1
	if (!item.ack.ok) {
		return inconclusive(
			caseId,
			`write-not-acknowledged:${item.ack.reason ?? "unknown"}`,
		)
	}
	if (visibleAt !== -1) {
		const interval = intervalOf(item, visibleAt)
		metrics.primary.observed += 1
		metrics.primary.intervals.push(interval)
		return {
			caseId,
			outcome: "pass",
			controlEligible: controlOk,
			detail: { lowerMs: interval.lowerMs, upperMs: interval.upperMs },
		}
	}
	metrics.primary.censored += 1
	const last = item.polls.at(-1)
	const afterMs = last ? last.atMs - item.dispatchAt : 0
	metrics.primary.censoredAfterMs.push({ index: item.index, afterMs })
	if (!last || afterMs < E_DEADLINE_MS) {
		return inconclusive(caseId, "deadline-not-reached")
	}
	if (classes.at(-1) !== "empty-silent") {
		return inconclusive(caseId, `final-read-unhealthy:${classes.at(-1)}`)
	}
	if (!controlOk) return inconclusive(caseId, "control-not-established")
	return {
		caseId,
		outcome: "fail",
		predicate: "never-visible-within-60s",
		reason: "never-visible-within-60s",
		controlEligible: true,
		detail: { afterMs, polls: item.polls.length },
		evidence: { request: last.request, response: last.observation },
	}
}

function barrierCase(item: EItem, metrics: ProbeEMetrics): CaseResult {
	const caseId = `E/barrier/item-${item.index}`
	const status = item.ack.barrier?.status ?? "missing"
	metrics.barrier.statuses[status] = (metrics.barrier.statuses[status] ?? 0) + 1
	const first = item.polls[0]
	const read = first ? classifyRead(first, item.marker) : "error"
	if (read === "visible") metrics.barrier.firstReadVisible += 1
	if (!item.ack.ok) {
		return inconclusive(
			caseId,
			`write-not-acknowledged:${item.ack.reason ?? "unknown"}`,
		)
	}
	if (status !== "searchable") return inconclusive(caseId, `barrier-${status}`)
	if (!first) return inconclusive(caseId, "no-read-after-barrier")
	if (read === "visible") {
		return { caseId, outcome: "pass", controlEligible: true }
	}
	if (read === "empty-silent") {
		return {
			caseId,
			outcome: "fail",
			predicate: "barrier-searchable-but-invisible",
			reason: "barrier-searchable-but-invisible",
			controlEligible: true,
			evidence: { request: first.request, response: first.observation },
		}
	}
	return inconclusive(caseId, `first-read-unhealthy:${read}`)
}

export function evaluateProbeE(input: {
	control: EControl
	items: readonly EItem[]
}): ProbeEEvaluation {
	const metrics: ProbeEMetrics = {
		primary: {
			n: 0,
			observed: 0,
			censored: 0,
			intervals: [],
			censoredAfterMs: [],
			ackMs: [],
		},
		barrier: { n: 0, statuses: {}, firstReadVisible: 0 },
		classes: emptyClasses(),
	}
	const control = evaluateControl(input.control)
	const cases: CaseResult[] = [control.result]
	for (const item of input.items) {
		if (item.variant === "primary") {
			metrics.primary.n += 1
			cases.push(primaryCase(item, control.ok, metrics))
		} else {
			metrics.barrier.n += 1
			cases.push(barrierCase(item, metrics))
		}
	}
	metrics.primary.intervals.sort((a, b) => a.index - b.index)
	const verdict = aggregateRun(cases, requiredCaseIdsE())
	return { outcome: verdict.outcome, reasons: verdict.reasons, cases, metrics }
}
