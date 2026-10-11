/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest"
import type { MongoClient } from "mongodb"
import type { MemongoConfig } from "@memongo/lib"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import { resolveMemoryBackendConfig } from "../../packages/memory-engine/src/backend-config.js"
import * as schemaModule from "../../packages/memory-engine/src/mongodb-schema.js"

// ---------------------------------------------------------------------------
// Module-graph mocks (same seam set as mongodb-manager-lifecycle.test.ts)
// ---------------------------------------------------------------------------

vi.mock("../../packages/memory-engine/src/mongodb-events.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).eventsModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-conversation-recall.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).conversationRecallModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-ops.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).opsModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-retrieval-planner.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).retrievalPlannerModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-episodes.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).episodesModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-graph.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).graphModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-schema.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).schemaModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-query-cache.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).queryCacheModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-query-rewriter.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).queryRewriterModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-reranker.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).rerankerModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-lane-coverage.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).laneCoverageModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-memory-jobs.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).memoryJobsModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-consolidator.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).consolidatorModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-derived-memory.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).derivedMemoryModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-telemetry.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).telemetryModuleMock(),
)

// ---------------------------------------------------------------------------
// W17 harness: fake driver client + fake AccessTracker
// ---------------------------------------------------------------------------

/**
 * W17: AccessTracker construction is the first post-manager factory phase.
 * The fake lets tests inject a constructor failure and observe close() on
 * unwinding. All other exports of the real module stay intact.
 */
const accessTrackerHarness = vi.hoisted(() => {
	const state = {
		constructorError: null as Error | null,
		instances: [] as Array<{ closed: boolean }>,
	}
	class FakeAccessTracker {
		closed = false
		constructor() {
			if (state.constructorError) {
				throw state.constructorError
			}
			state.instances.push(this)
		}
		async close(): Promise<void> {
			this.closed = true
		}
	}
	return { state, FakeAccessTracker }
})

vi.mock(
	"../../packages/memory-engine/src/mongodb-access-tracker.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		AccessTracker: accessTrackerHarness.FakeAccessTracker,
	}),
)

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const W17_URI = "mongodb://w17-unwind-unit:27017/w17"

const STRICT_ENV_KEYS = [
	"MEMONGO_BENCHMARK_STRICT",
	"MEMONGO_STRICT_SEARCH_INDEX_READY",
	"MEMONGO_FORCE_MONGODB_URI",
	"MEMONGO_MONGODB_URI",
] as const

const strictEnvOriginals = new Map<string, string | undefined>()

function buildCfg(): MemongoConfig {
	return {
		memory: {
			backend: "mongodb",
			mongodb: { uri: W17_URI },
		},
	}
}

/**
 * The three internally-guarded, db-heavy post-manager phases (startup sync,
 * projection repair, file watcher) are spied to no-ops: they cannot throw out
 * of create() themselves, and their failure handling is covered by dedicated
 * tests. Spying keeps these unit tests hermetic (no fs watching, no driver
 * I/O) while every phase that CAN fail the factory stays real.
 */
type ManagerPrototypeSeams = {
	sync: (params?: unknown) => Promise<void>
	repairEventProjections: () => Promise<unknown>
	ensureWatcher: () => void
}

const prototypeSeams =
	MongoDBMemoryManager.prototype as unknown as ManagerPrototypeSeams

function resetFactoryMocks(): void {
	vi.mocked(schemaModule.chunksCollection).mockReturnValue({
		collectionName: "memongo_chunks",
	} as never)
	vi.mocked(schemaModule.detectCapabilities).mockResolvedValue({
		textSearch: false,
		vectorSearch: false,
	} as never)
	vi.mocked(schemaModule.isSearchIndexManagementAvailable).mockResolvedValue(
		false,
	)
	vi.mocked(schemaModule.ensureCollections).mockResolvedValue(
		undefined as never,
	)
	vi.mocked(schemaModule.ensureStandardIndexes).mockResolvedValue(
		undefined as never,
	)
}

beforeAll(() => {
	for (const key of STRICT_ENV_KEYS) {
		strictEnvOriginals.set(key, process.env[key])
	}
	// Actual startup sync executes against fake collection boundaries.
	vi.spyOn(prototypeSeams, "repairEventProjections").mockResolvedValue({
		eventsProcessed: 0,
		chunksCreated: 0,
	} as never)
	// Actual temporary-directory watcher is owned and closed by the manager.
})

afterAll(() => {
	vi.restoreAllMocks()
	for (const [key, value] of strictEnvOriginals) {
		if (value === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = value
		}
	}
})

beforeEach(() => {
	for (const key of STRICT_ENV_KEYS) {
		delete process.env[key]
	}
	accessTrackerHarness.state.constructorError = null
	accessTrackerHarness.state.instances.length = 0
	resetFactoryMocks()
})

// ---------------------------------------------------------------------------

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import * as internal from "../../packages/memory-engine/src/internal.js"

it.each([
	"success",
	"schema",
	"tracker",
])("actual factory isolates workspace and preserves host ownership: %s", async (failure) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "memongo-factory-proof-"))
	const hostDir = path.join(root, "host")
	const defaultDir = path.join(root, "default")
	const scenarioDir = path.join(root, "scenario")
	for (const dir of [hostDir, defaultDir, scenarioDir])
		await mkdir(path.join(dir, "memory"), { recursive: true })
	for (const dir of [hostDir, defaultDir])
		await writeFile(
			path.join(dir, "memory", "sentinel.md"),
			"HOST_SENTINEL_MUST_NOT_ENTER_SCENARIO",
		)
	const writes: unknown[] = []
	const cursor = () => ({
		toArray: async () => [],
		sort() {
			return this
		},
		limit() {
			return this
		},
	})
	const col = {
		collectionName: "memongo_chunks",
		find: vi.fn(cursor),
		findOne: vi.fn(async (filter: { _id?: string }) =>
			filter._id?.startsWith("tenant-erasure-epoch:")
				? {
						_id: filter._id,
						agentId: "scenario-agent",
						epoch: 0,
						state: "open",
						serial: 0,
					}
				: null,
		),
		countDocuments: vi.fn(async () => 0),
		findOneAndUpdate: vi.fn(async (filter: { _id: string }) => ({
			_id: filter._id,
			agentId: "scenario-agent",
			epoch: 0,
			state: "open",
			serial: 0,
		})),
		updateOne: vi.fn(async (...args: unknown[]) => {
			writes.push(args)
			return { acknowledged: true, matchedCount: 1 }
		}),
		distinct: vi.fn(async () => []),
		deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
		bulkWrite: vi.fn(async (...args: unknown[]) => {
			writes.push(args)
			return {}
		}),
	}
	vi.mocked(schemaModule.chunksCollection).mockReturnValue(col as never)
	vi.mocked(schemaModule.filesCollection).mockReturnValue(col as never)
	vi.mocked(schemaModule.metaCollection).mockReturnValue(col as never)
	const close = vi.fn(async () => {})
	const session = {
		withTransaction: async (body: () => Promise<unknown>) => body(),
		endSession: async () => {},
	}
	const db = {
		databaseName: "unit",
		collection: () => col,
		client: { startSession: () => session },
	}
	const client = { db: () => db, close } as unknown as MongoClient
	const cfg = { ...buildCfg(), agents: { defaults: { workspace: defaultDir } } }
	const config = resolveMemoryBackendConfig({ cfg, agentId: "host-agent" })
	const host = {
		client,
		db,
		prefix: "memongo_",
		agentId: "host-agent",
		workspaceDir: hostDir,
		extraMemoryPaths: [defaultDir],
		config,
	} as unknown as MongoDBManagerHost
	const ops = new MongoDBManagerBenchmarkOps(host) as unknown as {
		createBenchmarkScenarioManager(
			id: string,
			workspace: string,
		): Promise<MongoDBMemoryManager>
	}
	expect(await internal.listMemoryFiles(hostDir, [])).toHaveLength(1)
	expect(await internal.listMemoryFiles(defaultDir, [])).toHaveLength(1)
	const enumeration = vi.spyOn(internal, "listMemoryFiles")
	let manager: MongoDBMemoryManager | undefined
	if (failure === "schema")
		vi.mocked(schemaModule.ensureCollections).mockRejectedValueOnce(
			new Error("schema failure"),
		)
	if (failure === "tracker")
		accessTrackerHarness.state.constructorError = new Error("tracker failure")
	try {
		if (failure !== "success") {
			await expect(
				ops.createBenchmarkScenarioManager("scenario-agent", scenarioDir),
			).rejects.toThrow(`${failure} failure`)
			expect(close).not.toHaveBeenCalled()
			return
		}
		manager = await ops.createBenchmarkScenarioManager(
			"scenario-agent",
			scenarioDir,
		)
		expect(manager).toBeInstanceOf(MongoDBMemoryManager)
		expect(enumeration.mock.calls).toEqual([[scenarioDir, []]])
		expect(await enumeration.mock.results.at(-1)?.value).toEqual([])
		expect(JSON.stringify(writes)).not.toContain("HOST_SENTINEL")
		expect((manager as unknown as { dirty: boolean }).dirty).toBe(false)
		expect(col.bulkWrite).not.toHaveBeenCalled()
		await manager.close()
		expect(close).not.toHaveBeenCalled()
		expect((manager as unknown as { watcher: unknown }).watcher).toBeNull()
		expect(accessTrackerHarness.state.instances.at(-1)?.closed).toBe(true)
	} finally {
		if (manager) await manager.close()
		enumeration.mockRestore()
		await rm(root, { recursive: true, force: true })
	}
})
