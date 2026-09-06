import { randomUUID } from "node:crypto"
import type { OperationRunContext } from "./mongodb-operation-accounting.js"
import { isDuplicateKeyError } from "./internal.js"
import { recordEmbeddingSpend } from "./mongodb-cost-ledger.js"
import {
	extractStructuredCandidatesFromEvent,
	extractProcedureCandidatesFromEvent,
} from "./mongodb-derived-memory.js"
import {
	clearEventExtractionJobPending,
	clearEventExtractionJobPendingBatch,
	writeEvent,
	writeEventsBatch,
	projectEventChunk,
	projectEventChunksBatch,
	IdempotencyConflictError,
	pruneIdempotencyFingerprints,
	IDEMPOTENCY_FINGERPRINT_PRUNE_INTERVAL_MS,
} from "./mongodb-events.js"
import { computeIdempotencyFingerprint } from "./mongodb-idempotency-fingerprint.js"
import type { CanonicalEvent } from "./mongodb-events.js"
import { updateLaneCoverage } from "./mongodb-lane-coverage.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { recordIngestRun } from "./mongodb-ops.js"
import {
	createMemoryJob,
	createMemoryJobsBatch,
	getMemoryJob,
	releaseStagedMemoryJob,
} from "./mongodb-memory-jobs.js"
import { QueryCacheInvalidationCoalescer } from "./mongodb-query-cache-invalidation.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { eventsCollection } from "./mongodb-schema.js"
import { resolveScopeIdentity } from "./mongodb-scope.js"
import { resolveWriteExpiresAt } from "./mongodb-temporal.js"
import { resolveDefaultScope } from "./backend-config.js"
import {
	isTransactionUnsupported,
	MAJORITY_TRANSACTION_OPTIONS,
} from "./mongodb-transactions.js"
import type { MemoryScope } from "@memongo/lib"
import type { ClientSession, Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb")

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
	}): Promise<{ pruned: number }> {
		// The entire method is failure-safe: the worker drain sweep awaits it
		// inline, so ANY error source (gate read, prune call) must degrade to
		// a no-op instead of rejecting the drain.
		try {
			const now = Date.now()
			if (
				!params?.force &&
				this.lastFingerprintPruneAt !== 0 &&
				now - this.lastFingerprintPruneAt <
					IDEMPOTENCY_FINGERPRINT_PRUNE_INTERVAL_MS
			) {
				return { pruned: 0 }
			}
			this.lastFingerprintPruneAt = now
			return await pruneIdempotencyFingerprints({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				...(params?.olderThanDays !== undefined
					? { olderThanDays: params.olderThanDays }
					: {}),
			})
		} catch (err) {
			// Prune failure must never block the worker drain that invoked it.
			log.warn("pruneIdempotencyFingerprints failed", { error: err })
			return { pruned: 0 }
		}
	}

	scheduleQueryCacheInvalidation(params: {
		agentId: string
		scope: MemoryScope
		scopeRef: string
	}): void {
		if (!this.host.queryCacheInvalidationCoalescer) {
			this.host.queryCacheInvalidationCoalescer =
				new QueryCacheInvalidationCoalescer()
		}
		const coalescer = this.host.queryCacheInvalidationCoalescer
		coalescer.schedule(
			`${params.agentId}|${params.scope}|${params.scopeRef}`,
			() => {
				void invalidateQueryCache({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: params.agentId,
					scope: params.scope,
					scopeRef: params.scopeRef,
				})
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
	 * compare the full canonical fingerprint — ANY changed immutable input
	 * (timestamp, validAt, invalidAt, metadata, expiresAt, not just role/
	 * body/session/scope) is a mismatch. Pre-B4 docs carry no fingerprint
	 * and fall back to the legacy five-field compare so in-flight retries
	 * across the upgrade still replay instead of false-conflicting.
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
	): boolean {
		if (existing.idempotencyFingerprint) {
			return (
				existing.idempotencyFingerprint ===
				computeIdempotencyFingerprint(
					event,
					this.host.agentId,
					this.resolveWriteDefaultScope(),
					this.host.workspaceDir,
				)
			)
		}
		const incoming = this.host.resolveIdempotencyFingerprint(event)
		return (
			existing.role === incoming.role &&
			existing.body === incoming.body &&
			(existing.sessionId ?? undefined) === incoming.sessionId &&
			existing.scope === incoming.scope &&
			existing.scopeRef === incoming.scopeRef
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
	}): Promise<{ eventId: string; chunkCreated: boolean } | null> {
		const existing = (await eventsCollection(
			this.host.db,
			this.host.prefix,
		).findOne({
			agentId: this.host.agentId,
			idempotencyKey: params.idempotencyKey,
		})) as CanonicalEvent | null
		if (!existing) {
			return null
		}
		if (!this.idempotencyPayloadMatches(existing, params.event)) {
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
		const execute = async () => {
			if (event.idempotencyKey) {
				const replay = await this.host.replayIdempotentEventWrite({
					idempotencyKey: event.idempotencyKey,
					event,
				})
				if (replay) {
					return replay
				}
			}
			// W16: ingest-run clock starts at the write attempt (a replay is
			// not an ingest and returns above before this point).
			const ingestStartMs = Date.now()
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
				session?: ClientSession,
			) => {
				await createMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					...(session ? { session } : {}),
					job: {
						jobId: `extraction-${written.eventId}`,
						jobType: "extraction",
						agentId: this.host.agentId,
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
			let written: Awaited<ReturnType<typeof writeEvent>>
			try {
				if (postWriteDerivedWorkEnabled && this.host.client) {
					const session = this.host.client.startSession()
					try {
						let transactionalWrite:
							| Awaited<ReturnType<typeof writeEvent>>
							| undefined
						await session.withTransaction(async () => {
							transactionalWrite = await persistEvent(session)
							await stageExtractionJob(transactionalWrite, session)
						}, MAJORITY_TRANSACTION_OPTIONS)
						if (!transactionalWrite) {
							throw new Error(
								"event and extraction job transaction returned no event",
							)
						}
						written = transactionalWrite
					} catch (err) {
						if (!isTransactionUnsupported(err)) {
							throw err
						}
						log.info(
							"transactions unavailable for event extraction outbox; using direct writes",
						)
						written = await persistEvent()
						await stageExtractionJob(written)
					} finally {
						await session.endSession()
					}
				} else {
					written = await persistEvent()
					if (postWriteDerivedWorkEnabled) {
						await stageExtractionJob(written)
					}
				}
			} catch (err) {
				if (event.idempotencyKey && isDuplicateKeyError(err)) {
					// Lost race: a concurrent request carrying the same key committed
					// first and uq_events_agent_idempotency_key rejected our insert.
					// Replay the winner's receipt (Stripe: same key, same result).
					const replay = await this.host.replayIdempotentEventWrite({
						idempotencyKey: event.idempotencyKey,
						event,
					})
					if (replay) {
						return replay
					}
				}
				throw err
			}
			let projected: { chunkCreated: boolean }
			try {
				projected = await projectEventChunk({
					db: this.host.db,
					prefix: this.host.prefix,
					event: {
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
					},
				})
			} catch (err) {
				// W08: the event (and its staged job) is durable; a failed
				// projection must not reject it. The event stays in the
				// unprojected set the repair pass re-projects (the chunk
				// upsert is idempotent by path).
				projected = { chunkCreated: false }
				log.warn(
					`chunk projection failed for durable event ${written.eventId}; leaving it unprojected for the repair pass: ${String(err)}`,
				)
			}
			if (projected.chunkCreated) {
				this.host.chunkCount += 1
				// C-017: a newly projected chunk is embedded server-side
				// (autoEmbed) in automated mode — bill one indexing unit per
				// created chunk; replays create none.
				if (this.host.config.mongodb?.embeddingMode === "automated") {
					recordEmbeddingSpend(
						this.host.db,
						this.host.prefix,
						this.host.agentId,
						"indexing",
						1,
					)
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
				if (this.host.memoryJobWorkerStopped) {
					this.host.startMemoryJobWorker()
				} else {
					this.host.wakeMemoryJobWorker()
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
			})

			// P2.4: the hot write path coalesces invalidation — a burst of
			// writes collapses into a leading + single trailing scope-level
			// delete instead of a deleteMany per write (which drove the cache
			// hit rate to ~0 and put an extra round trip on every write).
			this.host.scheduleQueryCacheInvalidation({
				agentId: this.host.agentId,
				scope,
				scopeRef: written.scopeRef,
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
				await updateLaneCoverage({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					increments,
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
				await recordIngestRun({
					db: this.host.db,
					prefix: this.host.prefix,
					run: {
						agentId: this.host.agentId,
						source: "event-write",
						status: "ok",
						itemsProcessed: 1,
						itemsFailed: 0,
						durationMs: Date.now() - ingestStartMs,
					},
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
	 * P3.9: batch variant of writeConversationEvent. The whole batch occupies
	 * ONE slot in the per-agent write queue (ordering against single writes is
	 * preserved) and amortizes round trips: one batched idempotency lookup,
	 * one insertMany for events, one bulkWrite for chunk projection, one
	 * insertMany for extraction jobs, one updateMany clearing outbox markers,
	 * and one aggregated lane-coverage update. Per-item receipts mirror the
	 * single-write receipt shape; a failed item never fails its siblings.
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
		const execute = async (): Promise<WriteConversationEventReceipt[]> => {
			// W16: ingest-run clock for the batch boundary (one run per call).
			const ingestStartMs = Date.now()
			const receipts: Array<WriteConversationEventReceipt | undefined> =
				events.map(() => undefined)

			// 1. Batched idempotency replay: ONE $in lookup for every key in the
			// batch instead of a findOne per keyed write (P0.1 semantics per
			// item: same key + same payload replays; different payload conflicts).
			const keyedIndexes = events
				.map((event, index) => ({ event, index }))
				.filter(({ event }) => Boolean(event.idempotencyKey))
			if (keyedIndexes.length > 0) {
				const keys = [
					...new Set(
						keyedIndexes.map(({ event }) => event.idempotencyKey as string),
					),
				]
				const existing = (await eventsCollection(this.host.db, this.host.prefix)
					.find({ agentId: this.host.agentId, idempotencyKey: { $in: keys } })
					.toArray()) as unknown as CanonicalEvent[]
				const byKey = new Map(
					existing.map((doc) => [doc.idempotencyKey as string, doc]),
				)
				for (const { event, index } of keyedIndexes) {
					const doc = byKey.get(event.idempotencyKey as string)
					if (!doc) {
						continue
					}
					// B4: same full-fingerprint comparison as the single path.
					const samePayload = this.idempotencyPayloadMatches(doc, event)
					receipts[index] = samePayload
						? {
								ok: true,
								eventId: doc.eventId,
								chunkCreated: false,
								replayed: true,
							}
						: {
								ok: false,
								code: "IDEMPOTENCY_CONFLICT",
								message: `idempotency key "${event.idempotencyKey}" was reused with a different payload`,
							}
				}
			}

			// 2. Build the write set for the non-replayed items.
			const postWriteDerivedWorkEnabled =
				this.host.shouldRunPostWriteDerivedWork()
			const extractionJobPendingAt = postWriteDerivedWorkEnabled
				? new Date()
				: undefined
			type PendingItem = {
				index: number
				input: WriteConversationEventInput
				eventId: string
				scope: MemoryScope
				// W06: the manager-resolved scopeRef (complete identity at the
				// boundary; carried so the low-level insert consumes it instead
				// of re-resolving without the workspaceDir).
				scopeRef: string
				// P4.4.1/C-005: expiry computed once per item so the event
				// document AND its chunk projection carry the same value.
				expiresAt?: Date
			}
			const pending: PendingItem[] = []
			// D1/B3: same unified-default identity rule as the single write.
			// W06: same complete-identity resolution — scope AND scopeRef with
			// the manager's workspaceDir, so batch workspace writes land in the
			// hashed workspace partition and the resolved scopeRef flows to the
			// low-level batch insert.
			const writeDefaultScope = this.resolveWriteDefaultScope()
			for (const [index, input] of events.entries()) {
				if (receipts[index]) {
					continue
				}
				const { scope, scopeRef } = resolveScopeIdentity({
					scope: input.scope,
					scopeRef: input.scopeRef,
					agentId: this.host.agentId,
					sessionId: input.sessionId,
					workspaceDir: this.host.workspaceDir,
					defaultScope: writeDefaultScope,
				})
				// P4.4.1: same TTL rule as the single write — explicit wins,
				// session-scope default applies to session writes only.
				const expiresAt = resolveWriteExpiresAt({
					explicit: input.expiresAt,
					sessionId: input.sessionId,
					ttl: this.host.config.mongodb?.ttl,
				})
				pending.push({
					index,
					input,
					eventId: randomUUID(),
					scope,
					scopeRef,
					expiresAt,
				})
			}

			// 3. ONE insertMany for the whole batch (unordered: a per-item
			// failure — validation or an E11000 idempotency race — does not
			// abort its siblings).
			const writeResults = await writeEventsBatch({
				db: this.host.db,
				prefix: this.host.prefix,
				events: pending.map(
					({ input, eventId, scope, scopeRef, expiresAt }) => ({
						eventId,
						agentId: this.host.agentId,
						sessionId: input.sessionId,
						role: input.role,
						body: input.body,
						scope,
						scopeRef,
						timestamp: input.timestamp,
						validAt: input.validAt,
						invalidAt: input.invalidAt,
						metadata: input.metadata,
						idempotencyKey: input.idempotencyKey,
						// B4: same per-item fingerprint rule as the single write.
						// W06: workspaceDir rides along for the same partition.
						...(input.idempotencyKey
							? {
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
					}),
				),
			})
			const written: Array<
				PendingItem & { timestamp: Date; scopeRef: string; replayed?: boolean }
			> = []
			for (const [position, result] of writeResults.entries()) {
				const item = pending[position]
				if (result.ok) {
					written.push({
						...item,
						timestamp: result.timestamp,
						scopeRef: result.scopeRef,
						// W09: a duplicateKey ok receipt is a durable event this
						// attempt did not create — an earlier attempt of the same
						// logical write (retry E11000 on our own eventId, or a
						// read-confirmed uncertain outcome). Converge projection
						// and job staging in this pass (both are idempotent) and
						// acknowledge it as a replay instead of failing a
						// durable write.
						...(result.duplicateKey ? { replayed: true } : {}),
					})
					continue
				}
				if (result.duplicateKey && item.input.idempotencyKey) {
					// Lost race: a concurrent same-key write committed first. Replay
					// the winner's receipt (Stripe: same key, same result); a payload
					// mismatch is a per-item 422-style conflict.
					try {
						const replay = await this.host.replayIdempotentEventWrite({
							idempotencyKey: item.input.idempotencyKey,
							event: item.input,
						})
						if (replay) {
							receipts[item.index] = {
								ok: true,
								eventId: replay.eventId,
								chunkCreated: false,
								replayed: true,
							}
							continue
						}
					} catch (err) {
						if (err instanceof IdempotencyConflictError) {
							receipts[item.index] = {
								ok: false,
								code: "IDEMPOTENCY_CONFLICT",
								message: err.message,
							}
							continue
						}
						throw err
					}
				}
				receipts[item.index] = {
					ok: false,
					code: "WRITE_ERROR",
					message: result.message,
				}
			}

			// 4. ONE bulkWrite for chunk projection + ONE updateMany marking the
			// events projected. A projection failure degrades to
			// chunkCreated:false without failing the (already durable) writes —
			// the projection repair pass recovers them.
			if (written.length > 0) {
				const chunkResults = await projectEventChunksBatch({
					db: this.host.db,
					prefix: this.host.prefix,
					events: written.map((item) => ({
						eventId: item.eventId,
						agentId: this.host.agentId,
						role: item.input.role,
						body: item.input.body,
						scope: item.scope,
						scopeRef: item.scopeRef,
						timestamp: item.timestamp,
						validAt: item.input.validAt ?? item.timestamp,
						...(item.input.invalidAt
							? { invalidAt: item.input.invalidAt }
							: {}),
						// C-005: expiry computed at pending time — identical to
						// the value persisted on the event document.
						...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
						...(item.input.sessionId
							? { sessionId: item.input.sessionId }
							: {}),
						...(item.input.metadata ? { metadata: item.input.metadata } : {}),
					})),
				})
				let createdChunkCount = 0
				for (const [position, item] of written.entries()) {
					const chunkCreated = chunkResults[position]?.chunkCreated ?? false
					if (chunkCreated) {
						this.host.chunkCount += 1
						createdChunkCount += 1
					}
					receipts[item.index] = {
						ok: true,
						eventId: item.eventId,
						chunkCreated,
						...(item.replayed ? { replayed: true } : {}),
					}
				}
				// C-017: each newly projected chunk is embedded server-side
				// (autoEmbed) in automated mode — one indexing unit per created
				// chunk, billed as one ledger increment for the batch.
				if (
					createdChunkCount > 0 &&
					this.host.config.mongodb?.embeddingMode === "automated"
				) {
					recordEmbeddingSpend(
						this.host.db,
						this.host.prefix,
						this.host.agentId,
						"indexing",
						createdChunkCount,
					)
				}
			}

			// 5. ONE insertMany for the extraction jobs (directly claimable —
			// the batch has no transaction to stage through), then ONE
			// updateMany clearing the outbox markers for events whose job is
			// durable. A failed job insert leaves the marker set for the outbox
			// repair pass, the same recovery contract as the single path.
			if (postWriteDerivedWorkEnabled && written.length > 0) {
				const jobResults = await createMemoryJobsBatch({
					db: this.host.db,
					prefix: this.host.prefix,
					jobs: written.map((item) => ({
						jobId: `extraction-${item.eventId}`,
						jobType: "extraction" as const,
						agentId: this.host.agentId,
						status: "pending" as const,
						metadata: { eventId: item.eventId },
						payload: {
							eventId: item.eventId,
							scope: item.scope,
							scopeRef: item.scopeRef,
						},
					})),
				})
				const claimableEventIds: string[] = []
				for (const [position, jobResult] of jobResults.entries()) {
					const item = written[position]
					// A duplicate means the deterministic extraction-<eventId> job
					// already exists (pre-created by /v1/extract or a prior attempt)
					// and is claimable — satisfied, not an error.
					if (jobResult.ok || jobResult.duplicate) {
						claimableEventIds.push(item.eventId)
						if (operationRunContext) {
							this.host.memoryJobOperationContexts.set(
								`extraction-${item.eventId}`,
								operationRunContext,
							)
						}
					} else {
						log.warn(
							`batch extraction job insert failed for ${item.eventId}; leaving the outbox marker for the repair pass: ${jobResult.message}`,
						)
					}
				}
				if (claimableEventIds.length > 0) {
					try {
						await clearEventExtractionJobPendingBatch({
							db: this.host.db,
							prefix: this.host.prefix,
							eventIds: claimableEventIds,
							agentId: this.host.agentId,
						})
					} catch (err) {
						log.warn(`batch extraction outbox cleanup failed: ${String(err)}`)
					}
				}
				if (this.host.memoryJobWorkerStopped) {
					this.host.startMemoryJobWorker()
				} else {
					this.host.wakeMemoryJobWorker()
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
					})
				}
				this.host.scheduleQueryCacheInvalidation({
					agentId: this.host.agentId,
					scope: item.scope,
					scopeRef: item.scopeRef,
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
					bump("hybrid", receipt && receipt.ok && receipt.chunkCreated ? 1 : 0)
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
					await updateLaneCoverage({
						db: this.host.db,
						prefix: this.host.prefix,
						agentId: this.host.agentId,
						increments,
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
					await recordIngestRun({
						db: this.host.db,
						prefix: this.host.prefix,
						run: {
							agentId: this.host.agentId,
							source: "event-write",
							status,
							itemsProcessed,
							itemsFailed,
							durationMs: Date.now() - ingestStartMs,
						},
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
		const eventId = params.eventId.trim()
		if (!eventId) {
			throw new Error("eventId is required")
		}
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
		return this.host.scheduleBackgroundExtraction(eventId, {
			scope: params.scope,
			scopeRef: params.scopeRef,
		})
	}
}
