// M2 T1 removal controls. Each test fails on 5280803 and passes with the
// startup contract: it drives the real boot path through a fake Db and
// imports nothing that only exists after the change.
import type { Collection, Db, MongoClient } from "mongodb"
import type { MemongoConfig } from "@memongo/lib"
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import * as schemaModule from "./mongodb-schema.js"
import { detectCapabilities } from "./mongodb-schema-capabilities.js"
import { ensureStandardIndexes } from "./mongodb-schema-standard-indexes.js"
import {
	createFakeSearchDb,
	embeddingQueries,
} from "./test-helpers/fake-search-db.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)
vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)
vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)
vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)
vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)
vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)
// The Search bootstrap stays real on both revisions (whichever of these
// names the revision exports); collection setup and standard indexes are
// mocked so only the Search contract decides whether boot serves.
vi.mock("./mongodb-schema.js", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>()
	const kit = (
		await import("./test-helpers/manager-test-kit.js")
	).schemaModuleMock() as Record<string, unknown>
	const realSearchBoot = [
		"enforceBootContract",
		"ensureSearchIndexes",
		"isSearchIndexManagementAvailable",
		"getExpectedSearchIndexTargets",
		"resolveSearchIndexReadinessTiming",
		"listSearchIndexes",
	].filter((name) => name in real)
	return {
		...real,
		...kit,
		...Object.fromEntries(realSearchBoot.map((name) => [name, real[name]])),
	}
})
vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)
vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)
vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)
vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)
vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)
vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)
vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)
vi.mock("./mongodb-access-tracker.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	AccessTracker: class {
		async close(): Promise<void> {}
	},
}))

type ManagerPrototypeSeams = {
	sync: (params?: unknown) => Promise<void>
	repairEventProjections: () => Promise<unknown>
	ensureWatcher: () => void
}
const prototypeSeams =
	MongoDBMemoryManager.prototype as unknown as ManagerPrototypeSeams

const ENV_KEYS = [
	"MEMONGO_BENCHMARK_STRICT",
	"MEMONGO_STRICT_SEARCH_INDEX_READY",
	"MEMONGO_REQUIRE_VECTOR",
	"MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS",
	"MEMONGO_SEARCH_INDEX_READINESS_POLL_MS",
	"MEMONGO_MONGODB_URI",
	"MEMONGO_FORCE_MONGODB_URI",
]

function buildCfg(): MemongoConfig {
	return {
		memory: {
			backend: "mongodb",
			mongodb: { uri: "mongodb://boot-controls-unit:27017/boot" },
		},
	}
}

beforeAll(() => {
	vi.spyOn(prototypeSeams, "sync").mockResolvedValue(undefined as never)
	vi.spyOn(prototypeSeams, "repairEventProjections").mockResolvedValue({
		eventsProcessed: 0,
		chunksCreated: 0,
	} as never)
	vi.spyOn(prototypeSeams, "ensureWatcher").mockImplementation(() => {})
})

beforeEach(() => {
	for (const key of ENV_KEYS) vi.stubEnv(key, undefined)
	vi.stubEnv("MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "1000")
	vi.stubEnv("MEMONGO_SEARCH_INDEX_READINESS_POLL_MS", "20")
	vi.mocked(schemaModule.chunksCollection).mockReturnValue({
		collectionName: "memongo_chunks",
	} as never)
	vi.mocked(schemaModule.detectCapabilities).mockResolvedValue({
		textSearch: false,
		vectorSearch: false,
		scoreFusion: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
	} as never)
	vi.mocked(schemaModule.ensureCollections).mockResolvedValue(
		undefined as never,
	)
	vi.mocked(schemaModule.ensureStandardIndexes).mockClear()
	vi.mocked(schemaModule.ensureStandardIndexes).mockResolvedValue(
		undefined as never,
	)
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("boot control: warn-and-serve (mongodb-manager.ts:718-826 on 5280803)", () => {
	it("refuses to return a manager when required Search indexes are still BUILDING at the deadline", async () => {
		const fake = createFakeSearchDb({
			indexes: {},
			onCreate: (_collection, description) => ({
				name: description.name,
				type: description.type,
				status: "BUILDING",
				queryable: false,
				latestDefinition: description.definition,
			}),
		})
		const client = {
			db: (name?: string) =>
				name === "admin" ? { command: async () => ({ ok: 1 }) } : fake.db,
			close: vi.fn(async () => {}),
		} as unknown as MongoClient

		const outcome = await MongoDBMemoryManager.create({
			cfg: buildCfg(),
			agentId: "boot-controls",
			resolved: resolveMemoryBackendConfig({
				cfg: buildCfg(),
				agentId: "boot-controls",
			}),
			client,
		}).then(
			async (manager) => {
				await manager.close()
				return { served: true as const }
			},
			(error: unknown) => ({ served: false as const, error }),
		)

		expect(outcome.served).toBe(false)
		expect(outcome).toMatchObject({
			error: { name: "MemongoBootError", code: "index-not-ready" },
		})
		expect(schemaModule.ensureStandardIndexes).not.toHaveBeenCalled()
		expect(embeddingQueries(fake.calls)).toEqual([])
	})
})

describe("boot control: capability catch (mongodb-schema-capabilities.ts:220 on 5280803)", () => {
	it("fails typed when $listSearchIndexes is denied instead of reporting no Search", async () => {
		const { db } = createFakeSearchDb({
			listError: () =>
				Object.assign(new Error("not authorized on boot to execute command"), {
					code: 13,
					codeName: "Unauthorized",
				}),
		})
		await expect(
			detectCapabilities(db, "memongo_chunks"),
		).rejects.toMatchObject({
			name: "MemongoBootError",
			code: "search-privileges-denied",
		})
	})

	it("fails typed on an unreadable buildInfo instead of a fusion-stage probe whose error counts as support (G4-67)", async () => {
		const fake = createFakeSearchDb({
			indexes: {},
			buildInfoError: Object.assign(new Error("buildInfo timed out"), {
				code: 50,
				codeName: "MaxTimeMSExpired",
			}),
		})
		await expect(
			detectCapabilities(fake.db, "memongo_chunks"),
		).rejects.toMatchObject({
			name: "MemongoBootError",
			code: "server-version-unreadable",
		})
		const probes = fake.calls.filter(
			(call) =>
				call.op === "aggregate" &&
				call.pipeline.some(
					(stage) => "$rankFusion" in stage || "$scoreFusion" in stage,
				),
		)
		expect(probes).toEqual([])
		expect(embeddingQueries(fake.calls)).toEqual([])
	})
})

describe("boot control: removals", () => {
	it("issues no paid $vectorSearch storedSource probe at boot (G4-69)", async () => {
		const fake = createFakeSearchDb({
			versionArray: [8, 3, 7, 0],
			indexes: {
				memongo_chunks: [
					{
						name: "memongo_chunks_text",
						type: "search",
						status: "READY",
						queryable: true,
					},
					{
						name: "memongo_chunks_vector",
						type: "vectorSearch",
						status: "READY",
						queryable: true,
						latestDefinition: {
							fields: [
								{ type: "autoEmbed", path: "text", model: "voyage-4-large" },
							],
							storedSource: { include: ["text"] },
						},
					},
				],
			},
		})
		await detectCapabilities(fake.db, "memongo_chunks").catch(() => undefined)
		expect(embeddingQueries(fake.calls)).toEqual([])
	})

	it("creates no $text index for idx_chunks_text or idx_kbchunks_text", async () => {
		const created: string[] = []
		const dropped: string[] = []
		const collection = (name: string) =>
			({
				collectionName: name,
				createIndex: vi.fn(async (_keys: unknown, opts?: { name?: string }) => {
					created.push(opts?.name ?? "")
					return opts?.name ?? name
				}),
				dropIndex: vi.fn(async (indexName: string) => {
					dropped.push(indexName)
					return { ok: 1 }
				}),
				listIndexes: vi.fn(() => ({ toArray: async () => [] })),
			}) as unknown as Collection
		const db = {
			collection: vi.fn(collection),
			command: vi.fn(async () => ({ ok: 1 })),
			admin: () => ({
				command: async () => ({ versionArray: [8, 3, 0, 0] }),
			}),
			listCollections: vi.fn(() => ({
				map: () => ({ toArray: async () => [] }),
				toArray: async () => [],
			})),
			createCollection: vi.fn(async (name: string) => collection(name)),
		} as unknown as Db
		await ensureStandardIndexes(db, "memongo_")
		expect(created).not.toContain("idx_chunks_text")
		expect(created).not.toContain("idx_kbchunks_text")
		expect(dropped).not.toContain("idx_chunks_text")
		expect(dropped).not.toContain("idx_kbchunks_text")
	})

	it.each([
		"MEMONGO_STRICT_SEARCH_INDEX_READY",
		"MEMONGO_REQUIRE_VECTOR",
	])("fails boot when the removed %s is set", (setting) => {
		vi.stubEnv(setting, "1")
		expect(() =>
			resolveMemoryBackendConfig({ cfg: buildCfg(), agentId: "boot-controls" }),
		).toThrow(setting)
	})
})
