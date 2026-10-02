import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, type Document, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import {
	prepareDerivedMemoryPromotion,
	persistPreparedDerivedMemoryPromotion,
} from "./mongodb-derived-memory.js"
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
	throw new Error("E148 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e147_driver_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
const audits = db.collection(`${prefix}memory_mutations`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/support-life-${label}.json`,
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
const scenarios = [
	"valid",
	"legacy",
	"explicit null",
	"future invalidation",
	"invalidated",
	"future valid",
	"expired",
	"invalidated after preparation",
	"future valid after preparation",
	"invalidated during preparation",
	"future valid during preparation",
] as const
it.each(
	scenarios,
)("%s support cannot bypass lifecycle at promotion", async (kind) => {
	const now = new Date(),
		agentId = `agent-${randomUUID()}`
	await captureAdmissionToken({ db, prefix, agentId })
	const event: Parameters<typeof prepareDerivedMemoryPromotion>[0]["event"] = {
		eventId: randomUUID(),
		agentId,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		role: "user",
		body: "I prefer concise answers with direct tradeoffs.",
		timestamp: now,
	}
	const support: Document = {
		...event,
		eventId: randomUUID(),
		timestamp: new Date(now.getTime() - 10000),
		validAt: new Date(now.getTime() - 20000),
	}
	if (kind === "legacy") delete support.validAt
	if (kind === "explicit null") support.invalidAt = null
	if (kind === "future invalidation")
		support.invalidAt = new Date(now.getTime() + 60000)
	if (kind === "invalidated") support.invalidAt = new Date(now.getTime() - 1000)
	if (kind === "future valid") support.validAt = new Date(now.getTime() + 60000)
	if (kind === "expired") support.expiresAt = new Date(now.getTime() - 1000)
	const events = db.collection(`${prefix}events`)
	await events.insertMany([{ ...event }, support])
	if (kind.endsWith("during preparation")) {
		const find = Collection.prototype.find
		let changed = false
		vi.spyOn(Collection.prototype, "find").mockImplementation(function (
			this: Collection<Document>,
			...args: Parameters<typeof find>
		) {
			const cursor = find.apply(this, args)
			if (
				!changed &&
				this.collectionName === events.collectionName &&
				args[0]?.eventId?.$ne === event.eventId
			) {
				const original = cursor.toArray.bind(cursor)
				vi.spyOn(cursor, "toArray").mockImplementation(async () => {
					const docs = await original()
					changed = true
					await events.updateOne(
						{ eventId: support.eventId },
						{
							$set: kind.startsWith("invalidated")
								? { invalidAt: new Date(now.getTime() - 1000) }
								: { validAt: new Date(now.getTime() + 60000) },
						},
					)
					return docs
				})
			}
			return cursor
		})
	}
	const prepared = await prepareDerivedMemoryPromotion({ db, prefix, event })
	const rejectedInitially =
		["invalidated", "future valid", "expired"].includes(kind) ||
		kind.endsWith("during preparation")
	expect(prepared.structuredCandidates).toHaveLength(rejectedInitially ? 0 : 1)
	if (kind.endsWith("after preparation")) {
		await events.updateOne(
			{ eventId: support.eventId },
			{
				$set: kind.startsWith("invalidated")
					? { invalidAt: new Date(now.getTime() - 1000) }
					: { validAt: new Date(now.getTime() + 60000) },
			},
		)
	}
	await client.withSession(async (session) => {
		await session.withTransaction(async () => {
			await persistPreparedDerivedMemoryPromotion({
				db,
				prefix,
				session,
				event,
				prepared,
				embeddingMode: "automated",
			})
		})
	})
	const rejected = rejectedInitially || kind.endsWith("after preparation")
	expect(await col.countDocuments({ agentId })).toBe(rejected ? 0 : 1)
	expect(await audits.countDocuments({ agentId })).toBe(rejected ? 0 : 1)
})
