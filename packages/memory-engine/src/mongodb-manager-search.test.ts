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
} from "./mongodb-manager.js"
import { crossEncoderRerank } from "./mongodb-reranker.js"
import type { MemorySearchResult } from "./types.js"
import {
	mocked,
	testOperationRunContext,
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

	it("keeps final scores within [0,1] after compounding ranking boosts", async () => {
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "episodic keywords",
		})
		mocked(searchEpisodes).mockResolvedValue([
			{
				episodeId: "ep-boosted",
				title: "Phoenix Release",
				summary: "Phoenix Release planning for Phoenix",
				type: "thread",
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
			"Phoenix Release",
			"agent-1",
			{
				availablePaths: new Set(["episodic"]),
				searchOptions: { allowHybridBackstop: false },
			},
		)

		expect(result.results).toHaveLength(1)
		expect(result.results[0]?.score).toBeGreaterThanOrEqual(0)
		expect(result.results[0]?.score).toBeLessThanOrEqual(1)
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
		const runContext = testOperationRunContext("rerank-failure")

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
				operationRunContext: runContext,
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
