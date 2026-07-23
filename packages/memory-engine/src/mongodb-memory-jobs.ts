import { randomUUID } from "node:crypto"
import { createSubsystemLogger } from "@memongo/lib"
import type { ClientSession, Db } from "mongodb"
import { memoryJobsCollection } from "./mongodb-schema.js"
import type {
	ClaimedMemoryJob,
	MemoryJob,
	MemoryJobStatus,
	MemoryJobType,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:memory-jobs")
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const DURABLE_JOB_WRITE_CONCERN = {
	w: "majority" as const,
	wtimeoutMS: 5_000,
}

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
	session?: ClientSession
	job: Omit<MemoryJob, "createdAt">
}): Promise<string> {
	const { db, prefix, job } = params
	const doc: MemoryJob = {
		...job,
		createdAt: new Date(),
		attempts: job.attempts ?? 0,
	}
	await memoryJobsCollection(db, prefix).insertOne(
		doc,
		params.session
			? { session: params.session }
			: { writeConcern: DURABLE_JOB_WRITE_CONCERN },
	)
	return doc.jobId
}

export async function claimMemoryJob(params: {
	db: Db
	prefix: string
	agentId: string
	jobType: MemoryJobType
	workerId: string
	leaseMs: number
	now?: Date
}): Promise<ClaimedMemoryJob | null> {
	const now = params.now ?? new Date()
	const leaseToken = randomUUID()
	const leaseExpiresAt = new Date(now.getTime() + params.leaseMs)
	const claimed = await memoryJobsCollection(
		params.db,
		params.prefix,
	).findOneAndUpdate(
		{
			agentId: params.agentId,
			jobType: params.jobType,
			$or: [
				{ status: "pending", stagedAt: { $exists: false } },
				{ status: "running", leaseExpiresAt: { $lte: now } },
				{ status: "running", leaseExpiresAt: { $exists: false } },
			],
		},
		{
			$set: {
				status: "running",
				startedAt: now,
				leaseOwner: params.workerId,
				leaseToken,
				heartbeatAt: now,
				leaseExpiresAt,
			},
			$inc: { attempts: 1 },
			$unset: { completedAt: "", error: "", stagedAt: "" },
		},
		{
			sort: { createdAt: 1, jobId: 1 },
			returnDocument: "after",
			writeConcern: DURABLE_JOB_WRITE_CONCERN,
		},
	)
	return (claimed as ClaimedMemoryJob | null) ?? null
}

export async function renewMemoryJobLease(params: {
	db: Db
	prefix: string
	jobId: string
	agentId: string
	leaseOwner: string
	leaseToken: string
	leaseMs: number
	now?: Date
}): Promise<boolean> {
	const now = params.now ?? new Date()
	const result = await memoryJobsCollection(params.db, params.prefix).updateOne(
		{
			jobId: params.jobId,
			agentId: params.agentId,
			status: "running",
			leaseOwner: params.leaseOwner,
			leaseToken: params.leaseToken,
			leaseExpiresAt: { $gt: now },
		},
		{
			$set: {
				heartbeatAt: now,
				leaseExpiresAt: new Date(now.getTime() + params.leaseMs),
			},
		},
		{ writeConcern: DURABLE_JOB_WRITE_CONCERN },
	)
	return result.matchedCount === 1
}

type ClaimedJobTerminalParams = {
	db: Db
	prefix: string
	jobId: string
	agentId: string
	leaseOwner: string
	leaseToken: string
	now?: Date
	completedAt?: Date
	durationMs?: number
	inputCount?: number
	outputCount?: number
	metadata?: Record<string, unknown>
}

async function finishClaimedMemoryJob(
	params: ClaimedJobTerminalParams & {
		status: "completed" | "failed"
		error?: string
	},
): Promise<boolean> {
	const now = params.now ?? new Date()
	const completedAt = params.completedAt ?? new Date()
	const update: Record<string, unknown> = {
		status: params.status,
		completedAt,
	}
	if (params.durationMs !== undefined) update.durationMs = params.durationMs
	if (params.inputCount !== undefined) update.inputCount = params.inputCount
	if (params.outputCount !== undefined) update.outputCount = params.outputCount
	if (params.metadata !== undefined) update.metadata = params.metadata
	if (params.error !== undefined) update.error = params.error
	const result = await memoryJobsCollection(params.db, params.prefix).updateOne(
		{
			jobId: params.jobId,
			agentId: params.agentId,
			status: "running",
			leaseOwner: params.leaseOwner,
			leaseToken: params.leaseToken,
			leaseExpiresAt: { $gt: now },
		},
		{
			$set: update,
			$unset: {
				leaseOwner: "",
				leaseToken: "",
				leaseExpiresAt: "",
				heartbeatAt: "",
			},
		},
		{ writeConcern: DURABLE_JOB_WRITE_CONCERN },
	)
	return result.matchedCount === 1
}

export async function completeClaimedMemoryJob(
	params: ClaimedJobTerminalParams,
): Promise<boolean> {
	return finishClaimedMemoryJob({ ...params, status: "completed" })
}

export async function failClaimedMemoryJob(
	params: ClaimedJobTerminalParams & { error: string },
): Promise<boolean> {
	return finishClaimedMemoryJob({ ...params, status: "failed" })
}

export async function retryFailedMemoryJob(params: {
	db: Db
	prefix: string
	jobId: string
	agentId: string
	payload: NonNullable<MemoryJob["payload"]>
	metadata?: Record<string, unknown>
}): Promise<boolean> {
	const result = await memoryJobsCollection(params.db, params.prefix).updateOne(
		{
			jobId: params.jobId,
			agentId: params.agentId,
			status: "failed",
		},
		{
			$set: {
				status: "pending",
				payload: params.payload,
				...(params.metadata ? { metadata: params.metadata } : {}),
			},
			$unset: {
				startedAt: "",
				completedAt: "",
				error: "",
				inputCount: "",
				outputCount: "",
				durationMs: "",
				leaseOwner: "",
				leaseToken: "",
				leaseExpiresAt: "",
				heartbeatAt: "",
			},
		},
		{ writeConcern: DURABLE_JOB_WRITE_CONCERN },
	)
	return result.matchedCount === 1
}

export async function releaseStagedMemoryJob(params: {
	db: Db
	prefix: string
	jobId: string
	agentId: string
}): Promise<boolean> {
	const result = await memoryJobsCollection(params.db, params.prefix).updateOne(
		{
			jobId: params.jobId,
			agentId: params.agentId,
			status: "pending",
			stagedAt: { $exists: true },
		},
		{ $unset: { stagedAt: "" } },
		{ writeConcern: DURABLE_JOB_WRITE_CONCERN },
	)
	return result.matchedCount === 1
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
