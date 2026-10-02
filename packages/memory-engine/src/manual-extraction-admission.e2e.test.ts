import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E101 requires owned local MongoDB")
const client = new MongoClient(uri),
	name = `memongo_e101_manual_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_",
	jobs = db.collection(`${prefix}memory_jobs`),
	events = db.collection(`${prefix}events`)
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/manual-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
function manager(agentId: string) {
	const start = vi.fn(),
		wake = vi.fn()
	const host = {
		db,
		prefix,
		agentId,
		closed: false,
		memoryJobWorkerStopped: true,
		memoryJobOperationContexts: new Map(),
		startMemoryJobWorker: start,
		wakeMemoryJobWorker: wake,
		isDuplicateKeyError: (error: unknown) =>
			Reflect.get(Object(error), "code") === 11000,
	} as unknown as MongoDBManagerHost
	const ops = new MongoDBManagerJobsOps(host),
		writes = new MongoDBManagerWriteOps(host)
	host.scheduleBackgroundExtraction = (...args) =>
		Reflect.apply(ops.scheduleBackgroundExtraction, ops, args)
	return { host, ops, writes, start, wake }
}
async function schedule(
	ops: MongoDBManagerJobsOps,
	eventId: string,
	admission: AdmissionToken,
) {
	return Reflect.apply(ops.scheduleBackgroundExtraction, ops, [
		eventId,
		undefined,
		undefined,
		{ admission },
	])
}
async function erase(agentId: string) {
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	return readErasureGate({ db, prefix, agentId })
}
async function failed(
	agentId: string,
	eventId: string,
	admissionEpoch?: unknown,
) {
	await jobs.insertOne({
		agentId,
		jobId: `extraction-${eventId}`,
		jobType: "extraction",
		status: "failed",
		createdAt: new Date(),
		attempts: 1,
		payload: { eventId },
		...(admissionEpoch === undefined ? {} : { admissionEpoch }),
	})
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
	await jobs.createIndex({ agentId: 1, jobId: 1 }, { unique: true })
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
it("rejects an original stale token before creating a missing job", async () => {
	const agentId = `stale-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		gate = await erase(agentId),
		{ ops, start } = manager(agentId)
	await expect(schedule(ops, "missing", admission)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await jobs.find({ agentId }).toArray()).toEqual([])
	expect(start).not.toHaveBeenCalled()
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})
it("captures before scoped event reads that straddle erasure", async () => {
	const agentId = `scope-${randomUUID()}`,
		eventId = "owned",
		{ writes, start } = manager(agentId)
	await events.insertOne({
		agentId,
		eventId,
		role: "user",
		body: "owned",
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		timestamp: new Date(),
		validAt: new Date(),
	})
	const original = Collection.prototype.findOne
	const spy = vi
		.spyOn(Collection.prototype, "findOne")
		.mockImplementation(async function (this: Collection, ...args) {
			const result = await Reflect.apply(original, this, args)
			if (
				this.collectionName === events.collectionName &&
				Reflect.get(args[0], "agentId") === agentId
			)
				await erase(agentId)
			return result
		})
	try {
		await expect(
			writes.extractEvent({
				eventId,
				scope: "agent",
				scopeRef: `agent:${agentId}`,
			}),
		).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	} finally {
		spy.mockRestore()
	}
	expect(await jobs.find({ agentId }).toArray()).toEqual([])
	expect(start).not.toHaveBeenCalled()
})
it("creates fresh jobs with the original epoch and wake token", async () => {
	const agentId = `fresh-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ ops, start } = manager(agentId)
	await expect(schedule(ops, "fresh", admission)).resolves.toEqual({
		jobId: "extraction-fresh",
		scheduled: true,
	})
	expect(await jobs.findOne({ agentId })).toMatchObject({
		admissionEpoch: admission.epoch,
		status: "pending",
	})
	expect(start).toHaveBeenCalledWith(admission, 0)
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(1)
})
it.each([
	1,
	"bad",
])("rejects an explicitly incompatible stored epoch %s", async (stored) => {
	const agentId = `epoch-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ ops, start } = manager(agentId)
	await failed(agentId, "old", stored)
	const gate = await readErasureGate({ db, prefix, agentId })
	await expect(schedule(ops, "old", admission)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await jobs.findOne({ agentId })).toMatchObject({
		status: "failed",
		admissionEpoch: stored,
	})
	expect(start).not.toHaveBeenCalled()
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})
it("upgrades a legacy failed retry under the current original admission", async () => {
	const agentId = `legacy-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ ops, start } = manager(agentId)
	await failed(agentId, "legacy")
	await expect(schedule(ops, "legacy", admission)).resolves.toEqual({
		jobId: "extraction-legacy",
		scheduled: true,
	})
	expect(await jobs.findOne({ agentId })).toMatchObject({
		status: "pending",
		admissionEpoch: admission.epoch,
	})
	expect(start).toHaveBeenCalledWith(admission, 0)
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(1)
})
it("rejects erasure between duplicate abort and the recovery fence", async () => {
	const agentId = `second-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ ops, start } = manager(agentId),
		original = Collection.prototype.insertOne
	await failed(agentId, "second", admission.epoch)
	const spy = vi
		.spyOn(Collection.prototype, "insertOne")
		.mockImplementation(async function (this: Collection, ...args) {
			try {
				return await Reflect.apply(original, this, args)
			} catch (error) {
				if (
					this.collectionName === jobs.collectionName &&
					Reflect.get(args[0], "agentId") === agentId
				) {
					if (args[1]?.session?.inTransaction())
						await args[1].session.abortTransaction()
					await erase(agentId)
				}
				throw error
			}
		})
	try {
		await expect(schedule(ops, "second", admission)).rejects.toMatchObject({
			code: "ERASURE_GATE_CONFLICT",
		})
	} finally {
		spy.mockRestore()
	}
	expect(await jobs.find({ agentId }).toArray()).toEqual([])
	expect(start).not.toHaveBeenCalled()
})

it("rolls back an actual failed-job retry and its gate on ordinary failure", async () => {
	const agentId = `rollback-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ ops, start } = manager(agentId),
		fault = new Error("owned retry failure")
	await failed(agentId, "rollback", admission.epoch)
	const gate = await readErasureGate({ db, prefix, agentId }),
		original = Collection.prototype.updateOne
	const spy = vi
		.spyOn(Collection.prototype, "updateOne")
		.mockImplementation(async function (this: Collection, ...args) {
			const result = await Reflect.apply(original, this, args)
			if (
				this.collectionName === jobs.collectionName &&
				Reflect.get(args[0], "agentId") === agentId
			)
				throw fault
			return result
		})
	try {
		await expect(schedule(ops, "rollback", admission)).rejects.toBe(fault)
	} finally {
		spy.mockRestore()
	}
	expect(await jobs.findOne({ agentId })).toMatchObject({ status: "failed" })
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
	expect(start).not.toHaveBeenCalled()
})
it("keeps legacy pending rows unchanged and completed jobs unscheduled", async () => {
	const agentId = `parity-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ ops, start } = manager(agentId)
	await jobs.insertMany(
		["pending", "completed"].map((status) => ({
			agentId,
			jobId: `extraction-${status}`,
			jobType: "extraction",
			status,
			createdAt: new Date(),
			payload: { eventId: status },
		})),
	)
	await expect(schedule(ops, "pending", admission)).resolves.toEqual({
		jobId: "extraction-pending",
		scheduled: true,
	})
	expect(await jobs.findOne({ agentId, status: "pending" })).not.toHaveProperty(
		"admissionEpoch",
	)
	start.mockClear()
	await expect(schedule(ops, "completed", admission)).resolves.toEqual({
		jobId: "extraction-completed",
		scheduled: false,
	})
	expect(start).not.toHaveBeenCalled()
})
