import path from "node:path"
import type { Document } from "mongodb"
import type { MemoryMongoDBFusionMethod, MemoryScope } from "@memongo/lib"
import { AccessTracker } from "./mongodb-access-tracker.js"
import { resolveSearchDefaultScope } from "./backend-config.js"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import type { BenchmarkRunContext } from "./benchmark-parity-envelope.js"
import { normalizeSearchResults } from "./mongodb-hybrid.js"
import type { SearchMethod } from "./mongodb-hybrid.js"
import { searchKB } from "./mongodb-kb-search.js"
import { recordRecallTrace } from "./mongodb-recall-traces.js"
import { checkCache, writeCache } from "./mongodb-query-cache.js"
import { runSingleFlight } from "./mongodb-single-flight.js"
import type { RelevanceArtifact } from "./mongodb-relevance.js"
import { resolveSessionEvidenceMode } from "./mongodb-session-evidence.js"
import { resolveUserfactEvidenceMode } from "./mongodb-userfact-evidence.js"
import { resolveEnrichmentMode } from "./mongodb-llm-enrichment.js"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import {
	kbCollection,
	chunksCollection,
	kbChunksCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { resolveScopeIdentity } from "./mongodb-scope.js"
import { mongoSearch, vectorSearch } from "./mongodb-search.js"
import type {
	SearchExplainOptions,
	SearchExplainTraceArtifact,
	SearchTraceEvent,
} from "./mongodb-search.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { annotateResultsWithTrust, summarizeTrust } from "./mongodb-trust.js"
import {
	applyHardConstraintRejections,
	buildConstraintSummaries,
	buildExecutorPasses,
	classifyExecutorSearch,
	computeEvidenceCoverage,
	executeMongoSearchPlan,
	normalizeMemorySearchRequest,
	resolveExecutorTimeRange,
	requestHasHardConstraints,
} from "./mongodb-search-executor.js"
import type {
	AccessEventCollection,
	MemorySearchRequest,
	MemorySearchResponse,
	MemorySearchResult,
} from "./types.js"
import {
	clampSearchMaxResults,
	deduplicateSearchResults,
	emptySearchMetadata,
	getActiveSources,
	isBenchmarkStrictMode,
	normalizeDetailedSearchRequest,
	rerankResults,
	resolveRuntimeSearchConfig,
	shouldUseDetailedSearchCache,
} from "./mongodb-search-ranking.js"
import type { ActiveSources } from "./mongodb-search-ranking.js"
import { searchV2 } from "./mongodb-search-v2.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import type { MongoDBMemoryManager } from "./mongodb-manager.js"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb")

/**
 * Search-orchestration collaborator extracted from `mongodb-manager.ts`
 * (P4.3 god-file split). The `MongoDBMemoryManager` facade lazily wires one
 * of these and delegates `search`, `searchDetailed`, and `searchKB`; all
 * state is read through the host at call time so `Object.create`-built test
 * doubles keep working.
 */

export class MongoDBManagerSearchOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	/**
	 * Resolve the tenant identity a read must be confined to.
	 *
	 * Every read path resolves identity through here so that an absent `scope`
	 * can never degrade into "all scopes" — the filter builders below take
	 * `scope`/`scopeRef` as required arguments, and this is the only sanctioned
	 * way to produce them.
	 *
	 * P2.3: reads share the canonical identity rule with writes (explicit
	 * scope wins; sessionKey implies "session"); the only read-specific input
	 * is the P1.4 env-resolved fallback (MEMONGO_SEARCH_DEFAULT_SCOPE).
	 */
	resolveSearchIdentity(opts?: {
		scope?: MemoryScope
		scopeRef?: string
		sessionKey?: string
	}): { scope: MemoryScope; scopeRef: string } {
		return resolveScopeIdentity({
			scope: opts?.scope,
			scopeRef: opts?.scopeRef,
			agentId: this.host.agentId,
			sessionId: opts?.sessionKey,
			workspaceDir: this.host.workspaceDir,
			defaultScope: resolveSearchDefaultScope(
				process.env.MEMONGO_SEARCH_DEFAULT_SCOPE,
			),
		})
	}

	buildConversationChunkFilter(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document {
		const sources = ["conversation", "sessions"]
		const sessionMode = resolveSessionEvidenceMode(
			process.env.MEMONGO_SESSION_EVIDENCE_MODE,
		)
		if (sessionMode === "A") {
			sources.push("session-evidence")
		}
		const userfactMode = resolveUserfactEvidenceMode(
			process.env.MEMONGO_USERFACT_EVIDENCE_MODE,
			process.env.MEMONGO_PREFERENCE_EVIDENCE_MODE,
		)
		if (userfactMode === "enabled") {
			sources.push("userfact-evidence", "preference-evidence")
		}
		const enrichmentMode = resolveEnrichmentMode(
			process.env.MEMONGO_LLM_ENRICHMENT_MODE,
		)
		if (enrichmentMode === "enabled") {
			if (!sources.includes("userfact-evidence")) {
				sources.push("userfact-evidence")
			}
			sources.push("qa-evidence")
		} else if (enrichmentMode === "facts-only") {
			if (!sources.includes("userfact-evidence")) {
				sources.push("userfact-evidence")
			}
		}
		return {
			source: { $in: sources },
			agentId: this.host.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			status: { $ne: "deleted" },
		}
	}

	buildBridgeChunkFilter(): Document {
		return {
			source: { $in: ["conversation", "memory"] },
			agentId: this.host.agentId,
			scope: "workspace",
			scopeRef: this.host.workspaceScopeRef,
			status: { $ne: "deleted" },
		}
	}

	/**
	 * Bridge notes live in the workspace namespace, so they are only readable by
	 * a caller whose own identity IS that workspace. Any other identity gets
	 * `undefined`, and the caller must skip the bridge lane entirely rather than
	 * search with no filter.
	 */
	buildBridgeChunkFilterForIdentity(params: {
		scope: MemoryScope
		scopeRef: string
	}): Document | undefined {
		if (
			params.scope !== "workspace" ||
			params.scopeRef !== this.host.workspaceScopeRef
		) {
			return undefined
		}
		return this.host.buildBridgeChunkFilter()
	}

	buildScopeAwareBridgeChunkFilter(
		activeSources: ActiveSources,
		params: { scope: MemoryScope; scopeRef: string },
	): Document | undefined {
		if (!activeSources.conversation || isBenchmarkStrictMode()) {
			return undefined
		}
		return this.host.buildBridgeChunkFilterForIdentity(params)
	}

	getBridgeChunkBudget(maxResults: number): number {
		// Bridge notes should remain searchable, but they are auxiliary to the
		// live runtime memory stream and should not monopolize the result budget.
		return Math.max(2, Math.ceil(maxResults / 3))
	}

	buildV2AvailablePaths(activeSources: ActiveSources): Set<RetrievalPath> {
		const mongoCfg = this.host.config.mongodb!
		const graphEnabled = mongoCfg.graph?.enabled !== false
		const episodesEnabled = mongoCfg.episodes?.enabled !== false
		const paths = new Set<RetrievalPath>()

		if (activeSources.structured) {
			paths.add("active-critical")
			paths.add("procedural")
			paths.add("structured")
		}
		if (activeSources.reference) {
			paths.add("kb")
		}
		if (activeSources.conversation) {
			paths.add("raw-window")
			paths.add("hybrid")
			if (graphEnabled) {
				paths.add("graph")
			}
			if (episodesEnabled) {
				paths.add("episodic")
			}
		}

		return paths
	}

	/**
	 * Record access for returned search results (fire-and-forget).
	 * Maps canonicalId prefixes to collection names for the AccessTracker.
	 */
	recordSearchAccess(results: MemorySearchResult[]): void {
		if (!this.host.accessTracker || results.length === 0) return
		for (const result of results) {
			const cid = result.canonicalId
			if (!cid) continue
			const colonIdx = cid.indexOf(":")
			if (colonIdx < 0) continue
			const prefix = cid.slice(0, colonIdx)
			const id = cid.slice(colonIdx + 1)
			const collectionMap: Record<string, AccessEventCollection> = {
				event: "events",
				structured: "structured_mem",
				procedure: "procedures",
				episode: "episodes",
				relation: "relations",
				entity: "entities",
			}
			const collection = collectionMap[prefix]
			if (collection && id) {
				this.host.accessTracker.recordAccess(id, collection)
			}
		}
	}

	setLastSearchMode(mode: string, details?: Record<string, unknown>) {
		this.host.lastSearchMode = mode
		this.host.lastSearchDetails = details
	}

	async legacySearch(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
		},
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			return []
		}

		const mongoCfg = this.host.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 10)
		const minScore = opts?.minScore ?? 0.1
		const startedAt = Date.now()
		const sampled = this.host.relevance?.shouldSample() ?? false
		const explainArtifacts: RelevanceArtifact[] = []
		const traceEvents: SearchTraceEvent[] = []
		const explainOpts: SearchExplainOptions | undefined = sampled
			? {
					enabled: true,
					deep: false,
					includeScoreDetails: true,
					onArtifact: (artifact: SearchExplainTraceArtifact) => {
						explainArtifacts.push({
							artifactType: artifact.artifactType,
							summary: artifact.summary,
							rawExplain: artifact.rawExplain,
							compression: "none",
						})
					},
				}
			: undefined

		const queryVector: number[] | null = null
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const bridgeMaxResults = this.host.getBridgeChunkBudget(maxResults)
		const emptyResults: MemorySearchResult[] = []
		// The legacy path is a fallback for searchV2, so it must be confined to
		// exactly the same tenant identity searchV2 would have used. Resolving it
		// here (rather than passing `opts` through raw) is what keeps an absent
		// `scope` from widening the read to every scope under this agentId.
		const identity = this.host.resolveSearchIdentity(opts)
		const bridgeFilter = this.host.buildBridgeChunkFilterForIdentity(identity)
		const [
			runtimeConversationResults,
			bridgeConversationResults,
			kbResults,
			structuredResults,
		] = await Promise.all([
			!activeSources.conversation
				? emptyResults
				: mongoSearch(
						chunksCollection(this.host.db, this.host.prefix),
						cleaned,
						queryVector,
						{
							maxResults,
							minScore,
							numCandidates: mongoCfg.numCandidates,
							sessionKey: opts?.sessionKey,
							filter: this.host.buildConversationChunkFilter(identity),
							fusionMethod: mongoCfg.fusionMethod,
							capabilities: this.host.capabilities,
							vectorIndexName: `${this.host.prefix}chunks_vector`,
							textIndexName: `${this.host.prefix}chunks_text`,
							vectorWeight: 0.7,
							textWeight: 0.3,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
							onTrace: (event) => {
								traceEvents.push(event)
							},
						},
					),
			!activeSources.conversation || !bridgeFilter
				? emptyResults
				: mongoSearch(
						chunksCollection(this.host.db, this.host.prefix),
						cleaned,
						queryVector,
						{
							maxResults: bridgeMaxResults,
							minScore,
							numCandidates: mongoCfg.numCandidates,
							sessionKey: opts?.sessionKey,
							filter: bridgeFilter,
							fusionMethod: mongoCfg.fusionMethod,
							capabilities: this.host.capabilities,
							vectorIndexName: `${this.host.prefix}chunks_vector`,
							textIndexName: `${this.host.prefix}chunks_text`,
							vectorWeight: 0.7,
							textWeight: 0.3,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
							onTrace: (event) => {
								traceEvents.push(event)
							},
						},
					),
			!activeSources.reference
				? emptyResults
				: searchKB(
						kbChunksCollection(this.host.db, this.host.prefix),
						cleaned,
						queryVector,
						{
							maxResults: Math.max(3, Math.floor(maxResults / 3)),
							minScore,
							scopeRef: identity.scopeRef,
							numCandidates: mongoCfg.numCandidates,
							vectorIndexName: `${this.host.prefix}kb_chunks_vector`,
							textIndexName: `${this.host.prefix}kb_chunks_text`,
							capabilities: this.host.capabilities,
							embeddingMode: mongoCfg.embeddingMode,
							kbDocs: kbCollection(this.host.db, this.host.prefix),
							explain: explainOpts,
						},
					).catch((err) => {
						if (isBenchmarkStrictMode()) {
							throw err
						}
						log.warn(`KB search failed: ${String(err)}`)
						return [] as MemorySearchResult[]
					}),
			!activeSources.structured
				? emptyResults
				: searchStructuredMemory(
						structuredMemCollection(this.host.db, this.host.prefix),
						cleaned,
						queryVector,
						{
							maxResults: Math.max(3, Math.floor(maxResults / 3)),
							minScore,
							filter: {
								agentId: this.host.agentId,
								scope: identity.scope,
								scopeRef: identity.scopeRef,
							},
							numCandidates: mongoCfg.numCandidates,
							capabilities: this.host.capabilities,
							vectorIndexName: `${this.host.prefix}structured_mem_vector`,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
						},
					).catch((err) => {
						if (isBenchmarkStrictMode()) {
							throw err
						}
						log.warn(`structured memory search failed: ${String(err)}`)
						return [] as MemorySearchResult[]
					}),
		])

		const conversationResults = [
			...runtimeConversationResults,
			...bridgeConversationResults,
		]
		const legacyMethod: SearchMethod = this.host.resolveObservedSearchMethod(
			traceEvents,
			mongoCfg,
		)
		const normalizedLegacy = normalizeSearchResults(
			conversationResults,
			legacyMethod,
		)
		const normalizedKb = normalizeSearchResults(kbResults, "kb")
		const normalizedStructured = normalizeSearchResults(
			structuredResults,
			"structured",
		)

		const merged = [
			...normalizedLegacy,
			...normalizedKb,
			...normalizedStructured,
		].toSorted((a, b) => b.score - a.score)

		const deduped = deduplicateSearchResults(merged)
		const dedupCount = merged.length - deduped.length
		if (dedupCount > 0) {
			log.debug(`search dedup: removed ${dedupCount} duplicate result(s)`)
		}
		const finalResults = rerankResults(deduped, cleaned).slice(0, maxResults)
		const successfulTrace = [...traceEvents]
			.toReversed()
			.find((event) => event.ok)
		const fallbackPath =
			successfulTrace && successfulTrace.method !== mongoCfg.fusionMethod
				? `${mongoCfg.fusionMethod}->${successfulTrace.method}`
				: undefined
		const health =
			this.host.relevance?.evaluateHealth(finalResults, fallbackPath) ?? "ok"
		this.host.relevance?.recordSignal(finalResults, fallbackPath)

		if (sampled && this.host.relevance) {
			explainArtifacts.push({
				artifactType: "trace",
				summary: {
					requestedFusionMethod: mongoCfg.fusionMethod,
					fallbackPath,
					events: traceEvents,
					topScore: finalResults[0]?.score ?? 0,
					resultCount: finalResults.length,
				},
			})
			void this.host.relevance
				.persistRun({
					query: cleaned,
					sourceScope: "all",
					latencyMs: Date.now() - startedAt,
					topK: maxResults,
					hitSources: Array.from(
						new Set(finalResults.map((result) => result.source)),
					),
					fallbackPath,
					status: health,
					sampled,
					sampleRate: this.host.relevance.getSampleState().current,
					artifacts: explainArtifacts,
					diagnosticMode: false,
				})
				.catch((err) => {
					this.host.relevance?.logTelemetryFailure(err)
				})
		}

		this.host.recordSearchAccess(finalResults)
		return finalResults
	}

	async search(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
			questionDate?: Date
			/**
			 * #66: receives the per-lane latency breakdown of this call. A sink
			 * rather than instance state so concurrent searches (#67 scenario
			 * runner) cannot cross-attribute each other's lane timings.
			 */
			onLaneLatency?: (latencyByLane: Record<string, number>) => void
		},
		benchmarkRunContext?: BenchmarkRunContext,
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			this.host.setLastSearchMode("v2:empty-query")
			return []
		}

		const mongoCfg = this.host.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 10)
		const minScore = opts?.minScore ?? mongoCfg.reranking?.minScore ?? 0.01
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const availablePaths = this.host.buildV2AvailablePaths(activeSources)

		// P1.4 + P2.3: explicit scope wins; sessionKey implies "session";
		// otherwise MEMONGO_SEARCH_DEFAULT_SCOPE overrides the "agent" fallback
		// (single-user deployments). Same rule the write path applies.
		const { scope: searchScope, scopeRef: searchScopeRef } =
			this.host.resolveSearchIdentity({
				scope: opts?.scope,
				scopeRef: opts?.scopeRef,
				sessionKey: opts?.sessionKey,
			})

		// P2.4: stampede protection — concurrent identical searches share ONE
		// execution via an in-process single-flight keyed on the resolved
		// effective query (agent + identity + query + resolved params, the same
		// dimensions the query-cache key folds in). Benchmark runs measure
		// per-call latency, so they bypass coalescing.
		const searchBag = {
			cleaned,
			opts,
			mongoCfg,
			maxResults,
			minScore,
			activeSources,
			availablePaths,
			searchScope,
			searchScopeRef,
			benchmarkRunContext,
		}
		if (benchmarkRunContext) {
			return this.host.executeSearchUncoalesced(searchBag)
		}
		const flightKey = [
			this.host.agentId,
			searchScope,
			searchScopeRef,
			cleaned,
			maxResults,
			minScore,
			opts?.questionDate?.toISOString() ?? "",
		].join("")
		const { value } = await runSingleFlight(this, flightKey, () =>
			this.host.executeSearchUncoalesced(searchBag),
		)
		return value
	}

	async executeSearchUncoalesced(params: {
		cleaned: string
		opts?: Parameters<MongoDBMemoryManager["search"]>[1]
		mongoCfg: ResolvedMongoDBConfig
		maxResults: number
		minScore: number
		activeSources: ActiveSources
		availablePaths: Set<RetrievalPath>
		searchScope: MemoryScope
		searchScopeRef: string
		benchmarkRunContext?: BenchmarkRunContext
	}): Promise<MemorySearchResult[]> {
		const {
			cleaned,
			opts,
			mongoCfg,
			maxResults,
			minScore,
			activeSources,
			availablePaths,
			searchScope,
			searchScopeRef,
			benchmarkRunContext,
		} = params

		// #66: measurement only — cost of the phases of this call that sit
		// outside searchV2's lanes. Merged into the lane breakdown before it
		// reaches the caller's sink.
		const phaseLatency: Record<string, number> = {}

		// Cache check: BEFORE search pipeline
		if (mongoCfg.cache.enabled) {
			const cacheCheckStartedAt = Date.now()
			const cacheResult = await checkCache({
				db: this.host.db,
				prefix: this.host.prefix,
				query: cleaned,
				agentId: this.host.agentId,
				scope: searchScope,
				scopeRef: searchScopeRef,
				config: mongoCfg.cache,
				// P2.4: resolved (post-default) params fold into the cache key, so
				// a cached page can never serve a different parameterization.
				keyParams: {
					maxResults,
					minScore,
					...(opts?.questionDate ? { questionDate: opts.questionDate } : {}),
				},
			})
			phaseLatency["phase:cache-check"] = Date.now() - cacheCheckStartedAt
			if (cacheResult.latency) {
				phaseLatency["phase:cache-exact"] = cacheResult.latency.exactMs
				phaseLatency["phase:cache-semantic"] = cacheResult.latency.semanticMs
			}
			if (cacheResult.hit) {
				this.host.setLastSearchMode(`v2:cache:${cacheResult.tier}`, {
					pathUsed: cacheResult.pathUsed,
					sourceScope: cacheResult.sourceScope,
				})
				const cachedPaths = cacheResult.pathUsed
					? cacheResult.pathUsed.split(",").filter(Boolean)
					: []
				void recordRecallTrace({
					db: this.host.db,
					prefix: this.host.prefix,
					trace: {
						agentId: this.host.agentId,
						query: cleaned,
						lanesUsed: cachedPaths,
						lanesSkipped: Array.from(availablePaths).filter(
							(path) => !cachedPaths.includes(path),
						),
						totalHits: cacheResult.results.length,
						latencyMs: 0,
						hitsByLane: Object.fromEntries(
							cachedPaths.map((path) => [path, 0]),
						),
						topHitIds: cacheResult.results
							.map((result) => result.canonicalId ?? result.path)
							.slice(0, 5),
					},
				}).catch((err) =>
					log.warn(
						`search recall trace write failed on cache hit: ${String(err)}`,
					),
				)
				return cacheResult.results
			}
		}

		const searchStart = Date.now()
		let laneLatency: Record<string, number> = {}
		try {
			const v2 = await searchV2(
				this.host.db,
				this.host.prefix,
				cleaned,
				this.host.agentId,
				{
					availablePaths,
					hasEpisodes: mongoCfg.episodes.enabled,
					hasGraphData: mongoCfg.graph.enabled,
					maxResults,
					searchOptions: {
						minScore,
						sessionKey: opts?.sessionKey,
						numCandidates: mongoCfg.numCandidates,
						capabilities: this.host.capabilities,
						fusionMethod: mongoCfg.fusionMethod,
						embeddingMode: mongoCfg.embeddingMode,
						graphMaxDepth: mongoCfg.graph.maxGraphDepth,
						conversationFilter: this.host.buildConversationChunkFilter({
							scope: searchScope,
							scopeRef: searchScopeRef,
						}),
						bridgeFilter: this.host.buildScopeAwareBridgeChunkFilter(
							activeSources,
							{
								scope: searchScope,
								scopeRef: searchScopeRef,
							},
						),
						bridgeMaxResults: this.host.getBridgeChunkBudget(maxResults),
						scope: searchScope,
						scopeRef: searchScopeRef,
						rerankConfig: mongoCfg.reranking,
						queryRewriteConfig: mongoCfg.queryRewriting,
						questionDate: opts?.questionDate,
						budget: mongoCfg.searchBudget,
						...(benchmarkRunContext ? { benchmarkRunContext } : {}),
					},
				},
			)

			// Emit search telemetry (fire-and-forget)
			emitTelemetry(this.host.db, this.host.prefix, {
				meta: { agentId: this.host.agentId, operation: "search" },
				durationMs: Date.now() - searchStart,
				ok: v2.results.length > 0,
				pathUsed: v2.metadata.pathsExecuted.join(","),
				resultCount: v2.results.length,
				topScore: v2.results[0]?.score ?? 0,
				fusionMethod: mongoCfg.fusionMethod,
			})
			const latencyMs = Date.now() - searchStart
			const latencyByLane = v2.metadata.latencyByPath ?? {}
			laneLatency = latencyByLane

			const v2Details = {
				plan: v2.metadata.plan.paths,
				confidence: v2.metadata.plan.confidence,
				constraints: v2.metadata.plan.constraints,
				pathsExecuted: v2.metadata.pathsExecuted,
				resultsByPath: v2.metadata.resultsByPath,
			}

			if (v2.results.length > 0) {
				this.host.setLastSearchMode("v2", v2Details)
				void recordRecallTrace({
					db: this.host.db,
					prefix: this.host.prefix,
					trace: {
						agentId: this.host.agentId,
						query: cleaned,
						lanesUsed: v2.metadata.pathsExecuted,
						lanesSkipped: Array.from(availablePaths).filter(
							(path) => !v2.metadata.pathsExecuted.includes(path),
						),
						totalHits: v2.results.length,
						latencyMs,
						hitsByLane: v2.metadata.resultsByPath,
						latencyByLane,
						topHitIds: v2.results
							.map((result) => result.canonicalId ?? result.path)
							.slice(0, 5),
					},
				}).catch((err) =>
					log.warn(`search recall trace write failed: ${String(err)}`),
				)
				// Fire-and-forget cache write
				if (mongoCfg.cache.enabled) {
					// H4 audit fix: derive TTL from actual paths executed (not static config)
					const hasKbPath = v2.metadata.pathsExecuted.includes("kb")
					const ttlSec = hasKbPath
						? mongoCfg.cache.kbTtlSec
						: mongoCfg.cache.conversationTtlSec
					// #66: writeCache is fire-and-forget, so this span bounds only the
					// synchronous dispatch the search path actually pays for.
					const cacheWriteStartedAt = Date.now()
					writeCache({
						db: this.host.db,
						prefix: this.host.prefix,
						query: cleaned,
						agentId: this.host.agentId,
						scope: searchScope,
						scopeRef: searchScopeRef,
						results: v2.results,
						pathUsed: v2.metadata.pathsExecuted.join(","),
						sourceScope: "conversation",
						ttlSec,
						// P2.4: same resolved params as the checkCache seam above.
						keyParams: {
							maxResults,
							minScore,
							...(opts?.questionDate
								? { questionDate: opts.questionDate }
								: {}),
						},
					})
					phaseLatency["phase:cache-write"] = Date.now() - cacheWriteStartedAt
				}
				this.host.recordSearchAccess(v2.results)
				return v2.results
			}

			void recordRecallTrace({
				db: this.host.db,
				prefix: this.host.prefix,
				trace: {
					agentId: this.host.agentId,
					query: cleaned,
					lanesUsed: v2.metadata.pathsExecuted,
					lanesSkipped: Array.from(availablePaths).filter(
						(path) => !v2.metadata.pathsExecuted.includes(path),
					),
					totalHits: 0,
					latencyMs,
					hitsByLane: v2.metadata.resultsByPath,
					latencyByLane,
					topHitIds: [],
				},
			}).catch((err) =>
				log.warn(`empty search recall trace write failed: ${String(err)}`),
			)
			if (isBenchmarkStrictMode()) {
				throw new Error(
					`searchV2 returned no results; legacy fallback disabled; paths=${v2.metadata.pathsExecuted.join(",") || "none"} hitsByLane=${JSON.stringify(v2.metadata.resultsByPath)}`,
				)
			}
			// P3.2: the legacySearch re-run is opt-in (empty ≠ error — the v2
			// empty answer stands unless the deployment asks for the double
			// retrieval via memory.mongodb.legacySearchFallback).
			if (!mongoCfg.legacySearchFallback) {
				this.host.setLastSearchMode("v2:empty", v2Details)
				return []
			}
			const fallbackResults = await this.host.legacySearch(cleaned, opts)
			this.host.setLastSearchMode("v2->legacy-empty", {
				...v2Details,
				fallbackResults: fallbackResults.length,
			})
			void recordRecallTrace({
				db: this.host.db,
				prefix: this.host.prefix,
				trace: {
					agentId: this.host.agentId,
					query: cleaned,
					lanesUsed: ["legacy"],
					lanesSkipped: Array.from(availablePaths),
					totalHits: fallbackResults.length,
					latencyMs,
					hitsByLane: { legacy: fallbackResults.length },
					topHitIds: fallbackResults
						.map((result) => result.canonicalId ?? result.path)
						.slice(0, 5),
				},
			}).catch((err) =>
				log.warn(`search fallback recall trace write failed: ${String(err)}`),
			)
			return fallbackResults
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (isBenchmarkStrictMode()) {
				throw new Error(
					`planner search failed; legacy fallback disabled: ${message}`,
				)
			}
			log.warn(
				`planner search failed, falling back to legacy search: ${message}`,
			)
			// P3.2: legacySearch re-run is opt-in (see the empty-result site).
			if (!mongoCfg.legacySearchFallback) {
				this.host.setLastSearchMode("v2:error", { error: message })
				return []
			}
			const fallbackResults = await this.host.legacySearch(cleaned, opts)
			this.host.setLastSearchMode("v2->legacy-error", {
				error: message,
				fallbackResults: fallbackResults.length,
			})
			void recordRecallTrace({
				db: this.host.db,
				prefix: this.host.prefix,
				trace: {
					agentId: this.host.agentId,
					query: cleaned,
					lanesUsed: ["legacy"],
					lanesSkipped: Array.from(availablePaths),
					totalHits: fallbackResults.length,
					latencyMs: Date.now() - searchStart,
					hitsByLane: { legacy: fallbackResults.length },
					topHitIds: fallbackResults
						.map((result) => result.canonicalId ?? result.path)
						.slice(0, 5),
				},
			}).catch((traceErr) =>
				log.warn(
					`search error fallback recall trace write failed: ${String(traceErr)}`,
				),
			)
			return fallbackResults
		} finally {
			// #66: `phase:total` is anchored on searchStart, so every span
			// subtracted here sits inside it. The cache check runs before
			// searchStart and is therefore reported alongside, not inside, total.
			phaseLatency["phase:total"] = Date.now() - searchStart
			const measuredInsideTotal =
				(laneLatency["phase:plan"] ?? 0) +
				(laneLatency["phase:lanes"] ?? 0) +
				(laneLatency["phase:rewrite"] ?? 0) +
				(laneLatency["phase:rerank"] ?? 0) +
				(phaseLatency["phase:cache-write"] ?? 0)
			phaseLatency["phase:unaccounted"] = Math.max(
				0,
				phaseLatency["phase:total"] - measuredInsideTotal,
			)
			opts?.onLaneLatency?.({ ...laneLatency, ...phaseLatency })
		}
	}

	async searchDetailed(
		request: MemorySearchRequest,
	): Promise<MemorySearchResponse> {
		const normalized = normalizeDetailedSearchRequest(request)
		if (!normalized.query) {
			this.host.setLastSearchMode("v2:empty-query")
			return {
				results: [],
				metadata: emptySearchMetadata(normalized),
			}
		}

		const mongoCfg = this.host.config.mongodb!
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const availablePaths = this.host.buildV2AvailablePaths(activeSources)
		// P1.4 + P2.3: same identity rule as search() and the write path.
		const { scope: searchScope, scopeRef: searchScopeRef } =
			this.host.resolveSearchIdentity({
				scope: normalized.scope,
				scopeRef: normalized.scopeRef,
				sessionKey: normalized.conversationScope?.sessionKey,
			})

		const executorRequest = normalizeMemorySearchRequest(normalized)
		const executorTimeRange = resolveExecutorTimeRange(executorRequest)
		const resolvedSearchConfig = resolveRuntimeSearchConfig(
			executorRequest,
			mongoCfg,
		)
		const canUseDetailedSearchCache =
			mongoCfg.cache.enabled && shouldUseDetailedSearchCache(executorRequest)

		// Cache check
		if (canUseDetailedSearchCache) {
			const cacheResult = await checkCache({
				db: this.host.db,
				prefix: this.host.prefix,
				query: normalized.query,
				agentId: this.host.agentId,
				scope: searchScope,
				scopeRef: searchScopeRef,
				config: mongoCfg.cache,
				// P2.4: resolved (post-default) params fold into the cache key.
				keyParams: {
					maxResults: resolvedSearchConfig.maxResults,
					minScore: normalized.minScore ?? 0.1,
					...(normalized.timeRange ? { timeRange: normalized.timeRange } : {}),
				},
			})
			if (cacheResult.hit) {
				this.host.setLastSearchMode(`v2:cache:${cacheResult.tier}`, {
					pathUsed: cacheResult.pathUsed,
					sourceScope: cacheResult.sourceScope,
				})
				const filteredCache = applyHardConstraintRejections({
					results: cacheResult.results,
					request: executorRequest,
					...(executorTimeRange ? { timeRange: executorTimeRange } : {}),
				})
				if (filteredCache.accepted.length === cacheResult.results.length) {
					const classification = classifyExecutorSearch(executorRequest)
					const cachedPaths = cacheResult.pathUsed
						? cacheResult.pathUsed.split(",").filter(Boolean)
						: []
					const plannedPasses = buildExecutorPasses(
						executorRequest,
						classification,
					).map((pass, index) => ({
						pass: pass.pass,
						query: pass.query,
						reason: index === 0 ? `${pass.reason} (cache hit)` : pass.reason,
						pathsExecuted: index === 0 ? cachedPaths : [],
						resultCount: index === 0 ? filteredCache.accepted.length : 0,
						queryRewritten: false,
						reranked: false,
					}))
					const trustedCacheResults = annotateResultsWithTrust(
						filteredCache.accepted,
						{
							scope: searchScope,
							scopeRef: searchScopeRef,
							sessionKey: normalized.conversationScope?.sessionKey,
						},
					)
					return {
						results: trustedCacheResults,
						metadata: {
							...emptySearchMetadata(normalized),
							classification,
							resolvedSearchConfig,
							passes: plannedPasses,
							queriesTried: plannedPasses.map((pass) => pass.query),
							constraintsApplied: [
								...buildConstraintSummaries(executorRequest),
								...(requestHasHardConstraints(normalized)
									? ["cache-hit-constrained"]
									: []),
							],
							evidenceCoverage: computeEvidenceCoverage(trustedCacheResults),
							pathsExecuted: cachedPaths,
							trustSummary: summarizeTrust(trustedCacheResults),
						},
					}
				}
			}
		}

		const searchStart = Date.now()
		const response = await executeMongoSearchPlan({
			request: normalized,
			availablePaths,
			executePass: async ({
				query: passQuery,
				availablePaths: passPaths,
				timeRange,
			}) =>
				searchV2(this.host.db, this.host.prefix, passQuery, this.host.agentId, {
					availablePaths: passPaths,
					hasEpisodes: mongoCfg.episodes.enabled,
					hasGraphData: mongoCfg.graph.enabled,
					maxResults: resolvedSearchConfig.maxResults,
					searchOptions: {
						minScore: normalized.minScore ?? 0.1,
						sessionKey: normalized.conversationScope?.sessionKey,
						numCandidates: resolvedSearchConfig.numCandidates,
						capabilities: this.host.capabilities,
						fusionMethod: resolvedSearchConfig.fusionMethod,
						embeddingMode: mongoCfg.embeddingMode,
						graphMaxDepth: mongoCfg.graph.maxGraphDepth,
						conversationFilter: this.host.buildConversationChunkFilter({
							scope: searchScope,
							scopeRef: searchScopeRef,
						}),
						bridgeFilter: this.host.buildScopeAwareBridgeChunkFilter(
							activeSources,
							{
								scope: searchScope,
								scopeRef: searchScopeRef,
							},
						),
						bridgeMaxResults: this.host.getBridgeChunkBudget(
							resolvedSearchConfig.maxResults,
						),
						scope: searchScope,
						scopeRef: searchScopeRef,
						allowHybridBackstop: resolvedSearchConfig.allowHybridBackstop,
						sourcePreference: normalized.sourcePreference,
						needExactEvidence: normalized.needExactEvidence,
						timeRange: normalized.timeRange,
						conversationScope: normalized.conversationScope,
						structuredScope: normalized.structuredScope,
						referenceScope: normalized.referenceScope,
						proceduralScope: normalized.proceduralScope,
						rerankConfig: mongoCfg.reranking,
						queryRewriteConfig: mongoCfg.queryRewriting,
						searchConfig: resolvedSearchConfig,
						budget: mongoCfg.searchBudget,
					},
				}),
			trustContext: {
				scope: searchScope,
				scopeRef: searchScopeRef,
			},
		})
		response.metadata.resolvedSearchConfig = resolvedSearchConfig

		emitTelemetry(this.host.db, this.host.prefix, {
			meta: { agentId: this.host.agentId, operation: "search" },
			durationMs: Date.now() - searchStart,
			ok: response.results.length > 0,
			pathUsed: response.metadata.pathsExecuted.join(","),
			resultCount: response.results.length,
			topScore: response.results[0]?.score ?? 0,
			fusionMethod: resolvedSearchConfig.fusionMethod,
		})
		const latencyMs = Date.now() - searchStart
		void recordRecallTrace({
			db: this.host.db,
			prefix: this.host.prefix,
			trace: {
				agentId: this.host.agentId,
				query: normalized.query,
				lanesUsed: response.metadata.pathsExecuted,
				lanesSkipped: Array.from(availablePaths).filter(
					(path) => !response.metadata.pathsExecuted.includes(path),
				),
				totalHits: response.results.length,
				latencyMs,
				hitsByLane: response.metadata.resultsByPath,
				topHitIds: response.results
					.map((result) => result.canonicalId ?? result.path)
					.slice(0, 5),
			},
		}).catch((err) =>
			log.warn(`searchDetailed recall trace write failed: ${String(err)}`),
		)

		const v2Details = {
			classification: response.metadata.classification,
			sourceOrder: response.metadata.sourceOrder,
			resolvedSearchConfig: response.metadata.resolvedSearchConfig,
			constraintsApplied: response.metadata.constraintsApplied,
			pathsExecuted: response.metadata.pathsExecuted,
			resultsByPath: response.metadata.resultsByPath,
			evidenceCoverage: response.metadata.evidenceCoverage,
		}

		if (response.results.length > 0) {
			this.host.setLastSearchMode("v2", v2Details)
			this.host.recordSearchAccess(response.results)
			if (canUseDetailedSearchCache) {
				const hasKbPath = response.metadata.pathsExecuted.includes("kb")
				const ttlSec = hasKbPath
					? mongoCfg.cache.kbTtlSec
					: mongoCfg.cache.conversationTtlSec
				writeCache({
					db: this.host.db,
					prefix: this.host.prefix,
					query: normalized.query,
					agentId: this.host.agentId,
					scope: searchScope,
					scopeRef: searchScopeRef,
					results: response.results,
					pathUsed: response.metadata.pathsExecuted.join(","),
					sourceScope: "conversation",
					ttlSec,
					// P2.4: same resolved params as the checkCache seam above.
					keyParams: {
						maxResults: resolvedSearchConfig.maxResults,
						minScore: normalized.minScore ?? 0.1,
						...(normalized.timeRange
							? { timeRange: normalized.timeRange }
							: {}),
					},
				})
			}
			return response
		}

		if (requestHasHardConstraints(normalized)) {
			this.host.setLastSearchMode("v2:constrained-empty", v2Details)
			return response
		}

		// P3.2: legacySearch re-run is opt-in (see the search() sites).
		if (!mongoCfg.legacySearchFallback) {
			this.host.setLastSearchMode("v2:empty", v2Details)
			return response
		}
		const fallbackResults = await this.host.legacySearch(normalized.query, {
			maxResults: normalized.maxResults,
			minScore: normalized.minScore,
			sessionKey: normalized.conversationScope?.sessionKey,
			scope: searchScope,
			scopeRef: searchScopeRef,
		})
		this.host.setLastSearchMode("v2->legacy-empty", {
			...v2Details,
			fallbackResults: fallbackResults.length,
		})
		return {
			results: fallbackResults,
			metadata: {
				...response.metadata,
				pathsExecuted: response.metadata.pathsExecuted.length
					? response.metadata.pathsExecuted
					: ["legacy"],
			},
		}
	}

	async searchKB(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			scopeRef?: string
			filter?: { tags?: string[]; category?: string; source?: string }
			/** Per-call override; defaults to the resolved config fusionMethod. */
			fusionMethod?: MemoryMongoDBFusionMethod
		},
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			return []
		}

		const mongoCfg = this.host.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 5)
		const minScore = opts?.minScore ?? 0.1

		// Direct KB search uses MongoDB query-time automatic embeddings.
		const queryVector: number[] | null = null

		return searchKB(
			kbChunksCollection(this.host.db, this.host.prefix),
			cleaned,
			queryVector,
			{
				maxResults,
				minScore,
				// Tenant isolation: search the caller's authorized scopeRef when
				// provided; otherwise fall back to this agent's default scopeRef.
				scopeRef: opts?.scopeRef ?? this.host.agentScopeRef,
				filter: opts?.filter,
				numCandidates: mongoCfg.numCandidates,
				vectorIndexName: `${this.host.prefix}kb_chunks_vector`,
				textIndexName: `${this.host.prefix}kb_chunks_text`,
				capabilities: this.host.capabilities,
				embeddingMode: mongoCfg.embeddingMode,
				// P0.10: KB fusion is a first-class option — per-call override,
				// else the resolved config value (env/config, default rankFusion).
				fusionMethod: opts?.fusionMethod ?? mongoCfg.fusionMethod,
				kbDocs: kbCollection(this.host.db, this.host.prefix),
			},
		)
	}

	detectSearchMethod(mongoCfg: ResolvedMongoDBConfig): SearchMethod {
		// Best guess from configuration alone. Only correct when mongoSearch
		// actually took the path its capabilities allow — prefer
		// resolveObservedSearchMethod, which uses the trace of what ran.
		const canVector =
			mongoCfg.embeddingMode === "automated" &&
			this.host.capabilities.vectorSearch

		if (canVector && this.host.capabilities.textSearch) {
			return "hybrid"
		}
		if (canVector) {
			return "vector"
		}
		// Text-only or $text fallback
		return "text"
	}

	/**
	 * Resolve which search method actually produced these results, from the
	 * trace mongoSearch emits, falling back to the configuration guess only
	 * when nothing succeeded.
	 *
	 * This picks the normalizer, so guessing wrong corrupts ranking rather than
	 * just mislabeling. mongoSearch degrades through hybrid → vector → keyword
	 * → $text, and the last two return raw BM25/textScore values on an
	 * unbounded scale. Calling those "hybrid" sends them to the [0,1] clamp,
	 * which pins every lexical hit above ~1 to exactly 1.0 — sorting degraded
	 * results above genuine cosine hits from the KB and structured lanes, whose
	 * scores are normalized honestly. normalizeBM25Score exists precisely for
	 * this case; it was simply never reached.
	 */
	resolveObservedSearchMethod(
		traceEvents: SearchTraceEvent[],
		mongoCfg: ResolvedMongoDBConfig,
	): SearchMethod {
		const succeeded = [...traceEvents].toReversed().find((event) => event.ok)
		switch (succeeded?.method) {
			case "scoreFusion":
			case "rankFusion":
			case "js-merge":
				return "hybrid"
			case "vector":
				return "vector"
			case "keyword":
			case "$text":
				return "text"
			default:
				return this.host.detectSearchMethod(mongoCfg)
		}
	}
}
