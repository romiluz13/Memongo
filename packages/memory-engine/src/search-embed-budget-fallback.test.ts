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
	"vector",
] as const)("#101: %s embed denial is a typed budget denial and runs no lexical tier", async (method) => {
	const { collection, pipelines } = fixture()
	const trace: SearchTraceEvent[] = []
	await expect(
		runWithSearchBudget({ maxAggregations: 4, maxEmbeds: 1 }, async () => {
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
		}),
	).rejects.toMatchObject({
		name: "SearchBudgetDeniedError",
		reason: "budget-embeds",
	})
	expect(pipelines).toHaveLength(0)
	expect(trace.filter((event) => event.ok)).toHaveLength(0)
})
it("js-merge embed denial keeps the keyword branch and records the vector denial", async () => {
	const { collection, pipelines } = fixture()
	const trace: SearchTraceEvent[] = []
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 4, maxEmbeds: 1 },
		async () => {
			tryConsumeSearchEmbed()
			return mongoSearch(collection, "garden plan", null, {
				...opts,
				fusionMethod: "js-merge",
				onTrace: (event) => {
					trace.push(event)
				},
			})
		},
	)
	expect(value).toHaveLength(1)
	expect(pipelines).toHaveLength(1)
	expect(pipelines[0][0].$search).toBeDefined()
	expect(
		trace.filter((event) => event.message === "embedding budget exhausted"),
	).toHaveLength(1)
	expect(budget.embeds).toBe(1)
})
it("#101: a fusion error stops the lane; keyword never runs", async () => {
	const { collection, pipelines } = fixture(true)
	await expect(
		runWithSearchBudget({ maxAggregations: 4, maxEmbeds: 1 }, () =>
			mongoSearch(collection, "garden plan", null, opts),
		),
	).rejects.toMatchObject({ name: "SearchLaneError", stage: "score-fusion" })
	expect(pipelines).toHaveLength(1)
	expect(pipelines[0][0].$scoreFusion).toBeDefined()
})
it("a held embedding reservation stays reserved; the lane is budget-denied", async () => {
	const { collection, pipelines } = fixture()
	const { budget } = await runWithSearchBudget(
		{ maxAggregations: 4, maxEmbeds: 1 },
		async () => {
			const reservation = tryReserveSearchBudget({ aggregations: 0, embeds: 1 })
			expect(reservation).toBeDefined()
			try {
				await expect(
					mongoSearch(collection, "garden plan", null, opts),
				).rejects.toMatchObject({ reason: "budget-embeds" })
				expect(reservation?.tryConsumeEmbed()).toBe(true)
			} finally {
				reservation?.release()
			}
		},
	)
	expect(pipelines).toHaveLength(0)
	expect(budget.embeds).toBe(1)
})
it.each([
	"option",
	"environment",
])("strict %s rejects exhausted embedding capacity with the same typed denial", async (strict) => {
	if (strict === "environment") vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
	const { collection, pipelines } = fixture()
	await expect(
		runWithSearchBudget({ maxAggregations: 4, maxEmbeds: 1 }, async () => {
			tryConsumeSearchEmbed()
			return mongoSearch(collection, "garden plan", null, opts)
		}),
	).rejects.toMatchObject({ reason: "budget-embeds" })
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
])("deadline refusal (capacity also exhausted=%s) is budget-deadline and cannot query", async (capacity) => {
	vi.useFakeTimers()
	try {
		const { collection, pipelines } = fixture()
		const trace: SearchTraceEvent[] = []
		await expect(
			runWithSearchBudget(
				{ maxAggregations: 4, maxEmbeds: 1, maxWallMs: 1 },
				async () => {
					if (capacity) tryConsumeSearchEmbed()
					vi.advanceTimersByTime(2)
					return mongoSearch(collection, "garden plan", null, {
						...opts,
						onTrace: (e) => {
							trace.push(e)
						},
					})
				},
			),
		).rejects.toMatchObject({ reason: "budget-deadline" })
		expect(pipelines).toHaveLength(0)
		expect(trace.some((e) => e.message === "embedding budget exhausted")).toBe(
			false,
		)
	} finally {
		vi.useRealTimers()
	}
})
it("exhausted budget sends no query and is a typed denial", async () => {
	const { collection, pipelines } = fixture()
	await expect(
		runWithSearchBudget({ maxAggregations: 1, maxEmbeds: 1 }, async () => {
			tryConsumeSearchAggregation()
			tryConsumeSearchEmbed()
			return mongoSearch(collection, "garden plan", null, opts)
		}),
	).rejects.toBeInstanceOf(Error)
	expect(pipelines).toHaveLength(0)
})
it("#101: a direct vector leaf denial is typed, not an empty result", async () => {
	const { collection, pipelines } = fixture()
	await expect(
		runWithSearchBudget({ maxAggregations: 4, maxEmbeds: 1 }, async () => {
			tryConsumeSearchEmbed()
			return vectorSearch(collection, null, {
				maxResults: 5,
				minScore: 0,
				indexName: "test_vector",
				queryText: "garden plan",
			})
		}),
	).rejects.toMatchObject({ stage: "vector", reason: "budget-embeds" })
	expect(pipelines).toHaveLength(0)
})
it("unbudgeted search still runs fusion normally", async () => {
	const { collection, pipelines } = fixture()
	expect(await mongoSearch(collection, "garden plan", null, opts)).toHaveLength(
		1,
	)
	expect(pipelines[0][0].$scoreFusion).toBeDefined()
})
