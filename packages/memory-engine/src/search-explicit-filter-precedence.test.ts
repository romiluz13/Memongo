import type { Db } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
vi.mock("./mongodb-structured-memory.js", async (original) => ({
	...(await original<typeof import("./mongodb-structured-memory.js")>()),
	searchStructuredMemory: vi.fn().mockResolvedValue([]),
}))
vi.mock("./mongodb-kb-search.js", async (original) => ({
	...(await original<typeof import("./mongodb-kb-search.js")>()),
	searchKB: vi.fn().mockResolvedValue([]),
}))
vi.mock("./mongodb-schema.js", async (original) => ({
	...(await original<typeof import("./mongodb-schema.js")>()),
	structuredMemCollection: vi.fn(() => ({})),
	kbChunksCollection: vi.fn(() => ({})),
	kbCollection: vi.fn(() => ({})),
}))
import { searchV2 } from "./mongodb-search-v2.js"
import { searchKB } from "./mongodb-kb-search.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import type { MemoryReferenceScope, MemoryStructuredScope } from "./types.js"

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
})
afterEach(() => {
	vi.unstubAllEnvs()
})

it.each([
	{
		query: "file notes",
		scope: { source: "url" },
		expected: { source: "url" },
	},
	{
		query: "API endpoint notes",
		scope: { source: "url" },
		expected: { source: "url" },
	},
	{
		query: "file notes",
		scope: { category: "research" },
		expected: { category: "research" },
	},
	{
		query: "API endpoint notes",
		scope: { category: "research" },
		expected: { category: "research" },
	},
	{
		query: "file notes",
		scope: { source: "url", category: "research", tags: ["owned"] },
		expected: { source: "url", category: "research", tags: ["owned"] },
	},
	{ query: "file notes", scope: {}, expected: { source: "file" } },
	{ query: "API endpoint notes", scope: {}, expected: { category: "api" } },
	{
		query: "file notes",
		scope: { tags: ["owned"] },
		expected: { source: "file", tags: ["owned"] },
	},
	{ query: "file notes", scope: { source: "" }, expected: { source: "file" } },
])("caller KB scope $scope with '$query' resolves to $expected", async ({
	query,
	scope,
	expected,
}) => {
	await searchV2({} as Db, "test_", query, "agent-1", {
		availablePaths: new Set(["kb"]),
		searchOptions: {
			referenceScope: scope as MemoryReferenceScope,
			allowHybridBackstop: false,
		},
	})
	expect(searchKB).toHaveBeenCalledOnce()
	const options = vi.mocked(searchKB).mock.calls[0][3]
	expect(options.filter).toEqual(expected)
	expect(options.scopeRef).toBe("agent:agent-1")
})
it.each([
	{ scope: { type: "fact" }, expected: "fact" },
	{ scope: {}, expected: "preference" },
	{ scope: { type: "" }, expected: "preference" },
])("structured caller scope $scope wins over preference inference", async ({
	scope,
	expected,
}) => {
	await searchV2({} as Db, "test_", "preference notes", "agent-1", {
		availablePaths: new Set(["structured"]),
		searchOptions: {
			structuredScope: scope as MemoryStructuredScope,
			allowHybridBackstop: false,
		},
	})
	expect(searchStructuredMemory).toHaveBeenCalledOnce()
	expect(
		vi.mocked(searchStructuredMemory).mock.calls[0][3].filter,
	).toMatchObject({
		type: expected,
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
	})
})
