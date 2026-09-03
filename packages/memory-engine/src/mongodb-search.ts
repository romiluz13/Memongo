import type { AggregateOptions, Collection, Document } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBQueryEmbeddingModel,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import { mergeHybridResultsMongoDB, rrfScore } from "./mongodb-hybrid.js"
import {
	resolveUserSearchMaxTimeMs,
	tryConsumeSearchAggregation,
	tryConsumeSearchEmbed,
} from "./mongodb-search-budget.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
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
		aggregateOptions,
	}: {
		maxAttempts?: number
		initialDelayMs?: number
		aggregateOptions?: AggregateOptions
	} = {},
): Promise<Document[]> {
	// P3.2: every aggregation in the search path consumes the per-request
	// budget. Exhaustion degrades to an empty result (empty ≠ error), which
	// also stops the caller's escalation machinery from re-firing.
	if (!tryConsumeSearchAggregation()) {
		return []
	}
	// P3.8: user-driven pipelines carry a maxTimeMS ceiling. Callers with
	// their own deadline (the query-cache semantic probe) override it via
	// aggregateOptions; everything else gets the resolved default.
	const options: AggregateOptions = {
		maxTimeMS: resolveUserSearchMaxTimeMs(),
		...aggregateOptions,
	}
	let attempt = 0
	let delayMs = initialDelayMs
	while (true) {
		try {
			return await collection.aggregate(pipeline, options).toArray()
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

/**
 * Rescale raw `$rankFusion` output into the [0,1] space every other search
 * path reports in, then apply the caller's threshold.
 *
 * MongoDB computes the fused score as (quoting the `scoreDetails.description`
 * the server itself returns): "value output by reciprocal rank fusion
 * algorithm, computed as sum of (weight * (1 / (60 + rank))) across input
 * pipelines from which this document is output". A document ranked #1 in every
 * pipeline therefore scores `Σweights / 61` — with the 0.7/0.3 weights used
 * here that ceiling is 1/61 ≈ 0.0164, measured exactly on a live cluster.
 *
 * Raw RRF output is thus not a relevance score and shares no scale with vector
 * or lexical scores. Comparing it against a caller minScore of 0.1 made this
 * function return [] for every query, which silently demoted every hybrid
 * search to the JS-merge fallback below. `mergeHybridResultsMongoDB` already
 * divides by this same ceiling; doing it here too is what makes the two paths
 * interchangeable, which a fallback has to be.
 */
/**
 * Rescale raw `$scoreFusion` output into the same [0,1] space, then apply the
 * caller's threshold.
 *
 * `normalization: "sigmoid"` maps every input-pipeline score into (0,1) and
 * the `avg` combination weights-and-averages them, so the raw ceiling is
 * `max(maxWeight, Σweights / 2)` — 0.7 with the 0.7/0.3 weights used here —
 * never 1. (The docs do not pin down whether `avg` divides by all pipelines
 * or only those that returned the document; this ceiling bounds both
 * readings.) Thresholding the raw value against a [0,1] `minScore` is the
 * same silent-empty-lane failure documented on
 * {@link normalizeAndFilterRankFusionResults}.
 */
export function normalizeAndFilterScoreFusionResults(
	results: MemorySearchResult[],
	minScore: number,
	vectorWeight: number,
	textWeight: number,
): MemorySearchResult[] {
	const maxPossibleScore = Math.max(
		vectorWeight,
		textWeight,
		(vectorWeight + textWeight) / 2,
	)
	if (!(maxPossibleScore > 0)) {
		return []
	}
	return results
		.filter((r) => r.score > 0)
		.map((r) => ({
			...r,
			score: Number(Math.min(1, r.score / maxPossibleScore).toFixed(6)),
		}))
		.filter((r) => r.score >= minScore)
}

export function normalizeAndFilterRankFusionResults(
	results: MemorySearchResult[],
	minScore: number,
	vectorWeight: number,
	textWeight: number,
): MemorySearchResult[] {
	const maxPossibleScore = (vectorWeight + textWeight) * rrfScore(1)
	if (!(maxPossibleScore > 0)) {
		return []
	}
	return results
		.filter((r) => r.score > 0)
		.map((r) => ({
			...r,
			score: Number(Math.min(1, r.score / maxPossibleScore).toFixed(6)),
		}))
		.filter((r) => r.score >= minScore)
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
				if (value.every((entry) => isPlainObject(entry))) {
					for (const entry of value) {
						visit(entry as Document)
					}
				} else {
					// A non-object member means this isn't a shape we can flatten.
					// Hand the whole clause to $match and keep visiting siblings —
					// bailing out here used to drop every remaining key on the node,
					// silently widening the query.
					postMatchClauses.push({ $and: value as unknown[] })
				}
				continue
			}

			// Any other operator key ($or, $nor, $not, $expr, ...) has no path to
			// bind to. buildSearchFilterClause would treat the operator itself as a
			// field path and emit e.g. {in: {path: "$or", value: [{...}]}}, which
			// mongot rejects outright ("must be a boolean, objectId, number,
			// string, date, uuid, or null"), taking the whole Atlas Search pipeline
			// down with it. $match handles these correctly, so route them there.
			if (key.startsWith("$")) {
				postMatchClauses.push({ [key]: value })
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
	model?: MemoryMongoDBQueryEmbeddingModel
	numCandidates: number
	limit: number
	filter?: Document
	textFieldPath?: string
	/** When true, uses MongoDB ENN (exact nearest neighbor): sets exact: true
	 *  and omits numCandidates per the $vectorSearch contract. */
	exact?: boolean
	/** When true, returns stored source fields from the index without a
	 *  collection re-fetch (requires the index to have `storedSource` configured).
	 *  MongoDB 8.3+ feature. */
	returnStoredSource?: boolean
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

	// L4: returnStoredSource — return stored source fields from the index
	// without a collection re-fetch (MongoDB 8.3+ feature).
	if (input.returnStoredSource) {
		base.returnStoredSource = true
	}

	if (input.embeddingMode === "automated" && input.queryText) {
		// P3.1/P3.2: an autoEmbed stage embeds the query text server-side — a
		// paid embedding per pipeline. Charge the per-request budget; when it
		// is exhausted the stage is withheld and the lane degrades to empty
		// (empty ≠ error) instead of firing another embedding.
		if (!tryConsumeSearchEmbed()) {
			return null
		}
		base.query = { text: input.queryText }
		base.model = input.model ?? INDEX_AUTOEMBED_MODEL
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
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
		numCandidates?: number
		explain?: SearchExplainOptions
		returnStoredSource?: boolean
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
		model: opts.queryEmbeddingModel,
		indexName: opts.indexName,
		numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		limit: opts.maxResults,
		filter: mergedFilter,
		returnStoredSource: opts.returnStoredSource ?? false,
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
// Hybrid Search with $scoreFusion (MongoDB 8.3+)
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
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
		numCandidates?: number
		explain?: SearchExplainOptions
		returnStoredSource?: boolean
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
		model: opts.queryEmbeddingModel,
		indexName: opts.vectorIndexName,
		numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		limit: opts.maxResults * 4,
		filter: mergedFilter,
		returnStoredSource: opts.returnStoredSource ?? false,
	})

	if (!vsStage) {
		return []
	}

	// The primary score comes from `$meta: "score"`, the only output shape the
	// fusion docs guarantee. `scoreDetails` is an unstable audit artifact
	// ("MongoDB does not guarantee any specific output format"), so it is
	// requested only when explain asks for it — never on the hot path, and
	// never as the score source.
	const includeScoreDetails = opts.explain?.includeScoreDetails === true
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
				...(includeScoreDetails ? { scoreDetails: true } : {}),
			},
		},
		{ $limit: opts.maxResults },
		...(includeScoreDetails
			? [{ $addFields: { scoreDetails: { $meta: "scoreDetails" } } }]
			: []),
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
				score: { $meta: "score" },
				...(includeScoreDetails ? { scoreDetails: 1 } : {}),
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
	return normalizeAndFilterScoreFusionResults(
		results,
		opts.minScore,
		opts.vectorWeight,
		opts.textWeight,
	)
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
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
		numCandidates?: number
		explain?: SearchExplainOptions
		returnStoredSource?: boolean
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
		model: opts.queryEmbeddingModel,
		indexName: opts.vectorIndexName,
		numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		limit: opts.maxResults * 4,
		filter: mergedFilter,
		returnStoredSource: opts.returnStoredSource ?? false,
	})

	if (!vsStage) {
		return []
	}

	// Same score-source contract as the $scoreFusion lane above: `$meta:
	// "score"` is the guaranteed shape; `scoreDetails` is explain-only.
	const includeScoreDetails = opts.explain?.includeScoreDetails === true
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
				...(includeScoreDetails ? { scoreDetails: true } : {}),
			},
		},
		{ $limit: opts.maxResults },
		...(includeScoreDetails
			? [{ $addFields: { scoreDetails: { $meta: "scoreDetails" } } }]
			: []),
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
				score: { $meta: "score" },
				...(includeScoreDetails ? { scoreDetails: 1 } : {}),
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
	return normalizeAndFilterRankFusionResults(
		results,
		opts.minScore,
		opts.vectorWeight,
		opts.textWeight,
	)
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
		vectorWeight: opts.vectorWeight,
		textWeight: opts.textWeight,
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
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
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
		returnStoredSource: opts.capabilities.storedSource,
	}

	// P3.2 — "empty ≠ error" (fix-plan-2026-08-03, Appendix C): an empty
	// result is a valid answer, not a trigger for escalation. Every stage
	// below that includes the vector lane returns nearest neighbors for ANY
	// query as long as documents exist under the filter, so an empty stage
	// result proves there is nothing retrievable for this query+filter —
	// re-running the same query through the next waterfall stage (and
	// re-embedding it server-side) is pure cost. Only ERRORS escalate.
	const emptyResult = (method: SearchTraceEvent["method"]) => {
		opts.onTrace?.({
			event: "method",
			method,
			ok: false,
			message: "empty results",
		})
		return [] as MemorySearchResult[]
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
				return emptyResult("scoreFusion")
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
				return emptyResult("rankFusion")
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
			// Stopping here also dedupes the old js-merge → vector-only double
			// vectorSearch: the identical vector search just ran inside the
			// merge, and it returned nothing.
			return emptyResult("js-merge")
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
			return emptyResult("vector")
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
			return emptyResult("keyword")
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
	// P3.2: the $text aggregate bypasses runSearchAggregateWithRetry, so it
	// consumes the budget directly.
	if (!tryConsumeSearchAggregation()) {
		return []
	}
	try {
		const sourceFilter = resolveLegacySourceFilter(opts.sessionKey)
		const filter = mergeFilters(
			{ $text: { $search: query } } as Document,
			sourceFilter ? ({ source: sourceFilter } as Document) : undefined,
			opts.filter,
		) ?? { $text: { $search: query } }
		const docs = await collection
			.aggregate(
				[
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
				],
				// P3.8: user-driven pipelines carry a maxTimeMS ceiling.
				{ maxTimeMS: resolveUserSearchMaxTimeMs() },
			)
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
