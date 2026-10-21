import type {
	BenchmarkCaseContextDiagnostics,
	BenchmarkReaderBudgetCalibration,
	BenchmarkReaderBudgetCaseRecord,
} from "../packages/memory-engine/src/types.js"
import {
	buildCaseContextDiagnostics,
	type Pass0ContextDiagnostics,
} from "./benchmark/benchmark-context-diagnostics.js"
import {
	estimateTokens,
	READER_BUDGET_TOKENIZER,
	type ReaderContext,
	type ReaderUnit,
} from "./benchmark/reader-budget.js"
import { ANSWER_SYSTEM_PROMPT } from "./mongodb-e2e-qa-calls.js"

/**
 * custom-v3 (D) recording: what the reader budget admitted for a case and
 * what the provider reported for the same answer call. Observation only;
 * nothing here feeds admission or a prompt, and gold is read only here,
 * after the answer request was built.
 */

/** Input tokens the answer call reported; null when it reported none. */
export type AnswerCallUsage = { inputTokens: number | null }

/**
 * The budget covers the user content only (`estimatedContextTokens`); the
 * provider counts the whole request, so calibration divides by the estimate
 * of the system prompt plus the user content (`estimatedRequestTokens`).
 */
export type ReaderBudgetCaseRecord = BenchmarkReaderBudgetCaseRecord & {
	estimatedRequestTokens: number
}

export type ReaderBudgetCalibration = BenchmarkReaderBudgetCalibration & {
	estimatedRequestTokens: number
}

const SYSTEM_PROMPT_ESTIMATED_TOKENS = estimateTokens(ANSWER_SYSTEM_PROMPT)

/**
 * Context diagnostics over the admitted units, in presentation order.
 * `diagnostics.sentCandidates` is index-aligned with `readerUnits`.
 */
export function buildReaderCaseDiagnostics(
	readerUnits: readonly ReaderUnit[],
	diagnostics: Pass0ContextDiagnostics,
	reader: ReaderContext,
): BenchmarkCaseContextDiagnostics {
	if (diagnostics.sentCandidates.length !== readerUnits.length) {
		throw new Error(
			`diagnostics describe ${diagnostics.sentCandidates.length} units but the case has ${readerUnits.length}`,
		)
	}
	const sentCandidates = reader.admitted.map((unit) => {
		const lineage = diagnostics.sentCandidates[readerUnits.indexOf(unit)]
		if (!lineage) throw new Error(`admitted unit ${unit.id} has no lineage`)
		return lineage
	})
	return buildCaseContextDiagnostics({
		contextPassages: reader.admitted.map((unit) => unit.passage),
		maxPassages: reader.admitted.length,
		diagnostics: { ...diagnostics, sentCandidates },
	})
}

function goldTurnPositions(
	diagnostics: BenchmarkCaseContextDiagnostics,
	reader: ReaderContext,
): BenchmarkReaderBudgetCaseRecord["goldTurnPositions"] {
	if (diagnostics.gold?.status !== "applicable") return []
	return diagnostics.gold.turns.flatMap((turn) => {
		if (turn.sentStatus !== "present" || turn.sentRank === null) return []
		const offset = reader.admittedOffsets[turn.sentRank - 1] as number
		const before = estimateTokens(reader.userContent.slice(0, offset))
		return [
			{
				turnId: turn.turnId,
				positionPercentile: (100 * before) / reader.estimatedContextTokens,
			},
		]
	})
}

export function readerBudgetCaseRecord(
	reader: ReaderContext,
	usage: AnswerCallUsage,
	diagnostics: BenchmarkCaseContextDiagnostics,
): ReaderBudgetCaseRecord {
	return {
		tokenizer: READER_BUDGET_TOKENIZER,
		budgetEstimatedTokens: reader.budgetEstimatedTokens,
		estimatedContextTokens: reader.estimatedContextTokens,
		estimatedRequestTokens:
			SYSTEM_PROMPT_ESTIMATED_TOKENS + reader.estimatedContextTokens,
		budgetExceededByFirstUnit: reader.budgetExceededByFirstUnit,
		units: reader.counts,
		skippedRanks: reader.skippedRanks,
		providerInputTokens: usage.inputTokens,
		providerUsageReported: usage.inputTokens !== null,
		goldTurnPositions: goldTurnPositions(diagnostics, reader),
	}
}

/** Calibration over the answer calls recorded in the case results. */
export function readerBudgetCalibration(
	records: readonly ReaderBudgetCaseRecord[],
	budgetEstimatedTokens: number,
): ReaderBudgetCalibration {
	const reported = records.filter((record) => record.providerUsageReported)
	const providerInputTokens = reported.reduce(
		(sum, record) => sum + (record.providerInputTokens as number),
		0,
	)
	const estimatedContextTokens = reported.reduce(
		(sum, record) => sum + record.estimatedContextTokens,
		0,
	)
	const estimatedRequestTokens = reported.reduce(
		(sum, record) => sum + record.estimatedRequestTokens,
		0,
	)
	return {
		tokenizer: READER_BUDGET_TOKENIZER,
		budgetEstimatedTokens,
		answerCalls: records.length,
		callsWithUsage: reported.length,
		callsMissingUsage: records.length - reported.length,
		providerInputTokens,
		estimatedContextTokens,
		estimatedRequestTokens,
		ratio:
			estimatedRequestTokens > 0
				? providerInputTokens / estimatedRequestTokens
				: null,
		complete: reported.length === records.length,
	}
}
