import type {
	MemoryMongoDBEmbeddingMode,
	MemoryMongoDBFusionMethod,
} from "@memongo/lib"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { isTextSearchTierAvailable } from "./mongodb-search.js"
import type { SearchWorkCost } from "./mongodb-search-budget.js"

// ---------------------------------------------------------------------------
// #101 decision 18: the per-lane cost table that sizes a required lane's
// reservation. A lane's cost is the sum, over every tier it can reach on this
// deployment, of that tier's first-attempt charges, assuming zero hits at
// every tier: an autoEmbed vector stage is one aggregation and one embed; a
// $search, $text or fusion aggregate is one aggregation (plus the embed of
// its vector input). It is the lane's upper bound without warmup retries,
// which pay from the unreserved remainder. search-lane-cost.test.ts runs the
// real lane functions against this table.
// ---------------------------------------------------------------------------

export const NO_SEARCH_COST: SearchWorkCost = { aggregations: 0, embeds: 0 }
const VECTOR_TIER: SearchWorkCost = { aggregations: 1, embeds: 1 }
const TEXT_TIER: SearchWorkCost = { aggregations: 1, embeds: 0 }

export function addSearchCosts(...costs: SearchWorkCost[]): SearchWorkCost {
	return costs.reduce(
		(sum, cost) => ({
			aggregations: sum.aggregations + cost.aggregations,
			embeds: sum.embeds + cost.embeds,
		}),
		NO_SEARCH_COST,
	)
}

type LaneCostContext = {
	capabilities: DetectedCapabilities
	embeddingMode: MemoryMongoDBEmbeddingMode
}

function canVector(context: LaneCostContext): boolean {
	return (
		context.embeddingMode === "automated" && context.capabilities.vectorSearch
	)
}

/** `active-critical`, `structured` and `procedural`: vector, then their $search tier. */
export function structuredLaneCost(
	context: LaneCostContext & { textIndexName: string },
): SearchWorkCost {
	return addSearchCosts(
		canVector(context) ? VECTOR_TIER : NO_SEARCH_COST,
		isTextSearchTierAvailable(context.capabilities, context.textIndexName)
			? TEXT_TIER
			: NO_SEARCH_COST,
	)
}

/** One `mongoSearch` call (a hybrid sub-lane): exactly one tier runs. */
export function mongoSearchTierCost(
	context: LaneCostContext & { fusionMethod: MemoryMongoDBFusionMethod },
): SearchWorkCost {
	const { capabilities, fusionMethod } = context
	if (canVector(context) && capabilities.textSearch) {
		if (fusionMethod === "scoreFusion" && capabilities.scoreFusion) {
			return VECTOR_TIER
		}
		if (fusionMethod !== "js-merge" && capabilities.rankFusion) {
			return VECTOR_TIER
		}
		return addSearchCosts(VECTOR_TIER, TEXT_TIER)
	}
	return canVector(context) ? VECTOR_TIER : TEXT_TIER
}

/** A `vector-only` hybrid sub-lane: one autoEmbed vector stage. */
export function vectorLeafCost(context: {
	embeddingMode: MemoryMongoDBEmbeddingMode
}): SearchWorkCost {
	return context.embeddingMode === "automated" ? VECTOR_TIER : NO_SEARCH_COST
}

/** `kb`: one fused aggregate, whichever fusion is configured: one aggregation and the embed of its vector input. */
export function kbLaneCost(context: {
	embeddingMode: MemoryMongoDBEmbeddingMode
}): SearchWorkCost {
	return vectorLeafCost(context)
}

/** `conversation-evidence`: the inline turn-vector and turn-text branches. */
export function conversationEvidenceLaneCost(
	context: LaneCostContext,
): SearchWorkCost {
	return addSearchCosts(
		canVector(context) ? VECTOR_TIER : NO_SEARCH_COST,
		context.capabilities.textSearch ? TEXT_TIER : NO_SEARCH_COST,
	)
}
