import path from "node:path"
import { normalizeSearchResults } from "./mongodb-hybrid.js"
import type { SearchMethod } from "./mongodb-hybrid.js"
import { searchKB } from "./mongodb-kb-search.js"
import type {
	RelevanceArtifact,
	RelevanceSourceScope,
} from "./mongodb-relevance.js"
import { applyPostRetrievalScoring } from "./mongodb-post-retrieval-scoring.js"
import {
	kbCollection,
	chunksCollection,
	kbChunksCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { mongoSearch } from "./mongodb-search.js"
import type {
	SearchExplainOptions,
	SearchTraceEvent,
} from "./mongodb-search.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import type { MemorySearchResult } from "./types.js"
import {
	deduplicateSearchResults,
	getActiveSources,
	rerankResults,
	resolveExplainSources,
} from "./mongodb-search-ranking.js"
import type { RelevanceExplainResult } from "./mongodb-search-ranking.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb")

/**
 * Relevance-diagnostics collaborator extracted from `mongodb-manager.ts`
 * (P4.3 god-file split). The facade delegates `relevanceExplain`; search
 * helpers are reached through the host's `searchOps` collaborator.
 */

export class MongoDBManagerRelevanceOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	async relevanceExplain(params: {
		query: string
		sourceScope?: RelevanceSourceScope
		sessionKey?: string
		maxResults?: number
		minScore?: number
		deep?: boolean
		questionDate?: Date
	}): Promise<RelevanceExplainResult> {
		if (!this.host.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		const sourceScope = params.sourceScope ?? "all"
		const maxResults = params.maxResults ?? 10
		const minScore = params.minScore ?? 0.1
		const startedAt = Date.now()
		const query = params.query.trim()
		if (!query) {
			return {
				latencyMs: 0,
				sourceScope,
				health: "insufficient-data",
				sampleRate: this.host.relevance.getSampleState().current,
				artifacts: [],
				results: [],
			}
		}

		const queryVector: number[] | null = null
		const mongoCfg = this.host.config.mongodb!

		const artifacts: RelevanceArtifact[] = []
		const traces: SearchTraceEvent[] = []
		const explainOpts: SearchExplainOptions = {
			enabled: true,
			deep: Boolean(params.deep),
			includeScoreDetails: true,
			onArtifact: (artifact) => {
				artifacts.push({
					artifactType: artifact.artifactType,
					summary: artifact.summary,
					rawExplain: artifact.rawExplain,
					compression: "none",
				})
			},
		}

		// Source policy enforcement: disabled sources return empty results even when
		// explicitly requested via sourceScope (matches search() behavior).
		const activeSources = getActiveSources(
			mongoCfg.sources,
			mongoCfg.kb.enabled,
		)
		const explainSources = resolveExplainSources(sourceScope, activeSources)
		const bridgeMaxResults = this.host.getBridgeChunkBudget(maxResults)
		const emptyResults: MemorySearchResult[] = []
		// relevanceExplain is a diagnostic view of what search() would return, so
		// it resolves the same identity from the same inputs and must never read
		// wider than the search path it is explaining.
		const identity = this.host.resolveSearchIdentity({
			sessionKey: params.sessionKey,
		})
		const bridgeFilter = this.host.buildBridgeChunkFilterForIdentity(identity)

		let mergedResults: MemorySearchResult[] = []
		if (sourceScope === "memory") {
			if (!explainSources.conversation) {
				mergedResults = emptyResults
			} else {
				const [runtimeHits, bridgeHits] = await Promise.all([
					mongoSearch(
						chunksCollection(this.host.db, this.host.prefix),
						query,
						queryVector,
						{
							maxResults: bridgeMaxResults,
							minScore,
							numCandidates: mongoCfg.numCandidates,
							sessionKey: params.sessionKey,
							filter: this.host.buildConversationChunkFilter(identity),
							fusionMethod: mongoCfg.fusionMethod,
							capabilities: this.host.capabilities,
							vectorIndexName: `${this.host.prefix}chunks_vector`,
							textIndexName: `${this.host.prefix}chunks_text`,
							vectorWeight: 0.7,
							textWeight: 0.3,
							embeddingMode: mongoCfg.embeddingMode,
							explain: explainOpts,
							onTrace: (event) => traces.push(event),
						},
					),
					!bridgeFilter
						? emptyResults
						: mongoSearch(
								chunksCollection(this.host.db, this.host.prefix),
								query,
								queryVector,
								{
									maxResults,
									minScore,
									numCandidates: mongoCfg.numCandidates,
									sessionKey: params.sessionKey,
									filter: bridgeFilter,
									fusionMethod: mongoCfg.fusionMethod,
									capabilities: this.host.capabilities,
									vectorIndexName: `${this.host.prefix}chunks_vector`,
									textIndexName: `${this.host.prefix}chunks_text`,
									vectorWeight: 0.7,
									textWeight: 0.3,
									embeddingMode: mongoCfg.embeddingMode,
									explain: explainOpts,
									onTrace: (event) => traces.push(event),
								},
							),
				])
				const legacyMethod: SearchMethod =
					this.host.resolveObservedSearchMethod(traces, mongoCfg)
				const normalizedRuntime = normalizeSearchResults(
					runtimeHits,
					legacyMethod,
				)
				const normalizedBridge = normalizeSearchResults(
					bridgeHits,
					legacyMethod,
				)
				mergedResults = applyPostRetrievalScoring(
					query,
					rerankResults(
						deduplicateSearchResults(
							[...normalizedRuntime, ...normalizedBridge].toSorted(
								(a, b) => b.score - a.score,
							),
						),
						query,
					),
					{ questionDate: params.questionDate },
				).slice(0, maxResults)
			}
		} else if (sourceScope === "kb") {
			mergedResults = !explainSources.reference
				? emptyResults
				: await searchKB(
						kbChunksCollection(this.host.db, this.host.prefix),
						query,
						queryVector,
						{
							maxResults,
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
					)
		} else if (sourceScope === "structured") {
			mergedResults = !explainSources.structured
				? emptyResults
				: await searchStructuredMemory(
						structuredMemCollection(this.host.db, this.host.prefix),
						query,
						queryVector,
						{
							maxResults,
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
					)
		} else {
			const [
				runtimeConversationResults,
				bridgeConversationResults,
				kbResults,
				structuredResults,
			] = await Promise.all([
				// Runtime conversation chunks — skip if conversation source is disabled
				!explainSources.conversation
					? emptyResults
					: mongoSearch(
							chunksCollection(this.host.db, this.host.prefix),
							query,
							queryVector,
							{
								maxResults,
								minScore,
								numCandidates: mongoCfg.numCandidates,
								sessionKey: params.sessionKey,
								filter: this.host.buildConversationChunkFilter(identity),
								fusionMethod: mongoCfg.fusionMethod,
								capabilities: this.host.capabilities,
								vectorIndexName: `${this.host.prefix}chunks_vector`,
								textIndexName: `${this.host.prefix}chunks_text`,
								vectorWeight: 0.7,
								textWeight: 0.3,
								embeddingMode: mongoCfg.embeddingMode,
								explain: explainOpts,
								onTrace: (event) => traces.push(event),
							},
						),
				// Bridge-note chunks — same collection, different namespace filter
				!explainSources.conversation || !bridgeFilter
					? emptyResults
					: mongoSearch(
							chunksCollection(this.host.db, this.host.prefix),
							query,
							queryVector,
							{
								maxResults: bridgeMaxResults,
								minScore,
								numCandidates: mongoCfg.numCandidates,
								sessionKey: params.sessionKey,
								filter: bridgeFilter,
								fusionMethod: mongoCfg.fusionMethod,
								capabilities: this.host.capabilities,
								vectorIndexName: `${this.host.prefix}chunks_vector`,
								textIndexName: `${this.host.prefix}chunks_text`,
								vectorWeight: 0.7,
								textWeight: 0.3,
								embeddingMode: mongoCfg.embeddingMode,
								explain: explainOpts,
								onTrace: (event) => traces.push(event),
							},
						),
				// KB chunks — skip if reference source is disabled
				!explainSources.reference
					? emptyResults
					: searchKB(
							kbChunksCollection(this.host.db, this.host.prefix),
							query,
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
							log.warn(`relevanceExplain KB search failed: ${String(err)}`)
							return [] as MemorySearchResult[]
						}),
				// Structured memory — skip if structured source is disabled
				!explainSources.structured
					? emptyResults
					: searchStructuredMemory(
							structuredMemCollection(this.host.db, this.host.prefix),
							query,
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
							log.warn(
								`relevanceExplain structured memory search failed: ${String(err)}`,
							)
							return [] as MemorySearchResult[]
						}),
			])
			const conversationResults = [
				...runtimeConversationResults,
				...bridgeConversationResults,
			]
			const legacyMethod: SearchMethod = this.host.resolveObservedSearchMethod(
				traces,
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
			mergedResults = applyPostRetrievalScoring(
				query,
				rerankResults(deduplicateSearchResults(merged), query),
				{ questionDate: params.questionDate },
			).slice(0, maxResults)
		}

		const successfulTrace = [...traces].toReversed().find((event) => event.ok)
		const fallbackPath =
			successfulTrace && successfulTrace.method !== mongoCfg.fusionMethod
				? `${mongoCfg.fusionMethod}->${successfulTrace.method}`
				: undefined
		const health = this.host.relevance.evaluateHealth(
			mergedResults,
			fallbackPath,
		)
		this.host.relevance.recordSignal(mergedResults, fallbackPath)
		artifacts.push({
			artifactType: "trace",
			summary: {
				sourceScope,
				requestedFusionMethod: mongoCfg.fusionMethod,
				fallbackPath,
				events: traces,
				topScore: mergedResults[0]?.score ?? 0,
				resultCount: mergedResults.length,
			},
		})

		const latencyMs = Date.now() - startedAt
		let runId: string | undefined
		try {
			runId = await this.host.relevance.persistRun({
				query,
				sourceScope,
				latencyMs,
				topK: maxResults,
				hitSources: Array.from(
					new Set(mergedResults.map((result) => result.source)),
				),
				fallbackPath,
				status: health,
				sampled: true,
				sampleRate: this.host.relevance.getSampleState().current,
				artifacts,
				diagnosticMode: true,
			})
		} catch (err) {
			this.host.relevance.logTelemetryFailure(err)
		}

		return {
			runId,
			latencyMs,
			sourceScope,
			health,
			fallbackPath,
			sampleRate: this.host.relevance.getSampleState().current,
			artifacts,
			results: mergedResults,
		}
	}
}
