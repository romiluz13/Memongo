// Standard (non-search) indexes, valid on every MongoDB edition (P4.3 split from mongodb-schema.ts).
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")
import {
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	entityLinksCollection,
	episodesCollection,
} from "./mongodb-schema-collections.js"

// ---------------------------------------------------------------------------
// Standard indexes (work on all MongoDB editions)
// ---------------------------------------------------------------------------

import { handleUniqueIndexCreationError } from "./mongodb-schema-index-utils.js"
import type { StandardIndexOptions } from "./mongodb-schema-standard-index-types.js"

export async function ensureGraphStandardIndexes(
	db: Db,
	prefix: string,
	ttlOpts?: StandardIndexOptions,
): Promise<number> {
	let applied = 0
	const textFallbackIndexes = ttlOpts?.textFallbackIndexes ?? true

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
	// Optional episodes retention (episodesRetentionDays, 0 = disabled and the
	// default). Keyed on updatedAt, so the clock is "untouched for N days",
	// not "created more than N days ago" — a re-materialized episode is live
	// history, a stale one ages out. Mirrors the files-TTL pattern: drop any
	// ghost index from a previous configuration when disabled.
	if (ttlOpts?.episodesRetentionDays && ttlOpts.episodesRetentionDays > 0) {
		const seconds = ttlOpts.episodesRetentionDays * 24 * 60 * 60
		await episodes.createIndex(
			{ updatedAt: 1 },
			{ name: "idx_episodes_ttl_updated", expireAfterSeconds: seconds },
		)
		applied++
		log.warn(
			`created TTL index on episodes: ${ttlOpts.episodesRetentionDays} days — old episodes will be auto-deleted`,
		)
	} else {
		try {
			await episodes.dropIndex("idx_episodes_ttl_updated")
		} catch {
			// Index may not exist — safe to ignore
		}
	}
	// Ingest runs indexes
	return applied
}
