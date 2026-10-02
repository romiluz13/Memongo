import { randomUUID } from "node:crypto"
import type { MemoryJob } from "./types.js"
import type { OperationRunContext } from "./mongodb-operation-accounting.js"
import { isDuplicateKeyError } from "./internal.js"
import { settledFailureMeta } from "./query-diagnostics.js"
import { recordEmbeddingSpend } from "./mongodb-cost-ledger.js"
import {
	extractStructuredCandidatesFromEvent,
	extractProcedureCandidatesFromEvent,
} from "./mongodb-derived-memory.js"
import {
	buildCanonicalEventDocument,
	classifyBulkInsertError,
	EVENT_IDEMPOTENCY_REPLAY_PROJECTION,
	clearEventExtractionJobPending,
	clearEventExtractionJobPendingBatch,
	eventReplayMatches,
	type EventReplayDocument,
	type EventWriteInput,
	findExistingEventsForReplay,
	isStoredEventReplayDocument,
	projectEventChunk,
	projectEventChunksBatch,
	writeEvent,
	IdempotencyConflictError,
	pruneIdempotencyFingerprints,
	resolveIdempotencyRetentionDays,
	IDEMPOTENCY_FINGERPRINT_PRUNE_INTERVAL_MS,
} from "./mongodb-events.js"
import {
	EVENT_IDENTITY_READ_OPTIONS,
	type EventMetadataWriteOptions,
	eventMetadataMatchesPersistedForm,
} from "./mongodb-event-metadata-identity.js"
import { computeIdempotencyFingerprint } from "./mongodb-idempotency-fingerprint.js"
import type { CanonicalEvent } from "./mongodb-events.js"
import { updateLaneCoverage } from "./mongodb-lane-coverage.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { recordIngestRun, recordProjectionRun } from "./mongodb-ops.js"
import {
	createMemoryJob,
	createMemoryJobsBatch,
	getMemoryJob,
	releaseStagedMemoryJob,
	releaseStagedMemoryJobsBatch,
} from "./mongodb-memory-jobs.js"
import { QueryCacheInvalidationCoalescer } from "./mongodb-query-cache-invalidation.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { eventsCollection } from "./mongodb-schema.js"
import { resolveScopeIdentity } from "./mongodb-scope.js"
import { resolveWriteExpiresAt } from "./mongodb-temporal.js"
import { resolveDefaultScope } from "./backend-config.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	ErasureGateConflictError,
	withFencedWrite,
} from "./mongodb-write-fence.js"
import type { MemoryScope } from "@memongo/lib"
import type { ClientSession, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb")

type BatchEventWriteReceipt =
	| {
			ok: true
			eventId: string
			chunkCreated: boolean
			replayed?: boolean
	  }
	| {
			ok: false
			code: "IDEMPOTENCY_CONFLICT" | "WRITE_ERROR"
			message: string
	  }

type PreparedBatchItem = {
	index: number
	input: EventWriteInput
	event: CanonicalEvent
	job?: Omit<MemoryJob, "createdAt"> & { createdAt?: Date }
}

type PreparedBatchGroup = {
	idempotencyKey?: string
	members: PreparedBatchItem[]
}

type BatchRoundDraft = {
	receipts: Map<number, BatchEventWriteReceipt>
	inserted: PreparedBatchItem[]
}

type AttributableEventIssue = {
	kind: "validation" | "idempotency-duplicate"
	originalIndex: number
	message: string
}

class AttributableEventBatchAbort extends Error {
	readonly issues: AttributableEventIssue[]
	readonly attemptedIndexes: number[]

	constructor(
		issues: AttributableEventIssue[],
		attemptedIndexes: number[],
		cause: unknown,
	) {
		super("transactional event insert had attributable item errors", {
			cause,
		})
		this.name = "AttributableEventBatchAbort"
		this.issues = issues
		this.attemptedIndexes = attemptedIndexes
	}
}

class BatchBodyAbort extends Error {
	readonly attemptedIndexes: number[]

	constructor(cause: unknown, attemptedIndexes: number[] = []) {
		super(cause instanceof Error ? cause.message : String(cause), { cause })
		this.name = "BatchBodyAbort"
		this.attemptedIndexes = attemptedIndexes
	}
}

function hasMongoErrorLabel(err: unknown, label: string): boolean {
	const hasErrorLabel = (err as { hasErrorLabel?: (value: string) => boolean })
		?.hasErrorLabel
	return (
		typeof hasErrorLabel === "function" &&
		hasErrorLabel.call(err, label) === true
	)
}

function isIdempotencyIndexWriteError(writeError: {
	errmsg?: string
	errInfo?: Document
}): boolean {
	const keyPattern = writeError.errInfo?.keyPattern
	if (keyPattern && typeof keyPattern === "object") {
		const keys = Object.keys(keyPattern)
		if (
			keys.length === 2 &&
			keys.includes("agentId") &&
			keys.includes("idempotencyKey")
		) {
			return true
		}
	}
	return (
		writeError.errmsg?.includes("index: uq_events_agent_idempotency_key ") ===
		true
	)
}

function classifyAttributableEventBatchAbort(
	err: unknown,
	leaders: PreparedBatchItem[],
): AttributableEventIssue[] | undefined {
	const outcome = classifyBulkInsertError(err)
	const rawWriteErrors = (
		err as {
			writeErrors?: unknown
		}
	)?.writeErrors
	if (
		outcome.kind !== "item-errors" ||
		outcome.writeConcernError ||
		outcome.writeErrors.length === 0 ||
		!Array.isArray(rawWriteErrors) ||
		rawWriteErrors.length !== outcome.writeErrors.length
	) {
		return undefined
	}
	const seen = new Set<number>()
	const issues: AttributableEventIssue[] = []
	for (const writeError of outcome.writeErrors) {
		if (
			!Number.isInteger(writeError.index) ||
			writeError.index < 0 ||
			writeError.index >= leaders.length ||
			seen.has(writeError.index)
		) {
			return undefined
		}
		seen.add(writeError.index)
		const leader = leaders[writeError.index]
		if (writeError.code === 121) {
			issues.push({
				kind: "validation",
				originalIndex: leader.index,
				message: writeError.errmsg ?? "event validation failed",
			})
			continue
		}
		if (
			writeError.code === 11000 &&
			leader.event.idempotencyKey &&
			isIdempotencyIndexWriteError(writeError)
		) {
			issues.push({
				kind: "idempotency-duplicate",
				originalIndex: leader.index,
				message: writeError.errmsg ?? "event insert failed",
			})
			continue
		}
		return undefined
	}
	return issues
}

function batchWriteError(message: string): BatchEventWriteReceipt {
	return { ok: false, code: "WRITE_ERROR", message }
}

function replayMatches(
	stored: EventReplayDocument,
	item: PreparedBatchItem,
	writeOptions: EventMetadataWriteOptions,
): boolean {
	const fingerprintOrLegacyFieldsMatch = stored.idempotencyFingerprint
		? stored.idempotencyFingerprint === item.event.idempotencyFingerprint
		: stored.role === item.event.role &&
			stored.body === item.event.body &&
			(stored.sessionId ?? undefined) === item.event.sessionId &&
			stored.scope === item.event.scope &&
			stored.scopeRef === item.event.scopeRef
	if (!fingerprintOrLegacyFieldsMatch) {
		return false
	}
	return eventMetadataMatchesPersistedForm(
		stored.metadata ?? {},
		item.input.metadata ?? {},
		writeOptions,
	)
}

function mintedAttemptMatches(
	stored: EventReplayDocument,
	item: PreparedBatchItem,
	writeOptions: EventMetadataWriteOptions,
): boolean {
	if (stored.eventId !== item.event.eventId) {
		return false
	}
	for (const field of ["invalidAt", "expiresAt"] as const) {
		if (Object.hasOwn(stored, field) !== Object.hasOwn(item.event, field)) {
			return false
		}
	}
	return eventReplayMatches(
		stored,
		item.event,
		{
			...item.input,
			timestamp: item.event.timestamp,
			validAt: item.event.validAt,
		},
		writeOptions,
	)
}

function draftGroupAgainstWinner(params: {
	group: PreparedBatchGroup
	stored: Document
	writeOptions: EventMetadataWriteOptions
}): Map<number, BatchEventWriteReceipt> {
	const receipts = new Map<number, BatchEventWriteReceipt>()
	if (!isStoredEventReplayDocument(params.stored)) {
		for (const member of params.group.members) {
			receipts.set(
				member.index,
				batchWriteError(
					"idempotency replay identity unconfirmed; stored event was malformed",
				),
			)
		}
		return receipts
	}
	for (const member of params.group.members) {
		try {
			if (replayMatches(params.stored, member, params.writeOptions)) {
				receipts.set(member.index, {
					ok: true,
					eventId: params.stored.eventId,
					chunkCreated: false,
					replayed: true,
				})
			} else {
				receipts.set(member.index, {
					ok: false,
					code: "IDEMPOTENCY_CONFLICT",
					message: "idempotency key was reused with a different payload",
				})
			}
		} catch {
			receipts.set(
				member.index,
				batchWriteError(
					"idempotency payload comparison could not be completed",
				),
			)
		}
	}
	return receipts
}

function draftInsertedGroup(params: {
	group: PreparedBatchGroup
	writeOptions: EventMetadataWriteOptions
}): Map<number, BatchEventWriteReceipt> {
	const [leader, ...followers] = params.group.members
	const receipts = new Map<number, BatchEventWriteReceipt>([
		[
			leader.index,
			{ ok: true, eventId: leader.event.eventId, chunkCreated: false },
		],
	])
	for (const follower of followers) {
		try {
			if (replayMatches(leader.event, follower, params.writeOptions)) {
				receipts.set(follower.index, {
					ok: true,
					eventId: leader.event.eventId,
					chunkCreated: false,
					replayed: true,
				})
			} else {
				receipts.set(follower.index, {
					ok: false,
					code: "IDEMPOTENCY_CONFLICT",
					message: "idempotency key was reused with a different payload",
				})
			}
		} catch {
			receipts.set(
				follower.index,
				batchWriteError(
					"idempotency payload comparison could not be completed",
				),
			)
		}
	}
	return receipts
}

// ---------------------------------------------------------------------------
// WS-11 change 4 (09-report R7/B5): bounded per-agent writeQueue.
//
// The queue used to be an unbounded promise chain: a burst of 10k writes
// created 10k pending closures in RAM with no depth cap, no rejection
// signal, and silently growing client latency — nothing could tell "slow"
// from "stuck". It is now depth-capped with a FAST-FAIL policy: a write
// arriving at a saturated queue throws WriteQueueFullError immediately (the
// caller can back off, buffer, or surface it) and a write-queue-saturation
// telemetry doc records the depth at denial. Fast-fail was chosen over
// oldest-drop because dropping accepted work silently discards data the
// caller believes is durable; a typed, immediate rejection keeps the
// failure observable and the decision with the caller.
// ---------------------------------------------------------------------------

/** Saturation cap for the per-agent write queue (MEMONGO_WRITE_QUEUE_MAX_DEPTH). */
const WRITE_QUEUE_MAX_DEPTH_DEFAULT = 256

export function resolveWriteQueueMaxDepth(
	env: { MEMONGO_WRITE_QUEUE_MAX_DEPTH?: string } = process.env,
): number {
	const raw = env.MEMONGO_WRITE_QUEUE_MAX_DEPTH?.trim()
	if (raw !== undefined && raw !== "") {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed >= 1) {
			return Math.floor(parsed)
		}
	}
	return WRITE_QUEUE_MAX_DEPTH_DEFAULT
}

/** Typed fast-fail thrown when the per-agent write queue is saturated. */
export class WriteQueueFullError extends Error {
	readonly code = "WRITE_QUEUE_FULL"
	readonly queueDepth: number
	readonly maxDepth: number
	constructor(queueDepth: number, maxDepth: number) {
		super(
			`per-agent write queue saturated (depth ${queueDepth} >= cap ${maxDepth}); fast-failing this write instead of queuing without bound`,
		)
		this.name = "WriteQueueFullError"
		this.queueDepth = queueDepth
		this.maxDepth = maxDepth
	}
}

/**
 * Enqueue one write slot on the per-agent write queue with a depth cap.
 * Depth counts enqueued-but-unfinished writes (the strict serial chain means
 * at most one is executing; the rest wait). The counter increments before
 * chaining and decrements when THIS write settles, so the cap bounds both
 * RAM (pending closures) and tail latency (queue depth x per-write RTT).
 * Exported so the bound itself is unit-testable without a MongoDB manager.
 */
export function enqueueBoundedWrite<T>(
	host: Pick<
		MongoDBManagerHost,
		"db" | "prefix" | "agentId" | "writeQueue" | "writeQueueDepth"
	>,
	execute: () => Promise<T>,
): Promise<T> {
	const maxDepth = resolveWriteQueueMaxDepth()
	if (host.writeQueueDepth >= maxDepth) {
		emitTelemetry(host.db, host.prefix, {
			meta: { agentId: host.agentId, operation: "write-queue-saturation" },
			durationMs: 0,
			ok: false,
			itemCount: host.writeQueueDepth,
			depth: host.writeQueueDepth,
			threshold: maxDepth,
		})
		throw new WriteQueueFullError(host.writeQueueDepth, maxDepth)
	}
	host.writeQueueDepth += 1
	const next = host.writeQueue.then(execute, execute)
	host.writeQueue = next.then(
		() => undefined,
		() => undefined,
	)
	const releaseDepth = () => {
		host.writeQueueDepth -= 1
	}
	next.then(releaseDepth, releaseDepth)
	return next
}

/** Input shape shared by writeConversationEvent and its batch variant. */
export type WriteConversationEventInput = {
	role: "user" | "assistant" | "system" | "tool"
	body: string
	sessionId?: string
	timestamp?: Date
	validAt?: Date
	invalidAt?: Date
	metadata?: Record<string, unknown>
	scope?: MemoryScope
	scopeRef?: string
	/**
	 * P4.4.1: explicit per-write expiry instant. Wins over the
	 * `memory.mongodb.ttl` session-scope default; when neither applies the
	 * event is written without an expiresAt and never expires.
	 */
	expiresAt?: Date
	/**
	 * Optional idempotency key: retries with the same key replay the
	 * original receipt (no duplicate event); reuse with a different
	 * payload is rejected with IdempotencyConflictError (422 upstream).
	 */
	idempotencyKey?: string
}

/**
 * P3.9 per-item batch receipt, mirroring the single-write receipt shape.
 * A replayed receipt reports chunkCreated:false (the chunk from the accepted
 * write already exists). A failed item never fails its siblings.
 */
export type WriteConversationEventReceipt =
	| { ok: true; eventId: string; chunkCreated: boolean; replayed?: boolean }
	| {
			ok: false
			code: "IDEMPOTENCY_CONFLICT" | "WRITE_ERROR"
			message: string
	  }

export class MongoDBManagerWriteOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	/**
	 * In-process gate for the C-006 prune sweep: at most one prune per hour
	 * per manager instance, so the worker drain loop (which wakes on every
	 * write) pays a Date.now() comparison and nothing else. 0 = never run.
	 */
	private lastFingerprintPruneAt = 0

	/**
	 * C-006: retention enforcement for idempotency fingerprint state. $Unsets
	 * idempotencyKey/idempotencyFingerprint from completed writes older than
	 * the retention window (default 90 days, MEMONGO_IDEMPOTENCY_RETENTION_DAYS
	 * override). The memory-job worker sweep calls this on every drain; the
	 * hourly gate keeps it off the write hot path. `force` bypasses the gate
	 * for explicit operator/test invocation.
	 */
	async pruneIdempotencyFingerprints(params?: {
		olderThanDays?: number
		force?: boolean
		admission?: AdmissionToken
	}): Promise<{ pruned: number }> {
		try {
			const now = Date.now()
			if (
				!params?.force &&
				this.lastFingerprintPruneAt !== 0 &&
				now - this.lastFingerprintPruneAt <
					IDEMPOTENCY_FINGERPRINT_PRUNE_INTERVAL_MS
			)
				return { pruned: 0 }
			const admission =
				params?.admission ??
				(await captureAdmissionToken({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
				}))
			if (admission.agentId !== this.host.agentId)
				throw new ErasureGateConflictError(this.host.agentId)
			const at = new Date(now)
			const olderThanDays =
				params?.olderThanDays ?? resolveIdempotencyRetentionDays()
			const result = await withFencedWrite({
				db: this.host.db,
				prefix: this.host.prefix,
				token: admission,
				fn: (session) =>
					pruneIdempotencyFingerprints({
						db: this.host.db,
						prefix: this.host.prefix,
						agentId: this.host.agentId,
						now: at,
						session,
						olderThanDays,
					}),
			})
			this.lastFingerprintPruneAt = now
			return result
		} catch (err) {
			if (params?.admission) throw err
			log.warn("pruneIdempotencyFingerprints failed", settledFailureMeta(err))
			return { pruned: 0 }
		}
	}

	scheduleQueryCacheInvalidation(params: {
		agentId: string
		scope: MemoryScope
		scopeRef: string
		admission?: AdmissionToken
	}): void {
		const { admission, agentId, scope, scopeRef } = params
		if (
			admission &&
			(admission.kind !== "admission" ||
				admission.agentId !== agentId ||
				agentId !== this.host.agentId)
		) {
			log.warn("query cache invalidation admission mismatch")
			return
		}
		if (!this.host.queryCacheInvalidationCoalescer) {
			this.host.queryCacheInvalidationCoalescer =
				new QueryCacheInvalidationCoalescer()
		}
		const namespace = {
			db: this.host.db,
			prefix: this.host.prefix,
			agentId,
			scope,
			scopeRef,
		}
		const coalescer = this.host.queryCacheInvalidationCoalescer
		coalescer.schedule(
			admission
				? JSON.stringify([agentId, scope, scopeRef, admission.epoch])
				: `${agentId}|${scope}|${scopeRef}`,
			() => {
				if (admission) {
					void withFencedWrite({
						db: namespace.db,
						prefix: namespace.prefix,
						token: admission,
						fn: (session) =>
							invalidateQueryCache({
								...namespace,
								session,
								throwOnError: true,
							}),
					}).catch((err) =>
						log.warn(
							"query cache invalidation failed",
							settledFailureMeta(err),
						),
					)
				} else {
					void invalidateQueryCache(namespace)
				}
			},
		)
	}

	/**
	 * Fingerprint used to detect key-reuse-with-different-payload (IETF §2.7).
	 * scope/scopeRef are compared AFTER resolution so an explicit scopeRef and
	 * the equivalent resolved one count as the same payload.
	 */
	resolveIdempotencyFingerprint(event: {
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		scope?: MemoryScope
		scopeRef?: string
	}): {
		role: string
		body: string
		sessionId?: string
		scope: MemoryScope
		scopeRef: string
	} {
		// P2.3: the fingerprint must resolve scope with the SAME rule the write
		// itself uses, or a retried implicit-session write would mismatch the
		// stored document and surface as a false 422 conflict. W06: that
		// includes the workspaceDir, so a workspace-scope payload compares
		// against the partition the write actually landed in.
		const { scope, scopeRef } = resolveScopeIdentity({
			scope: event.scope,
			scopeRef: event.scopeRef,
			agentId: this.host.agentId,
			sessionId: event.sessionId,
			workspaceDir: this.host.workspaceDir,
		})
		return {
			role: event.role,
			body: event.body,
			sessionId: event.sessionId,
			scope,
			scopeRef,
		}
	}

	/**
	 * D1/B3: the write-path fallback scope — unified MEMONGO_DEFAULT_SCOPE;
	 * the legacy search-only name does not move writes. Resolved per call
	 * (env-backed, like the read path) so tests and per-process config stay
	 * authoritative.
	 */
	private resolveWriteDefaultScope(): MemoryScope {
		return resolveDefaultScope({
			value: process.env.MEMONGO_DEFAULT_SCOPE,
			legacyValue: process.env.MEMONGO_SEARCH_DEFAULT_SCOPE,
			applyTo: "write",
			warn: (message) => log.warn(message),
		})
	}

	/**
	 * B4: does this request payload match the event previously persisted
	 * under its idempotency key? Both write paths (single + batch) share this
	 * one comparison. Docs written with a stored fingerprint (B4 onward)
	 * first compare the unchanged canonical fingerprint. Pre-B4 docs carry no
	 * fingerprint and fall back to the legacy five-field compare so in-flight
	 * retries across the upgrade still replay instead of false-conflicting.
	 * After that gate passes, both variants compare metadata by its BSON-
	 * persisted meaning because the historical JSON fingerprint can alias
	 * values with different BSON types.
	 */
	idempotencyPayloadMatches(
		existing: CanonicalEvent,
		event: {
			role: "user" | "assistant" | "system" | "tool"
			body: string
			sessionId?: string
			scope?: MemoryScope
			scopeRef?: string
			timestamp?: Date
			validAt?: Date
			invalidAt?: Date
			metadata?: Record<string, unknown>
			expiresAt?: Date
		},
		writeOptions: EventMetadataWriteOptions,
	): boolean {
		let fingerprintOrLegacyFieldsMatch: boolean
		if (existing.idempotencyFingerprint) {
			fingerprintOrLegacyFieldsMatch =
				existing.idempotencyFingerprint ===
				computeIdempotencyFingerprint(
					event,
					this.host.agentId,
					this.resolveWriteDefaultScope(),
					this.host.workspaceDir,
				)
		} else {
			const incoming = this.host.resolveIdempotencyFingerprint(event)
			fingerprintOrLegacyFieldsMatch =
				existing.role === incoming.role &&
				existing.body === incoming.body &&
				(existing.sessionId ?? undefined) === incoming.sessionId &&
				existing.scope === incoming.scope &&
				existing.scopeRef === incoming.scopeRef
		}
		if (!fingerprintOrLegacyFieldsMatch) {
			return false
		}
		return eventMetadataMatchesPersistedForm(
			existing.metadata ?? {},
			event.metadata ?? {},
			writeOptions,
		)
	}

	/**
	 * Idempotency replay (IETF Idempotency-Key / Stripe): a retry carrying a
	 * known key returns the original write's receipt instead of duplicating
	 * the event. chunkCreated reports false because the chunk projection from
	 * the accepted write already exists (replaying the request does not create
	 * a second one). Key reuse with a different payload is a 422 conflict.
	 */
	async replayIdempotentEventWrite(params: {
		idempotencyKey: string
		event: {
			role: "user" | "assistant" | "system" | "tool"
			body: string
			sessionId?: string
			scope?: MemoryScope
			scopeRef?: string
			timestamp?: Date
			validAt?: Date
			invalidAt?: Date
			metadata?: Record<string, unknown>
			expiresAt?: Date
		}
		session?: ClientSession
	}): Promise<{ eventId: string; chunkCreated: boolean } | null> {
		const filter = {
			agentId: this.host.agentId,
			idempotencyKey: params.idempotencyKey,
		}
		const collection = eventsCollection(this.host.db, this.host.prefix)
		const existing = (await (params.session
			? collection.findOne(filter, {
					...EVENT_IDENTITY_READ_OPTIONS,
					session: params.session,
				})
			: collection.findOne(filter, {
					...EVENT_IDENTITY_READ_OPTIONS,
					readConcern: { level: "majority" },
				}))) as CanonicalEvent | null
		if (!existing) {
			return null
		}
		if (
			!this.idempotencyPayloadMatches(
				existing,
				params.event,
				collection.bsonOptions,
			)
		) {
			throw new IdempotencyConflictError(params.idempotencyKey)
		}
		return { eventId: existing.eventId, chunkCreated: false }
	}

	async writeConversationEvent(
		event: WriteConversationEventInput,
		operationRunContext?: OperationRunContext,
	): Promise<{ eventId: string; chunkCreated: boolean }> {
		// (P2.5 e) shutdown intake stop: once close() begins, no new writes
		// enter the queue — a write queued during shutdown would schedule
		// extraction jobs and derivations on workers that are stopping.
		if (this.host.closed) {
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to queue a new write",
			)
		}
		// Capture admission at the public call boundary, before queue delay can
		// make this write appear newer than an intervening erasure. Convert the
		// promise to a settled result immediately so a queue fast-fail cannot
		// leave a rejected admission read orphaned.
		const generation = this.host.memoryJobWorkerGeneration ?? 0
		const admission = captureAdmissionToken({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		}).then(
			(token) => ({ ok: true as const, token }),
			(error: unknown) => ({ ok: false as const, error }),
		)
		const execute = async () => {
			const admitted = await admission
			if (!admitted.ok) {
				throw admitted.error
			}
			const eventId = randomUUID()
			// D1/B3: the write side of the canonical identity rule — an implicit
			// sessionId lands the event in the SAME session scope a sessionKey
			// search reads from, and an unscoped write falls back to the SAME
			// unified MEMONGO_DEFAULT_SCOPE an unscoped search queries (the
			// legacy search-only name does not move writes).
			// W06: the COMPLETE identity (scope + scopeRef) resolves once here,
			// with the manager's workspaceDir — a workspace-scope write without
			// an explicit scopeRef lands in the SAME hashed workspace partition
			// a workspace-default search reads from, instead of the
			// workspace:<agentId> fallback the low-level re-resolution would
			// produce. The resolved scopeRef is what flows downstream.
			const writeDefaultScope = this.resolveWriteDefaultScope()
			const { scope, scopeRef } = resolveScopeIdentity({
				scope: event.scope,
				scopeRef: event.scopeRef,
				agentId: this.host.agentId,
				sessionId: event.sessionId,
				workspaceDir: this.host.workspaceDir,
				defaultScope: writeDefaultScope,
			})
			const postWriteDerivedWorkEnabled =
				this.host.shouldRunPostWriteDerivedWork()
			const extractionJobPendingAt = postWriteDerivedWorkEnabled
				? new Date()
				: undefined
			// P4.4.1: explicit per-write expiresAt wins; otherwise the
			// session-scope TTL default applies to session writes only. When
			// neither applies the key is omitted entirely (byte-identical writes
			// with TTL disabled).
			const expiresAt = resolveWriteExpiresAt({
				explicit: event.expiresAt,
				sessionId: event.sessionId,
				ttl: this.host.config.mongodb?.ttl,
			})
			// B4: persist the canonical fingerprint whenever the write carries a
			// key. It fingerprints REQUEST-level inputs (explicit expiresAt
			// only — the TTL-resolved value is time-dependent); keyless writes
			// stay byte-identical. D1/B3: the fingerprint resolves scope with
			// the same unified default the write used, so an unscoped write and
			// the equivalent explicit-scope write fingerprint equal. W06: the
			// workspaceDir rides along so the fingerprint keys to the same
			// partition the write lands in.
			const idempotencyFingerprint = event.idempotencyKey
				? computeIdempotencyFingerprint(
						event,
						this.host.agentId,
						writeDefaultScope,
						this.host.workspaceDir,
					)
				: undefined
			const persistEvent = (session?: ClientSession) =>
				writeEvent({
					db: this.host.db,
					prefix: this.host.prefix,
					...(session ? { session } : {}),
					event: {
						eventId,
						agentId: this.host.agentId,
						sessionId: event.sessionId,
						role: event.role,
						body: event.body,
						scope,
						// W06: the manager-resolved scopeRef (complete identity
						// resolved once at the boundary), not the raw request
						// field — buildCanonicalEventDocument consumes this
						// instead of re-resolving without the workspaceDir.
						scopeRef,
						timestamp: event.timestamp,
						validAt: event.validAt,
						invalidAt: event.invalidAt,
						metadata: event.metadata,
						idempotencyKey: event.idempotencyKey,
						...(idempotencyFingerprint ? { idempotencyFingerprint } : {}),
						extractionJobPendingAt,
						...(expiresAt ? { expiresAt } : {}),
					},
				})
			const stageExtractionJob = async (
				written: Awaited<ReturnType<typeof writeEvent>>,
				session: ClientSession,
			) => {
				await createMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					session,
					job: {
						jobId: `extraction-${written.eventId}`,
						jobType: "extraction",
						agentId: this.host.agentId,
						admissionEpoch: admitted.token.epoch,
						status: "pending",
						stagedAt: extractionJobPendingAt,
						metadata: { eventId: written.eventId },
						payload: {
							eventId: written.eventId,
							scope,
							scopeRef: written.scopeRef,
						},
					},
				})
			}
			// W16: ingest-run clock starts at the write attempt. A replay returns
			// from the fenced transaction without recording an ingest run.
			const ingestStartMs = Date.now()
			let written: Awaited<ReturnType<typeof writeEvent>>
			try {
				const outcome = await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token: admitted.token,
					fn: async (session) => {
						if (event.idempotencyKey) {
							const replay = await this.host.replayIdempotentEventWrite({
								idempotencyKey: event.idempotencyKey,
								event,
								session,
							})
							if (replay) {
								return { kind: "replay" as const, receipt: replay }
							}
						}
						const persisted = await persistEvent(session)
						if (postWriteDerivedWorkEnabled) {
							await stageExtractionJob(persisted, session)
						}
						return { kind: "written" as const, written: persisted }
					},
				})
				if (outcome.kind === "replay") {
					return outcome.receipt
				}
				written = outcome.written
			} catch (err) {
				if (event.idempotencyKey && isDuplicateKeyError(err)) {
					// A duplicate-key error aborts its transaction, so replay in a
					// new fenced transaction with the original admission token.
					// An erasure that advanced the epoch wins this retry boundary.
					const replay = await withFencedWrite({
						db: this.host.db,
						prefix: this.host.prefix,
						token: admitted.token,
						fn: (session) =>
							this.host.replayIdempotentEventWrite({
								idempotencyKey: event.idempotencyKey as string,
								event,
								session,
							}),
					})
					if (replay) {
						return replay
					}
				}
				throw err
			}
			const projectionStartMs = Date.now()
			const projectionEvent: CanonicalEvent = {
				eventId: written.eventId,
				agentId: this.host.agentId,
				role: event.role,
				body: event.body,
				scope,
				scopeRef: written.scopeRef,
				timestamp: written.timestamp,
				validAt: event.validAt ?? written.timestamp,
				...(event.invalidAt ? { invalidAt: event.invalidAt } : {}),
				...(expiresAt ? { expiresAt } : {}),
				...(event.sessionId ? { sessionId: event.sessionId } : {}),
				...(event.metadata ? { metadata: event.metadata } : {}),
			}
			let projected: { chunkCreated: boolean }
			let projectionFailed = false
			try {
				projected = await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token: admitted.token,
					fn: (session) =>
						projectEventChunk({
							db: this.host.db,
							prefix: this.host.prefix,
							event: projectionEvent,
							session,
							recordRun: false,
						}),
				})
			} catch (err) {
				projectionFailed = true
				projected = { chunkCreated: false }
				log.warn(
					`chunk projection failed for durable event ${written.eventId}; leaving it unprojected for the repair pass: ${String(err)}`,
				)
			}
			const projectionRun = {
				agentId: this.host.agentId,
				projectionType: "chunks" as const,
				status: projectionFailed ? ("failed" as const) : ("ok" as const),
				itemsProjected: projected.chunkCreated ? 1 : 0,
				durationMs: Date.now() - projectionStartMs,
			}
			await withFencedWrite({
				db: this.host.db,
				prefix: this.host.prefix,
				token: admitted.token,
				fn: (session) =>
					recordProjectionRun({
						db: this.host.db,
						prefix: this.host.prefix,
						run: projectionRun,
						session,
					}),
			}).catch(() => {})
			if (projected.chunkCreated) {
				this.host.chunkCount += 1
				// C-017: a newly projected chunk is embedded server-side
				// (autoEmbed) in automated mode — bill one indexing unit per
				// created chunk; replays create none.
				if (this.host.config.mongodb?.embeddingMode === "automated") {
					void recordEmbeddingSpend(
						this.host.db,
						this.host.prefix,
						this.host.agentId,
						"indexing",
						1,
						{ admission: admitted.token },
					).catch(() => {
						log.warn("indexing cost ledger recording failed")
					})
				}
			}
			if (postWriteDerivedWorkEnabled) {
				const jobId = `extraction-${written.eventId}`
				if (operationRunContext) {
					this.host.memoryJobOperationContexts.set(jobId, operationRunContext)
				}
				let clearPendingMarker = false
				try {
					const released = await releaseStagedMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId,
						agentId: this.host.agentId,
					})
					clearPendingMarker = released
					if (!released) {
						const existing = await getMemoryJob({
							db: this.host.db,
							prefix: this.host.prefix,
							jobId,
							agentId: this.host.agentId,
						})
						if (
							!existing ||
							(existing.status === "pending" && Boolean(existing.stagedAt))
						) {
							// P0.1: the event is already committed — throwing here turned a
							// fully durable write into a client-visible 500 that invited
							// duplicate retries. Leave extractionJobPendingAt SET so
							// repairExtractionOutbox (which exists for exactly this) re-stages
							// the job, and acknowledge the write.
							this.host.memoryJobOperationContexts.delete(jobId)
							clearPendingMarker = false
							log.warn(
								`staged extraction job ${jobId} was not released; leaving the outbox marker set for the repair pass`,
							)
						}
					}
				} catch (err) {
					// W08: a thrown release/lookup error gets the same P0.1
					// treatment as an unreleased job — the marker stays set
					// for the repair pass and the durable write is
					// acknowledged.
					this.host.memoryJobOperationContexts.delete(jobId)
					clearPendingMarker = false
					log.warn(
						`staged extraction job release failed for ${jobId}; leaving the outbox marker set for the repair pass: ${String(err)}`,
					)
				}
				if (clearPendingMarker) {
					try {
						await clearEventExtractionJobPending({
							db: this.host.db,
							prefix: this.host.prefix,
							eventId: written.eventId,
							agentId: this.host.agentId,
						})
					} catch (err) {
						log.warn(
							`extraction outbox cleanup failed for ${written.eventId}: ${String(err)}`,
						)
					}
				}
				// W8: one admission per write chain — the post-write wake
				// reuses this write's admission token, so the drain's repair
				// and claim rounds do not capture a second admission against
				// the same erasure gate.
				if (this.host.memoryJobWorkerStopped) {
					this.host.startMemoryJobWorker(admitted.token, generation)
				} else {
					this.host.wakeMemoryJobWorker(admitted.token, generation)
				}
			}

			await this.host.schedulePostWriteDerivations({
				eventId: written.eventId,
				role: event.role,
				body: event.body,
				sessionId: event.sessionId,
				timestamp: written.timestamp,
				scope,
				scopeRef: written.scopeRef,
				runContext: operationRunContext,
				admission: admitted.token,
			})

			// P2.4: the hot write path coalesces invalidation — a burst of
			// writes collapses into a leading + single trailing scope-level
			// delete instead of a deleteMany per write (which drove the cache
			// hit rate to ~0 and put an extra round trip on every write).
			this.host.scheduleQueryCacheInvalidation({
				agentId: this.host.agentId,
				scope,
				scopeRef: written.scopeRef,
				admission: admitted.token,
			})

			// Lane coverage tracking (non-blocking)
			// Note: episodic lane coverage is handled asynchronously inside
			// schedulePostWriteDerivations when checkAutoEpisodeTriggers fires.
			try {
				const increments: Record<string, number> = {
					"raw-window": 1,
					hybrid: projected.chunkCreated ? 1 : 0,
				}
				// Regex-only on purpose: this is a synchronous coverage counter on
				// the hot write path. The LLM-augmented promotion (issue #30) runs
				// in the background job, so this count is a cheap regex lower bound,
				// not a blocking LLM call duplicated per event. P3.9: count by
				// regex/classification ONLY — the promotion resolver did a
				// per-candidate findOne existence check (N+1) and the counts only
				// feed planner hints, never durable writes.
				const candidates = postWriteDerivedWorkEnabled
					? extractStructuredCandidatesFromEvent({
							eventId: written.eventId,
							agentId: this.host.agentId,
							role: event.role,
							body: event.body,
							timestamp: written.timestamp,
							sessionId: event.sessionId,
							scope,
							scopeRef: written.scopeRef,
						})
					: []
				if (candidates.length > 0) {
					increments.structured = candidates.length
				}
				const criticalCount = candidates.filter(
					(c) => c.salience === "critical" || c.salience === "high",
				).length
				if (criticalCount > 0) {
					increments["active-critical"] = criticalCount
				}
				const procedureCandidates = postWriteDerivedWorkEnabled
					? extractProcedureCandidatesFromEvent({
							eventId: written.eventId,
							agentId: this.host.agentId,
							role: event.role,
							body: event.body,
							timestamp: written.timestamp,
							sessionId: event.sessionId,
							scope,
							scopeRef: written.scopeRef,
						})
					: []
				if (procedureCandidates.length > 0) {
					increments.procedural = procedureCandidates.length
				}
				await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token: admitted.token,
					fn: (session) =>
						updateLaneCoverage({
							db: this.host.db,
							prefix: this.host.prefix,
							agentId: this.host.agentId,
							increments,
							session,
						}),
				})
			} catch (err) {
				log.warn("lane coverage update failed after event write", {
					error: err instanceof Error ? err.message : String(err),
				})
			}

			// W16: the production event-write boundary records ingest runs so
			// the canonicalIngest health lane reflects real write outcomes —
			// the legacy helper always recorded them, but this path (the one
			// production callers use) never did, leaving the lane permanently
			// health-uncertain. status stays "ok" even when the inline chunk
			// projection degraded: the INGEST (canonical write) succeeded and
			// the unprojected event is the chunks lane's own obligation now.
			// Best-effort by design — the write is already durable and a
			// failed ledger insert must not reject it.
			try {
				const run = {
					agentId: this.host.agentId,
					source: "event-write" as const,
					status: "ok" as const,
					itemsProcessed: 1,
					itemsFailed: 0,
					durationMs: Date.now() - ingestStartMs,
				}
				await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token: admitted.token,
					fn: (session) =>
						recordIngestRun({
							db: this.host.db,
							prefix: this.host.prefix,
							run,
							session,
						}),
				})
			} catch (err) {
				log.warn("ingest run recording failed after durable event write", {
					eventId: written.eventId,
					error: err instanceof Error ? err.message : String(err),
				})
			}

			this.host.dirty = false
			return { eventId: written.eventId, chunkCreated: projected.chunkCreated }
		}

		// WS-11 change 4: bounded enqueue (fast-fail at cap + saturation
		// telemetry) replaces the unbounded promise chain.
		return enqueueBoundedWrite(this.host, execute)
	}

	/**
	 * Fenced batch variant of writeConversationEvent. The whole batch occupies
	 * one slot in the per-agent write queue and prepares stable IDs and clocks
	 * once. Known-aborted event rounds may shrink and retry, but exactly one
	 * fenced round commits. Event leaders and staged extraction jobs commit
	 * atomically; projection, job release, and accounting run afterward.
	 */
	async writeConversationEventsBatch(
		events: WriteConversationEventInput[],
		operationRunContext?: OperationRunContext,
	): Promise<WriteConversationEventReceipt[]> {
		// (P2.5 e) shutdown intake stop: same contract as the single write.
		if (this.host.closed) {
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to queue a new write",
			)
		}
		const generation = this.host.memoryJobWorkerGeneration ?? 0
		const admission = captureAdmissionToken({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		}).then(
			(token) => ({ ok: true as const, token }),
			(error: unknown) => ({ ok: false as const, error }),
		)
		const execute = async (): Promise<WriteConversationEventReceipt[]> => {
			const admitted = await admission
			if (!admitted.ok) {
				throw admitted.error
			}
			// W16: ingest-run clock for the batch boundary (one run per call).
			const ingestStartMs = Date.now()
			const receipts: Array<WriteConversationEventReceipt | undefined> =
				events.map(() => undefined)
			const postWriteDerivedWorkEnabled =
				this.host.shouldRunPostWriteDerivedWork()
			const extractionJobPendingAt = postWriteDerivedWorkEnabled
				? new Date()
				: undefined
			const writeDefaultScope = this.resolveWriteDefaultScope()
			const prepared: PreparedBatchItem[] = []
			for (const [index, input] of events.entries()) {
				try {
					const { scope, scopeRef } = resolveScopeIdentity({
						scope: input.scope,
						scopeRef: input.scopeRef,
						agentId: this.host.agentId,
						sessionId: input.sessionId,
						workspaceDir: this.host.workspaceDir,
						defaultScope: writeDefaultScope,
					})
					const expiresAt = resolveWriteExpiresAt({
						explicit: input.expiresAt,
						sessionId: input.sessionId,
						ttl: this.host.config.mongodb?.ttl,
					})
					const eventInput: EventWriteInput = {
						eventId: randomUUID(),
						agentId: this.host.agentId,
						role: input.role,
						body: input.body,
						scope,
						scopeRef,
						...(input.sessionId ? { sessionId: input.sessionId } : {}),
						...(input.timestamp ? { timestamp: input.timestamp } : {}),
						...(input.validAt ? { validAt: input.validAt } : {}),
						...(input.invalidAt ? { invalidAt: input.invalidAt } : {}),
						...(input.metadata ? { metadata: input.metadata } : {}),
						...(input.idempotencyKey
							? {
									idempotencyKey: input.idempotencyKey,
									idempotencyFingerprint: computeIdempotencyFingerprint(
										input,
										this.host.agentId,
										writeDefaultScope,
										this.host.workspaceDir,
									),
								}
							: {}),
						extractionJobPendingAt,
						...(expiresAt ? { expiresAt } : {}),
					}
					const event = buildCanonicalEventDocument(eventInput)
					prepared.push({
						index,
						input: eventInput,
						event,
						...(postWriteDerivedWorkEnabled
							? {
									job: {
										jobId: `extraction-${event.eventId}`,
										jobType: "extraction",
										agentId: this.host.agentId,
										status: "pending",
										createdAt: event.recordedAt,
										stagedAt: extractionJobPendingAt,
										admissionEpoch: admitted.token.epoch,
										metadata: { eventId: event.eventId },
										payload: {
											eventId: event.eventId,
											scope: event.scope,
											scopeRef: event.scopeRef,
										},
									},
								}
							: {}),
					})
				} catch (err) {
					receipts[index] = batchWriteError(
						err instanceof Error ? err.message : String(err),
					)
				}
			}

			const groups: PreparedBatchGroup[] = []
			const keyedGroups = new Map<string, PreparedBatchGroup>()
			for (const item of prepared) {
				const key = item.event.idempotencyKey
				if (!key) {
					groups.push({ members: [item] })
					continue
				}
				const group = keyedGroups.get(key)
				if (group) {
					group.members.push(item)
				} else {
					const created = { idempotencyKey: key, members: [item] }
					keyedGroups.set(key, created)
					groups.push(created)
				}
			}

			let insertGroups = groups
			let resolveGroups: PreparedBatchGroup[] = []
			let needsResolutionFence = false
			const writtenPrepared: PreparedBatchItem[] = []
			const attemptedIndexes = new Set<number>()
			const collection = eventsCollection(this.host.db, this.host.prefix)

			while (
				insertGroups.length > 0 ||
				resolveGroups.length > 0 ||
				needsResolutionFence
			) {
				const insertSnapshot = insertGroups.map((group) => ({
					...group,
					members: [...group.members],
				}))
				const resolveSnapshot = resolveGroups.map((group) => ({
					...group,
					members: [...group.members],
				}))
				try {
					const draft = await withFencedWrite({
						db: this.host.db,
						prefix: this.host.prefix,
						token: admitted.token,
						fn: async (session: ClientSession): Promise<BatchRoundDraft> => {
							const roundReceipts = new Map<number, BatchEventWriteReceipt>()
							const localInsertGroups: PreparedBatchGroup[] = []
							const keys = [
								...new Set(
									[...insertSnapshot, ...resolveSnapshot]
										.map((group) => group.idempotencyKey)
										.filter((key): key is string => Boolean(key)),
								),
							]
							const storedByKey = new Map<string, Document>()
							if (keys.length > 0) {
								let storedRows: Document[]
								try {
									storedRows = await collection
										.find(
											{
												agentId: this.host.agentId,
												idempotencyKey: { $in: keys },
											},
											{
												projection: EVENT_IDEMPOTENCY_REPLAY_PROJECTION,
												...EVENT_IDENTITY_READ_OPTIONS,
												session,
											},
										)
										.toArray()
								} catch (err) {
									if (hasMongoErrorLabel(err, "TransientTransactionError")) {
										throw err
									}
									throw new BatchBodyAbort(err)
								}
								for (const row of storedRows) {
									if (typeof row.idempotencyKey === "string") {
										storedByKey.set(row.idempotencyKey, row)
									}
								}
							}

							for (const group of insertSnapshot) {
								const stored = group.idempotencyKey
									? storedByKey.get(group.idempotencyKey)
									: undefined
								if (stored) {
									for (const [index, receipt] of draftGroupAgainstWinner({
										group,
										stored,
										writeOptions: collection.bsonOptions,
									})) {
										roundReceipts.set(index, receipt)
									}
								} else {
									localInsertGroups.push(group)
								}
							}
							for (const group of resolveSnapshot) {
								const stored = group.idempotencyKey
									? storedByKey.get(group.idempotencyKey)
									: undefined
								if (stored) {
									for (const [index, receipt] of draftGroupAgainstWinner({
										group,
										stored,
										writeOptions: collection.bsonOptions,
									})) {
										roundReceipts.set(index, receipt)
									}
								} else {
									for (const member of group.members) {
										roundReceipts.set(
											member.index,
											batchWriteError(
												"event durability unconfirmed; retry with the same idempotency key",
											),
										)
									}
								}
							}

							const leaders = localInsertGroups.map((group) => group.members[0])
							if (leaders.length > 0) {
								try {
									await collection.insertMany(
										leaders.map((leader) => leader.event),
										{ ordered: false, session },
									)
								} catch (err) {
									if (hasMongoErrorLabel(err, "TransientTransactionError")) {
										throw err
									}
									const issues = classifyAttributableEventBatchAbort(
										err,
										leaders,
									)
									if (issues) {
										throw new AttributableEventBatchAbort(
											issues,
											leaders.map((leader) => leader.index),
											err,
										)
									}
									throw new BatchBodyAbort(
										err,
										leaders.map((leader) => leader.index),
									)
								}
								if (postWriteDerivedWorkEnabled) {
									try {
										await createMemoryJobsBatch({
											db: this.host.db,
											prefix: this.host.prefix,
											session,
											jobs: leaders.map((leader) => {
												if (!leader.job) {
													throw new Error("prepared extraction job was missing")
												}
												return leader.job
											}),
										})
									} catch (err) {
										if (hasMongoErrorLabel(err, "TransientTransactionError")) {
											throw err
										}
										throw new BatchBodyAbort(
											err,
											leaders.map((leader) => leader.index),
										)
									}
								}
								for (const group of localInsertGroups) {
									for (const [index, receipt] of draftInsertedGroup({
										group,
										writeOptions: collection.bsonOptions,
									})) {
										roundReceipts.set(index, receipt)
									}
								}
							}
							return { receipts: roundReceipts, inserted: leaders }
						},
					})
					for (const [index, receipt] of draft.receipts) {
						receipts[index] = receipt
					}
					for (const item of draft.inserted) {
						attemptedIndexes.add(item.index)
					}
					writtenPrepared.push(...draft.inserted)
					insertGroups = []
					resolveGroups = []
					needsResolutionFence = false
				} catch (err) {
					if (err instanceof AttributableEventBatchAbort) {
						for (const index of err.attemptedIndexes) {
							attemptedIndexes.add(index)
						}
						needsResolutionFence = true
						const issues = new Map(
							err.issues.map((issue) => [issue.originalIndex, issue]),
						)
						const nextInsertGroups: PreparedBatchGroup[] = []
						for (const group of insertGroups) {
							const issue = issues.get(group.members[0].index)
							if (!issue) {
								nextInsertGroups.push(group)
								continue
							}
							if (issue.kind === "validation") {
								receipts[issue.originalIndex] = batchWriteError(issue.message)
								const remaining = group.members.slice(1)
								if (remaining.length > 0) {
									nextInsertGroups.push({
										...group,
										members: remaining,
									})
								}
							} else {
								resolveGroups = [...resolveGroups, group]
							}
						}
						insertGroups = nextInsertGroups
						continue
					}
					if (err instanceof ErasureGateConflictError) {
						throw err
					}
					if (err instanceof BatchBodyAbort) {
						for (const index of err.attemptedIndexes) {
							attemptedIndexes.add(index)
						}
						for (const group of [...insertGroups, ...resolveGroups]) {
							for (const member of group.members) {
								receipts[member.index] = batchWriteError(err.message)
							}
						}
						break
					}

					for (const group of [...insertGroups, ...resolveGroups]) {
						const uncertain = group.idempotencyKey
							? "event durability unconfirmed; retry with the same idempotency key"
							: "event durability unconfirmed; a keyless outcome cannot be retried safely"
						for (const member of group.members) {
							receipts[member.index] = batchWriteError(uncertain)
						}
					}
					try {
						const existing = await findExistingEventsForReplay({
							collection,
							eventIds: insertGroups.map(
								(group) => group.members[0].event.eventId,
							),
						})
						for (const group of insertGroups) {
							const leader = group.members[0]
							const stored = existing.get(leader.event.eventId)
							if (!isStoredEventReplayDocument(stored)) {
								continue
							}
							let matches = false
							try {
								matches = mintedAttemptMatches(
									stored,
									leader,
									collection.bsonOptions,
								)
							} catch {
								matches = false
							}
							if (!matches) {
								continue
							}
							for (const [index, receipt] of draftInsertedGroup({
								group,
								writeOptions: collection.bsonOptions,
							})) {
								receipts[index] = receipt
							}
							writtenPrepared.push(leader)
						}
					} catch {
						// The generic uncertainty receipts above remain authoritative.
					}
					break
				}
			}

			const pending = prepared.filter((item) =>
				attemptedIndexes.has(item.index),
			)
			const written = writtenPrepared.map((item) => ({
				index: item.index,
				input: events[item.index],
				eventId: item.event.eventId,
				scope: item.event.scope,
				scopeRef: item.event.scopeRef,
				timestamp: item.event.timestamp,
				expiresAt: item.event.expiresAt,
			}))

			// 4. ONE bulkWrite for chunk projection + ONE updateMany marking the
			// events projected. A projection failure degrades to
			// chunkCreated:false without failing the (already durable) writes —
			// the projection repair pass recovers them.
			if (written.length > 0) {
				const projectionStartMs = Date.now()
				const projectionEvents: CanonicalEvent[] = written.map((item) => ({
					eventId: item.eventId,
					agentId: this.host.agentId,
					role: item.input.role,
					body: item.input.body,
					scope: item.scope,
					scopeRef: item.scopeRef,
					timestamp: item.timestamp,
					validAt: item.input.validAt ?? item.timestamp,
					...(item.input.invalidAt ? { invalidAt: item.input.invalidAt } : {}),
					// C-005: expiry computed at pending time — identical to
					// the value persisted on the event document.
					...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
					...(item.input.sessionId ? { sessionId: item.input.sessionId } : {}),
					...(item.input.metadata ? { metadata: item.input.metadata } : {}),
				}))
				let chunkResults: Array<{ chunkCreated: boolean }> = []
				let projectionFailed = false
				try {
					chunkResults = await withFencedWrite({
						db: this.host.db,
						prefix: this.host.prefix,
						token: admitted.token,
						fn: (session) =>
							projectEventChunksBatch({
								db: this.host.db,
								prefix: this.host.prefix,
								events: projectionEvents,
								session,
								recordRun: false,
							}),
					})
				} catch (err) {
					projectionFailed = true
					log.warn(
						`batch chunk projection failed after durable writes; leaving events unprojected for repair: ${String(err)}`,
					)
				}
				const projectionRun = {
					agentId: this.host.agentId,
					projectionType: "chunks" as const,
					status: projectionFailed ? ("failed" as const) : ("ok" as const),
					itemsProjected: chunkResults.filter((result) => result.chunkCreated)
						.length,
					durationMs: Date.now() - projectionStartMs,
				}
				await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token: admitted.token,
					fn: (session) =>
						recordProjectionRun({
							db: this.host.db,
							prefix: this.host.prefix,
							run: projectionRun,
							session,
						}),
				}).catch(() => {})
				let createdChunkCount = 0
				for (const [position, item] of written.entries()) {
					const chunkCreated = chunkResults[position]?.chunkCreated ?? false
					if (chunkCreated) {
						this.host.chunkCount += 1
						createdChunkCount += 1
					}
					for (const [index, receipt] of receipts.entries()) {
						if (receipt?.ok && receipt.eventId === item.eventId) {
							receipts[index] = { ...receipt, chunkCreated }
						}
					}
				}
				// C-017: each newly projected chunk is embedded server-side
				// (autoEmbed) in automated mode — one indexing unit per created
				// chunk, billed as one ledger increment for the batch.
				if (
					createdChunkCount > 0 &&
					this.host.config.mongodb?.embeddingMode === "automated"
				) {
					void recordEmbeddingSpend(
						this.host.db,
						this.host.prefix,
						this.host.agentId,
						"indexing",
						createdChunkCount,
						{ admission: admitted.token },
					).catch(() => {
						log.warn("indexing cost ledger recording failed")
					})
				}
			}

			// 5. Jobs were atomically staged with their events. Release all
			// committed jobs in one update, then clear event outbox markers only
			// when every expected job became claimable. A partial release keeps
			// every marker armed so the repair pass can converge the batch.
			if (postWriteDerivedWorkEnabled && written.length > 0) {
				const jobIds = written.map((item) => `extraction-${item.eventId}`)
				if (operationRunContext) {
					for (const jobId of jobIds) {
						this.host.memoryJobOperationContexts.set(jobId, operationRunContext)
					}
				}
				try {
					const released = await releaseStagedMemoryJobsBatch({
						db: this.host.db,
						prefix: this.host.prefix,
						jobIds,
						agentId: this.host.agentId,
					})
					if (released === written.length) {
						await clearEventExtractionJobPendingBatch({
							db: this.host.db,
							prefix: this.host.prefix,
							eventIds: written.map((item) => item.eventId),
							agentId: this.host.agentId,
						})
					} else {
						log.warn(
							`batch extraction job release matched ${released}/${written.length}; leaving outbox markers for repair`,
						)
					}
					if (released > 0) {
						if (this.host.memoryJobWorkerStopped) {
							this.host.startMemoryJobWorker(admitted.token, generation)
						} else {
							this.host.wakeMemoryJobWorker(admitted.token, generation)
						}
					}
				} catch (err) {
					log.warn(
						`batch extraction job release failed; leaving outbox markers for repair: ${String(err)}`,
					)
				}
			}

			// 6. Post-write derivations + coalesced query-cache invalidation.
			// Episode triggers inspect the whole unconsolidated scope backlog, so
			// evaluating once per event in the same batch only repeats the same
			// expensive scan. Schedule at most once per tenant scope identity.
			const scheduledDerivationScopes = new Set<string>()
			for (const item of written) {
				const scopeIdentity = `${item.scope}\u0000${item.scopeRef}`
				if (!scheduledDerivationScopes.has(scopeIdentity)) {
					scheduledDerivationScopes.add(scopeIdentity)
					await this.host.schedulePostWriteDerivations({
						eventId: item.eventId,
						role: item.input.role,
						body: item.input.body,
						sessionId: item.input.sessionId,
						timestamp: item.timestamp,
						scope: item.scope,
						scopeRef: item.scopeRef,
						runContext: operationRunContext,
						admission: admitted.token,
					})
				}
				this.host.scheduleQueryCacheInvalidation({
					agentId: this.host.agentId,
					scope: item.scope,
					scopeRef: item.scopeRef,
					admission: admitted.token,
				})
			}

			// 7. Lane coverage: aggregate the per-item increments across the
			// batch into ONE update. Regex-only candidate counting (P3.9) — the
			// counts only feed planner hints.
			try {
				const increments: Record<string, number> = {}
				const bump = (lane: string, by: number) => {
					if (by > 0) {
						increments[lane] = (increments[lane] ?? 0) + by
					}
				}
				for (const item of written) {
					bump("raw-window", 1)
					const receipt = receipts[item.index]
					bump("hybrid", receipt?.ok && receipt.chunkCreated ? 1 : 0)
					if (postWriteDerivedWorkEnabled) {
						const candidates = extractStructuredCandidatesFromEvent({
							eventId: item.eventId,
							agentId: this.host.agentId,
							role: item.input.role,
							body: item.input.body,
							timestamp: item.timestamp,
							sessionId: item.input.sessionId,
							scope: item.scope,
							scopeRef: item.scopeRef,
						})
						bump("structured", candidates.length)
						bump(
							"active-critical",
							candidates.filter(
								(c) => c.salience === "critical" || c.salience === "high",
							).length,
						)
						bump(
							"procedural",
							extractProcedureCandidatesFromEvent({
								eventId: item.eventId,
								agentId: this.host.agentId,
								role: item.input.role,
								body: item.input.body,
								timestamp: item.timestamp,
								sessionId: item.input.sessionId,
								scope: item.scope,
								scopeRef: item.scopeRef,
							}).length,
						)
					}
				}
				if (written.length > 0) {
					await withFencedWrite({
						db: this.host.db,
						prefix: this.host.prefix,
						token: admitted.token,
						fn: (session) =>
							updateLaneCoverage({
								db: this.host.db,
								prefix: this.host.prefix,
								agentId: this.host.agentId,
								increments,
								session,
							}),
					})
				}
			} catch (err) {
				log.warn("lane coverage update failed after batch event write", {
					error: err instanceof Error ? err.message : String(err),
				})
			}

			// W16: same boundary contract as the single write — ONE ingest run
			// per batch call, summarizing the outcomes of the items that
			// ATTEMPTED an insert this call (`pending`; pre-write idempotency
			// replays/conflicts never reached the insert and are not ingests).
			// Counting rides the final per-item receipts: ok = landed durably
			// (including lost-race replays of an already-durable event),
			// not-ok = ingest failure. status: ok = everything landed,
			// partial = some landed, failed = nothing landed.
			if (pending.length > 0) {
				let itemsProcessed = 0
				let itemsFailed = 0
				for (const item of pending) {
					if (receipts[item.index]?.ok) {
						itemsProcessed++
					} else {
						itemsFailed++
					}
				}
				const status: "ok" | "partial" | "failed" =
					itemsFailed === 0 ? "ok" : itemsProcessed > 0 ? "partial" : "failed"
				try {
					const run = {
						agentId: this.host.agentId,
						source: "event-write" as const,
						status,
						itemsProcessed,
						itemsFailed,
						durationMs: Date.now() - ingestStartMs,
					}
					await withFencedWrite({
						db: this.host.db,
						prefix: this.host.prefix,
						token: admitted.token,
						fn: (session) =>
							recordIngestRun({
								db: this.host.db,
								prefix: this.host.prefix,
								run,
								session,
							}),
					})
				} catch (err) {
					log.warn("ingest run recording failed after batch event write", {
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			this.host.dirty = false
			return receipts.map(
				(receipt): WriteConversationEventReceipt =>
					receipt ?? {
						ok: false,
						code: "WRITE_ERROR",
						message: "event write not attempted",
					},
			)
		}

		// WS-11 change 4: same bounded enqueue as the single-write path — the
		// batch is ONE queue slot, so its depth accounting matches.
		return enqueueBoundedWrite(this.host, execute)
	}

	async extractEvent(params: {
		eventId: string
		scope?: MemoryScope
		scopeRef?: string
	}) {
		if (this.host.closed)
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to schedule extraction",
			)
		const eventId = params.eventId.trim()
		if (!eventId) {
			throw new Error("eventId is required")
		}
		const generation = this.host.memoryJobWorkerGeneration ?? 0
		const admission = await captureAdmissionToken({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})
		// Tenant isolation: a scope-restricted caller may only extract from an event
		// within its authorized scope/scopeRef. Enforce ownership SYNCHRONOUSLY here,
		// before scheduling — the deterministic `extraction-${eventId}` job is often
		// pre-created by the write path, so a scope check inside the background job
		// would dedup away and never run.
		if (params.scope !== undefined || params.scopeRef !== undefined) {
			const owned = await eventsCollection(
				this.host.db,
				this.host.prefix,
			).findOne(
				{
					eventId,
					agentId: this.host.agentId,
					...(params.scope !== undefined ? { scope: params.scope } : {}),
					...(params.scopeRef !== undefined
						? { scopeRef: params.scopeRef }
						: {}),
				},
				{ projection: { _id: 1 } },
			)
			if (!owned) {
				const err = new Error(`event not found: ${eventId}`)
				err.name = "EventNotInScopeError"
				throw err
			}
		}
		return this.host.scheduleBackgroundExtraction(
			eventId,
			{
				scope: params.scope,
				scopeRef: params.scopeRef,
			},
			undefined,
			{ admission, generation },
		)
	}
}
