import type { Collection, Document } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBQueryEmbeddingModel,
	createSubsystemLogger,
} from "@memongo/lib"
import { mergeHybridResultsMongoDB } from "./mongodb-hybrid.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import { settledFailureMeta } from "./query-diagnostics.js"
import {
	resolveUserSearchMaxTimeMs,
	tryConsumeSearchAggregation,
} from "./mongodb-search-budget.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	buildVectorSearchStage,
	freshnessRevalidationStages,
	MONGODB_MAX_NUM_CANDIDATES,
	normalizeAndFilterRankFusionResults,
	runSearchAggregateWithRetry,
	splitAtlasSearchFilter,
	type SearchExplainOptions,
} from "./mongodb-search.js"
import type { MemorySearchResult } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:kb-search")

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
		log.warn(
			"KB filter provided but kb document collection is unavailable; ignoring filter",
		)
		return base
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

export async function searchKB(
	kbChunks: Collection,
	query: string,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore: number
		scopeRef: string
		filter?: { tags?: string[]; category?: string; source?: string }
		kbDocs?: Collection
		vectorIndexName: string
		textIndexName: string
		capabilities: DetectedCapabilities
		embeddingMode: MemoryMongoDBEmbeddingMode
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
		numCandidates?: number
		explain?: SearchExplainOptions
		/**
		 * Server-side fusion preference, mirroring the general search path:
		 * "scoreFusion" tries $scoreFusion first (MongoDB 8.3+), "rankFusion"
		 * goes straight to $rankFusion, "js-merge" skips server fusion.
		 */
		fusionMethod?: MemoryMongoDBFusionMethod
		/**
		 * WS-11 admission control: drop the vector lane entirely (text-only
		 * degradation) when the caller's admission check denied the autoEmbed
		 * spend. Every $vectorSearch stage in this module is behind canVector,
		 * so one flag removes the whole embed burn.
		 */
		skipVectorLane?: boolean
		/**
		 * RET-13: shared lane failure policy for the KB waterfall. strict →
		 * rethrow so a failing stage fails the search loudly (consistent with
		 * every other lane under benchmark strict mode); else report each
		 * stage failure at its seam ("kb:$scoreFusion", "kb:js-merge",
		 * "kb:vector", "kb:keyword", "kb:$text") via onLaneFailure and keep
		 * degrading down the waterfall.
		 */
		strict?: boolean
		onLaneFailure?: (lane: string, error: unknown) => void
	},
): Promise<MemorySearchResult[]> {
	const canVector =
		opts.skipVectorLane !== true &&
		(opts.embeddingMode === "automated"
			? opts.capabilities.vectorSearch
			: queryVector != null && opts.capabilities.vectorSearch)

	const canText = opts.capabilities.textSearch
	const chunkFilter = await resolveKBChunkFilter({
		scopeRef: opts.scopeRef,
		kbDocs: opts.kbDocs,
		filter: opts.filter,
	})
	const filteredDocIds = (
		chunkFilter as { docId?: { $in?: string[] } } | undefined
	)?.docId?.$in
	if (Array.isArray(filteredDocIds) && filteredDocIds.length === 0) {
		return []
	}
	const numCandidates = Math.min(
		opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		MONGODB_MAX_NUM_CANDIDATES,
	)

	// F12/P0.10: server-side hybrid fusion, mirroring the general search
	// path's waterfall (scoreFusion → rankFusion → lane fallbacks). Fusion is
	// a first-class option (`fusionMethod`), resolved by the manager from
	// `mongodb.fusionMethod`.
	const fusionMethod = opts.fusionMethod ?? "scoreFusion"

	const runKbFusion = async (
		method: "scoreFusion" | "rankFusion",
	): Promise<MemorySearchResult[] | null> => {
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
		const weights = {
			vector: KB_FUSION_VECTOR_WEIGHT,
			text: KB_FUSION_TEXT_WEIGHT,
		}
		// Locked decision #9: $scoreFusion (8.3+) uses minMaxScaler — the only
		// officially documented normalization that yields a comparable [0,1]
		// fused score, so the caller's minScore threshold applies directly.
		const fusionStage =
			method === "scoreFusion"
				? {
						$scoreFusion: {
							input: {
								pipelines: {
									vector: [
										{ $vectorSearch: vsStage },
										...freshnessRevalidationStages(chunkFilter),
									],
									text: textPipeline,
								},
								normalization: "minMaxScaler",
							},
							combination: { weights, method: "avg" },
						},
					}
				: {
						$rankFusion: {
							input: {
								pipelines: {
									vector: [
										{ $vectorSearch: vsStage },
										...freshnessRevalidationStages(chunkFilter),
									],
									text: textPipeline,
								},
							},
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
							method,
							...summarizeExplain(explained),
						},
						...(opts.explain.deep ? { rawExplain: explained } : {}),
					})
				}
			} catch {
				log.warn("KB search explain failed")
			}
		}

		const docs = await runSearchAggregateWithRetry(kbChunks, pipeline)
		const results = docs.map(toKBSearchResult)
		if (method === "scoreFusion") {
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

	if (canVector && canText && fusionMethod !== "js-merge") {
		if (fusionMethod === "scoreFusion" && opts.capabilities.scoreFusion) {
			try {
				const results = await runKbFusion("scoreFusion")
				if (results && results.length > 0) {
					return results
				}
			} catch (err) {
				if (opts.strict) {
					throw err
				}
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`KB hybrid search ($scoreFusion) failed, falling back to $rankFusion: ${msg}`,
				)
				opts.onLaneFailure?.("kb:$scoreFusion", err)
			}
		}
		if (opts.capabilities.rankFusion) {
			try {
				const results = await runKbFusion("rankFusion")
				if (results && results.length > 0) {
					return results
				}
			} catch (err) {
				if (opts.strict) {
					throw err
				}
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`KB hybrid search ($rankFusion) failed, falling back to vector-only: ${msg}`,
				)
				opts.onLaneFailure?.("kb:$rankFusion", err)
			}
		}
	}

	const runVectorLane = async (
		limit: number,
	): Promise<MemorySearchResult[]> => {
		const vsStage = buildVectorSearchStage({
			queryVector,
			queryText: query,
			embeddingMode: opts.embeddingMode,
			model: opts.queryEmbeddingModel,
			indexName: opts.vectorIndexName,
			numCandidates,
			limit,
			filter: chunkFilter,
			// Authoritative serving hydrates the full current document from
			// mongod (the documented default); storedSource may return stale
			// data and would defeat the post-stage freshness $match below.
			returnStoredSource: false,
		})

		if (!vsStage) {
			return []
		}
		const pipeline: Document[] = [
			{ $vectorSearch: vsStage },
			// Re-validate the full chunk filter against the hydrated
			// document — the ANN prefilter runs against the indexed copy,
			// which can lag the latest write.
			...freshnessRevalidationStages(chunkFilter),
			{ $limit: limit },
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
					score: { $meta: "vectorSearchScore" },
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
						artifactType: "vectorExplain",
						summary: { source: "kb", ...summarizeExplain(explained) },
						...(opts.explain.deep ? { rawExplain: explained } : {}),
					})
				}
			} catch {
				log.warn("KB search explain failed")
			}
		}
		const docs = await runSearchAggregateWithRetry(kbChunks, pipeline)
		return docs.map(toKBSearchResult)
	}

	const runTextLane = async (limit: number): Promise<MemorySearchResult[]> => {
		const { compoundFilter } = splitAtlasSearchFilter(chunkFilter)
		const pipeline: Document[] = [
			{
				$search: {
					index: opts.textIndexName,
					compound: {
						must: [{ text: { query, path: "text" } }],
						...(compoundFilter ? { filter: compoundFilter } : {}),
					},
					...(opts.explain?.includeScoreDetails ? { scoreDetails: true } : {}),
				},
			},
			// Re-validate the full chunk filter against the hydrated
			// document — the compound filter runs against the indexed copy,
			// which can lag the latest write.
			...freshnessRevalidationStages(chunkFilter),
			{ $limit: limit },
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
					score: { $meta: "searchScore" },
					...(opts.explain?.includeScoreDetails
						? { scoreDetails: { $meta: "searchScoreDetails" } }
						: {}),
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
						artifactType: "searchExplain",
						summary: { source: "kb", ...summarizeExplain(explained) },
						...(opts.explain.deep ? { rawExplain: explained } : {}),
					})
				}
			} catch {
				log.warn("KB search explain failed")
			}
		}
		const docs = await runSearchAggregateWithRetry(kbChunks, pipeline)
		if (opts.explain?.enabled && opts.explain.includeScoreDetails) {
			const scoreDetailSample = docs.find(
				(doc) => doc.scoreDetails != null,
			)?.scoreDetails
			if (scoreDetailSample) {
				opts.explain.onArtifact?.({
					artifactType: "scoreDetails",
					summary: { source: "kb", available: true },
					...(opts.explain.deep ? { rawExplain: scoreDetailSample } : {}),
				})
			}
		}
		return docs.map(toKBSearchResult)
	}

	let vectorLaneFulfilled = false
	let textLaneFulfilled = false
	if (canVector && canText && fusionMethod === "js-merge") {
		try {
			const laneLimit = opts.maxResults * 4
			const [vectorOutcome, textOutcome] = await Promise.allSettled([
				runVectorLane(laneLimit),
				runTextLane(laneLimit),
			])
			const failure = [vectorOutcome, textOutcome].find(
				(outcome) => outcome.status === "rejected",
			)
			if (
				failure?.status === "rejected" &&
				(opts.strict ||
					(vectorOutcome.status === "rejected" &&
						textOutcome.status === "rejected"))
			) {
				throw failure.reason
			}
			if (
				vectorOutcome.status === "fulfilled" &&
				textOutcome.status === "fulfilled"
			) {
				return mergeHybridResultsMongoDB({
					vector: vectorOutcome.value,
					keyword: textOutcome.value,
					maxResults: opts.maxResults,
					vectorWeight: KB_FUSION_VECTOR_WEIGHT,
					textWeight: KB_FUSION_TEXT_WEIGHT,
				}).filter((result) => result.score >= opts.minScore)
			}
			vectorLaneFulfilled = vectorOutcome.status === "fulfilled"
			textLaneFulfilled = textOutcome.status === "fulfilled"
			const lane = vectorLaneFulfilled
				? "kb:js-merge:keyword"
				: "kb:js-merge:vector"
			if (failure?.status === "rejected") {
				log.warn("KB js-merge branch failed", {
					lane,
					...settledFailureMeta(failure.reason),
				})
				try {
					opts.onLaneFailure?.(lane, failure.reason)
				} catch {
					// A diagnostic hook must not discard a successful search.
				}
			}
			const survivor =
				vectorOutcome.status === "fulfilled"
					? vectorOutcome.value
					: textOutcome.status === "fulfilled"
						? textOutcome.value
						: []
			const results = survivor
				.filter((result) => result.score >= opts.minScore)
				.slice(0, opts.maxResults)
			if (results.length > 0) return results
		} catch (err) {
			if (opts.strict) {
				throw err
			}
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(
				`KB hybrid search (js-merge) failed, falling back to individual lanes: ${msg}`,
			)
			opts.onLaneFailure?.("kb:js-merge", err)
		}
	}

	// Try vector search (vector-only fallback)
	if (canVector && !vectorLaneFulfilled) {
		try {
			const results = (await runVectorLane(opts.maxResults)).filter(
				(result) => result.score >= opts.minScore,
			)
			if (results.length > 0) {
				return results
			}
		} catch (err) {
			if (opts.strict) {
				throw err
			}
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB vector search failed: ${msg}`)
			opts.onLaneFailure?.("kb:vector", err)
		}
	}

	// Keyword search fallback using $search
	if (canText && !textLaneFulfilled) {
		try {
			return (await runTextLane(opts.maxResults * 4))
				.filter((r) => r.score >= opts.minScore)
				.slice(0, opts.maxResults)
		} catch (err) {
			if (opts.strict) {
				throw err
			}
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB keyword search failed: ${msg}`)
			opts.onLaneFailure?.("kb:keyword", err)
		}
	}

	// Last resort: basic $text index search
	// RET-16: the $text fallback is a billable aggregation (EL-036) like
	// every other search stage — it bypasses runSearchAggregateWithRetry,
	// so it consumes the budget directly and carries the user-search
	// maxTimeMS ceiling. Refusal degrades to empty (empty ≠ error), never
	// an error.
	if (!tryConsumeSearchAggregation()) {
		return []
	}
	try {
		const filter: Document = { $text: { $search: query } }
		if (chunkFilter) {
			Object.assign(filter, chunkFilter)
		}
		const docs = await kbChunks
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
							docId: 1,
							// RET-11 wave-3e followup: match the vector/text
							// projections above.
							expiresAt: 1,
							updatedAt: 1,
							score: { $meta: "textScore" },
						},
					},
					{ $sort: { score: { $meta: "textScore" } } },
					{ $limit: opts.maxResults },
				],
				{ maxTimeMS: resolveUserSearchMaxTimeMs() },
			)
			.toArray()
		return docs.map(toKBSearchResult).filter((r) => r.score >= opts.minScore)
	} catch (err) {
		if (opts.strict) {
			throw err
		}
		log.warn("KB $text search fallback also failed; returning empty results")
		opts.onLaneFailure?.("kb:$text", err)
		return []
	}
}
