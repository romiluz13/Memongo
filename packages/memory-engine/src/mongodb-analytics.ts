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
	agentId: string,
	validPaths?: Set<string>,
	options: MemoryStatsOptions = {},
): Promise<MemoryStats> {
	const chunksCol = chunksCollection(db, prefix)
	const filesCol = filesCollection(db, prefix)

	// W13: every volume measurement on this per-agent surface is scoped to the
	// tenant. Physical index diagnostics ($indexStats) are the one exception —
	// they are server metadata, not tenant data, and stay unfiltered below.
	const tenantFilter: Document = { agentId }

	// Per-source file breakdown
	const sourceAgg: Document[] = await filesCol
		.aggregate([
			{ $match: tenantFilter },
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
		.aggregate([
			{ $match: tenantFilter },
			{ $group: { _id: "$source", count: { $sum: 1 } } },
		])
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
		tenantFilter,
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
		agentId,
	)

	// Stale files (in DB but not on disk)
	let staleFiles: string[] = []
	if (validPaths) {
		const docs = await filesCol
			.find(tenantFilter, { projection: { _id: 0, path: 1 } })
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
	// W13: intentionally unfiltered — $indexStats is physical index metadata
	// (server-wide by nature), operational rather than tenant volume.
	const indexStats = await aggregateIndexStats(db, prefix)

	// Collection document counts
	const totalFiles = await filesCol.countDocuments(tenantFilter)

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
 * Measures embedding coverage for one collection.
 *
 * With `tenantFilter` (W13) every count is scoped to the tenant: the
 * stored-vector aggregation is prefixed with `$match` and the total counts
 * only tenant documents. `numDocs` from `$listSearchIndexes` is INDEX-WIDE —
 * it counts every tenant's documents — so when a tenant filter is present it
 * cannot answer a per-tenant question, and Atlas reports no `numDocs` at all.
 * Both cases report `unknown` for the automated (search-index) basis.
 *
 * M2 T10 (G3-75): the former `$vectorSearch` probe is removed. Its text query
 * was embedded server-side on every call, so each `/stats` request spent
 * provider embeddings four times outside the cost ledger. Unknown is the
 * honest answer when the cheap metadata cannot give one. A read that fails
 * rejects: it is never reported as zero coverage.
 */
export async function measureEmbeddingCoverage(params: {
	collection: Collection
	indexName: string
	embeddingMode: "automated" | "client"
	tenantFilter?: Document
}): Promise<EmbeddingCoverageMeasurement> {
	if (params.embeddingMode === "client") {
		const rows: Document[] = await params.collection
			.aggregate([
				...(params.tenantFilter ? [{ $match: params.tenantFilter }] : []),
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
	}

	const total = await params.collection.countDocuments(
		params.tenantFilter ?? {},
	)
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

	// numDocs is index-wide, so it only answers a question that is not
	// tenant-scoped.
	const indexedCount =
		!params.tenantFilter &&
		typeof indexed === "number" &&
		Number.isFinite(indexed) &&
		indexed >= 0
			? Math.floor(indexed)
			: null
	if (indexedCount === null) {
		return unknownResult
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
	agentId: string,
): Promise<EmbeddingStatusCoverage> {
	const [chunks, kb, structured] = embeddableChunkCollections(db, prefix)
	const tenantFilter: Document = { agentId }
	const measurements = await Promise.all([
		measureEmbeddingCoverage({
			collection: chunks,
			indexName: `${prefix}chunks_vector`,
			embeddingMode,
			tenantFilter,
		}),
		measureEmbeddingCoverage({
			collection: kb,
			indexName: `${prefix}kb_chunks_vector`,
			embeddingMode,
			tenantFilter,
		}),
		measureEmbeddingCoverage({
			collection: structured,
			indexName: `${prefix}structured_mem_vector`,
			embeddingMode,
			tenantFilter,
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
