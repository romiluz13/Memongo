/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
}))

import { recallConversation } from "./mongodb-conversation-recall.js"
import { eventsCollection } from "./mongodb-schema.js"

function mockDb(): Db {
	return {} as Db
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

		expect(col.find).toHaveBeenCalledWith({
			agentId: "agent-1",
			role: { $in: ["tool"] },
			timestamp: {
				$lte: expect.any(Date),
			},
		})
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

		expect(col.find).toHaveBeenCalledWith({
			agentId: "agent-1",
			role: { $ne: "tool" },
			body: { $regex: /phoenix\+launch\?/i },
			timestamp: {
				$lte: expect.any(Date),
			},
		})
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

		expect(col.find).toHaveBeenCalledWith({
			agentId: "agent-1",
			role: { $in: ["user"] },
			timestamp: {
				$lte: expect.any(Date),
			},
		})
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
})
