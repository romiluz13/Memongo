// C-003: tenant-level erasure. Every collection that stores tenant data is
// deleted for one agent in a single primitive, with per-collection receipts
// and a critical-severity audit record. Before this, memories could only be
// soft-invalidated one handle at a time, so every auxiliary collection
// (jobs, ledgers, caches, telemetry) retained tenant data forever — a
// right-to-erasure compliance liability.
//
// Coverage map (verified against every collection accessor):
//   - 27 collections keyed by top-level agentId: the 15 scope-bearing
//     (chunks, events, structured_mem, structured_mem_revisions, procedures,
//     procedure_revisions, knowledge_base, kb_chunks, entities, relations,
//     entity_links, episodes, query_cache, memory_quarantine, memory_evidence)
//     and the 12 scopeless (files, relevance_runs, relevance_regressions,
//     memory_mutations, ingest_runs, projection_runs, recall_traces,
//     memory_jobs, lane_coverage, consolidation_runs, session_chunks,
//     memory_cost_ledger)
//   - 2 time-series collections keyed by meta.agentId (memory_telemetry,
//     access_events) — the time-series metaField is `meta`, so the tenant
//     identity lives at meta.agentId, not at the top level
//   - relevance_artifacts carries NO agentId (only runId): erased in two
//     phases — collect the agent's relevance_runs ids first, then
//     deleteMany({runId: {$in}}) — BEFORE relevance_runs itself is deleted
//   - meta is global operational state (no agentId) and is deliberately
//     NOT touched
// The audit record is written AFTER the deletes so it survives the
// memory_mutations erase as the durable proof-of-erasure receipt.
// Receipt integrity: a failed relevance-run-id lookup (phase 1) or a failed
// audit write surfaces on the receipt and forces status "partial" — the
// receipt never claims "complete" while known tenant data (artifacts) or the
// proof-of-erasure itself is missing.
import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { recordMutation } from "./mongodb-mutations.js"
import {
	accessEventsCollection,
	chunksCollection,
	consolidationRunsCollection,
	costLedgerCollection,
	entitiesCollection,
	entityLinksCollection,
	episodesCollection,
	eventsCollection,
	filesCollection,
	ingestRunsCollection,
	kbChunksCollection,
	kbCollection,
	laneCoverageCollection,
	memoryEvidenceCollection,
	memoryJobsCollection,
	memoryQuarantineCollection,
	mutationsCollection,
	procedureRevisionsCollection,
	proceduresCollection,
	projectionRunsCollection,
	queryCacheCollection,
	recallTracesCollection,
	relevanceArtifactsCollection,
	relevanceRegressionsCollection,
	relevanceRunsCollection,
	relationsCollection,
	sessionChunksCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
	telemetryCollection,
} from "./mongodb-schema.js"

const log = createSubsystemLogger("memory:mongodb:erasure")

export type TenantErasureCollectionReceipt = {
	/** Collection suffix (unprefixed name, e.g. "events"). */
	collection: string
	/** Documents deleted; 0 when the collection held none for this agent. */
	deleted: number
	/** Set when the delete failed — the receipt reports instead of throwing. */
	error?: string
}

export type TenantErasureReceipt = {
	agentId: string
	/**
	 * "complete" only when every collection delete succeeded AND the
	 * proof-of-erasure audit record was written.
	 */
	status: "complete" | "partial"
	receipts: TenantErasureCollectionReceipt[]
	/** Audit record id; absent when the audit write itself failed. */
	mutationId?: string
	/**
	 * Set when the proof-of-erasure audit write failed — the receipt reports
	 * it instead of throwing, but the status is "partial" because the
	 * erasure has no durable audit trail.
	 */
	auditError?: string
	completedAt: Date
}

/**
 * The agentId-keyed collections erased for a tenant, in deterministic order.
 * `filter` is the deleteMany filter for the agent's documents.
 */
function agentKeyedCollections(
	agentId: string,
): Array<{ collection: string; filter: Document }> {
	return [
		{ collection: "events", filter: { agentId } },
		{ collection: "chunks", filter: { agentId } },
		{ collection: "structured_mem", filter: { agentId } },
		{ collection: "structured_mem_revisions", filter: { agentId } },
		{ collection: "procedures", filter: { agentId } },
		{ collection: "procedure_revisions", filter: { agentId } },
		{ collection: "knowledge_base", filter: { agentId } },
		{ collection: "kb_chunks", filter: { agentId } },
		{ collection: "entities", filter: { agentId } },
		{ collection: "relations", filter: { agentId } },
		{ collection: "entity_links", filter: { agentId } },
		{ collection: "episodes", filter: { agentId } },
		{ collection: "query_cache", filter: { agentId } },
		{ collection: "memory_quarantine", filter: { agentId } },
		{ collection: "memory_evidence", filter: { agentId } },
		{ collection: "files", filter: { agentId } },
		{ collection: "relevance_runs", filter: { agentId } },
		{ collection: "relevance_regressions", filter: { agentId } },
		{ collection: "memory_mutations", filter: { agentId } },
		{ collection: "ingest_runs", filter: { agentId } },
		{ collection: "projection_runs", filter: { agentId } },
		{ collection: "recall_traces", filter: { agentId } },
		{ collection: "memory_jobs", filter: { agentId } },
		{ collection: "lane_coverage", filter: { agentId } },
		{ collection: "consolidation_runs", filter: { agentId } },
		{ collection: "session_chunks", filter: { agentId } },
		{ collection: "memory_cost_ledger", filter: { agentId } },
		// Time-series collections: the tenant identity is the metaField value.
		{ collection: "memory_telemetry", filter: { "meta.agentId": agentId } },
		{ collection: "access_events", filter: { "meta.agentId": agentId } },
	]
}

/** Resolve the collection accessor for a suffix name (erasure-local map). */
function accessorFor(
	db: Db,
	prefix: string,
	suffix: string,
): ReturnType<typeof eventsCollection> {
	switch (suffix) {
		case "events":
			return eventsCollection(db, prefix)
		case "chunks":
			return chunksCollection(db, prefix)
		case "structured_mem":
			return structuredMemCollection(db, prefix)
		case "structured_mem_revisions":
			return structuredMemRevisionsCollection(db, prefix)
		case "procedures":
			return proceduresCollection(db, prefix)
		case "procedure_revisions":
			return procedureRevisionsCollection(db, prefix)
		case "knowledge_base":
			return kbCollection(db, prefix)
		case "kb_chunks":
			return kbChunksCollection(db, prefix)
		case "entities":
			return entitiesCollection(db, prefix)
		case "relations":
			return relationsCollection(db, prefix)
		case "entity_links":
			return entityLinksCollection(db, prefix)
		case "episodes":
			return episodesCollection(db, prefix)
		case "query_cache":
			return queryCacheCollection(db, prefix)
		case "memory_quarantine":
			return memoryQuarantineCollection(db, prefix)
		case "memory_evidence":
			return memoryEvidenceCollection(db, prefix)
		case "files":
			return filesCollection(db, prefix)
		case "relevance_runs":
			return relevanceRunsCollection(db, prefix)
		case "relevance_artifacts":
			return relevanceArtifactsCollection(db, prefix)
		case "relevance_regressions":
			return relevanceRegressionsCollection(db, prefix)
		case "memory_mutations":
			return mutationsCollection(db, prefix)
		case "ingest_runs":
			return ingestRunsCollection(db, prefix)
		case "projection_runs":
			return projectionRunsCollection(db, prefix)
		case "recall_traces":
			return recallTracesCollection(db, prefix)
		case "memory_jobs":
			return memoryJobsCollection(db, prefix)
		case "lane_coverage":
			return laneCoverageCollection(db, prefix)
		case "consolidation_runs":
			return consolidationRunsCollection(db, prefix)
		case "session_chunks":
			return sessionChunksCollection(db, prefix)
		case "memory_cost_ledger":
			return costLedgerCollection(db, prefix)
		case "memory_telemetry":
			return telemetryCollection(db, prefix)
		case "access_events":
			return accessEventsCollection(db, prefix)
		default:
			throw new Error(`unknown erasure collection: ${suffix}`)
	}
}

/**
 * C-003 tenant-level erasure. Deletes every document the agent owns across
 * every collection, returns per-collection receipts, and writes a
 * critical-severity audit record that survives the erase as the
 * proof-of-erasure. A failed collection delete never aborts the sweep —
 * the receipt reports it and the overall status is "partial". The same
 * receipt-integrity rule covers the two indirect failure modes: a failed
 * phase-1 relevance-run-id lookup yields a zero-delete error receipt for
 * relevance_artifacts, and a failed audit write surfaces as
 * receipt.auditError — neither may report "complete".
 */
export async function deleteAllForAgent(params: {
	db: Db
	prefix: string
	agentId: string
}): Promise<TenantErasureReceipt> {
	const { db, prefix, agentId } = params

	// Phase 1: collect the agent's relevance run ids BEFORE relevance_runs is
	// deleted — relevance_artifacts has no agentId and can only be reached
	// through its parent run. A phase-1 failure is NOT silently degraded:
	// the agent's artifacts are then known-unswept tenant data, so it is
	// reported as a zero-delete error receipt (forcing status "partial").
	let artifactRunIds: string[] = []
	let artifactPhaseError: string | undefined
	try {
		const runs = await relevanceRunsCollection(db, prefix)
			.find({ agentId }, { projection: { _id: 0, runId: 1 } })
			.toArray()
		artifactRunIds = runs
			.map((run) => (run as { runId?: unknown }).runId)
			.filter((runId): runId is string => typeof runId === "string")
	} catch (err) {
		artifactPhaseError = err instanceof Error ? err.message : String(err)
		log.warn("relevance run id collection failed; artifacts not swept", {
			agentId,
			error: err,
		})
	}

	// Phase 2: every delete runs to completion; failures become receipts.
	const targets: Array<{ collection: string; filter: Document }> = [
		...agentKeyedCollections(agentId),
	]
	if (artifactRunIds.length > 0) {
		targets.push({
			collection: "relevance_artifacts",
			filter: { runId: { $in: artifactRunIds } },
		})
	}

	const receipts: TenantErasureCollectionReceipt[] = []
	await Promise.all(
		targets.map(async (target) => {
			try {
				const result = await accessorFor(
					db,
					prefix,
					target.collection,
				).deleteMany(target.filter)
				receipts.push({
					collection: target.collection,
					deleted: result.deletedCount ?? 0,
				})
			} catch (err) {
				receipts.push({
					collection: target.collection,
					deleted: 0,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}),
	)
	// Deterministic order regardless of settle order.
	// Phase-1 failure: relevance_artifacts could not be swept, so it gets a
	// zero-delete error receipt alongside the successful deletes — the
	// per-collection receipts stay a complete account of what was erased.
	if (artifactPhaseError !== undefined) {
		receipts.push({
			collection: "relevance_artifacts",
			deleted: 0,
			error: `relevance run ids unavailable: ${artifactPhaseError}`,
		})
	}
	receipts.sort((a, b) => a.collection.localeCompare(b.collection))

	const deletesOk = receipts.every((receipt) => receipt.error === undefined)
	const completedAt = new Date()

	// Audit record AFTER the deletes: it survives the memory_mutations erase
	// as the durable proof-of-erasure. The write must not throw (the deletes
	// are already durable), but a failed audit is a broken proof-of-erasure:
	// it is surfaced as receipt.auditError and forces status "partial".
	let mutationId: string | undefined
	let auditError: string | undefined
	try {
		const recorded = await recordMutation({
			db,
			prefix,
			mutation: {
				collectionName: "*",
				documentId: agentId,
				operation: "delete",
				agentId,
				oldValue: null,
				newValue: null,
				severity: "critical",
				meta: {
					kind: "tenant-erasure",
					status: deletesOk ? "complete" : "partial",
					collections: receipts.length,
					deletedTotal: receipts.reduce((sum, r) => sum + r.deleted, 0),
					failedCollections: receipts
						.filter((r) => r.error !== undefined)
						.map((r) => r.collection),
					completedAt,
				},
			},
		})
		mutationId = recorded.mutationId
	} catch (err) {
		auditError = err instanceof Error ? err.message : String(err)
		log.warn("tenant erasure audit record failed", { agentId, error: err })
	}

	// "complete" requires both a fully successful sweep AND the durable
	// proof-of-erasure audit record.
	const status: TenantErasureReceipt["status"] =
		deletesOk && auditError === undefined ? "complete" : "partial"

	const receipt: TenantErasureReceipt = {
		agentId,
		status,
		receipts,
		completedAt,
		...(mutationId ? { mutationId } : {}),
		...(auditError ? { auditError } : {}),
	}

	if (status === "partial") {
		log.warn("tenant erasure completed with failures", {
			agentId,
			failed: receipts
				.filter((r) => r.error !== undefined)
				.map((r) => r.collection),
		})
	} else {
		log.info("tenant erasure complete", {
			agentId,
			collections: receipts.length,
		})
	}
	return receipt
}
