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
//     NOT touched — which is also where the per-agent erasure epoch lives
//     (mongodb-erasure-epoch.ts, W03 fence).
// The audit record is written AFTER the deletes so it survives the
// memory_mutations erase as the durable proof-of-erasure receipt.
// Receipt integrity: a failed epoch bump aborts the sweep (epochError, no
// deletes); a failed artifact sweep or unresolved artifact ownership
// retains the parents (partial); a failed collection delete, a post-sweep
// verification residual, or a failed audit write all force "partial" — the
// receipt never claims "complete" while known tenant data, unverified
// state, or the proof-of-erasure itself is missing.
import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { bumpTenantErasureEpoch } from "./mongodb-erasure-epoch.js"
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
	 * "complete" only when every collection delete succeeded, the post-sweep
	 * verification found no residual tenant documents, AND the
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
	/**
	 * W03: the erasure epoch this attempt fenced with. Every worker that
	 * claimed this tenant's work at a lower epoch abandons at its next
	 * fence check; work claimed at this epoch or later is legitimate
	 * post-erasure activity.
	 */
	epoch?: number
	/**
	 * W03: set when the epoch bump itself failed — NO deletes ran in that
	 * attempt. An unfenced erasure must never sweep.
	 */
	epochError?: string
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
 * W03 (fencing): the sweep is fenced by a durable per-agent epoch bumped
 * BEFORE any delete (workers abandon pre-erasure claims at their fence
 * checks), and verified AFTER the deletes with per-collection counts —
 * residual tenant documents force "partial" instead of a false complete.
 */
export async function deleteAllForAgent(params: {
	db: Db
	prefix: string
	agentId: string
}): Promise<TenantErasureReceipt> {
	const { db, prefix, agentId } = params

	// W03 fence: advance the durable per-agent epoch FIRST. Pre-erasure
	// claimed work becomes stale the moment this lands. A failed bump means
	// the sweep cannot be fenced — NO deletes run and the receipt says why.
	let epoch: number | undefined
	let epochError: string | undefined
	try {
		epoch = await bumpTenantErasureEpoch(db, prefix, agentId)
	} catch (err) {
		epochError = err instanceof Error ? err.message : String(err)
		log.warn("tenant erasure epoch bump failed; refusing to sweep unfenced", {
			agentId,
			error: err,
		})
		return {
			agentId,
			status: "partial",
			receipts: [],
			epochError,
			completedAt: new Date(),
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

	// Phase 1.5 (W02): sweep relevance_artifacts BEFORE the parallel sweep
	// can delete their parents. The agentId arm covers artifacts written
	// with their own tenant identity; the runId arm covers legacy rows
	// while their parents still exist. Runs even when phase 1 failed (the
	// agentId arm is independent of the run join).
	const artifactFilter: Document = {
		$or: [
			{ agentId },
			...(artifactRunIds.length > 0
				? [{ runId: { $in: artifactRunIds } }]
				: []),
		],
	}
	let artifactDeleteFailed = false
	let artifactReceipt: TenantErasureCollectionReceipt
	try {
		const result = await relevanceArtifactsCollection(db, prefix).deleteMany(
			artifactFilter,
		)
		artifactReceipt = {
			collection: "relevance_artifacts",
			deleted: result.deletedCount ?? 0,
		}
	} catch (err) {
		artifactDeleteFailed = true
		artifactReceipt = {
			collection: "relevance_artifacts",
			deleted: 0,
			error: err instanceof Error ? err.message : String(err),
		}
		log.warn("relevance artifact sweep failed; retaining parents", {
			agentId,
			error: err,
		})
	}

	// W02 retention rule: whenever artifact ownership was unresolved or the
	// artifact delete failed, relevance_runs stays OUT of this attempt's
	// sweep. The next attempt re-resolves the children from the retained
	// parents, sweeps them, and only then deletes the parents — the
	// retry-false-complete path is structurally gone.
	const retainRelevanceRuns = unresolvedOwnership || artifactDeleteFailed

	// Phase 2: every delete runs to completion; failures become receipts.
	const targets: Array<{ collection: string; filter: Document }> =
		agentKeyedCollections(agentId).filter(
			(target) =>
				!(retainRelevanceRuns && target.collection === "relevance_runs"),
		)

	const receipts: TenantErasureCollectionReceipt[] = [artifactReceipt]
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

	// W03 verification: re-count every swept target (and the artifact
	// filter) AFTER the deletes. Any residual tenant document — a
	// concurrent writer resurrecting data, or a delete that under-reported —
	// is listed on the receipt and forces "partial". The retained
	// relevance_runs parents are expected survivors this attempt and are
	// excluded from the residual check. Runs BEFORE the audit write so the
	// proof-of-erasure record (an agentId-keyed memory_mutations doc written
	// after this point) is not counted as residual.
	const verifyTargets: Array<{ collection: string; filter: Document }> = [
		{ collection: "relevance_artifacts", filter: artifactFilter },
		...targets,
	]
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
	const verification = {
		checked: verifyTargets.length,
		residual,
	}
	const verified = residual.length === 0

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
					status: deletesOk && verified ? "complete" : "partial",
					epoch,
					collections: receipts.length,
					deletedTotal: receipts.reduce((sum, r) => sum + r.deleted, 0),
					failedCollections: receipts
						.filter((r) => r.error !== undefined)
						.map((r) => r.collection),
					residualCollections: residual.map((r) => r.collection),
					completedAt,
				},
			},
		})
		mutationId = recorded.mutationId
	} catch (err) {
		auditError = err instanceof Error ? err.message : String(err)
		log.warn("tenant erasure audit record failed", { agentId, error: err })
	}

	// "complete" requires a fully successful, verified sweep AND the durable
	// proof-of-erasure audit record.
	const status: TenantErasureReceipt["status"] =
		deletesOk && verified && auditError === undefined ? "complete" : "partial"

	const receipt: TenantErasureReceipt = {
		agentId,
		status,
		receipts,
		epoch,
		verification,
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
			residual: residual.map((r) => r.collection),
		})
	} else {
		log.info("tenant erasure complete", {
			agentId,
			collections: receipts.length,
			epoch,
		})
	}
	return receipt
}
