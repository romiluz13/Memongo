// T8 (#117): the context bundle selects its episode summary through $search,
// keeps the query-evidence lane outcomes (X-09), and reports every failed
// section as a typed row. The Search stage is MODELED
// (test-helpers/search-model-db.ts); real mongot analyzers are untested here.
import { MongoServerError } from "mongodb"
import type { Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	searchV2Result: undefined as unknown,
}))
vi.mock("./mongodb-write-fence.js", () => ({
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
		kind: "admission",
		agentId,
		epoch: 1,
	})),
}))
vi.mock("./mongodb-recall-traces.js", () => ({
	recordRecallTrace: vi.fn(async () => "trace"),
}))
vi.mock("./mongodb-search-v2.js", () => ({
	searchV2: vi.fn(async () => state.searchV2Result),
}))

import { buildContextBundle } from "./mongodb-context-bundle.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { SearchLaneError } from "./search-outcomes.js"
import {
	createSearchModelDb,
	type SearchModelDb,
} from "./test-helpers/search-model-db.js"
import type { MemoryContextBundle } from "./types.js"

const TENANT = { agentId: "a1", scope: "agent" as const, scopeRef: "agent:a1" }
const OTHER = { ...TENANT, scopeRef: "agent:other" }
const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY)

let model: SearchModelDb
let counter = 0

const episode = (over: Document): Document => ({
	...TENANT,
	episodeId: `ep-${++counter}`,
	title: "",
	summary: "",
	tags: [],
	topics: [],
	status: "open",
	timeRange: { start: daysAgo(3), end: daysAgo(2) },
	updatedAt: daysAgo(2),
	...over,
})

function bundle(
	request: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) {
	return buildContextBundle({
		db: model.db,
		prefix: "test_",
		agentId: TENANT.agentId,
		scope: TENANT.scope,
		scopeRef: TENANT.scopeRef,
		request,
		...extra,
	})
}

const summaryTitles = (result: MemoryContextBundle): string[] =>
	result.sections
		.filter((section) => section.kind === "summary")
		.flatMap((section) => section.items.map((item) => item.title))

beforeEach(() => {
	model = createSearchModelDb()
	counter = 0
	vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
	model.expectNoModelErrors()
	vi.restoreAllMocks()
})

describe("episode summary through the modeled Search", () => {
	beforeEach(async () => {
		await model.seed("episodes", [
			episode({
				episodeId: "e1",
				title: "Redis migration",
				summary: "Moved the cache to a managed cluster",
				topics: ["infra"],
			}),
			episode({
				episodeId: "e2",
				title: "Billing review",
				summary: "Quarterly invoice audit",
				topics: ["finance"],
			}),
			episode({
				episodeId: "e3",
				title: "Redis migration",
				summary: "Other tenant's notes",
				...OTHER,
			}),
		])
		model.refreshIndexes()
	})

	it.each([
		["redis", ["Redis migration"]],
		["REDIS", ["Redis migration"]],
		["rEdIs, migration!", ["Redis migration"]],
		["finance", ["Billing review"]],
		["invoice", ["Billing review"]],
		["reds", []],
		["redi", []],
		["???", []],
	])("query %j selects %j by analyzed term match", async (query, expected) => {
		const result = await bundle({ query })
		expect(summaryTitles(result)).toEqual(expected)
		expect(result.metadata.failures).toEqual([])
		expect(result.metadata.partial).toBe(false)
	})

	it("searches the episodes index once and never filters content by RegExp", async () => {
		await bundle({ query: "redis" })
		const [pipeline] = model.searchPipelines("episodes")
		expect(model.searchPipelines("episodes")).toHaveLength(1)
		expect(pipeline[0].$search.index).toBe("episode_autocomplete")
		expect(pipeline[0].$search.compound.must[0].text.query).toBe("redis")
		expect(pipeline[1].$match).toMatchObject(TENANT)
		const issued = JSON.stringify(
			model.calls.map((call) => call.args),
			(_key, value) => (value instanceof RegExp ? "RegExp" : value),
		)
		expect(issued).not.toContain('"RegExp"')
		expect(issued).not.toContain("$regex")
	})

	it("lists canonically without a query and issues no Search", async () => {
		const result = await bundle({})
		expect(summaryTitles(result)).toHaveLength(1)
		expect(model.searchPipelines("episodes")).toEqual([])
	})

	it("never returns another tenant's episode for the same words", async () => {
		const result = await bundle({ query: "other tenant's notes" })
		expect(JSON.stringify(result.sections)).not.toContain("Other tenant")
	})

	it("drops an episode deleted after the index snapshot", async () => {
		await model.fake
			.collection("episodes")
			.updateOne({ episodeId: "e1" }, { $set: { status: "deleted" } })
		const result = await bundle({ query: "redis" })
		expect(summaryTitles(result)).toEqual([])
		expect(result.metadata.failures).toEqual([])
	})

	it("drops an episode that left the requested window after indexing", async () => {
		await model.fake.collection("episodes").updateOne(
			{ episodeId: "e1" },
			{
				$set: {
					"timeRange.start": daysAgo(40),
					"timeRange.end": daysAgo(39),
				},
			},
		)
		const result = await bundle({
			query: "redis",
			timeRange: {
				start: daysAgo(10).toISOString(),
				end: new Date().toISOString(),
			},
		})
		expect(summaryTitles(result)).toEqual([])
	})

	it("keeps an episode inside the requested window", async () => {
		const result = await bundle({
			query: "redis",
			timeRange: {
				start: daysAgo(10).toISOString(),
				end: new Date().toISOString(),
			},
		})
		expect(summaryTitles(result)).toEqual(["Redis migration"])
	})
})

describe("typed section rows in the bundle", () => {
	it("types a failed episode Search as a row and keeps healthy siblings", async () => {
		await model.seed("episodes", [episode({ title: "Redis migration" })])
		model.refreshIndexes()
		model.fake.injectFailure({
			collection: "episodes",
			method: "aggregate",
			error: new MongoServerError({ errmsg: "SECRETTAIL", code: 2 }),
		})
		const result = await bundle({ query: "redis" })
		expect(summaryTitles(result)).toEqual([])
		expect(result.metadata.partial).toBe(true)
		expect(result.metadata.failures).toEqual([
			{
				section: "episode-summary",
				stage: "atlas-search",
				outcome: "failed",
				reason: "query-error",
			},
		])
		expect(JSON.stringify(result.metadata)).not.toContain("SECRETTAIL")
		expect(result.metadata.pathsExecuted).toContain("active-slate")
	})

	it("types a failed recent-events read as a row, not an empty section", async () => {
		model.fake.injectFailure({
			collection: "events",
			method: "find",
			error: new MongoServerError({ errmsg: "down", code: 6 }),
			times: 50,
		})
		const result = await bundle({})
		expect(result.metadata.partial).toBe(true)
		expect(result.metadata.failures).toEqual(
			expect.arrayContaining([
				{
					section: "recent-events",
					stage: "lane",
					outcome: "failed",
					reason: "query-error",
				},
				{
					section: "active-slate:recent-anchors",
					stage: "lane",
					outcome: "failed",
					reason: "query-error",
				},
			]),
		)
		expect(result.metadata.failures).toHaveLength(2)
		expect(result.metadata.pathsExecuted).not.toContain("recent-events")
	})

	it("throws the typed error when every planned section fails", async () => {
		const error = new MongoServerError({ errmsg: "down", code: 6 })
		for (const [collection, method] of [
			["episodes", "find"],
			["events", "find"],
		] as const) {
			model.fake.injectFailure({ collection, method, error, times: 50 })
		}
		for (const collection of [
			"structured_mem",
			"procedures",
			"entities",
			"episodes",
			"events",
			"relations",
		]) {
			for (const method of ["find", "aggregate"]) {
				model.fake.injectFailure({ collection, method, error, times: 50 })
			}
		}
		await expect(bundle({})).rejects.toBeInstanceOf(SearchLaneError)
	})

	it("keeps query-evidence lane outcomes, status and an adopted partial row (X-09)", async () => {
		const result = await bundle(
			{ query: "redis" },
			{
				search: async () => ({
					results: [],
					pathsExecuted: ["structured"],
					laneOutcomes: [
						{
							lane: "structured",
							stage: "lane",
							outcome: "ok",
							resultCount: 0,
						},
						{
							lane: "hybrid",
							stage: "atlas-search",
							outcome: "failed",
							reason: "index-not-ready",
						},
					],
					outcomeStatus: "partial",
				}),
			},
		)
		expect(result.metadata.laneOutcomes).toHaveLength(2)
		expect(result.metadata.outcomeStatus).toBe("partial")
		expect(result.metadata.failures).toEqual([
			{
				section: "query-evidence",
				stage: "atlas-search",
				outcome: "failed",
				reason: "index-not-ready",
			},
		])
		expect(result.metadata.partial).toBe(true)
		expect(result.metadata.pathsExecuted).toContain("structured")
	})

	it("types a throttled query-evidence search as a budget-denied row and keeps the marker", async () => {
		const result = await bundle(
			{ query: "redis" },
			{
				search: async () => ({
					results: [],
					pathsExecuted: [],
					throttled: { retryAfterMs: 1500 },
				}),
			},
		)
		expect(result.metadata.throttled).toEqual({ retryAfterMs: 1500 })
		expect(result.metadata.failures).toEqual([
			{
				section: "query-evidence",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		])
		expect(result.metadata.partial).toBe(true)
	})

	it("nests expansion failure rows under the query-evidence section", async () => {
		const result = await bundle(
			{ query: "redis" },
			{
				search: async () => ({
					results: [],
					pathsExecuted: [],
					failures: [
						{
							section: "context-expansion",
							stage: "lane",
							outcome: "failed",
							reason: "query-error",
						},
					],
				}),
			},
		)
		expect(result.metadata.failures).toEqual([
			{
				section: "query-evidence:context-expansion",
				stage: "lane",
				outcome: "failed",
				reason: "query-error",
			},
		])
		expect(result.metadata.partial).toBe(true)
	})

	it("types a failed query-evidence search and keeps the other sections", async () => {
		await model.seed("episodes", [
			episode({ title: "Redis migration", summary: "Moved the cache" }),
		])
		model.refreshIndexes()
		const result = await bundle(
			{ query: "redis" },
			{
				search: async () => {
					throw new SearchLaneError({
						lane: "hybrid",
						stage: "atlas-search",
						reason: "index-missing",
					})
				},
			},
		)
		expect(summaryTitles(result)).toEqual(["Redis migration"])
		expect(result.metadata.failures).toEqual([
			{
				section: "query-evidence",
				stage: "atlas-search",
				outcome: "failed",
				reason: "index-missing",
			},
		])
	})
})

describe("lifecycle wiring keeps the search outcomes (X-09)", () => {
	function ops() {
		const host = {
			db: model.db,
			prefix: "test_",
			agentId: TENANT.agentId,
			config: {
				mongodb: {
					kb: { enabled: false },
					episodes: { enabled: false },
					graph: { enabled: false, maxGraphDepth: 0 },
					relevance: { telemetry: { queryPrivacyMode: "none" } },
				},
			},
			buildV2AvailablePaths: () => new Set(),
			buildConversationChunkFilter: () => ({}),
			buildScopeAwareBridgeChunkFilter: () => ({}),
			getBridgeChunkBudget: () => 0,
			requestCapabilities: async () => ({}),
		}
		return new MongoDBManagerLifecycleOps(host as unknown as MongoDBManagerHost)
	}

	it("carries laneOutcomes, outcomeStatus and the throttle marker through MongoDBManager.buildContextBundle", async () => {
		state.searchV2Result = {
			results: [],
			metadata: {
				pathsExecuted: ["structured"],
				resultsByPath: {},
				laneOutcomes: [
					{
						lane: "structured",
						stage: "atlas-search",
						outcome: "failed",
						reason: "query-timeout",
					},
				],
				outcomeStatus: "partial",
				throttled: { retryAfterMs: 900 },
			},
		}
		const result = await ops().buildContextBundle({ query: "redis" })
		expect(result.metadata.laneOutcomes).toEqual([
			{
				lane: "structured",
				stage: "atlas-search",
				outcome: "failed",
				reason: "query-timeout",
			},
		])
		expect(result.metadata.outcomeStatus).toBe("partial")
		expect(result.metadata.throttled).toEqual({ retryAfterMs: 900 })
		expect(result.metadata.failures).toEqual([
			{
				section: "query-evidence",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		])
	})
})
