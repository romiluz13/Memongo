import type { Collection, Document } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBQueryEmbeddingModel,
	createSubsystemLogger,
} from "@memongo/lib"
import { mergeHybridResultsMongoDB } from "./mongodb-hybrid.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import {
	consumeSearchAggregationOrThrow,
	resolveUserSearchMaxTimeMs,
} from "./mongodb-search-budget.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
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
	type SearchStage,
	type SearchTierOutcomeSink,
	searchFailureLogFields,
	searchFailureTierRow,
	toTypedSearchError,
} from "./search-outcomes.js"
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
		 * #101 K7: under strict mode a failed js-merge branch fails the lane
		 * instead of letting the surviving branch stand.
		 */
		strict?: boolean
		/** #101: per-call sink for this lane's tier outcome rows. */
		onTierOutcome?: SearchTierOutcomeSink
	},
): Promise<MemorySearchResult[]> {
	// #101 / matrix 1f: zero-hit tiers are kept (a successful empty moves to
	// the next planned tier), but an error or a budget denial is a typed
	// throw at its tier — nothing degrades down the waterfall after a failure.
	const canVector =
		opts.skipVectorLane !== true &&
		(opts.embeddingMode === "automated"
			? opts.capabilities.vectorSearch
			: queryVector != null && opts.capabilities.vectorSearch)

	const canText = opts.capabilities.textSearch
	const report = (stage: SearchStage, count: number): void => {
		opts.onTierOutcome?.({
			stage,
			outcome: count > 0 ? "ok" : "ok-empty",
			...(count > 0 ? {} : { reason: "zero-hits" as const }),
			resultCount: count,
		})
	}
	const emptyQuery = (stage: SearchStage): MemorySearchResult[] => {
		opts.onTierOutcome?.({
			stage,
			outcome: "not-applicable",
			reason: "empty-query",
		})
		return []
	}
	let chunkFilter: Document
	try {
		chunkFilter = await resolveKBChunkFilter({
			scopeRef: opts.scopeRef,
			kbDocs: opts.kbDocs,
			filter: opts.filter,
		})
	} catch (err) {
		throw toTypedSearchError(err, "filter")
	}
	const filteredDocIds = (
		chunkFilter as { docId?: { $in?: string[] } } | undefined
	)?.docId?.$in
	if (Array.isArray(filteredDocIds) && filteredDocIds.length === 0) {
		// K1: the tag/category filter matched no document — a successful empty.
		report("filter", 0)
		return []
	}
	const numCandidates = Math.min(
		opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		MONGODB_MAX_NUM_CANDIDATES,
	)

	// F12/P0.10: server-side hybrid fusion, mirroring the general search
	// path. Fusion is a first-class option (`fusionMethod`), resolved by the
	// manager from `mongodb.fusionMethod`.
	const fusionMethod = opts.fusionMethod ?? "scoreFusion"

	const runKbFusion = async (
		method: "scoreFusion" | "rankFusion",
	): Promise<MemorySearchResult[] | null> => {
		const stage = method === "scoreFusion" ? "score-fusion" : "rank-fusion"
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
			} catch (err) {
				reportExplainFailure(err, opts.onTierOutcome)
			}
		}

		const docs = await runSearchAggregateWithRetry(kbChunks, pipeline, {
			stage,
		})
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

	const runFusionTier = async (
		method: "scoreFusion" | "rankFusion",
	): Promise<MemorySearchResult[]> => {
		const stage = method === "scoreFusion" ? "score-fusion" : "rank-fusion"
		let results: MemorySearchResult[] | null
		try {
			results = await runKbFusion(method)
		} catch (err) {
			throw toTypedSearchError(err, stage)
		}
		if (results === null) {
			return emptyQuery(stage)
		}
		report(stage, results.length)
		return results
	}

	if (canVector && canText && fusionMethod !== "js-merge") {
		if (fusionMethod === "scoreFusion" && opts.capabilities.scoreFusion) {
			const results = await runFusionTier("scoreFusion")
			if (results.length > 0) {
				return results
			}
		}
		if (opts.capabilities.rankFusion) {
			const results = await runFusionTier("rankFusion")
			if (results.length > 0) {
				return results
			}
		}
	}

	const runVectorLane = async (
		limit: number,
	): Promise<MemorySearchResult[] | null> => {
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
			stage: "vector",
		})

		if (!vsStage) {
			return null
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
			} catch (err) {
				reportExplainFailure(err, opts.onTierOutcome)
			}
		}
		try {
			const docs = await runSearchAggregateWithRetry(kbChunks, pipeline, {
				stage: "vector",
			})
			return docs.map(toKBSearchResult)
		} catch (err) {
			throw toTypedSearchError(err, "vector")
		}
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
			} catch (err) {
				reportExplainFailure(err, opts.onTierOutcome)
			}
		}
		let docs: Document[]
		try {
			docs = await runSearchAggregateWithRetry(kbChunks, pipeline, {
				stage: "keyword",
			})
		} catch (err) {
			throw toTypedSearchError(err, "keyword")
		}
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
		// K7: both branches run; a failed branch is its own row and the
		// survivor stands (the lane is partial). Nothing runs after an error.
		const laneLimit = opts.maxResults * 4
		const [vectorOutcome, textOutcome] = await Promise.allSettled([
			runVectorLane(laneLimit),
			runTextLane(laneLimit),
		])
		if (
			vectorOutcome.status === "rejected" &&
			textOutcome.status === "rejected"
		) {
			opts.onTierOutcome?.(
				searchFailureTierRow(
					"keyword",
					toTypedSearchError(textOutcome.reason, "keyword"),
				),
			)
			throw toTypedSearchError(vectorOutcome.reason, "vector")
		}
		const failed =
			vectorOutcome.status === "rejected"
				? { stage: "vector" as const, reason: vectorOutcome.reason }
				: textOutcome.status === "rejected"
					? { stage: "keyword" as const, reason: textOutcome.reason }
					: null
		if (failed) {
			const typed = toTypedSearchError(failed.reason, failed.stage)
			if (opts.strict) {
				throw typed
			}
			log.warn("KB js-merge branch failed", {
				stage: failed.stage,
				...searchFailureLogFields(typed),
			})
			opts.onTierOutcome?.(searchFailureTierRow(failed.stage, typed))
		}
		const vectorHits =
			vectorOutcome.status === "fulfilled" ? vectorOutcome.value : undefined
		const textHits =
			textOutcome.status === "fulfilled" ? textOutcome.value : undefined
		if (vectorHits === null) {
			emptyQuery("vector")
		} else if (vectorHits) {
			report("vector", vectorHits.length)
		}
		if (textHits) {
			report("keyword", textHits.length)
		}
		if (vectorHits && textHits) {
			return mergeHybridResultsMongoDB({
				vector: vectorHits,
				keyword: textHits,
				maxResults: opts.maxResults,
				vectorWeight: KB_FUSION_VECTOR_WEIGHT,
				textWeight: KB_FUSION_TEXT_WEIGHT,
			}).filter((result) => result.score >= opts.minScore)
		}
		return (vectorHits ?? textHits ?? [])
			.filter((result) => result.score >= opts.minScore)
			.slice(0, opts.maxResults)
	}

	// Vector tier (K6/K8): a zero hit moves on; an error stops the lane.
	if (canVector) {
		const hits = await runVectorLane(opts.maxResults)
		if (hits === null) {
			emptyQuery("vector")
		} else {
			const results = hits.filter((result) => result.score >= opts.minScore)
			report("vector", results.length)
			if (results.length > 0) {
				return results
			}
		}
	}

	// Keyword tier (K9) on the kb_chunks_text Search index.
	if (canText) {
		const results = (await runTextLane(opts.maxResults * 4))
			.filter((r) => r.score >= opts.minScore)
			.slice(0, opts.maxResults)
		report("keyword", results.length)
		return results
	}

	// R5/K11: classic $text is the planned lexical tier only where Search is
	// absent — idx_kbchunks_text exists by that same rule. RET-16: it is a
	// billable aggregation carrying the user-search maxTimeMS ceiling; a
	// refusal is a typed budget denial (K10).
	if (!query.trim()) {
		return emptyQuery("classic-text")
	}
	consumeSearchAggregationOrThrow("classic-text")
	let docs: Document[]
	try {
		const filter: Document = { $text: { $search: query } }
		if (chunkFilter) {
			Object.assign(filter, chunkFilter)
		}
		docs = await kbChunks
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
	} catch (err) {
		throw toTypedSearchError(err, "classic-text")
	}
	const results = docs
		.map(toKBSearchResult)
		.filter((r) => r.score >= opts.minScore)
	report("classic-text", results.length)
	return results
}
