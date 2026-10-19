// Atlas Search / Vector Search index definitions, readiness, and drift (P4.3 split from mongodb-schema.ts).
import type { Collection, Db, Document } from "mongodb"
import type { MemoryMongoDBDeploymentProfile } from "@memongo/lib"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

import { reconcileRequiredIndex } from "./mongodb-boot-contract.js"
import { bootConfigError } from "./mongodb-boot-errors.js"
import { isCapabilityEnabled } from "./mongodb-capability-registry.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"

// ---------------------------------------------------------------------------
// Search / Vector Search index creation
// ---------------------------------------------------------------------------

import {
	isSearchIndexFailed,
	isSearchIndexQueryable,
	listSearchIndexes,
	sleep,
	type SearchIndexDescription,
	type SearchIndexTarget,
	type SearchIndexWaitResult,
} from "./mongodb-schema-search-readiness.js"

async function ensureManifestIndex(
	db: Db,
	prefix: string,
	name: string,
): Promise<void> {
	const entry = buildRequiredIndexManifest({ prefix, env: {} }).find(
		(candidate) => candidate.name === name,
	)
	if (!entry) {
		throw new Error(`${name} is not in the required-index manifest`)
	}
	await reconcileRequiredIndex(db.collection(entry.collectionName), entry)
}

/** Entity autocomplete index (manifest row `entity_autocomplete`). */
export async function ensureEntityAutocompleteIndex(
	db: Db,
	prefix: string,
): Promise<void> {
	await ensureManifestIndex(db, prefix, "entity_autocomplete")
}

/** Episode autocomplete index (manifest row `episode_autocomplete`). */
export async function ensureEpisodeAutocompleteIndex(
	db: Db,
	prefix: string,
): Promise<void> {
	await ensureManifestIndex(db, prefix, "episode_autocomplete")
}

/**
 * The manifest's index names grouped by collection. The profile argument is
 * kept for callers; every supported profile carries the full manifest.
 */
export function getExpectedSearchIndexTargets(
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
): SearchIndexTarget[] {
	void profile
	const targets = new Map<string, string[]>()
	for (const entry of buildRequiredIndexManifest({ prefix })) {
		const names = targets.get(entry.collectionName) ?? []
		names.push(entry.name)
		targets.set(entry.collectionName, names)
	}
	return [...targets].map(([collectionName, indexNames]) => ({
		collectionName,
		indexNames,
	}))
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

/**
 * The autoEmbed model hardcoded in every vector index definition.
 * Exported as the single source of truth so guardrails can compare against
 * the same value the index definitions use — see embedding-validation.ts.
 */
export const INDEX_AUTOEMBED_MODEL = "voyage-4-large"

export function autoEmbedVectorField(
	path: string,
	quantization: "none" | "scalar" | "binary" = "none",
): Document {
	const indexingMethod = vectorIndexingMethodFromEnv()
	return {
		type: "autoEmbed",
		modality: "text",
		path,
		model: INDEX_AUTOEMBED_MODEL,
		...(indexingMethod ? { indexingMethod } : {}),
		// "none" omits the option and preserves the server default.
		// Explicit scalar/binary requests are never retried with omission.
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
 * That historical 8.3.4 probe also rejected explicit quantization. It does
 * not establish the default or supported options on a current deployment.
 * Explicit scalar/binary requests now retain their meaning or fail; omission
 * leaves the server default in effect. The same historical cluster rejected
 * `similarity`, `numDimensions`, and field-level `indexingMethod`; later
 * indexing-method support is described below.
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
 * Explicit quantization ships unchanged; rejection must not substitute the
 * server default. "none" omits the field without asserting float precision.
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

/**
 * The boot readiness deadline (one total 180 s by default) and the metadata
 * poll interval. Overrides must be positive integers; anything else fails
 * boot instead of silently using the default.
 */
export function resolveSearchIndexReadinessTiming(
	env: NodeJS.ProcessEnv = process.env,
): {
	timeoutMs: number
	pollMs: number
} {
	return {
		timeoutMs: parsePositiveIntegerEnv(
			env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS,
			180_000,
			"MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS",
		),
		pollMs: parsePositiveIntegerEnv(
			env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS,
			1_000,
			"MEMONGO_SEARCH_INDEX_READINESS_POLL_MS",
		),
	}
}

export function parsePositiveIntegerEnv(
	value: string | undefined,
	defaultValue: number,
	setting = "setting",
): number {
	if (value === undefined || value.trim() === "") {
		return defaultValue
	}
	const parsed = Number(value.trim())
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw bootConfigError(
			setting,
			`${setting} "${value}" is not a positive integer number of milliseconds`,
		)
	}
	return parsed
}
