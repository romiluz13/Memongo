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
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { searchV2 } from "./mongodb-search-v2.js"

// M2 T6 (G1-28): raw-window candidates come from one $search over the
// window; scoring, the temporal-proximity boost and ordering are
// composition over them. The fake applies the pipeline's own $match and
// $limit stages to the candidates its Search stage admits, the way mongod
// would, so stale index admissions are excluded only by the lane's
// post-stage revalidation.

const capabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}
const questionDate = new Date("2026-03-10T12:00:00Z")
const OWNER = { agentId: "agent-1", scope: "agent", scopeRef: "agent:agent-1" }

function matches(doc: Document, filter: Document): boolean {
	return Object.entries(filter).every(([key, value]) => {
		if (key === "$and")
			return (value as Document[]).every((f) => matches(doc, f))
		if (key === "$or") return (value as Document[]).some((f) => matches(doc, f))
		if (value instanceof Date) return doc[key]?.getTime?.() === value.getTime()
		if (value !== null && typeof value === "object") {
			return Object.entries(value as Document).every(([op, operand]) => {
				const field = doc[key]
				switch (op) {
					case "$exists":
						return (field !== undefined) === operand
					case "$gte":
						return field !== undefined && field >= operand
					case "$lte":
						return field !== undefined && field <= operand
					case "$gt":
						return field !== undefined && field !== null && field > operand
					case "$in":
						return (operand as unknown[]).includes(field)
					default:
						throw new Error(`fake does not implement ${op}`)
				}
			})
		}
		if (value === null) return doc[key] === null || doc[key] === undefined
		return doc[key] === value
	})
}

function event(eventId: string, overrides: Document = {}): Document {
	return {
		eventId,
		...OWNER,
		body: `note ${eventId}`,
		role: "user",
		sessionId: "s1",
		timestamp: new Date("2026-03-10T08:00:00Z"),
		invalidAt: null,
		...overrides,
	}
}

function database(
	admitted: Document[],
	outcome: "ok" | "fail" = "ok",
): { db: Db; pipelines: Document[][]; find: ReturnType<typeof vi.fn> } {
	const pipelines: Document[][] = []
	const find = vi.fn(() => {
		throw new Error("raw-window must not select with find")
	})
	const db = {
		collection: () => ({
			find,
			aggregate: (pipeline: Document[]) => {
				pipelines.push(pipeline)
				return {
					toArray: async () => {
						if (outcome === "fail") {
							throw new MongoServerError({ errmsg: "private", code: 2 })
						}
						let docs = admitted
						for (const stage of pipeline.slice(1)) {
							if (stage.$match)
								docs = docs.filter((d) => matches(d, stage.$match))
							if (typeof stage.$limit === "number")
								docs = docs.slice(0, stage.$limit)
						}
						return docs
					},
				}
			},
		}),
	} as unknown as Db
	return { db, pipelines, find }
}

function search(
	db: Db,
	query: string,
	options: { timeRange?: { start: Date; end: Date } } = {},
) {
	return searchV2(db, "test_", query, "agent-1", {
		availablePaths: new Set(["raw-window"]),
		searchOptions: {
			capabilities,
			scope: "agent",
			scopeRef: "agent:agent-1",
			questionDate,
			allowHybridBackstop: false,
			...(options.timeRange ? { timeRange: options.timeRange } : {}),
		},
	})
}

beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_BENCHMARK_TURN_PRECISION_MODE", "disabled")
	vi.stubEnv("MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE", "disabled")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
})
afterEach(() => {
	vi.unstubAllEnvs()
})

describe("raw-window selects through $search", () => {
	it("runs one $search with identity and the window in compound.filter and text on the body", async () => {
		const { db, pipelines, find } = database([
			event("e1", {
				body: "deploy rollback plan",
				timestamp: new Date("2026-03-03T00:00:00Z"),
			}),
		])
		const start = new Date("2026-03-01T00:00:00Z")
		const end = new Date("2026-03-05T00:00:00Z")
		const result = await search(db, "deploy rollback plan", {
			timeRange: { start, end },
		})
		expect(find).not.toHaveBeenCalled()
		expect(pipelines).toHaveLength(1)
		const stage = pipelines[0]?.[0]?.$search
		expect(stage.index).toBe("test_events_text")
		expect(stage.compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
			{ equals: { path: "scope", value: "agent" } },
			{ equals: { path: "scopeRef", value: "agent:agent-1" } },
			{ range: { path: "timestamp", gte: start, lte: end } },
		])
		expect(stage.compound.must).toEqual([
			{ text: { query: ["deploy", "rollback", "plan"], path: "body" } },
		])
		// Bound: 50 candidates, applied after the post-stage re-checks.
		const limitIndex = pipelines[0]?.findIndex((s) => s.$limit === 50) ?? -1
		const lastMatch = pipelines[0]?.findLastIndex((s) => s.$match) ?? -1
		expect(lastMatch).toBeGreaterThan(0)
		expect(limitIndex).toBeGreaterThan(lastMatch)
		// Ledger: the new Search aggregate is charged to the request.
		expect(result.metadata.budget).toMatchObject({ aggregations: 1, embeds: 0 })
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "raw-window",
			stage: "atlas-search",
			outcome: "ok",
			resultCount: 1,
		})
	})

	it("defaults the window to the 24 h before the reference clock and checks validity at it", async () => {
		const { db, pipelines } = database([])
		await search(db, "deploy rollback")
		const range = pipelines[0]?.[0]?.$search?.compound?.filter?.[3]?.range
		expect(range).toEqual({
			path: "timestamp",
			gte: new Date("2026-03-09T12:00:00Z"),
			lte: questionDate,
		})
		const lifecycle = JSON.stringify(
			pipelines[0]?.find((s) => JSON.stringify(s).includes("invalidAt")),
		)
		expect(lifecycle).toContain(JSON.stringify(questionDate))
	})

	it("excludes wrong-scope, out-of-window and lifecycle-changed stale admissions", async () => {
		// The Search stage admits every candidate from a stale index copy.
		const control = event("control", { body: "deploy rollback steps" })
		const victims = [
			event("wrong-scope", {
				scopeRef: "agent:other",
				body: "deploy rollback",
			}),
			event("wrong-owner", { agentId: "agent-2", body: "deploy rollback" }),
			event("out-of-window", {
				timestamp: new Date("2026-03-01T00:00:00Z"),
				body: "deploy rollback",
			}),
			event("retracted", {
				invalidAt: new Date("2026-03-10T09:00:00Z"),
				body: "deploy rollback",
			}),
			event("not-yet-valid", {
				validAt: new Date("2026-03-11T00:00:00Z"),
				body: "deploy rollback",
			}),
			event("expired", {
				expiresAt: new Date(Date.now() - 60_000),
				body: "deploy rollback",
			}),
		]
		const { db } = database([...victims, control])
		const result = await search(db, "deploy rollback")
		const paths = result.results.map((r) => r.path)
		expect(paths).toContain("events/control")
		for (const victim of victims) {
			expect(paths).not.toContain(`events/${victim.eventId}`)
		}
	})

	it("keeps term scoring, the proximity boost and a deterministic order over the candidates", async () => {
		const sameTime = new Date("2026-03-10T07:00:00Z")
		const candidates = [
			event("b-tie", { body: "deploy notes", timestamp: sameTime }),
			event("strong", {
				body: "deploy rollback for v2-api",
				timestamp: new Date("2026-03-10T01:00:00Z"),
			}),
			event("a-tie", { body: "deploy notes", timestamp: sameTime }),
			event("weak-late", {
				body: "deploy notes",
				timestamp: new Date("2026-03-10T11:00:00Z"),
			}),
		]
		const orders: string[][] = []
		for (const admitted of [candidates, [...candidates].reverse()]) {
			const { db } = database(admitted)
			const result = await search(db, "deploy rollback v2-api")
			orders.push(
				result.results
					.filter((r) => r.provenance?.lane === "raw-window")
					.map((r) => r.path),
			)
		}
		expect(orders[0]).toEqual([
			"events/strong",
			"events/weak-late",
			"events/a-tie",
			"events/b-tie",
		])
		expect(orders[1]).toEqual(orders[0])
	})

	it("keeps a healthy zero final: no chronological listing replaces it", async () => {
		const { db, find } = database([])
		const result = await search(db, "deploy rollback")
		expect(find).not.toHaveBeenCalled()
		expect(
			result.results.filter((r) => r.provenance?.lane === "raw-window"),
		).toEqual([])
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane: "raw-window",
			stage: "atlas-search",
			outcome: "ok-empty",
			reason: "zero-hits",
			resultCount: 0,
		})
	})

	it("reports a Search failure as a typed failed lane, never an empty success", async () => {
		const { db, find } = database([event("e1")], "fail")
		const result = await search(db, "deploy rollback")
		expect(find).not.toHaveBeenCalled()
		const rows = result.metadata.laneOutcomes?.filter(
			(row) => row.lane === "raw-window",
		)
		expect(rows).toEqual([
			{
				lane: "raw-window",
				stage: "atlas-search",
				outcome: "failed",
				reason: "query-error",
			},
		])
		expect(result.metadata.outcomeStatus).toBe("failed")
	})

	it("is never skipped on a capability flag: it runs one $search, and a Search failure fails the lane", async () => {
		const { db, pipelines, find } = database([event("e1")], "fail")
		const result = await searchV2(db, "test_", "deploy rollback", "agent-1", {
			availablePaths: new Set(["raw-window"]),
			searchOptions: {
				capabilities: { ...capabilities, textSearch: false },
				scope: "agent",
				scopeRef: "agent:agent-1",
				questionDate,
				allowHybridBackstop: false,
			},
		})
		expect(find).not.toHaveBeenCalled()
		expect(pipelines).toHaveLength(1)
		expect(
			result.metadata.laneOutcomes?.filter((row) => row.lane === "raw-window"),
		).toEqual([
			{
				lane: "raw-window",
				stage: "atlas-search",
				outcome: "failed",
				reason: "query-error",
			},
		])
		expect(result.metadata.outcomeStatus).toBe("failed")
	})

	it("fails the request typed in strict mode", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
		const { db } = database([event("e1")], "fail")
		const failure = await search(db, "deploy rollback").catch(
			(err: unknown) => err,
		)
		expect(failure).toMatchObject({
			name: "SearchLaneError",
			stage: "atlas-search",
			reason: "query-error",
		})
	})
})
