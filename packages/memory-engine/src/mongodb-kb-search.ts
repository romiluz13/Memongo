import type { Collection, Document } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBQueryEmbeddingModel,
	createSubsystemLogger,
} from "@memongo/lib"
import { mergeHybridResultsMongoDB } from "./mongodb-hybrid.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	buildVectorSearchStage,
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
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
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
	},
): Promise<MemorySearchResult[]> {
	const canVector =
		opts.embeddingMode === "automated"
			? opts.capabilities.vectorSearch
			: queryVector != null && opts.capabilities.vectorSearch

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
	const fusionMethod = opts.fusionMethod ?? "rankFusion"

	const runKbFusion = async (
		method: "scoreFusion" | "rankFusion",
	): Promise<MemorySearchResult[] | null> => {
		const { compoundFilter, postMatch } = splitAtlasSearchFilter(chunkFilter)
		const vsStage = buildVectorSearchStage({
			queryVector,
			queryText: query,
			embeddingMode: opts.embeddingMode,
			model: opts.queryEmbeddingModel,
			indexName: opts.vectorIndexName,
			numCandidates,
			limit: opts.maxResults,
			filter: chunkFilter,
			returnStoredSource: opts.capabilities.storedSource,
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
			...(postMatch ? [{ $match: postMatch }] : []),
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
									vector: [{ $vectorSearch: vsStage }],
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
									vector: [{ $vectorSearch: vsStage }],
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
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`KB hybrid search ($scoreFusion) failed, falling back to $rankFusion: ${msg}`,
				)
			}
		}
		if (opts.capabilities.rankFusion) {
			try {
				const results = await runKbFusion("rankFusion")
				if (results && results.length > 0) {
					return results
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`KB hybrid search ($rankFusion) failed, falling back to vector-only: ${msg}`,
				)
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
			returnStoredSource: opts.capabilities.storedSource,
		})

		if (!vsStage) {
			return []
		}
		const pipeline: Document[] = [
			{ $vectorSearch: vsStage },
			{ $limit: limit },
			{
				$project: {
					_id: 0,
					path: 1,
					startLine: 1,
					endLine: 1,
					text: 1,
					docId: 1,
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
		const { compoundFilter, postMatch } = splitAtlasSearchFilter(chunkFilter)
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
			...(postMatch ? [{ $match: postMatch }] : []),
			{ $limit: limit },
			{
				$project: {
					_id: 0,
					path: 1,
					startLine: 1,
					endLine: 1,
					text: 1,
					docId: 1,
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

	if (canVector && canText && fusionMethod === "js-merge") {
		try {
			const laneLimit = opts.maxResults * 4
			const [vectorResults, textResults] = await Promise.all([
				runVectorLane(laneLimit),
				runTextLane(laneLimit),
			])
			return mergeHybridResultsMongoDB({
				vector: vectorResults,
				keyword: textResults,
				maxResults: opts.maxResults,
				vectorWeight: KB_FUSION_VECTOR_WEIGHT,
				textWeight: KB_FUSION_TEXT_WEIGHT,
			}).filter((result) => result.score >= opts.minScore)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(
				`KB hybrid search (js-merge) failed, falling back to individual lanes: ${msg}`,
			)
		}
	}

	// Try vector search (vector-only fallback)
	if (canVector) {
		try {
			const results = (await runVectorLane(opts.maxResults)).filter(
				(result) => result.score >= opts.minScore,
			)
			if (results.length > 0) {
				return results
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB vector search failed: ${msg}`)
		}
	}

	// Keyword search fallback using $search
	if (canText) {
		try {
			return (await runTextLane(opts.maxResults * 4))
				.filter((r) => r.score >= opts.minScore)
				.slice(0, opts.maxResults)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB keyword search failed: ${msg}`)
		}
	}

	// Last resort: basic $text index search
	try {
		const filter: Document = { $text: { $search: query } }
		if (chunkFilter) {
			Object.assign(filter, chunkFilter)
		}
		const docs = await kbChunks
			.aggregate([
				{ $match: filter },
				{
					$project: {
						_id: 0,
						path: 1,
						startLine: 1,
						endLine: 1,
						text: 1,
						docId: 1,
						updatedAt: 1,
						score: { $meta: "textScore" },
					},
				},
				{ $sort: { score: { $meta: "textScore" } } },
				{ $limit: opts.maxResults },
			])
			.toArray()
		return docs.map(toKBSearchResult).filter((r) => r.score >= opts.minScore)
	} catch {
		log.warn("KB $text search fallback also failed; returning empty results")
		return []
	}
}
