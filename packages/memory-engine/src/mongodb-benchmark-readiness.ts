/**
 * Benchmark readiness probe (Task 1.5, pass-3 A2, Recommended Default #3).
 *
 * MongoDB Atlas Search `$listSearchIndexes` is the authoritative source for
 * index readiness — it returns the `status` plus a `queryable` boolean. An
 * index can be status=READY and queryable=false during a rebuild, or
 * status=STALE and queryable=true during replication lag. The benchmark
 * harness MUST assert on `queryable === true`, not on `status === "READY"`
 * alone.
 *
 * Reference: MongoDB Manual — $listSearchIndexes.
 *   https://www.mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes/
 *
 * This module is a pure boundary: tests mock it directly (vi.mock) instead
 * of inventing fixture helpers against the manager.
 */

import type { Db } from "mongodb"

export type SearchIndexStatus =
	| "PENDING"
	| "BUILDING"
	| "READY"
	| "STALE"
	| "FAILED"
	| "DELETING"
	| "DOES_NOT_EXIST"

const KNOWN_STATUSES: readonly SearchIndexStatus[] = [
	"PENDING",
	"BUILDING",
	"READY",
	"STALE",
	"FAILED",
	"DELETING",
	"DOES_NOT_EXIST",
]

/** Sentinel symbol returned when `$listSearchIndexes` is unsupported. */
export const BENCHMARK_READINESS_FALLBACK = Symbol(
	"benchmark-readiness-fallback",
)

export type ReadSearchIndexStatusResult =
	| {
			kind: "ok"
			status: SearchIndexStatus
			queryable: boolean
			indexName: string
	  }
	| { kind: "fallback"; reason: "command-not-found" | "unsupported" }

function normalizeStatus(raw: unknown): SearchIndexStatus {
	if (typeof raw !== "string") return "DOES_NOT_EXIST"
	const upper = raw.toUpperCase()
	if ((KNOWN_STATUSES as readonly string[]).includes(upper)) {
		return upper as SearchIndexStatus
	}
	// Unknown string — report as PENDING conservatively; callers should treat
	// anything other than READY+queryable=true as not-ready.
	return "PENDING"
}

function classifyError(err: unknown): "command-not-found" | "unsupported" {
	if (!(err instanceof Error)) return "unsupported"
	const msg = err.message || ""
	if (/command.*not\s*found/i.test(msg)) return "command-not-found"
	if (/\$listSearchIndexes/i.test(msg) && /not supported/i.test(msg)) {
		return "unsupported"
	}
	return "unsupported"
}

/**
 * Read the readiness status of a search index via `$listSearchIndexes`.
 *
 * Returns:
 *   - `{ kind: "ok", status, queryable, indexName }` when the command succeeds.
 *     `status === "DOES_NOT_EXIST"` when no matching index is returned.
 *   - `{ kind: "fallback", reason }` when the command is unsupported on this
 *     server (atlas-local:preview < 8.3 or older self-hosted). Callers
 *     should use the hardened aggregate `$search` fallback probe.
 *
 * Never throws for control-flow reasons; only the aggregate call itself can
 * throw and that is captured and converted to `fallback`.
 */
export async function readSearchIndexStatus(
	db: Pick<Db, "collection">,
	collName: string,
	indexName: string,
): Promise<ReadSearchIndexStatusResult> {
	try {
		// biome-ignore lint/suspicious/noExplicitAny: the aggregate signature in tests is intentionally loose
		const coll = db.collection(collName) as any
		const cursor = coll.aggregate([{ $listSearchIndexes: {} }])
		const docs: Array<{
			name?: unknown
			status?: unknown
			queryable?: unknown
		}> = await cursor.toArray()
		const match = docs.find((d) => d?.name === indexName)
		if (!match) {
			return {
				kind: "ok",
				status: "DOES_NOT_EXIST",
				queryable: false,
				indexName,
			}
		}
		return {
			kind: "ok",
			status: normalizeStatus(match.status),
			queryable: match.queryable === true,
			indexName,
		}
	} catch (err) {
		return { kind: "fallback", reason: classifyError(err) }
	}
}
