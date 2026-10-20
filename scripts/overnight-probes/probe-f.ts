import { abortReason, type ProbeContext } from "./context.ts"
import { planKill, runKill } from "./probe-f-kill.ts"
import { planLoadPhase, runLoadPhase } from "./probe-f-load.ts"
import {
	evaluateProbeF,
	F_PHASES,
	type FKillFacts,
	type FPhaseFacts,
	PROBE_F_RULE,
	PROBE_F_VERSION,
	summarizeLatencies,
} from "./probe-f-model.ts"
import type { ProbeRunResult } from "./types.ts"

export function planProbeF(): {
	"api-read": number
	"api-write": number
	"kill-op": number
	"current-op": number
} {
	const phases = F_PHASES.map((spec) => planLoadPhase(spec))
	const kill = planKill()
	return {
		"api-read":
			phases.reduce((total, item) => total + item["api-read"], 0) +
			kill["api-read"],
		"api-write":
			phases.reduce((total, item) => total + item["api-write"], 0) +
			kill["api-write"],
		"kill-op": kill["kill-op"],
		"current-op": kill["current-op"],
	}
}

function phaseSummary(facts: FPhaseFacts): Record<string, unknown> {
	return {
		variant: facts.variant,
		writers: facts.writers,
		searchers: facts.searchers,
		elapsedMs: facts.elapsedMs,
		startedWriters: facts.startedWriters,
		startedSearchers: facts.startedSearchers,
		controlSeeded: facts.controlSeeded,
		writes: {
			attempted: facts.writes.attempted,
			acked: facts.writes.acked,
			backpressure: facts.writes.backpressure,
			errors: facts.writes.errors,
			latency: summarizeLatencies(facts.writes.latenciesMs),
		},
		searches: {
			attempted: facts.searches.attempted,
			healthy: facts.searches.healthy,
			healthyMissingControl: facts.searches.healthyMissingControl,
			degraded: facts.searches.degraded,
			backpressure: facts.searches.backpressure,
			errors: facts.searches.errors,
			latency: summarizeLatencies(facts.searches.latenciesMs),
		},
		verification: facts.verification,
		...(facts.aborted ? { aborted: facts.aborted } : {}),
	}
}

export async function runProbeF(ctx: ProbeContext): Promise<ProbeRunResult> {
	const phases: FPhaseFacts[] = []
	for (const spec of F_PHASES) phases.push(await runLoadPhase(ctx, spec))
	let kill: FKillFacts
	try {
		kill = await runKill(ctx)
	} catch (error) {
		kill = {
			killed: false,
			reissues: [],
			expectedRecords: 0,
			status: { trusted: false },
			controls: { writeAcked: false, search: "not-run" },
			aborted: abortReason(error),
		}
	}
	const evaluation = evaluateProbeF(phases, kill)
	return {
		probe: "F",
		run: ctx.run,
		rule: PROBE_F_RULE,
		version: PROBE_F_VERSION,
		outcome: evaluation.outcome,
		reasons: evaluation.reasons,
		cases: evaluation.cases,
		counts: evaluation.counts,
		extra: {
			phases: phases.map(phaseSummary),
			kill: {
				killed: kill.killed,
				...(kill.interrupted !== undefined
					? { interrupted: kill.interrupted }
					: {}),
				...(kill.notRun ? { notRun: kill.notRun } : {}),
				reissues: kill.reissues.length,
				expectedRecords: kill.expectedRecords,
				status: kill.status,
				controls: kill.controls,
			},
		},
	}
}
