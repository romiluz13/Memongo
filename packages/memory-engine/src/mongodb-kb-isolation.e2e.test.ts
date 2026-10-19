/**
 * KB tenant isolation (issue #27).
 *
 * Proves that in SHARED-collection mode (both tenants share one physical
 * collection prefix), the Knowledge Base does not leak across tenants:
 * one agent cannot list, remove, stat, or SEARCH another agent's KB documents.
 *
 * searchKB runs one native fusion that needs Atlas Search and a query embedding,
 * which this keyless tier never has. Its isolation is exercised by capturing
 * the tenant predicate searchKB hands to $vectorSearch and applying that exact
 * predicate to the stored chunks.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e
 * (auto-discovers the running mongodb/mongodb-atlas-local container)
 */
import { randomUUID } from "node:crypto"
import { type Collection, type Db, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { hashText } from "./internal.js"
import { searchKB } from "./mongodb-kb-search.js"
import {
	getKBStats,
	type KBDocument,
	ingestToKB,
	listKBDocuments,
	removeKBDocument,
} from "./mongodb-kb.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	kbChunksCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_kb_isolation_${randomUUID().slice(0, 8)}`
// SHARED prefix: both tenants land in the same physical collections, so the
// only thing that can isolate them is the in-document scope filter.
const PREFIX = "shared_"

const AGENT_A = `agent-a-${randomUUID().slice(0, 8)}`
const AGENT_B = `agent-b-${randomUUID().slice(0, 8)}`

function kbDoc(title: string, content: string): KBDocument {
	return {
		title,
		content,
		source: { type: "manual", importedBy: "api" },
		hash: hashText(content),
	}
}

let client: MongoClient
let db: Db

beforeAll(async () => {
	client = new MongoClient(TEST_URI)
	await client.connect()
	db = client.db(TEST_DB)
	await ensureCollections(db, PREFIX)
	await ensureStandardIndexes(db, PREFIX)

	await ingestToKB({
		db,
		prefix: PREFIX,
		embeddingMode: "automated",
		scope: { agentId: AGENT_A, scope: "agent" },
		documents: [kbDoc("A-secret", "alpha private content")],
	})
	await ingestToKB({
		db,
		prefix: PREFIX,
		embeddingMode: "automated",
		scope: { agentId: AGENT_B, scope: "agent" },
		documents: [kbDoc("B-secret", "bravo private content")],
	})
})

afterAll(async () => {
	await db?.dropDatabase().catch(() => {})
	await client?.close().catch(() => {})
})

describe("KB tenant isolation (shared collection)", () => {
	it("lists only the calling tenant's documents", async () => {
		const aDocs = await listKBDocuments(db, PREFIX, {
			scope: { agentId: AGENT_A, scope: "agent" },
		})
		const bDocs = await listKBDocuments(db, PREFIX, {
			scope: { agentId: AGENT_B, scope: "agent" },
		})
		expect(aDocs.map((d) => d.title)).toEqual(["A-secret"])
		expect(bDocs.map((d) => d.title)).toEqual(["B-secret"])
	})

	it("prevents a tenant from removing another tenant's document", async () => {
		const aDocs = await listKBDocuments(db, PREFIX, {
			scope: { agentId: AGENT_A, scope: "agent" },
		})
		const aId = aDocs[0]?._id as string

		const removed = await removeKBDocument(db, PREFIX, aId, {
			scope: { agentId: AGENT_B, scope: "agent" },
		})
		expect(removed).toBe(false)

		const aStill = await listKBDocuments(db, PREFIX, {
			scope: { agentId: AGENT_A, scope: "agent" },
		})
		expect(aStill.map((d) => d.title)).toContain("A-secret")
	})

	it("reports stats only for the calling tenant", async () => {
		const aStats = await getKBStats(db, PREFIX, {
			scope: { agentId: AGENT_A, scope: "agent" },
		})
		expect(aStats.documents).toBe(1)
		expect(aStats.chunks).toBeGreaterThan(0)
	})

	it("lets two tenants ingest identical content without colliding", async () => {
		// Same title/content/hash for both tenants. A global unique index on
		// hash (or path+lines) would reject the second tenant; the scoped
		// unique index must allow both.
		const shared = kbDoc("shared-title", "identical shared content body")
		await ingestToKB({
			db,
			prefix: PREFIX,
			embeddingMode: "automated",
			scope: { agentId: AGENT_A, scope: "agent" },
			documents: [shared],
		})
		const rb = await ingestToKB({
			db,
			prefix: PREFIX,
			embeddingMode: "automated",
			scope: { agentId: AGENT_B, scope: "agent" },
			documents: [{ ...shared }],
		})
		expect(rb.documentsProcessed).toBe(1)
		expect(rb.errors).toHaveLength(0)

		const aTitles = (
			await listKBDocuments(db, PREFIX, {
				scope: { agentId: AGENT_A, scope: "agent" },
			})
		).map((d) => d.title)
		const bTitles = (
			await listKBDocuments(db, PREFIX, {
				scope: { agentId: AGENT_B, scope: "agent" },
			})
		).map((d) => d.title)
		expect(aTitles).toContain("shared-title")
		expect(bTitles).toContain("shared-title")
	})

	it("scopes searchKB to the calling tenant: the predicate it hands to Search isolates the stored chunks", async () => {
		const emitted: Document[][] = []
		const recorder = {
			aggregate: (pipeline: Document[]) => {
				emitted.push(pipeline)
				return { toArray: async () => [] }
			},
		} as unknown as Collection
		const searchOpts = (agentId: string) => ({
			maxResults: 10,
			minScore: 0,
			scopeRef: `agent:${agentId}`,
			embeddingMode: "automated" as const,
			vectorIndexName: `${PREFIX}kb_chunks_vector`,
			textIndexName: `${PREFIX}kb_chunks_text`,
		})
		await searchKB(recorder, "alpha", null, searchOpts(AGENT_A))
		await searchKB(recorder, "alpha", null, searchOpts(AGENT_B))
		const tenantPredicate = (pipeline: Document[]): Document =>
			pipeline[0].$scoreFusion.input.pipelines.vector[0].$vectorSearch.filter
		const chunks = kbChunksCollection(db, PREFIX)

		const asA = await chunks.find(tenantPredicate(emitted[0])).toArray()
		const asB = await chunks.find(tenantPredicate(emitted[1])).toArray()

		// "alpha" only appears in agent A's document.
		expect(asA.some((chunk) => String(chunk.text).includes("alpha"))).toBe(true)
		expect(asB.length).toBeGreaterThan(0)
		// Agent B must not see agent A's chunk even though it matches the query.
		expect(asB.some((chunk) => String(chunk.text).includes("alpha"))).toBe(
			false,
		)
	})
})
