import type { Db } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { queryCacheCollection } from "./mongodb-schema.js"

const log = createSubsystemLogger("memory:mongodb:query-cache")

/**
 * P2.4: per-write `deleteMany` invalidation drove the cache hit rate toward 0
 * under write load AND put an extra round trip on the write path. Burst
 * invalidation is coalesced instead; staleness is bounded by this window and
 * the TTL backstop.
 */
export const QUERY_CACHE_INVALIDATION_DEBOUNCE_MS = 250

/**
 * Invalidate the cache for one (agent, scope, scopeRef) namespace,
 * immediately. Failure is logged and swallowed: cache invalidation must
 * never break a completed primary mutation.
 */
export async function invalidateQueryCache(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
}): Promise<number> {
	try {
		const result = await queryCacheCollection(
			params.db,
			params.prefix,
		).deleteMany({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
		})
		return result.deletedCount
	} catch (err) {
		log.warn(`query cache invalidation failed: ${String(err)}`)
		return 0
	}
}

/**
 * P2.4 burst coalescer for the hot write path, leading + trailing:
 * - A write to a QUIET namespace fires immediately (leading), so the common
 *   single-write flow keeps its old eager-invalidation behavior and no
 *   staleness window opens.
 * - Repeats inside the window coalesce into ONE trailing fire (no re-arm —
 *   the trailing fire always lands within one window of the first repeat,
 *   so a continuous write stream is throttled to one invalidation per
 *   window and can never starve).
 *
 * Net effect under a burst of N writes: exactly 2 invalidations (leading +
 * trailing) instead of N deleteMany round trips.
 */
export class QueryCacheInvalidationCoalescer {
	private readonly pending = new Map<
		string,
		{
			timer: ReturnType<typeof setTimeout>
			repeat: boolean
			fire: () => void
		}
	>()

	constructor(
		private readonly debounceMs = QUERY_CACHE_INVALIDATION_DEBOUNCE_MS,
	) {}

	/**
	 * Schedule invalidation for a namespace identity. `fire` runs the actual
	 * invalidation; it must never throw (invalidateQueryCache satisfies this).
	 */
	schedule(identity: string, fire: () => void): void {
		const existing = this.pending.get(identity)
		if (existing) {
			// A fire already happened (or is pending) for this burst; the
			// trailing fire covers everything written since.
			existing.repeat = true
			return
		}
		const entry = {
			timer: undefined as unknown as ReturnType<typeof setTimeout>,
			repeat: false,
			fire,
		}
		entry.timer = this.arm(identity)
		this.pending.set(identity, entry)
		try {
			fire()
		} catch (err) {
			// Contractually fire never throws (invalidateQueryCache swallows);
			// never let a cache janitor break the write path regardless.
			log.warn(`query cache invalidation dispatch failed: ${String(err)}`)
		}
	}

	/** Test hook: namespaces currently inside a debounce window. */
	pendingCount(): number {
		return this.pending.size
	}

	private arm(identity: string): ReturnType<typeof setTimeout> {
		const timer = setTimeout(
			() => this.onWindowElapsed(identity),
			this.debounceMs,
		)
		// A cache janitor must never hold the event loop (or a CLI process) open.
		if (typeof timer.unref === "function") {
			timer.unref()
		}
		return timer
	}

	private onWindowElapsed(identity: string): void {
		const entry = this.pending.get(identity)
		if (!entry) {
			return
		}
		if (entry.repeat) {
			entry.repeat = false
			try {
				entry.fire()
			} catch (err) {
				log.warn(`query cache invalidation dispatch failed: ${String(err)}`)
			}
			// Stay armed: further writes inside the next window coalesce again.
			entry.timer = this.arm(identity)
		} else {
			this.pending.delete(identity)
		}
	}
}
