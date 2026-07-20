import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import type { EmbeddingStatusCoverage } from "./mongodb-embedding-retry.js"
import {
	chunksCollection,
	filesCollection,
	embeddingCacheCollection,
	kbChunksCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"

const log = createSubsystemLogger("memory:mongodb:analytics")

export type MemorySourceStats = {
	source: string
	fileCount: number
	chunkCount: number
	lastSync: Date | null
}

export type EmbeddingCoverage = {
	withEmbedding: number
	withoutEmbedding: number
	total: number
	coveragePercent: number
}

export type IndexStatsEntry = {
	collection: string
	name: string
	accesses: number
	since: Date | null
}

export type MemoryStats = {
	sources: MemorySourceStats[]
	totalFiles: number
	totalChunks: number
	embeddingCoverage: EmbeddingCoverage
	embeddingStatusCoverage: EmbeddingStatusCoverage
	cachedEmbeddings: number
	staleFiles: string[]
	collectionSizes: {
		files: number
		chunks: number
		embeddingCache: number
	}
	indexStats: IndexStatsEntry[]
}

export async function getMemoryStats(
	db: Db,
	prefix: string,
	validPaths?: Set<string>,
): Promise<MemoryStats> {
	const chunksCol = chunksCollection(db, prefix)
	const filesCol = filesCollection(db, prefix)
	const cacheCol = embeddingCacheCollection(db, prefix)

	// Per-source file breakdown
	const sourceAgg: Document[] = await filesCol
		.aggregate([
			{
				$group: {
					_id: "$source",
					count: { $sum: 1 },
					lastSync: { $max: "$updatedAt" },
				},
			},
		])
		.toArray()

	const sources: MemorySourceStats[] = sourceAgg.map((doc) => ({
		source: String(doc._id ?? "unknown"),
		fileCount: doc.count as number,
		chunkCount: 0, // filled below
		lastSync: doc.lastSync instanceof Date ? doc.lastSync : null,
	}))

	// Per-source chunk counts
	const chunkSourceAgg: Document[] = await chunksCol
		.aggregate([{ $group: { _id: "$source", count: { $sum: 1 } } }])
		.toArray()

	for (const doc of chunkSourceAgg) {
		const src = sources.find((s) => s.source === String(doc._id))
		if (src) {
			src.chunkCount = doc.count as number
		}
	}

	// Embedding coverage
	const embeddingAgg: Document[] = await chunksCol
		.aggregate([
			{
				$group: {
					_id: null,
					withEmbedding: {
						$sum: {
							$cond: [
								{ $gt: [{ $size: { $ifNull: ["$embedding", []] } }, 0] },
								1,
								0,
							],
						},
					},
					total: { $sum: 1 },
				},
			},
		])
		.toArray()

	const embRow = embeddingAgg[0] ?? { withEmbedding: 0, total: 0 }
	const withEmb = embRow.withEmbedding as number
	const totalChunks = embRow.total as number
	const embeddingCoverage: EmbeddingCoverage = {
		withEmbedding: withEmb,
		withoutEmbedding: totalChunks - withEmb,
		total: totalChunks,
		coveragePercent:
			totalChunks > 0 ? Math.round((withEmb / totalChunks) * 100) : 0,
	}

	// Embedding status coverage (across chunks, kb_chunks, and structured_mem)
	const embeddingStatusCoverage = await aggregateEmbeddingStatusCoverage(
		db,
		prefix,
	)

	// Cached embeddings count
	const cachedEmbeddings = await cacheCol.countDocuments()

	// Stale files (in DB but not on disk)
	let staleFiles: string[] = []
	if (validPaths) {
		const docs = await filesCol
			.find({}, { projection: { _id: 0, path: 1 } })
			.toArray()
		staleFiles = Array.from(
			new Set(
				docs
					.map((doc) => (typeof doc.path === "string" ? doc.path : null))
					.filter((entry): entry is string => Boolean(entry))
					.filter((entry) => !validPaths.has(entry)),
			),
		)
	}

	// $indexStats: show which indexes are used and which are unused
	const indexStats = await aggregateIndexStats(db, prefix)

	// Collection document counts
	const totalFiles = await filesCol.countDocuments()

	log.info(
		`stats: files=${totalFiles} chunks=${totalChunks} cached=${cachedEmbeddings} ` +
			`embeddingStatus={success=${embeddingStatusCoverage.success},failed=${embeddingStatusCoverage.failed},pending=${embeddingStatusCoverage.pending}} ` +
			`stale=${staleFiles.length}`,
	)

	return {
		sources,
		totalFiles,
		totalChunks,
		embeddingCoverage,
		embeddingStatusCoverage,
		cachedEmbeddings,
		staleFiles,
		collectionSizes: {
			files: totalFiles,
			chunks: totalChunks,
			embeddingCache: cachedEmbeddings,
		},
		indexStats,
	}
}

// Collections whose documents carry (or are expected to carry) an embedding
// vector queried by vector search.
function embeddableChunkCollections(db: Db, prefix: string) {
	return [
		chunksCollection(db, prefix),
		kbChunksCollection(db, prefix),
		structuredMemCollection(db, prefix),
	]
}

/**
 * Embedding coverage across all chunk collections (chunks, kb_chunks,
 * structured_mem).
 *
 * #26: the `embeddingStatus` field is written as "pending" by every writer and
 * never advanced, so grouping on it produced a fabricated, always-pending
 * coverage number. Instead derive coverage from the REAL signal — whether the
 * document actually carries a non-empty `embedding` vector (the field the vector
 * index queries) — so the reported number reflects reality.
 *
 * NOTE (autoEmbed): with Atlas autoEmbed the vector is generated and stored by
 * Atlas in a managed collection, NOT on the document, so on-document presence
 * understates coverage in that mode. Confirming autoEmbed queryability requires
 * a live vector-search probe against the atlas-local + mongot stack (doctor
 * probe / e2e); that is out of scope for this in-process aggregation.
 */
async function aggregateEmbeddingStatusCoverage(
	db: Db,
	prefix: string,
): Promise<EmbeddingStatusCoverage> {
	let total = 0
	let success = 0

	for (const col of embeddableChunkCollections(db, prefix)) {
		try {
			const agg: Document[] = await col
				.aggregate([
					{
						$group: {
							_id: null,
							total: { $sum: 1 },
							withEmbedding: {
								$sum: {
									$cond: [
										{ $gt: [{ $size: { $ifNull: ["$embedding", []] } }, 0] },
										1,
										0,
									],
								},
							},
						},
					},
				])
				.toArray()

			const row = agg[0]
			if (row) {
				total += (row.total as number) ?? 0
				success += (row.withEmbedding as number) ?? 0
			}
		} catch {
			// Collection may not exist yet — ignore
		}
	}

	// `failed` is not derivable from on-document presence alone; only genuinely
	// embedded (success) vs not-yet-embedded (pending) are reported honestly.
	return { total, success, failed: 0, pending: total - success }
}

/**
 * #26 reconciliation: advance the stored `embeddingStatus` field to "success"
 * for documents that actually carry an embedding vector, so the persisted field
 * stops lying (it was written "pending" and never advanced). Returns how many
 * documents were advanced. Documents without an on-document vector are left as
 * pending — for autoEmbed collections their queryability must be confirmed via a
 * live vector-search probe, not this sweep.
 */
export async function reconcileEmbeddingStatus(
	db: Db,
	prefix: string,
): Promise<{ advanced: number }> {
	let advanced = 0
	for (const col of embeddableChunkCollections(db, prefix)) {
		try {
			const res = await col.updateMany(
				{
					"embedding.0": { $exists: true },
					embeddingStatus: { $ne: "success" },
				},
				{ $set: { embeddingStatus: "success" } },
			)
			advanced += res.modifiedCount ?? 0
		} catch {
			// Collection may not exist yet — ignore
		}
	}
	return { advanced }
}

/**
 * Aggregate $indexStats across key collections (chunks, kb_chunks, structured_mem).
 * Returns per-index access counts so users can identify unused indexes.
 * Fails gracefully if $indexStats is not supported (e.g., some MongoDB versions).
 */
async function aggregateIndexStats(
	db: Db,
	prefix: string,
): Promise<IndexStatsEntry[]> {
	const collectionsToCheck: Array<{
		col: ReturnType<typeof chunksCollection>
		label: string
	}> = [
		{ col: chunksCollection(db, prefix), label: `${prefix}chunks` },
		{ col: kbChunksCollection(db, prefix), label: `${prefix}kb_chunks` },
		{
			col: structuredMemCollection(db, prefix),
			label: `${prefix}structured_mem`,
		},
	]

	const results: IndexStatsEntry[] = []

	for (const { col, label } of collectionsToCheck) {
		try {
			const stats: Document[] = await col
				.aggregate([{ $indexStats: {} }])
				.toArray()
			for (const stat of stats) {
				results.push({
					collection: label,
					name: String(stat.name ?? "unknown"),
					accesses:
						typeof stat.accesses?.ops === "number" ? stat.accesses.ops : 0,
					since:
						stat.accesses?.since instanceof Date ? stat.accesses.since : null,
				})
			}
		} catch {
			// $indexStats may not be supported — skip this collection
		}
	}

	return results
}
