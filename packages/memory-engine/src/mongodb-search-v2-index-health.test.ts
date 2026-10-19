import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn(),
}))
vi.mock("./mongodb-retrieval-planner.js", async (original) => ({
	...(await original<typeof import("./mongodb-retrieval-planner.js")>()),
	planRetrieval: vi.fn(),
}))
vi.mock("./mongodb-schema.js", async (original) => ({
	...(await original<typeof import("./mongodb-schema.js")>()),
	structuredMemCollection: vi.fn(() => ({})),
	proceduresCollection: vi.fn(() => ({})),
	chunksCollection: vi.fn(() => ({})),
}))
vi.mock("./mongodb-structured-memory.js", async (original) => ({
	...(await original<typeof import("./mongodb-structured-memory.js")>()),
	searchStructuredMemory: vi.fn(),
}))
vi.mock("./mongodb-procedures.js", async (original) => ({
	...(await original<typeof import("./mongodb-procedures.js")>()),
	findExactProcedureMatches: vi.fn(),
	searchProcedures: vi.fn(),
}))
vi.mock("./mongodb-episodes.js", async (original) => ({
	...(await original<typeof import("./mongodb-episodes.js")>()),
	searchEpisodes: vi.fn(),
}))
vi.mock("./mongodb-graph.js", async (original) => ({
	...(await original<typeof import("./mongodb-graph.js")>()),
	searchEntitiesAutocomplete: vi.fn(),
	expandGraph: vi.fn(),
}))
vi.mock("./mongodb-events.js", async (original) => ({
	...(await original<typeof import("./mongodb-events.js")>()),
	getEventsByTimeRange: vi.fn(async () => []),
}))
vi.mock("./mongodb-search.js", async (original) => ({
	...(await original<typeof import("./mongodb-search.js")>()),
	mongoSearch: vi.fn(),
	vectorSearch: vi.fn(),
}))
vi.mock("./mongodb-search-lanes.js", async (original) => ({
	...(await original<typeof import("./mongodb-search-lanes.js")>()),
	searchConversationEvidenceEvents: vi.fn(),
	searchTemporalCoverageEvents: vi.fn(),
	searchTurnEventsWithinSessions: vi.fn(),
}))

import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import {
	findExactProcedureMatches,
	searchProcedures,
} from "./mongodb-procedures.js"
import { searchEpisodes } from "./mongodb-episodes.js"
import { expandGraph, searchEntitiesAutocomplete } from "./mongodb-graph.js"
import { mongoSearch } from "./mongodb-search.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { tryConsumeSearchAggregation } from "./mongodb-search-budget.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { runWithIndexHealth } from "./mongodb-index-health.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"
import type { SearchLaneOutcome } from "./search-outcomes.js"
import {
	type FakeSearchIndex,
	createFakeSearchDb,
	readyIndex,
} from "./test-helpers/fake-search-db.js"
import { HEALTHY_TEST_CAPABILITIES } from "./test-helpers/search-capabilities.js"

const PREFIX = "test_"
const MANIFEST = buildRequiredIndexManifest({
	prefix: PREFIX,
	serverVersionArray: [8, 3, 0, 0],
	env: {} as NodeJS.ProcessEnv,
})
const FACTS = {
	scoreFusion: false,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}
const STRUCTURED_TEXT = `${PREFIX}structured_mem_text`
const CHUNKS_VECTOR = `${PREFIX}chunks_vector`
const CHUNKS_TEXT = `${PREFIX}chunks_text`
const CHUNKS = `${PREFIX}chunks`

function healthyIndexes(): Record<string, FakeSearchIndex[]> {
	const byCollection: Record<string, FakeSearchIndex[]> = {}
	for (const entry of MANIFEST) {
		byCollection[entry.collectionName] = [
			...(byCollection[entry.collectionName] ?? []),
			readyIndex(entry.name, entry.type, entry.definition),
		]
	}
	return byCollection
}

function setStatus(
	indexes: Record<string, FakeSearchIndex[]>,
	name: string,
	patch: Partial<FakeSearchIndex> | null,
) {
	for (const [collection, list] of Object.entries(indexes)) {
		indexes[collection] = list.flatMap((index) =>
			index.name !== name
				? [index]
				: patch === null
					? []
					: [{ ...index, ...patch }],
		)
	}
}

function harness(listError?: (collection: string) => Error | undefined) {
	const fake = createFakeSearchDb({ indexes: healthyIndexes(), listError })
	const source = {
		db: fake.db,
		prefix: PREFIX,
		manifest: MANIFEST,
		facts: FACTS,
	}
	const listReads = (collection: string) =>
		fake.calls.filter(
			(call) =>
				call.op === "aggregate" &&
				call.collection === collection &&
				"$listSearchIndexes" in call.pipeline[0],
		).length
	return { ...fake, source, listReads }
}

function plan(paths: RetrievalPath[]) {
	vi.mocked(planRetrieval).mockReturnValue({
		paths,
		confidence: "high",
		reasoning: "owned fixture",
	})
}

function coverage(lanes: Record<string, boolean>) {
	vi.mocked(getLaneCoverage).mockResolvedValue({
		agentId: "agent-1",
		updatedAt: new Date(),
		lanes: Object.fromEntries(
			Object.entries(lanes).map(([lane, hasData]) => [
				lane,
				{ hasData, count: hasData ? 1 : 0, lastUpdated: new Date() },
			]),
		),
	} as never)
}

function rowsFor(rows: SearchLaneOutcome[] | undefined, lane: string) {
	return (rows ?? []).filter((row) => row.lane === lane)
}

/** A request with no caller-stated capabilities: they come from the snapshot. */
function request(
	source: ReturnType<typeof harness>["source"],
	paths: RetrievalPath[],
) {
	return runWithIndexHealth(source, () =>
		searchV2({} as Db, PREFIX, "what did we decide", "agent-1", {
			availablePaths: new Set(paths),
			searchOptions: { allowHybridBackstop: false },
		}),
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_TEMPORAL_COVERAGE_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
	coverage({})
	vi.mocked(searchStructuredMemory).mockResolvedValue([])
	vi.mocked(findExactProcedureMatches).mockResolvedValue([])
	vi.mocked(searchProcedures).mockResolvedValue([])
	vi.mocked(searchEpisodes).mockResolvedValue([])
	vi.mocked(searchEntitiesAutocomplete).mockResolvedValue([])
	vi.mocked(expandGraph).mockResolvedValue(null)
	vi.mocked(mongoSearch).mockResolvedValue([])
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("searchV2 lane gate on the request's index snapshot (M2 decision 8)", () => {
	it.each([
		{
			name: "healthy to STALE",
			patch: { status: "STALE" },
			reason: "index-stale",
		},
		{
			name: "BUILDING",
			patch: { status: "BUILDING", queryable: false },
			reason: "index-unavailable",
		},
		{
			name: "NOT_STARTED and not queryable",
			patch: { status: "PENDING", queryable: false },
			reason: "index-unavailable",
		},
		{ name: "deleted", patch: null, reason: "index-unavailable" },
	] as const)("$name: the structured lane fails typed and never runs, the episodic sibling stands", async ({
		patch,
		reason,
	}) => {
		plan(["structured", "episodic"])
		const { source, indexes } = harness()
		setStatus(indexes, STRUCTURED_TEXT, patch)

		const result = await request(source, ["structured", "episodic"])

		expect(rowsFor(result.metadata.laneOutcomes, "structured")).toEqual([
			{
				lane: "structured",
				stage: "index-health",
				outcome: "failed",
				reason,
			},
		])
		expect(searchStructuredMemory).not.toHaveBeenCalled()
		expect(searchEpisodes).toHaveBeenCalledTimes(1)
		expect(rowsFor(result.metadata.laneOutcomes, "episodic")).toContainEqual(
			expect.objectContaining({ stage: "lane", outcome: "ok-empty" }),
		)
		expect(result.metadata.outcomeStatus).toBe("partial")
	})

	it("a request whose only lane is unhealthy is failed, never an empty success", async () => {
		plan(["structured"])
		const { source, indexes } = harness()
		setStatus(indexes, STRUCTURED_TEXT, { status: "STALE" })

		const result = await request(source, ["structured"])

		expect(result.results).toEqual([])
		expect(result.metadata.outcomeStatus).toBe("failed")
		expect(rowsFor(result.metadata.laneOutcomes, "structured")).toEqual([
			{
				lane: "structured",
				stage: "index-health",
				outcome: "failed",
				reason: "index-stale",
			},
		])
	})

	it("a failed metadata read is index-unavailable for every lane that needs it, read once, with no provider text in the rows", async () => {
		plan(["structured", "procedural"])
		const { source, listReads } = harness((collection) =>
			collection === CHUNKS
				? new Error("PRIVATE mongot unreachable")
				: undefined,
		)

		const result = await request(source, ["structured", "procedural"])

		for (const lane of ["structured", "procedural"]) {
			expect(rowsFor(result.metadata.laneOutcomes, lane)).toEqual([
				{
					lane,
					stage: "index-health",
					outcome: "failed",
					reason: "index-unavailable",
				},
			])
		}
		expect(searchStructuredMemory).not.toHaveBeenCalled()
		expect(searchProcedures).not.toHaveBeenCalled()
		expect(listReads(CHUNKS)).toBe(1)
		expect(JSON.stringify(result.metadata)).not.toContain("PRIVATE")
		expect(result.metadata.outcomeStatus).toBe("failed")
	})

	it("a stale text index fails the hybrid chunk lane typed instead of degrading to vector only", async () => {
		plan(["hybrid"])
		const { source, indexes } = harness()
		setStatus(indexes, CHUNKS_TEXT, { status: "STALE" })

		const result = await request(source, ["hybrid"])

		expect(mongoSearch).not.toHaveBeenCalled()
		expect(rowsFor(result.metadata.laneOutcomes, "hybrid:chunks")).toEqual([
			{
				lane: "hybrid:chunks",
				stage: "index-health",
				outcome: "failed",
				reason: "index-stale",
			},
		])
		expect(result.metadata.outcomeStatus).not.toBe("complete")
	})

	it("recovers on the next request once the index is healthy again", async () => {
		plan(["structured"])
		const { source, indexes } = harness()
		setStatus(indexes, CHUNKS_VECTOR, { status: "STALE" })
		const during = await request(source, ["structured"])
		expect(during.metadata.outcomeStatus).toBe("failed")
		expect(searchStructuredMemory).not.toHaveBeenCalled()

		setStatus(indexes, CHUNKS_VECTOR, { status: "READY", queryable: true })
		const after = await request(source, ["structured"])

		expect(searchStructuredMemory).toHaveBeenCalledTimes(1)
		expect(after.metadata.outcomeStatus).toBe("complete")
		expect(rowsFor(after.metadata.laneOutcomes, "structured")).toEqual([
			{
				lane: "structured",
				stage: "lane",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("reads each collection's metadata once per request and not again for later lanes", async () => {
		plan(["structured", "procedural"])
		const { source, listReads } = harness()

		await request(source, ["structured", "procedural"])

		expect(listReads(CHUNKS)).toBe(1)
		expect(listReads(`${PREFIX}structured_mem`)).toBe(1)
		expect(listReads(`${PREFIX}procedures`)).toBe(1)
	})

	it("a caller that states its own capabilities and opens no scope reads no index metadata", async () => {
		plan(["structured"])
		const { calls } = harness()

		const result = await searchV2(
			{} as Db,
			PREFIX,
			"what did we decide",
			"agent-1",
			{
				availablePaths: new Set<RetrievalPath>(["structured"]),
				searchOptions: {
					allowHybridBackstop: false,
					capabilities: HEALTHY_TEST_CAPABILITIES,
				},
			},
		)

		expect(result.metadata.outcomeStatus).toBe("complete")
		expect(calls).toEqual([])
	})

	it("refuses a caller with neither capabilities nor a request scope instead of assuming healthy", async () => {
		plan(["structured"])

		await expect(
			searchV2({} as Db, PREFIX, "what did we decide", "agent-1", {
				availablePaths: new Set<RetrievalPath>(["structured"]),
				searchOptions: { allowHybridBackstop: false },
			}),
		).rejects.toMatchObject({
			name: "SearchLaneError",
			reason: "internal-error",
		})
		expect(searchStructuredMemory).not.toHaveBeenCalled()
	})
})

describe("index metadata checks in the request ledger (M2 decision 8)", () => {
	it("are reported separately and spend none of the retrieval budget", async () => {
		plan(["structured"])
		const { source } = harness()
		// The lane spends one aggregation; the three metadata reads (chunks,
		// structured_mem, procedures) must not add to it.
		vi.mocked(searchStructuredMemory).mockImplementation(async () => {
			expect(tryConsumeSearchAggregation()).toBe(true)
			return []
		})

		const result = await runWithIndexHealth(source, () =>
			searchV2({} as Db, PREFIX, "what did we decide", "agent-1", {
				availablePaths: new Set<RetrievalPath>(["structured"]),
				searchOptions: {
					allowHybridBackstop: false,
					budget: { maxAggregations: 8, maxEmbeds: 4 },
				},
			}),
		)

		expect(result.metadata.outcomeStatus).toBe("complete")
		const budget = result.metadata.budget
		expect(budget).toMatchObject({ aggregations: 1, embeds: 0 })
		expect(budget?.indexHealth).toEqual({
			metadataReads: 3,
			failedMetadataReads: 0,
			indexesChecked: expect.any(Number),
		})
		expect(budget?.indexHealth?.indexesChecked).toBeGreaterThanOrEqual(6)
	})

	it("count a failed read as failed, apart from retrieval work", async () => {
		plan(["structured"])
		const { source } = harness((collection) =>
			collection === CHUNKS ? new Error("mongot unreachable") : undefined,
		)

		const result = await request(source, ["structured"])

		expect(result.metadata.budget).toMatchObject({ aggregations: 0, embeds: 0 })
		expect(result.metadata.budget?.indexHealth).toMatchObject({
			failedMetadataReads: 1,
		})
	})
})
