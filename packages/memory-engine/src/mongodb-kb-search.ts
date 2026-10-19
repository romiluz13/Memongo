import type { Collection, Document } from "mongodb"
import type {
	MemoryMongoDBEmbeddingMode,
	MemoryMongoDBFusionMethod,
	MemoryMongoDBQueryEmbeddingModel,
} from "@memongo/lib"
import { summarizeExplain } from "./mongodb-relevance.js"
import {
	buildVectorSearchStage,
	freshnessRevalidationStages,
	MONGODB_MAX_NUM_CANDIDATES,
	normalizeAndFilterRankFusionResults,
	reportExplainFailure,
	runSearchAggregateWithRetry,
	splitAtlasSearchFilter,
	type SearchExplainOptions,
} from "./mongodb-search.js"
import {
	SearchLaneError,
	type SearchStage,
	type SearchTierOutcomeSink,
	toTypedSearchError,
} from "./search-outcomes.js"
import type { MemorySearchResult } from "./types.js"

// KB hybrid lane weights — the same 0.7/0.3 split the general search path
// uses, kept as named constants so the score normalization and the pipeline
// can never drift apart.
const KB_FUSION_VECTOR_WEIGHT = 0.7
const KB_FUSION_TEXT_WEIGHT = 0.3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toKBSearchResult(doc: Document): MemorySearchResult {
	const rawPath = typeof doc.path === "string" ? doc.path : ""
	return {
		path: rawPath ? `kb:${rawPath}` : "kb:",
		filePath: rawPath || undefined,
		startLine: typeof doc.startLine === "number" ? doc.startLine : 0,
		endLine: typeof doc.endLine === "number" ? doc.endLine : 0,
		score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
		snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
		source: "reference",
		sourceType: "reference",
		// RET-09: KB chunks are verbatim spans of ingested external
		// documents — cited material, not conversation authorship.
		derivation: "reference",
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		// Preserve the source retention deadline in result provenance.
		...(doc.expiresAt instanceof Date ? { expiresAt: doc.expiresAt } : {}),
	}
}

function normalizeKBFilter(raw?: {
	tags?: string[]
	category?: string
	source?: string
}): { tags?: string[]; category?: string; source?: string } | null {
	if (!raw) {
		return null
	}
	const tags = Array.isArray(raw.tags)
		? raw.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)
		: []
	const category = raw.category?.trim()
	const source = raw.source?.trim()
	if (tags.length === 0 && !category && !source) {
		return null
	}
	return {
		...(tags.length > 0 ? { tags } : {}),
		...(category ? { category } : {}),
		...(source ? { source } : {}),
	}
}

async function resolveKBChunkFilter(params: {
	scopeRef: string
	kbDocs?: Collection
	filter?: { tags?: string[]; category?: string; source?: string }
}): Promise<Document> {
	// scopeRef is ALWAYS applied — it is the tenant isolation predicate, so a
	// search can never return another tenant's KB chunks (issue #27).
	const base: Document = { scopeRef: params.scopeRef }
	const normalized = normalizeKBFilter(params.filter)
	if (!normalized) {
		return base
	}
	if (!params.kbDocs) {
		// A filter the caller asked for is never dropped: searching without it
		// would return chunks the caller excluded.
		throw new SearchLaneError({
			lane: "kb",
			stage: "filter",
			reason: "internal-error",
		})
	}

	const kbDocFilter: Document = { scopeRef: params.scopeRef }
	if (normalized.tags?.length) {
		kbDocFilter.tags = { $all: normalized.tags }
	}
	if (normalized.category) {
		kbDocFilter.category = normalized.category
	}
	if (normalized.source) {
		kbDocFilter["source.type"] = normalized.source
	}

	// Keep this bounded to avoid oversized $in filters.
	const docs = await params.kbDocs
		.find(kbDocFilter, { projection: { _id: 1 } })
		.limit(10_000)
		.toArray()
	const docIds = docs.map((doc) => String(doc._id))
	return { scopeRef: params.scopeRef, docId: { $in: docIds } }
}

// ---------------------------------------------------------------------------
// KB Search
// ---------------------------------------------------------------------------

/**
 * M2 decision 5: KB search is one configured native fusion over kb_chunks —
 * `$scoreFusion` (minMaxScaler, avg) or `$rankFusion` — fixed before it runs.
 * A healthy zero is final. An error or a budget denial is a typed throw at the
 * fusion stage; no weaker tier (vector-only, keyword-only, JavaScript merge,
 * `$text`) runs after any outcome.
 */
export async function searchKB(
	kbChunks: Collection,
	query: string,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore: number
		scopeRef: string
		filter?: { tags?: string[]; category?: string; source?: string }
		/** Resolves `filter` to document ids; required whenever `filter` is set. */
		kbDocs?: Collection
		vectorIndexName: string
		textIndexName: string
		embeddingMode: MemoryMongoDBEmbeddingMode
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
		numCandidates?: number
		explain?: SearchExplainOptions
		/**
		 * The server-side fusion to run: "scoreFusion" ($scoreFusion, MongoDB
		 * 8.3+, the default) or "rankFusion" ($rankFusion). Any other value is
		 * a typed failure before anything runs.
		 */
		fusionMethod?: MemoryMongoDBFusionMethod
		/** #101: per-call sink for this lane's tier outcome rows. */
		onTierOutcome?: SearchTierOutcomeSink
	},
): Promise<MemorySearchResult[]> {
	const fusionMethod = opts.fusionMethod ?? "scoreFusion"
	if (fusionMethod !== "scoreFusion" && fusionMethod !== "rankFusion") {
		throw new SearchLaneError({
			lane: "kb",
			stage: "plan",
			reason: "query-error",
		})
	}
	const stage: SearchStage =
		fusionMethod === "scoreFusion" ? "score-fusion" : "rank-fusion"

	let chunkFilter: Document
	try {
		chunkFilter = await resolveKBChunkFilter({
			scopeRef: opts.scopeRef,
			kbDocs: opts.kbDocs,
			filter: opts.filter,
		})
	} catch (err) {
		throw toTypedSearchError(err, "filter", "kb")
	}
	const filteredDocIds = (
		chunkFilter as { docId?: { $in?: string[] } } | undefined
	)?.docId?.$in
	if (Array.isArray(filteredDocIds) && filteredDocIds.length === 0) {
		// K1: the tag/category filter matched no document — a successful empty.
		opts.onTierOutcome?.({
			stage: "filter",
			outcome: "ok-empty",
			reason: "zero-hits",
			resultCount: 0,
		})
		return []
	}
	const numCandidates = Math.min(
		opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		MONGODB_MAX_NUM_CANDIDATES,
	)

	const runKbFusion = async (): Promise<MemorySearchResult[] | null> => {
		const { compoundFilter } = splitAtlasSearchFilter(chunkFilter)
		const vsStage = buildVectorSearchStage({
			queryVector,
			queryText: query,
			embeddingMode: opts.embeddingMode,
			model: opts.queryEmbeddingModel,
			indexName: opts.vectorIndexName,
			numCandidates,
			limit: opts.maxResults,
			filter: chunkFilter,
			// Authoritative serving hydrates the full current document from
			// mongod (the documented default); storedSource may return stale
			// data and would defeat the post-stage freshness $match below.
			returnStoredSource: false,
			stage,
		})
		if (!vsStage) {
			return null
		}

		const textPipeline: Document[] = [
			{
				$search: {
					index: opts.textIndexName,
					compound: {
						must: [{ text: { query, path: "text" } }],
						...(compoundFilter ? { filter: compoundFilter } : {}),
					},
				},
			},
			// Re-validate the full chunk filter against the hydrated
			// document — the compound filter runs against the indexed copy,
			// which can lag the latest write.
			...freshnessRevalidationStages(chunkFilter),
			{ $limit: opts.maxResults * 4 },
		]
		const pipelines = {
			vector: [
				{ $vectorSearch: vsStage },
				...freshnessRevalidationStages(chunkFilter),
			],
			text: textPipeline,
		}
		const weights = {
			vector: KB_FUSION_VECTOR_WEIGHT,
			text: KB_FUSION_TEXT_WEIGHT,
		}
		// Locked decision #9: $scoreFusion (8.3+) uses minMaxScaler — the only
		// officially documented normalization that yields a comparable [0,1]
		// fused score, so the caller's minScore threshold applies directly.
		const fusionStage =
			fusionMethod === "scoreFusion"
				? {
						$scoreFusion: {
							input: { pipelines, normalization: "minMaxScaler" },
							combination: { weights, method: "avg" },
						},
					}
				: {
						$rankFusion: {
							input: { pipelines },
							combination: { weights },
						},
					}
		const pipeline: Document[] = [
			fusionStage,
			{ $limit: opts.maxResults },
			{
				$project: {
					_id: 0,
					path: 1,
					startLine: 1,
					endLine: 1,
					text: 1,
					docId: 1,
					// RET-11 wave-3e followup: the mapper's expiresAt carry
					// was dead — no KB projection included the field.
					expiresAt: 1,
					updatedAt: 1,
					score: { $meta: "score" },
				},
			},
		]

		if (opts.explain?.enabled) {
			try {
				const cursor = kbChunks.aggregate(pipeline) as unknown as {
					explain?: (verbosity?: string) => Promise<unknown>
				}
				if (typeof cursor.explain === "function") {
					const explained = await cursor.explain("executionStats")
					opts.explain.onArtifact?.({
						artifactType: "fusionExplain",
						summary: {
							source: "kb",
							method: fusionMethod,
							...summarizeExplain(explained),
						},
						...(opts.explain.deep ? { rawExplain: explained } : {}),
					})
				}
			} catch (err) {
				reportExplainFailure(err, opts.onTierOutcome)
			}
		}

		const docs = await runSearchAggregateWithRetry(kbChunks, pipeline, {
			stage,
		})
		const results = docs.map(toKBSearchResult)
		if (fusionMethod === "scoreFusion") {
			// minMaxScaler output is already [0,1] — threshold directly.
			return results.filter((r) => r.score >= opts.minScore)
		}
		// P0.10: raw RRF scores top out at Σweights/61 ≈ 0.0164 — rescale into
		// [0,1] exactly like the general path before thresholding, or the lane
		// silently empties under the default minScore.
		return normalizeAndFilterRankFusionResults(
			results,
			opts.minScore,
			KB_FUSION_VECTOR_WEIGHT,
			KB_FUSION_TEXT_WEIGHT,
		)
	}

	let results: MemorySearchResult[] | null
	try {
		results = await runKbFusion()
	} catch (err) {
		throw toTypedSearchError(err, stage, "kb")
	}
	if (results === null) {
		opts.onTierOutcome?.({
			stage,
			outcome: "not-applicable",
			reason: "empty-query",
		})
		return []
	}
	opts.onTierOutcome?.({
		stage,
		outcome: results.length > 0 ? "ok" : "ok-empty",
		...(results.length > 0 ? {} : { reason: "zero-hits" as const }),
		resultCount: results.length,
	})
	return results
}
