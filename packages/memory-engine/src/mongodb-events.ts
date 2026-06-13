import { createHash, randomUUID } from "node:crypto"
import type { Db, Document } from "mongodb"
import {
	type MemoryScope,
	createSubsystemLogger,
	retryAsync,
} from "@memongo/lib"
import { recordProjectionRun } from "./mongodb-ops.js"
import { eventsCollection, chunksCollection } from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"

const log = createSubsystemLogger("memory:mongodb:events")

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
	timestamp: Date
	projectedAt?: Date
	consolidatedAt?: Date
	consolidatedIntoEpisodeId?: string
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

export async function writeEvent(params: {
	db: Db
	prefix: string
	event: Omit<CanonicalEvent, "eventId" | "timestamp" | "scopeRef"> & {
		eventId?: string
		timestamp?: Date
		scopeRef?: string
	}
}): Promise<{ eventId: string; timestamp: Date; scopeRef: string }> {
	const { db, prefix, event } = params
	const collection = eventsCollection(db, prefix)
	const eventId = event.eventId ?? randomUUID()
	const timestamp = event.timestamp ?? new Date()
	const scope = event.scope ?? ("agent" as MemoryScope)
	const scopeRef = resolveScopeRef({
		scope,
		scopeRef: event.scopeRef,
		agentId: event.agentId,
		sessionId: event.sessionId,
	})

	const doc: CanonicalEvent = {
		eventId,
		agentId: event.agentId,
		role: event.role,
		body: event.body,
		scope,
		scopeRef,
		timestamp,
		...(event.sessionId && { sessionId: event.sessionId }),
		...(event.channel && { channel: event.channel }),
		...(event.metadata && { metadata: event.metadata }),
	}

	await retryTransientMongoWrite("events.updateOne", () =>
		collection.updateOne({ eventId }, { $setOnInsert: doc }, { upsert: true }),
	)

	log.info(`event written: ${eventId} role=${event.role}`)
	return { eventId, timestamp, scopeRef }
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
		.find({ agentId, sessionId })
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
		.find({ agentId, projectedAt: { $exists: false } })
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
	const filter: Document = { agentId, sessionId }
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
