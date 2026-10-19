// M2 T3 (#112): chunk search and the planner's chunk sub-lanes run exactly one
// declared native operation each. The fake collections record every emitted
// pipeline, so each test asserts both what ran and that no alternative did.
import type { Collection, Db, Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
vi.mock("./mongodb-retrieval-planner.js", async (original) => ({
	...(await original<typeof import("./mongodb-retrieval-planner.js")>()),
	planRetrieval: vi.fn(),
}))

import { planRetrieval } from "./mongodb-retrieval-planner.js"
import * as searchModule from "./mongodb-search.js"
import { mongoSearch } from "./mongodb-search.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import { searchV2 } from "./mongodb-search-v2.js"
import type { SearchTierOutcome } from "./search-outcomes.js"

type Emitted = { collection: string; pipeline: Document[] }

function fakeDb(handler: (emitted: Emitted) => Document[] | Error = () => []): {
	db: Db
	calls: Emitted[]
} {
	const calls: Emitted[] = []
	const db = {
		collection: (collection: string) =>
			({
				aggregate: vi.fn((pipeline: Document[]) => {
					const emitted = { collection, pipeline }
					calls.push(emitted)
					return {
						toArray: async () => {
							const out = handler(emitted)
							if (out instanceof Error) throw out
							return out
						},
					}
				}),
				find: vi.fn(() => {
					throw new Error("canonical find is not part of a chunk lane")
				}),
			}) as unknown as Collection,
	} as unknown as Db
	return { db, calls }
}

function fakeCollection(
	handler?: (pipeline: Document[]) => Document[] | Error,
) {
	const { db, calls } = fakeDb(({ pipeline }) => handler?.(pipeline) ?? [])
	return {
		collection: db.collection("chunks"),
		pipelines: () => calls.map((call) => call.pipeline),
	}
}

const HIT: Document = {
	path: "events/e1",
	startLine: 0,
	endLine: 0,
	text: "we deployed the payment service",
	source: "conversation",
	score: 0.4,
}

// A caller written against the capability ladder still passes this bag; it
// must not select any operation.
const STALE_FULL_CAPABILITIES = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: true,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}

const baseOpts = {
	maxResults: 10,
	minScore: 0.01,
	vectorIndexName: "t_chunks_vector",
	textIndexName: "t_chunks_text",
	embeddingMode: "automated" as const,
	...({ capabilities: STALE_FULL_CAPABILITIES } as object),
}

function pipelineJson(pipelines: Document[][]): string {
	return JSON.stringify(pipelines)
}

beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_SESSION_EVIDENCE_MODE", "")
	vi.stubEnv("MEMONGO_EVIDENCE_MIRROR_MODE", "")
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("chunk search runs one native operation (#112)", () => {
	it("scoreFusion emits one $scoreFusion aggregate with the unchanged sigmoid, avg and weights", async () => {
		const { collection, pipelines } = fakeCollection(() => [HIT])
		await mongoSearch(collection, "payment service", null, {
			...baseOpts,
			fusionMethod: "scoreFusion",
		})

		expect(pipelines()).toHaveLength(1)
		const fusion = pipelines()[0]?.[0]?.$scoreFusion
		expect(Object.keys(fusion.input.pipelines)).toEqual(["vector", "text"])
		expect(fusion.input.normalization).toBe("sigmoid")
		expect(fusion.combination).toEqual({
			weights: { vector: 0.7, text: 0.3 },
			method: "avg",
		})
		expect(fusion.input.pipelines.vector[0].$vectorSearch.query).toEqual({
			text: "payment service",
		})
		expect(fusion.input.pipelines.text[0].$search.index).toBe("t_chunks_text")
	})

	it("rankFusion emits one $rankFusion aggregate with the unchanged weights", async () => {
		const { collection, pipelines } = fakeCollection(() => [HIT])
		await mongoSearch(collection, "payment service", null, {
			...baseOpts,
			fusionMethod: "rankFusion",
		})

		expect(pipelines()).toHaveLength(1)
		const fusion = pipelines()[0]?.[0]?.$rankFusion
		expect(Object.keys(fusion.input.pipelines)).toEqual(["vector", "text"])
		expect(fusion.combination).toEqual({
			weights: { vector: 0.7, text: 0.3 },
		})
		expect(pipelines()[0]?.[0]?.$scoreFusion).toBeUndefined()
	})

	it("rejects the js-merge method with a typed error and runs no aggregate", async () => {
		const { collection, pipelines } = fakeCollection(() => [HIT])
		await expect(
			mongoSearch(collection, "payment service", null, {
				...baseOpts,
				fusionMethod: "js-merge",
			}),
		).rejects.toMatchObject({ name: "SearchLaneError", reason: "query-error" })
		expect(pipelines()).toHaveLength(0)
	})

	it("never answers an embed denial with keyword results, even for js-merge", async () => {
		const { collection, pipelines } = fakeCollection(() => [HIT])
		await expect(
			runWithSearchBudget({ maxAggregations: 12, maxEmbeds: 0 }, () =>
				mongoSearch(collection, "payment service", null, {
					...baseOpts,
					fusionMethod: "js-merge",
				}),
			),
		).rejects.toMatchObject({ name: "SearchLaneError" })
		expect(pipelines()).toHaveLength(0)
	})

	it("ignores stale capability flags instead of downgrading to a weaker operation", async () => {
		for (const fusionMethod of ["scoreFusion", "rankFusion"] as const) {
			const { collection, pipelines } = fakeCollection(() => [HIT])
			await mongoSearch(collection, "payment service", null, {
				...baseOpts,
				fusionMethod,
				...({
					capabilities: {
						vectorSearch: false,
						textSearch: false,
						scoreFusion: false,
						rankFusion: false,
					},
				} as object),
			})
			expect(pipelines()).toHaveLength(1)
			expect(
				pipelines()[0]?.[0]?.[`$${fusionMethod}`],
				`${fusionMethod} stays the one operation`,
			).toBeDefined()
		}
	})

	it("never emits a keyword-only, vector-only or $text pipeline from any input", async () => {
		const emitted: Document[][] = []
		for (const fusionMethod of ["scoreFusion", "rankFusion"] as const) {
			for (const caps of [
				{ vectorSearch: false, textSearch: false },
				{ vectorSearch: true, textSearch: false },
				{ vectorSearch: false, textSearch: true },
			]) {
				const { collection, pipelines } = fakeCollection(() => [])
				await mongoSearch(collection, "payment service", null, {
					...baseOpts,
					fusionMethod,
					...({ capabilities: caps } as object),
				})
				emitted.push(...pipelines())
			}
		}
		expect(emitted).toHaveLength(6)
		for (const pipeline of emitted) {
			expect(pipeline[0]?.$match).toBeUndefined()
			expect(pipeline[0]?.$search).toBeUndefined()
			expect(pipeline[0]?.$vectorSearch).toBeUndefined()
		}
		expect(pipelineJson(emitted)).not.toContain('"$text"')
	})

	it("exposes none of the removed alternatives", () => {
		const surface = searchModule as Record<string, unknown>
		expect(surface.hybridSearchJSFallback).toBeUndefined()
		expect(surface.keywordSearch).toBeUndefined()
		expect(surface.classicTextSearch).toBeUndefined()
	})

	it("treats a healthy zero as final: one aggregate and an ok-empty row", async () => {
		const { collection, pipelines } = fakeCollection(() => [])
		const rows: SearchTierOutcome[] = []
		const results = await mongoSearch(collection, "payment service", null, {
			...baseOpts,
			fusionMethod: "scoreFusion",
			onTierOutcome: (row) => rows.push(row),
		})
		expect(results).toEqual([])
		expect(pipelines()).toHaveLength(1)
		expect(rows).toEqual([
			{
				stage: "score-fusion",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("types an injected aggregate error and runs nothing else", async () => {
		const { collection, pipelines } = fakeCollection(
			() => new Error("mongot unavailable"),
		)
		await expect(
			mongoSearch(collection, "payment service", null, {
				...baseOpts,
				fusionMethod: "rankFusion",
			}),
		).rejects.toMatchObject({ name: "SearchLaneError", stage: "rank-fusion" })
		expect(pipelines()).toHaveLength(1)
	})

	it("types an embed denial and never runs a keyword replacement", async () => {
		const { collection, pipelines } = fakeCollection(() => [HIT])
		await expect(
			runWithSearchBudget({ maxAggregations: 12, maxEmbeds: 0 }, () =>
				mongoSearch(collection, "payment service", null, {
					...baseOpts,
					fusionMethod: "scoreFusion",
				}),
			),
		).rejects.toMatchObject({
			name: "SearchBudgetDeniedError",
			reason: "budget-embeds",
		})
		expect(pipelines()).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// The planner's chunk sub-lanes
// ---------------------------------------------------------------------------

const CONVERSATION_FILTER: Document = {
	source: { $in: ["conversation", "sessions"] },
	agentId: "agent-1",
	scope: "workspace",
	scopeRef: "ws-1",
	status: { $ne: "deleted" },
}
const COMPATIBLE_BRIDGE_FILTER: Document = {
	...CONVERSATION_FILTER,
	source: { $in: ["conversation", "memory"] },
}
const INCOMPATIBLE_BRIDGE_FILTER: Document = {
	...COMPATIBLE_BRIDGE_FILTER,
	status: "active",
}

function plannerRun(
	db: Db,
	searchOptions: Record<string, unknown>,
	extra: { maxResults?: number } = {},
) {
	vi.mocked(planRetrieval).mockReturnValue({
		paths: ["hybrid"],
		confidence: "high",
		reasoning: "owned fixture",
	})
	return searchV2(db, "t_", "payment service", "agent-1", {
		availablePaths: new Set(["hybrid"] as const),
		...extra,
		searchOptions: {
			allowHybridBackstop: false,
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				scoreFusion: true,
				rankFusion: true,
				storedSource: false,
				vectorIndexMethod: false,
			},
			fusionMethod: "scoreFusion",
			embeddingMode: "automated",
			conversationEvidenceMode: "disabled",
			scope: "workspace",
			scopeRef: "ws-1",
			conversationFilter: CONVERSATION_FILTER,
			bridgeMaxResults: 3,
			...searchOptions,
		},
	})
}

function chunkPipelines(calls: Emitted[]): Document[][] {
	return calls
		.filter((call) => call.collection === "t_chunks")
		.map((call) => call.pipeline)
}

function vectorStageCount(pipelines: Document[][]): number {
	return (JSON.stringify(pipelines).match(/"\$vectorSearch"/g) ?? []).length
}

describe("planner chunk sub-lanes fuse natively (#112)", () => {
	for (const fusionMethod of ["scoreFusion", "rankFusion"] as const) {
		it(`${fusionMethod}: compatible chunk and bridge filters run one two-input aggregate`, async () => {
			const { db, calls } = fakeDb(() => [HIT])
			await plannerRun(db, {
				fusionMethod,
				bridgeFilter: COMPATIBLE_BRIDGE_FILTER,
			})
			const chunks = chunkPipelines(calls)
			expect(chunks).toHaveLength(1)
			const fusion = chunks[0]?.[0]?.[`$${fusionMethod}`]
			expect(Object.keys(fusion.input.pipelines)).toEqual(["vector", "text"])
		})

		it(`${fusionMethod}: incompatible filters run ONE aggregate with each sub-lane's filter in its own input pipeline`, async () => {
			const { db, calls } = fakeDb(() => [HIT])
			const result = await plannerRun(db, {
				fusionMethod,
				bridgeFilter: INCOMPATIBLE_BRIDGE_FILTER,
			})
			const chunks = chunkPipelines(calls)
			expect(calls).toHaveLength(1)
			expect(chunks).toHaveLength(1)

			const fusion = chunks[0]?.[0]?.[`$${fusionMethod}`]
			const inputs = fusion.input.pipelines
			expect(Object.keys(inputs)).toEqual([
				"vector",
				"text",
				"bridgeVector",
				"bridgeText",
			])
			expect(fusion.combination.weights).toEqual({
				vector: 0.7,
				text: 0.3,
				bridgeVector: 0.7,
				bridgeText: 0.3,
			})
			if (fusionMethod === "scoreFusion") {
				expect(fusion.input.normalization).toBe("sigmoid")
				expect(fusion.combination.method).toBe("avg")
			}
			// Each sub-lane's own filter rides its own input pipelines.
			const primaryFilter = inputs.vector[0].$vectorSearch.filter
			const bridgeFilter = inputs.bridgeVector[0].$vectorSearch.filter
			expect(JSON.stringify(primaryFilter)).toContain('"$ne":"deleted"')
			expect(JSON.stringify(primaryFilter)).not.toContain('"active"')
			expect(JSON.stringify(bridgeFilter)).toContain('"active"')
			expect(JSON.stringify(bridgeFilter)).not.toContain('"$ne":"deleted"')
			expect(JSON.stringify(inputs.bridgeText)).toContain('"active"')
			// Input caps are the sub-lanes' own caps; the output cap is their sum.
			expect(inputs.vector[0].$vectorSearch.limit).toBe(40)
			expect(inputs.bridgeVector[0].$vectorSearch.limit).toBe(12)
			expect(chunks[0]?.find((stage) => stage.$limit != null)?.$limit).toBe(13)
			expect(result.metadata.outcomeStatus).toBe("complete")
			expect(
				result.metadata.laneOutcomes?.filter(
					(row) => row.lane === "hybrid:bridge",
				),
			).toEqual([])
		})
	}

	it("reconciles the ledger with the one emitted aggregate: one aggregation and one embed per vector input", async () => {
		const { db, calls } = fakeDb(() => [])
		const result = await plannerRun(db, {
			bridgeFilter: INCOMPATIBLE_BRIDGE_FILTER,
		})
		const chunks = chunkPipelines(calls)
		expect(chunks).toHaveLength(1)
		expect(vectorStageCount(chunks)).toBe(2)
		expect(result.metadata.budget).toMatchObject({
			aggregations: 1,
			embeds: 2,
		})
		expect(result.metadata.outcomeStatus).toBe("complete")
	})

	it("reconciles the ledger for a compatible single fused aggregate", async () => {
		const { db, calls } = fakeDb(() => [])
		const result = await plannerRun(db, {
			bridgeFilter: COMPATIBLE_BRIDGE_FILTER,
		})
		expect(chunkPipelines(calls)).toHaveLength(1)
		expect(result.metadata.budget).toMatchObject({ aggregations: 1, embeds: 1 })
	})

	it("hybridMode vector-only emits exactly one $vectorSearch per lane", async () => {
		const compatible = fakeDb(() => [HIT])
		await plannerRun(compatible.db, {
			bridgeFilter: COMPATIBLE_BRIDGE_FILTER,
			searchConfig: { hybridMode: "vector-only" },
		})
		const compatibleChunks = chunkPipelines(compatible.calls)
		expect(compatibleChunks).toHaveLength(1)
		expect(compatibleChunks[0]?.[0]?.$vectorSearch).toBeDefined()
		expect(vectorStageCount(compatibleChunks)).toBe(1)

		const incompatible = fakeDb(() => [HIT])
		const result = await plannerRun(incompatible.db, {
			bridgeFilter: INCOMPATIBLE_BRIDGE_FILTER,
			searchConfig: { hybridMode: "vector-only" },
		})
		const chunks = chunkPipelines(incompatible.calls)
		expect(chunks).toHaveLength(1)
		expect(vectorStageCount(chunks)).toBe(1)
		const stage = chunks[0]?.[0]?.$vectorSearch
		expect(stage.filter.$or).toHaveLength(2)
		expect(stage.limit).toBe(13)
		expect(result.metadata.budget).toMatchObject({ aggregations: 1, embeds: 1 })
		expect(pipelineJson(chunks)).not.toContain("$scoreFusion")
		expect(pipelineJson(chunks)).not.toContain("$rankFusion")
	})

	it("a healthy zero on the one aggregate is final: no second operation", async () => {
		const { db, calls } = fakeDb(() => [])
		const result = await plannerRun(db, {
			bridgeFilter: INCOMPATIBLE_BRIDGE_FILTER,
		})
		expect(result.results).toEqual([])
		expect(calls).toHaveLength(1)
		expect(result.metadata.outcomeStatus).toBe("complete")
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "hybrid:chunks",
			stage: "lane",
			outcome: "ok-empty",
			reason: "zero-hits",
			resultCount: 0,
		})
	})

	it("an injected aggregate error is a typed failed row, never an empty success", async () => {
		const { db, calls } = fakeDb(() => new Error("mongot unavailable"))
		const result = await plannerRun(db, {
			bridgeFilter: INCOMPATIBLE_BRIDGE_FILTER,
		})
		expect(calls).toHaveLength(1)
		expect(result.results).toEqual([])
		expect(result.metadata.outcomeStatus).toBe("failed")
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "hybrid:chunks",
			stage: "score-fusion",
			outcome: "failed",
			reason: "internal-error",
		})
	})
})
