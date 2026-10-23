import { describe, expect, it } from "vitest"
import type {
	BenchmarkE2eQaEnvelope,
	BenchmarkGoldSentStatus,
	MemoryBenchmarkQuestionTypeMetrics,
} from "../../packages/memory-engine/src/types.js"
import { attachReaderCutMetrics } from "./benchmark-reader-cut-metrics.js"

// C-5: gold-turn recall at the reader cut and abstention validity, per
// category, computed from case results only. Hand-built, fictional cases.

type CaseResult = BenchmarkE2eQaEnvelope["caseResults"][number]

function goldTurns(statuses: BenchmarkGoldSentStatus[]): Partial<CaseResult> {
	return {
		matchRule: "containment-v2",
		gold: {
			status: "applicable",
			sessions: [],
			turns: statuses.map((sentStatus, turnIndex) => ({
				admittedSessionIndex: 0,
				sessionId: "s-1",
				turnIndex,
				turnId: `t-${turnIndex}`,
				retrieved: true,
				retrievedRank: 1,
				sentRank: sentStatus === "present" ? 1 : null,
				sentStatus,
				sessionRetrieved: true,
				candidateDefect: sentStatus === "absent",
			})),
			counts: {
				candidate: 0,
				present: 0,
				unknown: 0,
				absentSessionNotRetrieved: 0,
			},
		},
	}
}

function result(
	caseId: string,
	fields: Partial<CaseResult> & { abstention: boolean },
): CaseResult {
	return {
		caseId,
		candidateAnswer: "a fictional answer",
		correct: false,
		latencyMs: 1,
		...fields,
	}
}

const caseResults: CaseResult[] = [
	result("t1", {
		abstention: false,
		correct: true,
		...goldTurns(["present", "absent"]),
	}),
	result("t2", {
		abstention: false,
		candidateAnswer: "I don't know",
		...goldTurns(["unknown", "present"]),
	}),
	result("t3", {
		abstention: true,
		candidateAnswer: "I don't know",
		correct: true,
	}),
	result("t4", { abstention: true, candidateAnswer: "The lighthouse" }),
	result("t5", {
		abstention: false,
		candidateAnswer: "",
		error: "answer-generation: transport",
		...goldTurns(["absent"]),
	}),
	result("u1", { abstention: false, correct: true, ...goldTurns(["present"]) }),
	result("u2", {
		abstention: true,
		candidateAnswer: "",
		error: "retrieval: down",
	}),
	result("u3", {
		abstention: false,
		correct: true,
		diagnosticsError: "lineage",
	}),
]

const questionTypeByCaseId = new Map([
	["t1", "temporal-reasoning"],
	["t2", "temporal-reasoning"],
	["t3", "temporal-reasoning"],
	["t4", "temporal-reasoning"],
	["t5", "temporal-reasoning"],
	["u1", "single-session-user"],
	["u2", "single-session-user"],
	["u3", "single-session-user"],
])

function breakdownRow(
	questionType: string,
): MemoryBenchmarkQuestionTypeMetrics {
	return {
		questionType,
		cases: 1,
		succeededCases: 1,
		failedCases: 0,
		retrievalEligibleCases: 1,
		scoredCases: 1,
		hitRate: 1,
		rAt5: 1,
		rAt10: 1,
		ndcgAt10: 1,
	}
}

const envelope = {
	caseResults,
} as unknown as BenchmarkE2eQaEnvelope

describe("reader-cut metrics", () => {
	it("computes gold-turn recall and abstention validity per category", () => {
		const { breakdown } = attachReaderCutMetrics({
			e2eQa: envelope,
			breakdown: [
				breakdownRow("single-session-user"),
				breakdownRow("temporal-reasoning"),
				breakdownRow("knowledge-update"),
			],
			questionTypeByCaseId,
		})
		const byType = new Map(breakdown.map((row) => [row.questionType, row]))
		expect(byType.get("temporal-reasoning")?.readerCut).toEqual({
			goldTurns: {
				cases: 3,
				marked: 5,
				present: 2,
				absent: 2,
				unknown: 1,
				recall: 0.4,
			},
			abstention: {
				abstentionCases: 2,
				correctAbstentions: 1,
				correctAbstentionRate: 0.5,
				answerableCases: 2,
				falseAbstentions: 1,
				falseAbstentionRate: 0.5,
				failedCases: 1,
				falseAbstentionsByEvidence: {
					allGoldPresent: 0,
					someGoldPresent: 0,
					noGoldPresent: 0,
					goldUnknown: 1,
				},
				phraseAbstentions: { abstentionCases: 1, answerableCases: 1 },
			},
		})
		expect(byType.get("single-session-user")?.readerCut).toEqual({
			goldTurns: {
				cases: 1,
				marked: 1,
				present: 1,
				absent: 0,
				unknown: 0,
				recall: 1,
			},
			abstention: {
				abstentionCases: 0,
				correctAbstentions: 0,
				correctAbstentionRate: null,
				answerableCases: 2,
				falseAbstentions: 0,
				falseAbstentionRate: 0,
				failedCases: 1,
				falseAbstentionsByEvidence: {
					allGoldPresent: 0,
					someGoldPresent: 0,
					noGoldPresent: 0,
					goldUnknown: 0,
				},
				phraseAbstentions: { abstentionCases: 0, answerableCases: 0 },
			},
		})
		expect(byType.get("knowledge-update")).toEqual(
			breakdownRow("knowledge-update"),
		)
	})

	it("reports the pooled run on the QA envelope with its frozen rules", () => {
		const { e2eQa } = attachReaderCutMetrics({
			e2eQa: envelope,
			breakdown: [],
			questionTypeByCaseId,
		})
		expect(e2eQa?.readerCut?.goldTurnMatchRule).toBe("containment-v2")
		expect(e2eQa?.readerCut?.overall).toEqual({
			goldTurns: {
				cases: 4,
				marked: 6,
				present: 3,
				absent: 2,
				unknown: 1,
				recall: 0.5,
			},
			abstention: {
				abstentionCases: 2,
				correctAbstentions: 1,
				correctAbstentionRate: 0.5,
				answerableCases: 4,
				falseAbstentions: 1,
				falseAbstentionRate: 0.25,
				failedCases: 2,
				falseAbstentionsByEvidence: {
					allGoldPresent: 0,
					someGoldPresent: 0,
					noGoldPresent: 0,
					goldUnknown: 1,
				},
				phraseAbstentions: { abstentionCases: 1, answerableCases: 1 },
			},
		})
		expect(
			e2eQa?.readerCut?.byQuestionType.map((row) => row.questionType),
		).toEqual(["single-session-user", "temporal-reasoning"])
	})

	it("leaves a run without case results untouched", () => {
		const empty = { caseResults: [] } as unknown as BenchmarkE2eQaEnvelope
		const rows = [breakdownRow("temporal-reasoning")]
		expect(
			attachReaderCutMetrics({
				e2eQa: empty,
				breakdown: rows,
				questionTypeByCaseId,
			}),
		).toEqual({ e2eQa: empty, breakdown: rows })
		expect(
			attachReaderCutMetrics({
				e2eQa: undefined,
				breakdown: rows,
				questionTypeByCaseId,
			}),
		).toEqual({ e2eQa: undefined, breakdown: rows })
	})
})

describe("false abstentions by evidence and phrase abstentions", () => {
	const notApplicable: Partial<CaseResult> = {
		gold: {
			status: "not-applicable",
			reason: "no-has-answer-marker",
			sessions: [],
			turns: [],
		},
	}
	const answerable = (
		caseId: string,
		candidateAnswer: string,
		fields: Partial<CaseResult> = {},
	) => result(caseId, { abstention: false, candidateAnswer, ...fields })
	const cases: CaseResult[] = [
		answerable("f1", ""),
		answerable("f2", "", notApplicable),
		answerable("f3", "", goldTurns([])),
		answerable("f4", "", goldTurns(["present", "present"])),
		answerable(
			"f5",
			"Not mentioned in the context.",
			goldTurns(["present", "absent"]),
		),
		answerable("f6", "", goldTurns(["absent", "absent"])),
		answerable("f7", "", goldTurns(["present", "unknown"])),
		answerable("f8", "By the mill pond", goldTurns(["absent"])),
		answerable("f9", "", {
			error: "answer-generation: truncated",
			...goldTurns(["present"]),
		}),
		result("f10", {
			abstention: true,
			candidateAnswer: "Unknown.",
			correct: true,
		}),
		result("f11", { abstention: true, candidateAnswer: "", correct: true }),
	]
	const overall = () =>
		attachReaderCutMetrics({
			e2eQa: { caseResults: cases } as unknown as BenchmarkE2eQaEnvelope,
			breakdown: [],
			questionTypeByCaseId: new Map(),
		}).e2eQa?.readerCut?.overall.abstention

	it("splits false abstentions by gold evidence in precedence order", () => {
		const abstention = overall()
		expect(abstention?.falseAbstentions).toBe(7)
		expect(abstention?.falseAbstentionsByEvidence).toEqual({
			allGoldPresent: 1,
			someGoldPresent: 1,
			noGoldPresent: 1,
			goldUnknown: 4,
		})
		const split = abstention?.falseAbstentionsByEvidence
		expect(
			(split?.allGoldPresent ?? 0) +
				(split?.someGoldPresent ?? 0) +
				(split?.noGoldPresent ?? 0) +
				(split?.goldUnknown ?? 0),
		).toBe(abstention?.falseAbstentions)
	})

	it("counts non-empty abstaining answers, each count at most its parent", () => {
		const abstention = overall()
		expect(abstention?.phraseAbstentions).toEqual({
			abstentionCases: 1,
			answerableCases: 1,
		})
		expect(abstention?.phraseAbstentions.abstentionCases).toBeLessThanOrEqual(
			abstention?.correctAbstentions ?? -1,
		)
		expect(abstention?.phraseAbstentions.answerableCases).toBeLessThanOrEqual(
			abstention?.falseAbstentions ?? -1,
		)
	})
})
