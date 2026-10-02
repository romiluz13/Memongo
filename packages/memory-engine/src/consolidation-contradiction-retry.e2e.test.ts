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
	withFencedWrite,
} from "./mongodb-write-fence.js"
const transport = vi.hoisted(() => ({
	calls: [] as string[],
	unexpected: [] as string[],
	wait: async () => {},
	contradictions: 0,
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
		name: "owned-local-contradiction-fixture",
		async chatCompletion(request) {
			const prompt = request.messages[0]?.content ?? ""
			const kind = prompt.includes("strict entailment")
				? "deduction"
				: prompt.includes("probable GENERALIZATIONS")
					? "induction"
					: prompt.includes("You detect direct contradictions")
						? "contradiction"
						: "unexpected"
			transport.calls.push(kind)
			if (kind === "unexpected") {
				transport.unexpected.push(prompt)
				throw new Error("unexpected local request")
			}
			if (kind === "contradiction") {
				transport.contradictions++
				if (transport.contradictions === 2) await transport.wait()
				return {
					content:
						'{"contradictions":[{"key":"city","rationale":"relocation supersedes residence"}]}',
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
	throw new Error("E55 requires explicit owned server")
const client = new MongoClient(uri),
	name = `memongo_e55_conflict_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	prefix = "test_",
	body = "The commuter is moving to Paris"
const options = {
	minCombinedScore: 0,
	minIntervalMs: 0,
	maxEvents: 1,
	llmDedup: false,
	resolveContradictions: true,
}
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/contradiction-retry-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	expect(matchPatterns(body)).toEqual({
		type: "fact",
		key: "moving to Paris",
		value: body,
	})
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
	transport.contradictions = 0
	transport.wait = async () => {}
	await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date()
	await db.collection(`${prefix}structured_mem`).insertMany(
		[
			{
				key: "moving to Paris",
				value: "The commuter is moving to Rome",
				state: "conflicted",
			},
			{ key: "city", value: "Lives in London", state: "active" },
		].map((d) => ({
			...d,
			type: "fact",
			agentId,
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			revision: 1,
			createdAt: now,
			updatedAt: now,
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
	for (const name of [
		"structured_mem",
		"structured_mem_revisions",
		"memory_mutations",
		"query_cache",
	])
		result[name] = await db
			.collection(`${prefix}${name}`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray()
	return result
}
function barrier() {
	let reached = () => {},
		release = () => {}
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
		reached: () =>
			Promise.race([
				paused,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("contradiction barrier not reached")),
						10000,
					)
					timer.unref()
				}),
			]),
	}
}
describe("consolidated contradiction retirement original admission", () => {
	it("rejects stale contradiction persistence after completed erase and same-value fresh fact", async () => {
		const agentId = `agent-${randomUUID()}`
		await seed(agentId)
		const pause = barrier()
		transport.wait = pause.wait
		const run = consolidateMemory({ db, prefix, agentId, options }).then(
			(result) => ({ kind: "resolved" as const, result }),
			(error) => ({
				kind: "rejected" as const,
				error: error as Error & { code?: string },
			}),
		)
		try {
			await pause.reached()
			expect(transport.contradictions).toBe(2)
			expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
				"complete",
			)
			const token = await captureAdmissionToken({ db, prefix, agentId })
			await withFencedWrite({
				db,
				prefix,
				token,
				fn: async (session) => {
					const now = new Date()
					await db.collection(`${prefix}structured_mem`).insertOne(
						{
							key: "city",
							value: "Lives in London",
							state: "active",
							revision: 1,
							type: "fact",
							agentId,
							scope: "agent",
							scopeRef: `agent:${agentId}`,
							createdAt: now,
							updatedAt: now,
							provenance: { origin: "observed" },
						},
						{ session },
					)
				},
			})
			const fresh = await rows(agentId),
				freshGate = await readErasureGate({ db, prefix, agentId })
			pause.release()
			const result = await run,
				actual = await rows(agentId),
				gate = await readErasureGate({ db, prefix, agentId })
			evidence("stale", {
				result:
					result.kind === "rejected"
						? { kind: result.kind, code: result.error.code }
						: result,
				fresh,
				actual,
				freshGate,
				gate,
				calls: transport.calls,
				unexpected: transport.unexpected,
			})
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected")
				expect(result.error.code).toBe("ERASURE_GATE_CONFLICT")
			expect(actual).toEqual(fresh)
			expect(gate).toEqual(freshGate)
			expect(transport.unexpected).toEqual([])
		} finally {
			pause.release()
			await run
		}
	})
	it("commits fresh contradiction revision/audit then ordinary promotion", async () => {
		const agentId = `agent-${randomUUID()}`,
			eventId = await seed(agentId)
		const result = await consolidateMemory({ db, prefix, agentId, options }),
			actual = await rows(agentId),
			gate = await readErasureGate({ db, prefix, agentId })
		evidence("fresh", {
			result,
			actual,
			gate,
			calls: transport.calls,
			unexpected: transport.unexpected,
		})
		expect(result.conflictsResolved).toBe(1)
		expect(result.factsPromoted).toBe(1)
		expect(actual.structured_mem).toHaveLength(2)
		expect(actual.structured_mem.find((d) => d.key === "city")).toMatchObject({
			state: "invalidated",
			revision: 2,
			invalidatedBy: {
				reason: "contradiction",
				byKey: "moving to Paris",
				byValue: body,
				runId: result.runId,
			},
		})
		expect(
			actual.structured_mem.find((d) => d.key === "moving to Paris"),
		).toMatchObject({
			state: "active",
			value: body,
			revision: 2,
			sourceEventIds: [eventId],
		})
		expect(actual.structured_mem_revisions).toHaveLength(2)
		expect(
			actual.memory_mutations.filter(
				(d) => d.collectionName === "structured_mem",
			),
		).toHaveLength(2)
		expect(gate?.serial).toBe(5)
		expect(transport.contradictions).toBe(2)
		expect(transport.unexpected).toEqual([])
		expect(
			(await db.collection(`${prefix}events`).findOne({ eventId }))
				?.dreamerProcessedAt,
		).toBeInstanceOf(Date)
	})
	it("keeps failed contradiction persistence retryable and preserves the original error", async () => {
		const agentId = `agent-${randomUUID()}`,
			eventId = await seed(agentId),
			before = await rows(agentId),
			error = new Error("owned retryable contradiction audit failure"),
			original = Collection.prototype.insertOne
		const spy = vi
			.spyOn(Collection.prototype, "insertOne")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				if (
					this.collectionName === `${prefix}memory_mutations` &&
					args[0]?.agentId === agentId &&
					args[0]?.operation === "invalidate"
				)
					return Promise.reject(error)
				return original.apply(this, args)
			})
		let outcome: unknown
		try {
			outcome = await consolidateMemory({ db, prefix, agentId, options }).then(
				(result) => ({ kind: "resolved", result }),
				(caught) => ({
					kind: "rejected",
					original: caught === error,
					message: caught.message,
				}),
			)
		} finally {
			spy.mockRestore()
		}
		const actual = await rows(agentId),
			event = await db.collection(`${prefix}events`).findOne({ eventId }),
			run = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId, gateKey: { $type: "string" } }),
			gate = await readErasureGate({ db, prefix, agentId })
		evidence("retry", {
			outcome,
			before,
			actual,
			event,
			run,
			gate,
			calls: transport.calls,
			unexpected: transport.unexpected,
		})
		expect(outcome).toEqual({
			kind: "rejected",
			original: true,
			message: error.message,
		})
		expect(actual).toEqual(before)
		expect(event?.dreamerProcessedAt).toBeUndefined()
		expect(run).toMatchObject({
			status: "failed",
			eventsProcessed: 0,
			factsPromoted: 0,
			error: error.message,
		})
		expect(gate?.serial).toBe(3)
		expect(transport.unexpected).toEqual([])
		const retry = await consolidateMemory({ db, prefix, agentId, options }),
			retriedEvent = await db
				.collection(`${prefix}events`)
				.findOne({ eventId }),
			retriedRows = await rows(agentId)
		evidence("retry-success", { retry, retriedEvent, retriedRows })
		expect(retry.eventsProcessed).toBe(1)
		expect(retry.factsPromoted).toBe(1)
		expect(retriedEvent?.dreamerProcessedAt).toBeInstanceOf(Date)
		expect(
			retriedRows.structured_mem.find((d) => d.key === "city"),
		).toMatchObject({ state: "invalidated", revision: 2 })
	})
})
