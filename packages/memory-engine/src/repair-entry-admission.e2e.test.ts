import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { projectChunksFromEvents, writeEvent } from "./mongodb-events.js"
import { ensureCollections } from "./mongodb-schema.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import {
	captureAdmissionToken,
	readErasureGate,
	beginErasure,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E132 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e132_repair_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/repair-entry-${label}.json`,
			JSON.stringify(data),
		)
}
function entry() {
	return { agentId: `agent-${randomUUID()}` }
}
async function event(
	e: ReturnType<typeof entry>,
	body = "Original repair content",
	eventId = randomUUID(),
) {
	await writeEvent({
		db,
		prefix,
		event: {
			eventId,
			agentId: e.agentId,
			role: "user",
			body,
			scope: "agent",
			scopeRef: `agent:${e.agentId}`,
			timestamp: new Date(),
		},
	})
	return eventId
}
async function token(e: ReturnType<typeof entry>) {
	return captureAdmissionToken({ db, prefix, agentId: e.agentId })
}
function repair(e: ReturnType<typeof entry>, admission?: AdmissionToken) {
	return projectChunksFromEvents({
		db,
		prefix,
		agentId: e.agentId,
		...(admission ? { admission } : {}),
	} as Parameters<typeof projectChunksFromEvents>[0])
}
async function rows(agentId: string) {
	return {
		chunks: await db.collection(`${prefix}chunks`).find({ agentId }).toArray(),
		events: await db.collection(`${prefix}events`).find({ agentId }).toArray(),
		runs: await db
			.collection(`${prefix}projection_runs`)
			.find({ agentId, projectionType: "chunks" })
			.toArray(),
	}
}
async function erase(e: ReturnType<typeof entry>) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId: e.agentId }))
			.status,
	).toBe("complete")
	return readErasureGate({ db, prefix, agentId: e.agentId })
}
function beforeStage(stage: number, action: () => Promise<unknown>) {
	const start = client.startSession.bind(client)
	let explicit = 0
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === stage) {
			const transaction = session.withTransaction.bind(session)
			session.withTransaction = ((fn, options) =>
				transaction(async (s) => {
					await action()
					return fn(s)
				}, options)) as typeof transaction
		}
		return session
	})
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
it("default repair projects then empty retry adds no serial or diagnostic", async () => {
	const e = entry()
	await event(e)
	expect(await repair(e)).toEqual({ eventsProcessed: 1, chunksCreated: 1 })
	const actual = await rows(e.agentId),
		gate = await readErasureGate({ db, prefix, agentId: e.agentId })
	expect(actual.chunks).toHaveLength(1)
	expect(actual.events[0].projectedAt).toBeInstanceOf(Date)
	expect(actual.runs).toEqual([
		expect.objectContaining({ status: "ok", itemsProjected: 1 }),
	])
	expect(gate?.serial).toBe(2)
	expect(await repair(e)).toEqual({ eventsProcessed: 0, chunksCreated: 0 })
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		gate,
	)
	expect((await rows(e.agentId)).runs).toHaveLength(1)
})
it.each([
	"wrong-kind",
	"wrong-owner",
	"malformed",
	"stale",
	"erasing",
])("supplied %s refuses before source query", async (mode) => {
	const e = entry()
	await event(e)
	const original = await token(e)
	if (mode === "stale") await erase(e)
	if (mode === "erasing")
		await beginErasure({ db: otherDb, prefix, agentId: e.agentId })
	const supplied =
		mode === "wrong-kind"
			? { ...original, kind: "erasure", runId: "wrong" }
			: mode === "wrong-owner"
				? { ...original, agentId: "foreign-agent" }
				: mode === "malformed"
					? { ...original, epoch: Number.NaN }
					: original
	const find = Collection.prototype.find
	let queries = 0
	vi.spyOn(Collection.prototype, "find").mockImplementation(function (
		this: Collection,
		filter,
		options,
	) {
		if (this.collectionName === `${prefix}events`) queries++
		return find.call(this, filter, options)
	})
	await expect(repair(e, supplied as AdmissionToken)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(queries).toBe(0)
})
it("default repair refuses while erasing before source query", async () => {
	const e = entry()
	await event(e)
	await beginErasure({ db: otherDb, prefix, agentId: e.agentId })
	const find = Collection.prototype.find
	let queries = 0
	vi.spyOn(Collection.prototype, "find").mockImplementation(function (
		this: Collection,
		filter,
		options,
	) {
		if (this.collectionName === `${prefix}events`) queries++
		return find.call(this, filter, options)
	})
	await expect(repair(e)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(queries).toBe(0)
})
it("retained source snapshot cannot project or mark same-ID fresh reimport", async () => {
	const e = entry(),
		id = await event(e),
		find = Collection.prototype.find
	let hit = false,
		erased: Awaited<ReturnType<typeof erase>> | undefined
	vi.spyOn(Collection.prototype, "find").mockImplementation(function (
		this: Collection,
		filter,
		options,
	) {
		const cursor = find.call(this, filter, options)
		if (
			!hit &&
			this.collectionName === `${prefix}events` &&
			Reflect.has(filter ?? {}, "projectedAt")
		) {
			hit = true
			const read = cursor.toArray.bind(cursor)
			vi.spyOn(cursor, "toArray").mockImplementation(async () => {
				const source = await read()
				erased = await erase(e)
				await writeEvent({
					db: otherDb,
					prefix,
					event: {
						eventId: id,
						agentId: e.agentId,
						role: "user",
						body: "Fresh reimport",
						scope: "agent",
						scopeRef: `agent:${e.agentId}`,
						timestamp: new Date(),
					},
				})
				return source
			})
		}
		return cursor
	})
	await expect(repair(e)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(hit).toBe(true)
	const actual = await rows(e.agentId)
	expect(actual.chunks).toEqual([])
	expect(actual.runs).toEqual([])
	expect(actual.events[0]).toMatchObject({ body: "Fresh reimport" })
	expect(actual.events[0].projectedAt).toBeUndefined()
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it.each([
	1, 2,
])("marker failure at item %s rolls back only that item and reports prior commits", async (item) => {
	const e = entry()
	await event(e)
	if (item === 2) await event(e, "Second repair content")
	const update = Collection.prototype.updateMany
	let markers = 0
	vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
		this: Collection,
		filter,
		changes,
		options,
	) {
		if (
			this.collectionName === `${prefix}events` &&
			!Array.isArray(changes) &&
			Reflect.has(changes.$set ?? {}, "projectedAt") &&
			++markers === item
		)
			return Promise.reject(new Error("E132 marker failure"))
		return update.call(this, filter, changes, options)
	})
	await expect(repair(e)).rejects.toThrow("E132 marker failure")
	const actual = await rows(e.agentId)
	expect(actual.chunks).toHaveLength(item - 1)
	expect(actual.events.filter((v) => v.projectedAt)).toHaveLength(item - 1)
	expect(actual.runs).toEqual([
		expect.objectContaining({ status: "failed", itemsProjected: item - 1 }),
	])
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(item)
})
it("success diagnostic failure preserves completed repair", async () => {
	const e = entry()
	await event(e)
	const insert = Collection.prototype.insertOne
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		doc,
		options,
	) {
		if (this.collectionName === `${prefix}projection_runs`)
			return Promise.reject(new Error("E132 diagnostic failure"))
		return insert.call(this, doc, options)
	})
	await expect(repair(e)).resolves.toEqual({
		eventsProcessed: 1,
		chunksCreated: 1,
	})
	const actual = await rows(e.agentId)
	expect(actual.chunks).toHaveLength(1)
	expect(actual.events[0].projectedAt).toBeInstanceOf(Date)
	expect(actual.runs).toEqual([])
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(1)
})
it.each([
	false,
	true,
])("old diagnostic does not resurrect failure=%s", async (failed) => {
	const e = entry()
	await event(e)
	let done = false,
		erased: Awaited<ReturnType<typeof erase>> | undefined
	const action = async () => {
		if (done) return
		done = true
		erased = await erase(e)
	}
	beforeStage(2, action)
	const update = Collection.prototype.updateMany,
		insert = Collection.prototype.insertOne
	vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
		this: Collection,
		filter,
		changes,
		options,
	) {
		if (
			failed &&
			this.collectionName === `${prefix}events` &&
			!Array.isArray(changes) &&
			Reflect.has(changes.$set ?? {}, "projectedAt")
		) {
			if (options?.session)
				return Promise.reject(new Error("E132 marker failure"))
			return action().then(() => {
				throw new Error("E132 marker failure")
			})
		}
		return update.call(this, filter, changes, options)
	})
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
	if (failed) await expect(repair(e)).rejects.toThrow("E132 marker failure")
	else await repair(e)
	expect(done).toBe(true)
	expect((await rows(e.agentId)).runs).toEqual([])
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it("known-aborted projection commit retries without duplicate chunk count", async () => {
	const e = entry()
	await event(e)
	const admission = await token(e),
		start = client.startSession.bind(client)
	let attempts = 0
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && attempts === 0) {
			const commit = session.commitTransaction.bind(session)
			vi.spyOn(session, "commitTransaction").mockImplementation(
				async (...commitArgs) => {
					if (++attempts === 1) {
						await session.abortTransaction()
						throw new MongoServerError({
							message: "E132 retry",
							code: 112,
							errorLabels: ["TransientTransactionError"],
						})
					}
					return commit(...commitArgs)
				},
			)
		}
		return session
	})
	expect(await repair(e, admission)).toEqual({
		eventsProcessed: 1,
		chunksCreated: 1,
	})
	expect(attempts).toBe(2)
	expect((await rows(e.agentId)).chunks).toHaveLength(1)
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(2)
})
