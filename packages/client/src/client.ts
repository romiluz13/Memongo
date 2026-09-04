import type {
	MemongoAddInput,
	MemongoAccessSummaryResponse,
	MemongoAccessTrendResponse,
	MemongoActiveSlateInput,
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
	MemongoEraseAgentResponse,
	MemongoExtractInput,
	MemongoExtractResponse,
	MemongoQuarantinedMemory,
	MemongoQuarantineReviewReceipt,
	MemongoQuarantineStatus,
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
	MemongoRelevanceExplainResponse,
	MemongoRelevanceReportResponse,
	MemongoRelevanceSampleRateResponse,
	MemongoProcedureOutcomeInput,
	MemongoRecallTrace,
	MemongoScanNoveltyInput,
	MemongoScope,
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
	MemongoQuarantineDisposition,
	MemongoWriteEventsResponse,
} from "./types.js"
import { MEMONGO_CLIENT_VERSION } from "./version.js"

export type MemongoClientOptions = {
	/** Memongo API base URL (e.g. http://127.0.0.1:3847). */
	baseUrl?: string
	/** Optional Bearer token; also reads `MEMONGO_API_KEY` when unset. */
	apiKey?: string
	/** Max retries for 429/503 (default 2). */
	maxRetries?: number
	/** Per-request timeout in ms (default 30_000). */
	timeoutMs?: number
	/**
	 * When true, search/read calls resolve to a benign empty result instead of
	 * throwing on HTTP errors, timeouts, or network failures — so callers like
	 * prompt middleware can inject "no memory" instead of breaking the request.
	 * Strictly opt-in: the default (throwing `MemongoClientError`) is unchanged.
	 */
	silent?: boolean
}

/**
 * Parse the API's `{error:{code,message}}` envelope (P0.8). Returns undefined
 * fields for non-envelope bodies (plain text, proxies, older servers).
 */
function parseErrorEnvelope(body: string): {
	code?: string
	message?: string
} {
	try {
		const parsed = JSON.parse(body) as {
			error?: { code?: unknown; message?: unknown }
		}
		const err = parsed?.error
		if (err && typeof err === "object") {
			return {
				code: typeof err.code === "string" ? err.code : undefined,
				message: typeof err.message === "string" ? err.message : undefined,
			}
		}
	} catch {
		// Not a JSON envelope — fall through with empty fields.
	}
	return {}
}

/** Thrown when the Memongo HTTP API returns a non-OK status. */
export class MemongoClientError extends Error {
	readonly status: number
	readonly body: string
	/** Deliberate error code from the API envelope (e.g. "VALIDATION_ERROR"). */
	readonly code?: string
	/** Human-readable message from the API envelope. */
	readonly apiMessage?: string

	constructor(status: number, body: string, message?: string) {
		const envelope = parseErrorEnvelope(body)
		super(
			message ??
				(envelope.message
					? `Memongo API ${status}${envelope.code ? ` ${envelope.code}` : ""}: ${envelope.message}`
					: // C-002: non-envelope bodies come from proxies and raw 500s
						// that can echo request content (queries, credentials).
						// The message stays structural; the raw body remains
						// available on the `body` property for programmatic use.
						body
						? `Memongo API ${status} (non-JSON body, ${body.length} bytes)`
						: `Memongo API ${status} (empty body)`),
		)
		this.name = "MemongoClientError"
		this.status = status
		this.body = body
		this.code = envelope.code
		this.apiMessage = envelope.message
	}
}

/** process.env is absent in browser/edge runtimes — guard every read. */
function readEnv(name: string): string | undefined {
	return typeof process !== "undefined" ? process.env?.[name] : undefined
}

function resolveBaseUrl(opts: MemongoClientOptions): string {
	const raw =
		opts.baseUrl ?? readEnv("MEMONGO_API_URL") ?? "http://127.0.0.1:3847"
	return raw.replace(/\/$/, "")
}

function resolveApiKey(opts: MemongoClientOptions): string | undefined {
	return opts.apiKey ?? readEnv("MEMONGO_API_KEY") ?? undefined
}

function shouldRetryStatus(status: number): boolean {
	return status === 429 || status === 503
}

/**
 * Hard ceiling for server-supplied Retry-After hints so a hostile or buggy
 * server cannot park the client for minutes.
 */
const MAX_RETRY_DELAY_MS = 10_000

/**
 * Read the Retry-After header (seconds or HTTP-date per RFC 9110), capped at
 * MAX_RETRY_DELAY_MS. Returns undefined when absent or unparseable.
 */
function retryAfterDelayMs(res: Response): number | undefined {
	const raw = res.headers.get("Retry-After")
	if (!raw) {
		return undefined
	}
	const seconds = Number(raw)
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
	}
	const dateMs = Date.parse(raw)
	if (!Number.isNaN(dateMs)) {
		return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_DELAY_MS)
	}
	return undefined
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

/** Normalize a HeadersInit into a plain record for header inspection. */
function headersToRecord(
	headers: RequestInit["headers"],
): Record<string, string> {
	if (!headers) {
		return {}
	}
	if (headers instanceof Headers) {
		const out: Record<string, string> = {}
		headers.forEach((value, key) => {
			out[key] = value
		})
		return out
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers)
	}
	// The ambient HeadersInit record type allows string[] values; join them
	// the same way Headers would when flattening to a single value.
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		out[key] = typeof value === "string" ? value : [...value].join(", ")
	}
	return out
}

/**
 * WS-08 / C-011: a 429/503 retry is only safe when the request is
 * idempotent by construction — GET/HEAD (no side effects), or a POST that
 * carries an Idempotency-Key (the server replays return the original
 * receipt instead of writing twice). Retrying any other POST could
 * double-write memory, so those now fail fast with the server's error.
 */
function isRetrySafeRequest(
	method: string,
	headers: Record<string, string>,
): boolean {
	if (method === "GET" || method === "HEAD") {
		return true
	}
	return headers["Idempotency-Key"] !== undefined
}

function buildHeaders(
	opts: MemongoClientOptions,
	method: string,
): Record<string, string> {
	const key = resolveApiKey(opts)
	const headers: Record<string, string> = {
		// Version telemetry: lets the server log client/server version skew.
		"x-memongo-client-version": MEMONGO_CLIENT_VERSION,
	}
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
	/** WS-08 / C-011: override for POSTs idempotent by construction. */
	retrySafeOverride?: boolean,
): Promise<T> {
	const url = `${resolveBaseUrl(opts)}${path}`
	const method = (init.method ?? "GET").toUpperCase()
	const maxRetries = opts.maxRetries ?? 2
	const timeoutMs = opts.timeoutMs ?? 30_000
	// Merge caller headers once so the retry-safety predicate and every
	// attempt see the exact same header set.
	const mergedHeaders = {
		...buildHeaders(opts, method),
		...headersToRecord(init.headers),
	}
	const retrySafe =
		retrySafeOverride ?? isRetrySafeRequest(method, mergedHeaders)
	let attempt = 0
	for (;;) {
		const timeoutSignal = AbortSignal.timeout(timeoutMs)
		const signal = init.signal
			? AbortSignal.any([init.signal, timeoutSignal])
			: timeoutSignal
		const res = await fetch(url, {
			...init,
			signal,
			headers: mergedHeaders,
		})
		if (res.ok) {
			return (await res.json()) as T
		}
		const text = await res.text()
		// WS-08 / C-011: only retry idempotent-by-construction requests; a
		// non-idempotent POST fails fast so it can never double-write.
		if (retrySafe && shouldRetryStatus(res.status) && attempt < maxRetries) {
			attempt += 1
			// The server's Retry-After (set on 429) wins over local backoff, capped.
			await sleep(retryAfterDelayMs(res) ?? 200 * attempt)
			continue
		}
		throw new MemongoClientError(res.status, text)
	}
}

async function apiPost<T>(
	opts: MemongoClientOptions,
	path: string,
	body: Record<string, unknown>,
	headers?: Record<string, string>,
	retrySafeOverride?: boolean,
): Promise<T> {
	return apiFetch<T>(
		opts,
		path,
		{
			method: "POST",
			body: JSON.stringify(body),
			...(headers ? { headers } : {}),
		},
		retrySafeOverride,
	)
}

/**
 * Stripe-style client-generated idempotency keys: opaque UUIDv4, generated
 * once per logical write and reused across every retry of that call so the
 * server can dedup instead of double-writing. WebCrypto first (Node 20+ and
 * every modern browser expose it); Math.random fallback only for exotic
 * runtimes where crypto is absent.
 */
function generateIdempotencyKey(): string {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID()
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = Math.floor(Math.random() * 16)
		return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16)
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

/** Metadata shell for a silent-mode empty `searchDetailed` response. */
const EMPTY_DETAILED_METADATA: MemongoSearchDetailedMetadata = {
	mode: "auto",
	classification: "none",
	sourceOrder: [],
	passes: [],
	queriesTried: [],
	constraintsApplied: [],
	resultsRejected: [],
	evidenceCoverage: "none",
	pathsExecuted: [],
	resultsByPath: {},
	queryRewritten: false,
	reranked: false,
}

/** Benign empty bundle for silent mode: `rendered: ""` injects nothing. */
function emptyContextBundle(
	input: MemongoContextBundleInput,
): MemongoContextBundleResponse {
	return {
		agentId: input.agentId ?? "",
		...(input.query ? { query: input.query } : {}),
		scope: input.scope ?? "agent",
		scopeRef: input.scopeRef ?? "",
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		rendered: "",
		sections: [],
		metadata: {
			tokenBudget: 0,
			estimatedTokensUsed: 0,
			partial: true,
			truncated: false,
			pathsExecuted: [],
			sectionsIncluded: [],
		},
		builtAt: new Date(0).toISOString(),
	}
}

/** HTTP client for the supported Memongo API surface. */
export class MemongoClient {
	constructor(private readonly _opts: MemongoClientOptions = {}) {}

	/**
	 * silent-mode wrapper: search/read calls degrade to `empty` on any failure
	 * (HTTP error, timeout, network). Writes never use this — a swallowed write
	 * would look like data loss that never happened.
	 */
	private async _silently<T>(empty: T, call: () => Promise<T>): Promise<T> {
		if (!this._opts.silent) {
			return call()
		}
		try {
			return await call()
		} catch {
			return empty
		}
	}

	async add(
		input: MemongoAddInput,
	): Promise<{ ok: true; eventId: string; chunkCreated: boolean }> {
		// One key per logical write, stable across this call's retries (P0.1).
		const idempotencyKey = input.customId ?? generateIdempotencyKey()
		return apiPost(
			this._opts,
			"/v1/add",
			{
				content: input.content,
				agentId: input.agentId,
				containerTag: input.containerTag,
				sessionId: input.sessionId ?? input.containerTag,
				metadata: normalizeMetadata(input.metadata),
				entityContext: input.entityContext,
				scope: input.scope,
				scopeRef: input.scopeRef,
				customId: idempotencyKey,
				expiresAt: input.expiresAt,
			},
			{ "Idempotency-Key": idempotencyKey },
		)
	}

	async search(
		input: MemongoSearchInput & {
			agentId?: string
			minScore?: number
			sessionKey?: string
		},
	): Promise<MemongoSearchResponse> {
		return this._silently<MemongoSearchResponse>({ results: [] }, () =>
			apiPost(this._opts, "/v1/search", {
				query: input.query,
				agentId: input.agentId,
				limit: input.limit,
				minScore: input.minScore,
				containerTag: input.containerTag,
				sessionKey: input.sessionKey ?? input.containerTag,
				scope: input.scope,
				scopeRef: input.scopeRef,
			}),
		)
	}

	async searchDetailed(input: {
		query: string
		agentId?: string
		scope?: MemongoScope
		scopeRef?: string
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
		return this._silently<MemongoSearchDetailedResponse>(
			{ results: [], metadata: EMPTY_DETAILED_METADATA },
			() =>
				apiPost(this._opts, "/v1/search-detailed", {
					query: input.query,
					agentId: input.agentId,
					scope: input.scope,
					scopeRef: input.scopeRef,
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
				}),
		)
	}

	async searchKB(input: {
		query: string
		agentId?: string
		scope?: MemongoScope
		scopeRef?: string
		limit?: number
		minScore?: number
		filter?: { tags?: string[]; category?: string; source?: string }
		/** Server-side fusion preference for the KB lane (P0.10). */
		fusionMethod?: "scoreFusion" | "rankFusion" | "js-merge"
	}): Promise<MemongoSearchKBResponse> {
		return this._silently<MemongoSearchKBResponse>({ results: [] }, () =>
			apiPost(this._opts, "/v1/search-kb", {
				query: input.query,
				agentId: input.agentId,
				scope: input.scope,
				scopeRef: input.scopeRef,
				limit: input.limit,
				minScore: input.minScore,
				filter: input.filter,
				fusionMethod: input.fusionMethod,
			}),
		)
	}

	async recallConversation(
		input: MemongoConversationRecallInput = {},
	): Promise<MemongoConversationRecallResponse> {
		return this._silently<MemongoConversationRecallResponse>(
			{
				results: [],
				metadata: {
					totalMatched: 0,
					filtersApplied: [],
					searchMethod: "standard",
					durationMs: 0,
				},
			},
			() =>
				apiPost(this._opts, "/v1/recall-conversation", {
					query: input.query,
					sessionId: input.sessionId,
					roles: input.roles,
					startTime: input.startTime,
					endTime: input.endTime,
					asOf: input.asOf,
					timezone: input.timezone,
					includeToolMessages: input.includeToolMessages,
					limit: input.limit,
					agentId: input.agentId,
					scope: input.scope,
					scopeRef: input.scopeRef,
				}),
		)
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
	): Promise<MemongoLifecycleItem & MemongoQuarantineDisposition> {
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
	): Promise<MemongoLifecycleItem & MemongoQuarantineDisposition> {
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
		return this._silently<MemongoReadFileResponse>(
			{ text: "", path: input.relPath },
			() =>
				apiPost(this._opts, "/v1/read-file", {
					relPath: input.relPath,
					from: input.from,
					lines: input.lines,
					agentId: input.agentId,
				}),
		)
	}

	async writeEvent(input: {
		role: "user" | "assistant" | "system" | "tool"
		body: string
		agentId?: string
		sessionId?: string
		timestamp?: string
		validAt?: string
		invalidAt?: string
		metadata?: Record<string, unknown>
		scope?: MemongoScope
		scopeRef?: string
		/** Idempotency key; a UUIDv4 is generated when omitted. */
		customId?: string
		/** Absolute expiry instant (ISO 8601, must be future); P4.4.1 TTL. */
		expiresAt?: string
	}): Promise<{ ok: true; eventId: string; chunkCreated: boolean }> {
		// One key per logical write, stable across this call's retries (P0.1).
		const idempotencyKey = input.customId ?? generateIdempotencyKey()
		return apiPost(
			this._opts,
			"/v1/write-event",
			{
				role: input.role,
				body: input.body,
				agentId: input.agentId,
				sessionId: input.sessionId,
				timestamp: input.timestamp,
				validAt: input.validAt,
				invalidAt: input.invalidAt,
				metadata: input.metadata,
				scope: input.scope,
				scopeRef: input.scopeRef,
				customId: idempotencyKey,
				expiresAt: input.expiresAt,
			},
			{ "Idempotency-Key": idempotencyKey },
		)
	}

	/**
	 * P3.9: bulk variant of writeEvent — one POST writes the whole batch
	 * through the server's amortized insertMany/bulkWrite path and returns
	 * per-item receipts mirroring the single-write receipt shape. Each item
	 * gets its own idempotency key (customId, or a generated UUIDv4 stable
	 * across this call's retries); a failed item never fails the batch.
	 */
	async writeEvents(input: {
		events: Array<{
			role: "user" | "assistant" | "system" | "tool"
			body: string
			sessionId?: string
			timestamp?: string
			validAt?: string
			invalidAt?: string
			metadata?: Record<string, unknown>
			scope?: MemongoScope
			scopeRef?: string
			/** Per-item idempotency key; a UUIDv4 is generated when omitted. */
			customId?: string
			/** Absolute expiry instant (ISO 8601, must be future); P4.4.1 TTL. */
			expiresAt?: string
		}>
		agentId?: string
	}): Promise<MemongoWriteEventsResponse> {
		return apiPost(
			this._opts,
			"/v1/write-events",
			{
				events: input.events.map((event) => ({
					role: event.role,
					body: event.body,
					sessionId: event.sessionId,
					timestamp: event.timestamp,
					validAt: event.validAt,
					invalidAt: event.invalidAt,
					metadata: event.metadata,
					scope: event.scope,
					scopeRef: event.scopeRef,
					customId: event.customId ?? generateIdempotencyKey(),
					expiresAt: event.expiresAt,
				})),
				agentId: input.agentId,
			},
			undefined,
			// WS-08 / C-011: the batch carries no Idempotency-Key header, but
			// every item carries its own key, and the server turns per-item
			// replays into receipt entries — a retried batch can never
			// double-write, so it stays retry-safe.
			true,
		)
	}

	async writeStructured(input: {
		entry: Record<string, unknown>
		agentId?: string
	}): Promise<{
		upserted: boolean
		id: string
		/** C-008: true when the write was quarantined pending human review. */
		quarantined?: boolean
		/** C-008: matched injection-pattern ids, present iff quarantined. */
		matchedPatterns?: string[]
	}> {
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
			scope: input.scope,
			scopeRef: input.scopeRef,
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
		return this._silently<MemongoContextBundleResponse>(
			emptyContextBundle(input),
			() =>
				apiPost(this._opts, "/v1/context-bundle", {
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
				}),
		)
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

	/**
	 * C-003: irreversible tenant erasure. The literal `confirm: "erase"` is
	 * required — the API rejects anything else with a 400.
	 */
	async eraseAgent(input: {
		confirm: "erase"
		agentId?: string
	}): Promise<MemongoEraseAgentResponse> {
		return apiPost(this._opts, "/v1/admin/erase", {
			confirm: input.confirm,
			agentId: input.agentId,
		})
	}

	/**
	 * C-004: list quarantined memories (oldest first). Unset `status` lists
	 * every stage so a review surface can show decided history alongside the
	 * pending queue.
	 */
	async listQuarantined(input?: {
		agentId?: string
		status?: MemongoQuarantineStatus
		limit?: number
	}): Promise<MemongoQuarantinedMemory[]> {
		return apiGet(
			this._opts,
			`/v1/admin/quarantine${q(input?.agentId, {
				status: input?.status,
				limit: input?.limit,
			})}`,
		)
	}

	/**
	 * C-004: overrule the injection classifier and write a quarantined memory
	 * as structured memory. Irreversible for the entry (status flips to
	 * `promoted` and it leaves the TTL expiry index).
	 */
	async promoteQuarantined(input: {
		quarantineId: string
		agentId?: string
		reviewerId?: string
		reviewNotes?: string
	}): Promise<MemongoQuarantineReviewReceipt> {
		return apiPost(this._opts, "/v1/admin/quarantine/promote", {
			quarantineId: input.quarantineId,
			agentId: input.agentId,
			reviewerId: input.reviewerId,
			reviewNotes: input.reviewNotes,
		})
	}

	/**
	 * C-004: discard a quarantined memory. The row is kept as audit trail;
	 * only unreviewed entries expire via the TTL index.
	 */
	async rejectQuarantined(input: {
		quarantineId: string
		agentId?: string
		reviewerId?: string
		reviewNotes?: string
	}): Promise<MemongoQuarantineReviewReceipt> {
		return apiPost(this._opts, "/v1/admin/quarantine/reject", {
			quarantineId: input.quarantineId,
			agentId: input.agentId,
			reviewerId: input.reviewerId,
			reviewNotes: input.reviewNotes,
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

	async importConversations(
		input: MemongoConversationImportInput,
	): Promise<MemongoConversationImportResponse> {
		return apiPost(this._opts, "/v1/import/conversations", {
			datasetPath: input.datasetPath,
			agentId: input.agentId,
			scope: input.scope,
			scopeRef: input.scopeRef,
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
		try {
			return await apiGet(
				this._opts,
				`/v1/admin/traces/${encodeURIComponent(input.traceId)}${q(input.agentId)}`,
			)
		} catch (err) {
			// Type says `| null` — honor it: 404 is "absent", not an exception.
			if (err instanceof MemongoClientError && err.status === 404) {
				return null
			}
			throw err
		}
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
		try {
			return await apiGet(
				this._opts,
				`/v1/jobs/${encodeURIComponent(input.jobId)}${q(input.agentId)}`,
			)
		} catch (err) {
			// Type says `| null` — honor it: 404 is "absent", not an exception.
			if (err instanceof MemongoClientError && err.status === 404) {
				return null
			}
			throw err
		}
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
			scopeRef: input?.scopeRef,
		})
	}

	async consolidate(
		input?: MemongoConsolidateInput,
	): Promise<MemongoConsolidateResponse> {
		return apiPost(this._opts, "/v1/consolidate", {
			agentId: input?.agentId,
			maxEvents: input?.maxEvents,
			minCombinedScore: input?.minCombinedScore,
			resolveContradictions: input?.resolveContradictions,
			llmDedup: input?.llmDedup,
			scope: input?.scope,
			scopeRef: input?.scopeRef,
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
