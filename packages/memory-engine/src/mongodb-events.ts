import { createHash, randomUUID } from "node:crypto"
import type { ClientSession, Collection, Db, Document } from "mongodb"
import {
	type MemoryScope,
	createSubsystemLogger,
	retryAsync,
} from "@memongo/lib"
import {
	EVENT_IDENTITY_READ_OPTIONS,
	type EventMetadataWriteOptions,
	eventMetadataMatchesPersistedForm,
} from "./mongodb-event-metadata-identity.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import { eventsCollection, chunksCollection } from "./mongodb-schema.js"
import { resolveScopeIdentity } from "./mongodb-scope.js"
import { buildUnexpiredClause } from "./mongodb-temporal.js"
import {
	captureAdmissionToken,
	readErasureGate,
	withFencedWrite,
	ErasureGateConflictError,
	isErasureGateConflictError,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import { settledFailureMeta } from "./query-diagnostics.js"

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
	session?: ClientSession
}): Promise<{ pruned: number }> {
	const { db, prefix, agentId } = params
	const retentionDays =
		params.olderThanDays ?? resolveIdempotencyRetentionDays()
	const now = params.now ?? new Date()
	const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
	// W10: age by the immutable acceptance instant (recordedAt), not the
	// event's own timestamp — a fresh import of historical events keeps its
	// replay protection for the full window, and a future-dated event can no
	// longer extend retention. Legacy rows without recordedAt keep the old
	// timestamp rule so they remain prunable.
	const result = await eventsCollection(db, prefix).updateMany(
		{
			agentId,
			idempotencyKey: { $exists: true },
			$or: [
				{ recordedAt: { $lt: cutoff } },
				{ recordedAt: { $exists: false }, timestamp: { $lt: cutoff } },
			],
		},
		{ $unset: { idempotencyKey: "", idempotencyFingerprint: "" } },
		params.session ? { session: params.session } : {},
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

export type EventWriteInput = Omit<
	CanonicalEvent,
	"eventId" | "timestamp" | "scopeRef" | "recordedAt"
> & {
	eventId?: string
	timestamp?: Date
	scopeRef?: string
}

export type EventReplayDocument = Pick<
	CanonicalEvent,
	"eventId" | "agentId" | "role" | "body" | "scope" | "scopeRef" | "timestamp"
> &
	Partial<
		Pick<
			CanonicalEvent,
			| "sessionId"
			| "channel"
			| "metadata"
			| "validAt"
			| "invalidAt"
			| "expiresAt"
			| "idempotencyKey"
			| "idempotencyFingerprint"
		>
	>

const EVENT_REPLAY_PROJECTION = {
	_id: 0,
	eventId: 1,
	agentId: 1,
	sessionId: 1,
	channel: 1,
	role: 1,
	body: 1,
	metadata: 1,
	scope: 1,
	scopeRef: 1,
	timestamp: 1,
	validAt: 1,
	invalidAt: 1,
	expiresAt: 1,
} as const

export const EVENT_IDEMPOTENCY_REPLAY_PROJECTION = {
	...EVENT_REPLAY_PROJECTION,
	idempotencyKey: 1,
	idempotencyFingerprint: 1,
} as const

export function isStoredEventReplayDocument(
	value: Document | null | undefined,
): value is EventReplayDocument {
	return (
		value != null &&
		typeof value.eventId === "string" &&
		typeof value.agentId === "string" &&
		typeof value.role === "string" &&
		typeof value.body === "string" &&
		typeof value.scope === "string" &&
		typeof value.scopeRef === "string" &&
		value.timestamp instanceof Date &&
		!Number.isNaN(value.timestamp.getTime())
	)
}

function datesMatch(stored: unknown, attempted: Date | undefined): boolean {
	return (
		stored instanceof Date &&
		attempted instanceof Date &&
		stored.getTime() === attempted.getTime()
	)
}

export function eventReplayMatches(
	stored: EventReplayDocument,
	attempted: CanonicalEvent,
	input: EventWriteInput,
	writeOptions: EventMetadataWriteOptions,
): boolean {
	if (
		stored.agentId !== attempted.agentId ||
		stored.scope !== attempted.scope ||
		stored.scopeRef !== attempted.scopeRef ||
		stored.role !== attempted.role ||
		stored.body !== attempted.body
	) {
		return false
	}
	for (const field of ["sessionId", "channel"] as const) {
		const storedHasField = Object.hasOwn(stored, field)
		const attemptedHasField = Object.hasOwn(attempted, field)
		if (
			storedHasField !== attemptedHasField ||
			(attemptedHasField && stored[field] !== attempted[field])
		) {
			return false
		}
	}
	const storedHasMetadata = Object.hasOwn(stored, "metadata")
	const attemptedHasMetadata = Object.hasOwn(attempted, "metadata")
	if (
		storedHasMetadata !== attemptedHasMetadata ||
		(attemptedHasMetadata &&
			!eventMetadataMatchesPersistedForm(
				stored.metadata,
				attempted.metadata,
				writeOptions,
			))
	) {
		return false
	}
	for (const field of ["invalidAt", "expiresAt"] as const) {
		if (field in attempted && !datesMatch(stored[field], attempted[field])) {
			return false
		}
	}
	if (
		input.timestamp !== undefined &&
		!datesMatch(stored.timestamp, attempted.timestamp)
	) {
		return false
	}
	if (input.validAt !== undefined) {
		if (
			!Object.hasOwn(stored, "validAt") ||
			!datesMatch(stored.validAt, attempted.validAt)
		) {
			return false
		}
	} else if (
		input.timestamp !== undefined &&
		Object.hasOwn(stored, "validAt") &&
		!datesMatch(stored.validAt, attempted.validAt)
	) {
		return false
	}
	return true
}

/**
 * Build the canonical event document for a write, applying the shared date
 * validation and the P2.3 scope-identity rule. Throws on invalid input.
 */
export function buildCanonicalEventDocument(
	event: EventWriteInput,
): CanonicalEvent {
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
	const update = () =>
		collection.updateOne(
			{ eventId },
			{ $setOnInsert: doc },
			params.session
				? { upsert: true, session: params.session }
				: { upsert: true, writeConcern: DURABLE_EVENT_WRITE_CONCERN },
		)

	const updateResult = params.session
		? await update()
		: await retryTransientMongoWrite("events.updateOne", update)
	if (updateResult.upsertedCount === 1) {
		log.info(`event written: ${eventId} role=${event.role}`)
		return { eventId, timestamp: doc.timestamp, scopeRef: doc.scopeRef }
	}

	let stored: Document | null
	try {
		stored = await collection.findOne(
			{ eventId },
			params.session
				? {
						projection: EVENT_REPLAY_PROJECTION,
						...EVENT_IDENTITY_READ_OPTIONS,
						session: params.session,
					}
				: {
						projection: EVENT_REPLAY_PROJECTION,
						...EVENT_IDENTITY_READ_OPTIONS,
						readConcern: { level: "majority" },
					},
		)
	} catch (cause) {
		throw new Error(
			`event replay confirmation failed for event ID "${eventId}"; stored event could not be read`,
			{ cause },
		)
	}
	if (!isStoredEventReplayDocument(stored)) {
		throw new Error(
			`event replay confirmation failed for event ID "${eventId}"; stored event was missing or malformed`,
		)
	}
	if (!eventReplayMatches(stored, doc, event, collection.bsonOptions)) {
		throw new Error(
			`event ID "${eventId}" is already assigned to a different event`,
		)
	}

	log.info(`event replayed: ${eventId} role=${event.role}`)
	return {
		eventId: stored.eventId,
		timestamp: stored.timestamp,
		scopeRef: stored.scopeRef,
	}
}

// ---------------------------------------------------------------------------
// Batch write (P3.9)
// ---------------------------------------------------------------------------

export type EventBatchItemResult =
	| {
			ok: true
			eventId: string
			timestamp: Date
			scopeRef: string
			/** Durable, but confirmed by a reconciliation read (a prior attempt of the same logical write holds the slot), not by this insert. */
			duplicateKey?: true
	  }
	| { ok: false; eventId?: string; duplicateKey: boolean; message: string }

type BulkWriteFailure = {
	writeErrors?: Array<{
		index: number
		code?: number
		errmsg?: string
		errInfo?: Document
	}>
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

export type BulkInsertOutcome =
	| {
			kind: "item-errors"
			writeErrors: Array<{
				index: number
				code?: number
				errmsg?: string
				errInfo?: Document
			}>
			writeConcernError: boolean
	  }
	| { kind: "no-writes-performed" }
	| { kind: "uncertain" }

/**
 * W09: classify a thrown insertMany error by what the server actually did,
 * per the shipped driver 7.5 shapes (EL-023):
 * - writeErrors array present → per-item failures; unlisted ops were applied
 *   by the unordered insert (EL-020). The write-concern combination is kept
 *   defensively, though driver 7.5 folds insertMany write-concern errors into
 *   a shape with no top-level writeErrors (EL-022).
 * - NoWritesPerformed error label → no writes occurred in that driver retry
 *   chain (EL-021). It says nothing about earlier engine-level attempts.
 * - Anything else (pure write-concern error, network exhaustion, unknown) →
 *   uncertain: the batch's fate is only knowable by a reconciliation read.
 */
export function classifyBulkInsertError(err: unknown): BulkInsertOutcome {
	const hasErrorLabel = (err as { hasErrorLabel?: (label: string) => boolean })
		?.hasErrorLabel
	if (
		typeof hasErrorLabel === "function" &&
		hasErrorLabel.call(err, "NoWritesPerformed")
	) {
		return { kind: "no-writes-performed" }
	}
	const writeErrorsRaw = (err as BulkWriteFailure).writeErrors
	const writeErrors = Array.isArray(writeErrorsRaw)
		? writeErrorsRaw.filter((we) => we && typeof we.index === "number")
		: []
	if (writeErrors.length > 0) {
		return {
			kind: "item-errors",
			writeErrors,
			writeConcernError: carriesWriteConcernError(err),
		}
	}
	return { kind: "uncertain" }
}

/**
 * EL-022/EL-023: detect all supported write-concern error shapes
 * defensively. For insertMany, driver 7.5 throws before processing per-item
 * results and leaves top-level writeErrors empty, so the current caller
 * classifies that shape as wholly uncertain instead of reaching the combined
 * item-errors/writeConcernError branch.
 */
function carriesWriteConcernError(err: unknown): boolean {
	if (!err || typeof err !== "object") {
		return false
	}
	const candidate = err as {
		err?: unknown
		result?: { getWriteConcernError?: () => unknown }
		getWriteConcernError?: () => unknown
		writeConcernErrors?: unknown[]
	}
	if (candidate.err != null) {
		return true
	}
	if (
		Array.isArray(candidate.writeConcernErrors) &&
		candidate.writeConcernErrors.length > 0
	) {
		return true
	}
	const viaResult = candidate.result?.getWriteConcernError?.()
	if (viaResult != null) {
		return true
	}
	const viaSelf = candidate.getWriteConcernError?.()
	return viaSelf != null
}

/**
 * W09 reconciliation read: which of the given eventIds are majority-visible
 * in the events collection. Presence confirms durability and cannot roll
 * back. Absence only means durability is unconfirmed at read time: an earlier
 * attempt may still majority-commit, so retry requires the same logical-write
 * identity (idempotency key or caller-pinned eventId).
 */
export async function findExistingEventIds(params: {
	db: Db
	prefix: string
	eventIds: string[]
}): Promise<Set<string>> {
	const { db, prefix, eventIds } = params
	if (eventIds.length === 0) {
		return new Set()
	}
	const docs = await eventsCollection(db, prefix)
		.find(
			{ eventId: { $in: eventIds } },
			{
				projection: { _id: 0, eventId: 1 },
				readConcern: { level: "majority" },
			},
		)
		.toArray()
	const existing = new Set<string>()
	for (const doc of docs) {
		const eventId = (doc as { eventId?: string }).eventId
		if (typeof eventId === "string") {
			existing.add(eventId)
		}
	}
	return existing
}

export async function findExistingEventsForReplay(params: {
	collection: Collection
	eventIds: string[]
}): Promise<Map<string, Document>> {
	const { collection, eventIds } = params
	if (eventIds.length === 0) {
		return new Map()
	}
	const docs = await collection
		.find(
			{ eventId: { $in: eventIds } },
			{
				projection: EVENT_REPLAY_PROJECTION,
				...EVENT_IDENTITY_READ_OPTIONS,
				readConcern: { level: "majority" },
			},
		)
		.toArray()
	const existing = new Map<string, Document>()
	for (const doc of docs) {
		if (typeof doc.eventId === "string") {
			existing.set(doc.eventId, doc)
		}
	}
	return existing
}

/**
 * W09: for docs whose durability the server did not confirm, read back which
 * eventIds are majority-visible. Present = durable — receipt ok with
 * duplicateKey flagged so the caller maps it to the replay path; absent =
 * durability unconfirmed — ok:false, with identity-preserving retry guidance.
 * If the reconciliation read itself fails, items get "durability unconfirmed"
 * receipts instead of a throw: a throw after a possible durable commit is the
 * W08 anti-pattern, and receipts preserve the batch's siblings.
 */
async function reconcileEventBatchOutcomes(params: {
	db: Db
	prefix: string
	results: EventBatchItemResult[]
	docs: CanonicalEvent[]
	inputs: EventWriteInput[]
	docIndexes: number[]
	positions: number[]
	keyedDuplicateMessages?: Map<number, string>
}): Promise<void> {
	const {
		db,
		prefix,
		results,
		docs,
		inputs,
		docIndexes,
		positions,
		keyedDuplicateMessages,
	} = params
	if (positions.length === 0) {
		return
	}
	let existing: Map<string, Document>
	const collection = eventsCollection(db, prefix)
	try {
		existing = await findExistingEventsForReplay({
			collection,
			eventIds: positions.map((position) => docs[position].eventId),
		})
	} catch (err) {
		log.warn(
			`event batch reconciliation read failed; ${positions.length} item(s) reported durability-unconfirmed: ${String(err)}`,
		)
		for (const position of positions) {
			const doc = docs[position]
			results[docIndexes[position]] = {
				ok: false,
				eventId: doc.eventId,
				duplicateKey: false,
				message:
					"event durability unconfirmed (majority reconciliation read failed); outcome may have committed; retry only with the same idempotency key or caller-pinned eventId",
			}
		}
		return
	}
	for (const position of positions) {
		const doc = docs[position]
		const stored = existing.get(doc.eventId)
		if (stored === undefined) {
			results[docIndexes[position]] = keyedDuplicateMessages?.has(position)
				? {
						ok: false,
						eventId: doc.eventId,
						duplicateKey: true,
						message:
							keyedDuplicateMessages.get(position) ?? "event insert failed",
					}
				: {
						ok: false,
						eventId: doc.eventId,
						duplicateKey: false,
						message:
							"event durability unconfirmed; not found by majority reconciliation read; retry only with the same idempotency key or caller-pinned eventId",
					}
		} else if (!isStoredEventReplayDocument(stored)) {
			results[docIndexes[position]] = {
				ok: false,
				eventId: doc.eventId,
				duplicateKey: false,
				message:
					"event replay identity unconfirmed; stored event was malformed",
			}
		} else if (
			eventReplayMatches(stored, doc, inputs[position], collection.bsonOptions)
		) {
			results[docIndexes[position]] = {
				ok: true,
				eventId: stored.eventId,
				timestamp: stored.timestamp,
				scopeRef: stored.scopeRef,
				duplicateKey: true,
			}
		} else if (stored) {
			results[docIndexes[position]] = {
				ok: false,
				eventId: doc.eventId,
				duplicateKey: false,
				message: `event ID "${doc.eventId}" is already assigned to a different event`,
			}
		}
	}
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
	const inputs: EventWriteInput[] = []
	const docIndexes: number[] = []
	const results: EventBatchItemResult[] = events.map(() => ({
		ok: false as const,
		duplicateKey: false,
		message: "event write not attempted",
	}))
	for (const [index, event] of events.entries()) {
		try {
			docs.push(buildCanonicalEventDocument(event))
			inputs.push(event)
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
		const outcome = classifyBulkInsertError(err)
		if (outcome.kind === "no-writes-performed") {
			// EL-021: the server guarantees zero writes only within the final
			// driver retry chain. Earlier engine-level attempts remain unknown,
			// so retries must preserve logical-write identity.
			for (const [position, doc] of docs.entries()) {
				results[docIndexes[position]] = {
					ok: false,
					eventId: doc.eventId,
					duplicateKey: false,
					message:
						"final driver retry chain performed no writes; earlier attempts may have committed; retry only with the same idempotency key or caller-pinned eventId",
				}
			}
		} else if (outcome.kind === "item-errors") {
			const erroredPositions = new Set(
				outcome.writeErrors.map((writeError) => writeError.index),
			)
			const unconfirmedPositions: number[] = []
			const keyedDuplicateMessages = new Map<number, string>()
			for (const writeError of outcome.writeErrors) {
				const doc = docs[writeError.index]
				if (!doc) {
					continue
				}
				if (writeError.code === 11000) {
					// The eventId and agent/idempotencyKey indexes can both raise
					// E11000. Read the event ID before deciding whether this is a
					// replay, an identity conflict, or a keyed winner race.
					unconfirmedPositions.push(writeError.index)
					if (doc.idempotencyKey) {
						keyedDuplicateMessages.set(
							writeError.index,
							writeError.errmsg ?? "event insert failed",
						)
					}
					continue
				}
				results[docIndexes[writeError.index]] = {
					ok: false,
					eventId: doc.eventId,
					duplicateKey: false,
					message: writeError.errmsg ?? "event insert failed",
				}
			}
			for (const [position, doc] of docs.entries()) {
				if (erroredPositions.has(position)) {
					continue
				}
				if (outcome.writeConcernError) {
					// EL-022: a write-concern error rode along — unlisted items
					// were applied on the primary but their replication is
					// uncertain; confirm them by read.
					unconfirmedPositions.push(position)
					continue
				}
				// EL-020: unordered inserts apply every doc that did not error.
				results[docIndexes[position]] = {
					ok: true,
					eventId: doc.eventId,
					timestamp: doc.timestamp,
					scopeRef: doc.scopeRef,
				}
			}
			await reconcileEventBatchOutcomes({
				db,
				prefix,
				results,
				docs,
				inputs,
				docIndexes,
				positions: unconfirmedPositions,
				keyedDuplicateMessages,
			})
		} else {
			// Uncertain outcome (write concern without per-item report, or a
			// network error that exhausted retries mid-flight): the batch's
			// fate is only knowable by reading back what actually exists.
			await reconcileEventBatchOutcomes({
				db,
				prefix,
				results,
				docs,
				inputs,
				docIndexes,
				positions: docs.map((_, position) => position),
			})
		}
	}

	log.info(`event batch processed: ${docs.length} event(s)`)
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
	session?: ClientSession
}): Promise<boolean> {
	const result = await eventsCollection(params.db, params.prefix).updateOne(
		{
			eventId: params.eventId,
			agentId: params.agentId,
			extractionJobPendingAt: { $exists: true },
		},
		{ $unset: { extractionJobPendingAt: "" } },
		params.session
			? { session: params.session }
			: { writeConcern: DURABLE_EVENT_WRITE_CONCERN },
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
	session?: ClientSession
}): Promise<number> {
	const { db, prefix, eventIds } = params
	if (eventIds.length === 0) {
		return 0
	}
	const collection = eventsCollection(db, prefix)
	const filter = { eventId: { $in: eventIds } }
	const update = { $set: { projectedAt: new Date() } }
	const result = params.session
		? await collection.updateMany(filter, update, { session: params.session })
		: await collection.updateMany(filter, update)
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
	agentId?: string
	session?: ClientSession
}): Promise<number> {
	const { db, prefix, eventIds, episodeId } = params
	if (eventIds.length === 0) {
		return 0
	}
	const collection = eventsCollection(db, prefix)
	const filter = {
		eventId: { $in: eventIds },
		...(params.agentId ? { agentId: params.agentId } : {}),
	}
	const update = {
		$set: { consolidatedAt: new Date(), consolidatedIntoEpisodeId: episodeId },
	}
	const result = params.session
		? await collection.updateMany(filter, update, { session: params.session })
		: await collection.updateMany(filter, update)

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
	admission?: AdmissionToken
}): Promise<{ eventsProcessed: number; chunksCreated: number }> {
	const { db, prefix, agentId, batchSize } = params
	const startMs = Date.now()
	const admission =
		params.admission ?? (await captureAdmissionToken({ db, prefix, agentId }))
	if (admission.kind !== "admission" || admission.agentId !== agentId)
		throw new ErasureGateConflictError(agentId)
	const gate = await readErasureGate({ db, prefix, agentId })
	if (!gate || gate.state !== "open" || gate.epoch !== admission.epoch)
		throw new ErasureGateConflictError(agentId)

	const events = await getUnprojectedEvents({
		db,
		prefix,
		agentId,
		limit: batchSize,
	})
	if (events.length === 0) return { eventsProcessed: 0, chunksCreated: 0 }
	let chunksCreated = 0
	try {
		for (const event of events) {
			const { chunkCreated } = await withFencedWrite({
				db,
				prefix,
				token: admission,
				fn: (session) =>
					projectEventChunk({ db, prefix, event, recordRun: false, session }),
			})
			if (chunkCreated) chunksCreated++
		}
	} catch (err) {
		if (isErasureGateConflictError(err)) throw err
		const run = {
			agentId,
			projectionType: "chunks" as const,
			status: "failed" as const,
			itemsProjected: chunksCreated,
			durationMs: Date.now() - startMs,
		}
		await withFencedWrite({
			db,
			prefix,
			token: admission,
			fn: (session) => recordProjectionRun({ db, prefix, run, session }),
		}).catch((diagnosticErr) =>
			log.warn(
				"projection repair failed-run record was not written",
				settledFailureMeta(diagnosticErr),
			),
		)
		const msg = err instanceof Error ? err.message : String(err)
		log.warn(
			`projection failed after ${chunksCreated} chunks created from ${events.length} events for agent=${agentId}: ${msg}`,
		)
		throw err
	}
	const run = {
		agentId,
		projectionType: "chunks" as const,
		status: "ok" as const,
		itemsProjected: chunksCreated,
		durationMs: Date.now() - startMs,
	}
	await withFencedWrite({
		db,
		prefix,
		token: admission,
		fn: (session) => recordProjectionRun({ db, prefix, run, session }),
	}).catch((err) =>
		log.warn(
			"projection repair run record was not written",
			settledFailureMeta(err),
		),
	)
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
 *
 * Session path (fence interior): when a session rides the params the same
 * pair of writes runs inside the caller's withTransaction — both writes go
 * straight to the collections carrying the session (no
 * retryTransientMongoWrite wrapper: the outer transaction owns retry) and any
 * failure rethrows RAW (the sessionless partial and W08 degrades must not
 * mask an abort inside the caller's fence). recordRun must be false and no
 * projection run is recorded — the caller owns diagnostics in separate
 * fenced writes.
 */
export async function projectEventChunksBatch(params: {
	db: Db
	prefix: string
	events: CanonicalEvent[]
	recordRun?: boolean
	session?: ClientSession
}): Promise<Array<{ chunkCreated: boolean }>> {
	const { db, prefix, events } = params
	const startMs = Date.now()
	if (events.length === 0) {
		return []
	}
	if (params.session && params.recordRun !== false) {
		throw new TypeError(
			"projectEventChunksBatch requires recordRun:false when a session is provided",
		)
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
						// RET-09: see projectEventChunk — role rides $setOnInsert
						// so mappers can label provenance directly.
						role: event.role,
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

	if (params.session) {
		// Session path (fence interior): the caller's withTransaction owns
		// retry and abort, so both writes ride the session directly with no
		// retryTransientMongoWrite wrapper, and any failure rethrows RAW —
		// the sessionless partial and W08 degrades would mask an abort
		// inside the caller's fence. recordRun is pinned false by the guard
		// above; no projection run is recorded — the caller owns diagnostics
		// in separate fenced writes.
		const result = await chunks.bulkWrite(ops, {
			ordered: false,
			session: params.session,
		})
		const sessionUpsertedIndexes = new Set(
			Object.keys(result.upsertedIds ?? {}).map((key) => Number(key)),
		)
		await markEventsProjected({
			db,
			prefix,
			eventIds: events.map((event) => event.eventId),
			session: params.session,
		})
		return events.map((_, index) => ({
			chunkCreated: sessionUpsertedIndexes.has(index),
		}))
	}

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
	let markerSet = true
	try {
		await retryTransientMongoWrite("events.markProjectedBatch", () =>
			markEventsProjected({ db, prefix, eventIds: projectableIds }),
		)
	} catch (err) {
		// W08: the chunks are durable but the projectedAt marker is not; the
		// events stay in the unprojected set so the repair pass re-projects
		// them (the chunk upsert is idempotent by path). Degrade to a
		// diagnostic instead of throwing out of a durable write path.
		markerSet = false
		log.warn(
			`batch projectedAt marker failed for ${projectableIds.length} event(s); leaving them unprojected for the repair pass: ${String(err)}`,
		)
	}

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
				status: failedIndexes.size > 0 || !markerSet ? "failed" : "ok",
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
	session?: ClientSession
}): Promise<{ chunkCreated: boolean }> {
	const { db, prefix, event } = params
	if (params.session && params.recordRun !== false) {
		throw new TypeError(
			"projectEventChunk requires recordRun:false when a session is provided",
		)
	}
	const startMs = Date.now()
	const chunks = chunksCollection(db, prefix)
	const path = `events/${event.eventId}`
	const text = renderEventChunkText(event)
	const hash = createHash("sha256").update(text).digest("hex")
	const writeChunk = () =>
		chunks.updateOne(
			{ path },
			{
				$setOnInsert: {
					path,
					text,
					hash,
					source: "conversation",
					// RET-09: preserve the turn's authoring role so search
					// mappers can label provenance without parsing the text
					// prefix. $setOnInsert (not $set): the role is immutable
					// like the text, and legacy chunks keep recovering it
					// from the renderEventChunkText prefix.
					role: event.role,
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
			params.session
				? { upsert: true, session: params.session }
				: { upsert: true },
		)
	const result = params.session
		? await writeChunk()
		: await retryTransientMongoWrite("chunks.updateOne", writeChunk)
	let markerSet = true
	try {
		const markProjected = () =>
			markEventsProjected({
				db,
				prefix,
				eventIds: [event.eventId],
				session: params.session,
			})
		if (params.session) {
			await markProjected()
		} else {
			await retryTransientMongoWrite("events.markProjected", markProjected)
		}
	} catch (err) {
		if (params.session) {
			throw err
		}
		// W08: same degradation as the batch variant — the chunk is durable,
		// the event stays unprojected, the repair pass re-projects it.
		markerSet = false
		log.warn(
			`projectedAt marker failed for ${event.eventId}; leaving the event unprojected for the repair pass: ${String(err)}`,
		)
	}
	if (params.recordRun !== false) {
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId: event.agentId,
				projectionType: "chunks",
				status: markerSet ? "ok" : "failed",
				itemsProjected: result.upsertedCount > 0 ? 1 : 0,
				durationMs: Date.now() - startMs,
			},
		}).catch(() => {})
	}
	return { chunkCreated: result.upsertedCount > 0 }
}
