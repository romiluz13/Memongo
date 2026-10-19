// Capability detection — probe what the connected MongoDB supports (P4.3 split from mongodb-schema.ts).
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

import {
	evaluateCapabilityGates,
	isCapabilityEnabled,
	logDisabledCapabilityGates,
	serverVersionAtLeast,
} from "./mongodb-capability-registry.js"
import {
	classifySearchIndexError,
	verifyServerVersion,
} from "./mongodb-boot-contract.js"
import { MemongoBootError } from "./mongodb-boot-errors.js"
import {
	isSearchIndexQueryable,
	isSearchIndexTypeCompatible,
	listSearchIndexes,
	sleep,
	type SearchIndexDescription,
} from "./mongodb-schema-search-readiness.js"
import type { DetectedCapabilities } from "./mongodb-schema-types.js"

// ---------------------------------------------------------------------------
// Capability detection (what the connected MongoDB serves)
// ---------------------------------------------------------------------------
//
// M2: every probe error is a typed MemongoBootError. There is no fusion stage
// probe whose error counts as "supported", no empty catch around
// $listSearchIndexes and no $vectorSearch storedSource probe (it embedded a
// query string, a paid call at boot).

async function listIndexesTyped(
	db: Db,
	collectionName: string,
): Promise<SearchIndexDescription[]> {
	try {
		return await listSearchIndexes(db.collection(collectionName))
	} catch (err) {
		throw classifySearchIndexError(err, {
			collection: collectionName,
			operation: "$listSearchIndexes",
		})
	}
}

export async function detectCapabilities(
	db: Db,
	probeCollectionName?: string,
	/**
	 * B10: credential-free deployment identity (mongodbDeploymentIdentity) so
	 * capability gate evaluation reads this deployment's probe outcomes only.
	 */
	deployment?: string,
	/**
	 * #101 R2: collections whose `<collection>_text` Search index backs a
	 * text tier; each is listed in `queryableSearchIndexes` only when that
	 * index is queryable now.
	 */
	textTierCollections: readonly string[] = [],
): Promise<DetectedCapabilities> {
	const result: DetectedCapabilities = {
		vectorSearch: false,
		textSearch: false,
		scoreFusion: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
	}

	// Fusion availability is defined by server version (rankFusion 8.1+,
	// scoreFusion 8.3+). An unreadable version fails typed.
	const versionArray: unknown = await verifyServerVersion(db)
	result.rankFusion = serverVersionAtLeast(versionArray, 8, 1)
	result.scoreFusion = serverVersionAtLeast(versionArray, 8, 3)

	// Search capability means the concrete serving indexes are queryable. Index
	// management availability alone is insufficient: an empty or PENDING index
	// list cannot serve either retrieval lane.
	if (probeCollectionName) {
		const indexes = await listIndexesTyped(db, probeCollectionName)
		const textIndex = indexes.find(
			(index) => index.name === `${probeCollectionName}_text`,
		)
		const vectorIndex = indexes.find(
			(index) => index.name === `${probeCollectionName}_vector`,
		)
		result.textSearch =
			textIndex !== undefined &&
			isSearchIndexTypeCompatible(textIndex.type, "search") &&
			isSearchIndexQueryable(textIndex)
		result.vectorSearch =
			vectorIndex !== undefined &&
			isSearchIndexTypeCompatible(vectorIndex.type, "vectorSearch") &&
			isSearchIndexQueryable(vectorIndex)
		// storedSource reflects what the serving index was BUILT with: true
		// only when the vector index definition carries a stored-source config
		// AND the registry gate is open (MongoDB 8.3.7+, or
		// MEMONGO_VECTOR_STORED_SOURCE=1; "0" kills it regardless). The server
		// may stamp `storedSource: false` as a default; that is not enabled.
		const vectorDefinition =
			vectorIndex?.latestDefinition ?? vectorIndex?.definition
		const storedSourceConfig = vectorDefinition?.storedSource
		result.storedSource =
			result.vectorSearch &&
			isCapabilityEnabled("vector-stored-source", {
				versionArray,
				env: process.env,
				deployment,
			}) &&
			typeof storedSourceConfig === "object" &&
			storedSourceConfig !== null
	}

	if (textTierCollections.length > 0) {
		const queryable: string[] = []
		for (const collectionName of textTierCollections) {
			const name = `${collectionName}_text`
			const textIndex = (await listIndexesTyped(db, collectionName)).find(
				(index) => index.name === name,
			)
			if (
				textIndex !== undefined &&
				isSearchIndexTypeCompatible(textIndex.type, "search") &&
				isSearchIndexQueryable(textIndex)
			) {
				queryable.push(name)
			}
		}
		result.queryableSearchIndexes = queryable
	}

	// Capability re-enable registry (P3.6): every gated feature self-evaluates
	// here so a server upgrade flips it on without a code change. The
	// build-side decisions (withVectorStoredSource, ensureSearchIndexes)
	// consult the same gates; probe-based results above stay dominant for
	// what the serving indexes were actually built with.
	result.capabilityGates = evaluateCapabilityGates({
		versionArray,
		env: process.env,
		deployment,
	})
	logDisabledCapabilityGates({ versionArray, env: process.env, deployment })

	log.info(`detected capabilities: ${JSON.stringify(result)}`)
	return result
}

export async function waitForSearchCapabilities(
	db: Db,
	probeCollectionName: string | undefined,
	{
		timeoutMs = 60_000,
		pollMs = 1_000,
		requireVector = true,
		requireText = true,
		deployment,
	}: {
		timeoutMs?: number
		pollMs?: number
		requireVector?: boolean
		requireText?: boolean
		/** B10: credential-free deployment identity for probe-scoped gates. */
		deployment?: string
	} = {},
): Promise<DetectedCapabilities> {
	const deadline = Date.now() + timeoutMs
	let latest: DetectedCapabilities = {
		vectorSearch: false,
		textSearch: false,
		scoreFusion: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
	}

	while (Date.now() < deadline) {
		latest = await detectCapabilities(db, probeCollectionName, deployment)
		const vectorReady = !requireVector || latest.vectorSearch
		const textReady = !requireText || latest.textSearch
		if (vectorReady && textReady) {
			return latest
		}
		await sleep(pollMs)
	}

	throw new MemongoBootError(
		{
			code: "index-not-ready",
			requirement: "queryable serving Search indexes",
			collection: probeCollectionName,
		},
		`Search capabilities were not ready after ${timeoutMs} ms (vectorSearch=${latest.vectorSearch}, textSearch=${latest.textSearch})`,
	)
}
