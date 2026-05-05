/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock collection accessors and telemetry before importing module under test
// ---------------------------------------------------------------------------

vi.mock("./mongodb-schema.js", () => ({
	structuredMemCollection: vi.fn(),
	entitiesCollection: vi.fn(),
	relationsCollection: vi.fn(),
	episodesCollection: vi.fn(),
	eventsCollection: vi.fn(),
}))

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import { synthesizeProfile } from "./mongodb-profile.js"
import {
	structuredMemCollection,
	entitiesCollection,
	episodesCollection,
	eventsCollection,
} from "./mongodb-schema.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const SCOPE = "agent" as const
const SCOPE_REF = "agent-scope-ref"

/**
 * Create a mock aggregate collection: the aggregate() call returns
 * a chain that ends with .toArray() returning the provided docs.
 */
function createMockAggregateCollection(docs: Document[]): Collection {
	return {
		aggregate: vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue(docs),
		}),
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					project: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}),
		}),
	} as unknown as Collection
}

/**
 * Create a mock find collection (for episodes): find().sort().limit().project().toArray()
 */
function createMockFindCollection(docs: Document[]): Collection {
	return {
		aggregate: vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		}),
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					project: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue(docs),
					}),
				}),
			}),
		}),
	} as unknown as Collection
}

/** Empty aggregate result for $facet (structured_mem) */
function emptyFacetResult(): Document[] {
	return [{ preferences: [], decisions: [], facts: [], todos: [] }]
}

/** Empty activity results */
function emptyActivityResult(): Document[] {
	return []
}

function defaultParams() {
	return {
		db: {} as Db,
		prefix: PREFIX,
		agentId: AGENT_ID,
		scope: SCOPE,
		scopeRef: SCOPE_REF,
	}
}

function setupEmptyMocks(): void {
	const emptyStructured = createMockAggregateCollection(emptyFacetResult())
	const emptyEntities = createMockAggregateCollection([])
	const emptyEpisodes = createMockFindCollection([])
	const emptyEvents = createMockAggregateCollection(emptyActivityResult())

	vi.mocked(structuredMemCollection).mockReturnValue(emptyStructured)
	vi.mocked(entitiesCollection).mockReturnValue(emptyEntities)
	vi.mocked(episodesCollection).mockReturnValue(emptyEpisodes)
	vi.mocked(eventsCollection).mockReturnValue(emptyEvents)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-profile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// 1. Empty collections
	it("synthesizeProfile returns empty profile when no data exists", async () => {
		setupEmptyMocks()

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.agentId).toBe(AGENT_ID)
		expect(profile.scope).toBe(SCOPE)
		expect(profile.scopeRef).toBe(SCOPE_REF)
		expect(profile.preferences).toEqual([])
		expect(profile.decisions).toEqual([])
		expect(profile.facts).toEqual([])
		expect(profile.todos).toEqual([])
		expect(profile.topEntities).toEqual([])
		expect(profile.recentEpisodes).toEqual([])
		expect(profile.activityPatterns.roleDistribution).toEqual({})
		expect(profile.activityPatterns.totalEvents).toBe(0)
		expect(profile.activityPatterns.lastActive).toBeNull()
		expect(profile.synthesizedAt).toBeInstanceOf(Date)
	})

	// 2. Grouped structured memory
	it("synthesizeProfile groups structured memory by type via $facet", async () => {
		const now = new Date()
		const facetResult = [
			{
				preferences: [
					{
						key: "pref1",
						value: "dark mode",
						salience: "normal",
						updatedAt: now,
					},
				],
				decisions: [
					{
						key: "dec1",
						value: "use TypeScript",
						salience: "high",
						updatedAt: now,
					},
				],
				facts: [
					{
						key: "fact1",
						value: "project started 2026",
						salience: "low",
						updatedAt: now,
					},
				],
				todos: [
					{
						key: "todo1",
						value: "add tests",
						salience: "critical",
						updatedAt: now,
					},
				],
			},
		]

		const structuredCol = createMockAggregateCollection(facetResult)
		vi.mocked(structuredMemCollection).mockReturnValue(structuredCol)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.preferences).toHaveLength(1)
		expect(profile.preferences[0].key).toBe("pref1")
		expect(profile.preferences[0].value).toBe("dark mode")
		expect(profile.decisions).toHaveLength(1)
		expect(profile.decisions[0].key).toBe("dec1")
		expect(profile.facts).toHaveLength(1)
		expect(profile.facts[0].key).toBe("fact1")
		expect(profile.todos).toHaveLength(1)
		expect(profile.todos[0].key).toBe("todo1")
	})

	// 3. Limits per type
	it("synthesizeProfile limits items per type to maxPerType", async () => {
		setupEmptyMocks()

		await synthesizeProfile({ ...defaultParams(), maxPerType: 5 })

		// Verify $facet pipeline uses the limit
		const structCol = vi.mocked(structuredMemCollection).mock.results[0].value
		const aggregateCall = vi.mocked(structCol.aggregate).mock
			.calls[0][0] as Document[]
		const facetStage = aggregateCall.find((s: Document) => s.$facet)
		expect(facetStage).toBeDefined()
		// Each sub-pipeline should contain a $limit step equal to maxPerType
		const facet = facetStage!.$facet
		for (const type of ["preferences", "decisions", "facts", "todos"]) {
			const subPipeline = facet[type] as Document[]
			const limitStage = subPipeline.find(
				(s: Document) => s.$limit !== undefined,
			)
			expect(limitStage).toBeDefined()
			expect(limitStage!.$limit).toBe(5)
		}
	})

	// 4. Sorted by updatedAt desc
	it("synthesizeProfile sorts structured memory by updatedAt desc", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		const structCol = vi.mocked(structuredMemCollection).mock.results[0].value
		const aggregateCall = vi.mocked(structCol.aggregate).mock
			.calls[0][0] as Document[]
		const facetStage = aggregateCall.find((s: Document) => s.$facet)
		const facet = facetStage!.$facet
		// Check at least one sub-pipeline has $sort by updatedAt: -1
		const prefPipeline = facet.preferences as Document[]
		const sortStage = prefPipeline.find((s: Document) => s.$sort !== undefined)
		expect(sortStage).toBeDefined()
		expect(sortStage!.$sort).toEqual({ updatedAt: -1 })
	})

	// 5. Filters by state: active
	it("synthesizeProfile filters by state: active only", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		const structCol = vi.mocked(structuredMemCollection).mock.results[0].value
		const aggregateCall = vi.mocked(structCol.aggregate).mock
			.calls[0][0] as Document[]
		const matchStage = aggregateCall.find((s: Document) => s.$match)
		expect(matchStage).toBeDefined()
		expect(matchStage!.$match.state).toBe("active")
	})

	// 6. Top entities by relation count
	it("synthesizeProfile returns top entities by relation count", async () => {
		const entityDocs = [
			{ name: "Alice", type: "person", relationCount: 5 },
			{ name: "Memongo", type: "project", relationCount: 3 },
		]

		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockAggregateCollection(emptyFacetResult()),
		)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection(entityDocs),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.topEntities).toHaveLength(2)
		expect(profile.topEntities[0].name).toBe("Alice")
		expect(profile.topEntities[0].type).toBe("person")
		expect(profile.topEntities[0].relationCount).toBe(5)
		expect(profile.topEntities[1].name).toBe("Memongo")
		expect(profile.topEntities[1].relationCount).toBe(3)
	})

	// 7. Limits entities
	it("synthesizeProfile limits entities to maxEntities", async () => {
		setupEmptyMocks()

		await synthesizeProfile({ ...defaultParams(), maxEntities: 3 })

		const entCol = vi.mocked(entitiesCollection).mock.results[0].value
		const aggregateCall = vi.mocked(entCol.aggregate).mock
			.calls[0][0] as Document[]
		const limitStage = aggregateCall.find(
			(s: Document) => s.$limit !== undefined,
		)
		expect(limitStage).toBeDefined()
		expect(limitStage!.$limit).toBe(3)
	})

	// 8. Recent episodes sorted
	it("synthesizeProfile returns recent episodes sorted by timeRange.start desc", async () => {
		const now = new Date()
		const earlier = new Date(now.getTime() - 3600000)
		const episodeDocs = [
			{
				title: "Recent",
				summary: "Recent episode",
				type: "daily",
				timeRange: { start: now, end: now },
			},
			{
				title: "Older",
				summary: "Older episode",
				type: "topic",
				timeRange: { start: earlier, end: earlier },
			},
		]

		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockAggregateCollection(emptyFacetResult()),
		)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(
			createMockFindCollection(episodeDocs),
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.recentEpisodes).toHaveLength(2)
		expect(profile.recentEpisodes[0].title).toBe("Recent")
		expect(profile.recentEpisodes[1].title).toBe("Older")
	})

	// 9. Limits episodes
	it("synthesizeProfile limits episodes to maxEpisodes", async () => {
		setupEmptyMocks()

		await synthesizeProfile({ ...defaultParams(), maxEpisodes: 3 })

		const epiCol = vi.mocked(episodesCollection).mock.results[0].value
		const findCall = vi.mocked(epiCol.find)
		expect(findCall).toHaveBeenCalled()
		// Check the chain: find().sort().limit(3)
		const sortResult = findCall.mock.results[0].value
		const limitResult = vi.mocked(sortResult.sort).mock.results[0].value
		expect(limitResult.limit).toHaveBeenCalledWith(3)
	})

	it("synthesizeProfile excludes deleted episodes from recentEpisodes", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		const epiCol = vi.mocked(episodesCollection).mock.results[0].value
		const findCall = vi.mocked(epiCol.find)
		expect(findCall).toHaveBeenCalledWith({
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			status: { $ne: "deleted" },
		})
	})

	// 10. Activity patterns from events
	it("synthesizeProfile calculates activity patterns from events", async () => {
		const activityDocs = [
			{ _id: "user", count: 15, lastTs: new Date("2026-03-20") },
			{ _id: "assistant", count: 10, lastTs: new Date("2026-03-22") },
			{ _id: "system", count: 2, lastTs: new Date("2026-03-19") },
		]

		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockAggregateCollection(emptyFacetResult()),
		)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection(activityDocs),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.activityPatterns.roleDistribution).toEqual({
			user: 15,
			assistant: 10,
			system: 2,
		})
		expect(profile.activityPatterns.totalEvents).toBe(27)
		expect(profile.activityPatterns.lastActive).toEqual(new Date("2026-03-22"))
	})

	// 11. activityWindowMs
	it("synthesizeProfile uses activityWindowMs for event filter", async () => {
		setupEmptyMocks()

		const customWindowMs = 7 * 24 * 60 * 60 * 1000 // 7 days
		const beforeTime = Date.now()
		await synthesizeProfile({
			...defaultParams(),
			activityWindowMs: customWindowMs,
		})
		const afterTime = Date.now()

		const evtCol = vi.mocked(eventsCollection).mock.results[0].value
		const aggregateCall = vi.mocked(evtCol.aggregate).mock
			.calls[0][0] as Document[]
		const matchStage = aggregateCall.find((s: Document) => s.$match)
		expect(matchStage).toBeDefined()
		const timestampFilter = matchStage!.$match.timestamp
		expect(timestampFilter.$gte).toBeInstanceOf(Date)
		const filterTime = (timestampFilter.$gte as Date).getTime()
		expect(filterTime).toBeGreaterThanOrEqual(beforeTime - customWindowMs)
		expect(filterTime).toBeLessThanOrEqual(afterTime - customWindowMs)
	})

	// 12. Null lastActive when no events
	it("synthesizeProfile returns null lastActive when no events", async () => {
		setupEmptyMocks()

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.activityPatterns.lastActive).toBeNull()
		expect(profile.activityPatterns.totalEvents).toBe(0)
	})

	// 13. Scope filtering on all queries
	it("synthesizeProfile filters all queries by agentId, scope, scopeRef", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		// Structured memory $match
		const structCol = vi.mocked(structuredMemCollection).mock.results[0].value
		const structAgg = vi.mocked(structCol.aggregate).mock
			.calls[0][0] as Document[]
		const structMatch = structAgg.find((s: Document) => s.$match)
		expect(structMatch!.$match.agentId).toBe(AGENT_ID)
		expect(structMatch!.$match.scope).toBe(SCOPE)
		expect(structMatch!.$match.scopeRef).toBe(SCOPE_REF)

		// Entities $match
		const entCol = vi.mocked(entitiesCollection).mock.results[0].value
		const entAgg = vi.mocked(entCol.aggregate).mock.calls[0][0] as Document[]
		const entMatch = entAgg.find((s: Document) => s.$match)
		expect(entMatch!.$match.agentId).toBe(AGENT_ID)
		expect(entMatch!.$match.scope).toBe(SCOPE)
		expect(entMatch!.$match.scopeRef).toBe(SCOPE_REF)

		// Episodes find filter
		const epiCol = vi.mocked(episodesCollection).mock.results[0].value
		const findCall = vi.mocked(epiCol.find).mock.calls[0][0] as Document
		expect(findCall.agentId).toBe(AGENT_ID)
		expect(findCall.scope).toBe(SCOPE)
		expect(findCall.scopeRef).toBe(SCOPE_REF)

		// Events $match
		const evtCol = vi.mocked(eventsCollection).mock.results[0].value
		const evtAgg = vi.mocked(evtCol.aggregate).mock.calls[0][0] as Document[]
		const evtMatch = evtAgg.find((s: Document) => s.$match)
		expect(evtMatch!.$match.agentId).toBe(AGENT_ID)
		expect(evtMatch!.$match.scope).toBe(SCOPE)
		expect(evtMatch!.$match.scopeRef).toBe(SCOPE_REF)
	})

	// 14. Telemetry emission
	it("synthesizeProfile emits profile-synthesis telemetry", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		expect(emitTelemetry).toHaveBeenCalledWith(
			{},
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "profile-synthesis" },
				ok: true,
				durationMs: expect.any(Number),
				resultCount: expect.any(Number),
			}),
		)
	})

	// 15. Empty structured_mem collection
	it("synthesizeProfile handles empty structured_mem collection", async () => {
		// When aggregate returns empty array (no $facet result)
		const structuredCol = createMockAggregateCollection([])
		vi.mocked(structuredMemCollection).mockReturnValue(structuredCol)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.preferences).toEqual([])
		expect(profile.decisions).toEqual([])
		expect(profile.facts).toEqual([])
		expect(profile.todos).toEqual([])
	})

	// 16. Empty entities collection
	it("synthesizeProfile handles empty entities collection", async () => {
		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockAggregateCollection(emptyFacetResult()),
		)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.topEntities).toEqual([])
	})

	// 17. Empty episodes collection
	it("synthesizeProfile handles empty episodes collection", async () => {
		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockAggregateCollection(emptyFacetResult()),
		)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.recentEpisodes).toEqual([])
	})

	// 18. Empty events collection
	it("synthesizeProfile handles empty events collection", async () => {
		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockAggregateCollection(emptyFacetResult()),
		)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.activityPatterns.totalEvents).toBe(0)
		expect(profile.activityPatterns.lastActive).toBeNull()
		expect(profile.activityPatterns.roleDistribution).toEqual({})
	})

	// 19. mapMemoryItems provides default salience
	it("synthesizeProfile provides default salience when missing from document", async () => {
		const now = new Date()
		const facetResult = [
			{
				preferences: [{ key: "pref1", value: "dark mode", updatedAt: now }],
				decisions: [],
				facts: [],
				todos: [],
			},
		]

		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockAggregateCollection(facetResult),
		)
		vi.mocked(entitiesCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)
		vi.mocked(episodesCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(
			createMockAggregateCollection([]),
		)

		const profile = await synthesizeProfile(defaultParams())

		expect(profile.preferences[0].salience).toBe("normal")
	})

	// 20. Entity $lookup uses two separate indexed $eq lookups (C2/M3 audit fix)
	it("synthesizeProfile uses two separate $lookup stages for fromEntityId and toEntityId", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		const entCol = vi.mocked(entitiesCollection).mock.results[0].value
		const aggregateCall = vi.mocked(entCol.aggregate).mock
			.calls[0][0] as Document[]
		const lookupStages = aggregateCall.filter((s: Document) => s.$lookup)
		// Should have TWO $lookup stages instead of one with $or
		expect(lookupStages.length).toBe(2)
		// Both should reference the relations collection
		expect(lookupStages[0].$lookup.from).toBe(`${PREFIX}relations`)
		expect(lookupStages[1].$lookup.from).toBe(`${PREFIX}relations`)
		// First lookup outputs "outRels", second "inRels"
		expect(lookupStages[0].$lookup.as).toBe("outRels")
		expect(lookupStages[1].$lookup.as).toBe("inRels")
	})

	// 21. No $or in $lookup pipeline (C2 audit fix: $or in $expr cannot use indexes)
	it("synthesizeProfile entity $lookup does NOT use $or in $expr", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		const entCol = vi.mocked(entitiesCollection).mock.results[0].value
		const aggregateCall = vi.mocked(entCol.aggregate).mock
			.calls[0][0] as Document[]
		const lookupStages = aggregateCall.filter((s: Document) => s.$lookup)
		for (const lookup of lookupStages) {
			const pipeline = lookup.$lookup.pipeline as Document[]
			for (const stage of pipeline) {
				if (stage.$match?.$expr) {
					expect(stage.$match.$expr.$or).toBeUndefined()
				}
			}
		}
	})

	// 22. Relation count sums both outgoing and incoming
	it("synthesizeProfile adds outgoing and incoming relation counts", async () => {
		setupEmptyMocks()

		await synthesizeProfile(defaultParams())

		const entCol = vi.mocked(entitiesCollection).mock.results[0].value
		const aggregateCall = vi.mocked(entCol.aggregate).mock
			.calls[0][0] as Document[]
		const addFieldsStage = aggregateCall.find(
			(s: Document) => s.$addFields?.relationCount,
		)
		expect(addFieldsStage).toBeDefined()
		// Should use $add with two $ifNull expressions
		const addExpr = addFieldsStage!.$addFields.relationCount
		expect(addExpr.$add).toBeDefined()
		expect(addExpr.$add.length).toBe(2)
	})
})
