import type { Collection, Document } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	buildVectorSearchStage,
	hybridSearchRankFusion,
	hybridSearchScoreFusion,
	mongoSearch,
	runSearchAggregateWithRetry,
	vectorSearch,
} from "./mongodb-search.js"
import {
	runWithSearchBudget,
	tryConsumeSearchEmbed,
} from "./mongodb-search-budget.js"
import {
	SearchBudgetDeniedError,
	SearchLaneError,
	type SearchTierOutcome,
} from "./search-outcomes.js"

const baseOpts = {
	maxResults: 5,
	minScore: 0,
	fusionMethod: "scoreFusion" as const,
	vectorIndexName: "test_vector",
	textIndexName: "test_text",
	embeddingMode: "automated" as const,
}

const hit = {
	path: "memory/hit",
	startLine: 1,
	endLine: 2,
	text: "garden plan",
	source: "conversation",
	score: 0.9,
}

function serverError(code = 2): Error {
	const err = new Error("provider text with secret query")
	err.name = "MongoServerError"
	return Object.assign(err, { code })
}

type Behavior = (pipeline: Document[]) => Document[] | Error
function fixture(behavior: Behavior = () => [hit]) {
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

const stageOf = (pipeline: Document[]): string => Object.keys(pipeline[0])[0]

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("S1-S3 runSearchAggregateWithRetry", () => {
	it("S1: a refused aggregation throws budget-denied instead of returning []", async () => {
		const { collection, pipelines } = fixture()
		await expect(
			runWithSearchBudget({ maxAggregations: 0, maxEmbeds: 5 }, () =>
				runSearchAggregateWithRetry(collection, [{ $search: {} }], {
					stage: "keyword",
				}),
			),
		).rejects.toMatchObject({
			name: "SearchBudgetDeniedError",
			stage: "keyword",
			reason: "budget-aggregations",
		})
		expect(pipelines).toHaveLength(0)
	})

	it("S2: a refused warmup-retry embed throws budget-embeds", async () => {
		let attempts = 0
		const { collection } = fixture(() => {
			attempts++
			return new Error("index NOT_STARTED")
		})
		await expect(
			runWithSearchBudget({ maxAggregations: 5, maxEmbeds: 0 }, () =>
				runSearchAggregateWithRetry(
					collection,
					[{ $vectorSearch: { query: { text: "q" } } }],
					{ stage: "vector", initialDelayMs: 0 },
				),
			),
		).rejects.toMatchObject({ reason: "budget-embeds", stage: "vector" })
		expect(attempts).toBe(1)
	})

	it("S3: exhausted warmup retries throw index-not-ready, typed and value-free", async () => {
		const { collection } = fixture(() => new Error("index is BUILDING secret"))
		const err = await runSearchAggregateWithRetry(
			collection,
			[{ $search: {} }],
			{
				stage: "keyword",
				maxAttempts: 2,
				initialDelayMs: 0,
			},
		).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(SearchLaneError)
		expect(err).toMatchObject({ stage: "keyword", reason: "index-not-ready" })
		expect((err as Error).message).not.toContain("secret")
	})

	it("S3: any other failure is rethrown for the caller's tier seam to type", async () => {
		const failure = serverError()
		const { collection } = fixture(() => failure)
		await expect(
			runSearchAggregateWithRetry(collection, [{ $search: {} }], {
				stage: "atlas-search",
			}),
		).rejects.toBe(failure)
	})
})

describe("S4-S8 vector stage and vector-bearing tiers", () => {
	it("S4: a refused stage embed throws budget-embeds, never returns null", async () => {
		await runWithSearchBudget(
			{ maxAggregations: 5, maxEmbeds: 0 },
			async () => {
				expect(() =>
					buildVectorSearchStage({
						queryVector: null,
						queryText: "q",
						embeddingMode: "automated",
						indexName: "v",
						numCandidates: 10,
						limit: 5,
					}),
				).toThrow(SearchBudgetDeniedError)
			},
		)
	})

	it("S5: no query text still yields a null stage (not a budget event)", () => {
		expect(
			buildVectorSearchStage({
				queryVector: null,
				queryText: null,
				embeddingMode: "automated",
				indexName: "v",
				numCandidates: 10,
				limit: 5,
			}),
		).toBeNull()
	})

	it.each([
		["S6 vectorSearch", "vector"],
		["S7 scoreFusion", "score-fusion"],
		["S8 rankFusion", "rank-fusion"],
	] as const)("%s reports not-applicable/empty-query for an empty query", async (_label, stage) => {
		const { collection, pipelines } = fixture()
		const rows: SearchTierOutcome[] = []
		const common = {
			...baseOpts,
			vectorWeight: 0.7,
			textWeight: 0.3,
			indexName: "v",
			queryText: "",
			onTierOutcome: (row: SearchTierOutcome) => rows.push(row),
		}
		const results =
			stage === "vector"
				? await vectorSearch(collection, null, common)
				: stage === "score-fusion"
					? await hybridSearchScoreFusion(collection, "", null, common)
					: await hybridSearchRankFusion(collection, "", null, common)
		expect(results).toEqual([])
		expect(pipelines).toHaveLength(0)
		expect(rows).toEqual([
			{ stage, outcome: "not-applicable", reason: "empty-query" },
		])
	})

	it.each([
		["S6 vectorSearch", "vector"],
		["S7 scoreFusion", "score-fusion"],
		["S8 rankFusion", "rank-fusion"],
	] as const)("%s propagates a budget denial at its stage", async (_label, stage) => {
		const { collection } = fixture()
		const common = {
			...baseOpts,
			vectorWeight: 0.7,
			textWeight: 0.3,
			indexName: "v",
			queryText: "garden",
		}
		await expect(
			runWithSearchBudget({ maxAggregations: 5, maxEmbeds: 0 }, () =>
				stage === "vector"
					? vectorSearch(collection, null, common)
					: stage === "score-fusion"
						? hybridSearchScoreFusion(collection, "garden", null, common)
						: hybridSearchRankFusion(collection, "garden", null, common),
			),
		).rejects.toMatchObject({ stage, reason: "budget-embeds" })
	})
})

describe("S9-S18 mongoSearch: one native operation, no fallback after a failure", () => {
	it("S9: a successful zero-hit ends the lane with ok-empty", async () => {
		const { collection, pipelines } = fixture(() => [])
		const rows: SearchTierOutcome[] = []
		const results = await mongoSearch(collection, "garden", null, {
			...baseOpts,
			onTierOutcome: (row) => rows.push(row),
		})
		expect(results).toEqual([])
		expect(pipelines).toHaveLength(1)
		expect(rows).toEqual([
			{
				stage: "score-fusion",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it.each([
		["scoreFusion", "score-fusion"],
		["rankFusion", "rank-fusion"],
	] as const)("S10: %s embed denial is budget-denied and runs no other query", async (method, stage) => {
		const { collection, pipelines } = fixture()
		const err = await runWithSearchBudget(
			{ maxAggregations: 5, maxEmbeds: 1 },
			async () => {
				tryConsumeSearchEmbed()
				return mongoSearch(collection, "garden", null, {
					...baseOpts,
					fusionMethod: method,
				})
			},
		).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(SearchBudgetDeniedError)
		expect(err).toMatchObject({ stage, reason: "budget-embeds" })
		expect(pipelines).toHaveLength(0)
	})

	it.each([
		[
			"S12 scoreFusion",
			{ fusionMethod: "scoreFusion" as const },
			"score-fusion",
			"$scoreFusion",
		],
		[
			"S12 rankFusion",
			{ fusionMethod: "rankFusion" as const },
			"rank-fusion",
			"$rankFusion",
		],
	] as const)("%s: an error stops the lane with a typed failure", async (_label, override, stage, failingStage) => {
		const { collection, pipelines } = fixture((pipeline) =>
			stageOf(pipeline) === failingStage ? serverError() : [hit],
		)
		const err = await mongoSearch(collection, "garden", null, {
			...baseOpts,
			...override,
		}).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(SearchLaneError)
		expect(err).toMatchObject({ stage, reason: "query-error" })
		expect(pipelines.map(stageOf)).toEqual([failingStage])
		expect(JSON.stringify(err)).not.toContain("secret")
	})
})

describe("S19 explain capture", () => {
	it("reports a failed explain as an explain row and keeps the results", async () => {
		const { collection } = fixture()
		const rows: SearchTierOutcome[] = []
		const results = await hybridSearchScoreFusion(collection, "garden", null, {
			...baseOpts,
			vectorWeight: 0.7,
			textWeight: 0.3,
			explain: { enabled: true },
			onTierOutcome: (row) => rows.push(row),
		})
		expect(results).toHaveLength(1)
		expect(rows).toEqual([
			{ stage: "explain", outcome: "failed", reason: "query-error" },
		])
	})
})
