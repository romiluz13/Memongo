import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { emitTelemetry } from "./mongodb-telemetry.js"
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
}

export type RerankResult = {
	results: MemorySearchResult[]
	reranked: boolean
	latencyMs: number
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

/**
 * Cross-encoder re-ranking of search results using Voyage rerank-2.5 API.
 *
 * On ANY error (network, API, JSON parse, unexpected shape): falls back to
 * input order unchanged, logs a warning, and never crashes the search pipeline.
 *
 * Uses `r.snippet` for document text (MemorySearchResult has no `text` field).
 */
export async function crossEncoderRerank(params: {
	db: Db
	prefix: string
	agentId: string
	query: string
	results: MemorySearchResult[]
	config: RerankConfig
}): Promise<RerankResult> {
	const { db, prefix, agentId, query, results, config } = params
	const rerankStart = Date.now()

	// Early returns — no API call needed
	if (!config.enabled || results.length === 0 || !config.voyageApiKey) {
		return { results, reranked: false, latencyMs: 0 }
	}

	// Three-bucket split: candidates (sent to reranker), overflow (above minScore but beyond topN), below (under minScore)
	const aboveMinScore = results.filter((r) => r.score >= config.minScore)
	const candidates = aboveMinScore.slice(0, config.topN)
	const overflow = aboveMinScore.slice(config.topN) // above minScore but not sent to reranker
	const below = results.filter((r) => r.score < config.minScore)

	// Need at least 2 candidates for reranking to have any benefit
	if (candidates.length <= 1) {
		return { results, reranked: false, latencyMs: 0 }
	}

	try {
		// H5: Filter out candidates with empty/blank snippets (graph relations can produce near-empty text)
		const validCandidates = candidates.filter(
			(r) => r.snippet.trim().length > 0,
		)
		const emptySnippetCandidates = candidates.filter(
			(r) => r.snippet.trim().length === 0,
		)

		// Need at least 2 valid candidates for reranking to have any benefit
		if (validCandidates.length <= 1) {
			return { results, reranked: false, latencyMs: 0 }
		}

		const documents = validCandidates.map((r) => r.snippet)

		const rerankUrl = resolveRerankUrl(config.voyageApiKey)
		const response = await fetch(rerankUrl, {
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
			signal: AbortSignal.timeout(2_000),
		})

		if (!response.ok) {
			const message = `rerank API returned non-OK status: ${response.status}`
			if (isStrictRerankMode()) {
				throw new Error(message)
			}
			log.warn("rerank API returned non-OK status", { status: response.status })
			return { results, reranked: false, latencyMs: Date.now() - rerankStart }
		}

		const body = (await response.json()) as {
			data: Array<{ index: number; relevance_score: number }>
		}

		if (!body.data || !Array.isArray(body.data)) {
			if (isStrictRerankMode()) {
				throw new Error("rerank API returned unexpected response shape")
			}
			log.warn("rerank API returned unexpected response shape")
			return { results, reranked: false, latencyMs: Date.now() - rerankStart }
		}

		// Map scores back onto candidate results with bounds validation (Voyage SDK does NO validation)
		const reranked = body.data
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

		const latencyMs = Date.now() - rerankStart
		emitTelemetry(db, prefix, {
			meta: { agentId, operation: "rerank" },
			durationMs: latencyMs,
			ok: true,
			resultCount: reranked.length,
			rerankModel: config.model,
			rerankLatencyMs: latencyMs,
		})

		// Preserve all results: reranked first, then empty-snippet candidates, then overflow, then below
		return {
			results: [...reranked, ...emptySnippetCandidates, ...overflow, ...below],
			reranked: true,
			latencyMs,
		}
	} catch (err) {
		log.warn("rerank failed, falling back to input order", { error: err })
		// M1: Emit failure telemetry in catch block
		emitTelemetry(db, prefix, {
			meta: { agentId, operation: "rerank" },
			durationMs: Date.now() - rerankStart,
			ok: false,
			rerankModel: config.model,
			rerankLatencyMs: Date.now() - rerankStart,
		})
		if (isStrictRerankMode()) {
			throw err
		}
		return { results, reranked: false, latencyMs: Date.now() - rerankStart }
	}
}
