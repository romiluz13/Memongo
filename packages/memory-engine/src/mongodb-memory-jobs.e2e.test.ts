import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { MemongoConfig } from "@memongo/lib"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	claimMemoryJob,
	completeClaimedMemoryJob,
	createMemoryJob,
	failClaimedMemoryJob,
	MEMORY_JOB_MAX_ATTEMPTS,
	releaseStagedMemoryJob,
	retryFailedMemoryJob,
} from "./mongodb-memory-jobs.js"
import { extractAndUpsertEntities, upsertRelation } from "./mongodb-graph.js"
import { writeEvent } from "./mongodb-events.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { writeProcedure } from "./mongodb-procedures.js"
import {
	ensureCollections,
	entitiesCollection,
	entityLinksCollection,
	eventsCollection,
	memoryJobsCollection,
	procedureRevisionsCollection,
	proceduresCollection,
	relationsCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
} from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"
import { MAJORITY_TRANSACTION_OPTIONS } from "./mongodb-transactions.js"
import { resolveMemoryBackendConfig } from "./backend-config.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_memory_jobs_${randomUUID().slice(0, 8)}`
const PREFIX = "jobs_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`

let client: MongoClient

describe("durable memory job leases (live MongoDB)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI, {
			serverSelectionTimeoutMS: 10_000,
			connectTimeoutMS: 10_000,
		})
		await client.connect()
		const db = client.db(TEST_DB)
		await ensureCollections(db, PREFIX)
		await memoryJobsCollection(db, PREFIX).createIndex(
			{ jobId: 1 },
			{ name: "uq_memory_jobs_jobid", unique: true },
		)
		await memoryJobsCollection(db, PREFIX).createIndex(
			{
				agentId: 1,
				jobType: 1,
				status: 1,
				leaseExpiresAt: 1,
				createdAt: 1,
				jobId: 1,
			},
			{ name: "idx_memory_jobs_claim_v2" },
		)
		await relationsCollection(db, PREFIX).createIndex(
			{
				agentId: 1,
				scope: 1,
				scopeRef: 1,
				fromEntityId: 1,
				toEntityId: 1,
				type: 1,
			},
			{ name: "uq_relations_identity", unique: true },
		)
		await structuredMemCollection(db, PREFIX).createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1 },
			{
				name: "uq_structured_agent_scope_scoperef_type_key",
				unique: true,
			},
		)
		await proceduresCollection(db, PREFIX).createIndex(
			{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_procedures_identity", unique: true },
		)
	})

	afterAll(async () => {
		await client
			?.db(TEST_DB)
			.dropDatabase()
			.catch(() => {})
		await client?.close()
	})

	it("grants exactly one lease when many workers race for one job", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-race`
		const jobId = `extraction-race-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-race" },
			},
		})

		const now = new Date("2026-07-23T00:00:00.000Z")
		const claims = await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				claimMemoryJob({
					db,
					prefix: PREFIX,
					agentId,
					jobType: "extraction",
					workerId: `worker-${index}`,
					leaseMs: 60_000,
					now,
				}),
			),
		)
		const winners = claims.filter((claim) => claim !== null)

		expect(winners).toHaveLength(1)
		expect(winners[0]).toMatchObject({
			jobId,
			status: "running",
			attempts: 1,
		})
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({
				jobId,
				status: "running",
			}),
		).toBe(1)
	})

	it("breaks equal-createdAt claim ties by jobId", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-tie-break`
		const createdAt = new Date("2026-07-23T01:00:00.000Z")
		const suffix = randomUUID()
		const jobIds = [
			`extraction-${suffix}-z`,
			`extraction-${suffix}-a`,
			`extraction-${suffix}-m`,
		]
		await memoryJobsCollection(db, PREFIX).insertMany(
			jobIds.map((jobId) => ({
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				createdAt,
				attempts: 0,
				payload: { eventId: jobId },
			})),
		)

		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-tie-break",
			leaseMs: 60_000,
			now: new Date("2026-07-23T01:01:00.000Z"),
		})

		expect(claimed?.jobId).toBe(`extraction-${suffix}-a`)
	})

	it("applies one typed-relation side effect when replacement workers overlap", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-relation-race`
		const scopeRef = `agent:${agentId}`
		const target = `project-${randomUUID()}`
		await upsertRelation({
			db,
			prefix: PREFIX,
			client,
			relation: {
				fromEntityId: "old-owner",
				toEntityId: target,
				type: "owns",
				agentId,
				scope: "agent",
				scopeRef,
				sourceEventIds: ["evt-old-owner"],
				updatedAt: new Date(),
			},
		})

		const sourceEventId = `evt-${randomUUID()}`
		await Promise.all(
			Array.from({ length: 12 }, () =>
				upsertRelation({
					db,
					prefix: PREFIX,
					client,
					relation: {
						fromEntityId: "new-owner",
						toEntityId: target,
						type: "owns",
						agentId,
						scope: "agent",
						scopeRef,
						sourceEventIds: [sourceEventId],
						updatedAt: new Date(),
					},
					eventReceiptIds: [sourceEventId],
				}),
			),
		)

		const relationDocs = await relationsCollection(db, PREFIX)
			.find({ agentId, type: "owns", toEntityId: target })
			.toArray()
		expect(relationDocs).toHaveLength(2)
		expect(
			relationDocs.find((doc) => doc.fromEntityId === "old-owner"),
		).toMatchObject({ state: "invalidated" })
		expect(
			relationDocs.find((doc) => doc.fromEntityId === "new-owner"),
		).toMatchObject({
			state: "active",
			reinforcementCount: 1,
			sourceEventIds: [sourceEventId],
		})
	})

	it("applies one structured and procedure promotion when replacement workers overlap", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-promotion-race`
		const sourceEventId = `evt-${randomUUID()}`
		const structuredKey = `fact-${randomUUID()}`
		const procedureId = `procedure-${randomUUID()}`

		await Promise.all(
			Array.from({ length: 12 }, () =>
				writeStructuredMemory({
					db,
					prefix: PREFIX,
					client,
					embeddingMode: "automated",
					eventReceiptIds: [sourceEventId],
					entry: {
						type: "fact",
						key: structuredKey,
						value: "A stale worker must not replay this fact",
						agentId,
						sourceEventIds: [sourceEventId],
					},
				}),
			),
		)
		await Promise.all(
			Array.from({ length: 12 }, () =>
				writeProcedure({
					db,
					prefix: PREFIX,
					client,
					embeddingMode: "automated",
					eventReceiptIds: [sourceEventId],
					entry: {
						procedureId,
						name: "Fence replacement workers",
						steps: ["Read the event receipt", "Skip a replay"],
						agentId,
						sourceEventIds: [sourceEventId],
					},
				}),
			),
		)

		const structured = await structuredMemCollection(db, PREFIX).findOne({
			agentId,
			type: "fact",
			key: structuredKey,
		})
		const procedure = await proceduresCollection(db, PREFIX).findOne({
			agentId,
			procedureId,
		})
		expect(structured).toMatchObject({
			revision: 1,
			reinforcementCount: 1,
			sourceEventIds: [sourceEventId],
		})
		expect(procedure).toMatchObject({
			revision: 1,
			sourceEventIds: [sourceEventId],
		})
		expect(
			await structuredMemRevisionsCollection(db, PREFIX).countDocuments({
				agentId,
				key: structuredKey,
			}),
		).toBe(0)
		expect(
			await procedureRevisionsCollection(db, PREFIX).countDocuments({
				agentId,
				procedureId,
			}),
		).toBe(0)
	})

	it("keeps staged work unclaimable until the producer releases it", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-staged`
		const jobId = `extraction-staged-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				stagedAt: new Date(),
				payload: { eventId: "event-staged" },
			},
		})

		await expect(
			claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: "worker-before-release",
				leaseMs: 60_000,
			}),
		).resolves.toBeNull()
		await expect(
			releaseStagedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
			}),
		).resolves.toBe(true)
		await expect(
			claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: "worker-after-release",
				leaseMs: 60_000,
			}),
		).resolves.toMatchObject({
			jobId,
			leaseOwner: "worker-after-release",
			status: "running",
		})
	})

	it("commits the canonical event and staged job as one transaction", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-transaction-commit`
		const eventId = `event-transaction-commit-${randomUUID()}`
		const jobId = `extraction-${eventId}`
		const session = client.startSession()
		try {
			await session.withTransaction(async () => {
				await writeEvent({
					db,
					prefix: PREFIX,
					session,
					event: {
						eventId,
						agentId,
						role: "user",
						body: "Commit this event with its durable extraction job.",
						scope: "agent",
						extractionJobPendingAt: new Date(),
					},
				})
				await createMemoryJob({
					db,
					prefix: PREFIX,
					session,
					job: {
						jobId,
						jobType: "extraction",
						agentId,
						status: "pending",
						stagedAt: new Date(),
						payload: { eventId },
					},
				})
			}, MAJORITY_TRANSACTION_OPTIONS)
		} finally {
			await session.endSession()
		}

		expect(
			await eventsCollection(db, PREFIX).countDocuments({ eventId, agentId }),
		).toBe(1)
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({ jobId, agentId }),
		).toBe(1)
	})

	it("aborts the canonical event when staging the job fails", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-transaction-abort`
		const eventId = `event-transaction-abort-${randomUUID()}`
		const session = client.startSession()
		try {
			await expect(
				session.withTransaction(async () => {
					await writeEvent({
						db,
						prefix: PREFIX,
						session,
						event: {
							eventId,
							agentId,
							role: "user",
							body: "This event must roll back with its missing job.",
							scope: "agent",
							extractionJobPendingAt: new Date(),
						},
					})
					throw new Error("forced job staging failure")
				}, MAJORITY_TRANSACTION_OPTIONS),
			).rejects.toThrow("forced job staging failure")
		} finally {
			await session.endSession()
		}

		expect(
			await eventsCollection(db, PREFIX).countDocuments({ eventId, agentId }),
		).toBe(0)
	})

	it("repairs a standalone crash from the canonical event outbox", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-standalone-repair`
		const eventId = `event-standalone-repair-${randomUUID()}`
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "@alice restores #durable-memory after a process crash.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{ db, prefix: PREFIX, agentId, chunkCount: 0 },
		) as MongoDBMemoryManager

		await expect(manager.repairExtractionOutbox()).resolves.toEqual({
			eventsProcessed: 1,
			jobsCreated: 1,
			jobsReleased: 1,
			eventsFailed: 0,
		})
		const storedEvent = await eventsCollection(db, PREFIX).findOne({ eventId })
		expect(storedEvent).not.toHaveProperty("extractionJobPendingAt")
		expect(storedEvent?.projectedAt).toBeInstanceOf(Date)
		await expect(
			claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: "worker-after-standalone-repair",
				leaseMs: 60_000,
			}),
		).resolves.toMatchObject({
			jobId: `extraction-${eventId}`,
			status: "running",
		})
	})

	it("recovers and executes staged outbox work through the public manager factory", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-startup-"),
		)
		const agentId = `${AGENT}-factory-startup`
		const eventId = `event-factory-startup-${randomUUID()}`
		const db = client.db(TEST_DB)
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "@alice restores #startup-recovery from the durable outbox.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		const cfg = {
			agents: { defaults: { workspace } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: TEST_URI,
					database: TEST_DB,
					collectionPrefix: PREFIX,
					enableChangeStreams: false,
					kb: { enabled: false },
					relevance: { enabled: false },
					episodes: { enabled: false },
				},
			},
		} as unknown as MemongoConfig
		const previousReadinessTimeout =
			process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS
		const previousReadinessPoll =
			process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS
		process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS = "1"
		process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS = "1"
		let manager: MongoDBMemoryManager | undefined
		try {
			manager = await MongoDBMemoryManager.create({
				cfg,
				agentId,
				resolved: resolveMemoryBackendConfig({ cfg, agentId }),
			})
			// Give-up budget, not an expected runtime: this waits on a full
			// manager startup (which now builds the vector indexes that used to
			// fail) plus a worker round trip, while every other e2e file is
			// hitting the same container.
			const deadline = Date.now() + 90_000
			let stored = await memoryJobsCollection(db, PREFIX).findOne({
				jobId: `extraction-${eventId}`,
				agentId,
			})
			while (stored?.status !== "completed" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
				stored = await memoryJobsCollection(db, PREFIX).findOne({
					jobId: `extraction-${eventId}`,
					agentId,
				})
			}
			expect(stored).toMatchObject({
				jobId: `extraction-${eventId}`,
				status: "completed",
				attempts: 1,
			})
			expect(
				await eventsCollection(db, PREFIX).findOne({ eventId, agentId }),
			).not.toHaveProperty("extractionJobPendingAt")
		} finally {
			if (previousReadinessTimeout === undefined) {
				delete process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS
			} else {
				process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS =
					previousReadinessTimeout
			}
			if (previousReadinessPoll === undefined) {
				delete process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS
			} else {
				process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS =
					previousReadinessPoll
			}
			await manager?.close()
			await rm(workspace, { recursive: true, force: true })
		}
		// Give-up budget. Manager startup now builds the vector indexes that
		// used to fail outright, and every other e2e file is hitting the same
		// container, so 30s no longer covers a healthy run.
	})

	it("replays foreground entity projection without double-counting an event", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-entity-replay`
		const eventId = `event-entity-replay-${randomUUID()}`
		const params = {
			db,
			prefix: PREFIX,
			agentId,
			eventContent: "@alice owns #durable-memory",
			scope: "agent" as const,
			sourceEventId: eventId,
		}

		const first = await extractAndUpsertEntities(params)
		await extractAndUpsertEntities(params)

		const storedAfterReplay = await entitiesCollection(db, PREFIX).findOne({
			entityId: first.entities[0]?.entityId,
			agentId,
		})
		expect(storedAfterReplay).toMatchObject({
			mentionCount: 1,
			sourceEventIds: [eventId],
		})

		const nextEventId = `event-entity-next-${randomUUID()}`
		await extractAndUpsertEntities({
			...params,
			sourceEventId: nextEventId,
		})
		const storedAfterNewEvent = await entitiesCollection(db, PREFIX).findOne({
			entityId: first.entities[0]?.entityId,
			agentId,
		})
		expect(storedAfterNewEvent).toMatchObject({ mentionCount: 2 })
		expect(storedAfterNewEvent?.sourceEventIds).toEqual(
			expect.arrayContaining([eventId, nextEventId]),
		)
		const storedRelation = await relationsCollection(db, PREFIX).findOne({
			agentId,
			type: "mentioned_with",
		})
		const storedLink = await entityLinksCollection(db, PREFIX).findOne({
			agentId,
		})
		expect(storedRelation?.sourceEventIds).toEqual(
			expect.arrayContaining([eventId, nextEventId]),
		)
		expect(storedLink?.sourceEventIds).toEqual(
			expect.arrayContaining([eventId, nextEventId]),
		)
	})

	it("reclaims an expired crash lease and fences the stale worker", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-crash`
		const jobId = `extraction-crash-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-crash" },
			},
		})

		// Lease expiry is stamped with server $$NOW, so a synthetic `now` can no
		// longer simulate a crashed worker. A negative leaseMs creates a lease
		// that is genuinely expired in server time (a minute of headroom absorbs
		// client/server clock skew on the reclaim comparison).
		const first = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-before-crash",
			leaseMs: -60_000,
		})
		expect(first).not.toBeNull()

		const recovered = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-after-crash",
			leaseMs: 60_000,
		})
		expect(recovered).toMatchObject({
			jobId,
			status: "running",
			attempts: 2,
			leaseOwner: "worker-after-crash",
		})

		await expect(
			completeClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: first?.leaseOwner ?? "",
				leaseToken: first?.leaseToken ?? "",
			}),
		).resolves.toBe(false)
		await expect(
			failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: first?.leaseOwner ?? "",
				leaseToken: first?.leaseToken ?? "",
				error: "stale worker must not win",
			}),
		).resolves.toBe(false)
		await expect(
			completeClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: recovered?.leaseOwner ?? "",
				leaseToken: recovered?.leaseToken ?? "",
				// Real clock: the recovered lease is 60 s in the future.
			}),
		).resolves.toBe(true)

		const stored = await memoryJobsCollection(db, PREFIX).findOne({ jobId })
		expect(stored).toMatchObject({
			jobId,
			status: "completed",
			attempts: 2,
		})
		expect(stored).not.toHaveProperty("leaseOwner")
		expect(stored).not.toHaveProperty("leaseToken")
	})

	it("rejects terminal writes after lease expiry even before reclaim", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-expired-terminal`
		const jobId = `extraction-expired-terminal-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-expired-terminal" },
			},
		})
		// Negative leaseMs: the lease is stamped expired in server time (see the
		// crash-reclaim test above for why a synthetic `now` no longer works).
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-expired-terminal",
			leaseMs: -60_000,
		})
		expect(claimed).not.toBeNull()

		await expect(
			completeClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: claimed?.leaseOwner ?? "",
				leaseToken: claimed?.leaseToken ?? "",
			}),
		).resolves.toBe(false)
		await expect(
			failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: claimed?.leaseOwner ?? "",
				leaseToken: claimed?.leaseToken ?? "",
				error: "expired worker must not win",
			}),
		).resolves.toBe(false)
		expect(
			await memoryJobsCollection(db, PREFIX).findOne({ jobId }),
		).toMatchObject({ status: "running" })
	})

	it("retries a failed deterministic job while preserving attempt history", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-retry`
		const jobId = `extraction-retry-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-retry" },
			},
		})
		const claimedAt = new Date()
		const first = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-first-attempt",
			leaseMs: 60_000,
			now: claimedAt,
		})
		expect(first).not.toBeNull()
		await expect(
			failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: first?.leaseOwner ?? "",
				leaseToken: first?.leaseToken ?? "",
				now: claimedAt,
				error: "temporary failure",
			}),
		).resolves.toBe(true)

		await expect(
			retryFailedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				payload: { eventId: "event-retry" },
			}),
		).resolves.toBe(true)
		const second = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-second-attempt",
			leaseMs: 60_000,
			now: new Date(claimedAt.getTime() + 1),
		})
		expect(second).toMatchObject({
			jobId,
			attempts: 2,
			status: "running",
			leaseOwner: "worker-second-attempt",
		})
	})

	it("retries a failed job until it exhausts its attempt budget (C4)", async () => {
		// Before this, `attempts` was incremented on every claim and read by
		// nothing, so claimMemoryJob never matched a failed job. Extraction
		// clears the event's extractionJobPendingAt marker when the job is
		// released — before the work runs — so repairExtractionOutbox could not
		// see it either. One transient failure dropped that event's memories
		// permanently and silently.
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-retry-budget`
		const jobId = `extraction-retry-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-retry" },
			},
		})

		// Each round claims, fails, then waits out the backoff by moving the
		// clock forward rather than sleeping.
		let now = new Date("2026-07-23T00:00:00.000Z")
		const observedAttempts: number[] = []
		for (let round = 0; round < MEMORY_JOB_MAX_ATTEMPTS; round++) {
			const claimed = await claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: `worker-${round}`,
				leaseMs: 60_000,
				now,
			})
			expect(claimed).not.toBeNull()
			observedAttempts.push(claimed!.attempts)
			await failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: claimed!.leaseOwner,
				leaseToken: claimed!.leaseToken,
				now,
				error: `transient failure ${round}`,
				attempts: claimed!.attempts,
			})
			// Past any backoff this job could have been given.
			now = new Date(now.getTime() + 2 * 60 * 60_000)
		}

		expect(observedAttempts).toEqual([1, 2, 3])

		// Budget spent: the job stays failed as an explicit dead letter.
		const exhausted = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-final",
			leaseMs: 60_000,
			now,
		})
		expect(exhausted).toBeNull()

		const doc = await memoryJobsCollection(db, PREFIX).findOne({ jobId })
		expect(doc?.status).toBe("failed")
		expect(doc?.attempts).toBe(MEMORY_JOB_MAX_ATTEMPTS)
	})

	it("holds a failed job until its retry backoff elapses", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-retry-backoff`
		const jobId = `extraction-backoff-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-backoff" },
			},
		})

		const now = new Date("2026-07-23T00:00:00.000Z")
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-a",
			leaseMs: 60_000,
			now,
		})
		expect(claimed).not.toBeNull()
		await failClaimedMemoryJob({
			db,
			prefix: PREFIX,
			jobId,
			agentId,
			leaseOwner: claimed!.leaseOwner,
			leaseToken: claimed!.leaseToken,
			now,
			error: "transient failure",
			attempts: claimed!.attempts,
		})

		// Immediately after failing, the job is still inside its backoff window,
		// so a job that fails for a persistent reason cannot spin the worker.
		const tooSoon = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-b",
			leaseMs: 60_000,
			now: new Date(now.getTime() + 1_000),
		})
		expect(tooSoon).toBeNull()

		const afterBackoff = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-c",
			leaseMs: 60_000,
			now: new Date(now.getTime() + 10 * 60_000),
		})
		expect(afterBackoff).not.toBeNull()
		expect(afterBackoff!.attempts).toBe(2)
	})
})
