// Shared test scaffolding for the MongoDBMemoryManager seam test files
// (P4.3 split of mongodb-manager.test.ts). vi.mock registrations stay in each
// test file (Vitest hoists them per-file), but the mock factories and the
// manager/collection scaffolding live here exactly once.
import { vi } from "vitest"
import { createOperationRunContext } from "../mongodb-operation-accounting.js"
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

export function testOperationRunContext(runId: string) {
	return createOperationRunContext({
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

/**
 * The canonical resolved `config.mongodb` shape for kit-based tests. Trace
 * and verdict seams read deep fields (`relevance.telemetry.queryPrivacyMode`,
 * `legacySearchFallback`, …), so partial configs crash — spread overrides on
 * top of this instead of building ad-hoc config objects.
 */
export function kitMongoConfig(overrides?: Record<string, unknown>) {
	return {
		mongodb: {
			embeddingMode: "automated",
			fusionMethod: "rankFusion",
			numCandidates: 200,
			cache: {
				enabled: false,
				conversationTtlSec: 300,
				kbTtlSec: 600,
			},
			// sources omitted — getActiveSources defaults to all enabled
			kb: { enabled: false },
			episodes: { enabled: true, minEventsForEpisode: 6 },
			graph: { enabled: false },
			reranking: { enabled: false },
			queryRewriting: { enabled: false },
			// RET-21: every recordRecallTrace site reads the diagnostic
			// privacy mode from the resolved relevance telemetry config —
			// mirror the resolver's safe default so trace writes in
			// mock-manager tests apply the redacted-hash policy.
			relevance: {
				enabled: true,
				telemetry: {
					enabled: true,
					baseSampleRate: 0.01,
					adaptive: {
						enabled: true,
						maxSampleRate: 0.1,
						minWindowSize: 5,
					},
					persistRawExplain: true,
					queryPrivacyMode: "redacted-hash",
				},
				retention: { days: 14 },
				benchmark: { enabled: false, datasetPath: "" },
			},
			...overrides,
		},
	}
}

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
		config: kitMongoConfig(),
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

export async function eventsModuleMock() {
	const actual = await vi.importActual<typeof import("../mongodb-events.js")>(
		"../mongodb-events.js",
	)
	return {
		...actual,
		writeEvent: vi.fn(),
		writeEventsBatch: vi.fn(),
		projectEventChunksBatch: vi.fn(),
		clearEventExtractionJobPendingBatch: vi.fn().mockResolvedValue(0),
		clearEventExtractionJobPending: vi.fn().mockResolvedValue(true),
		getPendingExtractionEvents: vi.fn().mockResolvedValue([]),
		getUnprojectedEvents: vi.fn().mockResolvedValue([]),
		projectChunksFromEvents: vi.fn(),
		projectEventChunk: vi.fn(),
		getEventsByTimeRange: vi.fn(),
		// C-006: fingerprint retention surface. The prune defaults to a no-op
		// so drain-path tests observe wiring, not retention behavior (covered
		// by mongodb-idempotency-retention.test.ts against the stateful fake).
		pruneIdempotencyFingerprints: vi.fn().mockResolvedValue({ pruned: 0 }),
		resolveIdempotencyRetentionDays: vi.fn(() => 90),
		IDEMPOTENCY_FINGERPRINT_RETENTION_DAYS: 90,
		IDEMPOTENCY_FINGERPRINT_PRUNE_INTERVAL_MS: 60 * 60 * 1000,
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

/**
 * Legacy manager suites use partial Db doubles and test behavior outside the
 * erasure boundary. Keep their established seams while making the new writer
 * dependency explicit. Fence-specific tests do not use this mock.
 */
export function writeFenceModuleMock() {
	class ErasureGateConflictError extends Error {
		readonly code = "ERASURE_GATE_CONFLICT"

		constructor(message = "erasure gate changed during write") {
			super(message)
			this.name = "ErasureGateConflictError"
		}
	}
	return {
		ErasureGateConflictError,
		isErasureGateConflictError: (
			err: unknown,
		): err is InstanceType<typeof ErasureGateConflictError> =>
			err instanceof ErasureGateConflictError,
		captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
			kind: "admission" as const,
			agentId,
			epoch: 0,
		})),
		readErasureGate: vi.fn(async ({ agentId }: { agentId: string }) => ({
			agentId,
			epoch: 0,
			state: "open" as const,
			serial: 0,
		})),
		withFencedWrite: vi.fn(
			async <T>({
				db,
				fn,
			}: {
				db: import("mongodb").Db
				fn: (session: import("mongodb").ClientSession) => Promise<T>
			}) => {
				const dbClient = (
					db as import("mongodb").Db & {
						client?: {
							startSession: () => Pick<
								import("mongodb").ClientSession,
								"withTransaction" | "endSession"
							>
						}
					}
				).client
				if (!dbClient) {
					return fn({} as import("mongodb").ClientSession)
				}
				const session = dbClient.startSession()
				try {
					return await session.withTransaction(
						() => fn(session as import("mongodb").ClientSession),
						{ writeConcern: { w: "majority", wtimeoutMS: 5000 } },
					)
				} finally {
					await session.endSession()
				}
			},
		),
	}
}

export async function benchmarkQualityContractsModuleMock(
	importOriginal: () => Promise<
		typeof import("../../../../scripts/benchmark/benchmark-quality-contracts.js")
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
		recordProjectionRun: vi.fn(async () => "projection-run-id"),
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
		extractAndUpsertTypedRelations: vi.fn(),
		prepareTypedRelations: vi.fn(async () => []),
		findRelationByLocatorId: vi.fn(),
	}
}

export function schemaModuleMock() {
	const makeEventsCollection = () => ({
		bsonOptions: {},
		find: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		insertMany: vi.fn(async (docs: Array<{ eventId?: string }>) => {
			const { writeEventsBatch } = await import("../mongodb-events.js")
			const results = await writeEventsBatch({
				db: {} as import("mongodb").Db,
				prefix: "test_",
				events: docs as never,
			})
			const writeErrors = results.flatMap((result, index) => {
				if (result.ok) {
					return []
				}
				return [
					{
						index,
						code: result.duplicateKey ? 11000 : 121,
						errmsg: result.duplicateKey
							? `${result.message} index: uq_events_agent_idempotency_key `
							: result.message,
					},
				]
			})
			if (writeErrors.length > 0) {
				throw { writeErrors }
			}
			return { acknowledged: true, insertedCount: docs.length }
		}),
	})
	const mockedEventsCollection = vi.fn(() => makeEventsCollection())
	const setEventsCollectionReturn = mockedEventsCollection.mockReturnValue.bind(
		mockedEventsCollection,
	)
	mockedEventsCollection.mockReturnValue = ((value: object) => {
		for (const [key, fallback] of Object.entries(makeEventsCollection())) {
			if (!(key in value)) {
				Object.defineProperty(value, key, {
					configurable: true,
					enumerable: false,
					value: fallback,
					writable: true,
				})
			}
		}
		return setEventsCollectionReturn(
			value as ReturnType<typeof makeEventsCollection>,
		)
	}) as typeof mockedEventsCollection.mockReturnValue
	return {
		eventsCollection: mockedEventsCollection,
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
		// W17: create() constructs the real MongoDBRelevanceRuntime when
		// relevance is enabled (the resolver default); its constructor reads
		// these two collections too.
		relevanceArtifactsCollection: vi.fn(),
		relevanceRegressionsCollection: vi.fn(),
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
		// W17 factory-unwind tests exercise create() end to end; the manager
		// imports this from mongodb-schema.js for the standard-index phase.
		shouldEnsureTextFallbackIndexes: vi.fn(() => false),
		resolveSearchIndexReadinessTiming: vi.fn(() => ({
			timeoutMs: 60_000,
			pollMs: 1_000,
		})),
		getExpectedSearchIndexTargets: vi.fn(() => []),
		sessionChunksCollection: vi.fn(),
		memoryEvidenceCollection: vi.fn(),
		// WS-13: getV2Status counts jobs via memoryJobsCollection(db, prefix)
		// (re-exported from mongodb-schema.js). Default to an empty collection
		// so unconfigured tests read 0 counts instead of throwing synchronously
		// while building the allSettled array.
		memoryJobsCollection: vi.fn(() => ({
			countDocuments: vi.fn(async () => 0),
		})),
		// WS-14: getV2Status passes entityLinksCollection(db, prefix) into
		// checkEntityLinkOrphans. The checkers themselves are mocked at the
		// mongodb-schema-integrity.js seam; this only needs to yield an
		// object, but an empty collection keeps unmocked call sites honest.
		entityLinksCollection: vi.fn(() => ({
			countDocuments: vi.fn(async () => 0),
		})),
	}
}

export function queryCacheModuleMock() {
	return {
		invalidateQueryCache: vi.fn(),
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
		// C-031: mongodb-search-v2.ts reads this constant at module scope, so
		// the mock must carry the real value (mongodb-reranker.ts) or every
		// manager test file fails at import time.
		RERANK_TIMEOUT_MS: 2_000,
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
		markLaneAvailable: vi.fn(),
		updateLaneCoverage: vi.fn(),
	}
}

export function memoryJobsModuleMock() {
	class MemoryJobOwnershipLostError extends Error {
		readonly code = "MEMORY_JOB_OWNERSHIP_LOST"

		constructor(readonly jobId: string) {
			super(`memory job ownership lost: ${jobId}`)
			this.name = "MemoryJobOwnershipLostError"
		}
	}
	return {
		claimMemoryJob: vi.fn(),
		captureClaimedMemoryJobAdmissionEpoch: vi.fn(async () => true),
		completeClaimedMemoryJob: vi.fn(),
		createMemoryJob: vi.fn(),
		createMemoryJobsBatch: vi.fn(),
		// W18: the drain loop calls this every round; default to "nothing to
		// sweep" so untouched tests keep passing.
		deadLetterExpiredMemoryJobs: vi.fn(async () => 0),
		failClaimedMemoryJob: vi.fn(),
		getMemoryJob: vi.fn(),
		listMemoryJobs: vi.fn(),
		releaseStagedMemoryJob: vi.fn().mockResolvedValue(true),
		releaseStagedMemoryJobsBatch: vi.fn().mockResolvedValue(0),
		renewMemoryJobLease: vi.fn(),
		retryFailedMemoryJob: vi.fn(),
		updateMemoryJob: vi.fn(),
		MemoryJobOwnershipLostError,
		isMemoryJobOwnershipLostError: (
			err: unknown,
		): err is InstanceType<typeof MemoryJobOwnershipLostError> =>
			err instanceof MemoryJobOwnershipLostError,
		withClaimedMemoryJobEffectBatch: vi.fn(
			async <T>({
				fn,
			}: {
				fn: (session: import("mongodb").ClientSession) => Promise<T>
			}) => fn({} as import("mongodb").ClientSession),
		),
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
		prepareDerivedMemoryPromotion: vi.fn(async () => ({
			structuredCandidates: [],
			procedureCandidates: [],
			promotionGuards: {},
		})),
		promoteDerivedMemoryFromEvent: vi.fn(),
		extractStructuredCandidatesFromEvent: vi.fn(() => []),
		resolveStructuredCandidatesForPromotion: vi.fn(async () => []),
		extractProcedureCandidatesFromEvent: vi.fn(() => []),
	}
}

// The readiness module is a pure boundary (only the db-touching probe needs
// stubbing), so its mock spreads the real module via importOriginal — same
// pattern as benchmarkQualityContractsModuleMock — instead of re-implementing
// pure exports like isTerminalSearchIndexStatus, which would drift.
export async function benchmarkReadinessModuleMock(
	importOriginal: () => Promise<
		typeof import("../../../../scripts/benchmark/mongodb-benchmark-readiness.js")
	>,
) {
	const actual = await importOriginal()
	return {
		...actual,
		readSearchIndexStatus: vi.fn().mockResolvedValue({
			kind: "fallback",
			reason: "command-not-found",
		}),
	}
}

export function telemetryModuleMock() {
	return {
		emitTelemetry: vi.fn().mockResolvedValue(undefined),
	}
}
