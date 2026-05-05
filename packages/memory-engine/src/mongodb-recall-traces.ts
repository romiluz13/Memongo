import { randomUUID } from "node:crypto"
import type { Db } from "mongodb"
import { recallTracesCollection } from "./mongodb-schema.js"
import type { RecallTrace } from "./types.js"

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100

function clampListLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIST_LIMIT
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit ?? 0)))
}

export async function recordRecallTrace(params: {
	db: Db
	prefix: string
	trace: Omit<RecallTrace, "traceId" | "timestamp"> & {
		traceId?: string
		timestamp?: Date
	}
}): Promise<string> {
	const { db, prefix, trace } = params
	const traceId = trace.traceId ?? randomUUID()
	const doc: RecallTrace = {
		...trace,
		traceId,
		timestamp: trace.timestamp ?? new Date(),
	}
	await recallTracesCollection(db, prefix).insertOne(doc)
	return traceId
}

export async function listRecallTraces(params: {
	db: Db
	prefix: string
	agentId: string
	limit?: number
}): Promise<RecallTrace[]> {
	const { db, prefix, agentId } = params
	const limit = clampListLimit(params.limit)
	const docs = await recallTracesCollection(db, prefix)
		.find({ agentId })
		.sort({ timestamp: -1 })
		.limit(limit)
		.toArray()
	return docs as unknown as RecallTrace[]
}

export async function getRecallTrace(params: {
	db: Db
	prefix: string
	traceId: string
	agentId?: string
}): Promise<RecallTrace | null> {
	const { db, prefix, traceId, agentId } = params
	const doc = await recallTracesCollection(db, prefix).findOne({
		traceId,
		...(agentId ? { agentId } : {}),
	})
	return (doc as RecallTrace | null) ?? null
}
