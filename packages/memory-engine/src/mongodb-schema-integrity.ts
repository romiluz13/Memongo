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

// ---------------------------------------------------------------------------
// Referential integrity beyond KB (C-024 / WS-14)
// ---------------------------------------------------------------------------

/**
 * C-024: relations whose fromEntityId or toEntityId no longer matches an
 * entity document. This is the graph analog of orphaned kb_chunks — a
 * crash between entity deletion and relation deletion (the deleteEntity
 * cascade covers the normal path) leaves edges pointing at nothing.
 *
 * A relation with BOTH endpoints missing counts as one orphaned relation,
 * not two. Read-only detection: it never auto-deletes.
 */
export async function checkRelationEntityOrphans(
	relCol: Collection,
	entCol: Collection,
	agentId?: string,
): Promise<{ orphanedRelationCount: number; orphanedEntityIds: string[] }> {
	const scopeFilter = agentId ? { agentId } : {}

	// Step 1: every entity id referenced from either endpoint of any relation.
	const endpointRefs = await relCol
		.aggregate([
			{ $match: scopeFilter },
			{ $project: { endpoints: ["$fromEntityId", "$toEntityId"] } },
			{ $unwind: "$endpoints" },
			{ $group: { _id: "$endpoints" } },
		])
		.toArray()
	if (endpointRefs.length === 0) {
		return { orphanedRelationCount: 0, orphanedEntityIds: [] }
	}
	const referenced = endpointRefs.map((d) => String(d._id))

	// Step 2: which referenced entities actually exist?
	const existing = await entCol
		.find(
			{ entityId: { $in: referenced }, ...scopeFilter },
			{ projection: { entityId: 1 } },
		)
		.toArray()
	const existingIds = new Set(existing.map((d) => String(d.entityId)))
	const missing = referenced.filter((id) => !existingIds.has(id))
	if (missing.length === 0) {
		return { orphanedRelationCount: 0, orphanedEntityIds: [] }
	}

	// Step 3: exact relation-level count — re-query so a relation with both
	// endpoints missing is counted once.
	const orphanedRelationCount = await relCol.countDocuments({
		...scopeFilter,
		$or: [{ fromEntityId: { $in: missing } }, { toEntityId: { $in: missing } }],
	})

	if (orphanedRelationCount > 0) {
		log.warn(
			`relation integrity: found ${orphanedRelationCount} relation(s) referencing missing entities. ` +
				`Missing entityIds: ${missing.join(", ")}. ` +
				`These edges point at entities that no longer exist. ` +
				`Consider manual cleanup or deleteEntity re-runs.`,
		)
	}

	return { orphanedRelationCount, orphanedEntityIds: missing }
}

/**
 * C-024: entity_links whose fromEntityId or toEntityId no longer matches an
 * entity document. Same orphan class as relations, on the canonicalized
 * from/to pair collection; deleteEntity's entity_links cascade (C-024)
 * covers the normal path, this detects the crash-between-writes residue.
 * Read-only detection: it never auto-deletes.
 */
export async function checkEntityLinkOrphans(
	linkCol: Collection,
	entCol: Collection,
	agentId?: string,
): Promise<{ orphanedLinkCount: number; orphanedEntityIds: string[] }> {
	const scopeFilter = agentId ? { agentId } : {}

	// Step 1: every entity id referenced from either side of any link.
	const endpointRefs = await linkCol
		.aggregate([
			{ $match: scopeFilter },
			{ $project: { endpoints: ["$fromEntityId", "$toEntityId"] } },
			{ $unwind: "$endpoints" },
			{ $group: { _id: "$endpoints" } },
		])
		.toArray()
	if (endpointRefs.length === 0) {
		return { orphanedLinkCount: 0, orphanedEntityIds: [] }
	}
	const referenced = endpointRefs.map((d) => String(d._id))

	// Step 2: which referenced entities actually exist?
	const existing = await entCol
		.find(
			{ entityId: { $in: referenced }, ...scopeFilter },
			{ projection: { entityId: 1 } },
		)
		.toArray()
	const existingIds = new Set(existing.map((d) => String(d.entityId)))
	const missing = referenced.filter((id) => !existingIds.has(id))
	if (missing.length === 0) {
		return { orphanedLinkCount: 0, orphanedEntityIds: [] }
	}

	// Step 3: exact link-level count — a link with both endpoints missing
	// counts once.
	const orphanedLinkCount = await linkCol.countDocuments({
		...scopeFilter,
		$or: [{ fromEntityId: { $in: missing } }, { toEntityId: { $in: missing } }],
	})

	if (orphanedLinkCount > 0) {
		log.warn(
			`entity_link integrity: found ${orphanedLinkCount} link(s) referencing missing entities. ` +
				`Missing entityIds: ${missing.join(", ")}. ` +
				`Consider manual cleanup or deleteEntity re-runs.`,
		)
	}

	return { orphanedLinkCount, orphanedEntityIds: missing }
}

/**
 * C-024: conversation chunks whose source event no longer exists. Chunks
 * reference their event as the path suffix (`events/{eventId}`) — there is
 * no direct eventId field on the chunk document — so only `events/`-prefixed
 * paths participate. Read-only detection: it never auto-deletes.
 */
export async function checkChunkEventOrphans(
	chunksCol: Collection,
	eventsCol: Collection,
	agentId?: string,
): Promise<{ orphanedChunkCount: number; orphanedEventIds: string[] }> {
	const scopeFilter = agentId ? { agentId } : {}

	// Step 1: event ids referenced by conversation chunks, via the path.
	const chunkDocs = await chunksCol
		.find({ path: /^events\//, ...scopeFilter }, { projection: { path: 1 } })
		.toArray()
	if (chunkDocs.length === 0) {
		return { orphanedChunkCount: 0, orphanedEventIds: [] }
	}
	const chunkEventIds = chunkDocs
		.map((d) => String(d.path ?? "").slice("events/".length))
		.filter((id) => id.length > 0)
	if (chunkEventIds.length === 0) {
		return { orphanedChunkCount: 0, orphanedEventIds: [] }
	}

	// Step 2: which referenced events actually exist? (Dedupe first —
	// re-projections can share an event id, and $in needs each id once.)
	const referencedEventIds = [...new Set(chunkEventIds)]
	const existing = await eventsCol
		.find(
			{ eventId: { $in: referencedEventIds }, ...scopeFilter },
			{ projection: { eventId: 1 } },
		)
		.toArray()
	const existingIds = new Set(existing.map((d) => String(d.eventId)))

	// Step 3: count orphaned CHUNKS (re-projections can share an event id)
	// and collect the distinct missing event ids.
	const orphanedEventIdSet = new Set(
		chunkEventIds.filter((id) => !existingIds.has(id)),
	)
	const orphanedChunkCount = chunkEventIds.filter((id) =>
		orphanedEventIdSet.has(id),
	).length

	if (orphanedChunkCount > 0) {
		log.warn(
			`chunk integrity: found ${orphanedChunkCount} chunk(s) referencing missing events. ` +
				`Missing eventIds: ${[...orphanedEventIdSet].join(", ")}. ` +
				`These chunks project events that no longer exist. ` +
				`Consider manual cleanup.`,
		)
	}

	return {
		orphanedChunkCount,
		orphanedEventIds: [...orphanedEventIdSet],
	}
}

/**
 * C-024: episodes whose sourceEventIds reference events that no longer
 * exist. Episodes without a sourceEventIds array (legacy or
 * non-consolidation rows) have nothing to check and are skipped.
 * Read-only detection: it never auto-deletes.
 */
export async function checkEpisodeEventOrphans(
	episodesCol: Collection,
	eventsCol: Collection,
	agentId?: string,
): Promise<{ orphanedEpisodeCount: number; orphanedEventIds: string[] }> {
	const scopeFilter = agentId ? { agentId } : {}

	// Step 1: per-episode source-event references.
	const episodeDocs = await episodesCol
		.find(
			{ sourceEventIds: { $exists: true }, ...scopeFilter },
			{ projection: { sourceEventIds: 1 } },
		)
		.toArray()
	const perEpisodeIds: string[][] = episodeDocs
		.map((d) =>
			Array.isArray(d.sourceEventIds)
				? d.sourceEventIds.map((id) => String(id))
				: [],
		)
		.filter((ids) => ids.length > 0)
	const referenced = [...new Set(perEpisodeIds.flat())]
	if (referenced.length === 0) {
		return { orphanedEpisodeCount: 0, orphanedEventIds: [] }
	}

	// Step 2: which referenced events actually exist?
	const existing = await eventsCol
		.find(
			{ eventId: { $in: referenced }, ...scopeFilter },
			{ projection: { eventId: 1 } },
		)
		.toArray()
	const existingIds = new Set(existing.map((d) => String(d.eventId)))

	// Step 3: episodes with at least one missing source event are orphaned;
	// collect the distinct missing event ids.
	const missing = new Set(referenced.filter((id) => !existingIds.has(id)))
	const orphanedEpisodeCount = perEpisodeIds.filter((ids) =>
		ids.some((id) => missing.has(id)),
	).length

	if (orphanedEpisodeCount > 0) {
		log.warn(
			`episode integrity: found ${orphanedEpisodeCount} episode(s) referencing missing events. ` +
				`Missing eventIds: ${[...missing].join(", ")}. ` +
				`These episodes consolidate events that no longer exist. ` +
				`Consider manual cleanup.`,
		)
	}

	return { orphanedEpisodeCount, orphanedEventIds: [...missing] }
}
