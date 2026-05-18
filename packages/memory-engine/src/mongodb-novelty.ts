/**
 * Surprisal-Based Novelty Detection — identifies the most novel/anomalous
 * stored observations using per-observation k-NN distance scoring via
 * Atlas Vector Search.
 *
 * Strategy (per-observation k-NN surprisal):
 *  1. Fetch candidate events for the agent
 *  2. For EACH candidate, run `$vectorSearch` with that event's body to
 *     find its k nearest neighbors
 *  3. Exclude the event itself from its own k-NN results (self-exclusion)
 *  4. Average the vectorSearchScore of the k non-self neighbors = avgSimilarity
 *  5. surprisal = 1 - avgSimilarity (isolated events = high surprisal = novel)
 *  6. Sort by surprisal descending, return top `limit`
 *
 * The autoEmbed index generates embeddings server-side from the `body` field.
 * We use `query: { text }` (not `queryVector`) to match this index type.
 *
 * CRITICAL: Graceful degradation when mongot is unavailable.
 *
 * @module mongodb-novelty
 */

import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import type { NoveltyEvent, NoveltyOptions, NoveltyReport } from "./types.js"

export type { NoveltyEvent, NoveltyReport, NoveltyOptions }

const log = createSubsystemLogger("memory:mongodb:novelty")

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10
const DEFAULT_K_NEIGHBORS = 5
/** Maximum number of candidate events to run k-NN on. */
const MAX_CANDIDATES = 30
/** Build the vector search index name for the events collection. */
export function eventsVectorIndex(prefix: string): string {
	return `${prefix}events_vector`
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the element-wise average of a list of embedding vectors.
 * All vectors must have the same dimensionality.
 * Retained for external consumers; not used by the k-NN novelty path.
 */
export function computeCentroid(embeddings: number[][]): number[] {
	if (embeddings.length === 0) {
		return []
	}
	const dim = embeddings[0].length
	const sum = new Float64Array(dim)
	for (const vec of embeddings) {
		for (let i = 0; i < dim; i++) {
			sum[i] += vec[i]
		}
	}
	const count = embeddings.length
	return Array.from(sum, (v) => v / count)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan for the most novel/surprising events stored for a given agent.
 *
 * Uses per-observation k-NN: for each candidate event, finds its k nearest
 * neighbors and computes surprisal = 1 - avgSimilarity. Events whose
 * neighbors are dissimilar (isolated in embedding space) score highest.
 *
 * Returns events ranked by novelty descending (most novel first).
 * Gracefully degrades when mongot/Atlas Vector Search is unavailable:
 * returns `{ events: [], scannedCount: 0, error: "mongot_unavailable" }`.
 */
export async function scanNovelty(params: {
	db: Db
	prefix: string
	agentId: string
	options?: NoveltyOptions
}): Promise<NoveltyReport> {
	const { db, prefix, agentId, options } = params
	const limit = options?.limit ?? DEFAULT_LIMIT
	const kNeighbors = options?.kNeighbors ?? DEFAULT_K_NEIGHBORS

	const emptyReport: NoveltyReport = {
		events: [],
		scannedCount: 0,
		agentId,
	}

	// 1. Build filter for fetching candidate events
	const filter: Document = {
		agentId,
		body: { $exists: true, $ne: "" },
	}
	if (options?.scope) {
		filter.scope = options.scope
	}
	if (options?.timeRange) {
		filter.timestamp = {
			$gte: options.timeRange.start,
			$lte: options.timeRange.end,
		}
	}

	// 2. Fetch candidate events with body text
	const eventsCol = db.collection(`${prefix}events`)
	const recentEvents = await eventsCol
		.find(filter)
		.sort({ timestamp: -1 })
		.limit(MAX_CANDIDATES)
		.project({ _id: 1, eventId: 1, body: 1, role: 1, timestamp: 1 })
		.toArray()

	const candidates = recentEvents.filter(
		(e) => typeof e.body === "string" && e.body.length > 0,
	)

	if (candidates.length === 0) {
		return emptyReport
	}

	// 3. Build $vectorSearch pre-filter (shared across all k-NN queries)
	const vsFilter: Document = { agentId }
	if (options?.scope) {
		vsFilter.scope = options.scope
	}
	if (options?.timeRange) {
		vsFilter.timestamp = {
			$gte: options.timeRange.start,
			$lte: options.timeRange.end,
		}
	}

	try {
		// 4. For each candidate, run k-NN to find its nearest neighbors
		const scoredEvents: NoveltyEvent[] = []

		for (const candidate of candidates) {
			const candidateId = String(candidate._id)
			const candidateBody = candidate.body as string

			// Request kNeighbors + 1 to account for self being returned
			const searchLimit = kNeighbors + 1
			const numCandidates = Math.max(searchLimit * 10, 50)

			const pipeline: Document[] = [
				{
					$vectorSearch: {
						index: eventsVectorIndex(prefix),
						path: "body",
						query: { text: candidateBody },
						model: "voyage-4-large",
						numCandidates,
						limit: searchLimit,
						filter: vsFilter,
					},
				},
				{
					$project: {
						_id: 1,
						eventId: 1,
						body: 1,
						role: 1,
						timestamp: 1,
						__vs: { $meta: "vectorSearchScore" },
					},
				},
			]

			const neighbors = await eventsCol.aggregate(pipeline).toArray()

			// Exclude self from neighbors (self will typically be score ~1.0)
			const nonSelfNeighbors = neighbors.filter(
				(n) => String(n._id) !== candidateId,
			)

			// Compute average similarity of k nearest non-self neighbors
			let avgSimilarity: number
			if (nonSelfNeighbors.length === 0) {
				// No non-self neighbors → maximally novel
				avgSimilarity = 0
			} else {
				const topK = nonSelfNeighbors.slice(0, kNeighbors)
				const totalSim = topK.reduce((sum, n) => {
					const s = Number(n.__vs)
					return sum + (Number.isFinite(s) ? s : 0)
				}, 0)
				avgSimilarity = totalSim / topK.length
			}

			const surprisal = 1 - avgSimilarity

			scoredEvents.push({
				eventId: candidate.eventId as string,
				body: candidateBody,
				noveltyScore: surprisal,
				timestamp:
					candidate.timestamp instanceof Date
						? candidate.timestamp
						: new Date(0),
				role: (candidate.role as string) ?? "unknown",
				nearestNeighborDistance: surprisal,
			})
		}

		// 5. Sort by surprisal descending (most novel first)
		scoredEvents.sort((a, b) => b.noveltyScore - a.noveltyScore)

		// 6. Apply limit
		const trimmed = scoredEvents.slice(0, limit)

		return {
			events: trimmed,
			scannedCount: candidates.length,
			agentId,
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		log.warn(`novelty scan failed (mongot likely unavailable): ${msg}`)
		return {
			events: [],
			scannedCount: 0,
			error: "mongot_unavailable",
			agentId,
		}
	}
}
