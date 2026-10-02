import type { Collection, Db, Document, UpdateResult } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn(async () => null),
		findOneAndUpdate: vi.fn(async () => ({ status: "running" })),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		})),
		updateMany: vi.fn(async () => ({ modifiedCount: 0 }) as UpdateResult),
		updateOne: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		insertOne: vi.fn(async () => ({ insertedId: "test" })),
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		...overrides,
	} as unknown as Collection
}

function mockDb(collectionMap: Record<string, Collection> = {}): Db {
	const gate: Document = { agentId: "", epoch: 0, state: "open", serial: 0 }
	const meta = mockCollection({
		findOneAndUpdate: vi.fn(
			async (
				_filter: unknown,
				update: { $setOnInsert: { agentId: string } },
			) => {
				gate.agentId = update.$setOnInsert.agentId
				return { ...gate }
			},
		),
		findOne: vi.fn(async () => ({ ...gate })),
		updateOne: vi.fn(async () => {
			gate.serial += 1
			return { matchedCount: 1, modifiedCount: 1 }
		}),
	})
	const session = {
		inTransaction: () => false,
		withTransaction: async (fn: () => Promise<unknown>) => fn(),
		endSession: async () => {},
	}
	return {
		client: { startSession: () => session },
		collection: vi.fn((name: string) =>
			name === "test_meta" ? meta : (collectionMap[name] ?? mockCollection()),
		),
	} as unknown as Db
}

// ---------------------------------------------------------------------------
// Module-level mocks for dependencies
// ---------------------------------------------------------------------------

vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))

vi.mock("./mongodb-novelty.js", () => ({
	scanNovelty: vi.fn(async () => ({
		events: [],
		scannedCount: 0,
		agentId: "test-agent",
	})),
}))

vi.mock("./mongodb-reasoning-chain.js", () => ({
	traceReasoningChain: vi.fn(async () => ({
		factId: "",
		collection: "events",
		nodes: [],
		chainComplete: true,
		maxDepthReached: false,
		agentId: "test-agent",
	})),
}))

vi.mock("./mongodb-structured-memory.js", () => ({
	writeStructuredMemory: vi.fn(async () => ({
		upserted: true,
		id: "test-id",
	})),
}))

vi.mock("./mongodb-graph.js", () => ({
	extractAndUpsertEntities: vi.fn(async () => ({
		entities: [],
		relationsCreated: 0,
	})),
}))

const { resolveEnrichmentProviderMock } = vi.hoisted(() => ({
	resolveEnrichmentProviderMock: vi.fn<() => unknown>(() => null),
}))

vi.mock("./mongodb-llm-enrichment.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-llm-enrichment.js")
	>("./mongodb-llm-enrichment.js")
	return { ...actual, resolveEnrichmentProvider: resolveEnrichmentProviderMock }
})

const { resolveConflictedCandidateMock, adjudicateFactMergeMock } = vi.hoisted(
	() => ({
		resolveConflictedCandidateMock: vi.fn(async () => ({
			resolved: false,
			invalidatedCount: 0,
		})),
		adjudicateFactMergeMock: vi.fn(async () => ({ verdict: "NO_MERGE" })),
	}),
)

vi.mock("./mongodb-consolidation-adjudication.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-consolidation-adjudication.js")
	>("./mongodb-consolidation-adjudication.js")
	return {
		...actual,
		resolveConflictedCandidate: resolveConflictedCandidateMock,
		adjudicateFactMerge: adjudicateFactMergeMock,
	}
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("markEventsDreamerProcessed", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("marks events with dreamerProcessedAt and runId", async () => {
		const { markEventsDreamerProcessed } = await import(
			"./mongodb-consolidator.js"
		)
		const eventsCol = mockCollection({
			updateMany: vi.fn(async () => ({ modifiedCount: 3 }) as UpdateResult),
		})
		const db = mockDb({ test_events: eventsCol })

		const count = await markEventsDreamerProcessed({
			db,
			prefix: "test_",
			eventIds: ["e1", "e2", "e3"],
			runId: "run-abc",
		})

		expect(count).toBe(3)
		expect(eventsCol.updateMany).toHaveBeenCalledWith(
			{ eventId: { $in: ["e1", "e2", "e3"] } },
			{
				$set: expect.objectContaining({
					dreamerRunId: "run-abc",
				}),
			},
		)
	})

	it("returns 0 for empty eventIds", async () => {
		const { markEventsDreamerProcessed } = await import(
			"./mongodb-consolidator.js"
		)
		const db = mockDb()

		const count = await markEventsDreamerProcessed({
			db,
			prefix: "test_",
			eventIds: [],
			runId: "run-abc",
		})

		expect(count).toBe(0)
	})
})

describe("consolidateMemory LLM seam gating (B1)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolves the enrichment provider for the reasoning seam by default", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		resolveEnrichmentProviderMock.mockReturnValueOnce({
			name: "mock-provider",
			chatCompletion: vi.fn(async () => ({ content: "{}" })),
		})

		const result = await consolidateMemory({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(resolveEnrichmentProviderMock).toHaveBeenCalledTimes(1)
		expect(result.eventsProcessed).toBe(0)
	})

	it("makes zero provider resolution calls when MEMONGO_EXTRACTION_LLM=off (B1)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		// Full enrichment env: without the gate the seam would resolve the
		// provider, so this proves the gate (not missing config) holds.
		resolveEnrichmentProviderMock.mockReturnValue({
			name: "mock-provider",
			chatCompletion: vi.fn(async () => ({ content: "{}" })),
		})
		vi.stubEnv("MEMONGO_EXTRACTION_LLM", "off")
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "test-key")
		vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "https://enrichment.example")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "test-model")
		try {
			const result = await consolidateMemory({
				db: mockDb(),
				prefix: "test_",
				agentId: "agent-1",
			})

			expect(resolveEnrichmentProviderMock).not.toHaveBeenCalled()
			expect(result.eventsProcessed).toBe(0)
		} finally {
			vi.unstubAllEnvs()
			resolveEnrichmentProviderMock.mockReturnValue(null)
		}
	})
})
