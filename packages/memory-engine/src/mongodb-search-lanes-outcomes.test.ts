import type { Db, Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	searchConversationEvidenceEvents,
	searchTemporalCoverageEvents,
	searchTurnEventsWithinSessions,
} from "./mongodb-search-lanes.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import {
	SearchBudgetDeniedError,
	type SearchTierOutcome,
} from "./search-outcomes.js"

const fullCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}
const questionDate = new Date("2026-03-01T00:00:00Z")

function database(docs: Document[] = []) {
	const aggregate = vi.fn((pipeline: Document[]) => ({
		toArray: async () =>
			docs.map((doc) => ({
				...doc,
				branch: pipeline[0].$vectorSearch ? "turn-vector" : "turn-text",
			})),
	}))
	const find = vi.fn(() => ({ toArray: async () => [] }))
	return {
		db: { collection: () => ({ aggregate, find }) } as unknown as Db,
		aggregate,
		find,
	}
}

function owner() {
	return {
		prefix: "test_",
		agentId: "agent-1",
		scope: "agent" as const,
		scopeRef: "agent:agent-1",
	}
}

beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("temporal coverage rows (#101 L2-L6)", () => {
	const temporal = (
		query: string,
		db: Db,
		rows: SearchTierOutcome[],
		capabilities = fullCapabilities,
		date: Date | undefined = questionDate,
	) =>
		searchTemporalCoverageEvents({
			db,
			...owner(),
			query,
			questionDate: date,
			maxResults: 5,
			capabilities,
			onTierOutcome: (row) => rows.push(row),
		})

	it("L2: a non-temporal query is a query-shape row, not a bare empty", async () => {
		const { db, aggregate } = database()
		const rows: SearchTierOutcome[] = []
		expect(await temporal("what is my favorite color", db, rows)).toEqual([])
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "query-shape" },
		])
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("L3: no textSearch is capability-absent and no longer throws in strict mode", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
		const { db } = database()
		const rows: SearchTierOutcome[] = []
		expect(
			await temporal("when did I go hiking last month", db, rows, {
				...fullCapabilities,
				textSearch: false,
			}),
		).toEqual([])
		expect(rows).toEqual([
			{
				stage: "turn-text",
				outcome: "not-applicable",
				reason: "capability-absent",
			},
		])
	})

	it("L4: a temporal query with no usable terms is a query-shape row", async () => {
		const { db, aggregate } = database()
		const rows: SearchTierOutcome[] = []
		expect(await temporal("last", db, rows)).toEqual([])
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "query-shape" },
		])
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("L5: a refused aggregation is a typed budget denial, never an empty", async () => {
		const { db, aggregate } = database()
		const rows: SearchTierOutcome[] = []
		const { value } = await runWithSearchBudget(
			{ maxAggregations: 1, maxEmbeds: 1 },
			async () => {
				const { tryConsumeSearchAggregation } = await import(
					"./mongodb-search-budget.js"
				)
				tryConsumeSearchAggregation()
				return temporal("when did I go hiking last month", db, rows).catch(
					(err: unknown) => err,
				)
			},
		)
		expect(value).toBeInstanceOf(SearchBudgetDeniedError)
		expect(value).toMatchObject({
			stage: "turn-text",
			reason: "budget-aggregations",
		})
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("L6: hits without session ids record turn-text plus a no-candidates expansion row", async () => {
		const { db, find } = database([])
		const rows: SearchTierOutcome[] = []
		await temporal("when did I go hiking last month", db, rows)
		expect(rows).toEqual([
			{
				stage: "turn-text",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
			{ stage: "plan", outcome: "not-applicable", reason: "no-candidates" },
		])
		expect(find).not.toHaveBeenCalled()
	})
})

describe("turn-precision rows (#101 L7-L10)", () => {
	const turns = (
		db: Db,
		rows: SearchTierOutcome[],
		sessionIds: string[],
		capabilities = fullCapabilities,
	) =>
		searchTurnEventsWithinSessions({
			db,
			...owner(),
			query: "we discussed the plan",
			sessionIds,
			maxResults: 5,
			numCandidates: 20,
			capabilities,
			embeddingMode: "automated",
			queryEmbeddingModel: "voyage-4-large",
			onTierOutcome: (row) => rows.push(row),
		})

	it("L7: no session ids is a no-candidates row", async () => {
		const { db, aggregate } = database()
		const rows: SearchTierOutcome[] = []
		expect(await turns(db, rows, [" "])).toEqual([])
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "no-candidates" },
		])
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("L9: no textSearch is a capability-absent turn-text row; the vector branch still runs", async () => {
		const { db, aggregate } = database()
		const rows: SearchTierOutcome[] = []
		await turns(db, rows, ["s1"], { ...fullCapabilities, textSearch: false })
		expect(aggregate).toHaveBeenCalledOnce()
		expect(rows).toEqual([
			{
				stage: "turn-text",
				outcome: "not-applicable",
				reason: "capability-absent",
			},
			{
				stage: "turn-vector",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("L8/L10: an embed refusal after the aggregation is charged is a denial row, not a silent skip", async () => {
		const { db } = database()
		const rows: SearchTierOutcome[] = []
		await runWithSearchBudget({ maxAggregations: 4, maxEmbeds: 0 }, () =>
			turns(db, rows, ["s1"]),
		)
		expect(rows).toContainEqual({
			stage: "turn-vector",
			outcome: "budget-denied",
			reason: "budget-embeds",
		})
		expect(rows).toContainEqual({
			stage: "turn-text",
			outcome: "ok-empty",
			reason: "zero-hits",
			resultCount: 0,
		})
	})
})

describe("conversation-evidence rows (#101 L11-L15)", () => {
	const evidence = (
		query: string,
		db: Db,
		rows: SearchTierOutcome[],
		capabilities = fullCapabilities,
	) =>
		searchConversationEvidenceEvents({
			db,
			...owner(),
			query,
			questionDate: undefined,
			maxResults: 5,
			numCandidates: 20,
			capabilities,
			embeddingMode: "automated",
			queryEmbeddingModel: "voyage-4-large",
			onTierOutcome: (row) => rows.push(row),
		})

	it("L11: a non-evidence query is a query-shape row", async () => {
		const { db, aggregate } = database()
		const rows: SearchTierOutcome[] = []
		expect(await evidence("what is my favorite color", db, rows)).toEqual([])
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "query-shape" },
		])
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("L12: no search capability is capability-absent and no longer throws in strict mode", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
		const { db } = database()
		const rows: SearchTierOutcome[] = []
		expect(
			await evidence("we discussed the plan", db, rows, {
				...fullCapabilities,
				vectorSearch: false,
				textSearch: false,
			}),
		).toEqual([])
		expect(rows).toEqual([
			{ stage: "lane", outcome: "not-applicable", reason: "capability-absent" },
		])
	})

	it("L14: no textSearch is a capability-absent turn-text row", async () => {
		const { db } = database()
		const rows: SearchTierOutcome[] = []
		await evidence("we discussed the plan", db, rows, {
			...fullCapabilities,
			textSearch: false,
		})
		expect(rows).toContainEqual({
			stage: "turn-text",
			outcome: "not-applicable",
			reason: "capability-absent",
		})
	})

	it("L15: with no branch able to run, the lane throws the denial instead of returning a bare empty", async () => {
		const { db } = database()
		const rows: SearchTierOutcome[] = []
		const { value } = await runWithSearchBudget(
			{ maxAggregations: 0, maxEmbeds: 0 },
			() =>
				evidence("we discussed the plan", db, rows, {
					...fullCapabilities,
					vectorSearch: false,
				}).catch((err: unknown) => err),
		)
		expect(value).toBeInstanceOf(SearchBudgetDeniedError)
		expect(value).toMatchObject({
			stage: "turn-text",
			reason: "budget-aggregations",
		})
		expect(rows).toEqual([
			{
				stage: "turn-vector",
				outcome: "not-applicable",
				reason: "capability-absent",
			},
		])
	})
})
