/**
 * searchV2 orchestration extracted from `mongodb-manager.ts` (P4.3): the
 * planned multi-lane search entry point, lane fusion, budget accounting, and
 * result post-processing. Re-exported through `mongodb-manager.ts`; the
 * package barrels are unchanged.
 */

import type { Db, Document } from "mongodb"
import { createSubsystemLogger, type MemoryScope } from "@memongo/lib"
import { settledFailureMeta } from "./query-diagnostics.js"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import { resolveDefaultScope } from "./backend-config.js"
import { resolveConversationEvidenceMode } from "./mongodb-conversation-evidence-mode.js"
import { searchEpisodes } from "./mongodb-episodes.js"
import type { OperationRunContext } from "./mongodb-operation-accounting.js"
import { getEventsByTimeRange } from "./mongodb-events.js"
import { searchEntitiesAutocomplete, expandGraph } from "./mongodb-graph.js"
import type { GraphExpansionResult } from "./mongodb-graph.js"
import { derivationFromRole } from "./memory-derivation.js"
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
import {
	crossEncoderRerank,
	RERANK_TIMEOUT_MS,
	type RerankConfig,
} from "./mongodb-reranker.js"
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
	DEFAULT_USER_SEARCH_MAX_TIME_MS,
	getSearchBudgetSnapshot,
	hasActiveSearchBudget,
	resolveSearchBudgetLimits,
	runWithSearchBudget,
	type SearchBudgetLimits,
	type SearchBudgetSnapshot,
	tryReserveSearchBudget,
} from "./mongodb-search-budget.js"
import { tryConsumeSearchAdmission } from "./mongodb-search-admission.js"
import { emitTelemetry, type TelemetryDocument } from "./mongodb-telemetry.js"
import type { AdmissionToken } from "./mongodb-write-fence.js"
import type {
	StructuredMemorySalience,
	StructuredMemoryState,
} from "./mongodb-structured-memory.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import {
	classifyExecutorSearch,
	applyLaneAwareResultControls,
	resolveExecutorTimeRangeAt,
} from "./mongodb-search-executor.js"
import { buildUnexpiredClause, mergeQueryClauses } from "./mongodb-temporal.js"
import type {
	MemorySearchRequest,
	MemorySearchResult,
	MemorySource,
	ResolvedSearchConfig,
	SearchLaneOutcome,
} from "./types.js"
// RET-13: the shared per-lane outcome shape lives in types.ts (the executor
// merge consumes it on MemorySearchMetadata too); re-exported here so the
// v2 public surface is unchanged.
export type { SearchLaneOutcome } from "./types.js"
import {
	applyPreferenceEvidenceBoostAfterRerank,
	clampSearchQuery,
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
	/**
	 * RET-13: paths whose lanes were ATTEMPTED this search — including
	 * ones that returned empty or failed (their detail is in laneOutcomes;
	 * contribution is in resultsByPath). Previously only contributing
	 * paths were listed, making executed-empty and failed lanes
	 * indistinguishable from skipped ones.
	 */
	pathsExecuted: RetrievalPath[]
	resultsByPath: Record<string, number>
	/** RET-13: per-lane/phase outcome detail (attempted, failed, denied). */
	laneOutcomes?: SearchLaneOutcome[]
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
	/**
	 * WS-11 change 2 (09-report R5/U1): set when process-level admission
	 * control DENIED this request before any lane ran. A throttled response
	 * is a distinct outcome — never an empty-success: results are empty AND
	 * this marker says why, with the earliest retry hint. Consumers (WS-12)
	 * must report throttling as throttling, not as "no memories".
	 */
	throttled?: { retryAfterMs: number }
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
 * RET-05: render the graph-lane snippet from the ACTUAL edge, not from the
 * assumption that the root is the edge's subject. The old
 * `${root.name} ${type} ${neighbor.name}` template asserted false facts for
 * incoming edges (the neighbor was the subject) and for multi-hop edges
 * (neither endpoint was the root at all). Direction comes from the resolved
 * endpoints expandGraph now carries; a multi-hop edge between two neighbors
 * gets an explicit "observed near" note instead of a direct root assertion.
 */
export function renderGraphRelationSnippet(
	connection: GraphExpansionResult["connections"][number],
	root: { entityId: string; name: string },
): string {
	const { relation, depth } = connection
	const fromName = connection.fromEntity?.name
	const toName = connection.toEntity?.name
	if (!fromName || !toName) {
		// Dangling endpoint document(s): assert nothing about direction.
		return `${connection.entity.name} (${relation.type})`
	}
	const edge = `${fromName} ${relation.type} ${toName}`
	const rootIsEndpoint =
		relation.fromEntityId === root.entityId ||
		relation.toEntityId === root.entityId
	if (!rootIsEndpoint && depth > 0) {
		return `${edge} (observed near ${root.name}, ${depth}-hop)`
	}
	return edge
}

/**
 * WS-16 (C-031): the end-to-end tail budget one search may spend — the
 * documented 12s worst-case composition (10s maxTimeMS aggregate + 2s
 * rerank timeout) pinned by
 * mongodb-search-latency-composition.test.ts. searchV2 stamps its start
 * time and hands rerank the REMAINDER of this budget, so the provider call
 * can never stack its full 2s cap on top of an already-consumed tail.
 */
export const SEARCH_TAIL_COMPOSITION_BUDGET_MS =
	DEFAULT_USER_SEARCH_MAX_TIME_MS + RERANK_TIMEOUT_MS

/**
 * searchV2 entry point: opens the per-request cost budget (P3.2) that every
 * lane, waterfall stage, and backstop consumes. Every entry clamps query text.
 * When a budget is already active — the recursive hybrid backstop re-entering
 * searchV2 — the call
 * shares it instead of opening a fresh one, so a backstop can never reset
 * the storm counter.
 */
function emitSearchTelemetry(
	db: Db,
	prefix: string,
	doc: Omit<TelemetryDocument, "ts">,
	admission?: AdmissionToken,
): void {
	if (admission) {
		void emitTelemetry(db, prefix, doc, { admission }).catch(() =>
			log.warn("searchV2 telemetry emit failed"),
		)
	} else {
		emitTelemetry(db, prefix, doc)
	}
}

export async function searchV2(
	db: Db,
	prefix: string,
	query: string,
	agentId: string,
	context: SearchV2Context,
): Promise<{ results: MemorySearchResult[]; metadata: V2SearchMetadata }> {
	const boundedQuery = clampSearchQuery(query)
	if (boundedQuery.length < query.length) {
		emitSearchTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "search-query-clamped" },
				durationMs: 0,
				ok: true,
				queryLength: query.length,
			},
			context.admission,
		)
	}
	if (hasActiveSearchBudget()) {
		const value = await searchV2WithBudget(
			db,
			prefix,
			boundedQuery,
			agentId,
			context,
		)
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
	// WS-11 change 1+2 (09-report R5/U1): process-level admission control.
	// Top-level entries only — the recursive backstop above shares the
	// parent's budget AND its admission, so a re-entry never double-charges.
	// Denial produces a DISTINCT throttled outcome (empty results + marker +
	// retry hint), never an empty-success: callers can tell "overloaded"
	// apart from "no memories", which is what WS-12 reports upstream.
	const admission = tryConsumeSearchAdmission()
	if (!admission.ok) {
		emitSearchTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "search" },
				durationMs: 0,
				ok: false,
				throttled: true,
				resultCount: 0,
			},
			context.admission,
		)
		const plan = planRetrieval(boundedQuery, {
			availablePaths: context.availablePaths,
			hasEpisodes: context.hasEpisodes,
			hasGraphData: context.hasGraphData,
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
		return {
			results: [],
			metadata: {
				plan,
				pathsExecuted: [],
				resultsByPath: {},
				throttled: { retryAfterMs: admission.retryAfterMs },
			},
		}
	}
	const limits = resolveSearchBudgetLimits(context.searchOptions?.budget)
	const { value, budget } = await runWithSearchBudget(limits, () =>
		searchV2WithBudget(db, prefix, boundedQuery, agentId, context),
	)
	return { results: value.results, metadata: { ...value.metadata, budget } }
}

export type SearchV2Context = {
	admission?: AdmissionToken
	availablePaths: Set<RetrievalPath>
	knownEntityNames?: string[]
	hasEpisodes?: boolean
	hasGraphData?: boolean
	maxResults?: number
	/**
	 * C-016 + RET-13: invoked at the ACTUAL catch seam when an individual
	 * lane, sub-lane, or phase fails at query time (non-strict mode). The
	 * manager wires this to noteSearchLaneFailure() so index readiness is
	 * re-polled and the outage is reflected in status instead of the
	 * boot-time snapshot. Labels are seam-level strings — a path name
	 * ("hybrid"), a sub-lane ("hybrid:chunks"), or a phase
	 * ("phase:conversation-evidence", "kb:$text").
	 */
	onPathFailure?: (lane: string, error: unknown) => void
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
		/**
		 * RET-02: executor-resolved bounds (preset resolved, or explicit
		 * start+end parsed) forwarded by the manager's executePass — the
		 * pass-level original or corrective-widened window. Engine-internal
		 * seam: the public `timeRange` request field already exists on every
		 * public surface; this is only the manager→V2 hand-off, and it takes
		 * precedence over both the raw `timeRange` and any plan-inferred
		 * preset. Direct callers omit it and have their raw `timeRange`
		 * resolved here with the executor's precedence.
		 */
		resolvedTimeRange?: { start: Date; end: Date }
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

/**
 * RET-06 (wave 3b): a caller-supplied chunk filter cannot widen tenant
 * identity. The resolved identity keys (agentId, scope, scopeRef) overwrite
 * any caller-supplied top-level values — a foreign identity arm (e.g.
 * `agentId: {$in: [...]}` or a different scope) can never cross scopes.
 * Nested $and/$or arms only ever AND with the forced top-level keys, so
 * enforcement strictly narrows. Lifecycle predicates (status, expiresAt)
 * remain the custom filter's responsibility — the audit's validation
 * requirement is identity-scoped ("cannot widen identity").
 */
function enforceResolvedChunkIdentity(
	filter: Document,
	identity: { agentId: string; scope: MemoryScope; scopeRef: string },
): Document {
	return {
		...filter,
		agentId: identity.agentId,
		scope: identity.scope,
		scopeRef: identity.scopeRef,
	}
}

async function searchV2WithBudget(
	db: Db,
	prefix: string,
	query: string,
	agentId: string,
	context: SearchV2Context,
): Promise<{ results: MemorySearchResult[]; metadata: V2SearchMetadata }> {
	// WS-16 (C-031): wall-clock start of the whole search. The rerank stage
	// derives its provider timeout from what REMAINS of the tail budget, so
	// the last stage is bounded by the composition, not just by its own cap.
	const searchStartedAt = Date.now()
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
		// B14: one reference clock per request. Benchmarks stamp
		// searchOptions.questionDate so fixed-clock ranking is deterministic;
		// live traffic falls back to the wall clock. Every relative-time
		// derivation below (time-range preset resolution, explicit range
		// resolution, raw-window fallback bounds, temporal-window extraction)
		// uses this clock instead of reading Date.now() independently.
		// Retention is the exception; see retentionDate below.
		const referenceDate = context.searchOptions?.questionDate ?? new Date()
		// Expiration uses the current time, independently of the historical
		// validity clock above.
		const retentionDate = new Date()
		// RET-02: resolved explicit bounds are a first-class V2 input. The
		// manager forwards the executor-resolved pass range (original or
		// widened corrective window) as `resolvedTimeRange`; a direct
		// caller's raw `timeRange` request field is resolved here with the
		// SAME precedence the executor applies (preset wins; partial or
		// unparseable explicit bounds mean no range), against the B14
		// reference clock. Inferred (query-text) presets never set this —
		// they stay soft ranking hints (Decision 2 in the wave 3b report).
		const explicitTimeRange =
			context.searchOptions?.resolvedTimeRange ??
			resolveExecutorTimeRangeAt(
				context.searchOptions?.timeRange,
				referenceDate,
			)
		// RET-06: the default conversation filter at this direct-call seam
		// now derives from the resolved tenant identity and the canonical
		// lifecycle predicates — the same shape the manager path builds
		// (buildConversationChunkFilter): identity pinned to the resolved
		// scope/scopeRef, non-deleted status, and the TTL-expiry clause
		// against the wall clock (retention is never historical). Direct
		// callers can no longer read across scopes or surface expired chunks
		// by default.
		// Caller-supplied custom filters keep their own lifecycle arms but
		// get the resolved identity keys overwritten — identity cannot be
		// widened (nested $and/$or arms only ever AND with the forced
		// top-level keys).
		const baseConversationChunkFilter: Document = context.searchOptions
			?.conversationFilter
			? enforceResolvedChunkIdentity(context.searchOptions.conversationFilter, {
					agentId,
					scope,
					scopeRef: agentScopeRef,
				})
			: mergeQueryClauses(
					{
						source: { $in: chunkSources },
						agentId,
						scope,
						scopeRef: agentScopeRef,
						status: { $ne: "deleted" },
					},
					buildUnexpiredClause({
						field: "expiresAt",
						asOf: retentionDate,
					}),
				)
		const baseBridgeChunkFilter = context.searchOptions?.bridgeFilter
			? enforceResolvedChunkIdentity(context.searchOptions.bridgeFilter, {
					agentId,
					scope,
					scopeRef: agentScopeRef,
				})
			: undefined
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
		// C-026: conversation chunks are bitemporal — each carries the
		// event-valid interval [validAt, invalidAt) carved from its event by
		// projectEventChunk. A chunk not yet valid (validAt after the request's
		// reference clock) or already invalidated (invalidAt at or before it)
		// is stale evidence and must not surface. Fused into the lane filter at
		// construction instead of post-filtering so the constraint rides the
		// index-adjacent filter: $and/$or compounds are supported
		// $vectorSearch filter expressions, and null-equality matches the
		// missing field on pre-C-026 chunks ($exists is NOT supported inside
		// $vectorSearch filters). Both wrapped filters carry identical arms,
		// so lane fusion's conversation-filter spread drops only a duplicate.
		//
		// RET-02 (wave 3b): the wrapper now also carries the occurrence-time
		// guard — an explicit caller range appends a `timestamp` $gte/$lte
		// arm so the vector/text candidate pool is bounded BEFORE ANN
		// traversal / postMatch instead of being crowded out pre-filter.
		// `timestamp` (event occurrence time, the same field the executor's
		// final original-constraint check validates on result.timestamp) is
		// declared as a filter path on chunks_vector; a missing-timestamp
		// legacy doc fails this arm exactly as it fails that check. Inferred
		// (plan-preset) windows add NO arm — they stay soft ranking hints.
		const chunkLaneGuardArms: Document[] = [
			{ $or: [{ validAt: null }, { validAt: { $lte: referenceDate } }] },
			{ $or: [{ invalidAt: null }, { invalidAt: { $gt: referenceDate } }] },
			...(explicitTimeRange
				? [
						{
							timestamp: {
								$gte: explicitTimeRange.start,
								$lte: explicitTimeRange.end,
							},
						},
					]
				: []),
		]
		const withChunkLaneGuards = (base: Document): Document => ({
			...base,
			$and: [
				...(Array.isArray(base.$and) ? base.$and : []),
				...chunkLaneGuardArms,
			],
		})
		const conversationChunkFilter = withChunkLaneGuards(
			baseConversationChunkFilter,
		)
		const bridgeChunkFilter = baseBridgeChunkFilter
			? withChunkLaneGuards(baseBridgeChunkFilter)
			: undefined

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
			// Driver text may echo user content; structural fields avoid echo processing.
			log.warn("Failed to load lane coverage for planner", {
				agentId,
				...settledFailureMeta(err, query),
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
					admission: context.admission,
					db,
					prefix,
					agentId,
					query,
					config: qrConfig,
				}),
			)
			if (rewriteResult.rewritten) {
				searchQuery = clampSearchQuery(rewriteResult.rewrittenQuery)
				if (searchQuery.length < rewriteResult.rewrittenQuery.length) {
					emitSearchTelemetry(
						db,
						prefix,
						{
							meta: { agentId, operation: "search-query-clamped" },
							durationMs: 0,
							ok: true,
							queryLength: rewriteResult.rewrittenQuery.length,
						},
						context.admission,
					)
				}
				wasQueryRewritten = true
			}
		}

		const constrainedGraphCandidates =
			plan.constraints?.entities?.names &&
			plan.constraints.entities.names.length > 0
				? plan.constraints.entities.names
				: graphQueryCandidates
		// RET-02: an explicit caller range takes precedence over the
		// plan-inferred (query-text) preset — every existing consumer of
		// this binding (raw-window start/end, episodic forwarding,
		// structured/procedural/active-critical/graph asOf) now sees the
		// explicit bounds first. Inferred presets keep today's soft-window
		// behavior when no explicit range exists.
		const timeRange =
			explicitTimeRange ??
			(plan.constraints?.timeRange
				? resolveTimeRangePreset(
						plan.constraints.timeRange.preset,
						referenceDate,
					)
				: undefined)
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
			...(context.searchOptions?.structuredScope?.type
				? { type: context.searchOptions.structuredScope.type }
				: plan.constraints?.structured?.type
					? { type: plan.constraints.structured.type }
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
			...(!context.searchOptions?.referenceScope?.source &&
			!context.searchOptions?.referenceScope?.category
				? {
						...(plan.constraints?.kb?.source
							? { source: plan.constraints.kb.source }
							: {}),
						...(plan.constraints?.kb?.category
							? { category: plan.constraints.kb.category }
							: {}),
					}
				: {}),
		}

		const results: MemorySearchResult[] = []
		const pathsExecuted: RetrievalPath[] = []
		const resultsByPath: Record<string, number> = {}
		// C3 audit fix: track per-path results for RRF score normalization
		const perPathResults: Record<string, MemorySearchResult[]> = {}
		// RET-13: per-lane outcome ledger (metadata surface) + the ONE
		// failure policy used at every catch seam — the outer
		// executeSearchPath catch's model: strict → rethrow so the search
		// fails loudly; else log + surface at the actual seam via
		// onPathFailure + record the outcome + degrade to empty.
		const laneOutcomes: SearchLaneOutcome[] = []
		const emitLaneFailure = (lane: string, err: unknown): void => {
			log.warn("searchV2 lane failed", { lane, ...settledFailureMeta(err) })
			laneOutcomes.push({
				lane,
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			})
			// C-016: surface the failure so the manager can re-poll index
			// readiness. Never let the hook break the remaining lanes.
			try {
				context.onPathFailure?.(lane, err)
			} catch (hookErr) {
				log.warn(`searchV2 onPathFailure hook failed`, { error: hookErr })
			}
		}
		/**
		 * Shared inner-catch handler for sub-lane promises (RET-13): the
		 * catch sits on the individual lane promise, so a failure degrades
		 * ONLY that lane — sibling lanes inside the same path keep their
		 * results — while still surfacing the failure in non-strict mode.
		 */
		const onLaneError =
			(lane: string) =>
			(err: unknown): MemorySearchResult[] => {
				if (isBenchmarkStrictMode()) {
					throw err
				}
				emitLaneFailure(lane, err)
				return []
			}

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
						).catch(onLaneError("active-critical"))
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
						).catch(onLaneError("structured"))
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
								// RET-09: raw events carry the turn's authoring
								// role natively — label it instead of dropping it.
								role: e.role,
								derivation: derivationFromRole(e.role),
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
										// C-025: typed locator ("from-to-type") so readFile
										// resolves same-pair relations of different types.
										path: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}-${c.relation.type}`,
										filePath: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}-${c.relation.type}`,
										startLine: 0,
										endLine: 0,
										// RET-05: render the actual edge (see
										// renderGraphRelationSnippet) — the old
										// root-subject template asserted false facts for
										// incoming and multi-hop edges.
										snippet: renderGraphRelationSnippet(c, {
											entityId: entity.entityId,
											name: graph.rootEntity.name,
										}),
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
										// RET-09: graph relations are extracted/inferred
										// structure, never user-authored spans.
										derivation: "inferred",
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
							// RET-09: episodes are agent-generated layered
							// summaries of consolidated events.
							derivation: "derived",
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
						).catch(onLaneError("procedural"))
						pathResults = procedureHits
						break
					}
					case "hybrid": {
						if (
							hybridMode === "vector-only" &&
							!capabilities.vectorSearch &&
							!capabilities.textSearch
						) {
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
									).catch(onLaneError("hybrid:chunks")),
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
									).catch(onLaneError("hybrid:chunks")),
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
									).catch(onLaneError("hybrid:bridge")),
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
						if (
							sessionMode === "B" &&
							(capabilities.vectorSearch || capabilities.textSearch)
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
								// C-005: hide expired session-evidence docs
								// during the TTL sweep lag. The "missing
								// field" arm uses $eq null (null equality
								// matches missing fields under $match
								// semantics). $vectorSearch filters do support
								// $exists (MongoDB changelog, 06 Nov 2025); the
								// null arm is kept deliberately since it also
								// covers explicit nulls.
								$or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
								// RET-02 (wave 3b): occurrence-time guard for
								// the session-evidence lane — same
								// explicit-range semantics as the chunk
								// lanes. `timestamp` (first user turn time)
								// is declared as a filter path on
								// session_chunks_vector.
								...(explicitTimeRange
									? {
											timestamp: {
												$gte: explicitTimeRange.start,
												$lte: explicitTimeRange.end,
											},
										}
									: {}),
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
									).catch(onLaneError("hybrid:session_chunks")),
								),
							)
						}
						if (
							isEvidenceMirrorEnabled() &&
							(capabilities.vectorSearch || capabilities.textSearch)
						) {
							const requestedMaxResults = context.maxResults ?? 10
							const evidenceMaxResults = Math.max(requestedMaxResults * 6, 30)
							const evidenceFilter: Document = {
								agentId,
								scope,
								scopeRef: agentScopeRef,
								status: "active",
								// RET-02 (wave 3b): occurrence-time guard for
								// the memory-evidence lane — `timestamp` is
								// already declared as a filter path on
								// memory_evidence_vector.
								...(explicitTimeRange
									? {
											timestamp: {
												$gte: explicitTimeRange.start,
												$lte: explicitTimeRange.end,
											},
										}
									: {}),
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
										.catch(onLaneError("hybrid:memory_evidence")),
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
								// RET-13: the KB waterfall runs its own degrade chain —
								// thread the shared policy so stage failures surface (and
								// strict mode fails loudly) instead of being swallowed
								// inside the waterfall.
								strict: isBenchmarkStrictMode(),
								onLaneFailure: (lane, err) => emitLaneFailure(lane, err),
							},
						).catch(onLaneError("kb"))
						pathResults = kbHits
						break
					}
				}

				// RET-13: success outcome at the executor's single success exit
				// (failed paths record "failed" in the catch below; empty is
				// still ok — resultCount carries the distinction).
				laneOutcomes.push({
					lane: path,
					status: "ok",
					resultCount: pathResults.length,
				})
				return pathResults
			} catch (pathErr) {
				if (isBenchmarkStrictMode()) {
					throw pathErr
				}
				log.error(`searchV2 path ${path} failed`, { error: pathErr })
				// RET-13: the outer catch models the shared policy (strict →
				// rethrow; else record + surface + degrade). Whole-path
				// failures keep their error-level log; inner lanes log at
				// warn.
				laneOutcomes.push({
					lane: path,
					status: "failed",
					error: pathErr instanceof Error ? pathErr.message : String(pathErr),
				})
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
						onBranchFailure: (branch, error) =>
							emitLaneFailure(`phase:conversation-evidence:${branch}`, error),
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
						// RET-02 (wave 3b): explicit bounds reach the evidence
						// lane; it composes them with the questionDate upper
						// bound (no future leakage past what the user had
						// seen). Inferred presets keep the questionDate-only
						// bound.
						...(explicitTimeRange ? { timeRange: explicitTimeRange } : {}),
					})
				} catch (err) {
					if (isBenchmarkStrictMode()) {
						throw err
					}
					emitLaneFailure("phase:conversation-evidence", err)
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
					? (async () => {
							// RET-16/RET-13: budget refused the conversation-evidence
							// lane — record the denial instead of silently dropping it.
							laneOutcomes.push({
								lane: "phase:conversation-evidence",
								status: "budget-denied",
							})
							return { results: [] as MemorySearchResult[] }
						})()
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
			// RET-13: pathsExecuted is ATTEMPTED semantics — a path that ran
			// empty or failed still executed (outcome ledger records which).
			// resultsByPath keeps contributed-only semantics.
			pathsExecuted.push(path)
			if (pathResults.length > 0) {
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
				log.warn(
					"searchV2 exact procedural backstop failed",
					settledFailureMeta(err),
				)
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
					// RET-13: the main loop already registers an attempted
					// (empty) procedural pass under attempted semantics —
					// never double-list the path.
					if (!pathsExecuted.includes("procedural")) {
						pathsExecuted.push("procedural")
					}
					laneOutcomes.push({
						lane: "backstop:procedural",
						status: "ok",
						resultCount: procedureFallback.length,
					})
					resultsByPath.procedural = procedureFallback.length
					perPathResults.procedural = procedureFallback
					deduped = deduplicateSearchResults([...deduped, ...procedureFallback])
				}
			} catch (err) {
				if (isBenchmarkStrictMode()) {
					throw err
				}
				emitLaneFailure("backstop:procedural", err)
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
					laneOutcomes.push({
						lane: "backstop:hybrid",
						status: "ok",
						resultCount: fallback.results.length,
					})
					resultsByPath.hybrid = fallback.results.length
					perPathResults.hybrid = fallback.results
					deduped = deduplicateSearchResults([...deduped, ...fallback.results])
				}
			} catch (err) {
				if (isBenchmarkStrictMode()) {
					throw err
				}
				emitLaneFailure("backstop:hybrid", err)
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
		} else if (conversationEvidenceMode === "serial") {
			// RET-13: serial mode asked for conversation evidence but no
			// conversation-capable lane is available — record, don't imply it ran.
			laneOutcomes.push({
				lane: "phase:conversation-evidence",
				status: "unavailable",
			})
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
						emitLaneFailure("phase:temporal-coverage", err)
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
						onBranchFailure: (branch, error) =>
							emitLaneFailure(`phase:turn-precision:${branch}`, error),
						db,
						prefix,
						query: searchQuery,
						questionDate: context.searchOptions?.questionDate,
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
						emitLaneFailure("phase:turn-precision", err)
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
					admission: context.admission,
					db,
					prefix,
					agentId,
					query,
					results: rerankInput.length > 0 ? rerankInput : precisionScored,
					config: rerankCfg,
					// WS-16 (C-031): the provider call gets only what the
					// search has left of its tail budget, never its own full
					// 2s cap stacked on an already-slow tail.
					remainingBudgetMs: Math.max(
						0,
						SEARCH_TAIL_COMPOSITION_BUDGET_MS - (Date.now() - searchStartedAt),
					),
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
				// RET-08: post-CE boosts refine only the CE-scored partition
				// (they are cross-encoder refinements, not retrieval-score
				// corrections), and the untouched partitions keep their
				// original retrieval order behind the CE head. Composing in
				// partition order — then sorting segment-stable in lane
				// controls — keeps CE-ranked results ahead of higher-scoring
				// unreranked overflow instead of comparing uncalibrated score
				// domains.
				const boostedReranked = applyPreferenceEvidenceBoostAfterRerank(
					query,
					applyRecencyAccessBoostAfterRerank(rerankResult.partitions.reranked, {
						recencyBoost: rerankCfg.recencyBoost,
						accessBoost: rerankCfg.accessBoost,
					}),
				)
				const composedTimeline = orderTimelineAfterSourceEvidence(
					deduplicateSearchResults([
						...boostedReranked,
						...rerankResult.partitions.emptySnippet,
						...rerankResult.partitions.overflow,
						...rerankResult.partitions.below,
						...timelineResults,
					]),
				)
				const postRerankLaneControlled = applyLaneAwareResultControls({
					query,
					results: composedTimeline,
					// RET-08: the rerank input was deduplicated upstream and
					// timeline items are appended behind the partitions, so the
					// CE-scored partition is exactly the first
					// `boostedReranked.length` composed results.
					rerankPartitionCount: boostedReranked.length,
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
				// RET-13: per-lane outcome ledger — every attempted lane's
				// ok/failed/budget-denied/unavailable status (pathsExecuted
				// now lists attempts, this explains each one).
				laneOutcomes,
			},
		}
	} catch (err) {
		// C-002: raw query text never enters diagnostics — length + digest
		// preserve correlation without content (see query-diagnostics.ts).
		log.error("searchV2 failed", settledFailureMeta(err, query))
		throw err
	}
}
