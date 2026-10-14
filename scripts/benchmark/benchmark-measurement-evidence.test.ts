import { describe, expect, it } from "vitest"
import { percentile50And95 } from "./benchmark-parity-envelope.js"
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
	})
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
