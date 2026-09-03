import {
	type MemongoConfig,
	type MemoryCitationsMode,
	type MemoryMongoDBDeploymentProfile,
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBQueryEmbeddingModel,
	type MemoryMongoDBRecallProfile,
	type MemoryScope,
	applyMongoDbForceUriOverride,
	createSubsystemLogger,
	resolveUserPath,
} from "@memongo/lib"
import { resolveSearchBudgetLimits } from "./mongodb-search-budget.js"
import {
	type ConversationEvidenceMode,
	resolveConversationEvidenceMode,
} from "./mongodb-conversation-evidence-mode.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"

const log = createSubsystemLogger("memory:backend-config")

// Known embedding model dimensions for numDimensions validation (F22)
// Exported for use by embedding-validation guardrails (dimension consistency check).
export const KNOWN_MODEL_DIMENSIONS: Record<string, number> = {
	"voyage-4-large": 1024,
	"voyage-4": 1024,
	"voyage-4-lite": 1024,
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
	queryEmbeddingModel: MemoryMongoDBQueryEmbeddingModel
	conversationEvidenceMode: ConversationEvidenceMode
	fusionMethod: MemoryMongoDBFusionMethod
	recallProfile: MemoryMongoDBRecallProfile
	quantization: "none" | "scalar" | "binary"
	watchDebounceMs: number
	/**
	 * Dead knob under autoEmbed (fix-plan-2026-08-03 P3.2): Atlas/Voyage
	 * decide the dimensions server-side; this value only flows into validator
	 * warnings and the generic index preset. Setting it logs an error.
	 */
	numDimensions: number
	/**
	 * P3.2: opt-in legacySearch re-run after searchV2 returns empty or
	 * errors. Default OFF — "empty ≠ error": the v2 empty answer stands.
	 */
	legacySearchFallback: boolean
	/**
	 * P3.2: resolved per-search cost budget (mongodb-search-budget.ts) —
	 * user overrides applied over DEFAULT_SEARCH_BUDGET, always populated.
	 */
	searchBudget: {
		maxAggregations: number
		maxEmbeds: number
	}
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
	memoryTtlDays: number
	/**
	 * P4.4.1: optional per-document TTL (memory.mongodb.ttl). Always
	 * populated; `enabled` is the explicit opt-in (off by default).
	 */
	ttl: {
		enabled: boolean
		sessionDays: number
	}
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
		recencyBoost: number
		accessBoost: number
		temporalProximityBoost: number
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
// C-007 / EL-002 F2: the default query model must be the same model the
// autoEmbed index definitions pin (INDEX_AUTOEMBED_MODEL), derived rather
// than duplicated so a model change cannot strand query-side defaults.
const DEFAULT_QUERY_EMBEDDING_MODEL: MemoryMongoDBQueryEmbeddingModel =
	INDEX_AUTOEMBED_MODEL

/**
 * C-007 (EL-002 F1): the embedding pipeline's supported-target contract.
 *
 * Memongo's vector pipeline runs exclusively on Atlas Automated Embeddings
 * (server-side embedding at index time), which MongoDB ships as a Preview
 * feature. This declaration makes that posture an explicit, versioned
 * contract instead of an implicit accident:
 *
 * - Supported targets: deploymentProfile "atlas-local-preview" (the local
 *   atlas-local + mongot container stack) and "atlas-managed" (Atlas
 *   clusters), both accepting Preview semantics knowingly.
 * - The only supported embeddingMode is "automated" — client-side embedding
 *   has no implementation; the dead provider stack was removed with this
 *   contract, and no client-side fallback exists or is implied.
 * - A Preview deprecation or removal therefore surfaces as a loud startup
 *   failure (index creation or search), never as a silent client-side
 *   detour.
 *
 * assertEmbeddingPipelineSupport checks the resolved config against this
 * declaration, so the resolver and the contract cannot drift apart silently.
 */
export const EMBEDDING_PIPELINE_SUPPORT = {
	contractVersion: 1,
	embeddingMode: "automated" as MemoryMongoDBEmbeddingMode,
	deploymentProfiles: [
		"atlas-local-preview",
		"atlas-managed",
	] as readonly MemoryMongoDBDeploymentProfile[],
	featureStage: "preview-accepted" as const,
	clientSideFallback: "none" as const,
}

export function assertEmbeddingPipelineSupport(params: {
	deploymentProfile: MemoryMongoDBDeploymentProfile
	embeddingMode: MemoryMongoDBEmbeddingMode
}): void {
	if (
		params.embeddingMode !== EMBEDDING_PIPELINE_SUPPORT.embeddingMode ||
		!EMBEDDING_PIPELINE_SUPPORT.deploymentProfiles.includes(
			params.deploymentProfile,
		)
	) {
		throw new Error(
			[
				`embedding pipeline supported-target contract v${EMBEDDING_PIPELINE_SUPPORT.contractVersion} violated:`,
				`deploymentProfile "${params.deploymentProfile}" with embeddingMode "${params.embeddingMode}".`,
				`Supported: embeddingMode "${EMBEDDING_PIPELINE_SUPPORT.embeddingMode}" on deploymentProfile ${EMBEDDING_PIPELINE_SUPPORT.deploymentProfiles.map((profile) => `"${profile}"`).join(" or ")} — Atlas Automated Embeddings (${EMBEDDING_PIPELINE_SUPPORT.featureStage}); no client-side fallback exists.`,
			].join(" "),
		)
	}
}
/**
 * P2.1: shared default collection prefix. All agents share one physical
 * collection set; per-agent isolation stays logical (agentId leads every
 * document and index). Opt out with an explicit prefix.
 */
export const DEFAULT_MONGODB_COLLECTION_PREFIX = "memongo_"

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
		// P2.6: one URI precedence rule, shared with the bridge via
		// applyMongoDbForceUriOverride (@memongo/lib): MEMONGO_FORCE_MONGODB_URI
		// wins over every other URI source, in every layer. Among the
		// non-force sources an explicit memory.mongodb.uri is treated as
		// intentional and beats the plain MEMONGO_MONGODB_URI fallback.
		const configuredUri =
			typeof mongoCfg?.uri === "string" && mongoCfg.uri.trim()
				? mongoCfg.uri.trim()
				: undefined
		const uri = applyMongoDbForceUriOverride(
			process.env.MEMONGO_FORCE_MONGODB_URI,
			configuredUri || process.env.MEMONGO_MONGODB_URI?.trim(),
		)
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
		// P3.1: honor the configured embeddingMode (validated below against the
		// supported set) instead of hardcoding the default — "automated" stays
		// the default when unset.
		const rawEmbeddingMode =
			mongoCfg?.embeddingMode ?? DEFAULT_MONGODB_EMBEDDING_MODE
		const embeddingMode: MemoryMongoDBEmbeddingMode = rawEmbeddingMode
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
		// C-007 (EL-002 F1): cross-check the resolved pair against the declared
		// supported-target contract — the raw-input throws above stay the input
		// validation layer; this keeps the declaration and the resolver locked
		// together.
		assertEmbeddingPipelineSupport({ deploymentProfile, embeddingMode })
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

		// P3.1: numDimensions is a dead knob under autoEmbed — the embedding
		// model fixes the dimensions server-side. The value still resolves for
		// config-schema compat, but it is inert; say so loudly at error level.
		if (mongoCfg?.numDimensions !== undefined) {
			log.error(
				`memory.mongodb.numDimensions is ignored under embeddingMode "automated": the server-managed embedding model determines vector dimensions (configured value ${String(mongoCfg.numDimensions)} resolves for compatibility but has no effect)`,
			)
		}

		const result: ResolvedMemoryBackendConfig = {
			backend: "mongodb",
			citations,
			mongodb: {
				uri,
				database:
					(process.env.MEMONGO_MONGODB_DATABASE?.trim() || undefined) ??
					mongoCfg?.database ??
					"memongo",
				// P2.1: the default collection prefix is the shared `memongo_`
				// prefix — every document and index already leads with agentId, so
				// per-agent physical isolation is opt-in via an explicit prefix
				// (config `memory.mongodb.collectionPrefix` or
				// MEMONGO_MONGODB_COLLECTION_PREFIX). See
				// scripts/migrate-to-shared-prefix.ts for existing deployments.
				collectionPrefix:
					(envCollectionPrefix && envCollectionPrefix.length > 0
						? envCollectionPrefix
						: undefined) ??
					mongoCfg?.collectionPrefix ??
					DEFAULT_MONGODB_COLLECTION_PREFIX,
				deploymentProfile,
				embeddingMode,
				queryEmbeddingModel: resolveQueryEmbeddingModel(
					process.env.MEMONGO_QUERY_EMBEDDING_MODEL,
					mongoCfg?.queryEmbeddingModel,
				),
				conversationEvidenceMode: resolveConversationEvidenceMode(
					process.env.MEMONGO_CONVERSATION_EVIDENCE_MODE,
				),
				fusionMethod: resolveEnvFusionMethod(
					"MEMONGO_MONGODB_FUSION_METHOD",
					mongoCfg?.fusionMethod ?? "scoreFusion",
				),
				recallProfile: resolveEnvRecallProfile(
					"MEMONGO_MONGODB_RECALL_PROFILE",
					mongoCfg?.recallProfile ?? "balanced",
				),
				// P3.2: legacySearch re-runs the whole retrieval stack after
				// searchV2 — opt-in only, off by default (empty ≠ error).
				legacySearchFallback: mongoCfg?.legacySearchFallback ?? false,
				searchBudget: resolveSearchBudgetLimits(mongoCfg?.searchBudget),
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
				memoryTtlDays:
					typeof mongoCfg?.memoryTtlDays === "number" &&
					Number.isFinite(mongoCfg.memoryTtlDays) &&
					mongoCfg.memoryTtlDays >= 0
						? Math.floor(mongoCfg.memoryTtlDays)
						: 0,
				ttl: resolveTtlSettings(mongoCfg?.ttl),
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
					// Clamped ≤4: $graphLookup accumulates each seed's whole
					// transitive closure into one transitiveRelations array, so an
					// unclamped depth on a dense graph hard-errors the graph lane at
					// the 16 MiB document limit ($graphLookup ignores allowDiskUse
					// by design — no server setting can absorb it).
					maxGraphDepth:
						typeof mongoCfg?.graph?.maxGraphDepth === "number" &&
						Number.isFinite(mongoCfg.graph.maxGraphDepth) &&
						mongoCfg.graph.maxGraphDepth > 0
							? Math.min(Math.floor(mongoCfg.graph.maxGraphDepth), 4)
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
					// P3.7: post-cross-encoder recency/access boost weights. 0 is
					// the off-switch; non-finite or negative values fall back to
					// the default so a misconfigured weight cannot invert ranking.
					recencyBoost: resolveRerankBoostWeight(
						mongoCfg?.reranking?.recencyBoost,
					),
					accessBoost: resolveRerankBoostWeight(
						mongoCfg?.reranking?.accessBoost,
					),
					// P4.4.4: raw-window lane temporal-proximity weight. 0 is the
					// off-switch; the 0.1 default is deliberately smaller than
					// the post-CE boosts — it nudges ordering in one lane only.
					temporalProximityBoost: resolveRerankBoostWeight(
						mongoCfg?.reranking?.temporalProximityBoost,
						0.1,
					),
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
		const defaultModel = DEFAULT_QUERY_EMBEDDING_MODEL
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

// P3.7: boost weights must be finite and non-negative; anything else falls
// back to the default so a bad config cannot invert ranking.
function resolveRerankBoostWeight(
	value: number | undefined,
	fallback = 0.2,
): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback
}

const DEFAULT_TTL_SESSION_DAYS = 30

/**
 * P4.4.1: memory.mongodb.ttl — optional per-document TTL, off by default.
 * `sessionDays` must be a positive finite number; anything else falls back
 * to the 30-day default (with a warning when the caller DID supply a value)
 * so a misconfigured retention window can never silently become "expire
 * immediately" or "never expire".
 */
function resolveTtlSettings(ttlCfg?: {
	enabled?: boolean
	sessionDays?: number
}): { enabled: boolean; sessionDays: number } {
	const raw = ttlCfg?.sessionDays
	const valid = typeof raw === "number" && Number.isFinite(raw) && raw > 0
	if (raw !== undefined && !valid) {
		log.warn(
			`memory.mongodb.ttl.sessionDays "${String(raw)}" is not a positive number; falling back to ${DEFAULT_TTL_SESSION_DAYS} days`,
		)
	}
	return {
		enabled: ttlCfg?.enabled === true,
		sessionDays: valid ? (raw as number) : DEFAULT_TTL_SESSION_DAYS,
	}
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

function resolveQueryEmbeddingModel(
	envValue: string | undefined,
	configValue: unknown,
): MemoryMongoDBQueryEmbeddingModel {
	const value =
		(envValue?.trim() || undefined) ??
		configValue ??
		DEFAULT_QUERY_EMBEDDING_MODEL
	if (
		value === "voyage-4-large" ||
		value === "voyage-4" ||
		value === "voyage-4-lite"
	) {
		return value
	}
	throw new Error(
		`memory.mongodb.queryEmbeddingModel "${String(value)}" is not supported; use "voyage-4-large", "voyage-4", or "voyage-4-lite"`,
	)
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

const MEMORY_SCOPES: readonly MemoryScope[] = [
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
]

/**
 * P1.4: resolve `MEMONGO_SEARCH_DEFAULT_SCOPE` — the fallback scope for
 * SEARCH reads (searchV2 and its callers) when the caller passes no explicit
 * scope. Writes are unaffected. Lets single-user deployments search `global`
 * (or `user`) by default instead of the multi-tenant `agent` default, so
 * memories written under broader scopes stop being invisible.
 *
 * Unlike the fusion/recall envs above (which silently fall back), an invalid
 * value here throws — a typo'd scope would silently change retrieval
 * behavior, so it fails fast like the enum config settings in this file.
 * Note: scopes that require a reference (session/user/tenant) still need a
 * matching scopeRef at the call site; `global` and `workspace` work as-is.
 */
export function resolveSearchDefaultScope(
	envValue: string | undefined,
): MemoryScope {
	const raw = envValue?.trim()
	if (!raw) {
		return "agent"
	}
	if ((MEMORY_SCOPES as readonly string[]).includes(raw)) {
		return raw as MemoryScope
	}
	throw new Error(
		`MEMONGO_SEARCH_DEFAULT_SCOPE "${envValue}" is not a valid memory scope. Use one of: ${MEMORY_SCOPES.join(", ")}.`,
	)
}

/** D1/B3: a conflicting legacy pair warns once per process, not per operation. */
let lastDefaultScopeConflictWarned: string | undefined

/**
 * D1 (B3): the ONE default scope applied to BOTH reads and writes.
 *
 * `MEMONGO_SEARCH_DEFAULT_SCOPE` (P1.4) fixed read invisibility for
 * broader-scope memories but left writes defaulting to `agent`, so an
 * unscoped add landed in one partition while the unscoped search queried
 * another — no roundtrip. `MEMONGO_DEFAULT_SCOPE` generalizes the setting
 * to both directions.
 *
 * Precedence:
 *  1. `MEMONGO_DEFAULT_SCOPE` wins. If the legacy name is ALSO set with a
 *     different value, a warning is logged (once per process) and the new
 *     name still wins.
 *  2. The legacy `MEMONGO_SEARCH_DEFAULT_SCOPE` alone remains a READ alias
 *     for one deprecation window — pass `applyTo: "read"` to honor it or
 *     `"write"` to ignore it (writes keep the `agent` fallback so existing
 *     deployments don't silently start writing into new partitions).
 *  3. Neither set: `agent`.
 *
 * Explicit scope still wins at the call site, and a session identity still
 * implies the session scope — this is only the fallback. An invalid value
 * throws, same fail-fast contract as resolveSearchDefaultScope.
 */
export function resolveDefaultScope(params: {
	/** process.env.MEMONGO_DEFAULT_SCOPE */
	value?: string
	/** process.env.MEMONGO_SEARCH_DEFAULT_SCOPE (legacy) */
	legacyValue?: string
	/** Whether the legacy alias applies on this path. */
	applyTo: "read" | "write"
	warn?: (message: string) => void
}): MemoryScope {
	const raw = params.value?.trim()
	if (raw) {
		if ((MEMORY_SCOPES as readonly string[]).includes(raw)) {
			const legacyRaw = params.legacyValue?.trim()
			if (legacyRaw && legacyRaw !== raw) {
				const conflictKey = `${raw}|${legacyRaw}`
				if (lastDefaultScopeConflictWarned !== conflictKey) {
					lastDefaultScopeConflictWarned = conflictKey
					params.warn?.(
						`MEMONGO_DEFAULT_SCOPE ("${raw}") and legacy MEMONGO_SEARCH_DEFAULT_SCOPE ("${legacyRaw}") disagree; MEMONGO_DEFAULT_SCOPE wins. Remove the legacy name to silence this warning.`,
					)
				}
			}
			return raw as MemoryScope
		}
		throw new Error(
			`MEMONGO_DEFAULT_SCOPE "${params.value}" is not a valid memory scope. Use one of: ${MEMORY_SCOPES.join(", ")}.`,
		)
	}
	if (params.applyTo === "read") {
		return resolveSearchDefaultScope(params.legacyValue)
	}
	return "agent"
}
