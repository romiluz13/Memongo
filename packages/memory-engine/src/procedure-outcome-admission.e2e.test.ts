import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { reportProcedureOutcomeByHandle } from "./mongodb-procedures.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import type { MemoryProcedureStableHandle } from "./types.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E116 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e116_updates_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/outcome-${label}.json`,
			JSON.stringify(data),
		)
}
function manager(agentId: string) {
	return new MongoDBManagerLifecycleOps({
		db,
		prefix,
		client,
		agentId,
		config: { mongodb: { embeddingMode: "automated" } },
		workspaceDir: "/tmp/e116",
	} as unknown as MongoDBManagerHost)
}
async function seedCache(agentId: string) {
	await db.collection(`${prefix}query_cache`).insertOne({
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		queryHash: randomUUID(),
		queryNorm: "fixture",
		results: [],
		pathUsed: "bm25",
		sourceScope: "agent",
		expiresAt: new Date(Date.now() + 60000),
		hitCount: 0,
		lastHitAt: new Date(),
		createdAt: new Date(),
	})
}
async function seed(agentId = `agent-${randomUUID()}`) {
	const ops = manager(agentId)
	await ops.writeProcedure({
		agentId,
		procedureId: "deploy",
		name: "Deploy",
		steps: ["build", "ship"],
	})
	await seedCache(agentId)
	return {
		family: "procedure",
		id: "fixture",
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		revision: 1,
		state: "active",
		procedure: { procedureId: "deploy" },
	} as MemoryProcedureStableHandle
}
async function rows(agentId: string) {
	const out: Record<string, unknown[]> = {}
	for (const suffix of [
		"structured_mem",
		"structured_mem_revisions",
		"procedures",
		"procedure_revisions",
		"memory_mutations",
		"memory_cost_ledger",
		"query_cache",
		"memory_quarantine",
	])
		out[suffix] = await db
			.collection(`${prefix}${suffix}`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray()
	return out
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
}
function leaf(
	handle: MemoryProcedureStableHandle,
	admission: AdmissionToken,
	success = true,
) {
	return Reflect.apply(reportProcedureOutcomeByHandle, undefined, [
		{ db, prefix, handle, admission, success },
	]) as Promise<unknown>
}
function report(handle: MemoryProcedureStableHandle, success = true) {
	return manager(handle.agentId).reportProcedureOutcome({ handle, success })
}
async function outcome(promise: Promise<unknown>) {
	return promise.then(
		(value) => ({ kind: "resolved", value }),
		(error) => ({ kind: "rejected", error }),
	)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
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
		await other.close()
		await client.close()
	}
})

it("rejects foreign manager before DB", async () => {
	const handle = await seed(),
		reads = vi.spyOn(db, "collection")
	await expect(
		manager(`foreign-${randomUUID()}`).reportProcedureOutcome({
			handle,
			success: true,
		}),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(reads).not.toHaveBeenCalled()
})
it("rejects foreign outcome token before DB", async () => {
	const handle = await seed(),
		token = await captureAdmissionToken({
			db,
			prefix,
			agentId: `foreign-${randomUUID()}`,
		}),
		reads = vi.spyOn(db, "collection")
	await expect(
		leaf(handle as MemoryProcedureStableHandle, token),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(reads).not.toHaveBeenCalled()
})
it.each([
	true,
	false,
])("rejects old admission for success=%s over recreated identity", async (success) => {
	const handle = await seed(),
		token = await captureAdmissionToken({ db, prefix, agentId: handle.agentId })
	await erase(handle.agentId)
	await seed(handle.agentId)
	const before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId })
	await expect(leaf(handle, token, success)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await rows(handle.agentId)).toEqual(before)
	expect(
		await readErasureGate({ db, prefix, agentId: handle.agentId }),
	).toEqual(gate)
})
it.each([
	true,
	false,
])("commits fresh outcome success=%s without advancing revision", async (success) => {
	const handle = await seed(),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId }),
		before = await rows(handle.agentId)
	expect(before.query_cache).toHaveLength(1)
	const result = await report(handle, success),
		actual = await rows(handle.agentId)
	expect(result?.handle).toMatchObject({ revision: 1, state: "active" })
	expect(actual.query_cache).toEqual([])
	expect(actual.memory_mutations).toHaveLength(
		before.memory_mutations.length + 1,
	)
	expect(actual.procedure_revisions).toEqual([])
	expect(actual.procedures[0]).toMatchObject({
		revision: 1,
		...(success
			? { successCount: 1, failCount: 0 }
			: { successCount: 0, failCount: 1 }),
	})
	expect(
		(await readErasureGate({ db, prefix, agentId: handle.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 1)
})
it("rolls back outcome on cache failure", async () => {
	const handle = await seed(),
		before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId }),
		error = new Error("owned outcome cache fault"),
		original = Collection.prototype.deleteMany
	let hit = false
	vi.spyOn(Collection.prototype, "deleteMany").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (
			this.collectionName === `${prefix}query_cache` &&
			Reflect.get(Object(args[0]), "agentId") === handle.agentId
		) {
			hit = true
			return Promise.reject(error)
		}
		return Reflect.apply(original, this, args)
	})
	expect(await outcome(report(handle))).toEqual({ kind: "rejected", error })
	expect(hit).toBe(true)
	expect(await rows(handle.agentId)).toEqual(before)
	expect(
		await readErasureGate({ db, prefix, agentId: handle.agentId }),
	).toEqual(gate)
})
it("rolls back outcome on audit failure", async () => {
	const handle = await seed(),
		before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId }),
		error = new Error("owned outcome audit fault"),
		original = Collection.prototype.insertOne
	let hit = false
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (
			this.collectionName === `${prefix}memory_mutations` &&
			Reflect.get(Object(args[0]), "operation") === "update"
		) {
			hit = true
			return Promise.reject(error)
		}
		return Reflect.apply(original, this, args)
	})
	expect(await outcome(report(handle))).toEqual({ kind: "rejected", error })
	expect(hit).toBe(true)
	expect(await rows(handle.agentId)).toEqual(before)
	expect(
		await readErasureGate({ db, prefix, agentId: handle.agentId }),
	).toEqual(gate)
})
it("rejects outcome callback retry after actual abort and complete erasure", async () => {
	const handle = await seed(),
		start = client.startSession.bind(client)
	let reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args),
			commit = session.commitTransaction.bind(session)
		vi.spyOn(session, "commitTransaction").mockImplementation(
			async (...commitArgs) => {
				if (!reached) {
					reached = true
					await session.abortTransaction()
					await erase(handle.agentId)
					before = await rows(handle.agentId)
					const e = new MongoServerError({ message: "owned outcome replay" })
					e.addErrorLabel("TransientTransactionError")
					throw e
				}
				return commit(...commitArgs)
			},
		)
		return session
	})
	const actual = await outcome(report(handle))
	expect(reached).toBe(true)
	expect(actual).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(await rows(handle.agentId)).toEqual(before)
})

it("returns null with one gate serial for a deleted outcome target", async () => {
	const handle = await seed()
	await otherDb
		.collection(`${prefix}procedures`)
		.deleteOne({ agentId: handle.agentId })
	const before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId })
	await expect(report(handle)).resolves.toBeNull()
	expect(await rows(handle.agentId)).toEqual(before)
	expect(
		(await readErasureGate({ db, prefix, agentId: handle.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 1)
})
it("rejects wrong token kind before DB", async () => {
	const handle = await seed(),
		token = await captureAdmissionToken({
			db,
			prefix,
			agentId: handle.agentId,
		}),
		reads = vi.spyOn(db, "collection")
	await expect(
		Reflect.apply(reportProcedureOutcomeByHandle, undefined, [
			{
				db,
				prefix,
				handle,
				admission: { ...token, kind: "erase" },
				success: true,
			},
		]),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(reads).not.toHaveBeenCalled()
})
it("aborts outcome audit before complete erasure without a detached content tail", async () => {
	const handle = await seed(),
		original = Collection.prototype.insertOne,
		error = new MongoServerError({
			message: "owned interrupted outcome audit",
		}),
		audits: Promise<unknown>[] = []
	let reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (
			!reached &&
			this.collectionName === `${prefix}memory_mutations` &&
			Reflect.get(Object(args[0]), "operation") === "update"
		) {
			reached = true
			const promise = (async () => {
				const session = Reflect.get(Object(args[1]), "session")
				if (session) await session.abortTransaction()
				await erase(handle.agentId)
				before = await rows(handle.agentId)
				if (session) throw error
				return Reflect.apply(original, this, args)
			})()
			audits.push(promise)
			return promise
		}
		return Reflect.apply(original, this, args)
	})
	const actual = await outcome(report(handle))
	await Promise.allSettled(audits)
	expect(reached).toBe(true)
	expect(actual).toEqual({ kind: "rejected", error })
	expect(await rows(handle.agentId)).toEqual(before)
})

it("counts exactly once after an aborted commit retries without erasure", async () => {
	const handle = await seed(),
		before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId }),
		start = client.startSession.bind(client)
	let reached = false
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args),
			commit = session.commitTransaction.bind(session)
		vi.spyOn(session, "commitTransaction").mockImplementation(
			async (...commitArgs) => {
				if (!reached) {
					reached = true
					await session.abortTransaction()
					const error = new MongoServerError({
						message: "owned outcome transient commit",
					})
					error.addErrorLabel("TransientTransactionError")
					throw error
				}
				return commit(...commitArgs)
			},
		)
		return session
	})
	const result = await report(handle),
		actual = await rows(handle.agentId)
	expect(reached).toBe(true)
	expect(result?.handle).toMatchObject({ revision: 1, state: "active" })
	expect(actual.procedures[0]).toMatchObject({
		revision: 1,
		successCount: 1,
		failCount: 0,
	})
	expect(actual.memory_mutations).toHaveLength(
		before.memory_mutations.length + 1,
	)
	expect(actual.query_cache).toEqual([])
	expect(
		(await readErasureGate({ db, prefix, agentId: handle.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 1)
})
it("preserves counting on an invalidated procedure without changing revision", async () => {
	const handle = await seed()
	await otherDb.collection(`${prefix}procedures`).updateOne(
		{ agentId: handle.agentId },
		{
			$set: {
				state: "invalidated",
				validTo: new Date(),
				invalidatedBy: { reason: "fixture" },
			},
		},
	)
	const before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId })
	const result = await report(handle),
		actual = await rows(handle.agentId)
	expect(result?.handle).toMatchObject({ revision: 1, state: "invalidated" })
	expect(actual.procedures[0]).toMatchObject({
		revision: 1,
		successCount: 1,
		failCount: 0,
	})
	expect(actual.memory_mutations).toHaveLength(
		before.memory_mutations.length + 1,
	)
	expect(actual.query_cache).toEqual([])
	expect(
		(await readErasureGate({ db, prefix, agentId: handle.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 1)
})
