import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import {
	MongoClient,
	type Collection,
	type Db,
	type Document,
	type MongoClientOptions,
} from "mongodb"
import {
	type MemongoConfig,
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
import { normalizeExtraMemoryPaths } from "./internal.js"
import { getMemoryStats, type MemoryStats } from "./mongodb-analytics.js"
import { MongoDBChangeStreamWatcher } from "./mongodb-change-stream.js"
import {
	heuristicEpisodeSummarizer,
	promoteDerivedMemoryFromEvent,
	extractStructuredCandidatesFromEvent,
	extractProcedureCandidatesFromEvent,
	resolveStructuredCandidatesForPromotion,
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
	buildMissLedger,
	buildCaseDiagnostics,
	projectBenchmarkParityFields,
	type BenchmarkCaseExecution,
} from "./mongodb-benchmark-runner.js"
import {
	createBenchmarkRunCounters,
	resolveBenchmarkRetrievalLane,
	type BenchmarkRetrievalLane,
	type BenchmarkRunCounters,
} from "./benchmark-parity-envelope.js"
import { readSearchIndexStatus } from "./mongodb-benchmark-readiness.js"
import {
	writeEvent,
	projectEventChunk,
	getEventsByTimeRange,
	renderEventChunkText,
} from "./mongodb-events.js"
import {
	extractAndUpsertEntities,
	searchEntitiesAutocomplete,
	expandGraph,
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
	createMemoryJob,
	getMemoryJob,
	listMemoryJobs,
	updateMemoryJob,
} from "./mongodb-memory-jobs.js"
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
import { checkCache, writeCache } from "./mongodb-query-cache.js"
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
	resolveEnrichmentMode,
	resolveEnrichmentStrictMode,
	resolveEnrichmentProvider,
	enrichSessionsWithLLM,
} from "./mongodb-llm-enrichment.js"
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
	kbChunksCollection,
	metaCollection,
	proceduresCollection,
	relevanceRunsCollection,
	resolveSearchIndexReadinessTiming,
	structuredMemCollection,
	waitForSearchCapabilities,
	waitForSearchIndexesQueryable,
	sessionChunksCollection,
} from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import {
	buildVectorSearchStage,
	MONGODB_MAX_NUM_CANDIDATES,
	mongoSearch,
	vectorSearch,
} from "./mongodb-search.js"
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
const VALID_PROCEDURE_STATES: ReadonlySet<ProcedureState> = new Set([
	"active",
	"invalidated",
	"conflicted",
])

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
		cost: import("./types.js").BenchmarkCostCounters
	},
): RelevanceBenchmarkResult {
	const queryGovernance = buildQueryGovernanceReport(result)
	return {
		...result,
		queryGovernance,
		benchmarkReport: buildBenchmarkRunReport({
			...result,
			queryGovernance,
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
				score: { $meta: "searchScore" },
			},
		},
	]

	const docs = await eventsCollection(params.db, params.prefix)
		.aggregate(pipeline)
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
		params.embeddingMode === "automated"
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
					score: { $meta: "vectorSearchScore" },
				},
			},
		]
		searches.push(
			events
				.aggregate(vectorPipeline)
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-vector"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}
	if (params.capabilities.textSearch) {
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
					score: { $meta: "searchScore" },
				},
			},
		]
		searches.push(
			events
				.aggregate(textPipeline)
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
		params.embeddingMode === "automated"
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
					score: { $meta: "vectorSearchScore" },
				},
			},
		]
		searches.push(
			events
				.aggregate(vectorPipeline)
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-vector"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}

	if (params.capabilities.textSearch) {
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
					score: { $meta: "searchScore" },
				},
			},
		]
		searches.push(
			events
				.aggregate(textPipeline)
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
		maxResults: configuredRequest.maxResults ?? 10,
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
	private readonly config: ResolvedMemoryBackendConfig
	private syncing: Promise<void> | null = null
	private watcher: FSWatcher | null = null
	private watchTimer: NodeJS.Timeout | null = null
	private changeStreamWatcher: MongoDBChangeStreamWatcher | null = null
	private relevance: MongoDBRelevanceRuntime | null = null
	private closed = false
	private dirty = true
	private fileCount = 0
	private chunkCount = 0
	private writeQueue: Promise<void> = Promise.resolve()
	private derivationSchedulingQueue: Promise<void> = Promise.resolve()
	private derivationQueue: Promise<void> = Promise.resolve()
	private lastSearchMode = "legacy"
	private lastSearchDetails: Record<string, unknown> | undefined
	private accessTracker: AccessTracker | null = null
	/**
	 * Task 1.A parity envelope: active run-scoped counters set by
	 * `relevanceBenchmark` and read by rerank / LLM-enrichment sites to
	 * populate `benchmarkReport.cost.*`. `null` outside a benchmark run.
	 */
	private benchmarkRunCounters: BenchmarkRunCounters | null = null

	private constructor(params: {
		client: MongoClient
		db: Db
		prefix: string
		agentId: string
		workspaceDir: string
		extraMemoryPaths?: string[]
		capabilities: DetectedCapabilities
		config: ResolvedMemoryBackendConfig
		relevance?: MongoDBRelevanceRuntime | null
	}) {
		this.client = params.client
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
	}): Promise<MongoDBMemoryManager> {
		const mongoCfg = params.resolved.mongodb
		if (!mongoCfg) {
			throw new Error(
				"mongodb memory config missing from resolved backend config",
			)
		}

		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId)
		// Connect to MongoDB with a timeout to avoid hanging
		const safeUri = redactMongoURI(mongoCfg.uri)
		log.info(`connecting to MongoDB: ${safeUri} (db=${mongoCfg.database})`)
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
		const client = new MongoClient(mongoCfg.uri, clientOptions)
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

		const db = client.db(mongoCfg.database)
		const prefix = mongoCfg.collectionPrefix

		// Ensure collections + schema validation + standard indexes
		await ensureCollections(db, prefix)
		await ensureStandardIndexes(db, prefix, {
			embeddingCacheTtlDays: mongoCfg.embeddingCacheTtlDays,
			memoryTtlDays: mongoCfg.memoryTtlDays,
			relevanceRetentionDays: mongoCfg.relevance.retention.days,
		})

		// Detect what the connected MongoDB supports. In strict benchmark/release
		// gates, Search/vector capability is required evidence, not an optional
		// acceleration path.
		let capabilities = await detectCapabilities(
			db,
			chunksCollection(db, prefix).collectionName,
		)
		if (
			isStrictSearchReadinessMode() &&
			(!capabilities.textSearch || !capabilities.vectorSearch)
		) {
			const { timeoutMs, pollMs } = resolveSearchIndexReadinessTiming()
			log.warn(
				`MongoDB Search capabilities not ready; waiting up to ${timeoutMs}ms before strict startup fails`,
			)
			capabilities = await waitForSearchCapabilities(
				db,
				chunksCollection(db, prefix).collectionName,
				{
					timeoutMs,
					pollMs,
					requireText: true,
					requireVector: true,
				},
			)
			if (!capabilities.textSearch || !capabilities.vectorSearch) {
				throw new Error(
					`MongoDB Search/vector capabilities are required in strict mode but were unavailable after ${timeoutMs}ms: ${JSON.stringify(capabilities)}`,
				)
			}
		}
		log.info(`capabilities: ${JSON.stringify(capabilities)}`)

		// Only bootstrap Search indexes when the deployment can talk to Search
		// Index Management at all. This keeps runtime startup responsive on
		// clusters that support fusion stages but do not expose mongot.
		if (capabilities.textSearch || capabilities.vectorSearch) {
			const ensuredSearchIndexes = await ensureSearchIndexes(
				db,
				prefix,
				mongoCfg.deploymentProfile,
				mongoCfg.embeddingMode,
				mongoCfg.quantization,
				mongoCfg.numDimensions,
			)
			if (ensuredSearchIndexes.text || ensuredSearchIndexes.vector) {
				const rawSessionBootstrapProfile =
					resolveBenchmarkRetrievalLane(
						process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE,
					) === "raw-session"
				if (rawSessionBootstrapProfile) {
					log.info(
						"raw-session benchmark profile: deferring Search/Vector queryability until post-ingest vector convergence",
					)
				} else {
					const { timeoutMs: readinessTimeoutMs, pollMs: readinessPollMs } =
						resolveSearchIndexReadinessTiming()
					const readinessResults = await Promise.all(
						getExpectedSearchIndexTargets(
							prefix,
							mongoCfg.deploymentProfile,
						).map(async (target) => {
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
						}),
					)
					const stalled = readinessResults.filter((result) => !result.ready)
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
				}
			}
		} else {
			log.info(
				"search index management unavailable; skipping search index bootstrap",
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
			config: params.resolved,
			relevance,
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

		// Start watching bridge memory files for changes
		manager.ensureWatcher()

		// Opt-in: Change Streams for cross-instance sync (requires replica set)
		if (mongoCfg.enableChangeStreams) {
			const persistedResumeToken =
				await manager.loadPersistedChangeStreamResumeToken()
			const csWatcher = new MongoDBChangeStreamWatcher(
				chunksCollection(db, prefix),
				(event) => {
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

	private buildConversationChunkFilter(params?: {
		scope?: MemoryScope
		scopeRef?: string
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
			...(params?.scope ? { scope: params.scope } : {}),
			...(params?.scopeRef ? { scopeRef: params.scopeRef } : {}),
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

	private buildScopeAwareBridgeChunkFilter(
		activeSources: ActiveSources,
		params: { scope: MemoryScope; scopeRef: string },
	): Document | undefined {
		if (!activeSources.conversation || isBenchmarkStrictMode()) {
			return undefined
		}
		if (
			params.scope !== "workspace" ||
			params.scopeRef !== this.workspaceScopeRef
		) {
			return undefined
		}
		return this.buildBridgeChunkFilter()
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
		const maxResults = opts?.maxResults ?? 10
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
							filter: this.buildConversationChunkFilter({
								scope: opts?.scope,
								scopeRef: opts?.scopeRef,
							}),
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
			!activeSources.conversation
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
							filter: this.buildBridgeChunkFilter(),
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
							filter: { agentId: this.agentId },
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
		const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg)
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
		},
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			this.setLastSearchMode("v2:empty-query")
			return []
		}

		const mongoCfg = this.config.mongodb!
		const maxResults = opts?.maxResults ?? 10
		const minScore = opts?.minScore ?? mongoCfg.reranking?.minScore ?? 0.01
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const availablePaths = this.buildV2AvailablePaths(activeSources)

		const searchScope: MemoryScope =
			opts?.scope ?? (opts?.sessionKey ? "session" : "agent")
		const searchScopeRef =
			opts?.scopeRef ??
			resolveScopeRef({
				scope: searchScope,
				agentId: this.agentId,
				sessionId: opts?.sessionKey,
				workspaceDir: this.workspaceDir,
			})

		// Cache check: BEFORE search pipeline
		if (mongoCfg.cache.enabled) {
			const cacheResult = await checkCache({
				db: this.db,
				prefix: this.prefix,
				query: cleaned,
				agentId: this.agentId,
				scope: searchScope,
				scopeRef: searchScopeRef,
				config: mongoCfg.cache,
			})
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
					// Task 1.A projection: thread run-scoped counters so the
					// rerank call site can increment cost.rerankCalls. null
					// outside a benchmark run.
					...(this.benchmarkRunCounters
						? { benchmarkRunCounters: this.benchmarkRunCounters }
						: {}),
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
					})
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
		const searchScope: MemoryScope =
			normalized.scope ??
			(normalized.conversationScope?.sessionKey ? "session" : "agent")
		const searchScopeRef =
			normalized.scopeRef ??
			resolveScopeRef({
				scope: searchScope,
				agentId: this.agentId,
				sessionId: normalized.conversationScope?.sessionKey,
				workspaceDir: this.workspaceDir,
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
				})
			}
			return response
		}

		if (requestHasHardConstraints(normalized)) {
			this.setLastSearchMode("v2:constrained-empty", v2Details)
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
							filter: this.buildConversationChunkFilter(),
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
					mongoSearch(
						chunksCollection(this.db, this.prefix),
						query,
						queryVector,
						{
							maxResults,
							minScore,
							numCandidates: mongoCfg.numCandidates,
							sessionKey: params.sessionKey,
							filter: this.buildBridgeChunkFilter(),
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
				const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg)
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
							filter: { agentId: this.agentId },
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
								filter: this.buildConversationChunkFilter(),
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
				!explainSources.conversation
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
								filter: this.buildBridgeChunkFilter(),
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
								filter: { agentId: this.agentId },
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
			const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg)
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
		const maxResults = params?.maxResults ?? 10
		const minScore = params?.minScore ?? mongoCfg.reranking?.minScore ?? 0.01
		const resolvedDatasetPath = await resolveBenchmarkDatasetPath({
			datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
		})
		const retrievalLane = resolveBenchmarkRetrievalLane(
			params?.retrievalLane ?? process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE,
		)

		// Task 1.A projection: register run-scoped counters so rerank + LLM
		// enrichment can increment cost fields without threading a counter
		// through every call site. Counters are cleared in `finally`.
		const counters = createBenchmarkRunCounters()
		this.benchmarkRunCounters = counters
		try {
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
					counters,
				})
				return attachBenchmarkOperationsReport(legacy.result, parity)
			}
			if (
				(dataset.scenarios?.some(
					(scenario) => scenario.evaluations.length > 0,
				) ?? false) === false
			) {
				const noEvaluationError = new Error(
					"benchmark dataset contains no evaluation cases",
				)
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
					counters,
				})
				return attachBenchmarkOperationsReport(legacy.result, parity)
			}
			const datasetVersion =
				await this.buildBenchmarkDatasetVersion(resolvedDatasetPath)
			const scenario = await this.runScenarioBenchmarkDataset({
				datasetPath: resolvedDatasetPath,
				dataset,
				datasetVersion,
				maxResults,
				minScore,
				retrievalLane,
			})
			const parity = await this.buildBenchmarkParityBundle({
				datasetPath: resolvedDatasetPath,
				datasetKind: scenario.result.datasetKind,
				retrievalLane,
				datasetSha256Override: params?.datasetSha256,
				latencySamples: scenario.latencySamples,
				counters,
			})
			return attachBenchmarkOperationsReport(scenario.result, parity)
		} finally {
			this.benchmarkRunCounters = null
		}
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
		counters: BenchmarkRunCounters
	}): Promise<{
		runIdentity: import("./types.js").BenchmarkRunIdentity
		embedding: import("./types.js").BenchmarkEmbeddingConfig
		reranker: import("./types.js").BenchmarkRerankerConfig
		storage: import("./types.js").BenchmarkStorageFootprint
		latency: import("./types.js").BenchmarkLatencyDistribution
		cost: import("./types.js").BenchmarkCostCounters
	}> {
		const mongoCfg = this.config.mongodb!
		const retrievalLane = params.retrievalLane ?? "native"
		return await projectBenchmarkParityFields({
			db: this.db,
			collectionName:
				retrievalLane === "raw-session"
					? `${this.prefix}session_chunks`
					: `${this.prefix}events`,
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
			costCounters: params.counters.snapshot(),
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
		return [
			this.workspaceDir,
			path.dirname(
				this.config.mongodb?.relevance.benchmark.datasetPath ??
					this.workspaceDir,
			),
			...envRoots,
		]
	}

	private createBenchmarkScenarioManager(
		agentId: string,
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
			config: this.config,
			relevance,
		})
		// Task 1.A projection: propagate run-scoped counters so rerank calls
		// issued via the scenario manager still increment the parent's
		// cost.* fields.
		scenario.benchmarkRunCounters = this.benchmarkRunCounters
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
			await awaitQueue(writeQueue, "writeQueue")
			await awaitQueue(derivationSchedulingQueue, "derivationSchedulingQueue")
			await awaitQueue(derivationQueue, "derivationQueue")
			if (
				writeQueue === manager.writeQueue &&
				derivationSchedulingQueue ===
					(manager.derivationSchedulingQueue ?? derivationSchedulingQueue) &&
				derivationQueue === manager.derivationQueue
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
						error: err,
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
						error: err,
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
						error: err,
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
		const collectionSuffixes = [
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
		const settled = await Promise.allSettled(
			collectionSuffixes.map(async (suffix) => {
				await this.db
					.collection(`${this.prefix}${suffix}`)
					.deleteMany({ agentId })
			}),
		)
		for (const [index, result] of settled.entries()) {
			if (result.status === "rejected") {
				log.warn("benchmark scenario cleanup failed", {
					agentId,
					collection: collectionSuffixes[index],
					error: result.reason,
				})
			}
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
		return hash.digest("hex").slice(0, 16)
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
		const attemptsValue = Number(
			process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS,
		)
		const attempts =
			Number.isFinite(attemptsValue) && attemptsValue > 0
				? Math.min(10, Math.floor(attemptsValue))
				: 6
		const delayValue = Number(process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS)
		const delayMs =
			Number.isFinite(delayValue) && delayValue >= 0
				? Math.min(30_000, Math.floor(delayValue))
				: 5_000
		const collection = sessionChunksCollection(this.db, this.prefix)
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const results = await vectorSearch(collection, null, {
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
			if (results.length > 0 || attempt >= attempts) {
				return results
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
		return []
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
	}): Promise<{
		result: RelevanceBenchmarkResult
		latencySamples: number[]
	}> {
		const scenarios = params.dataset.scenarios ?? []
		const executions: BenchmarkCaseExecution[] = []
		const expectedSessionMap = new Map<string, string[]>()
		const expectedTurnMap = new Map<string, string[]>()
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
					scenarioManager = this.createBenchmarkScenarioManager(scenarioAgentId)
					const scenarioIngest = scenarioManager.shouldUseBenchmarkFastIngest()
						? await scenarioManager.fastIngestBenchmarkConversations({
								datasetPath: params.datasetPath,
								datasetName: params.dataset.name,
								datasetKind: params.dataset.datasetKind,
								conversations: scenario.conversations,
								scope: "agent",
								metadata: {
									benchmarkDatasetKind: params.dataset.datasetKind ?? "generic",
									benchmarkScenarioId: scenario.scenarioId,
								},
							})
						: await ingestBenchmarkConversations({
								datasetPath: params.datasetPath,
								datasetName: params.dataset.name,
								conversations: scenario.conversations,
								scope: "agent",
								metadata: {
									benchmarkDatasetKind: params.dataset.datasetKind ?? "generic",
									benchmarkScenarioId: scenario.scenarioId,
								},
								writeTurn: async (turn) => {
									await scenarioManager.writeConversationEvent(turn)
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
					const effectiveSessionEvidenceMode = rawSessionLane
						? "B"
						: sessionEvidenceMode
					const userfactEvidenceMode = resolveUserfactEvidenceMode(
						process.env.MEMONGO_USERFACT_EVIDENCE_MODE,
						process.env.MEMONGO_PREFERENCE_EVIDENCE_MODE,
					)
					const enrichmentMode = resolveEnrichmentMode(
						process.env.MEMONGO_LLM_ENRICHMENT_MODE,
					)
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
									})
									// Task 1.A projection: count LLM enrichment API calls
									// during benchmark runs (both successful and failed — a
									// failed call is still a billed call).
									if (this.benchmarkRunCounters) {
										const totalAttempted =
											enrichResult.sessionsEnriched +
											enrichResult.sessionsFailed
										if (totalAttempted > 0) {
											this.benchmarkRunCounters.recordLlmEnrichmentCall(
												totalAttempted,
											)
										}
									}
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
										error: err,
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
								error: err,
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
							decompositionMode === "enabled"
						) {
							const decomposed = await decomposeQuery({
								provider: decompositionProvider,
								model: process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? "",
								query: evaluation.query,
								questionType: evaluation.questionType,
							})
							// Run each sub-query through the search pipeline
							const resultSets: MemorySearchResult[][] = []
							for (const subQuery of decomposed.subQueries) {
								const subResults = await scenarioManager.search(subQuery, {
									maxResults: params.maxResults,
									minScore: params.minScore,
									questionDate: validQuestionDate,
								})
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
							)
							resultSets.push(originalResults)
							// Merge all result sets with RRF
							results = mergeMultiQueryResults(
								resultSets,
								params.maxResults,
							) as MemorySearchResult[]
						} else {
							results =
								evaluation.sourceScope &&
								scenarioManager.relevance &&
								evaluation.sourceScope !== "all"
									? (
											await scenarioManager.relevanceExplain({
												query: evaluation.query,
												sourceScope: evaluation.sourceScope,
												maxResults: params.maxResults,
												minScore: params.minScore,
												deep: false,
												questionDate: validQuestionDate,
											})
										).results
									: await scenarioManager.search(evaluation.query, {
											maxResults: params.maxResults,
											minScore: params.minScore,
											questionDate: validQuestionDate,
										})
						}
						executions.push(
							evaluateRankingCase({
								caseId: evaluation.caseId,
								results,
								latencyMs: Date.now() - startedAt,
								relevantSessionIds: evaluation.expectedSessionIds,
								relevantTurnIds: evaluation.expectedTurnIds,
								relevantDialogIds: evaluation.expectedDialogIds,
								resolveSessionIds: (result) =>
									this.resolveBenchmarkResultSessionIds(result, eventEvidence),
								resolveTurnIds: (result) =>
									this.resolveBenchmarkResultTurnIds(result, eventEvidence),
								resolveDialogIds: (result) =>
									this.resolveBenchmarkResultDialogIds(result, eventEvidence),
								datasetKind: params.dataset.datasetKind,
								questionType: evaluation.questionType,
								abstention: evaluation.abstention,
								traceOptions: { maxCandidates: 50 },
							}),
						)
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
						if (isBenchmarkStrictMode()) {
							const message = err instanceof Error ? err.message : String(err)
							throw new Error(
								`benchmark evaluation query failed in strict mode: scenario=${scenario.scenarioId} case=${evaluation.caseId}: ${message}`,
							)
						}
						log.warn("benchmark evaluation query failed", {
							scenarioId: scenario.scenarioId,
							caseId: evaluation.caseId,
							error: err,
						})
						executions.push(
							evaluateRankingCase({
								caseId: evaluation.caseId,
								results: [],
								latencyMs: Date.now() - startedAt,
								relevantSessionIds: evaluation.expectedSessionIds,
								relevantTurnIds: evaluation.expectedTurnIds,
								relevantDialogIds: evaluation.expectedDialogIds,
								resolveSessionIds: (result) =>
									this.resolveBenchmarkResultSessionIds(result, eventEvidence),
								resolveTurnIds: (result) =>
									this.resolveBenchmarkResultTurnIds(result, eventEvidence),
								resolveDialogIds: (result) =>
									this.resolveBenchmarkResultDialogIds(result, eventEvidence),
								datasetKind: params.dataset.datasetKind,
								questionType: evaluation.questionType,
								abstention: evaluation.abstention,
							}),
						)
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
				log.info("benchmark scenario complete", {
					scenarioId: scenario.scenarioId,
					agentId: scenarioManager.agentId,
					index,
					totalScenarios: scenarios.length,
					evaluations: scenario.evaluations.length,
					elapsedMs: Date.now() - scenarioStartedAt,
				})
			} finally {
				if (
					scenarioManager !== this &&
					process.env.MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA !== "1"
				) {
					await this.cleanupBenchmarkScenarioData(scenarioManager.agentId)
				}
			}
		}

		const summary = summarizeBenchmarkExecutions({
			datasetName: params.dataset.name,
			datasetKind: params.dataset.datasetKind,
			scenarios: scenarios.length,
			executions,
			ingest,
		})
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
				hitRate: summary.hitRate,
				emptyRate: summary.emptyRate,
				avgTopScore: summary.avgTopScore,
				p95LatencyMs: summary.p95LatencyMs,
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
				await this.writeConversationEvent(turn)
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
			filter?: { tags?: string[]; category?: string; source?: string }
		},
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			return []
		}

		const mongoCfg = this.config.mongodb!
		const maxResults = opts?.maxResults ?? 5
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
				filter: opts?.filter,
				numCandidates: mongoCfg.numCandidates,
				vectorIndexName: `${this.prefix}kb_chunks_vector`,
				textIndexName: `${this.prefix}kb_chunks_text`,
				capabilities: this.capabilities,
				embeddingMode: mongoCfg.embeddingMode,
				kbDocs: kbCollection(this.db, this.prefix),
			},
		)
	}

	// ---------------------------------------------------------------------------
	// Score normalization: detect which search method was used for legacy search
	// ---------------------------------------------------------------------------

	private detectSearchMethod(mongoCfg: ResolvedMongoDBConfig): SearchMethod {
		// Determine which search method mongoSearch() likely used based on
		// capabilities and fusion method configuration.
		const canVector =
			mongoCfg.embeddingMode === "automated" && this.capabilities.vectorSearch

		if (canVector && this.capabilities.textSearch) {
			// Both server-side fusion and JS-merge fallback produce hybrid-like
			// scores in ~[0,1] range (server fusion via $meta:"searchScore",
			// JS merge via our RRF normalization in mergeHybridResultsMongoDB).
			return "hybrid"
		}
		if (canVector) {
			return "vector"
		}
		// Text-only or $text fallback
		return "text"
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
			const scope = query.get("scope") ?? "agent"
			const scopeRef = query.get("scopeRef") ?? this.agentScopeRef
			const relation = (
				await relationsCollection(this.db, this.prefix)
					.find(
						{
							agentId: this.agentId,
							scope,
							scopeRef,
						},
						{
							sort: { updatedAt: -1, _id: 1 },
							limit: 50,
						},
					)
					.toArray()
			).find((candidate) => {
				const fromEntityId = String(candidate.fromEntityId ?? "")
				const toEntityId = String(candidate.toEntityId ?? "")
				return `${fromEntityId}-${toEntityId}` === relationId
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
		return reportProcedureOutcomeByHandle({
			db: this.db,
			prefix: this.prefix,
			handle: params.handle,
			success: params.success,
			note: params.note,
			actorRole: params.actorRole,
		})
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
		return applyStructuredMemoryFeedbackByHandle({
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
						},
					},
				)
				const expandedResults =
					params.scope === "session"
						? await expandSearchContext({
								db: this.db,
								prefix: this.prefix,
								agentId: this.agentId,
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
		})
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

	async scanNovelty(params?: { limit?: number; scope?: string }) {
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
		scope?: string
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

	private async runBackgroundExtractionJob(params: {
		eventId: string
		jobId: string
	}): Promise<void> {
		const { eventId, jobId } = params
		const startedAt = new Date()
		try {
			await updateMemoryJob({
				db: this.db,
				prefix: this.prefix,
				jobId,
				agentId: this.agentId,
				status: "running",
				startedAt,
				metadata: { eventId },
			})
		} catch (err) {
			log.warn(
				`updateMemoryJob failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		try {
			const eventDoc = (await eventsCollection(this.db, this.prefix).findOne({
				eventId,
				agentId: this.agentId,
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

			const result = await promoteDerivedMemoryFromEvent({
				db: this.db,
				prefix: this.prefix,
				client: this.client,
				embeddingMode: this.config.mongodb?.embeddingMode ?? "automated",
				event: {
					...eventDoc,
					workspaceDir: this.workspaceDir,
				},
			})

			try {
				await updateMemoryJob({
					db: this.db,
					prefix: this.prefix,
					jobId,
					agentId: this.agentId,
					status: "completed",
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
			} catch (err) {
				log.warn(
					`updateMemoryJob failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		} catch (err) {
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
					metadata: { eventId },
				})
			} catch (updateErr) {
				log.warn(
					`updateMemoryJob failed for ${jobId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
				)
			}
		}
	}

	private async scheduleBackgroundExtraction(
		eventId: string,
	): Promise<{ jobId: string; scheduled: boolean }> {
		const jobId = `extraction-${eventId}`
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
				},
			})
		} catch (err) {
			if (this.isDuplicateKeyError(err)) {
				return { jobId, scheduled: false }
			}
			throw err
		}

		this.enqueueDerivedWork(async () => {
			await this.runBackgroundExtractionJob({ eventId, jobId })
		})
		return { jobId, scheduled: true }
	}

	private schedulePostWriteDerivations(params: {
		eventId: string
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		timestamp: Date
		scope: MemoryScope
		scopeRef: string
	}): void {
		const mongoCfg = this.config.mongodb
		if (!mongoCfg) {
			return
		}
		if (!this.shouldRunPostWriteDerivedWork()) {
			return
		}

		this.enqueueDerivationScheduling(async () => {
			await this.scheduleBackgroundExtraction(params.eventId)
		})

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

	async writeConversationEvent(event: {
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		timestamp?: Date
		metadata?: Record<string, unknown>
		scope?: MemoryScope
		scopeRef?: string
	}): Promise<{ eventId: string; chunkCreated: boolean }> {
		const execute = async () => {
			const eventId = randomUUID()
			const scope = event.scope ?? ("agent" as MemoryScope)
			const written = await writeEvent({
				db: this.db,
				prefix: this.prefix,
				event: {
					eventId,
					agentId: this.agentId,
					sessionId: event.sessionId,
					role: event.role,
					body: event.body,
					scope,
					scopeRef: event.scopeRef,
					timestamp: event.timestamp,
					metadata: event.metadata,
				},
			})
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
					...(event.sessionId ? { sessionId: event.sessionId } : {}),
					...(event.metadata ? { metadata: event.metadata } : {}),
				},
			})
			if (projected.chunkCreated) {
				this.chunkCount += 1
			}
			const postWriteDerivedWorkEnabled = this.shouldRunPostWriteDerivedWork()
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

			this.schedulePostWriteDerivations({
				eventId: written.eventId,
				role: event.role,
				body: event.body,
				sessionId: event.sessionId,
				timestamp: written.timestamp,
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
				const candidates = postWriteDerivedWorkEnabled
					? await resolveStructuredCandidatesForPromotion({
							db: this.db,
							prefix: this.prefix,
							event: {
								eventId: written.eventId,
								agentId: this.agentId,
								role: event.role,
								body: event.body,
								timestamp: written.timestamp,
								sessionId: event.sessionId,
								scope,
								scopeRef: written.scopeRef,
							},
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
					error: err,
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

	async extractEvent(params: { eventId: string }) {
		const eventId = params.eventId.trim()
		if (!eventId) {
			throw new Error("eventId is required")
		}
		return this.scheduleBackgroundExtraction(eventId)
	}

	// ---------------------------------------------------------------------------
	// Analytics: getMemoryStats
	// ---------------------------------------------------------------------------

	async stats(): Promise<MemoryStats> {
		return getMemoryStats(this.db, this.prefix)
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

		await this.derivationSchedulingQueue
		await this.derivationQueue

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

		// Wait for any in-flight sync to complete before closing the connection
		if (this.syncing) {
			try {
				await this.syncing
			} catch {
				// Ignore sync errors during close — already logged in runSync
			}
		}
		await this.writeQueue

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

		// Close the MongoDB connection
		try {
			await this.client.close()
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`error closing MongoDB connection: ${msg}`)
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
				error: err,
				eventId: written.eventId,
			})
		}

		// Structured fact + procedure extraction (sync rule-based, non-blocking)
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
				error: err,
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
			// Structured lane tracks durable promotion eligibility, not just raw
			// extraction hits, so deferred candidates do not inflate coverage.
			const candidates = await resolveStructuredCandidatesForPromotion({
				db,
				prefix,
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
				error: err,
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
export async function searchV2(
	db: Db,
	prefix: string,
	query: string,
	agentId: string,
	context: {
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
			searchConfig?: ResolvedSearchConfig
			questionDate?: Date
			/**
			 * Task 1.A projection: optional run-scoped cost counters. When
			 * injected, rerank / LLM paths increment on every API call.
			 * `null`/`undefined` outside a benchmark run.
			 */
			benchmarkRunCounters?: BenchmarkRunCounters
		}
	},
): Promise<{ results: MemorySearchResult[]; metadata: V2SearchMetadata }> {
	try {
		const graphQueryCandidates =
			context.knownEntityNames && context.knownEntityNames.length > 0
				? context.knownEntityNames
				: buildGraphQueryCandidates(query)
		const scope = context.searchOptions?.scope ?? "agent"
		const agentScopeRef =
			context.searchOptions?.scopeRef ?? resolveScopeRef({ scope, agentId })
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

		// Load lane coverage for planner (non-blocking: fallback to no coverage on error)
		let laneCoverage:
			| Record<
					string,
					{ hasData: boolean; count: number; lastUpdated: Date | null }
			  >
			| undefined
		try {
			const coverageDoc = await getLaneCoverage({ db, prefix, agentId })
			if (coverageDoc) {
				laneCoverage = coverageDoc.lanes
			}
		} catch (err) {
			log.warn("Failed to load lane coverage for planner", {
				error: err,
				agentId,
			})
		}

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

		// Rewrite query for search execution (NOT for planner or cache key):
		const qrConfig = context.searchOptions?.queryRewriteConfig
		let searchQuery = query
		let wasQueryRewritten = false
		if (qrConfig?.enabled) {
			const rewriteResult = await rewriteQuery({
				db,
				prefix,
				agentId,
				query,
				config: qrConfig,
			})
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
		// specialized paths come back weak or empty.
		const pathsToExecute = plan.paths.slice(0, 3)

		for (const path of pathsToExecute) {
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
						// Use original query for regex-based episodic search (synonym expansion breaks regex matching)
						const episodes = await searchEpisodes({
							db,
							prefix,
							query,
							agentId,
							scope,
							scopeRef: agentScopeRef,
							...(timeRange ? { timeRange } : {}),
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
						if (conversationChunkFilter) {
							searches.push(
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
							)
						}
						if (bridgeChunkFilter) {
							searches.push(
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
									log.warn(`searchV2 hybrid bridge path failed: ${String(err)}`)
									return [] as MemorySearchResult[]
								}),
							)
						}
						// Option B: parallel search on session_chunks collection (vector + text hybrid)
						const sessionMode = resolveSessionEvidenceMode(
							process.env.MEMONGO_SESSION_EVIDENCE_MODE,
						)
						if (
							sessionMode === "B" ||
							RECOMMENDATION_MEMORY_QUERY_RE.test(searchQuery)
						) {
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

				if (pathResults.length > 0) {
					pathsExecuted.push(path)
					resultsByPath[path] = pathResults.length
					perPathResults[path] = pathResults
					results.push(...pathResults)
				}
			} catch (pathErr) {
				if (isBenchmarkStrictMode()) {
					throw pathErr
				}
				log.error(`searchV2 path ${path} failed`, { error: pathErr })
				// Continue with other paths
			}
		}

		// Deduplicate, rerank, and limit
		let deduped = deduplicateSearchResults(results)
		const needsExactProceduralBackstop =
			context.availablePaths.has("procedural") &&
			!deduped.some((result) => result.path.startsWith("procedure:"))
		if (needsExactProceduralBackstop) {
			try {
				const exactProcedureMatches = await findExactProcedureMatches(
					proceduresCollection(db, prefix),
					query,
					{
						maxResults: context.maxResults ?? 10,
						filter: proceduralFilter,
					},
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
			deduped.length < Math.max(2, Math.ceil(maxResults / 3))
		if (needsProceduralBackstop) {
			try {
				const procedureFallback = await searchProcedures(
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
						embeddingMode,
					},
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
			deduped.length < Math.max(2, Math.ceil(maxResults / 3))
		if (needsHybridBackstop) {
			try {
				// Use searchQuery (already rewritten) for the backstop, but disable rewriting
				// to prevent double-expansion (idempotent for synonyms but breaks future LLM/HyDE)
				const fallback = await searchV2(db, prefix, searchQuery, agentId, {
					...context,
					availablePaths: new Set(["hybrid"]),
					maxResults,
					searchOptions: {
						...context.searchOptions,
						allowHybridBackstop: false,
						queryRewriteConfig: undefined, // already rewritten — don't rewrite again
					},
				})
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
			const rerankResult = await crossEncoderRerank({
				db,
				prefix,
				agentId,
				query,
				results: rerankInput.length > 0 ? rerankInput : precisionScored,
				config: rerankCfg,
			})
			// Task 1.A projection: count rerank API calls during benchmark runs.
			// Counters (if injected via searchOptions) increment only when the
			// call actually hit the rerank API (reranked=true); short-circuit
			// branches do NOT count.
			const rerankCounters = context.searchOptions?.benchmarkRunCounters
			if (rerankResult.reranked && rerankCounters) {
				rerankCounters.recordRerankCall()
			}
			if (rerankResult.reranked) {
				const postRerankLaneControlled = applyLaneAwareResultControls({
					query,
					results: orderTimelineAfterSourceEvidence(
						deduplicateSearchResults([
							...applyPreferenceEvidenceBoostAfterRerank(
								query,
								rerankResult.results,
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
