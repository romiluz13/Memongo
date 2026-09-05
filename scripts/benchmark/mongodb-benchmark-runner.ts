import type { Db } from "mongodb"
import {
	collectStorageFootprint,
	percentile50And95,
	type BenchmarkRetrievalLane,
	type BenchmarkRunContext,
	resolveBenchmarkEmbeddingConfig,
	resolveBenchmarkRerankerConfig,
	resolveDatasetSha256,
	resolveRetrievalUnit,
} from "./benchmark-parity-envelope.js"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import type {
	BenchmarkCostAccounting,
	BenchmarkE2eQaEnvelope,
	BenchmarkEmbeddingConfig,
	BenchmarkLatencyDistribution,
	BenchmarkQualityThresholds,
	BenchmarkRerankerConfig,
	BenchmarkRunIdentity,
	BenchmarkStorageFootprint,
	BenchmarkTenantStorageMeasurement,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkCaseOutcome,
	MemoryBenchmarkExecutionSummary,
	MemoryBenchmarkLaneLatencySummary,
	MemoryBenchmarkMeasurementPasses,
	MemoryBenchmarkOfficialMetrics,
	MemoryBenchmarkOfficialRetrievalMetrics,
	MemoryBenchmarkQuestionTypeMetrics,
	MemoryBenchmarkRunReport,
	QueryGovernanceReport,
} from "../../packages/memory-engine/src/types.js"

const LONGMEMEVAL_EVALUATOR_SOURCE = {
	suite: "longmemeval",
	sourceRepository: "xiaowu0162/LongMemEval",
	sourceCommit: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
	evaluatorPath: "src/retrieval/eval_utils.py",
	evaluatorBlob: "9c43a835e7c41aff0eb3272c448f5cbe76bbbd45",
	aggregationEntrypoint: "src/retrieval/run_retrieval.py",
	cutoffs: [1, 3, 5, 10, 30, 50],
	eligibilityPolicy: "exclude-abstention-and-no-user-answer-target",
} as const

export type BenchmarkCandidateTrace = {
	rank: number
	score: number
	finalScore: number
	fusionScore?: number
	source: string
	lane: string
	canonicalId?: string
	sessionId?: string
	resolvedSessionIds?: string[]
	sourceEventIds?: string[]
	resolvedTurnIds?: string[]
	path: string
	timestamp?: string
	whySurvived: string
	/**
	 * Task 35 observability (Fix #3): per-lane rank-fusion scoring
	 * breakdown when the retrieval path emitted it. Lets Phase 5
	 * investigators see WHICH lane contributed the winning score for
	 * each candidate — critical for confirming the gauss-decay boost
	 * actually fires on multi-session temporal queries. Populated from
	 * the upstream `MemorySearchResult.scoreDetails` when present.
	 */
	scoreDetails?: import("../../packages/memory-engine/src/types.js").MemorySearchScoreDetails
}

export type BenchmarkMissLedgerEntry = {
	caseId?: string
	questionType?: string
	rAt5: number
	rAt10: number
	expectedSessionIds: string[]
	expectedTurnIds: string[]
	/** Session IDs from the top 10 candidates */
	topCandidateSessionIds: string[]
	/** Whether at least one expected session appears in top 10 */
	sessionFound: boolean
	/** Whether ALL expected sessions appear in top 10 */
	allSessionsFound: boolean
	/** Turn IDs reachable via sourceEventIds of top 10 candidates */
	reachableTurnIds: string[]
	/** Whether at least one expected turn is reachable */
	turnReachable: boolean
	/** Inferred miss category based on what's missing */
	missCategory:
		| "preference"
		| "temporal"
		| "update"
		| "turn-selection"
		| "unknown"
	/** Top candidates with source, score, and lane context for inspection */
	topCandidates: Array<{
		rank: number
		score: number
		finalScore: number
		fusionScore?: number
		source: string
		lane: string
		sessionId?: string
		canonicalId?: string
		resolvedSessionIds?: string[]
		resolvedTurnIds?: string[]
		sourceEventIds?: string[]
		path: string
		whySurvived: string
	}>
}

export type BenchmarkCaseDiagnosticEntry = {
	caseId?: string
	questionType?: string
	rAt5: number
	rAt10: number
	ndcgAt10: number
	issue: "top1-session" | "top1-turn" | "top1-session-and-turn" | "recall-at-5"
	expectedSessionIds: string[]
	expectedTurnIds: string[]
	topCandidateSessionIds: string[]
	topCandidateTurnIds: string[]
	sessionTop1Found?: boolean
	turnTop1Found?: boolean
	longMemEval?: BenchmarkCaseExecution["longMemEval"]
	topCandidates: Array<{
		rank: number
		score: number
		source: string
		path: string
		sessionId?: string
		canonicalId?: string
		resolvedSessionIds?: string[]
		resolvedTurnIds?: string[]
		sourceEventIds?: string[]
	}>
}

export type BenchmarkCaseExecution = {
	caseId?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	questionType?: string
	abstention?: boolean
	executionStatus: MemoryBenchmarkCaseOutcome["executionStatus"]
	scoreEligibility: MemoryBenchmarkCaseOutcome["scoreEligibility"]
	retrievalOutcome: MemoryBenchmarkCaseOutcome["retrievalOutcome"]
	error?: string
	empty: boolean
	topScore: number
	latencyMs: number
	latencyByLane?: Record<string, number>
	scored: boolean
	hit: boolean
	rAt5: number
	rAt10: number
	ndcgAt10: number
	topCandidates?: BenchmarkCandidateTrace[]
	longMemEval?: {
		session?: MemoryBenchmarkOfficialRetrievalMetrics
		turn?: MemoryBenchmarkOfficialRetrievalMetrics
	}
	officialMetric?:
		| { status: "scored" }
		| {
				status: "ineligible" | "projection-failure" | "execution-failure"
				reason: string
		  }
	loCoMo?: {
		sessionEvidenceRecallAt5: number
		sessionEvidenceRecallAt10: number
		dialogEvidenceRecallAt5?: number
		dialogEvidenceRecallAt10?: number
	}
}

export type BenchmarkSummary = {
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	scenarios?: number
	cases: number
	scoredCases: number
	skippedCases: number
	execution: MemoryBenchmarkExecutionSummary
	caseOutcomes: MemoryBenchmarkCaseOutcome[]
	hitRate: number
	emptyRate: number
	avgTopScore: number
	p95LatencyMs: number
	laneLatencyP95?: MemoryBenchmarkLaneLatencySummary
	rAt5: number
	rAt10: number
	ndcgAt10: number
	questionTypeBreakdown: MemoryBenchmarkQuestionTypeMetrics[]
	officialMetrics?: MemoryBenchmarkOfficialMetrics
	ingest?: {
		conversationsIngested: number
		turnsIngested: number
		skippedConversations: number
		failedLines: number
		failedTurns: number
	}
}

type BenchmarkReportInput = {
	datasetVersion: string
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	scenarios?: number
	cases: number
	scoredCases?: number
	skippedCases?: number
	execution?: MemoryBenchmarkExecutionSummary
	caseOutcomes?: MemoryBenchmarkCaseOutcome[]
	hitRate: number
	emptyRate: number
	avgTopScore: number
	p95LatencyMs: number
	rAt5?: number
	rAt10?: number
	ndcgAt10?: number
	officialMetrics?: MemoryBenchmarkOfficialMetrics
	ingest?: BenchmarkSummary["ingest"]
	queryGovernance?: QueryGovernanceReport
	/** Task 1.A parity envelope (optional at Phase 1; required at Gate 3). */
	runIdentity?: BenchmarkRunIdentity
	embedding?: BenchmarkEmbeddingConfig
	reranker?: BenchmarkRerankerConfig
	storage?: BenchmarkStorageFootprint
	latency?: BenchmarkLatencyDistribution
	cost?: BenchmarkCostAccounting
	e2eQa?: BenchmarkE2eQaEnvelope
	qualityThresholds?: BenchmarkQualityThresholds
	/**
	 * #70: real outcome of the conversation-recall regression suite for THIS
	 * invocation. Absent means the suite did not run alongside the benchmark,
	 * and the gate stays "not-run" — which blocks publication by design.
	 */
	conversationRecallRegression?: {
		status: "passed" | "failed"
		evidence: string
	}
}

function readBuildIdentity(): MemoryBenchmarkRunReport["build"] {
	const commitSha =
		process.env.MEMONGO_BUILD_COMMIT?.trim() ||
		process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
		process.env.GITHUB_SHA?.trim() ||
		""
	const buildId =
		process.env.MEMONGO_BUILD_ID?.trim() ||
		process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
		process.env.GITHUB_RUN_ID?.trim() ||
		""
	const buildLabel =
		process.env.MEMONGO_BUILD_LABEL?.trim() ||
		process.env.npm_package_version?.trim() ||
		""

	return {
		source: commitSha || buildId || buildLabel ? "env" : "unknown",
		...(commitSha ? { commitSha } : {}),
		...(buildId ? { buildId } : {}),
		...(buildLabel ? { buildLabel } : {}),
	}
}

function buildBenchmarkWarnings(params: BenchmarkReportInput): string[] {
	const warnings: string[] = []
	if (params.datasetKind === "legacy-query") {
		warnings.push(
			"legacy-query datasets are non-comparable diagnostics and must not be published as official LongMemEval or LoCoMo wins",
		)
	}
	if (!params.officialMetrics) {
		warnings.push(
			"officialMetrics are absent; publish only as non-comparable diagnostics unless paired with an official benchmark run",
		)
	}
	if (params.officialMetrics && params.cases === 0) {
		warnings.push(
			"officialMetrics are present but no benchmark cases were available; do not publish as an official retrieval win",
		)
	}
	if (params.officialMetrics && params.scoredCases == null) {
		warnings.push(
			"officialMetrics are present but scoredCases is missing; official retrieval gate cannot pass",
		)
	}
	if (
		params.officialMetrics &&
		params.scoredCases != null &&
		params.scoredCases !== params.cases
	) {
		warnings.push(
			`officialMetrics are present but ${params.scoredCases}/${params.cases} benchmark cases were scored`,
		)
	}
	if ((params.skippedCases ?? 0) > 0) {
		warnings.push(`${params.skippedCases} benchmark cases were skipped`)
	}
	if ((params.ingest?.failedLines ?? 0) > 0) {
		warnings.push(`${params.ingest?.failedLines} dataset lines failed to parse`)
	}
	if ((params.ingest?.failedTurns ?? 0) > 0) {
		warnings.push(`${params.ingest?.failedTurns} benchmark turns failed ingest`)
	}
	return warnings
}

function buildBenchmarkDegradations(params: BenchmarkReportInput): string[] {
	const degradations: string[] = []
	if (params.cases === 0) {
		degradations.push("cases=0")
	}
	if (params.emptyRate > 0) {
		degradations.push(`emptyRate=${params.emptyRate.toFixed(4)}`)
	}
	if (
		params.scoredCases != null &&
		params.cases > 0 &&
		params.scoredCases !== params.cases
	) {
		degradations.push(`scoredCases=${params.scoredCases ?? 0}/${params.cases}`)
	}
	return degradations
}

function buildOfficialRetrievalGate(
	params: BenchmarkReportInput,
): MemoryBenchmarkRunReport["releaseGates"][number] {
	if (!params.officialMetrics) {
		return {
			gate: "official-retrieval",
			status: "failed",
			evidence: "officialMetrics absent; use non-comparable diagnostics only",
		}
	}
	if (params.cases === 0) {
		return {
			gate: "official-retrieval",
			status: "failed",
			evidence:
				"officialMetrics present, but no benchmark cases were available",
		}
	}
	const longMemEval = params.officialMetrics.longMemEval
	if (longMemEval) {
		if (longMemEval.evaluator.comparability !== "canonical") {
			return {
				gate: "official-retrieval",
				status: "failed",
				evidence: `LongMemEval evaluator projection is ${longMemEval.evaluator.comparability}: ${longMemEval.evaluator.candidateProjection}`,
			}
		}
		if (longMemEval.totalCases !== params.cases) {
			return {
				gate: "official-retrieval",
				status: "failed",
				evidence: `LongMemEval evaluator covered ${longMemEval.totalCases}/${params.cases} total cases`,
			}
		}
		if (
			longMemEval.projectionFailureCases > 0 ||
			longMemEval.executionFailureCases > 0
		) {
			return {
				gate: "official-retrieval",
				status: "failed",
				evidence: `${longMemEval.projectionFailureCases} canonical projection failures; ${longMemEval.executionFailureCases} execution failures`,
			}
		}
		if (longMemEval.retrievalCases !== longMemEval.eligibleCases) {
			return {
				gate: "official-retrieval",
				status: "failed",
				evidence: `${longMemEval.retrievalCases}/${longMemEval.eligibleCases} LongMemEval main-run eligible cases scored`,
			}
		}
		return {
			gate: "official-retrieval",
			status: "passed",
			evidence: `${longMemEval.retrievalCases}/${longMemEval.eligibleCases} LongMemEval main-run eligible cases scored with evaluator ${longMemEval.evaluator.sourceCommit}`,
		}
	}
	if (params.scoredCases == null) {
		return {
			gate: "official-retrieval",
			status: "failed",
			evidence:
				"officialMetrics present, but scoredCases is missing; use non-comparable diagnostics only",
		}
	}
	if ((params.execution?.failedCases ?? 0) > 0) {
		return {
			gate: "official-retrieval",
			status: "failed",
			evidence: `${params.execution?.failedCases ?? 0}/${params.cases} benchmark cases failed execution`,
		}
	}
	const coveredCases =
		params.scoredCases + (params.execution?.abstentionCases ?? 0)
	if (coveredCases !== params.cases) {
		return {
			gate: "official-retrieval",
			status: "failed",
			evidence: `officialMetrics present, but ${coveredCases}/${params.cases} benchmark cases were scored or identified as abstentions`,
		}
	}
	return {
		gate: "official-retrieval",
		status: "passed",
		evidence: `officialMetrics present and all ${coveredCases}/${params.cases} benchmark cases evaluated`,
	}
}

function buildQualityThresholdGate(
	params: BenchmarkReportInput,
): MemoryBenchmarkRunReport["releaseGates"][number] {
	const thresholds = params.qualityThresholds
	if (!thresholds) {
		return {
			gate: "quality-thresholds",
			status: "failed",
			evidence: "quality thresholds were not declared before the run",
		}
	}
	if (params.datasetKind !== thresholds.datasetKind) {
		return {
			gate: "quality-thresholds",
			status: "failed",
			evidence: `quality contract datasetKind=${thresholds.datasetKind} does not match run datasetKind=${params.datasetKind ?? "unknown"}`,
		}
	}
	const checks: NonNullable<
		MemoryBenchmarkRunReport["releaseGates"][number]["checks"]
	> = [
		{
			metric: "hitRate",
			actual: params.hitRate,
			operator: ">=",
			threshold: thresholds.minHitRate,
			passed: params.hitRate >= thresholds.minHitRate,
		},
		{
			metric: "emptyRate",
			actual: params.emptyRate,
			operator: "<=",
			threshold: thresholds.maxEmptyRate,
			passed: params.emptyRate <= thresholds.maxEmptyRate,
		},
		{
			metric: "rAt5",
			actual: params.rAt5 ?? null,
			operator: ">=",
			threshold: thresholds.minRAt5,
			passed: params.rAt5 != null && params.rAt5 >= thresholds.minRAt5,
		},
		{
			metric: "ndcgAt10",
			actual: params.ndcgAt10 ?? null,
			operator: ">=",
			threshold: thresholds.minNdcgAt10,
			passed:
				params.ndcgAt10 != null && params.ndcgAt10 >= thresholds.minNdcgAt10,
		},
		{
			metric: "p95LatencyMs",
			actual: params.p95LatencyMs,
			operator: "<=",
			threshold: thresholds.maxP95LatencyMs,
			passed: params.p95LatencyMs <= thresholds.maxP95LatencyMs,
		},
	]
	if (thresholds.datasetKind === "longmemeval") {
		const official = params.officialMetrics?.longMemEval?.session
		checks.push(
			{
				metric: "official.longMemEval.session.recallAnyAt10",
				actual: official?.recallAnyAt10 ?? null,
				operator: ">=",
				threshold: thresholds.minSessionRecallAnyAt10,
				passed:
					official != null &&
					official.recallAnyAt10 >= thresholds.minSessionRecallAnyAt10,
			},
			{
				metric: "official.longMemEval.session.ndcgAnyAt10",
				actual: official?.ndcgAnyAt10 ?? null,
				operator: ">=",
				threshold: thresholds.minSessionNdcgAnyAt10,
				passed:
					official != null &&
					official.ndcgAnyAt10 >= thresholds.minSessionNdcgAnyAt10,
			},
		)
	} else {
		const official = params.officialMetrics?.loCoMo
		checks.push({
			metric: "official.loCoMo.sessionEvidenceRecallAt10",
			actual: official?.sessionEvidenceRecallAt10 ?? null,
			operator: ">=",
			threshold: thresholds.minSessionEvidenceRecallAt10,
			passed:
				official != null &&
				official.sessionEvidenceRecallAt10 >=
					thresholds.minSessionEvidenceRecallAt10,
		})
		if (thresholds.minDialogEvidenceRecallAt10 !== undefined) {
			checks.push({
				metric: "official.loCoMo.dialogEvidenceRecallAt10",
				actual: official?.dialogEvidenceRecallAt10 ?? null,
				operator: ">=",
				threshold: thresholds.minDialogEvidenceRecallAt10,
				passed:
					official?.dialogEvidenceRecallAt10 != null &&
					official.dialogEvidenceRecallAt10 >=
						thresholds.minDialogEvidenceRecallAt10,
			})
		}
	}
	const failures = checks.filter((check) => !check.passed)
	return failures.length > 0
		? {
				gate: "quality-thresholds",
				status: "failed",
				evidence: failures
					.map(
						(check) =>
							`${check.metric}=${check.actual ?? "unavailable"} ${check.operator} ${check.threshold}`,
					)
					.join("; "),
				checks,
			}
		: {
				gate: "quality-thresholds",
				status: "passed",
				evidence: `all ${thresholds.contractId}@${thresholds.version} retrieval quality thresholds passed`,
				checks,
			}
}

function buildAnswerQualityGate(
	params: BenchmarkReportInput,
): MemoryBenchmarkRunReport["releaseGates"][number] | null {
	const thresholds = params.qualityThresholds
	if (!thresholds) {
		return null
	}
	// C-039: the answer-quality gate activates when the declared contract
	// carries answer-accuracy clauses. LoCoMo declares them by type; the
	// LongMemEval V1 contract is retrieval-only (gate stays off), while V2
	// declares the same answer bar so both dataset kinds publish under one
	// answer-quality standard.
	const declared =
		thresholds.datasetKind === "locomo" ||
		thresholds.datasetKind === "longmemeval"
			? {
					minAnswerAccuracy: thresholds.minAnswerAccuracy,
					maxJudgeFalsePositiveRate: thresholds.maxJudgeFalsePositiveRate,
					minAnswerCoverage: thresholds.minAnswerCoverage,
				}
			: null
	if (!declared || declared.minAnswerAccuracy === undefined) {
		return null
	}
	const minimum = declared.minAnswerAccuracy
	const accuracy = params.e2eQa?.accuracy
	if (accuracy == null) {
		return {
			gate: "e2e-answer-quality",
			status: "failed",
			evidence: `answer accuracy is unavailable${params.e2eQa?.unavailableReason ? ` (${params.e2eQa.unavailableReason})` : ""}; required minimum=${minimum}`,
		}
	}
	const coverage =
		params.e2eQa && params.e2eQa.cases.eligible > 0
			? params.e2eQa.cases.completed / params.e2eQa.cases.eligible
			: null
	const falsePositiveRate = params.e2eQa?.judgeFalsePositiveRate ?? null
	const checks: NonNullable<
		MemoryBenchmarkRunReport["releaseGates"][number]["checks"]
	> = [
		{
			metric: "e2eQa.accuracy",
			actual: accuracy,
			operator: ">=",
			threshold: minimum,
			passed: accuracy >= minimum,
		},
	]
	// Only clauses the contract actually declared become checks, so a
	// longmemeval V2-style contract cannot be silently graded against a bar it
	// never stated.
	if (declared.minAnswerCoverage !== undefined) {
		checks.push({
			metric: "e2eQa.coverage",
			actual: coverage,
			operator: ">=",
			threshold: declared.minAnswerCoverage,
			passed: coverage != null && coverage >= declared.minAnswerCoverage,
		})
	}
	if (declared.maxJudgeFalsePositiveRate !== undefined) {
		checks.push({
			metric: "e2eQa.judgeFalsePositiveRate",
			actual: falsePositiveRate,
			operator: "<=",
			threshold: declared.maxJudgeFalsePositiveRate,
			passed:
				falsePositiveRate != null &&
				falsePositiveRate <= declared.maxJudgeFalsePositiveRate,
		})
	}
	return checks.every((check) => check.passed)
		? {
				gate: "e2e-answer-quality",
				status: "passed",
				evidence:
					"all declared answer-quality and judge-calibration thresholds passed",
				checks,
			}
		: {
				gate: "e2e-answer-quality",
				status: "failed",
				evidence: checks
					.filter((check) => !check.passed)
					.map(
						(check) =>
							`${check.metric}=${check.actual ?? "unavailable"} ${check.operator} ${check.threshold}`,
					)
					.join("; "),
				checks,
			}
}

function buildEvidenceCompletenessGate(
	params: BenchmarkReportInput,
	build: MemoryBenchmarkRunReport["build"],
): MemoryBenchmarkRunReport["releaseGates"][number] {
	const missing: string[] = []
	if (build.source !== "env" || !build.commitSha) {
		missing.push("build commit identity")
	}
	if (!params.runIdentity?.runId || !params.runIdentity.configurationHash) {
		missing.push("immutable run identity")
	}
	if (!params.embedding) missing.push("embedding configuration")
	if (!params.reranker) missing.push("reranker configuration")
	if (!params.latency) missing.push("latency distribution")
	if (!params.storage) {
		missing.push("storage evidence")
	} else {
		if (
			params.storage.tenant.documents == null ||
			params.storage.tenant.logicalBytes == null
		) {
			missing.push("benchmark-attributed tenant storage")
		}
		if (
			params.storage.sharedPhysical.collections.length === 0 ||
			params.storage.sharedPhysical.collections.some(
				(entry) => entry.collectionBytes == null || entry.indexBytes == null,
			)
		) {
			missing.push("shared physical collection/index storage")
		}
	}
	if (!params.cost) {
		missing.push("operation accounting")
	} else {
		if (params.cost.currency == null || params.cost.totalCost == null) {
			missing.push("monetary cost")
		}
		if (
			params.cost.operations.some((entry) => entry.observability === "unknown")
		) {
			missing.push("complete operation observability")
		}
		if (
			params.cost.operations.some(
				(entry) =>
					entry.observability === "measured" &&
					(entry.attempted == null ||
						entry.succeeded == null ||
						entry.failed == null ||
						entry.attempted !== entry.succeeded + entry.failed),
			)
		) {
			missing.push("balanced operation outcomes")
		}
	}
	return missing.length === 0
		? {
				gate: "evidence-completeness",
				status: "passed",
				evidence:
					"build, run, storage, latency, configuration, operations, and monetary cost evidence are complete",
			}
		: {
				gate: "evidence-completeness",
				status: "failed",
				evidence: `publication evidence is incomplete: ${missing.join(", ")}`,
			}
}

export function buildBenchmarkRunReport(
	params: BenchmarkReportInput,
): MemoryBenchmarkRunReport {
	const build = readBuildIdentity()
	const executionFailed = (params.execution?.failedCases ?? 0) > 0
	const internalStatus =
		params.cases > 0 && !executionFailed ? "passed" : "failed"
	const answerQualityGate = buildAnswerQualityGate(params)
	const releaseGates: MemoryBenchmarkRunReport["releaseGates"] = [
		buildOfficialRetrievalGate(params),
		{
			gate: "internal-retrieval",
			status: internalStatus,
			evidence: `${params.cases} cases, ${params.scoredCases ?? params.cases} scored`,
		},
		{
			gate: "execution-completeness",
			status:
				params.execution && params.execution.failedCases === 0
					? "passed"
					: "failed",
			evidence: params.execution
				? `${params.execution.succeededCases}/${params.execution.attemptedCases} cases executed successfully; ${params.execution.failedCases} failed`
				: "per-case execution outcomes are absent",
		},
		buildQualityThresholdGate(params),
		...(answerQualityGate ? [answerQualityGate] : []),
		buildEvidenceCompletenessGate(params, build),
		params.conversationRecallRegression
			? {
					gate: "conversation-recall-regression",
					status: params.conversationRecallRegression.status,
					evidence: params.conversationRecallRegression.evidence,
				}
			: {
					gate: "conversation-recall-regression",
					status: "not-run",
					evidence:
						"conversation-recall regression suite did not run alongside this benchmark invocation (scripts/run-benchmark.ts executes it automatically); absent results block publication",
				},
		{
			gate: "query-governance",
			status: "advisory-only",
			evidence:
				params.queryGovernance?.status === "advisory-only"
					? "queryGovernance candidates are advisory-only"
					: "no queryGovernance candidates attached",
		},
	]
	const blockingGates = releaseGates
		.filter(
			(gate) => gate.status !== "passed" && gate.status !== "advisory-only",
		)
		.map((gate) => gate.gate)
	const failedGates = releaseGates
		.filter((gate) => gate.status === "failed")
		.map((gate) => gate.gate)
	return {
		generatedAt: new Date(),
		build,
		corpus: {
			datasetVersion: params.datasetVersion,
			...(params.datasetName ? { datasetName: params.datasetName } : {}),
			...(params.datasetKind ? { datasetKind: params.datasetKind } : {}),
			...(params.scenarios != null ? { scenarios: params.scenarios } : {}),
			cases: params.cases,
			...(params.scoredCases != null
				? { scoredCases: params.scoredCases }
				: {}),
			...(params.skippedCases != null
				? { skippedCases: params.skippedCases }
				: {}),
			...(params.execution ? { execution: params.execution } : {}),
			...(params.caseOutcomes ? { caseOutcomes: params.caseOutcomes } : {}),
		},
		metrics: {
			internal: {
				hitRate: params.hitRate,
				emptyRate: params.emptyRate,
				avgTopScore: params.avgTopScore,
				p95LatencyMs: params.p95LatencyMs,
				...(params.rAt5 != null ? { rAt5: params.rAt5 } : {}),
				...(params.rAt10 != null ? { rAt10: params.rAt10 } : {}),
				...(params.ndcgAt10 != null ? { ndcgAt10: params.ndcgAt10 } : {}),
			},
			...(params.officialMetrics ? { official: params.officialMetrics } : {}),
		},
		releaseGates,
		publicationDecision: {
			publishable: blockingGates.length === 0,
			failedGates,
			blockingGates,
		},
		...(params.qualityThresholds
			? { qualityThresholds: params.qualityThresholds }
			: {}),
		warnings: buildBenchmarkWarnings(params),
		degradations: buildBenchmarkDegradations(params),
		...(params.runIdentity ? { runIdentity: params.runIdentity } : {}),
		...(params.embedding ? { embedding: params.embedding } : {}),
		...(params.reranker ? { reranker: params.reranker } : {}),
		...(params.storage ? { storage: params.storage } : {}),
		...(params.latency ? { latency: params.latency } : {}),
		...(params.cost ? { cost: params.cost } : {}),
		...(params.e2eQa ? { e2eQa: params.e2eQa } : {}),
	}
}

/**
 * Task 1.A projection: compute the parity-envelope bundle (runIdentity,
 * embedding, reranker, storage, latency, cost) from runtime signals so
 * callers can pass it into `buildBenchmarkRunReport()` without duplicating
 * field logic at every call site.
 *
 * Inputs:
 *   - `db` + `collectionName` — used for `collStats`; null-with-reason on
 *     atlas-local:preview when unsupported.
 *   - `datasetPath` — always hashed from its bytes. Any declared digest is
 *     verified as an assertion against those bytes.
 *   - `datasetKind` — determines retrieval unit (currently always "turn").
 *   - `mongoEmbeddingConfig` — from resolved backend config
 *     (`numDimensions` + `quantization`).
 *   - `mongoRerankerConfig` — from resolved backend config
 *     (`enabled`, `model`, `topN`).
 *   - `latencySamples` — per-case retrieval latencies collected during
 *     the benchmark run. Emits p50 + p95.
 *   - `cost` — immutable snapshot from the run-scoped accounting ledger.
 */
export async function projectBenchmarkParityFields(params: {
	db: Pick<Db, "command">
	collectionName: string
	collectionNames?: string[]
	datasetPath?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	retrievalLane?: BenchmarkRetrievalLane
	datasetSha256Override?: string
	mongoEmbeddingConfig: {
		numDimensions: number
		quantization: "none" | "scalar" | "binary"
	}
	mongoRerankerConfig: {
		enabled: boolean
		model: string
		topN: number
	}
	latencySamples: number[]
	cost: BenchmarkCostAccounting
	runContext: BenchmarkRunContext
	tenantStorage?: BenchmarkTenantStorageMeasurement
}): Promise<{
	runIdentity: BenchmarkRunIdentity
	embedding: BenchmarkEmbeddingConfig
	reranker: BenchmarkRerankerConfig
	storage: BenchmarkStorageFootprint
	latency: BenchmarkLatencyDistribution
	cost: BenchmarkCostAccounting
}> {
	const datasetSha256 = await resolveDatasetSha256({
		datasetPath: params.datasetPath,
		override: params.datasetSha256Override,
	})
	const retrievalUnit = resolveRetrievalUnit(
		params.datasetKind,
		params.retrievalLane,
	)
	const embedding = resolveBenchmarkEmbeddingConfig(params.mongoEmbeddingConfig)
	const reranker = resolveBenchmarkRerankerConfig(params.mongoRerankerConfig)
	const storage = await collectStorageFootprint({
		db: params.db,
		collectionName: params.collectionName,
		collectionNames: params.collectionNames,
		tenant: params.tenantStorage,
	})
	const latency = percentile50And95(params.latencySamples)
	return {
		runIdentity: {
			runId: params.runContext.runId,
			datasetSha256,
			retrievalUnit,
			configurationHash: params.runContext.configurationHash,
			executionProfile: params.runContext.configuration.executionProfile,
			retrievalLane: params.runContext.configuration.retrievalLane,
			maxResults: params.runContext.configuration.maxResults,
			minScore: params.runContext.configuration.minScore,
			settings: { ...params.runContext.configuration.settings },
		},
		embedding,
		reranker,
		storage,
		latency,
		cost: params.cost,
	}
}

export function buildQueryGovernanceReport(params: {
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	cases: number
	hitRate: number
	p95LatencyMs: number
	rAt5?: number
	ndcgAt10?: number
}): QueryGovernanceReport {
	const recommendedAction =
		(params.rAt5 ?? 0) >= 0.85 || params.hitRate >= 0.85
			? "consider-setQuerySettings"
			: "inspect-query-stats"
	return {
		status: "advisory-only",
		generatedAt: new Date(),
		candidates: [
			{
				candidateId: "search-detailed-hybrid-rank-fusion",
				source: "benchmark",
				queryShapeFamily: "search-detailed",
				recipe: "hybrid",
				scope: "cluster",
				reason:
					"Benchmark evidence shows the canonical detailed-search hybrid lane is valuable enough to inspect with $queryStats before pinning any cluster-wide query settings.",
				evidence: {
					datasetName: params.datasetName,
					datasetKind: params.datasetKind,
					cases: params.cases,
					hitRate: params.hitRate,
					p95LatencyMs: params.p95LatencyMs,
					...(params.rAt5 != null ? { rAt5: params.rAt5 } : {}),
					...(params.ndcgAt10 != null ? { ndcgAt10: params.ndcgAt10 } : {}),
				},
				recommendedAction,
				rollbackNote:
					"Query settings are cluster-wide. If indexes, fusion strategy, or benchmark evidence changes, remove the setting with removeQuerySettings by shape or queryShapeHash.",
			},
		],
		notes: [
			"Operational only: do not hardcode setQuerySettings assumptions into application logic.",
			"Validate any candidate against live $queryStats and current indexes before pinning a plan.",
		],
	}
}

/**
 * #66: p95 per lane. The denominator is the cases where that lane actually ran
 * — not every case — so a lane that only fires on a query shape is not diluted.
 */
function summarizeLaneLatency(
	executions: BenchmarkCaseExecution[],
): MemoryBenchmarkLaneLatencySummary | undefined {
	const samples = new Map<string, number[]>()
	for (const execution of executions) {
		for (const [lane, latencyMs] of Object.entries(
			execution.latencyByLane ?? {},
		)) {
			const laneSamples = samples.get(lane)
			if (laneSamples) {
				laneSamples.push(latencyMs)
			} else {
				samples.set(lane, [latencyMs])
			}
		}
	}
	if (samples.size === 0) {
		return undefined
	}
	const summary: MemoryBenchmarkLaneLatencySummary = {}
	for (const [lane, laneSamples] of samples) {
		summary[lane] = {
			p95Ms: percentile(laneSamples, 95),
			cases: laneSamples.length,
		}
	}
	return summary
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) {
		return 0
	}
	const sorted = [...values].toSorted((a, b) => a - b)
	const rank = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	)
	return sorted[rank] ?? 0
}

function uniqueSessionIds(sessionIds: string[]): string[] {
	return Array.from(
		new Set(sessionIds.map((value) => value.trim()).filter(Boolean)),
	)
}

function inferCandidateLane(result: MemorySearchResult): string {
	const lane =
		result.provenance &&
		typeof result.provenance === "object" &&
		typeof result.provenance.lane === "string"
			? result.provenance.lane
			: ""
	if (lane) return lane
	if (result.path.startsWith("relation:")) return "graph"
	if (result.path.startsWith("procedure:")) return "procedural"
	if (result.path.startsWith("episode:")) return "episodic"
	if (
		result.path.startsWith("session-chunk/") ||
		result.path.startsWith("session_chunks/") ||
		result.canonicalId?.startsWith("session-chunk/")
	) {
		return "session-evidence"
	}
	if (result.source === "structured") return "structured"
	if (result.source === "reference") return "reference"
	return "conversation"
}

function explainCandidateSurvival(result: MemorySearchResult): string {
	const reasons: string[] = []
	if (result.sessionId) reasons.push("session-id")
	if (result.sourceEventIds?.length) reasons.push("source-event-ids")
	if (result.scoreDetails?.value !== undefined) reasons.push("fusion-score")
	if (result.canonicalId) reasons.push("canonical-id")
	if (result.timestamp) reasons.push("timestamp")
	return reasons.length > 0 ? reasons.join(",") : "scored-result"
}

type RankedIdGroup = {
	ids: string[]
	score: number
}

function officialDcgAtK(
	rankedGroups: RankedIdGroup[],
	relevantIds: Set<string>,
	k: number,
): number {
	let score = 0
	// The flattened canonical projection deliberately places one attributed id
	// in multiple consecutive rank slots (deflate-only honesty). Gain must be
	// awarded once per relevant id — the official evaluator ranks unique ids —
	// or DCG exceeds the IDCG computed from relevantCount and nDCG goes above
	// 1 (observed live: 1.564). Duplicate slots still burn rank positions;
	// they just cannot add gain.
	const credited = new Set<string>()
	for (const [index, group] of rankedGroups.slice(0, k).entries()) {
		const fresh = group.ids.filter(
			(id) => relevantIds.has(id) && !credited.has(id),
		)
		if (fresh.length === 0) {
			continue
		}
		for (const id of fresh) {
			credited.add(id)
		}
		score += index === 0 ? 1 : 1 / Math.log2(index + 1)
	}
	return score
}

function officialIdealDcg(relevantCount: number, k: number): number {
	let score = 0
	for (let index = 0; index < Math.min(relevantCount, k); index++) {
		score += index === 0 ? 1 : 1 / Math.log2(index + 1)
	}
	return score
}

function dcgAtK(
	rankedGroups: RankedIdGroup[],
	relevantIds: Set<string>,
	k: number,
): number {
	let score = 0
	for (const [index, group] of rankedGroups.slice(0, k).entries()) {
		if (!group.ids.some((id) => relevantIds.has(id))) {
			continue
		}
		score += 1 / Math.log2(index + 2)
	}
	return score
}

function rankResultIdGroups(params: {
	results: MemorySearchResult[]
	resolveIds: (result: MemorySearchResult) => string[]
}): RankedIdGroup[] {
	const seen = new Set<string>()
	const ranked: RankedIdGroup[] = []
	for (const result of params.results) {
		const ids = uniqueSessionIds(params.resolveIds(result)).filter(
			(id) => !seen.has(id),
		)
		if (ids.length === 0) {
			continue
		}
		for (const id of ids) {
			seen.add(id)
		}
		ranked.push({ ids, score: result.score })
	}
	return ranked
}

// The official protocol scores a ranked list where every position carries one
// label. A native memory attributed to N dataset items is therefore N
// candidates: its labels expand into consecutive rank slots in attribution
// order. Duplicates and unattributable results still consume a slot, so the
// projection can only deflate the score relative to a perfect labeling —
// never inflate it. That conservatism is what lets the shipped lane call
// itself canonical.
function projectCanonicalRankedGroups(params: {
	results: MemorySearchResult[]
	resolveIds: (result: MemorySearchResult) => string[]
}): RankedIdGroup[] {
	const groups: RankedIdGroup[] = []
	for (const result of params.results) {
		const ids = uniqueSessionIds(params.resolveIds(result))
		if (ids.length === 0) {
			groups.push({ ids: [], score: result.score })
			continue
		}
		for (const id of ids) {
			groups.push({ ids: [id], score: result.score })
		}
	}
	return groups
}

function idsAtK(rankedGroups: RankedIdGroup[], k: number): string[] {
	return uniqueSessionIds(
		rankedGroups.slice(0, k).flatMap((group) => group.ids),
	)
}

export function rankResultIds(params: {
	results: MemorySearchResult[]
	resolveIds: (result: MemorySearchResult) => string[]
}): Array<{ id: string; score: number }> {
	return rankResultIdGroups(params).flatMap((group) =>
		group.ids.map((id) => ({ id, score: group.score })),
	)
}

export function rankResultSessions(params: {
	results: MemorySearchResult[]
	resolveSessionIds: (result: MemorySearchResult) => string[]
}): Array<{ sessionId: string; score: number }> {
	return rankResultIds({
		results: params.results,
		resolveIds: params.resolveSessionIds,
	}).map((entry) => ({ sessionId: entry.id, score: entry.score }))
}

function evaluateOfficialRetrieval(
	rankedGroups: RankedIdGroup[],
	relevantIds: string[],
): MemoryBenchmarkOfficialRetrievalMetrics | undefined {
	const relevantSet = new Set(uniqueSessionIds(relevantIds))
	if (relevantSet.size === 0) {
		return undefined
	}
	const atK = (k: number) => {
		const recalled = new Set(idsAtK(rankedGroups, k))
		const recallAny = Array.from(relevantSet).some((id) => recalled.has(id))
			? 1
			: 0
		const recallAll = Array.from(relevantSet).every((id) => recalled.has(id))
			? 1
			: 0
		const idcg = officialIdealDcg(relevantSet.size, k)
		const ndcgAny =
			idcg > 0 ? officialDcgAtK(rankedGroups, relevantSet, k) / idcg : 0
		return { recallAny, recallAll, ndcgAny }
	}
	const at1 = atK(1)
	const at3 = atK(3)
	const at5 = atK(5)
	const at10 = atK(10)
	const at30 = atK(30)
	const at50 = atK(50)
	return {
		recallAnyAt1: at1.recallAny,
		recallAllAt1: at1.recallAll,
		ndcgAnyAt1: at1.ndcgAny,
		recallAnyAt3: at3.recallAny,
		recallAllAt3: at3.recallAll,
		ndcgAnyAt3: at3.ndcgAny,
		recallAnyAt5: at5.recallAny,
		recallAllAt5: at5.recallAll,
		ndcgAnyAt5: at5.ndcgAny,
		recallAnyAt10: at10.recallAny,
		recallAllAt10: at10.recallAll,
		ndcgAnyAt10: at10.ndcgAny,
		recallAnyAt30: at30.recallAny,
		recallAllAt30: at30.recallAll,
		ndcgAnyAt30: at30.ndcgAny,
		recallAnyAt50: at50.recallAny,
		recallAllAt50: at50.recallAll,
		ndcgAnyAt50: at50.ndcgAny,
	}
}

function evidenceRecallAtK(
	rankedGroups: RankedIdGroup[],
	relevantIds: string[] | undefined,
	k: number,
): number | undefined {
	if (!relevantIds) {
		return undefined
	}
	const relevant = uniqueSessionIds(relevantIds)
	if (relevant.length === 0) {
		return 1
	}
	const recalled = new Set(idsAtK(rankedGroups, k))
	return relevant.filter((id) => recalled.has(id)).length / relevant.length
}

export function evaluateRankingCase(params: {
	caseId?: string
	results: MemorySearchResult[]
	latencyMs: number
	/** #66: wall-clock ms per retrieval lane for this case. */
	latencyByLane?: Record<string, number>
	relevantSessionIds: string[]
	relevantTurnIds?: string[]
	relevantDialogIds?: string[]
	resolveSessionIds: (result: MemorySearchResult) => string[]
	resolveTurnIds?: (result: MemorySearchResult) => string[]
	resolveDialogIds?: (result: MemorySearchResult) => string[]
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	officialRetrieval?: {
		eligible: boolean
		expectedSessionIds: string[]
		expectedTurnIds: string[]
		ineligibleReason?: "abstention" | "no-user-answer-target"
	}
	questionType?: string
	abstention?: boolean
	executionError?: string
	traceOptions?: { maxCandidates?: number }
}): BenchmarkCaseExecution {
	const relevantSessionIds = uniqueSessionIds(params.relevantSessionIds)
	const rankedSessionGroups = rankResultIdGroups({
		results: params.results,
		resolveIds: params.resolveSessionIds,
	})
	const rankedTurnGroups = params.resolveTurnIds
		? rankResultIdGroups({
				results: params.results,
				resolveIds: params.resolveTurnIds,
			})
		: []
	const rankedDialogGroups = params.resolveDialogIds
		? rankResultIdGroups({
				results: params.results,
				resolveIds: params.resolveDialogIds,
			})
		: []
	const relevantSet = new Set(relevantSessionIds)
	const top5 = idsAtK(rankedSessionGroups, 5)
	const top10 = idsAtK(rankedSessionGroups, 10)
	const relevantTop5 = top5.filter((sessionId) =>
		relevantSet.has(sessionId),
	).length
	const relevantTop10 = top10.filter((sessionId) =>
		relevantSet.has(sessionId),
	).length
	const idealCount = Math.min(relevantSet.size, 10)
	const idcg =
		idealCount === 0
			? 0
			: Array.from(
					{ length: idealCount },
					(_, index) => 1 / Math.log2(index + 2),
				).reduce((sum, value) => sum + value, 0)

	const canonicalSessionProjection = projectCanonicalRankedGroups({
		results: params.results,
		resolveIds: params.resolveSessionIds,
	})
	const canonicalTurnProjection = params.resolveTurnIds
		? projectCanonicalRankedGroups({
				results: params.results,
				resolveIds: params.resolveTurnIds,
			})
		: undefined
	const officialExpectedSessionIds =
		params.officialRetrieval?.expectedSessionIds ?? params.relevantSessionIds
	const officialExpectedTurnIds =
		params.officialRetrieval?.expectedTurnIds ?? params.relevantTurnIds ?? []
	let officialMetric: BenchmarkCaseExecution["officialMetric"]
	let longMemEval: BenchmarkCaseExecution["longMemEval"]
	if (params.datasetKind === "longmemeval") {
		if (params.executionError) {
			officialMetric = {
				status: "execution-failure",
				reason: params.executionError,
			}
		} else if (
			params.abstention === true ||
			params.officialRetrieval?.eligible === false
		) {
			officialMetric = {
				status: "ineligible",
				reason:
					params.officialRetrieval?.ineligibleReason ??
					(params.abstention === true ? "abstention" : "case-ineligible"),
			}
		} else {
			officialMetric = { status: "scored" }
			longMemEval = {
				session: evaluateOfficialRetrieval(
					canonicalSessionProjection,
					officialExpectedSessionIds,
				),
				turn:
					canonicalTurnProjection !== undefined
						? evaluateOfficialRetrieval(
								canonicalTurnProjection,
								officialExpectedTurnIds,
							)
						: undefined,
			}
		}
	}
	const sessionEvidenceAt5 = evidenceRecallAtK(
		rankedSessionGroups,
		params.relevantSessionIds,
		5,
	)
	const sessionEvidenceAt10 = evidenceRecallAtK(
		rankedSessionGroups,
		params.relevantSessionIds,
		10,
	)
	const dialogEvidenceAt5 = evidenceRecallAtK(
		rankedDialogGroups,
		params.relevantDialogIds,
		5,
	)
	const dialogEvidenceAt10 = evidenceRecallAtK(
		rankedDialogGroups,
		params.relevantDialogIds,
		10,
	)
	const loCoMo =
		!params.executionError &&
		params.datasetKind === "locomo" &&
		params.abstention !== true &&
		sessionEvidenceAt5 !== undefined &&
		sessionEvidenceAt10 !== undefined
			? {
					sessionEvidenceRecallAt5: sessionEvidenceAt5,
					sessionEvidenceRecallAt10: sessionEvidenceAt10,
					...(dialogEvidenceAt5 !== undefined
						? { dialogEvidenceRecallAt5: dialogEvidenceAt5 }
						: {}),
					...(dialogEvidenceAt10 !== undefined
						? { dialogEvidenceRecallAt10: dialogEvidenceAt10 }
						: {}),
				}
			: undefined

	// Build per-candidate trace when requested
	const traceMax = params.traceOptions?.maxCandidates ?? 50
	const topCandidates: BenchmarkCandidateTrace[] | undefined =
		params.traceOptions
			? params.results.slice(0, traceMax).map((result, index) => ({
					rank: index + 1,
					score: result.score,
					finalScore: result.score,
					...(result.scoreDetails?.value !== undefined
						? { fusionScore: result.scoreDetails.value }
						: {}),
					source: result.source ?? "unknown",
					lane: inferCandidateLane(result),
					canonicalId: result.canonicalId,
					sessionId: result.sessionId,
					resolvedSessionIds: uniqueSessionIds(
						params.resolveSessionIds(result),
					),
					sourceEventIds: result.sourceEventIds,
					resolvedTurnIds: params.resolveTurnIds
						? uniqueSessionIds(params.resolveTurnIds(result))
						: undefined,
					path: result.path,
					timestamp: result.timestamp
						? new Date(result.timestamp).toISOString()
						: undefined,
					whySurvived: explainCandidateSurvival(result),
					// Task 35 Fix #3: surface scoreDetails on per-case trace so Phase
					// 5 investigations can see which lane contributed the winning
					// score (vs vs text). Only populated when upstream search
					// retuned it; omitted entirely otherwise to keep artifacts lean.
					...(result.scoreDetails !== undefined
						? { scoreDetails: result.scoreDetails }
						: {}),
				}))
			: undefined

	const executionStatus: BenchmarkCaseExecution["executionStatus"] =
		params.executionError ? "system-failure" : "succeeded"
	const scoreEligibility: BenchmarkCaseExecution["scoreEligibility"] =
		params.abstention === true
			? "abstention"
			: relevantSet.size > 0
				? "retrieval"
				: "missing-judgment"
	const hit =
		executionStatus === "succeeded" &&
		scoreEligibility === "retrieval" &&
		relevantTop10 > 0
	const retrievalOutcome: BenchmarkCaseExecution["retrievalOutcome"] =
		executionStatus === "succeeded" && scoreEligibility === "retrieval"
			? hit
				? "hit"
				: "miss"
			: "not-applicable"

	return {
		caseId: params.caseId,
		datasetKind: params.datasetKind,
		questionType: params.questionType,
		abstention: params.abstention,
		executionStatus,
		scoreEligibility,
		retrievalOutcome,
		...(params.executionError ? { error: params.executionError } : {}),
		empty: params.results.length === 0,
		topScore: params.results[0]?.score ?? 0,
		latencyMs: params.latencyMs,
		...(params.latencyByLane ? { latencyByLane: params.latencyByLane } : {}),
		scored: executionStatus === "succeeded" && scoreEligibility === "retrieval",
		hit,
		rAt5: relevantSet.size > 0 ? relevantTop5 / relevantSet.size : 0,
		rAt10: relevantSet.size > 0 ? relevantTop10 / relevantSet.size : 0,
		ndcgAt10:
			relevantSet.size > 0 && idcg > 0
				? dcgAtK(rankedSessionGroups, relevantSet, 10) / idcg
				: 0,
		...(topCandidates ? { topCandidates } : {}),
		...(longMemEval ? { longMemEval } : {}),
		...(officialMetric ? { officialMetric } : {}),
		...(loCoMo ? { loCoMo } : {}),
	}
}

function summarizeQuestionTypes(
	executions: BenchmarkCaseExecution[],
): MemoryBenchmarkQuestionTypeMetrics[] {
	const groups = new Map<string, BenchmarkCaseExecution[]>()
	for (const execution of executions) {
		const key = execution.questionType?.trim() || "untyped"
		const bucket = groups.get(key)
		if (bucket) {
			bucket.push(execution)
		} else {
			groups.set(key, [execution])
		}
	}
	return Array.from(groups.entries())
		.map(([questionType, bucket]) => {
			const scored = bucket.filter((entry) => entry.scored)
			const succeeded = bucket.filter(
				(entry) => entry.executionStatus === "succeeded",
			)
			return {
				questionType,
				cases: bucket.length,
				succeededCases: succeeded.length,
				failedCases: bucket.length - succeeded.length,
				retrievalEligibleCases: bucket.filter(
					(entry) => entry.scoreEligibility === "retrieval",
				).length,
				scoredCases: scored.length,
				hitRate:
					scored.length > 0
						? scored.filter((entry) => entry.hit).length / scored.length
						: 0,
				rAt5:
					scored.length > 0
						? scored.reduce((sum, entry) => sum + entry.rAt5, 0) / scored.length
						: 0,
				rAt10:
					scored.length > 0
						? scored.reduce((sum, entry) => sum + entry.rAt10, 0) /
							scored.length
						: 0,
				ndcgAt10:
					scored.length > 0
						? scored.reduce((sum, entry) => sum + entry.ndcgAt10, 0) /
							scored.length
						: 0,
			} satisfies MemoryBenchmarkQuestionTypeMetrics
		})
		.toSorted((a, b) => a.questionType.localeCompare(b.questionType))
}

function averageOfficialRetrievalMetrics(
	metrics: MemoryBenchmarkOfficialRetrievalMetrics[],
): MemoryBenchmarkOfficialRetrievalMetrics | undefined {
	if (metrics.length === 0) {
		return undefined
	}
	const avg = (key: keyof MemoryBenchmarkOfficialRetrievalMetrics) =>
		metrics.reduce((sum, entry) => sum + entry[key], 0) / metrics.length
	return {
		recallAnyAt1: avg("recallAnyAt1"),
		recallAllAt1: avg("recallAllAt1"),
		ndcgAnyAt1: avg("ndcgAnyAt1"),
		recallAnyAt3: avg("recallAnyAt3"),
		recallAllAt3: avg("recallAllAt3"),
		ndcgAnyAt3: avg("ndcgAnyAt3"),
		recallAnyAt5: avg("recallAnyAt5"),
		recallAllAt5: avg("recallAllAt5"),
		ndcgAnyAt5: avg("ndcgAnyAt5"),
		recallAnyAt10: avg("recallAnyAt10"),
		recallAllAt10: avg("recallAllAt10"),
		ndcgAnyAt10: avg("ndcgAnyAt10"),
		recallAnyAt30: avg("recallAnyAt30"),
		recallAllAt30: avg("recallAllAt30"),
		ndcgAnyAt30: avg("ndcgAnyAt30"),
		recallAnyAt50: avg("recallAnyAt50"),
		recallAllAt50: avg("recallAllAt50"),
		ndcgAnyAt50: avg("ndcgAnyAt50"),
	}
}

function summarizeOfficialMetrics(
	datasetKind: MemoryBenchmarkDatasetKind | "legacy-query" | undefined,
	executions: BenchmarkCaseExecution[],
	retrievalLane: BenchmarkRetrievalLane = "native",
): MemoryBenchmarkOfficialMetrics | undefined {
	if (datasetKind === "longmemeval") {
		const longMemEvalExecutions = executions.filter(
			(execution) => execution.datasetKind === "longmemeval",
		)
		const sessionMetrics = longMemEvalExecutions
			.map((execution) => execution.longMemEval?.session)
			.filter(
				(entry): entry is MemoryBenchmarkOfficialRetrievalMetrics =>
					entry !== undefined,
			)
		const turnMetrics = longMemEvalExecutions
			.map((execution) => execution.longMemEval?.turn)
			.filter(
				(entry): entry is MemoryBenchmarkOfficialRetrievalMetrics =>
					entry !== undefined,
			)
		const session = averageOfficialRetrievalMetrics(sessionMetrics)
		const turn = averageOfficialRetrievalMetrics(turnMetrics)
		const ineligibleCases = longMemEvalExecutions.filter(
			(execution) => execution.officialMetric?.status === "ineligible",
		).length
		const projectionFailureCases = longMemEvalExecutions.filter(
			(execution) => execution.officialMetric?.status === "projection-failure",
		).length
		const executionFailureCases = longMemEvalExecutions.filter(
			(execution) => execution.officialMetric?.status === "execution-failure",
		).length
		return {
			longMemEval: {
				evaluator: {
					...LONGMEMEVAL_EVALUATOR_SOURCE,
					candidateProjection:
						retrievalLane === "raw-session"
							? "one-session-document-one-label"
							: "native-source-attribution-flattened",
					// Both lanes are canonical: raw-session candidates ARE dataset
					// documents, and the native lane expands each memory's dataset
					// attribution one label per rank slot (see
					// projectCanonicalRankedGroups). Publication additionally requires
					// the native lane — the shipped pipeline — via the parity envelope.
					comparability: "canonical",
				},
				totalCases: longMemEvalExecutions.length,
				eligibleCases: longMemEvalExecutions.length - ineligibleCases,
				retrievalCases: sessionMetrics.length,
				abstentionCases: longMemEvalExecutions.filter(
					(execution) => execution.abstention === true,
				).length,
				ineligibleCases,
				projectionFailureCases,
				executionFailureCases,
				...(session ? { session } : {}),
				...(turn ? { turn } : {}),
			},
		}
	}
	if (datasetKind === "locomo") {
		const loCoMoExecutions = executions.filter(
			(execution) => execution.datasetKind === "locomo" && execution.loCoMo,
		)
		if (loCoMoExecutions.length === 0) {
			return undefined
		}
		const avg = (
			selector: (execution: BenchmarkCaseExecution) => number | undefined,
		) => {
			const values = loCoMoExecutions
				.map(selector)
				.filter((value): value is number => typeof value === "number")
			return values.length > 0
				? values.reduce((sum, value) => sum + value, 0) / values.length
				: undefined
		}
		const dialogEvidenceRecallAt5 = avg(
			(execution) => execution.loCoMo?.dialogEvidenceRecallAt5,
		)
		const dialogEvidenceRecallAt10 = avg(
			(execution) => execution.loCoMo?.dialogEvidenceRecallAt10,
		)
		return {
			loCoMo: {
				retrievalCases: loCoMoExecutions.length,
				abstentionCases: loCoMoExecutions.filter(
					(execution) => execution.abstention === true,
				).length,
				sessionEvidenceRecallAt5:
					avg((execution) => execution.loCoMo?.sessionEvidenceRecallAt5) ?? 0,
				sessionEvidenceRecallAt10:
					avg((execution) => execution.loCoMo?.sessionEvidenceRecallAt10) ?? 0,
				...(dialogEvidenceRecallAt5 !== undefined
					? { dialogEvidenceRecallAt5 }
					: {}),
				...(dialogEvidenceRecallAt10 !== undefined
					? { dialogEvidenceRecallAt10 }
					: {}),
			},
		}
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Miss ledger: per-case diagnostic for failed/borderline cases
// ---------------------------------------------------------------------------

function inferMissCategory(
	questionType: string | undefined,
	sessionFound: boolean,
): BenchmarkMissLedgerEntry["missCategory"] {
	if (!questionType) return "unknown"
	const qt = questionType.toLowerCase()
	if (qt.includes("preference")) return "preference"
	if (qt.includes("temporal")) return "temporal"
	if (qt.includes("update") || qt.includes("knowledge")) return "update"
	if (sessionFound) return "turn-selection"
	return "unknown"
}

export function buildMissLedger(params: {
	executions: BenchmarkCaseExecution[]
	expectedSessionMap: Map<string, string[]>
	expectedTurnMap: Map<string, string[]>
}): BenchmarkMissLedgerEntry[] {
	const ledger: BenchmarkMissLedgerEntry[] = []

	for (const exec of params.executions) {
		// Only include cases that are scored and have R@5 < 1.0 (imperfect recall)
		if (!exec.scored || exec.rAt5 >= 1.0) continue

		const caseId = exec.caseId ?? "unknown"
		const expectedSessionIds = params.expectedSessionMap.get(caseId) ?? []
		const expectedTurnIds = params.expectedTurnMap.get(caseId) ?? []
		// Extract session IDs from top 10 candidates for R@10-shaped diagnosis.
		const top10 = (exec.topCandidates ?? []).slice(0, 10)
		const top50 = (exec.topCandidates ?? []).slice(0, 50)
		const topCandidateSessionIds = top10.flatMap((candidate) => {
			if (
				candidate.resolvedSessionIds &&
				candidate.resolvedSessionIds.length > 0
			) {
				return candidate.resolvedSessionIds
			}
			return candidate.sessionId ? [candidate.sessionId] : []
		})
		const topSessionSet = new Set(topCandidateSessionIds)

		const sessionFound = expectedSessionIds.some((id) => topSessionSet.has(id))
		const allSessionsFound = expectedSessionIds.every((id) =>
			topSessionSet.has(id),
		)

		// Collect reachable turn IDs from sourceEventIds of top 10 candidates
		const reachableTurnIds = [
			...new Set(
				top10.flatMap((candidate) =>
					candidate.resolvedTurnIds && candidate.resolvedTurnIds.length > 0
						? candidate.resolvedTurnIds
						: (candidate.sourceEventIds ?? []),
				),
			),
		]
		const turnReachable = expectedTurnIds.some((id) =>
			reachableTurnIds.includes(id),
		)

		ledger.push({
			caseId,
			questionType: exec.questionType,
			rAt5: exec.rAt5,
			rAt10: exec.rAt10,
			expectedSessionIds,
			expectedTurnIds,
			topCandidateSessionIds: [...new Set(topCandidateSessionIds)],
			sessionFound,
			allSessionsFound,
			reachableTurnIds,
			turnReachable,
			missCategory: inferMissCategory(exec.questionType, sessionFound),
			topCandidates: top50.map((c) => ({
				rank: c.rank,
				score: c.score,
				finalScore: c.finalScore,
				fusionScore: c.fusionScore,
				source: c.source,
				lane: c.lane,
				sessionId: c.sessionId,
				canonicalId: c.canonicalId,
				resolvedSessionIds: c.resolvedSessionIds,
				resolvedTurnIds: c.resolvedTurnIds,
				sourceEventIds: c.sourceEventIds,
				path: c.path,
				whySurvived: c.whySurvived,
			})),
		})
	}

	return ledger.toSorted((a, b) => a.rAt5 - b.rAt5)
}

function inferDiagnosticIssue(
	exec: BenchmarkCaseExecution,
): BenchmarkCaseDiagnosticEntry["issue"] | null {
	const sessionTop1Miss =
		exec.longMemEval?.session !== undefined &&
		exec.longMemEval.session.recallAnyAt1 < 1
	const turnTop1Miss =
		exec.longMemEval?.turn !== undefined &&
		exec.longMemEval.turn.recallAnyAt1 < 1
	if (sessionTop1Miss && turnTop1Miss) return "top1-session-and-turn"
	if (sessionTop1Miss) return "top1-session"
	if (turnTop1Miss) return "top1-turn"
	if (exec.rAt5 < 1) return "recall-at-5"
	return null
}

export function buildCaseDiagnostics(params: {
	executions: BenchmarkCaseExecution[]
	expectedSessionMap: Map<string, string[]>
	expectedTurnMap: Map<string, string[]>
}): BenchmarkCaseDiagnosticEntry[] {
	const diagnostics: BenchmarkCaseDiagnosticEntry[] = []

	for (const exec of params.executions) {
		if (!exec.scored) continue
		const issue = inferDiagnosticIssue(exec)
		if (!issue) continue

		const caseId = exec.caseId ?? "unknown"
		const expectedSessionIds = params.expectedSessionMap.get(caseId) ?? []
		const expectedTurnIds = params.expectedTurnMap.get(caseId) ?? []
		const topCandidates = (exec.topCandidates ?? []).slice(0, 5)
		const topCandidateSessionIds = [
			...new Set(
				topCandidates.flatMap((candidate) => {
					if (
						candidate.resolvedSessionIds &&
						candidate.resolvedSessionIds.length > 0
					) {
						return candidate.resolvedSessionIds
					}
					return candidate.sessionId ? [candidate.sessionId] : []
				}),
			),
		]
		const topCandidateTurnIds = [
			...new Set(
				topCandidates.flatMap((candidate) =>
					candidate.resolvedTurnIds && candidate.resolvedTurnIds.length > 0
						? candidate.resolvedTurnIds
						: (candidate.sourceEventIds ?? []),
				),
			),
		]
		const top1 = topCandidates[0]
		const top1SessionIds =
			top1?.resolvedSessionIds && top1.resolvedSessionIds.length > 0
				? top1.resolvedSessionIds
				: top1?.sessionId
					? [top1.sessionId]
					: []
		const top1TurnIds =
			top1?.resolvedTurnIds && top1.resolvedTurnIds.length > 0
				? top1.resolvedTurnIds
				: (top1?.sourceEventIds ?? [])

		diagnostics.push({
			caseId,
			questionType: exec.questionType,
			rAt5: exec.rAt5,
			rAt10: exec.rAt10,
			ndcgAt10: exec.ndcgAt10,
			issue,
			expectedSessionIds,
			expectedTurnIds,
			topCandidateSessionIds,
			topCandidateTurnIds,
			sessionTop1Found: expectedSessionIds.some((id) =>
				top1SessionIds.includes(id),
			),
			turnTop1Found: expectedTurnIds.some((id) => top1TurnIds.includes(id)),
			longMemEval: exec.longMemEval,
			topCandidates: topCandidates.map((candidate) => ({
				rank: candidate.rank,
				score: candidate.score,
				source: candidate.source,
				path: candidate.path,
				sessionId: candidate.sessionId,
				canonicalId: candidate.canonicalId,
				resolvedSessionIds: candidate.resolvedSessionIds,
				resolvedTurnIds: candidate.resolvedTurnIds,
				sourceEventIds: candidate.sourceEventIds,
			})),
		})
	}

	return diagnostics.toSorted((a, b) => {
		const severity =
			a.issue === b.issue
				? 0
				: a.issue === "recall-at-5"
					? -1
					: b.issue === "recall-at-5"
						? 1
						: 0
		return severity || a.ndcgAt10 - b.ndcgAt10
	})
}

export function summarizeBenchmarkExecutions(params: {
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	retrievalLane?: BenchmarkRetrievalLane
	scenarios?: number
	executions: BenchmarkCaseExecution[]
	ingest?: BenchmarkSummary["ingest"]
}): BenchmarkSummary {
	const executions = params.executions
	const scored = executions.filter((entry) => entry.scored)
	const topScores = scored.map((entry) => entry.topScore)
	const latencies = scored.map((entry) => entry.latencyMs)
	const officialMetrics = summarizeOfficialMetrics(
		params.datasetKind,
		executions,
		params.retrievalLane,
	)
	const execution: MemoryBenchmarkExecutionSummary = {
		attemptedCases: executions.length,
		succeededCases: executions.filter(
			(entry) => entry.executionStatus === "succeeded",
		).length,
		failedCases: executions.filter(
			(entry) => entry.executionStatus === "system-failure",
		).length,
		retrievalEligibleCases: executions.filter(
			(entry) => entry.scoreEligibility === "retrieval",
		).length,
		abstentionCases: executions.filter(
			(entry) => entry.scoreEligibility === "abstention",
		).length,
		missingJudgmentCases: executions.filter(
			(entry) => entry.scoreEligibility === "missing-judgment",
		).length,
		retrievalHits: executions.filter(
			(entry) => entry.retrievalOutcome === "hit",
		).length,
		retrievalMisses: executions.filter(
			(entry) => entry.retrievalOutcome === "miss",
		).length,
		scoredCases: scored.length,
	}
	const laneLatencyP95 = summarizeLaneLatency(executions)
	const caseOutcomes: MemoryBenchmarkCaseOutcome[] = executions.map(
		(entry) => ({
			caseId: entry.caseId,
			questionType: entry.questionType,
			executionStatus: entry.executionStatus,
			scoreEligibility: entry.scoreEligibility,
			retrievalOutcome: entry.retrievalOutcome,
			...(entry.officialMetric ? { officialMetric: entry.officialMetric } : {}),
			empty: entry.empty,
			latencyMs: entry.latencyMs,
			...(entry.latencyByLane ? { latencyByLane: entry.latencyByLane } : {}),
			...(entry.error
				? { failure: { stage: "retrieval" as const, message: entry.error } }
				: {}),
		}),
	)
	return {
		datasetName: params.datasetName,
		datasetKind: params.datasetKind,
		scenarios: params.scenarios,
		cases: executions.length,
		scoredCases: scored.length,
		skippedCases: executions.length - scored.length,
		execution,
		caseOutcomes,
		hitRate:
			scored.length > 0
				? scored.filter((entry) => entry.hit).length / scored.length
				: 0,
		emptyRate:
			scored.length > 0
				? scored.filter((entry) => entry.empty).length / scored.length
				: 0,
		avgTopScore:
			topScores.length > 0
				? topScores.reduce((sum, value) => sum + value, 0) / topScores.length
				: 0,
		p95LatencyMs: percentile(latencies, 95),
		...(laneLatencyP95 ? { laneLatencyP95 } : {}),
		rAt5:
			scored.length > 0
				? scored.reduce((sum, entry) => sum + entry.rAt5, 0) / scored.length
				: 0,
		rAt10:
			scored.length > 0
				? scored.reduce((sum, entry) => sum + entry.rAt10, 0) / scored.length
				: 0,
		ndcgAt10:
			scored.length > 0
				? scored.reduce((sum, entry) => sum + entry.ndcgAt10, 0) / scored.length
				: 0,
		questionTypeBreakdown: summarizeQuestionTypes(executions),
		...(officialMetrics ? { officialMetrics } : {}),
		...(params.ingest ? { ingest: params.ingest } : {}),
	}
}

/**
 * #66: fold pass-ordered summaries (index 0 = the gate pass) into a per-pass
 * table plus the across-pass p95 noise band. A single pass carries no band, so
 * the report is omitted and the run reads exactly like a pre-passes run.
 */
export function summarizeMeasurementPasses(
	summaries: BenchmarkSummary[],
): MemoryBenchmarkMeasurementPasses | undefined {
	if (summaries.length < 2) {
		return undefined
	}
	const p95Samples = summaries.map((summary) => summary.p95LatencyMs)
	const mean =
		p95Samples.reduce((sum, value) => sum + value, 0) / p95Samples.length
	return {
		passes: summaries.length,
		gatePass: 1,
		samples: summaries.map((summary, index) => ({
			pass: index + 1,
			cases: summary.cases,
			scoredCases: summary.scoredCases,
			hitRate: summary.hitRate,
			p95LatencyMs: summary.p95LatencyMs,
			rAt5: summary.rAt5,
			rAt10: summary.rAt10,
			ndcgAt10: summary.ndcgAt10,
			...(summary.officialMetrics
				? { officialMetrics: summary.officialMetrics }
				: {}),
			...(summary.laneLatencyP95
				? { laneLatencyP95: summary.laneLatencyP95 }
				: {}),
		})),
		p95LatencyMs: {
			median: median(p95Samples),
			min: Math.min(...p95Samples),
			max: Math.max(...p95Samples),
			stddev: Math.sqrt(
				p95Samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
					p95Samples.length,
			),
		},
	}
}

function median(values: number[]): number {
	const sorted = [...values].toSorted((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 1) {
		return sorted[middle] ?? 0
	}
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}
