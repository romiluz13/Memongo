// M2 #122 R1 and R2 at the RUNNING manager seam. The manager boots through
// the real startup contract over a fake Db (the T1/T2 harness), so every
// public entry reads live index metadata.
//   - R1: discovery, the context bundle and novelty each run on ONE request
//     ledger with the configured limits (12/5 by default), shared by sibling
//     sections and the nested search. Their REAL cores run against a Search
//     model (discovery, bundle) or a recording events collection (novelty),
//     so emitted aggregates and embeds are reconciled with the ledger the
//     manager opened, and an exhausted ledger is a typed denial.
//   - R2: novelty and consolidation take the request's index-health snapshot,
//     so a STALE index they plan to query fails typed before any probe runs.
import type { Db, Document, MongoClient } from "mongodb"
import type { MemongoConfig } from "@memongo/lib"
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import * as schemaModule from "./mongodb-schema.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import {
	type SearchBudgetSnapshot,
	consumeSearchWorkOrThrow,
	getSearchBudgetSnapshot,
	hasActiveSearchBudget,
	isSearchBudgetAdmitted,
	openSearchBudget,
} from "./mongodb-search-budget.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { hydrateActiveSlate as hydrateActiveSlateCore } from "./mongodb-active-slate.js"
import { buildContextBundle as buildContextBundleCore } from "./mongodb-context-bundle.js"
import { buildDiscoveryProjection as buildDiscoveryProjectionCore } from "./mongodb-discovery-projections.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import {
	activeIndexHealth,
	assertCollectionIndexesHealthy,
} from "./mongodb-index-health.js"
import { scanNovelty as scanNoveltyCore } from "./mongodb-novelty.js"
import { SearchBudgetDeniedError, SearchLaneError } from "./search-outcomes.js"
import {
	type FakeSearchIndex,
	createFakeSearchDb,
} from "./test-helpers/fake-search-db.js"
import {
	type SearchModelDb,
	createSearchModelDb,
} from "./test-helpers/search-model-db.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)
vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)
vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)
vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)
vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)
vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)
vi.mock("./mongodb-schema.js", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>()
	const kit = (
		await import("./test-helpers/manager-test-kit.js")
	).schemaModuleMock() as Record<string, unknown>
	const realSearchBoot = [
		"enforceBootContract",
		"ensureSearchIndexes",
		"waitForSearchIndexesQueryable",
		"isSearchIndexManagementAvailable",
		"getExpectedSearchIndexTargets",
		"resolveSearchIndexReadinessTiming",
		"listSearchIndexes",
	].filter((name) => name in real)
	return {
		...real,
		...kit,
		...Object.fromEntries(realSearchBoot.map((name) => [name, real[name]])),
	}
})
vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)
vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)
vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)
vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)
vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)
vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)
vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)
vi.mock("./mongodb-access-tracker.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	AccessTracker: class {
		async close(): Promise<void> {}
	},
}))
vi.mock("./mongodb-write-fence.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
		kind: "admission" as const,
		agentId,
		epoch: 0,
	})),
	withFencedWrite: vi.fn(
		async ({ fn }: { fn: (session: unknown) => Promise<unknown> }) => fn({}),
	),
}))
vi.mock("./mongodb-active-slate.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	hydrateActiveSlate: vi.fn(),
}))
vi.mock("./mongodb-context-bundle.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	buildContextBundle: vi.fn(),
}))
vi.mock("./mongodb-discovery-projections.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	buildDiscoveryProjection: vi.fn(),
}))
vi.mock("./mongodb-novelty.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	scanNovelty: vi.fn(),
}))
vi.mock("./mongodb-search-v2.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-search-v2.js")>()
	return { ...actual, searchV2: vi.fn() }
})

const real = {
	discovery: await vi.importActual<
		typeof import("./mongodb-discovery-projections.js")
	>("./mongodb-discovery-projections.js"),
	bundle: await vi.importActual<typeof import("./mongodb-context-bundle.js")>(
		"./mongodb-context-bundle.js",
	),
	novelty: await vi.importActual<typeof import("./mongodb-novelty.js")>(
		"./mongodb-novelty.js",
	),
	schema: await vi.importActual<typeof import("./mongodb-schema.js")>(
		"./mongodb-schema.js",
	),
}

type ManagerPrototypeSeams = {
	sync: (params?: unknown) => Promise<void>
	repairEventProjections: () => Promise<unknown>
	ensureWatcher: () => void
}
const prototypeSeams =
	MongoDBMemoryManager.prototype as unknown as ManagerPrototypeSeams

const PREFIX = "memongo_"
const AGENT = "request-ledger"
const TENANT = { agentId: AGENT, scope: "agent", scopeRef: `agent:${AGENT}` }

function buildCfg(searchBudget?: Record<string, number>): MemongoConfig {
	return {
		memory: {
			backend: "mongodb",
			mongodb: {
				uri: "mongodb://request-ledger-unit:27017/ledger",
				...(searchBudget ? { searchBudget } : {}),
			},
		},
	} as MemongoConfig
}

beforeAll(() => {
	vi.spyOn(prototypeSeams, "sync").mockResolvedValue(undefined as never)
	vi.spyOn(prototypeSeams, "repairEventProjections").mockResolvedValue({
		eventsProcessed: 0,
		chunksCreated: 0,
	} as never)
	vi.spyOn(prototypeSeams, "ensureWatcher").mockImplementation(() => {})
})

const managers: MongoDBMemoryManager[] = []

/** Boots a real manager: the startup contract creates every manifest index READY. */
async function boot(searchBudget?: Record<string, number>) {
	const fake = createFakeSearchDb({ indexes: {} })
	const client = {
		db: (name?: string) =>
			name === "admin" ? { command: async () => ({ ok: 1 }) } : fake.db,
		close: vi.fn(async () => {}),
	} as unknown as MongoClient
	const cfg = buildCfg(searchBudget)
	const manager = await MongoDBMemoryManager.create({
		cfg,
		agentId: AGENT,
		resolved: resolveMemoryBackendConfig({ cfg, agentId: AGENT }),
		client,
	})
	managers.push(manager)
	return { manager, ...fake }
}

function patchIndex(
	indexes: Record<string, FakeSearchIndex[]>,
	suffix: string,
	patch: Partial<FakeSearchIndex>,
) {
	for (const [collection, list] of Object.entries(indexes)) {
		indexes[collection] = list.map((index) =>
			index.name.endsWith(suffix) ? { ...index, ...patch } : index,
		)
	}
}

let model: SearchModelDb
/** The ledger snapshot each passed-through core saw when it finished. */
let snapshots: Array<SearchBudgetSnapshot | undefined>

function modelSearches(): number {
	return ["structured_mem", "procedures", "episodes", "entities", "events"]
		.map((collection) => model.searchPipelines(collection).length)
		.reduce((sum, count) => sum + count, 0)
}

/** A real events collection stand-in: candidates come back, every probe is recorded. */
function recordingEventsDb(candidates: number) {
	const probes: Document[][] = []
	const docs = Array.from({ length: candidates }, (_, index) => ({
		_id: `id-${index}`,
		eventId: `evt-${index}`,
		body: `observation number ${index}`,
		role: "user",
		timestamp: new Date(Date.UTC(2026, 9, 1, 0, index)),
	}))
	const events = {
		find: () => {
			const cursor = {
				sort: () => cursor,
				limit: () => cursor,
				project: () => cursor,
				toArray: async () => docs,
			}
			return cursor
		},
		aggregate: (pipeline: Document[]) => {
			probes.push(pipeline)
			return { toArray: async () => [] }
		},
	}
	const db = {
		collection: (name: string) => {
			if (name === `${PREFIX}events`) return events
			throw new Error(`unexpected collection ${name}`)
		},
	} as unknown as Db
	return { db, probes }
}

beforeEach(async () => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "200")
	vi.stubEnv("MEMONGO_SEARCH_INDEX_READINESS_POLL_MS", "20")
	vi.stubEnv("MEMONGO_MONGODB_URI", undefined)
	vi.stubEnv("MEMONGO_FORCE_MONGODB_URI", undefined)
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
	snapshots = []
	vi.mocked(schemaModule.chunksCollection).mockReturnValue({
		collectionName: "memongo_chunks",
	} as never)
	vi.mocked(schemaModule.detectCapabilities).mockResolvedValue({
		textSearch: false,
		vectorSearch: false,
		scoreFusion: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
	} as never)
	vi.mocked(schemaModule.ensureCollections).mockResolvedValue(
		undefined as never,
	)
	vi.mocked(schemaModule.ensureStandardIndexes).mockResolvedValue(
		undefined as never,
	)

	model = createSearchModelDb({ prefix: PREFIX })
	await model.seed("structured_mem", [
		{
			...TENANT,
			type: "fact",
			key: "pager-key",
			value: "pager rotation",
			context: "",
			tags: [],
			state: "active",
			updatedAt: new Date(),
		},
	])
	await model.seed("episodes", [
		{
			...TENANT,
			episodeId: "ep-1",
			title: "Pager handoff",
			summary: "Rotated the pager",
			tags: [],
			topics: [],
			status: "open",
			timeRange: { start: new Date(), end: new Date() },
		},
	])
	model.refreshIndexes()

	// The real cores run against the Search model; the collection accessors
	// they call are the real ones.
	for (const accessor of [
		"eventsCollection",
		"episodesCollection",
		"structuredMemCollection",
		"proceduresCollection",
		"entitiesCollection",
	] as const) {
		vi.mocked(schemaModule[accessor]).mockImplementation(
			real.schema[accessor] as never,
		)
	}
	vi.mocked(buildDiscoveryProjectionCore).mockImplementation((async (
		params: Parameters<typeof buildDiscoveryProjectionCore>[0],
	) => {
		const projection = await real.discovery.buildDiscoveryProjection({
			...params,
			db: model.db,
		})
		snapshots.push(getSearchBudgetSnapshot())
		return projection
	}) as never)
	vi.mocked(buildContextBundleCore).mockImplementation((async (
		params: Parameters<typeof buildContextBundleCore>[0],
	) => {
		const bundle = await real.bundle.buildContextBundle({
			...params,
			db: model.db,
		})
		snapshots.push(getSearchBudgetSnapshot())
		return bundle
	}) as never)
	vi.mocked(hydrateActiveSlateCore).mockResolvedValue({
		items: [],
		metadata: { partial: false, failures: [] },
	} as never)
})

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close()
	model.expectNoModelErrors()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	)
}

describe("#122 R1: discovery runs on one request ledger", () => {
	it("every Search aggregate the real core emits is charged to one ledger with the default 12/5 limits", async () => {
		const { manager } = await boot()

		await manager.buildDiscoveryProjection({
			kind: "topic-brief",
			query: "pager",
		})

		expect(modelSearches()).toBe(3)
		expect(snapshots).toEqual([
			expect.objectContaining({
				maxAggregations: 12,
				maxEmbeds: 5,
				aggregations: modelSearches(),
				embeds: 0,
			}),
		])
	})

	it("an exhausted ledger is a typed budget denial per section, and nothing denied is emitted", async () => {
		const { manager } = await boot({ maxAggregations: 1, maxEmbeds: 5 })

		const projection = await manager.buildDiscoveryProjection({
			kind: "topic-brief",
			query: "pager",
		})

		const denied = projection.metadata.failures.filter(
			(row) => row.outcome === "budget-denied",
		)
		expect(denied).toHaveLength(2)
		expect(modelSearches()).toBe(1)
		expect(snapshots[0]).toMatchObject({ aggregations: 1, exhausted: true })
	})
})

describe("#122 R1: the context bundle shares one ledger across its sections and the nested search", () => {
	beforeEach(() => {
		vi.mocked(searchV2).mockImplementation((async () => {
			// What the real searchV2 sees on entry: the bundle's ledger, not
			// yet admitted, so it takes its admission token on that ledger.
			const ledgerOpen = hasActiveSearchBudget()
			const admitted = isSearchBudgetAdmitted()
			consumeSearchWorkOrThrow("lane", { aggregations: 1, embeds: 1 })
			return {
				results: [],
				metadata: {
					plan: { paths: [], confidence: "high", reasoning: "captured" },
					pathsExecuted: ["hybrid"],
					resultsByPath: {},
					outcomeStatus: "complete",
					laneOutcomes: [
						{
							lane: "hybrid",
							stage: "lane",
							outcome: "ok-empty",
							reason: "zero-hits",
							resultCount: 0,
						},
					],
					ledgerOpen,
					admitted,
				},
			}
		}) as never)
	})

	it("the episode-summary Search and the nested search charge the same ledger", async () => {
		const { manager } = await boot()

		await manager.buildContextBundle({ query: "pager" })

		expect(model.searchPipelines("episodes")).toHaveLength(1)
		const nested = await vi.mocked(searchV2).mock.results[0]?.value
		expect(nested.metadata).toMatchObject({ ledgerOpen: true, admitted: false })
		// One episode-summary Search plus the nested search's one charge.
		expect(snapshots).toEqual([
			expect.objectContaining({
				maxAggregations: 12,
				aggregations: modelSearches() + 1,
				embeds: 1,
			}),
		])
	})

	it("an exhausted ledger is a typed budget-denied section row, never an untyped empty", async () => {
		const { manager } = await boot({ maxAggregations: 1, maxEmbeds: 5 })

		const bundle = await manager.buildContextBundle({ query: "pager" })

		const denied = bundle.metadata.failures.filter(
			(row) => row.outcome === "budget-denied",
		)
		expect(denied).toHaveLength(1)
		expect(snapshots[0]).toMatchObject({ aggregations: 1, exhausted: true })
	})
})

describe("#122 R1 and R2: public novelty runs on one request ledger and the request's index snapshot", () => {
	function passThroughNovelty(candidates: number) {
		const events = recordingEventsDb(candidates)
		vi.mocked(scanNoveltyCore).mockImplementation((async (
			params: Parameters<typeof scanNoveltyCore>[0],
		) => {
			const report = await real.novelty.scanNovelty({
				...params,
				db: events.db,
			})
			snapshots.push(getSearchBudgetSnapshot())
			return report
		}) as never)
		return events
	}

	it("every probe it emits is one aggregation and one embed on the request ledger", async () => {
		const events = passThroughNovelty(3)
		const { manager } = await boot()

		const report = await manager.scanNovelty({ limit: 10 })

		expect(report.scannedCount).toBe(3)
		expect(events.probes).toHaveLength(3)
		expect(snapshots).toEqual([
			expect.objectContaining({
				maxAggregations: 30,
				maxEmbeds: 30,
				aggregations: events.probes.length,
				embeds: events.probes.length,
			}),
		])
	})

	it("a scan at the 30-candidate ceiling fits its own ledger at the default 12/5 config", async () => {
		const events = passThroughNovelty(30)
		const { manager } = await boot()

		const report = await manager.scanNovelty({ limit: 10 })

		expect(report.scannedCount).toBe(30)
		expect(events.probes).toHaveLength(30)
		expect(snapshots).toEqual([
			expect.objectContaining({
				aggregations: 30,
				embeds: 30,
				exhausted: false,
			}),
		])
	})

	it("inside a caller's 12/5 ledger, a scan of six candidates is a typed reservation denial and emits no probe", async () => {
		const events = passThroughNovelty(6)
		const { manager } = await boot()

		const failure = await failureOf(
			openSearchBudget(
				{ maxAggregations: 12, maxEmbeds: 5 },
				{ admitted: false },
			).run(() => manager.scanNovelty({ limit: 10 })),
		)

		expect(failure).toBeInstanceOf(SearchBudgetDeniedError)
		expect(failure).toMatchObject({
			stage: "reservation",
			reason: "budget-reservation",
		})
		expect(events.probes).toEqual([])
	})

	it("a STALE events vector index fails typed before any probe, then recovers", async () => {
		const events = passThroughNovelty(2)
		const { manager, indexes } = await boot()
		patchIndex(indexes, "events_vector", { status: "STALE" })

		const failure = await failureOf(manager.scanNovelty({ limit: 10 }))

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			stage: "index-health",
			reason: "index-stale",
		})
		expect(events.probes).toEqual([])

		patchIndex(indexes, "events_vector", { status: "READY" })
		await expect(manager.scanNovelty({ limit: 10 })).resolves.toMatchObject({
			scannedCount: 2,
		})
		expect(events.probes).toHaveLength(2)
	})
})

describe("#122 R2: consolidate runs inside the request's index snapshot", () => {
	it("a STALE structured-memory vector index its probes check fails typed, then recovers", async () => {
		let scopeOpen = false
		vi.mocked(consolidateMemory).mockImplementation((async () => {
			scopeOpen = activeIndexHealth() !== undefined
			await assertCollectionIndexesHealthy(["structured_mem"], undefined, [
				"vectorSearch",
			])
			return {
				runId: "run-1",
				eventsProcessed: 0,
				factsPromoted: 0,
				factsPruned: 0,
				conflictsResolved: 0,
				durationMs: 0,
			}
		}) as never)
		const { manager, indexes } = await boot()
		patchIndex(indexes, "structured_mem_vector", { status: "STALE" })

		const failure = await failureOf(manager.consolidate({}))

		expect(scopeOpen).toBe(true)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			stage: "index-health",
			reason: "index-stale",
		})

		patchIndex(indexes, "structured_mem_vector", { status: "READY" })
		await expect(manager.consolidate({})).resolves.toMatchObject({
			runId: "run-1",
		})
	})
})
