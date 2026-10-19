import type { Db, Document } from "mongodb"
import { MongoServerError } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
import {
	searchConversationEvidenceEvents,
	searchTurnEventsWithinSessions,
} from "./mongodb-search-lanes.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import {
	SearchBudgetDeniedError,
	SearchLaneError,
	type SearchTierOutcome,
	type SearchTierOutcomeSink,
} from "./search-outcomes.js"

const capabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}
const privateText = "CANARY210 confidential project"
const questionDate = new Date("2026-03-01T00:00:00Z")

function event(eventId: string, score = 0.03): Document {
	return {
		eventId,
		body: "We discussed the garden plan",
		role: "user",
		sessionId: "s1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		timestamp: new Date("2026-01-02"),
		score,
	}
}

function database(outcome: "ok" | "empty" | "fail") {
	const error = new MongoServerError({ errmsg: privateText, code: 50 })
	const pipelines: Document[][] = []
	const options: Document[] = []
	const db = {
		collection: () => ({
			aggregate: (pipeline: Document[], opts: Document) => {
				pipelines.push(pipeline)
				options.push(opts)
				return {
					toArray: async () => {
						if (outcome === "fail") throw error
						return outcome === "empty" ? [] : [event("e1"), event("e2")]
					},
				}
			},
			find: () => {
				throw new Error("event lanes must not read with find")
			},
		}),
	} as unknown as Db
	return { db, error, pipelines, options }
}

beforeEach(() => {
	resetSearchAdmissionForTests(Date.now())
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

for (const seam of ["session", "conversation"] as const) {
	const run = (
		db: Db,
		extra: {
			onTierOutcome?: SearchTierOutcomeSink
			capabilities?: typeof capabilities
		} = {},
	) => {
		const params = {
			db,
			prefix: "test_",
			query: "we discussed the plan",
			questionDate,
			agentId: "agent-1",
			scope: "agent" as const,
			scopeRef: "agent:agent-1",
			maxResults: 10,
			numCandidates: 100,
			capabilities,
			embeddingMode: "automated" as const,
			queryEmbeddingModel: "voyage-4-large" as const,
			...extra,
		}
		return seam === "session"
			? searchTurnEventsWithinSessions({ ...params, sessionIds: ["s1"] })
			: searchConversationEvidenceEvents(params)
	}

	describe(`${seam} event lane is one native $rankFusion`, () => {
		it("runs one fused aggregate with the former RRF's equal weights", async () => {
			const { db, pipelines, options } = database("ok")
			const rows: SearchTierOutcome[] = []
			const { value, budget } = await runWithSearchBudget(
				{ maxAggregations: 4, maxEmbeds: 2 },
				() => run(db, { onTierOutcome: (row) => rows.push(row) }),
			)
			expect(pipelines).toHaveLength(1)
			const fusion = pipelines[0]?.[0]?.$rankFusion
			expect(fusion?.combination).toEqual({ weights: { vector: 1, text: 1 } })
			expect(Object.keys(fusion?.input?.pipelines ?? {})).toEqual([
				"vector",
				"text",
			])
			expect(fusion.input.pipelines.vector[0]).toHaveProperty("$vectorSearch")
			expect(fusion.input.pipelines.text[0]).toHaveProperty("$search")
			expect(pipelines[0]?.at(-1)?.$project?.score).toEqual({
				$meta: "score",
			})
			expect(options).toEqual([{ maxTimeMS: 10000 }])
			expect(budget).toMatchObject({ aggregations: 1, embeds: 1 })
			expect(rows).toEqual([
				{ stage: "rank-fusion", outcome: "ok", resultCount: 2 },
			])
			expect(value.map((result) => result.path)).toEqual([
				"events/e1",
				"events/e2",
			])
		})

		it("re-checks the same tenant, scope and lifecycle inside both inputs", async () => {
			const { db, pipelines } = database("ok")
			await run(db)
			const inputs = pipelines[0]?.[0]?.$rankFusion?.input?.pipelines as Record<
				string,
				Document[]
			>
			const vectorFilter = inputs.vector[0]?.$vectorSearch?.filter
			expect(vectorFilter).toMatchObject({
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
			})
			for (const input of [inputs.vector, inputs.text]) {
				const matches = input.filter((stage) => stage.$match)
				// A document whose scope or owner changed after indexing fails
				// the hydrated revalidation; a retracted, not-yet-valid or
				// expired one fails the lifecycle clause.
				expect(matches[0]?.$match).toEqual(vectorFilter)
				const lifecycle = JSON.stringify(matches[1]?.$match)
				expect(lifecycle).toContain("invalidAt")
				expect(lifecycle).toContain("validAt")
				expect(lifecycle).toContain("expiresAt")
				expect(input[0]?.$search ?? input[0]?.$vectorSearch).toBeDefined()
				expect(input[0]).not.toHaveProperty("$match")
			}
			expect(inputs.text.at(-1)).toEqual({ $limit: 10 })
			expect(inputs.text[0]?.$search?.compound?.filter as Document[]).toEqual(
				expect.arrayContaining([
					{ equals: { path: "agentId", value: "agent-1" } },
					{ equals: { path: "scope", value: "agent" } },
					{ equals: { path: "scopeRef", value: "agent:agent-1" } },
				]),
			)
		})

		it("fails typed on a fusion error: no branch survives alone", async () => {
			const { db, error, pipelines } = database("fail")
			const rows: SearchTierOutcome[] = []
			const failure = await run(db, {
				onTierOutcome: (row) => rows.push(row),
			}).catch((err: unknown) => err)
			expect(failure).toBeInstanceOf(SearchLaneError)
			expect(failure).toMatchObject({
				stage: "rank-fusion",
				reason: "query-error",
			})
			expect((failure as Error).cause).toBe(error)
			expect((failure as Error).message).not.toContain(privateText)
			expect(pipelines).toHaveLength(1)
			expect(rows).toEqual([])
		})

		it("keeps a healthy zero final and distinguishable from a failure", async () => {
			const { db } = database("empty")
			const rows: SearchTierOutcome[] = []
			expect(await run(db, { onTierOutcome: (row) => rows.push(row) })).toEqual(
				[],
			)
			expect(rows).toEqual([
				{
					stage: "rank-fusion",
					outcome: "ok-empty",
					reason: "zero-hits",
					resultCount: 0,
				},
			])
		})

		it("types a budget denial and runs nothing", async () => {
			const { db, pipelines } = database("ok")
			let failure: unknown
			const { budget } = await runWithSearchBudget(
				{ maxAggregations: 4, maxEmbeds: 0 },
				async () => {
					failure = await run(db).catch((err: unknown) => err)
				},
			)
			expect(failure).toBeInstanceOf(SearchBudgetDeniedError)
			expect(failure).toMatchObject({
				stage: "rank-fusion",
				reason: "budget-embeds",
			})
			expect(pipelines).toHaveLength(0)
			expect(budget).toMatchObject({ aggregations: 0, embeds: 0 })
		})

		it.each([
			"vectorSearch",
			"textSearch",
			"rankFusion",
		] as const)("without %s the lane is not-applicable and never runs a single branch", async (capability) => {
			const { db, pipelines } = database("ok")
			const rows: SearchTierOutcome[] = []
			const result = await run(db, {
				capabilities: { ...capabilities, [capability]: false },
				onTierOutcome: (row) => rows.push(row),
			})
			expect(result).toEqual([])
			expect(pipelines).toHaveLength(0)
			expect(rows).toEqual([
				{
					stage: "rank-fusion",
					outcome: "not-applicable",
					reason: "capability-absent",
				},
			])
		})
	})
}
