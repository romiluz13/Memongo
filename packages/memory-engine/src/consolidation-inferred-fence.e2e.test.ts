import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { consolidateMemory, matchPatterns } from "./mongodb-consolidator.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"

const model = vi.hoisted(() => ({
	calls: [] as string[],
	unexpected: [] as string[],
	wait: async () => {},
}))
const values = [
	"Alice lives in London.",
	"Alice cycles to an office in central London.",
]
const inferred = "Cycling between home and office occurs within London."
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
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: (): EnrichmentProvider => ({
		name: "owned-local-reasoning-fixture",
		async chatCompletion(request) {
			const prompt = request.messages[0]?.content ?? ""
			const kind = prompt.includes("strict entailment")
				? "deduction"
				: prompt.includes("probable GENERALIZATIONS")
					? "induction"
					: "unexpected"
			if (kind === "unexpected") {
				model.unexpected.push(prompt)
				throw new Error("unexpected local model request")
			}
			model.calls.push(kind)
			await model.wait()
			return {
				content: JSON.stringify({
					facts: [
						{
							value: "Cycling between home and office occurs within London.",
							rationale: "Two local journeys connect London locations.",
							from: [
								"Alice lives in London.",
								"Alice cycles to an office in central London.",
							],
						},
					],
				}),
			}
		},
	}),
}))
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E46 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e46_inferred_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const body = "meeting notes"
const options = {
	minCombinedScore: 0,
	minIntervalMs: 0,
	maxEvents: 1,
	llmDedup: false,
}
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/inferred-${label}.json`,
			JSON.stringify(value, null, 2),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	expect(matchPatterns(body)).toBeNull()
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "true")
	vi.stubEnv("MEMONGO_TELEMETRY_SAMPLE_RATE", "1")
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
	vi.unstubAllEnvs()
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
	model.calls.length = 0
	model.unexpected.length = 0
	model.wait = async () => {}
	await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date()
	await db.collection(`${prefix}structured_mem`).insertMany(
		values.map((value, i) => ({
			agentId,
			type: "fact",
			key: `observed-${i}`,
			value,
			updatedAt: now,
			state: "active",
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			provenance: { origin: "observed" },
		})),
	)
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
	return eventId
}
async function rows(agentId: string) {
	const result: Record<string, Document[]> = {}
	for (const suffix of [
		"structured_mem",
		"structured_mem_revisions",
		"memory_mutations",
		"memory_cost_ledger",
		"projection_runs",
		"events",
		"consolidation_runs",
		"query_cache",
		"entities",
		"relations",
		"entity_links",
		"memory_quarantine",
	])
		result[suffix] = await db
			.collection(`${prefix}${suffix}`)
			.find({ agentId })
			.toArray()
	result.memory_telemetry = await db
		.collection(`${prefix}memory_telemetry`)
		.find({ "meta.agentId": agentId })
		.toArray()
	return result
}
function expectCalls() {
	expect(model.calls.toSorted()).toEqual(["deduction", "induction"])
	expect(model.unexpected).toEqual([])
}
describe("inferred consolidation writes on the owned real database", () => {
	it("rejects an inference prepared before completed erasure", async () => {
		const agentId = `agent-${randomUUID()}`
		await seed(agentId)
		let release = () => {}
		let reached = () => {}
		const paused = new Promise<void>((resolve) => {
			reached = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		model.wait = async () => {
			if (model.calls.length === 2) reached()
			await resume
		}
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
						() =>
							reject(
								new Error("both reasoning calls did not reach the barrier"),
							),
						10000,
					)
					timer.unref()
				}),
			])
			expectCalls()
			const receipt = await deleteAllForAgent({ db, prefix, agentId })
			expect(receipt.status).toBe("complete")
			expect(receipt.gateState).toBe("open")
			const afterErase = await readErasureGate({ db, prefix, agentId })
			expect(afterErase).toMatchObject({ epoch: 1, state: "open" })
			const afterEraseRows = await rows(agentId)
			release()
			const result = await run
			const actual = await rows(agentId)
			const gate = await readErasureGate({ db, prefix, agentId })
			evidence("stale", {
				result:
					result.kind === "rejected"
						? {
								kind: result.kind,
								code: result.error.code,
								message: result.error.message,
							}
						: result,
				actual,
				gate,
				afterErase,
				afterEraseRows,
				calls: model.calls,
				unexpected: model.unexpected,
			})
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected")
				expect(result.error.code).toBe("ERASURE_GATE_CONFLICT")
			expect(actual).toEqual(afterEraseRows)
			expect(gate).toEqual(afterErase)
		} finally {
			release()
			await run
			model.wait = async () => {}
		}
	})
	it("commits one fresh inference with its audit, index spend and cache invalidation", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const now = new Date()
		await db.collection(`${prefix}query_cache`).insertOne({
			queryHash: randomUUID(),
			queryNorm: "london",
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
		const result = await consolidateMemory({ db, prefix, agentId, options })
		const actual = await rows(agentId)
		const gate = await readErasureGate({ db, prefix, agentId })
		evidence("fresh", {
			result,
			actual,
			gate,
			calls: model.calls,
			unexpected: model.unexpected,
		})
		expectCalls()
		expect(result).toMatchObject({
			factsInferred: 1,
			factsPromoted: 0,
			eventsProcessed: 1,
		})
		expect(actual.structured_mem).toHaveLength(3)
		const fact = actual.structured_mem.find(
			(doc) => doc.provenance?.origin === "llm-inference",
		)
		expect(fact).toMatchObject({
			value: inferred,
			agentId,
			source: "agent",
			confidence: 0.5,
			reinforcementCount: 0,
			state: "active",
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			tags: ["inferred", "deduction"],
			provenance: {
				kind: "deduction",
				derivedFrom: values,
				runId: result.runId,
			},
			sourceAgent: { id: agentId, name: "dreamer", runId: result.runId },
		})
		expect(actual.memory_mutations).toHaveLength(1)
		expect(actual.memory_mutations[0]).toMatchObject({
			operation: "create",
			collectionName: "structured_mem",
			agentId,
		})
		expect(actual.memory_cost_ledger).toHaveLength(1)
		expect(actual.memory_cost_ledger[0]).toMatchObject({
			kind: "indexing",
			embedUnits: 1,
		})
		expect(actual.query_cache).toEqual([])
		expect(actual.structured_mem_revisions).toEqual([])
		expect(
			actual.events.find((event) => event.eventId === eventId)
				?.dreamerProcessedAt,
		).toBeInstanceOf(Date)
		expect(gate).toMatchObject({ epoch: 0, state: "open", serial: 5 })
	})
	it("rolls back a failed inline side effect and preserves ordinary-error best effort", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const original = Collection.prototype.deleteMany
		let failures = 0
		const spy = vi
			.spyOn(Collection.prototype, "deleteMany")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				if (
					this.collectionName === `${prefix}query_cache` &&
					args[0]?.agentId === agentId
				) {
					failures++
					return Promise.reject(new Error("owned inferred cache failure"))
				}
				return original.apply(this, args)
			})
		try {
			const result = await consolidateMemory({ db, prefix, agentId, options })
			const actual = await rows(agentId)
			const gate = await readErasureGate({ db, prefix, agentId })
			evidence("rollback", {
				result,
				actual,
				gate,
				failures,
				calls: model.calls,
				unexpected: model.unexpected,
			})
			expectCalls()
			expect(failures).toBe(1)
			expect(result).toMatchObject({
				factsInferred: 0,
				factsPromoted: 0,
				eventsProcessed: 1,
			})
			expect(actual.structured_mem).toHaveLength(2)
			expect(
				actual.structured_mem.every(
					(doc) => doc.provenance?.origin === "observed",
				),
			).toBe(true)
			expect(actual.memory_mutations).toEqual([])
			expect(actual.memory_cost_ledger).toEqual([])
			expect(actual.structured_mem_revisions).toEqual([])
			expect(
				actual.events.find((event) => event.eventId === eventId)
					?.dreamerProcessedAt,
			).toBeInstanceOf(Date)
			expect(gate).toMatchObject({ epoch: 0, state: "open", serial: 4 })
		} finally {
			spy.mockRestore()
		}
	})
})
