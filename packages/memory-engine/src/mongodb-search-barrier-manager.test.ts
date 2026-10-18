/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { ClientSession, Collection } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { mocked } from "./test-helpers/manager-test-kit.js"

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
vi.mock("./mongodb-episodes.js", async () => ({
	...(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
	checkAutoEpisodeTriggers: vi.fn(),
}))
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
vi.mock("./mongodb-structured-memory.js", () => ({
	writeStructuredMemory: vi.fn(),
}))
vi.mock("./mongodb-procedures.js", () => ({
	writeProcedure: vi.fn(),
}))
vi.mock("./mongodb-search-barrier.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-search-barrier.js")>()),
	assertSearchBarrierTargets: vi.fn(async () => undefined),
	awaitSearchBarrier: vi.fn(),
}))
vi.mock("./mongodb-write-fence.js", () => ({
	readErasureGate: vi.fn(async ({ agentId }: { agentId: string }) => ({
		agentId,
		epoch: 0,
		state: "open",
		serial: 0,
	})),
	isErasureGateConflictError: (error: unknown) =>
		Reflect.get(Object(error), "code") === "ERASURE_GATE_CONFLICT",
	ErasureGateConflictError: class extends Error {
		constructor(message = "erasure gate changed during write") {
			super(message)
			this.name = "ErasureGateConflictError"
		}
	},
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
		kind: "admission" as const,
		agentId,
		epoch: 0,
	})),
	withFencedWrite: vi.fn(
		async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) =>
			fn({ id: "fenced" } as unknown as ClientSession),
	),
}))

const SEARCHABLE = {
	committed: true as const,
	status: "searchable" as const,
	targets: [],
}

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
		writeQueueDepth: 0,
		derivationQueue: Promise.resolve(),
		derivationSchedulingQueue: Promise.resolve(),
		memoryJobWorkerId: "worker-1",
		memoryJobWorkerStopped: false,
		memoryJobWorkerActive: false,
		memoryJobWorkerPromise: Promise.resolve(),
		memoryJobOperationContexts: new Map(),
		chunkCount: 0,
		dirty: true,
		// Post-write derived work is not under test here.
		shouldRunPostWriteDerivedWork: () => false,
		schedulePostWriteDerivations: async () => {},
		scheduleQueryCacheInvalidation: () => {},
	}) as MongoDBMemoryManager
}

async function barrierMocks() {
	const barrier = await import("./mongodb-search-barrier.js")
	const events = await import("./mongodb-events.js")
	const schema = await import("./mongodb-schema.js")
	const fence = await import("./mongodb-write-fence.js")
	mocked(barrier.awaitSearchBarrier).mockResolvedValue(SEARCHABLE)
	mocked(events.writeEvent).mockResolvedValue({
		eventId: "evt-new",
		timestamp: new Date("2026-10-18T10:00:00.000Z"),
		scopeRef: "agent:agent-1",
	})
	mocked(events.projectEventChunk).mockResolvedValue({ chunkCreated: true })
	return { barrier, events, schema, fence }
}

function unsupported(reason: string) {
	return Object.assign(new Error(`search barrier unsupported: ${reason}`), {
		name: "SearchBarrierUnsupportedError",
		code: "BARRIER_UNSUPPORTED",
		reason,
	})
}

describe("event write with a search barrier", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("leaves an ordinary write unchanged: no check, no token, no wait", async () => {
		const { barrier, events } = await barrierMocks()
		const result = await makeManager().writeConversationEvent({
			role: "user",
			body: "ordinary",
			scope: "agent",
		})
		expect(result).toEqual({ eventId: "evt-new", chunkCreated: true })
		expect(barrier.assertSearchBarrierTargets).not.toHaveBeenCalled()
		expect(barrier.awaitSearchBarrier).not.toHaveBeenCalled()
		expect(
			mocked(events.writeEvent).mock.calls[0]?.[0].event,
		).not.toHaveProperty("searchWriteToken")
		expect(
			mocked(events.projectEventChunk).mock.calls[0]?.[0],
		).not.toHaveProperty("searchWriteToken")
	})

	it("checks the event targets first, stamps one token on event and chunk, then waits", async () => {
		const { barrier, events } = await barrierMocks()
		const result = await makeManager().writeConversationEvent(
			{ role: "user", body: "barrier", scope: "agent" },
			undefined,
			{ searchBarrier: { timeoutMs: 3_000 } },
		)
		expect(result).toEqual({
			eventId: "evt-new",
			chunkCreated: true,
			searchBarrier: SEARCHABLE,
		})
		expect(barrier.assertSearchBarrierTargets).toHaveBeenCalledWith(
			expect.objectContaining({ prefix: "test_", family: "event" }),
		)
		const token = mocked(events.writeEvent).mock.calls[0]?.[0].event
			.searchWriteToken
		expect(token).toMatch(/^[0-9a-f]{24}$/)
		expect(mocked(events.projectEventChunk).mock.calls[0]?.[0]).toMatchObject({
			searchWriteToken: token,
		})
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({
				family: "event",
				token,
				request: { timeoutMs: 3_000 },
				projectionFailed: false,
			}),
		)
		expect(
			mocked(barrier.assertSearchBarrierTargets).mock.invocationCallOrder[0],
		).toBeLessThan(mocked(events.writeEvent).mock.invocationCallOrder[0] ?? 0)
	})

	it.each([
		"target-missing",
		"target-not-queryable",
		"target-not-filter-capable",
	])("rejects %s before any write", async (reason) => {
		const { barrier, events, fence } = await barrierMocks()
		mocked(barrier.assertSearchBarrierTargets).mockRejectedValueOnce(
			unsupported(reason),
		)
		await expect(
			makeManager().writeConversationEvent(
				{ role: "user", body: "barrier", scope: "agent" },
				undefined,
				{ searchBarrier: {} },
			),
		).rejects.toMatchObject({ code: "BARRIER_UNSUPPORTED", reason })
		expect(events.writeEvent).not.toHaveBeenCalled()
		expect(events.projectEventChunk).not.toHaveBeenCalled()
		expect(fence.withFencedWrite).not.toHaveBeenCalled()
		expect(barrier.awaitSearchBarrier).not.toHaveBeenCalled()
	})

	it("returns committed projection-failed when the chunk projection fails", async () => {
		const { barrier, events } = await barrierMocks()
		mocked(events.projectEventChunk).mockRejectedValueOnce(
			new Error("chunk write failed"),
		)
		const projectionFailed = {
			committed: true as const,
			status: "not-yet-searchable" as const,
			reason: "projection-failed" as const,
			targets: [],
		}
		mocked(barrier.awaitSearchBarrier).mockResolvedValueOnce(projectionFailed)
		const result = await makeManager().writeConversationEvent(
			{ role: "user", body: "barrier", scope: "agent" },
			undefined,
			{ searchBarrier: {} },
		)
		expect(result.searchBarrier).toEqual(projectionFailed)
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({ projectionFailed: true }),
		)
	})

	it("annotates an uncertain commit and never starts the barrier", async () => {
		const { barrier, events } = await barrierMocks()
		const lost = Object.assign(new Error("connection reset"), {
			name: "MongoNetworkError",
		})
		mocked(events.writeEvent).mockRejectedValueOnce(lost)
		const failure = await makeManager()
			.writeConversationEvent(
				{ role: "user", body: "barrier", scope: "agent" },
				undefined,
				{ searchBarrier: {} },
			)
			.catch((err: unknown) => err)
		expect(failure).toBe(lost)
		expect(failure).toHaveProperty("commitState", "unknown")
		expect(barrier.awaitSearchBarrier).not.toHaveBeenCalled()
	})

	it("does not annotate the same failure on an ordinary write", async () => {
		const { events } = await barrierMocks()
		const lost = Object.assign(new Error("connection reset"), {
			name: "MongoNetworkError",
		})
		mocked(events.writeEvent).mockRejectedValueOnce(lost)
		const failure = await makeManager()
			.writeConversationEvent({ role: "user", body: "plain", scope: "agent" })
			.catch((err: unknown) => err)
		expect(failure).toBe(lost)
		expect(failure).not.toHaveProperty("commitState")
	})
})

describe("idempotent event replay with a search barrier", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const STORED = {
		eventId: "evt-original",
		agentId: "agent-1",
		role: "user",
		body: "replayed hello",
		scope: "agent",
		scopeRef: "agent:agent-1",
		idempotencyKey: "key-1",
		timestamp: new Date("2026-10-18T09:00:00.000Z"),
		validAt: new Date("2026-10-18T09:00:00.000Z"),
		searchWriteToken: "aaaaaaaaaaaaaaaaaaaaaaaa",
	}

	function replayCollections(chunkMatched: number) {
		const eventsUpdate = vi.fn(async () => STORED)
		const chunkUpdate = vi.fn(async () => ({
			matchedCount: chunkMatched,
			modifiedCount: chunkMatched,
		}))
		return { eventsUpdate, chunkUpdate }
	}

	async function arrange(chunkMatched: number) {
		const mocks = await barrierMocks()
		const { eventsUpdate, chunkUpdate } = replayCollections(chunkMatched)
		mocked(mocks.schema.eventsCollection).mockReturnValue({
			bsonOptions: { ignoreUndefined: false, serializeFunctions: false },
			findOne: vi.fn(async () => STORED),
			findOneAndUpdate: eventsUpdate,
		} as unknown as Collection)
		mocked(mocks.schema.chunksCollection).mockReturnValue({
			updateOne: chunkUpdate,
		} as unknown as Collection)
		return { ...mocks, eventsUpdate, chunkUpdate }
	}

	const replayWrite = () =>
		makeManager().writeConversationEvent(
			{
				role: "user",
				body: "replayed hello",
				scope: "agent",
				idempotencyKey: "key-1",
			},
			undefined,
			{ searchBarrier: {} },
		)

	it("re-stamps a fresh token with token-only updates and probes again", async () => {
		const { barrier, events, eventsUpdate, chunkUpdate } = await arrange(1)
		const result = await replayWrite()
		expect(result).toEqual({
			eventId: "evt-original",
			chunkCreated: false,
			searchBarrier: SEARCHABLE,
		})
		expect(events.writeEvent).not.toHaveBeenCalled()
		const token = mocked(barrier.awaitSearchBarrier).mock.calls[0]?.[0].token
		expect(token).toMatch(/^[0-9a-f]{24}$/)
		expect(token).not.toBe(STORED.searchWriteToken)
		expect(eventsUpdate).toHaveBeenCalledWith(
			{ eventId: "evt-original", agentId: "agent-1" },
			{ $set: { searchWriteToken: token } },
			expect.objectContaining({ session: expect.anything() }),
		)
		expect(chunkUpdate).toHaveBeenCalledWith(
			{ path: "events/evt-original" },
			{ $set: { searchWriteToken: token } },
			expect.objectContaining({ session: expect.anything() }),
		)
		expect(events.projectEventChunk).not.toHaveBeenCalled()
	})

	it("mints a different token on every replay", async () => {
		const { barrier } = await arrange(1)
		await replayWrite()
		await replayWrite()
		const tokens = mocked(barrier.awaitSearchBarrier).mock.calls.map(
			(call) => call[0].token,
		)
		expect(new Set(tokens).size).toBe(2)
	})

	it("re-projects a missing chunk with the fresh token", async () => {
		const { barrier, events } = await arrange(0)
		await replayWrite()
		const token = mocked(barrier.awaitSearchBarrier).mock.calls[0]?.[0].token
		expect(events.projectEventChunk).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({ eventId: "evt-original" }),
				searchWriteToken: token,
				recordRun: false,
			}),
		)
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({ projectionFailed: false }),
		)
	})

	it("returns committed projection-failed when the healing projection fails", async () => {
		const { barrier, events } = await arrange(0)
		mocked(events.projectEventChunk).mockRejectedValueOnce(new Error("down"))
		await replayWrite()
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({ projectionFailed: true }),
		)
	})

	it("replays an ordinary retry without touching the stored token", async () => {
		const { barrier, eventsUpdate, chunkUpdate } = await arrange(1)
		const result = await makeManager().writeConversationEvent({
			role: "user",
			body: "replayed hello",
			scope: "agent",
			idempotencyKey: "key-1",
		})
		expect(result).toEqual({ eventId: "evt-original", chunkCreated: false })
		expect(eventsUpdate).not.toHaveBeenCalled()
		expect(chunkUpdate).not.toHaveBeenCalled()
		expect(barrier.awaitSearchBarrier).not.toHaveBeenCalled()
	})
})

describe("structured and procedure writes with a search barrier", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const STRUCTURED = {
		type: "fact" as const,
		key: "deploy.day",
		value: "Friday",
		agentId: "agent-1",
	}
	const PROCEDURE = {
		procedureId: "rotate-keys",
		name: "Rotate keys",
		steps: ["revoke", "issue"],
		agentId: "agent-1",
		scope: "agent" as const,
		scopeRef: "agent:agent-1",
	}

	it("stamps a structured write and waits on the structured targets", async () => {
		const { barrier } = await barrierMocks()
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		mocked(writeStructuredMemory).mockResolvedValue({
			upserted: true,
			id: "deploy.day",
		})
		const result = await makeManager().writeStructuredMemory(STRUCTURED, {
			searchBarrier: { timeoutMs: 5_000 },
		})
		const token = mocked(writeStructuredMemory).mock.calls[0]?.[0]
			.searchWriteToken
		expect(token).toMatch(/^[0-9a-f]{24}$/)
		expect(result).toEqual({
			upserted: true,
			id: "deploy.day",
			searchBarrier: SEARCHABLE,
		})
		expect(barrier.assertSearchBarrierTargets).toHaveBeenCalledWith(
			expect.objectContaining({ family: "structured" }),
		)
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({
				family: "structured",
				token,
				request: { timeoutMs: 5_000 },
			}),
		)
	})

	it("reports a quarantined structured write as quarantined, without probing", async () => {
		const { barrier } = await barrierMocks()
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		mocked(writeStructuredMemory).mockResolvedValue({
			upserted: false,
			id: "deploy.day",
			quarantined: true,
			matchedPatterns: ["ignore-previous"],
		})
		await makeManager().writeStructuredMemory(STRUCTURED, {
			searchBarrier: {},
		})
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({ family: "structured", quarantined: true }),
		)
	})

	it("probes a stored structured write as not quarantined", async () => {
		const { barrier } = await barrierMocks()
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		mocked(writeStructuredMemory).mockResolvedValue({
			upserted: true,
			id: "deploy.day",
		})
		await makeManager().writeStructuredMemory(STRUCTURED, {
			searchBarrier: {},
		})
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({ family: "structured", quarantined: false }),
		)
	})

	it("stamps a procedure write and waits on the procedure targets", async () => {
		const { barrier } = await barrierMocks()
		const { writeProcedure } = await import("./mongodb-procedures.js")
		mocked(writeProcedure).mockResolvedValue({
			upserted: true,
			id: "rotate-keys",
		})
		const result = await makeManager().writeProcedure(PROCEDURE, {
			searchBarrier: {},
		})
		const token = mocked(writeProcedure).mock.calls[0]?.[0].searchWriteToken
		expect(token).toMatch(/^[0-9a-f]{24}$/)
		expect(result.searchBarrier).toEqual(SEARCHABLE)
		expect(barrier.awaitSearchBarrier).toHaveBeenCalledWith(
			expect.objectContaining({ family: "procedure", token }),
		)
	})

	it("rejects an unsupported structured target before the write", async () => {
		const { barrier } = await barrierMocks()
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		mocked(barrier.assertSearchBarrierTargets).mockRejectedValueOnce(
			unsupported("target-missing"),
		)
		await expect(
			makeManager().writeStructuredMemory(STRUCTURED, { searchBarrier: {} }),
		).rejects.toMatchObject({ reason: "target-missing" })
		expect(writeStructuredMemory).not.toHaveBeenCalled()
	})

	it("rejects an unsupported procedure target before the write", async () => {
		const { barrier } = await barrierMocks()
		const { writeProcedure } = await import("./mongodb-procedures.js")
		mocked(barrier.assertSearchBarrierTargets).mockRejectedValueOnce(
			unsupported("target-not-queryable"),
		)
		await expect(
			makeManager().writeProcedure(PROCEDURE, { searchBarrier: {} }),
		).rejects.toMatchObject({ reason: "target-not-queryable" })
		expect(writeProcedure).not.toHaveBeenCalled()
	})

	it("annotates an uncertain structured commit and skips the barrier", async () => {
		const { barrier } = await barrierMocks()
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const lost = Object.assign(new Error("commit unknown"), {
			hasErrorLabel: (label: string) =>
				label === "UnknownTransactionCommitResult",
		})
		mocked(writeStructuredMemory).mockRejectedValueOnce(lost)
		const failure = await makeManager()
			.writeStructuredMemory(STRUCTURED, { searchBarrier: {} })
			.catch((err: unknown) => err)
		expect(failure).toHaveProperty("commitState", "unknown")
		expect(barrier.awaitSearchBarrier).not.toHaveBeenCalled()
	})

	it("leaves ordinary structured and procedure writes unchanged", async () => {
		const { barrier } = await barrierMocks()
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const { writeProcedure } = await import("./mongodb-procedures.js")
		mocked(writeStructuredMemory).mockResolvedValue({ upserted: true, id: "k" })
		mocked(writeProcedure).mockResolvedValue({ upserted: true, id: "p" })
		const manager = makeManager()
		await expect(manager.writeStructuredMemory(STRUCTURED)).resolves.toEqual({
			upserted: true,
			id: "k",
		})
		await expect(manager.writeProcedure(PROCEDURE)).resolves.toEqual({
			upserted: true,
			id: "p",
		})
		expect(mocked(writeStructuredMemory).mock.calls[0]?.[0]).not.toHaveProperty(
			"searchWriteToken",
		)
		expect(mocked(writeProcedure).mock.calls[0]?.[0]).not.toHaveProperty(
			"searchWriteToken",
		)
		expect(barrier.assertSearchBarrierTargets).not.toHaveBeenCalled()
		expect(barrier.awaitSearchBarrier).not.toHaveBeenCalled()
	})
})
