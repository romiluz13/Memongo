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

	it("rate-limits within minIntervalMs", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		// The gate doc exists but its last run completed inside minIntervalMs,
		// so the claim upsert collides on uq_consolidation_runs_gate.
		const consolidationRunsCol = mockCollection({
			findOneAndUpdate: vi.fn(async () => {
				throw Object.assign(new Error("E11000 duplicate key error"), {
					code: 11000,
				})
			}),
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

	it("does not let a recent run in another scope rate-limit this tenant", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const consolidationRunsCol = mockCollection()
		const eventsCol = mockCollection()
		const db = mockDb({
			test_consolidation_runs: consolidationRunsCol,
			test_events: eventsCol,
		})

		await consolidateMemory({
			db,
			prefix: "test_",
			agentId: "agent-1",
			options: {
				scope: "tenant",
				scopeRef: "tenant:A",
				minIntervalMs: 3_600_000,
			},
		})

		// The gate is keyed on the full scope identity, so another scope's
		// recent run lives under a different gateKey and cannot collide.
		expect(consolidationRunsCol.findOneAndUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				gateKey: `7:"agent-1"|6:"tenant"|8:"tenant:A"`,
			}),
			expect.any(Array),
			expect.objectContaining({ upsert: true }),
		)
	})

	it("produces distinct gate keys for boundary-shifted identities (B7)", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		// B7: the gate key was plain concatenation, so these two identities
		// collapsed to one string ("agentsessionsess:1") and would share a
		// gate lease — one tenant's run could rate-limit or fence another's.
		const gateKeys: string[] = []
		const makeDb = () => {
			const consolidationRunsCol = mockCollection({
				findOneAndUpdate: vi.fn(async (filter: Document) => {
					gateKeys.push(filter.gateKey as string)
					return null
				}),
			})
			const eventsCol = mockCollection()
			return mockDb({
				test_consolidation_runs: consolidationRunsCol,
				test_events: eventsCol,
			})
		}

		await consolidateMemory({
			db: makeDb(),
			prefix: "test_",
			agentId: "agent",
			options: { scope: "session", scopeRef: "sess:1" },
		})
		await consolidateMemory({
			db: makeDb(),
			prefix: "test_",
			agentId: "agentsession",
			options: { scopeRef: "sess:1" },
		})

		expect(gateKeys).toHaveLength(2)
		expect(gateKeys[0]).not.toBe(gateKeys[1])
		// Length-prefixed JSON keeps component boundaries recoverable.
		expect(gateKeys[0]).toBe('5:"agent"|7:"session"|6:"sess:1"')
		expect(gateKeys[1]).toBe('12:"agentsession"|0:""|6:"sess:1"')
	})

	describe("phase-0 gate lease (P0.2)", () => {
		/**
		 * Minimal server emulation for the gate claim: applies the claim filter's
		 * $or clauses against a stored gate doc, simulates the upsert-insert when
		 * no doc exists (applying the pipeline's lease fields as the server
		 * would), and raises E11000 when the doc exists but is not claimable —
		 * exactly what uq_consolidation_runs_gate does on a lost race.
		 */
		function makeStatefulGate(initialDoc: Document | null) {
			let doc = initialDoc
			const col = mockCollection({
				findOneAndUpdate: vi.fn(async (filter: Document) => {
					const clauses = (filter.$or ?? []) as Document[]
					const matches =
						doc !== null &&
						clauses.some((c) => {
							if (c.status !== doc.status) {
								return false
							}
							if (c.startedAt?.$lte instanceof Date) {
								return (
									doc.startedAt instanceof Date &&
									doc.startedAt <= c.startedAt.$lte
								)
							}
							if (c.leaseExpiresAt?.$lte instanceof Date) {
								return (
									doc.leaseExpiresAt instanceof Date &&
									doc.leaseExpiresAt <= c.leaseExpiresAt.$lte
								)
							}
							if (c.leaseExpiresAt?.$exists === false) {
								return doc.leaseExpiresAt === undefined
							}
							return false
						})
					if (matches) {
						doc = {
							...doc,
							status: "running",
							leaseToken: "claimed",
							leaseExpiresAt: new Date(Date.now() + 900_000),
						}
						return doc
					}
					if (doc !== null) {
						throw Object.assign(new Error("E11000 duplicate key error"), {
							code: 11000,
						})
					}
					// upsert-insert: the pipeline stamps lease fields server-side
					doc = {
						gateKey: filter.gateKey,
						status: "running",
						leaseToken: "claimed",
						leaseExpiresAt: new Date(Date.now() + 900_000),
					}
					return doc
				}),
				findOne: vi.fn(async () => doc),
			})
			return col
		}

		it("claims the gate atomically when two runs race: exactly one proceeds", async () => {
			const { consolidateMemory } = await import("./mongodb-consolidator.js")
			const consolidationRunsCol = makeStatefulGate(null)
			const eventsCol = mockCollection()
			const db = mockDb({
				test_consolidation_runs: consolidationRunsCol,
				test_events: eventsCol,
			})

			const [a, b] = await Promise.all([
				consolidateMemory({ db, prefix: "test_", agentId: "agent-1" }),
				consolidateMemory({ db, prefix: "test_", agentId: "agent-1" }),
			])

			expect(consolidationRunsCol.findOneAndUpdate).toHaveBeenCalledTimes(2)
			// Exactly one run made it past the gate to the events query.
			expect(eventsCol.find).toHaveBeenCalledTimes(1)
			expect(a.eventsProcessed).toBe(0)
			expect(b.eventsProcessed).toBe(0)
		})

		it("re-claims a crashed run once its lease has expired", async () => {
			const { consolidateMemory } = await import("./mongodb-consolidator.js")
			// Crashed 5 minutes ago (would be rate-limited by startedAt alone),
			// but its lease is long expired — the gate must be claimable.
			const consolidationRunsCol = makeStatefulGate({
				gateKey: '7:"agent-1"|0:""|0:""',
				agentId: "agent-1",
				status: "running",
				startedAt: new Date(Date.now() - 5 * 60_000),
				leaseExpiresAt: new Date(Date.now() - 10 * 60_000),
			})
			const eventsCol = mockCollection()
			const db = mockDb({
				test_consolidation_runs: consolidationRunsCol,
				test_events: eventsCol,
			})

			await consolidateMemory({ db, prefix: "test_", agentId: "agent-1" })

			expect(consolidationRunsCol.findOneAndUpdate).toHaveBeenCalledOnce()
			expect(eventsCol.find).toHaveBeenCalledTimes(1)
		})

		it("does not claim a gate whose lease is still live", async () => {
			const { consolidateMemory } = await import("./mongodb-consolidator.js")
			const consolidationRunsCol = makeStatefulGate({
				gateKey: '7:"agent-1"|0:""|0:""',
				agentId: "agent-1",
				status: "running",
				startedAt: new Date(),
				leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
			})
			const eventsCol = mockCollection()
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
			expect(consolidationRunsCol.findOneAndUpdate).toHaveBeenCalledOnce()
			expect(eventsCol.find).not.toHaveBeenCalled()
		})

		it("fences run completion by lease token", async () => {
			const { consolidateMemory } = await import("./mongodb-consolidator.js")
			const consolidationRunsCol = mockCollection({
				updateOne: vi.fn(
					async () => ({ matchedCount: 0, modifiedCount: 0 }) as UpdateResult,
				),
			})
			const eventsCol = mockCollection()
			const db = mockDb({
				test_consolidation_runs: consolidationRunsCol,
				test_events: eventsCol,
			})

			await consolidateMemory({ db, prefix: "test_", agentId: "agent-1" })

			expect(consolidationRunsCol.updateOne).toHaveBeenCalledWith(
				expect.objectContaining({
					gateKey: expect.any(String),
					runId: expect.any(String),
					status: "running",
					leaseToken: expect.any(String),
					leaseExpiresAt: expect.objectContaining({
						$gt: expect.any(Date),
					}),
				}),
				expect.objectContaining({
					$set: expect.objectContaining({ status: "completed" }),
					$unset: expect.objectContaining({ leaseToken: "" }),
				}),
				expect.objectContaining({
					writeConcern: expect.objectContaining({ w: "majority" }),
				}),
			)
		})
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

	it("leaves a failed candidate unprocessed while acknowledging successful candidates", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const writeFailure = new Error("structured write failed")
		vi.mocked(writeStructuredMemory)
			.mockResolvedValueOnce({ upserted: true, id: "first" })
			.mockRejectedValueOnce(writeFailure)

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
								body: "I prefer TypeScript",
								timestamp: new Date("2026-01-02T00:00:00Z"),
								role: "user",
							},
							{
								eventId: "e2",
								agentId: "agent-1",
								body: "I prefer Rust",
								timestamp: new Date("2026-01-01T00:00:00Z"),
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

		await expect(
			consolidateMemory({
				db,
				prefix: "test_",
				agentId: "agent-1",
				options: { minCombinedScore: 0 },
			}),
		).rejects.toThrow(writeFailure)

		expect(eventsCol.updateMany).toHaveBeenCalledWith(
			{ eventId: { $in: ["e1"] } },
			expect.any(Object),
		)
		expect(consolidationRunsCol.updateOne).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				$set: expect.objectContaining({
					status: "failed",
					eventsProcessed: 1,
				}),
			}),
			expect.anything(),
		)
	})

	it("infers new flagged facts via the LLM reasoning phases when a provider is configured", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)

		// Canned provider: deduction and induction both call chatCompletion.
		const dummyProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({
					facts: [
						{
							value: "The user operates entirely within US infrastructure",
							rationale: "every region signal is US-based",
							from: ["fact-a", "fact-b"],
						},
					],
				}),
			})),
		}
		resolveEnrichmentProviderMock.mockReturnValueOnce(dummyProvider)

		const consolidationRunsCol = mockCollection({
			findOne: vi.fn(async () => null),
		})
		// One event that matches no extraction pattern → reaches the reasoning
		// phase without promoting anything in phase 2.
		const eventsCol = mockCollection({
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								eventId: "e1",
								agentId: "agent-1",
								body: "just checking in",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		// Two existing durable facts feed the reasoning phase.
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{ value: "The user deploys to AWS us-east-1", type: "fact" },
							{ value: "The user's data residency is the US", type: "fact" },
						]),
					})),
				})),
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

		// Deduction + induction returned the same value → deduped to one write.
		expect(result.factsInferred).toBe(1)
		expect(dummyProvider.chatCompletion).toHaveBeenCalledTimes(2)
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "fact",
					confidence: 0.5,
					reinforcementCount: 0,
					provenance: expect.objectContaining({ origin: "llm-inference" }),
				}),
			}),
		)
	})

	it("isolates reasoning per scope and never writes a cross-scope inference", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)

		let call = 0
		const dummyProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => {
				call += 1
				return {
					content: JSON.stringify({
						facts: [
							{
								value: `synthesized conclusion number ${call}`,
								rationale: "r",
								from: ["x", "y"],
							},
						],
					}),
				}
			}),
		}
		resolveEnrichmentProviderMock.mockReturnValueOnce(dummyProvider)

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
								body: "just checking in",
								timestamp: new Date(),
								role: "user",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		// Facts from two different tenants under the same agent.
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			find: vi.fn(() => ({
				sort: vi.fn(() => ({
					limit: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								value: "tenant A widget preference",
								type: "fact",
								scope: "user",
								scopeRef: "user:A",
							},
							{
								value: "tenant A gadget workflow",
								type: "fact",
								scope: "user",
								scopeRef: "user:A",
							},
							{
								value: "tenant B finance policy",
								type: "fact",
								scope: "user",
								scopeRef: "user:B",
							},
							{
								value: "tenant B budget cycle",
								type: "fact",
								scope: "user",
								scopeRef: "user:B",
							},
						]),
					})),
				})),
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

		// Two groups × (deduction + induction), each written under its own scope.
		expect(result.factsInferred).toBe(4)
		const writtenScopeRefs = (
			writeStructuredMemory as unknown as {
				mock: { calls: Array<[{ entry: { scopeRef?: string } }]> }
			}
		).mock.calls.map((c) => c[0].entry.scopeRef)
		expect(writtenScopeRefs.filter((r) => r === "user:A")).toHaveLength(2)
		expect(writtenScopeRefs.filter((r) => r === "user:B")).toHaveLength(2)
		// No inference is ever written agent-global from scoped inputs.
		expect(writtenScopeRefs).not.toContain("agent:agent-1")
		expect(writtenScopeRefs).not.toContain(undefined)
	})

	it("uses source-event scope for similarity filtering and promotion", async () => {
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
								eventId: "e-scoped",
								agentId: "agent-1",
								body: "I prefer scoped TypeScript memories",
								timestamp: new Date(),
								role: "user",
								scope: "workspace",
								scopeRef: "workspace:memongo",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const aggregate = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		const structuredCol = mockCollection({
			findOne: vi.fn(async () => null),
			aggregate,
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
		const pipeline = aggregate.mock.calls[0]?.[0] as Array<{
			$vectorSearch?: { filter?: Record<string, unknown> }
		}>
		expect(pipeline[0]?.$vectorSearch?.filter).toEqual({
			agentId: "agent-1",
			scope: "workspace",
			scopeRef: "workspace:memongo",
		})
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					scope: "workspace",
					scopeRef: "workspace:memongo",
				}),
			}),
		)
	})

	it("rejects consolidation in strict mode when options scopeRef conflicts with source event", async () => {
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
								eventId: "e-mismatch",
								agentId: "agent-1",
								body: "I prefer scoped TypeScript memories",
								timestamp: new Date(),
								role: "user",
								scope: "workspace",
								scopeRef: "workspace:memongo",
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

		const previousStrict = process.env.MEMONGO_BENCHMARK_STRICT
		process.env.MEMONGO_BENCHMARK_STRICT = "1"
		vi.mocked(writeStructuredMemory).mockClear()
		try {
			await expect(
				consolidateMemory({
					db,
					prefix: "test_",
					agentId: "agent-1",
					options: {
						minCombinedScore: 0,
						scope: "workspace",
						scopeRef: "workspace:other",
					},
				}),
			).rejects.toThrow("consolidator scopeRef mismatch")
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MEMONGO_BENCHMARK_STRICT
			} else {
				process.env.MEMONGO_BENCHMARK_STRICT = previousStrict
			}
		}
		expect(writeStructuredMemory).not.toHaveBeenCalled()
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

	it("does not let a conflict in another scope suppress promotion", async () => {
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
								eventId: "e-scope-A",
								agentId: "agent-1",
								body: "I prefer Python over JavaScript",
								timestamp: new Date(),
								role: "user",
								scope: "tenant",
								scopeRef: "tenant:A",
							},
						]),
					})),
				})),
			})),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 }) as UpdateResult),
		})
		const structuredCol = mockCollection({
			findOne: vi.fn(async (filter: Document) =>
				filter.scope === "tenant" && filter.scopeRef === "tenant:A"
					? null
					: {
							agentId: "agent-1",
							scope: "tenant",
							scopeRef: "tenant:B",
							type: "preference",
							key: "Python over JavaScript",
							state: "conflicted",
						},
			),
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
			options: {
				scope: "tenant",
				scopeRef: "tenant:A",
				minCombinedScore: 0,
			},
		})

		expect(result.factsPromoted).toBe(1)
		expect(result.conflictsResolved).toBe(0)
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

		// Should have claimed the gate atomically (run start) and recorded
		// completion through the lease fence (run completion).
		expect(consolidationRunsCol.findOneAndUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				gateKey: expect.any(String),
				$or: expect.any(Array),
			}),
			expect.any(Array),
			expect.objectContaining({ upsert: true }),
		)
		expect(consolidationRunsCol.updateOne).toHaveBeenCalledWith(
			expect.objectContaining({
				gateKey: expect.any(String),
				runId: expect.any(String),
				status: "running",
				leaseToken: expect.any(String),
			}),
			expect.objectContaining({
				$set: expect.objectContaining({
					status: "completed",
				}),
			}),
			expect.anything(),
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

	it("uses the caller scopeRef when scoring novelty", async () => {
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { scanNovelty } = await import("./mongodb-novelty.js")
		;(scanNovelty as ReturnType<typeof vi.fn>).mockImplementationOnce(
			async (params: { options?: { scopeRef?: string } }) => ({
				events: [
					{
						eventId: "e1",
						noveltyScore: params.options?.scopeRef === "tenant:A" ? 1 : 0,
					},
				],
				scannedCount: 1,
				agentId: "agent-1",
			}),
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

		expect(result.candidates[0]?.noveltyScore).toBe(1)
	})
})
