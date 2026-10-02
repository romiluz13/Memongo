import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { consolidateMemory, matchPatterns } from "./mongodb-consolidator.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { ensureCollections } from "./mongodb-schema.js"
import { captureAdmissionToken } from "./mongodb-write-fence.js"
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
	throw new Error("E159 requires explicit owned server")
const client = new MongoClient(uri),
	name = `memongo_e159_conflict_${randomUUID().replaceAll("-", "")}`,
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
			`${process.env.E22_FETCH_EVIDENCE_DIR}/candidate-atomic-${label}.json`,
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
async function seed(
	agentId: string,
	candidateType = "fact",
	candidateKey = "moving to Paris",
	candidateBody = body,
) {
	transport.calls.length = 0
	transport.unexpected.length = 0
	transport.contradictions = 0
	transport.wait = async () => {}
	await captureAdmissionToken({ db, prefix, agentId })
	const now = new Date()
	await db.collection(`${prefix}structured_mem`).insertMany(
		[
			{
				key: candidateKey,
				value: "The commuter is moving to Rome",
				state: "conflicted",
			},
			{ key: "city", value: "Lives in London", state: "active" },
		].map((d) => ({
			...d,
			type: d.key === "city" ? "fact" : candidateType,
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
		body: candidateBody,
		role: "user",
		timestamp: now,
		importance: 1,
		createdAt: now,
	})
	await db.collection(`${prefix}query_cache`).insertOne({
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		queryHash: randomUUID(),
		queryNorm: "city",
		results: [],
		pathUsed: "text",
		sourceScope: "agent",
		createdAt: now,
		expiresAt: new Date(now.getTime() + 60000),
		hitCount: 0,
		lastHitAt: now,
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

for (const mode of [
	"noop",
	"candidate-write-fault",
	"retirement-audit-fault",
	"target-stale",
	"happy",
	"decision-happy",
	"decision-stale",
	"quality-drop",
] as const) {
	it(`${mode}: rejected candidate cannot retire an observed target`, async () => {
		const agentId = `agent-${randomUUID()}`
		const decisionCandidate = mode.startsWith("decision-")
		const currentBody = decisionCandidate
			? "We decided moving to Paris"
			: mode === "quality-drop"
				? "The project uses TypeScript"
				: body
		const currentKey =
			mode === "quality-drop" ? "TypeScript" : "moving to Paris"
		await seed(
			agentId,
			decisionCandidate ? "decision" : "fact",
			currentKey,
			currentBody,
		)
		const col = db.collection(`${prefix}structured_mem`)
		const originalTarget = await col.findOne({ agentId, key: "city" })
		let forced = false
		const originalAggregate = Collection.prototype.aggregate
		const originalUpdate = Collection.prototype.updateOne
		if (mode === "noop") {
			const now = new Date()
			const lookalike = {
				agentId,
				scope: "agent",
				scopeRef: `agent:${agentId}`,
				type: "fact",
				key: "lookalike",
				value: body,
				state: "active",
				revision: 1,
				createdAt: now,
				updatedAt: now,
				provenance: { origin: "observed" },
			}
			await col.insertOne(lookalike)
			vi.spyOn(Collection.prototype, "aggregate").mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof originalAggregate>
			) {
				const cursor = originalAggregate.apply(this, args)
				if (
					this.collectionName === col.collectionName &&
					args[0]?.some((stage) => stage.$vectorSearch?.limit === 5)
				) {
					cursor.toArray = async () => {
						forced = true
						return [{ ...lookalike, score: 0.99 }]
					}
				}
				return cursor
			})
		}
		if (mode === "candidate-write-fault") {
			vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof originalUpdate>
			) {
				const update = args[1] as Document
				if (
					this.collectionName === col.collectionName &&
					update.$set?.value === body
				) {
					forced = true
					throw new Error("owned candidate write failure after resolution")
				}
				return originalUpdate.apply(this, args)
			})
		}
		if (mode === "retirement-audit-fault") {
			const originalInsert = Collection.prototype.insertOne
			vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof originalInsert>
			) {
				const row = args[0] as Document
				if (
					this.collectionName === `${prefix}memory_mutations` &&
					row.operation === "invalidate" &&
					row.oldValue?.key === "city"
				) {
					forced = true
					throw new Error("owned retirement audit failure")
				}
				return originalInsert.apply(this, args)
			})
		}
		if (mode === "target-stale" || mode === "decision-stale") {
			// A real outside mutation after provider preparation and before candidate admission.
			vi.spyOn(Collection.prototype, "aggregate").mockImplementation(function (
				this: Collection<Document>,
				...args: Parameters<typeof originalAggregate>
			) {
				const cursor = originalAggregate.apply(this, args)
				if (
					this.collectionName === col.collectionName &&
					args[0]?.some((stage) => "$vectorSearch" in stage)
				) {
					cursor.toArray = async () => {
						if (!forced) {
							forced = true
							await col.updateOne(
								{ agentId, key: "city" },
								{ $set: { value: "Lives in Oslo", revision: 3 } },
							)
						}
						return []
					}
				}
				return cursor
			})
		}

		let result: unknown, error: unknown
		try {
			result = await consolidateMemory({ db, prefix, agentId, options })
		} catch (failure) {
			error = failure
		} finally {
			vi.restoreAllMocks()
		}
		const actual = await rows(agentId)
		evidence(mode, {
			result,
			error: error instanceof Error ? error.message : undefined,
			forced,
			originalTarget,
			actual,
			calls: transport.calls,
			unexpected: transport.unexpected,
		})
		expect(transport.unexpected).toEqual([])
		expect(transport.contradictions).toBe(2)
		if (mode === "happy" || mode === "decision-happy") {
			expect(error).toBeUndefined()
			expect(actual.query_cache).toHaveLength(0)
			expect(actual.structured_mem_revisions).toHaveLength(2)
			expect(
				actual.memory_mutations.filter(
					(d) => d.collectionName === "structured_mem",
				),
			).toHaveLength(2)
			expect(
				actual.structured_mem.find((d) => d.key === "city")?.invalidatedBy
					.runId,
			).toBe((result as { runId: string }).runId)
			expect(actual.structured_mem.find((d) => d.key === "city")).toMatchObject(
				{ state: "invalidated", revision: 2 },
			)
			expect(
				actual.structured_mem.find((d) => d.key === currentKey),
			).toMatchObject({ state: "active", value: currentBody, revision: 2 })
		} else {
			expect(actual.query_cache).toHaveLength(1)
			if (mode !== "quality-drop") expect(forced).toBe(true)
			expect(actual.structured_mem.find((d) => d.key === "city")).toEqual(
				mode === "target-stale" || mode === "decision-stale"
					? { ...originalTarget, value: "Lives in Oslo", revision: 3 }
					: originalTarget,
			)
			expect(
				actual.structured_mem.find((d) => d.key === currentKey),
			).toMatchObject({ state: "conflicted", revision: 1 })
			expect(
				actual.structured_mem_revisions.filter((d) => d.key === "city"),
			).toEqual([])
			expect(
				actual.memory_mutations.filter(
					(d) => d.oldValue?.key === "city" && d.operation === "invalidate",
				),
			).toEqual([])
		}
	})
}
