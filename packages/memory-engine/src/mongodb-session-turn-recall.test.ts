import type { Document } from "mongodb"
import { beforeEach, describe, expect, it } from "vitest"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	SESSION_TURN_RECALL_SEED_SESSIONS,
	insertRecalledTurns,
	recallSessionTurns,
} from "./mongodb-session-turn-recall.js"
import { SearchLaneError, type SearchTierOutcome } from "./search-outcomes.js"
import {
	type FakeEvent,
	fakeEventsDb,
} from "./test-helpers/fake-event-rank-fusion.js"
import type { MemorySearchResult } from "./types.js"

// Fictional data: a gardener talks to an assistant across several sessions.

const namespace = {
	agentId: "agent-wren",
	scope: "agent",
	scopeRef: "agent:wren",
} as const
const questionDate = new Date("2026-05-01T00:00:00Z")
const capabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}

function event(
	eventId: string,
	sessionId: string,
	body: string,
	overrides: Partial<FakeEvent> = {},
): FakeEvent {
	return {
		eventId,
		...namespace,
		sessionId,
		role: "user",
		body,
		timestamp: new Date(
			`2026-04-${10 + Number(eventId.at(-1) ?? 0)}T08:00:00Z`,
		),
		...overrides,
	}
}

function stage1(
	id: string,
	sessionId: string | undefined,
	score: number,
	text = `stage one ${id}`,
): MemorySearchResult {
	return {
		path: `events/${id}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: text,
		text,
		source: "conversation",
		canonicalId: `event:${id}`,
		...(sessionId ? { sessionId } : {}),
		sourceEventIds: [id],
	}
}

const ids = (results: MemorySearchResult[]) =>
	results.map((result) => result.canonicalId)

async function recall(
	db: ReturnType<typeof fakeEventsDb>["db"],
	results: MemorySearchResult[],
	overrides: Partial<Parameters<typeof recallSessionTurns>[0]> = {},
) {
	const rows: SearchTierOutcome[] = []
	const recalled = await recallSessionTurns({
		db,
		prefix: "mem_",
		query: "when does the greenhouse lease renew",
		questionDate,
		namespace,
		results,
		numCandidates: 100,
		capabilities,
		embeddingMode: "automated",
		queryEmbeddingModel: "voyage-4-large",
		onTierOutcome: (row) => rows.push(row),
		...overrides,
	})
	return {
		merged: insertRecalledTurns(overrides.results ?? results, recalled),
		recalled,
		rows,
	}
}

const vectorFilterOf = (pipeline: Document[]) =>
	pipeline[0].$rankFusion.input.pipelines.vector[0].$vectorSearch.filter
const searchFilterOf = (pipeline: Document[]) =>
	pipeline[0].$rankFusion.input.pipelines.text[0].$search.compound.filter

beforeEach(() => {
	resetSearchAdmissionForTests(Date.now())
})

describe("session turn recall", () => {
	it("recalls an aside turn that shares no query word once its session seeds", async () => {
		const aside = event(
			"s1-t2",
			"s-oak",
			"by any chance my sister arrives in june and loves tomatoes",
		)
		const { db } = fakeEventsDb(
			[
				event("s1-t1", "s-oak", "the greenhouse lease renew date is in may"),
				aside,
				event("s2-t1", "s-elm", "compost bins arrived"),
			],
			{ similarity: { "s1-t2": 0.9 } },
		)
		const { merged } = await recall(db, [
			stage1("s1-t1", "s-oak", 0.9),
			stage1("s2-t1", "s-elm", 0.5),
		])
		expect(ids(merged)).toEqual(["event:s1-t1", "event:s1-t2", "event:s2-t1"])
		expect(merged[1]?.provenance).toMatchObject({
			lane: "session-turn-recall",
			seedRank: 1,
			inSessionRank: 2,
		})
	})

	it("never recalls the same session id under another agent or scope", async () => {
		const { db } = fakeEventsDb(
			[
				event("s1-t1", "s-oak", "the greenhouse lease renew date"),
				event("x-t1", "s-oak", "the greenhouse lease renew secret", {
					agentId: "agent-other",
				}),
				event("x-t2", "s-oak", "the greenhouse lease renew private", {
					scope: "session",
				}),
				event("x-t3", "s-oak", "the greenhouse lease renew hidden", {
					scopeRef: "agent:other",
				}),
			],
			{ similarity: { "x-t1": 1, "x-t2": 1, "x-t3": 1 } },
		)
		const { merged } = await recall(db, [stage1("s0-t0", "s-oak", 0.9)])
		expect(ids(merged)).toEqual(["event:s0-t0", "event:s1-t1"])
	})

	it("sends the namespace and the seed sessions on both inputs", async () => {
		const { db, pipelines } = fakeEventsDb([])
		await recall(db, [stage1("a", "s-oak", 0.9), stage1("b", "s-elm", 0.8)])
		expect(pipelines).toHaveLength(1)
		expect(vectorFilterOf(pipelines[0])).toEqual({
			agentId: "agent-wren",
			scope: "agent",
			scopeRef: "agent:wren",
			sessionId: { $in: ["s-oak", "s-elm"] },
			timestamp: { $lte: questionDate },
		})
		expect(searchFilterOf(pipelines[0])).toEqual([
			{ equals: { path: "agentId", value: "agent-wren" } },
			{ equals: { path: "scope", value: "agent" } },
			{ equals: { path: "scopeRef", value: "agent:wren" } },
			{ in: { path: "sessionId", value: ["s-oak", "s-elm"] } },
			{ range: { path: "timestamp", lte: questionDate } },
		])
		const text = pipelines[0][0].$rankFusion.input.pipelines.text
		expect(text[1]).toEqual({ $match: vectorFilterOf(pipelines[0]) })
		const vector = pipelines[0][0].$rankFusion.input.pipelines.vector
		expect(vector[1]).toEqual({ $match: vectorFilterOf(pipelines[0]) })
	})

	it("runs nothing and says so when no stage-1 result names a session", async () => {
		const { db, pipelines } = fakeEventsDb([])
		const results = [stage1("a", undefined, 0.9), stage1("b", " ", 0.8)]
		const { merged, rows } = await recall(db, results)
		expect(pipelines).toHaveLength(0)
		expect(merged).toEqual(results)
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "no-candidates" },
		])
	})

	it("seeds one session from one result", async () => {
		const { db, pipelines } = fakeEventsDb([])
		await recall(db, [stage1("a", "s-oak", 0.9), stage1("b", "s-oak", 0.8)])
		expect(vectorFilterOf(pipelines[0]).sessionId).toEqual({ $in: ["s-oak"] })
	})

	it("seeds at most S sessions, in stage-1 rank order, from the first R results", async () => {
		const { db, pipelines } = fakeEventsDb([])
		const sessions = Array.from(
			{ length: SESSION_TURN_RECALL_SEED_SESSIONS + 1 },
			(_, index) => `s-${index}`,
		)
		const results = [
			...sessions.map((sessionId, index) =>
				stage1(`r${index}`, sessionId, 1 - index * 0.01),
			),
			...Array.from({ length: 11 }, (_, index) =>
				stage1(`pad${index}`, undefined, 0.5),
			),
			stage1("late", "s-late", 0.1),
		]
		await recall(db, results)
		expect(vectorFilterOf(pipelines[0]).sessionId).toEqual({
			$in: sessions.slice(0, SESSION_TURN_RECALL_SEED_SESSIONS),
		})
	})

	it("ignores sessions first named past the first R results", async () => {
		const { db, pipelines } = fakeEventsDb([])
		const results = [
			stage1("r0", "s-oak", 1),
			...Array.from({ length: 19 }, (_, index) =>
				stage1(`pad${index}`, "s-oak", 0.9),
			),
			stage1("late", "s-late", 0.1),
		]
		await recall(db, results)
		expect(vectorFilterOf(pipelines[0]).sessionId).toEqual({ $in: ["s-oak"] })
	})

	it("inserts each session's turns right after its best stage-1 result, in in-session order", async () => {
		const { db } = fakeEventsDb(
			[
				event("o-t1", "s-oak", "greenhouse lease"),
				event("o-t2", "s-oak", "renew the greenhouse lease soon"),
				event("e-t1", "s-elm", "greenhouse"),
				event("e-t2", "s-elm", "lease renew greenhouse when"),
			],
			{ similarity: { "o-t2": 0.9, "e-t2": 0.9 } },
		)
		const { merged } = await recall(db, [
			stage1("x1", "s-ash", 0.95),
			stage1("x2", "s-elm", 0.9),
			stage1("x3", "s-oak", 0.8),
			stage1("x4", "s-elm", 0.7),
		])
		expect(ids(merged)).toEqual([
			"event:x1",
			"event:x2",
			"event:e-t2",
			"event:e-t1",
			"event:x3",
			"event:o-t2",
			"event:o-t1",
			"event:x4",
		])
		expect(
			merged
				.filter((r) => r.provenance?.lane === "session-turn-recall")
				.map((r) => [r.provenance?.seedRank, r.provenance?.inSessionRank]),
		).toEqual([
			[2, 1],
			[2, 2],
			[3, 1],
			[3, 2],
		])
	})

	it("keeps at most T turns per session", async () => {
		const { db } = fakeEventsDb([
			event("o-t1", "s-oak", "greenhouse lease"),
			event("o-t2", "s-oak", "greenhouse lease renew"),
			event("o-t3", "s-oak", "greenhouse"),
			event("o-t4", "s-oak", "lease"),
		])
		const { merged } = await recall(db, [stage1("x1", "s-oak", 0.9)])
		expect(merged).toHaveLength(4)
	})

	it("removes duplicates by canonical id, then by text", async () => {
		const { db } = fakeEventsDb([
			event("o-t1", "s-oak", "greenhouse lease renew"),
			event("o-t2", "s-oak", "the greenhouse lease"),
			event("o-t3", "s-oak", "the greenhouse lease"),
			event("e-t1", "s-elm", "lease renew chunk text"),
		])
		const { merged } = await recall(db, [
			stage1("o-t1", "s-oak", 0.9, "greenhouse lease renew"),
			{
				...stage1("chunk-9", "s-elm", 0.8, "lease renew chunk text"),
				canonicalId: "session-chunk/9",
			},
		])
		expect(ids(merged)).toEqual(["event:o-t1", "event:o-t2", "session-chunk/9"])
	})

	it("breaks equal fused scores by time, then id, whatever order the server returns", async () => {
		const corpus = [
			event("o-t2", "s-oak", "greenhouse alpha", {
				timestamp: new Date("2026-04-02T00:00:00Z"),
			}),
			event("o-t1", "s-oak", "greenhouse beta", {
				timestamp: new Date("2026-04-02T00:00:00Z"),
			}),
			event("o-t0", "s-oak", "greenhouse gamma", {
				timestamp: new Date("2026-04-03T00:00:00Z"),
			}),
		]
		// Vector ranks o-t2, o-t1, o-t0 and text ranks o-t0, o-t1, o-t2, so
		// o-t0 and o-t2 fuse to the same score; the earlier turn goes first.
		const similarity = { "o-t2": 0.9, "o-t1": 0.5 }
		const forward = fakeEventsDb(corpus, { similarity })
		const reverse = fakeEventsDb(corpus, { similarity, reverseTies: true })
		const base = [stage1("x1", "s-oak", 0.9)]
		const a = await recall(forward.db, base)
		const b = await recall(reverse.db, base)
		expect(ids(a.merged)).toEqual([
			"event:x1",
			"event:o-t2",
			"event:o-t0",
			"event:o-t1",
		])
		expect(ids(b.merged)).toEqual(ids(a.merged))
	})

	it("reports a missing vector input explicitly and runs nothing", async () => {
		const { db, pipelines } = fakeEventsDb([])
		const results = [stage1("x1", "s-oak", 0.9)]
		const { merged, rows } = await recall(db, results, {
			capabilities: { ...capabilities, vectorSearch: false },
		})
		expect(pipelines).toHaveLength(0)
		expect(merged).toEqual(results)
		expect(rows).toEqual([
			{
				stage: "turn-vector",
				outcome: "not-applicable",
				reason: "capability-absent",
			},
		])
	})

	it("reports a missing text input explicitly and runs nothing", async () => {
		const { db, pipelines } = fakeEventsDb([])
		const results = [stage1("x1", "s-oak", 0.9)]
		const { merged, rows } = await recall(db, results, {
			capabilities: { ...capabilities, textSearch: false },
		})
		expect(pipelines).toHaveLength(0)
		expect(merged).toEqual(results)
		expect(rows).toEqual([
			{
				stage: "turn-text",
				outcome: "not-applicable",
				reason: "capability-absent",
			},
		])
	})

	it("refuses a blank namespace field instead of dropping it from the filter", async () => {
		const { db, pipelines } = fakeEventsDb([])
		const failure = await recall(db, [stage1("x1", "s-oak", 0.9)], {
			namespace: { ...namespace, scopeRef: " " },
		}).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({ stage: "filter", reason: "query-error" })
		expect(pipelines).toHaveLength(0)
	})
})
