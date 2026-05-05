/**
 * Reasoning Chain Traversal — trace any derived fact back through its
 * reasoning chain using `$graphLookup` for multi-hop traversal.
 *
 * structured_mem records can reference other structured_mem records via
 * `sourceEventIds`. `$graphLookup` traverses these links recursively up to
 * `maxDepth` hops, building a full premise tree. Leaf events (which do NOT
 * have sourceEventIds) are fetched in a second `$lookup` pass.
 *
 * Also supports reverse traversal: find all conclusions that depend on a
 * given fact (downstream dependents).
 *
 * @module mongodb-reasoning-chain
 */

import type { Db, Document } from "mongodb"
import type {
	ReasoningChain,
	ReasoningChainNode,
	ReasoningChainOptions,
} from "./types.js"

export type { ReasoningChain, ReasoningChainNode, ReasoningChainOptions }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known source collections that carry `sourceEventIds`.
 * Maps collection short name to its primary id field.
 */
const COLLECTION_ID_FIELDS: Record<string, string> = {
	structured_mem: "key",
	entities: "entityId",
	relations: "fromEntityId",
	procedures: "procedureId",
	entity_links: "linkId",
}

const DEFAULT_MAX_DEPTH = 3

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trace a reasoning chain from a derived fact back through its premises
 * using `$graphLookup` for multi-hop traversal.
 *
 * The chain includes:
 * - Structured memory premises (intermediate facts linked via sourceEventIds)
 *   with `hopDistance` indicating depth from the starting fact
 * - Leaf events (original conversation events) fetched via $lookup
 * - Gap nodes for unresolved sourceEventIds
 *
 * Nodes are ordered by depth ascending then timestamp ascending.
 */
export async function traceReasoningChain(params: {
	db: Db
	prefix: string
	agentId: string
	factId: string
	collection: string
	options?: ReasoningChainOptions
}): Promise<ReasoningChain> {
	const { db, prefix, agentId, factId, collection, options } = params
	const maxDepth = Math.max(0, options?.maxDepth ?? DEFAULT_MAX_DEPTH)

	const emptyResult: ReasoningChain = {
		factId,
		collection,
		nodes: [],
		chainComplete: true,
		maxDepthReached: false,
		agentId,
	}

	// Validate collection name
	const idField = COLLECTION_ID_FIELDS[collection]
	if (!idField) {
		return emptyResult
	}

	const fullCollectionName = `${prefix}${collection}`
	const col = db.collection(fullCollectionName)

	// Phase 1: $graphLookup to find all structured_mem premises recursively.
	// Traverses sourceEventIds -> key links within the same collection.
	// $graphLookup follows: startWith "$sourceEventIds", connect sourceEventIds -> key.
	const pipeline: Document[] = [
		{ $match: { [idField]: factId, agentId } },
		{
			$graphLookup: {
				from: fullCollectionName,
				startWith: "$sourceEventIds",
				connectFromField: "sourceEventIds",
				connectToField: idField,
				as: "premises",
				maxDepth,
				depthField: "hopDistance",
				restrictSearchWithMatch: { agentId },
			},
		},
	]

	const results = await col.aggregate(pipeline).toArray()

	if (results.length === 0) {
		return emptyResult
	}

	const factDoc = results[0]
	const premises: Document[] = factDoc.premises ?? []
	const sourceEventIds: string[] = factDoc.sourceEventIds ?? []

	// Collect all event IDs referenced across the fact and all premises
	const allEventIds = new Set<string>()
	for (const sid of sourceEventIds) {
		allEventIds.add(sid)
	}
	for (const premise of premises) {
		const premiseSourceIds = premise.sourceEventIds as string[] | undefined
		if (premiseSourceIds) {
			for (const sid of premiseSourceIds) {
				allEventIds.add(sid)
			}
		}
	}

	// Remove IDs that resolved to structured_mem premises (not events)
	const premiseIds = new Set(
		premises.map((p: Document) => p[idField] as string),
	)
	const leafEventIds = [...allEventIds].filter((id) => !premiseIds.has(id))

	// Phase 2: Fetch leaf events via $lookup
	const eventsCol = db.collection(`${prefix}events`)
	const eventDocs =
		leafEventIds.length > 0
			? await eventsCol
					.find({
						eventId: { $in: leafEventIds },
						agentId,
					})
					.sort({ timestamp: 1 })
					.toArray()
			: []

	const resolvedEventIds = new Set(
		eventDocs.map((e: Document) => e.eventId as string),
	)

	// Build nodes
	const nodes: ReasoningChainNode[] = []

	// Event nodes (leaf level, depth 0)
	for (const evt of eventDocs) {
		nodes.push({
			type: "event",
			id: evt.eventId as string,
			collection: "events",
			body: evt.body as string | undefined,
			role: evt.role as string | undefined,
			timestamp: evt.timestamp instanceof Date ? evt.timestamp : undefined,
			depth: 0,
		})
	}

	// Gap nodes for unresolved leaf event IDs
	let chainComplete = true
	for (const sid of leafEventIds) {
		if (!resolvedEventIds.has(sid)) {
			chainComplete = false
			nodes.push({
				type: "gap",
				id: sid,
				collection: "events",
				depth: 0,
				reason: "deleted",
			})
		}
	}

	// Premise nodes (intermediate structured_mem facts at various depths)
	for (const premise of premises) {
		const hopDistance =
			typeof premise.hopDistance === "number" ? premise.hopDistance : 1
		nodes.push({
			type: "fact",
			id: premise[idField] as string,
			collection,
			body: premise.value as string | undefined,
			timestamp:
				premise.updatedAt instanceof Date ? premise.updatedAt : undefined,
			depth: hopDistance,
		})
	}

	// The starting fact itself is the last node at max depth + 1
	nodes.push({
		type: "fact",
		id: factId,
		collection,
		body: factDoc.value as string | undefined,
		timestamp:
			factDoc.updatedAt instanceof Date ? factDoc.updatedAt : undefined,
		depth:
			premises.length > 0
				? Math.max(
						...premises.map((p: Document) => (p.hopDistance as number) ?? 0),
					) + 1
				: sourceEventIds.length > 0
					? 1
					: 0,
	})

	// Sort by depth ascending, then timestamp ascending
	nodes.sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth
		const aTs = a.timestamp?.getTime() ?? 0
		const bTs = b.timestamp?.getTime() ?? 0
		return aTs - bTs
	})

	// If no sourceEventIds at all, the chain is self-contained
	if (sourceEventIds.length === 0 && premises.length === 0) {
		chainComplete = true
	}

	return {
		factId,
		collection,
		nodes,
		chainComplete,
		maxDepthReached: premises.some(
			(p: Document) => (p.hopDistance as number) >= maxDepth,
		),
		agentId,
	}
}
