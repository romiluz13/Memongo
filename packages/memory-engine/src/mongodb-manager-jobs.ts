import path from "node:path"
import type { Db } from "mongodb"
import { instrumentProviderCostSpend } from "./mongodb-cost-ledger.js"
import { getTenantErasureEpoch } from "./mongodb-erasure-epoch.js"
import {
	instrumentOperationProvider,
	type OperationRunContext,
} from "./mongodb-operation-accounting.js"
import { isDuplicateKeyError } from "./internal.js"
import {
	heuristicEpisodeSummarizer,
	promoteDerivedMemoryFromEvent,
} from "./mongodb-derived-memory.js"
import { checkAutoEpisodeTriggers } from "./mongodb-episodes.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import {
	extractAndUpsertEntities,
	extractAndUpsertTypedRelations,
} from "./mongodb-graph.js"
import {
	markLaneAvailable,
	updateLaneCoverage,
} from "./mongodb-lane-coverage.js"
import {
	resolveEnrichmentProvider,
	enrichSessionsWithLLM,
	extractSessionEnrichment,
} from "./mongodb-llm-enrichment.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	claimMemoryJob,
	completeClaimedMemoryJob,
	createMemoryJob,
	failClaimedMemoryJob,
	getMemoryJob,
	renewMemoryJobLease,
	retryFailedMemoryJob,
} from "./mongodb-memory-jobs.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import {
	eventsCollection,
	entitiesCollection,
	memoryJobsCollection,
} from "./mongodb-schema.js"
import type { ClaimedMemoryJob } from "./types.js"
import { createSubsystemLogger } from "@memongo/lib"
import type { MemoryScope } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb")

function elapsedMsSince(startedAt: Date): number {
	return Math.max(0, Date.now() - startedAt.getTime())
}

function normalizeFactEvidence(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
}

function bodySupportsFact(body: string, fact: string): boolean {
	const normalizedBody = normalizeFactEvidence(body)
	const normalizedFact = normalizeFactEvidence(fact)
	return (
		normalizedFact.length > 0 &&
		` ${normalizedBody} `.includes(` ${normalizedFact} `)
	)
}

/**
 * Memory-job/worker seam extracted from `mongodb-manager.ts` (P4.3): worker
 * tuning constants and the `ManagerJobsOps` collaborator the facade
 * delegates to for background extraction scheduling, leases, and drains.
 */

export const MEMORY_JOB_LEASE_MS = 60_000
export const MEMORY_JOB_HEARTBEAT_MS = 20_000

const MEMORY_JOB_SWEEP_DEFAULT_MS = 30_000

/**
 * C-009 (EL-009 R1): the standing worker interval is a 30s sweep in EVERY
 * runtime mode — the legacy 1 Hz poll exhausted connection budgets at
 * moderate scale (one poll round-trip per manager per second). Latency is
 * unaffected: every write still wakes the worker immediately, so the sweep
 * only bounds crash-recovery and lease-reclaim latency.
 */
export function resolveMemoryJobSweepMs(): number {
	const raw = process.env.MEMONGO_JOB_SWEEP_MS?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed)
		}
	}
	return MEMORY_JOB_SWEEP_DEFAULT_MS
}

/**
 * P3.9: how many extraction jobs the durable memory-job worker processes
 * concurrently per drain round (MEMONGO_JOB_WORKER_CONCURRENCY, default 3).
 * CAS claims (findOneAndUpdate) make concurrent claiming safe; lease fencing
 * inside the job runner is per-job and unchanged.
 */
const MEMORY_JOB_WORKER_CONCURRENCY_DEFAULT = 3
const MEMORY_JOB_WORKER_CONCURRENCY_MAX = 16

export function resolveMemoryJobWorkerConcurrency(): number {
	const raw = process.env.MEMONGO_JOB_WORKER_CONCURRENCY?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed >= 1) {
			return Math.min(Math.floor(parsed), MEMORY_JOB_WORKER_CONCURRENCY_MAX)
		}
	}
	return MEMORY_JOB_WORKER_CONCURRENCY_DEFAULT
}

// ---------------------------------------------------------------------------
// WS-11 change 3 (09-report R6/U3): backlog gauge + alert threshold + drain
// that scales with depth.
//
// "How far behind are we" used to be unanswerable from the system itself:
// jobs were countable (getV2Status) but nothing alarmed on depth, and the
// drain ran at fixed concurrency no matter how deep the queue was. Now each
// drain round reads the pending depth once (one countDocuments), emits a
// memory-job-backlog telemetry doc when depth crosses the alert threshold,
// and widens the round's claim concurrency within the 16 cap so a burst is
// drained faster instead of growing silently.
// ---------------------------------------------------------------------------

/** Alert threshold for pending extraction-job depth (default 500). */
const MEMORY_JOB_BACKLOG_ALERT_DEFAULT = 500

export function resolveMemoryJobBacklogAlertThreshold(): number {
	const raw = process.env.MEMONGO_JOB_BACKLOG_ALERT?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed >= 1) {
			return Math.floor(parsed)
		}
	}
	return MEMORY_JOB_BACKLOG_ALERT_DEFAULT
}

/**
 * Effective per-round claim concurrency. At or below the alert threshold the
 * configured base applies unchanged; above it, concurrency scales with the
 * overflow ratio (depth 2x threshold -> 2x base, 3x -> 3x base, ...) and
 * clamps at the 16-worker hard cap. Pure so the scaling rule is unit-pinned.
 */
export function resolveDrainConcurrency(params: {
	depth: number
	base: number
	threshold: number
	cap?: number
}): number {
	const {
		depth,
		base,
		threshold,
		cap = MEMORY_JOB_WORKER_CONCURRENCY_MAX,
	} = params
	if (depth <= threshold || threshold <= 0) {
		return base
	}
	const overflowRatio = depth / threshold
	const scale = Math.max(1, Math.ceil(overflowRatio))
	return Math.min(cap, base * scale)
}

/**
 * Pending (claimable) job depth for one agent's queue — the gauge's read.
 * One countDocuments per drain round; an error degrades to 0 so the gauge
 * can never break the drain itself (observability fails open here).
 */
export async function countPendingMemoryJobs(params: {
	db: Db
	prefix: string
	agentId: string
	jobType?: "extraction" | "consolidation"
}): Promise<number> {
	try {
		const filter: Record<string, unknown> = {
			agentId: params.agentId,
			status: "pending",
		}
		if (params.jobType) {
			filter.jobType = params.jobType
		}
		return await memoryJobsCollection(params.db, params.prefix).countDocuments(
			filter,
		)
	} catch (err) {
		log.warn("memory-job backlog count failed", {
			error: err instanceof Error ? err.message : String(err),
		})
		return 0
	}
}

const AUTO_CONSOLIDATION_DEFAULT_MS = 6 * 60 * 60 * 1000

/**
 * Cadence at which the worker sweep stages a consolidation job
 * (MEMONGO_AUTO_CONSOLIDATION_MS, default 6h; an explicit 0 or negative value
 * disables automatic consolidation entirely).
 *
 * This is a CADENCE, not a rate limit. The gate inside consolidateMemory
 * stays the actual limiter (default: one successful run per scope per hour)
 * and lease-fences concurrent runs, so a shorter staging interval can never
 * make consolidation run more often than the gate allows. Staging is
 * once-per-window by construction: the jobId encodes the window index and
 * the unique index on memory_jobs.jobId makes duplicate staging a no-op
 * across every drain round and every manager instance.
 */
export function resolveAutoConsolidationMs(): number {
	const raw = process.env.MEMONGO_AUTO_CONSOLIDATION_MS?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed)) {
			if (parsed <= 0) {
				return 0
			}
			return Math.floor(parsed)
		}
	}
	return AUTO_CONSOLIDATION_DEFAULT_MS
}

/** Input shape shared by writeConversationEvent and its batch variant. */

export class MongoDBManagerJobsOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	enqueueDerivedWork(task: () => Promise<void>): void {
		const run = async () => {
			try {
				await task()
			} catch (err) {
				log.warn(`derived memory work failed: ${String(err)}`)
			}
		}
		const next = this.host.derivationQueue.then(run, run)
		this.host.derivationQueue = next.then(
			() => undefined,
			() => undefined,
		)
	}

	enqueueDerivationScheduling(task: () => Promise<void>): void {
		const run = async () => {
			try {
				await task()
			} catch (err) {
				log.warn(`derived memory scheduling failed: ${String(err)}`)
			}
		}
		const current = this.host.derivationSchedulingQueue ?? Promise.resolve()
		const next = current.then(run, run)
		this.host.derivationSchedulingQueue = next.then(
			() => undefined,
			() => undefined,
		)
	}

	shouldRunPostWriteDerivedWork(): boolean {
		return true
	}

	isDuplicateKeyError(err: unknown): boolean {
		if (!err || typeof err !== "object") {
			return false
		}
		const code = (err as { code?: unknown }).code
		if (code === 11000 || code === "11000") {
			return true
		}
		const message =
			err instanceof Error
				? err.message
				: typeof (err as { message?: unknown }).message === "string"
					? String((err as { message: string }).message)
					: String(err)
		return message.includes("E11000") || message.includes("duplicate key")
	}

	async runClaimedBackgroundExtractionJob(
		job: ClaimedMemoryJob,
		prefetchedLlmFacts?: string[],
	): Promise<void> {
		const payloadEventId = job.payload?.eventId?.trim()
		const metadataEventId =
			typeof job.metadata?.eventId === "string"
				? job.metadata.eventId.trim()
				: undefined
		const eventId = payloadEventId || metadataEventId
		if (!eventId) {
			await failClaimedMemoryJob({
				db: this.host.db,
				prefix: this.host.prefix,
				jobId: job.jobId,
				agentId: this.host.agentId,
				leaseOwner: job.leaseOwner,
				leaseToken: job.leaseToken,
				error: "extraction job payload.eventId is required",
			})
			return
		}
		const scope = job.payload?.scope
		const scopeRef = job.payload?.scopeRef
		const runContext = this.host.memoryJobOperationContexts?.get(job.jobId)
		const startedAt = job.startedAt ?? new Date()
		let leaseLost = false
		let heartbeatInFlight = Promise.resolve()
		const heartbeat = () => {
			heartbeatInFlight = heartbeatInFlight
				.then(async () => {
					const renewed = await renewMemoryJobLease({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId: job.jobId,
						agentId: this.host.agentId,
						leaseOwner: job.leaseOwner,
						leaseToken: job.leaseToken,
						leaseMs: MEMORY_JOB_LEASE_MS,
					})
					if (!renewed) {
						leaseLost = true
					}
				})
				.catch((err) => {
					leaseLost = true
					log.warn(
						`memory job heartbeat failed for ${job.jobId}: ${String(err)}`,
					)
				})
		}
		const heartbeatTimer = setInterval(heartbeat, MEMORY_JOB_HEARTBEAT_MS)
		heartbeatTimer.unref?.()

		// (P2.5 b) lease fencing is enforced BEFORE every side-effecting
		// stage, not only before the terminal write: a worker that lost its
		// lease must not commit entity/derived/relation writes at all. The new
		// lease owner re-runs the job, and event-receipt idempotency
		// (hasProcessedSourceEvents, wired through
		// promoteDerivedMemoryFromEvent's eventReceiptIds) keeps that
		// re-execution free of duplicate side effects.
		// W03 erasure fencing: the tenant epoch captured at claim is
		// re-read at every fence check too. An erasure bumps the epoch and
		// deletes this job row (killing the lease) — but the lease check
		// alone cannot distinguish "erasure deleted my row" from any other
		// renewal failure, and a cross-process worker holding the event in
		// memory would otherwise keep projecting erased data. An advanced
		// epoch abandons the job before the next side-effecting stage.
		// The epoch read is BEST-EFFORT: on a read error (e.g. the meta
		// collection momentarily unavailable) the comparison is skipped and
		// the lease fence remains the owner guard — a meta read failure says
		// nothing about ownership, and the erasure's post-sweep verification
		// pass is the truth gate for anything that slips a fence.
		const epochAtClaim = await getTenantErasureEpoch(
			this.host.db,
			this.host.prefix,
			this.host.agentId,
		).catch((err: unknown) => {
			log.warn(
				`tenant epoch read failed at claim of ${job.jobId}; lease-only fencing for this job: ${err instanceof Error ? err.message : String(err)}`,
			)
			return null
		})
		let epochAdvanced = false
		const leaseFence = async (stage: string): Promise<boolean> => {
			await heartbeatInFlight
			if (leaseLost) {
				log.warn(`extraction job lease lost before ${stage}: ${job.jobId}`)
				return true
			}
			if (epochAtClaim !== null) {
				const currentEpoch = await getTenantErasureEpoch(
					this.host.db,
					this.host.prefix,
					this.host.agentId,
				).catch((err: unknown) => {
					log.warn(
						`tenant epoch read failed before ${stage} of ${job.jobId}; skipping epoch check: ${err instanceof Error ? err.message : String(err)}`,
					)
					return null
				})
				if (currentEpoch !== null && currentEpoch !== epochAtClaim) {
					epochAdvanced = true
				}
				if (epochAdvanced) {
					log.warn(
						`tenant erasure epoch advanced (${epochAtClaim} -> ${currentEpoch}) before ${stage}; abandoning pre-erasure job ${job.jobId}`,
					)
					return true
				}
			}
			return false
		}

		try {
			const eventDoc = (await eventsCollection(
				this.host.db,
				this.host.prefix,
			).findOne({
				eventId,
				agentId: this.host.agentId,
				// Tenant isolation: a scope-restricted caller can only extract from an
				// event within its authorized scope/scopeRef; a cross-scope event is
				// simply not found here.
				...(scope !== undefined ? { scope } : {}),
				...(scopeRef !== undefined ? { scopeRef } : {}),
			})) as {
				eventId: string
				agentId: string
				role: "user" | "assistant" | "system" | "tool"
				body: string
				timestamp: Date
				sessionId?: string
				scope: MemoryScope
				scopeRef: string
			} | null
			if (!eventDoc) {
				throw new Error(`event not found: ${eventId}`)
			}
			if (await leaseFence("entity extraction")) {
				return
			}
			const entityResult = await extractAndUpsertEntities({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				eventContent: eventDoc.body,
				scope: eventDoc.scope,
				scopeRef: eventDoc.scopeRef,
				sourceEventId: eventDoc.eventId,
				role: eventDoc.role,
			})
			if (entityResult.entities.length > 0) {
				if (await leaseFence("graph lane availability")) {
					return
				}
				// Availability is a separate idempotent bit from the useful
				// successful-job count. Persist it as soon as graph entities exist
				// so a permanent failure in promotion or relation extraction cannot
				// leave those entities gated from retrieval.
				await markLaneAvailable({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					lane: "graph",
				})
			}

			// LLM fact extraction (issue #30): degrade to regex-only when the
			// provider is unconfigured or misconfigured.
			let enrichmentProvider: EnrichmentProvider | null = null
			try {
				const resolved = resolveEnrichmentProvider(process.env)
				// C-017: every production extraction call lands in the per-tenant
				// per-day cost ledger (tokens from the transport usage block).
				enrichmentProvider = resolved
					? instrumentProviderCostSpend({
							db: this.host.db,
							prefix: this.host.prefix,
							agentId: this.host.agentId,
							provider: resolved,
						})
					: null
			} catch (err) {
				log.warn("enrichment provider resolution failed; using regex-only", {
					error: err instanceof Error ? err.message : String(err),
				})
			}
			const enrichmentModel = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
			const structuredProvider =
				enrichmentProvider && runContext
					? instrumentOperationProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "structured-extraction",
							model: enrichmentModel,
						})
					: enrichmentProvider
			const temporalProvider =
				enrichmentProvider && runContext
					? instrumentOperationProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "temporal-extraction",
							model: enrichmentModel,
						})
					: enrichmentProvider
			const contradictionProvider =
				enrichmentProvider && runContext
					? instrumentOperationProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "contradiction-detection",
							model: enrichmentModel,
						})
					: enrichmentProvider

			if (await leaseFence("derived-memory promotion")) {
				return
			}
			const result = await promoteDerivedMemoryFromEvent({
				db: this.host.db,
				prefix: this.host.prefix,
				client: this.host.client,
				embeddingMode: this.host.config.mongodb?.embeddingMode ?? "automated",
				event: {
					...eventDoc,
					workspaceDir: this.host.workspaceDir,
				},
				provider: structuredProvider,
				temporalProvider,
				contradictionProvider,
				model: enrichmentModel,
				// P3.9: facts from the round's session-batched extraction; when
				// present, promotion skips its own per-event provider call.
				...(prefetchedLlmFacts ? { prefetchedLlmFacts } : {}),
			})
			await heartbeatInFlight
			if (leaseLost) {
				log.warn(`extraction job lease lost during execution: ${job.jobId}`)
				return
			}

			// Typed semantic edge extraction (issue #34): LLM-only, background-only.
			// Read the entities already upserted earlier in this job for the event — do
			// NOT re-extract, which would double-increment the indexed mentionCount.
			if (enrichmentProvider) {
				try {
					const eventEntities = (
						await entitiesCollection(this.host.db, this.host.prefix)
							.find(
								{
									agentId: this.host.agentId,
									scope: eventDoc.scope,
									scopeRef: eventDoc.scopeRef,
									sourceEventIds: eventDoc.eventId,
								},
								{ projection: { entityId: 1, name: 1, _id: 0 } },
							)
							.toArray()
					)
						.map((e) => ({
							entityId: String(e.entityId),
							name: String(e.name ?? ""),
						}))
						.filter((e) => e.entityId && e.name)
					if (eventEntities.length >= 2) {
						if (await leaseFence("typed relation extraction")) {
							return
						}
						const relationProvider = runContext
							? instrumentOperationProvider({
									provider: enrichmentProvider,
									runContext,
									operation: "relation-extraction",
									model: enrichmentModel,
								})
							: enrichmentProvider
						const relationsCreated = await extractAndUpsertTypedRelations({
							db: this.host.db,
							prefix: this.host.prefix,
							client: this.host.client,
							agentId: this.host.agentId,
							scope: eventDoc.scope,
							scopeRef: eventDoc.scopeRef,
							eventContent: eventDoc.body,
							entities: eventEntities,
							provider: relationProvider,
							model: enrichmentModel,
							sourceEventId: eventDoc.eventId,
							validFrom: eventDoc.timestamp,
							leaseFence: () => leaseFence("typed relation write"),
						})
						// Surface the pass so silent degradation to mentioned_with-only
						// is observable rather than an invisible no-op.
						await recordProjectionRun({
							db: this.host.db,
							prefix: this.host.prefix,
							run: {
								agentId: this.host.agentId,
								projectionType: "relations",
								status: "ok",
								itemsProjected: relationsCreated,
								durationMs: 0,
							},
						}).catch(() => {})
					}
				} catch (err) {
					// C3: no silent success. Record the failed pass in the
					// projection ledger, then rethrow so the runner's outer catch
					// routes the error through failClaimedMemoryJob — the job
					// retries via the existing mechanism instead of completing
					// with the relations silently lost.
					await recordProjectionRun({
						db: this.host.db,
						prefix: this.host.prefix,
						run: {
							agentId: this.host.agentId,
							projectionType: "relations",
							status: "failed",
							itemsProjected: 0,
							durationMs: 0,
						},
					}).catch(() => {})
					throw err
				}
			}

			try {
				const completed = await completeClaimedMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					jobId: job.jobId,
					agentId: this.host.agentId,
					leaseOwner: job.leaseOwner,
					leaseToken: job.leaseToken,
					completedAt: new Date(),
					durationMs: elapsedMsSince(startedAt),
					inputCount: 1,
					outputCount: result.structuredCreated + result.proceduresCreated,
					metadata: {
						eventId,
						structuredCreated: result.structuredCreated,
						proceduresCreated: result.proceduresCreated,
						...(result.skipped
							? { skipped: true, skipReason: result.skipReason }
							: {}),
					},
				})
				if (!completed) {
					log.warn(`extraction job lease lost before completion: ${job.jobId}`)
				}
			} catch (err) {
				log.warn(
					`completeClaimedMemoryJob failed for ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		} catch (err) {
			try {
				await failClaimedMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					jobId: job.jobId,
					agentId: this.host.agentId,
					leaseOwner: job.leaseOwner,
					leaseToken: job.leaseToken,
					completedAt: new Date(),
					durationMs: elapsedMsSince(startedAt),
					error: err instanceof Error ? err.message : String(err),
					metadata: { eventId },
					attempts: job.attempts,
				})
			} catch (updateErr) {
				log.warn(
					`failClaimedMemoryJob failed for ${job.jobId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
				)
			}
		} finally {
			clearInterval(heartbeatTimer)
			await heartbeatInFlight
			this.host.memoryJobOperationContexts?.delete(job.jobId)
		}
	}

	async drainMemoryJobQueue(): Promise<void> {
		const repaired = await this.host.repairExtractionOutbox()
		if (repaired.eventsFailed > 0) {
			log.warn(
				`extraction outbox repair left ${repaired.eventsFailed} event(s) pending retry`,
			)
		}
		// C-006: fingerprint retention enforcement rides the worker sweep —
		// the prune is hourly-gated inside the write ops, so an idle queue
		// pays one Date.now() comparison per drain and nothing else.
		await this.host.pruneIdempotencyFingerprints()
		await this.stageAutoConsolidationJob()
		// P3.9: claim up to K jobs per round and process them concurrently.
		// Claims stay sequential findOneAndUpdate CAS operations, so two
		// rounds/workers can never claim the same job; lease fencing inside
		// the job runner is per-job and unchanged (P2.5). Within a round, LLM
		// fact extraction is batched per session (one provider call for every
		// claimed event sharing a session, mirroring enrichSessionsWithLLM).
		//
		// WS-11 change 3: K is backlog-aware. One depth read per drain call
		// feeds the alert gauge (telemetry when depth crosses the threshold)
		// and widens the round's concurrency within the 16 cap so a burst
		// drains faster instead of compounding silently (09-report R6/U3).
		const backlogThreshold = resolveMemoryJobBacklogAlertThreshold()
		const backlogDepth = await countPendingMemoryJobs({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			jobType: "extraction",
		})
		if (backlogDepth > backlogThreshold) {
			emitTelemetry(this.host.db, this.host.prefix, {
				meta: { agentId: this.host.agentId, operation: "memory-job-backlog" },
				durationMs: 0,
				ok: false,
				itemCount: backlogDepth,
				depth: backlogDepth,
				threshold: backlogThreshold,
			})
		}
		const concurrency = resolveDrainConcurrency({
			depth: backlogDepth,
			base: resolveMemoryJobWorkerConcurrency(),
			threshold: backlogThreshold,
		})
		while (!this.host.memoryJobWorkerStopped) {
			const jobs: ClaimedMemoryJob[] = []
			for (let claimed = 0; claimed < concurrency; claimed++) {
				const job = await claimMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					jobType: "extraction",
					workerId: this.host.memoryJobWorkerId,
					leaseMs: MEMORY_JOB_LEASE_MS,
				})
				if (!job) {
					break
				}
				jobs.push(job)
			}
			if (jobs.length === 0) {
				break
			}
			const sessionFacts = await this.host.prefetchExtractionSessionFacts(jobs)
			const stillOwned = await Promise.all(
				jobs.map(async (job) => {
					try {
						const renewed = await renewMemoryJobLease({
							db: this.host.db,
							prefix: this.host.prefix,
							jobId: job.jobId,
							agentId: this.host.agentId,
							leaseOwner: job.leaseOwner,
							leaseToken: job.leaseToken,
							leaseMs: MEMORY_JOB_LEASE_MS,
						})
						if (!renewed) {
							log.warn(
								`extraction job lease lost during session prefetch: ${job.jobId}`,
							)
						}
						return renewed
					} catch (err) {
						log.warn(
							`extraction job ownership check failed after session prefetch: ${job.jobId}: ${String(err)}`,
						)
						return false
					}
				}),
			)
			await Promise.all(
				jobs.map((job, index) => {
					if (!stillOwned[index]) {
						return Promise.resolve()
					}
					const eventId =
						job.payload?.eventId?.trim() ||
						(typeof job.metadata?.eventId === "string"
							? job.metadata.eventId.trim()
							: "")
					return this.host.runClaimedBackgroundExtractionJob(
						job,
						eventId ? sessionFacts.get(eventId) : undefined,
					)
				}),
			)
		}
		// One consolidation job per drain round. Staging (above) is
		// cadence-gated; the gate inside consolidateMemory rate-limits and
		// lease-fences the actual run; claimMemoryJob's CAS guarantees exactly
		// one winner across managers. A stale never-claimed window job simply
		// runs here, completes (or is skipped by the gate's rate limiter), and
		// the next drain picks up the next one.
		if (!this.host.memoryJobWorkerStopped) {
			// W03: capture the tenant epoch BEFORE the claim — work claimed at
			// epoch E must not execute at a higher epoch (an erasure bumped
			// it and swept the tenant). Checked again inside the runner.
			// Read errors degrade to lease-only fencing (see the runner).
			const consolidationEpochAtClaim = await getTenantErasureEpoch(
				this.host.db,
				this.host.prefix,
				this.host.agentId,
			).catch(() => null)
			const consolidationJob = await claimMemoryJob({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				jobType: "consolidation",
				workerId: this.host.memoryJobWorkerId,
				leaseMs: MEMORY_JOB_LEASE_MS,
			})
			if (consolidationJob) {
				await this.runClaimedConsolidationJob(
					consolidationJob,
					consolidationEpochAtClaim,
				)
			}
		}
	}

	/** Window index whose consolidation job this instance already staged. */
	private lastAutoConsolidationWindow: number | null = null

	/**
	 * Stage one pending consolidation job per cadence window. The jobId
	 * encodes the agent AND the window index: claims are agent-scoped (a job
	 * staged for agent A can only ever be claimed by agent A's worker), so a
	 * window-only jobId would let the first agent's uq_memory_jobs_jobid
	 * insert silently swallow every other agent's staging for that window —
	 * one agent per prefix would hoard all auto-consolidation. With the agent
	 * in the key, uq_memory_jobs_jobid makes staging idempotent across drain
	 * rounds and manager instances OF THE SAME AGENT (E11000 = a peer got
	 * there first, which is exactly the once-per-window-per-agent invariant).
	 * The in-memory window memo keeps the common case at zero extra round
	 * trips. Staged jobs carry no stagedAt, so they are claimable immediately
	 * — unlike extraction jobs, which a transaction stages until commit.
	 */
	private async stageAutoConsolidationJob(): Promise<void> {
		const intervalMs = resolveAutoConsolidationMs()
		if (intervalMs <= 0) {
			return
		}
		const windowIndex = Math.floor(Date.now() / intervalMs)
		if (windowIndex === this.lastAutoConsolidationWindow) {
			return
		}
		const jobId = `consolidation-auto-${this.host.agentId}-${windowIndex}`
		try {
			await createMemoryJob({
				db: this.host.db,
				prefix: this.host.prefix,
				job: {
					jobId,
					jobType: "consolidation",
					agentId: this.host.agentId,
					status: "pending",
					metadata: { auto: true, window: windowIndex },
				},
			})
		} catch (err) {
			if (this.host.isDuplicateKeyError(err)) {
				// Another drain round or manager already staged this window.
			} else {
				log.warn(
					`auto-consolidation staging failed for window ${windowIndex}: ${err instanceof Error ? err.message : String(err)}`,
				)
				return
			}
		}
		this.lastAutoConsolidationWindow = windowIndex
	}

	/**
	 * Run a claimed consolidation job with the same lease/heartbeat fencing
	 * the extraction runner uses. Runs with default options — scope "agent",
	 * the zero-config surface consolidateMemory itself defaults to — so the
	 * gate's rate limiter covers the whole agent, and the per-scope query
	 * cache is invalidated exactly like the explicit consolidate() path.
	 */
	private async runClaimedConsolidationJob(
		job: ClaimedMemoryJob,
		epochAtClaim: number | null,
	): Promise<void> {
		const startedAt = new Date()
		// W03 erasure fencing: consolidation derives new tenant data
		// (entities, structured memories) from state it reads at run time; a
		// job claimed before an erasure must not execute after it — its
		// source state was swept and its writes would resurrect erased data.
		// The job row itself is deleted by the sweep, so no re-claim follows.
		// The check is BEST-EFFORT like the extraction fence: on a read
		// error the lease fence still guards the run, and the erasure's
		// post-sweep verification pass is the truth gate for any in-flight
		// straddle.
		const currentEpoch = await getTenantErasureEpoch(
			this.host.db,
			this.host.prefix,
			this.host.agentId,
		).catch((err: unknown) => {
			log.warn(
				`tenant epoch read failed for consolidation job ${job.jobId}; proceeding lease-only: ${err instanceof Error ? err.message : String(err)}`,
			)
			return null
		})
		if (
			currentEpoch !== null &&
			epochAtClaim !== null &&
			currentEpoch !== epochAtClaim
		) {
			log.warn(
				`tenant erasure epoch advanced (${epochAtClaim} -> ${currentEpoch}); abandoning consolidation job ${job.jobId}`,
			)
			return
		}
		const heartbeatTimer = setInterval(() => {
			renewMemoryJobLease({
				db: this.host.db,
				prefix: this.host.prefix,
				jobId: job.jobId,
				agentId: this.host.agentId,
				leaseOwner: job.leaseOwner,
				leaseToken: job.leaseToken,
				leaseMs: MEMORY_JOB_LEASE_MS,
			}).catch((err) => {
				log.warn(
					`consolidation job heartbeat failed: ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`,
				)
			})
		}, MEMORY_JOB_HEARTBEAT_MS)
		heartbeatTimer.unref?.()
		try {
			const result = await consolidateMemory({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			})
			await invalidateQueryCache({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				scope: "agent",
				scopeRef: resolveScopeRef({
					scope: "agent",
					agentId: this.host.agentId,
					workspaceDir: this.host.workspaceDir,
				}),
			}).catch((err) => {
				log.warn(
					`query cache invalidation after consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			})
			const completed = await completeClaimedMemoryJob({
				db: this.host.db,
				prefix: this.host.prefix,
				jobId: job.jobId,
				agentId: this.host.agentId,
				leaseOwner: job.leaseOwner,
				leaseToken: job.leaseToken,
				completedAt: new Date(),
				durationMs: result.durationMs,
				inputCount: result.eventsProcessed,
				outputCount: result.factsPromoted,
				jobType: job.jobType,
				metadata: {
					auto: true,
					runId: result.runId,
					factsPruned: result.factsPruned,
					conflictsResolved: result.conflictsResolved,
				},
			})
			if (!completed) {
				log.warn(`consolidation job lease lost before completion: ${job.jobId}`)
			}
		} catch (err) {
			try {
				await failClaimedMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					jobId: job.jobId,
					agentId: this.host.agentId,
					leaseOwner: job.leaseOwner,
					leaseToken: job.leaseToken,
					completedAt: new Date(),
					durationMs: elapsedMsSince(startedAt),
					error: err instanceof Error ? err.message : String(err),
					jobType: job.jobType,
					attempts: job.attempts,
					metadata: { auto: true },
				})
			} catch (updateErr) {
				log.warn(
					`failClaimedMemoryJob failed for ${job.jobId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
				)
			}
		} finally {
			clearInterval(heartbeatTimer)
		}
	}

	/**
	 * P3.9: batch the round's LLM fact extraction per session. One batched
	 * read fetches the claimed events; every group of 2+ events sharing a
	 * session gets ONE extractSessionEnrichment call. Each fact is handed only
	 * to events whose own body supports it; unsupported events keep the
	 * per-event provider fallback inside the job runner. Purely read-only: a
	 * job that loses its lease mid-round is still fenced before any side
	 * effect — the prefetch only wastes an LLM call, never a write.
	 */
	async prefetchExtractionSessionFacts(
		jobs: ClaimedMemoryJob[],
	): Promise<Map<string, string[]>> {
		const facts = new Map<string, string[]>()
		if (jobs.length < 2) {
			return facts
		}
		let provider: EnrichmentProvider | null = null
		try {
			const resolved = resolveEnrichmentProvider(process.env)
			// C-017: session-batched prefetch calls bill the same per-tenant
			// ledger as per-event extraction.
			provider = resolved
				? instrumentProviderCostSpend({
						db: this.host.db,
						prefix: this.host.prefix,
						agentId: this.host.agentId,
						provider: resolved,
					})
				: null
		} catch (err) {
			log.warn(
				`session-batched extraction prefetch skipped; provider resolution failed: ${err instanceof Error ? err.message : String(err)}`,
			)
			return facts
		}
		if (!provider) {
			return facts
		}
		const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

		const jobByEventId = new Map<string, ClaimedMemoryJob>()
		for (const job of jobs) {
			const eventId =
				job.payload?.eventId?.trim() ||
				(typeof job.metadata?.eventId === "string"
					? job.metadata.eventId.trim()
					: "")
			if (eventId) {
				jobByEventId.set(eventId, job)
			}
		}
		if (jobByEventId.size < 2) {
			return facts
		}

		type PrefetchEventDoc = {
			eventId: string
			sessionId?: string
			body: string
			scope: MemoryScope
			scopeRef: string
		}
		const docs = (await eventsCollection(this.host.db, this.host.prefix)
			.find(
				{
					agentId: this.host.agentId,
					eventId: { $in: [...jobByEventId.keys()] },
				},
				{
					projection: {
						eventId: 1,
						sessionId: 1,
						body: 1,
						scope: 1,
						scopeRef: 1,
					},
				},
			)
			.toArray()
			.catch((err) => {
				log.warn(
					`session-batched extraction prefetch read failed; falling back to per-event extraction: ${String(err)}`,
				)
				return []
			})) as unknown as PrefetchEventDoc[]
		const groups = new Map<string, PrefetchEventDoc[]>()
		for (const doc of docs) {
			if (!doc.sessionId) {
				continue
			}
			const key = JSON.stringify([doc.scope, doc.scopeRef, doc.sessionId])
			const group = groups.get(key) ?? []
			group.push(doc)
			groups.set(key, group)
		}
		const eligible = [...groups.values()].filter((group) => group.length >= 2)
		await Promise.all(
			eligible.map(async (group) => {
				const sessionText = group
					.map((doc) => doc.body)
					.filter((body) => body.trim().length > 0)
					.join("\n")
				if (!sessionText) {
					return
				}
				// Benchmark accounting parity with the per-event path: instrument
				// with the first group member's run context when one is registered.
				const firstJob = jobByEventId.get(group[0].eventId)
				const runContext = firstJob
					? this.host.memoryJobOperationContexts?.get(firstJob.jobId)
					: undefined
				const structuredProvider = runContext
					? instrumentOperationProvider({
							provider,
							runContext,
							operation: "structured-extraction",
							model,
						})
					: provider
				try {
					const enrichment = await extractSessionEnrichment(
						structuredProvider,
						sessionText,
						model,
					)
					if (enrichment.facts.length === 0) {
						return
					}
					for (const doc of group) {
						const supportedFacts = enrichment.facts.filter((fact) =>
							bodySupportsFact(doc.body, fact),
						)
						if (supportedFacts.length > 0) {
							facts.set(doc.eventId, supportedFacts)
						}
					}
				} catch (err) {
					log.warn(
						`session-batched LLM extraction failed for ${group.length} event(s); falling back to per-event extraction: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}),
		)
		return facts
	}

	wakeMemoryJobWorker(): void {
		if (this.host.memoryJobWorkerStopped) {
			return
		}
		if (this.host.memoryJobWorkerActive) {
			this.host.memoryJobWakeRequested = true
			return
		}
		this.host.memoryJobWorkerActive = true
		this.host.memoryJobWakeRequested = false
		const run = this.host.drainMemoryJobQueue().catch((err) => {
			log.warn(`memory job worker failed: ${String(err)}`)
		})
		this.host.memoryJobWorkerPromise = run.finally(() => {
			this.host.memoryJobWorkerActive = false
			if (this.host.memoryJobWakeRequested) {
				this.host.wakeMemoryJobWorker()
			}
		})
	}

	startMemoryJobWorker(): void {
		// (P2.5 e) never (re)start the worker during/after shutdown — a write
		// drained by close() stages its extraction job for the NEXT boot's
		// outbox repair instead of reviving a stopped worker mid-close.
		if (this.host.closed) {
			return
		}
		if (!this.host.memoryJobWorkerStopped && this.host.memoryJobWorkerTimer) {
			return
		}
		this.host.memoryJobWorkerStopped = false
		this.host.wakeMemoryJobWorker()
		this.host.memoryJobWorkerTimer = setInterval(() => {
			this.host.wakeMemoryJobWorker()
		}, resolveMemoryJobSweepMs())
		this.host.memoryJobWorkerTimer.unref?.()
	}

	async stopMemoryJobWorker(): Promise<void> {
		this.host.memoryJobWorkerStopped = true
		this.host.memoryJobWakeRequested = false
		if (this.host.memoryJobWorkerTimer) {
			clearInterval(this.host.memoryJobWorkerTimer)
			this.host.memoryJobWorkerTimer = null
		}
		await this.host.memoryJobWorkerPromise
	}

	async scheduleBackgroundExtraction(
		eventId: string,
		tenant?: { scope?: MemoryScope; scopeRef?: string },
		runContext?: OperationRunContext,
	): Promise<{ jobId: string; scheduled: boolean }> {
		// (P2.5 e) shutdown intake stop: scheduling after close would stage a
		// job and wake workers that close() is stopping.
		if (this.host.closed) {
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to schedule extraction",
			)
		}
		const jobId = `extraction-${eventId}`
		const payload = {
			eventId,
			...(tenant?.scope !== undefined ? { scope: tenant.scope } : {}),
			...(tenant?.scopeRef !== undefined ? { scopeRef: tenant.scopeRef } : {}),
		}
		try {
			await createMemoryJob({
				db: this.host.db,
				prefix: this.host.prefix,
				job: {
					jobId,
					jobType: "extraction",
					agentId: this.host.agentId,
					status: "pending",
					metadata: { eventId },
					payload,
				},
			})
		} catch (err) {
			if (this.host.isDuplicateKeyError(err)) {
				const existing = await getMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					jobId,
					agentId: this.host.agentId,
				})
				let recoverable =
					existing?.status === "pending" ||
					(existing?.status === "running" &&
						(existing.leaseExpiresAt === undefined ||
							existing.leaseExpiresAt.getTime() <= Date.now()))
				if (existing?.status === "failed") {
					recoverable = await retryFailedMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId,
						agentId: this.host.agentId,
						payload,
						metadata: { eventId },
					})
				}
				if (!recoverable) {
					// (P2.5 e) a terminal job state (completed, or failed without a
					// recoverable retry) will never be claimed by this manager —
					// drop any stale benchmark run context instead of leaking the
					// entry for the process lifetime.
					this.host.memoryJobOperationContexts?.delete(jobId)
					return { jobId, scheduled: false }
				}
			} else {
				throw err
			}
		}

		if (runContext) {
			this.host.memoryJobOperationContexts ??= new Map<
				string,
				OperationRunContext
			>()
			this.host.memoryJobOperationContexts.set(jobId, runContext)
		}
		if (this.host.memoryJobWorkerStopped) {
			this.host.startMemoryJobWorker()
		} else {
			this.host.wakeMemoryJobWorker()
		}
		return { jobId, scheduled: true }
	}

	async schedulePostWriteDerivations(params: {
		eventId: string
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		timestamp: Date
		scope: MemoryScope
		scopeRef: string
		runContext?: OperationRunContext
	}): Promise<void> {
		const mongoCfg = this.host.config.mongodb
		if (!mongoCfg) {
			return
		}
		if (!this.host.shouldRunPostWriteDerivedWork()) {
			return
		}

		if (!mongoCfg.episodes.enabled) {
			return
		}

		this.host.enqueueDerivedWork(async () => {
			const triggerThreshold = Math.max(
				1,
				mongoCfg.episodes.minEventsForEpisode - 1,
			)
			try {
				const episodeResult = await checkAutoEpisodeTriggers({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					summarizer: heuristicEpisodeSummarizer,
					scope: params.scope,
					scopeRef: params.scopeRef,
					maxEventsWithoutEpisode: triggerThreshold,
				})
				// Update episodic lane coverage when an episode is materialized
				if (episodeResult.triggered) {
					await updateLaneCoverage({
						db: this.host.db,
						prefix: this.host.prefix,
						agentId: this.host.agentId,
						increments: { episodic: 1 },
					}).catch((coverageErr) => {
						log.warn(
							`episodic lane coverage update failed: ${String(coverageErr)}`,
						)
					})
				}
			} catch (err) {
				log.warn(
					`auto episode trigger failed after event write: ${String(err)}`,
				)
			}
		})
	}
}
