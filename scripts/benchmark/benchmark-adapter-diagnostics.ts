/**
 * Decision 7 (shape table 1197 section 5): value-free diagnostics for the
 * official LongMemEval and LoCoMo adapters. Separate from the generic
 * `rejections` contract, which stays unchanged.
 */
export type BenchmarkAdapterDiagnosticTotals = {
	rejectedTurns: number
	rejectedSessions: number
	emptiedSessions: number
	/** LongMemEval questions and LoCoMo samples. */
	rejectedQuestions: number
	/** LoCoMo only; a LongMemEval QA item is its question. */
	rejectedQaItems: number
	informationalSkips: number
}

export const ADAPTER_DIAGNOSTIC_TOTAL_KEYS = [
	"rejectedTurns",
	"rejectedSessions",
	"emptiedSessions",
	"rejectedQuestions",
	"rejectedQaItems",
	"informationalSkips",
] as const satisfies readonly (keyof BenchmarkAdapterDiagnosticTotals)[]

/** Decision 7 resume rule: an absent side reads as zero totals. */
export function sameAdapterDiagnosticTotals(
	left: BenchmarkAdapterDiagnosticTotals | undefined,
	right: BenchmarkAdapterDiagnosticTotals | undefined,
): boolean {
	return ADAPTER_DIAGNOSTIC_TOTAL_KEYS.every(
		(key) => (left?.[key] ?? 0) === (right?.[key] ?? 0),
	)
}

const REASON_TOTAL = {
	"skipped-empty-turn": "informationalSkips",
	"turn-not-object": "rejectedTurns",
	"turn-invalid-role": "rejectedTurns",
	"turn-invalid-speaker": "rejectedTurns",
	"turn-unknown-speaker": "rejectedTurns",
	"turn-content-not-string": "rejectedTurns",
	"turn-empty-answer-target": "rejectedTurns",
	"turn-empty-evidence": "rejectedTurns",
	"turn-invalid-has-answer": "rejectedTurns",
	"session-not-array": "rejectedSessions",
	"session-gap": "rejectedSessions",
	"session-invalid-key": "rejectedSessions",
	"session-emptied": "emptiedSessions",
	"question-not-object": "rejectedQuestions",
	"question-invalid-id": "rejectedQuestions",
	"question-invalid-text": "rejectedQuestions",
	"question-invalid-sessions": "rejectedQuestions",
	"question-invalid-gold": "rejectedQuestions",
	"question-evidence-unresolved": "rejectedQuestions",
	"question-no-sessions": "rejectedQuestions",
	"question-invalid-session-ids": "rejectedQuestions",
	"question-invalid-evidence": "rejectedQuestions",
	"sample-not-object": "rejectedQuestions",
	"sample-invalid-id": "rejectedQuestions",
	"sample-invalid-conversation": "rejectedQuestions",
	"sample-invalid-qa": "rejectedQuestions",
	"sample-invalid-speakers": "rejectedQuestions",
	"qa-not-object": "rejectedQaItems",
	"qa-invalid-question": "rejectedQaItems",
	"qa-invalid-gold": "rejectedQaItems",
	"qa-invalid-evidence": "rejectedQaItems",
	"qa-evidence-unresolved": "rejectedQaItems",
	"qa-invalid-category": "rejectedQaItems",
} as const satisfies Record<string, keyof BenchmarkAdapterDiagnosticTotals>

export type BenchmarkAdapterDiagnosticReason = keyof typeof REASON_TOTAL

/** Coordinates are raw source indices; optional ones are absent, never undefined. */
export type BenchmarkAdapterDiagnostic = {
	format: "longmemeval" | "locomo"
	questionIndex?: number
	sampleIndex?: number
	sessionIndex?: number
	turnIndex?: number
	qaIndex?: number
	reason: BenchmarkAdapterDiagnosticReason
}

export type BenchmarkAdapterDiagnostics = {
	/** Raw document order. */
	entries: BenchmarkAdapterDiagnostic[]
	totals: BenchmarkAdapterDiagnosticTotals
}

export function summarizeAdapterDiagnostics(
	entries: BenchmarkAdapterDiagnostic[],
): BenchmarkAdapterDiagnostics {
	const totals: BenchmarkAdapterDiagnosticTotals = {
		rejectedTurns: 0,
		rejectedSessions: 0,
		emptiedSessions: 0,
		rejectedQuestions: 0,
		rejectedQaItems: 0,
		informationalSkips: 0,
	}
	for (const entry of entries) totals[REASON_TOTAL[entry.reason]]++
	return { entries, totals }
}

/** Decision 7 mapping into the existing completeness counters; skips and emptied sessions add to neither (OPEN-10 B). */
export function countAdapterRejections(
	diagnostics: BenchmarkAdapterDiagnostics | undefined,
): { rejectedTurns: number; rejectedConversations: number } {
	const totals = diagnostics?.totals
	return {
		rejectedTurns: totals?.rejectedTurns ?? 0,
		rejectedConversations:
			(totals?.rejectedSessions ?? 0) +
			(totals?.rejectedQuestions ?? 0) +
			(totals?.rejectedQaItems ?? 0),
	}
}

export type BenchmarkAdapterFailureReason =
	| "format-ambiguous"
	| "duplicate-question-id"
	| "duplicate-session-mismatch"
	| "generated-id-collision"
	| "duplicate-sample-id"
	| "duplicate-dialog-id"
	| "all-rejected"

/**
 * Fail-closed admission (OPEN-2 B): thrown before anything is returned, so
 * nothing is written. Value-free; only `all-rejected` carries diagnostics.
 */
export class BenchmarkAdapterRejectedError extends Error {
	readonly reason: BenchmarkAdapterFailureReason
	// `declare` keeps the key absent, not undefined, on identity failures.
	declare readonly adapterDiagnostics?: BenchmarkAdapterDiagnostics

	constructor(
		reason: BenchmarkAdapterFailureReason,
		adapterDiagnostics?: BenchmarkAdapterDiagnostics,
	) {
		super(
			`benchmark dataset admission failed before any write: ${reason}${
				adapterDiagnostics
					? ` (${Object.entries(adapterDiagnostics.totals)
							.map(([key, value]) => `${key}=${value}`)
							.join(", ")})`
					: ""
			}`,
		)
		this.name = "BenchmarkAdapterRejectedError"
		this.reason = reason
		if (adapterDiagnostics) this.adapterDiagnostics = adapterDiagnostics
	}
}
