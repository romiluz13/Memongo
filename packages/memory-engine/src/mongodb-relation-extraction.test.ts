import { describe, expect, it, vi } from "vitest"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { extractTypedRelations } from "./mongodb-relation-extraction.js"

function providerReturning(content: string): EnrichmentProvider {
	return { name: "mock", chatCompletion: vi.fn(async () => ({ content })) }
}

const ENTITIES = [
	{ entityId: "e-alice", name: "Alice" },
	{ entityId: "e-api", name: "the API service" },
	{ entityId: "e-mongo", name: "MongoDB" },
]

describe("extractTypedRelations", () => {
	it("extracts a typed edge between two provided entities", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{
						from: "e-alice",
						to: "e-api",
						type: "works_on",
						confidence: 0.9,
						rationale: "Alice builds the API",
					},
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "Alice works on the API service, which depends on MongoDB.",
			entities: ENTITIES,
		})
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			fromEntityId: "e-alice",
			toEntityId: "e-api",
			type: "works_on",
		})
		expect(result[0].confidence).toBeCloseTo(0.9)
	})

	it("drops relations referencing an entity id not in the provided set", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{
						from: "e-alice",
						to: "e-ghost",
						type: "depends_on",
						confidence: 0.8,
					},
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("drops 'owns' — it is not LLM-extractable (destructive write-side exclusivity)", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-alice", to: "e-api", type: "owns", confidence: 0.95 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("drops edges below the minimum confidence floor", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 0.2 },
					{ from: "e-alice", to: "e-api", type: "works_on", confidence: 0.8 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result.map((r) => r.type)).toEqual(["works_on"])
	})

	it("drops self-relations and the co-occurrence type mentioned_with", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-alice", to: "e-alice", type: "works_on", confidence: 1 },
					{
						from: "e-alice",
						to: "e-api",
						type: "mentioned_with",
						confidence: 1,
					},
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("drops an unknown relation type", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "loves", confidence: 0.7 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("clamps confidence into [0,1] and defaults when missing", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 5 },
					{ from: "e-mongo", to: "e-api", type: "related_to" },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		const depends = result.find((r) => r.type === "depends_on")
		expect(depends?.confidence).toBe(1)
		const related = result.find((r) => r.type === "related_to")
		expect(related?.confidence).toBeGreaterThan(0)
		expect(related?.confidence).toBeLessThanOrEqual(1)
	})

	it("does not call the LLM when fewer than two entities are present", async () => {
		const provider = providerReturning(JSON.stringify({ relations: [] }))
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: [{ entityId: "e-alice", name: "Alice" }],
		})
		expect(result).toEqual([])
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})

	it("degrades to [] when the LLM throws", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => {
				throw new Error("boom")
			}),
		}
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("degrades to [] on unparseable JSON", async () => {
		const provider = providerReturning("not json")
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("deduplicates identical (from,to,type) triples", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 0.9 },
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 0.7 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toHaveLength(1)
	})
})
