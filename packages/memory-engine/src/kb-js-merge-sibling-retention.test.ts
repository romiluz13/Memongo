import type { Collection, Document } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { searchKB } from "./mongodb-kb-search.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import { SearchLaneError, type SearchTierOutcome } from "./search-outcomes.js"

const vectorError = new Error("vector failed")
const keywordError = new Error("keyword failed")
const opts = {
	maxResults: 2,
	minScore: 0.5,
	scopeRef: "agent:owner",
	vectorIndexName: "kb-vector",
	textIndexName: "kb-text",
	capabilities: {
		vectorSearch: true,
		textSearch: true,
		scoreFusion: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
	},
	embeddingMode: "automated" as const,
	fusionMethod: "js-merge" as const,
}
function doc(path: string, score = 0.8): Document {
	return {
		path,
		text: "matching text",
		startLine: 1,
		endLine: 2,
		docId: "doc1",
		score,
	}
}
function collection(
	vector: Document[] | Error,
	keyword: Document[] | Error,
	fallback: Document[] | Error = [],
) {
	const aggregate = vi.fn((pipeline: Document[], _options?: Document) => ({
		toArray: async () => {
			const value = pipeline[0].$vectorSearch
				? vector
				: pipeline[0].$search
					? keyword
					: fallback
			if (value instanceof Error) throw value
			return value
		},
	}))
	return { col: { aggregate } as unknown as Collection, aggregate }
}
beforeEach(() => vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false"))
afterEach(() => vi.unstubAllEnvs())

it.each([
	"vector",
	"keyword",
] as const)("keeps the %s survivor without reexecution and preserves its scores", async (survivor) => {
	const { col, aggregate } = collection(
		survivor === "vector" ? [doc("winner")] : vectorError,
		survivor === "keyword" ? [doc("winner")] : keywordError,
	)
	const rows: SearchTierOutcome[] = []
	const { value, budget } = await runWithSearchBudget(
		{ maxAggregations: 2, maxEmbeds: 1 },
		() =>
			searchKB(col, "matching", null, {
				...opts,
				onTierOutcome: (row) => rows.push(row),
			}),
	)
	expect(value).toEqual([
		expect.objectContaining({ path: "kb:winner", score: 0.8 }),
	])
	expect(aggregate).toHaveBeenCalledTimes(2)
	expect(budget.aggregations).toBe(2)
	expect(budget.embeds).toBe(1)
	// #101 K7: the failed branch is its own value-free row; the survivor stands.
	expect(rows).toEqual([
		{
			stage: survivor === "vector" ? "keyword" : "vector",
			outcome: "failed",
			reason: "internal-error",
		},
		{ stage: survivor, outcome: "ok", resultCount: 1 },
	])
	for (const [pipeline, options] of aggregate.mock.calls) {
		expect(options?.maxTimeMS).toBeGreaterThan(0)
		expect(JSON.stringify(pipeline)).toContain("agent:owner")
	}
})
it("filters and limits the lone survivor using raw scores", async () => {
	const { col } = collection(vectorError, [
		doc("low", 0.1),
		doc("first", 0.8),
		doc("second", 0.7),
		doc("third", 0.6),
	])
	const result = await searchKB(col, "matching", null, opts)
	expect(result.map((hit) => [hit.path, hit.score])).toEqual([
		["kb:first", 0.8],
		["kb:second", 0.7],
	])
})
it.each([
	{ survivor: [] },
	{ survivor: [doc("below", 0.1)] },
])("#101 K7: an empty or filtered survivor stands; nothing runs after the failed branch", async ({
	survivor,
}) => {
	const { col, aggregate } = collection(survivor, keywordError, [
		doc("ordinary"),
	])
	const { value } = await runWithSearchBudget(
		{ maxAggregations: 4, maxEmbeds: 2 },
		() => searchKB(col, "matching", null, opts),
	)
	expect(value).toEqual([])
	expect(aggregate).toHaveBeenCalledTimes(2)
	expect(
		aggregate.mock.calls.filter(([pipeline]) => pipeline[0].$match),
	).toHaveLength(0)
})
it("strict mode settles both branches and throws the first input error", async () => {
	let rejectVector!: (error: Error) => void
	const aggregate = vi.fn((pipeline: Document[]) => ({
		toArray: () =>
			pipeline[0].$vectorSearch
				? new Promise<Document[]>((_resolve, reject) => {
						rejectVector = reject
					})
				: Promise.reject(keywordError),
	}))
	const pending = searchKB(
		{ aggregate } as unknown as Collection,
		"matching",
		null,
		{ ...opts, strict: true },
	)
	const rejected = pending.then(
		() => undefined,
		(error: unknown) => error,
	)
	await vi.waitFor(() => expect(rejectVector).toBeTypeOf("function"))
	rejectVector(vectorError)
	const err = await rejected
	expect(err).toBeInstanceOf(SearchLaneError)
	expect(err).toMatchObject({ stage: "vector", cause: vectorError })
	expect(aggregate).toHaveBeenCalledTimes(2)
})
it("#101 K7: both branches failing is a typed failure, never a $text fallback", async () => {
	const { col, aggregate } = collection(vectorError, keywordError, [
		doc("ordinary"),
	])
	const rows: SearchTierOutcome[] = []
	await expect(
		searchKB(col, "matching", null, {
			...opts,
			onTierOutcome: (row) => rows.push(row),
		}),
	).rejects.toMatchObject({ stage: "vector", reason: "internal-error" })
	expect(rows).toEqual([
		{ stage: "keyword", outcome: "failed", reason: "internal-error" },
	])
	expect(aggregate).toHaveBeenCalledTimes(2)
})
it("keeps two successful lanes on the existing hybrid scoring path", async () => {
	const { col, aggregate } = collection([doc("shared")], [doc("shared")])
	const result = await searchKB(col, "matching", null, opts)
	expect(result).toHaveLength(1)
	expect(result[0].score).toBe(1)
	expect(aggregate).toHaveBeenCalledTimes(2)
})
it("keeps two successful empty lanes empty without starting the waterfall", async () => {
	const { col, aggregate } = collection([], [], [doc("ordinary")])
	expect(await searchKB(col, "matching", null, opts)).toEqual([])
	expect(aggregate).toHaveBeenCalledTimes(2)
})
