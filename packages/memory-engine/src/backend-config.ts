import {
	type MemongoConfig,
	type MemoryCitationsMode,
	type MemoryMongoDBDeploymentProfile,
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBRecallProfile,
	createSubsystemLogger,
	resolveUserPath,
} from "@memongo/lib"

const log = createSubsystemLogger("memory:backend-config")

// Known embedding model dimensions for numDimensions validation (F22)
const KNOWN_MODEL_DIMENSIONS: Record<string, number> = {
	"voyage-4-large": 1024,
	"voyage-4": 1024,
	"voyage-4-lite": 512,
	"voyage-3": 1024,
	"voyage-3-lite": 512,
	"voyage-code-3": 1024,
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"text-embedding-ada-002": 1536,
}

export type ResolvedMongoDBConfig = {
	uri: string
	database: string
	collectionPrefix: string
	deploymentProfile: MemoryMongoDBDeploymentProfile
	embeddingMode: MemoryMongoDBEmbeddingMode
	fusionMethod: MemoryMongoDBFusionMethod
	recallProfile: MemoryMongoDBRecallProfile
	quantization: "none" | "scalar" | "binary"
	watchDebounceMs: number
	numDimensions: number
	maxPoolSize: number
	minPoolSize: number
	maxConnecting?: number
	maxIdleTimeMs?: number
	networkFamily?: 4 | 6
	socketTimeoutMs?: number
	serverSelectionTimeoutMs: number
	heartbeatFrequencyMs?: number
	serverMonitoringMode?: "auto" | "stream" | "poll"
	waitQueueTimeoutMs?: number
	embeddingCacheTtlDays: number
	memoryTtlDays: number
	enableChangeStreams: boolean
	changeStreamDebounceMs: number
	connectTimeoutMs: number
	numCandidates: number
	maxSessionChunks: number
	kb: {
		enabled: boolean
		chunking: { tokens: number; overlap: number }
		autoImportPaths: string[]
		maxDocumentSize: number
		autoRefreshHours: number
	}
	relevance: {
		enabled: boolean
		telemetry: {
			enabled: boolean
			baseSampleRate: number
			adaptive: {
				enabled: boolean
				maxSampleRate: number
				minWindowSize: number
			}
			persistRawExplain: boolean
			queryPrivacyMode: "redacted-hash" | "raw" | "none"
		}
		retention: {
			days: number
		}
		benchmark: {
			enabled: boolean
			datasetPath: string
		}
	}
	episodes: { enabled: boolean; minEventsForEpisode: number }
	graph: {
		enabled: boolean
		maxGraphDepth: number
		entityExtraction: {
			method: "regex" | "llm"
			model?: string
			timeoutMs: number
		}
	}
	queryRewriting: {
		enabled: boolean
		method: "synonym-expansion"
		maxTokens: number
	}
	reranking: {
		enabled: boolean
		model: "rerank-2.5" | "rerank-2.5-lite"
		topN: number
		minScore: number
		voyageApiKey: string
		instruction?: string
	}
	cache: {
		enabled: boolean
		conversationTtlSec: number
		kbTtlSec: number
		similarityThreshold: number
	}
	sources: {
		reference: { enabled: boolean }
		conversation: { enabled: boolean }
		structured: { enabled: boolean }
	}
}

export type ResolvedMemoryBackendConfig = {
	backend: "mongodb"
	citations: MemoryCitationsMode
	mongodb?: ResolvedMongoDBConfig
}
const DEFAULT_BACKEND = "mongodb"
const DEFAULT_CITATIONS: MemoryCitationsMode = "auto"
const DEFAULT_RELEVANCE_DATASET = "~/.memongo/relevance/golden.jsonl"
const DEFAULT_MONGODB_PROFILE: MemoryMongoDBDeploymentProfile =
	"atlas-local-preview"
const DEFAULT_MONGODB_EMBEDDING_MODE: MemoryMongoDBEmbeddingMode = "automated"

function sanitizeName(input: string): string {
	const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
	const trimmed = lower.replace(/^-+|-+$/g, "")
	return trimmed || "collection"
}

export function resolveMemoryBackendConfig(params: {
	cfg: MemongoConfig
	agentId: string
}): ResolvedMemoryBackendConfig {
	const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND
	const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS

	if (backend !== "mongodb") {
		throw new Error(
			`Unsupported memory.backend "${String(backend)}". Memongo supports only the MongoDB memory backend.`,
		)
	}

	if (backend === "mongodb") {
		const mongoCfg = params.cfg.memory?.mongodb
		const forceUri = process.env.MEMONGO_FORCE_MONGODB_URI?.trim()
		const uri =
			forceUri ||
			(typeof mongoCfg?.uri === "string" && mongoCfg.uri.trim()
				? mongoCfg.uri.trim()
				: undefined) ||
			process.env.MEMONGO_MONGODB_URI?.trim()
		if (!uri) {
			throw new Error(
				[
					"MongoDB URI required for Memongo.",
					"Set `memory.mongodb.uri` in config or `MEMONGO_MONGODB_URI` in the environment.",
					"Use `MEMONGO_FORCE_MONGODB_URI` to override a file URI (for example memongo-api or CI).",
				].join(" "),
			)
		}
		const rawDeploymentProfile =
			mongoCfg?.deploymentProfile ??
			(uri.includes(".mongodb.net") ? "atlas-managed" : DEFAULT_MONGODB_PROFILE)
		const deploymentProfile: MemoryMongoDBDeploymentProfile =
			rawDeploymentProfile === "community-mongot"
				? "atlas-local-preview"
				: rawDeploymentProfile
		const rawEmbeddingMode =
			mongoCfg?.embeddingMode ?? DEFAULT_MONGODB_EMBEDDING_MODE
		const embeddingMode: MemoryMongoDBEmbeddingMode =
			DEFAULT_MONGODB_EMBEDDING_MODE
		const envCollectionPrefix =
			process.env.MEMONGO_MONGODB_COLLECTION_PREFIX?.trim()

		if (
			rawDeploymentProfile !== "atlas-local-preview" &&
			rawDeploymentProfile !== "atlas-managed" &&
			rawDeploymentProfile !== "community-mongot"
		) {
			const unsupportedDeploymentProfile = String(mongoCfg?.deploymentProfile)
			throw new Error(
				[
					`deploymentProfile "${unsupportedDeploymentProfile}" is not supported in Memongo.`,
					'Use deploymentProfile "atlas-local-preview" or "atlas-managed".',
				].join(" "),
			)
		}
		if (rawEmbeddingMode !== "automated") {
			const unsupportedEmbeddingMode = String(mongoCfg?.embeddingMode)
			throw new Error(
				[
					`embeddingMode "${unsupportedEmbeddingMode}" is not supported in Memongo.`,
					'Use embeddingMode "automated" with atlas-local-preview or atlas-managed.',
				].join(" "),
			)
		}
		if (
			typeof mongoCfg?.queryRewriting?.method === "string" &&
			mongoCfg.queryRewriting.method !== "synonym-expansion"
		) {
			throw new Error(
				[
					`queryRewriting.method "${mongoCfg.queryRewriting.method}" is not supported in Memongo.`,
					'Use queryRewriting.method "synonym-expansion" or disable query rewriting.',
				].join(" "),
			)
		}

		const result: ResolvedMemoryBackendConfig = {
			backend: "mongodb",
			citations,
			mongodb: {
				uri,
				database: mongoCfg?.database ?? "memongo",
				collectionPrefix:
					(envCollectionPrefix && envCollectionPrefix.length > 0
						? envCollectionPrefix
						: undefined) ??
					mongoCfg?.collectionPrefix ??
					`memongo_${sanitizeName(params.agentId)}_`,
				deploymentProfile,
				embeddingMode,
				fusionMethod: resolveEnvFusionMethod(
					"MEMONGO_MONGODB_FUSION_METHOD",
					mongoCfg?.fusionMethod ?? "rankFusion",
				),
				recallProfile: resolveEnvRecallProfile(
					"MEMONGO_MONGODB_RECALL_PROFILE",
					mongoCfg?.recallProfile ?? "balanced",
				),
				quantization: mongoCfg?.quantization ?? "none",
				watchDebounceMs:
					typeof mongoCfg?.watchDebounceMs === "number" &&
					Number.isFinite(mongoCfg.watchDebounceMs) &&
					mongoCfg.watchDebounceMs >= 0
						? Math.floor(mongoCfg.watchDebounceMs)
						: 500,
				numDimensions:
					typeof mongoCfg?.numDimensions === "number" &&
					Number.isFinite(mongoCfg.numDimensions) &&
					mongoCfg.numDimensions > 0
						? Math.floor(mongoCfg.numDimensions)
						: 1024,
				maxPoolSize: resolvePositiveIntegerSetting(
					mongoCfg?.maxPoolSize,
					"MEMONGO_MONGODB_MAX_POOL_SIZE",
					10,
				),
				minPoolSize: resolveNonNegativeIntegerSetting(
					mongoCfg?.minPoolSize,
					"MEMONGO_MONGODB_MIN_POOL_SIZE",
					2,
				),
				maxConnecting: resolveOptionalPositiveIntegerSetting(
					mongoCfg?.maxConnecting,
					"MEMONGO_MONGODB_MAX_CONNECTING",
				),
				maxIdleTimeMs: resolveOptionalPositiveIntegerSetting(
					mongoCfg?.maxIdleTimeMs,
					"MEMONGO_MONGODB_MAX_IDLE_TIME_MS",
				),
				networkFamily: resolveOptionalMongoNetworkFamily(
					mongoCfg?.networkFamily,
					"MEMONGO_MONGODB_NETWORK_FAMILY",
				),
				socketTimeoutMs: resolveOptionalPositiveIntegerSetting(
					mongoCfg?.socketTimeoutMs,
					"MEMONGO_MONGODB_SOCKET_TIMEOUT_MS",
				),
				serverSelectionTimeoutMs: resolvePositiveIntegerSetting(
					mongoCfg?.serverSelectionTimeoutMs,
					"MEMONGO_MONGODB_SERVER_SELECTION_TIMEOUT_MS",
					resolvePositiveIntegerSetting(
						mongoCfg?.connectTimeoutMs,
						"MEMONGO_MONGODB_CONNECT_TIMEOUT_MS",
						10_000,
					),
				),
				heartbeatFrequencyMs: resolveOptionalPositiveIntegerSetting(
					mongoCfg?.heartbeatFrequencyMs,
					"MEMONGO_MONGODB_HEARTBEAT_FREQUENCY_MS",
				),
				serverMonitoringMode: resolveOptionalMongoServerMonitoringMode(
					mongoCfg?.serverMonitoringMode,
					"MEMONGO_MONGODB_SERVER_MONITORING_MODE",
				),
				waitQueueTimeoutMs: resolveOptionalPositiveIntegerSetting(
					mongoCfg?.waitQueueTimeoutMs,
					"MEMONGO_MONGODB_WAIT_QUEUE_TIMEOUT_MS",
				),
				embeddingCacheTtlDays:
					typeof mongoCfg?.embeddingCacheTtlDays === "number" &&
					Number.isFinite(mongoCfg.embeddingCacheTtlDays) &&
					mongoCfg.embeddingCacheTtlDays >= 0
						? Math.floor(mongoCfg.embeddingCacheTtlDays)
						: 30,
				memoryTtlDays:
					typeof mongoCfg?.memoryTtlDays === "number" &&
					Number.isFinite(mongoCfg.memoryTtlDays) &&
					mongoCfg.memoryTtlDays >= 0
						? Math.floor(mongoCfg.memoryTtlDays)
						: 0,
				enableChangeStreams: mongoCfg?.enableChangeStreams === true,
				changeStreamDebounceMs:
					typeof mongoCfg?.changeStreamDebounceMs === "number" &&
					Number.isFinite(mongoCfg.changeStreamDebounceMs) &&
					mongoCfg.changeStreamDebounceMs >= 0
						? Math.floor(mongoCfg.changeStreamDebounceMs)
						: 1000,
				connectTimeoutMs: resolvePositiveIntegerSetting(
					mongoCfg?.connectTimeoutMs,
					"MEMONGO_MONGODB_CONNECT_TIMEOUT_MS",
					10_000,
				),
				numCandidates: Math.min(
					typeof mongoCfg?.numCandidates === "number" &&
						Number.isFinite(mongoCfg.numCandidates) &&
						mongoCfg.numCandidates > 0
						? Math.floor(mongoCfg.numCandidates)
						: resolveEnvInt("MEMONGO_NUM_CANDIDATES", 500),
					10_000, // F1: hard cap at MongoDB's max numCandidates
				),
				maxSessionChunks:
					typeof mongoCfg?.maxSessionChunks === "number" &&
					Number.isFinite(mongoCfg.maxSessionChunks) &&
					mongoCfg.maxSessionChunks > 0
						? Math.floor(mongoCfg.maxSessionChunks)
						: 50,
				kb: {
					enabled: mongoCfg?.kb?.enabled !== false,
					chunking: {
						tokens:
							typeof mongoCfg?.kb?.chunking?.tokens === "number" &&
							Number.isFinite(mongoCfg.kb.chunking.tokens) &&
							mongoCfg.kb.chunking.tokens > 0
								? Math.floor(mongoCfg.kb.chunking.tokens)
								: 600,
						overlap:
							typeof mongoCfg?.kb?.chunking?.overlap === "number" &&
							Number.isFinite(mongoCfg.kb.chunking.overlap) &&
							mongoCfg.kb.chunking.overlap >= 0
								? Math.floor(mongoCfg.kb.chunking.overlap)
								: 100,
					},
					autoImportPaths: Array.isArray(mongoCfg?.kb?.autoImportPaths)
						? mongoCfg.kb.autoImportPaths.filter(
								(p): p is string =>
									typeof p === "string" && p.trim().length > 0,
							)
						: [],
					maxDocumentSize:
						typeof mongoCfg?.kb?.maxDocumentSize === "number" &&
						Number.isFinite(mongoCfg.kb.maxDocumentSize) &&
						mongoCfg.kb.maxDocumentSize > 0
							? Math.floor(mongoCfg.kb.maxDocumentSize)
							: 10 * 1024 * 1024,
					autoRefreshHours:
						typeof mongoCfg?.kb?.autoRefreshHours === "number" &&
						Number.isFinite(mongoCfg.kb.autoRefreshHours) &&
						mongoCfg.kb.autoRefreshHours >= 0
							? mongoCfg.kb.autoRefreshHours
							: 24,
				},
				relevance: {
					enabled: mongoCfg?.relevance?.enabled !== false,
					telemetry: {
						enabled: mongoCfg?.relevance?.telemetry?.enabled !== false,
						baseSampleRate:
							typeof mongoCfg?.relevance?.telemetry?.baseSampleRate ===
								"number" &&
							Number.isFinite(mongoCfg.relevance.telemetry.baseSampleRate)
								? Math.min(
										1,
										Math.max(0, mongoCfg.relevance.telemetry.baseSampleRate),
									)
								: 0.01,
						adaptive: {
							enabled:
								mongoCfg?.relevance?.telemetry?.adaptive?.enabled !== false,
							maxSampleRate:
								typeof mongoCfg?.relevance?.telemetry?.adaptive
									?.maxSampleRate === "number" &&
								Number.isFinite(
									mongoCfg.relevance.telemetry.adaptive.maxSampleRate,
								)
									? Math.min(
											1,
											Math.max(
												0,
												mongoCfg.relevance.telemetry.adaptive.maxSampleRate,
											),
										)
									: 0.1,
							minWindowSize:
								typeof mongoCfg?.relevance?.telemetry?.adaptive
									?.minWindowSize === "number" &&
								Number.isFinite(
									mongoCfg.relevance.telemetry.adaptive.minWindowSize,
								) &&
								mongoCfg.relevance.telemetry.adaptive.minWindowSize > 0
									? Math.floor(
											mongoCfg.relevance.telemetry.adaptive.minWindowSize,
										)
									: 200,
						},
						persistRawExplain:
							mongoCfg?.relevance?.telemetry?.persistRawExplain !== false,
						queryPrivacyMode:
							mongoCfg?.relevance?.telemetry?.queryPrivacyMode === "raw" ||
							mongoCfg?.relevance?.telemetry?.queryPrivacyMode === "none"
								? mongoCfg.relevance.telemetry.queryPrivacyMode
								: "redacted-hash",
					},
					retention: {
						days:
							typeof mongoCfg?.relevance?.retention?.days === "number" &&
							Number.isFinite(mongoCfg.relevance.retention.days) &&
							mongoCfg.relevance.retention.days > 0
								? Math.floor(mongoCfg.relevance.retention.days)
								: 14,
					},
					benchmark: {
						enabled: mongoCfg?.relevance?.benchmark?.enabled !== false,
						datasetPath:
							typeof mongoCfg?.relevance?.benchmark?.datasetPath === "string" &&
							mongoCfg.relevance.benchmark.datasetPath.trim().length > 0
								? resolveUserPath(
										mongoCfg.relevance.benchmark.datasetPath.trim(),
									)
								: resolveUserPath(DEFAULT_RELEVANCE_DATASET),
					},
				},
				episodes: {
					enabled: mongoCfg?.episodes?.enabled !== false,
					minEventsForEpisode:
						typeof mongoCfg?.episodes?.minEventsForEpisode === "number" &&
						Number.isFinite(mongoCfg.episodes.minEventsForEpisode) &&
						mongoCfg.episodes.minEventsForEpisode > 0
							? Math.floor(mongoCfg.episodes.minEventsForEpisode)
							: 10,
				},
				graph: {
					enabled: mongoCfg?.graph?.enabled !== false,
					maxGraphDepth:
						typeof mongoCfg?.graph?.maxGraphDepth === "number" &&
						Number.isFinite(mongoCfg.graph.maxGraphDepth) &&
						mongoCfg.graph.maxGraphDepth > 0
							? Math.floor(mongoCfg.graph.maxGraphDepth)
							: 2,
					entityExtraction: {
						method: mongoCfg?.graph?.entityExtraction?.method ?? "regex",
						model: mongoCfg?.graph?.entityExtraction?.model,
						timeoutMs:
							typeof mongoCfg?.graph?.entityExtraction?.timeoutMs ===
								"number" &&
							Number.isFinite(mongoCfg.graph.entityExtraction.timeoutMs) &&
							mongoCfg.graph.entityExtraction.timeoutMs > 0
								? Math.floor(mongoCfg.graph.entityExtraction.timeoutMs)
								: 5000,
					},
				},
				queryRewriting: {
					enabled: mongoCfg?.queryRewriting?.enabled === true,
					method: mongoCfg?.queryRewriting?.method ?? "synonym-expansion",
					maxTokens:
						typeof mongoCfg?.queryRewriting?.maxTokens === "number" &&
						Number.isFinite(mongoCfg.queryRewriting.maxTokens) &&
						mongoCfg.queryRewriting.maxTokens > 0
							? Math.floor(mongoCfg.queryRewriting.maxTokens)
							: 128,
				},
				reranking: {
					enabled: resolveEnvBoolean(
						"MEMONGO_RERANKING_ENABLED",
						mongoCfg?.reranking?.enabled !== false,
					),
					model: mongoCfg?.reranking?.model ?? "rerank-2.5",
					topN:
						typeof mongoCfg?.reranking?.topN === "number" &&
						Number.isFinite(mongoCfg.reranking.topN) &&
						mongoCfg.reranking.topN > 0
							? Math.floor(mongoCfg.reranking.topN)
							: 20,
					minScore:
						typeof mongoCfg?.reranking?.minScore === "number" &&
						Number.isFinite(mongoCfg.reranking.minScore)
							? Math.min(1, Math.max(0, mongoCfg.reranking.minScore))
							: resolveEnvFloat("MEMONGO_RERANK_MIN_SCORE", 0.01),
					voyageApiKey:
						mongoCfg?.reranking?.voyageApiKey ??
						process.env.VOYAGE_API_KEY ??
						"",
					instruction: mongoCfg?.reranking?.instruction,
				},
				cache: {
					enabled: mongoCfg?.cache?.enabled !== false,
					conversationTtlSec: mongoCfg?.cache?.conversationTtlSec ?? 300,
					kbTtlSec: mongoCfg?.cache?.kbTtlSec ?? 3600,
					similarityThreshold: mongoCfg?.cache?.similarityThreshold ?? 0.95,
				},
				sources: {
					reference: {
						enabled: params.cfg.memory?.sources?.reference?.enabled !== false,
					},
					conversation: {
						enabled:
							params.cfg.memory?.sources?.conversation?.enabled !== false,
					},
					structured: {
						enabled: params.cfg.memory?.sources?.structured?.enabled !== false,
					},
				},
			},
		}
		const mongodb = result.mongodb
		if (
			mongodb &&
			mongodb.relevance.telemetry.adaptive.maxSampleRate <
				mongodb.relevance.telemetry.baseSampleRate
		) {
			mongodb.relevance.telemetry.adaptive.maxSampleRate =
				mongodb.relevance.telemetry.baseSampleRate
		}

		// F22: numDimensions validation warning — check if configured dimensions
		// match known model dimensions for the default embedding model
		const resolvedNumDims = mongodb?.numDimensions
		const defaultModel = "voyage-4-large"
		const expectedDims = KNOWN_MODEL_DIMENSIONS[defaultModel]
		if (
			mongoCfg?.numDimensions &&
			expectedDims &&
			resolvedNumDims !== expectedDims
		) {
			log.warn(
				`numDimensions=${resolvedNumDims} may not match expected dimensions for ${defaultModel} (${expectedDims}). ` +
					"Mismatched dimensions will cause vector search errors.",
			)
		}

		// H2 audit fix: warn when entity extraction method is 'llm' but no LLM function injected
		if (mongodb?.graph.entityExtraction.method === "llm") {
			log.warn(
				"entity extraction method 'llm' configured but LLM function not injected — regex extractor will be used at runtime. " +
					"Set graph.entityExtraction.method to 'regex' to suppress this warning.",
			)
		}

		return result
	}

	throw new Error(`Unsupported memory backend: ${String(backend)}`)
}

// ---------------------------------------------------------------------------
// Env-var overrides for recall-oriented threshold ablation
// ---------------------------------------------------------------------------

function resolveEnvInt(envKey: string, fallback: number): number {
	const raw = process.env[envKey]
	if (raw === undefined || raw === "") return fallback
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolvePositiveIntegerSetting(
	configValue: unknown,
	envKey: string,
	fallback: number,
): number {
	const envValue = resolveOptionalPositiveIntegerEnv(envKey)
	if (envValue !== undefined) return envValue
	if (
		typeof configValue === "number" &&
		Number.isFinite(configValue) &&
		configValue > 0
	) {
		return Math.floor(configValue)
	}
	return fallback
}

function resolveNonNegativeIntegerSetting(
	configValue: unknown,
	envKey: string,
	fallback: number,
): number {
	const envRaw = process.env[envKey]
	if (envRaw !== undefined && envRaw !== "") {
		const parsed = Number.parseInt(envRaw, 10)
		if (Number.isFinite(parsed) && parsed >= 0) return parsed
		return fallback
	}
	if (
		typeof configValue === "number" &&
		Number.isFinite(configValue) &&
		configValue >= 0
	) {
		return Math.floor(configValue)
	}
	return fallback
}

function resolveOptionalPositiveIntegerSetting(
	configValue: unknown,
	envKey: string,
): number | undefined {
	const envValue = resolveOptionalPositiveIntegerEnv(envKey)
	if (envValue !== undefined) return envValue
	if (
		typeof configValue === "number" &&
		Number.isFinite(configValue) &&
		configValue > 0
	) {
		return Math.floor(configValue)
	}
	return undefined
}

function resolveOptionalPositiveIntegerEnv(envKey: string): number | undefined {
	const raw = process.env[envKey]
	if (raw === undefined || raw === "") return undefined
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function resolveOptionalMongoNetworkFamily(
	configValue: unknown,
	envKey: string,
): 4 | 6 | undefined {
	const raw = process.env[envKey]?.trim()
	if (raw === "4" || raw === "6") return Number.parseInt(raw, 10) as 4 | 6
	if (configValue === 4 || configValue === 6) return configValue
	return undefined
}

function resolveOptionalMongoServerMonitoringMode(
	configValue: unknown,
	envKey: string,
): "auto" | "stream" | "poll" | undefined {
	const raw = process.env[envKey]?.trim()
	if (raw === "auto" || raw === "stream" || raw === "poll") return raw
	if (
		configValue === "auto" ||
		configValue === "stream" ||
		configValue === "poll"
	) {
		return configValue
	}
	return undefined
}

function resolveEnvFloat(envKey: string, fallback: number): number {
	const raw = process.env[envKey]
	if (raw === undefined || raw === "") return fallback
	const parsed = Number.parseFloat(raw)
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
		? parsed
		: fallback
}

function resolveEnvBoolean(envKey: string, fallback: boolean): boolean {
	const raw = process.env[envKey]?.trim().toLowerCase()
	if (!raw) return fallback
	if (["1", "true", "yes", "on", "enabled"].includes(raw)) return true
	if (["0", "false", "no", "off", "disabled"].includes(raw)) return false
	return fallback
}

function resolveEnvFusionMethod(
	envKey: string,
	fallback: MemoryMongoDBFusionMethod,
): MemoryMongoDBFusionMethod {
	const raw = process.env[envKey]?.trim()
	if (raw === "rankFusion" || raw === "scoreFusion" || raw === "js-merge") {
		return raw
	}
	return fallback
}

function resolveEnvRecallProfile(
	envKey: string,
	fallback: MemoryMongoDBRecallProfile,
): MemoryMongoDBRecallProfile {
	const raw = process.env[envKey]?.trim()
	if (raw === "latency" || raw === "balanced" || raw === "proof") {
		return raw
	}
	return fallback
}
