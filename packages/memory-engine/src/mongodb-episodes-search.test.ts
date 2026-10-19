// T7 (#116): episode search is one `$search` `text` query over title and
// summary. There is no regex tier and no capability flag that chooses a tier.
// The Search stage only selects candidates; owner, scope, status and the time
// window are checked again on the hydrated document before the limit.
import type { Db, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import { searchEpisodes } from "./mongodb-episodes.js"
import { SearchLaneError, type SearchTierOutcome } from "./search-outcomes.js"
import {
	type SearchStageFakeEntry,
	createSearchStageFake,
	manifestDefinition,
} from "./test-helpers/search-stage-fake.js"

const PREFIX = "t7_"
const INDEX = "episode_autocomplete"

function episode(overrides: Document): Document {
	return {
		episodeId: "ep",
		type: "daily",
		title: "Daily Standup Notes",
		summary: "The team reviewed the sprint board and blocked tickets.",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		status: "active",
		timeRange: {
			start: new Date("2026-10-01T09:00:00Z"),
			end: new Date("2026-10-01T10:00:00Z"),
		},
		updatedAt: new Date("2026-10-01T10:00:00Z"),
		...overrides,
	}
}

function stage(entries: SearchStageFakeEntry[], failure?: Error) {
	const fake = createSearchStageFake({
		indexName: INDEX,
		definition: manifestDefinition(PREFIX, INDEX),
		entries,
		failure,
	})
	const db = {
		collection: (name: string) => {
			if (name !== `${PREFIX}episodes`) throw new Error(`unexpected ${name}`)
			return fake.collection
		},
	} as unknown as Db
	return { ...fake, db }
}

const tenant = {
	agentId: "agent-1",
	scope: "agent" as const,
	scopeRef: "agent:agent-1",
}

async function ids(
	entries: SearchStageFakeEntry[],
	query: string,
	extra: Partial<Parameters<typeof searchEpisodes>[0]> = {},
) {
	const { db } = stage(entries)
	const hits = await searchEpisodes({
		db,
		prefix: PREFIX,
		query,
		...tenant,
		...extra,
	})
	return hits.map((hit) => hit.episodeId)
}

describe("searchEpisodes on $search text", () => {
	it("emits one $search text query over title and summary and never a find", async () => {
		const fake = stage([{ indexed: episode({ episodeId: "a" }) }])
		await searchEpisodes({
			db: fake.db,
			prefix: PREFIX,
			query: "standup",
			...tenant,
		})
		expect(fake.findCalls).toEqual([])
		expect(fake.pipelines).toHaveLength(1)
		const search = fake.pipelines[0][0].$search as Document
		expect(search.index).toBe(INDEX)
		expect(search.compound.must).toEqual([
			{ text: { query: "standup", path: ["title", "summary"] } },
		])
		expect(search.compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
			{ equals: { path: "scope", value: "agent" } },
			{ equals: { path: "scopeRef", value: "agent:agent-1" } },
		])
		const serialized = JSON.stringify(fake.pipelines)
		expect(serialized).not.toContain("$regex")
		expect(JSON.stringify(search.compound)).not.toContain("autocomplete")
		expect(fake.options[0]).toEqual({ maxTimeMS: expect.any(Number) })
	})

	it("matches analyzed terms in the title or the summary, in any case", async () => {
		const entries = [
			{ indexed: episode({ episodeId: "title" }) },
			{
				indexed: episode({
					episodeId: "summary",
					title: "Weekly sync",
					summary: "Discussed the DEPLOYMENT checklist.",
				}),
			},
			{
				indexed: episode({
					episodeId: "other",
					title: "Lunch",
					summary: "Pizza.",
				}),
			},
		]
		expect(await ids(entries, "STANDUP")).toEqual(["title"])
		expect(await ids(entries, "deployment")).toEqual(["summary"])
		expect(await ids(entries, "sprint deployment")).toEqual([
			"title",
			"summary",
		])
	})

	it("matches whole terms: a substring or a near-spelling is not a hit", async () => {
		const entries = [{ indexed: episode({ episodeId: "a" }) }]
		expect(await ids(entries, "stand")).toEqual([])
		expect(await ids(entries, "standups")).toEqual([])
		expect(await ids(entries, "stand-up")).toEqual([])
		expect(await ids(entries, "notes")).toEqual(["a"])
	})

	it("treats punctuation as separators and regex metacharacters as plain text", async () => {
		const entries = [
			{
				indexed: episode({
					episodeId: "a",
					title: "Release v2.1 (blue)",
					summary: "Shipped C++ bindings.",
				}),
			},
			{ indexed: episode({ episodeId: "b" }) },
		]
		expect(await ids(entries, "(blue)")).toEqual(["a"])
		expect(await ids(entries, "c++")).toEqual(["a"])
		expect(await ids(entries, ".*")).toEqual([])
		expect(await ids(entries, "a+b")).toEqual([])
	})

	it("matches numbers as terms", async () => {
		const entries = [
			{
				indexed: episode({
					episodeId: "a",
					title: "Sprint 42 review",
					summary: "Velocity was 38 points.",
				}),
			},
		]
		expect(await ids(entries, "42")).toEqual(["a"])
		expect(await ids(entries, "4")).toEqual([])
		expect(await ids(entries, "38")).toEqual(["a"])
	})

	it("does not interpret negation: a negated mention still matches its term", async () => {
		const entries = [
			{
				indexed: episode({
					episodeId: "a",
					title: "No standup today",
					summary: "The standup was cancelled.",
				}),
			},
		]
		expect(await ids(entries, "-standup")).toEqual(["a"])
		expect(await ids(entries, "not standup")).toEqual(["a"])
	})

	it("returns only the caller's tenant and ignores deleted episodes", async () => {
		const entries = [
			{ indexed: episode({ episodeId: "mine" }) },
			{ indexed: episode({ episodeId: "other-agent", agentId: "agent-2" }) },
			{ indexed: episode({ episodeId: "other-scope", scope: "workspace" }) },
			{
				indexed: episode({ episodeId: "other-ref", scopeRef: "agent:agent-2" }),
			},
			{ indexed: episode({ episodeId: "gone", status: "deleted" }) },
		]
		expect(await ids(entries, "standup")).toEqual(["mine"])
	})

	it("drops a candidate deleted, archived-as-deleted or re-scoped after it was indexed", async () => {
		const entries = [
			{ indexed: episode({ episodeId: "kept" }) },
			{
				indexed: episode({ episodeId: "deleted-later" }),
				current: episode({ episodeId: "deleted-later", status: "deleted" }),
			},
			{
				indexed: episode({ episodeId: "moved" }),
				current: episode({ episodeId: "moved", scopeRef: "agent:agent-2" }),
			},
			{ indexed: episode({ episodeId: "removed" }), current: null },
		]
		expect(await ids(entries, "standup")).toEqual(["kept"])
	})

	it("keeps only episodes that overlap the requested time range", async () => {
		const entries = [
			{ indexed: episode({ episodeId: "inside" }) },
			{
				indexed: episode({
					episodeId: "before",
					timeRange: {
						start: new Date("2026-09-01T09:00:00Z"),
						end: new Date("2026-09-01T10:00:00Z"),
					},
				}),
			},
			{
				indexed: episode({ episodeId: "moved-out" }),
				current: episode({
					episodeId: "moved-out",
					timeRange: {
						start: new Date("2026-08-01T09:00:00Z"),
						end: new Date("2026-08-01T10:00:00Z"),
					},
				}),
			},
		]
		const timeRange = {
			start: new Date("2026-10-01T00:00:00Z"),
			end: new Date("2026-10-02T00:00:00Z"),
		}
		expect(await ids(entries, "standup", { timeRange })).toEqual(["inside"])
	})

	it("limits after revalidation and defaults the limit to 50", async () => {
		const entries = Array.from({ length: 60 }, (_, index) => ({
			indexed: episode({ episodeId: `e${index}` }),
		}))
		expect(await ids(entries, "standup")).toHaveLength(50)
		expect(await ids(entries, "standup", { limit: 3 })).toEqual([
			"e0",
			"e1",
			"e2",
		])
	})

	it("reports a blank query as not applicable without calling the database", async () => {
		const fake = stage([{ indexed: episode({ episodeId: "a" }) }])
		const rows: SearchTierOutcome[] = []
		expect(
			await searchEpisodes({
				db: fake.db,
				prefix: PREFIX,
				query: "   ",
				...tenant,
				onTierOutcome: (row) => rows.push(row),
			}),
		).toEqual([])
		expect(fake.pipelines).toEqual([])
		expect(rows).toEqual([
			{
				stage: "episode-search",
				outcome: "not-applicable",
				reason: "empty-query",
			},
		])
	})

	it("reports ok for hits and ok-empty for a healthy zero-hit result", async () => {
		const rows: SearchTierOutcome[] = []
		const fake = stage([{ indexed: episode({ episodeId: "a" }) }])
		await searchEpisodes({
			db: fake.db,
			prefix: PREFIX,
			query: "standup",
			...tenant,
			onTierOutcome: (row) => rows.push(row),
		})
		await searchEpisodes({
			db: fake.db,
			prefix: PREFIX,
			query: "nothing here",
			...tenant,
			onTierOutcome: (row) => rows.push(row),
		})
		expect(rows).toEqual([
			{ stage: "atlas-search", outcome: "ok", resultCount: 1 },
			{
				stage: "atlas-search",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
		expect(fake.pipelines).toHaveLength(2)
		expect(fake.findCalls).toEqual([])
	})

	it("types a Search failure, reports no row and never falls back to a find", async () => {
		const fake = stage([], new Error("mongot unavailable"))
		const rows: SearchTierOutcome[] = []
		const failure = await searchEpisodes({
			db: fake.db,
			prefix: PREFIX,
			query: "standup",
			...tenant,
			onTierOutcome: (row) => rows.push(row),
		}).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({ stage: "atlas-search" })
		expect((failure as Error).message).not.toContain("mongot unavailable")
		expect(rows).toEqual([])
		expect(fake.pipelines).toHaveLength(1)
		expect(fake.findCalls).toEqual([])
	})

	it("ignores a capability flag passed by an older caller instead of switching lookups", async () => {
		const fake = stage([{ indexed: episode({ episodeId: "a" }) }])
		await searchEpisodes({
			db: fake.db,
			prefix: PREFIX,
			query: "standup",
			...tenant,
			...({ textSearchAvailable: false } as object),
		})
		expect(fake.pipelines).toHaveLength(1)
		expect(fake.findCalls).toEqual([])
	})
})
