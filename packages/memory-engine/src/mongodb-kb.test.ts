/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Collection, Db } from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock the schema module before imports
vi.mock("./mongodb-schema.js", () => ({
	kbCollection: vi.fn(),
	kbChunksCollection: vi.fn(),
	queryCacheCollection: vi.fn(),
}))

import { hashText } from "./internal.js"
import {
	ingestToKB,
	ingestFilesToKB,
	listKBDocuments,
	removeKBDocument,
	getKBStats,
	type KBDocument,
} from "./mongodb-kb.js"
import {
	kbCollection,
	kbChunksCollection,
	queryCacheCollection,
} from "./mongodb-schema.js"

// Shared tenant scope for unit tests. resolveScopeRef({agentId,scope:"agent"})
// yields "agent:test-agent" — the scopeRef the KB layer filters on.
const SCOPE = { agentId: "test-agent", scope: "agent" } as const
const SCOPE_REF = "agent:test-agent"

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockKBCol(): Collection {
	const docs: Record<string, unknown>[] = []
	return {
		findOne: vi.fn(async (filter: Record<string, unknown>) => {
			return docs.find((d) => d.hash === filter.hash) ?? null
		}),
		insertOne: vi.fn(async (doc: Record<string, unknown>) => {
			// Snapshot: updateOne mutates the stored doc, and tests assert the
			// chunksComplete value as it was AT INSERT time.
			docs.push({ ...doc })
			return { insertedId: doc._id }
		}),
		updateOne: vi.fn(
			async (
				filter: Record<string, unknown>,
				update: { $set?: Record<string, unknown> },
			) => {
				const doc = docs.find((d) => d._id === filter._id)
				if (doc && update.$set) {
					Object.assign(doc, update.$set)
				}
				return { modifiedCount: doc ? 1 : 0 }
			},
		),
		deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
		find: vi.fn(() => ({
			toArray: vi.fn(async () => docs),
		})),
		countDocuments: vi.fn(async () => docs.length),
		distinct: vi.fn(async () => []),
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
	} as unknown as Collection
}

function createMockKBChunksCol(): Collection {
	return {
		bulkWrite: vi.fn(async (ops: unknown[]) => ({
			upsertedCount: ops.length,
			modifiedCount: 0,
		})),
		deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
		countDocuments: vi.fn(async () => 0),
	} as unknown as Collection
}

function mockDb(): Db {
	return {} as unknown as Db
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string
let mockKB: Collection
let mockKBChunks: Collection
let mockQueryCache: Collection

beforeEach(async () => {
	vi.clearAllMocks()
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-kb-test-"))
	mockKB = createMockKBCol()
	mockKBChunks = createMockKBChunksCol()
	mockQueryCache = {
		deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
	} as unknown as Collection
	vi.mocked(kbCollection).mockReturnValue(mockKB)
	vi.mocked(kbChunksCollection).mockReturnValue(mockKBChunks)
	vi.mocked(queryCacheCollection).mockReturnValue(mockQueryCache)
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestToKB", () => {
	it("ingests a single document and creates chunks", async () => {
		const doc: KBDocument = {
			title: "Test Doc",
			content:
				"This is test content for the knowledge base.\n\nIt has multiple paragraphs.",
			source: { type: "manual", importedBy: "agent" },
			tags: ["test"],
			category: "testing",
			hash: hashText(
				"This is test content for the knowledge base.\n\nIt has multiple paragraphs.",
			),
		}

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
		})

		expect(result.documentsProcessed).toBe(1)
		expect(result.chunksCreated).toBeGreaterThan(0)
		expect(result.skipped).toBe(0)
		expect(result.errors).toHaveLength(0)
		expect(mockKB.insertOne).toHaveBeenCalledTimes(1)
		expect(mockKBChunks.bulkWrite).toHaveBeenCalledTimes(1)
		expect(mockQueryCache.deleteMany).toHaveBeenCalledWith({
			agentId: SCOPE.agentId,
			scope: SCOPE.scope,
			scopeRef: SCOPE_REF,
		})
	})

	it("treats a lost uq_kb_scope_hash insert race as dedup, not error (P1-2)", async () => {
		const content = "Concurrent content"
		const doc: KBDocument = {
			title: "Race",
			content,
			source: { type: "manual", importedBy: "agent" },
			hash: hashText(content),
		}
		;(mockKB.insertOne as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }),
		)

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
		})

		expect(result.skipped).toBe(1)
		expect(result.errors).toHaveLength(0)
		expect(result.documentsProcessed).toBe(0)
	})

	it("measures the size guard in UTF-8 bytes, not UTF-16 code units", async () => {
		// P1-3 (fleet audit): "€" is 1 code unit but 3 UTF-8 bytes. A guard on
		// .length passes documents insertOne cannot store — at the 10 MiB
		// default, ~10M non-ASCII chars is up to ~30 MB of BSON.
		const content = "€".repeat(600)
		const doc: KBDocument = {
			title: "Multibyte",
			content,
			source: { type: "manual", importedBy: "agent" },
			hash: hashText(content),
		}

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			maxDocumentSize: 1000, // 600 code units pass, 1800 bytes must not
		})

		expect(result.skipped).toBe(1)
		expect(result.errors[0]).toMatch(/too large \(1800 bytes > 1000/)
		expect(mockKB.insertOne).not.toHaveBeenCalled()
	})

	it("clamps a caller maxDocumentSize override under the 16 MiB BSON limit", async () => {
		const content = "x".repeat(64)
		const doc: KBDocument = {
			title: "Clamped",
			content,
			source: { type: "manual", importedBy: "agent" },
			hash: hashText(content),
		}

		// A 64-byte doc still ingests fine under an absurd override…
		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			maxDocumentSize: 64 * 1024 * 1024,
		})
		expect(result.documentsProcessed).toBe(1)

		// …but a doc over the BSON ceiling is rejected even when the caller
		// asked for a limit above it.
		const big: KBDocument = {
			title: "Over BSON",
			content: "y".repeat(15 * 1024 * 1024 + 1),
			source: { type: "manual", importedBy: "agent" },
			hash: "big",
		}
		const result2 = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [big],
			embeddingMode: "automated",
			scope: SCOPE,
			maxDocumentSize: 64 * 1024 * 1024,
		})
		expect(result2.skipped).toBe(1)
	})

	it("skips document with same hash (dedup)", async () => {
		const content = "Duplicate content"
		const hash = hashText(content)
		const doc: KBDocument = {
			title: "Dupe",
			content,
			source: { type: "manual", importedBy: "agent" },
			hash,
		}

		// First, make findOne return existing doc with same hash.
		// C2 + W07: the fixture models a COMPLETE duplicate written by the
		// current chunk scheme — an unmarked or legacy-scheme parent now
		// triggers repair, not a skip.
		vi.mocked(mockKB.findOne).mockResolvedValueOnce({
			_id: "existing-id",
			hash,
			chunksComplete: true,
			chunkScheme: 2,
		})

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
		})

		expect(result.documentsProcessed).toBe(0)
		expect(result.skipped).toBe(1)
		expect(mockKB.insertOne).not.toHaveBeenCalled()
	})

	it("force re-ingests even with same hash", async () => {
		const content = "Force content"
		const hash = hashText(content)
		const doc: KBDocument = {
			title: "Force",
			content,
			source: { type: "manual", importedBy: "agent" },
			hash,
		}

		// findOne returns existing doc
		vi.mocked(mockKB.findOne).mockResolvedValueOnce({ _id: "old-id", hash })

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			force: true,
		})

		expect(result.documentsProcessed).toBe(1)
		expect(result.skipped).toBe(0)
		// Should delete old doc+chunks and insert new
		expect(mockKBChunks.deleteMany).toHaveBeenCalled()
		expect(mockKB.deleteOne).toHaveBeenCalled()
		expect(mockKB.insertOne).toHaveBeenCalled()
	})

	it("deduplicates by source.path first, then hash (F10)", async () => {
		const content = "Original content"
		const doc: KBDocument = {
			title: "Path Dedup",
			content,
			source: { type: "file", path: "/docs/guide.md", importedBy: "cli" },
			hash: hashText(content),
		}

		// Mock findOne to return existing doc by path with same hash
		// (C2 + W07: complete and current-scheme, so the duplicate skips).
		vi.mocked(mockKB.findOne).mockResolvedValueOnce({
			_id: "existing-id",
			hash: doc.hash,
			"source.path": "/docs/guide.md",
			chunksComplete: true,
			chunkScheme: 2,
		})

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
		})

		expect(result.skipped).toBe(1)
		expect(result.documentsProcessed).toBe(0)
	})

	it("replaces old version when source.path matches but hash changed (F10)", async () => {
		const oldHash = hashText("Old content")
		const newContent = "New updated content"
		const doc: KBDocument = {
			title: "Updated Doc",
			content: newContent,
			source: { type: "file", path: "/docs/guide.md", importedBy: "cli" },
			hash: hashText(newContent),
		}

		// Mock findOne to return existing doc by path with DIFFERENT hash
		vi.mocked(mockKB.findOne).mockResolvedValueOnce({
			_id: "old-id",
			hash: oldHash,
			"source.path": "/docs/guide.md",
		})

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
		})

		expect(result.documentsProcessed).toBe(1)
		// Should delete old doc+chunks before inserting new
		expect(mockKBChunks.deleteMany).toHaveBeenCalledWith({ docId: "old-id" })
		expect(mockKB.deleteOne).toHaveBeenCalled()
		expect(mockQueryCache.deleteMany).toHaveBeenCalledWith({
			agentId: SCOPE.agentId,
			scope: SCOPE.scope,
			scopeRef: SCOPE_REF,
		})
	})

	it("handles empty content gracefully", async () => {
		const doc: KBDocument = {
			title: "Empty",
			content: "",
			source: { type: "manual", importedBy: "agent" },
			hash: hashText(""),
		}

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
		})

		expect(result.documentsProcessed).toBe(1)
		expect(result.errors).toHaveLength(0)
	})

	it("reports progress during ingestion", async () => {
		const docs: KBDocument[] = [
			{
				title: "Doc 1",
				content: "Content 1",
				source: { type: "manual", importedBy: "agent" },
				hash: hashText("Content 1"),
			},
			{
				title: "Doc 2",
				content: "Content 2",
				source: { type: "manual", importedBy: "agent" },
				hash: hashText("Content 2"),
			},
		]

		const progressUpdates: Array<{
			completed: number
			total: number
			label: string
		}> = []
		await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: docs,
			embeddingMode: "automated",
			scope: SCOPE,
			progress: (update) => progressUpdates.push(update),
		})

		// Should have progress updates for each doc + final "Done"
		expect(progressUpdates.length).toBeGreaterThanOrEqual(3)
		expect(progressUpdates[progressUpdates.length - 1].label).toBe("Done")
	})
})

describe("ingestFilesToKB", () => {
	it("ingests .md files from a directory", async () => {
		const docsDir = path.join(tmpDir, "docs")
		await fs.mkdir(docsDir, { recursive: true })
		await fs.writeFile(
			path.join(docsDir, "guide.md"),
			"# Guide\nSome guide content",
		)
		await fs.writeFile(path.join(docsDir, "notes.txt"), "Some plain text notes")
		await fs.writeFile(path.join(docsDir, "ignore.js"), "console.log('skip')")

		const result = await ingestFilesToKB({
			db: mockDb(),
			prefix: "test_",
			paths: [docsDir],
			importedBy: "cli",
			embeddingMode: "automated",
			scope: SCOPE,
		})

		// Should process .md and .txt but skip .js
		expect(result.documentsProcessed).toBe(2)
		expect(result.errors).toHaveLength(0)
	})

	it("handles missing paths gracefully", async () => {
		const result = await ingestFilesToKB({
			db: mockDb(),
			prefix: "test_",
			paths: ["/nonexistent/path"],
			importedBy: "cli",
			embeddingMode: "automated",
			scope: SCOPE,
		})

		expect(result.documentsProcessed).toBe(0)
		expect(result.errors).toHaveLength(0)
	})

	it("ingests single file path", async () => {
		const filePath = path.join(tmpDir, "single.md")
		await fs.writeFile(filePath, "# Single file\nContent here")

		const result = await ingestFilesToKB({
			db: mockDb(),
			prefix: "test_",
			paths: [filePath],
			importedBy: "agent",
			embeddingMode: "automated",
			scope: SCOPE,
			tags: ["auto"],
			category: "docs",
		})

		expect(result.documentsProcessed).toBe(1)
	})
})

describe("listKBDocuments", () => {
	it("returns list of KB documents", async () => {
		const docs = await listKBDocuments(mockDb(), "test_", { scope: SCOPE })
		expect(Array.isArray(docs)).toBe(true)
	})
})

describe("removeKBDocument", () => {
	it("removes a KB document and its chunks (sequential fallback)", async () => {
		const removed = await removeKBDocument(mockDb(), "test_", "doc-123", SCOPE)
		expect(removed).toBe(true)
		expect(mockKBChunks.deleteMany).toHaveBeenCalledWith({
			docId: "doc-123",
			scopeRef: SCOPE_REF,
		})
		expect(mockKB.deleteOne).toHaveBeenCalled()
	})

	it("uses transaction when client is provided (F11)", async () => {
		const sessionMock = {
			withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
			endSession: vi.fn(),
		}
		const clientMock = {
			startSession: vi.fn(() => sessionMock),
		}

		const removed = await removeKBDocument(
			mockDb(),
			"test_",
			"doc-tx",
			SCOPE,
			clientMock as unknown as import("mongodb").MongoClient,
		)
		expect(removed).toBe(true)
		expect(clientMock.startSession).toHaveBeenCalled()
		expect(sessionMock.withTransaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ writeConcern: { w: "majority", wtimeoutMS: 5000 } },
		)
		expect(sessionMock.endSession).toHaveBeenCalled()
	})

	it("falls back to sequential when transactions are unsupported (F11)", async () => {
		const sessionMock = {
			withTransaction: vi.fn(async () => {
				const error = new Error(
					"Transaction numbers are only allowed on a replica set member or mongos",
				)
				;(error as Error & { code: number }).code = 20
				throw error
			}),
			endSession: vi.fn(),
		}
		const clientMock = {
			startSession: vi.fn(() => sessionMock),
		}

		const removed = await removeKBDocument(
			mockDb(),
			"test_",
			"doc-fallback",
			SCOPE,
			clientMock as unknown as import("mongodb").MongoClient,
		)
		expect(removed).toBe(true)
		// Should still delete via sequential fallback
		expect(mockKBChunks.deleteMany).toHaveBeenCalledWith({
			docId: "doc-fallback",
			scopeRef: SCOPE_REF,
		})
		expect(mockKB.deleteOne).toHaveBeenCalled()
	})

	it("propagates transaction failures without replaying sequential deletes", async () => {
		const error = Object.assign(new Error("transaction exceeded cache"), {
			code: 225,
		})
		const sessionMock = {
			withTransaction: vi.fn(async () => {
				throw error
			}),
			endSession: vi.fn(),
		}
		const clientMock = {
			startSession: vi.fn(() => sessionMock),
		}

		await expect(
			removeKBDocument(
				mockDb(),
				"test_",
				"doc-too-large",
				SCOPE,
				clientMock as unknown as import("mongodb").MongoClient,
			),
		).rejects.toBe(error)
		expect(mockKB.deleteOne).not.toHaveBeenCalled()
		expect(mockKBChunks.deleteMany).not.toHaveBeenCalled()
	})
})

describe("getKBStats", () => {
	it("returns document and chunk counts", async () => {
		const stats = await getKBStats(mockDb(), "test_", { scope: SCOPE })
		expect(stats).toHaveProperty("documents")
		expect(stats).toHaveProperty("chunks")
		expect(stats).toHaveProperty("categories")
		expect(stats).toHaveProperty("sources")
		expect(typeof stats.documents).toBe("number")
		expect(typeof stats.chunks).toBe("number")
	})
})

// ---------------------------------------------------------------------------
// Phase 3: KB re-ingestion transaction wrapping
// ---------------------------------------------------------------------------

describe("ingestToKB — transaction wrapping for re-ingestion", () => {
	it("wraps re-ingestion (delete old + insert new) in withTransaction when client provided", async () => {
		const oldHash = hashText("Old content")
		const newContent = "New updated content for transaction test"
		const doc: KBDocument = {
			title: "Tx Re-Ingest",
			content: newContent,
			source: { type: "file", path: "/docs/txtest.md", importedBy: "cli" },
			hash: hashText(newContent),
		}

		// Existing doc found by path with different hash -> triggers re-ingestion
		vi.mocked(mockKB.findOne).mockResolvedValueOnce({
			_id: "old-id",
			hash: oldHash,
			"source.path": "/docs/txtest.md",
		})

		const sessionMock = {
			withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
			endSession: vi.fn(),
		}
		const clientMock = {
			startSession: vi.fn(() => sessionMock),
		}

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			client: clientMock as unknown as import("mongodb").MongoClient,
		})

		expect(result.documentsProcessed).toBe(1)
		expect(clientMock.startSession).toHaveBeenCalled()
		expect(sessionMock.withTransaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ writeConcern: { w: "majority", wtimeoutMS: 5000 } },
		)
		expect(sessionMock.endSession).toHaveBeenCalled()
	})

	it("does not replay re-ingestion writes after a non-topology transaction failure", async () => {
		const newContent = "Updated content that must remain atomic"
		const doc: KBDocument = {
			title: "Atomic Re-Ingest",
			content: newContent,
			source: { type: "file", path: "/docs/atomic.md", importedBy: "cli" },
			hash: hashText(newContent),
		}
		vi.mocked(mockKB.findOne).mockResolvedValueOnce({
			_id: "old-atomic-id",
			hash: hashText("Old atomic content"),
			"source.path": "/docs/atomic.md",
		})
		const error = Object.assign(new Error("duplicate key during transaction"), {
			code: 11000,
		})
		const sessionMock = {
			withTransaction: vi.fn(async () => {
				throw error
			}),
			endSession: vi.fn(),
		}
		const clientMock = { startSession: vi.fn(() => sessionMock) }

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			client: clientMock as unknown as import("mongodb").MongoClient,
		})

		expect(result.documentsProcessed).toBe(0)
		expect(result.errors).toEqual([`Atomic Re-Ingest: ${error.message}`])
		expect(mockKB.deleteOne).not.toHaveBeenCalled()
		expect(mockKBChunks.deleteMany).not.toHaveBeenCalled()
		expect(mockKB.insertOne).not.toHaveBeenCalled()
		expect(mockKBChunks.bulkWrite).not.toHaveBeenCalled()
	})

	it("falls back to sequential writes when transaction fails (standalone)", async () => {
		const oldHash = hashText("Old content standalone")
		const newContent = "Updated content standalone test"
		const doc: KBDocument = {
			title: "Standalone Re-Ingest",
			content: newContent,
			source: { type: "file", path: "/docs/standalone.md", importedBy: "cli" },
			hash: hashText(newContent),
		}

		vi.mocked(mockKB.findOne).mockResolvedValueOnce({
			_id: "old-standalone-id",
			hash: oldHash,
			"source.path": "/docs/standalone.md",
		})

		const sessionMock = {
			withTransaction: vi.fn(async () => {
				const err = new Error(
					"Transaction numbers are only allowed on a replica set",
				)
				;(err as unknown as { code: number }).code = 20
				throw err
			}),
			endSession: vi.fn(),
		}
		const clientMock = {
			startSession: vi.fn(() => sessionMock),
		}

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			client: clientMock as unknown as import("mongodb").MongoClient,
		})

		// Should still succeed via fallback
		expect(result.documentsProcessed).toBe(1)
		expect(result.errors).toHaveLength(0)
		// Chunks and doc deletion + new insertion should happen sequentially
		expect(mockKBChunks.deleteMany).toHaveBeenCalled()
		expect(mockKB.deleteOne).toHaveBeenCalled()
		expect(mockKB.insertOne).toHaveBeenCalled()
	})

	it("uses session in all operations inside the transaction body", async () => {
		const oldHash = hashText("Session check content")
		const newContent = "New session check content for testing"
		const doc: KBDocument = {
			title: "Session Check",
			content: newContent,
			source: { type: "file", path: "/docs/session.md", importedBy: "cli" },
			hash: hashText(newContent),
		}

		vi.mocked(mockKB.findOne).mockResolvedValueOnce({
			_id: "old-session-id",
			hash: oldHash,
			"source.path": "/docs/session.md",
		})

		const fakeSession = { id: "test-session" }
		const sessionMock = {
			withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
			endSession: vi.fn(),
			...fakeSession,
		}
		const clientMock = {
			startSession: vi.fn(() => sessionMock),
		}

		await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			client: clientMock as unknown as import("mongodb").MongoClient,
		})

		// Verify session was passed to delete and insert operations
		const deleteCall = vi.mocked(mockKBChunks.deleteMany).mock.calls[0]
		expect(deleteCall[1]).toEqual({ session: sessionMock })

		const deleteOneCall = vi.mocked(mockKB.deleteOne).mock.calls[0]
		expect(deleteOneCall[1]).toEqual({ session: sessionMock })

		const insertCall = vi.mocked(mockKB.insertOne).mock.calls[0]
		expect(insertCall[1]).toEqual({ session: sessionMock })

		const bulkWriteCall = vi.mocked(mockKBChunks.bulkWrite).mock.calls[0]
		expect(bulkWriteCall[1]).toMatchObject({ session: sessionMock })
	})

	it("does NOT use transaction for fresh ingestion (no re-ingestion path)", async () => {
		const doc: KBDocument = {
			title: "Fresh Doc",
			content: "Fresh content that has no existing version",
			source: { type: "manual", importedBy: "agent" },
			hash: hashText("Fresh content that has no existing version"),
		}

		const sessionMock = {
			withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
			endSession: vi.fn(),
		}
		const clientMock = {
			startSession: vi.fn(() => sessionMock),
		}

		const result = await ingestToKB({
			db: mockDb(),
			prefix: "test_",
			documents: [doc],
			embeddingMode: "automated",
			scope: SCOPE,
			client: clientMock as unknown as import("mongodb").MongoClient,
		})

		expect(result.documentsProcessed).toBe(1)
		// Transaction should NOT be used for fresh ingestion (no delete-old needed)
		expect(clientMock.startSession).not.toHaveBeenCalled()
	})
})

describe("ingestToKB — C2 partial-chunk completeness", () => {
	const doc: KBDocument = {
		title: "Partial Doc",
		content: "# Heading\n\nsome content here that becomes at least one chunk",
		source: { type: "manual", importedBy: "api" },
		hash: "hash-partial-1",
	}
	const params = () => ({
		db: mockDb(),
		prefix: "test_",
		scope: SCOPE,
		documents: [doc],
		embeddingMode: "automated" as const,
	})
	const bulkWriteFailure = (upsertedCount: number) => {
		const err = new Error("bulk write failed") as Error & {
			result: { upsertedCount: number; modifiedCount: number }
			writeErrors: Array<{ errmsg: string }>
		}
		err.result = { upsertedCount, modifiedCount: 0 }
		err.writeErrors = [{ errmsg: "chunk insert boom" }]
		return err
	}
	const seedParent = (fields: Record<string, unknown>) =>
		vi.mocked(mockKB.insertOne)({
			hash: doc.hash,
			scopeRef: SCOPE_REF,
			title: doc.title,
			source: doc.source,
			...fields,
		})

	it("marks a fresh parent complete only after every chunk persists", async () => {
		const result = await ingestToKB(params())
		expect(result.errors).toEqual([])
		// Parent starts incomplete…
		const inserted = vi.mocked(mockKB.insertOne).mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(inserted.chunksComplete).toBe(false)
		expect(inserted.chunkScheme).toBe(2)
		// …and is flipped complete exactly once all chunk writes succeed,
		// stamping the current chunk identity scheme and final chunk count.
		expect(vi.mocked(mockKB.updateOne)).toHaveBeenCalledWith(
			{ _id: expect.any(String) },
			{
				$set: expect.objectContaining({
					chunksComplete: true,
					chunkScheme: 2,
				}),
			},
		)
		const setOp = vi.mocked(mockKB.updateOne).mock.calls[0]?.[1] as {
			$set: Record<string, unknown>
		}
		expect(setOp.$set.chunkCount).toBeGreaterThanOrEqual(1)
	})

	it("partial chunk failure leaves the parent incomplete and records the error", async () => {
		vi.mocked(mockKBChunks.bulkWrite).mockRejectedValueOnce(bulkWriteFailure(1))
		const result = await ingestToKB(params())
		expect(result.errors.length).toBeGreaterThan(0)
		// The invariant: the parent must not read as complete.
		expect(vi.mocked(mockKB.updateOne)).not.toHaveBeenCalled()
		const inserted = vi.mocked(mockKB.insertOne).mock.calls[0]?.[0] as Record<
			string,
			unknown
		>
		expect(inserted.chunksComplete).toBe(false)
	})

	it("retry after partial failure repairs instead of skipping", async () => {
		await seedParent({ _id: "existing-parent", chunksComplete: false })

		const result = await ingestToKB(params())

		expect(result.skipped).toBe(0)
		// W15 clean-replace: old chunks for the parent are deleted before the
		// re-upsert, so a partial repair cannot leave mixed-scheme chunks.
		expect(vi.mocked(mockKBChunks.deleteMany)).toHaveBeenCalledWith({
			docId: "existing-parent",
		})
		// Chunks are re-upserted, attached to the EXISTING parent id…
		expect(vi.mocked(mockKBChunks.bulkWrite)).toHaveBeenCalled()
		const ops = vi.mocked(mockKBChunks.bulkWrite).mock.calls[0]?.[0] as Array<{
			updateOne: { update: { $set: Record<string, unknown> } }
		}>
		expect(ops[0]?.updateOne.update.$set.docId).toBe("existing-parent")
		// …and the parent flips complete once the repair fully lands, with
		// the current scheme stamped.
		expect(vi.mocked(mockKB.updateOne)).toHaveBeenCalledWith(
			{ _id: "existing-parent" },
			{
				$set: expect.objectContaining({
					chunksComplete: true,
					chunkScheme: 2,
				}),
			},
		)
	})

	it("treats a legacy parent without the marker as incomplete and repairs it", async () => {
		await seedParent({ _id: "legacy-parent" })

		const result = await ingestToKB(params())

		expect(result.skipped).toBe(0)
		expect(vi.mocked(mockKB.updateOne)).toHaveBeenCalledWith(
			{ _id: "legacy-parent" },
			{
				$set: expect.objectContaining({
					chunksComplete: true,
					chunkScheme: 2,
				}),
			},
		)
	})

	it("still skips a complete parent with no redundant chunk writes", async () => {
		// W07: "complete" only means skippable when it was written by the
		// current chunk scheme.
		await seedParent({
			_id: "done-parent",
			chunksComplete: true,
			chunkScheme: 2,
		})

		const result = await ingestToKB(params())

		expect(result.skipped).toBe(1)
		expect(vi.mocked(mockKBChunks.bulkWrite)).not.toHaveBeenCalled()
		expect(vi.mocked(mockKB.updateOne)).not.toHaveBeenCalled()
	})

	it("repairs a complete parent written by a legacy chunk scheme (W07)", async () => {
		// A parent completed under chunk scheme v1 (line-range identity) is
		// NOT skippable: its chunks may collide on long lines and must be
		// re-chunked under the ordinal identity.
		await seedParent({ _id: "legacy-scheme-parent", chunksComplete: true })

		const result = await ingestToKB(params())

		expect(result.skipped).toBe(0)
		expect(vi.mocked(mockKBChunks.deleteMany)).toHaveBeenCalledWith({
			docId: "legacy-scheme-parent",
		})
		expect(vi.mocked(mockKB.updateOne)).toHaveBeenCalledWith(
			{ _id: "legacy-scheme-parent" },
			{
				$set: expect.objectContaining({
					chunksComplete: true,
					chunkScheme: 2,
				}),
			},
		)
	})
})
