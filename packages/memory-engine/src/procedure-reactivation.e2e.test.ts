import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import {
	findExactProcedureMatches,
	getProcedureHistoryByHandle,
	invalidateProcedureByHandle,
	updateProcedureByHandle,
	writeProcedure,
	type ProcedureEntry,
} from "./mongodb-procedures.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	type AdmissionToken,
} from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E144 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e144_reassert_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_",
	col = db.collection(`${prefix}procedures`)
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/procedure-reactivation-${label}.json`,
			JSON.stringify(data),
		)
}
function entry(): ProcedureEntry {
	return {
		agentId: randomUUID(),
		procedureId: "deploy",
		name: "Deploy",
		steps: ["build", "ship"],
		scope: "agent",
	}
}
function write(value: ProcedureEntry, admission: AdmissionToken) {
	return writeProcedure({
		db,
		prefix,
		entry: value,
		admission,
		embeddingMode: "automated",
	})
}
async function seedClosed() {
	const value = entry(),
		admission = await captureAdmissionToken({
			db,
			prefix,
			agentId: value.agentId,
		})
	await write(value, admission)
	const identity = { agentId: value.agentId, procedureId: value.procedureId }
	const row = await col.findOne(identity)
	expect(row).not.toBeNull()
	const handle = {
		family: "procedure",
		id: `procedure:${value.agentId}`,
		agentId: value.agentId,
		scope: "agent",
		scopeRef: `agent:${value.agentId}`,
		procedure: { procedureId: value.procedureId },
		revision: 1,
		state: "active",
	} as const
	await invalidateProcedureByHandle({
		db,
		prefix,
		handle,
		admission,
		invalidatedBy: { reason: "old procedure ended" },
	})
	const closed = await col.findOne(identity)
	expect(closed?.state).toBe("invalidated")
	return { value, admission, identity, handle, row, closed }
}
function current(value: ProcedureEntry, asOf?: Date) {
	return findExactProcedureMatches(col, "Deploy", {
		maxResults: 10,
		filter: {
			agentId: value.agentId,
			scope: "agent",
			scopeRef: `agent:${value.agentId}`,
			state: "active",
			currentOnly: true,
			...(asOf ? { asOf } : {}),
		},
	})
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
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
		vi.unstubAllEnvs()
		await client.close()
	}
})
it.each([
	"same",
	"changed",
	"present undefined",
] as const)("%s reactivation clears stale validity and preserves history end", async (kind) => {
	const e = await seedClosed(),
		before = new Date()
	await write(
		{
			...e.value,
			state: kind === "present undefined" ? undefined : "active",
			...(kind === "changed" ? { steps: ["build", "test", "ship"] } : {}),
		},
		e.admission,
	)
	const row = await col.findOne(e.identity)
	expect(row?.state).toBe("active")
	expect(row?.revision).toBe(3)
	expect(row?.validFrom.getTime()).toBeGreaterThanOrEqual(before.getTime())
	expect(row).not.toHaveProperty("validTo")
	expect(row).not.toHaveProperty("invalidatedBy")
	expect(await current(e.value)).toHaveLength(1)
	expect(await current(e.value, e.closed?.validTo)).toHaveLength(0)
	const history = await getProcedureHistoryByHandle({
		db,
		prefix,
		handle: e.handle,
	})
	expect(history).toHaveLength(3)
	expect(history[1].handle.state).toBe("invalidated")
	expect(history[1].handle.validTo).toEqual(e.closed?.validTo)
})
it.each([
	"absent",
	"invalidated",
] as const)("%s state does not reactivate", async (kind) => {
	const e = await seedClosed()
	const value =
		kind === "absent" ? e.value : { ...e.value, state: "invalidated" as const }
	const before = await col.findOne(e.identity)
	await write(value, e.admission)
	expect(await col.findOne(e.identity)).toEqual(before)
	expect(await current(e.value)).toHaveLength(0)
})
it("unchanged active write retains revision and validity start", async () => {
	const value = entry(),
		admission = await captureAdmissionToken({
			db,
			prefix,
			agentId: value.agentId,
		})
	await write(value, admission)
	const before = await col.findOne({ agentId: value.agentId })
	await write(value, admission)
	expect(await col.findOne({ agentId: value.agentId })).toEqual(before)
})
it("reactivation retains an imported expiry field", async () => {
	const e = await seedClosed(),
		expiresAt = new Date(Date.now() - 1000)
	await col.updateOne(e.identity, { $set: { expiresAt } })
	await write({ ...e.value, state: "active" }, e.admission)
	expect((await col.findOne(e.identity))?.expiresAt).toEqual(expiresAt)
})
it("by-handle update still rejects invalidated procedures", async () => {
	const e = await seedClosed()
	await expect(
		updateProcedureByHandle({
			db,
			prefix,
			handle: { ...e.handle, revision: 2, state: "invalidated" },
			patch: { name: "New deploy" },
			admission: e.admission,
			embeddingMode: "automated",
		}),
	).rejects.toMatchObject({ reason: "invalidated" })
})
it("a fault after actual reactivation update rolls row and snapshot back", async () => {
	const e = await seedClosed(),
		before = await col.findOne(e.identity)
	const revisions = db.collection(`${prefix}procedure_revisions`),
		history = await revisions.find(e.identity).toArray()
	const original = Collection.prototype.updateOne
	let hit = false
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
		async function (this: Collection, filter, update, options) {
			const result = await Reflect.apply(original, this, [
				filter,
				update,
				options,
			])
			if (
				!hit &&
				this.collectionName === `${prefix}procedures` &&
				options?.session
			) {
				hit = true
				throw new Error("owned procedure reactivation fault")
			}
			return result
		},
	)
	await expect(
		write({ ...e.value, state: "active" }, e.admission),
	).rejects.toThrow("owned procedure reactivation fault")
	vi.restoreAllMocks()
	expect(hit).toBe(true)
	expect(await col.findOne(e.identity)).toEqual(before)
	expect(await revisions.find(e.identity).toArray()).toEqual(history)
})
