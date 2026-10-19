/**
 * Score helpers for the MongoDB backend: RRF rank scoring and the per-method
 * normalization of search scores onto [0, 1].
 *
 * A collection's text and vector inputs are fused by the server
 * (`$rankFusion` / `$scoreFusion`); this module merges no result lists.
 * `rrfScore` only ranks results across different lanes.
 *
 * @module memory:mongodb:hybrid
 */

import type { MemorySearchResult } from "./types.js"

// ---------------------------------------------------------------------------
// Search method classification for score normalization
// ---------------------------------------------------------------------------

export type SearchMethod = "vector" | "text" | "hybrid" | "structured" | "kb"

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF) scoring
// ---------------------------------------------------------------------------

/** Default RRF constant. Standard value from the original RRF paper. */
const DEFAULT_RRF_K = 60

/**
 * Compute the RRF score for a result at a given rank.
 *
 * Formula: `1 / (k + rank)` where k defaults to 60.
 *
 * Properties:
 * - Top-ranked result (rank=1) scores 1/61 ~ 0.0164
 * - Scores decrease smoothly with rank
 * - Results appearing in multiple lists get their RRF scores summed
 * - k=60 dampens the influence of high-ranked results, producing more uniform fusion
 */
export function rrfScore(rank: number, k: number = DEFAULT_RRF_K): number {
	return 1 / (k + rank)
}

// ---------------------------------------------------------------------------
// Score normalization utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a vector search score (cosine similarity).
 *
 * Cosine similarity from $vectorSearch is already in [0,1] range,
 * but we clamp to handle edge cases and non-finite values.
 */
export function normalizeVectorScore(score: number): number {
	if (!Number.isFinite(score)) {
		return score > 0 ? 1.0 : 0.0
	}
	return Math.max(0, Math.min(1, score))
}

/**
 * Normalize a BM25/TF-IDF text search score from [0, inf) to [0, 1].
 *
 * Uses a sigmoid-like function: `score / (score + k)` where k controls
 * the midpoint. With k=5, a BM25 score of 5 maps to 0.5.
 *
 * This provides a smooth, monotonically increasing mapping that:
 * - Maps 0 to 0
 * - Approaches 1 for very high scores
 * - Has a reasonable midpoint for typical BM25 scores (range 1-20)
 */
export function normalizeBM25Score(score: number, k: number = 5): number {
	if (!Number.isFinite(score) || score < 0) {
		return 0
	}
	return score / (score + k)
}

/**
 * Normalize an RRF score to [0, 1] range.
 *
 * Raw RRF scores are in [0, 1/k] where k is the RRF constant (default 60).
 * The maximum possible RRF score is 1/k (for rank=0, which is rare) or
 * more typically 1/(k+1) for rank=1.
 *
 * We normalize by dividing by the theoretical maximum (1/k) so that
 * the top-ranked result approaches 1.0.
 */
export function normalizeRRFScore(
	score: number,
	k: number = DEFAULT_RRF_K,
): number {
	if (!Number.isFinite(score) || score <= 0) {
		return 0
	}
	const maxScore = 1 / k
	return Math.min(1, score / maxScore)
}

// ---------------------------------------------------------------------------
// Cross-source score normalization
// ---------------------------------------------------------------------------

/**
 * Normalize search results to [0,1] range based on the search method that
 * produced them.
 *
 * This is the key function for fixing the score normalization gap (F23).
 * Different search methods produce scores on different scales:
 * - vector ($vectorSearch): cosine similarity [0, 1]
 * - text ($search): BM25 [0, inf)
 * - hybrid ($rankFusion/$scoreFusion): depends on fusion method
 * - structured: same as vector
 * - kb: same as vector
 *
 * After normalization, results from all methods can be merged and sorted
 * on a common [0,1] scale.
 */
export function normalizeSearchResults(
	results: MemorySearchResult[],
	method: SearchMethod,
): MemorySearchResult[] {
	if (results.length === 0) {
		return []
	}

	const normalizer = getNormalizer(method)

	return results.map((r) => ({
		...r,
		score: normalizer(r.score),
	}))
}

function getNormalizer(method: SearchMethod): (score: number) => number {
	switch (method) {
		case "vector":
		case "structured":
		case "kb":
			// These use $vectorSearch or server-side fusion, scores are [0,1]-ish
			return normalizeVectorScore
		case "text":
			// BM25 scores are unbounded [0, inf)
			return normalizeBM25Score
		case "hybrid":
			// Every hybrid producer reports in ~[0,1] by the time results reach
			// here: $scoreFusion normalizes with sigmoid and hybridSearchRankFusion
			// divides raw $rankFusion output by sum(weights)/61 at the source.
			// Rescaling again here would be a second, wrong division — clamp only.
			return normalizeVectorScore
		default:
			return normalizeVectorScore
	}
}
