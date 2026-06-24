/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock assertions */
import type { Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import {
	MongoDBRelevanceRuntime,
	summarizeExplain,
} from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"

function mockDb(): {
	db: Db
	collections: Map<
		string,
		{
			insertOne: ReturnType<typeof vi.fn>
			insertMany: ReturnType<typeof vi.fn>
			find: ReturnType<typeof vi.fn>
		}
	>
} {
	const collections = new Map<
		string,
		{
			insertOne: ReturnType<typeof vi.fn>
			insertMany: ReturnType<typeof vi.fn>
			find: ReturnType<typeof vi.fn>
		}
	>()

	const getCollection = (name: string) => {
		if (!collections.has(name)) {
			collections.set(name, {
				insertOne: vi.fn(async () => ({ acknowledged: true })),
				insertMany: vi.fn(async () => ({ acknowledged: true })),
				find: vi.fn(() => ({
					project: vi.fn(() => ({
						toArray: async () => [],
					})),
					toArray: async () => [],
				})),
			})
		}
		return collections.get(name)!
	}

	return {
		db: {
			collection: vi.fn((name: string) => getCollection(name)),
		} as unknown as Db,
		collections,
	}
}

function makeConfig(
	overrides?: Partial<ResolvedMongoDBConfig>,
): ResolvedMongoDBConfig {
	return {
		backend: "mongodb",
		uri: "mongodb://localhost:27017/memongo",
		database: "memongo",
		collectionPrefix: "test_",
		deploymentProfile: "atlas-local-preview",
		embeddingMode: "manual",
		recallProfile: "balanced",
		fallbackToBuiltin: true,
		relevance: {
			enabled: true,
			telemetry: {
				enabled: true,
				baseSampleRate: 0.01,
				adaptive: {
					enabled: true,
					maxSampleRate: 0.1,
					minWindowSize: 3,
				},
				persistRawExplain: true,
				queryPrivacyMode: "redacted-hash",
			},
			retention: { days: 14 },
			benchmark: {
				enabled: true,
				datasetPath: "/tmp/golden.jsonl",
			},
		},
		...overrides,
	} as ResolvedMongoDBConfig
}

const capabilities: DetectedCapabilities = {
	textSearch: true,
	vectorSearch: true,
	rankFusion: true,
	scoreFusion: true,
}

describe("mongodb relevance runtime", () => {
	it("summarizeExplain extracts key numeric fields from nested payloads", () => {
		const summary = summarizeExplain({
			stages: [
				{
					stats: {
						executionTimeMillisEstimate: 12,
						nReturned: 5,
						numCandidates: 64,
					},
				},
			],
		})
		expect(summary).toEqual({
			executionTimeMs: 12,
			nReturned: 5,
			numCandidates: 64,
		})
	})

	it("persistRun stores redacted query + hash in redacted-hash mode", async () => {
		const { db, collections } = mockDb()
		const runtime = new MongoDBRelevanceRuntime(
			db,
			"test_",
			"agent-a",
			makeConfig(),
			capabilities,
		)

		await runtime.persistRun({
			query: "Secret Build 123",
			sourceScope: "all",
			latencyMs: 10,
			topK: 5,
			hitSources: ["memory"],
			status: "ok",
			sampled: true,
			sampleRate: 0.01,
			artifacts: [
				{
					artifactType: "searchExplain",
					summary: { topScore: 0.8 },
					rawExplain: { raw: true },
				},
			],
		})

		const runsInsert = collections.get("test_relevance_runs")?.insertOne
		const artifactsInsert = collections.get(
			"test_relevance_artifacts",
		)?.insertMany
		expect(runsInsert).toHaveBeenCalledTimes(1)
		expect(artifactsInsert).toHaveBeenCalledTimes(1)

		const persistedRun = runsInsert?.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(typeof persistedRun.queryHash).toBe("string")
		expect(persistedRun.queryRedacted).toBe("xxxxxx xxxxx xxx")

		const persistedArtifacts = artifactsInsert?.mock.calls[0]?.[0] as Array<
			Record<string, unknown>
		>
		expect(persistedArtifacts[0]?.rawExplain).toBeUndefined()
	})

	it("persistRun omits optional validator-bound fields when absent", async () => {
		const { db, collections } = mockDb()
		const runtime = new MongoDBRelevanceRuntime(
			db,
			"test_",
			"agent-a",
			makeConfig(),
			capabilities,
		)

		await runtime.persistRun({
			query: "Phoenix release status",
			sourceScope: "all",
			latencyMs: 12,
			topK: 3,
			hitSources: ["conversation"],
			status: "ok",
			sampled: true,
			sampleRate: 0.01,
			artifacts: [{ artifactType: "trace", summary: {} }],
		})

		const runsInsert = collections.get("test_relevance_runs")?.insertOne
		const persistedRun = runsInsert?.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(persistedRun).not.toHaveProperty("fallbackPath")
	})

	it("adaptive sampler escalates on degradation and relaxes after recovery", () => {
		const { db } = mockDb()
		const runtime = new MongoDBRelevanceRuntime(
			db,
			"test_",
			"agent-a",
			makeConfig(),
			capabilities,
		)

		runtime.recordSignal([], "fallback")
		runtime.recordSignal([], "fallback")
		runtime.recordSignal([], "fallback")
		expect(runtime.getSampleState().current).toBe(0.1)

		for (let i = 0; i < 20; i++) {
			runtime.recordSignal(
				[
					{
						filePath: "/ok.md",
						path: "/ok.md",
						startLine: 1,
						endLine: 1,
						snippet: "ok",
						score: 0.9,
						source: "conversation",
					},
				],
				undefined,
			)
		}
		expect(runtime.getSampleState().current).toBe(0.01)
	})

	it("persistRegression stores numeric metrics without schema-fragile casting", async () => {
		const { db, collections } = mockDb()
		const runtime = new MongoDBRelevanceRuntime(
			db,
			"test_",
			"agent-a",
			makeConfig(),
			capabilities,
		)

		const regressions = await runtime.persistRegression("dataset-v1", {
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.75,
			p95LatencyMs: 180,
			rAt5: 0.8,
			rAt10: 0.9,
			ndcgAt10: 0.85,
		})

		const insert = collections.get("test_relevance_regressions")?.insertOne
		expect(insert).toHaveBeenCalledTimes(7)
		expect(regressions).toHaveLength(7)
		for (const call of insert?.mock.calls ?? []) {
			expect(call[0]).toEqual(
				expect.objectContaining({
					baseline: expect.any(Number),
					current: expect.any(Number),
					delta: expect.any(Number),
				}),
			)
		}
	})

	it("persistRegression still returns computed metrics when persistence fails", async () => {
		const { db, collections } = mockDb()
		const runtime = new MongoDBRelevanceRuntime(
			db,
			"test_",
			"agent-a",
			makeConfig(),
			capabilities,
		)

		const insert = collections.get("test_relevance_regressions")?.insertOne
		insert?.mockRejectedValueOnce(new Error("insert failed"))

		const regressions = await runtime.persistRegression("dataset-v1", {
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 0.75,
			p95LatencyMs: 180,
			rAt5: 0.8,
			rAt10: 0.9,
			ndcgAt10: 0.85,
		})

		expect(regressions).toHaveLength(7)
		expect(insert).toHaveBeenCalled()
	})
})
