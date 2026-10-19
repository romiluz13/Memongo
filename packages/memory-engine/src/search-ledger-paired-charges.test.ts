// #101 decision 18 (matrix section 6, item 6): an attempt that needs an
// embed and an aggregation charges both atomically, or neither. A refused
// half never leaves the other half spent.
import type { Collection, Db, Document } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { vectorSearch } from "./mongodb-search.js"
import {
	runWithSearchBudget,
	tryConsumeSearchAggregation,
} from "./mongodb-search-budget.js"
import { searchTurnEventsWithinSessions } from "./mongodb-search-lanes.js"
import { SearchBudgetDeniedError } from "./search-outcomes.js"

const capabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

function chunks(warmups = 0) {
	const aggregate = vi.fn((pipeline: Document[]) => ({
		toArray: async () => {
			if (pipeline[0].$vectorSearch && warmups-- > 0) {
				throw new Error("index NOT_STARTED")
			}
			return []
		},
	}))
	return { col: { aggregate } as unknown as Collection, aggregate }
}

function vectorLeaf(col: Collection) {
	return vectorSearch(col, null, {
		maxResults: 5,
		minScore: 0,
		indexName: "vector",
		queryText: "graphite",
		embeddingMode: "automated",
	})
}

beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

it("a vector stage whose aggregation is refused never spends its embed", async () => {
	const { col, aggregate } = chunks()
	let failure: unknown
	const { budget } = await runWithSearchBudget(
		{ maxAggregations: 1, maxEmbeds: 5 },
		async () => {
			tryConsumeSearchAggregation()
			failure = await vectorLeaf(col).catch((err: unknown) => err)
		},
	)
	expect(failure).toBeInstanceOf(SearchBudgetDeniedError)
	expect(failure).toMatchObject({
		stage: "vector",
		reason: "budget-aggregations",
	})
	expect(aggregate).not.toHaveBeenCalled()
	expect(budget.aggregations).toBe(1)
	expect(budget.embeds).toBe(0)
})

it("a warmup retry whose re-embed is refused never spends its aggregation", async () => {
	vi.useFakeTimers()
	const { col, aggregate } = chunks(1)
	const caught = runWithSearchBudget(
		{ maxAggregations: 10, maxEmbeds: 1 },
		async () => vectorLeaf(col).catch((err: unknown) => err),
	)
	await vi.runAllTimersAsync()
	const { value: failure, budget } = await caught
	expect(failure).toMatchObject({ stage: "vector", reason: "budget-embeds" })
	expect(aggregate).toHaveBeenCalledTimes(1)
	expect(budget.aggregations).toBe(1)
	expect(budget.embeds).toBe(1)
})

it("an event fusion whose embed is refused never spends its aggregation", async () => {
	const pipelines: Document[][] = []
	const db = {
		collection: () => ({
			aggregate: (pipeline: Document[]) => {
				pipelines.push(pipeline)
				return { toArray: async () => [] }
			},
		}),
	} as unknown as Db
	let failure: unknown
	const { budget } = await runWithSearchBudget(
		{ maxAggregations: 10, maxEmbeds: 0 },
		async () => {
			failure = await searchTurnEventsWithinSessions({
				db,
				prefix: "test_",
				query: "what did we plan",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				sessionIds: ["s1"],
				maxResults: 5,
				numCandidates: 100,
				capabilities: { ...capabilities, rankFusion: true },
				embeddingMode: "automated",
				queryEmbeddingModel: "voyage-4-large",
			}).catch((err: unknown) => err)
		},
	)
	// M2: the lane is one fused aggregate charged as a pair; a refused embed
	// is a typed denial, nothing runs, and no text-only branch stands in.
	expect(failure).toMatchObject({
		name: "SearchBudgetDeniedError",
		stage: "rank-fusion",
		reason: "budget-embeds",
	})
	expect(pipelines).toHaveLength(0)
	expect(budget.aggregations).toBe(0)
	expect(budget.embeds).toBe(0)
})
