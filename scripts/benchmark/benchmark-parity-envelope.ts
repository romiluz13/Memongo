/**
 * Task 1.A projection: populate parity fields for `benchmarkReport`.
 *
 * Phase 1 landed the TYPES in `types.ts` and the passthrough input in
 * `buildBenchmarkRunReport()`. Gate 3 canary proved the projection itself
 * was never wired — the runtime emitted `benchmarkReport` without
 * `datasetSha256`, `retrievalUnit`, `embedding`, `reranker`, `storage`,
 * `latency.p50`, or `cost.*`. This module fixes that.
 *
 * Single source of truth for:
 *   - `retrievalUnit` (engine-wide constant, no literal duplication)
 *   - dataset SHA-256 resolution (env override > computed-from-path)
 *   - embedding/reranker config projection from backend config
 *   - `collStats` → storage footprint (null-with-reason on atlas-local:preview)
 *   - latency p50/p95 over per-case samples
 *   - run-scoped cost counters
 */

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import type { Db } from "mongodb"
import type {
	BenchmarkEmbeddingConfig,
	BenchmarkEmbeddingQuantization,
	BenchmarkLatencyDistribution,
	BenchmarkRerankerConfig,
	BenchmarkRerankerStage,
	BenchmarkRetrievalUnit,
	BenchmarkStorageFootprint,
	BenchmarkTenantStorageMeasurement,
	MemoryBenchmarkDatasetKind,
} from "../../packages/memory-engine/src/types.js"
export {
	assertOperationRunConfiguration as assertBenchmarkRunConfiguration,
	createOperationRunContext as createBenchmarkRunContext,
	instrumentOperationProvider as instrumentBenchmarkProvider,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
export type {
	OperationRunAccounting as BenchmarkRunAccounting,
	OperationRunConfiguration as BenchmarkRunConfiguration,
	OperationRunContext as BenchmarkRunContext,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { INDEX_AUTOEMBED_MODEL } from "../../packages/memory-engine/src/mongodb-schema-search-definitions.js"
export { INDEX_AUTOEMBED_MODEL as BENCHMARK_AUTOEMBED_MODEL }

export async function collectBenchmarkTenantStorage(params: {
	db: Pick<Db, "collection">
	agentId: string
	collectionNames: string[]
}): Promise<BenchmarkTenantStorageMeasurement> {
	const collections: BenchmarkTenantStorageMeasurement["collections"] = []
	const failures: string[] = []
	for (const collectionName of params.collectionNames) {
		try {
			const rows = (await params.db
				.collection(collectionName)
				.aggregate([
					{ $match: { agentId: params.agentId } },
					{
						$group: {
							_id: null,
							documents: { $sum: 1 },
							logicalBytes: { $sum: { $bsonSize: "$$ROOT" } },
						},
					},
					{ $project: { _id: 0, documents: 1, logicalBytes: 1 } },
				])
				.toArray()) as Array<{ documents?: unknown; logicalBytes?: unknown }>
			const row = rows[0]
			const documents = row ? toNonNegativeNumber(row.documents) : 0
			const logicalBytes = row ? toNonNegativeNumber(row.logicalBytes) : 0
			if (documents === null || logicalBytes === null) {
				throw new Error("aggregation returned an unexpected shape")
			}
			collections.push({ collectionName, documents, logicalBytes })
		} catch (error) {
			failures.push(
				`${collectionName}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	if (failures.length > 0) {
		return {
			documents: null,
			logicalBytes: null,
			collections,
			unavailableReason: `tenant logical storage incomplete: ${failures.join("; ")}`,
		}
	}
	return {
		documents: collections.reduce((sum, entry) => sum + entry.documents, 0),
		logicalBytes: collections.reduce(
			(sum, entry) => sum + entry.logicalBytes,
			0,
		),
		collections,
	}
}

export type BenchmarkRetrievalLane = "native" | "raw-session"

export type BenchmarkExecutionProfile = "shipped" | "diagnostic"

/**
 * Engine-wide retrieval unit. Memongo retrieves over the `events` collection
 * (turn-level documents), so the unit is `turn`. Exported as a constant so
 * we never hardcode the literal in two places.
 */
export const BENCHMARK_RETRIEVAL_UNIT: BenchmarkRetrievalUnit = "turn"

export function resolveBenchmarkRetrievalLane(
	value?: string,
): BenchmarkRetrievalLane {
	const normalized = value?.trim().toLowerCase().replace(/_/g, "-")
	if (normalized === "raw-session" || normalized === "session") {
		return "raw-session"
	}
	return "native"
}

/**
 * Decides which execution profile a benchmark run uses.
 *
 * A `diagnostic` run writes session/userfact/preference evidence documents and
 * runs LLM enrichment that the shipped pipeline never performs — and the
 * shipped scorer then boosts exactly those documents
 * (mongodb-search-executor.ts lane multipliers). A number produced that way is
 * not a number about the shipped product.
 *
 * So `shipped` is the default and `diagnostic` costs an explicit, recorded
 * opt-in. This used to be inverted: the profile was derived solely from whether
 * a publication contract was supplied, so every run that simply forgot the flag
 * silently measured the augmented corpus.
 */
export function resolveBenchmarkExecutionProfile(params: {
	requested?: BenchmarkExecutionProfile
	retrievalLane?: BenchmarkRetrievalLane
	hasQualityContract?: boolean
}): BenchmarkExecutionProfile {
	const rawSessionLane = params.retrievalLane === "raw-session"
	if (params.requested === "diagnostic" && params.hasQualityContract) {
		throw new Error(
			"a publication quality contract cannot run in the diagnostic execution profile",
		)
	}
	if (params.requested === "shipped" && rawSessionLane) {
		throw new Error(
			"the raw-session retrieval lane retrieves over benchmark-only session evidence and cannot run in the shipped execution profile",
		)
	}
	if (params.requested) {
		return params.requested
	}
	// raw-session cannot describe the shipped pipeline by construction, so it is
	// diagnostic by nature rather than by choice.
	return rawSessionLane ? "diagnostic" : "shipped"
}

export function resolveRetrievalUnit(
	_datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query",
	retrievalLane: BenchmarkRetrievalLane = resolveBenchmarkRetrievalLane(
		process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE,
	),
): BenchmarkRetrievalUnit {
	if (retrievalLane === "raw-session") {
		return "session"
	}
	return BENCHMARK_RETRIEVAL_UNIT
}

// ---------------------------------------------------------------------------
// Dataset SHA-256 resolution
// ---------------------------------------------------------------------------

const SHA256_REGEX = /^[0-9a-f]{64}$/

export async function computeDatasetSha256FromPath(
	datasetPath: string,
): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const hash = createHash("sha256")
		const stream = createReadStream(datasetPath)
		stream.on("data", (chunk) => hash.update(chunk))
		stream.on("end", () => resolve(hash.digest("hex")))
		stream.on("error", (err) => reject(err))
	})
}

/** Hash dataset bytes and treat an override/env digest only as an assertion. */
export async function resolveDatasetSha256(params: {
	datasetPath: string | undefined
	override?: string
}): Promise<string> {
	if (!params.datasetPath) {
		throw new Error(
			"resolveDatasetSha256: dataset bytes are required to attest the SHA-256",
		)
	}
	const declared = params.override ?? process.env.MEMONGO_BENCHMARK_DATASET_SHA
	if (declared !== undefined && !SHA256_REGEX.test(declared)) {
		throw new Error(
			"resolveDatasetSha256: declared digest must be a 64-character lowercase SHA-256",
		)
	}
	const actual = await computeDatasetSha256FromPath(params.datasetPath)
	if (declared !== undefined && declared !== actual) {
		throw new Error(
			`resolveDatasetSha256: declared digest ${declared} does not match dataset bytes ${actual}`,
		)
	}
	return actual
}

// ---------------------------------------------------------------------------
// Embedding + reranker config projection
// ---------------------------------------------------------------------------

type ResolvedEmbeddingInput = {
	numDimensions: number
	quantization: "none" | "scalar" | "binary"
}

function projectQuantization(
	q: "none" | "scalar" | "binary",
): BenchmarkEmbeddingQuantization {
	if (q === "scalar") return "int8"
	if (q === "binary") return "binary"
	return "float32"
}

export function resolveBenchmarkEmbeddingConfig(
	mongoCfg: ResolvedEmbeddingInput,
): BenchmarkEmbeddingConfig {
	const envModel = process.env.MEMONGO_BENCHMARK_EMBEDDING_MODEL?.trim()
	const model =
		envModel && envModel.length > 0 ? envModel : INDEX_AUTOEMBED_MODEL
	return {
		model,
		dimensions: mongoCfg.numDimensions,
		quantization: projectQuantization(mongoCfg.quantization),
	}
}

type ResolvedRerankerInput = {
	enabled: boolean
	model: string
	topN: number
}

export function resolveBenchmarkRerankerConfig(
	cfg: ResolvedRerankerInput,
): BenchmarkRerankerConfig {
	const stage: BenchmarkRerankerStage = cfg.enabled ? "post-fusion" : "none"
	return {
		model: cfg.model,
		// Voyage SDK does not expose a version pin on rerank-2.5 today.
		version: null,
		stage,
	}
}

// ---------------------------------------------------------------------------
// Storage footprint via `db.command({ collStats })`
// ---------------------------------------------------------------------------

type CollStatsResponse = {
	size?: unknown
	totalIndexSize?: unknown
	storageSize?: unknown
}

function toNonNegativeNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null
	}
	return value
}

export async function collectStorageFootprint(params: {
	db: Pick<Db, "command">
	collectionName: string
	collectionNames?: string[]
	tenant?: BenchmarkStorageFootprint["tenant"]
}): Promise<BenchmarkStorageFootprint> {
	const collectionNames = params.collectionNames ?? [params.collectionName]
	const tenant = params.tenant ?? {
		documents: null,
		logicalBytes: null,
		collections: [],
		unavailableReason: "benchmark tenant measurement was not provided",
	}
	const collections: BenchmarkStorageFootprint["sharedPhysical"]["collections"] =
		[]
	for (const collectionName of collectionNames) {
		try {
			const stats = (await params.db.command({
				collStats: collectionName,
			})) as CollStatsResponse
			const collectionBytes = toNonNegativeNumber(stats.size)
			const indexBytes = toNonNegativeNumber(stats.totalIndexSize)
			collections.push(
				collectionBytes === null || indexBytes === null
					? {
							collectionName,
							collectionBytes: null,
							indexBytes: null,
							unavailableReason:
								"collStats returned unexpected shape on atlas-local:preview",
						}
					: { collectionName, collectionBytes, indexBytes },
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			collections.push({
				collectionName,
				collectionBytes: null,
				indexBytes: null,
				unavailableReason: `collStats unsupported on atlas-local:preview: ${message}`,
			})
		}
	}
	return {
		basis: "benchmark-agent-logical-plus-shared-physical",
		tenant,
		sharedPhysical: { collections },
	}
}

// ---------------------------------------------------------------------------
// Latency percentiles (p50 + p95)
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0
	const sorted = [...values].toSorted((a, b) => a - b)
	const rank = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	)
	return sorted[rank] ?? 0
}

export function percentile50And95(
	latencies: number[],
): BenchmarkLatencyDistribution {
	return {
		p50Ms: percentile(latencies, 50),
		p95Ms: percentile(latencies, 95),
	}
}
