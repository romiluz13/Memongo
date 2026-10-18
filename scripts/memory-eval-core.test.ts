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
				title: "Current release-window recall prefers latest durable truth",
				kind: "search-detailed",
				request: {
					agentId: "memory-eval-primary",
					query: "What is the current Phoenix release window?",
				},
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
						startLine: 1,
						endLine: 1,
						score: 0.92,
						snippet: "Phoenix release window is Monday afternoon.",
						source: "structured",
						trust: {
							score: 0.92,
							confidence: "high",
							exactness: "exact-id",
							freshness: "fresh",
							contradiction: "none",
							scopeMatch: "exact",
							provenance: "dense",
							sourceDiversity: "single",
							factors: [],
						},
					},
				],
				metadata: {
					mode: "agentic",
					classification: "factoid",
					sourceOrder: ["structured"],
					passes: [],
					queriesTried: [],
					constraintsApplied: [],
					resultsRejected: [],
					evidenceCoverage: "direct",
					pathsExecuted: [],
					resultsByPath: {},
					queryRewritten: false,
					reranked: false,
					trustSummary: {
						topScore: 0.92,
						topConfidence: "high",
						averageScore: 0.92,
						distribution: { high: 1, medium: 0, low: 0 },
						contradictionCount: 0,
						staleCount: 0,
						exactCount: 1,
						sourceDiversity: "single",
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
				title: "Unknown foreign-agent fact abstains instead of leaking",
				kind: "search-detailed",
				request: {
					agentId: "memory-eval-primary",
					query: "What is the Red Kite launch codeword?",
				},
				expect: {
					expectNoResults: true,
					requireNoDirectEvidenceReason: true,
				},
			},
			{
				results: [
					{
						path: "events/foreign",
						startLine: 1,
						endLine: 1,
						score: 0.31,
						snippet: "The launch codeword is Red Kite.",
						source: "conversation",
						trust: {
							score: 0.31,
							confidence: "low",
							exactness: "approximate",
							freshness: "unknown",
							contradiction: "none",
							scopeMatch: "mismatch",
							provenance: "sparse",
							sourceDiversity: "single",
							factors: [],
						},
					},
				],
				metadata: {
					mode: "direct",
					classification: "factoid",
					sourceOrder: ["conversation"],
					passes: [],
					queriesTried: [],
					constraintsApplied: [],
					resultsRejected: [],
					evidenceCoverage: "indirect",
					pathsExecuted: [],
					resultsByPath: {},
					queryRewritten: false,
					reranked: false,
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
