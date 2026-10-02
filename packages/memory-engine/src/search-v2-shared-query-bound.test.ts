import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-lane-coverage.js")>()),
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
vi.mock("./mongodb-events.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-events.js")>()),
	getEventsByTimeRange: vi.fn(),
}))
vi.mock("./mongodb-schema.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-schema.js")>()),
	chunksCollection: vi.fn(() => ({})),
	structuredMemCollection: vi.fn(() => ({})),
}))
vi.mock("./mongodb-search.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-search.js")>()),
	mongoSearch: vi.fn(),
}))
vi.mock("./mongodb-structured-memory.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-structured-memory.js")>()),
	searchStructuredMemory: vi.fn(),
}))
vi.mock("./mongodb-retrieval-planner.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-retrieval-planner.js")>()
	return { ...actual, planRetrieval: vi.fn(actual.planRetrieval) }
})
vi.mock("./mongodb-search-lanes.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-search-lanes.js")>()
	return {
		...actual,
		extractRawWindowQueryTerms: vi.fn(actual.extractRawWindowQueryTerms),
	}
})

import { getEventsByTimeRange } from "./mongodb-events.js"
import { emptyLaneCoverage } from "./mongodb-lane-coverage.js"
import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import { expandSynonyms } from "./mongodb-query-rewriter.js"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
import { mongoSearch } from "./mongodb-search.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import { extractRawWindowQueryTerms } from "./mongodb-search-lanes.js"
import { MAX_SEARCH_QUERY_LENGTH } from "./mongodb-search-ranking.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import {
	DEFAULT_SEARCH_ADMISSION_BURST,
	resetSearchAdmissionForTests,
	tryConsumeSearchAdmission,
} from "./mongodb-search-admission.js"
import {
	getSearchBudgetSnapshot,
	runWithSearchBudget,
	tryConsumeSearchAggregation,
} from "./mongodb-search-budget.js"

const prefix = `${"alpha ".repeat(333)}al`
const longQuery = `${prefix} yesterday TAILMARK`
const context = { availablePaths: new Set<"raw-window">(["raw-window"]) }

describe("shared-budget search input bounds", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getLaneCoverage).mockResolvedValue(null)
		vi.stubEnv("MEMONGO_SEARCH_ADMISSION_RPM", "1")
		resetSearchAdmissionForTests(Date.now())
		vi.mocked(getEventsByTimeRange).mockImplementation(async () => {
			expect(tryConsumeSearchAggregation()).toBe(true)
			return []
		})
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})
	it("bounds planner and raw-window input without replacing the parent ledger", async () => {
		const { value, budget } = await runWithSearchBudget(
			{ maxAggregations: 5, maxEmbeds: 2 },
			async () => {
				expect(tryConsumeSearchAggregation()).toBe(true)
				const first = await searchV2(
					{} as Db,
					"test_",
					longQuery,
					"a1",
					context,
				)
				const second = await searchV2({} as Db, "test_", "today", "a1", context)
				expect(getSearchBudgetSnapshot()?.aggregations).toBe(3)
				return { first, second }
			},
		)
		expect(prefix).toHaveLength(MAX_SEARCH_QUERY_LENGTH)
		expect(value.first.metadata.budget?.aggregations).toBe(2)
		expect(value.second.metadata.budget?.aggregations).toBe(3)
		expect(budget.aggregations).toBe(3)
		expect(budget.maxAggregations).toBe(5)
		expect(vi.mocked(planRetrieval).mock.calls.map((call) => call[0])).toEqual([
			prefix,
			"today",
		])
		expect(
			vi.mocked(extractRawWindowQueryTerms).mock.calls.map((call) => call[0]),
		).toEqual([prefix, "today"])
	})
	it("uses parent admission and records one truncation for the oversized entry", async () => {
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++)
			tryConsumeSearchAdmission()
		const { value } = await runWithSearchBudget(
			{ maxAggregations: 5, maxEmbeds: 2 },
			() => searchV2({} as Db, "test_", longQuery, "a1", context),
		)
		expect(value.metadata.throttled).toBeUndefined()
		expect(getEventsByTimeRange).toHaveBeenCalledTimes(1)
		expect(
			vi
				.mocked(emitTelemetry)
				.mock.calls.filter(
					(call) => call[2].meta.operation === "search-query-clamped",
				),
		).toHaveLength(1)
	})
	it("bounds one actual synonym rewrite consistently across parent and recursive backstop", async () => {
		const terms =
			"auth db bug perf config deps deploy docs test refactor ts js py env var fn cb req res err msg ctx impl repo"
		const query = `${terms} ${Array.from({ length: 340 }, (_, i) => `x${i}`).join(" ")}`
		const expanded = expandSynonyms(query)
		expect(query.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH)
		expect(expanded.length).toBeGreaterThan(MAX_SEARCH_QUERY_LENGTH)
		const lanes = emptyLaneCoverage()
		lanes.hybrid = { hasData: true, count: 1, lastUpdated: new Date() }
		lanes.structured = { hasData: true, count: 1, lastUpdated: new Date() }
		vi.mocked(getLaneCoverage).mockResolvedValue({
			agentId: "a1",
			lanes,
			updatedAt: new Date(),
		})
		vi.mocked(planRetrieval)
			.mockImplementationOnce(() => ({
				paths: ["structured"],
				confidence: "high",
				reasoning: "force parent",
			}))
			.mockImplementationOnce(() => ({
				paths: ["hybrid"],
				confidence: "high",
				reasoning: "force recursive backstop",
			}))
		const capture = vi.fn(async () => {
			expect(tryConsumeSearchAggregation()).toBe(true)
			return []
		})
		vi.mocked(mongoSearch).mockImplementation(capture)
		vi.mocked(searchStructuredMemory).mockImplementation(capture)
		const result = await searchV2({} as Db, "test_", query, "a1", {
			admission: { kind: "admission", agentId: "a1", epoch: 19 },
			availablePaths: new Set(["structured", "hybrid"]),
			searchOptions: {
				queryRewriteConfig: {
					enabled: true,
					method: "synonym-expansion",
					maxTokens: 1000,
				},
			},
		})
		expect(searchStructuredMemory).toHaveBeenCalledTimes(1)
		expect(mongoSearch).toHaveBeenCalledTimes(1)
		expect(result.metadata.budget?.aggregations).toBe(2)
		expect(vi.mocked(planRetrieval).mock.calls.map((call) => call[0])).toEqual([
			query,
			expanded.slice(0, MAX_SEARCH_QUERY_LENGTH),
		])
		expect(vi.mocked(searchStructuredMemory).mock.calls[0]?.[1]).toBe(
			expanded.slice(0, MAX_SEARCH_QUERY_LENGTH),
		)
		expect(vi.mocked(mongoSearch).mock.calls[0]?.[1]).toBe(
			expanded.slice(0, MAX_SEARCH_QUERY_LENGTH),
		)
		const clamped = vi
			.mocked(emitTelemetry)
			.mock.calls.filter(
				(call) => call[2].meta.operation === "search-query-clamped",
			)
		expect(Reflect.get(clamped[0], 3)).toEqual({
			admission: { kind: "admission", agentId: "a1", epoch: 19 },
		})
		expect(emitTelemetry).toHaveBeenCalledWith(
			expect.any(Object),
			"test_",
			expect.objectContaining({
				meta: { agentId: "a1", operation: "query-rewrite" },
			}),
			{ admission: { kind: "admission", agentId: "a1", epoch: 19 } },
		)
		expect(clamped).toHaveLength(1)
		expect(clamped[0]?.[2].queryLength).toBe(expanded.length)
	})
	it.each([
		true,
		false,
	])("preserves default-budget or disabled rewrites (enabled %s)", async (enabled) => {
		vi.mocked(planRetrieval).mockReturnValueOnce({
			paths: ["structured"],
			confidence: "high",
			reasoning: "rewrite control",
		})
		vi.mocked(searchStructuredMemory).mockResolvedValue([])
		const query = "auth db bug"
		await searchV2({} as Db, "test_", query, "a1", {
			admission: { kind: "admission", agentId: "a1", epoch: 19 },
			availablePaths: new Set(["structured"]),
			searchOptions: {
				rerankConfig: {
					enabled: true,
					model: "rerank-2.5",
					topN: 10,
					minScore: 0.1,
					voyageApiKey: "mock-key",
				},
				queryRewriteConfig: {
					enabled,
					method: "synonym-expansion",
					maxTokens: 128,
				},
			},
		})
		expect(emitTelemetry).toHaveBeenCalledWith(
			expect.any(Object),
			"test_",
			expect.objectContaining({
				meta: { agentId: "a1", operation: "rerank" },
				rerankSkipped: "no-results",
			}),
			{ admission: { kind: "admission", agentId: "a1", epoch: 19 } },
		)
		expect(vi.mocked(searchStructuredMemory).mock.lastCall?.[1]).toBe(
			enabled ? expandSynonyms(query) : query,
		)
		expect(
			vi
				.mocked(emitTelemetry)
				.mock.calls.filter(
					(call) => call[2].meta.operation === "search-query-clamped",
				),
		).toHaveLength(0)
	})
	it.each([
		"today",
		prefix,
	])("preserves a bounded shared input (case %#)", async (query) => {
		await runWithSearchBudget({ maxAggregations: 5, maxEmbeds: 2 }, () =>
			searchV2({} as Db, "test_", query, "a1", context),
		)
		expect(vi.mocked(planRetrieval).mock.lastCall?.[0]).toBe(query)
		expect(vi.mocked(extractRawWindowQueryTerms).mock.lastCall?.[0]).toBe(query)
		expect(
			vi
				.mocked(emitTelemetry)
				.mock.calls.some(
					(call) => call[2].meta.operation === "search-query-clamped",
				),
		).toBe(false)
	})
})
