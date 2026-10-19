import { setImmediate } from "node:timers/promises"
/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import {
	describe,
	it,
	expect,
	vi,
	beforeAll,
	beforeEach,
	afterAll,
} from "vitest"
import type { MongoClient } from "mongodb"
import type { MemongoConfig } from "@memongo/lib"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { ChangeStreamUnavailableError } from "./mongodb-change-stream.js"
import { MemongoBootError } from "./mongodb-boot-errors.js"
import {
	getBestEffortFailureCounts,
	resetBestEffortFailureCounts,
} from "./best-effort.js"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import * as schemaModule from "./mongodb-schema.js"
import { resolveSearchIndexReadinessTiming } from "./mongodb-schema-search-definitions.js"

// ---------------------------------------------------------------------------
// Module-graph mocks (same seam set as mongodb-manager-lifecycle.test.ts)
// ---------------------------------------------------------------------------

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

vi.mock("./mongodb-schema.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-schema.js")>()),
	...(await import("./test-helpers/manager-test-kit.js")).schemaModuleMock(),
}))

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

// ---------------------------------------------------------------------------
// W17 harness: fake driver client + fake AccessTracker
// ---------------------------------------------------------------------------

/**
 * W17: the owned-client path goes through `new MongoClient(...)` + connect +
 * ping. The real driver cannot reach a server in unit tests, so replace only
 * MongoClient (every other runtime export stays real via importOriginal) and
 * record close calls per instance to prove "closed exactly once".
 */
const mongoDriverHarness = vi.hoisted(() => {
	class FakeMongoClient {
		static instances: FakeMongoClient[] = []
		static connectError: Error | null = null
		uri: string
		closeCalls = 0
		closeError: Error | null = null
		constructor(uri: string) {
			this.uri = uri
			FakeMongoClient.instances.push(this)
		}
		async connect(): Promise<FakeMongoClient> {
			if (FakeMongoClient.connectError) {
				throw FakeMongoClient.connectError
			}
			return this
		}
		db(name?: string): unknown {
			if (name === "admin") {
				return { command: async () => ({ ok: 1 }) }
			}
			return { databaseName: name ?? "memongo" }
		}
		async close(): Promise<void> {
			this.closeCalls += 1
			if (this.closeError) {
				throw this.closeError
			}
		}
	}
	return { FakeMongoClient }
})

vi.mock("mongodb", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	MongoClient: mongoDriverHarness.FakeMongoClient,
}))

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

vi.mock("./mongodb-access-tracker.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	AccessTracker: accessTrackerHarness.FakeAccessTracker,
}))

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const W17_URI = "mongodb://w17-unwind-unit:27017/w17"

const STRICT_ENV_KEYS = [
	"MEMONGO_BENCHMARK_STRICT",
	"MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS",
	"MEMONGO_SEARCH_INDEX_READINESS_POLL_MS",
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

function buildSharedClient(): {
	client: MongoClient
	close: ReturnType<typeof vi.fn>
} {
	const close = vi.fn(async () => {})
	const client = {
		db: vi.fn((name?: string) =>
			name === "admin"
				? { command: vi.fn(async () => ({ ok: 1 })) }
				: {
						databaseName: name ?? "memongo",
						collection: vi.fn(() => ({
							listSearchIndexes: () => ({ toArray: async () => [] }),
						})),
					},
		),
		close,
	} as unknown as MongoClient
	return { client, close }
}

function resetFactoryMocks(): void {
	vi.mocked(schemaModule.chunksCollection).mockReturnValue({
		collectionName: "memongo_chunks",
	} as never)
	vi.mocked(schemaModule.detectCapabilities).mockResolvedValue({
		textSearch: false,
		vectorSearch: false,
	} as never)
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
	vi.spyOn(prototypeSeams, "sync").mockResolvedValue(undefined as never)
	vi.spyOn(prototypeSeams, "repairEventProjections").mockResolvedValue({
		eventsProcessed: 0,
		chunksCreated: 0,
	} as never)
	vi.spyOn(prototypeSeams, "ensureWatcher").mockImplementation(() => {})
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
	mongoDriverHarness.FakeMongoClient.instances.length = 0
	mongoDriverHarness.FakeMongoClient.connectError = null
	accessTrackerHarness.state.constructorError = null
	accessTrackerHarness.state.instances.length = 0
	resetFactoryMocks()
})

// ---------------------------------------------------------------------------
// T11 (review F5): the pre-contract connect path is a typed boot failure
// ---------------------------------------------------------------------------

describe("pre-contract connect failure is a typed server-unreachable boot error", () => {
	const SENTINELS = [
		"SENTINEL-password-4471",
		"private-host.example.net",
		"tenant-db-sentinel",
		"mongodb://",
		"10.1.2.3",
	]
	const SENTINEL_URI =
		"mongodb://dbuser:SENTINEL-password-4471@private-host.example.net:27017/tenant-db-sentinel"

	function captured(spies: Array<ReturnType<typeof vi.spyOn>>): string {
		return spies
			.flatMap((spy) =>
				spy.mock.calls.map((call) => call.map(String).join(" ")),
			)
			.join("\n")
	}

	it("throws MemongoBootError server-unreachable with no URI, host, address, database or secret anywhere", async () => {
		const spies = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "info").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "debug").mockImplementation(() => {}),
		]
		mongoDriverHarness.FakeMongoClient.connectError = Object.assign(
			new Error(
				`connect ECONNREFUSED 10.1.2.3:27017 for ${SENTINEL_URI} (db tenant-db-sentinel)`,
			),
			{ name: "MongoNetworkError" },
		)
		const cfg: MemongoConfig = {
			memory: {
				backend: "mongodb",
				mongodb: { uri: SENTINEL_URI, database: "tenant-db-sentinel" },
			},
		}

		const failure = await MongoDBMemoryManager.create({
			cfg,
			agentId: "t11-unit",
			resolved: resolveMemoryBackendConfig({ cfg, agentId: "t11-unit" }),
		}).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(MemongoBootError)
		expect(failure).toMatchObject({
			name: "MemongoBootError",
			code: "server-unreachable",
		})
		const surfaces = [
			(failure as Error).message,
			JSON.stringify((failure as MemongoBootError).failures),
			captured(spies),
		].join("\n")
		for (const sentinel of SENTINELS) {
			expect(surfaces).not.toContain(sentinel)
		}
		expect(surfaces).toContain("MongoNetworkError")
		expect(mongoDriverHarness.FakeMongoClient.instances).toHaveLength(1)
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
	})

	it("the success path logs no URI, host or database either", async () => {
		const spies = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "info").mockImplementation(() => {}),
		]
		const cfg: MemongoConfig = {
			memory: {
				backend: "mongodb",
				mongodb: { uri: SENTINEL_URI, database: "tenant-db-sentinel" },
			},
		}
		vi.mocked(schemaModule.ensureCollections).mockRejectedValueOnce(
			new Error("stop after connect"),
		)

		await MongoDBMemoryManager.create({
			cfg,
			agentId: "t11-unit",
			resolved: resolveMemoryBackendConfig({ cfg, agentId: "t11-unit" }),
		}).catch(() => undefined)

		const logged = captured(spies)
		expect(logged).toContain("connecting to MongoDB")
		for (const sentinel of SENTINELS) {
			expect(logged).not.toContain(sentinel)
		}
	})
})

// ---------------------------------------------------------------------------
// W17: factory failure unwind — owned client
// ---------------------------------------------------------------------------

describe("W17 factory failure unwind (owned client)", () => {
	it("closes the owned client exactly once when ensureCollections fails", async () => {
		vi.mocked(schemaModule.ensureCollections).mockRejectedValueOnce(
			new Error("ensure-collections failed"),
		)

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "w17-unit",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "w17-unit",
				}),
			}),
		).rejects.toThrow("ensure-collections failed")

		expect(mongoDriverHarness.FakeMongoClient.instances).toHaveLength(1)
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
	})

	it("closes the owned client exactly once when ensureStandardIndexes fails", async () => {
		vi.mocked(schemaModule.ensureStandardIndexes).mockRejectedValueOnce(
			new Error("ensure-standard-indexes failed"),
		)

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "w17-unit",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "w17-unit",
				}),
			}),
		).rejects.toThrow("ensure-standard-indexes failed")

		expect(mongoDriverHarness.FakeMongoClient.instances).toHaveLength(1)
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
	})

	it("unwinds through manager.close() when the AccessTracker constructor fails", async () => {
		accessTrackerHarness.state.constructorError = new Error(
			"tracker ctor failed",
		)
		const onClosed = vi.fn()

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "w17-unit",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "w17-unit",
				}),
				onClosed,
			}),
		).rejects.toThrow("tracker ctor failed")

		// The manager existed when the failure hit, so close() ran the full
		// unwind: owned client closed exactly once, shared-registry release
		// hook fired once, and no tracker instance survived the constructor.
		expect(mongoDriverHarness.FakeMongoClient.instances).toHaveLength(1)
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
		expect(onClosed).toHaveBeenCalledTimes(1)
		expect(accessTrackerHarness.state.instances).toHaveLength(0)
	})

	it("unwinds the constructed tracker and owned client when ensureWatcher fails after the worker started", async () => {
		vi.spyOn(prototypeSeams, "ensureWatcher").mockImplementationOnce(() => {
			throw new Error("watcher failed")
		})

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "w17-unit",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "w17-unit",
				}),
			}),
		).rejects.toThrow("watcher failed")

		expect(mongoDriverHarness.FakeMongoClient.instances).toHaveLength(1)
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
		// The tracker was constructed before the failure and must be closed by
		// the unwind, not leaked with its flush timer.
		expect(accessTrackerHarness.state.instances).toHaveLength(1)
		expect(accessTrackerHarness.state.instances[0].closed).toBe(true)
	})

	it("fails the factory with a typed error, with no file-watcher-only fallback, when enabled change streams cannot open", async () => {
		const cfg = {
			memory: {
				backend: "mongodb",
				mongodb: { uri: W17_URI, enableChangeStreams: true },
			},
		} as MemongoConfig
		vi.mocked(schemaModule.chunksCollection).mockReturnValue({
			watch: () => {
				throw new Error(
					"The $changeStream stage is only supported on replica sets",
				)
			},
		} as never)
		const onClosed = vi.fn()

		const outcome = MongoDBMemoryManager.create({
			cfg,
			agentId: "w17-unit",
			resolved: resolveMemoryBackendConfig({ cfg, agentId: "w17-unit" }),
			onClosed,
		})

		await expect(outcome).rejects.toBeInstanceOf(ChangeStreamUnavailableError)
		await expect(outcome).rejects.toMatchObject({
			code: "CHANGE_STREAM_UNAVAILABLE",
		})
		expect(mongoDriverHarness.FakeMongoClient.instances).toHaveLength(1)
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
		expect(onClosed).toHaveBeenCalledTimes(1)
	})

	it("rethrows the original factory error even when the cleanup close fails", async () => {
		vi.mocked(schemaModule.ensureCollections).mockRejectedValueOnce(
			new Error("ensure-collections failed"),
		)

		// create() runs synchronously up to its first await, so the owned
		// client instance exists as soon as the promise is created. Arm its
		// close() to reject: the unwind must swallow that failure and still
		// rethrow the ORIGINAL factory error.
		const promise = MongoDBMemoryManager.create({
			cfg: buildCfg(),
			agentId: "w17-unit",
			resolved: resolveMemoryBackendConfig({
				cfg: buildCfg(),
				agentId: "w17-unit",
			}),
		})
		expect(mongoDriverHarness.FakeMongoClient.instances).toHaveLength(1)
		mongoDriverHarness.FakeMongoClient.instances[0].closeError = new Error(
			"close exploded during unwind",
		)

		await expect(promise).rejects.toThrow("ensure-collections failed")
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// W17: factory failure unwind — shared client
// ---------------------------------------------------------------------------

describe("W17 factory failure unwind (shared client)", () => {
	it("neither closes the caller's client nor releases the registry ref when a pre-manager phase fails", async () => {
		vi.mocked(schemaModule.ensureCollections).mockRejectedValueOnce(
			new Error("ensure-collections failed"),
		)
		const { client, close } = buildSharedClient()
		const onClosed = vi.fn()

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "w17-unit",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "w17-unit",
				}),
				client,
				onClosed,
			}),
		).rejects.toThrow("ensure-collections failed")

		// The caller never received a manager and still owns the shared
		// client, so the failed factory must not close it or consume the
		// registry release hook.
		expect(close).not.toHaveBeenCalled()
		expect(onClosed).not.toHaveBeenCalled()
	})

	it("releases the registry ref via onClosed but never closes the caller's client when a post-manager phase fails", async () => {
		accessTrackerHarness.state.constructorError = new Error(
			"tracker ctor failed",
		)
		const { client, close } = buildSharedClient()
		const onClosed = vi.fn()

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "w17-unit",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "w17-unit",
				}),
				client,
				onClosed,
			}),
		).rejects.toThrow("tracker ctor failed")

		// manager.close() released the shared-registry reference (onClosed
		// once) but the client belongs to the process-level registry, so the
		// failed factory must never close it.
		expect(close).not.toHaveBeenCalled()
		expect(onClosed).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// W17: the wrap must not break the happy path
// ---------------------------------------------------------------------------

describe("W17 factory happy path under the unwind wrap", () => {
	it("creates and returns a usable manager, and close() still runs exactly once on demand", async () => {
		const onClosed = vi.fn()

		const manager = await MongoDBMemoryManager.create({
			cfg: buildCfg(),
			agentId: "w17-unit",
			resolved: resolveMemoryBackendConfig({
				cfg: buildCfg(),
				agentId: "w17-unit",
			}),
			onClosed,
		})

		expect(manager).toBeInstanceOf(MongoDBMemoryManager)
		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(0)
		expect(accessTrackerHarness.state.instances).toHaveLength(1)
		expect(accessTrackerHarness.state.instances[0].closed).toBe(false)

		await manager.close()

		expect(mongoDriverHarness.FakeMongoClient.instances[0].closeCalls).toBe(1)
		expect(accessTrackerHarness.state.instances[0].closed).toBe(true)
		expect(onClosed).toHaveBeenCalledTimes(1)
	})
})

describe("startup sync and projection repair are declared best-effort (J-09)", () => {
	it("counts a failed startup sync and a failed projection repair by label, logs no driver text, and still returns the manager", async () => {
		resetBestEffortFailureCounts()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(prototypeSeams.sync).mockRejectedValueOnce(
			new Error("sync failed at mongodb://user:SENTINEL-sync@db.example:27017"),
		)
		vi.mocked(prototypeSeams.repairEventProjections).mockRejectedValueOnce(
			new Error("repair failed at mongodb://user:SENTINEL-repair@db.example"),
		)

		const manager = await MongoDBMemoryManager.create({
			cfg: buildCfg(),
			agentId: "j09-unit",
			resolved: resolveMemoryBackendConfig({
				cfg: buildCfg(),
				agentId: "j09-unit",
			}),
		})

		expect(manager).toBeInstanceOf(MongoDBMemoryManager)
		expect(getBestEffortFailureCounts()).toEqual({
			"startup-sync": 1,
			"startup-projection-repair": 1,
		})
		const logged = warn.mock.calls.map((call) => call.map(String).join(" "))
		expect(logged.join("\n")).not.toContain("SENTINEL")
		await manager.close()
		warn.mockRestore()
	})

	it("counts nothing when both startup tasks succeed", async () => {
		resetBestEffortFailureCounts()

		const manager = await MongoDBMemoryManager.create({
			cfg: buildCfg(),
			agentId: "j09-unit-ok",
			resolved: resolveMemoryBackendConfig({
				cfg: buildCfg(),
				agentId: "j09-unit-ok",
			}),
		})

		expect(getBestEffortFailureCounts()).toEqual({})
		await manager.close()
	})
})

describe("startup contract timing reaches the boot contract", () => {
	const cases = [
		["defaults unset", undefined, undefined, 180_000, 1_000],
		["defaults empty", "", "", 180_000, 1_000],
		["whitespace", "   ", " ", 180_000, 1_000],
		["valid", "42000", "250", 42_000, 250],
		["valid padded", " 42000 ", " 125 ", 42_000, 125],
	] as const
	it.each(
		cases,
	)("%s passes one total deadline and a bounded poll to enforceBootContract", async (_name, timeout, poll, expectedDeadline, expectedPoll) => {
		if (timeout !== undefined) {
			process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS = timeout
		}
		if (poll !== undefined) {
			process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS = poll
		}
		vi.mocked(
			schemaModule.resolveSearchIndexReadinessTiming,
		).mockImplementation(resolveSearchIndexReadinessTiming)
		const contract = vi.mocked(schemaModule.enforceBootContract)
		contract.mockClear()
		const { client } = buildSharedClient()

		const manager = await MongoDBMemoryManager.create({
			cfg: buildCfg(),
			agentId: "readiness",
			resolved: resolveMemoryBackendConfig({
				cfg: buildCfg(),
				agentId: "readiness",
			}),
			client,
		})
		await manager.close()

		expect(contract).toHaveBeenCalledOnce()
		expect(contract.mock.calls[0]?.[1]).toMatchObject({
			mode: "repair",
			deadlineMs: expectedDeadline,
			pollMs: expectedPoll,
		})
	})

	it.each([
		["MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "0"],
		["MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "NaN"],
		["MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "-1"],
		["MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "Infinity"],
		["MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "42000.9"],
		["MEMONGO_SEARCH_INDEX_READINESS_POLL_MS", "0"],
		["MEMONGO_SEARCH_INDEX_READINESS_POLL_MS", "NaN"],
	] as const)("rejects %s=%s at boot, naming the setting, before any index work", async (setting, value) => {
		process.env[setting] = value
		vi.mocked(
			schemaModule.resolveSearchIndexReadinessTiming,
		).mockImplementation(resolveSearchIndexReadinessTiming)
		const contract = vi.mocked(schemaModule.enforceBootContract)
		contract.mockClear()

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "readiness",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "readiness",
				}),
			}),
		).rejects.toMatchObject({
			name: "MemongoBootError",
			code: "config-invalid",
			setting,
		})
		expect(contract).not.toHaveBeenCalled()
		expect(mongoDriverHarness.FakeMongoClient.instances[0]?.closeCalls).toBe(1)
	})

	it("serves nothing when the boot contract fails: the typed failure propagates and the owned client closes", async () => {
		const { MemongoBootError } = await import("./mongodb-boot-errors.js")
		vi.mocked(schemaModule.detectCapabilities).mockClear()
		vi.mocked(schemaModule.ensureStandardIndexes).mockClear()
		vi.mocked(schemaModule.enforceBootContract).mockRejectedValueOnce(
			new MemongoBootError(
				{
					code: "index-not-ready",
					requirement: "READY and serving its manifest definition",
					index: "memongo_chunks_vector",
					collection: "memongo_chunks",
					status: "BUILDING",
				},
				"boot refused after the 180 s readiness deadline",
			),
		)

		await expect(
			MongoDBMemoryManager.create({
				cfg: buildCfg(),
				agentId: "readiness",
				resolved: resolveMemoryBackendConfig({
					cfg: buildCfg(),
					agentId: "readiness",
				}),
			}),
		).rejects.toBeInstanceOf(MemongoBootError)
		expect(schemaModule.detectCapabilities).not.toHaveBeenCalled()
		expect(schemaModule.ensureStandardIndexes).not.toHaveBeenCalled()
		expect(mongoDriverHarness.FakeMongoClient.instances[0]?.closeCalls).toBe(1)
	})
})
