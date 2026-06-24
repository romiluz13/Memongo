import type {
	MemongoAddInput,
	MemongoAccessSummaryResponse,
	MemongoAccessTrendResponse,
	MemongoActiveSlateInput,
	MemongoBenchmarkIngestResponse,
	MemongoConsolidateInput,
	MemongoConsolidateResponse,
	MemongoConversationImportInput,
	MemongoConversationImportResponse,
	MemongoConversationRecallInput,
	MemongoConversationRecallResponse,
	MemongoMemoryJob,
	MemongoMemoryJobStatus,
	MemongoMemoryJobType,
	MemongoContextBundleInput,
	MemongoDetailedStatusResponse,
	MemongoDiscoveryProjectionInput,
	MemongoExtractInput,
	MemongoExtractResponse,
	MemongoLifecycleDeleteInput,
	MemongoMemoryFeedbackInput,
	MemongoLifecycleGetInput,
	MemongoLifecycleHistoryEntry,
	MemongoLifecycleHistoryInput,
	MemongoLifecycleItem,
	MemongoLifecycleUpdateInput,
	MemongoNoveltyResponse,
	MemongoProbeEmbeddingResponse,
	MemongoProfileInput,
	MemongoProfileResponse,
	MemongoReadFileResponse,
	MemongoRelevanceBenchmarkResponse,
	MemongoRelevanceExplainResponse,
	MemongoRelevanceReportResponse,
	MemongoRelevanceSampleRateResponse,
	MemongoProcedureOutcomeInput,
	MemongoRecallTrace,
	MemongoScanNoveltyInput,
	MemongoSearchInput,
	MemongoSearchKBResponse,
	MemongoSearchResponse,
	SearchConfig,
	MemongoStatsResponse,
	MemongoStatusResponse,
	MemongoTraceChainInput,
	MemongoTraceChainResponse,
	MemongoSelfEditInput,
	MemongoSelfEditResponse,
} from "./types.js"

export type MemongoClientOptions = {
	/** Memongo API base URL (e.g. http://127.0.0.1:3847). */
	baseUrl?: string
	/** Optional Bearer token; also reads `MEMONGO_API_KEY` when unset. */
	apiKey?: string
	/** Max retries for 429/503 (default 2). */
	maxRetries?: number
}

/** Thrown when the Memongo HTTP API returns a non-OK status. */
export class MemongoClientError extends Error {
	readonly status: number
	readonly body: string

	constructor(status: number, body: string, message?: string) {
		super(message ?? `Memongo API ${status}: ${body || "(empty)"}`)
		this.name = "MemongoClientError"
		this.status = status
		this.body = body
	}
}

function resolveBaseUrl(opts: MemongoClientOptions): string {
	const raw =
		opts.baseUrl ?? process.env.MEMONGO_API_URL ?? "http://127.0.0.1:3847"
	return raw.replace(/\/$/, "")
}

function resolveApiKey(opts: MemongoClientOptions): string | undefined {
	return opts.apiKey ?? process.env.MEMONGO_API_KEY ?? undefined
}

function shouldRetryStatus(status: number): boolean {
	return status === 429 || status === 503
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

function buildHeaders(
	opts: MemongoClientOptions,
	method: string,
): Record<string, string> {
	const key = resolveApiKey(opts)
	const headers: Record<string, string> = {}
	if (key) {
		headers.Authorization = `Bearer ${key}`
	}
	if (method !== "GET" && method !== "HEAD") {
		headers["Content-Type"] = "application/json"
	}
	return headers
}

async function apiFetch<T>(
	opts: MemongoClientOptions,
	path: string,
	init: RequestInit,
): Promise<T> {
	const url = `${resolveBaseUrl(opts)}${path}`
	const method = (init.method ?? "GET").toUpperCase()
	const maxRetries = opts.maxRetries ?? 2
	let attempt = 0
	for (;;) {
		const res = await fetch(url, {
			...init,
			headers: { ...buildHeaders(opts, method), ...init.headers },
		})
		if (res.ok) {
			return (await res.json()) as T
		}
		const text = await res.text()
		if (shouldRetryStatus(res.status) && attempt < maxRetries) {
			attempt += 1
			await sleep(200 * attempt)
			continue
		}
		throw new MemongoClientError(res.status, text)
	}
}

async function apiPost<T>(
	opts: MemongoClientOptions,
	path: string,
	body: Record<string, unknown>,
): Promise<T> {
	return apiFetch<T>(opts, path, {
		method: "POST",
		body: JSON.stringify(body),
	})
}

async function apiGet<T>(opts: MemongoClientOptions, path: string): Promise<T> {
	return apiFetch<T>(opts, path, { method: "GET" })
}

function q(
	agentId?: string,
	extra?: Record<string, string | number | undefined>,
): string {
	const p = new URLSearchParams()
	if (agentId) {
		p.set("agentId", agentId)
	}
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			if (v !== undefined && v !== "") {
				p.set(k, String(v))
			}
		}
	}
	const s = p.toString()
	return s ? `?${s}` : ""
}

/** A single result from `searchDetailed`. */
export type MemongoSearchDetailedResult = {
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
	state?: string
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	sourceReliability?: number
	reinforcementCount?: number
	validFrom?: string
	validTo?: string
	reviewAt?: string
	lastConfirmedAt?: string
	trust?: {
		score: number
		confidence: "high" | "medium" | "low"
		exactness: "exact-id" | "exact-locator" | "approximate"
		freshness: "fresh" | "aging" | "stale" | "timeless" | "unknown"
		contradiction: "none" | "conflicted" | "invalidated"
		scopeMatch: "exact" | "partial" | "unknown" | "mismatch"
		provenance: "dense" | "partial" | "sparse" | "none"
		sourceDiversity: "single" | "multi"
		factors: string[]
	}
}

/** A single retrieval pass executed during search. */
export type MemongoSearchPass = {
	pass: number
	query: string
	reason: string
	pathsExecuted: string[]
	resultCount: number
	queryRewritten: boolean
	reranked: boolean
	correctionApplied?: string
}

/** Metadata returned by `searchDetailed`. */
export type MemongoSearchDetailedMetadata = {
	mode: string
	classification: string
	sourceOrder: string[]
	resolvedSearchConfig?: SearchConfig & {
		recipe:
			| "fast"
			| "hybrid"
			| "deep"
			| "temporal"
			| "chain-of-thought"
			| "custom"
		recallProfile: "latency" | "balanced" | "proof"
		maxResults: number
		searchMode: "auto" | "direct" | "agentic"
		maxPasses: number
		sourcePreference: string[]
		needExactEvidence: boolean
		numCandidates: number
		fusionMethod: "scoreFusion" | "rankFusion" | "js-merge"
		hybridMode: "hybrid" | "vector-only"
		allowHybridBackstop: boolean
		lexicalPrefilter: "disabled" | "experimental"
	}
	passes: MemongoSearchPass[]
	queriesTried: string[]
	constraintsApplied: string[]
	resultsRejected: Array<{
		canonicalId?: string
		path?: string
		source?: string
		reason: string
	}>
	evidenceCoverage: string
	pathsExecuted: string[]
	resultsByPath: Record<string, number>
	queryRewritten: boolean
	reranked: boolean
	noDirectEvidenceReason?: string
	constraintRelaxations?: Array<{ constraint: string; action: string }>
	mmrApplied?: boolean
	mmrLambda?: number
	trustSummary?: {
		topScore: number | null
		topConfidence: "high" | "medium" | "low" | null
		averageScore: number | null
		distribution: Record<"high" | "medium" | "low", number>
		contradictionCount: number
		staleCount: number
		exactCount: number
		sourceDiversity: "single" | "multi" | "none"
	}
	plan?: { paths: string[]; confidence: string; reasoning: string }
}

/** Full response from `searchDetailed`. */
export type MemongoSearchDetailedResponse = {
	results: MemongoSearchDetailedResult[]
	metadata: MemongoSearchDetailedMetadata
}

export type MemongoActiveSlateItem = {
	kind: string
	source: string
	title: string
	summary: string
	path: string
	canonicalId?: string
	timestamp?: string
	scope?: string
	scopeRef?: string
	state?: string
	salience?: string
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
}

export type MemongoActiveSlateResponse = {
	agentId: string
	scope: string
	scopeRef: string
	items: MemongoActiveSlateItem[]
	metadata: {
		maxItems: number
		truncated: boolean
		partial: boolean
		countsByKind: Record<string, number>
		sourceCounts: Record<string, number>
	}
	hydratedAt: string
}

export type MemongoMemoryBlockLabel =
	| "working-memory"
	| "decisions"
	| "preferences"
	| "todos"
	| "procedures"

export type MemongoMemoryBlock = {
	label: MemongoMemoryBlockLabel
	title: string
	content: string
	tokenBudget: number
	actualTokens: number
	sourcePaths: string[]
}

export type MemongoMemoryBlocksResponse = {
	blocks: MemongoMemoryBlock[]
	totalTokenBudget: number
	totalActualTokens: number
}

export type MemongoDiscoveryProjectionResponse = {
	kind: string
	query?: string
	title: string
	summary: string
	scope: string
	scopeRef: string
	sections: Array<{
		title: string
		summary: string
		evidence: Array<{
			title: string
			summary: string
			path: string
			source: string
			canonicalId?: string
			timestamp?: string
			scope?: string
			scopeRef?: string
			sourceEventIds?: string[]
		}>
	}>
	metadata: {
		partial: boolean
		evidenceCount: number
		sourceCounts: Record<string, number>
		timeRange?: {
			label: string
			start: string
			end: string
		}
	}
	builtAt: string
}

export type MemongoContextBundleSectionItem = {
	title: string
	summary: string
	path?: string
	source?: string
	canonicalId?: string
	timestamp?: string
	scope?: string
	scopeRef?: string
	sourceEventIds?: string[]
	trust?: {
		score: number
		confidence: "high" | "medium" | "low"
		exactness: "exact-id" | "exact-locator" | "approximate"
		freshness: "fresh" | "aging" | "stale" | "timeless" | "unknown"
		contradiction: "none" | "conflicted" | "invalidated"
		scopeMatch: "exact" | "partial" | "unknown" | "mismatch"
		provenance: "dense" | "partial" | "sparse" | "none"
		sourceDiversity: "single" | "multi"
		factors: string[]
	}
	metadata?: Record<string, unknown>
}

export type MemongoContextBundleResponse = {
	agentId: string
	query?: string
	scope: string
	scopeRef: string
	sessionId?: string
	rendered: string
	sections: Array<{
		kind:
			| "active-slate"
			| "query-evidence"
			| "summary"
			| "recent-events"
			| "discovery-projection"
			| "profile"
		title: string
		summary?: string
		items: MemongoContextBundleSectionItem[]
		estimatedTokens: number
		truncated: boolean
		partial: boolean
	}>
	metadata: {
		tokenBudget: number
		estimatedTokensUsed: number
		partial: boolean
		truncated: boolean
		pathsExecuted: string[]
		trustSummary?: {
			topScore: number | null
			topConfidence: "high" | "medium" | "low" | null
			averageScore: number | null
			distribution: Record<"high" | "medium" | "low", number>
			contradictionCount: number
			staleCount: number
			exactCount: number
			sourceDiversity: "single" | "multi" | "none"
		}
		sectionsIncluded: Array<
			| "active-slate"
			| "query-evidence"
			| "summary"
			| "recent-events"
			| "discovery-projection"
			| "profile"
		>
	}
	builtAt: string
}

export type MemongoStateResponse = {
	profile: MemongoProfileResponse
	blocks: MemongoMemoryBlocksResponse
	bundle: MemongoContextBundleResponse
	partial?: boolean
}

/** HTTP client for the supported Memongo API surface. */
export class MemongoClient {
	constructor(private readonly _opts: MemongoClientOptions = {}) {}

	async add(
		input: MemongoAddInput,
	): Promise<{ ok: true; eventId: string; chunkCreated: boolean }> {
		return apiPost(this._opts, "/v1/add", {
			content: input.content,
			agentId: input.agentId,
			containerTag: input.containerTag,
			sessionId: input.sessionId ?? input.containerTag,
			metadata: normalizeMetadata(input.metadata),
		})
	}

	async search(
		input: MemongoSearchInput & {
			agentId?: string
			minScore?: number
			sessionKey?: string
		},
	): Promise<MemongoSearchResponse> {
		return apiPost(this._opts, "/v1/search", {
			query: input.query,
			agentId: input.agentId,
			limit: input.limit,
			minScore: input.minScore,
			containerTag: input.containerTag,
			sessionKey: input.sessionKey ?? input.containerTag,
		})
	}

	async searchDetailed(input: {
		query: string
		agentId?: string
		limit?: number
		maxResults?: number
		minScore?: number
		searchMode?: "auto" | "direct" | "agentic"
		sourcePreference?: string[]
		timeRange?: { preset?: string; start?: string; end?: string }
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
		searchConfig?: SearchConfig
		/** @deprecated This legacy alias is ignored by the canonical detailed search path. */
		containerTag?: string
	}): Promise<MemongoSearchDetailedResponse> {
		return apiPost(this._opts, "/v1/search-detailed", {
			query: input.query,
			agentId: input.agentId,
			limit: input.limit,
			maxResults: input.maxResults,
			minScore: input.minScore,
			searchMode: input.searchMode,
			sourcePreference: input.sourcePreference,
			timeRange: input.timeRange,
			needExactEvidence: input.needExactEvidence,
			maxPasses: input.maxPasses,
			returnPlan: input.returnPlan,
			conversationScope: input.conversationScope,
			structuredScope: input.structuredScope,
			referenceScope: input.referenceScope,
			proceduralScope: input.proceduralScope,
			searchConfig: input.searchConfig,
		})
	}

	async searchKB(input: {
		query: string
		agentId?: string
		limit?: number
		minScore?: number
		filter?: { tags?: string[]; category?: string; source?: string }
	}): Promise<MemongoSearchKBResponse> {
		return apiPost(this._opts, "/v1/search-kb", {
			query: input.query,
			agentId: input.agentId,
			limit: input.limit,
			minScore: input.minScore,
			filter: input.filter,
		})
	}

	async recallConversation(
		input: MemongoConversationRecallInput = {},
	): Promise<MemongoConversationRecallResponse> {
		return apiPost(this._opts, "/v1/recall-conversation", {
			query: input.query,
			sessionId: input.sessionId,
			roles: input.roles,
			startTime: input.startTime,
			endTime: input.endTime,
			timezone: input.timezone,
			includeToolMessages: input.includeToolMessages,
			limit: input.limit,
			agentId: input.agentId,
		})
	}

	async getLifecycleItem(
		input: MemongoLifecycleGetInput,
	): Promise<MemongoLifecycleItem> {
		return apiPost(this._opts, "/v1/lifecycle/get", {
			handle: input.handle,
		})
	}

	async updateLifecycleItem(
		input: MemongoLifecycleUpdateInput,
	): Promise<MemongoLifecycleItem> {
		return apiPost(this._opts, "/v1/lifecycle/update", {
			handle: input.handle,
			patch: input.patch,
		})
	}

	async deleteLifecycleItem(
		input: MemongoLifecycleDeleteInput,
	): Promise<MemongoLifecycleItem> {
		return apiPost(this._opts, "/v1/lifecycle/delete", {
			handle: input.handle,
			invalidatedBy: input.invalidatedBy,
		})
	}

	async getLifecycleHistory(
		input: MemongoLifecycleHistoryInput,
	): Promise<MemongoLifecycleHistoryEntry[]> {
		return apiPost(this._opts, "/v1/lifecycle/history", {
			handle: input.handle,
			limit: input.limit,
		})
	}

	async reportProcedureOutcome(
		input: MemongoProcedureOutcomeInput,
	): Promise<MemongoLifecycleItem> {
		return apiPost(this._opts, "/v1/procedures/outcome", {
			handle: input.handle,
			success: input.success,
			note: input.note,
			actorRole: input.actorRole,
		})
	}

	async applyMemoryFeedback(
		input: MemongoMemoryFeedbackInput,
	): Promise<MemongoLifecycleItem> {
		return apiPost(this._opts, "/v1/memory/feedback", {
			handle: input.handle,
			signal: input.signal,
			...(input.signal === "correct" ? { patch: input.patch } : {}),
			...(input.signal === "irrelevant" && input.invalidatedBy
				? { invalidatedBy: input.invalidatedBy }
				: {}),
			note: input.note,
			actorRole: input.actorRole,
		})
	}

	async readFile(input: {
		relPath: string
		from?: number
		lines?: number
		agentId?: string
	}): Promise<MemongoReadFileResponse> {
		return apiPost(this._opts, "/v1/read-file", {
			relPath: input.relPath,
			from: input.from,
			lines: input.lines,
			agentId: input.agentId,
		})
	}

	async writeEvent(input: {
		role: "user" | "assistant" | "system" | "tool"
		body: string
		agentId?: string
		sessionId?: string
		timestamp?: string
		metadata?: Record<string, unknown>
		scope?: string
	}): Promise<{ ok: true; eventId: string; chunkCreated: boolean }> {
		return apiPost(this._opts, "/v1/write-event", {
			role: input.role,
			body: input.body,
			agentId: input.agentId,
			sessionId: input.sessionId,
			timestamp: input.timestamp,
			metadata: input.metadata,
			scope: input.scope,
		})
	}

	async writeStructured(input: {
		entry: Record<string, unknown>
		agentId?: string
	}): Promise<{ upserted: boolean; id: string }> {
		return apiPost(this._opts, "/v1/write-structured", {
			entry: input.entry,
			agentId: input.agentId,
		})
	}

	async writeProcedure(input: {
		entry: Record<string, unknown>
		agentId?: string
	}): Promise<{ upserted: boolean; id: string }> {
		return apiPost(this._opts, "/v1/write-procedure", {
			entry: input.entry,
			agentId: input.agentId,
		})
	}

	async extract(input: MemongoExtractInput): Promise<MemongoExtractResponse> {
		return apiPost(this._opts, "/v1/extract", {
			eventId: input.eventId,
			agentId: input.agentId,
		})
	}

	async profile(
		input: MemongoProfileInput & {
			agentId?: string
			scopeRef?: string
			maxEntities?: number
			maxEpisodes?: number
			maxPerType?: number
			activityWindowMs?: number
		} = {},
	): Promise<MemongoProfileResponse> {
		return apiPost(this._opts, "/v1/profile", {
			agentId: input.agentId,
			containerTag: input.containerTag,
			scope: input.scope,
			scopeRef: input.scopeRef ?? input.containerTag,
			maxEntities: input.maxEntities,
			maxEpisodes: input.maxEpisodes,
			maxPerType: input.maxPerType,
			activityWindowMs: input.activityWindowMs,
		})
	}

	async hydrateActiveSlate(
		input: MemongoActiveSlateInput = {},
	): Promise<MemongoActiveSlateResponse> {
		return apiPost(this._opts, "/v1/hydrate-active-slate", {
			agentId: input.agentId,
			scope: input.scope,
			scopeRef: input.scopeRef,
			maxItems: input.maxItems,
		})
	}

	async state(
		input: MemongoActiveSlateInput = {},
	): Promise<MemongoStateResponse> {
		return apiGet(
			this._opts,
			`/v1/state${q(input.agentId, {
				scope: input.scope,
				scopeRef: input.scopeRef,
			})}`,
		)
	}

	async buildDiscoveryProjection(
		input: MemongoDiscoveryProjectionInput,
	): Promise<MemongoDiscoveryProjectionResponse> {
		return apiPost(this._opts, "/v1/discovery-projection", {
			agentId: input.agentId,
			kind: input.kind,
			query: input.query,
			scope: input.scope,
			scopeRef: input.scopeRef,
			maxItems: input.maxItems,
			timeRange: input.timeRange,
		})
	}

	async buildContextBundle(
		input: MemongoContextBundleInput = {},
	): Promise<MemongoContextBundleResponse> {
		return apiPost(this._opts, "/v1/context-bundle", {
			agentId: input.agentId,
			query: input.query,
			scope: input.scope,
			scopeRef: input.scopeRef,
			sessionId: input.sessionId,
			tokenBudget: input.tokenBudget,
			maxActiveItems: input.maxActiveItems,
			maxEvidenceItems: input.maxEvidenceItems,
			maxRecentEvents: input.maxRecentEvents,
			includeDiscoveryProjection: input.includeDiscoveryProjection,
			discoveryKind: input.discoveryKind,
			includeProfile: input.includeProfile,
			timeRange: input.timeRange,
			mode: input.mode,
		})
	}

	async status(agentId?: string): Promise<MemongoStatusResponse> {
		return apiGet(this._opts, `/v1/status${q(agentId)}`)
	}

	async getDetailedStatus(
		agentId?: string,
	): Promise<MemongoDetailedStatusResponse> {
		return apiGet(this._opts, `/v1/status/detailed${q(agentId)}`)
	}

	async stats(agentId?: string): Promise<MemongoStatsResponse> {
		return apiGet(this._opts, `/v1/stats${q(agentId)}`)
	}

	async sync(input?: {
		agentId?: string
		reason?: string
		force?: boolean
	}): Promise<{ ok: true }> {
		return apiPost(this._opts, "/v1/sync", {
			agentId: input?.agentId,
			reason: input?.reason,
			force: input?.force,
		})
	}

	async probeEmbedding(
		agentId?: string,
	): Promise<MemongoProbeEmbeddingResponse> {
		return apiGet(this._opts, `/v1/probes/embedding${q(agentId)}`)
	}

	async probeVector(agentId?: string): Promise<{ ok: boolean }> {
		return apiGet(this._opts, `/v1/probes/vector${q(agentId)}`)
	}

	async relevanceExplain(input: {
		query: string
		agentId?: string
		sourceScope?: "all" | "memory" | "kb" | "structured"
		sessionKey?: string
		maxResults?: number
		minScore?: number
		deep?: boolean
	}): Promise<MemongoRelevanceExplainResponse> {
		return apiPost(this._opts, "/v1/admin/relevance/explain", {
			query: input.query,
			agentId: input.agentId,
			sourceScope: input.sourceScope,
			sessionKey: input.sessionKey,
			maxResults: input.maxResults,
			minScore: input.minScore,
			deep: input.deep,
		})
	}

	async relevanceBenchmark(input?: {
		agentId?: string
		datasetPath?: string
		maxResults?: number
		minScore?: number
		retrievalLane?: "native" | "raw-session"
	}): Promise<MemongoRelevanceBenchmarkResponse> {
		return apiPost(this._opts, "/v1/admin/relevance/benchmark", {
			agentId: input?.agentId,
			datasetPath: input?.datasetPath,
			maxResults: input?.maxResults,
			minScore: input?.minScore,
			retrievalLane: input?.retrievalLane,
		})
	}

	async benchmarkIngest(input: {
		datasetPath: string
		agentId?: string
		scope?: "session" | "user" | "agent" | "workspace" | "tenant" | "global"
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemongoBenchmarkIngestResponse> {
		return apiPost(this._opts, "/v1/admin/benchmarks/ingest", {
			datasetPath: input.datasetPath,
			agentId: input.agentId,
			scope: input.scope,
			limitConversations: input.limitConversations,
			limitTurnsPerConversation: input.limitTurnsPerConversation,
		})
	}

	async importConversations(
		input: MemongoConversationImportInput,
	): Promise<MemongoConversationImportResponse> {
		return apiPost(this._opts, "/v1/import/conversations", {
			datasetPath: input.datasetPath,
			agentId: input.agentId,
			scope: input.scope,
			limitConversations: input.limitConversations,
			limitTurnsPerConversation: input.limitTurnsPerConversation,
		})
	}

	async relevanceReport(
		agentId?: string,
		windowMs?: number,
	): Promise<MemongoRelevanceReportResponse> {
		return apiGet(
			this._opts,
			`/v1/admin/relevance/report${q(agentId, { windowMs })}`,
		)
	}

	async relevanceSampleRate(
		agentId?: string,
	): Promise<MemongoRelevanceSampleRateResponse> {
		return apiGet(this._opts, `/v1/admin/relevance/sample-rate${q(agentId)}`)
	}

	async accessTrends(input?: {
		agentId?: string
		collection?:
			| "events"
			| "structured_mem"
			| "procedures"
			| "episodes"
			| "entities"
			| "relations"
		memoryIds?: string[]
		windowDays?: number
		limit?: number
	}): Promise<MemongoAccessTrendResponse> {
		return apiGet(
			this._opts,
			`/v1/admin/access-trends${q(input?.agentId, {
				collection: input?.collection,
				memoryIds: input?.memoryIds?.join(","),
				windowDays: input?.windowDays,
				limit: input?.limit,
			})}`,
		)
	}

	async accessSummaries(input: {
		agentId?: string
		collection:
			| "events"
			| "structured_mem"
			| "procedures"
			| "episodes"
			| "entities"
			| "relations"
		memoryIds: string[]
		windowDays?: number
	}): Promise<MemongoAccessSummaryResponse> {
		return apiGet(
			this._opts,
			`/v1/admin/access-summaries${q(input.agentId, {
				collection: input.collection,
				memoryIds: input.memoryIds.join(","),
				windowDays: input.windowDays,
			})}`,
		)
	}

	async listRecallTraces(input?: {
		agentId?: string
		limit?: number
	}): Promise<MemongoRecallTrace[]> {
		return apiGet(
			this._opts,
			`/v1/admin/traces${q(input?.agentId, { limit: input?.limit })}`,
		)
	}

	async getRecallTrace(input: {
		traceId: string
		agentId?: string
	}): Promise<MemongoRecallTrace | null> {
		return apiGet(
			this._opts,
			`/v1/admin/traces/${encodeURIComponent(input.traceId)}${q(input.agentId)}`,
		)
	}

	async listJobs(input?: {
		agentId?: string
		status?: MemongoMemoryJobStatus
		limit?: number
		jobType?: MemongoMemoryJobType
	}): Promise<MemongoMemoryJob[]> {
		return apiGet(
			this._opts,
			`/v1/jobs${q(input?.agentId, {
				status: input?.status,
				limit: input?.limit,
				jobType: input?.jobType,
			})}`,
		)
	}

	async getJob(input: {
		jobId: string
		agentId?: string
	}): Promise<MemongoMemoryJob | null> {
		return apiGet(
			this._opts,
			`/v1/jobs/${encodeURIComponent(input.jobId)}${q(input.agentId)}`,
		)
	}

	async traceChain(
		input: MemongoTraceChainInput,
	): Promise<MemongoTraceChainResponse> {
		return apiPost(this._opts, "/v1/chain-trace", {
			factId: input.factId,
			collection: input.collection,
			agentId: input.agentId,
			maxDepth: input.maxDepth,
		})
	}

	async scanNovelty(
		input?: MemongoScanNoveltyInput,
	): Promise<MemongoNoveltyResponse> {
		return apiPost(this._opts, "/v1/novelty-scan", {
			agentId: input?.agentId,
			limit: input?.limit,
			scope: input?.scope,
		})
	}

	async consolidate(
		input?: MemongoConsolidateInput,
	): Promise<MemongoConsolidateResponse> {
		return apiPost(this._opts, "/v1/consolidate", {
			agentId: input?.agentId,
			maxEvents: input?.maxEvents,
			minCombinedScore: input?.minCombinedScore,
			scope: input?.scope,
		})
	}

	async selfEdit(
		input: MemongoSelfEditInput,
	): Promise<MemongoSelfEditResponse> {
		return apiPost(this._opts, "/v1/self-edit", {
			block: input.block,
			action: input.action,
			content: input.content,
			agentId: input.agentId,
		})
	}
}

function normalizeMetadata(
	meta: MemongoAddInput["metadata"],
): Record<string, unknown> | undefined {
	if (!meta) {
		return undefined
	}
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(meta)) {
		out[k] = v
	}
	return out
}
