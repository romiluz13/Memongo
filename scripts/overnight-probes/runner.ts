import { type Budget, type BudgetSnapshot, validateLimits } from "./budget.ts"
import {
	abortReason,
	type AdminPort,
	type AnswerPort,
	type Clock,
	type ProbeContext,
} from "./context.ts"
import type { Harness } from "./harness.ts"
import type { EvidenceWriter } from "./output.ts"
import { planProbeA, runProbeA } from "./probe-a.ts"
import type { ProbeApi } from "./probe-api.ts"
import { planProbeB, runProbeB } from "./probe-b.ts"
import { planProbeC, runProbeC } from "./probe-c.ts"
import { planProbeD, runProbeD } from "./probe-d.ts"
import { planProbeE, runProbeE } from "./probe-e.ts"
import { planProbeF, runProbeF } from "./probe-f.ts"
import { planProbeG, runProbeG } from "./probe-g.ts"
import { compareRuns, type Reproduction } from "./reproduction.ts"
import type { Outcome, ProbeLetter, ProbeRunResult } from "./types.ts"
import { aggregateInvocation, combineRuns } from "./verdict.ts"

export type ProbeEntry = {
	plan(): Record<string, number>
	run(ctx: ProbeContext): Promise<ProbeRunResult>
}

export type Registry = Record<ProbeLetter, ProbeEntry>

export const PROBES: Registry = {
	A: { plan: planProbeA, run: runProbeA },
	B: { plan: planProbeB, run: runProbeB },
	C: { plan: planProbeC, run: runProbeC },
	D: { plan: planProbeD, run: runProbeD },
	E: { plan: planProbeE, run: runProbeE },
	F: { plan: planProbeF, run: runProbeF },
	G: { plan: planProbeG, run: runProbeG },
}

export type InvocationPlan = {
	runs: number
	perRun: Partial<Record<ProbeLetter, Record<string, number>>>
	caps: Record<string, number>
}

export function planInvocation(
	probes: readonly ProbeLetter[],
	runs: number,
	registry: Registry = PROBES,
): InvocationPlan {
	validateLimits({ runs, ceilingUsd: 1 })
	const perRun: InvocationPlan["perRun"] = {}
	const caps: Record<string, number> = {}
	for (const letter of probes) {
		const plan = registry[letter].plan()
		perRun[letter] = plan
		for (const [path, units] of Object.entries(plan)) {
			if (!Number.isSafeInteger(units) || units < 0) {
				throw new Error(`probe ${letter} plans an invalid count for ${path}`)
			}
			caps[path] = (caps[path] ?? 0) + units * runs
		}
	}
	return { runs, perRun, caps }
}

export function adminPortFor(harness: Harness): AdminPort {
	return {
		database: harness.database,
		appName: harness.appName,
		currentOps: () => harness.mongo.listOperations(),
		killOp: (opid) => harness.mongo.killOperation(opid),
	}
}

export type ProbeSummary = {
	probe: ProbeLetter
	outcome: Outcome
	reasons: string[]
	runs: number
	reproduction: Reproduction
}

export type InvocationReport = {
	outcome: Outcome
	probes: ProbeSummary[]
	budget: BudgetSnapshot
}

export type InvocationInput = {
	probes: readonly ProbeLetter[]
	runs: number
	api: ProbeApi
	answer?: AnswerPort
	admin?: AdminPort
	budget: Budget
	evidence: EvidenceWriter
	clock: Clock
	token(prefix: string): string
	agentId(): string
	registry?: Registry
}

function crashed(letter: ProbeLetter, run: number, error: unknown) {
	const result: ProbeRunResult = {
		probe: letter,
		run,
		rule: "unavailable",
		version: "unavailable",
		outcome: "inconclusive",
		reasons: [`probe stopped: ${abortReason(error)}`],
		cases: [],
		counts: {},
		extra: { crashed: true },
	}
	return result
}

export async function runInvocation(
	input: InvocationInput,
): Promise<InvocationReport> {
	const registry = input.registry ?? PROBES
	const collected = new Map<ProbeLetter, ProbeRunResult[]>()
	for (let run = 1; run <= input.runs; run += 1) {
		for (const letter of input.probes) {
			const ctx: ProbeContext = {
				api: input.api,
				...(input.answer ? { answer: input.answer } : {}),
				...(input.admin ? { admin: input.admin } : {}),
				run,
				budget: input.budget,
				evidence: input.evidence,
				clock: input.clock,
				token: input.token,
				agentId: input.agentId,
			}
			let result: ProbeRunResult
			try {
				result = await registry[letter].run(ctx)
			} catch (error) {
				result = crashed(letter, run, error)
			}
			collected.set(letter, [...(collected.get(letter) ?? []), result])
			input.evidence.record("probe-run", result)
		}
	}
	const probes: ProbeSummary[] = []
	for (const letter of input.probes) {
		const results = collected.get(letter) ?? []
		const combined = combineRuns(results)
		const reproduction = compareRuns(
			results.filter((item) => item.extra?.crashed !== true),
		)
		const summary: ProbeSummary = {
			probe: letter,
			outcome: combined.outcome,
			reasons: combined.reasons,
			runs: results.length,
			reproduction,
		}
		probes.push(summary)
		input.evidence.record("probe-summary", summary)
	}
	return {
		outcome: aggregateInvocation(probes.map((item) => item.outcome)),
		probes,
		budget: input.budget.snapshot(),
	}
}
