import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { invalidateStructuredMemoryByHandle } from "./mongodb-structured-memory.js"
import { invalidateProcedureByHandle } from "./mongodb-procedures.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import type {
	MemoryStableHandle,
	MemoryStructuredStableHandle,
	MemoryProcedureStableHandle,
} from "./types.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E112 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e112_updates_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/lifecycle-invalidate-${label}.json`,
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
		workspaceDir: "/tmp/e112",
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
async function seed(
	family: "structured" | "procedure",
	agentId = `agent-${randomUUID()}`,
) {
	const ops = manager(agentId)

	if (family === "structured") {
		await ops.writeStructuredMemory({
			agentId,
			type: "fact",
			key: "city",
			value: "Berlin",
		})
		await seedCache(agentId)
		return {
			family: "structured",
			id: "fixture",
			agentId,
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			revision: 1,
			state: "active",
			structured: { type: "fact", key: "city" },
		} as MemoryStructuredStableHandle
	}
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
	handle: MemoryStableHandle,
	admission: AdmissionToken,
	session?: unknown,
) {
	const params = {
		db,
		prefix,
		client,
		handle,
		admission,
		...(session ? { session } : {}),
	}
	return Reflect.apply(
		handle.family === "structured"
			? invalidateStructuredMemoryByHandle
			: invalidateProcedureByHandle,
		undefined,
		[params],
	) as Promise<unknown>
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

it.each([
	"structured",
	"procedure",
] as const)("rejects %s owner mismatch before database access", async (family) => {
	const handle = await seed(family),
		reads = vi.spyOn(db, "collection")
	await expect(
		manager(`foreign-${randomUUID()}`).invalidateLifecycleItem(handle),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(reads).not.toHaveBeenCalled()
})
it.each([
	"structured",
	"procedure",
] as const)("rejects foreign %s admission before database access", async (family) => {
	const handle = await seed(family),
		token = await captureAdmissionToken({
			db,
			prefix,
			agentId: `foreign-${randomUUID()}`,
		}),
		reads = vi.spyOn(db, "collection")
	await expect(leaf(handle, token)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(reads).not.toHaveBeenCalled()
})
it.each([
	"structured",
	"procedure",
] as const)("rejects admitted %s with external session before database access", async (family) => {
	const handle = await seed(family),
		token = await captureAdmissionToken({
			db,
			prefix,
			agentId: handle.agentId,
		}),
		session = client.startSession(),
		reads = vi.spyOn(db, "collection")
	try {
		await expect(leaf(handle, token, session)).rejects.toThrow()
		expect(reads).not.toHaveBeenCalled()
	} finally {
		await session.endSession()
	}
})
it.each([
	"structured",
	"procedure",
] as const)("rejects old %s admission over recreated identity", async (family) => {
	const handle = await seed(family),
		token = await captureAdmissionToken({ db, prefix, agentId: handle.agentId })
	await erase(handle.agentId)
	await seed(family, handle.agentId)
	const before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId })
	await expect(leaf(handle, token)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await rows(handle.agentId)).toEqual(before)
	expect(
		await readErasureGate({ db, prefix, agentId: handle.agentId }),
	).toEqual(gate)
})
it.each([
	"structured",
	"procedure",
] as const)("commits fresh %s invalidation and current-handle semantic no-op", async (family) => {
	const handle = await seed(family),
		ops = manager(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId }),
		before = await rows(handle.agentId)
	const first = await ops.invalidateLifecycleItem(handle)
	expect(first?.handle).toMatchObject({ state: "invalidated", revision: 2 })
	const after = await rows(handle.agentId)
	expect(before.query_cache).toHaveLength(1)
	expect(after.query_cache).toEqual([])
	expect(
		after[
			family === "structured"
				? "structured_mem_revisions"
				: "procedure_revisions"
		],
	).toHaveLength(1)
	expect(after.memory_mutations).toHaveLength(
		before.memory_mutations.length + 1,
	)
	expect(
		(await readErasureGate({ db, prefix, agentId: handle.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 1)
	expect(first).not.toBeNull()
	if (!first) throw new Error("fresh invalidation returned null")
	await expect(
		ops.invalidateLifecycleItem(first.handle),
	).resolves.toMatchObject({ handle: { state: "invalidated", revision: 2 } })
	expect(await rows(handle.agentId)).toEqual(after)
	expect(
		(await readErasureGate({ db, prefix, agentId: handle.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 2)
})
it.each([
	"structured",
	"procedure",
] as const)("rolls back %s invalidation on cache failure", async (family) => {
	const handle = await seed(family),
		before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId }),
		error = new Error("owned invalidation cache failure"),
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
	const actual = await outcome(
		manager(handle.agentId).invalidateLifecycleItem(handle),
	)
	expect(hit).toBe(true)
	expect(actual).toEqual({ kind: "rejected", error })
	expect(await rows(handle.agentId)).toEqual(before)
	expect(
		await readErasureGate({ db, prefix, agentId: handle.agentId }),
	).toEqual(gate)
})
it.each([
	"structured",
	"procedure",
] as const)("rolls back %s invalidation on audit failure", async (family) => {
	const handle = await seed(family),
		before = await rows(handle.agentId),
		gate = await readErasureGate({ db, prefix, agentId: handle.agentId }),
		error = new Error("owned invalidation audit failure"),
		original = Collection.prototype.insertOne
	let hit = false
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (
			this.collectionName === `${prefix}memory_mutations` &&
			Reflect.get(Object(args[0]), "operation") === "invalidate"
		) {
			hit = true
			return Promise.reject(error)
		}
		return Reflect.apply(original, this, args)
	})
	const actual = await outcome(
		manager(handle.agentId).invalidateLifecycleItem(handle),
	)
	expect(hit).toBe(true)
	expect(actual).toEqual({ kind: "rejected", error })
	expect(await rows(handle.agentId)).toEqual(before)
	expect(
		await readErasureGate({ db, prefix, agentId: handle.agentId }),
	).toEqual(gate)
})
it.each([
	"structured",
	"procedure",
] as const)("rejects %s callback replay after precommit abort and real erasure", async (family) => {
	const handle = await seed(family),
		start = client.startSession.bind(client),
		insert = Collection.prototype.insertOne,
		audits: Promise<unknown>[] = []
	let reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		const promise = Reflect.apply(insert, this, args)
		if (
			this.collectionName === `${prefix}memory_mutations` &&
			Reflect.get(Object(args[0]), "operation") === "invalidate"
		)
			audits.push(promise)
		return promise
	})
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
					const error = new MongoServerError({
						message: "owned transient precommit replay",
					})
					error.addErrorLabel("TransientTransactionError")
					throw error
				}
				return commit(...commitArgs)
			},
		)
		return session
	})
	const actual = await outcome(
		manager(handle.agentId).invalidateLifecycleItem(handle),
	)
	await Promise.allSettled(audits)
	expect(reached).toBe(true)
	expect(await rows(handle.agentId)).toEqual(before)
	expect(actual).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	evidence(`replay-${family}`, {
		actual,
		before,
		after: await rows(handle.agentId),
	})
})
