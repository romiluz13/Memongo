/**
 *  bi-temporal validity invariant tests ( scope expansion).
 *
 * fast-check seed: 20260512.
 */

import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { buildBitemporalFilter, isMemoryValidAt } from "./mongodb-bitemporal.js"

const FAST_CHECK_SEED = 20260512

describe("buildBitemporalFilter ()", () => {
	it("builds a two-clause $and enforcing validAt/invalidAt at queryTime", () => {
		const t = new Date("2026-05-12T10:00:00.000Z")
		const filter = buildBitemporalFilter(t)
		expect(filter).toEqual({
			$and: [
				{
					$or: [{ validAt: { $exists: false } }, { validAt: { $lte: t } }],
				},
				{
					$or: [
						{ invalidAt: { $exists: false } },
						{ invalidAt: null },
						{ invalidAt: { $gt: t } },
					],
				},
			],
		})
	})

	it("rejects invalid queryTime", () => {
		expect(() => buildBitemporalFilter(new Date("invalid"))).toThrow(
			/queryTime/,
		)
		// Non-Date values are a TypeScript error but also a runtime error.
		expect(() =>
			buildBitemporalFilter("2026-05-12" as unknown as Date),
		).toThrow(/queryTime/)
	})
})

describe("isMemoryValidAt ()", () => {
	const T = new Date("2026-05-12T10:00:00.000Z")

	it("accepts legacy memories without validAt", () => {
		expect(isMemoryValidAt({}, T)).toBe(true)
	})

	it("rejects memories whose invalidAt precedes or equals queryTime", () => {
		expect(
			isMemoryValidAt({ invalidAt: new Date("2026-05-11T23:59:59.000Z") }, T),
		).toBe(false)
		expect(isMemoryValidAt({ invalidAt: T }, T)).toBe(false)
	})

	it("accepts memories whose invalidAt is strictly after queryTime", () => {
		expect(
			isMemoryValidAt({ invalidAt: new Date("2026-05-12T10:00:00.001Z") }, T),
		).toBe(true)
	})

	it("rejects memories with validAt in the future", () => {
		expect(
			isMemoryValidAt({ validAt: new Date("2026-05-12T10:00:00.001Z") }, T),
		).toBe(false)
	})
})

describe("bi-temporal validity invariant (property test — fast-check)", () => {
	it("Property 11 (): no retrieval returns a memory where invalidAt <= queryTime", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						validAtMs: fc.option(
							fc.integer({ min: 0, max: 2_000_000_000_000 }),
							{ nil: undefined },
						),
						invalidAtMs: fc.option(
							fc.integer({ min: 0, max: 2_000_000_000_000 }),
							{ nil: undefined },
						),
					}),
					{ minLength: 0, maxLength: 100 },
				),
				fc.integer({ min: 0, max: 2_000_000_000_000 }),
				(memoriesRaw, queryMs) => {
					const queryTime = new Date(queryMs)
					const memories = memoriesRaw.map((m) => ({
						...(m.validAtMs !== undefined
							? { validAt: new Date(m.validAtMs) }
							: {}),
						...(m.invalidAtMs !== undefined
							? { invalidAt: new Date(m.invalidAtMs) }
							: {}),
					}))
					const retained = memories.filter((m) => isMemoryValidAt(m, queryTime))
					// Invariant: no retained memory has invalidAt <= queryTime.
					for (const m of retained) {
						if (m.invalidAt instanceof Date) {
							expect(m.invalidAt.getTime()).toBeGreaterThan(queryTime.getTime())
						}
						if (m.validAt instanceof Date) {
							expect(m.validAt.getTime()).toBeLessThanOrEqual(
								queryTime.getTime(),
							)
						}
					}
				},
			),
			{ seed: FAST_CHECK_SEED, numRuns: 500 },
		)
	})

	it("Property 11 duality: filtered set ∪ rejected set === input set", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						validAtMs: fc.option(
							fc.integer({ min: 0, max: 2_000_000_000_000 }),
							{ nil: undefined },
						),
						invalidAtMs: fc.option(
							fc.integer({ min: 0, max: 2_000_000_000_000 }),
							{ nil: undefined },
						),
					}),
					{ minLength: 0, maxLength: 50 },
				),
				fc.integer({ min: 0, max: 2_000_000_000_000 }),
				(memoriesRaw, queryMs) => {
					const queryTime = new Date(queryMs)
					const memories = memoriesRaw.map((m, idx) => ({
						idx,
						...(m.validAtMs !== undefined
							? { validAt: new Date(m.validAtMs) }
							: {}),
						...(m.invalidAtMs !== undefined
							? { invalidAt: new Date(m.invalidAtMs) }
							: {}),
					}))
					const retained = new Set(
						memories
							.filter((m) => isMemoryValidAt(m, queryTime))
							.map((m) => m.idx),
					)
					const rejected = new Set(
						memories
							.filter((m) => !isMemoryValidAt(m, queryTime))
							.map((m) => m.idx),
					)
					// Partition: retained ∩ rejected = ∅, retained ∪ rejected = [0..N).
					for (const idx of retained) {
						expect(rejected.has(idx)).toBe(false)
					}
					expect(retained.size + rejected.size).toBe(memories.length)
				},
			),
			{ seed: FAST_CHECK_SEED, numRuns: 200 },
		)
	})
})
