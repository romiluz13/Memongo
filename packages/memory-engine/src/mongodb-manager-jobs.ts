import type { ClientSession, Db } from "mongodb"
import {
	instrumentProviderCostSpend,
	recordLLMSpendInSession,
} from "./mongodb-cost-ledger.js"
import {
	persistPreparedContradictionInvalidations,
	prepareContradictionInvalidations,
} from "./mongodb-contradiction.js"
import { getTenantErasureEpoch } from "./mongodb-erasure-epoch.js"
import {
	applyOperationAccountingEffects,
	instrumentOperationProvider,
	type OperationAccountingEffect,
	type OperationRunContext,
} from "./mongodb-operation-accounting.js"
import {
	heuristicEpisodeSummarizer,
	prepareDerivedMemoryPromotion,
	promoteDerivedMemoryFromEvent,
} from "./mongodb-derived-memory.js"
import { checkAutoEpisodeTriggers } from "./mongodb-episodes.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import {
	extractAndUpsertEntities,
	extractAndUpsertTypedRelations,
	prepareTypedRelations,
} from "./mongodb-graph.js"
import {
	markLaneAvailable,
	updateLaneCoverage,
} from "./mongodb-lane-coverage.js"
import {
	EnrichmentResponseError,
	isExtractionLlmDisabled,
	resolveEnrichmentProvider,
	extractSessionEnrichment,
} from "./mongodb-llm-enrichment.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	claimMemoryJob,
	captureClaimedMemoryJobAdmissionEpoch,
	completeClaimedMemoryJob,
	createMemoryJob,
	deadLetterExpiredMemoryJobs,
	failClaimedMemoryJob,
	getMemoryJob,
	isMemoryJobOwnershipLostError,
	MemoryJobOwnershipLostError,
	renewMemoryJobLease,
	retryFailedMemoryJob,
	withClaimedMemoryJobEffectBatch,
} from "./mongodb-memory-jobs.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { buildEventLifecycleClause } from "./mongodb-temporal.js"
import { settledFailureMeta } from "./query-diagnostics.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import {
	eventsCollection,
	entitiesCollection,
	memoryJobsCollection,
} from "./mongodb-schema.js"
import type { ClaimedMemoryJob, ConsolidationOptions } from "./types.js"
import {
	captureAdmissionToken,
	ErasureGateConflictError,
	readErasureGate,
	isErasureGateConflictError,
	type AdmissionToken,
	withFencedWrite,
} from "./mongodb-write-fence.js"
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

type BufferedWorkerEffects = {
	llmUsage: Array<{
		inputTokens?: number
		outputTokens?: number
		at: Date
	}>
	operationAccounting: OperationAccountingEffect[]
}

const PREFETCH_EFFECTS = Symbol("prefetchEffects")
type PrefetchedFactsMap = Map<string, string[]> & {
	[PREFETCH_EFFECTS]?: Map<string, BufferedWorkerEffects>
}

function newBufferedWorkerEffects(): BufferedWorkerEffects {
	return { llmUsage: [], operationAccounting: [] }
}

function appendBufferedWorkerEffects(
	target: BufferedWorkerEffects,
	source: BufferedWorkerEffects | undefined,
): void {
	if (!source) return
	target.llmUsage.push(...source.llmUsage)
	target.operationAccounting.push(...source.operationAccounting)
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
	private pendingWake?: { admission?: AdmissionToken; generation: number }
	private workerAdmission?: AdmissionToken
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
		prefetchedEffects?: BufferedWorkerEffects,
	): Promise<void> {
		const startedAt = job.startedAt ?? new Date()
		const payloadEventId = job.payload?.eventId?.trim()
		const metadataEventId =
			typeof job.metadata?.eventId === "string"
				? job.metadata.eventId.trim()
				: undefined
		const eventId = payloadEventId || metadataEventId
		const storedEpoch = job.admissionEpoch
		let admissionToken:
			| {
					kind: "admission"
					agentId: string
					epoch: number
			  }
			| undefined
		if (storedEpoch !== undefined) {
			if (
				!Number.isInteger(storedEpoch) ||
				storedEpoch < 0 ||
				!Number.isFinite(storedEpoch)
			) {
				log.warn(
					`extraction job ${job.jobId} has an invalid admission epoch; refusing to run`,
				)
				return
			}
			admissionToken = {
				kind: "admission",
				agentId: this.host.agentId,
				epoch: storedEpoch,
			}
		} else {
			// Legacy rows are upgraded before reading event/provider data. The
			// trusted capture primitive initializes a missing gate and fails
			// closed on malformed/unreadable/erasing state.
			try {
				const captured = await captureAdmissionToken({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
				})
				const attached = await captureClaimedMemoryJobAdmissionEpoch({
					db: this.host.db,
					prefix: this.host.prefix,
					token: captured,
					jobId: job.jobId,
					agentId: this.host.agentId,
					leaseOwner: job.leaseOwner,
					leaseToken: job.leaseToken,
				})
				if (!attached) {
					log.warn(
						`extraction job lease lost before legacy admission capture: ${job.jobId}`,
					)
					return
				}
				job.admissionEpoch = captured.epoch
				admissionToken = captured
			} catch (err) {
				log.warn(
					`extraction job admission capture failed for ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`,
				)
				return
			}
		}
		if (!eventId || !admissionToken) {
			log.warn(`extraction job ${job.jobId} has no event id; refusing to run`)
			return
		}
		const scope = job.payload?.scope
		const scopeRef = job.payload?.scopeRef
		const runContext = this.host.memoryJobOperationContexts?.get(job.jobId)
		const bufferedEffects = newBufferedWorkerEffects()
		appendBufferedWorkerEffects(bufferedEffects, prefetchedEffects)
		let eventSnapshot:
			| {
					eventId: string
					agentId: string
					role: "user" | "assistant" | "system" | "tool"
					body: string
					timestamp: Date
					sessionId?: string
					scope: MemoryScope
					scopeRef: string
			  }
			| undefined
		let heartbeatInFlight = Promise.resolve()
		let leaseFailure: MemoryJobOwnershipLostError | undefined
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
						leaseFailure ??= new MemoryJobOwnershipLostError(job.jobId)
						log.warn(`memory job heartbeat lost lease for ${job.jobId}`)
					}
				})
				.catch((err) => {
					leaseFailure ??= new MemoryJobOwnershipLostError(job.jobId)
					log.warn(
						`memory job heartbeat failed for ${job.jobId}: ${String(err)}`,
					)
				})
		}
		const heartbeatTimer = setInterval(heartbeat, MEMORY_JOB_HEARTBEAT_MS)
		heartbeatTimer.unref?.()

		const commitBatch = async <T>(
			stage: string,
			fn: (session: ClientSession) => Promise<T>,
			validateEvent = true,
		): Promise<T> => {
			heartbeat()
			await heartbeatInFlight
			if (leaseFailure) {
				throw leaseFailure
			}
			const usage = bufferedEffects.llmUsage.slice()
			const accounting = bufferedEffects.operationAccounting.slice()
			const value = await withClaimedMemoryJobEffectBatch({
				db: this.host.db,
				prefix: this.host.prefix,
				token: admissionToken,
				jobId: job.jobId,
				agentId: this.host.agentId,
				leaseOwner: job.leaseOwner,
				leaseToken: job.leaseToken,
				fn: async (session) => {
					if (validateEvent) {
						if (!eventSnapshot) {
							throw new Error(
								`event snapshot missing before ${stage}: ${eventId}`,
							)
						}
						const currentEvent = await eventsCollection(
							this.host.db,
							this.host.prefix,
						).findOne(
							{
								eventId,
								agentId: eventSnapshot.agentId,
								role: eventSnapshot.role,
								body: eventSnapshot.body,
								timestamp: eventSnapshot.timestamp,
								scope: eventSnapshot.scope,
								scopeRef: eventSnapshot.scopeRef,
								...(eventSnapshot.sessionId
									? { sessionId: eventSnapshot.sessionId }
									: { sessionId: { $exists: false } }),
								...buildEventLifecycleClause(),
							},
							{ session, projection: { _id: 1 } },
						)
						if (!currentEvent) {
							throw new Error(
								`event changed before ${stage}: ${eventSnapshot.eventId}`,
							)
						}
					}
					const result = await fn(session)
					for (const spend of usage) {
						await recordLLMSpendInSession({
							db: this.host.db,
							prefix: this.host.prefix,
							agentId: this.host.agentId,
							spend,
							at: spend.at,
							session,
						})
					}
					return result
				},
			})
			bufferedEffects.llmUsage.splice(0, usage.length)
			bufferedEffects.operationAccounting.splice(0, accounting.length)
			if (runContext) {
				applyOperationAccountingEffects(runContext, accounting)
			}
			return value
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
				...buildEventLifecycleClause(),
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
			eventSnapshot = eventDoc
			await commitBatch("entity extraction", async (session) => {
				const extracted = await extractAndUpsertEntities({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					eventContent: eventDoc.body,
					scope: eventDoc.scope,
					scopeRef: eventDoc.scopeRef,
					sourceEventId: eventDoc.eventId,
					role: eventDoc.role,
					session,
					recordRun: false,
				})
				if (extracted.entities.length > 0) {
					await markLaneAvailable({
						db: this.host.db,
						prefix: this.host.prefix,
						agentId: this.host.agentId,
						lane: "graph",
						session,
					})
				}
				const durationMs = extracted.diagnostics?.durationMs ?? 0
				await recordProjectionRun({
					db: this.host.db,
					prefix: this.host.prefix,
					session,
					run: {
						agentId: this.host.agentId,
						projectionType: "entities",
						status: "ok",
						itemsProjected: extracted.entities.length,
						durationMs,
					},
				})
				await recordProjectionRun({
					db: this.host.db,
					prefix: this.host.prefix,
					session,
					run: {
						agentId: this.host.agentId,
						projectionType: "relations",
						status: "ok",
						itemsProjected: extracted.relationsCreated,
						durationMs,
					},
				})
				return extracted
			})

			// LLM fact extraction (issue #30): degrade to regex-only when the
			// provider is unconfigured or misconfigured. B1: an explicit
			// MEMONGO_EXTRACTION_LLM=off forces the same regex-only path with
			// zero provider calls (the B20 ablation switch), without touching
			// the enrichment env the benchmark answerer may share.
			let enrichmentProvider: EnrichmentProvider | null = null
			try {
				const resolved = isExtractionLlmDisabled(process.env)
					? null
					: resolveEnrichmentProvider(process.env)
				// C-017: every production extraction call lands in the per-tenant
				// per-day cost ledger (tokens from the transport usage block).
				enrichmentProvider = resolved
					? instrumentProviderCostSpend({
							db: this.host.db,
							prefix: this.host.prefix,
							agentId: this.host.agentId,
							provider: resolved,
							onUsage: (usage) => bufferedEffects.llmUsage.push(usage),
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
							onEffect: (effect) =>
								bufferedEffects.operationAccounting.push(effect),
						})
					: enrichmentProvider
			const temporalProvider =
				enrichmentProvider && runContext
					? instrumentOperationProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "temporal-extraction",
							model: enrichmentModel,
							onEffect: (effect) =>
								bufferedEffects.operationAccounting.push(effect),
						})
					: enrichmentProvider
			const contradictionProvider =
				enrichmentProvider && runContext
					? instrumentOperationProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "contradiction-detection",
							model: enrichmentModel,
							onEffect: (effect) =>
								bufferedEffects.operationAccounting.push(effect),
						})
					: enrichmentProvider

			const event = {
				...eventDoc,
				workspaceDir: this.host.workspaceDir,
			}
			const preparedPromotion = await prepareDerivedMemoryPromotion({
				db: this.host.db,
				prefix: this.host.prefix,
				event,
				provider: structuredProvider,
				temporalProvider,
				model: enrichmentModel,
				...(prefetchedLlmFacts ? { prefetchedLlmFacts } : {}),
			})
			const result = await commitBatch("derived-memory promotion", (session) =>
				promoteDerivedMemoryFromEvent({
					db: this.host.db,
					prefix: this.host.prefix,
					session,
					embeddingMode: this.host.config.mongodb?.embeddingMode ?? "automated",
					event,
					prepared: preparedPromotion,
					skipContradictions: true,
					// Pass the instrumented providers so provider usage inside
					// the promotion (when `prepared` does not already cover it)
					// is attributed to the originating run's accounting. With
					// `prepared` supplied the real path never re-extracts, so
					// this is instrumentation wiring, not a second LLM call.
					provider: structuredProvider,
					temporalProvider,
					contradictionProvider,
					model: enrichmentModel,
				}),
			)

			if (contradictionProvider) {
				const preparedContradictions = await prepareContradictionInvalidations({
					db: this.host.db,
					prefix: this.host.prefix,
					provider: contradictionProvider,
					model: enrichmentModel,
					requirePersistedSource: true,
					agentId: this.host.agentId,
					scope: eventDoc.scope,
					scopeRef: eventDoc.scopeRef,
					newFacts: preparedPromotion.structuredCandidates
						.filter((candidate) => candidate.type === "fact")
						.map((candidate) => ({
							key: candidate.key,
							value: candidate.value,
						})),
				})
				await commitBatch("contradiction invalidation", (session) =>
					persistPreparedContradictionInvalidations({
						db: this.host.db,
						prefix: this.host.prefix,
						session,
						agentId: this.host.agentId,
						scope: eventDoc.scope,
						scopeRef: eventDoc.scopeRef,
						prepared: preparedContradictions,
						runId: eventDoc.eventId,
					}),
				)
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
						const relationProvider = runContext
							? instrumentOperationProvider({
									provider: enrichmentProvider,
									runContext,
									operation: "relation-extraction",
									model: enrichmentModel,
									onEffect: (effect) =>
										bufferedEffects.operationAccounting.push(effect),
								})
							: enrichmentProvider
						const preparedRelations = await prepareTypedRelations({
							provider: relationProvider,
							model: enrichmentModel,
							eventContent: eventDoc.body,
							entities: eventEntities,
						})
						await commitBatch("typed relation persistence", async (session) => {
							const relationsCreated = await extractAndUpsertTypedRelations({
								db: this.host.db,
								prefix: this.host.prefix,
								session,
								agentId: this.host.agentId,
								scope: eventDoc.scope,
								scopeRef: eventDoc.scopeRef,
								eventContent: eventDoc.body,
								entities: eventEntities,
								model: enrichmentModel,
								preparedRelations,
								sourceEventId: eventDoc.eventId,
								validFrom: eventDoc.timestamp,
							})
							await recordProjectionRun({
								db: this.host.db,
								prefix: this.host.prefix,
								session,
								run: {
									agentId: this.host.agentId,
									projectionType: "relations",
									status: "ok",
									itemsProjected: relationsCreated,
									durationMs: 0,
								},
							})
							return relationsCreated
						})
					}
				} catch (err) {
					// C3: no silent success. Record the failed pass in the
					// projection ledger, then rethrow so the runner's outer catch
					// routes the error through failClaimedMemoryJob — the job
					// retries via the existing mechanism instead of completing
					// with the relations silently lost.
					await commitBatch("typed relation failure", (session) =>
						recordProjectionRun({
							db: this.host.db,
							prefix: this.host.prefix,
							session,
							run: {
								agentId: this.host.agentId,
								projectionType: "relations",
								status: "failed",
								itemsProjected: 0,
								durationMs: 0,
							},
						}),
					)
					throw err
				}
			}

			try {
				const completed = await commitBatch("job completion", (session) =>
					completeClaimedMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						session,
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
					}),
				)
				if (!completed) {
					log.warn(`extraction job lease lost before completion: ${job.jobId}`)
				}
			} catch (err) {
				log.warn(
					`completeClaimedMemoryJob failed for ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		} catch (err) {
			if (
				isMemoryJobOwnershipLostError(err) ||
				isErasureGateConflictError(err)
			) {
				log.warn(
					`extraction job ownership lost before a guarded effect commit: ${job.jobId}`,
				)
				return
			}
			// Non-retryable provider failure class (lead decision): a policy
			// refusal, content filter, or token-budget truncation fails
			// identically on every retry, so the job dead-letters on FIRST
			// failure with its truthful attempt count (failClaimedMemoryJob
			// `terminal` — no retryAt, deadLetterAt, attempts preserved).
			// Everything else (transient empties, parse errors, HTTP errors)
			// keeps the bounded retry ladder.
			const terminalFailure =
				err instanceof EnrichmentResponseError &&
				(err.shape === "refusal" ||
					err.shape === "content-filter" ||
					err.shape === "length")
			try {
				await commitBatch(
					"job failure",
					(session) =>
						failClaimedMemoryJob({
							db: this.host.db,
							prefix: this.host.prefix,
							session,
							jobId: job.jobId,
							agentId: this.host.agentId,
							leaseOwner: job.leaseOwner,
							leaseToken: job.leaseToken,
							completedAt: new Date(),
							durationMs: elapsedMsSince(startedAt),
							error: err instanceof Error ? err.message : String(err),
							metadata: { eventId },
							attempts: job.attempts,
							...(terminalFailure ? { terminal: true } : {}),
						}),
					false,
				)
			} catch (updateErr) {
				log.warn(
					`failClaimedMemoryJob failed for ${job.jobId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
				)
			}
		} finally {
			clearInterval(heartbeatTimer)
			await heartbeatInFlight
			// Benchmark attribution must survive job failure: a provider
			// error thrown mid-batch buffers its accounting effect but never
			// reaches a commitBatch flush (those only run on success). Apply
			// whatever is still buffered so a failed extraction is reported as
			// measured with its truthful failure count, not "not-run".
			if (runContext && bufferedEffects.operationAccounting.length > 0) {
				applyOperationAccountingEffects(
					runContext,
					bufferedEffects.operationAccounting.splice(0),
				)
			}
			this.host.memoryJobOperationContexts?.delete(job.jobId)
		}
	}

	async drainMemoryJobQueue(params?: {
		admission?: AdmissionToken
	}): Promise<void> {
		const extractionAdmission =
			params?.admission ??
			(await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			}))
		if (extractionAdmission.agentId !== this.host.agentId)
			throw new ErasureGateConflictError(this.host.agentId)
		const gate = await readErasureGate({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})
		if (
			!gate ||
			gate.state !== "open" ||
			gate.epoch !== extractionAdmission.epoch
		)
			throw new ErasureGateConflictError(this.host.agentId)
		const repaired = await this.host.repairExtractionOutbox({
			admission: extractionAdmission,
		})
		if (repaired.eventsFailed > 0) {
			log.warn(
				`extraction outbox repair left ${repaired.eventsFailed} event(s) pending retry`,
			)
		}
		try {
			await this.host.repairEventProjections({
				admission: extractionAdmission,
				singleBatch: true,
			})
		} catch (err) {
			if (isErasureGateConflictError(err)) throw err
			log.warn("worker chunk projection repair failed", settledFailureMeta(err))
		}
		// C-006: fingerprint retention enforcement rides the worker sweep —
		// the prune is hourly-gated inside the write ops, so an idle queue
		// pays one Date.now() comparison per drain and nothing else.
		await this.host
			.pruneIdempotencyFingerprints({
				admission: extractionAdmission,
			})
			.catch((err: unknown) => {
				if (isErasureGateConflictError(err)) throw err
				log.warn("worker fingerprint prune failed", settledFailureMeta(err))
				return { pruned: 0 }
			})
		await this.stageAutoConsolidationJob(extractionAdmission)
		// W18: bound the crash/lease-expiry loop. Running rows whose lease
		// expired with a spent attempt budget are no longer claimable; this
		// sweep transitions them to visible dead letters (once per round,
		// idempotent) instead of leaving them looping or stalled in running.
		const deadLetterAt = new Date()
		const deadLettered = await withFencedWrite({
			db: this.host.db,
			prefix: this.host.prefix,
			token: extractionAdmission,
			fn: (session) =>
				deadLetterExpiredMemoryJobs({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					now: deadLetterAt,
					session,
				}),
		}).catch((err: unknown) => {
			if (isErasureGateConflictError(err)) throw err
			log.warn(
				"expired-lease dead-letter sweep failed",
				settledFailureMeta(err),
			)
			return 0
		})
		if (deadLettered > 0) {
			log.warn(
				`dead-lettered ${deadLettered} lease-expired job(s) with a spent attempt budget`,
			)
		}
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
			void emitTelemetry(
				this.host.db,
				this.host.prefix,
				{
					meta: { agentId: this.host.agentId, operation: "memory-job-backlog" },
					durationMs: 0,
					ok: false,
					itemCount: backlogDepth,
					depth: backlogDepth,
					threshold: backlogThreshold,
				},
				{ admission: extractionAdmission },
			).catch(() => {
				log.warn("worker backlog telemetry emit failed")
			})
		}
		const concurrency = resolveDrainConcurrency({
			depth: backlogDepth,
			base: resolveMemoryJobWorkerConcurrency(),
			threshold: backlogThreshold,
		})
		while (!this.host.memoryJobWorkerStopped && extractionAdmission) {
			const jobs: ClaimedMemoryJob[] = []
			for (let claimed = 0; claimed < concurrency; claimed++) {
				const job = await claimMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					jobType: "extraction",
					workerId: this.host.memoryJobWorkerId,
					leaseMs: MEMORY_JOB_LEASE_MS,
					admissionEpoch: extractionAdmission.epoch,
				})
				if (!job) {
					break
				}
				// The storage helper preserves an older stored epoch and only
				// fills legacy missing values. Test doubles may omit that
				// returned field, so mirror the claimed default locally.
				job.admissionEpoch ??= extractionAdmission.epoch
				jobs.push(job)
			}
			if (jobs.length === 0) {
				break
			}
			// W18: heartbeat from claim until the runner takes over. The batched
			// session-fact prefetch can outlast the lease (its provider timeout
			// is configurable); renewing every claimed job's lease during it
			// keeps ownership instead of paying for the prefetch and losing the
			// claim to another worker. Cleared after the post-prefetch ownership
			// revalidation — each dispatched runner starts its own heartbeat.
			const prefetchHeartbeat = setInterval(() => {
				for (const job of jobs) {
					void renewMemoryJobLease({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId: job.jobId,
						agentId: this.host.agentId,
						leaseOwner: job.leaseOwner,
						leaseToken: job.leaseToken,
						leaseMs: MEMORY_JOB_LEASE_MS,
					}).catch((err: unknown) => {
						log.warn(
							`prefetch heartbeat failed for ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`,
						)
					})
				}
			}, MEMORY_JOB_HEARTBEAT_MS)
			prefetchHeartbeat.unref?.()
			let sessionFacts: PrefetchedFactsMap
			let stillOwned: boolean[]
			try {
				sessionFacts = (await this.host.prefetchExtractionSessionFacts(
					jobs,
				)) as PrefetchedFactsMap
				stillOwned = await Promise.all(
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
			} finally {
				clearInterval(prefetchHeartbeat)
			}
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
						eventId ? sessionFacts[PREFETCH_EFFECTS]?.get(eventId) : undefined,
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
	private async stageAutoConsolidationJob(
		admission: AdmissionToken,
	): Promise<void> {
		const intervalMs = resolveAutoConsolidationMs()
		if (intervalMs <= 0) {
			return
		}
		const windowIndex = Math.floor(Date.now() / intervalMs)
		if (windowIndex === this.lastAutoConsolidationWindow) {
			return
		}
		const jobId = `consolidation-auto-${this.host.agentId}-${windowIndex}`
		const createdAt = new Date()
		try {
			const job = {
				jobId,
				jobType: "consolidation" as const,
				agentId: this.host.agentId,
				status: "pending" as const,
				createdAt,
				admissionEpoch: admission.epoch,
				metadata: { auto: true, window: windowIndex },
			}
			await withFencedWrite({
				db: this.host.db,
				prefix: this.host.prefix,
				token: admission,
				fn: (session) =>
					createMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						session,
						job,
					}),
			})
		} catch (err) {
			if (isErasureGateConflictError(err)) throw err
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
	/**
	 * W05: restore a consolidation job's caller options from stored
	 * metadata. An explicit consolidate persists its params in metadata; a
	 * worker retry (a failed explicit row, or any claim of work that
	 * originated from an explicit run) must replay the ORIGINAL
	 * scope/options instead of silently defaulting to agent scope.
	 * Field-by-field validation — metadata is Record<string, unknown>.
	 */
	private static consolidationOptionsFromMetadata(
		metadata: Record<string, unknown> | undefined,
	): ConsolidationOptions | undefined {
		if (!metadata) {
			return undefined
		}
		const options: Record<string, unknown> = {}
		if (typeof metadata.maxEvents === "number") {
			options.maxEvents = metadata.maxEvents
		}
		if (typeof metadata.minCombinedScore === "number") {
			options.minCombinedScore = metadata.minCombinedScore
		}
		if (typeof metadata.resolveContradictions === "boolean") {
			options.resolveContradictions = metadata.resolveContradictions
		}
		if (typeof metadata.llmDedup === "boolean") {
			options.llmDedup = metadata.llmDedup
		}
		if (typeof metadata.scope === "string") {
			options.scope = metadata.scope as MemoryScope
		}
		if (typeof metadata.scopeRef === "string") {
			options.scopeRef = metadata.scopeRef
		}
		return Object.keys(options).length > 0
			? (options as ConsolidationOptions)
			: undefined
	}

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
			// W05: replay the ORIGINAL caller options (explicit consolidate
			// persists them in metadata) instead of defaulting to agent scope —
			// a retried scoped consolidation must stay scoped.
			const storedOptions =
				MongoDBManagerJobsOps.consolidationOptionsFromMetadata(job.metadata)
			const result = await consolidateMemory({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				...(storedOptions ? { options: storedOptions } : {}),
				...(job.admissionEpoch == null
					? {}
					: {
							admission: {
								kind: "admission" as const,
								agentId: job.agentId,
								epoch: job.admissionEpoch,
							},
						}),
			})
			const invalidatedScope = storedOptions?.scope ?? "agent"
			const invalidatedScopeRef =
				storedOptions?.scopeRef ??
				resolveScopeRef({
					scope: invalidatedScope,
					agentId: this.host.agentId,
					workspaceDir: this.host.workspaceDir,
				})
			await invalidateQueryCache({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				scope: invalidatedScope,
				scopeRef: invalidatedScopeRef,
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
					// No metadata override: the failed row keeps the caller's
					// options so a retry restores them.
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
		const facts = new Map<string, string[]>() as PrefetchedFactsMap
		Object.defineProperty(facts, PREFETCH_EFFECTS, {
			value: new Map<string, BufferedWorkerEffects>(),
		})
		if (jobs.length < 2) {
			return facts
		}
		let provider: EnrichmentProvider | null = null
		try {
			// B1: MEMONGO_EXTRACTION_LLM=off skips session-batched LLM
			// prefetch entirely (zero provider calls); the single-job path
			// above degrades the same way.
			const resolved = isExtractionLlmDisabled(process.env)
				? null
				: resolveEnrichmentProvider(process.env)
			provider = resolved
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
					...buildEventLifecycleClause(),
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
				if (!firstJob) {
					return
				}
				const effects = newBufferedWorkerEffects()
				facts[PREFETCH_EFFECTS]?.set(group[0].eventId, effects)
				const runContext = firstJob
					? this.host.memoryJobOperationContexts?.get(firstJob.jobId)
					: undefined
				const costProvider = instrumentProviderCostSpend({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
					provider,
					onUsage: (usage) => effects.llmUsage.push(usage),
				})
				const structuredProvider = runContext
					? instrumentOperationProvider({
							provider: costProvider,
							runContext,
							operation: "structured-extraction",
							model,
							onEffect: (effect) => effects.operationAccounting.push(effect),
						})
					: costProvider
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

	wakeMemoryJobWorker(
		admission?: AdmissionToken,
		generation = this.host.memoryJobWorkerGeneration ?? 0,
		expectedTimer?: NodeJS.Timeout,
	): void {
		if (
			this.host.closed ||
			this.host.memoryJobWorkerStopped ||
			generation !== (this.host.memoryJobWorkerGeneration ?? 0) ||
			(expectedTimer && expectedTimer !== this.host.memoryJobWorkerTimer)
		)
			return
		if (admission && admission.agentId !== this.host.agentId) return
		if (this.host.memoryJobWorkerActive) {
			const pending = this.pendingWake
			if (
				!pending ||
				pending.generation !== generation ||
				(admission &&
					(!pending.admission || admission.epoch >= pending.admission.epoch))
			)
				this.pendingWake = { admission, generation }
			this.host.memoryJobWakeRequested = true
			return
		}
		this.host.memoryJobWorkerActive = true
		this.host.memoryJobWakeRequested = false
		let selectedTimer = expectedTimer
		const isCurrent = () =>
			!this.host.closed &&
			!this.host.memoryJobWorkerStopped &&
			generation === (this.host.memoryJobWorkerGeneration ?? 0)
		const installInterval = () => {
			if (this.host.memoryJobWorkerTimer)
				clearInterval(this.host.memoryJobWorkerTimer)
			const token = admission
			const timer = setInterval(() => {
				this.host.wakeMemoryJobWorker(token, generation, timer)
			}, resolveMemoryJobSweepMs())
			timer.unref?.()
			this.host.memoryJobWorkerTimer = timer
			return timer
		}
		const run = async () => {
			try {
				admission ??= await captureAdmissionToken({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
				})
				const gate = await readErasureGate({
					db: this.host.db,
					prefix: this.host.prefix,
					agentId: this.host.agentId,
				})
				if (!gate || gate.state !== "open" || gate.epoch !== admission.epoch)
					throw new ErasureGateConflictError(this.host.agentId)
				if (!isCurrent()) return
				if (
					!this.host.memoryJobWorkerTimer ||
					this.workerAdmission?.epoch !== admission.epoch
				)
					selectedTimer = installInterval()
				else selectedTimer = this.host.memoryJobWorkerTimer
				this.workerAdmission = admission
				await this.host.drainMemoryJobQueue({ admission })
			} catch (error) {
				if (isErasureGateConflictError(error)) {
					if (
						isCurrent() &&
						selectedTimer &&
						selectedTimer === this.host.memoryJobWorkerTimer &&
						(!this.workerAdmission ||
							this.workerAdmission.epoch === admission?.epoch)
					) {
						clearInterval(selectedTimer)
						this.host.memoryJobWorkerTimer = null
						this.workerAdmission = undefined
					}
				} else {
					log.warn("memory job worker failed", settledFailureMeta(error))
					if (isCurrent() && !this.host.memoryJobWorkerTimer) installInterval()
				}
			}
		}
		this.host.memoryJobWorkerPromise = run().finally(() => {
			this.host.memoryJobWorkerActive = false
			const pending = this.pendingWake
			this.pendingWake = undefined
			this.host.memoryJobWakeRequested = false
			if (
				pending &&
				!this.host.closed &&
				!this.host.memoryJobWorkerStopped &&
				pending.generation === (this.host.memoryJobWorkerGeneration ?? 0)
			)
				this.host.wakeMemoryJobWorker(pending.admission, pending.generation)
		})
	}

	startMemoryJobWorker(
		admission?: AdmissionToken,
		generation = this.host.memoryJobWorkerGeneration ?? 0,
	): void {
		if (
			this.host.closed ||
			generation !== (this.host.memoryJobWorkerGeneration ?? 0)
		)
			return
		this.host.memoryJobWorkerStopped = false
		this.host.wakeMemoryJobWorker(admission, generation)
	}

	async stopMemoryJobWorker(): Promise<void> {
		this.host.memoryJobWorkerGeneration =
			(this.host.memoryJobWorkerGeneration ?? 0) + 1
		this.host.memoryJobWorkerStopped = true
		this.host.memoryJobWakeRequested = false
		this.pendingWake = undefined
		this.workerAdmission = undefined
		if (this.host.memoryJobWorkerTimer) {
			clearInterval(this.host.memoryJobWorkerTimer)
			this.host.memoryJobWorkerTimer = null
		}
		for (;;) {
			const promise = this.host.memoryJobWorkerPromise
			await promise
			if (promise === this.host.memoryJobWorkerPromise) return
		}
	}

	async scheduleBackgroundExtraction(
		eventId: string,
		tenant?: { scope?: MemoryScope; scopeRef?: string },
		runContext?: OperationRunContext,
		params?: { admission?: AdmissionToken; generation?: number },
	): Promise<{ jobId: string; scheduled: boolean }> {
		if (this.host.closed) {
			throw new Error(
				"MongoDBMemoryManager is closed; refusing to schedule extraction",
			)
		}
		const generation =
			params?.generation ?? this.host.memoryJobWorkerGeneration ?? 0
		const admission =
			params?.admission ??
			(await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			}))
		if (admission.agentId !== this.host.agentId)
			throw new ErasureGateConflictError(this.host.agentId)
		const gate = await readErasureGate({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})
		if (!gate || gate.state !== "open" || gate.epoch !== admission.epoch)
			throw new ErasureGateConflictError(this.host.agentId)
		const jobId = `extraction-${eventId}`
		const payload = {
			eventId,
			...(tenant?.scope !== undefined ? { scope: tenant.scope } : {}),
			...(tenant?.scopeRef !== undefined ? { scopeRef: tenant.scopeRef } : {}),
		}
		const createdAt = new Date(),
			metadata = { eventId }
		let scheduled = true
		try {
			await withFencedWrite({
				db: this.host.db,
				prefix: this.host.prefix,
				token: admission,
				fn: (session) =>
					createMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						session,
						job: {
							jobId,
							jobType: "extraction",
							agentId: this.host.agentId,
							status: "pending",
							createdAt,
							admissionEpoch: admission.epoch,
							metadata,
							payload,
						},
					}),
			})
		} catch (err) {
			if (!this.host.isDuplicateKeyError(err)) throw err
			scheduled = await withFencedWrite({
				db: this.host.db,
				prefix: this.host.prefix,
				token: admission,
				fn: async (session) => {
					const existing = await getMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId,
						agentId: this.host.agentId,
						session,
					})
					if (
						existing &&
						existing.admissionEpoch !== undefined &&
						(typeof existing.admissionEpoch !== "number" ||
							existing.admissionEpoch !== admission.epoch)
					)
						throw new ErasureGateConflictError(this.host.agentId)
					if (existing?.status === "failed")
						return retryFailedMemoryJob({
							db: this.host.db,
							prefix: this.host.prefix,
							jobId,
							agentId: this.host.agentId,
							payload,
							metadata,
							session,
							admissionEpoch: admission.epoch,
						})
					return (
						existing?.status === "pending" ||
						(existing?.status === "running" &&
							(existing.leaseExpiresAt === undefined ||
								existing.leaseExpiresAt.getTime() <= createdAt.getTime()))
					)
				},
			})
		}
		if (!scheduled) {
			this.host.memoryJobOperationContexts?.delete(jobId)
			return { jobId, scheduled: false }
		}
		if (runContext) {
			this.host.memoryJobOperationContexts ??= new Map<
				string,
				OperationRunContext
			>()
			this.host.memoryJobOperationContexts.set(jobId, runContext)
		}
		if (this.host.memoryJobWorkerStopped)
			this.host.startMemoryJobWorker(admission, generation)
		else this.host.wakeMemoryJobWorker(admission, generation)
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
		admission?: AdmissionToken
	}): Promise<void> {
		if (
			params.admission &&
			(params.admission.kind !== "admission" ||
				params.admission.agentId !== this.host.agentId)
		)
			throw new ErasureGateConflictError(this.host.agentId)
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
					...(params.admission ? { admission: params.admission } : {}),
				})
				// Update episodic lane coverage when an episode is materialized
				if (episodeResult.triggered) {
					const coverageParams = {
						db: this.host.db,
						prefix: this.host.prefix,
						agentId: this.host.agentId,
						increments: { episodic: 1 },
					}
					await (params.admission
						? withFencedWrite({
								db: this.host.db,
								prefix: this.host.prefix,
								token: params.admission,
								fn: (session) =>
									updateLaneCoverage({ ...coverageParams, session }),
							})
						: updateLaneCoverage(coverageParams)
					).catch((coverageErr) => {
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
