// Shared test scaffolding for the MongoDBMemoryManager seam test files
// (P4.3 split of mongodb-manager.test.ts). vi.mock registrations stay in each
// test file (Vitest hoists them per-file), but the mock factories and the
// manager/collection scaffolding live here exactly once.
import { vi } from "vitest"
import { createBenchmarkRunContext } from "../benchmark-parity-envelope.js"
import type { MongoDBMemoryManager } from "../mongodb-manager.js"

// This module is also loaded from inside vi.mock factories via dynamic
// import, so it must NOT statically import mongodb-manager.js (the manager's
// own module graph triggers those factories — a static import here would
// deadlock evaluation). Seam test files capture the prototype once instead.
let managerPrototype: object | undefined

export function captureManagerPrototype(
	managerClass: typeof MongoDBMemoryManager,
): void {
	managerPrototype = managerClass.prototype
}

export const mocked = <T>(value: T): T => {
	const maybeMocked = (
		vi as typeof vi & {
			mocked?: <U>(item: U) => U
		}
	).mocked
	return maybeMocked?.(value) ?? value
}

export function testBenchmarkRunContext(runId: string) {
	return createBenchmarkRunContext({
		runId,
		configuration: {
			executionProfile: "diagnostic",
			retrievalLane: "native",
			maxResults: 50,
			minScore: 0.01,
			settings: {},
		},
	})
}

export function testBenchmarkRunConfiguration(params: {
	executionProfile: "shipped" | "diagnostic"
	retrievalLane: "native" | "raw-session"
	maxResults: number
	minScore: number
}) {
	return { ...params, settings: {} }
}

// Fake Db — the real calls are mocked at the module level
export const fakeDb = {} as unknown as import("mongodb").Db
export const fakePrefix = "test_"

export function buildMockManager(overrides?: Record<string, unknown>) {
	if (!managerPrototype) {
		throw new Error(
			"captureManagerPrototype(MongoDBMemoryManager) must run before buildMockManager",
		)
	}
	return Object.assign(Object.create(managerPrototype), {
		db: fakeDb,
		prefix: fakePrefix,
		agentId: "agent-1",
		agentScopeRef: "agent:agent-1",
		workspaceScopeRef: "workspace:agent-1",
		client: undefined,
		capabilities: {
			vectorSearch: false,
			textSearch: false,
			rankFusion: false,
			storedSource: false,
			vectorIndexMethod: false,
			scoreFusion: false,
		},
		config: {
			mongodb: {
				embeddingMode: "automated",
				fusionMethod: "rankFusion",
				numCandidates: 200,
				cache: {
					enabled: true,
					conversationTtlSec: 300,
					kbTtlSec: 600,
				},
				// sources omitted — getActiveSources defaults to all enabled
				kb: { enabled: false },
				episodes: { enabled: true, minEventsForEpisode: 6 },
				graph: { enabled: false },
				reranking: { enabled: false },
				queryRewriting: { enabled: false },
			},
		},
		extraMemoryPaths: [],
		writeQueue: Promise.resolve(),
		derivationQueue: Promise.resolve(),
		chunkCount: 0,
		dirty: true,
		lastSearchMode: "legacy",
		accessTracker: null,
		relevance: null,
		...overrides,
	}) as MongoDBMemoryManager
}

// ---------------------------------------------------------------------------
// Module mock factories — one per vi.mock registration, verbatim from the
// pre-split mongodb-manager.test.ts. Wired up per test file as:
//   vi.mock("./mongodb-events.js", async () =>
//     (await import("./test-helpers/manager-test-kit.js")).eventsModuleMock())
// ---------------------------------------------------------------------------

export function eventsModuleMock() {
	return {
		writeEvent: vi.fn(),
		writeEventsBatch: vi.fn(),
		projectEventChunksBatch: vi.fn(),
		clearEventExtractionJobPendingBatch: vi.fn().mockResolvedValue(0),
		clearEventExtractionJobPending: vi.fn().mockResolvedValue(true),
		getPendingExtractionEvents: vi.fn().mockResolvedValue([]),
		projectChunksFromEvents: vi.fn(),
		projectEventChunk: vi.fn(),
		getEventsByTimeRange: vi.fn(),
		IdempotencyConflictError: class extends Error {
			readonly idempotencyKey: string
			constructor(idempotencyKey: string) {
				super(
					`idempotency key "${idempotencyKey}" was reused with a different payload`,
				)
				this.name = "IdempotencyConflictError"
				this.idempotencyKey = idempotencyKey
			}
		},
	}
}

export async function benchmarkQualityContractsModuleMock(
	importOriginal: () => Promise<
		typeof import("../benchmark-quality-contracts.js")
	>,
) {
	const actual = await importOriginal()
	return {
		...actual,
		resolveRegisteredBenchmarkQualityContract: vi.fn(
			({ declared }: { declared: unknown }) => declared,
		),
	}
}

export function conversationRecallModuleMock() {
	return {
		recallConversation: vi.fn(),
	}
}

export function opsModuleMock() {
	return {
		recordIngestRun: vi.fn(),
		getProjectionLag: vi.fn(),
		getLatestIngestRun: vi.fn(),
		getLatestProjectionRun: vi.fn(),
	}
}

export function benchmarkHarnessModuleMock() {
	return {
		ingestBenchmarkDataset: vi.fn(),
		ingestBenchmarkConversations: vi.fn(),
		importConversationDataset: vi.fn(),
		loadBenchmarkDataset: vi.fn(),
		resolveBenchmarkDatasetPath: vi.fn(
			async ({ datasetPath, baseDir, allowedRoots }) => {
				const fs = await import("node:fs/promises")
				const pathModule = await import("node:path")
				const candidate = pathModule.default.isAbsolute(datasetPath)
					? datasetPath
					: pathModule.default.resolve(baseDir, datasetPath)
				const resolved = await fs.realpath(candidate)
				const roots = await Promise.all(
					(allowedRoots ?? [baseDir]).map((root: string) =>
						fs.realpath(root).catch(() => pathModule.default.resolve(root)),
					),
				)
				const insideAllowedRoot = roots.some(
					(root) =>
						resolved === root ||
						resolved.startsWith(`${root}${pathModule.default.sep}`),
				)
				if (!insideAllowedRoot) {
					throw new Error(
						"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
					)
				}
				return resolved
			},
		),
	}
}

export function retrievalPlannerModuleMock() {
	return {
		planRetrieval: vi.fn(),
		classifyRetrievalQuery: vi.fn(({ query, hasTimeRange, hasScopes }) => {
			const normalizedQuery = String(query ?? "").toLowerCase()
			if (!normalizedQuery.trim()) return "direct"
			if (
				hasTimeRange ||
				/\b(today|yesterday|last week|last month|when)\b/.test(normalizedQuery)
			) {
				return "temporal"
			}
			if (hasScopes) return "scoped"
			if (/\b(compare|versus|vs|difference)\b/.test(normalizedQuery)) {
				return "comparison"
			}
			if (/\b(why|because|after that|before that)\b/.test(normalizedQuery)) {
				return "multi-hop"
			}
			return "direct"
		}),
		extractTemporalWindow: vi.fn(() => undefined),
		resolveNumCandidates: vi.fn((limit: number, override?: number) => {
			if (
				typeof override === "number" &&
				Number.isFinite(override) &&
				override > 0
			) {
				return Math.floor(override)
			}
			return Math.max(200, Math.floor(limit * 20))
		}),
		resolveTimeRangePreset: vi.fn((preset: string, now = new Date()) => {
			const end = new Date(now)
			const start = new Date(end)
			if (preset === "last-24h") start.setUTCDate(start.getUTCDate() - 1)
			else if (preset === "last-7d") start.setUTCDate(start.getUTCDate() - 7)
			else if (preset === "last-30d") start.setUTCDate(start.getUTCDate() - 30)
			else start.setUTCHours(0, 0, 0, 0)
			return { start, end }
		}),
	}
}

export function episodesModuleMock() {
	return {
		searchEpisodes: vi.fn(),
	}
}

export function graphModuleMock() {
	return {
		searchEntitiesAutocomplete: vi.fn(),
		expandGraph: vi.fn(),
		extractAndUpsertEntities: vi.fn(),
		findRelationByLocatorId: vi.fn(),
	}
}

export function schemaModuleMock() {
	return {
		eventsCollection: vi.fn(),
		entitiesCollection: vi.fn(),
		relationsCollection: vi.fn(),
		episodesCollection: vi.fn(),
		proceduresCollection: vi.fn(),
		chunksCollection: vi.fn(),
		filesCollection: vi.fn(),
		metaCollection: vi.fn(),
		kbCollection: vi.fn(),
		kbChunksCollection: vi.fn(),
		relevanceRunsCollection: vi.fn(),
		recallTracesCollection: vi.fn(),
		structuredMemCollection: vi.fn(),
		detectCapabilities: vi.fn(),
		ensureCollections: vi.fn(),
		ensureSchemaValidation: vi.fn(),
		ensureSearchIndexes: vi.fn(),
		ensureStandardIndexes: vi.fn(),
		waitForSearchCapabilities: vi.fn(),
		waitForSearchIndexesQueryable: vi.fn(),
		listSearchIndexes: vi.fn(),
		isSearchIndexReadyWithFilterFields: vi.fn(),
		isSearchIndexManagementAvailable: vi.fn(),
		isEventsVectorBitemporalPrefilterReady: vi.fn(),
		resolveSearchIndexReadinessTiming: vi.fn(() => ({
			timeoutMs: 60_000,
			pollMs: 1_000,
		})),
		getExpectedSearchIndexTargets: vi.fn(() => []),
		sessionChunksCollection: vi.fn(),
		memoryEvidenceCollection: vi.fn(),
	}
}

export function queryCacheModuleMock() {
	return {
		checkCache: vi.fn(),
		invalidateQueryCache: vi.fn(),
		writeCache: vi.fn(),
	}
}

export function queryRewriterModuleMock() {
	return {
		rewriteQuery: vi.fn(async ({ query }: { query: string }) => ({
			originalQuery: query,
			rewrittenQuery: query,
			rewritten: false,
			method: "synonym-expansion",
			latencyMs: 0,
		})),
	}
}

export function rerankerModuleMock() {
	return {
		crossEncoderRerank: vi.fn(async ({ results }) => ({
			results,
			reranked: false,
			latencyMs: 0,
		})),
	}
}

export function laneCoverageModuleMock() {
	return {
		getLaneCoverage: vi.fn().mockResolvedValue(null),
		updateLaneCoverage: vi.fn(),
	}
}

export function memoryJobsModuleMock() {
	return {
		claimMemoryJob: vi.fn(),
		completeClaimedMemoryJob: vi.fn(),
		createMemoryJob: vi.fn(),
		createMemoryJobsBatch: vi.fn(),
		failClaimedMemoryJob: vi.fn(),
		getMemoryJob: vi.fn(),
		listMemoryJobs: vi.fn(),
		releaseStagedMemoryJob: vi.fn().mockResolvedValue(true),
		renewMemoryJobLease: vi.fn(),
		retryFailedMemoryJob: vi.fn(),
		updateMemoryJob: vi.fn(),
	}
}

export function consolidatorModuleMock() {
	return {
		consolidateMemory: vi.fn(),
	}
}

export function derivedMemoryModuleMock() {
	return {
		heuristicEpisodeSummarizer: vi.fn(async () => ({
			title: "Thread: synthetic",
			summary: "Synthetic summary",
		})),
		promoteDerivedMemoryFromEvent: vi.fn(),
		extractStructuredCandidatesFromEvent: vi.fn(() => []),
		resolveStructuredCandidatesForPromotion: vi.fn(async () => []),
		extractProcedureCandidatesFromEvent: vi.fn(() => []),
	}
}

export function benchmarkReadinessModuleMock() {
	return {
		readSearchIndexStatus: vi.fn().mockResolvedValue({
			kind: "fallback",
			reason: "command-not-found",
		}),
	}
}

export function telemetryModuleMock() {
	return {
		emitTelemetry: vi.fn(),
	}
}
