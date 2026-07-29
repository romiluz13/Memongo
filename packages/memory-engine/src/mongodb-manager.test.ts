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
import { resolveRegisteredBenchmarkQualityContract } from "./benchmark-quality-contracts.js"
import { createBenchmarkRunContext } from "./benchmark-parity-envelope.js"
import type { MemoryBenchmarkDataset, MemorySearchResult } from "./types.js"

const mocked = <T>(value: T): T => {
	const maybeMocked = (
		vi as typeof vi & {
			mocked?: <U>(item: U) => U
		}
	).mocked
	return maybeMocked?.(value) ?? value
}

function testBenchmarkRunContext(runId: string) {
	return createBenchmarkRunContext({
		runId,
		configuration: {
			executionProfile: "diagnostic",
			retrievalLane: "native",
			maxResults: 50,
			minScore: 0.01,
			settings: {},
		},
	})
}

function testBenchmarkRunConfiguration(params: {
	executionProfile: "shipped" | "diagnostic"
	retrievalLane: "native" | "raw-session"
	maxResults: number
	minScore: number
}) {
	return { ...params, settings: {} }
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
	clearEventExtractionJobPending: vi.fn().mockResolvedValue(true),
	getPendingExtractionEvents: vi.fn().mockResolvedValue([]),
	projectChunksFromEvents: vi.fn(),
	projectEventChunk: vi.fn(),
	getEventsByTimeRange: vi.fn(),
}))

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./benchmark-quality-contracts.js")>()
	return {
		...actual,
		resolveRegisteredBenchmarkQualityContract: vi.fn(
			({ declared }: { declared: unknown }) => declared,
		),
	}
})

vi.mock("./mongodb-conversation-recall.js", () => ({
	recallConversation: vi.fn(),
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
	listSearchIndexes: vi.fn(),
	isSearchIndexReadyWithFilterFields: vi.fn(),
	isSearchIndexManagementAvailable: vi.fn(),
	isEventsVectorBitemporalPrefilterReady: vi.fn(),
	resolveSearchIndexReadinessTiming: vi.fn(() => ({
		timeoutMs: 60_000,
		pollMs: 1_000,
	})),
	getExpectedSearchIndexTargets: vi.fn(() => []),
	sessionChunksCollection: vi.fn(),
}))

vi.mock("./mongodb-query-cache.js", () => ({
	checkCache: vi.fn(),
	invalidateQueryCache: vi.fn(),
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
	claimMemoryJob: vi.fn(),
	completeClaimedMemoryJob: vi.fn(),
	createMemoryJob: vi.fn(),
	failClaimedMemoryJob: vi.fn(),
	getMemoryJob: vi.fn(),
	listMemoryJobs: vi.fn(),
	releaseStagedMemoryJob: vi.fn().mockResolvedValue(true),
	renewMemoryJobLease: vi.fn(),
	retryFailedMemoryJob: vi.fn(),
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
			agentId: "agent-benchmark",
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

	it("performs exactly one measured raw-session retrieval attempt", async () => {
		const previousAttempts =
			process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS
		const previousDelay = process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS
		process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS = "10"
		process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS = "0"
		try {
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			})
			mocked(sessionChunksCollection).mockReturnValue({ aggregate } as never)
			const manager = makeSearchConvergenceManager()

			await expect(
				(
					MongoDBMemoryManager.prototype as unknown as {
						searchBenchmarkRawSession: (
							this: MongoDBMemoryManager,
							query: string,
							opts: { maxResults: number; minScore: number },
						) => Promise<MemorySearchResult[]>
					}
				).searchBenchmarkRawSession.call(manager, "missing result", {
					maxResults: 5,
					minScore: 0,
				}),
			).resolves.toEqual([])

			expect(aggregate).toHaveBeenCalledTimes(1)
		} finally {
			if (previousAttempts === undefined) {
				delete process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS
			} else {
				process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_ATTEMPTS = previousAttempts
			}
			if (previousDelay === undefined) {
				delete process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS
			} else {
				process.env.MEMONGO_RAW_SESSION_VECTOR_RETRY_MS = previousDelay
			}
		}
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

	it("names memoryJobWorkerPromise when durable extraction hangs", async () => {
		const prev = process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS
		const prevStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS = "200"
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		try {
			const manager = {
				agentId: "benchmark-agent-durable-worker",
				writeQueue: Promise.resolve(),
				derivationSchedulingQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
				memoryJobWorkerPromise: new Promise<void>(() => {}),
			} as unknown as MongoDBMemoryManager
			await expect(callSettle(manager)).rejects.toThrow(
				/memoryJobWorkerPromise settle timed out after 200ms/,
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

	it("stops an isolated durable worker before measuring and cleaning its scenario", async () => {
		const { ingestBenchmarkConversations } = await import(
			"./mongodb-benchmark-harness.js"
		)
		const order: string[] = []
		mocked(ingestBenchmarkConversations).mockResolvedValue({
			datasetPath: "/tmp/benchmark.jsonl",
			datasetName: "worker-cleanup",
			conversationsIngested: 1,
			turnsIngested: 1,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: new Date("2026-04-09T12:00:00.000Z"),
			completedAt: new Date("2026-04-09T12:00:01.000Z"),
		})
		const scenarioManager = {
			agentId: "benchmark-isolated-worker",
			stopMemoryJobWorker: vi.fn(async () => {
				order.push("stop")
			}),
		} as unknown as MongoDBMemoryManager
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {
					collection: vi.fn(() => ({
						aggregate: vi.fn(() => ({
							toArray: vi.fn(async () => {
								order.push("measure")
								return []
							}),
						})),
					})),
				},
				prefix: "test_",
				agentId: "benchmark-parent",
				config: { mongodb: {} },
				relevance: { persistRegression: vi.fn(async () => []) },
				createBenchmarkScenarioManager: vi.fn(() => scenarioManager),
				settleBenchmarkScenarioManager: vi.fn(async () => {}),
				listBenchmarkEventEvidence: vi.fn(async () => ({
					sessionIds: new Map(),
					turnIds: new Map(),
					dialogIds: new Map(),
				})),
				waitForBenchmarkSearchConvergence: vi.fn(async () => {}),
				cleanupBenchmarkScenarioData: vi.fn(async () => {
					order.push("cleanup")
				}),
			},
		) as MongoDBMemoryManager
		const dataset: MemoryBenchmarkDataset = {
			name: "worker-cleanup",
			datasetKind: "generic",
			conversations: [],
			scenarios: [
				{
					scenarioId: "scenario-1",
					conversations: [
						{
							sessionId: "session-1",
							turns: [{ role: "user", body: "remember this" }],
						},
					],
					evaluations: [],
				},
			],
		}

		await (
			MongoDBMemoryManager.prototype as unknown as {
				runScenarioBenchmarkDataset: (
					this: MongoDBMemoryManager,
					params: {
						datasetPath: string
						dataset: MemoryBenchmarkDataset
						datasetVersion: string
						maxResults: number
						minScore: number
						retrievalLane: "native"
						executionProfile: "shipped"
						runContext: ReturnType<typeof testBenchmarkRunContext>
					},
				) => Promise<unknown>
			}
		).runScenarioBenchmarkDataset.call(manager, {
			datasetPath: "/tmp/benchmark.jsonl",
			dataset,
			datasetVersion: "dataset-v1",
			maxResults: 50,
			minScore: 0.01,
			retrievalLane: "native",
			executionProfile: "shipped",
			runContext: testBenchmarkRunContext("worker-cleanup"),
		})

		expect(order[0]).toBe("stop")
		expect(order.at(-1)).toBe("cleanup")
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

	it("isolates accounting when benchmark runs overlap on one manager", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-overlapping-bench-"),
		)
		const firstPath = path.join(workspaceDir, "first.json")
		const secondPath = path.join(workspaceDir, "second.json")
		let markFirstEntered: (() => void) | undefined
		let releaseFirst: (() => void) | undefined
		const firstEntered = new Promise<void>((resolve) => {
			markFirstEntered = resolve
		})
		const firstCanFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		try {
			await writeFile(firstPath, '{"name":"first"}')
			await writeFile(secondPath, '{"name":"second"}')
			mocked(loadBenchmarkDataset).mockResolvedValue({
				name: "overlap",
				datasetKind: "generic",
				conversations: [],
				evaluations: [],
				scenarios: [
					{
						scenarioId: "scenario-1",
						conversations: [],
						evaluations: [
							{
								caseId: "case-1",
								query: "question",
								expectedSessionIds: ["session-1"],
							},
						],
					},
				],
			})

			const runScenarioBenchmarkDataset = vi.fn(async (params) => {
				if (path.basename(params.datasetPath) === "first.json") {
					params.runContext.accounting.recordAttempt("rerank")
					params.runContext.accounting.recordFailure("rerank")
					markFirstEntered?.()
					await firstCanFinish
				} else {
					params.runContext.accounting.recordAttempt("answer-generation")
					params.runContext.accounting.recordSuccess("answer-generation")
					releaseFirst?.()
				}
				return {
					result: {
						datasetVersion: params.datasetVersion,
						datasetName: path.basename(params.datasetPath),
						datasetKind: "generic" as const,
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
				}
			})
			const buildBenchmarkParityBundle = vi.fn(async (params) => ({
				runIdentity: {
					datasetSha256: params.datasetSha256Override,
					retrievalUnit: "turn" as const,
				},
				embedding: {
					model: "mongodb-automated",
					dimensions: 1024,
					quantization: "float32" as const,
				},
				reranker: { model: "none", version: null, stage: "none" as const },
				storage: {
					basis: "benchmark-agent-logical-plus-shared-physical" as const,
					tenant: { documents: 0, logicalBytes: 0, collections: [] },
					sharedPhysical: { collections: [] },
				},
				latency: { p50Ms: 10, p95Ms: 10 },
				cost: params.runContext.accounting.snapshot(),
			}))
			const manager = {
				workspaceDir,
				db: { command: vi.fn() },
				prefix: "memongo_bench_",
				config: {
					mongodb: {
						relevance: { benchmark: { enabled: true, datasetPath: firstPath } },
						numDimensions: 1024,
						quantization: "none",
						reranking: {
							enabled: false,
							model: "none",
							topN: 0,
							minScore: 0.01,
						},
					},
				},
				relevance: { loadBenchmarkDataset: vi.fn() },
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark: vi.fn(),
				buildBenchmarkParityBundle,
			} as unknown as MongoDBMemoryManager

			const firstRun = MongoDBMemoryManager.prototype.relevanceBenchmark.call(
				manager,
				{ datasetPath: firstPath },
			)
			await firstEntered
			const secondRun = MongoDBMemoryManager.prototype.relevanceBenchmark.call(
				manager,
				{ datasetPath: secondPath },
			)
			const [first, second] = await Promise.all([firstRun, secondRun])

			expect(
				first.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "rerank",
				),
			).toEqual(expect.objectContaining({ attempted: 1, failed: 1 }))
			expect(
				first.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "answer-generation",
				),
			).toEqual(expect.objectContaining({ observability: "not-run" }))
			expect(
				second.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "answer-generation",
				),
			).toEqual(expect.objectContaining({ attempted: 1, succeeded: 1 }))
			expect(
				second.benchmarkReport?.cost?.operations.find(
					(entry) => entry.operation === "rerank",
				),
			).toEqual(expect.objectContaining({ observability: "not-run" }))
			const contexts = runScenarioBenchmarkDataset.mock.calls.map(
				([params]) => params.runContext,
			)
			expect(contexts[0]).not.toBe(contexts[1])
			expect(contexts[0].runId).not.toBe(contexts[1].runId)
		} finally {
			releaseFirst?.()
			await rm(workspaceDir, { recursive: true, force: true })
		}
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
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
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
					qualityThresholds: {
						contractId: "longmemeval-release",
						version: "1",
						datasetKind: "longmemeval",
						minHitRate: 0.8,
						maxEmptyRate: 0.2,
						minRAt5: 0.8,
						minNdcgAt10: 0.8,
						maxP95LatencyMs: 1_000,
						minSessionRecallAnyAt10: 0.8,
						minSessionNdcgAnyAt10: 0.8,
					},
				})

			expect(loadBenchmarkDataset).toHaveBeenCalledWith(
				resolvedDatasetPath,
				expect.objectContaining({
					allowedRoots: expect.arrayContaining([workspaceDir, datasetDir]),
				}),
			)
			expect(resolveRegisteredBenchmarkQualityContract).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetSha256: createHash("sha256")
						.update('{"name":"placeholder"}')
						.digest("hex"),
				}),
			)
			expect(runScenarioBenchmarkDataset).toHaveBeenCalledWith(
				expect.objectContaining({
					datasetPath: resolvedDatasetPath,
					maxResults: 50,
					executionProfile: "shipped",
					datasetVersion: createHash("sha256")
						.update('{"name":"placeholder"}')
						.digest("hex"),
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

	it("rejects a declared dataset digest before benchmark execution", async () => {
		const workspaceDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-relevance-bench-sha-"),
		)
		const datasetPath = path.join(workspaceDir, "dataset.json")
		try {
			await writeFile(datasetPath, '{"name":"actual-bytes"}')
			const runScenarioBenchmarkDataset = vi.fn()
			const runLegacyRelevanceBenchmark = vi.fn()
			const manager = {
				workspaceDir,
				config: {
					mongodb: {
						relevance: {
							benchmark: { enabled: true, datasetPath },
						},
						reranking: { minScore: 0.01 },
					},
				},
				relevance: { loadBenchmarkDataset: vi.fn() },
				getBenchmarkAllowedRoots:
					MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
				runScenarioBenchmarkDataset,
				runLegacyRelevanceBenchmark,
			} as unknown as MongoDBMemoryManager

			await expect(
				MongoDBMemoryManager.prototype.relevanceBenchmark.call(manager, {
					datasetPath,
					datasetSha256: "a".repeat(64),
				}),
			).rejects.toThrow(/does not match dataset bytes/i)
			expect(loadBenchmarkDataset).not.toHaveBeenCalled()
			expect(runScenarioBenchmarkDataset).not.toHaveBeenCalled()
			expect(runLegacyRelevanceBenchmark).not.toHaveBeenCalled()
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
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
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
				snapshotBenchmarkRunConfiguration: testBenchmarkRunConfiguration,
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
	it("forces production derived work for the shipped benchmark profile", () => {
		vi.stubEnv("MEMONGO_BENCHMARK_DERIVED_WORK_MODE", "disabled")
		const enabled = MongoDBMemoryManager.prototype[
			"shouldRunPostWriteDerivedWork"
		].call({ benchmarkShippedProfile: true } as unknown as MongoDBMemoryManager)
		expect(enabled).toBe(true)
		vi.unstubAllEnvs()
	})

	it("continues after an individual query failure without scoring it as a miss", async () => {
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "")
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
						name: "LoCoMo sample",
						datasetKind: "locomo",
						scenarios: [
							{
								scenarioId: "scenario-1",
								conversations: [],
								evaluations: [
									{
										caseId: "case-1",
										query: "First question",
										expectedSessionIds: ["session-1"],
										answer: "First answer",
										questionType: "single-session",
									},
									{
										caseId: "case-2",
										query: "Second question",
										expectedSessionIds: ["session-2"],
										answer: "Second answer",
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
		expect(result.result.scoredCases).toBe(1)
		expect(result.result.hitRate).toBe(1)
		expect(result.result.rAt10).toBe(1)
		expect(result.result.execution).toEqual({
			attemptedCases: 2,
			succeededCases: 1,
			failedCases: 1,
			retrievalEligibleCases: 2,
			abstentionCases: 0,
			missingJudgmentCases: 0,
			retrievalHits: 1,
			retrievalMisses: 0,
			scoredCases: 1,
		})
		expect(result.latencySamples).toHaveLength(2)
		expect(result.e2eQa).toEqual(
			expect.objectContaining({
				accuracy: null,
				unavailableReason: expect.any(String),
				cases: {
					eligible: 2,
					attempted: 0,
					completed: 0,
					failed: 0,
				},
			}),
		)
		vi.unstubAllEnvs()
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
				createHash("sha256").update(datasetText).digest("hex"),
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

	it("records a failed reranker provider attempt in the supplied benchmark context", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "high",
			reasoning: "direct evidence",
		})
		mocked(getEventsByTimeRange).mockResolvedValue([
			{
				_id: "evt-1",
				eventId: "evt-1",
				body: "first matching memory",
				role: "user",
				timestamp: new Date("2026-01-01T00:00:00Z"),
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				sessionId: "session-1",
				channel: "default",
			},
			{
				_id: "evt-2",
				eventId: "evt-2",
				body: "second matching memory",
				role: "user",
				timestamp: new Date("2026-01-02T00:00:00Z"),
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				sessionId: "session-2",
				channel: "default",
			},
		])
		mocked(crossEncoderRerank).mockImplementation(
			async ({ results, onProviderCall }) => {
				onProviderCall?.("attempted")
				onProviderCall?.("failed")
				return { results, reranked: false, latencyMs: 1 }
			},
		)
		const runContext = testBenchmarkRunContext("rerank-failure")

		await searchV2(fakeDb, fakePrefix, "matching memory", "agent-1", {
			availablePaths: new Set(["raw-window"]),
			searchOptions: {
				allowHybridBackstop: false,
				rerankConfig: {
					enabled: true,
					model: "rerank-2.5",
					topN: 10,
					minScore: 0,
					voyageApiKey: "test-key",
				},
				benchmarkRunContext: runContext,
			},
		})

		expect(runContext.accounting.snapshot().operations).toContainEqual({
			operation: "rerank",
			observability: "measured",
			attempted: 1,
			succeeded: 0,
			failed: 1,
			provider: "voyage",
			model: "rerank-2.5",
		})
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
							storedSource: false,
							vectorIndexMethod: false,
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

describe("MongoDBMemoryManager conversation recall", () => {
	it("forwards the verified native bitemporal prefilter capability", async () => {
		const { recallConversation } = await import(
			"./mongodb-conversation-recall.js"
		)
		mocked(recallConversation).mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: [],
				searchMethod: "standard",
				durationMs: 0,
			},
		})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				capabilities: {
					vectorSearch: true,
					textSearch: true,
					rankFusion: true,
					storedSource: false,
					vectorIndexMethod: false,
					scoreFusion: false,
				},
				nativeBitemporalVectorPrefilter: true,
			},
		) as MongoDBMemoryManager

		await manager.recallConversation({ query: "deployment" })

		expect(recallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				nativeBitemporalVectorPrefilter: true,
			}),
		)
	})

	it("activates native bitemporal prefiltering after a deferred index converges", async () => {
		const { recallConversation } = await import(
			"./mongodb-conversation-recall.js"
		)
		const { eventsCollection, isEventsVectorBitemporalPrefilterReady } =
			await import("./mongodb-schema.js")
		mocked(recallConversation).mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: [],
				searchMethod: "standard",
				durationMs: 0,
			},
		})
		mocked(isEventsVectorBitemporalPrefilterReady).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				capabilities: {
					vectorSearch: true,
					textSearch: true,
					rankFusion: true,
					storedSource: false,
					vectorIndexMethod: false,
					scoreFusion: false,
				},
				nativeBitemporalVectorPrefilter: false,
				nativeBitemporalPrefilterCheckedAt: 0,
			},
		) as MongoDBMemoryManager

		await manager.recallConversation({ query: "deployment" })

		expect(recallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				nativeBitemporalVectorPrefilter: true,
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
		const { invalidateQueryCache } = await import("./mongodb-query-cache.js")

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
		expect(invalidateQueryCache).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
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
		const { getPendingExtractionEvents } = await import("./mongodb-events.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, completeClaimedMemoryJob, createMemoryJob } =
			await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		mocked(createMemoryJob).mockResolvedValue("extraction-evt-1")
		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-evt-1",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				startedAt: new Date("2026-04-09T12:00:01.000Z"),
				payload: {
					eventId: "evt-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
				},
				attempts: 1,
				leaseOwner: "worker-1",
				leaseToken: "lease-1",
				heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
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
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
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
				memoryJobWorkerId: "worker-1",
				memoryJobWorkerStopped: false,
				memoryJobWorkerPromise: Promise.resolve(),
			},
		) as MongoDBMemoryManager & {
			derivationQueue: Promise<void>
			memoryJobWorkerPromise: Promise<void>
		}

		const result = await manager.extractEvent({
			eventId: "evt-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
		await manager.memoryJobWorkerPromise

		expect(result).toEqual({
			jobId: "extraction-evt-1",
			scheduled: true,
		})
		expect(getPendingExtractionEvents).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-1" }),
		)
		expect(extractAndUpsertEntities).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				sourceEventId: "evt-1",
			}),
		)
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobId: "extraction-evt-1",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					metadata: { eventId: "evt-1" },
					payload: {
						eventId: "evt-1",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
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
		expect(claimMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				jobType: "extraction",
				workerId: "worker-1",
			}),
		)
		expect(completeClaimedMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-1",
				leaseOwner: "worker-1",
				leaseToken: "lease-1",
				inputCount: 1,
				outputCount: 1,
			}),
		)
	})

	it("repairs a pending extraction outbox event into a claimable job", async () => {
		const {
			clearEventExtractionJobPending,
			getPendingExtractionEvents,
			projectEventChunk,
		} = await import("./mongodb-events.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { createMemoryJob, getMemoryJob, releaseStagedMemoryJob } =
			await import("./mongodb-memory-jobs.js")
		const pendingAt = new Date("2026-04-09T12:00:00.000Z")
		mocked(getPendingExtractionEvents).mockResolvedValue([
			{
				eventId: "evt-outbox-repair",
				agentId: "agent-1",
				role: "user",
				body: "Recover this event after a standalone crash.",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: pendingAt,
				extractionJobPendingAt: pendingAt,
			},
		])
		mocked(getMemoryJob).mockResolvedValue(null)
		mocked(createMemoryJob).mockResolvedValue("extraction-evt-outbox-repair")
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(releaseStagedMemoryJob).mockResolvedValue(true)
		mocked(clearEventExtractionJobPending).mockResolvedValue(true)

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				chunkCount: 0,
			},
		) as MongoDBMemoryManager
		const repair = (
			manager as unknown as {
				repairExtractionOutbox: (params?: { limit?: number }) => Promise<{
					eventsProcessed: number
					jobsCreated: number
					jobsReleased: number
					eventsFailed: number
				}>
			}
		).repairExtractionOutbox

		await expect(repair.call(manager, { limit: 25 })).resolves.toEqual({
			eventsProcessed: 1,
			jobsCreated: 1,
			jobsReleased: 1,
			eventsFailed: 0,
		})
		expect(getPendingExtractionEvents).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			limit: 25,
		})
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobId: "extraction-evt-outbox-repair",
					stagedAt: pendingAt,
					payload: {
						eventId: "evt-outbox-repair",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
				}),
			}),
		)
		expect(mocked(projectEventChunk).mock.invocationCallOrder[0]).toBeLessThan(
			mocked(releaseStagedMemoryJob).mock.invocationCallOrder[0],
		)
		expect(clearEventExtractionJobPending).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			eventId: "evt-outbox-repair",
			agentId: "agent-1",
		})
	})

	it("recovers pending extraction work when the durable worker starts", async () => {
		const { claimMemoryJob, completeClaimedMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)
		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-recovered",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: {
					eventId: "evt-recovered",
					scope: "agent",
					scopeRef: "agent:agent-1",
				},
				attempts: 2,
				leaseOwner: "worker-recovery",
				leaseToken: "lease-recovery",
				heartbeatAt: new Date("2026-04-09T12:01:00.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:02:00.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-recovered",
				agentId: "agent-1",
				role: "user",
				body: "Remember the recovered durable job.",
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
				memoryJobWorkerId: "worker-recovery",
				memoryJobWorkerStopped: true,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
			},
		) as MongoDBMemoryManager & {
			memoryJobWorkerPromise: Promise<void>
		}
		const lifecycle = MongoDBMemoryManager.prototype as unknown as {
			startMemoryJobWorker: (this: MongoDBMemoryManager) => void
			stopMemoryJobWorker: (this: MongoDBMemoryManager) => Promise<void>
		}

		lifecycle.startMemoryJobWorker.call(manager)
		await manager.memoryJobWorkerPromise

		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({ eventId: "evt-recovered" }),
			}),
		)
		expect(completeClaimedMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-recovered",
				leaseToken: "lease-recovery",
			}),
		)
		await lifecycle.stopMemoryJobWorker.call(manager)
	})

	it("recovers a pre-upgrade extraction job whose event id is in metadata", async () => {
		const { claimMemoryJob, completeClaimedMemoryJob, failClaimedMemoryJob } =
			await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-legacy-event",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				metadata: { eventId: "legacy-event" },
				attempts: 1,
				leaseOwner: "worker-legacy",
				leaseToken: "lease-legacy",
				heartbeatAt: new Date("2026-04-09T12:01:00.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:02:00.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
		mocked(failClaimedMemoryJob).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "legacy-event",
				agentId: "agent-1",
				role: "user",
				body: "Recover this event from the legacy job metadata.",
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
				memoryJobWorkerId: "worker-legacy",
				memoryJobWorkerStopped: true,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
			},
		) as MongoDBMemoryManager & {
			memoryJobWorkerPromise: Promise<void>
		}
		const lifecycle = MongoDBMemoryManager.prototype as unknown as {
			startMemoryJobWorker: (this: MongoDBMemoryManager) => void
			stopMemoryJobWorker: (this: MongoDBMemoryManager) => Promise<void>
		}

		lifecycle.startMemoryJobWorker.call(manager)
		await manager.memoryJobWorkerPromise

		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({ eventId: "legacy-event" }),
			}),
		)
		expect(completeClaimedMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "extraction-legacy-event" }),
		)
		expect(failClaimedMemoryJob).not.toHaveBeenCalled()
		await lifecycle.stopMemoryJobWorker.call(manager)
	})

	it("does not continue or terminal-write after the extraction lease is lost", async () => {
		vi.useFakeTimers()
		try {
			const {
				claimMemoryJob,
				completeClaimedMemoryJob,
				createMemoryJob,
				failClaimedMemoryJob,
				renewMemoryJobLease,
			} = await import("./mongodb-memory-jobs.js")
			const { eventsCollection } = await import("./mongodb-schema.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			mocked(createMemoryJob).mockResolvedValue("extraction-evt-long")
			mocked(claimMemoryJob)
				.mockResolvedValueOnce({
					jobId: "extraction-evt-long",
					jobType: "extraction",
					agentId: "agent-1",
					status: "running",
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					payload: {
						eventId: "evt-long",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
					attempts: 1,
					leaseOwner: "worker-long",
					leaseToken: "lease-long",
					heartbeatAt: new Date("2026-04-09T12:00:00.000Z"),
					leaseExpiresAt: new Date("2026-04-09T12:01:00.000Z"),
				})
				.mockResolvedValueOnce(null)
			mocked(renewMemoryJobLease).mockResolvedValue(false)
			mocked(eventsCollection).mockReturnValue({
				findOne: vi.fn(async () => ({
					eventId: "evt-long",
					agentId: "agent-1",
					role: "user",
					body: "Remember this long extraction.",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					scope: "agent",
					scopeRef: "agent:agent-1",
				})),
			} as unknown as import("mongodb").Collection)
			let resolvePromotion: (() => void) | undefined
			mocked(promoteDerivedMemoryFromEvent).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolvePromotion = () =>
							resolve({
								structuredCreated: 1,
								proceduresCreated: 0,
								skipped: false,
							})
					}),
			)

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "agent-1",
					client: undefined,
					config: { mongodb: { embeddingMode: "automated" } },
					workspaceDir: "/tmp/memongo",
					memoryJobWorkerId: "worker-long",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobRunContexts: new Map(),
				},
			) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

			await manager.extractEvent({
				eventId: "evt-long",
				scope: "agent",
				scopeRef: "agent:agent-1",
			})
			await vi.waitFor(() => {
				expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
			})
			await vi.advanceTimersByTimeAsync(20_001)
			expect(renewMemoryJobLease).toHaveBeenCalledWith(
				expect.objectContaining({
					jobId: "extraction-evt-long",
					leaseOwner: "worker-long",
					leaseToken: "lease-long",
				}),
			)
			resolvePromotion?.()
			await manager.memoryJobWorkerPromise

			expect(completeClaimedMemoryJob).not.toHaveBeenCalled()
			expect(failClaimedMemoryJob).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("fails closed when extraction lease renewal is uncertain", async () => {
		vi.useFakeTimers()
		try {
			const {
				claimMemoryJob,
				completeClaimedMemoryJob,
				createMemoryJob,
				failClaimedMemoryJob,
				renewMemoryJobLease,
			} = await import("./mongodb-memory-jobs.js")
			const { eventsCollection } = await import("./mongodb-schema.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			mocked(createMemoryJob).mockResolvedValue(
				"extraction-evt-uncertain-lease",
			)
			mocked(claimMemoryJob)
				.mockResolvedValueOnce({
					jobId: "extraction-evt-uncertain-lease",
					jobType: "extraction",
					agentId: "agent-1",
					status: "running",
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					payload: { eventId: "evt-uncertain-lease" },
					attempts: 1,
					leaseOwner: "worker-uncertain",
					leaseToken: "lease-uncertain",
					heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
					leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
				})
				.mockResolvedValueOnce(null)
			mocked(renewMemoryJobLease).mockRejectedValue(
				new Error("heartbeat outcome unknown"),
			)
			mocked(eventsCollection).mockReturnValue({
				findOne: vi.fn(async () => ({
					eventId: "evt-uncertain-lease",
					agentId: "agent-1",
					role: "user",
					body: "Do not terminal-write after an uncertain heartbeat.",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					scope: "agent",
					scopeRef: "agent:agent-1",
				})),
			} as unknown as import("mongodb").Collection)
			let resolvePromotion: (() => void) | undefined
			mocked(promoteDerivedMemoryFromEvent).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolvePromotion = () =>
							resolve({
								structuredCreated: 1,
								proceduresCreated: 0,
								skipped: false,
							})
					}),
			)

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "agent-1",
					client: undefined,
					config: { mongodb: { embeddingMode: "automated" } },
					workspaceDir: "/tmp/memongo",
					memoryJobWorkerId: "worker-uncertain",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobRunContexts: new Map(),
				},
			) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

			await manager.extractEvent({ eventId: "evt-uncertain-lease" })
			await vi.waitFor(() => {
				expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
			})
			await vi.advanceTimersByTimeAsync(20_001)
			resolvePromotion?.()
			await manager.memoryJobWorkerPromise

			expect(completeClaimedMemoryJob).not.toHaveBeenCalled()
			expect(failClaimedMemoryJob).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("waits for an active durable extraction before closing MongoDB", async () => {
		let finishWorker: (() => void) | undefined
		const worker = new Promise<void>((resolve) => {
			finishWorker = resolve
		})
		const closeClient = vi.fn(async () => {})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				closed: false,
				client: { close: closeClient },
				writeQueue: Promise.resolve(),
				derivationQueue: Promise.resolve(),
				derivationSchedulingQueue: Promise.resolve(),
				memoryJobWorkerStopped: false,
				memoryJobWorkerTimer: null,
				memoryJobWorkerPromise: worker,
				watchTimer: null,
				watcher: null,
				changeStreamWatcher: null,
				syncing: null,
				accessTracker: null,
			},
		) as MongoDBMemoryManager

		const closing = manager.close()
		await Promise.resolve()
		await Promise.resolve()
		expect(closeClient).not.toHaveBeenCalled()

		finishWorker?.()
		await closing

		expect(closeClient).toHaveBeenCalledOnce()
	})

	it("wakes an existing pending extraction job instead of stranding it", async () => {
		const {
			claimMemoryJob,
			completeClaimedMemoryJob,
			createMemoryJob,
			getMemoryJob,
		} = await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		mocked(createMemoryJob).mockRejectedValue({ code: 11000 })
		mocked(getMemoryJob).mockResolvedValue({
			jobId: "extraction-evt-1",
			jobType: "extraction",
			agentId: "agent-1",
			status: "pending",
			createdAt: new Date("2026-04-09T12:00:00.000Z"),
			payload: { eventId: "evt-1" },
		})
		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-evt-1",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: { eventId: "evt-1" },
				attempts: 1,
				leaseOwner: "worker-1",
				leaseToken: "lease-1",
				heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-1",
				agentId: "agent-1",
				role: "assistant",
				body: "Remember this recovered pending job.",
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
				memoryJobWorkerId: "worker-1",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

		const result = await manager.extractEvent({ eventId: "evt-1" })
		await manager.memoryJobWorkerPromise

		expect(result).toEqual({
			jobId: "extraction-evt-1",
			scheduled: true,
		})
		expect(getMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-1",
				agentId: "agent-1",
			}),
		)
		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
	})

	it("preserves a wake that arrives while an empty claim is finishing", async () => {
		const { claimMemoryJob, completeClaimedMemoryJob, createMemoryJob } =
			await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		let finishEmptyClaim: ((value: null) => void) | undefined
		mocked(claimMemoryJob)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishEmptyClaim = resolve
					}),
			)
			.mockResolvedValueOnce({
				jobId: "extraction-evt-late-wake",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: { eventId: "evt-late-wake" },
				attempts: 1,
				leaseOwner: "worker-late-wake",
				leaseToken: "lease-late-wake",
				heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(createMemoryJob).mockResolvedValue("extraction-evt-late-wake")
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-late-wake",
				agentId: "agent-1",
				role: "user",
				body: "Do not lose this wake between drain and finalizer.",
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
				memoryJobWorkerId: "worker-late-wake",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }
		const lifecycle = MongoDBMemoryManager.prototype as unknown as {
			wakeMemoryJobWorker: (this: MongoDBMemoryManager) => void
		}

		lifecycle.wakeMemoryJobWorker.call(manager)
		await vi.waitFor(() => {
			expect(claimMemoryJob).toHaveBeenCalledOnce()
		})
		await manager.extractEvent({ eventId: "evt-late-wake" })
		finishEmptyClaim?.(null)

		await vi.waitFor(
			() => {
				expect(claimMemoryJob).toHaveBeenCalledTimes(3)
			},
			{ timeout: 200 },
		)
		await manager.memoryJobWorkerPromise
		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
	})

	it("wakes an existing extraction job after its lease expires", async () => {
		const { claimMemoryJob, createMemoryJob, getMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)

		mocked(createMemoryJob).mockRejectedValue({ code: 11000 })
		mocked(getMemoryJob).mockResolvedValue({
			jobId: "extraction-evt-expired",
			jobType: "extraction",
			agentId: "agent-1",
			status: "running",
			createdAt: new Date("2026-04-09T12:00:00.000Z"),
			payload: { eventId: "evt-expired" },
			leaseOwner: "dead-worker",
			leaseToken: "expired-lease",
			leaseExpiresAt: new Date(Date.now() - 1_000),
		})
		mocked(claimMemoryJob).mockResolvedValue(null)

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				memoryJobWorkerId: "worker-1",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

		const result = await manager.extractEvent({ eventId: "evt-expired" })
		await manager.memoryJobWorkerPromise

		expect(result).toEqual({
			jobId: "extraction-evt-expired",
			scheduled: true,
		})
		expect(claimMemoryJob).toHaveBeenCalled()
	})

	it.each([
		"completed",
		"cancelled",
	] as const)("does not reschedule an extraction job that is already %s", async (status) => {
		const { claimMemoryJob, createMemoryJob, getMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)

		mocked(createMemoryJob).mockRejectedValue({ code: 11000 })
		mocked(getMemoryJob).mockResolvedValue({
			jobId: "extraction-evt-terminal",
			jobType: "extraction",
			agentId: "agent-1",
			status,
			createdAt: new Date("2026-04-09T12:00:00.000Z"),
			payload: { eventId: "evt-terminal" },
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
			},
		) as MongoDBMemoryManager

		await expect(
			manager.extractEvent({ eventId: "evt-terminal" }),
		).resolves.toEqual({
			jobId: "extraction-evt-terminal",
			scheduled: false,
		})
		expect(claimMemoryJob).not.toHaveBeenCalled()
	})

	it("atomically retries a failed extraction job when explicitly scheduled again", async () => {
		const {
			claimMemoryJob,
			createMemoryJob,
			getMemoryJob,
			retryFailedMemoryJob,
		} = await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")

		mocked(createMemoryJob).mockRejectedValue({ code: 11000 })
		mocked(getMemoryJob).mockResolvedValue({
			jobId: "extraction-evt-retry",
			jobType: "extraction",
			agentId: "agent-1",
			status: "failed",
			createdAt: new Date("2026-04-09T12:00:00.000Z"),
			payload: { eventId: "evt-retry" },
			attempts: 1,
			error: "temporary provider failure",
		})
		mocked(retryFailedMemoryJob).mockResolvedValue(true)
		mocked(claimMemoryJob).mockResolvedValue(null)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({ _id: "owned-event" })),
		} as unknown as import("mongodb").Collection)

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				memoryJobWorkerId: "worker-retry",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWakeRequested: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

		await expect(
			manager.extractEvent({
				eventId: "evt-retry",
				scope: "agent",
				scopeRef: "agent:agent-1",
			}),
		).resolves.toEqual({
			jobId: "extraction-evt-retry",
			scheduled: true,
		})
		expect(retryFailedMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-retry",
				agentId: "agent-1",
				payload: {
					eventId: "evt-retry",
					scope: "agent",
					scopeRef: "agent:agent-1",
				},
			}),
		)
	})

	it("does not disturb an extraction job with an active lease", async () => {
		const { claimMemoryJob, createMemoryJob, getMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)

		mocked(createMemoryJob).mockRejectedValue({ code: 11000 })
		mocked(getMemoryJob).mockResolvedValue({
			jobId: "extraction-evt-active",
			jobType: "extraction",
			agentId: "agent-1",
			status: "running",
			createdAt: new Date("2026-04-09T12:00:00.000Z"),
			payload: { eventId: "evt-active" },
			leaseOwner: "live-worker",
			leaseToken: "live-lease",
			leaseExpiresAt: new Date(Date.now() + 60_000),
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
			},
		) as MongoDBMemoryManager

		await expect(
			manager.extractEvent({ eventId: "evt-active" }),
		).resolves.toEqual({
			jobId: "extraction-evt-active",
			scheduled: false,
		})
		expect(claimMemoryJob).not.toHaveBeenCalled()
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
		const { claimMemoryJob, completeClaimedMemoryJob, createMemoryJob } =
			await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { invalidateQueryCache } = await import("./mongodb-query-cache.js")
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
		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-evt-1",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: {
					eventId: "evt-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
				},
				attempts: 1,
				leaseOwner: "worker-1",
				leaseToken: "lease-1",
				heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
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
				derivationSchedulingQueue: Promise.resolve(),
				memoryJobWorkerId: "worker-1",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
				chunkCount: 0,
				dirty: true,
			},
		) as MongoDBMemoryManager & {
			writeQueue: Promise<void>
			derivationQueue: Promise<void>
			derivationSchedulingQueue: Promise<void>
			memoryJobWorkerPromise: Promise<void>
		}

		const result = await manager.writeConversationEvent({
			role: "assistant",
			body: "Remember this: deployment is blocked by legal review.",
			scope: "agent",
		})
		await manager.derivationSchedulingQueue
		await manager.memoryJobWorkerPromise

		expect(result).toEqual({
			eventId: "evt-1",
			chunkCreated: false,
		})
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobId: "extraction-evt-1",
					jobType: "extraction",
					payload: {
						eventId: "evt-1",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
				}),
			}),
		)
		expect(promoteDerivedMemoryFromEvent).toHaveBeenCalled()
		expect(invalidateQueryCache).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
	})

	it("does not acknowledge an event write before its extraction job is durable", async () => {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)

		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-durable-before-ack",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		let persistJob: (() => void) | undefined
		mocked(createMemoryJob).mockImplementation(
			() =>
				new Promise((resolve) => {
					persistJob = () => resolve("extraction-evt-durable-before-ack")
				}),
		)
		mocked(claimMemoryJob).mockResolvedValue(null)

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
				derivationSchedulingQueue: Promise.resolve(),
				memoryJobWorkerId: "worker-durable-before-ack",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
				chunkCount: 0,
				dirty: true,
			},
		) as MongoDBMemoryManager

		let writeCompleted = false
		const write = manager
			.writeConversationEvent({
				role: "user",
				body: "Persist the durable job before acknowledging this event.",
				scope: "agent",
			})
			.then((result) => {
				writeCompleted = true
				return result
			})

		await vi.waitFor(() => {
			expect(createMemoryJob).toHaveBeenCalled()
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(writeCompleted).toBe(false)

		persistJob?.()
		await expect(write).resolves.toEqual({
			eventId: "evt-durable-before-ack",
			chunkCreated: false,
		})
	})

	it("stages the event and extraction job in one majority transaction", async () => {
		const { writeEvent, projectEventChunk, clearEventExtractionJobPending } =
			await import("./mongodb-events.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJob, releaseStagedMemoryJob } =
			await import("./mongodb-memory-jobs.js")

		const session = {
			withTransaction: vi.fn(async (callback: () => Promise<void>) =>
				callback(),
			),
			endSession: vi.fn().mockResolvedValue(undefined),
		}
		const client = {
			startSession: vi.fn(() => session),
		}
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-transactional-outbox",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue(
			"extraction-evt-transactional-outbox",
		)
		mocked(releaseStagedMemoryJob).mockResolvedValue(true)
		mocked(claimMemoryJob).mockResolvedValue(null)

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client,
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
				memoryJobWorkerId: "worker-transactional-outbox",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
				chunkCount: 0,
				dirty: true,
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

		await manager.writeConversationEvent({
			role: "user",
			body: "Persist this event and its extraction job atomically.",
			scope: "agent",
		})
		await manager.memoryJobWorkerPromise

		expect(client.startSession).toHaveBeenCalledOnce()
		expect(session.withTransaction).toHaveBeenCalledWith(expect.any(Function), {
			writeConcern: { w: "majority", wtimeout: 1000 },
		})
		expect(writeEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				session,
				event: expect.objectContaining({
					extractionJobPendingAt: expect.any(Date),
				}),
			}),
		)
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				session,
				job: expect.objectContaining({
					jobId: "extraction-evt-transactional-outbox",
					status: "pending",
					stagedAt: expect.any(Date),
				}),
			}),
		)
		expect(mocked(projectEventChunk).mock.invocationCallOrder[0]).toBeLessThan(
			mocked(releaseStagedMemoryJob).mock.invocationCallOrder[0],
		)
		expect(clearEventExtractionJobPending).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			eventId: "evt-transactional-outbox",
			agentId: "agent-1",
		})
		expect(
			mocked(releaseStagedMemoryJob).mock.invocationCallOrder[0],
		).toBeLessThan(
			mocked(clearEventExtractionJobPending).mock.invocationCallOrder[0],
		)
		expect(session.endSession).toHaveBeenCalledOnce()
	})

	it("accepts a staged job already released by a concurrent recovery worker", async () => {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const {
			claimMemoryJob,
			createMemoryJob,
			getMemoryJob,
			releaseStagedMemoryJob,
		} = await import("./mongodb-memory-jobs.js")
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-concurrent-outbox-repair",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue(
			"extraction-evt-concurrent-outbox-repair",
		)
		mocked(releaseStagedMemoryJob).mockResolvedValue(false)
		mocked(getMemoryJob).mockResolvedValue({
			jobId: "extraction-evt-concurrent-outbox-repair",
			jobType: "extraction",
			agentId: "agent-1",
			status: "pending",
			createdAt: new Date("2026-04-09T12:00:00.000Z"),
			payload: { eventId: "evt-concurrent-outbox-repair" },
		})
		mocked(claimMemoryJob).mockResolvedValue(null)

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
				derivationSchedulingQueue: Promise.resolve(),
				memoryJobWorkerId: "worker-concurrent-repair",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
				chunkCount: 0,
				dirty: true,
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

		await expect(
			manager.writeConversationEvent({
				role: "user",
				body: "Allow a concurrent recovery worker to finish the outbox.",
				scope: "agent",
			}),
		).resolves.toEqual({
			eventId: "evt-concurrent-outbox-repair",
			chunkCreated: false,
		})
	})

	it("attributes shipped post-write provider failures to the benchmark run", async () => {
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "derived-model")
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJob, failClaimedMemoryJob } =
			await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)
		const enrichment = await import("./mongodb-llm-enrichment.js")
		const provider = {
			name: "mock-provider",
			chatCompletion: vi.fn().mockRejectedValue(new Error("provider down")),
		}
		const providerSpy = vi
			.spyOn(enrichment, "resolveEnrichmentProvider")
			.mockReturnValue(provider)
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-benchmark-accounting",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:benchmark-accounting",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue(
			"extraction-evt-benchmark-accounting",
		)
		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-evt-benchmark-accounting",
				jobType: "extraction",
				agentId: "benchmark-accounting",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: {
					eventId: "evt-benchmark-accounting",
					scope: "agent",
					scopeRef: "agent:benchmark-accounting",
				},
				attempts: 1,
				leaseOwner: "worker-accounting",
				leaseToken: "lease-accounting",
				heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(failClaimedMemoryJob).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-benchmark-accounting",
				agentId: "benchmark-accounting",
				role: "user",
				body: "Remember this provider failure.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:benchmark-accounting",
			})),
		} as unknown as import("mongodb").Collection)
		mocked(promoteDerivedMemoryFromEvent).mockImplementation(
			async ({ provider: instrumented, model }) => {
				await instrumented?.chatCompletion({
					model: model ?? "derived-model",
					messages: [{ role: "user", content: "remember" }],
				})
				return {
					structuredCreated: 0,
					proceduresCreated: 0,
					skipped: false,
				}
			},
		)
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "benchmark-accounting",
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
				memoryJobWorkerId: "worker-accounting",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobRunContexts: new Map(),
				chunkCount: 0,
				dirty: true,
				benchmarkShippedProfile: true,
			},
		) as MongoDBMemoryManager & {
			derivationQueue: Promise<void>
			derivationSchedulingQueue: Promise<void>
			memoryJobWorkerPromise: Promise<void>
		}
		const runContext = testBenchmarkRunContext("shipped-run")

		try {
			await manager.writeConversationEvent(
				{
					role: "user",
					body: "Remember this provider failure.",
					scope: "agent",
				},
				runContext,
			)
			await manager.derivationSchedulingQueue
			await manager.memoryJobWorkerPromise
			expect(runContext.accounting.snapshot().operations).toContainEqual({
				operation: "structured-extraction",
				observability: "measured",
				attempted: 1,
				succeeded: 0,
				failed: 1,
				provider: "mock-provider",
				model: "derived-model",
			})
		} finally {
			providerSpy.mockRestore()
			vi.unstubAllEnvs()
		}
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
			const { claimMemoryJob, completeClaimedMemoryJob, createMemoryJob } =
				await import("./mongodb-memory-jobs.js")
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
			mocked(claimMemoryJob)
				.mockResolvedValueOnce({
					jobId: "extraction-evt-benchmark-enabled-1",
					jobType: "extraction",
					agentId: "benchmark-agent-enabled",
					status: "running",
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					payload: {
						eventId: "evt-benchmark-enabled-1",
						scope: "agent",
						scopeRef: "agent:benchmark-agent-enabled",
					},
					attempts: 1,
					leaseOwner: "worker-diagnostic",
					leaseToken: "lease-diagnostic",
					heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
					leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
				})
				.mockResolvedValueOnce(null)
			mocked(completeClaimedMemoryJob).mockResolvedValue(true)
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
					memoryJobWorkerId: "worker-diagnostic",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobRunContexts: new Map(),
					chunkCount: 0,
					dirty: true,
				},
			) as MongoDBMemoryManager & {
				derivationQueue: Promise<void>
				derivationSchedulingQueue: Promise<void>
				memoryJobWorkerPromise: Promise<void>
			}

			await manager.writeConversationEvent({
				role: "assistant",
				body: "Remember this diagnostic benchmark fact.",
				scope: "agent",
			})
			await manager.derivationSchedulingQueue
			await manager.memoryJobWorkerPromise

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

describe("MongoDBMemoryManager projection repair", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("drains every startup batch until no unprojected events remain", async () => {
		const { projectChunksFromEvents } = await import("./mongodb-events.js")
		mocked(projectChunksFromEvents)
			.mockResolvedValueOnce({ eventsProcessed: 500, chunksCreated: 499 })
			.mockResolvedValueOnce({ eventsProcessed: 2, chunksCreated: 2 })

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager

		const result = await (
			manager as unknown as {
				repairEventProjections: () => Promise<{
					eventsProcessed: number
					chunksCreated: number
				}>
			}
		).repairEventProjections()

		expect(result).toEqual({ eventsProcessed: 502, chunksCreated: 501 })
		expect(projectChunksFromEvents).toHaveBeenCalledTimes(2)
		expect(projectChunksFromEvents).toHaveBeenNthCalledWith(1, {
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			batchSize: 500,
		})
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
				storedSource: false,
				vectorIndexMethod: false,
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
				storedSource: false,
				vectorIndexMethod: false,
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

	it("never queries session_chunks unless the lane is explicitly enabled", async () => {
		// The session_chunks lane is written only by benchmark ingest, so for a
		// real user it is an empty collection whose results the scorer then
		// boosts 1.24x. A query-shape regex must not be able to enable it.
		const previousMode = process.env.MEMONGO_SESSION_EVIDENCE_MODE
		delete process.env.MEMONGO_SESSION_EVIDENCE_MODE
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["hybrid"],
				confidence: "high",
				reasoning: "test session lane opt-in",
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

			await searchV2(
				fakeDb,
				fakePrefix,
				"any tips or recommendations for my espresso setup?",
				"agent-1",
				{
					availablePaths: new Set(["hybrid"]),
					searchOptions: {
						scope: "agent",
						scopeRef: "agent:agent-1",
						capabilities: {
							vectorSearch: false,
							textSearch: true,
							rankFusion: false,
							storedSource: false,
							vectorIndexMethod: false,
							scoreFusion: false,
						},
						fusionMethod: "rankFusion",
						embeddingMode: "automated",
						allowHybridBackstop: false,
					},
				},
			)

			expect(sessionAggregate).not.toHaveBeenCalled()
		} finally {
			if (previousMode === undefined) {
				delete process.env.MEMONGO_SESSION_EVIDENCE_MODE
			} else {
				process.env.MEMONGO_SESSION_EVIDENCE_MODE = previousMode
			}
		}
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
						storedSource: false,
						vectorIndexMethod: false,
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

describe("resolveObservedSearchMethod", () => {
	// C8 regression. The normalizer is picked from this value, so guessing
	// "hybrid" while mongoSearch actually degraded to keyword/$text sent raw
	// BM25 scores through the [0,1] clamp. Every lexical hit scoring above 1
	// pinned to exactly 1.0 and sorted above genuine cosine hits from the KB
	// and structured lanes.
	const mongoCfg = {
		embeddingMode: "automated",
	} as unknown as Parameters<
		typeof MongoDBMemoryManager.prototype.resolveObservedSearchMethod
	>[1]

	function resolve(
		traceEvents: Array<{ method: string; ok: boolean }>,
		capabilities: { vectorSearch: boolean; textSearch: boolean },
	) {
		const self = {
			capabilities,
			detectSearchMethod: MongoDBMemoryManager.prototype["detectSearchMethod"],
		}
		return MongoDBMemoryManager.prototype["resolveObservedSearchMethod"].call(
			self as never,
			traceEvents as never,
			mongoCfg,
		)
	}

	const fullCaps = { vectorSearch: true, textSearch: true }

	it("reports text when the search degraded to keyword, despite hybrid capabilities", () => {
		expect(
			resolve(
				[
					{ method: "rankFusion", ok: false },
					{ method: "js-merge", ok: false },
					{ method: "vector", ok: false },
					{ method: "keyword", ok: true },
				],
				fullCaps,
			),
		).toBe("text")
	})

	it("reports text for the last-resort $text path", () => {
		expect(resolve([{ method: "$text", ok: true }], fullCaps)).toBe("text")
	})

	it("reports vector when only the vector fallback succeeded", () => {
		expect(
			resolve(
				[
					{ method: "rankFusion", ok: false },
					{ method: "vector", ok: true },
				],
				fullCaps,
			),
		).toBe("vector")
	})

	it("reports hybrid for each server-side fusion path and the JS merge", () => {
		for (const method of ["scoreFusion", "rankFusion", "js-merge"]) {
			expect(resolve([{ method, ok: true }], fullCaps)).toBe("hybrid")
		}
	})

	it("uses the latest successful trace when several succeeded", () => {
		expect(
			resolve(
				[
					{ method: "rankFusion", ok: true },
					{ method: "keyword", ok: true },
				],
				fullCaps,
			),
		).toBe("text")
	})

	it("falls back to the capability guess when nothing succeeded", () => {
		expect(resolve([{ method: "rankFusion", ok: false }], fullCaps)).toBe(
			"hybrid",
		)
		expect(resolve([], { vectorSearch: true, textSearch: false })).toBe(
			"vector",
		)
		expect(resolve([], { vectorSearch: false, textSearch: true })).toBe("text")
	})
})
