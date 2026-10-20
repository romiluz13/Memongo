import { describe, expect, it } from "vitest"
import { extractTemporalWindow } from "../../packages/memory-engine/src/mongodb-retrieval-planner.ts"
import { D_AS_OF } from "./probe-d-fixture.ts"
import {
	D_RELATIVE,
	D_RELATIVE_BASE_QUERY,
	D_RELATIVE_UNSUPPORTED,
} from "./probe-d-relative.ts"

describe("D relative-phrase oracle against the engine's own extractor", () => {
	const asOf = new Date(D_AS_OF)

	it("finds no temporal token in the filler query alone", () => {
		expect(extractTemporalWindow(D_RELATIVE_BASE_QUERY, asOf)).toBeNull()
	})

	it("resolves each supported phrase to the hand-derived origin and scale", () => {
		for (const item of D_RELATIVE) {
			const window = extractTemporalWindow(
				`${D_RELATIVE_BASE_QUERY} ${item.phrase}`,
				asOf,
			)
			expect(window?.origin.toISOString(), item.id).toBe(item.origin)
			expect(window?.scaleDays, item.id).toBe(item.scaleDays)
		}
	})

	it("does not resolve any family that is declared a gap", () => {
		for (const gap of D_RELATIVE_UNSUPPORTED) {
			expect(
				extractTemporalWindow(`${D_RELATIVE_BASE_QUERY} ${gap.example}`, asOf),
				gap.id,
			).toBeNull()
		}
	})
})
