import type { MemoryScope } from "@memongo/lib"

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

export type SearchConfig = {
	recipe?: SearchRecipe
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

export interface MemorySearchManager {
	search(
		query: string,
		opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
	): Promise<MemorySearchResult[]>
	searchDetailed?(request: MemorySearchRequest): Promise<MemorySearchResponse>
	buildDiscoveryProjection?(
		request: MemoryDiscoveryProjectionRequest,
	): Promise<MemoryDiscoveryProjection>
	hydrateActiveSlate?(params?: {
		scope?: MemoryScope
		scopeRef?: string
		maxItems?: number
	}): Promise<MemoryActiveSlate>
	buildContextBundle?(
		request?: MemoryContextBundleRequest,
	): Promise<MemoryContextBundle>
	recallConversation?(
		request: Omit<ConversationRecallRequest, "agentId">,
	): Promise<ConversationRecallResponse>
	extractEvent?(params: {
		eventId: string
	}): Promise<{ jobId: string; scheduled: boolean }>
	listRecallTraces?(params?: { limit?: number }): Promise<RecallTrace[]>
	getRecallTrace?(params: { traceId: string }): Promise<RecallTrace | null>
	listMemoryJobs?(params?: {
		status?: MemoryJobStatus
		limit?: number
		jobType?: MemoryJobType
	}): Promise<MemoryJob[]>
	getMemoryJob?(params: { jobId: string }): Promise<MemoryJob | null>
	accessTrends?(params?: {
		collection?: AccessEventCollection
		memoryIds?: string[]
		windowDays?: number
		limit?: number
	}): Promise<MemoryAccessTrend[]>
	accessSummaries?(params: {
		collection: AccessEventCollection
		memoryIds: string[]
		windowDays?: number
	}): Promise<MemoryAccessSummary[]>
	benchmarkIngest?(params: {
		datasetPath: string
		scope?: MemoryScope
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryBenchmarkIngestResult>
	importConversations?(params: {
		datasetPath: string
		scope?: MemoryScope
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryConversationImportResult>
	/** Direct KB search — optional, only available on MongoDB backend. */
	searchKB?(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			filter?: { tags?: string[]; category?: string; source?: string }
		},
	): Promise<MemorySearchResult[]>
	readFile(params: {
		relPath: string
		from?: number
		lines?: number
	}): Promise<MemoryReadResult>
	status(): MemoryProviderStatus
	sync?(params?: {
		reason?: string
		force?: boolean
		sessionFiles?: string[]
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void>
	probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>
	probeVectorAvailability(): Promise<boolean>
	close?(): Promise<void>
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

export type MemoryBenchmarkOfficialMetrics = {
	longMemEval?: {
		retrievalCases: number
		abstentionCases: number
		session: MemoryBenchmarkOfficialRetrievalMetrics
		turn?: MemoryBenchmarkOfficialRetrievalMetrics
	}
	loCoMo?: {
		qaCases: number
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
		| "conversation-recall-regression"
		| "query-governance"
	status: "passed" | "warning" | "not-run" | "advisory-only"
	evidence: string
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
	warnings: string[]
	degradations: string[]
}

// ---------------------------------------------------------------------------
// Conversation Recall (Wave 1)
// ---------------------------------------------------------------------------

export type ConversationRecallRole = "user" | "assistant" | "system" | "tool"

export type ConversationRecallRequest = {
	agentId: string
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

export type ConversationRecallResult = {
	citation: ConversationRecallCitation
	score?: number
	matchType: "filter" | "semantic" | "hybrid"
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
	memoryId: string
}

export type AccessEventDocument = {
	ts: Date
	meta: AccessEventMeta
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
	combinedScore: number
}

export type ConsolidationOptions = {
	maxEvents?: number
	minCombinedScore?: number
	minIntervalMs?: number
	noveltyWeight?: number
	importanceWeight?: number
	accessWeight?: number
	scope?: string
	/** Filter to specific namespace within scope */
	scopeRef?: string
	/** Bounded time window for scoped enrichment */
	timeRange?: { from: Date; to: Date }
	/** Filter events mentioning these entities (post-query regex filter) */
	entitySet?: string[]
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
