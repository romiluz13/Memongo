import type { Db } from "mongodb"
import {
	collectStorageFootprint,
	percentile50And95,
	type BenchmarkRetrievalLane,
	resolveBenchmarkEmbeddingConfig,
	resolveBenchmarkRerankerConfig,
	resolveDatasetSha256,
	resolveRetrievalUnit,
} from "./benchmark-parity-envelope.js"
import type { MemorySearchResult } from "./types.js"
import type {
	BenchmarkCostCounters,
	BenchmarkE2eQaEnvelope,
	BenchmarkEmbeddingConfig,
	BenchmarkLatencyDistribution,
	BenchmarkRerankerConfig,
	BenchmarkRunIdentity,
	BenchmarkStorageFootprint,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkOfficialMetrics,
	MemoryBenchmarkOfficialRetrievalMetrics,
	MemoryBenchmarkQuestionTypeMetrics,
	MemoryBenchmarkRunReport,
	QueryGovernanceReport,
} from "./types.js"

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
	scoreDetails?: import("./types.js").MemorySearchScoreDetails
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
	empty: boolean
	topScore: number
	latencyMs: number
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
	hitRate: number
	emptyRate: number
	avgTopScore: number
	p95LatencyMs: number
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
	cost?: BenchmarkCostCounters
	e2eQa?: BenchmarkE2eQaEnvelope
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
			status: "warning",
			evidence: "officialMetrics absent; use non-comparable diagnostics only",
		}
	}
	if (params.cases === 0) {
		return {
			gate: "official-retrieval",
			status: "warning",
			evidence:
				"officialMetrics present, but no benchmark cases were available",
		}
	}
	if (params.scoredCases == null) {
		return {
			gate: "official-retrieval",
			status: "warning",
			evidence:
				"officialMetrics present, but scoredCases is missing; use non-comparable diagnostics only",
		}
	}
	if (params.scoredCases !== params.cases) {
		return {
			gate: "official-retrieval",
			status: "warning",
			evidence: `officialMetrics present, but ${params.scoredCases}/${params.cases} benchmark cases were scored`,
		}
	}
	return {
		gate: "official-retrieval",
		status: "passed",
		evidence: `officialMetrics present and all ${params.scoredCases}/${params.cases} benchmark cases scored`,
	}
}

export function buildBenchmarkRunReport(
	params: BenchmarkReportInput,
): MemoryBenchmarkRunReport {
	const internalStatus = params.cases > 0 ? "passed" : "warning"
	return {
		generatedAt: new Date(),
		build: readBuildIdentity(),
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
		releaseGates: [
			buildOfficialRetrievalGate(params),
			{
				gate: "internal-retrieval",
				status: internalStatus,
				evidence: `${params.cases} cases, ${params.scoredCases ?? params.cases} scored`,
			},
			{
				gate: "conversation-recall-regression",
				status: "not-run",
				evidence:
					"Run packages/memory-engine/src/mongodb-conversation-recall-benchmark.test.ts for recall-affecting changes",
			},
			{
				gate: "query-governance",
				status: "advisory-only",
				evidence:
					params.queryGovernance?.status === "advisory-only"
						? "queryGovernance candidates are advisory-only"
						: "no queryGovernance candidates attached",
			},
		],
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
 *   - `datasetPath` — used to compute SHA-256 if no env override is set.
 *     Env `MEMONGO_BENCHMARK_DATASET_SHA` takes precedence (matches
 *     bootstrap.json), then the `datasetSha256` override.
 *   - `datasetKind` — determines retrieval unit (currently always "turn").
 *   - `mongoEmbeddingConfig` — from resolved backend config
 *     (`numDimensions` + `quantization`).
 *   - `mongoRerankerConfig` — from resolved backend config
 *     (`enabled`, `model`, `topN`).
 *   - `latencySamples` — per-case retrieval latencies collected during
 *     the benchmark run. Emits p50 + p95.
 *   - `costCounters` — run-scoped counters from
 *     `createBenchmarkRunCounters()`.
 */
export async function projectBenchmarkParityFields(params: {
	db: Pick<Db, "command">
	collectionName: string
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
	costCounters: BenchmarkCostCounters
}): Promise<{
	runIdentity: BenchmarkRunIdentity
	embedding: BenchmarkEmbeddingConfig
	reranker: BenchmarkRerankerConfig
	storage: BenchmarkStorageFootprint
	latency: BenchmarkLatencyDistribution
	cost: BenchmarkCostCounters
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
	})
	const latency = percentile50And95(params.latencySamples)
	return {
		runIdentity: { datasetSha256, retrievalUnit },
		embedding,
		reranker,
		storage,
		latency,
		cost: params.costCounters,
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

function officialDcgAtK(
	rankedIds: string[],
	relevantIds: Set<string>,
	k: number,
): number {
	let score = 0
	for (const [index, id] of rankedIds.slice(0, k).entries()) {
		if (!relevantIds.has(id)) {
			continue
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
	rankedIds: string[],
	relevantIds: Set<string>,
	k: number,
): number {
	let score = 0
	for (const [index, sessionId] of rankedIds.slice(0, k).entries()) {
		if (!relevantIds.has(sessionId)) {
			continue
		}
		score += 1 / Math.log2(index + 2)
	}
	return score
}

export function rankResultIds(params: {
	results: MemorySearchResult[]
	resolveIds: (result: MemorySearchResult) => string[]
}): Array<{ id: string; score: number }> {
	const seen = new Set<string>()
	const ranked: Array<{ id: string; score: number }> = []
	for (const result of params.results) {
		const ids = uniqueSessionIds(params.resolveIds(result))
		for (const id of ids) {
			if (seen.has(id)) {
				continue
			}
			seen.add(id)
			ranked.push({ id, score: result.score })
		}
	}
	return ranked
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
	rankedIds: string[],
	relevantIds: string[],
): MemoryBenchmarkOfficialRetrievalMetrics | undefined {
	const relevantSet = new Set(uniqueSessionIds(relevantIds))
	if (relevantSet.size === 0) {
		return undefined
	}
	const atK = (k: number) => {
		const recalled = new Set(rankedIds.slice(0, k))
		const recallAny = Array.from(relevantSet).some((id) => recalled.has(id))
			? 1
			: 0
		const recallAll = Array.from(relevantSet).every((id) => recalled.has(id))
			? 1
			: 0
		const idcg = officialIdealDcg(relevantSet.size, k)
		const ndcgAny =
			idcg > 0 ? officialDcgAtK(rankedIds, relevantSet, k) / idcg : 0
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
	rankedIds: string[],
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
	const recalled = new Set(rankedIds.slice(0, k))
	return relevant.filter((id) => recalled.has(id)).length / relevant.length
}

export function evaluateRankingCase(params: {
	caseId?: string
	results: MemorySearchResult[]
	latencyMs: number
	relevantSessionIds: string[]
	relevantTurnIds?: string[]
	relevantDialogIds?: string[]
	resolveSessionIds: (result: MemorySearchResult) => string[]
	resolveTurnIds?: (result: MemorySearchResult) => string[]
	resolveDialogIds?: (result: MemorySearchResult) => string[]
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	questionType?: string
	abstention?: boolean
	traceOptions?: { maxCandidates?: number }
}): BenchmarkCaseExecution {
	const relevantSessionIds = uniqueSessionIds(params.relevantSessionIds)
	const ranked = rankResultSessions({
		results: params.results,
		resolveSessionIds: params.resolveSessionIds,
	})
	const rankedIds = ranked.map((entry) => entry.sessionId)
	const rankedTurnIds = params.resolveTurnIds
		? rankResultIds({
				results: params.results,
				resolveIds: params.resolveTurnIds,
			}).map((entry) => entry.id)
		: []
	const rankedDialogIds = params.resolveDialogIds
		? rankResultIds({
				results: params.results,
				resolveIds: params.resolveDialogIds,
			}).map((entry) => entry.id)
		: []
	const relevantSet = new Set(relevantSessionIds)
	const top5 = rankedIds.slice(0, 5)
	const top10 = rankedIds.slice(0, 10)
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

	const longMemEval =
		params.datasetKind === "longmemeval" && params.abstention !== true
			? {
					session: evaluateOfficialRetrieval(
						rankedIds,
						params.relevantSessionIds,
					),
					turn: params.resolveTurnIds
						? evaluateOfficialRetrieval(
								rankedTurnIds,
								params.relevantTurnIds ?? [],
							)
						: undefined,
				}
			: undefined
	const sessionEvidenceAt5 = evidenceRecallAtK(
		rankedIds,
		params.relevantSessionIds,
		5,
	)
	const sessionEvidenceAt10 = evidenceRecallAtK(
		rankedIds,
		params.relevantSessionIds,
		10,
	)
	const dialogEvidenceAt5 = evidenceRecallAtK(
		rankedDialogIds,
		params.relevantDialogIds,
		5,
	)
	const dialogEvidenceAt10 = evidenceRecallAtK(
		rankedDialogIds,
		params.relevantDialogIds,
		10,
	)
	const loCoMo =
		params.datasetKind === "locomo" &&
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

	return {
		caseId: params.caseId,
		datasetKind: params.datasetKind,
		questionType: params.questionType,
		abstention: params.abstention,
		empty: params.results.length === 0,
		topScore: params.results[0]?.score ?? 0,
		latencyMs: params.latencyMs,
		scored: relevantSet.size > 0,
		hit: relevantTop10 > 0,
		rAt5: relevantSet.size > 0 ? relevantTop5 / relevantSet.size : 0,
		rAt10: relevantSet.size > 0 ? relevantTop10 / relevantSet.size : 0,
		ndcgAt10:
			relevantSet.size > 0 && idcg > 0
				? dcgAtK(top10, relevantSet, 10) / idcg
				: 0,
		...(topCandidates ? { topCandidates } : {}),
		...(longMemEval ? { longMemEval } : {}),
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
			return {
				questionType,
				cases: bucket.length,
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
		if (!session) {
			return undefined
		}
		const turn = averageOfficialRetrievalMetrics(turnMetrics)
		return {
			longMemEval: {
				retrievalCases: sessionMetrics.length,
				abstentionCases: longMemEvalExecutions.filter(
					(execution) => execution.abstention === true,
				).length,
				session,
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
				qaCases: loCoMoExecutions.length,
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
	scenarios?: number
	executions: BenchmarkCaseExecution[]
	ingest?: BenchmarkSummary["ingest"]
}): BenchmarkSummary {
	const executions = params.executions
	const scored = executions.filter((entry) => entry.scored)
	const topScores = executions.map((entry) => entry.topScore)
	const latencies = executions.map((entry) => entry.latencyMs)
	const officialMetrics = summarizeOfficialMetrics(
		params.datasetKind,
		executions,
	)
	return {
		datasetName: params.datasetName,
		datasetKind: params.datasetKind,
		scenarios: params.scenarios,
		cases: executions.length,
		scoredCases: scored.length,
		skippedCases: executions.length - scored.length,
		hitRate:
			scored.length > 0
				? scored.filter((entry) => entry.hit).length / scored.length
				: 0,
		emptyRate:
			executions.length > 0
				? executions.filter((entry) => entry.empty).length / executions.length
				: 0,
		avgTopScore:
			topScores.length > 0
				? topScores.reduce((sum, value) => sum + value, 0) / topScores.length
				: 0,
		p95LatencyMs: percentile(latencies, 95),
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
