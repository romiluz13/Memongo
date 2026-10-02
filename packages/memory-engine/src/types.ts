import type {
	ContextBundleModeValue,
	MemoryMongoDBFusionMethod,
	MemoryScope,
} from "@memongo/lib"
import type { ProcedureLifecyclePatch } from "./mongodb-procedures.js"
import type { SearchBudgetSnapshot } from "./mongodb-search-budget.js"
import type { StructuredMemoryLifecyclePatch } from "./mongodb-structured-memory.js"

export type MemorySource = "reference" | "conversation" | "structured"
export type LegacyMemorySource = "memory" | "sessions" | "kb" | "structured"
export type InternalMemoryStoredSource = LegacyMemorySource | "conversation"

export type MemorySearchTrustConfidence = "high" | "medium" | "low"
export type MemorySearchTrustFreshness =
	| "fresh"
	| "aging"
	| "stale"
	| "timeless"
	| "unknown"
export type MemorySearchTrustExactness =
	| "exact-id"
	| "exact-locator"
	| "approximate"
export type MemorySearchTrustContradiction =
	| "none"
	| "conflicted"
	| "invalidated"
export type MemorySearchTrustScopeMatch =
	| "exact"
	| "partial"
	| "unknown"
	| "mismatch"
export type MemorySearchTrustProvenance =
	| "dense"
	| "partial"
	| "sparse"
	| "none"

export type MemoryResultTrust = {
	score: number
	confidence: MemorySearchTrustConfidence
	exactness: MemorySearchTrustExactness
	freshness: MemorySearchTrustFreshness
	contradiction: MemorySearchTrustContradiction
	scopeMatch: MemorySearchTrustScopeMatch
	provenance: MemorySearchTrustProvenance
	sourceDiversity: "single" | "multi"
	factors: string[]
}

export type MemorySearchTrustSummary = {
	topScore: number | null
	topConfidence: MemorySearchTrustConfidence | null
	averageScore: number | null
	distribution: Record<MemorySearchTrustConfidence, number>
	contradictionCount: number
	staleCount: number
	exactCount: number
	sourceDiversity: "single" | "multi" | "none"
}

/**
 * Provenance derivation for a search result (RET-09): who authored the
 * underlying span, independent of retrieval score.
 *   - "user": user-authored span (role "user" turn, verbatim session text)
 *   - "user-extracted": normalized/paraphrased facts extracted FROM user
 *     turns (userfact evidence) — user-attributed but not verbatim
 *   - "agent": agent-generated text (assistant/tool/system turns)
 *   - "derived": summaries, procedures, structured records, or legacy rows
 *     with no provenance metadata (conservative default)
 *   - "inferred": graph relations and LLM-inferred facts
 *   - "reference": verbatim spans of ingested external documents (KB)
 */
export type MemoryResultDerivation =
	| "user"
	| "user-extracted"
	| "agent"
	| "derived"
	| "inferred"
	| "reference"

/**
 * Authoring role of the underlying event turn, when the source lane
 * preserves it (conversation chunks; raw-window events). Absent on lanes
 * with no turn-level authorship (KB, structured, procedures, graph).
 */
export type MemoryResultRole = "user" | "assistant" | "system" | "tool"

export type MemorySearchResult = {
	path: string
	filePath?: string
	startLine: number
	endLine: number
	score: number
	snippet: string
	/**
	 * Full passage text for the reranker and the reader (B5). `snippet`
	 * stays the short display preview; this carries the complete body so
	 * answers past the preview length remain reachable. Absent on lanes
	 * that only produce previews (fall back to `snippet`).
	 */
	text?: string
	source: MemorySource
	sourceType?: MemorySource
	citation?: string
	canonicalId?: string
	sessionId?: string
	timestamp?: Date
	/**
	 * Denormalized reinforcement counter maintained by the access tracker
	 * ($inc on the source document per retrieval). Surfaced here so the
	 * post-cross-encoder recency/access boost can modulate ranking; absent
	 * on lanes that do not project it (treated as neutral by the boost).
	 */
	accessCount?: number
	scope?: MemoryScope
	scopeRef?: string
	state?: string
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	sourceReliability?: number
	reinforcementCount?: number
	validFrom?: Date
	validTo?: Date
	/**
	 * Retention deadline of the source document (TTL-managed), when present.
	 */
	expiresAt?: Date
	factLineage?: string
	sourceRef?: string
	reviewAt?: Date
	lastConfirmedAt?: Date
	confidence?: number
	/** Authoring role of the source turn (conversation/raw-window lanes). */
	role?: MemoryResultRole
	/** Provenance derivation of the source span (see MemoryResultDerivation). */
	derivation?: MemoryResultDerivation
	trust?: MemoryResultTrust
	/**
	 * Task 35 observability: when the retrieval path was `$rankFusion`
	 * with `scoreDetails: true`, this carries the per-lane contribution
	 * breakdown (sum(weight * (1 / (60 + rank))) RRF). Optional because
	 * not every retrieval path produces it (e.g., standard find() has
	 * no notion of rank fusion).
	 */
	scoreDetails?: MemorySearchScoreDetails
}

/**
 * Task 35: rank-fusion per-pipeline contribution for observability.
 * Mirrors `ConversationRecallScoreDetails` but lives on the broader
 * search surface so the benchmark runner can emit per-case scoring
 * telemetry without importing conversation-recall types.
 */
export type MemorySearchScoreDetailEntry = {
	inputPipelineName: string
	rank: number
	weight: number
	value: number
}

export type MemorySearchScoreDetails = {
	value?: number
	description?: string
	details?: MemorySearchScoreDetailEntry[]
}

export type MemoryReadResult = {
	text: string
	path: string
	locator?: string
	source?: MemorySource
	sourceType?: MemorySource
	title?: string
	key?: string
	type?: string
	error?: string
	disabled?: boolean
}

export type MemoryLifecycleFamily = "structured" | "procedure"
export type MemoryLifecycleState = "active" | "invalidated" | "conflicted"
export type MemoryLifecycleHistoryKind = "revision" | "current"

type MemoryStableHandleBase = {
	family: MemoryLifecycleFamily
	id: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	revision: number
	state: MemoryLifecycleState
	validFrom?: Date
	validTo?: Date
	updatedAt?: Date
}

export type MemoryStructuredStableHandle = MemoryStableHandleBase & {
	family: "structured"
	structured: {
		type: string
		key: string
	}
}

export type MemoryProcedureStableHandle = MemoryStableHandleBase & {
	family: "procedure"
	procedure: {
		procedureId: string
	}
}

export type MemoryStableHandle =
	| MemoryStructuredStableHandle
	| MemoryProcedureStableHandle

export type MemoryLifecycleStructuredData = {
	type: string
	key: string
	value: string
	context?: string
	confidence?: number
	source?: string
	sessionId?: string
	tags?: string[]
	salience?: string
	temporalScope?: string
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	sourceReliability?: number
	reinforcementCount?: number
	reviewAt?: Date
	lastConfirmedAt?: Date
	sourceAgent?: MemorySourceAgent
	artifact?: MemoryArtifact
}

export type MemoryLifecycleProcedureData = {
	procedureId: string
	name: string
	intentTags?: string[]
	triggerQueries?: string[]
	steps: string[]
	successSignals?: string[]
	confidence?: number
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	/** Current operational metrics; they are not part of semantic revision history. */
	successCount?: number
	failCount?: number
	lastSuccessAt?: Date
	lastFailureAt?: Date
	sourceAgent?: MemorySourceAgent
}

export type MemoryLifecycleItem =
	| {
			family: "structured"
			handle: MemoryStructuredStableHandle
			data: MemoryLifecycleStructuredData
			createdAt?: Date
			updatedAt?: Date
	  }
	| {
			family: "procedure"
			handle: MemoryProcedureStableHandle
			data: MemoryLifecycleProcedureData
			createdAt?: Date
			updatedAt?: Date
	  }

export type MemoryLifecycleHistoryEntry = MemoryLifecycleItem & {
	historyKind: MemoryLifecycleHistoryKind
	supersededAt?: Date
}

export type MemoryActorRole = "user" | "assistant" | "system"
export type MemoryFeedbackSignal = "confirm" | "correct" | "irrelevant"

export type MemoryEmbeddingProbeResult = {
	ok: boolean
	error?: string
}

export type MemorySyncProgressUpdate = {
	completed: number
	total: number
	label?: string
}

export type MemoryProviderStatus = {
	backend: "mongodb"
	provider: string
	model?: string
	requestedProvider?: string
	files?: number
	chunks?: number
	dirty?: boolean
	workspaceDir?: string
	sources?: MemorySource[]
	sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>
	/** @deprecated Persisted search-result serving is disabled. */
	cache?: { enabled: boolean; entries?: number; maxEntries?: number }
	fts?: { enabled: boolean; available: boolean; error?: string }
	vector?: {
		enabled: boolean
		available?: boolean
		loadError?: string
		dims?: number
	}
	batch?: {
		enabled: boolean
		failures: number
		limit: number
		wait: boolean
		concurrency: number
		pollIntervalMs: number
		timeoutMs: number
		lastError?: string
		lastProvider?: string
	}
	custom?: Record<string, unknown>
}

export type MemorySearchMode = "auto" | "direct" | "agentic"
export type MemorySearchSourcePreference =
	| MemorySource
	| "procedural"
	| "episodic"
	| "graph"
export type MemorySearchClassification =
	| "direct"
	| "family"
	| "comparison"
	| "temporal"
	| "scoped"
	| "multi-hop"
export type EvidenceCoverage = "direct" | "partial" | "indirect" | "none"
export type MemorySearchTimeRangePreset =
	| "today"
	| "yesterday"
	| "last-24h"
	| "last-7d"
	| "this-week"
	| "last-30d"
	| "this-month"

export type MemorySearchTimeRange = {
	preset?: MemorySearchTimeRangePreset
	start?: string
	end?: string
}

export type SearchRecipe =
	| "fast"
	| "hybrid"
	| "deep"
	| "temporal"
	| "chain-of-thought"

export type SearchFusionMethod = "scoreFusion" | "rankFusion" | "js-merge"

export type SearchHybridMode = "hybrid" | "vector-only"

export type SearchLexicalPrefilterMode = "disabled" | "experimental"

export type SearchRecallProfile = "latency" | "balanced" | "proof"

export type SearchConfig = {
	recipe?: SearchRecipe
	recallProfile?: SearchRecallProfile
	maxResults?: number
	searchMode?: MemorySearchMode
	maxPasses?: number
	sourcePreference?: MemorySearchSourcePreference[]
	timeRange?: MemorySearchTimeRange
	needExactEvidence?: boolean
	/**
	 * RET-01: opt-in for the executor's constraint-relaxation fallback.
	 * Explicit caller constraints (timeRange, needExactEvidence) are hard by
	 * default — an empty constrained answer stays empty (with an honest
	 * noDirectEvidenceReason). Only when this flag is true may the executor
	 * re-run a pass with the dominant constraint removed, disclosed via
	 * metadata.constraintRelaxations.
	 */
	allowConstraintRelaxation?: boolean
	numCandidates?: number
	fusionMethod?: SearchFusionMethod
	hybridMode?: SearchHybridMode
	allowHybridBackstop?: boolean
	lexicalPrefilter?: SearchLexicalPrefilterMode
}

export type ResolvedSearchConfig = {
	recipe: SearchRecipe | "custom"
	recallProfile: SearchRecallProfile
	maxResults: number
	searchMode: MemorySearchMode
	maxPasses: number
	sourcePreference: MemorySearchSourcePreference[]
	timeRange?: MemorySearchTimeRange
	needExactEvidence: boolean
	allowConstraintRelaxation: boolean
	numCandidates: number
	fusionMethod: SearchFusionMethod
	hybridMode: SearchHybridMode
	allowHybridBackstop: boolean
	lexicalPrefilter: SearchLexicalPrefilterMode
}

export type MemoryConversationScope = {
	sessionKey?: string
}

export type MemoryStructuredScope = {
	type?: string
	state?: string | string[]
	salience?: string[]
}

export type MemoryReferenceScope = {
	source?: string
	category?: string
	tags?: string[]
}

export type MemoryProceduralScope = {
	state?: string
	intentTags?: string[]
}

export type MemorySearchRequest = {
	query: string
	scope?: MemoryScope
	scopeRef?: string
	/** Trusted boundary decision: exclude shared-KB retrieval for this request. */
	kbRestricted?: boolean
	maxResults?: number
	minScore?: number
	searchMode?: MemorySearchMode
	sourcePreference?: MemorySearchSourcePreference[]
	timeRange?: MemorySearchTimeRange
	needExactEvidence?: boolean
	/** RET-01: top-level mirror of searchConfig.allowConstraintRelaxation (explicit constraints stay hard unless opted in). */
	allowConstraintRelaxation?: boolean
	maxPasses?: number
	returnPlan?: boolean
	conversationScope?: MemoryConversationScope
	structuredScope?: MemoryStructuredScope
	referenceScope?: MemoryReferenceScope
	proceduralScope?: MemoryProceduralScope
	searchConfig?: SearchConfig
}

export type RejectedResultSummary = {
	canonicalId?: string
	path?: string
	source?: MemorySearchSourcePreference
	reason: string
}

export type MemorySearchPass = {
	pass: number
	query: string
	reason: string
	pathsExecuted: string[]
	resultCount: number
	queryRewritten: boolean
	reranked: boolean
	correctionApplied?: string
}

/**
 * RET-13: per-lane outcome for the metadata surface — one entry per
 * executed path, failed sub-lane/phase, budget-denied lane, or
 * capability-gated skip. Statuses distinguish what pathsExecuted (attempted
 * paths) and resultsByPath (contributing lanes) cannot: WHY a lane that ran
 * produced nothing. Shared by V2SearchMetadata (per pass) and
 * MemorySearchMetadata (executor-merged across passes).
 */
export type SearchLaneOutcome = {
	/** Seam label: path name, sub-lane (hybrid:chunks), or phase. */
	lane: string
	status: "ok" | "failed" | "budget-denied" | "unavailable"
	/** Number of results the lane contributed (ok lanes). */
	resultCount?: number
	/** Failure text (failed lanes). */
	error?: string
}

export type MemorySearchMetadata = {
	mode: MemorySearchMode
	classification: MemorySearchClassification
	sourceOrder: MemorySearchSourcePreference[]
	resolvedSearchConfig?: ResolvedSearchConfig
	passes: MemorySearchPass[]
	queriesTried: string[]
	constraintsApplied: string[]
	resultsRejected: RejectedResultSummary[]
	evidenceCoverage: EvidenceCoverage
	pathsExecuted: string[]
	resultsByPath: Record<string, number>
	queryRewritten: boolean
	reranked: boolean
	noDirectEvidenceReason?: string
	constraintRelaxations?: Array<{ constraint: string; action: string }>
	mmrApplied?: boolean
	mmrLambda?: number
	trustSummary?: MemorySearchTrustSummary
	plan?: {
		paths: string[]
		confidence: "high" | "medium" | "low"
		reasoning: string
	}
	/**
	 * WS-11 admission control: set when at least one pass was denied by the
	 * process-level search admission token bucket. A healthy empty search
	 * never carries it, so "overloaded" stays distinguishable from "no
	 * memories" at the detailed-search boundary, not only inside searchV2.
	 */
	throttled?: { retryAfterMs: number }
	/**
	 * RET-13: per-lane outcome ledger concatenated across passes by the
	 * executor merge — one entry per attempted path, failed sub-lane/phase,
	 * or budget-denied lane. Absent on cache-hit and legacy-fallback
	 * responses, which never run v2 lanes.
	 */
	laneOutcomes?: SearchLaneOutcome[]
	/**
	 * RET-16: the request-level search budget snapshot (aggregations/embeds
	 * consumed across ALL passes of this request, plus the limits). Set by
	 * searchDetailed's request-boundary wrapper; absent on admission-denied
	 * responses where no lanes ran.
	 */
	budget?: SearchBudgetSnapshot
}

/**
 * WS-12 (C-019): why a search response is degraded rather than authoritative.
 * Carried out of the array-returning search()/searchKB() surfaces via the
 * `onDegradation` sink (the onLaneLatency pattern) so the API boundary can
 * serve "throttled" as throttling instead of "no memories found".
 *
 * - "denied": admission control denied the whole query before any lane ran —
 *   the empty results are NOT a retrieval verdict.
 * - "legacy-fallback-skipped": the v2 empty verdict stands (it did search);
 *   only the opt-in legacy re-run was denied, so the answer is authoritative
 *   but the configured double-check did not happen.
 * - "vector-lane-skipped": the KB vector lane was dropped by denial; the
 *   text-lane results stand but ranking quality is degraded.
 */
export type MemorySearchDegradation = {
	kind: "throttled"
	scope: "denied" | "legacy-fallback-skipped" | "vector-lane-skipped"
	retryAfterMs: number
}

export type MemorySearchResponse = {
	results: MemorySearchResult[]
	metadata: MemorySearchMetadata
}

export type MemoryDiscoveryProjectionKind =
	| "entity-brief"
	| "topic-brief"
	| "what-changed"
	| "contradiction-report"

export type MemoryDiscoveryProjectionSource =
	| "graph"
	| "structured"
	| "procedural"
	| "episodic"
	| "conversation"

export type MemoryDiscoveryProjectionEvidence = {
	title: string
	summary: string
	path: string
	source: MemoryDiscoveryProjectionSource
	canonicalId?: string
	timestamp?: Date
	scope?: MemoryScope
	scopeRef?: string
	sourceEventIds?: string[]
}

export type MemoryDiscoveryProjectionSection = {
	title: string
	summary: string
	evidence: MemoryDiscoveryProjectionEvidence[]
}

export type MemoryDiscoveryProjectionMetadata = {
	partial: boolean
	evidenceCount: number
	sourceCounts: Record<string, number>
	timeRange?: {
		label: string
		start: Date
		end: Date
	}
}

export type MemoryDiscoveryProjection = {
	kind: MemoryDiscoveryProjectionKind
	query?: string
	title: string
	summary: string
	scope: MemoryScope
	scopeRef: string
	sections: MemoryDiscoveryProjectionSection[]
	metadata: MemoryDiscoveryProjectionMetadata
	builtAt: Date
}

export type MemoryDiscoveryProjectionRequest = {
	sessionId?: string
	kind: MemoryDiscoveryProjectionKind
	query?: string
	scope?: MemoryScope
	scopeRef?: string
	maxItems?: number
	timeRange?: MemorySearchTimeRange
}

export type MemoryActiveSlateKind =
	| "active-critical"
	| "procedure"
	| "decision"
	| "current-state"
	| "recent-anchor"

export type MemoryActiveSlateSource =
	| "structured"
	| "procedural"
	| "conversation"

export type MemoryActiveSlateItem = {
	kind: MemoryActiveSlateKind
	source: MemoryActiveSlateSource
	title: string
	summary: string
	path: string
	canonicalId?: string
	timestamp?: Date
	scope?: MemoryScope
	scopeRef?: string
	state?: string
	salience?: string
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
}

export type MemoryActiveSlateMetadata = {
	maxItems: number
	truncated: boolean
	partial: boolean
	countsByKind: Record<string, number>
	sourceCounts: Record<string, number>
}

export type MemoryActiveSlate = {
	agentId: string
	scope: MemoryScope
	scopeRef: string
	items: MemoryActiveSlateItem[]
	metadata: MemoryActiveSlateMetadata
	hydratedAt: Date
}

// ---------------------------------------------------------------------------
// Memory Blocks (Letta-inspired block-based core memory)
// ---------------------------------------------------------------------------

export type MemoryBlockLabel =
	| "persona"
	| "user-profile"
	| "current-work"
	| "active-risks"
	| "procedure-hints"
	| "recent-context"
	| "custom"

export type MemoryBlock = {
	label: MemoryBlockLabel
	tokenBudget: number
	items: MemoryActiveSlateItem[]
	actualTokens?: number
}

export type MemoryBlocks = {
	blocks: MemoryBlock[]
	totalTokenBudget: number
	totalActualTokens: number
}

export type MemoryContextBundleSectionKind =
	| "active-slate"
	| "query-evidence"
	| "summary"
	| "recent-events"
	| "discovery-projection"
	| "profile"

export type MemoryContextBundleSectionItem = {
	title: string
	summary: string
	path?: string
	source?: string
	canonicalId?: string
	timestamp?: Date
	scope?: MemoryScope
	scopeRef?: string
	sourceEventIds?: string[]
	trust?: MemoryResultTrust
	metadata?: Record<string, unknown>
}

export type MemoryContextBundleSection = {
	kind: MemoryContextBundleSectionKind
	title: string
	summary?: string
	items: MemoryContextBundleSectionItem[]
	estimatedTokens: number
	truncated: boolean
	partial: boolean
}

export type MemoryContextBundleMetadata = {
	tokenBudget: number
	estimatedTokensUsed: number
	partial: boolean
	truncated: boolean
	pathsExecuted: string[]
	trustSummary?: MemorySearchTrustSummary
	sectionsIncluded: MemoryContextBundleSectionKind[]
}

export type MemoryContextBundle = {
	agentId: string
	query?: string
	scope: MemoryScope
	scopeRef: string
	sessionId?: string
	rendered: string
	sections: MemoryContextBundleSection[]
	metadata: MemoryContextBundleMetadata
	builtAt: Date
}

/**
 * Context-bundle mode. Derived from the canonical contract enum
 * (CONTEXT_BUNDLE_MODE_VALUES in @memongo/lib, WS-08 / C-013) so the
 * engine cannot drift from the API/client/MCP/tools mode sets.
 */
export type MemoryContextBundleMode = ContextBundleModeValue

export type MemoryContextBundleRequest = {
	query?: string
	scope?: MemoryScope
	scopeRef?: string
	/** Trusted boundary decision: exclude shared-KB retrieval for this request. */
	kbRestricted?: boolean
	sessionId?: string
	tokenBudget?: number
	maxActiveItems?: number
	maxEvidenceItems?: number
	maxRecentEvents?: number
	includeDiscoveryProjection?: boolean
	discoveryKind?: MemoryDiscoveryProjectionKind
	includeProfile?: boolean
	timeRange?: MemorySearchTimeRange
	/** "wake-up" returns a compact 250-token projection for session start. Default: "full". */
	mode?: MemoryContextBundleMode
}

/**
 * The memory manager contract. Exactly one backend exists
 * (MongoDBMemoryManager), so every method is REQUIRED — optional members
 * here previously forced the bridge to compensate with 13 structural
 * `*CapableManager` casts (P2.2). Signatures mirror the concrete class.
 */
export interface MemorySearchManager {
	search(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
			kbRestricted?: boolean
		},
	): Promise<MemorySearchResult[]>
	searchDetailed(request: MemorySearchRequest): Promise<MemorySearchResponse>
	buildDiscoveryProjection(
		request: MemoryDiscoveryProjectionRequest,
	): Promise<MemoryDiscoveryProjection>
	hydrateActiveSlate(params?: {
		sessionId?: string
		scope?: MemoryScope
		scopeRef?: string
		maxItems?: number
	}): Promise<MemoryActiveSlate>
	buildContextBundle(
		request?: MemoryContextBundleRequest,
	): Promise<MemoryContextBundle>
	recallConversation(
		request: Omit<ConversationRecallRequest, "agentId">,
	): Promise<ConversationRecallResponse>
	extractEvent(params: {
		eventId: string
		scope?: MemoryScope
		scopeRef?: string
	}): Promise<{ jobId: string; scheduled: boolean }>
	listRecallTraces(params?: { limit?: number }): Promise<RecallTrace[]>
	getRecallTrace(params: { traceId: string }): Promise<RecallTrace | null>
	listMemoryJobs(params?: {
		status?: MemoryJobStatus
		limit?: number
		jobType?: MemoryJobType
	}): Promise<MemoryJob[]>
	getMemoryJob(params: { jobId: string }): Promise<MemoryJob | null>
	accessTrends(params?: {
		collection?: AccessEventCollection
		memoryIds?: string[]
		windowDays?: number
		limit?: number
	}): Promise<MemoryAccessTrend[]>
	accessSummaries(params: {
		collection: AccessEventCollection
		memoryIds: string[]
		windowDays?: number
	}): Promise<MemoryAccessSummary[]>
	importConversations(params: {
		datasetPath: string
		scope?: MemoryScope
		scopeRef?: string
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryConversationImportResult>
	/** Direct KB search on the MongoDB backend. */
	searchKB(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			scope?: MemoryScope
			sessionKey?: string
			scopeRef?: string
			filter?: { tags?: string[]; category?: string; source?: string }
			/** Per-call override; defaults to the resolved config fusionMethod. */
			fusionMethod?: MemoryMongoDBFusionMethod
		},
	): Promise<MemorySearchResult[]>
	readFile(params: {
		relPath: string
		from?: number
		lines?: number
	}): Promise<MemoryReadResult>
	status(): MemoryProviderStatus
	sync(params?: {
		reason?: string
		force?: boolean
		sessionFiles?: string[]
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void>
	probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>
	probeVectorAvailability(): Promise<boolean>
	getLifecycleItem(
		handle: MemoryStableHandle,
	): Promise<MemoryLifecycleItem | null>
	updateLifecycleItem(
		handle: MemoryStableHandle,
		patch: StructuredMemoryLifecyclePatch | ProcedureLifecyclePatch,
	): Promise<MemoryLifecycleItem | null>
	invalidateLifecycleItem(
		handle: MemoryStableHandle,
		invalidatedBy?: Record<string, unknown>,
	): Promise<MemoryLifecycleItem | null>
	getLifecycleHistory(params: {
		handle: MemoryStableHandle
		limit?: number
	}): Promise<MemoryLifecycleHistoryEntry[]>
	reportProcedureOutcome(params: {
		handle: Extract<MemoryStableHandle, { family: "procedure" }>
		success: boolean
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null>
	applyMemoryFeedback(params: {
		handle: Extract<MemoryStableHandle, { family: "structured" }>
		signal: MemoryFeedbackSignal
		patch?: StructuredMemoryLifecyclePatch
		invalidatedBy?: Record<string, unknown>
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null>
	selfEditBlock(params: {
		block: MemorySelfEditBlock
		action: MemorySelfEditAction
		content: string
	}): Promise<{
		upserted: boolean
		id: string
		/** C-008: true when the merged content was routed to memory_quarantine. */
		quarantined?: boolean
		matchedPatterns?: string[]
	}>
	traceChain(params: {
		factId: string
		collection: string
		options?: { maxDepth?: number }
	}): Promise<ReasoningChain>
	scanNovelty(params?: {
		limit?: number
		scope?: string
		scopeRef?: string
	}): Promise<NoveltyReport>
	consolidate(params?: {
		maxEvents?: number
		minCombinedScore?: number
		scope?: MemoryScope
		scopeRef?: string
	}): Promise<ConsolidationResult>
	close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Confidence Scoring (Phase 3.5)
// ---------------------------------------------------------------------------

/** Source attribution hierarchy for memory confidence. */
export type MemoryConfidenceSource =
	| "user_stated"
	| "agent_extracted"
	| "inferred"

/** Default confidence by source: user_stated=1.0, agent_extracted=0.7, inferred=0.4. */
export const CONFIDENCE_BY_SOURCE: Record<MemoryConfidenceSource, number> = {
	user_stated: 1.0,
	agent_extracted: 0.7,
	inferred: 0.4,
}

// ---------------------------------------------------------------------------
// Agent Attribution (Phase 3.9)
// ---------------------------------------------------------------------------

/** Tracks which agent created/modified a memory document. */
export type MemorySourceAgent = {
	/** The agentId that created this memory. */
	id: string
	/** Agent role: user, dreamer, extractor, deduction-specialist, induction-specialist. */
	name:
		| "user"
		| "dreamer"
		| "extractor"
		| "deduction-specialist"
		| "induction-specialist"
		| string
	/** Specific Dreamer run or extraction turn ID. */
	runId?: string
}

// ---------------------------------------------------------------------------
// Knowledge Artifacts (Phase 3.6)
// ---------------------------------------------------------------------------

/** Code/config stored as first-class memory in structured_mem. */
export type MemoryArtifact = {
	type: "solution" | "formula" | "command" | "config" | "snippet"
	title: string
	/** The actual code, config, or formula content. */
	content: string
}

// ---------------------------------------------------------------------------
// Self-Editing Memory (Phase 3.1)
// ---------------------------------------------------------------------------

export type MemorySelfEditBlock = "user" | "persona" | "instructions"

export type MemorySelfEditAction = "append" | "replace" | "prepend"

export type MemorySelfEditRequest = {
	block: MemorySelfEditBlock
	action: MemorySelfEditAction
	content: string
}

// ---------------------------------------------------------------------------
// Recall Traces (Phase 3.10)
// ---------------------------------------------------------------------------

export type RecallTrace = {
	traceId: string
	agentId: string
	/**
	 * RET-21: the query as the deployment's diagnostic privacy policy allows
	 * it to be stored — verbatim in "raw" mode, shape-preserving redacted
	 * text in "redacted-hash" mode, absent in "none" mode. Legacy traces
	 * written before the policy hold the raw query verbatim.
	 */
	query?: string
	/** sha256 of the normalized query; present whenever query text is stored. */
	queryHash?: string
	/** RET-21: scope retention fields — traces are tenant-sensitive rows. */
	scope?: MemoryScope
	scopeRef?: string
	timestamp: Date
	lanesUsed?: string[]
	lanesSkipped?: string[]
	totalHits?: number
	latencyMs?: number
	hitsByLane?: Record<string, number>
	/** #66: wall-clock ms per lane, hybrid sub-lane, and serial backstop. */
	latencyByLane?: Record<string, number>
	topHitIds?: string[]
	tokenBudgetUsed?: number
	bundleMode?: MemoryContextBundleMode
}

// ---------------------------------------------------------------------------
// Memory Jobs (Phase 3.11)
// ---------------------------------------------------------------------------

export type MemoryJobType =
	| "consolidation"
	| "extraction"
	| "import"
	| "materialization"
	| "enrichment"

export type MemoryJobStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"

export type MemoryExtractionJobPayload = {
	eventId: string
	scope?: MemoryScope
	scopeRef?: string
}

export type MemoryJob = {
	jobId: string
	jobType: MemoryJobType
	agentId: string
	status: MemoryJobStatus
	createdAt: Date
	startedAt?: Date
	completedAt?: Date
	error?: string
	inputCount?: number
	outputCount?: number
	durationMs?: number
	metadata?: Record<string, unknown>
	payload?: MemoryExtractionJobPayload
	attempts?: number
	/** Erasure admission epoch captured before this write entered the queue. */
	admissionEpoch?: number
	/** Earliest time a failed job may be claimed again. */
	retryAt?: Date
	/**
	 * Set when a job exhausts its attempt budget. A dead letter is terminal:
	 * the claim filter requires `attempts < MEMORY_JOB_MAX_ATTEMPTS`, so it is
	 * never reclaimed, and it deliberately carries no `completedAt` — the
	 * completed-TTL index must not erase it before an operator has seen it.
	 * Requeueing (`retryFailedMemoryJob`) clears the marker.
	 */
	deadLetterAt?: Date
	stagedAt?: Date
	leaseOwner?: string
	leaseToken?: string
	leaseExpiresAt?: Date
	heartbeatAt?: Date
	/**
	 * W05: set on rows that TRACK a live synchronous run (explicit
	 * consolidate) rather than queueing work. Nonclaimable by the worker's
	 * claim filter and excluded from the expired-lease dead-letter sweep;
	 * the synchronous runner owns the row's terminal transition. When a
	 * failed tracking row is claimed for retry, the claim clears this
	 * marker atomically: ownership moves to the worker, so a post-claim
	 * crash recovers via normal lease expiry.
	 */
	tracking?: boolean
}

export type ClaimedMemoryJob = MemoryJob & {
	status: "running"
	attempts: number
	leaseOwner: string
	leaseToken: string
	leaseExpiresAt: Date
	heartbeatAt: Date
}

// ---------------------------------------------------------------------------
// Benchmark Harness (Phase 4.2 scaffold)
// ---------------------------------------------------------------------------

export type MemoryBenchmarkTurn = {
	role: "user" | "assistant" | "system" | "tool"
	body: string
	timestamp?: string
	metadata?: Record<string, unknown>
}

export type MemoryBenchmarkConversation = {
	conversationId?: string
	sessionId?: string
	scope?: MemoryScope
	turns: MemoryBenchmarkTurn[]
}

export type MemoryBenchmarkDatasetKind = "generic" | "longmemeval" | "locomo"

export type MemoryBenchmarkEvaluationCase = {
	caseId: string
	query: string
	expectedSessionIds: string[]
	expectedTurnIds?: string[]
	officialRetrieval?: {
		evaluator: "longmemeval-main-run"
		eligible: boolean
		expectedSessionIds: string[]
		expectedTurnIds: string[]
		ineligibleReason?: "abstention" | "no-user-answer-target"
	}
	expectedDialogIds?: string[]
	answer?: string
	questionType?: string
	abstention?: boolean
	sourceScope?: "all" | "memory" | "kb" | "structured"
	expectedSources?: string[]
	minTopScore?: number
	metadata?: Record<string, unknown>
}

export type MemoryBenchmarkScenario = {
	scenarioId: string
	conversations: MemoryBenchmarkConversation[]
	evaluations: MemoryBenchmarkEvaluationCase[]
}

export type MemoryBenchmarkDataset = {
	name?: string
	datasetKind?: MemoryBenchmarkDatasetKind
	conversations: MemoryBenchmarkConversation[]
	evaluations?: MemoryBenchmarkEvaluationCase[]
	scenarios?: MemoryBenchmarkScenario[]
	failedLines?: number
}

export type MemoryBenchmarkIngestResult = {
	datasetPath: string
	datasetName?: string
	conversationsIngested: number
	turnsIngested: number
	skippedConversations: number
	failedLines: number
	failedTurns: number
	startedAt: Date
	completedAt: Date
}

export type MemoryConversationImportResult = {
	datasetPath: string
	datasetName?: string
	datasetKind?: "generic"
	conversationsImported: number
	turnsImported: number
	skippedConversations: number
	failedLines: number
	failedTurns: number
	startedAt: Date
	completedAt: Date
}

export type MemoryBenchmarkQuestionTypeMetrics = {
	questionType: string
	cases: number
	succeededCases: number
	failedCases: number
	retrievalEligibleCases: number
	scoredCases: number
	hitRate: number
	rAt5: number
	rAt10: number
	ndcgAt10: number
}

export type MemoryBenchmarkOfficialRetrievalMetrics = {
	recallAnyAt1: number
	recallAllAt1: number
	ndcgAnyAt1: number
	recallAnyAt3: number
	recallAllAt3: number
	ndcgAnyAt3: number
	recallAnyAt5: number
	recallAllAt5: number
	ndcgAnyAt5: number
	recallAnyAt10: number
	recallAllAt10: number
	ndcgAnyAt10: number
	recallAnyAt30: number
	recallAllAt30: number
	ndcgAnyAt30: number
	recallAnyAt50: number
	recallAllAt50: number
	ndcgAnyAt50: number
}

export type MemoryBenchmarkEvaluatorIdentity = {
	suite: "longmemeval"
	sourceRepository: "xiaowu0162/LongMemEval"
	sourceCommit: string
	evaluatorPath: "src/retrieval/eval_utils.py"
	evaluatorBlob: string
	aggregationEntrypoint: "src/retrieval/run_retrieval.py"
	cutoffs: readonly number[]
	eligibilityPolicy: "exclude-abstention-and-no-user-answer-target"
	candidateProjection:
		| "one-session-document-one-label"
		| "native-source-attribution-flattened"
		// Retained for reports produced before the native lane became canonical;
		// no current code path emits it.
		| "native-memory-source-session-adapter"
	comparability: "canonical" | "adapted"
}

/**
 * Slice B: summary of an official LongMemEval QA protocol run. Mirrors the
 * `official` block of the e2e QA envelope produced by the official scoring
 * pipeline (separate judge provider, dated answer prompts, anscheck verdicts).
 */
export type MemoryBenchmarkOfficialQaSummary = {
	protocol: "official-anscheck"
	coverage: "full" | "partial" | "unavailable"
	overallAccuracy: number | null
	taskAveragedAccuracy: number | null
	/**
	 * B8-3/B9-1: question ids the run recorded as unreliable (provider
	 * failure, budget truncation, or a response with no extractable
	 * answer). Terminal but excluded from judged coverage; named so an
	 * unmeasured case is never just an anonymous missing id. Absent when
	 * the summary predates the unreliable stage.
	 */
	unreliableQuestionIds?: string[]
	/**
	 * Slice B round 2: abstention-only accuracy over the judged abstention
	 * rows. Null when not measured (partial coverage or no abstention rows);
	 * never a fabricated zero.
	 */
	abstentionAccuracy: number | null
	/** Judged abstention row count; 0 when none were judged. */
	abstentionCount: number
	perType: Array<{
		questionType: string
		accuracy: number | null
		count: number
	}>
	missingQuestionIds: string[]
	lostPreCheckpointQuestionIds: string[]
	accountingCompleteness: "complete" | "incomplete"
	export?: {
		kind: "sample" | "full"
		path: string
		rows: number
	}
}

/**
 * Custom-judge (non-official) QA protocol summary: the same reviewed
 * machinery and metric shape as the official summary, but judged by a
 * separately configured non-official judge model (for example
 * gpt-5.6-luna). `judgeModel` records the actual judging model; the
 * `custom-judge-anscheck` protocol label keeps non-official provenance
 * visible wherever the summary is published.
 */
export type MemoryBenchmarkCustomJudgeQaSummary = {
	protocol: "custom-judge-anscheck"
	judgeModel: string
	coverage: "full" | "partial" | "unavailable"
	overallAccuracy: number | null
	taskAveragedAccuracy: number | null
	/**
	 * B8-3/B9-1: question ids the run recorded as unreliable (see
	 * MemoryBenchmarkOfficialQaSummary.unreliableQuestionIds).
	 */
	unreliableQuestionIds?: string[]
	abstentionAccuracy: number | null
	abstentionCount: number
	perType: Array<{
		questionType: string
		accuracy: number | null
		count: number
	}>
	missingQuestionIds: string[]
	lostPreCheckpointQuestionIds: string[]
	accountingCompleteness: "complete" | "incomplete"
	export?: {
		kind: "sample" | "full"
		path: string
		rows: number
	}
}

export type MemoryBenchmarkOfficialMetrics = {
	longMemEval?: {
		evaluator: MemoryBenchmarkEvaluatorIdentity
		totalCases: number
		eligibleCases: number
		retrievalCases: number
		abstentionCases: number
		ineligibleCases: number
		projectionFailureCases: number
		executionFailureCases: number
		session?: MemoryBenchmarkOfficialRetrievalMetrics
		turn?: MemoryBenchmarkOfficialRetrievalMetrics
		/**
		 * C-039: LLM-judged answer accuracy over pass-0 retrieval results, so
		 * published LongMemEval numbers carry the answer half of the official
		 * protocol (J score) next to the retrieval half. Null fields mean
		 * "not measured"; `unavailableReason` says why.
		 */
		answerQuality?: {
			answerModel: string | null
			judge: string | null
			judgeVersion: string | null
			accuracy: number | null
			judgeFalsePositiveRate: number | null
			eligibleCases: number
			completedCases: number
			unavailableReason?: string
			/**
			 * Slice B: per-run official QA protocol summary (separate judge
			 * provider, dated answer prompts, anscheck-verified hypotheses).
			 * Absent means the run did not use the official QA protocol.
			 * Nested canonical location (typed projection of
			 * `BenchmarkE2eQaEnvelope.official`); there is deliberately no
			 * sibling `officialQa` field.
			 */
			official?: MemoryBenchmarkOfficialQaSummary
			/**
			 * Custom-judge integration: per-run non-official judge summary
			 * (typed projection of `BenchmarkE2eQaEnvelope.customJudge`).
			 * Present only for custom-judge protocol runs, which never carry
			 * an `official` block.
			 */
			customJudge?: MemoryBenchmarkCustomJudgeQaSummary
		}
	}
	loCoMo?: {
		retrievalCases: number
		abstentionCases: number
		sessionEvidenceRecallAt5: number
		sessionEvidenceRecallAt10: number
		dialogEvidenceRecallAt5?: number
		dialogEvidenceRecallAt10?: number
	}
}

export type QueryGovernanceCandidate = {
	candidateId: string
	source: "benchmark" | "operator-trace"
	queryShapeFamily: "search-detailed"
	recipe?: SearchRecipe
	scope: "cluster"
	reason: string
	evidence: {
		datasetName?: string
		datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
		cases: number
		hitRate: number
		p95LatencyMs: number
		rAt5?: number
		ndcgAt10?: number
	}
	recommendedAction: "inspect-query-stats" | "consider-setQuerySettings"
	rollbackNote: string
}

export type QueryGovernanceReport = {
	status: "advisory-only"
	generatedAt: Date
	candidates: QueryGovernanceCandidate[]
	notes: string[]
}

export type MemoryBenchmarkBuildIdentity = {
	source: "env" | "unknown"
	commitSha?: string
	buildId?: string
	buildLabel?: string
}

export type MemoryBenchmarkReleaseGate = {
	gate:
		| "official-retrieval"
		| "internal-retrieval"
		| "execution-completeness"
		| "quality-thresholds"
		| "e2e-answer-quality"
		| "evidence-completeness"
		| "conversation-recall-regression"
		| "query-governance"
	status: "passed" | "failed" | "warning" | "not-run" | "advisory-only"
	evidence: string
	checks?: Array<{
		metric: string
		actual: number | null
		operator: ">=" | "<=" | "="
		threshold: number
		passed: boolean
	}>
}

export type MemoryBenchmarkExecutionSummary = {
	attemptedCases: number
	succeededCases: number
	failedCases: number
	retrievalEligibleCases: number
	abstentionCases: number
	missingJudgmentCases: number
	retrievalHits: number
	retrievalMisses: number
	scoredCases: number
}

export type MemoryBenchmarkCaseOutcome = {
	caseId?: string
	questionType?: string
	executionStatus: "succeeded" | "system-failure"
	scoreEligibility: "retrieval" | "abstention" | "missing-judgment"
	retrievalOutcome: "hit" | "miss" | "not-applicable"
	officialMetric?:
		| { status: "scored" }
		| {
				status: "ineligible" | "projection-failure" | "execution-failure"
				reason: string
		  }
	empty: boolean
	latencyMs: number
	/**
	 * B2: per-case session-level recallAny at the loop's decision depths, so
	 * a single result artifact carries the R side of the per-question join
	 * (the full depth ladder stays on the checkpoint executions).
	 */
	recallAnyAt10?: number
	recallAnyAt50?: number
	/** #66: wall-clock ms per lane, hybrid sub-lane, and serial backstop. */
	latencyByLane?: Record<string, number>
	failure?: { stage: "retrieval"; message: string }
}

/** #66: lane -> p95 latency over the cases where that lane actually ran. */
export type MemoryBenchmarkLaneLatencySummary = Record<
	string,
	{ p95Ms: number; cases: number }
>

/**
 * #66: one measurement pass over an already-ingested scenario corpus. Passes
 * repeat only the evaluation loop, so N passes cost N eval loops and one
 * ingest — which is what makes n>1 affordable.
 */
export type MemoryBenchmarkMeasurementPassSample = {
	/** 1-based pass index. */
	pass: number
	cases: number
	scoredCases: number
	hitRate: number
	p95LatencyMs: number
	rAt5: number
	rAt10: number
	ndcgAt10: number
	officialMetrics?: MemoryBenchmarkOfficialMetrics
	laneLatencyP95?: MemoryBenchmarkLaneLatencySummary
}

export type MemoryBenchmarkMeasurementPasses = {
	passes: number
	/**
	 * 1-based pass whose metrics are the published result and feed the release
	 * gates. Always pass 1, so gate semantics are identical to a single-pass run.
	 */
	gatePass: number
	samples: MemoryBenchmarkMeasurementPassSample[]
	/** Across-pass noise band of p95. `stddev` is the population stddev. */
	p95LatencyMs: { median: number; min: number; max: number; stddev: number }
}

type BenchmarkCommonQualityThresholds = {
	contractId: string
	version: string
	minHitRate: number
	maxEmptyRate: number
	minRAt5: number
	minNdcgAt10: number
	maxP95LatencyMs: number
}

export type BenchmarkQualityThresholds =
	| (BenchmarkCommonQualityThresholds & {
			datasetKind: "longmemeval"
			minSessionRecallAnyAt10: number
			minSessionNdcgAnyAt10: number
			/**
			 * C-039: answer-quality clauses are optional so the retrieval-only V1
			 * contract stays valid. When declared (V2 and later), the
			 * e2e-answer-quality release gate activates for LongMemEval runs.
			 */
			minAnswerAccuracy?: number
			maxJudgeFalsePositiveRate?: number
			minAnswerCoverage?: number
	  })
	| (BenchmarkCommonQualityThresholds & {
			datasetKind: "locomo"
			minSessionEvidenceRecallAt10: number
			minDialogEvidenceRecallAt10?: number
			minAnswerAccuracy: number
			maxJudgeFalsePositiveRate: number
			minAnswerCoverage: number
	  })

/**
 * Envelope parity fields (Task 1.A).
 *
 * Gate 3 / Gate 4 / Gate 5 artifacts all share a single envelope superset so
 * comparative claims against MemPalace carry dataset SHA, retrieval unit,
 * embedding model, reranker identity, storage footprint, latency, and cost
 * counters in every published run. `e2eQa.*` is a Gate-5 extension populated
 * by Task 5.E2E and Task 5.adv; at Phase 1 these fields may be null.
 */

export type BenchmarkRetrievalUnit = "turn" | "session" | "memory" | "qa-pair"

export type BenchmarkEmbeddingQuantization = "float32" | "int8" | "binary"

export type BenchmarkRerankerStage = "post-fusion" | "pre-fusion" | "none"

export type BenchmarkRunIdentity = {
	runId: string
	/** SHA-256 of dataset file bytes (64-hex-char). */
	datasetSha256: string
	retrievalUnit: BenchmarkRetrievalUnit
	configurationHash: string
	executionProfile: "shipped" | "diagnostic"
	retrievalLane: "native" | "raw-session"
	maxResults: number
	minScore: number
	settings: Record<string, string | number | boolean | null>
}

export type BenchmarkEmbeddingConfig = {
	model: string
	dimensions: number
	quantization: BenchmarkEmbeddingQuantization
}

export type BenchmarkRerankerConfig = {
	model: string
	version: string | null
	stage: BenchmarkRerankerStage
}

export type BenchmarkTenantStorageMeasurement = {
	documents: number | null
	logicalBytes: number | null
	collections: Array<{
		collectionName: string
		documents: number
		logicalBytes: number
	}>
	unavailableReason?: string
}

export type BenchmarkStorageFootprint = {
	basis: "benchmark-agent-logical-plus-shared-physical"
	tenant: BenchmarkTenantStorageMeasurement
	sharedPhysical: {
		collections: Array<{
			collectionName: string
			collectionBytes: number | null
			indexBytes: number | null
			unavailableReason?: string
		}>
		unavailableReason?: string
	}
}

export type BenchmarkLatencyDistribution = {
	p50Ms: number
	p95Ms: number
}

export type BenchmarkOperationName =
	| "embedding"
	| "rerank"
	| "enrichment"
	| "query-decomposition"
	| "answer-generation"
	| "answer-judge"
	| "decoy-judge"
	| "structured-extraction"
	| "temporal-extraction"
	| "contradiction-detection"
	| "relation-extraction"
	| "vector-query"

export type BenchmarkOperationAccounting = {
	operation: BenchmarkOperationName
	observability: "measured" | "unknown" | "not-run"
	attempted: number | null
	succeeded: number | null
	failed: number | null
	provider?: string
	model?: string
	unavailableReason?: string
	/**
	 * C-017: provider token usage accumulated across recorded successes,
	 * present once at least one transport response carried a usage block.
	 * Null when the provider does not report usage (the accounting then
	 * degrades to call counts).
	 */
	inputTokens?: number | null
	outputTokens?: number | null
	/**
	 * C-017: reasoning tokens accumulated across recorded successes,
	 * present once at least one transport response reported them
	 * (OpenAI-compatible completion_tokens_details.reasoning_tokens).
	 * Absent when the gateway does not report reasoning spend.
	 */
	reasoningTokens?: number | null
}

export type BenchmarkCostAccounting = {
	currency: null
	totalCost: null
	unavailableReason: string
	operations: BenchmarkOperationAccounting[]
}

/** Gate-5 extension. Populated by Task 5.E2E / Task 5.adv; null at Phase 1. */
export type BenchmarkE2eQaEnvelope = {
	answerModel: string | null
	judge: string | null
	judgeVersion: string | null
	accuracy: number | null
	latencyMs: number | null
	judgeFalsePositiveRate: number | null
	cases: {
		eligible: number
		attempted: number
		completed: number
		failed: number
	}
	attempts: {
		answerGeneration: number
		answerJudge: number
		decoyJudge: number
	}
	caseResults: Array<{
		caseId: string
		candidateAnswer: string
		correct: boolean
		abstention: boolean
		latencyMs: number
		error?: string
	}>
	unavailableReason?: string
	/**
	 * Slice B: official QA protocol summary (separate judge provider, dated
	 * answer prompts, anscheck-verified hypotheses). Absent means the run
	 * used the legacy custom-v1 harness or measured no QA. Canonical home of
	 * the official summary; `officialMetrics.longMemEval.answerQuality.official`
	 * is the typed projection of this field.
	 */
	official?: MemoryBenchmarkOfficialQaSummary
	/**
	 * Custom-judge integration: non-official judge summary (same reviewed
	 * machinery, separately configured judge model such as gpt-5.6-luna).
	 * Present only for custom-judge protocol runs, which never carry an
	 * `official` block; `answerQuality.customJudge` is the typed projection.
	 */
	customJudge?: MemoryBenchmarkCustomJudgeQaSummary
}

export type MemoryBenchmarkRunReport = {
	generatedAt: Date
	build: MemoryBenchmarkBuildIdentity
	corpus: {
		datasetVersion: string
		datasetName?: string
		datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
		scenarios?: number
		cases: number
		scoredCases?: number
		skippedCases?: number
		execution?: MemoryBenchmarkExecutionSummary
		caseOutcomes?: MemoryBenchmarkCaseOutcome[]
	}
	metrics: {
		internal: {
			hitRate: number
			emptyRate: number
			avgTopScore: number
			p95LatencyMs: number
			rAt5?: number
			rAt10?: number
			ndcgAt10?: number
		}
		official?: MemoryBenchmarkOfficialMetrics
	}
	releaseGates: MemoryBenchmarkReleaseGate[]
	publicationDecision: {
		publishable: boolean
		failedGates: MemoryBenchmarkReleaseGate["gate"][]
		blockingGates: MemoryBenchmarkReleaseGate["gate"][]
	}
	qualityThresholds?: BenchmarkQualityThresholds
	warnings: string[]
	degradations: string[]
	/** Task 1.A parity envelope (optional at Phase 1; blocks Gate 3 exit when missing). */
	runIdentity?: BenchmarkRunIdentity
	embedding?: BenchmarkEmbeddingConfig
	reranker?: BenchmarkRerankerConfig
	storage?: BenchmarkStorageFootprint
	latency?: BenchmarkLatencyDistribution
	cost?: BenchmarkCostAccounting
	e2eQa?: BenchmarkE2eQaEnvelope
}

// ---------------------------------------------------------------------------
// Conversation Recall (Wave 1)
// ---------------------------------------------------------------------------

export type ConversationRecallRole = "user" | "assistant" | "system" | "tool"

export type ConversationRecallRequest = {
	agentId: string
	/**
	 * Tenant-isolation coordinates. When present, recall is filtered to events
	 * carrying the same scope/scopeRef so a scope-restricted caller cannot read
	 * another tenant's conversation events under the same agent. Absent = the
	 * caller is unscoped (full access) and recall spans all scopes.
	 */
	scope?: string
	scopeRef?: string
	query?: string
	sessionId?: string
	roles?: ConversationRecallRole[]
	startTime?: string
	endTime?: string
	timezone?: string
	includeToolMessages?: boolean
	limit?: number
	asOf?: Date
}

export type ConversationRecallCitation = {
	eventId: string
	sessionId?: string
	role: ConversationRecallRole
	timestamp: Date
	sourceRef?: string
	preview: string
}

/**
 * Task 2.R1: rank-fusion per-pipeline contribution emitted by MongoDB 8.1+
 * `$rankFusion` with `scoreDetails: true`. Each entry is one sub-pipeline;
 * `value = weight * (1 / (60 + rank))` per RRF formula.
 */
export type ConversationRecallScoreDetailEntry = {
	inputPipelineName: string
	rank: number
	weight: number
	value: number
}

export type ConversationRecallScoreDetails = {
	value?: number
	description?: string
	details?: ConversationRecallScoreDetailEntry[]
}

export type ConversationRecallResult = {
	citation: ConversationRecallCitation
	score?: number
	matchType: "filter" | "semantic" | "hybrid"
	scoreDetails?: ConversationRecallScoreDetails
}

export type ConversationRecallResponse = {
	results: ConversationRecallResult[]
	metadata: {
		totalMatched: number
		/** Delivered query after trimming and the 2,000 UTF-16 code-unit ceiling. */
		queryUsed?: string
		filtersApplied: string[]
		searchMethod: "standard" | "semantic" | "hybrid"
		durationMs: number
		/**
		 * WS-11 admission control: present when the process-level search
		 * admission bucket denied this call and the recall degraded to the
		 * text-only standard lane. Distinguishes "overloaded" from "no
		 * matching conversation events".
		 */
		throttled?: { retryAfterMs: number }
	}
}

// ---------------------------------------------------------------------------
// Reasoning Chain
// ---------------------------------------------------------------------------

export type ReasoningChainNode = {
	type: "event" | "fact" | "gap"
	id: string
	collection: string
	body?: string
	role?: string
	timestamp?: Date
	depth: number
	reason?: string
}

export type ReasoningChain = {
	factId: string
	collection: string
	nodes: ReasoningChainNode[]
	chainComplete: boolean
	maxDepthReached: boolean
	agentId: string
}

export type ReasoningChainOptions = {
	maxDepth?: number
}

// ---------------------------------------------------------------------------
// Novelty Detection
// ---------------------------------------------------------------------------

export type NoveltyEvent = {
	eventId: string
	body: string
	noveltyScore: number
	timestamp: Date
	role: string
	nearestNeighborDistance: number
}

export type NoveltyReport = {
	events: NoveltyEvent[]
	scannedCount: number
	error?: string
	agentId: string
}

export type NoveltyOptions = {
	limit?: number
	kNeighbors?: number
	scope?: string
	scopeRef?: string
	timeRange?: {
		start: Date
		end: Date
	}
}

// ---------------------------------------------------------------------------
// Access Tracker
// ---------------------------------------------------------------------------

export type AccessEventCollection =
	| "events"
	| "structured_mem"
	| "procedures"
	| "episodes"
	| "entities"
	| "relations"

export type AccessEventMeta = {
	agentId: string
	collection: AccessEventCollection
}

export type AccessEventDocument = {
	ts: Date
	meta: AccessEventMeta
	/**
	 * Top-level field (not inside `meta`) to avoid high-cardinality
	 * `memoryId` defeating time-series bucket compaction. See L6.
	 */
	memoryId: string
	count: number
	/**
	 * W01: identity beyond the short id so a raw access record carries the
	 * complete handle of the accessed row. Top-level like `memoryId` —
	 * `scopeRef` is high-cardinality and must stay out of `meta` (see L6).
	 */
	scope?: string
	scopeRef?: string
	type?: string
	/**
	 * W11: durable logical batch id of the flush that produced this raw
	 * event. The flush read-reconciles on it before inserting, so an
	 * in-process retry of a failed flush never inserts the same batch's raw
	 * evidence twice. Unique indexes are prohibited on time-series
	 * collections, so read-reconcile is the available exactly-once shape for
	 * the raw layer. Top-level like `memoryId` (indexed measurement field).
	 */
	batchId: string
}

/**
 * W01: full identity of one accessed memory row. The canonical access update
 * targets the collection's unique compound index, so every member of that
 * index the tracker cannot derive itself (its own agentId, the primary id)
 * must travel with the access record. Under-specified identities never
 * produce a canonical update — the tracker skips them rather than guess.
 */
export type AccessRecordTarget = {
	collection: AccessEventCollection
	/**
	 * Per-collection primary id: eventId (events), key (structured_mem),
	 * procedureId (procedures), episodeId (episodes), entityId (entities),
	 * or the relation locator `from:type:to` (relations).
	 */
	id: string
	/** Owning scope; required for scope-bearing unique identities. */
	scope?: string
	/** Owning scope reference; required for scope-bearing unique identities. */
	scopeRef?: string
	/** structured_mem type lane, or the relation type. */
	type?: string
	/** relations: source entity of the edge. */
	fromEntityId?: string
	/** relations: target entity of the edge. */
	toEntityId?: string
}

export type MemoryAccessSummary = {
	memoryId: string
	collection: AccessEventCollection
	accessCount: number
	lastAccessedAt?: Date
}

export type MemoryAccessTrend = {
	memoryId: string
	collection: AccessEventCollection
	day: Date
	count: number
	rolling7dCount: number
	lastAccessedAt?: Date
}

export type AccessTrackerConfig = {
	/** Flush after this many buffered accesses. Default 10. */
	flushThreshold?: number
	/** Flush every N ms. Default 60 000. */
	flushIntervalMs?: number
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export type ConsolidationCandidate = {
	eventId: string
	body: string
	timestamp: Date
	noveltyScore: number
	importanceDecay: number
	accessCount: number
	/**
	 * Raw (undecayed) importance used for write eligibility. Write gating must
	 * not depend on creation age; `importanceDecay` is diagnostic only.
	 */
	importance?: number
	combinedScore: number
	/**
	 * Source-event scope. Scope-isolation safety threads scope/scopeRef from
	 * the originating event through the candidate so cross-scope merges become
	 * impossible by construction, rather than relying on the caller's
	 * `ConsolidationOptions.scope`.
	 */
	scope?: MemoryScope
	scopeRef?: string
}

export type ConsolidationOptions = {
	maxEvents?: number
	minCombinedScore?: number
	minIntervalMs?: number
	noveltyWeight?: number
	importanceWeight?: number
	accessWeight?: number
	scope?: MemoryScope
	/** Filter to specific namespace within scope */
	scopeRef?: string
	/** Bounded time window for scoped enrichment */
	timeRange?: { from: Date; to: Date }
	/** Filter events mentioning these entities (post-query regex filter) */
	entitySet?: string[]
	/**
	 * Phase-0 gate lease duration. A run that crashes leaves the gate
	 * "running"; the next claim may proceed once this lease has expired.
	 * Renewed every third of this duration during asynchronous work when it
	 * is finite and at least 3000ms. Shorter or non-finite durations do not
	 * start a heartbeat; expired leases still reject writes.
	 */
	leaseMs?: number
	/**
	 * P4.4.2 — contradiction wiring inside the consolidation loop. When a
	 * promotion candidate conflicts with an existing structured memory entry,
	 * resolve instead of skip: detect contradictions, invalidate the losing
	 * side, then re-evaluate the candidate. Requires an enrichment LLM; with
	 * none configured the historical skip is preserved either way.
	 * Default true.
	 */
	resolveContradictions?: boolean
	/**
	 * P4.4.3 — LLM-adjudicated dedup. Optional phase between the NOOP gate
	 * (similarity 0.85) and prune: fact pairs in the similarity band
	 * [0.75, 0.92] get a 1-by-1 LLM merge verdict; on MERGE the kept fact
	 * gets the synthesized union text and the union of sourceEventIds as the
	 * proof-count analog. Requires an enrichment LLM. Default false.
	 */
	llmDedup?: boolean
}

export type ConsolidationResult = {
	runId: string
	agentId: string
	eventsProcessed: number
	factsPromoted: number
	factsPruned: number
	conflictsResolved: number
	durationMs: number
	candidates: ConsolidationCandidate[]
	orientStats?: DreamerOrientStats
	prunedCount?: number
	/** New facts derived by the LLM deduction/induction phases (issue #31). */
	factsInferred?: number
	/** Fact pairs merged by the LLM-adjudicated dedup phase (P4.4.3). */
	factsMerged?: number
}

// ---------------------------------------------------------------------------
// Dreamer Decision Types (Phase 2 — Extract + Decide)
// ---------------------------------------------------------------------------

export type DreamerAction = "ADD" | "UPDATE" | "DELETE" | "NOOP"

export type DreamerDecision = {
	action: DreamerAction
	targetId?: number
	content?: string
	category?: string
	importance?: number
	reason: string
}

// ---------------------------------------------------------------------------
// Dreamer Orient Stats (Phase 1)
// ---------------------------------------------------------------------------

export type DreamerOrientStats = {
	unprocessedCount: number
	byRole: Array<{ role: string; count: number }>
	topScopes: Array<{ scope: string; lastActivity: Date }>
}

// ---------------------------------------------------------------------------
// Dreamer Deduction Output (Phase 3 — stub)
// ---------------------------------------------------------------------------

export type DeductionOutput = {
	deductions: Array<{
		body: string
		sourceIds: number[]
		confidence: number
	}>
	contradictions: Array<{ contradictedId: number; reason: string }>
}

// ---------------------------------------------------------------------------
// Dreamer Induction Output (Phase 4 — stub)
// ---------------------------------------------------------------------------

export type InductionOutput = {
	patterns: Array<{
		body: string
		patternType:
			| "preference"
			| "behavior"
			| "skill"
			| "relationship"
			| "goal"
			| "habit"
		confidence: "low" | "medium" | "high"
		sourceIds: number[]
	}>
}
