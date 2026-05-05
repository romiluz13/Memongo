import type { MemorySearchResult } from "./types.js"

/**
 * Merge contiguous chunks from the same session into single blocks.
 *
 * Algorithm:
 * 1. Separate results into conversation chunks (path starts with "events/")
 *    and non-conversation results (episodes, kb, structured, etc.)
 * 2. Group conversation chunks by sessionId
 * 3. Within each session group, sort by timestamp ascending
 * 4. Walk sorted results; merge consecutive chunks (adjacency = consecutive
 *    in the sorted timestamp order of the RETURNED RESULTS)
 * 5. Merged block: max(scores), concatenated snippets (newline-separated), first path
 * 6. Results WITHOUT sessionId pass through unchanged (no merge possible)
 * 7. Return merged + non-conversation results sorted by score descending
 *
 * Properties:
 * - Pure function (no side effects)
 * - Score monotonicity: merged score >= any individual score in block
 * - Results from different sessions are never merged
 * - Non-conversation results pass through unchanged
 * - Results with no sessionId pass through unchanged
 */
export function mergeContiguousChunks(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	if (results.length <= 1) {
		return results
	}

	const eventChunksWithSession: MemorySearchResult[] = []
	const passThrough: MemorySearchResult[] = []

	for (const r of results) {
		if (r.path.startsWith("events/") && r.sessionId) {
			eventChunksWithSession.push(r)
		} else {
			passThrough.push(r)
		}
	}

	if (eventChunksWithSession.length === 0) {
		return results
	}

	// Group by sessionId
	const bySession = new Map<string, MemorySearchResult[]>()
	for (const r of eventChunksWithSession) {
		const sid = r.sessionId!
		let group = bySession.get(sid)
		if (!group) {
			group = []
			bySession.set(sid, group)
		}
		group.push(r)
	}

	const merged: MemorySearchResult[] = []

	for (const [, group] of bySession) {
		// Sort by timestamp ascending
		const sorted = [...group].sort((a, b) => {
			const ta = a.timestamp?.getTime() ?? 0
			const tb = b.timestamp?.getTime() ?? 0
			return ta - tb
		})

		if (sorted.length === 0) continue

		// Walk and merge consecutive
		const current = { ...sorted[0] }
		let maxScore = current.score
		const snippets = [current.snippet]

		for (let i = 1; i < sorted.length; i++) {
			// Always merge consecutive results within same session group
			maxScore = Math.max(maxScore, sorted[i].score)
			snippets.push(sorted[i].snippet)
		}

		merged.push({
			...current,
			score: maxScore,
			snippet: snippets.join("\n"),
		})
	}

	// Combine merged conversation blocks with pass-through results
	const all = [...merged, ...passThrough]
	// Sort by score descending
	all.sort((a, b) => b.score - a.score)
	return all
}
