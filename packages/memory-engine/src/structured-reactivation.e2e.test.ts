import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import {
	getStructuredMemoryByHandle,
	getStructuredMemoryHistoryByHandle,
	invalidateStructuredMemoryByHandle,
	updateStructuredMemoryByHandle,
	writeStructuredMemory,
	type StructuredMemoryEntry,
} from "./mongodb-structured-memory.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	buildCurrentValidityClause,
	buildUnexpiredClause,
} from "./mongodb-temporal.js"
import {
	captureAdmissionToken,
	type AdmissionToken,
} from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E142 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e142_reassert_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/reactivation-${label}.json`,
			JSON.stringify(data),
		)
}
function entry(): StructuredMemoryEntry {
	return {
		agentId: randomUUID(),
		type: "fact",
		key: "favorite-city",
		value: "Berlin",
		scope: "agent",
	}
}
async function token(agentId: string) {
	return captureAdmissionToken({ db, prefix, agentId })
}
async function write(value: StructuredMemoryEntry, admission: AdmissionToken) {
	return writeStructuredMemory({
		db,
		prefix,
		entry: value,
		admission,
		embeddingMode: "automated",
	})
}
async function seedClosed(expiresAt?: Date) {
	const value = entry(),
		admission = await token(value.agentId)
	const t0 = new Date(Date.now() - 60_000)
	await write(
		{ ...value, validFrom: t0, ...(expiresAt ? { expiresAt } : {}) },
		admission,
	)
	const identity = { agentId: value.agentId, type: value.type, key: value.key }
	const row = await col.findOne(identity)
	expect(row).not.toBeNull()
	const handle = {
		family: "structured",
		id: `structured:${value.agentId}`,
		agentId: value.agentId,
		scope: "agent",
		scopeRef: `agent:${value.agentId}`,
		structured: { type: value.type, key: value.key },
		revision: 1,
		state: "active",
	} as const
	await invalidateStructuredMemoryByHandle({
		db,
		prefix,
		handle,
		admission,
		invalidatedBy: { reason: "old assertion ended" },
	})
	const closed = await col.findOne(identity)
	expect(closed?.state).toBe("invalidated")
	expect(closed?.validTo).toBeInstanceOf(Date)
	return { value, admission, identity, handle, t0, closed }
}
async function currentCount(identity: Record<string, unknown>, asOf: Date) {
	return col.countDocuments({
		...identity,
		state: "active",
		$and: [buildCurrentValidityClause({ asOf }), buildUnexpiredClause()],
	})
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
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
		await client.close()
	}
})
it("default same-value reassertion opens a new interval without filling the invalidated gap", async () => {
	const e = await seedClosed()
	const before = new Date()
	await write(e.value, e.admission)
	const row = await col.findOne(e.identity)
	expect(row?.state).toBe("active")
	expect(row?.revision).toBe(3)
	expect(row?.validFrom.getTime()).toBeGreaterThanOrEqual(before.getTime())
	expect(row).not.toHaveProperty("validTo")
	expect(row).not.toHaveProperty("invalidatedBy")
	expect(await currentCount(e.identity, new Date())).toBe(1)
	expect(
		await currentCount(e.identity, new Date(e.closed?.validTo.getTime())),
	).toBe(0)
	expect(await currentCount(e.identity, new Date(e.t0.getTime() + 1000))).toBe(
		0,
	)
	const history = await getStructuredMemoryHistoryByHandle({
		db,
		prefix,
		handle: e.handle,
	})
	expect(history).toHaveLength(3)
	expect(history[0].handle.state).toBe("active")
	expect(history[1].handle.state).toBe("invalidated")
	expect(history[1].handle.validTo).toEqual(e.closed?.validTo)
	expect(history[2].handle.validFrom).toEqual(row?.validFrom)
})
it("preserves the invalidated snapshot end on a changed-value reassertion", async () => {
	const e = await seedClosed()
	await write({ ...e.value, value: "Paris" }, e.admission)
	const snapshot = await db
		.collection(`${prefix}structured_mem_revisions`)
		.findOne({ ...e.identity, revision: 2 })
	expect(snapshot?.validTo).toEqual(e.closed?.validTo)
	const row = await col.findOne(e.identity)
	expect(row?.value).toBe("Paris")
	expect(row).not.toHaveProperty("invalidatedBy")
})
it.each([
	"past",
	"future",
] as const)("honors explicit %s validity bounds and removes stale invalidation reason", async (position) => {
	const e = await seedClosed()
	const start = new Date(Date.now() + (position === "past" ? -120_000 : 60_000))
	const end = new Date(start.getTime() + 30_000)
	await write(
		{ ...e.value, state: "active", validFrom: start, validTo: end },
		e.admission,
	)
	const row = await col.findOne(e.identity)
	expect(row?.validFrom).toEqual(start)
	expect(row?.validTo).toEqual(end)
	expect(row).not.toHaveProperty("invalidatedBy")
	expect(await currentCount(e.identity, new Date(start.getTime() + 1))).toBe(1)
	expect(await currentCount(e.identity, new Date(end.getTime()))).toBe(0)
})
it("does not open a new window when explicitly keeping the row invalidated", async () => {
	const e = await seedClosed()
	await write({ ...e.value, state: "invalidated" }, e.admission)
	const row = await col.findOne(e.identity)
	expect(row?.state).toBe("invalidated")
	expect(row?.validFrom).toEqual(e.t0)
	expect(row?.validTo).toEqual(e.closed?.validTo)
	expect(row?.invalidatedBy).toEqual(e.closed?.invalidatedBy)
	expect(await currentCount(e.identity, new Date())).toBe(0)
})
it("retains old expiry when a fresh assertion omits an expiry override", async () => {
	const expiry = new Date(Date.now() + 86_400_000)
	const e = await seedClosed(expiry)
	await col.updateOne(e.identity, {
		$set: { expiresAt: new Date(Date.now() - 1000) },
	})
	const old = await col.findOne(e.identity)
	await write(e.value, e.admission)
	const row = await col.findOne(e.identity)
	expect(row?.expiresAt).toEqual(old?.expiresAt)
	expect(await currentCount(e.identity, new Date())).toBe(0)
})
it("by-handle update still rejects an invalidated current row", async () => {
	const e = await seedClosed()
	const before = await col.findOne(e.identity)
	await expect(
		updateStructuredMemoryByHandle({
			db,
			prefix,
			handle: { ...e.handle, revision: 2, state: "invalidated" },
			patch: { value: "Paris" },
			embeddingMode: "automated",
			admission: e.admission,
		}),
	).rejects.toMatchObject({ reason: "invalidated" })
	expect(await col.findOne(e.identity)).toEqual(before)
})
it("same-value active reinforcement preserves its earliest validity start", async () => {
	const value = entry(),
		admission = await token(value.agentId)
	const start = new Date(Date.now() - 60_000)
	await write({ ...value, state: "active", validFrom: start }, admission)
	const stored = await col.findOne({ agentId: value.agentId })
	await write(
		{
			...value,
			state: "active",
			validFrom: new Date(),
			salience: stored?.salience,
			temporalScope: stored?.temporalScope,
			sourceReliability: stored?.sourceReliability,
		},
		admission,
	)
	const row = await col.findOne({ agentId: value.agentId })
	expect(row?.validFrom).toEqual(start)
	expect(row?.revision).toBe(1)
	expect(row?.reinforcementCount).toBe(2)
})
it("a fault after reactivation update rolls the row and snapshot back", async () => {
	const e = await seedClosed()
	const before = await col.findOne(e.identity)
	const revisionsBefore = await db
		.collection(`${prefix}structured_mem_revisions`)
		.find(e.identity)
		.toArray()
	const original = Collection.prototype.updateOne
	let hit = false
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
		async function (this: Collection, filter, update, options) {
			const result = await Reflect.apply(original, this, [
				filter,
				update,
				options,
			])
			if (
				!hit &&
				this.collectionName === `${prefix}structured_mem` &&
				options?.session
			) {
				hit = true
				throw new Error("owned reactivation fault after update")
			}
			return result
		},
	)
	await expect(write(e.value, e.admission)).rejects.toThrow(
		"owned reactivation fault",
	)
	vi.restoreAllMocks()
	expect(hit).toBe(true)
	expect(await col.findOne(e.identity)).toEqual(before)
	expect(
		await db
			.collection(`${prefix}structured_mem_revisions`)
			.find(e.identity)
			.toArray(),
	).toEqual(revisionsBefore)
	expect(
		await getStructuredMemoryByHandle({ db, prefix, handle: e.handle }),
	).not.toBeNull()
})
