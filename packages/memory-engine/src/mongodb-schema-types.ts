// Schema-layer shared types (P4.3 split from mongodb-schema.ts).
import type { MemoryMongoDBDeploymentProfile } from "@memongo/lib"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectedCapabilities = {
	vectorSearch: boolean
	textSearch: boolean
	scoreFusion: boolean
	rankFusion: boolean
	/**
	 * storedSource: $vectorSearch can return stored source fields directly
	 * from the index without a collection re-fetch. Available on MongoDB 8.3+.
	 * See: mongodb.com/docs/atlas/vector-search/tutorials/vector-search-stored-source/
	 */
	storedSource: boolean
	/**
	 * vectorIndexMethod: the vector index supports `indexingMethod` for
	 * controlling HNSW vs flat (exact) indexing. Available on MongoDB 8.3+.
	 * See: mongodb.com/docs/atlas/vector-search/vector-search-overview/
	 */
	vectorIndexMethod: boolean
	/**
	 * capabilityGates: per-feature evaluation of the capability re-enable
	 * registry (P3.6, mongodb-capability-registry.ts) against this server's
	 * buildInfo. Optional so existing DetectedCapabilities literals in
	 * callers and tests keep compiling.
	 */
	capabilityGates?: Record<string, boolean>
}

export type MongoIndexBudgetCheck = {
	profile: MemoryMongoDBDeploymentProfile
	plannedSearchIndexes: number
	budget: number | "unbounded"
	withinBudget: boolean
}
