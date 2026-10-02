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

const transport = vi.hoisted(() => ({
	calls: [] as string[],
	wait: async () => {},
	usage: { inputTokens: 12, outputTokens: 3 },
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
vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: (): EnrichmentProvider => ({
		name: "owned-local-cost-fixture",
		async chatCompletion(request) {
			const prompt = request.messages[0]?.content ?? ""
			const kind = prompt.includes("strict entailment")
				? "deduction"
				: prompt.includes("probable GENERALIZATIONS")
					? "induction"
					: "unexpected"
			transport.calls.push(kind)
			if (kind === "unexpected") throw new Error("unexpected local request")
			if (transport.calls.length === 1) await transport.wait()
			return { content: '{"facts":[]}', usage: transport.usage }
		},
	}),
}))
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E57 requires explicit owned server")
const client = new MongoClient(uri)
const name = `memongo_e57_cost_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const options = { minCombinedScore: 0, minIntervalMs: 0, maxEvents: 1 }
const body = "ordinary conversation"

function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/cost-${label}.json`,
			JSON.stringify(data, null, 2),
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
		const listed = await client.db("admin").admin().listDatabases({
			nameOnly: true,
			filter: { name },
		})
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		await client.close()
	}
})
async function seed(agentId: string) {
	transport.calls.length = 0
	transport.wait = async () => {}
	await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date()
	await db.collection(`${prefix}structured_mem`).insertMany(
		["Likes trains", "Lives in Paris"].map((value, i) => ({
			key: `fact-${i}`,
			value,
			state: "active",
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
	for (const collection of ["structured_mem", "memory_cost_ledger", "events"])
		result[collection] = await db
			.collection(`${prefix}${collection}`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray()
	return result
}
function stubVector() {
	let probes = 0
	const original = Collection.prototype.aggregate
	const spy = vi
		.spyOn(Collection.prototype, "aggregate")
		.mockImplementation(function (
			this: Collection<Document>,
			pipeline,
			options,
		) {
			if (
				this.namespace === `${name}.${prefix}structured_mem` &&
				pipeline?.[0]?.$vectorSearch
			) {
				probes++
				return { toArray: async () => [] } as unknown as ReturnType<
					typeof original
				>
			}
			return original.call(this, pipeline, options)
		})
	return { spy, count: () => probes }
}
describe("consolidation cost original admission", () => {
	it("does not recreate accounting after an erased epoch", async () => {
		const agentId = `agent-${randomUUID()}`
		await seed(agentId)
		let release!: () => void
		let signal!: () => void
		const paused = new Promise<void>((resolve) => {
			signal = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		transport.wait = async () => {
			signal()
			await resume
		}
		const vector = stubVector()
		const pending = consolidateMemory({ db, prefix, agentId, options }).then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		)
		try {
			await paused
			const erased = await deleteAllForAgent({ db, prefix, agentId })
			expect(erased.status).toBe("complete")
			const before = await rows(agentId)
			const gate = await readErasureGate({ db, prefix, agentId })
			release()
			const outcome = await pending
			const after = await rows(agentId)
			const afterGate = await readErasureGate({ db, prefix, agentId })
			evidence("stale", {
				before,
				after,
				gate,
				afterGate,
				error:
					outcome.error instanceof Error
						? { name: outcome.error.name, message: outcome.error.message }
						: outcome.error,
				calls: transport.calls,
				probes: vector.count(),
			})
			expect(outcome.error).toMatchObject({ name: "ErasureGateConflictError" })
			expect(after).toEqual(before)
			expect(afterGate).toEqual(gate)
		} finally {
			release()
			await pending
			vector.spy.mockRestore()
		}
	})
	it("counts each observed usage and probe once before acknowledging", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const vector = stubVector()
		try {
			const result = await consolidateMemory({ db, prefix, agentId, options })
			const ledger = await db
				.collection(`${prefix}memory_cost_ledger`)
				.find({ agentId })
				.toArray()
			const event = await db.collection(`${prefix}events`).findOne({ eventId })
			evidence("fresh", {
				result,
				ledger,
				event,
				calls: transport.calls,
				probes: vector.count(),
			})
			expect(transport.calls).toEqual(["deduction", "induction"])
			expect(vector.count()).toBe(2)
			expect(ledger.find((row) => row.kind === "llm")).toMatchObject({
				inputTokens: 24,
				outputTokens: 6,
			})
			expect(ledger.find((row) => row.kind === "consolidation")).toMatchObject({
				embedUnits: 2,
			})
			expect(event?.dreamerRunId).toBe(result.runId)
		} finally {
			vector.spy.mockRestore()
		}
	})
	it("aborts the ledger batch and leaves events unacknowledged on a write failure", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		const vector = stubVector()
		const failure = new Error("owned cost write failure")
		const original = Collection.prototype.updateOne
		let writes = 0
		const spy = vi
			.spyOn(Collection.prototype, "updateOne")
			.mockImplementation(function (
				this: Collection<Document>,
				filter,
				update,
				options,
			) {
				if (
					this.namespace === `${name}.${prefix}memory_cost_ledger` &&
					filter.agentId === agentId &&
					++writes === 2
				)
					return Promise.reject(failure)
				return original.call(this, filter, update, options)
			})
		try {
			const outcome = await consolidateMemory({
				db,
				prefix,
				agentId,
				options,
			}).then(
				(value) => ({ value, error: undefined }),
				(error: unknown) => ({ value: undefined, error }),
			)
			const ledger = await db
				.collection(`${prefix}memory_cost_ledger`)
				.find({ agentId })
				.toArray()
			const event = await db.collection(`${prefix}events`).findOne({ eventId })
			const run = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId })
			const gate = await readErasureGate({ db, prefix, agentId })
			evidence("rollback", {
				ledger,
				event,
				run,
				gate,
				writes,
				error:
					outcome.error instanceof Error
						? outcome.error.message
						: outcome.error,
			})
			expect(outcome.error).toBe(failure)
			expect(ledger).toEqual([])
			expect(event?.dreamerProcessedAt).toBeUndefined()
			expect(run?.status).toBe("running")
			expect(gate?.serial).toBe(3)
		} finally {
			spy.mockRestore()
			vector.spy.mockRestore()
		}
	})
})
