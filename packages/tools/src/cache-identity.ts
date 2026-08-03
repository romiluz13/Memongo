/**
 * P1.5 — canonical cache identity for the middleware context cache.
 *
 * The previous cache was keyed `${userId}:${hash32(query)}`. Under Vercel
 * Fluid Compute (the default), concurrent invocations share one warm global
 * process, so a module-level Map keyed that way serves one tenant's retrieved
 * memory inside another tenant's system prompt — a cross-tenant
 * prompt-injection vector. The 32-bit hash also collided at the birthday
 * bound (~65k entries).
 *
 * The cache key is now a full SHA-256 digest over the canonical identity
 * tuple `{ agentId, apiUrl, apiKeyHash, mode, scope, sessionId, userId, query }`,
 * where `apiKeyHash` is itself the SHA-256 of the raw API key (the raw key
 * never touches the cache). Full-digest keying makes the birthday bound a
 * non-issue and guarantees two tenants never share an entry unless every
 * identity dimension matches.
 *
 * Crypto choice: WebCrypto (`globalThis.crypto.subtle`) instead of
 * `node:crypto`. This package targets the Vercel AI SDK and runs on Vercel
 * Edge / browsers as well as Node; `crypto.subtle` is global in Node 20+ and
 * every edge/browser runtime, keeping the module free of node-only imports.
 * If WebCrypto is absent (exotic runtime), `sha256Hex` returns undefined and
 * the caller BYPASSES the cache entirely — failing safe (no cache) rather
 * than falling back to a weak hash.
 *
 * Production note: this bounded in-process LRU (50 entries / 60s TTL) only
 * dedups within a single warm instance. For multi-instance production
 * deployments the official recommendation is an external KV store (e.g.
 * Vercel KV / Upstash) shared across instances.
 */

export interface CacheIdentity {
	agentId?: string
	apiUrl: string
	/** SHA-256 hex of the raw API key — never the key itself. */
	apiKeyHash: string
	mode: "wake-up" | "full"
	scope?: string
	sessionId?: string
	userId?: string
	query: string
}

/** SHA-256 hex digest, or undefined when WebCrypto is unavailable. */
export async function sha256Hex(text: string): Promise<string | undefined> {
	const subtle = globalThis.crypto?.subtle
	if (!subtle) {
		return undefined
	}
	const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text))
	let hex = ""
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, "0")
	}
	return hex
}

/**
 * Canonical cache key: SHA-256 over a fixed-order JSON tuple (array order is
 * canonical — no object key-order hazard). Undefined fields normalize to "".
 * Returns undefined when WebCrypto is unavailable; callers must bypass the
 * cache in that case.
 */
export async function computeCacheKey(
	identity: CacheIdentity,
): Promise<string | undefined> {
	return sha256Hex(
		JSON.stringify([
			identity.agentId ?? "",
			identity.apiUrl,
			identity.apiKeyHash,
			identity.mode,
			identity.scope ?? "",
			identity.sessionId ?? "",
			identity.userId ?? "",
			identity.query,
		]),
	)
}

/* ------------------------------------------------------------------ */
/*  Bounded LRU: Map with max 50 entries, 60s TTL                     */
/* ------------------------------------------------------------------ */

interface CacheEntry {
	rendered: string
	expiresAt: number
}

const MAX_CACHE_SIZE = 50
const CACHE_TTL_MS = 60_000

const cache = new Map<string, CacheEntry>()

export function cacheGet(key: string): string | undefined {
	const entry = cache.get(key)
	if (!entry) return undefined
	if (Date.now() > entry.expiresAt) {
		cache.delete(key)
		return undefined
	}
	return entry.rendered
}

export function cacheSet(key: string, rendered: string): void {
	if (cache.size >= MAX_CACHE_SIZE) {
		const oldest = cache.keys().next().value
		if (oldest !== undefined) cache.delete(oldest)
	}
	cache.set(key, { rendered, expiresAt: Date.now() + CACHE_TTL_MS })
}

/** Exported for testing only. */
export function _clearCache(): void {
	cache.clear()
}
