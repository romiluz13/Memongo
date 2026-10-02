import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { type Document, MongoClient, ObjectId } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
	invalidateStructuredMemoryByHandle,
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
	throw new Error("E150 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e150_generation_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
const revisions = db.collection(`${prefix}structured_mem_revisions`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/generation-${label}.json`,
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
		key: "favorite-city",
		value: "v1",
	}
}
async function write(e: StructuredMemoryEntry, transaction: boolean) {
	const params = { db, prefix, entry: e, embeddingMode: "automated" as const }
	if (transaction)
		await client.withSession(async (session) => {
			await session.withTransaction(async () => {
				await writeStructuredMemory({
					...params,
					session,
					transactionalSideEffects: "inline",
				})
			})
		})
	else await writeStructuredMemory(params)
}
async function oldLifetime(transaction: boolean) {
	const e = entry()
	await write(e, transaction)
	const old = await col.findOne({ agentId: e.agentId })
	expect(old).not.toBeNull()
	await write({ ...e, value: "v2" }, transaction)
	expect(await revisions.countDocuments({ agentId: e.agentId })).toBe(1)
	await col.deleteOne({ _id: old?._id })
	await write({ ...e, value: "w1" }, transaction)
	const current = await col.findOne({ agentId: e.agentId })
	expect(String(current?._id)).not.toBe(String(old?._id))
	return { e, old, current }
}
it.each([
	false,
	true,
])("keeps both lifetimes' revision one when transaction=%s", async (transaction) => {
	const { e, old, current } = await oldLifetime(transaction)
	await write({ ...e, value: "w2" }, transaction)
	const snapshots = await revisions.find({ agentId: e.agentId }).toArray()
	expect(snapshots).toHaveLength(2)
	expect(snapshots.find((d) => d.value === "v1")?.structuredId).toEqual(
		old?._id,
	)
	expect(snapshots.find((d) => d.value === "w1")?.structuredId).toEqual(
		current?._id,
	)
	expect(new Set(snapshots.map((d) => String(d._id))).size).toBe(2)
	expect(await col.findOne({ agentId: e.agentId })).toMatchObject({
		value: "w2",
		revision: 2,
	})
})
it.each([
	false,
	true,
])("invalidation keeps recreated snapshot when transaction=%s", async (transaction) => {
	const { e, current } = await oldLifetime(transaction)
	const handle = {
		family: "structured" as const,
		id: "structured:fixture",
		agentId: e.agentId,
		scope: "agent" as const,
		scopeRef: `agent:${e.agentId}`,
		structured: { type: e.type, key: e.key },
		revision: 1,
		state: "active" as const,
	}
	const params = { db, prefix, handle, invalidatedBy: { reason: "fixture" } }
	if (transaction)
		await client.withSession(async (session) => {
			await session.withTransaction(async () => {
				await invalidateStructuredMemoryByHandle({
					...params,
					session,
					transactionalSideEffects: "inline",
				})
			})
		})
	else await invalidateStructuredMemoryByHandle(params)
	const snapshots = await revisions.find({ agentId: e.agentId }).toArray()
	expect(snapshots).toHaveLength(2)
	expect(snapshots.find((d) => d.value === "w1")?.structuredId).toEqual(
		current?._id,
	)
	expect(await col.findOne({ agentId: e.agentId })).toMatchObject({
		state: "invalidated",
		revision: 2,
	})
})
it("distinguishes ObjectId, its string and a stored embedded id", async () => {
	const e = entry(),
		oid = new ObjectId()
	await write(e, true)
	const seed = await col.findOne({ agentId: e.agentId })
	expect(seed).not.toBeNull()
	const physicalIds = [oid, oid.toHexString(), { text: oid.toHexString() }]
	for (const [i, id] of physicalIds.entries()) {
		await col.deleteOne({ agentId: e.agentId })
		await db
			.collection<Document & { _id: unknown }>(col.collectionName)
			.insertOne({ ...seed, _id: id })
		await write({ ...e, value: `generation ${i} second` }, true)
	}
	const snapshots = await revisions
		.find({ agentId: e.agentId })
		.sort({ supersededAt: 1 })
		.toArray()
	expect(snapshots).toHaveLength(3)
	expect(snapshots.map((d) => d.structuredId)).toEqual(physicalIds)
	expect(new Set(snapshots.map((d) => String(d._id))).size).toBe(3)
})

it.each([
	false,
	true,
])("preserves same-generation duplicate semantics when transaction=%s", async (transaction) => {
	const e = entry()
	await write(e, transaction)
	const original = await col.findOne({ agentId: e.agentId })
	await write({ ...e, value: "v2" }, transaction)
	const snapshot = await revisions.findOne({ agentId: e.agentId })
	await col.updateOne(
		{ _id: original?._id },
		{ $set: { value: "v1", revision: 1 } },
	)
	if (transaction)
		await expect(write({ ...e, value: "v3" }, true)).rejects.toMatchObject({
			code: 11000,
		})
	else await write({ ...e, value: "v3" }, false)
	expect(await revisions.countDocuments({ agentId: e.agentId })).toBe(1)
	expect(await revisions.findOne({ agentId: e.agentId })).toEqual(snapshot)
	expect(await col.findOne({ agentId: e.agentId })).toMatchObject(
		transaction ? { value: "v1", revision: 1 } : { value: "v3", revision: 2 },
	)
})
