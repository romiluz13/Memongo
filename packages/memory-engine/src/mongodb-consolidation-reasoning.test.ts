import { describe, expect, it, vi } from "vitest"
import {
	buildInferredMemoryEntry,
	deduceFactsFromMemories,
	induceFactsFromMemories,
	type ReasonedFact,
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

describe("buildInferredMemoryEntry", () => {
	const reasoned: ReasonedFact = {
		value: "The deployment satisfies the US compliance requirement",
		rationale: "us-east-1 is a US region",
		sourceValues: facts,
		kind: "deduction",
	}

	it("flags the entry as an unreinforced LLM inference, distinct from observed facts", () => {
		const entry = buildInferredMemoryEntry({
			reasoned,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			runId: "run-1",
		})

		expect(entry.type).toBe("fact")
		expect(entry.value).toBe(reasoned.value)
		expect(entry.confidence).toBeLessThan(0.7)
		expect(entry.reinforcementCount).toBe(0)
		expect(entry.tags).toContain("inferred")
		expect(entry.tags).toContain("deduction")
		expect(entry.provenance?.origin).toBe("llm-inference")
		expect(entry.provenance?.derivedFrom).toEqual(facts)
		expect(entry.provenance?.rationale).toBe(reasoned.rationale)
		expect(entry.scope).toBe("agent")
		expect(entry.scopeRef).toBe("agent:agent-1")
	})

	it("derives a deterministic fact key from the value", () => {
		const a = buildInferredMemoryEntry({ reasoned, agentId: "agent-1" })
		const b = buildInferredMemoryEntry({ reasoned, agentId: "agent-1" })
		expect(a.key).toBe(b.key)
		expect(a.key).toMatch(/^fact-/)
	})

	it("omits scope fields when not provided", () => {
		const entry = buildInferredMemoryEntry({ reasoned, agentId: "agent-1" })
		expect(entry.scope).toBeUndefined()
		expect(entry.scopeRef).toBeUndefined()
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
