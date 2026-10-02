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

vi.mock("./mongodb-novelty.js", () => ({
	scanNovelty: vi.fn(async () => ({ events: [], scannedCount: 0 })),
}))
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
	throw new Error("E42 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e42_graph_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const content = "meeting notes: @alice and @bobby"
const options = { minCombinedScore: 0, minIntervalMs: 0, maxEvents: 1 }
let ownedAgent = ""
function readback(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/graph-${label}-readback.json`,
			JSON.stringify(value, null, 2),
		)
}
async function rows(agentId: string) {
	return {
		entities: await db
			.collection(`${prefix}entities`)
			.find({ agentId })
			.toArray(),
		relations: await db
			.collection(`${prefix}relations`)
			.find({ agentId })
			.toArray(),
		links: await db
			.collection(`${prefix}entity_links`)
			.find({ agentId })
			.toArray(),
		projections: await db
			.collection(`${prefix}projection_runs`)
			.find({ agentId })
			.toArray(),
		telemetry: await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray(),
		events: await db.collection(`${prefix}events`).find({ agentId }).toArray(),
		gate: await readErasureGate({ db, prefix, agentId }),
	}
}

beforeAll(async () => {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/graph-fixture-worker.json`,
			JSON.stringify({ fixturePid: process.pid }),
		)
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "true")
	vi.stubEnv("MEMONGO_TELEMETRY_SAMPLE_RATE", "1")
	await client.connect()
	await ensureCollections(db, prefix)
	const [telemetry] = await db
		.listCollections({ name: `${prefix}memory_telemetry` }, { nameOnly: false })
		.toArray()
	expect(telemetry?.type).toBe("collection")
	readback("schema", { telemetry })
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
	vi.unstubAllEnvs()
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
async function seed(agentId: string, body = content) {
	const eventId = randomUUID()
	await db.collection(`${prefix}events`).insertOne({
		eventId,
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		body,
		role: "user",
		timestamp: new Date(),
		importance: 1,
		createdAt: new Date(),
	})
	return eventId
}
describe("direct consolidation graph fence on the owned real database", () => {
	it("rejects a stale source read after complete erasure and commits fresh graph", async () => {
		ownedAgent = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId: ownedAgent })
		await seed(ownedAgent)
		let release = () => {}
		let reached = () => {}
		const paused = new Promise<void>((resolve) => {
			reached = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		const originalFind = Collection.prototype.find
		let intercepted = false
		const spy = vi
			.spyOn(Collection.prototype, "find")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof originalFind>
			) {
				const cursor = originalFind.apply(this, args)
				const filter = args[0]
				if (
					!intercepted &&
					this.collectionName === `${prefix}events` &&
					filter?.agentId === ownedAgent &&
					filter?.dreamerProcessedAt
				) {
					intercepted = true
					const toArray = cursor.toArray.bind(cursor)
					vi.spyOn(cursor, "toArray").mockImplementation(async () => {
						const rows = await toArray()
						expect(rows).toHaveLength(1)
						reached()
						await resume
						return rows
					})
				}
				return cursor
			})
		const stale = consolidateMemory({
			db,
			prefix,
			agentId: ownedAgent,
			options,
		}).then(
			(result) => ({ kind: "resolved" as const, result }),
			(error) => ({
				kind: "rejected" as const,
				error: error as Error & { code?: string },
			}),
		)
		try {
			await Promise.race([
				paused,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("source barrier not reached")),
						10000,
					)
					timer.unref()
				}),
			])
			const receipt = await deleteAllForAgent({
				db,
				prefix,
				agentId: ownedAgent,
			})
			expect(receipt.status).toBe("complete")
			expect(receipt.gateState).toBe("open")
			const afterErase = await readErasureGate({
				db,
				prefix,
				agentId: ownedAgent,
			})
			expect(afterErase).toMatchObject({ epoch: 1, state: "open" })
			release()
			const result = await stale
			const staleRows = await rows(ownedAgent)
			readback("stale", { result, afterErase, ...staleRows })
			expect(staleRows.relations).toHaveLength(0)
			expect(staleRows.links).toHaveLength(0)
			expect(staleRows.projections).toHaveLength(0)
			expect(staleRows.telemetry).toHaveLength(0)
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected")
				expect(result.error.code).toBe("ERASURE_GATE_CONFLICT")
			expect(
				await db
					.collection(`${prefix}entities`)
					.countDocuments({ agentId: ownedAgent }),
			).toBe(0)
			expect(
				(await readErasureGate({ db, prefix, agentId: ownedAgent }))?.serial,
			).toBe(afterErase?.serial)
			expect(
				await db
					.collection(`${prefix}consolidation_runs`)
					.countDocuments({ agentId: ownedAgent }),
			).toBe(0)
			expect(
				await db.collection(`${prefix}events`).countDocuments({
					agentId: ownedAgent,
					dreamerProcessedAt: { $exists: true },
				}),
			).toBe(0)
			spy.mockRestore()
			await seed(ownedAgent)
			await consolidateMemory({ db, prefix, agentId: ownedAgent, options })
			expect(
				await db
					.collection(`${prefix}entities`)
					.countDocuments({ agentId: ownedAgent }),
			).toBe(2)
			expect(
				(await readErasureGate({ db, prefix, agentId: ownedAgent }))?.serial,
			).toBe((afterErase?.serial ?? 0) + 4)
		} finally {
			release()
			await stale
			spy.mockRestore()
		}
	})
	it("commits fresh and zero-extraction diagnostics with exact serials", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		await seed(agentId)
		await consolidateMemory({ db, prefix, agentId, options })
		const fresh = await rows(agentId)
		readback("fresh", fresh)
		expect(fresh.entities).toHaveLength(2)
		expect(fresh.relations).toHaveLength(1)
		expect(fresh.links).toHaveLength(1)
		expect(fresh.projections).toHaveLength(2)
		expect(
			fresh.telemetry.filter((x) => x.meta.operation === "entity-extraction"),
		).toHaveLength(1)
		expect(
			fresh.telemetry.filter((x) => x.meta.operation === "projection-run"),
		).toHaveLength(2)
		expect(fresh.events[0].dreamerProcessedAt).toBeInstanceOf(Date)
		expect(fresh.gate?.serial).toBe(4)
		const zeroId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId: zeroId })
		await seed(zeroId, "lowercase meeting notes")
		await consolidateMemory({ db, prefix, agentId: zeroId, options })
		const zero = await rows(zeroId)
		readback("zero", zero)
		expect(zero.entities).toHaveLength(0)
		expect(zero.projections).toHaveLength(2)
		expect(
			zero.projections.every(
				(x) => x.status === "ok" && x.itemsProjected === 0,
			),
		).toBe(true)
		expect(
			zero.telemetry.filter((x) => x.meta.operation === "entity-extraction"),
		).toHaveLength(0)
		expect(
			zero.telemetry.filter((x) => x.meta.operation === "projection-run"),
		).toHaveLength(2)
		expect(zero.gate?.serial).toBe(4)
	})
	it("rolls back failed graph content and keeps a successful peer acknowledged", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		const failedId = await seed(agentId)
		const goodId = await seed(agentId, "meeting notes: @carol and @david")
		const originalBulk = Collection.prototype.bulkWrite
		let failed = false
		const spy = vi
			.spyOn(Collection.prototype, "bulkWrite")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof originalBulk>
			) {
				const op = args[0][0]
				const filter = op && "updateOne" in op ? op.updateOne.filter : undefined
				if (
					!failed &&
					this.collectionName === `${prefix}relations` &&
					filter?.agentId === agentId &&
					op &&
					"updateOne" in op &&
					!Array.isArray(op.updateOne.update) &&
					op.updateOne.update.$addToSet?.sourceEventIds === failedId
				) {
					failed = true
					throw new Error("injected relation persistence failure")
				}
				return originalBulk.apply(this, args)
			})
		try {
			const failure = await consolidateMemory({
				db,
				prefix,
				agentId,
				options: { ...options, maxEvents: 2 },
			}).catch((error: unknown) => error)
			const after = await rows(agentId)
			readback("peer", { failure, ...after })
			expect(failure).toBeInstanceOf(Error)
			expect(after.entities).toHaveLength(2)
			expect(
				after.entities.every((x) => ["carol", "david"].includes(x.name)),
			).toBe(true)
			expect(after.relations).toHaveLength(1)
			expect(after.links).toHaveLength(1)
			expect(
				after.projections.filter((x) => x.status === "failed"),
			).toHaveLength(2)
			expect(after.projections.filter((x) => x.status === "ok")).toHaveLength(2)
			expect(
				after.telemetry.filter(
					(x) => x.meta.operation === "entity-extraction" && !x.ok,
				),
			).toHaveLength(1)
			expect(
				after.events.find((x) => x.eventId === failedId)?.dreamerProcessedAt,
			).toBeUndefined()
			expect(
				after.events.find((x) => x.eventId === goodId)?.dreamerProcessedAt,
			).toBeInstanceOf(Date)
			expect(after.gate?.serial).toBe(5)
		} finally {
			spy.mockRestore()
		}
	})
	it("keeps committed graph and acknowledgment when diagnostics fail", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		await seed(agentId)
		const originalInsert = Collection.prototype.insertOne
		const spy = vi
			.spyOn(Collection.prototype, "insertOne")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof originalInsert>
			) {
				if (
					this.collectionName === `${prefix}projection_runs` &&
					args[0].agentId === agentId &&
					args[0].projectionType === "relations"
				)
					throw new Error("injected diagnostic persistence failure")
				return originalInsert.apply(this, args)
			})
		try {
			await consolidateMemory({ db, prefix, agentId, options })
			const after = await rows(agentId)
			readback("diagnostic", after)
			expect(after.entities).toHaveLength(2)
			expect(after.projections).toHaveLength(0)
			expect(after.telemetry).toHaveLength(0)
			expect(after.events[0].dreamerProcessedAt).toBeInstanceOf(Date)
			expect(after.gate?.serial).toBe(3)
		} finally {
			spy.mockRestore()
		}
	})
})
