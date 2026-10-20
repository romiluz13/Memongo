import type { ProbeRunResult } from "./types.ts"

export type Reproduction = {
	ruleConsistent: boolean
	reproduced: Array<{ caseId: string; predicate: string; runs: number[] }>
	singleRun: Array<{
		caseId: string
		predicate: string
		run: number
		reason: string
	}>
	mismatched: Array<{ caseId: string; predicates: string[] }>
}

type Failure = { run: number; predicate: string; eligible: boolean }

export function compareRuns(runs: readonly ProbeRunResult[]): Reproduction {
	const first = runs[0]
	const ruleConsistent = runs.every(
		(item) => item.rule === first?.rule && item.version === first?.version,
	)
	const failuresByCase = new Map<string, Failure[]>()
	const outcomeByCaseAndRun = new Map<string, Map<number, string>>()
	for (const item of runs) {
		for (const result of item.cases) {
			const perRun = outcomeByCaseAndRun.get(result.caseId) ?? new Map()
			perRun.set(item.run, result.outcome)
			outcomeByCaseAndRun.set(result.caseId, perRun)
			if (result.outcome !== "fail") continue
			failuresByCase.set(result.caseId, [
				...(failuresByCase.get(result.caseId) ?? []),
				{
					run: item.run,
					predicate: result.predicate ?? "unspecified",
					eligible: result.controlEligible,
				},
			])
		}
	}

	const reproduced: Reproduction["reproduced"] = []
	const singleRun: Reproduction["singleRun"] = []
	const mismatched: Reproduction["mismatched"] = []
	for (const [caseId, failures] of failuresByCase) {
		const predicates = [...new Set(failures.map((f) => f.predicate))].sort()
		if (predicates.length > 1) mismatched.push({ caseId, predicates })
		for (const predicate of predicates) {
			const same = failures.filter((f) => f.predicate === predicate)
			const eligible = same.filter((f) => f.eligible)
			if (ruleConsistent && eligible.length >= 2) {
				reproduced.push({
					caseId,
					predicate,
					runs: eligible.map((f) => f.run).sort((a, b) => a - b),
				})
				continue
			}
			for (const f of same) {
				let reason = "failed in one run only"
				if (!ruleConsistent)
					reason = "rule or fixture version changed between runs"
				else if (!f.eligible || same.some((s) => !s.eligible)) {
					reason = "controls ineligible"
				}
				singleRun.push({ caseId, predicate, run: f.run, reason })
			}
		}
	}
	return { ruleConsistent, reproduced, singleRun, mismatched }
}
