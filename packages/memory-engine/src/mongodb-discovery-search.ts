/**
 * M2 T8 (#117): the one Search read behind every discovery content match.
 * Content selection happens only in `$search` (`text` plus tenant, state and
 * window clauses in `compound.filter`). Search hits are candidates, not
 * proof: the hydrated document is re-checked with a canonical `$match`
 * (tenant, state, window, expiry, lifecycle) right after the Search stage, so
 * a document that changed or was deleted after indexing cannot reach a brief.
 * Recency ordering is declared composition over the bounded candidate pool.
 */
import type { Collection, Document } from "mongodb"
import { assertCollectionIndexesHealthy } from "./mongodb-index-health.js"
import { runSearchAggregateWithRetry } from "./mongodb-search.js"
import { clampSearchQuery } from "./mongodb-search-ranking.js"
import { toTypedSearchError, type SearchLane } from "./search-outcomes.js"

/**
 * Candidates admitted after the re-check and before the recency sort. Search
 * orders by relevance; bounding the pool keeps the in-memory sort small while
 * leaving room above the largest brief (8 items, lanes read 3x that).
 */
export const DISCOVERY_CANDIDATE_POOL = 100

export type DiscoveryTenant = {
	agentId: string
	scope: string
	scopeRef: string
}

export type DiscoverySearchSpec = {
	collection: Collection
	/** The Search index name, already prefixed where the manifest prefixes it. */
	indexName: string
	/** The unprefixed collection whose manifest `search` index this read runs against. */
	healthCollection: string
	lane: SearchLane
	query: string
	textPaths: string[]
	tenant: DiscoveryTenant
	/** Extra `compound.filter` clauses (state, date window). */
	filter?: Document[]
	/** `compound.mustNot` clauses; the compound always keeps a `must` clause. */
	mustNot?: Document[]
	/** Canonical `$match` applied to every hit; must repeat tenant and state. */
	recheck: Document
	sort: Document
	limit: number
	/** Optional final projection, applied after the limit. */
	project?: Document
}

export function tenantEquals(tenant: DiscoveryTenant): Document[] {
	return [
		{ equals: { path: "agentId", value: tenant.agentId } },
		{ equals: { path: "scope", value: tenant.scope } },
		{ equals: { path: "scopeRef", value: tenant.scopeRef } },
	]
}

export function windowRange(
	path: string,
	window: { start: Date; end: Date },
): Document {
	return { range: { path, gte: window.start, lte: window.end } }
}

export function buildDiscoverySearchPipeline(
	spec: DiscoverySearchSpec,
): Document[] {
	return [
		{
			$search: {
				index: spec.indexName,
				compound: {
					must: [
						{
							text: {
								query: clampSearchQuery(spec.query),
								path:
									spec.textPaths.length === 1
										? spec.textPaths[0]
										: spec.textPaths,
							},
						},
					],
					filter: [...tenantEquals(spec.tenant), ...(spec.filter ?? [])],
					...(spec.mustNot?.length ? { mustNot: spec.mustNot } : {}),
				},
			},
		},
		{ $match: spec.recheck },
		{ $limit: DISCOVERY_CANDIDATE_POOL },
		{ $sort: spec.sort },
		{ $limit: spec.limit },
		...(spec.project ? [{ $project: spec.project }] : []),
	]
}

/**
 * A Search failure is a typed throw, never an empty list. An index observed
 * STALE or unavailable at admission (M2 decision 8) is the typed
 * `index-stale` / `index-unavailable` failure before any query runs; the
 * check is a no-op outside a request-local health scope.
 */
export async function searchDiscoveryCandidates(
	spec: DiscoverySearchSpec,
): Promise<Document[]> {
	await assertCollectionIndexesHealthy([spec.healthCollection], spec.lane, [
		"search",
	])
	try {
		return await runSearchAggregateWithRetry(
			spec.collection,
			buildDiscoverySearchPipeline(spec),
			{ stage: "atlas-search" },
		)
	} catch (error) {
		throw toTypedSearchError(error, "atlas-search", spec.lane)
	}
}
