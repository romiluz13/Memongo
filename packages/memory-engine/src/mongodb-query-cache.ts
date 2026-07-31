import { createHash } from "node:crypto"
import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { queryCacheCollection } from "./mongodb-schema.js"
import {
	buildVectorSearchStage,
	runSearchAggregateWithRetry,
} from "./mongodb-search.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import type { MemorySearchResult } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:query-cache")

// The tier-2 probe embeds the query server-side, so its floor is one provider
// round-trip; the cap only cuts off pathological cases, not the happy path.
const SEMANTIC_PROBE_MAX_TIME_MS = 1_500

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryCacheEntry = {
	queryHash: string
	queryNorm: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	results: MemorySearchResult[]
	pathUsed: string
	sourceScope: string
	createdAt: Date
	expiresAt: Date
	hitCount: number
	lastHitAt: Date
}

export type QueryCacheConfig = {
	enabled: boolean
	conversationTtlSec: number
	kbTtlSec: number
	similarityThreshold: number
}

export const DEFAULT_CACHE_CONFIG: QueryCacheConfig = {
	enabled: true,
	conversationTtlSec: 300, // 5 minutes
	kbTtlSec: 3600, // 1 hour
	similarityThreshold: 0.95,
}

export type CacheCheckResult = {
	hit: boolean
	tier: "exact" | "semantic" | "miss"
	results: MemorySearchResult[]
	pathUsed?: string
	sourceScope?: string
	/**
	 * #66: measurement only — cost of each tier of this check. The semantic
	 * probe carries a server-side embedding round trip capped at
	 * SEMANTIC_PROBE_MAX_TIME_MS, so it must be attributable on its own.
	 */
	latency?: { exactMs: number; semanticMs: number }
}

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize query for consistent hashing: lowercase, collapse whitespace, trim. */
export function normalizeQuery(query: string): string {
	return query.toLowerCase().replace(/\s+/g, " ").trim()
}

/** SHA-256 hash of normalized query string. */
export function hashQuery(normalizedQuery: string): string {
	return createHash("sha256").update(normalizedQuery).digest("hex")
}

// ---------------------------------------------------------------------------
// checkCache — Two-tier lookup
// ---------------------------------------------------------------------------

/**
 * Two-tier cache check:
 * Tier 1: Exact SHA-256 hash match via findOne on unique index.
 * Tier 2: $vectorSearch with autoEmbed on queryNorm field, cosine >= threshold.
 *
 * On hit: increments hitCount and updates lastHitAt (fire-and-forget).
 */
export async function checkCache(params: {
	db: Db
	prefix: string
	query: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	config: QueryCacheConfig
	vectorIndexName?: string
}): Promise<CacheCheckResult> {
	const { db, prefix, query, agentId, scope, scopeRef, config } = params

	if (!config.enabled) {
		return { hit: false, tier: "miss", results: [] }
	}

	const normalized = normalizeQuery(query)
	if (!normalized) {
		return { hit: false, tier: "miss", results: [] }
	}

	const cacheStart = Date.now()
	// #66: measurement only — the two tiers are reported separately so a slow
	// check can be attributed to the lookup or to the embedding probe.
	let exactMs = 0
	let semanticMs = 0
	const col = queryCacheCollection(db, prefix)
	const qHash = hashQuery(normalized)
	const now = new Date()

	// Tier 1: Exact match
	try {
		const exactStart = Date.now()
		const exact = await col.findOne({
			queryHash: qHash,
			agentId,
			scope,
			scopeRef,
			expiresAt: { $gt: now },
		})
		exactMs = Date.now() - exactStart
		if (exact) {
			// Fire-and-forget hit count increment
			col
				.findOneAndUpdate(
					{ _id: exact._id },
					{ $inc: { hitCount: 1 }, $set: { lastHitAt: now } },
				)
				.catch((err) => {
					log.warn("cache hit count update failed", { error: err })
				})
			emitTelemetry(db, prefix, {
				meta: { agentId, operation: "cache-check" },
				durationMs: Date.now() - cacheStart,
				ok: true,
				cacheHit: true,
			})
			return {
				hit: true,
				tier: "exact",
				results: exact.results as MemorySearchResult[],
				pathUsed: exact.pathUsed as string,
				sourceScope: exact.sourceScope as string,
				latency: { exactMs, semanticMs },
			}
		}
	} catch (err) {
		exactMs = Date.now() - cacheStart
		log.warn("cache exact lookup failed", { error: err })
		emitTelemetry(db, prefix, {
			meta: { agentId, operation: "cache-check" },
			durationMs: Date.now() - cacheStart,
			ok: false,
			cacheHit: false,
		})
		return {
			hit: false,
			tier: "miss",
			results: [],
			latency: { exactMs, semanticMs },
		}
	}

	// Tier 2: Semantic similarity via $vectorSearch with autoEmbed
	const semanticStart = Date.now()
	try {
		// The semantic probe embeds the query server-side — a full provider
		// round-trip (~2.4s measured on Atlas) — so never pay it against a cache
		// that cannot hit. estimatedDocumentCount is a collstats metadata read.
		const cachedEntries = await col.estimatedDocumentCount()
		if (cachedEntries === 0) {
			semanticMs = Date.now() - semanticStart
			emitTelemetry(db, prefix, {
				meta: { agentId, operation: "cache-check" },
				durationMs: Date.now() - cacheStart,
				ok: true,
				cacheHit: false,
			})
			return {
				hit: false,
				tier: "miss",
				results: [],
				latency: { exactMs, semanticMs },
			}
		}
		const indexName = params.vectorIndexName ?? `${prefix}query_cache_vector`
		const vsStage = buildVectorSearchStage({
			queryVector: null,
			queryText: normalized,
			embeddingMode: "automated",
			indexName,
			numCandidates: 20,
			limit: 1,
			filter: { agentId, scope, scopeRef, expiresAt: { $gt: new Date() } },
			textFieldPath: "queryNorm",
		})
		if (!vsStage) {
			semanticMs = Date.now() - semanticStart
			emitTelemetry(db, prefix, {
				meta: { agentId, operation: "cache-check" },
				durationMs: Date.now() - cacheStart,
				ok: true,
				cacheHit: false,
			})
			return {
				hit: false,
				tier: "miss",
				results: [],
				latency: { exactMs, semanticMs },
			}
		}

		const pipeline: Document[] = [
			{ $vectorSearch: vsStage },
			{ $limit: 1 },
			{
				$project: {
					_id: 1,
					results: 1,
					pathUsed: 1,
					sourceScope: 1,
					expiresAt: 1,
					score: { $meta: "vectorSearchScore" },
				},
			},
		]

		// A cache probe slower than its budget costs more than it can save; let
		// the server abandon it rather than serialize it in front of the search.
		const candidates = await runSearchAggregateWithRetry(col, pipeline, {
			aggregateOptions: { maxTimeMS: SEMANTIC_PROBE_MAX_TIME_MS },
		})
		semanticMs = Date.now() - semanticStart
		if (
			candidates.length > 0 &&
			candidates[0].score >= config.similarityThreshold &&
			candidates[0].expiresAt > now
		) {
			const match = candidates[0]
			// Fire-and-forget hit count increment
			col
				.findOneAndUpdate(
					{ _id: match._id },
					{ $inc: { hitCount: 1 }, $set: { lastHitAt: now } },
				)
				.catch((err) => {
					log.warn("cache hit count update failed (semantic)", { error: err })
				})
			emitTelemetry(db, prefix, {
				meta: { agentId, operation: "cache-check" },
				durationMs: Date.now() - cacheStart,
				ok: true,
				cacheHit: true,
			})
			return {
				hit: true,
				tier: "semantic",
				results: match.results as MemorySearchResult[],
				pathUsed: match.pathUsed as string,
				sourceScope: match.sourceScope as string,
				latency: { exactMs, semanticMs },
			}
		}
	} catch (err) {
		semanticMs = Date.now() - semanticStart
		// Semantic tier failure is non-fatal — degrade to cache miss
		log.warn("cache semantic lookup failed", { error: err })
	}

	emitTelemetry(db, prefix, {
		meta: { agentId, operation: "cache-check" },
		durationMs: Date.now() - cacheStart,
		ok: true,
		cacheHit: false,
	})
	return {
		hit: false,
		tier: "miss",
		results: [],
		latency: { exactMs, semanticMs },
	}
}

// ---------------------------------------------------------------------------
// writeCache — Fire-and-forget
// ---------------------------------------------------------------------------

/**
 * Write search results to cache. Fire-and-forget: does not block caller.
 * Uses upsert to handle race conditions (two identical queries completing simultaneously).
 */
export function writeCache(params: {
	db: Db
	prefix: string
	query: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	results: MemorySearchResult[]
	pathUsed: string
	sourceScope: string
	ttlSec: number
}): void {
	const {
		db,
		prefix,
		query,
		agentId,
		scope,
		scopeRef,
		results,
		pathUsed,
		sourceScope,
		ttlSec,
	} = params

	const normalized = normalizeQuery(query)
	if (!normalized || results.length === 0) {
		return
	}

	const now = new Date()
	const expiresAt = new Date(now.getTime() + ttlSec * 1000)
	const qHash = hashQuery(normalized)
	const col = queryCacheCollection(db, prefix)

	col
		.updateOne(
			{ queryHash: qHash, agentId, scope, scopeRef },
			{
				$setOnInsert: {
					queryNorm: normalized,
					createdAt: now,
					hitCount: 0,
				},
				$set: {
					results,
					pathUsed,
					sourceScope,
					expiresAt,
					lastHitAt: now,
				},
			},
			{ upsert: true },
		)
		.catch((err) => {
			log.warn("cache write failed", { error: err })
		})
}
