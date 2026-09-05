// Collection accessors and time-series fallback (P4.3 split from mongodb-schema.ts).
import type { Collection, Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function col(db: Db, prefix: string, name: string): Collection {
	return db.collection(`${prefix}${name}`)
}

export function chunksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "chunks")
}

export function filesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "files")
}

export function metaCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "meta")
}

export function kbCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "knowledge_base")
}

export function kbChunksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "kb_chunks")
}

export function structuredMemCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "structured_mem")
}

export function structuredMemRevisionsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "structured_mem_revisions")
}

export function proceduresCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "procedures")
}

export function procedureRevisionsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "procedure_revisions")
}

export function relevanceRunsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "relevance_runs")
}

export function relevanceArtifactsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "relevance_artifacts")
}

export function relevanceRegressionsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "relevance_regressions")
}

// v2 collection accessors

export function eventsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "events")
}

export function entitiesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "entities")
}

export function relationsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "relations")
}

export function entityLinksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "entity_links")
}

export function episodesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "episodes")
}

export function ingestRunsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "ingest_runs")
}

export function projectionRunsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "projection_runs")
}

export function queryCacheCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "query_cache")
}

/**
 * Ensure a time series collection exists, falling back to a plain collection
 * with a TTL index on the timeField when time series are unsupported
 * (pre-5.0 / DocumentDB / standalone). On "already exists" the collection is
 * assumed to already be a time series — no fallback is attempted.
 */

/**
 * Detect a "time series unsupported" error — fCV < 5.0 (code 72 / InvalidOptions,
 * message "Time-series collection is not enabled") or pre-5.0 unknown-field
 * rejection (code 9 / 40414). Used to discriminate before falling back to a
 * plain collection; all other errors are rethrown so transient/auth/quota
 * failures are not masked as "unsupported".
 *
 * Source: mongodb/mongo r5.0.0 src/mongo/db/commands/create_command.cpp:147-148;
 * src/mongo/base/error_codes.yml (code 72 = InvalidOptions, 9 = FailedToParse,
 * 40414 = IDLFailedToParse).
 */
function isTimeseriesUnsupported(err: unknown): boolean {
	if (!(err instanceof Error)) return false
	const code = (err as { code?: unknown }).code
	const msg = err.message ?? ""
	// (a) 5.0+ binary, fCV < 5.0: code 72 / InvalidOptions
	if (code === 72) {
		return /time-series collection is not enabled/i.test(msg)
	}
	// (b) pre-5.0 strict IDL: unknown field 'timeseries'
	if (code === 9 || code === 40414) {
		return /unknown field.*timeseries|timeseries.*unknown field/i.test(msg)
	}
	// (c) DocumentDB / other emulations: match a "not supported" message only
	return /time.?series.*(not supported|not enabled|unsupported)/i.test(msg)
}
export async function ensureTimeseriesOrPlain(
	db: Db,
	name: string,
	options: {
		timeField: string
		metaField: string
		granularity: "seconds" | "minutes" | "hours"
		expireAfterSeconds: number
	},
): Promise<void> {
	try {
		await db.createCollection(name, {
			timeseries: {
				timeField: options.timeField,
				metaField: options.metaField,
				granularity: options.granularity,
			},
			expireAfterSeconds: options.expireAfterSeconds,
		})
		log.info(`created time series collection ${name}`)
		return
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (
			msg.includes("already exists") ||
			msg.includes("Collection already exists")
		) {
			return
		}
		// Only fall back to a plain collection if time series is genuinely
		// unsupported (fCV < 5.0 / DocumentDB). Rethrow transient/auth/quota
		// errors so they surface instead of silently downgrading.
		if (!isTimeseriesUnsupported(err)) {
			throw err
		}
		// Fall back to a plain collection with a TTL index on the timeField.
		try {
			await db.createCollection(name)
		} catch (fallbackErr) {
			const fallbackMsg =
				fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
			if (
				!fallbackMsg.includes("already exists") &&
				!fallbackMsg.includes("Collection already exists")
			) {
				throw fallbackErr
			}
		}
		const collection = db.collection(name)
		await collection.createIndex(
			{ [options.timeField]: 1 },
			{ expireAfterSeconds: options.expireAfterSeconds },
		)
		log.info(
			`created plain collection ${name} with TTL index (time series unsupported: ${msg})`,
		)
	}
}

export function telemetryCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_telemetry")
}

export function accessEventsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "access_events")
}

export function mutationsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_mutations")
}

/**
 * Injection-safety: quarantine collection for injection-shaped candidates
 * detected by the consolidator pre-write hook. Rows live here until a human
 * (or a future review gate) promotes or rejects them; they are
 * NEVER written to canonical events/structured_mem directly.
 */
export function memoryQuarantineCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_quarantine")
}

export function laneCoverageCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "lane_coverage")
}

export function consolidationRunsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "consolidation_runs")
}

export function recallTracesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "recall_traces")
}

export function memoryJobsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_jobs")
}

export function sessionChunksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "session_chunks")
}

export function memoryEvidenceCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_evidence")
}

/**
 * C-017: per-tenant per-day spend ledger. One document per
 * (agentId, UTC day, kind) with $inc counters — LLM input/output tokens and
 * embedding units. Unlike memory_telemetry (sampled, 7-day TTL), the ledger
 * is written on every counted spend event and kept for 90 days so daily cost
 * sums survive a weekly reporting cycle.
 */
export function costLedgerCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_cost_ledger")
}
