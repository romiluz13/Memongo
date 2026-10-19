import type { searchV2 as SearchV2 } from "../mongodb-search-v2.js"
import type { DetectedCapabilities } from "../mongodb-schema-types.js"

/**
 * The capability view for tests that call searchV2 directly with fakes. M2
 * decision 8 removed searchV2's built-in all-true default: a direct caller
 * states the view it wants, or runs inside a request index-health scope.
 */
export const HEALTHY_TEST_CAPABILITIES: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}

/** searchV2 with HEALTHY_TEST_CAPABILITIES unless the call states its own. */
export function withHealthyCapabilities(
	searchV2: typeof SearchV2,
): typeof SearchV2 {
	return (db, prefix, query, agentId, context) =>
		searchV2(db, prefix, query, agentId, {
			...context,
			searchOptions: {
				capabilities: HEALTHY_TEST_CAPABILITIES,
				...context.searchOptions,
			},
		})
}
