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
 * Inference (B06): the only verdict is an exact two-sided McNemar test on
 * ONE declared endpoint — official judged QA correctness, or binary session
 * R@10 under --r-only — at a fixed diagnostic alpha of 0.05. It is emitted
 * only for eligible comparisons (see b2-join-eligibility.ts): bound run
 * identity, at most one declared scalar treatment, the complete declared
 * population paired, no known clusters, and the question-level independence
 * assumption declared with --assume-independent-questions (recorded as
 * declared, never verified). Ineligible comparisons still print the
 * descriptive join and exit non-zero. A non-significant result is
 * "inconclusive", not equivalence; statistical evidence is not a practical
 * or release win. noiseRule.real mirrors the test for compatibility.
 *
 * Descriptive heuristic (former noise rule, ADR 0011; no longer a verdict):
 *   P_R  = questions with session R@10 in both runs
 *   P_Q  = questions judged in both runs
 *   netR = Σ_P_R (r10B − r10A)     (net recall questions)
 *   netQ = Σ_P_Q (qB − qA)         (net correct answers)
 *   T    = max(3, baselineFlips + 1)   (baselineFlips from the double
 *                                       baseline; 3 until measured)
 *   netR, netQ, T and retrievalRealAnswerNeutral (|netR| ≥ 3, netQ == 0)
 *   are reported as diagnostics only.
 *
 * Q requires the run to have set MEMONGO_BENCHMARK_QA_PROTOCOL=official;
 * a missing prediction sidecar is refused unless --r-only is passed.
 *
 * Usage:
 *   bun scripts/benchmark/b2-join.ts --a <checkpoint-a> --b <checkpoint-b> \
 *     [--baseline-a <ckpt> --baseline-b <ckpt>] [--r-only] [--min-judged <n>]
 *     [--assume-independent-questions] [--treatment <field>]
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
	B2_TREATMENT_FIELDS,
	type B2ComparisonEligibility,
	type B2TreatmentField,
	assessB2Comparison,
	isB2TreatmentField,
	readB2RunIdentity,
} from "./b2-join-eligibility.js"
import { exactMcNemar } from "./paired-inference.js"

export const B2_NET_Q_FLIP_THRESHOLD = 3
export const B2_NET_R_THRESHOLD = 3
/** Fixed diagnostic level for this slice; not a release or practical-margin policy. */
export const B2_INFERENCE_ALPHA = 0.05

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
	datasetSha256?: string
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

export type B2Inference = {
	endpoint: "official-qa-judged-correct" | "session-recall-any-at-10"
	analysisUnit: "question"
	independence: "declared-not-verified" | "not-declared"
	treatment: B2TreatmentField | null
	eligible: boolean
	reasons: string[]
	method?: "exact-mcnemar-two-sided"
	alpha?: number
	/** Complete paired population (the denominator). */
	n?: number
	/** B succeeds where A fails. */
	gains?: number
	/** A succeeds where B fails. */
	losses?: number
	discordant?: number
	pTwoSided?: number
	differenceInProportion?: number
	evidence?: "b-higher" | "a-higher" | "inconclusive"
	practicalSignificance?: "not-assessed"
}

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
	inference: B2Inference
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
	/** No Q sidecar available: binary session R@10 is the declared endpoint. */
	rOnly?: boolean
	/** Artifact-level eligibility; without it no inference is emitted. */
	eligibility?: B2ComparisonEligibility
}

function isBinary(value: number): boolean {
	return value === 0 || value === 1
}

function buildInference(
	questionIds: string[],
	runA: Map<string, RunQuestionMetrics>,
	runB: Map<string, RunQuestionMetrics>,
	options: JoinB2RunsOptions,
): B2Inference {
	const eligibility = options.eligibility
	const endpoint = options.rOnly
		? "session-recall-any-at-10"
		: "official-qa-judged-correct"
	const reasons = eligibility
		? [...eligibility.reasons]
		: [
				"artifact identity was not assessed; typed metrics alone cannot establish a comparable pair",
			]
	if (
		eligibility &&
		eligibility.independence !== "declared-not-verified" &&
		!reasons.some((reason) => reason.includes("independence"))
	)
		reasons.push("question-level independence was not declared")
	let gains = 0
	let losses = 0
	let incomplete = 0
	let nonBinary = 0
	for (const id of questionIds) {
		const a = runA.get(id)
		const b = runB.get(id)
		let successA: boolean
		let successB: boolean
		if (options.rOnly) {
			const ra = a?.recallAnyAt10
			const rb = b?.recallAnyAt10
			if (ra == null || rb == null) {
				incomplete += 1
				continue
			}
			if (!isBinary(ra) || !isBinary(rb)) {
				nonBinary += 1
				continue
			}
			successA = ra === 1
			successB = rb === 1
		} else {
			const va = a?.verdict
			const vb = b?.verdict
			if ((va !== "yes" && va !== "no") || (vb !== "yes" && vb !== "no")) {
				incomplete += 1
				continue
			}
			successA = va === "yes"
			successB = vb === "yes"
		}
		if (successB && !successA) gains += 1
		if (successA && !successB) losses += 1
	}
	if (questionIds.length === 0) reasons.push("no questions to compare")
	if (incomplete > 0)
		reasons.push(
			`incomplete pairs: ${incomplete} of ${questionIds.length} questions lack a paired ${endpoint} outcome`,
		)
	if (nonBinary > 0)
		reasons.push(
			`${nonBinary} question(s) have non-binary recall; the exact test needs 0/1 outcomes`,
		)
	const base = {
		endpoint,
		analysisUnit: "question",
		independence: eligibility?.independence ?? "not-declared",
		treatment: eligibility?.treatment ?? null,
	} as const
	if (eligibility?.eligible !== true || reasons.length > 0)
		return { ...base, eligible: false, reasons }
	const test = exactMcNemar(gains, losses)
	const n = questionIds.length
	return {
		...base,
		eligible: true,
		reasons: [],
		method: "exact-mcnemar-two-sided",
		alpha: B2_INFERENCE_ALPHA,
		n,
		gains,
		losses,
		discordant: test.discordant,
		pTwoSided: test.pTwoSided,
		differenceInProportion: (gains - losses) / n,
		evidence:
			test.pTwoSided > B2_INFERENCE_ALPHA
				? "inconclusive"
				: gains > losses
					? "b-higher"
					: "a-higher",
		practicalSignificance: "not-assessed",
	}
}

function describeInference(inference: B2Inference): string {
	if (!inference.eligible)
		return `no inferential verdict: ${inference.reasons.join("; ")}`
	const test = `exact two-sided McNemar on ${inference.endpoint}: ${inference.gains} B-only vs ${inference.losses} A-only successes over ${inference.n} complete pairs, p=${inference.pTwoSided}`
	return inference.evidence === "inconclusive"
		? `${test}; inconclusive at alpha ${inference.alpha} (not evidence of equivalence)`
		: `${test}; statistical evidence at alpha ${inference.alpha} that ${inference.evidence === "b-higher" ? "B" : "A"} is higher; practical significance not assessed`
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
	const ids = checkpoint.scenarioIds
	if (
		ids !== undefined &&
		(!Array.isArray(ids) ||
			!ids.every((id) => typeof id === "string" && id.length > 0) ||
			new Set(ids).size !== ids.length ||
			(checkpoint.totalScenarios !== undefined &&
				checkpoint.totalScenarios !== ids.length))
	) {
		throw new Error("invalid run coverage: invalid scenario declaration")
	}
	const population = ids === undefined ? undefined : new Set(ids)
	// Other datasets can have several case IDs per declared scenario.
	const questionPopulation =
		population &&
		checkpoint.completedScenarios?.some((scenario) =>
			scenario.executionsByPass
				?.at(-1)
				?.some((execution) => execution.longMemEval),
		)
			? population
			: undefined
	for (const [id, row] of Object.entries(sidecar.rows ?? {})) {
		if (
			!row ||
			typeof row !== "object" ||
			row.questionId !== id ||
			(questionPopulation && !questionPopulation.has(id)) ||
			(row.stage === "judged"
				? row.verdict !== "yes" && row.verdict !== "no"
				: (row.stage !== "answered" && row.stage !== "unreliable") ||
					row.verdict !== null)
		) {
			throw new Error(
				"invalid run coverage: prediction row identity or stage/verdict",
			)
		}
	}
	const byQuestion = new Map<string, RunQuestionMetrics>()
	const completed = new Set<string>()
	for (const scenario of checkpoint.completedScenarios ?? []) {
		const id = scenario.scenarioId
		if (
			(population && (!id || !population.has(id))) ||
			(id && completed.has(id))
		) {
			throw new Error(
				"invalid run coverage: duplicate or unexpected completed scenario",
			)
		}
		if (id) completed.add(id)
		const passes = scenario.executionsByPass ?? []
		const lastPass = passes[passes.length - 1] ?? []
		if (
			questionPopulation &&
			(lastPass.length !== 1 || lastPass[0]?.caseId !== id)
		) {
			throw new Error(
				"invalid run coverage: LongMemEval scenario/case mismatch",
			)
		}
		for (const execution of lastPass) {
			if (!execution.caseId) continue
			if (byQuestion.has(execution.caseId)) {
				throw new Error("invalid run coverage: duplicate selected case ID")
			}
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
	const inference = buildInference(questionIds, runA, runB, options)
	const real = inference.eligible && inference.evidence !== "inconclusive"
	const reason = describeInference(inference)
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
		inference,
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

/** Checkpoint metadata for the dataset gate and measurement-pass warning. */
async function readCheckpointMetadata(
	checkpointPath: string,
): Promise<{ datasetSha256?: string; passCounts: number[] }> {
	const checkpoint = JSON.parse(
		await readFile(checkpointPath, "utf8"),
	) as CheckpointFile
	return {
		datasetSha256: checkpoint.datasetSha256,
		passCounts: (checkpoint.completedScenarios ?? []).map(
			(scenario) => scenario.executionsByPass?.length ?? 0,
		),
	}
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<void> {
	const checkpointA = parseArg(argv, "--a")
	const checkpointB = parseArg(argv, "--b")
	if (!checkpointA || !checkpointB) {
		console.error(
			"usage: bun scripts/benchmark/b2-join.ts --a <checkpoint-a> --b <checkpoint-b> [--baseline-a <ckpt> --baseline-b <ckpt>] [--r-only] [--min-judged <n>] [--assume-independent-questions] [--treatment <field>]",
		)
		process.exitCode = 1
		return
	}
	const rOnly = argv.includes("--r-only")
	const minJudgedValue = parseArg(argv, "--min-judged")
	const minJudged =
		minJudgedValue === undefined ? undefined : Number(minJudgedValue)
	if (
		argv.includes("--min-judged") &&
		(!minJudgedValue ||
			!/^\+?\d+$/.test(minJudgedValue) ||
			!Number.isSafeInteger(minJudged))
	) {
		console.error(
			"error: --min-judged requires a non-negative decimal safe integer",
		)
		process.exitCode = 1
		return
	}
	const treatmentValue = parseArg(argv, "--treatment")
	if (
		argv.includes("--treatment") &&
		(!treatmentValue || !isB2TreatmentField(treatmentValue))
	) {
		console.error(
			`error: --treatment must be one of ${B2_TREATMENT_FIELDS.join(", ")}; opaque digests such as configurationHash or executableDigest cannot be a treatment`,
		)
		process.exitCode = 1
		return
	}
	const treatment: B2TreatmentField | null =
		treatmentValue && isB2TreatmentField(treatmentValue) ? treatmentValue : null
	const requireSidecar = !rOnly
	// Sequential (not Promise.all) so a missing-sidecar failure names the
	// first artifact deterministically instead of racing on rejection order.
	const runA = await readB2RunArtifacts(path.resolve(checkpointA), {
		requireSidecar,
	})
	const runB = await readB2RunArtifacts(path.resolve(checkpointB), {
		requireSidecar,
	})
	const datasetDigests: Array<string | undefined> = []
	for (const label of ["a", "b"] as const) {
		const { datasetSha256, passCounts } = await readCheckpointMetadata(
			path.resolve(label === "a" ? checkpointA : checkpointB),
		)
		datasetDigests.push(datasetSha256)
		if (passCounts.some((count) => count > 1)) {
			console.warn(
				`warning: checkpoint ${label} has scenarios with more than one measurement pass; joining the LAST pass only`,
			)
		}
	}
	const [datasetShaA, datasetShaB] = datasetDigests
	const eligibility = assessB2Comparison({
		a: await readB2RunIdentity(path.resolve(checkpointA)),
		b: await readB2RunIdentity(path.resolve(checkpointB)),
		runA,
		runB,
		treatment,
		independenceDeclared: argv.includes("--assume-independent-questions"),
		rOnly,
		...(minJudged != null ? { minJudged } : {}),
	})
	if (
		datasetShaA &&
		datasetShaB &&
		datasetShaA !== datasetShaB &&
		!eligibility.reasons.some((reason) => reason.startsWith("datasetSha256"))
	) {
		eligibility.eligible = false
		eligibility.reasons.push(
			"dataset digest mismatch: A and B must use the same dataset",
		)
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
	const report = joinB2Runs(runA, runB, { baselineFlips, rOnly, eligibility })
	if (!rOnly) {
		if (report.judgedInBoth === 0) {
			console.error(
				"error: no questions judged in both runs — the Q side is empty; check that both runs set MEMONGO_BENCHMARK_QA_PROTOCOL=official (or pass --r-only)",
			)
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
	if (baselineFlips != null) {
		report.flipRate = {
			judgedInBoth: baselineJudged,
			flips: baselineFlips,
			flipRate: baselineJudged === 0 ? 0 : baselineFlips / baselineJudged,
		}
	}
	console.log(JSON.stringify(report, null, 2))
	if (!report.inference.eligible) {
		console.error(`error: ${report.noiseRule.reason}`)
		process.exitCode = 1
	}
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
