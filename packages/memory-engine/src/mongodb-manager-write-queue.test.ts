import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Db } from "mongodb"
import {
	WriteQueueFullError,
	enqueueBoundedWrite,
	resolveWriteQueueMaxDepth,
} from "./mongodb-manager-write.js"

// WS-11 change 4 (09-report R7/B5): the per-agent writeQueue used to be an
// unbounded promise chain — 10k concurrent writes created 10k pending
// closures with no cap, no rejection, no signal. These tests pin the bound:
// depth cap enforced with a typed fast-fail, depth draining on settle, and
// serial ordering preserved underneath the cap.

type FakeHost = {
	db: Db
	prefix: string
	agentId: string
	writeQueue: Promise<void>
	writeQueueDepth: number
}

function makeHost(): FakeHost {
	return {
		db: {} as Db,
		prefix: "test_",
		agentId: "agent-a",
		writeQueue: Promise.resolve(),
		writeQueueDepth: 0,
	}
}

const TELEMETRY_ENV = "MEMONGO_TELEMETRY_ENABLED"
const MAX_DEPTH_ENV = "MEMONGO_WRITE_QUEUE_MAX_DEPTH"

describe("resolveWriteQueueMaxDepth", () => {
	const original = process.env[MAX_DEPTH_ENV]

	afterEach(() => {
		if (original === undefined) {
			delete process.env[MAX_DEPTH_ENV]
		} else {
			process.env[MAX_DEPTH_ENV] = original
		}
	})

	it("defaults to 256 pending writes per agent", () => {
		expect(resolveWriteQueueMaxDepth({})).toBe(256)
	})

	it("honors a positive override and rejects invalid values", () => {
		expect(
			resolveWriteQueueMaxDepth({ MEMONGO_WRITE_QUEUE_MAX_DEPTH: "8" }),
		).toBe(8)
		expect(
			resolveWriteQueueMaxDepth({ MEMONGO_WRITE_QUEUE_MAX_DEPTH: "0" }),
		).toBe(256)
		expect(
			resolveWriteQueueMaxDepth({ MEMONGO_WRITE_QUEUE_MAX_DEPTH: "banana" }),
		).toBe(256)
	})
})

describe("enqueueBoundedWrite (depth cap + fast-fail)", () => {
	const originalTelemetry = process.env[TELEMETRY_ENV]
	const originalMaxDepth = process.env[MAX_DEPTH_ENV]

	beforeEach(() => {
		// Fast-fail emits a saturation telemetry doc; keep the fake db untouched.
		process.env[TELEMETRY_ENV] = "false"
		process.env[MAX_DEPTH_ENV] = "4"
	})

	afterEach(() => {
		if (originalTelemetry === undefined) {
			delete process.env[TELEMETRY_ENV]
		} else {
			process.env[TELEMETRY_ENV] = originalTelemetry
		}
		if (originalMaxDepth === undefined) {
			delete process.env[MAX_DEPTH_ENV]
		} else {
			process.env[MAX_DEPTH_ENV] = originalMaxDepth
		}
	})

	it("admits up to the cap and fast-fails the next write with a typed error", async () => {
		const host = makeHost()
		let releaseWrites: (() => void) | null = null
		const gate = new Promise<void>((resolve) => {
			releaseWrites = resolve
		})
		const admitted: Promise<string>[] = []
		for (let i = 0; i < 4; i++) {
			admitted.push(
				enqueueBoundedWrite(host, async () => {
					await gate
					return `write-${i}`
				}),
			)
		}
		expect(host.writeQueueDepth).toBe(4)
		expect(() => enqueueBoundedWrite(host, async () => "never")).toThrowError(
			WriteQueueFullError,
		)
		try {
			enqueueBoundedWrite(host, async () => "never")
		} catch (err) {
			expect(err).toBeInstanceOf(WriteQueueFullError)
			const typed = err as WriteQueueFullError
			expect(typed.code).toBe("WRITE_QUEUE_FULL")
			expect(typed.queueDepth).toBe(4)
			expect(typed.maxDepth).toBe(4)
			expect(typed.message).toContain("fast-failing")
		}
		releaseWrites?.()
		await Promise.all(admitted)
		expect(await admitted[0]).toBe("write-0")
	})

	it("depth drains back to zero as writes settle, re-admitting new writes", async () => {
		const host = makeHost()
		const first = enqueueBoundedWrite(host, async () => "a")
		expect(host.writeQueueDepth).toBe(1)
		await first
		expect(host.writeQueueDepth).toBe(0)
		// The cap is available again immediately after settle.
		const second = enqueueBoundedWrite(host, async () => "b")
		await second
		expect(host.writeQueueDepth).toBe(0)
	})

	it("a rejected write still drains its depth slot", async () => {
		const host = makeHost()
		const failing = enqueueBoundedWrite(host, async () => {
			throw new Error("db down")
		})
		await expect(failing).rejects.toThrow("db down")
		// The decrement rides the settle path, not the success path.
		await Promise.resolve()
		await Promise.resolve()
		expect(host.writeQueueDepth).toBe(0)
		// And the queue itself is still usable (the chain swallows the error).
		const next = enqueueBoundedWrite(host, async () => "ok")
		await expect(next).resolves.toBe("ok")
	})

	it("preserves strict serial ordering under the cap (queue semantics unchanged)", async () => {
		const host = makeHost()
		const seen: string[] = []
		const writes = Array.from({ length: 4 }, (_, i) =>
			enqueueBoundedWrite(host, async () => {
				// Every write observes the ones before it already recorded.
				seen.push(`w${i}`)
				return `w${i}`
			}),
		)
		await Promise.all(writes)
		expect(seen).toEqual(["w0", "w1", "w2", "w3"])
	})

	it("the failed-write chain does not poison the next write (execute runs on both settle paths)", async () => {
		const host = makeHost()
		const failing = enqueueBoundedWrite(host, async () => {
			throw new Error("first fails")
		})
		await expect(failing).rejects.toThrow("first fails")
		const following = enqueueBoundedWrite(host, async () => "still runs")
		await expect(following).resolves.toBe("still runs")
	})
})
