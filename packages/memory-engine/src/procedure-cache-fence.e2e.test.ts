import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ensureCollections } from "./mongodb-schema.js"
import { writeProcedure } from "./mongodb-procedures.js"
import {
	captureAdmissionToken,
	readErasureGate,
	withFencedWrite,
} from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E52 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e52_inline_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/procedure-inline-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
})
afterAll(async () => {
	vi.restoreAllMocks()
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
async function seed(agentId: string) {
	const token = await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date()
	await db.collection(`${prefix}query_cache`).insertOne({
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		queryHash: randomUUID(),
		queryNorm: "city",
		results: [],
		pathUsed: "bm25",
		sourceScope: "agent",
		expiresAt: new Date(now.getTime() + 60000),
		hitCount: 0,
		lastHitAt: now,
		createdAt: now,
	})
	const entry = {
		procedureId: "proc-1",
		name: "Deploy",
		steps: ["build", "ship"],
		agentId,
	}
	return { token, entry }
}
async function rows(agentId: string) {
	const result: Record<string, Document[]> = {}
	for (const name of [
		"procedures",
		"procedure_revisions",
		"memory_mutations",
		"memory_cost_ledger",
		"query_cache",
	])
		result[name] = await db
			.collection(`${prefix}${name}`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray()
	return result
}
function failCache(agentId: string, error: Error) {
	const original = Collection.prototype.deleteMany
	return vi
		.spyOn(Collection.prototype, "deleteMany")
		.mockImplementation(function (
			this: Collection<Document>,
			...args: Parameters<typeof original>
		) {
			if (
				this.collectionName === `${prefix}query_cache` &&
				args[0]?.agentId === agentId
			)
				return Promise.reject(error)
			return original.apply(this, args)
		})
}
describe("inline procedure cache errors on owned MongoDB", () => {
	it("propagates original cache error and rolls back procedure, cost, audit and gate", async () => {
		const agentId = `agent-${randomUUID()}`,
			{ token, entry } = await seed(agentId),
			before = await rows(agentId),
			gateBefore = await readErasureGate({ db, prefix, agentId }),
			error = new Error("owned procedure cache failure"),
			spy = failCache(agentId, error)
		let outcome: unknown
		try {
			outcome = await withFencedWrite({
				db,
				prefix,
				token,
				fn: (session) =>
					writeProcedure({
						db,
						prefix,
						entry,
						embeddingMode: "automated",
						session,
						transactionalSideEffects: "inline",
					}),
			}).then(
				(value) => ({ kind: "resolved", value }),
				(caught) => ({
					kind: "rejected",
					original: caught === error,
					message: caught.message,
				}),
			)
		} finally {
			spy.mockRestore()
		}
		const actual = await rows(agentId),
			gate = await readErasureGate({ db, prefix, agentId })
		evidence("rollback", { outcome, before, actual, gateBefore, gate })
		expect(outcome).toEqual({
			kind: "rejected",
			original: true,
			message: error.message,
		})
		expect(actual).toEqual(before)
		expect(gate).toEqual(gateBefore)
	})
	it("commits fresh procedure with indexing, audit and cache cleanup", async () => {
		const agentId = `agent-${randomUUID()}`,
			{ token, entry } = await seed(agentId),
			gateBefore = await readErasureGate({ db, prefix, agentId })
		const result = await withFencedWrite({
				db,
				prefix,
				token,
				fn: (session) =>
					writeProcedure({
						db,
						prefix,
						entry,
						embeddingMode: "automated",
						session,
						transactionalSideEffects: "inline",
					}),
			}),
			actual = await rows(agentId),
			gate = await readErasureGate({ db, prefix, agentId })
		evidence("fresh", { result, actual, gateBefore, gate })
		expect(result.upserted).toBe(true)
		expect(actual.procedures).toHaveLength(1)
		expect(actual.procedures[0]).toMatchObject({
			procedureId: entry.procedureId,
			agentId,
			state: "active",
			revision: 1,
			steps: entry.steps,
			searchText: "Deploy\nbuild\nship",
		})
		expect(actual.procedure_revisions).toEqual([])
		expect(actual.memory_mutations).toHaveLength(1)
		expect(actual.memory_mutations[0]).toMatchObject({
			operation: "create",
			collectionName: "procedures",
		})
		expect(actual.memory_cost_ledger).toHaveLength(1)
		expect(actual.memory_cost_ledger[0]).toMatchObject({
			kind: "indexing",
			embedUnits: 1,
		})
		expect(actual.query_cache).toEqual([])
		expect(gate?.serial).toBe((gateBefore?.serial ?? 0) + 1)
	})
	it("keeps session-free cache failure best effort", async () => {
		const agentId = `agent-${randomUUID()}`,
			{ entry } = await seed(agentId),
			spy = failCache(agentId, new Error("owned procedure best effort failure"))
		let result: Awaited<ReturnType<typeof writeProcedure>>
		try {
			result = await writeProcedure({
				db,
				prefix,
				entry,
				embeddingMode: "automated",
			})
		} finally {
			spy.mockRestore()
		}
		const actual = await rows(agentId)
		evidence("best-effort", { result, actual })
		expect(result.upserted).toBe(true)
		expect(actual.procedures).toHaveLength(1)
		expect(actual.query_cache).toHaveLength(1)
	})
})
