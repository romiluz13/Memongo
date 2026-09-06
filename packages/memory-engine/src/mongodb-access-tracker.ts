/**
 * AccessTracker — batched access-event persistence backed by a time series
 * collection plus computed summary fields on canonical memory documents.
 *
 * Raw access history is stored in `access_events` for trend analysis, while the
 * denormalized `accessCount` / `lastAccessedAt` fields remain updated on the
 * canonical collections so existing scoring paths keep working.
 */

import type { AnyBulkWriteOperation, Db, Document, Filter } from "mongodb"
import { randomUUID } from "node:crypto"
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
	AccessRecordTarget,
	AccessTrackerConfig,
	MemoryAccessSummary,
	MemoryAccessTrend,
	MemorySearchResult,
} from "./types.js"

export type { AccessRecordTarget, AccessTrackerConfig }

const log = createSubsystemLogger("memory:mongodb:access-tracker")

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * CanonicalId prefix -> canonical collection. Shared by
 * accessTargetFromSearchResult and its callers.
 */
const CANONICAL_ID_PREFIXES: Record<string, AccessEventCollection> = {
	event: "events",
	structured: "structured_mem",
	procedure: "procedures",
	episode: "episodes",
	relation: "relations",
	entity: "entities",
}

/**
 * W01: identity fields each collection requires beyond the primary id for a
 * canonical update to target exactly one row — the members of the
 * collection's unique compound index that the tracker cannot derive itself
 * (its own agentId, the primary id):
 * - structured_mem: uq {agentId, scope, scopeRef, type, key}
 * - procedures: uq {procedureId, agentId, scope, scopeRef}
 * - entities: uq {entityId, agentId, scope, scopeRef}
 * - relations: uq {agentId, scope, scopeRef, fromEntityId, toEntityId, type}
 * - events / episodes: uq {eventId} / {episodeId} (global per collection)
 * A canonical update is never written with an under-specified filter: when
 * any required field is missing the update is skipped (the raw access event
 * is still recorded).
 */
type RequiredIdentityField =
	| "scope"
	| "scopeRef"
	| "type"
	| "fromEntityId"
	| "toEntityId"

const REQUIRED_IDENTITY_FIELDS: Record<
	AccessEventCollection,
	ReadonlyArray<RequiredIdentityField>
> = {
	events: [],
	episodes: [],
	structured_mem: ["scope", "scopeRef", "type"],
	procedures: ["scope", "scopeRef"],
	entities: ["scope", "scopeRef"],
	relations: ["scope", "scopeRef", "fromEntityId", "toEntityId", "type"],
}

function isFilled(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0
}

/**
 * Canonical update filter matching the collection's unique compound index,
 * with the tracker's agentId in every update (events/episodes add it on top
 * of their single-field unique index as defense in depth). Returns null when
 * a required identity field is missing — callers must skip, never guess.
 */
function buildCanonicalFilter(
	agentId: string,
	target: AccessRecordTarget,
): Filter<Document> | null {
	for (const field of REQUIRED_IDENTITY_FIELDS[target.collection]) {
		if (!isFilled(target[field])) {
			return null
		}
	}
	switch (target.collection) {
		case "events":
			return { eventId: target.id, agentId }
		case "episodes":
			return { episodeId: target.id, agentId }
		case "structured_mem":
			return {
				agentId,
				scope: target.scope,
				scopeRef: target.scopeRef,
				type: target.type,
				key: target.id,
			}
		case "procedures":
			return {
				procedureId: target.id,
				agentId,
				scope: target.scope,
				scopeRef: target.scopeRef,
			}
		case "entities":
			return {
				entityId: target.id,
				agentId,
				scope: target.scope,
				scopeRef: target.scopeRef,
			}
		case "relations":
			return {
				agentId,
				scope: target.scope,
				scopeRef: target.scopeRef,
				fromEntityId: target.fromEntityId,
				toEntityId: target.toEntityId,
				type: target.type,
			}
	}
}

/**
 * W01: collision-proof buffer identity — the full target tuple, not
 * collection+id, so same-key rows in different scopes/types never merge
 * their counts.
 */
function bufferKey(target: AccessRecordTarget): string {
	return JSON.stringify([
		target.collection,
		target.id,
		target.scope ?? null,
		target.scopeRef ?? null,
		target.type ?? null,
		target.fromEntityId ?? null,
		target.toEntityId ?? null,
	])
}

/**
 * W01: derive the full access identity from a returned search result. The
 * canonicalId fixes the collection and per-collection id segments; the
 * result's scope/scopeRef fields (carried by every projection lane) fix the
 * owning scope. Returns null when the result carries no usable identity —
 * the caller then records nothing rather than guessing.
 */
export function accessTargetFromSearchResult(
	result: Pick<MemorySearchResult, "canonicalId" | "scope" | "scopeRef">,
): AccessRecordTarget | null {
	const cid = result.canonicalId
	if (!cid) {
		return null
	}
	const colonIdx = cid.indexOf(":")
	if (colonIdx < 0) {
		return null
	}
	const collection = CANONICAL_ID_PREFIXES[cid.slice(0, colonIdx)]
	if (!collection) {
		return null
	}

	const [base, queryString] = cid.slice(colonIdx + 1).split("?", 2)
	const trimmed = base.trim()
	if (!trimmed) {
		return null
	}

	// Scope identity: result fields win; a `?scope=&scopeRef=` suffix on the
	// canonicalId is the fallback (readFile's locator convention).
	let scope: string | undefined =
		typeof result.scope === "string" ? result.scope : undefined
	let scopeRef: string | undefined =
		typeof result.scopeRef === "string" ? result.scopeRef : undefined
	if (queryString) {
		const params = new URLSearchParams(queryString)
		scope ??= params.get("scope") ?? undefined
		scopeRef ??= params.get("scopeRef") ?? undefined
	}

	switch (collection) {
		case "events":
		case "episodes":
		case "entities":
		case "procedures":
			return { collection, id: trimmed, scope, scopeRef }
		case "structured_mem": {
			// `structured:<type>:<key>` — the key may itself contain colons;
			// readFile parses the same locator the same way.
			const [type, ...keyParts] = trimmed.split(":")
			const key = keyParts.join(":").trim()
			if (!type || !key) {
				return null
			}
			return { collection, id: key, type, scope, scopeRef }
		}
		case "relations": {
			// `relation:<fromEntityId>:<type>:<toEntityId>` — exactly three
			// non-empty segments, else the locator is unparseable.
			const parts = trimmed.split(":")
			if (parts.length !== 3 || parts.some((part) => !part)) {
				return null
			}
			return {
				collection,
				id: trimmed,
				fromEntityId: parts[0],
				type: parts[1],
				toEntityId: parts[2],
				scope,
				scopeRef,
			}
		}
	}
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

/**
 * W11: buffered access counts. An entry is MUTABLE only while uncommitted
 * (no batchId); the flush stamps uncommitted entries with the flush's
 * logical batch id before they leave the buffer, and from that moment the
 * entry's count is committed to that batch's raw-insert and
 * canonical-increment exactly-once accounting — a re-buffer preserves the
 * batchId instead of merging counts across batches.
 */
type UncommittedEntry = {
	target: AccessRecordTarget
	count: number
}

type CommittedEntry = UncommittedEntry & {
	/** W11: logical flush batch id; assigned at flush time, kept on retry. */
	batchId: string
}

type BufferEntry = UncommittedEntry | CommittedEntry

/**
 * W11: how many applied batch ids a canonical document remembers. A
 * re-buffered retry (same batchId) stays guarded for this many further
 * applied batches; `$slice: -32` keeps the array permanently bounded.
 */
const APPLIED_BATCHES_WINDOW = 32

export class AccessTracker {
	private buffer: Map<string, BufferEntry[]>
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
		// P2.5(e): a periodic flush must never hold the event loop open on
		// shutdown — the manager's close() flushes deterministically.
		this.timer.unref?.()
	}

	recordAccess(target: AccessRecordTarget): void {
		const id = target.id.trim()
		if (!id) {
			return
		}
		const normalized: AccessRecordTarget = { ...target, id }
		const key = bufferKey(normalized)
		const entries = this.buffer.get(key) ?? []
		// W11: only an uncommitted entry may absorb the new count. An entry
		// that already carries a batchId is committed to that batch's
		// exactly-once accounting — incrementing it after the raw insert would
		// double-count the raw layer and double-increment the canonical layer
		// (or lose the new count to the $ne guard). A new access therefore
		// starts a FRESH entry that the next flush stamps with a new batchId.
		const last = entries[entries.length - 1]
		if (last && !("batchId" in last)) {
			last.count++
		} else {
			entries.push({ target: normalized, count: 1 })
		}
		this.buffer.set(key, entries)
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
	 * Merge a failed flush's snapshot back into the live buffer. Used by the
	 * deadletter path so a flush failure does NOT drop access counts.
	 *
	 * W11: entries are appended AS-IS with their original batchIds — never
	 * merged into a live uncommitted entry. Counts from different batches
	 * must stay separate so each batch's raw insert and canonical $inc stay
	 * exactly-once on retry (the raw layer read-reconciles by batchId; the
	 * canonical layer no-matches already-applied batches).
	 */
	private rebufferSnapshot(snapshot: CommittedEntry[]): void {
		for (const entry of snapshot) {
			const key = bufferKey(entry.target)
			const entries = this.buffer.get(key) ?? []
			entries.push(entry)
			this.buffer.set(key, entries)
			this.totalBuffered += entry.count
		}
	}

	private async doFlush(): Promise<number> {
		if (this.buffer.size === 0) {
			return 0
		}

		// W11: one durable logical batch id per flush. Uncommitted entries are
		// stamped BEFORE the snapshot leaves the buffer so any failure
		// re-buffers entries that keep their original batchId: the retry then
		// read-reconciles the raw layer (skipping batches already inserted)
		// and no-matches canonical ops that already applied.
		const batchId = randomUUID()
		const snapshot: CommittedEntry[] = []
		for (const entries of this.buffer.values()) {
			for (const entry of entries) {
				// In-place stamp (Object.assign keeps the object identity the
				// re-buffer later preserves); committed retries pass through.
				const committed: CommittedEntry =
					"batchId" in entry ? entry : Object.assign(entry, { batchId })
				snapshot.push(committed)
			}
		}
		this.buffer.clear()
		this.totalBuffered = 0

		const now = new Date()
		const eventDocs: AccessEventDocument[] = []
		const collectionOps = new Map<
			AccessEventCollection,
			Array<AnyBulkWriteOperation<Document>>
		>()
		const skipped: AccessRecordTarget[] = []

		for (const entry of snapshot) {
			const { target } = entry
			eventDocs.push({
				ts: now,
				meta: {
					agentId: this.agentId,
					collection: target.collection,
				},
				memoryId: target.id,
				count: entry.count,
				batchId: entry.batchId,
				...(isFilled(target.scope) ? { scope: target.scope } : {}),
				...(isFilled(target.scopeRef) ? { scopeRef: target.scopeRef } : {}),
				...(isFilled(target.type) ? { type: target.type } : {}),
			})

			const filter = buildCanonicalFilter(this.agentId, target)
			if (!filter) {
				skipped.push(target)
				continue
			}
			const ops = collectionOps.get(target.collection) ?? []
			// Typed as a plain Document (house precedent from the bounded
			// evolutionHistory push in mongodb-procedures.ts): the driver's
			// PushOperator<Document> does not model the $each/$slice modifier
			// shape on an index-signature schema.
			const update: Document = {
				$inc: { accessCount: entry.count },
				$set: { lastAccessedAt: now },
				// W11: the batch append rides the SAME per-document atomic
				// updateOne as the guarded increments; $slice keeps the newest
				// APPLIED_BATCHES_WINDOW batch ids so the array stays
				// permanently bounded while a re-buffered retry stays guarded.
				$push: {
					appliedBatches: {
						$each: [entry.batchId],
						$slice: -APPLIED_BATCHES_WINDOW,
					},
				},
			}
			ops.push({
				updateOne: {
					// W11: the appliedBatches $ne guard makes the canonical
					// projection idempotent per batch — the filter matches
					// legacy documents (missing field) and other-batch
					// documents, and excludes exactly the documents that
					// already applied THIS batch, so a re-buffered retry's
					// updateOne no-matches instead of double-incrementing.
					filter: {
						...filter,
						appliedBatches: { $ne: entry.batchId },
					},
					update,
				},
			})
			collectionOps.set(target.collection, ops)
		}

		if (skipped.length > 0) {
			// W01 fail-safe: an under-specified identity never produces a
			// canonical update. One warn per flush (not per target) keeps the
			// log bounded. Raw access events were still recorded above.
			const byCollection: Record<string, number> = {}
			for (const target of skipped) {
				byCollection[target.collection] =
					(byCollection[target.collection] ?? 0) + 1
			}
			log.warn(
				`skipped ${skipped.length} under-specified canonical access update(s); raw access events still recorded: ${JSON.stringify(byCollection)}`,
			)
		}

		// W11 raw layer: read-reconcile by batchId before inserting. Unique
		// indexes are prohibited on time-series collections, so the available
		// exactly-once shape is to skip the insert for any batch whose raw
		// events are already present (a previous flush inserted them, then
		// failed a later phase and re-buffered this snapshot). A fresh flush
		// carries only the just-minted batchId — a UUID cannot collide — so
		// the reconcile read runs only on retry flushes, keeping the
		// steady-state cost identical to the pre-guard flush.
		if (eventDocs.length > 0) {
			try {
				const batchIds = [...new Set(snapshot.map((entry) => entry.batchId))]
				const isRetry = batchIds.length > 1 || batchIds[0] !== batchId
				let toInsert = eventDocs
				if (isRetry) {
					const present = new Set(
						(
							await accessEventsCollection(this.db, this.prefix)
								.find({ batchId: { $in: batchIds } })
								.toArray()
						).map((doc) => String(doc.batchId)),
					)
					toInsert = eventDocs.filter((doc) => !present.has(doc.batchId))
				}
				if (toInsert.length > 0) {
					await accessEventsCollection(this.db, this.prefix).insertMany(
						toInsert,
						{
							ordered: false,
						},
					)
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`access event insert failed (re-buffering ${snapshot.length} entries for retry): ${msg}`,
				)
				this.rebufferSnapshot(snapshot)
				return 0
			}
		}

		// W11 canonical layer: on ANY collection's failure the WHOLE snapshot
		// is re-buffered (batchIds preserved) — replacing the old
		// failed-collection-only re-buffer that desynchronized raw/canonical
		// alignment across collections. The retry is safe at both layers:
		// already-inserted batches are skipped by the raw read-reconcile and
		// already-applied ops no-match on the appliedBatches guard, so every
		// count lands exactly once across any sequence of partial failures.
		let updated = 0
		let canonicalFailed = false
		for (const [collection, ops] of collectionOps) {
			try {
				const result = await getCanonicalCollection(
					this.db,
					this.prefix,
					collection,
				).bulkWrite(ops, { ordered: false })
				updated += result.modifiedCount ?? 0
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`access summary flush failed for ${collection} (re-buffering ${snapshot.length} entries for retry): ${msg}`,
				)
				canonicalFailed = true
			}
		}
		if (canonicalFailed) {
			this.rebufferSnapshot(snapshot)
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
					memoryId: { $in: params.memoryIds },
					ts: { $gte: since },
				},
			},
			{
				$group: {
					_id: "$memoryId",
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
						memoryId: { $in: params.memoryIds },
						ts: {
							$gte: new Date(Date.now() - params.windowDays * DAY_MS),
						},
					},
				},
				{
					$group: {
						_id: {
							collection: "$meta.collection",
							memoryId: "$memoryId",
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
						memoryId: "$memoryId",
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
						memoryId: target.memoryId,
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
						memoryId: "$memoryId",
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
