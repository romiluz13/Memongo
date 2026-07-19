import { describe, expect, it, vi } from "vitest"
import {
	deduceFactsFromMemories,
	induceFactsFromMemories,
} from "./mongodb-consolidation-reasoning.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"

function mockProvider(content: string): EnrichmentProvider {
	return {
		name: "mock",
		chatCompletion: vi.fn(async () => ({ content })),
	}
}

const facts = [
	"The user deploys to AWS us-east-1",
	"The user's compliance region must be the United States",
]

describe("deduceFactsFromMemories", () => {
	it("returns entailed facts parsed from the LLM response", async () => {
		const provider = mockProvider(
			JSON.stringify({
				facts: [
					{
						value: "The deployment satisfies the US compliance requirement",
						rationale: "us-east-1 is a US region",
						from: [
							"The user deploys to AWS us-east-1",
							"The user's compliance region must be the United States",
						],
					},
				],
			}),
		)

		const result = await deduceFactsFromMemories({
			provider,
			model: "gpt-4o-mini",
			facts,
		})

		expect(result).toHaveLength(1)
		expect(result[0].kind).toBe("deduction")
		expect(result[0].value).toBe(
			"The deployment satisfies the US compliance requirement",
		)
		expect(result[0].rationale).toContain("US region")
		expect(result[0].sourceValues).toEqual(facts)
	})

	it("does not call the LLM when there are fewer than two facts", async () => {
		const provider = mockProvider("{}")
		const result = await deduceFactsFromMemories({
			provider,
			model: "gpt-4o-mini",
			facts: ["only one fact"],
		})
		expect(result).toEqual([])
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})

	it("degrades to an empty result when the LLM returns unparseable content", async () => {
		const provider = mockProvider("not json at all")
		const result = await deduceFactsFromMemories({
			provider,
			model: "gpt-4o-mini",
			facts,
		})
		expect(result).toEqual([])
	})

	it("skips entries with an empty value", async () => {
		const provider = mockProvider(
			JSON.stringify({
				facts: [
					{ value: "", rationale: "x", from: [] },
					{ value: "A real derived fact", rationale: "y", from: [] },
				],
			}),
		)
		const result = await deduceFactsFromMemories({
			provider,
			model: "gpt-4o-mini",
			facts,
		})
		expect(result).toHaveLength(1)
		expect(result[0].value).toBe("A real derived fact")
	})
})

describe("induceFactsFromMemories", () => {
	it("returns generalized facts tagged as induction", async () => {
		const provider = mockProvider(
			JSON.stringify({
				facts: [
					{
						value: "The user standardizes on US-based cloud infrastructure",
						rationale: "multiple US-region signals",
						from: facts,
					},
				],
			}),
		)

		const result = await induceFactsFromMemories({
			provider,
			model: "gpt-4o-mini",
			facts,
		})

		expect(result).toHaveLength(1)
		expect(result[0].kind).toBe("induction")
		expect(result[0].value).toContain("US-based cloud infrastructure")
	})
})
