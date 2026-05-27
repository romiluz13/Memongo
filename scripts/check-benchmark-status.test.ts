import { describe, expect, it } from "vitest"
import { evaluateBenchmarkStatus, parseArgs } from "./check-benchmark-status.js"

function makeArtifact(overrides: Record<string, unknown> = {}) {
	return {
		runId: "canary-test",
		benchmarkResponse: {
			questionTypeBreakdown: [
				{
					questionType: "single-session-preference",
					cases: 8,
					rAt5: 0.8,
				},
			],
			missLedger: [],
			caseDiagnostics: [],
			benchmarkReport: {
				build: { source: "env", commitSha: "abc123" },
				corpus: { cases: 48, scoredCases: 48 },
				metrics: {
					internal: {
						rAt5: 0.86,
						rAt10: 0.91,
						emptyRate: 0,
						hitRate: 0.9,
						avgTopScore: 0.7,
						p95LatencyMs: 1000,
					},
					official: {
						longMemEval: {
							session: { recallAnyAt5: 0.91 },
						},
					},
				},
				warnings: [],
				degradations: [],
				runIdentity: { datasetSha256: "a".repeat(64), retrievalUnit: "turn" },
				embedding: {
					model: "voyage-4-large",
					dimensions: 1024,
					quantization: "float32",
				},
				reranker: { model: "rerank-2.5", version: null, stage: "post-fusion" },
				storage: { collectionBytes: 1, indexBytes: 1 },
				latency: { p50Ms: 100, p95Ms: 1000 },
				cost: { embeddingCalls: 1, rerankCalls: 1, llmEnrichmentCalls: 0 },
			},
		},
		...overrides,
	}
}

describe("evaluateBenchmarkStatus", () => {
	it("passes a strict artifact with the publishable envelope and full-unlock metrics", () => {
		const status = evaluateBenchmarkStatus(makeArtifact())

		expect(status.ok).toBe(true)
		expect(status.fullUnlockOk).toBe(true)
		expect(status.failures).toEqual([])
	})

	it("fails started artifacts that never received a benchmark response", () => {
		const status = evaluateBenchmarkStatus({
			runId: "canary-started",
			status: "started",
			totalEvaluations: 48,
		})

		expect(status.ok).toBe(false)
		expect(status.failures.join("\n")).toContain("artifact status=started")
		expect(status.failures.join("\n")).toContain("benchmarkReport missing")
	})

	it("fails on warnings, degradations, partial scoring, and empty results", () => {
		const artifact = makeArtifact()
		const report = (artifact.benchmarkResponse as Record<string, unknown>)
			.benchmarkReport as Record<string, unknown>
		report.warnings = ["officialMetrics absent"]
		report.degradations = ["emptyRate=0.1000"]
		report.corpus = { cases: 48, scoredCases: 47 }
		report.metrics = {
			internal: { rAt5: 0.9, rAt10: 0.9, emptyRate: 0.1 },
			official: { longMemEval: { session: { recallAnyAt5: 0.95 } } },
		}

		const status = evaluateBenchmarkStatus(artifact)

		expect(status.ok).toBe(false)
		expect(status.failures.join("\n")).toContain("scoredCases=47/48")
		expect(status.failures.join("\n")).toContain("emptyRate=0.1000")
		expect(status.failures.join("\n")).toContain("warnings present")
		expect(status.failures.join("\n")).toContain("degradations present")
	})

	it("keeps diagnostic status separate from full-500 unlock status", () => {
		const artifact = makeArtifact()
		const report = (artifact.benchmarkResponse as Record<string, unknown>)
			.benchmarkReport as Record<string, unknown>
		report.metrics = {
			internal: { rAt5: 0.75, rAt10: 0.8, emptyRate: 0 },
			official: { longMemEval: { session: { recallAnyAt5: 0.8 } } },
		}

		const diagnostic = evaluateBenchmarkStatus(artifact)
		const fullUnlock = evaluateBenchmarkStatus(artifact, {
			requireFullUnlock: true,
		})

		expect(diagnostic.ok).toBe(true)
		expect(diagnostic.fullUnlockOk).toBe(false)
		expect(fullUnlock.ok).toBe(false)
		expect(fullUnlock.failures.join("\n")).toContain("internal R@5")
	})

	it("does not unlock full-500 from a 6-case smoke artifact", () => {
		const artifact = makeArtifact()
		const report = (artifact.benchmarkResponse as Record<string, unknown>)
			.benchmarkReport as Record<string, unknown>
		report.corpus = { cases: 6, scoredCases: 6 }

		const status = evaluateBenchmarkStatus(artifact)

		expect(status.ok).toBe(true)
		expect(status.fullUnlockOk).toBe(false)
		expect(status.notes.join("\n")).toContain("cases=6 < 48-case")
	})

	it("does not apply LongMemEval unlock gates to LoCoMo artifacts", () => {
		const artifact = makeArtifact()
		const response = artifact.benchmarkResponse as Record<string, unknown>
		const report = response.benchmarkReport as Record<string, unknown>
		report.corpus = { datasetKind: "locomo", cases: 10, scoredCases: 10 }
		report.metrics = {
			internal: { rAt5: 0.7, rAt10: 0.8, emptyRate: 0 },
			official: { loCoMo: { sessionEvidenceRecallAt5: 0.6 } },
		}
		response.questionTypeBreakdown = []

		const status = evaluateBenchmarkStatus(artifact, {
			requireFullUnlock: true,
		})

		expect(status.ok).toBe(true)
		expect(status.fullUnlockOk).toBe(true)
		expect(status.sessionRecallAnyAt5).toBe(0.6)
	})

	it("fails when the parity envelope or miss ledger is absent", () => {
		const artifact = makeArtifact()
		const response = artifact.benchmarkResponse as Record<string, unknown>
		const report = response.benchmarkReport as Record<string, unknown>
		delete response.missLedger
		delete report.embedding

		const status = evaluateBenchmarkStatus(artifact)

		expect(status.ok).toBe(false)
		expect(status.failures.join("\n")).toContain("missLedger missing")
		expect(status.failures.join("\n")).toContain(
			"publishable envelope missing: embedding",
		)
	})
})

describe("parseArgs", () => {
	it("accepts a positional artifact path after the bun -- separator", () => {
		const parsed = parseArgs([
			"artifacts/canary-runs/run/canary-artifact.json",
			"--allow-partial-envelope",
		])

		expect(parsed.artifactPath).toBe(
			"artifacts/canary-runs/run/canary-artifact.json",
		)
		expect(parsed.options.requirePublishableEnvelope).toBe(false)
	})

	it("keeps --artifact as the explicit artifact override", () => {
		const parsed = parseArgs([
			"ignored-positional.json",
			"--artifact",
			"artifacts/canary-runs/run/benchmark-response.json",
		])

		expect(parsed.artifactPath).toBe(
			"artifacts/canary-runs/run/benchmark-response.json",
		)
	})
})
