import type { Collection, Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import type { EmbeddingStatusCoverage } from "./mongodb-embedding-retry.js"
import {
	chunksCollection,
	filesCollection,
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
	unknown: number
	total: number
	coveragePercent: number | null
	basis: "stored-vector" | "search-index"
}

export type MemoryStatsOptions = {
	embeddingMode?: "automated" | "client"
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
	staleFiles: string[]
	collectionSizes: {
		files: number
		chunks: number
	}
	indexStats: IndexStatsEntry[]
}

export async function getMemoryStats(
	db: Db,
	prefix: string,
	validPaths?: Set<string>,
	options: MemoryStatsOptions = {},
): Promise<MemoryStats> {
	const chunksCol = chunksCollection(db, prefix)
	const filesCol = filesCollection(db, prefix)

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

	const embeddingMode = options.embeddingMode ?? "client"
	const chunkMeasurement = await measureEmbeddingCoverage({
		collection: chunksCol,
		indexName: `${prefix}chunks_vector`,
		embeddingMode,
	})
	const withEmb = chunkMeasurement.success
	const totalChunks = chunkMeasurement.total
	const embeddingCoverage: EmbeddingCoverage = {
		withEmbedding: withEmb,
		withoutEmbedding: chunkMeasurement.pending,
		unknown: chunkMeasurement.unknown,
		total: totalChunks,
		coveragePercent:
			chunkMeasurement.unknown > 0
				? null
				: totalChunks > 0
					? Math.round((withEmb / totalChunks) * 100)
					: 0,
		basis: chunkMeasurement.basis,
	}

	// Embedding status coverage (across chunks, kb_chunks, and structured_mem)
	const embeddingStatusCoverage = await aggregateEmbeddingStatusCoverage(
		db,
		prefix,
		embeddingMode,
	)

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
		`stats: files=${totalFiles} chunks=${totalChunks} ` +
			`embeddingStatus={basis=${embeddingStatusCoverage.basis},success=${embeddingStatusCoverage.success},failed=${embeddingStatusCoverage.failed},pending=${embeddingStatusCoverage.pending},unknown=${embeddingStatusCoverage.unknown}} ` +
			`stale=${staleFiles.length}`,
	)

	return {
		sources,
		totalFiles,
		totalChunks,
		embeddingCoverage,
		embeddingStatusCoverage,
		staleFiles,
		collectionSizes: {
			files: totalFiles,
			chunks: totalChunks,
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

type EmbeddingCoverageMeasurement = EmbeddingStatusCoverage

/**
 * Upper bound on the coverage probe below. numCandidates and limit are both
 * capped at 10k by the server, so a collection larger than this cannot be
 * measured in one query — and we report unknown rather than a partial count
 * dressed up as a total.
 */
const MAX_COVERAGE_PROBE_DOCS = 10_000

/** Any non-empty text works; autoEmbed embeds it and ANN returns every doc. */
const COVERAGE_PROBE_QUERY = "coverage probe"

/**
 * Counts how many documents the vector index will actually return.
 *
 * This exists because Atlas does not report `numDocs` on $listSearchIndexes —
 * only the local atlas-local container does. Keying coverage on that field
 * meant coverage was permanently `unknown` against a real cluster, which is
 * the deployment that matters.
 *
 * Counting what the index will serve is also the better question: coverage
 * should mean "retrievable", not "claimed by a metadata field".
 *
 * Returns null when the probe cannot answer, so the caller can report unknown
 * rather than guess.
 */
async function countRetrievableViaVectorIndex(params: {
	collection: Collection
	indexName: string
	path: string
	limit: number
}): Promise<number | null> {
	try {
		const rows: Document[] = await params.collection
			.aggregate([
				{
					$vectorSearch: {
						index: params.indexName,
						path: params.path,
						query: COVERAGE_PROBE_QUERY,
						numCandidates: params.limit,
						limit: params.limit,
					},
				},
				{ $count: "n" },
			])
			.toArray()
		const n = rows[0]?.n
		return typeof n === "number" && Number.isFinite(n) && n >= 0
			? Math.floor(n)
			: null
	} catch {
		return null
	}
}

export async function measureEmbeddingCoverage(params: {
	collection: Collection
	indexName: string
	embeddingMode: "automated" | "client"
}): Promise<EmbeddingCoverageMeasurement> {
	if (params.embeddingMode === "client") {
		try {
			const rows: Document[] = await params.collection
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
			const row = rows[0]
			const total = typeof row?.total === "number" ? row.total : 0
			const success =
				typeof row?.withEmbedding === "number" ? row.withEmbedding : 0
			return {
				total,
				success,
				failed: 0,
				pending: Math.max(0, total - success),
				unknown: 0,
				basis: "stored-vector",
			}
		} catch {
			return {
				total: 0,
				success: 0,
				failed: 0,
				pending: 0,
				unknown: 0,
				basis: "stored-vector",
			}
		}
	}

	let total = 0
	try {
		total = await params.collection.countDocuments()
		const indexes = await params.collection
			.aggregate([{ $listSearchIndexes: { name: params.indexName } }])
			.toArray()
		const index = indexes.find((entry) => entry.name === params.indexName)
		const indexed = index?.numDocs
		const fields = index?.latestDefinition?.fields
		const isAutomatedEmbeddingIndex =
			Array.isArray(fields) &&
			fields.some(
				(field: unknown) =>
					typeof field === "object" &&
					field !== null &&
					(field as { type?: unknown }).type === "autoEmbed",
			)
		const unknownResult: EmbeddingCoverageMeasurement = {
			total,
			success: 0,
			failed: 0,
			pending: 0,
			unknown: total,
			basis: "search-index",
		}
		if (
			index?.status !== "READY" ||
			index.queryable !== true ||
			!isAutomatedEmbeddingIndex
		) {
			return unknownResult
		}

		let indexedCount =
			typeof indexed === "number" && Number.isFinite(indexed) && indexed >= 0
				? Math.floor(indexed)
				: null

		if (indexedCount === null) {
			// Atlas serves a READY, queryable index but reports no numDocs. Ask the
			// index directly how much it will return instead of giving up.
			if (total > MAX_COVERAGE_PROBE_DOCS) {
				return unknownResult
			}
			const autoEmbedPath = (fields as Document[]).find(
				(field) => field?.type === "autoEmbed",
			)?.path
			if (typeof autoEmbedPath !== "string" || !autoEmbedPath.trim()) {
				return unknownResult
			}
			indexedCount = await countRetrievableViaVectorIndex({
				collection: params.collection,
				indexName: params.indexName,
				path: autoEmbedPath,
				limit: Math.max(1, Math.min(total, MAX_COVERAGE_PROBE_DOCS)),
			})
			if (indexedCount === null) {
				return unknownResult
			}
		}

		const success = Math.min(total, indexedCount)
		return {
			total,
			success,
			failed: 0,
			pending: Math.max(0, total - success),
			unknown: 0,
			basis: "search-index",
		}
	} catch {
		return {
			total,
			success: 0,
			failed: 0,
			pending: 0,
			unknown: total,
			basis: "search-index",
		}
	}
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
	embeddingMode: "automated" | "client",
): Promise<EmbeddingStatusCoverage> {
	const [chunks, kb, structured] = embeddableChunkCollections(db, prefix)
	const measurements = await Promise.all([
		measureEmbeddingCoverage({
			collection: chunks,
			indexName: `${prefix}chunks_vector`,
			embeddingMode,
		}),
		measureEmbeddingCoverage({
			collection: kb,
			indexName: `${prefix}kb_chunks_vector`,
			embeddingMode,
		}),
		measureEmbeddingCoverage({
			collection: structured,
			indexName: `${prefix}structured_mem_vector`,
			embeddingMode,
		}),
	])
	return measurements.reduce<EmbeddingStatusCoverage>(
		(total, current) => ({
			total: total.total + current.total,
			success: total.success + current.success,
			failed: total.failed + current.failed,
			pending: total.pending + current.pending,
			unknown: total.unknown + current.unknown,
			basis: current.basis,
		}),
		{
			total: 0,
			success: 0,
			failed: 0,
			pending: 0,
			unknown: 0,
			basis: embeddingMode === "automated" ? "search-index" : "stored-vector",
		},
	)
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
 *
 * CAVEAT (fleet audit P2-4): $indexStats is PER-NODE and resets on restart —
 * on a replica set it reflects only the node this connection reads from, and
 * `accesses: 0` may just mean "this node restarted recently" or "reads go to
 * the other members". Never drop an index on this signal alone; check every
 * node over a full workload cycle.
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
