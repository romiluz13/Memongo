// Atlas Search / Vector Search index definitions, readiness, and drift (P4.3 split from mongodb-schema.ts).
import type { Collection, Db, Document } from "mongodb"
import type {
	MemoryMongoDBDeploymentProfile,
	MemoryMongoDBEmbeddingMode,
} from "@memongo/lib"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

import { recordCapabilityProbe } from "./mongodb-capability-registry.js"
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import { assertIndexBudget } from "./mongodb-schema-budget.js"
import {
	chunksCollection,
	kbChunksCollection,
	structuredMemCollection,
	proceduresCollection,
	eventsCollection,
	queryCacheCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
} from "./mongodb-schema-collections.js"

// ---------------------------------------------------------------------------
// Search / Vector Search index creation
// ---------------------------------------------------------------------------

import {
	buildAutoEmbedVectorDefinition,
	ensureEntityAutocompleteIndex,
	ensureEpisodeAutocompleteIndex,
	isLongMemEvalSearchIndexProfile,
	isRawSessionSearchIndexProfile,
	autoEmbedVectorField,
	withVectorStoredSource,
	withoutFieldQuantization,
} from "./mongodb-schema-search-definitions.js"
import {
	detectServerVersionArray,
	ensureNamedSearchIndex,
	isSearchIndexManagementUnavailable,
} from "./mongodb-schema-search-readiness.js"

export {
	INDEX_AUTOEMBED_MODEL,
	buildAutoEmbedVectorDefinition,
	ensureEntityAutocompleteIndex,
	ensureEpisodeAutocompleteIndex,
	getExpectedSearchIndexTargets,
	waitForSearchIndexesQueryable,
	resolveSearchIndexReadinessTiming,
} from "./mongodb-schema-search-definitions.js"
export {
	detectServerVersionArray,
	isSearchIndexQueryable,
	isSearchIndexReadyWithFilterFields,
	isEventsVectorBitemporalPrefilterReady,
	listSearchIndexes,
	isSearchIndexManagementAvailable,
	isSearchIndexTypeCompatible,
	sleep,
} from "./mongodb-schema-search-readiness.js"
export type {
	SearchIndexDescription,
	SearchIndexTarget,
	SearchIndexWaitResult,
} from "./mongodb-schema-search-readiness.js"

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
						// C-005: the Option B lane filters unexpired docs in
						// its $vectorSearch filter (search-v2 sessionFilter).
						{ type: "filter", path: "expiresAt" },
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
		// C-005: every chunks read composes the unexpired clause
		// (buildUnexpiredClause on expiresAt) into its $vectorSearch filter,
		// so expiresAt must be declared as a filter field here or mongot
		// rejects the query ("Path 'expiresAt' needs to be indexed as
		// filter") — mirroring query_cache_vector.
		// C-026: the chunk lanes now compose the bitemporal guard (validAt /
		// invalidAt null-or-range arms) into the same $vectorSearch filter,
		// so both fields join the declared filter paths — mirroring
		// events_vector, which declares them for the events lane.
		const chunksFilterPaths = [
			"source",
			"path",
			"agentId",
			"scope",
			"scopeRef",
			"sessionId",
			"status",
			"expiresAt",
			"validAt",
			"invalidAt",
		]
		const vectorDef: Document = withVectorStoredSource(
			buildAutoEmbedVectorDefinition(
				"text",
				chunksFilterPaths,
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
				// C-005: the Option B lane filters unexpired docs in its
				// $vectorSearch filter (search-v2 sessionFilter).
				{ type: "filter", path: "expiresAt" },
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
