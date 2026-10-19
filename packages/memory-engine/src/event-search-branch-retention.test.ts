import type { Db, Document } from "mongodb"
import { MongoServerError } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
vi.mock("./mongodb-retrieval-planner.js", async (original) => ({
	...(await original<typeof import("./mongodb-retrieval-planner.js")>()),
	planRetrieval: vi.fn(() => ({
		paths: ["raw-window"],
		confidence: "high",
		reasoning: "owned fixture",
	})),
}))
vi.mock("./mongodb-events.js", async (original) => ({
	...(await original<typeof import("./mongodb-events.js")>()),
	getEventsByTimeRange: vi.fn(async () => [event("seed")]),
}))
import {
	searchConversationEvidenceEvents,
	searchTurnEventsWithinSessions,
} from "./mongodb-search-lanes.js"
import { searchV2 } from "./mongodb-search-v2.js"
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
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}
const privateText = "CANARY210 confidential project"
function event(eventId: string): Document {
	return {
		eventId,
		body: "We discussed the garden plan",
		role: "user",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		sessionId: "s1",
		timestamp: new Date("2026-01-02"),
		invalidAt: null,
		score: 0.9,
		channel: "default",
	}
}
function database(failed: Set<string>, empty = false) {
	const error = new MongoServerError({ errmsg: privateText, code: 50 })
	const pipelines: Document[][] = []
	const options: Document[] = []
	const db = {
		collection: () => ({
			aggregate: (pipeline: Document[], opts: Document) => {
				pipelines.push(pipeline)
				options.push(opts)
				const branch = pipeline[0].$vectorSearch ? "turn-vector" : "turn-text"
				return {
					toArray: async () => {
						if (failed.has(branch)) throw error
						return empty ? [] : [event(branch)]
					},
				}
			},
		}),
	} as unknown as Db
	return { db, error, pipelines, options }
}
beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

for (const seam of ["session", "conversation"] as const) {
	const run = (
		db: Db,
		extra: { onTierOutcome?: SearchTierOutcomeSink } = {},
	) => {
		const params = {
			db,
			prefix: "test_",
			query: "we discussed the plan",
			questionDate: undefined,
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
	describe(`${seam} event search`, () => {
		it.each([
			"turn-vector",
			"turn-text",
		] as const)("L1: retains sibling of failed %s and accounts unchanged budget", async (branch) => {
			const { db, pipelines, options } = database(new Set([branch]))
			const rows: SearchTierOutcome[] = []
			const sibling = branch === "turn-vector" ? "turn-text" : "turn-vector"
			const { value, budget } = await runWithSearchBudget(
				{ maxAggregations: 4, maxEmbeds: 2 },
				() => run(db, { onTierOutcome: (row) => rows.push(row) }),
			)
			expect(value.map((x) => x.path)).toEqual([`events/${sibling}`])
			expect(rows).toContainEqual({
				stage: branch,
				outcome: "failed",
				reason: "query-error",
			})
			expect(rows).toContainEqual({
				stage: sibling,
				outcome: "ok",
				resultCount: 1,
			})
			expect(JSON.stringify(rows)).not.toContain(privateText)
			expect(budget).toMatchObject({ aggregations: 2, embeds: 1 })
			expect(pipelines).toHaveLength(2)
			for (const pipeline of pipelines)
				expect(pipeline.some((stage) => stage.$match)).toBe(true)
			expect(options).toEqual([{ maxTimeMS: 10000 }, { maxTimeMS: 10000 }])
		})
		it("L1: all failed throws one typed error and reports only the sibling row", async () => {
			const { db, error } = database(new Set(["turn-vector", "turn-text"]))
			const rows: SearchTierOutcome[] = []
			const failure = await run(db, {
				onTierOutcome: (row) => rows.push(row),
			}).catch((err: unknown) => err)
			expect(failure).toBeInstanceOf(SearchLaneError)
			expect(failure).toMatchObject({
				stage: "turn-vector",
				reason: "query-error",
			})
			expect((failure as Error).cause).toBe(error)
			expect((failure as Error).message).not.toContain(privateText)
			expect(rows.filter((row) => row.outcome === "failed")).toEqual([
				{ stage: "turn-text", outcome: "failed", reason: "query-error" },
			])
		})
		it("strict partial failure throws typed with the original as cause", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
			const { db, error } = database(new Set(["turn-vector"]))
			const failure = await run(db).catch((err: unknown) => err)
			expect(failure).toBeInstanceOf(SearchLaneError)
			expect(failure).toMatchObject({ stage: "turn-vector" })
			expect((failure as Error).cause).toBe(error)
		})
		it("fulfilled empty remains distinguishable from an all-failed call", async () => {
			const { db } = database(new Set(["turn-vector"]), true)
			const rows: SearchTierOutcome[] = []
			expect(await run(db, { onTierOutcome: (row) => rows.push(row) })).toEqual(
				[],
			)
			expect(rows).toContainEqual({
				stage: "turn-vector",
				outcome: "failed",
				reason: "query-error",
			})
			expect(rows).toContainEqual({
				stage: "turn-text",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			})
		})
		it("missing sink retains result with structural warning", async () => {
			const { db } = database(new Set(["turn-vector"]))
			const warnings: string[] = []
			vi.spyOn(console, "warn").mockImplementation((...args) => {
				warnings.push(args.join(" "))
			})
			expect(await run(db)).toHaveLength(1)
			expect(warnings).toHaveLength(1)
			expect(warnings[0]).not.toContain(privateText)
			expect(warnings[0]).toContain('"code":50')
		})
		it("L8/L13: no affordable aggregation is a typed budget denial, not an empty", async () => {
			const { db, pipelines } = database(new Set())
			const rows: SearchTierOutcome[] = []
			let failure: unknown
			const { budget } = await runWithSearchBudget(
				{ maxAggregations: 1, maxEmbeds: 1 },
				async () => {
					const { tryConsumeSearchAggregation } = await import(
						"./mongodb-search-budget.js"
					)
					tryConsumeSearchAggregation()
					failure = await run(db, {
						onTierOutcome: (row) => rows.push(row),
					}).catch((err: unknown) => err)
				},
			)
			expect(failure).toBeInstanceOf(SearchBudgetDeniedError)
			expect(failure).toMatchObject({
				stage: "turn-vector",
				reason: "budget-aggregations",
			})
			expect(rows).toContainEqual({
				stage: "turn-text",
				outcome: "budget-denied",
				reason: "budget-aggregations",
			})
			expect(pipelines).toHaveLength(0)
			expect(budget.aggregations).toBe(1)
		})
	})
}

it.each([
	"conversation-evidence",
	"turn-precision",
] as const)("searchV2 %s records the failed branch row and retains evidence", async (phase) => {
	vi.stubEnv(
		"MEMONGO_CONVERSATION_EVIDENCE_MODE",
		phase === "conversation-evidence" ? "serial" : "disabled",
	)
	vi.stubEnv(
		"MEMONGO_BENCHMARK_TURN_PRECISION_MODE",
		phase === "turn-precision" ? "enabled" : "disabled",
	)
	const { db } = database(new Set(["turn-vector"]))
	const warnings: string[] = []
	vi.spyOn(console, "warn").mockImplementation((...args) => {
		warnings.push(args.join(" "))
	})
	const onPathFailure = vi.fn()
	const result = await searchV2(
		db,
		"test_",
		"we discussed the plan",
		"agent-1",
		{
			availablePaths: new Set(["raw-window"]),
			onPathFailure,
			searchOptions: {
				capabilities,
				allowHybridBackstop: false,
			},
		},
	)
	expect(result.results.map((x) => x.path)).toContain("events/turn-text")
	expect(onPathFailure).not.toHaveBeenCalled()
	expect(result.metadata.laneOutcomes).toContainEqual({
		lane: phase,
		stage: "turn-vector",
		outcome: "failed",
		reason: "query-error",
	})
	expect(result.metadata.laneOutcomes).toContainEqual(
		expect.objectContaining({ lane: phase, stage: "lane", outcome: "ok" }),
	)
	expect(result.metadata.outcomeStatus).toBe("partial")
	expect(JSON.stringify(result.metadata.laneOutcomes)).not.toContain(
		privateText,
	)
	expect(warnings.join(" ")).not.toContain(privateText)
})
