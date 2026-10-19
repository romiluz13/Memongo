// Atlas Search / Vector Search index definitions, readiness, and drift (P4.3 split from mongodb-schema.ts).
import type { Collection, Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")
import { sortObject } from "./search-utils.js"
import {
	reconcileRequiredIndex,
	verifyServerVersion,
} from "./mongodb-boot-contract.js"

// ---------------------------------------------------------------------------
// Search / Vector Search index creation
// ---------------------------------------------------------------------------

export function isSearchIndexManagementUnavailable(message: string): boolean {
	return (
		message.includes("Search Index Management service") ||
		message.includes("Error connecting to Search Index Management service")
	)
}

// Version gating goes through serverVersionAtLeast from the capability
// registry (mongodb-capability-registry.ts), so every gate in this file and
// the registry share one comparison.

// Exported for sibling schema modules; not part of the mongodb-schema.js
// public surface. An unreadable version is a typed boot failure, never
// "unknown".
export async function detectServerVersionArray(db: Db): Promise<unknown> {
	return verifyServerVersion(db)
}

export type SearchIndexDescription = {
	name?: string
	status?: string
	type?: string
	queryable?: boolean
	definition?: Document
	statusDetail?: Array<{
		mainIndex?: { queryable?: boolean; status?: string; definition?: Document }
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

export const SEARCH_INDEX_READY_STATUSES = new Set(["READY", "ACTIVE"])
export const SEARCH_INDEX_FAILED_STATUSES = new Set(["FAILED"])

// Exported for sibling schema modules (capabilities); not part of the
// mongodb-schema.js public surface.
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function extractNestedQueryableStates(
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

export function extractNestedStatuses(index: SearchIndexDescription): string[] {
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
	if (expectedType && !isSearchIndexTypeCompatible(index, expectedType)) {
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

export function isSearchIndexFailed(index: SearchIndexDescription): boolean {
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
	return (await collection
		.aggregate([{ $listSearchIndexes: {} }])
		.toArray()) as SearchIndexDescription[]
}

/**
 * Compute a signature of the code-owned parts of a search index definition.
 * We compare only the fields the code controls (mappings, fields, similarity,
 * type, numDimensions, path) — NOT the full normalized definition, because the
 * server may add default values (e.g. `storedSource: false`, `dynamic: true`) to
 * `latestDefinition` that cause full-JSON equality to spuriously report drift
 * and trigger a rebuild on every boot.
 */
export function searchIndexDefinitionSignature(definition: Document): string {
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

function isDocument(value: unknown): value is Document {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The type a listed Search index serves, or undefined when it cannot be read.
 * $listSearchIndexes documents no `type` field and the server omits it (CI
 * run 39214244063 and real-e2e-v2 both saw it undefined), so the definition
 * decides when it is absent: a search definition requires `mappings`, a
 * vectorSearch definition requires `fields`.
 */
export function servedSearchIndexType(
	index: SearchIndexDescription,
): "search" | "vectorSearch" | undefined {
	if (index.type === "search") return "search"
	// Atlas Local reports vectorSearch indexes backed by autoEmbed as `autoEmbed`.
	if (index.type === "vectorSearch" || index.type === "autoEmbed") {
		return "vectorSearch"
	}
	if (index.type !== undefined) return undefined
	const definition =
		index.latestDefinition ??
		index.definition ??
		index.statusDetail?.find((host) => host.mainIndex?.definition)?.mainIndex
			?.definition
	if (!isDocument(definition)) return undefined
	if (isDocument(definition.mappings)) return "search"
	if (Array.isArray(definition.fields)) return "vectorSearch"
	return undefined
}

export function isSearchIndexTypeCompatible(
	index: SearchIndexDescription,
	expected: "search" | "vectorSearch",
): boolean {
	return servedSearchIndexType(index) === expected
}

/**
 * Create or update one Search index toward its definition; never drops.
 * Every failure is a typed MemongoBootError (no inspect-then-create guess,
 * no warn on an incompatible type or a missing update API).
 */
export async function ensureNamedSearchIndex(params: {
	collection: Collection
	name: string
	type: "search" | "vectorSearch"
	definition: Document
	label: string
}): Promise<boolean> {
	await reconcileRequiredIndex(params.collection, {
		collectionName: params.collection.collectionName,
		name: params.name,
		type: params.type,
		definition: params.definition,
		label: params.label,
	})
	return true
}
