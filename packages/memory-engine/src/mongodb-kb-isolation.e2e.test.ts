/**
 * KB tenant isolation (issue #27).
 *
 * Proves that in SHARED-collection mode (both tenants share one physical
 * collection prefix), the Knowledge Base does not leak across tenants:
 * one agent cannot list, remove, stat, or SEARCH another agent's KB documents.
 *
 * searchKB isolation is exercised through the last-resort $text path (all Atlas
 * Search capabilities off), which is reachable on a plain replica set without
 * mongot — the vector/keyword pre-filter paths carry the same scopeRef filter.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e
 * (auto-discovers the running mongodb/mongodb-atlas-local:preview container)
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
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
	type DetectedCapabilities,
	ensureCollections,
	ensureStandardIndexes,
	kbChunksCollection,
	kbCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

// All Atlas Search capabilities off → searchKB uses the $text fallback path.
const NO_ATLAS_SEARCH: DetectedCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

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
	// Creates idx_kbchunks_text ($text index) so the searchKB fallback runs.
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

	it("does not return another tenant's chunks from searchKB", async () => {
		const searchOpts = (agentId: string) => ({
			maxResults: 10,
			minScore: 0,
			scopeRef: `agent:${agentId}`,
			capabilities: NO_ATLAS_SEARCH,
			embeddingMode: "automated" as const,
			vectorIndexName: `${PREFIX}kb_chunks_vector`,
			textIndexName: `${PREFIX}kb_chunks_text`,
			kbDocs: kbCollection(db, PREFIX),
		})
		const chunks = kbChunksCollection(db, PREFIX)

		// "alpha" only appears in agent A's document.
		const asA = await searchKB(chunks, "alpha", null, searchOpts(AGENT_A))
		const asB = await searchKB(chunks, "alpha", null, searchOpts(AGENT_B))

		expect(asA.length).toBeGreaterThan(0)
		expect(asA.every((r) => r.snippet.includes("alpha"))).toBe(true)
		// Agent B must not see agent A's chunk even though it matches the query.
		expect(asB).toHaveLength(0)
	})
})
