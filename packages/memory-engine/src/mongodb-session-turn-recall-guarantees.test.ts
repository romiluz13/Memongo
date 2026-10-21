import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	SESSION_TURN_RECALL_TURNS_PER_SESSION,
	insertRecalledTurns,
	recallSessionTurns,
} from "./mongodb-session-turn-recall.js"
import { buildEventLifecycleClause } from "./mongodb-temporal.js"
import type { SearchTierOutcome } from "./search-outcomes.js"
import {
	type FakeEvent,
	fakeEventsDb,
} from "./test-helpers/fake-event-rank-fusion.js"
import type { MemorySearchResult } from "./types.js"

// Fictional data: a beekeeper's sessions with an assistant. Each seed
// session's top T is computed among its own turns, and a recalled merge
// never costs a stage-1 session its last result.

const namespace = {
	agentId: "agent-hive",
	scope: "agent",
	scopeRef: "agent:hive",
} as const
const questionDate = new Date("2026-06-01T00:00:00Z")
const query = "when is the honey harvest"
const capabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}

function turn(eventId: string, sessionId: string, body: string): FakeEvent {
	return {
		eventId,
		...namespace,
		sessionId,
		role: "user",
		body,
		timestamp: new Date("2026-05-01T08:00:00Z"),
	}
}

function result(
	id: string,
	sessionId: string | undefined,
	score: number,
): MemorySearchResult {
	return {
		path: `events/${id}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: `stage one ${id}`,
		text: `stage one ${id}`,
		source: "conversation",
		canonicalId: `event:${id}`,
		...(sessionId ? { sessionId } : {}),
	}
}

function recalledTurn(
	id: string,
	sessionId: string,
	inSessionRank: number,
): MemorySearchResult {
	return {
		...result(id, sessionId, 0.01),
		provenance: { lane: "session-turn-recall", inSessionRank },
	}
}

async function recall(
	db: ReturnType<typeof fakeEventsDb>["db"],
	results: MemorySearchResult[],
) {
	const rows: SearchTierOutcome[] = []
	const recalled = await recallSessionTurns({
		db,
		prefix: "mem_",
		query,
		questionDate,
		namespace,
		results,
		capabilities,
		embeddingMode: "automated",
		queryEmbeddingModel: "voyage-4-large",
		onTierOutcome: (row) => rows.push(row),
	})
	return { recalled, rows }
}

const ids = (results: MemorySearchResult[]) => results.map((r) => r.canonicalId)

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-06-02T00:00:00Z"))
	resetSearchAdmissionForTests(Date.now())
})

afterEach(() => {
	vi.useRealTimers()
})

// Seven loud seed sessions of 11 turns each (77 turns that match the query
// in both inputs) and one quiet session whose turns share no query word and
// sit at the bottom of the vector ranking.
const loudSessions = Array.from({ length: 7 }, (_, s) => `s-loud-${s}`)
const loudTurns = loudSessions.flatMap((sessionId, s) =>
	Array.from({ length: 11 }, (_, k) =>
		turn(`loud-${s}-${k}`, sessionId, `honey harvest note ${s} ${k}`),
	),
)
const quietTurns = [
	turn("quiet-1", "s-quiet", "smoker fuel: pine needles"),
	turn("quiet-2", "s-quiet", "my neighbor keeps chickens"),
	turn("quiet-3", "s-quiet", "we painted supers blue"),
	turn("quiet-4", "s-quiet", "hive stand built from cedar"),
]
const similarity = {
	...Object.fromEntries(loudTurns.map((t) => [t.eventId, 0.9])),
	"quiet-1": 0.04,
	"quiet-2": 0.03,
	"quiet-3": 0.02,
	"quiet-4": 0.01,
}
const seedResults = [
	...loudSessions.map((sessionId, s) => result(`seed-${s}`, sessionId, 1)),
	result("seed-quiet", "s-quiet", 0.5),
]
const seeds = [...loudSessions, "s-quiet"]

describe("session turn recall: per-session top T", () => {
	it("recalls the top T of a seed session whose best turn ranks below 72nd across the seeds", async () => {
		const { db } = fakeEventsDb([...loudTurns, ...quietTurns], { similarity })
		const { recalled } = await recall(db, seedResults)
		const quiet = recalled.filter((r) => r.sessionId === "s-quiet")
		expect(ids(quiet)).toEqual([
			"event:quiet-1",
			"event:quiet-2",
			"event:quiet-3",
		])
		expect(quiet.map((r) => r.provenance?.inSessionRank)).toEqual([1, 2, 3])
		for (const sessionId of loudSessions) {
			expect(recalled.filter((r) => r.sessionId === sessionId)).toHaveLength(
				SESSION_TURN_RECALL_TURNS_PER_SESSION,
			)
		}
	})

	it("counts the seed turns once, then sizes both inputs to that count with one exact vector input", async () => {
		const { db, pipelines, counts } = fakeEventsDb(
			[...loudTurns, ...quietTurns],
			{ similarity },
		)
		await recall(db, seedResults)
		const canonicalFilter = {
			agentId: "agent-hive",
			scope: "agent",
			scopeRef: "agent:hive",
			sessionId: { $in: seeds },
			timestamp: { $lte: questionDate },
		}
		expect(counts).toEqual([
			{
				$and: [
					canonicalFilter,
					buildEventLifecycleClause({ asOf: questionDate }),
				],
			},
		])
		expect(pipelines).toHaveLength(1)
		const fusion = pipelines[0][0].$rankFusion.input.pipelines
		expect(fusion.vector[0]).toEqual({
			$vectorSearch: {
				index: "mem_events_vector",
				path: "body",
				query: { text: query },
				model: "voyage-4-large",
				filter: canonicalFilter,
				exact: true,
				limit: 81,
				returnStoredSource: false,
			},
		})
		expect(fusion.text[0].$search.compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-hive" } },
			{ equals: { path: "scope", value: "agent" } },
			{ equals: { path: "scopeRef", value: "agent:hive" } },
			{ in: { path: "sessionId", value: seeds } },
			{ range: { path: "timestamp", lte: questionDate } },
		])
		expect(fusion.text.at(-1)).toEqual({ $limit: 81 })
		expect(pipelines[0][1]).toEqual({ $limit: 162 })
		// One query embedding: the single autoEmbed vector input of one aggregate.
		expect(JSON.stringify(pipelines).match(/"\$vectorSearch"/g)).toHaveLength(1)
	})

	it("reports seeds holding more than 10000 turns as not applicable and runs no fusion", async () => {
		const crowded = Array.from({ length: 10_001 }, (_, k) =>
			turn(`crowd-${k}`, "s-crowd", "honey harvest"),
		)
		const { db, pipelines, counts } = fakeEventsDb(crowded)
		const { recalled, rows } = await recall(db, [result("seed", "s-crowd", 1)])
		expect(counts).toHaveLength(1)
		expect(pipelines).toHaveLength(0)
		expect(recalled).toEqual([])
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "query-shape" },
		])
	})

	it("runs no fusion when the seed sessions hold no turn in reach", async () => {
		const { db, pipelines } = fakeEventsDb([
			turn("other-1", "s-other", "honey harvest"),
		])
		const { recalled, rows } = await recall(db, [result("seed", "s-empty", 1)])
		expect(pipelines).toHaveLength(0)
		expect(recalled).toEqual([])
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "no-candidates" },
		])
	})
})

describe("session turn recall: merge under maxResults", () => {
	it("inserts without eviction when the recalled turns fit", () => {
		const merged = insertRecalledTurns(
			[result("a1", "s-a", 0.9), result("b1", "s-b", 0.8)],
			[recalledTurn("ta", "s-a", 1)],
			5,
		)
		expect(ids(merged.results)).toEqual(["event:a1", "event:ta", "event:b1"])
		expect(merged.summary).toEqual({
			recalled: 1,
			inserted: 1,
			stageOneEvicted: 0,
			recalledDroppedForRoom: 0,
			recalledDroppedPastCap: 0,
		})
	})

	it("evicts tail stage-1 results of sessions that keep a better one, and never a session's last result", () => {
		const stageOne = [
			result("a1", "s-a", 0.9),
			result("b1", "s-b", 0.8),
			result("a2", "s-a", 0.7),
			result("c1", "s-c", 0.6),
			result("x1", undefined, 0.55),
			result("b2", "s-b", 0.5),
			result("d1", "s-d", 0.4),
		]
		const merged = insertRecalledTurns(
			stageOne,
			[recalledTurn("ta", "s-a", 1), recalledTurn("tb", "s-b", 1)],
			7,
		)
		expect(ids(merged.results)).toEqual([
			"event:a1",
			"event:ta",
			"event:b1",
			"event:tb",
			"event:c1",
			"event:x1",
			"event:d1",
		])
		expect(merged.results[1]?.score).toBe(0.9)
		expect(merged.summary).toEqual({
			recalled: 2,
			inserted: 2,
			stageOneEvicted: 2,
			recalledDroppedForRoom: 0,
			recalledDroppedPastCap: 0,
		})
	})

	it("drops the lowest recalled turns, latest inserted first, once no stage-1 result can go", () => {
		const stageOne = [
			result("a1", "s-a", 0.9),
			result("b1", "s-b", 0.8),
			result("a2", "s-a", 0.7),
		]
		const merged = insertRecalledTurns(
			stageOne,
			[
				recalledTurn("ta1", "s-a", 1),
				recalledTurn("ta2", "s-a", 2),
				recalledTurn("tb1", "s-b", 1),
				recalledTurn("tb2", "s-b", 2),
			],
			5,
		)
		expect(ids(merged.results)).toEqual([
			"event:a1",
			"event:ta1",
			"event:ta2",
			"event:b1",
			"event:tb1",
		])
		expect(merged.summary).toEqual({
			recalled: 4,
			inserted: 3,
			stageOneEvicted: 1,
			recalledDroppedForRoom: 1,
			recalledDroppedPastCap: 0,
		})
	})

	it("drops recalled turns whose session's best stage-1 result lies past maxResults", () => {
		const merged = insertRecalledTurns(
			[
				result("a1", "s-a", 0.9),
				result("b1", "s-b", 0.8),
				result("c1", "s-c", 0.7),
				result("d1", "s-d", 0.6),
			],
			[recalledTurn("ta", "s-a", 1), recalledTurn("td", "s-d", 1)],
			3,
		)
		expect(ids(merged.results)).toEqual(["event:a1", "event:b1", "event:c1"])
		expect(merged.summary).toEqual({
			recalled: 2,
			inserted: 0,
			stageOneEvicted: 0,
			recalledDroppedForRoom: 1,
			recalledDroppedPastCap: 1,
		})
	})

	it("throws on a recalled turn without its in-session rank", () => {
		const unranked = {
			...result("tu", "s-a", 0.01),
			provenance: { lane: "session-turn-recall" as const },
		}
		expect(() =>
			insertRecalledTurns([result("a1", "s-a", 0.9)], [unranked], 5),
		).toThrow("recalled turn canonical:event:tu has no in-session rank")
	})
})
