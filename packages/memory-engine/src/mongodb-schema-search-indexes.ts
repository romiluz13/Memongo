// Atlas Search / Vector Search index definitions, readiness, and drift (P4.3 split from mongodb-schema.ts).
import type { Collection, Db, Document } from "mongodb"
import type {
	MemoryMongoDBDeploymentProfile,
	MemoryMongoDBEmbeddingMode,
} from "@memongo/lib"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

import {
	isCapabilityEnabled,
	recordCapabilityProbe,
} from "./mongodb-capability-registry.js"
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import { assertIndexBudget } from "./mongodb-schema-budget.js"
import {
	chunksCollection,
	kbChunksCollection,
	structuredMemCollection,
	proceduresCollection,
	eventsCollection,
	entitiesCollection,
	episodesCollection,
	queryCacheCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
} from "./mongodb-schema-collections.js"
import { sortObject } from "./search-utils.js"

// ---------------------------------------------------------------------------
// Search / Vector Search index creation
// ---------------------------------------------------------------------------

function isSearchIndexManagementUnavailable(message: string): boolean {
	return (
		message.includes("Search Index Management service") ||
		message.includes("Error connecting to Search Index Management service")
	)
}

// Version gating goes through serverVersionAtLeast from the capability
// registry (mongodb-capability-registry.ts), so every gate in this file and
// the registry share one comparison.

// Exported for sibling schema modules (validators); not part of the
// mongodb-schema.js public surface.
export async function detectServerVersionArray(db: Db): Promise<unknown> {
	try {
		const buildInfo = await db.admin().command({ buildInfo: 1 })
		return (buildInfo as { versionArray?: unknown }).versionArray
	} catch {
		return undefined
	}
}

export type SearchIndexDescription = {
	name?: string
	status?: string
	type?: string
	queryable?: boolean
	definition?: Document
	statusDetail?: Array<{
		mainIndex?: { queryable?: boolean; status?: string }
		definitions?: Array<{ queryable?: boolean; status?: string }>
	}>
	latestDefinition?: Document
}

export type SearchIndexTarget = {
	collectionName: string
	indexNames: string[]
}

export type SearchIndexWaitResult = {
	ready: boolean
	indexes: SearchIndexDescription[]
	pending: string[]
	failed: string[]
	lastError?: string
}

const SEARCH_INDEX_READY_STATUSES = new Set(["READY", "ACTIVE"])
const SEARCH_INDEX_FAILED_STATUSES = new Set(["FAILED"])

// Exported for sibling schema modules (capabilities); not part of the
// mongodb-schema.js public surface.
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractNestedQueryableStates(
	index: SearchIndexDescription,
): boolean[] {
	if (!Array.isArray(index.statusDetail)) {
		return []
	}
	const states: boolean[] = []
	for (const detail of index.statusDetail) {
		if (detail?.mainIndex?.queryable !== undefined) {
			states.push(detail.mainIndex.queryable === true)
		}
		if (Array.isArray(detail?.definitions)) {
			for (const definition of detail.definitions) {
				if (definition?.queryable !== undefined) {
					states.push(definition.queryable === true)
				}
			}
		}
	}
	return states
}

function extractNestedStatuses(index: SearchIndexDescription): string[] {
	if (!Array.isArray(index.statusDetail)) {
		return []
	}
	const statuses: string[] = []
	for (const detail of index.statusDetail) {
		const mainStatus = String(detail?.mainIndex?.status ?? "").toUpperCase()
		if (mainStatus) {
			statuses.push(mainStatus)
		}
		if (Array.isArray(detail?.definitions)) {
			for (const definition of detail.definitions) {
				const definitionStatus = String(definition?.status ?? "").toUpperCase()
				if (definitionStatus) {
					statuses.push(definitionStatus)
				}
			}
		}
	}
	return statuses
}

export function isSearchIndexQueryable(index: SearchIndexDescription): boolean {
	const status = String(index.status ?? "").toUpperCase()
	if (status && !SEARCH_INDEX_READY_STATUSES.has(status)) {
		return false
	}
	if (index.queryable === false) {
		return false
	}

	const nestedStates = extractNestedQueryableStates(index)
	if (nestedStates.some((queryable) => !queryable)) {
		return false
	}

	const nestedStatuses = extractNestedStatuses(index)
	if (
		nestedStatuses.some(
			(nestedStatus) => !SEARCH_INDEX_READY_STATUSES.has(nestedStatus),
		)
	) {
		return false
	}

	return (
		index.queryable === true ||
		nestedStates.length > 0 ||
		SEARCH_INDEX_READY_STATUSES.has(status) ||
		nestedStatuses.length > 0
	)
}

export function isSearchIndexReadyWithFilterFields(
	index: SearchIndexDescription,
	filterPaths: string[],
	expectedType?: "search" | "vectorSearch",
): boolean {
	if (!isSearchIndexQueryable(index)) {
		return false
	}
	if (expectedType && !isSearchIndexTypeCompatible(index.type, expectedType)) {
		return false
	}
	const definition = index.latestDefinition ?? index.definition
	const fields = Array.isArray(definition?.fields) ? definition.fields : []
	return filterPaths.every((path) =>
		fields.some(
			(field) =>
				typeof field === "object" &&
				field !== null &&
				(field as Document).type === "filter" &&
				(field as Document).path === path,
		),
	)
}

export async function isEventsVectorBitemporalPrefilterReady(
	collection: Collection,
	indexName: string,
	indexes?: SearchIndexDescription[],
): Promise<boolean> {
	const index = (indexes ?? (await listSearchIndexes(collection))).find(
		(candidate) => candidate.name === indexName,
	)
	if (
		!index ||
		!isSearchIndexReadyWithFilterFields(
			index,
			["validAt", "invalidAt"],
			"vectorSearch",
		)
	) {
		return false
	}
	const explicitNullInvalidAt = await collection.findOne(
		{ invalidAt: { $type: 10 } },
		{ projection: { _id: 1 } },
	)
	return explicitNullInvalidAt === null
}

function isSearchIndexFailed(index: SearchIndexDescription): boolean {
	if (index.queryable === true) {
		return false
	}
	const status = String(index.status ?? "").toUpperCase()
	if (SEARCH_INDEX_FAILED_STATUSES.has(status)) {
		return true
	}
	if (!Array.isArray(index.statusDetail)) {
		return false
	}
	for (const detail of index.statusDetail) {
		const mainStatus = String(detail?.mainIndex?.status ?? "").toUpperCase()
		if (SEARCH_INDEX_FAILED_STATUSES.has(mainStatus)) {
			return true
		}
		if (Array.isArray(detail?.definitions)) {
			for (const definition of detail.definitions) {
				const definitionStatus = String(definition?.status ?? "").toUpperCase()
				if (SEARCH_INDEX_FAILED_STATUSES.has(definitionStatus)) {
					return true
				}
			}
		}
	}
	return false
}

export async function listSearchIndexes(
	collection: Collection,
): Promise<SearchIndexDescription[]> {
	try {
		return (await collection
			.aggregate([{ $listSearchIndexes: {} }])
			.toArray()) as SearchIndexDescription[]
	} catch {
		return (await collection
			.listSearchIndexes()
			.toArray()) as SearchIndexDescription[]
	}
}

export async function isSearchIndexManagementAvailable(
	db: Db,
	collectionName: string,
): Promise<boolean> {
	try {
		await listSearchIndexes(db.collection(collectionName))
		return true
	} catch {
		return false
	}
}

/**
 * Compute a signature of the code-owned parts of a search index definition.
 * We compare only the fields the code controls (mappings, fields, similarity,
 * type, numDimensions, path) — NOT the full normalized definition, because the
 * server may add default values (e.g. `storedSource: false`, `dynamic: true`) to
 * `latestDefinition` that cause full-JSON equality to spuriously report drift
 * and trigger a rebuild on every boot.
 */
function searchIndexDefinitionSignature(definition: Document): string {
	const codeOwned: Record<string, unknown> = {}
	const keysToCompare = [
		"fields",
		"mappings",
		"similarity",
		"type",
		"numDimensions",
		"path",
		"query",
		"model",
		"filter",
		"storedSource",
		"indexingMethod",
	]
	for (const key of keysToCompare) {
		if (definition[key] !== undefined) {
			codeOwned[key] = definition[key]
		}
	}
	return JSON.stringify(sortObject(codeOwned))
}

export function isSearchIndexTypeCompatible(
	actual: string | undefined,
	expected: "search" | "vectorSearch",
): boolean {
	if (!actual) return true
	if (actual === expected) return true
	// Atlas Local reports vectorSearch indexes backed by autoEmbed as
	// `autoEmbed`. Treat that as compatible with the vectorSearch create API.
	return expected === "vectorSearch" && actual === "autoEmbed"
}

async function ensureNamedSearchIndex(params: {
	collection: Collection
	name: string
	type: "search" | "vectorSearch"
	definition: Document
	label: string
}): Promise<boolean> {
	const searchCollection = params.collection as Collection & {
		updateSearchIndex?: (name: string, definition: Document) => Promise<void>
		listSearchIndexes: (name?: string) => {
			toArray: () => Promise<
				Array<{
					name?: string
					type?: string
					definition?: Document
					latestDefinition?: Document
					queryable?: boolean
				}>
			>
		}
	}

	try {
		const existing = (await searchCollection
			.listSearchIndexes(params.name)
			.toArray()) as Array<{
			name?: string
			type?: string
			definition?: Document
			latestDefinition?: Document
			queryable?: boolean
		}>
		const current = existing[0]
		if (current) {
			if (!isSearchIndexTypeCompatible(current.type, params.type)) {
				log.warn(
					`${params.label} search index exists with incompatible type (${current.type}); expected ${params.type}`,
				)
				return false
			}
			const currentDefinition = current.latestDefinition ?? current.definition
			if (
				currentDefinition &&
				searchIndexDefinitionSignature(currentDefinition) !==
					searchIndexDefinitionSignature(params.definition)
			) {
				if (typeof searchCollection.updateSearchIndex === "function") {
					await searchCollection.updateSearchIndex(
						params.name,
						params.definition,
					)
					log.info(`updated ${params.label} search index`)
				} else {
					log.warn(
						`${params.label} search index definition drift detected but updateSearchIndex() is unavailable`,
					)
				}
			}
			if (current.queryable === false) {
				log.warn(`${params.label} search index exists but is not yet queryable`)
			}
			return true
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (isSearchIndexManagementUnavailable(msg)) {
			throw err
		}
		log.warn(
			`${params.label} search index inspection failed; attempting create: ${msg}`,
		)
	}

	await searchCollection.createSearchIndex({
		name: params.name,
		type: params.type,
		definition: params.definition,
	})
	log.info(`created ${params.label} search index`)
	return true
}

/**
 * Ensure Atlas Search autocomplete index on entities collection for fuzzy
 * entity lookup. Uses the existing ensureNamedSearchIndex pattern.
 */
export async function ensureEntityAutocompleteIndex(
	db: Db,
	prefix: string,
): Promise<void> {
	const entities = entitiesCollection(db, prefix)
	try {
		await ensureNamedSearchIndex({
			collection: entities,
			name: "entity_autocomplete",
			type: "search",
			definition: {
				mappings: {
					dynamic: false,
					fields: {
						name: { type: "autocomplete" },
						aliases: { type: "autocomplete" },
						agentId: { type: "token" },
						scope: { type: "token" },
						scopeRef: { type: "token" },
					},
				},
			},
			label: "entity autocomplete",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!msg.includes("already exists") && !msg.includes("duplicate")) {
			log.warn(`entity autocomplete index creation failed: ${msg}`)
		}
	}
}

/**
 * Ensure Atlas Search autocomplete index on episodes collection for
 * title/summary episode lookup (P3.8) — the episode counterpart of
 * ensureEntityAutocompleteIndex, retiring the request-path $regex scan.
 */
export async function ensureEpisodeAutocompleteIndex(
	db: Db,
	prefix: string,
): Promise<void> {
	const episodes = episodesCollection(db, prefix)
	try {
		await ensureNamedSearchIndex({
			collection: episodes,
			name: "episode_autocomplete",
			type: "search",
			definition: {
				mappings: {
					dynamic: false,
					fields: {
						title: { type: "autocomplete" },
						summary: { type: "autocomplete" },
						agentId: { type: "token" },
						scope: { type: "token" },
						scopeRef: { type: "token" },
					},
				},
			},
			label: "episode autocomplete",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!msg.includes("already exists") && !msg.includes("duplicate")) {
			log.warn(`episode autocomplete index creation failed: ${msg}`)
		}
	}
}

export function getExpectedSearchIndexTargets(
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
): SearchIndexTarget[] {
	const evidenceMirrorEnabled = isEvidenceMirrorEnabled()
	const rawSessionIndexProfile = isRawSessionSearchIndexProfile()
	const plannedSearchIndexCount = rawSessionIndexProfile
		? 1
		: evidenceMirrorEnabled
			? 17
			: 15
	const budget = assertIndexBudget(profile, plannedSearchIndexCount)
	const reducedBudget =
		!budget.withinBudget &&
		typeof budget.budget === "number" &&
		budget.budget >= 2
	if (!budget.withinBudget && !reducedBudget) {
		return []
	}
	if (rawSessionIndexProfile) {
		return [
			{
				collectionName: `${prefix}session_chunks`,
				indexNames: [`${prefix}session_chunks_vector`],
			},
		]
	}
	const targets: SearchIndexTarget[] = [
		{
			collectionName: `${prefix}chunks`,
			indexNames: [`${prefix}chunks_text`, `${prefix}chunks_vector`],
		},
	]
	if (reducedBudget) {
		return targets
	}
	const evidenceTargets: SearchIndexTarget[] = evidenceMirrorEnabled
		? [
				{
					collectionName: `${prefix}memory_evidence`,
					indexNames: [
						`${prefix}memory_evidence_text`,
						`${prefix}memory_evidence_vector`,
					],
				},
			]
		: []
	if (isLongMemEvalSearchIndexProfile()) {
		return [
			...targets,
			{
				collectionName: `${prefix}structured_mem`,
				indexNames: [
					`${prefix}structured_mem_text`,
					`${prefix}structured_mem_vector`,
				],
			},
			{
				collectionName: `${prefix}procedures`,
				indexNames: [`${prefix}procedures_text`, `${prefix}procedures_vector`],
			},
			{
				collectionName: `${prefix}events`,
				indexNames: [`${prefix}events_text`, `${prefix}events_vector`],
			},
			...evidenceTargets,
		]
	}
	return [
		...targets,
		{
			collectionName: `${prefix}kb_chunks`,
			indexNames: [`${prefix}kb_chunks_text`, `${prefix}kb_chunks_vector`],
		},
		{
			collectionName: `${prefix}structured_mem`,
			indexNames: [
				`${prefix}structured_mem_text`,
				`${prefix}structured_mem_vector`,
			],
		},
		{
			collectionName: `${prefix}procedures`,
			indexNames: [`${prefix}procedures_text`, `${prefix}procedures_vector`],
		},
		{
			collectionName: `${prefix}events`,
			indexNames: [`${prefix}events_text`, `${prefix}events_vector`],
		},
		{
			collectionName: `${prefix}session_chunks`,
			indexNames: [
				`${prefix}session_chunks_text`,
				`${prefix}session_chunks_vector`,
			],
		},
		...evidenceTargets,
		{
			collectionName: `${prefix}query_cache`,
			indexNames: [`${prefix}query_cache_vector`],
		},
		{
			collectionName: `${prefix}entities`,
			indexNames: ["entity_autocomplete"],
		},
		{
			collectionName: `${prefix}episodes`,
			indexNames: ["episode_autocomplete"],
		},
	]
}

function isLongMemEvalSearchIndexProfile(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE === "longmemeval" ||
		env.MEMONGO_SKIP_OPTIONAL_SEARCH_INDEXES === "1"
	)
}

function isRawSessionSearchIndexProfile(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const profile = env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE?.trim()
	const lane = env.MEMONGO_BENCHMARK_RETRIEVAL_LANE?.trim()
	return [profile, lane].some((value) =>
		["raw-session", "raw_session", "session"].includes(
			value?.toLowerCase() ?? "",
		),
	)
}

/**
 * Opt-in vector index structure. `flat` is the documented fit for
 * selective-prefilter multitenant queries (filters matching <5% of
 * documents) — exactly the scope/scopeRef pattern every lane uses.
 * Re-probed live on Atlas 8.3.7 (2026-07-30): field-level
 * indexingMethod:"flat" on an autoEmbed field is accepted and builds to
 * READY, so the 8.3.4 rejection recorded below no longer applies to this
 * one option. Default stays omit (server default HNSW); opting in via env
 * keeps the choice visible in benchmark run identity.
 */
function vectorIndexingMethodFromEnv(): "flat" | undefined {
	const raw = process.env.MEMONGO_VECTOR_INDEXING_METHOD?.trim().toLowerCase()
	if (!raw || raw === "hnsw") {
		return undefined
	}
	if (raw === "flat") {
		return "flat"
	}
	log.warn(
		`ignoring MEMONGO_VECTOR_INDEXING_METHOD="${raw}" (expected "flat" or "hnsw")`,
	)
	return undefined
}

function autoEmbedVectorField(
	path: string,
	quantization: "none" | "scalar" | "binary" = "none",
): Document {
	const indexingMethod = vectorIndexingMethodFromEnv()
	return {
		type: "autoEmbed",
		modality: "text",
		path,
		model: "voyage-4-large",
		...(indexingMethod ? { indexingMethod } : {}),
		// P3.4 probe-adopt: the configured quantization ships in the definition;
		// a server rejection is caught in ensureSearchIndexes, recorded in the
		// capability registry, and retried with the server default.
		...(quantization !== "none" ? { quantization } : {}),
	}
}

/**
 * storedSource include-lists for the search-lane vector indexes, from the
 * 2026-07-31 field-usage map of every consumer of $vectorSearch results
 * (issue #66). With `returnStoredSource: true` a query receives ONLY these
 * fields (plus _id), so each list is the union of everything the pipeline
 * projections and the JS mappers read — a missed field silently disappears
 * from results.
 *
 * Deliberately absent:
 * - events: recall pipelines $match on validAt/invalidAt AFTER
 *   $vectorSearch; if those fields were missing from stored source the
 *   $exists:false branches would pass every document and bi-temporal
 *   enforcement would silently die. Events also carry the largest corpus,
 *   so mirroring bodies into mongot is the most expensive place to start.
 * - query_cache: its `results` field is an unbounded array of serialized
 *   search results; storing it would inflate the index materially.
 * - memory_evidence: no latency-critical consumer.
 * Consolidator and novelty pipelines never pass returnStoredSource, so they
 * keep reading full documents regardless of what the index stores.
 *
 * provenance/artifact/metadata subdocuments are stored whole because
 * downstream code reads them with computed keys (e.g.
 * `provenance?.[key]` in mongodb-search-executor.ts).
 */
const VECTOR_STORED_SOURCE_INCLUDE: Record<string, string[]> = {
	chunks: [
		"path",
		"startLine",
		"endLine",
		"text",
		"source",
		"sessionId",
		"sourceEventIds",
		"updatedAt",
		"timestamp",
		"scope",
		"scopeRef",
		"canonicalId",
		"unit",
		"provenance",
		"metadata.sourceEventIds",
	],
	session_chunks: [
		"path",
		"startLine",
		"endLine",
		"text",
		"source",
		"sessionId",
		"sourceEventIds",
		"updatedAt",
		"timestamp",
		"scope",
		"scopeRef",
		"canonicalId",
		"unit",
		"provenance",
		"metadata.sourceEventIds",
	],
	kb_chunks: ["path", "startLine", "endLine", "text", "docId", "updatedAt"],
	structured_mem: [
		"type",
		"key",
		"value",
		"context",
		"confidence",
		"tags",
		"scope",
		"scopeRef",
		"state",
		"salience",
		"temporalScope",
		"sessionId",
		"updatedAt",
		"provenance",
		"sourceEventIds",
		"sourceReliability",
		"reinforcementCount",
		"validFrom",
		"validTo",
		"reviewAt",
		"lastConfirmedAt",
		"artifact",
	],
	procedures: [
		"procedureId",
		"searchText",
		"sessionId",
		"updatedAt",
		"state",
		"scope",
		"scopeRef",
		"provenance",
		"sourceEventIds",
		"validFrom",
		"validTo",
		"confidence",
	],
}

// P3.3: stored source is default-on from MongoDB 8.3.7 (the version that
// fixed the server rejection of the {include: [...]} form), with
// MEMONGO_VECTOR_STORED_SOURCE kept as an override — "0" kills it even when
// the version gate passes, "1" forces it on. The condition lives in the
// capability registry so it self-enables as servers advance.
function vectorStoredSourceEnabled(
	versionArray: unknown,
	deployment?: string,
): boolean {
	return isCapabilityEnabled("vector-stored-source", {
		versionArray,
		env: process.env,
		deployment,
	})
}

function withVectorStoredSource(
	definition: Document,
	collectionKind: string,
	versionArray?: unknown,
	deployment?: string,
): Document {
	const include = VECTOR_STORED_SOURCE_INCLUDE[collectionKind]
	if (!include || !vectorStoredSourceEnabled(versionArray, deployment)) {
		return definition
	}
	return { ...definition, storedSource: { include } }
}

/**
 * Build the vector search index definition for an auto-embedded text field.
 *
 * Exported so a live-server test can create one index from the exact shape
 * every collection ships, without paying for all fourteen.
 *
 * Deliberately carries no extra options. ensureSearchIndexes used to add
 * `storedSource: true` and `indexingMethod: "flat"` whenever buildInfo
 * reported MongoDB 8.3+. Verified against a live 8.3.4 cluster, the server
 * rejects the first outright — "storedSource: true is not supported for vector
 * indexes. Accepted values are include, exclude, or false" — and every
 * creation here is wrapped in a catch that only logs, so on 8.3 and newer all
 * seven vector indexes silently failed to create and ensureSearchIndexes
 * returned {text: true, vector: false}. No semantic retrieval at all, on
 * precisely the versions the gate was written to light up.
 *
 * The per-field options are not ours to choose either. The same cluster
 * rejects `quantization` ("Omit quantization to use the default (float)"),
 * `similarity` ("...the default (dotProduct)"), `numDimensions` ("The
 * embedding model determines dimensions automatically") and field-level
 * `indexingMethod` ("Omit indexingMethod to use default HNSW") on an autoEmbed
 * field: the embedding model determines all of them. So there is nothing here
 * to pin, and no irreversible choice to get wrong.
 *
 * Two exceptions have since opened up, both tracked in the capability
 * registry (mongodb-capability-registry.ts) so they self-enable as servers
 * advance:
 *
 * - Atlas 8.3.7 (re-probed live 2026-07-30) accepts field-level
 *   `indexingMethod: "flat"` on autoEmbed fields and builds the index to
 *   READY. autoEmbedVectorField therefore adds it behind the
 *   MEMONGO_VECTOR_INDEXING_METHOD opt-in.
 * - `storedSource` in the documented `{include: [...]}` object form ships
 *   from MongoDB 8.3.7 (P3.3) via withVectorStoredSource, naming every field
 *   the search projections read — the boolean `true` form remains rejected
 *   on every version.
 *
 * `quantization` is probe-adopted (P3.4): the configured value ships in the
 * definition and a server rejection degrades to the default at ensure time.
 */
export function buildAutoEmbedVectorDefinition(
	path: string,
	filterPaths: string[] = [],
	quantization: "none" | "scalar" | "binary" = "none",
): Document {
	return {
		fields: [
			autoEmbedVectorField(path, quantization),
			...filterPaths.map((filterPath) => ({
				type: "filter",
				path: filterPath,
			})),
		],
	}
}

/**
 * Strip quantization from autoEmbed fields — the retry shape after a server
 * rejection during probe-adopt (P3.4).
 */
function withoutFieldQuantization(definition: Document): Document {
	const fields = definition.fields
	if (!Array.isArray(fields)) {
		return definition
	}
	return {
		...definition,
		fields: fields.map((field: Document) =>
			field?.type === "autoEmbed" && "quantization" in field
				? Object.fromEntries(
						Object.entries(field).filter(([key]) => key !== "quantization"),
					)
				: field,
		),
	}
}

export async function waitForSearchIndexesQueryable(
	collection: Collection,
	{
		indexNames,
		timeoutMs = 60_000,
		pollMs = 1_000,
	}: {
		indexNames: string[]
		timeoutMs?: number
		pollMs?: number
	},
): Promise<SearchIndexWaitResult> {
	const deadline = Date.now() + timeoutMs
	let lastRelevant: SearchIndexDescription[] = []
	let lastError: string | undefined

	while (Date.now() < deadline) {
		try {
			lastRelevant = (await listSearchIndexes(collection)).filter((index) =>
				indexNames.includes(String(index.name ?? "")),
			)
			lastError = undefined
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
			await sleep(pollMs)
			continue
		}
		const byName = new Map(
			lastRelevant.map((index) => [String(index.name ?? ""), index]),
		)
		const failed = indexNames.filter((name) => {
			const index = byName.get(name)
			return index ? isSearchIndexFailed(index) : false
		})
		const pending = indexNames.filter((name) => {
			const index = byName.get(name)
			return !index || !isSearchIndexQueryable(index)
		})

		if (failed.length > 0) {
			return {
				ready: false,
				indexes: lastRelevant,
				pending,
				failed,
				...(lastError ? { lastError } : {}),
			}
		}
		if (pending.length === 0) {
			return {
				ready: true,
				indexes: lastRelevant,
				pending: [],
				failed: [],
			}
		}

		await sleep(pollMs)
	}

	const byName = new Map(
		lastRelevant.map((index) => [String(index.name ?? ""), index]),
	)
	const failed = indexNames.filter((name) => {
		const index = byName.get(name)
		return index ? isSearchIndexFailed(index) : false
	})
	const pending = indexNames.filter((name) => {
		const index = byName.get(name)
		return !index || !isSearchIndexQueryable(index)
	})
	return {
		ready: pending.length === 0 && failed.length === 0,
		indexes: lastRelevant,
		pending,
		failed,
		...(lastError ? { lastError } : {}),
	}
}

export function resolveSearchIndexReadinessTiming(
	env: NodeJS.ProcessEnv = process.env,
): {
	timeoutMs: number
	pollMs: number
} {
	const benchmarkStrict = env.MEMONGO_BENCHMARK_STRICT
	const searchReadyStrict = env.MEMONGO_STRICT_SEARCH_INDEX_READY
	const strictDefaultTimeoutMs =
		benchmarkStrict === "1" ||
		benchmarkStrict?.toLowerCase() === "true" ||
		searchReadyStrict === "1" ||
		searchReadyStrict?.toLowerCase() === "true"
			? 180_000
			: 60_000
	const timeoutMs = parsePositiveIntegerEnv(
		env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS,
		strictDefaultTimeoutMs,
	)
	const pollMs = parsePositiveIntegerEnv(
		env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS,
		1_000,
	)
	return { timeoutMs, pollMs }
}

function parsePositiveIntegerEnv(
	value: string | undefined,
	fallback: number,
): number {
	if (!value) {
		return fallback
	}
	const parsed = Number(value.trim())
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback
	}
	return Math.floor(parsed)
}

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
	void embeddingMode
	void numDimensions

	// Server version gates storedSource include-lists (P3.3) through the
	// capability registry; undefined (buildInfo unavailable) keeps them off.
	const serverVersionArray = await detectServerVersionArray(db)

	// Probe-adopt quantization (P3.4): the configured value ships in every
	// autoEmbed vector definition. If the server rejects it, record the
	// capability off in the registry and retry that index with the server
	// default — index creation never fails over a tuning knob.
	let activeQuantization = quantization
	const ensureVectorIndex = async (params: {
		collection: Collection
		name: string
		definition: Document
		label: string
	}): Promise<boolean> => {
		try {
			return await ensureNamedSearchIndex({ ...params, type: "vectorSearch" })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (activeQuantization !== "none" && msg.includes("quantization")) {
				activeQuantization = "none"
				recordCapabilityProbe("autoembed-quantization", false, deployment)
				log.warn(
					`server rejected quantization on autoEmbed index definitions; capability recorded off, using the server default: ${msg}`,
				)
				return await ensureNamedSearchIndex({
					...params,
					type: "vectorSearch",
					definition: withoutFieldQuantization(params.definition),
				})
			}
			throw err
		}
	}

	// 15 search indexes total: chunks, kb_chunks, structured_mem, procedures,
	// events, and session_chunks each get text + vector indexes, plus query_cache
	// gets 1 vector index, plus entities and episodes get 1 autocomplete index
	// each (P3.8). The optional evidence mirror adds two more indexes only when
	// explicitly enabled.
	// Keep the budget helper explicit so future constrained/free-tier profiles
	// can safely reduce index count without changing index definitions.
	const evidenceMirrorEnabled = isEvidenceMirrorEnabled()
	const rawSessionIndexProfile = isRawSessionSearchIndexProfile()
	const plannedSearchIndexCount = rawSessionIndexProfile
		? 1
		: evidenceMirrorEnabled
			? 17
			: 15
	const budget = assertIndexBudget(profile, plannedSearchIndexCount)
	const reducedBudget =
		!budget.withinBudget &&
		typeof budget.budget === "number" &&
		budget.budget >= 2
	if (!budget.withinBudget && !reducedBudget) {
		log.warn(
			`search index budget exceeded: planned=${budget.plannedSearchIndexes} budget=${budget.budget} profile=${profile}`,
		)
		return { text: false, vector: false }
	}
	if (reducedBudget) {
		log.warn(
			`search index budget tight (${budget.budget}/${budget.plannedSearchIndexes}): creating core chunks indexes only, skipping KB, structured memory, and procedure search indexes`,
		)
	}

	// Vector index definitions are built by buildAutoEmbedVectorDefinition (see
	// its doc comment): no version-gated extras, because the server rejects them.
	if (rawSessionIndexProfile) {
		const sessionChunks = sessionChunksCollection(db, prefix)
		try {
			const sessionVectorDef: Document = withVectorStoredSource(
				{
					fields: [
						autoEmbedVectorField("text", activeQuantization),
						{ type: "filter", path: "agentId" },
						{ type: "filter", path: "scope" },
						{ type: "filter", path: "scopeRef" },
						{ type: "filter", path: "sessionId" },
					],
				},
				"session_chunks",
				serverVersionArray,
				deployment,
			)
			const vectorCreated = await ensureVectorIndex({
				collection: sessionChunks,
				name: `${prefix}session_chunks_vector`,
				definition: sessionVectorDef,
				label: "session_chunks vector",
			})
			return { text: false, vector: vectorCreated }
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				return { text: false, vector: true }
			}
			if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: false, vector: false }
			}
			log.warn(`session_chunks vector search index creation failed: ${msg}`)
			return { text: false, vector: false }
		}
	}
	const longMemEvalIndexProfile = isLongMemEvalSearchIndexProfile()

	const chunks = chunksCollection(db, prefix)
	let textCreated = false
	let vectorCreated = false

	// MongoDB Search (text) index
	try {
		const textDef: Document = {
			mappings: {
				dynamic: false,
				fields: {
					text: { type: "string", analyzer: "lucene.standard" },
					source: { type: "token" },
					path: { type: "token" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					sessionId: { type: "token" },
					status: { type: "token" },
					updatedAt: { type: "date" },
				},
			},
		}
		textCreated = await ensureNamedSearchIndex({
			collection: chunks,
			name: `${prefix}chunks_text`,
			type: "search",
			definition: textDef,
			label: "chunks text",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			textCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: false, vector: false }
		} else {
			log.warn(`text search index creation failed: ${msg}`)
		}
	}

	// Vector Search index
	try {
		const vectorDef: Document = withVectorStoredSource(
			buildAutoEmbedVectorDefinition(
				"text",
				[
					"source",
					"path",
					"agentId",
					"scope",
					"scopeRef",
					"sessionId",
					"status",
				],
				activeQuantization,
			),
			"chunks",
			serverVersionArray,
			deployment,
		)

		vectorCreated = await ensureVectorIndex({
			collection: chunks,
			name: `${prefix}chunks_vector`,
			definition: vectorDef,
			label: "chunks vector",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			vectorCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: textCreated, vector: false }
		} else {
			log.warn(`vector search index creation failed: ${msg}`)
		}
	}

	// KB Chunks search indexes (skipped when budget is tight — core chunks indexes take priority)
	if (reducedBudget) {
		return { text: textCreated, vector: vectorCreated }
	}
	if (!longMemEvalIndexProfile) {
		const kbChunks = kbChunksCollection(db, prefix)
		try {
			const kbTextDef: Document = {
				mappings: {
					dynamic: false,
					fields: {
						text: { type: "string", analyzer: "lucene.standard" },
						path: { type: "token" },
						docId: { type: "token" },
						scopeRef: { type: "token" },
						updatedAt: { type: "date" },
					},
				},
			}
			textCreated = await ensureNamedSearchIndex({
				collection: kbChunks,
				name: `${prefix}kb_chunks_text`,
				type: "search",
				definition: kbTextDef,
				label: "kb_chunks text",
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				textCreated = true
			} else if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`kb_chunks text search index creation failed: ${msg}`)
			}
		}

		try {
			const kbFilterFields: Document[] = [
				{ type: "filter", path: "docId" },
				{ type: "filter", path: "path" },
				// Tenant isolation pre-filter for KB vector search (issue #27).
				{ type: "filter", path: "scopeRef" },
			]

			const kbVectorDef: Document = withVectorStoredSource(
				{
					fields: [
						autoEmbedVectorField("text", activeQuantization),
						...kbFilterFields,
					],
				},
				"kb_chunks",
				serverVersionArray,
				deployment,
			)

			vectorCreated = await ensureVectorIndex({
				collection: kbChunks,
				name: `${prefix}kb_chunks_vector`,
				definition: kbVectorDef,
				label: "kb_chunks vector",
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				vectorCreated = true
			} else if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`kb_chunks vector search index creation failed: ${msg}`)
			}
		}
	}

	// Structured Memory search indexes
	const structured = structuredMemCollection(db, prefix)
	try {
		const structTextDef: Document = {
			mappings: {
				dynamic: false,
				fields: {
					value: { type: "string", analyzer: "lucene.standard" },
					context: { type: "string", analyzer: "lucene.standard" },
					type: { type: "token" },
					key: { type: "token" },
					tags: { type: "token" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					state: { type: "token" },
					salience: { type: "token" },
					updatedAt: { type: "date" },
				},
			},
		}
		textCreated = await ensureNamedSearchIndex({
			collection: structured,
			name: `${prefix}structured_mem_text`,
			type: "search",
			definition: structTextDef,
			label: "structured_mem text",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			textCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: textCreated, vector: vectorCreated }
		} else {
			log.warn(`structured_mem text search index creation failed: ${msg}`)
		}
	}

	try {
		const structFilterFields: Document[] = [
			{ type: "filter", path: "type" },
			{ type: "filter", path: "tags" },
			{ type: "filter", path: "agentId" },
			{ type: "filter", path: "scope" },
			{ type: "filter", path: "scopeRef" },
			{ type: "filter", path: "state" },
			{ type: "filter", path: "salience" },
			{ type: "filter", path: "temporalScope" },
			{ type: "filter", path: "validFrom" },
			{ type: "filter", path: "validTo" },
		]

		const structVectorDef: Document = withVectorStoredSource(
			{
				fields: [
					autoEmbedVectorField("value", activeQuantization),
					...structFilterFields,
				],
			},
			"structured_mem",
			serverVersionArray,
			deployment,
		)

		vectorCreated = await ensureVectorIndex({
			collection: structured,
			name: `${prefix}structured_mem_vector`,
			definition: structVectorDef,
			label: "structured_mem vector",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			vectorCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: textCreated, vector: vectorCreated }
		} else {
			log.warn(`structured_mem vector search index creation failed: ${msg}`)
		}
	}

	const procedures = proceduresCollection(db, prefix)
	try {
		const procedureTextDef: Document = {
			mappings: {
				dynamic: false,
				fields: {
					name: { type: "string", analyzer: "lucene.standard" },
					searchText: { type: "string", analyzer: "lucene.standard" },
					intentTags: { type: "token" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					state: { type: "token" },
					updatedAt: { type: "date" },
				},
			},
		}
		textCreated = await ensureNamedSearchIndex({
			collection: procedures,
			name: `${prefix}procedures_text`,
			type: "search",
			definition: procedureTextDef,
			label: "procedures text",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			textCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: textCreated, vector: vectorCreated }
		} else {
			log.warn(`procedures text search index creation failed: ${msg}`)
		}
	}

	try {
		const procedureVectorDef: Document = withVectorStoredSource(
			{
				fields: [
					autoEmbedVectorField("searchText", activeQuantization),
					{ type: "filter", path: "intentTags" },
					{ type: "filter", path: "agentId" },
					{ type: "filter", path: "scope" },
					{ type: "filter", path: "scopeRef" },
					{ type: "filter", path: "state" },
					{ type: "filter", path: "validFrom" },
					{ type: "filter", path: "validTo" },
				],
			},
			"procedures",
			serverVersionArray,
			deployment,
		)

		vectorCreated = await ensureVectorIndex({
			collection: procedures,
			name: `${prefix}procedures_vector`,
			definition: procedureVectorDef,
			label: "procedures vector",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			vectorCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: textCreated, vector: vectorCreated }
		} else {
			log.warn(`procedures vector search index creation failed: ${msg}`)
		}
	}

	// Events search indexes (text + autoEmbed vector on body)
	const events = eventsCollection(db, prefix)
	try {
		const eventsTextDef: Document = {
			mappings: {
				dynamic: false,
				fields: {
					body: { type: "string", analyzer: "lucene.standard" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					sessionId: { type: "token" },
					role: { type: "token" },
					channel: { type: "token" },
					timestamp: { type: "date" },
				},
			},
		}
		textCreated = await ensureNamedSearchIndex({
			collection: events,
			name: `${prefix}events_text`,
			type: "search",
			definition: eventsTextDef,
			label: "events text",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			textCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: textCreated, vector: vectorCreated }
		} else {
			log.warn(`events text search index creation failed: ${msg}`)
		}
	}

	try {
		const eventsFilterFields: Document[] = [
			{ type: "filter", path: "agentId" },
			{ type: "filter", path: "scope" },
			{ type: "filter", path: "scopeRef" },
			{ type: "filter", path: "sessionId" },
			{ type: "filter", path: "role" },
			{ type: "filter", path: "channel" },
			{ type: "filter", path: "timestamp" },
			{ type: "filter", path: "validAt" },
			{ type: "filter", path: "invalidAt" },
		]
		const eventsVectorDef: Document = {
			fields: [
				autoEmbedVectorField("body", activeQuantization),
				...eventsFilterFields,
			],
		}
		vectorCreated = await ensureVectorIndex({
			collection: events,
			name: `${prefix}events_vector`,
			definition: eventsVectorDef,
			label: "events vector",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("already exists") || msg.includes("duplicate")) {
			vectorCreated = true
		} else if (isSearchIndexManagementUnavailable(msg)) {
			log.warn(`search index management unavailable: ${msg}`)
			return { text: textCreated, vector: vectorCreated }
		}
		if (!msg.includes("already exists") && !msg.includes("duplicate")) {
			log.warn(`events vector search index creation failed: ${msg}`)
		}
	}

	// Query Cache search index (autoEmbed on queryNorm)
	if (!longMemEvalIndexProfile) {
		const queryCache = queryCacheCollection(db, prefix)
		try {
			const cacheVectorDef: Document = {
				fields: [
					autoEmbedVectorField("queryNorm", activeQuantization),
					{ type: "filter", path: "agentId" },
					{ type: "filter", path: "scope" },
					{ type: "filter", path: "scopeRef" },
					{ type: "filter", path: "expiresAt" },
				],
			}
			vectorCreated = await ensureVectorIndex({
				collection: queryCache,
				name: `${prefix}query_cache_vector`,
				definition: cacheVectorDef,
				label: "query_cache vector",
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				vectorCreated = true
			} else if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`query_cache vector search index creation failed: ${msg}`)
			}
		}
	}

	// Session Chunks search indexes (Option B — dedicated session-evidence collection)
	if (!longMemEvalIndexProfile) {
		const sessionChunks = sessionChunksCollection(db, prefix)
		try {
			const sessionTextDef: Document = {
				mappings: {
					dynamic: false,
					fields: {
						text: { type: "string", analyzer: "lucene.standard" },
						agentId: { type: "token" },
						scope: { type: "token" },
						scopeRef: { type: "token" },
						sessionId: { type: "token" },
					},
				},
			}
			textCreated = await ensureNamedSearchIndex({
				collection: sessionChunks,
				name: `${prefix}session_chunks_text`,
				type: "search",
				definition: sessionTextDef,
				label: "session_chunks text",
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				textCreated = true
			} else if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`session_chunks text search index creation failed: ${msg}`)
			}
		}

		try {
			const sessionFilterFields: Document[] = [
				{ type: "filter", path: "agentId" },
				{ type: "filter", path: "scope" },
				{ type: "filter", path: "scopeRef" },
				{ type: "filter", path: "sessionId" },
			]
			const sessionVectorDef: Document = withVectorStoredSource(
				{
					fields: [
						autoEmbedVectorField("text", activeQuantization),
						...sessionFilterFields,
					],
				},
				"session_chunks",
				serverVersionArray,
				deployment,
			)
			vectorCreated = await ensureVectorIndex({
				collection: sessionChunks,
				name: `${prefix}session_chunks_vector`,
				definition: sessionVectorDef,
				label: "session_chunks vector",
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				vectorCreated = true
			} else if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`session_chunks vector search index creation failed: ${msg}`)
			}
		}
	}

	if (evidenceMirrorEnabled) {
		const memoryEvidence = memoryEvidenceCollection(db, prefix)
		try {
			const evidenceTextDef: Document = {
				mappings: {
					dynamic: false,
					fields: {
						text: { type: "string", analyzer: "lucene.standard" },
						agentId: { type: "token" },
						scope: { type: "token" },
						scopeRef: { type: "token" },
						sessionId: { type: "token" },
						unit: { type: "token" },
						status: { type: "token" },
						timestamp: { type: "date" },
					},
				},
			}
			textCreated = await ensureNamedSearchIndex({
				collection: memoryEvidence,
				name: `${prefix}memory_evidence_text`,
				type: "search",
				definition: evidenceTextDef,
				label: "memory_evidence text",
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				textCreated = true
			} else if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`memory_evidence text search index creation failed: ${msg}`)
			}
		}

		try {
			const evidenceFilterFields: Document[] = [
				{ type: "filter", path: "agentId" },
				{ type: "filter", path: "scope" },
				{ type: "filter", path: "scopeRef" },
				{ type: "filter", path: "sessionId" },
				{ type: "filter", path: "unit" },
				{ type: "filter", path: "status" },
				{ type: "filter", path: "timestamp" },
			]
			const evidenceVectorDef: Document = {
				fields: [
					autoEmbedVectorField("text", activeQuantization),
					...evidenceFilterFields,
				],
			}
			vectorCreated = await ensureVectorIndex({
				collection: memoryEvidence,
				name: `${prefix}memory_evidence_vector`,
				definition: evidenceVectorDef,
				label: "memory_evidence vector",
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("already exists") || msg.includes("duplicate")) {
				vectorCreated = true
			} else if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`memory_evidence vector search index creation failed: ${msg}`)
			}
		}
	}

	// Entity + episode autocomplete search indexes (separate from standard indexes)
	if (!longMemEvalIndexProfile) {
		try {
			await ensureEntityAutocompleteIndex(db, prefix)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`entity autocomplete search index creation failed: ${msg}`)
			}
		}
		try {
			await ensureEpisodeAutocompleteIndex(db, prefix)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (isSearchIndexManagementUnavailable(msg)) {
				log.warn(`search index management unavailable: ${msg}`)
				return { text: textCreated, vector: vectorCreated }
			} else {
				log.warn(`episode autocomplete search index creation failed: ${msg}`)
			}
		}
	}

	return { text: textCreated, vector: vectorCreated }
}
