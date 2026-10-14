/**
 * The covered settings of a benchmark run configuration (B02). The producer
 * (`snapshotBenchmarkRunConfiguration`) builds its settings from these lists
 * and readers require exactly this key set with these value contracts, so a
 * self-consistent hash over an incomplete or malformed manifest is not
 * accepted as coverage. Changing any list changes coverage: bump the marker.
 */
import {
	JUDGE_AUTH_STYLES,
	JUDGE_TOKEN_PARAMS,
} from "./longmemeval-official-scoring.js"

/** Hash-bound coverage marker; a manifest of another coverage never verifies. */
export const BENCHMARK_CONFIGURATION_COVERAGE = "b02-keyed-v1"

/** Raw env inputs, recorded trimmed or null as `env.<KEY>`. */
export const BENCHMARK_CONFIGURATION_ENV_KEYS = [
	// B1: the answerer and the extraction LLM are separately
	// configurable, so both must be part of the scenario identity.
	"MEMONGO_BENCHMARK_ANSWER_ALLOW_PRIVATE_NETWORK",
	"MEMONGO_BENCHMARK_ANSWER_AUTH_STYLE",
	"MEMONGO_BENCHMARK_ANSWER_MODEL",
	"MEMONGO_BENCHMARK_ANSWER_PROVIDER",
	"MEMONGO_BENCHMARK_ANSWER_TOKEN_PARAM",
	"MEMONGO_BENCHMARK_STRICT",
	"MEMONGO_BENCHMARK_DERIVED_WORK_MODE",
	"MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS",
	"MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS",
	"MEMONGO_BENCHMARK_FAST_INGEST",
	"MEMONGO_BENCHMARK_FAST_INGEST_BATCH_SIZE",
	// The official judge resolver reads these directly; omitting them let
	// two runs graded by different judges share one identity.
	"MEMONGO_BENCHMARK_JUDGE_AUTH_STYLE",
	"MEMONGO_BENCHMARK_JUDGE_MODEL",
	"MEMONGO_BENCHMARK_JUDGE_TOKEN_PARAM",
	"MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA",
	"MEMONGO_BENCHMARK_MEASUREMENT_PASSES",
	"MEMONGO_BENCHMARK_QA_PROTOCOL",
	"MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS",
	"MEMONGO_BENCHMARK_RETRY_ATTEMPTS",
	"MEMONGO_BENCHMARK_RETRY_BASE_DELAY_MS",
	"MEMONGO_BENCHMARK_RETRY_MAX_DELAY_MS",
	"MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE",
	"MEMONGO_BENCHMARK_TURN_PRECISION_MODE",
	"MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS",
	"MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS",
	"MEMONGO_ENRICHMENT_CONCURRENCY",
	"MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK",
	"MEMONGO_ENRICHMENT_AUTH_STYLE",
	"MEMONGO_ENRICHMENT_MODEL",
	"MEMONGO_ENRICHMENT_PROVIDER",
	"MEMONGO_ENRICHMENT_TOKEN_PARAM",
	"MEMONGO_EVIDENCE_SETTLE_MS",
	"MEMONGO_EVIDENCE_MIRROR_MODE",
	// B1: extraction-off changes what gets written, so it must not
	// hash identically to an extraction-on run.
	"MEMONGO_EXTRACTION_LLM",
	"MEMONGO_LLM_ENRICHMENT_MAX_RETRIES",
	"MEMONGO_LLM_ENRICHMENT_MAX_TOKENS",
	"MEMONGO_LLM_ENRICHMENT_MODE",
	"MEMONGO_LLM_ENRICHMENT_STRICT",
	"MEMONGO_LLM_ENRICHMENT_TIMEOUT_MS",
	"MEMONGO_PREFERENCE_EVIDENCE_MODE",
	"MEMONGO_QUERY_DECOMPOSITION_MODE",
	// #66: reranking costs ~715ms of p95 and changes ranking, so a
	// rerank-off run must not hash identically to a rerank-on one.
	"MEMONGO_RERANKING_ENABLED",
	"MEMONGO_RERANK_MIN_SCORE",
	"MEMONGO_RERANK_STRICT",
	"MEMONGO_SCORING_ABLATION",
	"MEMONGO_SEARCH_MAX_TIME_MS",
	"MEMONGO_SESSION_EVIDENCE_MODE",
	"MEMONGO_STRICT_SEARCH_INDEX_READY",
	"MEMONGO_TEMPORAL_COVERAGE_MODE",
	"MEMONGO_USERFACT_EVIDENCE_MODE",
	"MEMONGO_VECTOR_INDEXING_METHOD",
	"MEMONGO_VECTOR_STORED_SOURCE",
] as const

/**
 * Credentials and endpoints, recorded only as `env.<KEY>.hmac`: a keyed
 * fingerprint of the effective value under the operator's fingerprint key, so
 * a different answerer, enrichment provider or judge cannot share an identity
 * and a guessed value cannot be confirmed without the key.
 */
export const BENCHMARK_CONFIGURATION_FINGERPRINT_KEYS = [
	"MEMONGO_ENRICHMENT_API_KEY",
	"MEMONGO_BENCHMARK_ANSWER_API_KEY",
	"MEMONGO_ENRICHMENT_BASE_URL",
	"MEMONGO_BENCHMARK_ANSWER_BASE_URL",
	"MEMONGO_BENCHMARK_JUDGE_API_KEY",
	"MEMONGO_BENCHMARK_JUDGE_BASE_URL",
] as const

type Contract = (value: unknown) => boolean

const SHA256_HEX = /^[0-9a-f]{64}$/
const scalar: Contract = (value) =>
	value === null ||
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value))
const sha256: Contract = (value) =>
	typeof value === "string" && SHA256_HEX.test(value)
const nullable =
	(contract: Contract): Contract =>
	(value) =>
		value === null || contract(value)
const oneOf =
	(allowed: Iterable<string>): Contract =>
	(value) =>
		typeof value === "string" && new Set(allowed).has(value)
// Recorded as `value.trim() || null`, so text is never blank or padded.
const trimmedText: Contract = (value) =>
	typeof value === "string" && value.length > 0 && value.trim() === value

/** Resolved settings; identity-bearing digests carry their own contract. */
const RESOLVED_CONTRACTS: Record<string, Contract> = {
	configurationCoverage: (value) => value === BENCHMARK_CONFIGURATION_COVERAGE,
	qualityContractId: scalar,
	qualityContractVersion: scalar,
	deploymentIdentitySha256: sha256,
	collectionPrefix: scalar,
	deploymentProfile: scalar,
	numCandidates: scalar,
	fusionMethod: scalar,
	embeddingMode: scalar,
	queryEmbeddingModel: scalar,
	conversationEvidenceMode: scalar,
	embeddingDimensions: scalar,
	embeddingQuantization: scalar,
	rerankerEnabled: scalar,
	rerankerModel: scalar,
	rerankerTopN: scalar,
	rerankerMinScore: scalar,
	rerankerRecencyBoost: scalar,
	rerankerAccessBoost: scalar,
	rerankerInstructionSha256: nullable(sha256),
	rerankerApiKeyHmac: nullable(sha256),
	credentialFingerprintKeyId: sha256,
	queryRewritingEnabled: scalar,
	queryRewritingMethod: scalar,
	queryRewritingMaxTokens: scalar,
	conversationSourceEnabled: scalar,
	referenceSourceEnabled: scalar,
	structuredSourceEnabled: scalar,
	kbEnabled: scalar,
	graphEnabled: scalar,
	graphMaxDepth: scalar,
	graphEntityExtractionMethod: scalar,
	graphEntityExtractionModel: scalar,
	graphEntityExtractionTimeoutMs: scalar,
	episodesEnabled: scalar,
	episodesMinEvents: scalar,
	vectorSearchCapability: scalar,
	textSearchCapability: scalar,
	scoreFusionCapability: scalar,
	rankFusionCapability: scalar,
	searchBudgetMaxAggregations: scalar,
	searchBudgetMaxEmbeds: scalar,
	userSearchMaxTimeMs: scalar,
	effectiveTextSearchSettleTimeoutMs: scalar,
	effectiveVectorSearchSettleTimeoutMs: scalar,
	answerProviderSource: oneOf(["dedicated", "enrichment-fallback"]),
}

const ENV_CONTRACTS: Partial<Record<string, Contract>> = {
	MEMONGO_BENCHMARK_QA_PROTOCOL: oneOf([
		"official",
		"custom-judge",
		"custom-v1",
	]),
	MEMONGO_BENCHMARK_JUDGE_AUTH_STYLE: oneOf(JUDGE_AUTH_STYLES),
	MEMONGO_BENCHMARK_JUDGE_TOKEN_PARAM: oneOf(JUDGE_TOKEN_PARAMS),
}

const SETTING_CONTRACTS: ReadonlyMap<string, Contract> = new Map([
	...Object.entries(RESOLVED_CONTRACTS),
	...BENCHMARK_CONFIGURATION_ENV_KEYS.map(
		(key) =>
			[`env.${key}`, nullable(ENV_CONTRACTS[key] ?? trimmedText)] as const,
	),
	...BENCHMARK_CONFIGURATION_FINGERPRINT_KEYS.map(
		(key) => [`env.${key}.hmac`, nullable(sha256)] as const,
	),
])

/** Every covered setting key, in no particular order. */
export const BENCHMARK_CONFIGURATION_SETTING_KEYS: readonly string[] = [
	...SETTING_CONTRACTS.keys(),
]

const DURABLE_PROTOCOLS = new Set(["official", "custom-judge"])

/**
 * True when settings hold exactly the covered keys, each value meets its
 * contract, and the cross-field facts the producer guarantees hold: the
 * answerer source matches whether a dedicated key was fingerprinted, and a
 * durable QA protocol has the judge model, key and endpoint its resolver
 * requires. Says nothing about whether the values are authentic.
 */
export function hasCompleteConfigurationCoverage(
	settings: Record<string, unknown>,
): boolean {
	const keys = Object.keys(settings)
	if (
		keys.length !== SETTING_CONTRACTS.size ||
		!keys.every((key) => SETTING_CONTRACTS.get(key)?.(settings[key]))
	)
		return false
	const dedicated =
		settings["env.MEMONGO_BENCHMARK_ANSWER_API_KEY.hmac"] !== null
	if ((settings.answerProviderSource === "dedicated") !== dedicated)
		return false
	return (
		!DURABLE_PROTOCOLS.has(
			String(settings["env.MEMONGO_BENCHMARK_QA_PROTOCOL"]),
		) ||
		[
			"env.MEMONGO_BENCHMARK_JUDGE_MODEL",
			"env.MEMONGO_BENCHMARK_JUDGE_API_KEY.hmac",
			"env.MEMONGO_BENCHMARK_JUDGE_BASE_URL.hmac",
		].every((key) => settings[key] !== null)
	)
}
