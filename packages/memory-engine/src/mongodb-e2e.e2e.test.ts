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
import { writeEvent, projectChunksFromEvents } from "./mongodb-events.js"
import {
	chunksCollection,
	filesCollection,
	metaCollection,
	eventsCollection,
	ensureCollections,
	ensureStandardIndexes,
	ensureSearchIndexes,
	detectCapabilities,
} from "./mongodb-schema.js"
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
	// Added after this file was last able to run. The nightly job that would
	// have caught the drift was passing a glob vitest treats as a substring
	// filter, so it matched no files and never executed a single e2e test.
	"access_events",
	"memory_jobs",
	"memory_quarantine",
	"recall_traces",
	"session_chunks",
] as const
// P3.8: −3 retired redundant indexes (idx_chunks_path, idx_structured_agentid,
// idx_relations_agent_scope_scoperef), +3 ESR compounds, +1 relationId locator.
const EXPECTED_STANDARD_INDEX_COUNT = 91

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
		// P3.8: idx_chunks_path retired (strict prefix of idx_chunks_path_hash);
		// the ESR compound serves agent+path chunk reads.
		expect(indexNames).not.toContain("idx_chunks_path")
		expect(indexNames).toContain("idx_chunks_agent_path_startline")
		expect(indexNames).toContain("idx_chunks_path_hash")
		expect(indexNames).toContain("idx_chunks_updated")
		expect(indexNames).toContain("idx_chunks_text")

		// Verify $text index structure
		const textIdx = chunksIndexes.find((i) => i.name === "idx_chunks_text")
		expect(textIdx).toBeDefined()
		expect(textIdx?.key).toHaveProperty("_fts", "text")

		// #13: embedding_cache was removed (Atlas autoEmbed engine never
		// client-embeds), so bootstrap must not create it.
		const collections = await db
			.listCollections()
			.map((c) => c.name)
			.toArray()
		expect(collections).not.toContain(`${TEST_PREFIX}embedding_cache`)
	})

	it("ensureStandardIndexes is idempotent", async () => {
		const applied1 = await ensureStandardIndexes(db, TEST_PREFIX)
		const applied2 = await ensureStandardIndexes(db, TEST_PREFIX)
		expect(applied1).toBe(applied2)
	})

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
		const buildInfo = await db.admin().command({ buildInfo: 1 })
		const [major = 0, minor = 0] = buildInfo.versionArray as number[]

		expect(caps.rankFusion).toBe(true)
		expect(caps.scoreFusion).toBe(major > 8 || (major === 8 && minor >= 3))

		// This used to compare against "did listSearchIndexes succeed", which is
		// a weaker claim than detectCapabilities makes. Index management being
		// reachable says nothing about whether a serving index exists: an empty
		// or PENDING list cannot answer a query. Asserting the weaker premise
		// meant the test failed whenever the indexes were still building, and
		// would have passed on a deployment with no search indexes at all.
		let searchIndexes: Array<{ name?: string; queryable?: boolean }> = []
		try {
			searchIndexes = (await chunksCollection(db, TEST_PREFIX)
				.listSearchIndexes()
				.toArray()) as typeof searchIndexes
		} catch {
			searchIndexes = []
		}
		const queryable = (name: string) =>
			searchIndexes.some(
				(index) => index.name === name && index.queryable === true,
			)

		expect(caps.vectorSearch).toBe(queryable(`${TEST_PREFIX}chunks_vector`))
		expect(caps.textSearch).toBe(queryable(`${TEST_PREFIX}chunks_text`))
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
		expect(sampleChunk?.path).toMatch(/^memory\//)
		expect(sampleChunk?.source).toBe("conversation")
		expect(typeof sampleChunk?.startLine).toBe("number")
		expect(typeof sampleChunk?.endLine).toBe("number")
		expect(typeof sampleChunk?.text).toBe("string")
		expect(typeof sampleChunk?.hash).toBe("string")
		expect(typeof sampleChunk?.model).toBe("string")
		expect(sampleChunk?.updatedAt).toBeInstanceOf(Date)

		// Verify file metadata
		const sampleFile = await filesCollection(db, TEST_PREFIX).findOne({})
		expect(sampleFile).toBeDefined()
		expect(sampleFile?.source).toBe("conversation")
		expect(typeof sampleFile?.hash).toBe("string")
		expect(typeof sampleFile?.mtime).toBe("number")
		expect(typeof sampleFile?.size).toBe("number")
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
	})
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
					storedSource: false,
					vectorIndexMethod: false,
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

	it("ranks a nonsense query below a genuine match instead of inventing relevance", async () => {
		// This used to assert zero results, and only passed because autoEmbed was
		// dead on the local container: with no Voyage key mongot reports
		// "CanonicalModel: voyage-4-large not registered yet", every vector index
		// fails, the text lane runs alone, and a nonsense token matches nothing.
		// Against a cluster where the vector lane actually works, there is no such
		// thing as "no matches" for a semantic search — ANN always returns nearest
		// neighbours, and minScore 0 filters none of them.
		//
		// Measured on live Atlas 8.3.7, autoEmbed scores sit in a narrow band:
		// an exact match scored 0.50631 while unrelated docs scored 0.50381-0.50402,
		// and a nonsense query scored 0.50199-0.50217. Rank order is meaningful;
		// absolute magnitude barely is. So the contract worth pinning is ordering —
		// relevance must beat noise — not a count, and emphatically not a minScore
		// threshold, which cannot separate the two on this lane.
		const col = chunksCollection(db, TEST_PREFIX)
		const caps = await detectCapabilities(db, `${TEST_PREFIX}chunks`)
		const searchOpts = {
			maxResults: 5,
			minScore: 0,
			fusionMethod: "scoreFusion" as const,
			capabilities: caps,
			vectorIndexName: `${TEST_PREFIX}chunks_vector`,
			textIndexName: `${TEST_PREFIX}chunks_text`,
			vectorWeight: 0.7,
			textWeight: 0.3,
			embeddingMode: "automated" as const,
		}

		const nonsense = await mongoSearchFn(
			col,
			"xyznonexistent12345",
			null,
			searchOpts,
		)

		if (!caps.vectorSearch) {
			// Text-only deployment: a token present in no document matches nothing.
			expect(nonsense.length).toBe(0)
			return
		}

		const genuine = await mongoSearchFn(
			col,
			"MongoDB document database",
			null,
			searchOpts,
		)
		expect(genuine.length).toBeGreaterThan(0)
		expect(genuine[0].path).toContain("mongodb-guide.md")
		// Neighbours are expected; ranking below the genuine match is the contract.
		expect(nonsense[0]?.score ?? 0).toBeLessThan(genuine[0].score)
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
		const meta = metaCollection(db, TEST_PREFIX)

		expect(chunks.collectionName).toBe(`${TEST_PREFIX}chunks`)
		expect(files.collectionName).toBe(`${TEST_PREFIX}files`)
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
				{ writeConcern: { w: "majority", wtimeoutMS: 5000 } },
			)
			expect(executed).toBe(true)

			// Verify the committed document exists
			const doc = await chunksCollection(db, TEST_PREFIX).findOne({
				_id: "txn-retry-test:1:5" as unknown as import("mongodb").InferIdType<
					import("mongodb").Document
				>,
			})
			expect(doc).not.toBeNull()
			expect(doc?.text).toBe("transaction test")
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
		expect(ttlIdx?.expireAfterSeconds).toBe(90 * 24 * 60 * 60)
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
		expect(memorySrc?.fileCount).toBe(2)
		expect(memorySrc?.chunkCount).toBeGreaterThanOrEqual(2)
		expect(memorySrc?.lastSync).toBeInstanceOf(Date)
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
		expect(chunk?.source).toBe("conversation")
		expect(chunk?.text).toContain("Memongo")

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
