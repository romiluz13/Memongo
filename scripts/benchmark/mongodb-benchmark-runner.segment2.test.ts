import { describe, expect, it } from "vitest"
import {
	buildBenchmarkRunReport,
	projectBenchmarkParityFields,
} from "./mongodb-benchmark-runner.js"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import type { MemoryBenchmarkOfficialMetrics } from "../../packages/memory-engine/src/types.js"
import { createBenchmarkRunContext } from "./benchmark-parity-envelope.js"

function benchmarkCost(
	operations: Array<{
		operation:
			| "rerank"
			| "enrichment"
			| "query-decomposition"
			| "answer-generation"
			| "answer-judge"
			| "decoy-judge"
		attempted: number
		succeeded: number
		failed: number
	}> = [],
) {
	return {
		currency: null,
		totalCost: null,
		unavailableReason: "provider token usage and prices are not instrumented",
		operations: [
			{
				operation: "embedding" as const,
				observability: "unknown" as const,
				attempted: null,
				succeeded: null,
				failed: null,
				unavailableReason:
					"MongoDB automated embedding calls are not exposed to the benchmark process",
			},
			...operations.map((entry) => ({
				...entry,
				observability: "measured" as const,
			})),
		],
	}
}

function benchmarkRunContext(
	retrievalLane: "native" | "raw-session" = "native",
) {
	return createBenchmarkRunContext({
		runId: `run-${retrievalLane}`,
		configuration: {
			executionProfile: "diagnostic",
			retrievalLane,
			maxResults: 50,
			minScore: 0.01,
			settings: { numCandidates: 500, fusionMethod: "rankFusion" },
		},
	})
}

function _makeResult(params: {
	path: string
	score: number
	sessionId?: string
	sourceEventIds?: string[]
}): MemorySearchResult {
	return {
		path: params.path,
		startLine: 1,
		endLine: 1,
		score: params.score,
		snippet: params.path,
		source: "conversation",
		...(params.sessionId ? { sessionId: params.sessionId } : {}),
		...(params.sourceEventIds ? { sourceEventIds: params.sourceEventIds } : {}),
	}
}

const officialMetrics: MemoryBenchmarkOfficialMetrics = {
	longMemEval: {
		evaluator: {
			suite: "longmemeval",
			sourceRepository: "xiaowu0162/LongMemEval",
			sourceCommit: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
			evaluatorPath: "src/retrieval/eval_utils.py",
			evaluatorBlob: "9c43a835e7c41aff0eb3272c448f5cbe76bbbd45",
			aggregationEntrypoint: "src/retrieval/run_retrieval.py",
			cutoffs: [1, 3, 5, 10, 30, 50],
			eligibilityPolicy: "exclude-abstention-and-no-user-answer-target",
			candidateProjection: "one-session-document-one-label",
			comparability: "canonical",
		},
		totalCases: 2,
		eligibleCases: 2,
		retrievalCases: 2,
		abstentionCases: 0,
		ineligibleCases: 0,
		projectionFailureCases: 0,
		executionFailureCases: 0,
		session: {
			recallAnyAt1: 1,
			recallAllAt1: 1,
			ndcgAnyAt1: 1,
			recallAnyAt3: 1,
			recallAllAt3: 1,
			ndcgAnyAt3: 1,
			recallAnyAt5: 1,
			recallAllAt5: 1,
			ndcgAnyAt5: 1,
			recallAnyAt10: 1,
			recallAllAt10: 1,
			ndcgAnyAt10: 1,
			recallAnyAt30: 1,
			recallAllAt30: 1,
			ndcgAnyAt30: 1,
			recallAnyAt50: 1,
			recallAllAt50: 1,
			ndcgAnyAt50: 1,
		},
	},
}

describe("mongodb benchmark runner", () => {
	it("emits parity envelope fields when Task 1.A parity inputs are provided (Task 1.A)", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval_s.json",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 2,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			rAt5: 1,
			rAt10: 1,
			ndcgAt10: 1,
			runIdentity: {
				runId: "run-report",
				datasetSha256: "a".repeat(64),
				retrievalUnit: "turn",
				configurationHash: "b".repeat(64),
				executionProfile: "diagnostic",
				retrievalLane: "native",
				maxResults: 50,
				minScore: 0.01,
				settings: {},
			},
			embedding: {
				model: "voyage-3",
				dimensions: 1024,
				quantization: "float32",
			},
			reranker: {
				model: "rerank-2",
				version: null,
				stage: "post-fusion",
			},
			storage: {
				basis: "benchmark-agent-logical-plus-shared-physical",
				tenant: { documents: 2, logicalBytes: 512, collections: [] },
				sharedPhysical: {
					collections: [
						{
							collectionName: "memongo_events",
							collectionBytes: 1024,
							indexBytes: 2048,
						},
					],
				},
			},
			latency: {
				p50Ms: 20,
				p95Ms: 44,
			},
			cost: benchmarkCost([
				{
					operation: "rerank",
					attempted: 5,
					succeeded: 5,
					failed: 0,
				},
			]),
		})

		expect(report.runIdentity?.datasetSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(report.runIdentity?.retrievalUnit).toBe("turn")
		expect(report.embedding?.model).toBe("voyage-3")
		expect(report.embedding?.dimensions).toBe(1024)
		expect(report.embedding?.quantization).toBe("float32")
		expect(report.reranker?.model).toBe("rerank-2")
		expect(report.reranker?.version).toBeNull()
		expect(report.reranker?.stage).toBe("post-fusion")
		expect(report.storage?.tenant.logicalBytes).toBe(512)
		expect(report.storage?.sharedPhysical.collections[0]?.indexBytes).toBe(2048)
		expect(report.latency?.p50Ms).toBe(20)
		expect(report.latency?.p95Ms).toBe(44)
		expect(report.cost?.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operation: "embedding",
					observability: "unknown",
					attempted: null,
				}),
				expect.objectContaining({
					operation: "rerank",
					attempted: 5,
					succeeded: 5,
					failed: 0,
				}),
			]),
		)
		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "evidence-completeness",
					status: "failed",
					evidence: expect.stringContaining("monetary cost"),
				}),
			]),
		)
	})

	it("emits storage null-with-reason when collStats is unavailable (Task 1.A)", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval_s.json",
			datasetKind: "longmemeval",
			cases: 1,
			scoredCases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 30,
			runIdentity: {
				datasetSha256: "b".repeat(64),
				retrievalUnit: "turn",
			},
			storage: {
				basis: "benchmark-agent-logical-plus-shared-physical",
				tenant: {
					documents: null,
					logicalBytes: null,
					collections: [],
					unavailableReason: "tenant-measurement-unavailable",
				},
				sharedPhysical: {
					collections: [
						{
							collectionName: "memongo_events",
							collectionBytes: null,
							indexBytes: null,
							unavailableReason: "collStats-unsupported-on-atlas-local-preview",
						},
					],
				},
			},
		})

		expect(
			report.storage?.sharedPhysical.collections[0]?.collectionBytes,
		).toBeNull()
		expect(
			report.storage?.sharedPhysical.collections[0]?.unavailableReason,
		).toBe("collStats-unsupported-on-atlas-local-preview")
	})

	it("accepts Gate-5 e2eQa extensions (may be null at Phase 1) (Task 1.A)", () => {
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval_s.json",
			datasetKind: "longmemeval",
			cases: 1,
			scoredCases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 30,
			runIdentity: {
				datasetSha256: "c".repeat(64),
				retrievalUnit: "turn",
			},
			e2eQa: {
				judge: null,
				judgeVersion: null,
				accuracy: null,
				latencyMs: null,
				judgeFalsePositiveRate: null,
			},
		})

		expect(report.e2eQa).toBeDefined()
		expect(report.e2eQa?.judge).toBeNull()
		expect(report.e2eQa?.accuracy).toBeNull()
	})

	it("projectBenchmarkParityFields wires every parity field into the report (Task 1.A projection)", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-parity-proj-"))
		const datasetPath = path.join(dir, "canary.jsonl")
		writeFileSync(datasetPath, "parity-fixture-bytes")

		const mockDb = {
			command: async () => ({ size: 4096, totalIndexSize: 8192 }),
		}

		const projected = await projectBenchmarkParityFields({
			db: mockDb as unknown as Parameters<
				typeof projectBenchmarkParityFields
			>[0]["db"],
			collectionName: "memongo_bench_events",
			datasetPath,
			datasetKind: "longmemeval",
			mongoEmbeddingConfig: {
				numDimensions: 1024,
				quantization: "none",
			},
			mongoRerankerConfig: {
				enabled: true,
				model: "rerank-2.5",
				topN: 20,
			},
			latencySamples: [10, 20, 30, 40, 50],
			cost: benchmarkCost([
				{
					operation: "rerank",
					attempted: 3,
					succeeded: 3,
					failed: 0,
				},
				{
					operation: "enrichment",
					attempted: 2,
					succeeded: 2,
					failed: 0,
				},
			]),
			runContext: benchmarkRunContext(),
		})

		expect(projected.runIdentity?.datasetSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(projected.runIdentity?.retrievalUnit).toBe("turn")
		expect(projected.embedding?.model).toBe("voyage-4-large")
		expect(projected.embedding?.dimensions).toBe(1024)
		expect(projected.embedding?.quantization).toBe("float32")
		expect(projected.reranker?.model).toBe("rerank-2.5")
		expect(projected.reranker?.stage).toBe("post-fusion")
		expect(projected.storage?.sharedPhysical.collections[0]).toEqual(
			expect.objectContaining({
				collectionBytes: 4096,
				indexBytes: 8192,
			}),
		)
		expect(projected.latency?.p50Ms).toBeGreaterThanOrEqual(0)
		expect(projected.latency?.p95Ms).toBeGreaterThanOrEqual(
			projected.latency?.p50Ms ?? 0,
		)
		expect(projected.cost?.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operation: "embedding",
					observability: "unknown",
				}),
				expect.objectContaining({
					operation: "rerank",
					attempted: 3,
				}),
				expect.objectContaining({
					operation: "enrichment",
					attempted: 2,
				}),
			]),
		)
	})

	it("projectBenchmarkParityFields records session retrieval for raw-session lane", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-parity-session-"))
		const datasetPath = path.join(dir, "dataset.json")
		writeFileSync(datasetPath, "raw-session-fixture")
		const mockDb = {
			command: async () => ({ size: 1024, totalIndexSize: 2048 }),
		}

		const projected = await projectBenchmarkParityFields({
			db: mockDb as unknown as Parameters<
				typeof projectBenchmarkParityFields
			>[0]["db"],
			collectionName: "memongo_bench_session_chunks",
			datasetPath,
			datasetKind: "longmemeval",
			retrievalLane: "raw-session",
			mongoEmbeddingConfig: {
				numDimensions: 1024,
				quantization: "none",
			},
			mongoRerankerConfig: {
				enabled: false,
				model: "none",
				topN: 0,
			},
			latencySamples: [10],
			cost: benchmarkCost(),
			runContext: benchmarkRunContext("raw-session"),
		})

		expect(projected.runIdentity?.retrievalUnit).toBe("session")
		expect(projected.reranker?.stage).toBe("none")
		expect(projected.reranker?.model).toBe("none")
	})

	it("projectBenchmarkParityFields returns null-with-reason storage when collStats throws (atlas-local:preview)", async () => {
		const { writeFileSync, mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-parity-proj-"))
		const datasetPath = path.join(dir, "canary.jsonl")
		writeFileSync(datasetPath, "x")

		const throwingDb = {
			command: async () => {
				throw new Error("Cannot do collStats on collection ... not supported")
			},
		}

		const projected = await projectBenchmarkParityFields({
			db: throwingDb as unknown as Parameters<
				typeof projectBenchmarkParityFields
			>[0]["db"],
			collectionName: "memongo_bench_events",
			datasetPath,
			datasetKind: "longmemeval",
			mongoEmbeddingConfig: {
				numDimensions: 1024,
				quantization: "none",
			},
			mongoRerankerConfig: {
				enabled: true,
				model: "rerank-2.5",
				topN: 20,
			},
			latencySamples: [42],
			cost: benchmarkCost(),
			runContext: benchmarkRunContext(),
		})

		expect(projected.storage?.sharedPhysical.collections[0]).toEqual(
			expect.objectContaining({
				collectionBytes: null,
				indexBytes: null,
				unavailableReason: expect.stringMatching(/collStats/i),
			}),
		)
	})

	it("fails when official metrics score more cases than the corpus declares", () => {
		const oversizedOfficialMetrics: MemoryBenchmarkOfficialMetrics = {
			longMemEval: {
				...officialMetrics.longMemEval!,
				totalCases: 3,
				eligibleCases: 3,
				retrievalCases: 3,
			},
		}
		const report = buildBenchmarkRunReport({
			datasetVersion: "longmem-v1",
			datasetName: "longmemeval.json",
			datasetKind: "longmemeval",
			cases: 2,
			scoredCases: 3,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.9,
			p95LatencyMs: 44,
			officialMetrics: oversizedOfficialMetrics,
		})

		expect(report.releaseGates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gate: "official-retrieval",
					status: "failed",
					evidence: "LongMemEval evaluator covered 3/2 total cases",
				}),
			]),
		)
		expect(report.degradations).toEqual(
			expect.arrayContaining(["scoredCases=3/2"]),
		)
	})
})
