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
	beforeEach(async () => {
		vi.clearAllMocks()
		const { renewMemoryJobLease } = await import("./mongodb-memory-jobs.js")
		mocked(renewMemoryJobLease).mockResolvedValue(true)
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
			entities: [
				{
					entityId: "entity-1",
					name: "Batch F",
					type: "project",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					mentionCount: 1,
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					updatedAt: new Date("2026-04-09T12:00:00.000Z"),
				},
			],
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

	it("marks graph coverage available before a later extraction stage fails", async () => {
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { markLaneAvailable } = await import("./mongodb-lane-coverage.js")
		const {
			claimMemoryJob,
			completeClaimedMemoryJob,
			createMemoryJob,
			failClaimedMemoryJob,
		} = await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)

		mocked(createMemoryJob).mockResolvedValue("extraction-evt-graph")
		mocked(claimMemoryJob)
			.mockResolvedValueOnce({
				jobId: "extraction-evt-graph",
				jobType: "extraction",
				agentId: "agent-1",
				status: "running",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: { eventId: "evt-graph" },
				attempts: 1,
				leaseOwner: "worker-1",
				leaseToken: "lease-graph",
			})
			.mockResolvedValueOnce(null)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-graph",
				agentId: "agent-1",
				role: "user",
				body: "Discuss @Alice before promotion fails.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			})),
		} as unknown as import("mongodb").Collection)
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [
				{
					entityId: "entity-alice",
					name: "Alice",
					type: "person",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					mentionCount: 1,
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					updatedAt: new Date("2026-04-09T12:00:00.000Z"),
				},
			],
			relationsCreated: 0,
		})
		mocked(markLaneAvailable).mockResolvedValue(undefined)
		mocked(promoteDerivedMemoryFromEvent).mockRejectedValue(
			new Error("permanent promotion failure"),
		)
		mocked(failClaimedMemoryJob).mockResolvedValue(true)

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				workspaceDir: "/tmp/memongo",
				memoryJobWorkerId: "worker-1",
				memoryJobWorkerStopped: false,
				memoryJobWorkerPromise: Promise.resolve(),
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

		await manager.extractEvent({ eventId: "evt-graph" })
		await manager.memoryJobWorkerPromise

		expect(markLaneAvailable).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			lane: "graph",
		})
		expect(failClaimedMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "extraction-evt-graph",
				error: "permanent promotion failure",
			}),
		)
		expect(completeClaimedMemoryJob).not.toHaveBeenCalled()
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
				memoryJobOperationContexts: new Map(),
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
				memoryJobOperationContexts: new Map(),
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
			// W19: every stage fence now forces its own server-side renewal, so
			// the renewal chain is: post-prefetch revalidation, entity-stage
			// fence, promote-stage fence (all healthy while promotion runs),
			// then the lease is LOST — the periodic beat during the gated
			// promotion and the terminal-stage fence both see it gone.
			mocked(renewMemoryJobLease)
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true)
				.mockResolvedValue(false)
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
					memoryJobOperationContexts: new Map(),
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
			// W19: every stage fence forces its own server-side renewal —
			// post-prefetch revalidation, entity-stage fence, and promote-stage
			// fence all succeed while the promotion runs; the renewal outcome
			// then becomes UNKNOWN (rejection) during the gated promotion, and
			// both the beat's catch and the terminal-stage fence fail closed.
			mocked(renewMemoryJobLease)
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true)
				.mockRejectedValue(new Error("heartbeat outcome unknown"))
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
					memoryJobOperationContexts: new Map(),
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

	it("fences side-effecting stages when the extraction lease is lost before entity extraction (P2.5 b)", async () => {
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
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			const { getPendingExtractionEvents } = await import("./mongodb-events.js")
			// The worker's outbox-repair pass runs before claiming: keep it empty
			// so no residue from earlier tests' persisted mocks drives writes.
			mocked(getPendingExtractionEvents).mockResolvedValue([])
			mocked(createMemoryJob).mockResolvedValue("extraction-evt-fenced")
			mocked(claimMemoryJob)
				.mockResolvedValueOnce({
					jobId: "extraction-evt-fenced",
					jobType: "extraction",
					agentId: "agent-1",
					status: "running",
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					payload: { eventId: "evt-fenced" },
					attempts: 1,
					leaseOwner: "worker-fenced",
					leaseToken: "lease-fenced",
					heartbeatAt: new Date("2026-04-09T12:00:00.000Z"),
					leaseExpiresAt: new Date("2026-04-09T12:01:00.000Z"),
				})
				.mockResolvedValueOnce(null)
			// The lease renewal fails while the event read is still in flight —
			// the lease is lost BEFORE the first side-effecting stage.
			mocked(renewMemoryJobLease)
				.mockResolvedValueOnce(true)
				.mockResolvedValue(false)
			let resolveEventDoc: ((doc: unknown) => void) | undefined
			const findOne = vi.fn(
				() =>
					new Promise((resolve) => {
						resolveEventDoc = resolve
					}),
			)
			mocked(eventsCollection).mockReturnValue({
				findOne,
			} as unknown as import("mongodb").Collection)

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "agent-1",
					client: undefined,
					config: { mongodb: { embeddingMode: "automated" } },
					workspaceDir: "/tmp/memongo",
					memoryJobWorkerId: "worker-fenced",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobOperationContexts: new Map(),
				},
			) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

			await manager.extractEvent({ eventId: "evt-fenced" })
			await vi.waitFor(() => {
				expect(findOne).toHaveBeenCalled()
			})
			await vi.advanceTimersByTimeAsync(20_001)
			expect(renewMemoryJobLease).toHaveBeenCalledWith(
				expect.objectContaining({
					jobId: "extraction-evt-fenced",
					leaseOwner: "worker-fenced",
					leaseToken: "lease-fenced",
				}),
			)
			resolveEventDoc?.({
				eventId: "evt-fenced",
				agentId: "agent-1",
				role: "user",
				body: "Remember this fenced extraction.",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			})
			await manager.memoryJobWorkerPromise

			// The lease was lost BEFORE the first side-effecting stage, so no
			// entity/derived writes and no terminal write may commit.
			expect(extractAndUpsertEntities).not.toHaveBeenCalled()
			expect(promoteDerivedMemoryFromEvent).not.toHaveBeenCalled()
			expect(completeClaimedMemoryJob).not.toHaveBeenCalled()
			expect(failClaimedMemoryJob).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("abandons the job when the tenant erasure epoch advances before entity extraction (W03)", async () => {
		vi.useFakeTimers()
		try {
			const {
				claimMemoryJob,
				completeClaimedMemoryJob,
				createMemoryJob,
				failClaimedMemoryJob,
				renewMemoryJobLease,
			} = await import("./mongodb-memory-jobs.js")
			const { eventsCollection, metaCollection } = await import(
				"./mongodb-schema.js"
			)
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			const { getPendingExtractionEvents } = await import("./mongodb-events.js")
			// The worker's outbox-repair pass runs before claiming: keep it empty
			// so no residue from earlier tests' persisted mocks drives writes.
			mocked(getPendingExtractionEvents).mockResolvedValue([])
			mocked(createMemoryJob).mockResolvedValue("extraction-evt-epoch")
			mocked(claimMemoryJob)
				.mockResolvedValueOnce({
					jobId: "extraction-evt-epoch",
					jobType: "extraction",
					agentId: "agent-1",
					status: "running",
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					payload: { eventId: "evt-epoch" },
					attempts: 1,
					leaseOwner: "worker-epoch",
					leaseToken: "lease-epoch",
					heartbeatAt: new Date("2026-04-09T12:00:00.000Z"),
					leaseExpiresAt: new Date("2026-04-09T12:01:00.000Z"),
				})
				.mockResolvedValueOnce(null)
			// The lease stays healthy the whole time — ONLY the tenant erasure
			// epoch advances between the claim and the first fence check.
			mocked(renewMemoryJobLease).mockResolvedValue(true)
			mocked(eventsCollection).mockReturnValue({
				findOne: vi.fn(async () => ({
					eventId: "evt-epoch",
					agentId: "agent-1",
					role: "user",
					body: "Remember this pre-erasure extraction.",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					scope: "agent",
					scopeRef: "agent:agent-1",
				})),
			} as unknown as import("mongodb").Collection)
			// First meta read = the claim-time epoch (1); every later read (the
			// fence checks) = 2 — a tenant erasure bumped it after this job was
			// claimed, so the job's source data was swept mid-flight.
			let metaReads = 0
			mocked(metaCollection).mockReturnValue({
				findOne: vi.fn(async () => ({
					_id: "tenant-erasure-epoch:agent-1",
					agentId: "agent-1",
					epoch: ++metaReads === 1 ? 1 : 2,
					updatedAt: new Date("2026-04-09T12:00:05.000Z"),
				})),
			} as unknown as import("mongodb").Collection)

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "agent-1",
					client: undefined,
					config: { mongodb: { embeddingMode: "automated" } },
					workspaceDir: "/tmp/memongo",
					memoryJobWorkerId: "worker-epoch",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobOperationContexts: new Map(),
				},
			) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

			await manager.extractEvent({ eventId: "evt-epoch" })
			await vi.advanceTimersByTimeAsync(20_001)
			await manager.memoryJobWorkerPromise

			// The lease was NEVER lost — the epoch fence alone abandoned the
			// pre-erasure job before any side-effecting stage, so its in-memory
			// event cannot resurrect erased data.
			expect(extractAndUpsertEntities).not.toHaveBeenCalled()
			expect(promoteDerivedMemoryFromEvent).not.toHaveBeenCalled()
			expect(completeClaimedMemoryJob).not.toHaveBeenCalled()
			expect(failClaimedMemoryJob).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
	it("abandons the job when the fence's forced renewal discovers a stolen lease with no periodic beat fired (W19)", async () => {
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
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			const { getPendingExtractionEvents } = await import("./mongodb-events.js")
			// The worker's outbox-repair pass runs before claiming: keep it empty
			// so no residue from earlier tests' persisted mocks drives writes.
			mocked(getPendingExtractionEvents).mockResolvedValue([])
			mocked(createMemoryJob).mockResolvedValue("extraction-evt-w19")
			mocked(claimMemoryJob)
				.mockResolvedValueOnce({
					jobId: "extraction-evt-w19",
					jobType: "extraction",
					agentId: "agent-1",
					status: "running",
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					payload: { eventId: "evt-w19" },
					attempts: 1,
					leaseOwner: "worker-w19",
					leaseToken: "lease-w19",
					heartbeatAt: new Date("2026-04-09T12:00:00.000Z"),
					leaseExpiresAt: new Date("2026-04-09T12:01:00.000Z"),
				})
				.mockResolvedValueOnce(null)
			// No timer is advanced in this test, so NO periodic heartbeat beat
			// ever fires: the in-memory `leaseLost` boolean is still false and
			// `heartbeatInFlight` is a long-resolved promise. Renewal #1 is the
			// post-prefetch ownership revalidation (passes); renewal #2 is the
			// fence's FORCED server-side proof — the lease was stolen between
			// the claim and the first side-effecting stage, and only the forced
			// renewal can see it.
			mocked(renewMemoryJobLease)
				.mockResolvedValueOnce(true)
				.mockResolvedValue(false)
			mocked(eventsCollection).mockReturnValue({
				findOne: vi.fn(async () => ({
					eventId: "evt-w19",
					agentId: "agent-1",
					role: "user",
					body: "A stolen lease must not pass a stale-boolean fence.",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					scope: "agent",
					scopeRef: "agent:agent-1",
				})),
			} as unknown as import("mongodb").Collection)

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "agent-1",
					client: undefined,
					config: { mongodb: { embeddingMode: "automated" } },
					workspaceDir: "/tmp/memongo",
					memoryJobWorkerId: "worker-w19",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobOperationContexts: new Map(),
				},
			) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

			await manager.extractEvent({ eventId: "evt-w19" })
			await manager.memoryJobWorkerPromise

			// Exactly two server-side ownership proofs: the post-prefetch
			// revalidation, then the fence's forced renewal that caught the
			// theft. The fence did NOT trust the stale boolean.
			expect(renewMemoryJobLease).toHaveBeenCalledTimes(2)
			expect(extractAndUpsertEntities).not.toHaveBeenCalled()
			expect(promoteDerivedMemoryFromEvent).not.toHaveBeenCalled()
			expect(completeClaimedMemoryJob).not.toHaveBeenCalled()
			expect(failClaimedMemoryJob).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
	it("renews claimed leases during a long session prefetch and stops after (W18)", async () => {
		vi.useFakeTimers()
		try {
			const { claimMemoryJob, completeClaimedMemoryJob, renewMemoryJobLease } =
				await import("./mongodb-memory-jobs.js")
			const { eventsCollection } = await import("./mongodb-schema.js")
			const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
			const { promoteDerivedMemoryFromEvent } = await import(
				"./mongodb-derived-memory.js"
			)
			const { getPendingExtractionEvents } = await import("./mongodb-events.js")
			mocked(getPendingExtractionEvents).mockResolvedValue([])
			const job = (eventId: string, jobId: string) => ({
				jobId,
				jobType: "extraction" as const,
				agentId: "agent-1",
				status: "running" as const,
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: { eventId, scope: "agent", scopeRef: "agent:agent-1" },
				attempts: 1,
				leaseOwner: "worker-w18",
				leaseToken: `lease-${jobId}`,
				heartbeatAt: new Date("2026-04-09T12:00:00.000Z"),
				leaseExpiresAt: new Date("2026-04-09T12:01:00.000Z"),
			})
			let extractionClaims = 0
			mocked(claimMemoryJob).mockImplementation((async (params: {
				jobType: string
			}) => {
				if (params.jobType === "consolidation") {
					return null
				}
				extractionClaims += 1
				if (extractionClaims === 1) {
					return job("evt-hb-1", "extraction-evt-hb-1")
				}
				if (extractionClaims === 2) {
					return job("evt-hb-2", "extraction-evt-hb-2")
				}
				return null
			}) as never)
			mocked(renewMemoryJobLease).mockResolvedValue(true)
			mocked(eventsCollection).mockReturnValue({
				findOne: vi.fn(async (filter?: { eventId?: string }) =>
					filter?.eventId === "evt-hb-2"
						? {
								eventId: "evt-hb-2",
								agentId: "agent-1",
								role: "user",
								body: "Second claimed event of the prefetch round.",
								timestamp: new Date("2026-04-09T12:00:00.000Z"),
								scope: "agent",
								scopeRef: "agent:agent-1",
							}
						: {
								eventId: "evt-hb-1",
								agentId: "agent-1",
								role: "user",
								body: "First claimed event of the prefetch round.",
								timestamp: new Date("2026-04-09T12:00:00.000Z"),
								scope: "agent",
								scopeRef: "agent:agent-1",
							},
				),
			} as unknown as import("mongodb").Collection)
			mocked(extractAndUpsertEntities).mockResolvedValue({
				entities: [],
				relationsCreated: 0,
			})
			mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
				structuredCreated: 0,
				proceduresCreated: 0,
				skipped: false,
			})
			mocked(completeClaimedMemoryJob).mockResolvedValue(true)

			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "agent-1",
					client: undefined,
					config: { mongodb: { embeddingMode: "automated" } },
					workspaceDir: "/tmp/memongo",
					memoryJobWorkerId: "worker-w18",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobOperationContexts: new Map(),
				},
			) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }

			// Hold the batched prefetch open (2+ claimed jobs make it real):
			// its duration is ours to control, standing in for a slow provider.
			let finishPrefetch: ((value: Map<string, string[]>) => void) | undefined
			const prefetchGate = new Promise<Map<string, string[]>>((resolve) => {
				finishPrefetch = resolve
			})
			const prefetchSpy = vi
				.spyOn(
					manager as unknown as {
						prefetchExtractionSessionFacts: (
							jobs: unknown[],
						) => Promise<Map<string, string[]>>
					},
					"prefetchExtractionSessionFacts",
				)
				.mockImplementation(() => prefetchGate)

			const lifecycle = MongoDBMemoryManager.prototype as unknown as {
				wakeMemoryJobWorker: (this: MongoDBMemoryManager) => void
			}
			lifecycle.wakeMemoryJobWorker.call(manager)
			// Microtask-flush until the round has claimed both jobs and its
			// batch-end poll (3 extraction claims) — the drain is now parked
			// inside the gated prefetch.
			for (
				let i = 0;
				i < 200 && mocked(claimMemoryJob).mock.calls.length < 3;
				i += 1
			) {
				await Promise.resolve()
			}
			expect(claimMemoryJob).toHaveBeenCalledTimes(3)

			// A full lease period passes while the prefetch is still in flight:
			// the prefetch heartbeat renews BOTH claimed jobs server-side, so
			// the round does not pay for the prefetch and lose the claims.
			await vi.advanceTimersByTimeAsync(20_000)
			const renewedJobIds = new Set(
				mocked(renewMemoryJobLease).mock.calls.map(([params]) => params?.jobId),
			)
			expect(renewedJobIds).toContain("extraction-evt-hb-1")
			expect(renewedJobIds).toContain("extraction-evt-hb-2")

			finishPrefetch?.(new Map())
			for (
				let i = 0;
				i < 500 && mocked(completeClaimedMemoryJob).mock.calls.length < 2;
				i += 1
			) {
				await Promise.resolve()
			}
			await manager.memoryJobWorkerPromise
			expect(completeClaimedMemoryJob).toHaveBeenCalledTimes(2)

			// Both the prefetch heartbeat and the runners' heartbeat timers are
			// cleared: further lease periods produce no renewals.
			const renewalsAfterRun = mocked(renewMemoryJobLease).mock.calls.length
			await vi.advanceTimersByTimeAsync(60_000)
			expect(mocked(renewMemoryJobLease).mock.calls.length).toBe(
				renewalsAfterRun,
			)
			prefetchSpy.mockRestore()
		} finally {
			vi.useRealTimers()
		}
	})
	it("replays a claimed consolidation job's stored caller options and scope (W05)", async () => {
		const { claimMemoryJob, completeClaimedMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { invalidateQueryCache } = await import("./mongodb-query-cache.js")
		const { getPendingExtractionEvents } = await import("./mongodb-events.js")
		mocked(getPendingExtractionEvents).mockResolvedValue([])
		// An explicit consolidate() created this row with tracking + caller
		// options in metadata, then failed mid-run with budget left. The
		// worker's claim retry must replay the ORIGINAL options — not default
		// to agent scope.
		let consolidationClaims = 0
		mocked(claimMemoryJob).mockImplementation((async (params: {
			jobType: string
		}) => {
			if (params.jobType !== "consolidation") {
				return null
			}
			consolidationClaims += 1
			if (consolidationClaims === 1) {
				return {
					jobId: "consolidation-explicit-1",
					jobType: "consolidation",
					agentId: "agent-1",
					status: "running",
					createdAt: new Date("2026-04-09T12:00:00.000Z"),
					startedAt: new Date("2026-04-09T12:00:01.000Z"),
					attempts: 2,
					leaseOwner: "worker-w05",
					leaseToken: "lease-w05",
					heartbeatAt: new Date("2026-04-09T12:00:01.000Z"),
					leaseExpiresAt: new Date("2026-04-09T12:01:01.000Z"),
					metadata: {
						scope: "workspace",
						scopeRef: "workspace:ws-9",
						maxEvents: 5,
						minCombinedScore: 0.4,
						resolveContradictions: false,
						llmDedup: true,
					},
				}
			}
			return null
		}) as never)
		mocked(consolidateMemory).mockResolvedValue({
			runId: "cons-run-w05",
			eventsProcessed: 5,
			factsPromoted: 2,
			factsPruned: 1,
			conflictsResolved: 0,
			durationMs: 42,
		})
		mocked(invalidateQueryCache).mockResolvedValue(undefined)
		mocked(completeClaimedMemoryJob).mockResolvedValue(true)

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				client: undefined,
				config: { mongodb: { embeddingMode: "automated" } },
				workspaceDir: "/tmp/memongo",
				memoryJobWorkerId: "worker-w05",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobOperationContexts: new Map(),
			},
		) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }
		const lifecycle = MongoDBMemoryManager.prototype as unknown as {
			wakeMemoryJobWorker: (this: MongoDBMemoryManager) => void
		}

		lifecycle.wakeMemoryJobWorker.call(manager)
		await manager.memoryJobWorkerPromise

		// The run replays the stored options verbatim...
		expect(consolidateMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				prefix: "test_",
				agentId: "agent-1",
				options: {
					scope: "workspace",
					scopeRef: "workspace:ws-9",
					maxEvents: 5,
					minCombinedScore: 0.4,
					resolveContradictions: false,
					llmDedup: true,
				},
			}),
		)
		// ...and the cache invalidation targets the STORED scope, not agent.
		expect(invalidateQueryCache).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "workspace",
				scopeRef: "workspace:ws-9",
			}),
		)
		expect(completeClaimedMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "consolidation-explicit-1",
				metadata: expect.objectContaining({ runId: "cons-run-w05" }),
			}),
		)
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

	describe("shutdown concurrency hardening (P2.5 e)", () => {
		it("drains a queued write BEFORE stopping the job worker and closing MongoDB", async () => {
			let finishQueuedWrite: (() => void) | undefined
			const queuedWrite = new Promise<void>((resolve) => {
				finishQueuedWrite = resolve
			})
			const order: string[] = []
			const runContexts = new Map([["extraction-evt-orphan", {}]])
			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					closed: false,
					watchTimer: null,
					syncing: null,
					writeQueue: queuedWrite.then(() => {
						order.push("write-drained")
					}),
					derivationSchedulingQueue: Promise.resolve(),
					derivationQueue: Promise.resolve(),
					memoryJobOperationContexts: runContexts,
					stopMemoryJobWorker: vi.fn(async () => {
						order.push("worker-stopped")
					}),
					watcher: null,
					changeStreamWatcher: null,
					accessTracker: null,
					ownsClient: true,
					client: {
						close: vi.fn(async () => {
							order.push("client-closed")
						}),
					},
				},
			) as MongoDBMemoryManager

			const closing = manager.close()
			await Promise.resolve()
			await Promise.resolve()
			// Blocked on the queued write: the worker is NOT stopped and the
			// client is NOT closed while a write is still in flight.
			expect(order).toEqual([])

			finishQueuedWrite?.()
			await closing

			// The queued write completed BEFORE the worker stopped and before
			// the client closed — nothing schedules work after worker stop.
			expect(order).toEqual([
				"write-drained",
				"worker-stopped",
				"client-closed",
			])
			// Run contexts for never-claimed jobs are dropped on shutdown.
			expect(runContexts.size).toBe(0)
		})

		it("refuses new writes and extraction scheduling once closed", async () => {
			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{ closed: true },
			) as MongoDBMemoryManager

			await expect(
				manager.writeConversationEvent({ role: "user", body: "too late" }),
			).rejects.toThrow(/closed/)
			await expect(
				manager.extractEvent({ eventId: "evt-too-late" }),
			).rejects.toThrow(/closed/)
		})

		it("never restarts the memory job worker after close", () => {
			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					closed: true,
					memoryJobWorkerStopped: true,
					memoryJobWorkerTimer: null,
					memoryJobWorkerActive: false,
				},
			) as MongoDBMemoryManager
			const lifecycle = MongoDBMemoryManager.prototype as unknown as {
				startMemoryJobWorker: (this: MongoDBMemoryManager) => void
			}

			lifecycle.startMemoryJobWorker.call(manager)

			const internals = manager as unknown as {
				memoryJobWorkerStopped: boolean
				memoryJobWorkerTimer: unknown
				memoryJobWorkerActive: boolean
			}
			expect(internals.memoryJobWorkerStopped).toBe(true)
			expect(internals.memoryJobWorkerTimer).toBeNull()
			expect(internals.memoryJobWorkerActive).toBe(false)
		})

		it("unrefs the watch debounce timer so it cannot hold the process open", () => {
			const unref = vi.fn()
			const fakeTimer = { unref, ref: vi.fn() }
			const setTimeoutSpy = vi
				.spyOn(globalThis, "setTimeout")
				.mockReturnValue(fakeTimer as unknown as NodeJS.Timeout)
			try {
				const manager = Object.assign(
					Object.create(MongoDBMemoryManager.prototype),
					{
						watchTimer: null,
						config: { mongodb: { watchDebounceMs: 250 } },
					},
				) as MongoDBMemoryManager
				const internals = manager as unknown as {
					scheduleWatchSync: (this: MongoDBMemoryManager) => void
					watchTimer: unknown
				}

				internals.scheduleWatchSync.call(manager)

				expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250)
				expect(unref).toHaveBeenCalledOnce()
			} finally {
				setTimeoutSpy.mockRestore()
			}
		})

		it("drops the run context when the extraction job is already terminal", async () => {
			const { createMemoryJob, getMemoryJob } = await import(
				"./mongodb-memory-jobs.js"
			)
			mocked(createMemoryJob).mockRejectedValue({ code: 11000 })
			mocked(getMemoryJob).mockResolvedValue({
				jobId: "extraction-evt-done",
				jobType: "extraction",
				agentId: "agent-1",
				status: "completed",
				createdAt: new Date("2026-04-09T12:00:00.000Z"),
				payload: { eventId: "evt-done" },
			})
			const runContexts = new Map([
				["extraction-evt-done", testOperationRunContext("run-terminal")],
			])
			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					db: {} as import("mongodb").Db,
					prefix: "test_",
					agentId: "agent-1",
					client: undefined,
					config: { mongodb: { embeddingMode: "automated" } },
					workspaceDir: "/tmp/memongo",
					memoryJobWorkerId: "worker-terminal",
					memoryJobWorkerStopped: false,
					memoryJobWorkerActive: false,
					memoryJobWorkerPromise: Promise.resolve(),
					memoryJobOperationContexts: runContexts,
				},
			) as MongoDBMemoryManager

			const result = await manager.extractEvent({ eventId: "evt-done" })

			expect(result).toEqual({
				jobId: "extraction-evt-done",
				scheduled: false,
			})
			// A terminal job is never claimed by this manager — the stale run
			// context entry must not leak.
			expect(runContexts.has("extraction-evt-done")).toBe(false)
		})
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
				memoryJobOperationContexts: new Map(),
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

		// WS-13: every drain round ends with one consolidation claim after the
		// extraction polls, so positional once-chains would land the queued job
		// in the consolidation slot. Key the mock on jobType instead: the first
		// extraction claim is the gated empty claim; the next returns the job.
		let finishEmptyClaim: ((value: null) => void) | undefined
		let firstExtractionClaim = true
		let extractionClaims = 0
		mocked(claimMemoryJob).mockImplementation((async (params: {
			jobType: string
		}) => {
			if (params.jobType === "consolidation") {
				return null
			}
			if (firstExtractionClaim) {
				firstExtractionClaim = false
				return new Promise((resolve) => {
					finishEmptyClaim = resolve
				})
			}
			extractionClaims += 1
			if (extractionClaims === 1) {
				return {
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
				}
			}
			// P3.9: the worker claims up to K jobs per round, so further
			// polls return null until the queue idles.
			return null
		}) as never)
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
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
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
				memoryJobOperationContexts: new Map(),
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

		// 6 claims: drain round 1 = the in-flight empty claim + one
		// consolidation claim; drain round 2 (wake-preserved) = the job claim
		// + in-round empty poll (P3.9 claims up to K per round) + one final
		// empty poll after processing + one consolidation claim (WS-13).
		await vi.waitFor(
			() => {
				expect(claimMemoryJob).toHaveBeenCalledTimes(6)
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
				memoryJobOperationContexts: new Map(),
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
})
