// Real-database e2e for the W2 erasure foundation gate + write fence.
// Runs against the local replica set (transactions require one). Uses a
// unique disposable database per run; teardown drops it, asserts absence,
// and closes the client in a finally-style afterAll.

import { randomUUID } from "node:crypto"
import {
	type Collection,
	type Db,
	type Document,
	type Filter,
	type FindOptions,
	MongoClient,
	MongoError,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bumpTenantErasureEpoch } from "./mongodb-erasure-epoch.js"
import {
	beginErasure,
	captureAdmissionToken,
	finalizeErasure,
	isErasureGateConflictError,
	isMalformedGateError,
	readErasureGate,
	takeoverErasure,
	withFencedWrite,
} from "./mongodb-write-fence.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { metaCollection } from "./mongodb-schema.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

const URI =
	process.env.MEMONGO_TEST_MONGODB_URI ??
	"mongodb://127.0.0.1:27017/?directConnection=true"
const DB_NAME = `memongo_erasure_fence_e2e_${randomUUID().replaceAll("-", "")}`
const PREFIX = "test_"
const DATA = "data"
const TIMEOUT = 60_000

let client: MongoClient
let db: Db

captureManagerPrototype(MongoDBMemoryManager)

function agentId(label: string): string {
	return `agent-${label}-${randomUUID().slice(0, 8)}`
}

function transientError(): MongoError {
	const err = new MongoError("simulated transient transaction failure")
	err.addErrorLabel("TransientTransactionError")
	return err
}

async function dataRows(agent: string): Promise<number> {
	return db.collection(DATA).countDocuments({ agentId: agent })
}

async function gate(agent: string) {
	return readErasureGate({ db, prefix: PREFIX, agentId: agent })
}

beforeAll(async () => {
	client = new MongoClient(URI)
	await client.connect()
	db = client.db(DB_NAME)
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

describe("erasure gate + write fence (real replica set)", () => {
	it(
		"baseline: a fresh admitted write commits and mutates the gate serial",
		async () => {
			const agent = agentId("baseline")
			const token = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			expect(token).toEqual({ kind: "admission", agentId: agent, epoch: 0 })
			await withFencedWrite({
				db,
				prefix: PREFIX,
				token,
				fn: async (session) => {
					await db
						.collection(DATA)
						.insertOne({ agentId: agent, tag: "fresh" }, { session })
				},
			})
			expect(await dataRows(agent)).toBe(1)
			const g = await gate(agent)
			expect(g).toMatchObject({ epoch: 0, state: "open", serial: 1 })
		},
		TIMEOUT,
	)

	it(
		"the public event writer rejects stale queued admission and commits a fresh epoch with its outbox",
		async () => {
			const agent = agentId("public-writer")
			let releaseQueue = () => {}
			const queuedAhead = new Promise<void>((resolve) => {
				releaseQueue = resolve
			})
			const manager = buildMockManager({
				client,
				db,
				prefix: PREFIX,
				agentId: agent,
				agentScopeRef: `agent:${agent}`,
				workspaceScopeRef: `workspace:${agent}`,
				workspaceDir: "/tmp/memongo-erasure-fence-e2e",
				config: kitMongoConfig({
					episodes: { enabled: false, minEventsForEpisode: 6 },
				}),
				closed: false,
				writeQueue: queuedAhead,
				writeQueueDepth: 0,
				memoryJobWorkerStopped: true,
				memoryJobOperationContexts: new Map(),
				startMemoryJobWorker: () => {},
				wakeMemoryJobWorker: () => {},
				schedulePostWriteDerivations: async () => {},
				scheduleQueryCacheInvalidation: () => {},
			})

			const staleWrite = manager.writeConversationEvent({
				role: "user",
				body: "must not cross erasure",
				scope: "agent",
			})
			const staleOutcome = staleWrite.then(
				(value) => ({ status: "fulfilled" as const, value }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			)

			let admitted = await gate(agent)
			for (let attempt = 0; !admitted && attempt < 100; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				admitted = await gate(agent)
			}
			expect(admitted).toMatchObject({ state: "open", epoch: 0 })

			const erase = await beginErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			await finalizeErasure({ db, prefix: PREFIX, token: erase })
			expect(await gate(agent)).toMatchObject({
				state: "open",
				epoch: erase.epoch,
			})
			releaseQueue()
			const staleResult = await staleOutcome
			expect(staleResult.status).toBe("rejected")
			if (staleResult.status === "rejected") {
				expect(isErasureGateConflictError(staleResult.reason)).toBe(true)
			}
			expect(
				await db
					.collection(`${PREFIX}events`)
					.countDocuments({ agentId: agent }),
			).toBe(0)
			expect(
				await db
					.collection(`${PREFIX}memory_jobs`)
					.countDocuments({ agentId: agent }),
			).toBe(0)

			const fresh = await manager.writeConversationEvent({
				role: "user",
				body: "fresh admission commits",
				scope: "agent",
			})
			const event = await db
				.collection(`${PREFIX}events`)
				.findOne({ eventId: fresh.eventId, agentId: agent })
			const job = await db
				.collection(`${PREFIX}memory_jobs`)
				.findOne({ jobId: `extraction-${fresh.eventId}`, agentId: agent })
			expect(event).not.toBeNull()
			expect(job).toMatchObject({ admissionEpoch: erase.epoch })
		},
		TIMEOUT,
	)

	it(
		"an active caller transaction cannot use a stale token through the join path",
		async () => {
			const agent = agentId("unsafe-join")
			const stale = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			const erase = await beginErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			const session = client.startSession()
			try {
				session.startTransaction()
				await expect(
					withFencedWrite({
						db,
						prefix: PREFIX,
						token: stale,
						session,
						fn: async (joined) => {
							await db
								.collection(DATA)
								.insertOne(
									{ agentId: agent, tag: "unsafe" },
									{ session: joined },
								)
						},
					}),
				).rejects.toSatisfy(isErasureGateConflictError)
			} finally {
				if (session.inTransaction()) {
					await session.abortTransaction()
				}
				await session.endSession()
			}
			expect(await dataRows(agent)).toBe(0)
			await finalizeErasure({ db, prefix: PREFIX, token: erase })
		},
		TIMEOUT,
	)

	it(
		"a different agent's stale token aborts the active outer transaction",
		async () => {
			const outerAgent = agentId("mixed-outer")
			const blockedAgent = agentId("mixed-blocked")
			const outerToken = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: outerAgent,
			})
			const blockedToken = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: blockedAgent,
			})
			const blockedErase = await beginErasure({
				db,
				prefix: PREFIX,
				agentId: blockedAgent,
			})
			const session = client.startSession()
			try {
				await expect(
					withFencedWrite({
						db,
						prefix: PREFIX,
						token: outerToken,
						session,
						fn: async (outerSession) => {
							await db
								.collection(DATA)
								.insertOne(
									{ agentId: outerAgent, tag: "must-roll-back" },
									{ session: outerSession },
								)
							await withFencedWrite({
								db,
								prefix: PREFIX,
								token: blockedToken,
								session: outerSession,
								fn: async (joined) => {
									await db
										.collection(DATA)
										.insertOne(
											{ agentId: blockedAgent, tag: "must-not-run" },
											{ session: joined },
										)
								},
							})
						},
					}),
				).rejects.toSatisfy(isErasureGateConflictError)
			} finally {
				await session.endSession()
			}
			expect(await dataRows(outerAgent)).toBe(0)
			expect(await dataRows(blockedAgent)).toBe(0)
			expect(await gate(outerAgent)).toMatchObject({ serial: 0 })
			await finalizeErasure({
				db,
				prefix: PREFIX,
				token: blockedErase,
			})
		},
		TIMEOUT,
	)

	it(
		"an erasure start cannot pass an in-flight fenced transaction",
		async () => {
			const agent = agentId("write-conflict")
			const token = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			const session = client.startSession()
			let beginSettled = false
			try {
				session.startTransaction()
				await withFencedWrite({
					db,
					prefix: PREFIX,
					token,
					session,
					fn: async (joined) => {
						await db
							.collection(DATA)
							.insertOne(
								{ agentId: agent, tag: "before-erase" },
								{ session: joined },
							)
					},
				})

				const beginPromise = beginErasure({
					db,
					prefix: PREFIX,
					agentId: agent,
				}).finally(() => {
					beginSettled = true
				})
				await new Promise((resolve) => setTimeout(resolve, 150))
				expect(beginSettled).toBe(false)

				await session.commitTransaction()
				const erase = await beginPromise
				expect(erase.epoch).toBe(1)
				await finalizeErasure({ db, prefix: PREFIX, token: erase })
			} finally {
				if (session.inTransaction()) {
					await session.abortTransaction()
				}
				await session.endSession()
			}
			expect(await dataRows(agent)).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"competing erase starts return exactly the epoch written by the winner",
		async () => {
			const agent = agentId("competing-start")
			const outcomes = await Promise.allSettled([
				beginErasure({
					db,
					prefix: PREFIX,
					agentId: agent,
				}),
				beginErasure({
					db,
					prefix: PREFIX,
					agentId: agent,
				}),
			])
			const winners = outcomes.filter((result) => result.status === "fulfilled")
			const losers = outcomes.filter((result) => result.status === "rejected")
			expect(winners).toHaveLength(1)
			expect(losers).toHaveLength(1)
			expect(
				isErasureGateConflictError((losers[0] as PromiseRejectedResult).reason),
			).toBe(true)

			const winner = (
				winners[0] as PromiseFulfilledResult<
					Awaited<ReturnType<typeof beginErasure>>
				>
			).value
			const retained = await gate(agent)
			expect(winner.epoch).toBe(1)
			expect(retained).toMatchObject({
				epoch: winner.epoch,
				state: "erasing",
				erase: { runId: winner.runId },
			})
			await finalizeErasure({ db, prefix: PREFIX, token: winner })
		},
		TIMEOUT,
	)

	it(
		"competing takeovers from the same observed run have one winner",
		async () => {
			const agent = agentId("competing-takeover")
			await beginErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})

			const metadata = metaCollection(db, PREFIX)
			let readCount = 0
			let releaseReads = () => {}
			const bothRead = new Promise<void>((resolve) => {
				releaseReads = resolve
			})
			const barrierMetadata = {
				findOne: async (
					filter: Filter<Document>,
					options?: FindOptions<Document>,
				) => {
					const result = await metadata.findOne(filter, options)
					readCount += 1
					if (readCount === 2) {
						releaseReads()
					}
					await bothRead
					return result
				},
				findOneAndUpdate: metadata.findOneAndUpdate.bind(metadata),
			} as unknown as Collection
			const barrierDb = {
				client: db.client,
				collection: (name: string) =>
					name === `${PREFIX}meta` ? barrierMetadata : db.collection(name),
			} as unknown as Db

			const outcomes = await Promise.allSettled([
				takeoverErasure({
					db: barrierDb,
					prefix: PREFIX,
					agentId: agent,
				}),
				takeoverErasure({
					db: barrierDb,
					prefix: PREFIX,
					agentId: agent,
				}),
			])
			const winners = outcomes.filter((result) => result.status === "fulfilled")
			const losers = outcomes.filter((result) => result.status === "rejected")
			expect(winners).toHaveLength(1)
			expect(losers).toHaveLength(1)
			expect(
				isErasureGateConflictError((losers[0] as PromiseRejectedResult).reason),
			).toBe(true)

			const winner = (
				winners[0] as PromiseFulfilledResult<
					Awaited<ReturnType<typeof takeoverErasure>>
				>
			).value
			expect(await gate(agent)).toMatchObject({
				epoch: winner.epoch,
				state: "erasing",
				erase: { runId: winner.runId },
			})
			await finalizeErasure({ db, prefix: PREFIX, token: winner })
		},
		TIMEOUT,
	)

	it(
		"repeated takeovers keep every superseded opaque token dead",
		async () => {
			const agent = agentId("opaque-takeover")
			const tokenA = await beginErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			const tokenB = await takeoverErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})

			const expectSuperseded = async (
				token: typeof tokenA,
				transition: string,
			) => {
				await expect(
					withFencedWrite({
						db,
						prefix: PREFIX,
						token,
						fn: async (session) => {
							await db
								.collection(DATA)
								.insertOne({ agentId: agent, transition }, { session })
						},
					}),
				).rejects.toSatisfy(isErasureGateConflictError)
				await expect(
					finalizeErasure({ db, prefix: PREFIX, token }),
				).rejects.toSatisfy(isErasureGateConflictError)
			}

			await expectSuperseded(tokenA, "after-b")

			// A JavaScript-compatible variable can still carry an obsolete
			// caller-selected ID. The public API must ignore that extra property.
			const takeoverWithObsoleteCallerId = {
				db,
				prefix: PREFIX,
				agentId: agent,
				runId: tokenA.runId,
			}
			const tokenC = await takeoverErasure(takeoverWithObsoleteCallerId)

			expect(new Set([tokenA.runId, tokenB.runId, tokenC.runId]).size).toBe(3)
			for (const token of [tokenA, tokenB]) {
				await expectSuperseded(token, "after-c")
			}
			expect(await dataRows(agent)).toBe(0)

			await withFencedWrite({
				db,
				prefix: PREFIX,
				token: tokenC,
				fn: async (session) => {
					await db
						.collection(DATA)
						.insertOne({ agentId: agent, transition: "current" }, { session })
				},
			})
			expect(await dataRows(agent)).toBe(1)
			await finalizeErasure({ db, prefix: PREFIX, token: tokenC })
			expect(await gate(agent)).toMatchObject({ state: "open", epoch: 1 })
		},
		TIMEOUT,
	)

	it(
		"begin rejects an unknown retained state without mutating it",
		async () => {
			const agent = agentId("unknown-state")
			const metadata = metaCollection(db, PREFIX)
			await metadata.replaceOne(
				{ _id: `tenant-erasure-epoch:${agent}` },
				{
					agentId: agent,
					epoch: 4,
					state: "garbage",
					serial: 7,
				},
				{ upsert: true },
			)
			const before = await metadata.findOne({
				_id: `tenant-erasure-epoch:${agent}`,
			})
			await expect(
				beginErasure({ db, prefix: PREFIX, agentId: agent }),
			).rejects.toSatisfy(isMalformedGateError)
			expect(
				await metadata.findOne({ _id: `tenant-erasure-epoch:${agent}` }),
			).toEqual(before)
		},
		TIMEOUT,
	)

	it(
		"begin and finalization never mutate or reopen a fractional epoch",
		async () => {
			const metadata = metaCollection(db, PREFIX)
			const beginAgent = agentId("fractional-begin")
			await metadata.replaceOne(
				{ _id: `tenant-erasure-epoch:${beginAgent}` },
				{ agentId: beginAgent, epoch: 1.5 },
				{ upsert: true },
			)
			const beginBefore = await metadata.findOne({
				_id: `tenant-erasure-epoch:${beginAgent}`,
			})
			await expect(
				beginErasure({ db, prefix: PREFIX, agentId: beginAgent }),
			).rejects.toSatisfy(isMalformedGateError)
			expect(
				await metadata.findOne({
					_id: `tenant-erasure-epoch:${beginAgent}`,
				}),
			).toEqual(beginBefore)

			const finalizeAgent = agentId("fractional-finalize")
			const runId = "malformed-run"
			await metadata.replaceOne(
				{ _id: `tenant-erasure-epoch:${finalizeAgent}` },
				{
					agentId: finalizeAgent,
					epoch: 1.5,
					state: "erasing",
					serial: 0,
					erase: { runId, startedAt: new Date() },
				},
				{ upsert: true },
			)
			const finalizeBefore = await metadata.findOne({
				_id: `tenant-erasure-epoch:${finalizeAgent}`,
			})
			await expect(
				finalizeErasure({
					db,
					prefix: PREFIX,
					token: {
						kind: "erasure",
						agentId: finalizeAgent,
						runId,
						epoch: 1,
					},
				}),
			).rejects.toSatisfy(isMalformedGateError)
			expect(
				await metadata.findOne({
					_id: `tenant-erasure-epoch:${finalizeAgent}`,
				}),
			).toEqual(finalizeBefore)
		},
		TIMEOUT,
	)

	it(
		"legacy bumpTenantErasureEpoch documents interoperate with the gate",
		async () => {
			const agent = agentId("legacy")
			// The preserved W1 helper bumps an absent gate into a legacy
			// epoch-only document; the new gate must read and fence it.
			expect(await bumpTenantErasureEpoch(db, PREFIX, agent)).toBe(1)
			const g = await gate(agent)
			expect(g).toMatchObject({ epoch: 1, state: "open", serial: 0 })
			const token = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			expect(token.epoch).toBe(1)
			await withFencedWrite({
				db,
				prefix: PREFIX,
				token,
				fn: async (session) => {
					await db
						.collection(DATA)
						.insertOne({ agentId: agent, tag: "legacy-write" }, { session })
				},
			})
			expect(await dataRows(agent)).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"an old admitted writer fails after erase and reopen while a fresh write succeeds",
		async () => {
			const agent = agentId("stale")
			const tokenOld = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			expect(tokenOld.epoch).toBe(0)

			const tokenErase = await beginErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			expect(tokenErase.epoch).toBe(1)

			// While erasing, the old admission token is rejected as in-progress.
			await expect(
				withFencedWrite({
					db,
					prefix: PREFIX,
					token: tokenOld,
					fn: async (session) => {
						await db
							.collection(DATA)
							.insertOne({ agentId: agent, tag: "stale" }, { session })
					},
				}),
			).rejects.toSatisfy(isErasureGateConflictError)

			await expect(
				captureAdmissionToken({
					db,
					prefix: PREFIX,
					agentId: agent,
				}),
			).rejects.toSatisfy(isErasureGateConflictError)

			await finalizeErasure({ db, prefix: PREFIX, token: tokenErase })

			// After reopen, the same old token is rejected as stale.
			await expect(
				withFencedWrite({
					db,
					prefix: PREFIX,
					token: tokenOld,
					fn: async (session) => {
						await db
							.collection(DATA)
							.insertOne({ agentId: agent, tag: "stale" }, { session })
					},
				}),
			).rejects.toSatisfy(isErasureGateConflictError)
			expect(await dataRows(agent)).toBe(0)

			// The post-erasure generation writes normally.
			const tokenFresh = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			expect(tokenFresh.epoch).toBe(1)
			await withFencedWrite({
				db,
				prefix: PREFIX,
				token: tokenFresh,
				fn: async (session) => {
					await db
						.collection(DATA)
						.insertOne({ agentId: agent, tag: "fresh" }, { session })
				},
			})
			expect(await dataRows(agent)).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"a paused old eraser cannot outlive a successor takeover or delete a fresh write",
		async () => {
			const agent = agentId("takeover")
			await db.collection(DATA).insertOne({ agentId: agent, tag: "old" })

			const tokenOldEraser = await beginErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			// The old eraser pauses; the successor takes over atomically.
			const tokenSuccessor = await takeoverErasure({
				db,
				prefix: PREFIX,
				agentId: agent,
			})

			// The successor sweeps the pre-erasure row.
			await withFencedWrite({
				db,
				prefix: PREFIX,
				token: tokenSuccessor,
				fn: async (session) => {
					await db
						.collection(DATA)
						.deleteMany({ agentId: agent, tag: "old" }, { session })
				},
			})
			expect(await dataRows(agent)).toBe(0)

			await expect(
				captureAdmissionToken({
					db,
					prefix: PREFIX,
					agentId: agent,
				}),
			).rejects.toSatisfy(isErasureGateConflictError)

			// The successor completes the erasure and reopens the gate.
			await finalizeErasure({ db, prefix: PREFIX, token: tokenSuccessor })
			expect(await gate(agent)).toMatchObject({ state: "open", epoch: 1 })

			// A fresh admitted write commits on the post-bump generation.
			const tokenFresh = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			await withFencedWrite({
				db,
				prefix: PREFIX,
				token: tokenFresh,
				fn: async (session) => {
					await db
						.collection(DATA)
						.insertOne({ agentId: agent, tag: "fresh" }, { session })
				},
			})
			expect(await dataRows(agent)).toBe(1)

			// The old eraser wakes up and tries to delete the fresh row: its
			// ownership token is obsolete, the batch aborts, the row survives.
			await expect(
				withFencedWrite({
					db,
					prefix: PREFIX,
					token: tokenOldEraser,
					fn: async (session) => {
						await db
							.collection(DATA)
							.deleteMany({ agentId: agent }, { session })
					},
				}),
			).rejects.toSatisfy(isErasureGateConflictError)
			expect(await dataRows(agent)).toBe(1)

			// Old ownership cannot finalize either.
			await expect(
				finalizeErasure({ db, prefix: PREFIX, token: tokenOldEraser }),
			).rejects.toSatisfy(isErasureGateConflictError)
			expect(await gate(agent)).toMatchObject({ state: "open", epoch: 1 })
			expect(await dataRows(agent)).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"a driver transaction retry reuses the captured token and never recaptures the epoch",
		async () => {
			const agent = agentId("retry")
			const token = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agent,
			})
			let attempts = 0
			await withFencedWrite({
				db,
				prefix: PREFIX,
				token,
				fn: async (session) => {
					attempts += 1
					await db
						.collection(DATA)
						.insertOne({ agentId: agent, attempt: attempts }, { session })
					if (attempts === 1) {
						throw transientError()
					}
				},
			})
			expect(attempts).toBe(2)
			// Exactly one row committed (the aborted attempt rolled back), and
			// only the winning attempt's gate fence survived.
			expect(await dataRows(agent)).toBe(1)
			expect(await gate(agent)).toMatchObject({ epoch: 0, serial: 1 })

			// The retried write used the SAME captured token: after a real
			// generation bump the same token is rejected instead of silently
			// recapturing a fresh epoch.
			const erase = await beginErasure({ db, prefix: PREFIX, agentId: agent })
			await finalizeErasure({ db, prefix: PREFIX, token: erase })
			await expect(
				withFencedWrite({
					db,
					prefix: PREFIX,
					token,
					fn: async (session) => {
						await db
							.collection(DATA)
							.insertOne(
								{ agentId: agent, tag: "must-not-commit" },
								{ session },
							)
					},
				}),
			).rejects.toSatisfy(isErasureGateConflictError)
			expect(await dataRows(agent)).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"an explicit nested-session join commits and aborts atomically with the outer write",
		async () => {
			// Commit case: the outer fenced write hosts the transaction on the
			// caller's session; the nested write joins it and applies its own
			// gate fence, and both rows commit together.
			const agentCommit = agentId("join-commit")
			const tokenCommit = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agentCommit,
			})
			const sessionCommit = client.startSession()
			try {
				await withFencedWrite({
					db,
					prefix: PREFIX,
					token: tokenCommit,
					session: sessionCommit,
					fn: async (session) => {
						await db
							.collection(DATA)
							.insertOne({ agentId: agentCommit, tag: "outer" }, { session })
						// Nested write joins the now-active transaction.
						await withFencedWrite({
							db,
							prefix: PREFIX,
							token: tokenCommit,
							session,
							fn: async (inner) => {
								await db
									.collection(DATA)
									.insertOne(
										{ agentId: agentCommit, tag: "inner" },
										{ session: inner },
									)
							},
						})
					},
				})
			} finally {
				await sessionCommit.endSession()
			}
			expect(await dataRows(agentCommit)).toBe(2)
			expect(await gate(agentCommit)).toMatchObject({ serial: 2 })

			// Abort case: the nested write throws after writing; the outer
			// transaction aborts and NOTHING commits, including the gate fence.
			const agentAbort = agentId("join-abort")
			const tokenAbort = await captureAdmissionToken({
				db,
				prefix: PREFIX,
				agentId: agentAbort,
			})
			const sessionAbort = client.startSession()
			try {
				await expect(
					withFencedWrite({
						db,
						prefix: PREFIX,
						token: tokenAbort,
						session: sessionAbort,
						fn: async (session) => {
							await db
								.collection(DATA)
								.insertOne({ agentId: agentAbort, tag: "outer" }, { session })
							await withFencedWrite({
								db,
								prefix: PREFIX,
								token: tokenAbort,
								session,
								fn: async (inner) => {
									await db
										.collection(DATA)
										.insertOne(
											{ agentId: agentAbort, tag: "inner" },
											{ session: inner },
										)
									throw new Error("nested failure")
								},
							})
						},
					}),
				).rejects.toThrow("nested failure")
			} finally {
				await sessionAbort.endSession()
			}
			expect(await dataRows(agentAbort)).toBe(0)
			expect(await gate(agentAbort)).toMatchObject({ serial: 0 })
		},
		TIMEOUT,
	)

	it(
		"fails closed on malformed retained state and gate write errors against the real server",
		async () => {
			// Malformed retained gate: capture, fence, and takeover all refuse.
			const agentMalformed = agentId("malformed")
			await metaCollection(db, PREFIX).replaceOne(
				{ _id: `tenant-erasure-epoch:${agentMalformed}` },
				{ agentId: agentMalformed, epoch: "three" },
				{ upsert: true },
			)
			await expect(
				captureAdmissionToken({
					db,
					prefix: PREFIX,
					agentId: agentMalformed,
				}),
			).rejects.toSatisfy(isMalformedGateError)
			await expect(
				withFencedWrite({
					db,
					prefix: PREFIX,
					token: { kind: "admission", agentId: agentMalformed, epoch: 0 },
					fn: async (session) => {
						await db
							.collection(DATA)
							.insertOne({ agentId: agentMalformed }, { session })
					},
				}),
			).rejects.toSatisfy(isMalformedGateError)
			await expect(
				takeoverErasure({ db, prefix: PREFIX, agentId: agentMalformed }),
			).rejects.toSatisfy(isMalformedGateError)
			expect(await dataRows(agentMalformed)).toBe(0)

			// A different malformed retained field is rejected before the
			// conditional mutation, so the document remains byte-for-byte stable.
			const agentWriteError = agentId("write-error")
			await metaCollection(db, PREFIX).replaceOne(
				{ _id: `tenant-erasure-epoch:${agentWriteError}` },
				{
					agentId: agentWriteError,
					epoch: 0,
					state: "open",
					serial: "not-a-number",
				},
				{ upsert: true },
			)
			const malformedBefore = await metaCollection(db, PREFIX).findOne({
				_id: `tenant-erasure-epoch:${agentWriteError}`,
			})
			await expect(
				withFencedWrite({
					db,
					prefix: PREFIX,
					token: { kind: "admission", agentId: agentWriteError, epoch: 0 },
					fn: async (session) => {
						await db
							.collection(DATA)
							.insertOne({ agentId: agentWriteError }, { session })
					},
				}),
			).rejects.toSatisfy(isMalformedGateError)
			const malformedAfter = await metaCollection(db, PREFIX).findOne({
				_id: `tenant-erasure-epoch:${agentWriteError}`,
			})
			expect(malformedAfter).toEqual(malformedBefore)
			expect(await dataRows(agentWriteError)).toBe(0)
		},
		TIMEOUT,
	)
})
