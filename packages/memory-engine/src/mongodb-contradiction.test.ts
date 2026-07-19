import { describe, expect, it, vi } from "vitest"
import { detectContradictions } from "./mongodb-contradiction.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"

function providerReturning(content: string): EnrichmentProvider {
	return {
		name: "mock",
		chatCompletion: vi.fn(async () => ({ content })),
	}
}

const NEW_FACT = { key: "fact-london", value: "The user lives in London." }
const EXISTING = [
	{ key: "fact-berlin", value: "The user lives in Berlin." },
	{ key: "fact-dog", value: "The user has a dog." },
]

describe("detectContradictions", () => {
	it("returns the contradicted key with a rationale", async () => {
		const provider = providerReturning(
			JSON.stringify({
				contradictions: [
					{ key: "fact-berlin", rationale: "cannot live in two cities" },
				],
			}),
		)
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: EXISTING,
		})
		expect(result).toHaveLength(1)
		expect(result[0].contradictedKey).toBe("fact-berlin")
		expect(result[0].rationale).toBeTruthy()
	})

	it("returns [] when nothing is contradicted", async () => {
		const provider = providerReturning(JSON.stringify({ contradictions: [] }))
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: EXISTING,
		})
		expect(result).toEqual([])
	})

	it("drops hallucinated keys that are not among the existing facts", async () => {
		const provider = providerReturning(
			JSON.stringify({
				contradictions: [
					{ key: "fact-berlin", rationale: "real" },
					{ key: "fact-made-up", rationale: "hallucinated" },
				],
			}),
		)
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: EXISTING,
		})
		expect(result.map((r) => r.contradictedKey)).toEqual(["fact-berlin"])
	})

	it("never contradicts the new fact against itself", async () => {
		const provider = providerReturning(
			JSON.stringify({
				contradictions: [{ key: "fact-london", rationale: "self" }],
			}),
		)
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: [...EXISTING, NEW_FACT],
		})
		expect(result.map((r) => r.contradictedKey)).not.toContain("fact-london")
	})

	it("does not call the LLM when there are no existing facts", async () => {
		const provider = providerReturning(JSON.stringify({ contradictions: [] }))
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: [],
		})
		expect(result).toEqual([])
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})

	it("degrades to [] when the LLM call throws", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => {
				throw new Error("network down")
			}),
		}
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: EXISTING,
		})
		expect(result).toEqual([])
	})

	it("degrades to [] on unparseable JSON", async () => {
		const provider = providerReturning("not json")
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: EXISTING,
		})
		expect(result).toEqual([])
	})

	it("deduplicates repeated keys", async () => {
		const provider = providerReturning(
			JSON.stringify({
				contradictions: [
					{ key: "fact-berlin", rationale: "a" },
					{ key: "fact-berlin", rationale: "b" },
				],
			}),
		)
		const result = await detectContradictions({
			provider,
			model: "m",
			newFact: NEW_FACT,
			existingFacts: EXISTING,
		})
		expect(result).toHaveLength(1)
	})
})
