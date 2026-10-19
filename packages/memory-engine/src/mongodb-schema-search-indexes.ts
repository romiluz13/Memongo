// Search / Vector Search index bootstrap (P4.3 split from mongodb-schema.ts).
// The definitions live in the required-index manifest
// (mongodb-required-index-manifest.ts); this module creates or updates them.
// Every failure is a typed MemongoBootError: there are no per-index catches
// that log and continue.
import type { Db } from "mongodb"
import type {
	MemoryMongoDBDeploymentProfile,
	MemoryMongoDBEmbeddingMode,
} from "@memongo/lib"
import { reconcileRequiredIndex } from "./mongodb-boot-contract.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"
import { detectServerVersionArray } from "./mongodb-schema-search-readiness.js"

export {
	INDEX_AUTOEMBED_MODEL,
	buildAutoEmbedVectorDefinition,
	ensureEntityAutocompleteIndex,
	ensureEpisodeAutocompleteIndex,
	getExpectedSearchIndexTargets,
	resolveSearchIndexReadinessTiming,
} from "./mongodb-schema-search-definitions.js"
export {
	detectServerVersionArray,
	isSearchIndexQueryable,
	isSearchIndexReadyWithFilterFields,
	isEventsVectorBitemporalPrefilterReady,
	listSearchIndexes,
	isSearchIndexTypeCompatible,
	sleep,
} from "./mongodb-schema-search-readiness.js"
export type {
	SearchIndexDescription,
	SearchIndexTarget,
	SearchIndexWaitResult,
} from "./mongodb-schema-search-readiness.js"

/**
 * Create or update every required-index manifest entry. Never drops an index
 * and never skips one: the first failure is thrown as a MemongoBootError.
 * Readiness is verified separately (enforceBootContract).
 */
export async function ensureSearchIndexes(
	db: Db,
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
	embeddingMode: MemoryMongoDBEmbeddingMode,
	quantization: "none" | "scalar" | "binary" = "none",
	numDimensions: number = 1024,
	/**
	 * B10: credential-free deployment identity (mongodbDeploymentIdentity) so
	 * probe outcomes recorded here are scoped to this deployment only.
	 */
	deployment?: string,
): Promise<{ text: boolean; vector: boolean }> {
	void profile
	void embeddingMode
	void numDimensions
	const manifest = buildRequiredIndexManifest({
		prefix,
		quantization,
		serverVersionArray: await detectServerVersionArray(db),
		deployment,
	})
	for (const entry of manifest) {
		await reconcileRequiredIndex(db.collection(entry.collectionName), entry)
	}
	return {
		text: manifest.some((entry) => entry.type === "search"),
		vector: manifest.some((entry) => entry.type === "vectorSearch"),
	}
}
