/**
 * searchV2 orchestration extracted from `mongodb-manager.ts` (P4.3): the
 * planned multi-lane search entry point, lane fusion, budget accounting, and
 * result post-processing. Re-exported through `mongodb-manager.ts`; the
 * package barrels are unchanged.
 */

import type { Db, Document } from "mongodb"
import { createSubsystemLogger, type MemoryScope } from "@memongo/lib"
import { queryFailureMeta } from "./query-diagnostics.js"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import { resolveDefaultScope } from "./backend-config.js"
import { resolveConversationEvidenceMode } from "./mongodb-conversation-evidence-mode.js"
import { searchEpisodes } from "./mongodb-episodes.js"
import type { OperationRunContext } from "./mongodb-operation-accounting.js"
import { getEventsByTimeRange } from "./mongodb-events.js"
import { searchEntitiesAutocomplete, expandGraph } from "./mongodb-graph.js"
import { normalizeSearchResults, rrfScore } from "./mongodb-hybrid.js"
import { searchKB } from "./mongodb-kb-search.js"
import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import type { ProcedureState } from "./mongodb-procedures.js"
import {
	findExactProcedureMatches,
	searchProcedures,
} from "./mongodb-procedures.js"
import {
	rewriteQuery,
	type QueryRewriteConfig,
} from "./mongodb-query-rewriter.js"
import { applyPostRetrievalScoring } from "./mongodb-post-retrieval-scoring.js"
import {
	extractSessionIdFromCanonicalId,
	resolveSessionEvidenceMode,
} from "./mongodb-session-evidence.js"
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import { resolveUserfactEvidenceMode } from "./mongodb-userfact-evidence.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import { resolveEnrichmentMode } from "./mongodb-llm-enrichment.js"
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
	memoryEvidenceCollection,
	kbChunksCollection,
	proceduresCollection,
	structuredMemCollection,
	sessionChunksCollection,
} from "./mongodb-schema.js"
import { resolveScopeIdentity } from "./mongodb-scope.js"
import { mongoSearch, vectorSearch } from "./mongodb-search.js"
import {
	getSearchBudgetSnapshot,
	hasActiveSearchBudget,
	resolveSearchBudgetLimits,
	runWithSearchBudget,
	type SearchBudgetLimits,
	type SearchBudgetSnapshot,
	tryReserveSearchBudget,
} from "./mongodb-search-budget.js"
import type {
	StructuredMemorySalience,
	StructuredMemoryState,
} from "./mongodb-structured-memory.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import {
	classifyExecutorSearch,
	applyLaneAwareResultControls,
} from "./mongodb-search-executor.js"
import type {
	MemorySearchRequest,
	MemorySearchResult,
	MemorySource,
	ResolvedSearchConfig,
} from "./types.js"
import {
	applyPreferenceEvidenceBoostAfterRerank,
	applyRecencyAccessBoostAfterRerank,
	deduplicateSearchResults,
	isBenchmarkStrictMode,
	isBenchmarkTurnPrecisionMode,
	isTemporalCoverageMode,
	mergeRankedResultSets,
	normalizeProcedureState,
	normalizeStructuredSalience,
	normalizeStructuredState,
	rerankResults,
	searchResultIdentityKey,
	stripSessionSummaryTurnProvenance,
} from "./mongodb-search-ranking.js"
import {
	isConversationEvidenceQuery,
	orderTimelineAfterSourceEvidence,
} from "./mongodb-search-temporal.js"
import {
	buildGraphQueryCandidates,
	computeRawWindowEventQueryScore,
	extractRawWindowQueryTerms,
	fuseChunkLaneFilters,
	graphRelationPriority,
	isTrustedPlannerEntityCandidate,
	pickBestEntityMatch,
	searchConversationEvidenceEvents,
	searchTemporalCoverageEvents,
	searchTurnEventsWithinSessions,
} from "./mongodb-search-lanes.js"
import { extractTemporalWindow } from "./mongodb-retrieval-planner.js"

const log = createSubsystemLogger("memory:mongodb")

// P4.4.4: default temporal-proximity weight for the raw-window lane when the
// resolved rerank config does not carry one (direct searchV2 callers).
const DEFAULT_TEMPORAL_PROXIMITY_BOOST = 0.1

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

/**
 * Paths whose underlying search can fall back to a lexical lane ($search
 * keyword / $text) that emits raw BM25/textScore values on an unbounded
 * [0, inf) scale. raw-window/graph/episodic/procedural assign their own
 * bounded synthetic scores and must never be rescaled here.
 */
const LEXICAL_FALLBACK_PATHS = new Set([
	"kb",
	"memory_evidence",
	"structured",
	"active-critical",
])

/**
 * C1: a single executed lane never enters the RRF normalization block (it
 * requires >1 paths), and when that lane degraded to a lexical fallback its
 * raw BM25 scores flowed straight into reranking, outranking honest [0,1]
 * vector/fusion scores downstream. Vector and server-fusion producers are
 * already ~[0,1], so gate on BOTH signals: the executed path is
 * lexical-capable AND some score exceeds 1 (only a lexical lane produces
 * those). Apply the method-aware BM25 normalizer from mongodb-hybrid in
 * that case — strictly monotonic, so rank order is preserved — and leave
 * every other single-lane or multi-lane result byte-identical (the RRF
 * block owns the multi-lane case).
 */
export function normalizeSinglePathScores(
	results: MemorySearchResult[],
	executedPaths: readonly string[],
): MemorySearchResult[] {
	if (
		executedPaths.length !== 1 ||
		results.length === 0 ||
		!LEXICAL_FALLBACK_PATHS.has(executedPaths[0] as string)
	) {
		return results
	}
	if (!results.some((result) => result.score > 1)) {
		return results
	}
	return normalizeSearchResults(results, "text").toSorted(
		(a, b) => b.score - a.score,
	)
}

/**
 * Ranking boosts are additive and may push otherwise bounded scores above 1.
 * Scale the whole final result set by its finite maximum instead of clamping
 * each result independently, which would collapse meaningful score gaps and
 * turn distinct top results into ties.
 */
function normalizeFinalSearchScores(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const maxFiniteScore = results.reduce(
		(maxScore, result) =>
			Number.isFinite(result.score)
				? Math.max(maxScore, result.score)
				: maxScore,
		1,
	)
	return results.map((result) => ({
		...result,
		score: Number.isFinite(result.score)
			? Math.max(0, Math.min(1, result.score / maxFiniteScore))
			: result.score > 0
				? 1
				: 0,
	}))
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
	/**
	 * C-016: invoked when an individual retrieval path fails at query time
	 * (non-strict mode). The manager wires this to
	 * noteSearchLaneFailure() so index readiness is re-polled and the
	 * outage is reflected in status instead of the boot-time snapshot.
	 */
	onPathFailure?: (path: RetrievalPath, error: unknown) => void
	searchOptions?: {
		minScore?: number
		sessionKey?: string
		numCandidates?: number
		capabilities?: DetectedCapabilities
		fusionMethod?: ResolvedMongoDBConfig["fusionMethod"]
		embeddingMode?: ResolvedMongoDBConfig["embeddingMode"]
		queryEmbeddingModel?: ResolvedMongoDBConfig["queryEmbeddingModel"]
		conversationEvidenceMode?: ResolvedMongoDBConfig["conversationEvidenceMode"]
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
		operationRunContext?: OperationRunContext
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
		// D1/B3: searchV2 is the single retrieval funnel; direct callers get
		// the same identity rule (explicit scope > sessionKey implies
		// "session" > unified MEMONGO_DEFAULT_SCOPE fallback, legacy name
		// still honored on reads) so they cannot bypass it.
		const { scope, scopeRef: agentScopeRef } = resolveScopeIdentity({
			scope: context.searchOptions?.scope,
			scopeRef: context.searchOptions?.scopeRef,
			agentId,
			sessionId: context.searchOptions?.sessionKey,
			defaultScope: resolveDefaultScope({
				value: process.env.MEMONGO_DEFAULT_SCOPE,
				legacyValue: process.env.MEMONGO_SEARCH_DEFAULT_SCOPE,
				applyTo: "read",
				warn: (message) => log.warn(message),
			}),
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
		const fusionMethod = context.searchOptions?.fusionMethod ?? "scoreFusion"
		const embeddingMode = context.searchOptions?.embeddingMode ?? "automated"
		const queryEmbeddingModel =
			context.searchOptions?.queryEmbeddingModel ?? INDEX_AUTOEMBED_MODEL
		const conversationEvidenceMode =
			context.searchOptions?.conversationEvidenceMode ??
			resolveConversationEvidenceMode(
				process.env.MEMONGO_CONVERSATION_EVIDENCE_MODE,
			)
		const hybridMode =
			context.searchOptions?.searchConfig?.hybridMode ?? "hybrid"
		const bridgeMaxResults =
			context.searchOptions?.bridgeMaxResults ??
			Math.max(2, Math.ceil(maxResults / 3))
		const allowHybridBackstop =
			context.searchOptions?.allowHybridBackstop ?? true
		// B14: one reference clock per request. Benchmarks stamp
		// searchOptions.questionDate so fixed-clock ranking is deterministic;
		// live traffic falls back to the wall clock. Every relative-time
		// derivation below (time-range preset resolution, raw-window fallback
		// bounds, temporal-window extraction) uses this clock instead of
		// reading Date.now() independently.
		const referenceDate = context.searchOptions?.questionDate ?? new Date()

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
			// C-002: the coverage read can echo the query-bearing filter or
			// credentials in its driver message; queryFailureMeta redacts both
			// and preserves digest correlation, same as the outer failure seam.
			log.warn("Failed to load lane coverage for planner", {
				agentId,
				...queryFailureMeta(query, err),
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
			? resolveTimeRangePreset(plan.constraints.timeRange.preset, referenceDate)
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
								queryEmbeddingModel,
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
								queryEmbeddingModel,
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
								timeRange?.start ??
								new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000),
							end: timeRange?.end ?? referenceDate,
							scope,
							scopeRef: agentScopeRef,
							limit: rawWindowLimit,
						})
						const queryTerms = extractRawWindowQueryTerms(query)
						// P4.4.4 temporal proximity scoring (hindsight): when the
						// query implies a temporal window, events nearer the window
						// midpoint (origin ± scaleDays) outrank equally matched far
						// ones. Normalized to [0,1] by the window scale; weight 0
						// disables (config reranking.temporalProximityBoost).
						const temporalWindow = extractTemporalWindow(query, referenceDate)
						const temporalProximityWeight =
							context.searchOptions?.rerankConfig?.temporalProximityBoost ??
							DEFAULT_TEMPORAL_PROXIMITY_BOOST
						const temporalScaleMs = temporalWindow
							? temporalWindow.scaleDays * 24 * 60 * 60 * 1000
							: 0
						const temporalProximityOf = (timestamp: Date): number =>
							temporalWindow && temporalProximityWeight > 0
								? Math.max(
										0,
										1 -
											Math.abs(
												timestamp.getTime() - temporalWindow.origin.getTime(),
											) /
												temporalScaleMs,
									)
								: 0
						const scoredEvents = events.map((event) => ({
							event,
							matchScore: computeRawWindowEventQueryScore(
								event.body,
								queryTerms,
							),
							temporalProximity: temporalProximityOf(event.timestamp),
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
								if (right.temporalProximity !== left.temporalProximity) {
									return right.temporalProximity - left.temporalProximity
								}
								return (
									right.event.timestamp.getTime() -
									left.event.timestamp.getTime()
								)
							})
						pathResults = rankedEvents.map(
							({ event: e, matchScore, temporalProximity }, i) => ({
								path: `events/${e.eventId}`,
								filePath: `events/${e.eventId}`,
								startLine: 0,
								endLine: 0,
								snippet: e.body,
								score: Math.max(
									0.35,
									1 -
										i * 0.01 +
										Math.min(matchScore * 0.03, 0.12) +
										temporalProximity * temporalProximityWeight,
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
							}),
						)
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
								queryEmbeddingModel,
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
												queryEmbeddingModel,
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
													queryEmbeddingModel,
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
												queryEmbeddingModel,
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
													queryEmbeddingModel,
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
												queryEmbeddingModel,
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
													queryEmbeddingModel,
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
								// C-005: hide expired session-evidence docs
								// during the TTL sweep lag. $vectorSearch
								// filters do not support $exists, so the
								// "missing field" arm uses $eq null (null
								// equality matches missing fields under
								// $match semantics).
								$or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
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
												queryEmbeddingModel,
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
													queryEmbeddingModel,
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
												queryEmbeddingModel,
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
													queryEmbeddingModel,
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
								queryEmbeddingModel,
								fusionMethod,
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
				// C-016: surface the failure so the manager can re-poll index
				// readiness. Never let the hook break the remaining paths.
				try {
					context.onPathFailure?.(path, pathErr)
				} catch (hookErr) {
					log.warn(`searchV2 onPathFailure hook failed`, {
						error: hookErr,
					})
				}
				// Continue with other paths
				return []
			}
		}

		const runConversationEvidence = async (
			reservation?: ReturnType<typeof tryReserveSearchBudget>,
		): Promise<MemorySearchResult[]> =>
			timeLane("phase:conversation-evidence", async () => {
				try {
					return await searchConversationEvidenceEvents({
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
						queryEmbeddingModel,
						budgetReservation: reservation,
					})
				} catch (err) {
					if (isBenchmarkStrictMode()) {
						throw err
					}
					log.warn(`conversation evidence search failed: ${String(err)}`)
					return []
				} finally {
					reservation?.release()
				}
			})

		type ConversationEvidenceOutcome =
			| { results: MemorySearchResult[] }
			| { error: unknown }
		const captureConversationEvidence = (
			promise: Promise<MemorySearchResult[]>,
		): Promise<ConversationEvidenceOutcome> =>
			promise.then(
				(results) => ({ results }),
				(error: unknown) => ({ error }),
			)

		let parallelConversationEvidence:
			| Promise<ConversationEvidenceOutcome>
			| undefined
		const conversationRetrievalAvailable = (
			["raw-window", "hybrid", "graph", "episodic"] as const
		).some((path) => context.availablePaths.has(path))
		if (
			conversationEvidenceMode === "parallel" &&
			conversationRetrievalAvailable
		) {
			const isEvidenceQuery = isConversationEvidenceQuery(
				searchQuery,
				context.searchOptions?.questionDate,
			)
			const reservation = isEvidenceQuery
				? tryReserveSearchBudget({
						aggregations:
							(capabilities.vectorSearch && embeddingMode === "automated"
								? 1
								: 0) + (capabilities.textSearch ? 1 : 0),
						embeds:
							capabilities.vectorSearch && embeddingMode === "automated"
								? 1
								: 0,
					})
				: undefined
			parallelConversationEvidence =
				isEvidenceQuery && !reservation
					? Promise.resolve({ results: [] })
					: captureConversationEvidence(runConversationEvidence(reservation))
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
							queryEmbeddingModel,
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
		const resultNormalizationStartedAt = Date.now()
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
		} else {
			// C1: the RRF block skips the single-lane case; normalize an
			// unbounded lexical lane here instead of leaking raw BM25 into
			// reranking.
			deduped = normalizeSinglePathScores(deduped, Object.keys(perPathResults))
		}
		latencyByPath["phase:result-normalization"] =
			Date.now() - resultNormalizationStartedAt

		const heuristicRerankStartedAt = Date.now()
		const heuristicReranked = rerankResults(deduped, query)
		latencyByPath["phase:heuristic-rerank"] =
			Date.now() - heuristicRerankStartedAt

		// Post-retrieval scoring: keyword, temporal, entity, quoted-phrase boosts
		// Applied AFTER heuristic rerank, BEFORE cross-encoder rerank
		const postRetrievalScoringStartedAt = Date.now()
		const postScored = applyPostRetrievalScoring(query, heuristicReranked, {
			questionDate: context.searchOptions?.questionDate,
		})
		latencyByPath["phase:post-retrieval-scoring"] =
			Date.now() - postRetrievalScoringStartedAt
		let conversationEvidenceResults: MemorySearchResult[] = []
		if (conversationEvidenceMode === "parallel") {
			const outcome = await parallelConversationEvidence
			if (outcome && "error" in outcome) {
				throw outcome.error
			}
			conversationEvidenceResults = outcome?.results ?? []
		} else if (
			conversationEvidenceMode === "serial" &&
			conversationRetrievalAvailable
		) {
			conversationEvidenceResults = await runConversationEvidence()
		}
		const temporalCoverageResults = isTemporalCoverageMode()
			? await timeLane("phase:temporal-coverage", () =>
					searchTemporalCoverageEvents({
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
					}),
				)
			: []
		const temporalCandidateMergeStartedAt = Date.now()
		const temporalCandidateBase =
			temporalCoverageResults.length > 0
				? deduplicateSearchResults([...temporalCoverageResults, ...postScored])
				: postScored
		latencyByPath["phase:temporal-candidate-merge"] =
			Date.now() - temporalCandidateMergeStartedAt
		const turnPrecisionResults = isBenchmarkTurnPrecisionMode()
			? await timeLane("phase:turn-precision", () =>
					searchTurnEventsWithinSessions({
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
						queryEmbeddingModel,
					}).catch((err) => {
						if (isBenchmarkStrictMode()) {
							throw err
						}
						log.warn(`turn precision rerank failed: ${String(err)}`)
						return [] as MemorySearchResult[]
					}),
				)
			: []
		const precisionMergeStartedAt = Date.now()
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
		latencyByPath["phase:precision-merge"] =
			Date.now() - precisionMergeStartedAt
		const preRerankLaneControlsStartedAt = Date.now()
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
		latencyByPath["phase:lane-controls-pre-rerank"] =
			Date.now() - preRerankLaneControlsStartedAt

		// Cross-encoder re-ranking via Voyage API (after heuristic, before final slice)
		const rerankCfg = context.searchOptions?.rerankConfig
		let finalResults = laneControlled.results
		let laneControlSummary = laneControlled.summary
		let wasReranked = false
		if (rerankCfg?.enabled) {
			const rerankInputStartedAt = Date.now()
			const timelineResults = finalResults.filter(
				(result) => result.provenance?.temporalTimeline === true,
			)
			const rerankInput = finalResults.filter(
				(result) => result.provenance?.temporalTimeline !== true,
			)
			latencyByPath["phase:rerank-input"] = Date.now() - rerankInputStartedAt
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
							context.searchOptions?.operationRunContext?.accounting
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
				const postRerankLaneControlsStartedAt = Date.now()
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
				latencyByPath["phase:lane-controls-post-rerank"] =
					Date.now() - postRerankLaneControlsStartedAt
				finalResults = postRerankLaneControlled.results
				laneControlSummary = postRerankLaneControlled.summary
				wasReranked = true
			}
		}

		// Ranking boosts run after lane normalization and can compound above 1.
		// Preserve their ordering and relative score gaps while enforcing the
		// public searchV2 score contract for every lane and reranker branch.
		const finalNormalizeStartedAt = Date.now()
		const sliced = normalizeFinalSearchScores(finalResults).slice(0, maxResults)
		latencyByPath["phase:final-normalize"] =
			Date.now() - finalNormalizeStartedAt

		// Phase 9: Tiered retrieval — strip text for ids-only projection mode
		const projectionMode = context.searchOptions?.projection ?? "full"
		const projectionStartedAt = Date.now()
		const projected =
			projectionMode === "ids-only"
				? sliced.map((r) => ({ ...r, snippet: "" }))
				: sliced
		latencyByPath["phase:projection"] = Date.now() - projectionStartedAt

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
		// C-002: raw query text never enters diagnostics — length + digest
		// preserve correlation without content (see query-diagnostics.ts).
		log.error("searchV2 failed", queryFailureMeta(query, err))
		throw err
	}
}
