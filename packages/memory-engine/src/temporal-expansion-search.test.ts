import type { Db, Document } from "mongodb"
import { MongoServerError } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { runWithSearchBudget } from "./mongodb-search-budget.js"
import { searchTemporalCoverageEvents } from "./mongodb-search-lanes.js"
import { SearchLaneError, type SearchTierOutcome } from "./search-outcomes.js"

// M2 T6 (G1-28): the temporal-coverage lane's session expansion selects the
// hit sessions' user turns through $search with the session ids in
// compound.filter. It is a Search aggregate like any other: charged to the
// request ledger, typed on failure, and never replaced by a find.

const questionDate = new Date("2026-01-10T00:00:00Z")
const anchor = {
	eventId: "anchor",
	agentId: "agent-1",
	scope: "agent",
	scopeRef: "agent:test",
	sessionId: "s1",
	role: "user",
	body: "freshness orchard",
	timestamp: new Date("2026-01-09T00:00:00Z"),
	score: 3,
}

function database(expansion: Document[] | Error) {
	const pipelines: Document[][] = []
	const find = vi.fn(() => {
		throw new Error("the expansion must not select with find")
	})
	const db = {
		collection: () => ({
			find,
			aggregate: (pipeline: Document[]) => {
				pipelines.push(pipeline)
				return {
					toArray: async () => {
						const isExpansion = pipeline[0]?.$search?.compound?.filter?.some(
							(clause: Document) => clause.in?.path === "sessionId",
						)
						if (!isExpansion) return [anchor]
						if (expansion instanceof Error) throw expansion
						return expansion
					},
				}
			},
		}),
	} as unknown as Db
	return { db, pipelines, find }
}

function run(db: Db, rows: SearchTierOutcome[] = []) {
	return searchTemporalCoverageEvents({
		db,
		prefix: "mem_",
		query: "recent freshness",
		questionDate,
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:test",
		maxResults: 20,
		capabilities: {
			vectorSearch: true,
			textSearch: true,
			scoreFusion: false,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		},
		onTierOutcome: (row) => rows.push(row),
	})
}

beforeEach(() => {
	resetSearchAdmissionForTests(Date.now())
})

describe("temporal session expansion selects through $search", () => {
	it("charges the expansion's Search aggregate to the request ledger", async () => {
		const { db, pipelines, find } = database([anchor])
		const rows: SearchTierOutcome[] = []
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 12, maxEmbeds: 5 },
			() => run(db, rows),
		)
		expect(find).not.toHaveBeenCalled()
		expect(pipelines).toHaveLength(2)
		expect(budget).toMatchObject({ aggregations: 2, embeds: 0 })
		expect(rows).toContainEqual({
			stage: "atlas-search",
			outcome: "ok",
			resultCount: 1,
		})
	})

	it("types an expansion failure instead of dropping the expansion", async () => {
		const driverError = new MongoServerError({ errmsg: "private", code: 2 })
		const { db, find } = database(driverError)
		const failure = await run(db).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			stage: "atlas-search",
			reason: "query-error",
		})
		expect((failure as Error).cause).toBe(driverError)
		expect(find).not.toHaveBeenCalled()
	})

	it("keeps each session's earliest candidate whatever order Search returns", async () => {
		const opener = {
			...anchor,
			eventId: "opener",
			body: "hello there",
			timestamp: new Date("2026-01-01T00:00:00Z"),
			score: 0.1,
		}
		// Search ranks the term-bearing turns first and the termless opener
		// last; more term-bearing turns than the per-session pick (3) means
		// only the time-ordered first pick keeps the opener.
		const termBearing = [1, 2, 3, 4].map((n) => ({
			...anchor,
			eventId: `turn-${n}`,
			timestamp: new Date(`2026-01-0${n + 4}T00:00:00Z`),
		}))
		const { db } = database([anchor, ...termBearing, opener])
		const results = await run(db)
		const expanded = results.filter(
			(result) => result.provenance?.temporalSessionExpansion === true,
		)
		expect(expanded.map((result) => result.path)).toContain("events/opener")
	})
})
