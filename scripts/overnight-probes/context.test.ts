import { describe, expect, it } from "vitest"
import { API_WRITE, asRecord, countedObserve } from "./context.ts"
import { createFakeContext, httpError } from "./fake-api.ts"
import { isRecord } from "./rows.ts"

describe("asRecord", () => {
	it("returns a plain object unchanged", () => {
		const value = { a: 1 }
		expect(asRecord(value)).toBe(value)
	})

	it("returns undefined for arrays, null, primitives and undefined", () => {
		for (const value of [[], [1], null, "text", 4, true, undefined]) {
			expect(asRecord(value)).toBeUndefined()
		}
	})

	it("agrees with the shared isRecord guard on every kind of value", () => {
		for (const value of [{}, [], null, "x", 0, undefined, new Date()]) {
			expect(asRecord(value) !== undefined).toBe(isRecord(value))
		}
	})
})

describe("countedObserve", () => {
	it("records the message and elapsed time of a transport error", async () => {
		const ctx = createFakeContext({})
		const observation = await countedObserve(
			ctx,
			API_WRITE,
			"writeEvent",
			async () => {
				ctx.clock.advance(30_000)
				throw new DOMException("The operation timed out.", "TimeoutError")
			},
		)
		expect(observation.kind).toBe("transport-error")
		expect(ctx.evidence.records).toEqual([
			{
				kind: "transport-error",
				payload: {
					run: 1,
					route: "writeEvent",
					errorName: "TimeoutError",
					message: "The operation timed out.",
					elapsedMs: 30_000,
				},
			},
		])
	})

	it("records nothing for a response or an HTTP error", async () => {
		const ctx = createFakeContext({})
		await countedObserve(ctx, API_WRITE, "writeEvent", async () => ({
			ok: true,
		}))
		await countedObserve(ctx, API_WRITE, "writeEvent", async () => {
			throw httpError(503, "unavailable")
		})
		expect(ctx.evidence.records).toEqual([])
	})
})
