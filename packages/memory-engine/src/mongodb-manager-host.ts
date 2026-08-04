/**
 * P4.3 god-file split — internal host contract.
 *
 * The `MongoDBMemoryManager` facade keeps every piece of instance state as a
 * private field (tests build doubles with `Object.create` + `Object.assign`,
 * so the fields must stay directly on the instance). Extracted collaborator
 * classes receive the facade through this structural interface — a cast
 * bridges the private fields — and read/write state at call time, never
 * cached, so test doubles keep working unchanged. Every method the facade
 * delegates is declared here so collaborators can bounce cross-seam calls
 * through the manager instance (preserving own-property test mocks).
 *
 * Type-only module: erased at runtime, no public barrel surface.
 */
import type {
	ResolvedMemoryBackendConfig,
	ResolvedMongoDBConfig,
} from "./backend-config.js"
import type { OperationRunContext } from "./mongodb-operation-accounting.js"
import { isDuplicateKeyError } from "./internal.js"
import type { AccessTracker } from "./mongodb-access-tracker.js"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import type { MemoryStats } from "./mongodb-analytics.js"
import type { MongoDBChangeStreamWatcher } from "./mongodb-change-stream.js"
import type { consolidateMemory } from "./mongodb-consolidator.js"
import { buildContextBundle } from "./mongodb-context-bundle.js"
import { recallConversation } from "./mongodb-conversation-recall.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import type { SearchMethod } from "./mongodb-hybrid.js"
import { searchKB } from "./mongodb-kb-search.js"
import type { V2Status } from "./mongodb-manager-admin.js"
import type { ManagerReadResult } from "./mongodb-manager-read.js"
import type {
	WriteConversationEventInput,
	WriteConversationEventReceipt,
} from "./mongodb-manager-write.js"
import type { MongoDBMemoryManager } from "./mongodb-manager.js"
import type { getMemoryJob, listMemoryJobs } from "./mongodb-memory-jobs.js"
import type { scanNovelty } from "./mongodb-novelty.js"
import { writeProcedure } from "./mongodb-procedures.js"
import type {
	ProcedureEntry,
	ProcedureLifecyclePatch,
} from "./mongodb-procedures.js"
import { synthesizeProfile } from "./mongodb-profile.js"
import type { ProfileSynthesis } from "./mongodb-profile.js"
import type { QueryCacheInvalidationCoalescer } from "./mongodb-query-cache-invalidation.js"
import type { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import type {
	getRecallTrace,
	listRecallTraces,
} from "./mongodb-recall-traces.js"
import type { MongoDBRelevanceRuntime } from "./mongodb-relevance.js"
import type {
	RelevanceReport,
	RelevanceSampleState,
	RelevanceSourceScope,
} from "./mongodb-relevance.js"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import type {
	ActiveSources,
	RelevanceExplainResult,
} from "./mongodb-search-ranking.js"
import type { SearchTraceEvent } from "./mongodb-search.js"
import { selfEditBlock } from "./mongodb-self-edit.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import type {
	StructuredMemoryEntry,
	StructuredMemoryLifecyclePatch,
} from "./mongodb-structured-memory.js"
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
	MemoryConversationImportResult,
	MemoryFeedbackSignal,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	MemoryStableHandle,
	MemoryProviderStatus,
	MemorySearchRequest,
	MemorySearchResponse,
	MemorySearchResult,
	MemorySelfEditBlock,
	MemorySelfEditAction,
	MemorySyncProgressUpdate,
	MemoryActorRole,
	ClaimedMemoryJob,
	MemoryJobType,
	MemoryJobStatus,
} from "./types.js"
import type { MemoryMongoDBFusionMethod, MemoryScope } from "@memongo/lib"
import type { FSWatcher } from "chokidar"
import type { MongoClient } from "mongodb"
import type { Db, Document } from "mongodb"

export interface MongoDBManagerHost {
	readonly client: MongoClient
	readonly db: Db
	readonly prefix: string
	readonly agentId: string
	readonly workspaceDir: string
	readonly agentScopeRef: string
	readonly workspaceScopeRef: string
	readonly extraMemoryPaths: string[]
	readonly capabilities: DetectedCapabilities
	nativeBitemporalVectorPrefilter: boolean
	nativeBitemporalPrefilterCheckedAt: number
	readonly config: ResolvedMemoryBackendConfig
	syncing: Promise<void> | null
	watcher: FSWatcher | null
	watchTimer: NodeJS.Timeout | null
	changeStreamWatcher: MongoDBChangeStreamWatcher | null
	gapReSyncInFlight: boolean
	relevance: MongoDBRelevanceRuntime | null
	readonly ownsClient: boolean
	closed: boolean
	dirty: boolean
	fileCount: number
	chunkCount: number
	writeQueue: Promise<void>
	derivationSchedulingQueue: Promise<void>
	derivationQueue: Promise<void>
	readonly memoryJobWorkerId: string
	memoryJobWorkerStopped: boolean
	memoryJobWorkerActive: boolean
	memoryJobWakeRequested: boolean
	memoryJobWorkerPromise: Promise<void>
	memoryJobWorkerTimer: NodeJS.Timeout | null
	memoryJobOperationContexts: Map<string, OperationRunContext>
	lastSearchMode: string
	lastSearchDetails: Record<string, unknown> | undefined
	accessTracker: AccessTracker | null
	queryCacheInvalidationCoalescer?: QueryCacheInvalidationCoalescer

	// ---- Facade delegates (P4.3) ----
	resolveSearchIdentity(opts?: {
		scope?: MemoryScope
		scopeRef?: string
		sessionKey?: string
	}): { scope: MemoryScope; scopeRef: string }
	buildConversationChunkFilter(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document
	buildBridgeChunkFilter(): Document
	buildBridgeChunkFilterForIdentity(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document | undefined
	buildScopeAwareBridgeChunkFilter(
		activeSources: ActiveSources,
		params: { scope: MemoryScope; scopeRef: string },
	): Document | undefined
	getBridgeChunkBudget(maxResults: number): number
	buildV2AvailablePaths(activeSources: ActiveSources): Set<RetrievalPath>
	recordSearchAccess(results: MemorySearchResult[]): void
	setLastSearchMode(mode: string, details?: Record<string, unknown>): void
	legacySearch(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
		},
	): Promise<MemorySearchResult[]>
	search(
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
		operationRunContext?: OperationRunContext,
	): Promise<MemorySearchResult[]>
	executeSearchUncoalesced(params: {
		cleaned: string
		opts?: Parameters<MongoDBMemoryManager["search"]>[1]
		mongoCfg: ResolvedMongoDBConfig
		maxResults: number
		minScore: number
		activeSources: ActiveSources
		availablePaths: Set<RetrievalPath>
		searchScope: MemoryScope
		searchScopeRef: string
		operationRunContext?: OperationRunContext
	}): Promise<MemorySearchResult[]>
	searchDetailed(request: MemorySearchRequest): Promise<MemorySearchResponse>
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
	detectSearchMethod(mongoCfg: ResolvedMongoDBConfig): SearchMethod
	resolveObservedSearchMethod(
		traceEvents: SearchTraceEvent[],
		mongoCfg: ResolvedMongoDBConfig,
	): SearchMethod
	relevanceExplain(params: {
		query: string
		sourceScope?: RelevanceSourceScope
		sessionKey?: string
		maxResults?: number
		minScore?: number
		deep?: boolean
		questionDate?: Date
	}): Promise<RelevanceExplainResult>
	relevanceReport(params?: { windowMs?: number }): Promise<RelevanceReport>
	relevanceSampleRate(): RelevanceSampleState
	importConversations(params: {
		datasetPath: string
		scope?: MemoryScope
		scopeRef?: string
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryConversationImportResult>
	sync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void>
	repairEventProjections(): Promise<{
		eventsProcessed: number
		chunksCreated: number
	}>
	repairExtractionOutbox(params?: { limit?: number }): Promise<{
		eventsProcessed: number
		jobsCreated: number
		jobsReleased: number
		eventsFailed: number
	}>
	runSync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void>
	loadPersistedChangeStreamResumeToken(): Promise<unknown>
	persistChangeStreamResumeToken(token: unknown): Promise<void>
	clearPersistedChangeStreamResumeToken(): Promise<void>
	maybeAutoRefreshKB(): Promise<void>
	ensureWatcher(): void
	scheduleWatchSync(): void
	enqueueDerivedWork(task: () => Promise<void>): void
	enqueueDerivationScheduling(task: () => Promise<void>): void
	shouldRunPostWriteDerivedWork(): boolean
	isDuplicateKeyError(err: unknown): boolean
	runClaimedBackgroundExtractionJob(
		job: ClaimedMemoryJob,
		prefetchedLlmFacts?: string[],
	): Promise<void>
	drainMemoryJobQueue(): Promise<void>
	prefetchExtractionSessionFacts(
		jobs: ClaimedMemoryJob[],
	): Promise<Map<string, string[]>>
	wakeMemoryJobWorker(): void
	startMemoryJobWorker(): void
	stopMemoryJobWorker(): Promise<void>
	scheduleBackgroundExtraction(
		eventId: string,
		tenant?: { scope?: MemoryScope; scopeRef?: string },
		runContext?: OperationRunContext,
	): Promise<{ jobId: string; scheduled: boolean }>
	schedulePostWriteDerivations(params: {
		eventId: string
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		timestamp: Date
		scope: MemoryScope
		scopeRef: string
		runContext?: OperationRunContext
	}): Promise<void>
	scheduleQueryCacheInvalidation(params: {
		agentId: string
		scope: MemoryScope
		scopeRef: string
	}): void
	resolveIdempotencyFingerprint(event: {
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
	}
	replayIdempotentEventWrite(params: {
		idempotencyKey: string
		event: {
			role: "user" | "assistant" | "system" | "tool"
			body: string
			sessionId?: string
			scope?: MemoryScope
			scopeRef?: string
		}
	}): Promise<{ eventId: string; chunkCreated: boolean } | null>
	writeConversationEvent(
		event: WriteConversationEventInput,
		operationRunContext?: OperationRunContext,
	): Promise<{ eventId: string; chunkCreated: boolean }>
	writeConversationEventsBatch(
		events: WriteConversationEventInput[],
		operationRunContext?: OperationRunContext,
	): Promise<WriteConversationEventReceipt[]>
	extractEvent(params: {
		eventId: string
		scope?: MemoryScope
		scopeRef?: string
	}): void
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
	status(): MemoryProviderStatus
	probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>
	probeVectorAvailability(): Promise<boolean>
	probeEmbeddingModeSupportsVector(): boolean
	getDetailedStatus(): Promise<V2Status>
	stats(): Promise<MemoryStats>
	readFile(params: {
		relPath: string
		from?: number
		lines?: number
	}): Promise<ManagerReadResult>
	readConversationChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	): Promise<ManagerReadResult>
	readCanonicalEvent(
		eventId: string,
		rawPath: string,
	): Promise<ManagerReadResult>
	readBridgeChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	): Promise<ManagerReadResult>
	readEpisodeLocator(params: {
		rawPath: string
		episodeId: string
		expandEvents: boolean
	}): Promise<ManagerReadResult>
	writeStructuredMemory(
		entry: StructuredMemoryEntry,
	): Promise<{ upserted: boolean; id: string }>
	writeProcedure(
		entry: ProcedureEntry,
	): Promise<{ upserted: boolean; id: string }>
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
	synthesizeProfile(params?: {
		scope?: MemoryScope
		scopeRef?: string
		maxPerType?: number
		maxEntities?: number
		maxEpisodes?: number
		activityWindowMs?: number
	}): Promise<ProfileSynthesis>
	hydrateActiveSlate(params?: {
		scope?: MemoryScope
		scopeRef?: string
		maxItems?: number
	}): Promise<MemoryActiveSlate>
	buildDiscoveryProjection(
		request: MemoryDiscoveryProjectionRequest,
	): Promise<MemoryDiscoveryProjection>
	buildContextBundle(
		request?: MemoryContextBundleRequest,
	): Promise<MemoryContextBundle>
	recallConversation(
		request: Omit<ConversationRecallRequest, "agentId">,
	): Promise<ConversationRecallResponse>
	refreshNativeBitemporalVectorPrefilter(): Promise<boolean>
	traceChain(params: {
		factId: string
		collection: string
		options?: { maxDepth?: number }
	}): ReturnType<typeof traceReasoningChain>
	scanNovelty(params?: {
		limit?: number
		scope?: string
		scopeRef?: string
	}): ReturnType<typeof scanNovelty>
	consolidate(params?: {
		maxEvents?: number
		minCombinedScore?: number
		scope?: MemoryScope
		scopeRef?: string
	}): ReturnType<typeof consolidateMemory>
	listRecallTraces(params?: {
		limit?: number
	}): ReturnType<typeof listRecallTraces>
	getRecallTrace(params: { traceId: string }): ReturnType<typeof getRecallTrace>
	listMemoryJobs(params?: {
		status?: import("./types.js").MemoryJobStatus
		limit?: number
		jobType?: import("./types.js").MemoryJobType
	}): ReturnType<typeof listMemoryJobs>
	getMemoryJob(params: { jobId: string }): ReturnType<typeof getMemoryJob>
}
