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
import type { MemorySearchManager } from "./types.js"

const log = createSubsystemLogger("memory")
const MONGODB_MANAGER_CACHE = new Map<string, MemorySearchManager>()

/**
 * In-flight initialization promises keyed by the same cache key. This
 * prevents duplicate concurrent `MongoDBMemoryManager.create()` calls for
 * the same agent+config, which was the root cause of intermittent
 * "initialization returned null" errors under concurrent benchmark traffic.
 */
const INFLIGHT_INIT = new Map<string, Promise<MemorySearchManagerResult>>()

export type MemorySearchManagerResult = {
	manager: MemorySearchManager | null
	error?: string
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
		return { manager: cached }
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
	try {
		const { MongoDBMemoryManager } = await import("./mongodb-manager.js")
		const manager = await MongoDBMemoryManager.create({
			cfg: params.cfg,
			agentId: params.agentId,
			resolved: params.resolved,
			extraPaths: params.extraMemoryPaths,
		})
		MONGODB_MANAGER_CACHE.set(params.cacheKey, manager)
		return { manager }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const error = `mongodb memory unavailable: ${message}`
		log.warn(error)
		return { manager: null, error }
	}
}

export async function closeAllMemorySearchManagers(): Promise<void> {
	INFLIGHT_INIT.clear()
	const managers = Array.from(MONGODB_MANAGER_CACHE.values())
	MONGODB_MANAGER_CACHE.clear()
	for (const manager of managers) {
		try {
			await manager.close?.()
		} catch (err) {
			log.warn(`failed to close mongodb memory manager: ${String(err)}`)
		}
	}
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
