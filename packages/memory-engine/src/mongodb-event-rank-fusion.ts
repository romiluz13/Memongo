/**
 * The native `$rankFusion` aggregate on events, shared by the event lanes
 * (turn-precision, conversation-evidence) and session turn recall.
 */

import type { Db, Document } from "mongodb"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { eventsCollection } from "./mongodb-schema.js"
import { resolveUserSearchMaxTimeMs } from "./mongodb-search-budget.js"
import { mapEventSearchDocToResult } from "./mongodb-search-ranking.js"
import { freshnessRevalidationStages } from "./mongodb-search.js"
import {
	type SearchBudgetReason,
	SearchBudgetDeniedError,
	type SearchTierOutcomeSink,
	toTypedSearchError,
} from "./search-outcomes.js"
import type { MemorySearchResult } from "./types.js"

/**
 * M2 decision 5: the turn-precision and conversation-evidence event lanes
 * are one native `$rankFusion` aggregate on events, vector and text inputs.
 * The weights are the former JavaScript RRF's equal weights, and the
 * server's fixed rank constant 60 is that RRF's k (mongodb-hybrid.ts
 * rrfScore), so the fusion policy is unchanged. One aggregate means one
 * outcome: a failure or a denial fails the lane, and no branch survives
 * alone. https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/
 */
const EVENT_FUSION_WEIGHTS = { vector: 1, text: 1 } as const

/** One fused aggregate plus the embed of its autoEmbed vector input. */
export const EVENT_FUSION_COST = { aggregations: 1, embeds: 1 } as const

export const EVENT_RESULT_PROJECTION: Document = {
	_id: 0,
	eventId: 1,
	body: 1,
	role: 1,
	sessionId: 1,
	timestamp: 1,
	scope: 1,
	scopeRef: 1,
	accessCount: 1,
}

export async function runEventRankFusion(params: {
	db: Db
	prefix: string
	query: string
	maxResults: number
	numCandidates: number
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
	queryEmbeddingModel: ResolvedMongoDBConfig["queryEmbeddingModel"]
	/** The canonical identity/time predicate: the vector prefilter and the post-stage revalidation of both inputs. */
	canonicalFilter: Document
	textFilters: Document[]
	textShould?: Document[]
	lifecycleMatch: Document
	consumeWork: (cost: typeof EVENT_FUSION_COST) => boolean
	denialReason: (cost: typeof EVENT_FUSION_COST) => SearchBudgetReason
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<MemorySearchResult[]> {
	if (
		!params.capabilities.vectorSearch ||
		!params.capabilities.textSearch ||
		!params.capabilities.rankFusion ||
		params.embeddingMode !== "automated"
	) {
		params.onTierOutcome?.({
			stage: "rank-fusion",
			outcome: "not-applicable",
			reason: "capability-absent",
		})
		return []
	}
	// P3.2 / decision 18: the inline $vectorSearch input bypasses
	// buildVectorSearchStage, so the fused aggregate and its embed are
	// charged here as one pair; a refusal runs nothing.
	if (!params.consumeWork(EVENT_FUSION_COST)) {
		throw new SearchBudgetDeniedError({
			stage: "rank-fusion",
			reason: params.denialReason(EVENT_FUSION_COST),
		})
	}
	// Both inputs carry the same identity, time and lifecycle predicate
	// before their bounds: the Search stages read the indexed copy, which can
	// lag an owner/scope/session mutation, a retraction or an expiry, so the
	// hydrated document is re-checked inside each input.
	const pipeline: Document[] = [
		{
			$rankFusion: {
				input: {
					pipelines: {
						vector: [
							{
								$vectorSearch: {
									index: `${params.prefix}events_vector`,
									path: "body",
									query: { text: params.query },
									model: params.queryEmbeddingModel,
									filter: params.canonicalFilter,
									numCandidates: params.numCandidates,
									limit: params.maxResults,
									returnStoredSource: false,
								},
							},
							...freshnessRevalidationStages(params.canonicalFilter),
							{ $match: params.lifecycleMatch },
						],
						text: [
							{
								$search: {
									index: `${params.prefix}events_text`,
									compound: {
										filter: params.textFilters,
										must: [{ text: { query: params.query, path: "body" } }],
										...(params.textShould && params.textShould.length > 0
											? { should: params.textShould }
											: {}),
									},
								},
							},
							...freshnessRevalidationStages(params.canonicalFilter),
							{ $match: params.lifecycleMatch },
							{ $limit: params.maxResults },
						],
					},
				},
				combination: { weights: EVENT_FUSION_WEIGHTS },
			},
		},
		// Each input is bounded at maxResults, so the fused set holds at most
		// twice that; the lane's composition below trims to maxResults.
		{ $limit: params.maxResults * 2 },
		{ $project: { ...EVENT_RESULT_PROJECTION, score: { $meta: "score" } } },
	]
	let docs: Document[]
	try {
		docs = await eventsCollection(params.db, params.prefix)
			// P3.8: user-driven Search pipelines carry a maxTimeMS ceiling.
			.aggregate(pipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
			.toArray()
	} catch (err) {
		throw toTypedSearchError(err, "rank-fusion")
	}
	params.onTierOutcome?.({
		stage: "rank-fusion",
		outcome: docs.length > 0 ? "ok" : "ok-empty",
		...(docs.length > 0 ? {} : { reason: "zero-hits" as const }),
		resultCount: docs.length,
	})
	return docs
		.map((doc) => mapEventSearchDocToResult(doc, "turn-fusion"))
		.filter((result): result is MemorySearchResult => Boolean(result))
}
