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
	throw new Error("E145 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e145_prune_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
const revisions = db.collection(`${prefix}structured_mem_revisions`)
const cache = db.collection(`${prefix}query_cache`)
const audits = db.collection(`${prefix}memory_mutations`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/prune-history-${label}.json`,
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
function vector(
	agentId: string,
	duplicate: Document,
	beforeReturn = async () => {},
) {
	const original = Collection.prototype.aggregate
	let calls = 0
	vi.spyOn(Collection.prototype, "aggregate").mockImplementation(function (
		this: Collection<Document>,
		...args: Parameters<typeof original>
	) {
		const cursor = original.apply(this, args)
		if (
			this.collectionName === col.collectionName &&
			args[0]?.[0]?.$vectorSearch?.filter?.agentId === agentId
		) {
			vi.spyOn(cursor, "toArray").mockImplementation(async () => {
				if (++calls !== 1) return []
				await beforeReturn()
				return [{ ...duplicate, score: 0.97 }]
			})
		}
		return cursor
	})
}
function run(agentId: string) {
	return consolidateMemory({
		db,
		prefix,
		agentId,
		options: { maxEvents: 1, minCombinedScore: 0, minIntervalMs: 0 },
	})
}
async function noRetirement(agentId: string) {
	expect(await revisions.countDocuments({ agentId })).toBe(0)
	expect(
		await audits.countDocuments({ agentId, operation: "invalidate" }),
	).toBe(0)
	expect(await cache.countDocuments({ agentId })).toBe(1)
}
it("prune records the observed revision, end, reason, audit and cache atomically", async () => {
	const e = await seed()
	vector(e.agentId, e.old)
	const result = await run(e.agentId),
		retired = await col.findOne({ _id: e.old._id })
	expect(result.factsPruned).toBe(1)
	expect(retired).toMatchObject({
		state: "invalidated",
		revision: 2,
		invalidatedBy: { reason: "near-duplicate-prune" },
	})
	expect(retired?.validTo).toBeInstanceOf(Date)
	expect(retired?.invalidatedBy.runId).toBe(result.runId)
	expect(await col.findOne({ _id: e.newer._id })).toEqual(e.newer)
	const history = await revisions.find({ agentId: e.agentId }).toArray()
	expect(history).toHaveLength(1)
	expect(history[0]).toMatchObject({
		revision: 1,
		state: "active",
		value: e.old.value,
		validTo: retired?.validTo,
	})
	const audit = await audits
		.find({ agentId: e.agentId, operation: "invalidate" })
		.toArray()
	expect(audit).toHaveLength(1)
	expect(audit[0]).toMatchObject({
		oldValue: { revision: 1 },
		newValue: { revision: 2 },
		actorRole: "system",
	})
	expect(await cache.countDocuments({ agentId: e.agentId })).toBe(0)
})
it("a revision advanced after ANN selection is retained without re-reading loser intent", async () => {
	const e = await seed()
	vector(e.agentId, e.old, async () => {
		await col.updateOne(
			{ _id: e.old._id },
			{
				$set: {
					revision: 2,
					value: "Newer authoritative content",
					updatedAt: new Date(),
				},
			},
		)
	})
	expect((await run(e.agentId)).factsPruned).toBe(0)
	expect(await col.findOne({ _id: e.old._id })).toMatchObject({
		state: "active",
		revision: 2,
		value: "Newer authoritative content",
	})
	await noRetirement(e.agentId)
})
it("a deleted loser reinserted at the same logical key and revision is retained", async () => {
	const e = await seed(),
		replacement = {
			...e.old,
			_id: new ObjectId(),
			value: "Replacement content",
		}
	vector(e.agentId, e.old, async () => {
		await col.deleteOne({ _id: e.old._id })
		await col.insertOne(replacement)
	})
	expect((await run(e.agentId)).factsPruned).toBe(0)
	expect(await col.findOne({ _id: replacement._id })).toEqual(replacement)
	await noRetirement(e.agentId)
})
it("without a logical unique index only the observed physical lookalike is retired", async () => {
	const e = await seed(),
		lookalike = { ...e.old, _id: new ObjectId() }
	expect(
		(await col.listIndexes().toArray()).filter((index) => index.unique),
	).toHaveLength(0)
	await col.insertOne(lookalike)
	vector(e.agentId, lookalike)
	expect((await run(e.agentId)).factsPruned).toBe(1)
	expect(await col.findOne({ _id: lookalike._id })).toMatchObject({
		state: "invalidated",
		revision: 2,
	})
	expect(await col.findOne({ _id: e.old._id })).toEqual(e.old)
	expect(await revisions.countDocuments({ agentId: e.agentId })).toBe(1)
})
it.each([
	"missing",
	"fractional",
] as const)("%s revision is kept", async (kind) => {
	const e = await seed()
	if (kind === "missing") {
		await col.updateOne({ _id: e.old._id }, { $unset: { revision: "" } })
		delete e.old.revision
	} else {
		await col.updateOne({ _id: e.old._id }, { $set: { revision: 1.5 } })
		e.old.revision = 1.5
	}
	vector(e.agentId, e.old)
	expect((await run(e.agentId)).factsPruned).toBe(0)
	expect(await col.findOne({ _id: e.old._id })).toEqual(e.old)
	await noRetirement(e.agentId)
})
it("a foreign-owner ANN lookalike is retained", async () => {
	const e = await seed(),
		foreign = { ...e.old, _id: new ObjectId(), agentId: randomUUID() }
	await col.insertOne(foreign)
	vector(e.agentId, foreign)
	expect((await run(e.agentId)).factsPruned).toBe(0)
	expect(await col.findOne({ _id: foreign._id })).toEqual(foreign)
	await noRetirement(e.agentId)
})
it("blank scope references are retained", async () => {
	const e = await seed()
	await col.updateMany({ agentId: e.agentId }, { $set: { scopeRef: "" } })
	e.old.scopeRef = ""
	vector(e.agentId, e.old)
	expect((await run(e.agentId)).factsPruned).toBe(0)
	expect(await col.findOne({ _id: e.old._id })).toEqual(e.old)
	await noRetirement(e.agentId)
})
it("a concurrently invalidated revision is uncounted", async () => {
	const e = await seed()
	vector(e.agentId, e.old, async () => {
		await col.updateOne({ _id: e.old._id }, { $set: { state: "invalidated" } })
	})
	expect((await run(e.agentId)).factsPruned).toBe(0)
	expect(await col.findOne({ _id: e.old._id })).toMatchObject({
		state: "invalidated",
		revision: 1,
	})
	await noRetirement(e.agentId)
})
it.each([
	"cache",
	"audit",
] as const)("a fault after actual %s write rolls retirement and all effects back", async (kind) => {
	const e = await seed()
	vector(e.agentId, e.old)
	let hit = false
	if (kind === "cache") {
		const original = Collection.prototype.deleteMany
		vi.spyOn(Collection.prototype, "deleteMany").mockImplementation(
			async function (this: Collection, filter, options) {
				const result = await Reflect.apply(original, this, [filter, options])
				if (
					!hit &&
					this.collectionName === cache.collectionName &&
					filter?.agentId === e.agentId &&
					options?.session
				) {
					hit = true
					throw new Error("owned cache fault")
				}
				return result
			},
		)
	} else {
		const original = Collection.prototype.insertOne
		vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
			async function (this: Collection, doc, options) {
				const result = await Reflect.apply(original, this, [doc, options])
				if (
					!hit &&
					this.collectionName === audits.collectionName &&
					doc.agentId === e.agentId &&
					options?.session
				) {
					hit = true
					throw new Error("owned audit fault")
				}
				return result
			},
		)
	}
	expect((await run(e.agentId)).factsPruned).toBe(0)
	expect(hit).toBe(true)
	expect(await col.findOne({ _id: e.old._id })).toEqual(e.old)
	await noRetirement(e.agentId)
})

it.each([
	"newer inferred",
	"older inferred",
	"both inferred",
] as const)("%s: prune respects mixed-origin authority", async (kind) => {
	const e = await seed()
	const targets =
		kind === "both inferred"
			? [e.old, e.newer]
			: [kind === "newer inferred" ? e.newer : e.old]
	for (const target of targets) {
		target.provenance = { origin: "llm-inference" }
		await col.updateOne(
			{ _id: target._id },
			{ $set: { provenance: target.provenance } },
		)
	}
	vector(e.agentId, e.old)
	const result = await run(e.agentId)
	if (kind === "both inferred") {
		expect(result.factsPruned).toBe(1)
		expect(await col.findOne({ _id: e.old._id })).toMatchObject({
			state: "invalidated",
			revision: 2,
		})
		expect(await col.findOne({ _id: e.newer._id })).toEqual(e.newer)
	} else {
		expect(result.factsPruned).toBe(0)
		expect(await col.findOne({ _id: e.old._id })).toEqual(e.old)
		expect(await col.findOne({ _id: e.newer._id })).toEqual(e.newer)
		await noRetirement(e.agentId)
	}
})
