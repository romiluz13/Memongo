/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager, searchV2 } from "./mongodb-manager.js"
import { checkCache } from "./mongodb-query-cache.js"
import { crossEncoderRerank } from "./mongodb-reranker.js"
import { rewriteQuery } from "./mongodb-query-rewriter.js"
import { normalizeSinglePathScores } from "./mongodb-search-v2.js"
import type { MemorySearchResult } from "./types.js"
import {
	mocked,
	buildMockManager,
	fakeDb,
	fakePrefix,
	captureManagerPrototype,
} from "./test-helpers/manager-test-kit.js"

captureManagerPrototype(MongoDBMemoryManager)

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)

vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)

vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)

vi.mock("./mongodb-schema.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).schemaModuleMock(),
)

vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)

vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)

vi.mock("./mongodb-reranker.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).rerankerModuleMock(),
)

vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)

vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)

vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)

vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

const { getEventsByTimeRange } = await import("./mongodb-events.js")
const { planRetrieval, resolveTimeRangePreset, extractTemporalWindow } =
	await import("./mongodb-retrieval-planner.js")
const { searchEpisodes } = await import("./mongodb-episodes.js")
const { searchEntitiesAutocomplete, expandGraph } = await import(
	"./mongodb-graph.js"
)
const {
	eventsCollection,
	proceduresCollection,
	chunksCollection,
	structuredMemCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
} = await import("./mongodb-schema.js")
const { getLaneCoverage } = await import("./mongodb-lane-coverage.js")

// ---------------------------------------------------------------------------
// #66 step 3b: non-lane phase latency instrumentation
// ---------------------------------------------------------------------------

describe("searchV2 non-lane phase latency instrumentation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
			results,
			reranked: false,
			latencyMs: 0,
		}))
		mocked(rewriteQuery).mockResolvedValue({
			originalQuery: "espresso",
			rewrittenQuery: "espresso coffee",
			rewritten: true,
			method: "synonym-expansion",
			latencyMs: 0,
		})
	})

	it("records the planner and lane-fan-out phases alongside the lanes", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "phase probe",
		})
		mocked(searchEpisodes).mockResolvedValue([])

		const result = await searchV2(fakeDb, fakePrefix, "espresso", "agent-1", {
			availablePaths: new Set(["episodic"]),
			searchOptions: { allowHybridBackstop: false },
		})

		const phases = result.metadata.latencyByPath ?? {}
		expect(phases["phase:plan"]).toBeGreaterThanOrEqual(0)
		expect(phases["phase:lanes"]).toBeGreaterThanOrEqual(0)
		expect(phases.episodic).toBeGreaterThanOrEqual(0)
	})

	it("attributes the always-on result processing phases", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "result processing phase probe",
		})
		mocked(searchEpisodes).mockResolvedValue([])

		const result = await searchV2(fakeDb, fakePrefix, "espresso", "agent-1", {
			availablePaths: new Set(["episodic"]),
			searchOptions: { allowHybridBackstop: false },
		})

		expect(Object.keys(result.metadata.latencyByPath ?? {})).toEqual(
			expect.arrayContaining([
				"phase:result-normalization",
				"phase:heuristic-rerank",
				"phase:post-retrieval-scoring",
				"phase:conversation-evidence",
				"phase:temporal-candidate-merge",
				"phase:precision-merge",
				"phase:lane-controls-pre-rerank",
				"phase:final-normalize",
				"phase:projection",
			]),
		)
	})

	it("attributes conditional temporal and turn-precision phases when enabled", async () => {
		const previousTemporalMode =
			process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE
		const previousTurnPrecisionMode =
			process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE
		process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE = "enabled"
		process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE = "enabled"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["episodic"],
				confidence: "high",
				reasoning: "conditional phase probe",
			})
			mocked(searchEpisodes).mockResolvedValue([])

			const result = await searchV2(fakeDb, fakePrefix, "espresso", "agent-1", {
				availablePaths: new Set(["episodic"]),
				searchOptions: { allowHybridBackstop: false },
			})

			expect(result.metadata.latencyByPath).toEqual(
				expect.objectContaining({
					"phase:temporal-coverage": expect.any(Number),
					"phase:turn-precision": expect.any(Number),
				}),
			)
		} finally {
			if (previousTemporalMode === undefined) {
				delete process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE
			} else {
				process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE =
					previousTemporalMode
			}
			if (previousTurnPrecisionMode === undefined) {
				delete process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE
			} else {
				process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE =
					previousTurnPrecisionMode
			}
		}
	})

	it("records phase:rewrite only when query rewriting runs", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "rewrite phase probe",
		})
		mocked(searchEpisodes).mockResolvedValue([])

		const withoutRewrite = await searchV2(
			fakeDb,
			fakePrefix,
			"espresso",
			"agent-1",
			{
				availablePaths: new Set(["episodic"]),
				searchOptions: { allowHybridBackstop: false },
			},
		)
		const withRewrite = await searchV2(
			fakeDb,
			fakePrefix,
			"espresso",
			"agent-1",
			{
				availablePaths: new Set(["episodic"]),
				searchOptions: {
					allowHybridBackstop: false,
					queryRewriteConfig: {
						enabled: true,
						method: "synonym-expansion",
						maxTokens: 32,
					},
				},
			},
		)

		expect(withoutRewrite.metadata.latencyByPath).not.toHaveProperty(
			"phase:rewrite",
		)
		expect(
			withRewrite.metadata.latencyByPath?.["phase:rewrite"],
		).toBeGreaterThanOrEqual(0)
	})

	it("records phase:rerank only when reranking runs", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "rerank phase probe",
		})
		mocked(searchEpisodes).mockResolvedValue([])

		const result = await searchV2(fakeDb, fakePrefix, "espresso", "agent-1", {
			availablePaths: new Set(["episodic"]),
			searchOptions: {
				allowHybridBackstop: false,
				rerankConfig: {
					enabled: true,
					model: "rerank-2.5-lite",
					topN: 5,
					minScore: 0,
					voyageApiKey: "test-key",
				},
			},
		})

		expect(
			result.metadata.latencyByPath?.["phase:rerank"],
		).toBeGreaterThanOrEqual(0)
		expect(
			result.metadata.latencyByPath?.["phase:rerank-input"],
		).toBeGreaterThanOrEqual(0)
	})

	it("attributes post-rerank result controls when reranking succeeds", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "post-rerank controls phase probe",
		})
		mocked(searchEpisodes).mockResolvedValue([])
		mocked(crossEncoderRerank).mockResolvedValue({
			results: [],
			reranked: true,
			latencyMs: 0,
		})

		const result = await searchV2(fakeDb, fakePrefix, "espresso", "agent-1", {
			availablePaths: new Set(["episodic"]),
			searchOptions: {
				allowHybridBackstop: false,
				rerankConfig: {
					enabled: true,
					model: "rerank-2.5-lite",
					topN: 5,
					minScore: 0,
					voyageApiKey: "test-key",
				},
			},
		})

		expect(
			result.metadata.latencyByPath?.["phase:lane-controls-post-rerank"],
		).toBeGreaterThanOrEqual(0)
	})
})

describe("search() phase latency reporting", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
			results,
			reranked: false,
			latencyMs: 0,
		}))
	})

	it("reports the cache check, cache write, total and unaccounted phases", async () => {
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: "miss",
			results: [],
			latency: { exactMs: 4, semanticMs: 11 },
		} as never)
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "phase sink contract",
		})
		mocked(searchEpisodes).mockResolvedValue([
			{
				episodeId: "ep-phase-1",
				title: "Phase probe episode",
				summary: "Evidence so the cache write path runs",
				type: "daily",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timeRange: { start: new Date(), end: new Date() },
				sourceEventCount: 1,
				updatedAt: new Date(),
			},
		])

		const seen: Record<string, number>[] = []
		const manager = buildMockManager()
		await manager.search("what did we discuss?", {
			onLaneLatency: (lanes) => {
				seen.push(lanes)
			},
		})

		expect(seen).toHaveLength(1)
		const phases = seen[0]!
		expect(phases["phase:cache-check"]).toBeGreaterThanOrEqual(0)
		expect(phases["phase:cache-exact"]).toBe(4)
		expect(phases["phase:cache-semantic"]).toBe(11)
		expect(phases["phase:cache-write"]).toBeGreaterThanOrEqual(0)
		expect(phases["phase:total"]).toBeGreaterThanOrEqual(0)
		expect(phases["phase:unaccounted"]).toBeGreaterThanOrEqual(0)
		expect(phases["phase:lanes"]).toBeGreaterThanOrEqual(0)
	})

	it("computes unaccounted as the total minus the measured phases", async () => {
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: "miss",
			results: [],
		} as never)
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "unaccounted contract",
		})
		mocked(searchEpisodes).mockResolvedValue([])

		let phases: Record<string, number> = {}
		const manager = buildMockManager()
		let now = 0
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now++)
		try {
			await manager.search("what did we discuss?", {
				onLaneLatency: (lanes) => {
					phases = lanes
				},
			})
		} finally {
			nowSpy.mockRestore()
		}

		const measuredInsideTotal = [
			"phase:plan",
			"phase:lanes",
			"phase:rewrite",
			"phase:result-normalization",
			"phase:heuristic-rerank",
			"phase:post-retrieval-scoring",
			"phase:conversation-evidence",
			"phase:temporal-coverage",
			"phase:temporal-candidate-merge",
			"phase:turn-precision",
			"phase:precision-merge",
			"phase:lane-controls-pre-rerank",
			"phase:rerank-input",
			"phase:rerank",
			"phase:lane-controls-post-rerank",
			"phase:final-normalize",
			"phase:projection",
			"phase:cache-write",
		].reduce((total, phase) => total + (phases[phase] ?? 0), 0)
		expect(phases["phase:unaccounted"]).toBe(
			Math.max(0, (phases["phase:total"] ?? 0) - measuredInsideTotal),
		)
	})
})

describe("raw-window temporal proximity scoring (P4.4.4)", () => {
	// Two events with identical bodies (equal term-match): `nearOrigin` sits 1
	// day from the inferred window origin (proximity ≈ 6/7), `laterButFar` is
	// the NEWER event (recency tiebreak winner) but 26 days out (proximity 0).
	// Proximity must beat recency when a window is inferred.
	const nearOrigin = {
		eventId: "evt-near-origin",
		body: "deploy discussion",
		role: "user",
		timestamp: new Date("2026-07-21T00:00:00Z"),
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
	}
	const laterButFar = {
		eventId: "evt-later-but-far",
		body: "deploy discussion",
		role: "user",
		timestamp: new Date("2026-08-15T00:00:00Z"),
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
	}
	const windowOrigin = new Date("2026-07-20T00:00:00Z")

	function mockTemporalProbe(options?: { noWindow?: boolean }) {
		mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "high",
			reasoning: "temporal proximity probe",
		})
		mocked(getEventsByTimeRange).mockResolvedValue([
			laterButFar,
			nearOrigin,
		] as never)
		mocked(extractTemporalWindow).mockReturnValue(
			options?.noWindow
				? null
				: {
						origin: windowOrigin,
						scaleDays: 7,
						source: "relative-week",
						matchedToken: "last week",
					},
		)
	}

	async function runProbe(searchOptions?: Record<string, unknown>) {
		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"what happened last week",
			"agent-1",
			{
				availablePaths: new Set(["raw-window"]),
				searchOptions: { allowHybridBackstop: false, ...searchOptions },
			},
		)
		const near = result.results.find((r) => r.path === "events/evt-near-origin")
		const far = result.results.find(
			(r) => r.path === "events/evt-later-but-far",
		)
		return { result, near, far }
	}

	it("ranks the event nearer the window midpoint first at equal term match", async () => {
		mockTemporalProbe()
		const { result, near, far } = await runProbe()
		expect(near).toBeDefined()
		expect(far).toBeDefined()
		expect(result.results[0]?.path).toBe("events/evt-near-origin")
		// Default weight 0.1, proximity delta ≈ 6/7 → score delta ≈ 0.086 plus
		// the 0.01 rank-position effect from the new ordering.
		expect((near?.score ?? 0) - (far?.score ?? 0)).toBeGreaterThan(0.05)
	})

	it("falls back to recency ordering when no window is inferred", async () => {
		mockTemporalProbe({ noWindow: true })
		const { result } = await runProbe()
		expect(result.results[0]?.path).toBe("events/evt-later-but-far")
	})

	it("ignores proximity when the configured weight is 0 (off-switch)", async () => {
		mockTemporalProbe()
		const { result } = await runProbe({
			rerankConfig: { temporalProximityBoost: 0 },
		})
		expect(result.results[0]?.path).toBe("events/evt-later-but-far")
	})

	it("threads the caller-stamped reference date into temporal extraction and time-range resolution (B14)", async () => {
		// B14: without a threaded reference clock, extractTemporalWindow and
		// resolveTimeRangePreset read the wall clock, so two runs of the same
		// benchmark query at different wall-clock times rank differently.
		// The retrieval reference date is searchOptions.questionDate (the
		// clock benchmarks already stamp); both derivations must use it.
		mocked(extractTemporalWindow).mockClear()
		mocked(resolveTimeRangePreset).mockClear()
		const questionDate = new Date("2026-07-22T00:00:00Z")
		mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "high",
			reasoning: "reference clock probe",
			constraints: {
				timeRange: {
					preset: "last-7d",
					hard: false,
					reason: "reference clock probe",
				},
			},
		} as never)
		mocked(getEventsByTimeRange).mockResolvedValue([nearOrigin] as never)
		mocked(resolveTimeRangePreset).mockReturnValue({
			start: new Date("2026-07-15T00:00:00Z"),
			end: questionDate,
		})
		mocked(extractTemporalWindow).mockReturnValue({
			origin: windowOrigin,
			scaleDays: 7,
			source: "relative-week",
			matchedToken: "last week",
		})

		await runProbe({ questionDate })

		expect(mocked(extractTemporalWindow)).toHaveBeenCalledWith(
			"what happened last week",
			questionDate,
		)
		expect(mocked(resolveTimeRangePreset)).toHaveBeenCalledWith(
			"last-7d",
			questionDate,
		)
	})
})

describe("normalizeSinglePathScores (C1: single-lane BM25 normalization)", () => {
	const result = (id: string, score: number): MemorySearchResult =>
		({
			id,
			path: `chunks/${id}`,
			score,
			snippet: `snippet ${id}`,
			source: "conversation",
		}) as MemorySearchResult

	it("normalizes an unbounded lexical (BM25) lane into [0,1] preserving rank order", () => {
		const input = [result("a", 12.4), result("b", 3.1), result("c", 0.4)]
		const normalized = normalizeSinglePathScores(input, ["kb"])

		for (const r of normalized) {
			expect(r.score).toBeGreaterThanOrEqual(0)
			expect(r.score).toBeLessThanOrEqual(1)
		}
		// Strictly monotonic with the BM25 order: a > b > c.
		expect(normalized[0]?.id).toBe("a")
		expect(normalized[1]?.id).toBe("b")
		expect(normalized[2]?.id).toBe("c")
		expect(normalized[0]?.score).toBeGreaterThan(normalized[1]?.score)
		expect(normalized[1]?.score).toBeGreaterThan(normalized[2]?.score)
	})

	it("normalizes every lexical-capable lane, not just kb", () => {
		for (const path of ["memory_evidence", "structured", "active-critical"]) {
			const normalized = normalizeSinglePathScores(
				[result("a", 9.5), result("b", 2.5)],
				[path],
			)
			expect(normalized[0]?.score).toBeLessThanOrEqual(1)
			expect(normalized[0]?.score).toBeGreaterThan(normalized[1]?.score)
		}
	})

	it("leaves an already-[0,1] single lane (vector / server fusion) untouched", () => {
		const input = [result("a", 0.9), result("b", 0.5)]
		const normalized = normalizeSinglePathScores(input, ["kb"])
		expect(normalized.map((r) => r.score)).toEqual([0.9, 0.5])
	})

	it("does not rescale bounded synthetic lanes that can exceed 1 (raw-window P4.4.4)", () => {
		// raw-window assigns max(0.35, 1 - i*0.01 + termBoost + temporalBoost),
		// a synthetic scale bounded near ~1.2 — sigmoid-squashing it would
		// compress the temporal-proximity delta P4.4.4 relies on.
		const input = [result("a", 1.15), result("b", 1.02), result("c", 0.98)]
		const normalized = normalizeSinglePathScores(input, ["raw-window"])
		expect(normalized.map((r) => r.score)).toEqual([1.15, 1.02, 0.98])
	})

	it("does not touch multi-lane results — the RRF block owns that case", () => {
		const input = [result("a", 7.7), result("b", 0.2)]
		const normalized = normalizeSinglePathScores(input, ["kb", "raw-window"])
		expect(normalized.map((r) => r.score)).toEqual([7.7, 0.2])
	})

	it("returns empty for empty", () => {
		expect(normalizeSinglePathScores([], ["kb"])).toEqual([])
	})
})
