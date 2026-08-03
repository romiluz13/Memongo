import { type MemongoConfig, createSubsystemLogger } from "@memongo/lib"
import type {
	ResolvedMemoryBackendConfig,
	ResolvedMongoDBConfig,
} from "./backend-config.js"
import {
	resolveAgentMemorySearchExtraPaths,
	resolveAgentWorkspaceDir,
} from "./agent-config.js"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import { normalizeExtraMemoryPaths } from "./internal.js"
import {
	acquireSharedMongoClient,
	closeAllSharedMongoClients,
	isSharedMongoClientEnabled,
	releaseSharedMongoClient,
} from "./mongodb-client-registry.js"
import type { MemorySearchManager } from "./types.js"

const log = createSubsystemLogger("memory")

type ManagerCacheEntry = {
	manager: MemorySearchManager
	lastUsedAt: number
}

/**
 * Manager cache. When MEMONGO_SHARED_CLIENT is off the cache is unbounded and
 * entries live forever, exactly as before P2.1. When the shared-client runtime
 * is on, the cache is LRU-bounded (MEMONGO_MANAGER_CACHE_MAX, default 50) and
 * idle entries are evicted after MEMONGO_MANAGER_CACHE_IDLE_TTL_MS (default
 * 10 minutes); eviction closes the manager's workers/timers but never the
 * shared MongoClient.
 */
const MONGODB_MANAGER_CACHE = new Map<string, ManagerCacheEntry>()

/**
 * In-flight initialization promises keyed by the same cache key. This
 * prevents duplicate concurrent `MongoDBMemoryManager.create()` calls for
 * the same agent+config, which was the root cause of intermittent
 * "initialization returned null" errors under concurrent benchmark traffic.
 */
const INFLIGHT_INIT = new Map<string, Promise<MemorySearchManagerResult>>()

/**
 * Bumped by closeAllMemorySearchManagers. An initialization that started
 * before a close but resolves after it must close the fresh manager
 * immediately instead of caching it (shutdown-race leak fix, P2.1).
 */
let closeGeneration = 0

const DEFAULT_MANAGER_CACHE_MAX = 50
const DEFAULT_MANAGER_CACHE_IDLE_TTL_MS = 10 * 60 * 1_000
const DEFAULT_MANAGER_CACHE_SWEEP_MS = 60_000

let idleSweepTimer: NodeJS.Timeout | null = null

export type MemorySearchManagerResult = {
	manager: MemorySearchManager | null
	error?: string
}

function resolvePositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim()
	if (!raw) {
		return fallback
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback
	}
	return Math.floor(parsed)
}

function resolveManagerCacheMax(): number {
	return resolvePositiveIntEnv(
		"MEMONGO_MANAGER_CACHE_MAX",
		DEFAULT_MANAGER_CACHE_MAX,
	)
}

function resolveManagerCacheIdleTtlMs(): number {
	return resolvePositiveIntEnv(
		"MEMONGO_MANAGER_CACHE_IDLE_TTL_MS",
		DEFAULT_MANAGER_CACHE_IDLE_TTL_MS,
	)
}

function resolveManagerCacheSweepMs(): number {
	return resolvePositiveIntEnv(
		"MEMONGO_MANAGER_CACHE_SWEEP_MS",
		DEFAULT_MANAGER_CACHE_SWEEP_MS,
	)
}

async function closeManager(manager: MemorySearchManager): Promise<void> {
	try {
		await manager.close?.()
	} catch (err) {
		log.warn(`failed to close mongodb memory manager: ${String(err)}`)
	}
}

function ensureIdleSweepTimer(): void {
	if (idleSweepTimer) {
		return
	}
	idleSweepTimer = setInterval(() => {
		void evictIdleMemorySearchManagers()
	}, resolveManagerCacheSweepMs())
	idleSweepTimer.unref?.()
}

function stopIdleSweepTimer(): void {
	if (idleSweepTimer) {
		clearInterval(idleSweepTimer)
		idleSweepTimer = null
	}
}

/** Evict managers idle beyond the TTL. Shared-client runtime only. */
export async function evictIdleMemorySearchManagers(): Promise<void> {
	const ttl = resolveManagerCacheIdleTtlMs()
	const now = Date.now()
	for (const [key, entry] of Array.from(MONGODB_MANAGER_CACHE.entries())) {
		if (now - entry.lastUsedAt < ttl) {
			continue
		}
		MONGODB_MANAGER_CACHE.delete(key)
		await closeManager(entry.manager)
	}
	if (MONGODB_MANAGER_CACHE.size === 0) {
		stopIdleSweepTimer()
	}
}

/** Insert into the cache, evicting least-recently-used managers over the max. */
async function cacheManager(
	cacheKey: string,
	manager: MemorySearchManager,
): Promise<void> {
	MONGODB_MANAGER_CACHE.set(cacheKey, { manager, lastUsedAt: Date.now() })
	if (!isSharedMongoClientEnabled()) {
		return
	}
	ensureIdleSweepTimer()
	const max = resolveManagerCacheMax()
	while (MONGODB_MANAGER_CACHE.size > max) {
		const oldestKey = MONGODB_MANAGER_CACHE.keys().next().value
		if (oldestKey === undefined || oldestKey === cacheKey) {
			break
		}
		const entry = MONGODB_MANAGER_CACHE.get(oldestKey)
		MONGODB_MANAGER_CACHE.delete(oldestKey)
		if (entry) {
			await closeManager(entry.manager)
		}
	}
}

export async function getMemorySearchManager(params: {
	cfg: MemongoConfig
	agentId: string
	purpose?: "default" | "status"
}): Promise<MemorySearchManagerResult> {
	let resolved: ResolvedMemoryBackendConfig
	try {
		resolved = resolveMemoryBackendConfig(params)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		log.warn(`memory backend resolution failed: ${message}`)
		return { manager: null, error: message }
	}

	if (!resolved.mongodb) {
		return { manager: null, error: "mongodb memory config missing" }
	}

	const extraPaths = resolveAgentMemorySearchExtraPaths(
		params.cfg,
		params.agentId,
	)
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId)
	const extraMemoryPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths)
	const cacheKey = buildMongoDBCacheKey({
		agentId: params.agentId,
		config: resolved.mongodb,
		workspaceDir,
		extraMemoryPaths,
	})
	const cached = MONGODB_MANAGER_CACHE.get(cacheKey)
	if (cached) {
		cached.lastUsedAt = Date.now()
		if (isSharedMongoClientEnabled()) {
			// Refresh recency order so LRU eviction picks the true oldest entry.
			MONGODB_MANAGER_CACHE.delete(cacheKey)
			MONGODB_MANAGER_CACHE.set(cacheKey, cached)
		}
		return { manager: cached.manager }
	}

	// Deduplicate concurrent initialization for the same cache key. Without
	// this guard, two requests arriving before the first create() completes
	// would both attempt full MongoDB connection + index bootstrap in
	// parallel, causing intermittent connection failures.
	const inflight = INFLIGHT_INIT.get(cacheKey)
	if (inflight) {
		return inflight
	}

	const initPromise = initializeManager({
		cfg: params.cfg,
		agentId: params.agentId,
		resolved,
		extraMemoryPaths,
		cacheKey,
	})
	INFLIGHT_INIT.set(cacheKey, initPromise)
	try {
		return await initPromise
	} finally {
		INFLIGHT_INIT.delete(cacheKey)
	}
}

async function initializeManager(params: {
	cfg: MemongoConfig
	agentId: string
	resolved: ResolvedMemoryBackendConfig
	extraMemoryPaths?: string[]
	cacheKey: string
}): Promise<MemorySearchManagerResult> {
	const generation = closeGeneration
	const sharedRuntime = isSharedMongoClientEnabled()
	let sharedClientUri: string | null = null
	let sharedClientAcquired = false
	let manager: MemorySearchManager | null = null
	try {
		const { MongoDBMemoryManager, buildMongoClientOptions } = await import(
			"./mongodb-manager.js"
		)
		let client: import("mongodb").MongoClient | undefined
		if (sharedRuntime && params.resolved.mongodb) {
			sharedClientUri = params.resolved.mongodb.uri
			client = await acquireSharedMongoClient({
				uri: sharedClientUri,
				options: buildMongoClientOptions(params.resolved.mongodb),
			})
			sharedClientAcquired = true
		}
		const releaseSharedClient = () => {
			if (sharedClientAcquired && sharedClientUri) {
				sharedClientAcquired = false
				releaseSharedMongoClient(sharedClientUri)
			}
		}
		manager = await MongoDBMemoryManager.create({
			cfg: params.cfg,
			agentId: params.agentId,
			resolved: params.resolved,
			extraPaths: params.extraMemoryPaths,
			...(client ? { client, onClosed: releaseSharedClient } : {}),
		})
		if (generation !== closeGeneration) {
			// closeAllMemorySearchManagers ran while this manager was
			// initializing: close it immediately instead of caching it.
			await closeManager(manager)
			return {
				manager: null,
				error: "memory managers closed during initialization",
			}
		}
		await cacheManager(params.cacheKey, manager)
		return { manager }
	} catch (err) {
		if (manager) {
			// create() succeeded but a later step failed: close the manager so
			// its onClosed hook releases the shared-client reference exactly once.
			await closeManager(manager)
		} else if (sharedClientAcquired && sharedClientUri) {
			releaseSharedMongoClient(sharedClientUri)
		}
		const message = err instanceof Error ? err.message : String(err)
		const error = `mongodb memory unavailable: ${message}`
		log.warn(error)
		return { manager: null, error }
	}
}

export async function closeAllMemorySearchManagers(): Promise<void> {
	closeGeneration++
	// Await in-flight initializations instead of dropping them: any manager
	// that finishes during close sees the bumped generation and is closed
	// immediately, so nothing leaks.
	const inflight = Array.from(INFLIGHT_INIT.values())
	if (inflight.length > 0) {
		await Promise.allSettled(inflight)
	}
	INFLIGHT_INIT.clear()
	stopIdleSweepTimer()
	const entries = Array.from(MONGODB_MANAGER_CACHE.values())
	MONGODB_MANAGER_CACHE.clear()
	for (const entry of entries) {
		await closeManager(entry.manager)
	}
	await closeAllSharedMongoClients()
}

// IMPORTANT: stableSerialize includes sources config in the cache key.
// Changing source policy (reference/conversation/structured enabled/disabled)
// at runtime will produce a different cache key, ensuring no stale managers.
export function buildMongoDBCacheKey(params: {
	agentId: string
	config: ResolvedMongoDBConfig
	workspaceDir: string
	extraMemoryPaths?: string[]
}): string {
	return stableSerialize({
		agentId: params.agentId,
		config: params.config,
		workspaceDir: params.workspaceDir,
		extraMemoryPaths: params.extraMemoryPaths ?? [],
	})
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`
	}

	const entries = Object.entries(value).toSorted(([a], [b]) =>
		a.localeCompare(b),
	)
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
		.join(",")}}`
}
