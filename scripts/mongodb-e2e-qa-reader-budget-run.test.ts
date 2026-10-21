import { describe, expect, it } from "vitest"
import type {
	BenchmarkE2eQaEnvelope,
	BenchmarkGoldSentStatus,
} from "../packages/memory-engine/src/types.js"
import { estimateTokens, type ReaderUnit } from "./benchmark/reader-budget.js"
import type { E2eQaEnvelope } from "./mongodb-e2e-qa.js"
import {
	type Call,
	HERON_UNITS,
	heronCase,
	run,
} from "./mongodb-e2e-qa-reader-budget.fixture.js"
import { readerPositionTerciles } from "./mongodb-e2e-qa-reader-budget.js"

// custom-v3 per-run records: reader budget calibration and accuracy by gold
// position tercile. Fictional strings only.

describe("custom-v3 per-run calibration", () => {
	const second = () =>
		heronCase({
			caseId: "wren",
			question: "Which reeds are tall?",
			goldAnswer: "Brindlewick",
			readerUnits: [HERON_UNITS[1] as ReaderUnit],
		})

	const userTokens = (call: Call | undefined) =>
		estimateTokens(call?.messages[1]?.content ?? "")
	const requestTokens = (call: Call | undefined) =>
		estimateTokens(call?.messages[0]?.content ?? "") + userTokens(call)

	it("divides provider input tokens by the estimated system plus user tokens over calls with usage", async () => {
		const { answers, envelope } = await run(
			[heronCase(), second()],
			[
				{ inputTokens: 300, outputTokens: 5 },
				{ inputTokens: 120, outputTokens: 5 },
			],
		)
		const context = userTokens(answers[0]) + userTokens(answers[1])
		const request = requestTokens(answers[0]) + requestTokens(answers[1])
		expect(request).toBeGreaterThan(context)
		expect(envelope.readerBudgetCalibration).toEqual({
			tokenizer: "js-tiktoken@1.0.21/o200k_base",
			budgetEstimatedTokens: 16_000,
			answerCalls: 2,
			callsWithUsage: 2,
			callsMissingUsage: 0,
			providerInputTokens: 420,
			estimatedContextTokens: context,
			estimatedRequestTokens: request,
			ratio: 420 / request,
			complete: true,
		})
	})

	it("marks the calibration incomplete when any answer call lacked usage", async () => {
		const { answers, envelope } = await run(
			[heronCase(), second()],
			[{ inputTokens: 300, outputTokens: 5 }, undefined],
		)
		expect(envelope.readerBudgetCalibration).toMatchObject({
			answerCalls: 2,
			callsWithUsage: 1,
			callsMissingUsage: 1,
			providerInputTokens: 300,
			estimatedContextTokens: userTokens(answers[0]),
			estimatedRequestTokens: requestTokens(answers[0]),
			ratio: 300 / requestTokens(answers[0]),
			complete: false,
		})
	})
})

describe("custom-v3 accuracy by gold position tercile", () => {
	type CaseResult = BenchmarkE2eQaEnvelope["caseResults"][number]
	const budget = (percentiles: number[]) => ({
		readerBudget: {
			tokenizer: "fixture",
			budgetEstimatedTokens: 100,
			estimatedContextTokens: 100,
			budgetExceededByFirstUnit: false,
			units: { candidates: 1, admitted: 1, deduplicated: 0, skipped: 0 },
			skippedRanks: [],
			providerInputTokens: null,
			providerUsageReported: false,
			goldTurnPositions: percentiles.map((positionPercentile, index) => ({
				turnId: `t-${index}`,
				positionPercentile,
			})),
		},
	})
	const gold = (statuses: BenchmarkGoldSentStatus[]) => ({
		gold: {
			status: "applicable" as const,
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
				candidateDefect: false,
			})),
			counts: {
				candidate: 0,
				present: 0,
				unknown: 0,
				absentSessionNotRetrieved: 0,
			},
		},
	})
	const result = (
		caseId: string,
		correct: boolean,
		fields: Partial<CaseResult> = {},
	): CaseResult => ({
		caseId,
		candidateAnswer: "a fictional answer",
		correct,
		abstention: false,
		latencyMs: 1,
		...fields,
	})

	it("buckets each case by its earliest in-context gold turn and keeps the rest apart", () => {
		const report = readerPositionTerciles([
			result("a", true, {
				...gold(["present", "present"]),
				...budget([50, 10]),
			}),
			result("b", false, { ...gold(["present"]), ...budget([33.4]) }),
			result("c", false, { ...gold(["present"]), ...budget([33.3]) }),
			result("d", true, { ...gold(["present"]), ...budget([66.7]) }),
			result("e", true, { ...gold(["present"]), ...budget([66.6]) }),
			result("f", true, { ...gold(["absent", "absent"]), ...budget([]) }),
			result("g", true, {
				abstention: true,
				gold: {
					status: "not-applicable",
					reason: "abstention",
					sessions: [],
					turns: [],
				},
				...budget([]),
			}),
			result("h", true, { ...gold(["unknown", "absent"]), ...budget([]) }),
			result("i", false, { diagnosticsError: "fixture", ...budget([]) }),
			result("j", false, { error: "retrieval: fixture" }),
		])
		expect(report).toEqual({
			positionRule: "earliest-gold-turn-percentile",
			terciles: {
				start: { cases: 2, correct: 1, accuracy: 0.5 },
				middle: { cases: 2, correct: 1, accuracy: 0.5 },
				end: { cases: 1, correct: 1, accuracy: 1 },
			},
			noGoldTurnInContext: { cases: 2, correct: 2, accuracy: 1 },
			unmeasured: { cases: 3, correct: 1, accuracy: 1 / 3 },
		})
	})

	it("reports a null accuracy for an empty bucket, never zero", () => {
		expect(readerPositionTerciles([]).terciles.start).toEqual({
			cases: 0,
			correct: 0,
			accuracy: null,
		})
	})

	it("is attached to the custom-v3 envelope from the judged case results", async () => {
		const { envelope } = await run([heronCase(), heronCase({ caseId: "wren" })])
		expect(
			(envelope as E2eQaEnvelope).readerPositionTerciles?.unmeasured,
		).toEqual({ cases: 2, correct: 2, accuracy: 1 })
	})
})
