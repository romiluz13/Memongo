import type { AggregateOptions, Collection, Document } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBQueryEmbeddingModel,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import { rrfScore } from "./mongodb-hybrid.js"
import { resolveChunkProvenance } from "./memory-derivation.js"
import {
	consumeSearchAggregationOrThrow,
	consumeSearchWorkOrThrow,
	refundSearchAggregations,
	resolveUserSearchMaxTimeMs,
} from "./mongodb-search-budget.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import type {
	InternalMemoryStoredSource,
	LegacyMemorySource,
	MemorySearchResult,
} from "./types.js"
import {
	classifySearchError,
	SearchLaneError,
	type SearchStage,
	type SearchTierOutcomeSink,
	searchFailureLogFields,
	toTypedSearchError,
} from "./search-outcomes.js"

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

/**
 * R4 (#101): a failed explain capture is a diagnostic, not retrieval — it is
 * reported as an `explain` row with a classified reason and never changes
 * the results or the request status.
 */
export function reportExplainFailure(
	err: unknown,
	onTierOutcome?: SearchTierOutcomeSink,
): void {
	log.debug("aggregate explain capture failed", searchFailureLogFields(err))
	onTierOutcome?.({
		stage: "explain",
		outcome: "failed",
		reason: classifySearchError(err),
	})
}

async function captureAggregateExplain(
	collection: Collection,
	pipeline: Document[],
	onTierOutcome?: SearchTierOutcomeSink,
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
		reportExplainFailure(err, onTierOutcome)
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

function countAutomatedVectorStages(value: unknown): number {
	if (!value || typeof value !== "object") return 0
	if (Array.isArray(value))
		return value.reduce(
			(count, entry) => count + countAutomatedVectorStages(entry),
			0,
		)
	const object = value as Record<string, unknown>
	const vector = object.$vectorSearch as
		| { query?: { text?: unknown } }
		| undefined
	return (
		(typeof vector?.query?.text === "string" ? 1 : 0) +
		Object.values(object).reduce<number>(
			(count, entry) => count + countAutomatedVectorStages(entry),
			0,
		)
	)
}

/**
 * #101 decision 18: vector stages whose build charged the embed together with
 * the aggregation that will execute it. The first attempt of the pipeline
 * carrying the stage claims that prepaid aggregation instead of charging
 * again, so the pair is never split.
 */
const prepaidVectorStages = new WeakSet<object>()

function claimPrepaidVectorStages(value: unknown): number {
	if (!value || typeof value !== "object") return 0
	if (Array.isArray(value)) {
		return value.reduce<number>(
			(count, entry) => count + claimPrepaidVectorStages(entry),
			0,
		)
	}
	const object = value as Record<string, unknown>
	const vector = object.$vectorSearch
	let claimed = 0
	if (vector && typeof vector === "object" && prepaidVectorStages.has(vector)) {
		prepaidVectorStages.delete(vector)
		claimed = 1
	}
	return (
		claimed +
		Object.values(object).reduce<number>(
			(count, entry) => count + claimPrepaidVectorStages(entry),
			0,
		)
	)
}

export async function runSearchAggregateWithRetry(
	collection: Collection,
	pipeline: Document[],
	{
		maxAttempts = 5,
		initialDelayMs = 250,
		aggregateOptions,
		stage = "lane",
	}: {
		maxAttempts?: number
		initialDelayMs?: number
		aggregateOptions?: AggregateOptions
		/** #101: the stage a budget denial or failure is reported at. */
		stage?: SearchStage
	} = {},
): Promise<Document[]> {
	// P3.8: user-driven pipelines carry a maxTimeMS ceiling. Callers with
	// their own deadline override it via aggregateOptions; everything else
	// gets the resolved default.
	const options: AggregateOptions = {
		maxTimeMS: resolveUserSearchMaxTimeMs(),
		...aggregateOptions,
	}
	let attempt = 0
	let delayMs = initialDelayMs
	const retryEmbeds = countAutomatedVectorStages(pipeline)
	const prepaid = claimPrepaidVectorStages(pipeline)
	while (true) {
		// P3.2 + RET-16: every ATTEMPT consumes the per-request budget — a
		// warmup retry re-executes the aggregate server-side, so it is a
		// real aggregation, not a replay of the original charge. #101: a
		// refusal is a typed budget denial, never an empty result, so it can
		// never read as zero hits. Decision 18: a retry charges its
		// aggregation and its re-embeds together or not at all, and the first
		// attempt of a pipeline whose vector stage prepaid its aggregation
		// charges nothing more.
		if (attempt > 0) {
			consumeSearchWorkOrThrow(
				stage,
				{ aggregations: 1, embeds: retryEmbeds },
				{ retry: true },
			)
		} else if (prepaid === 0) {
			consumeSearchAggregationOrThrow(stage)
		} else if (prepaid > 1) {
			refundSearchAggregations(prepaid - 1)
		}
		try {
			return await collection.aggregate(pipeline, options).toArray()
		} catch (error) {
			if (!isSearchIndexWarmupError(error)) {
				// Callers type the failure at their own tier seam; recall and
				// other non-search callers keep the driver error.
				throw error
			}
			if (attempt >= maxAttempts - 1) {
				throw new SearchLaneError({
					stage,
					reason: "index-not-ready",
					cause: error,
				})
			}
			log.debug("search index still warming; retrying aggregate", { delayMs })
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
	// RET-09: resolve authorship provenance from the fields the document
	// actually preserves — the role field (new chunks), the polymorphic
	// source discriminator (evidence/KB/transcript docs), or the
	// renderEventChunkText prefix (legacy conversation chunks). Unknown
	// rows resolve to "derived"; absent provenance must never read as
	// user-authored. The caller's legacy `source` fallback is deliberately
	// NOT consulted here: it says which collection the caller searched,
	// not who authored the row.
	const { role, derivation } = resolveChunkProvenance({
		source: doc.source,
		role: doc.role,
		text: doc.text,
	})
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
		// B5: the full chunk text rides alongside the 700-char display
		// preview so the reranker and the reader see whole turns.
		text:
			typeof doc.text === "string"
				? doc.text.slice(0, MAX_RESULT_TEXT_CHARS)
				: "",
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
		// Preserve the source retention deadline in result provenance.
		...(doc.expiresAt instanceof Date ? { expiresAt: doc.expiresAt } : {}),
		...(sourceEventIds && sourceEventIds.length > 0
			? { sourceEventIds }
			: eventId
				? { sourceEventIds: [eventId] }
				: {}),
		...(doc.provenance && typeof doc.provenance === "object"
			? { provenance: doc.provenance as Record<string, unknown> }
			: {}),
		...(role ? { role } : {}),
		derivation,
		...(typeof doc.confidence === "number"
			? { confidence: doc.confidence }
			: {}),
		...(typeof doc.sourceReliability === "number"
			? { sourceReliability: doc.sourceReliability }
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
 * function return [] for every query. A document ranked first in every input
 * of a second fused sub-lane can exceed this one-lane ceiling; the clamp to 1
 * keeps the server's order.
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

// Search-stage filters (vector prefilter, compound filter) run against the
// indexed copy, which can lag the latest write. Re-apply the full filter
// against the hydrated document immediately after the Search stage so a
// stale index admission cannot reach authoritative results. `$match` is a
// legal selection-pipeline stage inside $scoreFusion/$rankFusion input
// pipelines, and post-filtering `$vectorSearch` with `$match` is the
// documented pattern.
export function freshnessRevalidationStages(
	filter: Document | undefined,
): Document[] {
	return filter && Object.keys(filter).length > 0 ? [{ $match: filter }] : []
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

/** #101 R2: a Search-backed text tier runs only when its index is known queryable. */
export function isTextSearchTierAvailable(
	capabilities: DetectedCapabilities,
	indexName: string | undefined,
): boolean {
	return (
		capabilities.textSearch &&
		indexName !== undefined &&
		(capabilities.queryableSearchIndexes?.includes(indexName) ?? false)
	)
}

/** The field path a splitAtlasSearchFilter clause binds to. */
export function atlasSearchClausePath(clause: Document): string | undefined {
	const inner: Document = clause.compound?.filter?.[0] ?? clause
	return inner.equals?.path ?? inner.in?.path
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

/**
 * B5: bound for the full-text field carried on `MemorySearchResult`.
 * Chunks are whole turns and LongMemEval assistant turns run to thousands
 * of characters (median 429, p99 3,495, max observed 76,560), so a 700-char
 * snippet preview hides answers from both the reranker and the reader. This
 * cap covers every realistic turn while keeping pathological documents from
 * blowing the answer prompt.
 */
export const MAX_RESULT_TEXT_CHARS = 16_000

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
	/** #101: the stage a refused embed is reported at. */
	stage?: SearchStage
	/** The caller charges the embed with its aggregation itself, once, for
	 *  every vector input of one fused aggregate. */
	callerCharges?: boolean
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
		// paid embedding per pipeline. Charge the per-request budget; #101:
		// exhaustion throws a typed denial (a null stage now means only "no
		// query text"). Decision 18: the embed and the aggregation that runs
		// it are charged together, so a refused aggregation never strands a
		// spent embed; the pipeline's first attempt claims the prepaid half.
		if (!input.callerCharges) {
			consumeSearchWorkOrThrow(input.stage ?? "vector", {
				aggregations: 1,
				embeds: 1,
			})
			prepaidVectorStages.add(base)
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
		onTierOutcome?: SearchTierOutcomeSink
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
		// Authoritative results always hydrate the full current document from
		// mongod (the documented default lookup); storedSource reads the
		// indexed copy, which may return stale data.
		returnStoredSource: false,
		stage: "vector",
	})

	if (!vsStage) {
		opts.onTierOutcome?.({
			stage: "vector",
			outcome: "not-applicable",
			reason: "empty-query",
		})
		return []
	}

	const pipeline: Document[] = [
		{ $vectorSearch: vsStage },
		...freshnessRevalidationStages(mergedFilter),
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
				// RET-11 wave-3e followup: expiresAt was carried by the mapper
				// since wave 3d but never projected, so the carry was dead on
				// every live vector/keyword/fusion path. RET-09: role
				// (new chunks), confidence and sourceReliability (evidence
				// chunks) feed the provenance classifier.
				expiresAt: 1,
				role: 1,
				confidence: 1,
				sourceReliability: 1,
				"metadata.sourceEventIds": 1,
				score: { $meta: "vectorSearchScore" },
			},
		},
	]

	if (opts.explain?.enabled) {
		const explained = await captureAggregateExplain(
			collection,
			pipeline,
			opts.onTierOutcome,
		)
		if (explained) {
			opts.explain.onArtifact?.({
				artifactType: "vectorExplain",
				summary: summarizeExplain(explained),
				...(opts.explain.deep ? { rawExplain: explained } : {}),
			})
		}
	}

	const docs = await runSearchAggregateWithRetry(collection, pipeline, {
		stage: "vector",
	})
	const results = docs.map((doc) => toSearchResult(doc, "memory"))
	return filterByScore(results, opts.minScore)
}

// ---------------------------------------------------------------------------
// Native fusion: one aggregate, `$scoreFusion` (MongoDB 8.3+) or `$rankFusion`
// (MongoDB 8.0+). There is no weaker operation to fall to; a failure is typed.
// ---------------------------------------------------------------------------

/**
 * A second sub-lane fused into the same aggregate. It brings its own filter
 * and its own cap, so two sub-lanes whose filters cannot merge still cost one
 * aggregation, never two.
 */
export type FusionSibling = {
	filter: Document
	maxResults: number
}

type FusionSearchOpts = {
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
	onTierOutcome?: SearchTierOutcomeSink
	sibling?: FusionSibling
}

export type NativeFusionMethod = "scoreFusion" | "rankFusion"

const FUSION_STAGE = {
	scoreFusion: "score-fusion",
	rankFusion: "rank-fusion",
} as const

async function chunkFusionSearch(
	kind: NativeFusionMethod,
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: FusionSearchOpts,
): Promise<MemorySearchResult[]> {
	const stage = FUSION_STAGE[kind]
	const sourceFilter: Document = {}
	const source = resolveLegacySourceFilter(opts.sessionKey)
	if (source) {
		sourceFilter.source = source
	}
	const sessionSourceFilter =
		Object.keys(sourceFilter).length > 0 ? sourceFilter : undefined
	const primaryFilter = mergeFilters(sessionSourceFilter, opts.filter)
	const subLanes: Array<{
		vectorName: string
		textName: string
		filter: Document | undefined
		maxResults: number
	}> = [
		{
			vectorName: "vector",
			textName: "text",
			filter: primaryFilter,
			maxResults: opts.maxResults,
		},
	]
	if (opts.sibling) {
		subLanes.push({
			vectorName: "bridgeVector",
			textName: "bridgeText",
			filter: mergeFilters(sessionSourceFilter, opts.sibling.filter),
			maxResults: opts.sibling.maxResults,
		})
	}

	const vectorStages: Document[] = []
	for (const subLane of subLanes) {
		const vsStage = buildVectorSearchStage({
			queryVector,
			queryText: query,
			embeddingMode: opts.embeddingMode ?? "automated",
			model: opts.queryEmbeddingModel,
			indexName: opts.vectorIndexName,
			numCandidates:
				opts.numCandidates ?? Math.max(subLane.maxResults * 20, 100),
			limit: subLane.maxResults * 4,
			filter: subLane.filter,
			// Authoritative results always hydrate the full current document from
			// mongod (the documented default lookup); storedSource reads the
			// indexed copy, which may return stale data.
			returnStoredSource: false,
			stage,
			callerCharges: true,
		})
		if (!vsStage) {
			opts.onTierOutcome?.({
				stage,
				outcome: "not-applicable",
				reason: "empty-query",
			})
			return []
		}
		vectorStages.push(vsStage)
	}

	// Decision 18: one fused aggregate is one aggregation plus every embedded
	// vector input, charged together so a refusal never strands a spent embed.
	// The first stage carries the prepaid aggregation the executor claims.
	consumeSearchWorkOrThrow(stage, {
		aggregations: 1,
		embeds: vectorStages.length,
	})
	const [firstVectorStage] = vectorStages
	if (firstVectorStage) prepaidVectorStages.add(firstVectorStage)

	const pipelines: Record<string, Document[]> = {}
	const weights: Record<string, number> = {}
	subLanes.forEach((subLane, index) => {
		const { compoundFilter } = splitAtlasSearchFilter(subLane.filter)
		pipelines[subLane.vectorName] = [
			{ $vectorSearch: vectorStages[index] },
			...freshnessRevalidationStages(subLane.filter),
		]
		pipelines[subLane.textName] = [
			{
				$search: {
					index: opts.textIndexName,
					compound: buildTextSearchCompound(query, compoundFilter),
				},
			},
			...freshnessRevalidationStages(subLane.filter),
			{ $limit: subLane.maxResults * 4 },
		]
		weights[subLane.vectorName] = opts.vectorWeight
		weights[subLane.textName] = opts.textWeight
	})

	// The primary score comes from `$meta: "score"`, the only output shape the
	// fusion docs guarantee. `scoreDetails` is an unstable audit artifact
	// ("MongoDB does not guarantee any specific output format"), so it is
	// requested only when explain asks for it — never on the hot path, and
	// never as the score source.
	const includeScoreDetails = opts.explain?.includeScoreDetails === true
	const scoreDetails = includeScoreDetails ? { scoreDetails: true } : {}
	const fusionStage: Document =
		kind === "scoreFusion"
			? {
					$scoreFusion: {
						input: { pipelines, normalization: "sigmoid" },
						combination: { weights, method: "avg" },
						...scoreDetails,
					},
				}
			: {
					$rankFusion: {
						input: { pipelines },
						combination: { weights },
						...scoreDetails,
					},
				}
	const pipeline: Document[] = [
		fusionStage,
		{ $limit: subLanes.reduce((sum, subLane) => sum + subLane.maxResults, 0) },
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
				// RET-11 wave-3e followup: expiresAt was carried by the mapper
				// since wave 3d but never projected, so the carry was dead on
				// every live vector/fusion path. RET-09: role (new chunks),
				// confidence and sourceReliability (evidence chunks) feed the
				// provenance classifier.
				expiresAt: 1,
				role: 1,
				confidence: 1,
				sourceReliability: 1,
				"metadata.sourceEventIds": 1,
				score: { $meta: "score" },
				...(includeScoreDetails ? { scoreDetails: 1 } : {}),
			},
		},
	]

	if (opts.explain?.enabled) {
		const explained = await captureAggregateExplain(
			collection,
			pipeline,
			opts.onTierOutcome,
		)
		if (explained) {
			opts.explain.onArtifact?.({
				artifactType: "fusionExplain",
				summary: { method: kind, ...summarizeExplain(explained) },
				...(opts.explain.deep ? { rawExplain: explained } : {}),
			})
		}
	}

	const docs = await runSearchAggregateWithRetry(collection, pipeline, {
		stage,
	})
	const results = docs.map((doc) => toSearchResult(doc, "memory"))
	return kind === "scoreFusion"
		? normalizeAndFilterScoreFusionResults(
				results,
				opts.minScore,
				opts.vectorWeight,
				opts.textWeight,
			)
		: normalizeAndFilterRankFusionResults(
				results,
				opts.minScore,
				opts.vectorWeight,
				opts.textWeight,
			)
}

export function hybridSearchScoreFusion(
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: FusionSearchOpts,
): Promise<MemorySearchResult[]> {
	return chunkFusionSearch("scoreFusion", collection, query, queryVector, opts)
}

export function hybridSearchRankFusion(
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: FusionSearchOpts,
): Promise<MemorySearchResult[]> {
	return chunkFusionSearch("rankFusion", collection, query, queryVector, opts)
}

// ---------------------------------------------------------------------------
// Main search entry: the configured fusion method is the one operation.
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
		filter?: Document
		vectorIndexName: string
		textIndexName: string
		vectorWeight?: number
		textWeight?: number
		embeddingMode?: MemoryMongoDBEmbeddingMode
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
		explain?: SearchExplainOptions
		/** A second sub-lane fused into this same aggregate. */
		sibling?: FusionSibling
		/** #101: per-call sink for this lane's tier outcomes. */
		onTierOutcome?: SearchTierOutcomeSink
	},
): Promise<MemorySearchResult[]> {
	const kind = opts.fusionMethod
	if (kind !== "scoreFusion" && kind !== "rankFusion") {
		throw new SearchLaneError({
			stage: "request",
			reason: "query-error",
			cause: new Error(
				`fusionMethod "${String(kind)}" is not a native fusion operation; use "scoreFusion" or "rankFusion"`,
			),
		})
	}
	const stage = FUSION_STAGE[kind]
	const searchOpts = {
		...opts,
		vectorWeight: opts.vectorWeight ?? 0.7,
		textWeight: opts.textWeight ?? 0.3,
	}

	// #101 / decision 16: the lane runs exactly ONE operation. A successful
	// empty answer ends the lane (P3.2 "empty ≠ error"); an error or a budget
	// denial is a typed throw at the failing stage and is never answered with
	// a weaker operation.
	try {
		const results = await chunkFusionSearch(
			kind,
			collection,
			query,
			queryVector,
			searchOpts,
		)
		opts.onTierOutcome?.({
			stage,
			outcome: results.length > 0 ? "ok" : "ok-empty",
			...(results.length > 0 ? {} : { reason: "zero-hits" as const }),
			resultCount: results.length,
		})
		return results
	} catch (err) {
		const typed =
			err instanceof SearchLaneError && err.stage !== stage
				? new SearchLaneError({
						stage,
						reason: err.reason,
						cause: err.cause ?? err,
					})
				: toTypedSearchError(err, stage)
		throw typed
	}
}
