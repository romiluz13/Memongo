import { describe, expect, it } from "vitest"
import { exactMcNemar } from "./paired-inference.js"

describe("exactMcNemar (exact conditional binomial, two-sided)", () => {
	it("gives p = 0.03125 for six gains and no losses", () => {
		expect(exactMcNemar(6, 0)).toEqual({
			gains: 6,
			losses: 0,
			discordant: 6,
			pTwoSided: 0.03125,
		})
		expect(exactMcNemar(0, 6).pTwoSided).toBe(0.03125)
	})

	it("matches analytic tail sums at the significance boundary", () => {
		expect(exactMcNemar(5, 0).pTwoSided).toBe(0.0625)
		expect(exactMcNemar(3, 0).pTwoSided).toBe(0.25)
		// 2 * sum_{i<=7} C(17, i) / 2^17 = 82452 / 131072
		expect(exactMcNemar(10, 7).pTwoSided).toBe(82452 / 131072)
		expect(exactMcNemar(1, 0).pTwoSided).toBe(1)
	})

	it("caps at one with no discordant pairs or balanced discordance", () => {
		expect(exactMcNemar(0, 0).pTwoSided).toBe(1)
		expect(exactMcNemar(3000, 3000).pTwoSided).toBe(1)
	})

	it("stays exact far past double-precision binomial coefficients", () => {
		expect(exactMcNemar(1050, 0).pTwoSided).toBe(2 ** -1049)
		const p = exactMcNemar(560, 440).pTwoSided
		expect(p).toBeGreaterThan(0)
		expect(p).toBeLessThan(exactMcNemar(55, 44).pTwoSided)
	})

	it.each([
		[-1, 0],
		[1.5, 0],
		[Number.NaN, 0],
		[0, Number.POSITIVE_INFINITY],
		[Number.MAX_SAFE_INTEGER + 1, 0],
	])("rejects invalid counts %s/%s", (gains, losses) => {
		expect(() => exactMcNemar(gains, losses)).toThrow(RangeError)
	})
})
