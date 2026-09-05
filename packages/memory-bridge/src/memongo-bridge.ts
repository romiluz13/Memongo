/**
 * Stable entry for the Memongo HTTP product layer: loads standalone config and
 * delegates to the MongoDB memory manager.
 */
import type {
	MemoryMongoDBFusionMethod,
	MemoryScope,
} from "@memongo/lib/types/memory"
import type {
	MemoryContextBundle,
	MemoryProviderStatus,
	MemorySearchDegradation,
	MemorySearchResult,
	MemorySearchTimeRange,
	MemoryFeedbackSignal,
	MemoryActorRole,
	MemoryStateFamily,
	MemoryStableHandle,
	MongoDBMemoryManager,
	RelevanceExplainResult,
	V2Status,
} from "@memongo/memory-engine"
// P4.1: deep engine symbols left the main barrel; during the deprecation
// window they are reachable via the explicit internal subpath.
import type {
	ConversationRecallResponse,
	DetectedCapabilities,
	MemoryActiveSlate,
	MemoryDiscoveryProjection,
	MemoryJob,
	MemoryJobStatus,
	MemoryJobType,
	MemoryAccessSummary,
	MemoryAccessTrend,
	MemoryConversationImportResult,
	AccessEventCollection,
	RecallTrace,
	MemoryStats,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	ProcedureLifecyclePatch,
	ProcedureEntry,
	ManagerReadResult,
	RelevanceReport,
	RelevanceSampleState,
	RelevanceSourceScope,
	StructuredMemoryLifecyclePatch,
	StructuredMemoryEntry,
	TenantErasureReceipt,
	QuarantinedEntry,
	QuarantineReviewReceipt,
	QuarantineStatus,
} from "@memongo/memory-engine/internal"
import {
	closeAllMemorySearchManagers,
	getMemorySearchManager,
} from "@memongo/memory-engine"
import { materializeBlocks } from "@memongo/memory-engine/internal"
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

/**
 * WS-12 (C-019): search carrying the degradation marker out of the engine.
 * Same pipeline as memongoBridgeSearch; the response's `degradation` is set
 * exactly when admission control degraded the answer (denied query, denied
 * legacy re-run), so the API boundary can serve "throttled" as throttling
 * instead of "no memories found". Absent means the answer is authoritative.
 */
export async function memongoBridgeSearchWithDegradation(params: {
	query: string
	agentId?: string
	maxResults?: number
	minScore?: number
	sessionKey?: string
	scope?: MemoryScope
	scopeRef?: string
}): Promise<{
	results: MemorySearchResult[]
	degradation?: MemorySearchDegradation
}> {
	const m = await memongoBridgeGetManager(params.agentId)
	let degradation: MemorySearchDegradation | undefined
	const results = await m.search(params.query, {
		maxResults: params.maxResults,
		minScore: params.minScore,
		sessionKey: params.sessionKey,
		scope: params.scope,
		scopeRef: params.scopeRef,
		onDegradation: (d) => {
			degradation = d
		},
	})
	return degradation ? { results, degradation } : { results }
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

/**
 * WS-12 (C-019): KB search carrying the degradation marker out of the engine.
 * `degradation` is set when admission control dropped the vector lane — the
 * text-lane results stand (real hits, degraded ranking), and the marker says
 * why, so degraded ranking never reads as authoritative ranking.
 */
export async function memongoBridgeSearchKBWithDegradation(params: {
	query: string
	agentId?: string
	scopeRef?: string
	maxResults?: number
	minScore?: number
	filter?: { tags?: string[]; category?: string; source?: string }
	fusionMethod?: MemoryMongoDBFusionMethod
}): Promise<{
	results: MemorySearchResult[]
	degradation?: MemorySearchDegradation
}> {
	const m = await memongoBridgeGetManager(params.agentId)
	let degradation: MemorySearchDegradation | undefined
	const results = await m.searchKB(params.query, {
		maxResults: params.maxResults,
		minScore: params.minScore,
		// Tenant isolation: search the caller's authorized KB scopeRef, not the
		// manager's default. Undefined falls back to the agent default in searchKB.
		scopeRef: params.scopeRef,
		filter: params.filter,
		fusionMethod: params.fusionMethod,
		onDegradation: (d) => {
			degradation = d
		},
	})
	return degradation ? { results, degradation } : { results }
}

export async function memongoBridgeReadFile(params: {
	relPath: string
	from?: number
	lines?: number
	agentId?: string
}): Promise<ManagerReadResult> {
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
	expiresAt?: string
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
		expiresAt: params.expiresAt,
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
	expiresAt?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	const timestamp = params.timestamp ? new Date(params.timestamp) : undefined
	const validAt = params.validAt ? new Date(params.validAt) : undefined
	const invalidAt = params.invalidAt ? new Date(params.invalidAt) : undefined
	const expiresAt = params.expiresAt ? new Date(params.expiresAt) : undefined
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
		expiresAt,
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
		expiresAt?: string
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
			expiresAt: event.expiresAt ? new Date(event.expiresAt) : undefined,
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

/**
 * C-003 tenant-level erasure: deletes every document the agent owns across
 * every collection (events, chunks, structured memories and revisions,
 * entities, relations, episodes, jobs, ledgers, caches, telemetry — and
 * relevance_artifacts via its parent runs). IRREVERSIBLE. Returns
 * per-collection receipts plus the proof-of-erasure audit record id; a
 * failed collection is reported on the receipt (status "partial") instead
 * of aborting the sweep.
 */
export async function memongoBridgeDeleteAllForAgent(params: {
	agentId?: string
}): Promise<TenantErasureReceipt> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.deleteAllForAgent()
}

/**
 * C-004 quarantine review: list the agent's quarantine review queue (and
 * decided history), oldest first. Injection-classified candidates wait here
 * for a human decision; before C-004 there was no way to even see them.
 */
export async function memongoBridgeListQuarantined(params: {
	agentId?: string
	status?: QuarantineStatus
	limit?: number
}): Promise<QuarantinedEntry[]> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.listQuarantined({
		status: params.status,
		limit: params.limit,
	})
}

/**
 * C-004 quarantine review: overrule the injection classifier and write the
 * quarantined candidate as structured memory, recording the decision
 * (reviewer, notes, timestamp) on the quarantine row and in memory_mutations.
 */
export async function memongoBridgePromoteQuarantined(params: {
	agentId?: string
	quarantineId: string
	reviewerId?: string
	reviewNotes?: string
}): Promise<QuarantineReviewReceipt> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.promoteQuarantined({
		quarantineId: params.quarantineId,
		reviewerId: params.reviewerId,
		reviewNotes: params.reviewNotes,
	})
}

/**
 * C-004 quarantine review: discard the quarantined candidate. The row is
 * kept as durable audit trail; only unreviewed entries age out (TTL).
 */
export async function memongoBridgeRejectQuarantined(params: {
	agentId?: string
	quarantineId: string
	reviewerId?: string
	reviewNotes?: string
}): Promise<QuarantineReviewReceipt> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.rejectQuarantined({
		quarantineId: params.quarantineId,
		reviewerId: params.reviewerId,
		reviewNotes: params.reviewNotes,
	})
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
 * themselves. B2a: the manager declares `capabilities` publicly, so this is
 * a typed read (the `| null` return shape is kept for callers compiled
 * against the pre-typed surface).
 */
export async function memongoBridgeCapabilities(params: {
	agentId?: string
}): Promise<MemongoBridgeCapabilities | null> {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.capabilities
}

/**
 * Readiness probe for the Mongo lane (P1.7). This probe forces a live,
 * bounded round-trip (a limit-1 jobs read) through the cached manager and
 * reports failure instead of throwing, so a `/ready` endpoint can answer
 * 503 while Mongo is unreachable. (C-016: `probeVectorAvailability` and
 * `probeEmbeddingAvailability` are ALSO live now — an index-status round
 * trip per call — but they answer vector/search-lane health, not Mongo
 * connectivity, so this lane stays.)
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
	resolveContradictions?: boolean
	llmDedup?: boolean
	scope?: MemoryScope
	scopeRef?: string
}) {
	const m = await memongoBridgeGetManager(params.agentId)
	return m.consolidate({
		maxEvents: params.maxEvents,
		minCombinedScore: params.minCombinedScore,
		resolveContradictions: params.resolveContradictions,
		llmDedup: params.llmDedup,
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
}): Promise<{
	upserted: boolean
	id: string
	/** C-008: true when the merged content was routed to memory_quarantine. */
	quarantined?: boolean
	matchedPatterns?: string[]
}> {
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

export type { MemoryStableHandle } from "@memongo/memory-engine"
export type {
	MemoryConversationImportResult,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	ProcedureEntry,
	StructuredMemoryEntry,
} from "@memongo/memory-engine/internal"
