/**
 * KB re-ingestion against a real replica set.
 *
 * Re-ingesting an existing document (same path, changed content) takes the
 * `reIngestAtomically` path, which wraps delete-old + insert-new in
 * `session.withTransaction()`. That path is only exercised when a MongoClient
 * is supplied, and it can only fail on a real topology — the unit tests stub
 * `withTransaction` as a stateless pass-through, so nothing there can observe
 * a nested-transaction error.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e
 * (auto-discovers the running mongodb/mongodb-atlas-local:preview container)
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { hashText } from "./internal.js"
import {
	type KBDocument,
	getKBStats,
	ingestToKB,
	listKBDocuments,
} from "./mongodb-kb.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	kbCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_kb_reingest_${randomUUID().slice(0, 8)}`
const PREFIX = "reingest_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`

const DOC_PATH = "docs/handbook.md"

function kbDoc(content: string): KBDocument {
	return {
		title: "handbook",
		content,
		source: { type: "manual", importedBy: "api", path: DOC_PATH },
		hash: hashText(content),
	}
}

async function ingest(content: string) {
	return await ingestToKB({
		db,
		prefix: PREFIX,
		embeddingMode: "automated",
		scope: { agentId: AGENT, scope: "agent" },
		documents: [kbDoc(content)],
		// The transactional re-ingest path only runs when a client is supplied.
		client,
	})
}

let client: MongoClient
let db: Db

beforeAll(async () => {
	client = new MongoClient(TEST_URI)
	await client.connect()
	db = client.db(TEST_DB)
	await ensureCollections(db, PREFIX)
	await ensureStandardIndexes(db, PREFIX)
})

afterAll(async () => {
	await db?.dropDatabase().catch(() => {})
	await client?.close().catch(() => {})
})

describe("KB re-ingestion on a real replica set", () => {
	it("re-ingests a changed document without transaction errors", async () => {
		const first = await ingest("original handbook body")
		expect(first.errors).toHaveLength(0)
		expect(first.documentsProcessed).toBe(1)

		// Same path, different content -> hash differs -> re-ingestion path,
		// which opens a transaction and (today) opens a second one inside it.
		const second = await ingest("revised handbook body")

		expect(second.errors).toHaveLength(0)
		expect(second.documentsProcessed).toBe(1)
		expect(second.chunksCreated).toBeGreaterThan(0)
	})

	it("leaves exactly one document and its chunks after re-ingestion", async () => {
		const docs = await listKBDocuments(db, PREFIX, {
			scope: { agentId: AGENT, scope: "agent" },
		})
		expect(docs).toHaveLength(1)

		// listKBDocuments omits `content`, so read the stored body directly to
		// prove the new revision replaced the old one.
		const stored = await kbCollection(db, PREFIX).findOne({
			scopeRef: `agent:${AGENT}`,
		})
		expect(stored?.content).toBe("revised handbook body")

		const stats = await getKBStats(db, PREFIX, {
			scope: { agentId: AGENT, scope: "agent" },
		})
		expect(stats.documents).toBe(1)
		// The old document's chunks must be gone and the new ones present.
		expect(stats.chunks).toBeGreaterThan(0)
	})
})
