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
 * Read existing conversation chunks (source: "memory" or "sessions") and create
 * canonical events from them. Uses deterministic eventIds derived from chunk
 * path + hash for idempotency. Safe to re-run.
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
	const { db, prefix, agentId, batchSize = 100 } = params

	const chunks = chunksCollection(db, prefix)
	const events = eventsCollection(db, prefix)
	const scope = "agent"
	const scopeRef = resolveScopeRef({ scope, agentId })

	// Read all conversation chunks
	const allChunks = await chunks
		.find({ source: { $in: ["conversation", "memory", "sessions"] } })
		.toArray()

	let chunksProcessed = 0
	let skipped = 0
	let eventsCreated = 0

	// Process in batches
	for (let i = 0; i < allChunks.length; i += batchSize) {
		const batch = allChunks.slice(i, i + batchSize)
		const ops: Array<{
			updateOne: {
				filter: { eventId: string }
				update: { $setOnInsert: Record<string, unknown> }
				upsert: boolean
			}
		}> = []

		for (const chunk of batch) {
			chunksProcessed++

			// Skip chunks without text
			const text = chunk.text as string | undefined
			if (!text) {
				skipped++
				continue
			}

			// Skip chunks with missing/null path or hash (invalid for deterministic eventId)
			const chunkPath = chunk.path as string | undefined | null
			const chunkHash = chunk.hash as string | undefined | null
			if (!chunkPath || !chunkHash) {
				log.warn(
					`skipping chunk with missing path or hash: path=${String(chunkPath)} hash=${String(chunkHash)}`,
				)
				skipped++
				continue
			}

			// Deterministic eventId from chunk path + hash for idempotency
			const eventId = createHash("sha256")
				.update(chunkPath + chunkHash)
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

		if (ops.length > 0) {
			const batchIndex = Math.floor(i / batchSize) + 1
			try {
				const result = await events.bulkWrite(ops)
				eventsCreated += result.upsertedCount
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log.warn(
					`bulkWrite failed on batch ${batchIndex} (${eventsCreated} events created so far, ${chunksProcessed}/${allChunks.length} chunks processed): ${msg}`,
				)
				throw err
			}
		}
	}

	log.info(
		`backfill complete: chunksProcessed=${chunksProcessed} eventsCreated=${eventsCreated} skipped=${skipped}`,
	)
	return { eventsCreated, chunksProcessed, skipped }
}
