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
	isSearchIndexQueryable,
	isSearchIndexTypeCompatible,
	listSearchIndexes,
	sleep,
} from "./mongodb-schema-search-indexes.js"
import type { DetectedCapabilities } from "./mongodb-schema-types.js"

// ---------------------------------------------------------------------------
// Capability detection (probe what the connected MongoDB supports)
// ---------------------------------------------------------------------------

function isStageUnsupported(message: string): boolean {
	const lower = message.toLowerCase()
	return (
		lower.includes("unrecognized pipeline stage") ||
		lower.includes("unknown top level operator") ||
		lower.includes("requires additional configuration") ||
		lower.includes("not allowed") ||
		lower.includes("not supported")
	)
}

async function canReturnStoredSource(
	db: Db,
	collectionName: string,
	indexName: string,
	definition: Record<string, unknown>,
): Promise<boolean> {
	const fields = Array.isArray(definition.fields) ? definition.fields : []
	const autoEmbedField = fields.find(
		(field): field is { type: "autoEmbed"; path: string } =>
			typeof field === "object" &&
			field !== null &&
			(field as { type?: unknown }).type === "autoEmbed" &&
			typeof (field as { path?: unknown }).path === "string",
	)
	if (!autoEmbedField) {
		return false
	}

	try {
		await db
			.collection(collectionName)
			.aggregate([
				{
					$vectorSearch: {
						index: indexName,
						path: autoEmbedField.path,
						query: { text: "__memongo_stored_source_capability_probe__" },
						numCandidates: 1,
						limit: 1,
						returnStoredSource: true,
					},
				},
				{ $limit: 1 },
			])
			.toArray()
		return true
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		log.warn(
			`storedSource operational probe failed for ${indexName}; disabling returnStoredSource: ${message}`,
		)
		return false
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
): Promise<DetectedCapabilities> {
	const result: DetectedCapabilities = {
		vectorSearch: false,
		textSearch: false,
		scoreFusion: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
	}

	// Prefer server-version gating for fusion stages because the MongoDB docs
	// define availability by server version. Fall back to stage probes only when
	// buildInfo is unavailable.
	let versionArray: unknown
	try {
		const buildInfo = await db.admin().command({ buildInfo: 1 })
		versionArray = (buildInfo as { versionArray?: unknown }).versionArray
		result.rankFusion = serverVersionAtLeast(versionArray, 8, 1)
		result.scoreFusion = serverVersionAtLeast(versionArray, 8, 3)
		// storedSource and vectorIndexMethod stay false: these describe what
		// THIS deployment's indexes were built with, not what the server
		// version could support. ensureSearchIndexes ships auto-embedding
		// indexes with neither option, so claiming them from a version number
		// would send returnStoredSource: true at indexes that store nothing.
		// Whoever re-enables stored source must set this from the index
		// definition, not from buildInfo.
	} catch {
		try {
			await db
				.collection("__probe__")
				.aggregate([
					{
						$rankFusion: {
							input: {
								pipelines: {
									a: [{ $match: { _id: null } }],
									b: [{ $match: { _id: null } }],
								},
							},
						},
					},
					{ $limit: 1 },
				])
				.toArray()
			result.rankFusion = true
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (!isStageUnsupported(msg)) {
				result.rankFusion = true
			}
		}

		try {
			await db
				.collection("__probe__")
				.aggregate([
					{
						$scoreFusion: {
							input: {
								pipelines: { a: [{ $match: { _id: null } }] },
								normalization: "none",
							},
						},
					},
					{ $limit: 1 },
				])
				.toArray()
			result.scoreFusion = true
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (!isStageUnsupported(msg)) {
				result.scoreFusion = true
			}
		}
	}

	// Search capability means the concrete serving indexes are queryable. Index
	// management availability alone is insufficient: an empty or PENDING index
	// list cannot serve either retrieval lane.
	if (probeCollectionName) {
		try {
			const indexes = await listSearchIndexes(
				db.collection(probeCollectionName),
			)
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
			// storedSource reflects what the serving index was BUILT with (see
			// the scar above): true only when the probe vector index definition
			// actually carries a stored-source config AND the registry gate is
			// open (MongoDB 8.3.7+, or MEMONGO_VECTOR_STORED_SOURCE=1; "0" kills
			// it regardless). The server may stamp `storedSource: false` as a
			// default — that is not enabled.
			const vectorDefinition =
				vectorIndex?.latestDefinition ?? vectorIndex?.definition
			const storedSourceConfig = vectorDefinition?.storedSource
			const storedSourceConfigured =
				result.vectorSearch &&
				isCapabilityEnabled("vector-stored-source", {
					versionArray,
					env: process.env,
					deployment,
				}) &&
				typeof storedSourceConfig === "object" &&
				storedSourceConfig !== null
			result.storedSource =
				storedSourceConfigured &&
				vectorDefinition !== undefined &&
				(await canReturnStoredSource(
					db,
					probeCollectionName,
					`${probeCollectionName}_vector`,
					vectorDefinition,
				))
		} catch {
			// Search index management is unavailable on this deployment.
		}
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

/**
 * C-016: live search-lane readiness probe. One bounded index-status round
 * trip (listSearchIndexes on the probe collection) that answers whether the
 * concrete serving indexes are queryable RIGHT NOW — the same checks
 * `detectCapabilities` applies at boot, but without the buildInfo/fusion
 * probes, so it is cheap enough for a readiness endpoint. Unlike the boot
 * snapshot, this catches a mongot that died after boot or an index an
 * operator dropped/rebuilt mid-process.
 *
 * Transport errors (search index management unreachable, mongot down)
 * propagate to the caller — a probe that cannot answer is a failure signal,
 * not a silent false.
 */
export async function probeSearchLaneReadiness(
	db: Db,
	probeCollectionName: string,
): Promise<{ vectorSearch: boolean; textSearch: boolean }> {
	const indexes = await listSearchIndexes(db.collection(probeCollectionName))
	const textIndex = indexes.find(
		(index) => index.name === `${probeCollectionName}_text`,
	)
	const vectorIndex = indexes.find(
		(index) => index.name === `${probeCollectionName}_vector`,
	)
	return {
		textSearch:
			textIndex !== undefined &&
			isSearchIndexTypeCompatible(textIndex.type, "search") &&
			isSearchIndexQueryable(textIndex),
		vectorSearch:
			vectorIndex !== undefined &&
			isSearchIndexTypeCompatible(vectorIndex.type, "vectorSearch") &&
			isSearchIndexQueryable(vectorIndex),
	}
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

	return latest
}
