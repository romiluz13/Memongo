import { describe, expect, it } from "vitest"
import {
	evaluateAnswererArtifact,
	parseArgs,
} from "./check-memory-benchmarks-answerer-artifact.js"

function makeArtifact(generatedAnswer: string) {
	return {
		metadata: { mode: "answerer" },
		evaluations: [
			{
				question_id: "q1",
				question_type: "multi-session",
				is_abstention: false,
				retrieval: {
					search_results: [{ memory: "evidence", score: 1 }],
				},
				cutoff_results: {
					top_50: {
						generated_answer: generatedAnswer,
						judge_raw: "yes",
					},
				},
			},
		],
	}
}

describe("evaluateAnswererArtifact", () => {
	it("passes non-empty non-abstention answerer artifacts", () => {
		const status = evaluateAnswererArtifact(makeArtifact("4 times"), "artifact.json")

		expect(status.ok).toBe(true)
		expect(status.failures).toEqual([])
		expect(status.cutoffsChecked).toEqual(["top_50"])
	})

	it("fails empty generated answers for non-abstention questions", () => {
		const status = evaluateAnswererArtifact(makeArtifact("  "), "artifact.json")

		expect(status.ok).toBe(false)
		expect(status.failures.join("\n")).toContain("generated_answer is empty")
	})

	it("fails empty retrieval for non-abstention questions", () => {
		const artifact = makeArtifact("4 times")
		artifact.evaluations[0].retrieval.search_results = []

		const status = evaluateAnswererArtifact(artifact, "artifact.json")

		expect(status.ok).toBe(false)
		expect(status.failures.join("\n")).toContain("retrieval.search_results empty")
	})
})

describe("parseArgs", () => {
	it("parses artifact path, cutoff, and json flag", () => {
		const parsed = parseArgs(["result.json", "--cutoff=top_50", "--json"])

		expect(parsed.artifactPath).toBe("result.json")
		expect(parsed.options.cutoff).toBe("top_50")
		expect(parsed.json).toBe(true)
	})
})
