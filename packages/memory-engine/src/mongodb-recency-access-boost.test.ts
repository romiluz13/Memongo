import { describe, expect, it } from "vitest"
import { applyRecencyAccessBoostAfterRerank } from "./mongodb-manager.js"
import type { MemorySearchResult } from "./types.js"

function makeResult(
	overrides: Partial<MemorySearchResult> & { path: string },
): MemorySearchResult {
	return {
		startLine: 0,
		endLine: 0,
		score: 1,
		snippet: `snippet for ${overrides.path}`,
		source: "conversation",
		...overrides,
	}
}

describe("applyRecencyAccessBoostAfterRerank", () => {
	it("ranks a recent result above a stale one at equal CE score", () => {
		const results = [
			makeResult({
				path: "stale",
				timestamp: new Date("2025-01-01T00:00:00Z"),
				accessCount: 3,
			}),
			makeResult({
				path: "recent",
				timestamp: new Date("2026-08-01T00:00:00Z"),
				accessCount: 3,
			}),
		]

		const boosted = applyRecencyAccessBoostAfterRerank(results)

		expect(boosted[0]?.path).toBe("recent")
		expect(boosted[1]?.path).toBe("stale")
		expect(boosted[0]!.score).toBeGreaterThan(boosted[1]!.score)
	})

	it("ranks a high-accessCount result above a zero-access one at equal CE score", () => {
		const ts = new Date("2026-01-01T00:00:00Z")
		const results = [
			makeResult({ path: "cold", timestamp: ts, accessCount: 0 }),
			makeResult({ path: "hot", timestamp: ts, accessCount: 12 }),
		]

		const boosted = applyRecencyAccessBoostAfterRerank(results)

		expect(boosted[0]?.path).toBe("hot")
		expect(boosted[1]?.path).toBe("cold")
		expect(boosted[0]!.score).toBeGreaterThan(boosted[1]!.score)
	})

	it("applies the combined multiplicative boost exactly", () => {
		// recencyNorm = 1 and accessNorm = 1 for the single top result:
		// score * (1 + 0.2 * 0.5) * (1 + 0.2 * 0.5) = 1 * 1.1 * 1.1
		const results = [
			makeResult({
				path: "top",
				score: 1,
				timestamp: new Date("2026-08-01T00:00:00Z"),
				accessCount: 10,
			}),
			makeResult({
				path: "bottom",
				score: 1,
				timestamp: new Date("2025-01-01T00:00:00Z"),
				accessCount: 0,
			}),
		]

		const boosted = applyRecencyAccessBoostAfterRerank(results)

		const top = boosted.find((result) => result.path === "top")
		const bottom = boosted.find((result) => result.path === "bottom")
		expect(top!.score).toBeCloseTo(1 * 1.1 * 1.1, 10)
		expect(bottom!.score).toBeCloseTo(1 * 0.9 * 0.9, 10)
	})

	it("is a bit-identical no-op when both weights are zero", () => {
		const results = [
			makeResult({
				path: "a",
				score: 0.83,
				timestamp: new Date("2026-08-01T00:00:00Z"),
				accessCount: 9,
			}),
			makeResult({
				path: "b",
				score: 0.41,
				timestamp: new Date("2025-01-01T00:00:00Z"),
				accessCount: 0,
			}),
		]

		const boosted = applyRecencyAccessBoostAfterRerank(results, {
			recencyBoost: 0,
			accessBoost: 0,
		})

		expect(boosted).toBe(results)
		expect(boosted.map((result) => result.score)).toEqual([0.83, 0.41])
	})

	it("gives a single-result set a neutral boost with no NaN", () => {
		const results = [
			makeResult({
				path: "only",
				score: 0.7,
				timestamp: new Date("2026-08-01T00:00:00Z"),
				accessCount: 5,
			}),
		]

		const boosted = applyRecencyAccessBoostAfterRerank(results)

		expect(boosted).toHaveLength(1)
		expect(boosted[0]!.score).toBe(0.7)
		expect(Number.isNaN(boosted[0]!.score)).toBe(false)
	})

	it("degrades to neutral when timestamp and accessCount are missing", () => {
		const results = [
			makeResult({ path: "a", score: 0.9 }),
			makeResult({ path: "b", score: 0.6 }),
		]

		const boosted = applyRecencyAccessBoostAfterRerank(results)

		expect(boosted.map((result) => result.path)).toEqual(["a", "b"])
		expect(boosted[0]!.score).toBe(0.9)
		expect(boosted[1]!.score).toBe(0.6)
	})

	it("honors custom weights from config", () => {
		// recencyNorm = 1 for the newer result with alpha = 0.5:
		// score * (1 + 0.5 * 0.5) = 1.25
		const results = [
			makeResult({
				path: "stale",
				score: 1,
				timestamp: new Date("2025-01-01T00:00:00Z"),
				accessCount: 1,
			}),
			makeResult({
				path: "recent",
				score: 1,
				timestamp: new Date("2026-08-01T00:00:00Z"),
				accessCount: 1,
			}),
		]

		const boosted = applyRecencyAccessBoostAfterRerank(results, {
			recencyBoost: 0.5,
			accessBoost: 0,
		})

		const recent = boosted.find((result) => result.path === "recent")
		expect(recent!.score).toBeCloseTo(1.25, 10)
	})
})
