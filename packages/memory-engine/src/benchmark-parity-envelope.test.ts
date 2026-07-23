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

import { describe, expect, it, vi } from "vitest"
import {
	BENCHMARK_RETRIEVAL_UNIT,
	assertBenchmarkRunConfiguration,
	collectBenchmarkTenantStorage,
	collectStorageFootprint,
	computeDatasetSha256FromPath,
	createBenchmarkRunContext,
	instrumentBenchmarkProvider,
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
	it("accepts an env digest only when it attests the dataset bytes", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-dataset-sha-"))
		const filePath = path.join(dir, "canary.jsonl")
		writeFileSync(filePath, "attested-bytes")
		const envSha = await computeDatasetSha256FromPath(filePath)
		const original = process.env.MEMONGO_BENCHMARK_DATASET_SHA
		process.env.MEMONGO_BENCHMARK_DATASET_SHA = envSha
		try {
			const sha = await resolveDatasetSha256({ datasetPath: filePath })
			expect(sha).toBe(envSha)
		} finally {
			if (original === undefined) {
				delete process.env.MEMONGO_BENCHMARK_DATASET_SHA
			} else {
				process.env.MEMONGO_BENCHMARK_DATASET_SHA = original
			}
		}
	})

	it("rejects an invalid env digest instead of silently dropping it", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-dataset-sha-"))
		const filePath = path.join(dir, "canary.jsonl")
		writeFileSync(filePath, "fallback-bytes")
		const original = process.env.MEMONGO_BENCHMARK_DATASET_SHA
		process.env.MEMONGO_BENCHMARK_DATASET_SHA = "not-a-real-sha"
		try {
			await expect(
				resolveDatasetSha256({ datasetPath: filePath }),
			).rejects.toThrow(/64-character lowercase SHA-256/i)
		} finally {
			if (original === undefined) {
				delete process.env.MEMONGO_BENCHMARK_DATASET_SHA
			} else {
				process.env.MEMONGO_BENCHMARK_DATASET_SHA = original
			}
		}
	})

	it("always rejects when no dataset bytes are available", async () => {
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

	it("rejects a valid-looking override that does not match dataset bytes", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-dataset-sha-"))
		const filePath = path.join(dir, "canary.jsonl")
		writeFileSync(filePath, "real-dataset-bytes")
		const original = process.env.MEMONGO_BENCHMARK_DATASET_SHA
		process.env.MEMONGO_BENCHMARK_DATASET_SHA = "b".repeat(64)
		try {
			const override = "c".repeat(64)
			await expect(
				resolveDatasetSha256({ datasetPath: filePath, override }),
			).rejects.toThrow(/does not match dataset bytes/i)
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
	it("sums benchmark-owned documents before cleanup across every touched collection", async () => {
		const rowsByCollection = new Map([
			["memongo_events", [{ documents: 2, logicalBytes: 300 }]],
			["memongo_chunks", [{ documents: 3, logicalBytes: 450 }]],
		])
		const aggregate = vi.fn((collectionName: string) => ({
			toArray: async () => rowsByCollection.get(collectionName) ?? [],
		}))
		const storage = await collectBenchmarkTenantStorage({
			db: {
				collection: (collectionName: string) => ({
					aggregate: () => aggregate(collectionName),
				}),
			} as unknown as Parameters<typeof collectBenchmarkTenantStorage>[0]["db"],
			agentId: "benchmark-agent",
			collectionNames: ["memongo_events", "memongo_chunks"],
		})

		expect(storage).toEqual({
			documents: 5,
			logicalBytes: 750,
			collections: [
				{ collectionName: "memongo_events", documents: 2, logicalBytes: 300 },
				{ collectionName: "memongo_chunks", documents: 3, logicalBytes: 450 },
			],
		})
	})

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
		expect(footprint).toEqual({
			basis: "benchmark-agent-logical-plus-shared-physical",
			tenant: {
				documents: null,
				logicalBytes: null,
				collections: [],
				unavailableReason: "benchmark tenant measurement was not provided",
			},
			sharedPhysical: {
				collections: [
					{
						collectionName: "memongo_bench_events",
						collectionBytes: 1234,
						indexBytes: 5678,
					},
				],
			},
		})
	})

	it("labels shared physical bytes for every requested collection", async () => {
		const footprint = await collectStorageFootprint({
			db: {
				command: async (cmd: { collStats?: string }) =>
					cmd.collStats === "memongo_events"
						? { size: 100, totalIndexSize: 200 }
						: { size: 300, totalIndexSize: 400 },
			} as unknown as Parameters<typeof collectStorageFootprint>[0]["db"],
			collectionName: "memongo_events",
			collectionNames: ["memongo_events", "memongo_chunks"],
		})

		expect(footprint.sharedPhysical.collections).toEqual([
			expect.objectContaining({
				collectionName: "memongo_events",
				collectionBytes: 100,
			}),
			expect.objectContaining({
				collectionName: "memongo_chunks",
				collectionBytes: 300,
			}),
		])
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
		expect(footprint.sharedPhysical.collections[0]).toEqual(
			expect.objectContaining({
				collectionBytes: null,
				indexBytes: null,
				unavailableReason: expect.stringMatching(/collStats/i),
			}),
		)
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
		expect(footprint.sharedPhysical.collections[0]).toEqual(
			expect.objectContaining({
				collectionBytes: null,
				indexBytes: null,
				unavailableReason: expect.stringMatching(/shape|malformed|unexpected/i),
			}),
		)
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

describe("createBenchmarkRunContext", () => {
	it("hashes an immutable configuration snapshot and rejects drift", () => {
		const configuration = {
			executionProfile: "shipped" as const,
			retrievalLane: "native" as const,
			maxResults: 50,
			minScore: 0.01,
			settings: {
				fusionMethod: "rankFusion",
				numCandidates: 500,
			},
		}
		const context = createBenchmarkRunContext({
			runId: "immutable-run",
			configuration,
		})
		const sameValuesDifferentOrder = {
			...configuration,
			settings: {
				numCandidates: 500,
				fusionMethod: "rankFusion",
			},
		}

		expect(context.configurationHash).toMatch(/^[0-9a-f]{64}$/)
		expect(() =>
			assertBenchmarkRunConfiguration(context, sameValuesDifferentOrder),
		).not.toThrow()
		expect(() =>
			assertBenchmarkRunConfiguration(context, {
				...configuration,
				settings: { ...configuration.settings, numCandidates: 501 },
			}),
		).toThrow(/configuration changed during execution/i)
	})

	it("keeps overlapping run accounting isolated and reports unobservable embeddings as unknown", () => {
		const configuration = {
			executionProfile: "diagnostic" as const,
			retrievalLane: "native" as const,
			maxResults: 10,
			minScore: 0.01,
			settings: {},
		}
		const first = createBenchmarkRunContext({
			runId: "run-first",
			configuration,
		})
		const second = createBenchmarkRunContext({
			runId: "run-second",
			configuration,
		})

		first.accounting.recordAttempt("rerank", {
			provider: "voyage",
			model: "rerank-2.5",
		})
		first.accounting.recordFailure("rerank", {
			provider: "voyage",
			model: "rerank-2.5",
		})
		second.accounting.recordAttempt("answer-generation", {
			provider: "openai-compatible",
			model: "judge-model",
		})
		second.accounting.recordSuccess("answer-generation", {
			provider: "openai-compatible",
			model: "judge-model",
		})

		expect(first.runId).toBe("run-first")
		const firstSnapshot = first.accounting.snapshot()
		expect(firstSnapshot).toEqual(
			expect.objectContaining({
				currency: null,
				totalCost: null,
				unavailableReason:
					"provider token usage and prices are not instrumented",
			}),
		)
		expect(firstSnapshot.operations).toEqual(
			expect.arrayContaining([
				{
					operation: "embedding",
					observability: "unknown",
					attempted: null,
					succeeded: null,
					failed: null,
					unavailableReason:
						"MongoDB automated embedding calls are not exposed to the benchmark process",
				},
				{
					operation: "vector-query",
					observability: "unknown",
					attempted: null,
					succeeded: null,
					failed: null,
					unavailableReason:
						"MongoDB search execution does not expose per-stage vector operation counts",
				},
				{
					operation: "rerank",
					observability: "measured",
					attempted: 1,
					succeeded: 0,
					failed: 1,
					provider: "voyage",
					model: "rerank-2.5",
				},
				{
					operation: "answer-generation",
					observability: "not-run",
					attempted: 0,
					succeeded: 0,
					failed: 0,
				},
			]),
		)
		expect(second.accounting.snapshot().operations).toEqual(
			expect.arrayContaining([
				{
					operation: "answer-generation",
					observability: "measured",
					attempted: 1,
					succeeded: 1,
					failed: 0,
					provider: "openai-compatible",
					model: "judge-model",
				},
				{
					operation: "rerank",
					observability: "not-run",
					attempted: 0,
					succeeded: 0,
					failed: 0,
				},
			]),
		)
	})

	it("keeps provider and model variants as separate operation rows", () => {
		const context = createBenchmarkRunContext({
			runId: "variant-run",
			configuration: {
				executionProfile: "diagnostic",
				retrievalLane: "native",
				maxResults: 10,
				minScore: 0.01,
				settings: {},
			},
		})
		for (const model of ["rerank-a", "rerank-b"]) {
			const metadata = { provider: "voyage", model }
			context.accounting.recordAttempt("rerank", metadata)
			context.accounting.recordSuccess("rerank", metadata)
		}

		expect(
			context.accounting
				.snapshot()
				.operations.filter((entry) => entry.operation === "rerank"),
		).toEqual([
			expect.objectContaining({
				model: "rerank-a",
				attempted: 1,
				succeeded: 1,
			}),
			expect.objectContaining({
				model: "rerank-b",
				attempted: 1,
				succeeded: 1,
			}),
		])
	})
})

describe("instrumentBenchmarkProvider", () => {
	it("records a failed shipped structured extraction call in its own ledger row", async () => {
		const context = createBenchmarkRunContext({
			runId: "derived-run",
			configuration: {
				executionProfile: "shipped",
				retrievalLane: "native",
				maxResults: 50,
				minScore: 0.01,
				settings: {},
			},
		})
		const provider = {
			name: "mock-provider",
			chatCompletion: vi.fn().mockRejectedValue(new Error("provider down")),
		}
		const instrumented = instrumentBenchmarkProvider({
			provider,
			runContext: context,
			operation: "structured-extraction",
			model: "derived-model",
		})

		await expect(
			instrumented.chatCompletion({
				model: "derived-model",
				messages: [{ role: "user", content: "remember this" }],
			}),
		).rejects.toThrow("provider down")
		expect(context.accounting.snapshot().operations).toContainEqual({
			operation: "structured-extraction",
			observability: "measured",
			attempted: 1,
			succeeded: 0,
			failed: 1,
			provider: "mock-provider",
			model: "derived-model",
		})
	})
})
