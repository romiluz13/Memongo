import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"

vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => true,
}))
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E37 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e37_lease_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const options = { minCombinedScore: 0, minIntervalMs: 0, maxEvents: 1 }
beforeAll(async () => {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/lease-fixture-worker.json`,
			JSON.stringify({ fixturePid: process.pid }),
		)
	await client.connect()
	await ensureCollections(db, prefix)
	await db.collection(`${prefix}consolidation_runs`).createIndex(
		{ gateKey: 1 },
		{
			unique: true,
			partialFilterExpression: { gateKey: { $type: "string" } },
		},
	)
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
	} finally {
		await client.close()
	}
})
describe("consolidation lease fence on the owned real database", () => {
	it("rejects an admitted empty run after erasure instead of recreating a lease", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		let release = () => {}
		let reached = () => {}
		const paused = new Promise<void>((resolve) => {
			reached = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		const original = Collection.prototype.findOneAndUpdate
		let intercepted = false
		const spy = vi
			.spyOn(Collection.prototype, "findOneAndUpdate")
			.mockImplementation(async function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				const result = await original.apply(this, args)
				if (
					!intercepted &&
					this.collectionName === `${prefix}meta` &&
					args[0]?._id === `tenant-erasure-epoch:${agentId}` &&
					!Array.isArray(args[1]) &&
					args[1]?.$setOnInsert
				) {
					intercepted = true
					reached()
					await resume
				}
				return result
			})
		const stale = consolidateMemory({ db, prefix, agentId, options }).then(
			(result) => ({ kind: "resolved" as const, result }),
			(error: Error & { code?: string }) => ({
				kind: "rejected" as const,
				error,
			}),
		)
		try {
			await Promise.race([
				paused,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("admission barrier not reached")),
						10000,
					)
					timer.unref()
				}),
			])
			const receipt = await deleteAllForAgent({ db, prefix, agentId })
			expect(receipt.status).toBe("complete")
			expect(receipt.gateState).toBe("open")
			const afterErase = await readErasureGate({ db, prefix, agentId })
			expect(afterErase).toMatchObject({ epoch: 1, state: "open" })
			release()
			const result = await stale
			const leases = await db
				.collection(`${prefix}consolidation_runs`)
				.find({ agentId })
				.toArray()
			writeFileSync(
				`${process.env.E22_FETCH_EVIDENCE_DIR}/lease-race-readback.json`,
				JSON.stringify({ result, afterErase, leases }),
			)
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected")
				expect(result.error.code).toBe("ERASURE_GATE_CONFLICT")
			expect(leases).toEqual([])
			expect(await readErasureGate({ db, prefix, agentId })).toEqual(afterErase)
		} finally {
			release()
			await stale
			spy.mockRestore()
		}
	})
	it("allows a fresh admitted empty run to complete", async () => {
		const agentId = `agent-${randomUUID()}`
		const result = await consolidateMemory({ db, prefix, agentId, options })
		expect(result).toMatchObject({
			agentId,
			eventsProcessed: 0,
			factsPromoted: 0,
		})
		expect(
			await db
				.collection(`${prefix}consolidation_runs`)
				.find({ agentId })
				.toArray(),
		).toEqual([
			expect.objectContaining({ status: "completed", runId: result.runId }),
		])
		const leases = db.collection(`${prefix}consolidation_runs`)
		const finished = await leases.findOne({ agentId })
		expect(finished).not.toHaveProperty("leaseToken")
		expect(finished).not.toHaveProperty("leaseExpiresAt")
		const gate = await readErasureGate({ db, prefix, agentId })
		expect(gate).toMatchObject({ epoch: 0, state: "open", serial: 1 })
		const paced = await consolidateMemory({
			db,
			prefix,
			agentId,
			options: { ...options, minIntervalMs: 3600000 },
		})
		expect(paced.eventsProcessed).toBe(0)
		expect(paced.runId).not.toBe(result.runId)
		expect(await leases.findOne({ agentId })).toEqual(finished)
		expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/lease-fresh-readback.json`,
			JSON.stringify({ gate, finished, paced }),
		)
	})
	it("keeps a live lease and rolls back the competing admission fence", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		const gateKey = [agentId, "", ""]
			.map((part) => `${part.length}:${JSON.stringify(part)}`)
			.join("|")
		const leases = db.collection(`${prefix}consolidation_runs`)
		await leases.insertOne({
			agentId,
			gateKey,
			runId: "live-owner",
			status: "running",
			startedAt: new Date(),
			leaseToken: "live-token",
			leaseExpiresAt: new Date(Date.now() + 60000),
		})
		const before = await leases.findOne({ agentId })
		const gate = await readErasureGate({ db, prefix, agentId })
		const result = await consolidateMemory({ db, prefix, agentId, options })
		expect(result.eventsProcessed).toBe(0)
		expect(await leases.findOne({ agentId })).toEqual(before)
		expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/lease-live-readback.json`,
			JSON.stringify({ gate, before, result }),
		)
	})
	it("allows one of two concurrent claims without committing the loser's fence", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		const results = await Promise.all(
			[0, 1].map(() =>
				consolidateMemory({
					db,
					prefix,
					agentId,
					options: { ...options, minIntervalMs: 3600000 },
				}),
			),
		)
		const leases = await db
			.collection(`${prefix}consolidation_runs`)
			.find({ agentId })
			.toArray()
		expect(leases).toHaveLength(1)
		expect(leases[0]).toMatchObject({ status: "completed" })
		expect(
			results.filter((result) => result.runId === leases[0]?.runId),
		).toHaveLength(1)
		expect(leases[0]).not.toHaveProperty("leaseToken")
		expect(leases[0]).not.toHaveProperty("leaseExpiresAt")
		expect(await readErasureGate({ db, prefix, agentId })).toMatchObject({
			epoch: 0,
			state: "open",
			serial: 1,
		})
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/lease-concurrent-readback.json`,
			JSON.stringify({
				results,
				leases,
				gate: await readErasureGate({ db, prefix, agentId }),
			}),
		)
	})
})
