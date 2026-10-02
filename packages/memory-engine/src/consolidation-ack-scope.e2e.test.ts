import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { FindCursor, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { consolidateMemory, matchPatterns } from "./mongodb-consolidator.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
	withFencedWrite,
} from "./mongodb-write-fence.js"

vi.mock("./mongodb-novelty.js", () => ({
	scanNovelty: vi.fn(async () => ({ events: [], scannedCount: 0 })),
}))
vi.mock("./mongodb-graph.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-graph.js")>()),
	extractAndUpsertEntities: vi.fn(async () => ({
		entities: [],
		relationsCreated: 0,
		diagnostics: {
			durationMs: 0,
			extractionMethod: "regex",
			entitiesExtracted: 0,
			relationsCreated: 0,
		},
	})),
}))
vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => true,
	resolveEnrichmentProvider: () => {
		throw new Error("ack fixture must not resolve provider")
	},
}))
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E62 requires explicit owned server")
const client = new MongoClient(uri)
const name = `memongo_e62_ack_scope_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const body = "ordinary conversation"
const options = { minCombinedScore: 0, minIntervalMs: 0, maxEvents: 1 }
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/ack-scope-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	expect(matchPatterns(body)).toBeNull()
	await client.connect()
	await ensureCollections(db, prefix)
	await db
		.collection(`${prefix}events`)
		.createIndex({ eventId: 1 }, { name: "uq_events_eventid", unique: true })
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
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		await client.close()
	}
})
function event(agentId: string, eventId: string, text = body) {
	const now = new Date()
	return {
		eventId,
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		body: text,
		role: "user",
		timestamp: now,
		importance: 1,
		createdAt: now,
	}
}
async function seed(agentId: string) {
	await captureAdmissionToken({ db, prefix, agentId })
	const eventId = randomUUID()
	await db.collection(`${prefix}events`).insertOne(event(agentId, eventId))
	return eventId
}
describe("consolidation acknowledgement tenant floor", () => {
	it("does not stamp another tenant after simulated TTL deletion", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const old = await db.collection(`${prefix}events`).findOne({ eventId })
		let release!: () => void, signal!: () => void
		const paused = new Promise<void>((resolve) => {
			signal = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		let calls = 0
		const original = FindCursor.prototype.toArray
		const spy = vi
			.spyOn(FindCursor.prototype, "toArray")
			.mockImplementation(async function (this: FindCursor<Document>) {
				if (
					this.namespace.db === name &&
					this.namespace.collection === `${prefix}structured_mem` &&
					calls++ === 0
				) {
					signal()
					await resume
					return []
				}
				return original.call(this)
			})
		const pending = consolidateMemory({ db, prefix, agentId, options }).then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		)
		try {
			await paused
			const expiredAt = new Date(Date.now() - 1000)
			await db
				.collection(`${prefix}events`)
				.updateOne({ _id: old?._id }, { $set: { expiresAt: expiredAt } })
			// Controlled deletion models TTL without running its background task.
			expect(
				(
					await db
						.collection(`${prefix}events`)
						.deleteOne({ _id: old?._id, expiresAt: expiredAt })
				).deletedCount,
			).toBe(1)
			const otherAgentId = `agent-${randomUUID()}`
			const token = await captureAdmissionToken({
				db,
				prefix,
				agentId: otherAgentId,
			})
			await withFencedWrite({
				db,
				prefix,
				token,
				fn: (session) =>
					db
						.collection(`${prefix}events`)
						.insertOne(
							event(otherAgentId, eventId, "other tenant conversation"),
							{ session },
						),
			})
			const before = await db.collection(`${prefix}events`).findOne({ eventId })
			expect(before?._id).not.toEqual(old?._id)
			const gate = await readErasureGate({ db, prefix, agentId })
			const otherGate = await readErasureGate({
				db,
				prefix,
				agentId: otherAgentId,
			})
			release()
			const outcome = await pending
			const after = await db.collection(`${prefix}events`).findOne({ eventId })
			const afterGate = await readErasureGate({ db, prefix, agentId })
			const afterOtherGate = await readErasureGate({
				db,
				prefix,
				agentId: otherAgentId,
			})
			evidence("stale", {
				old,
				before,
				after,
				otherGate,
				afterOtherGate,
				gate,
				afterGate,
				calls,
				error:
					outcome.error instanceof Error
						? { name: outcome.error.name, message: outcome.error.message }
						: outcome.error,
			})
			expect(calls).toBeGreaterThanOrEqual(1)
			expect(outcome.error).toBeUndefined()
			expect(after).toEqual(before)
			expect(afterOtherGate).toEqual(otherGate)
			expect(afterGate).toMatchObject({
				epoch: gate?.epoch,
				state: "open",
				serial: (gate?.serial ?? 0) + 1,
			})
		} finally {
			release()
			await pending
			spy.mockRestore()
		}
	})
	it("acknowledges a fresh event using its own run", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const result = await consolidateMemory({ db, prefix, agentId, options })
		const current = await db.collection(`${prefix}events`).findOne({ eventId })
		const gate = await readErasureGate({ db, prefix, agentId })
		evidence("fresh", { result, current, gate })
		expect(result.eventsProcessed).toBe(1)
		expect(current?.dreamerRunId).toBe(result.runId)
		expect(current?.dreamerProcessedAt).toBeInstanceOf(Date)
	})
	it("does not add an acknowledgement fence when no events exist", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		const result = await consolidateMemory({ db, prefix, agentId, options })
		const gate = await readErasureGate({ db, prefix, agentId })
		evidence("empty", { result, gate })
		expect(result.eventsProcessed).toBe(0)
		expect(gate?.serial).toBe(1)
	})
})
