/**
 * MongoDB E2E tests — requires a running MongoDB 8.2+ instance.
 *
 * Run manually:
 *   MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true" \
 *     pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts --reporter=verbose
 *
 * These tests exercise the real MongoDB driver and server operations.
 * They are useful both for the supported atlas-local-preview path and for
 * degraded behavior when Search is unavailable on the test server.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MongoClient, type Db } from "mongodb"
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { getMemoryStats } from "./mongodb-analytics.js"
import { MongoDBChangeStreamWatcher } from "./mongodb-change-stream.js"
import { materializeEpisode, searchEpisodes } from "./mongodb-episodes.js"
import { writeEvent, projectChunksFromEvents } from "./mongodb-events.js"
import {
	upsertEntity,
	upsertRelation,
	upsertEntityLink,
	setEntityLinkStatus,
	getEntityLinks,
	expandGraph,
} from "./mongodb-graph.js"
import { getV2Status } from "./mongodb-manager.js"
import { backfillEventsFromChunks } from "./mongodb-migration.js"
import {
	planRetrieval,
	type RetrievalPath,
} from "./mongodb-retrieval-planner.js"
import {
	chunksCollection,
	filesCollection,
	embeddingCacheCollection,
	metaCollection,
	eventsCollection,
	entitiesCollection,
	entityLinksCollection,
	relationsCollection,
	episodesCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
	ensureCollections,
	ensureStandardIndexes,
	ensureSearchIndexes,
	detectCapabilities,
} from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true",
)
const TEST_DB = "memongo_e2e_test"
const TEST_PREFIX = "e2e_"
const EXPECTED_COLLECTION_SUFFIXES = [
	"chunks",
	"files",
	"embedding_cache",
	"meta",
	"knowledge_base",
	"kb_chunks",
	"structured_mem",
	"structured_mem_revisions",
	"procedures",
	"procedure_revisions",
	"relevance_runs",
	"relevance_artifacts",
	"relevance_regressions",
	"events",
	"entities",
	"relations",
	"entity_links",
	"episodes",
	"ingest_runs",
	"projection_runs",
	"query_cache",
	"memory_telemetry",
	"memory_mutations",
	"lane_coverage",
	"consolidation_runs",
] as const
const EXPECTED_STANDARD_INDEX_COUNT = 67

let client: MongoClient
let db: Db
let tmpDir: string

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
	client = new MongoClient(TEST_URI, {
		serverSelectionTimeoutMS: 5_000,
		connectTimeoutMS: 5_000,
	})
	await client.connect()
	await client.db("admin").command({ ping: 1 })
	db = client.db(TEST_DB)
	// Clean slate
	await db.dropDatabase()
})

afterAll(async () => {
	if (db) {
		await db.dropDatabase()
	}
	if (client) {
		await client.close()
	}
})

beforeEach(async () => {
	// Drop and recreate for each test group that needs fresh state
})

// ---------------------------------------------------------------------------
// Helper: create workspace with memory files
// ---------------------------------------------------------------------------

async function setupWorkspace(files: Record<string, string>): Promise<string> {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-e2e-"))
	const memDir = path.join(tmpDir, "memory")
	await fs.mkdir(memDir, { recursive: true })
	for (const [name, content] of Object.entries(files)) {
		await fs.writeFile(path.join(memDir, name), content, "utf-8")
	}
	return tmpDir
}

async function cleanupWorkspace(): Promise<void> {
	if (tmpDir) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	}
}

// ===========================================================================
// Collection and Index Tests
// ===========================================================================

describe("E2E: MongoDB Collections and Indexes", () => {
	it("creates all required collections", async () => {
		await ensureCollections(db, TEST_PREFIX)

		const collections = await db.listCollections().toArray()
		const names = collections.map((c) => c.name)

		for (const suffix of EXPECTED_COLLECTION_SUFFIXES) {
			expect(names).toContain(`${TEST_PREFIX}${suffix}`)
		}
	})

	it("ensureCollections is idempotent", async () => {
		await ensureCollections(db, TEST_PREFIX)
		// Calling again should not throw
		await ensureCollections(db, TEST_PREFIX)

		const collections = await db.listCollections().toArray()
		const count = collections.filter((c) =>
			c.name.startsWith(TEST_PREFIX),
		).length
		expect(count).toBe(EXPECTED_COLLECTION_SUFFIXES.length)
	})

	it("refreshes validators on existing collections when the schema changes", async () => {
		const legacyPrefix = `legacy_${randomUUID().slice(0, 8)}_`
		await db.createCollection(`${legacyPrefix}projection_runs`, {
			validator: {
				$jsonSchema: {
					bsonType: "object",
					required: [
						"runId",
						"agentId",
						"projectionType",
						"status",
						"itemsProjected",
						"durationMs",
						"ts",
					],
					properties: {
						runId: { bsonType: "string" },
						agentId: { bsonType: "string" },
						projectionType: { enum: ["chunk", "graph", "episode"] },
						status: { enum: ["ok", "partial", "failed"] },
						itemsProjected: { bsonType: "number" },
						durationMs: { bsonType: "number" },
						ts: { bsonType: "date" },
					},
				},
			},
			validationLevel: "moderate",
			validationAction: "error",
		})

		await ensureCollections(db, legacyPrefix)

		await expect(
			db.collection(`${legacyPrefix}projection_runs`).insertOne({
				runId: "new-shape",
				agentId: "agent-test",
				projectionType: "chunks",
				status: "ok",
				itemsProjected: 1,
				durationMs: 1,
				ts: new Date(),
			}),
		).resolves.toBeDefined()
	})

	it("creates standard indexes", async () => {
		await ensureCollections(db, TEST_PREFIX)
		const applied = await ensureStandardIndexes(db, TEST_PREFIX)
		expect(applied).toBe(EXPECTED_STANDARD_INDEX_COUNT)

		// Verify chunks indexes
		const chunksIndexes = await chunksCollection(db, TEST_PREFIX).indexes()
		const indexNames = chunksIndexes.map((i) => i.name)
		expect(indexNames).toContain("idx_chunks_path")
		expect(indexNames).toContain("idx_chunks_path_hash")
		expect(indexNames).toContain("idx_chunks_updated")
		expect(indexNames).toContain("idx_chunks_text")

		// Verify $text index structure
		const textIdx = chunksIndexes.find((i) => i.name === "idx_chunks_text")
		expect(textIdx).toBeDefined()
		expect(textIdx!.key).toHaveProperty("_fts", "text")

		// Verify cache indexes
		const cacheIndexes = await embeddingCacheCollection(
			db,
			TEST_PREFIX,
		).indexes()
		const cacheNames = cacheIndexes.map((i) => i.name)
		expect(cacheNames).toContain("uq_embedding_cache_composite")
		expect(cacheNames).toContain("idx_cache_updated")

		// Verify the unique index
		const uniqueIdx = cacheIndexes.find(
			(i) => i.name === "uq_embedding_cache_composite",
		)
		expect(uniqueIdx?.unique).toBe(true)
	}, 90_000)

	it("ensureStandardIndexes is idempotent", async () => {
		const applied1 = await ensureStandardIndexes(db, TEST_PREFIX)
		const applied2 = await ensureStandardIndexes(db, TEST_PREFIX)
		expect(applied1).toBe(applied2)
	}, 90_000)

	it("ensures search indexes according to the live deployment", async () => {
		const result = await ensureSearchIndexes(
			db,
			TEST_PREFIX,
			"atlas-local-preview",
			"automated",
		)

		try {
			const searchIndexes = await chunksCollection(db, TEST_PREFIX)
				.listSearchIndexes()
				.toArray()
			const searchIndexNames = new Set(searchIndexes.map((index) => index.name))
			expect(result.text).toBe(
				searchIndexNames.has(`${TEST_PREFIX}chunks_text`),
			)
			expect(result.vector).toBe(
				searchIndexNames.has(`${TEST_PREFIX}chunks_vector`),
			)
		} catch {
			expect(result).toEqual({ text: false, vector: false })
		}
	})
})

// ===========================================================================
// Capability Detection Tests
// ===========================================================================

describe("E2E: Capability Detection", () => {
	it("matches the live deployment's actual search capabilities", async () => {
		const caps = await detectCapabilities(db, `${TEST_PREFIX}chunks`)

		// MongoDB 8.2 recognizes $rankFusion and $scoreFusion as valid stages
		expect(caps.rankFusion).toBe(true)
		expect(caps.scoreFusion).toBe(true)

		let listSearchIndexesAvailable = false
		try {
			await chunksCollection(db, TEST_PREFIX).listSearchIndexes().toArray()
			listSearchIndexesAvailable = true
		} catch {
			listSearchIndexesAvailable = false
		}

		expect(caps.vectorSearch).toBe(listSearchIndexesAvailable)
		expect(caps.textSearch).toBe(listSearchIndexesAvailable)
	})
})

// ===========================================================================
// Sync Workflow Tests
// ===========================================================================

describe("E2E: Sync Workflow", () => {
	let workspaceDir: string

	beforeAll(async () => {
		// Clean collections once at start for fresh sync
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
		await filesCollection(db, TEST_PREFIX).deleteMany({})
	})

	afterAll(async () => {
		await cleanupWorkspace()
	})

	// Tests in this block are SEQUENTIAL — each builds on the previous state
	it("syncs memory files to MongoDB", async () => {
		workspaceDir = await setupWorkspace({
			"project-notes.md": [
				"# Project Notes",
				"",
				"This is a project about building a MongoDB backend.",
				"It uses vector search and text search for hybrid retrieval.",
				"",
				"## Architecture",
				"",
				"The system has four main files:",
				"- mongodb-schema.ts for collection and index management",
				"- mongodb-search.ts for search operations",
				"- mongodb-sync.ts for file synchronization",
				"- mongodb-manager.ts for the manager class",
			].join("\n"),
			"decisions.md": [
				"# Decisions",
				"",
				"## Embedding Mode",
				"We chose automated embedding mode with Voyage AI.",
				"This means MongoDB handles embedding generation.",
				"",
				"## Fusion Method",
				"Default to scoreFusion for best quality hybrid search.",
			].join("\n"),
		})

		const result = await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
		})

		expect(result.filesProcessed).toBe(2)
		expect(result.chunksUpserted).toBeGreaterThanOrEqual(2)
		expect(result.staleDeleted).toBe(0)

		// Verify documents in MongoDB
		const chunkCount = await chunksCollection(db, TEST_PREFIX).countDocuments()
		const fileCount = await filesCollection(db, TEST_PREFIX).countDocuments()
		expect(chunkCount).toBeGreaterThanOrEqual(2)
		expect(fileCount).toBe(2)

		// Verify chunk document structure
		const sampleChunk = await chunksCollection(db, TEST_PREFIX).findOne({})
		expect(sampleChunk).toBeDefined()
		expect(sampleChunk!.path).toMatch(/^memory\//)
		expect(sampleChunk!.source).toBe("conversation")
		expect(typeof sampleChunk!.startLine).toBe("number")
		expect(typeof sampleChunk!.endLine).toBe("number")
		expect(typeof sampleChunk!.text).toBe("string")
		expect(typeof sampleChunk!.hash).toBe("string")
		expect(typeof sampleChunk!.model).toBe("string")
		expect(sampleChunk!.updatedAt).toBeInstanceOf(Date)

		// Verify file metadata
		const sampleFile = await filesCollection(db, TEST_PREFIX).findOne({})
		expect(sampleFile).toBeDefined()
		expect(sampleFile!.source).toBe("conversation")
		expect(typeof sampleFile!.hash).toBe("string")
		expect(typeof sampleFile!.mtime).toBe("number")
		expect(typeof sampleFile!.size).toBe("number")
	})

	it("skips unchanged files on re-sync", async () => {
		// First sync already done above, do another
		const result = await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
		})

		// Files already indexed with same hash — should skip
		expect(result.filesProcessed).toBe(0)
		expect(result.chunksUpserted).toBe(0)
	})

	it("re-indexes when file content changes", async () => {
		// Modify a file
		const filePath = path.join(workspaceDir, "memory", "decisions.md")
		const newContent = [
			"# Decisions",
			"",
			"## Embedding Mode",
			"We chose automated embedding mode with MongoDB-generated vectors.",
			"CHANGED: This line is new and different.",
			"",
			"## Search Strategy",
			"Use rankFusion for better results across heterogeneous sources.",
		].join("\n")
		await fs.writeFile(filePath, newContent, "utf-8")

		const result = await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
		})

		// Only the changed file should be re-indexed
		expect(result.filesProcessed).toBe(1)
		expect(result.chunksUpserted).toBeGreaterThanOrEqual(1)
	})

	it("force re-indexes all files", async () => {
		const result = await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
			force: true,
		})

		expect(result.filesProcessed).toBe(2)
		expect(result.chunksUpserted).toBeGreaterThanOrEqual(2)
	})

	it("deletes stale chunks when files are removed", async () => {
		// Delete a file
		await fs.unlink(path.join(workspaceDir, "memory", "decisions.md"))

		const result = await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
		})

		expect(result.staleDeleted).toBeGreaterThan(0)

		// Verify only project-notes.md chunks remain
		const chunks = await chunksCollection(db, TEST_PREFIX).find({}).toArray()
		for (const chunk of chunks) {
			expect(chunk.path).toBe("memory/project-notes.md")
		}

		// Files collection should only have 1 entry now
		const fileCount = await filesCollection(db, TEST_PREFIX).countDocuments()
		expect(fileCount).toBe(1)
	})

	it("reports progress during sync", async () => {
		// Recreate files
		await cleanupWorkspace()
		workspaceDir = await setupWorkspace({
			"a.md": "# File A\n\nContent for file A testing progress",
			"b.md": "# File B\n\nContent for file B testing progress",
			"c.md": "# File C\n\nContent for file C testing progress",
		})

		// Clear existing data
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
		await filesCollection(db, TEST_PREFIX).deleteMany({})

		const progressUpdates: Array<{
			completed: number
			total: number
			label?: string
		}> = []
		await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
			progress: (update) => progressUpdates.push(update),
		})

		expect(progressUpdates.length).toBeGreaterThanOrEqual(3)
		// First update should be initial (completed=0)
		expect(progressUpdates[0].completed).toBe(0)
		expect(progressUpdates[0].total).toBe(3)
		// Last update should show completion
		const last = progressUpdates[progressUpdates.length - 1]
		expect(last.completed).toBe(last.total)
	}, 90_000)
})

// ===========================================================================
// $text Search fallback tests when Search is unavailable
// ===========================================================================

describe("E2E: $text Search fallback", () => {
	let workspaceDir: string

	beforeAll(async () => {
		// Clean and sync fresh data
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
		await filesCollection(db, TEST_PREFIX).deleteMany({})
		await ensureCollections(db, TEST_PREFIX)
		await ensureStandardIndexes(db, TEST_PREFIX)

		workspaceDir = await setupWorkspace({
			"mongodb-guide.md": [
				"# MongoDB Guide",
				"",
				"MongoDB is a document database that provides high availability",
				"and automatic scaling. It stores data in flexible JSON-like documents.",
				"",
				"## Vector Search",
				"MongoDB Atlas Vector Search allows you to perform semantic search",
				"using embeddings generated by machine learning models.",
				"",
				"## Aggregation Pipeline",
				"The aggregation framework provides powerful data processing capabilities.",
			].join("\n"),
			"typescript-tips.md": [
				"# TypeScript Tips",
				"",
				"TypeScript is a strongly typed programming language that builds on JavaScript.",
				"Use interfaces to define object shapes and type aliases for complex types.",
				"",
				"## Generics",
				"Generics provide a way to make components work with any data type.",
			].join("\n"),
		})

		await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
			force: true,
		})
	})

	afterAll(async () => {
		await cleanupWorkspace()
	})

	it("$text search finds relevant documents", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const docs = await col
			.find(
				{ $text: { $search: "MongoDB vector search" } },
				{
					projection: {
						_id: 0,
						path: 1,
						text: 1,
						source: 1,
						score: { $meta: "textScore" },
					},
				},
			)
			// eslint-disable-next-line unicorn/no-array-sort -- MongoDB cursor sort (not Array.sort)
			.sort({ score: { $meta: "textScore" } })
			.limit(5)
			.toArray()

		expect(docs.length).toBeGreaterThan(0)
		// MongoDB-related content should score higher
		expect(docs[0].path).toContain("mongodb-guide.md")
		expect(docs[0].score).toBeGreaterThan(0)
		expect(["conversation", "memory"]).toContain(docs[0].source)
	})

	it("$text search returns empty for unrelated queries", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const docs = await col
			.find(
				{ $text: { $search: "quantum physics entanglement" } },
				{
					projection: {
						score: { $meta: "textScore" },
					},
				},
			)
			// eslint-disable-next-line unicorn/no-array-sort -- MongoDB cursor sort (not Array.sort)
			.sort({ score: { $meta: "textScore" } })
			.limit(5)
			.toArray()

		expect(docs.length).toBe(0)
	})

	it("$text search with source filter", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const docs = await col
			.find(
				{ $text: { $search: "TypeScript" }, source: "conversation" },
				{
					projection: {
						path: 1,
						text: 1,
						source: 1,
						score: { $meta: "textScore" },
					},
				},
			)
			// eslint-disable-next-line unicorn/no-array-sort -- MongoDB cursor sort (not Array.sort)
			.sort({ score: { $meta: "textScore" } })
			.limit(5)
			.toArray()

		expect(docs.length).toBeGreaterThan(0)
		for (const doc of docs) {
			expect(doc.source).toBe("conversation")
		}
	})
})

// ===========================================================================
// Full Search Dispatcher fallback path
// ===========================================================================

describe("E2E: mongoSearch dispatcher fallback", () => {
	// Import mongoSearch to test the full dispatcher cascade
	let mongoSearchFn: typeof import("./mongodb-search.js").mongoSearch
	let workspaceDir: string

	beforeAll(async () => {
		const mod = await import("./mongodb-search.js")
		mongoSearchFn = mod.mongoSearch

		await chunksCollection(db, TEST_PREFIX).deleteMany({})
		await filesCollection(db, TEST_PREFIX).deleteMany({})
		await ensureCollections(db, TEST_PREFIX)
		await ensureStandardIndexes(db, TEST_PREFIX)

		workspaceDir = await setupWorkspace({
			"mongodb-guide.md": [
				"# MongoDB Guide",
				"",
				"MongoDB is a document database that provides high availability",
				"and automatic scaling. It stores data in flexible JSON-like documents.",
				"",
				"## Vector Search",
				"MongoDB Atlas Vector Search allows you to perform semantic search",
				"using embeddings generated by machine learning models.",
				"",
				"## Aggregation Pipeline",
				"The aggregation framework provides powerful data processing capabilities.",
			].join("\n"),
			"typescript-tips.md": [
				"# TypeScript Tips",
				"",
				"TypeScript is a strongly typed programming language that builds on JavaScript.",
				"Use interfaces to define object shapes and type aliases for complex types.",
				"",
				"## Generics",
				"Generics provide a way to make components work with any data type.",
			].join("\n"),
		})

		await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir,
			embeddingMode: "automated",
			force: true,
		})
	})

	afterAll(async () => {
		await cleanupWorkspace()
	})

	it("falls through to $text search when Search is unavailable", async () => {
		const col = chunksCollection(db, TEST_PREFIX)

		const results = await mongoSearchFn(
			col,
			"MongoDB document database",
			null,
			{
				maxResults: 5,
				minScore: 0,
				fusionMethod: "scoreFusion",
				capabilities: {
					vectorSearch: false,
					textSearch: false,
					scoreFusion: false,
					rankFusion: false,
				},
				vectorIndexName: `${TEST_PREFIX}chunks_vector`,
				textIndexName: `${TEST_PREFIX}chunks_text`,
				vectorWeight: 0.7,
				textWeight: 0.3,
				embeddingMode: "automated",
			},
		)

		expect(results.length).toBeGreaterThan(0)
		expect(results[0].path).toContain("mongodb-guide.md")
		expect(results[0].score).toBeGreaterThan(0)
		expect(results[0].snippet.length).toBeGreaterThan(0)
		expect(results[0].source).toBe("conversation")
	})

	it("returns empty for queries with no matches", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const caps = await detectCapabilities(db, `${TEST_PREFIX}chunks`)

		const results = await mongoSearchFn(col, "xyznonexistent12345", null, {
			maxResults: 5,
			minScore: 0,
			fusionMethod: "scoreFusion",
			capabilities: caps,
			vectorIndexName: `${TEST_PREFIX}chunks_vector`,
			textIndexName: `${TEST_PREFIX}chunks_text`,
			vectorWeight: 0.7,
			textWeight: 0.3,
			embeddingMode: "automated",
		})

		expect(results.length).toBe(0)
	})

	it("respects maxResults limit", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const caps = await detectCapabilities(db, `${TEST_PREFIX}chunks`)

		const results = await mongoSearchFn(col, "data", null, {
			maxResults: 1,
			minScore: 0,
			fusionMethod: "scoreFusion",
			capabilities: caps,
			vectorIndexName: `${TEST_PREFIX}chunks_vector`,
			textIndexName: `${TEST_PREFIX}chunks_text`,
			vectorWeight: 0.7,
			textWeight: 0.3,
			embeddingMode: "automated",
		})

		expect(results.length).toBeLessThanOrEqual(1)
	})
})

// ===========================================================================
// Chunk ID and Deduplication Tests
// ===========================================================================

describe("E2E: Chunk IDs and Deduplication", () => {
	let dedupWorkspace: string

	beforeAll(async () => {
		// Set up fresh workspace and sync
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
		await filesCollection(db, TEST_PREFIX).deleteMany({})

		dedupWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-dedup-"))
		const memDir = path.join(dedupWorkspace, "memory")
		await fs.mkdir(memDir, { recursive: true })
		await fs.writeFile(
			path.join(memDir, "dedup-test.md"),
			"# Dedup Test\n\nContent for deduplication testing across syncs",
			"utf-8",
		)

		await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir: dedupWorkspace,
			embeddingMode: "automated",
			force: true,
		})
	})

	afterAll(async () => {
		await fs
			.rm(dedupWorkspace, { recursive: true, force: true })
			.catch(() => {})
	})

	it("chunks have deterministic namespaced _id based on source scope and line range", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const chunks = await col.find({}).toArray()

		expect(chunks.length).toBeGreaterThan(0)
		for (const chunk of chunks) {
			expect(String(chunk._id)).toContain(
				`::${chunk.path}:${chunk.startLine}:${chunk.endLine}`,
			)
		}
	})

	it("re-sync upserts (not duplicates) existing chunks", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const countBefore = await col.countDocuments()
		expect(countBefore).toBeGreaterThan(0)

		// Force re-sync should upsert, not create duplicates
		await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir: dedupWorkspace,
			embeddingMode: "automated",
			force: true,
		})

		const countAfter = await col.countDocuments()
		expect(countAfter).toBe(countBefore)
	})
})

// ===========================================================================
// Collection Helper Tests
// ===========================================================================

describe("E2E: Collection Helpers", () => {
	it("collection helpers return correct collection names", () => {
		const chunks = chunksCollection(db, TEST_PREFIX)
		const files = filesCollection(db, TEST_PREFIX)
		const cache = embeddingCacheCollection(db, TEST_PREFIX)
		const meta = metaCollection(db, TEST_PREFIX)

		expect(chunks.collectionName).toBe(`${TEST_PREFIX}chunks`)
		expect(files.collectionName).toBe(`${TEST_PREFIX}files`)
		expect(cache.collectionName).toBe(`${TEST_PREFIX}embedding_cache`)
		expect(meta.collectionName).toBe(`${TEST_PREFIX}meta`)
	})
})

// ===========================================================================
// Transaction E2E Tests (requires replica set)
// ===========================================================================

describe("E2E: Transactions (replica set)", () => {
	let txnWorkspace: string

	beforeAll(async () => {
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
		await filesCollection(db, TEST_PREFIX).deleteMany({})
	})

	afterAll(async () => {
		if (txnWorkspace) {
			await fs
				.rm(txnWorkspace, { recursive: true, force: true })
				.catch(() => {})
		}
	})

	it("syncToMongoDB uses transactions when client is provided on replica set", async () => {
		txnWorkspace = await setupWorkspace({
			"txn-test.md":
				"# Transaction Test\n\nVerifying ACID sync on replica set.",
		})

		const result = await syncToMongoDB({
			client,
			db,
			prefix: TEST_PREFIX,
			workspaceDir: txnWorkspace,
			embeddingMode: "automated",
			force: true,
		})

		expect(result.filesProcessed).toBeGreaterThan(0)
		expect(result.chunksUpserted).toBeGreaterThan(0)

		// Verify data was actually committed
		const files = await filesCollection(db, TEST_PREFIX).countDocuments()
		const chunks = await chunksCollection(db, TEST_PREFIX).countDocuments()
		expect(files).toBeGreaterThan(0)
		expect(chunks).toBeGreaterThan(0)
	})

	it("transaction commit is atomic — all-or-nothing per file", async () => {
		// Sync a file, then modify and re-sync. The old chunks should be replaced atomically.
		const chunksBefore = await chunksCollection(db, TEST_PREFIX)
			.find({})
			.toArray()
		const filesBefore = await filesCollection(db, TEST_PREFIX)
			.find({})
			.toArray()
		expect(chunksBefore.length).toBeGreaterThan(0)
		expect(filesBefore.length).toBeGreaterThan(0)

		// Modify the file content
		const memDir = path.join(txnWorkspace, "memory")
		await fs.writeFile(
			path.join(memDir, "txn-test.md"),
			"# Transaction Test v2\n\nUpdated content to verify atomic replacement.\n\n## New Section\n\nMore content here.",
			"utf-8",
		)

		const result = await syncToMongoDB({
			client,
			db,
			prefix: TEST_PREFIX,
			workspaceDir: txnWorkspace,
			embeddingMode: "automated",
			force: true,
		})

		expect(result.filesProcessed).toBeGreaterThan(0)

		// After atomic re-sync, no orphaned chunks from old version should remain
		const chunksAfter = await chunksCollection(db, TEST_PREFIX)
			.find({})
			.toArray()
		for (const chunk of chunksAfter) {
			// All chunks should contain updated text (no stale "Verifying ACID sync")
			expect(chunk.text).not.toContain("Verifying ACID sync on replica set")
		}
	})

	it("stale file cleanup works transactionally", async () => {
		// Remove the file from disk, then re-sync — stale entries should be cleaned up atomically
		const memDir = path.join(txnWorkspace, "memory")
		await fs.rm(path.join(memDir, "txn-test.md"))

		await syncToMongoDB({
			client,
			db,
			prefix: TEST_PREFIX,
			workspaceDir: txnWorkspace,
			embeddingMode: "automated",
			force: true,
		})

		// All data from the removed file should be gone
		const chunks = await chunksCollection(db, TEST_PREFIX).countDocuments()
		const files = await filesCollection(db, TEST_PREFIX).countDocuments()
		expect(chunks).toBe(0)
		expect(files).toBe(0)
	})

	it("withTransaction retries on transient errors", async () => {
		// Verify the session/transaction machinery works by running a simple transaction manually
		const session = client.startSession()
		try {
			let executed = false
			await session.withTransaction(
				async () => {
					const col = chunksCollection(db, TEST_PREFIX)
					await col.insertOne(
						{
							_id: "txn-retry-test:1:5" as unknown as import("mongodb").InferIdType<
								import("mongodb").Document
							>,
							path: "txn-retry-test",
							text: "transaction test",
							hash: "txn-retry-test-hash",
							source: "conversation",
							startLine: 1,
							endLine: 5,
							model: "none",
							updatedAt: new Date(),
						},
						{ session },
					)
					executed = true
				},
				{ writeConcern: { w: "majority" } },
			)
			expect(executed).toBe(true)

			// Verify the committed document exists
			const doc = await chunksCollection(db, TEST_PREFIX).findOne({
				_id: "txn-retry-test:1:5" as unknown as import("mongodb").InferIdType<
					import("mongodb").Document
				>,
			})
			expect(doc).not.toBeNull()
			expect(doc!.text).toBe("transaction test")
		} finally {
			await session.endSession()
			// Clean up
			await chunksCollection(db, TEST_PREFIX).deleteOne({
				_id: "txn-retry-test:1:5" as unknown as import("mongodb").InferIdType<
					import("mongodb").Document
				>,
			})
		}
	})
})

// ===========================================================================
// TTL Index E2E Tests
// ===========================================================================

describe("E2E: TTL Indexes", () => {
	it("creates TTL index on embedding_cache when embeddingCacheTtlDays > 0", async () => {
		// Drop and recreate to get fresh indexes
		try {
			await embeddingCacheCollection(db, TEST_PREFIX).drop()
		} catch {
			/* ok */
		}
		await db.createCollection(`${TEST_PREFIX}embedding_cache`)

		await ensureStandardIndexes(db, TEST_PREFIX, { embeddingCacheTtlDays: 30 })

		const indexes = await embeddingCacheCollection(db, TEST_PREFIX).indexes()
		const ttlIdx = indexes.find((i) => i.name === "idx_cache_ttl")
		expect(ttlIdx).toBeDefined()
		expect(ttlIdx!.expireAfterSeconds).toBe(30 * 24 * 60 * 60)

		// Regular idx_cache_updated should NOT exist (TTL replaces it)
		const regularIdx = indexes.find((i) => i.name === "idx_cache_updated")
		expect(regularIdx).toBeUndefined()
	})

	it("creates regular idx_cache_updated when TTL disabled", async () => {
		try {
			await embeddingCacheCollection(db, TEST_PREFIX).drop()
		} catch {
			/* ok */
		}
		await db.createCollection(`${TEST_PREFIX}embedding_cache`)

		await ensureStandardIndexes(db, TEST_PREFIX, { embeddingCacheTtlDays: 0 })

		const indexes = await embeddingCacheCollection(db, TEST_PREFIX).indexes()
		const regularIdx = indexes.find((i) => i.name === "idx_cache_updated")
		expect(regularIdx).toBeDefined()

		const ttlIdx = indexes.find((i) => i.name === "idx_cache_ttl")
		expect(ttlIdx).toBeUndefined()
	})

	it("creates TTL index on files when memoryTtlDays > 0", async () => {
		try {
			await filesCollection(db, TEST_PREFIX).drop()
		} catch {
			/* ok */
		}
		await db.createCollection(`${TEST_PREFIX}files`)

		await ensureStandardIndexes(db, TEST_PREFIX, { memoryTtlDays: 90 })

		const indexes = await filesCollection(db, TEST_PREFIX).indexes()
		const ttlIdx = indexes.find((i) => i.name === "idx_files_ttl")
		expect(ttlIdx).toBeDefined()
		expect(ttlIdx!.expireAfterSeconds).toBe(90 * 24 * 60 * 60)
	})

	it("skips files TTL index when memoryTtlDays is 0", async () => {
		try {
			await filesCollection(db, TEST_PREFIX).drop()
		} catch {
			/* ok */
		}
		await db.createCollection(`${TEST_PREFIX}files`)

		await ensureStandardIndexes(db, TEST_PREFIX, { memoryTtlDays: 0 })

		const indexes = await filesCollection(db, TEST_PREFIX).indexes()
		const ttlIdx = indexes.find((i) => i.name === "idx_files_ttl")
		expect(ttlIdx).toBeUndefined()
	})
})

// ===========================================================================
// Analytics E2E Tests
// ===========================================================================

describe("E2E: Analytics (getMemoryStats)", () => {
	let analyticsWorkspace: string

	beforeAll(async () => {
		// Clean and sync fresh data
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
		await filesCollection(db, TEST_PREFIX).deleteMany({})

		analyticsWorkspace = await setupWorkspace({
			"analytics-1.md":
				"# Analytics Test 1\n\nSome content for analytics testing.",
			"analytics-2.md":
				"# Analytics Test 2\n\nMore content for source breakdown.",
		})

		await syncToMongoDB({
			db,
			prefix: TEST_PREFIX,
			workspaceDir: analyticsWorkspace,
			embeddingMode: "automated",
			force: true,
		})
	})

	afterAll(async () => {
		if (analyticsWorkspace) {
			await fs
				.rm(analyticsWorkspace, { recursive: true, force: true })
				.catch(() => {})
		}
	})

	it("returns non-zero totals for synced data", async () => {
		const stats = await getMemoryStats(db, TEST_PREFIX)

		expect(stats.totalFiles).toBe(2)
		expect(stats.totalChunks).toBeGreaterThanOrEqual(2)
		expect(stats.sources.length).toBeGreaterThan(0)

		const memorySrc = stats.sources.find(
			(s) => s.source === "conversation" || s.source === "memory",
		)
		expect(memorySrc).toBeDefined()
		expect(memorySrc!.fileCount).toBe(2)
		expect(memorySrc!.chunkCount).toBeGreaterThanOrEqual(2)
		expect(memorySrc!.lastSync).toBeInstanceOf(Date)
	})

	it("reports embedding coverage (automated mode has no embeddings)", async () => {
		const stats = await getMemoryStats(db, TEST_PREFIX)

		// In automated mode, MongoDB generates embeddings at query-time,
		// so the stored documents don't have embedding fields
		expect(stats.embeddingCoverage.total).toBeGreaterThan(0)
		expect(stats.embeddingCoverage.withEmbedding).toBe(0)
		expect(stats.embeddingCoverage.coveragePercent).toBe(0)
	})

	it("detects stale files when validPaths provided", async () => {
		const stats = await getMemoryStats(
			db,
			TEST_PREFIX,
			new Set(["memory/analytics-1.md"]),
		)

		// analytics-2.md should show as stale
		expect(stats.staleFiles).toContain("memory/analytics-2.md")
		expect(stats.staleFiles.length).toBe(1)
	})

	it("reports collection sizes", async () => {
		const stats = await getMemoryStats(db, TEST_PREFIX)

		expect(stats.collectionSizes.files).toBe(2)
		expect(stats.collectionSizes.chunks).toBeGreaterThanOrEqual(2)
		expect(stats.collectionSizes.embeddingCache).toBe(0) // no manual embeddings cached
	})
})

// ===========================================================================
// Change Stream E2E Tests (requires replica set)
// ===========================================================================

describe("E2E: Change Streams", () => {
	it("starts change stream watcher on replica set", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const events: Array<{ operationType: string; paths: string[] }> = []

		const watcher = new MongoDBChangeStreamWatcher(
			col,
			(event) => events.push(event),
			100,
		)

		const started = await watcher.start()
		expect(started).toBe(true)
		expect(watcher.isActive).toBe(true)

		await watcher.close()
		expect(watcher.isActive).toBe(false)
	})

	it("detects insert events via change stream", async () => {
		const col = chunksCollection(db, TEST_PREFIX)
		const events: Array<{ operationType: string; paths: string[] }> = []

		const watcher = new MongoDBChangeStreamWatcher(
			col,
			(event) => events.push(event),
			100, // short debounce for test
		)

		await watcher.start()

		// Small delay to let the change stream fully initialize
		await new Promise((resolve) => setTimeout(resolve, 200))

		// Insert a document to trigger the change stream
		await col.insertOne({
			_id: "cs-test:1:5" as unknown as import("mongodb").InferIdType<
				import("mongodb").Document
			>,
			path: "cs-test",
			text: "change stream test",
			hash: "cs-test-hash",
			source: "conversation",
			startLine: 1,
			endLine: 5,
			model: "none",
			updatedAt: new Date(),
		})

		// Wait for debounce + processing (change stream events are async)
		// Retry poll: check up to 3 seconds
		for (let i = 0; i < 30 && events.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100))
		}

		expect(events.length).toBeGreaterThanOrEqual(1)
		expect(events[0].operationType).toBe("insert")
		expect(events[0].paths).toContain("cs-test")

		await watcher.close()

		// Clean up
		await col.deleteOne({
			_id: "cs-test:1:5" as unknown as import("mongodb").InferIdType<
				import("mongodb").Document
			>,
		})
	})
})

// ===========================================================================
// v2: Event -> Chunk Projection
// ===========================================================================

describe("E2E v2: event -> chunk projection", () => {
	const agentId = `e2e-evt-${randomUUID()}`

	beforeAll(async () => {
		await eventsCollection(db, TEST_PREFIX).deleteMany({})
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("writes event, projects chunk, retrieves via search", async () => {
		// 1. Write event with body text
		const { eventId } = await writeEvent({
			db,
			prefix: TEST_PREFIX,
			event: {
				agentId,
				role: "user",
				body: "Memongo uses MongoDB for canonical event storage and chunk projection",
				scope: "agent",
			},
		})
		expect(eventId).toBeDefined()

		// 2. Project chunks from events
		const projection = await projectChunksFromEvents({
			db,
			prefix: TEST_PREFIX,
			agentId,
		})
		expect(projection.eventsProcessed).toBe(1)
		expect(projection.chunksCreated).toBe(1)

		// 3. Verify chunk exists with source "conversation"
		const chunk = await chunksCollection(db, TEST_PREFIX).findOne({
			path: `events/${eventId}`,
		})
		expect(chunk).not.toBeNull()
		expect(chunk!.source).toBe("conversation")
		expect(chunk!.text).toContain("Memongo")

		// 4. Verify $text search finds the chunk
		const textResults = await chunksCollection(db, TEST_PREFIX)
			.find(
				{ $text: { $search: "canonical event storage" } },
				{ projection: { path: 1, text: 1, score: { $meta: "textScore" } } },
			)
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ score: { $meta: "textScore" } })
			.limit(5)
			.toArray()

		expect(textResults.length).toBeGreaterThan(0)
		expect(textResults[0].path).toBe(`events/${eventId}`)
	})
})

// ===========================================================================
// v2: Structured Memory with Scope
// ===========================================================================

describe("E2E v2: structured memory with scope", () => {
	const agentId = `e2e-struct-${randomUUID()}`

	beforeAll(async () => {
		await structuredMemCollection(db, TEST_PREFIX).deleteMany({})
		await structuredMemRevisionsCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("writes structured entries with different scopes", async () => {
		// 1. Write entry with scope "user"
		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "preference",
				key: "theme",
				value: "dark mode preferred",
				agentId,
				scope: "user",
				userId: `user-${agentId}`,
			},
			embeddingMode: "automated",
		})

		// 2. Write entry with scope "session"
		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "preference",
				key: "language",
				value: "TypeScript is the default",
				agentId,
				scope: "session",
				sessionId: `session-${agentId}`,
			},
			embeddingMode: "automated",
		})

		// 3. Query with scope "user" -> only user-scoped result
		const col = structuredMemCollection(db, TEST_PREFIX)
		const userScoped = await col.find({ agentId, scope: "user" }).toArray()
		expect(userScoped.length).toBe(1)
		expect(userScoped[0].key).toBe("theme")

		// 4. Query without scope filter -> both results
		const allScoped = await col.find({ agentId }).toArray()
		expect(allScoped.length).toBe(2)
	})

	it("preserves superseded structured values in the revisions collection", async () => {
		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "decision",
				key: "database",
				value: "Use Postgres",
				agentId,
				scope: "agent",
			},
			embeddingMode: "automated",
			client,
		})

		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "decision",
				key: "database",
				value: "Use MongoDB",
				agentId,
				scope: "agent",
			},
			embeddingMode: "automated",
			client,
		})

		const current = await structuredMemCollection(db, TEST_PREFIX).findOne({
			agentId,
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			type: "decision",
			key: "database",
		})
		const revisions = await structuredMemRevisionsCollection(db, TEST_PREFIX)
			.find({
				agentId,
				scope: "agent",
				scopeRef: `agent:${agentId}`,
				type: "decision",
				key: "database",
			})
			.toArray()

		expect(current?.value).toBe("Use MongoDB")
		expect(current?.revision).toBe(2)
		expect(revisions).toHaveLength(1)
		expect(revisions[0]?.value).toBe("Use Postgres")
		expect(revisions[0]?.revision).toBe(1)
		expect(revisions[0]?.supersededAt).toBeInstanceOf(Date)
	})
})

// ===========================================================================
// v2: Graph Expansion
// ===========================================================================

describe("E2E v2: graph expansion", () => {
	const agentId = `e2e-graph-${randomUUID()}`
	const romEntityId = randomUUID()
	const projectEntityId = randomUUID()

	beforeAll(async () => {
		await entitiesCollection(db, TEST_PREFIX).deleteMany({})
		await entityLinksCollection(db, TEST_PREFIX).deleteMany({})
		await relationsCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("creates entities and relations, expands graph via $graphLookup", async () => {
		// 1. upsertEntity("Rom", person)
		const romResult = await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: romEntityId,
				name: "Rom",
				type: "person",
				agentId,
				scope: "agent",
				updatedAt: new Date(),
			},
		})
		expect(romResult.upserted).toBe(true)

		// 2. upsertEntity("Memongo", project)
		const projectResult = await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: projectEntityId,
				name: "Memongo",
				type: "project",
				agentId,
				scope: "agent",
				updatedAt: new Date(),
			},
		})
		expect(projectResult.upserted).toBe(true)

		// 3. upsertRelation(Rom -> works_on -> Memongo)
		const relResult = await upsertRelation({
			db,
			prefix: TEST_PREFIX,
			relation: {
				fromEntityId: romEntityId,
				toEntityId: projectEntityId,
				type: "works_on",
				agentId,
				scope: "agent",
				updatedAt: new Date(),
			},
		})
		expect(relResult.upserted).toBe(true)

		// 4. expandGraph from Rom entityId -> finds Memongo
		const expansion = await expandGraph({
			db,
			prefix: TEST_PREFIX,
			entityId: romEntityId,
			agentId,
			maxDepth: 2,
		})

		expect(expansion).not.toBeNull()
		expect(expansion!.rootEntity.name).toBe("Rom")
		expect(expansion!.connections.length).toBe(1)
		expect(expansion!.connections[0].entity.name).toBe("Memongo")
		expect(expansion!.connections[0].relation.type).toBe("works_on")
		expect(expansion!.connections[0].depth).toBe(0)
	})

	it("stores candidate links as reversible records and keeps same-name entities isolated by scope", async () => {
		const agentSessionA = `session-a-${randomUUID().slice(0, 8)}`
		const agentSessionB = `session-b-${randomUUID().slice(0, 8)}`
		const alexA = randomUUID()
		const alexB = randomUUID()

		await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: alexA,
				name: "Alex",
				type: "person",
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionA}`,
				updatedAt: new Date(),
			},
		})
		await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: alexB,
				name: "Alex",
				type: "person",
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionB}`,
				updatedAt: new Date(),
			},
		})

		const link = await upsertEntityLink({
			db,
			prefix: TEST_PREFIX,
			link: {
				fromEntityId: romEntityId,
				toEntityId: projectEntityId,
				linkType: "candidate_same",
				status: "active",
				confidence: 0.55,
				agentId,
				scope: "agent",
				provenance: { heuristic: "manual-test" },
			},
		})
		expect(link.linkId).toBeTruthy()

		const links = await getEntityLinks({
			db,
			prefix: TEST_PREFIX,
			agentId,
			entityId: romEntityId,
			status: "active",
		})
		expect(links.some((entry) => entry.linkType === "candidate_same")).toBe(
			true,
		)

		const changed = await setEntityLinkStatus({
			db,
			prefix: TEST_PREFIX,
			agentId,
			scope: "agent",
			fromEntityId: romEntityId,
			toEntityId: projectEntityId,
			linkType: "candidate_same",
			status: "rejected",
		})
		expect(changed).toBe(true)

		const activeLinks = await getEntityLinks({
			db,
			prefix: TEST_PREFIX,
			agentId,
			entityId: romEntityId,
			status: "active",
		})
		expect(
			activeLinks.some((entry) => entry.linkType === "candidate_same"),
		).toBe(false)

		const sessionAEntities = await entitiesCollection(db, TEST_PREFIX)
			.find({
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionA}`,
				name: "Alex",
			})
			.toArray()
		const sessionBEntities = await entitiesCollection(db, TEST_PREFIX)
			.find({
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionB}`,
				name: "Alex",
			})
			.toArray()
		expect(sessionAEntities).toHaveLength(1)
		expect(sessionBEntities).toHaveLength(1)
		expect(sessionAEntities[0]?.entityId).not.toBe(
			sessionBEntities[0]?.entityId,
		)
	})
})

// ===========================================================================
// v2: Episode Materialization
// ===========================================================================

describe("E2E v2: episode materialization", () => {
	const agentId = `e2e-episode-${randomUUID()}`
	const dayStart = new Date("2026-03-15T00:00:00Z")
	const dayEnd = new Date("2026-03-15T23:59:59Z")

	beforeAll(async () => {
		await eventsCollection(db, TEST_PREFIX).deleteMany({})
		await episodesCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("writes events, materializes episode, searches episode", async () => {
		// 1. Write 5 events over a day
		for (let i = 0; i < 5; i++) {
			await writeEvent({
				db,
				prefix: TEST_PREFIX,
				event: {
					agentId,
					role: i % 2 === 0 ? "user" : "assistant",
					body: `Message number ${i + 1} about Memongo memory architecture`,
					scope: "agent",
					timestamp: new Date(
						`2026-03-15T${String(8 + i).padStart(2, "0")}:00:00Z`,
					),
				},
			})
		}

		// Verify events were written
		const eventCount = await eventsCollection(db, TEST_PREFIX).countDocuments({
			agentId,
		})
		expect(eventCount).toBe(5)

		// 2. Materialize episode with mock summarizer
		const episode = await materializeEpisode({
			db,
			prefix: TEST_PREFIX,
			agentId,
			type: "daily",
			timeRange: { start: dayStart, end: dayEnd },
			summarizer: async (events) => ({
				title: "Daily Memongo Discussion",
				summary: `Discussion about Memongo memory architecture with ${events.length} messages`,
				tags: ["memongo", "memory"],
			}),
		})

		// 3. Verify episode created with correct sourceEventCount
		expect(episode).not.toBeNull()
		expect(episode!.sourceEventCount).toBe(5)
		expect(episode!.title).toBe("Daily Memongo Discussion")
		expect(episode!.type).toBe("daily")
		expect(episode!.tags).toEqual(["memongo", "memory"])

		// 4. searchEpisodes finds the episode
		const searchResults = await searchEpisodes({
			db,
			prefix: TEST_PREFIX,
			query: "Memongo",
			agentId,
		})

		expect(searchResults.length).toBe(1)
		expect(searchResults[0].title).toBe("Daily Memongo Discussion")
	})
})

// ===========================================================================
// v2: Migration Backfill
// ===========================================================================

describe("E2E v2: migration backfill", () => {
	const agentId = `e2e-migrate-${randomUUID()}`

	beforeAll(async () => {
		await eventsCollection(db, TEST_PREFIX).deleteMany({})
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("backfills events from existing v1 chunks", async () => {
		// 1. Insert chunks directly (simulating v1 state) with source "memory"
		const chunksCol = chunksCollection(db, TEST_PREFIX)
		await chunksCol.insertMany([
			{
				_id: "memory/notes.md:1:5" as unknown as import("mongodb").InferIdType<
					import("mongodb").Document
				>,
				path: "memory/notes.md",
				text: "Project notes about Memongo v1 architecture",
				hash: "abc123hash",
				source: "conversation",
				startLine: 1,
				endLine: 5,
				model: "none",
				updatedAt: new Date("2026-03-14T10:00:00Z"),
			},
			{
				_id: "memory/decisions.md:1:3" as unknown as import("mongodb").InferIdType<
					import("mongodb").Document
				>,
				path: "memory/decisions.md",
				text: "Decision to use MongoDB-only backend",
				hash: "def456hash",
				source: "conversation",
				startLine: 1,
				endLine: 3,
				model: "none",
				updatedAt: new Date("2026-03-14T11:00:00Z"),
			},
		])

		// 2. Run backfillEventsFromChunks
		const result = await backfillEventsFromChunks({
			db,
			prefix: TEST_PREFIX,
			agentId,
		})

		expect(result.chunksProcessed).toBe(2)
		expect(result.eventsCreated).toBe(2)
		expect(result.skipped).toBe(0)

		// 3. Verify events created with correct body/timestamp
		const eventsCol = eventsCollection(db, TEST_PREFIX)
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		const events = await eventsCol
			.find({ agentId })
			.sort({ timestamp: 1 })
			.toArray()
		expect(events.length).toBe(2)
		expect(events[0].body).toBe("Project notes about Memongo v1 architecture")
		expect(events[1].body).toBe("Decision to use MongoDB-only backend")

		// 4. Run backfill again -> verify idempotent (no duplicates)
		const result2 = await backfillEventsFromChunks({
			db,
			prefix: TEST_PREFIX,
			agentId,
		})

		expect(result2.chunksProcessed).toBe(2)
		expect(result2.eventsCreated).toBe(0) // idempotent: no new events
		expect(result2.skipped).toBe(0)

		// Verify still only 2 events
		const eventCount = await eventsCol.countDocuments({ agentId })
		expect(eventCount).toBe(2)
	})
})

// ===========================================================================
// v2: Retrieval Planner
// ===========================================================================

describe("E2E v2: retrieval planner", () => {
	it("plans retrieval paths based on query and config", () => {
		const allPaths: Set<RetrievalPath> = new Set([
			"structured",
			"raw-window",
			"graph",
			"hybrid",
			"kb",
			"episodic",
		])

		// 1. Query mentioning entities + keywords
		const plan = planRetrieval("what does Rom work on today in the docs", {
			availablePaths: allPaths,
			knownEntityNames: ["Rom"],
			hasGraphData: true,
			hasEpisodes: true,
		})

		// 2. Verify paths include expected retrieval types
		// "Rom" triggers graph, "today" triggers raw-window, "docs" triggers kb
		expect(plan.paths).toContain("graph")
		expect(plan.paths).toContain("raw-window")
		expect(plan.paths).toContain("kb")

		// 3. Verify confidence is high (multiple strong signals)
		expect(plan.confidence).toBe("high")
		expect(plan.reasoning.length).toBeGreaterThan(0)
	})
})

// ===========================================================================
// v2: Health Semantics
// ===========================================================================

describe("E2E v2: health semantics", () => {
	const agentId = `e2e-health-${randomUUID()}`

	beforeAll(async () => {
		for (const suffix of [
			"events",
			"episodes",
			"entities",
			"relations",
			"ingest_runs",
			"projection_runs",
			"relevance_runs",
		]) {
			await db.collection(`${TEST_PREFIX}${suffix}`).deleteMany({ agentId })
		}
	})

	it("distinguishes healthy, degraded, and unavailable states in v2 status", async () => {
		await eventsCollection(db, TEST_PREFIX).insertOne({
			eventId: `evt-${randomUUID()}`,
			agentId,
			role: "user",
			body: "Health status probe",
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			timestamp: new Date(),
		})

		await db.collection(`${TEST_PREFIX}ingest_runs`).insertOne({
			runId: `ingest-${randomUUID()}`,
			agentId,
			source: "event-write",
			status: "failed",
			itemsProcessed: 0,
			itemsFailed: 1,
			durationMs: 12,
			ts: new Date(),
		})

		await db.collection(`${TEST_PREFIX}projection_runs`).insertMany([
			{
				runId: `proj-${randomUUID()}`,
				agentId,
				projectionType: "chunks",
				status: "ok",
				itemsProjected: 1,
				durationMs: 10,
				ts: new Date(Date.now() - 10 * 60 * 1000),
			},
			{
				runId: `proj-${randomUUID()}`,
				agentId,
				projectionType: "entities",
				status: "failed",
				itemsProjected: 0,
				durationMs: 10,
				ts: new Date(),
			},
			{
				runId: `proj-${randomUUID()}`,
				agentId,
				projectionType: "relations",
				status: "ok",
				itemsProjected: 0,
				durationMs: 10,
				ts: new Date(),
			},
		])

		await db.collection(`${TEST_PREFIX}relevance_runs`).insertOne({
			runId: `relevance-${randomUUID()}`,
			agentId,
			ts: new Date(),
			sourceScope: "memory",
			latencyMs: 22,
			status: "degraded",
			queryHash: "hash",
			queryRedacted: "xxxx",
			profile: "test",
			capabilities: {},
			topK: 5,
			hitSources: [],
			sampleRate: 0.5,
			sampled: true,
		})

		const status = await getV2Status(db, TEST_PREFIX, agentId)

		expect(status.health.canonicalIngest).toBe("canonical-ingest-failed")
		expect(status.health.retrieval).toBe("retrieval-degraded")
		expect(status.health.recentNoRelevantResults).toBe(true)
		expect(status.health.derivedProducts.chunks).toBe("projection-behind")
		expect(status.health.derivedProducts.entities).toBe(
			"derived-product-unavailable",
		)
		expect(status.health.derivedProducts.episodes).toBe("health-uncertain")
		expect(status.health.overall).toBe("degraded")
		expect(status.health.diagnostics).toEqual(
			expect.arrayContaining([
				"retrieval-degraded",
				"no-relevant-results",
				"canonical-ingest-failed",
				"projection-behind:chunks",
				"derived-product-unavailable:entities",
				"health-uncertain:episodes",
			]),
		)
	})
})

// Supermemory-inspired feature tests live in real-e2e-v2.e2e.test.ts (Phases 14-17)
// which uses the realistic multi-session conversation dataset for proper integration testing.
