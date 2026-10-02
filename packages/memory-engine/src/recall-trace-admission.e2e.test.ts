import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import {
	Collection,
	type Document,
	MongoClient,
	MongoServerError,
} from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { recordRecallTrace } from "./mongodb-recall-traces.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E82 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e82_trace_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/trace-${label}.json`,
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

it("rejects the original-read trace after completed erasure", async () => {
	const agentId = `stale-${randomUUID()}`
	const admission = await captureAdmissionToken({ db, prefix, agentId })
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	const gate = await readErasureGate({ db, prefix, agentId })
	const params = {
		db,
		prefix,
		admission,
		privacyMode: "redacted-hash" as const,
		trace: {
			agentId,
			query: "erased private question",
			lanesUsed: ["hybrid"],
			topHitIds: ["erased-event"],
			totalHits: 1,
		},
	}
	let error: unknown
	try {
		await recordRecallTrace(params)
	} catch (caught) {
		error = caught
	}
	const traces = await db
		.collection(`${prefix}recall_traces`)
		.find({ agentId })
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
		traces,
	})
	expect(error).toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(traces).toEqual([])
	expect(afterGate).toEqual(gate)
})

it.each([
	"none",
	"redacted-hash",
	"raw",
] as const)("persists fresh %s privacy mode with the supplied trace identity", async (privacyMode) => {
	const agentId = `fresh-${privacyMode}-${randomUUID()}`
	const admission = await captureAdmissionToken({ db, prefix, agentId })
	const traceId = randomUUID(),
		timestamp = new Date("2026-09-29T12:00:00Z")
	expect(
		await recordRecallTrace({
			db,
			prefix,
			admission,
			privacyMode,
			trace: {
				agentId,
				traceId,
				timestamp,
				query: "סוד private 123",
				totalHits: 1,
				lanesUsed: ["hybrid"],
			},
		}),
	).toBe(traceId)
	const traces = await db
		.collection(`${prefix}recall_traces`)
		.find({ agentId })
		.toArray()
	const gate = await readErasureGate({ db, prefix, agentId })
	evidence(`fresh-${privacyMode}`, { traces, gate })
	expect(traces).toHaveLength(1)
	expect(traces[0]?.traceId).toBe(traceId)
	expect(traces[0]?.timestamp).toEqual(timestamp)
	expect(gate?.serial).toBe(1)
	if (privacyMode === "none") {
		expect(traces[0]).not.toHaveProperty("query")
		expect(traces[0]).not.toHaveProperty("queryHash")
	} else {
		expect(traces[0]?.queryHash).toMatch(/^[a-f0-9]{64}$/)
		expect(traces[0]?.query).toBe(
			privacyMode === "raw" ? "סוד private 123" : "xxx xxxxxxx xxx",
		)
	}
})
it("rejects a different agent's token before writing either gate", async () => {
	const agentId = `owner-${randomUUID()}`,
		otherId = `other-${randomUUID()}`
	await captureAdmissionToken({ db, prefix, agentId })
	const admission = await captureAdmissionToken({
		db,
		prefix,
		agentId: otherId,
	})
	const ownerGate = await readErasureGate({ db, prefix, agentId }),
		otherGate = await readErasureGate({ db, prefix, agentId: otherId })
	await expect(
		recordRecallTrace({
			db,
			prefix,
			admission,
			privacyMode: "raw",
			trace: { agentId, query: "private", lanesUsed: [], totalHits: 0 },
		}),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(
		await db.collection(`${prefix}recall_traces`).countDocuments({ agentId }),
	).toBe(0)
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(ownerGate)
	expect(await readErasureGate({ db, prefix, agentId: otherId })).toEqual(
		otherGate,
	)
	evidence("wrong-agent", { ownerGate, otherGate, traces: [] })
})
it("rolls the gate back and preserves an ordinary insert fault", async () => {
	const agentId = `failure-${randomUUID()}`
	const admission = await captureAdmissionToken({ db, prefix, agentId })
	const gate = await readErasureGate({ db, prefix, agentId })
	const error = new Error("owned trace insert fault")
	const original = Collection.prototype.insertOne
	const spy = vi
		.spyOn(Collection.prototype, "insertOne")
		.mockImplementation(function (
			this: Collection<Document>,
			...args: Parameters<typeof original>
		) {
			if (
				this.collectionName === `${prefix}recall_traces` &&
				args[0].agentId === agentId
			)
				return Promise.reject(error)
			return original.apply(this, args)
		})
	try {
		await expect(
			recordRecallTrace({
				db,
				prefix,
				admission,
				privacyMode: "none",
				trace: { agentId, query: "private", lanesUsed: [], totalHits: 0 },
			}),
		).rejects.toBe(error)
		expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
		const traces = await db
			.collection(`${prefix}recall_traces`)
			.find({ agentId })
			.toArray()
		expect(traces).toEqual([])
		evidence("insert-fault", {
			gate,
			afterGate: await readErasureGate({ db, prefix, agentId }),
			traces,
		})
	} finally {
		spy.mockRestore()
	}
})
it("admits a legacy recorder call as a new trace intent", async () => {
	const agentId = `legacy-${randomUUID()}`
	const traceId = await recordRecallTrace({
		db,
		prefix,
		privacyMode: "none",
		trace: { agentId, query: "private", totalHits: 0, lanesUsed: [] },
	})
	const traces = await db
		.collection(`${prefix}recall_traces`)
		.find({ agentId })
		.toArray()
	const gate = await readErasureGate({ db, prefix, agentId })
	expect(traces).toHaveLength(1)
	expect(traces[0]?.traceId).toBe(traceId)
	expect(gate?.serial).toBe(1)
	evidence("legacy", { traces, gate })
})

it("retries an aborted callback with the same document identity and one committed gate bump", async () => {
	const agentId = `callback-retry-${randomUUID()}`
	const admission = await captureAdmissionToken({ db, prefix, agentId })
	const original = Collection.prototype.insertOne
	const identities: unknown[] = []
	const spy = vi
		.spyOn(Collection.prototype, "insertOne")
		.mockImplementation(async function (
			this: Collection<Document>,
			...args: Parameters<typeof original>
		) {
			if (
				this.collectionName !== `${prefix}recall_traces` ||
				args[0].agentId !== agentId
			)
				return original.apply(this, args)
			const result = await original.apply(this, args)
			identities.push(args[0]._id)
			if (identities.length === 1)
				throw new MongoServerError({
					message: "owned retryable abort",
					errorLabels: ["TransientTransactionError"],
				})
			return result
		})
	try {
		const traceId = await recordRecallTrace({
			db,
			prefix,
			admission,
			privacyMode: "none",
			trace: { agentId, query: "private", lanesUsed: [], totalHits: 0 },
		})
		const traces = await db
			.collection(`${prefix}recall_traces`)
			.find({ agentId })
			.toArray()
		const gate = await readErasureGate({ db, prefix, agentId })
		expect(identities).toHaveLength(2)
		expect(identities[0]).toEqual(identities[1])
		expect(traces).toHaveLength(1)
		expect(traces[0]?.traceId).toBe(traceId)
		expect(traces[0]?._id).toEqual(identities[0])
		expect(gate?.serial).toBe(1)
		evidence("callback-retry", { identities, traces, gate })
	} finally {
		spy.mockRestore()
	}
})
