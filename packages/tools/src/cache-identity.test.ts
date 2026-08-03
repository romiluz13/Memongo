import { describe, expect, it } from "vitest"
import {
	_clearCache,
	cacheGet,
	cacheSet,
	computeCacheKey,
	sha256Hex,
	type CacheIdentity,
} from "./cache-identity.js"

const BASE_IDENTITY: CacheIdentity = {
	agentId: "agent-1",
	apiUrl: "http://localhost:3847",
	apiKeyHash: "ab".repeat(32),
	mode: "full",
	userId: "user-1",
	query: "what did we discuss?",
}

describe("computeCacheKey (P1.5 canonical cache identity)", () => {
	it("produces a full 64-char SHA-256 hex digest (never truncated)", async () => {
		const key = await computeCacheKey(BASE_IDENTITY)
		expect(key).toMatch(/^[0-9a-f]{64}$/)
	})

	it("is deterministic for identical identities", async () => {
		const a = await computeCacheKey(BASE_IDENTITY)
		const b = await computeCacheKey({ ...BASE_IDENTITY })
		expect(a).toBe(b)
	})

	it("differs for near-identical queries (SHA-256 makes the 32-bit birthday bound a non-issue)", async () => {
		const a = await computeCacheKey(BASE_IDENTITY)
		const b = await computeCacheKey({
			...BASE_IDENTITY,
			query: "what did we discuss!",
		})
		expect(b).not.toBe(a)
		const c = await computeCacheKey({
			...BASE_IDENTITY,
			query: "what did we discuss? ",
		})
		expect(c).not.toBe(a)
		expect(c).not.toBe(b)
	})

	it("differs when only agentId changes", async () => {
		const a = await computeCacheKey(BASE_IDENTITY)
		const b = await computeCacheKey({ ...BASE_IDENTITY, agentId: "agent-2" })
		expect(b).not.toBe(a)
	})

	it("differs when only scope changes", async () => {
		const a = await computeCacheKey(BASE_IDENTITY)
		const b = await computeCacheKey({ ...BASE_IDENTITY, scope: "session" })
		expect(b).not.toBe(a)
		const c = await computeCacheKey({ ...BASE_IDENTITY, scope: "global" })
		expect(c).not.toBe(a)
		expect(c).not.toBe(b)
	})

	it("differs when only the api key hash changes (two deployments never share)", async () => {
		const a = await computeCacheKey(BASE_IDENTITY)
		const b = await computeCacheKey({
			...BASE_IDENTITY,
			apiKeyHash: "cd".repeat(32),
		})
		expect(b).not.toBe(a)
	})

	it("differs when only apiUrl changes", async () => {
		const a = await computeCacheKey(BASE_IDENTITY)
		const b = await computeCacheKey({
			...BASE_IDENTITY,
			apiUrl: "https://api.memongo.example",
		})
		expect(b).not.toBe(a)
	})

	it("never embeds the raw query or api key material in the key", async () => {
		const rawKey = "super-secret-api-key"
		const apiKeyHash = await sha256Hex(rawKey)
		expect(apiKeyHash).toMatch(/^[0-9a-f]{64}$/)
		const key = await computeCacheKey({
			...BASE_IDENTITY,
			apiKeyHash: apiKeyHash as string,
			query: "a very recognizable query string",
		})
		expect(key).not.toContain(rawKey)
		expect(key).not.toContain("recognizable")
	})
})

describe("bounded LRU cache", () => {
	it("refreshes recency on hit: a recently-read old entry survives eviction while an unread newer entry evicts (B13)", () => {
		_clearCache()
		// Fill to capacity (50): k0 is the oldest insertion.
		for (let i = 0; i < 50; i++) cacheSet(`k${i}`, `v${i}`)
		// Read the oldest entry — a true LRU moves it to most-recently-used.
		expect(cacheGet("k0")).toBe("v0")
		// Force exactly one eviction.
		cacheSet("k50", "v50")
		// FIFO (the B13 defect) evicts k0; LRU must evict k1, the oldest
		// entry that was never re-read.
		expect(cacheGet("k0")).toBe("v0")
		expect(cacheGet("k1")).toBeUndefined()
		expect(cacheGet("k50")).toBe("v50")
		_clearCache()
	})

	it("still evicts the oldest entry when nothing was re-read", () => {
		_clearCache()
		for (let i = 0; i < 50; i++) cacheSet(`k${i}`, `v${i}`)
		cacheSet("k50", "v50")
		expect(cacheGet("k0")).toBeUndefined()
		expect(cacheGet("k50")).toBe("v50")
		_clearCache()
	})
})
