/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
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

describe("P2.1 memory-job worker sweep", () => {
	function buildWorkerManager() {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
			config: { mongodb: { embeddingMode: "automated" } },
			workspaceDir: "/tmp/memongo",
			memoryJobWorkerId: "worker-sweep",
			memoryJobWorkerStopped: true,
			memoryJobWorkerActive: false,
			memoryJobWakeRequested: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobWorkerTimer: null,
			memoryJobOperationContexts: new Map(),
			repairExtractionOutbox: vi.fn(async () => ({
				eventsProcessed: 0,
				jobsCreated: 0,
				jobsReleased: 0,
				eventsFailed: 0,
			})),
		}) as MongoDBMemoryManager & {
			memoryJobWorkerPromise: Promise<void>
		}
	}

	const lifecycle = MongoDBMemoryManager.prototype as unknown as {
		startMemoryJobWorker: (this: MongoDBMemoryManager) => void
		stopMemoryJobWorker: (this: MongoDBMemoryManager) => Promise<void>
		wakeMemoryJobWorker: (this: MongoDBMemoryManager) => void
	}

	async function flushWorker(manager: MongoDBMemoryManager) {
		await (
			manager as MongoDBMemoryManager & {
				memoryJobWorkerPromise: Promise<void>
			}
		).memoryJobWorkerPromise
	}

	it("resolveMemoryJobSweepMs: 30s default with shared runtime, 1s legacy, env override", async () => {
		const { resolveMemoryJobSweepMs } = await import("./mongodb-manager.js")
		vi.stubEnv("MEMONGO_JOB_SWEEP_MS", "")
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "")
		expect(resolveMemoryJobSweepMs()).toBe(1_000)
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		expect(resolveMemoryJobSweepMs()).toBe(30_000)
		vi.stubEnv("MEMONGO_JOB_SWEEP_MS", "5000")
		expect(resolveMemoryJobSweepMs()).toBe(5_000)
		vi.stubEnv("MEMONGO_JOB_SWEEP_MS", "not-a-number")
		expect(resolveMemoryJobSweepMs()).toBe(30_000)
		vi.unstubAllEnvs()
	})

	it("shared runtime: no claim polls while idle; backstop fires at 30s", async () => {
		const { claimMemoryJob } = await import("./mongodb-memory-jobs.js")
		mocked(claimMemoryJob).mockReset()
		mocked(claimMemoryJob).mockResolvedValue(null)
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		vi.stubEnv("MEMONGO_JOB_SWEEP_MS", "")
		vi.useFakeTimers()
		try {
			const manager = buildWorkerManager()
			lifecycle.startMemoryJobWorker.call(manager)
			await flushWorker(manager)
			// Immediate drain on start: exactly one claim attempt.
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(1)

			// No 1s polling anymore: nothing fires for the next ~30s.
			await vi.advanceTimersByTimeAsync(29_999)
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(1)

			// Backstop sweep fires at 30s.
			await vi.advanceTimersByTimeAsync(1)
			await vi.advanceTimersByTimeAsync(0)
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(2)

			await lifecycle.stopMemoryJobWorker.call(manager)
		} finally {
			vi.useRealTimers()
			vi.unstubAllEnvs()
		}
	})

	it("legacy runtime: backstop stays at the 1s poll (flag-off behavior unchanged)", async () => {
		const { claimMemoryJob } = await import("./mongodb-memory-jobs.js")
		mocked(claimMemoryJob).mockReset()
		mocked(claimMemoryJob).mockResolvedValue(null)
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "")
		vi.stubEnv("MEMONGO_JOB_SWEEP_MS", "")
		vi.useFakeTimers()
		try {
			const manager = buildWorkerManager()
			lifecycle.startMemoryJobWorker.call(manager)
			await flushWorker(manager)
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(1)

			await vi.advanceTimersByTimeAsync(999)
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(1)
			await vi.advanceTimersByTimeAsync(1)
			await vi.advanceTimersByTimeAsync(0)
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(2)

			await lifecycle.stopMemoryJobWorker.call(manager)
		} finally {
			vi.useRealTimers()
			vi.unstubAllEnvs()
		}
	})

	it("a write wakes the worker immediately without waiting for the sweep", async () => {
		const { claimMemoryJob } = await import("./mongodb-memory-jobs.js")
		mocked(claimMemoryJob).mockReset()
		mocked(claimMemoryJob).mockResolvedValue(null)
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		vi.stubEnv("MEMONGO_JOB_SWEEP_MS", "")
		vi.useFakeTimers()
		try {
			const manager = buildWorkerManager()
			lifecycle.startMemoryJobWorker.call(manager)
			await flushWorker(manager)
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(1)

			// Wake-on-write: drain happens immediately, no timer advance needed.
			lifecycle.wakeMemoryJobWorker.call(manager)
			await flushWorker(manager)
			expect(mocked(claimMemoryJob).mock.calls.length).toBe(2)

			await lifecycle.stopMemoryJobWorker.call(manager)
		} finally {
			vi.useRealTimers()
			vi.unstubAllEnvs()
		}
	})
})

// ---------------------------------------------------------------------------
// P3.9 extraction worker: K=3 concurrent claims per drain round, per-session
// batched LLM extraction, per-job lease fencing preserved under concurrency.
// ---------------------------------------------------------------------------

describe("P3.9 extraction worker concurrency + session-batched LLM", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeExtractionJob(eventId: string) {
		return {
			jobId: `extraction-${eventId}`,
			jobType: "extraction" as const,
			agentId: "agent-1",
			status: "running" as const,
			createdAt: new Date("2026-04-09T12:00:00.000Z"),
			payload: {
				eventId,
				scope: "agent" as const,
				scopeRef: "agent:agent-1",
			},
			attempts: 1,
			leaseOwner: "worker-1",
			leaseToken: `lease-${eventId}`,
			heartbeatAt: new Date("2026-04-09T12:00:00.000Z"),
			leaseExpiresAt: new Date("2026-04-09T12:01:00.000Z"),
		}
	}

	function makeEventDoc(eventId: string, sessionId?: string) {
		return {
			eventId,
			agentId: "agent-1",
			role: "user" as const,
			body: `Remember this fact from ${eventId}.`,
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			...(sessionId ? { sessionId } : {}),
			scope: "agent" as const,
			scopeRef: "agent:agent-1",
		}
	}

	function makeDrainManager() {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
			client: undefined,
			config: { mongodb: { embeddingMode: "automated" } },
			workspaceDir: "/tmp/memongo",
			memoryJobWorkerId: "worker-1",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobOperationContexts: new Map(),
			repairExtractionOutbox: vi.fn(async () => ({
				eventsProcessed: 0,
				jobsCreated: 0,
				jobsReleased: 0,
				eventsFailed: 0,
			})),
		}) as MongoDBMemoryManager
	}

	const drainLifecycle = MongoDBMemoryManager.prototype as unknown as {
		drainMemoryJobQueue: (this: MongoDBMemoryManager) => Promise<void>
	}

	async function mockJobRunBase(docs: Array<ReturnType<typeof makeEventDoc>>) {
		const { claimMemoryJob, completeClaimedMemoryJob, renewMemoryJobLease } =
			await import("./mongodb-memory-jobs.js")
		const { eventsCollection, entitiesCollection } = await import(
			"./mongodb-schema.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async (filter: { eventId?: string }) =>
				docs.find((doc) => doc.eventId === filter.eventId),
			),
			find: vi.fn(() => ({
				toArray: vi.fn(async () => docs),
			})),
		} as unknown as import("mongodb").Collection)
		mocked(entitiesCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(renewMemoryJobLease).mockResolvedValue(true)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
		return {
			claimMemoryJob,
			completeClaimedMemoryJob,
			renewMemoryJobLease,
			promoteDerivedMemoryFromEvent,
		}
	}

	it("processes up to 3 claimed jobs concurrently per drain round", async () => {
		const docs = [
			makeEventDoc("evt-c1"),
			makeEventDoc("evt-c2"),
			makeEventDoc("evt-c3"),
		]
		const {
			claimMemoryJob,
			completeClaimedMemoryJob,
			promoteDerivedMemoryFromEvent,
		} = await mockJobRunBase(docs)
		mocked(claimMemoryJob)
			.mockResolvedValueOnce(makeExtractionJob("evt-c1"))
			.mockResolvedValueOnce(makeExtractionJob("evt-c2"))
			.mockResolvedValueOnce(makeExtractionJob("evt-c3"))
			.mockResolvedValue(null)
		const started: string[] = []
		let releaseGate: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			releaseGate = () => resolve()
		})
		mocked(promoteDerivedMemoryFromEvent).mockImplementation(
			async (params: { event: { eventId: string } }) => {
				started.push(params.event.eventId)
				await gate
				return { structuredCreated: 0, proceduresCreated: 0, skipped: false }
			},
		)

		const manager = makeDrainManager()
		const drain = drainLifecycle.drainMemoryJobQueue.call(manager)

		// All three promotions start BEFORE any completes — sequential claiming
		// would deadlock here against the gate.
		await vi.waitFor(() => {
			expect(started).toHaveLength(3)
		})
		releaseGate?.()
		await drain

		expect(claimMemoryJob).toHaveBeenCalledTimes(4) // 3 claims + empty poll
		expect(completeClaimedMemoryJob).toHaveBeenCalledTimes(3)
	})

	it("batches LLM fact extraction per session across the round", async () => {
		const enrichment = await import("./mongodb-llm-enrichment.js")
		const provider = {
			name: "mock-provider",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({
					facts: ["shared session fact"],
					qa_pairs: [],
					has_personal_content: true,
				}),
			})),
		}
		const providerSpy = vi
			.spyOn(enrichment, "resolveEnrichmentProvider")
			.mockReturnValue(provider as never)
		try {
			const docs = [
				makeEventDoc("evt-s1a", "session-1"),
				makeEventDoc("evt-s1b", "session-1"),
				makeEventDoc("evt-s2", "session-2"),
			]
			const { claimMemoryJob, promoteDerivedMemoryFromEvent } =
				await mockJobRunBase(docs)
			mocked(claimMemoryJob)
				.mockResolvedValueOnce(makeExtractionJob("evt-s1a"))
				.mockResolvedValueOnce(makeExtractionJob("evt-s1b"))
				.mockResolvedValueOnce(makeExtractionJob("evt-s2"))
				.mockResolvedValue(null)
			mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
				structuredCreated: 1,
				proceduresCreated: 0,
				skipped: false,
			})

			const manager = makeDrainManager()
			await drainLifecycle.drainMemoryJobQueue.call(manager)

			// ONE provider call for the two session-1 events; the session-2
			// singleton keeps its per-event path (no prefetch call).
			expect(provider.chatCompletion).toHaveBeenCalledTimes(1)
			const promoteCalls = mocked(promoteDerivedMemoryFromEvent).mock.calls
			const byEvent = new Map(
				promoteCalls.map((call) => [
					(call[0] as { event: { eventId: string } }).event.eventId,
					call[0] as { prefetchedLlmFacts?: string[] },
				]),
			)
			expect(byEvent.get("evt-s1a")?.prefetchedLlmFacts).toEqual([
				"shared session fact",
			])
			expect(byEvent.get("evt-s1b")?.prefetchedLlmFacts).toEqual([
				"shared session fact",
			])
			expect(byEvent.get("evt-s2")?.prefetchedLlmFacts).toBeUndefined()
		} finally {
			providerSpy.mockRestore()
		}
	})

	it("fences a job that loses its lease mid-batch while its sibling completes", async () => {
		vi.useFakeTimers()
		try {
			const docs = [makeEventDoc("evt-fenced"), makeEventDoc("evt-healthy")]
			const {
				claimMemoryJob,
				completeClaimedMemoryJob,
				renewMemoryJobLease,
				promoteDerivedMemoryFromEvent,
			} = await mockJobRunBase(docs)
			const { failClaimedMemoryJob } = await import("./mongodb-memory-jobs.js")
			mocked(claimMemoryJob)
				.mockResolvedValueOnce(makeExtractionJob("evt-fenced"))
				.mockResolvedValueOnce(makeExtractionJob("evt-healthy"))
				.mockResolvedValue(null)
			// The fenced job's heartbeat renewal fails; the sibling's succeeds.
			mocked(renewMemoryJobLease).mockImplementation(
				async ({ jobId }: { jobId: string }) =>
					jobId !== "extraction-evt-fenced",
			)
			const started: string[] = []
			let releaseGate: (() => void) | undefined
			const gate = new Promise<void>((resolve) => {
				releaseGate = () => resolve()
			})
			mocked(promoteDerivedMemoryFromEvent).mockImplementation(
				async (params: { event: { eventId: string } }) => {
					started.push(params.event.eventId)
					await gate
					return {
						structuredCreated: 1,
						proceduresCreated: 0,
						skipped: false,
					}
				},
			)

			const manager = makeDrainManager()
			const drain = drainLifecycle.drainMemoryJobQueue.call(manager)
			await vi.waitFor(() => {
				expect(started).toHaveLength(2)
			})
			// Both jobs are mid-promotion when the heartbeat interval fires and
			// the fenced job loses its lease.
			await vi.advanceTimersByTimeAsync(20_001)
			releaseGate?.()
			await drain

			const completedJobIds = mocked(completeClaimedMemoryJob).mock.calls.map(
				(call) => (call[0] as { jobId: string }).jobId,
			)
			expect(completedJobIds).toEqual(["extraction-evt-healthy"])
			expect(failClaimedMemoryJob).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("resolveMemoryJobWorkerConcurrency: default 3, env override, clamped", async () => {
		const { resolveMemoryJobWorkerConcurrency } = await import(
			"./mongodb-manager.js"
		)
		vi.stubEnv("MEMONGO_JOB_WORKER_CONCURRENCY", "")
		expect(resolveMemoryJobWorkerConcurrency()).toBe(3)
		vi.stubEnv("MEMONGO_JOB_WORKER_CONCURRENCY", "5")
		expect(resolveMemoryJobWorkerConcurrency()).toBe(5)
		vi.stubEnv("MEMONGO_JOB_WORKER_CONCURRENCY", "not-a-number")
		expect(resolveMemoryJobWorkerConcurrency()).toBe(3)
		vi.stubEnv("MEMONGO_JOB_WORKER_CONCURRENCY", "999")
		expect(resolveMemoryJobWorkerConcurrency()).toBe(16)
		vi.unstubAllEnvs()
	})
})

describe("C3: typed-relation failure surfacing", () => {
	function buildWorkerManager() {
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				workspaceDir: "/tmp/memongo",
				memoryJobWorkerId: "worker-c3",
				memoryJobWorkerStopped: true,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobOperationContexts: new Map(),
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }
		const lifecycle = MongoDBMemoryManager.prototype as unknown as {
			startMemoryJobWorker: (this: MongoDBMemoryManager) => void
			stopMemoryJobWorker: (this: MongoDBMemoryManager) => Promise<void>
		}
		return { manager, lifecycle }
	}

	async function primeExtractionJob() {
		const { claimMemoryJob, completeClaimedMemoryJob, failClaimedMemoryJob } =
			await import("./mongodb-memory-jobs.js")
		const { eventsCollection, entitiesCollection } = await import(
			"./mongodb-schema.js"
		)
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)
		const { extractAndUpsertTypedRelations } = await import(
			"./mongodb-graph.js"
		)
		const { recordProjectionRun } = await import("./mongodb-ops.js")

		// This describe has no file-level beforeEach: clear call history AND
		// implementations explicitly so one test's mocks cannot leak into the
		// next (clearAllMocks elsewhere drops history but not implementations).
		mocked(extractAndUpsertTypedRelations).mockReset()
		mocked(recordProjectionRun).mockClear()
		mocked(claimMemoryJob).mockClear()
		mocked(completeClaimedMemoryJob).mockClear()
		mocked(failClaimedMemoryJob).mockClear()
		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-c3",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				metadata: { eventId: "evt-c3" },
				attempts: 1,
				leaseOwner: "worker-c3",
				leaseToken: "lease-c3",
				heartbeatAt: new Date("2026-04-09T12:01:00.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:02:00.000Z"),
			})
			.mockResolvedValueOnce(null)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)
		mocked(failClaimedMemoryJob).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-c3",
				agentId: "agent-1",
				role: "user",
				body: "Alice reviewed the Bob proposal twice.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			})),
		} as unknown as import("mongodb").Collection)
		mocked(entitiesCollection).mockReturnValue({
			find: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{ entityId: "ent-alice", name: "Alice" },
					{ entityId: "ent-bob", name: "Bob" },
				]),
			})),
		} as unknown as import("mongodb").Collection)
		mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 1,
			proceduresCreated: 0,
			skipped: false,
		})

		return {
			claimMemoryJob,
			completeClaimedMemoryJob,
			failClaimedMemoryJob,
			extractAndUpsertTypedRelations,
			recordProjectionRun,
		}
	}

	function stubEnrichmentEnv() {
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "test-key")
		vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "https://llm.example/v1")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "test-model")
	}

	it("a typed-relation failure fails the job (retry path) instead of completing silently", async () => {
		stubEnrichmentEnv()
		try {
			const {
				completeClaimedMemoryJob,
				failClaimedMemoryJob,
				extractAndUpsertTypedRelations,
				recordProjectionRun,
			} = await primeExtractionJob()
			mocked(extractAndUpsertTypedRelations).mockRejectedValue(
				new Error("relation boom"),
			)
			const { manager, lifecycle } = buildWorkerManager()

			lifecycle.startMemoryJobWorker.call(manager)
			await manager.memoryJobWorkerPromise

			// The failure must surface through the job retry mechanism…
			expect(failClaimedMemoryJob).toHaveBeenCalledWith(
				expect.objectContaining({
					jobId: "extraction-c3",
					error: expect.stringContaining("relation boom"),
				}),
			)
			// …not be swallowed as a silent success…
			expect(completeClaimedMemoryJob).not.toHaveBeenCalled()
			// …and the projection ledger records the failed pass.
			expect(recordProjectionRun).toHaveBeenCalledWith(
				expect.objectContaining({
					run: expect.objectContaining({
						projectionType: "relations",
						status: "failed",
					}),
				}),
			)
			await lifecycle.stopMemoryJobWorker.call(manager)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("a successful typed-relation pass completes and records ok", async () => {
		stubEnrichmentEnv()
		try {
			const {
				completeClaimedMemoryJob,
				failClaimedMemoryJob,
				extractAndUpsertTypedRelations,
				recordProjectionRun,
			} = await primeExtractionJob()
			mocked(extractAndUpsertTypedRelations).mockResolvedValue(2)
			const { manager, lifecycle } = buildWorkerManager()

			lifecycle.startMemoryJobWorker.call(manager)
			await manager.memoryJobWorkerPromise

			expect(completeClaimedMemoryJob).toHaveBeenCalledWith(
				expect.objectContaining({ jobId: "extraction-c3" }),
			)
			expect(failClaimedMemoryJob).not.toHaveBeenCalled()
			expect(recordProjectionRun).toHaveBeenCalledWith(
				expect.objectContaining({
					run: expect.objectContaining({
						projectionType: "relations",
						status: "ok",
						itemsProjected: 2,
					}),
				}),
			)
			await lifecycle.stopMemoryJobWorker.call(manager)
		} finally {
			vi.unstubAllEnvs()
		}
	})
})
