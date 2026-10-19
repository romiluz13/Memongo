// M2 review D2: a configured KB source that cannot be scanned or read fails the
// refresh. These tests run the REAL ingestFilesToKB (real files, the stateful
// Mongo fake as the database) behind the manager's refresh seam, so a scan or
// read failure is observed through maybeAutoRefreshKB, not through a mocked
// import result.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	KBRefreshError,
	MongoDBManagerSyncOps,
} from "./mongodb-manager-sync.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const PREFIX = "test_"
const AGENT = "agent-1"
const MARKER_ID = `kb_last_auto_refresh:${AGENT}`

let tmpDir: string
let fake: ReturnType<typeof createStatefulMongoFake>

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-kb-refresh-"))
	fake = createStatefulMongoFake({ prefix: PREFIX })
})

afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeOps(paths: string[]): MongoDBManagerSyncOps {
	const host = {
		db: fake.db as Db,
		prefix: PREFIX,
		agentId: AGENT,
		config: {
			mongodb: {
				kb: {
					enabled: true,
					autoRefreshHours: 24,
					autoImportPaths: paths,
					chunking: { tokens: 600, overlap: 100 },
				},
				embeddingMode: "automated",
			},
		},
	} as unknown as MongoDBManagerHost
	return new MongoDBManagerSyncOps(host)
}

function marker() {
	return fake.findDoc("meta", { _id: MARKER_ID })
}

async function refreshFailure(ops: MongoDBManagerSyncOps) {
	try {
		await ops.maybeAutoRefreshKB()
	} catch (err) {
		return err
	}
	throw new Error("expected the refresh to fail")
}

describe("KB refresh over real files: input failures fail the refresh", () => {
	it("a clean refresh of real files advances the marker (control)", async () => {
		const good = path.join(tmpDir, "good.md")
		await fs.writeFile(good, "# Good\nContent that ingests")

		await makeOps([good]).maybeAutoRefreshKB()

		expect(fake.all("knowledge_base")).toHaveLength(1)
		expect(marker()).not.toBeNull()
	})

	it("a configured path that no longer exists fails the refresh typed and leaves the marker unchanged", async () => {
		const missing = path.join(tmpDir, "gone.md")

		const failure = await refreshFailure(makeOps([missing]))

		expect(failure).toBeInstanceOf(KBRefreshError)
		expect(failure).toMatchObject({
			code: "KB_REFRESH_FAILED",
			reason: "import-errors",
			documentsProcessed: 0,
			chunksCreated: 0,
			skipped: 0,
		})
		expect((failure as KBRefreshError).errors).toHaveLength(1)
		expect(marker()).toBeNull()
		expect(fake.all("knowledge_base")).toHaveLength(0)
	})

	it("a scan failure beside a good source reports the real counts of the document that succeeded and leaves the marker unchanged", async () => {
		const good = path.join(tmpDir, "good.md")
		await fs.writeFile(good, "# Good\nContent that ingests")
		const missing = path.join(tmpDir, "gone.md")

		const failure = await refreshFailure(makeOps([missing, good]))

		expect(failure).toBeInstanceOf(KBRefreshError)
		const refresh = failure as KBRefreshError
		expect(refresh.reason).toBe("import-errors")
		expect(refresh.documentsProcessed).toBe(1)
		expect(refresh.chunksCreated).toBeGreaterThan(0)
		expect(refresh.errors).toHaveLength(1)
		expect(fake.all("knowledge_base")).toHaveLength(1)
		expect(marker()).toBeNull()
	})

	it("a file that cannot be read fails the refresh typed, keeps its peer's real counts and leaves the marker unchanged", async () => {
		const docsDir = path.join(tmpDir, "docs")
		await fs.mkdir(docsDir, { recursive: true })
		const locked = path.join(docsDir, "locked.md")
		await fs.writeFile(locked, "# Locked\nBody")
		await fs.writeFile(path.join(docsDir, "open.md"), "# Open\nBody")
		const realReadFile = fs.readFile.bind(fs)
		vi.spyOn(fs, "readFile").mockImplementation(((
			file: string,
			options?: unknown,
		) =>
			file === locked
				? Promise.reject(
						Object.assign(
							new Error(`EACCES: permission denied, open '${file}'`),
							{ code: "EACCES" },
						),
					)
				: realReadFile(
						file,
						options as never,
					)) as unknown as typeof fs.readFile)

		const failure = await refreshFailure(makeOps([docsDir]))

		expect(failure).toBeInstanceOf(KBRefreshError)
		const refresh = failure as KBRefreshError
		expect(refresh.reason).toBe("import-errors")
		expect(refresh.documentsProcessed).toBe(1)
		expect(refresh.errors).toHaveLength(1)
		expect(refresh.errors[0]).toContain("EACCES")
		expect(marker()).toBeNull()
	})

	it("an unreadable directory fails the refresh typed and leaves the marker unchanged", async () => {
		const docsDir = path.join(tmpDir, "docs")
		await fs.mkdir(docsDir, { recursive: true })
		await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\nBody")
		const realReaddir = fs.readdir.bind(fs)
		vi.spyOn(fs, "readdir").mockImplementation(((
			dir: string,
			options?: unknown,
		) =>
			dir === docsDir
				? Promise.reject(
						Object.assign(
							new Error(`EACCES: permission denied, scandir '${dir}'`),
							{ code: "EACCES" },
						),
					)
				: realReaddir(dir, options as never)) as unknown as typeof fs.readdir)

		const failure = await refreshFailure(makeOps([docsDir]))

		expect(failure).toBeInstanceOf(KBRefreshError)
		expect((failure as KBRefreshError).reason).toBe("import-errors")
		expect(marker()).toBeNull()
	})

	it("unsupported extensions, symlinks and unchanged content stay skips: the refresh completes and advances the marker", async () => {
		const docsDir = path.join(tmpDir, "docs")
		await fs.mkdir(docsDir, { recursive: true })
		await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\nBody")
		await fs.writeFile(path.join(docsDir, "script.js"), "console.log(1)")
		await fs.symlink(
			path.join(docsDir, "guide.md"),
			path.join(docsDir, "link.md"),
		)

		await makeOps([docsDir]).maybeAutoRefreshKB()
		expect(marker()).not.toBeNull()
		expect(fake.all("knowledge_base")).toHaveLength(1)

		// A second refresh over the same unchanged content skips it again.
		await fake
			.collection("meta")
			.updateOne({ _id: MARKER_ID }, { $set: { timestamp: new Date(0) } })
		await makeOps([docsDir]).maybeAutoRefreshKB()
		expect(fake.all("knowledge_base")).toHaveLength(1)
		expect(marker()?.timestamp.getTime()).toBeGreaterThan(0)
	})
})
