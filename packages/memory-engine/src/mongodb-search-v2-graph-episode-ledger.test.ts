// M2 #122 R1: the graph and episodic lanes run their real Search aggregates
// (entity autocomplete, episode text search) through the charged executor.
// Each lane reserves its real cost before it runs, every emitted aggregate is
// charged to the request ledger, and an exhausted ledger is a typed
// reservation denial with nothing emitted.
import type { Db, Document } from "mongodb"
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

import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	DEFAULT_SEARCH_BUDGET,
	runWithSearchBudget,
	tryConsumeSearchWork,
} from "./mongodb-search-budget.js"
import { searchV2 } from "./mongodb-search-v2.js"

const PREFIX = "test_"
const ENTITY_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]

/** A Db whose Search aggregates find nothing; every aggregate is recorded. */
function recordingDb() {
	const emitted: Array<{ collection: string; pipeline: Document[] }> = []
	const db = {
		collection: (name: string) => ({
			collectionName: name,
			aggregate: (pipeline: Document[]) => {
				emitted.push({ collection: name, pipeline })
				return { toArray: async () => [] }
			},
		}),
	} as unknown as Db
	const searchAggregates = () =>
		emitted.filter(({ pipeline }) => "$search" in (pipeline[0] ?? {}))
	return { db, emitted, searchAggregates }
}

function plan(paths: RetrievalPath[]) {
	vi.mocked(planRetrieval).mockReturnValue({
		paths,
		confidence: "high",
		reasoning: "owned fixture",
	})
}

function run(db: Db, paths: RetrievalPath[]) {
	return searchV2(db, PREFIX, "what happened with the launch", "agent-1", {
		availablePaths: new Set(paths),
		knownEntityNames: ENTITY_NAMES,
		hasGraphData: true,
		hasEpisodes: true,
		searchOptions: {
			allowHybridBackstop: false,
			scope: "agent",
			scopeRef: "agent:agent-1",
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
		},
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_EVIDENCE_MIRROR_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("graph and episodic lanes charge the request ledger (#122 R1)", () => {
	it("graph: each entity lookup it emits is one charged aggregation, at most four", async () => {
		plan(["graph"])
		const fake = recordingDb()

		const result = await run(fake.db, ["graph"])

		const lookups = fake.searchAggregates()
		expect(lookups).toHaveLength(4)
		expect(
			lookups.every(({ collection }) => collection === `${PREFIX}entities`),
		).toBe(true)
		expect(result.metadata.budget).toMatchObject({
			aggregations: lookups.length,
			embeds: 0,
		})
	})

	it("episodic: its one Search aggregate is one charged aggregation", async () => {
		plan(["episodic"])
		const fake = recordingDb()

		const result = await run(fake.db, ["episodic"])

		const searches = fake.searchAggregates()
		expect(searches).toHaveLength(1)
		expect(searches[0]?.collection).toBe(`${PREFIX}episodes`)
		expect(result.metadata.budget).toMatchObject({
			aggregations: searches.length,
			embeds: 0,
		})
	})

	it("graph and episodic together: emitted aggregates equal the ledger snapshot", async () => {
		plan(["graph", "episodic"])
		const fake = recordingDb()

		const result = await run(fake.db, ["graph", "episodic"])

		expect(result.metadata.budget).toMatchObject({
			aggregations: fake.searchAggregates().length,
			embeds: 0,
		})
		expect(fake.searchAggregates()).toHaveLength(5)
	})

	it("graph: a ledger without room for its lookups is a typed reservation denial and emits nothing", async () => {
		plan(["graph"])
		const fake = recordingDb()

		const { value: result, budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				// Earlier work of this request left three aggregations.
				tryConsumeSearchWork({ aggregations: 9, embeds: 0 })
				return run(fake.db, ["graph"])
			},
		)

		expect(fake.emitted).toEqual([])
		expect(result.results).toEqual([])
		expect(result.metadata.outcomeStatus).toBe("failed")
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "graph",
			stage: "reservation",
			outcome: "budget-denied",
			reason: "budget-reservation",
		})
		expect(budget).toMatchObject({ aggregations: 9, embeds: 0 })
	})

	it("episodic: an exhausted ledger is a typed reservation denial and emits nothing", async () => {
		plan(["episodic"])
		const fake = recordingDb()

		const { value: result, budget } = await runWithSearchBudget(
			DEFAULT_SEARCH_BUDGET,
			async () => {
				tryConsumeSearchWork({ aggregations: 12, embeds: 0 })
				return run(fake.db, ["episodic"])
			},
		)

		expect(fake.emitted).toEqual([])
		expect(result.metadata.outcomeStatus).toBe("failed")
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "episodic",
			stage: "reservation",
			outcome: "budget-denied",
			reason: "budget-reservation",
		})
		expect(budget).toMatchObject({ aggregations: 12, embeds: 0 })
	})
})
