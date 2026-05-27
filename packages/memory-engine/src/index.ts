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
	MemoryActorRole,
	MemoryBlock,
	MemoryBlockLabel,
	MemoryBlocks,
	MemoryContextBundle,
	MemoryContextBundleMode,
	MemoryContextBundleMetadata,
	MemoryContextBundleRequest,
	MemoryContextBundleSection,
	MemoryContextBundleSectionItem,
	MemoryContextBundleSectionKind,
	MemoryLifecycleFamily,
	MemoryLifecycleHistoryEntry,
	MemoryLifecycleHistoryKind,
	MemoryLifecycleItem,
	MemoryLifecycleProcedureData,
	MemoryLifecycleState,
	MemoryLifecycleStructuredData,
	EvidenceCoverage,
	MemoryConversationScope,
	MemoryEmbeddingProbeResult,
	MemoryFeedbackSignal,
	MemoryProcedureStableHandle,
	MemoryProviderStatus,
	MemoryProceduralScope,
	MemoryReadResult,
	MemoryReferenceScope,
	MemorySearchClassification,
	MemorySearchManager,
	MemorySearchMetadata,
	MemorySearchMode,
	MemorySearchPass,
	ResolvedSearchConfig,
	SearchConfig,
	SearchFusionMethod,
	SearchHybridMode,
	SearchLexicalPrefilterMode,
	SearchRecipe,
	MemorySearchRequest,
	MemorySearchResponse,
	MemorySearchResult,
	MemorySearchSourcePreference,
	MemorySearchTimeRange,
	MemorySearchTimeRangePreset,
	MemorySource,
	MemoryStructuredScope,
	MemoryStableHandle,
	MemoryStructuredStableHandle,
	MemoryBenchmarkBuildIdentity,
	MemoryBenchmarkReleaseGate,
	MemoryBenchmarkRunReport,
	QueryGovernanceCandidate,
	QueryGovernanceReport,
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
export {
	closeAllMemorySearchManagers,
	getMemorySearchManager,
	type MemorySearchManagerResult,
} from "./search-manager.js"

// v2 modules
export {
	writeEvent,
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
	updateMemoryJob,
	listMemoryJobs,
	getMemoryJob,
} from "./mongodb-memory-jobs.js"
export type { MemoryStats } from "./mongodb-analytics.js"
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
	MongoDBMemoryManager,
	type RerankWeights,
	type RelevanceExplainResult,
	type V2Status,
} from "./mongodb-manager.js"
export {
	AccessTracker,
	getAccessSummaries,
	getAccessTrends,
	type AccessTrackerConfig,
} from "./mongodb-access-tracker.js"
export {
	loadBenchmarkDataset,
	ingestBenchmarkDataset,
	importConversationDataset,
} from "./mongodb-benchmark-harness.js"
export {
	evaluateRankingCase,
	buildQueryGovernanceReport,
	rankResultSessions,
	summarizeBenchmarkExecutions,
} from "./mongodb-benchmark-runner.js"
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
} from "./mongodb-schema.js"
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
	MemoryBenchmarkConversation,
	MemoryBenchmarkDataset,
	MemoryBenchmarkIngestResult,
	MemoryConversationImportResult,
	MemoryBenchmarkTurn,
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
	RelevanceBenchmarkResult,
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

// ---------------------------------------------------------------------------
// State Family — unified view over profile + blocks + context bundle
// ---------------------------------------------------------------------------

import type { ProfileSynthesis } from "./mongodb-profile.js"
import type { MemoryBlocks, MemoryContextBundle } from "./types.js"

/**
 * The Memongo State Family — three coordinated views over the same memory system.
 * - `profile`: synthesized summary of structured memory (preferences, decisions, facts)
 * - `blocks`: always-loaded hot context for the current session (materialized from active-slate)
 * - `bundle`: token-budgeted assembly of all state views for LLM consumption
 */
export type MemoryStateFamily = {
	profile: ProfileSynthesis
	blocks: MemoryBlocks
	bundle: MemoryContextBundle
}
