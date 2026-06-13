import { describe, expect, it } from "vitest"
import {
	buildMemoryCapabilityReport,
	renderMemoryCapabilityMarkdown,
} from "./memory-capability-report.js"

describe("memory capability report", () => {
	it("computes competitor deltas and capability blockers from saved artifacts", () => {
		const artifact = {
			metadata: {
				run_id: "unit-run",
			},
			metrics_by_cutoff: {
				top_50: {
					overall: {
						total: 100,
						correct: 88,
						accuracy: 88,
					},
				},
				top_200: {
					overall: {
						total: 100,
						correct: 90,
						accuracy: 90,
					},
				},
			},
			evaluations: [
				{
					retrieval: {
						search_results: [],
					},
				},
				{
					retrieval: {
						search_results: [{ memory: "source-backed result" }],
					},
				},
			],
		}
		const missAnalysis = {
			summary: {
				byCategory: {
					"retrieval-missing-evidence": 4,
					"stale-or-conflicting-evidence": 5,
					"count-aggregation-failure": 2,
					"answerer-ignored-present-evidence": 1,
					"context-distracted-by-extra-evidence": 0,
					"judge-or-answer-format-ambiguity": 1,
					"preference-evidence-missing-or-buried": 0,
				},
				byQuestionType: {
					"multi-session": {
						misses: 6,
					},
					"temporal-reasoning": {
						misses: 3,
					},
					"single-session-assistant": {
						misses: 1,
					},
				},
			},
		}

		const report = buildMemoryCapabilityReport(
			artifact,
			missAnalysis,
			"result.json",
			"misses.json",
			"2026-06-10T00:00:00.000Z",
		)

		expect(report.publicationStatus).toBe("blocked")
		expect(report.emptyRetrievals).toBe(1)
		expect(
			report.cutoffs
				.find((cutoff) => cutoff.cutoff === "top_50")
				?.targets.find((target) => target.label === "Mem0 committed platform")
				?.casesToBeat,
		).toBe(3)
		expect(
			report.cutoffs
				.find((cutoff) => cutoff.cutoff === "top_200")
				?.targets.find((target) => target.label === "Mem0 committed platform")
				?.casesToBeat,
		).toBe(4)
		expect(report.capabilities.map((capability) => capability.id)).toContain(
			"retrieval-coverage",
		)
		expect(report.capabilities.map((capability) => capability.id)).toContain(
			"multi-session-current-state",
		)
		expect(report.capabilities.map((capability) => capability.id)).toContain(
			"count-current-state",
		)
		const retrievalCoverage = report.capabilities.find(
			(capability) => capability.id === "retrieval-coverage",
		)
		expect(retrievalCoverage?.fixtureId).toBe(
			"fixture-retrieval-coverage-zero-empty",
		)
		expect(retrievalCoverage?.mongoCapabilities.join("\n")).toContain(
			"Vector Search",
		)
		expect(retrievalCoverage?.stopCondition).toContain("Stop")
		expect(report.redFlags.join("\n")).toContain("empty retrievals")
	})

	it("renders a markdown gate without question-id instructions", () => {
		const report = buildMemoryCapabilityReport(
			{
				metadata: { run_id: "unit-run" },
				metrics_by_cutoff: {
					top_50: { overall: { total: 10, correct: 10, accuracy: 100 } },
				},
				evaluations: [{ retrieval: { search_results: [{}] } }],
			},
			{
				summary: {
					byCategory: {},
					byQuestionType: {},
				},
			},
			"result.json",
			"misses.json",
			"2026-06-10T00:00:00.000Z",
		)

		const markdown = renderMemoryCapabilityMarkdown(report)

		expect(markdown).toContain("# Memory Capability Report")
		expect(markdown).toContain("Mem0 committed platform")
		expect(markdown).toContain("Publication status")
		expect(markdown).toContain("Product Fixture Gates")
		expect(markdown).toContain("MongoDB Capabilities")
		expect(markdown).toContain("no question-id logic")
	})
})
