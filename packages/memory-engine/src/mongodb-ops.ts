import { randomUUID } from "node:crypto"
import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import {
	eventsCollection,
	ingestRunsCollection,
	projectionRunsCollection,
} from "./mongodb-schema.js"
import { buildUnexpiredClause } from "./mongodb-temporal.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

const log = createSubsystemLogger("memory:mongodb:ops")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IngestSource =
	| "file-sync"
	| "session-sync"
	| "kb-import"
	| "manual"
	| "event-write"
export type RunStatus = "ok" | "partial" | "failed"
export type ProjectionType =
	| "chunks"
	| "entities"
	| "relations"
	| "episodes"
	| "structured-promotion"
	| "procedures"
	| "entity-brief"
	| "topic-brief"
	| "what-changed"
	| "contradiction-report"

export type IngestRun = {
	runId: string
	agentId: string
	source: IngestSource
	status: RunStatus
	itemsProcessed: number
	itemsFailed: number
	durationMs: number
	ts: Date
}

export type ProjectionRun = {
	runId: string
	agentId: string
	projectionType: ProjectionType
	status: RunStatus
	lag?: number
	itemsProjected: number
	durationMs: number
	ts: Date
}

// ---------------------------------------------------------------------------
// Record functions
// ---------------------------------------------------------------------------

export async function recordIngestRun(params: {
	db: Db
	prefix: string
	run: Omit<IngestRun, "runId" | "ts">
}): Promise<string> {
	const { db, prefix, run } = params
	const runId = randomUUID()
	const doc: IngestRun = { ...run, runId, ts: new Date() }
	try {
		await ingestRunsCollection(db, prefix).insertOne(doc)
		return runId
	} catch (err) {
		log.error("recordIngestRun failed", { runId, error: err })
		throw err
	}
}

export async function recordProjectionRun(params: {
	db: Db
	prefix: string
	run: Omit<ProjectionRun, "runId" | "ts">
}): Promise<string> {
	const { db, prefix, run } = params
	const runId = randomUUID()
	const doc: ProjectionRun = { ...run, runId, ts: new Date() }
	try {
		await projectionRunsCollection(db, prefix).insertOne(doc)
		emitTelemetry(db, prefix, {
			meta: { agentId: run.agentId, operation: "projection-run" },
			durationMs: run.durationMs,
			ok: run.status === "ok",
			itemCount: run.itemsProjected,
		})
		return runId
	} catch (err) {
		log.error("recordProjectionRun failed", { runId, error: err })
		throw err
	}
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function getRecentIngestRuns(params: {
	db: Db
	prefix: string
	agentId: string
	limit?: number
}): Promise<IngestRun[]> {
	const { db, prefix, agentId, limit = 20 } = params
	try {
		const docs = await ingestRunsCollection(db, prefix)
			.find({ agentId })
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ ts: -1 })
			.limit(limit)
			.toArray()
		return docs as unknown as IngestRun[]
	} catch (err) {
		log.error("getRecentIngestRuns failed", { agentId, error: err })
		throw err
	}
}

export async function getRecentProjectionRuns(params: {
	db: Db
	prefix: string
	agentId: string
	projectionType?: ProjectionType
	limit?: number
}): Promise<ProjectionRun[]> {
	const { db, prefix, agentId, projectionType, limit = 20 } = params
	try {
		const filter: Record<string, unknown> = { agentId }
		if (projectionType) {
			filter.projectionType = projectionType
		}
		const docs = await projectionRunsCollection(db, prefix)
			.find(filter)
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ ts: -1 })
			.limit(limit)
			.toArray()
		return docs as unknown as ProjectionRun[]
	} catch (err) {
		log.error("getRecentProjectionRuns failed", {
			agentId,
			projectionType,
			error: err instanceof Error ? err.message : String(err),
		})
		throw err
	}
}

export async function getLatestIngestRun(params: {
	db: Db
	prefix: string
	agentId: string
}): Promise<IngestRun | null> {
	const { db, prefix, agentId } = params
	try {
		const doc = await ingestRunsCollection(db, prefix).findOne(
			{ agentId },
			{ sort: { ts: -1 } },
		)
		return (doc as IngestRun | null) ?? null
	} catch (err) {
		log.error("getLatestIngestRun failed", { agentId, error: err })
		throw err
	}
}

export async function getLatestProjectionRun(params: {
	db: Db
	prefix: string
	agentId: string
	projectionType: ProjectionType
}): Promise<ProjectionRun | null> {
	const { db, prefix, agentId, projectionType } = params
	try {
		const doc = await projectionRunsCollection(db, prefix).findOne(
			{ agentId, projectionType },
			{ sort: { ts: -1 } },
		)
		return (doc as ProjectionRun | null) ?? null
	} catch (err) {
		log.error("getLatestProjectionRun failed", {
			agentId,
			projectionType,
			error: err instanceof Error ? err.message : String(err),
		})
		throw err
	}
}

/**
 * W16: per-lane unmet-obligation filters over the canonical events
 * collection. Each projection lane consumes events through its own pending
 * marker, so the SAME marker defines what the lane still owes:
 * - chunks: events not yet projected (`projectedAt` unset — the filter
 *   `getUnprojectedEvents` uses).
 * - entities / relations / structured-promotion / procedures: events whose
 *   extraction outbox marker is still set (`extractionJobPendingAt` — the
 *   filter `getPendingExtractionEvents` uses); one extraction job fulfills
 *   all four lanes for an event, so they share one marker.
 * - episodes: events the dreamer has not yet considered
 *   (`dreamerProcessedAt` unset — the filter `runDreamer` uses).
 * The brief/contradiction lanes have no per-event pending marker and are
 * deliberately absent: no backlog age is measurable for them.
 */
const PROJECTION_PENDING_EVENT_FILTERS: Partial<
	Record<ProjectionType, Document>
> = {
	chunks: { projectedAt: { $exists: false } },
	entities: { extractionJobPendingAt: { $exists: true } },
	relations: { extractionJobPendingAt: { $exists: true } },
	episodes: { dreamerProcessedAt: { $exists: false } },
	"structured-promotion": { extractionJobPendingAt: { $exists: true } },
	procedures: { extractionJobPendingAt: { $exists: true } },
}

/**
 * W16: lag is the age of the lane's OLDEST unmet projection obligation —
 * not now − last successful run. The old definition degraded a healthy idle
 * agent (no recent runs, nothing owed) while a recent success concealed
 * older stranded events. Null now means "the lane owes nothing" (healthy
 * idle); a thrown error means the backlog is unmeasurable, which the status
 * layer maps to health-uncertain.
 */
export async function getProjectionLag(params: {
	db: Db
	prefix: string
	agentId: string
	projectionType: ProjectionType
}): Promise<number | null> {
	const { db, prefix, agentId, projectionType } = params
	const pendingFilter = PROJECTION_PENDING_EVENT_FILTERS[projectionType]
	if (!pendingFilter) {
		// Brief/contradiction lanes: no per-event pending marker exists, so
		// no backlog age is measurable.
		return null
	}
	try {
		// P4.4.1: expired events are already hidden from every projection
		// reader and removed by the TTL sweep — they are not obligations.
		const oldest = await eventsCollection(db, prefix).findOne(
			{ agentId, ...pendingFilter, ...buildUnexpiredClause() },
			{ sort: { timestamp: 1 }, projection: { timestamp: 1 } },
		)
		if (!oldest) {
			return null
		}
		const ts = oldest.timestamp as Date
		return Math.floor((Date.now() - ts.getTime()) / 1000)
	} catch (err) {
		log.error("getProjectionLag failed", {
			agentId,
			projectionType,
			error: err instanceof Error ? err.message : String(err),
		})
		throw err
	}
}
