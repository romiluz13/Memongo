// T8 (#117): discovery content matching goes through $search. The Search
// stage is MODELED (test-helpers/search-model-db.ts): these tests prove our
// pipelines, mappings, canonical re-checks and failure rows. They do not
// prove the real mongot analyzers; that stays untested here.
import { MongoServerError } from "mongodb"
import type { Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import { openSearchBudget } from "./mongodb-search-budget.js"
import { SearchBudgetDeniedError, SearchLaneError } from "./search-outcomes.js"
import {
	bestEffortFailureCount,
	resetBestEffortFailureCounts,
} from "./section-failures.js"
import {
	createSearchModelDb,
	type SearchModelDb,
} from "./test-helpers/search-model-db.js"
import type { MemoryDiscoveryProjectionKind } from "./types.js"

const TENANT = { agentId: "a1", scope: "agent" as const, scopeRef: "agent:a1" }
const OTHER = { ...TENANT, scopeRef: "agent:other" }
const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY)

let model: SearchModelDb
let counter = 0

const entity = (over: Document): Document => ({
	...TENANT,
	entityId: `ent-${++counter}`,
	type: "tool",
	aliases: [],
	updatedAt: daysAgo(1),
	...over,
})
const relation = (over: Document): Document => ({
	...TENANT,
	type: "related_to",
	state: "active",
	updatedAt: daysAgo(1),
	...over,
})
const structured = (over: Document): Document => ({
	...TENANT,
	type: "fact",
	key: `key-${++counter}`,
	value: "",
	context: "",
	tags: [],
	state: "active",
	updatedAt: daysAgo(1),
	...over,
})
const procedure = (over: Document): Document => ({
	...TENANT,
	procedureId: `proc-${++counter}`,
	name: "procedure",
	searchText: "",
	steps: [],
	state: "active",
	updatedAt: daysAgo(1),
	...over,
})
const episode = (over: Document): Document => ({
	...TENANT,
	episodeId: `ep-${++counter}`,
	title: "",
	summary: "",
	tags: [],
	topics: [],
	status: "open",
	timeRange: { start: daysAgo(3), end: daysAgo(2) },
	...over,
})
const event = (over: Document): Document => ({
	...TENANT,
	eventId: `ev-${++counter}`,
	role: "user",
	body: "",
	timestamp: daysAgo(1),
	...over,
})
const revision = (over: Document): Document => ({
	...TENANT,
	type: "fact",
	key: `key-${++counter}`,
	value: "",
	context: "",
	tags: [],
	supersededAt: daysAgo(1),
	updatedAt: daysAgo(5),
	...over,
})

function run(
	kind: MemoryDiscoveryProjectionKind,
	query?: string,
	extra: Record<string, unknown> = {},
) {
	return buildDiscoveryProjection({
		db: model.db,
		prefix: "test_",
		agentId: TENANT.agentId,
		scope: TENANT.scope,
		scopeRef: TENANT.scopeRef,
		kind,
		query,
		...extra,
	})
}

const titles = (
	projection: Awaited<ReturnType<typeof run>>,
	section: string,
): string[] =>
	projection.sections
		.find((entry) => entry.title === section)
		?.evidence.map((entry) => entry.title) ?? []

function findContentMatchers(value: unknown, found: string[] = []): string[] {
	if (value instanceof RegExp) {
		found.push("RegExp")
	} else if (Array.isArray(value)) {
		for (const entry of value) findContentMatchers(entry, found)
	} else if (value && typeof value === "object" && !(value instanceof Date)) {
		for (const [key, entry] of Object.entries(value)) {
			if (["$regex", "regex", "wildcard", "$text", "$lookup"].includes(key)) {
				found.push(key)
			}
			findContentMatchers(entry, found)
		}
	}
	return found
}

beforeEach(() => {
	model = createSearchModelDb()
	resetBestEffortFailureCounts()
	counter = 0
})
afterEach(() => {
	model.expectNoModelErrors()
	vi.restoreAllMocks()
})

describe("no content RegExp in discovery", () => {
	it.each([
		["entity-brief", "redis"],
		["topic-brief", "redis"],
		["what-changed", "redis"],
		["contradiction-report", "redis"],
		["what-changed", undefined],
		["contradiction-report", undefined],
	] as const)("%s with query %s issues no regex, wildcard, text or lookup", async (kind, query) => {
		await run(kind, query)
		const issued = model.calls.filter((call) =>
			["find", "aggregate", "findOne"].includes(call.method),
		)
		expect(issued.length).toBeGreaterThan(0)
		expect(findContentMatchers(issued.map((call) => call.args))).toEqual([])
	})

	it("searches for every query-driven kind and lists canonically without a query", async () => {
		await run("what-changed")
		await run("contradiction-report")
		expect(
			[
				"entities",
				"structured_mem",
				"procedures",
				"events",
				"episodes",
			].flatMap((suffix) => model.searchPipelines(suffix)),
		).toEqual([])
		await run("what-changed", "redis")
		await run("contradiction-report", "redis")
		await run("entity-brief", "redis")
		await run("topic-brief", "redis")
		const searched = [
			"entities",
			"structured_mem",
			"structured_mem_revisions",
			"procedures",
			"events",
			"episodes",
		].filter((suffix) => model.searchPipelines(suffix).length > 0)
		expect(searched).toEqual([
			"entities",
			"structured_mem",
			"structured_mem_revisions",
			"procedures",
			"events",
			"episodes",
		])
	})

	it("re-checks every Search hit with a canonical $match right after the Search stage", async () => {
		await run("topic-brief", "redis")
		for (const suffix of ["episodes", "structured_mem", "procedures"]) {
			const [pipeline] = model.searchPipelines(suffix)
			expect(Object.keys(pipeline[0])).toEqual(["$search"])
			expect(pipeline[1].$match).toMatchObject(TENANT)
			expect(pipeline[0].$search.compound.must[0].text.query).toBe("redis")
			expect(pipeline[0].$search.compound.filter).toEqual(
				expect.arrayContaining([
					{ equals: { path: "agentId", value: "a1" } },
					{ equals: { path: "scope", value: "agent" } },
					{ equals: { path: "scopeRef", value: "agent:a1" } },
				]),
			)
		}
		const [episodes] = model.searchPipelines("episodes")
		expect(episodes[0].$search.compound.mustNot).toEqual([
			{ equals: { path: "status", value: "deleted" } },
		])
		const [structuredPipeline] = model.searchPipelines("structured_mem")
		expect(structuredPipeline[0].$search.compound.filter).toContainEqual({
			equals: { path: "state", value: "active" },
		})
		expect(structuredPipeline[1].$match.state).toBe("active")
	})
})

describe("analyzer behavior through the modeled Search (entity brief)", () => {
	beforeEach(async () => {
		await model.seed("entities", [
			entity({
				entityId: "e1",
				name: "Redis Cache",
				aliases: ["redis-cluster", "RDS"],
			}),
			entity({ entityId: "e2", name: "Project: Apollo (v2)", type: "project" }),
			entity({ entityId: "e4", name: "Redis Cache", ...OTHER }),
		])
		model.refreshIndexes()
	})

	it.each([
		["redis", ["Redis Cache (tool)"]],
		["REDIS", ["Redis Cache (tool)"]],
		["rEdIs cache", ["Redis Cache (tool)"]],
		["rds", ["Redis Cache (tool)"]],
		["apollo", ["Project: Apollo (v2) (project)"]],
		["Apollo!!!", ["Project: Apollo (v2) (project)"]],
		["v2", ["Project: Apollo (v2) (project)"]],
		["reds", []],
		["redi", []],
		["!!!", []],
	])("query %j matches %j", async (query, expected) => {
		const projection = await run("entity-brief", query)
		expect(titles(projection, "Entities")).toEqual(expected)
		expect(projection.metadata.failures).toEqual([])
		expect(projection.metadata.partial).toBe(false)
	})

	it("reads relations by the matched entity ids, not by query text", async () => {
		await model.seed("entities", [
			entity({ entityId: "e3", name: "Ops Team", type: "team" }),
		])
		await model.seed("relations", [
			relation({ fromEntityId: "e1", toEntityId: "e3", type: "owned_by" }),
			relation({ fromEntityId: "e2", toEntityId: "e3", type: "owned_by" }),
		])
		model.refreshIndexes()
		const projection = await run("entity-brief", "redis")
		expect(titles(projection, "Relationships")).toEqual([
			"Redis Cache owned_by Ops Team",
		])
	})
})

describe("analyzer behavior through the modeled Search (structured memory)", () => {
	beforeEach(async () => {
		await model.seed("structured_mem", [
			structured({
				key: "deploy_rule",
				value: "Do NOT deploy on Fridays",
				tags: ["policy"],
			}),
			structured({ key: "staging_port", value: "Port is 8080 for staging" }),
			structured({ key: "other_tenant", value: "Redis rotation", ...OTHER }),
		])
		model.refreshIndexes()
	})

	it.each([
		["8080", ["staging_port"]],
		["80", []],
		["STAGING", ["staging_port"]],
		["policy", ["deploy_rule"]],
		["deploy_rule", ["deploy_rule"]],
		["deploy", ["deploy_rule"]],
		["fridays", ["deploy_rule"]],
		["redis", []],
	])("topic brief query %j", async (query, expectedKeys) => {
		const projection = await run("topic-brief", query)
		expect(titles(projection, "Durable memory")).toEqual(expectedKeys)
	})

	it("returns a negated statement verbatim; Search does not interpret negation", async () => {
		const projection = await run("topic-brief", "deploy")
		const evidence = projection.sections.find(
			(entry) => entry.title === "Durable memory",
		)?.evidence[0]
		expect(evidence?.summary).toBe("Do NOT deploy on Fridays")
	})
})

describe("episodes and procedures", () => {
	it("matches episodes on title, summary, tags and topics and never a deleted one", async () => {
		await model.seed("episodes", [
			episode({ episodeId: "ep-a", title: "Redis migration" }),
			episode({ episodeId: "ep-b", summary: "Moved the cache layer" }),
			episode({ episodeId: "ep-c", topics: ["caching"] }),
			episode({ episodeId: "ep-d", tags: ["Redis"] }),
			episode({ episodeId: "ep-e", title: "Redis gone", status: "deleted" }),
			episode({ episodeId: "ep-f", title: "Redis elsewhere", ...OTHER }),
		])
		model.refreshIndexes()
		const redis = await run("topic-brief", "redis")
		expect(
			redis.sections
				.find((entry) => entry.title === "Recent episodes")
				?.evidence.map((entry) => entry.canonicalId)
				.sort(),
		).toEqual(["episode:ep-a", "episode:ep-d"])
		const cache = await run("topic-brief", "cache caching")
		expect(
			cache.sections
				.find((entry) => entry.title === "Recent episodes")
				?.evidence.map((entry) => entry.canonicalId)
				.sort(),
		).toEqual(["episode:ep-b", "episode:ep-c"])
	})

	it("matches procedures through searchText, which embeds steps and intent tags", async () => {
		await model.seed("procedures", [
			procedure({
				procedureId: "p1",
				name: "Release",
				searchText: "Release rollback step run migrations intent deploy",
				steps: ["run migrations", "tag release"],
			}),
			procedure({
				procedureId: "p2",
				name: "Retired",
				searchText: "rollback retired",
				state: "invalidated",
			}),
		])
		model.refreshIndexes()
		const projection = await run("topic-brief", "rollback")
		expect(titles(projection, "Procedures")).toEqual(["Release"])
	})
})

describe("candidates are re-checked after Search (lifecycle after indexing)", () => {
	it("drops a structured record that was superseded, expired or deleted after indexing", async () => {
		await model.seed("structured_mem", [
			structured({ key: "kept", value: "pager rotation weekly" }),
			structured({ key: "superseded", value: "pager rotation weekly" }),
			structured({ key: "expired", value: "pager rotation weekly" }),
			structured({ key: "deleted", value: "pager rotation weekly" }),
			structured({ key: "moved", value: "pager rotation weekly" }),
		])
		model.refreshIndexes()
		const live = model.fake.collection("structured_mem")
		await live.updateOne(
			{ key: "superseded" },
			{ $set: { state: "superseded" } },
		)
		await live.updateOne(
			{ key: "expired" },
			{ $set: { expiresAt: daysAgo(1) } },
		)
		await live.deleteMany({ key: "deleted" })
		await live.updateOne(
			{ key: "moved" },
			{ $set: { scopeRef: "agent:other" } },
		)
		const projection = await run("topic-brief", "pager")
		expect(titles(projection, "Durable memory")).toEqual(["kept"])
	})

	it("drops an entity whose tenant changed after indexing", async () => {
		await model.seed("entities", [
			entity({ entityId: "e1", name: "Redis Cache" }),
			entity({ entityId: "e2", name: "Redis Proxy" }),
		])
		model.refreshIndexes()
		await model.fake
			.collection("entities")
			.updateOne({ entityId: "e2" }, { $set: { agentId: "someone-else" } })
		const projection = await run("entity-brief", "redis")
		expect(titles(projection, "Entities")).toEqual(["Redis Cache (tool)"])
	})

	it("does not see a record written after the index snapshot", async () => {
		await model.seed("structured_mem", [
			structured({ key: "old", value: "pager rotation" }),
		])
		model.refreshIndexes()
		await model.seed("structured_mem", [
			structured({ key: "fresh", value: "pager rotation" }),
		])
		expect(titles(await run("topic-brief", "pager"), "Durable memory")).toEqual(
			["old"],
		)
		model.refreshIndexes()
		expect(
			titles(await run("topic-brief", "pager"), "Durable memory").sort(),
		).toEqual(["fresh", "old"])
	})

	it("what-changed events: the lifecycle clause applies with and without a query", async () => {
		await model.seed("events", [
			event({ eventId: "live", body: "redis failover drill" }),
			event({ eventId: "invalid", body: "redis failover drill" }),
			event({ eventId: "expired", body: "redis failover drill" }),
			event({ eventId: "future", body: "redis failover drill" }),
		])
		model.refreshIndexes()
		const live = model.fake.collection("events")
		await live.updateOne(
			{ eventId: "invalid" },
			{ $set: { invalidAt: daysAgo(1) } },
		)
		await live.updateOne(
			{ eventId: "expired" },
			{ $set: { expiresAt: daysAgo(1) } },
		)
		await live.updateOne(
			{ eventId: "future" },
			{ $set: { validAt: new Date(Date.now() + DAY) } },
		)
		const withQuery = await run("what-changed", "redis")
		expect(
			withQuery.sections
				.find((entry) => entry.title === "Recent anchors")
				?.evidence.map((entry) => entry.path),
		).toEqual(["events/live"])
		const withoutQuery = await run("what-changed")
		expect(
			withoutQuery.sections
				.find((entry) => entry.title === "Recent anchors")
				?.evidence.map((entry) => entry.path),
		).toEqual(["events/live"])
	})

	it("what-changed windows the revisions, procedures and events by their date field", async () => {
		await model.seed("structured_mem_revisions", [
			revision({ key: "in-window", value: "pager rotation weekly" }),
			revision({
				key: "out-of-window",
				value: "pager rotation weekly",
				supersededAt: daysAgo(40),
			}),
		])
		await model.seed("procedures", [
			procedure({ procedureId: "p-new", name: "Pager runbook" }),
			procedure({
				procedureId: "p-old",
				name: "Pager runbook old",
				updatedAt: daysAgo(40),
			}),
		])
		await model.seed("events", [
			event({ eventId: "e-new", body: "pager handoff" }),
			event({
				eventId: "e-old",
				body: "pager handoff",
				timestamp: daysAgo(40),
			}),
		])
		model.refreshIndexes()
		const projection = await run("what-changed", "pager")
		expect(titles(projection, "Structured changes")).toEqual(["in-window"])
		expect(titles(projection, "Procedure changes")).toEqual(["Pager runbook"])
		expect(
			projection.sections
				.find((entry) => entry.title === "Recent anchors")
				?.evidence.map((entry) => entry.path),
		).toEqual(["events/e-new"])
	})
})

describe("relation briefs search entities first, then read relations by id", () => {
	beforeEach(async () => {
		await model.seed("entities", [
			entity({ entityId: "e1", name: "Redis Cache" }),
			entity({ entityId: "e2", name: "Ops Team", type: "team" }),
			entity({ entityId: "e3", name: "Billing", type: "service" }),
		])
		await model.seed("relations", [
			relation({ fromEntityId: "e1", toEntityId: "e2", type: "owned_by" }),
			relation({
				fromEntityId: "e3",
				toEntityId: "e2",
				type: "owned_by",
				state: "conflicted",
			}),
			relation({
				fromEntityId: "e1",
				toEntityId: "e3",
				type: "feeds",
				state: "conflicted",
			}),
			relation({
				fromEntityId: "e1",
				toEntityId: "e2",
				type: "stale",
				updatedAt: daysAgo(40),
			}),
		])
		model.refreshIndexes()
	})

	it("what-changed with a query keeps relations adjacent to a matched entity inside the window", async () => {
		const projection = await run("what-changed", "redis")
		expect(
			projection.sections
				.find((entry) => entry.title === "Relation changes")
				?.evidence.map((entry) => entry.title)
				.sort(),
		).toEqual(["e1 feeds e3", "e1 owned_by e2"])
	})

	it("matches the entity type but never the relation type", async () => {
		const byEntityType = await run("what-changed", "team")
		expect(
			byEntityType.sections.find((entry) => entry.title === "Relation changes")
				?.evidence.length,
		).toBe(2)
		const byRelationType = await run("what-changed", "feeds")
		expect(
			byRelationType.sections.find(
				(entry) => entry.title === "Relation changes",
			),
		).toBeUndefined()
	})

	it("contradiction report with a query reads conflicted relations adjacent to the match", async () => {
		const projection = await run("contradiction-report", "billing")
		expect(
			projection.sections
				.find((entry) => entry.title === "Relation contradictions")
				?.evidence.map((entry) => entry.title)
				.sort(),
		).toEqual(["e1 feeds e3", "e3 owned_by e2"])
	})

	it("without a query the relation reads stay canonical listings", async () => {
		const whatChanged = await run("what-changed")
		expect(
			whatChanged.sections.find((entry) => entry.title === "Relation changes")
				?.evidence.length,
		).toBe(3)
		const contradictions = await run("contradiction-report")
		expect(
			contradictions.sections.find(
				(entry) => entry.title === "Relation contradictions",
			)?.evidence.length,
		).toBe(2)
		expect(model.searchPipelines("entities")).toEqual([])
	})
})

describe("typed per-section failures", () => {
	const boom = new Error("mongot unavailable")

	it("a healthy zero is not a failure", async () => {
		const projection = await run("topic-brief", "nothing-matches-this")
		expect(projection.sections).toEqual([])
		expect(projection.metadata.failures).toEqual([])
		expect(projection.metadata.partial).toBe(false)
	})

	it("a failed section is a typed row and its healthy siblings survive", async () => {
		await model.seed("episodes", [
			episode({ episodeId: "ep-a", title: "Pager handoff" }),
		])
		model.refreshIndexes()
		model.fake.injectFailure({
			collection: "structured_mem",
			method: "aggregate",
			error: boom,
		})
		const projection = await run("topic-brief", "pager")
		expect(projection.metadata.failures).toEqual([
			{
				section: "structured",
				stage: "atlas-search",
				outcome: "failed",
				reason: "internal-error",
			},
		])
		expect(projection.metadata.partial).toBe(true)
		expect(titles(projection, "Recent episodes")).toEqual(["Pager handoff"])
	})

	it("classifies a driver error and a network error by enum, not by message", async () => {
		model.fake.injectFailure({
			collection: "episodes",
			method: "aggregate",
			error: new MongoServerError({ ok: 0, errmsg: "bad", code: 2 }),
		})
		model.fake.injectFailure({
			collection: "procedures",
			method: "aggregate",
			error: Object.assign(new Error("socket"), { name: "MongoNetworkError" }),
		})
		const projection = await run("topic-brief", "pager")
		expect(projection.metadata.failures).toEqual([
			{
				section: "episodes",
				stage: "atlas-search",
				outcome: "failed",
				reason: "query-error",
			},
			{
				section: "procedures",
				stage: "atlas-search",
				outcome: "failed",
				reason: "dependency-unavailable",
			},
		])
	})

	it("a canonical read failure after a healthy search is a typed row on its own section", async () => {
		await model.seed("entities", [
			entity({ entityId: "e1", name: "Redis Cache" }),
		])
		model.refreshIndexes()
		model.fake.injectFailure({
			collection: "relations",
			method: "find",
			error: boom,
		})
		const projection = await run("entity-brief", "redis")
		expect(projection.metadata.failures).toEqual([
			{
				section: "relations",
				stage: "lane",
				outcome: "failed",
				reason: "internal-error",
			},
		])
		expect(titles(projection, "Entities")).toEqual(["Redis Cache (tool)"])
	})

	it("every planned section failing throws the typed error instead of an empty brief", async () => {
		for (const collection of ["episodes", "structured_mem", "procedures"]) {
			model.fake.injectFailure({ collection, method: "aggregate", error: boom })
		}
		const failure = await run("topic-brief", "pager").then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect((failure as SearchLaneError).reason).toBe("internal-error")
		expect((failure as SearchLaneError).stage).toBe("atlas-search")
	})

	it("a total what-changed failure without a query is also typed", async () => {
		for (const collection of [
			"structured_mem_revisions",
			"procedures",
			"relations",
			"events",
		]) {
			model.fake.injectFailure({ collection, method: "find", error: boom })
		}
		await expect(run("what-changed")).rejects.toBeInstanceOf(SearchLaneError)
	})

	it("records the failed run and keeps the typed error when everything fails", async () => {
		for (const collection of ["episodes", "structured_mem", "procedures"]) {
			model.fake.injectFailure({ collection, method: "aggregate", error: boom })
		}
		await run("topic-brief", "pager").catch(() => undefined)
		expect(model.fake.all("projection_runs")).toEqual([
			expect.objectContaining({
				projectionType: "topic-brief",
				status: "failed",
			}),
		])
	})

	it("a budget denial is a budget-denied row, never a replacement operation", async () => {
		const ledger = openSearchBudget({ maxAggregations: 1, maxEmbeds: 0 })
		const projection = await ledger.run(() => run("topic-brief", "pager"))
		expect(projection.metadata.failures).toEqual([
			{
				section: "structured",
				stage: "atlas-search",
				outcome: "budget-denied",
				reason: "budget-aggregations",
			},
			{
				section: "procedures",
				stage: "atlas-search",
				outcome: "budget-denied",
				reason: "budget-aggregations",
			},
		])
		const exhausted = openSearchBudget({ maxAggregations: 0, maxEmbeds: 0 })
		await expect(
			exhausted.run(() => run("topic-brief", "pager")),
		).rejects.toBeInstanceOf(SearchBudgetDeniedError)
	})

	it("logs enums, the numeric code and a query digest, never the query", async () => {
		const lines: string[] = []
		for (const method of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				lines.push(args.join(" "))
			})
		}
		const secret = "violet launch SECRETTAIL"
		model.fake.injectFailure({
			collection: "structured_mem",
			method: "aggregate",
			error: new MongoServerError({
				ok: 0,
				errmsg: `bad regex ${secret}`,
				code: 2,
				codeName: "BadValue",
			}),
		})
		await run("topic-brief", secret)
		const output = lines.join("\n")
		expect(output).not.toContain("SECRETTAIL")
		expect(output).not.toContain("BadValue")
		const line = lines.find((entry) =>
			entry.includes("topic-brief.structured query failed"),
		)
		expect(line).toContain('"code":2')
		expect(line).toContain(`"queryLength":${secret.length}`)
		expect(line).toContain('"reason":"query-error"')
	})
})

describe("the run record is declared best-effort and counted", () => {
	it("a failed projection-run write never fails the read, and is counted", async () => {
		model.fake.injectFailure({
			collection: "projection_runs",
			method: "insertOne",
			error: new Error("write refused"),
			times: 5,
		})
		const projection = await run("topic-brief", "pager")
		expect(projection.metadata.failures).toEqual([])
		expect(bestEffortFailureCount("discovery-projection-run")).toBe(1)
	})
})
