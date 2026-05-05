import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { renderEventChunkText } from "./mongodb-events.js"
import { eventsCollection } from "./mongodb-schema.js"
import type { MemorySearchResult } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:context-expansion")

/**
 * Expand search results by fetching neighbor events (N-1, N+1 by timestamp)
 * from the same session for event-based chunks.
 *
 * Only expands results that have a `sessionId` field and path matching `events/{eventId}`.
 * Results without sessionId are passed through unchanged.
 *
 * Context expansion behavior:
 * - Adds neighbors up to `maxResults`; if adding neighbors would exceed maxResults,
 *   drop the lowest-scored tail results to make room.
 * - Neighbors get a score of `parentScore * 0.95` (slightly below parent).
 * - Deduplicates by path against already-present results.
 *
 * Collection: Queries the EVENTS collection (not chunks) because:
 *   - Events have sessionId natively
 *   - The idx_events_agent_session_ts index supports efficient neighbor lookups
 *   - Neighbor text is rendered via renderEventChunkText() for consistency with chunk text
 *
 * Performance: Batches all neighbor lookups. For each unique sessionId in results,
 * queries events collection ONCE with sessionId + timestamp range to find neighbors.
 */
export async function expandSearchContext(params: {
	db: Db
	prefix: string
	agentId: string
	results: MemorySearchResult[]
	maxResults?: number
	windowSize?: number // neighbors per side (default: 1)
}): Promise<MemorySearchResult[]> {
	const { db, prefix, agentId, results, windowSize = 1 } = params
	const maxResults = params.maxResults ?? results.length + 10

	// Identify event-based chunks that can be expanded
	const expandable: Array<{
		result: MemorySearchResult
		sessionId: string
		timestamp: Date
	}> = []
	const existingPaths = new Set(results.map((r) => r.path))

	for (const r of results) {
		if (r.path.startsWith("events/") && r.sessionId && r.timestamp) {
			expandable.push({
				result: r,
				sessionId: r.sessionId,
				timestamp: r.timestamp,
			})
		}
	}

	if (expandable.length === 0) {
		return results
	}

	// Group by sessionId for batched lookups
	const bySession = new Map<
		string,
		Array<{ result: MemorySearchResult; timestamp: Date }>
	>()
	for (const item of expandable) {
		let group = bySession.get(item.sessionId)
		if (!group) {
			group = []
			bySession.set(item.sessionId, group)
		}
		group.push({ result: item.result, timestamp: item.timestamp })
	}

	// Fetch neighbors for each session (one query per session)
	const neighbors: MemorySearchResult[] = []
	const collection = eventsCollection(db, prefix)

	for (const [sessionId, items] of bySession) {
		// Find the min and max timestamps in this session's results
		const timestamps = items.map((i) => i.timestamp.getTime())
		const minTs = Math.min(...timestamps)
		const maxTs = Math.max(...timestamps)

		// Build a time-window query that captures neighbors around all results in this session
		const windowMs = 24 * 60 * 60 * 1000 // 24h default window for neighbor fetch
		const filter: Document = {
			agentId,
			sessionId,
			timestamp: {
				$gte: new Date(minTs - windowMs),
				$lte: new Date(maxTs + windowMs),
			},
		}

		let sessionEvents: Document[]
		try {
			sessionEvents = await collection
				.find(filter)
				.sort({ timestamp: 1 })
				.limit(100)
				.toArray()
		} catch (err) {
			log.warn(
				`context expansion query failed for session=${sessionId}, skipping`,
				{ error: err },
			)
			continue
		}

		// For each expandable result, find its N-1 and N+1 neighbors
		for (const item of items) {
			const parentTimestamp = item.timestamp.getTime()
			const parentScore = item.result.score

			// Find events immediately before and after this one
			const before: typeof sessionEvents = []
			const after: typeof sessionEvents = []

			for (const event of sessionEvents) {
				if (!event.timestamp || !(event.timestamp instanceof Date)) continue
				const eventTs = event.timestamp.getTime()
				if (eventTs < parentTimestamp) {
					before.push(event)
				} else if (eventTs > parentTimestamp) {
					after.push(event)
				}
			}

			// Take the closest N before and after
			const nearestBefore = before.slice(-windowSize)
			const nearestAfter = after.slice(0, windowSize)

			for (const event of [...nearestBefore, ...nearestAfter]) {
				if (!event.sessionId || typeof event.sessionId !== "string") continue
				if (!event.timestamp || !(event.timestamp instanceof Date)) continue

				const eventPath = `events/${event.eventId}`
				if (existingPaths.has(eventPath)) {
					continue // Already in results, skip
				}
				existingPaths.add(eventPath)

				const neighborScore = parentScore * 0.95
				const snippet = renderEventChunkText({
					role: event.role,
					body: event.body,
				})

				neighbors.push({
					path: eventPath,
					filePath: eventPath,
					startLine: 0,
					endLine: 0,
					score: neighborScore,
					snippet,
					source: "conversation",
					sourceType: "conversation",
					sessionId: event.sessionId,
					timestamp: event.timestamp,
				})
			}
		}
	}

	if (neighbors.length === 0) {
		return results
	}

	// Combine and cap at maxResults (drop lowest-scored tail)
	const combined = [...results, ...neighbors]
	combined.sort((a, b) => b.score - a.score)
	return combined.slice(0, maxResults)
}
