import type { Collection, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	findExactProcedureMatches,
	searchProcedures,
} from "./mongodb-procedures.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import {
	SearchBudgetDeniedError,
	SearchLaneError,
	type SearchTierOutcome,
} from "./search-outcomes.js"

const TEXT_INDEX = "test_procedures_text"

const withText: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
	queryableSearchIndexes: [TEXT_INDEX],
}

const doc = {
	procedureId: "rotate-auth",
	searchText: "Rotate auth keys",
	score: 0.9,
}

function serverError(): Error {
	const err = new Error("secret provider text")
	err.name = "MongoServerError"
	return Object.assign(err, { code: 2 })
}

type Behavior = (pipeline: Document[]) => Document[] | Error
function fixture(behavior: Behavior = () => [doc]) {
	const pipelines: Document[][] = []
	const collection = {
		aggregate: (pipeline: Document[]) => {
			pipelines.push(pipeline)
			return {
				toArray: async () => {
					const out = behavior(pipeline)
					if (out instanceof Error) throw out
					return out
				},
				explain: async () => {
					throw serverError()
				},
			}
		},
		find: () => ({ toArray: async () => [] }),
	} as unknown as Collection
	return { collection, pipelines }
}

const first = (pipeline: Document[]) => Object.keys(pipeline[0])[0]

async function run(
	collection: Collection,
	overrides: Partial<Parameters<typeof searchProcedures>[3]> = {},
	query = "rotate auth",
) {
	const rows: SearchTierOutcome[] = []
	const results = await searchProcedures(collection, query, null, {
		maxResults: 5,
		minScore: 0,
		capabilities: withText,
		vectorIndexName: "test_procedures_vector",
		textIndexName: TEXT_INDEX,
		embeddingMode: "automated",
		onTierOutcome: (row) => rows.push(row),
		...overrides,
	})
	return { results, rows }
}

describe("searchProcedures tiers (#101 matrix 1e)", () => {
	it("P1: no vector capability reports capability-absent and runs $search", async () => {
		const { collection, pipelines } = fixture()
		const { results, rows } = await run(collection, {
			capabilities: { ...withText, vectorSearch: false },
		})
		expect(results).toHaveLength(1)
		expect(pipelines.map(first)).toEqual(["$search"])
		expect(rows).toEqual([
			{
				stage: "vector",
				outcome: "not-applicable",
				reason: "capability-absent",
			},
			{ stage: "atlas-search", outcome: "ok", resultCount: 1 },
		])
	})

	it("P2: an embed denial is budget-denied and stops the lane", async () => {
		const { collection, pipelines } = fixture()
		const err = await runWithSearchBudget(
			{ maxAggregations: 5, maxEmbeds: 0 },
			() => run(collection),
		).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(SearchBudgetDeniedError)
		expect(err).toMatchObject({ stage: "vector", reason: "budget-embeds" })
		expect(pipelines).toHaveLength(0)
	})

	it("P2: an empty query is not-applicable/empty-query on both tiers", async () => {
		const { collection, pipelines } = fixture()
		const { results, rows } = await run(collection, {}, "")
		expect(results).toEqual([])
		expect(pipelines).toHaveLength(0)
		expect(rows).toEqual([
			{ stage: "vector", outcome: "not-applicable", reason: "empty-query" },
			{
				stage: "atlas-search",
				outcome: "not-applicable",
				reason: "empty-query",
			},
		])
	})

	it("P3: a failed explain is an explain row; results stand", async () => {
		const { collection } = fixture()
		const { results, rows } = await run(collection, {
			explain: { enabled: true },
		})
		expect(results).toHaveLength(1)
		expect(rows).toContainEqual({
			stage: "explain",
			outcome: "failed",
			reason: "query-error",
		})
	})

	it("P4: a refused aggregation is budget-denied, never a fall-through", async () => {
		const { collection, pipelines } = fixture()
		await expect(
			runWithSearchBudget({ maxAggregations: 0, maxEmbeds: 5 }, () =>
				run(collection),
			),
		).rejects.toMatchObject({ stage: "vector", reason: "budget-aggregations" })
		expect(pipelines).toHaveLength(0)
	})

	it("P4/P7: a vector zero-hit is ok-empty, then $search zero-hit is terminal ok-empty", async () => {
		const { collection, pipelines } = fixture(() => [])
		const { results, rows } = await run(collection)
		expect(results).toEqual([])
		expect(pipelines.map(first)).toEqual(["$vectorSearch", "$search"])
		expect(rows).toEqual([
			{
				stage: "vector",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
			{
				stage: "atlas-search",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("P5: a vector error is a typed failure; $search never runs", async () => {
		const { collection, pipelines } = fixture((pipeline) =>
			first(pipeline) === "$vectorSearch" ? serverError() : [doc],
		)
		const err = await run(collection).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(SearchLaneError)
		expect(err).toMatchObject({ stage: "vector", reason: "query-error" })
		expect((err as Error).message).not.toContain("secret")
		expect(pipelines.map(first)).toEqual(["$vectorSearch"])
	})

	it("P6: the $search tier is capability-absent when its index is not queryable", async () => {
		const { collection, pipelines } = fixture(() => [])
		const { rows } = await run(collection, {
			capabilities: { ...withText, queryableSearchIndexes: [] },
		})
		expect(pipelines.map(first)).toEqual(["$vectorSearch"])
		expect(rows.at(-1)).toEqual({
			stage: "atlas-search",
			outcome: "not-applicable",
			reason: "capability-absent",
		})
	})

	it("P6: with neither tier the lane is a typed lane-unavailable failure", async () => {
		const { collection, pipelines } = fixture()
		await expect(
			run(collection, {
				capabilities: { ...withText, vectorSearch: false, textSearch: false },
			}),
		).rejects.toMatchObject({ reason: "lane-unavailable" })
		expect(pipelines).toHaveLength(0)
	})

	it("P8: a $search error is a typed failure, never a $text fallback", async () => {
		const { collection, pipelines } = fixture((pipeline) =>
			first(pipeline) === "$search" ? serverError() : [],
		)
		await expect(run(collection)).rejects.toMatchObject({
			stage: "atlas-search",
			reason: "query-error",
		})
		expect(pipelines.map(first)).toEqual(["$vectorSearch", "$search"])
	})

	it("P9: no procedure $text query remains on any path", async () => {
		const { collection, pipelines } = fixture(() => [])
		await run(collection)
		await run(collection, {
			capabilities: { ...withText, vectorSearch: false },
		})
		expect(JSON.stringify(pipelines)).not.toContain("$text")
	})

	it("P10: the exact-match backstop reports an empty query", async () => {
		const { collection } = fixture()
		const rows: SearchTierOutcome[] = []
		const results = await findExactProcedureMatches(collection, "  ", {
			maxResults: 5,
			textIndexName: "procedures_text",
			onTierOutcome: (row) => rows.push(row),
		})
		expect(results).toEqual([])
		expect(rows).toEqual([
			{
				stage: "exact-match",
				outcome: "not-applicable",
				reason: "empty-query",
			},
		])
	})
})
