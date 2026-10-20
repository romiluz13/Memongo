import { describe, expect, it } from "vitest"
import {
	type JobCounts,
	awaitBenchmarkJobsDrained,
} from "./benchmark-job-drain.js"

function fixture(sequence: JobCounts[], options: { stallMs?: number } = {}) {
	let index = 0
	let clock = 0
	const calls = { wakes: 0, sleeps: [] as number[], counts: 0 }
	const drain = () =>
		awaitBenchmarkJobsDrained(
			{
				countJobs: async () => {
					calls.counts += 1
					const counts = sequence[Math.min(index, sequence.length - 1)]
					index += 1
					return counts
				},
				wake: () => {
					calls.wakes += 1
				},
				workerPromise: async () => {},
				sleep: async (ms) => {
					calls.sleeps.push(ms)
					clock += ms
				},
				now: () => clock,
			},
			{
				agentId: "agent-q4",
				pollMs: 5_000,
				stallMs: options.stallMs ?? 60_000,
			},
		)
	return { drain, calls }
}

const counts = (outstanding: number, completed: number, deadLettered = 0) => ({
	outstanding,
	completed,
	deadLettered,
})

describe("awaitBenchmarkJobsDrained", () => {
	it("returns at once when no extraction job is outstanding", async () => {
		const { drain, calls } = fixture([counts(0, 40)])
		await drain()
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
		await drain()
		expect(calls.wakes).toBe(3)
		expect(calls.counts).toBe(4)
	})

	it("keeps waiting through a lease-expiry pause shorter than the stall window", async () => {
		const { drain } = fixture([
			counts(3, 409),
			counts(3, 409),
			counts(3, 409),
			counts(0, 412),
		])
		await expect(drain()).resolves.toBeUndefined()
	})

	it("fails loudly when outstanding jobs make no progress for the stall window", async () => {
		const { drain } = fixture([counts(3, 409)], { stallMs: 20_000 })
		await expect(drain()).rejects.toThrow(
			/agent-q4: no extraction progress for 20000ms \(outstanding=3, completed=409\)/,
		)
	})

	it("fails loudly on dead-lettered extraction jobs even when nothing is outstanding", async () => {
		const { drain } = fixture([counts(0, 409, 2)])
		await expect(drain()).rejects.toThrow(
			/agent-q4: 2 extraction job\(s\) dead-lettered; derived memory is incomplete/,
		)
	})
})
