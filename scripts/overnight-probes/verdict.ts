import {
	type CaseResult,
	EXIT_CODES,
	type FailsByBasis,
	type Outcome,
	type ProbeRunResult,
} from "./types.ts"

export function aggregateRun(
	cases: readonly CaseResult[],
	requiredCaseIds: readonly string[],
): { outcome: Outcome; reasons: string[] } {
	const reasons: string[] = []
	const byId = new Map<string, CaseResult[]>()
	for (const item of cases) {
		byId.set(item.caseId, [...(byId.get(item.caseId) ?? []), item])
	}
	const failed = cases.filter((item) => item.outcome === "fail")
	const inconclusive = cases.filter((item) => item.outcome === "inconclusive")
	const notRun = cases.filter((item) => item.outcome === "not-run")
	const unexecuted = requiredCaseIds.filter((id) => !byId.has(id))
	const unproven = requiredCaseIds.filter(
		(id) =>
			byId.has(id) &&
			!(byId.get(id) ?? []).some((item) => item.outcome === "pass") &&
			!(byId.get(id) ?? []).some((item) => item.outcome === "fail"),
	)
	if (failed.length > 0) {
		reasons.push(
			`failed cases: ${failed.map((item) => item.caseId).join(", ")}`,
		)
	}
	if (unexecuted.length > 0) {
		reasons.push(`unexecuted required cases: ${unexecuted.join(", ")}`)
	}
	if (inconclusive.length > 0) {
		reasons.push(
			`inconclusive cases: ${inconclusive.map((item) => item.caseId).join(", ")}`,
		)
	}
	if (notRun.length > 0) {
		reasons.push(
			`not-run cases: ${notRun.map((item) => item.caseId).join(", ")}`,
		)
	}
	if (failed.length > 0) return { outcome: "fail", reasons }
	if (cases.length === 0 || cases.every((item) => item.outcome === "not-run")) {
		return { outcome: "not-run", reasons }
	}
	const passedAll =
		unexecuted.length === 0 &&
		unproven.length === 0 &&
		inconclusive.length === 0 &&
		notRun.length === 0
	return { outcome: passedAll ? "pass" : "inconclusive", reasons }
}

export function combineRuns(runs: readonly ProbeRunResult[]): {
	outcome: Outcome
	reasons: string[]
} {
	const outcomes = runs.map((item) => item.outcome)
	const reasons = runs.flatMap((item) =>
		item.reasons.map((reason) => `run ${item.run}: ${reason}`),
	)
	if (outcomes.includes("fail")) return { outcome: "fail", reasons }
	if (outcomes.includes("inconclusive"))
		return { outcome: "inconclusive", reasons }
	if (outcomes.length === 0 || outcomes.every((o) => o === "not-run")) {
		return { outcome: "not-run", reasons }
	}
	if (outcomes.includes("not-run")) {
		return {
			outcome: "inconclusive",
			reasons: [...reasons, "a run did not execute"],
		}
	}
	return { outcome: "pass", reasons }
}

export function countFailsByBasis(
	runs: readonly ProbeRunResult[],
): FailsByBasis {
	const basisOf = new Map<string, keyof FailsByBasis>()
	for (const item of runs.flatMap((entry) => entry.cases)) {
		if (item.outcome === "fail" && !basisOf.has(item.caseId)) {
			basisOf.set(item.caseId, item.contractBasis ?? "unclassified")
		}
	}
	const counts: FailsByBasis = {
		"code-derived": 0,
		documented: 0,
		unclassified: 0,
	}
	for (const basis of basisOf.values()) counts[basis] += 1
	return counts
}

export function aggregateInvocation(outcomes: readonly Outcome[]): Outcome {
	if (outcomes.includes("fail")) return "fail"
	if (outcomes.includes("inconclusive")) return "inconclusive"
	if (outcomes.length === 0 || outcomes.includes("not-run")) return "not-run"
	return "pass"
}

export function exitCodeFor(outcome: Outcome): number {
	return EXIT_CODES[outcome]
}
