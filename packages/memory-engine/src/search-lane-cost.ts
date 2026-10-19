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
// each vector input). The chunk lanes have one tier: a native fusion
// aggregate. It is the lane's upper bound without warmup retries,
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

/**
 * One `mongoSearch` call (a hybrid sub-lane) is one native fusion aggregate:
 * one aggregation plus each embedded vector input it fuses.
 */
export function nativeFusionCost(context: {
	embeddingMode: MemoryMongoDBEmbeddingMode
	vectorInputs?: number
}): SearchWorkCost {
	return context.embeddingMode === "automated"
		? { aggregations: 1, embeds: context.vectorInputs ?? 1 }
		: NO_SEARCH_COST
}

/** A `vector-only` hybrid sub-lane: one autoEmbed vector stage. */
export function vectorLeafCost(context: {
	embeddingMode: MemoryMongoDBEmbeddingMode
}): SearchWorkCost {
	return context.embeddingMode === "automated" ? VECTOR_TIER : NO_SEARCH_COST
}

/** `kb`: fusion tiers, then vector, then keyword (or classic $text without Search). */
export function kbLaneCost(
	context: LaneCostContext & { fusionMethod: MemoryMongoDBFusionMethod },
): SearchWorkCost {
	const { capabilities, fusionMethod } = context
	const vector = canVector(context)
	const text = capabilities.textSearch
	if (vector && text && fusionMethod === "js-merge") {
		return addSearchCosts(VECTOR_TIER, TEXT_TIER)
	}
	const fusion =
		vector && text
			? addSearchCosts(
					fusionMethod === "scoreFusion" && capabilities.scoreFusion
						? VECTOR_TIER
						: NO_SEARCH_COST,
					capabilities.rankFusion ? VECTOR_TIER : NO_SEARCH_COST,
				)
			: NO_SEARCH_COST
	// Without Search the planned lexical tier is classic $text (R5/K11).
	return addSearchCosts(
		fusion,
		vector ? VECTOR_TIER : NO_SEARCH_COST,
		TEXT_TIER,
	)
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
