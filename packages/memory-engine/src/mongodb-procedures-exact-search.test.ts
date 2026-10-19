// T7 (#116): procedure exact match runs `$search` `equals` on token fields
// with the lowercase normalizer. No `$regex` find survives. The Search stage
// is only a candidate source: scope, state and validity are re-checked on the
// hydrated document after it.
import type { Document } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { findExactProcedureMatches } from "./mongodb-procedures.js"
import { SearchLaneError, type SearchTierOutcome } from "./search-outcomes.js"
import {
	type SearchStageFakeEntry,
	createSearchStageFake,
	manifestDefinition,
} from "./test-helpers/search-stage-fake.js"

const PREFIX = "t7_"
const INDEX = `${PREFIX}procedures_text`
const NOW = new Date("2026-10-02T12:00:00Z")

function procedure(overrides: Document): Document {
	return {
		procedureId: "proc",
		name: "Deploy Blue-Green",
		triggerQueries: [],
		searchText: "deploy blue green",
		agentId: "owner",
		scope: "agent",
		scopeRef: "agent:owner",
		state: "active",
		updatedAt: new Date("2026-10-01T00:00:00Z"),
		validFrom: new Date("2026-09-01T00:00:00Z"),
		...overrides,
	}
}

function fake(entries: SearchStageFakeEntry[], failure?: Error) {
	return createSearchStageFake({
		indexName: INDEX,
		definition: manifestDefinition(PREFIX, INDEX),
		entries,
		failure,
	})
}

const lane = {
	maxResults: 5,
	textIndexName: INDEX,
	filter: {
		agentId: "owner",
		scope: "agent" as const,
		scopeRef: "agent:owner",
		state: "active" as const,
		currentOnly: true,
		asOf: NOW,
	},
}

async function ids(
	entries: SearchStageFakeEntry[],
	query: string,
	options: Partial<typeof lane> = {},
): Promise<string[]> {
	const { collection } = fake(entries)
	const hits = await findExactProcedureMatches(collection, query, {
		...lane,
		...options,
	})
	return hits.map((hit) => hit.path)
}

afterEach(() => vi.unstubAllEnvs())

describe("findExactProcedureMatches on $search equals", () => {
	it("emits one $search with equals on name and triggerQueries and no content find", async () => {
		const stage = fake([{ indexed: procedure({ procedureId: "a" }) }])
		await findExactProcedureMatches(stage.collection, "Deploy Blue-Green", lane)

		expect(stage.findCalls).toEqual([])
		expect(stage.pipelines).toHaveLength(1)
		const search = stage.pipelines[0][0].$search as Document
		expect(search.index).toBe(INDEX)
		expect(search.compound.should).toEqual([
			{ equals: { path: "name", value: "Deploy Blue-Green" } },
			{ equals: { path: "triggerQueries", value: "Deploy Blue-Green" } },
		])
		expect(search.compound.minimumShouldMatch).toBe(1)
		expect(search.compound.filter).toEqual(
			expect.arrayContaining([
				{ equals: { path: "agentId", value: "owner" } },
				{ equals: { path: "scope", value: "agent" } },
				{ equals: { path: "scopeRef", value: "agent:owner" } },
				{ equals: { path: "state", value: "active" } },
			]),
		)
		expect(JSON.stringify(stage.pipelines)).not.toContain("$regex")
	})

	it("matches the full name regardless of case", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "a", name: "Deploy Blue-Green" }) },
		]
		expect(await ids(entries, "deploy BLUE-green")).toEqual(["procedure:a"])
	})

	it("matches a trigger query alias exactly", async () => {
		const entries = [
			{
				indexed: procedure({
					procedureId: "a",
					name: "Release train",
					triggerQueries: ["Ship It", "cut a release"],
				}),
			},
		]
		expect(await ids(entries, "ship it")).toEqual(["procedure:a"])
		expect(await ids(entries, "cut a release")).toEqual(["procedure:a"])
	})

	it("does not return near-matches: a prefix, a superset or a mid-word substring", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "prefix", name: "Deploy Blue" }) },
			{
				indexed: procedure({
					procedureId: "superset",
					name: "Deploy Blue-Green Rollback",
				}),
			},
			{ indexed: procedure({ procedureId: "inner", name: "Redeploy Blue-Green" }) },
			{ indexed: procedure({ procedureId: "exact", name: "Deploy Blue-Green" }) },
		]
		expect(await ids(entries, "Deploy Blue-Green")).toEqual(["procedure:exact"])
	})

	it("keeps punctuation significant", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "paren", name: "Deploy (Blue)" }) },
			{ indexed: procedure({ procedureId: "plain", name: "Deploy Blue" }) },
			{ indexed: procedure({ procedureId: "dash", name: "Deploy-Blue" }) },
		]
		expect(await ids(entries, "deploy (blue)")).toEqual(["procedure:paren"])
		expect(await ids(entries, "Deploy-Blue")).toEqual(["procedure:dash"])
	})

	it("treats regex metacharacters in the query as plain text", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "dot", name: "v1.2" }) },
			{ indexed: procedure({ procedureId: "any", name: "v1x2" }) },
			{ indexed: procedure({ procedureId: "all", name: "Deploy .*" }) },
		]
		expect(await ids(entries, "v1.2")).toEqual(["procedure:dot"])
		expect(await ids(entries, ".*")).toEqual([])
	})

	it("matches numbers as whole values", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "two", name: "Step 2" }) },
			{ indexed: procedure({ procedureId: "twenty", name: "Step 20" }) },
			{ indexed: procedure({ procedureId: "dated", name: "Rollout 2026-10" }) },
		]
		expect(await ids(entries, "step 2")).toEqual(["procedure:two"])
		expect(await ids(entries, "Rollout 2026-10")).toEqual(["procedure:dated"])
		expect(await ids(entries, "Rollout 2026")).toEqual([])
	})

	it("does not match a name that merely contains the query as a negated phrase", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "neg", name: "Do not deploy" }) },
			{ indexed: procedure({ procedureId: "pos", name: "Deploy" }) },
		]
		expect(await ids(entries, "deploy")).toEqual(["procedure:pos"])
	})

	it("never returns another scope, owner or state", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "mine" }) },
			{ indexed: procedure({ procedureId: "other-owner", agentId: "stranger" }) },
			{
				indexed: procedure({
					procedureId: "other-ref",
					scopeRef: "agent:stranger",
				}),
			},
			{ indexed: procedure({ procedureId: "other-scope", scope: "workspace" }) },
			{ indexed: procedure({ procedureId: "retired", state: "invalidated" }) },
		]
		expect(await ids(entries, "Deploy Blue-Green")).toEqual(["procedure:mine"])
	})

	it("drops a candidate whose scope or state changed after it was indexed", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "kept" }) },
			{
				indexed: procedure({ procedureId: "moved" }),
				current: procedure({ procedureId: "moved", scopeRef: "agent:stranger" }),
			},
			{
				indexed: procedure({ procedureId: "retired" }),
				current: procedure({ procedureId: "retired", state: "invalidated" }),
			},
		]
		expect(await ids(entries, "Deploy Blue-Green")).toEqual(["procedure:kept"])
	})

	it("drops a candidate whose validity window closed after it was indexed", async () => {
		const entries = [
			{ indexed: procedure({ procedureId: "kept" }) },
			{
				indexed: procedure({ procedureId: "closed" }),
				current: procedure({
					procedureId: "closed",
					validTo: new Date("2026-10-01T00:00:00Z"),
				}),
			},
			{
				indexed: procedure({ procedureId: "future" }),
				current: procedure({
					procedureId: "future",
					validFrom: new Date("2026-11-01T00:00:00Z"),
				}),
			},
			{ indexed: procedure({ procedureId: "deleted" }), current: null },
		]
		expect(await ids(entries, "Deploy Blue-Green")).toEqual(["procedure:kept"])
	})

	it("honors intentTags and orders by recency within maxResults", async () => {
		const entries = [
			{
				indexed: procedure({
					procedureId: "old",
					intentTags: ["ops"],
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				}),
			},
			{
				indexed: procedure({
					procedureId: "new",
					intentTags: ["ops"],
					updatedAt: new Date("2026-09-01T00:00:00Z"),
				}),
			},
			{ indexed: procedure({ procedureId: "untagged", intentTags: ["docs"] }) },
		]
		const filter = { ...lane.filter, intentTags: ["ops"] }
		expect(await ids(entries, "Deploy Blue-Green", { filter })).toEqual([
			"procedure:new",
			"procedure:old",
		])
		expect(
			await ids(entries, "Deploy Blue-Green", { filter, maxResults: 1 }),
		).toEqual(["procedure:new"])
	})

	it("scores every exact match 1 and keeps the result shape", async () => {
		const { collection } = fake([{ indexed: procedure({ procedureId: "a" }) }])
		const [hit] = await findExactProcedureMatches(
			collection,
			"Deploy Blue-Green",
			lane,
		)
		expect(hit).toMatchObject({
			path: "procedure:a",
			score: 1,
			source: "structured",
			derivation: "derived",
			state: "active",
			scope: "agent",
			scopeRef: "agent:owner",
		})
	})

	it.each([
		undefined,
		"1250",
		"not-a-number",
	])("applies the existing processing limit for setting %s", async (setting) => {
		vi.stubEnv("MEMONGO_SEARCH_MAX_TIME_MS", setting)
		const stage = fake([])
		await findExactProcedureMatches(stage.collection, "deploy", lane)
		expect(stage.options).toEqual([
			{ maxTimeMS: setting === "1250" ? 1250 : 10000 },
		])
	})

	it("keeps empty queries free of database calls and reports them", async () => {
		const stage = fake([])
		const rows: SearchTierOutcome[] = []
		const hits = await findExactProcedureMatches(stage.collection, "   ", {
			...lane,
			onTierOutcome: (row) => rows.push(row),
		})
		expect(hits).toEqual([])
		expect(stage.pipelines).toEqual([])
		expect(stage.findCalls).toEqual([])
		expect(rows).toEqual([
			{
				stage: "exact-match",
				outcome: "not-applicable",
				reason: "empty-query",
			},
		])
	})

	it("types a Search failure and never retries it as a find", async () => {
		const stage = fake([], new Error("mongot unavailable"))
		const failure = await findExactProcedureMatches(
			stage.collection,
			"deploy",
			lane,
		).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({ stage: "exact-match" })
		expect((failure as Error).message).not.toContain("mongot unavailable")
		expect(stage.findCalls).toEqual([])
		expect(stage.pipelines).toHaveLength(1)
	})

	it("returns an honest empty list for a healthy zero-hit result", async () => {
		const stage = fake([{ indexed: procedure({ procedureId: "a" }) }])
		expect(
			await findExactProcedureMatches(stage.collection, "unknown name", lane),
		).toEqual([])
		expect(stage.pipelines).toHaveLength(1)
		expect(stage.findCalls).toEqual([])
	})
})
