import type { Db } from "mongodb"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import { laneCoverageCollection } from "./mongodb-schema.js"

export type LaneStatus = {
	count: number
	lastUpdated: Date | null
	hasData: boolean
}

export type LaneCoverageDocument = {
	agentId: string
	lanes: Record<string, LaneStatus>
	updatedAt: Date
}

const ALL_LANES: RetrievalPath[] = [
	"active-critical",
	"structured",
	"raw-window",
	"graph",
	"hybrid",
	"kb",
	"episodic",
	"procedural",
]

export function emptyLaneCoverage(): Record<string, LaneStatus> {
	const lanes: Record<string, LaneStatus> = {}
	for (const lane of ALL_LANES) {
		lanes[lane] = { count: 0, lastUpdated: null, hasData: false }
	}
	return lanes
}

/**
 * Atomically increment lane counters for an agent.
 * Uses $inc for atomic counter updates and upsert for first-time creation.
 */
export async function updateLaneCoverage(params: {
	db: Db
	prefix: string
	agentId: string
	increments: Partial<Record<string, number>>
}): Promise<void> {
	const { db, prefix, agentId, increments } = params
	if (Object.keys(increments).length === 0) {
		return
	}

	const incFields: Record<string, number> = {}
	const setFields: Record<string, unknown> = { updatedAt: new Date() }

	for (const [lane, count] of Object.entries(increments)) {
		if (count && count > 0) {
			incFields[`lanes.${lane}.count`] = count
			setFields[`lanes.${lane}.lastUpdated`] = new Date()
			setFields[`lanes.${lane}.hasData`] = true
		}
	}

	if (Object.keys(incFields).length === 0) {
		return
	}

	const collection = laneCoverageCollection(db, prefix)
	await collection.updateOne(
		{ agentId },
		{
			$inc: incFields,
			$set: setFields,
			$setOnInsert: { agentId },
		},
		{ upsert: true },
	)
}

/**
 * Get lane coverage for an agent.
 * Returns null if no coverage document exists.
 */
export async function getLaneCoverage(params: {
	db: Db
	prefix: string
	agentId: string
}): Promise<LaneCoverageDocument | null> {
	const { db, prefix, agentId } = params
	const collection = laneCoverageCollection(db, prefix)
	const doc = await collection.findOne({ agentId })
	if (!doc) {
		return null
	}
	return doc as unknown as LaneCoverageDocument
}
