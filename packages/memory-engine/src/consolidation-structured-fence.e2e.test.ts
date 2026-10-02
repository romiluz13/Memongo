import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { BSON, Collection, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { consolidateMemory, matchPatterns } from "./mongodb-consolidator.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { ensureCollections } from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
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
}))
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E40 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e40_structured_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const content = "I prefer jasmine tea after dinner"
const options = { minCombinedScore: 0, minIntervalMs: 0, maxEvents: 1 }
const evidence = (file: string, data: unknown) =>
	writeFileSync(
		`${process.env.E22_FETCH_EVIDENCE_DIR}/${file}.json`,
		JSON.stringify(data),
	)
beforeAll(async () => {
	evidence("structured-fixture-worker", { fixturePid: process.pid })
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
		expect(
			(
				await client
					.db("admin")
					.admin()
					.listDatabases({ nameOnly: true, filter: { name } })
			).databases,
		).toEqual([])
	} finally {
		await client.close()
	}
})
async function seed(agentId: string) {
	const eventId = randomUUID()
	await db.collection(`${prefix}events`).insertOne({
		eventId,
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		body: content,
		role: "user",
		timestamp: new Date(),
		importance: 1,
		createdAt: new Date(),
	})
	return eventId
}
async function rows(agentId: string) {
	const result: Record<string, Document[]> = {}
	for (const collection of [
		"structured_mem",
		"structured_mem_revisions",
		"memory_mutations",
	])
		result[collection] = await db
			.collection(`${prefix}${collection}`)
			.find({
				agentId,
				...(collection === "memory_mutations"
					? { collectionName: "structured_mem" }
					: {}),
			})
			.toArray()
	result.indexing = await db
		.collection(`${prefix}memory_cost_ledger`)
		.find({ agentId, kind: "indexing" })
		.toArray()
	return result
}
function entry(agentId: string) {
	return {
		agentId,
		type: "preference" as const,
		key: "tea",
		value: content,
		scope: "agent" as const,
		scopeRef: `agent:${agentId}`,
	}
}
describe("ordinary consolidated structured writes on the owned database", () => {
	it("rejects a stale ADD after source read and completed erasure", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		await seed(agentId)
		let reached = () => {}
		let release = () => {}
		const paused = new Promise<void>((resolve) => {
			reached = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		const original = Collection.prototype.find
		let intercepted = false
		const spy = vi
			.spyOn(Collection.prototype, "find")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				const cursor = original.apply(this, args)
				if (
					!intercepted &&
					this.collectionName === `${prefix}events` &&
					args[0]?.agentId === agentId &&
					args[0]?.dreamerProcessedAt
				) {
					intercepted = true
					const toArray = cursor.toArray.bind(cursor)
					vi.spyOn(cursor, "toArray").mockImplementation(async () => {
						const data = await toArray()
						expect(data).toHaveLength(1)
						reached()
						await resume
						return data
					})
				}
				return cursor
			})
		const run = consolidateMemory({ db, prefix, agentId, options }).then(
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
						() => reject(new Error("source barrier not reached")),
						10000,
					)
					timer.unref()
				}),
			])
			expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
				"complete",
			)
			const afterErase = await readErasureGate({ db, prefix, agentId })
			release()
			const result = await run
			const actual = await rows(agentId)
			const gate = await readErasureGate({ db, prefix, agentId })
			evidence("structured-stale-readback", {
				result:
					result.kind === "rejected"
						? { kind: result.kind, code: result.error.code }
						: result,
				actual,
				gate,
				afterErase,
			})
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected")
				expect(result.error.code).toBe("ERASURE_GATE_CONFLICT")
			for (const data of Object.values(actual)) expect(data).toEqual([])
			expect(gate).toEqual(afterErase)
		} finally {
			release()
			await run
			spy.mockRestore()
		}
	})
	it("commits fresh ADD and revision history with inline audit, cache and indexing", async () => {
		const agentId = `agent-${randomUUID()}`
		const now = new Date()
		await db.collection(`${prefix}query_cache`).insertOne({
			queryHash: randomUUID(),
			queryNorm: "tea",
			agentId,
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			results: [],
			pathUsed: "bm25",
			sourceScope: "agent",
			createdAt: now,
			expiresAt: new Date(Date.now() + 60000),
			hitCount: 0,
			lastHitAt: now,
		})
		await seed(agentId)
		expect(
			(await consolidateMemory({ db, prefix, agentId, options })).factsPromoted,
		).toBe(1)
		const first = await rows(agentId)
		expect(first.structured_mem).toHaveLength(1)
		expect(first.structured_mem_revisions).toEqual([])
		expect(first.memory_mutations).toHaveLength(1)
		expect(first.indexing).toHaveLength(1)
		expect(first.indexing[0]).toMatchObject({ embedUnits: 1 })
		expect(
			await db.collection(`${prefix}query_cache`).countDocuments({ agentId }),
		).toBe(0)
		expect(await readErasureGate({ db, prefix, agentId })).toMatchObject({
			epoch: 0,
			state: "open",
			serial: 5,
		})
		await seed(agentId)
		expect(
			(await consolidateMemory({ db, prefix, agentId, options })).factsPromoted,
		).toBe(1)
		const actual = await rows(agentId)
		const gate = await readErasureGate({ db, prefix, agentId })
		evidence("structured-fresh-readback", { actual, gate })
		expect(actual.structured_mem).toHaveLength(1)
		expect(actual.structured_mem[0]).toMatchObject({
			revision: 2,
			key: matchPatterns(content)?.key,
			value: content,
		})
		expect(actual.structured_mem_revisions).toHaveLength(1)
		expect(actual.structured_mem_revisions[0]).toMatchObject({
			revision: 1,
			value: content,
		})
		expect(actual.memory_mutations).toHaveLength(2)
		expect(actual.indexing[0]).toMatchObject({ embedUnits: 2 })
		expect(gate).toMatchObject({ epoch: 0, state: "open", serial: 10 })
	})
	it("propagates an inline cache failure and rolls back the fenced fact", async () => {
		const agentId = `agent-${randomUUID()}`
		const token = await captureAdmissionToken({ db, prefix, agentId })
		const before = await readErasureGate({ db, prefix, agentId })
		const original = Collection.prototype.deleteMany
		const failure = new Error("owned cache failure")
		const spy = vi
			.spyOn(Collection.prototype, "deleteMany")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				if (
					this.collectionName === `${prefix}query_cache` &&
					args[0]?.agentId === agentId &&
					args[1]?.session
				)
					return Promise.reject(failure)
				return original.apply(this, args)
			})
		try {
			const result = await withFencedWrite({
				db,
				prefix,
				token,
				fn: (session) =>
					writeStructuredMemory({
						db,
						prefix,
						entry: entry(agentId),
						embeddingMode: "automated",
						session,
						transactionalSideEffects: "inline",
					}),
			}).then(
				() => ({ kind: "resolved" }),
				(error) => ({ kind: "rejected", error }),
			)
			const actual = await rows(agentId)
			const gate = await readErasureGate({ db, prefix, agentId })
			evidence("structured-cache-readback", { result, actual, gate, before })
			expect(result).toEqual({ kind: "rejected", error: failure })
			for (const data of Object.values(actual)) expect(data).toEqual([])
			expect(gate).toEqual(before)
		} finally {
			spy.mockRestore()
		}
	})
	it("surfaces an orphan revision duplicate before continuing an aborted transaction", async () => {
		const agentId = `agent-${randomUUID()}`
		const fact = entry(agentId)
		const now = new Date()
		const { insertedId } = await db
			.collection(`${prefix}structured_mem`)
			.insertOne({
				...fact,
				value: "old tea",
				revision: 1,
				state: "active",
				updatedAt: now,
				createdAt: now,
			})
		const generation = createHash("sha256")
			.update(BSON.serialize({ _id: insertedId }))
			.digest("hex")
		const id = `${[agentId, "agent", fact.scopeRef, fact.type, fact.key].map(encodeURIComponent).join(":")}:g${generation}:r1`
		await db
			.collection<Document & { _id: string }>(
				`${prefix}structured_mem_revisions`,
			)
			.insertOne({
				...fact,
				_id: id,
				value: "old tea",
				revision: 1,
				validFrom: now,
				validTo: now,
				supersededAt: now,
				updatedAt: now,
			})
		const session = client.startSession()
		try {
			session.startTransaction({ writeConcern: { w: "majority" } })
			const result = await writeStructuredMemory({
				db,
				prefix,
				entry: fact,
				embeddingMode: "automated",
				session,
				transactionalSideEffects: "inline",
			}).then(
				() => ({ code: 0 }),
				(error: Error & { code?: number; errorLabels?: string[] }) => ({
					code: error.code,
					labels: error.errorLabels,
				}),
			)
			await session.abortTransaction()
			const actual = await rows(agentId)
			evidence("structured-orphan-readback", { result, actual })
			expect(result.code).toBe(11000)
			expect(actual.structured_mem[0]).toMatchObject({
				revision: 1,
				value: "old tea",
			})
			expect(actual.structured_mem_revisions).toHaveLength(1)
			expect(actual.memory_mutations).toEqual([])
			expect(actual.indexing).toEqual([])
		} finally {
			await session.endSession()
		}
		await writeStructuredMemory({
			db,
			prefix,
			entry: fact,
			embeddingMode: "automated",
		})
		expect(
			await db.collection(`${prefix}structured_mem`).findOne({ agentId }),
		).toMatchObject({ revision: 2, value: content })
		expect(
			await db
				.collection(`${prefix}structured_mem_revisions`)
				.countDocuments({ agentId }),
		).toBe(1)
	})
	it("fails a consolidated candidate on cache error and acknowledges only its successful retry", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const original = Collection.prototype.deleteMany
		const failure = new Error("owned consolidated cache failure")
		const spy = vi
			.spyOn(Collection.prototype, "deleteMany")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				if (
					this.collectionName === `${prefix}query_cache` &&
					args[0]?.agentId === agentId &&
					args[1]?.session
				)
					return Promise.reject(failure)
				return original.apply(this, args)
			})
		try {
			await expect(
				consolidateMemory({ db, prefix, agentId, options }),
			).rejects.toBe(failure)
			const actual = await rows(agentId)
			for (const data of Object.values(actual)) expect(data).toEqual([])
			expect(await readErasureGate({ db, prefix, agentId })).toMatchObject({
				serial: 3,
			})
			expect(
				await db.collection(`${prefix}events`).findOne({ agentId, eventId }),
			).not.toHaveProperty("dreamerProcessedAt")
			expect(
				await db.collection(`${prefix}consolidation_runs`).findOne({ agentId }),
			).toMatchObject({ status: "failed" })
			evidence("structured-candidate-cache-readback", {
				actual,
				gate: await readErasureGate({ db, prefix, agentId }),
			})
		} finally {
			spy.mockRestore()
		}
		expect(
			(await consolidateMemory({ db, prefix, agentId, options })).factsPromoted,
		).toBe(1)
		expect(
			await db.collection(`${prefix}events`).findOne({ agentId, eventId }),
		).toHaveProperty("dreamerProcessedAt")
		expect(await readErasureGate({ db, prefix, agentId })).toMatchObject({
			serial: 8,
		})
	})
})
