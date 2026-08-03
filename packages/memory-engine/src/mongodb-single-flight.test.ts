import { describe, expect, it, vi } from "vitest"
import { runSingleFlight } from "./mongodb-single-flight.js"

function deferred<T>(value: T, ms: number): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

describe("runSingleFlight", () => {
	it("coalesces concurrent identical keys into exactly one execution", async () => {
		const owner = {}
		const execute = vi.fn(async () => {
			await deferred(null, 10)
			return "value"
		})

		const outcomes = await Promise.all(
			Array.from({ length: 8 }, () => runSingleFlight(owner, "key", execute)),
		)

		expect(execute).toHaveBeenCalledTimes(1)
		expect(outcomes).toHaveLength(8)
		expect(outcomes.every((outcome) => outcome.value === "value")).toBe(true)
		expect(outcomes.filter((outcome) => outcome.leader)).toHaveLength(1)
		expect(outcomes.filter((outcome) => !outcome.leader)).toHaveLength(7)
	})

	it("runs different keys independently", async () => {
		const owner = {}
		const execute = vi.fn(async (label: string) => {
			await deferred(null, 5)
			return label
		})

		const [a, b] = await Promise.all([
			runSingleFlight(owner, "key-a", () => execute("a")),
			runSingleFlight(owner, "key-b", () => execute("b")),
		])

		expect(execute).toHaveBeenCalledTimes(2)
		expect(a).toEqual({ value: "a", leader: true })
		expect(b).toEqual({ value: "b", leader: true })
	})

	it("propagates the leader's rejection to every waiter", async () => {
		const owner = {}
		const failure = new Error("search exploded")
		const execute = vi.fn(async () => {
			await deferred(null, 5)
			throw failure
		})

		const results = await Promise.allSettled(
			Array.from({ length: 4 }, () => runSingleFlight(owner, "key", execute)),
		)

		expect(execute).toHaveBeenCalledTimes(1)
		for (const result of results) {
			expect(result.status).toBe("rejected")
			expect(result.status === "rejected" && result.reason).toBe(failure)
		}
	})

	it("cleans up after settle so the next identical call re-executes", async () => {
		const owner = {}
		const execute = vi.fn(async () => "fresh")

		await runSingleFlight(owner, "key", execute)
		await runSingleFlight(owner, "key", execute)

		expect(execute).toHaveBeenCalledTimes(2)
	})

	it("cleans up after a rejection so the next call retries", async () => {
		const owner = {}
		const failing = vi.fn(async () => {
			throw new Error("boom")
		})
		await expect(runSingleFlight(owner, "key", failing)).rejects.toThrow("boom")

		const succeeding = vi.fn(async () => 42)
		const outcome = await runSingleFlight(owner, "key", succeeding)
		expect(outcome).toEqual({ value: 42, leader: true })
		expect(succeeding).toHaveBeenCalledTimes(1)
	})

	it("scopes flights per owner (same key on different owners does not coalesce)", async () => {
		const execute = vi.fn(async () => {
			await deferred(null, 5)
			return "v"
		})

		await Promise.all([
			runSingleFlight({}, "key", execute),
			runSingleFlight({}, "key", execute),
		])

		expect(execute).toHaveBeenCalledTimes(2)
	})
})
