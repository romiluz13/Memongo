import type { Collection, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import { searchKB } from "./mongodb-kb-search.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import {
	SearchBudgetDeniedError,
	SearchLaneError,
	type SearchTierOutcome,
} from "./search-outcomes.js"

const hit = { path: "a.md", text: "hit", startLine: 1, endLine: 2, score: 0.9 }

function serverError(): Error {
	const err = new Error("secret provider text")
	err.name = "MongoServerError"
	return Object.assign(err, { code: 2 })
}

type Behavior = (pipeline: Document[]) => Document[] | Error
function fixture(behavior: Behavior = () => []) {
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
	} as unknown as Collection
	return { collection, pipelines }
}

const first = (pipeline: Document[]) => Object.keys(pipeline[0])[0]

const FUSIONS = [
	["scoreFusion", "$scoreFusion", "score-fusion"],
	["rankFusion", "$rankFusion", "rank-fusion"],
] as const

async function run(
	collection: Collection,
	overrides: Partial<Parameters<typeof searchKB>[3]> = {},
	query = "kb query",
) {
	const rows: SearchTierOutcome[] = []
	const results = await searchKB(collection, query, null, {
		maxResults: 5,
		minScore: 0.1,
		scopeRef: "agent:test",
		vectorIndexName: "kb_vector",
		textIndexName: "kb_text",
		embeddingMode: "automated",
		fusionMethod: "rankFusion",
		onTierOutcome: (row) => rows.push(row),
		...overrides,
	})
	return { results, rows }
}

describe("searchKB outcomes (#101 matrix 1f, M2 decision 5)", () => {
	it("K1: a filter that matches no document is a successful empty", async () => {
		const { collection, pipelines } = fixture()
		const kbDocs = {
			find: () => ({ limit: () => ({ toArray: async () => [] }) }),
		} as unknown as Collection
		const { results, rows } = await run(collection, {
			kbDocs,
			filter: { category: "none" },
		})
		expect(results).toEqual([])
		expect(pipelines).toHaveLength(0)
		expect(rows).toEqual([
			{
				stage: "filter",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("K3: a failed explain is an explain row; results stand", async () => {
		const { collection } = fixture(() => [hit])
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

	describe.each(FUSIONS)("%s", (fusionMethod, fusionStage, stage) => {
		it("a healthy zero hit is final: one fused aggregate, no cascade to a weaker tier", async () => {
			const { collection, pipelines } = fixture()
			const { results, rows } = await run(collection, { fusionMethod })
			expect(results).toEqual([])
			// The old waterfall ran fusion, then vector, then keyword (then
			// $text) after a zero here.
			expect(pipelines.map(first)).toEqual([fusionStage])
			expect(JSON.stringify(pipelines)).not.toContain('"$text"')
			expect(rows).toEqual([
				{ stage, outcome: "ok-empty", reason: "zero-hits", resultCount: 0 },
			])
		})

		it("a fusion error is a typed failure; no weaker tier runs and no row claims success", async () => {
			// Everything except the configured fusion would succeed: a
			// surviving fallback would show up as a result or a second pipeline.
			const { collection, pipelines } = fixture((pipeline) =>
				first(pipeline) === fusionStage ? serverError() : [hit],
			)
			const err = await run(collection, { fusionMethod }).catch(
				(e: unknown) => e,
			)
			expect(err).toBeInstanceOf(SearchLaneError)
			expect(err).toMatchObject({ stage, reason: "query-error" })
			expect((err as Error).message).not.toContain("secret")
			expect(pipelines.map(first)).toEqual([fusionStage])
		})

		it("a refused embed is a typed budget denial; nothing executes", async () => {
			const { collection, pipelines } = fixture()
			const err = await runWithSearchBudget(
				{ maxAggregations: 5, maxEmbeds: 0 },
				() => run(collection, { fusionMethod }),
			).catch((e: unknown) => e)
			expect(err).toBeInstanceOf(SearchBudgetDeniedError)
			expect(err).toMatchObject({ stage, reason: "budget-embeds" })
			expect(pipelines).toHaveLength(0)
		})

		it("a refused aggregation is a typed budget denial; no off-ledger aggregate runs", async () => {
			const { collection, pipelines } = fixture(() => [hit])
			const err = await runWithSearchBudget(
				{ maxAggregations: 0, maxEmbeds: 5 },
				() => run(collection, { fusionMethod }),
			).catch((e: unknown) => e)
			expect(err).toBeInstanceOf(SearchBudgetDeniedError)
			expect(err).toMatchObject({ stage, reason: "budget-aggregations" })
			expect(pipelines).toHaveLength(0)
		})

		it("an empty query is not-applicable and runs nothing", async () => {
			const { collection, pipelines } = fixture(() => [hit])
			const { results, rows } = await run(collection, { fusionMethod }, "")
			expect(results).toEqual([])
			expect(pipelines).toHaveLength(0)
			expect(rows).toEqual([
				{ stage, outcome: "not-applicable", reason: "empty-query" },
			])
		})
	})

	describe("removed alternatives", () => {
		it.each([
			"js-merge",
			"application",
			"",
		])("fusionMethod %j is a typed failure before any database access", async (fusionMethod) => {
			const { collection, pipelines } = fixture(() => [hit])
			let kbDocsTouched = false
			const kbDocs = {
				find: () => {
					kbDocsTouched = true
					throw new Error("kbDocs must not be read")
				},
			} as unknown as Collection
			const rows: SearchTierOutcome[] = []
			const err = await searchKB(collection, "kb query", null, {
				maxResults: 5,
				minScore: 0.1,
				scopeRef: "agent:test",
				vectorIndexName: "kb_vector",
				textIndexName: "kb_text",
				embeddingMode: "automated",
				filter: { tags: ["docs"] },
				kbDocs,
				// biome-ignore lint/suspicious/noExplicitAny: the engine must reject values the type no longer promises
				fusionMethod: fusionMethod as any,
				onTierOutcome: (row) => rows.push(row),
			}).catch((e: unknown) => e)
			expect(err).toBeInstanceOf(SearchLaneError)
			expect(err).toMatchObject({
				lane: "kb",
				stage: "plan",
				reason: "query-error",
			})
			// No JavaScript merge of two branches, no survivor, no fallback.
			expect(pipelines).toHaveLength(0)
			expect(kbDocsTouched).toBe(false)
			expect(rows).toEqual([])
		})

		it("no capability or deployment flag can bring back a vector-only, keyword-only or $text tier", async () => {
			const { collection, pipelines } = fixture(() => [])
			await run(collection, {
				...({
					capabilities: {
						vectorSearch: false,
						textSearch: false,
						scoreFusion: false,
						rankFusion: false,
						storedSource: false,
						vectorIndexMethod: false,
					},
					skipVectorLane: true,
					strict: false,
				} as object),
			})
			expect(pipelines.map(first)).toEqual(["$rankFusion"])
			expect(JSON.stringify(pipelines)).not.toContain('"$text"')
		})
	})

	describe("filters never widen", () => {
		it("a requested filter with no kbDocs collection is a typed failure and nothing is searched", async () => {
			const { collection, pipelines } = fixture(() => [hit])
			const rows: SearchTierOutcome[] = []
			const err = await searchKB(collection, "kb query", null, {
				maxResults: 5,
				minScore: 0.1,
				scopeRef: "agent:test",
				vectorIndexName: "kb_vector",
				textIndexName: "kb_text",
				embeddingMode: "automated",
				filter: { tags: ["docs"], category: "architecture" },
				onTierOutcome: (row) => rows.push(row),
			}).catch((e: unknown) => e)
			expect(err).toBeInstanceOf(SearchLaneError)
			expect(err).toMatchObject({
				lane: "kb",
				stage: "filter",
				reason: "internal-error",
			})
			// The old code logged a warning, dropped the filter and searched
			// the whole scope.
			expect(pipelines).toHaveLength(0)
			expect(rows).toEqual([])
		})

		it("a kbDocs read that fails is a typed failure at the filter stage; nothing is searched", async () => {
			const { collection, pipelines } = fixture(() => [hit])
			const networkError = new Error("connection reset")
			networkError.name = "MongoNetworkError"
			const kbDocs = {
				find: () => ({
					limit: () => ({
						toArray: async () => {
							throw networkError
						},
					}),
				}),
			} as unknown as Collection
			const err = await run(collection, {
				kbDocs,
				filter: { source: "file" },
			}).catch((e: unknown) => e)
			expect(err).toBeInstanceOf(SearchLaneError)
			expect(err).toMatchObject({
				lane: "kb",
				stage: "filter",
				reason: "dependency-unavailable",
			})
			expect(pipelines).toHaveLength(0)
		})
	})
})
