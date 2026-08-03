import { createHash } from "node:crypto"
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { chunksCollection, eventsCollection } from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"

const log = createSubsystemLogger("memory:mongodb:migration")

// ---------------------------------------------------------------------------
// Backfill v1 conversation chunks into canonical events
// ---------------------------------------------------------------------------

/**
 * Read the CALLER's existing conversation chunks (source: "conversation",
 * "memory" or "sessions") and create canonical events from them. Uses
 * deterministic eventIds derived from agentId + chunk path + hash for
 * idempotency. Safe to re-run.
 *
 * P2.7 tenant isolation:
 * - The source read is filtered by the caller's `agentId` (chunks are keyed
 *   by agentId/scope/scopeRef the same way events are), so a shared-prefix
 *   collection never copies another tenant's chunks into the caller's
 *   namespace. Chunks explicitly scoped outside "agent" (e.g. "workspace")
 *   are not converted into agent-scoped events; legacy chunks without a
 *   scope field still migrate.
 * - The read streams via a cursor in batches (no full `.toArray()`).
 * - `agentId` is part of the deterministic eventId hash input, so identical
 *   path+hash across tenants can no longer collide (first-writer-wins).
 *   NOTE: this changes the eventId derivation — re-running a migration
 *   written before this fix produces NEW eventIds. That is intended: the
 *   old ids were cross-tenant-unsafe.
 */
export async function backfillEventsFromChunks(params: {
	db: Db
	prefix: string
	agentId: string
	batchSize?: number
}): Promise<{
	eventsCreated: number
	chunksProcessed: number
	skipped: number
}> {
	const { db, prefix, agentId, batchSize = 500 } = params

	const chunks = chunksCollection(db, prefix)
	const events = eventsCollection(db, prefix)
	const scope = "agent"
	const scopeRef = resolveScopeRef({ scope, agentId })

	// P2.7: only ever read the caller's own chunks.
	const cursor = chunks
		.find({
			source: { $in: ["conversation", "memory", "sessions"] },
			agentId,
			$or: [{ scope: "agent" }, { scope: { $exists: false } }],
		})
		.batchSize(batchSize)

	type BulkOp = {
		updateOne: {
			filter: { eventId: string }
			update: { $setOnInsert: Record<string, unknown> }
			upsert: boolean
		}
	}

	let chunksProcessed = 0
	let skipped = 0
	let eventsCreated = 0
	let batchIndex = 0
	let batchChunks = 0
	let ops: BulkOp[] = []

	const flush = async (): Promise<void> => {
		if (ops.length === 0) {
			batchChunks = 0
			return
		}
		batchIndex++
		try {
			const result = await events.bulkWrite(ops)
			eventsCreated += result.upsertedCount
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(
				`bulkWrite failed on batch ${batchIndex} (${eventsCreated} events created so far, ${chunksProcessed} chunks processed): ${msg}`,
			)
			throw err
		}
		ops = []
		batchChunks = 0
	}

	for await (const chunk of cursor) {
		chunksProcessed++
		batchChunks++

		// Skip chunks without text
		const text = chunk.text as string | undefined
		if (!text) {
			skipped++
		} else {
			// Skip chunks with missing/null path or hash (invalid for deterministic eventId)
			const chunkPath = chunk.path as string | undefined | null
			const chunkHash = chunk.hash as string | undefined | null
			if (!chunkPath || !chunkHash) {
				log.warn(
					`skipping chunk with missing path or hash: path=${String(chunkPath)} hash=${String(chunkHash)}`,
				)
				skipped++
			} else {
				// Deterministic eventId from agentId + chunk path + hash for
				// idempotency — agentId is part of the input so the same
				// path+hash under two tenants yields two distinct eventIds.
				const eventId = createHash("sha256")
					.update(`${agentId}:${chunkPath}:${chunkHash}`)
					.digest("hex")
					.slice(0, 32)

				const timestamp = (chunk.updatedAt as Date) ?? new Date()

				ops.push({
					updateOne: {
						filter: { eventId },
						update: {
							$setOnInsert: {
								eventId,
								agentId,
								role: "user",
								body: text,
								scope,
								scopeRef,
								timestamp,
							},
						},
						upsert: true,
					},
				})
			}
		}

		if (batchChunks >= batchSize) {
			await flush()
		}
	}
	await flush()

	log.info(
		`backfill complete: chunksProcessed=${chunksProcessed} eventsCreated=${eventsCreated} skipped=${skipped}`,
	)
	return { eventsCreated, chunksProcessed, skipped }
}
