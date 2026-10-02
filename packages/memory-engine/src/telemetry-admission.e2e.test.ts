import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { ensureCollections } from "./mongodb-schema.js"
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
	throw new Error("E84 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e84_telemetry_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/telemetry-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
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

it("rejects the original search telemetry after completed erasure", async () => {
	const agentId = `stale-${randomUUID()}`
	const admission = await captureAdmissionToken({ db, prefix, agentId })
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	const gate = await readErasureGate({ db, prefix, agentId })
	let error: unknown
	try {
		await emitTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "search" },
				durationMs: 1,
				ok: true,
				pathUsed: "erased-path",
				resultCount: 1,
			},
			{ admission },
		)
	} catch (caught) {
		error = caught
	}
	const rows = await db
		.collection(`${prefix}memory_telemetry`)
		.find({ "meta.agentId": agentId })
		.toArray()
	const afterGate = await readErasureGate({ db, prefix, agentId })
	evidence("stale", {
		admission,
		gate,
		afterGate,
		error:
			error instanceof Error
				? { name: error.name, code: Reflect.get(error, "code") }
				: error,
		rows,
	})
	expect(error).toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(rows).toEqual([])
	expect(afterGate).toEqual(gate)
})

it("persists fresh telemetry in the admitted transaction", async () => {
	const agentId = `fresh-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	await emitTelemetry(
		db,
		prefix,
		{ meta: { agentId, operation: "search" }, durationMs: 12, ok: true },
		{ admission },
	)
	const rows = await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray(),
		gate = await readErasureGate({ db, prefix, agentId })
	evidence("fresh", { rows, gate })
	expect(rows).toHaveLength(1)
	expect(rows[0]?.ts).toBeInstanceOf(Date)
	expect(gate?.serial).toBe(1)
})
it("rejects a wrong-user token before persistence", async () => {
	const owner = `owner-${randomUUID()}`,
		agentId = `other-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId: owner })
	const before = await readErasureGate({ db, prefix, agentId: owner })
	await expect(
		emitTelemetry(
			db,
			prefix,
			{ meta: { agentId, operation: "search" }, durationMs: 1, ok: true },
			{ admission },
		),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	const rows = await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray(),
		after = await readErasureGate({ db, prefix, agentId: owner }),
		other = await readErasureGate({ db, prefix, agentId })
	evidence("wrong-agent", { before, after, other, rows })
	expect(rows).toEqual([])
	expect(after).toEqual(before)
	expect(other).toBeNull()
})
it("propagates insert failure and rolls back the gate", async () => {
	const agentId = `fault-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const gate = await readErasureGate({ db, prefix, agentId })
	const failure = new Error("fixture insert failure")
	const insert = Collection.prototype.insertOne
	const spy = vi
		.spyOn(Collection.prototype, "insertOne")
		.mockImplementation(function (this: Collection, doc, ...rest) {
			if (
				this.collectionName === `${prefix}memory_telemetry` &&
				Reflect.get(doc, "meta")?.agentId === agentId
			)
				throw failure
			return insert.call(this, doc, ...rest)
		})
	try {
		await expect(
			emitTelemetry(
				db,
				prefix,
				{ meta: { agentId, operation: "search" }, durationMs: 1, ok: true },
				{ admission },
			),
		).rejects.toBe(failure)
	} finally {
		spy.mockRestore()
	}
	const afterGate = await readErasureGate({ db, prefix, agentId }),
		rows = await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray()
	evidence("insert-fault", { gate, afterGate, rows })
	expect(afterGate).toEqual(gate)
	expect(rows).toEqual([])
})
it("keeps legacy void calls as a new diagnostic intent", async () => {
	const agentId = `legacy-${randomUUID()}`
	expect(
		emitTelemetry(db, prefix, {
			meta: { agentId, operation: "search" },
			durationMs: 1,
			ok: true,
		}),
	).toBeUndefined()
	await vi.waitFor(async () =>
		expect(
			await db
				.collection(`${prefix}memory_telemetry`)
				.countDocuments({ "meta.agentId": agentId }),
		).toBe(1),
	)
	const gate = await readErasureGate({ db, prefix, agentId })
	evidence("legacy", { gate })
	expect(gate?.serial).toBe(1)
})
it("implicitly creates a missing ordinary telemetry sink", async () => {
	const alt = `missing_${randomUUID().replaceAll("-", "")}_`,
		agentId = `missing-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix: alt, agentId })
	await emitTelemetry(
		db,
		alt,
		{ meta: { agentId, operation: "search" }, durationMs: 1, ok: true },
		{ admission },
	)
	const rows = await db
		.collection(`${alt}memory_telemetry`)
		.find({ "meta.agentId": agentId })
		.toArray()
	const info = await db
			.listCollections({ name: `${alt}memory_telemetry` })
			.toArray(),
		gate = await readErasureGate({ db, prefix: alt, agentId })
	evidence("missing", { rows, info, gate })
	expect(rows).toHaveLength(1)
	expect(info[0]?.type).toBe("collection")
	expect(gate?.serial).toBe(1)
})
it("skips retained time-series telemetry without changing the gate", async () => {
	const alt = `timeseries_${randomUUID().replaceAll("-", "")}_`,
		agentId = `ts-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix: alt, agentId })
	await db.createCollection(`${alt}memory_telemetry`, {
		timeseries: { timeField: "ts", metaField: "meta" },
	})
	const gate = await readErasureGate({ db, prefix: alt, agentId })
	await emitTelemetry(
		db,
		alt,
		{ meta: { agentId, operation: "search" }, durationMs: 1, ok: true },
		{ admission },
	)
	const rows = await db
			.collection(`${alt}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray(),
		info = await db
			.listCollections({ name: `${alt}memory_telemetry` }, { nameOnly: false })
			.toArray(),
		afterGate = await readErasureGate({ db, prefix: alt, agentId })
	evidence("timeseries", { rows, info, gate, afterGate })
	expect(rows).toEqual([])
	expect(info[0]?.type).toBe("timeseries")
	expect(afterGate).toEqual(gate)
})
it.each([
	"disabled",
	"rate-zero",
] as const)("%s emission touches no gate or sink", async (mode) => {
	const agentId = `sampling-${randomUUID()}`,
		oldEnabled = process.env.MEMONGO_TELEMETRY_ENABLED,
		oldRate = process.env.MEMONGO_TELEMETRY_SAMPLE_RATE
	try {
		if (mode === "disabled") process.env.MEMONGO_TELEMETRY_ENABLED = "false"
		else process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = "0"
		await emitTelemetry(
			db,
			prefix,
			{ meta: { agentId, operation: "search" }, durationMs: 1, ok: true },
			{ admission: { kind: "admission", agentId, epoch: 0 } },
		)
		expect(
			emitTelemetry(db, prefix, {
				meta: { agentId, operation: "search" },
				durationMs: 1,
				ok: true,
			}),
		).toBeUndefined()
	} finally {
		if (oldEnabled === undefined) delete process.env.MEMONGO_TELEMETRY_ENABLED
		else process.env.MEMONGO_TELEMETRY_ENABLED = oldEnabled
		if (oldRate === undefined) delete process.env.MEMONGO_TELEMETRY_SAMPLE_RATE
		else process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = oldRate
	}
	const gate = await readErasureGate({ db, prefix, agentId }),
		rows = await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray()
	evidence(mode, { gate, rows })
	expect(gate).toBeNull()
	expect(rows).toEqual([])
})
it("preserves the awaited caller-owned session and its rollback", async () => {
	const agentId = `session-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const gate = await readErasureGate({ db, prefix, agentId })
	const failure = new Error("fixture caller rollback")
	await expect(
		withFencedWrite({
			db,
			prefix,
			token: admission,
			fn: async (session) => {
				await emitTelemetry(
					db,
					prefix,
					{ meta: { agentId, operation: "search" }, durationMs: 1, ok: true },
					{ session },
				)
				throw failure
			},
		}),
	).rejects.toBe(failure)
	const afterGate = await readErasureGate({ db, prefix, agentId }),
		rows = await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray()
	evidence("session", { gate, afterGate, rows })
	expect(rows).toEqual([])
	expect(afterGate).toEqual(gate)
})
