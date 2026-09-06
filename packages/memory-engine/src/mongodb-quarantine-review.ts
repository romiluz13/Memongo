// C-004: quarantine review lifecycle. Injection-classified candidates land
// in memory_quarantine with status "pending-review" and, before this module,
// had no review path: no listing, no promote, no reject, no TTL — a
// classifier false positive was silent permanent data loss. This module adds
// the three review operations:
//   - listQuarantined: bounded, oldest-first listing for the review queue
//   - promoteQuarantined: overrule the classifier and write the candidate as
//     structured memory through the same matchPatterns extraction the
//     consolidator uses, with provenance pointing back at the quarantine row
//   - rejectQuarantined: discard the candidate, recording the decision
// Decision metadata (status, reviewedAt, reviewerId, reviewNotes) is
// persisted on the quarantine document and audited to memory_mutations —
// the audit row carries the same decision metadata so it is a self-contained
// record of who decided what and when. The audit write is best-effort (the
// decision itself is already durable on the row), but a failed audit is
// surfaced as receipt.auditError, never swallowed.
// Unreviewed entries additionally age out via the partial TTL index
// idx_memory_quarantine_ttl_pending (schema): 30-day default, so a review
// backlog can never accumulate forever. Reviewed rows (promoted/rejected)
// stay out of that index and persist as the audit trail.
import type { Db } from "mongodb"
import { randomUUID } from "node:crypto"
import { createSubsystemLogger, type MemoryScope } from "@memongo/lib"
import { matchPatterns } from "./mongodb-consolidator.js"
import { recordMutation } from "./mongodb-mutations.js"
import { memoryQuarantineCollection } from "./mongodb-schema.js"
import {
	writeStructuredMemory,
	type StructuredMemoryEntry,
	type StructuredMemoryType,
} from "./mongodb-structured-memory.js"
import { CONFIDENCE_BY_SOURCE, type MemorySourceAgent } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:quarantine")

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100

function clampListLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIST_LIMIT
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit ?? 0)))
}

export type QuarantineStatus =
	| "pending-review"
	| "promoting"
	| "promoted"
	| "rejected"

/**
 * W12: a promote claim holds the row in the intermediate "promoting" state
 * for at most this long. A process that dies between the claim and the
 * finalize leaves the row recoverable once the lease expires (re-promotion
 * is an identity-keyed upsert, so it is idempotent); the TTL backstop
 * sweeps rows nobody recovers.
 */
const PROMOTE_LEASE_MS = 120_000

/** True when a promoting row's claim lease has lapsed (or was never set). */
function promoteLeaseExpired(entry: unknown): boolean {
	const expires = (entry as { promoteLeaseExpiresAt?: unknown })
		.promoteLeaseExpiresAt
	return !(expires instanceof Date) || expires.getTime() <= Date.now()
}

/** One memory_quarantine row as surfaced to a reviewer. */
export type QuarantinedEntry = {
	quarantineId: string
	agentId: string
	scope?: string
	scopeRef?: string
	content: string
	classification: string
	tier?: "pattern" | "llm"
	matchedPatterns: string[]
	status: QuarantineStatus
	createdAt: Date
	reviewedAt?: Date
	reviewerId?: string
	reviewNotes?: string
	sourceEventIds?: string[]
}

/** Receipt for a promote/reject decision. */
export type QuarantineReviewReceipt = {
	quarantineId: string
	agentId: string
	status: "promoted" | "rejected"
	reviewedAt: Date
	reviewerId?: string
	reviewNotes?: string
	/** structured_mem document id; promote only. */
	memoryId?: string
	/** Audit record id in memory_mutations. */
	mutationId?: string
	/**
	 * W12: the structured memory was written but the quarantine row could
	 * not be finalized to "promoted" (its claim lease keeps it recoverable —
	 * a re-promotion finalizes it idempotently). The decision is durable in
	 * memory_mutations; this field surfaces the row-state gap.
	 */
	finalizeError?: string
	/**
	 * Audit write failed. The decision itself is durable on the quarantine
	 * row (status + metadata persisted before the audit attempt), but no
	 * memory_mutations record exists for it; `mutationId` is then absent.
	 * Surfaced rather than swallowed so callers can flag the audit gap.
	 */
	auditError?: string
}

/**
 * List quarantined entries for one agent, oldest first (FIFO review queue).
 * `status` filters the lifecycle stage; unset lists every stage so the
 * console can show decided history alongside the pending queue.
 */
export async function listQuarantined(params: {
	db: Db
	prefix: string
	agentId: string
	status?: QuarantineStatus
	limit?: number
}): Promise<QuarantinedEntry[]> {
	const { db, prefix, agentId, status } = params
	const limit = clampListLimit(params.limit)
	const docs = await memoryQuarantineCollection(db, prefix)
		.find({
			agentId,
			...(status ? { status } : {}),
		})
		.sort({ createdAt: 1 })
		.limit(limit)
		.toArray()
	return docs as unknown as QuarantinedEntry[]
}

type ReviewMetadata = {
	reviewerId?: string
	reviewNotes?: string
}

type DecisionFields = {
	reviewedAt: Date
	reviewerId?: string
	reviewNotes?: string
}

function buildDecisionFields(metadata: ReviewMetadata): DecisionFields {
	const now = new Date()
	return {
		reviewedAt: now,
		...(metadata.reviewerId ? { reviewerId: metadata.reviewerId } : {}),
		...(metadata.reviewNotes ? { reviewNotes: metadata.reviewNotes } : {}),
	}
}

/**
 * Promote a quarantined candidate: overrule the injection classifier and
 * write the candidate's content as structured memory.
 *
 * W12 claim protocol (leased intermediate state): the row flips
 * pending-review -> "promoting" (a LEASED claim, not a terminal decision)
 * BEFORE the memory write, so two concurrent reviews cannot double-write.
 * The memory write then finalizes promoting -> promoted. If the process
 * dies between claim and finalize, the row stays "promoting" with an
 * expired lease — recoverable by a re-promotion (writeStructuredMemory is
 * an identity-keyed upsert, so re-running it is idempotent). A thrown
 * write error reverts the claim to pending-review as before.
 *
 * Candidate identity: a structured write that was routed to quarantine
 * persists its FULL original entry as `structuredCandidate` at ingress
 * (mongodb-structured-memory.ts); promotion rebuilds that exact entry —
 * original type/key/value preserved verbatim. Rows without a stored
 * candidate (consolidator-sourced conversation text) keep the
 * deterministic matchPatterns extraction; content that matches no pattern
 * has no derivable memory shape and promote fails loudly instead of
 * inventing one.
 */
export async function promoteQuarantined(params: {
	db: Db
	prefix: string
	agentId: string
	quarantineId: string
	embeddingMode: import("@memongo/lib").MemoryMongoDBEmbeddingMode
	reviewerId?: string
	reviewNotes?: string
}): Promise<QuarantineReviewReceipt> {
	const { db, prefix, agentId, quarantineId, embeddingMode } = params
	const collection = memoryQuarantineCollection(db, prefix)

	const entry = await collection.findOne({ quarantineId, agentId })
	if (!entry) {
		throw new Error(`quarantine entry not found: ${quarantineId}`)
	}
	if (entry.status === "promoted" || entry.status === "rejected") {
		throw new Error(
			`quarantine entry ${quarantineId} already reviewed (status=${entry.status})`,
		)
	}
	if (entry.status === "promoting" && !promoteLeaseExpired(entry)) {
		throw new Error(
			`quarantine entry ${quarantineId} promotion already in progress (claim lease active)`,
		)
	}
	const recovering = entry.status === "promoting"

	const content = typeof entry.content === "string" ? entry.content : ""
	// W12: exact roundtrip for structured-write-sourced rows; matchPatterns
	// only for rows with no stored candidate shape.
	const storedCandidate =
		entry.structuredCandidate && typeof entry.structuredCandidate === "object"
			? (entry.structuredCandidate as Record<string, unknown>)
			: null
	const candidateType =
		typeof storedCandidate?.type === "string" ? storedCandidate.type : undefined
	const candidateKey =
		typeof storedCandidate?.key === "string" ? storedCandidate.key : undefined
	const candidateValue =
		typeof storedCandidate?.value === "string"
			? storedCandidate.value
			: undefined
	const candidateUsable =
		candidateType !== undefined &&
		candidateKey !== undefined &&
		candidateValue !== undefined
	let match: { type: StructuredMemoryType; key: string; value: string } | null
	if (candidateUsable) {
		// The candidate's type was a validated StructuredMemoryType at ingress
		// (it came from a StructuredMemoryEntry); the doc read-back only
		// proves string-ness, hence the narrow cast.
		match = {
			type: candidateType as StructuredMemoryType,
			key: candidateKey,
			value: candidateValue,
		}
	} else {
		match = matchPatterns(content)
	}
	if (!match) {
		throw new Error(
			`quarantine entry ${quarantineId} content matches no memory pattern; promote requires a derivable memory shape`,
		)
	}

	const decision = buildDecisionFields(params)
	const now = new Date()
	// Claim (or, when recovering an expired lease, re-claim) the row in the
	// leased intermediate state. The CAS filter keeps concurrent reviews and
	// live-lease re-promotions from double-claiming.
	const claimFilter = recovering
		? {
				quarantineId,
				agentId,
				status: "promoting" as const,
				$or: [
					{ promoteLeaseExpiresAt: { $lt: now } },
					{ promoteLeaseExpiresAt: { $exists: false } },
				],
			}
		: { quarantineId, agentId, status: "pending-review" as const }
	const claim = await collection.updateOne(claimFilter, {
		$set: {
			...decision,
			status: "promoting" as const,
			promoteClaimedAt: now,
			promoteLeaseExpiresAt: new Date(now.getTime() + PROMOTE_LEASE_MS),
		},
	})
	if (claim.matchedCount === 0) {
		throw new Error(
			`quarantine entry ${quarantineId} concurrently reviewed; no changes applied`,
		)
	}

	const memoryEntry: StructuredMemoryEntry = {
		// W12: rebuild the persisted candidate verbatim (shape fields only —
		// tenant identity and provenance are always re-derived here). The
		// original confidence (if stored) is applied in the explicit
		// `confidence` field below; a stored sourceAgent wins over the
		// review default so the roundtrip preserves who originally produced
		// the memory.
		...(candidateUsable && storedCandidate
			? {
					...(Array.isArray(storedCandidate.tags)
						? { tags: storedCandidate.tags as string[] }
						: {}),
					...(typeof storedCandidate.context === "string"
						? { context: storedCandidate.context }
						: {}),
				}
			: {}),
		type: match.type,
		key: match.key,
		value: match.value,
		agentId,
		source: "agent",
		confidence:
			candidateUsable && storedCandidate
				? typeof storedCandidate.confidence === "number"
					? storedCandidate.confidence
					: CONFIDENCE_BY_SOURCE.agent_extracted
				: CONFIDENCE_BY_SOURCE.agent_extracted,
		sourceAgent:
			candidateUsable && storedCandidate?.sourceAgent
				? (storedCandidate.sourceAgent as MemorySourceAgent)
				: { id: agentId, name: "quarantine-review" },
		sourceEventIds: Array.isArray(entry.sourceEventIds)
			? (entry.sourceEventIds as string[])
			: undefined,
		...(entry.scope ? { scope: entry.scope as MemoryScope } : {}),
		...(entry.scopeRef ? { scopeRef: entry.scopeRef as string } : {}),
		provenance: {
			quarantineId,
			originalClassification: entry.classification,
			matchedPatterns: entry.matchedPatterns,
			promotedByReview: true,
			...(candidateUsable ? { restoredCandidate: true } : {}),
		},
	}

	let writeResult: { upserted: boolean; id: string }
	try {
		writeResult = await writeStructuredMemory({
			db,
			prefix,
			entry: memoryEntry,
			embeddingMode,
			// C-008: the review IS the overrule. This write re-enters the
			// write-structured path AFTER a human reviewed the flagged
			// content (the row only reaches "promoting" through
			// decideQuarantine), so the tier-1 classifier verdict is
			// intentionally superseded — without this, every promotion
			// would loop straight back into quarantine.
			injectionClassification: "skip",
		})
	} catch (err) {
		// Compensating revert: the claim holds the row in "promoting", but no
		// memory exists — put it back in the queue and surface the error.
		// (A process that dies HERE leaves the leased claim, which the
		// expired-lease recovery above handles — W12.)
		await collection.updateOne(
			{ quarantineId, agentId, status: "promoting" },
			{
				$set: {
					status: "pending-review",
				},
				$unset: {
					reviewedAt: "",
					reviewerId: "",
					reviewNotes: "",
					promoteClaimedAt: "",
					promoteLeaseExpiresAt: "",
				},
			},
		)
		throw err
	}

	// Finalize: promoting -> promoted, with the written memory id on the
	// row. A failure here must NOT revert (the memory exists); the leased
	// claim keeps the row recoverable and the receipt surfaces the gap.
	let finalizeError: string | undefined
	try {
		const finalized = await collection.updateOne(
			{ quarantineId, agentId, status: "promoting" },
			{
				$set: {
					...decision,
					status: "promoted" as const,
					memoryId: writeResult.id,
				},
			},
		)
		if (finalized.matchedCount === 0) {
			finalizeError =
				"quarantine row left in promoting: row changed state during promotion"
		}
	} catch (err) {
		finalizeError = err instanceof Error ? err.message : String(err)
		log.warn(
			`promote finalize failed for quarantine=${quarantineId} (row left recoverable in promoting): ${finalizeError}`,
		)
	}

	const receipt: QuarantineReviewReceipt = {
		quarantineId,
		agentId,
		status: "promoted",
		reviewedAt: decision.reviewedAt,
		...(params.reviewerId ? { reviewerId: params.reviewerId } : {}),
		...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {}),
		memoryId: writeResult.id,
		...(finalizeError ? { finalizeError } : {}),
	}

	try {
		const { mutationId } = await recordMutation({
			db,
			prefix,
			mutation: {
				collectionName: "memory_quarantine",
				documentId: quarantineId,
				operation: "update",
				agentId,
				oldValue: null,
				newValue: {
					status: finalizeError ? "promoting (finalize pending)" : "promoted",
					memoryId: writeResult.id,
					type: match.type,
					key: match.key,
				},
				changedFields: ["status", "reviewedAt"],
				severity: "warning",
				meta: {
					decision: "promoted",
					quarantineId,
					originalClassification: entry.classification,
					matchedPatterns: entry.matchedPatterns,
					...(candidateUsable ? { restoredCandidate: true } : {}),
					...(finalizeError ? { finalizeError } : {}),
					...(params.reviewerId ? { reviewerId: params.reviewerId } : {}),
					...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {}),
					reviewedAt: decision.reviewedAt,
				},
			},
		})
		receipt.mutationId = mutationId
	} catch (err) {
		// The decision is durable on the row; the ledger copy failed. Surface
		// the gap on the receipt instead of swallowing it.
		receipt.auditError = err instanceof Error ? err.message : String(err)
		log.warn(
			`promote audit record failed for quarantine=${quarantineId}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	return receipt
}

/**
 * Reject a quarantined candidate: mark it rejected with decision metadata.
 * The row is kept (not deleted) so the decision survives as audit trail;
 * only pending-review rows age out via the TTL index.
 */
export async function rejectQuarantined(params: {
	db: Db
	prefix: string
	agentId: string
	quarantineId: string
	reviewerId?: string
	reviewNotes?: string
}): Promise<QuarantineReviewReceipt> {
	const { db, prefix, agentId, quarantineId } = params
	const collection = memoryQuarantineCollection(db, prefix)

	const entry = await collection.findOne({ quarantineId, agentId })
	if (!entry) {
		throw new Error(`quarantine entry not found: ${quarantineId}`)
	}
	if (entry.status === "promoted" || entry.status === "rejected") {
		throw new Error(
			`quarantine entry ${quarantineId} already reviewed (status=${entry.status})`,
		)
	}
	// W12: a promote claim with a live lease owns the row; an expired one
	// (crashed promoter) is recoverable — rejection is a valid resolution.
	if (entry.status === "promoting" && !promoteLeaseExpired(entry)) {
		throw new Error(
			`quarantine entry ${quarantineId} promotion already in progress (claim lease active)`,
		)
	}
	const recoveringPromotion = entry.status === "promoting"

	const decision = {
		...buildDecisionFields(params),
		status: "rejected" as const,
	}
	const rejectFilter = recoveringPromotion
		? {
				quarantineId,
				agentId,
				status: "promoting" as const,
				$or: [
					{ promoteLeaseExpiresAt: { $lt: new Date() } },
					{ promoteLeaseExpiresAt: { $exists: false } },
				],
			}
		: { quarantineId, agentId, status: "pending-review" as const }
	const result = await collection.updateOne(rejectFilter, {
		$set: decision,
		...(recoveringPromotion
			? {
					$unset: {
						promoteClaimedAt: "",
						promoteLeaseExpiresAt: "",
					},
				}
			: {}),
	})
	if (result.matchedCount === 0) {
		throw new Error(
			`quarantine entry ${quarantineId} concurrently reviewed; no changes applied`,
		)
	}

	const receipt: QuarantineReviewReceipt = {
		quarantineId,
		agentId,
		status: "rejected",
		reviewedAt: decision.reviewedAt,
		...(params.reviewerId ? { reviewerId: params.reviewerId } : {}),
		...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {}),
	}

	try {
		const { mutationId } = await recordMutation({
			db,
			prefix,
			mutation: {
				collectionName: "memory_quarantine",
				documentId: quarantineId,
				operation: "update",
				agentId,
				oldValue: null,
				newValue: { status: "rejected" },
				changedFields: ["status", "reviewedAt"],
				severity: "warning",
				meta: {
					decision: "rejected",
					quarantineId,
					originalClassification: entry.classification,
					...(recoveringPromotion
						? {
								recoveredFromPromoting: true,
								note: "a promotion claim was in flight; a partially completed promotion may have written structured memory with provenance pointing at this quarantineId — inspect before relying on this rejection",
							}
						: {}),
					...(params.reviewerId ? { reviewerId: params.reviewerId } : {}),
					...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {}),
					reviewedAt: decision.reviewedAt,
				},
			},
		})
		receipt.mutationId = mutationId
	} catch (err) {
		// The decision is durable on the row; the ledger copy failed. Surface
		// the gap on the receipt instead of swallowing it.
		receipt.auditError = err instanceof Error ? err.message : String(err)
		log.warn(
			`reject audit record failed for quarantine=${quarantineId}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	return receipt
}

/**
 * Insert a quarantined candidate directly (test/admin seam; the consolidator
 * writes its own rows). Exposed so the review lifecycle can be exercised
 * end-to-end without invoking the classifier.
 */
export async function insertQuarantinedForReview(params: {
	db: Db
	prefix: string
	agentId: string
	content: string
	scope?: string
	scopeRef?: string
	classification?: string
	matchedPatterns?: string[]
	sourceEventIds?: string[]
	createdAt?: Date
}): Promise<{ quarantineId: string }> {
	const quarantineId = randomUUID()
	await memoryQuarantineCollection(params.db, params.prefix).insertOne({
		quarantineId,
		agentId: params.agentId,
		...(params.scope ? { scope: params.scope } : {}),
		...(params.scopeRef ? { scopeRef: params.scopeRef } : {}),
		content: params.content,
		classification: params.classification ?? "injection-likely",
		tier: "pattern",
		matchedPatterns: params.matchedPatterns ?? [],
		status: "pending-review",
		createdAt: params.createdAt ?? new Date(),
		...(params.sourceEventIds ? { sourceEventIds: params.sourceEventIds } : {}),
	})
	return { quarantineId }
}
