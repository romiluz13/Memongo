import type { Collection, Db, UpdateResult } from "mongodb"
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
	return {
		collection: vi.fn((name: string) => {
			return collectionMap[name] ?? mockCollection()
		}),
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
