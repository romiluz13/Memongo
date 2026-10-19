import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"

// M2 T11 (failure matrix, E-15): a failed read or count is a failure of the
// operation. It is never replaced by a delta count or by a missing resume
// token; only the declared best-effort resume-token write is counted instead.

const collections = vi.hoisted(() => ({
	files: { countDocuments: vi.fn() },
	chunks: { countDocuments: vi.fn() },
	meta: { findOne: vi.fn(), updateOne: vi.fn() },
}))
const syncToMongoDB = vi.hoisted(() => vi.fn())

vi.mock("./mongodb-schema.js", () => ({
	filesCollection: () => collections.files,
	chunksCollection: () => collections.chunks,
	metaCollection: () => collections.meta,
}))
vi.mock("./mongodb-sync.js", () => ({ syncToMongoDB }))
vi.mock("./mongodb-write-fence.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-write-fence.js")>()),
	captureAdmissionToken: vi.fn(async () => ({
		kind: "admission",
		agentId: "agent-1",
		epoch: 0,
	})),
}))

import {
	getBestEffortFailureCounts,
	resetBestEffortFailureCounts,
} from "./best-effort.js"
import { MongoDBManagerSyncOps } from "./mongodb-manager-sync.js"

const SYNC_RESULT = {
	filesProcessed: 1,
	sessionFilesProcessed: 0,
	chunksUpserted: 4,
	sessionChunksUpserted: 0,
	filesFailed: 0,
	enumerationComplete: true,
}

function buildOps() {
	const host = {
		db: {},
		client: {},
		prefix: "t_",
		agentId: "agent-1",
		workspaceDir: "/workspace",
		extraMemoryPaths: [],
		fileCount: -1,
		chunkCount: -1,
		dirty: true,
		config: { mongodb: { embeddingMode: "automated", maxSessionChunks: 10 } },
		maybeAutoRefreshKB: vi.fn(async () => undefined),
	}
	return {
		host,
		ops: new MongoDBManagerSyncOps(host as unknown as MongoDBManagerHost),
	}
}

beforeEach(() => {
	vi.resetAllMocks()
	resetBestEffortFailureCounts()
	syncToMongoDB.mockResolvedValue(SYNC_RESULT)
})

describe("runSync tenant totals", () => {
	it("reads the tenant's real totals and clears the dirty flag", async () => {
		collections.files.countDocuments.mockResolvedValue(7)
		collections.chunks.countDocuments.mockResolvedValue(30)
		const { host, ops } = buildOps()

		await ops.runSync()

		expect(host.fileCount).toBe(7)
		expect(host.chunkCount).toBe(30)
		expect(host.dirty).toBe(false)
		expect(collections.files.countDocuments).toHaveBeenCalledWith({
			agentId: "agent-1",
		})
	})

	it("a healthy zero total is final: no delta count replaces it", async () => {
		collections.files.countDocuments.mockResolvedValue(0)
		collections.chunks.countDocuments.mockResolvedValue(0)
		const { host, ops } = buildOps()

		await ops.runSync()

		expect(host.fileCount).toBe(0)
		expect(host.chunkCount).toBe(0)
	})

	it("a failed count fails the sync and reports no delta as a total", async () => {
		const failure = new Error("count failed")
		collections.files.countDocuments.mockRejectedValue(failure)
		const { host, ops } = buildOps()

		await expect(ops.runSync()).rejects.toBe(failure)

		expect(host.fileCount).toBe(-1)
		expect(host.chunkCount).toBe(-1)
		expect(host.dirty).toBe(true)
		expect(host.maybeAutoRefreshKB).not.toHaveBeenCalled()
	})
})

describe("change stream resume token", () => {
	it("a stored token is returned and a missing one is null", async () => {
		const { ops } = buildOps()
		collections.meta.findOne.mockResolvedValueOnce({ token: { _data: "t" } })
		collections.meta.findOne.mockResolvedValueOnce(null)

		await expect(ops.loadPersistedChangeStreamResumeToken()).resolves.toEqual({
			_data: "t",
		})
		await expect(ops.loadPersistedChangeStreamResumeToken()).resolves.toBeNull()
	})

	it("a failed read rejects instead of starting the stream from now", async () => {
		const failure = new Error("meta read failed")
		collections.meta.findOne.mockRejectedValue(failure)
		const { ops } = buildOps()

		await expect(ops.loadPersistedChangeStreamResumeToken()).rejects.toBe(
			failure,
		)
	})

	it("a failed token write is declared best-effort: counted, never thrown", async () => {
		collections.meta.updateOne.mockRejectedValue(new Error("write failed"))
		const { ops } = buildOps()

		await expect(
			ops.persistChangeStreamResumeToken({ _data: "t" }),
		).resolves.toBeUndefined()

		expect(getBestEffortFailureCounts()).toEqual({
			"change-stream-resume-token": 1,
		})
	})
})
