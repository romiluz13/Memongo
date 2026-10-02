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
	throw new Error("E78 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e78_heartbeat_${randomUUID().replaceAll("-", "")}`
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
			`${process.env.E22_FETCH_EVIDENCE_DIR}/heartbeat-${label}.json`,
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
describe("consolidation renews during an awaited local model call", () => {
	it("renews across the initial expiry and commits inference and acknowledgement", async () => {
		const agentId = `agent-${randomUUID()}`
		const eventId = await seed(agentId)
		let initial: Document | null = null
		let during: Document | null = null
		let modelStarted = false
		model.wait = async () => {
			if (!modelStarted) {
				modelStarted = true
				initial = await db
					.collection(`${prefix}consolidation_runs`)
					.findOne({ agentId })
			}
			await new Promise((resolve) => setTimeout(resolve, 4500))
			during = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId })
		}
		const outcome = await consolidateMemory({
			db,
			prefix,
			agentId,
			options: { ...options, leaseMs: 3000 },
		}).then(
			(result) => ({ kind: "resolved" as const, result }),
			(error: Error) => ({
				kind: "rejected" as const,
				name: error.name,
				message: error.message,
			}),
		)
		const actual = await rows(agentId)
		evidence("long-wait", {
			initial,
			during,
			outcome,
			actual,
			calls: model.calls,
		})
		expectCalls()
		expect(outcome.kind).toBe("resolved")
		const start = initial as Document | null
		const renewed = during as Document | null
		expect(start?.leaseExpiresAt).toBeInstanceOf(Date)
		expect(renewed?.leaseExpiresAt).toBeInstanceOf(Date)
		expect(renewed?.leaseExpiresAt.getTime()).toBeGreaterThan(
			start?.leaseExpiresAt.getTime(),
		)
		expect(renewed?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() - 1000)
		expect(actual.structured_mem).toHaveLength(3)
		expect(actual.events[0]).toMatchObject({
			eventId,
			dreamerProcessedAt: expect.any(Date),
		})
		expect(actual.consolidation_runs[0]).toMatchObject({
			status: "completed",
			eventsProcessed: 1,
		})
		const afterFinish = await rows(agentId)
		await new Promise((resolve) => setTimeout(resolve, 1200))
		expect(await rows(agentId)).toEqual(afterFinish)
		model.wait = async () => {}
	})
	it.each([
		"replacement",
		"erase",
		"renewal-fault",
	] as const)("blocks effects after %s during a model wait", async (kind) => {
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
		const run = consolidateMemory({
			db,
			prefix,
			agentId,
			options: { ...options, leaseMs: 3000 },
		}).then(
			(result) => ({ kind: "resolved" as const, result }),
			(error: Error & { code?: string }) => ({
				kind: "rejected" as const,
				error,
			}),
		)
		let spy: ReturnType<typeof vi.spyOn> | undefined
		const fault = new Error("owned heartbeat fault")
		let heartbeatFaults = 0
		try {
			await paused
			const claimed = await db
				.collection(`${prefix}consolidation_runs`)
				.findOne({ agentId })
			expect(claimed?.status).toBe("running")
			if (kind === "replacement") {
				await db.collection(`${prefix}consolidation_runs`).updateOne(
					{ agentId },
					{
						$set: {
							runId: randomUUID(),
							leaseToken: randomUUID(),
							leaseExpiresAt: new Date(Date.now() + 60000),
						},
					},
				)
			} else if (kind === "erase") {
				expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
					"complete",
				)
			} else {
				const original = Collection.prototype.updateOne
				spy = vi
					.spyOn(Collection.prototype, "updateOne")
					.mockImplementation(function (
						this: Collection<Document>,
						...args: Parameters<typeof original>
					) {
						if (
							this.collectionName === `${prefix}consolidation_runs` &&
							args[0]?.runId === claimed?.runId &&
							Array.isArray(args[1])
						) {
							heartbeatFaults++
							return Promise.reject(fault)
						}
						return original.apply(this, args)
					})
			}
			const snapshot = await rows(agentId)
			const epoch = await readErasureGate({ db, prefix, agentId })
			await new Promise((resolve) => setTimeout(resolve, 1400))
			release()
			const outcome = await run
			const actual = await rows(agentId)
			const actualEpoch = await readErasureGate({ db, prefix, agentId })
			evidence(kind, {
				snapshot,
				actual,
				epoch,
				actualEpoch,
				outcome:
					outcome.kind === "rejected"
						? {
								kind: outcome.kind,
								name: outcome.error.name,
								code: outcome.error.code,
								message: outcome.error.message,
								sameFault: outcome.error === fault,
							}
						: outcome,
				heartbeatFaults,
				calls: model.calls,
			})
			expect(outcome.kind).toBe("rejected")
			if (outcome.kind === "rejected") {
				if (kind === "replacement")
					expect(outcome.error.name).toBe("ConsolidationLeaseLostError")
				else if (kind === "erase")
					expect(outcome.error.code).toBe("ERASURE_GATE_CONFLICT")
				else {
					expect(outcome.error).toBe(fault)
					expect(heartbeatFaults).toBe(1)
				}
			}
			expect(actual).toEqual(snapshot)
			expect(actualEpoch).toEqual(epoch)
			await new Promise((resolve) => setTimeout(resolve, 1200))
			expect(await rows(agentId)).toEqual(actual)
			expect(await readErasureGate({ db, prefix, agentId })).toEqual(
				actualEpoch,
			)
			expectCalls()
		} finally {
			release()
			await run
			spy?.mockRestore()
			model.wait = async () => {}
		}
	})
	it.each([
		"empty",
		"query-error",
	] as const)("cleans the unreferenced timer on %s exit", async (kind) => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		const interval = vi.spyOn(globalThis, "setInterval")
		const clear = vi.spyOn(globalThis, "clearInterval")
		const fault = new Error("owned event query fault")
		const original = Collection.prototype.find
		const query = vi
			.spyOn(Collection.prototype, "find")
			.mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof original>
			) {
				if (
					kind === "query-error" &&
					this.collectionName === `${prefix}events` &&
					args[0]?.agentId === agentId
				)
					throw fault
				return original.apply(this, args)
			})
		try {
			const outcome = await consolidateMemory({
				db,
				prefix,
				agentId,
				options,
			}).then(
				(result) => ({ kind: "resolved" as const, result }),
				(error: Error) => ({ kind: "rejected" as const, error }),
			)
			expect(interval).toHaveBeenCalledTimes(1)
			const timer = interval.mock.results[0]?.value as ReturnType<
				typeof setInterval
			>
			expect(timer.hasRef()).toBe(false)
			expect(clear).toHaveBeenCalledWith(timer)
			if (kind === "empty") {
				expect(outcome.kind).toBe("resolved")
				expect(
					await db
						.collection(`${prefix}consolidation_runs`)
						.findOne({ agentId }),
				).toMatchObject({ status: "completed", eventsProcessed: 0 })
			} else {
				expect(outcome.kind).toBe("rejected")
				if (outcome.kind === "rejected") expect(outcome.error).toBe(fault)
			}
			evidence(kind, {
				kind: outcome.kind,
				unref: !timer.hasRef(),
				cleared: clear.mock.calls.some((args) => args[0] === timer),
				sameFault: outcome.kind === "rejected" && outcome.error === fault,
			})
		} finally {
			query.mockRestore()
			interval.mockRestore()
			clear.mockRestore()
		}
	})
})
