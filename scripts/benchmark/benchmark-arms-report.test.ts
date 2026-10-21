import { describe, expect, it } from "vitest"
import {
	type ArmCaseResult,
	type ArmTokenTotals,
	armCaseVerdict,
	buildPairedArmsReport,
} from "./benchmark-arms-report.js"
import type { BenchmarkArm } from "./benchmark-arms.js"

const tokens = (input: number): ArmTokenTotals => ({
	answer: { inputTokens: input, outputTokens: 10, callsWithoutUsage: 0 },
	judge: { inputTokens: input * 2, outputTokens: 20, callsWithoutUsage: 1 },
})

function result(
	caseId: string,
	correct: boolean,
	error?: string,
): ArmCaseResult {
	return {
		caseId,
		candidateAnswer: correct ? "right" : "wrong",
		correct,
		abstention: false,
		latencyMs: 1,
		...(error ? { error } : {}),
	}
}

const v1: BenchmarkArm = {
	name: "v1",
	protocol: "custom-v1",
	sessionTurnRecall: false,
}
const v3r: BenchmarkArm = {
	name: "v3r",
	protocol: "custom-v3",
	sessionTurnRecall: true,
}

describe("armCaseVerdict", () => {
	it.each([
		[undefined, "missing", false],
		[result("q", true), "correct", false],
		[result("q", false), "incorrect", false],
		[result("q", false, "answer-judge: invalid-json"), "incorrect", true],
		[result("q", false, "answer-generation: truncated"), "incorrect", true],
		[result("q", false, "answer-judge: transport-failure"), "missing", false],
		[
			result("q", false, "answer-generation: transport-failure"),
			"missing",
			false,
		],
		[result("q", false, "retrieval: search failed"), "missing", false],
		[result("q", true, "decoy-judge: invalid-json"), "correct", false],
	] as const)("classifies %j", (caseResult, verdict, parseFailure) => {
		expect(armCaseVerdict(caseResult)).toEqual({ verdict, parseFailure })
	})
})

describe("buildPairedArmsReport", () => {
	// q1: baseline only; q2-q8: arm only; q9: both right; q10: both wrong;
	// q11: arm judge unparseable (incorrect); q12: arm transport failure.
	const caseIds = Array.from({ length: 12 }, (_, i) => `q${i + 1}`)
	const baseline = [
		result("q1", true),
		...caseIds.slice(1, 8).map((id) => result(id, false)),
		result("q9", true),
		result("q10", false),
		result("q11", true),
		result("q12", true),
	]
	const arm = [
		result("q1", false),
		...caseIds.slice(1, 8).map((id) => result(id, true)),
		result("q9", true),
		result("q10", false),
		result("q11", false, "answer-judge: invalid-json"),
		result("q12", false, "answer-generation: transport-failure"),
	]
	const report = buildPairedArmsReport({
		caseIds,
		arms: [
			{
				arm: v1,
				configurationHash: "a".repeat(64),
				caseResults: baseline,
				tokens: tokens(100),
			},
			{
				arm: v3r,
				configurationHash: "b".repeat(64),
				caseResults: arm,
				tokens: tokens(300),
			},
		],
	})

	it("counts the 2x2 against the baseline with an exact McNemar p", () => {
		expect(report.baseline).toBe("v1")
		expect(report.comparisons).toHaveLength(1)
		const comparison = report.comparisons[0]
		expect(comparison).toMatchObject({
			baseline: "v1",
			arm: "v3r",
			pairs: 11,
			bothCorrect: 1,
			baselineOnly: 2,
			armOnly: 7,
			bothWrong: 1,
			unpaired: 1,
		})
		expect(comparison?.baselineAccuracy).toBeCloseTo(3 / 11, 12)
		expect(comparison?.armAccuracy).toBeCloseTo(8 / 11, 12)
		// b=2, c=7: 2 * (1 + 9 + 36) / 512.
		expect(comparison?.mcnemar.pTwoSided).toBeCloseTo(92 / 512, 12)
	})

	it("reports per-arm accuracy, parse failures, missing verdicts and tokens", () => {
		expect(report.arms).toEqual([
			{
				name: "v1",
				protocol: "custom-v1",
				sessionTurnRecall: false,
				configurationHash: "a".repeat(64),
				questions: 12,
				verdicts: 12,
				correct: 4,
				accuracy: 4 / 12,
				parseFailures: 0,
				missingVerdicts: 0,
				tokens: tokens(100),
			},
			{
				name: "v3r",
				protocol: "custom-v3",
				sessionTurnRecall: true,
				configurationHash: "b".repeat(64),
				questions: 12,
				verdicts: 11,
				correct: 8,
				accuracy: 8 / 11,
				parseFailures: 1,
				missingVerdicts: 1,
				tokens: tokens(300),
			},
		])
	})

	it("lists every question's verdict per arm in question order", () => {
		expect(report.perQuestion[0]).toEqual({
			caseId: "q1",
			verdicts: { v1: "correct", v3r: "incorrect" },
		})
		expect(report.perQuestion[11]).toEqual({
			caseId: "q12",
			verdicts: { v1: "correct", v3r: "missing" },
		})
		expect(report.perQuestion.map((row) => row.caseId)).toEqual(caseIds)
	})
})

describe("exact McNemar on the paired counts", () => {
	it("gives p = 0.0703 for b = 1, c = 7", () => {
		const ids = Array.from({ length: 8 }, (_, i) => `q${i}`)
		const report = buildPairedArmsReport({
			caseIds: ids,
			arms: [
				{
					arm: v1,
					configurationHash: "a".repeat(64),
					caseResults: ids.map((id, i) => result(id, i === 0)),
					tokens: tokens(1),
				},
				{
					arm: v3r,
					configurationHash: "b".repeat(64),
					caseResults: ids.map((id, i) => result(id, i !== 0)),
					tokens: tokens(1),
				},
			],
		})
		expect(report.comparisons[0]?.mcnemar.pTwoSided).toBeCloseTo(0.0703125, 7)
		expect(report.comparisons[0]?.mcnemar.discordant).toBe(8)
	})
})
