import { createHash, randomUUID } from "node:crypto"
import type { ClientSession, Db, Document } from "mongodb"
import {
	type MemoryScope,
	createSubsystemLogger,
	retryAsync,
} from "@memongo/lib"
import { recordProjectionRun } from "./mongodb-ops.js"
import { eventsCollection, chunksCollection } from "./mongodb-schema.js"
import { resolveScopeIdentity } from "./mongodb-scope.js"
import { buildUnexpiredClause } from "./mongodb-temporal.js"

const log = createSubsystemLogger("memory:mongodb:events")
const DURABLE_EVENT_WRITE_CONCERN = {
	w: "majority" as const,
	wtimeoutMS: 5_000,
}

const RETRYABLE_MONGO_ERROR_LABELS = new Set([
	"NoWritesPerformed",
	"RetryableError",
	"RetryableWriteError",
	"TransientTransactionError",
])

export function isTransientMongoWriteError(err: unknown): boolean {
	const hasErrorLabel = (err as { hasErrorLabel?: (label: string) => boolean })
		?.hasErrorLabel
	if (typeof hasErrorLabel === "function") {
		for (const label of RETRYABLE_MONGO_ERROR_LABELS) {
			if (hasErrorLabel.call(err, label)) return true
		}
	}

	const name = err instanceof Error ? err.name : ""
	const message = err instanceof Error ? err.message : String(err)
	const normalized = `${name} ${message}`.toLowerCase()
	return (
		normalized.includes("mongonetwork") ||
		normalized.includes("mongoserverselection") ||
		normalized.includes("mongotimeout") ||
		normalized.includes("getaddrinfo enotfound") ||
		normalized.includes("econnrefused") ||
		normalized.includes("replicasetnoprimary") ||
		normalized.includes("server monitor timeout") ||
		normalized.includes("server selection timed out") ||
		normalized.includes("connection timed out") ||
		(normalized.includes("connection to") && normalized.includes("interrupted"))
	)
}

async function retryTransientMongoWrite<T>(
	label: string,
	run: () => Promise<T>,
): Promise<T> {
	const attempts = resolveTransientWriteRetryAttempts()
	return await retryAsync(run, {
		label,
		attempts,
		minDelayMs: resolveTransientWriteRetryDelayMs(
			"MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_MIN_DELAY_MS",
			500,
		),
		maxDelayMs: resolveTransientWriteRetryDelayMs(
			"MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_MAX_DELAY_MS",
			3_000,
		),
		jitter: 0.2,
		shouldRetry: (err) => isTransientMongoWriteError(err),
		onRetry: ({ attempt, delayMs, err }) => {
			const message = err instanceof Error ? err.message : String(err)
			log.warn(
				`transient MongoDB write retry: ${label} nextAttempt=${attempt + 1}/${attempts} delayMs=${delayMs} error=${message}`,
			)
		},
	})
}

function resolveTransientWriteRetryAttempts(): number {
	const raw = process.env.MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_ATTEMPTS
	const parsed = raw ? Number.parseInt(raw, 10) : 3
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 3
}

function resolveTransientWriteRetryDelayMs(
	envKey: string,
	fallback: number,
): number {
	const raw = process.env[envKey]
	const parsed = raw ? Number.parseInt(raw, 10) : fallback
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanonicalEvent = {
	eventId: string
	agentId: string
	sessionId?: string
	channel?: string
	role: "user" | "assistant" | "system" | "tool"
	body: string
	metadata?: Record<string, unknown>
	scope: MemoryScope
	scopeRef: string
	/**
	 * Client-supplied idempotency key (IETF Idempotency-Key / Stripe model):
	 * unique per logical write within an agent. Retries carrying the same key
	 * replay the original write's receipt instead of duplicating the event.
	 */
	idempotencyKey?: string
	timestamp: Date
	/** Event-valid time. Legacy rows may omit it; new writes always set it. */
	validAt?: Date
	/** End of event-valid time. Missing means the event remains valid. */
	invalidAt?: Date
	/** Transaction time when Memongo first persisted the event. */
	recordedAt?: Date
	/**
	 * P4.4.1: optional absolute expiry instant. Set explicitly per write, or
	 * derived at the manager write seam from `memory.mongodb.ttl.sessionDays`
	 * for session-scoped writes. Backed by a partial TTL index
	 * (expireAfterSeconds: 0); read paths also filter `expiresAt > now`
	 * because the TTL sweep lags ~60s. Absent means the event never expires.
	 */
	expiresAt?: Date
	/** Durable outbox marker cleared only after the extraction job is claimable. */
	extractionJobPendingAt?: Date
	projectedAt?: Date
	consolidatedAt?: Date
	consolidatedIntoEpisodeId?: string
	/**
	 * Denormalized reinforcement counter maintained by the access tracker on
	 * the event document; surfaced on search results so the post-CE access
	 * boost (P3.7) can modulate ranking. Absent on legacy rows.
	 */
	accessCount?: number
	/**
	 * B4: SHA-256 hex of the canonical idempotency fingerprint, stored when
	 * the write carried an idempotencyKey. Replay compares request-side
	 * fingerprints so ANY changed immutable input (not just role/body/
	 * session/scope) surfaces as a 422 instead of a silent false replay.
	 * Absent on pre-B4 rows; replay falls back to the legacy field compare.
	 */
	idempotencyFingerprint?: string
}

/**
 * IETF draft-ietf-httpapi-idempotency-key-header §2.7 / Stripe
 * idempotency_error: the key was seen before with a DIFFERENT payload.
 * The API maps this to 422. Checked across package boundaries by `name`
 * (class instances do not survive every consumer's module graph).
 */
export class IdempotencyConflictError extends Error {
	readonly idempotencyKey: string

	constructor(idempotencyKey: string) {
		super(
			`idempotency key "${idempotencyKey}" was reused with a different payload`,
		)
		this.name = "IdempotencyConflictError"
		this.idempotencyKey = idempotencyKey
	}
}

export function isIdempotencyConflictError(
	err: unknown,
): err is IdempotencyConflictError {
	return err instanceof Error && err.name === "IdempotencyConflictError"
}

// ---------------------------------------------------------------------------
// Idempotency fingerprint retention (C-006)
// ---------------------------------------------------------------------------

/**
 * Default retention window (days) for completed-write idempotency state.
 * Mirrors the memory_mutations audit TTL so the deduplication window and the
 * audit window expire together.
 */
export const IDEMPOTENCY_FINGERPRINT_RETENTION_DAYS = 90

/**
 * In-process gate for the prune sweep: at most one prune per hour per
 * manager instance, so the worker drain loop (which wakes on every write)
 * pays a Date.now() comparison and nothing else between prunes.
 */
export const IDEMPOTENCY_FINGERPRINT_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Retention window with a MEMONGO_IDEMPOTENCY_RETENTION_DAYS override (days;
 * 0 prunes every completed write on each sweep). Falls back to the 90-day
 * default on missing/invalid input.
 */
export function resolveIdempotencyRetentionDays(): number {
	const raw = process.env.MEMONGO_IDEMPOTENCY_RETENTION_DAYS?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed >= 0) {
			return Math.floor(parsed)
		}
	}
	return IDEMPOTENCY_FINGERPRINT_RETENTION_DAYS
}

/**
 * C-006 retention policy for idempotency deduplication state. Fingerprints
 * ride ON canonical event documents (there is no separate fingerprint
 * collection), so a TTL index cannot expire them without deleting the event
 * itself — the policy is a field-level prune. Once a completed write is
 * older than the retention window its idempotencyKey/idempotencyFingerprint
 * pair is $unset, releasing the unique-index slot and the stored payload
 * digest. After the prune, a retried write inserts a NEW event instead of
 * replaying: the deduplication guarantee intentionally expires with the
 * window (the Stripe idempotency-key model — 24h there, 90 days here).
 * The event body itself is untouched.
 */
export async function pruneIdempotencyFingerprints(params: {
	db: Db
	prefix: string
	agentId: string
	olderThanDays?: number
	now?: Date
}): Promise<{ pruned: number }> {
	const { db, prefix, agentId } = params
	const retentionDays =
		params.olderThanDays ?? resolveIdempotencyRetentionDays()
	const now = params.now ?? new Date()
	const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
	const result = await eventsCollection(db, prefix).updateMany(
		{
			agentId,
			idempotencyKey: { $exists: true },
			timestamp: { $lt: cutoff },
		},
		{ $unset: { idempotencyKey: "", idempotencyFingerprint: "" } },
	)
	return { pruned: result.modifiedCount }
}

export function renderEventChunkText(
	event: Pick<CanonicalEvent, "role" | "body">,
): string {
	const roleLabel = event.role.charAt(0).toUpperCase() + event.role.slice(1)
	return `${roleLabel}: ${event.body}`
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

type EventWriteInput = Omit<
	CanonicalEvent,
	"eventId" | "timestamp" | "scopeRef" | "recordedAt"
> & {
	eventId?: string
	timestamp?: Date
	scopeRef?: string
}

/**
 * Build the canonical event document for a write, applying the shared date
 * validation and the P2.3 scope-identity rule. Throws on invalid input.
 */
function buildCanonicalEventDocument(event: EventWriteInput): CanonicalEvent {
	const eventId = event.eventId ?? randomUUID()
	const timestamp = event.timestamp ?? new Date()
	const validAt = event.validAt ?? timestamp
	const recordedAt = new Date()
	for (const [label, value] of [
		["timestamp", timestamp],
		["validAt", validAt],
		["recordedAt", recordedAt],
		["invalidAt", event.invalidAt],
		["expiresAt", event.expiresAt],
	] as const) {
		if (value && Number.isNaN(value.getTime())) {
			throw new Error(`invalid event ${label}`)
		}
	}
	if (event.invalidAt && event.invalidAt.getTime() <= validAt.getTime()) {
		throw new Error("event invalidAt must be later than validAt")
	}
	// P2.3: the write side of the canonical identity rule — an implicit
	// sessionId lands the event in the SAME session scope a sessionKey search
	// reads from (previously writes fell through to "agent").
	const { scope, scopeRef } = resolveScopeIdentity({
		scope: event.scope,
		scopeRef: event.scopeRef,
		agentId: event.agentId,
		sessionId: event.sessionId,
	})

	return {
		eventId,
		agentId: event.agentId,
		role: event.role,
		body: event.body,
		scope,
		scopeRef,
		timestamp,
		validAt,
		recordedAt,
		...(event.invalidAt ? { invalidAt: event.invalidAt } : {}),
		...(event.sessionId && { sessionId: event.sessionId }),
		...(event.channel && { channel: event.channel }),
		...(event.metadata && { metadata: event.metadata }),
		...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
		...(event.idempotencyFingerprint
			? { idempotencyFingerprint: event.idempotencyFingerprint }
			: {}),
		...(event.extractionJobPendingAt
			? { extractionJobPendingAt: event.extractionJobPendingAt }
			: {}),
		...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
	}
}

export async function writeEvent(params: {
	db: Db
	prefix: string
	session?: ClientSession
	event: EventWriteInput
}): Promise<{ eventId: string; timestamp: Date; scopeRef: string }> {
	const { db, prefix, event } = params
	const collection = eventsCollection(db, prefix)
	const doc = buildCanonicalEventDocument(event)
	const eventId = doc.eventId

	await retryTransientMongoWrite("events.updateOne", () =>
		collection.updateOne(
			{ eventId },
			{ $setOnInsert: doc },
			params.session
				? { upsert: true, session: params.session }
				: { upsert: true, writeConcern: DURABLE_EVENT_WRITE_CONCERN },
		),
	)

	log.info(`event written: ${eventId} role=${event.role}`)
	return { eventId, timestamp: doc.timestamp, scopeRef: doc.scopeRef }
}

// ---------------------------------------------------------------------------
// Batch write (P3.9)
// ---------------------------------------------------------------------------

export type EventBatchItemResult =
	| { ok: true; eventId: string; timestamp: Date; scopeRef: string }
	| { ok: false; eventId?: string; duplicateKey: boolean; message: string }

type BulkWriteFailure = {
	writeErrors?: Array<{ index: number; code?: number; errmsg?: string }>
}

function asBulkWriteFailure(err: unknown): BulkWriteFailure | null {
	if (!err || typeof err !== "object") {
		return null
	}
	const writeErrors = (err as BulkWriteFailure).writeErrors
	if (!Array.isArray(writeErrors)) {
		return null
	}
	return err as BulkWriteFailure
}

/**
 * P3.9: insert many canonical events in ONE unordered insertMany with the
 * same durable write concern as the single-write path. Per-item receipts keep
 * a partial failure (validation or E11000 on the idempotency-key unique
 * index) from failing its siblings; the caller maps a duplicateKey receipt to
 * the idempotency replay path. Unlike `writeEvent` (upsert-on-eventId), the
 * batch strictly inserts: a duplicate eventId surfaces as duplicateKey.
 */
export async function writeEventsBatch(params: {
	db: Db
	prefix: string
	events: EventWriteInput[]
}): Promise<EventBatchItemResult[]> {
	const { db, prefix, events } = params
	if (events.length === 0) {
		return []
	}
	const collection = eventsCollection(db, prefix)

	const docs: CanonicalEvent[] = []
	const docIndexes: number[] = []
	const results: EventBatchItemResult[] = events.map(() => ({
		ok: false as const,
		duplicateKey: false,
		message: "event write not attempted",
	}))
	for (const [index, event] of events.entries()) {
		try {
			docs.push(buildCanonicalEventDocument(event))
			docIndexes.push(index)
		} catch (err) {
			results[index] = {
				ok: false,
				...(event.eventId ? { eventId: event.eventId } : {}),
				duplicateKey: false,
				message: err instanceof Error ? err.message : String(err),
			}
		}
	}
	if (docs.length === 0) {
		return results
	}

	const markInserted = () => {
		for (const [position, doc] of docs.entries()) {
			results[docIndexes[position]] = {
				ok: true,
				eventId: doc.eventId,
				timestamp: doc.timestamp,
				scopeRef: doc.scopeRef,
			}
		}
	}

	try {
		await retryTransientMongoWrite("events.insertMany", () =>
			collection.insertMany(docs, {
				ordered: false,
				writeConcern: DURABLE_EVENT_WRITE_CONCERN,
			}),
		)
		markInserted()
	} catch (err) {
		const bulk = asBulkWriteFailure(err)
		if (!bulk?.writeErrors) {
			throw err
		}
		// Unordered inserts apply every doc that did not error; only the
		// indexed failures get an error receipt.
		markInserted()
		for (const writeError of bulk.writeErrors) {
			const doc = docs[writeError.index]
			if (!doc) {
				continue
			}
			results[docIndexes[writeError.index]] = {
				ok: false,
				eventId: doc.eventId,
				duplicateKey: writeError.code === 11000,
				message: writeError.errmsg ?? "event insert failed",
			}
		}
	}

	log.info(`event batch written: ${docs.length} event(s)`)
	return results
}

export async function getPendingExtractionEvents(params: {
	db: Db
	prefix: string
	agentId: string
	limit?: number
}): Promise<CanonicalEvent[]> {
	const limit = Math.max(1, Math.min(500, Math.floor(params.limit ?? 100)))
	return (await eventsCollection(params.db, params.prefix)
		.find({
			agentId: params.agentId,
			extractionJobPendingAt: { $exists: true },
			// P4.4.1: hide expired docs until the TTL sweep removes them.
			...buildUnexpiredClause(),
		})
		.sort({ extractionJobPendingAt: 1, _id: 1 })
		.limit(limit)
		.toArray()) as unknown as CanonicalEvent[]
}

export async function clearEventExtractionJobPending(params: {
	db: Db
	prefix: string
	eventId: string
	agentId: string
}): Promise<boolean> {
	const result = await eventsCollection(params.db, params.prefix).updateOne(
		{
			eventId: params.eventId,
			agentId: params.agentId,
			extractionJobPendingAt: { $exists: true },
		},
		{ $unset: { extractionJobPendingAt: "" } },
		{ writeConcern: DURABLE_EVENT_WRITE_CONCERN },
	)
	return result.matchedCount === 1
}

/**
 * P3.9: batch variant of clearEventExtractionJobPending — one updateMany for
 * every event whose extraction job became claimable in a batch write.
 * Returns the number of events whose marker was cleared.
 */
export async function clearEventExtractionJobPendingBatch(params: {
	db: Db
	prefix: string
	eventIds: string[]
	agentId: string
}): Promise<number> {
	if (params.eventIds.length === 0) {
		return 0
	}
	const result = await eventsCollection(params.db, params.prefix).updateMany(
		{
			eventId: { $in: params.eventIds },
			agentId: params.agentId,
			extractionJobPendingAt: { $exists: true },
		},
		{ $unset: { extractionJobPendingAt: "" } },
		{ writeConcern: DURABLE_EVENT_WRITE_CONCERN },
	)
	return result.matchedCount
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getEventsByTimeRange(params: {
	db: Db
	prefix: string
	agentId: string
	start: Date
	end: Date
	scope?: MemoryScope
	scopeRef?: string
	limit?: number
}): Promise<CanonicalEvent[]> {
	const { db, prefix, agentId, start, end, scope, scopeRef, limit } = params
	const collection = eventsCollection(db, prefix)
	const filter: Document = {
		agentId,
		timestamp: { $gte: start, $lte: end },
		// P4.4.1: hide expired docs until the TTL sweep removes them.
		...buildUnexpiredClause(),
	}
	if (scope) {
		filter.scope = scope
	}
	if (scopeRef) {
		filter.scopeRef = scopeRef
	}

	return (await collection
		.find(filter)
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		.sort({ timestamp: 1, _id: 1 })
		.limit(limit ?? 1000)
		.toArray()) as unknown as CanonicalEvent[]
}

export async function getEventsBySession(params: {
	db: Db
	prefix: string
	agentId: string
	sessionId: string
	limit?: number
}): Promise<CanonicalEvent[]> {
	const { db, prefix, agentId, sessionId, limit } = params
	const collection = eventsCollection(db, prefix)
	return (await collection
		.find({
			agentId,
			sessionId,
			// P4.4.1: hide expired docs until the TTL sweep removes them.
			...buildUnexpiredClause(),
		})
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		.sort({ timestamp: 1, _id: 1 })
		.limit(limit ?? 1000)
		.toArray()) as unknown as CanonicalEvent[]
}

export async function getUnprojectedEvents(params: {
	db: Db
	prefix: string
	agentId: string
	limit?: number
}): Promise<CanonicalEvent[]> {
	const { db, prefix, agentId, limit } = params
	const collection = eventsCollection(db, prefix)
	return (await collection
		.find({
			agentId,
			projectedAt: { $exists: false },
			// P4.4.1: hide expired docs until the TTL sweep removes them.
			...buildUnexpiredClause(),
		})
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		.sort({ timestamp: 1, _id: 1 })
		.limit(limit ?? 500)
		.toArray()) as unknown as CanonicalEvent[]
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export async function markEventsProjected(params: {
	db: Db
	prefix: string
	eventIds: string[]
}): Promise<number> {
	const { db, prefix, eventIds } = params
	if (eventIds.length === 0) {
		return 0
	}
	const collection = eventsCollection(db, prefix)
	const result = await collection.updateMany(
		{ eventId: { $in: eventIds } },
		{ $set: { projectedAt: new Date() } },
	)
	return result.modifiedCount
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * Mark events as consolidated into an episode.
 * Sets consolidatedAt timestamp and consolidatedIntoEpisodeId.
 * Returns the count of modified events.
 */
export async function markEventsConsolidated(params: {
	db: Db
	prefix: string
	eventIds: string[]
	episodeId: string
}): Promise<number> {
	const { db, prefix, eventIds, episodeId } = params
	if (eventIds.length === 0) {
		return 0
	}
	const collection = eventsCollection(db, prefix)
	const result = await collection.updateMany(
		{ eventId: { $in: eventIds } },
		{
			$set: {
				consolidatedAt: new Date(),
				consolidatedIntoEpisodeId: episodeId,
			},
		},
	)
	log.info(
		`marked ${result.modifiedCount} events consolidated into episode=${episodeId}`,
	)
	return result.modifiedCount
}

/**
 * Get events that have NOT been consolidated into any episode.
 * Uses the sparse index on consolidatedAt for efficient queries.
 */
export async function getUnconsolidatedEvents(params: {
	db: Db
	prefix: string
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	limit?: number
}): Promise<CanonicalEvent[]> {
	const { db, prefix, agentId, scope, scopeRef, limit } = params
	const collection = eventsCollection(db, prefix)
	const filter: Document = {
		agentId,
		consolidatedAt: { $exists: false },
		// P4.4.1: hide expired docs until the TTL sweep removes them.
		...buildUnexpiredClause(),
	}
	if (scope) {
		filter.scope = scope
	}
	if (scopeRef) {
		filter.scopeRef = scopeRef
	}

	return (await collection
		.find(filter)
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		.sort({ timestamp: 1, _id: 1 })
		.limit(limit ?? 500)
		.toArray()) as unknown as CanonicalEvent[]
}

// ---------------------------------------------------------------------------
// Session events with working memory bound
// ---------------------------------------------------------------------------

export async function getSessionEventsWithBound(params: {
	db: Db
	prefix: string
	agentId: string
	sessionId: string
	bound?: number
	scope?: MemoryScope
	scopeRef?: string
}): Promise<CanonicalEvent[]> {
	const { db, prefix, agentId, sessionId, scope, scopeRef } = params
	const effectiveBound = Math.max(1, params.bound ?? 50)
	const collection = eventsCollection(db, prefix)
	const filter: Document = {
		agentId,
		sessionId,
		// P4.4.1: hide expired docs until the TTL sweep removes them.
		...buildUnexpiredClause(),
	}
	if (scope) {
		filter.scope = scope
	}
	if (scopeRef) {
		filter.scopeRef = scopeRef
	}

	const events = (await collection
		.find(filter)
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		.sort({ timestamp: -1 })
		.limit(effectiveBound)
		.toArray()) as unknown as CanonicalEvent[]

	// Reverse to chronological order (oldest first)
	return events.toReversed()
}

/**
 * Project unprojected events into the chunks collection.
 * Each event becomes a conversation chunk at `events/{eventId}` using a
 * role-labeled text rendering for recall quality.
 */
export async function projectChunksFromEvents(params: {
	db: Db
	prefix: string
	agentId: string
	batchSize?: number
}): Promise<{ eventsProcessed: number; chunksCreated: number }> {
	const { db, prefix, agentId, batchSize } = params
	const startMs = Date.now()

	const events = await getUnprojectedEvents({
		db,
		prefix,
		agentId,
		limit: batchSize,
	})
	if (events.length === 0) {
		return { eventsProcessed: 0, chunksCreated: 0 }
	}

	let chunksCreated = 0

	try {
		for (const event of events) {
			const { chunkCreated } = await projectEventChunk({
				db,
				prefix,
				event,
				recordRun: false,
			})
			if (chunkCreated) {
				chunksCreated++
			}
		}
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId,
				projectionType: "chunks",
				status: "ok",
				itemsProjected: chunksCreated,
				durationMs: Date.now() - startMs,
			},
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId,
				projectionType: "chunks",
				status: "failed",
				itemsProjected: chunksCreated,
				durationMs: Date.now() - startMs,
			},
		}).catch(() => {})
		log.warn(
			`projection failed after ${chunksCreated} chunks created from ${events.length} events for agent=${agentId}: ${msg}`,
		)
		throw err
	}

	log.info(
		`projected ${chunksCreated} chunks from ${events.length} events for agent=${agentId}`,
	)
	return { eventsProcessed: events.length, chunksCreated }
}

/**
 * P3.9: batch variant of projectEventChunk — one unordered bulkWrite for all
 * chunk upserts plus one updateMany marking the events projected, instead of
 * three round trips per event. A total bulk failure degrades to
 * chunkCreated:false for every item WITHOUT marking events projected, so the
 * projection repair pass recovers them later; the event writes themselves are
 * already durable and stay acknowledged.
 */
export async function projectEventChunksBatch(params: {
	db: Db
	prefix: string
	events: CanonicalEvent[]
	recordRun?: boolean
}): Promise<Array<{ chunkCreated: boolean }>> {
	const { db, prefix, events } = params
	const startMs = Date.now()
	if (events.length === 0) {
		return []
	}
	const chunks = chunksCollection(db, prefix)
	const ops = events.map((event) => {
		const path = `events/${event.eventId}`
		const text = renderEventChunkText(event)
		const hash = createHash("sha256").update(text).digest("hex")
		return {
			updateOne: {
				filter: { path },
				update: {
					$setOnInsert: {
						path,
						text,
						hash,
						source: "conversation",
						agentId: event.agentId,
						scope: event.scope,
						scopeRef: event.scopeRef,
						...(event.sessionId ? { sessionId: event.sessionId } : {}),
						timestamp: event.timestamp,
						updatedAt: new Date(),
					},
					// C-005 + C-026: see projectEventChunk — expiry propagates
					// from the event to its chunk, in $set so re-projection
					// also heals chunks an older path wrote without it; the
					// event-valid interval rides along for searchV2's
					// bitemporal lane filter.
					$set: {
						...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
						validAt: event.validAt ?? event.timestamp,
						invalidAt: event.invalidAt ?? null,
					},
				},
				upsert: true,
			},
		}
	})

	let upsertedIndexes: Set<number>
	let failedIndexes: Set<number>
	try {
		const result = await retryTransientMongoWrite("chunks.bulkWrite", () =>
			chunks.bulkWrite(ops, { ordered: false }),
		)
		upsertedIndexes = new Set(
			Object.keys(result.upsertedIds ?? {}).map((key) => Number(key)),
		)
		failedIndexes = new Set()
	} catch (err) {
		const bulk = asBulkWriteFailure(err)
		if (!bulk?.writeErrors) {
			log.warn(
				`batch chunk projection failed outright for ${events.length} event(s); leaving them unprojected for the repair pass: ${String(err)}`,
			)
			return events.map(() => ({ chunkCreated: false }))
		}
		const partial = (
			err as { result?: { upsertedIds?: Record<number, unknown> } }
		).result
		upsertedIndexes = new Set(
			Object.keys(partial?.upsertedIds ?? {}).map((key) => Number(key)),
		)
		failedIndexes = new Set(bulk.writeErrors.map((we) => we.index))
		log.warn(
			`batch chunk projection had ${failedIndexes.size} per-item failure(s): ${String(err)}`,
		)
	}

	// Mark projected only for events whose chunk now durably exists (upserted
	// or matched); failed items stay unprojected for the repair pass.
	const projectableIds = events
		.filter((_, index) => !failedIndexes.has(index))
		.map((event) => event.eventId)
	await retryTransientMongoWrite("events.markProjectedBatch", () =>
		markEventsProjected({ db, prefix, eventIds: projectableIds }),
	)

	const results = events.map((_, index) => ({
		chunkCreated: upsertedIndexes.has(index),
	}))
	const chunksCreated = results.filter((r) => r.chunkCreated).length
	if (params.recordRun !== false) {
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId: events[0].agentId,
				projectionType: "chunks",
				status: failedIndexes.size > 0 ? "failed" : "ok",
				itemsProjected: chunksCreated,
				durationMs: Date.now() - startMs,
			},
		}).catch(() => {})
	}
	return results
}

export async function projectEventChunk(params: {
	db: Db
	prefix: string
	event: CanonicalEvent
	recordRun?: boolean
}): Promise<{ chunkCreated: boolean }> {
	const { db, prefix, event } = params
	const startMs = Date.now()
	const chunks = chunksCollection(db, prefix)
	const path = `events/${event.eventId}`
	const text = renderEventChunkText(event)
	const hash = createHash("sha256").update(text).digest("hex")
	const result = await retryTransientMongoWrite("chunks.updateOne", () =>
		chunks.updateOne(
			{ path },
			{
				$setOnInsert: {
					path,
					text,
					hash,
					source: "conversation",
					agentId: event.agentId,
					scope: event.scope,
					scopeRef: event.scopeRef,
					...(event.sessionId ? { sessionId: event.sessionId } : {}),
					timestamp: event.timestamp,
					updatedAt: new Date(),
				},
				// C-005 + C-026: propagate the event's expiry AND event-valid
				// interval onto the chunk. Same model as the events partial TTL
				// index: absent expiresAt means the chunk never expires; a
				// partial chunks TTL index deletes expired chunks and the
				// unexpired guard keeps reads from surfacing them between
				// sweeps. validAt/invalidAt are the bitemporal bounds that
				// searchV2's chunk lane filter enforces. All carried in $set
				// (not $setOnInsert) so re-projection also HEALS a chunk that
				// an older projection path wrote without them — events are
				// immutable, so re-setting the values is idempotent. Legacy
				// chunks keep missing fields and match the filter's null arms
				// until this heal rewrites them.
				$set: {
					...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
					validAt: event.validAt ?? event.timestamp,
					invalidAt: event.invalidAt ?? null,
				},
			},
			{ upsert: true },
		),
	)
	await retryTransientMongoWrite("events.markProjected", () =>
		markEventsProjected({ db, prefix, eventIds: [event.eventId] }),
	)
	if (params.recordRun !== false) {
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId: event.agentId,
				projectionType: "chunks",
				status: "ok",
				itemsProjected: result.upsertedCount > 0 ? 1 : 0,
				durationMs: Date.now() - startMs,
			},
		}).catch(() => {})
	}
	return { chunkCreated: result.upsertedCount > 0 }
}
