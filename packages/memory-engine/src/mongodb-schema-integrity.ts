// Startup integrity checks (P4.3 split from mongodb-schema.ts).
import type { Collection } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

// ---------------------------------------------------------------------------
// KB orphan detection (startup integrity check)
// ---------------------------------------------------------------------------

/**
 * Check for orphaned kb_chunks — chunks whose docId references a knowledge_base
 * document that no longer exists. This can happen if a crash occurs between
 * chunk deletion and document deletion (or vice versa) without a transaction.
 *
 * Returns the list of orphaned docIds and total orphaned chunk count.
 * Does NOT auto-delete — the user decides.
 */
export async function checkKBOrphans(
	kbChunksCol: Collection,
	kbCol: Collection,
): Promise<{ orphanedChunkCount: number; orphanedDocIds: string[] }> {
	// Step 1: Get all distinct docIds + their chunk counts from kb_chunks
	const chunksByDoc = await kbChunksCol
		.aggregate([{ $group: { _id: "$docId", count: { $sum: 1 } } }])
		.toArray()

	if (chunksByDoc.length === 0) {
		return { orphanedChunkCount: 0, orphanedDocIds: [] }
	}

	// Step 2: Get all existing KB document IDs
	const allDocIds = chunksByDoc.map((d) => d._id)
	const existingDocs = await kbCol
		.find({ _id: { $in: allDocIds } })
		.project({ _id: 1 })
		.toArray()
	const existingIds = new Set(existingDocs.map((d) => String(d._id)))

	// Step 3: Find orphans (docId in chunks that doesn't exist in knowledge_base)
	const orphanedDocIds: string[] = []
	let orphanedChunkCount = 0
	for (const entry of chunksByDoc) {
		const docId = String(entry._id)
		if (!existingIds.has(docId)) {
			orphanedDocIds.push(docId)
			orphanedChunkCount += entry.count as number
		}
	}

	if (orphanedChunkCount > 0) {
		log.warn(
			`KB integrity: found ${orphanedChunkCount} orphaned kb_chunks across ${orphanedDocIds.length} missing document(s). ` +
				`Orphaned docIds: ${orphanedDocIds.join(", ")}. ` +
				`These chunks reference knowledge_base documents that no longer exist. ` +
				`Consider manual cleanup.`,
		)
	}

	return { orphanedChunkCount, orphanedDocIds }
}
