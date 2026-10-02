import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient, ObjectId } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { ensureCollections } from "./mongodb-schema.js"
import { captureAdmissionToken } from "./mongodb-write-fence.js"

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
}))

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E147 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e147_driver_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
const revisions = db.collection(`${prefix}structured_mem_revisions`)
const cache = db.collection(`${prefix}query_cache`)
const audits = db.collection(`${prefix}memory_mutations`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/prune-driver-${label}.json`,
			JSON.stringify(value),
		)
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
async function seed() {
	const agentId = randomUUID(),
		now = new Date()
	await captureAdmissionToken({ db, prefix, agentId })
	const identity = {
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		type: "fact",
	}
	const old: Document = {
		...identity,
		_id: new ObjectId(),
		key: "old",
		value: "London cycling observation.",
		state: "active",
		revision: 1,
		validFrom: new Date(now.getTime() - 20000),
		updatedAt: new Date(now.getTime() - 10000),
		provenance: { origin: "observed" },
	}
	const newer: Document = {
		...old,
		_id: new ObjectId(),
		key: "new",
		value: "London commute observation.",
		updatedAt: now,
	}
	await col.insertMany([old, newer])
	await db.collection(`${prefix}events`).insertOne({
		eventId: randomUUID(),
		...identity,
		body: "meeting notes",
		role: "user",
		timestamp: now,
		importance: 1,
	})
	await cache.insertOne({
		...identity,
		queryHash: randomUUID(),
		queryNorm: "commute",
		results: [],
		pathUsed: "text",
		sourceScope: "agent",
		createdAt: now,
		expiresAt: new Date(now.getTime() + 60000),
		hitCount: 0,
		lastHitAt: now,
	})
	return { agentId, old, newer }
}

it.each([
	"driver retired",
	"driver kept",
] as const)("%s: remaining pairs use only a live driver", async (kind) => {
	const e = await seed(),
		third = {
			...e.old,
			_id: new ObjectId(),
			key: "third",
			value: "Third cycling observation.",
			updatedAt: new Date(e.old.updatedAt.getTime() - 10000),
		}
	await col.insertOne(third)
	const original = Collection.prototype.aggregate
	let calls = 0
	vi.spyOn(Collection.prototype, "aggregate").mockImplementation(function (
		this: Collection<Document>,
		...args: Parameters<typeof original>
	) {
		const cursor = original.apply(this, args)
		if (
			this.collectionName === col.collectionName &&
			args[0]?.[0]?.$vectorSearch?.filter?.agentId === e.agentId
		) {
			vi.spyOn(cursor, "toArray").mockImplementation(async () => {
				if (++calls !== 1) return []
				if (kind === "driver retired") {
					e.old.updatedAt = new Date(e.newer.updatedAt.getTime() + 10000)
					await col.updateOne(
						{ _id: e.old._id },
						{ $set: { updatedAt: e.old.updatedAt } },
					)
				}
				return [
					{ ...e.old, score: 0.97 },
					{ ...third, score: 0.97 },
				]
			})
		}
		return cursor
	})
	const result = await consolidateMemory({
		db,
		prefix,
		agentId: e.agentId,
		options: { maxEvents: 1, minCombinedScore: 0, minIntervalMs: 0 },
	})
	const count = kind === "driver retired" ? 1 : 2
	expect(result.factsPruned).toBe(count)
	expect(await revisions.countDocuments({ agentId: e.agentId })).toBe(count)
	expect(
		await audits.countDocuments({
			agentId: e.agentId,
			operation: "invalidate",
		}),
	).toBe(count)
	if (kind === "driver retired") {
		expect(await col.findOne({ _id: e.newer._id })).toMatchObject({
			state: "invalidated",
			revision: 2,
		})
		expect(await col.findOne({ _id: third._id })).toEqual(third)
		expect(await col.findOne({ _id: e.old._id })).toEqual(e.old)
	} else {
		expect(await col.findOne({ _id: e.newer._id })).toEqual(e.newer)
		expect(await col.findOne({ _id: e.old._id })).toMatchObject({
			state: "invalidated",
			revision: 2,
		})
		expect(await col.findOne({ _id: third._id })).toMatchObject({
			state: "invalidated",
			revision: 2,
		})
	}
})
