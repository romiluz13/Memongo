import { settledFailureMeta } from "./query-diagnostics.js"
import type { Document } from "mongodb"
import type { MemoryMongoDBFusionMethod, MemoryScope } from "@memongo/lib"
import {
	captureAdmissionToken,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import { accessTargetFromSearchResult } from "./mongodb-access-tracker.js"
import { resolveDefaultScope } from "./backend-config.js"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import type { OperationRunContext } from "./mongodb-operation-accounting.js"
import { normalizeSearchResults } from "./mongodb-hybrid.js"
import type { SearchMethod } from "./mongodb-hybrid.js"
import { searchKB } from "./mongodb-kb-search.js"
import {
	resolveSearchBudgetLimits,
	runWithSearchBudget,
} from "./mongodb-search-budget.js"
import { tryConsumeSearchAdmission } from "./mongodb-search-admission.js"
import { recordRecallTrace } from "./mongodb-recall-traces.js"
import type { RelevanceArtifact } from "./mongodb-relevance.js"
import { resolveSessionEvidenceMode } from "./mongodb-session-evidence.js"
import { resolveUserfactEvidenceMode } from "./mongodb-userfact-evidence.js"
import { resolveEnrichmentMode } from "./mongodb-llm-enrichment.js"
import { recordEmbeddingSpend } from "./mongodb-cost-ledger.js"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import {
	kbCollection,
	chunksCollection,
	kbChunksCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { resolveScopeIdentity } from "./mongodb-scope.js"
import { buildUnexpiredClause, mergeQueryClauses } from "./mongodb-temporal.js"
import { mongoSearch } from "./mongodb-search.js"
import type {
	SearchExplainOptions,
	SearchExplainTraceArtifact,
	SearchTraceEvent,
} from "./mongodb-search.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import {
	buildConstraintSummaries,
	executeMongoSearchPlan,
	normalizeMemorySearchRequest,
	requestHasHardConstraints,
} from "./mongodb-search-executor.js"
import type {
	MemorySearchRequest,
	MemorySearchResponse,
	MemorySearchDegradation,
	MemorySearchResult,
	SearchLaneOutcome,
} from "./types.js"
import {
	clampSearchMaxResults,
	clampSearchQuery,
	deduplicateSearchResults,
	emptySearchMetadata,
	getActiveSources,
	isBenchmarkStrictMode,
	MAX_SEARCH_QUERY_LENGTH,
	normalizeDetailedSearchRequest,
	rerankResults,
	resolveRuntimeSearchConfig,
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
	 * WS-16 (C-030): fire-and-forget telemetry when a public search entry
	 * point clamped an over-length query, so operators can see callers
	 * pushing past the 2,000-character ceiling instead of silently
	 * truncating their intent.
	 */
	private emitQueryClampedTelemetry(
		originalLength: number,
		readAdmission: AdmissionToken,
	): void {
		void emitTelemetry(
			this.host.db,
			this.host.prefix,
			{
				meta: {
					agentId: this.host.agentId,
					operation: "search-query-clamped",
				},
				durationMs: 0,
				ok: true,
				queryLength: originalLength,
			},
			{ admission: readAdmission },
		).catch(() => {
			log.warn("search telemetry emit failed")
		})
	}

	/**
	 * Resolve the tenant identity a read must be confined to.
	 *
	 * Every read path resolves identity through here so that an absent `scope`
	 * can never degrade into "all scopes" — the filter builders below take
	 * `scope`/`scopeRef` as required arguments, and this is the only sanctioned
	 * way to produce them.
	 *
	 * P2.3: reads share the canonical identity rule with writes (explicit
	 * scope wins; sessionKey implies "session"); D1/B3: the fallback is the
	 * unified MEMONGO_DEFAULT_SCOPE (legacy MEMONGO_SEARCH_DEFAULT_SCOPE
	 * remains a read alias for one deprecation window).
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
			defaultScope: resolveDefaultScope({
				value: process.env.MEMONGO_DEFAULT_SCOPE,
				legacyValue: process.env.MEMONGO_SEARCH_DEFAULT_SCOPE,
				applyTo: "read",
				warn: (message) => log.warn(message),
			}),
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
		// C-005: hide expired chunks immediately. The chunks TTL index
		// (idx_chunks_ttl_expires_at) only sweeps about every 60s, so an
		// expired chunk can still surface in reads until the sweep deletes
		// it — every surface fed by this filter composes the unexpired
		// clause, mirroring the events read guard (buildUnexpiredClause on
		// expiresAt). The $exists:false branch keeps the clause
		// semantics-neutral for chunks written without an expiry.
		return mergeQueryClauses(
			{
				source: { $in: sources },
				agentId: this.host.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				status: { $ne: "deleted" },
			},
			buildUnexpiredClause({ field: "expiresAt" }),
		)
	}

	buildBridgeChunkFilter(): Document {
		// C-005: same unexpired guard as buildConversationChunkFilter — the
		// bridge lane reads the same chunks collection, so an expired chunk
		// (TTL sweep lagging up to ~60s) must not surface there either.
		return mergeQueryClauses(
			{
				source: { $in: ["conversation", "memory"] },
				agentId: this.host.agentId,
				scope: "workspace",
				scopeRef: this.host.workspaceScopeRef,
				status: { $ne: "deleted" },
			},
			buildUnexpiredClause({ field: "expiresAt" }),
		)
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
	 * Maps canonicalId + result scope fields to the full access identity
	 * (W01): every canonical update must target the owning tenant/scope row,
	 * and results without a usable identity are recorded nowhere rather than
	 * guessed at.
	 */
	recordSearchAccess(
		results: MemorySearchResult[],
		admission?: AdmissionToken,
	): void {
		if (!this.host.accessTracker || results.length === 0) return
		for (const result of results) {
			const target = accessTargetFromSearchResult(result)
			if (target) {
				this.host.accessTracker.recordAccess(target, admission)
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
			kbRestricted?: boolean
		},
		priorAdmission?: AdmissionToken,
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			return []
		}

		const readAdmission =
			priorAdmission ??
			(await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			}))

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
			mongoCfg.kb.enabled && opts?.kbRestricted !== true,
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
							queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
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
							queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
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
							queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
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
							queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
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
					admission: readAdmission,
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

		this.host.recordSearchAccess(finalResults, readAdmission)
		return finalResults
	}

	/**
	 * RET-15: the V2 pipeline's actual verdict now feeds the relevance
	 * runtime. Called only where the V2 outcome is the answer the caller
	 * receives — the success return, and the empty/error outcomes returned
	 * without an opt-in legacy re-run. Throttled denials are excluded
	 * (WS-11: a throttle is not a retrieval verdict), and the legacy
	 * fallback re-run records its own signal at its own seam.
	 *
	 * The sampled run carries the V2 decision surface — plan, constraints,
	 * per-path execution and latency, rerank/rewrite flags — so a sampled
	 * run diagnoses the pipeline that actually answered, not the legacy
	 * approximation `relevanceExplain` used to run.
	 *
	 * `metadata` is deliberately structural: `V2SearchMetadata` (whose
	 * `plan.constraints` is an object) and the `MemorySearchResponse`
	 * metadata projection (whose `plan` lacks constraints and may be
	 * absent) both satisfy it, and the error seam passes no metadata at
	 * all — the summary then records the error outcome alone.
	 */
	recordV2RelevanceVerdict(params: {
		admission: AdmissionToken
		query: string
		results: MemorySearchResult[]
		metadata?: {
			plan?: {
				paths: string[]
				confidence: string
				reasoning?: string
				constraints?: unknown
			}
			pathsExecuted: string[]
			resultsByPath: Record<string, number>
			laneOutcomes?: SearchLaneOutcome[]
			latencyByPath?: Record<string, number>
			reranked?: boolean
			queryRewritten?: boolean
		}
		latencyMs: number
		maxResults: number
	}): void {
		const relevance = this.host.relevance
		if (!relevance) {
			return
		}
		// Mirror of the legacy seam: the sampling decision precedes the
		// signal (recordSignal recomputes the rate), and health is judged on
		// the V2 answer itself — the fusion fallbackPath concept does not
		// apply to the planner pipeline.
		const sampled = relevance.shouldSample()
		const health = relevance.evaluateHealth(params.results)
		relevance.recordSignal(params.results)
		if (!sampled) {
			return
		}
		void relevance
			.persistRun({
				admission: params.admission,
				query: params.query,
				sourceScope: "all",
				latencyMs: params.latencyMs,
				topK: params.maxResults,
				hitSources: Array.from(
					new Set(params.results.map((result) => result.source)),
				),
				status: health,
				sampled,
				sampleRate: relevance.getSampleState().current,
				artifacts: [
					{
						artifactType: "trace",
						summary: {
							pipeline: "v2",
							...(params.metadata
								? {
										plan: params.metadata.plan?.paths ?? [],
										planConfidence: params.metadata.plan?.confidence,
										planConstraintCount: params.metadata.plan?.constraints
											? Object.keys(
													params.metadata.plan.constraints as Record<
														string,
														unknown
													>,
												).length
											: 0,
										pathsExecuted: params.metadata.pathsExecuted,
										resultsByPath: params.metadata.resultsByPath,
										...(params.metadata.laneOutcomes
											? { laneOutcomes: params.metadata.laneOutcomes }
											: {}),
										...(params.metadata.latencyByPath
											? { latencyByPath: params.metadata.latencyByPath }
											: {}),
										reranked: Boolean(params.metadata.reranked),
										queryRewritten: Boolean(params.metadata.queryRewritten),
									}
								: {
										outcome: "error",
									}),
							topScore: params.results[0]?.score ?? 0,
							resultCount: params.results.length,
						},
					},
				],
				diagnosticMode: false,
			})
			.catch((err) => {
				relevance.logTelemetryFailure(err)
			})
	}

	async search(
		query: string,
		opts?: {
			maxResults?: number
			minScore?: number
			sessionKey?: string
			scope?: MemoryScope
			scopeRef?: string
			kbRestricted?: boolean
			questionDate?: Date
			/**
			 * #66: receives the per-lane latency breakdown of this call. A sink
			 * rather than instance state so concurrent searches (#67 scenario
			 * runner) cannot cross-attribute each other's lane timings.
			 */
			onLaneLatency?: (latencyByLane: Record<string, number>) => void
			/**
			 * WS-12 (C-019): receives the degradation marker when admission
			 * control degraded this answer (denied query, denied legacy
			 * re-run, or skipped KB vector lane). Same sink-not-state pattern
			 * as onLaneLatency so concurrent searches cannot cross-attribute;
			 * fires at most once, before the results return. A healthy search
			 * never fires it — absence means the answer is authoritative.
			 */
			onDegradation?: (degradation: MemorySearchDegradation) => void
		},
		operationRunContext?: OperationRunContext,
	): Promise<MemorySearchResult[]> {
		const trimmed = query.trim()
		// WS-16 (C-030): clamp before the hot path consumes the query —
		// autoEmbed, BM25, and rerank all see the bounded query.
		const cleaned = clampSearchQuery(trimmed)
		if (!cleaned) {
			this.host.setLastSearchMode("v2:empty-query")
			return []
		}

		const readAdmission = await captureAdmissionToken({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})
		if (cleaned.length < trimmed.length) {
			this.emitQueryClampedTelemetry(trimmed.length, readAdmission)
		}

		const mongoCfg = this.host.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 10)
		const minScore = opts?.minScore ?? mongoCfg.reranking?.minScore ?? 0.01
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled && opts?.kbRestricted !== true,
		)
		const availablePaths = this.host.buildV2AvailablePaths(activeSources)

		// D1/B3: explicit scope wins; sessionKey implies "session"; otherwise
		// the unified MEMONGO_DEFAULT_SCOPE fallback applies (the legacy
		// MEMONGO_SEARCH_DEFAULT_SCOPE remains a read alias). Same rule the
		// write path applies.
		const { scope: searchScope, scopeRef: searchScopeRef } =
			this.host.resolveSearchIdentity({
				scope: opts?.scope,
				scopeRef: opts?.scopeRef,
				sessionKey: opts?.sessionKey,
			})

		// Every public invocation owns a distinct live retrieval execution.
		// This preserves caller-specific session and lifecycle boundaries.
		return this.host.executeSearchUncoalesced({
			cleaned,
			opts,
			mongoCfg,
			maxResults,
			minScore,
			activeSources,
			availablePaths,
			searchScope,
			searchScopeRef,
			operationRunContext,
			readAdmission,
		})
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
		operationRunContext?: OperationRunContext
		readAdmission?: AdmissionToken
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
			operationRunContext,
			readAdmission: priorAdmission,
		} = params

		const readAdmission =
			priorAdmission ??
			(await captureAdmissionToken({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
			}))

		// #66: measurement only — cost of the phases of this call that sit
		// outside searchV2's lanes. Merged into the lane breakdown before it
		// reaches the caller's sink.
		const phaseLatency: Record<string, number> = {}

		const searchStart = Date.now()
		let laneLatency: Record<string, number> = {}
		try {
			const v2 = await searchV2(
				this.host.db,
				this.host.prefix,
				cleaned,
				this.host.agentId,
				{
					admission: readAdmission,
					availablePaths,
					hasEpisodes: mongoCfg.episodes.enabled,
					hasGraphData: mongoCfg.graph.enabled,
					maxResults,
					// C-016: re-poll index readiness when a lane fails at query
					// time so status reflects the outage.
					onPathFailure: (path, error) =>
						this.host.noteSearchLaneFailure(path, error),
					searchOptions: {
						minScore,
						sessionKey: opts?.sessionKey,
						numCandidates: mongoCfg.numCandidates,
						capabilities: this.host.capabilities,
						fusionMethod: mongoCfg.fusionMethod,
						embeddingMode: mongoCfg.embeddingMode,
						queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
						conversationEvidenceMode: mongoCfg.conversationEvidenceMode,
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
						...(operationRunContext ? { operationRunContext } : {}),
					},
				},
			)

			// Emit search telemetry (fire-and-forget). WS-11: a throttled
			// request already emitted its distinct throttled:true doc inside
			// searchV2 — a second ok:false "search" doc here would blur
			// "overloaded" back into "ran and found nothing", the exact
			// confusion the throttle marker exists to prevent.
			if (!v2.metadata.throttled) {
				void emitTelemetry(
					this.host.db,
					this.host.prefix,
					{
						meta: { agentId: this.host.agentId, operation: "search" },
						durationMs: Date.now() - searchStart,
						ok: v2.results.length > 0,
						pathUsed: v2.metadata.pathsExecuted.join(","),
						resultCount: v2.results.length,
						topScore: v2.results[0]?.score ?? 0,
						fusionMethod: mongoCfg.fusionMethod,
					},
					{ admission: readAdmission },
				).catch(() => {
					log.warn("search telemetry emit failed")
				})
			}
			// C-017: bill query-time server-side embeds from the search budget
			// snapshot — one fire-and-forget ledger increment per request
			// (zero when the budget was untouched).
			void recordEmbeddingSpend(
				this.host.db,
				this.host.prefix,
				this.host.agentId,
				"search",
				v2.metadata.budget?.embeds ?? 0,
				{ admission: readAdmission },
			).catch(() => {
				log.warn("search cost ledger recording failed")
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
					admission: readAdmission,
					db: this.host.db,
					prefix: this.host.prefix,
					privacyMode: mongoCfg.relevance.telemetry.queryPrivacyMode,
					trace: {
						agentId: this.host.agentId,
						scope: searchScope,
						scopeRef: searchScopeRef,
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
					log.warn("search recall trace write failed", settledFailureMeta(err)),
				)
				this.host.recordSearchAccess(v2.results, readAdmission)
				// RET-15: the returned V2 answer feeds the relevance runtime.
				this.recordV2RelevanceVerdict({
					admission: readAdmission,
					query: cleaned,
					results: v2.results,
					metadata: v2.metadata,
					latencyMs,
					maxResults,
				})
				return v2.results
			}

			// WS-11 change 2: a throttled response is NOT a retrieval verdict.
			// No recall trace (nothing was retrieved), no benchmark-strict throw
			// (the corpus is not at fault), no legacy re-run (it would pay for
			// a second admission token and blur the throttle outcome). The
			// empty results carry the throttle marker in metadata; WS-12
			// reports it upstream as throttling, never as "no memories".
			if (v2.metadata.throttled) {
				this.host.setLastSearchMode("v2:throttled", {
					...v2Details,
					throttled: v2.metadata.throttled,
				})
				// WS-12 (C-019): the array return cannot carry the marker, so
				// the sink does — "throttled" rides to the caller, the API
				// boundary, and the agent instead of dying as {results: []}.
				opts?.onDegradation?.({
					kind: "throttled",
					scope: "denied",
					retryAfterMs: v2.metadata.throttled.retryAfterMs,
				})
				return []
			}

			void recordRecallTrace({
				admission: readAdmission,
				db: this.host.db,
				prefix: this.host.prefix,
				privacyMode: mongoCfg.relevance.telemetry.queryPrivacyMode,
				trace: {
					agentId: this.host.agentId,
					scope: searchScope,
					scopeRef: searchScopeRef,
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
				log.warn(
					"empty search recall trace write failed",
					settledFailureMeta(err),
				),
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
				// RET-15: the empty verdict the caller receives is the signal.
				this.recordV2RelevanceVerdict({
					admission: readAdmission,
					query: cleaned,
					results: [],
					metadata: v2.metadata,
					latencyMs,
					maxResults,
				})
				return []
			}
			// WS-11: the legacy re-run burns another server-side autoEmbed
			// input outside the v2 lanes, so it pays its own admission token.
			// A dry bucket leaves the v2 empty answer standing — re-running
			// into the same denial would blur the throttle outcome.
			const legacyAdmission = tryConsumeSearchAdmission()
			if (!legacyAdmission.ok) {
				this.host.setLastSearchMode("v2:empty->legacy-throttled", {
					...v2Details,
					retryAfterMs: legacyAdmission.retryAfterMs,
				})
				// WS-12 (C-019): the v2 empty verdict IS authoritative (it did
				// search), but the configured double-check did not happen —
				// the sink says which, so "unverified empty" never masquerades
				// as fully-verified emptiness.
				opts?.onDegradation?.({
					kind: "throttled",
					scope: "legacy-fallback-skipped",
					retryAfterMs: legacyAdmission.retryAfterMs,
				})
				// RET-15: the v2 empty verdict stands (only the opt-in
				// double-check was denied) — it is still the served answer.
				this.recordV2RelevanceVerdict({
					admission: readAdmission,
					query: cleaned,
					results: [],
					metadata: v2.metadata,
					latencyMs,
					maxResults,
				})
				return []
			}
			const fallbackResults = await this.host.legacySearch(
				cleaned,
				opts,
				readAdmission,
			)
			this.host.setLastSearchMode("v2->legacy-empty", {
				...v2Details,
				fallbackResults: fallbackResults.length,
			})
			void recordRecallTrace({
				admission: readAdmission,
				db: this.host.db,
				prefix: this.host.prefix,
				privacyMode: mongoCfg.relevance.telemetry.queryPrivacyMode,
				trace: {
					agentId: this.host.agentId,
					scope: searchScope,
					scopeRef: searchScopeRef,
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
				log.warn(
					"search fallback recall trace write failed",
					settledFailureMeta(err),
				),
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
				// RET-15: the error-empty answer is a served verdict — no
				// metadata survived the throw, so the sampled run records
				// the error outcome alone.
				this.recordV2RelevanceVerdict({
					admission: readAdmission,
					query: cleaned,
					results: [],
					latencyMs: Date.now() - searchStart,
					maxResults,
				})
				return []
			}
			const fallbackResults = await this.host.legacySearch(
				cleaned,
				opts,
				readAdmission,
			)
			this.host.setLastSearchMode("v2->legacy-error", {
				error: message,
				fallbackResults: fallbackResults.length,
			})
			void recordRecallTrace({
				admission: readAdmission,
				db: this.host.db,
				prefix: this.host.prefix,
				privacyMode: mongoCfg.relevance.telemetry.queryPrivacyMode,
				trace: {
					agentId: this.host.agentId,
					scope: searchScope,
					scopeRef: searchScopeRef,
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
					"search error fallback recall trace write failed",
					settledFailureMeta(traceErr),
				),
			)
			return fallbackResults
		} finally {
			// #66: `phase:total` is anchored on searchStart, so every span
			// subtracted here sits inside it.
			phaseLatency["phase:total"] = Date.now() - searchStart
			const measuredInsideTotal = [
				"phase:plan",
				"phase:lanes",
				"phase:rewrite",
				"phase:result-normalization",
				"phase:heuristic-rerank",
				"phase:post-retrieval-scoring",
				"phase:conversation-evidence",
				"phase:temporal-coverage",
				"phase:temporal-candidate-merge",
				"phase:turn-precision",
				"phase:precision-merge",
				"phase:lane-controls-pre-rerank",
				"phase:rerank-input",
				"phase:rerank",
				"phase:lane-controls-post-rerank",
				"phase:final-normalize",
				"phase:projection",
			].reduce((total, phase) => total + (laneLatency[phase] ?? 0), 0)
			phaseLatency["phase:unaccounted"] = Math.max(
				0,
				phaseLatency["phase:total"] - measuredInsideTotal,
			)
			opts?.onLaneLatency?.({ ...laneLatency, ...phaseLatency })
		}
	}

	async searchDetailed(
		request: MemorySearchRequest,
		operationRunContext?: OperationRunContext,
	): Promise<MemorySearchResponse> {
		const normalized = normalizeDetailedSearchRequest(request)
		// WS-16 (C-030): the clamp happened inside normalize — emit the
		// telemetry marker here, where the host db/prefix are in reach, so
		// the over-length caller is visible to operators.
		if (!normalized.query) {
			this.host.setLastSearchMode("v2:empty-query")
			return {
				results: [],
				metadata: emptySearchMetadata(normalized),
			}
		}

		const readAdmission = await captureAdmissionToken({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})
		if (request.query.trim().length > MAX_SEARCH_QUERY_LENGTH) {
			this.emitQueryClampedTelemetry(request.query.trim().length, readAdmission)
		}

		const mongoCfg = this.host.config.mongodb!
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled && normalized.kbRestricted !== true,
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
		const resolvedSearchConfig = resolveRuntimeSearchConfig(
			executorRequest,
			mongoCfg,
		)

		// RET-16: searchDetailed owns the REQUEST boundary. One admission
		// token covers the whole multi-pass request — every per-pass
		// searchV2 below runs inside the request budget and therefore takes
		// its budget-share branch, which
		// skips the per-pass admission charge; before this seam a 3-pass
		// search paid 3 tokens and opened 3 fresh budgets. The opt-in legacy
		// re-run keeps its own token (below).
		const admission = tryConsumeSearchAdmission()
		if (!admission.ok) {
			void emitTelemetry(
				this.host.db,
				this.host.prefix,
				{
					meta: { agentId: this.host.agentId, operation: "search" },
					durationMs: 0,
					ok: false,
					throttled: true,
					resultCount: 0,
				},
				{ admission: readAdmission },
			).catch(() => {
				log.warn("search telemetry emit failed")
			})
			this.host.setLastSearchMode("v2:throttled", {
				resolvedSearchConfig,
				constraintsApplied: buildConstraintSummaries(executorRequest),
				pathsExecuted: [],
				resultsByPath: {},
				evidenceCoverage: "none",
				throttled: { retryAfterMs: admission.retryAfterMs },
			})
			return {
				results: [],
				metadata: {
					...emptySearchMetadata(normalized),
					throttled: { retryAfterMs: admission.retryAfterMs },
				},
			}
		}

		const searchStart = Date.now()
		const executeRequest = async () =>
			executeMongoSearchPlan({
				request: normalized,
				availablePaths,
				executePass: async ({
					query: passQuery,
					availablePaths: passPaths,
					timeRange,
				}) =>
					searchV2(
						this.host.db,
						this.host.prefix,
						passQuery,
						this.host.agentId,
						{
							admission: readAdmission,
							availablePaths: passPaths,
							hasEpisodes: mongoCfg.episodes.enabled,
							hasGraphData: mongoCfg.graph.enabled,
							maxResults: resolvedSearchConfig.maxResults,
							// C-016: re-poll index readiness when a lane fails at query
							// time so status reflects the outage.
							onPathFailure: (path, error) =>
								this.host.noteSearchLaneFailure(path, error),
							searchOptions: {
								minScore: normalized.minScore ?? 0.1,
								sessionKey: normalized.conversationScope?.sessionKey,
								numCandidates: resolvedSearchConfig.numCandidates,
								capabilities: this.host.capabilities,
								fusionMethod: resolvedSearchConfig.fusionMethod,
								embeddingMode: mongoCfg.embeddingMode,
								queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
								conversationEvidenceMode: mongoCfg.conversationEvidenceMode,
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
								// RET-02 (wave 3b): forward the PASS-level resolved range
								// (original constraints on the first pass, the widened
								// corrective window on follow-ups) as first-class V2
								// input so it reaches lane selection instead of being
								// dropped at this seam. The executor's re-validation
								// against the ORIGINAL constraints (wave 3a) remains
								// the final authority.
								...(timeRange ? { resolvedTimeRange: timeRange } : {}),
								conversationScope: normalized.conversationScope,
								structuredScope: normalized.structuredScope,
								referenceScope: normalized.referenceScope,
								proceduralScope: normalized.proceduralScope,
								rerankConfig: mongoCfg.reranking,
								queryRewriteConfig: mongoCfg.queryRewriting,
								searchConfig: resolvedSearchConfig,
								budget: mongoCfg.searchBudget,
								// RET-16: one run context threads through EVERY pass so
								// provider operations (rerank, enrichment) account
								// against one request ledger when a diagnostic caller
								// supplied one.
								...(operationRunContext ? { operationRunContext } : {}),
							},
						},
					),
				trustContext: {
					scope: searchScope,
					scopeRef: searchScopeRef,
				},
			})
		// RET-16: ONE budget spans every pass — each per-pass searchV2
		// detects the active budget (share branch in mongodb-search-v2.ts)
		// and consumes from this request ledger instead of opening a fresh
		// one, so the configured caps bound the REQUEST, not each pass. A
		// opt-in legacy re-run stays outside it and pays its own admission
		// token below.
		const { value: response, budget: requestBudget } =
			await runWithSearchBudget(
				resolveSearchBudgetLimits(mongoCfg.searchBudget),
				executeRequest,
			)
		response.metadata.resolvedSearchConfig = resolvedSearchConfig
		// RET-16: the request-level snapshot (limits + consumed totals
		// across ALL passes) rides on the response metadata.
		response.metadata.budget = requestBudget

		// WS-11: a throttled detailed search is not a retrieval verdict. The
		// denied pass already emitted its own throttle telemetry, the recall
		// trace has nothing to record (no lanes ran), and a legacy re-run
		// would pay a second admission token and blur the outcome — same
		// policy as the search() throttle branch below.
		if (response.metadata.throttled) {
			this.host.setLastSearchMode("v2:throttled", {
				classification: response.metadata.classification,
				sourceOrder: response.metadata.sourceOrder,
				resolvedSearchConfig: response.metadata.resolvedSearchConfig,
				constraintsApplied: response.metadata.constraintsApplied,
				pathsExecuted: response.metadata.pathsExecuted,
				resultsByPath: response.metadata.resultsByPath,
				evidenceCoverage: response.metadata.evidenceCoverage,
				throttled: response.metadata.throttled,
			})
			return response
		}

		void emitTelemetry(
			this.host.db,
			this.host.prefix,
			{
				meta: { agentId: this.host.agentId, operation: "search" },
				durationMs: Date.now() - searchStart,
				ok: response.results.length > 0,
				pathUsed: response.metadata.pathsExecuted.join(","),
				resultCount: response.results.length,
				topScore: response.results[0]?.score ?? 0,
				fusionMethod: resolvedSearchConfig.fusionMethod,
			},
			{ admission: readAdmission },
		).catch(() => {
			log.warn("search telemetry emit failed")
		})
		const latencyMs = Date.now() - searchStart
		void recordRecallTrace({
			admission: readAdmission,
			db: this.host.db,
			prefix: this.host.prefix,
			privacyMode: mongoCfg.relevance.telemetry.queryPrivacyMode,
			trace: {
				agentId: this.host.agentId,
				scope: searchScope,
				scopeRef: searchScopeRef,
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
			log.warn(
				"searchDetailed recall trace write failed",
				settledFailureMeta(err),
			),
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
			this.host.recordSearchAccess(response.results, readAdmission)
			// RET-15: the returned V2 answer feeds the relevance runtime.
			this.recordV2RelevanceVerdict({
				admission: readAdmission,
				query: normalized.query,
				results: response.results,
				metadata: response.metadata,
				latencyMs,
				maxResults: resolvedSearchConfig.maxResults,
			})
			return response
		}

		if (requestHasHardConstraints(normalized)) {
			this.host.setLastSearchMode("v2:constrained-empty", v2Details)
			// RET-15: a constraint-filtered empty is the served verdict —
			// the relevance signal keeps it distinguishable from an
			// unconstrained miss.
			this.recordV2RelevanceVerdict({
				admission: readAdmission,
				query: normalized.query,
				results: response.results,
				metadata: response.metadata,
				latencyMs,
				maxResults: resolvedSearchConfig.maxResults,
			})
			return response
		}

		// P3.2: legacySearch re-run is opt-in (see the search() sites).
		if (!mongoCfg.legacySearchFallback) {
			this.host.setLastSearchMode("v2:empty", v2Details)
			// RET-15: the empty verdict the caller receives is the signal.
			this.recordV2RelevanceVerdict({
				admission: readAdmission,
				query: normalized.query,
				results: response.results,
				metadata: response.metadata,
				latencyMs,
				maxResults: resolvedSearchConfig.maxResults,
			})
			return response
		}
		// WS-11: same admission policy as the search() legacy site — the
		// re-run pays its own token or it does not run.
		const legacyAdmission = tryConsumeSearchAdmission()
		if (!legacyAdmission.ok) {
			this.host.setLastSearchMode("v2:empty->legacy-throttled", {
				...v2Details,
				retryAfterMs: legacyAdmission.retryAfterMs,
			})
			// RET-15: the v2 empty verdict stands (only the opt-in
			// double-check was denied) — it is still the served answer.
			this.recordV2RelevanceVerdict({
				admission: readAdmission,
				query: normalized.query,
				results: response.results,
				metadata: response.metadata,
				latencyMs,
				maxResults: resolvedSearchConfig.maxResults,
			})
			return response
		}
		const fallbackResults = await this.host.legacySearch(
			normalized.query,
			{
				maxResults: normalized.maxResults,
				minScore: normalized.minScore,
				sessionKey: normalized.conversationScope?.sessionKey,
				scope: searchScope,
				scopeRef: searchScopeRef,
				kbRestricted: normalized.kbRestricted,
			},
			readAdmission,
		)
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
			scope?: MemoryScope
			sessionKey?: string
			scopeRef?: string
			filter?: { tags?: string[]; category?: string; source?: string }
			/** Per-call override; defaults to the resolved config fusionMethod. */
			fusionMethod?: MemoryMongoDBFusionMethod
			/**
			 * WS-12 (C-019): receives the degradation marker when admission
			 * control dropped the KB vector lane. Sink-not-state (see the
			 * search() onLaneLatency/onDegradation pattern); absence means the
			 * ranking is authoritative.
			 */
			onDegradation?: (degradation: MemorySearchDegradation) => void
		},
	): Promise<MemorySearchResult[]> {
		const cleaned = query.trim()
		if (!cleaned) {
			return []
		}

		const scopeRef =
			opts?.scopeRef ??
			(opts?.scope
				? this.host.resolveSearchIdentity({
						scope: opts.scope,
						sessionKey: opts.sessionKey,
					}).scopeRef
				: this.host.agentScopeRef)

		const readAdmission = await captureAdmissionToken({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})

		const mongoCfg = this.host.config.mongodb!
		const maxResults = clampSearchMaxResults(opts?.maxResults ?? 5)
		const minScore = opts?.minScore ?? 0.1

		// Direct KB search uses MongoDB query-time automatic embeddings.
		const queryVector: number[] | null = null

		// WS-11 (09-report R5/U1): the KB vector lane burns a server-side
		// autoEmbed query input on the same Atlas tier searchV2 draws from,
		// so direct KB search draws from the same process-level admission
		// bucket. Denial drops the vector lane — the text lane still answers,
		// so a throttle degrades ranking quality instead of emptying the
		// result set, and the marker records why.
		const kbVectorLane =
			mongoCfg.embeddingMode === "automated" &&
			this.host.capabilities.vectorSearch
		const kbAdmission = kbVectorLane ? tryConsumeSearchAdmission() : null
		if (kbAdmission && !kbAdmission.ok) {
			void emitTelemetry(
				this.host.db,
				this.host.prefix,
				{
					meta: { agentId: this.host.agentId, operation: "search" },
					durationMs: 0,
					ok: false,
					throttled: true,
					resultCount: 0,
				},
				{ admission: readAdmission },
			).catch(() => {
				log.warn("search telemetry emit failed")
			})
			this.host.setLastSearchMode("kb:throttled", {
				retryAfterMs: kbAdmission.retryAfterMs,
			})
			// WS-12 (C-019): the text lane still answers, so this is degraded
			// ranking, not an empty verdict — the sink carries that
			// distinction out with the results.
			opts?.onDegradation?.({
				kind: "throttled",
				scope: "vector-lane-skipped",
				retryAfterMs: kbAdmission.retryAfterMs,
			})
		}

		return searchKB(
			kbChunksCollection(this.host.db, this.host.prefix),
			cleaned,
			queryVector,
			{
				maxResults,
				minScore,
				scopeRef,
				filter: opts?.filter,
				numCandidates: mongoCfg.numCandidates,
				vectorIndexName: `${this.host.prefix}kb_chunks_vector`,
				textIndexName: `${this.host.prefix}kb_chunks_text`,
				capabilities: this.host.capabilities,
				embeddingMode: mongoCfg.embeddingMode,
				queryEmbeddingModel: mongoCfg.queryEmbeddingModel,
				// P0.10: KB fusion is a first-class option — per-call override,
				// else the resolved config value (env/config, default rankFusion).
				fusionMethod: opts?.fusionMethod ?? mongoCfg.fusionMethod,
				kbDocs: kbCollection(this.host.db, this.host.prefix),
				...(kbAdmission && !kbAdmission.ok ? { skipVectorLane: true } : {}),
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
