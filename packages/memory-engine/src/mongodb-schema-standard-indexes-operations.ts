// Standard (non-search) indexes, valid on every MongoDB edition (P4.3 split from mongodb-schema.ts).
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import {
	kbChunksCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
	proceduresCollection,
	procedureRevisionsCollection,
	eventsCollection,
	episodesCollection,
	ingestRunsCollection,
	projectionRunsCollection,
	queryCacheCollection,
	telemetryCollection,
	accessEventsCollection,
	mutationsCollection,
	laneCoverageCollection,
	consolidationRunsCollection,
	memoryQuarantineCollection,
	recallTracesCollection,
	memoryJobsCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
} from "./mongodb-schema-collections.js"

// ---------------------------------------------------------------------------
// Standard indexes (work on all MongoDB editions)
// ---------------------------------------------------------------------------

import { handleUniqueIndexCreationError } from "./mongodb-schema-index-utils.js"
import type { StandardIndexOptions } from "./mongodb-schema-standard-index-types.js"

export async function ensureOperationalStandardIndexes(
	db: Db,
	prefix: string,
	ttlOpts?: StandardIndexOptions,
): Promise<number> {
	let applied = 0
	const textFallbackIndexes = ttlOpts?.textFallbackIndexes ?? true

	const structured = structuredMemCollection(db, prefix)
	const ingestRuns = ingestRunsCollection(db, prefix)
	await ingestRuns.createIndex(
		{ agentId: 1, ts: -1 },
		{ name: "idx_ingestruns_agent_ts" },
	)
	applied++

	// Projection runs indexes
	const projRuns = projectionRunsCollection(db, prefix)
	await projRuns.createIndex(
		{ agentId: 1, projectionType: 1, ts: -1 },
		{ name: "idx_projruns_agent_type_ts" },
	)
	applied++

	// v2-ready structured memory scope index
	try {
		await structured.createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1 },
			{
				name: "uq_structured_agent_scope_scoperef_type_key_v2",
				unique: true,
				sparse: true,
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(
			err,
			"uq_structured_agent_scope_scoperef_type_key_v2",
		)
		applied++
	}

	const structuredRevisions = structuredMemRevisionsCollection(db, prefix)
	await structuredRevisions.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1, revision: -1 },
		{ name: "idx_structured_revisions_identity_revision" },
	)
	applied++
	// Optional retention cap on structured history (#32). Revisions are the audit
	// trail and the substrate for future historical-version ("as of T reads the
	// value that was current at T") retrieval, so retention is indefinite by
	// default; a destructive TTL is created ONLY when a window is explicitly
	// configured. Keyed on supersededAt (when the revision left the current set).
	if (ttlOpts?.revisionRetentionDays && ttlOpts.revisionRetentionDays > 0) {
		await structuredRevisions.createIndex(
			{ supersededAt: 1 },
			{
				name: "idx_structured_revisions_ttl",
				expireAfterSeconds: ttlOpts.revisionRetentionDays * 24 * 60 * 60,
			},
		)
		applied++
	}

	const procedures = proceduresCollection(db, prefix)
	try {
		await procedures.createIndex(
			{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_procedures_identity", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_procedures_identity")
		applied++
	}
	await procedures.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, state: 1, updatedAt: -1 },
		{ name: "idx_procedures_scope_state_updated" },
	)
	applied++
	await procedures.createIndex(
		{ intentTags: 1 },
		{ name: "idx_procedures_intent_tags" },
	)
	applied++
	await procedures.createIndex(
		{ agentId: 1, sourceEventIds: 1 },
		{ name: "idx_procedures_agent_source_event" },
	)
	applied++
	if (textFallbackIndexes) {
		await procedures.createIndex(
			{ searchText: "text", name: "text" },
			{ name: "idx_procedures_text" },
		)
		applied++
	}

	const procedureRevisions = procedureRevisionsCollection(db, prefix)
	await procedureRevisions.createIndex(
		{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1, revision: -1 },
		{ name: "idx_procedure_revisions_identity_revision" },
	)
	applied++

	// Query Cache indexes
	const queryCache = queryCacheCollection(db, prefix)
	try {
		await queryCache.createIndex(
			{ queryHash: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_query_cache_hash_agent_scope_scoperef", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(
			err,
			"uq_query_cache_hash_agent_scope_scoperef",
		)
		applied++
	}
	await queryCache.createIndex(
		{ expiresAt: 1 },
		{ name: "idx_query_cache_ttl", expireAfterSeconds: 0 },
	)
	applied++
	await queryCache.createIndex(
		{ agentId: 1, hitCount: -1 },
		{ name: "idx_query_cache_agent_hitcount" },
	)
	applied++

	// Telemetry indexes (time series collection — meta field compound indexes)
	const telemetry = telemetryCollection(db, prefix)
	try {
		await telemetry.createIndex(
			{ "meta.agentId": 1, ts: -1 },
			{ name: "idx_telemetry_agent_ts" },
		)
		applied++
		await telemetry.createIndex(
			{ "meta.operation": 1, ts: -1 },
			{ name: "idx_telemetry_op_ts" },
		)
		applied++
	} catch (err) {
		// Time series collection may not exist (creation failed in ensureCollections)
		const msg = err instanceof Error ? err.message : String(err)
		log.warn(`telemetry index creation skipped: ${msg}`)
	}

	const accessEvents = accessEventsCollection(db, prefix)
	try {
		await accessEvents.createIndex(
			{ "meta.agentId": 1, "meta.collection": 1, memoryId: 1, ts: -1 },
			{ name: "idx_access_events_agent_collection_memory_ts" },
		)
		applied++
		await accessEvents.createIndex(
			{ "meta.agentId": 1, "meta.collection": 1, ts: -1 },
			{ name: "idx_access_events_agent_collection_ts" },
		)
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		log.warn(`access events index creation skipped: ${msg}`)
	}

	// Mutation audit trail indexes
	const mutations = mutationsCollection(db, prefix)
	await mutations.createIndex(
		{ agentId: 1, collectionName: 1, timestamp: -1 },
		{ name: "idx_mutations_agent_collection_ts" },
	)
	applied++
	await mutations.createIndex(
		{ timestamp: 1 },
		{ name: "idx_mutations_ttl", expireAfterSeconds: 7776000 },
	)
	applied++
	await mutations.createIndex(
		{ documentId: 1, collectionName: 1, timestamp: -1 },
		{ name: "idx_mutations_doc_collection_ts" },
	)
	applied++

	// Lane coverage indexes
	const laneCoverage = laneCoverageCollection(db, prefix)
	try {
		await laneCoverage.createIndex(
			{ agentId: 1 },
			{ name: "uq_lane_coverage_agentid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_lane_coverage_agentid")
		applied++
	}

	// Episodes promotion index (consolidation queries for promotable episodes)
	const episodesForPromotion = episodesCollection(db, prefix)
	await episodesForPromotion.createIndex(
		{ agentId: 1, importance: -1 },
		{ name: "idx_episodes_promotion" },
	)
	applied++

	// Consolidation runs tracking
	const consolidationRuns = consolidationRunsCollection(db, prefix)
	await consolidationRuns.createIndex(
		{ agentId: 1, startedAt: -1 },
		{ name: "idx_consolidation_runs_agent_time" },
	)
	applied++

	// One Phase-0 gate document per scope identity (atomic lease, see
	// consolidateMemory). Partial so legacy per-run docs without a gateKey
	// never collide on the unique key (the single-null trap for unique
	// indexes); only string-typed gateKeys are constrained.
	await consolidationRuns.createIndex(
		{ gateKey: 1 },
		{
			name: "uq_consolidation_runs_gate",
			unique: true,
			partialFilterExpression: { gateKey: { $type: "string" } },
		},
	)
	applied++

	// KB chunks wiki source filter
	const kbChunksForWiki = kbChunksCollection(db, prefix)
	await kbChunksForWiki.createIndex(
		{ docId: 1, wikiSource: 1 },
		{ name: "idx_kb_chunks_wiki" },
	)
	applied++

	// sourceRef dedup indexes — uses partialFilterExpression because sparse+unique
	// on compound keys doesn't work as expected (agentId is always present, so
	// sparse won't skip docs without sourceRef). partialFilterExpression ensures
	// uniqueness only among docs that actually have a sourceRef field.
	const eventsForSourceRef = eventsCollection(db, prefix)
	try {
		await eventsForSourceRef.createIndex(
			{ agentId: 1, sourceRef: 1 },
			{
				unique: true,
				partialFilterExpression: { sourceRef: { $exists: true } },
				name: "uq_events_sourceref",
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_events_sourceref")
		applied++
	}
	const structuredForSourceRef = structuredMemCollection(db, prefix)
	try {
		await structuredForSourceRef.createIndex(
			{ agentId: 1, sourceRef: 1 },
			{
				unique: true,
				partialFilterExpression: { sourceRef: { $exists: true } },
				name: "uq_structured_sourceref",
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_structured_sourceref")
		applied++
	}
	const proceduresForSourceRef = proceduresCollection(db, prefix)
	try {
		await proceduresForSourceRef.createIndex(
			{ agentId: 1, sourceRef: 1 },
			{
				unique: true,
				partialFilterExpression: { sourceRef: { $exists: true } },
				name: "uq_procedures_sourceref",
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_procedures_sourceref")
		applied++
	}

	// Partial index for current-facts queries on structured_mem.
	// MongoDB partialFilterExpression does not support $ne, so enumerate the
	// live states explicitly to keep the index valid on real Atlas Local.
	await structuredForSourceRef.createIndex(
		{ agentId: 1, type: 1, salience: -1 },
		{
			name: "idx_structured_active_facts",
			partialFilterExpression: { state: { $in: ["active", "conflicted"] } },
		},
	)
	applied++

	// -----------------------------------------------------------------------
	// Recall Traces (Phase 3.10)
	// -----------------------------------------------------------------------

	const recallTraces = recallTracesCollection(db, prefix)
	await recallTraces.createIndex(
		{ agentId: 1, timestamp: -1 },
		{ name: "idx_recall_traces_agent_ts" },
	)
	applied++
	try {
		await recallTraces.createIndex(
			{ traceId: 1 },
			{ name: "uq_recall_traces_traceid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_recall_traces_traceid")
		applied++
	}

	// -----------------------------------------------------------------------
	// Memory Jobs (Phase 3.11)
	// -----------------------------------------------------------------------

	const memoryJobs = memoryJobsCollection(db, prefix)
	try {
		await memoryJobs.createIndex(
			{ jobId: 1 },
			{ name: "uq_memory_jobs_jobid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_memory_jobs_jobid")
		applied++
	}
	// ESR: agentId + status equality, createdAt descending sort
	await memoryJobs.createIndex(
		{ agentId: 1, status: 1, createdAt: -1 },
		{ name: "idx_memory_jobs_agent_status_created" },
	)
	applied++
	await memoryJobs.createIndex(
		{
			agentId: 1,
			jobType: 1,
			status: 1,
			leaseExpiresAt: 1,
			createdAt: 1,
			jobId: 1,
		},
		{ name: "idx_memory_jobs_claim_v2" },
	)
	applied++
	try {
		await memoryJobs.dropIndex("idx_memory_jobs_claim")
	} catch {
		// The v1 index may not exist on fresh installations.
	}
	// TTL on completedAt: only terminal jobs (completed/failed/cancelled) carry
	// the field, so pending/running jobs never expire. 30 days keeps failed
	// jobs inspectable as a dead-letter record before pruning — without this,
	// terminal jobs accumulated forever (fleet audit).
	//
	// Dead letters (attempts exhausted, deadLetterAt set) are deliberately
	// EXEMPT from this TTL: they never carry completedAt, so they are not in
	// the index and never age out. A dead letter is a signal an operator must
	// see — the status counts surface it, and requeueing/deleting it is a
	// deliberate act — not just another finished job to sweep.
	await memoryJobs.createIndex(
		{ completedAt: 1 },
		{ name: "idx_memory_jobs_completed_ttl", expireAfterSeconds: 30 * 86_400 },
	)
	applied++

	// -----------------------------------------------------------------------
	// Memory quarantine (C-004 review lifecycle)
	// -----------------------------------------------------------------------
	const memoryQuarantine = memoryQuarantineCollection(db, prefix)
	try {
		await memoryQuarantine.createIndex(
			{ quarantineId: 1 },
			{ name: "uq_memory_quarantine_quarantineid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_memory_quarantine_quarantineid")
		applied++
	}
	// Review-queue listing: equality on agentId + status, ascending createdAt
	// sort (FIFO queue — oldest pending entry surfaces first).
	await memoryQuarantine.createIndex(
		{ agentId: 1, status: 1, createdAt: 1 },
		{ name: "idx_memory_quarantine_agent_status_created" },
	)
	applied++
	// C-004: TTL cap on unreviewed entries only. Partial on
	// status "pending-review" so promote/reject decisions — the audit trail —
	// never age out; an unreviewed backlog cannot accumulate forever. Same
	// 30-day default as the dead-letter cap above; explicit 0 disables.
	const quarantineRetentionDays =
		ttlOpts?.quarantineRetentionDays !== undefined
			? ttlOpts.quarantineRetentionDays
			: 30
	if (quarantineRetentionDays > 0) {
		await memoryQuarantine.createIndex(
			{ createdAt: 1 },
			{
				name: "idx_memory_quarantine_ttl_pending",
				expireAfterSeconds: quarantineRetentionDays * 24 * 60 * 60,
				partialFilterExpression: { status: "pending-review" },
			},
		)
		applied++
	}

	// Session chunks (Option B session-evidence collection)
	const sessionChunks = sessionChunksCollection(db, prefix)
	try {
		await sessionChunks.createIndex(
			{ agentId: 1, sessionId: 1 },
			{ name: "uq_session_chunks_agent_session", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_session_chunks_agent_session")
		applied++
	}
	await sessionChunks.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_session_chunks_agent_scope" },
	)
	applied++
	await sessionChunks.createIndex(
		{ agentId: 1, timestamp: -1 },
		{ name: "idx_session_chunks_agent_time" },
	)
	applied++
	// C-005: session-evidence docs inherit the latest source-event expiry
	// (absent = the session has a never-expiring event and never expires),
	// so this collection needs the same partial TTL + read-guard pair as the
	// chunks collection.
	await sessionChunks.createIndex(
		{ expiresAt: 1 },
		{
			name: "idx_session_chunks_ttl_expires_at",
			expireAfterSeconds: 0,
			partialFilterExpression: { expiresAt: { $exists: true } },
		},
	)
	applied++

	if (isEvidenceMirrorEnabled()) {
		const memoryEvidence = memoryEvidenceCollection(db, prefix)
		try {
			await memoryEvidence.createIndex(
				{ canonicalId: 1 },
				{ name: "uq_memory_evidence_canonical", unique: true },
			)
			applied++
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("duplicate") || msg.includes("already exists")) {
				log.warn(
					"unique index uq_memory_evidence_canonical: index exists or duplicates detected; skipping",
				)
				applied++
			} else {
				throw err
			}
		}
		await memoryEvidence.createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, unit: 1, status: 1 },
			{ name: "idx_memory_evidence_scope_unit_status" },
		)
		applied++
		await memoryEvidence.createIndex(
			{ agentId: 1, sessionId: 1, unit: 1 },
			{ name: "idx_memory_evidence_session_unit" },
		)
		applied++
		await memoryEvidence.createIndex(
			{ agentId: 1, timestamp: -1 },
			{ name: "idx_memory_evidence_agent_time" },
		)
		applied++
	}

	log.info(`ensured ${applied} standard indexes`)
	return applied
}
