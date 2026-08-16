import { randomUUID } from "node:crypto"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { buildContextBundle as composeContextBundle } from "./mongodb-context-bundle.js"
import { expandSearchContext } from "./mongodb-context-expansion.js"
import { recallConversation as recallConversationCore } from "./mongodb-conversation-recall.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	createMemoryJob,
	getMemoryJob,
	listMemoryJobs,
	updateMemoryJob,
} from "./mongodb-memory-jobs.js"
import { scanNovelty } from "./mongodb-novelty.js"
import type {
	ProcedureEntry,
	ProcedureLifecyclePatch,
} from "./mongodb-procedures.js"
import { synthesizeProfile } from "./mongodb-profile.js"
import type { ProfileSynthesis } from "./mongodb-profile.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import {
	getRecallTrace,
	listRecallTraces,
	recordRecallTrace,
} from "./mongodb-recall-traces.js"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import {
	eventsCollection,
	isEventsVectorBitemporalPrefilterReady,
} from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { getActiveSources } from "./mongodb-search-ranking.js"
import { searchV2 } from "./mongodb-search-v2.js"
import type {
	StructuredMemoryEntry,
	StructuredMemoryLifecyclePatch,
} from "./mongodb-structured-memory.js"
import { annotateResultsWithTrust, summarizeTrust } from "./mongodb-trust.js"
import type {
	ConversationRecallRequest,
	ConversationRecallResponse,
	MemoryActiveSlate,
	MemoryActorRole,
	MemoryContextBundle,
	MemoryContextBundleRequest,
	MemoryDiscoveryProjection,
	MemoryDiscoveryProjectionRequest,
	MemoryFeedbackSignal,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	MemorySelfEditAction,
	MemorySelfEditBlock,
	MemoryStableHandle,
} from "./types.js"
import { createSubsystemLogger } from "@memongo/lib"
import type { MemoryScope } from "@memongo/lib"

/**
 * Lifecycle seam extracted from `mongodb-manager.ts` (P4.3): structured/procedure
 * lifecycle writes and patches, self-edit, profile/slate/projection/bundle
 * builders, conversation recall, reasoning-chain/novelty/consolidation
 * wrappers, recall traces, and memory-job listing behind the
 * `MongoDBManagerLifecycleOps` collaborator the facade delegates to.
 */

const log = createSubsystemLogger("memory:mongodb")

export class MongoDBManagerLifecycleOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	async writeStructuredMemory(
		entry: StructuredMemoryEntry,
	): Promise<{ upserted: boolean; id: string }> {
		const mongoCfg = this.host.config.mongodb!
		const { writeStructuredMemory: writeFn } = await import(
			"./mongodb-structured-memory.js"
		)
		return writeFn({
			db: this.host.db,
			prefix: this.host.prefix,
			entry: {
				...entry,
				workspaceDir: this.host.workspaceDir,
				// Default sourceAgent to user when caller does not supply one
				sourceAgent: entry.sourceAgent ?? {
					id: entry.agentId,
					name: "user",
				},
			},
			embeddingMode: mongoCfg.embeddingMode,
			client: this.host.client,
			// P4.4.1: session-scope TTL default (off unless explicitly enabled).
			ttl: mongoCfg.ttl,
		})
	}

	async writeProcedure(
		entry: ProcedureEntry,
	): Promise<{ upserted: boolean; id: string }> {
		const mongoCfg = this.host.config.mongodb!
		const { writeProcedure: writeFn } = await import("./mongodb-procedures.js")
		return writeFn({
			db: this.host.db,
			prefix: this.host.prefix,
			entry: {
				...entry,
				workspaceDir: this.host.workspaceDir,
				// Default sourceAgent to user when caller does not supply one
				sourceAgent: entry.sourceAgent ?? {
					id: entry.agentId,
					name: "user",
				},
			},
			embeddingMode: mongoCfg.embeddingMode,
			client: this.host.client,
		})
	}

	async getLifecycleItem(
		handle: MemoryStableHandle,
	): Promise<MemoryLifecycleItem | null> {
		if (handle.family === "structured") {
			const { getStructuredMemoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return getStructuredMemoryByHandle({
				db: this.host.db,
				prefix: this.host.prefix,
				handle,
			})
		}
		const { getProcedureByHandle } = await import("./mongodb-procedures.js")
		return getProcedureByHandle({
			db: this.host.db,
			prefix: this.host.prefix,
			handle,
		})
	}

	async updateLifecycleItem(
		handle: MemoryStableHandle,
		patch: StructuredMemoryLifecyclePatch | ProcedureLifecyclePatch,
	): Promise<MemoryLifecycleItem | null> {
		const mongoCfg = this.host.config.mongodb!
		if (handle.family === "structured") {
			const { updateStructuredMemoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return updateStructuredMemoryByHandle({
				db: this.host.db,
				prefix: this.host.prefix,
				handle,
				patch: patch as StructuredMemoryLifecyclePatch,
				embeddingMode: mongoCfg.embeddingMode,
				client: this.host.client,
			})
		}
		const { updateProcedureByHandle } = await import("./mongodb-procedures.js")
		return updateProcedureByHandle({
			db: this.host.db,
			prefix: this.host.prefix,
			handle,
			patch: patch as ProcedureLifecyclePatch,
			embeddingMode: mongoCfg.embeddingMode,
			client: this.host.client,
		})
	}

	async invalidateLifecycleItem(
		handle: MemoryStableHandle,
		invalidatedBy?: Record<string, unknown>,
	): Promise<MemoryLifecycleItem | null> {
		if (handle.family === "structured") {
			const { invalidateStructuredMemoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return invalidateStructuredMemoryByHandle({
				db: this.host.db,
				prefix: this.host.prefix,
				handle,
				...(invalidatedBy ? { invalidatedBy } : {}),
				client: this.host.client,
			})
		}
		const { invalidateProcedureByHandle } = await import(
			"./mongodb-procedures.js"
		)
		return invalidateProcedureByHandle({
			db: this.host.db,
			prefix: this.host.prefix,
			handle,
			...(invalidatedBy ? { invalidatedBy } : {}),
			client: this.host.client,
		})
	}

	async getLifecycleHistory(params: {
		handle: MemoryStableHandle
		limit?: number
	}): Promise<MemoryLifecycleHistoryEntry[]> {
		if (params.handle.family === "structured") {
			const { getStructuredMemoryHistoryByHandle } = await import(
				"./mongodb-structured-memory.js"
			)
			return getStructuredMemoryHistoryByHandle({
				db: this.host.db,
				prefix: this.host.prefix,
				handle: params.handle,
				limit: params.limit,
			}) as Promise<MemoryLifecycleHistoryEntry[]>
		}
		const { getProcedureHistoryByHandle } = await import(
			"./mongodb-procedures.js"
		)
		return getProcedureHistoryByHandle({
			db: this.host.db,
			prefix: this.host.prefix,
			handle: params.handle,
			limit: params.limit,
		}) as Promise<MemoryLifecycleHistoryEntry[]>
	}

	async reportProcedureOutcome(params: {
		handle: Extract<MemoryStableHandle, { family: "procedure" }>
		success: boolean
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
		const { reportProcedureOutcomeByHandle } = await import(
			"./mongodb-procedures.js"
		)
		const result = await reportProcedureOutcomeByHandle({
			db: this.host.db,
			prefix: this.host.prefix,
			handle: params.handle,
			success: params.success,
			note: params.note,
			actorRole: params.actorRole,
		})
		if (result) {
			await invalidateQueryCache({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: params.handle.agentId,
				scope: params.handle.scope,
				scopeRef: params.handle.scopeRef,
			})
		}
		return result
	}

	async applyMemoryFeedback(params: {
		handle: Extract<MemoryStableHandle, { family: "structured" }>
		signal: MemoryFeedbackSignal
		patch?: StructuredMemoryLifecyclePatch
		invalidatedBy?: Record<string, unknown>
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
		const mongoCfg = this.host.config.mongodb!
		const { applyStructuredMemoryFeedbackByHandle } = await import(
			"./mongodb-structured-memory.js"
		)
		const result = await applyStructuredMemoryFeedbackByHandle({
			db: this.host.db,
			prefix: this.host.prefix,
			handle: params.handle,
			signal: params.signal,
			patch: params.patch,
			invalidatedBy: params.invalidatedBy,
			note: params.note,
			embeddingMode: mongoCfg.embeddingMode,
			client: this.host.client,
			actorRole: params.actorRole,
		})
		if (result) {
			await invalidateQueryCache({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: params.handle.agentId,
				scope: params.handle.scope,
				scopeRef: params.handle.scopeRef,
			})
		}
		return result
	}

	async selfEditBlock(params: {
		block: MemorySelfEditBlock
		action: MemorySelfEditAction
		content: string
	}): Promise<{ upserted: boolean; id: string }> {
		const mongoCfg = this.host.config.mongodb!
		const { selfEditBlock: editFn } = await import("./mongodb-self-edit.js")
		return editFn({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			embeddingMode: mongoCfg.embeddingMode,
			client: this.host.client,
			block: params.block,
			action: params.action,
			content: params.content,
		})
	}

	async synthesizeProfile(
		params: {
			scope?: MemoryScope
			scopeRef?: string
			maxPerType?: number
			maxEntities?: number
			maxEpisodes?: number
			activityWindowMs?: number
		} = {},
	): Promise<ProfileSynthesis> {
		return synthesizeProfile({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			scope: params.scope ?? "agent",
			scopeRef: params.scopeRef ?? this.host.agentScopeRef,
			maxPerType: params.maxPerType,
			maxEntities: params.maxEntities,
			maxEpisodes: params.maxEpisodes,
			activityWindowMs: params.activityWindowMs,
		})
	}

	async hydrateActiveSlate(
		params: { scope?: MemoryScope; scopeRef?: string; maxItems?: number } = {},
	): Promise<MemoryActiveSlate> {
		return hydrateActiveSlate({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			scope: params.scope ?? "agent",
			scopeRef: params.scopeRef ?? this.host.agentScopeRef,
			maxItems: params.maxItems,
		})
	}

	async buildDiscoveryProjection(
		request: MemoryDiscoveryProjectionRequest,
	): Promise<MemoryDiscoveryProjection> {
		return buildDiscoveryProjection({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			kind: request.kind,
			query: request.query,
			scope: request.scope ?? "agent",
			scopeRef: request.scopeRef ?? this.host.agentScopeRef,
			maxItems: request.maxItems,
			timeRange: request.timeRange,
		})
	}

	async buildContextBundle(
		request: MemoryContextBundleRequest = {},
	): Promise<MemoryContextBundle> {
		const scope = request.scope ?? "agent"
		const scopeRef =
			request.scopeRef ??
			resolveScopeRef({
				scope,
				agentId: this.host.agentId,
				sessionId: request.sessionId,
				workspaceDir: this.host.workspaceDir,
			})
		const mongoCfg = this.host.config.mongodb!
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const availablePaths = this.host.buildV2AvailablePaths(activeSources)
		const startedAt = Date.now()
		let bundleSearchTrace:
			| {
					pathsExecuted: string[]
					hitsByLane: Record<string, number>
					totalHits: number
			  }
			| undefined

		const bundle = await composeContextBundle({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			scope,
			scopeRef,
			request,
			search: async (params) => {
				const result = await searchV2(
					this.host.db,
					this.host.prefix,
					params.query,
					this.host.agentId,
					{
						availablePaths,
						hasEpisodes: mongoCfg.episodes.enabled,
						hasGraphData: mongoCfg.graph.enabled,
						maxResults: params.maxResults,
						searchOptions: {
							minScore: 0.1,
							numCandidates: mongoCfg.numCandidates,
							capabilities: this.host.capabilities,
							fusionMethod: mongoCfg.fusionMethod,
							embeddingMode: mongoCfg.embeddingMode,
							queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
							conversationEvidenceMode: mongoCfg.conversationEvidenceMode,
							graphMaxDepth: mongoCfg.graph.maxGraphDepth,
							conversationFilter: this.host.buildConversationChunkFilter({
								scope: params.scope,
								scopeRef: params.scopeRef,
							}),
							bridgeFilter: this.host.buildScopeAwareBridgeChunkFilter(
								activeSources,
								{
									scope: params.scope,
									scopeRef: params.scopeRef,
								},
							),
							bridgeMaxResults: this.host.getBridgeChunkBudget(
								params.maxResults,
							),
							scope: params.scope,
							scopeRef: params.scopeRef,
							conversationScope:
								params.scope === "session" && params.sessionId
									? { sessionKey: params.sessionId }
									: undefined,
							rerankConfig: mongoCfg.reranking,
							queryRewriteConfig: mongoCfg.queryRewriting,
							budget: mongoCfg.searchBudget,
						},
					},
				)
				const expandedResults =
					params.scope === "session"
						? await expandSearchContext({
								db: this.host.db,
								prefix: this.host.prefix,
								agentId: this.host.agentId,
								scope: params.scope,
								scopeRef: params.scopeRef,
								results: result.results,
								maxResults: params.maxResults,
							})
						: result.results
				const trustedResults = annotateResultsWithTrust(expandedResults, {
					scope: params.scope,
					scopeRef: params.scopeRef,
					sessionKey: params.scope === "session" ? params.sessionId : undefined,
				})
				bundleSearchTrace = {
					pathsExecuted: result.metadata.pathsExecuted,
					hitsByLane: result.metadata.resultsByPath,
					totalHits: trustedResults.length,
				}
				return {
					results: trustedResults,
					pathsExecuted: result.metadata.pathsExecuted,
					trustSummary: summarizeTrust(trustedResults),
				}
			},
		})
		void recordRecallTrace({
			db: this.host.db,
			prefix: this.host.prefix,
			trace: {
				agentId: this.host.agentId,
				query: request.query?.trim() || "(context-bundle)",
				lanesUsed:
					bundleSearchTrace?.pathsExecuted ?? bundle.metadata.pathsExecuted,
				lanesSkipped: Array.from(availablePaths).filter(
					(path) =>
						!(
							bundleSearchTrace?.pathsExecuted ?? bundle.metadata.pathsExecuted
						).includes(path),
				),
				totalHits: bundleSearchTrace?.totalHits ?? 0,
				latencyMs: Date.now() - startedAt,
				hitsByLane: bundleSearchTrace?.hitsByLane ?? {},
				topHitIds: [],
				tokenBudgetUsed: bundle.metadata.estimatedTokensUsed,
				bundleMode: request.mode ?? "full",
			},
		}).catch((err) =>
			log.warn(`buildContextBundle recall trace write failed: ${String(err)}`),
		)
		return bundle
	}

	async recallConversation(
		request: Omit<ConversationRecallRequest, "agentId">,
	): Promise<ConversationRecallResponse> {
		const nativeBitemporalVectorPrefilter =
			await this.host.refreshNativeBitemporalVectorPrefilter()
		return recallConversationCore({
			db: this.host.db,
			prefix: this.host.prefix,
			request: {
				...request,
				agentId: this.host.agentId,
			},
			vectorIndexName: `${this.host.prefix}events_vector`,
			textIndexName: `${this.host.prefix}events_text`,
			queryEmbeddingModel:
				this.host.config?.mongodb?.queryEmbeddingModel ?? "voyage-4-large",
			capabilities: this.host.capabilities,
			nativeBitemporalVectorPrefilter,
		})
	}

	async refreshNativeBitemporalVectorPrefilter(): Promise<boolean> {
		const now = Date.now()
		if (!Number.isFinite(this.host.nativeBitemporalPrefilterCheckedAt)) {
			this.host.nativeBitemporalPrefilterCheckedAt = now
			return this.host.nativeBitemporalVectorPrefilter === true
		}
		if (now - this.host.nativeBitemporalPrefilterCheckedAt < 60_000) {
			return this.host.nativeBitemporalVectorPrefilter
		}
		this.host.nativeBitemporalPrefilterCheckedAt = now
		if (!this.host.capabilities.vectorSearch) {
			this.host.nativeBitemporalVectorPrefilter = false
			return false
		}
		try {
			const collection = eventsCollection(this.host.db, this.host.prefix)
			this.host.nativeBitemporalVectorPrefilter =
				await isEventsVectorBitemporalPrefilterReady(
					collection,
					`${this.host.prefix}events_vector`,
				)
			return this.host.nativeBitemporalVectorPrefilter
		} catch (err) {
			this.host.nativeBitemporalVectorPrefilter = false
			log.warn(
				`could not refresh native bitemporal prefilter readiness: ${String(err)}`,
			)
			return false
		}
	}

	async traceChain(params: {
		factId: string
		collection: string
		options?: { maxDepth?: number }
	}) {
		return traceReasoningChain({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			factId: params.factId,
			collection: params.collection,
			options: params.options,
		})
	}

	async scanNovelty(params?: {
		limit?: number
		scope?: string
		scopeRef?: string
	}) {
		return scanNovelty({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			options: params,
		})
	}

	async consolidate(params?: {
		maxEvents?: number
		minCombinedScore?: number
		resolveContradictions?: boolean
		llmDedup?: boolean
		scope?: MemoryScope
		scopeRef?: string
	}) {
		const startedAt = new Date()
		const runId = randomUUID()
		const jobId = `consolidation-${runId}`
		let jobTrackingEnabled = false
		try {
			await createMemoryJob({
				db: this.host.db,
				prefix: this.host.prefix,
				job: {
					jobId,
					jobType: "consolidation",
					agentId: this.host.agentId,
					status: "running",
					startedAt,
					metadata: params ? { ...params } : undefined,
				},
			})
			jobTrackingEnabled = true
		} catch (err) {
			log.warn(
				`createMemoryJob failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
		try {
			const result = await consolidateMemory({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				options: params,
			})
			const scope = params?.scope ?? "agent"
			const scopeRef =
				params?.scopeRef ??
				resolveScopeRef({
					scope,
					agentId: this.host.agentId,
					workspaceDir: this.host.workspaceDir,
				})
			await invalidateQueryCache({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				scope,
				scopeRef,
			})
			if (jobTrackingEnabled) {
				try {
					await updateMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId,
						agentId: this.host.agentId,
						status: "completed",
						completedAt: new Date(),
						durationMs: result.durationMs,
						inputCount: result.eventsProcessed,
						outputCount: result.factsPromoted,
						metadata: {
							...(params ? { ...params } : {}),
							runId: result.runId,
							factsPruned: result.factsPruned,
							conflictsResolved: result.conflictsResolved,
						},
					})
				} catch (err) {
					log.warn(
						`updateMemoryJob failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}
			return result
		} catch (err) {
			if (jobTrackingEnabled) {
				try {
					await updateMemoryJob({
						db: this.host.db,
						prefix: this.host.prefix,
						jobId,
						agentId: this.host.agentId,
						status: "failed",
						completedAt: new Date(),
						durationMs: Date.now() - startedAt.getTime(),
						error: err instanceof Error ? err.message : String(err),
						metadata: params ? { ...params } : undefined,
					})
				} catch (updateErr) {
					log.warn(
						`updateMemoryJob failed for ${jobId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
					)
				}
			}
			throw err
		}
	}

	async listRecallTraces(params?: { limit?: number }) {
		return listRecallTraces({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			limit: params?.limit,
		})
	}

	async getRecallTrace(params: { traceId: string }) {
		return getRecallTrace({
			db: this.host.db,
			prefix: this.host.prefix,
			traceId: params.traceId,
			agentId: this.host.agentId,
		})
	}

	async listMemoryJobs(params?: {
		status?: import("./types.js").MemoryJobStatus
		limit?: number
		jobType?: import("./types.js").MemoryJobType
	}) {
		return listMemoryJobs({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			status: params?.status,
			limit: params?.limit,
			jobType: params?.jobType,
		})
	}

	async getMemoryJob(params: { jobId: string }) {
		return getMemoryJob({
			db: this.host.db,
			prefix: this.host.prefix,
			jobId: params.jobId,
			agentId: this.host.agentId,
		})
	}
}
