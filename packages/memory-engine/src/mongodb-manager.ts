import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import {
	MongoClient,
	type ClientSession,
	type Collection,
	type Db,
	type Document,
	type MongoClientOptions,
} from "mongodb"
import {
	type MemongoConfig,
	type MemoryMongoDBFusionMethod,
	type MemoryScope,
	createSubsystemLogger,
	resolveUserPath,
} from "@memongo/lib"
import {
	AccessTracker,
	getAccessSummaries as listAccessSummaries,
	getAccessTrends as listAccessTrends,
} from "./mongodb-access-tracker.js"
import { resolveAgentWorkspaceDir } from "./agent-config.js"
import type {
	ResolvedMemoryBackendConfig,
	ResolvedMongoDBConfig,
} from "./backend-config.js"
import { resolveSearchDefaultScope } from "./backend-config.js"
import { isDuplicateKeyError, normalizeExtraMemoryPaths } from "./internal.js"
import { isSharedMongoClientEnabled } from "./mongodb-client-registry.js"
import { getMemoryStats, type MemoryStats } from "./mongodb-analytics.js"
import { MongoDBChangeStreamWatcher } from "./mongodb-change-stream.js"
import {
	heuristicEpisodeSummarizer,
	promoteDerivedMemoryFromEvent,
	extractStructuredCandidatesFromEvent,
	extractProcedureCandidatesFromEvent,
} from "./mongodb-derived-memory.js"
import { searchEpisodes } from "./mongodb-episodes.js"
import { checkAutoEpisodeTriggers } from "./mongodb-episodes.js"
import { recallConversation as recallConversationCore } from "./mongodb-conversation-recall.js"
import {
	importConversationDataset,
	resolveConversationDatasetPath,
} from "./mongodb-conversation-import.js"
import type { OperationRunContext } from "./mongodb-operation-accounting.js"
import {
	clearEventExtractionJobPending,
	clearEventExtractionJobPendingBatch,
	getPendingExtractionEvents,
	writeEvent,
	writeEventsBatch,
	projectChunksFromEvents,
	projectEventChunk,
	projectEventChunksBatch,
	getEventsByTimeRange,
	renderEventChunkText,
	IdempotencyConflictError,
	type CanonicalEvent,
} from "./mongodb-events.js"
import {
	extractAndUpsertEntities,
	extractAndUpsertTypedRelations,
	searchEntitiesAutocomplete,
	expandGraph,
	findRelationByLocatorId,
	type Entity,
	type RelationType,
} from "./mongodb-graph.js"
import {
	normalizeSearchResults,
	rrfScore,
	type SearchMethod,
} from "./mongodb-hybrid.js"
import { searchKB } from "./mongodb-kb-search.js"
import { updateLaneCoverage, getLaneCoverage } from "./mongodb-lane-coverage.js"
import {
	recordIngestRun,
	recordProjectionRun,
	getLatestIngestRun,
	getLatestProjectionRun,
	getProjectionLag,
	type IngestRun,
	type ProjectionRun,
} from "./mongodb-ops.js"
import {
	claimMemoryJob,
	completeClaimedMemoryJob,
	createMemoryJob,
	createMemoryJobsBatch,
	failClaimedMemoryJob,
	getMemoryJob,
	listMemoryJobs,
	releaseStagedMemoryJob,
	renewMemoryJobLease,
	retryFailedMemoryJob,
	updateMemoryJob,
} from "./mongodb-memory-jobs.js"
import {
	isTransactionUnsupported,
	MAJORITY_TRANSACTION_OPTIONS,
} from "./mongodb-transactions.js"
import {
	getRecallTrace,
	listRecallTraces,
	recordRecallTrace,
} from "./mongodb-recall-traces.js"
import type {
	ProcedureEntry,
	ProcedureLifecyclePatch,
	ProcedureState,
} from "./mongodb-procedures.js"
import {
	findExactProcedureMatches,
	searchProcedures,
} from "./mongodb-procedures.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { buildContextBundle as composeContextBundle } from "./mongodb-context-bundle.js"
import { synthesizeProfile, type ProfileSynthesis } from "./mongodb-profile.js"
import {
	checkCache,
	invalidateQueryCache,
	writeCache,
} from "./mongodb-query-cache.js"
import type { QueryCacheInvalidationCoalescer } from "./mongodb-query-cache-invalidation.js"
import { runSingleFlight } from "./mongodb-single-flight.js"
import {
	rewriteQuery,
	type QueryRewriteConfig,
} from "./mongodb-query-rewriter.js"
import {
	MongoDBRelevanceRuntime,
	type RelevanceArtifact,
	type RelevanceHealth,
	type RelevanceReport,
	type RelevanceSampleState,
	type RelevanceSourceScope,
} from "./mongodb-relevance.js"
import { applyPostRetrievalScoring } from "./mongodb-post-retrieval-scoring.js"
import {
	extractSessionIdFromCanonicalId,
	resolveSessionEvidenceMode,
	writeSessionEvidenceOptionA,
	writeSessionEvidenceOptionB,
	type SessionEvidenceMode,
} from "./mongodb-session-evidence.js"
import {
	isEvidenceMirrorEnabled,
	writeMemoryEvidenceDocuments,
} from "./mongodb-evidence-mirror.js"
import {
	resolveUserfactEvidenceMode,
	writeUserfactEvidence,
} from "./mongodb-userfact-evidence.js"
import {
	type EnrichmentProvider,
	resolveEnrichmentMode,
	resolveEnrichmentStrictMode,
	resolveEnrichmentProvider,
	enrichSessionsWithLLM,
	extractSessionEnrichment,
} from "./mongodb-llm-enrichment.js"
import {
	resolveDecompositionMode,
	decomposeQuery,
	mergeMultiQueryResults,
} from "./mongodb-query-decomposition.js"
import { crossEncoderRerank, type RerankConfig } from "./mongodb-reranker.js"
import {
	planRetrieval,
	type RetrievalPath,
	type RetrievalPlan,
	resolveTimeRangePreset,
} from "./mongodb-retrieval-planner.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	kbCollection,
	chunksCollection,
	detectCapabilities,
	ensureCollections,
	ensureSearchIndexes,
	ensureStandardIndexes,
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	episodesCollection,
	memoryEvidenceCollection,
	filesCollection,
	getExpectedSearchIndexTargets,
	isEventsVectorBitemporalPrefilterReady,
	isSearchIndexManagementAvailable,
	kbChunksCollection,
	metaCollection,
	proceduresCollection,
	queryCacheCollection,
	relevanceRunsCollection,
	resolveSearchIndexReadinessTiming,
	structuredMemCollection,
	waitForSearchIndexesQueryable,
	sessionChunksCollection,
} from "./mongodb-schema.js"
import { resolveScopeIdentity, resolveScopeRef } from "./mongodb-scope.js"
import {
	buildVectorSearchStage,
	MONGODB_MAX_NUM_CANDIDATES,
	mongoSearch,
	vectorSearch,
} from "./mongodb-search.js"
import {
	getSearchBudgetSnapshot,
	hasActiveSearchBudget,
	resolveSearchBudgetLimits,
	resolveUserSearchMaxTimeMs,
	runWithSearchBudget,
	type SearchBudgetLimits,
	type SearchBudgetSnapshot,
	tryConsumeSearchAggregation,
	tryConsumeSearchEmbed,
} from "./mongodb-search-budget.js"
import {
	applyCapabilityProbeResult,
	mongodbDeploymentIdentity,
} from "./mongodb-capability-registry.js"
import type {
	SearchExplainOptions,
	SearchExplainTraceArtifact,
	SearchTraceEvent,
} from "./mongodb-search.js"
import type {
	StructuredMemoryEntry,
	StructuredMemoryLifecyclePatch,
	StructuredMemorySalience,
	StructuredMemoryState,
} from "./mongodb-structured-memory.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { annotateResultsWithTrust, summarizeTrust } from "./mongodb-trust.js"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { scanNovelty } from "./mongodb-novelty.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { expandSearchContext } from "./mongodb-context-expansion.js"
import {
	applyHardConstraintRejections,
	applySearchConfig,
	buildConstraintSummaries,
	buildExecutorPasses,
	buildMemorySearchRequestSignature,
	classifyExecutorSearch,
	applyLaneAwareResultControls,
	computeEvidenceCoverage,
	executeMongoSearchPlan,
	normalizeMemorySearchRequest,
	resolveExecutorTimeRange,
	resolveProfileNumCandidates,
	resolveSearchConfig,
	requestHasHardConstraints,
} from "./mongodb-search-executor.js"
import type {
	ConversationRecallRequest,
	ConversationRecallResponse,
	MemoryActiveSlate,
	AccessEventCollection,
	MemoryContextBundle,
	MemoryContextBundleRequest,
	MemoryDiscoveryProjection,
	MemoryDiscoveryProjectionRequest,
	MemoryEmbeddingProbeResult,
	MemoryAccessSummary,
	MemoryAccessTrend,
	MemoryConversationImportResult,
	MemoryFeedbackSignal,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleItem,
	MemoryStableHandle,
	MemoryProviderStatus,
	MemorySearchManager,
	MemorySearchRequest,
	MemorySearchResponse,
	MemorySearchResult,
	MemorySearchMetadata,
	MemorySearchMode,
	MemorySource,
	MemorySelfEditBlock,
	MemorySelfEditAction,
	MemorySyncProgressUpdate,
	MemoryActorRole,
	ClaimedMemoryJob,
	ResolvedSearchConfig,
} from "./types.js"

// v2 validation constants
import {
	clampSearchMaxResults,
	deduplicateSearchResults,
	emptySearchMetadata,
	getActiveSources,
	getActiveSourcesForStatus,
	normalizeDetailedSearchRequest,
	rerankResults,
	resolveExplainSources,
	resolveRuntimeSearchConfig,
	shouldUseDetailedSearchCache,
	type ActiveSources,
	type RelevanceExplainResult,
} from "./mongodb-search-ranking.js"
import {
	MEMORY_JOB_HEARTBEAT_MS,
	MEMORY_JOB_LEASE_MS,
	resolveMemoryJobSweepMs,
	resolveMemoryJobWorkerConcurrency,
} from "./mongodb-manager-jobs.js"
import type {
	WriteConversationEventInput,
	WriteConversationEventReceipt,
} from "./mongodb-manager-write.js"
import {
	getAccessSummariesOrEmpty,
	getV2Status,
	type V2Status,
} from "./mongodb-manager-admin.js"
import { searchV2 } from "./mongodb-search-v2.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import {
	MongoDBManagerReadOps,
	type ManagerReadResult,
} from "./mongodb-manager-read.js"
import { MongoDBManagerAdminOps } from "./mongodb-manager-admin.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerSyncOps } from "./mongodb-manager-sync.js"
import { MongoDBManagerRelevanceOps } from "./mongodb-manager-relevance.js"
import { MongoDBManagerSearchOps } from "./mongodb-manager-search.js"

// ---------------------------------------------------------------------------
// P4.3 god-file split — re-exports
// Symbols below moved to seam modules; they keep their `./mongodb-manager.js`
// import contract so the package barrels and in-repo importers are unchanged.
// ---------------------------------------------------------------------------
export {
	MAX_SEARCH_MAX_RESULTS,
	applyRecencyAccessBoostAfterRerank,
	clampSearchMaxResults,
	deduplicateSearchResults,
	getActiveSources,
	getActiveSourcesForStatus,
	hasRelevanceCapability,
	hasWriteCapability,
	mergeRankedResultSets,
	rerankResults,
	resolveExplainSources,
	scorePreferenceGroundingSignalBoost,
	searchResultIdentityKey,
} from "./mongodb-search-ranking.js"
export type {
	RerankWeights,
	RelevanceExplainResult,
} from "./mongodb-search-ranking.js"
export { isConversationEvidenceQuery } from "./mongodb-search-temporal.js"
export { searchV2 } from "./mongodb-search-v2.js"
export type {
	SearchV2Context,
	V2SearchMetadata,
} from "./mongodb-search-v2.js"
export {
	resolveMemoryJobSweepMs,
	resolveMemoryJobWorkerConcurrency,
} from "./mongodb-manager-jobs.js"
export { writeEventAndProject } from "./mongodb-manager-write.js"
export type {
	WriteConversationEventInput,
	WriteConversationEventReceipt,
} from "./mongodb-manager-write.js"
export {
	classifyCanonicalIngestHealth,
	classifyProjectionHealth,
	classifyRetrievalHealth,
	computeOverallV2Health,
	getV2Status,
} from "./mongodb-manager-admin.js"
export type { V2Status } from "./mongodb-manager-admin.js"

const log = createSubsystemLogger("memory:mongodb")

function isStrictSearchReadinessMode(): boolean {
	return (
		process.env.MEMONGO_BENCHMARK_STRICT === "1" ||
		process.env.MEMONGO_STRICT_SEARCH_INDEX_READY === "1"
	)
}

function redactMongoURI(uri: string): string {
	try {
		const parsed = new URL(uri)
		if (parsed.password) {
			parsed.password = "***"
		}
		if (parsed.username) {
			parsed.username = parsed.username.slice(0, 2) + "***"
		}
		return parsed.toString()
	} catch {
		// If URL parsing fails, do a simple regex-based redaction
		return uri.replace(/\/\/([^:]+):([^@]+)@/, "//***:***@")
	}
}

// ---------------------------------------------------------------------------
// MongoDBMemoryManager — implements MemorySearchManager for MongoDB backend
// ---------------------------------------------------------------------------

/**
 * Core runtime coordinator for the Memongo engine.
 *
 * The file is intentionally large today because it still hosts several stable
 * subsystems in one place:
 * - request normalization and search entrypoints
 * - planner and legacy search orchestration
 * - canonical event writes and derived memory projection
 * - workspace/session sync and health/status reporting
 *
 * Cleanup work should preserve those behavior boundaries even when code is
 * extracted into smaller modules later.
 */
/**
 * Build MongoClient options from the resolved mongodb config. Shared by the
 * per-manager connect path and the shared-client registry (P2.1).
 */
export function buildMongoClientOptions(
	mongoCfg: ResolvedMongoDBConfig,
): MongoClientOptions {
	const clientOptions: MongoClientOptions = {
		serverSelectionTimeoutMS: mongoCfg.serverSelectionTimeoutMs,
		connectTimeoutMS: mongoCfg.connectTimeoutMs,
		maxPoolSize: mongoCfg.maxPoolSize,
		minPoolSize: mongoCfg.minPoolSize,
	}
	if (mongoCfg.maxConnecting !== undefined) {
		clientOptions.maxConnecting = mongoCfg.maxConnecting
	}
	if (mongoCfg.maxIdleTimeMs !== undefined) {
		clientOptions.maxIdleTimeMS = mongoCfg.maxIdleTimeMs
	}
	if (mongoCfg.networkFamily !== undefined) {
		clientOptions.family = mongoCfg.networkFamily
	}
	if (mongoCfg.socketTimeoutMs !== undefined) {
		clientOptions.socketTimeoutMS = mongoCfg.socketTimeoutMs
	}
	if (mongoCfg.heartbeatFrequencyMs !== undefined) {
		clientOptions.heartbeatFrequencyMS = mongoCfg.heartbeatFrequencyMs
	}
	if (mongoCfg.serverMonitoringMode !== undefined) {
		clientOptions.serverMonitoringMode = mongoCfg.serverMonitoringMode
	}
	if (mongoCfg.waitQueueTimeoutMs !== undefined) {
		clientOptions.waitQueueTimeoutMS = mongoCfg.waitQueueTimeoutMs
	}
	return clientOptions
}

/**
 * Memory-job worker backstop sweep interval. Writes wake the worker
 * immediately (wake-on-write); the interval only catches missed wakes.
 * With the shared-client runtime on (P2.1) the default drops from a 1s poll
 * to a 30s backstop so idle managers issue ~0 claim polls. Flag-off behavior
 * is unchanged. MEMONGO_JOB_SWEEP_MS overrides both.
 */
export class MongoDBMemoryManager implements MemorySearchManager {
	private readonly client: MongoClient
	private readonly db: Db
	private readonly prefix: string
	private readonly agentId: string
	private readonly workspaceDir: string
	private readonly agentScopeRef: string
	private readonly workspaceScopeRef: string
	private readonly extraMemoryPaths: string[]
	/**
	 * Serving capabilities detected at manager creation (B2a: public so the
	 * bridge can expose them to deploy targets without a type-guard cast;
	 * readonly — they are recomputed on construction, never mutated).
	 */
	readonly capabilities: DetectedCapabilities
	private nativeBitemporalVectorPrefilter: boolean
	private nativeBitemporalPrefilterCheckedAt = Date.now()
	private readonly config: ResolvedMemoryBackendConfig
	private syncing: Promise<void> | null = null
	private watcher: FSWatcher | null = null
	private watchTimer: NodeJS.Timeout | null = null
	private changeStreamWatcher: MongoDBChangeStreamWatcher | null = null
	/** Guards against a re-scan storm from rapid gapDetected events. */
	gapReSyncInFlight = false
	private relevance: MongoDBRelevanceRuntime | null = null
	/**
	 * P2.1: when the manager was built on a shared client (MEMONGO_SHARED_CLIENT),
	 * close() must not close the client — the process-level registry owns it.
	 */
	private readonly ownsClient: boolean
	/** Invoked once at the end of close() (used to release shared-client refs). */
	private readonly onClosed?: () => void
	private closed = false
	private dirty = true
	private fileCount = 0
	private chunkCount = 0
	private writeQueue: Promise<void> = Promise.resolve()
	private derivationSchedulingQueue: Promise<void> = Promise.resolve()
	private derivationQueue: Promise<void> = Promise.resolve()
	private readonly memoryJobWorkerId = `${process.pid}:${randomUUID()}`
	private memoryJobWorkerStopped = true
	private memoryJobWorkerActive = false
	private memoryJobWakeRequested = false
	private memoryJobWorkerPromise: Promise<void> = Promise.resolve()
	private memoryJobWorkerTimer: NodeJS.Timeout | null = null
	private memoryJobOperationContexts = new Map<string, OperationRunContext>()
	private lastSearchMode = "legacy"
	private lastSearchDetails: Record<string, unknown> | undefined
	private accessTracker: AccessTracker | null = null

	private constructor(params: {
		client: MongoClient
		db: Db
		prefix: string
		agentId: string
		workspaceDir: string
		extraMemoryPaths?: string[]
		capabilities: DetectedCapabilities
		nativeBitemporalVectorPrefilter: boolean
		config: ResolvedMemoryBackendConfig
		relevance?: MongoDBRelevanceRuntime | null
		ownsClient?: boolean
		onClosed?: () => void
	}) {
		this.client = params.client
		this.ownsClient = params.ownsClient ?? true
		this.onClosed = params.onClosed
		this.db = params.db
		this.prefix = params.prefix
		this.agentId = params.agentId
		this.workspaceDir = params.workspaceDir
		this.agentScopeRef = resolveScopeRef({
			scope: "agent",
			agentId: params.agentId,
		})
		this.workspaceScopeRef = resolveScopeRef({
			scope: "workspace",
			agentId: params.agentId,
			workspaceDir: params.workspaceDir,
		})
		this.extraMemoryPaths = params.extraMemoryPaths ?? []
		this.capabilities = params.capabilities
		this.nativeBitemporalVectorPrefilter =
			params.nativeBitemporalVectorPrefilter
		this.config = params.config
		this.relevance = params.relevance ?? null
	}

	// ---------------------------------------------------------------------------
	// Factory
	// ---------------------------------------------------------------------------

	static async create(params: {
		cfg: MemongoConfig
		agentId: string
		resolved: ResolvedMemoryBackendConfig
		extraPaths?: string[]
		/**
		 * P2.1: pre-connected shared MongoClient owned by the process-level
		 * registry (MEMONGO_SHARED_CLIENT). When provided, the manager skips
		 * connect and never closes the client.
		 */
		client?: MongoClient
		/** Invoked once when the manager finishes closing. */
		onClosed?: () => void
	}): Promise<MongoDBMemoryManager> {
		const mongoCfg = params.resolved.mongodb
		if (!mongoCfg) {
			throw new Error(
				"mongodb memory config missing from resolved backend config",
			)
		}

		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId)
		const safeUri = redactMongoURI(mongoCfg.uri)
		// B10: credential-free deployment identity (hosts + database + appName,
		// never userinfo) so capability probe outcomes are scoped to this
		// deployment only. Never log this key material.
		const capabilityDeployment = mongodbDeploymentIdentity(
			mongoCfg.uri,
			mongoCfg.database,
		)
		let client: MongoClient
		let ownsClient = true
		if (params.client) {
			log.info(
				`using shared MongoDB client: ${safeUri} (db=${mongoCfg.database})`,
			)
			client = params.client
			ownsClient = false
		} else {
			// Connect to MongoDB with a timeout to avoid hanging
			log.info(`connecting to MongoDB: ${safeUri} (db=${mongoCfg.database})`)
			client = new MongoClient(mongoCfg.uri, buildMongoClientOptions(mongoCfg))
			try {
				await client.connect()
				// Verify the connection actually works with a ping
				await client.db("admin").command({ ping: 1 })
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(`failed to connect to MongoDB (${safeUri}): ${msg}`)
				try {
					await client.close()
				} catch {
					// Ignore close errors during failed connect
				}
				throw new Error(`failed to connect to MongoDB (${safeUri}): ${msg}`)
			}
		}

		const db = client.db(mongoCfg.database)
		const prefix = mongoCfg.collectionPrefix

		// Ensure collections + schema validation + standard indexes
		await ensureCollections(db, prefix)

		const chunksCollectionName = chunksCollection(db, prefix).collectionName
		const searchIndexManagementAvailable =
			await isSearchIndexManagementAvailable(db, chunksCollectionName)

		await ensureStandardIndexes(db, prefix, {
			memoryTtlDays: mongoCfg.memoryTtlDays,
			relevanceRetentionDays: mongoCfg.relevance.retention.days,
			// P3.8: the BSON $text indexes are the no-mongot fallback — with
			// Search Index Management present the $search indexes serve every
			// text lane, so maintaining six $text duplicates is pure write
			// amplification.
			textFallbackIndexes: !searchIndexManagementAvailable,
		})

		// Detect concrete serving readiness. Fusion capability is server-version
		// based, while Search capabilities require named queryable indexes.
		let capabilities = await detectCapabilities(
			db,
			chunksCollectionName,
			capabilityDeployment,
		)
		log.info(`capabilities: ${JSON.stringify(capabilities)}`)
		let nativeBitemporalVectorPrefilter = false

		// Only bootstrap Search indexes when the deployment can talk to Search
		// Index Management at all. This keeps runtime startup responsive on
		// clusters that support fusion stages but do not expose mongot.
		if (searchIndexManagementAvailable) {
			const ensuredSearchIndexes = await ensureSearchIndexes(
				db,
				prefix,
				mongoCfg.deploymentProfile,
				mongoCfg.embeddingMode,
				mongoCfg.quantization,
				mongoCfg.numDimensions,
				capabilityDeployment,
			)
			// P3.2: the quantization-on-autoEmbed rejection is a probe outcome
			// recorded during index creation — fold it into the capabilities so
			// the search paths see the adopted gate state (detectCapabilities ran
			// before the probe was recorded).
			capabilities = {
				...capabilities,
				capabilityGates: applyCapabilityProbeResult(
					capabilities.capabilityGates ?? {},
					"autoembed-quantization",
					capabilityDeployment,
				),
			}
			if (ensuredSearchIndexes.text || ensuredSearchIndexes.vector) {
				const { timeoutMs: readinessTimeoutMs, pollMs: readinessPollMs } =
					resolveSearchIndexReadinessTiming()
				const readinessResults = await Promise.all(
					getExpectedSearchIndexTargets(prefix, mongoCfg.deploymentProfile).map(
						async (target) => {
							try {
								const readiness = await waitForSearchIndexesQueryable(
									db.collection(target.collectionName),
									{
										indexNames: target.indexNames,
										timeoutMs: readinessTimeoutMs,
										pollMs: readinessPollMs,
									},
								)
								return {
									collectionName: target.collectionName,
									...readiness,
								}
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err)
								return {
									collectionName: target.collectionName,
									ready: false,
									indexes: [],
									pending: target.indexNames,
									failed: [],
									lastError: message,
								}
							}
						},
					),
				)
				const stalled = readinessResults.filter((result) => !result.ready)
				const eventsVectorIndexes =
					readinessResults.find(
						(result) => result.collectionName === `${prefix}events`,
					)?.indexes ?? []
				try {
					nativeBitemporalVectorPrefilter =
						await isEventsVectorBitemporalPrefilterReady(
							eventsCollection(db, prefix),
							`${prefix}events_vector`,
							eventsVectorIndexes,
						)
					if (!nativeBitemporalVectorPrefilter) {
						log.warn(
							"native event bitemporal prefiltering remains disabled until the exact index definition and event representation are ready",
						)
					}
				} catch (err) {
					log.warn(
						`could not verify native event bitemporal prefilter readiness: ${String(err)}`,
					)
				}
				if (stalled.length > 0) {
					const summary = stalled
						.map((result) => {
							const pending = result.pending.join(",") || "none"
							const failed = result.failed.join(",") || "none"
							const lastError = result.lastError
								? ` lastError=${result.lastError}`
								: ""
							return `${result.collectionName} pending=[${pending}] failed=[${failed}]${lastError}`
						})
						.join("; ")
					const readinessMessage = `search indexes not fully queryable after bootstrap wait: ${summary}`
					if (isStrictSearchReadinessMode()) {
						throw new Error(readinessMessage)
					}
					log.warn(readinessMessage)
				}
				capabilities = await detectCapabilities(
					db,
					chunksCollectionName,
					capabilityDeployment,
				)
			}
		} else {
			log.info(
				"search index management unavailable; skipping search index bootstrap",
			)
		}
		if (
			isStrictSearchReadinessMode() &&
			(!capabilities.textSearch || !capabilities.vectorSearch)
		) {
			throw new Error(
				`MongoDB Search/vector capabilities are required in strict mode but named serving indexes are not queryable: ${JSON.stringify(capabilities)}`,
			)
		}
		if (
			isStrictSearchReadinessMode() &&
			capabilities.vectorSearch &&
			!nativeBitemporalVectorPrefilter
		) {
			throw new Error(
				"events vector index is not ready with validAt/invalidAt filters and null-compatible data",
			)
		}

		let relevance: MongoDBRelevanceRuntime | null = null
		try {
			if (mongoCfg.relevance.enabled) {
				relevance = new MongoDBRelevanceRuntime(
					db,
					prefix,
					params.agentId,
					mongoCfg,
					capabilities,
				)
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`relevance runtime initialization failed: ${msg}`)
		}

		const manager = new MongoDBMemoryManager({
			client,
			db,
			prefix,
			agentId: params.agentId,
			workspaceDir,
			extraMemoryPaths: normalizeExtraMemoryPaths(
				workspaceDir,
				params.extraPaths,
			),
			capabilities,
			nativeBitemporalVectorPrefilter,
			config: params.resolved,
			relevance,
			ownsClient,
			onClosed: params.onClosed,
		})

		// Phase 4.1 — the tracker now writes raw access events to the time-series
		// collection while keeping computed access summaries on canonical docs.
		manager.accessTracker = new AccessTracker(db, prefix, params.agentId, {
			flushThreshold: 50,
			flushIntervalMs: 5_000,
		})

		try {
			await manager.sync({ reason: "startup" })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`initial memory sync failed: ${msg}`)
		}
		try {
			const repaired = await manager.repairEventProjections()
			if (repaired.eventsProcessed > 0) {
				log.info(
					`repaired ${repaired.chunksCreated} chunks from ${repaired.eventsProcessed} canonical events during startup`,
				)
			}
		} catch (err) {
			log.warn(
				`startup projection repair failed; remaining canonical events will be retried on restart: ${String(err)}`,
			)
		}
		manager.startMemoryJobWorker()

		// Start watching bridge memory files for changes
		manager.ensureWatcher()

		// Opt-in: Change Streams for cross-instance sync (requires replica set)
		if (mongoCfg.enableChangeStreams) {
			const persistedResumeToken =
				await manager.loadPersistedChangeStreamResumeToken()
			const csWatcher = new MongoDBChangeStreamWatcher(
				chunksCollection(db, prefix),
				(event) => {
					if (event.gapDetected) {
						log.warn(
							`change stream gap detected (${event.gapDetected.from}); triggering full re-scan`,
						)
						// Debounce: dedupe concurrent gap-triggered syncs to avoid a
						// re-scan storm. If a sync is already in-flight, skip this one.
						if (!manager.gapReSyncInFlight) {
							manager.gapReSyncInFlight = true
							void manager
								.sync({ reason: "change-stream-gap" })
								.catch((err) => log.warn(`gap re-scan failed: ${String(err)}`))
								.finally(() => {
									manager.gapReSyncInFlight = false
								})
						}
						return // do NOT persist the stale token carried by the gap event
					}
					if (event.resumeToken !== undefined && event.resumeToken !== null) {
						void manager.persistChangeStreamResumeToken(event.resumeToken)
					}
				},
				mongoCfg.changeStreamDebounceMs,
			)
			let started = await csWatcher.start(persistedResumeToken ?? undefined)
			if (!started && persistedResumeToken) {
				log.warn(
					"change stream resume failed with persisted token; retrying from latest position",
				)
				started = await csWatcher.start()
				if (started) {
					await manager.clearPersistedChangeStreamResumeToken()
				}
			}
			if (started) {
				manager.changeStreamWatcher = csWatcher
				log.info("change stream watcher enabled for cross-instance sync")
			} else {
				log.info(
					"change streams not available — falling back to file watcher only",
				)
			}
		}

		log.info(
			`ready: profile=${mongoCfg.deploymentProfile} embedding=${mongoCfg.embeddingMode} ` +
				`fusion=${mongoCfg.fusionMethod} caps=${JSON.stringify(capabilities)}`,
		)

		return manager
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.search
	// ---------------------------------------------------------------------------

	/**
	 * P2.4: lazily created so Object.create-built test managers (which skip
	 * field initializers) get one on first write. Burst-coalesces the hot
	 * write path's cache invalidation: a quiet namespace invalidates
	 * immediately (leading), repeats inside the debounce window collapse
	 * into a single trailing scope-level delete.
	 */
	private queryCacheInvalidationCoalescer?: QueryCacheInvalidationCoalescer

	private scheduleQueryCacheInvalidation(params: {
		agentId: string
		scope: MemoryScope
		scopeRef: string
	}): void {
		writeOpsOf(this).scheduleQueryCacheInvalidation(params)
	}

	/**
	 * Resolve the tenant identity a read must be confined to.
	 *
	 * Every read path resolves identity through here so that an absent `scope`
	 * can never degrade into "all scopes" — the filter builders below take
	 * `scope`/`scopeRef` as required arguments, and this is the only sanctioned
	 * way to produce them.
	 *
	 * P2.3: reads share the canonical identity rule with writes (explicit
	 * scope wins; sessionKey implies "session"); D1/B3: the fallback is the
	 * unified MEMONGO_DEFAULT_SCOPE (legacy MEMONGO_SEARCH_DEFAULT_SCOPE
	 * remains a read alias for one deprecation window).
	 */
	private resolveSearchIdentity(opts?: {
		scope?: MemoryScope
		scopeRef?: string
		sessionKey?: string
	}): { scope: MemoryScope; scopeRef: string } {
		return searchOpsOf(this).resolveSearchIdentity(opts)
	}

	private buildConversationChunkFilter(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document {
		return searchOpsOf(this).buildConversationChunkFilter(params)
	}

	private buildBridgeChunkFilter(): Document {
		return searchOpsOf(this).buildBridgeChunkFilter()
	}

	/**
	 * Bridge notes live in the workspace namespace, so they are only readable by
	 * a caller whose own identity IS that workspace. Any other identity gets
	 * `undefined`, and the caller must skip the bridge lane entirely rather than
	 * search with no filter.
	 */
	private buildBridgeChunkFilterForIdentity(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document | undefined {
		return searchOpsOf(this).buildBridgeChunkFilterForIdentity(params)
	}

	private buildScopeAwareBridgeChunkFilter(
		activeSources: ActiveSources,
		params: { scope: MemoryScope; scopeRef: string },
	): Document | undefined {
		return searchOpsOf(this).buildScopeAwareBridgeChunkFilter(
			activeSources,
			params,
		)
	}

	private getBridgeChunkBudget(maxResults: number): number {
		return searchOpsOf(this).getBridgeChunkBudget(maxResults)
	}

	private buildV2AvailablePaths(
		activeSources: ActiveSources,
	): Set<RetrievalPath> {
		return searchOpsOf(this).buildV2AvailablePaths(activeSources)
	}

	/**
	 * Record access for returned search results (fire-and-forget).
	 * Maps canonicalId prefixes to collection names for the AccessTracker.
	 */
	private recordSearchAccess(results: MemorySearchResult[]): void {
		searchOpsOf(this).recordSearchAccess(results)
	}

	private setLastSearchMode(mode: string, details?: Record<string, unknown>) {
		return searchOpsOf(this).setLastSearchMode(mode, details)
	}

	private async legacySearch(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
		},
	): Promise<MemorySearchResult[]> {
		return searchOpsOf(this).legacySearch(query, opts)
	}

	async search(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
			questionDate?: Date
			/**
			 * #66: receives the per-lane latency breakdown of this call. A sink
			 * rather than instance state so concurrent searches (#67 scenario
			 * runner) cannot cross-attribute each other's lane timings.
			 */
			onLaneLatency?: (latencyByLane: Record<string, number>) => void
		},
		operationRunContext?: OperationRunContext,
	): Promise<MemorySearchResult[]> {
		return searchOpsOf(this).search(query, opts, operationRunContext)
	}

	private async executeSearchUncoalesced(params: {
		cleaned: string
		opts?: Parameters<MongoDBMemoryManager["search"]>[1]
		mongoCfg: ResolvedMongoDBConfig
		maxResults: number
		minScore: number
		activeSources: ActiveSources
		availablePaths: Set<RetrievalPath>
		searchScope: MemoryScope
		searchScopeRef: string
		operationRunContext?: OperationRunContext
	}): Promise<MemorySearchResult[]> {
		return searchOpsOf(this).executeSearchUncoalesced(params)
	}

	async searchDetailed(
		request: MemorySearchRequest,
	): Promise<MemorySearchResponse> {
		return searchOpsOf(this).searchDetailed(request)
	}

	async relevanceExplain(params: {
		query: string
		sourceScope?: RelevanceSourceScope
		sessionKey?: string
		maxResults?: number
		minScore?: number
		deep?: boolean
		questionDate?: Date
	}): Promise<RelevanceExplainResult> {
		return relevanceOpsOf(this).relevanceExplain(params)
	}

	async relevanceReport(params?: {
		windowMs?: number
	}): Promise<RelevanceReport> {
		if (!this.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		return this.relevance.buildReport(params?.windowMs ?? 24 * 60 * 60 * 1000)
	}

	relevanceSampleRate(): RelevanceSampleState {
		if (!this.relevance) {
			return {
				enabled: false,
				current: 0,
				base: 0,
				max: 0,
				windowSize: 0,
				degradedSignals: 0,
			}
		}
		return this.relevance.getSampleState()
	}

	async importConversations(params: {
		datasetPath: string
		scope?: MemoryScope
		scopeRef?: string
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryConversationImportResult> {
		const envRoots = (process.env.MEMONGO_DATASET_ROOTS ?? "")
			.split(path.delimiter)
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => resolveUserPath(entry))
		const datasetRoot = process.env.MEMONGO_DATASET_ROOT?.trim()
		const allowedRoots = [
			this.workspaceDir,
			...(datasetRoot ? [resolveUserPath(datasetRoot)] : []),
			...envRoots,
		]
		const datasetPath = await resolveConversationDatasetPath({
			datasetPath: params.datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots,
		})
		return importConversationDataset({
			datasetPath,
			baseDir: this.workspaceDir,
			allowedRoots,
			scope: params.scope,
			scopeRef: params.scopeRef,
			limitConversations: params.limitConversations,
			limitTurnsPerConversation: params.limitTurnsPerConversation,
			writeTurns: async (turns) =>
				this.writeConversationEventsBatch(
					turns.map((turn) => ({
						...turn,
						...(params.scope !== undefined ? { scope: params.scope } : {}),
						...(params.scopeRef !== undefined
							? { scopeRef: params.scopeRef }
							: {}),
					})),
				),
		})
	}

	async accessTrends(params?: {
		collection?: AccessEventCollection
		memoryIds?: string[]
		windowDays?: number
		limit?: number
	}): Promise<MemoryAccessTrend[]> {
		return adminOpsOf(this).accessTrends(params)
	}

	async accessSummaries(params: {
		collection: AccessEventCollection
		memoryIds: string[]
		windowDays?: number
	}): Promise<MemoryAccessSummary[]> {
		return adminOpsOf(this).accessSummaries(params)
	}

	// ---------------------------------------------------------------------------
	// Direct KB search (for kb_search tool optimization)
	// ---------------------------------------------------------------------------

	async searchKB(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			scopeRef?: string
			filter?: { tags?: string[]; category?: string; source?: string }
			/** Per-call override; defaults to the resolved config fusionMethod. */
			fusionMethod?: MemoryMongoDBFusionMethod
		},
	): Promise<MemorySearchResult[]> {
		return searchOpsOf(this).searchKB(query, opts)
	}

	// ---------------------------------------------------------------------------
	// Score normalization: detect which search method was used for legacy search
	// ---------------------------------------------------------------------------

	private detectSearchMethod(mongoCfg: ResolvedMongoDBConfig): SearchMethod {
		return searchOpsOf(this).detectSearchMethod(mongoCfg)
	}

	/**
	 * Resolve which search method actually produced these results, from the
	 * trace mongoSearch emits, falling back to the configuration guess only
	 * when nothing succeeded.
	 *
	 * This picks the normalizer, so guessing wrong corrupts ranking rather than
	 * just mislabeling. mongoSearch degrades through hybrid → vector → keyword
	 * → $text, and the last two return raw BM25/textScore values on an
	 * unbounded scale. Calling those "hybrid" sends them to the [0,1] clamp,
	 * which pins every lexical hit above ~1 to exactly 1.0 — sorting degraded
	 * results above genuine cosine hits from the KB and structured lanes, whose
	 * scores are normalized honestly. normalizeBM25Score exists precisely for
	 * this case; it was simply never reached.
	 */
	private resolveObservedSearchMethod(
		traceEvents: SearchTraceEvent[],
		mongoCfg: ResolvedMongoDBConfig,
	): SearchMethod {
		return searchOpsOf(this).resolveObservedSearchMethod(traceEvents, mongoCfg)
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.readFile
	// ---------------------------------------------------------------------------

	async readFile(params: {
		relPath: string
		from?: number
		lines?: number
	}): Promise<ManagerReadResult> {
		return readOpsOf(this).readFile(params)
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.status
	// ---------------------------------------------------------------------------

	status(): MemoryProviderStatus {
		return adminOpsOf(this).status()
	}

	private async readConversationChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	): Promise<ManagerReadResult> {
		return readOpsOf(this).readConversationChunk(rawPath, from, lines)
	}

	private async readCanonicalEvent(
		eventId: string,
		rawPath: string,
	): Promise<ManagerReadResult> {
		return readOpsOf(this).readCanonicalEvent(eventId, rawPath)
	}

	private async readBridgeChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	): Promise<ManagerReadResult> {
		return readOpsOf(this).readBridgeChunk(rawPath, from, lines)
	}

	private async readEpisodeLocator(params: {
		rawPath: string
		episodeId: string
		expandEvents: boolean
	}): Promise<ManagerReadResult> {
		return readOpsOf(this).readEpisodeLocator(params)
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.sync
	// ---------------------------------------------------------------------------

	async sync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void> {
		return syncOpsOf(this).sync(params)
	}

	private async repairEventProjections(): Promise<{
		eventsProcessed: number
		chunksCreated: number
	}> {
		return syncOpsOf(this).repairEventProjections()
	}

	async repairExtractionOutbox(params?: { limit?: number }): Promise<{
		eventsProcessed: number
		jobsCreated: number
		jobsReleased: number
		eventsFailed: number
	}> {
		return syncOpsOf(this).repairExtractionOutbox(params)
	}

	private async runSync(params?: {
		reason?: string
		force?: boolean
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void> {
		return syncOpsOf(this).runSync(params)
	}

	private async loadPersistedChangeStreamResumeToken(): Promise<unknown> {
		return syncOpsOf(this).loadPersistedChangeStreamResumeToken()
	}

	private async persistChangeStreamResumeToken(token: unknown): Promise<void> {
		return syncOpsOf(this).persistChangeStreamResumeToken(token)
	}

	private async clearPersistedChangeStreamResumeToken(): Promise<void> {
		return syncOpsOf(this).clearPersistedChangeStreamResumeToken()
	}

	private async maybeAutoRefreshKB(): Promise<void> {
		return syncOpsOf(this).maybeAutoRefreshKB()
	}

	// ---------------------------------------------------------------------------
	// File watcher (chokidar)
	// ---------------------------------------------------------------------------

	private ensureWatcher(): void {
		syncOpsOf(this).ensureWatcher()
	}

	private scheduleWatchSync(): void {
		syncOpsOf(this).scheduleWatchSync()
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.probeEmbeddingAvailability
	// ---------------------------------------------------------------------------

	async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
		return adminOpsOf(this).probeEmbeddingAvailability()
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.probeVectorAvailability
	// ---------------------------------------------------------------------------

	async probeVectorAvailability(): Promise<boolean> {
		return adminOpsOf(this).probeVectorAvailability()
	}

	private probeEmbeddingModeSupportsVector(): boolean {
		return adminOpsOf(this).probeEmbeddingModeSupportsVector()
	}

	// ---------------------------------------------------------------------------
	// Structured memory write (exposed for memory_write tool to avoid per-call MongoClient)
	// ---------------------------------------------------------------------------

	async writeStructuredMemory(
		entry: StructuredMemoryEntry,
	): Promise<{ upserted: boolean; id: string }> {
		return lifecycleOpsOf(this).writeStructuredMemory(entry)
	}

	async writeProcedure(
		entry: ProcedureEntry,
	): Promise<{ upserted: boolean; id: string }> {
		return lifecycleOpsOf(this).writeProcedure(entry)
	}

	async getLifecycleItem(
		handle: MemoryStableHandle,
	): Promise<MemoryLifecycleItem | null> {
		return lifecycleOpsOf(this).getLifecycleItem(handle)
	}

	async updateLifecycleItem(
		handle: MemoryStableHandle,
		patch: StructuredMemoryLifecyclePatch | ProcedureLifecyclePatch,
	): Promise<MemoryLifecycleItem | null> {
		return lifecycleOpsOf(this).updateLifecycleItem(handle, patch)
	}

	async invalidateLifecycleItem(
		handle: MemoryStableHandle,
		invalidatedBy?: Record<string, unknown>,
	): Promise<MemoryLifecycleItem | null> {
		return lifecycleOpsOf(this).invalidateLifecycleItem(handle, invalidatedBy)
	}

	async getLifecycleHistory(params: {
		handle: MemoryStableHandle
		limit?: number
	}): Promise<MemoryLifecycleHistoryEntry[]> {
		return lifecycleOpsOf(this).getLifecycleHistory(params)
	}

	async reportProcedureOutcome(params: {
		handle: Extract<MemoryStableHandle, { family: "procedure" }>
		success: boolean
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
		return lifecycleOpsOf(this).reportProcedureOutcome(params)
	}

	async applyMemoryFeedback(params: {
		handle: Extract<MemoryStableHandle, { family: "structured" }>
		signal: MemoryFeedbackSignal
		patch?: StructuredMemoryLifecyclePatch
		invalidatedBy?: Record<string, unknown>
		note?: string
		actorRole?: MemoryActorRole
	}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
		return lifecycleOpsOf(this).applyMemoryFeedback(params)
	}

	// ---------------------------------------------------------------------------
	// Self-edit: direct core block editing (user/persona/instructions)
	// ---------------------------------------------------------------------------

	async selfEditBlock(params: {
		block: MemorySelfEditBlock
		action: MemorySelfEditAction
		content: string
	}): Promise<{ upserted: boolean; id: string }> {
		return lifecycleOpsOf(this).selfEditBlock(params)
	}

	async getDetailedStatus(): Promise<V2Status> {
		return adminOpsOf(this).getDetailedStatus()
	}

	// C2-manager audit fix: synthesizeProfile delegation to standalone function
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
		return lifecycleOpsOf(this).synthesizeProfile(params)
	}

	async hydrateActiveSlate(
		params: { scope?: MemoryScope; scopeRef?: string; maxItems?: number } = {},
	): Promise<MemoryActiveSlate> {
		return lifecycleOpsOf(this).hydrateActiveSlate(params)
	}

	async buildDiscoveryProjection(
		request: MemoryDiscoveryProjectionRequest,
	): Promise<MemoryDiscoveryProjection> {
		return lifecycleOpsOf(this).buildDiscoveryProjection(request)
	}

	async buildContextBundle(
		request: MemoryContextBundleRequest = {},
	): Promise<MemoryContextBundle> {
		return lifecycleOpsOf(this).buildContextBundle(request)
	}

	async recallConversation(
		request: Omit<ConversationRecallRequest, "agentId">,
	): Promise<ConversationRecallResponse> {
		return lifecycleOpsOf(this).recallConversation(request)
	}

	private async refreshNativeBitemporalVectorPrefilter(): Promise<boolean> {
		return lifecycleOpsOf(this).refreshNativeBitemporalVectorPrefilter()
	}

	// -----------------------------------------------------------------------
	// Reasoning chain / novelty / consolidation wrappers
	// -----------------------------------------------------------------------

	async traceChain(params: {
		factId: string
		collection: string
		options?: { maxDepth?: number }
	}) {
		return lifecycleOpsOf(this).traceChain(params)
	}

	async scanNovelty(params?: {
		limit?: number
		scope?: string
		scopeRef?: string
	}) {
		return lifecycleOpsOf(this).scanNovelty(params)
	}

	async consolidate(params?: {
		maxEvents?: number
		minCombinedScore?: number
		resolveContradictions?: boolean
		llmDedup?: boolean
		scope?: MemoryScope
		scopeRef?: string
	}) {
		return lifecycleOpsOf(this).consolidate(params)
	}

	async listRecallTraces(params?: { limit?: number }) {
		return lifecycleOpsOf(this).listRecallTraces(params)
	}

	async getRecallTrace(params: { traceId: string }) {
		return lifecycleOpsOf(this).getRecallTrace(params)
	}

	async listMemoryJobs(params?: {
		status?: import("./types.js").MemoryJobStatus
		limit?: number
		jobType?: import("./types.js").MemoryJobType
	}) {
		return lifecycleOpsOf(this).listMemoryJobs(params)
	}

	async getMemoryJob(params: { jobId: string }) {
		return lifecycleOpsOf(this).getMemoryJob(params)
	}

	private enqueueDerivedWork(task: () => Promise<void>): void {
		jobsOpsOf(this).enqueueDerivedWork(task)
	}

	private enqueueDerivationScheduling(task: () => Promise<void>): void {
		jobsOpsOf(this).enqueueDerivationScheduling(task)
	}

	private shouldRunPostWriteDerivedWork(): boolean {
		return jobsOpsOf(this).shouldRunPostWriteDerivedWork()
	}

	private isDuplicateKeyError(err: unknown): boolean {
		return jobsOpsOf(this).isDuplicateKeyError(err)
	}

	private async runClaimedBackgroundExtractionJob(
		job: ClaimedMemoryJob,
		prefetchedLlmFacts?: string[],
	): Promise<void> {
		return jobsOpsOf(this).runClaimedBackgroundExtractionJob(
			job,
			prefetchedLlmFacts,
		)
	}

	private async drainMemoryJobQueue(): Promise<void> {
		return jobsOpsOf(this).drainMemoryJobQueue()
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
	private async prefetchExtractionSessionFacts(
		jobs: ClaimedMemoryJob[],
	): Promise<Map<string, string[]>> {
		return jobsOpsOf(this).prefetchExtractionSessionFacts(jobs)
	}

	private wakeMemoryJobWorker(): void {
		jobsOpsOf(this).wakeMemoryJobWorker()
	}

	private startMemoryJobWorker(): void {
		jobsOpsOf(this).startMemoryJobWorker()
	}

	private async stopMemoryJobWorker(): Promise<void> {
		return jobsOpsOf(this).stopMemoryJobWorker()
	}

	private async scheduleBackgroundExtraction(
		eventId: string,
		tenant?: { scope?: MemoryScope; scopeRef?: string },
		runContext?: OperationRunContext,
	): Promise<{ jobId: string; scheduled: boolean }> {
		return jobsOpsOf(this).scheduleBackgroundExtraction(
			eventId,
			tenant,
			runContext,
		)
	}

	private async schedulePostWriteDerivations(params: {
		eventId: string
		role: "user" | "assistant" | "system" | "tool"
		body: string
		sessionId?: string
		timestamp: Date
		scope: MemoryScope
		scopeRef: string
		runContext?: OperationRunContext
	}): Promise<void> {
		return jobsOpsOf(this).schedulePostWriteDerivations(params)
	}

	/**
	 * Fingerprint used to detect key-reuse-with-different-payload (IETF §2.7).
	 * scope/scopeRef are compared AFTER resolution so an explicit scopeRef and
	 * the equivalent resolved one count as the same payload.
	 */
	private resolveIdempotencyFingerprint(event: {
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
		return writeOpsOf(this).resolveIdempotencyFingerprint(event)
	}

	/**
	 * Idempotency replay (IETF Idempotency-Key / Stripe): a retry carrying a
	 * known key returns the original write's receipt instead of duplicating
	 * the event. chunkCreated reports false because the chunk projection from
	 * the accepted write already exists (replaying the request does not create
	 * a second one). Key reuse with a different payload is a 422 conflict.
	 */
	private async replayIdempotentEventWrite(params: {
		idempotencyKey: string
		event: {
			role: "user" | "assistant" | "system" | "tool"
			body: string
			sessionId?: string
			scope?: MemoryScope
			scopeRef?: string
		}
	}): Promise<{ eventId: string; chunkCreated: boolean } | null> {
		return writeOpsOf(this).replayIdempotentEventWrite(params)
	}

	async writeConversationEvent(
		event: WriteConversationEventInput,
		operationRunContext?: OperationRunContext,
	): Promise<{ eventId: string; chunkCreated: boolean }> {
		return writeOpsOf(this).writeConversationEvent(event, operationRunContext)
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
		return writeOpsOf(this).writeConversationEventsBatch(
			events,
			operationRunContext,
		)
	}

	async extractEvent(params: {
		eventId: string
		scope?: MemoryScope
		scopeRef?: string
	}) {
		return writeOpsOf(this).extractEvent(params)
	}

	// ---------------------------------------------------------------------------
	// Analytics: getMemoryStats
	// ---------------------------------------------------------------------------

	async stats(): Promise<MemoryStats> {
		return adminOpsOf(this).stats()
	}

	// ---------------------------------------------------------------------------
	// MemorySearchManager.close
	// ---------------------------------------------------------------------------

	async close(): Promise<void> {
		if (this.closed) {
			return
		}
		this.closed = true

		// Clear the debounced sync timer
		if (this.watchTimer) {
			clearTimeout(this.watchTimer)
			this.watchTimer = null
		}

		// (P2.5 e) shutdown ordering: intake is now stopped (closed — sync()
		// no-ops and writeConversationEvent throws). Drain everything ALREADY
		// queued BEFORE stopping the workers: a queued write stages extraction
		// jobs and post-write derivations, so awaiting the writeQueue only
		// after watcher/worker shutdown let queued writes schedule work on
		// stopped workers.
		if (this.syncing) {
			try {
				await this.syncing
			} catch {
				// Ignore sync errors during close — already logged in runSync
			}
		}
		await this.writeQueue
		await this.derivationSchedulingQueue
		await this.derivationQueue
		await this.stopMemoryJobWorker()
		// (P2.5 e) benchmark run contexts for never-claimed jobs are moot once
		// the worker has stopped; drop them instead of leaking the entries.
		this.memoryJobOperationContexts?.clear()

		// Close the file watcher
		if (this.watcher) {
			try {
				await this.watcher.close()
			} catch {
				// Ignore watcher close errors
			}
			this.watcher = null
		}

		// Close the change stream watcher
		if (this.changeStreamWatcher) {
			const token = this.changeStreamWatcher.lastResumeToken
			if (token !== undefined && token !== null) {
				await this.persistChangeStreamResumeToken(token)
			}
			try {
				await this.changeStreamWatcher.close()
			} catch {
				// Ignore change stream close errors
			}
			this.changeStreamWatcher = null
		}

		// Flush and close access tracker. Never swallow failures silently
		// (Bridge close durability): closing can lose buffered access events.
		// If the flush fails we at least surface it via log.warn with context
		// so the reviewer/hunter can grep for it and downstream operators can
		// alert on it; the tracker reference is still cleared afterward so the
		// close sequence is idempotent.
		if (this.accessTracker) {
			try {
				await this.accessTracker.close()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(`accessTracker close failed: ${msg}`)
			}
			this.accessTracker = null
		}

		// Close the MongoDB connection — but only when this manager owns it.
		// Shared clients (MEMONGO_SHARED_CLIENT) are owned by the process-level
		// registry and released via onClosed instead.
		if (this.ownsClient !== false) {
			try {
				await this.client.close()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(`error closing MongoDB connection: ${msg}`)
			}
		}
		try {
			this.onClosed?.()
		} catch (err) {
			log.warn(`onClosed hook failed: ${String(err)}`)
		}
	}
}

function searchOpsOf(self: MongoDBMemoryManager): MongoDBManagerSearchOps {
	const holder = self as unknown as { _searchOps?: MongoDBManagerSearchOps }
	if (!holder._searchOps) {
		holder._searchOps = new MongoDBManagerSearchOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._searchOps
}

function relevanceOpsOf(
	self: MongoDBMemoryManager,
): MongoDBManagerRelevanceOps {
	const holder = self as unknown as {
		_relevanceOps?: MongoDBManagerRelevanceOps
	}
	if (!holder._relevanceOps) {
		holder._relevanceOps = new MongoDBManagerRelevanceOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._relevanceOps
}

function syncOpsOf(self: MongoDBMemoryManager): MongoDBManagerSyncOps {
	const holder = self as unknown as { _syncOps?: MongoDBManagerSyncOps }
	if (!holder._syncOps) {
		holder._syncOps = new MongoDBManagerSyncOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._syncOps
}

function jobsOpsOf(self: MongoDBMemoryManager): MongoDBManagerJobsOps {
	const holder = self as unknown as { _jobsOps?: MongoDBManagerJobsOps }
	if (!holder._jobsOps) {
		holder._jobsOps = new MongoDBManagerJobsOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._jobsOps
}

function writeOpsOf(self: MongoDBMemoryManager): MongoDBManagerWriteOps {
	const holder = self as unknown as { _writeOps?: MongoDBManagerWriteOps }
	if (!holder._writeOps) {
		holder._writeOps = new MongoDBManagerWriteOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._writeOps
}

function adminOpsOf(self: MongoDBMemoryManager): MongoDBManagerAdminOps {
	const holder = self as unknown as { _adminOps?: MongoDBManagerAdminOps }
	if (!holder._adminOps) {
		holder._adminOps = new MongoDBManagerAdminOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._adminOps
}

function readOpsOf(self: MongoDBMemoryManager): MongoDBManagerReadOps {
	const holder = self as unknown as { _readOps?: MongoDBManagerReadOps }
	if (!holder._readOps) {
		holder._readOps = new MongoDBManagerReadOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._readOps
}

function lifecycleOpsOf(
	self: MongoDBMemoryManager,
): MongoDBManagerLifecycleOps {
	const holder = self as unknown as {
		_lifecycleOps?: MongoDBManagerLifecycleOps
	}
	if (!holder._lifecycleOps) {
		holder._lifecycleOps = new MongoDBManagerLifecycleOps(
			self as unknown as MongoDBManagerHost,
		)
	}
	return holder._lifecycleOps
}
