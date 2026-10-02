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
//   - relevance_artifacts: legacy rows carry no agentId (only runId) and
//     are swept through the runId join; new rows carry their own immutable
//     agentId (mongodb-relevance.ts persistRun) and are swept directly.
//     Artifacts are deleted BEFORE relevance_runs, and whenever artifact
//     ownership cannot be fully resolved or the artifact delete fails, the
//     relevance_runs parents are RETAINED for the next attempt (W02) so a
//     retry can never report complete with artifacts still present.
//   - meta is global operational state (no agentId) and is deliberately
//     NOT swept — which is also where the per-agent erasure epoch lives
//     (mongodb-erasure-epoch.ts, W03 fence). The ONE deliberate exception
//     (S3, plan e5ec10dc §4.4): the erased agent's KB auto-refresh marker
//     (`kb_last_auto_refresh:<agentId>`, mongodb-manager-sync.ts §4.1) is
//     removed exact-_id WITH COMPLETION, inside the finalize writeAudit —
//     completion-only deletion (C6), and a failed delete forces
//     FinalizeAuditWriteError, blocking the complete receipt (C5).
// Gate integration (production erasure integration grant): the sweep runs
// behind the erasure gate — beginErasure closes admission (or, for
// recovery:"takeover", the existing takeover primitive dispatches
// directly, replacing the observed owner); every delete batch runs inside
// a withFencedWrite transaction that validates ownership and advances the
// serial; completion is granted ONLY by finalizeErasure, which couples the
// authoritative in-transaction recount, the proof-of-erasure audit record,
// and the conditional gate reopen in ONE transaction. The audit record
// therefore survives the memory_mutations erase as the durable
// proof-of-erasure receipt. There is no unfenced delete path under any
// condition: a retained time-series diagnostic sink fails closed before
// the sweep (named, partial, admission stays closed, migration required).
// Receipt integrity (F2-corrected + final grant): a failed begin/takeover
// aborts with no deletes (epochError; runId and gateState both omitted);
// unresolved artifact ownership or a failed artifact sweep retains the
// relevance_runs parents (partial); any batch failure, verification
// residual, audit failure, or finalize failure forces "partial", and
// gateState "erasing" is claimed only when the fenced partial audit
// ACKNOWLEDGED this attempt's ownership (C-1: that acknowledgment is the
// evidence — an audit that errors without confirming ownership omits
// gateState, since begin success or an unobserved conflict is not
// ownership evidence) — the receipt never claims "complete" while known
// tenant data, unverified state, or the proof-of-erasure itself is
// missing. Ownership loss aborts immediately with
// ownershipLost:true and NO gateState claim (the displaced owner cannot
// prove the gate's true state); a commit-ambiguous finalize is reported
// honestly as finalizeIndeterminate with no gateState claim, no
// compensating reopen/reclose, and no token reacquisition.
import type { Db, Document, ObjectId } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import {
	beginErasure,
	type ErasureToken,
	isErasureGateConflictError,
	takeoverErasure,
} from "./mongodb-erasure-epoch.js"
import { finalizeErasure, withFencedWrite } from "./mongodb-write-fence.js"
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
	metaCollection,
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
	 * "complete" only when every fenced batch succeeded, both verification
	 * stages found no residual tenant documents (the post-sweep counts AND
	 * the authoritative in-finalize recount), the proof-of-erasure audit
	 * record was written, AND finalizeErasure reopened the gate — all
	 * coupled in the single finalize transaction.
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
	/**
	 * The erasure epoch this attempt fenced with — the gate epoch advanced
	 * by beginErasure (or inherited by takeoverErasure). Same numeric
	 * meaning as the legacy bump: every worker that claimed this tenant's
	 * work at a lower epoch abandons at its next fence check; work claimed
	 * at this epoch or later is legitimate post-erasure activity.
	 */
	epoch?: number
	/**
	 * Set when gate entry itself failed (beginErasure — or takeoverErasure
	 * for a recovery request — with a non-conflict error): NO deletes ran
	 * in that attempt. An unfenced erasure must never sweep. Conflict
	 * errors never land here; they propagate for the typed admin 409.
	 */
	epochError?: string
	/**
	 * Gate integration: identity of this erasure run. Present on every
	 * receipt from an attempt that acquired a token (complete, still-owned
	 * partial, ownership-lost partial). Omitted on gate-entry failure —
	 * no token exists.
	 */
	runId?: string
	/**
	 * The gate state THIS attempt established: "open" only on a complete
	 * receipt (the attempt's own successful finalize reopened the gate);
	 * "erasing" only on a partial receipt whose fenced partial audit
	 * ACKNOWLEDGED — the audit transaction's fence re-validated
	 * ownership, which begin/takeover success and an unobserved conflict
	 * cannot (C-1). Omitted on ownership loss, finalize-indeterminate
	 * outcomes, gate-entry failure, and partials whose audit errored
	 * without confirming ownership — the receipt never asserts a gate
	 * state the attempt did not itself establish (F2-corrected, C-1).
	 */
	gateState?: "open" | "erasing"
	/**
	 * Set when ownership was lost mid-attempt — a fenced batch or the
	 * finalize owner validation observed a successor's takeover. The
	 * attempt aborted immediately: no further deletes, no re-begin, no
	 * re-takeover, no finalize, no post-loss scanning. Terminal for the
	 * attempt; gateState is omitted because the displaced owner cannot
	 * prove the gate's true state.
	 */
	ownershipLost?: true
	/**
	 * Set when the finalize transaction failed with a commit-ambiguous
	 * outcome (the commit may have landed): the attempt can prove neither
	 * "open" (its finalize acknowledgment never arrived) nor "erasing"
	 * (the finalize may have committed and reopened). No compensating
	 * reopen/reclose and no token reacquisition — the operator reads the
	 * true gate state and recovers deliberately.
	 */
	finalizeIndeterminate?: true
	/**
	 * Set when this attempt started through the deliberate recovery entry
	 * (recovery:"takeover" replaced the observed owner).
	 */
	recovery?: "takeover"
	/**
	 * W03: post-sweep verification. `residual` lists collections that still
	 * held this agent's documents after the sweep (a concurrent writer
	 * resurrecting data, or a delete that under-reported); any residual
	 * forces status "partial".
	 */
	verification?: {
		checked: number
		residual: Array<{ collection: string; count: number }>
	}
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
 * Upper bound on documents deleted per fenced transaction (§3.3): the sweep
 * runs as bounded sequential batches, never an unbounded all-collection
 * transaction. 500 follows the engine's existing batch precedents
 * (IMPORT_WRITE_BATCH_SIZE; episode fetch limits).
 */
const ERASE_SWEEP_BATCH_SIZE = 500

/**
 * The diagnostic sinks — the only sweep targets with time-series history.
 * Fresh deployments create both as ordinary collections; retained
 * time-series instances exist only on legacy deployments pending the W13
 * conversion and fail closed (§3.6).
 */
const DIAGNOSTIC_SINK_SUFFIXES = ["memory_telemetry", "access_events"] as const

const TIMESERIES_RETAINED_REASON =
	"time-series collection: transactional delete unsupported; migration to ordinary (W13 boundary) required, then deliberate recovery"

function errorToString(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * Commit-ambiguous outcome (§3.5): the driver surfaced an error after the
 * commit was sent (UnknownTransactionCommitResult) — the commit may have
 * landed, so neither outcome can be proven.
 */
function isCommitAmbiguousError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) {
		return false
	}
	const labels = (err as { errorLabels?: unknown }).errorLabels
	return (
		Array.isArray(labels) && labels.includes("UnknownTransactionCommitResult")
	)
}

/**
 * Transaction-illegal / time-series-unsupported error class (§3.6
 * backstop): a diagnostic-sink batch that fails with this shape gets the
 * fail-closed migration-required reason instead of a bare error string.
 */
function isTimeseriesUnsupportedError(err: unknown): boolean {
	return /time[- ]?series/i.test(errorToString(err))
}

/**
 * Gate-entry failure (§3.5): no token exists and NO deletes ran. The
 * receipt carries epochError only — runId and gateState are both omitted
 * because nothing about the gate is proven from this seat.
 */
function gateEntryFailureReceipt(
	agentId: string,
	err: unknown,
): TenantErasureReceipt {
	log.warn("tenant erasure gate entry failed; refusing to sweep unfenced", {
		agentId,
		error: err,
	})
	return {
		agentId,
		status: "partial",
		receipts: [],
		epochError: errorToString(err),
		completedAt: new Date(),
	}
}

/**
 * Fenced partial-attempt audit (§3.5, C-1): a partial records its
 * outcome through the SAME fence — ownership is re-validated and the
 * serial advanced, so the durable audit trail can never disagree with
 * the gate state (meta status "partial", runId, gateLeftErasing:true).
 * The audit's ACKNOWLEDGMENT is the ownership evidence a partial
 * receipt's gateState:"erasing" cites — begin/takeover success and an
 * unobserved conflict prove nothing (a successor may have completed
 * while this attempt's fence was never re-checked). A non-conflict
 * failure here (auditError) leaves ownership UNCONFIRMED: callers omit
 * gateState entirely — no invented ownershipLost (no conflict was
 * observed), no finalizeIndeterminate (this path never finalized). A
 * conflict here means ownership was lost after all — the caller reports
 * ownershipLost instead of a partial-audit result.
 */
async function writeFencedPartialAudit(params: {
	db: Db
	prefix: string
	token: ErasureToken
	meta: Record<string, unknown>
}): Promise<{
	mutationId?: string
	auditError?: string
	ownershipLost?: true
}> {
	const { db, prefix, token, meta } = params
	try {
		const recorded = await withFencedWrite({
			db,
			prefix,
			token,
			fn: (session) =>
				recordMutation({
					db,
					prefix,
					session,
					mutation: {
						collectionName: "*",
						documentId: token.agentId,
						operation: "delete",
						agentId: token.agentId,
						oldValue: null,
						newValue: null,
						severity: "critical",
						meta: {
							...meta,
							status: "partial",
							runId: token.runId,
							gateLeftErasing: true,
						},
					},
				}),
		})
		return { mutationId: recorded.mutationId }
	} catch (err) {
		if (isErasureGateConflictError(err)) {
			return { ownershipLost: true }
		}
		log.warn("tenant erasure partial audit record failed", {
			agentId: token.agentId,
			error: err,
		})
		return { auditError: errorToString(err) }
	}
}

/** True for the two diagnostic-sink sweep targets (§3.6 backstop naming). */
function isDiagnosticSink(suffix: string): boolean {
	return (DIAGNOSTIC_SINK_SUFFIXES as readonly string[]).includes(suffix)
}

/**
 * Internal tag: the proof-of-erasure audit write inside finalizeErasure
 * failed — the finalize transaction aborted because the audit record could
 * not be persisted; the receipt surfaces this as auditError.
 */
class FinalizeAuditWriteError extends Error {
	constructor(cause: unknown) {
		super(`proof-of-erasure audit write failed: ${errorToString(cause)}`)
		this.name = "FinalizeAuditWriteError"
	}
}

/**
 * Bounded fenced batch sweep of ONE collection (§3.3): sequential rounds of
 * an id fetch OUTSIDE any transaction (also the pause seam for tests), then
 * a withFencedWrite transaction deleting at most ERASE_SWEEP_BATCH_SIZE
 * ids ANDed with the tenant filter — a stale id set can never delete
 * outside the tenant. The fenced callback only computes and RETURNS the
 * committed delta; accumulation happens outside the fence, and a
 * withTransaction re-run of the body on a transient error never
 * double-counts because only the committed attempt's return survives
 * (F8). Deltas are informational — the complete verdict rests exclusively
 * on the two-stage recount. A fence conflict is ownership loss (the caller
 * aborts the whole attempt); a diagnostic-sink batch failing with a
 * transaction-illegal/time-series error is named with the fail-closed
 * migration reason (§3.6 backstop).
 */
async function sweepCollectionFenced(params: {
	db: Db
	prefix: string
	token: ErasureToken
	collection: string
	filter: Document
}): Promise<{
	deleted: number
	error?: string
	ownershipLost?: true
}> {
	const { db, prefix, token, collection, filter } = params
	const accessor = accessorFor(db, prefix, collection)
	let deleted = 0
	for (;;) {
		let ids: ObjectId[]
		try {
			const docs = await accessor
				.find(filter, {
					projection: { _id: 1 },
					limit: ERASE_SWEEP_BATCH_SIZE,
				})
				.toArray()
			// The projection guarantees each doc is exactly { _id }, so the
			// only untyped field on the wire is the id itself.
			ids = docs.map((doc) => doc._id as ObjectId)
		} catch (err) {
			return { deleted, error: errorToString(err) }
		}
		if (ids.length === 0) {
			return { deleted }
		}
		try {
			const batchDeleted = await withFencedWrite({
				db,
				prefix,
				token,
				fn: async (session) => {
					const result = await accessor.deleteMany(
						{ ...filter, _id: { $in: ids } },
						{ session },
					)
					return result.deletedCount ?? 0
				},
			})
			deleted += batchDeleted
		} catch (err) {
			if (isErasureGateConflictError(err)) {
				return { deleted, ownershipLost: true }
			}
			return {
				deleted,
				error:
					isDiagnosticSink(collection) && isTimeseriesUnsupportedError(err)
						? TIMESERIES_RETAINED_REASON
						: errorToString(err),
			}
		}
	}
}

/**
 * C-003 tenant-level erasure. Deletes every document the agent owns across
 * every collection, returns per-collection receipts, and writes a
 * critical-severity audit record that survives the erase as the
 * proof-of-erasure. A failed collection delete never aborts the sweep —
 * the receipt reports it and the overall status is "partial".
 *
 * W02 (retry integrity): relevance_artifacts are swept BEFORE their
 * relevance_runs parents, and the parents are RETAINED for the next
 * attempt whenever artifact ownership could not be fully resolved or the
 * artifact delete failed — a retry can therefore never report "complete"
 * while tenant artifacts are still present.
 *
 * Gate integration (production erasure integration grant): the sweep runs
 * behind the erasure gate — beginErasure closes admission (or a recovery
 * request dispatches directly to the existing takeover primitive); every
 * delete batch runs inside a withFencedWrite transaction that validates
 * ownership and advances the serial; completion is granted ONLY by
 * finalizeErasure, which couples the authoritative in-transaction recount,
 * the proof-of-erasure audit record, and the conditional gate reopen in
 * ONE transaction. A fence conflict aborts the attempt immediately
 * (ownershipLost; no re-begin, no re-takeover, no finalize, no post-loss
 * scanning). There is no unfenced delete path under any condition: a
 * retained time-series diagnostic sink fails closed before the sweep
 * (named, partial, admission stays closed, migration required), and the
 * audit record written inside finalize survives the memory_mutations erase
 * as the durable proof-of-erasure.
 */
export async function deleteAllForAgent(params: {
	db: Db
	prefix: string
	agentId: string
	/**
	 * Deliberate recovery entry (F9): dispatches DIRECTLY to the existing
	 * takeover primitive — it never attempts a fresh begin. Meaningful
	 * only while an owner holds the gate: if the gate is open/absent, or
	 * the original owner's finalize raced the recovery, takeoverErasure
	 * throws ErasureGateConflictError (typed admin 409; the operator
	 * retries ordinary). Racing recoveries: one CAS winner, the loser
	 * 409s. The literal "takeover" flows unchanged through every layer;
	 * no boolean translation exists anywhere in the chain.
	 */
	recovery?: "takeover"
}): Promise<TenantErasureReceipt> {
	const { db, prefix, agentId, recovery } = params

	// Gate entry (§3.1): beginErasure closes admission (gate -> erasing,
	// epoch advanced, runId ours) in place of the legacy unfenced bump. A
	// recovery request dispatches DIRECTLY to takeoverErasure — never a
	// fresh begin — so an open/absent gate or a raced finalize conflicts
	// here. Conflict errors propagate for the typed admin 409; any other
	// entry failure means no token and NO deletes ran (epochError receipt;
	// runId and gateState both omitted — nothing is proven).
	let token: ErasureToken
	let recovered = false
	if (recovery === "takeover") {
		try {
			token = await takeoverErasure({ db, prefix, agentId })
			recovered = true
		} catch (err) {
			if (isErasureGateConflictError(err)) {
				throw err // open/absent gate or raced finalize: typed admin 409
			}
			return gateEntryFailureReceipt(agentId, err)
		}
	} else {
		try {
			token = await beginErasure({ db, prefix, agentId })
		} catch (err) {
			if (isErasureGateConflictError(err)) {
				throw err // an active owner holds the gate: typed admin 409
			}
			return gateEntryFailureReceipt(agentId, err)
		}
	}

	// §3.6 fail-closed pre-sweep type check — the ONLY time-series handling
	// in the eraser; there is no unfenced branch anywhere. Both diagnostic
	// sinks are ordinary collections on fresh deployments (verified
	// initializer bytes); a RETAINED time-series instance (legacy
	// deployments pending the W13 conversion) ends the attempt partial with
	// ZERO deletes — nothing half-erased, the gate stays erasing (admission
	// closed), and the receipt names the sink with the migration-required
	// reason. A failed type-check read leaves the sink's safety unproven,
	// so the same fail-closed treatment applies with the observed error.
	const retainedSinks: Array<{ collection: string; reason: string }> = []
	for (const suffix of DIAGNOSTIC_SINK_SUFFIXES) {
		try {
			const infos = await db
				.listCollections({ name: `${prefix}${suffix}` }, { nameOnly: false })
				.toArray()
			const info = infos[0] as { type?: unknown } | undefined
			if (info?.type === "timeseries") {
				retainedSinks.push({
					collection: suffix,
					reason: TIMESERIES_RETAINED_REASON,
				})
			}
		} catch (err) {
			log.warn("diagnostic sink type check failed; failing closed", {
				agentId,
				collection: suffix,
				error: err,
			})
			retainedSinks.push({
				collection: suffix,
				reason: `collection type check failed: ${errorToString(err)}`,
			})
		}
	}
	if (retainedSinks.length > 0) {
		const receipts: TenantErasureCollectionReceipt[] = retainedSinks.map(
			(entry) => ({
				collection: entry.collection,
				deleted: 0,
				error: entry.reason,
			}),
		)
		const completedAt = new Date()
		const audit = await writeFencedPartialAudit({
			db,
			prefix,
			token,
			meta: {
				kind: "tenant-erasure",
				epoch: token.epoch,
				collections: receipts.length,
				deletedTotal: 0,
				failedCollections: receipts.map((r) => r.collection),
				residualCollections: [],
				completedAt,
			},
		})
		log.warn("tenant erasure failed closed on retained diagnostic sink", {
			agentId,
			retained: retainedSinks.map((r) => r.collection),
		})
		return {
			agentId,
			status: "partial",
			receipts,
			epoch: token.epoch,
			runId: token.runId,
			// C-1: gateState:"erasing" cites the audit's fence re-validation,
			// not begin success — an audit that errored without confirming
			// ownership leaves the gate state unproven from this seat.
			...(audit.ownershipLost
				? { ownershipLost: true as const }
				: audit.auditError === undefined
					? { gateState: "erasing" as const }
					: {}),
			...(recovered ? { recovery: "takeover" as const } : {}),
			...(audit.mutationId ? { mutationId: audit.mutationId } : {}),
			...(audit.auditError ? { auditError: audit.auditError } : {}),
			completedAt,
		}
	}

	// Phase 1: collect the agent's relevance run ids BEFORE relevance_runs
	// is deleted — legacy relevance_artifacts rows carry no agentId and can
	// only be reached through their parent run. A phase-1 failure (or a run
	// row without a usable runId) leaves artifact ownership UNRESOLVED: the
	// parents are retained for the next attempt (W02) so the retry can
	// re-resolve and sweep the children first.
	const artifactRunIds: string[] = []
	let unresolvedOwnership = false
	let ownershipError: string | undefined
	try {
		const runs = await relevanceRunsCollection(db, prefix)
			.find({ agentId }, { projection: { _id: 0, runId: 1 } })
			.toArray()
		let runsWithoutUsableRunId = 0
		for (const run of runs) {
			const runId = (run as { runId?: unknown }).runId
			if (typeof runId === "string") {
				artifactRunIds.push(runId)
			} else {
				runsWithoutUsableRunId++
			}
		}
		if (runsWithoutUsableRunId > 0) {
			unresolvedOwnership = true
			ownershipError = `${runsWithoutUsableRunId} relevance run document(s) have no usable runId; their artifacts cannot be resolved`
			log.warn("relevance runs without usable runId; retaining parents", {
				agentId,
				runsWithoutUsableRunId,
			})
		}
	} catch (err) {
		unresolvedOwnership = true
		ownershipError = err instanceof Error ? err.message : String(err)
		log.warn("relevance run id collection failed; artifacts not swept", {
			agentId,
			error: err,
		})
	}

	// Phase 1.5 (W02): sweep relevance_artifacts FIRST, in fenced batches,
	// BEFORE the per-collection sweep can delete their parents. The agentId
	// arm covers artifacts written with their own tenant identity; the
	// runId arm covers legacy rows while their parents still exist. Runs
	// even when phase 1 failed (the agentId arm is independent of the run
	// join). A fence conflict here is ownership loss for the whole attempt.
	const artifactFilter: Document = {
		$or: [
			{ agentId },
			...(artifactRunIds.length > 0
				? [{ runId: { $in: artifactRunIds } }]
				: []),
		],
	}
	let ownershipLost = false
	let artifactDeleteFailed = false
	let artifactReceipt: TenantErasureCollectionReceipt
	const artifactSweep = await sweepCollectionFenced({
		db,
		prefix,
		token,
		collection: "relevance_artifacts",
		filter: artifactFilter,
	})
	if (artifactSweep.ownershipLost === true) {
		ownershipLost = true
		artifactReceipt = {
			collection: "relevance_artifacts",
			deleted: artifactSweep.deleted,
		}
	} else if (artifactSweep.error !== undefined) {
		artifactDeleteFailed = true
		artifactReceipt = {
			collection: "relevance_artifacts",
			deleted: artifactSweep.deleted,
			error: artifactSweep.error,
		}
		log.warn("relevance artifact sweep failed; retaining parents", {
			agentId,
			error: artifactSweep.error,
		})
	} else {
		artifactReceipt = {
			collection: "relevance_artifacts",
			deleted: artifactSweep.deleted,
		}
	}

	// W02 retention rule: whenever artifact ownership was unresolved or the
	// artifact delete failed, relevance_runs stays OUT of this attempt's
	// sweep. The next attempt re-resolves the children from the retained
	// parents, sweeps them, and only then deletes the parents — the
	// retry-false-complete path is structurally gone.
	const retainRelevanceRuns = unresolvedOwnership || artifactDeleteFailed

	// Phase 2 (§3.3): every remaining collection sweeps in bounded fenced
	// batches, strictly sequential — one owned session per batch, no
	// Promise.all, no shared sessions, no unbounded all-collection
	// transaction. A fence conflict aborts the WHOLE attempt immediately
	// (ownership lost: no re-begin, no re-takeover, no finalize); any other
	// batch failure ends only that collection (receipt error, partial).
	const targets: Array<{ collection: string; filter: Document }> =
		agentKeyedCollections(agentId).filter(
			(target) =>
				!(retainRelevanceRuns && target.collection === "relevance_runs"),
		)

	const receipts: TenantErasureCollectionReceipt[] = [artifactReceipt]
	if (!ownershipLost) {
		for (const target of targets) {
			const sweep = await sweepCollectionFenced({
				db,
				prefix,
				token,
				collection: target.collection,
				filter: target.filter,
			})
			receipts.push(
				sweep.error !== undefined || sweep.ownershipLost === true
					? {
							collection: target.collection,
							deleted: sweep.deleted,
							...(sweep.error !== undefined ? { error: sweep.error } : {}),
						}
					: { collection: target.collection, deleted: sweep.deleted },
			)
			if (sweep.ownershipLost === true) {
				ownershipLost = true
				break // abort: no further deletes, no finalize
			}
			if (sweep.error !== undefined) {
				log.warn("tenant erasure collection sweep failed", {
					agentId,
					collection: target.collection,
					error: sweep.error,
				})
			}
		}
	}
	if (ownershipLost) {
		// §3.5 terminal abort — ownership was lost mid-sweep. The displaced
		// attempt stops HERE after recording the loss: no post-loss
		// scanning, no clearing of successor/fresh data, no verification
		// claims, no finalize. gateState is omitted — the true state is
		// unproven from this seat (the successor may already have reopened).
		if (retainRelevanceRuns) {
			receipts.push({
				collection: "relevance_runs",
				deleted: 0,
				error: `retained for artifact retry: ${
					ownershipError ??
					(artifactDeleteFailed
						? "artifact sweep failed this attempt"
						: "artifact ownership unresolved")
				}`,
			})
		}
		receipts.sort((a, b) => a.collection.localeCompare(b.collection))
		log.warn("tenant erasure attempt lost ownership; aborting", {
			agentId,
			runId: token.runId,
		})
		return {
			agentId,
			status: "partial",
			receipts,
			epoch: token.epoch,
			runId: token.runId,
			ownershipLost: true,
			completedAt: new Date(),
		}
	}
	if (retainRelevanceRuns) {
		// The retained parents are reported on the receipt so "partial" is
		// explained: ownership is kept deliberately so the retry can resolve
		// the children first.
		receipts.push({
			collection: "relevance_runs",
			deleted: 0,
			error: `retained for artifact retry: ${
				ownershipError ??
				(artifactDeleteFailed
					? "artifact sweep failed this attempt"
					: "artifact ownership unresolved")
			}`,
		})
	}
	receipts.sort((a, b) => a.collection.localeCompare(b.collection))

	const deletesOk =
		receipts.every((receipt) => receipt.error === undefined) &&
		!retainRelevanceRuns

	// Verification stage 1 (§3.4): re-count every swept target (and the
	// artifact filter) AFTER the deletes, with plain reads outside any
	// transaction. Any residual tenant document — a concurrent writer
	// resurrecting data, or a delete that under-reported — is listed on the
	// receipt and forces "partial". The retained relevance_runs parents are
	// expected survivors this attempt and are excluded from the residual
	// check. Runs BEFORE the audit write so the proof-of-erasure record (an
	// agentId-keyed memory_mutations doc written after this point) is not
	// counted as residual. The same counts are re-run if a finalize attempt
	// later fails, so a resurrection between the two stages is surfaced on
	// the final receipt.
	const verifyTargets: Array<{ collection: string; filter: Document }> = [
		{ collection: "relevance_artifacts", filter: artifactFilter },
		...targets,
	]
	const countResiduals = async (): Promise<{
		checked: number
		residual: Array<{ collection: string; count: number }>
	}> => {
		const residual: Array<{ collection: string; count: number }> = []
		for (const target of verifyTargets) {
			try {
				const count = await accessorFor(
					db,
					prefix,
					target.collection,
				).countDocuments(target.filter)
				if (count > 0) {
					residual.push({ collection: target.collection, count })
				}
			} catch (err) {
				residual.push({
					collection: target.collection,
					count: -1,
				})
				log.warn("post-sweep verification count failed", {
					agentId,
					collection: target.collection,
					error: err,
				})
			}
		}
		return { checked: verifyTargets.length, residual }
	}
	let verification = await countResiduals()
	const verified = verification.residual.length === 0

	const completedAt = new Date()
	const clean = deletesOk && verified
	let finalizeAuditError: string | undefined

	if (clean) {
		// §3.4: completion is granted ONLY by finalizeErasure — the
		// authoritative in-finalize recount (stage 2, the sole completion
		// authority), the proof-of-erasure audit record, and the conditional
		// gate reopen coupled in ONE transaction. The audit document is
		// constructed INSIDE the callback so a retried finalize never
		// persists a duplicate audit, and it survives the memory_mutations
		// erase as the durable proof-of-erasure.
		let completeMutationId: string | undefined
		try {
			await finalizeErasure({
				db,
				prefix,
				token,
				writeAudit: async (session) => {
					for (const target of verifyTargets) {
						const count = await accessorFor(
							db,
							prefix,
							target.collection,
						).countDocuments(target.filter, { session })
						if (count > 0) {
							throw new Error(
								`finalize recount residual: ${count} document(s) remain in ${target.collection}`,
							)
						}
					}
					try {
						// C5/C6/C7 (settled): the erased agent's KB auto-refresh
						// marker (mongodb-manager-sync.ts §4.1) is removed with
						// completion — the ONLY meta write in this module,
						// exact-_id. B's marker and unrelated meta survive; the
						// gate doc's epoch/state transition belongs to
						// finalizeErasure's reopen (write-fence.ts), not to
						// this callback.
						await metaCollection(db, prefix).deleteOne(
							{ _id: `kb_last_auto_refresh:${agentId}` } as Record<
								string,
								unknown
							>,
							{ session },
						)
						const recorded = await recordMutation({
							db,
							prefix,
							session,
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
									status: "complete",
									runId: token.runId,
									epoch: token.epoch,
									collections: receipts.length,
									deletedTotal: receipts.reduce((sum, r) => sum + r.deleted, 0),
									failedCollections: [],
									residualCollections: [],
									completedAt,
								},
							},
						})
						completeMutationId = recorded.mutationId
					} catch (err) {
						throw new FinalizeAuditWriteError(err)
					}
				},
			})
			log.info("tenant erasure complete", {
				agentId,
				runId: token.runId,
				collections: receipts.length,
				epoch: token.epoch,
			})
			return {
				agentId,
				status: "complete",
				receipts,
				epoch: token.epoch,
				gateState: "open",
				runId: token.runId,
				verification,
				...(completeMutationId ? { mutationId: completeMutationId } : {}),
				...(recovered ? { recovery: "takeover" as const } : {}),
				completedAt,
			}
		} catch (err) {
			if (isErasureGateConflictError(err)) {
				// Finalize owner validation observed a successor: ownership
				// lost — terminal abort, gateState omitted.
				log.warn("tenant erasure finalize lost ownership", {
					agentId,
					runId: token.runId,
					error: err,
				})
				return {
					agentId,
					status: "partial",
					receipts,
					epoch: token.epoch,
					runId: token.runId,
					ownershipLost: true,
					verification,
					completedAt,
				}
			}
			if (isCommitAmbiguousError(err)) {
				// The commit may have landed: neither "open" nor "erasing" is
				// provable from this seat. Honest finalizeIndeterminate; NO
				// compensating reopen/reclose, NO token reacquisition — the
				// operator reads the true gate state and recovers
				// deliberately (§3.5).
				log.warn("tenant erasure finalize commit-ambiguous", {
					agentId,
					runId: token.runId,
					error: err,
				})
				return {
					agentId,
					status: "partial",
					receipts,
					epoch: token.epoch,
					runId: token.runId,
					finalizeIndeterminate: true,
					verification,
					completedAt,
				}
			}
			// Ordinary finalize failure (stage-2 residual, the audit write,
			// or the reopen itself): the transaction aborted cleanly (its
			// fence check passed — a conflict would have taken the
			// ownershipLost branch above) — the partial path below records
			// it, with the partial audit's acknowledgment as the receipt's
			// ownership evidence (C-1). A stage-2 residual means data
			// resurrected between the stages, so stage 1 is re-run to
			// surface it on the receipt; an audit-write failure is tagged
			// and reported as auditError.
			if (err instanceof FinalizeAuditWriteError) {
				finalizeAuditError = err.message
			} else {
				verification = await countResiduals()
			}
			log.warn("tenant erasure finalize failed; still-owned partial", {
				agentId,
				runId: token.runId,
				error: err,
			})
		}
	}

	// Still-owned partial (§3.5, C-1): batch failure, commit-ambiguous
	// batch, verification residual, retained parents, fail-closed target,
	// or a finalize failure that was neither ownership loss nor
	// commit-ambiguous. No finalize completed in this attempt.
	// gateState:"erasing" is claimed ONLY when the fenced partial audit
	// below ACKNOWLEDGED — that audit transaction's own fence check
	// re-validated ownership. Begin/takeover success and an unobserved
	// conflict are NOT ownership evidence (a successor may have completed;
	// C-1), so an audit that errors without confirming ownership
	// (auditError) omits gateState — no invented ownershipLost (no
	// conflict was observed), no finalizeIndeterminate (this path never
	// finalized).
	const partialAudit = await writeFencedPartialAudit({
		db,
		prefix,
		token,
		meta: {
			kind: "tenant-erasure",
			epoch: token.epoch,
			collections: receipts.length,
			deletedTotal: receipts.reduce((sum, r) => sum + r.deleted, 0),
			failedCollections: receipts
				.filter((r) => r.error !== undefined)
				.map((r) => r.collection),
			residualCollections: verification.residual.map((r) => r.collection),
			completedAt,
		},
	})
	log.warn("tenant erasure completed with failures", {
		agentId,
		runId: token.runId,
		failed: receipts
			.filter((r) => r.error !== undefined)
			.map((r) => r.collection),
		residual: verification.residual.map((r) => r.collection),
	})
	if (partialAudit.ownershipLost === true) {
		// Ownership was lost at the partial-audit fence check after all:
		// terminal abort, gateState omitted.
		return {
			agentId,
			status: "partial",
			receipts,
			epoch: token.epoch,
			runId: token.runId,
			ownershipLost: true,
			verification,
			completedAt,
		}
	}
	const auditError = partialAudit.auditError ?? finalizeAuditError
	return {
		agentId,
		status: "partial",
		receipts,
		epoch: token.epoch,
		// C-1: the discriminator is the partial audit's OWN outcome — NOT
		// the combined auditError, which may carry only the finalize
		// audit-write failure (finalizeAuditError) while this partial
		// audit acknowledged and re-validated ownership.
		...(partialAudit.auditError === undefined
			? { gateState: "erasing" as const }
			: {}),
		runId: token.runId,
		verification,
		...(recovered ? { recovery: "takeover" as const } : {}),
		...(partialAudit.mutationId ? { mutationId: partialAudit.mutationId } : {}),
		...(auditError ? { auditError } : {}),
		completedAt,
	}
}
