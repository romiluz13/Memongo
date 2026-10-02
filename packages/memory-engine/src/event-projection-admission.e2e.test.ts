import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { ensureCollections } from "./mongodb-schema.js"
import { writeEvent } from "./mongodb-events.js"
import { readErasureGate } from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E128 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e128_projection_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/event-projection-${label}.json`,
			JSON.stringify(data),
		)
}
function entry() {
	const agentId = `agent-${randomUUID()}`,
		host = {
			db,
			prefix,
			client,
			agentId,
			closed: false,
			config: {
				mongodb: {
					embeddingMode: "manual",
					episodes: { enabled: false, minEventsForEpisode: 6 },
				},
			},
			workspaceDir: "/tmp/memongo-e125-no-files",
			writeQueue: Promise.resolve(),
			writeQueueDepth: 0,
			chunkCount: 0,
			dirty: true,
			memoryJobWorkerStopped: true,
			memoryJobOperationContexts: new Map(),
			shouldRunPostWriteDerivedWork: () => false,
			schedulePostWriteDerivations: async () => {},
			scheduleQueryCacheInvalidation: () => {},
			startMemoryJobWorker: () => {},
			wakeMemoryJobWorker: () => {},
		}
	return {
		agentId,
		ops: new MongoDBManagerWriteOps(host as unknown as MongoDBManagerHost),
	}
}
async function write(
	e: ReturnType<typeof entry>,
	batch: boolean,
	secondBody = "Second durable event",
) {
	const input = {
		role: "user" as const,
		body: "Original durable event",
		scope: "agent" as const,
	}
	if (batch) {
		const receipts = await e.ops.writeConversationEventsBatch([
			input,
			{ ...input, body: secondBody },
		])
		expect(receipts).toHaveLength(2)
		for (const receipt of receipts) expect(receipt.ok).toBe(true)
		return receipts
	}
	const receipt = await e.ops.writeConversationEvent(input)
	expect(receipt.eventId).toBeTypeOf("string")
	return receipt
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
	return readErasureGate({ db: otherDb, prefix, agentId })
}
function beforeStage(stage: number, action: () => Promise<unknown>) {
	let explicit = 0,
		hit = false
	const start = client.startSession.bind(client)
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === stage) {
			const txn = session.withTransaction.bind(session)
			session.withTransaction = ((
				fn: Parameters<typeof txn>[0],
				options?: Parameters<typeof txn>[1],
			) =>
				txn(async (s) => {
					if (!hit) {
						hit = true
						await action()
					}
					return fn(s)
				}, options)) as typeof txn
		}
		return session
	})
	return () => hit
}
async function projectionRows(agentId: string) {
	return db
		.collection(`${prefix}projection_runs`)
		.find({ agentId, projectionType: "chunks" })
		.toArray()
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
	await other.connect()
	await ensureCollections(db, prefix)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
	try {
		await db.command({
			collMod: `${prefix}chunks`,
			validator: {},
			validationAction: "error",
		})
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		vi.unstubAllEnvs()
		await other.close()
		await client.close()
	}
})
it.each([
	false,
	true,
])("fresh public projection commits markers and accurate diagnostic batch=%s", async (batch) => {
	const e = entry()
	await write(e, batch)
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(batch ? 2 : 1)
	expect(
		await db
			.collection(`${prefix}events`)
			.countDocuments({ agentId: e.agentId, projectedAt: { $exists: true } }),
	).toBe(batch ? 2 : 1)
	expect(await projectionRows(e.agentId)).toEqual([
		expect.objectContaining({ status: "ok", itemsProjected: batch ? 2 : 1 }),
	])
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(5)
})
it.each([
	false,
	true,
])("old preprojection cannot recreate chunks or mark reimported IDs batch=%s", async (batch) => {
	const e = entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined,
		done = false
	const action = async () => {
		if (done) return
		done = true
		const old = await otherDb
			.collection(`${prefix}events`)
			.findOne({ agentId: e.agentId })
		expect(old?.eventId).toBeTypeOf("string")
		erased = await erase(e.agentId)
		await writeEvent({
			db: otherDb,
			prefix,
			event: {
				eventId: String(old?.eventId),
				agentId: e.agentId,
				role: "user",
				body: "Fresh reimport",
				timestamp: new Date(),
				scope: "agent",
				scopeRef: `agent:${e.agentId}`,
			},
		})
	}
	beforeStage(2, action)
	const update = Collection.prototype.updateOne,
		bulk = Collection.prototype.bulkWrite
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
		async function (this: Collection, filter, changes, options) {
			if (this.collectionName === `${prefix}chunks` && !options?.session)
				await action()
			return update.call(this, filter, changes, options)
		},
	)
	vi.spyOn(Collection.prototype, "bulkWrite").mockImplementation(
		async function (this: Collection, ops, options) {
			if (this.collectionName === `${prefix}chunks` && !options?.session)
				await action()
			return bulk.call(this, ops, options)
		},
	)
	const receipts = await write(e, batch)
	expect(done).toBe(true)
	expect(erased).toBeDefined()
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(0)
	const fresh = await db
		.collection(`${prefix}events`)
		.findOne({ agentId: e.agentId })
	expect(fresh?.body).toBe("Fresh reimport")
	expect(fresh?.projectedAt).toBeUndefined()
	expect(await projectionRows(e.agentId)).toEqual([])
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
	for (const receipt of Array.isArray(receipts) ? receipts : [receipts])
		expect("chunkCreated" in receipt && receipt.chunkCreated).toBe(false)
})
it.each([
	false,
	true,
])("marker failure rolls back chunk and records failed zero batch=%s", async (batch) => {
	const e = entry(),
		update = Collection.prototype.updateMany
	vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
		this: Collection,
		filter,
		changes,
		options,
	) {
		if (
			this.collectionName === `${prefix}events` &&
			!Array.isArray(changes) &&
			Reflect.has(changes.$set ?? {}, "projectedAt")
		)
			return Promise.reject(new Error("E128 marker failure"))
		return update.call(this, filter, changes, options)
	})
	const receipts = await write(e, batch)
	expect(
		await db
			.collection(`${prefix}events`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(batch ? 2 : 1)
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(0)
	expect(
		await db
			.collection(`${prefix}events`)
			.countDocuments({ agentId: e.agentId, projectedAt: { $exists: true } }),
	).toBe(0)
	expect(await projectionRows(e.agentId)).toEqual([
		expect.objectContaining({ status: "failed", itemsProjected: 0 }),
	])
	for (const receipt of Array.isArray(receipts) ? receipts : [receipts])
		expect("chunkCreated" in receipt && receipt.chunkCreated).toBe(false)
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(4)
})
it("real unordered bulk validation error rolls back successful earlier items", async () => {
	const e = entry()
	await db.command({
		collMod: `${prefix}chunks`,
		validator: { text: { $not: { $regex: "Reject this chunk" } } },
		validationAction: "error",
	})
	try {
		const receipts = await write(e, true, "Reject this chunk")
		expect(
			await db
				.collection(`${prefix}events`)
				.countDocuments({ agentId: e.agentId }),
		).toBe(2)
		expect(
			await db
				.collection(`${prefix}chunks`)
				.countDocuments({ agentId: e.agentId }),
		).toBe(0)
		expect(
			await db
				.collection(`${prefix}events`)
				.countDocuments({ agentId: e.agentId, projectedAt: { $exists: true } }),
		).toBe(0)
		expect(await projectionRows(e.agentId)).toEqual([
			expect.objectContaining({ status: "failed", itemsProjected: 0 }),
		])
		for (const receipt of Array.isArray(receipts) ? receipts : [receipts])
			expect("chunkCreated" in receipt && receipt.chunkCreated).toBe(false)
	} finally {
		await db.command({
			collMod: `${prefix}chunks`,
			validator: {},
			validationAction: "error",
		})
	}
})
it.each([
	false,
	true,
])("old completed projection diagnostic cannot resurrect batch=%s", async (batch) => {
	const e = entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined,
		done = false
	const action = async () => {
		if (done) return
		done = true
		erased = await erase(e.agentId)
	}
	beforeStage(3, action)
	const insert = Collection.prototype.insertOne
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
		async function (this: Collection, doc, options) {
			if (
				this.collectionName === `${prefix}projection_runs` &&
				!options?.session
			)
				await action()
			return insert.call(this, doc, options)
		},
	)
	await write(e, batch)
	expect(done).toBe(true)
	expect(await projectionRows(e.agentId)).toEqual([])
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it.each([
	false,
	true,
])("known-aborted projection replay remains coherent batch=%s", async (batch) => {
	const e = entry(),
		start = client.startSession.bind(client)
	let explicit = 0,
		attempts = 0
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 2) {
			const commit = session.commitTransaction.bind(session)
			vi.spyOn(session, "commitTransaction").mockImplementation(
				async (...args) => {
					if (++attempts === 1) {
						await session.abortTransaction()
						throw new MongoServerError({
							message: "E128 retry",
							code: 112,
							errorLabels: ["TransientTransactionError"],
						})
					}
					return commit(...args)
				},
			)
		}
		return session
	})
	await write(e, batch)
	expect(attempts).toBe(2)
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(batch ? 2 : 1)
	expect(await projectionRows(e.agentId)).toEqual([
		expect.objectContaining({ status: "ok", itemsProjected: batch ? 2 : 1 }),
	])
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(5)
})

it.each([
	false,
	true,
])("failure diagnostic cannot resurrect after projection abort batch=%s", async (batch) => {
	const e = entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined,
		done = false
	const action = async () => {
		if (done) return
		done = true
		erased = await erase(e.agentId)
	}
	beforeStage(3, action)
	const update = Collection.prototype.updateMany
	vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
		this: Collection,
		filter,
		changes,
		options,
	) {
		if (
			this.collectionName === `${prefix}events` &&
			!Array.isArray(changes) &&
			Reflect.has(changes.$set ?? {}, "projectedAt")
		) {
			if (!options?.session)
				return action().then(() => {
					throw new Error("E128 legacy marker failure")
				})
			return Promise.reject(new Error("E128 admitted marker failure"))
		}
		return update.call(this, filter, changes, options)
	})
	await write(e, batch)
	expect(done).toBe(true)
	expect(erased).toBeDefined()
	expect(await projectionRows(e.agentId)).toEqual([])
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it.each([
	false,
	true,
])("abort before erasure at marker prevents old chunk replay batch=%s", async (batch) => {
	const e = entry(),
		update = Collection.prototype.updateMany
	let hit = false,
		erased: Awaited<ReturnType<typeof erase>> | undefined
	vi.spyOn(Collection.prototype, "updateMany").mockImplementation(
		async function (this: Collection, filter, changes, options) {
			if (
				!hit &&
				this.collectionName === `${prefix}events` &&
				!Array.isArray(changes) &&
				Reflect.has(changes.$set ?? {}, "projectedAt")
			) {
				hit = true
				if (options?.session) await options.session.abortTransaction()
				const old = await otherDb
					.collection(`${prefix}events`)
					.findOne({ agentId: e.agentId })
				erased = await erase(e.agentId)
				await writeEvent({
					db: otherDb,
					prefix,
					event: {
						eventId: String(old?.eventId),
						agentId: e.agentId,
						role: "user",
						body: "Fresh after aborted projection",
						timestamp: new Date(),
						scope: "agent",
						scopeRef: `agent:${e.agentId}`,
					},
				})
				if (options?.session)
					throw new MongoServerError({
						message: "E128 abort-before-erasure",
						code: 112,
						errorLabels: ["TransientTransactionError"],
					})
			}
			return update.call(this, filter, changes, options)
		},
	)
	await write(e, batch)
	expect(hit).toBe(true)
	expect(erased).toBeDefined()
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(0)
	expect(
		(await db.collection(`${prefix}events`).findOne({ agentId: e.agentId }))
			?.projectedAt,
	).toBeUndefined()
	expect(await projectionRows(e.agentId)).toEqual([])
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
