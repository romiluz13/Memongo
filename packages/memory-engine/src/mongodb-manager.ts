import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import {
	MongoClient,
	type ClientSession,
	type Collection,
	type Db,
	type Document,
	type MongoClientOptions,
} from "mongodb"
import {
	type MemongoConfig,
	type MemoryMongoDBFusionMethod,
	type MemoryScope,
	createSubsystemLogger,
	resolveUserPath,
} from "@memongo/lib"
import {
	AccessTracker,
	getAccessSummaries as listAccessSummaries,
	getAccessTrends as listAccessTrends,
} from "./mongodb-access-tracker.js"
import { resolveAgentWorkspaceDir } from "./agent-config.js"
import type {
	ResolvedMemoryBackendConfig,
	ResolvedMongoDBConfig,
} from "./backend-config.js"
import { resolveSearchDefaultScope } from "./backend-config.js"
import { isDuplicateKeyError, normalizeExtraMemoryPaths } from "./internal.js"
import { isSharedMongoClientEnabled } from "./mongodb-client-registry.js"
import { getMemoryStats, type MemoryStats } from "./mongodb-analytics.js"
import { MongoDBChangeStreamWatcher } from "./mongodb-change-stream.js"
import {
	heuristicEpisodeSummarizer,
	promoteDerivedMemoryFromEvent,
	extractStructuredCandidatesFromEvent,
	extractProcedureCandidatesFromEvent,
} from "./mongodb-derived-memory.js"
import { searchEpisodes } from "./mongodb-episodes.js"
import { checkAutoEpisodeTriggers } from "./mongodb-episodes.js"
import {
	ingestBenchmarkDataset,
	ingestBenchmarkConversations,
	importConversationDataset,
	loadBenchmarkDataset,
	resolveBenchmarkDatasetPath,
} from "./mongodb-benchmark-harness.js"
import { recallConversation as recallConversationCore } from "./mongodb-conversation-recall.js"
import {
	buildBenchmarkRunReport,
	evaluateRankingCase,
	buildQueryGovernanceReport,
	summarizeBenchmarkExecutions,
	summarizeMeasurementPasses,
	buildMissLedger,
	buildCaseDiagnostics,
	projectBenchmarkParityFields,
	type BenchmarkCaseExecution,
} from "./mongodb-benchmark-runner.js"
import {
	createBenchmarkRunContext,
	assertBenchmarkRunConfiguration,
	collectBenchmarkTenantStorage,
	instrumentBenchmarkProvider,
	resolveDatasetSha256,
	resolveBenchmarkRetrievalLane,
	resolveBenchmarkExecutionProfile,
	type BenchmarkExecutionProfile,
	type BenchmarkRetrievalLane,
	type BenchmarkRunContext,
	type BenchmarkRunConfiguration,
} from "./benchmark-parity-envelope.js"
import { resolveRegisteredBenchmarkQualityContract } from "./benchmark-quality-contracts.js"
import { readSearchIndexStatus } from "./mongodb-benchmark-readiness.js"
import {
	clearEventExtractionJobPending,
	clearEventExtractionJobPendingBatch,
	getPendingExtractionEvents,
	writeEvent,
	writeEventsBatch,
	projectChunksFromEvents,
	projectEventChunk,
	projectEventChunksBatch,
	getEventsByTimeRange,
	renderEventChunkText,
	IdempotencyConflictError,
	type CanonicalEvent,
} from "./mongodb-events.js"
import {
	extractAndUpsertEntities,
	extractAndUpsertTypedRelations,
	searchEntitiesAutocomplete,
	expandGraph,
	findRelationByLocatorId,
	type Entity,
	type RelationType,
} from "./mongodb-graph.js"
import {
	normalizeSearchResults,
	rrfScore,
	type SearchMethod,
} from "./mongodb-hybrid.js"
import { searchKB } from "./mongodb-kb-search.js"
import { updateLaneCoverage, getLaneCoverage } from "./mongodb-lane-coverage.js"
import {
	recordIngestRun,
	recordProjectionRun,
	getLatestIngestRun,
	getLatestProjectionRun,
	getProjectionLag,
	type IngestRun,
	type ProjectionRun,
} from "./mongodb-ops.js"
import {
	claimMemoryJob,
	completeClaimedMemoryJob,
	createMemoryJob,
	createMemoryJobsBatch,
	failClaimedMemoryJob,
	getMemoryJob,
	listMemoryJobs,
	releaseStagedMemoryJob,
	renewMemoryJobLease,
	retryFailedMemoryJob,
	updateMemoryJob,
} from "./mongodb-memory-jobs.js"
import {
	isTransactionUnsupported,
	MAJORITY_TRANSACTION_OPTIONS,
} from "./mongodb-transactions.js"
import {
	getRecallTrace,
	listRecallTraces,
	recordRecallTrace,
} from "./mongodb-recall-traces.js"
import type {
	ProcedureEntry,
	ProcedureLifecyclePatch,
	ProcedureState,
} from "./mongodb-procedures.js"
import {
	findExactProcedureMatches,
	searchProcedures,
} from "./mongodb-procedures.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { buildContextBundle as composeContextBundle } from "./mongodb-context-bundle.js"
import { synthesizeProfile, type ProfileSynthesis } from "./mongodb-profile.js"
import {
	checkCache,
	invalidateQueryCache,
	writeCache,
} from "./mongodb-query-cache.js"
import { QueryCacheInvalidationCoalescer } from "./mongodb-query-cache-invalidation.js"
import { runSingleFlight } from "./mongodb-single-flight.js"
import {
	rewriteQuery,
	type QueryRewriteConfig,
} from "./mongodb-query-rewriter.js"
import {
	MongoDBRelevanceRuntime,
	type RelevanceArtifact,
	type RelevanceBenchmarkResult,
	type RelevanceHealth,
	type RelevanceReport,
	type RelevanceSampleState,
	type RelevanceSourceScope,
} from "./mongodb-relevance.js"
import { applyPostRetrievalScoring } from "./mongodb-post-retrieval-scoring.js"
import {
	extractSessionIdFromCanonicalId,
	resolveSessionEvidenceMode,
	writeSessionEvidenceOptionA,
	writeSessionEvidenceOptionB,
	type SessionEvidenceMode,
} from "./mongodb-session-evidence.js"
import {
	isEvidenceMirrorEnabled,
	writeMemoryEvidenceDocuments,
} from "./mongodb-evidence-mirror.js"
import {
	resolveUserfactEvidenceMode,
	writeUserfactEvidence,
} from "./mongodb-userfact-evidence.js"
import {
	type EnrichmentProvider,
	resolveEnrichmentMode,
	resolveEnrichmentStrictMode,
	resolveEnrichmentProvider,
	enrichSessionsWithLLM,
	extractSessionEnrichment,
} from "./mongodb-llm-enrichment.js"
import { runE2eQa, type E2eQaCase } from "./mongodb-e2e-qa.js"
import {
	resolveDecompositionMode,
	decomposeQuery,
	mergeMultiQueryResults,
} from "./mongodb-query-decomposition.js"
import { crossEncoderRerank, type RerankConfig } from "./mongodb-reranker.js"
import {
	planRetrieval,
	type RetrievalPath,
	type RetrievalPlan,
	resolveTimeRangePreset,
} from "./mongodb-retrieval-planner.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	kbCollection,
	chunksCollection,
	detectCapabilities,
	ensureCollections,
	ensureSearchIndexes,
	ensureStandardIndexes,
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	episodesCollection,
	memoryEvidenceCollection,
	filesCollection,
	getExpectedSearchIndexTargets,
	isEventsVectorBitemporalPrefilterReady,
	isSearchIndexManagementAvailable,
	kbChunksCollection,
	metaCollection,
	proceduresCollection,
	queryCacheCollection,
	relevanceRunsCollection,
	resolveSearchIndexReadinessTiming,
	structuredMemCollection,
	waitForSearchIndexesQueryable,
	sessionChunksCollection,
} from "./mongodb-schema.js"
import { resolveScopeIdentity, resolveScopeRef } from "./mongodb-scope.js"
import {
	buildVectorSearchStage,
	MONGODB_MAX_NUM_CANDIDATES,
	mongoSearch,
	vectorSearch,
} from "./mongodb-search.js"
import {
	getSearchBudgetSnapshot,
	hasActiveSearchBudget,
	resolveSearchBudgetLimits,
	resolveUserSearchMaxTimeMs,
	runWithSearchBudget,
	type SearchBudgetLimits,
	type SearchBudgetSnapshot,
	tryConsumeSearchAggregation,
	tryConsumeSearchEmbed,
} from "./mongodb-search-budget.js"
import { applyCapabilityProbeResult } from "./mongodb-capability-registry.js"
import type {
	SearchExplainOptions,
	SearchExplainTraceArtifact,
	SearchTraceEvent,
} from "./mongodb-search.js"
import type {
	StructuredMemoryEntry,
	StructuredMemoryLifecyclePatch,
	StructuredMemorySalience,
	StructuredMemoryState,
} from "./mongodb-structured-memory.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { annotateResultsWithTrust, summarizeTrust } from "./mongodb-trust.js"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { scanNovelty } from "./mongodb-novelty.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { expandSearchContext } from "./mongodb-context-expansion.js"
import {
	applyHardConstraintRejections,
	applySearchConfig,
	buildConstraintSummaries,
	buildExecutorPasses,
	buildMemorySearchRequestSignature,
	classifyExecutorSearch,
	applyLaneAwareResultControls,
	computeEvidenceCoverage,
	executeMongoSearchPlan,
	normalizeMemorySearchRequest,
	resolveExecutorTimeRange,
	resolveProfileNumCandidates,
	resolveSearchConfig,
	requestHasHardConstraints,
} from "./mongodb-search-executor.js"
import type {
	ConversationRecallRequest,
	ConversationRecallResponse,
	BenchmarkE2eQaEnvelope,
	BenchmarkQualityThresholds,
	BenchmarkTenantStorageMeasurement,
	MemoryActiveSlate,
	AccessEventCollection,
	MemoryContextBundle,
	MemoryContextBundleRequest,
	MemoryDiscoveryProjection,
	MemoryDiscoveryProjectionRequest,
	MemoryEmbeddingProbeResult,
	MemoryAccessSummary,
	MemoryAccessTrend,
	MemoryBenchmarkDataset,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkConversation,
	MemoryBenchmarkTurn,
	MemoryBenchmarkScenario,
	MemoryBenchmarkIngestResult,
	MemoryConversationImportResult,
	MemoryFeedbackSignal,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	MemoryStableHandle,
	MemoryProviderStatus,
	MemorySearchManager,
	MemorySearchRequest,
	MemorySearchResponse,
	MemorySearchResult,
	MemorySearchMetadata,
	MemorySearchMode,
	MemorySource,
	MemorySelfEditBlock,
	MemorySelfEditAction,
	MemorySyncProgressUpdate,
	MemoryActorRole,
	ClaimedMemoryJob,
	ResolvedSearchConfig,
} from "./types.js"

// v2 validation constants
const VALID_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
])
const VALID_ROLES: ReadonlySet<string> = new Set([
	"user",
	"assistant",
	"system",
	"tool",
])
const VALID_STRUCTURED_STATES: ReadonlySet<StructuredMemoryState> = new Set([
	"active",
	"invalidated",
	"conflicted",
])
const VALID_STRUCTURED_SALIENCE: ReadonlySet<StructuredMemorySalience> =
	new Set(["critical", "high", "normal", "low"])
const MEMORY_JOB_LEASE_MS = 60_000
const MEMORY_JOB_HEARTBEAT_MS = 20_000
const MEMORY_JOB_POLL_MS = 1_000
const VALID_PROCEDURE_STATES: ReadonlySet<ProcedureState> = new Set([
	"active",
	"invalidated",
	"conflicted",
])

const BENCHMARK_SCENARIO_COLLECTION_SUFFIXES = [
	"events",
	"chunks",
	"session_chunks",
	"memory_evidence",
	"structured_mem",
	"structured_mem_revisions",
	"procedures",
	"procedure_revisions",
	"entities",
	"relations",
	"entity_links",
	"episodes",
	"ingest_runs",
	"projection_runs",
	"lane_coverage",
	"relevance_runs",
	"relevance_regressions",
	"relevance_artifacts",
	"recall_traces",
	"memory_jobs",
	"consolidation_runs",
	"memory_mutations",
] as const

function isLegacyBenchmarkFallbackCandidate(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.message === "benchmark dataset contains no valid conversations" ||
			err.message === "benchmark dataset contains no evaluation cases")
	)
}

/**
 * Benchmark strict mode toggle. Reads MEMONGO_BENCHMARK_STRICT at call time
 * (not at module load) so tests that mutate the env mid-run see the update.
 * Truthy values: "1", "true" (case-insensitive). Everything else is false.
 *
 * Referenced in 22 hot-path sites across this file. Was previously called
 * without a definition (latent ReferenceError masked only by conditionals
 * that never executed in non-strict runs); Task 1.5 uses it in the new
 * readiness-probe delegate, so we define it here.
 */
function isBenchmarkStrictMode(): boolean {
	const v = process.env.MEMONGO_BENCHMARK_STRICT
	return v === "1" || v?.toLowerCase() === "true"
}

function hasBenchmarkSearchableText(value: unknown): boolean {
	return typeof value === "string" && /[\p{L}\p{N}]/u.test(value)
}

type BenchmarkConvergenceNamespace = {
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	sessionId?: string
}

function benchmarkConvergenceFilter(
	namespace: BenchmarkConvergenceNamespace,
): Document {
	return {
		agentId: namespace.agentId,
		...(namespace.scope ? { scope: namespace.scope } : {}),
		...(namespace.scopeRef ? { scopeRef: namespace.scopeRef } : {}),
		...(namespace.sessionId ? { sessionId: namespace.sessionId } : {}),
	}
}

function benchmarkSearchEqualsFilters(
	namespace: BenchmarkConvergenceNamespace,
): Document[] {
	return Object.entries(benchmarkConvergenceFilter(namespace)).map(
		([path, value]) => ({ equals: { path, value } }),
	)
}

function benchmarkSearchProbeTerm(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const terms = value.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? []
	return terms.find((term) => term.length >= 4) ?? terms[0]
}

function parseBenchmarkTurnTimestamp(value?: string): Date | undefined {
	if (!value) return undefined
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function buildBenchmarkReplayMetadata(params: {
	baseMetadata?: Record<string, unknown>
	turnMetadata?: Record<string, unknown>
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind
	conversationId: string
}): Record<string, unknown> {
	return {
		...(params.baseMetadata ?? {}),
		...(params.turnMetadata ?? {}),
		benchmarkDataset: params.datasetName,
		benchmarkDatasetKind: params.datasetKind,
		benchmarkConversationId: params.conversationId,
	}
}

function attachBenchmarkOperationsReport(
	result: RelevanceBenchmarkResult,
	parity?: {
		runIdentity: import("./types.js").BenchmarkRunIdentity
		embedding: import("./types.js").BenchmarkEmbeddingConfig
		reranker: import("./types.js").BenchmarkRerankerConfig
		storage: import("./types.js").BenchmarkStorageFootprint
		latency: import("./types.js").BenchmarkLatencyDistribution
		cost: import("./types.js").BenchmarkCostAccounting
	},
	qualityThresholds?: BenchmarkQualityThresholds,
	e2eQa?: BenchmarkE2eQaEnvelope,
	conversationRecallRegression?: {
		status: "passed" | "failed"
		evidence: string
	},
): RelevanceBenchmarkResult {
	const queryGovernance = buildQueryGovernanceReport(result)
	return {
		...result,
		queryGovernance,
		benchmarkReport: buildBenchmarkRunReport({
			...result,
			queryGovernance,
			...(qualityThresholds ? { qualityThresholds } : {}),
			...(e2eQa ? { e2eQa } : {}),
			...(conversationRecallRegression ? { conversationRecallRegression } : {}),
			...(parity
				? {
						runIdentity: parity.runIdentity,
						embedding: parity.embedding,
						reranker: parity.reranker,
						storage: parity.storage,
						latency: parity.latency,
						cost: parity.cost,
					}
				: {}),
		}),
	}
}

type BenchmarkEventEvidenceMaps = {
	sessionIds: Map<string, string>
	turnIds: Map<string, string>
	dialogIds: Map<string, string>
}

export type RelevanceExplainResult = {
	runId?: string
	latencyMs: number
	sourceScope: RelevanceSourceScope
	health: RelevanceHealth
	fallbackPath?: string
	sampleRate: number
	artifacts: RelevanceArtifact[]
	results: MemorySearchResult[]
}

const log = createSubsystemLogger("memory:mongodb")
const CHANGE_STREAM_RESUME_TOKEN_META_KEY = "change_stream_resume_token"

function isStrictSearchReadinessMode(): boolean {
	return (
		process.env.MEMONGO_BENCHMARK_STRICT === "1" ||
		process.env.MEMONGO_STRICT_SEARCH_INDEX_READY === "1"
	)
}

function isBenchmarkTurnPrecisionMode(): boolean {
	return process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE === "enabled"
}

/**
 * #66: how many times the measurement (evaluation) loop runs over one
 * already-ingested scenario corpus. Ingest costs ~48 minutes and dominates a
 * run, so extra passes are the cheap way to get n>1 samples of the same
 * condition. Default 1 reproduces single-sample behavior exactly.
 */
function resolveBenchmarkMeasurementPasses(): number {
	const raw = Number(process.env.MEMONGO_BENCHMARK_MEASUREMENT_PASSES)
	if (!Number.isFinite(raw) || raw < 1) {
		return 1
	}
	return Math.floor(raw)
}

function isTemporalCoverageMode(): boolean {
	return (
		process.env.MEMONGO_TEMPORAL_COVERAGE_MODE === "enabled" ||
		process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE === "enabled"
	)
}

function buildSearchFilterEquals(
	path: string,
	value: unknown,
): Document | null {
	if (Array.isArray(value)) {
		return value.length > 0 ? { in: { path, value } } : null
	}
	if (typeof value === "string" && value.trim().length > 0) {
		return { equals: { path, value } }
	}
	return null
}

function mapEventSearchDocToResult(
	doc: Document,
	lane: "turn-vector" | "turn-text",
): MemorySearchResult | null {
	const eventId = typeof doc.eventId === "string" ? doc.eventId.trim() : ""
	const body = typeof doc.body === "string" ? doc.body : ""
	if (!eventId || !body) return null
	const score = typeof doc.score === "number" ? doc.score : 0
	return {
		path: `events/${eventId}`,
		filePath: `events/${eventId}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: body.slice(0, 700),
		source: "conversation",
		sourceType: "conversation",
		canonicalId: `event:${eventId}`,
		...(typeof doc.sessionId === "string" ? { sessionId: doc.sessionId } : {}),
		...(doc.timestamp instanceof Date ? { timestamp: doc.timestamp } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		// P3.7 wiring: project the reinforcement counter where the lane has it
		// (events) so the post-CE access boost reads a real value.
		...(typeof doc.accessCount === "number" && Number.isFinite(doc.accessCount)
			? { accessCount: doc.accessCount }
			: {}),
		sourceEventIds: [eventId],
		provenance: {
			lane,
			turnPrecisionRerank: true,
			...(typeof doc.role === "string" ? { eventRole: doc.role } : {}),
		},
	}
}

export function mergeRankedResultSets(
	resultSets: MemorySearchResult[][],
): MemorySearchResult[] {
	const activeSets = resultSets.filter((results) => results.length > 0)
	if (activeSets.length <= 1) {
		return activeSets[0]?.map((result) => ({ ...result })) ?? []
	}
	const byIdentity = new Map<
		string,
		MemorySearchResult & { originalScore: number; rrfScore: number }
	>()
	for (const results of resultSets) {
		for (let index = 0; index < results.length; index++) {
			const result = results[index]
			const key = searchResultIdentityKey(result)
			const score = rrfScore(index + 1)
			const existing = byIdentity.get(key)
			if (existing) {
				existing.rrfScore += score
				existing.score = existing.rrfScore
				if (result.score > existing.originalScore) {
					Object.assign(existing, {
						...result,
						originalScore: result.score,
						rrfScore: existing.rrfScore,
						score: existing.rrfScore,
					})
				}
			} else {
				byIdentity.set(key, {
					...result,
					originalScore: result.score,
					rrfScore: score,
					score,
				})
			}
		}
	}
	return Array.from(byIdentity.values())
		.toSorted((left, right) => right.rrfScore - left.rrfScore)
		.map(
			({ originalScore: _originalScore, rrfScore: _rrfScore, ...result }) =>
				result,
		)
}

function mergeTurnPrecisionResults(
	resultSets: MemorySearchResult[][],
): MemorySearchResult[] {
	return mergeRankedResultSets(resultSets)
}

const RECOMMENDATION_MEMORY_QUERY_RE =
	/\b(?:advice|tips?|suggest(?:ion)?s?|recommend(?:ation)?s?|accessor(?:y|ies)|complement|setup|prefer|preference)\b|(?:\bwhat\s+should\s+i\b|\bany\s+(?:tips?|suggestions?|recommendations?)\b)/i

const FIRST_PERSON_MEMORY_SIGNAL_RE =
	/\b(?:i(?:'m| am|'ve| have|'d| would)?|my|we(?:'re| are|'ve| have|'d| would)?|our)\b/i
const PREFERENCE_CONTEXT_SIGNAL_RE =
	/\b(?:like|love|prefer|favorite|enjoy|use|using|used|have|own|bought|purchased|consider(?:ing)?|try(?:ing)?|attend(?:ed|ing)?|learn(?:ed|ing)?|made|make|harvest(?:ed|ing)?|grew|grow(?:n|ing)?|garden(?:ing)?|class|course|travel|accessor(?:y|ies)|ingredient(?:s)?|setup|routine|habit)\b/i
const FIRST_PERSON_ACTIVITY_SIGNAL_RE =
	/\b(?:i(?:'ve| have| am|'m)?|we(?:'ve| have| are|'re)?|my|our)\b.{0,96}\b(?:like|love|prefer|enjoy|use|using|used|have|own|bought|purchased|consider(?:ing)?|try(?:ing)?|attend(?:ed|ing)?|learn(?:ed|ing)?|made|make|harvest(?:ed|ing)?|grew|grow(?:n|ing)?|garden(?:ing)?|class|course|travel|setup|routine|habit)\b/i

export function scorePreferenceGroundingSignalBoost(
	query: string,
	result: MemorySearchResult,
): number {
	if (!RECOMMENDATION_MEMORY_QUERY_RE.test(query)) {
		return 0
	}
	if (result.provenance?.eventRole !== "user") {
		return 0
	}
	const snippet = result.snippet.toLowerCase()
	let boost = 0.04
	if (
		FIRST_PERSON_MEMORY_SIGNAL_RE.test(snippet) &&
		PREFERENCE_CONTEXT_SIGNAL_RE.test(snippet)
	) {
		boost += 0.16
	}
	if (FIRST_PERSON_ACTIVITY_SIGNAL_RE.test(snippet)) {
		boost += 0.08
	}
	if (
		/\b(?:compatible|specifically designed|designed for|as a .* user)\b/i.test(
			snippet,
		)
	) {
		boost += 0.08
	}
	return Math.min(boost, 0.32)
}

function applyPreferenceEvidenceBoostAfterRerank(
	query: string,
	results: MemorySearchResult[],
): MemorySearchResult[] {
	if (!RECOMMENDATION_MEMORY_QUERY_RE.test(query)) {
		return results
	}
	return results
		.map((result, index) => ({
			result: {
				...result,
				score:
					result.score + scorePreferenceGroundingSignalBoost(query, result),
			},
			index,
		}))
		.toSorted(
			(left, right) =>
				right.result.score - left.result.score || left.index - right.index,
		)
		.map(({ result }) => result)
}

// P3.7: post-cross-encoder recency/access boost. The CE rerank overwrites
// `score`, erasing every pre-CE boost; this hook reintroduces recency and
// reinforcement as multiplicative factors on the CE score:
//   score *= (1 + alpha * (recencyNorm - 0.5)) * (1 + beta * (accessNorm - 0.5))
// Both norms are min-max normalized to [0,1] across the result set, so the
// factors are relative to the set and calibration-free. Degenerate sets
// (single value, missing fields) normalize to 0.5, i.e. a neutral factor.
const DEFAULT_RECENCY_ACCESS_BOOST_WEIGHT = 0.2

function normalizeRecencyAccessValues(
	values: (number | undefined)[],
): (number | undefined)[] {
	const present = values.filter(
		(value): value is number => typeof value === "number",
	)
	if (present.length <= 1) {
		// Degenerate set: every present value is neutral.
		return values.map((value) => (typeof value === "number" ? 0.5 : undefined))
	}
	const min = Math.min(...present)
	const max = Math.max(...present)
	if (max === min) {
		return values.map((value) => (typeof value === "number" ? 0.5 : undefined))
	}
	return values.map((value) =>
		typeof value === "number" ? (value - min) / (max - min) : undefined,
	)
}

export function applyRecencyAccessBoostAfterRerank(
	results: MemorySearchResult[],
	options?: { recencyBoost?: number; accessBoost?: number },
): MemorySearchResult[] {
	const recencyBoost =
		options?.recencyBoost ?? DEFAULT_RECENCY_ACCESS_BOOST_WEIGHT
	const accessBoost =
		options?.accessBoost ?? DEFAULT_RECENCY_ACCESS_BOOST_WEIGHT
	// Zero weights are the off-switch: skip the pass so scores stay
	// bit-identical to the CE output.
	if (recencyBoost === 0 && accessBoost === 0) {
		return results
	}
	const recencyNorms = normalizeRecencyAccessValues(
		results.map((result) =>
			result.timestamp instanceof Date ? result.timestamp.getTime() : undefined,
		),
	)
	const accessNorms = normalizeRecencyAccessValues(
		results.map((result) =>
			typeof result.accessCount === "number" &&
			Number.isFinite(result.accessCount)
				? result.accessCount
				: undefined,
		),
	)
	return results
		.map((result, index) => {
			// Missing fields degrade to a neutral factor, never a penalty.
			const recencyNorm = recencyNorms[index] ?? 0.5
			const accessNorm = accessNorms[index] ?? 0.5
			return {
				result: {
					...result,
					score:
						result.score *
						(1 + recencyBoost * (recencyNorm - 0.5)) *
						(1 + accessBoost * (accessNorm - 0.5)),
				},
				index,
			}
		})
		.toSorted(
			(left, right) =>
				right.result.score - left.result.score || left.index - right.index,
		)
		.map(({ result }) => result)
}

function stripSessionSummaryTurnProvenance(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	return results.map((result) => {
		if (!result.canonicalId?.startsWith("session-chunk/")) {
			return result
		}
		const { sourceEventIds: _sourceEventIds, ...rest } = result
		return {
			...rest,
			provenance: {
				...(result.provenance ?? {}),
				turnPrecisionSourceEventIdsSuppressed: true,
			},
		}
	})
}

const TEMPORAL_COVERAGE_QUERY_RE =
	/\b(?:last|latest|recent|recently|since|before|after|when|months?|years?|weeks?|days?|passed|ago|january|february|march|april|may|june|july|august|september|october|november|december)\b/i

const CONVERSATION_EVIDENCE_QUERY_RE =
	/\b(?:previous conversation|earlier conversation|past conversation|last conversation|we discussed|we talked|i said|i told you|did i|did we|have i|have we|how many|remind me|appointments?)\b/i

const TEMPORAL_COVERAGE_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"been",
	"being",
	"but",
	"by",
	"could",
	"did",
	"do",
	"does",
	"for",
	"had",
	"has",
	"many",
	"much",
	"passed",
	"since",
	"last",
	"latest",
	"recent",
	"recently",
	"before",
	"after",
	"when",
	"month",
	"months",
	"year",
	"years",
	"week",
	"weeks",
	"day",
	"days",
	"ago",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"its",
	"may",
	"me",
	"might",
	"my",
	"not",
	"of",
	"on",
	"or",
	"our",
	"should",
	"so",
	"that",
	"the",
	"their",
	"these",
	"they",
	"this",
	"those",
	"to",
	"user",
	"was",
	"we",
	"were",
	"what",
	"where",
	"which",
	"who",
	"whom",
	"why",
	"will",
	"would",
	"with",
	"from",
	"you",
	"your",
])

const TEMPORAL_COVERAGE_WEAK_TERMS = new Set([
	"go",
	"goes",
	"going",
	"gone",
	"visit",
	"visited",
	"visiting",
	"visits",
])

const TEMPORAL_COVERAGE_TIMELINE_EVENT_LIMIT = 12

function isTemporalCoverageQuery(
	query: string,
	questionDate: Date | undefined,
): boolean {
	return Boolean(
		questionDate &&
			!Number.isNaN(questionDate.getTime()) &&
			TEMPORAL_COVERAGE_QUERY_RE.test(query),
	)
}

export function isConversationEvidenceQuery(
	query: string,
	questionDate: Date | undefined,
): boolean {
	return (
		CONVERSATION_EVIDENCE_QUERY_RE.test(query) ||
		RECOMMENDATION_MEMORY_QUERY_RE.test(query) ||
		isTemporalCoverageQuery(query, questionDate)
	)
}

function expandTemporalCoverageTerm(term: string): string[] {
	const terms = new Set([term])
	if (term.endsWith("ies") && term.length > 4) {
		terms.add(`${term.slice(0, -3)}y`)
	}
	if (term.endsWith("s") && term.length > 4) {
		terms.add(term.slice(0, -1))
	}
	if (term.endsWith("ed") && term.length > 4) {
		terms.add(term.slice(0, -2))
	}
	if (term.endsWith("ing") && term.length > 5) {
		terms.add(term.slice(0, -3))
	}
	return Array.from(terms)
}

function extractTemporalCoverageTerms(query: string): string[] {
	const rawTerms = query
		.toLowerCase()
		.split(/\s+/)
		.map((word) => word.replace(/[^a-z0-9]/g, ""))
		.filter((word) => word.length >= 3)
		.filter((word) => !TEMPORAL_COVERAGE_STOP_WORDS.has(word))
	const expanded = new Set<string>()
	for (const term of rawTerms) {
		for (const expandedTerm of expandTemporalCoverageTerm(term)) {
			if (expandedTerm.length >= 3) expanded.add(expandedTerm)
		}
	}
	return Array.from(expanded).slice(0, 12)
}

function extractTemporalCoverageAnchorTerms(terms: string[]): string[] {
	const anchors = terms.filter(
		(term) => !TEMPORAL_COVERAGE_WEAK_TERMS.has(term),
	)
	return anchors.length > 0 ? anchors : terms
}

function scoreTemporalCoverageSessionEvent(
	body: string,
	terms: string[],
	timestamp: Date | undefined,
	questionDate: Date | undefined,
): number {
	const bodyLower = body.toLowerCase()
	const matches = terms.filter((term) => bodyLower.includes(term)).length
	const overlap = terms.length > 0 ? matches / terms.length : 0
	const temporalScore =
		timestamp && questionDate
			? Math.max(
					0,
					1 -
						Math.abs(questionDate.getTime() - timestamp.getTime()) /
							(365 * 24 * 60 * 60 * 1000),
				)
			: 0
	return 0.04 + overlap * 0.08 + temporalScore * 0.02
}

function orderTemporalCoverageBySession(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const bySession = new Map<string, MemorySearchResult[]>()
	const withoutSession: MemorySearchResult[] = []
	for (const result of results) {
		if (!result.sessionId) {
			withoutSession.push(result)
			continue
		}
		const sessionResults = bySession.get(result.sessionId)
		if (sessionResults) {
			sessionResults.push(result)
		} else {
			bySession.set(result.sessionId, [result])
		}
	}
	for (const sessionResults of bySession.values()) {
		sessionResults.sort((left, right) => right.score - left.score)
	}

	const output: MemorySearchResult[] = []
	let depth = 0
	while (output.length < results.length) {
		let added = false
		for (const sessionResults of bySession.values()) {
			const result = sessionResults[depth]
			if (result) {
				output.push(result)
				added = true
			}
		}
		if (!added) break
		depth++
	}
	return [...output, ...withoutSession]
}

function temporalCoverageBucketKey(result: MemorySearchResult): string {
	if (!result.timestamp) return "unknown"
	return result.timestamp.toISOString().slice(0, 7)
}

function orderTemporalCoverageByTimeBucket(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const byBucket = new Map<string, MemorySearchResult[]>()
	for (const result of results) {
		const key = temporalCoverageBucketKey(result)
		const bucket = byBucket.get(key)
		if (bucket) {
			bucket.push(result)
		} else {
			byBucket.set(key, [result])
		}
	}

	for (const bucket of byBucket.values()) {
		bucket.sort((left, right) => right.score - left.score)
	}

	const bucketEntries = [...byBucket.entries()].sort(([left], [right]) => {
		if (left === "unknown") return 1
		if (right === "unknown") return -1
		return right.localeCompare(left)
	})
	const output: MemorySearchResult[] = []
	const seenPaths = new Set<string>()
	for (let depth = 0; depth < 2; depth++) {
		for (const [, bucket] of bucketEntries) {
			const result = bucket[depth]
			if (!result || seenPaths.has(result.path)) continue
			output.push(result)
			seenPaths.add(result.path)
		}
	}

	for (const result of results) {
		if (seenPaths.has(result.path)) continue
		output.push(result)
		seenPaths.add(result.path)
	}
	return output
}

function isUserAuthoredTemporalResult(result: MemorySearchResult): boolean {
	return result.provenance?.eventRole === "user"
}

function chooseTemporalTimelinePrimary(
	results: MemorySearchResult[],
): MemorySearchResult {
	return results.toSorted((left, right) => {
		const roleDelta =
			(isUserAuthoredTemporalResult(right) ? 1 : 0) -
			(isUserAuthoredTemporalResult(left) ? 1 : 0)
		if (roleDelta !== 0) return roleDelta
		return right.score - left.score
	})[0]
}

function orderTemporalTimelineSourceEvidence(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const bySession = new Map<string, MemorySearchResult[]>()
	const withoutSession: MemorySearchResult[] = []
	for (const result of results) {
		if (!result.sessionId) {
			withoutSession.push(result)
			continue
		}
		const sessionResults = bySession.get(result.sessionId)
		if (sessionResults) {
			sessionResults.push(result)
		} else {
			bySession.set(result.sessionId, [result])
		}
	}
	const primaries = new Set<string>()
	const primaryResults = Array.from(bySession.values()).map(
		(sessionResults) => {
			const primary = chooseTemporalTimelinePrimary(sessionResults)
			primaries.add(primary.path)
			return primary
		},
	)
	return [
		...primaryResults,
		...withoutSession,
		...results.filter((result) => !primaries.has(result.path)),
	]
}

function buildTemporalCoverageTimelineResult(
	query: string,
	results: MemorySearchResult[],
): MemorySearchResult | null {
	const timelineResults = orderTemporalTimelineSourceEvidence(results)
	const visibleTimelineResults = timelineResults.slice(
		0,
		TEMPORAL_COVERAGE_TIMELINE_EVENT_LIMIT,
	)
	const sourceEventIds = [
		...new Set(
			visibleTimelineResults.flatMap((result) =>
				Array.isArray(result.sourceEventIds) ? result.sourceEventIds : [],
			),
		),
	]
	const sessionIds = [
		...new Set(
			results
				.map((result) => result.sessionId)
				.filter((sessionId): sessionId is string => Boolean(sessionId)),
		),
	]
	if (sourceEventIds.length === 0 || sessionIds.length < 2) return null

	const timeline = timelineResults
		.slice(0, TEMPORAL_COVERAGE_TIMELINE_EVENT_LIMIT)
		.map((result) => {
			const timestamp = result.timestamp
				? result.timestamp.toISOString().slice(0, 10)
				: "unknown-date"
			const session = result.sessionId ? ` session=${result.sessionId}` : ""
			return `- ${timestamp}${session}: ${result.snippet.replace(/\s+/g, " ").slice(0, 220)}`
		})
		.join("\n")
	const hash = createHash("sha256")
		.update(`${query}\n${sourceEventIds.join("\n")}`)
		.digest("hex")
		.slice(0, 16)
	const topScore =
		results.length > 0 ? Math.max(...results.map((result) => result.score)) : 0

	return {
		path: `temporal-coverage/${hash}`,
		filePath: `temporal-coverage/${hash}`,
		startLine: 0,
		endLine: 0,
		score: Math.max(0, topScore - 0.05),
		snippet: `Temporal event timeline for: ${query}\n${timeline}`,
		source: "conversation",
		sourceType: "conversation",
		canonicalId: `temporal-coverage/${hash}`,
		sourceEventIds,
		provenance: {
			lane: "temporal-coverage-timeline",
			temporalCoverage: true,
			temporalTimeline: true,
			sessionIds,
		},
	}
}

function orderTimelineAfterSourceEvidence(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const timelineResults = results.filter(
		(result) => result.provenance?.temporalTimeline === true,
	)
	if (timelineResults.length === 0) return results
	const sourceResults = results.filter(
		(result) => result.provenance?.temporalTimeline !== true,
	)
	if (sourceResults.length === 0) return results
	return [...sourceResults, ...timelineResults]
}

async function expandTemporalCoverageSessionEvents(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionIds: string[]
	terms: string[]
	questionDate: Date
	maxPerSession: number
	maxEvents: number
}): Promise<MemorySearchResult[]> {
	const sessionIds = [...new Set(params.sessionIds)].filter(Boolean)
	if (sessionIds.length === 0) return []
	const docs = await eventsCollection(params.db, params.prefix)
		.find(
			{
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId: { $in: sessionIds },
				role: "user",
				timestamp: { $lte: params.questionDate },
			},
			{
				projection: {
					_id: 0,
					eventId: 1,
					body: 1,
					role: 1,
					sessionId: 1,
					timestamp: 1,
					scope: 1,
					scopeRef: 1,
					accessCount: 1,
				},
				sort: { timestamp: 1 },
				limit: Math.max(params.maxEvents * 4, sessionIds.length * 6),
			},
		)
		.toArray()
	const bySession = new Map<string, Document[]>()
	for (const doc of docs) {
		if (
			typeof doc.sessionId !== "string" ||
			!sessionIds.includes(doc.sessionId)
		) {
			continue
		}
		const bucket = bySession.get(doc.sessionId)
		if (bucket) {
			bucket.push(doc)
		} else {
			bySession.set(doc.sessionId, [doc])
		}
	}

	const selected: MemorySearchResult[] = []
	for (const sessionId of sessionIds) {
		const sessionDocs = bySession.get(sessionId) ?? []
		if (sessionDocs.length === 0) continue
		const scored = sessionDocs
			.map((doc, index) => ({
				doc,
				index,
				score: scoreTemporalCoverageSessionEvent(
					typeof doc.body === "string" ? doc.body : "",
					params.terms,
					doc.timestamp instanceof Date ? doc.timestamp : undefined,
					params.questionDate,
				),
			}))
			.toSorted((left, right) => {
				const scoreDelta = right.score - left.score
				return Math.abs(scoreDelta) > 0.000001
					? scoreDelta
					: left.index - right.index
			})
		const picked = new Map<Document, number>()
		picked.set(
			sessionDocs[0],
			scoreTemporalCoverageSessionEvent(
				typeof sessionDocs[0].body === "string" ? sessionDocs[0].body : "",
				params.terms,
				sessionDocs[0].timestamp instanceof Date
					? sessionDocs[0].timestamp
					: undefined,
				params.questionDate,
			),
		)
		for (const entry of scored) {
			picked.set(entry.doc, entry.score)
			if (picked.size >= params.maxPerSession) break
		}
		for (const [doc, score] of picked) {
			const result = mapEventSearchDocToResult({ ...doc, score }, "turn-text")
			if (!result) continue
			selected.push({
				...result,
				provenance: {
					...(result.provenance ?? {}),
					lane: "temporal-session-expansion",
					temporalCoverage: true,
					temporalSessionExpansion: true,
				},
			})
		}
	}

	return orderTemporalCoverageByTimeBucket(
		orderTemporalCoverageBySession(selected),
	).slice(0, params.maxEvents)
}

async function searchTemporalCoverageEvents(params: {
	db: Db
	prefix: string
	query: string
	questionDate: Date | undefined
	agentId: string
	scope: MemoryScope
	scopeRef: string
	maxResults: number
	capabilities: DetectedCapabilities
}): Promise<MemorySearchResult[]> {
	const temporalQuery = isTemporalCoverageQuery(
		params.query,
		params.questionDate,
	)
	if (!temporalQuery) {
		return []
	}
	if (!params.capabilities.textSearch) {
		if (isBenchmarkStrictMode()) {
			throw new Error(
				"temporal coverage search requires MongoDB Search text capability in strict mode",
			)
		}
		return []
	}

	const terms = extractTemporalCoverageTerms(params.query)
	if (terms.length === 0 || !params.questionDate) return []
	const anchorTerms = extractTemporalCoverageAnchorTerms(terms)

	const filters = [
		buildSearchFilterEquals("agentId", params.agentId),
		buildSearchFilterEquals("scope", params.scope),
		buildSearchFilterEquals("scopeRef", params.scopeRef),
		{
			range: {
				path: "timestamp",
				lte: params.questionDate,
			},
		},
	].filter((value): value is Document => Boolean(value))

	const temporalPivotMs = 180 * 24 * 60 * 60 * 1000
	const pipeline: Document[] = [
		{
			$search: {
				index: `${params.prefix}events_text`,
				compound: {
					filter: filters,
					must: [
						{
							text: {
								query: anchorTerms,
								path: "body",
							},
						},
					],
					should: [
						{
							text: {
								query: terms,
								path: "body",
							},
						},
						{
							near: {
								path: "timestamp",
								origin: params.questionDate,
								pivot: temporalPivotMs,
								score: { boost: { value: 2 } },
							},
						},
					],
				},
			},
		},
		{ $limit: Math.max(params.maxResults * 3, 30) },
		{
			$project: {
				_id: 0,
				eventId: 1,
				body: 1,
				role: 1,
				sessionId: 1,
				timestamp: 1,
				scope: 1,
				scopeRef: 1,
				accessCount: 1,
				score: { $meta: "searchScore" },
			},
		},
	]

	// P3.2: this direct aggregate bypasses runSearchAggregateWithRetry, so it
	// consumes the per-request budget here.
	if (!tryConsumeSearchAggregation()) {
		return []
	}
	const docs = await eventsCollection(params.db, params.prefix)
		// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
		.aggregate(pipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
		.toArray()
	const mapped = docs
		.map((doc) => mapEventSearchDocToResult(doc, "turn-text"))
		.filter((result): result is MemorySearchResult => Boolean(result))
		.map((result) => ({
			...result,
			score: result.score + 0.02,
			provenance: {
				...(result.provenance ?? {}),
				lane: "temporal-coverage",
				temporalCoverage: true,
			},
		}))

	const ordered = orderTemporalCoverageByTimeBucket(
		orderTemporalCoverageBySession(mapped),
	)
	const sessionIds = [
		...new Set(
			ordered
				.map((result) => result.sessionId)
				.filter((sessionId): sessionId is string => Boolean(sessionId)),
		),
	].slice(0, 5)
	const expandedSessionEvents = await expandTemporalCoverageSessionEvents({
		db: params.db,
		prefix: params.prefix,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionIds,
		terms,
		questionDate: params.questionDate,
		maxPerSession: 3,
		maxEvents: Math.max(params.maxResults, 30),
	})
	const timelineEvidence = orderTemporalCoverageByTimeBucket(
		orderTemporalCoverageBySession(
			deduplicateSearchResults([...expandedSessionEvents, ...ordered]),
		),
	)
	const timeline = buildTemporalCoverageTimelineResult(
		params.query,
		timelineEvidence.slice(0, Math.max(params.maxResults, 30)),
	)
	const eventResults = timelineEvidence.slice(0, params.maxResults)
	return timeline ? [timeline, ...eventResults] : eventResults
}

async function searchTurnEventsWithinSessions(params: {
	db: Db
	prefix: string
	query: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionIds: string[]
	maxResults: number
	numCandidates: number
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
}): Promise<MemorySearchResult[]> {
	const sessionIds = Array.from(new Set(params.sessionIds)).filter(
		(value) => value.trim().length > 0,
	)
	if (sessionIds.length === 0) return []

	const events = eventsCollection(params.db, params.prefix)
	const vectorFilter: Document = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: { $in: sessionIds },
	}
	const textFilters = [
		buildSearchFilterEquals("agentId", params.agentId),
		buildSearchFilterEquals("scope", params.scope),
		buildSearchFilterEquals("scopeRef", params.scopeRef),
		buildSearchFilterEquals("sessionId", sessionIds),
	].filter((value): value is Document => Boolean(value))

	const searches: Array<Promise<MemorySearchResult[]>> = []
	if (
		params.capabilities.vectorSearch &&
		params.embeddingMode === "automated" &&
		// P3.2: these inline $vectorSearch pipelines bypass
		// buildVectorSearchStage, so they consume the per-request aggregation +
		// server-side embed budget here.
		tryConsumeSearchAggregation() &&
		tryConsumeSearchEmbed()
	) {
		const vectorPipeline: Document[] = [
			{
				$vectorSearch: {
					index: `${params.prefix}events_vector`,
					path: "body",
					query: { text: params.query },
					model: "voyage-4-large",
					filter: vectorFilter,
					numCandidates: params.numCandidates,
					limit: params.maxResults,
				},
			},
			{
				$project: {
					_id: 0,
					eventId: 1,
					body: 1,
					role: 1,
					sessionId: 1,
					timestamp: 1,
					scope: 1,
					scopeRef: 1,
					accessCount: 1,
					score: { $meta: "vectorSearchScore" },
				},
			},
		]
		searches.push(
			events
				// P3.8: user-driven $vectorSearch pipelines carry a maxTimeMS ceiling.
				.aggregate(vectorPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-vector"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}
	// P3.2: direct aggregates consume the per-request budget here.
	if (params.capabilities.textSearch && tryConsumeSearchAggregation()) {
		const textPipeline: Document[] = [
			{
				$search: {
					index: `${params.prefix}events_text`,
					compound: {
						must: [{ text: { query: params.query, path: "body" } }],
						filter: textFilters,
					},
				},
			},
			{ $limit: params.maxResults },
			{
				$project: {
					_id: 0,
					eventId: 1,
					body: 1,
					role: 1,
					sessionId: 1,
					timestamp: 1,
					scope: 1,
					scopeRef: 1,
					accessCount: 1,
					score: { $meta: "searchScore" },
				},
			},
		]
		searches.push(
			events
				// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
				.aggregate(textPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-text"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}

	if (searches.length === 0) return []
	const results = await Promise.all(searches)
	return mergeTurnPrecisionResults(results)
		.map((result, index) => ({
			...result,
			score:
				Math.max(result.score, 1 - index * 0.01) +
				scorePreferenceGroundingSignalBoost(params.query, result),
		}))
		.toSorted((left, right) => right.score - left.score)
		.slice(0, params.maxResults)
}

async function searchConversationEvidenceEvents(params: {
	db: Db
	prefix: string
	query: string
	questionDate: Date | undefined
	agentId: string
	scope: MemoryScope
	scopeRef: string
	maxResults: number
	numCandidates: number
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
}): Promise<MemorySearchResult[]> {
	if (!isConversationEvidenceQuery(params.query, params.questionDate)) {
		return []
	}
	if (!params.capabilities.textSearch && !params.capabilities.vectorSearch) {
		if (isBenchmarkStrictMode()) {
			throw new Error(
				"conversation evidence search requires MongoDB Search or Vector Search capability in strict mode",
			)
		}
		return []
	}

	const events = eventsCollection(params.db, params.prefix)
	const vectorFilter: Document = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
	}
	if (params.questionDate && !Number.isNaN(params.questionDate.getTime())) {
		vectorFilter.timestamp = { $lte: params.questionDate }
	}

	const searchFilters = [
		buildSearchFilterEquals("agentId", params.agentId),
		buildSearchFilterEquals("scope", params.scope),
		buildSearchFilterEquals("scopeRef", params.scopeRef),
		params.questionDate && !Number.isNaN(params.questionDate.getTime())
			? {
					range: {
						path: "timestamp",
						lte: params.questionDate,
					},
				}
			: null,
	].filter((value): value is Document => Boolean(value))

	const searches: Array<Promise<MemorySearchResult[]>> = []
	if (
		params.capabilities.vectorSearch &&
		params.embeddingMode === "automated" &&
		// P3.2: these inline $vectorSearch pipelines bypass
		// buildVectorSearchStage, so they consume the per-request aggregation +
		// server-side embed budget here.
		tryConsumeSearchAggregation() &&
		tryConsumeSearchEmbed()
	) {
		const vectorPipeline: Document[] = [
			{
				$vectorSearch: {
					index: `${params.prefix}events_vector`,
					path: "body",
					query: { text: params.query },
					model: "voyage-4-large",
					filter: vectorFilter,
					numCandidates: params.numCandidates,
					limit: params.maxResults,
				},
			},
			{
				$project: {
					_id: 0,
					eventId: 1,
					body: 1,
					role: 1,
					sessionId: 1,
					timestamp: 1,
					scope: 1,
					scopeRef: 1,
					accessCount: 1,
					score: { $meta: "vectorSearchScore" },
				},
			},
		]
		searches.push(
			events
				// P3.8: user-driven $vectorSearch pipelines carry a maxTimeMS ceiling.
				.aggregate(vectorPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-vector"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}

	// P3.2: direct aggregates consume the per-request budget here.
	if (params.capabilities.textSearch && tryConsumeSearchAggregation()) {
		const should: Document[] = []
		if (params.questionDate && !Number.isNaN(params.questionDate.getTime())) {
			should.push({
				near: {
					path: "timestamp",
					origin: params.questionDate,
					pivot: 180 * 24 * 60 * 60 * 1000,
					score: { boost: { value: 2 } },
				},
			})
		}
		const textPipeline: Document[] = [
			{
				$search: {
					index: `${params.prefix}events_text`,
					compound: {
						filter: searchFilters,
						must: [{ text: { query: params.query, path: "body" } }],
						...(should.length > 0 ? { should } : {}),
					},
				},
			},
			{ $limit: params.maxResults },
			{
				$project: {
					_id: 0,
					eventId: 1,
					body: 1,
					role: 1,
					sessionId: 1,
					timestamp: 1,
					scope: 1,
					scopeRef: 1,
					accessCount: 1,
					score: { $meta: "searchScore" },
				},
			},
		]
		searches.push(
			events
				// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
				.aggregate(textPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-text"))
						.filter((result): result is MemorySearchResult => Boolean(result))
						.map((result) => ({
							...result,
							provenance: {
								...(result.provenance ?? {}),
								conversationEvidence: true,
							},
						})),
				),
		)
	}

	if (searches.length === 0) return []
	const results = await Promise.all(searches)
	return mergeTurnPrecisionResults(results)
		.map((result, index) => ({
			...result,
			score: Math.max(result.score, 1.1 - index * 0.01),
			sourceReliability: Math.max(result.sourceReliability ?? 0, 0.98),
			provenance: {
				...(result.provenance ?? {}),
				conversationEvidence: true,
			},
		}))
		.slice(0, params.maxResults)
}

// ---------------------------------------------------------------------------
// Result dedup utility — exported for testing and reuse
// ---------------------------------------------------------------------------

export function searchResultIdentityKey(result: MemorySearchResult): string {
	const canonicalId = result.canonicalId?.trim()
	if (canonicalId) return `canonical:${canonicalId}`
	const sourceEventIds = (result.sourceEventIds ?? [])
		.map((id) => id.trim())
		.filter(Boolean)
		.toSorted()
	if (sourceEventIds.length > 0) {
		return `events:${sourceEventIds.join("|")}`
	}
	const locator = [
		result.path || result.filePath || "",
		result.startLine ?? "",
		result.endLine ?? "",
		result.sessionId ?? "",
	]
		.map(String)
		.join(":")
	if (locator.replaceAll(":", "").trim().length > 0) {
		return `loc:${locator}`
	}
	return `snippet:${result.snippet}`
}

/**
 * Deduplicate search results by stable evidence identity.
 * Falls back to snippet text only when the result has no canonical id,
 * source event id, or locator.
 */
export function deduplicateSearchResults(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	if (results.length === 0) {
		return []
	}

	const seen = new Map<string, MemorySearchResult>()
	for (const result of results) {
		const key = searchResultIdentityKey(result)
		const existing = seen.get(key)
		if (!existing || result.score > existing.score) {
			seen.set(key, result)
		}
	}

	return Array.from(seen.values())
}

// ---------------------------------------------------------------------------
// Heuristic reranker
// ---------------------------------------------------------------------------

/**
 * Configurable weights for the heuristic reranker.
 */
export type RerankWeights = {
	/** Penalty per excess result from same source (default 0.15) */
	diversityWeight?: number
	/** Bonus for episode results (default 0.12) */
	episodeBoost?: number
}

/**
 * Heuristic reranker for v2 search results.
 * - Source diversity penalty: no more than 2 results from the same source at the top
 * - Episode priority boost: episode results get a score boost
 *
 * Does not mutate the original array.
 * Recency boost deferred (needs timestamp in MemorySearchResult interface).
 */
export function rerankResults(
	results: MemorySearchResult[],
	_query: string,
	weights?: RerankWeights,
): MemorySearchResult[] {
	if (results.length === 0) {
		return []
	}

	const diversityWeight = weights?.diversityWeight ?? 0.15
	const episodeBoost = weights?.episodeBoost ?? 0.12

	// Score each result (copy, don't mutate)
	const scored = results.map((r) => ({
		result: r,
		adjustedScore: r.score,
	}))

	// 1. Episode priority boost
	for (const entry of scored) {
		if (entry.result.path.startsWith("episode:")) {
			entry.adjustedScore += episodeBoost
		}
	}

	// 2. Sort by adjusted score descending
	scored.sort((a, b) => b.adjustedScore - a.adjustedScore)

	// 3. Source diversity penalty: penalize 3rd+ result from same source
	const sourceCounts = new Map<string, number>()
	for (const entry of scored) {
		const source = entry.result.source
		const count = (sourceCounts.get(source) ?? 0) + 1
		sourceCounts.set(source, count)
		if (count > 2) {
			entry.adjustedScore -= diversityWeight * (count - 2)
		}
	}

	// 4. Re-sort after diversity penalty
	scored.sort((a, b) => b.adjustedScore - a.adjustedScore)

	return scored.map((s) => s.result)
}

// ---------------------------------------------------------------------------
// Source policy helpers — exported for testing and reuse
// ---------------------------------------------------------------------------

type SourceConfig = {
	reference: { enabled: boolean }
	conversation: { enabled: boolean }
	structured: { enabled: boolean }
}

/**
 * Determine which search sources are active based on source policy config.
 * Reference (KB) search additionally requires KB to be enabled.
 */
export function getActiveSources(
	sources: SourceConfig | undefined,
	kbEnabled: boolean,
): { conversation: boolean; reference: boolean; structured: boolean } {
	if (!sources) {
		// Default: all sources enabled when no source config is present (backward compat)
		return { conversation: true, reference: kbEnabled, structured: true }
	}
	return {
		conversation: sources.conversation.enabled,
		reference: sources.reference.enabled && kbEnabled,
		structured: sources.structured.enabled,
	}
}

// ---------------------------------------------------------------------------
// searchDetailed helpers
// ---------------------------------------------------------------------------

/**
 * P2.8 defense-in-depth: the HTTP API clamps search limits at the route
 * layer, but non-API callers (MCP stdio, direct engine embedding, internal
 * fallbacks) can pass any maxResults. An unbounded result set blows up
 * fusion/rerank memory, so every public search entry point clamps to this
 * ceiling regardless of caller.
 */
export const MAX_SEARCH_MAX_RESULTS = 100

export function clampSearchMaxResults(value: number): number {
	if (!Number.isFinite(value)) {
		return MAX_SEARCH_MAX_RESULTS
	}
	return Math.max(1, Math.min(MAX_SEARCH_MAX_RESULTS, Math.floor(value)))
}

function normalizeDetailedSearchRequest(
	request: MemorySearchRequest,
): MemorySearchRequest {
	const query = request.query.trim()
	const configuredRequest = applySearchConfig({
		...request,
		query,
	})
	return {
		...configuredRequest,
		query,
		searchMode: configuredRequest.searchMode ?? "auto",
		maxResults: clampSearchMaxResults(configuredRequest.maxResults ?? 10),
		minScore: configuredRequest.minScore ?? 0.1,
		needExactEvidence: configuredRequest.needExactEvidence === true,
		returnPlan: configuredRequest.returnPlan === true,
		...(configuredRequest.maxPasses != null
			? {
					maxPasses: Math.max(1, Math.min(4, configuredRequest.maxPasses)),
				}
			: {}),
	}
}

function resolveRuntimeSearchConfig(
	request: MemorySearchRequest,
	mongoCfg: ResolvedMongoDBConfig,
): ResolvedSearchConfig {
	const resolved = resolveSearchConfig(request)
	const recallProfile =
		request.searchConfig?.recallProfile ??
		mongoCfg.recallProfile ??
		resolved.recallProfile
	const recommendedNumCandidates = Math.min(
		Math.max(mongoCfg.numCandidates, resolved.maxResults * 20),
		MONGODB_MAX_NUM_CANDIDATES,
	)
	const requestedNumCandidates =
		resolved.numCandidates ??
		request.searchConfig?.numCandidates ??
		recommendedNumCandidates
	return {
		recipe: resolved.recipe,
		recallProfile,
		maxResults: resolved.maxResults,
		searchMode: resolved.searchMode,
		maxPasses: resolved.maxPasses,
		sourcePreference: resolved.sourcePreference,
		timeRange: resolved.timeRange,
		needExactEvidence: resolved.needExactEvidence,
		numCandidates:
			resolveProfileNumCandidates({
				maxResults: resolved.maxResults,
				recallProfile,
				requested: requestedNumCandidates,
			}) ?? recommendedNumCandidates,
		fusionMethod: resolved.fusionMethod ?? mongoCfg.fusionMethod,
		hybridMode: resolved.hybridMode,
		allowHybridBackstop: resolved.allowHybridBackstop,
		lexicalPrefilter: resolved.lexicalPrefilter,
	}
}

function shouldUseDetailedSearchCache(request: MemorySearchRequest): boolean {
	const config = request.searchConfig
	if (!config) {
		return true
	}
	return (
		config.recipe === undefined &&
		(config.recallProfile === undefined ||
			config.recallProfile === "balanced") &&
		config.numCandidates === undefined &&
		config.fusionMethod === undefined &&
		config.hybridMode === undefined &&
		config.allowHybridBackstop === undefined &&
		config.lexicalPrefilter === undefined
	)
}

function emptySearchMetadata(
	request: MemorySearchRequest,
): MemorySearchMetadata {
	const resolvedSearchConfig = request.searchConfig
	return {
		mode: (request.searchMode ?? "auto") as MemorySearchMode,
		classification: "direct",
		sourceOrder: request.sourcePreference ?? [
			"conversation",
			"structured",
			"reference",
		],
		...(resolvedSearchConfig
			? {
					resolvedSearchConfig:
						resolvedSearchConfig as unknown as ResolvedSearchConfig,
				}
			: {}),
		passes: [],
		queriesTried: [],
		constraintsApplied: [],
		resultsRejected: [],
		evidenceCoverage: "none",
		pathsExecuted: [],
		resultsByPath: {},
		queryRewritten: false,
		reranked: false,
	}
}

function normalizeStructuredState(
	value: string | string[] | undefined,
): StructuredMemoryState | StructuredMemoryState[] | undefined {
	if (Array.isArray(value)) {
		const states = value.filter((state): state is StructuredMemoryState =>
			VALID_STRUCTURED_STATES.has(state as StructuredMemoryState),
		)
		return states.length > 0 ? states : undefined
	}
	if (
		typeof value === "string" &&
		VALID_STRUCTURED_STATES.has(value as StructuredMemoryState)
	) {
		return value as StructuredMemoryState
	}
	return undefined
}

function normalizeStructuredSalience(
	value: string[] | undefined,
): StructuredMemorySalience[] | undefined {
	if (!Array.isArray(value)) {
		return undefined
	}
	const salience = value.filter((entry): entry is StructuredMemorySalience =>
		VALID_STRUCTURED_SALIENCE.has(entry as StructuredMemorySalience),
	)
	return salience.length > 0 ? salience : undefined
}

function normalizeProcedureState(
	value: string | undefined,
): ProcedureState | undefined {
	if (
		typeof value === "string" &&
		VALID_PROCEDURE_STATES.has(value as ProcedureState)
	) {
		return value as ProcedureState
	}
	return undefined
}

/**
 * Return the list of active source names for status reporting.
 * Only sources that are actually enabled are included.
 */
export function getActiveSourcesForStatus(
	sources: SourceConfig | undefined,
	kbEnabled: boolean,
): MemorySource[] {
	const active = getActiveSources(sources, kbEnabled)
	const names: MemorySource[] = []
	if (active.conversation) {
		names.push("conversation")
	}
	if (active.reference) {
		names.push("reference")
	}
	if (active.structured) {
		names.push("structured")
	}
	return names
}

type ActiveSources = {
	conversation: boolean
	reference: boolean
	structured: boolean
}

/**
 * Resolve which sources to query in relevanceExplain based on the requested
 * sourceScope AND the active source policy. Disabled sources always return
 * false even when explicitly requested via sourceScope.
 */
export function resolveExplainSources(
	sourceScope: RelevanceSourceScope,
	activeSources: ActiveSources,
): ActiveSources {
	switch (sourceScope) {
		case "memory":
			return {
				conversation: activeSources.conversation,
				reference: false,
				structured: false,
			}
		case "kb":
			return {
				conversation: false,
				reference: activeSources.reference,
				structured: false,
			}
		case "structured":
			return {
				conversation: false,
				reference: false,
				structured: activeSources.structured,
			}
		case "all":
		default:
			return { ...activeSources }
	}
}

/** Type guard: checks if a MemorySearchManager supports structured memory writes (MongoDB backend). */
export function hasWriteCapability(
	manager: MemorySearchManager,
): manager is MongoDBMemoryManager {
	return "writeStructuredMemory" in manager
}

/** Type guard: checks if a MemorySearchManager supports relevance diagnostics. */
export function hasRelevanceCapability(
	manager: MemorySearchManager,
): manager is MongoDBMemoryManager {
	return "relevanceExplain" in manager
}

/** Redact credentials from a MongoDB connection string for safe logging. */
function redactMongoURI(uri: string): string {
	try {
		const parsed = new URL(uri)
		if (parsed.password) {
			parsed.password = "***"
		}
		if (parsed.username) {
			parsed.username = parsed.username.slice(0, 2) + "***"
		}
		return parsed.toString()
	} catch {
		// If URL parsing fails, do a simple regex-based redaction
		return uri.replace(/\/\/([^:]+):([^@]+)@/, "//***:***@")
	}
}

// ---------------------------------------------------------------------------
// MongoDBMemoryManager — implements MemorySearchManager for MongoDB backend
// ---------------------------------------------------------------------------

/**
 * Core runtime coordinator for the Memongo engine.
 *
 * The file is intentionally large today because it still hosts several stable
 * subsystems in one place:
 * - request normalization and search entrypoints
 * - planner and legacy search orchestration
 * - canonical event writes and derived memory projection
 * - workspace/session sync and health/status reporting
 *
 * Cleanup work should preserve those behavior boundaries even when code is
 * extracted into smaller modules later.
 */
/**
 * Build MongoClient options from the resolved mongodb config. Shared by the
 * per-manager connect path and the shared-client registry (P2.1).
 */
export function buildMongoClientOptions(
	mongoCfg: ResolvedMongoDBConfig,
): MongoClientOptions {
	const clientOptions: MongoClientOptions = {
		serverSelectionTimeoutMS: mongoCfg.serverSelectionTimeoutMs,
		connectTimeoutMS: mongoCfg.connectTimeoutMs,
		maxPoolSize: mongoCfg.maxPoolSize,
		minPoolSize: mongoCfg.minPoolSize,
	}
	if (mongoCfg.maxConnecting !== undefined) {
		clientOptions.maxConnecting = mongoCfg.maxConnecting
	}
	if (mongoCfg.maxIdleTimeMs !== undefined) {
		clientOptions.maxIdleTimeMS = mongoCfg.maxIdleTimeMs
	}
	if (mongoCfg.networkFamily !== undefined) {
		clientOptions.family = mongoCfg.networkFamily
	}
	if (mongoCfg.socketTimeoutMs !== undefined) {
		clientOptions.socketTimeoutMS = mongoCfg.socketTimeoutMs
	}
	if (mongoCfg.heartbeatFrequencyMs !== undefined) {
		clientOptions.heartbeatFrequencyMS = mongoCfg.heartbeatFrequencyMs
	}
	if (mongoCfg.serverMonitoringMode !== undefined) {
		clientOptions.serverMonitoringMode = mongoCfg.serverMonitoringMode
	}
	if (mongoCfg.waitQueueTimeoutMs !== undefined) {
		clientOptions.waitQueueTimeoutMS = mongoCfg.waitQueueTimeoutMs
	}
	return clientOptions
}

/**
 * Memory-job worker backstop sweep interval. Writes wake the worker
 * immediately (wake-on-write); the interval only catches missed wakes.
 * With the shared-client runtime on (P2.1) the default drops from a 1s poll
 * to a 30s backstop so idle managers issue ~0 claim polls. Flag-off behavior
 * is unchanged. MEMONGO_JOB_SWEEP_MS overrides both.
 */
const MEMORY_JOB_SWEEP_DEFAULT_MS = 30_000

export function resolveMemoryJobSweepMs(): number {
	const raw = process.env.MEMONGO_JOB_SWEEP_MS?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed)
		}
	}
	return isSharedMongoClientEnabled()
		? MEMORY_JOB_SWEEP_DEFAULT_MS
		: MEMORY_JOB_POLL_MS
}

/**
 * P3.9: how many extraction jobs the durable memory-job worker processes
 * concurrently per drain round (MEMONGO_JOB_WORKER_CONCURRENCY, default 3).
 * CAS claims (findOneAndUpdate) make concurrent claiming safe; lease fencing
 * inside the job runner is per-job and unchanged.
 */
const MEMORY_JOB_WORKER_CONCURRENCY_DEFAULT = 3
const MEMORY_JOB_WORKER_CONCURRENCY_MAX = 16

export function resolveMemoryJobWorkerConcurrency(): number {
	const raw = process.env.MEMONGO_JOB_WORKER_CONCURRENCY?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed >= 1) {
			return Math.min(Math.floor(parsed), MEMORY_JOB_WORKER_CONCURRENCY_MAX)
		}
	}
	return MEMORY_JOB_WORKER_CONCURRENCY_DEFAULT
}

/** Input shape shared by writeConversationEvent and its batch variant. */
export type WriteConversationEventInput = {
	role: "user" | "assistant" | "system" | "tool"
	body: string
	sessionId?: string
	timestamp?: Date
	validAt?: Date
	invalidAt?: Date
	metadata?: Record<string, unknown>
	scope?: MemoryScope
	scopeRef?: string
	/**
	 * Optional idempotency key: retries with the same key replay the
	 * original receipt (no duplicate event); reuse with a different
	 * payload is rejected with IdempotencyConflictError (422 upstream).
	 */
	idempotencyKey?: string
}

/**
 * P3.9 per-item batch receipt, mirroring the single-write receipt shape.
 * A replayed receipt reports chunkCreated:false (the chunk from the accepted
 * write already exists). A failed item never fails its siblings.
 */
export type WriteConversationEventReceipt =
	| { ok: true; eventId: string; chunkCreated: boolean; replayed?: boolean }
	| {
			ok: false
			code: "IDEMPOTENCY_CONFLICT" | "WRITE_ERROR"
			message: string
	  }

export class MongoDBMemoryManager implements MemorySearchManager {
	private readonly client: MongoClient
	private readonly db: Db
	private readonly prefix: string
	private readonly agentId: string
	private readonly workspaceDir: string
	private readonly agentScopeRef: string
	private readonly workspaceScopeRef: string
	private readonly extraMemoryPaths: string[]
	private readonly capabilities: DetectedCapabilities
	private nativeBitemporalVectorPrefilter: boolean
	private nativeBitemporalPrefilterCheckedAt = Date.now()
	private readonly config: ResolvedMemoryBackendConfig
	private syncing: Promise<void> | null = null
	private watcher: FSWatcher | null = null
	private watchTimer: NodeJS.Timeout | null = null
	private changeStreamWatcher: MongoDBChangeStreamWatcher | null = null
	/** Guards against a re-scan storm from rapid gapDetected events. */
	gapReSyncInFlight = false
	private relevance: MongoDBRelevanceRuntime | null = null
	/**
	 * P2.1: when the manager was built on a shared client (MEMONGO_SHARED_CLIENT),
	 * close() must not close the client — the process-level registry owns it.
	 */
	private readonly ownsClient: boolean
	/** Invoked once at the end of close() (used to release shared-client refs). */
	private readonly onClosed?: () => void
	private closed = false
	private dirty = true
	private fileCount = 0
	private chunkCount = 0
	private writeQueue: Promise<void> = Promise.resolve()
	private derivationSchedulingQueue: Promise<void> = Promise.resolve()
	private derivationQueue: Promise<void> = Promise.resolve()
	private readonly memoryJobWorkerId = `${process.pid}:${randomUUID()}`
	private memoryJobWorkerStopped = true
	private memoryJobWorkerActive = false
	private memoryJobWakeRequested = false
	private memoryJobWorkerPromise: Promise<void> = Promise.resolve()
	private memoryJobWorkerTimer: NodeJS.Timeout | null = null
	private memoryJobRunContexts = new Map<string, BenchmarkRunContext>()
	private lastSearchMode = "legacy"
	private lastSearchDetails: Record<string, unknown> | undefined
	private accessTracker: AccessTracker | null = null
	private benchmarkShippedProfile = false

	private constructor(params: {
		client: MongoClient
		db: Db
		prefix: string
		agentId: string
		workspaceDir: string
		extraMemoryPaths?: string[]
		capabilities: DetectedCapabilities
		nativeBitemporalVectorPrefilter: boolean
		config: ResolvedMemoryBackendConfig
		relevance?: MongoDBRelevanceRuntime | null
		ownsClient?: boolean
		onClosed?: () => void
	}) {
		this.client = params.client
		this.ownsClient = params.ownsClient ?? true
		this.onClosed = params.onClosed
		this.db = params.db
		this.prefix = params.prefix
		this.agentId = params.agentId
		this.workspaceDir = params.workspaceDir
		this.agentScopeRef = resolveScopeRef({
			scope: "agent",
			agentId: params.agentId,
		})
		this.workspaceScopeRef = resolveScopeRef({
			scope: "workspace",
			agentId: params.agentId,
			workspaceDir: params.workspaceDir,
		})
		this.extraMemoryPaths = params.extraMemoryPaths ?? []
		this.capabilities = params.capabilities
		this.nativeBitemporalVectorPrefilter =
			params.nativeBitemporalVectorPrefilter
		this.config = params.config
		this.relevance = params.relevance ?? null
	}

	// ---------------------------------------------------------------------------
	// Factory
	// ---------------------------------------------------------------------------

	static async create(params: {
		cfg: MemongoConfig
		agentId: string
		resolved: ResolvedMemoryBackendConfig
		extraPaths?: string[]
		/**
		 * P2.1: pre-connected shared MongoClient owned by the process-level
		 * registry (MEMONGO_SHARED_CLIENT). When provided, the manager skips
		 * connect and never closes the client.
		 */
		client?: MongoClient
		/** Invoked once when the manager finishes closing. */
		onClosed?: () => void
	}): Promise<MongoDBMemoryManager> {
		const mongoCfg = params.resolved.mongodb
		if (!mongoCfg) {
			throw new Error(
				"mongodb memory config missing from resolved backend config",
			)
		}

		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId)
		const safeUri = redactMongoURI(mongoCfg.uri)
		let client: MongoClient
		let ownsClient = true
		if (params.client) {
			log.info(
				`using shared MongoDB client: ${safeUri} (db=${mongoCfg.database})`,
			)
			client = params.client
			ownsClient = false
		} else {
			// Connect to MongoDB with a timeout to avoid hanging
			log.info(`connecting to MongoDB: ${safeUri} (db=${mongoCfg.database})`)
			client = new MongoClient(mongoCfg.uri, buildMongoClientOptions(mongoCfg))
			try {
				await client.connect()
				// Verify the connection actually works with a ping
				await client.db("admin").command({ ping: 1 })
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(`failed to connect to MongoDB (${safeUri}): ${msg}`)
				try {
					await client.close()
				} catch {
					// Ignore close errors during failed connect
				}
				throw new Error(`failed to connect to MongoDB (${safeUri}): ${msg}`)
			}
		}

		const db = client.db(mongoCfg.database)
		const prefix = mongoCfg.collectionPrefix

		// Ensure collections + schema validation + standard indexes
		await ensureCollections(db, prefix)

		const chunksCollectionName = chunksCollection(db, prefix).collectionName
		const searchIndexManagementAvailable =
			await isSearchIndexManagementAvailable(db, chunksCollectionName)

		await ensureStandardIndexes(db, prefix, {
			memoryTtlDays: mongoCfg.memoryTtlDays,
			relevanceRetentionDays: mongoCfg.relevance.retention.days,
			// P3.8: the BSON $text indexes are the no-mongot fallback — with
			// Search Index Management present the $search indexes serve every
			// text lane, so maintaining six $text duplicates is pure write
			// amplification.
			textFallbackIndexes: !searchIndexManagementAvailable,
		})

		// Detect concrete serving readiness. Fusion capability is server-version
		// based, while Search capabilities require named queryable indexes.
		let capabilities = await detectCapabilities(db, chunksCollectionName)
		log.info(`capabilities: ${JSON.stringify(capabilities)}`)
		let nativeBitemporalVectorPrefilter = false

		// Only bootstrap Search indexes when the deployment can talk to Search
		// Index Management at all. This keeps runtime startup responsive on
		// clusters that support fusion stages but do not expose mongot.
		if (searchIndexManagementAvailable) {
			const ensuredSearchIndexes = await ensureSearchIndexes(
				db,
				prefix,
				mongoCfg.deploymentProfile,
				mongoCfg.embeddingMode,
				mongoCfg.quantization,
				mongoCfg.numDimensions,
			)
			// P3.2: the quantization-on-autoEmbed rejection is a probe outcome
			// recorded during index creation — fold it into the capabilities so
			// the search paths see the adopted gate state (detectCapabilities ran
			// before the probe was recorded).
			capabilities = {
				...capabilities,
				capabilityGates: applyCapabilityProbeResult(
					capabilities.capabilityGates ?? {},
					"autoembed-quantization",
				),
			}
			if (ensuredSearchIndexes.text || ensuredSearchIndexes.vector) {
				const { timeoutMs: readinessTimeoutMs, pollMs: readinessPollMs } =
					resolveSearchIndexReadinessTiming()
				const readinessResults = await Promise.all(
					getExpectedSearchIndexTargets(prefix, mongoCfg.deploymentProfile).map(
						async (target) => {
							try {
								const readiness = await waitForSearchIndexesQueryable(
									db.collection(target.collectionName),
									{
										indexNames: target.indexNames,
										timeoutMs: readinessTimeoutMs,
										pollMs: readinessPollMs,
									},
								)
								return {
									collectionName: target.collectionName,
									...readiness,
								}
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err)
								return {
									collectionName: target.collectionName,
									ready: false,
									indexes: [],
									pending: target.indexNames,
									failed: [],
									lastError: message,
								}
							}
						},
					),
				)
				const stalled = readinessResults.filter((result) => !result.ready)
				const eventsVectorIndexes =
					readinessResults.find(
						(result) => result.collectionName === `${prefix}events`,
					)?.indexes ?? []
				try {
					nativeBitemporalVectorPrefilter =
						await isEventsVectorBitemporalPrefilterReady(
							eventsCollection(db, prefix),
							`${prefix}events_vector`,
							eventsVectorIndexes,
						)
					if (!nativeBitemporalVectorPrefilter) {
						log.warn(
							"native event bitemporal prefiltering remains disabled until the exact index definition and event representation are ready",
						)
					}
				} catch (err) {
					log.warn(
						`could not verify native event bitemporal prefilter readiness: ${String(err)}`,
					)
				}
				if (stalled.length > 0) {
					const summary = stalled
						.map((result) => {
							const pending = result.pending.join(",") || "none"
							const failed = result.failed.join(",") || "none"
							const lastError = result.lastError
								? ` lastError=${result.lastError}`
								: ""
							return `${result.collectionName} pending=[${pending}] failed=[${failed}]${lastError}`
						})
						.join("; ")
					const readinessMessage = `search indexes not fully queryable after bootstrap wait: ${summary}`
					if (isStrictSearchReadinessMode()) {
						throw new Error(readinessMessage)
					}
					log.warn(readinessMessage)
				}
				capabilities = await detectCapabilities(db, chunksCollectionName)
			}
		} else {
			log.info(
				"search index management unavailable; skipping search index bootstrap",
			)
		}
		if (
			isStrictSearchReadinessMode() &&
			(!capabilities.textSearch || !capabilities.vectorSearch)
		) {
			throw new Error(
				`MongoDB Search/vector capabilities are required in strict mode but named serving indexes are not queryable: ${JSON.stringify(capabilities)}`,
			)
		}
		if (
			isStrictSearchReadinessMode() &&
			capabilities.vectorSearch &&
			!nativeBitemporalVectorPrefilter
		) {
			throw new Error(
				"events vector index is not ready with validAt/invalidAt filters and null-compatible data",
			)
		}

		let relevance: MongoDBRelevanceRuntime | null = null
		try {
			if (mongoCfg.relevance.enabled) {
				relevance = new MongoDBRelevanceRuntime(
					db,
					prefix,
					params.agentId,
					mongoCfg,
					capabilities,
				)
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`relevance runtime initialization failed: ${msg}`)
		}

		const manager = new MongoDBMemoryManager({
			client,
			db,
			prefix,
			agentId: params.agentId,
			workspaceDir,
			extraMemoryPaths: normalizeExtraMemoryPaths(
				workspaceDir,
				params.extraPaths,
			),
			capabilities,
			nativeBitemporalVectorPrefilter,
			config: params.resolved,
			relevance,
			ownsClient,
			onClosed: params.onClosed,
		})

		// Phase 4.1 — the tracker now writes raw access events to the time-series
		// collection while keeping computed access summaries on canonical docs.
		manager.accessTracker = new AccessTracker(db, prefix, params.agentId, {
			flushThreshold: 50,
			flushIntervalMs: 5_000,
		})

		try {
			await manager.sync({ reason: "startup" })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`initial memory sync failed: ${msg}`)
		}
		try {
			const repaired = await manager.repairEventProjections()
			if (repaired.eventsProcessed > 0) {
				log.info(
					`repaired ${repaired.chunksCreated} chunks from ${repaired.eventsProcessed} canonical events during startup`,
				)
			}
		} catch (err) {
			log.warn(
				`startup projection repair failed; remaining canonical events will be retried on restart: ${String(err)}`,
			)
		}
		manager.startMemoryJobWorker()

		// Start watching bridge memory files for changes
		manager.ensureWatcher()

		// Opt-in: Change Streams for cross-instance sync (requires replica set)
		if (mongoCfg.enableChangeStreams) {
			const persistedResumeToken =
				await manager.loadPersistedChangeStreamResumeToken()
			const csWatcher = new MongoDBChangeStreamWatcher(
				chunksCollection(db, prefix),
				(event) => {
					if (event.gapDetected) {
						log.warn(
							`change stream gap detected (${event.gapDetected.from}); triggering full re-scan`,
						)
						// Debounce: dedupe concurrent gap-triggered syncs to avoid a
						// re-scan storm. If a sync is already in-flight, skip this one.
						if (!manager.gapReSyncInFlight) {
							manager.gapReSyncInFlight = true
							void manager
								.sync({ reason: "change-stream-gap" })
								.catch((err) => log.warn(`gap re-scan failed: ${String(err)}`))
								.finally(() => {
									manager.gapReSyncInFlight = false
								})
						}
						return // do NOT persist the stale token carried by the gap event
					}
					if (event.resumeToken !== undefined && event.resumeToken !== null) {
						void manager.persistChangeStreamResumeToken(event.resumeToken)
					}
				},
				mongoCfg.changeStreamDebounceMs,
			)
			let started = await csWatcher.start(persistedResumeToken ?? undefined)
			if (!started && persistedResumeToken) {
				log.warn(
					"change stream resume failed with persisted token; retrying from latest position",
				)
				started = await csWatcher.start()
				if (started) {
					await manager.clearPersistedChangeStreamResumeToken()
				}
			}
			if (started) {
				manager.changeStreamWatcher = csWatcher
				log.info("change stream watcher enabled for cross-instance sync")
			} else {
				log.info(
					"change streams not available — falling back to file watcher only",
				)
			}
		}

		log.info(
			`ready: profile=${mongoCfg.deploymentProfile} embedding=${mongoCfg.embeddingMode} ` +
				`fusion=${mongoCfg.fusionMethod} caps=${JSON.stringify(capabilities)}`,
		)

		return manager
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.search
	// ---------------------------------------------------------------------------

	/**
	 * P2.4: lazily created so Object.create-built test managers (which skip
	 * field initializers) get one on first write. Burst-coalesces the hot
	 * write path's cache invalidation: a quiet namespace invalidates
	 * immediately (leading), repeats inside the debounce window collapse
	 * into a single trailing scope-level delete.
	 */
	private queryCacheInvalidationCoalescer?: QueryCacheInvalidationCoalescer

	private scheduleQueryCacheInvalidation(params: {
		agentId: string
		scope: MemoryScope
		scopeRef: string
	}): void {
		if (!this.queryCacheInvalidationCoalescer) {
			this.queryCacheInvalidationCoalescer =
				new QueryCacheInvalidationCoalescer()
		}
		const coalescer = this.queryCacheInvalidationCoalescer
		coalescer.schedule(
			`${params.agentId}|${params.scope}|${params.scopeRef}`,
			() => {
				void invalidateQueryCache({
					db: this.db,
					prefix: this.prefix,
					agentId: params.agentId,
					scope: params.scope,
					scopeRef: params.scopeRef,
				})
			},
		)
	}

	/**
	 * Resolve the tenant identity a read must be confined to.
	 *
	 * Every read path resolves identity through here so that an absent `scope`
	 * can never degrade into "all scopes" — the filter builders below take
	 * `scope`/`scopeRef` as required arguments, and this is the only sanctioned
	 * way to produce them.
	 *
	 * P2.3: reads share the canonical identity rule with writes (explicit
	 * scope wins; sessionKey implies "session"); the only read-specific input
	 * is the P1.4 env-resolved fallback (MEMONGO_SEARCH_DEFAULT_SCOPE).
	 */
	private resolveSearchIdentity(opts?: {
		scope?: MemoryScope
		scopeRef?: string
		sessionKey?: string
	}): { scope: MemoryScope; scopeRef: string } {
		return resolveScopeIdentity({
			scope: opts?.scope,
			scopeRef: opts?.scopeRef,
			agentId: this.agentId,
			sessionId: opts?.sessionKey,
			workspaceDir: this.workspaceDir,
			defaultScope: resolveSearchDefaultScope(
				process.env.MEMONGO_SEARCH_DEFAULT_SCOPE,
			),
		})
	}

	private buildConversationChunkFilter(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document {
		const sources = ["conversation", "sessions"]
		const sessionMode = resolveSessionEvidenceMode(
			process.env.MEMONGO_SESSION_EVIDENCE_MODE,
		)
		if (sessionMode === "A") {
			sources.push("session-evidence")
		}
		const userfactMode = resolveUserfactEvidenceMode(
			process.env.MEMONGO_USERFACT_EVIDENCE_MODE,
			process.env.MEMONGO_PREFERENCE_EVIDENCE_MODE,
		)
		if (userfactMode === "enabled") {
			sources.push("userfact-evidence", "preference-evidence")
		}
		const enrichmentMode = resolveEnrichmentMode(
			process.env.MEMONGO_LLM_ENRICHMENT_MODE,
		)
		if (enrichmentMode === "enabled") {
			if (!sources.includes("userfact-evidence")) {
				sources.push("userfact-evidence")
			}
			sources.push("qa-evidence")
		} else if (enrichmentMode === "facts-only") {
			if (!sources.includes("userfact-evidence")) {
				sources.push("userfact-evidence")
			}
		}
		return {
			source: { $in: sources },
			agentId: this.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			status: { $ne: "deleted" },
		}
	}

	private buildBridgeChunkFilter(): Document {
		return {
			source: { $in: ["conversation", "memory"] },
			agentId: this.agentId,
			scope: "workspace",
			scopeRef: this.workspaceScopeRef,
			status: { $ne: "deleted" },
		}
	}

	/**
	 * Bridge notes live in the workspace namespace, so they are only readable by
	 * a caller whose own identity IS that workspace. Any other identity gets
	 * `undefined`, and the caller must skip the bridge lane entirely rather than
	 * search with no filter.
	 */
	private buildBridgeChunkFilterForIdentity(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document | undefined {
		if (
			params.scope !== "workspace" ||
			params.scopeRef !== this.workspaceScopeRef
		) {
			return undefined
		}
		return this.buildBridgeChunkFilter()
	}

	private buildScopeAwareBridgeChunkFilter(
		activeSources: ActiveSources,
		params: { scope: MemoryScope; scopeRef: string },
	): Document | undefined {
		if (!activeSources.conversation || isBenchmarkStrictMode()) {
			return undefined
		}
		return this.buildBridgeChunkFilterForIdentity(params)
	}

	private getBridgeChunkBudget(maxResults: number): number {
		// Bridge notes should remain searchable, but they are auxiliary to the
		// live runtime memory stream and should not monopolize the result budget.
		return Math.max(2, Math.ceil(maxResults / 3))
	}

	private buildV2AvailablePaths(
		activeSources: ActiveSources,
	): Set<RetrievalPath> {
		const mongoCfg = this.config.mongodb!
		const graphEnabled = mongoCfg.graph?.enabled !== false
		const episodesEnabled = mongoCfg.episodes?.enabled !== false
		const paths = new Set<RetrievalPath>()

		if (activeSources.structured) {
			paths.add("active-critical")
			paths.add("procedural")
			paths.add("structured")
		}
		if (activeSources.reference) {
			paths.add("kb")
		}
		if (activeSources.conversation) {
			paths.add("raw-window")
			paths.add("hybrid")
			if (graphEnabled) {
				paths.add("graph")
			}
			if (episodesEnabled) {
				paths.add("episodic")
			}
		}

		return paths
	}

	/**
	 * Record access for returned search results (fire-and-forget).
	 * Maps canonicalId prefixes to collection names for the AccessTracker.
	 */
	private recordSearchAccess(results: MemorySearchResult[]): void {
		if (!this.accessTracker || results.length === 0) return
		for (const result of results) {
			const cid = result.canonicalId
			if (!cid) continue
			const colonIdx = cid.indexOf(":")
			if (colonIdx < 0) continue
			const prefix = cid.slice(0, colonIdx)
			const id = cid.slice(colonIdx + 1)
			const collectionMap: Record<string, AccessEventCollection> = {
				event: "events",
				structured: "structured_mem",
				procedure: "procedures",
				episode: "episodes",
				relation: "relations",
				entity: "entities",
			}
			const collection = collectionMap[prefix]
			if (collection && id) {
				this.accessTracker.recordAccess(id, collection)
			}
		}
	}

	private setLastSearchMode(mode: string, details?: Record<string, unknown>) {
		this.lastSearchMode = mode
		this.lastSearchDetails = details
	}

	private async legacySearch(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
		},
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			return []
		}

		const mongoCfg = this.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 10)
		const minScore = opts?.minScore ?? 0.1
		const startedAt = Date.now()
		const sampled = this.relevance?.shouldSample() ?? false
		const explainArtifacts: RelevanceArtifact[] = []
		const traceEvents: SearchTraceEvent[] = []
		const explainOpts: SearchExplainOptions | undefined = sampled
			? {
					enabled: true,
					deep: false,
					includeScoreDetails: true,
					onArtifact: (artifact: SearchExplainTraceArtifact) => {
						explainArtifacts.push({
							artifactType: artifact.artifactType,
							summary: artifact.summary,
							rawExplain: artifact.rawExplain,
							compression: "none",
						})
					},
				}
			: undefined

		const queryVector: number[] | null = null
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const bridgeMaxResults = this.getBridgeChunkBudget(maxResults)
		const emptyResults: MemorySearchResult[] = []
		// The legacy path is a fallback for searchV2, so it must be confined to
		// exactly the same tenant identity searchV2 would have used. Resolving it
		// here (rather than passing `opts` through raw) is what keeps an absent
		// `scope` from widening the read to every scope under this agentId.
		const identity = this.resolveSearchIdentity(opts)
		const bridgeFilter = this.buildBridgeChunkFilterForIdentity(identity)
		const [
			runtimeConversationResults,
			bridgeConversationResults,
			kbResults,
			structuredResults,
		] = await Promise.all([
			!activeSources.conversation
				? emptyResults
				: mongoSearch(
						chunksCollection(this.db, this.prefix),
						cleaned,
						queryVector,
						{
							maxResults,
							minScore,
							numCandidates: mongoCfg.numCandidates,
							sessionKey: opts?.sessionKey,
							filter: this.buildConversationChunkFilter(identity),
							fusionMethod: mongoCfg.fusionMethod,
							capabilities: this.capabilities,
							vectorIndexName: `${this.prefix}chunks_vector`,
							textIndexName: `${this.prefix}chunks_text`,
							vectorWeight: 0.7,
							textWeight: 0.3,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
							onTrace: (event) => {
								traceEvents.push(event)
							},
						},
					),
			!activeSources.conversation || !bridgeFilter
				? emptyResults
				: mongoSearch(
						chunksCollection(this.db, this.prefix),
						cleaned,
						queryVector,
						{
							maxResults: bridgeMaxResults,
							minScore,
							numCandidates: mongoCfg.numCandidates,
							sessionKey: opts?.sessionKey,
							filter: bridgeFilter,
							fusionMethod: mongoCfg.fusionMethod,
							capabilities: this.capabilities,
							vectorIndexName: `${this.prefix}chunks_vector`,
							textIndexName: `${this.prefix}chunks_text`,
							vectorWeight: 0.7,
							textWeight: 0.3,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
							onTrace: (event) => {
								traceEvents.push(event)
							},
						},
					),
			!activeSources.reference
				? emptyResults
				: searchKB(
						kbChunksCollection(this.db, this.prefix),
						cleaned,
						queryVector,
						{
							maxResults: Math.max(3, Math.floor(maxResults / 3)),
							minScore,
							scopeRef: identity.scopeRef,
							numCandidates: mongoCfg.numCandidates,
							vectorIndexName: `${this.prefix}kb_chunks_vector`,
							textIndexName: `${this.prefix}kb_chunks_text`,
							capabilities: this.capabilities,
							embeddingMode: mongoCfg.embeddingMode,
							kbDocs: kbCollection(this.db, this.prefix),
							explain: explainOpts,
						},
					).catch((err) => {
						if (isBenchmarkStrictMode()) {
							throw err
						}
						log.warn(`KB search failed: ${String(err)}`)
						return [] as MemorySearchResult[]
					}),
			!activeSources.structured
				? emptyResults
				: searchStructuredMemory(
						structuredMemCollection(this.db, this.prefix),
						cleaned,
						queryVector,
						{
							maxResults: Math.max(3, Math.floor(maxResults / 3)),
							minScore,
							filter: {
								agentId: this.agentId,
								scope: identity.scope,
								scopeRef: identity.scopeRef,
							},
							numCandidates: mongoCfg.numCandidates,
							capabilities: this.capabilities,
							vectorIndexName: `${this.prefix}structured_mem_vector`,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
						},
					).catch((err) => {
						if (isBenchmarkStrictMode()) {
							throw err
						}
						log.warn(`structured memory search failed: ${String(err)}`)
						return [] as MemorySearchResult[]
					}),
		])

		const conversationResults = [
			...runtimeConversationResults,
			...bridgeConversationResults,
		]
		const legacyMethod: SearchMethod = this.resolveObservedSearchMethod(
			traceEvents,
			mongoCfg,
		)
		const normalizedLegacy = normalizeSearchResults(
			conversationResults,
			legacyMethod,
		)
		const normalizedKb = normalizeSearchResults(kbResults, "kb")
		const normalizedStructured = normalizeSearchResults(
			structuredResults,
			"structured",
		)

		const merged = [
			...normalizedLegacy,
			...normalizedKb,
			...normalizedStructured,
		].toSorted((a, b) => b.score - a.score)

		const deduped = deduplicateSearchResults(merged)
		const dedupCount = merged.length - deduped.length
		if (dedupCount > 0) {
			log.debug(`search dedup: removed ${dedupCount} duplicate result(s)`)
		}
		const finalResults = rerankResults(deduped, cleaned).slice(0, maxResults)
		const successfulTrace = [...traceEvents]
			.toReversed()
			.find((event) => event.ok)
		const fallbackPath =
			successfulTrace && successfulTrace.method !== mongoCfg.fusionMethod
				? `${mongoCfg.fusionMethod}->${successfulTrace.method}`
				: undefined
		const health =
			this.relevance?.evaluateHealth(finalResults, fallbackPath) ?? "ok"
		this.relevance?.recordSignal(finalResults, fallbackPath)

		if (sampled && this.relevance) {
			explainArtifacts.push({
				artifactType: "trace",
				summary: {
					requestedFusionMethod: mongoCfg.fusionMethod,
					fallbackPath,
					events: traceEvents,
					topScore: finalResults[0]?.score ?? 0,
					resultCount: finalResults.length,
				},
			})
			void this.relevance
				.persistRun({
					query: cleaned,
					sourceScope: "all",
					latencyMs: Date.now() - startedAt,
					topK: maxResults,
					hitSources: Array.from(
						new Set(finalResults.map((result) => result.source)),
					),
					fallbackPath,
					status: health,
					sampled,
					sampleRate: this.relevance.getSampleState().current,
					artifacts: explainArtifacts,
					diagnosticMode: false,
				})
				.catch((err) => {
					this.relevance?.logTelemetryFailure(err)
				})
		}

		this.recordSearchAccess(finalResults)
		return finalResults
	}

	async search(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
			questionDate?: Date
			/**
			 * #66: receives the per-lane latency breakdown of this call. A sink
			 * rather than instance state so concurrent searches (#67 scenario
			 * runner) cannot cross-attribute each other's lane timings.
			 */
			onLaneLatency?: (latencyByLane: Record<string, number>) => void
		},
		benchmarkRunContext?: BenchmarkRunContext,
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			this.setLastSearchMode("v2:empty-query")
			return []
		}

		const mongoCfg = this.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 10)
		const minScore = opts?.minScore ?? mongoCfg.reranking?.minScore ?? 0.01
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const availablePaths = this.buildV2AvailablePaths(activeSources)

		// P1.4 + P2.3: explicit scope wins; sessionKey implies "session";
		// otherwise MEMONGO_SEARCH_DEFAULT_SCOPE overrides the "agent" fallback
		// (single-user deployments). Same rule the write path applies.
		const { scope: searchScope, scopeRef: searchScopeRef } =
			this.resolveSearchIdentity({
				scope: opts?.scope,
				scopeRef: opts?.scopeRef,
				sessionKey: opts?.sessionKey,
			})

		// P2.4: stampede protection — concurrent identical searches share ONE
		// execution via an in-process single-flight keyed on the resolved
		// effective query (agent + identity + query + resolved params, the same
		// dimensions the query-cache key folds in). Benchmark runs measure
		// per-call latency, so they bypass coalescing.
		const searchBag = {
			cleaned,
			opts,
			mongoCfg,
			maxResults,
			minScore,
			activeSources,
			availablePaths,
			searchScope,
			searchScopeRef,
			benchmarkRunContext,
		}
		if (benchmarkRunContext) {
			return this.executeSearchUncoalesced(searchBag)
		}
		const flightKey = [
			this.agentId,
			searchScope,
			searchScopeRef,
			cleaned,
			maxResults,
			minScore,
			opts?.questionDate?.toISOString() ?? "",
		].join("")
		const { value } = await runSingleFlight(this, flightKey, () =>
			this.executeSearchUncoalesced(searchBag),
		)
		return value
	}

	private async executeSearchUncoalesced(params: {
		cleaned: string
		opts?: Parameters<MongoDBMemoryManager["search"]>[1]
		mongoCfg: ResolvedMongoDBConfig
		maxResults: number
		minScore: number
		activeSources: ActiveSources
		availablePaths: Set<RetrievalPath>
		searchScope: MemoryScope
		searchScopeRef: string
		benchmarkRunContext?: BenchmarkRunContext
	}): Promise<MemorySearchResult[]> {
		const {
			cleaned,
			opts,
			mongoCfg,
			maxResults,
			minScore,
			activeSources,
			availablePaths,
			searchScope,
			searchScopeRef,
			benchmarkRunContext,
		} = params

		// #66: measurement only — cost of the phases of this call that sit
		// outside searchV2's lanes. Merged into the lane breakdown before it
		// reaches the caller's sink.
		const phaseLatency: Record<string, number> = {}

		// Cache check: BEFORE search pipeline
		if (mongoCfg.cache.enabled) {
			const cacheCheckStartedAt = Date.now()
			const cacheResult = await checkCache({
				db: this.db,
				prefix: this.prefix,
				query: cleaned,
				agentId: this.agentId,
				scope: searchScope,
				scopeRef: searchScopeRef,
				config: mongoCfg.cache,
				// P2.4: resolved (post-default) params fold into the cache key, so
				// a cached page can never serve a different parameterization.
				keyParams: {
					maxResults,
					minScore,
					...(opts?.questionDate ? { questionDate: opts.questionDate } : {}),
				},
			})
			phaseLatency["phase:cache-check"] = Date.now() - cacheCheckStartedAt
			if (cacheResult.latency) {
				phaseLatency["phase:cache-exact"] = cacheResult.latency.exactMs
				phaseLatency["phase:cache-semantic"] = cacheResult.latency.semanticMs
			}
			if (cacheResult.hit) {
				this.setLastSearchMode(`v2:cache:${cacheResult.tier}`, {
					pathUsed: cacheResult.pathUsed,
					sourceScope: cacheResult.sourceScope,
				})
				const cachedPaths = cacheResult.pathUsed
					? cacheResult.pathUsed.split(",").filter(Boolean)
					: []
				void recordRecallTrace({
					db: this.db,
					prefix: this.prefix,
					trace: {
						agentId: this.agentId,
						query: cleaned,
						lanesUsed: cachedPaths,
						lanesSkipped: Array.from(availablePaths).filter(
							(path) => !cachedPaths.includes(path),
						),
						totalHits: cacheResult.results.length,
						latencyMs: 0,
						hitsByLane: Object.fromEntries(
							cachedPaths.map((path) => [path, 0]),
						),
						topHitIds: cacheResult.results
							.map((result) => result.canonicalId ?? result.path)
							.slice(0, 5),
					},
				}).catch((err) =>
					log.warn(
						`search recall trace write failed on cache hit: ${String(err)}`,
					),
				)
				return cacheResult.results
			}
		}

		const searchStart = Date.now()
		let laneLatency: Record<string, number> = {}
		try {
			const v2 = await searchV2(this.db, this.prefix, cleaned, this.agentId, {
				availablePaths,
				hasEpisodes: mongoCfg.episodes.enabled,
				hasGraphData: mongoCfg.graph.enabled,
				maxResults,
				searchOptions: {
					minScore,
					sessionKey: opts?.sessionKey,
					numCandidates: mongoCfg.numCandidates,
					capabilities: this.capabilities,
					fusionMethod: mongoCfg.fusionMethod,
					embeddingMode: mongoCfg.embeddingMode,
					graphMaxDepth: mongoCfg.graph.maxGraphDepth,
					conversationFilter: this.buildConversationChunkFilter({
						scope: searchScope,
						scopeRef: searchScopeRef,
					}),
					bridgeFilter: this.buildScopeAwareBridgeChunkFilter(activeSources, {
						scope: searchScope,
						scopeRef: searchScopeRef,
					}),
					bridgeMaxResults: this.getBridgeChunkBudget(maxResults),
					scope: searchScope,
					scopeRef: searchScopeRef,
					rerankConfig: mongoCfg.reranking,
					queryRewriteConfig: mongoCfg.queryRewriting,
					questionDate: opts?.questionDate,
					budget: mongoCfg.searchBudget,
					...(benchmarkRunContext ? { benchmarkRunContext } : {}),
				},
			})

			// Emit search telemetry (fire-and-forget)
			emitTelemetry(this.db, this.prefix, {
				meta: { agentId: this.agentId, operation: "search" },
				durationMs: Date.now() - searchStart,
				ok: v2.results.length > 0,
				pathUsed: v2.metadata.pathsExecuted.join(","),
				resultCount: v2.results.length,
				topScore: v2.results[0]?.score ?? 0,
				fusionMethod: mongoCfg.fusionMethod,
			})
			const latencyMs = Date.now() - searchStart
			const latencyByLane = v2.metadata.latencyByPath ?? {}
			laneLatency = latencyByLane

			const v2Details = {
				plan: v2.metadata.plan.paths,
				confidence: v2.metadata.plan.confidence,
				constraints: v2.metadata.plan.constraints,
				pathsExecuted: v2.metadata.pathsExecuted,
				resultsByPath: v2.metadata.resultsByPath,
			}

			if (v2.results.length > 0) {
				this.setLastSearchMode("v2", v2Details)
				void recordRecallTrace({
					db: this.db,
					prefix: this.prefix,
					trace: {
						agentId: this.agentId,
						query: cleaned,
						lanesUsed: v2.metadata.pathsExecuted,
						lanesSkipped: Array.from(availablePaths).filter(
							(path) => !v2.metadata.pathsExecuted.includes(path),
						),
						totalHits: v2.results.length,
						latencyMs,
						hitsByLane: v2.metadata.resultsByPath,
						latencyByLane,
						topHitIds: v2.results
							.map((result) => result.canonicalId ?? result.path)
							.slice(0, 5),
					},
				}).catch((err) =>
					log.warn(`search recall trace write failed: ${String(err)}`),
				)
				// Fire-and-forget cache write
				if (mongoCfg.cache.enabled) {
					// H4 audit fix: derive TTL from actual paths executed (not static config)
					const hasKbPath = v2.metadata.pathsExecuted.includes("kb")
					const ttlSec = hasKbPath
						? mongoCfg.cache.kbTtlSec
						: mongoCfg.cache.conversationTtlSec
					// #66: writeCache is fire-and-forget, so this span bounds only the
					// synchronous dispatch the search path actually pays for.
					const cacheWriteStartedAt = Date.now()
					writeCache({
						db: this.db,
						prefix: this.prefix,
						query: cleaned,
						agentId: this.agentId,
						scope: searchScope,
						scopeRef: searchScopeRef,
						results: v2.results,
						pathUsed: v2.metadata.pathsExecuted.join(","),
						sourceScope: "conversation",
						ttlSec,
						// P2.4: same resolved params as the checkCache seam above.
						keyParams: {
							maxResults,
							minScore,
							...(opts?.questionDate
								? { questionDate: opts.questionDate }
								: {}),
						},
					})
					phaseLatency["phase:cache-write"] = Date.now() - cacheWriteStartedAt
				}
				this.recordSearchAccess(v2.results)
				return v2.results
			}

			void recordRecallTrace({
				db: this.db,
				prefix: this.prefix,
				trace: {
					agentId: this.agentId,
					query: cleaned,
					lanesUsed: v2.metadata.pathsExecuted,
					lanesSkipped: Array.from(availablePaths).filter(
						(path) => !v2.metadata.pathsExecuted.includes(path),
					),
					totalHits: 0,
					latencyMs,
					hitsByLane: v2.metadata.resultsByPath,
					latencyByLane,
					topHitIds: [],
				},
			}).catch((err) =>
				log.warn(`empty search recall trace write failed: ${String(err)}`),
			)
			if (isBenchmarkStrictMode()) {
				throw new Error(
					`searchV2 returned no results; legacy fallback disabled; paths=${v2.metadata.pathsExecuted.join(",") || "none"} hitsByLane=${JSON.stringify(v2.metadata.resultsByPath)}`,
				)
			}
			// P3.2: the legacySearch re-run is opt-in (empty ≠ error — the v2
			// empty answer stands unless the deployment asks for the double
			// retrieval via memory.mongodb.legacySearchFallback).
			if (!mongoCfg.legacySearchFallback) {
				this.setLastSearchMode("v2:empty", v2Details)
				return []
			}
			const fallbackResults = await this.legacySearch(cleaned, opts)
			this.setLastSearchMode("v2->legacy-empty", {
				...v2Details,
				fallbackResults: fallbackResults.length,
			})
			void recordRecallTrace({
				db: this.db,
				prefix: this.prefix,
				trace: {
					agentId: this.agentId,
					query: cleaned,
					lanesUsed: ["legacy"],
					lanesSkipped: Array.from(availablePaths),
					totalHits: fallbackResults.length,
					latencyMs,
					hitsByLane: { legacy: fallbackResults.length },
					topHitIds: fallbackResults
						.map((result) => result.canonicalId ?? result.path)
						.slice(0, 5),
				},
			}).catch((err) =>
				log.warn(`search fallback recall trace write failed: ${String(err)}`),
			)
			return fallbackResults
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (isBenchmarkStrictMode()) {
				throw new Error(
					`planner search failed; legacy fallback disabled: ${message}`,
				)
			}
			log.warn(
				`planner search failed, falling back to legacy search: ${message}`,
			)
			// P3.2: legacySearch re-run is opt-in (see the empty-result site).
			if (!mongoCfg.legacySearchFallback) {
				this.setLastSearchMode("v2:error", { error: message })
				return []
			}
			const fallbackResults = await this.legacySearch(cleaned, opts)
			this.setLastSearchMode("v2->legacy-error", {
				error: message,
				fallbackResults: fallbackResults.length,
			})
			void recordRecallTrace({
				db: this.db,
				prefix: this.prefix,
				trace: {
					agentId: this.agentId,
					query: cleaned,
					lanesUsed: ["legacy"],
					lanesSkipped: Array.from(availablePaths),
					totalHits: fallbackResults.length,
					latencyMs: Date.now() - searchStart,
					hitsByLane: { legacy: fallbackResults.length },
					topHitIds: fallbackResults
						.map((result) => result.canonicalId ?? result.path)
						.slice(0, 5),
				},
			}).catch((traceErr) =>
				log.warn(
					`search error fallback recall trace write failed: ${String(traceErr)}`,
				),
			)
			return fallbackResults
		} finally {
			// #66: `phase:total` is anchored on searchStart, so every span
			// subtracted here sits inside it. The cache check runs before
			// searchStart and is therefore reported alongside, not inside, total.
			phaseLatency["phase:total"] = Date.now() - searchStart
			const measuredInsideTotal =
				(laneLatency["phase:plan"] ?? 0) +
				(laneLatency["phase:lanes"] ?? 0) +
				(laneLatency["phase:rewrite"] ?? 0) +
				(laneLatency["phase:rerank"] ?? 0) +
				(phaseLatency["phase:cache-write"] ?? 0)
			phaseLatency["phase:unaccounted"] = Math.max(
				0,
				phaseLatency["phase:total"] - measuredInsideTotal,
			)
			opts?.onLaneLatency?.({ ...laneLatency, ...phaseLatency })
		}
	}

	async searchDetailed(
		request: MemorySearchRequest,
	): Promise<MemorySearchResponse> {
		const normalized = normalizeDetailedSearchRequest(request)
		if (!normalized.query) {
			this.setLastSearchMode("v2:empty-query")
			return {
				results: [],
				metadata: emptySearchMetadata(normalized),
			}
		}

		const mongoCfg = this.config.mongodb!
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const availablePaths = this.buildV2AvailablePaths(activeSources)
		// P1.4 + P2.3: same identity rule as search() and the write path.
		const { scope: searchScope, scopeRef: searchScopeRef } =
			this.resolveSearchIdentity({
				scope: normalized.scope,
				scopeRef: normalized.scopeRef,
				sessionKey: normalized.conversationScope?.sessionKey,
			})

		const executorRequest = normalizeMemorySearchRequest(normalized)
		const executorTimeRange = resolveExecutorTimeRange(executorRequest)
		const resolvedSearchConfig = resolveRuntimeSearchConfig(
			executorRequest,
			mongoCfg,
		)
		const canUseDetailedSearchCache =
			mongoCfg.cache.enabled && shouldUseDetailedSearchCache(executorRequest)

		// Cache check
		if (canUseDetailedSearchCache) {
			const cacheResult = await checkCache({
				db: this.db,
				prefix: this.prefix,
				query: normalized.query,
				agentId: this.agentId,
				scope: searchScope,
				scopeRef: searchScopeRef,
				config: mongoCfg.cache,
				// P2.4: resolved (post-default) params fold into the cache key.
				keyParams: {
					maxResults: resolvedSearchConfig.maxResults,
					minScore: normalized.minScore ?? 0.1,
					...(normalized.timeRange ? { timeRange: normalized.timeRange } : {}),
				},
			})
			if (cacheResult.hit) {
				this.setLastSearchMode(`v2:cache:${cacheResult.tier}`, {
					pathUsed: cacheResult.pathUsed,
					sourceScope: cacheResult.sourceScope,
				})
				const filteredCache = applyHardConstraintRejections({
					results: cacheResult.results,
					request: executorRequest,
					...(executorTimeRange ? { timeRange: executorTimeRange } : {}),
				})
				if (filteredCache.accepted.length === cacheResult.results.length) {
					const classification = classifyExecutorSearch(executorRequest)
					const cachedPaths = cacheResult.pathUsed
						? cacheResult.pathUsed.split(",").filter(Boolean)
						: []
					const plannedPasses = buildExecutorPasses(
						executorRequest,
						classification,
					).map((pass, index) => ({
						pass: pass.pass,
						query: pass.query,
						reason: index === 0 ? `${pass.reason} (cache hit)` : pass.reason,
						pathsExecuted: index === 0 ? cachedPaths : [],
						resultCount: index === 0 ? filteredCache.accepted.length : 0,
						queryRewritten: false,
						reranked: false,
					}))
					const trustedCacheResults = annotateResultsWithTrust(
						filteredCache.accepted,
						{
							scope: searchScope,
							scopeRef: searchScopeRef,
							sessionKey: normalized.conversationScope?.sessionKey,
						},
					)
					return {
						results: trustedCacheResults,
						metadata: {
							...emptySearchMetadata(normalized),
							classification,
							resolvedSearchConfig,
							passes: plannedPasses,
							queriesTried: plannedPasses.map((pass) => pass.query),
							constraintsApplied: [
								...buildConstraintSummaries(executorRequest),
								...(requestHasHardConstraints(normalized)
									? ["cache-hit-constrained"]
									: []),
							],
							evidenceCoverage: computeEvidenceCoverage(trustedCacheResults),
							pathsExecuted: cachedPaths,
							trustSummary: summarizeTrust(trustedCacheResults),
						},
					}
				}
			}
		}

		const searchStart = Date.now()
		const response = await executeMongoSearchPlan({
			request: normalized,
			availablePaths,
			executePass: async ({
				query: passQuery,
				availablePaths: passPaths,
				timeRange,
			}) =>
				searchV2(this.db, this.prefix, passQuery, this.agentId, {
					availablePaths: passPaths,
					hasEpisodes: mongoCfg.episodes.enabled,
					hasGraphData: mongoCfg.graph.enabled,
					maxResults: resolvedSearchConfig.maxResults,
					searchOptions: {
						minScore: normalized.minScore ?? 0.1,
						sessionKey: normalized.conversationScope?.sessionKey,
						numCandidates: resolvedSearchConfig.numCandidates,
						capabilities: this.capabilities,
						fusionMethod: resolvedSearchConfig.fusionMethod,
						embeddingMode: mongoCfg.embeddingMode,
						graphMaxDepth: mongoCfg.graph.maxGraphDepth,
						conversationFilter: this.buildConversationChunkFilter({
							scope: searchScope,
							scopeRef: searchScopeRef,
						}),
						bridgeFilter: this.buildScopeAwareBridgeChunkFilter(activeSources, {
							scope: searchScope,
							scopeRef: searchScopeRef,
						}),
						bridgeMaxResults: this.getBridgeChunkBudget(
							resolvedSearchConfig.maxResults,
						),
						scope: searchScope,
						scopeRef: searchScopeRef,
						allowHybridBackstop: resolvedSearchConfig.allowHybridBackstop,
						sourcePreference: normalized.sourcePreference,
						needExactEvidence: normalized.needExactEvidence,
						timeRange: normalized.timeRange,
						conversationScope: normalized.conversationScope,
						structuredScope: normalized.structuredScope,
						referenceScope: normalized.referenceScope,
						proceduralScope: normalized.proceduralScope,
						rerankConfig: mongoCfg.reranking,
						queryRewriteConfig: mongoCfg.queryRewriting,
						searchConfig: resolvedSearchConfig,
						budget: mongoCfg.searchBudget,
					},
				}),
			trustContext: {
				scope: searchScope,
				scopeRef: searchScopeRef,
			},
		})
		response.metadata.resolvedSearchConfig = resolvedSearchConfig

		emitTelemetry(this.db, this.prefix, {
			meta: { agentId: this.agentId, operation: "search" },
			durationMs: Date.now() - searchStart,
			ok: response.results.length > 0,
			pathUsed: response.metadata.pathsExecuted.join(","),
			resultCount: response.results.length,
			topScore: response.results[0]?.score ?? 0,
			fusionMethod: resolvedSearchConfig.fusionMethod,
		})
		const latencyMs = Date.now() - searchStart
		void recordRecallTrace({
			db: this.db,
			prefix: this.prefix,
			trace: {
				agentId: this.agentId,
				query: normalized.query,
				lanesUsed: response.metadata.pathsExecuted,
				lanesSkipped: Array.from(availablePaths).filter(
					(path) => !response.metadata.pathsExecuted.includes(path),
				),
				totalHits: response.results.length,
				latencyMs,
				hitsByLane: response.metadata.resultsByPath,
				topHitIds: response.results
					.map((result) => result.canonicalId ?? result.path)
					.slice(0, 5),
			},
		}).catch((err) =>
			log.warn(`searchDetailed recall trace write failed: ${String(err)}`),
		)

		const v2Details = {
			classification: response.metadata.classification,
			sourceOrder: response.metadata.sourceOrder,
			resolvedSearchConfig: response.metadata.resolvedSearchConfig,
			constraintsApplied: response.metadata.constraintsApplied,
			pathsExecuted: response.metadata.pathsExecuted,
			resultsByPath: response.metadata.resultsByPath,
			evidenceCoverage: response.metadata.evidenceCoverage,
		}

		if (response.results.length > 0) {
			this.setLastSearchMode("v2", v2Details)
			this.recordSearchAccess(response.results)
			if (canUseDetailedSearchCache) {
				const hasKbPath = response.metadata.pathsExecuted.includes("kb")
				const ttlSec = hasKbPath
					? mongoCfg.cache.kbTtlSec
					: mongoCfg.cache.conversationTtlSec
				writeCache({
					db: this.db,
					prefix: this.prefix,
					query: normalized.query,
					agentId: this.agentId,
					scope: searchScope,
					scopeRef: searchScopeRef,
					results: response.results,
					pathUsed: response.metadata.pathsExecuted.join(","),
					sourceScope: "conversation",
					ttlSec,
					// P2.4: same resolved params as the checkCache seam above.
					keyParams: {
						maxResults: resolvedSearchConfig.maxResults,
						minScore: normalized.minScore ?? 0.1,
						...(normalized.timeRange
							? { timeRange: normalized.timeRange }
							: {}),
					},
				})
			}
			return response
		}

		if (requestHasHardConstraints(normalized)) {
			this.setLastSearchMode("v2:constrained-empty", v2Details)
			return response
		}

		// P3.2: legacySearch re-run is opt-in (see the search() sites).
		if (!mongoCfg.legacySearchFallback) {
			this.setLastSearchMode("v2:empty", v2Details)
			return response
		}
		const fallbackResults = await this.legacySearch(normalized.query, {
			maxResults: normalized.maxResults,
			minScore: normalized.minScore,
			sessionKey: normalized.conversationScope?.sessionKey,
			scope: searchScope,
			scopeRef: searchScopeRef,
		})
		this.setLastSearchMode("v2->legacy-empty", {
			...v2Details,
			fallbackResults: fallbackResults.length,
		})
		return {
			results: fallbackResults,
			metadata: {
				...response.metadata,
				pathsExecuted: response.metadata.pathsExecuted.length
					? response.metadata.pathsExecuted
					: ["legacy"],
			},
		}
	}

	async relevanceExplain(params: {
		query: string
		sourceScope?: RelevanceSourceScope
		sessionKey?: string
		maxResults?: number
		minScore?: number
		deep?: boolean
		questionDate?: Date
	}): Promise<RelevanceExplainResult> {
		if (!this.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		const sourceScope = params.sourceScope ?? "all"
		const maxResults = params.maxResults ?? 10
		const minScore = params.minScore ?? 0.1
		const startedAt = Date.now()
		const query = params.query.trim()
		if (!query) {
			return {
				latencyMs: 0,
				sourceScope,
				health: "insufficient-data",
				sampleRate: this.relevance.getSampleState().current,
				artifacts: [],
				results: [],
			}
		}

		const queryVector: number[] | null = null
		const mongoCfg = this.config.mongodb!

		const artifacts: RelevanceArtifact[] = []
		const traces: SearchTraceEvent[] = []
		const explainOpts: SearchExplainOptions = {
			enabled: true,
			deep: Boolean(params.deep),
			includeScoreDetails: true,
			onArtifact: (artifact) => {
				artifacts.push({
					artifactType: artifact.artifactType,
					summary: artifact.summary,
					rawExplain: artifact.rawExplain,
					compression: "none",
				})
			},
		}

		// Source policy enforcement: disabled sources return empty results even when
		// explicitly requested via sourceScope (matches search() behavior).
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const explainSources = resolveExplainSources(sourceScope, activeSources)
		const bridgeMaxResults = this.getBridgeChunkBudget(maxResults)
		const emptyResults: MemorySearchResult[] = []
		// relevanceExplain is a diagnostic view of what search() would return, so
		// it resolves the same identity from the same inputs and must never read
		// wider than the search path it is explaining.
		const identity = this.resolveSearchIdentity({
			sessionKey: params.sessionKey,
		})
		const bridgeFilter = this.buildBridgeChunkFilterForIdentity(identity)

		let mergedResults: MemorySearchResult[] = []
		if (sourceScope === "memory") {
			if (!explainSources.conversation) {
				mergedResults = emptyResults
			} else {
				const [runtimeHits, bridgeHits] = await Promise.all([
					mongoSearch(
						chunksCollection(this.db, this.prefix),
						query,
						queryVector,
						{
							maxResults: bridgeMaxResults,
							minScore,
							numCandidates: mongoCfg.numCandidates,
							sessionKey: params.sessionKey,
							filter: this.buildConversationChunkFilter(identity),
							fusionMethod: mongoCfg.fusionMethod,
							capabilities: this.capabilities,
							vectorIndexName: `${this.prefix}chunks_vector`,
							textIndexName: `${this.prefix}chunks_text`,
							vectorWeight: 0.7,
							textWeight: 0.3,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
							onTrace: (event) => traces.push(event),
						},
					),
					!bridgeFilter
						? emptyResults
						: mongoSearch(
								chunksCollection(this.db, this.prefix),
								query,
								queryVector,
								{
									maxResults,
									minScore,
									numCandidates: mongoCfg.numCandidates,
									sessionKey: params.sessionKey,
									filter: bridgeFilter,
									fusionMethod: mongoCfg.fusionMethod,
									capabilities: this.capabilities,
									vectorIndexName: `${this.prefix}chunks_vector`,
									textIndexName: `${this.prefix}chunks_text`,
									vectorWeight: 0.7,
									textWeight: 0.3,
									embeddingMode: mongoCfg.embeddingMode,
									explain: explainOpts,
									onTrace: (event) => traces.push(event),
								},
							),
				])
				const legacyMethod: SearchMethod = this.resolveObservedSearchMethod(
					traces,
					mongoCfg,
				)
				const normalizedRuntime = normalizeSearchResults(
					runtimeHits,
					legacyMethod,
				)
				const normalizedBridge = normalizeSearchResults(
					bridgeHits,
					legacyMethod,
				)
				mergedResults = applyPostRetrievalScoring(
					query,
					rerankResults(
						deduplicateSearchResults(
							[...normalizedRuntime, ...normalizedBridge].toSorted(
								(a, b) => b.score - a.score,
							),
						),
						query,
					),
					{ questionDate: params.questionDate },
				).slice(0, maxResults)
			}
		} else if (sourceScope === "kb") {
			mergedResults = !explainSources.reference
				? emptyResults
				: await searchKB(
						kbChunksCollection(this.db, this.prefix),
						query,
						queryVector,
						{
							maxResults,
							minScore,
							scopeRef: identity.scopeRef,
							numCandidates: mongoCfg.numCandidates,
							vectorIndexName: `${this.prefix}kb_chunks_vector`,
							textIndexName: `${this.prefix}kb_chunks_text`,
							capabilities: this.capabilities,
							embeddingMode: mongoCfg.embeddingMode,
							kbDocs: kbCollection(this.db, this.prefix),
							explain: explainOpts,
						},
					)
		} else if (sourceScope === "structured") {
			mergedResults = !explainSources.structured
				? emptyResults
				: await searchStructuredMemory(
						structuredMemCollection(this.db, this.prefix),
						query,
						queryVector,
						{
							maxResults,
							minScore,
							filter: {
								agentId: this.agentId,
								scope: identity.scope,
								scopeRef: identity.scopeRef,
							},
							numCandidates: mongoCfg.numCandidates,
							capabilities: this.capabilities,
							vectorIndexName: `${this.prefix}structured_mem_vector`,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
						},
					)
		} else {
			const [
				runtimeConversationResults,
				bridgeConversationResults,
				kbResults,
				structuredResults,
			] = await Promise.all([
				// Runtime conversation chunks — skip if conversation source is disabled
				!explainSources.conversation
					? emptyResults
					: mongoSearch(
							chunksCollection(this.db, this.prefix),
							query,
							queryVector,
							{
								maxResults,
								minScore,
								numCandidates: mongoCfg.numCandidates,
								sessionKey: params.sessionKey,
								filter: this.buildConversationChunkFilter(identity),
								fusionMethod: mongoCfg.fusionMethod,
								capabilities: this.capabilities,
								vectorIndexName: `${this.prefix}chunks_vector`,
								textIndexName: `${this.prefix}chunks_text`,
								vectorWeight: 0.7,
								textWeight: 0.3,
								embeddingMode: mongoCfg.embeddingMode,
								explain: explainOpts,
								onTrace: (event) => traces.push(event),
							},
						),
				// Bridge-note chunks — same collection, different namespace filter
				!explainSources.conversation || !bridgeFilter
					? emptyResults
					: mongoSearch(
							chunksCollection(this.db, this.prefix),
							query,
							queryVector,
							{
								maxResults: bridgeMaxResults,
								minScore,
								numCandidates: mongoCfg.numCandidates,
								sessionKey: params.sessionKey,
								filter: bridgeFilter,
								fusionMethod: mongoCfg.fusionMethod,
								capabilities: this.capabilities,
								vectorIndexName: `${this.prefix}chunks_vector`,
								textIndexName: `${this.prefix}chunks_text`,
								vectorWeight: 0.7,
								textWeight: 0.3,
								embeddingMode: mongoCfg.embeddingMode,
								explain: explainOpts,
								onTrace: (event) => traces.push(event),
							},
						),
				// KB chunks — skip if reference source is disabled
				!explainSources.reference
					? emptyResults
					: searchKB(
							kbChunksCollection(this.db, this.prefix),
							query,
							queryVector,
							{
								maxResults: Math.max(3, Math.floor(maxResults / 3)),
								minScore,
								scopeRef: identity.scopeRef,
								numCandidates: mongoCfg.numCandidates,
								vectorIndexName: `${this.prefix}kb_chunks_vector`,
								textIndexName: `${this.prefix}kb_chunks_text`,
								capabilities: this.capabilities,
								embeddingMode: mongoCfg.embeddingMode,
								kbDocs: kbCollection(this.db, this.prefix),
								explain: explainOpts,
							},
						).catch((err) => {
							log.warn(`relevanceExplain KB search failed: ${String(err)}`)
							return [] as MemorySearchResult[]
						}),
				// Structured memory — skip if structured source is disabled
				!explainSources.structured
					? emptyResults
					: searchStructuredMemory(
							structuredMemCollection(this.db, this.prefix),
							query,
							queryVector,
							{
								maxResults: Math.max(3, Math.floor(maxResults / 3)),
								minScore,
								filter: {
									agentId: this.agentId,
									scope: identity.scope,
									scopeRef: identity.scopeRef,
								},
								numCandidates: mongoCfg.numCandidates,
								capabilities: this.capabilities,
								vectorIndexName: `${this.prefix}structured_mem_vector`,
								embeddingMode: mongoCfg.embeddingMode,
								explain: explainOpts,
							},
						).catch((err) => {
							log.warn(
								`relevanceExplain structured memory search failed: ${String(err)}`,
							)
							return [] as MemorySearchResult[]
						}),
			])
			const conversationResults = [
				...runtimeConversationResults,
				...bridgeConversationResults,
			]
			const legacyMethod: SearchMethod = this.resolveObservedSearchMethod(
				traces,
				mongoCfg,
			)
			const normalizedLegacy = normalizeSearchResults(
				conversationResults,
				legacyMethod,
			)
			const normalizedKb = normalizeSearchResults(kbResults, "kb")
			const normalizedStructured = normalizeSearchResults(
				structuredResults,
				"structured",
			)
			const merged = [
				...normalizedLegacy,
				...normalizedKb,
				...normalizedStructured,
			].toSorted((a, b) => b.score - a.score)
			mergedResults = applyPostRetrievalScoring(
				query,
				rerankResults(deduplicateSearchResults(merged), query),
				{ questionDate: params.questionDate },
			).slice(0, maxResults)
		}

		const successfulTrace = [...traces].toReversed().find((event) => event.ok)
		const fallbackPath =
			successfulTrace && successfulTrace.method !== mongoCfg.fusionMethod
				? `${mongoCfg.fusionMethod}->${successfulTrace.method}`
				: undefined
		const health = this.relevance.evaluateHealth(mergedResults, fallbackPath)
		this.relevance.recordSignal(mergedResults, fallbackPath)
		artifacts.push({
			artifactType: "trace",
			summary: {
				sourceScope,
				requestedFusionMethod: mongoCfg.fusionMethod,
				fallbackPath,
				events: traces,
				topScore: mergedResults[0]?.score ?? 0,
				resultCount: mergedResults.length,
			},
		})

		const latencyMs = Date.now() - startedAt
		let runId: string | undefined
		try {
			runId = await this.relevance.persistRun({
				query,
				sourceScope,
				latencyMs,
				topK: maxResults,
				hitSources: Array.from(
					new Set(mergedResults.map((result) => result.source)),
				),
				fallbackPath,
				status: health,
				sampled: true,
				sampleRate: this.relevance.getSampleState().current,
				artifacts,
				diagnosticMode: true,
			})
		} catch (err) {
			this.relevance.logTelemetryFailure(err)
		}

		return {
			runId,
			latencyMs,
			sourceScope,
			health,
			fallbackPath,
			sampleRate: this.relevance.getSampleState().current,
			artifacts,
			results: mergedResults,
		}
	}

	async relevanceBenchmark(params?: {
		datasetPath?: string
		maxResults?: number
		minScore?: number
		// Task 1.A envelope-parity pass-through — accepted today, wired into
		// the envelope by Task 5.E2E (envelope emitter already supports them).
		datasetSha256?: string
		embeddingConfig?: {
			model: string
			dimensions: number
			quantization: "float32" | "int8" | "binary"
		}
		rerankerConfig?: {
			model: string
			version: string | null
			stage: "post-fusion" | "pre-fusion" | "none"
		}
		retrievalLane?: BenchmarkRetrievalLane
		qualityThresholds?: BenchmarkQualityThresholds
		/**
		 * #70: real outcome of the conversation-recall regression suite executed
		 * alongside this run (scripts/run-benchmark.ts runs it). Absent → the
		 * gate stays "not-run" and blocks publication.
		 */
		conversationRecallRegression?: {
			status: "passed" | "failed"
			evidence: string
		}
		/**
		 * Defaults to "shipped". Pass "diagnostic" to opt into the augmented
		 * corpus (evidence documents + LLM enrichment) that the shipped pipeline
		 * never writes — a diagnostic number must never be published as a
		 * product number.
		 */
		executionProfile?: BenchmarkExecutionProfile
	}): Promise<RelevanceBenchmarkResult> {
		if (!this.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		const mongoCfg = this.config.mongodb!
		if (!mongoCfg.relevance.benchmark.enabled) {
			throw new Error("relevance benchmark is disabled by configuration")
		}
		const datasetPath =
			params?.datasetPath ?? mongoCfg.relevance.benchmark.datasetPath
		const maxResults =
			params?.maxResults ?? (params?.qualityThresholds ? 50 : 10)
		const minScore = params?.minScore ?? mongoCfg.reranking?.minScore ?? 0.01
		const resolvedDatasetPath = await resolveBenchmarkDatasetPath({
			datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
		})
		const datasetSha256 = await resolveDatasetSha256({
			datasetPath: resolvedDatasetPath,
			override: params?.datasetSha256,
		})
		const qualityThresholds = params?.qualityThresholds
			? resolveRegisteredBenchmarkQualityContract({
					declared: params.qualityThresholds,
					datasetSha256,
				})
			: undefined
		const retrievalLane = resolveBenchmarkRetrievalLane(
			params?.retrievalLane ?? process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE,
		)
		if (qualityThresholds && retrievalLane !== "native") {
			throw new Error(
				"publication quality contracts require the shipped native retrieval lane",
			)
		}
		if (qualityThresholds && maxResults < 50) {
			throw new Error(
				"publication quality contracts require maxResults >= 50 so @50 metrics use a complete candidate budget",
			)
		}

		const executionProfile = resolveBenchmarkExecutionProfile({
			requested: params?.executionProfile,
			retrievalLane,
			hasQualityContract: Boolean(qualityThresholds),
		})
		const runContext = createBenchmarkRunContext({
			runId: randomUUID(),
			configuration: this.snapshotBenchmarkRunConfiguration({
				executionProfile,
				retrievalLane,
				maxResults,
				minScore,
				qualityContractId: qualityThresholds?.contractId,
				qualityContractVersion: qualityThresholds?.version,
			}),
		})
		let dataset: MemoryBenchmarkDataset
		try {
			dataset = await loadBenchmarkDataset(resolvedDatasetPath, {
				baseDir: this.workspaceDir,
				allowedRoots: this.getBenchmarkAllowedRoots(),
			})
		} catch (datasetErr) {
			if (!isLegacyBenchmarkFallbackCandidate(datasetErr)) {
				throw datasetErr
			}
			if (qualityThresholds) {
				throw new Error(
					"a publication quality contract cannot run against a legacy-query dataset",
				)
			}
			const cases =
				await this.relevance.loadBenchmarkDataset(resolvedDatasetPath)
			if (cases.length === 0) {
				throw datasetErr
			}
			const legacy = await this.runLegacyRelevanceBenchmark({
				datasetPath: resolvedDatasetPath,
				maxResults,
				minScore,
			})
			const parity = await this.buildBenchmarkParityBundle({
				datasetPath: resolvedDatasetPath,
				datasetKind: legacy.result.datasetKind,
				retrievalLane,
				datasetSha256Override: params?.datasetSha256,
				latencySamples: legacy.latencySamples,
				runContext,
			})
			return attachBenchmarkOperationsReport(
				legacy.result,
				parity,
				qualityThresholds,
				undefined,
				params?.conversationRecallRegression,
			)
		}
		if (
			qualityThresholds &&
			dataset.datasetKind !== qualityThresholds.datasetKind
		) {
			throw new Error(
				`quality contract datasetKind=${qualityThresholds.datasetKind} does not match dataset kind=${dataset.datasetKind ?? "unknown"}`,
			)
		}
		if (
			(dataset.scenarios?.some((scenario) => scenario.evaluations.length > 0) ??
				false) === false
		) {
			const noEvaluationError = new Error(
				"benchmark dataset contains no evaluation cases",
			)
			if (qualityThresholds) {
				throw noEvaluationError
			}
			const cases =
				await this.relevance.loadBenchmarkDataset(resolvedDatasetPath)
			if (cases.length === 0) {
				throw noEvaluationError
			}
			const legacy = await this.runLegacyRelevanceBenchmark({
				datasetPath: resolvedDatasetPath,
				maxResults,
				minScore,
			})
			const parity = await this.buildBenchmarkParityBundle({
				datasetPath: resolvedDatasetPath,
				datasetKind: legacy.result.datasetKind,
				retrievalLane,
				datasetSha256Override: params?.datasetSha256,
				latencySamples: legacy.latencySamples,
				runContext,
			})
			return attachBenchmarkOperationsReport(
				legacy.result,
				parity,
				qualityThresholds,
				undefined,
				params?.conversationRecallRegression,
			)
		}
		const datasetVersion = datasetSha256
		const scenario = await this.runScenarioBenchmarkDataset({
			datasetPath: resolvedDatasetPath,
			dataset,
			datasetVersion,
			maxResults,
			minScore,
			retrievalLane,
			executionProfile,
			runContext,
		})
		const parity = await this.buildBenchmarkParityBundle({
			datasetPath: resolvedDatasetPath,
			datasetKind: scenario.result.datasetKind,
			retrievalLane,
			datasetSha256Override: params?.datasetSha256,
			latencySamples: scenario.latencySamples,
			runContext,
			tenantStorage: scenario.storage,
		})
		return attachBenchmarkOperationsReport(
			scenario.result,
			parity,
			qualityThresholds,
			scenario.e2eQa,
			params?.conversationRecallRegression,
		)
	}

	/**
	 * Task 1.A projection: assemble the parity-envelope bundle from
	 * runtime signals (resolved backend config, run-scoped counters,
	 * latency samples, live `collStats`).
	 */
	private async buildBenchmarkParityBundle(params: {
		datasetPath: string
		datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
		retrievalLane?: BenchmarkRetrievalLane
		datasetSha256Override?: string
		latencySamples: number[]
		runContext: BenchmarkRunContext
		tenantStorage?: BenchmarkTenantStorageMeasurement
	}): Promise<{
		runIdentity: import("./types.js").BenchmarkRunIdentity
		embedding: import("./types.js").BenchmarkEmbeddingConfig
		reranker: import("./types.js").BenchmarkRerankerConfig
		storage: import("./types.js").BenchmarkStorageFootprint
		latency: import("./types.js").BenchmarkLatencyDistribution
		cost: import("./types.js").BenchmarkCostAccounting
	}> {
		const mongoCfg = this.config.mongodb!
		const retrievalLane = params.retrievalLane ?? "native"
		const qualityContractId =
			typeof params.runContext.configuration.settings.qualityContractId ===
			"string"
				? params.runContext.configuration.settings.qualityContractId
				: undefined
		const qualityContractVersion =
			typeof params.runContext.configuration.settings.qualityContractVersion ===
			"string"
				? params.runContext.configuration.settings.qualityContractVersion
				: undefined
		assertBenchmarkRunConfiguration(
			params.runContext,
			this.snapshotBenchmarkRunConfiguration({
				executionProfile: params.runContext.configuration.executionProfile,
				retrievalLane: params.runContext.configuration.retrievalLane,
				maxResults: params.runContext.configuration.maxResults,
				minScore: params.runContext.configuration.minScore,
				qualityContractId,
				qualityContractVersion,
			}),
		)
		return await projectBenchmarkParityFields({
			db: this.db,
			collectionName:
				retrievalLane === "raw-session"
					? `${this.prefix}session_chunks`
					: `${this.prefix}events`,
			collectionNames: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(
				(suffix) => `${this.prefix}${suffix}`,
			),
			datasetPath: params.datasetPath,
			datasetKind: params.datasetKind,
			retrievalLane,
			datasetSha256Override: params.datasetSha256Override,
			mongoEmbeddingConfig: {
				numDimensions: mongoCfg.numDimensions,
				quantization: mongoCfg.quantization,
			},
			mongoRerankerConfig: {
				enabled:
					retrievalLane === "raw-session"
						? false
						: (mongoCfg.reranking?.enabled ?? false),
				model:
					retrievalLane === "raw-session"
						? "none"
						: (mongoCfg.reranking?.model ?? "rerank-2.5"),
				topN:
					retrievalLane === "raw-session"
						? 0
						: (mongoCfg.reranking?.topN ?? 20),
			},
			latencySamples: params.latencySamples,
			cost: params.runContext.accounting.snapshot(),
			runContext: params.runContext,
			tenantStorage: params.tenantStorage,
		})
	}

	async relevanceReport(params?: {
		windowMs?: number
	}): Promise<RelevanceReport> {
		if (!this.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		const windowMs = params?.windowMs ?? 24 * 60 * 60 * 1000
		return await this.relevance.buildReport(windowMs)
	}

	relevanceSampleRate(): RelevanceSampleState {
		if (!this.relevance) {
			return {
				enabled: false,
				current: 0,
				base: 0,
				max: 0,
				windowSize: 0,
				degradedSignals: 0,
			}
		}
		return this.relevance.getSampleState()
	}

	private getBenchmarkAllowedRoots(): string[] {
		const envRoots = (process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS ?? "")
			.split(path.delimiter)
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => resolveUserPath(entry))
		// Single-directory convenience knob for operators (containers): one
		// dedicated datasets root instead of a path-delimited list.
		const datasetRoot = process.env.MEMONGO_DATASET_ROOT?.trim()
		return [
			this.workspaceDir,
			path.dirname(
				this.config.mongodb?.relevance.benchmark.datasetPath ??
					this.workspaceDir,
			),
			...(datasetRoot ? [resolveUserPath(datasetRoot)] : []),
			...envRoots,
		]
	}

	private snapshotBenchmarkRunConfiguration(params: {
		executionProfile: "shipped" | "diagnostic"
		retrievalLane: BenchmarkRetrievalLane
		maxResults: number
		minScore: number
		qualityContractId?: string
		qualityContractVersion?: string
	}): BenchmarkRunConfiguration {
		const mongoCfg = this.config.mongodb!
		const settings: BenchmarkRunConfiguration["settings"] = {
			qualityContractId: params.qualityContractId ?? null,
			qualityContractVersion: params.qualityContractVersion ?? null,
			deploymentProfile: mongoCfg.deploymentProfile,
			numCandidates: mongoCfg.numCandidates,
			fusionMethod: mongoCfg.fusionMethod,
			embeddingMode: mongoCfg.embeddingMode,
			embeddingDimensions: mongoCfg.numDimensions,
			embeddingQuantization: mongoCfg.quantization,
			cacheEnabled: mongoCfg.cache.enabled,
			cacheConversationTtlSec: mongoCfg.cache.conversationTtlSec,
			cacheKbTtlSec: mongoCfg.cache.kbTtlSec,
			cacheSimilarityThreshold: mongoCfg.cache.similarityThreshold,
			rerankerEnabled: mongoCfg.reranking?.enabled ?? false,
			rerankerModel: mongoCfg.reranking?.model ?? null,
			rerankerTopN: mongoCfg.reranking?.topN ?? null,
			rerankerMinScore: mongoCfg.reranking?.minScore ?? null,
			rerankerInstructionSha256: mongoCfg.reranking?.instruction
				? createHash("sha256")
						.update(mongoCfg.reranking.instruction)
						.digest("hex")
				: null,
			rerankerApiKeySha256: mongoCfg.reranking?.voyageApiKey
				? createHash("sha256")
						.update(mongoCfg.reranking.voyageApiKey)
						.digest("hex")
				: null,
			queryRewritingEnabled: mongoCfg.queryRewriting.enabled,
			queryRewritingMethod: mongoCfg.queryRewriting.method,
			queryRewritingMaxTokens: mongoCfg.queryRewriting.maxTokens,
			conversationSourceEnabled: mongoCfg.sources.conversation.enabled,
			referenceSourceEnabled: mongoCfg.sources.reference.enabled,
			structuredSourceEnabled: mongoCfg.sources.structured.enabled,
			kbEnabled: mongoCfg.kb.enabled,
			graphEnabled: mongoCfg.graph.enabled,
			graphMaxDepth: mongoCfg.graph.maxGraphDepth,
			graphEntityExtractionMethod: mongoCfg.graph.entityExtraction.method,
			graphEntityExtractionModel: mongoCfg.graph.entityExtraction.model ?? null,
			graphEntityExtractionTimeoutMs: mongoCfg.graph.entityExtraction.timeoutMs,
			episodesEnabled: mongoCfg.episodes.enabled,
			episodesMinEvents: mongoCfg.episodes.minEventsForEpisode,
			vectorSearchCapability: this.capabilities.vectorSearch,
			textSearchCapability: this.capabilities.textSearch,
			scoreFusionCapability: this.capabilities.scoreFusion,
			rankFusionCapability: this.capabilities.rankFusion,
		}
		const environmentKeys = [
			"MEMONGO_BENCHMARK_STRICT",
			"MEMONGO_BENCHMARK_DERIVED_WORK_MODE",
			"MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS",
			"MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS",
			"MEMONGO_BENCHMARK_FAST_INGEST",
			"MEMONGO_BENCHMARK_FAST_INGEST_BATCH_SIZE",
			"MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA",
			"MEMONGO_BENCHMARK_MEASUREMENT_PASSES",
			"MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS",
			"MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE",
			"MEMONGO_BENCHMARK_TURN_PRECISION_MODE",
			"MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS",
			"MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS",
			"MEMONGO_ENRICHMENT_CONCURRENCY",
			"MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK",
			"MEMONGO_ENRICHMENT_AUTH_STYLE",
			"MEMONGO_ENRICHMENT_MODEL",
			"MEMONGO_ENRICHMENT_PROVIDER",
			"MEMONGO_ENRICHMENT_TOKEN_PARAM",
			"MEMONGO_EVIDENCE_SETTLE_MS",
			"MEMONGO_EVIDENCE_MIRROR_MODE",
			"MEMONGO_LLM_ENRICHMENT_MAX_RETRIES",
			"MEMONGO_LLM_ENRICHMENT_MAX_TOKENS",
			"MEMONGO_LLM_ENRICHMENT_MODE",
			"MEMONGO_LLM_ENRICHMENT_STRICT",
			"MEMONGO_LLM_ENRICHMENT_TIMEOUT_MS",
			"MEMONGO_PREFERENCE_EVIDENCE_MODE",
			"MEMONGO_QUERY_DECOMPOSITION_MODE",
			// #66: reranking costs ~715ms of p95 and changes ranking, so a
			// rerank-off run must not hash identically to a rerank-on one.
			"MEMONGO_RERANKING_ENABLED",
			"MEMONGO_RERANK_MIN_SCORE",
			"MEMONGO_RERANK_STRICT",
			"MEMONGO_SCORING_ABLATION",
			"MEMONGO_SESSION_EVIDENCE_MODE",
			"MEMONGO_STRICT_SEARCH_INDEX_READY",
			"MEMONGO_TEMPORAL_COVERAGE_MODE",
			"MEMONGO_USERFACT_EVIDENCE_MODE",
			"MEMONGO_VECTOR_INDEXING_METHOD",
			"MEMONGO_VECTOR_STORED_SOURCE",
		] as const
		for (const key of environmentKeys) {
			settings[`env.${key}`] = process.env[key]?.trim() || null
		}
		const enrichmentApiKey =
			process.env.MEMONGO_ENRICHMENT_API_KEY?.trim() ?? ""
		settings["env.MEMONGO_ENRICHMENT_API_KEY.sha256"] = enrichmentApiKey
			? createHash("sha256").update(enrichmentApiKey).digest("hex")
			: null
		const enrichmentBaseUrl =
			process.env.MEMONGO_ENRICHMENT_BASE_URL?.trim() ?? ""
		settings["env.MEMONGO_ENRICHMENT_BASE_URL.sha256"] = enrichmentBaseUrl
			? createHash("sha256").update(enrichmentBaseUrl).digest("hex")
			: null
		return {
			executionProfile: params.executionProfile,
			retrievalLane: params.retrievalLane,
			maxResults: params.maxResults,
			minScore: params.minScore,
			settings,
		}
	}

	private createBenchmarkScenarioManager(
		agentId: string,
		shippedProfile = false,
	): MongoDBMemoryManager {
		const mongoCfg = this.config.mongodb
		const relevance =
			mongoCfg?.relevance.enabled === true
				? new MongoDBRelevanceRuntime(
						this.db,
						this.prefix,
						agentId,
						mongoCfg,
						this.capabilities,
					)
				: null
		const scenario = new MongoDBMemoryManager({
			client: this.client,
			db: this.db,
			prefix: this.prefix,
			agentId,
			workspaceDir: this.workspaceDir,
			extraMemoryPaths: this.extraMemoryPaths,
			capabilities: this.capabilities,
			nativeBitemporalVectorPrefilter: this.nativeBitemporalVectorPrefilter,
			config: this.config,
			relevance,
		})
		scenario.benchmarkShippedProfile = shippedProfile
		return scenario
	}

	private async settleBenchmarkScenarioManager(
		manager: MongoDBMemoryManager,
	): Promise<void> {
		const configuredTimeout = Number(
			process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS,
		)
		const timeoutMs =
			Number.isFinite(configuredTimeout) && configuredTimeout >= 0
				? configuredTimeout
				: isBenchmarkStrictMode()
					? 60_000
					: 0
		const awaitQueue = async (queue: Promise<void>, label: string) => {
			if (timeoutMs === 0) {
				await queue
				return
			}
			let timeout: ReturnType<typeof setTimeout> | undefined
			await Promise.race([
				queue,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						reject(
							new Error(
								`benchmark scenario manager ${label} settle timed out after ${timeoutMs}ms`,
							),
						)
					}, timeoutMs)
				}),
			]).finally(() => {
				if (timeout) clearTimeout(timeout)
			})
		}

		for (let attempt = 0; attempt < 8; attempt++) {
			const writeQueue = manager.writeQueue
			const derivationSchedulingQueue =
				manager.derivationSchedulingQueue ?? Promise.resolve()
			const derivationQueue = manager.derivationQueue
			const memoryJobWorkerPromise =
				manager.memoryJobWorkerPromise ?? Promise.resolve()
			await awaitQueue(writeQueue, "writeQueue")
			await awaitQueue(derivationSchedulingQueue, "derivationSchedulingQueue")
			await awaitQueue(derivationQueue, "derivationQueue")
			await awaitQueue(memoryJobWorkerPromise, "memoryJobWorkerPromise")
			if (
				writeQueue === manager.writeQueue &&
				derivationSchedulingQueue ===
					(manager.derivationSchedulingQueue ?? derivationSchedulingQueue) &&
				derivationQueue === manager.derivationQueue &&
				memoryJobWorkerPromise ===
					(manager.memoryJobWorkerPromise ?? memoryJobWorkerPromise)
			) {
				return
			}
		}
		log.warn("benchmark scenario manager did not fully settle after retries", {
			agentId: manager.agentId,
		})
	}

	private shouldUseBenchmarkFastIngest(): boolean {
		const mode = process.env.MEMONGO_BENCHMARK_FAST_INGEST?.trim().toLowerCase()
		if (mode === "0" || mode === "false" || mode === "off" || mode === "none") {
			return false
		}
		if (
			mode === "1" ||
			mode === "true" ||
			mode === "on" ||
			mode === "enabled"
		) {
			return true
		}
		return !this.shouldRunPostWriteDerivedWork()
	}

	private async insertBenchmarkDocumentsInBatches(
		collection: Collection<Document>,
		docs: Document[],
	): Promise<void> {
		if (docs.length === 0) return
		const configuredBatchSize = Number(
			process.env.MEMONGO_BENCHMARK_FAST_INGEST_BATCH_SIZE,
		)
		const batchSize =
			Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
				? Math.min(1000, Math.floor(configuredBatchSize))
				: 200
		for (let offset = 0; offset < docs.length; offset += batchSize) {
			await collection.insertMany(docs.slice(offset, offset + batchSize), {
				ordered: false,
			})
		}
	}

	private async fastIngestBenchmarkConversations(params: {
		datasetPath: string
		datasetName?: string
		datasetKind?: MemoryBenchmarkDatasetKind
		conversations: MemoryBenchmarkConversation[]
		failedLines?: number
		scope?: MemoryScope
		metadata?: Record<string, unknown>
	}): Promise<MemoryBenchmarkIngestResult> {
		const startedAt = new Date()
		const eventDocs: Document[] = []
		const chunkDocs: Document[] = []
		const eventIdsBySession = new Map<string, string[]>()
		let conversationsIngested = 0
		let turnsIngested = 0
		let skippedConversations = 0
		let failedTurns = 0

		for (const [index, conversation] of params.conversations.entries()) {
			const turns = conversation.turns
			if (turns.length === 0) {
				skippedConversations++
				continue
			}
			const sessionId =
				conversation.sessionId ??
				conversation.conversationId ??
				`conversation-${index + 1}`
			const scope =
				conversation.scope ?? params.scope ?? ("agent" as MemoryScope)
			const scopeRef = resolveScopeRef({
				scope,
				agentId: this.agentId,
				sessionId,
			})
			const conversationId = conversation.conversationId ?? sessionId

			for (const turn of turns) {
				try {
					const eventId = randomUUID()
					const timestamp =
						parseBenchmarkTurnTimestamp(turn.timestamp) ?? new Date()
					const metadata = buildBenchmarkReplayMetadata({
						baseMetadata: params.metadata,
						turnMetadata: turn.metadata,
						datasetName: params.datasetName,
						datasetKind: params.datasetKind,
						conversationId,
					})
					const eventDoc = {
						eventId,
						agentId: this.agentId,
						sessionId,
						role: turn.role,
						body: turn.body,
						scope,
						scopeRef,
						timestamp,
						projectedAt: startedAt,
						metadata,
					}
					const sessionEventIds = eventIdsBySession.get(sessionId) ?? []
					sessionEventIds.push(eventId)
					eventIdsBySession.set(sessionId, sessionEventIds)
					const text = renderEventChunkText({
						role: turn.role,
						body: turn.body,
					})
					const path = `events/${eventId}`
					chunkDocs.push({
						path,
						text,
						hash: createHash("sha256").update(text).digest("hex"),
						source: "conversation",
						agentId: this.agentId,
						scope,
						scopeRef,
						sessionId,
						updatedAt: startedAt,
					})
					eventDocs.push(eventDoc)
					turnsIngested++
				} catch (err) {
					failedTurns++
					log.warn("benchmark fast ingest turn failed", {
						datasetPath: params.datasetPath,
						datasetName: params.datasetName,
						sessionId,
						role: (turn as MemoryBenchmarkTurn).role,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			conversationsIngested++
		}

		await this.insertBenchmarkDocumentsInBatches(
			eventsCollection(this.db, this.prefix),
			eventDocs,
		)
		await this.insertBenchmarkDocumentsInBatches(
			chunksCollection(this.db, this.prefix),
			chunkDocs,
		)
		let memoryEvidenceCount = 0
		if (isEvidenceMirrorEnabled()) {
			const evidenceScope = params.scope ?? ("agent" as MemoryScope)
			const evidenceScopeRef = resolveScopeRef({
				scope: evidenceScope,
				agentId: this.agentId,
			})
			memoryEvidenceCount = await writeMemoryEvidenceDocuments({
				collection: memoryEvidenceCollection(this.db, this.prefix),
				conversations: params.conversations,
				agentId: this.agentId,
				scope: evidenceScope,
				scopeRef: evidenceScopeRef,
				eventIds: eventIdsBySession,
			})
		}
		if (turnsIngested > 0) {
			await updateLaneCoverage({
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
				increments: {
					"raw-window": turnsIngested,
					hybrid: chunkDocs.length,
					...(memoryEvidenceCount > 0
						? { "memory-evidence": memoryEvidenceCount }
						: {}),
				},
			})
		}
		await recordProjectionRun({
			db: this.db,
			prefix: this.prefix,
			run: {
				agentId: this.agentId,
				projectionType: "chunks",
				status: "ok",
				itemsProjected: chunkDocs.length,
				durationMs: Date.now() - startedAt.getTime(),
			},
		}).catch(() => {})
		this.chunkCount += chunkDocs.length
		this.dirty = false

		return {
			datasetPath: params.datasetPath,
			datasetName: params.datasetName,
			conversationsIngested,
			turnsIngested,
			skippedConversations,
			failedLines: params.failedLines ?? 0,
			failedTurns,
			startedAt,
			completedAt: new Date(),
		}
	}

	private async waitForBenchmarkSearchConvergence(params: {
		agentId: string
		retrievalLane?: BenchmarkRetrievalLane
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
	}): Promise<void> {
		if (params.retrievalLane === "raw-session") {
			await this.waitForBenchmarkVectorSearchCollectionConvergence({
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId: params.sessionId,
				label: "session_chunks",
				collection: sessionChunksCollection(this.db, this.prefix),
				collectionName: `${this.prefix}session_chunks`,
				indexName: `${this.prefix}session_chunks_vector`,
				textPath: "text",
				requireSearchableDocuments: true,
			})
			return
		}
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "events",
			collection: eventsCollection(this.db, this.prefix),
			collectionName: `${this.prefix}events`,
			indexName: `${this.prefix}events_text`,
			textPath: "body",
		})
		await this.waitForBenchmarkVectorSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "events",
			collection: eventsCollection(this.db, this.prefix),
			collectionName: `${this.prefix}events`,
			indexName: `${this.prefix}events_vector`,
			textPath: "body",
		})
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "chunks",
			collection: chunksCollection(this.db, this.prefix),
			collectionName: `${this.prefix}chunks`,
			indexName: `${this.prefix}chunks_text`,
			textPath: "text",
		})
		await this.waitForBenchmarkVectorSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "chunks",
			collection: chunksCollection(this.db, this.prefix),
			collectionName: `${this.prefix}chunks`,
			indexName: `${this.prefix}chunks_vector`,
			textPath: "text",
		})
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "session_chunks",
			collection: sessionChunksCollection(this.db, this.prefix),
			collectionName: `${this.prefix}session_chunks`,
			indexName: `${this.prefix}session_chunks_text`,
			textPath: "text",
		})
		await this.waitForBenchmarkVectorSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "session_chunks",
			collection: sessionChunksCollection(this.db, this.prefix),
			collectionName: `${this.prefix}session_chunks`,
			indexName: `${this.prefix}session_chunks_vector`,
			textPath: "text",
		})
		if (isEvidenceMirrorEnabled()) {
			await this.waitForBenchmarkSearchCollectionConvergence({
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId: params.sessionId,
				label: "memory_evidence",
				collection: memoryEvidenceCollection(this.db, this.prefix),
				collectionName: `${this.prefix}memory_evidence`,
				indexName: `${this.prefix}memory_evidence_text`,
				textPath: "text",
			})
		}
	}

	async waitForBenchmarkSearchReadiness(params?: {
		retrievalLane?: BenchmarkRetrievalLane
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
	}): Promise<void> {
		await this.waitForBenchmarkSearchConvergence({
			agentId: this.agentId,
			retrievalLane: params?.retrievalLane,
			scope: params?.scope,
			scopeRef: params?.scopeRef,
			sessionId: params?.sessionId,
		})
	}

	private async waitForBenchmarkVectorSearchCollectionConvergence(params: {
		agentId: string
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
		label: string
		collection: Collection<Document>
		collectionName: string
		indexName: string
		textPath: string
		requireSearchableDocuments?: boolean
	}): Promise<void> {
		const {
			agentId,
			label,
			collection,
			collectionName,
			indexName,
			textPath,
			requireSearchableDocuments = false,
		} = params
		const namespace = {
			agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
		}
		const scopeFilter = benchmarkConvergenceFilter(namespace)
		const mongoCfg = this.config.mongodb!
		if (
			mongoCfg.embeddingMode !== "automated" ||
			!this.capabilities.vectorSearch
		) {
			if (isBenchmarkStrictMode()) {
				throw new Error(
					"benchmark vector convergence requires MongoDB Vector Search auto-embed capability in strict mode",
				)
			}
			return
		}

		const expectedDocs = await collection
			.find(
				{
					...scopeFilter,
					[textPath]: { $type: "string", $ne: "" },
				},
				{ projection: { [textPath]: 1 } },
			)
			.toArray()
		const expectedCount = expectedDocs.filter((doc) =>
			hasBenchmarkSearchableText(doc[textPath]),
		).length
		if (expectedCount === 0) {
			const message = `benchmark ${label} vector convergence has no searchable documents: collection=${collectionName} agentId=${agentId} textPath=${textPath}`
			if (requireSearchableDocuments && isBenchmarkStrictMode()) {
				throw new Error(message)
			}
			if (requireSearchableDocuments) {
				log.warn(message)
			}
			return
		}

		const configuredTimeout = Number(
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS ??
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS,
		)
		const timeoutMs =
			Number.isFinite(configuredTimeout) && configuredTimeout >= 0
				? configuredTimeout
				: isBenchmarkStrictMode()
					? 300_000
					: 0
		if (timeoutMs === 0) return

		const readinessProbe = await readSearchIndexStatus(
			this.db,
			collectionName,
			indexName,
		)
		if (readinessProbe.kind === "ok") {
			if (
				(readinessProbe.status === "FAILED" ||
					readinessProbe.status === "DELETING" ||
					readinessProbe.status === "STALE") &&
				isBenchmarkStrictMode()
			) {
				throw new Error(
					`index-not-ready: vector index ${indexName} status ${readinessProbe.status} (queryable=${readinessProbe.queryable}) agentId=${agentId}`,
				)
			}
		}

		const limit = Math.min(expectedCount, 1000)
		const vectorStage = buildVectorSearchStage({
			queryVector: null,
			queryText: "benchmark vector readiness probe",
			embeddingMode: mongoCfg.embeddingMode,
			indexName,
			numCandidates: Math.max(limit, Math.min(expectedCount * 4, 10_000)),
			limit,
			filter: scopeFilter,
			textFieldPath: textPath,
			exact: true,
		})
		if (!vectorStage) {
			if (isBenchmarkStrictMode()) {
				throw new Error(
					`benchmark ${label} vector convergence cannot build $vectorSearch stage agentId=${agentId}`,
				)
			}
			return
		}

		const intervalMs = 2_000
		const configuredProbeMaxTime = Number(
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS ??
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS,
		)
		const probeMaxTimeMs =
			Number.isFinite(configuredProbeMaxTime) && configuredProbeMaxTime > 0
				? Math.floor(configuredProbeMaxTime)
				: 30_000
		const deadline = Date.now() + timeoutMs
		let indexedCount = 0
		let lastError: unknown
		let lastProgressLogAt = 0

		while (Date.now() <= deadline) {
			try {
				const controller = new AbortController()
				let timeout: ReturnType<typeof setTimeout> | undefined
				const probe = collection
					.aggregate<{ count: number }>(
						[{ $vectorSearch: vectorStage }, { $count: "count" }],
						{ maxTimeMS: probeMaxTimeMs, signal: controller.signal },
					)
					.toArray()
				const rows = await Promise.race([
					probe,
					new Promise<Array<{ count: number }>>((_, reject) => {
						timeout = setTimeout(() => {
							controller.abort()
							reject(
								new Error(
									`benchmark vector convergence probe exceeded ${probeMaxTimeMs}ms`,
								),
							)
						}, probeMaxTimeMs)
					}),
				]).finally(() => {
					if (timeout) clearTimeout(timeout)
				})
				indexedCount =
					typeof rows[0]?.count === "number" ? Number(rows[0].count) : 0
				if (indexedCount >= Math.min(expectedCount, limit)) {
					return
				}
			} catch (err) {
				lastError = err
				if (!isBenchmarkStrictMode()) {
					log.warn("benchmark vector convergence probe failed", {
						agentId,
						error: err instanceof Error ? err.message : String(err),
					})
					return
				}
			}
			const now = Date.now()
			if (now - lastProgressLogAt >= 30_000) {
				lastProgressLogAt = now
				log.info("benchmark vector convergence waiting", {
					agentId,
					collection: collectionName,
					index: indexName,
					indexedCount,
					expectedCount,
					remainingMs: Math.max(0, deadline - now),
					lastError: lastError ? String(lastError) : undefined,
				})
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs))
		}

		const message = `benchmark ${label} vector convergence timed out: indexed=${indexedCount}/${expectedCount} agentId=${agentId}`
		if (isBenchmarkStrictMode()) {
			throw new Error(
				lastError ? `${message}; lastError=${String(lastError)}` : message,
			)
		}
		log.warn(message)
	}

	private async waitForBenchmarkEventSearchConvergence(
		agentId: string,
	): Promise<void> {
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId,
			label: "events",
			collection: eventsCollection(this.db, this.prefix),
			collectionName: `${this.prefix}events`,
			indexName: `${this.prefix}events_text`,
			textPath: "body",
		})
	}

	private async waitForBenchmarkSearchCollectionConvergence(params: {
		agentId: string
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
		label: string
		collection: Collection<Document>
		collectionName: string
		indexName: string
		textPath: string
	}): Promise<void> {
		const { agentId, label, collection, collectionName, indexName, textPath } =
			params
		const namespace = {
			agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
		}
		const scopeFilter = benchmarkConvergenceFilter(namespace)
		const searchFilters = benchmarkSearchEqualsFilters(namespace)
		if (!this.capabilities.textSearch) {
			if (isBenchmarkStrictMode()) {
				throw new Error(
					"benchmark event search convergence requires MongoDB Search text capability in strict mode",
				)
			}
			return
		}

		const expectedDocs = await collection
			.find(
				{
					...scopeFilter,
					[textPath]: { $type: "string", $ne: "" },
				},
				{ projection: { [textPath]: 1 } },
			)
			.toArray()
		const expectedCount = expectedDocs.filter((doc) =>
			hasBenchmarkSearchableText(doc[textPath]),
		).length
		const textProbeQuery = [...expectedDocs]
			.reverse()
			.map((doc) => benchmarkSearchProbeTerm(doc[textPath]))
			.find((term): term is string => Boolean(term))
		if (expectedCount === 0) return

		const configuredTimeout = Number(
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS,
		)
		const timeoutMs =
			Number.isFinite(configuredTimeout) && configuredTimeout >= 0
				? configuredTimeout
				: isBenchmarkStrictMode()
					? 60_000
					: 0
		if (timeoutMs === 0) return

		const readinessProbe = await readSearchIndexStatus(
			this.db,
			collectionName,
			indexName,
		)
		if (readinessProbe.kind === "ok") {
			if (readinessProbe.queryable) {
				if (readinessProbe.status === "STALE" && isBenchmarkStrictMode()) {
					throw new Error(
						`index-not-ready: search index ${indexName} status STALE (queryable=${readinessProbe.queryable}) agentId=${agentId}`,
					)
				}
				// queryable=true means the index is usable, not that fresh writes have
				// propagated into mongot. MongoDB Search is eventually consistent, so
				// benchmark setup must still probe document visibility below.
			}
			if (!readinessProbe.queryable && isBenchmarkStrictMode()) {
				throw new Error(
					`index-not-ready: search index ${indexName} queryable=false status=${readinessProbe.status} agentId=${agentId}`,
				)
			}
			// non-strict: fall through to aggregate probe and keep polling
		}

		const intervalMs = 2_000
		const configuredProbeMaxTime = Number(
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS,
		)
		const probeMaxTimeMs =
			Number.isFinite(configuredProbeMaxTime) && configuredProbeMaxTime > 0
				? Math.floor(configuredProbeMaxTime)
				: 5_000
		const deadline = Date.now() + timeoutMs
		let indexedCount = 0
		let textProbeCount = 0
		let lastError: unknown

		while (Date.now() <= deadline) {
			try {
				const controller = new AbortController()
				let timeout: ReturnType<typeof setTimeout> | undefined
				const probe = collection
					.aggregate<{
						count?: { total?: number; lowerBound?: number } | number
					}>(
						[
							{
								$searchMeta: {
									index: indexName,
									compound: {
										filter: searchFilters,
										must: [
											{
												// Atlas Search `exists` can report zero for analyzed string
												// fields even after `text` queries are live; wildcard probes
												// the same analyzed field used by retrieval.
												wildcard: {
													path: textPath,
													query: "*",
													allowAnalyzedField: true,
												},
											},
										],
									},
									count: { type: "total" },
								},
							},
						],
						{
							maxTimeMS: probeMaxTimeMs,
							signal: controller.signal,
						},
					)
					.toArray()
				const rows = await Promise.race([
					probe,
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => {
							controller.abort()
							reject(
								new Error(
									`benchmark event search convergence probe exceeded ${probeMaxTimeMs}ms`,
								),
							)
						}, probeMaxTimeMs)
					}),
				]).finally(() => {
					if (timeout) clearTimeout(timeout)
				})
				const countMeta = rows[0]?.count
				indexedCount =
					typeof countMeta === "number"
						? countMeta
						: (countMeta?.total ?? countMeta?.lowerBound ?? 0)
				if (indexedCount >= expectedCount && !textProbeQuery) {
					return
				}
				if (indexedCount >= expectedCount && textProbeQuery) {
					const textProbeRows = await collection
						.aggregate<{
							count?: { total?: number; lowerBound?: number } | number
						}>(
							[
								{
									$searchMeta: {
										index: indexName,
										compound: {
											filter: searchFilters,
											must: [
												{
													text: {
														path: textPath,
														query: textProbeQuery,
													},
												},
											],
										},
										count: { type: "total" },
									},
								},
							],
							{
								maxTimeMS: probeMaxTimeMs,
								signal: controller.signal,
							},
						)
						.toArray()
					const textCountMeta = textProbeRows[0]?.count
					textProbeCount =
						typeof textCountMeta === "number"
							? textCountMeta
							: (textCountMeta?.total ?? textCountMeta?.lowerBound ?? 0)
					if (textProbeCount > 0) {
						return
					}
				}
			} catch (err) {
				lastError = err
				if (!isBenchmarkStrictMode()) {
					log.warn("benchmark event search convergence probe failed", {
						agentId,
						error: err instanceof Error ? err.message : String(err),
					})
					return
				}
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs))
		}

		const message = `benchmark ${label} search convergence timed out: indexed=${indexedCount}/${expectedCount} textProbe=${textProbeCount}${textProbeQuery ? ` query=${textProbeQuery}` : ""} agentId=${agentId}`
		if (isBenchmarkStrictMode()) {
			throw new Error(
				lastError ? `${message}; lastError=${String(lastError)}` : message,
			)
		}
		log.warn(message)
	}

	private async cleanupBenchmarkScenarioData(agentId: string): Promise<void> {
		const settled = await Promise.allSettled(
			BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(async (suffix) => {
				await this.db
					.collection(`${this.prefix}${suffix}`)
					.deleteMany({ agentId })
			}),
		)
		for (const [index, result] of settled.entries()) {
			if (result.status === "rejected") {
				log.warn("benchmark scenario cleanup failed", {
					agentId,
					collection: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES[index],
					error: result.reason,
				})
			}
		}
	}

	/**
	 * #66: drop the benchmark tenant's query cache between measurement passes.
	 * Without this, pass 2+ replays pass 1 from `query_cache` — latencyMs ~0 and
	 * bit-identical rankings — so every extra pass would be fake-fast noise-free
	 * garbage. Deleting the scenario agent's entries keeps every pass as cold as
	 * pass 1 without touching the shipped `checkCache`/`writeCache` path.
	 *
	 * `writeCache` is fire-and-forget, so an upsert issued by the previous
	 * pass's last query can still land after this delete; at most one stale
	 * entry per pass survives, which cannot move a p95 over a full dataset.
	 */
	private async flushBenchmarkQueryCache(agentId: string): Promise<void> {
		try {
			const deleted = await queryCacheCollection(
				this.db,
				this.prefix,
			).deleteMany({ agentId })
			log.info("benchmark query cache flushed between measurement passes", {
				agentId,
				deletedCount: deleted.deletedCount,
			})
		} catch (err) {
			throw new Error(
				`benchmark query cache flush failed for agentId=${agentId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	private async listBenchmarkEventSessions(
		agentId: string,
	): Promise<Map<string, string>> {
		return (await this.listBenchmarkEventEvidence(agentId)).sessionIds
	}

	private async listBenchmarkEventEvidence(
		agentId: string,
	): Promise<BenchmarkEventEvidenceMaps> {
		const rows = await eventsCollection(this.db, this.prefix)
			.find(
				{ agentId },
				{
					projection: {
						eventId: 1,
						sessionId: 1,
						metadata: 1,
					},
				},
			)
			.toArray()
		const evidence: BenchmarkEventEvidenceMaps = {
			sessionIds: new Map<string, string>(),
			turnIds: new Map<string, string>(),
			dialogIds: new Map<string, string>(),
		}
		for (const row of rows) {
			if (typeof row.eventId !== "string" || row.eventId.trim().length === 0) {
				continue
			}
			const eventId = row.eventId.trim()
			if (
				typeof row.sessionId === "string" &&
				row.sessionId.trim().length > 0
			) {
				evidence.sessionIds.set(eventId, row.sessionId.trim())
			}
			const metadata =
				row.metadata && typeof row.metadata === "object"
					? (row.metadata as Record<string, unknown>)
					: undefined
			if (
				typeof metadata?.benchmarkTurnId === "string" &&
				metadata.benchmarkTurnId.trim().length > 0
			) {
				evidence.turnIds.set(eventId, metadata.benchmarkTurnId.trim())
			}
			if (
				typeof metadata?.locomoDialogId === "string" &&
				metadata.locomoDialogId.trim().length > 0
			) {
				evidence.dialogIds.set(eventId, metadata.locomoDialogId.trim())
			}
		}
		return evidence
	}

	private collectBenchmarkResultSourceEventIds(
		result: MemorySearchResult,
	): string[] {
		const sourceEventIds = new Set<string>()
		if (Array.isArray(result.sourceEventIds)) {
			for (const eventId of result.sourceEventIds) {
				if (typeof eventId === "string" && eventId.trim().length > 0) {
					sourceEventIds.add(eventId.trim())
				}
			}
		}
		const provenance = result.provenance
		if (
			provenance &&
			typeof provenance === "object" &&
			Array.isArray(
				(provenance as { sourceEventIds?: unknown[] }).sourceEventIds,
			)
		) {
			for (const eventId of (provenance as { sourceEventIds: unknown[] })
				.sourceEventIds) {
				if (typeof eventId === "string" && eventId.trim().length > 0) {
					sourceEventIds.add(eventId.trim())
				}
			}
		}
		return Array.from(sourceEventIds)
	}

	private resolveBenchmarkResultSessionIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps | Map<string, string>,
	): string[] {
		const sessionIds: string[] = []
		if (
			typeof result.sessionId === "string" &&
			result.sessionId.trim().length > 0
		) {
			sessionIds.push(result.sessionId.trim())
		}
		// Recognize session-chunk canonical IDs (from session evidence documents)
		if (
			typeof result.canonicalId === "string" &&
			result.canonicalId.startsWith("session-chunk/")
		) {
			const sessionId = result.canonicalId.slice("session-chunk/".length).trim()
			if (sessionId.length > 0) {
				sessionIds.push(sessionId)
			}
		}
		const eventSessions =
			evidence instanceof Map ? evidence : evidence.sessionIds
		for (const eventId of this.collectBenchmarkResultSourceEventIds(result)) {
			const sessionId = eventSessions.get(eventId)
			if (sessionId) {
				sessionIds.push(sessionId)
			}
		}
		return Array.from(new Set(sessionIds))
	}

	private resolveBenchmarkResultTurnIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps,
	): string[] {
		const turnIds: string[] = []
		for (const eventId of this.collectBenchmarkResultSourceEventIds(result)) {
			const turnId = evidence.turnIds.get(eventId)
			if (turnId) {
				turnIds.push(turnId)
			}
		}
		return Array.from(new Set(turnIds))
	}

	private resolveBenchmarkResultDialogIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps,
	): string[] {
		const dialogIds: string[] = []
		for (const eventId of this.collectBenchmarkResultSourceEventIds(result)) {
			const dialogId = evidence.dialogIds.get(eventId)
			if (dialogId) {
				dialogIds.push(dialogId)
			}
		}
		return Array.from(new Set(dialogIds))
	}

	private async buildBenchmarkDatasetVersion(
		datasetPath: string,
	): Promise<string> {
		const hash = createHash("sha256")
		const stream = createReadStream(datasetPath)
		await new Promise<void>((resolve, reject) => {
			stream.on("data", (chunk) => {
				hash.update(chunk)
			})
			stream.on("end", () => resolve())
			stream.on("error", (err) => reject(err))
		})
		return hash.digest("hex")
	}

	private async searchBenchmarkRawSession(
		query: string,
		opts: {
			maxResults: number
			minScore: number
		},
	): Promise<MemorySearchResult[]> {
		const mongoCfg = this.config.mongodb!
		if (
			mongoCfg.embeddingMode !== "automated" ||
			!this.capabilities.vectorSearch
		) {
			throw new Error(
				"raw-session benchmark lane requires MongoDB Vector Search auto-embed",
			)
		}
		const scopeRef = resolveScopeRef({
			scope: "agent",
			agentId: this.agentId,
		})
		const collection = sessionChunksCollection(this.db, this.prefix)
		return vectorSearch(collection, null, {
			maxResults: opts.maxResults,
			minScore: opts.minScore,
			numCandidates: mongoCfg.numCandidates,
			filter: {
				agentId: this.agentId,
				scope: "agent",
				scopeRef,
			},
			indexName: `${this.prefix}session_chunks_vector`,
			queryText: query,
			embeddingMode: mongoCfg.embeddingMode,
		})
	}

	private async runLegacyRelevanceBenchmark(params: {
		datasetPath: string
		maxResults: number
		minScore: number
	}): Promise<{
		result: RelevanceBenchmarkResult
		latencySamples: number[]
	}> {
		const cases = await this.relevance!.loadBenchmarkDataset(params.datasetPath)
		const evaluations: Array<{
			empty: boolean
			topScore: number
			latencyMs: number
			pass: boolean
		}> = []

		for (const entry of cases) {
			const run = await this.relevanceExplain({
				query: entry.query,
				sourceScope: entry.sourceScope ?? "all",
				maxResults: params.maxResults,
				minScore: params.minScore,
				deep: false,
			})
			const summary = MongoDBRelevanceRuntime.buildCaseSummary(
				run.results,
				run.latencyMs,
			)
			const expectedSources = entry.expectedSources ?? []
			const sourcePass = expectedSources.every((source) =>
				summary.hitSources.includes(source),
			)
			const scorePass =
				typeof entry.minTopScore === "number"
					? summary.topScore >= entry.minTopScore
					: true
			evaluations.push({
				empty: summary.empty,
				topScore: summary.topScore,
				latencyMs: summary.latencyMs,
				pass: !summary.empty && sourcePass && scorePass,
			})
		}

		const metrics = MongoDBRelevanceRuntime.summarizeBenchmarkCases(evaluations)
		const datasetVersion = createHash("sha256")
			.update(JSON.stringify(cases.map((entry) => entry.query)))
			.digest("hex")
			.slice(0, 16)
		const regressions = await this.relevance!.persistRegression(
			datasetVersion,
			{
				...metrics,
				rAt5: 0,
				rAt10: 0,
				ndcgAt10: 0,
			},
		)
		return {
			result: {
				datasetVersion,
				datasetName: path.basename(params.datasetPath),
				datasetKind: "legacy-query",
				cases: cases.length,
				scoredCases: cases.length,
				skippedCases: 0,
				...metrics,
				rAt5: 0,
				rAt10: 0,
				ndcgAt10: 0,
				questionTypeBreakdown: [],
				regressions,
			},
			latencySamples: evaluations.map((entry) => entry.latencyMs),
		}
	}

	private async runScenarioBenchmarkDataset(params: {
		datasetPath: string
		dataset: MemoryBenchmarkDataset
		datasetVersion: string
		maxResults: number
		minScore: number
		retrievalLane?: BenchmarkRetrievalLane
		executionProfile?: "shipped" | "diagnostic"
		runContext: BenchmarkRunContext
	}): Promise<{
		result: RelevanceBenchmarkResult
		latencySamples: number[]
		e2eQa?: BenchmarkE2eQaEnvelope
		storage: BenchmarkTenantStorageMeasurement
	}> {
		const scenarios = params.dataset.scenarios ?? []
		const measurementPasses = resolveBenchmarkMeasurementPasses()
		// #66: index 0 is the gate pass — the one the published result, the
		// release gates, and the regression baseline are computed from.
		const executionsByPass: BenchmarkCaseExecution[][] = Array.from(
			{ length: measurementPasses },
			() => [],
		)
		const executions = executionsByPass[0]!
		const expectedSessionMap = new Map<string, string[]>()
		const expectedTurnMap = new Map<string, string[]>()
		const qaCases: E2eQaCase[] = []
		const storageCollections = new Map<
			string,
			{ documents: number; logicalBytes: number }
		>()
		const storageFailures: string[] = []
		const runToken = randomUUID().slice(0, 8)
		const rawSessionLane = params.retrievalLane === "raw-session"
		const ingest = {
			conversationsIngested: 0,
			turnsIngested: 0,
			skippedConversations: 0,
			failedLines: params.dataset.failedLines ?? 0,
			failedTurns: 0,
		}

		for (const [index, scenario] of scenarios.entries()) {
			const scenarioStartedAt = Date.now()
			let scenarioManager: MongoDBMemoryManager = this
			let eventEvidence: BenchmarkEventEvidenceMaps = {
				sessionIds: new Map<string, string>(),
				turnIds: new Map<string, string>(),
				dialogIds: new Map<string, string>(),
			}
			try {
				log.info("benchmark scenario start", {
					scenarioId: scenario.scenarioId,
					index,
					totalScenarios: scenarios.length,
					conversations: scenario.conversations.length,
					evaluations: scenario.evaluations.length,
					retrievalLane: params.retrievalLane ?? "native",
				})
				if (scenario.conversations.length > 0) {
					const scenarioAgentId = `benchmark-${this.agentId}-${runToken}-${createHash("sha256").update(`${index}:${scenario.scenarioId}`).digest("hex").slice(0, 12)}`
					scenarioManager = this.createBenchmarkScenarioManager(
						scenarioAgentId,
						params.executionProfile === "shipped",
					)
					const scenarioIngest =
						params.executionProfile !== "shipped" &&
						scenarioManager.shouldUseBenchmarkFastIngest()
							? await scenarioManager.fastIngestBenchmarkConversations({
									datasetPath: params.datasetPath,
									datasetName: params.dataset.name,
									datasetKind: params.dataset.datasetKind,
									conversations: scenario.conversations,
									scope: "agent",
									metadata: {
										benchmarkDatasetKind:
											params.dataset.datasetKind ?? "generic",
										benchmarkScenarioId: scenario.scenarioId,
									},
								})
							: await ingestBenchmarkConversations({
									datasetPath: params.datasetPath,
									datasetName: params.dataset.name,
									conversations: scenario.conversations,
									scope: "agent",
									metadata: {
										benchmarkDatasetKind:
											params.dataset.datasetKind ?? "generic",
										benchmarkScenarioId: scenario.scenarioId,
									},
									writeTurn: async (turn) => {
										await scenarioManager.writeConversationEvent(
											turn,
											params.runContext,
										)
									},
								})
					ingest.conversationsIngested += scenarioIngest.conversationsIngested
					ingest.turnsIngested += scenarioIngest.turnsIngested
					ingest.skippedConversations += scenarioIngest.skippedConversations
					ingest.failedTurns += scenarioIngest.failedTurns
					log.info("benchmark scenario ingested", {
						scenarioId: scenario.scenarioId,
						agentId: scenarioManager.agentId,
						conversationsIngested: scenarioIngest.conversationsIngested,
						turnsIngested: scenarioIngest.turnsIngested,
						failedTurns: scenarioIngest.failedTurns,
					})
					await this.settleBenchmarkScenarioManager(scenarioManager)
					eventEvidence = await this.listBenchmarkEventEvidence(
						scenarioManager.agentId,
					)

					// Session evidence: create session-level documents for retrieval
					const sessionEvidenceMode = resolveSessionEvidenceMode(
						process.env.MEMONGO_SESSION_EVIDENCE_MODE,
					)
					const effectiveSessionEvidenceMode =
						params.executionProfile === "shipped"
							? "none"
							: rawSessionLane
								? "B"
								: sessionEvidenceMode
					const userfactEvidenceMode =
						params.executionProfile === "shipped"
							? "none"
							: resolveUserfactEvidenceMode(
									process.env.MEMONGO_USERFACT_EVIDENCE_MODE,
									process.env.MEMONGO_PREFERENCE_EVIDENCE_MODE,
								)
					const enrichmentMode =
						params.executionProfile === "shipped"
							? "none"
							: resolveEnrichmentMode(process.env.MEMONGO_LLM_ENRICHMENT_MODE)
					let sessionEvidenceDocsWritten = 0
					let sessionEventCount = 0
					if (
						effectiveSessionEvidenceMode !== "none" ||
						(!rawSessionLane &&
							(userfactEvidenceMode === "enabled" || enrichmentMode !== "none"))
					) {
						try {
							// Invert eventId->sessionId to sessionId->[eventIds]
							const sessionEventMap = new Map<string, string[]>()
							for (const [eventId, sessionId] of eventEvidence.sessionIds) {
								const existing = sessionEventMap.get(sessionId)
								if (existing) {
									existing.push(eventId)
								} else {
									sessionEventMap.set(sessionId, [eventId])
								}
							}
							sessionEventCount = sessionEventMap.size
							const scopeRef = resolveScopeRef({
								scope: "agent",
								agentId: scenarioManager.agentId,
							})

							if (effectiveSessionEvidenceMode === "A") {
								await writeSessionEvidenceOptionA({
									chunksCollection: chunksCollection(this.db, this.prefix),
									conversations: scenario.conversations,
									agentId: scenarioManager.agentId,
									scope: "agent",
									scopeRef,
									eventIds: sessionEventMap,
								})
							} else if (effectiveSessionEvidenceMode === "B") {
								sessionEvidenceDocsWritten = await writeSessionEvidenceOptionB({
									sessionChunksCollection: sessionChunksCollection(
										this.db,
										this.prefix,
									),
									conversations: scenario.conversations,
									agentId: scenarioManager.agentId,
									scope: "agent",
									scopeRef,
									eventIds: sessionEventMap,
								})
							}

							// LLM enrichment: replaces regex userfact when available
							const enrichmentProvider =
								!rawSessionLane && enrichmentMode !== "none"
									? resolveEnrichmentProvider(process.env)
									: null
							const enrichmentStrict =
								!rawSessionLane &&
								resolveEnrichmentStrictMode(
									process.env.MEMONGO_LLM_ENRICHMENT_STRICT,
								)

							if (
								!rawSessionLane &&
								enrichmentMode !== "none" &&
								enrichmentStrict &&
								!enrichmentProvider
							) {
								throw new Error(
									"MEMONGO_LLM_ENRICHMENT_STRICT requires a configured LLM enrichment provider",
								)
							}

							if (enrichmentProvider && enrichmentMode !== "none") {
								try {
									const enrichmentModel =
										process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
									const enrichmentConcurrencyValue = Number(
										process.env.MEMONGO_ENRICHMENT_CONCURRENCY,
									)
									const enrichmentConcurrency =
										Number.isFinite(enrichmentConcurrencyValue) &&
										enrichmentConcurrencyValue > 0
											? Math.min(10, Math.floor(enrichmentConcurrencyValue))
											: undefined
									const enrichResult = await enrichSessionsWithLLM({
										provider: enrichmentProvider,
										model: enrichmentModel,
										mode: enrichmentMode,
										conversations: scenario.conversations,
										agentId: scenarioManager.agentId,
										scope: "agent",
										scopeRef,
										eventIds: sessionEventMap,
										concurrency: enrichmentConcurrency,
										strict: enrichmentStrict,
										onProviderCall: (outcome) => {
											const accounting = params.runContext.accounting
											const metadata = {
												provider: enrichmentProvider.name,
												model: enrichmentModel,
											}
											if (outcome === "attempted") {
												accounting.recordAttempt("enrichment", metadata)
											} else if (outcome === "succeeded") {
												accounting.recordSuccess("enrichment", metadata)
											} else {
												accounting.recordFailure("enrichment", metadata)
											}
										},
									})
									// Write LLM-produced userfact docs (replace regex)
									if (enrichResult.userfactDocs.length > 0) {
										await chunksCollection(this.db, this.prefix).insertMany(
											enrichResult.userfactDocs,
										)
									}
									// Write QA evidence docs
									if (enrichResult.qaDocs.length > 0) {
										await chunksCollection(this.db, this.prefix).insertMany(
											enrichResult.qaDocs,
										)
									}
									// Fall back to regex for sessions where LLM failed
									if (
										enrichResult.failedSessionIds.length > 0 &&
										enrichmentStrict
									) {
										throw new Error(
											`LLM enrichment failed for ${enrichResult.sessionsFailed} sessions: ${JSON.stringify(enrichResult.failureSamples)}`,
										)
									}
									if (
										enrichResult.failedSessionIds.length > 0 &&
										userfactEvidenceMode === "enabled"
									) {
										log.warn(
											"LLM enrichment partial failure, falling back to regex for failed sessions",
											{
												scenarioId: scenario.scenarioId,
												sessionsEnriched: enrichResult.sessionsEnriched,
												sessionsFailed: enrichResult.sessionsFailed,
												failedSessionIds: enrichResult.failedSessionIds,
												failureSamples: enrichResult.failureSamples,
											},
										)
										const failedSet = new Set(enrichResult.failedSessionIds)
										const failedConversations = scenario.conversations.filter(
											(c) => c.sessionId && failedSet.has(c.sessionId),
										)
										if (failedConversations.length > 0) {
											await writeUserfactEvidence({
												chunksCollection: chunksCollection(
													this.db,
													this.prefix,
												),
												conversations: failedConversations,
												agentId: scenarioManager.agentId,
												scope: "agent",
												scopeRef,
												eventIds: sessionEventMap,
											})
										}
									}
								} catch (err) {
									if (enrichmentStrict) {
										throw err
									}
									log.warn("LLM enrichment failed, falling back to regex", {
										scenarioId: scenario.scenarioId,
										error: err instanceof Error ? err.message : String(err),
									})
									// Full fallback to regex userfact extraction
									if (userfactEvidenceMode === "enabled") {
										await writeUserfactEvidence({
											chunksCollection: chunksCollection(this.db, this.prefix),
											conversations: scenario.conversations,
											agentId: scenarioManager.agentId,
											scope: "agent",
											scopeRef,
											eventIds: sessionEventMap,
										})
									}
								}
							} else if (
								!rawSessionLane &&
								userfactEvidenceMode === "enabled"
							) {
								// No LLM provider: use regex extraction
								await writeUserfactEvidence({
									chunksCollection: chunksCollection(this.db, this.prefix),
									conversations: scenario.conversations,
									agentId: scenarioManager.agentId,
									scope: "agent",
									scopeRef,
									eventIds: sessionEventMap,
								})
							}
						} catch (err) {
							log.warn("benchmark evidence creation failed", {
								sessionMode: effectiveSessionEvidenceMode,
								userfactMode: userfactEvidenceMode,
								scenarioId: scenario.scenarioId,
								error: err instanceof Error ? err.message : String(err),
							})
							if (isBenchmarkStrictMode()) {
								const message = err instanceof Error ? err.message : String(err)
								throw new Error(
									`benchmark evidence creation failed in strict mode: scenario=${scenario.scenarioId}: ${message}`,
								)
							}
						}
						// Allow auto-embed to index enrichment docs before evaluation.
						// MongoDB auto-embed is eventually consistent — mongot processes
						// docs async via change streams + Voyage API. Empirically 5-15s
						// for ~40 docs on Atlas Local. Fixed delay + write queue settle.
						await this.settleBenchmarkScenarioManager(scenarioManager)
						const [chunkEvidenceCount, sessionEvidenceCount] =
							await Promise.all([
								chunksCollection(this.db, this.prefix).countDocuments({
									agentId: scenarioManager.agentId,
									source: {
										$in: [
											"session-evidence",
											"userfact-evidence",
											"qa-evidence",
										],
									},
								}),
								sessionChunksCollection(this.db, this.prefix).countDocuments({
									agentId: scenarioManager.agentId,
									source: "session-evidence",
								}),
							])
						const evidenceCount = chunkEvidenceCount + sessionEvidenceCount
						if (rawSessionLane) {
							const nonAbstentionEvaluations = scenario.evaluations.filter(
								(evaluation) => !evaluation.abstention,
							).length
							if (
								nonAbstentionEvaluations > 0 &&
								sessionEvidenceDocsWritten === 0
							) {
								throw new Error(
									`raw-session benchmark evidence creation produced zero session documents: scenario=${scenario.scenarioId} agentId=${scenarioManager.agentId} conversations=${scenario.conversations.length} nonAbstentionEvaluations=${nonAbstentionEvaluations}`,
								)
							}
							if (sessionEvidenceCount < sessionEvidenceDocsWritten) {
								throw new Error(
									`raw-session benchmark session_chunks persistence mismatch: scenario=${scenario.scenarioId} agentId=${scenarioManager.agentId} written=${sessionEvidenceDocsWritten} persisted=${sessionEvidenceCount}`,
								)
							}
							log.info("raw-session benchmark evidence ready", {
								scenarioId: scenario.scenarioId,
								agentId: scenarioManager.agentId,
								writtenSessionDocs: sessionEvidenceDocsWritten,
								persistedSessionDocs: sessionEvidenceCount,
								sessionEventCount,
								nonAbstentionEvaluations,
							})
						}
						if (chunkEvidenceCount > 0 && !rawSessionLane) {
							const settleMs =
								Number(process.env.MEMONGO_EVIDENCE_SETTLE_MS) || 15_000
							log.info(
								`waiting ${settleMs}ms for auto-embed convergence (${chunkEvidenceCount} chunk evidence docs)`,
								{
									scenarioId: scenario.scenarioId,
									evidenceCount: chunkEvidenceCount,
								},
							)
							await new Promise((r) => setTimeout(r, settleMs))
						}
					}
					await this.waitForBenchmarkSearchConvergence({
						agentId: scenarioManager.agentId,
						retrievalLane: params.retrievalLane,
					})
				} else {
					eventEvidence = await this.listBenchmarkEventEvidence(this.agentId)
				}

				// #66: repeat ONLY the measurement loop. Ingest, evidence, settle,
				// convergence, and cleanup each stay at exactly one per scenario, so
				// n samples of a condition cost n eval loops instead of n full runs.
				for (let pass = 0; pass < measurementPasses; pass++) {
					const passExecutions = executionsByPass[pass]!
					if (pass > 0) {
						await this.flushBenchmarkQueryCache(scenarioManager.agentId)
					}
					for (const evaluation of scenario.evaluations) {
						const startedAt = Date.now()
						// Parse questionDate from evaluation metadata for temporal scoring
						const evalQuestionDate =
							typeof evaluation.metadata?.questionDate === "string"
								? new Date(evaluation.metadata.questionDate)
								: undefined
						const validQuestionDate =
							evalQuestionDate && !Number.isNaN(evalQuestionDate.getTime())
								? evalQuestionDate
								: undefined
						try {
							// Query decomposition: break preference-style queries into sub-queries
							const decompositionMode = resolveDecompositionMode(
								process.env.MEMONGO_QUERY_DECOMPOSITION_MODE,
							)
							const decompositionProvider =
								decompositionMode === "enabled"
									? resolveEnrichmentProvider(process.env)
									: null

							let results: MemorySearchResult[]
							// #66: per-lane latency of the search that produced `results`.
							// Only the plain search() path carries a lane breakdown.
							let latencyByLane: Record<string, number> | undefined

							if (rawSessionLane) {
								results = await scenarioManager.searchBenchmarkRawSession(
									evaluation.query,
									{
										maxResults: params.maxResults,
										minScore: params.minScore,
									},
								)
							} else if (
								decompositionProvider &&
								decompositionMode === "enabled" &&
								params.executionProfile !== "shipped"
							) {
								// #66: decomposition sits outside search(), so its cost and the
								// N sub-searches it fans out never reach the lane breakdown.
								const decomposeStartedAt = Date.now()
								const decomposed = await decomposeQuery({
									provider: decompositionProvider,
									model: process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? "",
									query: evaluation.query,
									questionType: evaluation.questionType,
									onProviderCall: (outcome) => {
										const accounting = params.runContext.accounting
										const metadata = {
											provider: decompositionProvider.name,
											model: process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? "",
										}
										if (outcome === "attempted") {
											accounting.recordAttempt("query-decomposition", metadata)
										} else if (outcome === "succeeded") {
											accounting.recordSuccess("query-decomposition", metadata)
										} else {
											accounting.recordFailure("query-decomposition", metadata)
										}
									},
								})
								const decomposeMs = Date.now() - decomposeStartedAt
								// Run each sub-query through the search pipeline
								const subSearchStartedAt = Date.now()
								const resultSets: MemorySearchResult[][] = []
								for (const subQuery of decomposed.subQueries) {
									const subResults = await scenarioManager.search(
										subQuery,
										{
											maxResults: params.maxResults,
											minScore: params.minScore,
											questionDate: validQuestionDate,
										},
										params.runContext,
									)
									resultSets.push(subResults)
								}
								// Also run the original query to avoid losing good direct matches
								const originalResults = await scenarioManager.search(
									evaluation.query,
									{
										maxResults: params.maxResults,
										minScore: params.minScore,
										questionDate: validQuestionDate,
									},
									params.runContext,
								)
								resultSets.push(originalResults)
								latencyByLane = {
									"phase:decompose": decomposeMs,
									"phase:decompose-searches": Date.now() - subSearchStartedAt,
								}
								// Merge all result sets with RRF
								results = mergeMultiQueryResults(
									resultSets,
									params.maxResults,
								) as MemorySearchResult[]
							} else {
								const relevanceScope =
									evaluation.sourceScope &&
									scenarioManager.relevance &&
									evaluation.sourceScope !== "all"
										? evaluation.sourceScope
										: undefined
								results = relevanceScope
									? (
											await scenarioManager.relevanceExplain({
												query: evaluation.query,
												sourceScope: relevanceScope,
												maxResults: params.maxResults,
												minScore: params.minScore,
												deep: false,
												questionDate: validQuestionDate,
											})
										).results
									: await scenarioManager.search(
											evaluation.query,
											{
												maxResults: params.maxResults,
												minScore: params.minScore,
												questionDate: validQuestionDate,
												onLaneLatency: (lanes) => {
													latencyByLane = lanes
												},
											},
											params.runContext,
										)
							}
							passExecutions.push(
								evaluateRankingCase({
									caseId: evaluation.caseId,
									results,
									latencyMs: Date.now() - startedAt,
									...(latencyByLane && Object.keys(latencyByLane).length > 0
										? { latencyByLane }
										: {}),
									relevantSessionIds: evaluation.expectedSessionIds,
									relevantTurnIds: evaluation.expectedTurnIds,
									relevantDialogIds: evaluation.expectedDialogIds,
									resolveSessionIds: (result) =>
										this.resolveBenchmarkResultSessionIds(
											result,
											eventEvidence,
										),
									resolveTurnIds: (result) =>
										this.resolveBenchmarkResultTurnIds(result, eventEvidence),
									resolveDialogIds: (result) =>
										this.resolveBenchmarkResultDialogIds(result, eventEvidence),
									datasetKind: params.dataset.datasetKind,
									officialRetrieval: evaluation.officialRetrieval,
									questionType: evaluation.questionType,
									abstention: evaluation.abstention,
									traceOptions: { maxCandidates: 50 },
								}),
							)
							// QA answers are graded once: extra passes measure retrieval,
							// not the answer model.
							if (pass === 0 && params.dataset.datasetKind === "locomo") {
								qaCases.push({
									caseId: evaluation.caseId,
									question: evaluation.query,
									goldAnswer:
										typeof evaluation.answer === "string"
											? evaluation.answer
											: "",
									contextPassages: results.map((result) => result.snippet),
									abstention: evaluation.abstention,
									...(typeof evaluation.answer !== "string"
										? { upstreamFailure: "gold answer is missing" }
										: {}),
								})
							}
							// Track expected IDs for miss ledger
							expectedSessionMap.set(
								evaluation.caseId,
								evaluation.expectedSessionIds,
							)
							expectedTurnMap.set(
								evaluation.caseId,
								evaluation.expectedTurnIds ?? [],
							)
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err)
							if (isBenchmarkStrictMode()) {
								throw new Error(
									`benchmark evaluation query failed in strict mode: scenario=${scenario.scenarioId} case=${evaluation.caseId}: ${message}`,
								)
							}
							log.warn("benchmark evaluation query failed", {
								scenarioId: scenario.scenarioId,
								caseId: evaluation.caseId,
								error: err instanceof Error ? err.message : String(err),
							})
							passExecutions.push(
								evaluateRankingCase({
									caseId: evaluation.caseId,
									results: [],
									latencyMs: Date.now() - startedAt,
									relevantSessionIds: evaluation.expectedSessionIds,
									relevantTurnIds: evaluation.expectedTurnIds,
									relevantDialogIds: evaluation.expectedDialogIds,
									resolveSessionIds: (result) =>
										this.resolveBenchmarkResultSessionIds(
											result,
											eventEvidence,
										),
									resolveTurnIds: (result) =>
										this.resolveBenchmarkResultTurnIds(result, eventEvidence),
									resolveDialogIds: (result) =>
										this.resolveBenchmarkResultDialogIds(result, eventEvidence),
									datasetKind: params.dataset.datasetKind,
									officialRetrieval: evaluation.officialRetrieval,
									questionType: evaluation.questionType,
									abstention: evaluation.abstention,
									executionError: message,
								}),
							)
							// QA answers are graded once: extra passes measure retrieval,
							// not the answer model.
							if (pass === 0 && params.dataset.datasetKind === "locomo") {
								qaCases.push({
									caseId: evaluation.caseId,
									question: evaluation.query,
									goldAnswer:
										typeof evaluation.answer === "string"
											? evaluation.answer
											: "",
									contextPassages: [],
									abstention: evaluation.abstention,
									upstreamFailure: message,
								})
							}
							expectedSessionMap.set(
								evaluation.caseId,
								evaluation.expectedSessionIds,
							)
							expectedTurnMap.set(
								evaluation.caseId,
								evaluation.expectedTurnIds ?? [],
							)
						}
					}
				}
				log.info("benchmark scenario complete", {
					scenarioId: scenario.scenarioId,
					agentId: scenarioManager.agentId,
					index,
					totalScenarios: scenarios.length,
					evaluations: scenario.evaluations.length,
					elapsedMs: Date.now() - scenarioStartedAt,
				})
			} finally {
				if (scenarioManager !== this) {
					await scenarioManager.stopMemoryJobWorker()
					const measurement = await collectBenchmarkTenantStorage({
						db: this.db,
						agentId: scenarioManager.agentId,
						collectionNames: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(
							(suffix) => `${this.prefix}${suffix}`,
						),
					})
					if (measurement.unavailableReason) {
						storageFailures.push(
							`${scenario.scenarioId}: ${measurement.unavailableReason}`,
						)
					}
					for (const entry of measurement.collections) {
						const current = storageCollections.get(entry.collectionName) ?? {
							documents: 0,
							logicalBytes: 0,
						}
						current.documents += entry.documents
						current.logicalBytes += entry.logicalBytes
						storageCollections.set(entry.collectionName, current)
					}
				} else {
					storageFailures.push(
						`${scenario.scenarioId}: scenario did not use an isolated benchmark agent`,
					)
				}
				if (
					scenarioManager !== this &&
					process.env.MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA !== "1"
				) {
					await this.cleanupBenchmarkScenarioData(scenarioManager.agentId)
				}
			}
		}

		let e2eQa: BenchmarkE2eQaEnvelope | undefined
		if (qaCases.length > 0) {
			const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
			let provider: EnrichmentProvider | null = null
			let unavailableReason = "answer QA provider is not configured"
			try {
				provider = resolveEnrichmentProvider(process.env)
			} catch (error) {
				unavailableReason =
					error instanceof Error ? error.message : String(error)
			}
			if (provider && model) {
				e2eQa = await runE2eQa({
					provider,
					model,
					cases: qaCases,
					onProviderCall: (operation, outcome) => {
						const accounting = params.runContext.accounting
						const metadata = { provider: provider.name, model }
						if (outcome === "attempted") {
							accounting.recordAttempt(operation, metadata)
						} else if (outcome === "succeeded") {
							accounting.recordSuccess(operation, metadata)
						} else {
							accounting.recordFailure(operation, metadata)
						}
					},
				})
			} else {
				e2eQa = {
					answerModel: model || null,
					judge: model || null,
					judgeVersion: null,
					accuracy: null,
					latencyMs: null,
					judgeFalsePositiveRate: null,
					cases: {
						eligible: qaCases.length,
						attempted: 0,
						completed: 0,
						failed: 0,
					},
					attempts: {
						answerGeneration: 0,
						answerJudge: 0,
						decoyJudge: 0,
					},
					caseResults: [],
					unavailableReason,
				}
			}
		}

		// #66: pass 1 is the gate pass — every published metric, release gate, and
		// regression baseline below is computed from it alone, so gate semantics
		// are identical whether one pass ran or ten.
		const passSummaries = executionsByPass.map((passExecutions) =>
			summarizeBenchmarkExecutions({
				datasetName: params.dataset.name,
				datasetKind: params.dataset.datasetKind,
				retrievalLane: params.retrievalLane,
				scenarios: scenarios.length,
				executions: passExecutions,
				ingest,
			}),
		)
		const summary = passSummaries[0]!
		const measurementPassReport = summarizeMeasurementPasses(passSummaries)
		const regressions = await this.relevance!.persistRegression(
			params.datasetVersion,
			{
				hitRate: summary.hitRate,
				emptyRate: summary.emptyRate,
				avgTopScore: summary.avgTopScore,
				p95LatencyMs: summary.p95LatencyMs,
				rAt5: summary.rAt5,
				rAt10: summary.rAt10,
				ndcgAt10: summary.ndcgAt10,
			},
		)
		const storageCollectionRows = Array.from(
			storageCollections,
			([collectionName, values]) => ({ collectionName, ...values }),
		)
		const storage: BenchmarkTenantStorageMeasurement =
			storageFailures.length > 0
				? {
						documents: null,
						logicalBytes: null,
						collections: storageCollectionRows,
						unavailableReason: storageFailures.join("; "),
					}
				: {
						documents: storageCollectionRows.reduce(
							(sum, entry) => sum + entry.documents,
							0,
						),
						logicalBytes: storageCollectionRows.reduce(
							(sum, entry) => sum + entry.logicalBytes,
							0,
						),
						collections: storageCollectionRows,
					}
		// Explicitly pick only the fields defined in RelevanceBenchmarkResult
		// to prevent any runtime-leaked properties from inflating the response
		// beyond V8's JSON.stringify limit (~512 MB).
		return {
			result: {
				datasetVersion: params.datasetVersion,
				datasetName: summary.datasetName,
				datasetKind: summary.datasetKind,
				scenarios: summary.scenarios,
				cases: summary.cases,
				scoredCases: summary.scoredCases,
				skippedCases: summary.skippedCases,
				execution: summary.execution,
				caseOutcomes: summary.caseOutcomes,
				hitRate: summary.hitRate,
				emptyRate: summary.emptyRate,
				avgTopScore: summary.avgTopScore,
				p95LatencyMs: summary.p95LatencyMs,
				...(summary.laneLatencyP95
					? { laneLatencyP95: summary.laneLatencyP95 }
					: {}),
				...(measurementPassReport
					? { measurementPasses: measurementPassReport }
					: {}),
				rAt5: summary.rAt5,
				rAt10: summary.rAt10,
				ndcgAt10: summary.ndcgAt10,
				questionTypeBreakdown: summary.questionTypeBreakdown,
				...(summary.officialMetrics
					? { officialMetrics: summary.officialMetrics }
					: {}),
				...(summary.ingest ? { ingest: summary.ingest } : {}),
				regressions,
				missLedger: buildMissLedger({
					executions,
					expectedSessionMap,
					expectedTurnMap,
				}),
				caseDiagnostics: buildCaseDiagnostics({
					executions,
					expectedSessionMap,
					expectedTurnMap,
				}),
			},
			latencySamples: executions.map((e) => e.latencyMs),
			...(e2eQa ? { e2eQa } : {}),
			storage,
		}
	}

	async benchmarkIngest(params: {
		datasetPath: string
		scope?: MemoryScope
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryBenchmarkIngestResult> {
		const datasetPath = await resolveBenchmarkDatasetPath({
			datasetPath: params.datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
		})
		return ingestBenchmarkDataset({
			datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
			scope: params.scope,
			limitConversations: params.limitConversations,
			limitTurnsPerConversation: params.limitTurnsPerConversation,
			writeTurn: async (turn) => {
				await this.writeConversationEvent(turn)
			},
		})
	}

	async importConversations(params: {
		datasetPath: string
		scope?: MemoryScope
		scopeRef?: string
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryConversationImportResult> {
		const datasetPath = await resolveBenchmarkDatasetPath({
			datasetPath: params.datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
		})
		return importConversationDataset({
			datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
			scope: params.scope,
			limitConversations: params.limitConversations,
			limitTurnsPerConversation: params.limitTurnsPerConversation,
			writeTurn: async (turn) => {
				// Tenant isolation: force the caller's authorized scope/scopeRef onto
				// every imported turn so a dataset that declares its own
				// conversation.scope cannot land events outside the caller's tenant.
				await this.writeConversationEvent({
					...turn,
					...(params.scope !== undefined ? { scope: params.scope } : {}),
					...(params.scopeRef !== undefined
						? { scopeRef: params.scopeRef }
						: {}),
				})
			},
		})
	}

	async accessTrends(params?: {
		collection?: AccessEventCollection
		memoryIds?: string[]
		windowDays?: number
		limit?: number
	}): Promise<MemoryAccessTrend[]> {
		return listAccessTrends({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			collection: params?.collection,
			memoryIds:
				params?.memoryIds?.filter((memoryId) => memoryId.trim().length > 0) ??
				undefined,
			windowDays: params?.windowDays,
			limit: params?.limit,
		})
	}

	async accessSummaries(params: {
		collection: AccessEventCollection
		memoryIds: string[]
		windowDays?: number
	}): Promise<MemoryAccessSummary[]> {
		return getAccessSummariesOrEmpty({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			collection: params.collection,
			memoryIds: params.memoryIds,
			windowDays: params.windowDays,
		})
	}

	// ---------------------------------------------------------------------------
	// Direct KB search (for kb_search tool optimization)
	// ---------------------------------------------------------------------------

	async searchKB(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			scopeRef?: string
			filter?: { tags?: string[]; category?: string; source?: string }
			/** Per-call override; defaults to the resolved config fusionMethod. */
			fusionMethod?: MemoryMongoDBFusionMethod
		},
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			return []
		}

		const mongoCfg = this.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 5)
		const minScore = opts?.minScore ?? 0.1

		// Direct KB search uses MongoDB query-time automatic embeddings.
		const queryVector: number[] | null = null

		return searchKB(
			kbChunksCollection(this.db, this.prefix),
			cleaned,
			queryVector,
			{
				maxResults,
				minScore,
				// Tenant isolation: search the caller's authorized scopeRef when
				// provided; otherwise fall back to this agent's default scopeRef.
				scopeRef: opts?.scopeRef ?? this.agentScopeRef,
				filter: opts?.filter,
				numCandidates: mongoCfg.numCandidates,
				vectorIndexName: `${this.prefix}kb_chunks_vector`,
				textIndexName: `${this.prefix}kb_chunks_text`,
				capabilities: this.capabilities,
				embeddingMode: mongoCfg.embeddingMode,
				// P0.10: KB fusion is a first-class option — per-call override,
				// else the resolved config value (env/config, default rankFusion).
				fusionMethod: opts?.fusionMethod ?? mongoCfg.fusionMethod,
				kbDocs: kbCollection(this.db, this.prefix),
			},
		)
	}

	// ---------------------------------------------------------------------------
	// Score normalization: detect which search method was used for legacy search
	// ---------------------------------------------------------------------------

	private detectSearchMethod(mongoCfg: ResolvedMongoDBConfig): SearchMethod {
		// Best guess from configuration alone. Only correct when mongoSearch
		// actually took the path its capabilities allow — prefer
		// resolveObservedSearchMethod, which uses the trace of what ran.
		const canVector =
			mongoCfg.embeddingMode === "automated" && this.capabilities.vectorSearch

		if (canVector && this.capabilities.textSearch) {
			return "hybrid"
		}
		if (canVector) {
			return "vector"
		}
		// Text-only or $text fallback
		return "text"
	}

	/**
	 * Resolve which search method actually produced these results, from the
	 * trace mongoSearch emits, falling back to the configuration guess only
	 * when nothing succeeded.
	 *
	 * This picks the normalizer, so guessing wrong corrupts ranking rather than
	 * just mislabeling. mongoSearch degrades through hybrid → vector → keyword
	 * → $text, and the last two return raw BM25/textScore values on an
	 * unbounded scale. Calling those "hybrid" sends them to the [0,1] clamp,
	 * which pins every lexical hit above ~1 to exactly 1.0 — sorting degraded
	 * results above genuine cosine hits from the KB and structured lanes, whose
	 * scores are normalized honestly. normalizeBM25Score exists precisely for
	 * this case; it was simply never reached.
	 */
	private resolveObservedSearchMethod(
		traceEvents: SearchTraceEvent[],
		mongoCfg: ResolvedMongoDBConfig,
	): SearchMethod {
		const succeeded = [...traceEvents].toReversed().find((event) => event.ok)
		switch (succeeded?.method) {
			case "scoreFusion":
			case "rankFusion":
			case "js-merge":
				return "hybrid"
			case "vector":
				return "vector"
			case "keyword":
			case "$text":
				return "text"
			default:
				return this.detectSearchMethod(mongoCfg)
		}
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.readFile
	// ---------------------------------------------------------------------------

	async readFile(params: { relPath: string; from?: number; lines?: number }) {
		const rawPath = params.relPath.trim()
		if (!rawPath) {
			throw new Error("path required")
		}

		if (rawPath.startsWith("structured:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const [, type, ...keyParts] = basePath.split(":")
			const key = keyParts.join(":").trim()
			if (!type || !key) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = query.get("scope")
			const scopeRef = query.get("scopeRef")
			const record = await structuredMemCollection(
				this.db,
				this.prefix,
			).findOne({
				agentId: this.agentId,
				type,
				key,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "structured" as const,
					sourceType: "structured" as const,
				}
			}
			await structuredMemCollection(this.db, this.prefix).updateOne(
				{ _id: record._id },
				{
					$set: { openedAt: new Date() },
					$inc: { openedCount: 1 },
				},
			)
			const text = [
				`type: ${String(record.type ?? type)}`,
				`key: ${String(record.key ?? key)}`,
				`value: ${String(record.value ?? "")}`,
				typeof record.revision === "number"
					? `revision: ${record.revision}`
					: null,
				typeof record.state === "string" ? `state: ${record.state}` : null,
				typeof record.salience === "string"
					? `salience: ${record.salience}`
					: null,
				typeof record.temporalScope === "string"
					? `temporalScope: ${record.temporalScope}`
					: null,
				record.validFrom instanceof Date
					? `validFrom: ${record.validFrom.toISOString()}`
					: null,
				record.validTo instanceof Date
					? `validTo: ${record.validTo.toISOString()}`
					: null,
				record.reviewAt instanceof Date
					? `reviewAt: ${record.reviewAt.toISOString()}`
					: null,
				record.lastConfirmedAt instanceof Date
					? `lastConfirmedAt: ${record.lastConfirmedAt.toISOString()}`
					: null,
				typeof record.reinforcementCount === "number"
					? `reinforcementCount: ${record.reinforcementCount}`
					: null,
				typeof record.sourceReliability === "number"
					? `sourceReliability: ${record.sourceReliability}`
					: null,
				typeof record.context === "string"
					? `context: ${record.context}`
					: null,
				Array.isArray(record.tags) && record.tags.length > 0
					? `tags: ${record.tags.join(", ")}`
					: null,
				Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
					? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
					: null,
				record.provenance && typeof record.provenance === "object"
					? `provenance: ${JSON.stringify(record.provenance)}`
					: null,
				record.supersedes && typeof record.supersedes === "object"
					? `supersedes: ${JSON.stringify(record.supersedes)}`
					: null,
				record.invalidatedBy && typeof record.invalidatedBy === "object"
					? `invalidatedBy: ${JSON.stringify(record.invalidatedBy)}`
					: null,
				Array.isArray(record.conflictsWith) && record.conflictsWith.length > 0
					? `conflictsWith: ${JSON.stringify(record.conflictsWith)}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "structured" as const,
				sourceType: "structured" as const,
				type,
				key,
			}
		}

		if (rawPath.startsWith("entity:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const entityId = basePath.slice("entity:".length).trim()
			if (!entityId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = query.get("scope")
			const scopeRef = query.get("scopeRef")
			const record = await entitiesCollection(this.db, this.prefix).findOne({
				agentId: this.agentId,
				entityId,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "conversation" as const,
					sourceType: "conversation" as const,
				}
			}
			const text = [
				`entityId: ${String(record.entityId ?? entityId)}`,
				`name: ${String(record.name ?? "")}`,
				typeof record.type === "string" ? `type: ${record.type}` : null,
				Array.isArray(record.aliases) && record.aliases.length > 0
					? `aliases: ${record.aliases.join(", ")}`
					: null,
				Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
					? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
					: null,
				record.metadata && typeof record.metadata === "object"
					? `metadata: ${JSON.stringify(record.metadata)}`
					: null,
				record.updatedAt instanceof Date
					? `updatedAt: ${record.updatedAt.toISOString()}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}

		if (rawPath.startsWith("procedure:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const procedureId = basePath.slice("procedure:".length).trim()
			if (!procedureId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = query.get("scope")
			const scopeRef = query.get("scopeRef")
			const record = await proceduresCollection(this.db, this.prefix).findOne({
				agentId: this.agentId,
				procedureId,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "structured" as const,
					sourceType: "structured" as const,
				}
			}
			await proceduresCollection(this.db, this.prefix).updateOne(
				{ _id: record._id },
				{
					$set: { openedAt: new Date() },
					$inc: { openedCount: 1 },
				},
			)
			const text = [
				`procedureId: ${String(record.procedureId ?? procedureId)}`,
				`name: ${String(record.name ?? "")}`,
				Array.isArray(record.intentTags) && record.intentTags.length > 0
					? `intentTags: ${record.intentTags.join(", ")}`
					: null,
				Array.isArray(record.triggerQueries) && record.triggerQueries.length > 0
					? `triggerQueries: ${record.triggerQueries.join(" | ")}`
					: null,
				Array.isArray(record.steps) && record.steps.length > 0
					? `steps:\n${record.steps.map((step: unknown, index: number) => `${index + 1}. ${String(step)}`).join("\n")}`
					: null,
				Array.isArray(record.successSignals) && record.successSignals.length > 0
					? `successSignals: ${record.successSignals.join(", ")}`
					: null,
				typeof record.state === "string" ? `state: ${record.state}` : null,
				typeof record.confidence === "number"
					? `confidence: ${record.confidence}`
					: null,
				typeof record.revision === "number"
					? `revision: ${record.revision}`
					: null,
				Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
					? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
					: null,
				record.provenance && typeof record.provenance === "object"
					? `provenance: ${JSON.stringify(record.provenance)}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "structured" as const,
				sourceType: "structured" as const,
			}
		}

		if (rawPath.startsWith("event:")) {
			const eventId = rawPath.slice("event:".length).trim()
			if (!eventId) {
				throw new Error("path required")
			}
			return await this.readCanonicalEvent(eventId, rawPath)
		}

		if (rawPath.startsWith("episode:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const episodeId = basePath.slice("episode:".length).trim()
			if (!episodeId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const expand = query.get("expand")?.trim().toLowerCase()
			return await this.readEpisodeLocator({
				rawPath,
				episodeId,
				expandEvents: expand === "events" || expand === "full",
			})
		}

		if (rawPath.startsWith("relation:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const relationId = basePath.slice("relation:".length).trim()
			if (!relationId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = (query.get("scope") ?? "agent") as MemoryScope
			const scopeRef = query.get("scopeRef") ?? this.agentScopeRef
			// P3.8: one findOne on the relationId index — the old path fetched up
			// to 50 relations per read and JS-matched the pair.
			const relation = await findRelationByLocatorId({
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
				scope,
				scopeRef,
				relationId,
			})
			if (!relation) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "conversation" as const,
					sourceType: "conversation" as const,
				}
			}
			const text = [
				`type: ${String(relation.type ?? "")}`,
				`fromEntityId: ${String(relation.fromEntityId ?? "")}`,
				`toEntityId: ${String(relation.toEntityId ?? "")}`,
				typeof relation.state === "string" ? `state: ${relation.state}` : null,
				typeof relation.weight === "number"
					? `weight: ${relation.weight}`
					: null,
				typeof relation.confidence === "number"
					? `confidence: ${relation.confidence}`
					: null,
				relation.validFrom instanceof Date
					? `validFrom: ${relation.validFrom.toISOString()}`
					: null,
				relation.validTo instanceof Date
					? `validTo: ${relation.validTo.toISOString()}`
					: null,
				relation.reviewAt instanceof Date
					? `reviewAt: ${relation.reviewAt.toISOString()}`
					: null,
				relation.lastConfirmedAt instanceof Date
					? `lastConfirmedAt: ${relation.lastConfirmedAt.toISOString()}`
					: null,
				typeof relation.reinforcementCount === "number"
					? `reinforcementCount: ${relation.reinforcementCount}`
					: null,
				typeof relation.sourceReliability === "number"
					? `sourceReliability: ${relation.sourceReliability}`
					: null,
				Array.isArray(relation.sourceEventIds) &&
				relation.sourceEventIds.length > 0
					? `sourceEventIds: ${relation.sourceEventIds.join(", ")}`
					: null,
				relation.provenance && typeof relation.provenance === "object"
					? `provenance: ${JSON.stringify(relation.provenance)}`
					: null,
				relation.supersedes && typeof relation.supersedes === "object"
					? `supersedes: ${JSON.stringify(relation.supersedes)}`
					: null,
				relation.invalidatedBy && typeof relation.invalidatedBy === "object"
					? `invalidatedBy: ${JSON.stringify(relation.invalidatedBy)}`
					: null,
				relation.updatedAt instanceof Date
					? `updatedAt: ${relation.updatedAt.toISOString()}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}

		if (rawPath.startsWith("kb:") || rawPath.startsWith("reference:")) {
			const kbPath = rawPath.replace(/^kb:|^reference:/, "").trim()
			if (!kbPath) {
				throw new Error("path required")
			}
			const record = await kbCollection(this.db, this.prefix).findOne(
				{
					$or: [{ "source.path": kbPath }, { title: kbPath }],
				},
				{ sort: { updatedAt: -1, _id: 1 } },
			)
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "reference" as const,
					sourceType: "reference" as const,
				}
			}
			return {
				text: typeof record.content === "string" ? record.content : "",
				path: rawPath,
				locator: rawPath,
				source: "reference" as const,
				sourceType: "reference" as const,
				title: typeof record.title === "string" ? record.title : undefined,
			}
		}

		if (
			rawPath.startsWith("conversation:") ||
			rawPath.startsWith("events/") ||
			rawPath.startsWith("sessions/")
		) {
			return await this.readConversationChunk(
				rawPath,
				params.from,
				params.lines,
			)
		}

		return await this.readBridgeChunk(rawPath, params.from, params.lines)
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.status
	// ---------------------------------------------------------------------------

	status(): MemoryProviderStatus {
		const mongoCfg = this.config.mongodb!
		const vectorEnabled =
			this.capabilities.vectorSearch && this.probeEmbeddingModeSupportsVector()
		const lexicalEnabled = this.capabilities.textSearch
		const hybridEnabled = vectorEnabled && lexicalEnabled
		return {
			backend: "mongodb",
			provider: "mongodb-automated",
			model: "automated (server-managed)",
			files: this.fileCount,
			chunks: this.chunkCount,
			dirty: this.dirty,
			workspaceDir: this.workspaceDir,
			sources: getActiveSourcesForStatus(mongoCfg.sources, mongoCfg.kb.enabled),
			custom: {
				deploymentProfile: mongoCfg.deploymentProfile,
				embeddingMode: mongoCfg.embeddingMode,
				fusionMethod: mongoCfg.fusionMethod,
				capabilities: this.capabilities,
				searchModes: {
					vector: vectorEnabled,
					lexical: lexicalEnabled,
					hybrid: hybridEnabled,
				},
				searchMode: this.lastSearchMode,
				searchModeDetails: this.lastSearchDetails,
				retrievalPaths: [
					"active-critical",
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
					"procedural",
				],
				sourceCoverage: {
					reference:
						mongoCfg.sources?.reference?.enabled && mongoCfg.kb.enabled,
					conversation: mongoCfg.sources?.conversation?.enabled,
					structured: mongoCfg.sources?.structured?.enabled,
				},
				database: mongoCfg.database,
				collectionPrefix: mongoCfg.collectionPrefix,
				quantization: mongoCfg.quantization,
				relevance: this.relevance
					? {
							enabled: mongoCfg.relevance.enabled,
							telemetry: {
								state:
									mongoCfg.relevance.enabled &&
									mongoCfg.relevance.telemetry.enabled
										? "enabled"
										: "disabled",
							},
							sampleRate: {
								current: this.relevance.getSampleState().current,
							},
							health: this.relevance.getCurrentHealth(),
							lastRegressionAt: undefined,
							profileCapabilities: this.relevance.getProfileCapabilities(),
						}
					: {
							enabled: false,
							telemetry: { state: "disabled" },
							sampleRate: { current: 0 },
							health: "insufficient-data",
							profileCapabilities: {
								textExplain: false,
								vectorExplain: false,
								fusionExplain: false,
							},
						},
			},
		}
	}

	private async readConversationChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	) {
		const normalizedPath = rawPath.startsWith("conversation:")
			? rawPath.slice("conversation:".length).trim()
			: rawPath
		if (!normalizedPath) {
			throw new Error("path required")
		}
		const start = Math.max(1, from ?? 1)
		const count = Math.max(1, lines ?? Number.MAX_SAFE_INTEGER)
		const end = start + count - 1
		const docs = await chunksCollection(this.db, this.prefix)
			.find({
				path: normalizedPath,
				source: { $in: ["sessions", "conversation"] },
				agentId: this.agentId,
				...(from || lines
					? {
							$or: [
								{ startLine: { $gte: start, $lte: end } },
								{ endLine: { $gte: start, $lte: end } },
								{ startLine: { $lte: start }, endLine: { $gte: end } },
							],
						}
					: {}),
			})
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ startLine: 1 })
			.toArray()
		if (docs.length === 0) {
			if (normalizedPath.startsWith("events/")) {
				const eventId = normalizedPath.slice("events/".length).trim()
				if (eventId) {
					return await this.readCanonicalEvent(
						eventId,
						`conversation:${normalizedPath}`,
					)
				}
			}
			return {
				text: "",
				path: `conversation:${normalizedPath}`,
				locator: `conversation:${normalizedPath}`,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}
		return {
			text: docs
				.map((doc: Document) => (typeof doc.text === "string" ? doc.text : ""))
				.filter(Boolean)
				.join("\n"),
			path: `conversation:${normalizedPath}`,
			locator: `conversation:${normalizedPath}`,
			source: "conversation" as const,
			sourceType: "conversation" as const,
		}
	}

	private async readCanonicalEvent(eventId: string, rawPath: string) {
		const event = await eventsCollection(this.db, this.prefix).findOne({
			agentId: this.agentId,
			eventId,
		})
		if (!event) {
			return {
				text: "",
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}
		const role = typeof event.role === "string" ? event.role : "unknown-role"
		const body = typeof event.body === "string" ? event.body : ""
		const timestamp =
			event.timestamp instanceof Date
				? `timestamp: ${event.timestamp.toISOString()}\n`
				: ""
		return {
			text: `${timestamp}${role}: ${body}`.trim(),
			path: rawPath,
			locator: rawPath,
			source: "conversation" as const,
			sourceType: "conversation" as const,
			type: "event",
			key: eventId,
		}
	}

	private async readBridgeChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	) {
		const start = Math.max(1, from ?? 1)
		const count = Math.max(1, lines ?? Number.MAX_SAFE_INTEGER)
		const end = start + count - 1
		const docs = await chunksCollection(this.db, this.prefix)
			.find({
				path: rawPath,
				source: { $in: ["conversation", "memory"] },
				agentId: this.agentId,
				scope: "workspace",
				scopeRef: this.workspaceScopeRef,
				...(from || lines
					? {
							$or: [
								{ startLine: { $gte: start, $lte: end } },
								{ endLine: { $gte: start, $lte: end } },
								{ startLine: { $lte: start }, endLine: { $gte: end } },
							],
						}
					: {}),
			})
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ startLine: 1 })
			.toArray()
		if (docs.length === 0) {
			return {
				text: "",
				path: rawPath,
				locator: rawPath,
				source: "reference" as const,
				sourceType: "reference" as const,
			}
		}
		return {
			text: docs
				.map((doc: Document) => (typeof doc.text === "string" ? doc.text : ""))
				.filter(Boolean)
				.join("\n"),
			path: rawPath,
			locator: rawPath,
			source: "reference" as const,
			sourceType: "reference" as const,
		}
	}

	private async readEpisodeLocator(params: {
		rawPath: string
		episodeId: string
		expandEvents: boolean
	}) {
		const { rawPath, episodeId, expandEvents } = params
		const episode = await episodesCollection(this.db, this.prefix).findOne({
			agentId: this.agentId,
			episodeId,
			status: { $ne: "deleted" },
		})
		if (!episode) {
			return {
				text: "",
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}

		const sourceEventIds = Array.isArray(episode.sourceEventIds)
			? episode.sourceEventIds.filter(
					(value): value is string => typeof value === "string",
				)
			: Array.isArray(episode.eventIds)
				? episode.eventIds.filter(
						(value): value is string => typeof value === "string",
					)
				: []

		const lines = [
			`type: episode`,
			`episodeId: ${episodeId}`,
			typeof episode.type === "string" ? `episodeType: ${episode.type}` : null,
			typeof episode.title === "string" ? `title: ${episode.title}` : null,
			typeof episode.summary === "string"
				? `summary: ${episode.summary}`
				: null,
			episode.timeRange?.start instanceof Date
				? `timeRangeStart: ${episode.timeRange.start.toISOString()}`
				: null,
			episode.timeRange?.end instanceof Date
				? `timeRangeEnd: ${episode.timeRange.end.toISOString()}`
				: null,
			typeof episode.sourceEventCount === "number"
				? `sourceEventCount: ${episode.sourceEventCount}`
				: `sourceEventCount: ${sourceEventIds.length}`,
			sourceEventIds.length > 0 && !expandEvents
				? `expandLocator: episode:${episodeId}?expand=events`
				: null,
		].filter(Boolean)

		if (expandEvents && sourceEventIds.length > 0) {
			const events = await eventsCollection(this.db, this.prefix)
				.find({
					agentId: this.agentId,
					eventId: { $in: sourceEventIds },
				})
				.toArray()
			const eventOrder = new Map(
				sourceEventIds.map((value, index) => [value, index]),
			)
			events.sort((a, b) => {
				const left =
					eventOrder.get(String(a.eventId)) ?? Number.MAX_SAFE_INTEGER
				const right =
					eventOrder.get(String(b.eventId)) ?? Number.MAX_SAFE_INTEGER
				return left - right
			})

			if (events.length > 0) {
				lines.push("sourceEvents:")
				for (const event of events) {
					const timestamp =
						event.timestamp instanceof Date
							? event.timestamp.toISOString()
							: "unknown-time"
					const role =
						typeof event.role === "string" ? event.role : "unknown-role"
					const body = typeof event.body === "string" ? event.body : ""
					lines.push(`[${timestamp}] ${role}: ${body}`)
				}
			}
		}

		return {
			text: lines.join("\n"),
			path: rawPath,
			locator: rawPath,
			source: "conversation" as const,
			sourceType: "conversation" as const,
			title: typeof episode.title === "string" ? episode.title : undefined,
			type: "episode",
			key: episodeId,
		}
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.sync
	// ---------------------------------------------------------------------------

	async sync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void> {
		if (this.closed) {
			return
		}
		if (this.syncing) {
			return this.syncing
		}
		this.syncing = this.runSync(params).finally(() => {
			this.syncing = null
		})
		return this.syncing
	}

	private async repairEventProjections(): Promise<{
		eventsProcessed: number
		chunksCreated: number
	}> {
		const batchSize = 500
		let eventsProcessed = 0
		let chunksCreated = 0
		for (;;) {
			const batch = await projectChunksFromEvents({
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
				batchSize,
			})
			eventsProcessed += batch.eventsProcessed
			chunksCreated += batch.chunksCreated
			if (batch.eventsProcessed < batchSize) {
				return { eventsProcessed, chunksCreated }
			}
		}
	}

	async repairExtractionOutbox(params?: { limit?: number }): Promise<{
		eventsProcessed: number
		jobsCreated: number
		jobsReleased: number
		eventsFailed: number
	}> {
		const pendingEvents = await getPendingExtractionEvents({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			limit: params?.limit,
		})
		let eventsProcessed = 0
		let jobsCreated = 0
		let jobsReleased = 0
		let eventsFailed = 0

		for (const event of pendingEvents) {
			try {
				const jobId = `extraction-${event.eventId}`
				let existing = await getMemoryJob({
					db: this.db,
					prefix: this.prefix,
					jobId,
					agentId: this.agentId,
				})
				let staged =
					existing?.status === "pending" && Boolean(existing.stagedAt)
				if (!existing) {
					try {
						await createMemoryJob({
							db: this.db,
							prefix: this.prefix,
							job: {
								jobId,
								jobType: "extraction",
								agentId: this.agentId,
								status: "pending",
								stagedAt: event.extractionJobPendingAt ?? new Date(),
								metadata: { eventId: event.eventId },
								payload: {
									eventId: event.eventId,
									scope: event.scope,
									scopeRef: event.scopeRef,
								},
							},
						})
						jobsCreated++
						staged = true
					} catch (err) {
						if (!this.isDuplicateKeyError(err)) {
							throw err
						}
						existing = await getMemoryJob({
							db: this.db,
							prefix: this.prefix,
							jobId,
							agentId: this.agentId,
						})
						if (!existing) {
							throw new Error(
								`duplicate extraction job is unreadable: ${jobId}`,
							)
						}
						staged = existing.status === "pending" && Boolean(existing.stagedAt)
					}
				}

				if (staged) {
					const projected = await projectEventChunk({
						db: this.db,
						prefix: this.prefix,
						event: {
							eventId: event.eventId,
							agentId: event.agentId,
							role: event.role,
							body: event.body,
							scope: event.scope,
							scopeRef: event.scopeRef,
							timestamp: event.timestamp,
							validAt: event.validAt ?? event.timestamp,
							...(event.invalidAt ? { invalidAt: event.invalidAt } : {}),
							...(event.sessionId ? { sessionId: event.sessionId } : {}),
							...(event.metadata ? { metadata: event.metadata } : {}),
						},
					})
					if (projected.chunkCreated) {
						this.chunkCount += 1
					}
					try {
						await extractAndUpsertEntities({
							db: this.db,
							prefix: this.prefix,
							agentId: this.agentId,
							eventContent: event.body,
							scope: event.scope,
							scopeRef: event.scopeRef,
							sourceEventId: event.eventId,
							role: event.role,
						})
					} catch (err) {
						log.warn("entity extraction failed during outbox repair", {
							error: err instanceof Error ? err.message : String(err),
							eventId: event.eventId,
						})
					}

					const released = await releaseStagedMemoryJob({
						db: this.db,
						prefix: this.prefix,
						jobId,
						agentId: this.agentId,
					})
					if (released) {
						jobsReleased++
					} else {
						existing = await getMemoryJob({
							db: this.db,
							prefix: this.prefix,
							jobId,
							agentId: this.agentId,
						})
						if (
							!existing ||
							(existing.status === "pending" && Boolean(existing.stagedAt))
						) {
							throw new Error(
								`failed to release staged extraction job: ${jobId}`,
							)
						}
					}
				}

				await clearEventExtractionJobPending({
					db: this.db,
					prefix: this.prefix,
					eventId: event.eventId,
					agentId: this.agentId,
				})
				eventsProcessed++
			} catch (err) {
				eventsFailed++
				log.warn(
					`extraction outbox repair failed for ${event.eventId}: ${String(err)}`,
				)
			}
		}

		return { eventsProcessed, jobsCreated, jobsReleased, eventsFailed }
	}

	private async runSync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void> {
		const mongoCfg = this.config.mongodb!
		try {
			const result = await syncToMongoDB({
				client: this.client,
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
				// Runtime conversation memory is event-native in MongoDB. Manager-level
				// sync only keeps bridge Markdown in sync and must not rebuild live
				// conversation memory from session transcript files.
				sessionMemoryEnabled: false,
				workspaceDir: this.workspaceDir,
				extraPaths: this.extraMemoryPaths,
				embeddingMode: mongoCfg.embeddingMode,
				reason: params?.reason,
				force: params?.force,
				maxSessionChunks: mongoCfg.maxSessionChunks,
				progress: params?.progress,
			})

			// Query actual totals from MongoDB (not just the delta from this sync)
			try {
				this.fileCount = await filesCollection(
					this.db,
					this.prefix,
				).countDocuments()
				this.chunkCount = await chunksCollection(
					this.db,
					this.prefix,
				).countDocuments()
			} catch {
				// Fallback to delta counts if count query fails
				this.fileCount = result.filesProcessed + result.sessionFilesProcessed
				this.chunkCount = result.chunksUpserted + result.sessionChunksUpserted
			}

			this.dirty = false
			log.info(
				`sync complete: processed=${result.filesProcessed}+${result.sessionFilesProcessed} ` +
					`chunks=${result.chunksUpserted}+${result.sessionChunksUpserted} ` +
					`totals=${this.fileCount} files, ${this.chunkCount} chunks`,
			)

			// KB auto-refresh: re-import autoImportPaths if autoRefreshHours has elapsed
			await this.maybeAutoRefreshKB()
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`sync failed: ${msg}`)
			throw err instanceof Error ? err : new Error(msg)
		}
	}

	private async loadPersistedChangeStreamResumeToken(): Promise<unknown> {
		try {
			const meta = metaCollection(this.db, this.prefix)
			const doc = await meta.findOne({
				_id: CHANGE_STREAM_RESUME_TOKEN_META_KEY,
			} as Record<string, unknown>)
			if (!doc || !("token" in doc)) {
				return null
			}
			return (doc as Record<string, unknown>).token ?? null
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to load persisted change stream resume token: ${msg}`)
			return null
		}
	}

	private async persistChangeStreamResumeToken(token: unknown): Promise<void> {
		try {
			const meta = metaCollection(this.db, this.prefix)
			await meta.updateOne(
				{ _id: CHANGE_STREAM_RESUME_TOKEN_META_KEY } as Record<string, unknown>,
				{ $set: { token, updatedAt: new Date() } },
				{ upsert: true },
			)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to persist change stream resume token: ${msg}`)
		}
	}

	private async clearPersistedChangeStreamResumeToken(): Promise<void> {
		try {
			const meta = metaCollection(this.db, this.prefix)
			await meta.deleteOne({
				_id: CHANGE_STREAM_RESUME_TOKEN_META_KEY,
			} as Record<string, unknown>)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to clear stale change stream resume token: ${msg}`)
		}
	}

	private async maybeAutoRefreshKB(): Promise<void> {
		const mongoCfg = this.config.mongodb!
		if (!mongoCfg.kb.enabled) {
			return
		}
		const autoRefreshHours = mongoCfg.kb.autoRefreshHours
		if (autoRefreshHours <= 0) {
			return
		}
		const paths = mongoCfg.kb.autoImportPaths
		if (paths.length === 0) {
			return
		}

		// Check last KB import time from meta collection
		const meta = metaCollection(this.db, this.prefix)
		const lastRefresh = await meta.findOne({
			_id: "kb_last_auto_refresh",
		} as Record<string, unknown>)
		const lastRefreshTime =
			lastRefresh?.timestamp instanceof Date
				? lastRefresh.timestamp.getTime()
				: 0
		const hoursSinceRefresh = (Date.now() - lastRefreshTime) / (1000 * 60 * 60)

		if (hoursSinceRefresh < autoRefreshHours) {
			return
		}

		log.info(
			`KB auto-refresh: ${hoursSinceRefresh.toFixed(1)}h since last import, refreshing ${paths.length} paths`,
		)
		try {
			const { ingestFilesToKB } = await import("./mongodb-kb.js")
			const result = await ingestFilesToKB({
				db: this.db,
				prefix: this.prefix,
				scope: { agentId: this.agentId, scope: "agent" },
				paths,
				recursive: true,
				importedBy: "agent",
				embeddingMode: mongoCfg.embeddingMode,
				chunking: mongoCfg.kb.chunking,
			})
			log.info(
				`KB auto-refresh complete: ${result.documentsProcessed} docs, ${result.chunksCreated} chunks, ${result.skipped} skipped`,
			)

			// Update last refresh timestamp
			await meta.updateOne(
				{ _id: "kb_last_auto_refresh" } as Record<string, unknown>,
				{ $set: { timestamp: new Date() } },
				{ upsert: true },
			)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB auto-refresh failed: ${msg}`)
		}
	}

	// ---------------------------------------------------------------------------
	// File watcher (chokidar)
	// ---------------------------------------------------------------------------

	private ensureWatcher(): void {
		if (this.watcher) {
			return
		}
		const mongoCfg = this.config.mongodb!
		const debounceMs = mongoCfg.watchDebounceMs
		const watchPaths = new Set<string>([
			path.join(this.workspaceDir, "memory"),
			...this.extraMemoryPaths,
		])
		this.watcher = chokidar.watch(Array.from(watchPaths), {
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: debounceMs,
				pollInterval: 100,
			},
		})
		const markDirty = () => {
			this.dirty = true
			this.scheduleWatchSync()
		}
		this.watcher.on("add", markDirty)
		this.watcher.on("change", markDirty)
		this.watcher.on("unlink", markDirty)
		this.watcher.on("error", (err) => {
			log.warn(`file watcher error: ${String(err)}`)
		})
	}

	private scheduleWatchSync(): void {
		const mongoCfg = this.config.mongodb!
		if (this.watchTimer) {
			clearTimeout(this.watchTimer)
		}
		this.watchTimer = setTimeout(() => {
			this.watchTimer = null
			void this.sync({ reason: "watch" }).catch((err) => {
				log.warn(`memory sync failed (watch): ${String(err)}`)
			})
		}, mongoCfg.watchDebounceMs)
		// (P2.5 e) a pending watch debounce must not hold the process open.
		this.watchTimer.unref?.()
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.probeEmbeddingAvailability
	// ---------------------------------------------------------------------------

	async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
		const mongoCfg = this.config.mongodb!

		if (mongoCfg.embeddingMode === "automated") {
			if (
				mongoCfg.deploymentProfile !== "atlas-local-preview" &&
				mongoCfg.deploymentProfile !== "atlas-managed"
			) {
				return {
					ok: false,
					error: `embeddingMode "automated" is only supported on atlas-local-preview or atlas-managed in Memongo`,
				}
			}
			return this.capabilities.vectorSearch
				? { ok: true }
				: {
						ok: false,
						error: "vector search not available on this MongoDB deployment",
					}
		}

		return { ok: false, error: "unsupported embedding mode" }
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.probeVectorAvailability
	// ---------------------------------------------------------------------------

	async probeVectorAvailability(): Promise<boolean> {
		return (
			this.capabilities.vectorSearch && this.probeEmbeddingModeSupportsVector()
		)
	}

	private probeEmbeddingModeSupportsVector(): boolean {
		const mongoCfg = this.config.mongodb!
		return (
			mongoCfg.embeddingMode === "automated" &&
			(mongoCfg.deploymentProfile === "atlas-local-preview" ||
				mongoCfg.deploymentProfile === "atlas-managed")
		)
	}

	// ---------------------------------------------------------------------------
	// Structured memory write (exposed for memory_write tool to avoid per-call MongoClient)
	// ---------------------------------------------------------------------------

	async writeStructuredMemory(
		entry: StructuredMemoryEntry,
	): Promise<{ upserted: boolean; id: string }> {
		const mongoCfg = this.config.mongodb!
		const { writeStructuredMemory: writeFn } = await import(
			"./mongodb-structured-memory.js"
		)
		return writeFn({
			db: this.db,
			prefix: this.prefix,
			entry: {
				...entry,
				workspaceDir: this.workspaceDir,
				// Default sourceAgent to user when caller does not supply one
				sourceAgent: entry.sourceAgent ?? {
					id: entry.agentId,
					name: "user",
				},
			},
			embeddingMode: mongoCfg.embeddingMode,
			client: this.client,
		})
	}

	async writeProcedure(
		entry: ProcedureEntry,
	): Promise<{ upserted: boolean; id: string }> {
		const mongoCfg = this.config.mongodb!
		const { writeProcedure: writeFn } = await import("./mongodb-procedures.js")
		return writeFn({
			db: this.db,
			prefix: this.prefix,
			entry: {
				...entry,
				workspaceDir: this.workspaceDir,
				// Default sourceAgent to user when caller does not supply one
				sourceAgent: entry.sourceAgent ?? {
					id: entry.agentId,
					name: "user",
				},
			},
			embeddingMode: mongoCfg.embeddingMode,
			client: this.client,
		})
	}

	async getLifecycleItem(
		handle: MemoryStableHandle,
	): Promise<MemoryLifecycleItem | null> {
		if (handle.family === "structured") {
			const { getStructuredMemoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return getStructuredMemoryByHandle({
				db: this.db,
				prefix: this.prefix,
				handle,
			})
		}
		const { getProcedureByHandle } = await import("./mongodb-procedures.js")
		return getProcedureByHandle({
			db: this.db,
			prefix: this.prefix,
			handle,
		})
	}

	async updateLifecycleItem(
		handle: MemoryStableHandle,
		patch: StructuredMemoryLifecyclePatch | ProcedureLifecyclePatch,
	): Promise<MemoryLifecycleItem | null> {
		const mongoCfg = this.config.mongodb!
		if (handle.family === "structured") {
			const { updateStructuredMemoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return updateStructuredMemoryByHandle({
				db: this.db,
				prefix: this.prefix,
				handle,
				patch: patch as StructuredMemoryLifecyclePatch,
				embeddingMode: mongoCfg.embeddingMode,
				client: this.client,
			})
		}
		const { updateProcedureByHandle } = await import("./mongodb-procedures.js")
		return updateProcedureByHandle({
			db: this.db,
			prefix: this.prefix,
			handle,
			patch: patch as ProcedureLifecyclePatch,
			embeddingMode: mongoCfg.embeddingMode,
			client: this.client,
		})
	}

	async invalidateLifecycleItem(
		handle: MemoryStableHandle,
		invalidatedBy?: Record<string, unknown>,
	): Promise<MemoryLifecycleItem | null> {
		if (handle.family === "structured") {
			const { invalidateStructuredMemoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return invalidateStructuredMemoryByHandle({
				db: this.db,
				prefix: this.prefix,
				handle,
				...(invalidatedBy ? { invalidatedBy } : {}),
				client: this.client,
			})
		}
		const { invalidateProcedureByHandle } = await import(
			"./mongodb-procedures.js"
		)
		return invalidateProcedureByHandle({
			db: this.db,
			prefix: this.prefix,
			handle,
			...(invalidatedBy ? { invalidatedBy } : {}),
			client: this.client,
		})
	}

	async getLifecycleHistory(params: {
		handle: MemoryStableHandle
		limit?: number
	}): Promise<MemoryLifecycleHistoryEntry[]> {
		if (params.handle.family === "structured") {
			const { getStructuredMemoryHistoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return getStructuredMemoryHistoryByHandle({
				db: this.db,
				prefix: this.prefix,
				handle: params.handle,
				limit: params.limit,
			}) as Promise<MemoryLifecycleHistoryEntry[]>
		}
		const { getProcedureHistoryByHandle } = await import(
			"./mongodb-procedures.js"
		)
		return getProcedureHistoryByHandle({
			db: this.db,
			prefix: this.prefix,
			handle: params.handle,
			limit: params.limit,
		}) as Promise<MemoryLifecycleHistoryEntry[]>
	}

	async reportProcedureOutcome(params: {
		handle: Extract<MemoryStableHandle, { family: "procedure" }>
		success: boolean
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
		const { reportProcedureOutcomeByHandle } = await import(
			"./mongodb-procedures.js"
		)
		const result = await reportProcedureOutcomeByHandle({
			db: this.db,
			prefix: this.prefix,
			handle: params.handle,
			success: params.success,
			note: params.note,
			actorRole: params.actorRole,
		})
		if (result) {
			await invalidateQueryCache({
				db: this.db,
				prefix: this.prefix,
				agentId: params.handle.agentId,
				scope: params.handle.scope,
				scopeRef: params.handle.scopeRef,
			})
		}
		return result
	}

	async applyMemoryFeedback(params: {
		handle: Extract<MemoryStableHandle, { family: "structured" }>
		signal: MemoryFeedbackSignal
		patch?: StructuredMemoryLifecyclePatch
		invalidatedBy?: Record<string, unknown>
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
		const mongoCfg = this.config.mongodb!
		const { applyStructuredMemoryFeedbackByHandle } = await import(
			"./mongodb-structured-memory.js"
		)
		const result = await applyStructuredMemoryFeedbackByHandle({
			db: this.db,
			prefix: this.prefix,
			handle: params.handle,
			signal: params.signal,
			patch: params.patch,
			invalidatedBy: params.invalidatedBy,
			note: params.note,
			embeddingMode: mongoCfg.embeddingMode,
			client: this.client,
			actorRole: params.actorRole,
		})
		if (result) {
			await invalidateQueryCache({
				db: this.db,
				prefix: this.prefix,
				agentId: params.handle.agentId,
				scope: params.handle.scope,
				scopeRef: params.handle.scopeRef,
			})
		}
		return result
	}

	// ---------------------------------------------------------------------------
	// Self-edit: direct core block editing (user/persona/instructions)
	// ---------------------------------------------------------------------------

	async selfEditBlock(params: {
		block: MemorySelfEditBlock
		action: MemorySelfEditAction
		content: string
	}): Promise<{ upserted: boolean; id: string }> {
		const mongoCfg = this.config.mongodb!
		const { selfEditBlock: editFn } = await import("./mongodb-self-edit.js")
		return editFn({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			embeddingMode: mongoCfg.embeddingMode,
			client: this.client,
			block: params.block,
			action: params.action,
			content: params.content,
		})
	}

	async getDetailedStatus(): Promise<V2Status> {
		return getV2Status(this.db, this.prefix, this.agentId)
	}

	// C2-manager audit fix: synthesizeProfile delegation to standalone function
	async synthesizeProfile(
		params: {
			scope?: MemoryScope
			scopeRef?: string
			maxPerType?: number
			maxEntities?: number
			maxEpisodes?: number
			activityWindowMs?: number
		} = {},
	): Promise<ProfileSynthesis> {
		return synthesizeProfile({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			scope: params.scope ?? "agent",
			scopeRef: params.scopeRef ?? this.agentScopeRef,
			maxPerType: params.maxPerType,
			maxEntities: params.maxEntities,
			maxEpisodes: params.maxEpisodes,
			activityWindowMs: params.activityWindowMs,
		})
	}

	async hydrateActiveSlate(
		params: { scope?: MemoryScope; scopeRef?: string; maxItems?: number } = {},
	): Promise<MemoryActiveSlate> {
		return hydrateActiveSlate({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			scope: params.scope ?? "agent",
			scopeRef: params.scopeRef ?? this.agentScopeRef,
			maxItems: params.maxItems,
		})
	}

	async buildDiscoveryProjection(
		request: MemoryDiscoveryProjectionRequest,
	): Promise<MemoryDiscoveryProjection> {
		return buildDiscoveryProjection({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			kind: request.kind,
			query: request.query,
			scope: request.scope ?? "agent",
			scopeRef: request.scopeRef ?? this.agentScopeRef,
			maxItems: request.maxItems,
			timeRange: request.timeRange,
		})
	}

	async buildContextBundle(
		request: MemoryContextBundleRequest = {},
	): Promise<MemoryContextBundle> {
		const scope = request.scope ?? "agent"
		const scopeRef =
			request.scopeRef ??
			resolveScopeRef({
				scope,
				agentId: this.agentId,
				sessionId: request.sessionId,
				workspaceDir: this.workspaceDir,
			})
		const mongoCfg = this.config.mongodb!
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const availablePaths = this.buildV2AvailablePaths(activeSources)
		const startedAt = Date.now()
		let bundleSearchTrace:
			| {
					pathsExecuted: string[]
					hitsByLane: Record<string, number>
					totalHits: number
			  }
			| undefined

		const bundle = await composeContextBundle({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			scope,
			scopeRef,
			request,
			search: async (params) => {
				const result = await searchV2(
					this.db,
					this.prefix,
					params.query,
					this.agentId,
					{
						availablePaths,
						hasEpisodes: mongoCfg.episodes.enabled,
						hasGraphData: mongoCfg.graph.enabled,
						maxResults: params.maxResults,
						searchOptions: {
							minScore: 0.1,
							numCandidates: mongoCfg.numCandidates,
							capabilities: this.capabilities,
							fusionMethod: mongoCfg.fusionMethod,
							embeddingMode: mongoCfg.embeddingMode,
							graphMaxDepth: mongoCfg.graph.maxGraphDepth,
							conversationFilter: this.buildConversationChunkFilter({
								scope: params.scope,
								scopeRef: params.scopeRef,
							}),
							bridgeFilter: this.buildScopeAwareBridgeChunkFilter(
								activeSources,
								{
									scope: params.scope,
									scopeRef: params.scopeRef,
								},
							),
							bridgeMaxResults: this.getBridgeChunkBudget(params.maxResults),
							scope: params.scope,
							scopeRef: params.scopeRef,
							conversationScope:
								params.scope === "session" && params.sessionId
									? { sessionKey: params.sessionId }
									: undefined,
							rerankConfig: mongoCfg.reranking,
							queryRewriteConfig: mongoCfg.queryRewriting,
							budget: mongoCfg.searchBudget,
						},
					},
				)
				const expandedResults =
					params.scope === "session"
						? await expandSearchContext({
								db: this.db,
								prefix: this.prefix,
								agentId: this.agentId,
								scope: params.scope,
								scopeRef: params.scopeRef,
								results: result.results,
								maxResults: params.maxResults,
							})
						: result.results
				const trustedResults = annotateResultsWithTrust(expandedResults, {
					scope: params.scope,
					scopeRef: params.scopeRef,
					sessionKey: params.scope === "session" ? params.sessionId : undefined,
				})
				bundleSearchTrace = {
					pathsExecuted: result.metadata.pathsExecuted,
					hitsByLane: result.metadata.resultsByPath,
					totalHits: trustedResults.length,
				}
				return {
					results: trustedResults,
					pathsExecuted: result.metadata.pathsExecuted,
					trustSummary: summarizeTrust(trustedResults),
				}
			},
		})
		void recordRecallTrace({
			db: this.db,
			prefix: this.prefix,
			trace: {
				agentId: this.agentId,
				query: request.query?.trim() || "(context-bundle)",
				lanesUsed:
					bundleSearchTrace?.pathsExecuted ?? bundle.metadata.pathsExecuted,
				lanesSkipped: Array.from(availablePaths).filter(
					(path) =>
						!(
							bundleSearchTrace?.pathsExecuted ?? bundle.metadata.pathsExecuted
						).includes(path),
				),
				totalHits: bundleSearchTrace?.totalHits ?? 0,
				latencyMs: Date.now() - startedAt,
				hitsByLane: bundleSearchTrace?.hitsByLane ?? {},
				topHitIds: [],
				tokenBudgetUsed: bundle.metadata.estimatedTokensUsed,
				bundleMode: request.mode ?? "full",
			},
		}).catch((err) =>
			log.warn(`buildContextBundle recall trace write failed: ${String(err)}`),
		)
		return bundle
	}

	async recallConversation(
		request: Omit<ConversationRecallRequest, "agentId">,
	): Promise<ConversationRecallResponse> {
		const nativeBitemporalVectorPrefilter =
			await this.refreshNativeBitemporalVectorPrefilter()
		return recallConversationCore({
			db: this.db,
			prefix: this.prefix,
			request: {
				...request,
				agentId: this.agentId,
			},
			vectorIndexName: `${this.prefix}events_vector`,
			textIndexName: `${this.prefix}events_text`,
			capabilities: this.capabilities,
			nativeBitemporalVectorPrefilter,
		})
	}

	private async refreshNativeBitemporalVectorPrefilter(): Promise<boolean> {
		const now = Date.now()
		if (!Number.isFinite(this.nativeBitemporalPrefilterCheckedAt)) {
			this.nativeBitemporalPrefilterCheckedAt = now
			return this.nativeBitemporalVectorPrefilter === true
		}
		if (now - this.nativeBitemporalPrefilterCheckedAt < 60_000) {
			return this.nativeBitemporalVectorPrefilter
		}
		this.nativeBitemporalPrefilterCheckedAt = now
		if (!this.capabilities.vectorSearch) {
			this.nativeBitemporalVectorPrefilter = false
			return false
		}
		try {
			const collection = eventsCollection(this.db, this.prefix)
			this.nativeBitemporalVectorPrefilter =
				await isEventsVectorBitemporalPrefilterReady(
					collection,
					`${this.prefix}events_vector`,
				)
			return this.nativeBitemporalVectorPrefilter
		} catch (err) {
			this.nativeBitemporalVectorPrefilter = false
			log.warn(
				`could not refresh native bitemporal prefilter readiness: ${String(err)}`,
			)
			return false
		}
	}

	// -----------------------------------------------------------------------
	// Reasoning chain / novelty / consolidation wrappers
	// -----------------------------------------------------------------------

	async traceChain(params: {
		factId: string
		collection: string
		options?: { maxDepth?: number }
	}) {
		return traceReasoningChain({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			factId: params.factId,
			collection: params.collection,
			options: params.options,
		})
	}

	async scanNovelty(params?: {
		limit?: number
		scope?: string
		scopeRef?: string
	}) {
		return scanNovelty({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			options: params,
		})
	}

	async consolidate(params?: {
		maxEvents?: number
		minCombinedScore?: number
		scope?: MemoryScope
		scopeRef?: string
	}) {
		const startedAt = new Date()
		const runId = randomUUID()
		const jobId = `consolidation-${runId}`
		let jobTrackingEnabled = false
		try {
			await createMemoryJob({
				db: this.db,
				prefix: this.prefix,
				job: {
					jobId,
					jobType: "consolidation",
					agentId: this.agentId,
					status: "running",
					startedAt,
					metadata: params ? { ...params } : undefined,
				},
			})
			jobTrackingEnabled = true
		} catch (err) {
			log.warn(
				`createMemoryJob failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
		try {
			const result = await consolidateMemory({
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
				options: params,
			})
			const scope = params?.scope ?? "agent"
			const scopeRef =
				params?.scopeRef ??
				resolveScopeRef({
					scope,
					agentId: this.agentId,
					workspaceDir: this.workspaceDir,
				})
			await invalidateQueryCache({
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
				scope,
				scopeRef,
			})
			if (jobTrackingEnabled) {
				try {
					await updateMemoryJob({
						db: this.db,
						prefix: this.prefix,
						jobId,
						agentId: this.agentId,
						status: "completed",
						completedAt: new Date(),
						durationMs: result.durationMs,
						inputCount: result.eventsProcessed,
						outputCount: result.factsPromoted,
						metadata: {
							...(params ? { ...params } : {}),
							runId: result.runId,
							factsPruned: result.factsPruned,
							conflictsResolved: result.conflictsResolved,
						},
					})
				} catch (err) {
					log.warn(
						`updateMemoryJob failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}
			return result
		} catch (err) {
			if (jobTrackingEnabled) {
				try {
					await updateMemoryJob({
						db: this.db,
						prefix: this.prefix,
						jobId,
						agentId: this.agentId,
						status: "failed",
						completedAt: new Date(),
						durationMs: Date.now() - startedAt.getTime(),
						error: err instanceof Error ? err.message : String(err),
						metadata: params ? { ...params } : undefined,
					})
				} catch (updateErr) {
					log.warn(
						`updateMemoryJob failed for ${jobId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
					)
				}
			}
			throw err
		}
	}

	async listRecallTraces(params?: { limit?: number }) {
		return listRecallTraces({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			limit: params?.limit,
		})
	}

	async getRecallTrace(params: { traceId: string }) {
		return getRecallTrace({
			db: this.db,
			prefix: this.prefix,
			traceId: params.traceId,
			agentId: this.agentId,
		})
	}

	async listMemoryJobs(params?: {
		status?: import("./types.js").MemoryJobStatus
		limit?: number
		jobType?: import("./types.js").MemoryJobType
	}) {
		return listMemoryJobs({
			db: this.db,
			prefix: this.prefix,
			agentId: this.agentId,
			status: params?.status,
			limit: params?.limit,
			jobType: params?.jobType,
		})
	}

	async getMemoryJob(params: { jobId: string }) {
		return getMemoryJob({
			db: this.db,
			prefix: this.prefix,
			jobId: params.jobId,
			agentId: this.agentId,
		})
	}

	private enqueueDerivedWork(task: () => Promise<void>): void {
		const run = async () => {
			try {
				await task()
			} catch (err) {
				log.warn(`derived memory work failed: ${String(err)}`)
			}
		}
		const next = this.derivationQueue.then(run, run)
		this.derivationQueue = next.then(
			() => undefined,
			() => undefined,
		)
	}

	private enqueueDerivationScheduling(task: () => Promise<void>): void {
		const run = async () => {
			try {
				await task()
			} catch (err) {
				log.warn(`derived memory scheduling failed: ${String(err)}`)
			}
		}
		const current = this.derivationSchedulingQueue ?? Promise.resolve()
		const next = current.then(run, run)
		this.derivationSchedulingQueue = next.then(
			() => undefined,
			() => undefined,
		)
	}

	private shouldRunPostWriteDerivedWork(): boolean {
		if (this.benchmarkShippedProfile) {
			return true
		}
		const mode =
			process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE?.trim().toLowerCase()
		if (
			mode === "enabled" ||
			mode === "on" ||
			mode === "1" ||
			mode === "true"
		) {
			return true
		}
		const benchmarkAgent =
			this.agentId.startsWith("benchmark-") ||
			this.agentId.startsWith("canary-")
		if (
			mode === "disabled" ||
			mode === "off" ||
			mode === "none" ||
			mode === "0" ||
			mode === "false"
		) {
			return false
		}
		if (benchmarkAgent) {
			return false
		}
		return true
	}

	private isDuplicateKeyError(err: unknown): boolean {
		if (!err || typeof err !== "object") {
			return false
		}
		const code = (err as { code?: unknown }).code
		if (code === 11000 || code === "11000") {
			return true
		}
		const message =
			err instanceof Error
				? err.message
				: typeof (err as { message?: unknown }).message === "string"
					? String((err as { message: string }).message)
					: String(err)
		return message.includes("E11000") || message.includes("duplicate key")
	}

	private async runClaimedBackgroundExtractionJob(
		job: ClaimedMemoryJob,
		prefetchedLlmFacts?: string[],
	): Promise<void> {
		const payloadEventId = job.payload?.eventId?.trim()
		const metadataEventId =
			typeof job.metadata?.eventId === "string"
				? job.metadata.eventId.trim()
				: undefined
		const eventId = payloadEventId || metadataEventId
		if (!eventId) {
			await failClaimedMemoryJob({
				db: this.db,
				prefix: this.prefix,
				jobId: job.jobId,
				agentId: this.agentId,
				leaseOwner: job.leaseOwner,
				leaseToken: job.leaseToken,
				error: "extraction job payload.eventId is required",
			})
			return
		}
		const scope = job.payload?.scope
		const scopeRef = job.payload?.scopeRef
		const runContext = this.memoryJobRunContexts?.get(job.jobId)
		const startedAt = job.startedAt ?? new Date()
		let leaseLost = false
		let heartbeatInFlight = Promise.resolve()
		const heartbeat = () => {
			heartbeatInFlight = heartbeatInFlight
				.then(async () => {
					const renewed = await renewMemoryJobLease({
						db: this.db,
						prefix: this.prefix,
						jobId: job.jobId,
						agentId: this.agentId,
						leaseOwner: job.leaseOwner,
						leaseToken: job.leaseToken,
						leaseMs: MEMORY_JOB_LEASE_MS,
					})
					if (!renewed) {
						leaseLost = true
					}
				})
				.catch((err) => {
					leaseLost = true
					log.warn(
						`memory job heartbeat failed for ${job.jobId}: ${String(err)}`,
					)
				})
		}
		const heartbeatTimer = setInterval(heartbeat, MEMORY_JOB_HEARTBEAT_MS)
		heartbeatTimer.unref?.()

		// (P2.5 b) lease fencing is enforced BEFORE every side-effecting
		// stage, not only before the terminal write: a worker that lost its
		// lease must not commit entity/derived/relation writes at all. The new
		// lease owner re-runs the job, and event-receipt idempotency
		// (hasProcessedSourceEvents, wired through
		// promoteDerivedMemoryFromEvent's eventReceiptIds) keeps that
		// re-execution free of duplicate side effects.
		const leaseFence = async (stage: string): Promise<boolean> => {
			await heartbeatInFlight
			if (leaseLost) {
				log.warn(`extraction job lease lost before ${stage}: ${job.jobId}`)
			}
			return leaseLost
		}

		try {
			const eventDoc = (await eventsCollection(this.db, this.prefix).findOne({
				eventId,
				agentId: this.agentId,
				// Tenant isolation: a scope-restricted caller can only extract from an
				// event within its authorized scope/scopeRef; a cross-scope event is
				// simply not found here.
				...(scope !== undefined ? { scope } : {}),
				...(scopeRef !== undefined ? { scopeRef } : {}),
			})) as {
				eventId: string
				agentId: string
				role: "user" | "assistant" | "system" | "tool"
				body: string
				timestamp: Date
				sessionId?: string
				scope: MemoryScope
				scopeRef: string
			} | null
			if (!eventDoc) {
				throw new Error(`event not found: ${eventId}`)
			}
			if (await leaseFence("entity extraction")) {
				return
			}
			await extractAndUpsertEntities({
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
				eventContent: eventDoc.body,
				scope: eventDoc.scope,
				scopeRef: eventDoc.scopeRef,
				sourceEventId: eventDoc.eventId,
				role: eventDoc.role,
			})

			// LLM fact extraction (issue #30): degrade to regex-only when the
			// provider is unconfigured or misconfigured.
			let enrichmentProvider: EnrichmentProvider | null = null
			try {
				enrichmentProvider = resolveEnrichmentProvider(process.env)
			} catch (err) {
				log.warn("enrichment provider resolution failed; using regex-only", {
					error: err instanceof Error ? err.message : String(err),
				})
			}
			const enrichmentModel = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
			const structuredProvider =
				enrichmentProvider && runContext
					? instrumentBenchmarkProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "structured-extraction",
							model: enrichmentModel,
						})
					: enrichmentProvider
			const temporalProvider =
				enrichmentProvider && runContext
					? instrumentBenchmarkProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "temporal-extraction",
							model: enrichmentModel,
						})
					: enrichmentProvider
			const contradictionProvider =
				enrichmentProvider && runContext
					? instrumentBenchmarkProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "contradiction-detection",
							model: enrichmentModel,
						})
					: enrichmentProvider

			if (await leaseFence("derived-memory promotion")) {
				return
			}
			const result = await promoteDerivedMemoryFromEvent({
				db: this.db,
				prefix: this.prefix,
				client: this.client,
				embeddingMode: this.config.mongodb?.embeddingMode ?? "automated",
				event: {
					...eventDoc,
					workspaceDir: this.workspaceDir,
				},
				provider: structuredProvider,
				temporalProvider,
				contradictionProvider,
				model: enrichmentModel,
				// P3.9: facts from the round's session-batched extraction; when
				// present, promotion skips its own per-event provider call.
				...(prefetchedLlmFacts ? { prefetchedLlmFacts } : {}),
			})
			await heartbeatInFlight
			if (leaseLost) {
				log.warn(`extraction job lease lost during execution: ${job.jobId}`)
				return
			}

			// Typed semantic edge extraction (issue #34): LLM-only, background-only.
			// Read the entities already upserted synchronously for this event — do
			// NOT re-extract, which would double-increment the indexed mentionCount.
			if (enrichmentProvider) {
				try {
					const eventEntities = (
						await entitiesCollection(this.db, this.prefix)
							.find(
								{
									agentId: this.agentId,
									scope: eventDoc.scope,
									scopeRef: eventDoc.scopeRef,
									sourceEventIds: eventDoc.eventId,
								},
								{ projection: { entityId: 1, name: 1, _id: 0 } },
							)
							.toArray()
					)
						.map((e) => ({
							entityId: String(e.entityId),
							name: String(e.name ?? ""),
						}))
						.filter((e) => e.entityId && e.name)
					if (eventEntities.length >= 2) {
						const relationProvider = runContext
							? instrumentBenchmarkProvider({
									provider: enrichmentProvider,
									runContext,
									operation: "relation-extraction",
									model: enrichmentModel,
								})
							: enrichmentProvider
						const relationsCreated = await extractAndUpsertTypedRelations({
							db: this.db,
							prefix: this.prefix,
							client: this.client,
							agentId: this.agentId,
							scope: eventDoc.scope,
							scopeRef: eventDoc.scopeRef,
							eventContent: eventDoc.body,
							entities: eventEntities,
							provider: relationProvider,
							model: enrichmentModel,
							sourceEventId: eventDoc.eventId,
							validFrom: eventDoc.timestamp,
						})
						// Surface the pass so silent degradation to mentioned_with-only
						// is observable rather than an invisible no-op.
						await recordProjectionRun({
							db: this.db,
							prefix: this.prefix,
							run: {
								agentId: this.agentId,
								projectionType: "relations",
								status: "ok",
								itemsProjected: relationsCreated,
								durationMs: 0,
							},
						}).catch(() => {})
					}
				} catch (err) {
					log.warn("typed relation extraction failed", { error: err })
				}
			}

			try {
				const completed = await completeClaimedMemoryJob({
					db: this.db,
					prefix: this.prefix,
					jobId: job.jobId,
					agentId: this.agentId,
					leaseOwner: job.leaseOwner,
					leaseToken: job.leaseToken,
					completedAt: new Date(),
					durationMs: Date.now() - startedAt.getTime(),
					inputCount: 1,
					outputCount: result.structuredCreated + result.proceduresCreated,
					metadata: {
						eventId,
						structuredCreated: result.structuredCreated,
						proceduresCreated: result.proceduresCreated,
						...(result.skipped
							? { skipped: true, skipReason: result.skipReason }
							: {}),
					},
				})
				if (!completed) {
					log.warn(`extraction job lease lost before completion: ${job.jobId}`)
				}
			} catch (err) {
				log.warn(
					`completeClaimedMemoryJob failed for ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		} catch (err) {
			try {
				await failClaimedMemoryJob({
					db: this.db,
					prefix: this.prefix,
					jobId: job.jobId,
					agentId: this.agentId,
					leaseOwner: job.leaseOwner,
					leaseToken: job.leaseToken,
					completedAt: new Date(),
					durationMs: Date.now() - startedAt.getTime(),
					error: err instanceof Error ? err.message : String(err),
					metadata: { eventId },
					attempts: job.attempts,
				})
			} catch (updateErr) {
				log.warn(
					`failClaimedMemoryJob failed for ${job.jobId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
				)
			}
		} finally {
			clearInterval(heartbeatTimer)
			await heartbeatInFlight
			this.memoryJobRunContexts?.delete(job.jobId)
		}
	}

	private async drainMemoryJobQueue(): Promise<void> {
		const repaired = await this.repairExtractionOutbox()
		if (repaired.eventsFailed > 0) {
			log.warn(
				`extraction outbox repair left ${repaired.eventsFailed} event(s) pending retry`,
			)
		}
		// P3.9: claim up to K jobs per round and process them concurrently.
		// Claims stay sequential findOneAndUpdate CAS operations, so two
		// rounds/workers can never claim the same job; lease fencing inside
		// the job runner is per-job and unchanged (P2.5). Within a round, LLM
		// fact extraction is batched per session (one provider call for every
		// claimed event sharing a session, mirroring enrichSessionsWithLLM).
		const concurrency = resolveMemoryJobWorkerConcurrency()
		while (!this.memoryJobWorkerStopped) {
			const jobs: ClaimedMemoryJob[] = []
			for (let claimed = 0; claimed < concurrency; claimed++) {
				const job = await claimMemoryJob({
					db: this.db,
					prefix: this.prefix,
					agentId: this.agentId,
					jobType: "extraction",
					workerId: this.memoryJobWorkerId,
					leaseMs: MEMORY_JOB_LEASE_MS,
				})
				if (!job) {
					break
				}
				jobs.push(job)
			}
			if (jobs.length === 0) {
				return
			}
			const sessionFacts = await this.prefetchExtractionSessionFacts(jobs)
			await Promise.all(
				jobs.map((job) => {
					const eventId =
						job.payload?.eventId?.trim() ||
						(typeof job.metadata?.eventId === "string"
							? job.metadata.eventId.trim()
							: "")
					return this.runClaimedBackgroundExtractionJob(
						job,
						eventId ? sessionFacts.get(eventId) : undefined,
					)
				}),
			)
		}
	}

	/**
	 * P3.9: batch the round's LLM fact extraction per session. One batched
	 * read fetches the claimed events; every group of 2+ events sharing a
	 * session gets ONE extractSessionEnrichment call whose facts are handed
	 * to each event's promotion (per-event events keep their own call inside
	 * the job runner). Purely read-only: a job that loses its lease mid-round
	 * is still fenced before any side effect — the prefetch only wastes an
	 * LLM call, never a write.
	 */
	private async prefetchExtractionSessionFacts(
		jobs: ClaimedMemoryJob[],
	): Promise<Map<string, string[]>> {
		const facts = new Map<string, string[]>()
		if (jobs.length < 2) {
			return facts
		}
		let provider: EnrichmentProvider | null = null
		try {
			provider = resolveEnrichmentProvider(process.env)
		} catch (err) {
			log.warn(
				`session-batched extraction prefetch skipped; provider resolution failed: ${err instanceof Error ? err.message : String(err)}`,
			)
			return facts
		}
		if (!provider) {
			return facts
		}
		const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

		const jobByEventId = new Map<string, ClaimedMemoryJob>()
		for (const job of jobs) {
			const eventId =
				job.payload?.eventId?.trim() ||
				(typeof job.metadata?.eventId === "string"
					? job.metadata.eventId.trim()
					: "")
			if (eventId) {
				jobByEventId.set(eventId, job)
			}
		}
		if (jobByEventId.size < 2) {
			return facts
		}

		type PrefetchEventDoc = {
			eventId: string
			sessionId?: string
			body: string
			scope: MemoryScope
			scopeRef: string
		}
		const docs = (await eventsCollection(this.db, this.prefix)
			.find(
				{
					agentId: this.agentId,
					eventId: { $in: [...jobByEventId.keys()] },
				},
				{
					projection: {
						eventId: 1,
						sessionId: 1,
						body: 1,
						scope: 1,
						scopeRef: 1,
					},
				},
			)
			.toArray()
			.catch((err) => {
				log.warn(
					`session-batched extraction prefetch read failed; falling back to per-event extraction: ${String(err)}`,
				)
				return []
			})) as unknown as PrefetchEventDoc[]
		const groups = new Map<string, PrefetchEventDoc[]>()
		for (const doc of docs) {
			if (!doc.sessionId) {
				continue
			}
			const key = `${doc.scope}::${doc.scopeRef}::${doc.sessionId}`
			const group = groups.get(key) ?? []
			group.push(doc)
			groups.set(key, group)
		}
		const eligible = [...groups.values()].filter((group) => group.length >= 2)
		await Promise.all(
			eligible.map(async (group) => {
				const sessionText = group
					.map((doc) => doc.body)
					.filter((body) => body.trim().length > 0)
					.join("\n")
				if (!sessionText) {
					return
				}
				// Benchmark accounting parity with the per-event path: instrument
				// with the first group member's run context when one is registered.
				const firstJob = jobByEventId.get(group[0].eventId)
				const runContext = firstJob
					? this.memoryJobRunContexts?.get(firstJob.jobId)
					: undefined
				const structuredProvider = runContext
					? instrumentBenchmarkProvider({
							provider,
							runContext,
							operation: "structured-extraction",
							model,
						})
					: provider
				try {
					const enrichment = await extractSessionEnrichment(
						structuredProvider,
						sessionText,
						model,
					)
					if (enrichment.facts.length === 0) {
						return
					}
					for (const doc of group) {
						facts.set(doc.eventId, enrichment.facts)
					}
				} catch (err) {
					log.warn(
						`session-batched LLM extraction failed for ${group.length} event(s); falling back to per-event extraction: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}),
		)
		return facts
	}

	private wakeMemoryJobWorker(): void {
		if (this.memoryJobWorkerStopped) {
			return
		}
		if (this.memoryJobWorkerActive) {
			this.memoryJobWakeRequested = true
			return
		}
		this.memoryJobWorkerActive = true
		this.memoryJobWakeRequested = false
		const run = this.drainMemoryJobQueue().catch((err) => {
			log.warn(`memory job worker failed: ${String(err)}`)
		})
		this.memoryJobWorkerPromise = run.finally(() => {
			this.memoryJobWorkerActive = false
			if (this.memoryJobWakeRequested) {
				this.wakeMemoryJobWorker()
			}
		})
	}

	private startMemoryJobWorker(): void {
		// (P2.5 e) never (re)start the worker during/after shutdown — a write
		// drained by close() stages its extraction job for the NEXT boot's
		// outbox repair instead of reviving a stopped worker mid-close.
		if (this.closed) {
			return
		}
		if (!this.memoryJobWorkerStopped && this.memoryJobWorkerTimer) {
			return
		}
		this.memoryJobWorkerStopped = false
		this.wakeMemoryJobWorker()
		this.memoryJobWorkerTimer = setInterval(() => {
			this.wakeMemoryJobWorker()
		}, resolveMemoryJobSweepMs())
		this.memoryJobWorkerTimer.unref?.()
	}

	private async stopMemoryJobWorker(): Promise<void> {
		this.memoryJobWorkerStopped = true
		this.memoryJobWakeRequested = false
		if (this.memoryJobWorkerTimer) {
			clearInterval(this.memoryJobWorkerTimer)
			this.memoryJobWorkerTimer = null
		}
		await this.memoryJobWorkerPromise
	}

	private async scheduleBackgroundExtraction(
		eventId: string,
		tenant?: { scope?: MemoryScope; scopeRef?: string },
		runContext?: BenchmarkRunContext,
	): Promise<{ jobId: string; scheduled: boolean }> {
		// (P2.5 e) shutdown intake stop: scheduling after close would stage a
		// job and wake workers that close() is stopping.
		if (this.closed) {
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to schedule extraction",
			)
		}
		const jobId = `extraction-${eventId}`
		const payload = {
			eventId,
			...(tenant?.scope !== undefined ? { scope: tenant.scope } : {}),
			...(tenant?.scopeRef !== undefined ? { scopeRef: tenant.scopeRef } : {}),
		}
		try {
			await createMemoryJob({
				db: this.db,
				prefix: this.prefix,
				job: {
					jobId,
					jobType: "extraction",
					agentId: this.agentId,
					status: "pending",
					metadata: { eventId },
					payload,
				},
			})
		} catch (err) {
			if (this.isDuplicateKeyError(err)) {
				const existing = await getMemoryJob({
					db: this.db,
					prefix: this.prefix,
					jobId,
					agentId: this.agentId,
				})
				let recoverable =
					existing?.status === "pending" ||
					(existing?.status === "running" &&
						(existing.leaseExpiresAt === undefined ||
							existing.leaseExpiresAt.getTime() <= Date.now()))
				if (existing?.status === "failed") {
					recoverable = await retryFailedMemoryJob({
						db: this.db,
						prefix: this.prefix,
						jobId,
						agentId: this.agentId,
						payload,
						metadata: { eventId },
					})
				}
				if (!recoverable) {
					// (P2.5 e) a terminal job state (completed, or failed without a
					// recoverable retry) will never be claimed by this manager —
					// drop any stale benchmark run context instead of leaking the
					// entry for the process lifetime.
					this.memoryJobRunContexts?.delete(jobId)
					return { jobId, scheduled: false }
				}
			} else {
				throw err
			}
		}

		if (runContext) {
			this.memoryJobRunContexts ??= new Map<string, BenchmarkRunContext>()
			this.memoryJobRunContexts.set(jobId, runContext)
		}
		if (this.memoryJobWorkerStopped) {
			this.startMemoryJobWorker()
		} else {
			this.wakeMemoryJobWorker()
		}
		return { jobId, scheduled: true }
	}

	private async schedulePostWriteDerivations(params: {
		eventId: string
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		timestamp: Date
		scope: MemoryScope
		scopeRef: string
		runContext?: BenchmarkRunContext
	}): Promise<void> {
		const mongoCfg = this.config.mongodb
		if (!mongoCfg) {
			return
		}
		if (!this.shouldRunPostWriteDerivedWork()) {
			return
		}

		if (!mongoCfg.episodes.enabled) {
			return
		}

		this.enqueueDerivedWork(async () => {
			const triggerThreshold = Math.max(
				1,
				mongoCfg.episodes.minEventsForEpisode - 1,
			)
			try {
				const episodeResult = await checkAutoEpisodeTriggers({
					db: this.db,
					prefix: this.prefix,
					agentId: this.agentId,
					summarizer: heuristicEpisodeSummarizer,
					scope: params.scope,
					scopeRef: params.scopeRef,
					maxEventsWithoutEpisode: triggerThreshold,
				})
				// Update episodic lane coverage when an episode is materialized
				if (episodeResult.triggered) {
					await updateLaneCoverage({
						db: this.db,
						prefix: this.prefix,
						agentId: this.agentId,
						increments: { episodic: 1 },
					}).catch((coverageErr) => {
						log.warn(
							`episodic lane coverage update failed: ${String(coverageErr)}`,
						)
					})
				}
			} catch (err) {
				log.warn(
					`auto episode trigger failed after event write: ${String(err)}`,
				)
			}
		})
	}

	/**
	 * Fingerprint used to detect key-reuse-with-different-payload (IETF §2.7).
	 * scope/scopeRef are compared AFTER resolution so an explicit scopeRef and
	 * the equivalent resolved one count as the same payload.
	 */
	private resolveIdempotencyFingerprint(event: {
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		scope?: MemoryScope
		scopeRef?: string
	}): {
		role: string
		body: string
		sessionId?: string
		scope: MemoryScope
		scopeRef: string
	} {
		// P2.3: the fingerprint must resolve scope with the SAME rule the write
		// itself uses, or a retried implicit-session write would mismatch the
		// stored document and surface as a false 422 conflict.
		const { scope, scopeRef } = resolveScopeIdentity({
			scope: event.scope,
			scopeRef: event.scopeRef,
			agentId: this.agentId,
			sessionId: event.sessionId,
		})
		return {
			role: event.role,
			body: event.body,
			sessionId: event.sessionId,
			scope,
			scopeRef,
		}
	}

	/**
	 * Idempotency replay (IETF Idempotency-Key / Stripe): a retry carrying a
	 * known key returns the original write's receipt instead of duplicating
	 * the event. chunkCreated reports false because the chunk projection from
	 * the accepted write already exists (replaying the request does not create
	 * a second one). Key reuse with a different payload is a 422 conflict.
	 */
	private async replayIdempotentEventWrite(params: {
		idempotencyKey: string
		event: {
			role: "user" | "assistant" | "system" | "tool"
			body: string
			sessionId?: string
			scope?: MemoryScope
			scopeRef?: string
		}
	}): Promise<{ eventId: string; chunkCreated: boolean } | null> {
		const existing = (await eventsCollection(this.db, this.prefix).findOne({
			agentId: this.agentId,
			idempotencyKey: params.idempotencyKey,
		})) as CanonicalEvent | null
		if (!existing) {
			return null
		}
		const incoming = this.resolveIdempotencyFingerprint(params.event)
		const samePayload =
			existing.role === incoming.role &&
			existing.body === incoming.body &&
			(existing.sessionId ?? undefined) === incoming.sessionId &&
			existing.scope === incoming.scope &&
			existing.scopeRef === incoming.scopeRef
		if (!samePayload) {
			throw new IdempotencyConflictError(params.idempotencyKey)
		}
		return { eventId: existing.eventId, chunkCreated: false }
	}

	async writeConversationEvent(
		event: WriteConversationEventInput,
		benchmarkRunContext?: BenchmarkRunContext,
	): Promise<{ eventId: string; chunkCreated: boolean }> {
		// (P2.5 e) shutdown intake stop: once close() begins, no new writes
		// enter the queue — a write queued during shutdown would schedule
		// extraction jobs and derivations on workers that are stopping.
		if (this.closed) {
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to queue a new write",
			)
		}
		const execute = async () => {
			if (event.idempotencyKey) {
				const replay = await this.replayIdempotentEventWrite({
					idempotencyKey: event.idempotencyKey,
					event,
				})
				if (replay) {
					return replay
				}
			}
			const eventId = randomUUID()
			// P2.3: the write side of the canonical identity rule — an implicit
			// sessionId lands the event in the SAME session scope a sessionKey
			// search reads from (previously writes fell through to "agent").
			const { scope } = resolveScopeIdentity({
				scope: event.scope,
				agentId: this.agentId,
				sessionId: event.sessionId,
			})
			const postWriteDerivedWorkEnabled = this.shouldRunPostWriteDerivedWork()
			const extractionJobPendingAt = postWriteDerivedWorkEnabled
				? new Date()
				: undefined
			const persistEvent = (session?: ClientSession) =>
				writeEvent({
					db: this.db,
					prefix: this.prefix,
					...(session ? { session } : {}),
					event: {
						eventId,
						agentId: this.agentId,
						sessionId: event.sessionId,
						role: event.role,
						body: event.body,
						scope,
						scopeRef: event.scopeRef,
						timestamp: event.timestamp,
						validAt: event.validAt,
						invalidAt: event.invalidAt,
						metadata: event.metadata,
						idempotencyKey: event.idempotencyKey,
						extractionJobPendingAt,
					},
				})
			const stageExtractionJob = async (
				written: Awaited<ReturnType<typeof writeEvent>>,
				session?: ClientSession,
			) => {
				await createMemoryJob({
					db: this.db,
					prefix: this.prefix,
					...(session ? { session } : {}),
					job: {
						jobId: `extraction-${written.eventId}`,
						jobType: "extraction",
						agentId: this.agentId,
						status: "pending",
						stagedAt: extractionJobPendingAt,
						metadata: { eventId: written.eventId },
						payload: {
							eventId: written.eventId,
							scope,
							scopeRef: written.scopeRef,
						},
					},
				})
			}
			let written: Awaited<ReturnType<typeof writeEvent>>
			try {
				if (postWriteDerivedWorkEnabled && this.client) {
					const session = this.client.startSession()
					try {
						let transactionalWrite:
							| Awaited<ReturnType<typeof writeEvent>>
							| undefined
						await session.withTransaction(async () => {
							transactionalWrite = await persistEvent(session)
							await stageExtractionJob(transactionalWrite, session)
						}, MAJORITY_TRANSACTION_OPTIONS)
						if (!transactionalWrite) {
							throw new Error(
								"event and extraction job transaction returned no event",
							)
						}
						written = transactionalWrite
					} catch (err) {
						if (!isTransactionUnsupported(err)) {
							throw err
						}
						log.info(
							"transactions unavailable for event extraction outbox; using direct writes",
						)
						written = await persistEvent()
						await stageExtractionJob(written)
					} finally {
						await session.endSession()
					}
				} else {
					written = await persistEvent()
					if (postWriteDerivedWorkEnabled) {
						await stageExtractionJob(written)
					}
				}
			} catch (err) {
				if (event.idempotencyKey && isDuplicateKeyError(err)) {
					// Lost race: a concurrent request carrying the same key committed
					// first and uq_events_agent_idempotency_key rejected our insert.
					// Replay the winner's receipt (Stripe: same key, same result).
					const replay = await this.replayIdempotentEventWrite({
						idempotencyKey: event.idempotencyKey,
						event,
					})
					if (replay) {
						return replay
					}
				}
				throw err
			}
			const projected = await projectEventChunk({
				db: this.db,
				prefix: this.prefix,
				event: {
					eventId: written.eventId,
					agentId: this.agentId,
					role: event.role,
					body: event.body,
					scope,
					scopeRef: written.scopeRef,
					timestamp: written.timestamp,
					validAt: event.validAt ?? written.timestamp,
					...(event.invalidAt ? { invalidAt: event.invalidAt } : {}),
					...(event.sessionId ? { sessionId: event.sessionId } : {}),
					...(event.metadata ? { metadata: event.metadata } : {}),
				},
			})
			if (projected.chunkCreated) {
				this.chunkCount += 1
			}
			// Entity extraction (sync rule-based, non-blocking)
			let entityCount = 0
			if (postWriteDerivedWorkEnabled) {
				try {
					const entityResult = await extractAndUpsertEntities({
						db: this.db,
						prefix: this.prefix,
						agentId: this.agentId,
						eventContent: event.body,
						scope,
						scopeRef: written.scopeRef,
						sourceEventId: written.eventId,
					})
					entityCount = entityResult.entities.length
				} catch (err) {
					log.warn("entity extraction failed after event write", { error: err })
				}
			}
			if (postWriteDerivedWorkEnabled) {
				const jobId = `extraction-${written.eventId}`
				if (benchmarkRunContext) {
					this.memoryJobRunContexts.set(jobId, benchmarkRunContext)
				}
				const released = await releaseStagedMemoryJob({
					db: this.db,
					prefix: this.prefix,
					jobId,
					agentId: this.agentId,
				})
				let clearPendingMarker = released
				if (!released) {
					const existing = await getMemoryJob({
						db: this.db,
						prefix: this.prefix,
						jobId,
						agentId: this.agentId,
					})
					if (
						!existing ||
						(existing.status === "pending" && Boolean(existing.stagedAt))
					) {
						// P0.1: the event is already committed — throwing here turned a
						// fully durable write into a client-visible 500 that invited
						// duplicate retries. Leave extractionJobPendingAt SET so
						// repairExtractionOutbox (which exists for exactly this) re-stages
						// the job, and acknowledge the write.
						this.memoryJobRunContexts.delete(jobId)
						clearPendingMarker = false
						log.warn(
							`staged extraction job ${jobId} was not released; leaving the outbox marker set for the repair pass`,
						)
					}
				}
				if (clearPendingMarker) {
					try {
						await clearEventExtractionJobPending({
							db: this.db,
							prefix: this.prefix,
							eventId: written.eventId,
							agentId: this.agentId,
						})
					} catch (err) {
						log.warn(
							`extraction outbox cleanup failed for ${written.eventId}: ${String(err)}`,
						)
					}
				}
				if (this.memoryJobWorkerStopped) {
					this.startMemoryJobWorker()
				} else {
					this.wakeMemoryJobWorker()
				}
			}

			await this.schedulePostWriteDerivations({
				eventId: written.eventId,
				role: event.role,
				body: event.body,
				sessionId: event.sessionId,
				timestamp: written.timestamp,
				scope,
				scopeRef: written.scopeRef,
				runContext: benchmarkRunContext,
			})

			// P2.4: the hot write path coalesces invalidation — a burst of
			// writes collapses into a leading + single trailing scope-level
			// delete instead of a deleteMany per write (which drove the cache
			// hit rate to ~0 and put an extra round trip on every write).
			this.scheduleQueryCacheInvalidation({
				agentId: this.agentId,
				scope,
				scopeRef: written.scopeRef,
			})

			// Lane coverage tracking (non-blocking)
			// Note: episodic lane coverage is handled asynchronously inside
			// schedulePostWriteDerivations when checkAutoEpisodeTriggers fires.
			try {
				const increments: Record<string, number> = {
					"raw-window": 1,
					hybrid: projected.chunkCreated ? 1 : 0,
				}
				if (entityCount > 0) {
					increments.graph = entityCount
				}
				// Regex-only on purpose: this is a synchronous coverage counter on
				// the hot write path. The LLM-augmented promotion (issue #30) runs
				// in the background job, so this count is a cheap regex lower bound,
				// not a blocking LLM call duplicated per event. P3.9: count by
				// regex/classification ONLY — the promotion resolver did a
				// per-candidate findOne existence check (N+1) and the counts only
				// feed planner hints, never durable writes.
				const candidates = postWriteDerivedWorkEnabled
					? extractStructuredCandidatesFromEvent({
							eventId: written.eventId,
							agentId: this.agentId,
							role: event.role,
							body: event.body,
							timestamp: written.timestamp,
							sessionId: event.sessionId,
							scope,
							scopeRef: written.scopeRef,
						})
					: []
				if (candidates.length > 0) {
					increments.structured = candidates.length
				}
				const criticalCount = candidates.filter(
					(c) => c.salience === "critical" || c.salience === "high",
				).length
				if (criticalCount > 0) {
					increments["active-critical"] = criticalCount
				}
				const procedureCandidates = postWriteDerivedWorkEnabled
					? extractProcedureCandidatesFromEvent({
							eventId: written.eventId,
							agentId: this.agentId,
							role: event.role,
							body: event.body,
							timestamp: written.timestamp,
							sessionId: event.sessionId,
							scope,
							scopeRef: written.scopeRef,
						})
					: []
				if (procedureCandidates.length > 0) {
					increments.procedural = procedureCandidates.length
				}
				await updateLaneCoverage({
					db: this.db,
					prefix: this.prefix,
					agentId: this.agentId,
					increments,
				})
			} catch (err) {
				log.warn("lane coverage update failed after event write", {
					error: err instanceof Error ? err.message : String(err),
				})
			}

			this.dirty = false
			return { eventId: written.eventId, chunkCreated: projected.chunkCreated }
		}

		const next = this.writeQueue.then(execute, execute)
		this.writeQueue = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	/**
	 * P3.9: batch variant of writeConversationEvent. The whole batch occupies
	 * ONE slot in the per-agent write queue (ordering against single writes is
	 * preserved) and amortizes round trips: one batched idempotency lookup,
	 * one insertMany for events, one bulkWrite for chunk projection, one
	 * insertMany for extraction jobs, one updateMany clearing outbox markers,
	 * and one aggregated lane-coverage update. Per-item receipts mirror the
	 * single-write receipt shape; a failed item never fails its siblings.
	 */
	async writeConversationEventsBatch(
		events: WriteConversationEventInput[],
		benchmarkRunContext?: BenchmarkRunContext,
	): Promise<WriteConversationEventReceipt[]> {
		// (P2.5 e) shutdown intake stop: same contract as the single write.
		if (this.closed) {
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to queue a new write",
			)
		}
		const execute = async (): Promise<WriteConversationEventReceipt[]> => {
			const receipts: Array<WriteConversationEventReceipt | undefined> =
				events.map(() => undefined)

			// 1. Batched idempotency replay: ONE $in lookup for every key in the
			// batch instead of a findOne per keyed write (P0.1 semantics per
			// item: same key + same payload replays; different payload conflicts).
			const keyedIndexes = events
				.map((event, index) => ({ event, index }))
				.filter(({ event }) => Boolean(event.idempotencyKey))
			if (keyedIndexes.length > 0) {
				const keys = [
					...new Set(
						keyedIndexes.map(({ event }) => event.idempotencyKey as string),
					),
				]
				const existing = (await eventsCollection(this.db, this.prefix)
					.find({ agentId: this.agentId, idempotencyKey: { $in: keys } })
					.toArray()) as unknown as CanonicalEvent[]
				const byKey = new Map(
					existing.map((doc) => [doc.idempotencyKey as string, doc]),
				)
				for (const { event, index } of keyedIndexes) {
					const doc = byKey.get(event.idempotencyKey as string)
					if (!doc) {
						continue
					}
					const incoming = this.resolveIdempotencyFingerprint(event)
					const samePayload =
						doc.role === incoming.role &&
						doc.body === incoming.body &&
						(doc.sessionId ?? undefined) === incoming.sessionId &&
						doc.scope === incoming.scope &&
						doc.scopeRef === incoming.scopeRef
					receipts[index] = samePayload
						? {
								ok: true,
								eventId: doc.eventId,
								chunkCreated: false,
								replayed: true,
							}
						: {
								ok: false,
								code: "IDEMPOTENCY_CONFLICT",
								message: `idempotency key "${event.idempotencyKey}" was reused with a different payload`,
							}
				}
			}

			// 2. Build the write set for the non-replayed items.
			const postWriteDerivedWorkEnabled = this.shouldRunPostWriteDerivedWork()
			const extractionJobPendingAt = postWriteDerivedWorkEnabled
				? new Date()
				: undefined
			type PendingItem = {
				index: number
				input: WriteConversationEventInput
				eventId: string
				scope: MemoryScope
			}
			const pending: PendingItem[] = []
			for (const [index, input] of events.entries()) {
				if (receipts[index]) {
					continue
				}
				// P2.3: same canonical identity rule as the single write.
				const { scope } = resolveScopeIdentity({
					scope: input.scope,
					agentId: this.agentId,
					sessionId: input.sessionId,
				})
				pending.push({ index, input, eventId: randomUUID(), scope })
			}

			// 3. ONE insertMany for the whole batch (unordered: a per-item
			// failure — validation or an E11000 idempotency race — does not
			// abort its siblings).
			const writeResults = await writeEventsBatch({
				db: this.db,
				prefix: this.prefix,
				events: pending.map(({ input, eventId, scope }) => ({
					eventId,
					agentId: this.agentId,
					sessionId: input.sessionId,
					role: input.role,
					body: input.body,
					scope,
					scopeRef: input.scopeRef,
					timestamp: input.timestamp,
					validAt: input.validAt,
					invalidAt: input.invalidAt,
					metadata: input.metadata,
					idempotencyKey: input.idempotencyKey,
					extractionJobPendingAt,
				})),
			})
			const written: Array<
				PendingItem & { timestamp: Date; scopeRef: string }
			> = []
			for (const [position, result] of writeResults.entries()) {
				const item = pending[position]
				if (result.ok) {
					written.push({
						...item,
						timestamp: result.timestamp,
						scopeRef: result.scopeRef,
					})
					continue
				}
				if (result.duplicateKey && item.input.idempotencyKey) {
					// Lost race: a concurrent same-key write committed first. Replay
					// the winner's receipt (Stripe: same key, same result); a payload
					// mismatch is a per-item 422-style conflict.
					try {
						const replay = await this.replayIdempotentEventWrite({
							idempotencyKey: item.input.idempotencyKey,
							event: item.input,
						})
						if (replay) {
							receipts[item.index] = {
								ok: true,
								eventId: replay.eventId,
								chunkCreated: false,
								replayed: true,
							}
							continue
						}
					} catch (err) {
						if (err instanceof IdempotencyConflictError) {
							receipts[item.index] = {
								ok: false,
								code: "IDEMPOTENCY_CONFLICT",
								message: err.message,
							}
							continue
						}
						throw err
					}
				}
				receipts[item.index] = {
					ok: false,
					code: "WRITE_ERROR",
					message: result.message,
				}
			}

			// 4. ONE bulkWrite for chunk projection + ONE updateMany marking the
			// events projected. A projection failure degrades to
			// chunkCreated:false without failing the (already durable) writes —
			// the projection repair pass recovers them.
			if (written.length > 0) {
				const chunkResults = await projectEventChunksBatch({
					db: this.db,
					prefix: this.prefix,
					events: written.map((item) => ({
						eventId: item.eventId,
						agentId: this.agentId,
						role: item.input.role,
						body: item.input.body,
						scope: item.scope,
						scopeRef: item.scopeRef,
						timestamp: item.timestamp,
						validAt: item.input.validAt ?? item.timestamp,
						...(item.input.invalidAt
							? { invalidAt: item.input.invalidAt }
							: {}),
						...(item.input.sessionId
							? { sessionId: item.input.sessionId }
							: {}),
						...(item.input.metadata ? { metadata: item.input.metadata } : {}),
					})),
				})
				for (const [position, item] of written.entries()) {
					const chunkCreated = chunkResults[position]?.chunkCreated ?? false
					if (chunkCreated) {
						this.chunkCount += 1
					}
					receipts[item.index] = {
						ok: true,
						eventId: item.eventId,
						chunkCreated,
					}
				}
			}

			// 5. Entity extraction per item (sync rule-based, non-blocking) —
			// same derived-work contract as the single write; feeds the graph
			// lane coverage increment below.
			const entityCounts = new Map<number, number>()
			if (postWriteDerivedWorkEnabled) {
				for (const item of written) {
					try {
						const entityResult = await extractAndUpsertEntities({
							db: this.db,
							prefix: this.prefix,
							agentId: this.agentId,
							eventContent: item.input.body,
							scope: item.scope,
							scopeRef: item.scopeRef,
							sourceEventId: item.eventId,
						})
						entityCounts.set(item.index, entityResult.entities.length)
					} catch (err) {
						log.warn("entity extraction failed after batch event write", {
							error: err,
						})
					}
				}
			}

			// 6. ONE insertMany for the extraction jobs (directly claimable —
			// the batch has no transaction to stage through), then ONE
			// updateMany clearing the outbox markers for events whose job is
			// durable. A failed job insert leaves the marker set for the outbox
			// repair pass, the same recovery contract as the single path.
			if (postWriteDerivedWorkEnabled && written.length > 0) {
				const jobResults = await createMemoryJobsBatch({
					db: this.db,
					prefix: this.prefix,
					jobs: written.map((item) => ({
						jobId: `extraction-${item.eventId}`,
						jobType: "extraction" as const,
						agentId: this.agentId,
						status: "pending" as const,
						metadata: { eventId: item.eventId },
						payload: {
							eventId: item.eventId,
							scope: item.scope,
							scopeRef: item.scopeRef,
						},
					})),
				})
				const claimableEventIds: string[] = []
				for (const [position, jobResult] of jobResults.entries()) {
					const item = written[position]
					// A duplicate means the deterministic extraction-<eventId> job
					// already exists (pre-created by /v1/extract or a prior attempt)
					// and is claimable — satisfied, not an error.
					if (jobResult.ok || jobResult.duplicate) {
						claimableEventIds.push(item.eventId)
						if (benchmarkRunContext) {
							this.memoryJobRunContexts.set(
								`extraction-${item.eventId}`,
								benchmarkRunContext,
							)
						}
					} else {
						log.warn(
							`batch extraction job insert failed for ${item.eventId}; leaving the outbox marker for the repair pass: ${jobResult.message}`,
						)
					}
				}
				if (claimableEventIds.length > 0) {
					try {
						await clearEventExtractionJobPendingBatch({
							db: this.db,
							prefix: this.prefix,
							eventIds: claimableEventIds,
							agentId: this.agentId,
						})
					} catch (err) {
						log.warn(`batch extraction outbox cleanup failed: ${String(err)}`)
					}
				}
				if (this.memoryJobWorkerStopped) {
					this.startMemoryJobWorker()
				} else {
					this.wakeMemoryJobWorker()
				}
			}

			// 7. Post-write derivations + coalesced query-cache invalidation
			// per item (in-process scheduling queues, no extra round trips).
			for (const item of written) {
				await this.schedulePostWriteDerivations({
					eventId: item.eventId,
					role: item.input.role,
					body: item.input.body,
					sessionId: item.input.sessionId,
					timestamp: item.timestamp,
					scope: item.scope,
					scopeRef: item.scopeRef,
					runContext: benchmarkRunContext,
				})
				this.scheduleQueryCacheInvalidation({
					agentId: this.agentId,
					scope: item.scope,
					scopeRef: item.scopeRef,
				})
			}

			// 8. Lane coverage: aggregate the per-item increments across the
			// batch into ONE update. Regex-only candidate counting (P3.9) — the
			// counts only feed planner hints.
			try {
				const increments: Record<string, number> = {}
				const bump = (lane: string, by: number) => {
					if (by > 0) {
						increments[lane] = (increments[lane] ?? 0) + by
					}
				}
				for (const item of written) {
					bump("raw-window", 1)
					const receipt = receipts[item.index]
					bump("hybrid", receipt && receipt.ok && receipt.chunkCreated ? 1 : 0)
					bump("graph", entityCounts.get(item.index) ?? 0)
					if (postWriteDerivedWorkEnabled) {
						const candidates = extractStructuredCandidatesFromEvent({
							eventId: item.eventId,
							agentId: this.agentId,
							role: item.input.role,
							body: item.input.body,
							timestamp: item.timestamp,
							sessionId: item.input.sessionId,
							scope: item.scope,
							scopeRef: item.scopeRef,
						})
						bump("structured", candidates.length)
						bump(
							"active-critical",
							candidates.filter(
								(c) => c.salience === "critical" || c.salience === "high",
							).length,
						)
						bump(
							"procedural",
							extractProcedureCandidatesFromEvent({
								eventId: item.eventId,
								agentId: this.agentId,
								role: item.input.role,
								body: item.input.body,
								timestamp: item.timestamp,
								sessionId: item.input.sessionId,
								scope: item.scope,
								scopeRef: item.scopeRef,
							}).length,
						)
					}
				}
				if (written.length > 0) {
					await updateLaneCoverage({
						db: this.db,
						prefix: this.prefix,
						agentId: this.agentId,
						increments,
					})
				}
			} catch (err) {
				log.warn("lane coverage update failed after batch event write", {
					error: err instanceof Error ? err.message : String(err),
				})
			}

			this.dirty = false
			return receipts.map(
				(receipt): WriteConversationEventReceipt =>
					receipt ?? {
						ok: false,
						code: "WRITE_ERROR",
						message: "event write not attempted",
					},
			)
		}

		const next = this.writeQueue.then(execute, execute)
		this.writeQueue = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	async extractEvent(params: {
		eventId: string
		scope?: MemoryScope
		scopeRef?: string
	}) {
		const eventId = params.eventId.trim()
		if (!eventId) {
			throw new Error("eventId is required")
		}
		// Tenant isolation: a scope-restricted caller may only extract from an event
		// within its authorized scope/scopeRef. Enforce ownership SYNCHRONOUSLY here,
		// before scheduling — the deterministic `extraction-${eventId}` job is often
		// pre-created by the write path, so a scope check inside the background job
		// would dedup away and never run.
		if (params.scope !== undefined || params.scopeRef !== undefined) {
			const owned = await eventsCollection(this.db, this.prefix).findOne(
				{
					eventId,
					agentId: this.agentId,
					...(params.scope !== undefined ? { scope: params.scope } : {}),
					...(params.scopeRef !== undefined
						? { scopeRef: params.scopeRef }
						: {}),
				},
				{ projection: { _id: 1 } },
			)
			if (!owned) {
				const err = new Error(`event not found: ${eventId}`)
				err.name = "EventNotInScopeError"
				throw err
			}
		}
		return this.scheduleBackgroundExtraction(eventId, {
			scope: params.scope,
			scopeRef: params.scopeRef,
		})
	}

	// ---------------------------------------------------------------------------
	// Analytics: getMemoryStats
	// ---------------------------------------------------------------------------

	async stats(): Promise<MemoryStats> {
		const embeddingMode = this.config.mongodb?.embeddingMode ?? "automated"
		return getMemoryStats(this.db, this.prefix, undefined, { embeddingMode })
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.close
	// ---------------------------------------------------------------------------

	async close(): Promise<void> {
		if (this.closed) {
			return
		}
		this.closed = true

		// Clear the debounced sync timer
		if (this.watchTimer) {
			clearTimeout(this.watchTimer)
			this.watchTimer = null
		}

		// (P2.5 e) shutdown ordering: intake is now stopped (closed — sync()
		// no-ops and writeConversationEvent throws). Drain everything ALREADY
		// queued BEFORE stopping the workers: a queued write stages extraction
		// jobs and post-write derivations, so awaiting the writeQueue only
		// after watcher/worker shutdown let queued writes schedule work on
		// stopped workers.
		if (this.syncing) {
			try {
				await this.syncing
			} catch {
				// Ignore sync errors during close — already logged in runSync
			}
		}
		await this.writeQueue
		await this.derivationSchedulingQueue
		await this.derivationQueue
		await this.stopMemoryJobWorker()
		// (P2.5 e) benchmark run contexts for never-claimed jobs are moot once
		// the worker has stopped; drop them instead of leaking the entries.
		this.memoryJobRunContexts?.clear()

		// Close the file watcher
		if (this.watcher) {
			try {
				await this.watcher.close()
			} catch {
				// Ignore watcher close errors
			}
			this.watcher = null
		}

		// Close the change stream watcher
		if (this.changeStreamWatcher) {
			const token = this.changeStreamWatcher.lastResumeToken
			if (token !== undefined && token !== null) {
				await this.persistChangeStreamResumeToken(token)
			}
			try {
				await this.changeStreamWatcher.close()
			} catch {
				// Ignore change stream close errors
			}
			this.changeStreamWatcher = null
		}

		// Flush and close access tracker. Never swallow failures silently
		// (Bridge close durability): closing can lose buffered access events.
		// If the flush fails we at least surface it via log.warn with context
		// so the reviewer/hunter can grep for it and downstream operators can
		// alert on it; the tracker reference is still cleared afterward so the
		// close sequence is idempotent.
		if (this.accessTracker) {
			try {
				await this.accessTracker.close()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(`accessTracker close failed: ${msg}`)
			}
			this.accessTracker = null
		}

		// Close the MongoDB connection — but only when this manager owns it.
		// Shared clients (MEMONGO_SHARED_CLIENT) are owned by the process-level
		// registry and released via onClosed instead.
		if (this.ownsClient !== false) {
			try {
				await this.client.close()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(`error closing MongoDB connection: ${msg}`)
			}
		}
		try {
			this.onClosed?.()
		} catch (err) {
			log.warn(`onClosed hook failed: ${String(err)}`)
		}
	}
}

function getAccessSummariesOrEmpty(params: {
	db: Db
	prefix: string
	agentId: string
	collection: AccessEventCollection
	memoryIds: string[]
	windowDays?: number
}) {
	const memoryIds = params.memoryIds.filter(
		(memoryId) => memoryId.trim().length > 0,
	)
	if (memoryIds.length === 0) {
		return Promise.resolve([])
	}
	return listAccessSummaries({
		db: params.db,
		prefix: params.prefix,
		agentId: params.agentId,
		collection: params.collection,
		memoryIds,
		windowDays: params.windowDays,
	})
}

// ---------------------------------------------------------------------------
// Phase 8: v2 standalone functions — write, search, status
// ---------------------------------------------------------------------------

/**
 * Write an event and project it to chunks. Records an ingest run on success or failure.
 * Standalone function following the v2 module pattern (db, prefix, ...).
 */
export async function writeEventAndProject(
	db: Db,
	prefix: string,
	event: {
		agentId: string
		role: string
		body: string
		scope: string
		sessionId?: string
		path?: string
		hash?: string
		metadata?: Record<string, unknown>
	},
	options?: {
		extractor?: import("./mongodb-entity-extractor.js").EntityExtractor
	},
): Promise<{ eventId: string; chunksCreated: number }> {
	const startMs = Date.now()
	try {
		// Validate scope and role before passing to writeEvent
		if (!VALID_SCOPES.has(event.scope)) {
			throw new Error(`Invalid scope: ${event.scope}`)
		}
		if (!VALID_ROLES.has(event.role)) {
			throw new Error(`Invalid role: ${event.role}`)
		}
		const written = await writeEvent({
			db,
			prefix,
			event: {
				eventId: randomUUID(),
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				scope: event.scope as MemoryScope,
				sessionId: event.sessionId,
				channel: undefined,
				metadata: event.metadata,
			},
		})

		const projected = await projectEventChunk({
			db,
			prefix,
			event: {
				eventId: written.eventId,
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
				timestamp: written.timestamp,
				...(event.sessionId ? { sessionId: event.sessionId } : {}),
				...(event.metadata ? { metadata: event.metadata } : {}),
			},
		})
		// Entity extraction (sync rule-based, non-blocking)
		let entityCount = 0
		try {
			const entityResult = await extractAndUpsertEntities({
				db,
				prefix,
				agentId: event.agentId,
				eventContent: event.body,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
				sourceEventId: written.eventId,
				extractor: options?.extractor,
			})
			entityCount = entityResult.entities.length
		} catch (err) {
			log.warn("entity extraction failed during writeEventAndProject", {
				error: err instanceof Error ? err.message : String(err),
				eventId: written.eventId,
			})
		}

		// Structured fact + procedure extraction (sync rule-based, non-blocking).
		// LLM-augmented promotion (issue #30) intentionally runs only in the
		// manager's background memory-job path (runBackgroundExtractionJob), never
		// inline here — extractSessionEnrichment is a 30s-timeout network call and
		// this function promotes synchronously on the write path.
		try {
			await promoteDerivedMemoryFromEvent({
				db,
				prefix,
				client: undefined,
				embeddingMode: "automated",
				event: {
					eventId: written.eventId,
					agentId: event.agentId,
					role: event.role as "user" | "assistant" | "system" | "tool",
					body: event.body,
					timestamp: written.timestamp,
					sessionId: event.sessionId,
					scope: event.scope as MemoryScope,
					scopeRef: written.scopeRef,
				},
			})
		} catch (err) {
			log.warn(
				"structured/procedure extraction failed during writeEventAndProject",
				{ error: err, eventId: written.eventId },
			)
		}

		// Episode trigger check (sync, non-blocking)
		// MUST capture result: episodeTriggered drives episodic lane coverage.
		let episodeTriggered = false
		try {
			const episodeResult = await checkAutoEpisodeTriggers({
				db,
				prefix,
				agentId: event.agentId,
				summarizer: heuristicEpisodeSummarizer,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
			})
			episodeTriggered = episodeResult.triggered
		} catch (err) {
			log.warn("episode trigger check failed during writeEventAndProject", {
				error: err instanceof Error ? err.message : String(err),
				eventId: written.eventId,
			})
		}

		// Lane coverage tracking (non-blocking)
		try {
			const increments: Record<string, number> = {
				"raw-window": 1, // every event populates raw-window
				hybrid: projected.chunkCreated ? 1 : 0,
			}
			if (entityCount > 0) {
				increments.graph = entityCount
			}
			// Structured lane counts regex/classification candidates only (P3.9):
			// the promotion resolver did a per-candidate findOne existence check
			// (N+1) and the counts only feed planner hints, never durable writes.
			// Regex-only, matching this function.s regex-only promotion above.
			const candidates = extractStructuredCandidatesFromEvent({
				eventId: written.eventId,
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				timestamp: written.timestamp,
				sessionId: event.sessionId,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
			})
			if (candidates.length > 0) {
				increments.structured = candidates.length
			}
			// Active-critical: check candidates for salience
			const criticalCount = candidates.filter(
				(c) => c.salience === "critical" || c.salience === "high",
			).length
			if (criticalCount > 0) {
				increments["active-critical"] = criticalCount
			}
			// Procedure lane: use candidate count from re-extraction
			const procedureCandidates = extractProcedureCandidatesFromEvent({
				eventId: written.eventId,
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				timestamp: written.timestamp,
				sessionId: event.sessionId,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
			})
			if (procedureCandidates.length > 0) {
				increments.procedural = procedureCandidates.length
			}
			// Episodic lane: from captured checkAutoEpisodeTriggers result
			if (episodeTriggered) {
				increments.episodic = 1
			}
			await updateLaneCoverage({
				db,
				prefix,
				agentId: event.agentId,
				increments,
			})
		} catch (err) {
			log.warn("lane coverage update failed during writeEventAndProject", {
				error: err instanceof Error ? err.message : String(err),
				eventId: written.eventId,
			})
		}

		const durationMs = Date.now() - startMs
		await recordIngestRun({
			db,
			prefix,
			run: {
				agentId: event.agentId,
				source: "event-write",
				status: "ok",
				itemsProcessed: 1,
				itemsFailed: 0,
				durationMs,
			},
		})

		// Emit event-write telemetry (fire-and-forget)
		emitTelemetry(db, prefix, {
			meta: { agentId: event.agentId, operation: "event-write" },
			durationMs,
			ok: true,
			eventType: event.role,
			projectionTriggered: true,
		})

		return {
			eventId: written.eventId,
			chunksCreated: projected.chunkCreated ? 1 : 0,
		}
	} catch (err) {
		const durationMs = Date.now() - startMs
		await recordIngestRun({
			db,
			prefix,
			run: {
				agentId: event.agentId,
				source: "event-write",
				status: "failed",
				itemsProcessed: 0,
				itemsFailed: 1,
				durationMs,
			},
		}).catch((recErr) => {
			log.warn("recordIngestRun failed during error recovery", {
				error: recErr,
			})
		})
		log.error("writeEventAndProject failed", { error: err })
		throw err
	}
}

// ---------------------------------------------------------------------------
// v2 search types
// ---------------------------------------------------------------------------

export type V2SearchMetadata = {
	plan: RetrievalPlan
	pathsExecuted: RetrievalPath[]
	resultsByPath: Record<string, number>
	reranked?: boolean
	queryRewritten?: boolean
	laneControls?: ReturnType<typeof applyLaneAwareResultControls>["summary"]
	/** #66: wall-clock ms per executed lane, hybrid sub-lane, and serial backstop. */
	latencyByPath?: Record<string, number>
	/**
	 * P3.2: per-request cost ledger (aggregations + server-side embeddings
	 * consumed, and whether the storm budget was hit). See
	 * mongodb-search-budget.ts.
	 */
	budget?: SearchBudgetSnapshot
}

const GRAPH_QUERY_STOPWORDS = new Set([
	"a",
	"about",
	"and",
	"for",
	"how",
	"in",
	"is",
	"of",
	"on",
	"or",
	"the",
	"to",
	"what",
	"who",
])

function graphRelationPriority(type: RelationType): number {
	switch (type) {
		case "works_on":
		case "owns":
		case "depends_on":
		case "blocked_by":
		case "decided":
		case "reported_by":
			return 4
		case "related_to":
			return 3
		case "mentioned_with":
		default:
			return 1
	}
}

function entityMatchScore(entity: Entity, query: string): number {
	const normalizedQuery = query.trim().toLowerCase()
	const normalizedName = entity.name.trim().toLowerCase()
	if (!normalizedQuery || !normalizedName) {
		return 0
	}
	if (normalizedQuery === normalizedName) {
		return 10
	}
	if (normalizedQuery.includes(normalizedName)) {
		return 8
	}
	if (normalizedName.includes(normalizedQuery)) {
		return 6
	}
	const aliasMatch = entity.aliases?.some((alias) => {
		const normalizedAlias = alias.trim().toLowerCase()
		return (
			normalizedAlias === normalizedQuery ||
			normalizedQuery.includes(normalizedAlias)
		)
	})
	if (aliasMatch) {
		return 7
	}
	return 1
}

function pickBestEntityMatch(
	candidates: Entity[],
	query: string,
): Entity | null {
	if (candidates.length === 0) {
		return null
	}
	return (
		[...candidates].toSorted((a, b) => {
			const scoreDiff = entityMatchScore(b, query) - entityMatchScore(a, query)
			if (scoreDiff !== 0) {
				return scoreDiff
			}
			const recencyDiff =
				(b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0) -
				(a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0)
			if (recencyDiff !== 0) {
				return recencyDiff
			}
			return a.name.localeCompare(b.name)
		})[0] ?? null
	)
}

function buildGraphQueryCandidates(query: string): string[] {
	const candidates = new Set<string>()
	const add = (value: string | undefined) => {
		const trimmed = value?.trim()
		if (
			trimmed &&
			trimmed.length >= 2 &&
			!GRAPH_QUERY_STOPWORDS.has(trimmed.toLowerCase())
		) {
			candidates.add(trimmed)
		}
	}

	for (const match of query.matchAll(/"([^"]+)"/g)) {
		add(match[1])
	}
	for (const match of query.matchAll(/[@#]([A-Za-z0-9_./-]+)/g)) {
		add(match[1])
	}
	for (const match of query.matchAll(
		/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g,
	)) {
		add(match[0])
	}

	if (candidates.size < 2) {
		const words = query
			.split(/\s+/)
			.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
			.filter(
				(word) =>
					word.length >= 3 && !GRAPH_QUERY_STOPWORDS.has(word.toLowerCase()),
			)
		for (const word of words.slice(0, 6)) {
			add(word)
		}
	}

	return Array.from(candidates).slice(0, 6)
}

function isTrustedPlannerEntityCandidate(
	candidate: string,
	query: string,
): boolean {
	const trimmed = candidate.trim()
	if (!trimmed) {
		return false
	}
	if (/\s/.test(trimmed) || /[./_-]/.test(trimmed)) {
		return true
	}
	if (/^\p{Lu}/u.test(trimmed)) {
		return true
	}
	const lowerQuery = query.toLowerCase()
	const lowerCandidate = trimmed.toLowerCase()
	return (
		lowerQuery.includes(`"${lowerCandidate}"`) ||
		lowerQuery.includes(`@${lowerCandidate}`) ||
		lowerQuery.includes(`#${lowerCandidate}`)
	)
}

const RAW_WINDOW_QUERY_STOPWORDS = new Set([
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"whose",
	"why",
	"how",
	"is",
	"are",
	"was",
	"were",
	"do",
	"does",
	"did",
	"the",
	"a",
	"an",
	"this",
	"that",
	"these",
	"those",
	"in",
	"on",
	"for",
	"with",
	"to",
	"from",
	"of",
	"my",
	"our",
	"your",
	"current",
	"exactly",
	"please",
	"thread",
])

function extractRawWindowQueryTerms(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9-]+/i)
				.map((part) => part.trim())
				.filter(
					(part) => part.length >= 3 && !RAW_WINDOW_QUERY_STOPWORDS.has(part),
				),
		),
	)
}

function computeRawWindowEventQueryScore(
	body: string,
	queryTerms: string[],
): number {
	if (queryTerms.length === 0) {
		return 0
	}
	const haystack = body.toLowerCase()
	let score = 0
	for (const term of queryTerms) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		if (new RegExp(`\\b${escaped}\\b`, "i").test(haystack)) {
			score += term.includes("-") || /\d/.test(term) ? 5 : 1
		}
	}
	return score
}

/**
 * Execute a v2 retrieval plan: call planRetrieval, execute top 3 paths, deduplicate results.
 * Each path has its own try/catch so one failure doesn't kill the whole search.
 */
/**
 * P3.1: the conversation and bridge chunk lanes read the SAME collection
 * with the SAME query text, and under autoEmbed each $vectorSearch re-embeds
 * that text server-side — two lanes cost two paid embeddings per request.
 * When both filters pin the same identity fields they differ only in the
 * `source` set, so they fuse into ONE lane with the union of sources: one
 * aggregation, one embedding. Structurally incompatible filters (different
 * identity, non-$in source sets) keep the split lanes — a fusion must never
 * widen or narrow either read. Returns undefined when fusion is unsafe.
 */
function fuseChunkLaneFilters(
	conversation: Document,
	bridge: Document | undefined,
): Document | undefined {
	if (!bridge) {
		return conversation
	}
	for (const key of ["agentId", "scope", "scopeRef", "status"] as const) {
		if (JSON.stringify(conversation[key]) !== JSON.stringify(bridge[key])) {
			return undefined
		}
	}
	const conversationSources = (conversation.source as { $in?: unknown[] })?.$in
	const bridgeSources = (bridge.source as { $in?: unknown[] })?.$in
	if (!Array.isArray(conversationSources) || !Array.isArray(bridgeSources)) {
		return undefined
	}
	return {
		...conversation,
		source: { $in: [...new Set([...conversationSources, ...bridgeSources])] },
	}
}

/**
 * searchV2 entry point: opens the per-request cost budget (P3.2) that every
 * lane, waterfall stage, and backstop consumes. When a budget is already
 * active — the recursive hybrid backstop re-entering searchV2 — the call
 * shares it instead of opening a fresh one, so a backstop can never reset
 * the storm counter.
 */
export async function searchV2(
	db: Db,
	prefix: string,
	query: string,
	agentId: string,
	context: SearchV2Context,
): Promise<{ results: MemorySearchResult[]; metadata: V2SearchMetadata }> {
	if (hasActiveSearchBudget()) {
		const value = await searchV2WithBudget(db, prefix, query, agentId, context)
		return {
			results: value.results,
			metadata: {
				...value.metadata,
				...(getSearchBudgetSnapshot()
					? { budget: getSearchBudgetSnapshot() }
					: {}),
			},
		}
	}
	const limits = resolveSearchBudgetLimits(context.searchOptions?.budget)
	const { value, budget } = await runWithSearchBudget(limits, () =>
		searchV2WithBudget(db, prefix, query, agentId, context),
	)
	return { results: value.results, metadata: { ...value.metadata, budget } }
}

export type SearchV2Context = {
	availablePaths: Set<RetrievalPath>
	knownEntityNames?: string[]
	hasEpisodes?: boolean
	hasGraphData?: boolean
	maxResults?: number
	searchOptions?: {
		minScore?: number
		sessionKey?: string
		numCandidates?: number
		capabilities?: DetectedCapabilities
		fusionMethod?: ResolvedMongoDBConfig["fusionMethod"]
		embeddingMode?: ResolvedMongoDBConfig["embeddingMode"]
		conversationFilter?: Document
		bridgeFilter?: Document
		bridgeMaxResults?: number
		scope?: MemoryScope
		scopeRef?: string
		allowHybridBackstop?: boolean
		rerankConfig?: RerankConfig
		queryRewriteConfig?: QueryRewriteConfig
		projection?: "full" | "ids-only"
		sourcePreference?: MemorySearchRequest["sourcePreference"]
		needExactEvidence?: boolean
		timeRange?: MemorySearchRequest["timeRange"]
		conversationScope?: MemorySearchRequest["conversationScope"]
		structuredScope?: MemorySearchRequest["structuredScope"]
		referenceScope?: MemorySearchRequest["referenceScope"]
		proceduralScope?: MemorySearchRequest["proceduralScope"]
		graphMaxDepth?: number
		searchConfig?: ResolvedSearchConfig
		questionDate?: Date
		benchmarkRunContext?: BenchmarkRunContext
		/** P3.2: per-request cost budget overrides (resolved over defaults). */
		budget?: Partial<SearchBudgetLimits>
	}
}

async function searchV2WithBudget(
	db: Db,
	prefix: string,
	query: string,
	agentId: string,
	context: SearchV2Context,
): Promise<{ results: MemorySearchResult[]; metadata: V2SearchMetadata }> {
	try {
		const graphQueryCandidates =
			context.knownEntityNames && context.knownEntityNames.length > 0
				? context.knownEntityNames
				: buildGraphQueryCandidates(query)
		// P1.4 + P2.3: searchV2 is the single retrieval funnel; direct callers
		// get the same identity rule (explicit scope > sessionKey implies
		// "session" > env-resolved default) so they cannot bypass it.
		const { scope, scopeRef: agentScopeRef } = resolveScopeIdentity({
			scope: context.searchOptions?.scope,
			scopeRef: context.searchOptions?.scopeRef,
			agentId,
			sessionId: context.searchOptions?.sessionKey,
			defaultScope: resolveSearchDefaultScope(
				process.env.MEMONGO_SEARCH_DEFAULT_SCOPE,
			),
		})
		const sessionMode = resolveSessionEvidenceMode(
			process.env.MEMONGO_SESSION_EVIDENCE_MODE,
		)
		const chunkSources = ["conversation", "sessions"]
		if (sessionMode === "A") {
			chunkSources.push("session-evidence")
		}
		const userfactMode = resolveUserfactEvidenceMode(
			process.env.MEMONGO_USERFACT_EVIDENCE_MODE,
			process.env.MEMONGO_PREFERENCE_EVIDENCE_MODE,
		)
		if (userfactMode === "enabled") {
			chunkSources.push("userfact-evidence", "preference-evidence")
		}
		const enrichmentMode = resolveEnrichmentMode(
			process.env.MEMONGO_LLM_ENRICHMENT_MODE,
		)
		if (enrichmentMode === "enabled") {
			if (!chunkSources.includes("userfact-evidence")) {
				chunkSources.push("userfact-evidence")
			}
			chunkSources.push("qa-evidence")
		} else if (enrichmentMode === "facts-only") {
			if (!chunkSources.includes("userfact-evidence")) {
				chunkSources.push("userfact-evidence")
			}
		}
		const conversationChunkFilter: Document = context.searchOptions
			?.conversationFilter ?? {
			source: { $in: chunkSources },
			agentId,
			status: { $ne: "deleted" },
		}
		const bridgeChunkFilter = context.searchOptions?.bridgeFilter
		const maxResults = context.maxResults ?? 20
		const minScore = context.searchOptions?.minScore ?? 0.01
		const numCandidates = context.searchOptions?.numCandidates ?? 500
		const capabilities = context.searchOptions?.capabilities ?? {
			vectorSearch: true,
			textSearch: true,
			scoreFusion: false,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		}
		const fusionMethod = context.searchOptions?.fusionMethod ?? "rankFusion"
		const embeddingMode = context.searchOptions?.embeddingMode ?? "automated"
		const hybridMode =
			context.searchOptions?.searchConfig?.hybridMode ?? "hybrid"
		const bridgeMaxResults =
			context.searchOptions?.bridgeMaxResults ??
			Math.max(2, Math.ceil(maxResults / 3))
		const allowHybridBackstop =
			context.searchOptions?.allowHybridBackstop ?? true

		// #66: measurement only — records elapsed ms per lane and per non-lane
		// phase without changing what runs. `finally` so a span that throws still
		// reports its cost.
		const latencyByPath: Record<string, number> = {}
		const timeLane = async <T>(
			laneKey: string,
			run: () => Promise<T>,
		): Promise<T> => {
			const laneStartedAt = Date.now()
			try {
				return await run()
			} finally {
				latencyByPath[laneKey] = Date.now() - laneStartedAt
			}
		}

		// Load lane coverage for planner (non-blocking: fallback to no coverage on error)
		const planStartedAt = Date.now()
		let laneCoverage:
			| Record<
					string,
					{ hasData: boolean; count: number; lastUpdated: Date | null }
			  >
			| undefined
		// P3.2: distinguishes "coverage read failed" (backstops keep the old
		// behavior) from "coverage read succeeded and there is no data" (a
		// cold tenant — backstops must not fire, empty ≠ error).
		let laneCoverageLoaded = false
		try {
			const coverageDoc = await getLaneCoverage({ db, prefix, agentId })
			laneCoverageLoaded = true
			if (coverageDoc) {
				laneCoverage = coverageDoc.lanes
			}
		} catch (err) {
			log.warn("Failed to load lane coverage for planner", {
				error: err instanceof Error ? err.message : String(err),
				agentId,
			})
		}
		/**
		 * P3.2 — "empty ≠ error" (fix-plan-2026-08-03, Appendix C): escalation
		 * machinery (search backstops) fires only when lane coverage says data
		 * EXISTS. A coverage read failure keeps the old permissive behavior; a
		 * cold tenant (no coverage document, or hasData=false) never triggers
		 * a re-run — its empty answer stands.
		 */
		const laneHasData = (lane: string): boolean =>
			!laneCoverageLoaded || laneCoverage?.[lane]?.hasData === true

		const plan = planRetrieval(query, {
			availablePaths: context.availablePaths,
			knownEntityNames:
				context.knownEntityNames && context.knownEntityNames.length > 0
					? context.knownEntityNames
					: graphQueryCandidates.filter((candidate) =>
							isTrustedPlannerEntityCandidate(candidate, query),
						),
			hasEpisodes: context.hasEpisodes,
			hasGraphData: context.hasGraphData,
			laneCoverage,
			intent: {
				needExactEvidence: context.searchOptions?.needExactEvidence,
				sourcePreference: context.searchOptions?.sourcePreference,
				timeRange: context.searchOptions?.timeRange,
				conversationScope: context.searchOptions?.conversationScope,
				structuredScope: context.searchOptions?.structuredScope,
				referenceScope: context.searchOptions?.referenceScope,
				proceduralScope: context.searchOptions?.proceduralScope,
			},
		})
		latencyByPath["phase:plan"] = Date.now() - planStartedAt

		// Rewrite query for search execution (NOT for planner or cache key):
		const qrConfig = context.searchOptions?.queryRewriteConfig
		let searchQuery = query
		let wasQueryRewritten = false
		if (qrConfig?.enabled) {
			const rewriteResult = await timeLane("phase:rewrite", () =>
				rewriteQuery({
					db,
					prefix,
					agentId,
					query,
					config: qrConfig,
				}),
			)
			if (rewriteResult.rewritten) {
				searchQuery = rewriteResult.rewrittenQuery
				wasQueryRewritten = true
			}
		}

		const constrainedGraphCandidates =
			plan.constraints?.entities?.names &&
			plan.constraints.entities.names.length > 0
				? plan.constraints.entities.names
				: graphQueryCandidates
		const timeRange = plan.constraints?.timeRange
			? resolveTimeRangePreset(plan.constraints.timeRange.preset)
			: undefined
		const normalizedStructuredState = normalizeStructuredState(
			context.searchOptions?.structuredScope?.state,
		)
		const normalizedStructuredSalience = normalizeStructuredSalience(
			context.searchOptions?.structuredScope?.salience,
		)
		const normalizedProceduralState = normalizeProcedureState(
			context.searchOptions?.proceduralScope?.state,
		)
		const structuredCurrentOnly = Array.isArray(normalizedStructuredState)
			? !normalizedStructuredState.includes("invalidated")
			: normalizedStructuredState !== "invalidated"
		const proceduralCurrentOnly = normalizedProceduralState !== "invalidated"
		const structuredFilter: {
			agentId: string
			scope?: MemoryScope
			scopeRef?: string
			type?: string
			state?: StructuredMemoryState | StructuredMemoryState[]
			salience?: StructuredMemorySalience[]
			currentOnly?: boolean
			asOf?: Date
		} = {
			agentId,
			scope,
			scopeRef: agentScopeRef,
			...(normalizedStructuredState
				? { state: normalizedStructuredState }
				: {}),
			...(normalizedStructuredSalience
				? { salience: normalizedStructuredSalience }
				: {}),
			...(structuredCurrentOnly
				? { currentOnly: true, asOf: timeRange?.end }
				: {}),
			...(plan.constraints?.structured?.type
				? { type: plan.constraints.structured.type }
				: context.searchOptions?.structuredScope?.type
					? { type: context.searchOptions.structuredScope.type }
					: {}),
		}
		const activeCriticalFilter = {
			agentId,
			scope,
			scopeRef: agentScopeRef,
			state: "active" as const,
			salience:
				plan.constraints?.activeCritical?.salience ??
				(["critical", "high"] as const),
			currentOnly: true,
			asOf: timeRange?.end,
		}
		const proceduralFilter: {
			agentId: string
			scope?: MemoryScope
			scopeRef?: string
			state?: ProcedureState
			intentTags?: string[]
			currentOnly?: boolean
			asOf?: Date
		} = {
			agentId,
			scope,
			scopeRef: agentScopeRef,
			state: normalizedProceduralState ?? ("active" as const),
			...(proceduralCurrentOnly
				? { currentOnly: true, asOf: timeRange?.end }
				: {}),
			...(context.searchOptions?.proceduralScope?.intentTags?.length
				? { intentTags: context.searchOptions.proceduralScope.intentTags }
				: {}),
		}
		const kbFilter = {
			...(context.searchOptions?.referenceScope?.source
				? { source: context.searchOptions.referenceScope.source }
				: {}),
			...(context.searchOptions?.referenceScope?.category
				? { category: context.searchOptions.referenceScope.category }
				: {}),
			...(context.searchOptions?.referenceScope?.tags?.length
				? { tags: context.searchOptions.referenceScope.tags }
				: {}),
			...(plan.constraints?.kb?.source
				? { source: plan.constraints.kb.source }
				: {}),
			...(plan.constraints?.kb?.category
				? { category: plan.constraints.kb.category }
				: {}),
		}

		const results: MemorySearchResult[] = []
		const pathsExecuted: RetrievalPath[] = []
		const resultsByPath: Record<string, number> = {}
		// C3 audit fix: track per-path results for RRF score normalization
		const perPathResults: Record<string, MemorySearchResult[]> = {}

		// Execute the top planned paths first, but keep hybrid as the backstop when
		// specialized paths come back weak or empty. Intersect with availablePaths
		// (the planner already filters; a stubbed planner in tests does not) and
		// honor the planner contract that hybrid is the baseline lane whenever it
		// is available — a search must never silently execute zero lanes while
		// hybrid is on the table.
		const plannedPaths = plan.paths.filter((path) =>
			context.availablePaths.has(path),
		)
		const pathsToExecute = (
			plannedPaths.length > 0
				? plannedPaths
				: context.availablePaths.has("hybrid")
					? (["hybrid"] as RetrievalPath[])
					: []
		).slice(0, 3)

		// Each path is an independent read over its own collections, and most
		// pay a server-side embedding round-trip inside $vectorSearch — run
		// serially the loop costs the SUM of its lanes (3.5s measured on
		// Atlas). Execute concurrently; merge in plan order below so ranking
		// stays deterministic.
		const executeSearchPath = async (
			path: RetrievalPath,
		): Promise<MemorySearchResult[]> => {
			try {
				let pathResults: MemorySearchResult[] = []

				switch (path) {
					case "active-critical": {
						const criticalHits = await searchStructuredMemory(
							structuredMemCollection(db, prefix),
							searchQuery,
							null,
							{
								maxResults: context.maxResults ?? 10,
								minScore,
								filter: activeCriticalFilter,
								numCandidates,
								capabilities,
								vectorIndexName: `${prefix}structured_mem_vector`,
								embeddingMode,
							},
						).catch((err) => {
							log.warn(`searchV2 active-critical path failed: ${String(err)}`)
							return [] as MemorySearchResult[]
						})
						pathResults = criticalHits
						break
					}
					case "structured": {
						const structuredHits = await searchStructuredMemory(
							structuredMemCollection(db, prefix),
							searchQuery,
							null,
							{
								maxResults: context.maxResults ?? 10,
								minScore,
								filter: structuredFilter,
								numCandidates,
								capabilities,
								vectorIndexName: `${prefix}structured_mem_vector`,
								embeddingMode,
							},
						).catch((err) => {
							log.warn(`searchV2 structured path failed: ${String(err)}`)
							return [] as MemorySearchResult[]
						})
						pathResults = structuredHits
						break
					}
					case "raw-window": {
						// M2 audit fix: cap raw-window events at 50 to avoid unbounded result sets
						const rawWindowLimit = 50
						const events = await getEventsByTimeRange({
							db,
							prefix,
							agentId,
							start:
								timeRange?.start ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
							end: timeRange?.end ?? new Date(),
							scope,
							scopeRef: agentScopeRef,
							limit: rawWindowLimit,
						})
						const queryTerms = extractRawWindowQueryTerms(query)
						const scoredEvents = events.map((event) => ({
							event,
							matchScore: computeRawWindowEventQueryScore(
								event.body,
								queryTerms,
							),
						}))
						const hasRelevantEvents = scoredEvents.some(
							(entry) => entry.matchScore > 0,
						)
						const rankedEvents = scoredEvents
							.filter((entry) => !hasRelevantEvents || entry.matchScore > 0)
							.toSorted((left, right) => {
								if (right.matchScore !== left.matchScore) {
									return right.matchScore - left.matchScore
								}
								return (
									right.event.timestamp.getTime() -
									left.event.timestamp.getTime()
								)
							})
						pathResults = rankedEvents.map(({ event: e, matchScore }, i) => ({
							path: `events/${e.eventId}`,
							filePath: `events/${e.eventId}`,
							startLine: 0,
							endLine: 0,
							snippet: e.body,
							score: Math.max(
								0.35,
								1 - i * 0.01 + Math.min(matchScore * 0.03, 0.12),
							),
							canonicalId: `event:${e.eventId}`,
							source: "conversation" as MemorySource,
							...(e.sessionId ? { sessionId: e.sessionId } : {}),
							timestamp: e.timestamp,
							scope: e.scope,
							scopeRef: e.scopeRef,
							sourceEventIds: [e.eventId],
							sourceReliability: 0.95,
							reinforcementCount: 1,
							// P3.7 wiring: the denormalized reinforcement counter the
							// access tracker maintains on the event document, surfaced
							// so the post-CE access boost can modulate ranking.
							...(typeof e.accessCount === "number"
								? { accessCount: e.accessCount }
								: {}),
							provenance: {
								lane: "raw-window",
								eventId: e.eventId,
								sourceEventIds: [e.eventId],
							},
						}))
						break
					}
					case "graph": {
						if (constrainedGraphCandidates.length > 0) {
							const candidateEntities = (
								await Promise.all(
									constrainedGraphCandidates.slice(0, 4).map((name) =>
										searchEntitiesAutocomplete({
											db,
											prefix,
											query: name,
											agentId,
											scope,
											scopeRef: agentScopeRef,
											limit: 5,
											// P3.8: route through entity_autocomplete $search only when
											// mongot is present; otherwise the escaped $regex fallback.
											textSearchAvailable: capabilities.textSearch,
										}),
									),
								)
							).flat()
							const entity = pickBestEntityMatch(candidateEntities, query)
							if (entity) {
								const graph = await expandGraph({
									db,
									prefix,
									entityId: entity.entityId,
									agentId,
									scope,
									scopeRef: agentScopeRef,
									asOf: timeRange?.end,
									...(context.searchOptions?.graphMaxDepth != null
										? { maxDepth: context.searchOptions.graphMaxDepth }
										: {}),
								})
								if (graph) {
									pathResults = graph.connections.map((c, i) => ({
										path: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}`,
										filePath: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}`,
										startLine: 0,
										endLine: 0,
										snippet: `${graph.rootEntity.name} ${c.relation.type} ${c.entity.name}`,
										score: Math.min(
											1.0,
											Math.max(
												0.25,
												0.9 -
													c.depth * 0.08 -
													i * 0.02 -
													(4 - graphRelationPriority(c.relation.type)) * 0.05,
											) + Math.min(c.relation.weight ?? 0, 0.15),
										),
										canonicalId: `relation:${c.relation.fromEntityId}:${c.relation.type}:${c.relation.toEntityId}`,
										source: "conversation" as MemorySource,
										timestamp: c.relation.updatedAt,
										scope: c.relation.scope,
										scopeRef: c.relation.scopeRef,
										state: c.relation.state,
										provenance: c.relation.provenance,
										sourceEventIds: c.relation.sourceEventIds,
										sourceReliability: c.relation.sourceReliability,
										reinforcementCount: c.relation.reinforcementCount,
										validFrom: c.relation.validFrom,
										validTo: c.relation.validTo,
										reviewAt: c.relation.reviewAt,
										lastConfirmedAt: c.relation.lastConfirmedAt,
									}))
								}
							}
						}
						break
					}
					case "episodic": {
						// Use original query for episodic search (synonym expansion breaks matching)
						const episodes = await searchEpisodes({
							db,
							prefix,
							query,
							agentId,
							scope,
							scopeRef: agentScopeRef,
							...(timeRange ? { timeRange } : {}),
							// P3.8: route through episode_autocomplete $search only when
							// mongot is present; otherwise the escaped $regex fallback.
							textSearchAvailable: capabilities.textSearch,
						})
						pathResults = episodes.map((ep, i) => ({
							path: `episode:${ep.episodeId}`,
							filePath: `episode:${ep.episodeId}`,
							startLine: 0,
							endLine: 0,
							snippet: `${ep.title}: ${ep.summary}`,
							score: 0.85 - i * 0.01,
							canonicalId: `episode:${ep.episodeId}`,
							source: "conversation" as MemorySource,
							timestamp: ep.timeRange.end,
							scope: ep.scope,
							scopeRef: ep.scopeRef,
							sourceEventIds: ep.sourceEventIds,
							sourceReliability: 0.82,
							reinforcementCount: ep.sourceEventCount,
							provenance: {
								lane: "episodic",
								sourceEventIds: ep.sourceEventIds ?? [],
								sourceEventCount: ep.sourceEventCount,
							},
						}))
						break
					}
					case "procedural": {
						const procedureHits = await searchProcedures(
							proceduresCollection(db, prefix),
							searchQuery,
							null,
							{
								maxResults: context.maxResults ?? 10,
								minScore,
								filter: proceduralFilter,
								numCandidates,
								capabilities,
								vectorIndexName: `${prefix}procedures_vector`,
								textIndexName: `${prefix}procedures_text`,
								embeddingMode,
							},
						).catch((err) => {
							log.warn(`searchV2 procedural path failed: ${String(err)}`)
							return [] as MemorySearchResult[]
						})
						pathResults = procedureHits
						break
					}
					case "hybrid": {
						if (!capabilities.vectorSearch && !capabilities.textSearch) {
							pathResults = []
							break
						}
						const searches: Array<Promise<MemorySearchResult[]>> = []
						// P3.1: the conversation and bridge lanes read the same
						// collection with the same query text, and under autoEmbed
						// every $vectorSearch embeds that text server-side — two
						// lanes cost two paid embeddings per request. When both
						// filters pin the same identity they differ only in the
						// `source` set, so fuse them into ONE lane with the union of
						// sources: one aggregation, one embedding. The bridge budget
						// folds into the lane's (larger) conversation budget; the
						// results were merged into one pool downstream anyway.
						// Incompatible filters keep the split lanes below — a fusion
						// must never widen or narrow either read.
						const fusedChunkFilter = conversationChunkFilter
							? fuseChunkLaneFilters(conversationChunkFilter, bridgeChunkFilter)
							: undefined
						if (fusedChunkFilter) {
							searches.push(
								timeLane("hybrid:chunks", () =>
									(hybridMode === "vector-only"
										? vectorSearch(chunksCollection(db, prefix), null, {
												maxResults: context.maxResults ?? 10,
												minScore,
												numCandidates,
												sessionKey: context.searchOptions?.sessionKey,
												filter: fusedChunkFilter,
												indexName: `${prefix}chunks_vector`,
												queryText: searchQuery,
												embeddingMode,
											})
										: mongoSearch(
												chunksCollection(db, prefix),
												searchQuery,
												null,
												{
													maxResults: context.maxResults ?? 10,
													minScore,
													numCandidates,
													sessionKey: context.searchOptions?.sessionKey,
													filter: fusedChunkFilter,
													fusionMethod,
													capabilities,
													vectorIndexName: `${prefix}chunks_vector`,
													textIndexName: `${prefix}chunks_text`,
													vectorWeight: 0.7,
													textWeight: 0.3,
													embeddingMode,
												},
											)
									).catch((err) => {
										if (isBenchmarkStrictMode()) {
											throw err
										}
										log.warn(
											`searchV2 hybrid chunks path failed: ${String(err)}`,
										)
										return [] as MemorySearchResult[]
									}),
								),
							)
						} else if (conversationChunkFilter) {
							searches.push(
								timeLane("hybrid:chunks", () =>
									(hybridMode === "vector-only"
										? vectorSearch(chunksCollection(db, prefix), null, {
												maxResults: context.maxResults ?? 10,
												minScore,
												numCandidates,
												sessionKey: context.searchOptions?.sessionKey,
												filter: conversationChunkFilter,
												indexName: `${prefix}chunks_vector`,
												queryText: searchQuery,
												embeddingMode,
											})
										: mongoSearch(
												chunksCollection(db, prefix),
												searchQuery,
												null,
												{
													maxResults: context.maxResults ?? 10,
													minScore,
													numCandidates,
													sessionKey: context.searchOptions?.sessionKey,
													filter: conversationChunkFilter,
													fusionMethod,
													capabilities,
													vectorIndexName: `${prefix}chunks_vector`,
													textIndexName: `${prefix}chunks_text`,
													vectorWeight: 0.7,
													textWeight: 0.3,
													embeddingMode,
												},
											)
									).catch((err) => {
										if (isBenchmarkStrictMode()) {
											throw err
										}
										log.warn(
											`searchV2 hybrid conversation path failed: ${String(err)}`,
										)
										return [] as MemorySearchResult[]
									}),
								),
							)
						}
						if (!fusedChunkFilter && bridgeChunkFilter) {
							searches.push(
								timeLane("hybrid:bridge", () =>
									(hybridMode === "vector-only"
										? vectorSearch(chunksCollection(db, prefix), null, {
												maxResults: bridgeMaxResults,
												minScore,
												numCandidates,
												sessionKey: context.searchOptions?.sessionKey,
												filter: bridgeChunkFilter,
												indexName: `${prefix}chunks_vector`,
												queryText: searchQuery,
												embeddingMode,
											})
										: mongoSearch(
												chunksCollection(db, prefix),
												searchQuery,
												null,
												{
													maxResults: bridgeMaxResults,
													minScore,
													numCandidates,
													sessionKey: context.searchOptions?.sessionKey,
													filter: bridgeChunkFilter,
													fusionMethod,
													capabilities,
													vectorIndexName: `${prefix}chunks_vector`,
													textIndexName: `${prefix}chunks_text`,
													vectorWeight: 0.7,
													textWeight: 0.3,
													embeddingMode,
												},
											)
									).catch((err) => {
										if (isBenchmarkStrictMode()) {
											throw err
										}
										log.warn(
											`searchV2 hybrid bridge path failed: ${String(err)}`,
										)
										return [] as MemorySearchResult[]
									}),
								),
							)
						}
						// Option B: parallel search on session_chunks collection (vector +
						// text hybrid). Strictly opt-in: only benchmark ingest writes this
						// collection, so for a real user it is empty — and the scorer
						// boosts its lane. No query-shape heuristic may enable it.
						const sessionMode = resolveSessionEvidenceMode(
							process.env.MEMONGO_SESSION_EVIDENCE_MODE,
						)
						if (sessionMode === "B") {
							const requestedMaxResults = context.maxResults ?? 10
							const sessionEvidenceMaxResults = Math.max(
								requestedMaxResults,
								requestedMaxResults * 4,
							)
							const sessionFilter: Document = {
								agentId,
								scope,
								scopeRef: agentScopeRef,
							}
							searches.push(
								timeLane("hybrid:session_chunks", () =>
									(hybridMode === "vector-only"
										? vectorSearch(sessionChunksCollection(db, prefix), null, {
												maxResults: sessionEvidenceMaxResults,
												minScore,
												numCandidates,
												sessionKey: context.searchOptions?.sessionKey,
												filter: sessionFilter,
												indexName: `${prefix}session_chunks_vector`,
												queryText: searchQuery,
												embeddingMode,
											})
										: mongoSearch(
												sessionChunksCollection(db, prefix),
												searchQuery,
												null,
												{
													maxResults: sessionEvidenceMaxResults,
													minScore,
													numCandidates,
													sessionKey: context.searchOptions?.sessionKey,
													filter: sessionFilter,
													fusionMethod,
													capabilities,
													vectorIndexName: `${prefix}session_chunks_vector`,
													textIndexName: `${prefix}session_chunks_text`,
													vectorWeight: 0.7,
													textWeight: 0.3,
													embeddingMode,
												},
											)
									).catch((err) => {
										if (isBenchmarkStrictMode()) {
											throw err
										}
										log.warn(
											`searchV2 session_chunks path failed: ${String(err)}`,
										)
										return [] as MemorySearchResult[]
									}),
								),
							)
						}
						if (isEvidenceMirrorEnabled()) {
							const requestedMaxResults = context.maxResults ?? 10
							const evidenceMaxResults = Math.max(requestedMaxResults * 6, 30)
							const evidenceFilter: Document = {
								agentId,
								scope,
								scopeRef: agentScopeRef,
								status: "active",
							}
							searches.push(
								timeLane("hybrid:memory_evidence", () =>
									(hybridMode === "vector-only"
										? vectorSearch(memoryEvidenceCollection(db, prefix), null, {
												maxResults: evidenceMaxResults,
												minScore,
												numCandidates,
												sessionKey: context.searchOptions?.sessionKey,
												filter: evidenceFilter,
												indexName: `${prefix}memory_evidence_vector`,
												queryText: searchQuery,
												embeddingMode,
											})
										: mongoSearch(
												memoryEvidenceCollection(db, prefix),
												searchQuery,
												null,
												{
													maxResults: evidenceMaxResults,
													minScore,
													numCandidates,
													sessionKey: context.searchOptions?.sessionKey,
													filter: evidenceFilter,
													fusionMethod,
													capabilities,
													vectorIndexName: `${prefix}memory_evidence_vector`,
													textIndexName: `${prefix}memory_evidence_text`,
													vectorWeight: 0.65,
													textWeight: 0.35,
													embeddingMode,
												},
											)
									)
										.then((hits) =>
											hits.map((hit) => ({
												...hit,
												source: "conversation" as MemorySource,
												sourceType: "conversation" as MemorySource,
												provenance: {
													...(hit.provenance ?? {}),
													lane: "memory-evidence",
												},
											})),
										)
										.catch((err) => {
											if (isBenchmarkStrictMode()) {
												throw err
											}
											log.warn(
												`searchV2 memory_evidence path failed: ${String(err)}`,
											)
											return [] as MemorySearchResult[]
										}),
								),
							)
						}
						pathResults =
							searches.length > 0
								? mergeRankedResultSets(await Promise.all(searches))
								: []
						break
					}
					case "kb": {
						const kbHits = await searchKB(
							kbChunksCollection(db, prefix),
							searchQuery,
							null,
							{
								maxResults: Math.max(
									3,
									Math.floor((context.maxResults ?? 10) / 3),
								),
								minScore,
								scopeRef: agentScopeRef,
								...(Object.keys(kbFilter).length > 0
									? { filter: kbFilter }
									: {}),
								numCandidates,
								vectorIndexName: `${prefix}kb_chunks_vector`,
								textIndexName: `${prefix}kb_chunks_text`,
								capabilities,
								embeddingMode,
								kbDocs: kbCollection(db, prefix),
							},
						).catch((err) => {
							if (isBenchmarkStrictMode()) {
								throw err
							}
							log.warn(`searchV2 kb path failed: ${String(err)}`)
							return [] as MemorySearchResult[]
						})
						pathResults = kbHits
						break
					}
				}

				return pathResults
			} catch (pathErr) {
				if (isBenchmarkStrictMode()) {
					throw pathErr
				}
				log.error(`searchV2 path ${path} failed`, { error: pathErr })
				// Continue with other paths
				return []
			}
		}

		// #66: wall clock of the whole retrieval block — the lanes run
		// concurrently, so summing per-lane samples overstates their cost.
		const lanesStartedAt = Date.now()
		const pathOutcomes = await Promise.all(
			pathsToExecute.map((path) =>
				timeLane(path, () => executeSearchPath(path)),
			),
		)
		for (const [pathIndex, path] of pathsToExecute.entries()) {
			const pathResults = pathOutcomes[pathIndex] ?? []
			if (pathResults.length > 0) {
				pathsExecuted.push(path)
				resultsByPath[path] = pathResults.length
				perPathResults[path] = pathResults
				results.push(...pathResults)
			}
		}

		// Deduplicate, rerank, and limit
		let deduped = deduplicateSearchResults(results)
		const needsExactProceduralBackstop =
			context.availablePaths.has("procedural") &&
			!deduped.some((result) => result.path.startsWith("procedure:"))
		if (needsExactProceduralBackstop) {
			try {
				const exactProcedureMatches = await timeLane(
					"backstop:procedural-exact",
					() =>
						findExactProcedureMatches(proceduresCollection(db, prefix), query, {
							maxResults: context.maxResults ?? 10,
							filter: proceduralFilter,
						}),
				)
				if (exactProcedureMatches.length > 0) {
					pathsExecuted.push("procedural")
					resultsByPath.procedural = exactProcedureMatches.length
					perPathResults.procedural = exactProcedureMatches
					deduped = deduplicateSearchResults([
						...deduped,
						...exactProcedureMatches,
					])
				}
			} catch (err) {
				if (isBenchmarkStrictMode()) {
					throw err
				}
				log.warn(`searchV2 exact procedural backstop failed: ${String(err)}`)
			}
		}
		const needsProceduralBackstop =
			context.availablePaths.has("procedural") &&
			!pathsToExecute.includes("procedural") &&
			!pathsExecuted.includes("procedural") &&
			deduped.length < Math.max(2, Math.ceil(maxResults / 3)) &&
			laneHasData("procedural")
		if (needsProceduralBackstop) {
			try {
				const procedureFallback = await timeLane("backstop:procedural", () =>
					searchProcedures(
						proceduresCollection(db, prefix),
						searchQuery,
						null,
						{
							maxResults: context.maxResults ?? 10,
							minScore,
							filter: proceduralFilter,
							numCandidates,
							capabilities,
							vectorIndexName: `${prefix}procedures_vector`,
							textIndexName: `${prefix}procedures_text`,
							embeddingMode,
						},
					),
				)
				if (procedureFallback.length > 0) {
					pathsExecuted.push("procedural")
					resultsByPath.procedural = procedureFallback.length
					perPathResults.procedural = procedureFallback
					deduped = deduplicateSearchResults([...deduped, ...procedureFallback])
				}
			} catch (err) {
				if (isBenchmarkStrictMode()) {
					throw err
				}
				log.warn(`searchV2 procedural backstop failed: ${String(err)}`)
			}
		}

		const needsHybridBackstop =
			allowHybridBackstop &&
			context.availablePaths.has("hybrid") &&
			!pathsExecuted.includes("hybrid") &&
			deduped.length < Math.max(2, Math.ceil(maxResults / 3)) &&
			// P3.2: the recursive hybrid backstop re-runs the whole search — it
			// is only justified when lane coverage says data EXISTS to find.
			laneHasData("hybrid")
		if (needsHybridBackstop) {
			try {
				// Use searchQuery (already rewritten) for the backstop, but disable rewriting
				// to prevent double-expansion (idempotent for synonyms but breaks future LLM/HyDE)
				const fallback = await timeLane("backstop:hybrid", () =>
					searchV2(db, prefix, searchQuery, agentId, {
						...context,
						availablePaths: new Set(["hybrid"]),
						maxResults,
						searchOptions: {
							...context.searchOptions,
							allowHybridBackstop: false,
							queryRewriteConfig: undefined, // already rewritten — don't rewrite again
						},
					}),
				)
				if (fallback.results.length > 0) {
					pathsExecuted.push("hybrid")
					resultsByPath.hybrid = fallback.results.length
					perPathResults.hybrid = fallback.results
					deduped = deduplicateSearchResults([...deduped, ...fallback.results])
				}
			} catch (err) {
				if (isBenchmarkStrictMode()) {
					throw err
				}
				log.warn(`searchV2 hybrid backstop failed: ${String(err)}`)
			}
		}
		latencyByPath["phase:lanes"] = Date.now() - lanesStartedAt
		// C3 audit fix: RRF score normalization across paths before reranking.
		// Replace raw scores (incomparable across paths: vector 0-1, BM25 0-inf, episode 0.85-synthetic)
		// with rank-based scores summed across paths. Uses existing rrfScore() from mongodb-hybrid.ts.
		if (Object.keys(perPathResults).length > 1) {
			const rrfMap = new Map<string, number>()
			for (const [_pathName, pathRes] of Object.entries(perPathResults)) {
				for (let rank = 0; rank < pathRes.length; rank++) {
					const key = searchResultIdentityKey(pathRes[rank])
					rrfMap.set(key, (rrfMap.get(key) ?? 0) + rrfScore(rank + 1))
				}
			}
			for (const r of deduped) {
				const rrfVal = rrfMap.get(searchResultIdentityKey(r))
				if (rrfVal !== undefined) {
					r.score = rrfVal
				}
			}
			deduped.sort((a, b) => b.score - a.score)
		}

		const heuristicReranked = rerankResults(deduped, query)

		// Post-retrieval scoring: keyword, temporal, entity, quoted-phrase boosts
		// Applied AFTER heuristic rerank, BEFORE cross-encoder rerank
		const postScored = applyPostRetrievalScoring(query, heuristicReranked, {
			questionDate: context.searchOptions?.questionDate,
		})
		const conversationEvidenceResults = await searchConversationEvidenceEvents({
			db,
			prefix,
			query: searchQuery,
			questionDate: context.searchOptions?.questionDate,
			agentId,
			scope,
			scopeRef: agentScopeRef,
			maxResults: Math.min(maxResults, 20),
			numCandidates,
			capabilities,
			embeddingMode,
		}).catch((err) => {
			if (isBenchmarkStrictMode()) {
				throw err
			}
			log.warn(`conversation evidence search failed: ${String(err)}`)
			return [] as MemorySearchResult[]
		})
		const temporalCoverageResults = isTemporalCoverageMode()
			? await searchTemporalCoverageEvents({
					db,
					prefix,
					query: searchQuery,
					questionDate: context.searchOptions?.questionDate,
					agentId,
					scope,
					scopeRef: agentScopeRef,
					maxResults: Math.min(maxResults, 20),
					capabilities,
				}).catch((err) => {
					if (isBenchmarkStrictMode()) {
						throw err
					}
					log.warn(`temporal coverage search failed: ${String(err)}`)
					return [] as MemorySearchResult[]
				})
			: []
		const temporalCandidateBase =
			temporalCoverageResults.length > 0
				? deduplicateSearchResults([...temporalCoverageResults, ...postScored])
				: postScored
		const turnPrecisionResults = isBenchmarkTurnPrecisionMode()
			? await searchTurnEventsWithinSessions({
					db,
					prefix,
					query: searchQuery,
					agentId,
					scope,
					scopeRef: agentScopeRef,
					sessionIds: temporalCandidateBase.slice(0, 15).flatMap((result) => {
						const ids: string[] = []
						if (result.sessionId) ids.push(result.sessionId)
						const sessionIdFromCanonical = extractSessionIdFromCanonicalId(
							result.canonicalId,
						)
						if (sessionIdFromCanonical) ids.push(sessionIdFromCanonical)
						return ids
					}),
					maxResults: Math.min(maxResults, 20),
					numCandidates,
					capabilities,
					embeddingMode,
				}).catch((err) => {
					if (isBenchmarkStrictMode()) {
						throw err
					}
					log.warn(`turn precision rerank failed: ${String(err)}`)
					return [] as MemorySearchResult[]
				})
			: []
		const precisionScored =
			turnPrecisionResults.length > 0 || temporalCoverageResults.length > 0
				? (() => {
						const timelineResults = temporalCoverageResults.filter(
							(result) => result.provenance?.temporalTimeline === true,
						)
						const temporalEventResults = temporalCoverageResults.filter(
							(result) => result.provenance?.temporalTimeline !== true,
						)
						return orderTimelineAfterSourceEvidence(
							deduplicateSearchResults([
								...turnPrecisionResults,
								...conversationEvidenceResults,
								...temporalEventResults,
								...stripSessionSummaryTurnProvenance(postScored),
								...timelineResults,
							]),
						)
					})()
				: conversationEvidenceResults.length > 0
					? deduplicateSearchResults([
							...conversationEvidenceResults,
							...stripSessionSummaryTurnProvenance(postScored),
						])
					: postScored
		const laneControlled = applyLaneAwareResultControls({
			query,
			results: precisionScored,
			classification: classifyExecutorSearch({
				query,
				timeRange: context.searchOptions?.timeRange,
				conversationScope: context.searchOptions?.conversationScope,
				structuredScope: context.searchOptions?.structuredScope,
				referenceScope: context.searchOptions?.referenceScope,
				proceduralScope: context.searchOptions?.proceduralScope,
			}),
			planPaths: plan.paths,
		})

		// Cross-encoder re-ranking via Voyage API (after heuristic, before final slice)
		const rerankCfg = context.searchOptions?.rerankConfig
		let finalResults = laneControlled.results
		let laneControlSummary = laneControlled.summary
		let wasReranked = false
		if (rerankCfg?.enabled) {
			const timelineResults = finalResults.filter(
				(result) => result.provenance?.temporalTimeline === true,
			)
			const rerankInput = finalResults.filter(
				(result) => result.provenance?.temporalTimeline !== true,
			)
			const rerankResult = await timeLane("phase:rerank", () =>
				crossEncoderRerank({
					db,
					prefix,
					agentId,
					query,
					results: rerankInput.length > 0 ? rerankInput : precisionScored,
					config: rerankCfg,
					onProviderCall: (outcome) => {
						const accounting =
							context.searchOptions?.benchmarkRunContext?.accounting
						if (!accounting) return
						const metadata = { provider: "voyage", model: rerankCfg.model }
						if (outcome === "attempted") {
							accounting.recordAttempt("rerank", metadata)
						} else if (outcome === "succeeded") {
							accounting.recordSuccess("rerank", metadata)
						} else {
							accounting.recordFailure("rerank", metadata)
						}
					},
				}),
			)
			if (rerankResult.reranked) {
				const postRerankLaneControlled = applyLaneAwareResultControls({
					query,
					results: orderTimelineAfterSourceEvidence(
						deduplicateSearchResults([
							...applyPreferenceEvidenceBoostAfterRerank(
								query,
								applyRecencyAccessBoostAfterRerank(rerankResult.results, {
									recencyBoost: rerankCfg.recencyBoost,
									accessBoost: rerankCfg.accessBoost,
								}),
							),
							...timelineResults,
						]),
					),
					classification: classifyExecutorSearch({
						query,
						timeRange: context.searchOptions?.timeRange,
						conversationScope: context.searchOptions?.conversationScope,
						structuredScope: context.searchOptions?.structuredScope,
						referenceScope: context.searchOptions?.referenceScope,
						proceduralScope: context.searchOptions?.proceduralScope,
					}),
					planPaths: plan.paths,
				})
				finalResults = postRerankLaneControlled.results
				laneControlSummary = postRerankLaneControlled.summary
				wasReranked = true
			}
		}

		const sliced = finalResults.slice(0, maxResults)

		// Phase 9: Tiered retrieval — strip text for ids-only projection mode
		const projectionMode = context.searchOptions?.projection ?? "full"
		const projected =
			projectionMode === "ids-only"
				? sliced.map((r) => ({ ...r, snippet: "" }))
				: sliced

		return {
			results: projected,
			metadata: {
				plan,
				pathsExecuted,
				resultsByPath,
				reranked: wasReranked,
				queryRewritten: wasQueryRewritten,
				laneControls: laneControlSummary,
				latencyByPath,
			},
		}
	} catch (err) {
		log.error("searchV2 failed", { query, error: err })
		throw err
	}
}

// ---------------------------------------------------------------------------
// v2 status types
// ---------------------------------------------------------------------------

export type V2Status = {
	events: { count: number; latestTimestamp?: Date }
	entities: { count: number }
	relations: { count: number }
	episodes: { count: number; latestTimestamp?: Date }
	procedures: { count: number; latestTimestamp?: Date }
	projectionLag: Record<string, number | null>
	projectionHealth: Record<
		string,
		| "ok"
		| "projection-behind"
		| "derived-product-unavailable"
		| "health-uncertain"
	>
	laneCoverage: Record<
		string,
		{ hasData: boolean; count: number; lastUpdated: Date | null }
	>
	health: {
		overall: "ok" | "degraded" | "health-uncertain"
		retrieval: "ok" | "retrieval-degraded" | "health-uncertain"
		recentNoRelevantResults: boolean
		canonicalIngest: "ok" | "canonical-ingest-failed" | "health-uncertain"
		derivedProducts: Record<
			string,
			| "ok"
			| "projection-behind"
			| "derived-product-unavailable"
			| "health-uncertain"
		>
		diagnostics: string[]
	}
	retrievalPaths: string[]
}

const PROJECTION_BEHIND_SECONDS = 5 * 60

export function classifyCanonicalIngestHealth(
	latestIngestRun: Pick<IngestRun, "status"> | null,
): "ok" | "canonical-ingest-failed" | "health-uncertain" {
	if (!latestIngestRun) {
		return "health-uncertain"
	}
	return latestIngestRun.status === "failed" ? "canonical-ingest-failed" : "ok"
}

export function classifyProjectionHealth(params: {
	latestRun: Pick<ProjectionRun, "status"> | null
	lagSeconds: number | null
}):
	| "ok"
	| "projection-behind"
	| "derived-product-unavailable"
	| "health-uncertain" {
	const { latestRun, lagSeconds } = params
	if (!latestRun) {
		return "health-uncertain"
	}
	if (latestRun.status === "failed") {
		return "derived-product-unavailable"
	}
	if (lagSeconds === null) {
		return "health-uncertain"
	}
	if (lagSeconds > PROJECTION_BEHIND_SECONDS) {
		return "projection-behind"
	}
	return "ok"
}

export function classifyRetrievalHealth(params: {
	status?: string | null
	hitSources?: string[] | null
}): {
	state: "ok" | "retrieval-degraded" | "health-uncertain"
	recentNoRelevantResults: boolean
} {
	const status = params.status ?? null
	const hitSources = params.hitSources ?? []
	if (status === "ok") {
		return { state: "ok", recentNoRelevantResults: false }
	}
	if (status === "degraded") {
		return {
			state: "retrieval-degraded",
			recentNoRelevantResults: hitSources.length === 0,
		}
	}
	return { state: "health-uncertain", recentNoRelevantResults: false }
}

export function computeOverallV2Health(params: {
	retrieval: "ok" | "retrieval-degraded" | "health-uncertain"
	canonicalIngest: "ok" | "canonical-ingest-failed" | "health-uncertain"
	derivedProducts: Array<
		| "ok"
		| "projection-behind"
		| "derived-product-unavailable"
		| "health-uncertain"
	>
}): "ok" | "degraded" | "health-uncertain" {
	const { retrieval, canonicalIngest, derivedProducts } = params
	if (
		retrieval === "retrieval-degraded" ||
		canonicalIngest === "canonical-ingest-failed" ||
		derivedProducts.some(
			(state) =>
				state === "projection-behind" ||
				state === "derived-product-unavailable",
		)
	) {
		return "degraded"
	}
	if (
		retrieval === "health-uncertain" ||
		canonicalIngest === "health-uncertain" ||
		derivedProducts.some((state) => state === "health-uncertain")
	) {
		return "health-uncertain"
	}
	return "ok"
}

/**
 * Gather v2 health metrics: collection counts, projection lag, available retrieval paths.
 */
export async function getV2Status(
	db: Db,
	prefix: string,
	agentId: string,
): Promise<V2Status> {
	try {
		const settled = await Promise.allSettled([
			eventsCollection(db, prefix).countDocuments({ agentId }),
			entitiesCollection(db, prefix).countDocuments({ agentId }),
			relationsCollection(db, prefix).countDocuments({ agentId }),
			episodesCollection(db, prefix).countDocuments({ agentId }),
			proceduresCollection(db, prefix).countDocuments({ agentId }),
			getProjectionLag({ db, prefix, agentId, projectionType: "chunks" }),
			getProjectionLag({ db, prefix, agentId, projectionType: "entities" }),
			getProjectionLag({ db, prefix, agentId, projectionType: "relations" }),
			getProjectionLag({ db, prefix, agentId, projectionType: "episodes" }),
			getProjectionLag({
				db,
				prefix,
				agentId,
				projectionType: "structured-promotion",
			}),
			getProjectionLag({ db, prefix, agentId, projectionType: "procedures" }),
			getLatestIngestRun({ db, prefix, agentId }),
			getLatestProjectionRun({ db, prefix, agentId, projectionType: "chunks" }),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "entities",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "relations",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "episodes",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "structured-promotion",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "procedures",
			}),
			getLaneCoverage({ db, prefix, agentId }),
			relevanceRunsCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { ts: -1 }, projection: { status: 1, hitSources: 1 } },
			),
			eventsCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { timestamp: -1 }, projection: { timestamp: 1 } },
			),
			episodesCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
			),
			proceduresCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
			),
		])

		// Extract fulfilled values, default to safe fallbacks on rejection
		const val = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
			r.status === "fulfilled" ? r.value : fallback

		const eventCount = val(settled[0], 0)
		const entityCount = val(settled[1], 0)
		const relationCount = val(settled[2], 0)
		const episodeCount = val(settled[3], 0)
		const procedureCount = val(settled[4], 0)
		const chunksLag = val(settled[5], null)
		const entitiesLag = val(settled[6], null)
		const relationsLag = val(settled[7], null)
		const episodesLag = val(settled[8], null)
		const structuredPromotionLag = val(settled[9], null)
		const proceduresLag = val(settled[10], null)
		const latestIngest = val(settled[11], null)
		const latestChunksProjection = val(settled[12], null)
		const latestEntitiesProjection = val(settled[13], null)
		const latestRelationsProjection = val(settled[14], null)
		const latestEpisodesProjection = val(settled[15], null)
		const latestStructuredPromotion = val(settled[16], null)
		const latestProceduresProjection = val(settled[17], null)
		const laneCoverageDoc = val(settled[18], null) as {
			lanes?: Record<
				string,
				{ hasData: boolean; count: number; lastUpdated: Date | null }
			>
		} | null
		const latestRetrievalSafe = val(settled[19], null) as {
			status?: string
			hitSources?: string[]
		} | null
		const latestEvent = val(settled[20], null) as { timestamp?: Date } | null
		const latestEpisode = val(settled[21], null) as { updatedAt?: Date } | null
		const latestProcedure = val(settled[22], null) as {
			updatedAt?: Date
		} | null

		const canonicalIngest = classifyCanonicalIngestHealth(latestIngest)
		const retrievalHealth = classifyRetrievalHealth({
			status: latestRetrievalSafe?.status,
			hitSources: latestRetrievalSafe?.hitSources,
		})
		const derivedProducts = {
			chunks: classifyProjectionHealth({
				latestRun: latestChunksProjection,
				lagSeconds: chunksLag,
			}),
			entities: classifyProjectionHealth({
				latestRun: latestEntitiesProjection,
				lagSeconds: entitiesLag,
			}),
			relations: classifyProjectionHealth({
				latestRun: latestRelationsProjection,
				lagSeconds: relationsLag,
			}),
			episodes: classifyProjectionHealth({
				latestRun: latestEpisodesProjection,
				lagSeconds: episodesLag,
			}),
			"structured-promotion": classifyProjectionHealth({
				latestRun: latestStructuredPromotion,
				lagSeconds: structuredPromotionLag,
			}),
			procedures: classifyProjectionHealth({
				latestRun: latestProceduresProjection,
				lagSeconds: proceduresLag,
			}),
		}
		const diagnostics = [
			retrievalHealth.state === "retrieval-degraded"
				? "retrieval-degraded"
				: null,
			retrievalHealth.recentNoRelevantResults ? "no-relevant-results" : null,
			canonicalIngest === "canonical-ingest-failed"
				? "canonical-ingest-failed"
				: null,
			canonicalIngest === "health-uncertain"
				? "health-uncertain:canonical-ingest"
				: null,
			...Object.entries(derivedProducts).map(([name, state]) => {
				if (state === "projection-behind") {
					return `projection-behind:${name}`
				}
				if (state === "derived-product-unavailable") {
					return `derived-product-unavailable:${name}`
				}
				if (state === "health-uncertain") {
					return `health-uncertain:${name}`
				}
				return null
			}),
		].filter((value): value is string => Boolean(value))
		const overall = computeOverallV2Health({
			retrieval: retrievalHealth.state,
			canonicalIngest,
			derivedProducts: [
				derivedProducts.chunks,
				derivedProducts.entities,
				derivedProducts.relations,
				derivedProducts.episodes,
			],
		})

		// Log any individual failures for diagnostics
		for (const r of settled) {
			if (r.status === "rejected") {
				log.error("getV2Status partial failure", { error: r.reason })
			}
		}

		return {
			events: {
				count: eventCount,
				latestTimestamp: latestEvent?.timestamp,
			},
			entities: { count: entityCount },
			relations: { count: relationCount },
			episodes: {
				count: episodeCount,
				latestTimestamp: latestEpisode?.updatedAt,
			},
			procedures: {
				count: procedureCount,
				latestTimestamp: latestProcedure?.updatedAt,
			},
			projectionLag: {
				chunks: chunksLag,
				entities: entitiesLag,
				relations: relationsLag,
				episodes: episodesLag,
				"structured-promotion": structuredPromotionLag,
				procedures: proceduresLag,
			},
			projectionHealth: derivedProducts,
			laneCoverage: laneCoverageDoc?.lanes ?? {},
			health: {
				overall,
				retrieval: retrievalHealth.state,
				recentNoRelevantResults: retrievalHealth.recentNoRelevantResults,
				canonicalIngest,
				derivedProducts,
				diagnostics,
			},
			retrievalPaths: [
				"active-critical",
				"structured",
				"raw-window",
				"graph",
				"hybrid",
				"kb",
				"episodic",
				"procedural",
			],
		}
	} catch (err) {
		log.error("getV2Status failed", { error: err })
		throw err
	}
}
