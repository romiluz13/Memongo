import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
	writeStructuredMemory,
	type StructuredMemoryEntry,
} from "./mongodb-structured-memory.js"
import { ensureCollections } from "./mongodb-schema.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E155 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e155_reinforce_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
const revisions = db.collection(`${prefix}structured_mem_revisions`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/reinforce-count-${label}.json`,
			JSON.stringify(value),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
	await ensureCollections(db, prefix)
})
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
		await client.close()
	}
})
function entry(): StructuredMemoryEntry {
	return {
		agentId: `agent-${randomUUID()}`,
		scope: "agent",
		type: "fact",
		key: "count-conflict",
		value: "stable fact",
		state: "active",
		salience: "normal",
		temporalScope: "ongoing",
		sourceReliability: 0.7,
		reinforcementCount: 7,
	}
}
async function write(value: StructuredMemoryEntry) {
	const session = client.startSession()
	try {
		return await session.withTransaction(() =>
			writeStructuredMemory({
				db,
				prefix,
				entry: value,
				embeddingMode: "automated",
				session,
				transactionalSideEffects: "inline",
			}),
		)
	} finally {
		await session.endSession()
	}
}
it("Mongo rejects set and inc on the same path without changing the row", async () => {
	const key = randomUUID()
	await db.collection("operators").insertOne({ key, count: 7 })
	await expect(
		db
			.collection("operators")
			.updateOne({ key }, { $set: { count: 7 }, $inc: { count: 1 } }),
	).rejects.toMatchObject({ code: 40 })
	expect(await db.collection("operators").findOne({ key })).toMatchObject({
		count: 7,
	})
})
it("same-value explicit-count reinforcement increments the stored count", async () => {
	const value = entry()
	await write(value)
	const result = await write({ ...value, reinforcementCount: 1 })
	expect(result).toMatchObject({ upserted: false, changed: true })
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 8,
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(0)
})
it("same-value reinforcement without an explicit count still increments", async () => {
	const value = entry()
	await write(value)
	const { reinforcementCount: _count, ...withoutCount } = value
	await write(withoutCount)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 8,
	})
})

it("reinforcement audit records stored increment even without incoming count", async () => {
	const value = entry()
	await write(value)
	const { reinforcementCount: _count, ...withoutCount } = value
	await write(withoutCount)
	const audit = await db
		.collection(`${prefix}memory_mutations`)
		.findOne({ agentId: value.agentId, operation: "update" })
	expect(audit).toMatchObject({
		oldValue: { reinforcementCount: 7 },
		newValue: { reinforcementCount: 8 },
		changedFields: expect.arrayContaining(["reinforcementCount"]),
	})
})
it("explicit zero cannot reset the stored count on reinforcement", async () => {
	const value = entry()
	await write(value)
	await write({ ...value, reinforcementCount: 0 })
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 8,
	})
})
it("a missing stored counter starts at one and its audit records one", async () => {
	const value = entry()
	const { reinforcementCount: _count, ...withoutCount } = value
	await write(withoutCount)
	await col.updateOne(
		{ agentId: value.agentId },
		{ $unset: { reinforcementCount: "" } },
	)
	await write(withoutCount)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 1,
	})
	expect(
		await db
			.collection(`${prefix}memory_mutations`)
			.findOne({ agentId: value.agentId, operation: "update" }),
	).toMatchObject({ newValue: { reinforcementCount: 1 } })
})
it("a changed value still persists the explicitly supplied counter", async () => {
	const value = entry()
	await write(value)
	await write({ ...value, value: "changed fact", reinforcementCount: 3 })
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		reinforcementCount: 3,
	})
	expect(await revisions.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 7,
	})
})

it("concurrent sessionless reinforcement receipts use each atomic post-count", async () => {
	const value = entry()
	await write(value)
	const { reinforcementCount: _count, ...withoutCount } = value
	const find = Collection.prototype.findOne,
		insert = Collection.prototype.insertOne
	let reads = 0
	let release: () => void = () => {}
	const barrier = new Promise<void>((r) => {
		release = r
	})
	let finish: () => void = () => {}
	const receiptsDone = new Promise<void>((r) => {
		finish = r
	})
	const counts: unknown[] = []
	vi.spyOn(Collection.prototype, "findOne").mockImplementation(async function (
		this: Collection,
		...args: Parameters<typeof find>
	) {
		const found = await find.apply(this, args)
		if (
			this.collectionName === col.collectionName &&
			args[0]?.agentId === value.agentId &&
			reads < 2
		) {
			reads++
			if (reads === 2) release()
			await barrier
		}
		return found
	})
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
		async function (this: Collection, ...args: Parameters<typeof insert>) {
			const result = await insert.apply(this, args)
			if (
				this.collectionName === `${prefix}memory_mutations` &&
				args[0].agentId === value.agentId &&
				args[0].operation === "update"
			) {
				counts.push(args[0].newValue?.reinforcementCount)
				if (counts.length === 2) finish()
			}
			return result
		},
	)
	try {
		await Promise.all([
			writeStructuredMemory({
				db,
				prefix,
				entry: withoutCount,
				embeddingMode: "automated",
			}),
			writeStructuredMemory({
				db,
				prefix,
				entry: withoutCount,
				embeddingMode: "automated",
			}),
		])
		await receiptsDone
	} finally {
		vi.restoreAllMocks()
	}
	expect(reads).toBe(2)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 9,
	})
	expect(counts.sort()).toEqual([8, 9])
})
it("a stale reinforcement revision rereads before applying the write", async () => {
	const value = entry()
	await write(value)
	const { reinforcementCount: _count, ...withoutCount } = value
	const find = Collection.prototype.findOne
	let moved = false
	vi.spyOn(Collection.prototype, "findOne").mockImplementation(async function (
		this: Collection,
		...args: Parameters<typeof find>
	) {
		const found = await find.apply(this, args)
		if (
			!moved &&
			this.collectionName === col.collectionName &&
			args[0]?.agentId === value.agentId
		) {
			moved = true
			await col.updateOne(
				{ agentId: value.agentId },
				{ $set: { value: "competing fact", revision: 2 } },
			)
		}
		return found
	})
	try {
		await writeStructuredMemory({
			db,
			prefix,
			entry: withoutCount,
			embeddingMode: "automated",
		})
	} finally {
		vi.restoreAllMocks()
	}
	expect(moved).toBe(true)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 3,
		value: value.value,
		reinforcementCount: 7,
	})
	expect(await revisions.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		value: "competing fact",
	})
})
