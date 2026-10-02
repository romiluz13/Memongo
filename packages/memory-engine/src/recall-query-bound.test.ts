import type { Collection, Db, Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-schema.js", () => ({ eventsCollection: vi.fn() }))
vi.mock("./mongodb-telemetry.js", () => ({ emitTelemetry: vi.fn() }))
import { recallConversation } from "./mongodb-conversation-recall.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { eventsCollection } from "./mongodb-schema.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { MAX_SEARCH_QUERY_LENGTH } from "./mongodb-search-ranking.js"

const head = "a".repeat(MAX_SEARCH_QUERY_LENGTH)
const longQuery = `  ${head} TAILMARK  `
const capabilities = {
	vectorSearch: true,
	textSearch: true,
	rankFusion: true,
	scoreFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}
let pipelines: Document[][] = []
let filters: Document[] = []
const result = {
	eventId: "event1",
	role: "user",
	agentId: "a1",
	body: "result",
	timestamp: new Date("2026-01-01T00:00:00Z"),
}

describe("recall query execution bounds", () => {
	beforeEach(() => {
		pipelines = []
		filters = []
		resetSearchAdmissionForTests(Date.now())
		vi.mocked(eventsCollection).mockReturnValue({
			aggregate: vi.fn((pipeline: Document[]) => {
				pipelines.push(pipeline)
				return { toArray: async () => [result] }
			}),
			find: vi.fn((filter: Document) => {
				filters.push(filter)
				return {
					sort: () => ({ limit: () => ({ toArray: async () => [result] }) }),
				}
			}),
		} as unknown as Collection)
	})
	afterEach(() => vi.clearAllMocks())
	it.each([
		"hybrid",
		"semantic",
		"standard",
	] as const)("bounds the actual %s query and metadata", async (lane) => {
		const response = await recallConversation({
			db: {} as Db,
			prefix: "test_",
			request: { agentId: "a1", query: longQuery },
			capabilities: {
				...capabilities,
				rankFusion: lane === "hybrid",
				vectorSearch: lane !== "standard",
			},
		})
		expect(response.metadata.searchMethod).toBe(lane)
		expect(response.metadata.queryUsed).toBe(head)
		expect(emitTelemetry).toHaveBeenCalledExactlyOnceWith(
			{},
			"test_",
			expect.objectContaining({
				meta: { agentId: "a1", operation: "search-query-clamped" },
				queryLength: longQuery.trim().length,
			}),
		)
		if (lane === "standard") {
			expect(filters[0]?.body?.$regex).toBeInstanceOf(RegExp)
			expect(filters[0]?.body?.$regex.source).toBe(head)
		} else {
			if (lane === "semantic") {
				expect(pipelines[0]?.[0]?.$vectorSearch?.query?.text).toBe(head)
			} else {
				const inner = pipelines[0]?.[0]?.$rankFusion?.input?.pipelines
				expect(inner?.vector?.[0]?.$vectorSearch?.query?.text).toBe(head)
				expect(
					inner?.text?.[0]?.$search?.compound?.must?.[0]?.text?.query,
				).toBe(head)
			}
		}
	})
	it.each([
		undefined,
		"",
		"   ",
		" today ",
		head,
	])("preserves optional and bounded query handling (case %#)", async (query) => {
		const response = await recallConversation({
			db: {} as Db,
			prefix: "test_",
			request: { agentId: "a1", query },
			capabilities: { ...capabilities, vectorSearch: false, rankFusion: false },
		})
		expect(response.metadata.queryUsed).toBe(query?.trim() || undefined)
		if (!query?.trim()) expect(filters[0]).not.toHaveProperty("body")
		expect(emitTelemetry).not.toHaveBeenCalled()
	})
	it("bounds the query echo before an inverted date range returns without reads", async () => {
		const response = await recallConversation({
			db: {} as Db,
			prefix: "test_",
			request: {
				agentId: "a1",
				query: longQuery,
				startTime: "2026-01-02T00:00:00Z",
				endTime: "2026-01-01T00:00:00Z",
			},
			capabilities,
		})
		expect(response.results).toEqual([])
		expect(response.metadata.queryUsed).toBe(head)
		expect(pipelines).toHaveLength(0)
		expect(filters).toHaveLength(0)
		expect(emitTelemetry).toHaveBeenCalledTimes(1)
	})
	it("measures trimmed input and leaves the caller request untouched", async () => {
		const request = Object.freeze({ agentId: "a1", query: `  ${head}x  ` })
		const response = await recallConversation({
			db: {} as Db,
			prefix: "test_",
			request,
			capabilities: { ...capabilities, vectorSearch: false },
		})
		expect(request.query).toBe(`  ${head}x  `)
		expect(response.metadata.queryUsed).toBe(head)
		expect(emitTelemetry).toHaveBeenCalledExactlyOnceWith(
			{},
			"test_",
			expect.objectContaining({ queryLength: 2001 }),
		)
	})
})
