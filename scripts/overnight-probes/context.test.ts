import { describe, expect, it } from "vitest"
import { asRecord } from "./context.ts"
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
