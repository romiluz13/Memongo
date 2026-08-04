// Atlas Search / Vector Search index definitions, readiness, and drift (P4.3 split from mongodb-schema.ts).
import type { Collection, Db, Document } from "mongodb"
import type { MemoryMongoDBDeploymentProfile } from "@memongo/lib"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

import { isCapabilityEnabled } from "./mongodb-capability-registry.js"
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import { assertIndexBudget } from "./mongodb-schema-budget.js"
import {
	entitiesCollection,
	episodesCollection,
} from "./mongodb-schema-collections.js"

// ---------------------------------------------------------------------------
// Search / Vector Search index creation
// ---------------------------------------------------------------------------

import {
	ensureNamedSearchIndex,
	isSearchIndexFailed,
	isSearchIndexQueryable,
	listSearchIndexes,
	sleep,
	type SearchIndexDescription,
	type SearchIndexTarget,
	type SearchIndexWaitResult,
} from "./mongodb-schema-search-readiness.js"

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

export function isLongMemEvalSearchIndexProfile(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE === "longmemeval" ||
		env.MEMONGO_SKIP_OPTIONAL_SEARCH_INDEXES === "1"
	)
}

export function isRawSessionSearchIndexProfile(
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
export function vectorIndexingMethodFromEnv(): "flat" | undefined {
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

export function autoEmbedVectorField(
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
export const VECTOR_STORED_SOURCE_INCLUDE: Record<string, string[]> = {
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
export function vectorStoredSourceEnabled(
	versionArray: unknown,
	deployment?: string,
): boolean {
	return isCapabilityEnabled("vector-stored-source", {
		versionArray,
		env: process.env,
		deployment,
	})
}

export function withVectorStoredSource(
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
export function withoutFieldQuantization(definition: Document): Document {
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

export function parsePositiveIntegerEnv(
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
