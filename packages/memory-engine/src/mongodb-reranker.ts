import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { emitTelemetry, type TelemetryDocument } from "./mongodb-telemetry.js"
import type { AdmissionToken } from "./mongodb-write-fence.js"
import { withRemoteHttpResponse } from "./remote-http.js"
import type { MemorySearchResult } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:reranker")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RerankConfig = {
	enabled: boolean
	model: "rerank-2.5" | "rerank-2.5-lite"
	topN: number
	minScore: number
	voyageApiKey: string
	/** Optional instruction prepended to query for rerank-2.5 instruction-following. */
	instruction?: string
	/** Post-CE recency boost weight applied after reranking (0 disables). */
	recencyBoost?: number
	/** Post-CE access-count boost weight applied after reranking (0 disables). */
	accessBoost?: number
	/** Raw-window lane temporal-proximity weight (0 disables; default 0.1). */
	temporalProximityBoost?: number
}

/**
 * RET-08: per-bucket result split. The cross-encoder only scores the topN
 * candidates; the other partitions keep their ORIGINAL retrieval scores,
 * which are not calibrated against CE scores. Consumers must compose the
 * partitions in authority order (reranked → emptySnippet → overflow →
 * below) and never re-sort across the partition boundary, or unreranked
 * overflow with a high retrieval score will displace CE-ranked results.
 */
export type RerankPartitions = {
	/** Candidates scored by the cross-encoder (CE score applied, best first). */
	reranked: MemorySearchResult[]
	/** Candidates with empty snippets, never sent to the CE. */
	emptySnippet: MemorySearchResult[]
	/** Results above minScore beyond topN, never sent to the CE. */
	overflow: MemorySearchResult[]
	/** Results below minScore, never sent to the CE. */
	below: MemorySearchResult[]
}

export type RerankResult =
	| { results: MemorySearchResult[]; reranked: false; latencyMs: number }
	| {
			/**
			 * Flat concatenation in partition order (reranked, emptySnippet,
			 * overflow, below) — same order as `partitions`.
			 */
			results: MemorySearchResult[]
			reranked: true
			latencyMs: number
			/** Authoritative partition split (RET-08). */
			partitions: RerankPartitions
	  }

/**
 * WS-11 change 5 (09-report U2): the rerank stage's individual bound. Part
 * of the tail-latency composition asserted by
 * mongodb-search-latency-composition.test.ts — 1.5s semantic probe +
 * 10s maxTimeMS aggregate + this 2s rerank timeout = the documented 13.5s
 * worst case. Named (not inline) so the composition test pins it.
 */
export const RERANK_TIMEOUT_MS = 2_000

/**
 * WS-16 (C-031): the floor below which a provider call is not worth
 * starting. A rerank that cannot complete within the remaining latency
 * budget is skipped outright (rerankSkipped: "budget-exhausted") rather
 * than allowed to abort mid-flight a few milliseconds later.
 */
export const MIN_RERANK_TIMEOUT_MS = 250

/**
 * WS-16 (C-031): the rerank timeout derives from the caller's remaining
 * latency budget, so one provider call can never stack a full 2s cap on
 * top of an already-consumed tail (probe-miss + slow-lane worst cases).
 *
 * - No budget provided → the fixed 2s cap (previous behavior, used by
 *   direct callers and tests).
 * - Budget at or above the floor → min(remaining, 2s cap): the provider
 *   gets whatever the search has left, never more.
 * - Budget below the floor (or non-finite) → null: skip the call entirely.
 */
export function resolveRerankTimeoutMs(
	remainingBudgetMs?: number,
): number | null {
	if (remainingBudgetMs === undefined) {
		return RERANK_TIMEOUT_MS
	}
	if (
		!Number.isFinite(remainingBudgetMs) ||
		remainingBudgetMs < MIN_RERANK_TIMEOUT_MS
	) {
		return null
	}
	return Math.min(Math.floor(remainingBudgetMs), RERANK_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Cross-encoder re-ranking via Voyage rerank-2.5 API
// ---------------------------------------------------------------------------

// Auto-route based on API key prefix (same pattern as official Voyage Python SDK):
// - Atlas Model API Key (al-...) → ai.mongodb.com (MongoDB proxy, supports embedding + reranking)
// - Direct Voyage AI Key (pa-...) → api.voyageai.com (Voyage platform)
const VOYAGE_RERANK_URL_ATLAS = "https://ai.mongodb.com/v1/rerank"
const VOYAGE_RERANK_URL_DIRECT = "https://api.voyageai.com/v1/rerank"

function resolveRerankUrl(apiKey: string): string {
	return apiKey.startsWith("al-")
		? VOYAGE_RERANK_URL_ATLAS
		: VOYAGE_RERANK_URL_DIRECT
}

function isStrictRerankMode(): boolean {
	const benchmarkStrict = process.env.MEMONGO_BENCHMARK_STRICT
	return (
		process.env.MEMONGO_RERANK_STRICT === "1" ||
		process.env.MEMONGO_RERANK_STRICT?.toLowerCase() === "true" ||
		benchmarkStrict === "1" ||
		benchmarkStrict?.toLowerCase() === "true"
	)
}

function emitLeafTelemetry(
	db: Db,
	prefix: string,
	doc: Omit<TelemetryDocument, "ts">,
	admission?: AdmissionToken,
): void {
	if (admission) {
		void emitTelemetry(db, prefix, doc, { admission }).catch(() =>
			log.warn("rerank telemetry emit failed"),
		)
	} else {
		emitTelemetry(db, prefix, doc)
	}
}

/**
 * Cross-encoder re-ranking of search results using Voyage rerank-2.5 API.
 *
 * On ANY error (network, API, JSON parse, unexpected shape): falls back to
 * input order unchanged, logs a warning, and never crashes the search pipeline.
 *
 * Uses the full passage `text` when present, falling back to `r.snippet`
 * (B5: the preview alone hides answers past 700 characters).
 */
export async function crossEncoderRerank(params: {
	admission?: AdmissionToken
	db: Db
	prefix: string
	agentId: string
	query: string
	results: MemorySearchResult[]
	config: RerankConfig
	onProviderCall?: (outcome: "attempted" | "succeeded" | "failed") => void
	fetchFn?: typeof globalThis.fetch
	/**
	 * WS-16 (C-031): remaining end-to-end latency budget in ms. When present,
	 * the provider timeout is min(remaining, RERANK_TIMEOUT_MS); when the
	 * remainder is below MIN_RERANK_TIMEOUT_MS the call is skipped (empty ≠
	 * error — the search returns unreranked results, it never fails).
	 */
	remainingBudgetMs?: number
}): Promise<RerankResult> {
	const { db, prefix, agentId, query, results, config } = params
	const rerankStart = Date.now()
	let providerCallOpen = false
	const recordProviderCall = (
		outcome: "attempted" | "succeeded" | "failed",
	) => {
		if (outcome === "attempted") {
			providerCallOpen = true
		} else if (!providerCallOpen) {
			return
		} else {
			providerCallOpen = false
		}
		try {
			params.onProviderCall?.(outcome)
		} catch (error) {
			log.warn("rerank provider-call observer failed", { error })
		}
	}

	// Early returns — no API call needed. WS-12 (C-019): every skip emits a
	// telemetry doc (ok:true, rerankSkipped reason) so "off" is
	// distinguishable from "failed" (ok:false) and from "ran" (no marker) in
	// the telemetry time series — the pre-fix silence made a disabled
	// reranker indistinguishable from a healthy skipped one.
	if (!config.enabled || results.length === 0 || !config.voyageApiKey) {
		const skipReason = !config.enabled
			? "disabled"
			: results.length === 0
				? "no-results"
				: "no-api-key"
		emitLeafTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "rerank" },
				durationMs: 0,
				ok: true,
				rerankModel: config.model,
				rerankSkipped: skipReason,
			},
			params.admission,
		)
		return { results, reranked: false, latencyMs: 0 }
	}

	// B7: candidates are the first `topN` results BY RANK, not by a
	// first-stage score threshold. The retrieval score is produced by a
	// different, uncalibrated scoring domain than the cross-encoder's
	// relevance scores, so filtering candidates on `config.minScore` could
	// silently drop the exact results the cross-encoder would have ranked
	// highest. `minScore` now applies to the CE scores after the rerank (see
	// the partition split below).
	const candidates = results.slice(0, config.topN)
	const overflow = results.slice(config.topN) // beyond topN, never sent to the reranker

	// Need at least 2 candidates for reranking to have any benefit
	if (candidates.length <= 1) {
		emitLeafTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "rerank" },
				durationMs: 0,
				ok: true,
				rerankModel: config.model,
				rerankSkipped: "too-few-candidates",
			},
			params.admission,
		)
		return { results, reranked: false, latencyMs: 0 }
	}

	try {
		// H5: Filter out candidates with empty/blank snippets (graph relations can produce near-empty text)
		// B5: prefer the full-text field over the 700-char snippet preview.
		const rerankText = (r: MemorySearchResult) => r.text ?? r.snippet
		const validCandidates = candidates.filter(
			(r) => rerankText(r).trim().length > 0,
		)
		const emptySnippetCandidates = candidates.filter(
			(r) => rerankText(r).trim().length === 0,
		)

		// Need at least 2 valid candidates for reranking to have any benefit
		if (validCandidates.length <= 1) {
			emitLeafTelemetry(
				db,
				prefix,
				{
					meta: { agentId, operation: "rerank" },
					durationMs: Date.now() - rerankStart,
					ok: true,
					rerankModel: config.model,
					rerankSkipped: "too-few-valid-candidates",
				},
				params.admission,
			)
			return { results, reranked: false, latencyMs: 0 }
		}

		// B5: the Voyage reranker accepts long documents — send the full
		// passage text, not the truncated preview.
		const documents = validCandidates.map((r) => r.text ?? r.snippet)

		// WS-16 (C-031): derive the provider timeout from the remaining
		// latency budget. Below the floor the call is not started at all —
		// a deliberate skip (ok:true) so telemetry distinguishes it from a
		// provider failure.
		const timeoutMs = resolveRerankTimeoutMs(params.remainingBudgetMs)
		if (timeoutMs === null) {
			emitLeafTelemetry(
				db,
				prefix,
				{
					meta: { agentId, operation: "rerank" },
					durationMs: Date.now() - rerankStart,
					ok: true,
					rerankModel: config.model,
					rerankSkipped: "budget-exhausted",
				},
				params.admission,
			)
			return { results, reranked: false, latencyMs: Date.now() - rerankStart }
		}

		const rerankUrl = resolveRerankUrl(config.voyageApiKey)
		recordProviderCall("attempted")
		const response = await withRemoteHttpResponse({
			url: rerankUrl,
			fetchFn: params.fetchFn,
			init: {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.voyageApiKey}`,
				},
				body: JSON.stringify({
					model: config.model,
					// rerank-2.5 supports instruction-following: prepend instruction to query
					query: config.instruction ? `${config.instruction}\n${query}` : query,
					documents,
					top_k: validCandidates.length,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			},
			onResponse: async (value) => value,
		})

		if (!response.ok) {
			recordProviderCall("failed")
			const message = `rerank API returned non-OK status: ${response.status}`
			if (isStrictRerankMode()) {
				throw new Error(message)
			}
			log.warn("rerank API returned non-OK status", {
				status: response.status,
				url: rerankUrl,
			})
			// WS-12 (C-019): a provider failure that degraded to input order
			// is a FAILED rerank, not a skip — the marker distinguishes it
			// from config-off (ok:true) in the telemetry time series.
			emitLeafTelemetry(
				db,
				prefix,
				{
					meta: { agentId, operation: "rerank" },
					durationMs: Date.now() - rerankStart,
					ok: false,
					rerankModel: config.model,
					rerankLatencyMs: Date.now() - rerankStart,
					rerankSkipped: "api-error",
				},
				params.admission,
			)
			return { results, reranked: false, latencyMs: Date.now() - rerankStart }
		}

		const body = (await response.json()) as {
			data: Array<{ index: number; relevance_score: number }>
		}

		if (!body.data || !Array.isArray(body.data)) {
			recordProviderCall("failed")
			if (isStrictRerankMode()) {
				throw new Error("rerank API returned unexpected response shape")
			}
			log.warn("rerank API returned unexpected response shape")
			emitLeafTelemetry(
				db,
				prefix,
				{
					meta: { agentId, operation: "rerank" },
					durationMs: Date.now() - rerankStart,
					ok: false,
					rerankModel: config.model,
					rerankLatencyMs: Date.now() - rerankStart,
					rerankSkipped: "bad-response-shape",
				},
				params.admission,
			)
			return { results, reranked: false, latencyMs: Date.now() - rerankStart }
		}

		// Map scores back onto candidate results with bounds validation (Voyage SDK does NO validation)
		const ceScored = body.data
			.filter((r) => {
				if (
					typeof r.index !== "number" ||
					r.index < 0 ||
					r.index >= validCandidates.length
				) {
					if (isStrictRerankMode()) {
						throw new Error(
							`rerank API returned out-of-bounds index: ${r.index}`,
						)
					}
					log.warn("rerank API returned out-of-bounds index", {
						index: r.index,
						max: validCandidates.length - 1,
					})
					return false
				}
				return true
			})
			.toSorted((a, b) => b.relevance_score - a.relevance_score)
			.map((r) => ({
				...validCandidates[r.index],
				score: Math.min(1, Math.max(0, r.relevance_score)),
			}))

		// B7: `minScore` gates the cross-encoder's own relevance scores, not
		// the first-stage retrieval scores. Results the CE scored below
		// minScore are preserved (appended last, after overflow) rather than
		// dropped, so the caller keeps the full candidate set while the
		// CE-authoritative head stays above the configured relevance floor.
		const reranked = ceScored.filter((r) => r.score >= config.minScore)
		const below = ceScored.filter((r) => r.score < config.minScore)

		const latencyMs = Date.now() - rerankStart
		recordProviderCall("succeeded")
		emitLeafTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "rerank" },
				durationMs: latencyMs,
				ok: true,
				resultCount: reranked.length,
				rerankModel: config.model,
				rerankLatencyMs: latencyMs,
			},
			params.admission,
		)

		// Preserve all results: reranked first, then empty-snippet candidates, then overflow, then below
		// (RET-08: partitions carry the split so callers can keep CE-ranked
		// results ahead of untouched overflow instead of re-sorting across
		// uncalibrated score domains).
		return {
			results: [...reranked, ...emptySnippetCandidates, ...overflow, ...below],
			reranked: true,
			latencyMs,
			partitions: {
				reranked,
				emptySnippet: emptySnippetCandidates,
				overflow,
				below,
			},
		}
	} catch (err) {
		recordProviderCall("failed")
		log.warn("rerank failed, falling back to input order", { error: err })
		// M1: Emit failure telemetry in catch block
		emitLeafTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "rerank" },
				durationMs: Date.now() - rerankStart,
				ok: false,
				rerankModel: config.model,
				rerankLatencyMs: Date.now() - rerankStart,
			},
			params.admission,
		)
		if (isStrictRerankMode()) {
			throw err
		}
		return { results, reranked: false, latencyMs: Date.now() - rerankStart }
	}
}
