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
	BenchmarkCostCounters,
	BenchmarkEmbeddingConfig,
	BenchmarkEmbeddingQuantization,
	BenchmarkLatencyDistribution,
	BenchmarkRerankerConfig,
	BenchmarkRerankerStage,
	BenchmarkRetrievalUnit,
	BenchmarkStorageFootprint,
	MemoryBenchmarkDatasetKind,
} from "./types.js"

export type BenchmarkRetrievalLane = "native" | "raw-session"

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

function isStrictBenchmarkMode(): boolean {
	const v = process.env.MEMONGO_BENCHMARK_STRICT
	return v === "1" || v?.toLowerCase() === "true"
}

/**
 * Resolve dataset SHA-256. Precedence:
 *   1. `override` argument (e.g., route-body `datasetSha256`)
 *   2. `MEMONGO_BENCHMARK_DATASET_SHA` env var (matches bootstrap.json)
 *   3. compute from `datasetPath` bytes
 *
 * In strict mode, throws if no source is available — zero silent fallback.
 */
export async function resolveDatasetSha256(params: {
	datasetPath: string | undefined
	override?: string
}): Promise<string> {
	if (params.override && SHA256_REGEX.test(params.override)) {
		return params.override
	}
	const envSha = process.env.MEMONGO_BENCHMARK_DATASET_SHA
	if (envSha && SHA256_REGEX.test(envSha)) {
		return envSha
	}
	if (params.datasetPath) {
		return await computeDatasetSha256FromPath(params.datasetPath)
	}
	if (isStrictBenchmarkMode()) {
		throw new Error(
			"resolveDatasetSha256: cannot resolve dataset SHA-256 — no override, no MEMONGO_BENCHMARK_DATASET_SHA env, and no dataset path (strict mode rejects silent fallback)",
		)
	}
	// Non-strict: fall back to zero-SHA only when no strict requirement.
	return "0".repeat(64)
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
	const model = envModel && envModel.length > 0 ? envModel : "voyage-4-large"
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
}): Promise<BenchmarkStorageFootprint> {
	const { db, collectionName } = params
	try {
		const stats = (await db.command({
			collStats: collectionName,
		})) as CollStatsResponse
		const collectionBytes = toNonNegativeNumber(stats.size)
		const indexBytes = toNonNegativeNumber(stats.totalIndexSize)
		if (collectionBytes === null || indexBytes === null) {
			return {
				collectionBytes: null,
				indexBytes: null,
				unavailableReason:
					"collStats returned unexpected shape on atlas-local:preview",
			}
		}
		return { collectionBytes, indexBytes }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return {
			collectionBytes: null,
			indexBytes: null,
			unavailableReason: `collStats unsupported on atlas-local:preview: ${message}`,
		}
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

// ---------------------------------------------------------------------------
// Cost counters (run-scoped)
// ---------------------------------------------------------------------------

export type BenchmarkRunCounters = {
	snapshot(): BenchmarkCostCounters
	recordEmbeddingCall(count?: number): void
	recordRerankCall(count?: number): void
	recordLlmEnrichmentCall(count?: number): void
}

export function createBenchmarkRunCounters(): BenchmarkRunCounters {
	let embeddingCalls = 0
	let rerankCalls = 0
	let llmEnrichmentCalls = 0
	return {
		snapshot() {
			return { embeddingCalls, rerankCalls, llmEnrichmentCalls }
		},
		recordEmbeddingCall(count = 1) {
			if (Number.isFinite(count) && count > 0) {
				embeddingCalls += count
			}
		},
		recordRerankCall(count = 1) {
			if (Number.isFinite(count) && count > 0) {
				rerankCalls += count
			}
		},
		recordLlmEnrichmentCall(count = 1) {
			if (Number.isFinite(count) && count > 0) {
				llmEnrichmentCalls += count
			}
		},
	}
}
