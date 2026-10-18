import type { Collection, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import { searchKB } from "./mongodb-kb-search.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import type { SearchTierOutcome } from "./search-outcomes.js"

const caps: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}

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
		capabilities: caps,
		embeddingMode: "automated",
		fusionMethod: "rankFusion",
		onTierOutcome: (row) => rows.push(row),
		...overrides,
	})
	return { results, rows }
}

describe("searchKB outcomes (#101 matrix 1f)", () => {
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

	it("K2: a fusion tier whose embed is refused is budget-denied and stops", async () => {
		const { collection, pipelines } = fixture()
		await expect(
			runWithSearchBudget({ maxAggregations: 5, maxEmbeds: 0 }, () =>
				run(collection),
			),
		).rejects.toMatchObject({ stage: "rank-fusion", reason: "budget-embeds" })
		expect(pipelines).toHaveLength(0)
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

	it("K4: zero-hit tiers are kept — each reports ok-empty and the next planned tier runs", async () => {
		const { collection, pipelines } = fixture()
		const { results, rows } = await run(collection)
		expect(results).toEqual([])
		expect(pipelines.map(first)).toEqual([
			"$rankFusion",
			"$vectorSearch",
			"$search",
		])
		expect(rows.map((row) => [row.stage, row.outcome])).toEqual([
			["rank-fusion", "ok-empty"],
			["vector", "ok-empty"],
			["keyword", "ok-empty"],
		])
	})

	it("K5: a fusion error is a typed failure; no later tier runs", async () => {
		const { collection, pipelines } = fixture(() => serverError())
		const err = await run(collection).catch((e: unknown) => e)
		expect(err).toMatchObject({ stage: "rank-fusion", reason: "query-error" })
		expect((err as Error).message).not.toContain("secret")
		expect(pipelines).toHaveLength(1)
	})

	it("K6: an empty query reports the vector tier not-applicable/empty-query", async () => {
		const { collection } = fixture()
		const { rows } = await run(
			collection,
			{ capabilities: { ...caps, rankFusion: false } },
			"",
		)
		expect(rows[0]).toEqual({
			stage: "vector",
			outcome: "not-applicable",
			reason: "empty-query",
		})
	})

	it("K9: a keyword error is typed; classic $text never runs after it", async () => {
		const { collection, pipelines } = fixture((pipeline) =>
			first(pipeline) === "$search" ? serverError() : [],
		)
		await expect(
			run(collection, { capabilities: { ...caps, rankFusion: false } }),
		).rejects.toMatchObject({ stage: "keyword", reason: "query-error" })
		expect(pipelines.map(first)).toEqual(["$vectorSearch", "$search"])
	})

	it("K11: classic $text runs only where Search is absent (vector zero-hit, no textSearch)", async () => {
		const { collection, pipelines } = fixture((pipeline) =>
			first(pipeline) === "$match" ? [{ ...hit, score: 2 }] : [],
		)
		const { results, rows } = await run(collection, {
			capabilities: { ...caps, textSearch: false, rankFusion: false },
		})
		expect(results).toHaveLength(1)
		expect(pipelines.map(first)).toEqual(["$vectorSearch", "$match"])
		expect(rows).toEqual([
			{
				stage: "vector",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
			{ stage: "classic-text", outcome: "ok", resultCount: 1 },
		])
	})
})
