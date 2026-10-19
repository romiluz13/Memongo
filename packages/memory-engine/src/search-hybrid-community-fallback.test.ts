import type { Collection, Db, Document } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
vi.mock("./mongodb-schema.js", async (original) => ({
	...(await original<typeof import("./mongodb-schema.js")>()),
	chunksCollection: vi.fn(),
	sessionChunksCollection: vi.fn(),
	memoryEvidenceCollection: vi.fn(),
}))
import {
	chunksCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
} from "./mongodb-schema.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { resolveSearchConfig } from "./mongodb-search-executor.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"

const capabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}
let aggregate = vi.fn((_pipeline: Document[], _options?: Document) => ({
	toArray: vi.fn().mockResolvedValue([]),
}))
const unsupportedAggregate = vi.fn((_pipeline: Document[]) => ({
	toArray: vi.fn().mockRejectedValue(new Error("no ordinary text index")),
}))
beforeEach(() => {
	vi.clearAllMocks()
	for (const key of [
		"MEMONGO_BENCHMARK_STRICT",
		"MEMONGO_EVIDENCE_MIRROR_MODE",
	])
		vi.stubEnv(key, "false")
	for (const key of [
		"MEMONGO_CONVERSATION_EVIDENCE_MODE",
		"MEMONGO_BENCHMARK_TURN_PRECISION_MODE",
		"MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE",
		"MEMONGO_SESSION_EVIDENCE_MODE",
	])
		vi.stubEnv(key, "disabled")
	resetSearchAdmissionForTests(Date.now())
	aggregate = vi.fn((_pipeline: Document[], _options?: Document) => ({
		toArray: vi.fn().mockResolvedValue([
			{
				path: "events/choice",
				startLine: 1,
				endLine: 1,
				text: "use graphite",
				source: "conversation",
				score: 0.9,
			},
		]),
	}))
	vi.mocked(chunksCollection).mockReturnValue({
		aggregate,
	} as unknown as Collection)
	vi.mocked(sessionChunksCollection).mockReturnValue({
		aggregate: unsupportedAggregate,
	} as unknown as Collection)
	vi.mocked(memoryEvidenceCollection).mockReturnValue({
		aggregate: unsupportedAggregate,
	} as unknown as Collection)
})
afterEach(() => vi.unstubAllEnvs())

function search(hybridMode: "hybrid" | "vector-only" = "hybrid") {
	return searchV2({} as Db, "test_", "graphite choice", "agent-1", {
		availablePaths: new Set(["hybrid"]),
		searchOptions: {
			capabilities,
			conversationEvidenceMode: "disabled",
			allowHybridBackstop: false,
			searchConfig: {
				...resolveSearchConfig({ query: "graphite choice" }),
				numCandidates: 500,
				fusionMethod: "scoreFusion",
				hybridMode,
			},
			scope: "agent",
			scopeRef: "agent:agent-1",
		},
	})
}
it("default hybrid issues the one native fusion aggregate, never $text, whatever the capability flags say", async () => {
	const result = await search()
	expect(aggregate).toHaveBeenCalledOnce()
	const [pipeline, options] = aggregate.mock.calls[0]
	expect(pipeline[0].$scoreFusion).toBeDefined()
	expect(pipeline.some((stage) => "$text" in (stage.$match ?? {}))).toBe(false)
	expect(JSON.stringify(pipeline)).not.toContain("$text")
	const inputs = pipeline[0].$scoreFusion.input.pipelines as Record<
		string,
		Document[]
	>
	for (const name of ["vector", "text"]) {
		const filterText = JSON.stringify(inputs[name])
		expect(filterText).toContain("agent-1")
		expect(filterText).toContain("agent:agent-1")
		expect(filterText).toContain("expiresAt")
		expect(filterText).toContain("invalidAt")
	}
	expect(options?.maxTimeMS).toBeGreaterThan(0)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				text: "use graphite",
				snippet: "use graphite",
				canonicalId: "event:choice",
			}),
		]),
	)
})
it("vector-only with neither capability is a typed unavailable row, not a silent empty", async () => {
	const result = await search("vector-only")
	expect(aggregate).not.toHaveBeenCalled()
	expect(result.results).toEqual([])
	expect(result.metadata.outcomeStatus).toBe("failed")
	expect(result.metadata.laneOutcomes).toContainEqual(
		expect.objectContaining({
			outcome: "failed",
			reason: "lane-unavailable",
		}),
	)
})
it("strict mode runs the same one native aggregate", async () => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
	const result = await search()
	expect(aggregate).toHaveBeenCalledOnce()
	expect(aggregate.mock.calls[0][0][0].$scoreFusion).toBeDefined()
	expect(result.results).toHaveLength(1)
})
it("exhausted aggregation budget sends no query", async () => {
	const { value } = await runWithSearchBudget(
		{ maxAggregations: 0, maxEmbeds: 0 },
		() => search(),
	)
	expect(aggregate).not.toHaveBeenCalled()
	expect(value.results).toEqual([])
	expect(value.metadata.outcomeStatus).toBe("failed")
	expect(value.metadata.laneOutcomes).toContainEqual(
		expect.objectContaining({ outcome: "budget-denied" }),
	)
})
it("a successful no-match query remains empty", async () => {
	aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) })
	const result = await search()
	expect(aggregate).toHaveBeenCalledOnce()
	expect(result.results).toEqual([])
})
it.each([
	"session",
	"mirror",
	"both",
])("keeps unsupported opt-in sibling queries disabled: %s", async (mode) => {
	if (mode !== "mirror") vi.stubEnv("MEMONGO_SESSION_EVIDENCE_MODE", "B")
	if (mode !== "session") vi.stubEnv("MEMONGO_EVIDENCE_MIRROR_MODE", "enabled")
	await search()
	expect(aggregate).toHaveBeenCalledOnce()
	expect(unsupportedAggregate).not.toHaveBeenCalled()
})
