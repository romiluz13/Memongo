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
} from "./mongodb-structured-memory.js"
import { CONFIDENCE_BY_SOURCE } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:quarantine")

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100

function clampListLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIST_LIMIT
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit ?? 0)))
}

export type QuarantineStatus = "pending-review" | "promoted" | "rejected"

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
 * The claim-first protocol keeps the queue consistent: the row flips
 * pending-review → promoted atomically BEFORE the memory write, so two
 * concurrent reviews cannot double-write. If the memory write then fails,
 * the status is reverted to pending-review and the error surfaces — the
 * operator can retry.
 *
 * Extraction reuses the consolidator's matchPatterns: the quarantine row
 * stores raw candidate text, and promote applies the same deterministic
 * extraction the unblocked pipeline would have run. Content that matches no
 * pattern has no derivable memory shape; promote fails loudly instead of
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
	if (entry.status !== "pending-review") {
		throw new Error(
			`quarantine entry ${quarantineId} already reviewed (status=${entry.status})`,
		)
	}

	const content = typeof entry.content === "string" ? entry.content : ""
	const match = matchPatterns(content)
	if (!match) {
		throw new Error(
			`quarantine entry ${quarantineId} content matches no memory pattern; promote requires a derivable memory shape`,
		)
	}

	const decision = buildDecisionFields(params)
	const claim = await collection.updateOne(
		{ quarantineId, agentId, status: "pending-review" },
		{ $set: { ...decision, status: "promoted" as const } },
	)
	if (claim.matchedCount === 0) {
		throw new Error(
			`quarantine entry ${quarantineId} concurrently reviewed; no changes applied`,
		)
	}

	const memoryEntry: StructuredMemoryEntry = {
		type: match.type,
		key: match.key,
		value: match.value,
		agentId,
		source: "agent",
		confidence: CONFIDENCE_BY_SOURCE.agent_extracted,
		sourceAgent: { id: agentId, name: "quarantine-review" },
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
			// content (the row only reaches "promoted" through
			// decideQuarantine), so the tier-1 classifier verdict is
			// intentionally superseded — without this, every promotion
			// would loop straight back into quarantine.
			injectionClassification: "skip",
		})
	} catch (err) {
		// Compensating revert: the claim already flipped the row to promoted,
		// but no memory exists — put it back in the queue and surface the error.
		await collection.updateOne(
			{ quarantineId, agentId, status: "promoted" },
			{
				$set: {
					status: "pending-review",
				},
				$unset: { reviewedAt: "", reviewerId: "", reviewNotes: "" },
			},
		)
		throw err
	}

	const receipt: QuarantineReviewReceipt = {
		quarantineId,
		agentId,
		status: "promoted",
		reviewedAt: decision.reviewedAt,
		...(params.reviewerId ? { reviewerId: params.reviewerId } : {}),
		...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {}),
		memoryId: writeResult.id,
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
					status: "promoted",
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
	if (entry.status !== "pending-review") {
		throw new Error(
			`quarantine entry ${quarantineId} already reviewed (status=${entry.status})`,
		)
	}

	const decision = {
		...buildDecisionFields(params),
		status: "rejected" as const,
	}
	const result = await collection.updateOne(
		{ quarantineId, agentId, status: "pending-review" },
		{ $set: decision },
	)
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
