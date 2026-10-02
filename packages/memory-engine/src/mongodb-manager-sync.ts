import path from "node:path"
import chokidar from "chokidar"
import {
	clearEventExtractionJobPending,
	getPendingExtractionEvents,
	getUnprojectedEvents,
	projectEventChunk,
	projectEventChunksBatch,
} from "./mongodb-events.js"
import { extractAndUpsertEntities } from "./mongodb-graph.js"
import {
	createMemoryJob,
	getMemoryJob,
	releaseStagedMemoryJob,
} from "./mongodb-memory-jobs.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import {
	chunksCollection,
	filesCollection,
	metaCollection,
} from "./mongodb-schema.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	ErasureGateConflictError,
	readErasureGate,
	isErasureGateConflictError,
	withFencedWrite,
} from "./mongodb-write-fence.js"
import type { MemorySyncProgressUpdate } from "./types.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb")

/**
 * Sync/watchers collaborator extracted from `mongodb-manager.ts` (P4.3
 * god-file split). The facade delegates `sync` and the startup repair/
 * watcher/token helpers called from `create()`; change-stream resume tokens
 * and KB auto-refresh live here too.
 */

const CHANGE_STREAM_RESUME_TOKEN_META_KEY = "change_stream_resume_token"

type RepairDiagnostics = {
	status: "ok" | "failed"
	durationMs: number
	chunkCreated: boolean
	entitiesExtracted: number
	relationsCreated: number
	extractionMethod: "regex" | "llm"
}

export class MongoDBManagerSyncOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	private async emitRepairDiagnostics(params: {
		admission: AdmissionToken
		eventId: string
		diagnostics: RepairDiagnostics
	}): Promise<void> {
		const { admission, eventId, diagnostics } = params
		try {
			await withFencedWrite({
				db: this.host.db,
				prefix: this.host.prefix,
				token: admission,
				fn: async (session) => {
					await recordProjectionRun({
						db: this.host.db,
						prefix: this.host.prefix,
						run: {
							agentId: this.host.agentId,
							projectionType: "chunks",
							status: diagnostics.status,
							itemsProjected: diagnostics.chunkCreated ? 1 : 0,
							durationMs: diagnostics.durationMs,
						},
						session,
					})
					await emitTelemetry(
						this.host.db,
						this.host.prefix,
						{
							meta: {
								agentId: this.host.agentId,
								operation: "entity-extraction",
							},
							durationMs: diagnostics.durationMs,
							ok: diagnostics.status === "ok",
							extractionMethod: diagnostics.extractionMethod,
							entitiesExtracted: diagnostics.entitiesExtracted,
						},
						{ session },
					)
					await recordProjectionRun({
						db: this.host.db,
						prefix: this.host.prefix,
						run: {
							agentId: this.host.agentId,
							projectionType: "entities",
							status: diagnostics.status,
							itemsProjected: diagnostics.entitiesExtracted,
							durationMs: diagnostics.durationMs,
						},
						session,
					})
					await recordProjectionRun({
						db: this.host.db,
						prefix: this.host.prefix,
						run: {
							agentId: this.host.agentId,
							projectionType: "relations",
							status: diagnostics.status,
							itemsProjected: diagnostics.relationsCreated,
							durationMs: diagnostics.durationMs,
						},
						session,
					})
				},
			})
		} catch {
			log.warn(
				`deferred extraction repair diagnostics were not recorded for ${eventId}`,
			)
		}
	}

	async sync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void> {
		if (this.host.closed) {
			return
		}
		if (this.host.syncing) {
			return this.host.syncing
		}
		this.host.syncing = this.host.runSync(params).finally(() => {
			this.host.syncing = null
		})
		return this.host.syncing
	}

	/**
	 * Fenced event-chunk projection repair (the startup T-R1/T-R2 path). One
	 * admission covers the whole pass; every snapshot stays OUTSIDE the
	 * fences, each batch projects inside withFencedWrite on the fence session
	 * with recordRun:false, and diagnostics record in separate best-effort
	 * fenced writes carrying the SAME token. Host counters advance only from
	 * committed primaries; a gate conflict propagates with no diagnostic
	 * attempt; any other failure records a fenced failed run with the
	 * original token before rethrowing.
	 */
	async repairEventProjections(params?: {
		admission?: AdmissionToken
		singleBatch?: boolean
	}): Promise<{
		eventsProcessed: number
		chunksCreated: number
	}> {
		const batchSize = 500
		const token =
			params?.admission ??
			(await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			}))
		if (params?.admission) {
			if (token.kind !== "admission" || token.agentId !== this.host.agentId)
				throw new ErasureGateConflictError(this.host.agentId)
			const gate = await readErasureGate({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			})
			if (!gate || gate.state !== "open" || gate.epoch !== token.epoch)
				throw new ErasureGateConflictError(this.host.agentId)
		}
		let eventsProcessed = 0
		let chunksCreated = 0
		for (;;) {
			// Snapshots stay outside the fences: the gate decides per batch,
			// and a short snapshot (< batchSize) ends the drain.
			const events = await getUnprojectedEvents({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				limit: batchSize,
			})
			if (events.length === 0) {
				return { eventsProcessed, chunksCreated }
			}
			const startMs = Date.now()
			let results: Array<{ chunkCreated: boolean }>
			try {
				results = await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token,
					fn: (session) =>
						projectEventChunksBatch({
							db: this.host.db,
							prefix: this.host.prefix,
							events,
							recordRun: false,
							session,
						}),
				})
			} catch (err) {
				if (isErasureGateConflictError(err)) {
					// The tenant's bytes are gone: refuse with no diagnostic
					// attempt and no counter movement.
					throw err
				}
				// Best-effort fenced failed-run record with the ORIGINAL
				// token; the failure itself then propagates.
				try {
					await withFencedWrite({
						db: this.host.db,
						prefix: this.host.prefix,
						token,
						fn: (session) =>
							recordProjectionRun({
								db: this.host.db,
								prefix: this.host.prefix,
								run: {
									agentId: this.host.agentId,
									projectionType: "chunks",
									status: "failed",
									itemsProjected: 0,
									durationMs: Date.now() - startMs,
								},
								session,
							}),
					})
				} catch (diagnosticErr) {
					log.warn(
						`projection repair failed-run record was not written: ${String(diagnosticErr)}`,
					)
				}
				throw err
			}
			eventsProcessed += events.length
			const committed = results.filter((result) => result.chunkCreated).length
			chunksCreated += committed
			this.host.chunkCount += committed
			// Diagnostics ride a separate fenced write AFTER the committed
			// primary; best-effort, they never fail the repair.
			try {
				await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token,
					fn: (session) =>
						recordProjectionRun({
							db: this.host.db,
							prefix: this.host.prefix,
							run: {
								agentId: this.host.agentId,
								projectionType: "chunks",
								status: "ok",
								itemsProjected: committed,
								durationMs: Date.now() - startMs,
							},
							session,
						}),
				})
			} catch (diagnosticErr) {
				log.warn(
					`projection repair diagnostics were not recorded: ${String(diagnosticErr)}`,
				)
			}
			if (params?.singleBatch || events.length < batchSize) {
				return { eventsProcessed, chunksCreated }
			}
		}
	}

	async repairExtractionOutbox(params?: {
		limit?: number
		admission?: AdmissionToken
	}): Promise<{
		eventsProcessed: number
		jobsCreated: number
		jobsReleased: number
		eventsFailed: number
	}> {
		// W8: one admission per write chain. A wake-triggered repair reuses
		// the calling write's admission (captured at the write boundary, so
		// strictly before this scan); a standalone repair pass captures its
		// own admission before scanning, per the W11 capture-before-scan rule.
		const admission =
			params?.admission ??
			(await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			}))
		const pendingEvents = await getPendingExtractionEvents({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			limit: params?.limit,
		})
		let eventsProcessed = 0
		let jobsCreated = 0
		let jobsReleased = 0
		let eventsFailed = 0

		for (const event of pendingEvents) {
			const eventStartMs = Date.now()
			try {
				const jobId = `extraction-${event.eventId}`
				const outcome = await withFencedWrite({
					db: this.host.db,
					prefix: this.host.prefix,
					token: admission,
					fn: async (session) => {
						let created = 0
						let released = 0
						let chunkCreated = false
						let diagnostics: RepairDiagnostics | undefined
						let existing = await getMemoryJob({
							db: this.host.db,
							prefix: this.host.prefix,
							jobId,
							agentId: this.host.agentId,
							session,
						})
						let staged =
							existing?.status === "pending" && Boolean(existing.stagedAt)
						if (!existing) {
							await createMemoryJob({
								db: this.host.db,
								prefix: this.host.prefix,
								job: {
									jobId,
									jobType: "extraction",
									agentId: this.host.agentId,
									status: "pending",
									stagedAt: event.extractionJobPendingAt ?? new Date(),
									admissionEpoch: admission.epoch,
									metadata: { eventId: event.eventId },
									payload: {
										eventId: event.eventId,
										scope: event.scope,
										scopeRef: event.scopeRef,
									},
								},
								session,
							})
							created = 1
							staged = true
						}

						if (staged) {
							const projected = await projectEventChunk({
								db: this.host.db,
								prefix: this.host.prefix,
								event: {
									eventId: event.eventId,
									agentId: event.agentId,
									role: event.role,
									body: event.body,
									scope: event.scope,
									scopeRef: event.scopeRef,
									timestamp: event.timestamp,
									validAt: event.validAt ?? event.timestamp,
									...(event.invalidAt ? { invalidAt: event.invalidAt } : {}),
									...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
									...(event.sessionId ? { sessionId: event.sessionId } : {}),
									...(event.metadata ? { metadata: event.metadata } : {}),
								},
								recordRun: false,
								session,
							})
							chunkCreated = projected.chunkCreated
							const graph = await extractAndUpsertEntities({
								db: this.host.db,
								prefix: this.host.prefix,
								agentId: this.host.agentId,
								eventContent: event.body,
								scope: event.scope,
								scopeRef: event.scopeRef,
								sourceEventId: event.eventId,
								role: event.role,
								recordRun: false,
								session,
							})

							const wasReleased = await releaseStagedMemoryJob({
								db: this.host.db,
								prefix: this.host.prefix,
								jobId,
								agentId: this.host.agentId,
								session,
							})
							if (wasReleased) {
								released = 1
							} else {
								existing = await getMemoryJob({
									db: this.host.db,
									prefix: this.host.prefix,
									jobId,
									agentId: this.host.agentId,
									session,
								})
								if (
									!existing ||
									(existing.status === "pending" && Boolean(existing.stagedAt))
								) {
									throw new Error(
										`failed to release staged extraction job: ${jobId}`,
									)
								}
							}
							diagnostics = {
								status: "ok",
								durationMs:
									graph.diagnostics?.durationMs ?? Date.now() - eventStartMs,
								chunkCreated,
								entitiesExtracted:
									graph.diagnostics?.entitiesExtracted ?? graph.entities.length,
								relationsCreated:
									graph.diagnostics?.relationsCreated ?? graph.relationsCreated,
								extractionMethod:
									graph.diagnostics?.extractionMethod ?? "regex",
							}
						}

						await clearEventExtractionJobPending({
							db: this.host.db,
							prefix: this.host.prefix,
							eventId: event.eventId,
							agentId: this.host.agentId,
							session,
						})
						return {
							jobsCreated: created,
							jobsReleased: released,
							chunkCreated,
							diagnostics,
						}
					},
				})
				jobsCreated += outcome.jobsCreated
				jobsReleased += outcome.jobsReleased
				if (outcome.chunkCreated) {
					this.host.chunkCount += 1
				}
				eventsProcessed++
				if (outcome.diagnostics) {
					await this.emitRepairDiagnostics({
						admission,
						eventId: event.eventId,
						diagnostics: outcome.diagnostics,
					})
				}
			} catch (err) {
				if (isErasureGateConflictError(err)) {
					throw err
				}
				eventsFailed++
				await this.emitRepairDiagnostics({
					admission,
					eventId: event.eventId,
					diagnostics: {
						status: "failed",
						durationMs: Date.now() - eventStartMs,
						chunkCreated: false,
						entitiesExtracted: 0,
						relationsCreated: 0,
						extractionMethod: "regex",
					},
				})
				log.warn(`extraction outbox repair failed for ${event.eventId}`)
			}
		}

		return { eventsProcessed, jobsCreated, jobsReleased, eventsFailed }
	}

	async runSync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void> {
		try {
			const admission = await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			})
			const mongoCfg = this.host.config.mongodb!
			const result = await syncToMongoDB({
				client: this.host.client,
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				admission,
				// Runtime conversation memory is event-native in MongoDB. Manager-level
				// sync only keeps bridge Markdown in sync and must not rebuild live
				// conversation memory from session transcript files.
				sessionMemoryEnabled: false,
				workspaceDir: this.host.workspaceDir,
				extraPaths: this.host.extraMemoryPaths,
				embeddingMode: mongoCfg.embeddingMode,
				reason: params?.reason,
				force: params?.force,
				maxSessionChunks: mongoCfg.maxSessionChunks,
				progress: params?.progress,
			})

			// Query actual totals from MongoDB (not just the delta from this sync)
			try {
				// W13: host.fileCount/chunkCount describe the TENANT, not the
				// shared deployment — count this agent's rows only.
				const tenantFilter = { agentId: this.host.agentId }
				this.host.fileCount = await filesCollection(
					this.host.db,
					this.host.prefix,
				).countDocuments(tenantFilter)
				this.host.chunkCount = await chunksCollection(
					this.host.db,
					this.host.prefix,
				).countDocuments(tenantFilter)
			} catch {
				// Fallback to delta counts if count query fails
				this.host.fileCount =
					result.filesProcessed + result.sessionFilesProcessed
				this.host.chunkCount =
					result.chunksUpserted + result.sessionChunksUpserted
			}

			// W14: only a fully-successful sync may clear the dirty flag. With
			// failed files or an incomplete source enumeration, chunks are
			// missing or unaccounted for — keep dirty set so the next sync
			// (watch trigger, restart, manual) re-runs instead of trusting a
			// clean state that was never reached.
			if (result.filesFailed === 0 && result.enumerationComplete) {
				this.host.dirty = false
			} else {
				log.warn(
					`sync finished dirty: filesFailed=${result.filesFailed} enumerationComplete=${result.enumerationComplete}; keeping dirty flag set`,
				)
			}
			log.info(
				`sync complete: processed=${result.filesProcessed}+${result.sessionFilesProcessed} ` +
					`chunks=${result.chunksUpserted}+${result.sessionChunksUpserted} ` +
					`totals=${this.host.fileCount} files, ${this.host.chunkCount} chunks`,
			)

			// KB auto-refresh: re-import autoImportPaths if autoRefreshHours has elapsed
			await this.host.maybeAutoRefreshKB()
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`sync failed: ${msg}`)
			throw err instanceof Error ? err : new Error(msg)
		}
	}

	async loadPersistedChangeStreamResumeToken(): Promise<unknown> {
		try {
			const meta = metaCollection(this.host.db, this.host.prefix)
			const doc = await meta.findOne({
				_id: CHANGE_STREAM_RESUME_TOKEN_META_KEY,
			} as Record<string, unknown>)
			if (!doc || !("token" in doc)) {
				return null
			}
			return (doc as Record<string, unknown>).token ?? null
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to load persisted change stream resume token: ${msg}`)
			return null
		}
	}

	async persistChangeStreamResumeToken(token: unknown): Promise<void> {
		try {
			const meta = metaCollection(this.host.db, this.host.prefix)
			await meta.updateOne(
				{ _id: CHANGE_STREAM_RESUME_TOKEN_META_KEY } as Record<string, unknown>,
				{ $set: { token, updatedAt: new Date() } },
				{ upsert: true },
			)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to persist change stream resume token: ${msg}`)
		}
	}

	async clearPersistedChangeStreamResumeToken(): Promise<void> {
		try {
			const meta = metaCollection(this.host.db, this.host.prefix)
			await meta.deleteOne({
				_id: CHANGE_STREAM_RESUME_TOKEN_META_KEY,
			} as Record<string, unknown>)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to clear stale change stream resume token: ${msg}`)
		}
	}

	async maybeAutoRefreshKB(): Promise<void> {
		const mongoCfg = this.host.config.mongodb!
		if (!mongoCfg.kb.enabled) {
			return
		}
		const autoRefreshHours = mongoCfg.kb.autoRefreshHours
		if (autoRefreshHours <= 0) {
			return
		}
		const paths = mongoCfg.kb.autoImportPaths
		if (paths.length === 0) {
			return
		}

		// Check last KB import time from meta collection
		const meta = metaCollection(this.host.db, this.host.prefix)
		const lastRefresh = await meta.findOne({
			_id: `kb_last_auto_refresh:${this.host.agentId}`,
		} as Record<string, unknown>)
		const lastRefreshTime =
			lastRefresh?.timestamp instanceof Date
				? lastRefresh.timestamp.getTime()
				: 0
		const hoursSinceRefresh = (Date.now() - lastRefreshTime) / (1000 * 60 * 60)

		if (hoursSinceRefresh < autoRefreshHours) {
			return
		}

		log.info(
			`KB auto-refresh: ${hoursSinceRefresh.toFixed(1)}h since last import, refreshing ${paths.length} paths`,
		)
		try {
			// S1 (plan e5ec10dc §4.1): capture once before any scan/read/CPU
			// work; the token threads through the ingest and the marker
			// fence so no effect of this attempt lands unfenced.
			const token = await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			})
			const { ingestFilesToKB } = await import("./mongodb-kb.js")
			const result = await ingestFilesToKB({
				db: this.host.db,
				prefix: this.host.prefix,
				scope: { agentId: this.host.agentId, scope: "agent" },
				paths,
				recursive: true,
				importedBy: "agent",
				embeddingMode: mongoCfg.embeddingMode,
				chunking: mongoCfg.kb.chunking,
				admission: token,
			})
			log.info(
				`KB auto-refresh complete: ${result.documentsProcessed} docs, ${result.chunksCreated} chunks, ${result.skipped} skipped`,
			)

			// Update last refresh timestamp inside the fence: a gate
			// conflict here means the marker must NOT land — the next
			// cycle re-attempts the whole refresh.
			await withFencedWrite({
				db: this.host.db,
				prefix: this.host.prefix,
				token,
				fn: async (session) => {
					await meta.updateOne(
						{
							_id: `kb_last_auto_refresh:${this.host.agentId}`,
						} as Record<string, unknown>,
						{ $set: { timestamp: new Date() } },
						{ upsert: true, session },
					)
				},
			})
		} catch (err) {
			if (isErasureGateConflictError(err)) {
				// Deferred, not failed: the attempt is retried whole on a
				// later cycle once the erasure completes.
				log.warn("KB auto-refresh deferred: tenant erasure in progress")
				return
			}
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB auto-refresh failed: ${msg}`)
		}
	}

	ensureWatcher(): void {
		if (this.host.watcher) {
			return
		}
		const mongoCfg = this.host.config.mongodb!
		const debounceMs = mongoCfg.watchDebounceMs
		const watchPaths = new Set<string>([
			path.join(this.host.workspaceDir, "memory"),
			...this.host.extraMemoryPaths,
		])
		const watcher = chokidar.watch(Array.from(watchPaths), {
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: debounceMs,
				pollInterval: 100,
			},
		})
		this.host.watcher = watcher
		const markDirty = () => {
			this.host.dirty = true
			this.host.scheduleWatchSync()
		}
		watcher.on("add", markDirty)
		watcher.on("change", markDirty)
		watcher.on("unlink", markDirty)
		watcher.on("error", (err) => {
			log.warn(`file watcher error: ${String(err)}`)
		})
	}

	scheduleWatchSync(): void {
		const mongoCfg = this.host.config.mongodb!
		if (this.host.watchTimer) {
			clearTimeout(this.host.watchTimer)
		}
		this.host.watchTimer = setTimeout(() => {
			this.host.watchTimer = null
			void this.host.sync({ reason: "watch" }).catch((err) => {
				log.warn(`memory sync failed (watch): ${String(err)}`)
			})
		}, mongoCfg.watchDebounceMs)
		// (P2.5 e) a pending watch debounce must not hold the process open.
		this.host.watchTimer.unref?.()
	}
}
