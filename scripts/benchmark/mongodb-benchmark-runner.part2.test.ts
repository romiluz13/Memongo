import { describe, expect, it } from "vitest"
import {
	buildCaseDiagnostics,
	buildMissLedger,
	evaluateRankingCase,
	summarizeBenchmarkExecutions,
	summarizeMeasurementPasses,
	type BenchmarkCaseExecution,
	type BenchmarkSummary,
} from "./mongodb-benchmark-runner.js"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import type { MemoryBenchmarkOfficialMetrics } from "../../packages/memory-engine/src/types.js"
import { createBenchmarkRunContext } from "./benchmark-parity-envelope.js"

function _benchmarkCost(
	operations: Array<{
		operation:
			| "rerank"
			| "enrichment"
			| "query-decomposition"
			| "answer-generation"
			| "answer-judge"
			| "decoy-judge"
		attempted: number
		succeeded: number
		failed: number
	}> = [],
) {
	return {
		currency: null,
		totalCost: null,
		unavailableReason: "provider token usage and prices are not instrumented",
		operations: [
			{
				operation: "embedding" as const,
				observability: "unknown" as const,
				attempted: null,
				succeeded: null,
				failed: null,
				unavailableReason:
					"MongoDB automated embedding calls are not exposed to the benchmark process",
			},
			...operations.map((entry) => ({
				...entry,
				observability: "measured" as const,
			})),
		],
	}
}

function _benchmarkRunContext(
	retrievalLane: "native" | "raw-session" = "native",
) {
	return createBenchmarkRunContext({
		runId: `run-${retrievalLane}`,
		configuration: {
			executionProfile: "diagnostic",
			retrievalLane,
			maxResults: 50,
			minScore: 0.01,
			settings: { numCandidates: 500, fusionMethod: "rankFusion" },
		},
	})
}

function makeResult(params: {
	path: string
	score: number
	sessionId?: string
	sourceEventIds?: string[]
}): MemorySearchResult {
	return {
		path: params.path,
		startLine: 1,
		endLine: 1,
		score: params.score,
		snippet: params.path,
		source: "conversation",
		...(params.sessionId ? { sessionId: params.sessionId } : {}),
		...(params.sourceEventIds ? { sourceEventIds: params.sourceEventIds } : {}),
	}
}

const _officialMetrics: MemoryBenchmarkOfficialMetrics = {
	longMemEval: {
		evaluator: {
			suite: "longmemeval",
			sourceRepository: "xiaowu0162/LongMemEval",
			sourceCommit: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
			evaluatorPath: "src/retrieval/eval_utils.py",
			evaluatorBlob: "9c43a835e7c41aff0eb3272c448f5cbe76bbbd45",
			aggregationEntrypoint: "src/retrieval/run_retrieval.py",
			cutoffs: [1, 3, 5, 10, 30, 50],
			eligibilityPolicy: "exclude-abstention-and-no-user-answer-target",
			candidateProjection: "one-session-document-one-label",
			comparability: "canonical",
		},
		totalCases: 2,
		eligibleCases: 2,
		retrievalCases: 2,
		abstentionCases: 0,
		ineligibleCases: 0,
		projectionFailureCases: 0,
		executionFailureCases: 0,
		session: {
			recallAnyAt1: 1,
			recallAllAt1: 1,
			ndcgAnyAt1: 1,
			recallAnyAt3: 1,
			recallAllAt3: 1,
			ndcgAnyAt3: 1,
			recallAnyAt5: 1,
			recallAllAt5: 1,
			ndcgAnyAt5: 1,
			recallAnyAt10: 1,
			recallAllAt10: 1,
			ndcgAnyAt10: 1,
			recallAnyAt30: 1,
			recallAllAt30: 1,
			ndcgAnyAt30: 1,
			recallAnyAt50: 1,
			recallAllAt50: 1,
			ndcgAnyAt50: 1,
		},
	},
}

// ---------------------------------------------------------------------------
// buildMissLedger
// ---------------------------------------------------------------------------

describe("buildMissLedger", () => {
	it("returns empty array when all cases have R@5 = 1.0", () => {
		const executions: BenchmarkCaseExecution[] = [
			{
				caseId: "case-1",
				questionType: "multi-session",
				empty: false,
				topScore: 0.9,
				latencyMs: 100,
				scored: true,
				hit: true,
				rAt5: 1.0,
				rAt10: 1.0,
				ndcgAt10: 1.0,
			},
		]
		const ledger = buildMissLedger({
			executions,
			expectedSessionMap: new Map([["case-1", ["s1"]]]),
			expectedTurnMap: new Map([["case-1", ["t1"]]]),
		})
		expect(ledger).toHaveLength(0)
	})

	it("includes cases with R@5 < 1.0", () => {
		const executions: BenchmarkCaseExecution[] = [
			{
				caseId: "case-miss",
				questionType: "single-session-preference",
				empty: false,
				topScore: 0.7,
				latencyMs: 200,
				scored: true,
				hit: false,
				rAt5: 0.0,
				rAt10: 0.0,
				ndcgAt10: 0.0,
				topCandidates: [
					{
						rank: 1,
						score: 0.7,
						source: "conversation",
						sessionId: "wrong-s1",
						path: "p1",
					},
					{
						rank: 2,
						score: 0.6,
						source: "session-evidence",
						sessionId: "wrong-s2",
						canonicalId: "session-chunk/wrong-s2",
						path: "p2",
					},
				],
			},
		]
		const ledger = buildMissLedger({
			executions,
			expectedSessionMap: new Map([["case-miss", ["expected-s1"]]]),
			expectedTurnMap: new Map([["case-miss", ["expected-t1"]]]),
		})
		expect(ledger).toHaveLength(1)
		expect(ledger[0].caseId).toBe("case-miss")
		expect(ledger[0].questionType).toBe("single-session-preference")
		expect(ledger[0].missCategory).toBe("preference")
		expect(ledger[0].sessionFound).toBe(false)
		expect(ledger[0].allSessionsFound).toBe(false)
		expect(ledger[0].expectedSessionIds).toEqual(["expected-s1"])
		expect(ledger[0].topCandidateSessionIds).toContain("wrong-s1")
	})

	it("detects partial session recall (sessionFound but not all)", () => {
		const executions: BenchmarkCaseExecution[] = [
			{
				caseId: "case-partial",
				questionType: "knowledge-update",
				empty: false,
				topScore: 0.8,
				latencyMs: 150,
				scored: true,
				hit: true,
				rAt5: 0.5,
				rAt10: 0.5,
				ndcgAt10: 0.4,
				topCandidates: [
					{
						rank: 1,
						score: 0.8,
						source: "conversation",
						sessionId: "s1",
						path: "p1",
					},
					{
						rank: 2,
						score: 0.7,
						source: "conversation",
						sessionId: "s3",
						path: "p2",
					},
				],
			},
		]
		const ledger = buildMissLedger({
			executions,
			expectedSessionMap: new Map([["case-partial", ["s1", "s2"]]]),
			expectedTurnMap: new Map([["case-partial", []]]),
		})
		expect(ledger).toHaveLength(1)
		expect(ledger[0].sessionFound).toBe(true)
		expect(ledger[0].allSessionsFound).toBe(false)
		expect(ledger[0].missCategory).toBe("update")
	})

	it("detects turn reachability via sourceEventIds", () => {
		const executions: BenchmarkCaseExecution[] = [
			{
				caseId: "case-turn",
				questionType: "temporal-reasoning",
				empty: false,
				topScore: 0.9,
				latencyMs: 120,
				scored: true,
				hit: true,
				rAt5: 0.5,
				rAt10: 0.5,
				ndcgAt10: 0.5,
				topCandidates: [
					{
						rank: 1,
						score: 0.9,
						source: "session-evidence",
						sessionId: "s1",
						sourceEventIds: ["t1", "t2", "t3"],
						path: "p1",
					},
				],
			},
		]
		const ledger = buildMissLedger({
			executions,
			expectedSessionMap: new Map([["case-turn", ["s1", "s2"]]]),
			expectedTurnMap: new Map([["case-turn", ["t2"]]]),
		})
		expect(ledger).toHaveLength(1)
		expect(ledger[0].turnReachable).toBe(true)
		expect(ledger[0].reachableTurnIds).toContain("t2")
		expect(ledger[0].missCategory).toBe("temporal")
	})

	it("uses resolved session ids in the miss ledger when raw session ids are absent", () => {
		const evaluation = evaluateRankingCase({
			caseId: "case-resolved-session",
			results: [
				makeResult({
					path: "structured:fact:camera",
					score: 0.91,
					sourceEventIds: ["evt-42"],
				}),
			],
			latencyMs: 91,
			relevantSessionIds: ["expected-s1", "expected-s2"],
			relevantTurnIds: ["turn-42"],
			resolveSessionIds: (result) =>
				result.sourceEventIds?.includes("evt-42") ? ["expected-s1"] : [],
			resolveTurnIds: (result) =>
				result.sourceEventIds?.includes("evt-42") ? ["turn-42"] : [],
			questionType: "single-session-preference",
			traceOptions: { maxCandidates: 10 },
		})

		const ledger = buildMissLedger({
			executions: [evaluation],
			expectedSessionMap: new Map([
				["case-resolved-session", ["expected-s1", "expected-s2"]],
			]),
			expectedTurnMap: new Map([["case-resolved-session", ["turn-42"]]]),
		})

		expect(ledger).toHaveLength(1)
		expect(ledger[0].topCandidateSessionIds).toEqual(["expected-s1"])
		expect(ledger[0].sessionFound).toBe(true)
		expect(ledger[0].topCandidates[0]?.resolvedSessionIds).toEqual([
			"expected-s1",
		])
		expect(ledger[0].topCandidates[0]?.sourceEventIds).toEqual(["evt-42"])
		expect(ledger[0].reachableTurnIds).toEqual(["turn-42"])
	})

	it("sorts ledger by rAt5 ascending (worst first)", () => {
		const executions: BenchmarkCaseExecution[] = [
			{
				caseId: "better",
				questionType: "knowledge-update",
				empty: false,
				topScore: 0.8,
				latencyMs: 100,
				scored: true,
				hit: true,
				rAt5: 0.5,
				rAt10: 0.5,
				ndcgAt10: 0.5,
			},
			{
				caseId: "worse",
				questionType: "single-session-preference",
				empty: false,
				topScore: 0.5,
				latencyMs: 200,
				scored: true,
				hit: false,
				rAt5: 0.0,
				rAt10: 0.0,
				ndcgAt10: 0.0,
			},
		]
		const ledger = buildMissLedger({
			executions,
			expectedSessionMap: new Map([
				["better", ["s1", "s2"]],
				["worse", ["s3"]],
			]),
			expectedTurnMap: new Map(),
		})
		expect(ledger).toHaveLength(2)
		expect(ledger[0].caseId).toBe("worse")
		expect(ledger[1].caseId).toBe("better")
	})
})

describe("buildCaseDiagnostics", () => {
	it("records top-1 LongMemEval misses even when R@5 is perfect", () => {
		const evaluation = evaluateRankingCase({
			caseId: "case-top1",
			results: [
				makeResult({
					path: "distractor",
					score: 0.95,
					sessionId: "wrong",
					sourceEventIds: ["wrong-turn"],
				}),
				makeResult({
					path: "expected",
					score: 0.91,
					sessionId: "expected-s1",
					sourceEventIds: ["turn-1"],
				}),
			],
			latencyMs: 30,
			relevantSessionIds: ["expected-s1"],
			relevantTurnIds: ["turn-1"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			resolveTurnIds: (result) => result.sourceEventIds ?? [],
			datasetKind: "longmemeval",
			questionType: "knowledge-update",
			traceOptions: { maxCandidates: 10 },
		})

		expect(evaluation.rAt5).toBe(1)
		expect(evaluation.longMemEval?.session.recallAllAt1).toBe(0)

		const diagnostics = buildCaseDiagnostics({
			executions: [evaluation],
			expectedSessionMap: new Map([["case-top1", ["expected-s1"]]]),
			expectedTurnMap: new Map([["case-top1", ["turn-1"]]]),
		})

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toEqual(
			expect.objectContaining({
				caseId: "case-top1",
				issue: "top1-session-and-turn",
				sessionTop1Found: false,
				turnTop1Found: false,
				expectedSessionIds: ["expected-s1"],
				expectedTurnIds: ["turn-1"],
				topCandidateSessionIds: ["wrong", "expected-s1"],
				topCandidateTurnIds: ["wrong-turn", "turn-1"],
			}),
		)
		expect(diagnostics[0].topCandidates[0]).toEqual(
			expect.objectContaining({
				rank: 1,
				sessionId: "wrong",
				path: "distractor",
			}),
		)
	})

	it("does not record clean top-1 hits", () => {
		const evaluation = evaluateRankingCase({
			caseId: "case-clean",
			results: [makeResult({ path: "expected", score: 0.95, sessionId: "s1" })],
			latencyMs: 10,
			relevantSessionIds: ["s1"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			datasetKind: "longmemeval",
			traceOptions: { maxCandidates: 10 },
		})

		const diagnostics = buildCaseDiagnostics({
			executions: [evaluation],
			expectedSessionMap: new Map([["case-clean", ["s1"]]]),
			expectedTurnMap: new Map(),
		})

		expect(diagnostics).toHaveLength(0)
	})

	it("does not record healthy multi-evidence spreads as top-1 misses", () => {
		const evaluation = evaluateRankingCase({
			caseId: "case-multi-evidence",
			results: [
				makeResult({
					path: "expected-1",
					score: 0.95,
					sessionId: "s1",
					sourceEventIds: ["turn-1"],
				}),
				makeResult({
					path: "expected-2",
					score: 0.9,
					sessionId: "s2",
					sourceEventIds: ["turn-2"],
				}),
			],
			latencyMs: 10,
			relevantSessionIds: ["s1", "s2"],
			relevantTurnIds: ["turn-1", "turn-2"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			resolveTurnIds: (result) => result.sourceEventIds ?? [],
			datasetKind: "longmemeval",
			traceOptions: { maxCandidates: 10 },
		})

		expect(evaluation.longMemEval?.session.recallAnyAt1).toBe(1)
		expect(evaluation.longMemEval?.session.recallAllAt1).toBe(0)
		expect(evaluation.longMemEval?.session.recallAllAt3).toBe(1)

		const diagnostics = buildCaseDiagnostics({
			executions: [evaluation],
			expectedSessionMap: new Map([["case-multi-evidence", ["s1", "s2"]]]),
			expectedTurnMap: new Map([["case-multi-evidence", ["turn-1", "turn-2"]]]),
		})

		expect(diagnostics).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// #66 step 3: per-lane latency aggregation
// ---------------------------------------------------------------------------

describe("per-lane latency aggregation", () => {
	function laneCase(caseId: string, latencyByLane?: Record<string, number>) {
		return evaluateRankingCase({
			caseId,
			results: [makeResult({ path: caseId, score: 0.9, sessionId: "s1" })],
			latencyMs: 5,
			relevantSessionIds: ["s1"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			...(latencyByLane ? { latencyByLane } : {}),
		})
	}

	it("computes p95 per lane over only the cases where that lane ran", () => {
		const summary = summarizeBenchmarkExecutions({
			executions: [
				laneCase("c1", { hybrid: 100, kb: 10 }),
				laneCase("c2", { hybrid: 200 }),
				laneCase("c3", { hybrid: 300, kb: 30 }),
				laneCase("c4"),
			],
		})

		expect(summary.laneLatencyP95).toEqual({
			hybrid: { p95Ms: 300, cases: 3 },
			kb: { p95Ms: 30, cases: 2 },
		})
	})

	it("carries the per-lane latency sample onto the case outcome", () => {
		const summary = summarizeBenchmarkExecutions({
			executions: [laneCase("c1", { "hybrid:chunks": 42 })],
		})

		expect(summary.caseOutcomes[0]?.latencyByLane).toEqual({
			"hybrid:chunks": 42,
		})
	})

	it("omits the per-lane breakdown when no case recorded lane latency", () => {
		const summary = summarizeBenchmarkExecutions({
			executions: [laneCase("c1")],
		})

		expect(summary.laneLatencyP95).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------

describe("measurement pass aggregation", () => {
	function passSummary(
		p95LatencyMs: number,
		overrides: Partial<BenchmarkSummary> = {},
	): BenchmarkSummary {
		return {
			cases: 2,
			scoredCases: 2,
			skippedCases: 0,
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
			caseOutcomes: [],
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs,
			rAt5: 1,
			rAt10: 1,
			ndcgAt10: 1,
			questionTypeBreakdown: [],
			...overrides,
		}
	}

	it("reports every pass plus the across-pass p95 noise band", () => {
		const report = summarizeMeasurementPasses([
			passSummary(2507, {
				laneLatencyP95: { hybrid: { p95Ms: 900, cases: 2 } },
			}),
			passSummary(2611),
			passSummary(1627),
		])

		expect(report?.passes).toBe(3)
		expect(report?.gatePass).toBe(1)
		expect(report?.samples.map((sample) => sample.pass)).toEqual([1, 2, 3])
		expect(report?.samples.map((sample) => sample.p95LatencyMs)).toEqual([
			2507, 2611, 1627,
		])
		expect(report?.samples[0]?.laneLatencyP95).toEqual({
			hybrid: { p95Ms: 900, cases: 2 },
		})
		// median of [1627, 2507, 2611]; stddev is population stddev
		expect(report?.p95LatencyMs.median).toBe(2507)
		expect(report?.p95LatencyMs.min).toBe(1627)
		expect(report?.p95LatencyMs.max).toBe(2611)
		expect(report?.p95LatencyMs.stddev).toBeCloseTo(441.4, 1)
	})

	it("averages the two middle passes for an even pass count", () => {
		const report = summarizeMeasurementPasses([
			passSummary(1000),
			passSummary(3000),
			passSummary(2000),
			passSummary(4000),
		])

		expect(report?.p95LatencyMs.median).toBe(2500)
	})

	it("omits the report for a single measurement pass", () => {
		expect(summarizeMeasurementPasses([passSummary(2507)])).toBeUndefined()
	})
})
