import { describe, expect, it } from "vitest"

import {
	compareEvalRuns,
	evaluateSearchDetailedCase,
	summarizeEvalRun,
} from "./memory-eval-core.js"

describe("memory-eval-core", () => {
	it("scores a current-state search case from content, evidence, and trust", () => {
		const result = evaluateSearchDetailedCase(
			{
				id: "current-release-window",
				kind: "search-detailed",
				request: {},
				expect: {
					mustIncludeAll: ["Monday"],
					mustExcludeAll: ["Friday"],
					pathPrefixesAny: ["structured:"],
					evidenceAtLeast: "partial",
					topConfidenceAtLeast: "medium",
				},
			},
			{
				results: [
					{
						path: "structured:decision:release-window",
						snippet: "Phoenix release window is Monday afternoon.",
						trust: {
							confidence: "high",
						},
					},
				],
				metadata: {
					evidenceCoverage: "direct",
					trustSummary: {
						distribution: { high: 1, medium: 0, low: 0 },
						topConfidence: "high",
						staleCount: 0,
						contradictionCount: 0,
					},
				},
			},
			42,
		)

		expect(result.ok).toBe(true)
		expect(result.score).toBe(1)
		expect(result.failures).toEqual([])
		expect(result.metrics.latencyMs).toBe(42)
	})

	it("treats missing evidence as a failed abstention/scope-leak case", () => {
		const result = evaluateSearchDetailedCase(
			{
				id: "no-scope-leak-red-kite",
				kind: "search-detailed",
				request: {},
				expect: {
					expectNoResults: true,
					requireNoDirectEvidenceReason: true,
				},
			},
			{
				results: [
					{
						path: "events/foreign",
						snippet: "The launch codeword is Red Kite.",
						trust: {
							confidence: "low",
						},
					},
				],
				metadata: {
					evidenceCoverage: "indirect",
				},
			},
			19,
		)

		expect(result.ok).toBe(false)
		expect(result.failures).toContain("expected no results")
	})

	it("compares baseline and candidate runs with release-gate metrics", () => {
		const baseline = summarizeEvalRun({
			label: "baseline",
			cases: [
				{
					id: "scope-leak",
					ok: false,
					score: 0,
					failures: ["expected no results"],
					metrics: {
						latencyMs: 120,
						scopeLeak: true,
						staleFailure: false,
						abstentionSuccess: false,
						evidenceCoverage: "none",
						topConfidence: null,
						exactEvidence: false,
					},
				},
				{
					id: "current-state",
					ok: true,
					score: 0.5,
					failures: [],
					metrics: {
						latencyMs: 100,
						scopeLeak: false,
						staleFailure: true,
						abstentionSuccess: false,
						evidenceCoverage: "partial",
						topConfidence: "medium",
						exactEvidence: false,
					},
				},
			],
		})
		const candidate = summarizeEvalRun({
			label: "candidate",
			cases: [
				{
					id: "scope-leak",
					ok: true,
					score: 1,
					failures: [],
					metrics: {
						latencyMs: 110,
						scopeLeak: false,
						staleFailure: false,
						abstentionSuccess: true,
						evidenceCoverage: "none",
						topConfidence: null,
						exactEvidence: false,
					},
				},
				{
					id: "current-state",
					ok: true,
					score: 1,
					failures: [],
					metrics: {
						latencyMs: 105,
						scopeLeak: false,
						staleFailure: false,
						abstentionSuccess: false,
						evidenceCoverage: "direct",
						topConfidence: "high",
						exactEvidence: true,
					},
				},
			],
		})

		const comparison = compareEvalRuns({ baseline, candidate })

		expect(comparison.summary.releaseReady).toBe(true)
		expect(comparison.summary.scoreDelta).toBeGreaterThan(0)
		expect(comparison.summary.scopeLeakDelta).toBeLessThan(0)
		expect(comparison.summary.staleFailureDelta).toBeLessThan(0)
		expect(comparison.summary.exactEvidenceDelta).toBeGreaterThan(0)
	})
})
