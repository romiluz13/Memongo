import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { MemorySearchResult } from "./types.js"
import {
	annotateResultsWithTrust,
	computeImportanceDecay,
	computeResultTrust,
	rerankResultsByTrust,
	shouldAbstainForLowTrust,
	summarizeTrust,
} from "./mongodb-trust.js"

/**
 * Importance-decay safety: fast-check seed pinned to project default.
 * fast-check seed: 20260512.
 */
const FAST_CHECK_SEED = 20260512

function makeResult(
	overrides: Partial<MemorySearchResult> = {},
): MemorySearchResult {
	return {
		path: overrides.path ?? "events/e-1",
		startLine: overrides.startLine ?? 0,
		endLine: overrides.endLine ?? 0,
		score: overrides.score ?? 0.8,
		snippet: overrides.snippet ?? "test snippet",
		source: overrides.source ?? "conversation",
		...(overrides.canonicalId ? { canonicalId: overrides.canonicalId } : {}),
		...(overrides.timestamp ? { timestamp: overrides.timestamp } : {}),
		...(overrides.scope ? { scope: overrides.scope } : {}),
		...(overrides.scopeRef ? { scopeRef: overrides.scopeRef } : {}),
		...(overrides.state ? { state: overrides.state } : {}),
		...(overrides.provenance ? { provenance: overrides.provenance } : {}),
		...(overrides.sourceEventIds
			? { sourceEventIds: overrides.sourceEventIds }
			: {}),
		...(overrides.sourceReliability !== undefined
			? { sourceReliability: overrides.sourceReliability }
			: {}),
		...(overrides.reinforcementCount !== undefined
			? { reinforcementCount: overrides.reinforcementCount }
			: {}),
		...(overrides.validFrom ? { validFrom: overrides.validFrom } : {}),
		...(overrides.validTo ? { validTo: overrides.validTo } : {}),
		...(overrides.reviewAt ? { reviewAt: overrides.reviewAt } : {}),
		...(overrides.lastConfirmedAt
			? { lastConfirmedAt: overrides.lastConfirmedAt }
			: {}),
		...(overrides.confidence !== undefined
			? { confidence: overrides.confidence }
			: {}),
	}
}

describe("computeResultTrust", () => {
	it("assigns high trust to fresh exact results with strong provenance", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const trust = computeResultTrust(
			makeResult({
				canonicalId: "event:e-1",
				timestamp: new Date("2026-04-05T11:55:00.000Z"),
				scope: "agent",
				scopeRef: "agent:demo",
				sourceReliability: 0.95,
				reinforcementCount: 4,
				sourceEventIds: ["e-1", "e-0"],
				provenance: { sourceEventIds: ["e-1", "e-0"] },
			}),
			{
				now,
				scope: "agent",
				scopeRef: "agent:demo",
			},
		)

		expect(trust.confidence).toBe("high")
		expect(trust.freshness).toBe("fresh")
		expect(trust.contradiction).toBe("none")
		expect(trust.score).toBeGreaterThan(0.75)
	})

	it("penalizes invalidated results even when raw retrieval score is strong", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const trust = computeResultTrust(
			makeResult({
				path: "relation:a-b",
				score: 0.97,
				state: "invalidated",
				validTo: new Date("2026-04-04T15:00:00.000Z"),
				sourceReliability: 0.9,
				reinforcementCount: 3,
			}),
			{
				now,
				scope: "agent",
				scopeRef: "agent:demo",
			},
		)

		expect(trust.contradiction).toBe("invalidated")
		expect(trust.confidence).toBe("low")
		expect(trust.score).toBeLessThan(0.4)
	})
})

describe("rerankResultsByTrust", () => {
	it("demotes lower-trust results behind healthier evidence", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const invalidated = makeResult({
			canonicalId: "invalidated",
			score: 0.97,
			path: "relation:old-owner",
			state: "invalidated",
			validTo: new Date("2026-04-04T15:00:00.000Z"),
			sourceReliability: 0.95,
		})
		const stable = makeResult({
			canonicalId: "stable",
			score: 0.88,
			path: "events/e-stable",
			timestamp: new Date("2026-04-05T11:57:00.000Z"),
			sourceReliability: 0.9,
			reinforcementCount: 2,
			sourceEventIds: ["e-stable"],
		})

		const ranked = rerankResultsByTrust(
			annotateResultsWithTrust([invalidated, stable], {
				now,
				scope: "agent",
				scopeRef: "agent:demo",
			}),
		)

		expect(ranked[0]?.canonicalId).toBe("stable")
		expect(ranked[1]?.canonicalId).toBe("invalidated")
	})
})

describe("summarizeTrust", () => {
	it("reports confidence distribution and contradiction counts", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const results = annotateResultsWithTrust(
			[
				makeResult({
					canonicalId: "high",
					timestamp: new Date("2026-04-05T11:59:00.000Z"),
					sourceReliability: 0.95,
					sourceEventIds: ["e-1", "e-2"],
				}),
				makeResult({
					canonicalId: "low",
					state: "invalidated",
					validTo: new Date("2026-04-01T00:00:00.000Z"),
				}),
			],
			{ now, scope: "agent", scopeRef: "agent:demo" },
		)

		const summary = summarizeTrust(results)
		expect(summary.distribution.high).toBe(1)
		expect(summary.distribution.low).toBe(1)
		expect(summary.contradictionCount).toBe(1)
		expect(summary.topConfidence).toBe("high")
	})
})

describe("computeImportanceDecay", () => {
	it("returns raw importance when no createdAt is provided", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		expect(computeImportanceDecay(0.8, undefined)).toBe(0.8)
	})

	it("returns 0.5 when importance is undefined", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		expect(computeImportanceDecay(undefined, undefined)).toBe(0.5)
	})

	it("applies half-life decay at 7 days", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		const now = new Date("2026-04-07T12:00:00.000Z")
		const sevenDaysAgo = new Date("2026-03-31T12:00:00.000Z")
		const result = computeImportanceDecay(1.0, sevenDaysAgo, now, 7)
		// At exactly 1 half-life, result should be ~0.5
		expect(result).toBeGreaterThan(0.475)
		expect(result).toBeLessThan(0.525)
	})

	it("decays to ~6.25% at 28 days with halfLife=7", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		const now = new Date("2026-04-07T12:00:00.000Z")
		const twentyEightDaysAgo = new Date("2026-03-10T12:00:00.000Z")
		const result = computeImportanceDecay(1.0, twentyEightDaysAgo, now, 7)
		// 4 half-lives: 0.5^4 = 0.0625
		expect(result).toBeGreaterThan(0.0625 * 0.95)
		expect(result).toBeLessThan(0.0625 * 1.05)
	})

	it("permanent scope returns raw importance regardless of age", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		const now = new Date("2026-04-07T12:00:00.000Z")
		const thirtyDaysAgo = new Date("2026-03-08T12:00:00.000Z")
		const result = computeImportanceDecay(
			1.0,
			thirtyDaysAgo,
			now,
			7,
			"permanent",
		)
		expect(result).toBe(1.0)
	})

	it("ongoing scope returns raw importance regardless of age", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		const now = new Date("2026-04-07T12:00:00.000Z")
		const thirtyDaysAgo = new Date("2026-03-08T12:00:00.000Z")
		const result = computeImportanceDecay(0.9, thirtyDaysAgo, now, 7, "ongoing")
		expect(result).toBe(0.9)
	})

	it("transient scope still decays normally", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		const now = new Date("2026-04-07T12:00:00.000Z")
		const sevenDaysAgo = new Date("2026-03-31T12:00:00.000Z")
		const result = computeImportanceDecay(
			1.0,
			sevenDaysAgo,
			now,
			7,
			"transient",
		)
		expect(result).toBeGreaterThan(0.475)
		expect(result).toBeLessThan(0.525)
	})

	it("undefined scope (backwards compat) still decays normally", async () => {
		const { computeImportanceDecay } = await import("./mongodb-trust.js")
		const now = new Date("2026-04-07T12:00:00.000Z")
		const sevenDaysAgo = new Date("2026-03-31T12:00:00.000Z")
		const result = computeImportanceDecay(1.0, sevenDaysAgo, now, 7, undefined)
		expect(result).toBeGreaterThan(0.475)
		expect(result).toBeLessThan(0.525)
	})
})

describe("confidence factor in trust scoring", () => {
	it("result with confidence=1.0 scores higher than identical result with confidence=0.4", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const base = {
			canonicalId: "event:e-1",
			timestamp: new Date("2026-04-05T11:55:00.000Z"),
			scope: "agent" as const,
			scopeRef: "agent:demo",
			sourceReliability: 0.9,
			reinforcementCount: 2,
			sourceEventIds: ["e-1"],
		}

		const highConf = computeResultTrust(
			makeResult({ ...base, confidence: 1.0 }),
			{ now, scope: "agent", scopeRef: "agent:demo" },
		)
		const lowConf = computeResultTrust(
			makeResult({ ...base, confidence: 0.4 }),
			{ now, scope: "agent", scopeRef: "agent:demo" },
		)

		expect(highConf.score).toBeGreaterThan(lowConf.score)
		expect(highConf.factors).toContain("confidence")
		expect(lowConf.factors).toContain("confidence")
	})

	it("result without confidence field scores the same as before (no confidence factor)", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const trust = computeResultTrust(
			makeResult({
				canonicalId: "event:e-1",
				timestamp: new Date("2026-04-05T11:55:00.000Z"),
				sourceEventIds: ["e-1"],
			}),
			{ now },
		)

		expect(trust.factors).not.toContain("confidence")
	})
})

describe("shouldAbstainForLowTrust", () => {
	it("abstains on direct queries when every surviving result is low trust", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const results = annotateResultsWithTrust(
			[
				makeResult({
					path: "",
					score: 0.81,
					state: "invalidated",
					validTo: new Date("2026-03-01T00:00:00.000Z"),
					sourceReliability: 0.3,
				}),
			],
			{ now, scope: "agent", scopeRef: "agent:demo" },
		)

		expect(
			shouldAbstainForLowTrust({
				results,
				classification: "direct",
				request: { query: "who owns billing-service" },
			}),
		).toContain("low-trust")
	})

	it("does not abstain when at least one medium-or-better result remains", () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		const results = annotateResultsWithTrust(
			[
				makeResult({
					canonicalId: "usable",
					score: 0.72,
					timestamp: new Date("2026-04-05T11:59:00.000Z"),
					sourceEventIds: ["e-usable"],
				}),
			],
			{ now, scope: "agent", scopeRef: "agent:demo" },
		)

		expect(
			shouldAbstainForLowTrust({
				results,
				classification: "direct",
				request: { query: "what happened today" },
			}),
		).toBeNull()
	})
})

// ===========================================================================
// Importance-decay safety: importance-decay fast-check property tests.
//
// The importance-decay evidence claims three properties at
// seed=20260512. These fast-check property tests defend those claims:
//
//   Property A (permanent never decays): for any temporalScope in
//     {"permanent", "ongoing"}, the decayed importance equals the clamped
//     base importance regardless of how much time has passed since createdAt.
//
//   Property B (range): for any valid non-permanent input, the result is in
//     the closed interval [0, 1]. The implementation clamps importance to
//     [0, 1] before applying exponential decay, so inputs > 1 get clamped to
//     1.0 first.
//
//   Property C (monotonic without access): for fixed baseImportance and no
//     access, the decay function is non-increasing as daysSinceCreation grows.
// ===========================================================================

describe("computeImportanceDecay fast-check properties (importance-decay safety)", () => {
	it("Property A: permanent/ongoing temporalScope never decays", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.integer({ min: 0, max: 365 * 10 }),
				fc.constantFrom("permanent" as const, "ongoing" as const),
				(importance, daysSinceCreate, temporalScope) => {
					const now = new Date("2026-05-12T00:00:00.000Z")
					const createdAt = new Date(
						now.getTime() - daysSinceCreate * 86_400_000,
					)
					const result = computeImportanceDecay(
						importance,
						createdAt,
						now,
						7,
						temporalScope,
					)
					// Result equals the clamp of the input (raw path).
					expect(result).toBe(Math.min(1, Math.max(0, importance)))
				},
			),
			{ seed: FAST_CHECK_SEED, numRuns: 500 },
		)
	})

	it("Property B: non-permanent results are always in [0, 1]", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -5, max: 5, noNaN: true }),
				fc.integer({ min: 0, max: 365 * 10 }),
				fc.double({ min: 0.1, max: 365, noNaN: true }),
				(importance, daysSinceCreate, halfLifeDays) => {
					const now = new Date("2026-05-12T00:00:00.000Z")
					const createdAt = new Date(
						now.getTime() - daysSinceCreate * 86_400_000,
					)
					const result = computeImportanceDecay(
						importance,
						createdAt,
						now,
						halfLifeDays,
					)
					expect(result).toBeGreaterThanOrEqual(0)
					expect(result).toBeLessThanOrEqual(1)
					expect(Number.isFinite(result)).toBe(true)
				},
			),
			{ seed: FAST_CHECK_SEED, numRuns: 500 },
		)
	})

	it("Property C: non-increasing as daysSinceCreate grows (no access)", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.integer({ min: 0, max: 365 }),
				fc.integer({ min: 1, max: 365 }),
				fc.double({ min: 0.5, max: 30, noNaN: true }),
				(importance, day0, dayDelta, halfLifeDays) => {
					const now = new Date("2026-05-12T00:00:00.000Z")
					const earlier = new Date(now.getTime() - day0 * 86_400_000)
					const later = new Date(now.getTime() - (day0 + dayDelta) * 86_400_000)
					const decayEarlier = computeImportanceDecay(
						importance,
						earlier,
						now,
						halfLifeDays,
					)
					const decayLater = computeImportanceDecay(
						importance,
						later,
						now,
						halfLifeDays,
					)
					// `later` is older (smaller timestamp) so its daysSinceCreation
					// is LARGER than `earlier`. Monotonicity: older => smaller decay.
					expect(decayLater).toBeLessThanOrEqual(decayEarlier + 1e-12)
				},
			),
			{ seed: FAST_CHECK_SEED, numRuns: 500 },
		)
	})
})
