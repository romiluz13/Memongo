// Real-database coverage for the W09 fenced batch writer. These tests require
// a replica set because the primary event and extraction-job writes commit in
// one transaction. Every run uses and drops a unique disposable database.

import { randomUUID } from "node:crypto"
import {
	type ClientSession,
	type CommandStartedEvent,
	type Db,
	MongoClient,
	MongoNetworkError,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	ensureCollections,
	eventsCollection,
	memoryJobsCollection,
} from "./mongodb-schema.js"
import {
	beginErasure,
	finalizeErasure,
	isErasureGateConflictError,
	readErasureGate,
} from "./mongodb-write-fence.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

const URI = "mongodb://127.0.0.1:27017/?directConnection=true"
const DB_NAME = `memongo_batch_write_e2e_${randomUUID().replaceAll("-", "")}`
const PREFIX = "test_"
const TIMEOUT = 60_000

let client: MongoClient
let db: Db
const commandsStarted: CommandStartedEvent[] = []

captureManagerPrototype(MongoDBMemoryManager)

function agentId(label: string): string {
	return `agent-${label}-${randomUUID().slice(0, 8)}`
}

function managerFor(agent: string, writeQueue = Promise.resolve()) {
	return buildMockManager({
		client,
		db,
		prefix: PREFIX,
		agentId: agent,
		agentScopeRef: `agent:${agent}`,
		workspaceScopeRef: `workspace:${agent}`,
		workspaceDir: "/tmp/memongo-batch-write-e2e",
		config: kitMongoConfig({
			episodes: { enabled: false, minEventsForEpisode: 6 },
		}),
		closed: false,
		writeQueue,
		writeQueueDepth: 0,
		memoryJobWorkerStopped: true,
		memoryJobOperationContexts: new Map(),
		shouldRunPostWriteDerivedWork: () => true,
		startMemoryJobWorker: () => {},
		wakeMemoryJobWorker: () => {},
		schedulePostWriteDerivations: async () => {},
		scheduleQueryCacheInvalidation: () => {},
	})
}

beforeAll(async () => {
	client = new MongoClient(URI, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
		monitorCommands: true,
	})
	client.on("commandStarted", (event: CommandStartedEvent) => {
		commandsStarted.push(event)
	})
	await client.connect()
	db = client.db(DB_NAME)
	await ensureCollections(db, PREFIX)
	await eventsCollection(db, PREFIX).createIndex(
		{ eventId: 1 },
		{ name: "uq_events_eventid", unique: true },
	)
	await eventsCollection(db, PREFIX).createIndex(
		{ agentId: 1, idempotencyKey: 1 },
		{
			name: "uq_events_agent_idempotency_key",
			unique: true,
			partialFilterExpression: { idempotencyKey: { $type: "string" } },
		},
	)
	await memoryJobsCollection(db, PREFIX).createIndex(
		{ jobId: 1 },
		{ name: "uq_memory_jobs_jobid", unique: true },
	)
}, TIMEOUT)

afterAll(async () => {
	try {
		if (db) {
			await db.dropDatabase()
			const listed = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true, filter: { name: DB_NAME } })
			expect(
				listed.databases.length,
				"disposable database must be absent after teardown",
			).toBe(0)
		}
	} finally {
		await client?.close()
	}
}, TIMEOUT)

describe("MongoDBMemoryManager fenced batch writes (real replica set)", () => {
	it(
		"commits the events and staged extraction jobs in one successful fence",
		async () => {
			const agent = agentId("commit")
			const manager = managerFor(agent)

			const receipts = await manager.writeConversationEventsBatch([
				{
					role: "user",
					body: "first durable batch event",
					idempotencyKey: "commit-1",
				},
				{
					role: "assistant",
					body: "second durable batch event",
					idempotencyKey: "commit-2",
				},
			])

			expect(receipts).toHaveLength(2)
			expect(receipts.every((receipt) => receipt.ok)).toBe(true)
			expect(
				await eventsCollection(db, PREFIX).countDocuments({ agentId: agent }),
			).toBe(2)
			expect(
				await memoryJobsCollection(db, PREFIX).countDocuments({
					agentId: agent,
					status: "pending",
					stagedAt: { $exists: false },
				}),
			).toBe(2)
			expect(
				await eventsCollection(db, PREFIX).countDocuments({
					agentId: agent,
					extractionJobPendingAt: { $exists: true },
				}),
			).toBe(0)
			expect(
				await readErasureGate({ db, prefix: PREFIX, agentId: agent }),
			).toMatchObject({ state: "open", epoch: 0, serial: 1 })
		},
		TIMEOUT,
	)

	it(
		"confirms a native commit after the commit response is lost",
		async () => {
			const agent = agentId("commit-response-loss")
			const invalidAt = new Date(Date.now() + 24 * 60 * 60 * 1_000)
			const expiresAt = new Date(invalidAt.getTime() + 24 * 60 * 60 * 1_000)
			commandsStarted.length = 0
			const originalStartSession = client.startSession.bind(client)
			const startSessionSpy = vi.spyOn(client, "startSession")
			startSessionSpy.mockImplementation((options) => {
				const session = originalStartSession(options)
				const nativeCommit = session.commitTransaction.bind(session)
				session.commitTransaction = async (...args) => {
					await nativeCommit(...args)
					throw new MongoNetworkError(
						"synthetic response loss after native commit",
					)
				}
				return session
			})

			try {
				const receipts = await managerFor(agent).writeConversationEventsBatch([
					{
						role: "user",
						body: "native committed response lost",
						scope: "agent",
						metadata: { proof: "native-commit-loss" },
						invalidAt,
						expiresAt,
					},
				])

				expect(receipts).toHaveLength(1)
				expect(receipts[0]).toMatchObject({
					ok: true,
					chunkCreated: true,
				})
				if (!receipts[0]?.ok) {
					throw new Error("expected committed event receipt")
				}
				const eventId = receipts[0].eventId
				const [storedEvent, storedJobs] = await Promise.all([
					eventsCollection(db, PREFIX).findOne({ eventId }),
					memoryJobsCollection(db, PREFIX)
						.find({ "metadata.eventId": eventId })
						.toArray(),
				])
				expect(storedEvent).toMatchObject({
					eventId,
					agentId: agent,
					metadata: { proof: "native-commit-loss" },
					invalidAt,
					expiresAt,
				})
				expect(storedJobs).toHaveLength(1)
				expect(
					commandsStarted.filter(
						(event) => event.commandName === "commitTransaction",
					),
				).toHaveLength(1)
				expect(
					commandsStarted.filter(
						(event) =>
							event.databaseName === DB_NAME &&
							event.commandName === "insert" &&
							event.command.insert === `${PREFIX}events`,
					),
				).toHaveLength(1)
				expect(
					commandsStarted.filter(
						(event) =>
							event.databaseName === DB_NAME &&
							event.commandName === "insert" &&
							event.command.insert === `${PREFIX}memory_jobs`,
					),
				).toHaveLength(1)
				const confirmationReads = commandsStarted.filter(
					(event) =>
						event.databaseName === DB_NAME &&
						event.commandName === "find" &&
						event.command.find === `${PREFIX}events` &&
						event.command.readConcern?.level === "majority",
				)
				expect(confirmationReads).toHaveLength(1)
				expect(confirmationReads[0]?.command.filter).toEqual({
					eventId: { $in: [eventId] },
				})
			} finally {
				startSessionSpy.mockRestore()
			}
		},
		TIMEOUT,
	)

	it(
		"does not treat a replay-only row as proof that this fence inserted it",
		async () => {
			const agent = agentId("replay-only")
			const eventId = randomUUID()
			const timestamp = new Date()
			const expiresAt = new Date(timestamp.getTime() + 24 * 60 * 60 * 1_000)
			const idempotencyKey = `replay-only-${eventId}`
			await eventsCollection(db, PREFIX).insertOne({
				eventId,
				agentId: agent,
				role: "user",
				body: "replay-only predecessor",
				scope: "agent",
				scopeRef: `agent:${agent}`,
				timestamp,
				validAt: timestamp,
				recordedAt: timestamp,
				idempotencyKey,
				expiresAt,
			})

			commandsStarted.length = 0
			const originalStartSession = client.startSession.bind(client)
			const startSessionSpy = vi.spyOn(client, "startSession")
			startSessionSpy.mockImplementation((options) => {
				const session = originalStartSession(options)
				const nativeCommit = session.commitTransaction.bind(session)
				session.commitTransaction = async (...args) => {
					await nativeCommit(...args)
					throw new MongoNetworkError(
						"synthetic response loss after replay-only fence commit",
					)
				}
				return session
			})

			try {
				const receipts = await managerFor(agent).writeConversationEventsBatch([
					{
						idempotencyKey,
						role: "user",
						body: "replay-only predecessor",
						scope: "agent",
						timestamp,
						validAt: timestamp,
					},
				])

				expect(receipts).toEqual([
					{
						ok: false,
						code: "WRITE_ERROR",
						message:
							"event durability unconfirmed; retry with the same idempotency key",
					},
				])
				expect(
					await eventsCollection(db, PREFIX).countDocuments({ eventId }),
				).toBe(1)
				expect(
					await memoryJobsCollection(db, PREFIX).countDocuments({
						"metadata.eventId": eventId,
					}),
				).toBe(0)
				expect(
					commandsStarted.filter(
						(event) => event.commandName === "commitTransaction",
					),
				).toHaveLength(1)
				expect(
					commandsStarted.filter(
						(event) =>
							event.databaseName === DB_NAME &&
							event.commandName === "insert" &&
							(event.command.insert === `${PREFIX}events` ||
								event.command.insert === `${PREFIX}memory_jobs`),
					),
				).toHaveLength(0)
			} finally {
				startSessionSpy.mockRestore()
			}
		},
		TIMEOUT,
	)

	it(
		"collapses identical in-request keys and rejects a differing follower",
		async () => {
			const replayAgent = agentId("same-key-replay")
			const replayManager = managerFor(replayAgent)
			const replayReceipts = await replayManager.writeConversationEventsBatch([
				{
					role: "user",
					body: "same payload",
					idempotencyKey: "same-key",
				},
				{
					role: "user",
					body: "same payload",
					idempotencyKey: "same-key",
				},
			])

			expect(replayReceipts[0]).toMatchObject({ ok: true })
			expect(replayReceipts[1]).toMatchObject({
				ok: true,
				replayed: true,
				eventId:
					replayReceipts[0]?.ok === true
						? replayReceipts[0].eventId
						: "missing",
			})
			expect(
				await eventsCollection(db, PREFIX).countDocuments({
					agentId: replayAgent,
				}),
			).toBe(1)

			const conflictAgent = agentId("same-key-conflict")
			const conflictReceipts = await managerFor(
				conflictAgent,
			).writeConversationEventsBatch([
				{
					role: "user",
					body: "accepted payload",
					idempotencyKey: "conflict-key",
				},
				{
					role: "user",
					body: "different payload",
					idempotencyKey: "conflict-key",
				},
			])

			expect(conflictReceipts[0]).toMatchObject({ ok: true })
			expect(conflictReceipts[1]).toMatchObject({
				ok: false,
				code: "IDEMPOTENCY_CONFLICT",
			})
			expect(
				await eventsCollection(db, PREFIX).countDocuments({
					agentId: conflictAgent,
				}),
			).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"aborts a code-121 round, promotes its prepared successor, and commits once",
		async () => {
			const agent = agentId("validation")
			const receipts = await managerFor(agent).writeConversationEventsBatch([
				{
					role: "invalid" as "user",
					body: "validator must reject this leader",
					idempotencyKey: "promoted-key",
				},
				{
					role: "user",
					body: "prepared successor survives",
					idempotencyKey: "promoted-key",
				},
				{
					role: "assistant",
					body: "unrelated sibling survives the aborted round",
					idempotencyKey: "sibling-key",
				},
			])

			expect(receipts[0]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
			expect(receipts[1], JSON.stringify(receipts)).toMatchObject({ ok: true })
			expect(receipts[2]).toMatchObject({ ok: true })
			expect(
				await eventsCollection(db, PREFIX).countDocuments({ agentId: agent }),
			).toBe(2)
			expect(
				await eventsCollection(db, PREFIX).countDocuments({
					agentId: agent,
					role: "invalid",
				}),
			).toBe(0)
			expect(
				await readErasureGate({ db, prefix: PREFIX, agentId: agent }),
			).toMatchObject({ state: "open", epoch: 0, serial: 1 })
		},
		TIMEOUT,
	)

	it(
		"preserves the typed erasure conflict for stale queued admission",
		async () => {
			const agent = agentId("erasure")
			let releaseQueue = () => {}
			const queuedAhead = new Promise<void>((resolve) => {
				releaseQueue = resolve
			})
			const manager = managerFor(agent, queuedAhead)
			const staleWrite = manager.writeConversationEventsBatch([
				{
					role: "user",
					body: "must not cross erasure",
					idempotencyKey: "stale-key",
				},
			])
			const staleOutcome = staleWrite.then(
				(value) => ({ status: "fulfilled" as const, value }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			)

			let admitted = await readErasureGate({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			for (let attempt = 0; !admitted && attempt < 100; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				admitted = await readErasureGate({
					db,
					prefix: PREFIX,
					agentId: agent,
				})
			}
			expect(admitted).toMatchObject({ state: "open", epoch: 0 })

			const erase = await beginErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			await finalizeErasure({ db, prefix: PREFIX, token: erase })
			releaseQueue()

			const outcome = await staleOutcome
			expect(outcome.status).toBe("rejected")
			if (outcome.status === "rejected") {
				expect(isErasureGateConflictError(outcome.reason)).toBe(true)
			}
			expect(
				await eventsCollection(db, PREFIX).countDocuments({ agentId: agent }),
			).toBe(0)
			expect(
				await memoryJobsCollection(db, PREFIX).countDocuments({
					agentId: agent,
				}),
			).toBe(0)
		},
		TIMEOUT,
	)

	it(
		"rejects the original admission when erasure completes between validation rounds",
		async () => {
			const agent = agentId("erasure-between-rounds")
			const originalStartSession = client.startSession.bind(client)
			const startSessionSpy = vi.spyOn(client, "startSession")
			let startedSessions = 0
			let announceSecondRound = () => {}
			const secondRoundStarted = new Promise<void>((resolve) => {
				announceSecondRound = resolve
			})
			let releaseSecondRound = () => {}
			const continueSecondRound = new Promise<void>((resolve) => {
				releaseSecondRound = resolve
			})
			startSessionSpy.mockImplementation((options) => {
				const session = originalStartSession(options)
				startedSessions++
				if (startedSessions === 2) {
					const originalWithTransaction = session.withTransaction.bind(session)
					session.withTransaction = ((
						...args: Parameters<ClientSession["withTransaction"]>
					) => {
						announceSecondRound()
						return continueSecondRound.then(() =>
							originalWithTransaction(...args),
						)
					}) as ClientSession["withTransaction"]
				}
				return session
			})

			try {
				const outcomePromise = managerFor(agent)
					.writeConversationEventsBatch([
						{
							role: "invalid" as "user",
							body: "native validator aborts the first round",
							idempotencyKey: "promote-after-erasure",
						},
						{
							role: "user",
							body: "must not cross the intervening erasure",
							idempotencyKey: "promote-after-erasure",
						},
					])
					.then(
						(value) => ({ status: "fulfilled" as const, value }),
						(reason: unknown) => ({ status: "rejected" as const, reason }),
					)

				await secondRoundStarted
				const erase = await beginErasure({
					db,
					prefix: PREFIX,
					agentId: agent,
				})
				await finalizeErasure({ db, prefix: PREFIX, token: erase })
				releaseSecondRound()

				const outcome = await outcomePromise
				expect(outcome.status).toBe("rejected")
				if (outcome.status === "rejected") {
					expect(isErasureGateConflictError(outcome.reason)).toBe(true)
				}
				expect(
					await eventsCollection(db, PREFIX).countDocuments({ agentId: agent }),
				).toBe(0)
				expect(
					await memoryJobsCollection(db, PREFIX).countDocuments({
						agentId: agent,
					}),
				).toBe(0)
				expect(
					await readErasureGate({ db, prefix: PREFIX, agentId: agent }),
				).toMatchObject({ state: "open", epoch: 1, serial: 0 })
			} finally {
				releaseSecondRound()
				startSessionSpy.mockRestore()
			}
		},
		TIMEOUT,
	)

	it(
		"rolls back every event when staged-job insertion aborts the transaction",
		async () => {
			const agent = agentId("job-abort")
			await db.command({
				collMod: `${PREFIX}memory_jobs`,
				validator: { $expr: false },
				validationLevel: "strict",
				validationAction: "error",
			})

			const receipts = await managerFor(agent).writeConversationEventsBatch([
				{
					role: "user",
					body: "must roll back with its job",
					idempotencyKey: "job-abort-1",
				},
				{
					role: "assistant",
					body: "must also roll back",
					idempotencyKey: "job-abort-2",
				},
			])

			expect(receipts).toEqual([
				expect.objectContaining({ ok: false, code: "WRITE_ERROR" }),
				expect.objectContaining({ ok: false, code: "WRITE_ERROR" }),
			])
			expect(
				await eventsCollection(db, PREFIX).countDocuments({ agentId: agent }),
			).toBe(0)
			expect(
				await memoryJobsCollection(db, PREFIX).countDocuments({
					agentId: agent,
				}),
			).toBe(0)
			expect(
				await readErasureGate({ db, prefix: PREFIX, agentId: agent }),
			).toMatchObject({ state: "open", epoch: 0, serial: 0 })
		},
		TIMEOUT,
	)
})
