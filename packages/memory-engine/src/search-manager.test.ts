import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemongoConfig } from "@memongo/lib"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import {
	resetSharedMongoClientRegistryForTests,
	setSharedMongoClientConnectForTests,
} from "./mongodb-client-registry.js"
import {
	buildMongoDBCacheKey,
	closeAllMemorySearchManagers,
	evictIdleMemorySearchManagers,
	getMemorySearchManager,
} from "./search-manager.js"

const managerMocks = vi.hoisted(() => ({
	create: vi.fn(),
}))

vi.mock("./mongodb-manager.js", () => ({
	MongoDBMemoryManager: { create: managerMocks.create },
	buildMongoClientOptions: vi.fn(() => ({})),
}))

/**
 * Minimal resolved config factory for cache key tests.
 * Only fields relevant to cache key differentiation are varied;
 * the rest are stable defaults.
 */
function makeConfig(
	overrides?: Partial<ResolvedMongoDBConfig>,
): ResolvedMongoDBConfig {
	return {
		uri: "mongodb://localhost:27017",
		database: "test",
		collectionPrefix: "mem_",
		deploymentProfile: "atlas-local-preview",
		embeddingMode: "automated",
		fusionMethod: "scoreFusion",
		recallProfile: "balanced",
		quantization: "none",
		watchDebounceMs: 500,
		numDimensions: 1024,
		maxPoolSize: 10,
		minPoolSize: 1,
		memoryTtlDays: 90,
		enableChangeStreams: false,
		changeStreamDebounceMs: 500,
		connectTimeoutMs: 5000,
		numCandidates: 100,
		maxSessionChunks: 50,
		kb: {
			enabled: true,
			chunking: { tokens: 512, overlap: 50 },
			autoImportPaths: [],
			maxDocumentSize: 1_000_000,
			autoRefreshHours: 24,
		},
		relevance: {
			enabled: false,
			telemetry: {
				enabled: false,
				baseSampleRate: 0,
				adaptive: { enabled: false, maxSampleRate: 0, minWindowSize: 0 },
				persistRawExplain: false,
				queryPrivacyMode: "none",
			},
			retention: { days: 30 },
			benchmark: { enabled: false, datasetPath: "" },
		},
		episodes: { enabled: false, minEventsForEpisode: 10 },
		graph: {
			enabled: false,
			maxGraphDepth: 2,
			entityExtraction: {
				method: "regex" as const,
				model: undefined,
				timeoutMs: 5000,
			},
		},
		queryRewriting: {
			enabled: false,
			method: "synonym-expansion" as const,
			maxTokens: 128,
		},
		reranking: {
			enabled: false,
			model: "rerank-2.5" as const,
			topN: 20,
			minScore: 0.1,
			voyageApiKey: "",
		},
		cache: {
			enabled: true,
			conversationTtlSec: 300,
			kbTtlSec: 3600,
			similarityThreshold: 0.95,
		},
		sources: {
			reference: { enabled: true },
			conversation: { enabled: true },
			structured: { enabled: true },
		},
		...overrides,
	}
}

describe("buildMongoDBCacheKey", () => {
	it("different source policies produce different cache keys", () => {
		const allEnabled = makeConfig({
			sources: {
				reference: { enabled: true },
				conversation: { enabled: true },
				structured: { enabled: true },
			},
		})
		const structuredDisabled = makeConfig({
			sources: {
				reference: { enabled: true },
				conversation: { enabled: true },
				structured: { enabled: false },
			},
		})

		const key1 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config: allEnabled,
			workspaceDir: "/tmp/workspace-a",
		})
		const key2 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config: structuredDisabled,
			workspaceDir: "/tmp/workspace-a",
		})

		expect(key1).not.toBe(key2)
	})

	it("same config produces same cache key (stability)", () => {
		const config = makeConfig()
		const key1 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config,
			workspaceDir: "/tmp/workspace-a",
		})
		const key2 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config,
			workspaceDir: "/tmp/workspace-a",
		})

		expect(key1).toBe(key2)
	})

	it("different agentIds produce different cache keys", () => {
		const config = makeConfig()
		const key1 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config,
			workspaceDir: "/tmp/workspace-a",
		})
		const key2 = buildMongoDBCacheKey({
			agentId: "agent-2",
			config,
			workspaceDir: "/tmp/workspace-a",
		})

		expect(key1).not.toBe(key2)
	})

	it("cache key changes when conversation source is toggled", () => {
		const enabled = makeConfig({
			sources: {
				reference: { enabled: true },
				conversation: { enabled: true },
				structured: { enabled: true },
			},
		})
		const disabled = makeConfig({
			sources: {
				reference: { enabled: true },
				conversation: { enabled: false },
				structured: { enabled: true },
			},
		})

		const key1 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config: enabled,
			workspaceDir: "/tmp/workspace-a",
		})
		const key2 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config: disabled,
			workspaceDir: "/tmp/workspace-a",
		})

		expect(key1).not.toBe(key2)
	})

	it("cache key changes when workspace changes for the same agent and config", () => {
		const config = makeConfig()

		const key1 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config,
			workspaceDir: "/tmp/workspace-a",
		})
		const key2 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config,
			workspaceDir: "/tmp/workspace-b",
		})

		expect(key1).not.toBe(key2)
	})

	it("cache key changes when normalized extra memory paths change", () => {
		const config = makeConfig()

		const key1 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config,
			workspaceDir: "/tmp/workspace-a",
			extraMemoryPaths: ["/tmp/workspace-a/memory/extra.md"],
		})
		const key2 = buildMongoDBCacheKey({
			agentId: "agent-1",
			config,
			workspaceDir: "/tmp/workspace-a",
			extraMemoryPaths: [
				"/tmp/workspace-a/memory/extra.md",
				"/tmp/shared/notes.md",
			],
		})

		expect(key1).not.toBe(key2)
	})
})

// ---------------------------------------------------------------------------
// P2.1 shared Mongo runtime: manager cache lifecycle
// ---------------------------------------------------------------------------

type FakeManager = {
	close: ReturnType<typeof vi.fn>
}

function makeFakeManager(): FakeManager {
	return { close: vi.fn(async () => {}) }
}

describe("getMemorySearchManager runtime (P2.1)", () => {
	const cfg = {} as MemongoConfig
	let createdManagers: FakeManager[]
	let sharedClientClose: ReturnType<typeof vi.fn>
	let sharedConnect: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://localhost:27017")
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_MAX", "")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_IDLE_TTL_MS", "")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_SWEEP_MS", "")
		createdManagers = []
		sharedClientClose = vi.fn(async () => {})
		sharedConnect = vi.fn(
			async () =>
				({
					close: sharedClientClose,
				}) as unknown as import("mongodb").MongoClient,
		)
		setSharedMongoClientConnectForTests(sharedConnect)
		managerMocks.create.mockReset()
		managerMocks.create.mockImplementation(async () => {
			const manager = makeFakeManager()
			createdManagers.push(manager)
			return manager
		})
	})

	afterEach(async () => {
		await closeAllMemorySearchManagers()
		await resetSharedMongoClientRegistryForTests()
		vi.unstubAllEnvs()
	})

	it("flag off: no shared client is passed and the cache stays unbounded", async () => {
		for (let i = 0; i < 60; i++) {
			const result = await getMemorySearchManager({
				cfg,
				agentId: `agent-${i}`,
			})
			expect(result.manager).not.toBeNull()
		}

		expect(managerMocks.create).toHaveBeenCalledTimes(60)
		expect(sharedConnect).not.toHaveBeenCalled()
		for (const call of managerMocks.create.mock.calls) {
			expect(call[0]).not.toHaveProperty("client")
			expect(call[0]).not.toHaveProperty("onClosed")
		}
		// Unbounded: nothing was evicted/closed along the way.
		for (const manager of createdManagers) {
			expect(manager.close).not.toHaveBeenCalled()
		}

		await closeAllMemorySearchManagers()
		for (const manager of createdManagers) {
			expect(manager.close).toHaveBeenCalledTimes(1)
		}
		expect(sharedClientClose).not.toHaveBeenCalled()
	})

	it("flag on: 50 agents share exactly one MongoClient pool", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")

		for (let i = 0; i < 50; i++) {
			const result = await getMemorySearchManager({
				cfg,
				agentId: `agent-${i}`,
			})
			expect(result.manager).not.toBeNull()
		}

		expect(managerMocks.create).toHaveBeenCalledTimes(50)
		expect(sharedConnect).toHaveBeenCalledTimes(1)
		for (const call of managerMocks.create.mock.calls) {
			expect(call[0].client).toBeDefined()
			expect(typeof call[0].onClosed).toBe("function")
		}
		const clients = new Set(
			managerMocks.create.mock.calls.map((call) => call[0].client),
		)
		expect(clients.size).toBe(1)

		await closeAllMemorySearchManagers()
		for (const manager of createdManagers) {
			expect(manager.close).toHaveBeenCalledTimes(1)
		}
		await vi.waitFor(() => {
			expect(sharedClientClose).toHaveBeenCalledTimes(1)
		})
	})

	it("flag on: LRU eviction closes the evicted manager but not the shared client", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_MAX", "2")

		await getMemorySearchManager({ cfg, agentId: "agent-a" })
		await getMemorySearchManager({ cfg, agentId: "agent-b" })
		await getMemorySearchManager({ cfg, agentId: "agent-c" })

		expect(managerMocks.create).toHaveBeenCalledTimes(3)
		// agent-a was least recently used: evicted and closed.
		expect(createdManagers[0]!.close).toHaveBeenCalledTimes(1)
		expect(createdManagers[1]!.close).not.toHaveBeenCalled()
		expect(createdManagers[2]!.close).not.toHaveBeenCalled()
		// The shared client survives manager eviction (refs remain).
		expect(sharedClientClose).not.toHaveBeenCalled()

		// A subsequent create for the evicted agent re-initializes.
		await getMemorySearchManager({ cfg, agentId: "agent-a" })
		expect(managerMocks.create).toHaveBeenCalledTimes(4)
		// ...and evicts the new LRU entry (agent-b).
		expect(createdManagers[1]!.close).toHaveBeenCalledTimes(1)
		expect(sharedClientClose).not.toHaveBeenCalled()
	})

	it("flag on: cache hits refresh recency so hot agents are not evicted", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_MAX", "2")

		await getMemorySearchManager({ cfg, agentId: "agent-a" })
		await getMemorySearchManager({ cfg, agentId: "agent-b" })
		// Touch agent-a so agent-b becomes the LRU entry.
		await getMemorySearchManager({ cfg, agentId: "agent-a" })
		await getMemorySearchManager({ cfg, agentId: "agent-c" })

		expect(managerMocks.create).toHaveBeenCalledTimes(3)
		expect(createdManagers[0]!.close).not.toHaveBeenCalled()
		expect(createdManagers[1]!.close).toHaveBeenCalledTimes(1)
	})

	it("flag on: idle TTL eviction closes managers idle beyond the TTL", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_IDLE_TTL_MS", "1000")
		vi.useFakeTimers()
		try {
			await getMemorySearchManager({ cfg, agentId: "agent-a" })
			await getMemorySearchManager({ cfg, agentId: "agent-b" })

			vi.advanceTimersByTime(2_000)
			await evictIdleMemorySearchManagers()

			expect(createdManagers[0]!.close).toHaveBeenCalledTimes(1)
			expect(createdManagers[1]!.close).toHaveBeenCalledTimes(1)
			expect(sharedClientClose).not.toHaveBeenCalled()

			// Evicted entries re-initialize on next access.
			vi.advanceTimersByTime(10)
			await getMemorySearchManager({ cfg, agentId: "agent-a" })
			expect(managerMocks.create).toHaveBeenCalledTimes(3)
		} finally {
			vi.useRealTimers()
		}
	})

	it("B9: in-flight operation survives LRU eviction; evicted manager closes at quiescence exactly once", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_MAX", "1")

		let resolveOp: (value: string) => void = () => undefined
		const inflight = new Promise<string>((resolve) => {
			resolveOp = resolve
		})

		const { manager: managerA } = await getMemorySearchManager({
			cfg,
			agentId: "agent-a",
		})
		expect(managerA).not.toBeNull()
		// Attach a controllable async operation to the created fake manager.
		const rawA = createdManagers[0] as unknown as {
			search: ReturnType<typeof vi.fn>
		}
		rawA.search = vi.fn(() => inflight)

		// Start the in-flight operation through the handed-out manager.
		const opResult = (
			managerA as unknown as { search: (query: string) => Promise<string> }
		).search("in-flight query")

		// Fetching agent-b with cache max 1 evicts agent-a from the lookup…
		await getMemorySearchManager({ cfg, agentId: "agent-b" })
		// …but the evicted manager must stay alive while the operation runs.
		expect(createdManagers[0]!.close).not.toHaveBeenCalled()

		// Quiescence: once the operation settles, the deferred close runs once.
		resolveOp("done")
		await expect(opResult).resolves.toBe("done")
		await vi.waitFor(() => {
			expect(createdManagers[0]!.close).toHaveBeenCalledTimes(1)
		})
	})

	it("B9: idle eviction defers close until in-flight operations settle", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		vi.stubEnv("MEMONGO_MANAGER_CACHE_IDLE_TTL_MS", "1000")

		let resolveOp: (value: string) => void = () => undefined
		const inflight = new Promise<string>((resolve) => {
			resolveOp = resolve
		})

		vi.useFakeTimers()
		try {
			const { manager: managerA } = await getMemorySearchManager({
				cfg,
				agentId: "agent-a",
			})
			const rawA = createdManagers[0] as unknown as {
				search: ReturnType<typeof vi.fn>
			}
			rawA.search = vi.fn(() => inflight)
			const opResult = (
				managerA as unknown as { search: (query: string) => Promise<string> }
			).search("in-flight query")

			vi.advanceTimersByTime(2_000)
			await evictIdleMemorySearchManagers()

			// Idle-past-TTL and evicted from the lookup, but not closed mid-flight.
			expect(createdManagers[0]!.close).not.toHaveBeenCalled()

			resolveOp("done")
			await expect(opResult).resolves.toBe("done")
			await vi.waitFor(() => {
				expect(createdManagers[0]!.close).toHaveBeenCalledTimes(1)
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it("B9: shutdown leaves the lookup immediately but closes after in-flight operations", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")

		let resolveOp: (value: string) => void = () => undefined
		const inflight = new Promise<string>((resolve) => {
			resolveOp = resolve
		})

		const { manager: managerA } = await getMemorySearchManager({
			cfg,
			agentId: "agent-a",
		})
		const rawA = createdManagers[0] as unknown as {
			search: ReturnType<typeof vi.fn>
		}
		rawA.search = vi.fn(() => inflight)
		const opResult = (
			managerA as unknown as { search: (query: string) => Promise<string> }
		).search("in-flight query")

		// Shutdown starts but must not close the borrowed manager mid-flight.
		const closeAllPromise = closeAllMemorySearchManagers()
		expect(createdManagers[0]!.close).not.toHaveBeenCalled()

		// A new request after shutdown re-initializes (the old entry is gone
		// from the lookup immediately).
		resolveOp("done")
		await expect(opResult).resolves.toBe("done")
		await closeAllPromise
		expect(createdManagers[0]!.close).toHaveBeenCalledTimes(1)
	})

	it("close during initialization closes the manager instead of caching it", async () => {
		let resolveCreate: ((manager: FakeManager) => void) | undefined
		managerMocks.create.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCreate = resolve
				}),
		)

		const pending = getMemorySearchManager({ cfg, agentId: "agent-a" })
		// Let the initialization register in INFLIGHT_INIT.
		await vi.waitFor(() => {
			expect(managerMocks.create).toHaveBeenCalledTimes(1)
		})

		const closing = closeAllMemorySearchManagers()
		const lateManager = makeFakeManager()
		resolveCreate?.(lateManager)

		await closing
		expect(lateManager.close).toHaveBeenCalledTimes(1)

		const result = await pending
		expect(result.manager).toBeNull()
		expect(result.error).toContain("closed during initialization")

		// After the close, a fresh get re-initializes cleanly.
		managerMocks.create.mockImplementation(async () => makeFakeManager())
		const next = await getMemorySearchManager({ cfg, agentId: "agent-a" })
		expect(next.manager).not.toBeNull()
	})

	it("failed initialization releases the shared client reference", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
		managerMocks.create.mockRejectedValue(new Error("bootstrap failed"))

		const result = await getMemorySearchManager({ cfg, agentId: "agent-a" })
		expect(result.manager).toBeNull()
		expect(sharedConnect).toHaveBeenCalledTimes(1)

		// The released client is closed once its last reference drops.
		await vi.waitFor(() => {
			expect(sharedClientClose).toHaveBeenCalledTimes(1)
		})
	})
})
