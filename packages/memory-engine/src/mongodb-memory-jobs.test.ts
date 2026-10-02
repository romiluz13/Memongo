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
				admissionEpoch: 7,
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
					// W05: tracking rows (live synchronous runs) are excluded from
					// reclamation even when lease-less. W18: reclaiming abandoned
					// running work is bounded by the attempt budget.
					{
						status: "running",
						leaseExpiresAt: { $lte: now },
						attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
						tracking: { $ne: true },
					},
					{
						status: "running",
						leaseExpiresAt: { $exists: false },
						attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
						tracking: { $ne: true },
					},
					// C4: a failed job stays claimable until its attempt budget is
					// spent, so a transient failure no longer discards the work.
					// Terminal dead letters (deadLetterAt set, possibly at a low
					// truthful attempt count with no retryAt) are excluded — a
					// retry would be a pointless identical request (p6).
					{
						status: "failed",
						attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
						deadLetterAt: { $exists: false },
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
						admissionEpoch: { $ifNull: ["$admissionEpoch", 7] },
					}),
				},
				{ $unset: ["completedAt", "error", "stagedAt", "retryAt", "tracking"] },
			],
			expect.objectContaining({
				sort: { createdAt: 1, jobId: 1 },
				returnDocument: "after",
				writeConcern: { w: "majority", wtimeoutMS: 5_000 },
			}),
		)
	})

	it("commits an effect batch only after fencing the gate and exact live lease", async () => {
		const { withClaimedMemoryJobEffectBatch } = await import(
			"./mongodb-memory-jobs.js"
		)
		const session = {
			withTransaction: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
			endSession: vi.fn(async () => undefined),
		} as unknown as ClientSession
		const gateUpdate = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const jobUpdate = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = {
			client: { startSession: vi.fn(() => session) },
			collection: vi.fn((name: string) => {
				if (name === "test_meta") {
					return mockCollection({
						findOne: vi.fn(async () => ({
							_id: "tenant-erasure-gate:agent-1",
							agentId: "agent-1",
							epoch: 7,
							state: "open",
							serial: 2,
						})),
						updateOne: gateUpdate,
					})
				}
				if (name === "test_memory_jobs") {
					return mockCollection({ updateOne: jobUpdate })
				}
				return mockCollection()
			}),
		} as unknown as Db
		const effect = vi.fn(async (received: ClientSession) => {
			expect(received).toBe(session)
			return "committed"
		})

		await expect(
			withClaimedMemoryJobEffectBatch({
				db,
				prefix: "test_",
				token: { kind: "admission", agentId: "agent-1", epoch: 7 },
				jobId: "job-1",
				agentId: "agent-1",
				leaseOwner: "worker-a",
				leaseToken: "token-a",
				fn: effect,
			}),
		).resolves.toBe("committed")

		expect(jobUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "job-1",
				agentId: "agent-1",
				status: "running",
				leaseOwner: "worker-a",
				leaseToken: "token-a",
				leaseExpiresAt: { $gt: expect.any(Date) },
				admissionEpoch: 7,
			}),
			{
				$inc: { effectFenceSerial: 1 },
				$currentDate: { effectFenceAt: true },
			},
			{ session },
		)
		expect(effect).toHaveBeenCalledOnce()
		expect(gateUpdate).toHaveBeenCalledOnce()
	})

	it("fails an effect batch closed when the exact lease is no longer owned", async () => {
		const { withClaimedMemoryJobEffectBatch } = await import(
			"./mongodb-memory-jobs.js"
		)
		const session = {
			withTransaction: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
			endSession: vi.fn(async () => undefined),
		} as unknown as ClientSession
		const db = {
			client: { startSession: vi.fn(() => session) },
			collection: vi.fn((name: string) => {
				if (name === "test_meta") {
					return mockCollection({
						findOne: vi.fn(async () => ({
							_id: "tenant-erasure-gate:agent-1",
							agentId: "agent-1",
							epoch: 7,
							state: "open",
							serial: 2,
						})),
						updateOne: vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult),
					})
				}
				if (name === "test_memory_jobs") {
					return mockCollection({
						updateOne: vi.fn(async () => ({ matchedCount: 0 }) as UpdateResult),
					})
				}
				return mockCollection()
			}),
		} as unknown as Db
		const effect = vi.fn(async () => "must-not-run")

		await expect(
			withClaimedMemoryJobEffectBatch({
				db,
				prefix: "test_",
				token: { kind: "admission", agentId: "agent-1", epoch: 7 },
				jobId: "job-1",
				agentId: "agent-1",
				leaseOwner: "worker-a",
				leaseToken: "stale-token",
				fn: effect,
			}),
		).rejects.toMatchObject({
			code: "MEMORY_JOB_OWNERSHIP_LOST",
			jobId: "job-1",
		})
		expect(effect).not.toHaveBeenCalled()
	})

	it("binds a legacy claimed row to the captured admission epoch", async () => {
		const { captureClaimedMemoryJobAdmissionEpoch } = await import(
			"./mongodb-memory-jobs.js"
		)
		const session = {
			withTransaction: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
			endSession: vi.fn(async () => undefined),
		} as unknown as ClientSession
		const jobUpdate = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = {
			client: { startSession: vi.fn(() => session) },
			collection: vi.fn((name: string) => {
				if (name === "test_meta") {
					return mockCollection({
						findOne: vi.fn(async () => ({
							_id: "tenant-erasure-gate:agent-1",
							agentId: "agent-1",
							epoch: 9,
							state: "open",
							serial: 3,
						})),
						updateOne: vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult),
					})
				}
				if (name === "test_memory_jobs") {
					return mockCollection({ updateOne: jobUpdate })
				}
				return mockCollection()
			}),
		} as unknown as Db

		await expect(
			captureClaimedMemoryJobAdmissionEpoch({
				db,
				prefix: "test_",
				token: { kind: "admission", agentId: "agent-1", epoch: 9 },
				jobId: "legacy-job",
				agentId: "agent-1",
				leaseOwner: "worker-a",
				leaseToken: "token-a",
			}),
		).resolves.toBe(true)

		expect(jobUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "legacy-job",
				leaseOwner: "worker-a",
				leaseToken: "token-a",
				admissionEpoch: { $exists: false },
				leaseExpiresAt: { $gt: expect.any(Date) },
			}),
			{
				$set: {
					admissionEpoch: 9,
					effectFenceAt: expect.any(Date),
				},
				$inc: { effectFenceSerial: 1 },
			},
			{ session },
		)
	})

	it("dead-letters lease-expired running rows with a spent attempt budget (W18)", async () => {
		const { deadLetterExpiredMemoryJobs, MEMORY_JOB_MAX_ATTEMPTS } =
			await import("./mongodb-memory-jobs.js")
		const now = new Date("2026-07-23T00:00:00.000Z")
		const updateMany = vi.fn(async () => ({ modifiedCount: 2 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateMany }),
		})

		await expect(
			deadLetterExpiredMemoryJobs({
				db,
				prefix: "test_",
				agentId: "agent-1",
				jobType: "extraction",
				now,
			}),
		).resolves.toBe(2)

		expect(updateMany).toHaveBeenCalledWith(
			{
				agentId: "agent-1",
				jobType: "extraction",
				status: "running",
				attempts: { $gte: MEMORY_JOB_MAX_ATTEMPTS },
				// W05: live synchronous tracking rows keep their own terminal
				// ownership; the sweep must not touch them even though they carry
				// no lease.
				tracking: { $ne: true },
				$or: [
					{ leaseExpiresAt: { $lte: now } },
					{ leaseExpiresAt: { $exists: false } },
				],
			},
			{
				$set: {
					status: "failed",
					deadLetterAt: now,
					error: "lease-expiry retry budget exhausted",
				},
				$unset: {
					leaseOwner: "",
					leaseToken: "",
					leaseExpiresAt: "",
					heartbeatAt: "",
					retryAt: "",
					completedAt: "",
				},
			},
			// Majority write concern: a dead letter is a decision (the row leaves
			// `running` forever), so it must survive a failover.
			{ writeConcern: { w: "majority", wtimeoutMS: 5_000 } },
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
				test_meta: mockCollection({
					findOneAndUpdate: vi.fn(async () => ({
						agentId: "agent-1",
						epoch: 0,
						state: "open",
						serial: 0,
					})),
					findOne: vi.fn(async () => ({
						agentId: "agent-1",
						epoch: 0,
						state: "open",
						serial: 0,
					})),
				}),
				test_memory_telemetry: mockCollection({ insertOne: telemetryInsert }),
			})
			Object.assign(db, {
				listCollections: () => ({
					toArray: async () => [{ type: "collection" }],
				}),
				client: {
					startSession: () => ({
						inTransaction: () => false,
						withTransaction: async (fn: () => Promise<unknown>) => fn(),
						endSession: async () => {},
					}),
				},
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
			await vi.waitFor(() => expect(telemetryInsert).toHaveBeenCalledTimes(1))
			expect(telemetryInsert).toHaveBeenCalledWith(
				expect.objectContaining({
					ok: false,
					itemCount: MEMORY_JOB_MAX_ATTEMPTS,
					eventType: "extraction",
					meta: { agentId: "agent-1", operation: "memory-job-dead-letter" },
				}),
				expect.objectContaining({ session: expect.any(Object) }),
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

	it("uses the caller session to release one staged job", async () => {
		const { releaseStagedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateOne }),
		})
		const session = {} as ClientSession

		await expect(
			releaseStagedMemoryJob({
				db,
				prefix: "test_",
				jobId: "job-transaction",
				agentId: "agent-1",
				session,
			}),
		).resolves.toBe(true)
		expect(updateOne).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			{ session },
		)
	})

	it("uses the caller session to read one job", async () => {
		const { getMemoryJob } = await import("./mongodb-memory-jobs.js")
		const findOne = vi.fn(async () => null)
		const db = mockDb({
			test_memory_jobs: mockCollection({ findOne }),
		})
		const session = {} as ClientSession

		await expect(
			getMemoryJob({
				db,
				prefix: "test_",
				jobId: "job-transaction",
				agentId: "agent-1",
				session,
			}),
		).resolves.toBeNull()
		expect(findOne).toHaveBeenCalledWith(
			{ jobId: "job-transaction", agentId: "agent-1" },
			{ session },
		)
	})

	it("releases staged jobs in one batch update", async () => {
		const { releaseStagedMemoryJobsBatch } = await import(
			"./mongodb-memory-jobs.js"
		)
		const updateMany = vi.fn(async () => ({ matchedCount: 2 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateMany }),
		})

		await expect(
			releaseStagedMemoryJobsBatch({
				db,
				prefix: "test_",
				jobIds: ["job-1", "job-2"],
				agentId: "agent-1",
			}),
		).resolves.toBe(2)
		expect(updateMany).toHaveBeenCalledWith(
			{
				jobId: { $in: ["job-1", "job-2"] },
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

	it("uses the caller session for one batch insert and preserves prepared clocks", async () => {
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const insertMany = vi.fn(async () => ({
			acknowledged: true,
			insertedCount: 1,
		}))
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertMany }),
		})
		const session = {} as import("mongodb").ClientSession
		const createdAt = new Date("2026-09-08T12:00:00.000Z")

		await createMemoryJobsBatch({
			db,
			prefix: "test_",
			session,
			jobs: [
				{
					jobId: "extraction-evt-1",
					jobType: "extraction",
					agentId: "agent-1",
					status: "pending",
					createdAt,
				},
			],
		})

		expect(insertMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					jobId: "extraction-evt-1",
					createdAt,
				}),
			],
			{ ordered: false, session },
		)
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

	it("reconciles a write-concern-only error by read instead of throwing into a persisted batch (W08/W09)", async () => {
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const insertMany = vi.fn(async () => {
			throw Object.assign(new Error("wtimeout"), {
				writeConcernErrors: [{ code: 64, errmsg: "wtimeout" }],
			})
		})
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => [{ jobId: "extraction-evt-1" }]),
		}))
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertMany, find }),
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

		// Present job = satisfied; missing job = retry-safe receipt. No throw.
		expect(results[0]).toEqual({ ok: true, jobId: "extraction-evt-1" })
		expect(results[1]).toMatchObject({
			ok: false,
			jobId: "extraction-evt-2",
			duplicate: false,
		})
		if (!results[1].ok) {
			expect(results[1].message).toContain("not found on reconciliation read")
		}
		expect(find).toHaveBeenCalledWith(
			{ jobId: { $in: ["extraction-evt-1", "extraction-evt-2"] } },
			{ projection: { _id: 0, jobId: 1 } },
		)
	})

	it("returns safe-retry receipts for a NoWritesPerformed error (W09)", async () => {
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const insertMany = vi.fn(async () => {
			const err = new Error("NoWritesPerformed") as Error & {
				hasErrorLabel: (label: string) => boolean
			}
			err.hasErrorLabel = (label: string) => label === "NoWritesPerformed"
			throw err
		})
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertMany, find }),
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
			],
		})

		expect(results[0]).toMatchObject({
			ok: false,
			jobId: "extraction-evt-1",
			duplicate: false,
		})
		if (!results[0].ok) {
			expect(results[0].message).toContain("no writes performed")
		}
		// Zero writes are guaranteed — no reconciliation read.
		expect(find).not.toHaveBeenCalled()
	})

	it("yields durability-unconfirmed receipts when the reconciliation read fails (W08)", async () => {
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const insertMany = vi.fn(async () => {
			throw Object.assign(new Error("wtimeout"), {
				writeConcernErrors: [{ code: 64, errmsg: "wtimeout" }],
			})
		})
		const find = vi.fn(() => {
			throw new Error("reconciliation read unavailable")
		})
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertMany, find }),
		})

		// No throw — the batch's events are already durable.
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
			],
		})

		expect(results[0]).toMatchObject({
			ok: false,
			jobId: "extraction-evt-1",
			duplicate: false,
		})
		if (!results[0].ok) {
			expect(results[0].message).toContain("durability unconfirmed")
		}
	})

	it("read-confirms unlisted jobs when a write-concern error rides along with per-item errors (W09)", async () => {
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const insertMany = vi.fn(async () => {
			throw Object.assign(new Error("BulkWriteError"), {
				name: "MongoBulkWriteError",
				err: { code: 64, errmsg: "wtimeout" },
				writeErrors: [{ index: 0, code: 11000, errmsg: "E11000" }],
			})
		})
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => [{ jobId: "extraction-evt-2" }]),
		}))
		const db = mockDb({
			test_memory_jobs: mockCollection({ insertMany, find }),
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

		// E11000 → duplicate (existing job satisfied); unlisted evt-2 is
		// uncertain under the write-concern error → read confirms it.
		expect(results[0]).toMatchObject({
			ok: false,
			jobId: "extraction-evt-1",
			duplicate: true,
		})
		expect(results[1]).toEqual({ ok: true, jobId: "extraction-evt-2" })
	})

	it("terminal failure dead-letters at the TRUTHFUL attempt count (p6-approved design)", async () => {
		const { failClaimedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = mockDb({ test_memory_jobs: mockCollection({ updateOne }) })

		// First-attempt policy refusal: attempts is 1, not MEMORY_JOB_MAX.
		await failClaimedMemoryJob({
			db,
			prefix: "test_",
			jobId: "extraction-evt-1",
			agentId: "agent-1",
			leaseOwner: "worker-1",
			leaseToken: "token-1",
			jobType: "extraction",
			completedAt: new Date("2026-09-20T12:00:00Z"),
			now: new Date("2026-09-20T12:00:00Z"),
			error:
				"relation extraction: provider response unusable (shape=refusal, finishReason=stop, refusal=true, provider=mock)",
			metadata: { eventId: "evt-1" },
			attempts: 1,
			terminal: true,
		})

		expect(updateOne).toHaveBeenCalledTimes(1)
		const [filter, update] = updateOne.mock.calls[0]
		expect(filter).toMatchObject({
			jobId: "extraction-evt-1",
			status: "running",
			leaseOwner: "worker-1",
			leaseToken: "token-1",
		})
		const set = update.$set
		// Dead letter: no retryAt (a retry would be a pointless identical
		// request), no completedAt (TTL must not erase it), deadLetterAt set.
		expect(set.status).toBe("failed")
		expect(set.deadLetterAt).toEqual(new Date("2026-09-20T12:00:00Z"))
		expect(set.retryAt).toBeUndefined()
		expect(set.completedAt).toBeUndefined()
		// Truthful attempts: the historical claim count is NEVER fabricated to
		// force the terminal transition.
		expect(set.attempts).toBeUndefined()
		// Caller metadata is untouched (p6: no diagnostics through metadata).
		expect(set.metadata).toEqual({ eventId: "evt-1" })
	})

	it("non-terminal failure keeps the bounded retry ladder (retryAt, no deadLetterAt)", async () => {
		const { failClaimedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = mockDb({ test_memory_jobs: mockCollection({ updateOne }) })

		await failClaimedMemoryJob({
			db,
			prefix: "test_",
			jobId: "extraction-evt-1",
			agentId: "agent-1",
			leaseOwner: "worker-1",
			leaseToken: "token-1",
			jobType: "extraction",
			completedAt: new Date("2026-09-20T12:00:00Z"),
			now: new Date("2026-09-20T12:00:00Z"),
			error:
				"relation extraction: provider response unusable (shape=empty-content, finishReason=stop, provider=mock)",
			metadata: { eventId: "evt-1" },
			attempts: 1,
		})

		const set = updateOne.mock.calls[0][1].$set
		expect(set.status).toBe("failed")
		expect(set.retryAt).toBeInstanceOf(Date)
		expect(set.deadLetterAt).toBeUndefined()
	})

	it("exhausted attempts still dead-letter without the terminal flag (existing ladder)", async () => {
		const { failClaimedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = mockDb({ test_memory_jobs: mockCollection({ updateOne }) })

		await failClaimedMemoryJob({
			db,
			prefix: "test_",
			jobId: "extraction-evt-1",
			agentId: "agent-1",
			leaseOwner: "worker-1",
			leaseToken: "token-1",
			jobType: "extraction",
			completedAt: new Date("2026-09-20T12:00:00Z"),
			now: new Date("2026-09-20T12:00:00Z"),
			error:
				"relation extraction JSON parse failed (finishReason=stop, provider=mock)",
			metadata: { eventId: "evt-1" },
			attempts: 3,
		})

		const set = updateOne.mock.calls[0][1].$set
		expect(set.deadLetterAt).toEqual(new Date("2026-09-20T12:00:00Z"))
		expect(set.retryAt).toBeUndefined()
		expect(set.attempts).toBeUndefined()
	})

	it("the failed claim branch excludes dead letters (MANDATORY for truthful terminal attempts)", async () => {
		const { claimMemoryJob } = await import("./mongodb-memory-jobs.js")
		const findOneAndUpdate = vi.fn(async () => null)
		const db = mockDb({
			test_memory_jobs: mockCollection({ findOneAndUpdate }),
		})

		await claimMemoryJob({
			db,
			prefix: "test_",
			agentId: "agent-1",
			jobType: "extraction",
			workerId: "worker-1",
			leaseMs: 60_000,
		})

		const filter = findOneAndUpdate.mock.calls[0][0]
		const failedBranch = filter.$or.find(
			(branch: { status?: string }) => branch.status === "failed",
		)
		expect(failedBranch).toBeDefined()
		// Without this exclusion, a terminal failure at attempts=1 with no
		// retryAt would be immediately reclaimed (p6).
		expect(failedBranch.deadLetterAt).toEqual({ $exists: false })
	})

	it("retryFailedMemoryJob unsets deadLetterAt so an intentional requeue stays possible", async () => {
		const { retryFailedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult)
		const db = mockDb({ test_memory_jobs: mockCollection({ updateOne }) })

		await retryFailedMemoryJob({
			db,
			prefix: "test_",
			jobId: "extraction-evt-1",
			agentId: "agent-1",
			payload: { eventId: "evt-1" },
		})

		const update = updateOne.mock.calls[0][1]
		expect(update.$set.status).toBe("pending")
		expect(update.$unset.deadLetterAt).toBe("")
		expect(update.$unset.retryAt).toBe("")
	})
})
