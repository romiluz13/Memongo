import type { RouteHealth } from "./health.ts"
import { isRecord } from "./rows.ts"
import type { CaseResult, Observation, Outcome } from "./types.ts"
import { aggregateRun } from "./verdict.ts"

export const PROBE_F_VERSION = "F-1"
export const F_DURATION_MS = 60_000
export const F_PACE_MS = 2_000
export const F_TICKS = F_DURATION_MS / F_PACE_MS
export const F_SEARCHERS = 20
export const F_PHASES = [
	{ variant: "w20", writers: 20 },
	{ variant: "w50", writers: 50 },
] as const
export const F_MIN_DELIVERY = 0.9
export const F_MIN_ACK_RATE = 0.5
export const F_MAX_ERROR_RATE = 0.01
export const F_SAMPLE = 10
export const F_DRAIN_MS = 30_000

export const PROBE_F_RULE =
	"Two fixed workloads run for 60 seconds each: 20 writers and 20 searchers, then 50 writers and 20 searchers, each worker acting every 2 seconds. A seeded control record must be returned by every healthy search. After the load stops, the stored record count for the agent must be at least the acknowledged writes plus the control and at most the attempted writes plus the control, and a fixed sample of acknowledged writes must be found by search. A workload fails on a lost acknowledged write, more records than writes attempted, an acknowledged write that search cannot find, a healthy search that lost the control, or an error rate above 1 percent. Backpressure and explicit degradation are counted apart and never count as errors or as passes. A workload that started fewer workers, ran shorter than scheduled, delivered under 90 percent of its schedule, was acknowledged for under half of it, or could not be verified is inconclusive. Recovery kills one active operation of the generated database, owned by the spawned client and carrying the marker of a write still pending, using killOp after revalidating it. It passes only when the interruption is observed, every failed write is reissued with the same payload and customId, a repeated reissue returns the same record, the stored count equals the number of distinct writes, and a fresh write is acknowledged and found by search. A cluster that denies killOp, an absent target, a finished operation and an uninterrupted kill each report not-run with their own reason; there is no substitute injection."

const DEGRADED_ISSUES = ["degraded:throttled", "throttled"]
const BACKPRESSURE_CODES = [
	"THROTTL",
	"RATE_LIMIT",
	"ADMISSION",
	"BACKPRESSURE",
	"OVERLOAD",
]
const ELIGIBLE_OPS: ReadonlySet<string> = new Set([
	"insert",
	"update",
	"command",
	"query",
])

export type FPhaseFacts = {
	variant: "w20" | "w50"
	writers: number
	searchers: number
	durationMs: number
	elapsedMs: number
	startedWriters: number
	startedSearchers: number
	scheduledWrites: number
	scheduledSearches: number
	writes: {
		attempted: number
		acked: number
		backpressure: number
		errors: number
		latenciesMs: number[]
	}
	searches: {
		attempted: number
		healthy: number
		healthyMissingControl: number
		degraded: number
		backpressure: number
		errors: number
		latenciesMs: number[]
	}
	controlSeeded: boolean
	verification: {
		statusTrusted: boolean
		eventsCount?: number
		sampled: number
		sampledFound: number
		sampledUnverified: number
	}
	aborted?: string
}

export type FKillFacts = {
	notRun?: {
		reason:
			| "permission"
			| "no-owned-target"
			| "operation-finished"
			| "admin-unavailable"
		detail?: string
	}
	adminError?: string
	aborted?: string
	killed: boolean
	interrupted?: boolean
	reissues: { customId: string; ok: boolean; eventId?: string }[]
	dedupe?: {
		customId: string
		ok: boolean
		firstEventId?: string
		secondEventId?: string
	}
	expectedRecords: number
	status: { trusted: boolean; count?: number }
	controls: {
		writeAcked: boolean
		search: "found" | "missing-healthy" | "unhealthy" | "not-run"
	}
}

export type OpOwnership = {
	database: string
	appName: string
	identities: readonly string[]
}

export function requiredCaseIdsF(): string[] {
	return [
		...F_PHASES.map((item) => `F/load/${item.variant}`),
		"F/kill/recovery",
	]
}

export function classifyWrite(
	observation: Observation,
): "acked" | "backpressure" | "error" {
	if (observation.kind === "response") {
		const body = observation.body
		return isRecord(body) && typeof body.eventId === "string"
			? "acked"
			: "error"
	}
	if (observation.kind === "http-error") {
		const code = (observation.code ?? "").toUpperCase()
		return observation.status === 429 ||
			BACKPRESSURE_CODES.some((part) => code.includes(part))
			? "backpressure"
			: "error"
	}
	return "error"
}

export function classifySearch(
	observation: Observation,
	health: RouteHealth,
	controlMarker: string,
):
	| "healthy"
	| "healthy-missing-control"
	| "degraded"
	| "backpressure"
	| "error" {
	if (observation.kind === "transport-error") return "error"
	if (observation.kind === "http-error") {
		return classifyWrite(observation) === "backpressure"
			? "backpressure"
			: "error"
	}
	if (health.evaluable) {
		return JSON.stringify(observation.body).includes(controlMarker)
			? "healthy"
			: "healthy-missing-control"
	}
	return health.issues.some((issue) => DEGRADED_ISSUES.includes(issue))
		? "backpressure"
		: "degraded"
}

export function summarizeLatencies(values: readonly number[]): {
	n: number
	p50?: number
	p95?: number
	max?: number
} {
	if (values.length === 0) return { n: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	const at = (fraction: number) =>
		sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] as number
	return {
		n: sorted.length,
		p50: at(0.5),
		p95: at(0.95),
		max: sorted[sorted.length - 1] as number,
	}
}

function inconclusive(caseId: string, reason: string): CaseResult {
	return { caseId, outcome: "inconclusive", reason, controlEligible: false }
}

function loadViolation(facts: FPhaseFacts): string | undefined {
	const { verification, writes, searches } = facts
	const count = verification.statusTrusted
		? verification.eventsCount
		: undefined
	if (count !== undefined && count < writes.acked + 1)
		return "lost-acked-writes"
	if (count !== undefined && count > writes.attempted + 1)
		return "phantom-writes"
	if (
		verification.sampledFound + verification.sampledUnverified <
		verification.sampled
	) {
		return "acked-not-searchable"
	}
	if (searches.healthyMissingControl > 0) return "silent-miss-under-load"
	const attempts = writes.attempted + searches.attempted
	const errors = writes.errors + searches.errors
	if (attempts > 0 && errors > Math.floor(attempts * F_MAX_ERROR_RATE)) {
		return "server-errors"
	}
	return undefined
}

function shortened(facts: FPhaseFacts): boolean {
	return (
		facts.startedWriters < facts.writers ||
		facts.startedSearchers < facts.searchers ||
		facts.elapsedMs < facts.durationMs - 1_000 ||
		facts.writes.attempted < facts.scheduledWrites * F_MIN_DELIVERY ||
		facts.searches.attempted < facts.scheduledSearches * F_MIN_DELIVERY
	)
}

export function evaluateLoadPhase(facts: FPhaseFacts): CaseResult {
	const caseId = `F/load/${facts.variant}`
	const violation = loadViolation(facts)
	if (violation) {
		return {
			caseId,
			outcome: "fail",
			predicate: violation,
			reason: violation,
			controlEligible: facts.controlSeeded && !shortened(facts),
			detail: {
				writes: facts.writes,
				searches: facts.searches,
				verification: facts.verification,
			},
		}
	}
	if (facts.aborted) return inconclusive(caseId, `aborted:${facts.aborted}`)
	if (!facts.controlSeeded) return inconclusive(caseId, "control-not-seeded")
	if (shortened(facts)) return inconclusive(caseId, "workload-shortened")
	if (!facts.verification.statusTrusted) {
		return inconclusive(caseId, "count-unverified")
	}
	if (facts.verification.sampledUnverified > 0) {
		return inconclusive(caseId, "sample-unverified")
	}
	if (facts.writes.acked < facts.scheduledWrites * F_MIN_ACK_RATE) {
		return inconclusive(caseId, "backpressure-dominated")
	}
	return {
		caseId,
		outcome: "pass",
		controlEligible: true,
		detail: {
			writes: {
				attempted: facts.writes.attempted,
				acked: facts.writes.acked,
				backpressure: facts.writes.backpressure,
				errors: facts.writes.errors,
			},
			writeLatency: summarizeLatencies(facts.writes.latenciesMs),
			searchLatency: summarizeLatencies(facts.searches.latenciesMs),
		},
	}
}

export function isEligibleOp(op: unknown, ownership: OpOwnership): boolean {
	if (!isRecord(op) || op.active !== true) return false
	if (typeof op.op !== "string" || !ELIGIBLE_OPS.has(op.op)) return false
	const prefix = `${ownership.database}.`
	if (
		typeof op.ns !== "string" ||
		!op.ns.startsWith(prefix) ||
		op.ns.length === prefix.length
	) {
		return false
	}
	if (op.appName !== ownership.appName) return false
	if (isRecord(op.command) && "$currentOp" in op.command) return false
	const text = JSON.stringify(op.command ?? {})
	return ownership.identities.some((identity) => text.includes(identity))
}

export function pickEligibleOp(
	ops: readonly unknown[],
	ownership: OpOwnership,
): Record<string, unknown> | undefined {
	return ops.find((op) => isEligibleOp(op, ownership)) as
		| Record<string, unknown>
		| undefined
}

export function evaluateKill(facts: FKillFacts): CaseResult {
	const caseId = "F/kill/recovery"
	if (facts.notRun) {
		const { reason, detail } = facts.notRun
		return {
			caseId,
			outcome: "not-run",
			reason: detail ? `${reason}: ${detail}` : reason,
			controlEligible: false,
		}
	}
	if (facts.aborted) return inconclusive(caseId, `aborted:${facts.aborted}`)
	if (facts.adminError) return inconclusive(caseId, "admin-failed")
	if (facts.killed && facts.interrupted !== true) {
		return {
			caseId,
			outcome: "not-run",
			reason: "not-interrupted",
			controlEligible: false,
		}
	}
	const fail = (predicate: string): CaseResult => ({
		caseId,
		outcome: "fail",
		predicate,
		reason: predicate,
		controlEligible: true,
		detail: {
			reissues: facts.reissues,
			dedupe: facts.dedupe,
			expectedRecords: facts.expectedRecords,
			status: facts.status,
			controls: facts.controls,
		},
	})
	if (facts.reissues.some((item) => !item.ok)) return fail("reissue-failed")
	if (
		facts.dedupe &&
		(!facts.dedupe.ok ||
			facts.dedupe.firstEventId === undefined ||
			facts.dedupe.firstEventId !== facts.dedupe.secondEventId)
	) {
		return fail("non-idempotent-reissue")
	}
	if (!facts.status.trusted || facts.status.count === undefined) {
		return inconclusive(caseId, "count-unverified")
	}
	if (facts.status.count > facts.expectedRecords) {
		return fail("duplicate-logical-record")
	}
	if (facts.status.count < facts.expectedRecords) return fail("lost-record")
	if (!facts.controls.writeAcked) return fail("write-not-recovered")
	if (facts.controls.search === "missing-healthy") {
		return fail("acked-not-searchable")
	}
	if (facts.controls.search !== "found") {
		return inconclusive(caseId, "read-control-unverified")
	}
	return { caseId, outcome: "pass", controlEligible: true }
}

export type ProbeFEvaluation = {
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	counts: Record<string, number>
}

export function evaluateProbeF(
	phases: readonly FPhaseFacts[],
	kill: FKillFacts | undefined,
): ProbeFEvaluation {
	const cases = [
		...phases.map((facts) => evaluateLoadPhase(facts)),
		...(kill ? [evaluateKill(kill)] : []),
	]
	const verdict = aggregateRun(cases, requiredCaseIdsF())
	const sum = (pick: (facts: FPhaseFacts) => number) =>
		phases.reduce((total, facts) => total + pick(facts), 0)
	return {
		outcome: verdict.outcome,
		reasons: verdict.reasons,
		cases,
		counts: {
			attempted: sum((facts) => facts.searches.attempted),
			completed: sum(
				(facts) => facts.searches.attempted - facts.searches.errors,
			),
			healthy: sum(
				(facts) =>
					facts.searches.healthy + facts.searches.healthyMissingControl,
			),
			evaluable: sum(
				(facts) =>
					facts.searches.healthy + facts.searches.healthyMissingControl,
			),
			writesAttempted: sum((facts) => facts.writes.attempted),
			writesAcked: sum((facts) => facts.writes.acked),
			writesBackpressure: sum((facts) => facts.writes.backpressure),
			searchesBackpressure: sum((facts) => facts.searches.backpressure),
		},
	}
}
