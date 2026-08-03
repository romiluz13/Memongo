/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { checkCache } from "./mongodb-query-cache.js"
import {
	mocked,
	buildMockManager,
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

const { projectEventChunk } = await import("./mongodb-events.js")
const { planRetrieval } = await import("./mongodb-retrieval-planner.js")
const { searchEpisodes } = await import("./mongodb-episodes.js")
const { chunksCollection } = await import("./mongodb-schema.js")

// ---------------------------------------------------------------------------
// P2.3 scope identity unification: writes and reads resolve the SAME
// { scope, scopeRef } from the same hints. Rule: explicit scope wins;
// sessionId/sessionKey implies "session"; otherwise the env-resolved default
// ("agent" unless MEMONGO_SEARCH_DEFAULT_SCOPE overrides it on reads).
// ---------------------------------------------------------------------------

describe("P2.3 scope identity unification", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeWriteManager() {
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

	async function mockWritePath() {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { invalidateQueryCache } = await import("./mongodb-query-cache.js")
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-p23",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(invalidateQueryCache).mockResolvedValue(undefined as never)
		return { writeEvent, invalidateQueryCache }
	}

	// The identity a search actually queried with, observed at the cache seam
	// (checkCache receives the resolved scope/scopeRef before any lane runs).
	async function searchIdentityViaCache(
		opts?: Parameters<MongoDBMemoryManager["search"]>[1],
	): Promise<{ scope: string; scopeRef: string }> {
		mocked(checkCache).mockResolvedValue({
			hit: false,
			tier: "miss",
			results: [],
		} as never)
		mocked(planRetrieval).mockReturnValue({
			paths: ["episodic"],
			confidence: "high",
			reasoning: "p2.3 identity probe",
		})
		mocked(searchEpisodes).mockResolvedValue([
			{
				episodeId: "ep-p23",
				title: "probe",
				summary: "evidence so the legacy fallback is skipped",
				type: "daily",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timeRange: { start: new Date(), end: new Date() },
				sourceEventCount: 1,
				updatedAt: new Date(),
			},
		] as never)
		const manager = buildMockManager()
		await manager.search("identity probe", opts)
		const calls = mocked(checkCache).mock.calls
		const call = calls[calls.length - 1]?.[0] as unknown as {
			scope: string
			scopeRef: string
		}
		return { scope: call.scope, scopeRef: call.scopeRef }
	}

	it("write: sessionId with no explicit scope lands in the session scope", async () => {
		const { writeEvent, invalidateQueryCache } = await mockWritePath()
		const manager = makeWriteManager()

		await manager.writeConversationEvent({
			role: "user",
			body: "session-scoped write",
			sessionId: "s1",
		})

		expect(mocked(writeEvent).mock.calls[0]?.[0]).toMatchObject({
			event: expect.objectContaining({ scope: "session", sessionId: "s1" }),
		})
		expect(mocked(invalidateQueryCache)).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "session" }),
		)
	})

	it("write: explicit scope wins over an implicit sessionId", async () => {
		const { writeEvent } = await mockWritePath()
		const manager = makeWriteManager()

		await manager.writeConversationEvent({
			role: "user",
			body: "explicit agent scope with a session id",
			scope: "agent",
			sessionId: "s1",
		})

		expect(mocked(writeEvent).mock.calls[0]?.[0]).toMatchObject({
			event: expect.objectContaining({ scope: "agent" }),
		})
	})

	it("write: bare event still defaults to the agent scope", async () => {
		const { writeEvent } = await mockWritePath()
		const manager = makeWriteManager()

		await manager.writeConversationEvent({
			role: "user",
			body: "plain write",
		})

		expect(mocked(writeEvent).mock.calls[0]?.[0]).toMatchObject({
			event: expect.objectContaining({ scope: "agent" }),
		})
	})

	it("read: sessionKey with no explicit scope queries the session scope", async () => {
		const identity = await searchIdentityViaCache({ sessionKey: "s1" })
		expect(identity).toEqual({ scope: "session", scopeRef: "session:s1" })
	})

	it("read: explicit scope wins over an implicit sessionKey", async () => {
		const identity = await searchIdentityViaCache({
			scope: "agent",
			sessionKey: "s1",
		})
		expect(identity).toEqual({ scope: "agent", scopeRef: "agent:agent-1" })
	})

	it("read: bare search defaults to agent, or MEMONGO_SEARCH_DEFAULT_SCOPE when set", async () => {
		expect(await searchIdentityViaCache()).toEqual({
			scope: "agent",
			scopeRef: "agent:agent-1",
		})

		vi.stubEnv("MEMONGO_SEARCH_DEFAULT_SCOPE", "global")
		try {
			expect(await searchIdentityViaCache()).toEqual({
				scope: "global",
				scopeRef: "global",
			})
			// Precedence proof: the session implication still beats the env default.
			expect(await searchIdentityViaCache({ sessionKey: "s1" })).toEqual({
				scope: "session",
				scopeRef: "session:s1",
			})
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("roundtrip: add({sessionId}) and search({sessionKey}) hit the same partition", async () => {
		const { writeEvent } = await mockWritePath()
		const writeManager = makeWriteManager()
		await writeManager.writeConversationEvent({
			role: "user",
			body: "remember the quokkaberry harvest",
			sessionId: "s1",
		})
		const written = mocked(writeEvent).mock.calls[0]?.[0] as unknown as {
			event: { scope: string; sessionId?: string }
		}

		const read = await searchIdentityViaCache({ sessionKey: "s1" })

		// The write's scope plus the canonical session scopeRef (writeEvent
		// resolves it via the same rule — see mongodb-events.test.ts) must equal
		// the identity the search queried with.
		expect(written.event.scope).toBe(read.scope)
		expect(read.scopeRef).toBe(`session:${written.event.sessionId}`)
	})

	it("searchDetailed: conversationScope.sessionKey implies the session scope", async () => {
		// searchDetailed always injects a searchConfig, so its cache seam is
		// disabled by design (shouldUseDetailedSearchCache) — observe the
		// identity at the conversation-lane pipeline instead.
		mocked(planRetrieval).mockReturnValue({
			paths: ["hybrid"],
			confidence: "high",
			reasoning: "p2.3 searchDetailed identity probe",
		})
		const aggregate = vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		})
		const findArgs: unknown[] = []
		const find = vi.fn((...args: unknown[]) => {
			findArgs.push(args[0])
			return {
				sort: vi.fn().mockReturnThis(),
				limit: vi.fn().mockReturnThis(),
				toArray: vi.fn().mockResolvedValue([]),
			}
		})
		mocked(chunksCollection).mockReturnValue({ aggregate, find } as never)

		// textSearch capability on so the keyword lane actually issues an
		// aggregate carrying the identity filter (all-off capabilities
		// short-circuit every lane before it touches the collection).
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
		await manager.searchDetailed({
			query: "identity probe",
			conversationScope: { sessionKey: "s1" },
		})

		const observed = [
			...aggregate.mock.calls.map((call) => JSON.stringify(call[0])),
			...findArgs.map((filter) => JSON.stringify(filter)),
		]
		expect(observed.length).toBeGreaterThan(0)
		// The identity reaches lane pipelines in two syntaxes: BSON filters
		// (`"scope":"session"`, the legacy/find shape) and $search compound
		// filters (`{"path":"scope","value":"session"}`, the v2 keyword lane).
		// P3.2 made the legacySearch re-run opt-in, so the v2 $search shape is
		// now the one that carries the identity in this probe.
		const carriesSessionIdentity = (payload: string) =>
			(payload.includes('"scope":"session"') &&
				payload.includes('"scopeRef":"session:s1"')) ||
			(payload.includes('"path":"scope","value":"session"') &&
				payload.includes('"path":"scopeRef","value":"session:s1"'))
		expect(observed.some(carriesSessionIdentity)).toBe(true)
	})
})
