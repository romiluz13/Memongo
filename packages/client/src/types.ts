/**
 * Request shapes for the Memongo HTTP API.
 * Runtime implementation lives in @memongo/memory-bridge.
 */

export type MemongoContainerTag = string

/** Tenant-isolation scope understood by the API. */
export type MemongoScope =
	| "session"
	| "user"
	| "agent"
	| "workspace"
	| "tenant"
	| "global"

export type MemongoAddInput = {
	content: string
	/** @deprecated Prefer `sessionId`. */
	containerTag?: MemongoContainerTag
	entityContext?: string
	customId?: string
	metadata?: Record<string, string | number | boolean | null>
	agentId?: string
	sessionId?: string
	scope?: MemongoScope
	scopeRef?: string
	/** Absolute expiry instant (ISO 8601, must be future); P4.4.1 TTL. */
	expiresAt?: string
}

export type MemongoSearchInput = {
	query: string
	/** @deprecated Prefer `sessionKey`. */
	containerTag?: MemongoContainerTag
	limit?: number
	agentId?: string
	minScore?: number
	sessionKey?: string
	scope?: MemongoScope
	scopeRef?: string
}

export type SearchConfig = {
	recipe?: "fast" | "hybrid" | "deep" | "temporal" | "chain-of-thought"
	recallProfile?: "latency" | "balanced" | "proof"
	maxResults?: number
	searchMode?: "auto" | "direct" | "agentic"
	maxPasses?: number
	sourcePreference?: Array<
		| "reference"
		| "conversation"
		| "structured"
		| "procedural"
		| "episodic"
		| "graph"
	>
	timeRange?: { preset?: string; start?: string; end?: string }
	needExactEvidence?: boolean
	numCandidates?: number
	fusionMethod?: "scoreFusion" | "rankFusion" | "js-merge"
	hybridMode?: "hybrid" | "vector-only"
	allowHybridBackstop?: boolean
	lexicalPrefilter?: "disabled" | "experimental"
}

export type MemongoConversationRecallInput = {
	query?: string
	sessionId?: string
	roles?: Array<"user" | "assistant" | "system" | "tool">
	startTime?: string
	endTime?: string
	asOf?: string
	timezone?: string
	includeToolMessages?: boolean
	limit?: number
	agentId?: string
	scope?: MemongoScope
	scopeRef?: string
}

export type MemongoConversationImportInput = {
	datasetPath: string
	scope?: MemongoScope
	scopeRef?: string
	limitConversations?: number
	limitTurnsPerConversation?: number
	agentId?: string
}

export type MemongoSourceAgent = {
	id: string
	name: string
	runId?: string
}

export type MemongoActorRole = "user" | "assistant" | "system"
export type MemongoMemoryFeedbackSignal = "confirm" | "correct" | "irrelevant"

export type MemongoLifecycleFamily = "structured" | "procedure"
export type MemongoLifecycleState = "active" | "invalidated" | "conflicted"
export type MemongoLifecycleHistoryKind = "revision" | "current"

type MemongoStableHandleBase = {
	family: MemongoLifecycleFamily
	id: string
	agentId: string
	scope: MemongoScope
	scopeRef: string
	revision: number
	state: MemongoLifecycleState
	validFrom?: string
	validTo?: string
	updatedAt?: string
}

export type MemongoStructuredStableHandle = MemongoStableHandleBase & {
	family: "structured"
	structured: {
		type: string
		key: string
	}
}

export type MemongoProcedureStableHandle = MemongoStableHandleBase & {
	family: "procedure"
	procedure: {
		procedureId: string
	}
}

export type MemongoStableHandle =
	| MemongoStructuredStableHandle
	| MemongoProcedureStableHandle

export type MemongoLifecycleStructuredData = {
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
	reviewAt?: string
	lastConfirmedAt?: string
	sourceAgent?: MemongoSourceAgent
	artifact?: Record<string, unknown>
}

export type MemongoLifecycleProcedureData = {
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
	lastSuccessAt?: string
	lastFailureAt?: string
	sourceAgent?: MemongoSourceAgent
}

export type MemongoLifecycleItem =
	| {
			family: "structured"
			handle: MemongoStructuredStableHandle
			data: MemongoLifecycleStructuredData
			createdAt?: string
			updatedAt?: string
	  }
	| {
			family: "procedure"
			handle: MemongoProcedureStableHandle
			data: MemongoLifecycleProcedureData
			createdAt?: string
			updatedAt?: string
	  }

export type MemongoLifecycleHistoryEntry = MemongoLifecycleItem & {
	historyKind: MemongoLifecycleHistoryKind
	supersededAt?: string
}

export type MemongoStructuredLifecyclePatch = Partial<
	Pick<
		MemongoLifecycleStructuredData,
		| "value"
		| "context"
		| "confidence"
		| "source"
		| "sessionId"
		| "tags"
		| "salience"
		| "temporalScope"
		| "provenance"
		| "sourceEventIds"
		| "sourceReliability"
		| "reviewAt"
		| "lastConfirmedAt"
		| "sourceAgent"
		| "artifact"
	> & { validTo: string }
>

export type MemongoProcedureLifecyclePatch = Partial<
	Pick<
		MemongoLifecycleProcedureData,
		| "name"
		| "intentTags"
		| "triggerQueries"
		| "steps"
		| "successSignals"
		| "confidence"
		| "provenance"
		| "sourceEventIds"
		| "sourceAgent"
	>
>

export type MemongoLifecycleGetInput = {
	handle: MemongoStableHandle
}

export type MemongoLifecycleUpdateInput =
	| {
			handle: MemongoStructuredStableHandle
			patch: MemongoStructuredLifecyclePatch
	  }
	| {
			handle: MemongoProcedureStableHandle
			patch: MemongoProcedureLifecyclePatch
	  }

export type MemongoLifecycleDeleteInput = {
	handle: MemongoStableHandle
	invalidatedBy?: Record<string, unknown>
}

export type MemongoLifecycleHistoryInput = {
	handle: MemongoStableHandle
	limit?: number
}

export type MemongoProcedureOutcomeInput = {
	handle: MemongoProcedureStableHandle
	success: boolean
	note?: string
	actorRole?: MemongoActorRole
}

export type MemongoMemoryFeedbackInput =
	| {
			handle: MemongoStructuredStableHandle
			signal: "confirm"
			note?: string
			actorRole?: MemongoActorRole
	  }
	| {
			handle: MemongoStructuredStableHandle
			signal: "correct"
			patch: MemongoStructuredLifecyclePatch
			note?: string
			actorRole?: MemongoActorRole
	  }
	| {
			handle: MemongoStructuredStableHandle
			signal: "irrelevant"
			note?: string
			actorRole?: MemongoActorRole
			invalidatedBy?: Record<string, unknown>
	  }

export type MemongoProfileInput = {
	/** @deprecated Prefer `scopeRef`. */
	containerTag?: MemongoContainerTag
	agentId?: string
	scope?: MemongoScope
	scopeRef?: string
	maxEntities?: number
	maxEpisodes?: number
}

export type MemongoActiveSlateInput = {
	agentId?: string
	scope?: MemongoScope
	scopeRef?: string
	maxItems?: number
}

export type MemongoDiscoveryProjectionInput = {
	agentId?: string
	kind: "entity-brief" | "topic-brief" | "what-changed" | "contradiction-report"
	query?: string
	scope?: MemongoScope
	scopeRef?: string
	maxItems?: number
	timeRange?: { preset?: string; start?: string; end?: string }
}

export type MemongoTraceChainInput = {
	factId: string
	collection: string
	agentId?: string
	maxDepth?: number
}

export type MemongoScanNoveltyInput = {
	agentId?: string
	limit?: number
	scope?: MemongoScope
	scopeRef?: string
}

export type MemongoConsolidateInput = {
	agentId?: string
	maxEvents?: number
	minCombinedScore?: number
	resolveContradictions?: boolean
	llmDedup?: boolean
	scope?: MemongoScope
	scopeRef?: string
}

export type MemongoSelfEditInput = {
	block: "user" | "persona" | "instructions"
	action: "append" | "replace" | "prepend"
	content: string
	agentId?: string
}

export type MemongoSelfEditResponse = {
	upserted: boolean
	id: string
	/** C-008: true when the merged content was routed to memory_quarantine (202). */
	quarantined?: boolean
	matchedPatterns?: string[]
}

/**
 * C-008: quarantine disposition carried on 202 responses. Lifecycle update
 * and memory feedback hold a write for injection review instead of applying
 * it; the server answers 202 with these fields instead of the updated item.
 * All fields are optional so non-quarantined 200 payloads (the normal
 * `MemongoLifecycleItem`) type-check unchanged.
 */
export type MemongoQuarantineDisposition = {
	/** True when the write was held in memory_quarantine for review. */
	quarantined?: boolean
	/** Quarantine row id, present when quarantined. */
	quarantineId?: string
	/** INJECTION_PATTERNS ids that matched, present when quarantined. */
	matchedPatterns?: string[]
}

export type MemongoExtractInput = {
	eventId: string
	agentId?: string
	scope?: MemongoScope
	scopeRef?: string
}

export type MemongoExtractResponse = {
	ok: true
	jobId: string
	scheduled: boolean
}

/**
 * P3.9 per-item receipt from /v1/write-events, mirroring the single-write
 * receipt shape. A failed item carries a stable code
 * (VALIDATION_ERROR | IDEMPOTENCY_CONFLICT | WRITE_ERROR) and never fails
 * its siblings.
 */
export type MemongoWriteEventReceipt =
	| { ok: true; eventId: string; chunkCreated: boolean; replayed?: boolean }
	| { ok: false; code: string; message: string }

export type MemongoWriteEventsResponse = {
	ok: true
	receipts: MemongoWriteEventReceipt[]
}

// ---------------------------------------------------------------------------
// Response types for typed client methods (JSON wire format — dates as strings)
// ---------------------------------------------------------------------------

export type MemongoReadFileResponse = {
	text: string
	path: string
	locator?: string
	source?: string
	sourceType?: string
	title?: string
	key?: string
	type?: string
	error?: string
	disabled?: boolean
}

export type MemongoStatusResponse = {
	/** Memongo release version of the responding server. */
	version?: string
	backend: "mongodb"
	provider: string
	model?: string
	requestedProvider?: string
	files?: number
	chunks?: number
	dirty?: boolean
	workspaceDir?: string
	sources?: string[]
	sourceCounts?: Array<{ source: string; files: number; chunks: number }>
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

export type MemongoConversationRecallCitation = {
	eventId: string
	sessionId?: string
	role: "user" | "assistant" | "system" | "tool"
	timestamp: string
	sourceRef?: string
	preview: string
}

export type MemongoConversationRecallResult = {
	citation: MemongoConversationRecallCitation
	score?: number
	matchType: "filter" | "semantic" | "hybrid"
}

export type MemongoConversationRecallResponse = {
	results: MemongoConversationRecallResult[]
	metadata: {
		totalMatched: number
		queryUsed?: string
		filtersApplied: string[]
		searchMethod: "standard" | "semantic" | "hybrid"
		durationMs: number
	}
}

export type MemongoDetailedStatusResponse = {
	events: { count: number; latestTimestamp?: string }
	entities: { count: number }
	relations: { count: number }
	episodes: { count: number; latestTimestamp?: string }
	procedures: { count: number; latestTimestamp?: string }
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
		{ hasData: boolean; count: number; lastUpdated: string | null }
	>
	health: {
		overall: "ok" | "degraded" | "health-uncertain"
		retrieval: "ok" | "retrieval-degraded" | "health-uncertain"
		recentNoRelevantResults: boolean
		canonicalIngest: "ok" | "canonical-ingest-failed" | "health-uncertain"
		/** Whether every query used to assemble the status response succeeded. */
		dataCompleteness?: "complete" | "partial"
		/** Query labels whose values were replaced with safe fallbacks. */
		failedChecks?: string[]
		derivedProducts: Record<
			string,
			| "ok"
			| "projection-behind"
			| "derived-product-unavailable"
			| "health-uncertain"
		>
		diagnostics: string[]
	}
}

export type MemongoStatsResponse = {
	sources: Array<{
		source: string
		fileCount: number
		chunkCount: number
		lastSync: string | null
	}>
	totalFiles: number
	totalChunks: number
	embeddingCoverage: {
		withEmbedding: number
		withoutEmbedding: number
		unknown: number
		total: number
		coveragePercent: number | null
		basis: "stored-vector" | "search-index"
	}
	embeddingStatusCoverage: {
		total: number
		success: number
		failed: number
		pending: number
		unknown: number
		basis: "stored-vector" | "search-index"
	}
	staleFiles: string[]
	collectionSizes: { files: number; chunks: number }
	indexStats: Array<{
		collection: string
		name: string
		accesses: number
		since: string | null
	}>
}

export type MemongoProbeEmbeddingResponse = {
	ok: boolean
	error?: string
}

export type MemongoProfileResponse = {
	agentId: string
	scope: string
	scopeRef: string
	preferences: Array<{
		key: string
		value: string
		salience: string
		updatedAt: string
	}>
	decisions: Array<{
		key: string
		value: string
		salience: string
		updatedAt: string
	}>
	facts: Array<{
		key: string
		value: string
		salience: string
		updatedAt: string
	}>
	todos: Array<{
		key: string
		value: string
		salience: string
		updatedAt: string
	}>
	topEntities: Array<{ name: string; type: string; relationCount: number }>
	recentEpisodes: Array<{
		title: string
		summary: string
		type: string
		timeRange: { start: string; end: string }
	}>
	activityPatterns: {
		roleDistribution: Record<string, number>
		totalEvents: number
		lastActive: string | null
	}
	synthesizedAt: string
}

export type MemongoRelevanceExplainResponse = {
	runId?: string
	latencyMs: number
	sourceScope: string
	health: "ok" | "degraded" | "insufficient-data"
	fallbackPath?: string
	sampleRate: number
	artifacts: Array<{
		artifactType: string
		summary: Record<string, unknown>
		rawExplain?: unknown
		compression?: "none"
	}>
	results: Array<Record<string, unknown>>
}

export type MemongoRelevanceReportResponse = {
	health: "ok" | "degraded" | "insufficient-data"
	runs: number
	sampledRuns: number
	emptyRate: number
	avgTopScore: number
	fallbackRate: number
	lastRegressionAt?: string
	profileCapabilities: {
		textExplain: boolean
		vectorExplain: boolean
		fusionExplain: boolean
	}
}

export type MemongoRelevanceSampleRateResponse = {
	enabled: boolean
	current: number
	base: number
	max: number
	windowSize: number
	degradedSignals: number
}

export type MemongoConversationImportResponse = {
	datasetPath: string
	datasetName?: string
	datasetKind?: "generic"
	conversationsImported: number
	turnsImported: number
	skippedConversations: number
	failedLines: number
	failedTurns: number
	startedAt: string
	completedAt: string
}

export type MemongoEraseAgentResponse = {
	agentId: string
	status: "complete" | "partial"
	receipts: Array<{
		collection: string
		deleted: number
		error?: string
	}>
	mutationId?: string
	/** Set when the proof-of-erasure audit write failed (status is "partial"). */
	auditError?: string
	completedAt: string
}

// ---------------------------------------------------------------------------
// C-004 quarantine review (JSON wire format — dates as strings)
// ---------------------------------------------------------------------------

export type MemongoQuarantineStatus = "pending-review" | "promoted" | "rejected"

/** One memory_quarantine row as surfaced to a reviewer. */
export type MemongoQuarantinedMemory = {
	quarantineId: string
	agentId: string
	scope?: string
	scopeRef?: string
	content: string
	classification: string
	tier?: "pattern" | "llm"
	matchedPatterns: string[]
	status: MemongoQuarantineStatus
	createdAt: string
	reviewedAt?: string
	reviewerId?: string
	reviewNotes?: string
	sourceEventIds?: string[]
}

/** Receipt for a promote/reject decision. */
export type MemongoQuarantineReviewReceipt = {
	quarantineId: string
	agentId: string
	status: "promoted" | "rejected"
	reviewedAt: string
	reviewerId?: string
	reviewNotes?: string
	/** structured_mem document id; promote only. */
	memoryId?: string
	/** Audit record id in memory_mutations; absent when the audit write failed. */
	mutationId?: string
	/** Audit write failed; the decision is durable on the row but unaudited. */
	auditError?: string
}

export type MemongoAccessTrendResponse = Array<{
	collection: string
	memoryId: string
	day: string
	count: number
	rolling7dCount: number
	lastAccessedAt?: string
}>

export type MemongoAccessSummaryResponse = Array<{
	collection: string
	memoryId: string
	accessCount: number
	lastAccessedAt?: string
}>

export type MemongoTraceChainResponse = {
	factId: string
	collection: string
	nodes: Array<{
		type: "event" | "fact" | "gap"
		id: string
		collection: string
		body?: string
		role?: string
		timestamp?: string
		depth: number
		reason?: string
	}>
	chainComplete: boolean
	maxDepthReached: boolean
	agentId: string
}

export type MemongoNoveltyResponse = {
	events: Array<{
		eventId: string
		body: string
		noveltyScore: number
		timestamp: string
		role: string
		nearestNeighborDistance: number
	}>
	scannedCount: number
	error?: string
	agentId: string
}

export type MemongoConsolidateResponse = {
	runId: string
	agentId: string
	eventsProcessed: number
	factsPromoted: number
	factsPruned: number
	conflictsResolved: number
	durationMs: number
	candidates: Array<{
		eventId: string
		body: string
		timestamp: string
		noveltyScore: number
		importanceDecay: number
		accessCount: number
		combinedScore: number
	}>
	orientStats?: {
		unprocessedCount: number
		byRole: Array<{ role: string; count: number }>
		topScopes: Array<{ scope: string; lastActivity: string }>
	}
	prunedCount?: number
}

export type MemongoRecallTrace = {
	traceId: string
	agentId: string
	query: string
	timestamp: string
	lanesUsed?: string[]
	lanesSkipped?: string[]
	totalHits?: number
	latencyMs?: number
	hitsByLane?: Record<string, number>
	topHitIds?: string[]
	tokenBudgetUsed?: number
	bundleMode?: "full" | "wake-up"
}

export type MemongoMemoryJobStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"

export type MemongoMemoryJobType =
	| "consolidation"
	| "extraction"
	| "import"
	| "materialization"
	| "enrichment"

export type MemongoMemoryJob = {
	jobId: string
	jobType: MemongoMemoryJobType
	agentId: string
	status: MemongoMemoryJobStatus
	createdAt: string
	startedAt?: string
	completedAt?: string
	error?: string
	inputCount?: number
	outputCount?: number
	durationMs?: number
	metadata?: Record<string, unknown>
}

export type MemongoSearchKBResponse = {
	results: Array<{
		path: string
		startLine: number
		endLine: number
		score: number
		snippet: string
		source: string
		canonicalId?: string
		timestamp?: string
		scope?: string
		scopeRef?: string
	}>
}

export type MemongoSearchResponse = {
	results: Array<{
		path: string
		startLine: number
		endLine: number
		score: number
		snippet: string
		source: string
		canonicalId?: string
		sessionId?: string
		timestamp?: string
		scope?: string
		scopeRef?: string
	}>
}

export type MemongoContextBundleInput = {
	agentId?: string
	query?: string
	scope?: MemongoScope
	scopeRef?: string
	sessionId?: string
	tokenBudget?: number
	maxActiveItems?: number
	maxEvidenceItems?: number
	maxRecentEvents?: number
	includeDiscoveryProjection?: boolean
	discoveryKind?:
		| "entity-brief"
		| "topic-brief"
		| "what-changed"
		| "contradiction-report"
	includeProfile?: boolean
	timeRange?: { preset?: string; start?: string; end?: string }
	/** "wake-up" returns a compact 250-token projection for session start. Default: "full". */
	mode?: "full" | "wake-up"
}
