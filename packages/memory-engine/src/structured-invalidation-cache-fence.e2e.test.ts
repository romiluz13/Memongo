import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ensureCollections } from "./mongodb-schema.js"
import { invalidateStructuredMemoryByHandle } from "./mongodb-structured-memory.js"
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
	throw new Error("E51 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e51_inline_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/inline-${label}.json`,
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
	await db.collection(`${prefix}structured_mem`).insertOne({
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		type: "fact",
		key: "city",
		value: "Lives in London",
		revision: 1,
		state: "active",
		createdAt: now,
		updatedAt: now,
	})
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
	const handle = {
		family: "structured" as const,
		id: `structured:${agentId}:city`,
		agentId,
		scope: "agent" as const,
		scopeRef: `agent:${agentId}`,
		revision: 1,
		state: "active" as const,
		structured: { type: "fact", key: "city" },
	}
	return { token, handle }
}
async function rows(agentId: string) {
	const result: Record<string, Document[]> = {}
	for (const name of [
		"structured_mem",
		"structured_mem_revisions",
		"memory_mutations",
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
describe("inline structured invalidation cache errors on owned MongoDB", () => {
	it("propagates the original inline cache error and rolls back the complete transaction", async () => {
		const agentId = `agent-${randomUUID()}`,
			{ token, handle } = await seed(agentId)
		const before = await rows(agentId),
			gateBefore = await readErasureGate({ db, prefix, agentId }),
			error = new Error("owned inline cache failure"),
			spy = failCache(agentId, error)
		let outcome: unknown
		try {
			outcome = await withFencedWrite({
				db,
				prefix,
				token,
				fn: (session) =>
					invalidateStructuredMemoryByHandle({
						db,
						prefix,
						handle,
						session,
						transactionalSideEffects: "inline",
						invalidatedBy: { reason: "contradiction", runId: "owned-fixture" },
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
	it("commits fresh invalidation with revision, audit and cache cleanup", async () => {
		const agentId = `agent-${randomUUID()}`,
			{ token, handle } = await seed(agentId),
			gateBefore = await readErasureGate({ db, prefix, agentId })
		const result = await withFencedWrite({
			db,
			prefix,
			token,
			fn: (session) =>
				invalidateStructuredMemoryByHandle({
					db,
					prefix,
					handle,
					session,
					transactionalSideEffects: "inline",
					invalidatedBy: { reason: "contradiction", runId: "owned-fixture" },
				}),
		})
		const actual = await rows(agentId),
			gate = await readErasureGate({ db, prefix, agentId })
		evidence("fresh", { result, actual, gateBefore, gate })
		expect(result?.handle.state).toBe("invalidated")
		expect(actual.structured_mem).toHaveLength(1)
		expect(actual.structured_mem[0]).toMatchObject({
			state: "invalidated",
			revision: 2,
			invalidatedBy: { reason: "contradiction", runId: "owned-fixture" },
		})
		expect(actual.structured_mem_revisions).toHaveLength(1)
		expect(actual.structured_mem_revisions[0]).toMatchObject({
			state: "active",
			revision: 1,
		})
		expect(actual.memory_mutations).toHaveLength(1)
		expect(actual.memory_mutations[0]).toMatchObject({
			operation: "invalidate",
			collectionName: "structured_mem",
		})
		expect(actual.query_cache).toEqual([])
		expect(gate?.serial).toBe((gateBefore?.serial ?? 0) + 1)
	})
	it("keeps session-free cache cleanup best effort after a primary invalidation", async () => {
		const agentId = `agent-${randomUUID()}`,
			{ handle } = await seed(agentId),
			spy = failCache(agentId, new Error("owned best effort failure"))
		let result: Awaited<ReturnType<typeof invalidateStructuredMemoryByHandle>>
		try {
			result = await invalidateStructuredMemoryByHandle({ db, prefix, handle })
		} finally {
			spy.mockRestore()
		}
		const actual = await rows(agentId)
		evidence("best-effort", { result, actual })
		expect(result?.handle.state).toBe("invalidated")
		expect(actual.structured_mem[0]).toMatchObject({
			state: "invalidated",
			revision: 2,
		})
		expect(actual.structured_mem_revisions).toHaveLength(1)
		expect(actual.query_cache).toHaveLength(1)
	})
})
