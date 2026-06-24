export type MemoryBackend = "mongodb"

export type MemoryMongoDBDeploymentProfile =
	| "atlas-local-preview"
	| "atlas-managed"
	| "community-mongot"

export type MemoryMongoDBEmbeddingMode = "automated"

export type MemoryMongoDBFusionMethod =
	| "scoreFusion"
	| "rankFusion"
	| "js-merge"

export type MemoryMongoDBRecallProfile = "latency" | "balanced" | "proof"

export type MemoryScope =
	| "session"
	| "user"
	| "agent"
	| "workspace"
	| "tenant"
	| "global"
export type MemorySourceToggleConfig = {
	enabled?: boolean
}

export type MemoryMongoDBConfig = {
	uri?: string
	database?: string
	collectionPrefix?: string
	deploymentProfile?: MemoryMongoDBDeploymentProfile
	embeddingMode?: MemoryMongoDBEmbeddingMode
	fusionMethod?: MemoryMongoDBFusionMethod
	recallProfile?: MemoryMongoDBRecallProfile
	quantization?: "none" | "scalar" | "binary"
	watchDebounceMs?: number
	numDimensions?: number
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
	embeddingCacheTtlDays?: number
	memoryTtlDays?: number
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
