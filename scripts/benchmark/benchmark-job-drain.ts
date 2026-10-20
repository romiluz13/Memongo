import type { Collection, Document } from "mongodb"
import { MEMORY_JOB_MAX_ATTEMPTS } from "../../packages/memory-engine/src/mongodb-memory-jobs.js"

export type JobCounts = {
	outstanding: number
	completed: number
	deadLettered: number
}

export type JobDrainDeps = {
	countJobs(): Promise<JobCounts>
	wake(): void
	workerPromise(): Promise<void>
	sleep(ms: number): Promise<void>
	now(): number
}

export const JOB_DRAIN_POLL_MS = 5_000
export const JOB_DRAIN_STALL_DEFAULT_MS = 600_000

export function resolveJobDrainStallMs(): number {
	const raw = Number(process.env.MEMONGO_BENCHMARK_JOB_DRAIN_STALL_MS)
	return Number.isFinite(raw) && raw > 0 ? raw : JOB_DRAIN_STALL_DEFAULT_MS
}

/**
 * Extraction-job states for one agent. Outstanding is anything the worker can
 * still finish: pending, running (a lost lease is reclaimed after expiry) and
 * failed with attempts left. Dead-lettered work will never run again.
 */
export async function countBenchmarkExtractionJobs(
	jobs: Collection<Document>,
	agentId: string,
): Promise<JobCounts> {
	const base = { agentId, jobType: "extraction" }
	const [outstanding, completed, deadLettered] = await Promise.all([
		jobs.countDocuments({
			...base,
			$or: [
				{ status: { $in: ["pending", "running"] } },
				{
					status: "failed",
					attempts: { $lt: MEMORY_JOB_MAX_ATTEMPTS },
					deadLetterAt: { $exists: false },
				},
			],
		}),
		jobs.countDocuments({ ...base, status: "completed" }),
		jobs.countDocuments({
			...base,
			status: "failed",
			$or: [
				{ deadLetterAt: { $exists: true } },
				{ attempts: { $gte: MEMORY_JOB_MAX_ATTEMPTS } },
			],
		}),
	])
	return { outstanding, completed, deadLettered }
}

/**
 * The in-process queues can settle while extraction jobs remain: a worker
 * whose drain throws (for example on a DNS outage) resolves its promise and
 * leaves the rest to a later sweep. Scoring then would read partial derived
 * memory, so wait until the job collection itself is drained, waking the
 * worker each round, and fail loudly on dead letters or a stalled drain.
 */
export async function awaitBenchmarkJobsDrained(
	deps: JobDrainDeps,
	options: { agentId: string; pollMs: number; stallMs: number },
): Promise<void> {
	let last = await deps.countJobs()
	let lastProgressAt = deps.now()
	for (;;) {
		if (last.deadLettered > 0) {
			throw new Error(
				`benchmark scenario ${options.agentId}: ${last.deadLettered} extraction job(s) dead-lettered; derived memory is incomplete`,
			)
		}
		if (last.outstanding === 0) return
		deps.wake()
		await deps.workerPromise()
		const next = await deps.countJobs()
		if (
			next.outstanding < last.outstanding ||
			next.completed > last.completed
		) {
			lastProgressAt = deps.now()
		} else if (deps.now() - lastProgressAt >= options.stallMs) {
			throw new Error(
				`benchmark scenario ${options.agentId}: no extraction progress for ${options.stallMs}ms (outstanding=${next.outstanding}, completed=${next.completed})`,
			)
		}
		if (next.outstanding > 0) await deps.sleep(options.pollMs)
		last = next
	}
}
