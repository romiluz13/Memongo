import type { Collection, Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	extractLlmStructuredCandidates,
	extractProcedureCandidatesFromEvent,
	extractStructuredCandidatesFromEvent,
	heuristicEpisodeSummarizer,
	promoteDerivedMemoryFromEvent,
	resolveStructuredCandidatesForPromotion,
} from "./mongodb-derived-memory.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"

function mockLlmProvider(content: string): EnrichmentProvider {
	return {
		name: "mock",
		chatCompletion: async () => ({ content }),
	}
}

const loggerMocks = vi.hoisted(() => ({
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}))

vi.mock("@memongo/lib", async () => {
	const actual =
		await vi.importActual<typeof import("@memongo/lib")>("@memongo/lib")
	return {
		...actual,
		createSubsystemLogger: () => loggerMocks,
	}
})

vi.mock("./mongodb-structured-memory.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-structured-memory.js")
	>("./mongodb-structured-memory.js")
	return {
		...actual,
		writeStructuredMemory: vi.fn(async () => ({ upserted: true, id: "mem-1" })),
	}
})

vi.mock("./mongodb-procedures.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-procedures.js")
	>("./mongodb-procedures.js")
	return {
		...actual,
		writeProcedure: vi.fn(async () => ({ upserted: true, id: "proc-1" })),
	}
})

vi.mock("./mongodb-ops.js", () => ({
	recordProjectionRun: vi.fn(async () => undefined),
}))

vi.mock("./mongodb-consolidator.js", async () => {
	const actual = await vi.importActual<
		typeof import("./mongodb-consolidator.js")
	>("./mongodb-consolidator.js")
	return {
		...actual,
		isDerivableFromContext: vi.fn(() => false),
	}
})

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn(async () => null),
		find: vi.fn(() => ({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					toArray: vi.fn(async () => []),
				}),
			}),
		})),
		...overrides,
	} as unknown as Collection
}

function createMockDb(collections: Record<string, Collection>): Db {
	return {
		collection: vi.fn((name: string) => {
			return collections[name] ?? createMockCollection()
		}),
	} as unknown as Db
}

describe("mongodb-derived-memory", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("promotes crisis-like user statements into active critical structured facts", () => {
		const candidates = extractStructuredCandidatesFromEvent({
			eventId: "evt-1",
			agentId: "agent-1",
			role: "user",
			body: "Remember this: there is war in Israel right now and it is critical context.",
			timestamp: new Date("2026-03-21T10:00:00Z"),
			scope: "agent",
			scopeRef: "agent:agent-1",
		})

		const activeContext = candidates.find(
			(candidate) => candidate.salience === "critical",
		)
		expect(activeContext).toBeTruthy()
		expect(activeContext?.type).toBe("fact")
		expect(activeContext?.temporalScope).toBe("ongoing")
		expect(activeContext?.sourceEventIds).toEqual(["evt-1"])
	})

	it("stamps candidate valid-time from the event timestamp (#32), not the write clock", () => {
		const eventTime = new Date("2026-03-21T10:00:00Z")
		const candidates = extractStructuredCandidatesFromEvent({
			eventId: "evt-vt",
			agentId: "agent-1",
			role: "user",
			body: "Remember this: the deploy region is us-east-1.",
			timestamp: eventTime,
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
		expect(candidates.length).toBeGreaterThan(0)
		for (const candidate of candidates) {
			expect(candidate.validFrom?.toISOString()).toBe(eventTime.toISOString())
			expect(
				(candidate.provenance as Record<string, unknown>)?.validTimeSource,
			).toBe("event")
		}
	})

	it("promotes explicit preferences into structured preference memory", () => {
		const candidates = extractStructuredCandidatesFromEvent({
			eventId: "evt-2",
			agentId: "agent-1",
			role: "user",
			body: "I prefer concise answers with direct tradeoffs.",
			timestamp: new Date("2026-03-21T10:00:00Z"),
			scope: "agent",
			scopeRef: "agent:agent-1",
		})

		expect(
			candidates.some((candidate) => candidate.type === "preference"),
		).toBe(true)
	})

	it("does not durably promote a first-mention preference without reinforcement", async () => {
		const structuredCol = createMockCollection()
		const eventsCol = createMockCollection()

		const promotable = await resolveStructuredCandidatesForPromotion({
			db: createMockDb({
				test_structured_mem: structuredCol,
				test_events: eventsCol,
			}),
			prefix: "test_",
			event: {
				eventId: "evt-pref-1",
				agentId: "agent-1",
				role: "user",
				body: "I prefer concise answers with direct tradeoffs.",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(promotable).toEqual([])
	})

	it("promotes a repeated preference after canonical evidence repeats", async () => {
		const structuredCol = createMockCollection()
		const supportingEvents = [
			{
				eventId: "evt-pref-0",
				body: "I prefer concise answers with direct tradeoffs.",
				timestamp: new Date("2026-03-20T10:00:00Z"),
			},
		]
		const eventsCol = createMockCollection({
			find: vi.fn(() => ({
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn(async () => supportingEvents),
					}),
				}),
			})),
		})

		const promotable = await resolveStructuredCandidatesForPromotion({
			db: createMockDb({
				test_structured_mem: structuredCol,
				test_events: eventsCol,
			}),
			prefix: "test_",
			event: {
				eventId: "evt-pref-1",
				agentId: "agent-1",
				role: "user",
				body: "I prefer concise answers with direct tradeoffs.",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(promotable).toHaveLength(1)
		expect(promotable[0]?.type).toBe("preference")
		expect(promotable[0]?.reinforcementCount).toBe(2)
		expect(promotable[0]?.sourceEventIds).toEqual(["evt-pref-0", "evt-pref-1"])
		expect(promotable[0]?.provenance).toMatchObject({
			promotionTrigger: "repeated-evidence",
			supportingEventCount: 1,
		})
	})

	it("promotes explicit remember instructions immediately without waiting for reinforcement", async () => {
		const structuredCol = createMockCollection()
		const eventsCol = createMockCollection()

		const promotable = await resolveStructuredCandidatesForPromotion({
			db: createMockDb({
				test_structured_mem: structuredCol,
				test_events: eventsCol,
			}),
			prefix: "test_",
			event: {
				eventId: "evt-remember-1",
				agentId: "agent-1",
				role: "user",
				body: "Remember this: the launch codeword is Blue Finch.",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(promotable).toHaveLength(1)
		expect(promotable[0]?.type).toBe("fact")
		expect(promotable[0]?.value).toContain("Blue Finch")
		expect(structuredCol.findOne).not.toHaveBeenCalled()
		expect(eventsCol.find).not.toHaveBeenCalled()
	})

	it("merges LLM-extracted facts into promotable candidates when a provider is configured", async () => {
		const structuredCol = createMockCollection()
		// Reinforcement path: LLM facts are requires-reinforcement, so supply
		// one supporting event so the candidate becomes promotable.
		const eventsCol = createMockCollection({
			find: vi.fn(() => ({
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn(async () => [
							{
								eventId: "evt-support-0",
								body: "earlier chat about deployment",
								timestamp: new Date("2026-03-20T10:00:00Z"),
							},
						]),
					}),
				}),
			})),
		})

		const provider = mockLlmProvider(
			JSON.stringify({
				facts: ["User deploys to AWS us-east-1"],
				qa_pairs: [],
				has_personal_content: false,
			}),
		)

		const promotable = await resolveStructuredCandidatesForPromotion({
			db: createMockDb({
				test_structured_mem: structuredCol,
				test_events: eventsCol,
			}),
			prefix: "test_",
			// Inert body: the regex extractor produces nothing here, so any
			// promotable fact must have come from the LLM path.
			event: {
				eventId: "evt-llm-merge-1",
				agentId: "agent-1",
				role: "user",
				body: "ok sounds good",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
			provider,
			model: "gpt-4o-mini",
		})

		expect(
			promotable.some((c) => c.value === "User deploys to AWS us-east-1"),
		).toBe(true)
	})

	it("falls back to regex candidates when the LLM provider fails", async () => {
		const structuredCol = createMockCollection()
		const eventsCol = createMockCollection()
		const failingProvider: EnrichmentProvider = {
			name: "failing",
			chatCompletion: async () => {
				throw new Error("llm upstream 500")
			},
		}

		const promotable = await resolveStructuredCandidatesForPromotion({
			db: createMockDb({
				test_structured_mem: structuredCol,
				test_events: eventsCol,
			}),
			prefix: "test_",
			event: {
				eventId: "evt-llm-fail-1",
				agentId: "agent-1",
				role: "user",
				body: "Remember this: the launch codeword is Blue Finch.",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
			provider: failingProvider,
			model: "gpt-4o-mini",
		})

		expect(promotable).toHaveLength(1)
		expect(promotable[0]?.value).toContain("Blue Finch")
	})

	it("extracts procedures from assistant workflow-style responses", () => {
		const procedures = extractProcedureCandidatesFromEvent({
			eventId: "evt-3",
			agentId: "agent-1",
			role: "assistant",
			body: [
				"For incident response:",
				"1. Check current service status.",
				"2. Notify the team lead.",
				"3. Escalate if customer impact continues.",
			].join("\n"),
			timestamp: new Date("2026-03-21T10:00:00Z"),
			scope: "agent",
			scopeRef: "agent:agent-1",
		})

		expect(procedures).toHaveLength(1)
		expect(procedures[0]?.name).toBe("incident response")
		expect(procedures[0]?.steps).toEqual([
			"Check current service status.",
			"Notify the team lead.",
			"Escalate if customer impact continues.",
		])
	})

	it("extracts procedures from flattened inline numbered assistant responses", () => {
		const procedures = extractProcedureCandidatesFromEvent({
			eventId: "evt-3b",
			agentId: "agent-1",
			role: "assistant",
			body: "For incident response: 1. Check current service status. 2. Notify the team lead. 3. Escalate if customer impact continues.",
			timestamp: new Date("2026-03-21T10:00:00Z"),
			scope: "agent",
			scopeRef: "agent:agent-1",
		})

		expect(procedures).toHaveLength(1)
		expect(procedures[0]?.steps).toEqual([
			"Check current service status.",
			"Notify the team lead.",
			"Escalate if customer impact continues.",
		])
	})

	it("does not turn assistant procedures into active critical facts just because they mention incidents", () => {
		const candidates = extractStructuredCandidatesFromEvent({
			eventId: "evt-4",
			agentId: "agent-1",
			role: "assistant",
			body: "For incident response: 1. Check current service status. 2. Notify the team lead.",
			timestamp: new Date("2026-03-21T10:00:00Z"),
			scope: "agent",
			scopeRef: "agent:agent-1",
		})

		expect(
			candidates.some((candidate) => candidate.salience === "critical"),
		).toBe(false)
	})

	it("builds deterministic heuristic episode summaries", async () => {
		const summary = await heuristicEpisodeSummarizer([
			{
				role: "user",
				body: "We hit a production outage in the billing pipeline.",
				timestamp: new Date("2026-03-21T09:00:00Z"),
			},
			{
				role: "assistant",
				body: "We should check MongoDB status, then notify the billing team.",
				timestamp: new Date("2026-03-21T09:05:00Z"),
			},
		])

		expect(summary.title.length).toBeGreaterThan(0)
		expect(summary.summary).toContain("2 messages")
		expect(summary.tags?.length).toBeGreaterThan(0)
	})

	it("skips promotion when this event was already promoted", async () => {
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const { writeProcedure } = await import("./mongodb-procedures.js")

		const db = createMockDb({
			test_structured_mem: createMockCollection({
				findOne: vi.fn(async () => ({ key: "fact-existing" })),
			}),
			test_procedures: createMockCollection({
				findOne: vi.fn(async () => ({ procedureId: "proc-existing" })),
			}),
		})

		const result = await promoteDerivedMemoryFromEvent({
			db,
			prefix: "test_",
			embeddingMode: "automated",
			event: {
				eventId: "evt-dup-1",
				agentId: "agent-1",
				role: "user",
				body: "Remember this: deployment window is Friday at noon.",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(result).toEqual({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: true,
			skipReason: "already-promoted",
		})
		expect(writeStructuredMemory).not.toHaveBeenCalled()
		expect(writeProcedure).not.toHaveBeenCalled()
	})

	it("filters derivable structured candidates before immediate promotion", async () => {
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const { isDerivableFromContext } = await import("./mongodb-consolidator.js")

		vi.mocked(isDerivableFromContext).mockImplementation((value) =>
			value.toLowerCase().includes("typescript"),
		)

		const db = createMockDb({
			test_structured_mem: createMockCollection({
				findOne: vi.fn(async () => null),
			}),
			test_procedures: createMockCollection({
				findOne: vi.fn(async () => null),
			}),
			test_events: createMockCollection(),
		})

		const result = await promoteDerivedMemoryFromEvent({
			db,
			prefix: "test_",
			embeddingMode: "automated",
			event: {
				eventId: "evt-derivable-1",
				agentId: "agent-1",
				role: "user",
				body: "Remember: uses TypeScript",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(result).toEqual({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: false,
		})
		expect(writeStructuredMemory).not.toHaveBeenCalled()
	})

	it("recovers missing procedure promotion when structured memory already exists", async () => {
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const { writeProcedure } = await import("./mongodb-procedures.js")

		const db = createMockDb({
			test_structured_mem: createMockCollection({
				findOne: vi.fn(async () => ({ key: "fact-existing" })),
			}),
			test_procedures: createMockCollection({
				findOne: vi.fn(async () => null),
			}),
		})

		const result = await promoteDerivedMemoryFromEvent({
			db,
			prefix: "test_",
			embeddingMode: "automated",
			event: {
				eventId: "evt-partial-1",
				agentId: "agent-1",
				role: "assistant",
				body: [
					"Remember this: legal review is the current blocker.",
					"For release checklist:",
					"1. Check CI status.",
					"2. Confirm reviewer approval.",
				].join("\n"),
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(result).toEqual({
			structuredCreated: 0,
			proceduresCreated: 1,
			skipped: false,
		})
		expect(writeStructuredMemory).not.toHaveBeenCalled()
		expect(writeProcedure).toHaveBeenCalledTimes(1)
	})

	it("retries only the missing structured candidate after a partial failure", async () => {
		const { writeStructuredMemory } = await import(
			"./mongodb-structured-memory.js"
		)
		const writtenKeys = new Set<string>()
		const structured = createMockCollection({
			findOne: vi.fn(async (filter: Record<string, unknown>) =>
				writtenKeys.has(String(filter.key)) ? { key: filter.key } : null,
			),
		})
		const db = createMockDb({
			test_structured_mem: structured,
			test_procedures: createMockCollection(),
		})
		const failure = new Error("second candidate failed")
		vi.mocked(writeStructuredMemory)
			.mockImplementationOnce(async ({ entry }) => {
				writtenKeys.add(entry.key)
				return { upserted: true, id: entry.key }
			})
			.mockRejectedValueOnce(failure)
			.mockImplementationOnce(async ({ entry }) => {
				writtenKeys.add(entry.key)
				return { upserted: true, id: entry.key }
			})

		const event = {
			eventId: "evt-partial-candidates",
			agentId: "agent-1",
			role: "user" as const,
			body: "Remember this: the launch blocker is active right now.",
			timestamp: new Date("2026-03-21T10:00:00Z"),
			scope: "agent" as const,
			scopeRef: "agent:agent-1",
		}

		await expect(
			promoteDerivedMemoryFromEvent({
				db,
				prefix: "test_",
				embeddingMode: "automated",
				event,
			}),
		).rejects.toBe(failure)
		await expect(
			promoteDerivedMemoryFromEvent({
				db,
				prefix: "test_",
				embeddingMode: "automated",
				event,
			}),
		).resolves.toEqual({
			structuredCreated: 1,
			proceduresCreated: 0,
			skipped: false,
		})
		expect(writeStructuredMemory).toHaveBeenCalledTimes(3)
		expect(writtenKeys.size).toBe(2)
	})

	it("logs projection-run failures instead of swallowing them silently", async () => {
		const { recordProjectionRun } = await import("./mongodb-ops.js")
		vi.mocked(recordProjectionRun).mockRejectedValue(
			new Error("ops unavailable"),
		)

		const db = createMockDb({
			test_structured_mem: createMockCollection({
				findOne: vi.fn(async () => null),
			}),
			test_procedures: createMockCollection({
				findOne: vi.fn(async () => null),
			}),
		})

		const result = await promoteDerivedMemoryFromEvent({
			db,
			prefix: "test_",
			embeddingMode: "automated",
			event: {
				eventId: "evt-ops-1",
				agentId: "agent-1",
				role: "user",
				body: "Remember this: the launch codeword is Blue Finch.",
				timestamp: new Date("2026-03-21T10:00:00Z"),
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(result).toEqual({
			structuredCreated: 1,
			proceduresCreated: 0,
			skipped: false,
		})
		expect(loggerMocks.warn).toHaveBeenCalledWith(
			expect.stringContaining("projection run recording failed"),
		)
	})
})

describe("extractLlmStructuredCandidates", () => {
	const event = {
		eventId: "evt-llm-1",
		agentId: "agent-1",
		role: "user" as const,
		body: "By the way, I always switch the editor to dark mode.",
		timestamp: new Date("2026-03-21T10:00:00Z"),
		scope: "agent" as const,
		scopeRef: "agent:agent-1",
	}

	it("maps LLM-extracted facts into structured fact candidates", async () => {
		const provider = mockLlmProvider(
			JSON.stringify({
				facts: ["User prefers dark mode in the editor"],
				qa_pairs: [],
				has_personal_content: true,
			}),
		)

		const candidates = await extractLlmStructuredCandidates({
			event,
			provider,
			model: "gpt-4o-mini",
		})

		expect(candidates).toHaveLength(1)
		const fact = candidates[0]
		expect(fact.type).toBe("fact")
		expect(fact.value).toBe("User prefers dark mode in the editor")
		expect(fact.sourceEventIds).toEqual(["evt-llm-1"])
		expect(fact.promotionReason).toBe("llm-extraction")
		expect(fact.promotionPolicy).toBe("requires-reinforcement")
	})

	it("returns no candidates when the LLM extracts no facts", async () => {
		const provider = mockLlmProvider(JSON.stringify({ facts: [] }))
		const candidates = await extractLlmStructuredCandidates({
			event,
			provider,
			model: "gpt-4o-mini",
		})
		expect(candidates).toEqual([])
	})
})
