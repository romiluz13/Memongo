/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	classifyCanonicalIngestHealth,
	classifyProjectionHealth,
	classifyRetrievalHealth,
	computeOverallV2Health,
	deduplicateSearchResults,
	getActiveSources,
	getActiveSourcesForStatus,
	isConversationEvidenceQuery,
	mergeRankedResultSets,
	MongoDBMemoryManager,
	resolveExplainSources,
	scorePreferenceGroundingSignalBoost,
	writeEventAndProject,
	searchV2,
	getV2Status,
	rerankResults,
} from "./mongodb-manager.js"
import {
	ingestBenchmarkDataset,
	importConversationDataset,
	loadBenchmarkDataset,
} from "./mongodb-benchmark-harness.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { checkCache, writeCache } from "./mongodb-query-cache.js"
import { crossEncoderRerank } from "./mongodb-reranker.js"
import type { MemorySearchResult } from "./types.js"

const mocked = <T>(value: T): T => {
	const maybeMocked = (
		vi as typeof vi & {
			mocked?: <U>(item: U) => U
		}
	).mocked
	return maybeMocked?.(value) ?? value
}

describe("conversation evidence query detection", () => {
	it("routes advice and recommendation queries through conversation evidence", () => {
		expect(
			isConversationEvidenceQuery(
				"What should I serve for dinner this weekend?",
				undefined,
			),
		).toBe(true)
		expect(
			isConversationEvidenceQuery(
				"I've been having trouble with my phone battery. Any tips?",
				undefined,
			),
		).toBe(true)
		expect(
			isConversationEvidenceQuery(
				"Any suggestions for a cocktail get-together?",
				undefined,
			),
		).toBe(true)
	})
})

describe("preference grounding signal boost", () => {
	it("boosts first-person user memories for recommendation queries", () => {
		const result: MemorySearchResult = {
			path: "conversation/session-1",
			startLine: 1,
			endLine: 1,
			score: 0.5,
			snippet:
				"I've been using a portable power bank on trips and I recently attended a mixology class.",
			source: "conversation",
			provenance: { eventRole: "user" },
		}

		expect(
			scorePreferenceGroundingSignalBoost(
				"Any suggestions for my weekend setup?",
				result,
			),
		).toBeGreaterThanOrEqual(0.28)
	})

	it("does not boost assistant or non-recommendation evidence", () => {
		const result: MemorySearchResult = {
			path: "conversation/session-1",
			startLine: 1,
			endLine: 1,
			score: 0.5,
			snippet: "I've been using a portable power bank on trips.",
			source: "conversation",
			provenance: { eventRole: "assistant" },
		}

		expect(
			scorePreferenceGroundingSignalBoost(
				"Any tips for improving battery life?",
				result,
			),
		).toBe(0)
		expect(
			scorePreferenceGroundingSignalBoost("What date was the meeting?", {
				...result,
				provenance: { eventRole: "user" },
			}),
		).toBe(0)
	})
})

// ---------------------------------------------------------------------------
// Mocks for v2 module dependencies
// ---------------------------------------------------------------------------

vi.mock("./mongodb-events.js", () => ({
	writeEvent: vi.fn(),
	projectChunksFromEvents: vi.fn(),
	projectEventChunk: vi.fn(),
	getEventsByTimeRange: vi.fn(),
}))

vi.mock("./mongodb-ops.js", () => ({
	recordIngestRun: vi.fn(),
	getProjectionLag: vi.fn(),
	getLatestIngestRun: vi.fn(),
	getLatestProjectionRun: vi.fn(),
}))

vi.mock("./mongodb-benchmark-harness.js", () => ({
	ingestBenchmarkDataset: vi.fn(),
	ingestBenchmarkConversations: vi.fn(),
	importConversationDataset: vi.fn(),
	loadBenchmarkDataset: vi.fn(),
	resolveBenchmarkDatasetPath: vi.fn(
		async ({ datasetPath, baseDir, allowedRoots }) => {
			const fs = await import("node:fs/promises")
			const pathModule = await import("node:path")
			const candidate = pathModule.default.isAbsolute(datasetPath)
				? datasetPath
				: pathModule.default.resolve(baseDir, datasetPath)
			const resolved = await fs.realpath(candidate)
			const roots = await Promise.all(
				(allowedRoots ?? [baseDir]).map((root: string) =>
					fs.realpath(root).catch(() => pathModule.default.resolve(root)),
				),
			)
			const insideAllowedRoot = roots.some(
				(root) =>
					resolved === root ||
					resolved.startsWith(`${root}${pathModule.default.sep}`),
			)
			if (!insideAllowedRoot) {
				throw new Error(
					"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
				)
			}
			return resolved
		},
	),
}))

vi.mock("./mongodb-retrieval-planner.js", () => ({
	planRetrieval: vi.fn(),
	classifyRetrievalQuery: vi.fn(({ query, hasTimeRange, hasScopes }) => {
		const normalizedQuery = String(query ?? "").toLowerCase()
		if (!normalizedQuery.trim()) return "direct"
		if (
			hasTimeRange ||
			/\b(today|yesterday|last week|last month|when)\b/.test(normalizedQuery)
		) {
			return "temporal"
		}
		if (hasScopes) return "scoped"
		if (/\b(compare|versus|vs|difference)\b/.test(normalizedQuery)) {
			return "comparison"
		}
		if (/\b(why|because|after that|before that)\b/.test(normalizedQuery)) {
			return "multi-hop"
		}
		return "direct"
	}),
	extractTemporalWindow: vi.fn(() => undefined),
	resolveNumCandidates: vi.fn((limit: number, override?: number) => {
		if (
			typeof override === "number" &&
			Number.isFinite(override) &&
			override > 0
		) {
			return Math.floor(override)
		}
		return Math.max(200, Math.floor(limit * 20))
	}),
	resolveTimeRangePreset: vi.fn((preset: string, now = new Date()) => {
		const end = new Date(now)
		const start = new Date(end)
		if (preset === "last-24h") start.setUTCDate(start.getUTCDate() - 1)
		else if (preset === "last-7d") start.setUTCDate(start.getUTCDate() - 7)
		else if (preset === "last-30d") start.setUTCDate(start.getUTCDate() - 30)
		else start.setUTCHours(0, 0, 0, 0)
		return { start, end }
	}),
}))

vi.mock("./mongodb-episodes.js", () => ({
	searchEpisodes: vi.fn(),
}))

vi.mock("./mongodb-graph.js", () => ({
	searchEntitiesAutocomplete: vi.fn(),
	expandGraph: vi.fn(),
	extractAndUpsertEntities: vi.fn(),
}))

vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
	entitiesCollection: vi.fn(),
	relationsCollection: vi.fn(),
	episodesCollection: vi.fn(),
	proceduresCollection: vi.fn(),
	chunksCollection: vi.fn(),
	filesCollection: vi.fn(),
	metaCollection: vi.fn(),
	kbCollection: vi.fn(),
	kbChunksCollection: vi.fn(),
	relevanceRunsCollection: vi.fn(),
	recallTracesCollection: vi.fn(),
	structuredMemCollection: vi.fn(),
	embeddingCacheCollection: vi.fn(),
	detectCapabilities: vi.fn(),
	ensureCollections: vi.fn(),
	ensureSchemaValidation: vi.fn(),
	ensureSearchIndexes: vi.fn(),
	ensureStandardIndexes: vi.fn(),
	waitForSearchCapabilities: vi.fn(),
	waitForSearchIndexesQueryable: vi.fn(),
	resolveSearchIndexReadinessTiming: vi.fn(() => ({
		timeoutMs: 60_000,
		pollMs: 1_000,
	})),
	getExpectedSearchIndexTargets: vi.fn(() => []),
	sessionChunksCollection: vi.fn(),
}))

vi.mock("./mongodb-query-cache.js", () => ({
	checkCache: vi.fn(),
	writeCache: vi.fn(),
}))

vi.mock("./mongodb-reranker.js", () => ({
	crossEncoderRerank: vi.fn(async ({ results }) => ({
		results,
		reranked: false,
		latencyMs: 0,
	})),
}))

vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
	updateLaneCoverage: vi.fn(),
}))

vi.mock("./mongodb-memory-jobs.js", () => ({
	createMemoryJob: vi.fn(),
	getMemoryJob: vi.fn(),
	listMemoryJobs: vi.fn(),
	updateMemoryJob: vi.fn(),
}))

vi.mock("./mongodb-consolidator.js", () => ({
	consolidateMemory: vi.fn(),
}))

vi.mock("./mongodb-derived-memory.js", () => ({
	heuristicEpisodeSummarizer: vi.fn(async () => ({
		title: "Thread: synthetic",
		summary: "Synthetic summary",
	})),
	promoteDerivedMemoryFromEvent: vi.fn(),
	extractStructuredCandidatesFromEvent: vi.fn(() => []),
	resolveStructuredCandidatesForPromotion: vi.fn(async () => []),
	extractProcedureCandidatesFromEvent: vi.fn(() => []),
}))

vi.mock("./mongodb-benchmark-readiness.js", () => ({
	readSearchIndexStatus: vi.fn().mockResolvedValue({
		kind: "fallback",
		reason: "command-not-found",
	}),
}))

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Phase 3: Result dedup at merge by stable evidence identity
// ---------------------------------------------------------------------------

describe("deduplicateSearchResults", () => {
	const makeResult = (
		filePath: string,
		snippet: string,
		score: number,
		source: MemorySearchResult["source"],
	): MemorySearchResult => ({
		filePath,
		path: filePath,
		startLine: 1,
		endLine: 1,
		snippet,
		score,
		source,
	})

	it("removes duplicate results by evidence identity, keeping the highest-scoring one", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "same content here", 0.9, "conversation"),
			makeResult("/a.md", "same content here", 0.7, "reference"),
			makeResult("/c.md", "different content", 0.8, "structured"),
		]

		const deduped = deduplicateSearchResults(results)
		expect(deduped).toHaveLength(2)
		// The duplicate locator should keep the one with score 0.9
		const sameContentResult = deduped.find(
			(r) => r.snippet === "same content here",
		)
		expect(sameContentResult?.score).toBe(0.9)
		expect(sameContentResult?.filePath).toBe("/a.md")
	})

	it("returns empty array for empty input", () => {
		const deduped = deduplicateSearchResults([])
		expect(deduped).toHaveLength(0)
	})

	it("keeps all results when no duplicates exist", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "first content", 0.9, "conversation"),
			makeResult("/b.md", "second content", 0.7, "reference"),
			makeResult("/c.md", "third content", 0.5, "structured"),
		]

		const deduped = deduplicateSearchResults(results)
		expect(deduped).toHaveLength(3)
	})

	it("keeps distinct evidence with identical snippet text", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "same text", 0.9, "conversation"),
			makeResult("/b.md", "same text", 0.7, "reference"),
		]

		const deduped = deduplicateSearchResults(results)

		expect(deduped).toHaveLength(2)
	})

	it("handles multiple duplicates correctly", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "alpha content", 0.3, "conversation"),
			makeResult("/a.md", "alpha content", 0.9, "reference"),
			makeResult("/a.md", "alpha content", 0.5, "structured"),
			makeResult("/d.md", "beta content", 0.8, "conversation"),
			makeResult("/d.md", "beta content", 0.6, "structured"),
		]

		const deduped = deduplicateSearchResults(results)
		expect(deduped).toHaveLength(2)
		const alpha = deduped.find((r) => r.snippet === "alpha content")
		expect(alpha?.score).toBe(0.9)
		const beta = deduped.find((r) => r.snippet === "beta content")
		expect(beta?.score).toBe(0.8)
	})

	it("returns dedupCount in the result when logging is needed", () => {
		const results: MemorySearchResult[] = [
			makeResult("/a.md", "dup content", 0.9, "conversation"),
			makeResult("/a.md", "dup content", 0.7, "reference"),
		]

		// The function should return deduped results — the count of removed duplicates
		// can be derived from input.length - output.length
		const deduped = deduplicateSearchResults(results)
		const dedupCount = results.length - deduped.length
		expect(dedupCount).toBe(1)
	})
})

describe("mergeRankedResultSets", () => {
	const makeResult = (
		path: string,
		score: number,
		source: MemorySearchResult["source"] = "conversation",
	): MemorySearchResult => ({
		path,
		filePath: path,
		startLine: 0,
		endLine: 0,
		score,
		snippet: path,
		source,
		canonicalId: path,
	})

	it("combines independent ranked lists without penalizing later arrays", () => {
		const turnResults = Array.from({ length: 8 }, (_, index) =>
			makeResult(`event:${index}`, 1 - index * 0.01),
		)
		const sessionResults = [
			makeResult("session-chunk:best", 0.01),
			makeResult("session-chunk:next", 0.009),
		]

		const merged = mergeRankedResultSets([turnResults, sessionResults])

		expect(merged.slice(0, 4).map((result) => result.canonicalId)).toContain(
			"session-chunk:best",
		)
		expect(
			merged.findIndex((result) => result.canonicalId === "session-chunk:best"),
		).toBeLessThan(
			merged.findIndex((result) => result.canonicalId === "event:7"),
		)
	})

	it("sums RRF contribution for duplicate evidence identities", () => {
		const sharedA = makeResult("event:shared", 0.2)
		const sharedB = makeResult("event:shared", 0.9)
		const merged = mergeRankedResultSets([
			[makeResult("event:other-a", 0.8), sharedA],
			[sharedB, makeResult("event:other-b", 0.7)],
		])

		expect(merged[0]?.canonicalId).toBe("event:shared")
		expect(merged[0]?.snippet).toBe("event:shared")
	})
})

describe("benchmarkIngest", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves workspace-relative benchmark datasets before replay", async () => {
		mocked(ingestBenchmarkDataset).mockResolvedValue({
			datasetPath: "/workspace/benchmarks/dataset.jsonl",
			datasetName: "dataset.jsonl",
			conversationsIngested: 1,
			turnsIngested: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-09T00:00:00.000Z"),
			completedAt: new Date("2026-04-09T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-workspace-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.jsonl")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, "")
			const expectedDatasetPath = await realpath(datasetPath)
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(datasetDir, "default.jsonl"),
							},
						},
					},
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.benchmarkIngest.call(manager, {
				datasetPath: "benchmarks/dataset.jsonl",
			})

			expect(ingestBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: expectedDatasetPath,
					allowedRoots: expect.arrayContaining([workspaceDir, datasetDir]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("rejects benchmark datasets outside allowed roots", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-workspace-"),
		)
		const outsideDir = await mkdtemp(path.join(os.tmpdir(), "memongo-outside-"))
		const outsideFile = path.join(outsideDir, "dataset.jsonl")
		try {
			await writeFile(outsideFile, "")
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(
									workspaceDir,
									"benchmarks",
									"default.jsonl",
								),
							},
						},
					},
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await expect(
				MongoDBMemoryManager.prototype.benchmarkIngest.call(manager, {
					datasetPath: outsideFile,
				}),
			).rejects.toThrow(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
			await rm(outsideDir, { recursive: true, force: true })
		}
	})

	it("allows explicit benchmark dataset roots from the environment", async () => {
		mocked(ingestBenchmarkDataset).mockResolvedValue({
			datasetPath: "/outside/dataset.jsonl",
			datasetName: "dataset.jsonl",
			conversationsIngested: 1,
			turnsIngested: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-09T00:00:00.000Z"),
			completedAt: new Date("2026-04-09T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-workspace-"),
		)
		const outsideDir = await mkdtemp(path.join(os.tmpdir(), "memongo-outside-"))
		const outsideFile = path.join(outsideDir, "dataset.jsonl")
		const previous = process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS
		try {
			await writeFile(outsideFile, "")
			process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS = outsideDir
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(
									workspaceDir,
									"benchmarks",
									"default.jsonl",
								),
							},
						},
					},
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.benchmarkIngest.call(manager, {
				datasetPath: outsideFile,
			})

			expect(ingestBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: await realpath(outsideFile),
					allowedRoots: expect.arrayContaining([outsideDir]),
				}),
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS
			} else {
				process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS = previous
			}
			await rm(workspaceDir, { recursive: true, force: true })
			await rm(outsideDir, { recursive: true, force: true })
		}
	})
})

describe("benchmark event search convergence", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const makeSearchConvergenceManager = () =>
		Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: fakeDb,
			prefix: fakePrefix,
			config: {
				mongodb: {
					embeddingMode: "automated",
				},
			},
			capabilities: { textSearch: true, vectorSearch: true },
		}) as MongoDBMemoryManager
	const makeSearchableFind = (values = ["alpha", "beta"]) =>
		vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue(values.map((body) => ({ body }))),
		})
	const makeSearchableTextFind = (values = ["alpha", "beta"]) =>
		vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue(values.map((text) => ({ text }))),
		})

	it("bounds each MongoDB Search convergence probe with maxTimeMS", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "60000"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1234"
		try {
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkEventSearchConvergence: (
						this: MongoDBMemoryManager,
						agentId: string,
					) => Promise<void>
				}
			).waitForBenchmarkEventSearchConvergence.call(manager, "agent-1")

			expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
				maxTimeMS: 1234,
				signal: expect.any(AbortSignal),
			})
			const [pipeline] = aggregate.mock.calls[0]
			expect(pipeline[0].$searchMeta.compound.must).toEqual([
				{
					wildcard: {
						path: "body",
						query: "*",
						allowAnalyzedField: true,
					},
				},
			])
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
		}
	})

	it("narrows MongoDB Search convergence probes to scope filters", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1234"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "events_text",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			const find = makeSearchableFind()
			const manager = makeSearchConvergenceManager()

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkSearchCollectionConvergence: (
						this: MongoDBMemoryManager,
						params: {
							agentId: string
							scope?:
								| "session"
								| "user"
								| "agent"
								| "workspace"
								| "tenant"
								| "global"
							scopeRef?: string
							sessionId?: string
							label: string
							collection: unknown
							collectionName: string
							indexName: string
							textPath: string
						},
					) => Promise<void>
				}
			).waitForBenchmarkSearchCollectionConvergence.call(manager, {
				agentId: "agent-1",
				scope: "user",
				scopeRef: "user:bench-17",
				sessionId: "bench-17",
				label: "events",
				collection: { find, aggregate },
				collectionName: "test_events",
				indexName: "test_events_text",
				textPath: "body",
			})

			expect(find).toHaveBeenCalledWith(
				{
					agentId: "agent-1",
					scope: "user",
					scopeRef: "user:bench-17",
					sessionId: "bench-17",
					body: { $type: "string", $ne: "" },
				},
				{ projection: { body: 1 } },
			)
			const [pipeline] = aggregate.mock.calls[0]
			expect(pipeline[0].$searchMeta.compound.filter).toEqual([
				{ equals: { path: "agentId", value: "agent-1" } },
				{ equals: { path: "scope", value: "user" } },
				{ equals: { path: "scopeRef", value: "user:bench-17" } },
				{ equals: { path: "sessionId", value: "bench-17" } },
			])
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
		}
	})

	// Task 1.5 — readSearchIndexStatus delegation tests.
	// The readSearchIndexStatus helper is mocked at module scope; each test
	// overrides the return value for that test.
	it("still probes document visibility when readiness helper reports queryable=true", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const prevSettle =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		const { readSearchIndexStatus } = await import(
			"./mongodb-benchmark-readiness.js"
		)
		try {
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "events_text",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(manager, "agent-ready"),
			).resolves.toBeUndefined()
			expect(aggregate).toHaveBeenCalled()
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
			if (prevSettle === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					prevSettle
		}
	})

	it("waits for actual text terms after wildcard document visibility", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const prevSettle =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const prevProbe =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "3000"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1000"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "events_text",
			})
			const textCounts = [0, 1]
			const aggregate = vi
				.fn()
				.mockImplementation((pipeline: Array<unknown>) => {
					const firstStage = pipeline[0] as {
						$searchMeta?: {
							compound?: { must?: Array<Record<string, unknown>> }
						}
					}
					const must = firstStage.$searchMeta?.compound?.must ?? []
					const isTextProbe = Boolean(must[0]?.text)
					return {
						toArray: vi
							.fn()
							.mockResolvedValue([
								{ count: isTextProbe ? (textCounts.shift() ?? 1) : 2 },
							]),
					}
				})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(["alpha", "beta"]),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(manager, "agent-ready"),
			).resolves.toBeUndefined()
			expect(aggregate).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({
						$searchMeta: expect.objectContaining({
							compound: expect.objectContaining({
								must: [
									{
										text: {
											path: "body",
											query: "beta",
										},
									},
								],
							}),
						}),
					}),
				]),
				expect.any(Object),
			)
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
			if (prevSettle === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					prevSettle
			if (prevProbe === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = prevProbe
		}
	})

	it("does not wait for non-searchable control-character text", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		const aggregate = vi.fn()
		try {
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(["\u200b"]),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(
					manager,
					"agent-zero-width",
				),
			).resolves.toBeUndefined()
			expect(aggregate).not.toHaveBeenCalled()
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("aborts on STALE in strict mode even when queryable=true (Task 1.5)", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "STALE",
				queryable: true,
				indexName: "events_text",
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(manager, "agent-stale"),
			).rejects.toThrow(/index-not-ready|STALE/)
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("aborts on queryable=false in strict mode (Task 1.5)", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "BUILDING",
				queryable: false,
				indexName: "events_text",
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
			} as never)

			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkEventSearchConvergence: (
							this: MongoDBMemoryManager,
							agentId: string,
						) => Promise<void>
					}
				).waitForBenchmarkEventSearchConvergence.call(
					manager,
					"agent-building",
				),
			).rejects.toThrow(/index-not-ready|queryable=false|BUILDING/)
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("falls back to aggregate probe when helper signals fallback (Task 1.5)", async () => {
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const prevSettle =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const prevProbe =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		// Use a short settle window so this test stays fast even under the
		// aggregate probe loop.
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = "1000"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "fallback",
				reason: "command-not-found",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(eventsCollection).mockReturnValue({
				find: makeSearchableFind(),
				aggregate,
			} as never)

			const manager = makeSearchConvergenceManager()

			const start = Date.now()
			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkEventSearchConvergence: (
						this: MongoDBMemoryManager,
						agentId: string,
					) => Promise<void>
				}
			).waitForBenchmarkEventSearchConvergence.call(manager, "agent-fallback")
			// Aggregate-probe fallback must still bound itself under the
			// configured probeMaxTime — this completes well under 2s.
			expect(Date.now() - start).toBeLessThan(3000)
			expect(aggregate).toHaveBeenCalled()
		} finally {
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
			if (prevSettle === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					prevSettle
			if (prevProbe === undefined)
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			else
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS = prevProbe
		}
	})

	it("probes raw-session readiness through the session_chunks vector index", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS = "1234"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind(),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkSearchConvergence: (
						this: MongoDBMemoryManager,
						params: {
							agentId: string
							retrievalLane?: "native" | "raw-session"
							scope?:
								| "session"
								| "user"
								| "agent"
								| "workspace"
								| "tenant"
								| "global"
							scopeRef?: string
							sessionId?: string
						},
					) => Promise<void>
				}
			).waitForBenchmarkSearchConvergence.call(manager, {
				agentId: "agent-raw",
				retrievalLane: "raw-session",
				scope: "user",
				scopeRef: "user:bench-17",
				sessionId: "bench-17",
			})

			expect(aggregate).toHaveBeenCalledWith(
				[
					{
						$vectorSearch: expect.objectContaining({
							exact: true,
							filter: {
								agentId: "agent-raw",
								scope: "user",
								scopeRef: "user:bench-17",
								sessionId: "bench-17",
							},
							index: "test_session_chunks_vector",
							model: "voyage-4-large",
							path: "text",
							query: { text: "benchmark vector readiness probe" },
						}),
					},
					{ $count: "count" },
				],
				{ maxTimeMS: 1234, signal: expect.any(AbortSignal) },
			)
			expect(
				(
					mocked(sessionChunksCollection).mock.results[0]?.value as {
						find: ReturnType<typeof vi.fn>
					}
				).find,
			).toHaveBeenCalledWith(
				{
					agentId: "agent-raw",
					scope: "user",
					scopeRef: "user:bench-17",
					sessionId: "bench-17",
					text: { $type: "string", $ne: "" },
				},
				{ projection: { text: 1 } },
			)
			expect(eventsCollection).not.toHaveBeenCalled()
			expect(chunksCollection).not.toHaveBeenCalled()
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
		}
	})

	it("uses longer strict defaults for raw-session vector probes", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		const previousFallbackTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		const previousProbeTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
		const previousFallbackProbeTimeout =
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
		delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
		delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind(),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await (
				MongoDBMemoryManager.prototype as unknown as {
					waitForBenchmarkSearchConvergence: (
						this: MongoDBMemoryManager,
						params: {
							agentId: string
							retrievalLane?: "native" | "raw-session"
						},
					) => Promise<void>
				}
			).waitForBenchmarkSearchConvergence.call(manager, {
				agentId: "agent-defaults",
				retrievalLane: "raw-session",
			})

			expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
				maxTimeMS: 30000,
				signal: expect.any(AbortSignal),
			})
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
			if (previousFallbackTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS =
					previousFallbackTimeout
			}
			if (previousProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS =
					previousProbeTimeout
			}
			if (previousFallbackProbeTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS
			} else {
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS =
					previousFallbackProbeTimeout
			}
		}
	})

	it("waits through pending raw-session vector readiness when aggregate results are visible", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS = "1500"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "PENDING",
				queryable: false,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([{ count: 2 }]),
			})
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind(),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkSearchConvergence: (
							this: MongoDBMemoryManager,
							params: {
								agentId: string
								retrievalLane?: "native" | "raw-session"
							},
						) => Promise<void>
					}
				).waitForBenchmarkSearchConvergence.call(manager, {
					agentId: "agent-pending",
					retrievalLane: "raw-session",
				}),
			).resolves.toBeUndefined()
			expect(aggregate).toHaveBeenCalled()
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS =
					previousTimeout
			}
		}
	})

	it("fails strict raw-session convergence when no session evidence documents exist", async () => {
		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const { readSearchIndexStatus } = await import(
				"./mongodb-benchmark-readiness.js"
			)
			mocked(readSearchIndexStatus).mockResolvedValue({
				kind: "ok",
				status: "READY",
				queryable: true,
				indexName: "test_session_chunks_vector",
			})
			const aggregate = vi.fn()
			mocked(sessionChunksCollection).mockReturnValue({
				find: makeSearchableTextFind([]),
				aggregate,
			} as never)
			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						waitForBenchmarkSearchConvergence: (
							this: MongoDBMemoryManager,
							params: {
								agentId: string
								retrievalLane?: "native" | "raw-session"
							},
						) => Promise<void>
					}
				).waitForBenchmarkSearchConvergence.call(manager, {
					agentId: "agent-missing-session-evidence",
					retrievalLane: "raw-session",
				}),
			).rejects.toThrow(
				"benchmark session_chunks vector convergence has no searchable documents",
			)
			expect(aggregate).not.toHaveBeenCalled()
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
		}
	})
})

describe("benchmark scenario queue settling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("fails fast when a benchmark scenario queue does not settle", async () => {
		const previousTimeout =
			process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-1",
				writeQueue: new Promise<void>(() => {}),
				derivationQueue: Promise.resolve(),
			} as unknown as MongoDBMemoryManager

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						settleBenchmarkScenarioManager: (
							this: MongoDBMemoryManager,
							manager: MongoDBMemoryManager,
						) => Promise<void>
					}
				).settleBenchmarkScenarioManager.call(manager, manager),
			).rejects.toThrow(
				"benchmark scenario manager writeQueue settle timed out after 1ms",
			)
		} finally {
			if (previousTimeout === undefined) {
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			} else {
				process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = previousTimeout
			}
		}
	})

	// Task 1.3 — complete queue-settle timeout coverage (plan Harness Checklist #3).
	const callSettle = async (manager: MongoDBMemoryManager) =>
		(
			MongoDBMemoryManager.prototype as unknown as {
				settleBenchmarkScenarioManager: (
					this: MongoDBMemoryManager,
					manager: MongoDBMemoryManager,
				) => Promise<void>
			}
		).settleBenchmarkScenarioManager.call(manager, manager)

	it("names writeQueue when writeQueue hangs (Task 1.3)", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-write",
				writeQueue: new Promise<void>(() => {}),
				derivationQueue: Promise.resolve(),
			} as unknown as MongoDBMemoryManager
			await expect(callSettle(manager)).rejects.toThrow(
				/writeQueue settle timed out after 200ms/,
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("names derivationQueue when derivationQueue hangs (Task 1.3)", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-derivation",
				writeQueue: Promise.resolve(),
				derivationQueue: new Promise<void>(() => {}),
			} as unknown as MongoDBMemoryManager
			await expect(callSettle(manager)).rejects.toThrow(
				/derivationQueue settle timed out after 200ms/,
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("names derivationSchedulingQueue when post-write scheduling hangs", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-scheduling",
				writeQueue: Promise.resolve(),
				derivationSchedulingQueue: new Promise<void>(() => {}),
				derivationQueue: Promise.resolve(),
			} as unknown as MongoDBMemoryManager
			await expect(callSettle(manager)).rejects.toThrow(
				/derivationSchedulingQueue settle timed out after 200ms/,
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("waits for post-write scheduling that enqueues derived work", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "500"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-scheduling-flush",
				writeQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
			} as MongoDBMemoryManager & {
				derivationSchedulingQueue: Promise<void>
				derivationQueue: Promise<void>
			}
			manager.derivationSchedulingQueue = new Promise<void>((resolve) => {
				setTimeout(() => {
					manager.derivationQueue = new Promise<void>((resolveDerived) => {
						setTimeout(resolveDerived, 25)
					})
					resolve()
				}, 25)
			})

			await expect(callSettle(manager)).resolves.toBeUndefined()
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})

	it("succeeds on slow-but-bounded queue under timeout (Task 1.3)", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "500"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-slow",
				writeQueue: new Promise<void>((resolve) => setTimeout(resolve, 50)),
				derivationQueue: Promise.resolve(),
			} as unknown as MongoDBMemoryManager
			await expect(callSettle(manager)).resolves.toBeUndefined()
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
			else process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = prev
			if (prevStrict === undefined) delete process.env.MEMONGO_BENCHMARK_STRICT
			else process.env.MEMONGO_BENCHMARK_STRICT = prevStrict
		}
	})
})

describe("importConversations", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves workspace-relative conversation imports before replay", async () => {
		mocked(importConversationDataset).mockResolvedValue({
			datasetPath: "/workspace/imports/history.json",
			datasetName: "history.json",
			datasetKind: "generic",
			conversationsImported: 1,
			turnsImported: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-11T00:00:00.000Z"),
			completedAt: new Date("2026-04-11T00:00:01.000Z"),
		})

		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-import-workspace-"),
		)
		const importDir = path.join(workspaceDir, "imports")
		const datasetPath = path.join(importDir, "history.json")
		try {
			await mkdir(importDir, { recursive: true })
			await writeFile(datasetPath, JSON.stringify({ conversations: [] }))
			const expectedDatasetPath = await realpath(datasetPath)
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(importDir, "default.json"),
							},
						},
					},
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await MongoDBMemoryManager.prototype.importConversations.call(manager, {
				datasetPath: "imports/history.json",
			})

			expect(importConversationDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: expectedDatasetPath,
					allowedRoots: expect.arrayContaining([workspaceDir, importDir]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("rejects conversation imports outside allowed roots", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-import-workspace-"),
		)
		const outsideDir = await mkdtemp(path.join(os.tmpdir(), "memongo-outside-"))
		const outsideFile = path.join(outsideDir, "history.json")
		try {
			await writeFile(outsideFile, JSON.stringify({ conversations: [] }))
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								datasetPath: path.join(workspaceDir, "imports", "default.json"),
							},
						},
					},
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				writeConversationEvent: vi.fn(),
			} as unknown as MongoDBMemoryManager

			await expect(
				MongoDBMemoryManager.prototype.importConversations.call(manager, {
					datasetPath: outsideFile,
				}),
			).rejects.toThrow(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
			await rm(outsideDir, { recursive: true, force: true })
		}
	})
})

describe("relevanceBenchmark", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("routes scenario datasets through the new scenario benchmark runner", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.json")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, JSON.stringify({ name: "placeholder" }))
			const resolvedDatasetPath = await realpath(datasetPath)
			mocked(loadBenchmarkDataset).mockResolvedValue({
				name: "LongMemEval sample",
				datasetKind: "longmemeval",
				conversations: [],
				evaluations: [],
				scenarios: [
					{
						scenarioId: "scenario-1",
						conversations: [],
						evaluations: [
							{
								caseId: "case-1",
								query: "When is the launch?",
								expectedSessionIds: ["session-1"],
							},
						],
					},
				],
			})

			const runScenarioBenchmarkDataset = vi.fn().mockResolvedValue({
				result: {
					datasetVersion: "dataset-v1",
					datasetName: "LongMemEval sample",
					datasetKind: "longmemeval",
					scenarios: 1,
					cases: 1,
					scoredCases: 1,
					skippedCases: 0,
					hitRate: 1,
					emptyRate: 0,
					avgTopScore: 0.9,
					p95LatencyMs: 10,
					rAt5: 1,
					rAt10: 1,
					ndcgAt10: 1,
					questionTypeBreakdown: [],
					regressions: [],
				},
				latencySamples: [10],
			})

			const manager = {
				workspaceDir,
				db: {
					command: vi.fn().mockResolvedValue({ size: 0, totalIndexSize: 0 }),
				},
				prefix: "memongo_bench_",
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								enabled: true,
								datasetPath: path.join(datasetDir, "default.json"),
							},
						},
						numDimensions: 1024,
						quantization: "none",
						reranking: { enabled: false, model: "rerank-2.5", topN: 20 },
					},
				},
				relevance: {
					loadBenchmarkDataset: vi.fn(),
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				buildBenchmarkDatasetVersion:
					MongoDBMemoryManager.prototype.buildBenchmarkDatasetVersion,
				buildBenchmarkParityBundle:
					MongoDBMemoryManager.prototype["buildBenchmarkParityBundle"],
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark: vi.fn(),
			} as unknown as MongoDBMemoryManager

			const result =
				await MongoDBMemoryManager.prototype.relevanceBenchmark.call(manager, {
					datasetPath: "benchmarks/dataset.json",
				})

			expect(loadBenchmarkDataset).toHaveBeenCalledWith(
				resolvedDatasetPath,
				expect.objectContaining({
					allowedRoots: expect.arrayContaining([workspaceDir, datasetDir]),
				}),
			)
			expect(runScenarioBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: resolvedDatasetPath,
					datasetVersion: createHash("sha256")
						.update('{"name":"placeholder"}')
						.digest("hex")
						.slice(0, 16),
				}),
			)
			expect(result.queryGovernance).toEqual(
				expect.objectContaining({
					status: "advisory-only",
				}),
			)
			expect(result.benchmarkReport).toEqual(
				expect.objectContaining({
					generatedAt: expect.any(Date),
					corpus: expect.objectContaining({
						datasetVersion: "dataset-v1",
						datasetName: "LongMemEval sample",
						datasetKind: "longmemeval",
						cases: 1,
						scoredCases: 1,
					}),
					metrics: expect.objectContaining({
						internal: expect.objectContaining({
							rAt5: 1,
							ndcgAt10: 1,
						}),
					}),
					releaseGates: expect.arrayContaining([
						expect.objectContaining({
							gate: "query-governance",
							status: "advisory-only",
						}),
					]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("falls back to the legacy benchmark path for query-only datasets", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.jsonl")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, '{"query":"legacy"}\n')
			const resolvedDatasetPath = await realpath(datasetPath)
			mocked(loadBenchmarkDataset).mockRejectedValue(
				new Error("benchmark dataset contains no valid conversations"),
			)
			const runLegacyRelevanceBenchmark = vi.fn().mockResolvedValue({
				result: {
					datasetVersion: "legacy-v1",
					cases: 1,
					hitRate: 1,
					emptyRate: 0,
					avgTopScore: 0.8,
					p95LatencyMs: 12,
					rAt5: 0,
					rAt10: 0,
					ndcgAt10: 0,
					regressions: [],
				},
				latencySamples: [12],
			})

			const manager = {
				workspaceDir,
				db: {
					command: vi.fn().mockResolvedValue({ size: 0, totalIndexSize: 0 }),
				},
				prefix: "memongo_bench_",
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								enabled: true,
								datasetPath: path.join(datasetDir, "default.jsonl"),
							},
						},
						numDimensions: 1024,
						quantization: "none",
						reranking: { enabled: false, model: "rerank-2.5", topN: 20 },
					},
				},
				relevance: {
					loadBenchmarkDataset: vi
						.fn()
						.mockResolvedValue([{ query: "legacy" }]),
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				buildBenchmarkParityBundle:
					MongoDBMemoryManager.prototype["buildBenchmarkParityBundle"],
				runScenarioBenchmarkDataset: vi.fn(),
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			const result =
				await MongoDBMemoryManager.prototype.relevanceBenchmark.call(manager, {
					datasetPath: "benchmarks/dataset.jsonl",
				})

			expect(runLegacyRelevanceBenchmark).toHaveBeenCalledWith({
				datasetPath: resolvedDatasetPath,
				maxResults: 10,
				minScore: 0.01,
			})
			expect(result.queryGovernance?.candidates[0]?.source).toBe("benchmark")
			expect(result.benchmarkReport).toEqual(
				expect.objectContaining({
					corpus: expect.objectContaining({
						datasetVersion: "legacy-v1",
						cases: 1,
					}),
					warnings: expect.arrayContaining([
						expect.stringContaining("officialMetrics are absent"),
					]),
				}),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("does not silently fall back to legacy when scenario execution fails", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-"),
		)
		const datasetDir = path.join(workspaceDir, "benchmarks")
		const datasetPath = path.join(datasetDir, "dataset.json")
		try {
			await mkdir(datasetDir, { recursive: true })
			await writeFile(datasetPath, JSON.stringify({ name: "placeholder" }))
			mocked(loadBenchmarkDataset).mockResolvedValue({
				name: "LongMemEval sample",
				datasetKind: "longmemeval",
				conversations: [],
				evaluations: [],
				scenarios: [
					{
						scenarioId: "scenario-1",
						conversations: [],
						evaluations: [
							{
								caseId: "case-1",
								query: "When is the launch?",
								expectedSessionIds: ["session-1"],
							},
						],
					},
				],
			})

			const runLegacyRelevanceBenchmark = vi.fn()
			const runScenarioBenchmarkDataset = vi
				.fn()
				.mockRejectedValue(new Error("scenario search timeout"))

			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: {
								enabled: true,
								datasetPath: path.join(datasetDir, "default.json"),
							},
						},
					},
				},
				relevance: {
					loadBenchmarkDataset: vi.fn(),
				},
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				buildBenchmarkDatasetVersion:
					MongoDBMemoryManager.prototype.buildBenchmarkDatasetVersion,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			await expect(
				MongoDBMemoryManager.prototype.relevanceBenchmark.call(manager, {
					datasetPath: "benchmarks/dataset.json",
				}),
			).rejects.toThrow("scenario search timeout")
			expect(runLegacyRelevanceBenchmark).not.toHaveBeenCalled()
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})

describe("runScenarioBenchmarkDataset", () => {
	it("continues scoring after an individual evaluation query fails", async () => {
		const search = vi
			.fn()
			.mockRejectedValueOnce(new Error("search timeout"))
			.mockResolvedValueOnce([
				{
					path: "memory://result",
					startLine: 1,
					endLine: 1,
					score: 0.9,
					snippet: "memory hit",
					source: "conversation",
					sessionId: "session-2",
				},
			] satisfies MemorySearchResult[])

		const manager = {
			agentId: "agent-1",
			relevance: {
				persistRegression: vi.fn().mockResolvedValue([]),
			},
			search,
			listBenchmarkEventEvidence: vi.fn().mockResolvedValue({
				sessionIds: new Map<string, string>(),
				turnIds: new Map<string, string>(),
				dialogIds: new Map<string, string>(),
			}),
			collectBenchmarkResultSourceEventIds:
				MongoDBMemoryManager.prototype.collectBenchmarkResultSourceEventIds,
			resolveBenchmarkResultSessionIds:
				MongoDBMemoryManager.prototype.resolveBenchmarkResultSessionIds,
			resolveBenchmarkResultTurnIds:
				MongoDBMemoryManager.prototype.resolveBenchmarkResultTurnIds,
			resolveBenchmarkResultDialogIds:
				MongoDBMemoryManager.prototype.resolveBenchmarkResultDialogIds,
		} as unknown as MongoDBMemoryManager

		const result =
			await MongoDBMemoryManager.prototype.runScenarioBenchmarkDataset.call(
				manager,
				{
					datasetPath: "/tmp/benchmark.json",
					dataset: {
						name: "LongMemEval sample",
						datasetKind: "longmemeval",
						scenarios: [
							{
								scenarioId: "scenario-1",
								conversations: [],
								evaluations: [
									{
										caseId: "case-1",
										query: "First question",
										expectedSessionIds: ["session-1"],
										questionType: "single-session",
									},
									{
										caseId: "case-2",
										query: "Second question",
										expectedSessionIds: ["session-2"],
										questionType: "single-session",
									},
								],
							},
						],
						evaluations: [],
						conversations: [],
					},
					datasetVersion: "dataset-v1",
					maxResults: 10,
					minScore: 0.1,
				},
			)

		expect(search).toHaveBeenCalledTimes(2)
		// Phase 3 REM-FIX Task 1.A: runScenarioBenchmarkDataset now returns
		// `{ result, latencySamples }` so the caller can project parity fields.
		expect(result.result.cases).toBe(2)
		expect(result.result.scoredCases).toBe(2)
		expect(result.result.hitRate).toBe(0.5)
		expect(result.result.rAt10).toBe(0.5)
		expect(result.latencySamples).toHaveLength(2)
	})

	it("hashes the raw dataset file to build scenario datasetVersion", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-benchmark-version-"),
		)
		const datasetPath = path.join(workspaceDir, "dataset.json")
		const datasetText =
			'{"name":"LongMemEval sample","scenarios":[{"scenarioId":"scenario-1"}]}\n'
		try {
			await writeFile(datasetPath, datasetText, "utf8")

			const datasetVersion =
				await MongoDBMemoryManager.prototype.buildBenchmarkDatasetVersion.call(
					{} as MongoDBMemoryManager,
					datasetPath,
				)

			expect(datasetVersion).toBe(
				createHash("sha256").update(datasetText).digest("hex").slice(0, 16),
			)
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})

// ---------------------------------------------------------------------------
// Phase 3: Source policy enforcement helpers
// ---------------------------------------------------------------------------

describe("getActiveSources", () => {
	it("returns all sources when all enabled", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, true)
		expect(active.conversation).toBe(true)
		expect(active.reference).toBe(true)
		expect(active.structured).toBe(true)
	})

	it("disables conversation search when conversation.enabled is false", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: false },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, true)
		expect(active.conversation).toBe(false)
		expect(active.reference).toBe(true)
		expect(active.structured).toBe(true)
	})

	it("disables reference (KB) search when reference.enabled is false", () => {
		const sources = {
			reference: { enabled: false },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, true)
		expect(active.reference).toBe(false)
	})

	it("disables reference when kb is disabled even if reference.enabled is true", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const active = getActiveSources(sources, false)
		expect(active.reference).toBe(false)
	})

	it("disables structured search when structured.enabled is false", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: false },
		}
		const active = getActiveSources(sources, true)
		expect(active.structured).toBe(false)
	})

	it("disables all sources when all are disabled", () => {
		const sources = {
			reference: { enabled: false },
			conversation: { enabled: false },
			structured: { enabled: false },
		}
		const active = getActiveSources(sources, true)
		expect(active.conversation).toBe(false)
		expect(active.reference).toBe(false)
		expect(active.structured).toBe(false)
	})
})

describe("getActiveSourcesForStatus", () => {
	it("returns only enabled source names", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: false },
		}
		const names = getActiveSourcesForStatus(sources, true)
		expect(names).toContain("conversation")
		expect(names).toContain("reference")
		expect(names).not.toContain("structured")
	})

	it("returns empty array when all sources disabled", () => {
		const sources = {
			reference: { enabled: false },
			conversation: { enabled: false },
			structured: { enabled: false },
		}
		const names = getActiveSourcesForStatus(sources, true)
		expect(names).toHaveLength(0)
	})

	it("excludes reference when kb is disabled", () => {
		const sources = {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: true },
		}
		const names = getActiveSourcesForStatus(sources, false)
		expect(names).not.toContain("reference")
		expect(names).toContain("conversation")
		expect(names).toContain("structured")
	})
})

// ---------------------------------------------------------------------------
// Phase 3 REM-FIX: relevanceExplain source policy filtering
// ---------------------------------------------------------------------------

describe("resolveExplainSources", () => {
	const allActive = { conversation: true, reference: true, structured: true }

	it("allows memory scope when conversation source is active", () => {
		const result = resolveExplainSources("memory", allActive)
		expect(result).toEqual({
			conversation: true,
			reference: false,
			structured: false,
		})
	})

	it("disables memory scope when conversation source is inactive", () => {
		const result = resolveExplainSources("memory", {
			...allActive,
			conversation: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("allows kb scope when reference source is active", () => {
		const result = resolveExplainSources("kb", allActive)
		expect(result).toEqual({
			conversation: false,
			reference: true,
			structured: false,
		})
	})

	it("disables kb scope when reference source is inactive", () => {
		const result = resolveExplainSources("kb", {
			...allActive,
			reference: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("allows structured scope when structured source is active", () => {
		const result = resolveExplainSources("structured", allActive)
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: true,
		})
	})

	it("disables structured scope when structured source is inactive", () => {
		const result = resolveExplainSources("structured", {
			...allActive,
			structured: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("returns all active sources for 'all' scope", () => {
		const result = resolveExplainSources("all", allActive)
		expect(result).toEqual({
			conversation: true,
			reference: true,
			structured: true,
		})
	})

	it("filters inactive sources from 'all' scope", () => {
		const result = resolveExplainSources("all", {
			conversation: true,
			reference: false,
			structured: true,
		})
		expect(result).toEqual({
			conversation: true,
			reference: false,
			structured: true,
		})
	})

	it("returns all disabled for 'all' scope when all sources disabled", () => {
		const result = resolveExplainSources("all", {
			conversation: false,
			reference: false,
			structured: false,
		})
		expect(result).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})
})

// ---------------------------------------------------------------------------
// Phase 8: Wire v2 into MongoDBMemoryManager
// ---------------------------------------------------------------------------

// Dynamic imports for mocked modules
const { writeEvent, projectEventChunk, getEventsByTimeRange } = await import(
	"./mongodb-events.js"
)
const { recordIngestRun, getProjectionLag } = await import("./mongodb-ops.js")
const { planRetrieval, resolveTimeRangePreset } = await import(
	"./mongodb-retrieval-planner.js"
)
const { searchEpisodes } = await import("./mongodb-episodes.js")
const { searchEntitiesAutocomplete, expandGraph } = await import(
	"./mongodb-graph.js"
)
const {
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	episodesCollection,
	proceduresCollection,
	chunksCollection,
	sessionChunksCollection,
	relevanceRunsCollection,
} = await import("./mongodb-schema.js")

// Fake Db — the real calls are mocked at the module level
const fakeDb = {} as unknown as import("mongodb").Db
const fakePrefix = "test_"

// ---------------------------------------------------------------------------
// 8.1: writeEventAndProject
// ---------------------------------------------------------------------------

// Covered by real-e2e-v2 E2E tests. This unit seam still depends
// on a stale module-mock architecture and should be rewritten around a fake Db.
describe("writeEventAndProject", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls writeEvent + projectEventChunk + recordIngestRun and returns result", async () => {
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-03-16T00:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		mocked(recordIngestRun).mockResolvedValue("run-1")

		const result = await writeEventAndProject(fakeDb, fakePrefix, {
			agentId: "agent-1",
			role: "user",
			body: "Hello world",
			scope: "agent",
		})

		expect(result.eventId).toBe("evt-1")
		expect(result.chunksCreated).toBe(1)

		expect(writeEvent).toHaveBeenCalledOnce()
		expect(projectEventChunk).toHaveBeenCalledOnce()
		expect(recordIngestRun).toHaveBeenCalledWith(
			expect.objectContaining({
				db: fakeDb,
				prefix: fakePrefix,
				run: expect.objectContaining({
					agentId: "agent-1",
					source: "event-write",
					status: "ok",
					itemsProcessed: 1,
					itemsFailed: 0,
				}),
			}),
		)
	})

	it("records failed ingest on error and re-throws", async () => {
		const error = new Error("write failed")
		mocked(writeEvent).mockRejectedValue(error)
		mocked(recordIngestRun).mockResolvedValue("run-fail")

		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("write failed")

		// Should record a failed ingest run
		expect(recordIngestRun).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					status: "failed",
					itemsProcessed: 0,
					itemsFailed: 1,
				}),
			}),
		)
	})

	it("swallows recordIngestRun failure in catch path to not mask real error", async () => {
		const realError = new Error("write failed")
		mocked(writeEvent).mockRejectedValue(realError)
		mocked(recordIngestRun).mockRejectedValue(
			new Error("ingest record also failed"),
		)

		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("write failed")
	})

	it("rejects invalid scope values", async () => {
		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "invalid-scope",
			}),
		).rejects.toThrow("Invalid scope: invalid-scope")
	})

	it("rejects invalid role values", async () => {
		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "invalid-role",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("Invalid role: invalid-role")
	})
})

// ---------------------------------------------------------------------------
// 8.2: searchV2
// ---------------------------------------------------------------------------

// The real searchV2 pipeline is covered by src/memory/real-e2e-v2.e2e.test.ts.
// This mock-heavy orchestration block is parked until it is redesigned around
// explicit dependency injection or a fake Db harness.
describe("searchV2", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
			results,
			reranked: false,
			latencyMs: 0,
		}))
	})

	it("uses retrieval planner and executes paths, returning results + metadata", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic", "hybrid", "raw-window"],
			confidence: "high",
			reasoning: "episodic keywords",
		})

		mocked(searchEpisodes).mockResolvedValue([
			{
				episodeId: "ep-1",
				title: "Morning standup",
				summary: "Discussed sprint goals",
				type: "daily",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timeRange: { start: new Date(), end: new Date() },
				sourceEventCount: 1,
				updatedAt: new Date(),
			},
		])

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"summarize today",
			"agent-1",
			{
				availablePaths: new Set([
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
				]),
				searchOptions: {
					allowHybridBackstop: false,
				},
			},
		)

		expect(planRetrieval).toHaveBeenCalledOnce()
		expect(result.metadata.plan.paths).toContain("episodic")
		expect(result.metadata.pathsExecuted).toContain("episodic")
		expect(result.results.length).toBeGreaterThan(0)
		expect(result.results[0].snippet).toContain("Morning standup")
	})

	it("continues when one path fails (inner try/catch per path)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic", "raw-window", "hybrid"],
			confidence: "medium",
			reasoning: "test",
		})

		// Episodic fails
		mocked(searchEpisodes).mockRejectedValue(new Error("episodic broke"))

		// Raw-window succeeds
		mocked(getEventsByTimeRange).mockResolvedValue([
			{
				eventId: "e-1",
				body: "recent event",
				role: "user",
				timestamp: new Date(),
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		])

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"what happened recently",
			"agent-1",
			{
				availablePaths: new Set([
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
				]),
				searchOptions: {
					allowHybridBackstop: false,
				},
			},
		)

		// Should still have results from raw-window despite episodic failure
		expect(result.results.length).toBeGreaterThan(0)
		expect(result.metadata.pathsExecuted).toContain("raw-window")
		expect(result.metadata.pathsExecuted).not.toContain("episodic")
	})

	it("ranks raw-window events by query relevance before pure recency", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "medium",
			reasoning: "conversation scope requested",
		})

		mocked(getEventsByTimeRange).mockResolvedValue([
			{
				eventId: "evt-recent",
				body: "I will keep concise updates and track the Phoenix deploy checklist.",
				role: "assistant",
				timestamp: new Date("2026-04-05T22:39:50.981Z"),
				agentId: "agent-1",
				scope: "session",
				scopeRef: "session:session-1",
				sessionId: "session-1",
			},
			{
				eventId: "evt-marker",
				body: "capability-marker-8c79e671 Alice is handling the Phoenix release blocker.",
				role: "user",
				timestamp: new Date("2026-04-05T22:36:50.981Z"),
				agentId: "agent-1",
				scope: "session",
				scopeRef: "session:session-1",
				sessionId: "session-1",
			},
		])

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"capability-marker-8c79e671",
			"agent-1",
			{
				availablePaths: new Set(["raw-window"]),
				searchOptions: {
					scope: "session",
					scopeRef: "session:session-1",
					conversationScope: { sessionKey: "session-1" },
				},
			},
		)

		expect(result.metadata.pathsExecuted).toContain("raw-window")
		expect(result.results[0]?.path).toBe("events/evt-marker")
		expect(result.results[0]?.sessionId).toBe("session-1")
	})

	it("executes graph path when entity names are provided", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["graph", "hybrid", "raw-window"],
			confidence: "high",
			reasoning: "known entity detected",
		})

		mocked(searchEntitiesAutocomplete).mockResolvedValue([
			{
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date(),
			},
		])
		mocked(expandGraph).mockResolvedValue({
			rootEntity: {
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date(),
			},
			connections: [
				{
					entity: {
						entityId: "ent-2",
						name: "ProjectX",
						type: "project",
						agentId: "agent-1",
						scope: "agent",
						updatedAt: new Date(),
					},
					relation: {
						fromEntityId: "ent-1",
						toEntityId: "ent-2",
						type: "works_on",
						agentId: "agent-1",
						scope: "agent",
						updatedAt: new Date(),
					},
					depth: 0,
				},
			],
		})

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"what does Alice work on",
			"agent-1",
			{
				availablePaths: new Set([
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
				]),
				knownEntityNames: ["Alice"],
				searchOptions: {
					allowHybridBackstop: false,
				},
			},
		)

		expect(searchEntitiesAutocomplete).toHaveBeenCalledOnce()
		expect(expandGraph).toHaveBeenCalledOnce()
		expect(result.metadata.pathsExecuted).toContain("graph")
		expect(result.results.length).toBeGreaterThan(0)
	})

	it("passes the planned time-range end into graph expansion asOf", async () => {
		const plannedEnd = new Date("2026-04-11T12:00:00.000Z")
		mocked(resolveTimeRangePreset).mockReturnValue({
			start: new Date("2026-04-04T12:00:00.000Z"),
			end: plannedEnd,
		})
		mocked(planRetrieval).mockReturnValue({
			paths: ["graph"],
			confidence: "high",
			reasoning: "known entity with temporal constraint",
			constraints: {
				timeRange: {
					preset: "last-7d",
					hard: true,
					reason: "explicit last-week constraint",
				},
				entities: { names: ["Alice"] },
			},
		})
		mocked(searchEntitiesAutocomplete).mockResolvedValue([
			{
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date(),
			},
		])
		mocked(expandGraph).mockResolvedValue({
			rootEntity: {
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date(),
			},
			connections: [],
		})

		await searchV2(
			fakeDb,
			fakePrefix,
			"what did Alice work on last week",
			"agent-1",
			{
				availablePaths: new Set(["graph"]),
				knownEntityNames: ["Alice"],
			},
		)

		expect(expandGraph).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "ent-1",
				agentId: "agent-1",
				asOf: plannedEnd,
			}),
		)
	})

	it("accepts questionDate in searchOptions type for post-retrieval scoring", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "high",
			reasoning: "temporal query",
		})

		const recentTimestamp = new Date("2024-03-14T00:00:00Z")
		const oldTimestamp = new Date("2023-01-01T00:00:00Z")

		mocked(getEventsByTimeRange).mockResolvedValue([
			{
				_id: "evt-old",
				eventId: "evt-old",
				body: "weather in Paris is nice today",
				role: "user",
				timestamp: oldTimestamp,
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				sessionId: "sess-1",
				channel: "default",
			},
			{
				_id: "evt-recent",
				eventId: "evt-recent",
				body: "Tokyo restaurant was amazing last week",
				role: "user",
				timestamp: recentTimestamp,
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				sessionId: "sess-1",
				channel: "default",
			},
		])

		const questionDate = new Date("2024-03-15T00:00:00Z")
		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"What about the Tokyo restaurant last week",
			"agent-1",
			{
				availablePaths: new Set(["raw-window"]),
				searchOptions: {
					allowHybridBackstop: false,
					questionDate,
				},
			},
		)

		// Post-retrieval scoring with questionDate should execute without error
		// and return results (the scoring is ranking-only)
		expect(result.results.length).toBeGreaterThan(0)
	})

	it("uses MongoDB Search temporal coverage lane for temporal questions", async () => {
		const previousMode = process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE
		process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE = "enabled"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["raw-window"],
				confidence: "high",
				reasoning: "temporal coverage query",
			})
			mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
				results: [...results].toReversed(),
				reranked: true,
				latencyMs: 1,
			}))

			mocked(getEventsByTimeRange).mockResolvedValue([
				{
					_id: "evt-direct",
					eventId: "evt-direct",
					body: "I attended a guided tour at the Natural History Museum yesterday with my dad.",
					role: "user",
					timestamp: new Date("2023-02-18T04:22:00Z"),
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					sessionId: "answer_f4ea84fb_1",
					channel: "default",
				},
			])

			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([
					{
						eventId: "evt-history",
						body: "I learned about Petra in a lecture at the History Museum about ancient civilizations this month.",
						sessionId: "answer_f4ea84fb_2",
						timestamp: new Date("2023-01-11T10:24:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
						score: 0.8,
					},
					{
						eventId: "evt-science",
						body: "I went to the Science Museum with a friend who is a chemistry professor.",
						sessionId: "answer_f4ea84fb_3",
						timestamp: new Date("2022-10-22T18:38:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
						score: 0.7,
					},
				]),
			})
			const find = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([
					{
						eventId: "evt-history",
						body: "I learned about Petra in a lecture at the History Museum about ancient civilizations this month.",
						sessionId: "answer_f4ea84fb_2",
						timestamp: new Date("2023-01-11T10:24:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
					{
						eventId: "evt-science",
						body: "I went to the Science Museum with a friend who is a chemistry professor.",
						sessionId: "answer_f4ea84fb_3",
						timestamp: new Date("2022-10-22T18:38:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
				]),
			})
			mocked(eventsCollection).mockReturnValue({
				aggregate,
				find,
			} as never)

			const questionDate = new Date("2023-03-25T17:18:00Z")
			const result = await searchV2(
				fakeDb,
				fakePrefix,
				"How many months have passed since I last visited a museum with a friend?",
				"agent-1",
				{
					availablePaths: new Set(["raw-window"]),
					maxResults: 10,
					searchOptions: {
						allowHybridBackstop: false,
						questionDate,
						rerankConfig: {
							enabled: true,
							model: "rerank-2.5-lite",
							topN: 10,
							minScore: 0,
							voyageApiKey: "test-key",
						},
					},
				},
			)

			expect(aggregate).toHaveBeenCalled()
			expect(find).toHaveBeenCalledOnce()
			const pipeline = aggregate.mock.calls
				.map((call) => call[0] as Record<string, any>[])
				.find(
					(candidate) =>
						candidate[0]?.$search?.index === `${fakePrefix}events_text` &&
						candidate[0]?.$search?.compound?.should?.some(
							(clause: Record<string, any>) => clause.near,
						),
				)
			expect(pipeline).toBeDefined()
			const searchStage = pipeline[0]?.$search
			expect(searchStage.index).toBe(`${fakePrefix}events_text`)
			expect(searchStage.compound.must[0].text.query).toContain("museum")
			expect(searchStage.compound.filter).toContainEqual({
				range: { path: "timestamp", lte: questionDate },
			})
			const nearClause = searchStage.compound.should.find(
				(clause: Record<string, any>) => clause.near,
			)
			expect(nearClause?.near).toMatchObject({
				path: "timestamp",
				origin: questionDate,
			})
			expect(crossEncoderRerank).toHaveBeenCalledOnce()
			const rerankInput = mocked(crossEncoderRerank).mock.calls[0]?.[0] as
				| { results: MemorySearchResult[] }
				| undefined
			expect(
				rerankInput?.results.some(
					(entry) => entry.provenance?.temporalTimeline === true,
				),
			).toBe(false)
			const timeline = result.results.find(
				(entry) => entry.provenance?.temporalTimeline === true,
			)
			expect(timeline?.provenance?.temporalTimeline).toBe(true)
			expect(timeline?.sourceEventIds).toEqual(
				expect.arrayContaining(["evt-history", "evt-science"]),
			)
			expect(result.results[0]?.provenance?.temporalTimeline).not.toBe(true)
			expect(result.results.map((entry) => entry.sessionId)).toContain(
				"answer_f4ea84fb_2",
			)
			expect(result.results.map((entry) => entry.sessionId)).toContain(
				"answer_f4ea84fb_3",
			)
		} finally {
			if (previousMode === undefined) {
				delete process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE
			} else {
				process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE = previousMode
			}
		}
	})

	it("boosts user-authored compatibility evidence for recommendation memory queries", async () => {
		const previousMode = process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE
		process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE = "enabled"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["raw-window"],
				confidence: "high",
				reasoning: "recommendation memory query",
			})
			mocked(getEventsByTimeRange).mockResolvedValue([
				{
					_id: "evt-seed",
					eventId: "evt-seed",
					body: "Photography setup context for Sony A7R IV accessories.",
					role: "user",
					timestamp: new Date("2023-05-30T10:00:00Z"),
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					sessionId: "photo-session",
					channel: "default",
				},
			])
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([
					{
						eventId: "evt-user-distractor",
						body: "What are good external battery packs for my Sony A7R IV?",
						role: "user",
						sessionId: "photo-session",
						timestamp: new Date("2023-05-30T10:01:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
						score: 0.9,
					},
					{
						eventId: "evt-user-compatible",
						body: "I'm looking to upgrade my camera flash. Can you recommend options compatible with my Sony A7R IV?",
						role: "user",
						sessionId: "photo-session",
						timestamp: new Date("2023-05-30T10:02:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
						score: 0.8,
					},
					{
						eventId: "evt-assistant-recommendation",
						body: "The Godox V1 comes with a soft case, but a padded pouch would complement your photography setup.",
						role: "assistant",
						sessionId: "photo-session",
						timestamp: new Date("2023-05-30T10:03:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
						score: 0.7,
					},
				]),
			})
			mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
				results: results
					.map((entry) => ({
						...entry,
						score:
							entry.path === "events/evt-assistant-recommendation"
								? 0.63
								: entry.path === "events/evt-user-compatible"
									? 0.57
									: 0.52,
					}))
					.toSorted((left, right) => right.score - left.score),
				reranked: true,
				latencyMs: 1,
			}))
			mocked(eventsCollection).mockReturnValue({ aggregate } as never)

			const result = await searchV2(
				fakeDb,
				fakePrefix,
				"Can you suggest accessories that complement my photography setup?",
				"agent-1",
				{
					availablePaths: new Set(["raw-window"]),
					searchOptions: {
						allowHybridBackstop: false,
						capabilities: {
							vectorSearch: false,
							textSearch: true,
							scoreFusion: false,
							rankFusion: false,
						},
						scope: "agent",
						scopeRef: "agent:agent-1",
						rerankConfig: {
							enabled: true,
							model: "rerank-2.5-lite",
							topN: 10,
							minScore: 0,
							voyageApiKey: "test-key",
						},
					},
				},
			)

			expect(crossEncoderRerank).toHaveBeenCalledOnce()
			expect(result.results[0]?.path).toBe("events/evt-user-compatible")
			expect(result.results[0]?.provenance?.eventRole).toBe("user")
		} finally {
			if (previousMode === undefined) {
				delete process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE
			} else {
				process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE = previousMode
			}
		}
	})
})

// ---------------------------------------------------------------------------
// 8.3: getV2Status
// ---------------------------------------------------------------------------

describe("v2 health classification helpers", () => {
	it("classifies ingest health from the latest ingest run", () => {
		expect(classifyCanonicalIngestHealth(null)).toBe("health-uncertain")
		expect(classifyCanonicalIngestHealth({ status: "ok" })).toBe("ok")
		expect(classifyCanonicalIngestHealth({ status: "failed" })).toBe(
			"canonical-ingest-failed",
		)
	})

	it("classifies projection health from latest run and lag", () => {
		expect(
			classifyProjectionHealth({ latestRun: null, lagSeconds: null }),
		).toBe("health-uncertain")
		expect(
			classifyProjectionHealth({
				latestRun: { status: "failed" },
				lagSeconds: null,
			}),
		).toBe("derived-product-unavailable")
		expect(
			classifyProjectionHealth({
				latestRun: { status: "ok" },
				lagSeconds: 601,
			}),
		).toBe("projection-behind")
		expect(
			classifyProjectionHealth({ latestRun: { status: "ok" }, lagSeconds: 12 }),
		).toBe("ok")
	})

	it("distinguishes degraded retrieval from no relevant results", () => {
		expect(classifyRetrievalHealth({ status: null, hitSources: null })).toEqual(
			{
				state: "health-uncertain",
				recentNoRelevantResults: false,
			},
		)
		expect(
			classifyRetrievalHealth({ status: "ok", hitSources: ["conversation"] }),
		).toEqual({
			state: "ok",
			recentNoRelevantResults: false,
		})
		expect(
			classifyRetrievalHealth({ status: "degraded", hitSources: [] }),
		).toEqual({
			state: "retrieval-degraded",
			recentNoRelevantResults: true,
		})
	})

	it("computes the overall status from retrieval, ingest, and derived-product states", () => {
		expect(
			computeOverallV2Health({
				retrieval: "ok",
				canonicalIngest: "ok",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("ok")
		expect(
			computeOverallV2Health({
				retrieval: "retrieval-degraded",
				canonicalIngest: "ok",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("degraded")
		expect(
			computeOverallV2Health({
				retrieval: "ok",
				canonicalIngest: "health-uncertain",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("health-uncertain")
	})
})

// Covered by real v2 status checks in the live MongoDB gate. This unit block
// still assumes a stale module-mock seam.
describe("getV2Status", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns counts, projection lag, and retrieval paths", async () => {
		const latestDate = new Date("2026-03-15T12:00:00Z")

		const mockCountDocuments = vi.fn().mockResolvedValue(42)
		const eventCol = {
			countDocuments: mockCountDocuments,
			findOne: vi.fn().mockResolvedValue({ timestamp: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const derivedCol = {
			countDocuments: mockCountDocuments,
			findOne: vi.fn().mockResolvedValue({ updatedAt: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const relevanceCol = {
			findOne: vi.fn().mockResolvedValue({ status: "ok", hitSources: ["kb"] }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		mocked(eventsCollection).mockReturnValue(eventCol)
		mocked(entitiesCollection).mockReturnValue(derivedCol)
		mocked(relationsCollection).mockReturnValue(derivedCol)
		mocked(episodesCollection).mockReturnValue(derivedCol)
		mocked(proceduresCollection).mockReturnValue(derivedCol)
		mocked(relevanceRunsCollection).mockReturnValue(relevanceCol)

		mocked(getProjectionLag)
			.mockResolvedValueOnce(10) // chunks lag
			.mockResolvedValueOnce(20) // entities lag
			.mockResolvedValueOnce(30) // relations lag
			.mockResolvedValueOnce(null) // episodes lag (no data)
			.mockResolvedValueOnce(40) // structured lag
			.mockResolvedValueOnce(50) // procedures lag

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		expect(status.events.count).toBe(42)
		expect(status.events.latestTimestamp).toEqual(latestDate)
		expect(status.entities.count).toBe(42)
		expect(status.relations.count).toBe(42)
		expect(status.episodes.count).toBe(42)
		expect(status.procedures.count).toBe(42)
		expect(status.projectionLag.chunks).toBe(10)
		expect(status.projectionLag.entities).toBe(20)
		expect(status.projectionLag.relations).toBe(30)
		expect(status.projectionLag.episodes).toBeNull()
		expect(status.retrievalPaths).toEqual(
			expect.arrayContaining([
				"structured",
				"raw-window",
				"graph",
				"hybrid",
				"kb",
				"episodic",
			]),
		)
	})

	it("returns partial results when some queries fail (Promise.allSettled)", async () => {
		// Events collection works, but entities/relations/episodes reject
		const workingCol = {
			countDocuments: vi.fn().mockResolvedValue(10),
			findOne: vi
				.fn()
				.mockResolvedValue({ timestamp: new Date("2026-03-15T12:00:00Z") }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const failingCol = {
			countDocuments: vi.fn().mockRejectedValue(new Error("connection lost")),
			findOne: vi.fn().mockRejectedValue(new Error("connection lost")),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		mocked(eventsCollection).mockReturnValue(workingCol)
		mocked(entitiesCollection).mockReturnValue(failingCol)
		mocked(relationsCollection).mockReturnValue(failingCol)
		mocked(episodesCollection).mockReturnValue(failingCol)
		mocked(proceduresCollection).mockReturnValue(failingCol)
		mocked(relevanceRunsCollection).mockReturnValue(failingCol)

		mocked(getProjectionLag)
			.mockResolvedValueOnce(5) // chunks lag works
			.mockRejectedValueOnce(new Error("timeout")) // entities lag fails
			.mockResolvedValueOnce(15) // relations lag works
			.mockRejectedValueOnce(new Error("timeout")) // episodes lag fails
			.mockRejectedValueOnce(new Error("timeout")) // structured lag fails
			.mockRejectedValueOnce(new Error("timeout")) // procedures lag fails

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		// Working values preserved
		expect(status.events.count).toBe(10)
		expect(status.events.latestTimestamp).toEqual(
			new Date("2026-03-15T12:00:00Z"),
		)
		expect(status.projectionLag.chunks).toBe(5)
		expect(status.projectionLag.relations).toBe(15)

		// Failed values default to safe fallbacks
		expect(status.entities.count).toBe(0)
		expect(status.relations.count).toBe(0)
		expect(status.episodes.count).toBe(0)
		expect(status.procedures.count).toBe(0)
		expect(status.projectionLag.entities).toBeNull()
		expect(status.projectionLag.episodes).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Tests: rerankResults
// ---------------------------------------------------------------------------

describe("rerankResults", () => {
	const makeResult = (
		path: string,
		snippet: string,
		score: number,
		source: MemorySearchResult["source"],
	): MemorySearchResult => ({
		path,
		filePath: path,
		startLine: 0,
		endLine: 0,
		snippet,
		score,
		source,
	})

	it("returns empty array for empty input", () => {
		const result = rerankResults([], "query")
		expect(result).toHaveLength(0)
	})

	it("applies source diversity penalty (no >2 from same source at top)", () => {
		const results = [
			makeResult("event:1", "text1", 0.95, "conversation"),
			makeResult("event:2", "text2", 0.9, "conversation"),
			makeResult("event:3", "text3", 0.85, "conversation"),
			makeResult("struct:1", "text4", 0.8, "structured"),
		]
		const reranked = rerankResults(results, "query")
		// The 3rd conversation result should be penalized below structured
		const top3Sources = reranked.slice(0, 3).map((r) => r.source)
		expect(top3Sources).toContain("structured")
	})

	it("boosts episode results", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("episode:ep1", "Episode: summary", 0.8, "conversation"),
		]
		const reranked = rerankResults(results, "query")
		// Episode should be boosted above the event (0.80 + 0.12 = 0.92 > 0.90)
		expect(reranked[0].path).toBe("episode:ep1")
	})

	it("respects custom weights", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("episode:ep1", "text2", 0.8, "conversation"),
		]
		// With zero episode boost, original order preserved
		const reranked = rerankResults(results, "query", { episodeBoost: 0 })
		expect(reranked[0].path).toBe("event:1")
	})

	it("does not mutate original array", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("event:2", "text2", 0.85, "conversation"),
		]
		const originalOrder = results.map((r) => r.path)
		rerankResults(results, "query")
		expect(results.map((r) => r.path)).toEqual(originalOrder)
	})
})

// ---------------------------------------------------------------------------
// Telemetry emission from writeEventAndProject
// ---------------------------------------------------------------------------

describe("writeEventAndProject telemetry emission", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("emits event-write telemetry after successful write", async () => {
		const { writeEvent } = await import("./mongodb-events.js")
		const { projectEventChunk } = await import("./mongodb-events.js")
		const { recordIngestRun } = await import("./mongodb-ops.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")

		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-03-16T00:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		mocked(recordIngestRun).mockResolvedValue("run-1")
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})

		const fakeDb = { collection: vi.fn() } as unknown as import("mongodb").Db
		await writeEventAndProject(fakeDb, "test_", {
			agentId: "agent-1",
			role: "user",
			body: "Hello world",
			scope: "agent",
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			fakeDb,
			"test_",
			expect.objectContaining({
				meta: { agentId: "agent-1", operation: "event-write" },
				ok: true,
				eventType: "user",
				projectionTriggered: true,
				durationMs: expect.any(Number),
			}),
		)
	})
})

describe("MongoDBMemoryManager consolidate job tracking", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does not abort consolidation when createMemoryJob fails", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { consolidateMemory } = await import("./mongodb-consolidator.js")

		mocked(createMemoryJob).mockRejectedValue(new Error("job create failed"))
		mocked(consolidateMemory).mockResolvedValue({
			runId: "run-1",
			eventsProcessed: 3,
			factsPromoted: 2,
			factsPruned: 0,
			conflictsResolved: 0,
			durationMs: 25,
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager

		const result = await manager.consolidate({ maxEvents: 10 })

		expect(result.eventsProcessed).toBe(3)
		expect(createMemoryJob).toHaveBeenCalledTimes(1)
		expect(updateMemoryJob).not.toHaveBeenCalled()
	})

	it("preserves the original consolidation error when failed job update also fails", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { consolidateMemory } = await import("./mongodb-consolidator.js")

		mocked(createMemoryJob).mockResolvedValue("job-1")
		mocked(consolidateMemory).mockRejectedValue(new Error("boom"))
		mocked(updateMemoryJob).mockRejectedValue(new Error("job update failed"))

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager

		await expect(manager.consolidate({ scope: "workspace" })).rejects.toThrow(
			"boom",
		)
		expect(updateMemoryJob).toHaveBeenCalledTimes(1)
	})
})

describe("MongoDBMemoryManager background extraction", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("schedules and runs a single-event extraction job", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		mocked(createMemoryJob).mockResolvedValue("extraction-evt-1")
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-1",
				agentId: "agent-1",
				role: "assistant",
				body: "Remember this: ship Batch F after tests pass.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			})),
		} as unknown as import("mongodb").Collection)
		mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 1,
			proceduresCreated: 0,
			skipped: false,
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				workspaceDir: "/tmp/memongo",
				derivationQueue: Promise.resolve(),
			},
		) as MongoDBMemoryManager & { derivationQueue: Promise<void> }

		const result = await manager.extractEvent({ eventId: "evt-1" })
		await manager.derivationQueue

		expect(result).toEqual({
			jobId: "extraction-evt-1",
			scheduled: true,
		})
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobId: "extraction-evt-1",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					metadata: { eventId: "evt-1" },
				}),
			}),
		)
		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({
					eventId: "evt-1",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					workspaceDir: "/tmp/memongo",
				}),
			}),
		)
		expect(updateMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-1",
				status: "running",
			}),
		)
		expect(updateMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-1",
				status: "completed",
				inputCount: 1,
				outputCount: 1,
			}),
		)
	})

	it("treats duplicate extraction jobs as already scheduled", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		mocked(createMemoryJob).mockRejectedValue({ code: 11000 })

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				derivationQueue: Promise.resolve(),
			},
		) as MongoDBMemoryManager & { derivationQueue: Promise<void> }

		const result = await manager.extractEvent({ eventId: "evt-1" })
		await manager.derivationQueue

		expect(result).toEqual({
			jobId: "extraction-evt-1",
			scheduled: false,
		})
		expect(promoteDerivedMemoryFromEvent).not.toHaveBeenCalled()
		expect(updateMemoryJob).not.toHaveBeenCalled()
	})

	it("rejects blank event ids at the manager boundary", async () => {
		const { createMemoryJob } = await import("./mongodb-memory-jobs.js")

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				derivationQueue: Promise.resolve(),
			},
		) as MongoDBMemoryManager & { derivationQueue: Promise<void> }

		await expect(manager.extractEvent({ eventId: "   " })).rejects.toThrow(
			"eventId is required",
		)
		expect(createMemoryJob).not.toHaveBeenCalled()
	})

	it("schedules extraction automatically after event writes", async () => {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue("extraction-evt-1")
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-1",
				agentId: "agent-1",
				role: "assistant",
				body: "Remember this: deployment is blocked by legal review.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			})),
		} as unknown as import("mongodb").Collection)
		mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: true,
			skipReason: "already-promoted",
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: {
					mongodb: {
						embeddingMode: "automated",
						episodes: { enabled: false, minEventsForEpisode: 6 },
					},
				},
				workspaceDir: "/tmp/memongo",
				writeQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
				chunkCount: 0,
				dirty: true,
			},
		) as MongoDBMemoryManager & {
			writeQueue: Promise<void>
			derivationQueue: Promise<void>
		}

		const result = await manager.writeConversationEvent({
			role: "assistant",
			body: "Remember this: deployment is blocked by legal review.",
			scope: "agent",
		})
		await manager.derivationQueue

		expect(result).toEqual({
			eventId: "evt-1",
			chunkCreated: false,
		})
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobId: "extraction-evt-1",
					jobType: "extraction",
				}),
			}),
		)
		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
	})

	it("skips benchmark-only derived work when benchmark mode disables it", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
		process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = "disabled"
		try {
			const { writeEvent, projectEventChunk } = await import(
				"./mongodb-events.js"
			)
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
			const {
				extractProcedureCandidatesFromEvent,
				resolveStructuredCandidatesForPromotion,
			} = await import("./mongodb-derived-memory.js")
			const { updateLaneCoverage } = await import("./mongodb-lane-coverage.js")

			mocked(writeEvent).mockResolvedValue({
				eventId: "evt-benchmark-1",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scopeRef: "agent:benchmark-agent-1",
			})
			mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "benchmark-agent-1",
					client: undefined,
					config: {
						mongodb: {
							embeddingMode: "automated",
							episodes: { enabled: true, minEventsForEpisode: 6 },
						},
					},
					workspaceDir: "/tmp/memongo",
					writeQueue: Promise.resolve(),
					derivationQueue: Promise.resolve(),
					derivationSchedulingQueue: Promise.resolve(),
					chunkCount: 0,
					dirty: true,
				},
			) as MongoDBMemoryManager

			await manager.writeConversationEvent({
				role: "assistant",
				body: "Remember this benchmark fact.",
				scope: "agent",
			})

			expect(extractAndUpsertEntities).not.toHaveBeenCalled()
			expect(createMemoryJob).not.toHaveBeenCalled()
			expect(resolveStructuredCandidatesForPromotion).not.toHaveBeenCalled()
			expect(extractProcedureCandidatesFromEvent).not.toHaveBeenCalled()
			expect(updateLaneCoverage).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: "benchmark-agent-1",
					increments: {
						"raw-window": 1,
						hybrid: 1,
					},
				}),
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
			else process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = prev
		}
	})

	it("defaults benchmark agents to skip post-write derived work", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
		delete process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
		try {
			const { writeEvent, projectEventChunk } = await import(
				"./mongodb-events.js"
			)
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
			const {
				extractProcedureCandidatesFromEvent,
				resolveStructuredCandidatesForPromotion,
			} = await import("./mongodb-derived-memory.js")
			const { updateLaneCoverage } = await import("./mongodb-lane-coverage.js")

			mocked(writeEvent).mockResolvedValue({
				eventId: "evt-canary-default-1",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scopeRef: "agent:canary-agent-1",
			})
			mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "canary-agent-1",
					client: undefined,
					config: {
						mongodb: {
							embeddingMode: "automated",
							episodes: { enabled: true, minEventsForEpisode: 6 },
						},
					},
					workspaceDir: "/tmp/memongo",
					writeQueue: Promise.resolve(),
					derivationQueue: Promise.resolve(),
					derivationSchedulingQueue: Promise.resolve(),
					chunkCount: 0,
					dirty: true,
				},
			) as MongoDBMemoryManager

			await manager.writeConversationEvent({
				role: "assistant",
				body: "Remember this canary fact.",
				scope: "agent",
			})

			expect(extractAndUpsertEntities).not.toHaveBeenCalled()
			expect(createMemoryJob).not.toHaveBeenCalled()
			expect(resolveStructuredCandidatesForPromotion).not.toHaveBeenCalled()
			expect(extractProcedureCandidatesFromEvent).not.toHaveBeenCalled()
			expect(updateLaneCoverage).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: "canary-agent-1",
					increments: {
						"raw-window": 1,
						hybrid: 1,
					},
				}),
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
			else process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = prev
		}
	})

	it("allows diagnostic benchmarks to opt into post-write derived work", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
		process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = "enabled"
		try {
			const { writeEvent, projectEventChunk } = await import(
				"./mongodb-events.js"
			)
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
			const { eventsCollection } = await import("./mongodb-schema.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			const { updateLaneCoverage } = await import("./mongodb-lane-coverage.js")

			mocked(writeEvent).mockResolvedValue({
				eventId: "evt-benchmark-enabled-1",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scopeRef: "agent:benchmark-agent-enabled",
			})
			mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
			mocked(extractAndUpsertEntities).mockResolvedValue({
				entities: [],
				relationsCreated: 0,
			})
			mocked(createMemoryJob).mockResolvedValue(
				"extraction-evt-benchmark-enabled-1",
			)
			mocked(eventsCollection).mockReturnValue({
				findOne: vi.fn(async () => ({
					eventId: "evt-benchmark-enabled-1",
					agentId: "benchmark-agent-enabled",
					role: "assistant",
					body: "Remember this diagnostic benchmark fact.",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					scope: "agent",
					scopeRef: "agent:benchmark-agent-enabled",
				})),
			} as unknown as import("mongodb").Collection)
			mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
				structuredCreated: 0,
				proceduresCreated: 0,
				skipped: false,
			})

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "benchmark-agent-enabled",
					client: undefined,
					config: {
						mongodb: {
							embeddingMode: "automated",
							episodes: { enabled: false, minEventsForEpisode: 6 },
						},
					},
					workspaceDir: "/tmp/memongo",
					writeQueue: Promise.resolve(),
					derivationQueue: Promise.resolve(),
					derivationSchedulingQueue: Promise.resolve(),
					chunkCount: 0,
					dirty: true,
				},
			) as MongoDBMemoryManager & {
				derivationQueue: Promise<void>
				derivationSchedulingQueue: Promise<void>
			}

			await manager.writeConversationEvent({
				role: "assistant",
				body: "Remember this diagnostic benchmark fact.",
				scope: "agent",
			})
			await manager.derivationSchedulingQueue
			await manager.derivationQueue

			expect(extractAndUpsertEntities).toHaveBeenCalled()
			expect(createMemoryJob).toHaveBeenCalledWith(
				expect.objectContaining({
					job: expect.objectContaining({
						jobId: "extraction-evt-benchmark-enabled-1",
						jobType: "extraction",
					}),
				}),
			)
			expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
			else process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = prev
		}
	})

	it("lets explicit benchmark mode disable derived work for non-standard benchmark agent ids", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
		process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = "disabled"
		try {
			const { writeEvent, projectEventChunk } = await import(
				"./mongodb-events.js"
			)
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
			const { eventsCollection } = await import("./mongodb-schema.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			const { updateLaneCoverage } = await import("./mongodb-lane-coverage.js")

			mocked(writeEvent).mockResolvedValue({
				eventId: "evt-longmemeval-1",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scopeRef: "agent:longmemeval_311778f1_run",
			})
			mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "longmemeval_311778f1_run",
					client: undefined,
					config: {
						mongodb: {
							embeddingMode: "automated",
							episodes: { enabled: false, minEventsForEpisode: 6 },
						},
					},
					workspaceDir: "/tmp/memongo",
					writeQueue: Promise.resolve(),
					derivationQueue: Promise.resolve(),
					derivationSchedulingQueue: Promise.resolve(),
					chunkCount: 0,
					dirty: true,
				},
			) as MongoDBMemoryManager & {
				derivationQueue: Promise<void>
				derivationSchedulingQueue: Promise<void>
			}

			await manager.writeConversationEvent({
				role: "assistant",
				body: "Remember this benchmark fact.",
				scope: "agent",
			})
			await manager.derivationSchedulingQueue
			await manager.derivationQueue

			expect(extractAndUpsertEntities).not.toHaveBeenCalled()
			expect(createMemoryJob).not.toHaveBeenCalled()
			expect(eventsCollection).not.toHaveBeenCalled()
			expect(promoteDerivedMemoryFromEvent).not.toHaveBeenCalled()
			expect(updateLaneCoverage).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: "longmemeval_311778f1_run",
					increments: {
						"raw-window": 1,
						hybrid: 0,
					},
				}),
			)
		} finally {
			if (prev === undefined)
				delete process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE
			else process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = prev
		}
	})
})

// ---------------------------------------------------------------------------
// Scope-safe cache writes: search() and searchDetailed() must use the
// resolved search scope, not hard-coded "agent"
// ---------------------------------------------------------------------------

describe("scope-safe cache writes", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function buildMockManager(overrides?: Record<string, unknown>) {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			agentScopeRef: "agent:agent-1",
			workspaceScopeRef: "workspace:agent-1",
			client: undefined,
			capabilities: {
				vectorSearch: false,
				textSearch: false,
				rankFusion: false,
				scoreFusion: false,
			},
			config: {
				mongodb: {
					embeddingMode: "automated",
					fusionMethod: "rankFusion",
					numCandidates: 200,
					cache: {
						enabled: true,
						conversationTtlSec: 300,
						kbTtlSec: 600,
					},
					// sources omitted — getActiveSources defaults to all enabled
					kb: { enabled: false },
					episodes: { enabled: true, minEventsForEpisode: 6 },
					graph: { enabled: false },
					reranking: { enabled: false },
					queryRewriting: { enabled: false },
				},
			},
			extraMemoryPaths: [],
			writeQueue: Promise.resolve(),
			derivationQueue: Promise.resolve(),
			chunkCount: 0,
			dirty: true,
			lastSearchMode: "legacy",
			accessTracker: null,
			relevance: null,
			...overrides,
		}) as MongoDBMemoryManager
	}

	it("scales default searchDetailed numCandidates with requested top-k", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "test numCandidates scaling",
			constraints: {},
		})
		mocked(chunksCollection).mockReturnValue({
			aggregate: vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			}),
		} as never)

		const manager = buildMockManager({
			config: {
				mongodb: {
					embeddingMode: "automated",
					fusionMethod: "rankFusion",
					numCandidates: 500,
					cache: {
						enabled: false,
						conversationTtlSec: 300,
						kbTtlSec: 600,
					},
					kb: { enabled: false },
					episodes: { enabled: false },
					graph: { enabled: false },
					reranking: { enabled: false },
					queryRewriting: { enabled: false },
				},
			},
		})

		const top50 = await manager.searchDetailed({
			query: "what changed?",
			maxResults: 50,
		})
		const top200 = await manager.searchDetailed({
			query: "what changed?",
			maxResults: 200,
		})

		expect(top50.metadata.resolvedSearchConfig?.numCandidates).toBe(1000)
		expect(top200.metadata.resolvedSearchConfig?.numCandidates).toBe(4000)
	})

	it("uses backend proof recall profile when request does not override it", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "test proof profile from backend config",
			constraints: {},
		})
		mocked(chunksCollection).mockReturnValue({
			aggregate: vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			}),
		} as never)

		const manager = buildMockManager({
			config: {
				mongodb: {
					embeddingMode: "automated",
					fusionMethod: "rankFusion",
					recallProfile: "proof",
					numCandidates: 200,
					cache: {
						enabled: false,
						conversationTtlSec: 300,
						kbTtlSec: 600,
					},
					kb: { enabled: false },
					episodes: { enabled: false },
					graph: { enabled: false },
					reranking: { enabled: false },
					queryRewriting: { enabled: false },
				},
			},
		})

		const response = await manager.searchDetailed({
			query: "what changed?",
			maxResults: 50,
			searchConfig: {
				numCandidates: 200,
			},
		})

		expect(response.metadata.resolvedSearchConfig?.recallProfile).toBe("proof")
		expect(response.metadata.resolvedSearchConfig?.numCandidates).toBe(1000)
	})

	it("keeps explicit searchDetailed numCandidates overrides", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "test explicit numCandidates",
			constraints: {},
		})
		mocked(chunksCollection).mockReturnValue({
			aggregate: vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			}),
		} as never)

		const manager = buildMockManager({
			config: {
				mongodb: {
					embeddingMode: "automated",
					fusionMethod: "rankFusion",
					numCandidates: 500,
					cache: {
						enabled: false,
						conversationTtlSec: 300,
						kbTtlSec: 600,
					},
					kb: { enabled: false },
					episodes: { enabled: false },
					graph: { enabled: false },
					reranking: { enabled: false },
					queryRewriting: { enabled: false },
				},
			},
		})

		const response = await manager.searchDetailed({
			query: "what changed?",
			maxResults: 50,
			searchConfig: {
				numCandidates: 750,
			},
		})

		expect(response.metadata.resolvedSearchConfig?.numCandidates).toBe(750)
	})

	it("search() writes cache with session scope when sessionKey is provided", async () => {
		// Cache miss so the search pipeline runs
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: undefined,
			results: [],
		} as never)

		// Planner returns episodic path — which is fully mocked
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "test scope cache",
		})

		mocked(searchEpisodes).mockResolvedValue([
			{
				episodeId: "ep-scope-1",
				title: "Scope session episode",
				summary: "Evidence for session",
				type: "daily",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timeRange: { start: new Date(), end: new Date() },
				sourceEventCount: 1,
				updatedAt: new Date(),
			},
		])

		const manager = buildMockManager()
		await manager.search("what did we discuss?", {
			sessionKey: "sess-1",
		})

		expect(writeCache).toHaveBeenCalledTimes(1)
		const writeCacheArgs = mocked(writeCache).mock.calls[0]![0]
		// BUG: currently writes scope: "agent" — should be "session"
		expect(writeCacheArgs.scope).toBe("session")
		expect(writeCacheArgs.scopeRef).toBe("session:sess-1")
	})

	it("search() reads cache with session scope when sessionKey is provided", async () => {
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: undefined,
			results: [],
		} as never)

		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "test scope in cache read",
		})

		mocked(searchEpisodes).mockResolvedValue([])

		const manager = buildMockManager()
		await manager.search("what did we discuss?", {
			sessionKey: "sess-3",
		})

		// BUG: currently reads cache with scope: "agent" — should be "session"
		expect(checkCache).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "session",
				scopeRef: "session:sess-3",
			}),
		)
	})

	it("keeps default agent searches out of workspace bridge chunks", async () => {
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: undefined,
			results: [],
		} as never)
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "test bridge isolation",
		})
		const chunksAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([
				{
					path: "event:evt-1",
					text: "agent scoped answer",
					source: "conversation",
					scope: "agent",
					scopeRef: "agent:agent-1",
					score: 0.9,
				},
			]),
		})
		mocked(chunksCollection).mockReturnValue({
			aggregate: chunksAggregate,
		} as never)

		const manager = buildMockManager({
			capabilities: {
				vectorSearch: false,
				textSearch: true,
				rankFusion: false,
				scoreFusion: false,
			},
		})
		await manager.search("agent scoped answer")

		expect(chunksAggregate).toHaveBeenCalledOnce()
		const pipeline = chunksAggregate.mock.calls[0]![0] as Record<string, any>[]
		expect(pipeline[0]?.$search?.compound?.filter).toEqual(
			expect.arrayContaining([
				{ equals: { path: "scope", value: "agent" } },
				{ equals: { path: "scopeRef", value: "agent:agent-1" } },
			]),
		)
	})

	it("filters session_chunks by scope and scopeRef even for agent scope", async () => {
		const previousMode = process.env.MEMONGO_SESSION_EVIDENCE_MODE
		process.env.MEMONGO_SESSION_EVIDENCE_MODE = "B"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["hybrid"],
				confidence: "high",
				reasoning: "test session chunk isolation",
			})
			mocked(chunksCollection).mockReturnValue({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			} as never)
			const sessionAggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			})
			mocked(sessionChunksCollection).mockReturnValue({
				aggregate: sessionAggregate,
			} as never)

			await searchV2(fakeDb, fakePrefix, "agent scoped answer", "agent-1", {
				availablePaths: new Set(["hybrid"]),
				searchOptions: {
					scope: "agent",
					scopeRef: "agent:agent-1",
					capabilities: {
						vectorSearch: false,
						textSearch: true,
						rankFusion: false,
						scoreFusion: false,
					},
					fusionMethod: "rankFusion",
					embeddingMode: "automated",
					allowHybridBackstop: false,
				},
			})

			expect(sessionAggregate).toHaveBeenCalled()
			const pipeline = sessionAggregate.mock.calls
				.map((call) => call[0] as Record<string, any>[])
				.find((candidate) => candidate[0]?.$search)
			expect(pipeline).toBeDefined()
			expect(pipeline![0]?.$search?.compound?.filter).toEqual(
				expect.arrayContaining([
					{ equals: { path: "agentId", value: "agent-1" } },
					{ equals: { path: "scope", value: "agent" } },
					{ equals: { path: "scopeRef", value: "agent:agent-1" } },
				]),
			)
		} finally {
			if (previousMode === undefined) {
				delete process.env.MEMONGO_SESSION_EVIDENCE_MODE
			} else {
				process.env.MEMONGO_SESSION_EVIDENCE_MODE = previousMode
			}
		}
	})
})
