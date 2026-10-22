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
import type { EnrichmentChatUsage } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	BenchmarkE2eQaEnvelope,
	BenchmarkHiddenOutputTokensUnavailableReason,
} from "../../packages/memory-engine/src/types.js"
import { LENGTH_FINISH_REASONS } from "../mongodb-e2e-qa-answer-attempt.js"
import { hiddenOutputTokens } from "../mongodb-e2e-qa-calls.js"
import type { BenchmarkArm } from "./benchmark-arms.js"
import { exactMcNemar } from "./paired-inference.js"

export type ArmCaseResult = BenchmarkE2eQaEnvelope["caseResults"][number]
export type ArmVerdict = "correct" | "incorrect" | "missing"

export type TokenTotals = {
	inputTokens: number
	outputTokens: number
	/** Ended calls whose transport reported no usage; never read as zero. */
	callsWithoutUsage: number
	/** Sum of the provider's reported total_tokens. */
	totalTokens: number
	/**
	 * Billed but unreported output (a thinking model's thoughts), summed over
	 * the calls where total, prompt and completion were all reported.
	 */
	hiddenOutputTokens: number
	/** Ended calls with no hidden-token figure, by reason. */
	hiddenOutputTokensUnavailable: Partial<
		Record<BenchmarkHiddenOutputTokensUnavailableReason, number>
	>
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
	/** Answers whose provider stopped at the token limit (length, max_tokens). */
	lengthFinishAnswers: number
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

export const emptyTokenTotals = (): TokenTotals => ({
	inputTokens: 0,
	outputTokens: 0,
	callsWithoutUsage: 0,
	totalTokens: 0,
	hiddenOutputTokens: 0,
	hiddenOutputTokensUnavailable: {},
})

/** Add one ended call's reported usage to the totals. */
export function addCallTokens(
	totals: TokenTotals,
	usage: EnrichmentChatUsage | undefined,
): void {
	if (usage) {
		totals.inputTokens += usage.inputTokens
		totals.outputTokens += usage.outputTokens
		totals.totalTokens += usage.totalTokens ?? 0
	} else {
		totals.callsWithoutUsage += 1
	}
	const hidden = hiddenOutputTokens(usage)
	if (hidden.hiddenOutputTokens === null) {
		const missing = totals.hiddenOutputTokensUnavailable
		missing[hidden.reason] = (missing[hidden.reason] ?? 0) + 1
	} else {
		totals.hiddenOutputTokens += hidden.hiddenOutputTokens
	}
}

export function sumTokenTotals(values: readonly TokenTotals[]): TokenTotals {
	return values.reduce((sum, value) => {
		const missing = { ...sum.hiddenOutputTokensUnavailable }
		for (const [reason, count] of Object.entries(
			value.hiddenOutputTokensUnavailable,
		) as Array<[BenchmarkHiddenOutputTokensUnavailableReason, number]>) {
			missing[reason] = (missing[reason] ?? 0) + count
		}
		return {
			inputTokens: sum.inputTokens + value.inputTokens,
			outputTokens: sum.outputTokens + value.outputTokens,
			callsWithoutUsage: sum.callsWithoutUsage + value.callsWithoutUsage,
			totalTokens: sum.totalTokens + value.totalTokens,
			hiddenOutputTokens: sum.hiddenOutputTokens + value.hiddenOutputTokens,
			hiddenOutputTokensUnavailable: missing,
		}
	}, emptyTokenTotals())
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
			lengthFinishAnswers: entry.caseResults.filter((result) => {
				const reason = result.answerAttempt?.finishReason
				return reason !== undefined && LENGTH_FINISH_REASONS.has(reason)
			}).length,
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
