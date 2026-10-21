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
	sleep(ms: number, signal: AbortSignal): Promise<void>
	now(): number
}

/** Resolves after `ms`, or at once when `signal` aborts, clearing its timer. */
export function sleepUnlessAborted(
	ms: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				resolve()
			},
			{ once: true },
		)
	})
}

export const JOB_DRAIN_POLL_MS = 5_000
export const JOB_DRAIN_STALL_DEFAULT_MS = 600_000

/** The value is never echoed: the error names the variable and the rule. */
export function resolveJobDrainStallMs(): number {
	const raw = process.env.MEMONGO_BENCHMARK_JOB_DRAIN_STALL_MS
	if (raw === undefined) return JOB_DRAIN_STALL_DEFAULT_MS
	const value = raw.trim()
	const stallMs = Number(value)
	if (value === "" || !Number.isFinite(stallMs) || stallMs <= 0) {
		throw new Error(
			"MEMONGO_BENCHMARK_JOB_DRAIN_STALL_MS must be a positive, finite number of milliseconds when set; unset it to use the default",
		)
	}
	return stallMs
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
 *
 * No wait here outlives the stall window: a worker run is awaited for at most
 * one poll, so counts are re-read while a long run makes progress, and each
 * count read is bounded by what is left of the window. A drain that keeps
 * progressing has no total deadline.
 */
export async function awaitBenchmarkJobsDrained(
	deps: JobDrainDeps,
	options: { agentId: string; pollMs: number; stallMs: number },
): Promise<void> {
	let lastProgressAt = deps.now()
	const readCounts = async (step: string): Promise<JobCounts> => {
		// A read always gets one poll, even when the window is already spent by
		// the poll that preceded it.
		const budgetMs = Math.max(
			lastProgressAt + options.stallMs - deps.now(),
			options.pollMs,
		)
		const expired = new AbortController()
		const timedOut = Symbol("timedOut")
		try {
			const result = await Promise.race([
				deps.countJobs(),
				deps.sleep(budgetMs, expired.signal).then(() => timedOut),
			])
			if (result === timedOut) {
				throw new Error(
					`benchmark scenario ${options.agentId}: extraction job ${step} did not return within ${budgetMs}ms; no extraction progress for ${deps.now() - lastProgressAt}ms`,
				)
			}
			return result as JobCounts
		} finally {
			expired.abort()
		}
	}
	let last = await readCounts("initial count")
	for (;;) {
		if (last.deadLettered > 0) {
			throw new Error(
				`benchmark scenario ${options.agentId}: ${last.deadLettered} extraction job(s) dead-lettered; derived memory is incomplete`,
			)
		}
		if (last.outstanding === 0) return
		if (deps.now() - lastProgressAt >= options.stallMs) {
			throw new Error(
				`benchmark scenario ${options.agentId}: no extraction progress for ${options.stallMs}ms (outstanding=${last.outstanding}, completed=${last.completed})`,
			)
		}
		deps.wake()
		const poll = new AbortController()
		try {
			const tick = deps.sleep(options.pollMs, poll.signal)
			await Promise.race([deps.workerPromise(), tick])
			const next = await readCounts("count after wake")
			if (
				next.outstanding < last.outstanding ||
				next.completed > last.completed
			) {
				lastProgressAt = deps.now()
			}
			if (next.outstanding > 0) await tick
			last = next
		} finally {
			poll.abort()
		}
	}
}
