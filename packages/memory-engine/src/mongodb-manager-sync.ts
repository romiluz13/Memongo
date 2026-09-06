import path from "node:path"
import chokidar from "chokidar"
import { isDuplicateKeyError } from "./internal.js"
import {
	clearEventExtractionJobPending,
	getPendingExtractionEvents,
	projectChunksFromEvents,
	projectEventChunk,
} from "./mongodb-events.js"
import { extractAndUpsertEntities } from "./mongodb-graph.js"
import {
	createMemoryJob,
	getMemoryJob,
	releaseStagedMemoryJob,
} from "./mongodb-memory-jobs.js"
import {
	chunksCollection,
	filesCollection,
	metaCollection,
} from "./mongodb-schema.js"
import { syncToMongoDB } from "./mongodb-sync.js"
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

export class MongoDBManagerSyncOps {
	constructor(private readonly host: MongoDBManagerHost) {}

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

	async repairEventProjections(): Promise<{
		eventsProcessed: number
		chunksCreated: number
	}> {
		const batchSize = 500
		let eventsProcessed = 0
		let chunksCreated = 0
		for (;;) {
			const batch = await projectChunksFromEvents({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				batchSize,
			})
			eventsProcessed += batch.eventsProcessed
			chunksCreated += batch.chunksCreated
			if (batch.eventsProcessed < batchSize) {
				return { eventsProcessed, chunksCreated }
			}
		}
	}

	async repairExtractionOutbox(params?: { limit?: number }): Promise<{
		eventsProcessed: number
		jobsCreated: number
		jobsReleased: number
		eventsFailed: number
	}> {
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
			try {
				const jobId = `extraction-${event.eventId}`
				let existing = await getMemoryJob({
					db: this.host.db,
					prefix: this.host.prefix,
					jobId,
					agentId: this.host.agentId,
				})
				let staged =
					existing?.status === "pending" && Boolean(existing.stagedAt)
				if (!existing) {
					try {
						await createMemoryJob({
							db: this.host.db,
							prefix: this.host.prefix,
							job: {
								jobId,
								jobType: "extraction",
								agentId: this.host.agentId,
								status: "pending",
								stagedAt: event.extractionJobPendingAt ?? new Date(),
								metadata: { eventId: event.eventId },
								payload: {
									eventId: event.eventId,
									scope: event.scope,
									scopeRef: event.scopeRef,
								},
							},
						})
						jobsCreated++
						staged = true
					} catch (err) {
						if (!this.host.isDuplicateKeyError(err)) {
							throw err
						}
						existing = await getMemoryJob({
							db: this.host.db,
							prefix: this.host.prefix,
							jobId,
							agentId: this.host.agentId,
						})
						if (!existing) {
							throw new Error(
								`duplicate extraction job is unreadable: ${jobId}`,
							)
						}
						staged = existing.status === "pending" && Boolean(existing.stagedAt)
					}
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
							// C-005: stored events carry the persisted expiry —
							// the chunk must inherit it (and re-projection heals
							// older chunks that were written without it).
							...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
							...(event.sessionId ? { sessionId: event.sessionId } : {}),
							...(event.metadata ? { metadata: event.metadata } : {}),
						},
					})
					if (projected.chunkCreated) {
						this.host.chunkCount += 1
					}
					try {
						await extractAndUpsertEntities({
							db: this.host.db,
							prefix: this.host.prefix,
							agentId: this.host.agentId,
							eventContent: event.body,
							scope: event.scope,
							scopeRef: event.scopeRef,
							sourceEventId: event.eventId,
							role: event.role,
						})
					} catch (err) {
						log.warn("entity extraction failed during outbox repair", {
							error: err instanceof Error ? err.message : String(err),
							eventId: event.eventId,
						})
					}

					const released = await releaseStagedMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId,
						agentId: this.host.agentId,
					})
					if (released) {
						jobsReleased++
					} else {
						existing = await getMemoryJob({
							db: this.host.db,
							prefix: this.host.prefix,
							jobId,
							agentId: this.host.agentId,
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
				}

				await clearEventExtractionJobPending({
					db: this.host.db,
					prefix: this.host.prefix,
					eventId: event.eventId,
					agentId: this.host.agentId,
				})
				eventsProcessed++
			} catch (err) {
				eventsFailed++
				log.warn(
					`extraction outbox repair failed for ${event.eventId}: ${String(err)}`,
				)
			}
		}

		return { eventsProcessed, jobsCreated, jobsReleased, eventsFailed }
	}

	async runSync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void> {
		const mongoCfg = this.host.config.mongodb!
		try {
			const result = await syncToMongoDB({
				client: this.host.client,
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
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
			_id: "kb_last_auto_refresh",
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
			})
			log.info(
				`KB auto-refresh complete: ${result.documentsProcessed} docs, ${result.chunksCreated} chunks, ${result.skipped} skipped`,
			)

			// Update last refresh timestamp
			await meta.updateOne(
				{ _id: "kb_last_auto_refresh" } as Record<string, unknown>,
				{ $set: { timestamp: new Date() } },
				{ upsert: true },
			)
		} catch (err) {
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
