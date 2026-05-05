import { randomUUID } from "node:crypto"
import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import type { MemoryActorRole } from "./types.js"
import { mutationsCollection } from "./mongodb-schema.js"

const log = createSubsystemLogger("memory:mongodb:mutations")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MutationOperation = "create" | "update" | "delete" | "invalidate"
export type MutationMeta = Record<string, unknown>

export type MutationRecord = {
	mutationId: string
	collectionName: string
	documentId: string
	operation: MutationOperation
	agentId: string
	oldValue: Document | null
	newValue: Document | null
	changedFields?: string[]
	timestamp: Date
	actorRole?: MemoryActorRole
	meta?: MutationMeta
}

// ---------------------------------------------------------------------------
// Record mutation (fire-and-forget safe)
// ---------------------------------------------------------------------------

/**
 * Insert an audit record into the memory_mutations collection.
 * Fire-and-forget safe: callers can use Promise.allSettled to avoid blocking.
 */
export async function recordMutation(params: {
	db: Db
	prefix: string
	mutation: Omit<MutationRecord, "mutationId" | "timestamp">
}): Promise<{ mutationId: string }> {
	const { db, prefix, mutation } = params
	const mutationId = randomUUID()
	const doc: MutationRecord = {
		mutationId,
		collectionName: mutation.collectionName,
		documentId: mutation.documentId,
		operation: mutation.operation,
		agentId: mutation.agentId,
		oldValue: mutation.oldValue,
		newValue: mutation.newValue,
		timestamp: new Date(),
		...(mutation.changedFields
			? { changedFields: mutation.changedFields }
			: {}),
		...(mutation.actorRole ? { actorRole: mutation.actorRole } : {}),
		...(mutation.meta ? { meta: mutation.meta } : {}),
	}
	try {
		await mutationsCollection(db, prefix).insertOne(doc)
		return { mutationId }
	} catch (err) {
		log.warn("recordMutation failed", { mutationId, error: err })
		throw err
	}
}

// ---------------------------------------------------------------------------
// Query mutation history
// ---------------------------------------------------------------------------

/**
 * Query mutation audit records with filters.
 * Returns records sorted by timestamp descending (newest first).
 */
export async function getMutationHistory(params: {
	db: Db
	prefix: string
	agentId: string
	collectionName?: string
	documentId?: string
	limit?: number
	since?: Date
}): Promise<MutationRecord[]> {
	const {
		db,
		prefix,
		agentId,
		collectionName,
		documentId,
		limit = 50,
		since,
	} = params
	try {
		const filter: Record<string, unknown> = { agentId }
		if (collectionName) {
			filter.collectionName = collectionName
		}
		if (documentId) {
			filter.documentId = documentId
		}
		if (since) {
			filter.timestamp = { $gte: since }
		}
		const docs = await mutationsCollection(db, prefix)
			.find(filter)
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ timestamp: -1 })
			.limit(limit)
			.toArray()
		return docs as unknown as MutationRecord[]
	} catch (err) {
		log.error("getMutationHistory failed", { agentId, error: err })
		throw err
	}
}
