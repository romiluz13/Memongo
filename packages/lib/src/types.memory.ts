export type MemoryBackend = "mongodb"

export type MemoryMongoDBDeploymentProfile =
	| "atlas-local-preview"
	| "atlas-managed"
	| "community-mongot"

export type MemoryMongoDBEmbeddingMode = "automated"

export type MemoryMongoDBQueryEmbeddingModel =
	| "voyage-4-large"
	| "voyage-4"
	| "voyage-4-lite"

export type MemoryMongoDBFusionMethod =
	| "scoreFusion"
	| "rankFusion"
	| "js-merge"

export type MemoryMongoDBRecallProfile = "latency" | "balanced" | "proof"

import type { MemoryScopeValue } from "./contract.js"

/**
 * Memory isolation scope. Derived from the canonical MEMORY_SCOPE_VALUES in
 * ./contract.ts (P2.2 single contract source) so the type can never drift
 * from the runtime enum the API/MCP/zod layers validate against.
 */
export type MemoryScope = MemoryScopeValue
export type MemorySourceToggleConfig = {
	enabled?: boolean
}

export type MemoryMongoDBConfig = {
	uri?: string
	database?: string
	collectionPrefix?: string
	deploymentProfile?: MemoryMongoDBDeploymentProfile
	embeddingMode?: MemoryMongoDBEmbeddingMode
	/**
	 * Voyage model used to embed read-path queries. Voyage 4 models share an
	 * embedding space, so this may differ from the index-time model.
	 */
	queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
	fusionMethod?: MemoryMongoDBFusionMethod
	recallProfile?: MemoryMongoDBRecallProfile
	quantization?: "none" | "scalar" | "binary"
	watchDebounceMs?: number
	/**
	 * Dead knob under autoEmbed (fix-plan-2026-08-03 P3.2): Atlas/Voyage
	 * decide the dimensions server-side, so this value only flows into
	 * validator warnings and the generic index preset. resolveMongoDBConfig
	 * logs an error when it is set.
	 */
	numDimensions?: number
	/**
	 * P3.2: opt-in legacySearch re-run after searchV2 returns empty or
	 * errors. Default OFF — "empty ≠ error": the v2 empty answer stands.
	 */
	legacySearchFallback?: boolean
	/**
	 * P3.2: per-search cost budget overrides (see
	 * packages/memory-engine/src/mongodb-search-budget.ts). Caps the
	 * aggregations and paid server-side query embeddings one search request
	 * may consume; exhaustion degrades remaining lanes to empty results.
	 */
	searchBudget?: {
		maxAggregations?: number
		maxEmbeds?: number
	}
	maxPoolSize?: number
	minPoolSize?: number
	maxConnecting?: number
	maxIdleTimeMs?: number
	networkFamily?: 4 | 6
	socketTimeoutMs?: number
	serverSelectionTimeoutMs?: number
	heartbeatFrequencyMs?: number
	serverMonitoringMode?: "auto" | "stream" | "poll"
	waitQueueTimeoutMs?: number
	memoryTtlDays?: number
	/**
	 * P4.4.1: optional per-document TTL on `events` and `structured_mem`.
	 * Off by default. When enabled, writes carrying a sessionId get an
	 * absolute `expiresAt` of recordedAt + sessionDays unless the caller
	 * passes an explicit per-write `expiresAt` (which always wins, even
	 * when this group is disabled). Backed by partial TTL indexes
	 * (`expireAfterSeconds: 0` keyed on `expiresAt`, partial on
	 * `expiresAt: { $exists: true }`); read paths also exclude expired
	 * documents because the TTL sweep lags ~60s.
	 *
	 * C-005: event expiry propagates to EVERY derived copy of the event
	 * text, so retention on events cannot leave orphaned projections
	 * behind:
	 *   - event chunks (`events/{eventId}`) carry the same absolute
	 *     `expiresAt` on every write path (single write, batch write, and
	 *     extraction-outbox repair); a partial chunks TTL index
	 *     (`idx_chunks_ttl_expires_at`) deletes them and chunk read
	 *     surfaces exclude them once expired. Re-projection re-asserts the
	 *     expiry, so chunks written by older code without one are healed.
	 *   - conversation windows (`windows/{sessionId}/{index}`) embed their
	 *     source events' text, so a window expires with its LATEST-expiring
	 *     event (a window containing any never-expiring event is
	 *     permanent); expired events are excluded from window text entirely.
	 *   - session-evidence documents (benchmark ingestion lanes A and B)
	 *     inherit the latest source-event expiry the same way, with a
	 *     matching TTL index on `session_chunks`.
	 *   - all chunk read surfaces (conversation search, bridge search, and
	 *     direct chunk/event reads) compose the same unexpired guard, so an
	 *     expired copy stops surfacing immediately instead of waiting for
	 *     the ~60s TTL sweep lag.
	 */
	ttl?: {
		enabled?: boolean
		/** Session-scope default retention in days (must be positive). */
		sessionDays?: number
	}
	enableChangeStreams?: boolean
	changeStreamDebounceMs?: number
	connectTimeoutMs?: number
	numCandidates?: number
	maxSessionChunks?: number
	kb?: {
		enabled?: boolean
		chunking?: { tokens?: number; overlap?: number }
		autoImportPaths?: string[]
		maxDocumentSize?: number
		autoRefreshHours?: number
	}
	episodes?: {
		enabled?: boolean
		minEventsForEpisode?: number
	}
	graph?: {
		enabled?: boolean
		maxGraphDepth?: number
		entityExtraction?: {
			method?: "regex" | "llm"
			model?: string
			timeoutMs?: number
		}
	}
	queryRewriting?: {
		enabled?: boolean
		method?: "synonym-expansion"
		maxTokens?: number
	}
	reranking?: {
		enabled?: boolean
		model?: "rerank-2.5" | "rerank-2.5-lite"
		topN?: number
		minScore?: number
		voyageApiKey?: string
		instruction?: string
		/** Post-cross-encoder recency boost weight (0 disables; default 0.2). */
		recencyBoost?: number
		/** Post-cross-encoder access-count boost weight (0 disables; default 0.2). */
		accessBoost?: number
		/**
		 * Raw-window lane temporal-proximity weight (P4.4.4): when the query
		 * implies a temporal window, events nearer the window midpoint score
		 * higher. 0 disables; default 0.1.
		 */
		temporalProximityBoost?: number
	}
	cache?: {
		enabled?: boolean
		conversationTtlSec?: number
		kbTtlSec?: number
		similarityThreshold?: number
	}
	relevance?: {
		enabled?: boolean
		telemetry?: {
			enabled?: boolean
			baseSampleRate?: number
			adaptive?: {
				enabled?: boolean
				maxSampleRate?: number
				minWindowSize?: number
			}
			persistRawExplain?: boolean
			queryPrivacyMode?: "redacted-hash" | "raw" | "none"
		}
		retention?: { days?: number }
		benchmark?: {
			enabled?: boolean
			datasetPath?: string
		}
	}
}
export type MemoryCitationsMode = "auto" | "on" | "off"

export type MemoryConfig = {
	backend?: MemoryBackend
	citations?: MemoryCitationsMode
	sources?: {
		reference?: MemorySourceToggleConfig
		conversation?: MemorySourceToggleConfig
		structured?: MemorySourceToggleConfig
	}
	mongodb?: MemoryMongoDBConfig
}
