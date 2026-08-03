/**
 * Stable entry for the Memongo HTTP product layer: loads standalone config and
 * delegates to the MongoDB memory manager.
 */
import type {
	MemoryMongoDBFusionMethod,
	MemoryScope,
} from "@memongo/lib/types/memory"
import type {
	ConversationRecallResponse,
	DetectedCapabilities,
	MemoryActiveSlate,
	MemoryContextBundle,
	MemoryDiscoveryProjection,
	MemoryProviderStatus,
	MemoryJob,
	MemoryJobStatus,
	MemoryJobType,
	MemorySearchTimeRange,
	MemoryAccessSummary,
	MemoryAccessTrend,
	MemoryBenchmarkIngestResult,
	MemoryConversationImportResult,
	MemoryFeedbackSignal,
	AccessEventCollection,
	BenchmarkQualityThresholds,
	MemoryActorRole,
	RecallTrace,
	MemoryStateFamily,
	MemoryStats,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	MemoryStableHandle,
	MongoDBMemoryManager,
	ProcedureLifecyclePatch,
	ProcedureEntry,
	RelevanceBenchmarkResult,
	RelevanceExplainResult,
	RelevanceReport,
	RelevanceSampleState,
	RelevanceSourceScope,
	StructuredMemoryLifecyclePatch,
	StructuredMemoryEntry,
	V2Status,
} from "@memongo/memory-engine"
import {
	closeAllMemorySearchManagers,
	getMemorySearchManager,
	materializeBlocks,
} from "@memongo/memory-engine"
import { resolveBridgeConfig } from "./memory-config.js"

/**
 * Graceful shutdown: Graceful bridge shutdown.
 * Closes every cached MongoDB memory manager, which in turn flushes the
 * access tracker and closes the Mongo client. Swallows errors per-manager
 * via `closeAllMemorySearchManagers` so one failing manager does not block
 * the rest.
 */
export async function memongoBridgeShutdown(): Promise<void> {
	await closeAllMemorySearchManagers()
}

// P2.2: the engine's MemorySearchManager interface now declares every method
// as non-optional (one backend exists), so the bridge calls the manager
// directly. The 13 `*CapableManager` intersection types and the three
// re-declared domain types (active slate / discovery projection / context
// bundle) that used to live here were deleted — the bridge re-uses the real
// engine types instead of keeping a third structural copy.

export type MemongoBridgeContext = {
	agentId: string
}

function resolveAgentId(explicit?: string): string {
	return (explicit ?? process.env.MEMONGO_AGENT_ID ?? "main").trim() || "main"
}

export async function memongoBridgeGetManager(
	agentId?: string,
): Promise<MongoDBMemoryManager> {
	const id = resolveAgentId(agentId)
	const cfg = resolveBridgeConfig()
	const { manager, error } = await getMemorySearchManager({ cfg, agentId: id })
	if (!manager || error) {
		throw new Error(error ?? "mongodb memory unavailable")
	}
	return manager as MongoDBMemoryManager
}

export async function memongoBridgeSearch(params: {
	query: string
	agentId?: string
	maxResults?: number
	minScore?: number
	sessionKey?: string
	scope?: MemoryScope
	scopeRef?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.search(params.query, {
		maxResults: params.maxResults,
		minScore: params.minScore,
		sessionKey: params.sessionKey,
		scope: params.scope,
		scopeRef: params.scopeRef,
	})
}

export async function memongoBridgeWaitForBenchmarkSearchReadiness(params: {
	agentId?: string
	retrievalLane?: "native" | "raw-session"
	scope?: MemoryScope
	scopeRef?: string
	sessionId?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	await m.waitForBenchmarkSearchReadiness({
		retrievalLane: params.retrievalLane,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: params.sessionId,
	})
}

export async function memongoBridgeSearchKB(params: {
	query: string
	agentId?: string
	scopeRef?: string
	maxResults?: number
	minScore?: number
	filter?: { tags?: string[]; category?: string; source?: string }
	fusionMethod?: MemoryMongoDBFusionMethod
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.searchKB(params.query, {
		maxResults: params.maxResults,
		minScore: params.minScore,
		// Tenant isolation: search the caller's authorized KB scopeRef, not the
		// manager's default. Undefined falls back to the agent default in searchKB.
		scopeRef: params.scopeRef,
		filter: params.filter,
		fusionMethod: params.fusionMethod,
	})
}

export async function memongoBridgeReadFile(params: {
	relPath: string
	from?: number
	lines?: number
	agentId?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.readFile({
		relPath: params.relPath,
		from: params.from,
		lines: params.lines,
	})
}

/** Legacy: append a user message (same as `writeConversationEvent` with role user). */
export async function memongoBridgeAdd(params: {
	content: string
	agentId?: string
	sessionId?: string
	metadata?: Record<string, unknown>
	scope?: MemoryScope
	scopeRef?: string
	idempotencyKey?: string
}) {
	return memongoBridgeWriteConversationEvent({
		agentId: params.agentId,
		role: "user",
		body: params.content,
		sessionId: params.sessionId,
		metadata: params.metadata,
		scope: params.scope,
		scopeRef: params.scopeRef,
		idempotencyKey: params.idempotencyKey,
	})
}

export async function memongoBridgeWriteConversationEvent(params: {
	agentId?: string
	role: "user" | "assistant" | "system" | "tool"
	body: string
	sessionId?: string
	timestamp?: string
	validAt?: string
	invalidAt?: string
	metadata?: Record<string, unknown>
	scope?: MemoryScope
	scopeRef?: string
	idempotencyKey?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	const timestamp = params.timestamp ? new Date(params.timestamp) : undefined
	const validAt = params.validAt ? new Date(params.validAt) : undefined
	const invalidAt = params.invalidAt ? new Date(params.invalidAt) : undefined
	return m.writeConversationEvent({
		role: params.role,
		body: params.body,
		sessionId: params.sessionId,
		timestamp,
		validAt,
		invalidAt,
		metadata: params.metadata,
		scope: params.scope,
		scopeRef: params.scopeRef,
		idempotencyKey: params.idempotencyKey,
	})
}

/**
 * P3.9: batch variant of memongoBridgeWriteConversationEvent. One bridge
 * call writes the whole array through the engine's amortized batch write
 * (insertMany + bulkWrite) and returns per-item receipts mirroring the
 * single-write receipt shape; a failed item never fails its siblings.
 */
export async function memongoBridgeWriteConversationEventsBatch(params: {
	agentId?: string
	events: Array<{
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		timestamp?: string
		validAt?: string
		invalidAt?: string
		metadata?: Record<string, unknown>
		scope?: MemoryScope
		scopeRef?: string
		idempotencyKey?: string
	}>
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.writeConversationEventsBatch(
		params.events.map((event) => ({
			role: event.role,
			body: event.body,
			sessionId: event.sessionId,
			timestamp: event.timestamp ? new Date(event.timestamp) : undefined,
			validAt: event.validAt ? new Date(event.validAt) : undefined,
			invalidAt: event.invalidAt ? new Date(event.invalidAt) : undefined,
			metadata: event.metadata,
			scope: event.scope,
			scopeRef: event.scopeRef,
			idempotencyKey: event.idempotencyKey,
		})),
	)
}

export async function memongoBridgeExtractEvent(params: {
	agentId?: string
	scope?: MemoryScope
	scopeRef?: string
	eventId: string
}): Promise<{ jobId: string; scheduled: boolean }> {
	const m = await memongoBridgeGetManager(params.agentId)
	// Tenant isolation: forward the authorized scope/scopeRef so extraction can
	// only read an event within the caller's tenant.
	return m.extractEvent({
		eventId: params.eventId,
		scope: params.scope,
		scopeRef: params.scopeRef,
	})
}

export async function memongoBridgeWriteStructuredMemory(params: {
	agentId?: string
	scope?: MemoryScope
	scopeRef?: string
	entry: StructuredMemoryEntry
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	const id = resolveAgentId(params.agentId)
	return m.writeStructuredMemory({
		...params.entry,
		// Issue #42: the manager/collection prefix is selected from the
		// authorized identity, so the stored agentId MUST be that identity.
		// Never trust a caller-supplied entry.agentId (cross-tenant write).
		agentId: id,
		// Scope isolation: when the caller resolved an authorized scope/scopeRef
		// (top-level precedence), force them so a nested entry.scope/entry.scopeRef
		// smuggle cannot cross the tenant boundary. Undefined = unscoped caller;
		// keep the entry's own value.
		...(params.scope !== undefined ? { scope: params.scope } : {}),
		...(params.scopeRef !== undefined ? { scopeRef: params.scopeRef } : {}),
	})
}

export async function memongoBridgeWriteProcedure(params: {
	agentId?: string
	scope?: MemoryScope
	scopeRef?: string
	entry: ProcedureEntry
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	const id = resolveAgentId(params.agentId)
	return m.writeProcedure({
		...params.entry,
		// Issue #42: force the authorized identity; never trust entry.agentId.
		agentId: id,
		// Scope isolation: force the authorized scope/scopeRef over any nested
		// entry smuggle (see memongoBridgeWriteStructuredMemory).
		...(params.scope !== undefined ? { scope: params.scope } : {}),
		...(params.scopeRef !== undefined ? { scopeRef: params.scopeRef } : {}),
	})
}

export async function memongoBridgeProfile(params: {
	agentId?: string
	scope?: MemoryScope
	scopeRef?: string
	maxEntities?: number
	maxEpisodes?: number
	maxPerType?: number
	activityWindowMs?: number
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.synthesizeProfile({
		scope: params.scope,
		scopeRef: params.scopeRef,
		maxEntities: params.maxEntities,
		maxEpisodes: params.maxEpisodes,
		maxPerType: params.maxPerType,
		activityWindowMs: params.activityWindowMs,
	})
}

export async function memongoBridgeHydrateActiveSlate(params: {
	agentId?: string
	scope?: MemoryScope
	scopeRef?: string
	maxItems?: number
}): Promise<MemoryActiveSlate> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.hydrateActiveSlate({
		scope: params.scope,
		scopeRef: params.scopeRef,
		maxItems: params.maxItems,
	})
}

export async function memongoBridgeBuildDiscoveryProjection(params: {
	agentId?: string
	kind: "entity-brief" | "topic-brief" | "what-changed" | "contradiction-report"
	query?: string
	scope?: MemoryScope
	scopeRef?: string
	maxItems?: number
	timeRange?: {
		preset?: string
		start?: string
		end?: string
	}
}): Promise<MemoryDiscoveryProjection> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.buildDiscoveryProjection({
		kind: params.kind,
		query: params.query,
		scope: params.scope,
		scopeRef: params.scopeRef,
		maxItems: params.maxItems,
		// HTTP boundary type (preset: string) narrowed to the engine's preset
		// union at the seam — same translation pattern as searchDetailed.
		timeRange: params.timeRange as MemorySearchTimeRange | undefined,
	})
}

export async function memongoBridgeBuildContextBundle(params: {
	agentId?: string
	query?: string
	scope?: MemoryScope
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
	timeRange?: {
		preset?: string
		start?: string
		end?: string
	}
	mode?: "full" | "wake-up"
}): Promise<MemoryContextBundle> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.buildContextBundle({
		query: params.query,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: params.sessionId,
		tokenBudget: params.tokenBudget,
		maxActiveItems: params.maxActiveItems,
		maxEvidenceItems: params.maxEvidenceItems,
		maxRecentEvents: params.maxRecentEvents,
		includeDiscoveryProjection: params.includeDiscoveryProjection,
		discoveryKind: params.discoveryKind,
		includeProfile: params.includeProfile,
		// HTTP boundary type (preset: string) narrowed to the engine's preset
		// union at the seam — same translation pattern as searchDetailed.
		timeRange: params.timeRange as MemorySearchTimeRange | undefined,
		mode: params.mode,
	})
}

export async function memongoBridgeRecallConversation(params: {
	agentId?: string
	scope?: string
	scopeRef?: string
	query?: string
	sessionId?: string
	roles?: Array<"user" | "assistant" | "system" | "tool">
	startTime?: string
	endTime?: string
	asOf?: string
	timezone?: string
	includeToolMessages?: boolean
	limit?: number
}): Promise<ConversationRecallResponse> {
	const m = await memongoBridgeGetManager(params.agentId)
	const asOf = params.asOf ? new Date(params.asOf) : undefined
	return m.recallConversation({
		// Tenant isolation: forward the authorized scope/scopeRef so recall is
		// filtered to the caller's tenant, never all scopes under the agent.
		scope: params.scope,
		scopeRef: params.scopeRef,
		query: params.query,
		sessionId: params.sessionId,
		roles: params.roles,
		startTime: params.startTime,
		endTime: params.endTime,
		asOf,
		timezone: params.timezone,
		includeToolMessages: params.includeToolMessages,
		limit: params.limit,
	})
}

export async function memongoBridgeGetLifecycleItem(params: {
	handle: MemoryStableHandle
}): Promise<MemoryLifecycleItem | null> {
	const m = await memongoBridgeGetManager(params.handle.agentId)
	return m.getLifecycleItem(params.handle)
}

export async function memongoBridgeUpdateLifecycleItem(params: {
	handle: MemoryStableHandle
	patch: StructuredMemoryLifecyclePatch | ProcedureLifecyclePatch
}): Promise<MemoryLifecycleItem | null> {
	const m = await memongoBridgeGetManager(params.handle.agentId)
	return m.updateLifecycleItem(params.handle, params.patch)
}

export async function memongoBridgeDeleteLifecycleItem(params: {
	handle: MemoryStableHandle
	invalidatedBy?: Record<string, unknown>
}): Promise<MemoryLifecycleItem | null> {
	const m = await memongoBridgeGetManager(params.handle.agentId)
	return m.invalidateLifecycleItem(params.handle, params.invalidatedBy)
}

export async function memongoBridgeGetLifecycleHistory(params: {
	handle: MemoryStableHandle
	limit?: number
}): Promise<MemoryLifecycleHistoryEntry[]> {
	const m = await memongoBridgeGetManager(params.handle.agentId)
	return m.getLifecycleHistory({
		handle: params.handle,
		limit: params.limit,
	})
}

export async function memongoBridgeReportProcedureOutcome(params: {
	handle: Extract<MemoryStableHandle, { family: "procedure" }>
	success: boolean
	note?: string
	actorRole?: MemoryActorRole
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	const m = await memongoBridgeGetManager(params.handle.agentId)
	return m.reportProcedureOutcome(params)
}

export async function memongoBridgeApplyMemoryFeedback(params: {
	handle: Extract<MemoryStableHandle, { family: "structured" }>
	signal: MemoryFeedbackSignal
	patch?: StructuredMemoryLifecyclePatch
	invalidatedBy?: Record<string, unknown>
	note?: string
	actorRole?: MemoryActorRole
}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
	const m = await memongoBridgeGetManager(params.handle.agentId)
	return m.applyMemoryFeedback(params)
}

export async function memongoBridgeSearchDetailed(params: {
	agentId?: string
	query: string
	scope?: MemoryScope
	scopeRef?: string
	maxResults?: number
	minScore?: number
	searchMode?: "auto" | "direct" | "agentic"
	sourcePreference?: string[]
	timeRange?: {
		preset?: string
		start?: string
		end?: string
	}
	needExactEvidence?: boolean
	maxPasses?: number
	returnPlan?: boolean
	conversationScope?: { sessionKey?: string }
	structuredScope?: {
		type?: string
		state?: string | string[]
		salience?: string[]
	}
	referenceScope?: {
		source?: string
		category?: string
		tags?: string[]
	}
	proceduralScope?: { state?: string; intentTags?: string[] }
	searchConfig?: {
		recipe?: "fast" | "hybrid" | "deep" | "temporal" | "chain-of-thought"
		recallProfile?: "latency" | "balanced" | "proof"
		maxResults?: number
		searchMode?: "auto" | "direct" | "agentic"
		maxPasses?: number
		sourcePreference?: string[]
		timeRange?: {
			preset?: string
			start?: string
			end?: string
		}
		needExactEvidence?: boolean
		numCandidates?: number
		fusionMethod?: "scoreFusion" | "rankFusion" | "js-merge"
		hybridMode?: "hybrid" | "vector-only"
		allowHybridBackstop?: boolean
		lexicalPrefilter?: "disabled" | "experimental"
	}
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	if (!m.searchDetailed) {
		throw new Error("searchDetailed is not available on this manager")
	}
	return m.searchDetailed({
		query: params.query,
		scope: params.scope,
		scopeRef: params.scopeRef,
		maxResults: params.maxResults,
		minScore: params.minScore,
		searchMode: params.searchMode,
		sourcePreference: params.sourcePreference as
			| Array<
					| "reference"
					| "conversation"
					| "structured"
					| "procedural"
					| "episodic"
					| "graph"
			  >
			| undefined,
		timeRange: params.timeRange as
			| {
					preset?:
						| "today"
						| "yesterday"
						| "last-24h"
						| "last-7d"
						| "this-week"
						| "last-30d"
						| "this-month"
					start?: string
					end?: string
			  }
			| undefined,
		needExactEvidence: params.needExactEvidence,
		maxPasses: params.maxPasses,
		returnPlan: params.returnPlan,
		conversationScope: params.conversationScope,
		structuredScope: params.structuredScope,
		referenceScope: params.referenceScope,
		proceduralScope: params.proceduralScope,
		searchConfig: params.searchConfig as
			| {
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
					timeRange?: {
						preset?:
							| "today"
							| "yesterday"
							| "last-24h"
							| "last-7d"
							| "this-week"
							| "last-30d"
							| "this-month"
						start?: string
						end?: string
					}
					needExactEvidence?: boolean
					numCandidates?: number
					fusionMethod?: "scoreFusion" | "rankFusion" | "js-merge"
					hybridMode?: "hybrid" | "vector-only"
					allowHybridBackstop?: boolean
					lexicalPrefilter?: "disabled" | "experimental"
			  }
			| undefined,
	})
}

export async function memongoBridgeStatus(params: {
	agentId?: string
}): Promise<MemoryProviderStatus> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.status()
}

export async function memongoBridgeGetDetailedStatus(params: {
	agentId?: string
}): Promise<V2Status> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.getDetailedStatus()
}

export async function memongoBridgeStats(params: {
	agentId?: string
}): Promise<MemoryStats> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.stats()
}

export async function memongoBridgeSync(params: {
	agentId?: string
	reason?: string
	force?: boolean
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.sync({
		reason: params.reason,
		force: params.force,
	})
}

export async function memongoBridgeProbeEmbedding(params: {
	agentId?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.probeEmbeddingAvailability()
}

export async function memongoBridgeProbeVector(params: { agentId?: string }) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.probeVectorAvailability()
}

/**
 * Serving capabilities detected by the engine at manager creation. Alias of
 * the engine's `DetectedCapabilities` (re-exported through the engine package
 * entry since P2.2 — previously redeclared here because the engine did not
 * export the type). vectorSearch/textSearch are true only when the concrete
 * serving Atlas Search indexes exist and are queryable — not merely when the
 * deployment could support them.
 */
export type MemongoBridgeCapabilities = DetectedCapabilities

/**
 * P1.9 boot capability surface: exposes the manager's detected serving
 * capabilities so deploy targets (memongo-api boot) can log a search-lane
 * table and enforce MEMONGO_REQUIRE_VECTOR without re-probing Mongo
 * themselves. Returns null when the manager predates the capability field.
 */
export async function memongoBridgeCapabilities(params: {
	agentId?: string
}): Promise<MemongoBridgeCapabilities | null> {
	const m = await memongoBridgeGetManager(params.agentId)
	return (
		(m as unknown as { capabilities?: MemongoBridgeCapabilities })
			.capabilities ?? null
	)
}

/**
 * Readiness probe for the Mongo lane (P1.7). `probeVectorAvailability` and
 * `probeEmbeddingAvailability` are capability checks computed at manager
 * creation — they cannot detect a MongoDB that died after boot, and
 * `getDetailedStatus` intentionally swallows per-query failures. This probe
 * forces a live, bounded round-trip (a limit-1 jobs read) through the cached
 * manager and reports failure instead of throwing, so a `/ready` endpoint can
 * answer 503 while Mongo is unreachable.
 */
export async function memongoBridgePingMongo(params: {
	agentId?: string
}): Promise<{ ok: boolean; message?: string }> {
	try {
		const m = await memongoBridgeGetManager(params.agentId)
		await m.listMemoryJobs({ limit: 1 })
		return { ok: true }
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		}
	}
}

// Re-exported so deploy targets (memongo-api boot validation) can resolve the
// effective config exactly the way the bridge does at runtime (env first, then
// ~/.memongo/memongo.json) instead of duplicating the merge rules.
export { buildMemongoConfig } from "./memory-config.js"

export async function memongoBridgeRelevanceExplain(params: {
	agentId?: string
	query: string
	sourceScope?: RelevanceSourceScope
	sessionKey?: string
	maxResults?: number
	minScore?: number
	deep?: boolean
}): Promise<RelevanceExplainResult> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.relevanceExplain({
		query: params.query,
		sourceScope: params.sourceScope,
		sessionKey: params.sessionKey,
		maxResults: params.maxResults,
		minScore: params.minScore,
		deep: params.deep,
	})
}

export async function memongoBridgeRelevanceBenchmark(params: {
	agentId?: string
	datasetPath?: string
	maxResults?: number
	minScore?: number
	/** Task 1.A parity envelope — optional pass-through. */
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
	retrievalLane?: "native" | "raw-session"
	qualityThresholds?: BenchmarkQualityThresholds
	/** #70: real recall-regression suite outcome for this invocation. */
	conversationRecallRegression?: {
		status: "passed" | "failed"
		evidence: string
	}
}): Promise<RelevanceBenchmarkResult> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.relevanceBenchmark({
		datasetPath: params.datasetPath,
		maxResults: params.maxResults,
		minScore: params.minScore,
		...(params.datasetSha256 ? { datasetSha256: params.datasetSha256 } : {}),
		...(params.embeddingConfig
			? { embeddingConfig: params.embeddingConfig }
			: {}),
		...(params.rerankerConfig ? { rerankerConfig: params.rerankerConfig } : {}),
		...(params.retrievalLane ? { retrievalLane: params.retrievalLane } : {}),
		...(params.qualityThresholds
			? { qualityThresholds: params.qualityThresholds }
			: {}),
		...(params.conversationRecallRegression
			? { conversationRecallRegression: params.conversationRecallRegression }
			: {}),
	})
}

export async function memongoBridgeRelevanceReport(params: {
	agentId?: string
	windowMs?: number
}): Promise<RelevanceReport> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.relevanceReport({ windowMs: params.windowMs })
}

export async function memongoBridgeRelevanceSampleRate(params: {
	agentId?: string
}): Promise<RelevanceSampleState> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.relevanceSampleRate()
}

export async function memongoBridgeBenchmarkIngest(params: {
	agentId?: string
	datasetPath: string
	scope?: MemoryScope
	limitConversations?: number
	limitTurnsPerConversation?: number
}): Promise<MemoryBenchmarkIngestResult> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.benchmarkIngest({
		datasetPath: params.datasetPath,
		scope: params.scope,
		limitConversations: params.limitConversations,
		limitTurnsPerConversation: params.limitTurnsPerConversation,
	})
}

export async function memongoBridgeImportConversations(params: {
	agentId?: string
	datasetPath: string
	scope?: MemoryScope
	scopeRef?: string
	limitConversations?: number
	limitTurnsPerConversation?: number
}): Promise<MemoryConversationImportResult> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.importConversations({
		datasetPath: params.datasetPath,
		scope: params.scope,
		// Tenant isolation: forward the authorized scopeRef so imported turns are
		// forced into the caller's tenant (see manager importConversations).
		scopeRef: params.scopeRef,
		limitConversations: params.limitConversations,
		limitTurnsPerConversation: params.limitTurnsPerConversation,
	})
}

export async function memongoBridgeAccessTrends(params: {
	agentId?: string
	collection?: AccessEventCollection
	memoryIds?: string[]
	windowDays?: number
	limit?: number
}): Promise<MemoryAccessTrend[]> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.accessTrends({
		collection: params.collection,
		memoryIds: params.memoryIds,
		windowDays: params.windowDays,
		limit: params.limit,
	})
}

export async function memongoBridgeAccessSummaries(params: {
	agentId?: string
	collection: AccessEventCollection
	memoryIds: string[]
	windowDays?: number
}): Promise<MemoryAccessSummary[]> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.accessSummaries({
		collection: params.collection,
		memoryIds: params.memoryIds,
		windowDays: params.windowDays,
	})
}

export async function memongoBridgeTraceChain(params: {
	agentId?: string
	factId: string
	collection: string
	maxDepth?: number
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.traceChain({
		factId: params.factId,
		collection: params.collection,
		options:
			params.maxDepth !== undefined ? { maxDepth: params.maxDepth } : undefined,
	})
}

export async function memongoBridgeScanNovelty(params: {
	agentId?: string
	limit?: number
	scope?: string
	scopeRef?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.scanNovelty({
		limit: params.limit,
		scope: params.scope,
		// Tenant isolation: forward the authorized scopeRef so novelty scanning
		// stays within the caller's tenant, not every scopeRef under the scope.
		scopeRef: params.scopeRef,
	})
}

export async function memongoBridgeConsolidate(params: {
	agentId?: string
	maxEvents?: number
	minCombinedScore?: number
	scope?: MemoryScope
	scopeRef?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.consolidate({
		maxEvents: params.maxEvents,
		minCombinedScore: params.minCombinedScore,
		scope: params.scope,
		// Tenant isolation: forward the authorized scopeRef so consolidation only
		// processes the caller's tenant events (consolidateMemory filters on it).
		scopeRef: params.scopeRef,
	})
}

export async function memongoBridgeSelfEdit(params: {
	agentId?: string
	block: "user" | "persona" | "instructions"
	action: "append" | "replace" | "prepend"
	content: string
}): Promise<{ upserted: boolean; id: string }> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.selfEditBlock({
		block: params.block,
		action: params.action,
		content: params.content,
	})
}

export async function memongoBridgeGetState(params: {
	agentId?: string
	scope?: MemoryScope
	scopeRef?: string
}): Promise<MemoryStateFamily & { partial?: boolean }> {
	const results = await Promise.allSettled([
		memongoBridgeProfile({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
		}),
		memongoBridgeHydrateActiveSlate({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
		}),
		memongoBridgeBuildContextBundle({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
		}),
	])
	const partial = results.some((r) => r.status === "rejected")
	const profile =
		results[0].status === "fulfilled"
			? results[0].value
			: ({} as MemoryStateFamily["profile"])
	const slate = results[1].status === "fulfilled" ? results[1].value : null
	const bundle =
		results[2].status === "fulfilled"
			? results[2].value
			: ({} as MemoryStateFamily["bundle"])
	const blocks = slate
		? materializeBlocks(slate)
		: { blocks: [], totalTokenBudget: 0, totalActualTokens: 0 }
	return { profile, blocks, bundle, ...(partial ? { partial: true } : {}) }
}

export async function memongoBridgeListRecallTraces(params: {
	agentId?: string
	limit?: number
}): Promise<RecallTrace[]> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.listRecallTraces({ limit: params.limit })
}

export async function memongoBridgeGetRecallTrace(params: {
	agentId?: string
	traceId: string
}): Promise<RecallTrace | null> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.getRecallTrace({ traceId: params.traceId })
}

export async function memongoBridgeListMemoryJobs(params: {
	agentId?: string
	status?: MemoryJobStatus
	limit?: number
	jobType?: MemoryJobType
}): Promise<MemoryJob[]> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.listMemoryJobs({
		status: params.status,
		limit: params.limit,
		jobType: params.jobType,
	})
}

export async function memongoBridgeGetMemoryJob(params: {
	agentId?: string
	jobId: string
}): Promise<MemoryJob | null> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.getMemoryJob({ jobId: params.jobId })
}

export type {
	MemoryConversationImportResult,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	MemoryStableHandle,
	ProcedureEntry,
	StructuredMemoryEntry,
} from "@memongo/memory-engine"
