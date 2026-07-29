/**
 * Typed semantic edge proof (issue #34).
 *
 * Against live MongoDB + a live LLM: extract typed relations among an event's
 * entities and prove (a) real typed edges (works_on / depends_on / blocked_by)
 * are written with confidence + provenance, and (b) the graph lane gains a query
 * class co-occurrence cannot answer — "what does the API depend on?" is
 * answerable via a typed depends_on edge, whereas a mentioned_with-only graph
 * has ZERO semantic edges. Skipped unless a provider is configured.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_ENRICHMENT_API_KEY=... MEMONGO_ENRICHMENT_BASE_URL=... \
 *   MEMONGO_ENRICHMENT_MODEL=... MEMONGO_ENRICHMENT_AUTH_STYLE=api-key \
 *   MEMONGO_ENRICHMENT_PROVIDER=openai-compatible \
 *   vitest run src/mongodb-relation-extraction.e2e.test.ts --testTimeout=240000
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { extractAndUpsertTypedRelations } from "./mongodb-graph.js"
import { resolveEnrichmentProvider } from "./mongodb-llm-enrichment.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	relationsCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const provider = (() => {
	try {
		return resolveEnrichmentProvider(process.env)
	} catch {
		return null
	}
})()
const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_relations_${randomUUID().slice(0, 8)}`
const PREFIX = "rel_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`
const SCOPE_REF = `agent:${AGENT}`

const ENTITIES = [
	{ entityId: "e-alice", name: "Alice" },
	{ entityId: "e-api", name: "the payments API" },
	{ entityId: "e-mongo", name: "MongoDB" },
]
const SEMANTIC_TYPES = [
	"works_on",
	"owns",
	"depends_on",
	"blocked_by",
	"decided",
	"reported_by",
	"related_to",
]

let client: MongoClient
let db: Db
let created = 0

describe.skipIf(!provider)("typed semantic edges (live Mongo + LLM)", () => {
	beforeAll(async () => {
		if (!provider) return
		client = new MongoClient(TEST_URI)
		await client.connect()
		db = client.db(TEST_DB)
		await ensureCollections(db, PREFIX)
		await ensureStandardIndexes(db, PREFIX)

		created = await extractAndUpsertTypedRelations({
			db,
			prefix: PREFIX,
			agentId: AGENT,
			scope: "agent",
			scopeRef: SCOPE_REF,
			eventContent:
				"Alice works on the payments API, which depends on MongoDB.",
			entities: ENTITIES,
			provider,
			model,
			sourceEventId: "evt-rel-1",
			validFrom: new Date("2026-01-01T00:00:00.000Z"),
		})
	})

	afterAll(async () => {
		await db?.dropDatabase().catch(() => {})
		await client?.close()
	})

	it("writes typed semantic edges with confidence and provenance", async () => {
		expect(created).toBeGreaterThan(0)
		const edges = await relationsCollection(db, PREFIX)
			.find({ agentId: AGENT, type: { $in: SEMANTIC_TYPES } })
			.toArray()
		console.log(
			"typed edges ->",
			JSON.stringify(
				edges.map((e) => ({
					from: e.fromEntityId,
					to: e.toEntityId,
					type: e.type,
					weight: e.weight,
				})),
			),
		)
		expect(edges.length).toBeGreaterThan(0)
		for (const edge of edges) {
			expect(typeof edge.confidence).toBe("number")
			expect(edge.weight).toBe(edge.confidence)
			expect((edge.provenance as Record<string, unknown>)?.origin).toBe(
				"llm-relation-extraction",
			)
			expect(edge.validFrom).toBeInstanceOf(Date)
		}
	})

	it("answers 'what does the payments API depend on?' — a query co-occurrence cannot", async () => {
		// mentioned_with-only graphs have ZERO depends_on edges, so this traversal
		// is only possible because typed extraction ran.
		const mentionedWithCount = await relationsCollection(
			db,
			PREFIX,
		).countDocuments({ agentId: AGENT, type: "depends_on" })
		expect(mentionedWithCount).toBeGreaterThan(0)

		const dependsOn = await relationsCollection(db, PREFIX)
			.find({ agentId: AGENT, type: "depends_on", fromEntityId: "e-api" })
			.toArray()
		expect(dependsOn.map((e) => e.toEntityId)).toContain("e-mongo")
	})
})
