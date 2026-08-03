import path from "node:path"
import { instrumentBenchmarkProvider } from "./benchmark-parity-envelope.js"
import type { BenchmarkRunContext } from "./benchmark-parity-envelope.js"
import { isDuplicateKeyError } from "./internal.js"
import { isSharedMongoClientEnabled } from "./mongodb-client-registry.js"
import {
	heuristicEpisodeSummarizer,
	promoteDerivedMemoryFromEvent,
} from "./mongodb-derived-memory.js"
import { checkAutoEpisodeTriggers } from "./mongodb-episodes.js"
import {
	extractAndUpsertEntities,
	extractAndUpsertTypedRelations,
} from "./mongodb-graph.js"
import { updateLaneCoverage } from "./mongodb-lane-coverage.js"
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
import { eventsCollection, entitiesCollection } from "./mongodb-schema.js"
import type { ClaimedMemoryJob } from "./types.js"
import { createSubsystemLogger } from "@memongo/lib"
import type { MemoryScope } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb")

/**
 * Memory-job/worker seam extracted from `mongodb-manager.ts` (P4.3): worker
 * tuning constants and the `ManagerJobsOps` collaborator the facade
 * delegates to for background extraction scheduling, leases, and drains.
 */

export const MEMORY_JOB_LEASE_MS = 60_000
export const MEMORY_JOB_HEARTBEAT_MS = 20_000
const MEMORY_JOB_POLL_MS = 1_000

const MEMORY_JOB_SWEEP_DEFAULT_MS = 30_000

export function resolveMemoryJobSweepMs(): number {
	const raw = process.env.MEMONGO_JOB_SWEEP_MS?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed)
		}
	}
	return isSharedMongoClientEnabled()
		? MEMORY_JOB_SWEEP_DEFAULT_MS
		: MEMORY_JOB_POLL_MS
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
		if (this.host.benchmarkShippedProfile) {
			return true
		}
		const mode =
			process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE?.trim().toLowerCase()
		if (
			mode === "enabled" ||
			mode === "on" ||
			mode === "1" ||
			mode === "true"
		) {
			return true
		}
		const benchmarkAgent =
			this.host.agentId.startsWith("benchmark-") ||
			this.host.agentId.startsWith("canary-")
		if (
			mode === "disabled" ||
			mode === "off" ||
			mode === "none" ||
			mode === "0" ||
			mode === "false"
		) {
			return false
		}
		if (benchmarkAgent) {
			return false
		}
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
		const runContext = this.host.memoryJobRunContexts?.get(job.jobId)
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
		const leaseFence = async (stage: string): Promise<boolean> => {
			await heartbeatInFlight
			if (leaseLost) {
				log.warn(`extraction job lease lost before ${stage}: ${job.jobId}`)
			}
			return leaseLost
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
			await extractAndUpsertEntities({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				eventContent: eventDoc.body,
				scope: eventDoc.scope,
				scopeRef: eventDoc.scopeRef,
				sourceEventId: eventDoc.eventId,
				role: eventDoc.role,
			})

			// LLM fact extraction (issue #30): degrade to regex-only when the
			// provider is unconfigured or misconfigured.
			let enrichmentProvider: EnrichmentProvider | null = null
			try {
				enrichmentProvider = resolveEnrichmentProvider(process.env)
			} catch (err) {
				log.warn("enrichment provider resolution failed; using regex-only", {
					error: err instanceof Error ? err.message : String(err),
				})
			}
			const enrichmentModel = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
			const structuredProvider =
				enrichmentProvider && runContext
					? instrumentBenchmarkProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "structured-extraction",
							model: enrichmentModel,
						})
					: enrichmentProvider
			const temporalProvider =
				enrichmentProvider && runContext
					? instrumentBenchmarkProvider({
							provider: enrichmentProvider,
							runContext,
							operation: "temporal-extraction",
							model: enrichmentModel,
						})
					: enrichmentProvider
			const contradictionProvider =
				enrichmentProvider && runContext
					? instrumentBenchmarkProvider({
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
			// Read the entities already upserted synchronously for this event — do
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
							? instrumentBenchmarkProvider({
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
					durationMs: Date.now() - startedAt.getTime(),
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
					durationMs: Date.now() - startedAt.getTime(),
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
			this.host.memoryJobRunContexts?.delete(job.jobId)
		}
	}

	async drainMemoryJobQueue(): Promise<void> {
		const repaired = await this.host.repairExtractionOutbox()
		if (repaired.eventsFailed > 0) {
			log.warn(
				`extraction outbox repair left ${repaired.eventsFailed} event(s) pending retry`,
			)
		}
		// P3.9: claim up to K jobs per round and process them concurrently.
		// Claims stay sequential findOneAndUpdate CAS operations, so two
		// rounds/workers can never claim the same job; lease fencing inside
		// the job runner is per-job and unchanged (P2.5). Within a round, LLM
		// fact extraction is batched per session (one provider call for every
		// claimed event sharing a session, mirroring enrichSessionsWithLLM).
		const concurrency = resolveMemoryJobWorkerConcurrency()
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
				return
			}
			const sessionFacts = await this.host.prefetchExtractionSessionFacts(jobs)
			await Promise.all(
				jobs.map((job) => {
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
	}

	/**
	 * P3.9: batch the round's LLM fact extraction per session. One batched
	 * read fetches the claimed events; every group of 2+ events sharing a
	 * session gets ONE extractSessionEnrichment call whose facts are handed
	 * to each event's promotion (per-event events keep their own call inside
	 * the job runner). Purely read-only: a job that loses its lease mid-round
	 * is still fenced before any side effect — the prefetch only wastes an
	 * LLM call, never a write.
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
			provider = resolveEnrichmentProvider(process.env)
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
			const key = `${doc.scope}::${doc.scopeRef}::${doc.sessionId}`
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
					? this.host.memoryJobRunContexts?.get(firstJob.jobId)
					: undefined
				const structuredProvider = runContext
					? instrumentBenchmarkProvider({
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
						facts.set(doc.eventId, enrichment.facts)
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
		runContext?: BenchmarkRunContext,
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
					this.host.memoryJobRunContexts?.delete(jobId)
					return { jobId, scheduled: false }
				}
			} else {
				throw err
			}
		}

		if (runContext) {
			this.host.memoryJobRunContexts ??= new Map<string, BenchmarkRunContext>()
			this.host.memoryJobRunContexts.set(jobId, runContext)
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
		runContext?: BenchmarkRunContext
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
