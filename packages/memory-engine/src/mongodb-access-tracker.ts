/**
 * AccessTracker — batched access-event persistence backed by a time series
 * collection plus computed summary fields on canonical memory documents.
 *
 * Raw access history is stored in `access_events` for trend analysis, while the
 * denormalized `accessCount` / `lastAccessedAt` fields remain updated on the
 * canonical collections so existing scoring paths keep working.
 */

import type { AnyBulkWriteOperation, Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import {
	accessEventsCollection,
	entitiesCollection,
	episodesCollection,
	eventsCollection,
	proceduresCollection,
	relationsCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import type {
	AccessEventCollection,
	AccessEventDocument,
	AccessTrackerConfig,
	MemoryAccessSummary,
	MemoryAccessTrend,
} from "./types.js"

export type { AccessTrackerConfig }

const log = createSubsystemLogger("memory:mongodb:access-tracker")

const DAY_MS = 24 * 60 * 60 * 1000

const COLLECTION_ID_FIELDS: Record<AccessEventCollection, string> = {
	events: "eventId",
	structured_mem: "key",
	procedures: "procedureId",
	episodes: "episodeId",
	entities: "entityId",
	relations: "relationId",
}

function getCanonicalCollection(
	db: Db,
	prefix: string,
	collection: AccessEventCollection,
) {
	switch (collection) {
		case "events":
			return eventsCollection(db, prefix)
		case "structured_mem":
			return structuredMemCollection(db, prefix)
		case "procedures":
			return proceduresCollection(db, prefix)
		case "episodes":
			return episodesCollection(db, prefix)
		case "entities":
			return entitiesCollection(db, prefix)
		case "relations":
			return relationsCollection(db, prefix)
	}
}

type TrendTarget = {
	collection: AccessEventCollection
	memoryId: string
}

export class AccessTracker {
	private buffer: Map<
		string,
		{ collection: AccessEventCollection; count: number }
	>
	private readonly config: Required<AccessTrackerConfig>
	private timer: ReturnType<typeof setInterval> | null = null
	private totalBuffered = 0
	private pendingFlush: Promise<number> | null = null

	constructor(
		private readonly db: Db,
		private readonly prefix: string,
		private readonly agentId: string,
		config?: AccessTrackerConfig,
	) {
		this.buffer = new Map()
		this.config = {
			flushThreshold: config?.flushThreshold ?? 10,
			flushIntervalMs: config?.flushIntervalMs ?? 60_000,
		}
		this.timer = setInterval(() => {
			if (this.buffer.size === 0 || this.pendingFlush) {
				return
			}
			void this.startBackgroundFlush("interval")
		}, this.config.flushIntervalMs)
	}

	recordAccess(id: string, collection: AccessEventCollection): void {
		const key = `${collection}::${id}`
		const entry = this.buffer.get(key)
		if (entry) {
			entry.count++
		} else {
			this.buffer.set(key, { collection, count: 1 })
		}
		this.totalBuffered++

		if (
			this.totalBuffered >= this.config.flushThreshold &&
			!this.pendingFlush
		) {
			void this.startBackgroundFlush("threshold")
		}
	}

	async flush(): Promise<number> {
		let updated = 0
		if (this.pendingFlush) {
			updated += await this.pendingFlush
		}
		if (this.buffer.size === 0) {
			return updated
		}
		updated += await this.startBackgroundFlush("explicit")
		return updated
	}

	private startBackgroundFlush(reason: "interval" | "threshold" | "explicit") {
		if (this.pendingFlush) {
			return this.pendingFlush
		}

		const run = this.doFlush()
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(`access tracker ${reason} flush failed: ${msg}`)
				return 0
			})
			.finally(() => {
				if (this.pendingFlush === run) {
					this.pendingFlush = null
				}
			})

		this.pendingFlush = run
		return run
	}

	/**
	 * Merge a snapshot back into the live buffer. Used by the deadletter path
	 * so a flush failure does NOT drop access counts. Counts are summed when
	 * the same key already exists in the live buffer (another recordAccess()
	 * call may have landed while the flush was in-flight).
	 */
	private rebufferSnapshot(
		snapshot: Map<string, { collection: AccessEventCollection; count: number }>,
	): void {
		for (const [key, entry] of snapshot) {
			const existing = this.buffer.get(key)
			if (existing) {
				existing.count += entry.count
			} else {
				this.buffer.set(key, {
					collection: entry.collection,
					count: entry.count,
				})
			}
			this.totalBuffered += entry.count
		}
	}

	private async doFlush(): Promise<number> {
		const snapshot = new Map(this.buffer)
		this.buffer.clear()
		this.totalBuffered = 0

		const now = new Date()
		const eventDocs: AccessEventDocument[] = []
		const collectionOps = new Map<
			AccessEventCollection,
			Array<AnyBulkWriteOperation<Document>>
		>()

		for (const [key, entry] of snapshot) {
			const memoryId = key.slice(entry.collection.length + 2)
			eventDocs.push({
				ts: now,
				meta: {
					agentId: this.agentId,
					collection: entry.collection,
					memoryId,
				},
				count: entry.count,
			})

			const idField = COLLECTION_ID_FIELDS[entry.collection]
			const ops = collectionOps.get(entry.collection) ?? []
			ops.push({
				updateOne: {
					filter: { [idField]: memoryId },
					update: {
						$inc: { accessCount: entry.count },
						$set: { lastAccessedAt: now },
					},
				},
			})
			collectionOps.set(entry.collection, ops)
		}

		// Access-event durability: re-buffer the ENTIRE snapshot on any error so
		// no access counts are lost. Previously, a failing insertMany or bulk
		// write silently swallowed the counts. Now the next flush retries.
		if (eventDocs.length > 0) {
			try {
				await accessEventsCollection(this.db, this.prefix).insertMany(
					eventDocs,
					{
						ordered: false,
					},
				)
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`access event insert failed (re-buffering ${snapshot.size} keys for retry): ${msg}`,
				)
				this.rebufferSnapshot(snapshot)
				return 0
			}
		}

		let updated = 0
		for (const [collection, ops] of collectionOps) {
			try {
				const result = await getCanonicalCollection(
					this.db,
					this.prefix,
					collection,
				).bulkWrite(ops, { ordered: false })
				updated += result.modifiedCount ?? ops.length
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`access summary flush failed for ${collection} (re-buffering ${ops.length} ops for retry): ${msg}`,
				)
				// Re-buffer only the failed collection's keys, not the whole
				// snapshot: the access_events insert already succeeded for
				// them and the other collections' bulkWrites may have too.
				for (const [key, entry] of snapshot) {
					if (entry.collection !== collection) {
						continue
					}
					const existing = this.buffer.get(key)
					if (existing) {
						existing.count += entry.count
					} else {
						this.buffer.set(key, {
							collection: entry.collection,
							count: entry.count,
						})
					}
					this.totalBuffered += entry.count
				}
			}
		}

		return updated
	}

	async close(): Promise<void> {
		if (this.timer !== null) {
			clearInterval(this.timer)
			this.timer = null
		}
		await this.flush()
	}
}

export async function getAccessSummaries(params: {
	db: Db
	prefix: string
	agentId: string
	collection: AccessEventCollection
	memoryIds: string[]
	windowDays?: number
}): Promise<MemoryAccessSummary[]> {
	if (params.memoryIds.length === 0) {
		return []
	}

	const since = new Date(Date.now() - (params.windowDays ?? 30) * DAY_MS)
	const rows = await accessEventsCollection(params.db, params.prefix)
		.aggregate([
			{
				$match: {
					"meta.agentId": params.agentId,
					"meta.collection": params.collection,
					"meta.memoryId": { $in: params.memoryIds },
					ts: { $gte: since },
				},
			},
			{
				$group: {
					_id: "$meta.memoryId",
					accessCount: { $sum: "$count" },
					lastAccessedAt: { $max: "$ts" },
				},
			},
		])
		.toArray()

	return rows.map((row) => ({
		memoryId: String(row._id),
		collection: params.collection,
		accessCount:
			typeof row.accessCount === "number"
				? row.accessCount
				: Number(row.accessCount ?? 0),
		lastAccessedAt:
			row.lastAccessedAt instanceof Date ? row.lastAccessedAt : undefined,
	}))
}

async function resolveTrendTargets(params: {
	db: Db
	prefix: string
	agentId: string
	collection?: AccessEventCollection
	memoryIds?: string[]
	windowDays: number
	limit: number
}): Promise<TrendTarget[]> {
	if (params.memoryIds && params.memoryIds.length > 0) {
		if (params.collection) {
			return params.memoryIds.map((memoryId) => ({
				collection: params.collection!,
				memoryId,
			}))
		}
		const rows = await accessEventsCollection(params.db, params.prefix)
			.aggregate([
				{
					$match: {
						"meta.agentId": params.agentId,
						"meta.memoryId": { $in: params.memoryIds },
						ts: {
							$gte: new Date(Date.now() - params.windowDays * DAY_MS),
						},
					},
				},
				{
					$group: {
						_id: {
							collection: "$meta.collection",
							memoryId: "$meta.memoryId",
						},
					},
				},
			])
			.toArray()
		return rows.map((row) => ({
			collection: row._id.collection as AccessEventCollection,
			memoryId: String(row._id.memoryId),
		}))
	}

	const since = new Date(Date.now() - params.windowDays * DAY_MS)
	const rows = await accessEventsCollection(params.db, params.prefix)
		.aggregate([
			{
				$match: {
					"meta.agentId": params.agentId,
					...(params.collection
						? { "meta.collection": params.collection }
						: {}),
					ts: { $gte: since },
				},
			},
			{
				$group: {
					_id: {
						collection: "$meta.collection",
						memoryId: "$meta.memoryId",
					},
					totalCount: { $sum: "$count" },
				},
			},
			{ $sort: { totalCount: -1 } },
			{ $limit: params.limit },
		])
		.toArray()

	return rows.map((row) => ({
		collection: row._id.collection as AccessEventCollection,
		memoryId: String(row._id.memoryId),
	}))
}

export async function getAccessTrends(params: {
	db: Db
	prefix: string
	agentId: string
	collection?: AccessEventCollection
	memoryIds?: string[]
	windowDays?: number
	limit?: number
}): Promise<MemoryAccessTrend[]> {
	const windowDays = Math.max(1, params.windowDays ?? 30)
	const limit = Math.max(1, Math.min(50, params.limit ?? 10))
	const targets = await resolveTrendTargets({
		db: params.db,
		prefix: params.prefix,
		agentId: params.agentId,
		collection: params.collection,
		memoryIds: params.memoryIds,
		windowDays,
		limit,
	})
	if (targets.length === 0) {
		return []
	}

	const since = new Date(Date.now() - windowDays * DAY_MS)
	const rows = await accessEventsCollection(params.db, params.prefix)
		.aggregate([
			{
				$match: {
					"meta.agentId": params.agentId,
					ts: { $gte: since },
					$or: targets.map((target) => ({
						"meta.collection": target.collection,
						"meta.memoryId": target.memoryId,
					})),
				},
			},
			{
				$set: {
					day: {
						$dateTrunc: {
							date: "$ts",
							unit: "day",
						},
					},
				},
			},
			{
				$group: {
					_id: {
						collection: "$meta.collection",
						memoryId: "$meta.memoryId",
						day: "$day",
					},
					count: { $sum: "$count" },
					lastAccessedAt: { $max: "$ts" },
				},
			},
			{
				$setWindowFields: {
					partitionBy: {
						collection: "$_id.collection",
						memoryId: "$_id.memoryId",
					},
					sortBy: { "_id.day": 1 },
					output: {
						rolling7dCount: {
							$sum: "$count",
							window: {
								range: [-6, 0],
								unit: "day",
							},
						},
					},
				},
			},
			{
				$project: {
					_id: 0,
					collection: "$_id.collection",
					memoryId: "$_id.memoryId",
					day: "$_id.day",
					count: 1,
					rolling7dCount: 1,
					lastAccessedAt: 1,
				},
			},
			{
				$sort: {
					collection: 1,
					memoryId: 1,
					day: 1,
				},
			},
		])
		.toArray()

	return rows.map((row) => ({
		collection: row.collection as AccessEventCollection,
		memoryId: String(row.memoryId),
		day: row.day as Date,
		count: typeof row.count === "number" ? row.count : Number(row.count ?? 0),
		rolling7dCount:
			typeof row.rolling7dCount === "number"
				? row.rolling7dCount
				: Number(row.rolling7dCount ?? 0),
		lastAccessedAt:
			row.lastAccessedAt instanceof Date ? row.lastAccessedAt : undefined,
	}))
}
