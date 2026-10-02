import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, FindCursor, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { consolidateMemory, matchPatterns } from "./mongodb-consolidator.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
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
	throw new Error("E73 requires explicit owned server")
const client = new MongoClient(uri)
const name = `memongo_e73_ack_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const body = "ordinary conversation"
const options = { minCombinedScore: 0, minIntervalMs: 0, maxEvents: 1 }
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/ack-${label}.json`,
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
describe("consolidation acknowledgement run lease ownership", () => {
	it("does not stamp a successor event after same-epoch lease takeover", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		let release!: () => void, signal!: () => void
		const paused = new Promise<void>((resolve) => {
			signal = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		let intercepted = false
		const original = FindCursor.prototype.toArray
		const spy = vi
			.spyOn(FindCursor.prototype, "toArray")
			.mockImplementation(async function (this: FindCursor<Document>) {
				if (
					!intercepted &&
					this.namespace.db === name &&
					this.namespace.collection === `${prefix}structured_mem`
				) {
					intercepted = true
					signal()
					await resume
					return []
				}
				return original.call(this)
			})
		const stale = consolidateMemory({ db, prefix, agentId, options }).then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		)
		try {
			await Promise.race([
				paused,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("ack lease barrier not reached")),
						10000,
					)
					timer.unref()
				}),
			])
			const oldRun = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId })
			expect(oldRun?.status).toBe("running")
			await db
				.collection(`${prefix}consolidation_runs`)
				.updateOne(
					{ agentId, runId: oldRun?.runId },
					{ $set: { leaseExpiresAt: new Date(0) } },
				)
			const successor = await consolidateMemory({
				db,
				prefix,
				agentId,
				options,
			})
			expect(successor.runId).not.toBe(oldRun?.runId)
			expect(successor.eventsProcessed).toBe(1)
			const before = await db
				.collection(`${prefix}events`)
				.findOne({ agentId, eventId })
			const beforeRun = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId })
			const beforeGate = await readErasureGate({ db, prefix, agentId })
			expect(before?.dreamerRunId).toBe(successor.runId)
			expect(beforeGate?.epoch).toBe(0)
			release()
			const outcome = await stale
			const after = await db
				.collection(`${prefix}events`)
				.findOne({ agentId, eventId })
			const afterRun = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId })
			const afterGate = await readErasureGate({ db, prefix, agentId })
			evidence("lease-takeover", {
				oldRun,
				successor,
				before,
				beforeRun,
				beforeGate,
				after,
				afterRun,
				afterGate,
				outcome: {
					value: outcome.value,
					error:
						outcome.error instanceof Error
							? { name: outcome.error.name, message: outcome.error.message }
							: outcome.error,
				},
			})
			expect(outcome.error).toMatchObject({
				name: "ConsolidationLeaseLostError",
			})
			expect(after).toEqual(before)
			expect(afterRun).toEqual(beforeRun)
			expect(afterGate).toEqual(beforeGate)
		} finally {
			release()
			await stale
			spy.mockRestore()
		}
	})
	it("rolls back the lease touch and gate when acknowledgement fails", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		let beforeRun: Document | null = null
		const captured: { insideRun?: Document | null; beforeExpiry?: Date } = {}
		let beforeGate: unknown
		let intercepted = false
		const futureExpiry = new Date("2035-01-01T00:00:00.000Z")
		const originalCursor = FindCursor.prototype.toArray
		const cursorSpy = vi
			.spyOn(FindCursor.prototype, "toArray")
			.mockImplementation(async function (this: FindCursor<Document>) {
				if (
					!intercepted &&
					this.namespace.db === name &&
					this.namespace.collection === `${prefix}structured_mem`
				) {
					intercepted = true
					await db
						.collection(`${prefix}consolidation_runs`)
						.updateOne(
							{ agentId, status: "running" },
							{ $set: { leaseExpiresAt: futureExpiry } },
						)
					return []
				}
				return originalCursor.call(this)
			})
		const fault = new Error("ack write fixture failure")
		const original = Collection.prototype.updateMany
		const spy = vi
			.spyOn(Collection.prototype, "updateMany")
			.mockImplementation(async function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				if (
					this.namespace === `${name}.${prefix}events` &&
					!Array.isArray(args[1]) &&
					args[1]?.$set?.dreamerRunId
				) {
					beforeRun = await db
						.collection(`${prefix}consolidation_runs`)
						.findOne({ agentId })
					beforeGate = await readErasureGate({ db, prefix, agentId })
					captured.beforeExpiry = beforeRun?.leaseExpiresAt
					expect(args[2]?.session).toBeDefined()
					captured.insideRun = await db
						.collection(`${prefix}consolidation_runs`)
						.findOne({ agentId }, { session: args[2]?.session })
					throw fault
				}
				return original.apply(this, args)
			})
		try {
			await expect(
				consolidateMemory({ db, prefix, agentId, options }),
			).rejects.toBe(fault)
			const afterRun = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId })
			const afterGate = await readErasureGate({ db, prefix, agentId })
			const current = await db
				.collection(`${prefix}events`)
				.findOne({ agentId, eventId })
			evidence("lease-rollback", {
				beforeRun,
				insideRun: captured.insideRun,
				beforeGate,
				afterRun,
				afterGate,
				current,
			})
			expect(beforeRun).not.toBeNull()
			expect(captured.beforeExpiry).toEqual(futureExpiry)
			expect(captured.insideRun?.leaseExpiresAt.getTime()).toBeGreaterThan(
				futureExpiry.getTime(),
			)
			expect(afterRun).toEqual(beforeRun)
			expect(afterGate).toEqual(beforeGate)
			expect(current?.dreamerRunId).toBeUndefined()
		} finally {
			spy.mockRestore()
			cursorSpy.mockRestore()
		}
	})
	it("acknowledges an event under its live run lease", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const result = await consolidateMemory({ db, prefix, agentId, options })
		const current = await db
			.collection(`${prefix}events`)
			.findOne({ agentId, eventId })
		const run = await db
			.collection(`${prefix}consolidation_runs`)
			.findOne({ agentId })
		evidence("lease-fresh", { result, current, run })
		expect(result.eventsProcessed).toBe(1)
		expect(current?.dreamerRunId).toBe(result.runId)
		expect(run?.status).toBe("completed")
	})
})
