/**
 * Public barrel for `@memongo/memory-engine`.
 *
 * P4.1 trim: the stable surface is the manager, its configuration, and the
 * request/response types of the memory API (~50 symbols). Everything that was
 * previously re-exported here (module-level helpers and collection accessors)
 * remains available during the deprecation window behind the explicit
 * `@memongo/memory-engine/internal` subpath (src/internal-barrel.ts) and is
 * slated for removal from the package surface in the next major version.
 * Benchmark and evaluation tooling lives outside the published package.
 */
export type {
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
} from "./types.js"
export {
	MongoDBMemoryManager,
	type RerankWeights,
	type RelevanceExplainResult,
	type V2Status,
	type WriteConversationEventInput,
	type WriteConversationEventReceipt,
} from "./mongodb-manager.js"
export {
	closeAllMemorySearchManagers,
	getMemorySearchManager,
	type MemorySearchManagerResult,
} from "./search-manager.js"

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
