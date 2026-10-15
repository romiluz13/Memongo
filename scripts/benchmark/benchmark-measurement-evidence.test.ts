import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { BenchmarkE2eQaEnvelope } from "../../packages/memory-engine/src/types.js"
import { percentile50And95 } from "./benchmark-parity-envelope.js"
import {
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
} from "./longmemeval-official-qa.js"
import {
	OFFICIAL_ANSWER_MAX_TOKENS,
	OFFICIAL_ANSWER_TEMPERATURE,
	OFFICIAL_DATED_ANSWER_VERSION,
	type OfficialQaContext,
	summarizeOfficialBenchmarkQaRun,
} from "./longmemeval-official-scoring.js"
import {
	createOfficialPredictionSidecar,
	recordOfficialAnswer,
	recordOfficialVerdict,
} from "./longmemeval-prediction-sidecar.js"
import {
	buildBenchmarkRunReport,
	describeLatencyBasis,
	evaluateRankingCase,
	summarizeBenchmarkExecutions,
} from "./mongodb-benchmark-runner.js"

function caseRun(caseId: string, latencyMs: number, failed = false) {
	return evaluateRankingCase({
		caseId,
		results: failed
			? []
			: [
					{
						path: caseId,
						score: 0.9,
						snippet: caseId,
						sessionId: "s1",
					} as never,
				],
		latencyMs,
		...(failed ? { executionError: "synthetic failure" } : {}),
		relevantSessionIds: ["s1"],
		resolveSessionIds: (result) => (result.sessionId ? [result.sessionId] : []),
	})
}

function reportWith(params: {
	ingest?: {
		conversationsIngested: number
		turnsIngested: number
		skippedConversations: number
		failedLines: number
		failedTurns: number
	}
	e2eQa?: BenchmarkE2eQaEnvelope
	answerThreshold?: boolean
}) {
	return buildBenchmarkRunReport({
		datasetVersion: "dataset-v1",
		cases: 2,
		hitRate: 1,
		emptyRate: 0,
		avgTopScore: 1,
		p95LatencyMs: 1,
		execution: {
			attemptedCases: 2,
			succeededCases: 2,
			failedCases: 0,
			retrievalEligibleCases: 2,
			abstentionCases: 0,
			missingJudgmentCases: 0,
			retrievalHits: 2,
			retrievalMisses: 0,
			scoredCases: 2,
		},
		...(params.ingest ? { ingest: params.ingest } : {}),
		...(params.e2eQa ? { e2eQa: params.e2eQa } : {}),
		...(params.answerThreshold
			? {
					qualityThresholds: {
						contractId: "longmemeval-release",
						version: "2",
						datasetKind: "longmemeval" as const,
						minHitRate: 0,
						maxEmptyRate: 1,
						minRAt5: 0,
						minNdcgAt10: 0,
						maxP95LatencyMs: 1000,
						minSessionRecallAnyAt10: 0,
						minSessionNdcgAnyAt10: 0,
						minAnswerAccuracy: 0.5,
					},
				}
			: {}),
	})
}

const MEASURED_QA: BenchmarkE2eQaEnvelope = {
	answerModel: "answer-model",
	judge: "judge-model",
	judgeVersion: "1",
	accuracy: 1,
	latencyMs: 20,
	judgeFalsePositiveRate: 0,
	cases: { eligible: 2, attempted: 2, completed: 2, failed: 0 },
	attempts: { answerGeneration: 2, answerJudge: 2, decoyJudge: 0 },
	caseResults: [],
}

async function summarizeTwoJudged(params: {
	protocol: "official" | "custom-judge"
	ingest?: { failedTurns: number; failedLines: number }
	resumedFromCheckpoint?: boolean
}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-b08-c06-"))
	const judgeModel =
		params.protocol === "official"
			? OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL
			: "custom-judge-model"
	let sidecar = createOfficialPredictionSidecar({
		runId: "run-1",
		datasetSha256: "a".repeat(64),
		configurationHash: "b".repeat(64),
		answerModel: "answer-model",
		judgeModel,
		judgeProtocol:
			params.protocol === "official"
				? "official-anscheck"
				: "custom-judge-anscheck",
		promptVersion: OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
		answerPromptVersion: OFFICIAL_DATED_ANSWER_VERSION,
		answerTemperature: `${OFFICIAL_ANSWER_TEMPERATURE}`,
		answerMaxTokens: `${OFFICIAL_ANSWER_MAX_TOKENS}`,
	})
	sidecar = recordOfficialAnswer(sidecar, "q-1", "violet")
	sidecar = recordOfficialVerdict(sidecar, "q-1", "yes")
	sidecar = recordOfficialAnswer(sidecar, "q-2", "emerald")
	sidecar = recordOfficialVerdict(sidecar, "q-2", "no")
	const context = {
		protocol: params.protocol,
		answerProvider: {},
		judgeProvider: {},
		answerModel: "answer-model",
		judgeModel,
		sidecarPath: path.join(dir, "checkpoint.json.predictions.json"),
		sidecar,
		stats: {
			attempts: { answerGeneration: 2, answerJudge: 2 },
			successes: { answerGeneration: 2, answerJudge: 2 },
			failures: { answerGeneration: 0, answerJudge: 0 },
			unreliable: { answerGeneration: 0, answerJudge: 0 },
		},
		unavailable: [],
	} as unknown as OfficialQaContext
	try {
		const { envelope } = await summarizeOfficialBenchmarkQaRun({
			context,
			scenarios: [
				{
					scenarioId: "scenario-A",
					conversations: [],
					evaluations: [
						{ caseId: "q-1", query: "q1", answer: "violet" },
						{
							caseId: "q-2",
							query: "q2",
							answer: "emerald",
							questionType: "temporal-reasoning",
						},
					],
				},
			],
			coveredCaseIds: new Set(["q-1", "q-2"]),
			datasetSha256: "a".repeat(64),
			...(params.resumedFromCheckpoint ? { resumedFromCheckpoint: true } : {}),
			...(params.ingest ? { ingest: params.ingest } : {}),
		})
		return {
			envelope,
			block:
				params.protocol === "official"
					? envelope.official
					: envelope.customJudge,
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

const INGEST_OK = {
	conversationsIngested: 2,
	turnsIngested: 40,
	skippedConversations: 0,
	failedLines: 0,
	failedTurns: 0,
}

describe("B08 latency denominators", () => {
	it("names scored-case and all-attempt latency with counts from actual attempts", () => {
		const summary = summarizeBenchmarkExecutions({
			executions: [
				caseRun("c1", 10),
				caseRun("c2", 20),
				caseRun("c3", 30),
				caseRun("c4", 40),
				caseRun("c5", 50),
				caseRun("c6", 900, true),
				caseRun("c7", 1000, true),
			],
		})
		expect(summary.scoredLatency).toEqual({
			denominator: "scored-cases",
			samples: 5,
			p50Ms: 30,
			p95Ms: 50,
			p95Basis: "sample-maximum",
		})
		// The runner hands every attempt's latency to the parity envelope.
		expect(
			percentile50And95(summary.caseOutcomes.map((entry) => entry.latencyMs)),
		).toEqual({
			denominator: "all-attempts",
			samples: 7,
			p50Ms: 40,
			p95Ms: 1000,
			p95Basis: "sample-maximum",
		})
		expect(summary.p95LatencyMs).toBe(50)
	})

	it("labels seven samples descriptive: nearest-rank p95 is the sample maximum below 20", () => {
		const seven = percentile50And95([10, 20, 30, 40, 50, 60, 70])
		expect(seven).toMatchObject({
			denominator: "all-attempts",
			samples: 7,
			p95Ms: 70,
			p95Basis: "sample-maximum",
		})
		const nineteen = percentile50And95(
			Array.from({ length: 19 }, (_, i) => i + 1),
		)
		expect(nineteen.p95Basis).toBe("sample-maximum")
		const twenty = percentile50And95(
			Array.from({ length: 20 }, (_, i) => i + 1),
		)
		expect(twenty).toMatchObject({ p95Ms: 19, p95Basis: "nearest-rank" })
		expect(percentile50And95([])).toMatchObject({
			samples: 0,
			p95Basis: "no-samples",
		})
	})

	it("carries scored-case latency into the report next to p95LatencyMs", () => {
		const scoredLatency = {
			denominator: "scored-cases" as const,
			samples: 7,
			p50Ms: 40,
			p95Ms: 70,
			p95Basis: "sample-maximum" as const,
		}
		const report = buildBenchmarkRunReport({
			datasetVersion: "dataset-v1",
			cases: 7,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 1,
			p95LatencyMs: 70,
			scoredLatency,
		})
		expect(report.metrics.internal.scoredLatency).toEqual(scoredLatency)
		expect(JSON.stringify(report)).not.toMatch(/stable/i)
	})
})

describe("B08 failed ingest is never complete QA evidence", () => {
	it("passes execution completeness when ingest had no failures", () => {
		const gate = reportWith({ ingest: INGEST_OK }).releaseGates.find(
			(entry) => entry.gate === "execution-completeness",
		)
		expect(gate?.status).toBe("passed")
	})

	it.each([
		["failedTurns", { ...INGEST_OK, failedTurns: 3 }, "3 turns failed ingest"],
		["failedLines", { ...INGEST_OK, failedLines: 2 }, "2 dataset lines failed"],
	])("fails execution completeness on %s even when every case executed", (_name, ingest, text) => {
		const report = reportWith({ ingest })
		const gate = report.releaseGates.find(
			(entry) => entry.gate === "execution-completeness",
		)
		expect(gate?.status).toBe("failed")
		expect(gate?.evidence).toContain(text)
		expect(report.publicationDecision.publishable).toBe(false)
		expect(report.publicationDecision.failedGates).toContain(
			"execution-completeness",
		)
	})
})

describe("B08:C06 QA envelopes after failed ingest", () => {
	it.each([
		"official",
		"custom-judge",
	] as const)("%s: every question judged over a whole corpus stays full and complete", async (protocol) => {
		const { envelope, block } = await summarizeTwoJudged({
			protocol,
			ingest: { failedTurns: 0, failedLines: 0 },
		})
		expect(block?.coverage).toBe("full")
		expect(block?.accountingCompleteness).toBe("complete")
		expect(block?.overallAccuracy).toBe(0.5)
		expect(envelope.accuracy).toBe(0.5)
		expect(envelope.unavailableReason).toBeUndefined()
	})

	it.each([
		["official", { failedTurns: 3, failedLines: 0 }, "3 turns failed ingest"],
		[
			"custom-judge",
			{ failedTurns: 3, failedLines: 0 },
			"3 turns failed ingest",
		],
		[
			"official",
			{ failedTurns: 0, failedLines: 2 },
			"2 dataset lines failed to parse",
		],
		[
			"custom-judge",
			{ failedTurns: 0, failedLines: 2 },
			"2 dataset lines failed to parse",
		],
	] as const)("%s: labels judged evidence partial and incomplete with %o and keeps per-case scores", async (protocol, ingest, text) => {
		const whole = await summarizeTwoJudged({ protocol })
		const { envelope, block } = await summarizeTwoJudged({ protocol, ingest })
		expect(block?.coverage).toBe("partial")
		expect(block?.accountingCompleteness).toBe("incomplete")
		expect(block?.missingQuestionIds).toEqual([])
		expect(block?.overallAccuracy).toBeNull()
		expect(envelope.accuracy).toBeNull()
		expect(envelope.unavailableReason).toContain(text)
		expect(envelope.unavailableReason).toContain("QA evidence is incomplete")
		expect(block?.perType).toEqual(whole.block?.perType)
		expect(envelope.caseResults).toEqual(whole.envelope.caseResults)
		expect(envelope.cases).toEqual(whole.envelope.cases)
		expect(block?.export?.kind).toBe("sample")
	})

	it.each([
		"official",
		"custom-judge",
	] as const)("%s: a resumed run with restored ingest failures stays partial", async (protocol) => {
		const resumedWhole = await summarizeTwoJudged({
			protocol,
			resumedFromCheckpoint: true,
		})
		expect(resumedWhole.block?.coverage).toBe("full")
		expect(resumedWhole.block?.accountingCompleteness).toBe("incomplete")
		const { block } = await summarizeTwoJudged({
			protocol,
			resumedFromCheckpoint: true,
			ingest: { failedTurns: 1, failedLines: 0 },
		})
		expect(block?.coverage).toBe("partial")
		expect(block?.accountingCompleteness).toBe("incomplete")
	})

	it("fails the answer-quality gate without answer thresholds when QA evidence was emitted", () => {
		expect(
			reportWith({ ingest: INGEST_OK, e2eQa: MEASURED_QA }).releaseGates.some(
				(entry) => entry.gate === "e2e-answer-quality",
			),
		).toBe(false)
		const report = reportWith({
			ingest: { ...INGEST_OK, failedTurns: 3 },
			e2eQa: MEASURED_QA,
		})
		const gate = report.releaseGates.find(
			(entry) => entry.gate === "e2e-answer-quality",
		)
		expect(gate?.status).toBe("failed")
		expect(gate?.evidence).toBe(
			"3 turns failed ingest; QA evidence is incomplete",
		)
		expect(report.publicationDecision.failedGates).toContain(
			"e2e-answer-quality",
		)
	})

	it("fails a declared answer gate whose thresholds pass when ingest failed", () => {
		const passing = reportWith({
			ingest: INGEST_OK,
			e2eQa: MEASURED_QA,
			answerThreshold: true,
		}).releaseGates.find((entry) => entry.gate === "e2e-answer-quality")
		expect(passing?.status).toBe("passed")
		const gate = reportWith({
			ingest: { ...INGEST_OK, failedLines: 2 },
			e2eQa: MEASURED_QA,
			answerThreshold: true,
		}).releaseGates.find((entry) => entry.gate === "e2e-answer-quality")
		expect(gate?.status).toBe("failed")
		expect(gate?.evidence).toContain("2 dataset lines failed to parse")
	})
})

describe("B08 latency text", () => {
	it("names the denominator and marks a small sample descriptive", () => {
		expect(
			describeLatencyBasis(
				percentile50And95([1, 2, 3, 4, 5, 6, 7], "scored-cases"),
			),
		).toBe(
			" (scored-cases, n=7; descriptive only: below 20 samples p95 is the sample maximum)",
		)
		expect(
			describeLatencyBasis(
				percentile50And95(Array.from({ length: 20 }, (_, i) => i)),
			),
		).toBe(" (all-attempts, n=20)")
		expect(describeLatencyBasis({ p50Ms: 1, p95Ms: 2 })).toBe("")
	})
})
