// M2 T2 (decision 8): a RUNNING manager takes a request-local index-health
// snapshot on every public search entry and refuses to run a lane against an
// index it observed unhealthy. The manager boots through the real startup
// contract over a fake Db (the T1 harness); the retrieval cores are mocked so
// only the health gate, the request scope and the ledger are under test.
import type { Db, MongoClient } from "mongodb"
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
	hasActiveSearchBudget,
	tryConsumeSearchAggregation,
} from "./mongodb-search-budget.js"
import {
	assertSearchBarrierTargets,
	awaitSearchBarrier,
} from "./mongodb-search-barrier.js"
import { searchKB as searchKBCore } from "./mongodb-kb-search.js"
import { recallConversation as recallConversationCore } from "./mongodb-conversation-recall.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { hydrateActiveSlate as hydrateActiveSlateCore } from "./mongodb-active-slate.js"
import { buildContextBundle as buildContextBundleCore } from "./mongodb-context-bundle.js"
import { buildDiscoveryProjection as buildDiscoveryProjectionCore } from "./mongodb-discovery-projections.js"
import {
	activeIndexHealth,
	assertCollectionIndexesHealthy,
} from "./mongodb-index-health.js"
import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import {
	getLatestIngestRun,
	getLatestProjectionRun,
	getProjectionLag,
} from "./mongodb-ops.js"
import {
	SearchLaneError,
	type SearchOutcomeSummary,
} from "./search-outcomes.js"
import {
	type FakeSearchIndex,
	createFakeSearchDb,
} from "./test-helpers/fake-search-db.js"

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
vi.mock("./mongodb-reranker.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).rerankerModuleMock(),
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
vi.mock("./mongodb-kb-search.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	searchKB: vi.fn(),
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
vi.mock("./mongodb-search-v2.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-search-v2.js")>()
	return { ...actual, searchV2: vi.fn() }
})

type ManagerPrototypeSeams = {
	sync: (params?: unknown) => Promise<void>
	repairEventProjections: () => Promise<unknown>
	ensureWatcher: () => void
}
const prototypeSeams =
	MongoDBMemoryManager.prototype as unknown as ManagerPrototypeSeams

function buildCfg(): MemongoConfig {
	return {
		memory: {
			backend: "mongodb",
			mongodb: { uri: "mongodb://index-health-unit:27017/health" },
		},
	}
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
async function boot() {
	// `fault.listError` injects a collection-level metadata read failure after boot.
	const fault: { listError?: (collection: string) => Error | undefined } = {}
	const fake = createFakeSearchDb({
		indexes: {},
		listError: (collection) => fault.listError?.(collection),
	})
	const client = {
		db: (name?: string) =>
			name === "admin" ? { command: async () => ({ ok: 1 }) } : fake.db,
		close: vi.fn(async () => {}),
	} as unknown as MongoClient
	const manager = await MongoDBMemoryManager.create({
		cfg: buildCfg(),
		agentId: "index-health",
		resolved: resolveMemoryBackendConfig({
			cfg: buildCfg(),
			agentId: "index-health",
		}),
		client,
	})
	managers.push(manager)
	return { manager, ...fake, fault }
}

function findIndex(
	indexes: Record<string, FakeSearchIndex[]>,
	suffix: string,
): { collection: string; index: FakeSearchIndex } {
	for (const [collection, list] of Object.entries(indexes)) {
		for (const index of list) {
			if (index.name.endsWith(suffix)) return { collection, index }
		}
	}
	throw new Error(`no booted index ends with ${suffix}`)
}

function patchIndex(
	indexes: Record<string, FakeSearchIndex[]>,
	suffix: string,
	patch: Partial<FakeSearchIndex> | null,
) {
	const { collection, index } = findIndex(indexes, suffix)
	indexes[collection] = indexes[collection].flatMap((candidate) =>
		candidate !== index
			? [candidate]
			: patch === null
				? []
				: [{ ...candidate, ...patch }],
	)
}

/** Puts back an index a test deleted, as a healthy READY index (a later healthy check). */
function restoreIndex(
	indexes: Record<string, FakeSearchIndex[]>,
	saved: { collection: string; index: FakeSearchIndex },
) {
	indexes[saved.collection] = [
		...indexes[saved.collection].filter(
			(candidate) => candidate.name !== saved.index.name,
		),
		{ ...saved.index, ...READY },
	]
}

const RECALL_TENANT = { scope: "agent", scopeRef: "agent:agent-1" } as const
const STALE = { status: "STALE" } as const
const BUILDING = { status: "BUILDING", queryable: false } as const
const READY = { status: "READY", queryable: true } as const

const kbHit = {
	path: "kb/doc-1",
	startLine: 1,
	endLine: 1,
	snippet: "runbook",
	score: 0.9,
	source: "kb" as const,
}

function listReadsOf(
	calls: ReturnType<typeof createFakeSearchDb>["calls"],
	collectionSuffix: string,
) {
	return calls.filter(
		(call) =>
			call.op === "aggregate" &&
			call.collection.endsWith(collectionSuffix) &&
			"$listSearchIndexes" in call.pipeline[0],
	).length
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "200")
	vi.stubEnv("MEMONGO_SEARCH_INDEX_READINESS_POLL_MS", "20")
	vi.stubEnv("MEMONGO_MONGODB_URI", undefined)
	vi.stubEnv("MEMONGO_FORCE_MONGODB_URI", undefined)
	resetSearchAdmissionForTests(Date.now())
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.mocked(schemaModule.chunksCollection).mockReturnValue({
		collectionName: "memongo_chunks",
	} as never)
	// The boot probe says NO Search at all: no request may read it as capability.
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
	vi.mocked(searchKBCore).mockResolvedValue([kbHit] as never)
	vi.mocked(recallConversationCore).mockResolvedValue({
		results: [],
	} as never)
	vi.mocked(searchV2).mockImplementation((async () => {
		const aggregationGranted = tryConsumeSearchAggregation()
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
				aggregationGranted,
			},
		}
	}) as never)
})

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	)
}

describe("running manager: searchKB gates on the request's index snapshot", () => {
	it.each([
		{ name: "healthy to STALE", patch: STALE, reason: "index-stale" },
		{ name: "BUILDING", patch: BUILDING, reason: "index-unavailable" },
		{ name: "deleted", patch: null, reason: "index-unavailable" },
	] as const)("$name: fails typed with the failed kb row and never runs the lane", async ({
		patch,
		reason,
	}) => {
		const { manager, indexes } = await boot()
		await expect(manager.searchKB("deploy runbook")).resolves.toEqual([kbHit])
		vi.mocked(searchKBCore).mockClear()
		patchIndex(indexes, "kb_chunks_vector", patch)

		let outcomes: SearchOutcomeSummary | undefined
		const failure = await failureOf(
			manager.searchKB("deploy runbook", {
				onOutcomes: (summary) => {
					outcomes = summary
				},
			}),
		)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			lane: "kb",
			stage: "index-health",
			reason,
		})
		expect(searchKBCore).not.toHaveBeenCalled()
		expect(outcomes).toEqual({
			status: "failed",
			lanes: [{ lane: "kb", stage: "index-health", outcome: "failed", reason }],
		})
	})

	it("a failed metadata read is index-unavailable carrying the read error, not an empty result", async () => {
		const { manager, calls, fault } = await boot()
		const readError = new Error("mongot unreachable")
		fault.listError = (collection) =>
			collection.endsWith("kb_chunks") ? readError : undefined
		const readsBefore = listReadsOf(calls, "kb_chunks")

		const failure = await failureOf(manager.searchKB("deploy runbook"))

		expect(failure).toMatchObject({
			name: "SearchLaneError",
			stage: "index-health",
			reason: "index-unavailable",
		})
		expect((failure as Error).cause).toBe(readError)
		expect(searchKBCore).not.toHaveBeenCalled()
		expect(listReadsOf(calls, "kb_chunks") - readsBefore).toBe(1)
	})

	it("recovers on the next request once the index is healthy", async () => {
		const { manager, indexes } = await boot()
		patchIndex(indexes, "kb_chunks_vector", STALE)
		const during = await failureOf(manager.searchKB("deploy runbook"))
		expect(during).toMatchObject({ reason: "index-stale" })
		expect(searchKBCore).not.toHaveBeenCalled()

		patchIndex(indexes, "kb_chunks_vector", READY)
		let outcomes: SearchOutcomeSummary | undefined
		const after = await manager.searchKB("deploy runbook", {
			onOutcomes: (summary) => {
				outcomes = summary
			},
		})

		expect(after).toEqual([kbHit])
		expect(searchKBCore).toHaveBeenCalledTimes(1)
		expect(outcomes?.status).toBe("complete")
	})

	it("an unhealthy index outside the kb lane does not fail a kb request", async () => {
		const { manager, indexes } = await boot()
		patchIndex(indexes, "events_vector", STALE)

		await expect(manager.searchKB("deploy runbook")).resolves.toEqual([kbHit])
		expect(searchKBCore).toHaveBeenCalledTimes(1)
	})

	it("reads index metadata fresh on every request: there is no startup snapshot", async () => {
		const { manager, calls } = await boot()
		const before = listReadsOf(calls, "kb_chunks")

		await manager.searchKB("first")
		const afterFirst = listReadsOf(calls, "kb_chunks")
		await manager.searchKB("second")
		const afterSecond = listReadsOf(calls, "kb_chunks")

		expect(afterFirst - before).toBe(1)
		expect(afterSecond - afterFirst).toBe(1)
	})
})

describe("running manager: searchDetailed and search take capabilities from the request snapshot", () => {
	function capabilitiesOfCall(position: number) {
		const context = vi.mocked(searchV2).mock.calls[position]?.[4] as {
			searchOptions?: {
				capabilities?: { vectorSearch: boolean; textSearch: boolean }
			}
		}
		return context.searchOptions?.capabilities
	}

	it("serves the live view although the boot probe reported no Search, and follows STALE and recovery", async () => {
		const { manager, indexes } = await boot()

		await manager.searchDetailed({
			query: "deploy notes",
			searchMode: "direct",
		})
		patchIndex(indexes, "chunks_vector", STALE)
		await manager.searchDetailed({
			query: "deploy notes",
			searchMode: "direct",
		})
		patchIndex(indexes, "chunks_vector", READY)
		await manager.searchDetailed({
			query: "deploy notes",
			searchMode: "direct",
		})

		expect(capabilitiesOfCall(0)).toMatchObject({
			vectorSearch: true,
			textSearch: true,
		})
		expect(capabilitiesOfCall(1)).toMatchObject({
			vectorSearch: false,
			textSearch: true,
		})
		expect(capabilitiesOfCall(2)).toMatchObject({
			vectorSearch: true,
			textSearch: true,
		})
	})

	it("a failed metadata read gives the request no search capability, so no lane can run against it", async () => {
		const { manager, fault } = await boot()
		fault.listError = () => new Error("mongot unreachable")

		await manager.searchDetailed({
			query: "deploy notes",
			searchMode: "direct",
		})

		expect(capabilitiesOfCall(0)).toMatchObject({
			vectorSearch: false,
			textSearch: false,
		})
	})

	it("reports the metadata checks on the request ledger apart from retrieval work", async () => {
		const { manager } = await boot()

		const response = await manager.searchDetailed({
			query: "deploy notes",
			searchMode: "direct",
		})

		expect(response.metadata.budget?.aggregations).toBe(1)
		expect(response.metadata.budget?.indexHealth).toMatchObject({
			failedMetadataReads: 0,
		})
		expect(
			response.metadata.budget?.indexHealth?.metadataReads,
		).toBeGreaterThanOrEqual(1)
	})

	it("search() shares the same live capability view", async () => {
		const { manager, indexes } = await boot()
		patchIndex(indexes, "chunks_text", STALE)

		await manager.search("deploy notes")

		expect(capabilitiesOfCall(0)).toMatchObject({
			vectorSearch: true,
			textSearch: false,
		})
	})

	it("runs every pass of one request inside one budget, with the snapshot open", async () => {
		const { manager } = await boot()
		let budgetActive = false
		vi.mocked(searchV2).mockImplementationOnce((async () => {
			budgetActive = hasActiveSearchBudget()
			return {
				results: [],
				metadata: {
					plan: { paths: [], confidence: "high", reasoning: "captured" },
					pathsExecuted: [],
					resultsByPath: {},
					outcomeStatus: "complete",
					laneOutcomes: [],
				},
			}
		}) as never)

		await manager.searchDetailed({
			query: "deploy notes",
			searchMode: "direct",
		})

		expect(budgetActive).toBe(true)
	})
})

describe("running manager: recallConversation gates on the events indexes", () => {
	it.each([
		{ name: "healthy to STALE", patch: STALE, reason: "index-stale" },
		{ name: "BUILDING", patch: BUILDING, reason: "index-unavailable" },
		{ name: "deleted", patch: null, reason: "index-unavailable" },
	] as const)("$name events index: fails typed before the recall core runs, then recovers", async ({
		patch,
		reason,
	}) => {
		const { manager, indexes } = await boot()
		const saved = findIndex(indexes, "events_vector")
		patchIndex(indexes, "events_vector", patch)

		const failure = await failureOf(
			manager.recallConversation({
				...RECALL_TENANT,
				query: "what did we say",
			} as never),
		)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			lane: "recall",
			stage: "index-health",
			reason,
		})
		expect(recallConversationCore).not.toHaveBeenCalled()

		restoreIndex(indexes, saved)
		await expect(
			manager.recallConversation({
				...RECALL_TENANT,
				query: "what did we say",
			} as never),
		).resolves.toEqual({ results: [] })
		expect(recallConversationCore).toHaveBeenCalledTimes(1)
	})

	it("a recall without a query is a plain find: it reads no Search index and is not gated", async () => {
		const { manager, indexes } = await boot()
		patchIndex(indexes, "events_vector", STALE)

		await expect(
			manager.recallConversation({ ...RECALL_TENANT, limit: 5 } as never),
		).resolves.toEqual({ results: [] })

		expect(recallConversationCore).toHaveBeenCalledTimes(1)
		expect(
			vi.mocked(recallConversationCore).mock.calls[0]?.[0],
		).not.toHaveProperty("capabilities")
	})

	it("a recall without its tenant identity fails typed before the health gate and the core", async () => {
		const { manager, indexes } = await boot()
		patchIndex(indexes, "events_vector", STALE)

		const failure = await failureOf(
			manager.recallConversation({ query: "what did we say" } as never),
		)

		expect(failure).toMatchObject({
			code: "TENANT_IDENTITY_REQUIRED",
			operation: "recallConversation",
			missing: ["scope", "scopeRef"],
		})
		expect(recallConversationCore).not.toHaveBeenCalled()
	})
})

describe("running manager: the slate and discovery entries open a request scope (M2 T13)", () => {
	it("buildDiscoveryProjection runs inside a request scope: a STALE index its core checks fails typed, then recovers", async () => {
		vi.mocked(buildDiscoveryProjectionCore).mockImplementation((async () => {
			await assertCollectionIndexesHealthy(["structured_mem"], "structured", [
				"search",
			])
			return { kind: "topic-brief", sections: [] }
		}) as never)
		const { manager, indexes } = await boot()
		const saved = findIndex(indexes, "structured_mem_text")
		patchIndex(indexes, "structured_mem_text", STALE)

		const failure = await failureOf(
			manager.buildDiscoveryProjection({
				kind: "topic-brief",
				query: "pager",
			}),
		)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			lane: "structured",
			stage: "index-health",
			reason: "index-stale",
		})

		restoreIndex(indexes, saved)
		await expect(
			manager.buildDiscoveryProjection({ kind: "topic-brief", query: "pager" }),
		).resolves.toMatchObject({ kind: "topic-brief" })
	})

	it("buildContextBundle runs inside a request scope: a STALE episodes index its episode-summary Search checks fails typed, then recovers", async () => {
		vi.mocked(buildContextBundleCore).mockImplementation((async () => {
			await assertCollectionIndexesHealthy(["episodes"], "episodic", ["search"])
			return {
				sections: [],
				metadata: { pathsExecuted: [], estimatedTokensUsed: 0 },
			}
		}) as never)
		const { manager, indexes } = await boot()
		const saved = findIndex(indexes, "episode_autocomplete")
		patchIndex(indexes, "episode_autocomplete", STALE)

		const failure = await failureOf(
			manager.buildContextBundle({ query: "pager" }),
		)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			lane: "episodic",
			stage: "index-health",
			reason: "index-stale",
		})

		restoreIndex(indexes, saved)
		await expect(
			manager.buildContextBundle({ query: "pager" }),
		).resolves.toMatchObject({ sections: [] })
	})

	it("hydrateActiveSlate runs inside a request scope", async () => {
		let scopeOpen = false
		vi.mocked(hydrateActiveSlateCore).mockImplementation((async () => {
			scopeOpen = activeIndexHealth() !== undefined
			return { items: [] }
		}) as never)
		const { manager } = await boot()

		await manager.hydrateActiveSlate({})

		expect(scopeOpen).toBe(true)
	})

	it("hydrateActiveSlate reads no Search index: a STALE index does not refuse it", async () => {
		vi.mocked(hydrateActiveSlateCore).mockResolvedValue({ items: [] } as never)
		const { manager, indexes, calls } = await boot()
		patchIndex(indexes, "structured_mem_text", STALE)
		const readsBefore = listReadsOf(calls, "structured_mem")

		await expect(manager.hydrateActiveSlate({})).resolves.toEqual({
			items: [],
		})

		expect(listReadsOf(calls, "structured_mem")).toBe(readsBefore)
	})
})

describe("running manager: no boot snapshot is live capability", () => {
	it("status() reports deployment facts and drops capabilities and searchModes", async () => {
		const { manager } = await boot()
		const status = manager.status()
		expect(status.custom).toHaveProperty("deploymentFacts")
		expect(status.custom).not.toHaveProperty("capabilities")
		expect(status.custom).not.toHaveProperty("searchModes")
	})

	it("holds no snapshot state or re-poll hook that could answer for a request", async () => {
		const { manager } = await boot()
		for (const removed of [
			"capabilities",
			"noteSearchLaneFailure",
			"searchLaneHealth",
			"lastSearchLaneFailure",
		]) {
			expect(manager).not.toHaveProperty(removed)
		}
	})

	it("getDetailedStatus reads each required index live and recovers", async () => {
		const zeroCollection = {
			countDocuments: vi.fn().mockResolvedValue(0),
			findOne: vi.fn().mockResolvedValue(null),
		} as never
		for (const collection of [
			schemaModule.eventsCollection,
			schemaModule.entitiesCollection,
			schemaModule.relationsCollection,
			schemaModule.episodesCollection,
			schemaModule.proceduresCollection,
			schemaModule.relevanceRunsCollection,
		]) {
			vi.mocked(collection).mockReturnValue(zeroCollection)
		}
		vi.mocked(getProjectionLag).mockResolvedValue(null)
		vi.mocked(getLatestIngestRun).mockResolvedValue(null)
		vi.mocked(getLatestProjectionRun).mockResolvedValue(null)
		vi.mocked(getLaneCoverage).mockResolvedValue(null)
		const { manager, indexes } = await boot()
		patchIndex(indexes, "chunks_text", STALE)
		const during = await manager.getDetailedStatus()
		patchIndex(indexes, "chunks_text", READY)
		const after = await manager.getDetailedStatus()

		expect(during.searchLanes).toMatchObject({ textSearch: false })
		expect(after.searchLanes).toMatchObject({ textSearch: true })
		expect(after.searchLanes?.indexes.every((index) => index.healthy)).toBe(
			true,
		)
	})
})

describe("post-commit barrier failure keeps the committed state (M2 decision 8)", () => {
	it("reports committed when the search probe cannot run after the index went unhealthy", async () => {
		const { manager, indexes } = await boot()
		const db = (manager as unknown as { db: Db }).db
		const prefix = "memongo_"
		await assertSearchBarrierTargets({ db, prefix, family: "structured" })
		patchIndex(indexes, "structured_mem_text", STALE)

		const result = await awaitSearchBarrier({
			db,
			prefix,
			family: "structured",
			token: "token-1",
			request: { timeoutMs: 1_000 },
		})

		expect(result).toMatchObject({
			committed: true,
			status: "not-yet-searchable",
			reason: "probe-failed",
		})
	})
})
