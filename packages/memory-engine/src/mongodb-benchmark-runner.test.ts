import { describe, expect, it } from "vitest"
import {
	buildBenchmarkRunReport,
	buildCaseDiagnostics,
	buildMissLedger,
	buildQueryGovernanceReport,
	evaluateRankingCase,
	projectBenchmarkParityFields,
	rankResultSessions,
	summarizeBenchmarkExecutions,
	type BenchmarkCaseExecution,
} from "./mongodb-benchmark-runner.js"
import type { MemorySearchResult } from "./types.js"
import type { MemoryBenchmarkOfficialMetrics } from "./types.js"
import { createBenchmarkRunContext } from "./benchmark-parity-envelope.js"

function benchmarkCost(
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

function benchmarkRunContext(
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

const officialMetrics: MemoryBenchmarkOfficialMetrics = {
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

describe("mongodb benchmark runner", () => {
	it("ranks unique session ids from direct and source-event evidence", () => {
		const ranked = rankResultSessions({
			results: [
				makeResult({ path: "a", score: 0.9, sessionId: "session-1" }),
				makeResult({ path: "b", score: 0.8, sourceEventIds: ["evt-2"] }),
				makeResult({ path: "c", score: 0.7, sessionId: "session-1" }),
			],
			resolveSessionIds: (result) => {
				if (result.sessionId) {
					return [result.sessionId]
				}
				if (
					Array.isArray(result.sourceEventIds) &&
					result.sourceEventIds[0] === "evt-2"
				) {
					return ["session-2"]
				}
				return []
			},
		})

		expect(ranked).toEqual([
			{ sessionId: "session-1", score: 0.9 },
			{ sessionId: "session-2", score: 0.8 },
		])
	})

	it("marks a query execution failure separately from a retrieval miss", () => {
		const execution = evaluateRankingCase({
			caseId: "case-failed",
			results: [],
			latencyMs: 12,
			relevantSessionIds: ["session-1"],
			resolveSessionIds: () => [],
			executionError: "search timeout",
		})

		expect(execution.executionStatus).toBe("system-failure")
		expect(execution.scoreEligibility).toBe("retrieval")
		expect(execution.retrievalOutcome).toBe("not-applicable")
		expect(execution.error).toBe("search timeout")
		expect(execution.scored).toBe(false)
	})

	it("reports attempted, succeeded, failed, abstention, and scored denominators", () => {
		const summary = summarizeBenchmarkExecutions({
			executions: [
				evaluateRankingCase({
					caseId: "hit",
					results: [
						makeResult({ path: "hit", score: 0.9, sessionId: "session-1" }),
					],
					latencyMs: 1,
					relevantSessionIds: ["session-1"],
					resolveSessionIds: (result) => [result.sessionId ?? ""],
				}),
				evaluateRankingCase({
					caseId: "abstain",
					results: [],
					latencyMs: 1,
					relevantSessionIds: [],
					resolveSessionIds: () => [],
					abstention: true,
				}),
				evaluateRankingCase({
					caseId: "failed",
					results: [],
					latencyMs: 1,
					relevantSessionIds: ["session-2"],
					resolveSessionIds: () => [],
					executionError: "network failure",
				}),
			],
		})

		expect(summary.execution).toEqual({
			attemptedCases: 3,
			succeededCases: 2,
			failedCases: 1,
			retrievalEligibleCases: 2,
			abstentionCases: 1,
			missingJudgmentCases: 0,
			retrievalHits: 1,
			retrievalMisses: 0,
			scoredCases: 1,
		})
		expect(summary.emptyRate).toBe(0)
		expect(summary.avgTopScore).toBe(0.9)
		expect(summary.caseOutcomes).toHaveLength(3)
	})

	it("fails publication when declared quality thresholds are missed", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 2,
			hitRate: 0.5,
			emptyRate: 0.5,
			avgTopScore: 0.5,
			p95LatencyMs: 200,
			rAt5: 0.5,
			rAt10: 0.5,
			ndcgAt10: 0.5,
			officialMetrics,
			execution: {
				attemptedCases: 2,
				succeededCases: 2,
				failedCases: 0,
				retrievalEligibleCases: 2,
				abstentionCases: 0,
				missingJudgmentCases: 0,
				retrievalHits: 1,
				retrievalMisses: 1,
				scoredCases: 2,
			},
			qualityThresholds: {
				contractId: "longmemeval-release",
				version: "1",
				datasetKind: "longmemeval",
				minHitRate: 0.8,
				maxEmptyRate: 0.2,
				minRAt5: 0.8,
				minNdcgAt10: 0.7,
				maxP95LatencyMs: 100,
				minSessionRecallAnyAt10: 0.8,
				minSessionNdcgAnyAt10: 0.8,
			},
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "quality-thresholds",
					status: "failed",
				}),
			]),
		)
		expect(report.publicationDecision.publishable).toBe(false)
		expect(report.publicationDecision.failedGates).toContain(
			"quality-thresholds",
		)
		expect(report.publicationDecision.failedGates).not.toContain(
			"conversation-recall-regression",
		)
		expect(report.publicationDecision.blockingGates).toContain(
			"conversation-recall-regression",
		)
	})

	it("#70: a passed conversation-recall-regression result unblocks the gate", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetKind: "longmemeval",
			cases: 1,
			scoredCases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 10,
			conversationRecallRegression: {
				status: "passed",
				evidence: "vitest run: 8/8 recall regression tests passed",
			},
		})

		const gate = report.releaseGates.find(
			(entry) => entry.gate === "conversation-recall-regression",
		)
		expect(gate).toMatchObject({
			status: "passed",
			evidence: "vitest run: 8/8 recall regression tests passed",
		})
		expect(report.publicationDecision.blockingGates).not.toContain(
			"conversation-recall-regression",
		)
	})

	it("#70: a failed conversation-recall-regression result blocks publication", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetKind: "longmemeval",
			cases: 1,
			scoredCases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 10,
			conversationRecallRegression: {
				status: "failed",
				evidence: "vitest run: 2 of 8 recall regression tests failed",
			},
		})

		expect(report.publicationDecision.publishable).toBe(false)
		expect(report.publicationDecision.failedGates).toContain(
			"conversation-recall-regression",
		)
	})

	it("applies the declared LoCoMo answer coverage threshold", () => {
		const build = (minAnswerCoverage: number) =>
			buildBenchmarkRunReport({
				datasetVersion: "locomo-v1",
				datasetKind: "locomo",
				cases: 4,
				scoredCases: 4,
				hitRate: 1,
				emptyRate: 0,
				avgTopScore: 0.9,
				p95LatencyMs: 10,
				rAt5: 1,
				ndcgAt10: 1,
				officialMetrics: {
					loCoMo: {
						retrievalCases: 4,
						abstentionCases: 0,
						sessionEvidenceRecallAt5: 1,
						sessionEvidenceRecallAt10: 1,
					},
				},
				qualityThresholds: {
					contractId: "locomo-release",
					version: "1",
					datasetKind: "locomo",
					minHitRate: 0.8,
					maxEmptyRate: 0.2,
					minRAt5: 0.8,
					minNdcgAt10: 0.8,
					maxP95LatencyMs: 100,
					minSessionEvidenceRecallAt10: 0.8,
					minAnswerAccuracy: 0.8,
					maxJudgeFalsePositiveRate: 0.05,
					minAnswerCoverage,
				},
				e2eQa: {
					answerModel: "answer-model",
					judge: "judge-model",
					judgeVersion: "1",
					accuracy: 0.9,
					latencyMs: 20,
					judgeFalsePositiveRate: 0,
					cases: { eligible: 4, attempted: 4, completed: 3, failed: 1 },
					attempts: { answerGeneration: 4, answerJudge: 3, decoyJudge: 3 },
					caseResults: [],
				},
			})

		expect(build(0.75).releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "e2e-answer-quality",
					status: "passed",
				}),
			]),
		)
		expect(build(0.8).releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "e2e-answer-quality",
					status: "failed",
				}),
			]),
		)
	})

	it("computes recall and ndcg over ranked session hits", () => {
		const evaluation = evaluateRankingCase({
			results: [
				makeResult({ path: "a", score: 0.9, sessionId: "session-3" }),
				makeResult({ path: "b", score: 0.8, sessionId: "session-1" }),
				makeResult({ path: "c", score: 0.7, sourceEventIds: ["evt-2"] }),
			],
			latencyMs: 42,
			relevantSessionIds: ["session-1", "session-2"],
			resolveSessionIds: (result) => {
				if (result.sessionId) {
					return [result.sessionId]
				}
				if (
					Array.isArray(result.sourceEventIds) &&
					result.sourceEventIds[0] === "evt-2"
				) {
					return ["session-2"]
				}
				return []
			},
			questionType: "temporal",
		})

		expect(evaluation.scored).toBe(true)
		expect(evaluation.hit).toBe(true)
		expect(evaluation.rAt5).toBe(1)
		expect(evaluation.rAt10).toBe(1)
		expect(evaluation.ndcgAt10).toBeGreaterThan(0)
		expect(evaluation.questionType).toBe("temporal")
	})

	it("Task 35: propagates scoreDetails on per-case topCandidates when present on result", () => {
		const evaluation = evaluateRankingCase({
			results: [
				{
					...makeResult({ path: "a", score: 0.31, sessionId: "s1" }),
					canonicalId: "event:evt-1",
					sourceEventIds: ["evt-1"],
					scoreDetails: {
						value: 0.31,
						description: "rank-fusion:sum(weight*(1/(60+rank)))",
						details: [
							{
								inputPipelineName: "vector",
								rank: 1,
								weight: 0.5,
								value: 0.5 * (1 / (60 + 1)),
							},
							{
								inputPipelineName: "text",
								rank: 2,
								weight: 0.5,
								value: 0.5 * (1 / (60 + 2)),
							},
						],
					},
				},
			],
			latencyMs: 12,
			relevantSessionIds: ["s1"],
			resolveSessionIds: (r) => (r.sessionId ? [r.sessionId] : []),
			traceOptions: { maxCandidates: 10 },
		})

		expect(evaluation.topCandidates).toBeDefined()
		const first = evaluation.topCandidates![0]
		expect(first.scoreDetails).toBeDefined()
		expect(first.scoreDetails!.description).toContain("rank-fusion")
		expect(first.scoreDetails!.details).toHaveLength(2)
		expect(first.scoreDetails!.details![0]).toMatchObject({
			inputPipelineName: "vector",
			rank: 1,
			weight: 0.5,
		})
	})

	it("includes topCandidates trace with per-result retrieval metadata", () => {
		const evaluation = evaluateRankingCase({
			results: [
				{
					...makeResult({ path: "events/evt-1", score: 0.9, sessionId: "s1" }),
					canonicalId: "event:evt-1",
					sourceEventIds: ["evt-1"],
				},
				{
					...makeResult({ path: "structured/sm-1", score: 0.7 }),
					canonicalId: "structured:sm-1",
					source: "structured" as const,
				},
			],
			latencyMs: 33,
			relevantSessionIds: ["s1"],
			resolveSessionIds: (r) => (r.sessionId ? [r.sessionId] : []),
			questionType: "single-session-user",
			traceOptions: { maxCandidates: 10 },
		})

		expect(evaluation.topCandidates).toBeDefined()
		expect(evaluation.topCandidates).toHaveLength(2)
		const first = evaluation.topCandidates![0]
		expect(first.rank).toBe(1)
		expect(first.score).toBe(0.9)
		expect(first.canonicalId).toBe("event:evt-1")
		expect(first.sessionId).toBe("s1")
		expect(first.resolvedSessionIds).toEqual(["s1"])
		expect(first.sourceEventIds).toEqual(["evt-1"])
		expect(first.source).toBe("conversation")
	})

	it("computes LongMemEval official binary recall_all and ndcg_any metrics", () => {
		const evaluation = evaluateRankingCase({
			results: [
				makeResult({ path: "a", score: 0.9, sessionId: "distractor" }),
				makeResult({ path: "b", score: 0.8, sessionId: "session-1" }),
				makeResult({ path: "c", score: 0.7, sourceEventIds: ["evt-2"] }),
			],
			latencyMs: 42,
			relevantSessionIds: ["session-1", "session-2"],
			relevantTurnIds: ["turn-2"],
			resolveSessionIds: (result) => {
				if (result.sessionId) {
					return [result.sessionId]
				}
				return result.sourceEventIds?.includes("evt-2") ? ["session-2"] : []
			},
			resolveTurnIds: (result) =>
				result.sourceEventIds?.includes("evt-2") ? ["turn-2"] : [],
			datasetKind: "longmemeval",
			questionType: "multi-session",
		})

		expect(evaluation.longMemEval?.session?.recallAnyAt1).toBe(0)
		expect(evaluation.longMemEval?.session?.recallAllAt3).toBe(1)
		expect(evaluation.longMemEval?.session?.ndcgAnyAt10).toBeGreaterThan(0)
		expect(evaluation.longMemEval?.turn?.recallAllAt5).toBe(1)
	})

	it("matches the pinned LongMemEval evaluator discount fixture", () => {
		const evaluation = evaluateRankingCase({
			results: [
				makeResult({ path: "distractor-1", score: 0.9, sessionId: "d1" }),
				makeResult({ path: "relevant-1", score: 0.8, sessionId: "s1" }),
				makeResult({ path: "distractor-2", score: 0.7, sessionId: "d2" }),
				makeResult({ path: "relevant-2", score: 0.6, sessionId: "s2" }),
			],
			latencyMs: 1,
			relevantSessionIds: ["s1", "s2"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			datasetKind: "longmemeval",
		})

		expect(evaluation.longMemEval?.session).toMatchObject({
			recallAnyAt1: 0,
			recallAnyAt3: 1,
			recallAllAt3: 0,
			ndcgAnyAt3: 0.5,
			recallAllAt5: 1,
			ndcgAnyAt5: 0.75,
		})
	})

	it("flattens multi-label candidates into consecutive canonical rank slots", () => {
		const evaluation = evaluateRankingCase({
			results: [makeResult({ path: "multi-session", score: 0.9 })],
			latencyMs: 1,
			relevantSessionIds: ["s1", "s2"],
			resolveSessionIds: () => ["s1", "s2"],
			datasetKind: "longmemeval",
		})

		expect(evaluation.rAt5).toBe(1)
		expect(evaluation.officialMetric).toEqual({ status: "scored" })
		expect(evaluation.longMemEval?.session).toMatchObject({
			recallAnyAt1: 1,
			recallAllAt1: 0,
			recallAllAt3: 1,
		})
	})

	it("never lets a multi-label candidate outrank the slots it occupies", () => {
		// One memory attributed to [s1, s2] where only s2 is relevant: s1 must
		// consume rank 1, so the earliest the answer can appear is rank 2.
		const evaluation = evaluateRankingCase({
			results: [
				makeResult({ path: "multi-session", score: 0.9 }),
				makeResult({ path: "relevant-later", score: 0.8, sessionId: "s3" }),
			],
			latencyMs: 1,
			relevantSessionIds: ["s2"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : ["s1", "s2"],
			datasetKind: "longmemeval",
		})

		expect(evaluation.officialMetric).toEqual({ status: "scored" })
		expect(evaluation.longMemEval?.session).toMatchObject({
			recallAnyAt1: 0,
			recallAnyAt3: 1,
		})
	})

	it("keeps unresolved candidates and duplicate labels in canonical ranks", () => {
		const evaluation = evaluateRankingCase({
			results: [
				makeResult({ path: "unresolved", score: 0.9 }),
				makeResult({ path: "duplicate-1", score: 0.8, sessionId: "s1" }),
				makeResult({ path: "duplicate-2", score: 0.7, sessionId: "s1" }),
				makeResult({ path: "relevant", score: 0.6, sessionId: "s2" }),
			],
			latencyMs: 1,
			relevantSessionIds: ["s2"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			datasetKind: "longmemeval",
		})

		expect(evaluation.longMemEval?.session).toMatchObject({
			recallAnyAt1: 0,
			recallAnyAt3: 0,
			recallAnyAt5: 1,
			ndcgAnyAt5: 0.5,
		})
		expect(evaluation.officialMetric).toEqual({ status: "scored" })
	})

	it("never credits DCG twice for the same relevant id across flattened slots", () => {
		// Two memories both attributed to the one relevant session: the
		// flattened projection puts s1 in two consecutive rank slots. Gain must
		// be awarded once — the 2026-07-30 regression run produced session
		// nDCG 1.564 (> 1 is impossible) because every duplicate slot was
		// credited while IDCG assumed one appearance.
		const evaluation = evaluateRankingCase({
			results: [
				makeResult({ path: "mem-a", score: 0.9, sessionId: "s1" }),
				makeResult({ path: "mem-b", score: 0.8, sessionId: "s1" }),
			],
			latencyMs: 1,
			relevantSessionIds: ["s1"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			datasetKind: "longmemeval",
		})

		const session = evaluation.longMemEval?.session
		expect(session?.ndcgAnyAt3).toBe(1)
		expect(session?.ndcgAnyAt10).toBe(1)
		expect(session?.recallAnyAt1).toBe(1)
	})

	it("excludes cases outside the pinned LongMemEval main-run denominator", () => {
		const evaluation = evaluateRankingCase({
			results: [makeResult({ path: "answer", score: 0.9, sessionId: "s1" })],
			latencyMs: 1,
			relevantSessionIds: ["s1"],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
			datasetKind: "longmemeval",
			officialRetrieval: {
				eligible: false,
				expectedSessionIds: [],
				expectedTurnIds: [],
				ineligibleReason: "no-user-answer-target",
			},
		})

		expect(evaluation.longMemEval).toBeUndefined()
		expect(evaluation.officialMetric).toEqual({
			status: "ineligible",
			reason: "no-user-answer-target",
		})
	})

	it("computes LoCoMo evidence recall from session and dialog IDs", () => {
		const evaluation = evaluateRankingCase({
			results: [
				makeResult({ path: "a", score: 0.9, sessionId: "sample::session_2" }),
				makeResult({ path: "b", score: 0.8, sourceEventIds: ["evt-1"] }),
			],
			latencyMs: 42,
			relevantSessionIds: ["sample::session_1"],
			relevantDialogIds: ["D1:1", "D1:2"],
			resolveSessionIds: (result) => {
				if (result.sessionId) {
					return [result.sessionId]
				}
				return result.sourceEventIds?.includes("evt-1")
					? ["sample::session_1"]
					: []
			},
			resolveDialogIds: (result) =>
				result.sourceEventIds?.includes("evt-1") ? ["D1:1"] : [],
			datasetKind: "locomo",
			questionType: "category-2",
		})

		expect(evaluation.loCoMo?.sessionEvidenceRecallAt5).toBe(1)
		expect(evaluation.loCoMo?.dialogEvidenceRecallAt5).toBe(0.5)
	})

	it("marks cases without relevance judgments as skipped for ranking metrics", () => {
		const evaluation = evaluateRankingCase({
			results: [makeResult({ path: "a", score: 0.9, sessionId: "session-3" })],
			latencyMs: 12,
			relevantSessionIds: [],
			resolveSessionIds: (result) =>
				result.sessionId ? [result.sessionId] : [],
		})

		expect(evaluation.scored).toBe(false)
		expect(evaluation.rAt5).toBe(0)
		expect(evaluation.ndcgAt10).toBe(0)
	})

	it("labels the native lane canonical under the flattened attribution projection", () => {
		const summary = summarizeBenchmarkExecutions({
			datasetKind: "longmemeval",
			retrievalLane: "native",
			executions: [
				evaluateRankingCase({
					results: [makeResult({ path: "a", score: 0.9, sessionId: "s1" })],
					latencyMs: 1,
					relevantSessionIds: ["s1"],
					resolveSessionIds: (result) =>
						result.sessionId ? [result.sessionId] : [],
					datasetKind: "longmemeval",
				}),
			],
		})

		expect(summary.officialMetrics?.longMemEval?.evaluator).toMatchObject({
			candidateProjection: "native-source-attribution-flattened",
			comparability: "canonical",
		})
		expect(summary.officialMetrics?.longMemEval?.retrievalCases).toBe(1)
		expect(summary.officialMetrics?.longMemEval?.projectionFailureCases).toBe(0)
	})

	it("keeps the raw-session lane on the one-document-one-label projection", () => {
		const summary = summarizeBenchmarkExecutions({
			datasetKind: "longmemeval",
			retrievalLane: "raw-session",
			executions: [
				evaluateRankingCase({
					results: [makeResult({ path: "a", score: 0.9, sessionId: "s1" })],
					latencyMs: 1,
					relevantSessionIds: ["s1"],
					resolveSessionIds: (result) =>
						result.sessionId ? [result.sessionId] : [],
					datasetKind: "longmemeval",
				}),
			],
		})

		expect(summary.officialMetrics?.longMemEval?.evaluator).toMatchObject({
			candidateProjection: "one-session-document-one-label",
			comparability: "canonical",
		})
	})

	it("summarizes executions with question-type breakdown", () => {
		const summary = summarizeBenchmarkExecutions({
			datasetName: "LongMemEval",
			datasetKind: "longmemeval",
			scenarios: 2,
			executions: [
				{
					datasetKind: "longmemeval",
					questionType: "single-session",
					empty: false,
					topScore: 0.9,
					latencyMs: 10,
					scored: true,
					hit: true,
					rAt5: 1,
					rAt10: 1,
					ndcgAt10: 1,
					longMemEval: {
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
				},
				{
					datasetKind: "longmemeval",
					questionType: "single-session",
					empty: true,
					topScore: 0,
					latencyMs: 20,
					scored: true,
					hit: false,
					rAt5: 0,
					rAt10: 0,
					ndcgAt10: 0,
					longMemEval: {
						session: {
							recallAnyAt1: 0,
							recallAllAt1: 0,
							ndcgAnyAt1: 0,
							recallAnyAt3: 0,
							recallAllAt3: 0,
							ndcgAnyAt3: 0,
							recallAnyAt5: 0,
							recallAllAt5: 0,
							ndcgAnyAt5: 0,
							recallAnyAt10: 0,
							recallAllAt10: 0,
							ndcgAnyAt10: 0,
							recallAnyAt30: 0,
							recallAllAt30: 0,
							ndcgAnyAt30: 0,
							recallAnyAt50: 0,
							recallAllAt50: 0,
							ndcgAnyAt50: 0,
						},
					},
				},
				{
					datasetKind: "longmemeval",
					questionType: "abstention",
					abstention: true,
					empty: false,
					topScore: 0.5,
					latencyMs: 30,
					scored: false,
					hit: false,
					rAt5: 0,
					rAt10: 0,
					ndcgAt10: 0,
				},
			],
			ingest: {
				conversationsIngested: 2,
				turnsIngested: 12,
				skippedConversations: 0,
				failedLines: 0,
				failedTurns: 1,
			},
		})

		expect(summary.cases).toBe(3)
		expect(summary.scoredCases).toBe(2)
		expect(summary.skippedCases).toBe(1)
		expect(summary.hitRate).toBe(0.5)
		expect(summary.emptyRate).toBe(0.5)
		expect(summary.rAt5).toBe(0.5)
		expect(summary.officialMetrics?.longMemEval).toEqual(
			expect.objectContaining({
				retrievalCases: 2,
				abstentionCases: 1,
				session: expect.objectContaining({
					recallAllAt5: 0.5,
					ndcgAnyAt10: 0.5,
				}),
			}),
		)
		expect(summary.questionTypeBreakdown).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					questionType: "single-session",
					cases: 2,
					scoredCases: 2,
					hitRate: 0.5,
				}),
			]),
		)
		expect(summary.ingest?.failedTurns).toBe(1)
	})

	it("builds advisory query-governance candidates from benchmark evidence", () => {
		const report = buildQueryGovernanceReport({
			datasetName: "LongMemEval sample",
			datasetKind: "longmemeval",
			cases: 12,
			hitRate: 0.92,
			p95LatencyMs: 44,
			rAt5: 0.95,
			ndcgAt10: 0.9,
		})

		expect(report.status).toBe("advisory-only")
		expect(report.candidates).toEqual([
			expect.objectContaining({
				candidateId: "search-detailed-hybrid-rank-fusion",
				source: "benchmark",
				queryShapeFamily: "search-detailed",
				scope: "cluster",
				recommendedAction: "consider-setQuerySettings",
			}),
		])
		expect(report.notes).toContain(
			"Operational only: do not hardcode setQuerySettings assumptions into application logic.",
		)
	})

	it("builds an operations report with build identity, gates, and warnings", () => {
		const previousCommit = process.env.MEMONGO_BUILD_COMMIT
		process.env.MEMONGO_BUILD_COMMIT = "abc123"
		try {
			const queryGovernance = buildQueryGovernanceReport({
				datasetName: "legacy.jsonl",
				datasetKind: "legacy-query",
				cases: 2,
				hitRate: 0.5,
				p95LatencyMs: 44,
			})
			const report = buildBenchmarkRunReport({
				datasetVersion: "legacy-v1",
				datasetName: "legacy.jsonl",
				datasetKind: "legacy-query",
				cases: 2,
				scoredCases: 1,
				skippedCases: 1,
				hitRate: 0.5,
				emptyRate: 0.5,
				avgTopScore: 0.4,
				p95LatencyMs: 44,
				rAt5: 0.5,
				rAt10: 0.5,
				ndcgAt10: 0.4,
				ingest: {
					conversationsIngested: 1,
					turnsIngested: 2,
					skippedConversations: 0,
					failedLines: 1,
					failedTurns: 1,
				},
				queryGovernance,
			})

			expect(report.build).toEqual(
				expect.objectContaining({
					source: "env",
					commitSha: "abc123",
				}),
			)
			expect(report.releaseGates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						gate: "official-retrieval",
						status: "failed",
					}),
					expect.objectContaining({
						gate: "query-governance",
						status: "advisory-only",
					}),
				]),
			)
			expect(report.warnings).toEqual(
				expect.arrayContaining([
					expect.stringContaining("legacy-query datasets"),
					expect.stringContaining("officialMetrics are absent"),
					expect.stringContaining("1 benchmark cases were skipped"),
					expect.stringContaining("1 dataset lines failed to parse"),
					expect.stringContaining("1 benchmark turns failed ingest"),
				]),
			)
			expect(report.degradations).toEqual(
				expect.arrayContaining(["emptyRate=0.5000", "scoredCases=1/2"]),
			)
		} finally {
			if (previousCommit == null) {
				delete process.env.MEMONGO_BUILD_COMMIT
			} else {
				process.env.MEMONGO_BUILD_COMMIT = previousCommit
			}
		}
	})

	it("passes official retrieval only when all benchmark cases are scored", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval.json",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 2,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			rAt5: 1,
			rAt10: 1,
			ndcgAt10: 1,
			officialMetrics,
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "official-retrieval",
					status: "passed",
					evidence:
						"2/2 LongMemEval main-run eligible cases scored with evaluator 9e0b455f4ef0e2ab8f2e582289761153549043fc",
				}),
			]),
		)
		expect(report.warnings).not.toEqual(
			expect.arrayContaining([expect.stringContaining("officialMetrics")]),
		)
	})

	it("fails when official metrics have zero benchmark cases", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval.json",
			datasetKind: "longmemeval",
			cases: 0,
			scoredCases: 0,
			hitRate: 0,
			emptyRate: 0,
			avgTopScore: 0,
			p95LatencyMs: 0,
			officialMetrics,
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "official-retrieval",
					status: "failed",
					evidence:
						"officialMetrics present, but no benchmark cases were available",
				}),
			]),
		)
		expect(report.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("no benchmark cases were available"),
			]),
		)
	})

	it("uses evaluator-specific coverage instead of the internal scored denominator", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval.json",
			datasetKind: "longmemeval",
			cases: 2,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			officialMetrics,
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "official-retrieval",
					status: "passed",
				}),
			]),
		)
	})

	it("fails when official metrics only score part of the eligible corpus", () => {
		const partialOfficialMetrics: MemoryBenchmarkOfficialMetrics = {
			longMemEval: {
				...officialMetrics.longMemEval!,
				retrievalCases: 1,
			},
		}
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval.json",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			officialMetrics: partialOfficialMetrics,
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "official-retrieval",
					status: "failed",
					evidence: "1/2 LongMemEval main-run eligible cases scored",
				}),
			]),
		)
		expect(report.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("1/2 benchmark cases were scored"),
			]),
		)
	})

	it("rejects adapted native metrics as an official LongMemEval result", () => {
		const adaptedOfficialMetrics: MemoryBenchmarkOfficialMetrics = {
			longMemEval: {
				...officialMetrics.longMemEval!,
				evaluator: {
					...officialMetrics.longMemEval!.evaluator,
					candidateProjection: "native-memory-source-session-adapter",
					comparability: "adapted",
				},
			},
		}
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 2,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			officialMetrics: adaptedOfficialMetrics,
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "official-retrieval",
					status: "failed",
					evidence: expect.stringContaining("projection is adapted"),
				}),
			]),
		)
	})

	it("emits parity envelope fields when Task 1.A parity inputs are provided (Task 1.A)", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval_s.json",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 2,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			rAt5: 1,
			rAt10: 1,
			ndcgAt10: 1,
			runIdentity: {
				runId: "run-report",
				datasetSha256: "a".repeat(64),
				retrievalUnit: "turn",
				configurationHash: "b".repeat(64),
				executionProfile: "diagnostic",
				retrievalLane: "native",
				maxResults: 50,
				minScore: 0.01,
				settings: {},
			},
			embedding: {
				model: "voyage-3",
				dimensions: 1024,
				quantization: "float32",
			},
			reranker: {
				model: "rerank-2",
				version: null,
				stage: "post-fusion",
			},
			storage: {
				basis: "benchmark-agent-logical-plus-shared-physical",
				tenant: { documents: 2, logicalBytes: 512, collections: [] },
				sharedPhysical: {
					collections: [
						{
							collectionName: "memongo_events",
							collectionBytes: 1024,
							indexBytes: 2048,
						},
					],
				},
			},
			latency: {
				p50Ms: 20,
				p95Ms: 44,
			},
			cost: benchmarkCost([
				{
					operation: "rerank",
					attempted: 5,
					succeeded: 5,
					failed: 0,
				},
			]),
		})

		expect(report.runIdentity?.datasetSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(report.runIdentity?.retrievalUnit).toBe("turn")
		expect(report.embedding?.model).toBe("voyage-3")
		expect(report.embedding?.dimensions).toBe(1024)
		expect(report.embedding?.quantization).toBe("float32")
		expect(report.reranker?.model).toBe("rerank-2")
		expect(report.reranker?.version).toBeNull()
		expect(report.reranker?.stage).toBe("post-fusion")
		expect(report.storage?.tenant.logicalBytes).toBe(512)
		expect(report.storage?.sharedPhysical.collections[0]?.indexBytes).toBe(2048)
		expect(report.latency?.p50Ms).toBe(20)
		expect(report.latency?.p95Ms).toBe(44)
		expect(report.cost?.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operation: "embedding",
					observability: "unknown",
					attempted: null,
				}),
				expect.objectContaining({
					operation: "rerank",
					attempted: 5,
					succeeded: 5,
					failed: 0,
				}),
			]),
		)
		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "evidence-completeness",
					status: "failed",
					evidence: expect.stringContaining("monetary cost"),
				}),
			]),
		)
	})

	it("emits storage null-with-reason when collStats is unavailable (Task 1.A)", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval_s.json",
			datasetKind: "longmemeval",
			cases: 1,
			scoredCases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 30,
			runIdentity: {
				datasetSha256: "b".repeat(64),
				retrievalUnit: "turn",
			},
			storage: {
				basis: "benchmark-agent-logical-plus-shared-physical",
				tenant: {
					documents: null,
					logicalBytes: null,
					collections: [],
					unavailableReason: "tenant-measurement-unavailable",
				},
				sharedPhysical: {
					collections: [
						{
							collectionName: "memongo_events",
							collectionBytes: null,
							indexBytes: null,
							unavailableReason: "collStats-unsupported-on-atlas-local-preview",
						},
					],
				},
			},
		})

		expect(
			report.storage?.sharedPhysical.collections[0]?.collectionBytes,
		).toBeNull()
		expect(
			report.storage?.sharedPhysical.collections[0]?.unavailableReason,
		).toBe("collStats-unsupported-on-atlas-local-preview")
	})

	it("accepts Gate-5 e2eQa extensions (may be null at Phase 1) (Task 1.A)", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval_s.json",
			datasetKind: "longmemeval",
			cases: 1,
			scoredCases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 30,
			runIdentity: {
				datasetSha256: "c".repeat(64),
				retrievalUnit: "turn",
			},
			e2eQa: {
				judge: null,
				judgeVersion: null,
				accuracy: null,
				latencyMs: null,
				judgeFalsePositiveRate: null,
			},
		})

		expect(report.e2eQa).toBeDefined()
		expect(report.e2eQa?.judge).toBeNull()
		expect(report.e2eQa?.accuracy).toBeNull()
	})

	it("projectBenchmarkParityFields wires every parity field into the report (Task 1.A projection)", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-parity-proj-"))
		const datasetPath = path.join(dir, "canary.jsonl")
		writeFileSync(datasetPath, "parity-fixture-bytes")

		const mockDb = {
			command: async () => ({ size: 4096, totalIndexSize: 8192 }),
		}

		const projected = await projectBenchmarkParityFields({
			db: mockDb as unknown as Parameters<
				typeof projectBenchmarkParityFields
			>[0]["db"],
			collectionName: "memongo_bench_events",
			datasetPath,
			datasetKind: "longmemeval",
			mongoEmbeddingConfig: {
				numDimensions: 1024,
				quantization: "none",
			},
			mongoRerankerConfig: {
				enabled: true,
				model: "rerank-2.5",
				topN: 20,
			},
			latencySamples: [10, 20, 30, 40, 50],
			cost: benchmarkCost([
				{
					operation: "rerank",
					attempted: 3,
					succeeded: 3,
					failed: 0,
				},
				{
					operation: "enrichment",
					attempted: 2,
					succeeded: 2,
					failed: 0,
				},
			]),
			runContext: benchmarkRunContext(),
		})

		expect(projected.runIdentity?.datasetSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(projected.runIdentity?.retrievalUnit).toBe("turn")
		expect(projected.embedding?.model).toBe("voyage-4-large")
		expect(projected.embedding?.dimensions).toBe(1024)
		expect(projected.embedding?.quantization).toBe("float32")
		expect(projected.reranker?.model).toBe("rerank-2.5")
		expect(projected.reranker?.stage).toBe("post-fusion")
		expect(projected.storage?.sharedPhysical.collections[0]).toEqual(
			expect.objectContaining({
				collectionBytes: 4096,
				indexBytes: 8192,
			}),
		)
		expect(projected.latency?.p50Ms).toBeGreaterThanOrEqual(0)
		expect(projected.latency?.p95Ms).toBeGreaterThanOrEqual(
			projected.latency?.p50Ms ?? 0,
		)
		expect(projected.cost?.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operation: "embedding",
					observability: "unknown",
				}),
				expect.objectContaining({
					operation: "rerank",
					attempted: 3,
				}),
				expect.objectContaining({
					operation: "enrichment",
					attempted: 2,
				}),
			]),
		)
	})

	it("projectBenchmarkParityFields records session retrieval for raw-session lane", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-parity-session-"))
		const datasetPath = path.join(dir, "dataset.json")
		writeFileSync(datasetPath, "raw-session-fixture")
		const mockDb = {
			command: async () => ({ size: 1024, totalIndexSize: 2048 }),
		}

		const projected = await projectBenchmarkParityFields({
			db: mockDb as unknown as Parameters<
				typeof projectBenchmarkParityFields
			>[0]["db"],
			collectionName: "memongo_bench_session_chunks",
			datasetPath,
			datasetKind: "longmemeval",
			retrievalLane: "raw-session",
			mongoEmbeddingConfig: {
				numDimensions: 1024,
				quantization: "none",
			},
			mongoRerankerConfig: {
				enabled: false,
				model: "none",
				topN: 0,
			},
			latencySamples: [10],
			cost: benchmarkCost(),
			runContext: benchmarkRunContext("raw-session"),
		})

		expect(projected.runIdentity?.retrievalUnit).toBe("session")
		expect(projected.reranker?.stage).toBe("none")
		expect(projected.reranker?.model).toBe("none")
	})

	it("projectBenchmarkParityFields returns null-with-reason storage when collStats throws (atlas-local:preview)", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-parity-proj-"))
		const datasetPath = path.join(dir, "canary.jsonl")
		writeFileSync(datasetPath, "x")

		const throwingDb = {
			command: async () => {
				throw new Error("Cannot do collStats on collection ... not supported")
			},
		}

		const projected = await projectBenchmarkParityFields({
			db: throwingDb as unknown as Parameters<
				typeof projectBenchmarkParityFields
			>[0]["db"],
			collectionName: "memongo_bench_events",
			datasetPath,
			datasetKind: "longmemeval",
			mongoEmbeddingConfig: {
				numDimensions: 1024,
				quantization: "none",
			},
			mongoRerankerConfig: {
				enabled: true,
				model: "rerank-2.5",
				topN: 20,
			},
			latencySamples: [42],
			cost: benchmarkCost(),
			runContext: benchmarkRunContext(),
		})

		expect(projected.storage?.sharedPhysical.collections[0]).toEqual(
			expect.objectContaining({
				collectionBytes: null,
				indexBytes: null,
				unavailableReason: expect.stringMatching(/collStats/i),
			}),
		)
	})

	it("fails when official metrics score more cases than the corpus declares", () => {
		const oversizedOfficialMetrics: MemoryBenchmarkOfficialMetrics = {
			longMemEval: {
				...officialMetrics.longMemEval!,
				totalCases: 3,
				eligibleCases: 3,
				retrievalCases: 3,
			},
		}
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval.json",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 3,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			officialMetrics: oversizedOfficialMetrics,
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "official-retrieval",
					status: "failed",
					evidence: "LongMemEval evaluator covered 3/2 total cases",
				}),
			]),
		)
		expect(report.degradations).toEqual(
			expect.arrayContaining(["scoredCases=3/2"]),
		)
	})
})

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
