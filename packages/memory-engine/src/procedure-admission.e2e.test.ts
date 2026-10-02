import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { ClientSession, Collection, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { writeProcedure, type ProcedureEntry } from "./mongodb-procedures.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E106 requires owned local MongoDB")
const client = new MongoClient(uri),
	other = new MongoClient(uri)
const name = `memongo_e106_procedure_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/procedure-admission-${label}.json`,
			JSON.stringify(data),
		)
}
function entry(agentId = `agent-${randomUUID()}`): ProcedureEntry {
	return {
		agentId,
		procedureId: "procedure-1",
		name: "Deploy",
		steps: ["build", "ship"],
	}
}
function manager(agentId: string) {
	return new MongoDBManagerLifecycleOps({
		db,
		prefix,
		agentId,
		client,
		config: { mongodb: { embeddingMode: "automated" } },
		workspaceDir: "/tmp/e106",
	} as unknown as MongoDBManagerHost)
}
function write(
	value: ProcedureEntry,
	admission: AdmissionToken,
	session?: ClientSession,
) {
	return Reflect.apply(writeProcedure, undefined, [
		{
			db,
			prefix,
			entry: value,
			embeddingMode: "automated",
			admission,
			...(session ? { session } : {}),
		},
	]) as ReturnType<typeof writeProcedure>
}
async function token(agentId: string) {
	return captureAdmissionToken({ db, prefix, agentId })
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
}
async function rows(agentId: string) {
	const result: Record<string, unknown[]> = {}
	for (const col of [
		"procedures",
		"procedure_revisions",
		"memory_mutations",
		"memory_cost_ledger",
		"query_cache",
	])
		result[col] = await db
			.collection(`${prefix}${col}`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray()
	return result
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await other.connect()
	await ensureCollections(db, prefix)
	await db
		.collection(`${prefix}procedures`)
		.createIndex(
			{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ unique: true },
		)
	await db
		.collection(`${prefix}memory_cost_ledger`)
		.createIndex({ agentId: 1, day: 1, kind: 1 }, { unique: true })
})
afterEach(() => {
	vi.restoreAllMocks()
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
		await other.close()
		await client.close()
	}
})
it("rejects stale supplied admission before procedure or audit writes", async () => {
	const value = entry(),
		admission = await token(value.agentId)
	await erase(value.agentId)
	const before = await rows(value.agentId)
	await expect(write(value, admission)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await rows(value.agentId)).toEqual(before)
})
it("captures public manager admission before erasure straddles the gate read", async () => {
	const value = entry(),
		original = Collection.prototype.findOneAndUpdate
	let once = true
	let before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(
		async function (this: Collection, ...args) {
			const result = await Reflect.apply(original, this, args)
			if (
				once &&
				this.collectionName === `${prefix}meta` &&
				!Reflect.get(Object(Reflect.get(args, 2)), "session") &&
				String(Reflect.get(args[0], "_id")).endsWith(value.agentId)
			) {
				once = false
				await erase(value.agentId)
				before = await rows(value.agentId)
			}
			return result
		},
	)
	await expect(
		manager(value.agentId).writeProcedure(value),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(once).toBe(false)
	expect(await rows(value.agentId)).toEqual(before)
})
it("commits fresh public procedure, audit and cost with one gate serial", async () => {
	const value = entry()
	await expect(
		manager(value.agentId).writeProcedure(value),
	).resolves.toMatchObject({ upserted: true, id: value.procedureId })
	const actual = await rows(value.agentId)
	expect(actual.procedures).toHaveLength(1)
	expect(actual.memory_mutations).toHaveLength(1)
	expect(actual.memory_cost_ledger).toHaveLength(1)
	expect(
		(await readErasureGate({ db, prefix, agentId: value.agentId }))?.serial,
	).toBe(1)
})
it("accepts a fresh public write after erasure reopens the gate", async () => {
	const value = entry()
	await token(value.agentId)
	await erase(value.agentId)
	await expect(
		manager(value.agentId).writeProcedure(value),
	).resolves.toMatchObject({ upserted: true })
	expect(
		await db
			.collection(`${prefix}procedures`)
			.findOne({ agentId: value.agentId }),
	).toMatchObject({ name: value.name })
	expect(
		(await readErasureGate({ db, prefix, agentId: value.agentId }))?.epoch,
	).toBe(1)
})
it("rejects foreign manager identity before any database access", async () => {
	const value = entry(),
		ops = manager(`owner-${randomUUID()}`),
		reads = vi.spyOn(db, "collection")
	await expect(ops.writeProcedure(value)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(reads).not.toHaveBeenCalled()
})
it("rejects mismatched leaf admission without reading either owner", async () => {
	const value = entry(),
		admission = await token(`other-${randomUUID()}`),
		reads = vi.spyOn(db, "collection")
	await expect(write(value, admission)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(reads).not.toHaveBeenCalled()
})
it("rejects simultaneous admission and externally owned session", async () => {
	const value = entry(),
		admission = await token(value.agentId),
		session = client.startSession()
	try {
		await expect(write(value, admission, session)).rejects.toThrow()
	} finally {
		await session.endSession()
	}
	for (const result of Object.values(await rows(value.agentId)))
		expect(result).toEqual([])
})
it("rolls back procedure and gate when a real audit insert then fails", async () => {
	const value = entry(),
		admission = await token(value.agentId),
		gate = await readErasureGate({ db, prefix, agentId: value.agentId }),
		fault = new Error("audit fault"),
		original = Collection.prototype.insertOne
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
		async function (this: Collection, ...args) {
			const result = await Reflect.apply(original, this, args)
			if (
				this.collectionName === `${prefix}memory_mutations` &&
				Reflect.get(args[0], "agentId") === value.agentId
			)
				throw fault
			return result
		},
	)
	await expect(write(value, admission)).rejects.toBe(fault)
	for (const result of Object.values(await rows(value.agentId)))
		expect(result).toEqual([])
	expect(await readErasureGate({ db, prefix, agentId: value.agentId })).toEqual(
		gate,
	)
})
it("retries a real aborted revision attempt against newer history without inverted intervals", async () => {
	const value = entry(),
		admission = await token(value.agentId)
	await write(value, admission)
	const initialAudit = await db
		.collection(`${prefix}memory_mutations`)
		.countDocuments({ agentId: value.agentId })
	const update = Collection.prototype.updateOne,
		abort = ClientSession.prototype.abortTransaction
	let once = true,
		advance = false,
		advancedAt: Date | undefined
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
		async function (this: Collection, ...args) {
			const result = await Reflect.apply(update, this, args)
			if (
				once &&
				this.collectionName === `${prefix}procedures` &&
				Reflect.get(args[0], "agentId") === value.agentId &&
				Reflect.get(args[0], "revision") === 1
			) {
				once = false
				advance = true
				return { ...result, matchedCount: 0 }
			}
			return result
		},
	)
	vi.spyOn(ClientSession.prototype, "abortTransaction").mockImplementation(
		async function (this: ClientSession, ...args) {
			await Reflect.apply(abort, this, args)
			if (advance) {
				advance = false
				advancedAt = new Date()
				await otherDb.collection(`${prefix}procedures`).updateOne(
					{ agentId: value.agentId },
					{
						$set: {
							name: "Concurrent",
							revision: 2,
							validFrom: advancedAt,
							updatedAt: advancedAt,
						},
					},
				)
			}
		},
	)
	await expect(
		write({ ...value, name: "Final" }, admission),
	).resolves.toMatchObject({ upserted: false })
	expect(once).toBe(false)
	expect(advancedAt).toBeInstanceOf(Date)
	const current = await db
		.collection(`${prefix}procedures`)
		.findOne({ agentId: value.agentId })
	expect(current).toMatchObject({ name: "Final", revision: 3 })
	const revisions = await db
		.collection(`${prefix}procedure_revisions`)
		.find({ agentId: value.agentId })
		.toArray()
	expect(revisions).toHaveLength(1)
	expect(revisions[0]?.revision).toBe(2)
	expect(revisions[0]?.validTo.getTime()).toBeGreaterThanOrEqual(
		revisions[0]?.validFrom.getTime(),
	)
	expect(
		await db
			.collection(`${prefix}memory_mutations`)
			.countDocuments({ agentId: value.agentId }),
	).toBe(initialAudit + 1)
	expect(
		(await readErasureGate({ db, prefix, agentId: value.agentId }))?.serial,
	).toBe(2)
	evidence("cas-retry", { advancedAt, current, revisions })
})
