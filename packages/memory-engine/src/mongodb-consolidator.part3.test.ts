import fc from "fast-check"
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

	// =====================================================================
	// Scope-isolation safety — scope-isolation regression tests.
	//
	// Previously the dreamer wrote structured_mem rows using the caller's
	// `options.scope` / `options.scopeRef`. If the caller omitted those or
	// supplied a value different from the source event's scope, a cross-
	// scope consolidation was possible. The fix derives scope/scopeRef
	// from the candidate (source event) and asserts any caller-supplied
	// options match.
	// =====================================================================

	it("scope-isolation safety: inherits scope/scopeRef from source event when options omit them", async () => {
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
								eventId: "evt-user-scope",
								agentId: "agent-1",
								body: "I prefer TypeScript over JavaScript",
								timestamp: new Date(),
								role: "user",
								scope: "user",
								scopeRef: "user:alice",
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

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 }, // no scope / scopeRef
		})

		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					scope: "user",
					scopeRef: "user:alice",
				}),
			}),
		)
	})

	it("scope-isolation safety: skips when options.scope disagrees with candidate.scope outside strict mode", async () => {
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
								eventId: "evt-user",
								agentId: "agent-1",
								body: "I prefer dark mode",
								timestamp: new Date(),
								role: "user",
								scope: "user",
								scopeRef: "user:alice",
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

		// With the events-collection filter also containing the mismatched scope,
		// the query would return nothing in production — but the guard must
		// fire if the candidate and options ever disagree. To exercise the
		// guard we provide an event that slipped past the top-level scope
		// filter (e.g., because the mock ignores filter args). The
		// consolidator must log.warn + skip (NOT throw, NOT cross-scope write).
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		vi.mocked(writeStructuredMemory).mockClear()

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: {
				minCombinedScore: 0,
				scope: "agent", // disagrees with candidate.scope === "user"
			},
		})

		expect(result.factsPromoted).toBe(0)
		expect(writeStructuredMemory).not.toHaveBeenCalled()
	})

	// =====================================================================
	// Scope-isolation safety — fast-check: no consolidated row spans scopes.
	//
	// Seed = 20260512, numRuns = 300. Evidence doc:
	// Dreamer evidence seed: 20260512.
	//
	// Method: generate a random batch of events with varying scope/scopeRef.
	// Run consolidateMemory once per event (single-scope filter). Assert the
	// structured_mem rows written inherit the generating event's scope.
	// =====================================================================

	it("scope-isolation safety property: consolidated rows never cross scope/scopeRef", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						eventId: fc
							.integer({ min: 0, max: 0xff_ff_ff })
							.map((n) => n.toString(16).padStart(4, "0")),
						scope: fc.constantFrom(
							"session" as const,
							"user" as const,
							"agent" as const,
						),
						scopeRef: fc.constantFrom(
							"user:alice",
							"user:bob",
							"agent:default",
							"session:s1",
						),
					}),
					{ minLength: 1, maxLength: 6 },
				),
				async (rawEvents) => {
					const { consolidateMemory } = await import(
						"./mongodb-consolidator.js"
					)
					const { writeStructuredMemory } = await import(
						"./mongodb-structured-memory.js"
					)
					vi.mocked(writeStructuredMemory).mockClear()

					const events = rawEvents.map((e, idx) => ({
						eventId: e.eventId + String(idx),
						agentId: "agent-1",
						body: "I prefer TypeScript over JavaScript", // matches preference pattern
						timestamp: new Date(),
						role: "user",
						scope: e.scope,
						scopeRef: e.scopeRef,
					}))

					// Simulate the server-side scope filter: events_col.find(filter)
					// returns only events matching options.scope/scopeRef. The
					// property focuses on the WRITE path: every structured_mem
					// row must inherit its originating event's scope, even when
					// options.scope matches multiple candidate scopes.
					const eventsCol = mockCollection({
						find: vi.fn((filter: Document) => ({
							sort: vi.fn(() => ({
								limit: vi.fn(() => ({
									toArray: vi.fn(async () =>
										events.filter(
											(ev) =>
												(!filter.scope || ev.scope === filter.scope) &&
												(!filter.scopeRef || ev.scopeRef === filter.scopeRef),
										),
									),
								})),
							})),
						})),
						updateMany: vi.fn(
							async () => ({ modifiedCount: 1 }) as UpdateResult,
						),
					})
					const consolidationRunsCol = mockCollection({
						findOne: vi.fn(async () => null),
					})
					const structuredCol = mockCollection({
						findOne: vi.fn(async () => null),
					})
					const db = mockDb({
						test_consolidation_runs: consolidationRunsCol,
						test_events: eventsCol,
						test_structured_mem: structuredCol,
					})

					// Run ONE consolidation with no scope filter → all events
					// are candidates. The structured_mem rows must still each
					// carry their own event's scope.
					await consolidateMemory({
						db,
						prefix: "test_",
						agentId: "agent-1",
						options: { minCombinedScore: 0 },
					})

					const calls = vi.mocked(writeStructuredMemory).mock.calls
					for (const [args] of calls) {
						const entry = args?.entry as {
							scope?: string
							scopeRef?: string
							sourceEventIds?: string[]
						}
						const sourceEventId = entry?.sourceEventIds?.[0]
						const sourceEvent = events.find(
							(ev) => ev.eventId === sourceEventId,
						)
						if (sourceEvent) {
							expect(entry.scope).toBe(sourceEvent.scope)
							expect(entry.scopeRef).toBe(sourceEvent.scopeRef)
						}
					}
				},
			),
			{ seed: 20260512, numRuns: 300 },
		)
	}, 30_000)
})

describe("matchPatterns", () => {
	it("extracts decisions phrased in the first person plural", async () => {
		// Regression. The decision pattern matched only "I decided/chose/...",
		// so every "we decided" statement fell through to no category and was
		// never promoted. In the e2e evaluation fixtures that was all 8 of the
		// decision events: consolidation reported 0 decisions while the suite
		// expected 8. Every existing unit test used "I decided", which is why
		// the gap survived.
		for (const body of [
			"We decided to use MongoDB for the memory layer",
			"We chose Vitest over Jest for testing",
			"We picked Turborepo for the build system",
			"We selected Node 20 as the minimum",
			"We went with Biome instead of ESLint",
		]) {
			const { matchPatterns } = await import("./mongodb-consolidator.js")
			expect(matchPatterns(body), body).toMatchObject({ type: "decision" })
		}
	})

	it("still extracts decisions phrased in the first person singular", async () => {
		const { matchPatterns } = await import("./mongodb-consolidator.js")
		expect(matchPatterns("I decided to use Bun instead of Node")).toMatchObject(
			{ type: "decision" },
		)
	})

	it("keeps the whole body as the value and the predicate as the key", async () => {
		const { matchPatterns } = await import("./mongodb-consolidator.js")
		const body = "We chose Vitest over Jest for testing"
		expect(matchPatterns(body)).toEqual({
			type: "decision",
			key: "Vitest over Jest for testing",
			value: body,
		})
	})

	it("does not invent a decision from unrelated first-person-plural text", async () => {
		// The category patterns are documented as conservative: false negatives
		// are acceptable, false positives are not. Widening to "we" must not
		// start classifying ordinary narration as a decision.
		const { matchPatterns } = await import("./mongodb-consolidator.js")
		for (const body of [
			"We discussed the tradeoffs for a while",
			"We were wondering about the schema",
			"We deployed on Friday",
		]) {
			expect(matchPatterns(body)?.type, body).not.toBe("decision")
		}
	})
})

// ---------------------------------------------------------------------------
// P4.4.2 — contradiction wiring inside the consolidation loop
// ---------------------------------------------------------------------------

describe("P4.4.2 contradiction wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeConflictSetup() {
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
		// Existing same-key structured_mem entry in the conflicted state.
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => ({
				agentId: "agent-1",
				type: "preference",
				key: "Python over JavaScript",
				value: "I prefer JavaScript over Python",
				state: "conflicted",
			})),
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})
		return { consolidationRunsCol, eventsCol, structuredCol, db }
	}

	const stubProvider = { name: "stub", chatCompletion: vi.fn() }

	it("resolves a conflicting candidate instead of skipping (default on): loser invalidated, winner promoted", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const { db } = makeConflictSetup()
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)
		resolveConflictedCandidateMock.mockResolvedValueOnce({
			resolved: true,
			invalidatedCount: 1,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.factsPromoted).toBe(1)
		expect(result.conflictsResolved).toBe(1)
		expect(resolveConflictedCandidateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				candidate: expect.objectContaining({
					key: "Python over JavaScript",
					value: "I prefer Python over JavaScript",
				}),
			}),
		)
		// resolve (detect → invalidate inside the helper) happens BEFORE the
		// candidate is re-evaluated and promoted.
		expect(
			resolveConflictedCandidateMock.mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(writeStructuredMemory).mock.invocationCallOrder[0])
	})

	it("drops the candidate when IT is the loser (no existing fact invalidated)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const { db } = makeConflictSetup()
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)
		resolveConflictedCandidateMock.mockResolvedValueOnce({
			resolved: false,
			invalidatedCount: 0,
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.factsPromoted).toBe(0)
		expect(result.conflictsResolved).toBe(1)
		expect(vi.mocked(writeStructuredMemory)).not.toHaveBeenCalled()
	})

	it("flag off preserves the exact old skip behavior (no resolution attempted)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const { db } = makeConflictSetup()
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0, resolveContradictions: false },
		})

		expect(result.factsPromoted).toBe(0)
		expect(result.conflictsResolved).toBe(1)
		expect(resolveConflictedCandidateMock).not.toHaveBeenCalled()
		expect(vi.mocked(writeStructuredMemory)).not.toHaveBeenCalled()
	})

	it("preserves the old skip when no LLM is configured, even with the flag on", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { db } = makeConflictSetup()
		// resolveEnrichmentProviderMock defaults to null → resolution cannot run.

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(result.factsPromoted).toBe(0)
		expect(result.conflictsResolved).toBe(1)
		expect(resolveConflictedCandidateMock).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// P4.4.3 — LLM-adjudicated dedup between the NOOP gate and prune
// ---------------------------------------------------------------------------

describe("P4.4.3 LLM-adjudicated dedup", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const stubProvider = { name: "stub", chatCompletion: vi.fn() }

	function makeDedupSetup(params: {
		dupScore: number
		keptSourceEventIds?: string[]
		mergedAwaySourceEventIds?: string[]
	}) {
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		// One event that matches no extraction pattern: phase 2 promotes
		// nothing, so any structured_mem writes observed come from the dedup
		// phase only.
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e-plain",
								agentId: "agent-1",
								body: "just an ordinary chat line",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const keptFact = {
			_id: "fact-kept",
			agentId: "agent-1",
			type: "fact",
			key: "city",
			value: "The user lives in Berlin",
			state: "active",
			scope: "agent",
			scopeRef: "agent:agent-1",
			updatedAt: new Date("2026-01-02T00:00:00Z"),
			sourceEventIds: params.keptSourceEventIds ?? ["k1"],
		}
		const dupFact = {
			_id: "fact-dup",
			agentId: "agent-1",
			type: "fact",
			key: "city-detail",
			value: "The user lives in Berlin, Germany",
			state: "active",
			scope: "agent",
			scopeRef: "agent:agent-1",
			updatedAt: new Date("2026-01-01T00:00:00Z"),
			sourceEventIds: params.mergedAwaySourceEventIds ?? ["d1"],
			score: params.dupScore,
		}
		const updateOneMock = vi.fn(
			async () => ({ modifiedCount: 1 }) as UpdateResult,
		)
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [keptFact]),
					})),
				})),
			})),
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [dupFact]),
			})),
			updateOne: updateOneMock,
		})
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})
		return { db, updateOneMock, keptFact, dupFact }
	}

	it.each([
		{ score: 0.74, expectedCalls: 0 },
		{ score: 0.75, expectedCalls: 1 },
		{ score: 0.92, expectedCalls: 1 },
		{ score: 0.93, expectedCalls: 0 },
	])("adjudicates only inside the band [0.75, 0.92] (score=$score → $expectedCalls calls)", async ({
		score,
		expectedCalls,
	}) => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { db } = makeDedupSetup({ dupScore: score })
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0, llmDedup: true },
		})

		expect(adjudicateFactMergeMock).toHaveBeenCalledTimes(expectedCalls)
	})

	it("MERGE verdict writes union text and folds sourceEventIds (cap respected); loser invalidated", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const keptIds = Array.from({ length: 150 }, (_, i) => `k${i + 1}`)
		const dupIds = Array.from({ length: 100 }, (_, i) => `d${i + 1}`)
		const { db, updateOneMock, keptFact, dupFact } = makeDedupSetup({
			dupScore: 0.88,
			keptSourceEventIds: keptIds,
			mergedAwaySourceEventIds: dupIds,
		})
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)
		adjudicateFactMergeMock.mockResolvedValueOnce({
			verdict: "MERGE",
			mergedValue: "The user lives in Berlin, Germany",
		})

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0, llmDedup: true },
		})

		expect(result.factsMerged).toBe(1)

		// The kept (newer) fact gets the synthesized union text and the folded
		// sourceEventIds, capped at MAX_SOURCE_EVENT_IDS = 200 keeping the most
		// recent entries.
		const keptWrite = updateOneMock.mock.calls.find(
			([filter]) => (filter as { _id?: unknown })._id === keptFact._id,
		)
		expect(keptWrite).toBeDefined()
		const keptSet = (keptWrite?.[1] as { $set: Record<string, unknown> }).$set
		expect(keptSet.value).toBe("The user lives in Berlin, Germany")
		const folded = keptSet.sourceEventIds as string[]
		expect(folded).toHaveLength(200)
		expect(folded[0]).toBe("k51")
		expect(folded[folded.length - 1]).toBe("d100")

		// The merged-away (older) fact is invalidated per the prune mechanism.
		expect(updateOneMock).toHaveBeenCalledWith(
			{ _id: dupFact._id },
			{ $set: { state: "invalidated" } },
		)
	})

	it("NO-MERGE verdict leaves both facts untouched", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { db, updateOneMock } = makeDedupSetup({ dupScore: 0.88 })
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)
		adjudicateFactMergeMock.mockResolvedValueOnce({ verdict: "NO_MERGE" })

		const result = await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0, llmDedup: true },
		})

		expect(result.factsMerged ?? 0).toBe(0)
		expect(updateOneMock).not.toHaveBeenCalled()
	})

	it("treats an adjudication failure as no-merge and never throws", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { db, updateOneMock } = makeDedupSetup({ dupScore: 0.88 })
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)
		adjudicateFactMergeMock.mockRejectedValueOnce(new Error("llm down"))

		await expect(
			consolidateMemory({
				db,
				prefix: "test_",
				agentId: "agent-1",
				options: { minCombinedScore: 0, llmDedup: true },
			}),
		).resolves.toMatchObject({ factsPromoted: 0 })
		expect(updateOneMock).not.toHaveBeenCalled()
	})

	it("flag off (default) makes no adjudication calls at all", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { db } = makeDedupSetup({ dupScore: 0.88 })
		resolveEnrichmentProviderMock.mockReturnValueOnce(stubProvider)

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(adjudicateFactMergeMock).not.toHaveBeenCalled()
	})
})

describe("consolidateMemory TTL expiry guards (B1)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const unexpiredClause = {
		$or: [
			{ expiresAt: { $exists: false } },
			{ expiresAt: { $gt: expect.any(Date) } },
		],
	}

	function makeTtlRunDb(structuredCol: Collection): Db {
		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e-ttl",
								agentId: "agent-1",
								body: "I prefer TypeScript over JavaScript",
								timestamp: new Date("2026-01-02T00:00:00Z"),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		return mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
			test_structured_mem: structuredCol,
		})
	}

	it("hasConflict lookup excludes expired structured docs", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const findOneMock = vi.fn(async () => null)
		const structuredCol = mockCollection({ findOne: findOneMock })
		const db = makeTtlRunDb(structuredCol)

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(findOneMock).toHaveBeenCalled()
		expect(findOneMock.mock.calls[0]?.[0]).toMatchObject(unexpiredClause)
	})

	it("candidate similarity search excludes expired structured docs", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const aggregateMock = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		const structuredCol = mockCollection({ aggregate: aggregateMock })
		const db = makeTtlRunDb(structuredCol)

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		expect(aggregateMock).toHaveBeenCalled()
		const pipeline = aggregateMock.mock.calls[0]?.[0] as Document[]
		const matchStages = pipeline.filter((stage) => stage.$match)
		expect(matchStages).toEqual(
			expect.arrayContaining([
				{ $match: expect.objectContaining(unexpiredClause) },
			]),
		)
	})

	it("prune phase fact sweep excludes expired structured docs", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const findMock = vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		}))
		const structuredCol = mockCollection({ find: findMock })
		const db = makeTtlRunDb(structuredCol)

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0 },
		})

		const pruneCall = findMock.mock.calls.find(
			(call) =>
				(call[0] as Document | undefined)?.state !== undefined &&
				(call[0] as Document).type === undefined,
		)
		expect(pruneCall).toBeDefined()
		expect(pruneCall?.[0]).toMatchObject(unexpiredClause)
	})

	it("reasoning and llm-dedup phases exclude expired structured docs", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const fact = {
			_id: "fact-1",
			agentId: "agent-1",
			type: "fact",
			key: "city",
			value: "The user lives in Berlin",
			state: "active",
			scope: "agent",
			scopeRef: "agent:agent-1",
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		}
		const findMock = vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => [fact]),
				})),
			})),
		}))
		const aggregateMock = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		const structuredCol = mockCollection({
			find: findMock,
			aggregate: aggregateMock,
			findOne: vi.fn(async () => null),
		})
		const db = makeTtlRunDb(structuredCol)
		resolveEnrichmentProviderMock.mockReturnValueOnce({
			name: "stub",
			chatCompletion: vi.fn(),
		})

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: { minCombinedScore: 0, llmDedup: true },
		})

		// Reasoning fact sweep, llm-dedup candidate sweep, and prune sweep —
		// every find against structured_mem must hide expired docs.
		expect(findMock.mock.calls.length).toBeGreaterThanOrEqual(3)
		for (const call of findMock.mock.calls) {
			expect(call[0]).toMatchObject(unexpiredClause)
		}
		// Every structured_mem aggregate pipeline (candidate similarity,
		// llm-dedup similars, prune duplicates) must carry the clause in a
		// $match stage.
		expect(aggregateMock.mock.calls.length).toBeGreaterThanOrEqual(3)
		for (const call of aggregateMock.mock.calls) {
			const pipeline = call[0] as Document[]
			const matchStages = pipeline.filter((stage) => stage.$match)
			expect(matchStages).toEqual(
				expect.arrayContaining([
					{ $match: expect.objectContaining(unexpiredClause) },
				]),
			)
		}
	})
})
