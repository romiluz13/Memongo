// Standard (non-search) indexes, valid on every MongoDB edition (P4.3 split from mongodb-schema.ts).
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import {
	chunksCollection,
	filesCollection,
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
	telemetryCollection,
	accessEventsCollection,
	mutationsCollection,
	laneCoverageCollection,
	consolidationRunsCollection,
	recallTracesCollection,
	memoryJobsCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
} from "./mongodb-schema-collections.js"

// ---------------------------------------------------------------------------
// Standard indexes (work on all MongoDB editions)
// ---------------------------------------------------------------------------

/**
 * E11000 while building a unique index means the collection already contains
 * duplicates for the exact keys the index exists to enforce — including the
 * tenant/scope uniqueness floors (uq_kb_scope_hash, uq_structured_*,
 * uq_entities_*). MongoDB builds no partial index in that case, so continuing
 * would leave the constraint permanently unenforced behind a log line: fail
 * bootstrap and make the operator deduplicate. "already exists"
 * (IndexOptionsConflict) stays non-fatal — an index with this name is present,
 * just created by an older version.
 */
function handleUniqueIndexCreationError(err: unknown, indexName: string): void {
	const code = (err as { code?: unknown } | null)?.code
	const msg = err instanceof Error ? err.message : String(err)
	if (
		code === 11000 ||
		code === "11000" ||
		msg.includes("E11000") ||
		msg.includes("duplicate key")
	) {
		throw new Error(
			`unique index ${indexName} cannot be enforced: existing documents violate it (${msg}). Deduplicate the collection, then restart.`,
			{ cause: err },
		)
	}
	if (msg.includes("already exists")) {
		log.warn(`unique index ${indexName}: already exists; skipping`)
		return
	}
	throw err
}

export async function ensureStandardIndexes(
	db: Db,
	prefix: string,
	ttlOpts?: {
		memoryTtlDays?: number
		relevanceRetentionDays?: number
		revisionRetentionDays?: number
		/**
		 * P3.8: the six BSON $text indexes are the no-mongot fallback — when
		 * Search Index Management is available the $search indexes serve every
		 * text lane and the $text duplicates are pure write amplification.
		 * The manager bootstrap passes `!searchIndexManagementAvailable`; direct
		 * callers default to true (create) to preserve the fallback guarantee.
		 */
		textFallbackIndexes?: boolean
	},
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

	// Events indexes
	const events = eventsCollection(db, prefix)
	await events.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, timestamp: -1 },
		{ name: "idx_events_agent_scope_scoperef_ts" },
	)
	applied++
	try {
		await events.createIndex(
			{ eventId: 1 },
			{ name: "uq_events_eventid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_events_eventid")
		applied++
	}
	await events.createIndex(
		{ scope: 1, scopeRef: 1, timestamp: -1 },
		{ name: "idx_events_scope_scoperef_ts" },
	)
	applied++
	await events.createIndex(
		{ sessionId: 1, timestamp: -1 },
		{ name: "idx_events_session_ts", sparse: true },
	)
	applied++
	await events.createIndex(
		{ projectedAt: 1 },
		{ name: "idx_events_projected", sparse: true },
	)
	applied++
	await events.createIndex(
		{ agentId: 1, extractionJobPendingAt: 1 },
		{
			name: "idx_events_agent_extraction_pending",
			partialFilterExpression: {
				extractionJobPendingAt: { $type: "date" },
			},
		},
	)
	applied++
	// Write idempotency (IETF/Stripe): one event per (agentId, idempotencyKey).
	// Tenant field first (ESR) so identical keys in different tenants never
	// collide — a global-unique key would leak another tenant's receipt on
	// replay. Partial on string-typed keys only: legacy keyless writes are
	// untouched (the single-null trap for unique indexes), so no backfill or
	// online-build dance is needed on existing collections.
	await events.createIndex(
		{ agentId: 1, idempotencyKey: 1 },
		{
			name: "uq_events_agent_idempotency_key",
			unique: true,
			partialFilterExpression: {
				idempotencyKey: { $type: "string" },
			},
		},
	)
	applied++
	await events.createIndex(
		{ consolidatedAt: 1 },
		{ name: "idx_events_consolidated", sparse: true },
	)
	applied++
	// Dreamer processing status — sparse index for consistency with projectedAt/consolidatedAt.
	// Note: sparse indexes do NOT optimize $exists:false queries (the consolidator's primary query).
	// The agentId prefix of idx_events_agent_scope_scoperef_ts handles that. This index serves
	// the inverse query ($exists:true) and maintains the codebase's sparse-lifecycle-field pattern.
	await events.createIndex(
		{ dreamerProcessedAt: 1 },
		{ name: "idx_events_dreamer_processed", sparse: true },
	)
	applied++
	// P4.4.1: optional per-document TTL (memory.mongodb.ttl) — same partial
	// TTL pattern as structured_mem above: expireAfterSeconds: 0 on an
	// absolute expiresAt, partial so non-expiring events stay out of the
	// index. Read paths hide expired docs immediately (buildUnexpiredClause)
	// because the sweep lags ~60s.
	await events.createIndex(
		{ expiresAt: 1 },
		{
			name: "idx_events_ttl_expires_at",
			expireAfterSeconds: 0,
			partialFilterExpression: { expiresAt: { $exists: true } },
		},
	)
	applied++
	// Bi-temporal validity: bi-temporal retrieval index. Supports the filter
	//   validAt <= queryTime AND (invalidAt IS NULL OR invalidAt > queryTime)
	// scoped by (agentId, scope, scopeRef). MongoDB compound index rules
	// https://www.mongodb.com/docs/manual/core/indexes/index-types/index-compound/
	await events.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, validAt: 1, invalidAt: 1 },
		{ name: "idx_events_agent_scope_scoperef_validAt_invalidAt" },
	)
	applied++

	// Entities indexes
	const entities = entitiesCollection(db, prefix)
	try {
		await entities.createIndex(
			{ entityId: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_entities_entityid_agent_scope_scoperef", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(
			err,
			"uq_entities_entityid_agent_scope_scoperef",
		)
		applied++
	}
	await entities.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, type: 1, name: 1 },
		{ name: "idx_entities_agent_scope_scoperef_type_name" },
	)
	applied++
	if (textFallbackIndexes) {
		await entities.createIndex(
			{ name: "text", aliases: "text" },
			{ name: "idx_entities_text" },
		)
		applied++
	}
	// P3.8 ESR compound: entity lookups (findEntitiesByName, getEntitiesByType)
	// filter agentId and sort updatedAt desc with no supporting index before.
	await entities.createIndex(
		{ agentId: 1, updatedAt: -1 },
		{ name: "idx_entities_agent_updated" },
	)
	applied++
	// Phase 3.4: entity alias lookup + mention count ranking
	try {
		await entities.createIndex(
			{ agentId: 1, aliases: 1 },
			{ name: "idx_entities_agent_aliases" },
		)
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"index idx_entities_agent_aliases: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}
	try {
		await entities.createIndex(
			{ agentId: 1, mentionCount: -1 },
			{ name: "idx_entities_agent_mentions" },
		)
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"index idx_entities_agent_mentions: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}

	// Relations indexes
	const relations = relationsCollection(db, prefix)
	await relations.createIndex(
		{
			agentId: 1,
			scope: 1,
			scopeRef: 1,
			fromEntityId: 1,
			toEntityId: 1,
			type: 1,
		},
		{ name: "uq_relations_identity", unique: true },
	)
	applied++
	await relations.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, fromEntityId: 1, type: 1 },
		{ name: "idx_relations_agent_scope_scoperef_from_type" },
	)
	applied++
	await relations.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, toEntityId: 1 },
		{ name: "idx_relations_agent_scope_scoperef_to" },
	)
	applied++
	// P3.8: idx_relations_agent_scope_scoperef retired — a strict prefix of the
	// unique uq_relations_identity index (and of the _from_type compound), so
	// it was pure write amplification.
	try {
		await relations.dropIndex("idx_relations_agent_scope_scoperef")
	} catch {
		// Index may not exist — safe to ignore
	}
	// P3.8: relation locator index. readFile("relation:from-to") used to fetch
	// up to 50 relations and JS-match the pair; the denormalized relationId
	// field makes it a single findOne.
	await relations.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, relationId: 1 },
		{ name: "idx_relations_agent_scope_scoperef_relationid" },
	)
	applied++
	// C2/M3 audit fix: toEntityId-prefixed index for correlated $lookup in profile synthesis.
	// $expr $eq in $lookup can only use indexes when the foreign field is a prefix key.
	await relations.createIndex(
		{ toEntityId: 1, agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_relations_to_entity_scope" },
	)
	applied++
	// Forward fromEntityId-prefixed index for $graphLookup / $lookup paths that
	// traverse from the source entity (connectFromField: fromEntityId). Mirrors
	// idx_relations_to_entity_scope for the reverse direction.
	await relations.createIndex(
		{ fromEntityId: 1, agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_relations_from_entity_scope" },
	)
	applied++

	const entityLinks = entityLinksCollection(db, prefix)
	try {
		await entityLinks.createIndex(
			{
				agentId: 1,
				scope: 1,
				scopeRef: 1,
				fromEntityId: 1,
				toEntityId: 1,
				linkType: 1,
			},
			{ name: "uq_entity_links_pair_type", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_entity_links_pair_type")
		applied++
	}
	await entityLinks.createIndex(
		{
			agentId: 1,
			scope: 1,
			scopeRef: 1,
			status: 1,
			fromEntityId: 1,
			toEntityId: 1,
		},
		{ name: "idx_entity_links_status_pair" },
	)
	applied++

	// Episodes indexes
	const episodes = episodesCollection(db, prefix)
	try {
		await episodes.createIndex(
			{ episodeId: 1 },
			{ name: "uq_episodes_episodeid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_episodes_episodeid")
		applied++
	}
	await episodes.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, type: 1, "timeRange.start": -1 },
		{ name: "idx_episodes_agent_scope_scoperef_type_start" },
	)
	applied++
	// Content address of the summarized event set — the identity materializeEpisode
	// upserts on. Unique so two concurrent materializations of the same events
	// cannot both insert; partial so episodes written before the field existed do
	// not all collide on a missing key.
	try {
		await episodes.createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, type: 1, sourceEventsHash: 1 },
			{
				name: "uq_episodes_source_events",
				unique: true,
				partialFilterExpression: { sourceEventsHash: { $type: "string" } },
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_episodes_source_events")
		applied++
	}
	if (textFallbackIndexes) {
		await episodes.createIndex(
			{ summary: "text", title: "text" },
			{ name: "idx_episodes_text" },
		)
		applied++
	}
	// P3.8 ESR compound: getEpisodesByType filters (agentId, type) equality and
	// sorts updatedAt desc with no supporting index before.
	await episodes.createIndex(
		{ agentId: 1, type: 1, updatedAt: -1 },
		{ name: "idx_episodes_agent_type_updated" },
	)
	applied++

	// Ingest runs indexes
	const ingestRuns = ingestRunsCollection(db, prefix)
	await ingestRuns.createIndex(
		{ agentId: 1, ts: -1 },
		{ name: "idx_ingestruns_agent_ts" },
	)
	applied++

	// Projection runs indexes
	const projRuns = projectionRunsCollection(db, prefix)
	await projRuns.createIndex(
		{ agentId: 1, projectionType: 1, ts: -1 },
		{ name: "idx_projruns_agent_type_ts" },
	)
	applied++

	// v2-ready structured memory scope index
	try {
		await structured.createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1 },
			{
				name: "uq_structured_agent_scope_scoperef_type_key_v2",
				unique: true,
				sparse: true,
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(
			err,
			"uq_structured_agent_scope_scoperef_type_key_v2",
		)
		applied++
	}

	const structuredRevisions = structuredMemRevisionsCollection(db, prefix)
	await structuredRevisions.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1, revision: -1 },
		{ name: "idx_structured_revisions_identity_revision" },
	)
	applied++
	// Optional retention cap on structured history (#32). Revisions are the audit
	// trail and the substrate for future historical-version ("as of T reads the
	// value that was current at T") retrieval, so retention is indefinite by
	// default; a destructive TTL is created ONLY when a window is explicitly
	// configured. Keyed on supersededAt (when the revision left the current set).
	if (ttlOpts?.revisionRetentionDays && ttlOpts.revisionRetentionDays > 0) {
		await structuredRevisions.createIndex(
			{ supersededAt: 1 },
			{
				name: "idx_structured_revisions_ttl",
				expireAfterSeconds: ttlOpts.revisionRetentionDays * 24 * 60 * 60,
			},
		)
		applied++
	}

	const procedures = proceduresCollection(db, prefix)
	try {
		await procedures.createIndex(
			{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_procedures_identity", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_procedures_identity")
		applied++
	}
	await procedures.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, state: 1, updatedAt: -1 },
		{ name: "idx_procedures_scope_state_updated" },
	)
	applied++
	await procedures.createIndex(
		{ intentTags: 1 },
		{ name: "idx_procedures_intent_tags" },
	)
	applied++
	await procedures.createIndex(
		{ agentId: 1, sourceEventIds: 1 },
		{ name: "idx_procedures_agent_source_event" },
	)
	applied++
	if (textFallbackIndexes) {
		await procedures.createIndex(
			{ searchText: "text", name: "text" },
			{ name: "idx_procedures_text" },
		)
		applied++
	}

	const procedureRevisions = procedureRevisionsCollection(db, prefix)
	await procedureRevisions.createIndex(
		{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1, revision: -1 },
		{ name: "idx_procedure_revisions_identity_revision" },
	)
	applied++

	// Query Cache indexes
	const queryCache = queryCacheCollection(db, prefix)
	try {
		await queryCache.createIndex(
			{ queryHash: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_query_cache_hash_agent_scope_scoperef", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(
			err,
			"uq_query_cache_hash_agent_scope_scoperef",
		)
		applied++
	}
	await queryCache.createIndex(
		{ expiresAt: 1 },
		{ name: "idx_query_cache_ttl", expireAfterSeconds: 0 },
	)
	applied++
	await queryCache.createIndex(
		{ agentId: 1, hitCount: -1 },
		{ name: "idx_query_cache_agent_hitcount" },
	)
	applied++

	// Telemetry indexes (time series collection — meta field compound indexes)
	const telemetry = telemetryCollection(db, prefix)
	try {
		await telemetry.createIndex(
			{ "meta.agentId": 1, ts: -1 },
			{ name: "idx_telemetry_agent_ts" },
		)
		applied++
		await telemetry.createIndex(
			{ "meta.operation": 1, ts: -1 },
			{ name: "idx_telemetry_op_ts" },
		)
		applied++
	} catch (err) {
		// Time series collection may not exist (creation failed in ensureCollections)
		const msg = err instanceof Error ? err.message : String(err)
		log.warn(`telemetry index creation skipped: ${msg}`)
	}

	const accessEvents = accessEventsCollection(db, prefix)
	try {
		await accessEvents.createIndex(
			{ "meta.agentId": 1, "meta.collection": 1, memoryId: 1, ts: -1 },
			{ name: "idx_access_events_agent_collection_memory_ts" },
		)
		applied++
		await accessEvents.createIndex(
			{ "meta.agentId": 1, "meta.collection": 1, ts: -1 },
			{ name: "idx_access_events_agent_collection_ts" },
		)
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		log.warn(`access events index creation skipped: ${msg}`)
	}

	// Mutation audit trail indexes
	const mutations = mutationsCollection(db, prefix)
	await mutations.createIndex(
		{ agentId: 1, collectionName: 1, timestamp: -1 },
		{ name: "idx_mutations_agent_collection_ts" },
	)
	applied++
	await mutations.createIndex(
		{ timestamp: 1 },
		{ name: "idx_mutations_ttl", expireAfterSeconds: 7776000 },
	)
	applied++
	await mutations.createIndex(
		{ documentId: 1, collectionName: 1, timestamp: -1 },
		{ name: "idx_mutations_doc_collection_ts" },
	)
	applied++

	// Lane coverage indexes
	const laneCoverage = laneCoverageCollection(db, prefix)
	try {
		await laneCoverage.createIndex(
			{ agentId: 1 },
			{ name: "uq_lane_coverage_agentid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_lane_coverage_agentid")
		applied++
	}

	// Episodes promotion index (consolidation queries for promotable episodes)
	const episodesForPromotion = episodesCollection(db, prefix)
	await episodesForPromotion.createIndex(
		{ agentId: 1, importance: -1 },
		{ name: "idx_episodes_promotion" },
	)
	applied++

	// Consolidation runs tracking
	const consolidationRuns = consolidationRunsCollection(db, prefix)
	await consolidationRuns.createIndex(
		{ agentId: 1, startedAt: -1 },
		{ name: "idx_consolidation_runs_agent_time" },
	)
	applied++

	// One Phase-0 gate document per scope identity (atomic lease, see
	// consolidateMemory). Partial so legacy per-run docs without a gateKey
	// never collide on the unique key (the single-null trap for unique
	// indexes); only string-typed gateKeys are constrained.
	await consolidationRuns.createIndex(
		{ gateKey: 1 },
		{
			name: "uq_consolidation_runs_gate",
			unique: true,
			partialFilterExpression: { gateKey: { $type: "string" } },
		},
	)
	applied++

	// KB chunks wiki source filter
	const kbChunksForWiki = kbChunksCollection(db, prefix)
	await kbChunksForWiki.createIndex(
		{ docId: 1, wikiSource: 1 },
		{ name: "idx_kb_chunks_wiki" },
	)
	applied++

	// sourceRef dedup indexes — uses partialFilterExpression because sparse+unique
	// on compound keys doesn't work as expected (agentId is always present, so
	// sparse won't skip docs without sourceRef). partialFilterExpression ensures
	// uniqueness only among docs that actually have a sourceRef field.
	const eventsForSourceRef = eventsCollection(db, prefix)
	try {
		await eventsForSourceRef.createIndex(
			{ agentId: 1, sourceRef: 1 },
			{
				unique: true,
				partialFilterExpression: { sourceRef: { $exists: true } },
				name: "uq_events_sourceref",
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_events_sourceref")
		applied++
	}
	const structuredForSourceRef = structuredMemCollection(db, prefix)
	try {
		await structuredForSourceRef.createIndex(
			{ agentId: 1, sourceRef: 1 },
			{
				unique: true,
				partialFilterExpression: { sourceRef: { $exists: true } },
				name: "uq_structured_sourceref",
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_structured_sourceref")
		applied++
	}
	const proceduresForSourceRef = proceduresCollection(db, prefix)
	try {
		await proceduresForSourceRef.createIndex(
			{ agentId: 1, sourceRef: 1 },
			{
				unique: true,
				partialFilterExpression: { sourceRef: { $exists: true } },
				name: "uq_procedures_sourceref",
			},
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_procedures_sourceref")
		applied++
	}

	// Partial index for current-facts queries on structured_mem.
	// MongoDB partialFilterExpression does not support $ne, so enumerate the
	// live states explicitly to keep the index valid on real Atlas Local.
	await structuredForSourceRef.createIndex(
		{ agentId: 1, type: 1, salience: -1 },
		{
			name: "idx_structured_active_facts",
			partialFilterExpression: { state: { $in: ["active", "conflicted"] } },
		},
	)
	applied++

	// -----------------------------------------------------------------------
	// Recall Traces (Phase 3.10)
	// -----------------------------------------------------------------------

	const recallTraces = recallTracesCollection(db, prefix)
	await recallTraces.createIndex(
		{ agentId: 1, timestamp: -1 },
		{ name: "idx_recall_traces_agent_ts" },
	)
	applied++
	try {
		await recallTraces.createIndex(
			{ traceId: 1 },
			{ name: "uq_recall_traces_traceid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_recall_traces_traceid")
		applied++
	}

	// -----------------------------------------------------------------------
	// Memory Jobs (Phase 3.11)
	// -----------------------------------------------------------------------

	const memoryJobs = memoryJobsCollection(db, prefix)
	try {
		await memoryJobs.createIndex(
			{ jobId: 1 },
			{ name: "uq_memory_jobs_jobid", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_memory_jobs_jobid")
		applied++
	}
	// ESR: agentId + status equality, createdAt descending sort
	await memoryJobs.createIndex(
		{ agentId: 1, status: 1, createdAt: -1 },
		{ name: "idx_memory_jobs_agent_status_created" },
	)
	applied++
	await memoryJobs.createIndex(
		{
			agentId: 1,
			jobType: 1,
			status: 1,
			leaseExpiresAt: 1,
			createdAt: 1,
			jobId: 1,
		},
		{ name: "idx_memory_jobs_claim_v2" },
	)
	applied++
	try {
		await memoryJobs.dropIndex("idx_memory_jobs_claim")
	} catch {
		// The v1 index may not exist on fresh installations.
	}
	// TTL on completedAt: only terminal jobs (completed/failed/cancelled) carry
	// the field, so pending/running jobs never expire. 30 days keeps failed
	// jobs inspectable as a dead-letter record before pruning — without this,
	// terminal jobs accumulated forever (fleet audit).
	await memoryJobs.createIndex(
		{ completedAt: 1 },
		{ name: "idx_memory_jobs_completed_ttl", expireAfterSeconds: 30 * 86_400 },
	)
	applied++

	// Session chunks (Option B session-evidence collection)
	const sessionChunks = sessionChunksCollection(db, prefix)
	try {
		await sessionChunks.createIndex(
			{ agentId: 1, sessionId: 1 },
			{ name: "uq_session_chunks_agent_session", unique: true },
		)
		applied++
	} catch (err) {
		handleUniqueIndexCreationError(err, "uq_session_chunks_agent_session")
		applied++
	}
	await sessionChunks.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_session_chunks_agent_scope" },
	)
	applied++
	await sessionChunks.createIndex(
		{ agentId: 1, timestamp: -1 },
		{ name: "idx_session_chunks_agent_time" },
	)
	applied++

	if (isEvidenceMirrorEnabled()) {
		const memoryEvidence = memoryEvidenceCollection(db, prefix)
		try {
			await memoryEvidence.createIndex(
				{ canonicalId: 1 },
				{ name: "uq_memory_evidence_canonical", unique: true },
			)
			applied++
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("duplicate") || msg.includes("already exists")) {
				log.warn(
					"unique index uq_memory_evidence_canonical: index exists or duplicates detected; skipping",
				)
				applied++
			} else {
				throw err
			}
		}
		await memoryEvidence.createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, unit: 1, status: 1 },
			{ name: "idx_memory_evidence_scope_unit_status" },
		)
		applied++
		await memoryEvidence.createIndex(
			{ agentId: 1, sessionId: 1, unit: 1 },
			{ name: "idx_memory_evidence_session_unit" },
		)
		applied++
		await memoryEvidence.createIndex(
			{ agentId: 1, timestamp: -1 },
			{ name: "idx_memory_evidence_agent_time" },
		)
		applied++
	}

	log.info(`ensured ${applied} standard indexes`)
	return applied
}
