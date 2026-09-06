/**
 * Internal (deprecated) deep export surface of `@memongo/memory-engine`.
 *
 * P4.1: this module backs the explicit `@memongo/memory-engine/internal`
 * subpath. It carries every symbol that was removed from the main barrel
 * (`src/index.ts`) during the P4.1 trim, including module-level helpers,
 * collection accessors, and advanced types. Existing consumers keep compiling
 * through the deprecation window.
 *
 * @deprecated Nothing here is covered by the package's SemVer guarantee.
 * Migrate to the main barrel (`@memongo/memory-engine`: manager + config +
 * request/response types) or to `@memongo/memory-bridge`; this subpath is
 * slated for removal in the next major version.
 */
export type {
	ConversationRecallCitation,
	ConversationRecallRequest,
	ConversationRecallResponse,
	ConversationRecallResult,
	ConversationRecallRole,
	MemoryDiscoveryProjection,
	MemoryDiscoveryProjectionEvidence,
	MemoryDiscoveryProjectionKind,
	MemoryDiscoveryProjectionMetadata,
	MemoryDiscoveryProjectionRequest,
	MemoryDiscoveryProjectionSection,
	MemoryDiscoveryProjectionSource,
	MemoryActiveSlate,
	MemoryActiveSlateItem,
	MemoryActiveSlateKind,
	MemoryActiveSlateMetadata,
	MemoryActiveSlateSource,
	MemoryLifecycleFamily,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleHistoryKind,
	MemoryLifecycleItem,
	MemoryLifecycleProcedureData,
	MemoryLifecycleState,
	MemoryLifecycleStructuredData,
	MemorySearchManager,
	RejectedResultSummary,
} from "./types.js"
export { sortObject } from "./search-utils.js"
export {
	buildMemorySearchRequestSignature,
	normalizeMemorySearchRequest,
	applySearchConfig,
	resolveSearchConfig,
	resolveExecutorTimeRange,
	classifyExecutorSearch,
	buildExecutorPasses,
	computeEvidenceCoverage,
	applyHardConstraintRejections,
	requestHasHardConstraints,
	buildConstraintSummaries,
	analyzeCorrectionNeeded,
	identifyRelaxableConstraint,
	applyMMRReranking,
	executeMongoSearchPlan,
	type MemorySearchExecutorTimeRange,
	type MemorySearchExecutorRequest,
	type MemorySearchExecutorPlanPass,
} from "./mongodb-search-executor.js"

// v2 modules
export {
	writeEvent,
	writeEventsBatch,
	projectEventChunksBatch,
	clearEventExtractionJobPendingBatch,
	getEventsByTimeRange,
	getEventsBySession,
	getUnprojectedEvents,
	markEventsProjected,
	markEventsConsolidated,
	getUnconsolidatedEvents,
	projectChunksFromEvents,
	getSessionEventsWithBound,
	renderEventChunkText,
	type CanonicalEvent,
	type EventBatchItemResult,
} from "./mongodb-events.js"
export {
	buildMemoryEvidenceDocuments,
	isEvidenceMirrorEnabled,
	resolveEvidenceMirrorMode,
	writeMemoryEvidenceDocuments,
	type EvidenceMirrorMode,
	type MemoryEvidenceDocument,
	type MemoryEvidenceUnit,
} from "./mongodb-evidence-mirror.js"
export {
	upsertEntity,
	upsertRelation,
	findEntitiesByName,
	getEntitiesByType,
	expandGraph,
	deleteEntity,
	deleteEntityConservative,
	extractAndUpsertEntities,
	searchEntitiesAutocomplete,
	findRelationByLocatorId,
	type Entity,
	type EntityType,
	type Relation,
	type RelationType,
	type GraphExpansionResult,
} from "./mongodb-graph.js"
export {
	materializeEpisode,
	getEpisodesByTimeRange,
	getEpisodesByType,
	searchEpisodes,
	checkAutoEpisodeTriggers,
	updateEpisodeStatus,
	getEpisodesByIds,
	type Episode,
	type EpisodeType,
	type EpisodeStatus,
	type EpisodeSummarizer,
	type EpisodeSummarizerResult,
	type AutoEpisodeTriggerResult,
} from "./mongodb-episodes.js"
export {
	recordIngestRun,
	recordProjectionRun,
	getRecentIngestRuns,
	getRecentProjectionRuns,
	getProjectionLag,
} from "./mongodb-ops.js"
export {
	recordRecallTrace,
	listRecallTraces,
	getRecallTrace,
} from "./mongodb-recall-traces.js"
export {
	createMemoryJob,
	createMemoryJobsBatch,
	updateMemoryJob,
	listMemoryJobs,
	getMemoryJob,
	type MemoryJobBatchItemResult,
} from "./mongodb-memory-jobs.js"
export type { MemoryStats } from "./mongodb-analytics.js"
export type { TenantErasureReceipt } from "./mongodb-erasure.js"
// C-004: quarantine review lifecycle — the review queue the bridge surfaces
// to the API/MCP/console review surfaces.
export type {
	QuarantinedEntry,
	QuarantineReviewReceipt,
	QuarantineStatus,
} from "./mongodb-quarantine-review.js"
export {
	planRetrieval,
	classifyRetrievalQuery,
	type RetrievalPlan,
	type RetrievalPath,
} from "./mongodb-retrieval-planner.js"
export {
	writeProcedure,
	searchProcedures,
	recordProcedureOutcome,
	reportProcedureOutcomeByHandle,
	evolveProcedure,
	getProcedureByHandle,
	updateProcedureByHandle,
	invalidateProcedureByHandle,
	getProcedureHistoryByHandle,
	type ProcedureEntry,
	type ProcedureLifecyclePatch,
	type ProcedureState,
} from "./mongodb-procedures.js"
export { backfillEventsFromChunks } from "./mongodb-migration.js"
export {
	rerankResults,
	resolveMemoryJobWorkerConcurrency,
} from "./mongodb-manager.js"
export type { ManagerReadResult } from "./mongodb-manager-read.js"
export {
	AccessTracker,
	accessTargetFromSearchResult,
	getAccessSummaries,
	getAccessTrends,
	type AccessRecordTarget,
	type AccessTrackerConfig,
} from "./mongodb-access-tracker.js"
export {
	bumpTenantErasureEpoch,
	getTenantErasureEpoch,
} from "./mongodb-erasure-epoch.js"
export { importConversationDataset } from "./mongodb-conversation-import.js"
export {
	queryCacheCollection,
	telemetryCollection,
	accessEventsCollection,
	mutationsCollection,
	laneCoverageCollection,
	consolidationRunsCollection,
	recallTracesCollection,
	memoryJobsCollection,
	sessionChunksCollection,
	ensureEntityAutocompleteIndex,
	ensureEpisodeAutocompleteIndex,
} from "./mongodb-schema.js"
// P2.2: exported so the bridge can type its capability surface with the real
// engine type instead of re-declaring it.
export type { DetectedCapabilities } from "./mongodb-schema.js"
// P3.6: capability re-enable registry — the single surface where gated
// MongoDB features declare their unblock condition.
export {
	applyCapabilityProbeResult,
	CAPABILITY_GATES,
	evaluateCapabilityGates,
	getCapabilityGate,
	isCapabilityEnabled,
	mongodbDeploymentIdentity,
	recordCapabilityProbe,
	resetCapabilityProbes,
	serverVersionAtLeast,
	type CapabilityGate,
	type CapabilityGateContext,
} from "./mongodb-capability-registry.js"
export {
	resolveSessionEvidenceMode,
	buildSessionEvidenceDocuments,
	truncateAtSentenceBoundary,
	writeSessionEvidenceOptionA,
	writeSessionEvidenceOptionB,
	extractSessionIdFromCanonicalId,
	type SessionEvidenceMode,
	type SessionEvidenceDocument,
} from "./mongodb-session-evidence.js"
export {
	resolveUserfactEvidenceMode,
	extractUserfactFacts,
	buildUserfactEvidenceDocuments,
	writeUserfactEvidence,
	extractSessionIdFromUserfactCanonicalId,
	type UserfactEvidenceMode,
	type UserfactEvidenceDocument,
} from "./mongodb-userfact-evidence.js"
export {
	resolveEnrichmentMode,
	resolveEnrichmentProvider,
	createHttpProvider,
	extractSessionEnrichment,
	buildEnrichedUserfactDocument,
	buildQaEvidenceDocument,
	enrichSessionsWithLLM,
	EnrichmentHttpError,
	ENRICHMENT_SYSTEM_PROMPT,
	type EnrichmentMode,
	type EnrichmentProvider,
	type EnrichmentProviderConfig,
	type EnrichmentResult,
	type UserfactEvidenceEnrichedDocument,
	type QaEvidenceDocument,
	type EnrichSessionsResult,
} from "./mongodb-llm-enrichment.js"
export {
	updateLaneCoverage,
	getLaneCoverage,
	emptyLaneCoverage,
	type LaneStatus,
	type LaneCoverageDocument,
} from "./mongodb-lane-coverage.js"
export {
	recordMutation,
	getMutationHistory,
	type MutationRecord,
	type MutationOperation,
} from "./mongodb-mutations.js"
export {
	checkCache,
	writeCache,
	normalizeQuery,
	hashQuery,
	type QueryCacheEntry,
	type QueryCacheConfig,
	type CacheCheckResult,
	DEFAULT_CACHE_CONFIG,
} from "./mongodb-query-cache.js"
export {
	emitTelemetry,
	getLatencyStats,
	getCacheHitRate,
	getOperationDistribution,
	type TelemetryDocument,
	type TelemetryOperation,
	type TelemetryMeta,
} from "./mongodb-telemetry.js"
export {
	computeResultTrust,
	annotateResultsWithTrust,
	rerankResultsByTrust,
	summarizeTrust,
	shouldAbstainForLowTrust,
	computeImportanceDecay,
} from "./mongodb-trust.js"
export {
	consolidateMemory,
	markEventsDreamerProcessed,
} from "./mongodb-consolidator.js"
export type {
	ConsolidationCandidate,
	ConsolidationOptions,
	ConsolidationResult,
} from "./types.js"
export type {
	AccessEventCollection,
	AccessEventDocument,
	MemoryAccessSummary,
	MemoryAccessTrend,
	MemoryConversationImportResult,
	MemoryConfidenceSource,
	MemorySourceAgent,
	MemoryArtifact,
	MemorySelfEditBlock,
	MemorySelfEditAction,
	MemorySelfEditRequest,
	RecallTrace,
	MemoryJob,
	MemoryJobType,
	MemoryJobStatus,
} from "./types.js"
export { CONFIDENCE_BY_SOURCE } from "./types.js"
export { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
export {
	hydrateActiveSlate,
	materializeBlocks,
} from "./mongodb-active-slate.js"
export { buildContextBundle } from "./mongodb-context-bundle.js"
export { recallConversation } from "./mongodb-conversation-recall.js"
export {
	synthesizeProfile,
	type ProfileSynthesis,
	type ProfileMemoryItem,
	type ProfileEntity,
	type ProfileEpisode,
	type ActivityPatterns,
} from "./mongodb-profile.js"
export {
	crossEncoderRerank,
	type RerankConfig,
	type RerankResult,
} from "./mongodb-reranker.js"
export type { RelevanceSourceScope } from "./mongodb-relevance.js"
export type {
	RelevanceArtifact,
	RelevanceHealth,
	RelevanceReport,
	RelevanceSampleState,
} from "./mongodb-relevance.js"
export {
	rewriteQuery,
	expandSynonyms,
	type QueryRewriteConfig,
	type QueryRewriteResult,
} from "./mongodb-query-rewriter.js"
export {
	getStructuredMemoryByHandle,
	applyStructuredMemoryFeedbackByHandle,
	updateStructuredMemoryByHandle,
	invalidateStructuredMemoryByHandle,
	getStructuredMemoryHistoryByHandle,
	type StructuredMemoryEntry,
	type StructuredMemoryLifecyclePatch,
	type StructuredMemorySalience,
	type StructuredMemoryTemporalScope,
} from "./mongodb-structured-memory.js"
export {
	type EntityExtractor,
	type ExtractedEntity as ExtractedEntityV2,
	type EntityExtractionContext,
	type LLMFunction,
	RegexEntityExtractor,
	LLMEntityExtractor,
	buildExtractionPrompt,
	buildUserExtractionPrompt,
	buildAssistantExtractionPrompt,
	parseExtractionResponse,
	AMBIGUOUS_PERSON_NAMES,
	isAmbiguousPersonName,
} from "./mongodb-entity-extractor.js"
export { expandSearchContext } from "./mongodb-context-expansion.js"
export { mergeContiguousChunks } from "./mongodb-contiguous-merge.js"
export {
	buildConversationWindows,
	projectConversationWindows,
	type ConversationWindow,
} from "./mongodb-conversation-windows.js"
export {
	buildTieredSummaryPrompt,
	parseTieredSummaryResponse,
	withTieredSummaries,
} from "./mongodb-tiered-summary.js"
export {
	traceReasoningChain,
	type ReasoningChain,
	type ReasoningChainNode,
	type ReasoningChainOptions,
} from "./mongodb-reasoning-chain.js"
export {
	scanNovelty,
	computeCentroid,
	type NoveltyEvent,
	type NoveltyReport,
	type NoveltyOptions,
} from "./mongodb-novelty.js"
