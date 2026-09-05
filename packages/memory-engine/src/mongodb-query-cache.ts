import { createHash } from "node:crypto"
import type { Collection, Db, Document } from "mongodb"
import {
	type MemoryMongoDBFusionMethod,
	type MemoryMongoDBQueryEmbeddingModel,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import type { ConversationEvidenceMode } from "./mongodb-conversation-evidence-mode.js"
import { recordEmbeddingSpend } from "./mongodb-cost-ledger.js"
import type { RerankConfig } from "./mongodb-reranker.js"
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
//
// WS-11 change 5 (09-report U2): this 1.5s probe + 10s maxTimeMS aggregate +
// 2s rerank timeout = the documented 13.5s tail. Exported so
// mongodb-search-latency-composition.test.ts pins the arithmetic.
export const SEMANTIC_PROBE_MAX_TIME_MS = 1_500

// P2.4: invalidation (immediate delete + the burst coalescer used by the
// manager's hot write path) lives in a sibling module; re-exported here so
// the public seam of this module is unchanged.
export { invalidateQueryCache } from "./mongodb-query-cache-invalidation.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * P2.4: the resolved search parameters that change what a query returns.
 * Callers must pass values AFTER defaults are applied so two differently
 * spelled requests for the same effective query share one cache entry. These
 * fold into `queryHash` (no schema/index change) and are mirrored onto the
 * stored document as `keySuffix` so the tier-2 semantic probe can reject a
 * similarly-worded entry cached under different parameterization.
 */
export type QueryCacheKeyParams = {
	maxResults?: number
	minScore?: number
	timeRange?: { preset?: string; start?: string; end?: string }
	questionDate?: Date
	queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
	conversationEvidenceMode?: ConversationEvidenceMode
	fusionMethod?: MemoryMongoDBFusionMethod
	reranker?: Pick<
		RerankConfig,
		| "enabled"
		| "model"
		| "topN"
		| "minScore"
		| "instruction"
		| "recencyBoost"
		| "accessBoost"
		| "temporalProximityBoost"
	>
}

export type QueryCacheEntry = {
	queryHash: string
	queryNorm: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	/** Canonical serialization of the key params this entry was cached under. */
	keySuffix?: string
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize query for consistent hashing: lowercase, collapse whitespace, trim. */
export function normalizeQuery(query: string): string {
	return query.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Canonical serialization of cache key params: defined fields only, stable
 * order. `k` = maxResults, `s` = minScore, `t` = timeRange (preset|start|end),
 * `d` = questionDate, `q` = query embedding model, `e` = conversation
 * evidence mode, `f` = fusion method, `r` = reranker fingerprint.
 */
export function serializeKeyParams(params?: QueryCacheKeyParams): string {
	if (!params) {
		return ""
	}
	const parts: string[] = []
	if (params.maxResults !== undefined) {
		parts.push(`k=${params.maxResults}`)
	}
	if (params.minScore !== undefined) {
		parts.push(`s=${params.minScore}`)
	}
	if (params.timeRange) {
		const range = params.timeRange
		parts.push(
			`t=${range.preset ?? ""}|${range.start ?? ""}|${range.end ?? ""}`,
		)
	}
	if (params.questionDate) {
		parts.push(`d=${params.questionDate.toISOString()}`)
	}
	if (params.queryEmbeddingModel) {
		parts.push(`q=${params.queryEmbeddingModel}`)
	}
	if (params.conversationEvidenceMode) {
		parts.push(`e=${params.conversationEvidenceMode}`)
	}
	if (params.fusionMethod) {
		parts.push(`f=${params.fusionMethod}`)
	}
	if (params.reranker) {
		const reranker = params.reranker
		const instructionSha256 = reranker.instruction
			? createHash("sha256").update(reranker.instruction).digest("hex")
			: ""
		parts.push(
			[
				`r=${reranker.enabled ? "1" : "0"}`,
				reranker.model,
				reranker.topN,
				reranker.minScore,
				instructionSha256,
				reranker.recencyBoost ?? "",
				reranker.accessBoost ?? "",
				reranker.temporalProximityBoost ?? "",
			].join("|"),
		)
	}
	return parts.join(";")
}

/**
 * SHA-256 of the cache key input: the normalized query plus, when present,
 * the canonical key params. Callers that pass no keyParams get the legacy
 * input (hash of the normalized query alone), so existing entries and tests
 * are unaffected.
 */
export function hashQuery(
	normalizedQuery: string,
	keyParams?: QueryCacheKeyParams,
): string {
	const suffix = serializeKeyParams(keyParams)
	const input = suffix ? `${normalizedQuery}\n${suffix}` : normalizedQuery
	return createHash("sha256").update(input).digest("hex")
}

/**
 * Tier-2 expected-win gate (P2.4): one bounded count against the caller's
 * OWN namespace. A probe can only hit when this (agentId, scope, scopeRef)
 * holds unexpired entries — the previous estimatedDocumentCount gated on the
 * whole collection, paying a full embedding probe for namespaces that could
 * never hit. Failures degrade to 0 (skip the probe), never to an exception.
 */
async function probeNamespaceEntries(
	col: Collection,
	filter: {
		agentId: string
		scope: MemoryScope
		scopeRef: string
		now: Date
	},
): Promise<number> {
	try {
		return await col.countDocuments(
			{
				agentId: filter.agentId,
				scope: filter.scope,
				scopeRef: filter.scopeRef,
				expiresAt: { $gt: filter.now },
			},
			{ limit: 1 },
		)
	} catch (err) {
		log.warn("cache namespace gate failed", { error: err })
		return 0
	}
}

// ---------------------------------------------------------------------------
// checkCache — Two-tier lookup
// ---------------------------------------------------------------------------

/**
 * Two-tier cache check:
 * Tier 1: Exact SHA-256 hash match via findOne on unique index.
 * Tier 2: $vectorSearch with autoEmbed on queryNorm field, cosine >= threshold,
 *         gated by a namespace-level expected-win check and guarded against
 *         cross-parameterization serves via keySuffix comparison.
 *
 * P2.4: tier 1 and the tier-2 gate run CONCURRENTLY — both are cheap metadata
 * reads, so the miss path no longer serializes gate-behind-exact, and an
 * exact hit short-circuits before the embedding probe is ever issued.
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
	queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
	vectorIndexName?: string
	keyParams?: QueryCacheKeyParams
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
	const qHash = hashQuery(normalized, params.keyParams)
	const keySuffix = serializeKeyParams(params.keyParams)
	const now = new Date()

	// Tier 1 and the tier-2 namespace gate race in parallel. The gate promise
	// is catch-guarded inside probeNamespaceEntries, so abandoning it on an
	// exact hit can never produce an unhandled rejection.
	const exactStart = Date.now()
	const gatePromise = probeNamespaceEntries(col, {
		agentId,
		scope,
		scopeRef,
		now,
	})

	let exact: Document | null
	try {
		exact = await col.findOne({
			queryHash: qHash,
			agentId,
			scope,
			scopeRef,
			expiresAt: { $gt: now },
		})
		exactMs = Date.now() - exactStart
	} catch (err) {
		// P2.4 fix: measure the retrieval span (from exactStart), not the
		// setup-inclusive cacheStart.
		exactMs = Date.now() - exactStart
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

	if (exact) {
		// Exact hit: the probe path is short-circuited; the gate settles
		// unobserved.
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

	// Tier 2: Semantic similarity via $vectorSearch with autoEmbed. The gate
	// has been running concurrently with tier 1, so on a warm namespace the
	// probe starts without paying a serialized gate round trip first.
	const semanticStart = Date.now()
	const cachedEntries = await gatePromise
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

	try {
		const indexName = params.vectorIndexName ?? `${prefix}query_cache_vector`
		const vsStage = buildVectorSearchStage({
			queryVector: null,
			queryText: normalized,
			embeddingMode: "automated",
			model: params.queryEmbeddingModel,
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
					keySuffix: 1,
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
		// C-017: the executed $vectorSearch embedded queryNorm server-side
		// (autoEmbed) — bill one cache-probe embedding unit, hit or miss.
		recordEmbeddingSpend(db, prefix, agentId, "cache-probe", 1)
		if (
			candidates.length > 0 &&
			candidates[0].score >= config.similarityThreshold &&
			candidates[0].expiresAt > now &&
			((candidates[0].keySuffix as string | undefined) ?? "") === keySuffix
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
 * keyParams must be the RESOLVED search parameters (post-defaults), matching
 * what checkCache receives, so the entry lands under the same folded hash.
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
	keyParams?: QueryCacheKeyParams
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
	const qHash = hashQuery(normalized, params.keyParams)
	const col = queryCacheCollection(db, prefix)

	col
		.updateOne(
			{ queryHash: qHash, agentId, scope, scopeRef },
			{
				$setOnInsert: {
					queryNorm: normalized,
					keySuffix: serializeKeyParams(params.keyParams),
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
