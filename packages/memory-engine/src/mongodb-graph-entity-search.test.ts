// T7 (#116): entity lookups run on Search only. Exact names use `equals` on
// token fields with the lowercase normalizer; prefix lookup uses
// `autocomplete`. There is no regex tier and no capability gate that picks
// one: a Search failure is a typed failure, not a different lookup.
import type { Db, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	findEntitiesByName,
	searchEntitiesAutocomplete,
} from "./mongodb-graph.js"
import { SearchLaneError } from "./search-outcomes.js"
import {
	type SearchStageFakeEntry,
	createSearchStageFake,
	manifestDefinition,
} from "./test-helpers/search-stage-fake.js"

const PREFIX = "t7_"
const INDEX = "entity_autocomplete"

function entity(overrides: Document): Document {
	return {
		entityId: "ent",
		name: "Alice",
		type: "person",
		aliases: [],
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		updatedAt: new Date("2026-10-01T00:00:00Z"),
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
			if (name !== `${PREFIX}entities`) throw new Error(`unexpected ${name}`)
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

async function exact(
	entries: SearchStageFakeEntry[],
	query: string,
	extra: Partial<Parameters<typeof findEntitiesByName>[0]> = {},
) {
	const { db } = stage(entries)
	const hits = await findEntitiesByName({
		db,
		prefix: PREFIX,
		query,
		...tenant,
		...extra,
	})
	return hits.map((hit) => hit.entityId)
}

async function prefixLookup(entries: SearchStageFakeEntry[], query: string) {
	const { db } = stage(entries)
	const hits = await searchEntitiesAutocomplete({
		db,
		prefix: PREFIX,
		query,
		...tenant,
	})
	return hits.map((hit) => hit.entityId)
}

describe("findEntitiesByName on $search equals", () => {
	it("emits one $search with equals on name and aliases and no content find", async () => {
		const fake = stage([{ indexed: entity({ entityId: "a" }) }])
		await findEntitiesByName({
			db: fake.db,
			prefix: PREFIX,
			query: "Alice",
			...tenant,
		})
		expect(fake.findCalls).toEqual([])
		expect(fake.pipelines).toHaveLength(1)
		const search = fake.pipelines[0][0].$search as Document
		expect(search.index).toBe(INDEX)
		expect(search.compound.should).toEqual([
			{ equals: { path: "name", value: "Alice" } },
			{ equals: { path: "aliases", value: "Alice" } },
		])
		expect(search.compound.minimumShouldMatch).toBe(1)
		expect(search.compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
			{ equals: { path: "scope", value: "agent" } },
			{ equals: { path: "scopeRef", value: "agent:agent-1" } },
		])
		expect(JSON.stringify(fake.pipelines)).not.toContain("$regex")
		expect(fake.options[0]).toEqual({ maxTimeMS: expect.any(Number) })
	})

	it("matches the whole name or an alias regardless of case", async () => {
		const entries = [
			{
				indexed: entity({
					entityId: "nyc",
					name: "New York City",
					aliases: ["NYC", "The Big Apple"],
				}),
			},
		]
		expect(await exact(entries, "new york city")).toEqual(["nyc"])
		expect(await exact(entries, "nyc")).toEqual(["nyc"])
		expect(await exact(entries, "THE BIG APPLE")).toEqual(["nyc"])
	})

	it("no longer matches a mid-word or partial substring", async () => {
		const entries = [
			{ indexed: entity({ entityId: "alice", name: "Alice" }) },
			{ indexed: entity({ entityId: "ali", name: "Ali" }) },
		]
		expect(await exact(entries, "Ali")).toEqual(["ali"])
		expect(await exact(entries, "lic")).toEqual([])
		expect(await exact(entries, "Alic")).toEqual([])
	})

	it("does not return near-matches, numbers or negations as the same entity", async () => {
		const entries = [
			{ indexed: entity({ entityId: "p2", name: "Project 2" }) },
			{ indexed: entity({ entityId: "p20", name: "Project 20" }) },
			{ indexed: entity({ entityId: "not", name: "Not Alice" }) },
			{ indexed: entity({ entityId: "alice", name: "Alice" }) },
			{ indexed: entity({ entityId: "alice-b", name: "Alice B." }) },
		]
		expect(await exact(entries, "project 2")).toEqual(["p2"])
		expect(await exact(entries, "Alice")).toEqual(["alice"])
	})

	it("keeps punctuation significant and never reads the query as a pattern", async () => {
		const entries = [
			{ indexed: entity({ entityId: "cpp", name: "C++" }) },
			{ indexed: entity({ entityId: "c", name: "C" }) },
			{ indexed: entity({ entityId: "dot", name: "v1.2" }) },
			{ indexed: entity({ entityId: "any", name: "v1x2" }) },
		]
		expect(await exact(entries, "c++")).toEqual(["cpp"])
		expect(await exact(entries, "v1.2")).toEqual(["dot"])
		expect(await exact(entries, ".*")).toEqual([])
	})

	it("trims the query and returns nothing, without a call, for a blank one", async () => {
		const entries = [{ indexed: entity({ entityId: "alice" }) }]
		expect(await exact(entries, "  Alice  ")).toEqual(["alice"])
		const fake = stage(entries)
		expect(
			await findEntitiesByName({
				db: fake.db,
				prefix: PREFIX,
				query: "   ",
				...tenant,
			}),
		).toEqual([])
		expect(fake.pipelines).toEqual([])
	})

	it("returns only the caller's tenant", async () => {
		const entries = [
			{ indexed: entity({ entityId: "mine" }) },
			{ indexed: entity({ entityId: "other-agent", agentId: "agent-2" }) },
			{ indexed: entity({ entityId: "other-scope", scope: "workspace" }) },
			{ indexed: entity({ entityId: "other-ref", scopeRef: "agent:agent-2" }) },
		]
		expect(await exact(entries, "Alice")).toEqual(["mine"])
	})

	it("drops a candidate re-scoped or deleted after it was indexed", async () => {
		const entries = [
			{ indexed: entity({ entityId: "kept" }) },
			{
				indexed: entity({ entityId: "moved" }),
				current: entity({ entityId: "moved", scopeRef: "agent:agent-2" }),
			},
			{
				indexed: entity({ entityId: "reowned" }),
				current: entity({ entityId: "reowned", agentId: "agent-2" }),
			},
			{ indexed: entity({ entityId: "deleted" }), current: null },
		]
		expect(await exact(entries, "Alice")).toEqual(["kept"])
	})

	it("orders by recency and applies the limit after revalidation", async () => {
		const entries = [
			{
				indexed: entity({
					entityId: "stale-newest",
					updatedAt: new Date("2026-12-01T00:00:00Z"),
				}),
				current: entity({
					entityId: "stale-newest",
					agentId: "agent-2",
					updatedAt: new Date("2026-12-01T00:00:00Z"),
				}),
			},
			{
				indexed: entity({
					entityId: "old",
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				}),
			},
			{
				indexed: entity({
					entityId: "new",
					updatedAt: new Date("2026-09-01T00:00:00Z"),
				}),
			},
		]
		expect(await exact(entries, "Alice")).toEqual(["new", "old"])
		expect(await exact(entries, "Alice", { limit: 1 })).toEqual(["new"])
	})

	it("types a Search failure and never runs a second lookup", async () => {
		const fake = stage([], new Error("mongot unavailable"))
		const failure = await findEntitiesByName({
			db: fake.db,
			prefix: PREFIX,
			query: "Alice",
			...tenant,
		}).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({ stage: "entity-lookup" })
		expect((failure as Error).message).not.toContain("mongot unavailable")
		expect(fake.pipelines).toHaveLength(1)
		expect(fake.findCalls).toEqual([])
	})

	it("returns an honest empty list for a healthy zero-hit result", async () => {
		const fake = stage([{ indexed: entity({ entityId: "alice" }) }])
		expect(
			await findEntitiesByName({
				db: fake.db,
				prefix: PREFIX,
				query: "Nobody",
				...tenant,
			}),
		).toEqual([])
		expect(fake.pipelines).toHaveLength(1)
	})
})

describe("searchEntitiesAutocomplete on $search autocomplete", () => {
	it("emits one $search with autocomplete on name and aliases, and never a find", async () => {
		const fake = stage([{ indexed: entity({ entityId: "a" }) }])
		await searchEntitiesAutocomplete({
			db: fake.db,
			prefix: PREFIX,
			query: "Ali",
			...tenant,
		})
		expect(fake.findCalls).toEqual([])
		expect(fake.pipelines).toHaveLength(1)
		const search = fake.pipelines[0][0].$search as Document
		expect(search.index).toBe(INDEX)
		expect(search.compound.should).toEqual([
			{ autocomplete: { query: "Ali", path: "name" } },
			{ autocomplete: { query: "Ali", path: "aliases" } },
		])
		// With a filter present, `should` is optional unless a minimum is set.
		expect(search.compound.minimumShouldMatch).toBe(1)
		expect(JSON.stringify(fake.pipelines)).not.toContain("$regex")
		expect(fake.options[0]).toEqual({ maxTimeMS: expect.any(Number) })
	})

	it("matches a prefix of a name word or of an alias, in any case", async () => {
		const entries = [
			{
				indexed: entity({
					entityId: "nyc",
					name: "New York City",
					aliases: ["Big Apple"],
				}),
			},
			{ indexed: entity({ entityId: "bob", name: "Bob" }) },
		]
		expect(await prefixLookup(entries, "new yo")).toEqual(["nyc"])
		expect(await prefixLookup(entries, "APP")).toEqual(["nyc"])
		expect(await prefixLookup(entries, "bo")).toEqual(["bob"])
	})

	it("does not return entities that do not match the prefix", async () => {
		const entries = [
			{ indexed: entity({ entityId: "alice", name: "Alice" }) },
			{ indexed: entity({ entityId: "bob", name: "Bob" }) },
			{ indexed: entity({ entityId: "malice", name: "Malice" }) },
		]
		expect(await prefixLookup(entries, "ali")).toEqual(["alice"])
		expect(await prefixLookup(entries, "lic")).toEqual([])
		expect(await prefixLookup(entries, "alicia")).toEqual([])
	})

	it("handles numbers, punctuation and a negated phrase as ordinary terms", async () => {
		const entries = [
			{ indexed: entity({ entityId: "p2", name: "Project 2024" }) },
			{ indexed: entity({ entityId: "njs", name: "Node.js Runtime" }) },
			{ indexed: entity({ entityId: "not", name: "Not Alice" }) },
			{ indexed: entity({ entityId: "alice", name: "Alice" }) },
		]
		expect(await prefixLookup(entries, "project 20")).toEqual(["p2"])
		expect(await prefixLookup(entries, "node.js run")).toEqual(["njs"])
		expect(await prefixLookup(entries, "alice")).toEqual(["not", "alice"])
	})

	it("returns only the caller's tenant and drops a candidate re-scoped after indexing", async () => {
		const entries = [
			{ indexed: entity({ entityId: "mine" }) },
			{ indexed: entity({ entityId: "other-agent", agentId: "agent-2" }) },
			{ indexed: entity({ entityId: "other-ref", scopeRef: "agent:agent-2" }) },
			{
				indexed: entity({ entityId: "moved" }),
				current: entity({ entityId: "moved", scopeRef: "agent:agent-2" }),
			},
			{ indexed: entity({ entityId: "deleted" }), current: null },
		]
		expect(await prefixLookup(entries, "ali")).toEqual(["mine"])
	})

	it("limits after revalidation and defaults the limit to 10", async () => {
		const entries = Array.from({ length: 14 }, (_, index) => ({
			indexed: entity({ entityId: `e${index}`, name: `Alice ${index}` }),
		}))
		const fake = stage(entries)
		const hits = await searchEntitiesAutocomplete({
			db: fake.db,
			prefix: PREFIX,
			query: "ali",
			...tenant,
		})
		expect(hits).toHaveLength(10)
		const pipeline = fake.pipelines[0]
		const match = pipeline.findIndex((entry) => "$match" in entry)
		const limit = pipeline.findIndex((entry) => "$limit" in entry)
		expect(match).toBeGreaterThan(0)
		expect(limit).toBeGreaterThan(match)
	})

	it("returns nothing, without a call, for a blank query", async () => {
		const fake = stage([{ indexed: entity({ entityId: "a" }) }])
		expect(
			await searchEntitiesAutocomplete({
				db: fake.db,
				prefix: PREFIX,
				query: "  ",
				...tenant,
			}),
		).toEqual([])
		expect(fake.pipelines).toEqual([])
	})

	it("types a Search failure and never runs a find, whatever the deployment reports", async () => {
		const fake = stage([], new Error("mongot unavailable"))
		const failure = await searchEntitiesAutocomplete({
			db: fake.db,
			prefix: PREFIX,
			query: "Ali",
			...tenant,
		}).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({ stage: "entity-lookup" })
		expect((failure as Error).message).not.toContain("mongot unavailable")
		expect(fake.pipelines).toHaveLength(1)
		expect(fake.findCalls).toEqual([])
	})

	it("ignores a capability flag passed by an older caller instead of switching lookups", async () => {
		const fake = stage([{ indexed: entity({ entityId: "a" }) }])
		await searchEntitiesAutocomplete({
			db: fake.db,
			prefix: PREFIX,
			query: "Ali",
			...tenant,
			...({ textSearchAvailable: false } as object),
		})
		expect(fake.pipelines).toHaveLength(1)
		expect(fake.findCalls).toEqual([])
	})
})
