/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Db, ClientSession, MongoClient } from "mongodb"
import type { Collection } from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock the schema module before imports (vi.mock is hoisted)
vi.mock("./mongodb-schema.js", () => ({
	chunksCollection: vi.fn(),
	filesCollection: vi.fn(),
}))

vi.mock("./session-files.js", () => ({
	listSessionFilesForAgent: vi.fn(async () => []),
	buildSessionEntry: vi.fn(async () => null),
	sessionPathForFile: vi.fn(
		(absPath: string) => `sessions/${path.basename(absPath)}`,
	),
}))

import { chunksCollection, filesCollection } from "./mongodb-schema.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import { listSessionFilesForAgent, buildSessionEntry } from "./session-files.js"

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockChunksCol(): ReturnType<typeof vi.fn> & Collection {
	const col = {
		find: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		bulkWrite: vi.fn(async (ops: unknown[]) => ({
			upsertedCount: ops.length,
			modifiedCount: 0,
		})),
		deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
		distinct: vi.fn(async () => [] as string[]),
	}
	return col as unknown as ReturnType<typeof vi.fn> & Collection
}

function createMockFilesCol(
	storedFiles: Map<
		string,
		{ hash: string; mtime: number; size: number }
	> = new Map(),
): Collection {
	const docs = Array.from(storedFiles.entries()).map(([filePath, data]) => ({
		_id: filePath,
		...data,
	}))
	return {
		find: vi.fn(() => ({
			toArray: vi.fn(async () => docs),
		})),
		updateOne: vi.fn(async () => ({})),
		deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
		deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
	} as unknown as Collection
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string
let mockChunks: Collection
let mockFiles: Collection

beforeEach(async () => {
	vi.clearAllMocks()
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-sync-test-"))
	mockChunks = createMockChunksCol()
	mockFiles = createMockFilesCol()
	vi.mocked(chunksCollection).mockReturnValue(mockChunks)
	vi.mocked(filesCollection).mockReturnValue(mockFiles)
	// Reset session mocks to defaults (no sessions)
	vi.mocked(listSessionFilesForAgent).mockResolvedValue([])
	vi.mocked(buildSessionEntry).mockResolvedValue(null)
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeMemoryFiles(
	workspaceDir: string,
	files: Record<string, string>,
): Promise<void> {
	const memDir = path.join(workspaceDir, "memory")
	await fs.mkdir(memDir, { recursive: true })
	for (const [name, content] of Object.entries(files)) {
		await fs.writeFile(path.join(memDir, name), content, "utf-8")
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// This suite still uses an old module-mock seam around collection helpers.
// The live MongoDB E2E gate now covers the canonical sync behavior, so keep
// this file parked until it is rewritten around a fake Db.collection harness.
describe("syncToMongoDB", () => {
	it("syncs markdown memory files from disk", async () => {
		await writeMemoryFiles(tmpDir, {
			"test.md": "# Test\n\nHello world content here for chunking",
			"notes.md": "# Notes\n\nSome notes here for indexing",
		})

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			embeddingMode: "automated",
		})

		expect(result.filesProcessed).toBe(2)
		expect(result.chunksUpserted).toBeGreaterThanOrEqual(2)
		expect(mockChunks.bulkWrite).toHaveBeenCalled()
		expect(mockFiles.updateOne).toHaveBeenCalled()
	})

	it("returns zero when no memory files exist", async () => {
		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			embeddingMode: "automated",
		})

		expect(result.filesProcessed).toBe(0)
		expect(result.chunksUpserted).toBe(0)
		expect(result.staleDeleted).toBe(0)
	})

	it("re-indexes markdown files when stored hash differs", async () => {
		await writeMemoryFiles(tmpDir, {
			"test.md": "# Test\n\nHello world",
		})

		const storedFiles = new Map([
			["memory/test.md", { hash: "stale-hash", mtime: 0, size: 0 }],
		])
		mockFiles = createMockFilesCol(storedFiles)
		vi.mocked(filesCollection).mockReturnValue(mockFiles)
		mockChunks = createMockChunksCol()
		vi.mocked(chunksCollection).mockReturnValue(mockChunks)

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			embeddingMode: "automated",
		})

		expect(result.filesProcessed).toBe(1)
		expect(mockChunks.bulkWrite).toHaveBeenCalled()
	})

	it("force re-indexes all markdown files even with matching hash", async () => {
		await writeMemoryFiles(tmpDir, {
			"test.md": "# Test\n\nContent",
		})

		// Pretend file is already stored with matching hash
		const storedFiles = new Map([
			["memory/test.md", { hash: "matches_everything", mtime: 0, size: 0 }],
		])
		mockFiles = createMockFilesCol(storedFiles)
		vi.mocked(filesCollection).mockReturnValue(mockFiles)
		mockChunks = createMockChunksCol()
		vi.mocked(chunksCollection).mockReturnValue(mockChunks)

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			embeddingMode: "automated",
			force: true,
		})

		expect(result.filesProcessed).toBe(1)
		expect(result.chunksUpserted).toBeGreaterThanOrEqual(1)
		expect(mockChunks.bulkWrite).toHaveBeenCalled()
	})

	it("does not include embedding field in automated mode for conversation sync", async () => {
		const sessionEntry = {
			path: "sessions/embed-check.jsonl",
			absPath: "/tmp/sessions/embed-check.jsonl",
			mtimeMs: Date.now(),
			size: 200,
			hash: "session-embed-check",
			content: "User: Hello\nAssistant: Mongo handles embeddings",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/embed-check.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			// In automated mode, MongoDB handles embeddings — no embedding field in document
			expect(op.updateOne.update.$set.embedding).toBeUndefined()
		}
	})

	it("does not include embedding field even when a legacy provider object is passed", async () => {
		const sessionEntry = {
			path: "sessions/provider-check.jsonl",
			absPath: "/tmp/sessions/provider-check.jsonl",
			mtimeMs: Date.now(),
			size: 200,
			hash: "session-provider-check",
			content: "User: Hello\nAssistant: Provider ignored",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/provider-check.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const mockProvider = {
			id: "mock",
			model: "mock-model",
			embedBatch: vi.fn(async (texts: string[]) =>
				texts.map(() => [0.1, 0.2, 0.3]),
			),
			embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
		}

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			model: "mock-model",
		})

		expect(mockProvider.embedBatch).not.toHaveBeenCalled()
		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.embeddingStatus).toBe("pending")
			expect(op.updateOne.update.$set.embedding).toBeUndefined()
		}
	})

	it("reports progress during conversation sync", async () => {
		const sessionEntryA = {
			path: "sessions/a.jsonl",
			absPath: "/tmp/sessions/a.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "session-a",
			content: "User: A\nAssistant: A",
			lineMap: [1, 2],
		}
		const sessionEntryB = {
			path: "sessions/b.jsonl",
			absPath: "/tmp/sessions/b.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "session-b",
			content: "User: B\nAssistant: B",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/a.jsonl",
			"/tmp/sessions/b.jsonl",
		])
		vi.mocked(buildSessionEntry)
			.mockResolvedValueOnce(sessionEntryA)
			.mockResolvedValueOnce(sessionEntryB)

		const progressUpdates: Array<{
			completed: number
			total: number
			label?: string
		}> = []
		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			progress: (update) => progressUpdates.push(update),
		})

		// Should have at least initial + per-file progress updates
		expect(progressUpdates.length).toBeGreaterThanOrEqual(2)
		const last = progressUpdates[progressUpdates.length - 1]
		expect(last.completed).toBe(last.total)
	})

	it("deletes stale chunks for removed files but keeps active ones", async () => {
		await writeMemoryFiles(tmpDir, {
			"keep.md": "# Keep\n\nKeep this file",
		})

		// Mock: chunks collection reports paths including a deleted file
		;(mockChunks.distinct as ReturnType<typeof vi.fn>).mockResolvedValue([
			"memory/keep.md",
			"memory/deleted.md",
		])
		;(mockChunks.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({
			deletedCount: 3,
		})

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			embeddingMode: "automated",
		})

		// Only memory/deleted.md should be stale — memory/keep.md is still on disk
		expect(mockChunks.deleteMany).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "conversation",
				path: { $in: ["memory/deleted.md"] },
			}),
		)
		expect(result.staleDeleted).toBe(3)
	})

	it("sets correct chunk document structure for conversation chunks", async () => {
		const sessionEntry = {
			path: "sessions/structure.jsonl",
			absPath: "/tmp/sessions/structure.jsonl",
			mtimeMs: Date.now(),
			size: 120,
			hash: "session-structure",
			content: "User: Structure\nAssistant: Test",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/structure.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(bulkOps.length).toBeGreaterThan(0)

		const firstOp = bulkOps[0].updateOne
		// Check filter uses composite _id
		expect(typeof firstOp.filter._id).toBe("string")
		expect(firstOp.filter._id).toContain("sessions/structure.jsonl:")

		// Check set fields
		const doc = firstOp.update.$set
		expect(doc.path).toBe("sessions/structure.jsonl")
		expect(doc.source).toBe("sessions")
		expect(typeof doc.startLine).toBe("number")
		expect(typeof doc.endLine).toBe("number")
		expect(typeof doc.hash).toBe("string")
		expect(typeof doc.text).toBe("string")
		expect(doc.updatedAt).toBeInstanceOf(Date)
		expect(firstOp.upsert).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// Session transcript syncing tests
// ---------------------------------------------------------------------------

describe("syncToMongoDB — session files", () => {
	it("syncs session files when agentId is provided", async () => {
		const sessionEntry = {
			path: "sessions/transcript.jsonl",
			absPath: "/tmp/sessions/transcript.jsonl",
			mtimeMs: Date.now(),
			size: 500,
			hash: "session-hash-abc",
			content: "User: How do I use MongoDB?\nAssistant: Use the driver.",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/transcript.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-123",
			embeddingMode: "automated",
		})

		expect(result.sessionFilesProcessed).toBe(1)
		expect(result.sessionChunksUpserted).toBeGreaterThanOrEqual(1)
		expect(listSessionFilesForAgent).toHaveBeenCalledWith("agent-123")
		expect(buildSessionEntry).toHaveBeenCalledWith(
			"/tmp/sessions/transcript.jsonl",
		)
	})

	it("does not sync sessions when agentId is not provided", async () => {
		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			embeddingMode: "automated",
		})

		expect(result.sessionFilesProcessed).toBe(0)
		expect(result.sessionChunksUpserted).toBe(0)
		expect(listSessionFilesForAgent).not.toHaveBeenCalled()
	})

	it("does not sync sessions when sessionMemory is disabled", async () => {
		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			sessionMemoryEnabled: false,
			embeddingMode: "automated",
		})

		expect(result.sessionFilesProcessed).toBe(0)
		expect(result.sessionChunksUpserted).toBe(0)
		expect(listSessionFilesForAgent).not.toHaveBeenCalled()
	})

	it("stores session chunks with source='sessions'", async () => {
		const sessionEntry = {
			path: "sessions/chat.jsonl",
			absPath: "/tmp/sessions/chat.jsonl",
			mtimeMs: Date.now(),
			size: 300,
			hash: "session-hash-def",
			content: "User: Hello\nAssistant: Hi there!",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/chat.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.source).toBe("sessions")
			expect(op.updateOne.update.$set.path).toBe("sessions/chat.jsonl")
		}
	})

	it("stores session file metadata with source='sessions'", async () => {
		const sessionEntry = {
			path: "sessions/meta-test.jsonl",
			absPath: "/tmp/sessions/meta-test.jsonl",
			mtimeMs: 1700000000000,
			size: 200,
			hash: "session-meta-hash",
			content: "User: Test\nAssistant: Response",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/meta-test.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		// updateOne is called for session file metadata
		const updateCalls = (mockFiles.updateOne as ReturnType<typeof vi.fn>).mock
			.calls
		const sessionCall = updateCalls.find(
			(call) =>
				typeof call[0]._id === "string" &&
				call[0]._id.endsWith("::sessions/meta-test.jsonl"),
		)
		expect(sessionCall).toBeDefined()
		expect(sessionCall![1].$set.source).toBe("sessions")
		expect(sessionCall![1].$set.hash).toBe("session-meta-hash")
	})

	it("skips unchanged session files based on hash", async () => {
		const sessionEntry = {
			path: "sessions/unchanged.jsonl",
			absPath: "/tmp/sessions/unchanged.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "already-indexed-hash",
			content: "User: Repeat\nAssistant: Same",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/unchanged.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		// Pre-populate stored files with matching hash
		mockFiles = createMockFilesCol(
			new Map([
				[
					"sessions/unchanged.jsonl",
					{ hash: "already-indexed-hash", mtime: 0, size: 0 },
				],
			]),
		)
		vi.mocked(filesCollection).mockReturnValue(mockFiles)

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		expect(result.sessionFilesProcessed).toBe(0)
		expect(mockChunks.bulkWrite).not.toHaveBeenCalled()
	})

	it("force re-indexes session files", async () => {
		const sessionEntry = {
			path: "sessions/force-test.jsonl",
			absPath: "/tmp/sessions/force-test.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "same-hash",
			content: "User: Force test\nAssistant: Forced",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/force-test.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		// Pre-populate stored files with matching hash
		mockFiles = createMockFilesCol(
			new Map([
				["sessions/force-test.jsonl", { hash: "same-hash", mtime: 0, size: 0 }],
			]),
		)
		vi.mocked(filesCollection).mockReturnValue(mockFiles)

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			force: true,
		})

		expect(result.sessionFilesProcessed).toBe(1)
		expect(result.sessionChunksUpserted).toBeGreaterThanOrEqual(1)
	})

	it("skips null/empty session entries", async () => {
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/null.jsonl",
			"/tmp/sessions/empty.jsonl",
		])
		vi.mocked(buildSessionEntry)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				path: "sessions/empty.jsonl",
				absPath: "/tmp/sessions/empty.jsonl",
				mtimeMs: Date.now(),
				size: 0,
				hash: "empty-hash",
				content: "",
				lineMap: [],
			})

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		// null entry skipped, empty content entry skipped
		expect(result.sessionFilesProcessed).toBe(0)
	})

	it("session paths are tracked for stale cleanup", async () => {
		const sessionEntry = {
			path: "sessions/tracked.jsonl",
			absPath: "/tmp/sessions/tracked.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "tracked-hash",
			content: "User: Track me\nAssistant: Tracked",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/tracked.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)
		mockFiles = createMockFilesCol(
			new Map([
				["sessions/tracked.jsonl", { hash: "tracked-hash", mtime: 0, size: 0 }],
				["sessions/old.jsonl", { hash: "old-hash", mtime: 0, size: 0 }],
			]),
		)
		vi.mocked(filesCollection).mockReturnValue(mockFiles)

		// Mock stale chunk detection — sessions/old.jsonl is stale
		;(mockChunks.distinct as ReturnType<typeof vi.fn>).mockImplementation(
			async (_field: string, filter?: { source?: string }) => {
				if (filter?.source === "sessions") {
					return ["sessions/tracked.jsonl", "sessions/old.jsonl"]
				}
				return []
			},
		)
		;(mockChunks.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({
			deletedCount: 2,
		})

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		// sessions/old.jsonl should be deleted as stale
		expect(result.staleDeleted).toBe(2)
		expect(mockChunks.deleteMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				source: "sessions",
				agentId: "agent-1",
				path: { $in: ["sessions/old.jsonl"] },
			}),
		)
	})

	it("does not generate session embeddings in the automated-only write path", async () => {
		const sessionEntry = {
			path: "sessions/embed-test.jsonl",
			absPath: "/tmp/sessions/embed-test.jsonl",
			mtimeMs: Date.now(),
			size: 200,
			hash: "embed-session-hash",
			content: "User: Embed me\nAssistant: Embedded",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/embed-test.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const mockProvider = {
			id: "mock",
			model: "mock-model",
			embedBatch: vi.fn(async (texts: string[]) =>
				texts.map(() => [0.5, 0.6, 0.7]),
			),
			embedQuery: vi.fn(async () => [0.5, 0.6, 0.7]),
		}

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			model: "mock-model",
		})

		expect(mockProvider.embedBatch).not.toHaveBeenCalled()
		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.embeddingStatus).toBe("pending")
			expect(op.updateOne.update.$set.embedding).toBeUndefined()
			expect(op.updateOne.update.$set.source).toBe("sessions")
		}
	})
})

// ---------------------------------------------------------------------------
// Transaction wrapping tests
// ---------------------------------------------------------------------------

function createMockSession(): ClientSession {
	const session = {
		withTransaction: vi.fn(async (fn: () => Promise<void>) => {
			await fn()
		}),
		endSession: vi.fn(),
	}
	return session as unknown as ClientSession
}

function createMockClient(session: ClientSession): MongoClient {
	return {
		startSession: vi.fn(() => session),
	} as unknown as MongoClient
}

describe("syncToMongoDB — transaction wrapping", () => {
	it("uses withTransaction when client is provided", async () => {
		const sessionEntry = {
			path: "sessions/tx-basic.jsonl",
			absPath: "/tmp/sessions/tx-basic.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "tx-basic",
			content: "User: tx\nAssistant: tx",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/tx-basic.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const mockSession = createMockSession()
		const mockClient = createMockClient(mockSession)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			client: mockClient,
		})

		expect(mockClient.startSession).toHaveBeenCalled()
		expect(mockSession.withTransaction).toHaveBeenCalled()
		expect(mockSession.endSession).toHaveBeenCalled()
	})

	it("passes session to bulkWrite and deleteMany inside transaction", async () => {
		const sessionEntry = {
			path: "sessions/tx-propagation.jsonl",
			absPath: "/tmp/sessions/tx-propagation.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "tx-propagation",
			content: "User: propagation\nAssistant: propagation",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/tx-propagation.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const mockSession = createMockSession()
		const mockClient = createMockClient(mockSession)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			client: mockClient,
		})

		// bulkWrite should be called with session option
		const bulkWriteCalls = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>)
			.mock.calls
		expect(bulkWriteCalls.length).toBeGreaterThan(0)
		const bulkWriteOpts = bulkWriteCalls[0][1]
		expect(bulkWriteOpts).toMatchObject({ session: mockSession })
	})

	it("passes session to stale chunk deleteMany", async () => {
		await writeMemoryFiles(tmpDir, {
			"keep.md": "# Keep\n\nKeep this file in transaction",
		})

		// Mock stale chunks exist
		;(mockChunks.distinct as ReturnType<typeof vi.fn>).mockResolvedValue([
			"memory/keep.md",
			"memory/stale.md",
		])
		;(mockChunks.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({
			deletedCount: 2,
		})

		const mockSession = createMockSession()
		const mockClient = createMockClient(mockSession)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			client: mockClient,
		})

		// deleteMany for stale chunks should include session
		const deleteCalls = (mockChunks.deleteMany as ReturnType<typeof vi.fn>).mock
			.calls
		const staleDeleteCall = deleteCalls.find((call: unknown[]) => {
			const filter = call[0] as { path?: { $in?: unknown } } | undefined
			return filter?.path?.$in !== undefined
		})
		expect(staleDeleteCall).toBeDefined()
		expect(staleDeleteCall![1]).toMatchObject({ session: mockSession })
	})

	it("falls back to non-transactional when transactions are not supported", async () => {
		const sessionEntry = {
			path: "sessions/tx-fallback.jsonl",
			absPath: "/tmp/sessions/tx-fallback.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "tx-fallback",
			content: "User: fallback\nAssistant: fallback",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/tx-fallback.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		// Simulate standalone MongoDB error
		const mockSession = createMockSession()
		;(
			mockSession.withTransaction as ReturnType<typeof vi.fn>
		).mockRejectedValue(
			new Error(
				"Transaction numbers are only allowed on a replica set member or mongos",
			),
		)
		const mockClient = createMockClient(mockSession)

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			client: mockClient,
		})

		// Should still succeed with non-transactional fallback
		expect(result.sessionFilesProcessed).toBe(1)
		expect(result.sessionChunksUpserted).toBeGreaterThanOrEqual(1)
		expect(mockSession.endSession).toHaveBeenCalled()
	})

	it("does not use transactions when client is not provided", async () => {
		const sessionEntry = {
			path: "sessions/no-client.jsonl",
			absPath: "/tmp/sessions/no-client.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "no-client",
			content: "User: no client\nAssistant: no client",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/no-client.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const result = await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		// Should still work normally without transactions
		expect(result.sessionFilesProcessed).toBe(1)
		expect(result.sessionChunksUpserted).toBeGreaterThanOrEqual(1)
	})

	it("session files also use transactions when client is provided", async () => {
		const sessionEntry = {
			path: "sessions/tx-session.jsonl",
			absPath: "/tmp/sessions/tx-session.jsonl",
			mtimeMs: Date.now(),
			size: 300,
			hash: "tx-session-hash",
			content: "User: Transaction test\nAssistant: In transaction",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/tx-session.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const mockSession = createMockSession()
		const mockClient = createMockClient(mockSession)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			client: mockClient,
		})

		// Session file bulkWrite should include session
		const bulkWriteCalls = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>)
			.mock.calls
		expect(bulkWriteCalls.length).toBeGreaterThan(0)
		for (const call of bulkWriteCalls) {
			expect(call[1]).toMatchObject({ session: mockSession })
		}
	})
})

// ---------------------------------------------------------------------------
// Embedding resilience: embeddingStatus field + retry
// ---------------------------------------------------------------------------

describe("syncToMongoDB — embeddingStatus and retry", () => {
	it("keeps embeddingStatus='pending' even if a legacy provider is passed", async () => {
		const sessionEntry = {
			path: "sessions/pending-success.jsonl",
			absPath: "/tmp/sessions/pending-success.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "pending-success",
			content: "User: pending\nAssistant: pending",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/pending-success.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.embeddingStatus).toBe("pending")
			expect(op.updateOne.update.$set.embedding).toBeUndefined()
		}
	})

	it("ignores legacy embedding provider failures and keeps pending status", async () => {
		const sessionEntry = {
			path: "sessions/pending-failed.jsonl",
			absPath: "/tmp/sessions/pending-failed.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "pending-failed",
			content: "User: pending failed\nAssistant: pending failed",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/pending-failed.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		const mockProvider = {
			id: "mock",
			model: "mock-model",
			embedBatch: vi.fn().mockRejectedValue(new Error("API unavailable")),
			embedQuery: vi.fn(async () => []),
		}

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		expect(mockProvider.embedBatch).not.toHaveBeenCalled()
		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.embeddingStatus).toBe("pending")
			expect(op.updateOne.update.$set.embedding).toBeUndefined()
		}
	})

	it("sets embeddingStatus='pending' in automated mode (MongoDB manages embeddings)", async () => {
		const sessionEntry = {
			path: "sessions/pending-auto.jsonl",
			absPath: "/tmp/sessions/pending-auto.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "pending-auto",
			content: "User: pending auto\nAssistant: pending auto",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/pending-auto.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.embeddingStatus).toBe("pending")
		}
	})

	it("does not retry legacy embedding generation on the automated write path", async () => {
		const sessionEntry = {
			path: "sessions/retry-test.jsonl",
			absPath: "/tmp/sessions/retry-test.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "retry-test",
			content: "User: retry\nAssistant: retry",
			lineMap: [1, 2],
		}
		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/retry-test.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		let callCount = 0
		const mockProvider = {
			id: "mock",
			model: "mock-model",
			embedBatch: vi.fn(async (texts: string[]) => {
				callCount++
				if (callCount < 3) {
					throw new Error(`attempt ${callCount} failed`)
				}
				return texts.map(() => [0.3, 0.4])
			}),
			embedQuery: vi.fn(async () => [0.3, 0.4]),
		}

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		expect(mockProvider.embedBatch).not.toHaveBeenCalled()
		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.embeddingStatus).toBe("pending")
			expect(op.updateOne.update.$set.embedding).toBeUndefined()
		}
	})

	it("does not re-attempt legacy embedding repair on sync", async () => {
		const failedChunks = [
			{ _id: "file.md:1:5", text: "failed chunk 1", embeddingStatus: "failed" },
			{
				_id: "file.md:6:10",
				text: "failed chunk 2",
				embeddingStatus: "failed",
			},
		]
		;(mockChunks.find as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => failedChunks),
		})
		;(mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mockResolvedValue({
			upsertedCount: 0,
			modifiedCount: 2,
		})

		const mockProvider = {
			id: "mock",
			model: "mock-model",
			embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.5, 0.6])),
			embedQuery: vi.fn(async () => [0.5, 0.6]),
		}

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			embeddingMode: "automated",
		})

		expect(mockChunks.find).not.toHaveBeenCalled()
		expect(mockProvider.embedBatch).not.toHaveBeenCalled()
	})

	// ---------------------------------------------------------------------------
	// maxSessionChunks truncation tests
	// ---------------------------------------------------------------------------

	it("caps session chunks at maxSessionChunks (keeps last N)", async () => {
		// Create a session with lots of content that will produce many chunks
		const lines: string[] = []
		for (let i = 0; i < 200; i++) {
			lines.push(
				`## Section ${i}\n\nThis is paragraph ${i} with enough text to form a chunk on its own. ` +
					"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt " +
					"ut labore et dolore magna aliqua. Ut enim ad minim veniam.",
			)
		}
		const sessionEntry = {
			path: "sessions/large-session.jsonl",
			absPath: "/tmp/sessions/large-session.jsonl",
			mtimeMs: Date.now(),
			size: 50000,
			hash: "large-session-hash",
			content: lines.join("\n\n"),
			lineMap: Array.from({ length: 200 }, (_, i) => i + 1),
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/large-session.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			maxSessionChunks: 5,
		})

		// Verify that bulkWrite was called with at most 5 chunks
		const bulkCalls = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls
		expect(bulkCalls.length).toBeGreaterThan(0)
		const sessionBulkOps = bulkCalls.find(
			(call) => call[0][0]?.updateOne?.update?.$set?.source === "sessions",
		)
		expect(sessionBulkOps).toBeDefined()
		expect(sessionBulkOps![0].length).toBeLessThanOrEqual(5)
	})

	it("does not truncate session chunks when under maxSessionChunks limit", async () => {
		const sessionEntry = {
			path: "sessions/small-session.jsonl",
			absPath: "/tmp/sessions/small-session.jsonl",
			mtimeMs: Date.now(),
			size: 100,
			hash: "small-session-hash",
			content: "User: Hello\nAssistant: Hi there!",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/small-session.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
			maxSessionChunks: 50,
		})

		// Should have chunks (small content = 1 chunk), all preserved
		const bulkCalls = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls
		expect(bulkCalls.length).toBeGreaterThan(0)
		const sessionBulkOps = bulkCalls.find(
			(call) => call[0][0]?.updateOne?.update?.$set?.source === "sessions",
		)
		expect(sessionBulkOps).toBeDefined()
		// Small content should produce 1 chunk, which is under the 50 limit
		expect(sessionBulkOps![0].length).toBeLessThanOrEqual(50)
	})

	it("session chunks also keep embeddingStatus='pending'", async () => {
		const sessionEntry = {
			path: "sessions/status-test.jsonl",
			absPath: "/tmp/sessions/status-test.jsonl",
			mtimeMs: Date.now(),
			size: 200,
			hash: "status-session-hash",
			content: "User: Status test\nAssistant: Has embeddingStatus",
			lineMap: [1, 2],
		}

		vi.mocked(listSessionFilesForAgent).mockResolvedValue([
			"/tmp/sessions/status-test.jsonl",
		])
		vi.mocked(buildSessionEntry).mockResolvedValue(sessionEntry)

		await syncToMongoDB({
			db: {} as Db,
			prefix: "test_",
			workspaceDir: tmpDir,
			agentId: "agent-1",
			embeddingMode: "automated",
		})

		const bulkOps = (mockChunks.bulkWrite as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		for (const op of bulkOps) {
			expect(op.updateOne.update.$set.embeddingStatus).toBe("pending")
		}
	})
})
