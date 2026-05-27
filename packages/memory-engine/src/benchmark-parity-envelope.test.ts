/**
 * Task 1.A projection tests.
 *
 * These tests pin the runtime behavior that projects parity fields
 * (datasetSha256, retrievalUnit, embedding, reranker, storage, latency, cost)
 * into the `benchmarkReport` envelope consumed by Gate 3 artifacts.
 *
 * Phase 1 wired the TYPES + `buildBenchmarkRunReport` input passthroughs;
 * this re-open wires the PROJECTION — callers now actually populate them.
 */

import { describe, expect, it } from "vitest"
import {
	BENCHMARK_RETRIEVAL_UNIT,
	collectStorageFootprint,
	computeDatasetSha256FromPath,
	createBenchmarkRunCounters,
	percentile50And95,
	resolveBenchmarkEmbeddingConfig,
	resolveBenchmarkRetrievalLane,
	resolveBenchmarkRerankerConfig,
	resolveDatasetSha256,
	resolveRetrievalUnit,
} from "./benchmark-parity-envelope.js"
import type { MemoryBenchmarkDatasetKind } from "./types.js"

describe("BENCHMARK_RETRIEVAL_UNIT constant", () => {
	it("is a single source of truth exported as 'turn' at engine level", () => {
		expect(BENCHMARK_RETRIEVAL_UNIT).toBe("turn")
	})
})

describe("resolveRetrievalUnit", () => {
	it("returns 'turn' for longmemeval", () => {
		expect(resolveRetrievalUnit("longmemeval")).toBe("turn")
	})

	it("returns 'turn' for locomo (dialog-level evaluation)", () => {
		expect(resolveRetrievalUnit("locomo")).toBe("turn")
	})

	it("returns 'turn' for unknown dataset kinds — safe default", () => {
		expect(
			resolveRetrievalUnit(undefined as unknown as MemoryBenchmarkDatasetKind),
		).toBe("turn")
	})

	it("returns 'session' for the raw-session benchmark lane", () => {
		expect(resolveRetrievalUnit("longmemeval", "raw-session")).toBe("session")
	})
})

describe("resolveBenchmarkRetrievalLane", () => {
	it("normalizes raw-session aliases", () => {
		expect(resolveBenchmarkRetrievalLane("raw_session")).toBe("raw-session")
		expect(resolveBenchmarkRetrievalLane("session")).toBe("raw-session")
	})

	it("defaults unknown values to native", () => {
		expect(resolveBenchmarkRetrievalLane(undefined)).toBe("native")
		expect(resolveBenchmarkRetrievalLane("nope")).toBe("native")
	})
})

describe("computeDatasetSha256FromPath", () => {
	it("returns a 64-hex-char SHA-256 hash for a real file", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-dataset-sha-"))
		const filePath = path.join(dir, "canary.jsonl")
		writeFileSync(filePath, "hello-memongo-dataset")
		const sha = await computeDatasetSha256FromPath(filePath)
		expect(sha).toMatch(/^[0-9a-f]{64}$/)
	})

	it("returns the same hash for the same content", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-dataset-sha-"))
		const a = path.join(dir, "a.jsonl")
		const b = path.join(dir, "b.jsonl")
		writeFileSync(a, "same-bytes")
		writeFileSync(b, "same-bytes")
		const shaA = await computeDatasetSha256FromPath(a)
		const shaB = await computeDatasetSha256FromPath(b)
		expect(shaA).toBe(shaB)
	})
})

describe("resolveDatasetSha256", () => {
	it("prefers MEMONGO_BENCHMARK_DATASET_SHA env over computing from path", async () => {
		const envSha = "a".repeat(64)
		const original = process.env.MEMONGO_BENCHMARK_DATASET_SHA
		process.env.MEMONGO_BENCHMARK_DATASET_SHA = envSha
		try {
			const sha = await resolveDatasetSha256({
				datasetPath: "/nonexistent/path.json",
			})
			expect(sha).toBe(envSha)
		} finally {
			if (original === undefined) {
				delete process.env.MEMONGO_BENCHMARK_DATASET_SHA
			} else {
				process.env.MEMONGO_BENCHMARK_DATASET_SHA = original
			}
		}
	})

	it("ignores env value that is not a 64-hex SHA and falls back to path compute", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-dataset-sha-"))
		const filePath = path.join(dir, "canary.jsonl")
		writeFileSync(filePath, "fallback-bytes")
		const original = process.env.MEMONGO_BENCHMARK_DATASET_SHA
		process.env.MEMONGO_BENCHMARK_DATASET_SHA = "not-a-real-sha"
		try {
			const sha = await resolveDatasetSha256({ datasetPath: filePath })
			expect(sha).toMatch(/^[0-9a-f]{64}$/)
		} finally {
			if (original === undefined) {
				delete process.env.MEMONGO_BENCHMARK_DATASET_SHA
			} else {
				process.env.MEMONGO_BENCHMARK_DATASET_SHA = original
			}
		}
	})

	it("throws in strict mode when no env and no path — zero silent fallback", async () => {
		const originalEnv = process.env.MEMONGO_BENCHMARK_DATASET_SHA
		const originalStrict = process.env.MEMONGO_BENCHMARK_STRICT
		delete process.env.MEMONGO_BENCHMARK_DATASET_SHA
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			await expect(
				resolveDatasetSha256({ datasetPath: undefined }),
			).rejects.toThrow(/dataset/i)
		} finally {
			if (originalEnv === undefined) {
				delete process.env.MEMONGO_BENCHMARK_DATASET_SHA
			} else {
				process.env.MEMONGO_BENCHMARK_DATASET_SHA = originalEnv
			}
			if (originalStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = originalStrict
			}
		}
	})

	it("accepts override datasetSha256 arg ahead of env and path", async () => {
		const original = process.env.MEMONGO_BENCHMARK_DATASET_SHA
		process.env.MEMONGO_BENCHMARK_DATASET_SHA = "b".repeat(64)
		try {
			const override = "c".repeat(64)
			const sha = await resolveDatasetSha256({
				datasetPath: undefined,
				override,
			})
			expect(sha).toBe(override)
		} finally {
			if (original === undefined) {
				delete process.env.MEMONGO_BENCHMARK_DATASET_SHA
			} else {
				process.env.MEMONGO_BENCHMARK_DATASET_SHA = original
			}
		}
	})
})

describe("resolveBenchmarkEmbeddingConfig", () => {
	it("returns voyage model/dimensions from the resolved backend config", () => {
		const cfg = resolveBenchmarkEmbeddingConfig({
			numDimensions: 1024,
			quantization: "none",
		})
		expect(cfg.model).toBe("voyage-4-large")
		expect(cfg.dimensions).toBe(1024)
		expect(cfg.quantization).toBe("float32")
	})

	it("maps quantization 'scalar' to 'int8'", () => {
		const cfg = resolveBenchmarkEmbeddingConfig({
			numDimensions: 1024,
			quantization: "scalar",
		})
		expect(cfg.quantization).toBe("int8")
	})

	it("maps quantization 'binary' to 'binary'", () => {
		const cfg = resolveBenchmarkEmbeddingConfig({
			numDimensions: 1024,
			quantization: "binary",
		})
		expect(cfg.quantization).toBe("binary")
	})

	it("honors MEMONGO_BENCHMARK_EMBEDDING_MODEL env override", () => {
		const original = process.env.MEMONGO_BENCHMARK_EMBEDDING_MODEL
		process.env.MEMONGO_BENCHMARK_EMBEDDING_MODEL = "voyage-4-large"
		try {
			const cfg = resolveBenchmarkEmbeddingConfig({
				numDimensions: 1024,
				quantization: "none",
			})
			expect(cfg.model).toBe("voyage-4-large")
		} finally {
			if (original === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EMBEDDING_MODEL
			} else {
				process.env.MEMONGO_BENCHMARK_EMBEDDING_MODEL = original
			}
		}
	})
})

describe("resolveBenchmarkRerankerConfig", () => {
	it("projects enabled + model + topN + stage from reranking config", () => {
		const cfg = resolveBenchmarkRerankerConfig({
			enabled: true,
			model: "rerank-2.5",
			topN: 20,
		})
		expect(cfg.model).toBe("rerank-2.5")
		// Current engine wiring applies rerank AFTER hybrid fusion
		expect(cfg.stage).toBe("post-fusion")
		expect(cfg.version).toBeNull()
	})

	it("marks stage 'none' when reranking is disabled", () => {
		const cfg = resolveBenchmarkRerankerConfig({
			enabled: false,
			model: "rerank-2.5",
			topN: 20,
		})
		expect(cfg.stage).toBe("none")
	})
})

describe("collectStorageFootprint", () => {
	it("returns populated bytes when collStats succeeds", async () => {
		const mockDb = {
			command: async (cmd: Record<string, unknown>) => {
				expect(cmd).toEqual({ collStats: "memongo_bench_events" })
				return { size: 1234, totalIndexSize: 5678, storageSize: 9000 }
			},
		}
		const footprint = await collectStorageFootprint({
			db: mockDb as unknown as Parameters<
				typeof collectStorageFootprint
			>[0]["db"],
			collectionName: "memongo_bench_events",
		})
		expect(footprint.collectionBytes).toBe(1234)
		expect(footprint.indexBytes).toBe(5678)
		expect(footprint.unavailableReason).toBeUndefined()
	})

	it("returns null-with-reason when collStats throws (atlas-local:preview)", async () => {
		const mockDb = {
			command: async () => {
				throw new Error("collStats command is not supported")
			},
		}
		const footprint = await collectStorageFootprint({
			db: mockDb as unknown as Parameters<
				typeof collectStorageFootprint
			>[0]["db"],
			collectionName: "memongo_bench_events",
		})
		expect(footprint.collectionBytes).toBeNull()
		expect(footprint.indexBytes).toBeNull()
		expect(footprint.unavailableReason).toMatch(/collStats/i)
	})

	it("returns null-with-reason when collStats returns malformed shape", async () => {
		const mockDb = {
			command: async () => ({ size: "not-a-number", totalIndexSize: null }),
		}
		const footprint = await collectStorageFootprint({
			db: mockDb as unknown as Parameters<
				typeof collectStorageFootprint
			>[0]["db"],
			collectionName: "memongo_bench_events",
		})
		expect(footprint.collectionBytes).toBeNull()
		expect(footprint.indexBytes).toBeNull()
		expect(footprint.unavailableReason).toMatch(/shape|malformed|unexpected/i)
	})
})

describe("percentile50And95", () => {
	it("returns p50 and p95 over latency samples (p95 ≥ p50)", () => {
		const { p50Ms, p95Ms } = percentile50And95([10, 20, 30, 40, 50, 60, 70])
		expect(p50Ms).toBeGreaterThanOrEqual(0)
		expect(p95Ms).toBeGreaterThanOrEqual(p50Ms)
	})

	it("returns 0/0 for empty latency set", () => {
		expect(percentile50And95([])).toEqual({ p50Ms: 0, p95Ms: 0 })
	})

	it("returns the single value for both percentiles when one sample", () => {
		const { p50Ms, p95Ms } = percentile50And95([42])
		expect(p50Ms).toBe(42)
		expect(p95Ms).toBe(42)
	})
})

describe("createBenchmarkRunCounters", () => {
	it("starts at zero and increments monotonically", () => {
		const counters = createBenchmarkRunCounters()
		expect(counters.snapshot()).toEqual({
			embeddingCalls: 0,
			rerankCalls: 0,
			llmEnrichmentCalls: 0,
		})
		counters.recordRerankCall()
		counters.recordRerankCall()
		counters.recordEmbeddingCall()
		counters.recordLlmEnrichmentCall()
		expect(counters.snapshot()).toEqual({
			embeddingCalls: 1,
			rerankCalls: 2,
			llmEnrichmentCalls: 1,
		})
	})

	it("supports bulk increments (records batch of N calls)", () => {
		const counters = createBenchmarkRunCounters()
		counters.recordLlmEnrichmentCall(5)
		expect(counters.snapshot().llmEnrichmentCalls).toBe(5)
	})
})
