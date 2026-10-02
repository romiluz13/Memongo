/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Document } from "mongodb"
import {
	MongoDBMemoryManager,
	searchV2,
	rerankResults,
} from "./mongodb-manager.js"
import {
	DEFAULT_SEARCH_ADMISSION_BURST,
	resetSearchAdmissionForTests,
	tryConsumeSearchAdmission,
} from "./mongodb-search-admission.js"
import { crossEncoderRerank } from "./mongodb-reranker.js"
import type { MemorySearchResult } from "./types.js"
import {
	mocked,
	buildMockManager,
	fakeDb,
	fakePrefix,
	captureManagerPrototype,
	kitMongoConfig,
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

vi.mock("./mongodb-kb-search.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-kb-search.js")>()),
	searchKB: vi.fn(),
}))

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
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
const { searchKB } = await import("./mongodb-kb-search.js")
const { emitTelemetry } = await import("./mongodb-telemetry.js")
const { captureAdmissionToken } = await import("./mongodb-write-fence.js")

// ---------------------------------------------------------------------------
// 8.2b: P3.1/P3.2 search cost — fused lanes, per-search budget, backstop gating
// ---------------------------------------------------------------------------

describe("searchV2 cost controls (P3.1/P3.2)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
			results,
			reranked: false,
			latencyMs: 0,
		}))
	})

	it("fuses conversation and bridge chunk lanes into one embedded search per request (P3.1)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "fusion probe",
		})
		const chunkDoc = {
			path: "events/evt-1",
			startLine: 0,
			endLine: 0,
			text: "fused lane result",
			source: "conversation",
			score: 0.9,
		}
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([chunkDoc]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)

		// Production-shaped filters (same identity + status; only the source
		// set differs) — exactly what the manager's filter builders emit when
		// the caller's identity IS the workspace.
		const conversationFilter = {
			source: { $in: ["conversation", "sessions"] },
			agentId: "agent-1",
			scope: "workspace",
			scopeRef: "workspace:agent-1",
			status: { $ne: "deleted" },
		}
		const bridgeFilter = {
			source: { $in: ["conversation", "memory"] },
			agentId: "agent-1",
			scope: "workspace",
			scopeRef: "workspace:agent-1",
			status: { $ne: "deleted" },
		}

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"fused lane probe",
			"agent-1",
			{
				availablePaths: new Set(["hybrid"]),
				searchOptions: {
					scope: "workspace",
					scopeRef: "workspace:agent-1",
					conversationFilter,
					bridgeFilter,
					capabilities: {
						vectorSearch: true,
						textSearch: true,
						scoreFusion: false,
						rankFusion: true,
						storedSource: false,
						vectorIndexMethod: false,
					},
					fusionMethod: "rankFusion",
					embeddingMode: "automated",
					queryEmbeddingModel: "voyage-4-large",
					allowHybridBackstop: false,
				},
			},
		)

		// ONE fused lane: one aggregation, one server-side embedding (was 2).
		expect(aggregate).toHaveBeenCalledTimes(1)
		const pipeline = aggregate.mock.calls[0]?.[0] as Record<string, any>[]
		const vsStage =
			pipeline[0]?.$rankFusion?.input?.pipelines?.vector?.[0]?.$vectorSearch
		expect(vsStage).toBeDefined()
		expect(vsStage.model).toBe("voyage-4-large")
		expect(vsStage.filter.source.$in).toEqual([
			"conversation",
			"sessions",
			"memory",
		])
		// C-026: the fused chunk lane carries the bitemporal guard — chunks
		// not yet valid (validAt after the reference clock) or already
		// invalidated (invalidAt at or before it) are excluded at the
		// index-adjacent filter; the null arms match legacy chunks that
		// predate the validAt/invalidAt fields.
		expect(vsStage.filter.$and).toEqual([
			{ $or: [{ validAt: null }, { validAt: { $lte: expect.any(Date) } }] },
			{ $or: [{ invalidAt: null }, { invalidAt: { $gt: expect.any(Date) } }] },
		])
		expect(result.metadata.budget?.embeds).toBe(1)
		expect(result.metadata.budget?.aggregations).toBe(1)
		expect(result.results.length).toBeGreaterThan(0)
	})

	it("starts conversation evidence while the primary retrieval lane is still pending", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "parallel evidence probe",
		})
		let releasePrimary: (() => void) | undefined
		const primaryGate = new Promise<void>((resolve) => {
			releasePrimary = resolve
		})
		const chunkAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn(async () => {
				await primaryGate
				return []
			}),
		})
		const evidenceAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		const questionDate = new Date("2026-08-12T12:00:00.000Z")
		mocked(chunksCollection).mockReturnValue({
			aggregate: chunkAggregate,
		} as never)
		mocked(eventsCollection).mockReturnValue({
			aggregate: evidenceAggregate,
		} as never)

		const searchPromise = searchV2(
			fakeDb,
			fakePrefix,
			"What did I say about espresso?",
			"agent-1",
			{
				availablePaths: new Set(["hybrid"]),
				searchOptions: {
					scope: "agent",
					scopeRef: "agent:agent-1",
					conversationFilter: {
						source: { $in: ["conversation"] },
						agentId: "agent-1",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
					capabilities: {
						vectorSearch: true,
						textSearch: false,
						scoreFusion: false,
						rankFusion: false,
						storedSource: true,
						vectorIndexMethod: false,
					},
					embeddingMode: "automated",
					queryEmbeddingModel: "voyage-4-lite",
					conversationEvidenceMode: "parallel",
					questionDate,
					allowHybridBackstop: false,
				},
			},
		)

		await vi.waitFor(() => expect(chunkAggregate).toHaveBeenCalledOnce())
		expect(evidenceAggregate).toHaveBeenCalledOnce()
		const evidencePipeline = evidenceAggregate.mock.calls[0]?.[0]
		expect(evidencePipeline?.[0].$vectorSearch.returnStoredSource).toBe(false)
		expect(evidencePipeline).toEqual(
			expect.arrayContaining([
				{
					$match: {
						$and: [
							{
								$or: [
									{ validAt: { $exists: false } },
									{ validAt: { $lte: questionDate } },
								],
							},
							{
								$or: [
									{ invalidAt: null },
									{ invalidAt: { $gt: questionDate } },
								],
							},
							{
								$or: [
									{ expiresAt: { $exists: false } },
									{ expiresAt: { $gt: expect.any(Date) } },
								],
							},
						],
					},
				},
			]),
		)
		releasePrimary?.()
		await searchPromise
	})

	it("forwards the resolved fusion method to the KB lane", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["kb"],
			confidence: "high",
			reasoning: "reference query",
		})
		mocked(searchKB).mockResolvedValue([])

		await searchV2(fakeDb, fakePrefix, "MongoDB index guide", "agent-1", {
			availablePaths: new Set(["kb"]),
			searchOptions: {
				scope: "agent",
				scopeRef: "agent:agent-1",
				fusionMethod: "js-merge",
				allowHybridBackstop: false,
			},
		})

		expect(searchKB).toHaveBeenCalledOnce()
		expect(searchKB).toHaveBeenCalledWith(
			undefined,
			"MongoDB index guide",
			null,
			expect.objectContaining({ fusionMethod: "js-merge" }),
		)
	})

	it("does not run conversation evidence when conversation retrieval is unavailable", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["kb"],
			confidence: "high",
			reasoning: "reference-only query",
		})
		mocked(searchKB).mockResolvedValue([])
		const evidenceAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(eventsCollection).mockReturnValue({
			aggregate: evidenceAggregate,
		} as never)

		await searchV2(
			fakeDb,
			fakePrefix,
			"What did I say about the reference guide?",
			"agent-1",
			{
				availablePaths: new Set(["kb"]),
				searchOptions: {
					scope: "agent",
					scopeRef: "agent:agent-1",
					conversationEvidenceMode: "parallel",
					allowHybridBackstop: false,
				},
			},
		)

		expect(evidenceAggregate).not.toHaveBeenCalled()
	})

	it("keeps split hybrid sub-lanes when the filters are structurally incompatible", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "incompatible filters probe",
		})
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)

		await searchV2(fakeDb, fakePrefix, "split lanes probe", "agent-1", {
			availablePaths: new Set(["hybrid"]),
			searchOptions: {
				scope: "agent",
				scopeRef: "agent:agent-1",
				conversationFilter: {
					source: { $in: ["conversation"] },
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					status: { $ne: "deleted" },
				},
				// Different identity shape than the conversation filter — must NOT
				// be fused into a lane that would widen or narrow either read.
				bridgeFilter: { agentId: "agent-1", source: { $in: ["files"] } },
				allowHybridBackstop: false,
			},
		})

		expect(aggregate).toHaveBeenCalledTimes(2)
	})

	it("does not fire the recursive hybrid backstop when lane coverage says no data (P3.2)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "low",
			reasoning: "sparse query",
		})
		mocked(searchEpisodes).mockResolvedValue([])
		mocked(getLaneCoverage).mockResolvedValue({
			agentId: "agent-1",
			lanes: {
				hybrid: { count: 0, lastUpdated: null, hasData: false },
			},
			updatedAt: new Date(),
		} as never)
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"qzx sparse marker",
			"agent-1",
			{
				availablePaths: new Set(["episodic", "hybrid"]),
				maxResults: 10,
				searchOptions: {},
			},
		)

		// Empty ≠ error: with lane coverage reporting no hybrid data, the
		// recursive hybrid backstop must not re-run the search.
		expect(result.results).toEqual([])
		expect(aggregate).not.toHaveBeenCalled()
		expect(result.metadata.pathsExecuted).not.toContain("hybrid")
	})

	it("does not fire the recursive hybrid backstop when no coverage document exists", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "low",
			reasoning: "cold tenant",
		})
		mocked(searchEpisodes).mockResolvedValue([])
		mocked(getLaneCoverage).mockResolvedValue(null)
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"qzx cold tenant marker",
			"agent-1",
			{
				availablePaths: new Set(["episodic", "hybrid"]),
				maxResults: 10,
				searchOptions: {},
			},
		)

		expect(result.results).toEqual([])
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("fires the recursive hybrid backstop when lane coverage says data exists", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "low",
			reasoning: "sparse but populated",
		})
		mocked(searchEpisodes).mockResolvedValue([])
		mocked(getLaneCoverage).mockResolvedValue({
			agentId: "agent-1",
			lanes: {
				hybrid: { count: 3, lastUpdated: new Date(), hasData: true },
			},
			updatedAt: new Date(),
		} as never)
		const chunkDoc = {
			path: "events/evt-backstop",
			startLine: 0,
			endLine: 0,
			text: "backstop hit",
			source: "conversation",
			score: 0.9,
		}
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([chunkDoc]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"qzx backstop marker",
			"agent-1",
			{
				availablePaths: new Set(["episodic", "hybrid"]),
				maxResults: 10,
				searchOptions: {},
			},
		)

		expect(aggregate).toHaveBeenCalled()
		expect(result.results.length).toBeGreaterThan(0)
		expect(result.metadata.pathsExecuted).toContain("hybrid")
	})

	it("keeps an empty-corpus sparse query within the aggregation budget (P3.2)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["structured", "hybrid"],
			confidence: "low",
			reasoning: "empty corpus",
		})
		mocked(getLaneCoverage).mockResolvedValue(null)
		const chunksAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		const structuredAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		const proceduresAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({
			aggregate: chunksAggregate,
		} as never)
		mocked(structuredMemCollection).mockReturnValue({
			aggregate: structuredAggregate,
		} as never)
		mocked(proceduresCollection).mockReturnValue({
			aggregate: proceduresAggregate,
			find: vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			}),
		} as never)

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"qzx empty corpus marker",
			"agent-1",
			{
				availablePaths: new Set(["structured", "hybrid", "procedural"]),
				maxResults: 10,
				searchOptions: {},
			},
		)

		const totalAggregations =
			chunksAggregate.mock.calls.length +
			structuredAggregate.mock.calls.length +
			proceduresAggregate.mock.calls.length
		// Was 15+ (6-deep mongoSearch waterfall per lane + procedural backstop +
		// recursive hybrid backstop); now: hybrid fusion (1) + structured
		// vector/$text (2) + gated backstops (0).
		expect(totalAggregations).toBeLessThanOrEqual(6)
		expect(result.results).toEqual([])
		expect(result.metadata.budget).toBeDefined()
		expect(result.metadata.budget?.aggregations ?? 0).toBeLessThanOrEqual(
			totalAggregations,
		)
	})

	it("surfaces accessCount from the raw-window lane so the post-CE boost activates", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "high",
			reasoning: "accessCount probe",
		})
		mocked(getEventsByTimeRange).mockResolvedValue([
			{
				eventId: "evt-hot",
				body: "hot event body",
				role: "user",
				timestamp: new Date("2026-04-01T00:00:00Z"),
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				accessCount: 7,
			},
		] as never)

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"hot event access probe",
			"agent-1",
			{
				availablePaths: new Set(["raw-window"]),
				searchOptions: { allowHybridBackstop: false },
			},
		)

		expect(result.results[0]?.path).toBe("events/evt-hot")
		expect(result.results[0]?.accessCount).toBe(7)
	})

	it("projects accessCount in the turn-precision events lane", async () => {
		const previousMode = process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE
		process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE = "enabled"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["raw-window"],
				confidence: "high",
				reasoning: "accessCount projection probe",
			})
			mocked(getEventsByTimeRange).mockResolvedValue([
				{
					_id: "evt-seed",
					eventId: "evt-seed",
					body: "seed event for session expansion",
					role: "user",
					timestamp: new Date("2023-05-30T10:00:00Z"),
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					sessionId: "sess-projection",
					channel: "default",
				},
			])
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([
					{
						eventId: "evt-turn",
						body: "turn precision hit with reinforcement",
						role: "user",
						sessionId: "sess-projection",
						timestamp: new Date("2023-05-30T10:01:00Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
						score: 0.9,
						accessCount: 11,
					},
				]),
			})
			mocked(eventsCollection).mockReturnValue({ aggregate } as never)

			const result = await searchV2(
				fakeDb,
				fakePrefix,
				"turn precision accessCount probe",
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
					},
				},
			)

			const pipelines = aggregate.mock.calls.map(
				(call) => call[0] as Record<string, any>[],
			)
			const projectStages = pipelines
				.map((pipeline) => pipeline.find((stage) => stage.$project))
				.filter(Boolean)
			expect(projectStages.length).toBeGreaterThan(0)
			for (const project of projectStages) {
				expect(project.$project.accessCount).toBe(1)
			}
			const turnHit = result.results.find(
				(entry) => entry.path === "events/evt-turn",
			)
			expect(turnHit?.accessCount).toBe(11)
		} finally {
			if (previousMode === undefined) {
				delete process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE
			} else {
				process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE = previousMode
			}
		}
	})
})

describe("legacySearch fallback opt-in (P3.2)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns empty without re-running legacySearch when the fallback is not opted in", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: [],
			confidence: "low",
			reasoning: "empty plan",
		})
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)

		const manager = buildMockManager()
		const legacySearch = vi.spyOn(
			manager as unknown as {
				legacySearch(...args: unknown[]): Promise<MemorySearchResult[]>
			},
			"legacySearch",
		)
		const results = await manager.search("qzx legacy opt-out marker")

		// Empty ≠ error: the v2 empty answer stands; legacySearch does not
		// re-run the whole retrieval; the only aggregate is the v2 text query.
		expect(results).toEqual([])
		expect(aggregate).toHaveBeenCalledTimes(1)
		expect(legacySearch).not.toHaveBeenCalled()
	})

	it("runs legacySearch when legacySearchFallback is opted in", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: [],
			confidence: "low",
			reasoning: "empty plan",
		})
		const legacyDoc = {
			path: "memory/legacy.md",
			startLine: 1,
			endLine: 5,
			text: "legacy fallback hit",
			source: "conversation",
			score: 0.9,
		}
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([legacyDoc]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)

		const base = buildMockManager()
		const baseCfg = (
			base as unknown as { config: { mongodb: Record<string, unknown> } }
		).config.mongodb
		const manager = buildMockManager({
			config: {
				mongodb: { ...baseCfg, legacySearchFallback: true },
			},
		})
		const recordSearchAccess = vi.spyOn(
			manager as unknown as { recordSearchAccess(...args: unknown[]): void },
			"recordSearchAccess",
		)
		const results = await manager.search("qzx legacy opt-in marker")
		expect(captureAdmissionToken).toHaveBeenCalledTimes(1)
		expect(recordSearchAccess).toHaveBeenCalledWith(results, {
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})

		expect(aggregate).toHaveBeenCalled()
		expect(results.length).toBeGreaterThan(0)
		expect(results[0]?.snippet).toContain("legacy fallback hit")
	})

	it("preserves the KB restriction in the detailed legacy fallback literal", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: [],
			confidence: "low",
			reasoning: "empty plan",
		})
		vi.mocked(chunksCollection).mockReturnValue({
			aggregate: vi
				.fn()
				.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
		} as never)
		const base = buildMockManager()
		const baseCfg = (
			base as unknown as { config: { mongodb: Record<string, unknown> } }
		).config.mongodb
		const manager = buildMockManager({
			config: {
				mongodb: { ...baseCfg, legacySearchFallback: true },
			},
		})
		const legacySearch = vi
			.spyOn(
				manager as unknown as {
					legacySearch(
						query: string,
						opts?: Record<string, unknown>,
					): Promise<MemorySearchResult[]>
				},
				"legacySearch",
			)
			.mockResolvedValue([])

		await manager.searchDetailed({
			query: "authorization probe",
			kbRestricted: true,
		})

		expect(legacySearch).toHaveBeenCalledWith(
			"authorization probe",
			expect.objectContaining({ kbRestricted: true }),
			expect.objectContaining({
				kind: "admission",
				agentId: "agent-1",
				epoch: 0,
			}),
		)
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

	it("propagates diversity-adjusted scores with provenance stamps (RET-07)", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("event:2", "text2", 0.8, "conversation"),
			makeResult("event:3", "text3", 0.7, "conversation"),
			makeResult("struct:1", "text4", 0.6, "reference"),
		]
		const reranked = rerankResults(results, "query")
		// Audit proof: the 3rd conversation result (0.7) drops below the
		// reference (0.6) under the diversity penalty.
		expect(reranked.map((r) => r.path)).toEqual([
			"event:1",
			"event:2",
			"struct:1",
			"event:3",
		])
		// RET-07: the adjusted scores now travel on the returned results, so
		// the next scoring stage composes on top of the heuristic instead of
		// re-sorting it away.
		expect(reranked[0].score).toBeCloseTo(0.9)
		expect(reranked[0].provenance).toBeUndefined()
		expect(reranked[2].score).toBeCloseTo(0.6)
		expect(reranked[2].provenance).toBeUndefined()
		// Multiplicative penalty: 0.7 * (1 - 0.15 * 1) = 0.595 (B6)
		expect(reranked[3].score).toBeCloseTo(0.595)
		expect(reranked[3].provenance?.heuristicRerankAdjustment).toBeCloseTo(
			-0.105,
		)
	})

	it("keeps RRF-scale scores positive under the diversity penalty (B6)", () => {
		// Regression: an additive 0.15 penalty zeroed every RRF-scale score
		// (~0.016), collapsing the evidence lane after the first two chunks.
		const results = [
			makeResult("chunk:1", "chunk1", 0.016, "reference"),
			makeResult("chunk:2", "chunk2", 0.015, "reference"),
			makeResult("chunk:3", "chunk3", 0.014, "reference"),
			makeResult("struct:1", "entity1", 0.013, "structured"),
		]
		const reranked = rerankResults(results, "query")
		expect(reranked).toHaveLength(4)
		// All four results keep a strictly positive score.
		for (const r of reranked) {
			expect(r.score).toBeGreaterThan(0)
		}
		// Relative order among the penalized chunks is preserved.
		const chunkScores = reranked
			.filter((r) => r.path.startsWith("chunk:"))
			.map((r) => r.score)
		expect(chunkScores).toEqual([...chunkScores].sort((a, b) => b - a))
		// The 3rd reference chunk is dampened proportionally, not zeroed:
		// 0.014 * 0.85 = 0.0119.
		const thirdChunk = reranked.find((r) => r.path === "chunk:3")
		expect(thirdChunk?.score).toBeCloseTo(0.0119, 5)
	})

	it("propagates episode boost scores (RET-07)", () => {
		const results = [
			makeResult("event:1", "text1", 0.9, "conversation"),
			makeResult("episode:ep1", "Episode: summary", 0.8, "conversation"),
		]
		const reranked = rerankResults(results, "query")
		expect(reranked[0].path).toBe("episode:ep1")
		expect(reranked[0].score).toBeCloseTo(0.92)
		expect(reranked[0].provenance?.heuristicRerankAdjustment).toBeCloseTo(0.12)
		expect(reranked[1].score).toBeCloseTo(0.9)
		expect(reranked[1].provenance).toBeUndefined()
	})
})

describe("P3.9 lane-coverage counting is regex-only (no per-candidate findOne)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeManager() {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
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
			memoryJobWorkerStopped: true,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobOperationContexts: new Map(),
			chunkCount: 0,
			dirty: true,
		}) as MongoDBMemoryManager
	}

	it("counts structured candidates without touching the database", async () => {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const {
			extractStructuredCandidatesFromEvent,
			extractProcedureCandidatesFromEvent,
			resolveStructuredCandidatesForPromotion,
		} = await import("./mongodb-derived-memory.js")
		const { eventsCollection, structuredMemCollection } = await import(
			"./mongodb-schema.js"
		)
		const { updateLaneCoverage } = await import("./mongodb-lane-coverage.js")

		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-p39-lane",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue("extraction-evt-p39-lane")
		mocked(claimMemoryJob).mockResolvedValue(null)
		mocked(extractStructuredCandidatesFromEvent).mockReturnValue([
			{
				type: "fact",
				key: "fact-a",
				value: "deployment is blocked",
				confidence: 0.9,
				source: "session",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				salience: "critical",
				promotionPolicy: "immediate",
			},
			{
				type: "preference",
				key: "pref-a",
				value: "prefers tabs",
				confidence: 0.8,
				source: "user",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				promotionPolicy: "requires-reinforcement",
			},
		] as never)
		mocked(extractProcedureCandidatesFromEvent).mockReturnValue([
			{ procedureId: "procedure-a" },
		] as never)

		const manager = makeManager()
		await manager.writeConversationEvent({
			role: "assistant",
			body: "Remember this: deployment is blocked. Procedure for deploys: 1) build 2) ship.",
			scope: "agent",
		})

		// Regex-only counting: the DB-touching promotion resolver and its
		// per-candidate findOne existence checks stay off the write path.
		expect(resolveStructuredCandidatesForPromotion).not.toHaveBeenCalled()
		expect(structuredMemCollection).not.toHaveBeenCalled()
		expect(eventsCollection).not.toHaveBeenCalled()
		expect(extractStructuredCandidatesFromEvent).toHaveBeenCalled()
		expect(updateLaneCoverage).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				increments: {
					"raw-window": 1,
					hybrid: 0,
					structured: 2,
					"active-critical": 1,
					procedural: 1,
				},
			}),
		)
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
			config: kitMongoConfig({
				numCandidates: 500,
				cache: {
					enabled: false,
					conversationTtlSec: 300,
					kbTtlSec: 600,
				},
				episodes: { enabled: false, minEventsForEpisode: 6 },
			}),
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
		// P2.8: maxResults is clamped to the 100 ceiling at the manager entry
		// point, so a top-200 request scales numCandidates from the clamped
		// top-k (100 * 20), not the requested 200.
		expect(top200.metadata.resolvedSearchConfig?.numCandidates).toBe(2000)
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
			config: kitMongoConfig({
				recallProfile: "proof",
				numCandidates: 200,
				cache: {
					enabled: false,
					conversationTtlSec: 300,
					kbTtlSec: 600,
				},
				episodes: { enabled: false, minEventsForEpisode: 6 },
			}),
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
			config: kitMongoConfig({
				numCandidates: 500,
				cache: {
					enabled: false,
					conversationTtlSec: 300,
					kbTtlSec: 600,
				},
				episodes: { enabled: false, minEventsForEpisode: 6 },
			}),
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

	it("keeps default agent searches out of workspace bridge chunks", async () => {
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
		const pipeline = chunksAggregate.mock.calls[0]?.[0] as Record<string, any>[]
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
			expect(pipeline?.[0]?.$search?.compound?.filter).toEqual(
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
			detectSearchMethod: MongoDBMemoryManager.prototype.detectSearchMethod,
		}
		return MongoDBMemoryManager.prototype.resolveObservedSearchMethod.call(
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

// ---------------------------------------------------------------------------
// #66 step 3: per-lane latency instrumentation
// ---------------------------------------------------------------------------

describe("searchV2 lane latency instrumentation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
			results,
			reranked: false,
			latencyMs: 0,
		}))
	})

	it("records a latency sample for every executed lane, including one that fails", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic", "raw-window"],
			confidence: "high",
			reasoning: "latency probe",
		})
		mocked(searchEpisodes).mockRejectedValue(new Error("episodic broke"))
		mocked(getEventsByTimeRange).mockResolvedValue([])

		const result = await searchV2(
			fakeDb,
			fakePrefix,
			"what happened recently",
			"agent-1",
			{
				availablePaths: new Set(["episodic", "raw-window"]),
				searchOptions: { allowHybridBackstop: false },
			},
		)

		expect(
			Object.keys(result.metadata.latencyByPath ?? {})
				.filter((key) => !key.startsWith("phase:"))
				.toSorted(),
		).toEqual(["episodic", "raw-window"])
		expect(result.metadata.latencyByPath?.episodic).toBeGreaterThanOrEqual(0)
		expect(
			result.metadata.latencyByPath?.["raw-window"],
		).toBeGreaterThanOrEqual(0)
	})

	it("records a latency sample for each enabled hybrid sub-lane", async () => {
		const previousSessionMode = process.env.MEMONGO_SESSION_EVIDENCE_MODE
		const previousMirrorMode = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		process.env.MEMONGO_SESSION_EVIDENCE_MODE = "B"
		process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["hybrid"],
				confidence: "high",
				reasoning: "hybrid sub-lane latency probe",
			})
			const emptyAggregate = () =>
				({
					aggregate: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}) as never
			mocked(chunksCollection).mockReturnValue(emptyAggregate())
			mocked(sessionChunksCollection).mockReturnValue(emptyAggregate())
			mocked(memoryEvidenceCollection).mockReturnValue(emptyAggregate())

			const result = await searchV2(fakeDb, fakePrefix, "espresso", "agent-1", {
				availablePaths: new Set(["hybrid"]),
				searchOptions: {
					scope: "agent",
					scopeRef: "agent:agent-1",
					bridgeFilter: { agentId: "agent-1", source: { $in: ["files"] } },
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

			const laneKeys = Object.keys(result.metadata.latencyByPath ?? {})
			expect(laneKeys).toContain("hybrid:chunks")
			expect(laneKeys).toContain("hybrid:bridge")
			expect(laneKeys).toContain("hybrid:session_chunks")
			expect(laneKeys).toContain("hybrid:memory_evidence")
		} finally {
			if (previousSessionMode === undefined) {
				delete process.env.MEMONGO_SESSION_EVIDENCE_MODE
			} else {
				process.env.MEMONGO_SESSION_EVIDENCE_MODE = previousSessionMode
			}
			if (previousMirrorMode === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previousMirrorMode
			}
		}
	})

	it("search() hands the lane breakdown to the caller's onLaneLatency sink", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "sink contract",
		})
		mocked(searchEpisodes).mockResolvedValue([])

		const seen: Record<string, number>[] = []
		const manager = buildMockManager()
		await manager.search("what did we discuss?", {
			onLaneLatency: (lanes) => {
				seen.push(lanes)
			},
		})

		expect(seen).toHaveLength(1)
		expect(seen[0].episodic).toBeGreaterThanOrEqual(0)
	})
})

// ---------------------------------------------------------------------------
// Tests: WS-11 admission envelope at the manager boundary
// searchV2 is real here (only its collaborators are module-mocked), so the
// process-level admission bucket gates these calls exactly as in production.
// ---------------------------------------------------------------------------

describe("search admission envelope at the manager boundary (WS-11)", () => {
	const originalRpm = process.env.MEMONGO_SEARCH_ADMISSION_RPM

	beforeEach(() => {
		vi.clearAllMocks()
		// RPM=1 makes the refill rate ~0 for the test duration, so a denial
		// verdict cannot race the clock between the drain loop below and the
		// search's internal Date.now() read. emitTelemetry is module-mocked
		// above, so no telemetry env toggle is needed.
		process.env.MEMONGO_SEARCH_ADMISSION_RPM = "1"
		resetSearchAdmissionForTests(Date.now())
	})

	afterEach(() => {
		if (originalRpm === undefined) {
			delete process.env.MEMONGO_SEARCH_ADMISSION_RPM
		} else {
			process.env.MEMONGO_SEARCH_ADMISSION_RPM = originalRpm
		}
		// Re-fill the bucket for whatever describe runs next in this worker.
		resetSearchAdmissionForTests(Date.now())
	})

	function exhaustBucket(): void {
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++) {
			tryConsumeSearchAdmission(Date.now())
		}
	}

	function lastSearchModeOf(manager: MongoDBMemoryManager): string {
		return (manager as unknown as { lastSearchMode: string }).lastSearchMode
	}

	/** Empty v2 plan + chunks aggregate that records any legacy lane. */
	function primeEmptySearch(): ReturnType<typeof vi.fn> {
		mocked(planRetrieval).mockReturnValue({
			paths: [],
			confidence: "low",
			reasoning: "empty plan",
		})
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)
		return aggregate
	}

	it("search() marks v2:throttled and skips the opted-in legacy re-run on denial", async () => {
		exhaustBucket()
		const aggregate = primeEmptySearch()
		const base = buildMockManager()
		const baseCfg = (
			base as unknown as { config: { mongodb: Record<string, unknown> } }
		).config.mongodb
		const manager = buildMockManager({
			config: {
				mongodb: { ...baseCfg, legacySearchFallback: true },
			},
		})

		const results = await manager.search("qzx throttle envelope")

		// The throttle verdict is final: no v2 lanes ran, and the opted-in
		// legacy re-run (which would pay a second token) never fires.
		expect(results).toEqual([])
		expect(aggregate).not.toHaveBeenCalled()
		expect(lastSearchModeOf(manager)).toBe("v2:throttled")
	})

	it("search() makes the opted-in legacy re-run pay its own admission token", async () => {
		// Pin the burst at 2 (the burst fallback scales with RPM, so RPM=1
		// alone would leave exactly 1 token): reset gives 2 tokens, the
		// drain below removes one, the admitted v2 search takes the last,
		// and the opted-in legacy re-run hits a dry bucket.
		const originalBurst = process.env.MEMONGO_SEARCH_ADMISSION_BURST
		process.env.MEMONGO_SEARCH_ADMISSION_BURST = "2"
		try {
			resetSearchAdmissionForTests(Date.now())
			tryConsumeSearchAdmission(Date.now())
			const aggregate = primeEmptySearch()
			const base = buildMockManager()
			const baseCfg = (
				base as unknown as { config: { mongodb: Record<string, unknown> } }
			).config.mongodb
			const manager = buildMockManager({
				config: {
					mongodb: { ...baseCfg, legacySearchFallback: true },
				},
			})

			const legacySearch = vi.spyOn(
				manager as unknown as {
					legacySearch(...args: unknown[]): Promise<MemorySearchResult[]>
				},
				"legacySearch",
			)
			const results = await manager.search("qzx legacy token envelope")

			// v2 was admitted and returned its (healthy) empty answer; the
			// legacy re-run was denied and left that answer standing with
			// the marker.
			expect(results).toEqual([])
			expect(aggregate).toHaveBeenCalledTimes(1)
			expect(legacySearch).not.toHaveBeenCalled()
			expect(lastSearchModeOf(manager)).toBe("v2:empty->legacy-throttled")
		} finally {
			if (originalBurst === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_BURST = originalBurst
			}
		}
	})

	it("searchDetailed() short-circuits a throttled response before legacy", async () => {
		exhaustBucket()
		const aggregate = primeEmptySearch()
		const base = buildMockManager()
		const baseCfg = (
			base as unknown as { config: { mongodb: Record<string, unknown> } }
		).config.mongodb
		const manager = buildMockManager({
			config: {
				mongodb: { ...baseCfg, legacySearchFallback: true },
			},
		})

		const response = await manager.searchDetailed({
			query: "qzx detailed throttle",
			maxResults: 10,
		})

		expect(response.results).toEqual([])
		expect(response.metadata.throttled).toBeDefined()
		expect(response.metadata.throttled?.retryAfterMs).toBeGreaterThan(0)
		expect(aggregate).not.toHaveBeenCalled()
		expect(lastSearchModeOf(manager)).toBe("v2:throttled")
	})

	it("searchDetailed() makes the opted-in legacy re-run pay its own admission token", async () => {
		// Pin the burst at 2 (the burst fallback scales with RPM): reset
		// gives 2 tokens, the drain below removes one, the admitted v2
		// search takes the last, and the opted-in legacy re-run hits a dry
		// bucket — mirroring the search() legacy-token test at this seam.
		const originalBurst = process.env.MEMONGO_SEARCH_ADMISSION_BURST
		process.env.MEMONGO_SEARCH_ADMISSION_BURST = "2"
		try {
			resetSearchAdmissionForTests(Date.now())
			tryConsumeSearchAdmission(Date.now())
			const aggregate = primeEmptySearch()
			const base = buildMockManager()
			const baseCfg = (
				base as unknown as { config: { mongodb: Record<string, unknown> } }
			).config.mongodb
			const manager = buildMockManager({
				config: {
					mongodb: { ...baseCfg, legacySearchFallback: true },
				},
			})

			const legacySearch = vi.spyOn(
				manager as unknown as {
					legacySearch(...args: unknown[]): Promise<MemorySearchResult[]>
				},
				"legacySearch",
			)
			const response = await manager.searchDetailed({
				query: "qzx detailed legacy token",
				maxResults: 10,
			})

			expect(response.results).toEqual([])
			expect(response.metadata.throttled).toBeUndefined()
			expect(aggregate).toHaveBeenCalledTimes(1)
			expect(legacySearch).not.toHaveBeenCalled()
			expect(lastSearchModeOf(manager)).toBe("v2:empty->legacy-throttled")
		} finally {
			if (originalBurst === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_BURST = originalBurst
			}
		}
	})

	it("searchDetailed() keeps a healthy empty answer free of the throttle marker", async () => {
		const aggregate = primeEmptySearch()
		const manager = buildMockManager()

		const legacySearch = vi.spyOn(
			manager as unknown as {
				legacySearch(...args: unknown[]): Promise<MemorySearchResult[]>
			},
			"legacySearch",
		)
		const response = await manager.searchDetailed({
			query: "qzx healthy empty",
			maxResults: 10,
		})

		// Empty corpus/plan is a verdict; throttling is an outcome — the
		// manager keeps them distinguishable at the detailed seam too.
		expect(response.results).toEqual([])
		expect(response.metadata.throttled).toBeUndefined()
		expect(aggregate).toHaveBeenCalledTimes(1)
		expect(legacySearch).not.toHaveBeenCalled()
		expect(lastSearchModeOf(manager)).toBe("v2:empty")
	})

	it("searchKB() drops the vector lane on denial and marks kb:throttled", async () => {
		exhaustBucket()
		mocked(searchKB).mockResolvedValue([])
		const manager = buildMockManager({
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
				scoreFusion: false,
			},
		})

		await manager.searchKB("qzx kb throttle")

		expect(captureAdmissionToken).toHaveBeenCalledTimes(1)
		expect(emitTelemetry).toHaveBeenCalledWith(
			fakeDb,
			fakePrefix,
			expect.objectContaining({ throttled: true }),
			{ admission: { kind: "admission", agentId: "agent-1", epoch: 0 } },
		)
		expect(
			vi.mocked(captureAdmissionToken).mock.invocationCallOrder[0],
		).toBeLessThan(Number(vi.mocked(emitTelemetry).mock.invocationCallOrder[0]))

		// Denial degrades ranking (text lane), not completeness: searchKB
		// still runs, with the vector lane explicitly dropped.
		expect(lastSearchModeOf(manager)).toBe("kb:throttled")
		const opts = mocked(searchKB).mock.calls[0]?.[3] as
			| { skipVectorLane?: boolean }
			| undefined
		expect(opts?.skipVectorLane).toBe(true)
	})

	it("searchKB() keeps the vector lane when admission grants a token", async () => {
		mocked(searchKB).mockResolvedValue([])
		const manager = buildMockManager({
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
				scoreFusion: false,
			},
		})

		await manager.searchKB("qzx kb admitted")

		expect(lastSearchModeOf(manager)).not.toBe("kb:throttled")
		const opts = mocked(searchKB).mock.calls[0]?.[3] as
			| { skipVectorLane?: boolean }
			| undefined
		expect(opts?.skipVectorLane).toBeUndefined()
	})
})

describe("search degradation sink at the manager boundary (WS-12, C-019)", () => {
	const originalRpm = process.env.MEMONGO_SEARCH_ADMISSION_RPM

	beforeEach(() => {
		vi.clearAllMocks()
		process.env.MEMONGO_SEARCH_ADMISSION_RPM = "1"
		resetSearchAdmissionForTests(Date.now())
	})

	afterEach(() => {
		if (originalRpm === undefined) {
			delete process.env.MEMONGO_SEARCH_ADMISSION_RPM
		} else {
			process.env.MEMONGO_SEARCH_ADMISSION_RPM = originalRpm
		}
		resetSearchAdmissionForTests(Date.now())
	})

	function exhaustBucket(): void {
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++) {
			tryConsumeSearchAdmission(Date.now())
		}
	}

	function primeEmptySearch(): ReturnType<typeof vi.fn> {
		mocked(planRetrieval).mockReturnValue({
			paths: [],
			confidence: "low",
			reasoning: "empty plan",
		})
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)
		return aggregate
	}

	it("search() fires the sink with the denial marker on admission denial", async () => {
		exhaustBucket()
		const aggregate = primeEmptySearch()
		const manager = buildMockManager()
		const degradations: Array<Record<string, unknown>> = []

		const results = await manager.search("qzx sink denial", {
			onDegradation: (degradation) => degradations.push(degradation),
		})

		expect(results).toEqual([])
		expect(aggregate).not.toHaveBeenCalled()
		// One marker, throttled, with a usable retry hint.
		expect(degradations).toHaveLength(1)
		expect(degradations[0]).toMatchObject({
			kind: "throttled",
			scope: "denied",
		})
		expect(
			(degradations[0]?.retryAfterMs as number | undefined) ?? 0,
		).toBeGreaterThan(0)
	})

	it("search() leaves the sink silent on a healthy empty answer", async () => {
		const aggregate = primeEmptySearch()
		const manager = buildMockManager()
		const degradations: Array<Record<string, unknown>> = []

		const legacySearch = vi.spyOn(
			manager as unknown as {
				legacySearch(...args: unknown[]): Promise<MemorySearchResult[]>
			},
			"legacySearch",
		)
		const results = await manager.search("qzx sink healthy empty", {
			onDegradation: (degradation) => degradations.push(degradation),
		})

		expect(results).toEqual([])
		expect(aggregate).toHaveBeenCalledTimes(1)
		expect(legacySearch).not.toHaveBeenCalled()
		expect(degradations).toHaveLength(0)
	})

	it("search() fires the sink with legacy-fallback-skipped when the double-check is denied", async () => {
		const originalBurst = process.env.MEMONGO_SEARCH_ADMISSION_BURST
		process.env.MEMONGO_SEARCH_ADMISSION_BURST = "2"
		try {
			resetSearchAdmissionForTests(Date.now())
			tryConsumeSearchAdmission(Date.now())
			const aggregate = primeEmptySearch()
			const base = buildMockManager()
			const baseCfg = (
				base as unknown as { config: { mongodb: Record<string, unknown> } }
			).config.mongodb
			const manager = buildMockManager({
				config: {
					mongodb: { ...baseCfg, legacySearchFallback: true },
				},
			})
			const degradations: Array<Record<string, unknown>> = []

			const legacySearch = vi.spyOn(
				manager as unknown as {
					legacySearch(...args: unknown[]): Promise<MemorySearchResult[]>
				},
				"legacySearch",
			)
			const results = await manager.search("qzx sink legacy skipped", {
				onDegradation: (degradation) => degradations.push(degradation),
			})

			expect(results).toEqual([])
			expect(aggregate).toHaveBeenCalledTimes(1)
			expect(legacySearch).not.toHaveBeenCalled()
			expect(degradations).toHaveLength(1)
			expect(degradations[0]).toMatchObject({
				kind: "throttled",
				scope: "legacy-fallback-skipped",
			})
		} finally {
			if (originalBurst === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_BURST = originalBurst
			}
		}
	})

	it("searchKB() fires the sink with vector-lane-skipped on vector-lane denial", async () => {
		exhaustBucket()
		mocked(searchKB).mockResolvedValue([])
		const manager = buildMockManager({
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
				scoreFusion: false,
			},
		})
		const degradations: Array<Record<string, unknown>> = []

		const results = await manager.searchKB("qzx sink kb lane", {
			onDegradation: (degradation) => degradations.push(degradation),
		} as Parameters<typeof manager.searchKB>[1])

		expect(results).toEqual([])
		expect(degradations).toHaveLength(1)
		expect(degradations[0]).toMatchObject({
			kind: "throttled",
			scope: "vector-lane-skipped",
		})
	})

	it("searchKB() leaves the sink silent when admission grants the vector lane", async () => {
		mocked(searchKB).mockResolvedValue([])
		const manager = buildMockManager({
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
				scoreFusion: false,
			},
		})
		const degradations: Array<Record<string, unknown>> = []

		await manager.searchKB("qzx sink kb admitted", {
			onDegradation: (degradation) => degradations.push(degradation),
		} as Parameters<typeof manager.searchKB>[1])

		expect(degradations).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// Tests: WS-16 (C-030) search query clamp at the manager boundary
// searchV2 is real (only collaborators module-mocked), so the clamp runs in
// its production position: trimmed, clamped, THEN handed to planning, embed,
// and rerank lanes.
// ---------------------------------------------------------------------------

describe("search query clamp (C-030)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	/** Empty v2 plan + empty chunks aggregate. */
	function primeEmptySearch(): ReturnType<typeof vi.fn> {
		mocked(planRetrieval).mockReturnValue({
			paths: [],
			confidence: "low",
			reasoning: "empty plan",
		})
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)
		return aggregate
	}

	it("clamps before planning and emits search-query-clamped telemetry", async () => {
		primeEmptySearch()
		const manager = buildMockManager()
		const longQuery = `needle-at-start${"x".repeat(2400)}`

		const results = await manager.search(longQuery)

		expect(results).toEqual([])
		expect(mocked(planRetrieval).mock.calls[0]?.[0]).toHaveLength(2000)
		// The clamp marker fired with the PRE-clamp length so operators can
		// see how far over the ceiling the caller was.
		const clampCall = vi
			.mocked(emitTelemetry)
			.mock.calls.find(
				(call) =>
					(call[2] as { meta?: { operation?: string } }).meta?.operation ===
					"search-query-clamped",
			)
		expect(clampCall?.[3]).toEqual({
			admission: { kind: "admission", agentId: "agent-1", epoch: 0 },
		})
		expect(
			vi.mocked(captureAdmissionToken).mock.invocationCallOrder[0],
		).toBeLessThan(Number(vi.mocked(emitTelemetry).mock.invocationCallOrder[0]))

		expect(clampCall).toBeDefined()
		const [db, prefix, doc] = clampCall as [
			typeof fakeDb,
			string,
			{
				meta?: { agentId?: string; operation?: string }
				ok?: boolean
				queryLength?: number
			},
		]
		expect(db).toBe(fakeDb)
		expect(prefix).toBe(fakePrefix)
		expect(doc.meta).toEqual({
			agentId: "agent-1",
			operation: "search-query-clamped",
		})
		expect(doc.ok).toBe(true)
		expect(doc.queryLength).toBe(longQuery.length)
	})

	it("leaves telemetry silent for in-range queries", async () => {
		primeEmptySearch()
		const manager = buildMockManager()

		await manager.search("qzx in-range clamp marker")

		const clampCalls = vi
			.mocked(emitTelemetry)
			.mock.calls.filter(
				(call) =>
					(call[2] as { meta?: { operation?: string } }).meta?.operation ===
					"search-query-clamped",
			)
		expect(clampCalls).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// Wave 3b (RET-02/RET-06): resolved time ranges and tenant identity reach
// every V2 lane filter — chunk guard arms, session/evidence lanes, the
// evidence pipeline, raw-window and graph bounds, and the default filter
// at the direct-call seam.
// ---------------------------------------------------------------------------

describe("searchV2 resolved time range and chunk identity guards (RET-02/RET-06)", () => {
	const RANGE_START = new Date("2026-08-01T00:00:00.000Z")
	const RANGE_END = new Date("2026-08-10T00:00:00.000Z")
	const FIXED_CLOCK = new Date("2026-08-12T00:00:00.000Z")

	/** One conversation chunk doc so the fused lane returns a result. */
	function primeChunkAggregate(): ReturnType<typeof vi.fn> {
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([
				{
					path: "events/evt-1",
					startLine: 0,
					endLine: 0,
					text: "guard arm probe",
					source: "conversation",
					score: 0.9,
				},
			]),
		})
		mocked(chunksCollection).mockReturnValue({ aggregate } as never)
		return aggregate
	}

	/** Vector-only hybrid probe with an explicit caller range. */
	async function searchWithRange(
		searchOptions: Record<string, unknown>,
		query = "guard arm probe",
		availablePaths: string[] = ["hybrid"],
	) {
		return searchV2(fakeDb, fakePrefix, query, "agent-1", {
			availablePaths: new Set(availablePaths as never),
			searchOptions: {
				embeddingMode: "automated",
				queryEmbeddingModel: "voyage-4-large",
				allowHybridBackstop: false,
				...searchOptions,
			} as never,
		})
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mocked(crossEncoderRerank).mockImplementation(async ({ results }) => ({
			results,
			reranked: false,
			latencyMs: 0,
		}))
	})

	it("arms the fused chunk lane with the explicit-range timestamp guard (RET-02)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "guard probe",
		})
		const aggregate = primeChunkAggregate()

		await searchWithRange({
			scope: "workspace",
			scopeRef: "workspace:agent-1",
			timeRange: { start: RANGE_START, end: RANGE_END },
			conversationFilter: {
				source: { $in: ["conversation", "sessions"] },
				agentId: "agent-1",
				scope: "workspace",
				scopeRef: "workspace:agent-1",
				status: { $ne: "deleted" },
			},
			bridgeFilter: {
				source: { $in: ["conversation", "memory"] },
				agentId: "agent-1",
				scope: "workspace",
				scopeRef: "workspace:agent-1",
				status: { $ne: "deleted" },
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				scoreFusion: false,
				rankFusion: true,
				storedSource: false,
				vectorIndexMethod: false,
			},
			fusionMethod: "rankFusion",
		})

		expect(aggregate).toHaveBeenCalledTimes(1)
		const pipeline = aggregate.mock.calls[0]?.[0] as Document[]
		const vsStage =
			pipeline[0]?.$rankFusion?.input?.pipelines?.vector?.[0]?.$vectorSearch
		expect(vsStage).toBeDefined()
		// C-026 bitemporal arms stay; RET-02 appends the occurrence-time arm
		// with the executor-resolved explicit bounds, so the candidate pool
		// is bounded before ANN traversal instead of being crowded out
		// post-filter.
		expect(vsStage.filter.$and).toEqual([
			{ $or: [{ validAt: null }, { validAt: { $lte: expect.any(Date) } }] },
			{ $or: [{ invalidAt: null }, { invalidAt: { $gt: expect.any(Date) } }] },
			{ timestamp: { $gte: RANGE_START, $lte: RANGE_END } },
		])
	})

	it("keeps inferred preset windows soft — no chunk-lane timestamp arm (RET-02)", async () => {
		const aggregate = primeChunkAggregate()
		mocked(resolveTimeRangePreset).mockReturnValue({
			start: new Date("2026-08-05T00:00:00.000Z"),
			end: new Date("2026-08-12T00:00:00.000Z"),
		})
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "temporal query",
			constraints: {
				timeRange: {
					preset: "last-7d",
					hard: true,
					reason: "explicit last-week constraint",
				},
			},
		})

		await searchWithRange({
			scope: "workspace",
			scopeRef: "workspace:agent-1",
			// No searchOptions.timeRange: the window below is INFERRED from
			// query text by the planner.
			conversationFilter: {
				source: { $in: ["conversation", "sessions"] },
				agentId: "agent-1",
				scope: "workspace",
				scopeRef: "workspace:agent-1",
				status: { $ne: "deleted" },
			},
			capabilities: {
				vectorSearch: true,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			searchConfig: { hybridMode: "vector-only" },
		})

		// The preset DID resolve into the request's timeRange binding…
		expect(resolveTimeRangePreset).toHaveBeenCalledWith(
			"last-7d",
			expect.any(Date),
		)
		// …but Decision 2 keeps inferred windows SOFT: no timestamp arm in
		// the index-adjacent filter. Only the C-026 bitemporal arms ride it.
		const pipeline = aggregate.mock.calls[0]?.[0] as Document[]
		const vsStage = pipeline[0]?.$vectorSearch
		expect(vsStage.filter.$and).toEqual([
			{ $or: [{ validAt: null }, { validAt: { $lte: expect.any(Date) } }] },
			{ $or: [{ invalidAt: null }, { invalidAt: { $gt: expect.any(Date) } }] },
		])
		expect(vsStage.filter.timestamp).toBeUndefined()
	})

	it("prefers searchOptions.resolvedTimeRange over the raw timeRange field (RET-02)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "guard probe",
		})
		const aggregate = primeChunkAggregate()

		await searchWithRange({
			timeRange: {
				start: "2026-01-01T00:00:00.000Z",
				end: "2026-01-31T00:00:00.000Z",
			},
			resolvedTimeRange: { start: RANGE_START, end: RANGE_END },
			conversationFilter: {
				source: { $in: ["conversation"] },
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
			capabilities: {
				vectorSearch: true,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			searchConfig: { hybridMode: "vector-only" },
		})

		const pipeline = aggregate.mock.calls[0]?.[0] as Document[]
		const vsStage = pipeline[0]?.$vectorSearch
		// The manager forwards the executor-resolved bounds as
		// resolvedTimeRange; those win over the raw normalized field.
		expect(vsStage.filter.$and).toEqual(
			expect.arrayContaining([
				{ timestamp: { $gte: RANGE_START, $lte: RANGE_END } },
			]),
		)
	})

	it("derives the default chunk filter from resolved identity and expiry (RET-06)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "guard probe",
		})
		const aggregate = primeChunkAggregate()

		const callStart = new Date()
		await searchWithRange({
			questionDate: FIXED_CLOCK,
			capabilities: {
				vectorSearch: true,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			searchConfig: { hybridMode: "vector-only" },
		})
		const callEnd = new Date()

		const pipeline = aggregate.mock.calls[0]?.[0] as Document[]
		// Clock split invariant: retention (expiresAt) is pruned at wall-now;
		// validity (validAt/invalidAt) keeps the caller's question clock. The
		// same merged filter rides the $vectorSearch prefilter and the
		// post-stage revalidation $match — assert both copies.
		const filters = [
			pipeline[0]?.$vectorSearch?.filter,
			pipeline.find((stage) => stage.$match)?.$match,
		] as Document[]
		for (const filter of filters) {
			expect(filter).toBeDefined()
			expect(filter.$and).toHaveLength(4)
			const identity = filter.$and[0] as Document
			expect(identity.agentId).toBe("agent-1")
			expect(identity.scope).toBe("agent")
			expect(identity.scopeRef).toBe("agent:agent-1")
			expect(identity.source.$in).toEqual(["conversation", "sessions"])
			expect(identity.status).toEqual({ $ne: "deleted" })
			const expiryArm = filter.$and[1] as Document
			expect(expiryArm.$or[0]).toEqual({ expiresAt: { $exists: false } })
			const expiryGt = (expiryArm.$or[1] as Document).expiresAt.$gt as Date
			expect(expiryGt).toBeInstanceOf(Date)
			expect(expiryGt.getTime()).toBeGreaterThanOrEqual(callStart.getTime())
			expect(expiryGt.getTime()).toBeLessThanOrEqual(callEnd.getTime())
			expect(expiryGt.getTime()).not.toBe(FIXED_CLOCK.getTime())
			expect(filter.$and[2]).toEqual({
				$or: [{ validAt: null }, { validAt: { $lte: FIXED_CLOCK } }],
			})
			expect(filter.$and[3]).toEqual({
				$or: [{ invalidAt: null }, { invalidAt: { $gt: FIXED_CLOCK } }],
			})
		}
	})

	it("pins the default chunk filter to the session scope when a sessionKey is present (RET-06)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "guard probe",
		})
		const aggregate = primeChunkAggregate()

		await searchWithRange({
			sessionKey: "sess-9",
			questionDate: FIXED_CLOCK,
			capabilities: {
				vectorSearch: true,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			searchConfig: { hybridMode: "vector-only" },
		})

		const pipeline = aggregate.mock.calls[0]?.[0] as Document[]
		const filter = pipeline[0]?.$vectorSearch?.filter
		const identity = filter.$and[0] as Document
		expect(identity.scope).toBe("session")
		expect(identity.scopeRef).toBe("session:sess-9")
		expect(identity.agentId).toBe("agent-1")
	})

	it("overwrites foreign identity keys on custom chunk filters (RET-06)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "guard probe",
		})
		const aggregate = primeChunkAggregate()

		await searchWithRange({
			conversationFilter: {
				// A foreign-tenant shape — identity keys that would widen the
				// read across scopes if honored.
				source: { $in: ["conversation", "sessions"] },
				agentId: "agent-2",
				scope: "session",
				scopeRef: "session:other-tenant",
				status: { $ne: "deleted" },
			},
			bridgeFilter: {
				source: { $in: ["memory"] },
				agentId: "agent-3",
				scope: "workspace",
				scopeRef: "workspace:agent-3",
				status: { $ne: "deleted" },
			},
			capabilities: {
				vectorSearch: true,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			searchConfig: { hybridMode: "vector-only" },
		})

		// Both custom filters were forced onto the resolved identity, so
		// they still fuse into ONE lane with the union of sources — identity
		// cannot be widened, and the fusion budget is preserved.
		expect(aggregate).toHaveBeenCalledTimes(1)
		const pipeline = aggregate.mock.calls[0]?.[0] as Document[]
		const filter = pipeline[0]?.$vectorSearch?.filter
		expect(filter.agentId).toBe("agent-1")
		expect(filter.scope).toBe("agent")
		expect(filter.scopeRef).toBe("agent:agent-1")
		expect(filter.source.$in).toEqual(["conversation", "sessions", "memory"])
	})

	it("forwards the explicit range into the raw-window lane bounds (RET-02)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["raw-window"],
			confidence: "high",
			reasoning: "temporal query",
			constraints: {
				timeRange: {
					preset: "last-7d",
					hard: true,
					reason: "inferred last-week constraint",
				},
			},
		})
		mocked(resolveTimeRangePreset).mockReturnValue({
			start: new Date("2026-07-01T00:00:00.000Z"),
			end: new Date("2026-07-08T00:00:00.000Z"),
		})
		mocked(getEventsByTimeRange).mockResolvedValue([] as never)

		await searchWithRange(
			{
				timeRange: { start: RANGE_START, end: RANGE_END },
			},
			"what happened in the deployment window",
			["raw-window"],
		)

		// Explicit caller bounds win over both the inferred preset and the
		// 24h fallback default.
		expect(getEventsByTimeRange).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				start: RANGE_START,
				end: RANGE_END,
			}),
		)
	})

	it("prefers the explicit range end for graph expansion asOf (RET-02)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["graph"],
			confidence: "high",
			reasoning: "known entity with temporal constraint",
			constraints: {
				timeRange: {
					preset: "last-7d",
					hard: true,
					reason: "inferred last-week constraint",
				},
				entities: { names: ["Alice"] },
			},
		})
		mocked(resolveTimeRangePreset).mockReturnValue({
			start: new Date("2026-07-01T00:00:00.000Z"),
			end: new Date("2026-07-08T00:00:00.000Z"),
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
		mocked(expandGraph).mockResolvedValue(null)

		await searchV2(
			fakeDb,
			fakePrefix,
			"what did Alice work on last week",
			"agent-1",
			{
				availablePaths: new Set(["graph"]),
				knownEntityNames: ["Alice"],
				searchOptions: {
					allowHybridBackstop: false,
					timeRange: { start: RANGE_START, end: RANGE_END },
				},
			},
		)

		// The bitemporal graph expansion snapshot lands on the explicit
		// range end, not the inferred preset end.
		expect(expandGraph).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "ent-1",
				agentId: "agent-1",
				asOf: RANGE_END,
			}),
		)
	})

	it("caps the conversation-evidence upper bound at the explicit range end (RET-02)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "evidence probe",
		})
		mocked(chunksCollection).mockReturnValue({
			aggregate: vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			}),
		} as never)
		const evidenceAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(eventsCollection).mockReturnValue({
			aggregate: evidenceAggregate,
		} as never)

		await searchV2(
			fakeDb,
			fakePrefix,
			"What did I say about espresso?",
			"agent-1",
			{
				availablePaths: new Set(["hybrid"]),
				searchOptions: {
					scope: "agent",
					scopeRef: "agent:agent-1",
					conversationFilter: {
						source: { $in: ["conversation"] },
						agentId: "agent-1",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
					capabilities: {
						vectorSearch: true,
						textSearch: false,
						scoreFusion: false,
						rankFusion: false,
						storedSource: true,
						vectorIndexMethod: false,
					},
					embeddingMode: "automated",
					queryEmbeddingModel: "voyage-4-lite",
					conversationEvidenceMode: "parallel",
					// AFTER the range end — the range bounds the window.
					questionDate: new Date("2026-08-15T00:00:00.000Z"),
					timeRange: { start: RANGE_START, end: RANGE_END },
					allowHybridBackstop: false,
				},
			},
		)

		expect(evidenceAggregate).toHaveBeenCalledOnce()
		const pipeline = evidenceAggregate.mock.calls[0]?.[0] as Document[]
		const evidenceFilter = pipeline[0]?.$vectorSearch?.filter
		expect(evidenceFilter).toBeDefined()
		expect(evidenceFilter.timestamp).toEqual({
			$gte: RANGE_START,
			$lte: RANGE_END,
		})
	})

	it("caps the conversation-evidence window at questionDate when it precedes the range end (RET-02)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "evidence probe",
		})
		mocked(chunksCollection).mockReturnValue({
			aggregate: vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			}),
		} as never)
		const evidenceAggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		mocked(eventsCollection).mockReturnValue({
			aggregate: evidenceAggregate,
		} as never)
		const questionDate = new Date("2026-08-05T00:00:00.000Z")

		await searchV2(
			fakeDb,
			fakePrefix,
			"What did I say about espresso?",
			"agent-1",
			{
				availablePaths: new Set(["hybrid"]),
				searchOptions: {
					scope: "agent",
					scopeRef: "agent:agent-1",
					conversationFilter: {
						source: { $in: ["conversation"] },
						agentId: "agent-1",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
					capabilities: {
						vectorSearch: true,
						textSearch: false,
						scoreFusion: false,
						rankFusion: false,
						storedSource: true,
						vectorIndexMethod: false,
					},
					embeddingMode: "automated",
					queryEmbeddingModel: "voyage-4-lite",
					conversationEvidenceMode: "parallel",
					// BEFORE the range end — no future leakage past what the
					// user had seen when asking.
					questionDate,
					timeRange: { start: RANGE_START, end: RANGE_END },
					allowHybridBackstop: false,
				},
			},
		)

		expect(evidenceAggregate).toHaveBeenCalledOnce()
		const pipeline = evidenceAggregate.mock.calls[0]?.[0] as Document[]
		const evidenceFilter = pipeline[0]?.$vectorSearch?.filter
		expect(evidenceFilter.timestamp).toEqual({
			$gte: RANGE_START,
			$lte: questionDate,
		})
	})

	it("arms the Option B session-evidence lane timestamp guard (RET-02)", async () => {
		const previousMode = process.env.MEMONGO_SESSION_EVIDENCE_MODE
		process.env.MEMONGO_SESSION_EVIDENCE_MODE = "B"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["hybrid"],
				confidence: "high",
				reasoning: "session lane probe",
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

			await searchWithRange({
				timeRange: { start: RANGE_START, end: RANGE_END },
				capabilities: {
					vectorSearch: true,
					textSearch: false,
					scoreFusion: false,
					rankFusion: false,
					storedSource: false,
					vectorIndexMethod: false,
				},
				searchConfig: { hybridMode: "vector-only" },
			})

			expect(sessionAggregate).toHaveBeenCalled()
			const pipelines = sessionAggregate.mock.calls.map(
				(call) => call[0] as Document[],
			)
			const vectorPipeline = pipelines.find(
				(candidate) => candidate[0]?.$vectorSearch,
			)
			expect(vectorPipeline).toBeDefined()
			const filter = vectorPipeline?.[0]?.$vectorSearch?.filter
			expect(filter.agentId).toBe("agent-1")
			expect(filter.scope).toBe("agent")
			expect(filter.scopeRef).toBe("agent:agent-1")
			// Occurrence-time guard on session evidence docs (first user
			// turn time), same explicit-range semantics as the chunk lanes.
			expect(filter.timestamp).toEqual({
				$gte: RANGE_START,
				$lte: RANGE_END,
			})
		} finally {
			if (previousMode === undefined) {
				delete process.env.MEMONGO_SESSION_EVIDENCE_MODE
			} else {
				process.env.MEMONGO_SESSION_EVIDENCE_MODE = previousMode
			}
		}
	})

	it("arms the memory-evidence lane timestamp guard (RET-02)", async () => {
		const previousSessionMode = process.env.MEMONGO_SESSION_EVIDENCE_MODE
		const previousMirrorMode = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		delete process.env.MEMONGO_SESSION_EVIDENCE_MODE
		process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		try {
			mocked(planRetrieval).mockReturnValue({
				paths: ["hybrid"],
				confidence: "high",
				reasoning: "mirror lane probe",
			})
			mocked(chunksCollection).mockReturnValue({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			} as never)
			const mirrorAggregate = vi.fn().mockReturnValue({
				toArray: vi.fn().mockResolvedValue([]),
			})
			mocked(memoryEvidenceCollection).mockReturnValue({
				aggregate: mirrorAggregate,
			} as never)

			await searchWithRange({
				timeRange: { start: RANGE_START, end: RANGE_END },
				capabilities: {
					vectorSearch: true,
					textSearch: false,
					scoreFusion: false,
					rankFusion: false,
					storedSource: false,
					vectorIndexMethod: false,
				},
				searchConfig: { hybridMode: "vector-only" },
			})

			expect(mirrorAggregate).toHaveBeenCalled()
			const pipelines = mirrorAggregate.mock.calls.map(
				(call) => call[0] as Document[],
			)
			const vectorPipeline = pipelines.find(
				(candidate) => candidate[0]?.$vectorSearch,
			)
			expect(vectorPipeline).toBeDefined()
			const filter = vectorPipeline?.[0]?.$vectorSearch?.filter
			expect(filter.agentId).toBe("agent-1")
			expect(filter.status).toBe("active")
			expect(filter.timestamp).toEqual({
				$gte: RANGE_START,
				$lte: RANGE_END,
			})
		} finally {
			if (previousSessionMode === undefined) {
				delete process.env.MEMONGO_SESSION_EVIDENCE_MODE
			} else {
				process.env.MEMONGO_SESSION_EVIDENCE_MODE = previousSessionMode
			}
			if (previousMirrorMode === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previousMirrorMode
			}
		}
	})
})
