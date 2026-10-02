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
	structuredMemCollection: vi.fn(),
}))
import { structuredMemCollection } from "./mongodb-schema.js"
import {
	searchStructuredMemory,
	type StructuredMemoryState,
} from "./mongodb-structured-memory.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"

const asOf = new Date("2026-04-11T10:30:00.000Z")
const validity = [
	{ $or: [{ validFrom: { $exists: false } }, { validFrom: { $lte: asOf } }] },
	{ $or: [{ validTo: { $exists: false } }, { validTo: { $gt: asOf } }] },
]
function collection() {
	const aggregate = vi.fn((_pipeline: Document[]) => ({
		toArray: vi
			.fn()
			.mockResolvedValue([
				{ type: "fact", key: "choice", value: "selected", score: 0.9 },
			]),
	}))
	return { aggregate, col: { aggregate } as unknown as Collection }
}
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
})
afterEach(() => vi.unstubAllEnvs())

for (const vector of [true, false]) {
	it.each([
		{ state: "conflicted", currentOnly: true, expected: "conflicted" },
		{
			state: ["active", "conflicted"],
			currentOnly: true,
			expected: { $in: ["active", "conflicted"] },
		},
		{ state: undefined, currentOnly: true, expected: "active" },
		{ state: "active", currentOnly: true, expected: "active" },
		{ state: [], currentOnly: true, expected: "active" },
		{ state: "invalidated", currentOnly: true, expected: "invalidated" },
		{ state: "invalidated", currentOnly: false, expected: "invalidated" },
		{
			state: ["conflicted", "invalidated"],
			currentOnly: false,
			expected: { $in: ["conflicted", "invalidated"] },
		},
	])(`honors leaf state and validity with vector=${vector}: $state / $currentOnly`, async ({
		state,
		currentOnly,
		expected,
	}) => {
		const { col, aggregate } = collection()
		await searchStructuredMemory(col, "choice", null, {
			maxResults: 5,
			filter: {
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				state: state as
					| StructuredMemoryState
					| StructuredMemoryState[]
					| undefined,
				currentOnly,
				asOf,
			},
			capabilities: {
				vectorSearch: vector,
				textSearch: true,
				scoreFusion: false,
				rankFusion: false,
				storedSource: false,
				vectorIndexMethod: false,
			},
			vectorIndexName: "structured_vector",
			embeddingMode: "automated",
		})
		expect(aggregate).toHaveBeenCalledOnce()
		const pipeline = aggregate.mock.calls[0][0] as Document[]
		const filter = vector
			? pipeline[0].$vectorSearch.filter
			: pipeline[0].$match
		const clauses: Document[] = filter.$and ?? [filter]
		expect(clauses).toContainEqual(
			expect.objectContaining({
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
			}),
		)
		if (currentOnly) {
			expect(clauses).toContainEqual({ state: expected })
			for (const clause of validity) expect(clauses).toContainEqual(clause)
		} else {
			expect(clauses).toContainEqual(
				expect.objectContaining({ state: expected }),
			)
			for (const clause of validity) expect(clauses).not.toContainEqual(clause)
		}
	})
}

it.each([
	{ state: "conflicted", expected: "conflicted", current: true },
	{
		state: ["active", "conflicted"],
		expected: { $in: ["active", "conflicted"] },
		current: true,
	},
	{ state: "active", expected: "active", current: true },
	{ state: "invalidated", expected: "invalidated", current: false },
])("searchV2 reaches the real structured leaf with $state", async ({
	state,
	expected,
	current,
}) => {
	const { col, aggregate } = collection()
	vi.mocked(structuredMemCollection).mockReturnValue(col)
	await searchV2({} as Db, "test_", "preference choice", "agent-1", {
		availablePaths: new Set(["structured"]),
		searchOptions: {
			structuredScope: { state },
			allowHybridBackstop: false,
			timeRange: { start: "2026-04-10T00:00:00Z", end: asOf.toISOString() },
		},
	})
	expect(aggregate).toHaveBeenCalledOnce()
	const pipeline = aggregate.mock.calls[0][0] as Document[]
	const filter = pipeline[0].$vectorSearch?.filter ?? pipeline[0].$match
	const clauses = (filter.$and ?? [filter]) as Document[]
	expect(clauses).toContainEqual(expect.objectContaining({ state: expected }))
	if (current)
		for (const clause of validity) expect(clauses).toContainEqual(clause)
	else for (const clause of validity) expect(clauses).not.toContainEqual(clause)
})
