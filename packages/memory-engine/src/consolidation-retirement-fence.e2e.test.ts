import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient, ObjectId } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { consolidateMemory, matchPatterns } from "./mongodb-consolidator.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
	withFencedWrite,
} from "./mongodb-write-fence.js"
const transport = vi.hoisted(() => ({
	calls: [] as string[],
	unexpected: [] as string[],
	wait: async () => {},
}))
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
vi.mock("./mongodb-cost-ledger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-cost-ledger.js")>()),
	recordEmbeddingSpend: vi.fn(),
}))
vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: (): EnrichmentProvider => ({
		name: "owned-local-retirement-fixture",
		async chatCompletion(request) {
			const prompt = request.messages[0]?.content ?? ""
			const kind = prompt.includes("strict entailment")
				? "deduction"
				: prompt.includes("probable GENERALIZATIONS")
					? "induction"
					: prompt.includes("You decide whether two facts")
						? "merge"
						: "unexpected"
			transport.calls.push(kind)
			if (kind === "unexpected") {
				transport.unexpected.push(prompt)
				throw new Error("unexpected local request")
			}
			if (kind === "merge") {
				await transport.wait()
				return {
					content: JSON.stringify({
						verdict: "MERGE",
						merged: "Combined London cycling observation.",
					}),
				}
			}
			return { content: '{"facts":[]}' }
		},
	}),
}))
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E48 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e48_retire_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_",
	body = "meeting notes"
const options = { minCombinedScore: 0, minIntervalMs: 0, maxEvents: 1 }
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/retire-${label}.json`,
			JSON.stringify(value, null, 2),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	expect(matchPatterns(body)).toBeNull()
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
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		await client.close()
	}
})
async function seed(agentId: string) {
	transport.calls.length = 0
	transport.unexpected.length = 0
	transport.wait = async () => {}
	await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date(),
		oldId = new ObjectId(),
		newId = new ObjectId()
	const docs = [
		{
			_id: oldId,
			key: "older",
			value: "London cycling observation.",
			updatedAt: new Date(now.getTime() - 10000),
			sourceEventIds: ["older-source"],
		},
		{
			_id: newId,
			key: "newer",
			value: "London commute observation.",
			updatedAt: now,
			sourceEventIds: ["newer-source"],
		},
	].map((doc) => ({
		...doc,
		agentId,
		type: "fact",
		state: "active",
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		revision: 1,
		provenance: { origin: "observed" },
	}))
	await db.collection(`${prefix}structured_mem`).insertMany(docs)
	const eventId = randomUUID()
	await db.collection(`${prefix}events`).insertOne({
		eventId,
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		body,
		role: "user",
		timestamp: now,
		importance: 1,
		createdAt: now,
	})
	return { docs, oldId, newId, eventId }
}
async function facts(agentId: string) {
	return db
		.collection(`${prefix}structured_mem`)
		.find({ agentId })
		.sort({ key: 1 })
		.toArray()
}
function vector(
	agentId: string,
	duplicate: Document,
	score: number,
	wait = async () => {},
) {
	const original = Collection.prototype.aggregate
	let calls = 0
	const spy = vi
		.spyOn(Collection.prototype, "aggregate")
		.mockImplementation(function (
			this: Collection<Document>,
			...args: Parameters<typeof original>
		) {
			const cursor = original.apply(this, args)
			const pipeline = args[0]
			if (
				this.collectionName === `${prefix}structured_mem` &&
				pipeline?.[0]?.$vectorSearch?.filter?.agentId === agentId
			) {
				vi.spyOn(cursor, "toArray").mockImplementation(async () => {
					calls++
					if (calls !== 1) return []
					await wait()
					return [{ ...duplicate, score }]
				})
			}
			return cursor
		})
	return spy
}
function barrier() {
	let release = () => {},
		reached = () => {}
	const paused = new Promise<void>((resolve) => {
			reached = resolve
		}),
		resume = new Promise<void>((resolve) => {
			release = resolve
		})
	return {
		release: () => release(),
		wait: async () => {
			reached()
			await resume
		},
		reached: async () =>
			Promise.race([
				paused,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("retirement barrier not reached")),
						10000,
					)
					timer.unref()
				}),
			]),
	}
}
async function refresh(agentId: string, docs: Document[]) {
	const receipt = await deleteAllForAgent({ db, prefix, agentId })
	expect(receipt.status).toBe("complete")
	expect(receipt.gateState).toBe("open")
	const token = await captureAdmissionToken({ db, prefix, agentId })
	expect(token.epoch).toBe(1)
	await withFencedWrite({
		db,
		prefix,
		token,
		fn: (session) =>
			db.collection(`${prefix}structured_mem`).insertMany(
				docs.map((doc) => ({
					...doc,
					value: `Fresh epoch ${doc.key}.`,
					sourceEventIds: [`fresh-${doc.key}`],
					updatedAt: new Date(),
				})),
				{ session },
			),
	})
	return {
		facts: await facts(agentId),
		gate: await readErasureGate({ db, prefix, agentId }),
	}
}
describe("duplicate retirement on the owned real database", () => {
	for (const kind of ["dedup", "prune"] as const) {
		it(`rejects stale ${kind} mutations against refreshed same-id facts`, async () => {
			const agentId = `agent-${randomUUID()}`,
				seeded = await seed(agentId),
				pause = barrier()
			const spy = vector(
				agentId,
				seeded.docs[0],
				kind === "dedup" ? 0.8 : 0.97,
				kind === "prune" ? pause.wait : async () => {},
			)
			if (kind === "dedup") transport.wait = pause.wait
			const run = consolidateMemory({
				db,
				prefix,
				agentId,
				options: { ...options, llmDedup: kind === "dedup" },
			}).then(
				(result) => ({ kind: "resolved" as const, result }),
				(error: Error & { code?: string }) => ({
					kind: "rejected" as const,
					error,
				}),
			)
			try {
				await pause.reached()
				const fresh = await refresh(agentId, seeded.docs)
				pause.release()
				const result = await run
				const actual = await facts(agentId),
					gate = await readErasureGate({ db, prefix, agentId })
				evidence(`${kind}-stale`, {
					result:
						result.kind === "rejected"
							? {
									kind: result.kind,
									code: result.error.code,
									message: result.error.message,
								}
							: result,
					fresh,
					actual,
					gate,
					calls: transport.calls,
					unexpected: transport.unexpected,
				})
				expect(transport.unexpected).toEqual([])
				expect(result.kind).toBe("rejected")
				if (result.kind === "rejected")
					expect(result.error.code).toBe("ERASURE_GATE_CONFLICT")
				expect(actual).toEqual(fresh.facts)
				expect(gate).toEqual(fresh.gate)
				expect(
					await db.collection(`${prefix}events`).countDocuments({ agentId }),
				).toBe(0)
				expect(
					await db
						.collection(`${prefix}consolidation_runs`)
						.countDocuments({ agentId }),
				).toBe(0)
			} finally {
				pause.release()
				await run
				spy.mockRestore()
				transport.wait = async () => {}
			}
		})
		it(`commits fresh ${kind} with actual row and serial checks`, async () => {
			const agentId = `agent-${randomUUID()}`,
				seeded = await seed(agentId),
				spy = vector(agentId, seeded.docs[0], kind === "dedup" ? 0.8 : 0.97)
			try {
				const result = await consolidateMemory({
						db,
						prefix,
						agentId,
						options: { ...options, llmDedup: kind === "dedup" },
					}),
					actual = await facts(agentId),
					gate = await readErasureGate({ db, prefix, agentId })
				evidence(`${kind}-fresh`, {
					result,
					actual,
					gate,
					calls: transport.calls,
					unexpected: transport.unexpected,
				})
				expect(transport.unexpected).toEqual([])
				expect(actual.find((doc) => doc.key === "older")?.state).toBe(
					"invalidated",
				)
				const kept = actual.find((doc) => doc.key === "newer")
				if (kind === "dedup") {
					expect(result.factsMerged).toBe(1)
					expect(kept?.value).toBe("Combined London cycling observation.")
					expect(kept?.sourceEventIds).toEqual(["newer-source", "older-source"])
				} else {
					expect(result.factsPruned).toBe(1)
					expect(kept?.value).toBe(seeded.docs[1].value)
				}
				expect(kept?.state).toBe("active")
				expect(gate).toMatchObject({ epoch: 0, state: "open", serial: 6 })
				expect(
					(
						await db
							.collection(`${prefix}events`)
							.findOne({ eventId: seeded.eventId })
					)?.dreamerProcessedAt,
				).toBeInstanceOf(Date)
			} finally {
				spy.mockRestore()
			}
		})
	}
	it("rolls back both dedup mutations when the second fails", async () => {
		const agentId = `agent-${randomUUID()}`,
			seeded = await seed(agentId),
			before = await facts(agentId),
			spy = vector(agentId, seeded.docs[0], 0.8),
			original = Collection.prototype.updateOne
		let failures = 0
		const fail = vi
			.spyOn(Collection.prototype, "updateOne")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				if (
					this.collectionName === `${prefix}structured_mem` &&
					args[0]?._id?.equals?.(seeded.oldId) &&
					!Array.isArray(args[1]) &&
					args[1]?.$set?.state === "invalidated"
				) {
					failures++
					return Promise.reject(new Error("owned second mutation failure"))
				}
				return original.apply(this, args)
			})
		try {
			const result = await consolidateMemory({
					db,
					prefix,
					agentId,
					options: { ...options, llmDedup: true },
				}),
				actual = await facts(agentId),
				gate = await readErasureGate({ db, prefix, agentId })
			evidence("dedup-rollback", {
				result,
				before,
				actual,
				gate,
				failures,
				calls: transport.calls,
				unexpected: transport.unexpected,
			})
			expect(failures).toBe(1)
			expect(transport.unexpected).toEqual([])
			expect(result.factsMerged).toBe(0)
			expect(actual).toEqual(before)
			expect(gate).toMatchObject({ epoch: 0, state: "open", serial: 5 })
			expect(
				(
					await db
						.collection(`${prefix}events`)
						.findOne({ eventId: seeded.eventId })
				)?.dreamerProcessedAt,
			).toBeInstanceOf(Date)
		} finally {
			fail.mockRestore()
			spy.mockRestore()
		}
	})
})
