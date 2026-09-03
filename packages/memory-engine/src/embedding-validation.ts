/**
 * Guardrails 1 & 2: embedding model consistency checks that make silent
 * failures fail loudly at startup.
 *
 * Adapted from mongodb-partners/agent-memory (battle-tested Python framework):
 * - Guardrail 1 ← embedding_check.py:expected_dimension()
 * - Guardrail 2 ← migrations.py:find_stranding_dimension_changes() +
 *   memory.py:_refuse_to_strand_existing_vectors()
 *
 * Architectural context: Memongo runs in embeddingMode "automated" exclusively.
 * Atlas autoEmbed generates vectors server-side at index time; production code
 * never writes embedding vectors. These guardrails operate at startup, before
 * any index reconciliation, to catch configuration drift that would silently
 * degrade or expensively re-embed the entire collection.
 */
import type { Db } from "mongodb"
import {
	formatErrorMessage,
	type MemoryMongoDBDeploymentProfile,
} from "@memongo/lib"
import { KNOWN_MODEL_DIMENSIONS } from "./backend-config.js"
import {
	INDEX_AUTOEMBED_MODEL,
	getExpectedSearchIndexTargets,
} from "./mongodb-schema-search-definitions.js"
import {
	listSearchIndexes,
	type SearchIndexDescription,
} from "./mongodb-schema-search-readiness.js"

// ---------------------------------------------------------------------------
// Guardrail 1: Query-Model vs Index-Model Dimension Consistency Check
// ---------------------------------------------------------------------------

export class EmbeddingModelMismatchError extends Error {
	readonly queryModel: string
	readonly indexModel: string
	readonly queryDimension: number | undefined
	readonly indexDimension: number | undefined

	constructor(queryModel: string, indexModel: string) {
		const queryDim = KNOWN_MODEL_DIMENSIONS[queryModel]
		const indexDim = KNOWN_MODEL_DIMENSIONS[indexModel]
		super(
			`Refusing to start: query embedding model "${queryModel}" ` +
				`(${queryDim ?? "unknown"} dimensions) does not match the autoEmbed ` +
				`index model "${indexModel}" (${indexDim ?? "unknown"} dimensions). ` +
				`$vectorSearch would silently return nothing — no error, no visible ` +
				`symptom, recall goes empty.\n` +
				`  • Set MEMONGO_QUERY_EMBEDDING_MODEL to a model with the same ` +
				`dimensions as "${indexModel}".\n` +
				`  • Or update the autoEmbed index model in autoEmbedVectorField() ` +
				`to match.`,
		)
		this.name = "EmbeddingModelMismatchError"
		this.queryModel = queryModel
		this.indexModel = indexModel
		this.queryDimension = queryDim
		this.indexDimension = indexDim
	}
}

export function isEmbeddingModelMismatchError(
	err: unknown,
): err is EmbeddingModelMismatchError {
	return err instanceof Error && err.name === "EmbeddingModelMismatchError"
}

/**
 * Verify that the configured query embedding model produces vectors in the
 * same dimension space as the model used in the autoEmbed index definition.
 *
 * Returns silently if dimensions match. Throws EmbeddingModelMismatchError
 * if they differ. If either model's dimensions are unknown (not in
 * KNOWN_MODEL_DIMENSIONS), the check is skipped — matching agent-memory's
 * tolerant pattern in expected_dimension() where "None means no declared
 * width to compare against" rather than a failure.
 *
 * Copied from agent_memory/core/embedding_check.py:expected_dimension()
 * (lines 39-51). The spirit is the same; the insertion point differs because
 * Memongo has no client-side write path — the check moves from pre-write to
 * startup.
 */
export function assertQueryModelDimensionsMatch(queryModel: string): void {
	const queryDim = KNOWN_MODEL_DIMENSIONS[queryModel]
	const indexDim = KNOWN_MODEL_DIMENSIONS[INDEX_AUTOEMBED_MODEL]
	if (queryDim === undefined || indexDim === undefined) {
		// Tolerant: unknown dimensions are not a finding. See agent-memory's
		// expected_dimension(): "None means no declared width to compare
		// against rather than zero."
		return
	}
	if (queryDim !== indexDim) {
		throw new EmbeddingModelMismatchError(queryModel, INDEX_AUTOEMBED_MODEL)
	}
}

// ---------------------------------------------------------------------------
// Guardrail 2: Index Model Migration Refusal
// ---------------------------------------------------------------------------

export type ModelMigrationFinding = {
	collectionName: string
	indexName: string
	existingModel: string
	wantedModel: string
	documentCount: number
}

export class EmbeddingModelMigrationError extends Error {
	readonly findings: ModelMigrationFinding[]

	constructor(findings: ModelMigrationFinding[]) {
		const detail = findings
			.map(
				(f) =>
					`  ${f.collectionName}.${f.indexName}: index uses model ` +
					`"${f.existingModel}", config wants "${f.wantedModel}", ` +
					`and ${f.documentCount} document(s) would be re-embedded ` +
					`server-side with the new model`,
			)
			.join("\n")
		super(
			`Refusing to start: the autoEmbed index model changed and existing ` +
				`documents would be re-embedded.\n${detail}\n\n` +
				`Changing the autoEmbed model triggers a full server-side re-embed ` +
				`of every document — consuming embedding API calls, billing, and ` +
				`a rebuild window where queries still run against the old index. ` +
				`If the rebuild fails, the index goes FAILED or STALE.\n` +
				`Choose one:\n` +
				`  • Restore the previous autoEmbed model to avoid the re-embed.\n` +
				`  • Confirm the change is intentional and set ` +
				`MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE=true to proceed.\n` +
				`  • Drop the affected collections if the history is expendable.`,
		)
		this.name = "EmbeddingModelMigrationError"
		this.findings = findings
	}
}

export function isEmbeddingModelMigrationError(
	err: unknown,
): err is EmbeddingModelMigrationError {
	return err instanceof Error && err.name === "EmbeddingModelMigrationError"
}

/**
 * Extract the autoEmbed model from an existing search index definition.
 * Adapted from agent-memory's _get_existing_dims() (migrations.py:499-503),
 * which extracts numDimensions from a "vector" field. For autoEmbed indexes,
 * we extract the "model" from an "autoEmbed" field instead.
 *
 * Per MongoDB docs, $listSearchIndexes returns the index definition in the
 * `latestDefinition` field. There is no top-level `definition` field in
 * current server output (it appears only nested in statusDetail); the
 * fallback is retained for forward compatibility with older server versions.
 */
function extractAutoEmbedModel(
	indexInfo: Pick<SearchIndexDescription, "latestDefinition" | "definition">,
): string | undefined {
	const def = indexInfo.latestDefinition ?? indexInfo.definition
	if (!def || !Array.isArray(def.fields)) return undefined
	for (const field of def.fields) {
		if (
			typeof field === "object" &&
			field !== null &&
			(field as { type?: string }).type === "autoEmbed"
		) {
			return (field as { model?: string }).model
		}
	}
	return undefined
}

/**
 * Find indexes whose model differs from the wanted model, where the
 * collection already has documents that would be re-embedded.
 * Adapted from agent-memory's find_stranding_dimension_changes()
 * (migrations.py:171-253). Compares model names instead of numDimensions
 * because autoEmbed indexes manage dimensions server-side from the model.
 *
 * An empty collection is not a finding — there are no documents to re-embed.
 * A missing index is not a finding — it will be created fresh.
 * A model that cannot be extracted from the definition is not a finding —
 * it may be a non-autoEmbed index or an older definition format.
 *
 * Note: countDocuments({}) counts ALL documents in the collection, not just
 * documents with embeddings. In autoEmbed mode, vectors are materialized
 * server-side in the index, not stored as a document field — so every
 * document in the collection is a document that would be re-embedded.
 */
export async function findStrandingModelChanges(
	db: Db,
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
	wantedModel: string,
): Promise<ModelMigrationFinding[]> {
	const findings: ModelMigrationFinding[] = []
	const targets = getExpectedSearchIndexTargets(prefix, profile)

	for (const target of targets) {
		for (const indexName of target.indexNames) {
			const collection = db.collection(target.collectionName)
			let existing: SearchIndexDescription[]
			try {
				existing = await listSearchIndexes(collection)
			} catch (err) {
				// Not an Atlas deployment, or search is unavailable. Fail open
				// but log — the operator should know the scan was incomplete.
				// Matches agent-memory's pattern of warning on mid-scan errors.
				// C-002: the error chain is redacted before it reaches the log.
				console.warn(
					`[guardrail] Could not inspect search indexes on ` +
						`${target.collectionName}: ${formatErrorMessage(err)}. Proceeding; if the model ` +
						`did change, existing documents will be re-embedded on startup.`,
				)
				return []
			}
			const index = existing.find((idx) => idx.name === indexName)
			if (!index) continue

			const existingModel = extractAutoEmbedModel(index)
			if (!existingModel || existingModel === wantedModel) continue

			let documentCount: number
			try {
				documentCount = await collection.countDocuments({})
			} catch {
				// The model change is real; only the blast radius is unknown.
				documentCount = -1
			}
			if (documentCount === 0) continue

			findings.push({
				collectionName: target.collectionName,
				indexName,
				existingModel,
				wantedModel,
				documentCount,
			})
		}
	}
	return findings
}

/**
 * Startup preflight: refuse to proceed when the autoEmbed model changes and
 * existing documents would be re-embedded. Adapted from agent-memory's
 * _refuse_to_strand_existing_vectors() (memory.py:239-261).
 */
export async function refuseToStrandExistingDocuments(
	db: Db,
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
	wantedModel: string,
): Promise<void> {
	if (process.env.MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE === "true") {
		return
	}
	const findings = await findStrandingModelChanges(
		db,
		prefix,
		profile,
		wantedModel,
	)
	if (findings.length > 0) {
		throw new EmbeddingModelMigrationError(findings)
	}
}
