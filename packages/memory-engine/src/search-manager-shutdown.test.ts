import { setImmediate } from "node:timers/promises"
import type { MemongoConfig } from "@memongo/lib"
import type { MongoClient } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	resetSharedMongoClientRegistryForTests,
	setSharedMongoClientConnectForTests,
} from "./mongodb-client-registry.js"
import {
	closeAllMemorySearchManagers,
	evictIdleMemorySearchManagers,
	getMemorySearchManager,
} from "./search-manager.js"

function deferred() {
	let resolve = () => {}
	let reject: (error: Error) => void = () => {}
	const promise = new Promise<void>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}
const cfg: MemongoConfig = {
	memory: {
		backend: "mongodb",
		mongodb: { uri: "mongodb://offline.invalid/task257" },
	},
}
const clientClose = vi.fn(async () => {})
const client = { close: clientClose } as unknown as MongoClient
const queues: ReturnType<typeof deferred>[] = []
const managers: MongoDBMemoryManager[] = []

beforeEach(() => {
	vi.stubEnv("MEMONGO_SHARED_CLIENT", "1")
	vi.stubEnv("MEMONGO_MANAGER_CACHE_IDLE_TTL_MS", "1")
	vi.stubEnv("MEMONGO_MANAGER_CACHE_SWEEP_MS", "600000")
	clientClose.mockReset()
	clientClose.mockResolvedValue(undefined)
	setSharedMongoClientConnectForTests(async () => client)
	// Factory-only substitution: cache, borrows, manager.close, and worker stop
	// stay real. Seed the actual write queue held at an external I/O boundary;
	// constructor/startup need no database, filesystem watcher, or provider.
	vi.spyOn(MongoDBMemoryManager, "create").mockImplementation(
		async (params) => {
			const queue = deferred()
			queues.push(queue)
			const manager = Object.assign(
				Object.create(MongoDBMemoryManager.prototype),
				{
					closed: false,
					client: params.client ?? client,
					ownsClient: !params.client,
					onClosed: params.onClosed,
					writeQueue: queue.promise,
					derivationSchedulingQueue: Promise.resolve(),
					derivationQueue: Promise.resolve(),
					memoryJobOperationContexts: new Map(),
				},
			) as MongoDBMemoryManager
			managers.push(manager)
			return manager
		},
	)
})
afterEach(async () => {
	for (const queue of queues) queue.resolve()
	await closeAllMemorySearchManagers()
	await resetSharedMongoClientRegistryForTests()
	queues.length = 0
	managers.length = 0
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("real manager queue shutdown", () => {
	it("awaits an idle manager's close before closing its shared client", async () => {
		const result = await getMemorySearchManager({ cfg, agentId: "idle" })
		expect(result.manager).not.toBeNull()
		const finalFlush = deferred()
		Reflect.set(managers[0], "accessTracker", {
			close: () => finalFlush.promise,
		})
		const shutdown = closeAllMemorySearchManagers()
		let finished = false
		void shutdown.then(() => {
			finished = true
		})
		try {
			await setImmediate()
			expect(clientClose).not.toHaveBeenCalled()
			expect(finished).toBe(false)
			queues[0].resolve()
			await setImmediate()
			expect(clientClose).not.toHaveBeenCalled()
			expect(finished).toBe(false)
		} finally {
			queues[0].resolve()
			finalFlush.resolve()
			await shutdown
		}
		expect(clientClose).toHaveBeenCalledTimes(1)
	})
})

describe("evicted manager and ownership controls", () => {
	it("retains an idle close after TTL eviction removes its lookup entry", async () => {
		await getMemorySearchManager({ cfg, agentId: "idle-evicted" })
		const close = vi.spyOn(managers[0], "close")
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10)
		await evictIdleMemorySearchManagers()
		expect(close).toHaveBeenCalledTimes(1)
		const shutdown = closeAllMemorySearchManagers()
		let finished = false
		void shutdown.then(() => {
			finished = true
		})
		try {
			await setImmediate()
			expect(clientClose).not.toHaveBeenCalled()
			expect(finished).toBe(false)
		} finally {
			queues[0].resolve()
			await shutdown
		}
		expect(close).toHaveBeenCalledTimes(1)
		expect(clientClose).toHaveBeenCalledTimes(1)
	})

	it.each([
		false,
		true,
	])("awaits a borrowed real sync and queue, prior LRU eviction=%s", async (priorEviction) => {
		vi.stubEnv("MEMONGO_MANAGER_CACHE_MAX", "1")
		const { manager } = await getMemorySearchManager({
			cfg,
			agentId: "borrowed",
		})
		const provider = deferred()
		// Real sync() returns the outstanding provider-backed sync; the facade
		// must release its borrow before real close() starts draining the queue.
		Reflect.set(managers[0], "syncing", provider.promise)
		const close = vi.spyOn(managers[0], "close")
		const operation = manager?.sync?.()
		if (priorEviction) {
			await getMemorySearchManager({ cfg, agentId: "replacement" })
			queues[1].resolve()
		}
		const shutdown = closeAllMemorySearchManagers()
		let finished = false
		void shutdown.then(() => {
			finished = true
		})
		try {
			await setImmediate()
			expect(close).not.toHaveBeenCalled()
			expect(clientClose).not.toHaveBeenCalled()
			expect(finished).toBe(false)
			provider.resolve()
			await operation
			await setImmediate()
			expect(close).toHaveBeenCalledTimes(1)
			expect(clientClose).not.toHaveBeenCalled()
			expect(finished).toBe(false)
		} finally {
			provider.resolve()
			queues[0].resolve()
			await operation
			await shutdown
		}
		expect(close).toHaveBeenCalledTimes(1)
		expect(clientClose).toHaveBeenCalledTimes(1)
	})

	it("drains a legacy manager before its owned client is closed", async () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "0")
		await getMemorySearchManager({ cfg, agentId: "legacy" })
		const shutdown = closeAllMemorySearchManagers()
		try {
			await setImmediate()
			expect(clientClose).not.toHaveBeenCalled()
		} finally {
			queues[0].resolve()
			await shutdown
		}
		expect(clientClose).toHaveBeenCalledTimes(1)
	})

	it("leaves uncached caller-owned managers to their caller", async () => {
		const { manager } = await getMemorySearchManager({
			cfg,
			agentId: "owned",
			ownership: "owned",
		})
		const close = vi.spyOn(managers[0], "close")
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10)
		await evictIdleMemorySearchManagers()
		expect(close).not.toHaveBeenCalled()
		expect(clientClose).not.toHaveBeenCalled()
		const closing = manager?.close?.()
		try {
			await setImmediate()
			expect(clientClose).not.toHaveBeenCalled()
		} finally {
			queues[0].resolve()
			await closing
		}
		await setImmediate()
		expect(clientClose).toHaveBeenCalledTimes(1)
	})

	it("settles a rejected real queue before best-effort shared shutdown", async () => {
		await getMemorySearchManager({ cfg, agentId: "failed-queue" })
		const shutdown = closeAllMemorySearchManagers()
		await setImmediate()
		expect(clientClose).not.toHaveBeenCalled()
		queues[0].reject(new Error("offline queued write failed"))
		await expect(shutdown).resolves.toBeUndefined()
		expect(clientClose).toHaveBeenCalledTimes(1)
	})
})
