import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type JobCounts,
	awaitBenchmarkJobsDrained,
	sleepUnlessAborted,
} from "./benchmark-job-drain.js"

const never = <T>() => new Promise<T>(() => {})

function fixture(
	sequence: Array<JobCounts | "hang">,
	options: { stallMs?: number; worker?: "settles" | "hangs" } = {},
) {
	let index = 0
	const calls = { wakes: 0, counts: 0 }
	const drain = () =>
		awaitBenchmarkJobsDrained(
			{
				countJobs: async () => {
					calls.counts += 1
					const next = sequence[Math.min(index, sequence.length - 1)]
					index += 1
					return next === "hang" ? never<JobCounts>() : next
				},
				wake: () => {
					calls.wakes += 1
				},
				workerPromise: () =>
					options.worker === "hangs" ? never<void>() : Promise.resolve(),
				sleep: sleepUnlessAborted,
				now: () => Date.now(),
			},
			{
				agentId: "agent-q4",
				pollMs: 5_000,
				stallMs: options.stallMs ?? 60_000,
			},
		)
	return { drain, calls }
}

type Outcome =
	| { state: "pending" | "resolved" }
	| { state: "rejected"; error: unknown }

async function outcome(
	promise: Promise<void>,
	horizonMs = 1_000_000,
): Promise<Outcome> {
	let result: Outcome = { state: "pending" }
	promise.then(
		() => {
			result = { state: "resolved" }
		},
		(error: unknown) => {
			result = { state: "rejected", error }
		},
	)
	await vi.advanceTimersByTimeAsync(horizonMs)
	return result
}

function rejection(result: Outcome): string {
	expect(result.state).toBe("rejected")
	return result.state === "rejected" ? String(result.error) : ""
}

const counts = (outstanding: number, completed: number, deadLettered = 0) => ({
	outstanding,
	completed,
	deadLettered,
})

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe("awaitBenchmarkJobsDrained", () => {
	it("returns at once when no extraction job is outstanding", async () => {
		const { drain, calls } = fixture([counts(0, 40)])
		expect(await outcome(drain())).toEqual({ state: "resolved" })
		expect(calls.wakes).toBe(0)
		expect(calls.counts).toBe(1)
	})

	it("wakes the worker and waits while a failed worker left jobs pending", async () => {
		const { drain, calls } = fixture([
			counts(374, 38),
			counts(200, 212),
			counts(3, 409),
			counts(0, 412),
		])
		expect(await outcome(drain())).toEqual({ state: "resolved" })
		expect(calls.wakes).toBe(3)
		expect(calls.counts).toBe(4)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("keeps waiting through a lease-expiry pause shorter than the stall window", async () => {
		const { drain } = fixture([
			counts(3, 409),
			counts(3, 409),
			counts(3, 409),
			counts(0, 412),
		])
		expect(await outcome(drain())).toEqual({ state: "resolved" })
	})

	it("fails loudly when outstanding jobs make no progress for the stall window", async () => {
		const { drain } = fixture([counts(3, 409)], { stallMs: 20_000 })
		expect(rejection(await outcome(drain()))).toMatch(
			/agent-q4: no extraction progress for 20000ms \(outstanding=3, completed=409\)/,
		)
	})

	it("fails loudly on dead-lettered extraction jobs even when nothing is outstanding", async () => {
		const { drain } = fixture([counts(0, 409, 2)])
		expect(rejection(await outcome(drain()))).toMatch(
			/agent-q4: 2 extraction job\(s\) dead-lettered; derived memory is incomplete/,
		)
	})

	it("re-reads counts every poll while a worker run never settles, and completes on progress", async () => {
		const { drain, calls } = fixture(
			[counts(30, 0), counts(20, 10), counts(10, 20), counts(0, 30)],
			{ worker: "hangs", stallMs: 20_000 },
		)
		expect(await outcome(drain(), 60_000)).toEqual({ state: "resolved" })
		expect(calls.counts).toBe(4)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("fails loudly after the stall window when a never-settling worker makes no progress", async () => {
		const { drain } = fixture([counts(3, 409)], {
			worker: "hangs",
			stallMs: 20_000,
		})
		expect(rejection(await outcome(drain(), 60_000))).toMatch(
			/agent-q4: no extraction progress for 20000ms \(outstanding=3, completed=409\)/,
		)
	})

	it("fails loudly naming the stalled count read when a count never settles", async () => {
		const { drain } = fixture([counts(3, 409), "hang"], { stallMs: 20_000 })
		expect(rejection(await outcome(drain(), 60_000))).toMatch(
			/agent-q4: extraction job count after wake did not return within \d+ms; no extraction progress for \d+ms/,
		)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("fails loudly naming the initial count read when the first count never settles", async () => {
		const { drain } = fixture(["hang"], { stallMs: 20_000 })
		expect(rejection(await outcome(drain(), 60_000))).toMatch(
			/agent-q4: extraction job initial count did not return within 20000ms/,
		)
	})
})
