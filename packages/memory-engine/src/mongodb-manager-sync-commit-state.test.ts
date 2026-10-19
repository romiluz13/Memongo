// M2 review D3: a sync whose file-sync phase completed and whose KB refresh then
// failed says so on the typed error it throws. The refresh is the real
// maybeAutoRefreshKB over real files and the stateful Mongo fake; only the
// file-sync phase itself (syncToMongoDB) is a stub, because it needs a workspace
// of its own and has its own suites.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	KBRefreshError,
	MongoDBManagerSyncOps,
} from "./mongodb-manager-sync.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const syncToMongoDB = vi.hoisted(() => vi.fn())
vi.mock("./mongodb-sync.js", () => ({ syncToMongoDB }))

vi.mock("./mongodb-schema.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-schema.js")>()),
	filesCollection: () => ({ countDocuments: async () => 3 }),
	chunksCollection: () => ({ countDocuments: async () => 9 }),
}))

// The sync captures one admission token and the refresh captures another;
// `failOnCapture` makes the Nth capture fail like an unreachable gate.
const gate = vi.hoisted(() => ({ calls: 0, failOnCapture: 0 }))
vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		captureAdmissionToken: async (
			params: Parameters<typeof actual.captureAdmissionToken>[0],
		) => {
			gate.calls += 1
			if (gate.calls === gate.failOnCapture) {
				throw new Error("gate read failed: private-host.example")
			}
			return actual.captureAdmissionToken(params)
		},
	}
})

const PREFIX = "test_"
const AGENT = "agent-1"
const MARKER_ID = `kb_last_auto_refresh:${AGENT}`
const SYNC_RESULT = {
	filesProcessed: 1,
	sessionFilesProcessed: 0,
	chunksUpserted: 4,
	sessionChunksUpserted: 0,
	staleDeleted: 0,
	filesFailed: 0,
	enumerationComplete: true,
}

let tmpDir: string
let fake: ReturnType<typeof createStatefulMongoFake>

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-sync-commit-"))
	fake = createStatefulMongoFake({ prefix: PREFIX })
	gate.calls = 0
	gate.failOnCapture = 0
	syncToMongoDB.mockReset()
	syncToMongoDB.mockResolvedValue(SYNC_RESULT)
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

function build(paths: string[]) {
	const host = {
		db: fake.db as Db,
		client: {},
		prefix: PREFIX,
		agentId: AGENT,
		workspaceDir: tmpDir,
		extraMemoryPaths: [],
		fileCount: -1,
		chunkCount: -1,
		dirty: true,
		config: {
			mongodb: {
				kb: {
					enabled: true,
					autoRefreshHours: 24,
					autoImportPaths: paths,
					chunking: { tokens: 600, overlap: 100 },
				},
				embeddingMode: "automated",
				maxSessionChunks: 10,
			},
		},
		maybeAutoRefreshKB: () => ops.maybeAutoRefreshKB(),
	}
	const ops = new MongoDBManagerSyncOps(host as unknown as MongoDBManagerHost)
	return { host, ops }
}

/** Fails only the refresh marker's write; the import's own meta writes run. */
function failMarkerWrite(error: Error) {
	const meta = fake.collection("meta")
	const write = meta.updateOne.bind(meta)
	vi.spyOn(meta, "updateOne").mockImplementation(((
		filter: Record<string, unknown>,
		...rest: unknown[]
	) =>
		filter?._id === MARKER_ID
			? Promise.reject(error)
			: (write as (...args: unknown[]) => unknown)(filter, ...rest)) as never)
}

async function failureOf(run: Promise<unknown>): Promise<Error> {
	try {
		await run
	} catch (err) {
		return err as Error
	}
	throw new Error("expected the sync to fail")
}

describe("a failed KB refresh after a completed file sync reports its commit state (D3)", () => {
	it("a refresh that failed on a missing source keeps its type and says the file sync committed, with the import's real counts", async () => {
		const good = path.join(tmpDir, "good.md")
		await fs.writeFile(good, "# Good\nContent that ingests")
		const { host, ops } = build([path.join(tmpDir, "gone.md"), good])

		const failure = await failureOf(ops.runSync())

		expect(failure).toBeInstanceOf(KBRefreshError)
		expect(failure).toMatchObject({
			code: "KB_REFRESH_FAILED",
			reason: "import-errors",
		})
		expect(failure).toHaveProperty("commitState", "committed")
		expect(failure).toHaveProperty("commit", {
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
			kbImport: {
				documentsProcessed: 1,
				chunksCreated: expect.any(Number),
				skipped: 0,
			},
		})
		// The file sync and its totals really did land; the marker did not.
		expect(host.fileCount).toBe(3)
		expect(host.chunkCount).toBe(9)
		expect(fake.findDoc("meta", { _id: MARKER_ID })).toBeNull()
	})

	it("an uncertain marker commit after a clean import reports unknown, with the known counts (review 1244 E1)", async () => {
		const good = path.join(tmpDir, "good.md")
		await fs.writeFile(good, "# Good\nContent that ingests")
		const { ops } = build([good])
		const uncertain = Object.assign(new Error("commit result unknown"), {
			hasErrorLabel: (label: string) =>
				label === "UnknownTransactionCommitResult",
		})
		failMarkerWrite(uncertain)

		const failure = await failureOf(ops.runSync())

		expect(failure).toBeInstanceOf(KBRefreshError)
		expect(failure).toMatchObject({ reason: "marker-write-failed" })
		expect(failure).toHaveProperty("commitState", "unknown")
		expect(failure).toHaveProperty("commit", {
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
			kbImport: {
				documentsProcessed: 1,
				chunksCreated: expect.any(Number),
				skipped: 0,
			},
		})
	})

	it("a marker write that failed with a certain error stays committed", async () => {
		const good = path.join(tmpDir, "good.md")
		await fs.writeFile(good, "# Good\nContent that ingests")
		const { ops } = build([good])
		failMarkerWrite(new Error("marker write refused"))

		const failure = await failureOf(ops.runSync())

		expect(failure).toMatchObject({ reason: "marker-write-failed" })
		expect(failure).toHaveProperty("commitState", "committed")
	})

	it("a rejected import names no KB counts: absent means not known, never zero", async () => {
		const good = path.join(tmpDir, "good.md")
		await fs.writeFile(good, "# Good\nContent that ingests")
		const { ops } = build([good])
		gate.failOnCapture = 2

		const failure = await failureOf(ops.runSync())

		expect(failure).toBeInstanceOf(KBRefreshError)
		expect(failure).toMatchObject({ reason: "import-rejected" })
		expect(failure).toHaveProperty("commitState", "committed")
		expect(failure).toHaveProperty("commit", {
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
		})
		expect(failure).not.toHaveProperty("commit.kbImport")
	})

	it("a failure before the import started still says the file sync committed", async () => {
		const { ops } = build([path.join(tmpDir, "docs")])
		const lookupFailure = new Error("marker lookup failed")
		fake.injectFailure({
			collection: "meta",
			method: "findOne",
			error: lookupFailure,
		})

		const failure = await failureOf(ops.runSync())

		expect(failure).toBe(lookupFailure)
		expect(failure).toHaveProperty("commitState", "committed")
		expect(failure).not.toHaveProperty("commit.kbImport")
	})

	it("a file sync that finished dirty reports what it left undone", async () => {
		syncToMongoDB.mockResolvedValue({
			...SYNC_RESULT,
			filesFailed: 2,
			enumerationComplete: false,
		})
		const { host, ops } = build([path.join(tmpDir, "gone.md")])

		const failure = await failureOf(ops.runSync())

		expect(failure).toHaveProperty("commit.fileSync", {
			filesFailed: 2,
			enumerationComplete: false,
		})
		expect(host.dirty).toBe(true)
	})

	it("a failure of the file sync itself claims no commit state", async () => {
		const syncFailure = new Error("file sync failed")
		syncToMongoDB.mockRejectedValue(syncFailure)
		const { ops } = build([path.join(tmpDir, "gone.md")])

		const failure = await failureOf(ops.runSync())

		expect(failure).toBe(syncFailure)
		expect(failure).not.toHaveProperty("commitState")
		expect(failure).not.toHaveProperty("commit")
	})
})
