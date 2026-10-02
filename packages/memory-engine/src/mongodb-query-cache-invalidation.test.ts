/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection } from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("./mongodb-schema.js", () => ({
	queryCacheCollection: vi.fn(),
}))

import {
	invalidateQueryCache,
	QueryCacheInvalidationCoalescer,
	QUERY_CACHE_INVALIDATION_DEBOUNCE_MS,
} from "./mongodb-query-cache-invalidation.js"
import { queryCacheCollection } from "./mongodb-schema.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const SCOPE = "agent" as const
const SCOPE_REF = "agent-scope-ref"

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
		...overrides,
	} as unknown as Collection
}

describe("invalidateQueryCache (immediate)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("deletes only the mutated tenant namespace", async () => {
		const mockCol = createMockCollection({
			deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
		})
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)

		await expect(
			invalidateQueryCache({
				db: {} as Db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
			}),
		).resolves.toBe(3)
		// Byte-preserved baseline call shape: without a session the
		// deleteMany call takes EXACTLY ONE argument (pinned by the
		// mongodb-kb.test.ts regression suite); a session adds the options
		// argument only inside fenced transactions.
		expect(mockCol.deleteMany).toHaveBeenCalledWith({
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
		})
	})

	it("does not fail a completed primary mutation when invalidation fails", async () => {
		const mockCol = createMockCollection({
			deleteMany: vi.fn().mockRejectedValue(new Error("cache unavailable")),
		})
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)

		await expect(
			invalidateQueryCache({
				db: {} as Db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
			}),
		).resolves.toBe(0)
	})
})

describe("invalidateQueryCache throwOnError opt-in (U15, plan e5ec10dc C3)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("U15a (RED on current bytes): throwOnError:true propagates the operation error instead of swallowing it", async () => {
		const mockCol = createMockCollection({
			deleteMany: vi.fn().mockRejectedValue(new Error("cache unavailable")),
		})
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)

		// On unfixed bytes the param does not exist and the error is
		// swallowed (resolves 0), so this refusal is the meaningful RED.
		await expect(
			invalidateQueryCache({
				db: {} as Db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				throwOnError: true,
			}),
		).rejects.toThrow("cache unavailable")
	})

	it("U15b (passing control): throwOnError:true with a successful delete still returns deletedCount", async () => {
		const mockCol = createMockCollection({
			deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 }),
		})
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)

		await expect(
			invalidateQueryCache({
				db: {} as Db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				throwOnError: true,
			}),
		).resolves.toBe(2)
	})

	it("U15c (passing control): default (absent) keeps the byte-preserved swallow — returns 0 and logs a warn", async () => {
		const mockCol = createMockCollection({
			deleteMany: vi.fn().mockRejectedValue(new Error("cache unavailable")),
		})
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			await expect(
				invalidateQueryCache({
					db: {} as Db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					scope: SCOPE,
					scopeRef: SCOPE_REF,
				}),
			).resolves.toBe(0)
			expect(
				warnSpy.mock.calls.some((args) =>
					String(args[0]).includes("query cache invalidation failed"),
				),
			).toBe(true)
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("U15d (passing control): explicit throwOnError:false keeps the documented swallow contract", async () => {
		const mockCol = createMockCollection({
			deleteMany: vi.fn().mockRejectedValue(new Error("cache unavailable")),
		})
		vi.mocked(queryCacheCollection).mockReturnValue(mockCol)
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			await expect(
				invalidateQueryCache({
					db: {} as Db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					throwOnError: false,
				}),
			).resolves.toBe(0)
			expect(
				warnSpy.mock.calls.some((args) =>
					String(args[0]).includes("query cache invalidation failed"),
				),
			).toBe(true)
		} finally {
			warnSpy.mockRestore()
		}
	})

	// The coalescer's "fire never throws" contract is pinned unchanged by
	// the existing QueryCacheInvalidationCoalescer block below: those cases
	// must stay GREEN after the C3 opt-in lands.
})

describe("QueryCacheInvalidationCoalescer (P2.4)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("a write to a quiet namespace fires immediately (leading edge)", () => {
		const fire = vi.fn()
		const coalescer = new QueryCacheInvalidationCoalescer()

		coalescer.schedule("ns", fire)

		expect(fire).toHaveBeenCalledTimes(1)
	})

	it("repeats inside the window coalesce into ONE trailing fire after the window", async () => {
		const fire = vi.fn()
		const coalescer = new QueryCacheInvalidationCoalescer()

		coalescer.schedule("ns", fire)
		expect(fire).toHaveBeenCalledTimes(1)

		coalescer.schedule("ns", fire)
		coalescer.schedule("ns", fire)
		expect(fire).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(QUERY_CACHE_INVALIDATION_DEBOUNCE_MS)
		expect(fire).toHaveBeenCalledTimes(2)

		// Window closes quietly — no further fires.
		await vi.advanceTimersByTimeAsync(QUERY_CACHE_INVALIDATION_DEBOUNCE_MS)
		expect(fire).toHaveBeenCalledTimes(2)
		expect(coalescer.pendingCount()).toBe(0)
	})

	it("a continuous write stream is throttled to one invalidation per window (no starvation)", async () => {
		const fire = vi.fn()
		const coalescer = new QueryCacheInvalidationCoalescer()

		coalescer.schedule("ns", fire) // leading: 1
		for (let window = 0; window < 3; window++) {
			coalescer.schedule("ns", fire)
			await vi.advanceTimersByTimeAsync(
				QUERY_CACHE_INVALIDATION_DEBOUNCE_MS / 2,
			)
			coalescer.schedule("ns", fire)
			await vi.advanceTimersByTimeAsync(
				QUERY_CACHE_INVALIDATION_DEBOUNCE_MS / 2,
			)
		}

		// 1 leading + 3 trailing (one per elapsed window), never more.
		expect(fire).toHaveBeenCalledTimes(4)
	})

	it("tracks namespaces independently", async () => {
		const fireA = vi.fn()
		const fireB = vi.fn()
		const coalescer = new QueryCacheInvalidationCoalescer()

		coalescer.schedule("ns-a", fireA)
		coalescer.schedule("ns-b", fireB)
		coalescer.schedule("ns-a", fireA)

		await vi.advanceTimersByTimeAsync(QUERY_CACHE_INVALIDATION_DEBOUNCE_MS)

		expect(fireA).toHaveBeenCalledTimes(2)
		expect(fireB).toHaveBeenCalledTimes(1)
	})

	it("a throwing fire callback never breaks the write path", async () => {
		const fire = vi.fn(() => {
			throw new Error("kaboom")
		})
		const coalescer = new QueryCacheInvalidationCoalescer()

		expect(() => coalescer.schedule("ns", fire)).not.toThrow()
		coalescer.schedule("ns", fire)
		await expect(
			vi.advanceTimersByTimeAsync(QUERY_CACHE_INVALIDATION_DEBOUNCE_MS),
		).resolves.toBeDefined()
	})
})
