/**
 * Bi-temporal memory filter (Bi-temporal validity).
 *
 * A memory's validity window is defined by two dates:
 *   - `validAt`   — when the assertion became true (required)
 *   - `invalidAt` — when it stopped being true (null = still valid)
 *
 * Retrieval at `queryTime = T` MUST only return memories satisfying
 *   validAt <= T AND (invalidAt IS NULL OR invalidAt > T)
 *
 * This module is the durable surface for every retrieval path (standard,
 * semantic, hybrid) to enforce current-state and historical-time invariants.
 *
 * MongoDB MCP citation: compound index shape
 * https://www.mongodb.com/docs/manual/core/indexes/index-types/index-compound/
 */

import type { Document } from "mongodb"

/**
 * Shape used by retrieval paths (standard filter + Atlas Search `$vectorSearch`
 * filter + `$rankFusion` inner `$search` compound filter) to enforce the
 * bi-temporal validity predicate at `queryTime`.
 *
 * Returns a MongoDB `$and`-composable `Document` describing:
 *   validAt <= queryTime AND (invalidAt IS NULL OR invalidAt > queryTime)
 *
 * Memories written before the bi-temporal migration may lack `validAt`; those
 * rows are legacy and MUST be treated as valid (retrieval is monotonic across
 * the migration). Callers merge `buildBitemporalFilter` into their existing
 * filter via `$and`.
 */
export function buildBitemporalFilter(queryTime: Date): Document {
	if (!(queryTime instanceof Date) || Number.isNaN(queryTime.getTime())) {
		throw new Error("buildBitemporalFilter: queryTime must be a valid Date")
	}
	return {
		$and: [
			// validAt either missing (legacy pre-migration row) or <= queryTime.
			{
				$or: [
					{ validAt: { $exists: false } },
					{ validAt: { $lte: queryTime } },
				],
			},
			// invalidAt either absent, explicitly null, or strictly greater than queryTime.
			{
				$or: [
					{ invalidAt: { $exists: false } },
					{ invalidAt: null },
					{ invalidAt: { $gt: queryTime } },
				],
			},
		],
	}
}

/**
 * Pure predicate mirror of `buildBitemporalFilter` used by property tests and
 * unit tests that apply the filter to an in-memory array. Keeps the MongoDB
 * filter shape and the TypeScript predicate in one file so they cannot drift.
 */
export function isMemoryValidAt(
	memory: { validAt?: Date | null; invalidAt?: Date | null },
	queryTime: Date,
): boolean {
	if (
		memory.validAt instanceof Date &&
		memory.validAt.getTime() > queryTime.getTime()
	) {
		return false
	}
	if (
		memory.invalidAt instanceof Date &&
		memory.invalidAt.getTime() <= queryTime.getTime()
	) {
		return false
	}
	return true
}
