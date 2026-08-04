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

describe("consolidateMemory", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("scores an old event identically to a fresh one (age-invariance)", async () => {
		// The contract, not just the count. Write eligibility used to multiply
		// importance by 0.5**(ageDays/7), so a 60-day-old preference contributed
		// ~0.001 where a same-day one contributed 0.15 — the same fact, promoted
		// or silently dropped depending only on when it was said. A count-only
		// assertion would pass again the day someone reintroduces a milder decay;
		// equality is what pins it.
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { scanNovelty } = await import("./mongodb-novelty.js")
		;(scanNovelty as ReturnType<typeof vi.fn>).mockImplementationOnce(
			async () => ({ events: [], scannedCount: 0, agentId: "agent-1" }),
		)
		const now = new Date("2026-07-29T00:00:00.000Z")
		const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "fresh",
								agentId: "agent-1",
								body: "I prefer tabs over spaces",
								timestamp: now,
								role: "user",
							},
							{
								eventId: "old",
								agentId: "agent-1",
								body: "I prefer tabs over spaces",
								timestamp: sixtyDaysAgo,
								role: "user",
							},
						]),
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

		const fresh = result.candidates.find((c) => c.eventId === "fresh")
		const old = result.candidates.find((c) => c.eventId === "old")
		expect(fresh).toBeDefined()
		expect(old).toBeDefined()
		expect(old?.combinedScore).toBe(fresh?.combinedScore)
		// Both must clear the default gate — neither is a duplicate, and the
		// novelty report returned nothing, which means "unscored", not "stale".
		expect(fresh?.combinedScore).toBeGreaterThanOrEqual(0.15)
		// The decay figure survives as an observability field, and still differs.
		expect(old?.importanceDecay).toBeLessThan(
			fresh?.importanceDecay ?? Number.POSITIVE_INFINITY,
		)
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
		expect(result.orientStats?.unprocessedCount).toBe(5)
		expect(result.orientStats?.byRole).toEqual([
			{ role: "user", count: 3 },
			{ role: "assistant", count: 2 },
		])
		expect(result.orientStats?.topScopes).toHaveLength(1)
		expect(result.orientStats?.topScopes[0].scope).toBe("project-alpha")
	})

	it("bounds the orient scan to the batch's time window (P1-7)", async () => {
		// Unbounded, the orient $facet walked the agent's ENTIRE event history
		// on every run — a linearly growing COLLSCAN feeding a log line.
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const oldest = new Date("2026-06-01T00:00:00Z")
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const aggregate = vi.fn(() => ({
			toArray: vi.fn(async () => [
				{ unprocessed: [{ n: 1 }], byType: [], topTopics: [] },
			]),
		}))
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e-new",
								agentId: "agent-1",
								body: "newest",
								timestamp: new Date("2026-06-02T00:00:00Z"),
								role: "user",
							},
							{
								eventId: "e-old",
								agentId: "agent-1",
								body: "oldest in batch",
								timestamp: oldest,
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 2 }) as UpdateResult),
			aggregate,
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		const pipeline = aggregate.mock.calls[0]?.[0] as Array<{
			$match?: { timestamp?: { $gte?: Date } }
		}>
		expect(pipeline[0]?.$match?.timestamp?.$gte).toEqual(oldest)
	})

	it("does not expose another scope through orientStats", async () => {
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
								body: "ordinary scoped event",
								timestamp: new Date(),
								role: "user",
								scope: "tenant",
								scopeRef: "tenant:A",
							},
						]),
					})),
				})),
			})),
			aggregate: vi.fn((pipeline: Document[]) => {
				const initialMatch = pipeline[0]?.$match as Document | undefined
				const isolated =
					initialMatch?.scope === "tenant" &&
					initialMatch?.scopeRef === "tenant:A"
				return {
					toArray: vi.fn(async () => [
						{
							unprocessed: [{ n: isolated ? 1 : 99 }],
							byType: [{ _id: "user", count: isolated ? 1 : 99 }],
							topTopics: [
								{
									_id: isolated ? "tenant" : "tenant:B",
									lastActivity: new Date(),
								},
							],
						},
					]),
				}
			}),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: {
				scope: "tenant",
				scopeRef: "tenant:A",
				minIntervalMs: 0,
			},
		})

		expect(result.orientStats?.unprocessedCount).toBe(1)
		expect(result.orientStats?.byRole).toEqual([{ role: "user", count: 1 }])
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

	it("never invalidates a fact from another scope during pruning (Phase 5)", async () => {
		// P0: with no options.scope, the prune filter degraded to agentId-only,
		// so the older of two similar facts was invalidated ACROSS the tenant
		// floor (scopeRef). Each fact must prune only within its own scope.
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
		const aggregateFn = vi.fn(() => ({
			// Simulates the unscoped query result: a near-identical fact that
			// belongs to a DIFFERENT tenant (scopeRef) under the same agentId.
			toArray: vi.fn(async () => [
				{
					_id: "fact-bob",
					value: "I prefer dark mode",
					type: "preference",
					agentId: "agent-1",
					scope: "user",
					scopeRef: "user:bob",
					state: "active",
					updatedAt: new Date("2026-04-01"),
					score: 0.95,
				},
			]),
		}))
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								_id: "fact-alice",
								value: "I prefer dark mode for coding",
								agentId: "agent-1",
								scope: "user",
								scopeRef: "user:alice",
								state: "active",
								updatedAt: new Date("2026-04-08"),
							},
						]),
					})),
				})),
			})),
			aggregate: aggregateFn,
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

		// The $vectorSearch prune query must be scoped to the fact's own tenant.
		const pipeline = aggregateFn.mock.calls[0]?.[0] as
			| Record<string, any>[]
			| undefined
		expect(pipeline?.[0]?.$vectorSearch?.filter).toMatchObject({
			agentId: "agent-1",
			scope: "user",
			scopeRef: "user:alice",
		})
		// And even if the store returns a cross-scope doc, it must not be touched.
		expect(updateOneFn).not.toHaveBeenCalled()
		expect(result.prunedCount).toBe(0)
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
