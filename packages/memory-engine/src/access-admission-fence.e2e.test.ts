import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { AccessTracker } from "./mongodb-access-tracker.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E80 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e80_access_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/access-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
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
		await client.close()
	}
})
it("drops original-read access after completed erasure", async () => {
	const agentId = `stale-${randomUUID()}`,
		eventId = randomUUID()
	const token = await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date()
	await db.collection(`${prefix}events`).insertOne({
		eventId,
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		body: "fixture memory",
		role: "user",
		timestamp: now,
		createdAt: now,
	})
	const tracker = new AccessTracker(db, prefix, agentId, {
		flushThreshold: 100,
	})
	try {
		Reflect.apply(tracker.recordAccess, tracker, [
			{ collection: "events", id: eventId },
			token,
		])
		expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
			"complete",
		)
		const gate = await readErasureGate({ db, prefix, agentId })
		const updated = await tracker.flush()
		const raw = await db
			.collection(`${prefix}access_events`)
			.find({ "meta.agentId": agentId })
			.toArray()
		const events = await db
			.collection(`${prefix}events`)
			.find({ agentId })
			.toArray()
		const afterGate = await readErasureGate({ db, prefix, agentId })
		evidence("stale", { token, gate, afterGate, updated, raw, events })
		expect(raw).toEqual([])
		expect(events).toEqual([])
		expect(afterGate).toEqual(gate)
		expect(updated).toBe(0)
	} finally {
		await tracker.close()
	}
})

async function seed(agentId: string, eventId = randomUUID()) {
	const token = await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date()
	await db.collection(`${prefix}events`).insertOne({
		eventId,
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		body: "fixture memory",
		role: "user",
		timestamp: now,
		createdAt: now,
	})
	return { token, eventId }
}
it("keeps stale and fresh epochs separate for the same recreated target", async () => {
	const agentId = `mixed-${randomUUID()}`
	const old = await seed(agentId)
	const tracker = new AccessTracker(db, prefix, agentId, {
		flushThreshold: 100,
	})
	try {
		tracker.recordAccess({ collection: "events", id: old.eventId }, old.token)
		expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
			"complete",
		)
		const fresh = await seed(agentId, old.eventId)
		tracker.recordAccess({ collection: "events", id: old.eventId }, fresh.token)
		expect(await tracker.flush()).toBe(1)
		const raw = await db
			.collection(`${prefix}access_events`)
			.find({ "meta.agentId": agentId })
			.toArray()
		const row = await db.collection(`${prefix}events`).findOne({ agentId })
		evidence("mixed", { old, fresh, raw, row })
		expect(raw).toHaveLength(1)
		expect(raw[0]?.count).toBe(1)
		expect(row?.accessCount).toBe(1)
		expect(await tracker.flush()).toBe(0)
	} finally {
		await tracker.close()
	}
})
it("rolls raw history and the gate back on canonical failure then retries the same batch", async () => {
	const agentId = `retry-${randomUUID()}`,
		{ token, eventId } = await seed(agentId)
	const tracker = new AccessTracker(db, prefix, agentId, {
		flushThreshold: 100,
	})
	const beforeGate = await readErasureGate({ db, prefix, agentId })
	const original = Collection.prototype.bulkWrite
	let failed = false
	const spy = vi
		.spyOn(Collection.prototype, "bulkWrite")
		.mockImplementation(function (
			this: Collection<Document>,
			...args: Parameters<typeof original>
		) {
			if (this.collectionName === `${prefix}events` && !failed) {
				failed = true
				return Promise.reject(new Error("owned canonical write failure"))
			}
			return original.apply(this, args)
		})
	try {
		tracker.recordAccess({ collection: "events", id: eventId }, token)
		expect(await tracker.flush()).toBe(0)
		expect(failed).toBe(true)
		const buffered = Reflect.get(tracker, "buffer") as Map<
			string,
			Array<{ batchId: string; admission: typeof token }>
		>
		const retained = [...buffered.values()][0]?.[0]
		expect(retained?.admission).toEqual(token)
		expect(
			await db
				.collection(`${prefix}access_events`)
				.countDocuments({ "meta.agentId": agentId }),
		).toBe(0)
		expect(
			(await db.collection(`${prefix}events`).findOne({ agentId }))
				?.accessCount,
		).toBeUndefined()
		expect(await readErasureGate({ db, prefix, agentId })).toEqual(beforeGate)
		spy.mockRestore()
		expect(await tracker.flush()).toBe(1)
		const raw = await db
			.collection(`${prefix}access_events`)
			.find({ "meta.agentId": agentId })
			.toArray()
		const row = await db.collection(`${prefix}events`).findOne({ agentId })
		evidence("retry", {
			retained,
			raw,
			row,
			gate: await readErasureGate({ db, prefix, agentId }),
		})
		expect(raw).toHaveLength(1)
		expect(raw[0]?.batchId).toBe(retained?.batchId)
		expect(row?.accessCount).toBe(1)
		expect(row?.appliedBatches).toEqual([retained?.batchId])
		expect(await tracker.flush()).toBe(0)
	} finally {
		spy.mockRestore()
		await tracker.close()
	}
})
it("close waits for a legacy record admission and persists its count", async () => {
	const agentId = `legacy-${randomUUID()}`,
		{ eventId } = await seed(agentId)
	const tracker = new AccessTracker(db, prefix, agentId, {
		flushThreshold: 100,
	})
	tracker.recordAccess({ collection: "events", id: eventId })
	await tracker.close()
	const raw = await db
		.collection(`${prefix}access_events`)
		.find({ "meta.agentId": agentId })
		.toArray()
	const row = await db.collection(`${prefix}events`).findOne({ agentId })
	evidence("legacy-close", { raw, row })
	expect(raw).toHaveLength(1)
	expect(row?.accessCount).toBe(1)
})
it("creates a missing ordinary sink inside the fenced transaction", async () => {
	const agentId = `missing-${randomUUID()}`,
		{ token, eventId } = await seed(agentId)
	await db.collection(`${prefix}access_events`).drop()
	const tracker = new AccessTracker(db, prefix, agentId, {
		flushThreshold: 100,
	})
	try {
		tracker.recordAccess({ collection: "events", id: eventId }, token)
		expect(await tracker.flush()).toBe(1)
		const info = await db
			.listCollections({ name: `${prefix}access_events` })
			.toArray()
		const raw = await db
			.collection(`${prefix}access_events`)
			.find({ "meta.agentId": agentId })
			.toArray()
		evidence("missing-sink", { info, raw })
		expect(info[0]?.type).toBe("collection")
		expect(raw).toHaveLength(1)
	} finally {
		await tracker.close()
	}
})
it("rejects another agent's token without touching either gate", async () => {
	const agentId = `owner-${randomUUID()}`,
		{ eventId } = await seed(agentId)
	const other = await captureAdmissionToken({
		db,
		prefix,
		agentId: `other-${randomUUID()}`,
	})
	const gate = await readErasureGate({ db, prefix, agentId })
	const tracker = new AccessTracker(db, prefix, agentId)
	try {
		tracker.recordAccess({ collection: "events", id: eventId }, other)
		expect(await tracker.flush()).toBe(0)
		expect(
			await db
				.collection(`${prefix}access_events`)
				.countDocuments({ "meta.agentId": agentId }),
		).toBe(0)
		expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
	} finally {
		await tracker.close()
	}
})
it("retains fenced canonical reinforcement but writes no raw time-series history", async () => {
	const agentId = `timeseries-${randomUUID()}`,
		{ token, eventId } = await seed(agentId)
	await db.collection(`${prefix}access_events`).drop()
	await db.createCollection(`${prefix}access_events`, {
		timeseries: { timeField: "ts", metaField: "meta" },
	})
	const tracker = new AccessTracker(db, prefix, agentId, {
		flushThreshold: 100,
	})
	try {
		tracker.recordAccess({ collection: "events", id: eventId }, token)
		expect(await tracker.flush()).toBe(1)
		const row = await db.collection(`${prefix}events`).findOne({ agentId })
		const raw = await db
			.collection(`${prefix}access_events`)
			.find({ "meta.agentId": agentId })
			.toArray()
		const info = await db
			.listCollections({ name: `${prefix}access_events` })
			.toArray()
		evidence("time-series", { row, raw, info })
		expect(row?.accessCount).toBe(1)
		expect(raw).toEqual([])
		expect(info[0]?.type).toBe("timeseries")
		expect(await tracker.flush()).toBe(0)
	} finally {
		await tracker.close()
	}
})
