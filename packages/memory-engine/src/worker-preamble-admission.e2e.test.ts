import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	type AdmissionToken,
	beginErasure,
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E98 requires owned local MongoDB")
const client = new MongoClient(uri),
	name = `memongo_e98_worker_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/worker-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
function worker(agentId: string) {
	const repair = vi.fn(async () => ({
		eventsProcessed: 0,
		jobsCreated: 0,
		jobsReleased: 0,
		eventsFailed: 0,
	}))
	const prune = vi.fn(async (_params?: { admission?: AdmissionToken }) => ({
		pruned: 0,
	}))
	const host = {
		db,
		prefix,
		agentId,
		repairExtractionOutbox: repair,
		pruneIdempotencyFingerprints: prune,
		memoryJobWorkerStopped: true,
		isDuplicateKeyError: () => false,
	} as unknown as MongoDBManagerHost
	const ops = new MongoDBManagerJobsOps(host)
	return { host, ops, repair, prune }
}
async function erased(agentId: string) {
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	return readErasureGate({ db, prefix, agentId })
}
async function drainError(
	ops: MongoDBManagerJobsOps,
	admission: AdmissionToken,
) {
	let error: unknown
	try {
		await ops.drainMemoryJobQueue({ admission })
	} catch (caught) {
		error = caught
	}
	return error
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
	await db
		.collection(`${prefix}memory_jobs`)
		.createIndex({ agentId: 1, jobId: 1 }, { unique: true })
})
afterEach(() => vi.unstubAllEnvs())
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
it("rejects a stale admission even when outbox repair is empty", async () => {
	vi.stubEnv("MEMONGO_AUTO_CONSOLIDATION_MS", "0")
	const agentId = `stale-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		gate = await erased(agentId)
	const { ops, repair, prune } = worker(agentId),
		error = await drainError(ops, admission)
	evidence("stale", {
		gate,
		afterGate: await readErasureGate({ db, prefix, agentId }),
		repairCalls: repair.mock.calls.length,
		pruneCalls: prune.mock.calls.length,
	})
	expect(error).toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(repair).not.toHaveBeenCalled()
	expect(prune).not.toHaveBeenCalled()
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})
it("rejects a fresh capture during erasure before any preamble call", async () => {
	const agentId = `erasing-${randomUUID()}`
	await captureAdmissionToken({ db, prefix, agentId })
	await beginErasure({ db, prefix, agentId })
	const { ops, repair, prune } = worker(agentId)
	await expect(ops.drainMemoryJobQueue()).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(repair).not.toHaveBeenCalled()
	expect(prune).not.toHaveBeenCalled()
})
it("prunes only old fingerprints in one original gate transaction", async () => {
	const agentId = `prune-fresh-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const events = db.collection(`${prefix}events`),
		{ host } = worker(agentId)
	const at = new Date(),
		old = new Date(at.getTime() - 100 * 86_400_000)
	await events.insertMany(
		[old, at].map((recordedAt, index) => ({
			agentId,
			eventId: `event-${index}`,
			role: "user",
			body: "retained body",
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			timestamp: new Date(0),
			validAt: new Date(0),
			recordedAt,
			idempotencyKey: `key-${index}`,
			idempotencyFingerprint: `fingerprint-${index}`,
		})),
	)
	await expect(
		new MongoDBManagerWriteOps(host).pruneIdempotencyFingerprints({
			admission,
			force: true,
		}),
	).resolves.toEqual({ pruned: 1 })
	expect(
		await events.findOne({ agentId, eventId: "event-0" }),
	).not.toHaveProperty("idempotencyKey")
	expect(await events.findOne({ agentId, eventId: "event-1" })).toMatchObject({
		idempotencyKey: "key-1",
	})
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(1)
})
it.each([
	"prune",
	"stage",
	"deadletter",
] as const)("rejects erasure after entry and before %s", async (seam) => {
	vi.stubEnv("MEMONGO_AUTO_CONSOLIDATION_MS", seam === "stage" ? "1" : "0")
	const agentId = `barrier-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ host, ops, repair, prune } = worker(agentId)
	let gate: Awaited<ReturnType<typeof readErasureGate>> = null
	if (seam === "prune") {
		const writes = new MongoDBManagerWriteOps(host)
		repair.mockImplementationOnce(async () => {
			gate = await erased(agentId)
			return {
				eventsProcessed: 0,
				jobsCreated: 0,
				jobsReleased: 0,
				eventsFailed: 0,
			}
		})
		prune.mockImplementation((params) =>
			writes.pruneIdempotencyFingerprints({ ...params, force: true }),
		)
	} else
		prune.mockImplementationOnce(async () => {
			gate = await erased(agentId)
			return { pruned: 0 }
		})
	const error = await drainError(ops, admission),
		jobs = await db
			.collection(`${prefix}memory_jobs`)
			.find({ agentId })
			.toArray(),
		afterGate = await readErasureGate({ db, prefix, agentId })
	evidence(`barrier-${seam}`, { gate, afterGate, jobs })
	expect(error).toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(afterGate).toEqual(gate)
	expect(jobs).toEqual([])
})
it("deadletters expired jobs on the original gate session", async () => {
	vi.stubEnv("MEMONGO_AUTO_CONSOLIDATION_MS", "0")
	const agentId = `fresh-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ ops, repair, prune } = worker(agentId)
	await db.collection(`${prefix}memory_jobs`).insertOne({
		agentId,
		jobId: "expired",
		jobType: "extraction",
		status: "running",
		createdAt: new Date(),
		attempts: 3,
		leaseExpiresAt: new Date(0),
	})
	await ops.drainMemoryJobQueue({ admission })
	expect(repair).toHaveBeenCalledWith({ admission })
	expect(prune).toHaveBeenCalledWith({ admission })
	expect(
		await db.collection(`${prefix}memory_jobs`).findOne({ agentId }),
	).toMatchObject({ status: "failed" })
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(1)
})
it("rolls back a real prune mutation and gate on failure", async () => {
	const agentId = `rollback-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const events = db.collection(`${prefix}events`),
		at = new Date(0)
	await events.insertOne({
		agentId,
		eventId: "old",
		role: "user",
		body: "old",
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		timestamp: at,
		validAt: at,
		recordedAt: at,
		idempotencyKey: "retained-key",
		idempotencyFingerprint: "retained-fingerprint",
	})
	const gate = await readErasureGate({ db, prefix, agentId }),
		{ host } = worker(agentId),
		original = Collection.prototype.updateMany,
		fault = new Error("owned prune failure")
	const spy = vi
		.spyOn(Collection.prototype, "updateMany")
		.mockImplementation(async function (
			this: Collection,
			filter,
			update,
			options,
		) {
			const result = await Reflect.apply(original, this, [
				filter,
				update,
				options,
			])
			if (this.collectionName === events.collectionName) throw fault
			return result
		})
	try {
		await expect(
			new MongoDBManagerWriteOps(host).pruneIdempotencyFingerprints({
				admission,
				force: true,
			}),
		).rejects.toBe(fault)
	} finally {
		spy.mockRestore()
	}
	expect(await events.findOne({ agentId })).toMatchObject({
		idempotencyKey: "retained-key",
	})
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})

it("keeps the retention policy fixed through a real transaction retry", async () => {
	vi.stubEnv("MEMONGO_IDEMPOTENCY_RETENTION_DAYS", "90")
	const agentId = `retry-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ host } = worker(agentId),
		events = db.collection(`${prefix}events`),
		at = new Date()
	await events.insertMany(
		[100, 1].map((days, index) => ({
			agentId,
			eventId: `retry-${index}`,
			role: "user",
			body: "retained body",
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			timestamp: new Date(0),
			validAt: new Date(0),
			recordedAt: new Date(at.getTime() - days * 86_400_000),
			idempotencyKey: `retry-key-${index}`,
			idempotencyFingerprint: `retry-fingerprint-${index}`,
		})),
	)
	const original = Collection.prototype.updateMany
	let writes = 0
	const spy = vi
		.spyOn(Collection.prototype, "updateMany")
		.mockImplementation(async function (
			this: Collection,
			filter,
			update,
			options,
		) {
			const result = await Reflect.apply(original, this, [
				filter,
				update,
				options,
			])
			if (
				this.collectionName === events.collectionName &&
				Reflect.get(filter, "agentId") === agentId
			) {
				writes++
				if (writes === 1) {
					vi.stubEnv("MEMONGO_IDEMPOTENCY_RETENTION_DAYS", "0")
					const error = new MongoServerError({
						message: "owned transient prune failure",
						code: 112,
					})
					error.addErrorLabel("TransientTransactionError")
					throw error
				}
			}
			return result
		})
	try {
		await expect(
			new MongoDBManagerWriteOps(host).pruneIdempotencyFingerprints({
				admission,
				force: true,
			}),
		).resolves.toEqual({ pruned: 1 })
	} finally {
		spy.mockRestore()
	}
	expect(writes).toBe(2)
	expect(
		await events.findOne({ agentId, eventId: "retry-0" }),
	).not.toHaveProperty("idempotencyKey")
	expect(await events.findOne({ agentId, eventId: "retry-1" })).toMatchObject({
		idempotencyKey: "retry-key-1",
	})
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(1)
	evidence("retry", {
		writes,
		rows: await events.find({ agentId }).toArray(),
		gate: await readErasureGate({ db, prefix, agentId }),
	})
})

it("continues each drain after a rolled-back ordinary prune failure", async () => {
	vi.stubEnv("MEMONGO_AUTO_CONSOLIDATION_MS", "0")
	const agentId = `continue-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		{ host, ops, prune } = worker(agentId),
		events = db.collection(`${prefix}events`),
		jobs = db.collection(`${prefix}memory_jobs`),
		writes = new MongoDBManagerWriteOps(host),
		fault = new Error("owned persistent prune failure"),
		original = Collection.prototype.updateMany
	await events.insertOne({
		agentId,
		eventId: "old",
		role: "user",
		body: "old",
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		timestamp: new Date(0),
		validAt: new Date(0),
		recordedAt: new Date(0),
		idempotencyKey: "retained-key",
	})
	prune.mockImplementation((params) =>
		writes.pruneIdempotencyFingerprints({ ...params, force: true }),
	)
	let failures = 0
	const spy = vi
		.spyOn(Collection.prototype, "updateMany")
		.mockImplementation(async function (
			this: Collection,
			filter,
			update,
			options,
		) {
			const result = await Reflect.apply(original, this, [
				filter,
				update,
				options,
			])
			if (
				this.collectionName === events.collectionName &&
				Reflect.get(filter, "agentId") === agentId
			) {
				failures++
				throw fault
			}
			return result
		})
	try {
		for (let index = 0; index < 2; index++) {
			await jobs.insertOne({
				agentId,
				jobId: `expired-${index}`,
				jobType: "extraction",
				status: "running",
				createdAt: new Date(),
				attempts: 3,
				leaseExpiresAt: new Date(0),
			})
			await expect(
				ops.drainMemoryJobQueue({ admission }),
			).resolves.toBeUndefined()
			expect(
				await jobs.findOne({ agentId, jobId: `expired-${index}` }),
			).toMatchObject({ status: "failed" })
		}
	} finally {
		spy.mockRestore()
	}
	expect(failures).toBe(2)
	expect(await events.findOne({ agentId })).toMatchObject({
		idempotencyKey: "retained-key",
	})
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(2)
	evidence("continuation", {
		failures,
		jobs: await jobs.find({ agentId }).toArray(),
		gate: await readErasureGate({ db, prefix, agentId }),
	})
})
