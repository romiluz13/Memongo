/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	deduplicateSearchResults,
	getActiveSources,
	getActiveSourcesForStatus,
	isConversationEvidenceQuery,
	mergeRankedResultSets,
	MongoDBMemoryManager,
	scorePreferenceGroundingSignalBoost,
	searchV2,
	rerankResults,
} from "./mongodb-manager.js"
import { checkCache, writeCache } from "./mongodb-query-cache.js"
import { crossEncoderRerank } from "./mongodb-reranker.js"
import { rewriteQuery } from "./mongodb-query-rewriter.js"
import { normalizeSinglePathScores } from "./mongodb-search-v2.js"
import type { MemorySearchResult } from "./types.js"
import {
	mocked,
	testBenchmarkRunContext,
	buildMockManager,
	fakeDb,
	fakePrefix,
	captureManagerPrototype,
} from "./test-helpers/manager-test-kit.js"

captureManagerPrototype(MongoDBMemoryManager)

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkQualityContractsModuleMock(importOriginal),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-benchmark-harness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkHarnessModuleMock(),
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

vi.mock("./mongodb-benchmark-readiness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkReadinessModuleMock(),
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

	it("executes planned paths concurrently, not serially", async () => {
		// Most paths pay a server-side embedding round-trip inside
		// $vectorSearch; run serially the loop costs the SUM of its lanes
		// (3.5s measured on Atlas). The first path here refuses to resolve
		// until it has seen the second path start.
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic", "raw-window"],
			confidence: "high",
			reasoning: "concurrency probe",
		})

		let rawWindowStarted = false
		let rawWindowStartedBeforeEpisodicResolved = false
		mocked(getEventsByTimeRange).mockImplementation(async () => {
			rawWindowStarted = true
			return []
		})
		mocked(searchEpisodes).mockImplementation(async () => {
			for (let i = 0; i < 20 && !rawWindowStarted; i++) {
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
			rawWindowStartedBeforeEpisodicResolved = rawWindowStarted
			return []
		})

		await searchV2(fakeDb, fakePrefix, "what happened today", "agent-1", {
			availablePaths: new Set(["episodic", "raw-window"]),
			searchOptions: { allowHybridBackstop: false },
		})

		expect(rawWindowStartedBeforeEpisodicResolved).toBe(true)
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

	it("threads the textSearch capability into the episodic lane lookup (P3.8)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "episodic keywords",
		})
		mocked(searchEpisodes).mockResolvedValue([])

		await searchV2(fakeDb, fakePrefix, "summarize today", "agent-1", {
			availablePaths: new Set(["episodic"]),
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
		})

		expect(searchEpisodes).toHaveBeenCalledWith(
			expect.objectContaining({ textSearchAvailable: true }),
		)

		mocked(searchEpisodes).mockClear()
		await searchV2(fakeDb, fakePrefix, "summarize today", "agent-1", {
			availablePaths: new Set(["episodic"]),
			searchOptions: {
				allowHybridBackstop: false,
				capabilities: {
					vectorSearch: false,
					textSearch: false,
					scoreFusion: false,
					rankFusion: false,
					storedSource: false,
					vectorIndexMethod: false,
				},
			},
		})

		expect(searchEpisodes).toHaveBeenCalledWith(
			expect.objectContaining({ textSearchAvailable: false }),
		)
	})

	it("threads the textSearch capability into the graph lane entity lookup (P3.8)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["graph"],
			confidence: "high",
			reasoning: "known entity detected",
		})
		mocked(searchEntitiesAutocomplete).mockResolvedValue([])

		await searchV2(fakeDb, fakePrefix, "what does Alice work on", "agent-1", {
			availablePaths: new Set(["graph"]),
			knownEntityNames: ["Alice"],
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
		})

		expect(searchEntitiesAutocomplete).toHaveBeenCalledWith(
			expect.objectContaining({ textSearchAvailable: true }),
		)
	})

	it("applies maxTimeMS to the user-driven conversation-evidence $search pipeline (P3.8)", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: [],
			confidence: "low",
			reasoning: "no lanes planned",
		})
		const aggregate = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		mocked(eventsCollection).mockReturnValue({ aggregate } as never)

		await searchV2(
			fakeDb,
			fakePrefix,
			"what did we discuss about the roadmap?",
			"agent-1",
			{
				availablePaths: new Set(["hybrid"]),
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

		// The conversation-evidence lane matches "did we" and runs a direct
		// $search aggregate that bypasses runSearchAggregateWithRetry.
		expect(aggregate.mock.calls.length).toBeGreaterThan(0)
		for (const call of aggregate.mock.calls) {
			const options = call[1] as { maxTimeMS?: number } | undefined
			expect(typeof options?.maxTimeMS).toBe("number")
			expect(options?.maxTimeMS).toBeGreaterThan(0)
		}
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

	it("passes the configured graph depth into graph expansion", async () => {
		// graph.maxGraphDepth was resolved from config but never reached
		// $graphLookup — every deployment silently ran at the hardcoded default.
		mocked(planRetrieval).mockReturnValue({
			paths: ["graph"],
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
		mocked(expandGraph).mockResolvedValue(null)

		await searchV2(fakeDb, fakePrefix, "what does Alice work on", "agent-1", {
			availablePaths: new Set(["graph"]),
			knownEntityNames: ["Alice"],
			searchOptions: {
				allowHybridBackstop: false,
				graphMaxDepth: 4,
			},
		})

		expect(expandGraph).toHaveBeenCalledWith(
			expect.objectContaining({ maxDepth: 4 }),
		)
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
							// P3.7: isolate the preference-evidence behavior under test
							// from the orthogonal post-CE recency/access boost.
							recencyBoost: 0,
							accessBoost: 0,
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
		expect(vsStage.filter.source.$in).toEqual([
			"conversation",
			"sessions",
			"memory",
		])
		expect(result.metadata.budget?.embeds).toBe(1)
		expect(result.metadata.budget?.aggregations).toBe(1)
		expect(result.results.length).toBeGreaterThan(0)
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
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: "miss",
			results: [],
		})
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
		const results = await manager.search("qzx legacy opt-out marker")

		// Empty ≠ error: the v2 empty answer stands; legacySearch does not
		// re-run the whole retrieval (its chunks aggregate never fires).
		expect(results).toEqual([])
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("runs legacySearch when legacySearchFallback is opted in", async () => {
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: "miss",
			results: [],
		})
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
		const results = await manager.search("qzx legacy opt-in marker")

		expect(aggregate).toHaveBeenCalled()
		expect(results.length).toBeGreaterThan(0)
		expect(results[0]?.snippet).toContain("legacy fallback hit")
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
			memoryJobRunContexts: new Map(),
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
		const writeCacheArgs = mocked(writeCache).mock.calls[0]?.[0]
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

	it("records the reranking toggles in benchmark run identity", () => {
		const previous = {
			enabled: process.env.MEMONGO_RERANKING_ENABLED,
			minScore: process.env.MEMONGO_RERANK_MIN_SCORE,
		}
		process.env.MEMONGO_RERANKING_ENABLED = "false"
		process.env.MEMONGO_RERANK_MIN_SCORE = "0.5"
		try {
			const base = buildMockManager()
			const baseCfg = (
				base as unknown as { config: { mongodb: Record<string, unknown> } }
			).config.mongodb
			const manager = buildMockManager({
				config: {
					mongodb: {
						...baseCfg,
						deploymentProfile: "atlas",
						numDimensions: 1024,
						quantization: "float32",
						sources: {
							conversation: { enabled: true },
							reference: { enabled: true },
							structured: { enabled: true },
						},
						graph: {
							enabled: false,
							maxGraphDepth: 2,
							entityExtraction: { method: "regex", timeoutMs: 1000 },
						},
					},
				},
			})
			const snapshot = (
				manager as unknown as {
					snapshotBenchmarkRunConfiguration: (p: {
						executionProfile: "shipped" | "diagnostic"
						retrievalLane: string
						maxResults: number
						minScore: number
					}) => { settings: Record<string, unknown> }
				}
			).snapshotBenchmarkRunConfiguration({
				executionProfile: "shipped",
				retrievalLane: "native",
				maxResults: 10,
				minScore: 0.01,
			})

			// A rerank-off run must not hash identically to a rerank-on run.
			expect(snapshot.settings["env.MEMONGO_RERANKING_ENABLED"]).toBe("false")
			expect(snapshot.settings["env.MEMONGO_RERANK_MIN_SCORE"]).toBe("0.5")
		} finally {
			for (const [key, value] of [
				["MEMONGO_RERANKING_ENABLED", previous.enabled],
				["MEMONGO_RERANK_MIN_SCORE", previous.minScore],
			] as const) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		}
	})

	it("search() hands the lane breakdown to the caller's onLaneLatency sink", async () => {
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: undefined,
			results: [],
		} as never)
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
		await manager.search("what did we discuss?", {
			onLaneLatency: (lanes) => {
				phases = lanes
			},
		})

		const measuredInsideTotal =
			(phases["phase:plan"] ?? 0) +
			(phases["phase:lanes"] ?? 0) +
			(phases["phase:rewrite"] ?? 0) +
			(phases["phase:rerank"] ?? 0) +
			(phases["phase:cache-write"] ?? 0)
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
		expect(normalized[0]!.score).toBeGreaterThan(normalized[1]!.score)
		expect(normalized[1]!.score).toBeGreaterThan(normalized[2]!.score)
	})

	it("normalizes every lexical-capable lane, not just kb", () => {
		for (const path of ["memory_evidence", "structured", "active-critical"]) {
			const normalized = normalizeSinglePathScores(
				[result("a", 9.5), result("b", 2.5)],
				[path],
			)
			expect(normalized[0]!.score).toBeLessThanOrEqual(1)
			expect(normalized[0]!.score).toBeGreaterThan(normalized[1]!.score)
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
