// M2 T13 (#120, T2 Return decision 1): the T8 read surfaces and the request
// index-health snapshot.
//   - Discovery matches content through `$search`, so a STALE or missing text
//     index is a typed `index-stale` / `index-unavailable` section failure and
//     the query never runs against it.
//   - The active slate and context expansion read plain `find`s: they use no
//     Search index. They are pinned as NOT gated (negative controls), so a
//     later change that makes them depend on Search has to move these tests.
// The Search stage is MODELED (test-helpers/search-model-db.ts); the health
// metadata comes from the T2 fake over the real required-index manifest.
import type { Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { expandSearchContext } from "./mongodb-context-expansion.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import {
	deploymentFactsOf,
	runWithIndexHealth,
} from "./mongodb-index-health.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"
import { SearchLaneError } from "./search-outcomes.js"
import {
	type FakeSearchIndex,
	createFakeSearchDb,
	readyIndex,
} from "./test-helpers/fake-search-db.js"
import {
	type SearchModelDb,
	createSearchModelDb,
} from "./test-helpers/search-model-db.js"
import type {
	MemoryDiscoveryProjectionKind,
	MemorySearchResult,
} from "./types.js"

const PREFIX = "test_"
const TENANT = { agentId: "a1", scope: "agent" as const, scopeRef: "agent:a1" }
const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY)
const MANIFEST = buildRequiredIndexManifest({
	prefix: PREFIX,
	serverVersionArray: [8, 3, 0, 0],
	env: {} as NodeJS.ProcessEnv,
})
const FACTS = deploymentFactsOf({
	vectorSearch: true,
	textSearch: true,
	scoreFusion: true,
	rankFusion: true,
	storedSource: true,
	vectorIndexMethod: true,
	queryableSearchIndexes: [],
})

let model: SearchModelDb
let health: ReturnType<typeof createFakeSearchDb>

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

function setIndex(
	collection: string,
	name: string,
	patch: Partial<FakeSearchIndex> | null,
) {
	const key = `${PREFIX}${collection}`
	health.indexes[key] = health.indexes[key].flatMap((index) =>
		index.name !== name
			? [index]
			: patch === null
				? []
				: [{ ...index, ...patch }],
	)
}

function indexNameOf(collection: string, type: "search" | "vectorSearch") {
	const entry = MANIFEST.find(
		(candidate) =>
			candidate.collectionName === `${PREFIX}${collection}` &&
			candidate.type === type,
	)
	if (!entry) throw new Error(`no ${type} index on ${collection}`)
	return entry.name
}

function inRequestScope<T>(fn: () => Promise<T>): Promise<T> {
	return runWithIndexHealth(
		{ db: health.db, prefix: PREFIX, manifest: MANIFEST, facts: FACTS },
		fn,
	)
}

function listReads(): number {
	return health.calls.filter(
		(call) =>
			call.op === "aggregate" && "$listSearchIndexes" in call.pipeline[0],
	).length
}

function discover(kind: MemoryDiscoveryProjectionKind, query?: string) {
	return buildDiscoveryProjection({
		db: model.db,
		prefix: PREFIX,
		...TENANT,
		kind,
		query,
	})
}

const structured = (over: Document): Document => ({
	...TENANT,
	type: "fact",
	key: "pager-key",
	value: "pager rotation",
	context: "",
	tags: [],
	state: "active",
	updatedAt: daysAgo(1),
	...over,
})
const procedure = (over: Document): Document => ({
	...TENANT,
	procedureId: "proc-1",
	name: "pager handoff",
	searchText: "pager handoff",
	steps: [],
	state: "active",
	updatedAt: daysAgo(1),
	...over,
})
const episode = (over: Document): Document => ({
	...TENANT,
	episodeId: "ep-1",
	title: "Pager handoff",
	summary: "",
	tags: [],
	topics: [],
	status: "open",
	timeRange: { start: daysAgo(3), end: daysAgo(2) },
	...over,
})

beforeEach(async () => {
	model = createSearchModelDb({ prefix: PREFIX })
	health = createFakeSearchDb({ indexes: healthyIndexes() })
	await model.seed("structured_mem", [structured({})])
	await model.seed("procedures", [procedure({})])
	await model.seed("episodes", [episode({})])
	await model.seed("entities", [
		{
			...TENANT,
			entityId: "ent-1",
			name: "Pager",
			type: "tool",
			aliases: [],
			updatedAt: daysAgo(1),
		},
	])
	model.refreshIndexes()
})
afterEach(() => {
	model.expectNoModelErrors()
})

const SURFACES = [
	{
		kind: "topic-brief",
		collection: "structured_mem",
		section: "structured",
	},
	{ kind: "topic-brief", collection: "procedures", section: "procedures" },
	{ kind: "topic-brief", collection: "episodes", section: "episodes" },
	{ kind: "entity-brief", collection: "entities", section: "entities" },
	{
		kind: "what-changed",
		collection: "structured_mem_revisions",
		section: "revisions",
	},
	{ kind: "what-changed", collection: "events", section: "events" },
] as const

describe("discovery gates its Search read on the request's index snapshot", () => {
	it.each(
		SURFACES.flatMap((surface) => [
			{ ...surface, damage: "STALE", reason: "index-stale" },
			{ ...surface, damage: "missing", reason: "index-unavailable" },
		]),
	)("$kind: a $damage $collection index is a typed $reason section failure and is never queried", async ({
		kind,
		collection,
		section,
		damage,
		reason,
	}) => {
		setIndex(
			collection,
			indexNameOf(collection, "search"),
			damage === "STALE" ? { status: "STALE" } : null,
		)

		const projection = await inRequestScope(() => discover(kind, "pager"))

		expect(projection.metadata.failures).toContainEqual({
			section,
			stage: "index-health",
			outcome: "failed",
			reason,
		})
		expect(projection.metadata.partial).toBe(true)
		expect(model.searchPipelines(collection)).toEqual([])
	})

	it("sibling sections of a brief still serve when one index is unhealthy", async () => {
		setIndex("structured_mem", indexNameOf("structured_mem", "search"), {
			status: "STALE",
		})

		const projection = await inRequestScope(() =>
			discover("topic-brief", "pager"),
		)

		expect(projection.metadata.failures).toEqual([
			{
				section: "structured",
				stage: "index-health",
				outcome: "failed",
				reason: "index-stale",
			},
		])
		const titles = projection.sections.flatMap((entry) =>
			entry.evidence.map((item) => item.title),
		)
		expect(titles).toContain("Pager handoff")
	})

	it("every planned section unhealthy throws the typed error instead of an empty brief", async () => {
		for (const collection of ["structured_mem", "procedures", "episodes"]) {
			setIndex(collection, indexNameOf(collection, "search"), {
				status: "STALE",
			})
		}

		const failure = await inRequestScope(() =>
			discover("topic-brief", "pager"),
		).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect((failure as SearchLaneError).reason).toBe("index-stale")
		expect((failure as SearchLaneError).stage).toBe("index-health")
	})

	it("an unhealthy vector index does not refuse a text-only discovery read", async () => {
		setIndex("structured_mem", indexNameOf("structured_mem", "vectorSearch"), {
			status: "STALE",
		})

		const projection = await inRequestScope(() =>
			discover("topic-brief", "pager"),
		)

		expect(projection.metadata.failures).toEqual([])
	})

	it("a healthy snapshot reads each collection's metadata once per request", async () => {
		await inRequestScope(() => discover("topic-brief", "pager"))

		expect(listReads()).toBe(3)
	})

	it("a caller outside any request scope is not gated", async () => {
		setIndex("structured_mem", indexNameOf("structured_mem", "search"), {
			status: "STALE",
		})

		const projection = await discover("topic-brief", "pager")

		expect(projection.metadata.failures).toEqual([])
		expect(listReads()).toBe(0)
	})
})

describe("surfaces that read no Search index are not gated (negative controls)", () => {
	it("the active slate serves under a STALE and a missing Search index and reads no index metadata", async () => {
		setIndex("structured_mem", indexNameOf("structured_mem", "search"), {
			status: "STALE",
		})
		setIndex("procedures", indexNameOf("procedures", "search"), null)
		setIndex("events", indexNameOf("events", "search"), null)

		const slate = await inRequestScope(() =>
			hydrateActiveSlate({ db: model.db, prefix: PREFIX, ...TENANT }),
		)

		expect(slate.metadata.failures).toEqual([])
		expect(slate.items.length).toBeGreaterThan(0)
		expect(listReads()).toBe(0)
		expect(
			["structured_mem", "procedures", "events"].flatMap((collection) =>
				model.searchPipelines(collection),
			),
		).toEqual([])
	})

	it("context expansion serves under a missing events Search index and reads no index metadata", async () => {
		await model.seed("events", [
			{
				...TENANT,
				eventId: "ev-prev",
				sessionId: "s1",
				role: "user",
				body: "previous turn",
				timestamp: daysAgo(1.0001),
			},
			{
				...TENANT,
				eventId: "ev-hit",
				sessionId: "s1",
				role: "user",
				body: "the hit",
				timestamp: daysAgo(1),
			},
		])
		setIndex("events", indexNameOf("events", "search"), null)
		const hit: MemorySearchResult = {
			path: "events/ev-hit",
			startLine: 0,
			endLine: 0,
			score: 0.9,
			snippet: "the hit",
			source: "conversation",
			sessionId: "s1",
			timestamp: daysAgo(1),
		}

		const expanded = await inRequestScope(() =>
			expandSearchContext({
				db: model.db,
				prefix: PREFIX,
				...TENANT,
				results: [hit],
			}),
		)

		expect(expanded.failures).toEqual([])
		expect(expanded.results.map((result) => result.path)).toContain(
			"events/ev-prev",
		)
		expect(listReads()).toBe(0)
	})
})
