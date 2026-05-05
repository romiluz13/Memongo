import type { Collection, Db, UpdateResult } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn(async () => null),
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

describe("consolidateMemory", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("rate-limits within minIntervalMs", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => ({
				agentId: "agent-1",
				status: "completed",
				startedAt: new Date(), // just now
			})),
		})
		const db = mockDb({ test_consolidation_runs: consolidationRunsCol })

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minIntervalMs: 3_600_000 },
		})

		expect(result.eventsProcessed).toBe(0)
		expect(result.factsPromoted).toBe(0)
	})

	it("returns empty result when no unprocessed events", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => []),
					})),
				})),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result.eventsProcessed).toBe(0)
	})

	it("extracts preference pattern", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "I prefer TypeScript over JavaScript",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.eventsProcessed).toBe(1)
		expect(result.factsPromoted).toBe(1)
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "preference",
				}),
			}),
		)
	})

	it("extracts decision pattern", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e2",
								agentId: "agent-1",
								body: "I decided to use Bun instead of Node",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.factsPromoted).toBe(1)
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "decision",
				}),
			}),
		)
	})

	it("skips events below minCombinedScore", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e-low",
								agentId: "agent-1",
								body: "I prefer dark mode",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0.99 },
		})

		// Event was processed but no facts promoted due to score filter
		expect(result.eventsProcessed).toBe(1)
		expect(result.factsPromoted).toBe(0)
	})

	it("skips promotion when conflict detected", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e-conflict",
								agentId: "agent-1",
								body: "I prefer Python over JavaScript",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		// Existing conflicting structured_mem entry
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => ({
				agentId: "agent-1",
				type: "preference",
				key: "Python over JavaScript",
				value: "I prefer Python over JavaScript",
				state: "conflicted",
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		// Events processed but conflict prevented promotion
		expect(result.eventsProcessed).toBe(1)
		expect(result.factsPromoted).toBe(0)
	})

	it("records run start and completion", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => []),
					})),
				})),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
		})

		// Should have called insertOne (run start) and updateOne (run completion)
		expect(consolidationRunsCol.insertOne).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				status: "running",
			}),
		)
		expect(consolidationRunsCol.updateOne).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: expect.any(String),
			}),
			expect.objectContaining({
				$set: expect.objectContaining({
					status: "completed",
				}),
			}),
		)
	})

	it("marks all processed events as dreamer-processed", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "some regular event",
								timestamp: new Date(),
								role: "user",
							},
							{
								eventId: "e2",
								agentId: "agent-1",
								body: "another event",
								timestamp: new Date(),
								role: "assistant",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 2 }) as UpdateResult),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
		})

		// Should mark both events regardless of pattern match
		expect(eventsCol.updateMany).toHaveBeenCalledWith(
			{ eventId: { $in: ["e1", "e2"] } },
			expect.objectContaining({
				$set: expect.objectContaining({
					dreamerRunId: expect.any(String),
				}),
			}),
		)
	})

	it("handles novelty scan failure gracefully", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { scanNovelty } = await import("./mongodb-novelty.js")
		;(scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			events: [],
			scannedCount: 0,
			error: "mongot_unavailable",
			agentId: "agent-1",
		})
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "I prefer tabs",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		// Should not throw, should still process events
		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.eventsProcessed).toBe(1)
	})

	it("uses 0.15 as default minCombinedScore when not specified", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		// Event matches preference pattern but will have zero combined score:
		// novelty mock returns empty (0), importance explicitly 0 → decay=0, accessCount 0
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e-low-score",
								agentId: "agent-1",
								body: "I prefer dark mode",
								importance: 0,
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		// Do NOT pass minCombinedScore — rely on default (should be 0.15)
		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minIntervalMs: 0 },
		})

		// Event processed but the near-zero combined score is below default 0.15,
		// so no facts should be promoted
		expect(result.eventsProcessed).toBe(1)
		expect(result.factsPromoted).toBe(0)
	})

	it("is idempotent — re-run produces 0 new facts", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		// Second run: no unprocessed events (all already marked)
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => []),
					})),
				})),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minIntervalMs: 0 },
		})

		expect(result.eventsProcessed).toBe(0)
		expect(result.factsPromoted).toBe(0)
	})

	it("returns orientStats from $facet aggregation (Phase 1 — Orient)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "some event",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{
						unprocessed: [{ n: 5 }],
						byType: [
							{ _id: "user", count: 3 },
							{ _id: "assistant", count: 2 },
						],
						topTopics: [
							{ _id: "project-alpha", lastActivity: new Date("2026-04-01") },
						],
					},
				]),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.orientStats).toBeDefined()
		expect(result.orientStats!.unprocessedCount).toBe(5)
		expect(result.orientStats!.byRole).toEqual([
			{ role: "user", count: 3 },
			{ role: "assistant", count: 2 },
		])
		expect(result.orientStats!.topScopes).toHaveLength(1)
		expect(result.orientStats!.topScopes[0].scope).toBe("project-alpha")
	})

	it("matches 8 category patterns (Phase 2 — Extract)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const events = [
			{ eventId: "e-decision", body: "I decided to use Bun", role: "user" },
			{ eventId: "e-preference", body: "I prefer dark mode", role: "user" },
			{ eventId: "e-fact", body: "The API uses port 3000", role: "assistant" },
			{
				eventId: "e-contact",
				body: "Contact John at john@acme.com for support",
				role: "user",
			},
			{
				eventId: "e-todo",
				body: "TODO: fix the login bug by Friday",
				role: "user",
			},
			{
				eventId: "e-milestone",
				body: "We shipped v2.0 today",
				role: "assistant",
			},
			{
				eventId: "e-problem",
				body: "There is a bug in the auth module",
				role: "user",
			},
			{
				eventId: "e-emotional",
				body: "I'm frustrated with the deployment process",
				role: "user",
			},
		].map((e) => ({
			...e,
			agentId: "agent-1",
			timestamp: new Date(),
		}))

		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => events),
					})),
				})),
			})),
			updateMany: vi.fn(
				async () => ({ modifiedCount: events.length }) as UpdateResult,
			),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{ unprocessed: [{ n: 8 }], byType: [], topTopics: [] },
				]),
			})),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		// All 8 events should match their respective categories and get promoted
		expect(result.factsPromoted).toBe(8)
		expect(writeStructuredMemory).toHaveBeenCalledTimes(8)

		// Verify categories were extracted
		const calls = (writeStructuredMemory as ReturnType<typeof vi.fn>).mock.calls
		const types = calls.map(
			(c: Array<{ entry: { type: string } }>) => c[0].entry.type,
		)
		expect(types).toContain("decision")
		expect(types).toContain("preference")
		expect(types).toContain("fact")
		expect(types).toContain("contact")
		expect(types).toContain("todo")
		expect(types).toContain("milestone")
		expect(types).toContain("problem")
		expect(types).toContain("emotional")
	})

	it("uses similarity check to decide ADD vs NOOP (Phase 2 — Decide)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "I prefer TypeScript over JavaScript",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{ unprocessed: [{ n: 1 }], byType: [], topTopics: [] },
				]),
			})),
		})
		// Similarity check returns a highly similar existing memory (score > 0.85)
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{
						_id: "existing-mem-1",
						value: "I prefer TypeScript over JavaScript for all projects",
						type: "preference",
						agentId: "agent-1",
						score: 0.92,
					},
				]),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		// High similarity → NOOP → no promotion
		expect(result.factsPromoted).toBe(0)
		expect(writeStructuredMemory).not.toHaveBeenCalled()
	})

	it("prunes near-duplicate structured memories (Phase 5 — Prune)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "some event without pattern match",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{ unprocessed: [{ n: 1 }], byType: [], topTopics: [] },
				]),
			})),
		})

		const updateOneFn = vi.fn(
			async () => ({ modifiedCount: 1 }) as UpdateResult,
		)

		// structured_mem needs:
		// - findOne for conflict check (none needed since no pattern match)
		// - find().sort().limit().toArray() for recent facts in prune phase
		// - aggregate for $vectorSearch prune similarity check
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								_id: "fact-new",
								value: "I prefer dark mode for coding",
								agentId: "agent-1",
								state: "active",
								updatedAt: new Date("2026-04-08"),
							},
						]),
					})),
				})),
			})),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{
						_id: "fact-old",
						value: "I prefer dark mode",
						type: "preference",
						agentId: "agent-1",
						state: "active",
						updatedAt: new Date("2026-04-01"),
						score: 0.95,
					},
				]),
			})),
			updateOne: updateOneFn,
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.prunedCount).toBe(1)
		// The older duplicate should have been invalidated
		expect(updateOneFn).toHaveBeenCalledWith(
			{ _id: "fact-old" },
			{ $set: { state: "invalidated" } },
		)
	})

	it("promoted fact has confidence=0.7 and sourceAgent.name=dreamer", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "I prefer TypeScript over JavaScript",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.factsPromoted).toBe(1)
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					confidence: 0.7,
					sourceAgent: expect.objectContaining({
						id: "agent-1",
						name: "dreamer",
						runId: expect.any(String),
					}),
				}),
			}),
		)
	})

	it("stubs deduction and induction phases without error", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "some event",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{ unprocessed: [{ n: 1 }], byType: [], topTopics: [] },
				]),
			})),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		// Should complete without error — deduction/induction stubs just log and skip
		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.eventsProcessed).toBe(1)
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
	})
})

// ---------------------------------------------------------------------------
// Phase 3.7 — Quality filter: isDerivableFromContext
// ---------------------------------------------------------------------------

describe("isDerivableFromContext (quality filter 3.7)", async () => {
	const { isDerivableFromContext } = await import("./mongodb-consolidator.js")

	it("filters obvious tech-stack statements", () => {
		expect(isDerivableFromContext("uses TypeScript")).toBe(true)
		expect(isDerivableFromContext("runs on Node 20")).toBe(true)
		expect(isDerivableFromContext("built with React")).toBe(true)
		expect(isDerivableFromContext("written in Python")).toBe(true)
		expect(isDerivableFromContext("Use Bun")).toBe(true)
	})

	it("filters project-identity statements", () => {
		expect(isDerivableFromContext("this is a monorepo project")).toBe(true)
		expect(isDerivableFromContext("it is a TypeScript app")).toBe(true)
		expect(isDerivableFromContext("The codebase uses MongoDB")).toBe(true)
		expect(isDerivableFromContext("The repo has tests")).toBe(true)
	})

	it("filters version/runtime statements", () => {
		expect(isDerivableFromContext("Node 20")).toBe(true)
		expect(isDerivableFromContext("bun 1.2")).toBe(true)
		expect(isDerivableFromContext("python 3.12")).toBe(true)
	})

	it("passes through non-derivable memories", () => {
		expect(isDerivableFromContext("prefers tabs over spaces")).toBe(false)
		expect(isDerivableFromContext("deploys on Monday afternoon")).toBe(false)
		expect(
			isDerivableFromContext("risk-averse approach to production changes"),
		).toBe(false)
		expect(
			isDerivableFromContext("Phoenix release blocked by legal review"),
		).toBe(false)
	})

	it("passes through empty or long strings", () => {
		expect(isDerivableFromContext("")).toBe(false)
		expect(isDerivableFromContext("a".repeat(201))).toBe(false)
	})
})

describe("Dreamer entity extraction integration (Phase 3.4)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls extractAndUpsertEntities for each processed event during consolidation", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")

		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "I decided to use MongoDB for the backend",
								timestamp: new Date(),
								role: "user",
								scope: "agent",
								scopeRef: "agent:agent-1",
							},
							{
								eventId: "e2",
								agentId: "agent-1",
								body: "Talked to @alice about the project",
								timestamp: new Date(),
								role: "user",
								scope: "agent",
								scopeRef: "agent:agent-1",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 2 })),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{
						unprocessed: [{ n: 2 }],
						byType: [{ _id: "user", count: 2 }],
						topTopics: [{ _id: "agent", lastActivity: new Date() }],
					},
				]),
			})),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => []),
					})),
				})),
			})),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minIntervalMs: 0 },
		})

		// extractAndUpsertEntities should be called once per event
		expect(extractAndUpsertEntities).toHaveBeenCalledTimes(2)
		expect(extractAndUpsertEntities).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				sourceEventId: "e1",
			}),
		)
		expect(extractAndUpsertEntities).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				sourceEventId: "e2",
			}),
		)
	})
})
