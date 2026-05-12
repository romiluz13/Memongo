import fc from "fast-check"
import { expect, test } from "vitest"

test("fast-check is importable and runnable", () => {
	fc.assert(
		fc.property(fc.integer(), (n) => n + 0 === n),
		{ numRuns: 10 },
	)
	expect(true).toBe(true)
})
