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
	const run = (db: Db, extra = {}) => {
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
		])("retains sibling of failed %s and accounts unchanged budget", async (branch) => {
			const { db, error, pipelines, options } = database(new Set([branch]))
			const onBranchFailure = vi.fn()
			const { value, budget } = await runWithSearchBudget(
				{ maxAggregations: 4, maxEmbeds: 2 },
				() => run(db, { onBranchFailure }),
			)
			expect(value.map((x) => x.path)).toEqual([
				`events/${branch === "turn-vector" ? "turn-text" : "turn-vector"}`,
			])
			expect(onBranchFailure).toHaveBeenCalledExactlyOnceWith(branch, error)
			expect(budget).toMatchObject({ aggregations: 2, embeds: 1 })
			expect(pipelines).toHaveLength(2)
			for (const pipeline of pipelines)
				expect(pipeline.some((stage) => stage.$match)).toBe(true)
			expect(options).toEqual([{ maxTimeMS: 10000 }, { maxTimeMS: 10000 }])
		})
		it("all failed retains rejection and avoids duplicate branch hooks", async () => {
			const { db, error } = database(new Set(["turn-vector", "turn-text"]))
			const onBranchFailure = vi.fn()
			await expect(run(db, { onBranchFailure })).rejects.toBe(error)
			expect(onBranchFailure).not.toHaveBeenCalled()
		})
		it("strict partial failure retains rejection", async () => {
			vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
			const { db, error } = database(new Set(["turn-vector"]))
			await expect(run(db)).rejects.toBe(error)
		})
		it("fulfilled empty remains distinguishable from an all-failed call", async () => {
			const { db, error } = database(new Set(["turn-vector"]), true)
			const onBranchFailure = vi.fn()
			expect(await run(db, { onBranchFailure })).toEqual([])
			expect(onBranchFailure).toHaveBeenCalledExactlyOnceWith(
				"turn-vector",
				error,
			)
		})
		it.each([
			false,
			true,
		])("missing or broken hook (%s) retains result with structural warning", async (broken) => {
			const { db } = database(new Set(["turn-vector"]))
			const warnings: string[] = []
			vi.spyOn(console, "warn").mockImplementation((...args) => {
				warnings.push(args.join(" "))
			})
			const extra = broken
				? {
						onBranchFailure: () => {
							throw new Error(privateText)
						},
					}
				: {}
			expect(await run(db, extra)).toHaveLength(1)
			expect(warnings).toHaveLength(1)
			expect(warnings[0]).not.toContain(privateText)
			expect(warnings[0]).toContain('"code":50')
		})
		it("no attempted aggregations remains empty", async () => {
			const { db, pipelines } = database(new Set())
			const { value, budget } = await runWithSearchBudget(
				{ maxAggregations: 1, maxEmbeds: 1 },
				async () => {
					const { tryConsumeSearchAggregation } = await import(
						"./mongodb-search-budget.js"
					)
					tryConsumeSearchAggregation()
					return run(db)
				},
			)
			expect(value).toEqual([])
			expect(pipelines).toHaveLength(0)
			expect(budget.aggregations).toBe(1)
		})
	})
}

it.each([
	"conversation-evidence",
	"turn-precision",
] as const)("searchV2 %s forwards branch health and retains evidence", async (phase) => {
	vi.stubEnv(
		"MEMONGO_CONVERSATION_EVIDENCE_MODE",
		phase === "conversation-evidence" ? "serial" : "disabled",
	)
	vi.stubEnv(
		"MEMONGO_BENCHMARK_TURN_PRECISION_MODE",
		phase === "turn-precision" ? "enabled" : "disabled",
	)
	const { db, error } = database(new Set(["turn-vector"]))
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
				rerankConfig: {
					enabled: false,
					model: "rerank-2.5",
					topN: 10,
					minScore: 0,
					voyageApiKey: "unused-fixture",
				},
			},
		},
	)
	const lane = `phase:${phase}:turn-vector`
	expect(result.results.map((x) => x.path)).toContain("events/turn-text")
	expect(onPathFailure).toHaveBeenCalledExactlyOnceWith(lane, error)
	expect(result.metadata.laneOutcomes).toContainEqual({
		lane,
		status: "failed",
		error: error.message,
	})
	expect(
		result.metadata.laneOutcomes?.some(
			(x) => x.lane === `phase:${phase}` && x.status === "failed",
		),
	).toBe(false)
	expect(warnings.join(" ")).not.toContain(privateText)
})
