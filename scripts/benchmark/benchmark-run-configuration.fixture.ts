import {
	type OperationRunConfiguration,
	hashOperationRunConfiguration,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"

/** Synthetic resolved host for the real configuration producer (no network). */
export const SYNTHETIC_BENCHMARK_HOST = {
	prefix: "p_",
	requiredManifest: [{ name: "p_chunks_vector" }, { name: "p_chunks_text" }],
	deploymentFacts: { scoreFusion: true, rankFusion: true },
	config: {
		mongodb: {
			uri: "mongodb://synthetic.invalid:27017",
			database: "db",
			// The resolver's defaults; optional client inputs stay unset.
			serverSelectionTimeoutMs: 10_000,
			connectTimeoutMs: 10_000,
			maxPoolSize: 10,
			minPoolSize: 2,
			collectionPrefix: "p_",
			deploymentProfile: "synthetic",
			numCandidates: 100,
			fusionMethod: "rrf",
			embeddingMode: "auto",
			queryEmbeddingModel: "embed",
			conversationEvidenceMode: "off",
			numDimensions: 1024,
			quantization: "int8",
			reranking: { enabled: false },
			queryRewriting: { enabled: false, method: "none", maxTokens: 0 },
			sources: {
				conversation: { enabled: true },
				reference: { enabled: false },
				structured: { enabled: false },
			},
			kb: { enabled: false },
			graph: {
				enabled: false,
				maxGraphDepth: 1,
				entityExtraction: { method: "none", timeoutMs: 1 },
			},
			episodes: { enabled: false, minEventsForEpisode: 1 },
		},
	},
}

/** Synthetic credential fingerprint key; never a real secret. */
export const SYNTHETIC_FINGERPRINT_KEY = "5e".repeat(32)

/**
 * The real producer's configuration under exactly `env` (other MEMONGO_*
 * variables cleared for the call, the synthetic fingerprint key supplied
 * unless `env` sets its own), with its hash. Restores process.env.
 */
export function producedRunConfiguration(env: Record<string, string> = {}): {
	configuration: OperationRunConfiguration
	configurationHash: string
} {
	const saved = { ...process.env }
	try {
		for (const key of Object.keys(process.env))
			if (key.startsWith("MEMONGO_")) delete process.env[key]
		Object.assign(
			process.env,
			{ MEMONGO_BENCHMARK_FINGERPRINT_KEY: SYNTHETIC_FINGERPRINT_KEY },
			env,
		)
		const configuration = new MongoDBManagerBenchmarkScenarioOps(
			SYNTHETIC_BENCHMARK_HOST as never,
		).snapshotBenchmarkRunConfiguration({
			executionProfile: "shipped",
			retrievalLane: "native",
			maxResults: 10,
			minScore: 0.01,
		})
		return {
			configuration,
			configurationHash: hashOperationRunConfiguration(configuration),
		}
	} finally {
		process.env = saved
	}
}
