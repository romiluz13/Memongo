import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { type Document, MongoClient, ObjectId } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { ensureCollections } from "./mongodb-schema.js"
import type { MemoryStructuredStableHandle } from "./types.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("Structured history fixture requires owned local MongoDB")
const client = new MongoClient(uri)
const name = `memongo_structured_history_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const current = db.collection(`${prefix}structured_mem`)
const revisions = db.collection(`${prefix}structured_mem_revisions`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/history-${label}.json`,
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
async function seed() {
	const agentId = `agent-${randomUUID()}`
	const ops = new MongoDBManagerLifecycleOps({
		db,
		prefix,
		client,
		agentId,
		config: { mongodb: { embeddingMode: "automated" } },
	} as unknown as MongoDBManagerHost)
	const entry = { agentId, type: "fact" as const, key: "city", value: "first" }
	await ops.writeStructuredMemory(entry)
	const handle: MemoryStructuredStableHandle = {
		family: "structured",
		id: "structured:fact:city",
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		revision: 1,
		state: "active",
		structured: { type: "fact", key: "city" },
	}
	await ops.writeStructuredMemory({ ...entry, value: "second" })
	return { agentId, entry, handle, ops }
}
it("shows only the recreated document's history after real writes", async () => {
	const { agentId, entry, handle, ops } = await seed()
	const previous = await current.findOne({ agentId })
	await current.deleteOne({ agentId })
	await ops.writeStructuredMemory({ ...entry, value: "new first" })
	await ops.writeStructuredMemory({ ...entry, value: "new second" })
	expect((await current.findOne({ agentId }))?._id).not.toEqual(previous?._id)
	const before = await revisions.find({ agentId }).toArray()
	expect(before).toHaveLength(2)
	const history = await ops.getLifecycleHistory({ handle })
	expect(
		history.map((item) =>
			item.family === "structured" ? item.data.value : undefined,
		),
	).toEqual(["new first", "new second"])
	expect(await revisions.find({ agentId }).toArray()).toEqual(before)
})
it("excludes unbound legacy history without changing stored snapshots", async () => {
	const { agentId, handle, ops } = await seed()
	const snapshot = await revisions.findOne({ agentId })
	expect(snapshot).not.toBeNull()
	const { structuredId: _binding, ...legacy } = snapshot as Document
	await revisions.insertOne({
		...legacy,
		_id: new ObjectId(),
		value: "legacy",
		revision: 10,
	})
	const before = await revisions.find({ agentId }).toArray()
	const history = await ops.getLifecycleHistory({ handle })
	expect(
		history.map((item) =>
			item.family === "structured" ? item.data.value : undefined,
		),
	).toEqual(["first", "second"])
	expect(await revisions.find({ agentId }).toArray()).toEqual(before)
})
it("returns no current history after physical deletion", async () => {
	const { agentId, handle, ops } = await seed()
	await current.deleteOne({ agentId })
	const before = await revisions.find({ agentId }).toArray()
	expect(await ops.getLifecycleHistory({ handle })).toEqual([])
	expect(await revisions.find({ agentId }).toArray()).toEqual(before)
})
it("keeps ObjectId ownership distinct from a same-hex string", async () => {
	const { agentId, handle, ops } = await seed()
	const snapshot = await revisions.findOne({ agentId })
	expect(snapshot?.structuredId).toBeInstanceOf(ObjectId)
	await revisions.insertOne({
		...snapshot,
		_id: new ObjectId(),
		structuredId: (snapshot?.structuredId as ObjectId).toHexString(),
		value: "string identity",
		revision: 10,
	})
	const history = await ops.getLifecycleHistory({ handle })
	expect(
		history.map((item) =>
			item.family === "structured" ? item.data.value : undefined,
		),
	).toEqual(["first", "second"])
	expect(await revisions.countDocuments({ agentId })).toBe(2)
})
it("applies physical ownership before the history limit", async () => {
	const { agentId, handle, ops } = await seed()
	const snapshot = await revisions.findOne({ agentId })
	await revisions.insertMany(
		[50, 60, 70].map((revision) => ({
			...snapshot,
			_id: new ObjectId(),
			structuredId: new ObjectId(),
			value: "foreign",
			revision,
		})),
	)
	const history = await ops.getLifecycleHistory({ handle, limit: 2 })
	expect(
		history.map((item) =>
			item.family === "structured" ? item.data.value : undefined,
		),
	).toEqual(["first", "second"])
	expect(await revisions.countDocuments({ agentId })).toBe(4)
})
it("uses a legal embedded physical id as an equality value", async () => {
	const { agentId, entry, handle, ops } = await seed()
	const row = await current.findOne({ agentId })
	const physicalId = { text: new ObjectId().toHexString() }
	await current.deleteOne({ agentId })
	await db
		.collection<Document & { _id: unknown }>(current.collectionName)
		.insertOne({
			...row,
			_id: physicalId,
			value: "embedded first",
			revision: 1,
		})
	await ops.writeStructuredMemory({ ...entry, value: "embedded second" })
	expect(
		await revisions.findOne({ agentId, structuredId: { $eq: physicalId } }),
	).toMatchObject({ value: "embedded first", structuredId: physicalId })
	const history = await ops.getLifecycleHistory({ handle })
	expect(
		history.map((item) =>
			item.family === "structured" ? item.data.value : undefined,
		),
	).toEqual(["embedded first", "embedded second"])
})
it("retains bound revision ordering and an invalidated current row", async () => {
	const { agentId, handle, ops } = await seed()
	await ops.invalidateLifecycleItem(
		{ ...handle, revision: 2 },
		{ reason: "fixture" },
	)
	const history = await ops.getLifecycleHistory({ handle })
	expect(history.map((item) => item.historyKind)).toEqual([
		"revision",
		"revision",
		"current",
	])
	expect(history.map((item) => item.handle.revision)).toEqual([1, 2, 3])
	expect(history.at(-1)?.handle.state).toBe("invalidated")
	expect(await revisions.countDocuments({ agentId })).toBe(2)
})
