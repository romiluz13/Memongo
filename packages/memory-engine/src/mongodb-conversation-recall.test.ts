/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Malformed scoreDetails handling — capture log.warn for malformed scoreDetails.
// `vi.mock` is hoisted above `const` declarations at module scope, so we
// use `vi.hoisted` to declare the spy in the same phase.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }))
vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		info: vi.fn(),
		warn: warnSpy,
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))

vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
}))

import { recallConversation } from "./mongodb-conversation-recall.js"
import { eventsCollection } from "./mongodb-schema.js"

function mockDb(): Db {
	return {} as Db
}

/**
 * Bi-temporal recall safety: every recall path MUST stamp the
 * bi-temporal validity clause onto the filter so invalidated memories
 * cannot be returned at `asOf`. Tests use this helper to match the
 * expected `$and: [...bitemporal shape...]` entry.
 */
function expectedBitemporalAnd(asOf: Date): Document[] {
	return [
		{
			$and: [
				{
					$or: [{ validAt: { $exists: false } }, { validAt: { $lte: asOf } }],
				},
				{
					$or: [
						{ invalidAt: { $exists: false } },
						{ invalidAt: null },
						{ invalidAt: { $gt: asOf } },
					],
				},
			],
		},
	]
}

function makeFindCollection(params?: {
	results?: Document[]
	findImpl?: (filter: Document) => unknown
}): Collection {
	const limit = vi.fn((value?: number) => ({
		toArray: vi.fn(async () =>
			(params?.results ?? []).slice(0, value ?? params?.results?.length),
		),
	}))
	const sort = vi.fn(() => ({ limit }))
	const find = vi.fn(
		params?.findImpl ?? (() => ({ sort })),
	) as unknown as Collection["find"]

	return {
		find,
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
	} as unknown as Collection
}

function makeAggregateCollection(params?: {
	results?: Document[]
	aggregateImpl?: (pipeline: Document[]) => unknown
}): Collection {
	const aggregate = vi.fn(
		params?.aggregateImpl ??
			(() => ({
				toArray: vi.fn(async () => params?.results ?? []),
			})),
	) as unknown as Collection["aggregate"]

	return {
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		})),
		aggregate,
	} as unknown as Collection
}

describe("recallConversation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("runs standard recall with tool exclusion and asOf-capped time range", async () => {
		const resultDoc = {
			eventId: "evt-1",
			agentId: "agent-1",
			sessionId: "sess-1",
			role: "assistant",
			body: "Phoenix launches on Friday.",
			scope: "agent",
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T10:30:00.000Z"),
		}
		const col = makeFindCollection({ results: [resultDoc] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				sessionId: "sess-1",
				startTime: "2026-04-08",
				endTime: "2026-04-11",
				timezone: "UTC",
				asOf: new Date("2026-04-10T12:00:00.000Z"),
				limit: 10,
			},
		})

		expect(col.find).toHaveBeenCalledWith({
			agentId: "agent-1",
			sessionId: "sess-1",
			role: { $ne: "tool" },
			timestamp: {
				$gte: new Date("2026-04-08T00:00:00.000Z"),
				$lte: new Date("2026-04-10T12:00:00.000Z"),
			},
			$and: expectedBitemporalAnd(new Date("2026-04-10T12:00:00.000Z")),
		})

		expect(response.metadata.searchMethod).toBe("standard")
		expect(response.metadata.filtersApplied).toEqual([
			"sessionId:sess-1",
			"startTime:2026-04-08T00:00:00.000Z",
			"endTime:2026-04-10T12:00:00.000Z",
			"excludeToolMessages",
		])
		expect(response.results).toEqual([
			expect.objectContaining({
				matchType: "filter",
				citation: expect.objectContaining({
					eventId: "evt-1",
					sessionId: "sess-1",
					role: "assistant",
					preview: "Assistant: Phoenix launches on Friday.",
				}),
			}),
		])
	})

	it("lets explicit roles override the default tool-message exclusion", async () => {
		const col = makeFindCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				roles: ["tool"],
				includeToolMessages: false,
			},
		})

		expect(col.find).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				role: { $in: ["tool"] },
				timestamp: {
					$lte: expect.any(Date),
				},
				// Bi-temporal recall safety: bi-temporal $and clause is always present.
				$and: expect.arrayContaining([
					expect.objectContaining({ $and: expect.any(Array) }),
				]),
			}),
		)
	})

	it("resolves date-only boundaries in the requested timezone", async () => {
		const col = makeFindCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				startTime: "2026-04-08",
				endTime: "2026-04-08",
				timezone: "America/New_York",
				asOf: new Date("2026-04-12T00:00:00.000Z"),
			},
		})

		expect(col.find).toHaveBeenCalledWith({
			agentId: "agent-1",
			role: { $ne: "tool" },
			timestamp: {
				$gte: new Date("2026-04-08T04:00:00.000Z"),
				$lte: new Date("2026-04-09T03:59:59.999Z"),
			},
			$and: expectedBitemporalAnd(new Date("2026-04-12T00:00:00.000Z")),
		})
	})

	it("uses semantic recall when vector search is available", async () => {
		const resultDoc = {
			eventId: "evt-2",
			agentId: "agent-1",
			role: "user",
			body: "The Phoenix launch moved to Friday.",
			scope: "agent",
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T10:30:00.000Z"),
			score: 0.92,
		}
		const col = makeAggregateCollection({ results: [resultDoc] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "phoenix launch",
				startTime: "2026-04-01",
				limit: 999,
			},
			capabilities: {
				vectorSearch: true,
				textSearch: false,
				rankFusion: false,
				scoreFusion: false,
			},
		})

		expect(col.aggregate).toHaveBeenCalledOnce()
		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		expect(pipeline[0]?.$vectorSearch).toEqual({
			index: "mem_events_vector",
			query: { text: "phoenix launch" },
			model: "voyage-4-large",
			path: "body",
			filter: {
				agentId: { $eq: "agent-1" },
				role: { $ne: "tool" },
				timestamp: {
					$gte: new Date("2026-04-01T00:00:00.000Z"),
					$lte: expect.any(Date),
				},
			},
			// Task 2.R2: approved numCandidates table — effectiveLimit=200 clamps
			// above the 30-row (600), so we fall through to the 20× rule = 4000.
			numCandidates: 4000,
			limit: 200,
		})
		expect(response.metadata.searchMethod).toBe("semantic")
		expect(response.results[0]).toEqual(
			expect.objectContaining({
				matchType: "semantic",
				score: 0.92,
			}),
		)
	})

	it("uses rankFusion for hybrid recall when text and vector search are available", async () => {
		const col = makeAggregateCollection({
			results: [
				{
					eventId: "evt-3",
					agentId: "agent-1",
					role: "assistant",
					body: "We discussed the Phoenix deployment timeline.",
					scope: "agent",
					scopeRef: "agent:agent-1",
					timestamp: new Date("2026-04-09T10:30:00.000Z"),
					score: 0.41,
				},
			],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "deployment timeline",
				sessionId: "sess-7",
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		expect(pipeline[0]?.$rankFusion).toBeDefined()
		expect(
			pipeline[0]?.$rankFusion?.input?.pipelines?.vector?.[0]?.$vectorSearch
				?.index,
		).toBe("mem_events_vector")
		expect(
			pipeline[0]?.$rankFusion?.input?.pipelines?.text?.[0]?.$search?.index,
		).toBe("mem_events_text")
		expect(response.metadata.searchMethod).toBe("hybrid")
		expect(response.results[0]?.matchType).toBe("hybrid")
	})

	it("projects $rankFusion scoreDetails via $addFields before the final $project (Task 2.R1)", async () => {
		const col = makeAggregateCollection({
			results: [
				{
					eventId: "evt-4",
					agentId: "agent-1",
					role: "assistant",
					body: "Scoring telemetry is observable.",
					scope: "agent",
					scopeRef: "agent:agent-1",
					timestamp: new Date("2026-04-09T10:30:00.000Z"),
					score: 0.31,
					scoreDetails: {
						value: 0.31,
						description: "rank-fusion:sum(weight*(1/(60+rank)))",
						details: [
							{
								inputPipelineName: "vector",
								rank: 1,
								weight: 0.5,
								value: 0.5 * (1 / (60 + 1)),
							},
							{
								inputPipelineName: "text",
								rank: 2,
								weight: 0.5,
								value: 0.5 * (1 / (60 + 2)),
							},
						],
					},
				},
			],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "deployment telemetry",
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		// scoreDetails must come from $addFields BEFORE the final $project so the
		// rank-fusion contributions survive into the benchmark artifact writer.
		const addFieldsStage = pipeline.find(
			(stage) => stage.$addFields !== undefined,
		)
		expect(addFieldsStage?.$addFields?.scoreDetails).toEqual({
			$meta: "scoreDetails",
		})
		const projectStage = pipeline.find((stage) => stage.$project !== undefined)
		expect(projectStage?.$project?.scoreDetails).toBe(1)
		// Order invariant: $addFields comes before $project.
		const addFieldsIdx = pipeline.findIndex(
			(stage) => stage.$addFields !== undefined,
		)
		const projectIdx = pipeline.findIndex(
			(stage) => stage.$project !== undefined,
		)
		expect(addFieldsIdx).toBeLessThan(projectIdx)
		// Envelope surfaces the scoreDetails to consumers.
		expect(response.results[0]?.scoreDetails?.details).toHaveLength(2)
		expect(response.results[0]?.scoreDetails?.details?.[0]).toMatchObject({
			inputPipelineName: "vector",
			rank: 1,
			weight: 0.5,
		})
		const vectorContribution =
			response.results[0]?.scoreDetails?.details?.[0]?.value ?? 0
		expect(vectorContribution).toBeCloseTo(0.5 * (1 / (60 + 1)), 10)
	})

	it("falls back to escaped regex filtering when semantic search is unavailable", async () => {
		const col = makeFindCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "phoenix+launch?",
			},
			capabilities: {
				vectorSearch: false,
				textSearch: false,
				rankFusion: false,
				scoreFusion: false,
			},
		})

		expect(col.find).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				role: { $ne: "tool" },
				body: { $regex: /phoenix\+launch\?/i },
				timestamp: {
					$lte: expect.any(Date),
				},
				$and: expect.arrayContaining([
					expect.objectContaining({ $and: expect.any(Array) }),
				]),
			}),
		)
		expect(response.metadata.searchMethod).toBe("standard")
		expect(response.metadata.queryUsed).toBe("phoenix+launch?")
	})

	it("returns empty results with clean metadata when no events match", async () => {
		const col = makeFindCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
			},
		})

		expect(response.results).toEqual([])
		expect(response.metadata.totalMatched).toBe(0)
		expect(response.metadata.searchMethod).toBe("standard")
		expect(response.metadata.filtersApplied).toContain("excludeToolMessages")
		expect(response.metadata.queryUsed).toBeUndefined()
	})

	it("enforces the requested limit on standard recall results", async () => {
		const col = makeFindCollection({
			results: [
				{
					eventId: "evt-4",
					agentId: "agent-1",
					role: "assistant",
					body: "Most recent message",
					scope: "agent",
					scopeRef: "agent:agent-1",
					timestamp: new Date("2026-04-09T10:30:00.000Z"),
				},
				{
					eventId: "evt-3",
					agentId: "agent-1",
					role: "assistant",
					body: "Older message",
					scope: "agent",
					scopeRef: "agent:agent-1",
					timestamp: new Date("2026-04-08T10:30:00.000Z"),
				},
			],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				limit: 1,
			},
		})

		expect(response.results).toHaveLength(1)
		expect(response.results[0]?.citation.eventId).toBe("evt-4")
	})

	it("prefers explicit role filters over includeToolMessages", async () => {
		const col = makeFindCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				roles: ["user"],
				includeToolMessages: true,
			},
		})

		expect(col.find).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				role: { $in: ["user"] },
				timestamp: {
					$lte: expect.any(Date),
				},
				$and: expect.arrayContaining([
					expect.objectContaining({ $and: expect.any(Array) }),
				]),
			}),
		)
	})

	it("falls back to UTC boundaries when the timezone is invalid", async () => {
		const col = makeFindCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				startTime: "2026-04-08",
				endTime: "2026-04-08",
				timezone: "Mars/Olympus",
				asOf: new Date("2026-04-12T00:00:00.000Z"),
			},
		})

		expect(col.find).toHaveBeenCalledWith({
			agentId: "agent-1",
			role: { $ne: "tool" },
			timestamp: {
				$gte: new Date("2026-04-08T00:00:00.000Z"),
				$lte: new Date("2026-04-08T23:59:59.999Z"),
			},
			$and: expectedBitemporalAnd(new Date("2026-04-12T00:00:00.000Z")),
		})
	})

	it("returns empty results without touching the database when startTime is after endTime", async () => {
		const col = makeFindCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				startTime: "2026-04-10T12:00:00.000Z",
				endTime: "2026-04-09T12:00:00.000Z",
			},
		})

		expect(response.results).toEqual([])
		expect(response.metadata.totalMatched).toBe(0)
		expect(eventsCollection).not.toHaveBeenCalled()
	})

	it("truncates citation previews to 500 characters", async () => {
		const body = "x".repeat(600)
		const col = makeFindCollection({
			results: [
				{
					eventId: "evt-preview",
					agentId: "agent-1",
					role: "assistant",
					body,
					scope: "agent",
					scopeRef: "agent:agent-1",
					timestamp: new Date("2026-04-09T10:30:00.000Z"),
				},
			],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
			},
		})

		expect(response.results[0]?.citation.preview.length).toBe(500)
		expect(
			response.results[0]?.citation.preview.startsWith("Assistant: "),
		).toBe(true)
	})

	// =========================================================================
	// Malformed scoreDetails handling — warn on malformed scoreDetails shape.
	//
	// When MongoDB returns a document with scoreDetails present but malformed
	// (e.g., non-object or object missing value/description/details), the
	// normalizer silently returns undefined. That hid real data-quality bugs.
	// New behavior: emit a single log.warn per recall call, keyed by first
	// offending docId, while still returning undefined so the ranking path
	// is unaffected. Truly absent scoreDetails (undefined) stays silent.
	// =========================================================================
	it("malformed scoreDetails: emits a single log.warn when scoreDetails is malformed", async () => {
		warnSpy.mockClear()
		const col = makeAggregateCollection({
			results: [
				{
					eventId: "evt-bad-1",
					agentId: "agent-1",
					role: "assistant",
					body: "first",
					timestamp: new Date("2026-04-09T10:30:00.000Z"),
					score: 0.2,
					scoreDetails: "not-an-object", // malformed (primitive)
				},
				{
					eventId: "evt-bad-2",
					agentId: "agent-1",
					role: "assistant",
					body: "second",
					timestamp: new Date("2026-04-09T10:31:00.000Z"),
					score: 0.1,
					scoreDetails: null, // also malformed
				},
			],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: { agentId: "agent-1", query: "anything" },
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const malformedWarns = warnSpy.mock.calls.filter((c: unknown[]) =>
			String(c[0]).includes("rankFusion scoreDetails missing expected shape"),
		)
		expect(malformedWarns).toHaveLength(1)
		expect(String(malformedWarns[0][0])).toMatch(/evt-bad-1/)
	})

	it("malformed scoreDetails: stays silent when scoreDetails is absent (undefined)", async () => {
		warnSpy.mockClear()
		const col = makeAggregateCollection({
			results: [
				{
					eventId: "evt-clean",
					agentId: "agent-1",
					role: "assistant",
					body: "ok",
					timestamp: new Date("2026-04-09T10:30:00.000Z"),
					score: 0.5,
					// scoreDetails omitted entirely
				},
			],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: { agentId: "agent-1", query: "anything" },
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const malformedWarns = warnSpy.mock.calls.filter((c: unknown[]) =>
			String(c[0]).includes("rankFusion scoreDetails missing expected shape"),
		)
		expect(malformedWarns).toHaveLength(0)
	})

	// =========================================================================
	// Bi-temporal recall safety: bi-temporal wiring pipeline-level
	// assertions. The evidence document must cite these tests as proof that
	// `buildBitemporalFilter` is wired into standard, semantic, and hybrid
	// retrieval paths. Without these, the audit claim is undefended.
	// =========================================================================

	it("bi-temporal safety: semanticRecall pipeline includes $match(bitemporal) after $vectorSearch", async () => {
		const col = makeAggregateCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const asOf = new Date("2026-05-12T10:00:00.000Z")
		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "semantic query",
				asOf,
			},
			capabilities: {
				vectorSearch: true,
				textSearch: false,
				rankFusion: false,
				scoreFusion: false,
			},
		})

		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		// stage 0 = $vectorSearch, stage 1 = $match(bitemporal)
		expect(pipeline[0]?.$vectorSearch).toBeDefined()
		expect(pipeline[1]?.$match).toEqual({
			$and: [
				{
					$or: [{ validAt: { $exists: false } }, { validAt: { $lte: asOf } }],
				},
				{
					$or: [
						{ invalidAt: { $exists: false } },
						{ invalidAt: null },
						{ invalidAt: { $gt: asOf } },
					],
				},
			],
		})
	})

	it("bi-temporal safety: hybridRecall $rankFusion injects bi-temporal $match into BOTH vector and text inner pipelines", async () => {
		const col = makeAggregateCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const asOf = new Date("2026-05-12T10:00:00.000Z")
		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "hybrid query",
				asOf,
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		const rankFusion = pipeline[0]?.$rankFusion as {
			input?: {
				pipelines?: {
					vector?: Document[]
					text?: Document[]
				}
			}
		}
		const vectorInner = rankFusion?.input?.pipelines?.vector ?? []
		const textInner = rankFusion?.input?.pipelines?.text ?? []

		const hasBitemporalMatch = (inner: Document[]): boolean =>
			inner.some((stage) => {
				const m = stage.$match as
					| { $and?: Array<{ $or?: Array<Record<string, unknown>> }> }
					| undefined
				if (!m?.$and) {
					return false
				}
				const validAtClause = m.$and[0]?.$or?.some(
					(o: Record<string, unknown>) => "validAt" in o,
				)
				const invalidAtClause = m.$and[1]?.$or?.some(
					(o: Record<string, unknown>) => "invalidAt" in o,
				)
				return Boolean(validAtClause && invalidAtClause)
			})

		expect(hasBitemporalMatch(vectorInner)).toBe(true)
		expect(hasBitemporalMatch(textInner)).toBe(true)
	})

	// =========================================================================
	// Task 35 — gauss-decay root fix for Gate 3 miss 00ca467f.
	//
	// When the query contains a temporal token (via extractTemporalWindow),
	// the hybrid text-lane must inject an Atlas Search `near` operator on
	// `timestamp` into `compound.should` to boost in-window events. The
	// $rankFusion default 0.5/0.5 fusion weights are untouched — the boost
	// lives inside the text pipeline's own relevance score.
	//
	// Cited: https://www.mongodb.com/docs/atlas/atlas-search/near/ (near on
	// date with origin=ISODate + pivot=ms). See research doc for substitution
	// disclosure. MongoDB-native capability adoption MongoDB-native.
	// =========================================================================

	it("Task 35: hybrid text lane injects near-on-timestamp when temporal token is present (in March)", async () => {
		const col = makeAggregateCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "how many doctor's appointments in March",
				asOf: new Date("2026-05-12T00:00:00.000Z"),
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		const rankFusion = pipeline[0]?.$rankFusion as {
			input?: {
				pipelines?: {
					text?: Document[]
				}
			}
		}
		const textInner = rankFusion?.input?.pipelines?.text ?? []
		const searchStage = textInner[0]?.$search as
			| {
					compound?: {
						should?: Array<{
							near?: {
								path?: string
								origin?: Date
								pivot?: number
							}
						}>
					}
			  }
			| undefined
		const should = searchStage?.compound?.should ?? []
		const nearClause = should.find((s) => s.near !== undefined)
		expect(nearClause).toBeDefined()
		expect(nearClause!.near!.path).toBe("timestamp")
		expect(nearClause!.near!.origin).toBeInstanceOf(Date)
		// March 2026 first-of-month (most recent past March from May 2026).
		expect((nearClause!.near!.origin as Date).toISOString()).toBe(
			"2026-03-01T00:00:00.000Z",
		)
		// scaleDays=15 → pivot = 15 * 86_400_000 = 1_296_000_000 ms.
		expect(nearClause!.near!.pivot).toBe(15 * 86_400_000)
	})

	it("Task 35: hybrid text lane has NO near-on-timestamp when no temporal token is present", async () => {
		const col = makeAggregateCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "deployment timeline for the service",
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		const rankFusion = pipeline[0]?.$rankFusion as {
			input?: { pipelines?: { text?: Document[] } }
		}
		const searchStage = (rankFusion?.input?.pipelines?.text?.[0]?.$search ??
			{}) as {
			compound?: {
				should?: Array<{ near?: unknown }>
			}
		}
		const should = searchStage.compound?.should ?? []
		expect(should.find((s) => s.near !== undefined)).toBeUndefined()
	})

	it("Task 35: near pivot milliseconds = scaleDays * 86_400_000 for relative-week (3 days)", async () => {
		const col = makeAggregateCollection({ results: [] })
		vi.mocked(eventsCollection).mockReturnValue(col)

		await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId: "agent-1",
				query: "what did we decide last week",
				asOf: new Date("2026-05-12T00:00:00.000Z"),
			},
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: false,
			},
		})

		const pipeline = vi.mocked(col.aggregate).mock.calls[0]?.[0] as Document[]
		const rankFusion = pipeline[0]?.$rankFusion as {
			input?: { pipelines?: { text?: Document[] } }
		}
		const searchStage = rankFusion?.input?.pipelines?.text?.[0]?.$search as
			| {
					compound?: { should?: Array<{ near?: { pivot?: number } }> }
			  }
			| undefined
		const should = searchStage?.compound?.should ?? []
		const nearClause = should.find((s) => s.near !== undefined)
		expect(nearClause).toBeDefined()
		expect(nearClause!.near!.pivot).toBe(3 * 86_400_000)
	})

	it("bi-temporal safety: standardRecall find() excludes memories invalidAt <= asOf", async () => {
		// This is an integration-style unit test: two docs, one invalid,
		// one valid — assert only the valid one returns after filter.
		const asOf = new Date("2026-05-12T10:00:00.000Z")
		const validDoc = {
			eventId: "evt-valid",
			agentId: "agent-1",
			role: "user",
			body: "hello",
			timestamp: new Date("2026-05-12T09:00:00.000Z"),
			invalidAt: null,
		}
		const invalidDoc = {
			eventId: "evt-invalid",
			agentId: "agent-1",
			role: "user",
			body: "stale",
			timestamp: new Date("2026-05-12T09:00:00.000Z"),
			invalidAt: new Date("2026-05-12T08:00:00.000Z"),
		}
		// `find()` mock applies the filter via the helper's impl.
		const col = makeFindCollection({
			findImpl: (filter: Document) => {
				const results = [validDoc, invalidDoc].filter((d) => {
					// Emulate MongoDB filter evaluation for bi-temporal clause.
					if (!filter.$and) {
						return true
					}
					// Each $and entry is { $and: [validAt-branch, invalidAt-branch] }
					const outer = filter.$and[0]?.$and as Document[] | undefined
					if (!outer) {
						return true
					}
					const [validBranch, invalidBranch] = outer
					const validOk = (validBranch.$or as Document[]).some(
						(clause: Document) => {
							if ("validAt" in clause) {
								const v = clause.validAt
								if (
									typeof v === "object" &&
									v &&
									"$exists" in v &&
									v.$exists === false
								) {
									return !("validAt" in d)
								}
								if (
									typeof v === "object" &&
									v &&
									"$lte" in v &&
									v.$lte instanceof Date
								) {
									const dAt = (d as unknown as { validAt?: Date }).validAt
									return dAt ? dAt <= v.$lte : true
								}
							}
							return false
						},
					)
					const invalidOk = (invalidBranch.$or as Document[]).some(
						(clause: Document) => {
							if ("invalidAt" in clause) {
								const v = clause.invalidAt
								if (
									typeof v === "object" &&
									v &&
									"$exists" in v &&
									v.$exists === false
								) {
									return !("invalidAt" in d)
								}
								if (v === null) {
									return d.invalidAt === null
								}
								if (
									typeof v === "object" &&
									v &&
									"$gt" in v &&
									v.$gt instanceof Date
								) {
									const inv = (d as unknown as { invalidAt?: Date | null })
										.invalidAt
									return inv instanceof Date && inv > v.$gt
								}
							}
							return false
						},
					)
					return validOk && invalidOk
				})
				return {
					sort: vi.fn(() => ({
						limit: vi.fn(() => ({ toArray: vi.fn(async () => results) })),
					})),
				}
			},
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: { agentId: "agent-1", asOf, limit: 10 },
		})

		expect(response.results).toHaveLength(1)
		expect(response.results[0]?.citation.eventId).toBe("evt-valid")
	})
})
