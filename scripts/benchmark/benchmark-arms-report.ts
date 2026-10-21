/**
 * Paired report over benchmark arms that answered the same questions from
 * the same stored data. Each arm is compared with the first (the baseline)
 * on the questions where both recorded a verdict: the 2x2 counts and an
 * exact two-sided McNemar p over the discordant pairs (paired-inference.ts).
 *
 * A verdict is recorded when the answer and the judge both returned. An
 * unparseable or refused answer or judge response is a recorded INCORRECT
 * verdict and is counted as a parse failure. A retrieval failure or a
 * transport failure records no verdict, so that pair is left out.
 */
import type { BenchmarkE2eQaEnvelope } from "../../packages/memory-engine/src/types.js"
import type { BenchmarkArm } from "./benchmark-arms.js"
import { exactMcNemar } from "./paired-inference.js"

export type ArmCaseResult = BenchmarkE2eQaEnvelope["caseResults"][number]
export type ArmVerdict = "correct" | "incorrect" | "missing"

export type TokenTotals = {
	inputTokens: number
	outputTokens: number
	/** Ended calls whose transport reported no usage; never read as zero. */
	callsWithoutUsage: number
}
/** Judge totals include the decoy probe's judge calls. */
export type ArmTokenTotals = { answer: TokenTotals; judge: TokenTotals }

export type PairedArmSummary = {
	name: string
	protocol: BenchmarkArm["protocol"]
	sessionTurnRecall: boolean
	configurationHash: string
	questions: number
	verdicts: number
	correct: number
	/** correct / verdicts; null when the arm recorded no verdict. */
	accuracy: number | null
	parseFailures: number
	missingVerdicts: number
	tokens: ArmTokenTotals
}

export type PairedArmComparison = {
	baseline: string
	arm: string
	pairs: number
	bothCorrect: number
	baselineOnly: number
	armOnly: number
	bothWrong: number
	/** Questions where either arm recorded no verdict. */
	unpaired: number
	baselineAccuracy: number | null
	armAccuracy: number | null
	mcnemar: { discordant: number; pTwoSided: number }
}

export type PairedArmsReport = {
	baseline: string
	arms: PairedArmSummary[]
	comparisons: PairedArmComparison[]
	perQuestion: Array<{ caseId: string; verdicts: Record<string, ArmVerdict> }>
}

const NO_VERDICT_ERRORS = new Set([
	"answer-generation: transport-failure",
	"answer-judge: transport-failure",
])

export function armCaseVerdict(result: ArmCaseResult | undefined): {
	verdict: ArmVerdict
	parseFailure: boolean
} {
	const error = result?.error
	if (
		!result ||
		(error !== undefined &&
			(NO_VERDICT_ERRORS.has(error) || error.startsWith("retrieval:")))
	) {
		return { verdict: "missing", parseFailure: false }
	}
	if (
		error?.startsWith("answer-generation:") ||
		error?.startsWith("answer-judge:")
	) {
		return { verdict: "incorrect", parseFailure: true }
	}
	return {
		verdict: result.correct ? "correct" : "incorrect",
		parseFailure: false,
	}
}

export function buildPairedArmsReport(params: {
	caseIds: readonly string[]
	arms: ReadonlyArray<{
		arm: BenchmarkArm
		configurationHash: string
		caseResults: readonly ArmCaseResult[]
		tokens: ArmTokenTotals
	}>
}): PairedArmsReport {
	const classified = params.arms.map((entry) => {
		const byCaseId = new Map(
			entry.caseResults.map((result) => [result.caseId, result]),
		)
		return params.caseIds.map((caseId) => armCaseVerdict(byCaseId.get(caseId)))
	})
	const arms = params.arms.map((entry, index): PairedArmSummary => {
		const rows = classified[index] ?? []
		const verdicts = rows.filter((row) => row.verdict !== "missing").length
		const correct = rows.filter((row) => row.verdict === "correct").length
		return {
			name: entry.arm.name,
			protocol: entry.arm.protocol,
			sessionTurnRecall: entry.arm.sessionTurnRecall,
			configurationHash: entry.configurationHash,
			questions: params.caseIds.length,
			verdicts,
			correct,
			accuracy: verdicts > 0 ? correct / verdicts : null,
			parseFailures: rows.filter((row) => row.parseFailure).length,
			missingVerdicts: params.caseIds.length - verdicts,
			tokens: entry.tokens,
		}
	})
	const baseline = params.arms[0]
	if (!baseline) {
		throw new Error("paired report needs a baseline arm; got no arms")
	}
	const baselineName = baseline.arm.name
	const baselineRows = classified[0] ?? []
	const comparisons = params.arms.slice(1).map((entry, offset) => {
		const rows = classified[offset + 1] ?? []
		let bothCorrect = 0
		let baselineOnly = 0
		let armOnly = 0
		let bothWrong = 0
		params.caseIds.forEach((_, index) => {
			const base = baselineRows[index]?.verdict ?? "missing"
			const other = rows[index]?.verdict ?? "missing"
			if (base === "missing" || other === "missing") return
			if (base === "correct" && other === "correct") bothCorrect += 1
			else if (base === "correct") baselineOnly += 1
			else if (other === "correct") armOnly += 1
			else bothWrong += 1
		})
		const pairs = bothCorrect + baselineOnly + armOnly + bothWrong
		const test = exactMcNemar(armOnly, baselineOnly)
		return {
			baseline: baselineName,
			arm: entry.arm.name,
			pairs,
			bothCorrect,
			baselineOnly,
			armOnly,
			bothWrong,
			unpaired: params.caseIds.length - pairs,
			baselineAccuracy: pairs > 0 ? (bothCorrect + baselineOnly) / pairs : null,
			armAccuracy: pairs > 0 ? (bothCorrect + armOnly) / pairs : null,
			mcnemar: { discordant: test.discordant, pTwoSided: test.pTwoSided },
		}
	})
	return {
		baseline: baselineName,
		arms,
		comparisons,
		perQuestion: params.caseIds.map((caseId, index) => ({
			caseId,
			verdicts: Object.fromEntries(
				params.arms.map((entry, armIndex) => [
					entry.arm.name,
					classified[armIndex]?.[index]?.verdict ?? "missing",
				]),
			),
		})),
	}
}
