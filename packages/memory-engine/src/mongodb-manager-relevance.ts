import { captureAdmissionToken } from "./mongodb-write-fence.js"
import type {
	RelevanceArtifact,
	RelevanceSourceScope,
} from "./mongodb-relevance.js"
import { searchV2 } from "./mongodb-search-v2.js"
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import {
	clampSearchMaxResults,
	clampSearchQuery,
	getActiveSources,
} from "./mongodb-search-ranking.js"
import type { RelevanceExplainResult } from "./mongodb-search-ranking.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"

/**
 * Relevance-diagnostics collaborator extracted from `mongodb-manager.ts`
 * (P4.3 god-file split). The facade delegates `relevanceExplain`.
 */

export class MongoDBManagerRelevanceOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	/**
	 * sourceScope narrows the V2 lane set the way the retired legacy
	 * implementation's resolveExplainSources gate did: "memory" keeps the
	 * conversation-derived lanes (raw-window/hybrid/graph/episodic), "kb"
	 * keeps the KB lane, "structured" keeps the structured-family lanes
	 * (active-critical/structured/procedural), "all" keeps everything.
	 * buildV2AvailablePaths has already excluded disabled sources and
	 * graph/episode lanes, so the filter only intersects with that set.
	 */
	private filterV2PathsForSourceScope(
		availablePaths: Set<RetrievalPath>,
		sourceScope: RelevanceSourceScope,
	): Set<RetrievalPath> {
		if (sourceScope === "all") {
			return availablePaths
		}
		const keep: RetrievalPath[] =
			sourceScope === "memory"
				? ["raw-window", "hybrid", "graph", "episodic"]
				: sourceScope === "kb"
					? ["kb"]
					: ["active-critical", "structured", "procedural"]
		return new Set([...availablePaths].filter((path) => keep.includes(path)))
	}

	/**
	 * RET-15: relevanceExplain diagnoses the pipeline that actually answers
	 * searches — searchV2 (planner, lanes, reranker, constraints) — instead
	 * of the retired hand-rolled re-implementation of the legacy pipeline
	 * that omitted every V2-only stage and reversed the bridge/memory
	 * result budgets. It resolves identity and lanes exactly like search()
	 * (narrowed per sourceScope), executes one V2 search, and persists one
	 * diagnostic-mode run whose trace artifact carries the real V2
	 * metadata. A diagnostic must execute the pipeline, not read a prior
	 * answer.
	 */
	async relevanceExplain(params: {
		query: string
		sourceScope?: RelevanceSourceScope
		sessionKey?: string
		maxResults?: number
		minScore?: number
		deep?: boolean
		questionDate?: Date
		kbRestricted?: boolean
	}): Promise<RelevanceExplainResult> {
		if (!this.host.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		const relevance = this.host.relevance
		const sourceScope = params.sourceScope ?? "all"
		const maxResults = clampSearchMaxResults(params.maxResults ?? 10)
		const startedAt = Date.now()
		const cleaned = clampSearchQuery(params.query.trim())
		if (!cleaned) {
			return {
				latencyMs: 0,
				sourceScope,
				health: "insufficient-data",
				sampleRate: relevance.getSampleState().current,
				artifacts: [],
				results: [],
			}
		}

		const mongoCfg = this.host.config.mongodb!
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled && params.kbRestricted !== true,
		)
		const availablePaths = this.filterV2PathsForSourceScope(
			this.host.buildV2AvailablePaths(activeSources),
			sourceScope,
		)
		// Nothing measurable: disabled sources or a sourceScope that
		// intersects nothing. Distinguishable from "searched and found
		// nothing" — that verdict is "degraded", this one is not a verdict.
		if (availablePaths.size === 0) {
			return {
				latencyMs: Date.now() - startedAt,
				sourceScope,
				health: "insufficient-data",
				sampleRate: relevance.getSampleState().current,
				artifacts: [],
				results: [],
			}
		}

		const readAdmission = await captureAdmissionToken({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})

		// Same identity rule as search(): sessionKey implies "session",
		// explicit scope wins, default otherwise — a diagnostic view must
		// never read wider than the search path it explains.
		const { scope: searchScope, scopeRef: searchScopeRef } =
			this.host.resolveSearchIdentity({ sessionKey: params.sessionKey })

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
				// time so status reflects the outage — same seam as search().
				onPathFailure: (path, error) =>
					this.host.noteSearchLaneFailure(path, error),
				searchOptions: {
					// Same default chain as search(), so the diagnostic runs
					// the pipeline at the thresholds the served path uses.
					minScore: params.minScore ?? mongoCfg.reranking?.minScore ?? 0.01,
					sessionKey: params.sessionKey,
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
					questionDate: params.questionDate,
					budget: mongoCfg.searchBudget,
				},
			},
		)

		const latencyMs = Date.now() - startedAt

		// WS-11: a throttled diagnostic is not a retrieval verdict — surface
		// it as such instead of feeding a synthetic "empty/degraded" signal
		// into the adaptive sampler.
		const throttled = v2.metadata.throttled
		const health = throttled
			? "insufficient-data"
			: relevance.evaluateHealth(v2.results)
		if (!throttled) {
			relevance.recordSignal(v2.results)
		}

		// One trace artifact with the real V2 decision surface — plan,
		// constraints, per-lane execution/latency/outcomes, rerank and
		// rewrite flags, budget. `deep` is recorded, not honored with fake
		// per-lane mongo explains: searchV2 has no explain instrumentation,
		// and the retired lane-level explains were of the legacy pipeline.
		const artifacts: RelevanceArtifact[] = [
			{
				artifactType: "trace",
				summary: {
					pipeline: "v2",
					sourceScope,
					diagnosticDepth: params.deep ? "deep" : "standard",
					...(throttled ? { throttled } : {}),
					plan: v2.metadata.plan.paths,
					planConfidence: v2.metadata.plan.confidence,
					planConstraints: v2.metadata.plan.constraints ?? {},
					planReasoning: v2.metadata.plan.reasoning,
					skippedLanes: v2.metadata.plan.skippedLanes ?? [],
					pathsExecuted: v2.metadata.pathsExecuted,
					resultsByPath: v2.metadata.resultsByPath,
					...(v2.metadata.laneOutcomes
						? { laneOutcomes: v2.metadata.laneOutcomes }
						: {}),
					...(v2.metadata.latencyByPath
						? { latencyByPath: v2.metadata.latencyByPath }
						: {}),
					reranked: Boolean(v2.metadata.reranked),
					queryRewritten: Boolean(v2.metadata.queryRewritten),
					...(v2.metadata.budget ? { budget: v2.metadata.budget } : {}),
					topScore: v2.results[0]?.score ?? 0,
					resultCount: v2.results.length,
				},
			},
		]

		let runId: string | undefined
		try {
			runId = await relevance.persistRun({
				admission: readAdmission,
				query: cleaned,
				sourceScope,
				latencyMs,
				topK: maxResults,
				hitSources: Array.from(
					new Set(v2.results.map((result) => result.source)),
				),
				status: health,
				sampled: true,
				sampleRate: relevance.getSampleState().current,
				artifacts,
				diagnosticMode: true,
			})
		} catch (err) {
			relevance.logTelemetryFailure(err)
		}

		return {
			runId,
			latencyMs,
			sourceScope,
			health,
			sampleRate: relevance.getSampleState().current,
			artifacts,
			results: v2.results,
		}
	}
}
