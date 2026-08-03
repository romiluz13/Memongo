/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	mocked,
	testBenchmarkRunContext,
} from "./test-helpers/manager-test-kit.js"

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
			mocked(renewMemoryJobLease).mockResolvedValue(false)
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
					memoryJobRunContexts: new Map(),
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
					memoryJobRunContexts: runContexts,
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
				["extraction-evt-done", testBenchmarkRunContext("run-terminal")],
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
					memoryJobRunContexts: runContexts,
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
			// P3.9: the worker claims up to K jobs per round, so further polls
			// return null until the queue idles.
			.mockResolvedValue(null)
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

		// 4 claims: the in-flight empty claim, the wake-preserved round's
		// job claim + in-round empty poll, and one final empty poll (P3.9
		// claims up to K per round).
		await vi.waitFor(
			() => {
				expect(claimMemoryJob).toHaveBeenCalledTimes(4)
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
			memoryJobRunContexts: new Map(),
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
			memoryJobRunContexts: new Map(),
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
				memoryJobRunContexts: new Map(),
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
