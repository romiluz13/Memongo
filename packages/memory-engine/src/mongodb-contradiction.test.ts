import { beforeEach, describe, expect, it, vi } from "vitest"
import { detectContradictions } from "./mongodb-contradiction.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"

const { invalidateByHandleMock, structuredMemCollectionMock } = vi.hoisted(
	() => ({
		invalidateByHandleMock: vi.fn(),
		structuredMemCollectionMock: vi.fn(),
	}),
)

vi.mock("./mongodb-schema.js", () => ({
	structuredMemCollection: structuredMemCollectionMock,
}))

vi.mock("./mongodb-structured-memory.js", () => ({
	invalidateStructuredMemoryByHandle: invalidateByHandleMock,
}))

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

beforeEach(() => {
	vi.clearAllMocks()
})

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

describe("invalidateContradictedFacts TTL guard (B1)", () => {
	it("excludes expired facts from the contradiction candidate set", async () => {
		const { invalidateContradictedFacts } = await import(
			"./mongodb-contradiction.js"
		)
		const findMock = vi
			.fn()
			.mockReturnValueOnce({ toArray: vi.fn(async () => []) })
			.mockReturnValueOnce({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => []),
					})),
				})),
			})
		structuredMemCollectionMock.mockReturnValue({
			find: findMock,
		} as unknown as import("mongodb").Collection)

		const count = await invalidateContradictedFacts({
			db: {} as import("mongodb").Db,
			prefix: "test_",
			provider: providerReturning(JSON.stringify({ contradictions: [] })),
			model: "m",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			newFacts: [NEW_FACT],
		})

		expect(count).toBe(0)
		expect(findMock).toHaveBeenCalled()
		expect(findMock.mock.calls[0]?.[0]).toMatchObject({
			$and: expect.arrayContaining([
				{
					$or: [
						{ expiresAt: { $exists: false } },
						{ expiresAt: { $gt: expect.any(Date) } },
					],
				},
			]),
		})
	})

	it("prepares contradiction decisions with pinned source and target revisions", async () => {
		const { prepareContradictionInvalidations } = await import(
			"./mongodb-contradiction.js"
		)
		const provider = providerReturning(
			JSON.stringify({
				contradictions: [
					{ key: "fact-berlin", rationale: "the residence changed" },
				],
			}),
		)
		const findMock = vi
			.fn()
			.mockReturnValueOnce({
				toArray: vi.fn(async () => [
					{ key: "fact-london", value: NEW_FACT.value, revision: 5 },
				]),
			})
			.mockReturnValueOnce({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								key: "fact-berlin",
								value: "The user lives in Berlin.",
								revision: 8,
							},
						]),
					})),
				})),
			})
		structuredMemCollectionMock.mockReturnValue({
			find: findMock,
		} as unknown as import("mongodb").Collection)

		await expect(
			prepareContradictionInvalidations({
				db: {} as import("mongodb").Db,
				prefix: "test_",
				provider,
				model: "m",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				newFacts: [NEW_FACT],
			}),
		).resolves.toEqual([
			{
				newFact: { ...NEW_FACT, revision: 5 },
				target: {
					key: "fact-berlin",
					value: "The user lives in Berlin.",
					revision: 8,
				},
				rationale: "the residence changed",
			},
		])
	})

	it("does not persist a prepared contradiction after either revision changes", async () => {
		const { persistPreparedContradictionInvalidations } = await import(
			"./mongodb-contradiction.js"
		)
		const session = {} as import("mongodb").ClientSession
		const findOne = vi
			.fn()
			.mockResolvedValueOnce({ key: "fact-london", revision: 5 })
			.mockResolvedValueOnce(null)
		structuredMemCollectionMock.mockReturnValue({
			findOne,
		} as unknown as import("mongodb").Collection)

		await expect(
			persistPreparedContradictionInvalidations({
				db: {} as import("mongodb").Db,
				prefix: "test_",
				session,
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				prepared: [
					{
						newFact: { ...NEW_FACT, revision: 5 },
						target: {
							key: "fact-berlin",
							value: "The user lives in Berlin.",
							revision: 8,
						},
						rationale: "the residence changed",
					},
				],
			}),
		).resolves.toBe(0)

		expect(findOne).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				key: "fact-berlin",
				value: "The user lives in Berlin.",
				revision: 8,
			}),
			{ session },
		)
		expect(invalidateByHandleMock).not.toHaveBeenCalled()
	})

	it("invalidates a prepared target when both pinned revisions still match", async () => {
		const { persistPreparedContradictionInvalidations } = await import(
			"./mongodb-contradiction.js"
		)
		const session = {} as import("mongodb").ClientSession
		structuredMemCollectionMock.mockReturnValue({
			findOne: vi
				.fn()
				.mockResolvedValueOnce({ key: "fact-london", revision: 5 })
				.mockResolvedValueOnce({ key: "fact-berlin", revision: 8 }),
		} as unknown as import("mongodb").Collection)
		invalidateByHandleMock.mockResolvedValue(true)

		await expect(
			persistPreparedContradictionInvalidations({
				db: {} as import("mongodb").Db,
				prefix: "test_",
				session,
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				runId: "evt-london",
				prepared: [
					{
						newFact: { ...NEW_FACT, revision: 5 },
						target: {
							key: "fact-berlin",
							value: "The user lives in Berlin.",
							revision: 8,
						},
						rationale: "the residence changed",
					},
				],
			}),
		).resolves.toBe(1)

		expect(invalidateByHandleMock).toHaveBeenCalledWith(
			expect.objectContaining({
				session,
				transactionalSideEffects: "inline",
				handle: expect.objectContaining({
					id: "fact-berlin",
					revision: 8,
					state: "active",
				}),
				invalidatedBy: expect.objectContaining({
					byKey: "fact-london",
					runId: "evt-london",
				}),
			}),
		)
	})
})
