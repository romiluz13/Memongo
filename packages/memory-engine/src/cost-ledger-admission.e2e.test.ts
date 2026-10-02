import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { recordEmbeddingSpend, recordLLMSpend } from "./mongodb-cost-ledger.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
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
	throw new Error("E94 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e94_cost_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const ledger = db.collection(`${prefix}memory_cost_ledger`)
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/cost-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
// Reflect also exercises the baseline, which ignores the proposed trailing options.
async function embedding(
	agentId: string,
	units: number,
	admission: AdmissionToken,
) {
	const result: unknown = Reflect.apply(recordEmbeddingSpend, undefined, [
		db,
		prefix,
		agentId,
		"search",
		units,
		{ admission },
	])
	if (result instanceof Promise) return result
	await vi.waitFor(async () =>
		expect(await ledger.countDocuments({ agentId })).toBe(1),
	)
}
async function llm(agentId: string, admission: AdmissionToken) {
	const result: unknown = Reflect.apply(recordLLMSpend, undefined, [
		db,
		prefix,
		agentId,
		{ inputTokens: 7, outputTokens: 3 },
		{ admission },
	])
	if (result instanceof Promise) return result
	await vi.waitFor(async () =>
		expect(await ledger.countDocuments({ agentId, kind: "llm" })).toBe(1),
	)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
	await ledger.createIndex({ agentId: 1, day: 1, kind: 1 }, { unique: true })
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
it.each([
	"embedding",
	"llm",
] as const)("rejects stale %s spend after completed erasure", async (kind) => {
	const agentId = `stale-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	const gate = await readErasureGate({ db, prefix, agentId })
	let error: unknown
	try {
		await (kind === "embedding"
			? embedding(agentId, 2, admission)
			: llm(agentId, admission))
	} catch (caught) {
		error = caught
	}
	const rows = await ledger.find({ agentId }).toArray(),
		afterGate = await readErasureGate({ db, prefix, agentId })
	evidence(`stale-${kind}`, {
		admission,
		gate,
		afterGate,
		rows,
		code: error instanceof Error ? Reflect.get(error, "code") : null,
	})
	expect(rows).toEqual([])
	expect(error).toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(afterGate).toEqual(gate)
})
it("commits both fresh ledger counters with their gate serials", async () => {
	const agentId = `fresh-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	await embedding(agentId, 2, admission)
	await llm(agentId, admission)
	const rows = await ledger.find({ agentId }).sort({ kind: 1 }).toArray(),
		gate = await readErasureGate({ db, prefix, agentId })
	evidence("fresh", { rows, gate })
	expect(rows).toHaveLength(2)
	expect(rows[0]).toMatchObject({
		kind: "llm",
		inputTokens: 7,
		outputTokens: 3,
	})
	expect(rows[1]).toMatchObject({ kind: "search", embedUnits: 2 })
	expect(gate?.serial).toBe(2)
})
it("retries a real rolled-back increment exactly once", async () => {
	const agentId = `retry-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const original = Collection.prototype.updateOne
	let writes = 0
	const spy = vi
		.spyOn(Collection.prototype, "updateOne")
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
				this.collectionName === ledger.collectionName &&
				Reflect.get(filter, "agentId") === agentId &&
				++writes === 1
			) {
				const error = new MongoServerError({
					message: "owned transient fixture",
					code: 112,
				})
				error.addErrorLabel("TransientTransactionError")
				throw error
			}
			return result
		})
	try {
		await embedding(agentId, 4, admission)
	} finally {
		spy.mockRestore()
	}
	const rows = await ledger.find({ agentId }).toArray(),
		gate = await readErasureGate({ db, prefix, agentId })
	evidence("retry", { writes, rows, gate })
	expect(writes).toBe(2)
	expect(rows).toHaveLength(1)
	expect(rows[0]?.embedUnits).toBe(4)
	expect(gate?.serial).toBe(1)
})
it("rolls back a real increment and gate on an ordinary error", async () => {
	const agentId = `rollback-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const gate = await readErasureGate({ db, prefix, agentId }),
		fault = new Error("owned update fault")
	const original = Collection.prototype.updateOne
	const spy = vi
		.spyOn(Collection.prototype, "updateOne")
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
				this.collectionName === ledger.collectionName &&
				Reflect.get(filter, "agentId") === agentId
			)
				throw fault
			return result
		})
	let error: unknown
	try {
		await embedding(agentId, 4, admission)
	} catch (caught) {
		error = caught
	} finally {
		spy.mockRestore()
	}
	const rows = await ledger.find({ agentId }).toArray(),
		afterGate = await readErasureGate({ db, prefix, agentId })
	evidence("rollback", { rows, gate, afterGate })
	expect(rows).toEqual([])
	expect(error).toBe(fault)
	expect(afterGate).toEqual(gate)
})
it("rejects a different owner before creating either counter or gate", async () => {
	const agentId = `owner-${randomUUID()}`,
		otherId = `other-${randomUUID()}`
	const admission = await captureAdmissionToken({
		db,
		prefix,
		agentId: otherId,
	})
	const gate = await readErasureGate({ db, prefix, agentId: otherId })
	let error: unknown
	try {
		await embedding(agentId, 1, admission)
	} catch (caught) {
		error = caught
	}
	expect(await ledger.find({ agentId }).toArray()).toEqual([])
	expect(error).toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(await readErasureGate({ db, prefix, agentId })).toBeNull()
	expect(await readErasureGate({ db, prefix, agentId: otherId })).toEqual(gate)
})
it("preserves legacy void and fractional floor-zero upsert behavior", async () => {
	const agentId = `legacy-${randomUUID()}`
	const returned: void = recordEmbeddingSpend(
		db,
		prefix,
		agentId,
		"search",
		0.5,
	)
	expect(returned).toBeUndefined()
	await vi.waitFor(async () =>
		expect(await ledger.countDocuments({ agentId })).toBe(1),
	)
	expect((await ledger.findOne({ agentId }))?.embedUnits).toBe(0)
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(1)
})
it("does not create a gate for invalid count no-ops", async () => {
	const agentId = `noop-${randomUUID()}`
	expect(recordEmbeddingSpend(db, prefix, agentId, "search", 0)).toBeUndefined()
	expect(
		recordLLMSpend(db, prefix, agentId, { inputTokens: Number.NaN }),
	).toBeUndefined()
	expect(await ledger.countDocuments({ agentId })).toBe(0)
	expect(await readErasureGate({ db, prefix, agentId })).toBeNull()
})
