import type { Collection, Document } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
	mongoSearch,
	vectorSearch,
	type SearchTraceEvent,
} from "./mongodb-search.js"
import {
	runWithSearchBudget,
	tryConsumeSearchEmbed,
	tryReserveSearchBudget,
	tryConsumeSearchAggregation,
} from "./mongodb-search-budget.js"

const opts = {
	maxResults: 5,
	minScore: 0,
	fusionMethod: "scoreFusion" as const,
	vectorIndexName: "test_vector",
	textIndexName: "test_text",
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
function fixture(failFusion = false, emptyFusion = false) {
	const pipelines: Document[][] = []
	const collection = {
		aggregate: (pipeline: Document[]) => {
			pipelines.push(pipeline)
			return {
				toArray: async () => {
					if (pipeline[0].$scoreFusion || pipeline[0].$rankFusion) {
						if (failFusion) throw new Error("fusion unsupported")
						if (emptyFusion) return []
					}
					return [
						{
							path: "memory/hit",
							startLine: 1,
							endLine: 2,
							text: "garden plan",
							source: "conversation",
							score: 0.9,
						},
					]
				},
			}
		},
	} as unknown as Collection
	return { collection, pipelines }
}
beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

it.each([
	"scoreFusion",
	"rankFusion",
	"js-merge",
	"vector",
] as const)("%s embed denial keeps lexical evidence and records the reason", async (method) => {
	const { collection, pipelines } = fixture()
	const trace: SearchTraceEvent[] = []
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 4, maxEmbeds: 1 },
		async () => {
			tryConsumeSearchEmbed()
			return mongoSearch(collection, "garden plan", null, {
				...opts,
				fusionMethod: method === "vector" ? "scoreFusion" : method,
				capabilities:
					method === "vector"
						? { ...opts.capabilities, textSearch: false }
						: opts.capabilities,
				onTrace: (event) => {
					trace.push(event)
				},
			})
		},
	)
	expect(value).toHaveLength(method === "vector" ? 0 : 1)
	expect(pipelines).toHaveLength(method === "vector" ? 0 : 1)
	if (method !== "vector") expect(pipelines[0][0].$search).toBeDefined()
	expect(
		trace.filter((event) => event.message === "embedding budget exhausted"),
	).toHaveLength(1)
	expect(budget.embeds).toBe(1)
})
it("a fusion error using the last embed skips rankFusion and keeps keyword results", async () => {
	const { collection, pipelines } = fixture(true)
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 4, maxEmbeds: 1 },
		() => mongoSearch(collection, "garden plan", null, opts),
	)
	expect(value).toHaveLength(1)
	expect(pipelines).toHaveLength(2)
	expect(pipelines[0][0].$scoreFusion).toBeDefined()
	expect(pipelines[1][0].$search).toBeDefined()
	expect(budget).toMatchObject({ embeds: 1, aggregations: 2 })
})
it("a held embedding reservation stays reserved while keyword search runs", async () => {
	const { collection, pipelines } = fixture()
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 4, maxEmbeds: 1 },
		async () => {
			const reservation = tryReserveSearchBudget({ aggregations: 0, embeds: 1 })
			expect(reservation).toBeDefined()
			try {
				const result = await mongoSearch(collection, "garden plan", null, opts)
				expect(reservation?.tryConsumeEmbed()).toBe(true)
				return result
			} finally {
				reservation?.release()
			}
		},
	)
	expect(value).toHaveLength(1)
	expect(pipelines).toHaveLength(1)
	expect(budget.embeds).toBe(1)
})
it.each([
	"option",
	"environment",
])("strict %s rejects exhausted embedding capacity", async (strict) => {
	if (strict === "environment") vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
	const { collection, pipelines } = fixture()
	await expect(
		runWithSearchBudget({ maxAggregations: 4, maxEmbeds: 1 }, async () => {
			tryConsumeSearchEmbed()
			return mongoSearch(collection, "garden plan", null, {
				...opts,
				strictNoFallback: strict === "option",
			})
		}),
	).rejects.toThrow("search fallback disabled: embedding budget exhausted")
	expect(pipelines).toHaveLength(0)
})
it("a genuine executed fusion empty remains final", async () => {
	const { collection, pipelines } = fixture(false, true)
	expect(await mongoSearch(collection, "garden plan", null, opts)).toEqual([])
	expect(pipelines).toHaveLength(1)
})
it.each([
	false,
	true,
])("deadline refusal (capacity also exhausted=%s) stays distinct and cannot query", async (capacity) => {
	vi.useFakeTimers()
	try {
		const { collection, pipelines } = fixture()
		const trace: SearchTraceEvent[] = []
		const { value } = await runWithSearchBudget(
			{ maxAggregations: 4, maxEmbeds: 1, maxWallMs: 1 },
			async () => {
				if (capacity) tryConsumeSearchEmbed()
				vi.advanceTimersByTime(2)
				return mongoSearch(collection, "garden plan", null, {
					...opts,
					strictNoFallback: true,
					onTrace: (e) => {
						trace.push(e)
					},
				})
			},
		)
		expect(value).toEqual([])
		expect(pipelines).toHaveLength(0)
		expect(trace.some((e) => e.message === "embedding budget exhausted")).toBe(
			false,
		)
	} finally {
		vi.useRealTimers()
	}
})
it("exhausted aggregation budget still blocks lexical fallback", async () => {
	const { collection, pipelines } = fixture()
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 1, maxEmbeds: 1 },
		async () => {
			tryConsumeSearchAggregation()
			tryConsumeSearchEmbed()
			return mongoSearch(collection, "garden plan", null, opts)
		},
	)
	expect(value).toEqual([])
	expect(pipelines).toHaveLength(0)
	expect(budget).toMatchObject({ embeds: 1, aggregations: 1 })
})
it("direct vector leaf preserves empty degradation by default", async () => {
	const { collection, pipelines } = fixture()
	const { value } = await runWithSearchBudget(
		{ maxAggregations: 4, maxEmbeds: 1 },
		async () => {
			tryConsumeSearchEmbed()
			return vectorSearch(collection, null, {
				maxResults: 5,
				minScore: 0,
				indexName: "test_vector",
				queryText: "garden plan",
			})
		},
	)
	expect(value).toEqual([])
	expect(pipelines).toHaveLength(0)
})
it("unbudgeted search still runs fusion normally", async () => {
	const { collection, pipelines } = fixture()
	expect(await mongoSearch(collection, "garden plan", null, opts)).toHaveLength(
		1,
	)
	expect(pipelines[0][0].$scoreFusion).toBeDefined()
})
