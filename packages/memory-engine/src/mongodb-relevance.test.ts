/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock assertions */
import type { Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import {
	MongoDBRelevanceRuntime,
	summarizeExplain,
} from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"

const fenceState = vi.hoisted(() => ({ session: { fixture: true } }))
vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
			kind: "admission" as const,
			agentId,
			epoch: 0,
		})),
		withFencedWrite: vi.fn(
			async ({ fn }: { fn: (session: unknown) => Promise<unknown> }) =>
				fn(fenceState.session),
		),
	}
})

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
	storedSource: false,
	vectorIndexMethod: false,
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

	it("summarizeExplain never reports unrelated numeric leaves (RET-14 audit proof)", () => {
		// Exact audit proof case: serverInfo.port must not leak into any
		// metric; numCandidates is absent and must stay null, not borrowed.
		const summary = summarizeExplain({
			serverInfo: { port: 27017 },
			executionStats: {
				executionTimeMillis: 12,
				nReturned: 3,
				totalDocsExamined: 99,
			},
		})
		expect(summary).toEqual({
			executionTimeMs: 12,
			nReturned: 3,
			numCandidates: null,
		})
	})

	it("summarizeExplain prefers the measured executionTimeMillis over the stage estimate", () => {
		const summary = summarizeExplain({
			queryPlanner: {
				winningPlan: {
					stage: "VECTOR_SEARCH",
					executionTimeMillisEstimate: 5,
				},
			},
			executionStats: {
				executionTimeMillis: 21,
				nReturned: 7,
			},
		})
		expect(summary).toEqual({
			executionTimeMs: 21,
			nReturned: 7,
			numCandidates: null,
		})
	})

	it("summarizeExplain still finds the estimate alone (queryPlanner verbosity)", () => {
		const summary = summarizeExplain({
			queryPlanner: {
				winningPlan: {
					inputStage: {
						stage: "TEXT_MATCH",
						executionTimeMillisEstimate: 3,
					},
				},
			},
		})
		expect(summary).toEqual({
			executionTimeMs: 3,
			nReturned: null,
			numCandidates: null,
		})
	})

	it("summarizeExplain ignores unrelated numeric siblings before wanted nodes", () => {
		// Arrays and sibling objects carry unrelated numbers; only
		// key-matched values at any depth qualify.
		const summary = summarizeExplain({
			lanes: [
				{ attempts: 4, docs: [1, 2, 3] },
				{ nested: { deep: { nReturned: 9, noise: 12345 } } },
			],
			other: { totalKeysExamined: 500 },
		})
		expect(summary).toEqual({
			executionTimeMs: null,
			nReturned: 9,
			numCandidates: null,
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
		expect(runsInsert).toHaveBeenCalledWith(expect.anything(), {
			session: fenceState.session,
		})
		expect(artifactsInsert).toHaveBeenCalledWith(expect.anything(), {
			session: fenceState.session,
		})

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
})
