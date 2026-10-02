import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { ensureCollections } from "./mongodb-schema.js"
import { readErasureGate } from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E125 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e125_diagnostics_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/event-diag-${label}.json`,
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
async function write(e: ReturnType<typeof entry>, batch: boolean) {
	const input = {
		role: "user" as const,
		body: "Original durable event",
		scope: "agent" as const,
	}
	if (batch) {
		const receipts = await e.ops.writeConversationEventsBatch([
			input,
			{ ...input, body: "Second durable event" },
		])
		expect(receipts).toHaveLength(2)
		for (const receipt of receipts) expect(receipt.ok).toBe(true)
		return receipts
	}
	const receipt = await e.ops.writeConversationEvent(input)
	expect(receipt.eventId).toBeTypeOf("string")
	return receipt
}
async function rows(agentId: string) {
	return {
		coverage: await db
			.collection(`${prefix}lane_coverage`)
			.find({ agentId })
			.toArray(),
		ingest: await db
			.collection(`${prefix}ingest_runs`)
			.find({ agentId })
			.toArray(),
	}
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
	return readErasureGate({ db: otherDb, prefix, agentId })
}
function pauseBeforeTail(agentId: string, tail: "coverage" | "ingest") {
	let done = false,
		explicit = 0
	let erasedGate: Awaited<ReturnType<typeof erase>>
	const start = client.startSession.bind(client),
		update = Collection.prototype.updateOne,
		insert = Collection.prototype.insertOne
	const trigger = async () => {
		if (!done) {
			done = true
			erasedGate = await erase(agentId)
		}
	}
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === (tail === "coverage" ? 4 : 5)) {
			const txn = session.withTransaction.bind(session)
			session.withTransaction = ((
				fn: Parameters<typeof txn>[0],
				options?: Parameters<typeof txn>[1],
			) =>
				txn(async (s) => {
					await trigger()
					return fn(s)
				}, options)) as typeof session.withTransaction
		}
		return session
	})
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
		async function (this: Collection, filter, changes, options) {
			if (
				tail === "coverage" &&
				this.collectionName === `${prefix}lane_coverage` &&
				!options?.session
			)
				await trigger()
			return update.call(this, filter, changes, options)
		},
	)
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
		async function (this: Collection, doc, options) {
			if (
				tail === "ingest" &&
				this.collectionName === `${prefix}ingest_runs` &&
				!options?.session
			)
				await trigger()
			return insert.call(this, doc, options)
		},
	)
	return { wasPaused: () => done, erasedGate: () => erasedGate }
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
it.each([
	false,
	true,
])("fresh event diagnostic tails commit same counts batch=%s", async (batch) => {
	const e = entry()
	await write(e, batch)
	const actual = await rows(e.agentId),
		gate = await readErasureGate({ db, prefix, agentId: e.agentId })
	expect(actual.coverage).toHaveLength(1)
	expect(actual.ingest).toHaveLength(1)
	expect(actual.coverage[0]?.lanes["raw-window"].count).toBe(batch ? 2 : 1)
	expect(actual.ingest[0]).toMatchObject({
		source: "event-write",
		status: "ok",
		itemsProcessed: batch ? 2 : 1,
		itemsFailed: 0,
	})
	expect(gate?.serial).toBe(5)
})
it.each(
	[false, true].flatMap((batch) =>
		["coverage", "ingest"].map((tail) => [batch, tail] as const),
	),
)("erasure before %s event tail %s prevents resurrection and preserves receipt", async (batch, tail) => {
	const e = entry(),
		barrier = pauseBeforeTail(e.agentId, tail as "coverage" | "ingest")
	await write(e, batch)
	expect(barrier.wasPaused()).toBe(true)
	expect(await rows(e.agentId)).toEqual({ coverage: [], ingest: [] })
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		barrier.erasedGate(),
	)
	expect(
		await db
			.collection(`${prefix}events`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(0)
})
it.each(
	[false, true].flatMap((batch) =>
		["coverage", "ingest"].map((tail) => [batch, tail] as const),
	),
)("failed %s event tail %s rolls back its serial while preserving canonical receipt", async (batch, tail) => {
	const e = entry(),
		update = Collection.prototype.updateOne,
		insert = Collection.prototype.insertOne,
		error = new Error("E125 diagnostic failed")
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
		this: Collection,
		filter,
		changes,
		options,
	) {
		if (tail === "coverage" && this.collectionName === `${prefix}lane_coverage`)
			return Promise.reject(error)
		return update.call(this, filter, changes, options)
	})
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		doc,
		options,
	) {
		if (tail === "ingest" && this.collectionName === `${prefix}ingest_runs`)
			return Promise.reject(error)
		return insert.call(this, doc, options)
	})
	await write(e, batch)
	const actual = await rows(e.agentId),
		gate = await readErasureGate({ db, prefix, agentId: e.agentId })
	expect(actual.coverage).toHaveLength(tail === "coverage" ? 0 : 1)
	expect(actual.ingest).toHaveLength(tail === "ingest" ? 0 : 1)
	expect(gate?.serial).toBe(4)
	expect(
		await db
			.collection(`${prefix}events`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(batch ? 2 : 1)
})
it.each([
	false,
	true,
])("diagnostic replay does not double counters or runs erased=%s", async (erased) => {
	const e = entry(),
		start = client.startSession.bind(client)
	let explicit = 0,
		attempts = 0
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 4) {
			const commit = session.commitTransaction.bind(session)
			vi.spyOn(session, "commitTransaction").mockImplementation(
				async (...args) => {
					if (++attempts === 1) {
						await session.abortTransaction()
						if (erased) await erase(e.agentId)
						throw new MongoServerError({
							message: "E125 replay",
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
	await write(e, false)
	const actual = await rows(e.agentId),
		gate = await readErasureGate({ db, prefix, agentId: e.agentId })
	if (erased) {
		expect(actual).toEqual({ coverage: [], ingest: [] })
		expect(gate?.epoch).toBe(1)
		expect(attempts).toBe(1)
	} else {
		expect(actual.coverage[0]?.lanes["raw-window"].count).toBe(1)
		expect(actual.ingest).toHaveLength(1)
		expect(gate?.serial).toBe(5)
		expect(attempts).toBe(2)
	}
})
