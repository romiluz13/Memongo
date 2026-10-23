import type {
	BenchmarkE2eQaEnvelope,
	MemoryBenchmarkQuestionTypeMetrics,
	MemoryBenchmarkReaderCutMetrics,
} from "../../packages/memory-engine/src/types.js"
import { isAbstaining } from "../mongodb-e2e-qa.js"
import { CONTEXT_MATCH_RULE } from "./benchmark-context-diagnostics.js"

/**
 * C-5: gold-turn recall at the reader cut and abstention validity, per
 * question type and pooled. Computed from the judged case results after the
 * run (the containment-v2 sent status and the harness's own abstention
 * rule); nothing here feeds selection.
 */

type CaseResult = BenchmarkE2eQaEnvelope["caseResults"][number]

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null)

type Evidence =
	keyof MemoryBenchmarkReaderCutMetrics["abstention"]["falseAbstentionsByEvidence"]

function goldEvidence(result: CaseResult): Evidence {
	const turns = result.gold?.status === "applicable" ? result.gold.turns : []
	if (turns.length === 0) return "goldUnknown"
	if (turns.every((turn) => turn.sentStatus === "present")) {
		return "allGoldPresent"
	}
	if (turns.some((turn) => turn.sentStatus === "unknown")) return "goldUnknown"
	if (turns.some((turn) => turn.sentStatus === "present")) {
		return "someGoldPresent"
	}
	return "noGoldPresent"
}

const isPhraseAbstention = (result: CaseResult) =>
	result.candidateAnswer.trim() !== "" && isAbstaining(result.candidateAnswer)

function summarize(results: CaseResult[]): MemoryBenchmarkReaderCutMetrics {
	const turns = results.flatMap((result) =>
		result.gold?.status === "applicable" ? [result.gold.turns] : [],
	)
	const statuses = turns.flat().map((turn) => turn.sentStatus)
	const count = (status: string) => statuses.filter((s) => s === status).length
	const completed = results.filter((result) => result.error === undefined)
	const abstention = completed.filter((result) => result.abstention)
	const answerable = completed.filter((result) => !result.abstention)
	const correctAbstentions = abstention.filter((r) => r.correct).length
	const abstaining = answerable.filter((r) => isAbstaining(r.candidateAnswer))
	const falseAbstentions = abstaining.length
	const byEvidence = (evidence: Evidence) =>
		abstaining.filter((r) => goldEvidence(r) === evidence).length
	return {
		goldTurns: {
			cases: turns.length,
			marked: statuses.length,
			present: count("present"),
			absent: count("absent"),
			unknown: count("unknown"),
			recall: rate(count("present"), statuses.length),
		},
		abstention: {
			abstentionCases: abstention.length,
			correctAbstentions,
			correctAbstentionRate: rate(correctAbstentions, abstention.length),
			answerableCases: answerable.length,
			falseAbstentions,
			falseAbstentionRate: rate(falseAbstentions, answerable.length),
			failedCases: results.length - completed.length,
			falseAbstentionsByEvidence: {
				allGoldPresent: byEvidence("allGoldPresent"),
				someGoldPresent: byEvidence("someGoldPresent"),
				noGoldPresent: byEvidence("noGoldPresent"),
				goldUnknown: byEvidence("goldUnknown"),
			},
			phraseAbstentions: {
				abstentionCases: abstention.filter(isPhraseAbstention).length,
				answerableCases: answerable.filter(isPhraseAbstention).length,
			},
		},
	}
}

/**
 * Adds the metrics to the QA envelope (pooled and per type) and to each
 * matching `questionTypeBreakdown` row. Question types use the breakdown's
 * key (trimmed, `untyped` when blank). No case results: inputs unchanged.
 */
export function attachReaderCutMetrics<
	Envelope extends BenchmarkE2eQaEnvelope | undefined,
>(params: {
	e2eQa: Envelope
	breakdown: MemoryBenchmarkQuestionTypeMetrics[]
	questionTypeByCaseId: Map<string, string | undefined>
}): {
	e2eQa: Envelope
	breakdown: MemoryBenchmarkQuestionTypeMetrics[]
} {
	const caseResults = params.e2eQa?.caseResults ?? []
	if (!params.e2eQa || caseResults.length === 0) {
		return { e2eQa: params.e2eQa, breakdown: params.breakdown }
	}
	const groups = new Map<string, CaseResult[]>()
	for (const result of caseResults) {
		const key =
			params.questionTypeByCaseId.get(result.caseId)?.trim() || "untyped"
		groups.set(key, [...(groups.get(key) ?? []), result])
	}
	const byQuestionType = [...groups.entries()]
		.map(([questionType, results]) => ({
			questionType,
			...summarize(results),
		}))
		.toSorted((a, b) => a.questionType.localeCompare(b.questionType))
	const byType = new Map(byQuestionType.map((row) => [row.questionType, row]))
	return {
		e2eQa: {
			...params.e2eQa,
			readerCut: {
				goldTurnMatchRule: CONTEXT_MATCH_RULE,
				overall: summarize(caseResults),
				byQuestionType,
			},
		},
		breakdown: params.breakdown.map((row) => {
			const metrics = byType.get(row.questionType)
			if (!metrics) return row
			const { questionType: _, ...readerCut } = metrics
			return { ...row, readerCut }
		}),
	}
}
