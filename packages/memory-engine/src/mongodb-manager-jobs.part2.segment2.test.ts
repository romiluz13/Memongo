/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	mocked,
	testOperationRunContext,
} from "./test-helpers/manager-test-kit.js"

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

describe("MongoDBMemoryManager background extraction", () => {
	beforeEach(() => {
		vi.clearAllMocks()
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
				memoryJobOperationContexts: new Map(),
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
				memoryJobOperationContexts: new Map(),
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
				memoryJobOperationContexts: new Map(),
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
				memoryJobOperationContexts: new Map(),
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
			writeConcern: { w: "majority", wtimeoutMS: 5000 },
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
				memoryJobOperationContexts: new Map(),
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
				memoryJobOperationContexts: new Map(),
				chunkCount: 0,
				dirty: true,
				benchmarkShippedProfile: true,
			},
		) as MongoDBMemoryManager & {
			derivationQueue: Promise<void>
			derivationSchedulingQueue: Promise<void>
			memoryJobWorkerPromise: Promise<void>
		}
		const runContext = testOperationRunContext("shipped-run")

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
})
