import type { Collection, Document } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	createSubsystemLogger,
} from "@memongo/lib"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	buildVectorSearchStage,
	MONGODB_MAX_NUM_CANDIDATES,
	runSearchAggregateWithRetry,
	splitAtlasSearchFilter,
	type SearchExplainOptions,
} from "./mongodb-search.js"
import type { MemorySearchResult } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:kb-search")

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
	kbDocs?: Collection
	filter?: { tags?: string[]; category?: string; source?: string }
}): Promise<Document | undefined> {
	const normalized = normalizeKBFilter(params.filter)
	if (!normalized) {
		return undefined
	}
	if (!params.kbDocs) {
		log.warn(
			"KB filter provided but kb document collection is unavailable; ignoring filter",
		)
		return undefined
	}

	const kbDocFilter: Document = {}
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
	return { docId: { $in: docIds } }
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
		filter?: { tags?: string[]; category?: string; source?: string }
		kbDocs?: Collection
		vectorIndexName: string
		textIndexName: string
		capabilities: DetectedCapabilities
		embeddingMode: MemoryMongoDBEmbeddingMode
		numCandidates?: number
		explain?: SearchExplainOptions
	},
): Promise<MemorySearchResult[]> {
	const canVector =
		opts.embeddingMode === "automated"
			? opts.capabilities.vectorSearch
			: queryVector != null && opts.capabilities.vectorSearch

	const canText = opts.capabilities.textSearch
	const chunkFilter = await resolveKBChunkFilter({
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

	// F12: Try hybrid search (rankFusion) when both vector and text are available
	if (canVector && canText && opts.capabilities.rankFusion) {
		try {
			const { compoundFilter, postMatch } = splitAtlasSearchFilter(chunkFilter)
			const vsStage = buildVectorSearchStage({
				queryVector,
				queryText: query,
				embeddingMode: opts.embeddingMode,
				indexName: opts.vectorIndexName,
				numCandidates,
				limit: opts.maxResults,
				filter: chunkFilter,
			})

			if (vsStage) {
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
												compound: {
													must: [{ text: { query, path: "text" } }],
													...(compoundFilter ? { filter: compoundFilter } : {}),
												},
											},
										},
										...(postMatch ? [{ $match: postMatch }] : []),
										{ $limit: opts.maxResults * 4 },
									],
								},
							},
						},
					},
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
							score: { $meta: "searchScore" },
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
									method: "rankFusion",
									...summarizeExplain(explained),
								},
								...(opts.explain.deep ? { rawExplain: explained } : {}),
							})
						}
					} catch {}
				}

				const docs = await runSearchAggregateWithRetry(kbChunks, pipeline)
				const results = docs
					.map(toKBSearchResult)
					.filter((r) => r.score >= opts.minScore)
				if (results.length > 0) {
					return results
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(
				`KB hybrid search ($rankFusion) failed, falling back to vector-only: ${msg}`,
			)
		}
	}

	// Try vector search (vector-only fallback)
	if (canVector) {
		try {
			const vsStage = buildVectorSearchStage({
				queryVector,
				queryText: query,
				embeddingMode: opts.embeddingMode,
				indexName: opts.vectorIndexName,
				numCandidates,
				limit: opts.maxResults,
				filter: chunkFilter,
			})

			if (vsStage) {
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
					} catch {}
				}

				const docs = await runSearchAggregateWithRetry(kbChunks, pipeline)
				const results = docs
					.map(toKBSearchResult)
					.filter((r) => r.score >= opts.minScore)
				if (results.length > 0) {
					return results
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB vector search failed: ${msg}`)
		}
	}

	// Keyword search fallback using $search
	if (canText) {
		try {
			const { compoundFilter, postMatch } = splitAtlasSearchFilter(chunkFilter)
			const pipeline: Document[] = [
				{
					$search: {
						index: opts.textIndexName,
						compound: {
							must: [{ text: { query, path: "text" } }],
							...(compoundFilter ? { filter: compoundFilter } : {}),
						},
						...(opts.explain?.includeScoreDetails
							? { scoreDetails: true }
							: {}),
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
				} catch {}
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
			return docs
				.map(toKBSearchResult)
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
