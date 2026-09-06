import { randomUUID } from "node:crypto"
import { createSubsystemLogger } from "@memongo/lib"
import type { ClientSession, Db } from "mongodb"
import { memoryJobsCollection } from "./mongodb-schema.js"
import { classifyBulkInsertError } from "./mongodb-events.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import type {
	ClaimedMemoryJob,
	MemoryJob,
	MemoryJobStatus,
	MemoryJobType,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:memory-jobs")
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
export const DURABLE_JOB_WRITE_CONCERN = {
	w: "majority" as const,
	wtimeoutMS: 5_000,
}

/**
 * How many times a job may be claimed before it is left failed for good.
 *
 * `attempts` has always been incremented on claim but never read, so a failed
 * job was terminal by accident rather than by policy: nothing reclaimed it,
 * and for extraction the event's `extractionJobPendingAt` marker is cleared
 * when the job is released — before the work runs — so the outbox repair pass
 * could not see it either. A single transient extraction failure therefore
 * dropped that event's memories permanently and silently.
 */
export const MEMORY_JOB_MAX_ATTEMPTS = 3

/** Backoff before a failed job becomes claimable again: 1min, 4min, ... */
export function memoryJobRetryDelayMs(attempts: number): number {
	const safeAttempts = Math.max(1, Math.floor(attempts))
	return Math.min(60_000 * 4 ** (safeAttempts - 1), 60 * 60_000)
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

export type MemoryJobBatchItemResult =
	| { ok: true; jobId: string }
	| { ok: false; jobId: string; duplicate: boolean; message: string }

/**
 * W09 reconciliation read for job inserts: which jobIds already exist. An
 * existing job is claimable (or already ran) — satisfied either way; a
 * missing job is not durable and is safe to retry.
 */
async function findExistingMemoryJobIds(params: {
	db: Db
	prefix: string
	jobIds: string[]
}): Promise<Set<string>> {
	const { db, prefix, jobIds } = params
	if (jobIds.length === 0) {
		return new Set()
	}
	const docs = await memoryJobsCollection(db, prefix)
		.find({ jobId: { $in: jobIds } }, { projection: { _id: 0, jobId: 1 } })
		.toArray()
	const existing = new Set<string>()
	for (const doc of docs) {
		const jobId = (doc as { jobId?: string }).jobId
		if (typeof jobId === "string") {
			existing.add(jobId)
		}
	}
	return existing
}

/**
 * W09: for jobs whose durability the server did not confirm, read back which
 * jobIds exist. Present = satisfied; absent = retry-safe receipt. A failed
 * reconciliation read yields "durability unconfirmed" receipts instead of a
 * throw — a throw here would reject a batch whose events are already durable
 * (W08).
 */
async function reconcileJobBatchOutcomes(params: {
	db: Db
	prefix: string
	results: MemoryJobBatchItemResult[]
	docs: MemoryJob[]
	positions: number[]
}): Promise<void> {
	const { db, prefix, results, docs, positions } = params
	let existing: Set<string>
	try {
		existing = await findExistingMemoryJobIds({
			db,
			prefix,
			jobIds: positions.map((position) => docs[position].jobId),
		})
	} catch (err) {
		log.warn(
			`job batch reconciliation read failed; ${positions.length} item(s) reported durability-unconfirmed: ${String(err)}`,
		)
		for (const position of positions) {
			results[position] = {
				ok: false,
				jobId: docs[position].jobId,
				duplicate: false,
				message: "job durability unconfirmed (reconciliation read failed)",
			}
		}
		return
	}
	for (const position of positions) {
		const doc = docs[position]
		if (existing.has(doc.jobId)) {
			results[position] = { ok: true, jobId: doc.jobId }
		} else {
			results[position] = {
				ok: false,
				jobId: doc.jobId,
				duplicate: false,
				message:
					"job insert unconfirmed (write concern or network outcome); not found on reconciliation read",
			}
		}
	}
}

/**
 * P3.9/W09: insert many jobs in ONE unordered insertMany with the durable
 * write concern. Per-item receipts isolate failures; E11000 (the
 * deterministic `extraction-<eventId>` job already exists) maps to
 * duplicate:true so the caller can treat an existing job as satisfied
 * instead of an error. Non-per-item errors (write concern, network
 * exhaustion, NoWritesPerformed) are classified and reconciled by read
 * instead of throwing into a persisted batch (W08): present jobs are
 * satisfied, missing ones stay retry-safe receipts.
 */
export async function createMemoryJobsBatch(params: {
	db: Db
	prefix: string
	jobs: Array<Omit<MemoryJob, "createdAt">>
}): Promise<MemoryJobBatchItemResult[]> {
	const { db, prefix, jobs } = params
	if (jobs.length === 0) {
		return []
	}
	const docs: MemoryJob[] = jobs.map((job) => ({
		...job,
		createdAt: new Date(),
		attempts: job.attempts ?? 0,
	}))
	const results: MemoryJobBatchItemResult[] = docs.map((doc) => ({
		ok: true,
		jobId: doc.jobId,
	}))
	try {
		await memoryJobsCollection(db, prefix).insertMany(docs, {
			ordered: false,
			writeConcern: DURABLE_JOB_WRITE_CONCERN,
		})
	} catch (err) {
		const outcome = classifyBulkInsertError(err)
		const unconfirmed: number[] = []
		if (outcome.kind === "no-writes-performed") {
			// EL-021: zero writes guaranteed; every job stays retry-safe.
			for (const [index, doc] of docs.entries()) {
				results[index] = {
					ok: false,
					jobId: doc.jobId,
					duplicate: false,
					message: "no writes performed (server-confirmed); safe to retry",
				}
			}
		} else if (outcome.kind === "item-errors") {
			const erroredPositions = new Set(
				outcome.writeErrors.map((writeError) => writeError.index),
			)
			for (const writeError of outcome.writeErrors) {
				const doc = docs[writeError.index]
				if (!doc) {
					continue
				}
				results[writeError.index] = {
					ok: false,
					jobId: doc.jobId,
					duplicate: writeError.code === 11000,
					message: writeError.errmsg ?? "job insert failed",
				}
			}
			for (const [position] of docs.entries()) {
				if (erroredPositions.has(position)) {
					continue
				}
				// EL-020: unlisted jobs were applied — unless a write-concern
				// error rode along (EL-022), in which case confirm by read.
				if (outcome.writeConcernError) {
					unconfirmed.push(position)
				}
			}
		} else {
			// Uncertain outcome (write concern without per-item report, or a
			// network error that exhausted retries mid-flight): read back what
			// actually exists.
			unconfirmed.push(...docs.keys())
		}
		if (unconfirmed.length > 0) {
			await reconcileJobBatchOutcomes({
				db,
				prefix,
				results,
				docs,
				positions: unconfirmed,
			})
		}
	}
	return results
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
	// Fleet audit P2: lease timestamps are stamped with server time ($$NOW via
	// aggregation-pipeline update) so cross-worker clock skew cannot shorten or
	// stretch a lease. The FILTER comparisons below still use the client clock
	// (an $expr would defeat idx_memory_jobs_claim_v2's bounds) — that residual
	// assumes workers are NTP-synced within the lease slack.
	const now = params.now ?? new Date()
	const leaseToken = randomUUID()
	const claimed = await memoryJobsCollection(
		params.db,
		params.prefix,
	).findOneAndUpdate(
		{
			agentId: params.agentId,
			jobType: params.jobType,
			$or: [
				{ status: "pending", stagedAt: { $exists: false } },
				// W05: a running row marked `tracking: true` is a LIVE synchronous
				// run's audit row (explicit consolidate), not queued work — never
				// claimable, even lease-less. Legacy pre-lease rows (no tracking
				// field) remain reclaimable as abandoned.
				// W18: reclaiming lease-expired (or lease-less) running work is
				// bounded by the same attempt budget as failed retries, so a
				// crash/lease-expiry loop cannot pay for work forever.
				{
					status: "running",
					leaseExpiresAt: { $lte: now },
					attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
					tracking: { $ne: true },
				},
				{
					status: "running",
					leaseExpiresAt: { $exists: false },
					attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
					tracking: { $ne: true },
				},
				// A failed job is retried until it exhausts its attempt budget,
				// after which it stays failed as an explicit dead letter. Jobs that
				// failed before retryAt existed are eligible immediately. A failed
				// explicit run keeps its caller options in metadata; the
				// consolidation runner restores them (W05).
				{
					status: "failed",
					attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
					$or: [{ retryAt: { $exists: false } }, { retryAt: { $lte: now } }],
				},
			],
		},
		[
			{
				$set: {
					status: "running",
					startedAt: "$$NOW",
					leaseOwner: params.workerId,
					leaseToken,
					heartbeatAt: "$$NOW",
					leaseExpiresAt: { $add: ["$$NOW", params.leaseMs] },
					attempts: { $add: [{ $ifNull: ["$attempts", 0] }, 1] },
				},
			},
			{ $unset: ["completedAt", "error", "stagedAt", "retryAt"] },
		],
		{
			sort: { createdAt: 1, jobId: 1 },
			returnDocument: "after",
			writeConcern: DURABLE_JOB_WRITE_CONCERN,
		},
	)
	return (claimed as ClaimedMemoryJob | null) ?? null
}

/**
 * W18: bound the crash/lease-expiry retry loop. A running row whose lease
 * expired (or was never set) and whose attempt budget is spent can no longer
 * be claimed; without this sweep it would sit in `running` forever, invisible
 * to the failed/dead-letter status counts. The sweep transitions exactly
 * those rows to the same dead-letter shape finishClaimedMemoryJob writes
 * (failed + deadLetterAt, no completedAt so the completed-TTL index keeps the
 * row visible for operator action, lease fields cleared). Idempotent by
 * construction: transitioned rows leave the `running` state, so a re-run
 * matches nothing — updateMany is for idempotent operations per the manual.
 * Live synchronous tracking rows (W05) are excluded: their runner owns its
 * own terminal transition.
 */
export async function deadLetterExpiredMemoryJobs(params: {
	db: Db
	prefix: string
	agentId: string
	jobType?: MemoryJobType
	now?: Date
}): Promise<number> {
	const now = params.now ?? new Date()
	const result = await memoryJobsCollection(
		params.db,
		params.prefix,
	).updateMany(
		{
			agentId: params.agentId,
			...(params.jobType ? { jobType: params.jobType } : {}),
			status: "running",
			attempts: { $gte: MEMORY_JOB_MAX_ATTEMPTS },
			tracking: { $ne: true },
			$or: [
				{ leaseExpiresAt: { $lte: now } },
				{ leaseExpiresAt: { $exists: false } },
			],
		},
		{
			$set: {
				status: "failed",
				deadLetterAt: now,
				error: "lease-expiry retry budget exhausted",
			},
			$unset: {
				leaseOwner: "",
				leaseToken: "",
				leaseExpiresAt: "",
				heartbeatAt: "",
				retryAt: "",
				completedAt: "",
			},
		},
		{ writeConcern: DURABLE_JOB_WRITE_CONCERN },
	)
	return result.modifiedCount ?? 0
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
		[
			{
				$set: {
					heartbeatAt: "$$NOW",
					leaseExpiresAt: { $add: ["$$NOW", params.leaseMs] },
				},
			},
		],
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
	/** Job type, recorded on dead-letter telemetry and logs. */
	jobType?: MemoryJobType
	metadata?: Record<string, unknown>
}

async function finishClaimedMemoryJob(
	params: ClaimedJobTerminalParams & {
		status: "completed" | "failed"
		error?: string
		/** Attempts already spent, used to space out the retry. */
		attempts?: number
	},
): Promise<boolean> {
	const now = params.now ?? new Date()
	const completedAt = params.completedAt ?? new Date()
	// A job that exhausted its attempt budget becomes a dead letter instead of
	// a retryable failure. Three properties follow from that, and all three
	// are load-bearing:
	//   - no retryAt: the claim filter requires attempts < MAX, so a retry
	//     time would be a promise the queue can never keep;
	//   - no completedAt: the completed-TTL index would silently erase the job
	//     like any other finished one — a dead letter is kept precisely so an
	//     operator can see it (status counts surface it) and requeue or drop
	//     it deliberately;
	//   - deadLetterAt marks the transition so counts and queries can tell a
	//     dead letter from a failure that still has budget left.
	const deadLettered =
		params.status === "failed" &&
		(params.attempts ?? 1) >= MEMORY_JOB_MAX_ATTEMPTS
	const update: Record<string, unknown> = {
		status: params.status,
		completedAt,
	}
	if (params.status === "failed" && !deadLettered) {
		// Claiming is what enforces the budget; this only spaces the retries out
		// so a job that fails for a persistent reason does not spin.
		update.retryAt = new Date(
			now.getTime() + memoryJobRetryDelayMs(params.attempts ?? 1),
		)
	}
	if (deadLettered) {
		update.deadLetterAt = completedAt
		delete update.completedAt
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
	if (result.matchedCount === 1 && deadLettered) {
		log.error(
			`memory job dead-lettered after ${params.attempts ?? 1} attempts: jobId=${params.jobId} jobType=${params.jobType ?? "unknown"} error=${params.error ?? ""}`,
		)
		emitTelemetry(params.db, params.prefix, {
			meta: {
				agentId: params.agentId,
				operation: "memory-job-dead-letter",
			},
			durationMs: params.durationMs ?? 0,
			ok: false,
			itemCount: params.attempts ?? 1,
			eventType: params.jobType ?? "unknown",
		})
	}
	return result.matchedCount === 1
}

export async function completeClaimedMemoryJob(
	params: ClaimedJobTerminalParams,
): Promise<boolean> {
	return finishClaimedMemoryJob({ ...params, status: "completed" })
}

export async function failClaimedMemoryJob(
	params: ClaimedJobTerminalParams & { error: string; attempts?: number },
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
				deadLetterAt: "",
				error: "",
				inputCount: "",
				outputCount: "",
				durationMs: "",
				leaseOwner: "",
				leaseToken: "",
				leaseExpiresAt: "",
				heartbeatAt: "",
				retryAt: "",
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
