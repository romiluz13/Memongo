// ---------------------------------------------------------------------------
// P4.3 god-file split — schema orchestrator
//
// Implementations moved to per-domain modules (mongodb-schema-<domain>.ts);
// this file keeps the exact "./mongodb-schema.js" import contract so every
// importer and both package barrels (index.ts, internal-barrel.ts) resolve
// unchanged. Do not add new exports here — add them in the domain module and
// re-export deliberately.
// ---------------------------------------------------------------------------
export type {
	DetectedCapabilities,
	MongoIndexBudgetCheck,
} from "./mongodb-schema-types.js"
export {
	chunksCollection,
	filesCollection,
	metaCollection,
	kbCollection,
	kbChunksCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
	proceduresCollection,
	procedureRevisionsCollection,
	relevanceRunsCollection,
	relevanceArtifactsCollection,
	relevanceRegressionsCollection,
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	entityLinksCollection,
	episodesCollection,
	ingestRunsCollection,
	projectionRunsCollection,
	queryCacheCollection,
	ensureTimeseriesOrPlain,
	telemetryCollection,
	accessEventsCollection,
	mutationsCollection,
	memoryQuarantineCollection,
	laneCoverageCollection,
	consolidationRunsCollection,
	recallTracesCollection,
	memoryJobsCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
} from "./mongodb-schema-collections.js"
export {
	ensureCollections,
	ensureSchemaValidation,
} from "./mongodb-schema-validators.js"
export { ensureStandardIndexes } from "./mongodb-schema-standard-indexes.js"
export {
	isSearchIndexQueryable,
	isSearchIndexReadyWithFilterFields,
	isEventsVectorBitemporalPrefilterReady,
	listSearchIndexes,
	isSearchIndexManagementAvailable,
	isSearchIndexTypeCompatible,
	ensureEntityAutocompleteIndex,
	ensureEpisodeAutocompleteIndex,
	getExpectedSearchIndexTargets,
	buildAutoEmbedVectorDefinition,
	waitForSearchIndexesQueryable,
	resolveSearchIndexReadinessTiming,
	ensureSearchIndexes,
} from "./mongodb-schema-search-indexes.js"
export type {
	SearchIndexDescription,
	SearchIndexTarget,
	SearchIndexWaitResult,
} from "./mongodb-schema-search-indexes.js"
export { assertIndexBudget } from "./mongodb-schema-budget.js"
export { checkKBOrphans } from "./mongodb-schema-integrity.js"
export {
	detectCapabilities,
	waitForSearchCapabilities,
} from "./mongodb-schema-capabilities.js"
