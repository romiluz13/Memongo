import { afterEach, describe, expect, it } from "vitest"
import type { Db } from "mongodb"
import {
	countPendingMemoryJobs,
	resolveDrainConcurrency,
	resolveMemoryJobBacklogAlertThreshold,
} from "./mongodb-manager-jobs.js"

// WS-11 change 3 (09-report R6/U3): the memory_jobs backlog used to be
// invisible (countable but nothing alarmed) and the drain ran at fixed
// concurrency no matter the depth. These tests pin the alert threshold
// resolution, the backlog-aware drain scaling rule, and the gauge read.

const THRESHOLD_ENV = "MEMONGO_JOB_BACKLOG_ALERT"

describe("resolveMemoryJobBacklogAlertThreshold", () => {
	const original = process.env[THRESHOLD_ENV]

	afterEach(() => {
		if (original === undefined) {
			delete process.env[THRESHOLD_ENV]
		} else {
			process.env[THRESHOLD_ENV] = original
		}
	})

	it("defaults to 500 pending jobs", () => {
		delete process.env[THRESHOLD_ENV]
		expect(resolveMemoryJobBacklogAlertThreshold()).toBe(500)
	})

	it("honors a positive override and rejects invalid values", () => {
		process.env[THRESHOLD_ENV] = "50"
		expect(resolveMemoryJobBacklogAlertThreshold()).toBe(50)
		process.env[THRESHOLD_ENV] = "0"
		expect(resolveMemoryJobBacklogAlertThreshold()).toBe(500)
		process.env[THRESHOLD_ENV] = "not-a-number"
		expect(resolveMemoryJobBacklogAlertThreshold()).toBe(500)
	})
})

describe("resolveDrainConcurrency (backlog-aware scaling)", () => {
	it("keeps the configured base at or below the alert threshold", () => {
		expect(resolveDrainConcurrency({ depth: 0, base: 3, threshold: 500 })).toBe(
			3,
		)
		expect(
			resolveDrainConcurrency({ depth: 500, base: 3, threshold: 500 }),
		).toBe(3)
	})

	it("scales with the overflow ratio above the threshold", () => {
		// 2x threshold -> 2x base; 3x -> 3x base.
		expect(
			resolveDrainConcurrency({ depth: 1000, base: 3, threshold: 500 }),
		).toBe(6)
		expect(
			resolveDrainConcurrency({ depth: 1500, base: 3, threshold: 500 }),
		).toBe(9)
		// Partial overflow rounds up to the next whole multiple.
		expect(
			resolveDrainConcurrency({ depth: 501, base: 3, threshold: 500 }),
		).toBe(6)
	})

	it("clamps at the 16-worker hard cap", () => {
		expect(
			resolveDrainConcurrency({ depth: 10_000, base: 3, threshold: 500 }),
		).toBe(16)
	})

	it("never scales below the configured base", () => {
		expect(
			resolveDrainConcurrency({ depth: 9999, base: 16, threshold: 500 }),
		).toBe(16)
		expect(
			resolveDrainConcurrency({ depth: 10, base: 16, threshold: 500 }),
		).toBe(16)
	})

	it("a zero threshold (misconfiguration) falls back to the base, not division blowups", () => {
		expect(
			resolveDrainConcurrency({ depth: 1000, base: 3, threshold: 0 }),
		).toBe(3)
	})
})

describe("countPendingMemoryJobs (the gauge read)", () => {
	it("counts pending jobs for the agent with the jobType filter applied", async () => {
		const calls: Array<Record<string, unknown>> = []
		const fakeDb = {
			command: () => {
				throw new Error("unused")
			},
		} as unknown as Db
		const collection = {
			countDocuments: async (filter: Record<string, unknown>) => {
				calls.push(filter)
				return 4242
			},
		}
		const db = new Proxy(fakeDb, {
			get: (target, prop) => {
				if (prop === "collection") {
					return () => collection
				}
				return (target as Record<string | symbol, unknown>)[prop]
			},
		}) as unknown as Db
		const depth = await countPendingMemoryJobs({
			db,
			prefix: "t_",
			agentId: "agent-a",
			jobType: "extraction",
		})
		expect(depth).toBe(4242)
		expect(calls).toEqual([
			{ agentId: "agent-a", status: "pending", jobType: "extraction" },
		])
	})

	it("degrades to 0 when the count fails (the gauge cannot break the drain)", async () => {
		const fakeDb = {
			collection: () => ({
				countDocuments: async () => {
					throw new Error("connection lost")
				},
			}),
		} as unknown as Db
		const depth = await countPendingMemoryJobs({
			db: fakeDb,
			prefix: "t_",
			agentId: "agent-a",
		})
		expect(depth).toBe(0)
	})
})
