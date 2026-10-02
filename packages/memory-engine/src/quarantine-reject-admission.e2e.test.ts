import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerAdminOps } from "./mongodb-manager-admin.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { rejectQuarantined } from "./mongodb-quarantine-review.js"
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
	throw new Error("E117 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e117_updates_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/quarantine-reject-${label}.json`,
			JSON.stringify(data),
		)
}
function manager(agentId: string) {
	return new MongoDBManagerAdminOps({
		db,
		prefix,
		client,
		agentId,
		config: { mongodb: { embeddingMode: "automated" } },
		workspaceDir: "/tmp/e117",
	} as unknown as MongoDBManagerHost)
}
async function seed(
	agentId = `agent-${randomUUID()}`,
	quarantineId = randomUUID(),
) {
	await db.collection(`${prefix}memory_quarantine`).insertOne({
		quarantineId,
		agentId,
		content: "My preferred city is Berlin",
		classification: "injection-likely",
		tier: "pattern",
		matchedPatterns: [],
		status: "pending-review",
		createdAt: new Date(),
	})
	await captureAdmissionToken({ db, prefix, agentId })
	return { agentId, quarantineId }
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
	entry: { agentId: string; quarantineId: string },
	admission: AdmissionToken,
) {
	return Reflect.apply(rejectQuarantined, undefined, [
		{
			db,
			prefix,
			...entry,
			admission,
			reviewerId: "reviewer",
			reviewNotes: "fixture reviewed content",
		},
	]) as Promise<unknown>
}
function reject(entry: { agentId: string; quarantineId: string }) {
	return manager(entry.agentId).rejectQuarantined({
		quarantineId: entry.quarantineId,
		reviewerId: "reviewer",
		reviewNotes: "fixture reviewed content",
	})
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
	"owner",
	"kind",
])("rejects wrong admission %s before DB", async (which) => {
	const entry = await seed(),
		token = await captureAdmissionToken({ db, prefix, agentId: entry.agentId }),
		reads = vi.spyOn(db, "collection")
	const bad =
		which === "owner"
			? { ...token, agentId: "foreign" }
			: { ...token, kind: "erase" }
	await expect(
		Reflect.apply(rejectQuarantined, undefined, [
			{ db, prefix, ...entry, admission: bad },
		]),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(reads).not.toHaveBeenCalled()
})
it("rejects stale admission over a recreated quarantine identity", async () => {
	const entry = await seed(),
		token = await captureAdmissionToken({ db, prefix, agentId: entry.agentId })
	await erase(entry.agentId)
	await seed(entry.agentId, entry.quarantineId)
	const before = await rows(entry.agentId),
		gate = await readErasureGate({ db, prefix, agentId: entry.agentId })
	await expect(leaf(entry, token)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await rows(entry.agentId)).toEqual(before)
	expect(await readErasureGate({ db, prefix, agentId: entry.agentId })).toEqual(
		gate,
	)
})
it.each([
	false,
	true,
])("commits rejected decision and audit, recovered=%s", async (recovered) => {
	const entry = await seed()
	if (recovered)
		await db.collection(`${prefix}memory_quarantine`).updateOne(
			{ quarantineId: entry.quarantineId },
			{
				$set: {
					status: "promoting",
					promoteLeaseExpiresAt: new Date(Date.now() - 10000),
				},
			},
		)
	const gate = await readErasureGate({ db, prefix, agentId: entry.agentId }),
		result = await reject(entry),
		actual = await rows(entry.agentId)
	expect(result.status).toBe("rejected")
	expect(result.auditError).toBeUndefined()
	expect(result.mutationId).toBeTypeOf("string")
	expect(actual.memory_quarantine[0]).toMatchObject({
		status: "rejected",
		reviewerId: "reviewer",
		reviewNotes: "fixture reviewed content",
	})
	expect(actual.memory_mutations).toHaveLength(1)
	expect(
		(await readErasureGate({ db, prefix, agentId: entry.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 2)
})
it("keeps durable decision when generic audit failure returns auditError", async () => {
	const entry = await seed(),
		gate = await readErasureGate({ db, prefix, agentId: entry.agentId }),
		original = Collection.prototype.insertOne,
		error = new Error("owned reject audit fault")
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (this.collectionName === `${prefix}memory_mutations`)
			return Promise.reject(error)
		return Reflect.apply(original, this, args)
	})
	const result = await reject(entry),
		actual = await rows(entry.agentId)
	expect(result.status).toBe("rejected")
	expect(result.auditError).toBe(error.message)
	expect(result.mutationId).toBeUndefined()
	expect(actual.memory_quarantine[0]).toMatchObject({ status: "rejected" })
	expect(actual.memory_mutations).toEqual([])
	expect(
		(await readErasureGate({ db, prefix, agentId: entry.agentId }))?.serial,
	).toBe((gate?.serial ?? 0) + 1)
})
it("rolls back decision and gate on update failure", async () => {
	const entry = await seed(),
		before = await rows(entry.agentId),
		gate = await readErasureGate({ db, prefix, agentId: entry.agentId }),
		original = Collection.prototype.updateOne,
		error = new Error("owned reject decision fault")
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (this.collectionName === `${prefix}memory_quarantine`)
			return Promise.reject(error)
		return Reflect.apply(original, this, args)
	})
	await expect(reject(entry)).rejects.toBe(error)
	expect(await rows(entry.agentId)).toEqual(before)
	expect(await readErasureGate({ db, prefix, agentId: entry.agentId })).toEqual(
		gate,
	)
})
it("does not reject a live promotion lease", async () => {
	const entry = await seed()
	await db.collection(`${prefix}memory_quarantine`).updateOne(
		{ quarantineId: entry.quarantineId },
		{
			$set: {
				status: "promoting",
				promoteLeaseExpiresAt: new Date(Date.now() + 60000),
			},
		},
	)
	const before = await rows(entry.agentId),
		gate = await readErasureGate({ db, prefix, agentId: entry.agentId })
	await expect(reject(entry)).rejects.toThrow("promotion already in progress")
	expect(await rows(entry.agentId)).toEqual(before)
	expect(await readErasureGate({ db, prefix, agentId: entry.agentId })).toEqual(
		gate,
	)
})
it("propagates erased admission from an interrupted audit without recreating review metadata", async () => {
	const entry = await seed(),
		original = Collection.prototype.insertOne,
		audits: Promise<unknown>[] = []
	let reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (!reached && this.collectionName === `${prefix}memory_mutations`) {
			reached = true
			const promise = (async () => {
				const session = Reflect.get(Object(args[1]), "session")
				if (session) await session.abortTransaction()
				await erase(entry.agentId)
				before = await rows(entry.agentId)
				if (session) {
					const error = new MongoServerError({
						message: "owned interrupted reject audit",
					})
					Object.defineProperty(error, "code", {
						value: "ERASURE_GATE_CONFLICT",
					})
					throw error
				}
				return Reflect.apply(original, this, args)
			})()
			audits.push(promise)
			return promise
		}
		return Reflect.apply(original, this, args)
	})
	const result = await outcome(reject(entry))
	await Promise.allSettled(audits)
	expect(reached).toBe(true)
	expect(result).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(await rows(entry.agentId)).toEqual(before)
})

it("rejects actual erasure admission between decision and audit transactions", async () => {
	const entry = await seed(),
		start = client.startSession.bind(client)
	let calls = 0,
		reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args),
			run = session.withTransaction.bind(session)
		if (session.explicit) calls++
		if (session.explicit && calls === 2)
			vi.spyOn(session, "withTransaction").mockImplementation(
				async (...txnArgs) => {
					reached = true
					await erase(entry.agentId)
					before = await rows(entry.agentId)
					return Reflect.apply(run, undefined, txnArgs)
				},
			)
		return session
	})
	const result = await outcome(reject(entry))
	expect(reached).toBe(true)
	expect(result).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(await rows(entry.agentId)).toEqual(before)
})

it("keeps manager admission captured before actual erase and recreated review row", async () => {
	const entry = await seed(),
		original = Collection.prototype.findOneAndUpdate
	let reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined,
		gate: Awaited<ReturnType<typeof readErasureGate>> | undefined
	vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(
		async function (this: Collection, ...args) {
			const result = await Reflect.apply(original, this, args)
			if (
				!reached &&
				this.collectionName === `${prefix}meta` &&
				Reflect.get(Object(args[0]), "_id") ===
					`tenant-erasure-epoch:${entry.agentId}`
			) {
				reached = true
				await erase(entry.agentId)
				await seed(entry.agentId, entry.quarantineId)
				before = await rows(entry.agentId)
				gate = await readErasureGate({ db, prefix, agentId: entry.agentId })
			}
			return result
		},
	)
	const result = await outcome(reject(entry))
	expect(reached).toBe(true)
	expect(result).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(await rows(entry.agentId)).toEqual(before)
	expect(await readErasureGate({ db, prefix, agentId: entry.agentId })).toEqual(
		gate,
	)
})
it.each([
	false,
	true,
])("replays an aborted decision under the same original admission, erase=%s", async (erased) => {
	const entry = await seed(),
		start = client.startSession.bind(client),
		gate = await readErasureGate({ db, prefix, agentId: entry.agentId })
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
					if (erased) {
						await erase(entry.agentId)
						before = await rows(entry.agentId)
					}
					const error = new MongoServerError({
						message: "owned reject transient decision",
					})
					error.addErrorLabel("TransientTransactionError")
					throw error
				}
				return commit(...commitArgs)
			},
		)
		return session
	})
	const result = await outcome(reject(entry))
	expect(reached).toBe(true)
	if (erased) {
		expect(result).toMatchObject({
			kind: "rejected",
			error: { code: "ERASURE_GATE_CONFLICT" },
		})
		expect(await rows(entry.agentId)).toEqual(before)
	} else {
		expect(result).toMatchObject({
			kind: "resolved",
			value: { status: "rejected" },
		})
		const actual = await rows(entry.agentId)
		expect(actual.memory_quarantine[0]).toMatchObject({ status: "rejected" })
		expect(actual.memory_mutations).toHaveLength(1)
		expect(
			(await readErasureGate({ db, prefix, agentId: entry.agentId }))?.serial,
		).toBe((gate?.serial ?? 0) + 2)
	}
})
