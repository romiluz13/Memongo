import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import type { Document } from "mongodb"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	resolveEnrichmentProvider: () => null,
}))
vi.mock("./mongodb-graph.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	extractAndUpsertEntities: vi.fn(async () => ({ entities: [] })),
}))

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E143 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e143_tail_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const body = "We decided to use Biome for linting"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/noop-tail-${label}.json`,
			JSON.stringify(data),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
})
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

// Only the production post-search pipeline runs on mongod; ANN and writes remain fake.
it.each([
	["observed", { provenance: { origin: "user" } }, 0],
	["legacy", { state: undefined }, 0],
	["conflicted", { state: "conflicted" }, 0],
	["invalidated", { state: "invalidated" }, 1],
	["inferred", { provenance: { origin: "llm-inference" } }, 1],
	["owner", { agentId: "another-agent" }, 1],
	["scope", { scope: "workspace" }, 1],
	["scope reference", { scopeRef: "another-reference" }, 1],
	["expired", { expiresAt: new Date(0) }, 1],
] as const)("native tail revalidates %s before the NOOP decision", async (_label, patch, promoted) => {
	const agentId = randomUUID(),
		scopeRef = `agent:${agentId}`
	const row: Document = {
		agentId,
		scope: "agent",
		scopeRef,
		state: "active",
		score: 0.99,
		...patch,
	}
	for (const key of Object.keys(row))
		if (row[key] === undefined) delete row[key]
	const native = db.collection(`lookalike_${randomUUID().replaceAll("-", "")}`)
	await native.insertOne(row)
	const fake = createStatefulMongoFake({ prefix: "test_" })
	await fake.collection("events").insertOne({
		agentId,
		scope: "agent",
		scopeRef,
		eventId: "evt-repeat",
		body,
		role: "user",
		timestamp: new Date(),
	})
	const structured = fake.collection("structured_mem"),
		original = structured.aggregate.bind(structured)
	let hits = 0
	const spy = vi
		.spyOn(structured, "aggregate")
		.mockImplementation((pipeline) => {
			const vector = pipeline[0]?.$vectorSearch as Document | undefined
			if (vector?.numCandidates !== 100) return original(pipeline)
			hits++
			return {
				toArray: () => native.aggregate(pipeline.slice(2)).toArray(),
			} as ReturnType<typeof structured.aggregate>
		})
	try {
		const result = await consolidateMemory({
			db: fake.db,
			prefix: "test_",
			agentId,
		})
		expect(hits).toBe(1)
		expect(result.factsPromoted).toBe(promoted)
		expect(result.eventsProcessed).toBe(1)
	} finally {
		spy.mockRestore()
	}
})
