#!/usr/bin/env bun
/**
 * B2 noise-rule join (backlog B2 §4): per-question R and Q deltas between
 * two frozen-50 runs, the noise-rule verdict, and the double-baseline flip
 * rate.
 *
 * Inputs per run: the benchmark checkpoint (R side — per-case session- and
 * turn-level recallAny@10/@50 from the last measurement pass) and the
 * official prediction sidecar beside it (Q side — per-question judge
 * verdicts). All joins are on questionId == caseId.
 *
 * Populations (round-2 review): R deltas are computed over the PAIRED
 * population — questions with recall in BOTH runs — so a question that
 * failed in one run cannot masquerade as a fix. Unpaired counts are
 * reported. Q uses judged-in-both, which is paired by construction.
 *
 * Noise rule (tightened, ADR 0011):
 *   P_R  = questions with session R@10 in both runs
 *   P_Q  = questions judged in both runs
 *   netR = Σ_P_R (r10B − r10A)     (net recall questions)
 *   netQ = Σ_P_Q (qB − qA)         (net correct answers)
 *   T    = max(3, baselineFlips + 1)   (baselineFlips from the double
 *                                       baseline; 3 until measured)
 *   REAL iff |netQ| ≥ T
 *         OR (sign(netR) == sign(netQ) ≠ 0 AND |netR| ≥ 2 AND |netQ| ≥ 1)
 *   Reported separately — retrieval-real, answer-neutral — when
 *   |netR| ≥ 3 and netQ == 0 (expected for retrieval-only fixes; R-neutral
 *   fixes can only be REAL via |netQ| ≥ T).
 * With --r-only (no Q sidecar required), REAL iff |netR| ≥ 3.
 *
 * Q requires the run to have set MEMONGO_BENCHMARK_QA_PROTOCOL=official;
 * a missing prediction sidecar is refused unless --r-only is passed.
 *
 * Usage:
 *   bun scripts/benchmark/b2-join.ts --a <checkpoint-a> --b <checkpoint-b> \
 *     [--baseline-a <ckpt> --baseline-b <ckpt>] [--r-only] [--min-judged <n>]
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const B2_NET_Q_FLIP_THRESHOLD = 3
export const B2_NET_R_THRESHOLD = 3

type ExecutionTrace = {
	caseId?: string
	questionType?: string
	abstention?: boolean
	longMemEval?: {
		session?: { recallAnyAt10?: number; recallAnyAt50?: number }
		turn?: { recallAnyAt10?: number; recallAnyAt50?: number }
	}
}

type CheckpointFile = {
	totalScenarios?: number
	scenarioIds?: string[]
	completedScenarios?: Array<{
		scenarioId?: string
		executionsByPass?: ExecutionTrace[][]
	}>
}

type SidecarFile = {
	rows?: Record<
		string,
		{ questionId: string; stage: string; verdict: string | null }
	>
}

export type RunQuestionMetrics = {
	questionId: string
	questionType?: string
	abstention?: boolean
	recallAnyAt10?: number
	recallAnyAt50?: number
	turnRecallAnyAt10?: number
	turnRecallAnyAt50?: number
	verdict?: string | null
}

export type B2PerQuestionRow = {
	questionId: string
	questionType?: string
	abstention?: boolean
	recallAnyAt10A?: number
	recallAnyAt10B?: number
	recallAnyAt50A?: number
	recallAnyAt50B?: number
	turnRecallAnyAt10A?: number
	turnRecallAnyAt10B?: number
	turnRecallAnyAt50A?: number
	turnRecallAnyAt50B?: number
	verdictA?: string | null
	verdictB?: string | null
}

export type B2AggregateTriple = { a: number; b: number; delta: number }

export type B2JoinReport = {
	questionCount: number
	judgedInBoth: number
	rPaired: number
	rUnpaired: { aOnly: number; bOnly: number }
	aggregate: {
		recallAnyAt10: B2AggregateTriple
		recallAnyAt50: B2AggregateTriple
		turnRecallAnyAt10: B2AggregateTriple
		turnRecallAnyAt50: B2AggregateTriple
		accuracy: B2AggregateTriple
	}
	netR: number
	netQFlips: number
	noiseRule: {
		real: boolean
		reason: string
		threshold: number
		retrievalRealAnswerNeutral: boolean
		rOnly: boolean
	}
	partialQ: {
		judgedInBoth: number
		questionCount: number
		incomplete: boolean
	}
	perQuestion: B2PerQuestionRow[]
	flipRate?: {
		judgedInBoth: number
		flips: number
		flipRate: number
	}
}

export type JoinB2RunsOptions = {
	/** Net flips measured between two repetitions of the SAME configuration. */
	baselineFlips?: number
	/** No Q sidecar available: verdict on R movement alone. */
	rOnly?: boolean
}

function mean(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((s, v) => s + v, 0) / values.length
}

function pairedMeanDelta(
	pairs: Array<[number | undefined, number | undefined]>,
): B2AggregateTriple & { count: number } {
	const both = pairs.filter(
		(pair): pair is [number, number] => pair[0] != null && pair[1] != null,
	)
	if (both.length === 0) return { a: 0, b: 0, delta: 0, count: 0 }
	const a = mean(both.map((pair) => pair[0]))
	const b = mean(both.map((pair) => pair[1]))
	return { a, b, delta: b - a, count: both.length }
}

/**
 * Reads one run's R (checkpoint) and Q (sidecar) sides and merges them into
 * a per-question map. Uses the LAST measurement pass per scenario: the
 * final measured state for that scenario (the default loop runs a single
 * measurement pass; main() warns when a scenario recorded more than one).
 *
 * A missing prediction sidecar is tolerated only when `requireSidecar` is
 * false; with it true (the default in main() unless --r-only), ENOENT
 * throws so a Q-less run can never be silently joined as "noise".
 */
export async function readB2RunArtifacts(
	checkpointPath: string,
	options: { requireSidecar?: boolean } = {},
): Promise<Map<string, RunQuestionMetrics>> {
	const checkpoint = JSON.parse(
		await readFile(checkpointPath, "utf8"),
	) as CheckpointFile
	const sidecarPath = `${checkpointPath}.predictions.json`
	let sidecar: SidecarFile = {}
	let sidecarMissing = false
	try {
		sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as SidecarFile
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
		sidecarMissing = true
	}
	if (sidecarMissing && options.requireSidecar) {
		throw new Error(
			`missing prediction sidecar: ${sidecarPath}. The Q side requires a run with MEMONGO_BENCHMARK_QA_PROTOCOL=official; pass --r-only to join on R alone.`,
		)
	}
	const byQuestion = new Map<string, RunQuestionMetrics>()
	for (const scenario of checkpoint.completedScenarios ?? []) {
		const passes = scenario.executionsByPass ?? []
		const lastPass = passes[passes.length - 1] ?? []
		for (const execution of lastPass) {
			if (!execution.caseId) continue
			byQuestion.set(execution.caseId, {
				questionId: execution.caseId,
				questionType: execution.questionType,
				abstention: execution.abstention,
				recallAnyAt10: execution.longMemEval?.session?.recallAnyAt10,
				recallAnyAt50: execution.longMemEval?.session?.recallAnyAt50,
				turnRecallAnyAt10: execution.longMemEval?.turn?.recallAnyAt10,
				turnRecallAnyAt50: execution.longMemEval?.turn?.recallAnyAt50,
				verdict: sidecar.rows?.[execution.caseId]?.verdict,
			})
		}
	}
	return byQuestion
}

async function readCompleteBaselinePopulation(
	checkpointPath: string,
): Promise<Set<string>> {
	const checkpoint = JSON.parse(
		await readFile(checkpointPath, "utf8"),
	) as CheckpointFile
	const sidecar = JSON.parse(
		await readFile(`${checkpointPath}.predictions.json`, "utf8"),
	) as SidecarFile
	const ids = checkpoint.scenarioIds ?? []
	const population = new Set(ids)
	const completed = new Set<string>()
	let complete =
		Array.isArray(ids) &&
		ids.length > 0 &&
		ids.every((id) => typeof id === "string" && id.length > 0) &&
		population.size === ids.length &&
		checkpoint.totalScenarios === ids.length
	for (const scenario of checkpoint.completedScenarios ?? []) {
		const id = scenario.scenarioId
		const lastPass = scenario.executionsByPass?.at(-1) ?? []
		if (
			!id ||
			!population.has(id) ||
			completed.has(id) ||
			lastPass.length !== 1 ||
			lastPass[0]?.caseId !== id
		) {
			complete = false
		}
		if (id) completed.add(id)
	}
	for (const id of population) {
		const row = sidecar.rows?.[id]
		if (
			row?.questionId !== id ||
			row.stage !== "judged" ||
			(row.verdict !== "yes" && row.verdict !== "no")
		) {
			complete = false
		}
	}
	if (!complete || completed.size !== population.size) {
		throw new Error(
			`incomplete baseline coverage: ${checkpointPath}; every declared question must have one completed entry and a matching judged yes/no row`,
		)
	}
	return population
}

function isCorrect(verdict?: string | null): boolean {
	return verdict === "yes"
}

/**
 * Joins two runs per question over paired populations, computes aggregate
 * R/Q deltas, the net recall-question and net correct-answer movements, and
 * the noise-rule verdict.
 */
export function joinB2Runs(
	runA: Map<string, RunQuestionMetrics>,
	runB: Map<string, RunQuestionMetrics>,
	options: JoinB2RunsOptions = {},
): B2JoinReport {
	const questionIds = [...new Set([...runA.keys(), ...runB.keys()])].sort()
	const perQuestion: B2PerQuestionRow[] = []
	const r10Pairs: Array<[number | undefined, number | undefined]> = []
	const r50Pairs: Array<[number | undefined, number | undefined]> = []
	const turnR10Pairs: Array<[number | undefined, number | undefined]> = []
	const turnR50Pairs: Array<[number | undefined, number | undefined]> = []
	const qPairs: Array<[boolean, boolean]> = []
	let rAOnly = 0
	let rBOnly = 0
	for (const questionId of questionIds) {
		const a = runA.get(questionId)
		const b = runB.get(questionId)
		perQuestion.push({
			questionId,
			questionType: b?.questionType ?? a?.questionType,
			abstention: b?.abstention ?? a?.abstention,
			recallAnyAt10A: a?.recallAnyAt10,
			recallAnyAt10B: b?.recallAnyAt10,
			recallAnyAt50A: a?.recallAnyAt50,
			recallAnyAt50B: b?.recallAnyAt50,
			turnRecallAnyAt10A: a?.turnRecallAnyAt10,
			turnRecallAnyAt10B: b?.turnRecallAnyAt10,
			turnRecallAnyAt50A: a?.turnRecallAnyAt50,
			turnRecallAnyAt50B: b?.turnRecallAnyAt50,
			verdictA: a?.verdict,
			verdictB: b?.verdict,
		})
		const aR10 = a?.recallAnyAt10
		const bR10 = b?.recallAnyAt10
		if (aR10 != null && bR10 != null) r10Pairs.push([aR10, bR10])
		else if (aR10 != null) rAOnly += 1
		else if (bR10 != null) rBOnly += 1
		if (a?.recallAnyAt50 != null && b?.recallAnyAt50 != null) {
			r50Pairs.push([a.recallAnyAt50, b.recallAnyAt50])
		}
		if (a?.turnRecallAnyAt10 != null && b?.turnRecallAnyAt10 != null) {
			turnR10Pairs.push([a.turnRecallAnyAt10, b.turnRecallAnyAt10])
		}
		if (a?.turnRecallAnyAt50 != null && b?.turnRecallAnyAt50 != null) {
			turnR50Pairs.push([a.turnRecallAnyAt50, b.turnRecallAnyAt50])
		}
		if (a?.verdict != null && b?.verdict != null) {
			qPairs.push([isCorrect(a.verdict), isCorrect(b.verdict)])
		}
	}
	const r10 = pairedMeanDelta(r10Pairs)
	const r50 = pairedMeanDelta(r50Pairs)
	const turnR10 = pairedMeanDelta(turnR10Pairs)
	const turnR50 = pairedMeanDelta(turnR50Pairs)
	const judgedInBoth = qPairs.length
	const accuracyA =
		judgedInBoth === 0
			? 0
			: qPairs.filter((pair) => pair[0]).length / judgedInBoth
	const accuracyB =
		judgedInBoth === 0
			? 0
			: qPairs.filter((pair) => pair[1]).length / judgedInBoth
	let netQFlips = 0
	for (const [correctA, correctB] of qPairs) {
		if (correctB && !correctA) netQFlips += 1
		if (correctA && !correctB) netQFlips -= 1
	}
	// netR: net recall QUESTIONS over the paired R@10 population (entries
	// are pushed only when both sides are present; ?? 0 satisfies the wide
	// tuple type).
	const netR = r10Pairs.reduce(
		(sum, pair) => sum + ((pair[1] ?? 0) - (pair[0] ?? 0)),
		0,
	)
	const threshold = Math.max(
		B2_NET_Q_FLIP_THRESHOLD,
		(options.baselineFlips ?? 0) + 1,
	)
	const retrievalRealAnswerNeutral =
		Math.abs(netR) >= B2_NET_R_THRESHOLD && netQFlips === 0
	let real: boolean
	let reason: string
	if (options.rOnly) {
		real = Math.abs(netR) >= B2_NET_R_THRESHOLD
		reason = real
			? `r-only: net R@10 ${netR >= 0 ? "+" : ""}${netR} questions reaches the ±${B2_NET_R_THRESHOLD}-question threshold`
			: `r-only: net R@10 ${netR >= 0 ? "+" : ""}${netR} questions stays under the ±${B2_NET_R_THRESHOLD}-question threshold`
	} else if (Math.abs(netQFlips) >= threshold) {
		real = true
		reason = `net Q flips ${netQFlips >= 0 ? "+" : ""}${netQFlips} reach the ±${threshold}-question threshold`
	} else if (
		netR !== 0 &&
		Math.sign(netR) === Math.sign(netQFlips) &&
		Math.abs(netR) >= 2 &&
		Math.abs(netQFlips) >= 1
	) {
		real = true
		reason = `R@10 net ${netR >= 0 ? "+" : ""}${netR} questions and Q net ${netQFlips >= 0 ? "+" : ""}${netQFlips} correct answers move together (|netR| ≥ 2)`
	} else {
		real = false
		reason = `net R@10 ${netR >= 0 ? "+" : ""}${netR} questions and net Q ${netQFlips >= 0 ? "+" : ""}${netQFlips} flips stay inside the noise envelope (threshold ±${threshold})`
	}
	return {
		questionCount: questionIds.length,
		judgedInBoth,
		rPaired: r10.count,
		rUnpaired: { aOnly: rAOnly, bOnly: rBOnly },
		aggregate: {
			recallAnyAt10: { a: r10.a, b: r10.b, delta: r10.delta },
			recallAnyAt50: { a: r50.a, b: r50.b, delta: r50.delta },
			turnRecallAnyAt10: { a: turnR10.a, b: turnR10.b, delta: turnR10.delta },
			turnRecallAnyAt50: { a: turnR50.a, b: turnR50.b, delta: turnR50.delta },
			accuracy: {
				a: accuracyA,
				b: accuracyB,
				delta: judgedInBoth === 0 ? 0 : netQFlips / judgedInBoth,
			},
		},
		netR,
		netQFlips,
		noiseRule: {
			real,
			reason,
			threshold,
			retrievalRealAnswerNeutral,
			rOnly: options.rOnly === true,
		},
		partialQ: {
			judgedInBoth,
			questionCount: questionIds.length,
			incomplete: judgedInBoth < questionIds.length,
		},
		perQuestion,
	}
}

/**
 * Double-baseline flip rate: how many questions changed verdict between two
 * repetitions of the SAME configuration. This is the measured noise floor
 * the noise rule exists to clear; its flip count feeds the threshold T.
 */
export function b2FlipRate(
	baselineA: Map<string, RunQuestionMetrics>,
	baselineB: Map<string, RunQuestionMetrics>,
): { judgedInBoth: number; flips: number; flipRate: number } {
	let judgedInBoth = 0
	let flips = 0
	for (const [questionId, a] of baselineA) {
		const b = baselineB.get(questionId)
		if (a.verdict == null || b?.verdict == null) continue
		judgedInBoth += 1
		if (isCorrect(a.verdict) !== isCorrect(b.verdict)) flips += 1
	}
	return {
		judgedInBoth,
		flips,
		flipRate: judgedInBoth === 0 ? 0 : flips / judgedInBoth,
	}
}

function parseArg(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag)
	const value = argv[index + 1]?.trim()
	return index >= 0 && value && !value.startsWith("--") ? value : undefined
}

/** Pass counts per scenario, used to warn when a checkpoint recorded >1 pass. */
async function readCheckpointPassCounts(
	checkpointPath: string,
): Promise<number[]> {
	const checkpoint = JSON.parse(
		await readFile(checkpointPath, "utf8"),
	) as CheckpointFile
	return (checkpoint.completedScenarios ?? []).map(
		(scenario) => scenario.executionsByPass?.length ?? 0,
	)
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<void> {
	const checkpointA = parseArg(argv, "--a")
	const checkpointB = parseArg(argv, "--b")
	if (!checkpointA || !checkpointB) {
		console.error(
			"usage: bun scripts/benchmark/b2-join.ts --a <checkpoint-a> --b <checkpoint-b> [--baseline-a <ckpt> --baseline-b <ckpt>] [--r-only] [--min-judged <n>]",
		)
		process.exitCode = 1
		return
	}
	const rOnly = argv.includes("--r-only")
	const minJudged = Number.parseInt(parseArg(argv, "--min-judged") ?? "", 10)
	const requireSidecar = !rOnly
	// Sequential (not Promise.all) so a missing-sidecar failure names the
	// first artifact deterministically instead of racing on rejection order.
	const runA = await readB2RunArtifacts(path.resolve(checkpointA), {
		requireSidecar,
	})
	const runB = await readB2RunArtifacts(path.resolve(checkpointB), {
		requireSidecar,
	})
	for (const label of ["a", "b"] as const) {
		const passCounts = await readCheckpointPassCounts(
			path.resolve(label === "a" ? checkpointA : checkpointB),
		)
		if (passCounts.some((count) => count > 1)) {
			console.warn(
				`warning: checkpoint ${label} has scenarios with more than one measurement pass; joining the LAST pass only`,
			)
		}
	}
	const baselineAPath = parseArg(argv, "--baseline-a")
	const baselineBPath = parseArg(argv, "--baseline-b")
	let baselineFlips: number | undefined
	let baselineJudged = 0
	if (baselineAPath && baselineBPath) {
		// Sequential reads: a missing baseline sidecar must name baseline-a
		// deterministically, never race on Promise.all rejection order.
		const baselineA = await readB2RunArtifacts(path.resolve(baselineAPath), {
			requireSidecar: true,
		})
		const baselineB = await readB2RunArtifacts(path.resolve(baselineBPath), {
			requireSidecar: true,
		})
		const rate = b2FlipRate(baselineA, baselineB)
		baselineFlips = rate.flips
		baselineJudged = rate.judgedInBoth
		if (baselineJudged === 0) {
			console.error(
				"error: baseline has no judged questions — a Q-less baseline cannot set the noise gate (flips would be 0)",
			)
			process.exitCode = 1
			return
		}
		const populationA = await readCompleteBaselinePopulation(
			path.resolve(baselineAPath),
		)
		const populationB = await readCompleteBaselinePopulation(
			path.resolve(baselineBPath),
		)
		if (
			populationA.size !== populationB.size ||
			[...populationA].some((id) => !populationB.has(id)) ||
			baselineJudged !== populationA.size
		) {
			throw new Error(
				"incomplete baseline coverage: both baselines must judge the same complete declared population",
			)
		}
		if (rate.flipRate * 50 >= B2_NET_Q_FLIP_THRESHOLD) {
			console.warn(
				`warning: double-baseline flip rate ${rate.flipRate.toFixed(3)} (${rate.flips}/${rate.judgedInBoth}) projects to ≥${B2_NET_Q_FLIP_THRESHOLD} flips at n=50; the loop cannot resolve ${B2_NET_Q_FLIP_THRESHOLD}-question effects at this noise floor`,
			)
		}
	}
	const report = joinB2Runs(runA, runB, { baselineFlips, rOnly })
	if (!rOnly) {
		if (report.judgedInBoth === 0) {
			console.error(
				"error: no questions judged in both runs — the Q side is empty; check that both runs set MEMONGO_BENCHMARK_QA_PROTOCOL=official (or pass --r-only)",
			)
			process.exitCode = 1
			return
		}
		if (report.partialQ.incomplete) {
			console.warn(
				`warning: partial Q join — ${report.judgedInBoth}/${report.questionCount} questions judged in both runs`,
			)
		}
		if (report.rUnpaired.aOnly > 0 || report.rUnpaired.bOnly > 0) {
			console.warn(
				`warning: unpaired R population — a-only ${report.rUnpaired.aOnly}, b-only ${report.rUnpaired.bOnly}; R deltas cover the ${report.rPaired} paired questions only`,
			)
		}
	}
	if (Number.isFinite(minJudged) && report.judgedInBoth < minJudged) {
		console.error(
			`error: judged-in-both ${report.judgedInBoth} is below --min-judged ${minJudged}`,
		)
		process.exitCode = 1
		return
	}
	if (baselineFlips != null) {
		report.flipRate = {
			judgedInBoth: baselineJudged,
			flips: baselineFlips,
			flipRate: baselineJudged === 0 ? 0 : baselineFlips / baselineJudged,
		}
	}
	console.log(JSON.stringify(report, null, 2))
}

const invokedPath = process.argv[1]
if (
	invokedPath &&
	path.resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	})
}
