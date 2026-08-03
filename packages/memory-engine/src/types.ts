import type { MemoryMongoDBFusionMethod, MemoryScope } from "@memongo/lib"
import type { ProcedureLifecyclePatch } from "./mongodb-procedures.js"
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

export type MemorySearchResult = {
	path: string
	filePath?: string
	startLine: number
	endLine: number
	score: number
	snippet: string
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
	factLineage?: string
	sourceRef?: string
	reviewAt?: Date
	lastConfirmedAt?: Date
	confidence?: number
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
	maxResults?: number
	minScore?: number
	searchMode?: MemorySearchMode
	sourcePreference?: MemorySearchSourcePreference[]
	timeRange?: MemorySearchTimeRange
	needExactEvidence?: boolean
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

export type MemoryContextBundleMode = "full" | "wake-up"

export type MemoryContextBundleRequest = {
	query?: string
	scope?: MemoryScope
	scopeRef?: string
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
		},
	): Promise<MemorySearchResult[]>
	searchDetailed(request: MemorySearchRequest): Promise<MemorySearchResponse>
	buildDiscoveryProjection(
		request: MemoryDiscoveryProjectionRequest,
	): Promise<MemoryDiscoveryProjection>
	hydrateActiveSlate(params?: {
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
	benchmarkIngest(params: {
		datasetPath: string
		scope?: MemoryScope
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryBenchmarkIngestResult>
	importConversations(params: {
		datasetPath: string
		scope?: MemoryScope
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryConversationImportResult>
	/** Direct KB search on the MongoDB backend. */
	searchKB(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
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
	}): Promise<{ upserted: boolean; id: string }>
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
	query: string
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
	/** Earliest time a failed job may be claimed again. */
	retryAt?: Date
	stagedAt?: Date
	leaseOwner?: string
	leaseToken?: string
	leaseExpiresAt?: Date
	heartbeatAt?: Date
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
	datasetKind?: MemoryBenchmarkDatasetKind
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
		queryUsed?: string
		filtersApplied: string[]
		searchMethod: "standard" | "semantic" | "hybrid"
		durationMs: number
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
	 * Must exceed the worst-case run duration or the run's own completion
	 * is fenced off as stale.
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
