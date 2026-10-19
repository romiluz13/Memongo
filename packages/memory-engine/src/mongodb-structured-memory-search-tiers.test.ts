import type { Collection, Db, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	type DetectedCapabilities,
	detectCapabilities,
} from "./mongodb-schema.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import {
	SearchBudgetDeniedError,
	SearchLaneError,
	type SearchTierOutcome,
} from "./search-outcomes.js"

const TEXT_INDEX = "test_structured_mem_text"

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
	type: "fact",
	key: "camera",
	value: "User shoots with a Sony A7R IV",
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
	} as unknown as Collection
	return { collection, pipelines }
}

const first = (pipeline: Document[]) => Object.keys(pipeline[0])[0]

async function run(
	collection: Collection,
	overrides: Partial<Parameters<typeof searchStructuredMemory>[3]> = {},
	query = "sony camera",
) {
	const rows: SearchTierOutcome[] = []
	const results = await searchStructuredMemory(collection, query, null, {
		maxResults: 5,
		minScore: 0,
		capabilities: withText,
		vectorIndexName: "test_structured_mem_vector",
		textIndexName: TEXT_INDEX,
		embeddingMode: "automated",
		onTierOutcome: (row) => rows.push(row),
		...overrides,
	})
	return { results, rows }
}

describe("searchStructuredMemory tiers (#101 matrix 1d)", () => {
	it("T1: no vector capability reports capability-absent and runs the $search tier", async () => {
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

	it("T2: a vector embed denial is budget-denied and never reaches the text tier", async () => {
		const { collection, pipelines } = fixture()
		const err = await runWithSearchBudget(
			{ maxAggregations: 5, maxEmbeds: 0 },
			() => run(collection),
		).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(SearchBudgetDeniedError)
		expect(err).toMatchObject({ stage: "vector", reason: "budget-embeds" })
		expect(pipelines).toHaveLength(0)
	})

	it("T2: an empty query reports the vector tier not-applicable/empty-query", async () => {
		const { collection } = fixture(() => [])
		const { rows } = await run(collection, {}, "")
		expect(rows[0]).toEqual({
			stage: "vector",
			outcome: "not-applicable",
			reason: "empty-query",
		})
	})

	it("T3: a failed explain is an explain row; results stand", async () => {
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

	it("T4: a refused vector aggregation is budget-denied, never zero hits", async () => {
		const { collection, pipelines } = fixture()
		await expect(
			runWithSearchBudget({ maxAggregations: 0, maxEmbeds: 5 }, () =>
				run(collection),
			),
		).rejects.toMatchObject({ stage: "vector", reason: "budget-aggregations" })
		expect(pipelines).toHaveLength(0)
	})

	it("T5: a vector zero-hit is ok-empty and runs the $search tier next", async () => {
		const { collection, pipelines } = fixture((pipeline) =>
			first(pipeline) === "$vectorSearch" ? [] : [doc],
		)
		const { results, rows } = await run(collection)
		expect(results).toHaveLength(1)
		expect(pipelines.map(first)).toEqual(["$vectorSearch", "$search"])
		expect(rows).toEqual([
			{
				stage: "vector",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
			{ stage: "atlas-search", outcome: "ok", resultCount: 1 },
		])
	})

	it("T6: a vector error is a typed failure; no later tier runs", async () => {
		const { collection, pipelines } = fixture((pipeline) =>
			first(pipeline) === "$vectorSearch" ? serverError() : [doc],
		)
		const err = await run(collection).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(SearchLaneError)
		expect(err).toMatchObject({ stage: "vector", reason: "query-error" })
		expect((err as Error).message).not.toContain("secret")
		expect(pipelines.map(first)).toEqual(["$vectorSearch"])
	})

	it("T7: no structured $text query remains on any path", async () => {
		const { collection, pipelines } = fixture(() => [])
		await run(collection)
		await run(collection, {
			capabilities: { ...withText, vectorSearch: false },
		})
		expect(JSON.stringify(pipelines)).not.toContain("$text")
	})

	it("T7: the $search tier queries value+context on structured_mem_text with mapped filters only", async () => {
		const { collection, pipelines } = fixture()
		await run(collection, {
			capabilities: { ...withText, vectorSearch: false },
			filter: {
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				type: "fact",
				salience: ["critical"],
				temporalScope: ["current"],
				currentOnly: true,
				asOf: new Date("2026-01-01T00:00:00Z"),
			},
		})
		const search = pipelines[0][0].$search
		expect(search.index).toBe(TEXT_INDEX)
		expect(search.compound.must).toEqual([
			{ text: { query: "sony camera", path: ["value", "context"] } },
		])
		const paths = (search.compound.filter as Document[]).map(
			(clause) => clause.equals?.path ?? clause.in?.path,
		)
		expect(paths.sort()).toEqual(
			[
				"agentId",
				"salience",
				"scope",
				"scopeRef",
				"state",
				"temporalScope",
				"type",
			].sort(),
		)
		expect(JSON.stringify(search)).not.toContain("validFrom")
		// The full filter, validity clauses included, is revalidated post-stage.
		expect(JSON.stringify(pipelines[0].slice(1))).toContain("validFrom")
		expect(pipelines[0].at(-1).$project.score).toEqual({ $meta: "searchScore" })
	})

	it("T7: a $search error is a typed atlas-search failure", async () => {
		const { collection } = fixture((pipeline) =>
			first(pipeline) === "$search" ? serverError() : [],
		)
		await expect(run(collection)).rejects.toMatchObject({
			stage: "atlas-search",
			reason: "query-error",
		})
	})

	it("T7: the $search tier is charged as an aggregation", async () => {
		const { collection } = fixture()
		await expect(
			runWithSearchBudget({ maxAggregations: 0, maxEmbeds: 5 }, () =>
				run(collection, { capabilities: { ...withText, vectorSearch: false } }),
			),
		).rejects.toMatchObject({
			stage: "atlas-search",
			reason: "budget-aggregations",
		})
	})

	it.each([
		["textSearch is false", { ...withText, textSearch: false }],
		[
			"the index is not queryable for this profile",
			{ ...withText, queryableSearchIndexes: [] },
		],
		[
			"per-index availability is unknown",
			{ ...withText, queryableSearchIndexes: undefined },
		],
	])("R1/R2: the $search tier is capability-absent when %s", async (_label, capabilities) => {
		const { collection, pipelines } = fixture((pipeline) =>
			first(pipeline) === "$vectorSearch" ? [] : [doc],
		)
		const { results, rows } = await run(collection, { capabilities })
		expect(results).toEqual([])
		expect(pipelines.map(first)).toEqual(["$vectorSearch"])
		expect(rows.at(-1)).toEqual({
			stage: "atlas-search",
			outcome: "not-applicable",
			reason: "capability-absent",
		})
	})

	it("3.5: with neither tier available the lane is a typed lane-unavailable failure", async () => {
		const { collection, pipelines } = fixture()
		await expect(
			run(collection, {
				capabilities: {
					...withText,
					vectorSearch: false,
					queryableSearchIndexes: [],
				},
			}),
		).rejects.toMatchObject({
			name: "SearchLaneUnavailableError",
			reason: "lane-unavailable",
		})
		expect(pipelines).toHaveLength(0)
	})
})

describe("detectCapabilities per-index availability (#101 R2)", () => {
	function dbWith(byCollection: Record<string, Document[] | Error>): Db {
		return {
			admin: () => ({ command: async () => ({ versionArray: [8, 3, 0, 0] }) }),
			collection: (name: string) => ({
				collectionName: name,
				aggregate: () => ({
					toArray: async () => {
						const out = byCollection[name] ?? []
						if (out instanceof Error) throw out
						return out
					},
				}),
			}),
		} as unknown as Db
	}
	const ready = (name: string) => ({
		name,
		type: "search",
		status: "READY",
		queryable: true,
	})

	it("lists only the text indexes that are queryable now", async () => {
		const caps = await detectCapabilities(
			dbWith({
				test_chunks: [ready("test_chunks_text")],
				test_structured_mem: [ready("test_structured_mem_text")],
				test_procedures: [
					{
						...ready("test_procedures_text"),
						status: "PENDING",
						queryable: false,
					},
				],
			}),
			"test_chunks",
			undefined,
			["test_structured_mem", "test_procedures"],
		)
		expect(caps.textSearch).toBe(true)
		expect(caps.queryableSearchIndexes).toEqual(["test_structured_mem_text"])
	})

	it("fails typed when an index's availability cannot be read (M2)", async () => {
		await expect(
			detectCapabilities(
				dbWith({ test_structured_mem: new Error("search unavailable") }),
				"test_chunks",
				undefined,
				["test_structured_mem"],
			),
		).rejects.toMatchObject({
			name: "MemongoBootError",
			code: "search-management-unavailable",
			collection: "test_structured_mem",
		})
	})

	it("leaves per-index availability unknown when no text-tier collection is named", async () => {
		const caps = await detectCapabilities(dbWith({}), "test_chunks")
		expect(caps.queryableSearchIndexes).toBeUndefined()
	})
})
