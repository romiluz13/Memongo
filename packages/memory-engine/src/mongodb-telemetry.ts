import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { telemetryCollection } from "./mongodb-schema.js"

const log = createSubsystemLogger("memory:mongodb:telemetry")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelemetryOperation =
	| "search"
	| "event-write"
	| "projection-run"
	| "cache-check"
	| "graph-expansion"
	| "profile-synthesis"
	| "active-slate-hydration"
	| "context-bundle"
	| "rerank"
	| "query-rewrite"
	| "entity-extraction"
	| "memory-job-dead-letter"
	| "memory-job-backlog"
	| "write-queue-saturation"
	| "search-query-clamped"

export type TelemetryMeta = {
	agentId: string
	operation: TelemetryOperation
}

export type TelemetryDocument = {
	ts: Date
	meta: TelemetryMeta
	durationMs: number
	ok: boolean
	pathUsed?: string
	resultCount?: number
	topScore?: number
	fusionMethod?: string
	cacheHit?: boolean
	latencySavedMs?: number
	itemCount?: number
	eventType?: string
	projectionTriggered?: boolean
	rerankModel?: string
	rerankLatencyMs?: number
	queryRewritten?: boolean
	rewriteMethod?: string
	extractionMethod?: string
	entitiesExtracted?: number
	/**
	 * WS-11: true when the search was DENIED by process-level admission
	 * control before any lane ran (see mongodb-search-admission.ts). A
	 * throttled doc is ok:false with this marker set, so window aggregates
	 * can separate "overloaded" from "ran and found nothing".
	 */
	throttled?: boolean
	/**
	 * WS-11: retry hint (ms) carried on throttle and saturation docs where
	 * one is computable.
	 */
	retryAfterMs?: number
	/**
	 * WS-12 (C-019): rerank skip marker. Set when the rerank stage
	 * legitimately did not run — "disabled" (config off), "no-results"
	 * (nothing to rank), "no-api-key", "too-few-candidates",
	 * "too-few-valid-candidates" — with ok:true, so a skip is
	 * distinguishable from a rerank that ran (no marker) and from a rerank
	 * failure (ok:false, e.g. "api-error"/"bad-response-shape").
	 */
	rerankSkipped?: string
	/**
	 * WS-11: queue/gauge context on backlog and saturation docs (depth at
	 * observation time, threshold the gauge tripped at).
	 */
	depth?: number
	threshold?: number
	/**
	 * WS-16 (C-030): pre-clamp character length carried on
	 * search-query-clamped docs so operators can see how far past the
	 * 2,000-character ceiling a caller pushed.
	 */
	queryLength?: number
}

// ---------------------------------------------------------------------------
// Emit (fire-and-forget, error-swallowing, non-blocking)
// ---------------------------------------------------------------------------

/**
 * Sampling controls (08-report fleet audit: unbounded per-operation telemetry
 * writes at scale). `MEMONGO_TELEMETRY_ENABLED=false|0|off|no` is the kill
 * switch — no emit even touches the driver. `MEMONGO_TELEMETRY_SAMPLE_RATE`
 * (0..1, default 1) deterministically samples the documents that do emit;
 * window aggregates read as counts × 1/rate. Both resolve per emit, so an
 * operator can flip either without a restart. Invalid values fall back to
 * the safe defaults (enabled, rate 1) — telemetry failing open matches its
 * observability role, unlike the cost ledger which never samples.
 */
export function resolveTelemetrySampling(env: {
	MEMONGO_TELEMETRY_ENABLED?: string
	MEMONGO_TELEMETRY_SAMPLE_RATE?: string
}): { enabled: boolean; sampleRate: number } {
	const enabledRaw = env.MEMONGO_TELEMETRY_ENABLED?.trim().toLowerCase()
	const disabled =
		enabledRaw === "false" ||
		enabledRaw === "0" ||
		enabledRaw === "off" ||
		enabledRaw === "no"
	const rateRaw = env.MEMONGO_TELEMETRY_SAMPLE_RATE
	let sampleRate = 1
	if (rateRaw !== undefined && rateRaw.trim() !== "") {
		const parsed = Number(rateRaw)
		if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
			sampleRate = parsed
		}
	}
	return { enabled: !disabled, sampleRate }
}

/**
 * Emit a telemetry document to the memory_telemetry time series collection.
 * Fire-and-forget: never blocks the caller, never throws. Kill-switched and
 * sampled via MEMONGO_TELEMETRY_ENABLED / MEMONGO_TELEMETRY_SAMPLE_RATE
 * (see {@link resolveTelemetrySampling}). Uses insertOne with .catch() for
 * error-swallowing.
 */
export function emitTelemetry(
	db: Db,
	prefix: string,
	doc: Omit<TelemetryDocument, "ts">,
): void {
	const { enabled, sampleRate } = resolveTelemetrySampling(process.env)
	if (!enabled || sampleRate <= 0) {
		return
	}
	if (sampleRate < 1 && Math.random() > sampleRate) {
		return
	}
	const entry: TelemetryDocument = { ...doc, ts: new Date() }
	telemetryCollection(db, prefix)
		.insertOne(entry)
		.catch((err) => {
			log.warn("telemetry emit failed", {
				operation: doc.meta.operation,
				error: err instanceof Error ? err.message : String(err),
			})
		})
}

// ---------------------------------------------------------------------------
// Aggregation helpers (dashboard metrics)
// ---------------------------------------------------------------------------

/** Get P50/P95/P99 latency stats for a given operation over a time window. */
export async function getLatencyStats(params: {
	db: Db
	prefix: string
	agentId: string
	operation?: TelemetryOperation
	windowMs?: number
}): Promise<{ p50: number; p95: number; p99: number; count: number }> {
	const { db, prefix, agentId, operation, windowMs = 3600000 } = params
	const since = new Date(Date.now() - windowMs)
	const matchStage: Record<string, unknown> = {
		"meta.agentId": agentId,
		ts: { $gte: since },
	}
	if (operation) {
		matchStage["meta.operation"] = operation
	}

	// M4 audit fix: use server-side $percentile instead of $push + client-side calculation.
	// $percentile is GA since MongoDB 7.0, available in atlas-local:preview.
	const pipeline = [
		{ $match: matchStage },
		{
			$group: {
				_id: null,
				count: { $sum: 1 },
				p50: {
					$percentile: {
						input: "$durationMs",
						p: [0.5],
						method: "approximate",
					},
				},
				p95: {
					$percentile: {
						input: "$durationMs",
						p: [0.95],
						method: "approximate",
					},
				},
				p99: {
					$percentile: {
						input: "$durationMs",
						p: [0.99],
						method: "approximate",
					},
				},
			},
		},
	]

	// Telemetry is observability, not product behavior — an aggregation error
	// here must never fail the caller (fleet audit P2-6).
	let results: Document[]
	try {
		results = await telemetryCollection(db, prefix)
			.aggregate(pipeline)
			.toArray()
	} catch (err) {
		log.warn(
			`latency stats aggregation failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		return { p50: 0, p95: 0, p99: 0, count: 0 }
	}
	if (results.length === 0 || results[0].count === 0) {
		return { p50: 0, p95: 0, p99: 0, count: 0 }
	}

	return {
		p50: results[0].p50?.[0] ?? 0,
		p95: results[0].p95?.[0] ?? 0,
		p99: results[0].p99?.[0] ?? 0,
		count: results[0].count,
	}
}

/** Get cache hit rate over a time window. */
export async function getCacheHitRate(params: {
	db: Db
	prefix: string
	agentId: string
	windowMs?: number
}): Promise<{ hitRate: number; hits: number; misses: number; total: number }> {
	const { db, prefix, agentId, windowMs = 3600000 } = params
	const since = new Date(Date.now() - windowMs)

	const pipeline = [
		{
			$match: {
				"meta.agentId": agentId,
				"meta.operation": "cache-check",
				ts: { $gte: since },
			},
		},
		{
			$group: {
				_id: "$cacheHit",
				count: { $sum: 1 },
			},
		},
	]

	let results: Document[]
	try {
		results = await telemetryCollection(db, prefix)
			.aggregate(pipeline)
			.toArray()
	} catch (err) {
		log.warn(
			`cache hit-rate aggregation failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		return { hitRate: 0, hits: 0, misses: 0, total: 0 }
	}
	let hits = 0
	let misses = 0
	for (const r of results) {
		if (r._id === true) {
			hits = r.count as number
		} else {
			misses += r.count as number
		}
	}
	const total = hits + misses
	return { hitRate: total > 0 ? hits / total : 0, hits, misses, total }
}

/** Get operation distribution over a time window. */
export async function getOperationDistribution(params: {
	db: Db
	prefix: string
	agentId: string
	windowMs?: number
}): Promise<
	Array<{ operation: TelemetryOperation; count: number; avgDurationMs: number }>
> {
	const { db, prefix, agentId, windowMs = 3600000 } = params
	const since = new Date(Date.now() - windowMs)

	const pipeline = [
		{
			$match: {
				"meta.agentId": agentId,
				ts: { $gte: since },
			},
		},
		{
			$group: {
				_id: "$meta.operation",
				count: { $sum: 1 },
				avgDurationMs: { $avg: "$durationMs" },
			},
		},
		{ $sort: { count: -1 } },
	]

	let results: Document[]
	try {
		results = await telemetryCollection(db, prefix)
			.aggregate(pipeline)
			.toArray()
	} catch (err) {
		log.warn(
			`operation distribution aggregation failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		return []
	}
	return results.map((r) => ({
		operation: r._id as TelemetryOperation,
		count: r.count as number,
		avgDurationMs: Math.round(r.avgDurationMs as number),
	}))
}
