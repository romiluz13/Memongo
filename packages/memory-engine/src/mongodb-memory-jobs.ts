import { createSubsystemLogger } from "@memongo/lib"
import type { Db } from "mongodb"
import { memoryJobsCollection } from "./mongodb-schema.js"
import type { MemoryJob, MemoryJobStatus, MemoryJobType } from "./types.js"

const log = createSubsystemLogger("memory:mongodb:memory-jobs")
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100

function clampListLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIST_LIMIT
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit ?? 0)))
}

function allowedPreviousStatuses(status: MemoryJobStatus): MemoryJobStatus[] {
	switch (status) {
		case "pending":
			return ["pending"]
		case "running":
			return ["pending", "running"]
		case "completed":
			return ["pending", "running", "completed"]
		case "failed":
			return ["pending", "running", "failed"]
		case "cancelled":
			return ["pending", "running", "cancelled"]
	}
}

export async function createMemoryJob(params: {
	db: Db
	prefix: string
	job: Omit<MemoryJob, "createdAt">
}): Promise<string> {
	const { db, prefix, job } = params
	const doc: MemoryJob = {
		...job,
		createdAt: new Date(),
	}
	await memoryJobsCollection(db, prefix).insertOne(doc)
	return doc.jobId
}

export async function updateMemoryJob(params: {
	db: Db
	prefix: string
	jobId: string
	agentId?: string
	status: MemoryJobStatus
	startedAt?: Date
	completedAt?: Date
	error?: string
	inputCount?: number
	outputCount?: number
	durationMs?: number
	metadata?: Record<string, unknown>
}): Promise<void> {
	const {
		db,
		prefix,
		jobId,
		agentId,
		status,
		startedAt,
		completedAt,
		error,
		inputCount,
		outputCount,
		durationMs,
		metadata,
	} = params
	const update: Record<string, unknown> = { status }
	if (startedAt) {
		update.startedAt = startedAt
	}
	if (completedAt) {
		update.completedAt = completedAt
	}
	if (error !== undefined) {
		update.error = error
	}
	if (inputCount !== undefined) {
		update.inputCount = inputCount
	}
	if (outputCount !== undefined) {
		update.outputCount = outputCount
	}
	if (durationMs !== undefined) {
		update.durationMs = durationMs
	}
	if (metadata !== undefined) {
		update.metadata = metadata
	}
	const result = await memoryJobsCollection(db, prefix).updateOne(
		{
			jobId,
			...(agentId ? { agentId } : {}),
			status: { $in: allowedPreviousStatuses(status) },
		},
		{ $set: update },
	)
	if (result.matchedCount === 0) {
		log.warn(
			`updateMemoryJob skipped missing/invalid-transition jobId=${jobId} status=${status}`,
		)
	}
}

export async function listMemoryJobs(params: {
	db: Db
	prefix: string
	agentId: string
	status?: MemoryJobStatus
	limit?: number
	jobType?: MemoryJobType
}): Promise<MemoryJob[]> {
	const { db, prefix, agentId, status, jobType } = params
	const limit = clampListLimit(params.limit)
	const docs = await memoryJobsCollection(db, prefix)
		.find({
			agentId,
			...(status ? { status } : {}),
			...(jobType ? { jobType } : {}),
		})
		.sort({ createdAt: -1 })
		.limit(limit)
		.toArray()
	return docs as unknown as MemoryJob[]
}

export async function getMemoryJob(params: {
	db: Db
	prefix: string
	jobId: string
	agentId?: string
}): Promise<MemoryJob | null> {
	const { db, prefix, jobId, agentId } = params
	const doc = await memoryJobsCollection(db, prefix).findOne({
		jobId,
		...(agentId ? { agentId } : {}),
	})
	return (doc as MemoryJob | null) ?? null
}
