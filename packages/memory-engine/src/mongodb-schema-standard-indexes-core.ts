// Standard (non-search) indexes, valid on every MongoDB edition (P4.3 split from mongodb-schema.ts).
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")
import {
	chunksCollection,
	filesCollection,
	kbCollection,
	kbChunksCollection,
	structuredMemCollection,
	relevanceRunsCollection,
	relevanceArtifactsCollection,
	relevanceRegressionsCollection,
} from "./mongodb-schema-collections.js"

// ---------------------------------------------------------------------------
// Standard indexes (work on all MongoDB editions)
// ---------------------------------------------------------------------------

import { handleUniqueIndexCreationError } from "./mongodb-schema-index-utils.js"
import type { StandardIndexOptions } from "./mongodb-schema-standard-index-types.js"

export async function ensureCoreStandardIndexes(
	db: Db,
	prefix: string,
	ttlOpts?: StandardIndexOptions,
): Promise<number> {
	let applied = 0
	const textFallbackIndexes = ttlOpts?.textFallbackIndexes ?? true

	const chunks = chunksCollection(db, prefix)
	// P3.8: idx_chunks_path retired — a strict prefix of idx_chunks_path_hash
	// and of the ESR compound below, so it was pure write amplification. Drop
	// it explicitly: removing it from the spec alone would leave it live on
	// existing deployments (the structured_mem create/drop dance precedent).
	try {
		await chunks.dropIndex("idx_chunks_path")
	} catch {
		// Index may not exist — safe to ignore
	}
	// ESR compound for chunk reads: equality on (agentId, path), sort on
	// startLine (readConversationChunk / readBridgeChunk previously filtered
	// path only and sorted in memory).
	await chunks.createIndex(
		{ agentId: 1, path: 1, startLine: 1 },
		{ name: "idx_chunks_agent_path_startline" },
	)
	applied++
	// F17: Removed idx_chunks_source — low-cardinality index (only "memory"/"sessions" values)
	await chunks.createIndex(
		{ path: 1, hash: 1 },
		{ name: "idx_chunks_path_hash" },
	)
	applied++
	await chunks.createIndex({ updatedAt: -1 }, { name: "idx_chunks_updated" })
	applied++
	// Keep a BSON $text index as a defensive last-resort fallback if Search is unavailable.
	// Only one $text index is allowed per collection.
	if (textFallbackIndexes) {
		await chunks.createIndex({ text: "text" }, { name: "idx_chunks_text" })
		applied++
	}

	// Optional TTL on files for memory auto-expiry
	// WARNING: This deletes memory files from MongoDB after ttlDays
	// F18: Drop opposite-named index before creating to avoid IndexOptionsConflict.
	if (ttlOpts?.memoryTtlDays && ttlOpts.memoryTtlDays > 0) {
		const files = filesCollection(db, prefix)
		try {
			await files.dropIndex("idx_files_updated")
		} catch {
			// Index may not exist — safe to ignore
		}
		const seconds = ttlOpts.memoryTtlDays * 24 * 60 * 60
		await files.createIndex(
			{ updatedAt: 1 },
			{ name: "idx_files_ttl", expireAfterSeconds: seconds },
		)
		applied++
		log.warn(
			`created TTL index on files: ${ttlOpts.memoryTtlDays} days — old memory files will be auto-deleted`,
		)
	} else {
		// Ensure no ghost TTL index from a previous config
		const files = filesCollection(db, prefix)
		try {
			await files.dropIndex("idx_files_ttl")
		} catch {
			// Index may not exist — safe to ignore
		}
	}

	// Knowledge Base indexes
	const kb = kbCollection(db, prefix)
	// Migrate the old globally-unique hash index to the tenant-scoped one —
	// otherwise it keeps enforcing cross-tenant uniqueness on upgraded clusters.
	try {
		await kb.dropIndex("uq_kb_hash")
	} catch {
		// Index may not exist — safe to ignore.
	}
	try {
		// Unique per tenant (scopeRef), not globally — otherwise one tenant's
		// content hash blocks another tenant from ingesting the same content.
		// scopeRef-leading prefix also serves list/stats/remove tenant filters.
		await kb.createIndex(
			{ scopeRef: 1, hash: 1 },
			{ name: "uq_kb_scope_hash", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_kb_scope_hash")
		applied++
	}
	await kb.createIndex(
		{ "source.type": 1, category: 1 },
		{ name: "idx_kb_source_category" },
	)
	applied++
	await kb.createIndex({ tags: 1 }, { name: "idx_kb_tags" })
	applied++
	await kb.createIndex({ updatedAt: 1 }, { name: "idx_kb_updated" })
	applied++
	// F10: Index for dedup-by-source-path queries during re-ingestion
	await kb.createIndex(
		{ "source.path": 1 },
		{ name: "idx_kb_source_path", sparse: true },
	)
	applied++

	// KB Chunks indexes
	const kbChunks = kbChunksCollection(db, prefix)
	await kbChunks.createIndex({ docId: 1 }, { name: "idx_kbchunks_docid" })
	applied++
	// Migrate the old globally-unique path+lines index to the tenant-scoped one.
	try {
		await kbChunks.dropIndex("uq_kbchunks_path_lines")
	} catch {
		// Index may not exist — safe to ignore.
	}
	try {
		await kbChunks.createIndex(
			{ scopeRef: 1, path: 1, startLine: 1, endLine: 1 },
			{ name: "uq_kbchunks_scope_path_lines", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_kbchunks_path_lines")
		applied++
	}
	// $text index on kb_chunks text field for text search fallback
	if (textFallbackIndexes) {
		await kbChunks.createIndex({ text: "text" }, { name: "idx_kbchunks_text" })
		applied++
	}

	// Structured Memory indexes
	const structured = structuredMemCollection(db, prefix)
	// Migrate old unique index (type+key) to agent-scoped unique key.
	try {
		await structured.dropIndex("uq_structured_type_key")
	} catch {
		// Index may not exist — safe to ignore.
	}
	try {
		await structured.dropIndex("uq_structured_agent_type_key")
	} catch {
		// Index may not exist — safe to ignore.
	}
	try {
		await structured.createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1 },
			{ name: "uq_structured_agent_scope_scoperef_type_key", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(
			err,
			"uq_structured_agent_scope_scoperef_type_key",
		)
		applied++
	}
	await structured.createIndex(
		{ type: 1, updatedAt: -1 },
		{ name: "idx_structured_type_updated" },
	)
	applied++
	// P3.8: idx_structured_agentid retired — a strict prefix of the unique
	// (agentId, scope, scopeRef, type, key) index and of
	// idx_structured_agent_source_event, so it was pure write amplification.
	try {
		await structured.dropIndex("idx_structured_agentid")
	} catch {
		// Index may not exist — safe to ignore
	}
	await structured.createIndex({ tags: 1 }, { name: "idx_structured_tags" })
	applied++
	await structured.createIndex(
		{ agentId: 1, sourceEventIds: 1 },
		{ name: "idx_structured_agent_source_event" },
	)
	applied++
	await structured.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, state: 1, salience: 1, updatedAt: -1 },
		{ name: "idx_structured_scope_state_salience_updated" },
	)
	applied++
	// $text index on structured_mem for text search fallback
	if (textFallbackIndexes) {
		await structured.createIndex(
			{ value: "text", context: "text" },
			{ name: "idx_structured_text" },
		)
		applied++
	}
	// P4.4.1: optional per-document TTL (memory.mongodb.ttl). Official TTL
	// pattern: expireAfterSeconds: 0 keyed on an absolute expiresAt date,
	// partial so documents without an expiresAt stay out of the index. The
	// sweep runs ~60s, so read paths also exclude expired docs via
	// buildUnexpiredClause. Created unconditionally (the idx_query_cache_ttl
	// precedent): empty until a write carries expiresAt, so TTL-disabled
	// deployments pay nothing.
	await structured.createIndex(
		{ expiresAt: 1 },
		{
			name: "idx_structured_ttl_expires_at",
			expireAfterSeconds: 0,
			partialFilterExpression: { expiresAt: { $exists: true } },
		},
	)
	applied++
	// Bi-temporal valid-time index (#32): serves buildCurrentValidityClause's
	// "as of T" predicate (validFrom <= T AND (validTo absent OR > T)). The
	// current-facts read composes it with state:"active" as an equality, so under
	// ESR `state` precedes the validFrom/validTo range fields.
	await structured.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, state: 1, validFrom: 1, validTo: 1 },
		{ name: "idx_structured_scope_validfrom_validto" },
	)
	applied++

	// Explain-driven relevance telemetry indexes
	const relevanceRuns = relevanceRunsCollection(db, prefix)
	await relevanceRuns.createIndex(
		{ agentId: 1, ts: -1 },
		{ name: "idx_relruns_agent_ts" },
	)
	applied++
	await relevanceRuns.createIndex(
		{ queryHash: 1, ts: -1 },
		{ name: "idx_relruns_query_ts" },
	)
	applied++
	if (ttlOpts?.relevanceRetentionDays && ttlOpts.relevanceRetentionDays > 0) {
		try {
			await relevanceRuns.dropIndex("idx_relruns_ts")
		} catch {
			// Index may not exist — safe to ignore
		}
		await relevanceRuns.createIndex(
			{ ts: 1 },
			{
				name: "idx_relruns_ttl",
				expireAfterSeconds: ttlOpts.relevanceRetentionDays * 24 * 60 * 60,
			},
		)
		applied++
	} else {
		try {
			await relevanceRuns.dropIndex("idx_relruns_ttl")
		} catch {
			// Index may not exist — safe to ignore
		}
		await relevanceRuns.createIndex({ ts: 1 }, { name: "idx_relruns_ts" })
		applied++
	}

	const relevanceArtifacts = relevanceArtifactsCollection(db, prefix)
	await relevanceArtifacts.createIndex(
		{ runId: 1, artifactType: 1 },
		{ name: "idx_relart_run_type" },
	)
	applied++
	if (ttlOpts?.relevanceRetentionDays && ttlOpts.relevanceRetentionDays > 0) {
		try {
			await relevanceArtifacts.dropIndex("idx_relart_ts")
		} catch {
			// Index may not exist — safe to ignore
		}
		await relevanceArtifacts.createIndex(
			{ ts: 1 },
			{
				name: "idx_relart_ttl",
				expireAfterSeconds: ttlOpts.relevanceRetentionDays * 24 * 60 * 60,
			},
		)
		applied++
	} else {
		try {
			await relevanceArtifacts.dropIndex("idx_relart_ttl")
		} catch {
			// Index may not exist — safe to ignore
		}
		await relevanceArtifacts.createIndex({ ts: 1 }, { name: "idx_relart_ts" })
		applied++
	}

	const relevanceRegressions = relevanceRegressionsCollection(db, prefix)
	await relevanceRegressions.createIndex(
		{ agentId: 1, ts: -1, severity: 1 },
		{ name: "idx_relreg_agent_ts_severity" },
	)
	applied++
	await relevanceRegressions.createIndex(
		{ datasetVersion: 1, metricName: 1, ts: -1 },
		{ name: "idx_relreg_dataset_metric_ts" },
	)
	applied++

	// v2 collection indexes

	return applied
}
