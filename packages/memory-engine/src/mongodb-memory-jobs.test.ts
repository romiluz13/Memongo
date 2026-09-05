import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientSession, Collection, Db, UpdateResult } from "mongodb"

function mockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		insertOne: vi.fn(async () => ({ insertedId: "job-1" })),
		updateOne: vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult),
		updateMany: vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult),
		findOneAndUpdate: vi.fn(async () => null),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		})),
		findOne: vi.fn(async () => null),
		...overrides,
	} as unknown as Collection
}

function mockDb(collectionMap: Record<string, Collection> = {}): Db {
	return {
		collection: vi.fn(
			(name: string) => collectionMap[name] ?? mockCollection(),
		),
	} as unknown as Db
}

vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))

describe("mongodb-memory-jobs", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("clamps list limits to a maximum of 100", async () => {
		const { listMemoryJobs } = await import("./mongodb-memory-jobs.js")
		const limitSpy = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		const db = mockDb({
			test_memory_jobs: mockCollection({
				find: vi.fn(() => ({
					sort: vi.fn(() => ({
						limit: limitSpy,
					})),
				})),
			}),
		})

		await listMemoryJobs({
			db,
			prefix: "test_",
			agentId: "agent-1",
			limit: 999999999,
		})

		expect(limitSpy).toHaveBeenCalledWith(100)
	})

	it("prevents invalid terminal-to-running transitions", async () => {
		const { updateMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 0 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateOne }),
		})

		await updateMemoryJob({
			db,
			prefix: "test_",
			jobId: "job-1",
			agentId: "agent-1",
			status: "running",
		})

		expect(updateOne).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "job-1",
				agentId: "agent-1",
				status: { $in: ["pending", "running"] },
			}),
			expect.any(Object),
		)
	})

	it("claims pending or abandoned extraction work with one atomic lease update", async () => {
		const { claimMemoryJob, MEMORY_JOB_MAX_ATTEMPTS } = await import(
			"./mongodb-memory-jobs.js"
		)
		const now = new Date("2026-07-23T00:00:00.000Z")
		const claimed = {
			jobId: "job-1",
			jobType: "extraction",
			agentId: "agent-1",
			status: "running",
			createdAt: now,
			attempts: 1,
			leaseOwner: "worker-a",
			leaseToken: "token-a",
			heartbeatAt: now,
			leaseExpiresAt: new Date(now.getTime() + 30_000),
		}
		const findOneAndUpdate = vi.fn(async () => claimed)
		const db = mockDb({
			test_memory_jobs: mockCollection({ findOneAndUpdate }),
		})

		await expect(
			claimMemoryJob({
				db,
				prefix: "test_",
				agentId: "agent-1",
				jobType: "extraction",
				workerId: "worker-a",
				leaseMs: 30_000,
				now,
			}),
		).resolves.toEqual(claimed)

		expect(findOneAndUpdate).toHaveBeenCalledTimes(1)
		expect(findOneAndUpdate).toHaveBeenCalledWith(
			{
				agentId: "agent-1",
				jobType: "extraction",
				$or: [
					{ status: "pending", stagedAt: { $exists: false } },
					{ status: "running", leaseExpiresAt: { $lte: now } },
					{ status: "running", leaseExpiresAt: { $exists: false } },
					// C4: a failed job stays claimable until its attempt budget is
					// spent, so a transient failure no longer discards the work.
					{
						status: "failed",
						attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
						$or: [{ retryAt: { $exists: false } }, { retryAt: { $lte: now } }],
					},
				],
			},
			// Pipeline update: lease timestamps come from server time ($$NOW),
			// immune to cross-worker clock skew.
			[
				{
					$set: expect.objectContaining({
						status: "running",
						startedAt: "$$NOW",
						leaseOwner: "worker-a",
						heartbeatAt: "$$NOW",
						leaseExpiresAt: { $add: ["$$NOW", 30_000] },
						attempts: { $add: [{ $ifNull: ["$attempts", 0] }, 1] },
						leaseToken: expect.any(String),
					}),
				},
				{ $unset: ["completedAt", "error", "stagedAt", "retryAt"] },
			],
			expect.objectContaining({
				sort: { createdAt: 1, jobId: 1 },
				returnDocument: "after",
				writeConcern: { w: "majority", wtimeoutMS: 5_000 },
			}),
		)
	})

	it("renews only the current unexpired fenced lease", async () => {
		const { renewMemoryJobLease } = await import("./mongodb-memory-jobs.js")
		const now = new Date("2026-07-23T00:00:00.000Z")
		const updateOne = vi.fn(async () => ({ matchedCount: 0 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateOne }),
		})

		await expect(
			renewMemoryJobLease({
				db,
				prefix: "test_",
				jobId: "job-1",
				agentId: "agent-1",
				leaseOwner: "worker-a",
				leaseToken: "stale-token",
				leaseMs: 30_000,
				now,
			}),
		).resolves.toBe(false)

		expect(updateOne).toHaveBeenCalledWith(
			{
				jobId: "job-1",
				agentId: "agent-1",
				status: "running",
				leaseOwner: "worker-a",
				leaseToken: "stale-token",
				leaseExpiresAt: { $gt: now },
			},
			expect.any(Object),
			expect.objectContaining({
				writeConcern: { w: "majority", wtimeoutMS: 5_000 },
			}),
		)
	})

	it("prevents a stale or expired worker from completing claimed work", async () => {
		const { completeClaimedMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const now = new Date("2026-07-23T00:01:00.000Z")
		const updateOne = vi.fn(async () => ({ matchedCount: 0 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateOne }),
		})

		await expect(
			completeClaimedMemoryJob({
				db,
				prefix: "test_",
				jobId: "job-1",
				agentId: "agent-1",
				leaseOwner: "worker-a",
				leaseToken: "stale-token",
				completedAt: now,
				now,
			}),
		).resolves.toBe(false)

		expect(updateOne).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "running",
				leaseOwner: "worker-a",
				leaseToken: "stale-token",
				leaseExpiresAt: { $gt: now },
			}),
			expect.objectContaining({
				$set: expect.objectContaining({ status: "completed" }),
				$unset: {
					leaseOwner: "",
					leaseToken: "",
					leaseExpiresAt: "",
					heartbeatAt: "",
				},
			}),
			expect.any(Object),
		)
	})

	it("atomically resets a failed job to pending without resetting attempts", async () => {
		const { retryFailedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateOne }),
		})

		await expect(
			retryFailedMemoryJob({
				db,
				prefix: "test_",
				jobId: "job-1",
				agentId: "agent-1",
				payload: {
					eventId: "event-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
				},
				metadata: { eventId: "event-1" },
			}),
		).resolves.toBe(true)

		expect(updateOne).toHaveBeenCalledWith(
			{
				jobId: "job-1",
				agentId: "agent-1",
				status: "failed",
			},
			expect.objectContaining({
				$set: expect.objectContaining({
					status: "pending",
					payload: expect.objectContaining({ eventId: "event-1" }),
				}),
				$unset: expect.not.objectContaining({ attempts: expect.anything() }),
			}),
			expect.objectContaining({
				writeConcern: { w: "majority", wtimeoutMS: 5_000 },
			}),
		)
	})

	describe("dead letters (WS-13)", () => {
		it("marks a failed job that exhausted its attempt budget as a dead letter", async () => {
			const { failClaimedMemoryJob, MEMORY_JOB_MAX_ATTEMPTS } = await import(
				"./mongodb-memory-jobs.js"
			)
			const now = new Date("2026-08-14T00:00:00.000Z")
			const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
			const telemetryInsert = vi.fn(async () => ({ insertedId: "t-1" }))
			const db = mockDb({
				test_memory_jobs: mockCollection({ updateOne }),
				test_memory_telemetry: mockCollection({ insertOne: telemetryInsert }),
			})

			await expect(
				failClaimedMemoryJob({
					db,
					prefix: "test_",
					jobId: "job-1",
					agentId: "agent-1",
					jobType: "extraction",
					leaseOwner: "worker-a",
					leaseToken: "token-a",
					durationMs: 12,
					error: "provider 503 x3",
					attempts: MEMORY_JOB_MAX_ATTEMPTS,
					now,
					completedAt: now,
				}),
			).resolves.toBe(true)

			expect(updateOne).toHaveBeenCalledTimes(1)
			const [filter, update] = updateOne.mock.calls[0]
			expect(filter).toEqual({
				jobId: "job-1",
				agentId: "agent-1",
				status: "running",
				leaseOwner: "worker-a",
				leaseToken: "token-a",
				leaseExpiresAt: { $gt: now },
			})
			expect(update.$set).toMatchObject({
				status: "failed",
				deadLetterAt: now,
			})
			// The completed-TTL index must not erase an operator-visible dead
			// letter, and the claim filter (attempts < MAX) means a retryAt
			// would be a promise the queue can never keep.
			expect(update.$set).not.toHaveProperty("completedAt")
			expect(update.$set).not.toHaveProperty("retryAt")
			expect(update.$unset).toEqual({
				leaseOwner: "",
				leaseToken: "",
				leaseExpiresAt: "",
				heartbeatAt: "",
			})
			// The transition is surfaced in telemetry for status dashboards.
			expect(telemetryInsert).toHaveBeenCalledWith(
				expect.objectContaining({
					ok: false,
					itemCount: MEMORY_JOB_MAX_ATTEMPTS,
					eventType: "extraction",
					meta: { agentId: "agent-1", operation: "memory-job-dead-letter" },
				}),
			)
		})

		it("spaces retries for a failure that still has attempt budget", async () => {
			const { failClaimedMemoryJob } = await import("./mongodb-memory-jobs.js")
			const now = new Date("2026-08-14T00:00:00.000Z")
			const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
			const telemetryInsert = vi.fn(async () => ({ insertedId: "t-1" }))
			const db = mockDb({
				test_memory_jobs: mockCollection({ updateOne }),
				test_memory_telemetry: mockCollection({ insertOne: telemetryInsert }),
			})

			await expect(
				failClaimedMemoryJob({
					db,
					prefix: "test_",
					jobId: "job-2",
					agentId: "agent-1",
					jobType: "extraction",
					leaseOwner: "worker-a",
					leaseToken: "token-a",
					durationMs: 8,
					error: "provider timeout",
					attempts: 1,
					now,
					completedAt: now,
				}),
			).resolves.toBe(true)

			const [, update] = updateOne.mock.calls[0]
			expect(update.$set).toMatchObject({
				status: "failed",
				completedAt: now,
				// memoryJobRetryDelayMs(1) = 60s backoff.
				retryAt: new Date(now.getTime() + 60_000),
			})
			expect(update.$set).not.toHaveProperty("deadLetterAt")
			// Budget-left failures are ordinary, not dead-letter telemetry.
			expect(telemetryInsert).not.toHaveBeenCalled()
		})

		it("clears the dead-letter marker when a dead letter is requeued", async () => {
			const { retryFailedMemoryJob } = await import("./mongodb-memory-jobs.js")
			const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
			const db = mockDb({
				test_memory_jobs: mockCollection({ updateOne }),
			})

			await expect(
				retryFailedMemoryJob({
					db,
					prefix: "test_",
					jobId: "job-dead",
					agentId: "agent-1",
					payload: {
						eventId: "event-1",
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
				}),
			).resolves.toBe(true)

			const [, update] = updateOne.mock.calls[0]
			expect(update.$unset).toMatchObject({ deadLetterAt: "" })
			expect(update.$unset).not.toHaveProperty("attempts")
		})
	})

	it("uses the transaction session instead of per-operation write concern", async () => {
		const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
		const insertOne = vi.fn(async () => ({ insertedId: "job-1" }))
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertOne }),
		})
		const session = {} as ClientSession

		await createMemoryJob({
			db,
			prefix: "test_",
			session,
			job: {
				jobId: "job-1",
				jobType: "extraction",
				agentId: "agent-1",
				status: "pending",
				stagedAt: new Date("2026-07-23T00:00:00.000Z"),
				payload: { eventId: "event-1" },
			},
		})

		expect(insertOne).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "job-1" }),
			{ session },
		)
	})

	it("releases one staged job owned by an agent", async () => {
		const { releaseStagedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateOne }),
		})

		await expect(
			releaseStagedMemoryJob({
				db,
				prefix: "test_",
				jobId: "job-1",
				agentId: "agent-1",
			}),
		).resolves.toBe(true)
		expect(updateOne).toHaveBeenCalledWith(
			{
				jobId: "job-1",
				agentId: "agent-1",
				status: "pending",
				stagedAt: { $exists: true },
			},
			{ $unset: { stagedAt: "" } },
			expect.any(Object),
		)
	})

	it("creates many jobs in ONE unordered majority insertMany (P3.9)", async () => {
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const insertMany = vi.fn(async () => ({
			acknowledged: true,
			insertedCount: 2,
		}))
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertMany }),
		})

		const results = await createMemoryJobsBatch({
			db,
			prefix: "test_",
			jobs: [
				{
					jobId: "extraction-evt-1",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					payload: { eventId: "evt-1" },
				},
				{
					jobId: "extraction-evt-2",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					payload: { eventId: "evt-2" },
				},
			],
		})

		expect(insertMany).toHaveBeenCalledTimes(1)
		const [docs, opts] = insertMany.mock.calls[0]
		expect(opts).toEqual({
			ordered: false,
			writeConcern: { w: "majority", wtimeoutMS: 5_000 },
		})
		expect(docs).toHaveLength(2)
		expect(docs[0]).toMatchObject({
			jobId: "extraction-evt-1",
			attempts: 0,
		})
		expect(docs[0].createdAt).toBeInstanceOf(Date)
		expect(results).toEqual([
			{ ok: true, jobId: "extraction-evt-1" },
			{ ok: true, jobId: "extraction-evt-2" },
		])
	})

	it("maps per-item bulk failures, flagging E11000 as duplicate (P3.9)", async () => {
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const bulkError = Object.assign(new Error("BulkWriteError"), {
			name: "MongoBulkWriteError",
			writeErrors: [
				{
					index: 1,
					code: 11000,
					errmsg: "E11000 duplicate key error collection: test_memory_jobs",
				},
			],
		})
		const insertMany = vi.fn(async () => {
			throw bulkError
		})
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertMany }),
		})

		const results = await createMemoryJobsBatch({
			db,
			prefix: "test_",
			jobs: [
				{
					jobId: "extraction-evt-1",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					payload: { eventId: "evt-1" },
				},
				{
					jobId: "extraction-evt-dupe",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					payload: { eventId: "evt-dupe" },
				},
			],
		})

		expect(results[0]).toEqual({ ok: true, jobId: "extraction-evt-1" })
		expect(results[1]).toMatchObject({
			ok: false,
			jobId: "extraction-evt-dupe",
			duplicate: true,
		})
	})
})
