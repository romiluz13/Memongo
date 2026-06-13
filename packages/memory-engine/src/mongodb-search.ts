import type { Collection, Document } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import { mergeHybridResultsMongoDB } from "./mongodb-hybrid.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import type {
	InternalMemoryStoredSource,
	LegacyMemorySource,
	MemorySearchResult,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:search")

export type SearchExplainTraceArtifact = {
	artifactType:
		| "searchExplain"
		| "vectorExplain"
		| "fusionExplain"
		| "scoreDetails"
		| "trace"
	summary: Record<string, unknown>
	rawExplain?: unknown
}

export type SearchExplainOptions = {
	enabled: boolean
	deep?: boolean
	includeScoreDetails?: boolean
	onArtifact?: (artifact: SearchExplainTraceArtifact) => void
}

export type SearchTraceEvent = {
	event: "method"
	method:
		| "scoreFusion"
		| "rankFusion"
		| "js-merge"
		| "vector"
		| "keyword"
		| "$text"
	ok: boolean
	message?: string
}

class SearchFallbackDisabledError extends Error {
	constructor(message: string) {
		super(`search fallback disabled: ${message}`)
		this.name = "SearchFallbackDisabledError"
	}
}

function isStrictSearchFallbackDisabled(opts: {
	strictNoFallback?: boolean
}): boolean {
	const strictEnv = process.env.MEMONGO_BENCHMARK_STRICT
	return (
		opts.strictNoFallback === true ||
		strictEnv === "1" ||
		strictEnv?.toLowerCase() === "true"
	)
}

function warnOrThrowFallback(
	opts: { strictNoFallback?: boolean },
	message: string,
): void {
	if (isStrictSearchFallbackDisabled(opts)) {
		throw new SearchFallbackDisabledError(message)
	}
	log.warn(message)
}

function shouldStopInsteadOfFallback(opts: {
	strictNoFallback?: boolean
}): boolean {
	return isStrictSearchFallbackDisabled(opts)
}

async function captureAggregateExplain(
	collection: Collection,
	pipeline: Document[],
): Promise<unknown> {
	try {
		const cursor = collection.aggregate(pipeline) as unknown as {
			explain?: (verbosity?: string) => Promise<unknown>
		}
		if (typeof cursor.explain !== "function") {
			return null
		}
		return await cursor.explain("executionStats")
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		log.debug(`aggregate explain capture failed: ${message}`)
		return null
	}
}

const SEARCH_INDEX_WARMUP_HINTS = [
	"NOT_STARTED",
	"INITIAL_SYNC",
	"BUILDING",
	"PENDING",
	"not ready to query",
	"still building",
	"while in state",
] as const

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isSearchIndexWarmupError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	const normalized = message.toUpperCase()
	return SEARCH_INDEX_WARMUP_HINTS.some((hint) =>
		hint === hint.toUpperCase()
			? normalized.includes(hint)
			: message.toLowerCase().includes(hint.toLowerCase()),
	)
}

export async function runSearchAggregateWithRetry(
	collection: Collection,
	pipeline: Document[],
	{
		maxAttempts = 5,
		initialDelayMs = 250,
	}: {
		maxAttempts?: number
		initialDelayMs?: number
	} = {},
): Promise<Document[]> {
	let attempt = 0
	let delayMs = initialDelayMs
	while (true) {
		try {
			return await collection.aggregate(pipeline).toArray()
		} catch (error) {
			if (!isSearchIndexWarmupError(error) || attempt >= maxAttempts - 1) {
				throw error
			}
			const message = error instanceof Error ? error.message : String(error)
			log.debug(
				`search index still warming; retrying aggregate in ${delayMs}ms: ${message}`,
			)
			await sleep(delayMs)
			attempt++
			delayMs = Math.min(delayMs * 2, 2_000)
		}
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mapLegacySourceToRuntime(
	source: unknown,
): MemorySearchResult["source"] {
	if (source === "structured") {
		return "structured"
	}
	if (source === "kb" || source === "memory") {
		return "reference"
	}
	return "conversation"
}

function toSearchResult(
	doc: Document,
	source: LegacyMemorySource,
): MemorySearchResult {
	const path = typeof doc.path === "string" ? doc.path : ""
	const sourceType = mapLegacySourceToRuntime(doc.source ?? source)
	const rawSourceEventIds = doc.sourceEventIds ?? doc.metadata?.sourceEventIds
	const sourceEventIds = Array.isArray(rawSourceEventIds)
		? rawSourceEventIds.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
		: undefined
	const eventId =
		path.startsWith("events/") && path.length > "events/".length
			? path.slice("events/".length).trim()
			: ""
	const score =
		typeof doc.score === "number"
			? Number(doc.score.toFixed(6))
			: typeof doc.scoreDetails?.value === "number"
				? Number(doc.scoreDetails.value.toFixed(6))
				: 0
	return {
		path,
		startLine: typeof doc.startLine === "number" ? doc.startLine : 0,
		endLine: typeof doc.endLine === "number" ? doc.endLine : 0,
		score,
		snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
		source: sourceType,
		sourceType,
		...(typeof doc.canonicalId === "string"
			? { canonicalId: doc.canonicalId }
			: eventId
				? { canonicalId: `event:${eventId}` }
				: {}),
		...(doc.timestamp instanceof Date
			? { timestamp: doc.timestamp }
			: doc.updatedAt instanceof Date
				? { timestamp: doc.updatedAt }
				: {}),
		...(typeof doc.sessionId === "string" ? { sessionId: doc.sessionId } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(sourceEventIds && sourceEventIds.length > 0
			? { sourceEventIds }
			: eventId
				? { sourceEventIds: [eventId] }
				: {}),
		...(doc.provenance && typeof doc.provenance === "object"
			? { provenance: doc.provenance as Record<string, unknown> }
			: {}),
		...(doc.scoreDetails && typeof doc.scoreDetails === "object"
			? {
					scoreDetails: doc.scoreDetails as MemorySearchResult["scoreDetails"],
				}
			: {}),
	}
}

function filterByScore(
	results: MemorySearchResult[],
	minScore: number,
): MemorySearchResult[] {
	return results.filter((r) => r.score >= minScore)
}

function filterRankFusionResults(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	// $rankFusion scores use MongoDB's RRF formula, so values are commonly
	// around 0.01-0.03 and are not comparable to vector or lexical scores.
	return results.filter((r) => r.score > 0)
}

function resolveLegacySourceFilter(
	sessionKey?: string,
): InternalMemoryStoredSource | undefined {
	const normalized = sessionKey?.trim().toLowerCase()
	if (!normalized) {
		return undefined
	}
	if (normalized === "__memory__") {
		return "memory"
	}
	if (normalized === "__sessions__") {
		return "sessions"
	}
	return undefined
}

function mergeFilters(
	...filters: Array<Document | undefined>
): Document | undefined {
	const active = filters.filter(
		(filter): filter is Document =>
			filter !== undefined && Object.keys(filter).length > 0,
	)
	if (active.length === 0) {
		return undefined
	}
	if (active.length === 1) {
		return active[0]
	}
	return { $and: active }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function buildSearchFilterClause(
	path: string,
	value: unknown,
): Document | null {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value instanceof Date
	) {
		return { equals: { path, value } }
	}
	if (Array.isArray(value)) {
		return value.length > 0 ? { in: { path, value } } : null
	}
	if (!isPlainObject(value)) {
		return null
	}
	if ("$in" in value && Array.isArray(value.$in)) {
		return value.$in.length > 0 ? { in: { path, value: value.$in } } : null
	}
	if ("$all" in value && Array.isArray(value.$all)) {
		return {
			compound: {
				filter: value.$all.map((item) => ({ equals: { path, value: item } })),
			},
		}
	}
	if ("$eq" in value) {
		return buildSearchFilterClause(path, value.$eq)
	}
	return null
}

export function splitAtlasSearchFilter(filter?: Document): {
	compoundFilter?: Document[]
	postMatch?: Document
} {
	if (!filter || Object.keys(filter).length === 0) {
		return {}
	}

	const compoundFilter: Document[] = []
	const postMatchClauses: Document[] = []

	const visit = (node: Document) => {
		for (const [key, value] of Object.entries(node)) {
			if (key === "$and" && Array.isArray(value)) {
				for (const entry of value) {
					if (isPlainObject(entry)) {
						visit(entry as Document)
					} else {
						postMatchClauses.push({ $and: value as unknown[] })
						return
					}
				}
				continue
			}

			const searchClause = buildSearchFilterClause(key, value)
			if (searchClause) {
				compoundFilter.push(searchClause)
			} else {
				postMatchClauses.push({ [key]: value })
			}
		}
	}

	visit(filter)

	return {
		...(compoundFilter.length > 0 ? { compoundFilter } : {}),
		...(postMatchClauses.length > 0
			? {
					postMatch:
						postMatchClauses.length === 1
							? postMatchClauses[0]
							: { $and: postMatchClauses },
				}
			: {}),
	}
}

function extractQuotedPhrases(query: string): string[] {
	return [...query.matchAll(/"([^"]{2,120})"|'([^']{2,120})'/g)]
		.map((match) => (match[1] ?? match[2] ?? "").trim())
		.filter(Boolean)
		.slice(0, 4)
}

function buildTextSearchShouldClauses(query: string): Document[] {
	const should: Document[] = []
	for (const phrase of extractQuotedPhrases(query)) {
		should.push({
			phrase: {
				query: phrase,
				path: "text",
				score: { boost: { value: 6 } },
			},
		})
	}
	if (
		/\b(prefer|preference|like|dislike|favorite|want|need|advice|tips?|recommend(?:ation)?s?)\b/i.test(
			query,
		)
	) {
		should.push({
			text: {
				query:
					"prefer preference like favorite want need advice recommendation",
				path: "text",
				score: { boost: { value: 2 } },
			},
		})
	}
	if (
		/\b(when|before|after|earlier|later|recent|latest|last|first|updated|changed|currently|now|timeline|session)\b/i.test(
			query,
		)
	) {
		should.push({
			text: {
				query: "session date before after recent latest updated changed",
				path: "text",
				score: { boost: { value: 1.5 } },
			},
		})
	}
	return should
}

function buildTextSearchCompound(
	query: string,
	compoundFilter?: Document[],
): Document {
	const should = buildTextSearchShouldClauses(query)
	return {
		must: [{ text: { query, path: "text" } }],
		...(compoundFilter ? { filter: compoundFilter } : {}),
		...(should.length > 0 ? { should } : {}),
	}
}

// ---------------------------------------------------------------------------
// $vectorSearch stage builder
// ---------------------------------------------------------------------------
// Memongo uses MongoDB Community automatic embeddings. Query text is sent to
// MongoDB and the server handles query-time embedding generation via autoEmbed.
// ---------------------------------------------------------------------------

/** Hard maximum for numCandidates — MongoDB server rejects values above 10,000. */
export const MONGODB_MAX_NUM_CANDIDATES = 10_000

function normalizeVectorSearchLimit(value: number): number {
	const normalized = Math.floor(value)
	if (!Number.isFinite(normalized) || normalized <= 0) {
		return 1
	}
	return Math.min(normalized, MONGODB_MAX_NUM_CANDIDATES)
}

function normalizeVectorSearchNumCandidates(params: {
	numCandidates: number
	limit: number
}): number {
	const requested = Math.floor(params.numCandidates)
	const finiteRequested =
		Number.isFinite(requested) && requested > 0 ? requested : params.limit
	return Math.min(
		Math.max(finiteRequested, params.limit),
		MONGODB_MAX_NUM_CANDIDATES,
	)
}

export function buildVectorSearchStage(input: {
	queryVector: number[] | null
	queryText: string | null
	embeddingMode: MemoryMongoDBEmbeddingMode
	indexName: string
	model?: string
	numCandidates: number
	limit: number
	filter?: Document
	textFieldPath?: string
	/** When true, uses MongoDB ENN (exact nearest neighbor): sets exact: true
	 *  and omits numCandidates per the $vectorSearch contract. */
	exact?: boolean
}): Document | null {
	const limit = normalizeVectorSearchLimit(input.limit)
	const base: Document = {
		index: input.indexName,
		limit,
	}

	// ENN mode: exact: true, no numCandidates
	if (input.exact) {
		base.exact = true
	} else {
		base.numCandidates = normalizeVectorSearchNumCandidates({
			numCandidates: input.numCandidates,
			limit,
		})
	}

	if (input.filter && Object.keys(input.filter).length > 0) {
		base.filter = input.filter
	}

	if (input.embeddingMode === "automated" && input.queryText) {
		base.query = { text: input.queryText }
		base.model = input.model ?? "voyage-4-large"
		base.path = input.textFieldPath ?? "text"
	} else {
		return null
	}

	return base
}

// ---------------------------------------------------------------------------
// Vector Search (native $vectorSearch)
// ---------------------------------------------------------------------------

export async function vectorSearch(
	collection: Collection,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore: number
		sessionKey?: string
		filter?: Document
		indexName: string
		queryText?: string
		embeddingMode?: MemoryMongoDBEmbeddingMode
		numCandidates?: number
		explain?: SearchExplainOptions
	},
): Promise<MemorySearchResult[]> {
	const filter: Document = {}
	const sourceFilter = resolveLegacySourceFilter(opts.sessionKey)
	if (sourceFilter) {
		filter.source = sourceFilter
	}
	const mergedFilter = mergeFilters(
		Object.keys(filter).length > 0 ? filter : undefined,
		opts.filter,
	)

	const vsStage = buildVectorSearchStage({
		queryVector,
		queryText: opts.queryText ?? null,
		embeddingMode: opts.embeddingMode ?? "automated",
		indexName: opts.indexName,
		numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		limit: opts.maxResults,
		filter: mergedFilter,
	})

	if (!vsStage) {
		return []
	}

	const pipeline: Document[] = [
		{ $vectorSearch: vsStage },
		{ $limit: opts.maxResults },
		{
			$project: {
				_id: 0,
				path: 1,
				startLine: 1,
				endLine: 1,
				text: 1,
				source: 1,
				sessionId: 1,
				sourceEventIds: 1,
				updatedAt: 1,
				timestamp: 1,
				scope: 1,
				scopeRef: 1,
				canonicalId: 1,
				unit: 1,
				provenance: 1,
				"metadata.sourceEventIds": 1,
				score: { $meta: "vectorSearchScore" },
			},
		},
	]

	if (opts.explain?.enabled) {
		const explained = await captureAggregateExplain(collection, pipeline)
		if (explained) {
			opts.explain.onArtifact?.({
				artifactType: "vectorExplain",
				summary: summarizeExplain(explained),
				...(opts.explain.deep ? { rawExplain: explained } : {}),
			})
		}
	}

	const docs = await runSearchAggregateWithRetry(collection, pipeline)
	const results = docs.map((doc) => toSearchResult(doc, "memory"))
	return filterByScore(results, opts.minScore)
}

// ---------------------------------------------------------------------------
// Keyword Search (native $search)
// ---------------------------------------------------------------------------

export async function keywordSearch(
	collection: Collection,
	query: string,
	opts: {
		maxResults: number
		minScore: number
		sessionKey?: string
		filter?: Document
		indexName: string
		explain?: SearchExplainOptions
	},
): Promise<MemorySearchResult[]> {
	const sourceFilter = resolveLegacySourceFilter(opts.sessionKey)
	const mergedFilter = mergeFilters(
		sourceFilter ? ({ source: sourceFilter } as Document) : undefined,
		opts.filter,
	)
	const { compoundFilter, postMatch } = splitAtlasSearchFilter(mergedFilter)

	const pipeline: Document[] = [
		{
			$search: {
				index: opts.indexName,
				compound: buildTextSearchCompound(query, compoundFilter),
				...(opts.explain?.includeScoreDetails ? { scoreDetails: true } : {}),
			},
		},
		...(postMatch ? [{ $match: postMatch }] : []),
		{ $limit: opts.maxResults * 4 },
		{
			$project: {
				_id: 0,
				path: 1,
				startLine: 1,
				endLine: 1,
				text: 1,
				source: 1,
				sessionId: 1,
				sourceEventIds: 1,
				updatedAt: 1,
				timestamp: 1,
				scope: 1,
				scopeRef: 1,
				canonicalId: 1,
				unit: 1,
				provenance: 1,
				"metadata.sourceEventIds": 1,
				score: { $meta: "searchScore" },
				...(opts.explain?.includeScoreDetails
					? { scoreDetails: { $meta: "searchScoreDetails" } }
					: {}),
			},
		},
	]

	if (opts.explain?.enabled) {
		const explained = await captureAggregateExplain(collection, pipeline)
		if (explained) {
			opts.explain.onArtifact?.({
				artifactType: "searchExplain",
				summary: summarizeExplain(explained),
				...(opts.explain.deep ? { rawExplain: explained } : {}),
			})
		}
	}

	const docs = await runSearchAggregateWithRetry(collection, pipeline)
	if (opts.explain?.enabled && opts.explain.includeScoreDetails) {
		const scoreDetailSample = docs.find(
			(doc) => doc.scoreDetails != null,
		)?.scoreDetails
		if (scoreDetailSample) {
			opts.explain.onArtifact?.({
				artifactType: "scoreDetails",
				summary: { available: true },
				...(opts.explain.deep ? { rawExplain: scoreDetailSample } : {}),
			})
		}
	}
	const results = docs
		.map((doc) => toSearchResult(doc, "memory"))
		.slice(0, opts.maxResults)
	return filterByScore(results, opts.minScore)
}

// ---------------------------------------------------------------------------
// Hybrid Search with $scoreFusion (MongoDB 8.2+)
// ---------------------------------------------------------------------------

export async function hybridSearchScoreFusion(
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore: number
		sessionKey?: string
		filter?: Document
		vectorIndexName: string
		textIndexName: string
		vectorWeight: number
		textWeight: number
		embeddingMode?: MemoryMongoDBEmbeddingMode
		numCandidates?: number
		explain?: SearchExplainOptions
	},
): Promise<MemorySearchResult[]> {
	const sourceFilter: Document = {}
	const source = resolveLegacySourceFilter(opts.sessionKey)
	if (source) {
		sourceFilter.source = source
	}
	const mergedFilter = mergeFilters(
		Object.keys(sourceFilter).length > 0 ? sourceFilter : undefined,
		opts.filter,
	)
	const { compoundFilter, postMatch } = splitAtlasSearchFilter(mergedFilter)

	const vsStage = buildVectorSearchStage({
		queryVector,
		queryText: query,
		embeddingMode: opts.embeddingMode ?? "automated",
		indexName: opts.vectorIndexName,
		numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		limit: opts.maxResults * 4,
		filter: mergedFilter,
	})

	if (!vsStage) {
		return []
	}

	const pipeline: Document[] = [
		{
			$scoreFusion: {
				input: {
					pipelines: {
						vector: [{ $vectorSearch: vsStage }],
						text: [
							{
								$search: {
									index: opts.textIndexName,
									compound: buildTextSearchCompound(query, compoundFilter),
								},
							},
							...(postMatch ? [{ $match: postMatch }] : []),
							{ $limit: opts.maxResults * 4 },
						],
					},
					normalization: "sigmoid",
				},
				combination: {
					weights: {
						vector: opts.vectorWeight,
						text: opts.textWeight,
					},
					method: "avg",
				},
				scoreDetails: true,
			},
		},
		{ $limit: opts.maxResults },
		{ $addFields: { scoreDetails: { $meta: "scoreDetails" } } },
		{
			$project: {
				_id: 0,
				path: 1,
				startLine: 1,
				endLine: 1,
				text: 1,
				source: 1,
				sessionId: 1,
				sourceEventIds: 1,
				updatedAt: 1,
				timestamp: 1,
				scope: 1,
				scopeRef: 1,
				canonicalId: 1,
				unit: 1,
				provenance: 1,
				"metadata.sourceEventIds": 1,
				score: "$scoreDetails.value",
				...(opts.explain?.includeScoreDetails ? { scoreDetails: 1 } : {}),
			},
		},
	]

	if (opts.explain?.enabled) {
		const explained = await captureAggregateExplain(collection, pipeline)
		if (explained) {
			opts.explain.onArtifact?.({
				artifactType: "fusionExplain",
				summary: { method: "scoreFusion", ...summarizeExplain(explained) },
				...(opts.explain.deep ? { rawExplain: explained } : {}),
			})
		}
	}

	const docs = await runSearchAggregateWithRetry(collection, pipeline)
	const results = docs.map((doc) => toSearchResult(doc, "memory"))
	return filterByScore(results, opts.minScore)
}

// ---------------------------------------------------------------------------
// Hybrid Search with $rankFusion (MongoDB 8.0+)
// ---------------------------------------------------------------------------

export async function hybridSearchRankFusion(
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore: number
		sessionKey?: string
		filter?: Document
		vectorIndexName: string
		textIndexName: string
		vectorWeight: number
		textWeight: number
		embeddingMode?: MemoryMongoDBEmbeddingMode
		numCandidates?: number
		explain?: SearchExplainOptions
	},
): Promise<MemorySearchResult[]> {
	const sourceFilter: Document = {}
	const source = resolveLegacySourceFilter(opts.sessionKey)
	if (source) {
		sourceFilter.source = source
	}
	const mergedFilter = mergeFilters(
		Object.keys(sourceFilter).length > 0 ? sourceFilter : undefined,
		opts.filter,
	)
	const { compoundFilter, postMatch } = splitAtlasSearchFilter(mergedFilter)

	const vsStage = buildVectorSearchStage({
		queryVector,
		queryText: query,
		embeddingMode: opts.embeddingMode ?? "automated",
		indexName: opts.vectorIndexName,
		numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		limit: opts.maxResults * 4,
		filter: mergedFilter,
	})

	if (!vsStage) {
		return []
	}

	const pipeline: Document[] = [
		{
			$rankFusion: {
				input: {
					pipelines: {
						vector: [{ $vectorSearch: vsStage }],
						text: [
							{
								$search: {
									index: opts.textIndexName,
									compound: buildTextSearchCompound(query, compoundFilter),
								},
							},
							...(postMatch ? [{ $match: postMatch }] : []),
							{ $limit: opts.maxResults * 4 },
						],
					},
				},
				combination: {
					weights: {
						vector: opts.vectorWeight,
						text: opts.textWeight,
					},
				},
				scoreDetails: true,
			},
		},
		{ $limit: opts.maxResults },
		{ $addFields: { scoreDetails: { $meta: "scoreDetails" } } },
		{
			$project: {
				_id: 0,
				path: 1,
				startLine: 1,
				endLine: 1,
				text: 1,
				source: 1,
				sessionId: 1,
				sourceEventIds: 1,
				updatedAt: 1,
				timestamp: 1,
				scope: 1,
				scopeRef: 1,
				canonicalId: 1,
				unit: 1,
				provenance: 1,
				"metadata.sourceEventIds": 1,
				score: "$scoreDetails.value",
				...(opts.explain?.includeScoreDetails ? { scoreDetails: 1 } : {}),
			},
		},
	]

	if (opts.explain?.enabled) {
		const explained = await captureAggregateExplain(collection, pipeline)
		if (explained) {
			opts.explain.onArtifact?.({
				artifactType: "fusionExplain",
				summary: { method: "rankFusion", ...summarizeExplain(explained) },
				...(opts.explain.deep ? { rawExplain: explained } : {}),
			})
		}
	}

	const docs = await runSearchAggregateWithRetry(collection, pipeline)
	const results = docs.map((doc) => toSearchResult(doc, "memory"))
	return filterRankFusionResults(results)
}

// ---------------------------------------------------------------------------
// JS fallback merge (for Community without mongot)
// ---------------------------------------------------------------------------

export function hybridSearchJSFallback(
	vectorResults: MemorySearchResult[],
	keywordResults: MemorySearchResult[],
	opts: { maxResults: number; vectorWeight: number; textWeight: number },
): MemorySearchResult[] {
	// Use our RRF-based merge instead of upstream's broken weighted-average merge.
	// RRF does not penalize results appearing in only one list and handles
	// incompatible score scales (cosine [0,1] vs BM25 [0,inf)) naturally.
	return mergeHybridResultsMongoDB({
		vector: vectorResults,
		keyword: keywordResults,
		maxResults: opts.maxResults,
	})
}

// ---------------------------------------------------------------------------
// Main search dispatcher
// ---------------------------------------------------------------------------

export async function mongoSearch(
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore: number
		numCandidates?: number
		sessionKey?: string
		fusionMethod: MemoryMongoDBFusionMethod
		capabilities: DetectedCapabilities
		filter?: Document
		vectorIndexName: string
		textIndexName: string
		vectorWeight?: number
		textWeight?: number
		embeddingMode?: MemoryMongoDBEmbeddingMode
		explain?: SearchExplainOptions
		onTrace?: (event: SearchTraceEvent) => void
		strictNoFallback?: boolean
	},
): Promise<MemorySearchResult[]> {
	const vectorWeight = opts.vectorWeight ?? 0.7
	const textWeight = opts.textWeight ?? 0.3
	const embeddingMode = opts.embeddingMode ?? "automated"
	const canVector =
		embeddingMode === "automated" && opts.capabilities.vectorSearch

	const searchOpts = {
		...opts,
		vectorWeight,
		textWeight,
		embeddingMode,
	}

	// Attempt hybrid search first (best quality).
	// Respect the user's fusionMethod preference:
	//   "scoreFusion" → try $scoreFusion, fall back to $rankFusion, then JS merge
	//   "rankFusion"  → try $rankFusion directly, fall back to JS merge
	//   "js-merge"    → skip server-side fusion entirely, go straight to JS merge
	if (canVector && opts.capabilities.textSearch) {
		// Try $scoreFusion (only if user wants it and server supports it)
		if (opts.fusionMethod === "scoreFusion" && opts.capabilities.scoreFusion) {
			try {
				const results = await hybridSearchScoreFusion(
					collection,
					query,
					queryVector,
					searchOpts,
				)
				if (results.length > 0) {
					opts.onTrace?.({ event: "method", method: "scoreFusion", ok: true })
					return results
				}
				opts.onTrace?.({
					event: "method",
					method: "scoreFusion",
					ok: false,
					message: "empty results",
				})
				if (shouldStopInsteadOfFallback(opts)) {
					return []
				}
				warnOrThrowFallback(
					opts,
					"$scoreFusion returned no hits, trying fallback path",
				)
			} catch (err) {
				if (err instanceof SearchFallbackDisabledError) {
					throw err
				}
				const msg = err instanceof Error ? err.message : String(err)
				opts.onTrace?.({
					event: "method",
					method: "scoreFusion",
					ok: false,
					message: msg,
				})
				warnOrThrowFallback(
					opts,
					`$scoreFusion failed, trying $rankFusion fallback: ${msg}`,
				)
			}
		}

		// Try $rankFusion (if user wants it, or as fallback from scoreFusion)
		if (opts.fusionMethod !== "js-merge" && opts.capabilities.rankFusion) {
			try {
				const results = await hybridSearchRankFusion(
					collection,
					query,
					queryVector,
					searchOpts,
				)
				if (results.length > 0) {
					opts.onTrace?.({ event: "method", method: "rankFusion", ok: true })
					return results
				}
				opts.onTrace?.({
					event: "method",
					method: "rankFusion",
					ok: false,
					message: "empty results",
				})
				if (shouldStopInsteadOfFallback(opts)) {
					return []
				}
				warnOrThrowFallback(
					opts,
					"$rankFusion returned no hits, trying fallback path",
				)
			} catch (err) {
				if (err instanceof SearchFallbackDisabledError) {
					throw err
				}
				const msg = err instanceof Error ? err.message : String(err)
				opts.onTrace?.({
					event: "method",
					method: "rankFusion",
					ok: false,
					message: msg,
				})
				warnOrThrowFallback(
					opts,
					`$rankFusion failed, trying separate queries + JS merge: ${msg}`,
				)
			}
		}

		// JS merge fallback: run vector + keyword separately
		try {
			const [vResults, kResults] = await Promise.all([
				vectorSearch(collection, queryVector, {
					...searchOpts,
					indexName: opts.vectorIndexName,
					queryText: query,
				}),
				keywordSearch(collection, query, {
					...searchOpts,
					indexName: opts.textIndexName,
				}),
			])
			const merged = hybridSearchJSFallback(vResults, kResults, {
				maxResults: opts.maxResults,
				vectorWeight,
				textWeight,
			})
			if (merged.length > 0) {
				opts.onTrace?.({ event: "method", method: "js-merge", ok: true })
				return merged
			}
			opts.onTrace?.({
				event: "method",
				method: "js-merge",
				ok: false,
				message: "empty results",
			})
			if (shouldStopInsteadOfFallback(opts)) {
				return []
			}
			warnOrThrowFallback(
				opts,
				"hybrid JS merge returned no hits, trying fallback path",
			)
		} catch (err) {
			if (err instanceof SearchFallbackDisabledError) {
				throw err
			}
			const msg = err instanceof Error ? err.message : String(err)
			opts.onTrace?.({
				event: "method",
				method: "js-merge",
				ok: false,
				message: msg,
			})
			warnOrThrowFallback(opts, `hybrid JS merge failed: ${msg}`)
		}
	}

	// Vector-only fallback
	if (canVector) {
		try {
			const results = await vectorSearch(collection, queryVector, {
				...searchOpts,
				indexName: opts.vectorIndexName,
				queryText: query,
			})
			if (results.length > 0) {
				opts.onTrace?.({ event: "method", method: "vector", ok: true })
				return results
			}
			opts.onTrace?.({
				event: "method",
				method: "vector",
				ok: false,
				message: "empty results",
			})
			if (shouldStopInsteadOfFallback(opts)) {
				return []
			}
			warnOrThrowFallback(
				opts,
				"vector search returned no hits, trying fallback path",
			)
		} catch (err) {
			if (err instanceof SearchFallbackDisabledError) {
				throw err
			}
			const msg = err instanceof Error ? err.message : String(err)
			opts.onTrace?.({
				event: "method",
				method: "vector",
				ok: false,
				message: msg,
			})
			warnOrThrowFallback(opts, `vector search failed: ${msg}`)
		}
	}

	// Keyword-only fallback
	if (opts.capabilities.textSearch) {
		try {
			const results = await keywordSearch(collection, query, {
				...searchOpts,
				indexName: opts.textIndexName,
			})
			if (results.length > 0) {
				opts.onTrace?.({ event: "method", method: "keyword", ok: true })
				return results
			}
			opts.onTrace?.({
				event: "method",
				method: "keyword",
				ok: false,
				message: "empty results",
			})
			if (shouldStopInsteadOfFallback(opts)) {
				return []
			}
			warnOrThrowFallback(
				opts,
				"keyword search returned no hits, trying $text fallback",
			)
		} catch (err) {
			if (err instanceof SearchFallbackDisabledError) {
				throw err
			}
			const msg = err instanceof Error ? err.message : String(err)
			opts.onTrace?.({
				event: "method",
				method: "keyword",
				ok: false,
				message: msg,
			})
			warnOrThrowFallback(opts, `keyword search failed: ${msg}`)
		}
	}

	// Last resort: basic $text index search (Community without mongot)
	if (isStrictSearchFallbackDisabled(opts)) {
		throw new SearchFallbackDisabledError("$text fallback would be required")
	}
	try {
		const sourceFilter = resolveLegacySourceFilter(opts.sessionKey)
		const filter = mergeFilters(
			{ $text: { $search: query } } as Document,
			sourceFilter ? ({ source: sourceFilter } as Document) : undefined,
			opts.filter,
		) ?? { $text: { $search: query } }
		const docs = await collection
			.aggregate([
				{ $match: filter },
				{
					$project: {
						_id: 0,
						path: 1,
						startLine: 1,
						endLine: 1,
						text: 1,
						source: 1,
						score: { $meta: "textScore" },
					},
				},
				{ $sort: { score: { $meta: "textScore" } } },
				{ $limit: opts.maxResults },
			])
			.toArray()
		opts.onTrace?.({ event: "method", method: "$text", ok: true })
		return docs
			.map((doc: Document) => toSearchResult(doc, "memory"))
			.filter((r: MemorySearchResult) => r.score >= opts.minScore)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		opts.onTrace?.({ event: "method", method: "$text", ok: false, message })
		log.warn("$text search fallback also failed; returning empty results")
		return []
	}
}
