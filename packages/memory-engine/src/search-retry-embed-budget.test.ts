import type { Collection, Document } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
	buildVectorSearchStage,
	mongoSearch,
	runSearchAggregateWithRetry,
	vectorSearch,
} from "./mongodb-search.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"

const docs = [{ path: "memory/hit", text: "graphite", score: 0.9 }]
function fixture(warmups = 2, message = "index NOT_STARTED") {
	const aggregate = vi.fn((pipeline: Document[]) => ({
		toArray: async () => {
			const vector =
				pipeline[0].$vectorSearch ||
				pipeline[0].$rankFusion ||
				pipeline[0].$scoreFusion
			if (vector && warmups-- > 0) throw new Error(message)
			return docs
		},
	}))
	return { col: { aggregate } as unknown as Collection, aggregate }
}
const opts = {
	maxResults: 5,
	minScore: 0,
	vectorIndexName: "vector",
	textIndexName: "text",
	embeddingMode: "automated" as const,
	capabilities: {
		vectorSearch: true,
		textSearch: true,
		scoreFusion: true,
		rankFusion: true,
		storedSource: false,
		vectorIndexMethod: false,
	},
}
beforeEach(() => {
	vi.useFakeTimers()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})
async function settle<T>(task: Promise<T>): Promise<T> {
	const caught = task.then(
		(value) => ({ value }),
		(error) => ({ error }),
	)
	await vi.runAllTimersAsync()
	const result = await caught
	if ("error" in result) throw result.error
	return result.value
}
it("charges the automated vector embedding on every warmup attempt", async () => {
	const { col, aggregate } = fixture()
	const { budget } = await settle(
		runWithSearchBudget({ maxEmbeds: 5, maxAggregations: 10 }, () =>
			vectorSearch(col, null, {
				...opts,
				indexName: "vector",
				queryText: "graphite",
			}),
		),
	)
	expect(aggregate).toHaveBeenCalledTimes(3)
	expect(budget.aggregations).toBe(3)
	expect(budget.embeds).toBe(3)
})
it("counts each automated fusion input while leaving manual vectors uncharged", async () => {
	const { col, aggregate } = fixture(1)
	const { budget } = await settle(
		runWithSearchBudget({ maxEmbeds: 5, maxAggregations: 10 }, () => {
			const stage = () =>
				buildVectorSearchStage({
					queryVector: null,
					queryText: "graphite",
					embeddingMode: "automated",
					indexName: "vector",
					limit: 5,
					numCandidates: 100,
				})
			return runSearchAggregateWithRetry(
				col,
				[
					{
						$rankFusion: {
							input: {
								pipelines: {
									a: [{ $vectorSearch: stage() }],
									b: [{ $vectorSearch: stage() }],
									manual: [{ $vectorSearch: { queryVector: [1, 0] } }],
								},
							},
						},
					},
				],
				{ initialDelayMs: 1 },
			)
		}),
	)
	expect(aggregate).toHaveBeenCalledTimes(2)
	expect(budget.embeds).toBe(4)
})
it.each([
	"scoreFusion",
	"rankFusion",
	"js-merge",
] as const)("retry denial keeps lexical fallback for %s", async (fusionMethod) => {
	const { col, aggregate } = fixture(99)
	const { value, budget } = await settle(
		runWithSearchBudget({ maxEmbeds: 1, maxAggregations: 10 }, () =>
			mongoSearch(col, "graphite", null, { ...opts, fusionMethod }),
		),
	)
	expect(value).toHaveLength(1)
	expect(budget.embeds).toBe(1)
	const vectorCalls = aggregate.mock.calls.filter(
		([p]) => p[0].$vectorSearch || p[0].$rankFusion || p[0].$scoreFusion,
	)
	expect(vectorCalls).toHaveLength(1)
})
it("strict retry denial rejects instead of executing another embedding", async () => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
	const { col, aggregate } = fixture(99)
	await expect(
		settle(
			runWithSearchBudget({ maxEmbeds: 1, maxAggregations: 10 }, () =>
				mongoSearch(col, "graphite", null, {
					...opts,
					fusionMethod: "scoreFusion",
				}),
			),
		),
	).rejects.toThrow("embedding budget exhausted")
	expect(aggregate).toHaveBeenCalledTimes(1)
})
it("direct retry denial preserves empty degradation without a hook", async () => {
	const { col, aggregate } = fixture(99)
	const { value, budget } = await settle(
		runWithSearchBudget({ maxEmbeds: 1, maxAggregations: 10 }, () =>
			vectorSearch(col, null, {
				...opts,
				indexName: "vector",
				queryText: "graphite",
			}),
		),
	)
	expect(value).toEqual([])
	expect(aggregate).toHaveBeenCalledTimes(1)
	expect(budget.embeds).toBe(1)
})
it("aggregation refusal prevents any retry embed charge", async () => {
	const { col, aggregate } = fixture(99)
	const { value, budget } = await settle(
		runWithSearchBudget({ maxEmbeds: 5, maxAggregations: 1 }, () =>
			vectorSearch(col, null, {
				...opts,
				indexName: "vector",
				queryText: "graphite",
			}),
		),
	)
	expect(value).toEqual([])
	expect(aggregate).toHaveBeenCalledTimes(1)
	expect(budget.embeds).toBe(1)
})
it.each([
	0, 1,
])("no extra charge for success or non-warmup failure: %s", async (failures) => {
	const { col, aggregate } = fixture(failures, "ordinary failure")
	const { budget } = await settle(
		runWithSearchBudget({ maxEmbeds: 5, maxAggregations: 10 }, async () => {
			try {
				await vectorSearch(col, null, {
					...opts,
					indexName: "vector",
					queryText: "graphite",
				})
			} catch (error) {
				expect((error as Error).message).toBe("ordinary failure")
			}
		}),
	)
	expect(aggregate).toHaveBeenCalledTimes(1)
	expect(budget.embeds).toBe(1)
})
it("manual vector warmup retry consumes no embeddings", async () => {
	const { col, aggregate } = fixture(1)
	const { budget } = await settle(
		runWithSearchBudget({ maxEmbeds: 0, maxAggregations: 10 }, () =>
			runSearchAggregateWithRetry(
				col,
				[{ $vectorSearch: { queryVector: [1, 0] } }],
				{ initialDelayMs: 1 },
			),
		),
	)
	expect(aggregate).toHaveBeenCalledTimes(2)
	expect(budget.embeds).toBe(0)
})
