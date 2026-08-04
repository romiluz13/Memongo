// $jsonSchema collection validators + ensureCollections (P4.3 split from mongodb-schema.ts).
import type { Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

import { serverVersionAtLeast } from "./mongodb-capability-registry.js"
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import { ensureTimeseriesOrPlain } from "./mongodb-schema-collections.js"
import { detectServerVersionArray } from "./mongodb-schema-search-indexes.js"

// ---------------------------------------------------------------------------
// Ensure collections exist (idempotent)
// ---------------------------------------------------------------------------

// JSON Schema validators for MongoDB-native collections.
// Uses $jsonSchema with validationAction: "errorAndLog" (MongoDB 8.1+;
// "error" below) so invalid docs are rejected at write time and logged
// server-side, keeping persisted memory collections structurally consistent.

import {
	KB_SCHEMA,
	KB_CHUNKS_SCHEMA,
	STRUCTURED_MEM_SCHEMA,
	STRUCTURED_MEM_REVISIONS_SCHEMA,
	PROCEDURES_SCHEMA,
	PROCEDURE_REVISIONS_SCHEMA,
	CHUNKS_SCHEMA,
} from "./mongodb-schema-validator-knowledge.js"
import {
	RELEVANCE_RUNS_SCHEMA,
	RELEVANCE_ARTIFACTS_SCHEMA,
	RELEVANCE_REGRESSIONS_SCHEMA,
} from "./mongodb-schema-validator-relevance.js"
import {
	EVENTS_SCHEMA,
	ENTITIES_SCHEMA,
	RELATIONS_SCHEMA,
	ENTITY_LINKS_SCHEMA,
	EPISODES_SCHEMA,
} from "./mongodb-schema-validator-memory.js"
import {
	INGEST_RUNS_SCHEMA,
	PROJECTION_RUNS_SCHEMA,
	QUERY_CACHE_SCHEMA,
	MEMORY_MUTATIONS_SCHEMA,
	RECALL_TRACES_SCHEMA,
	MEMORY_JOBS_SCHEMA,
	MEMORY_QUARANTINE_SCHEMA,
	MEMORY_EVIDENCE_SCHEMA,
} from "./mongodb-schema-validator-operations.js"

const VALIDATED_COLLECTIONS: Record<string, Document> = {
	chunks: CHUNKS_SCHEMA,
	knowledge_base: KB_SCHEMA,
	kb_chunks: KB_CHUNKS_SCHEMA,
	structured_mem: STRUCTURED_MEM_SCHEMA,
	structured_mem_revisions: STRUCTURED_MEM_REVISIONS_SCHEMA,
	procedures: PROCEDURES_SCHEMA,
	procedure_revisions: PROCEDURE_REVISIONS_SCHEMA,
	relevance_runs: RELEVANCE_RUNS_SCHEMA,
	relevance_artifacts: RELEVANCE_ARTIFACTS_SCHEMA,
	relevance_regressions: RELEVANCE_REGRESSIONS_SCHEMA,
	events: EVENTS_SCHEMA,
	entities: ENTITIES_SCHEMA,
	relations: RELATIONS_SCHEMA,
	entity_links: ENTITY_LINKS_SCHEMA,
	episodes: EPISODES_SCHEMA,
	ingest_runs: INGEST_RUNS_SCHEMA,
	projection_runs: PROJECTION_RUNS_SCHEMA,
	query_cache: QUERY_CACHE_SCHEMA,
	memory_mutations: MEMORY_MUTATIONS_SCHEMA,
	recall_traces: RECALL_TRACES_SCHEMA,
	memory_jobs: MEMORY_JOBS_SCHEMA,
	memory_quarantine: MEMORY_QUARANTINE_SCHEMA,
	memory_evidence: MEMORY_EVIDENCE_SCHEMA,
	// L2: files uses a TTL index on updatedAt. If updatedAt is missing or not a
	// date, the TTL index silently no-ops (the document never expires). This
	// validator ensures updatedAt is a BSON date so the TTL index actually
	// evicts expired entries.
	files: {
		$jsonSchema: {
			bsonType: "object",
			required: ["updatedAt"],
			properties: {
				updatedAt: { bsonType: "date" },
			},
		},
	},
}

export async function ensureCollections(db: Db, prefix: string): Promise<void> {
	const existing = new Set(
		await db
			.listCollections()
			.map((c) => c.name)
			.toArray(),
	)
	const needed = [
		"chunks",
		"files",
		"meta",
		"knowledge_base",
		"kb_chunks",
		"structured_mem",
		"structured_mem_revisions",
		"procedures",
		"procedure_revisions",
		"relevance_runs",
		"relevance_artifacts",
		"relevance_regressions",
		"events",
		"entities",
		"relations",
		"entity_links",
		"episodes",
		"ingest_runs",
		"projection_runs",
		"query_cache",
		"memory_mutations",
		"lane_coverage",
		"consolidation_runs",
		"recall_traces",
		"memory_jobs",
		"session_chunks",
		"memory_quarantine",
		...(isEvidenceMirrorEnabled() ? ["memory_evidence"] : []),
	].map((n) => `${prefix}${n}`)
	// errorAndLog is GA since MongoDB 8.1 (P3.5): rejections are additionally
	// recorded in the mongod log with document and reason. Older servers and
	// deployments where buildInfo is unavailable keep plain "error".
	const validationAction = serverVersionAtLeast(
		await detectServerVersionArray(db),
		8,
		1,
	)
		? "errorAndLog"
		: "error"
	for (const name of needed) {
		if (!existing.has(name)) {
			// Strip prefix to look up validator
			const baseName = name.slice(prefix.length)
			const validator = VALIDATED_COLLECTIONS[baseName]
			if (validator) {
				await db.createCollection(name, {
					validator,
					validationLevel: "moderate",
					validationAction,
				})
			} else {
				await db.createCollection(name)
			}
			log.info(`created collection ${name}`)
		}
	}
	// Time series collections — created separately (no $jsonSchema support).
	// Falls back to a plain collection with a TTL index when time series are
	// unsupported (pre-5.0 / DocumentDB / standalone), so writes don't throw.
	const telemetryName = `${prefix}memory_telemetry`
	if (!existing.has(telemetryName)) {
		await ensureTimeseriesOrPlain(db, telemetryName, {
			timeField: "ts",
			metaField: "meta",
			granularity: "seconds",
			expireAfterSeconds: 604800, // 7 days
		})
		log.info(`created telemetry collection ${telemetryName}`)
	}
	const accessEventsName = `${prefix}access_events`
	if (!existing.has(accessEventsName)) {
		await ensureTimeseriesOrPlain(db, accessEventsName, {
			timeField: "ts",
			metaField: "meta",
			granularity: "minutes",
			expireAfterSeconds: 30 * 24 * 3600,
		})
		log.info(`created access events collection ${accessEventsName}`)
	}

	await ensureSchemaValidation(db, prefix)
}

/**
 * Apply JSON Schema validation to existing collections that were created
 * before validation was added. Idempotent — safe to call on every startup.
 * Uses validationAction: "errorAndLog" on MongoDB 8.1+ ("error" below) so
 * invalid writes fail fast AND leave a server-side record (P3.5).
 */
export async function ensureSchemaValidation(
	db: Db,
	prefix: string,
): Promise<void> {
	const validationAction = serverVersionAtLeast(
		await detectServerVersionArray(db),
		8,
		1,
	)
		? "errorAndLog"
		: "error"
	const failures: string[] = []
	for (const [baseName, validator] of Object.entries(VALIDATED_COLLECTIONS)) {
		if (baseName === "memory_evidence" && !isEvidenceMirrorEnabled()) {
			continue
		}
		const collName = `${prefix}${baseName}`
		try {
			await db.command({
				collMod: collName,
				validator,
				validationLevel: "moderate",
				validationAction,
			})
			log.info(`applied schema validation to ${collName}`)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			// Collection might not exist yet — skip silently
			if (
				msg.includes("ns not found") ||
				msg.includes("ns does not exist") ||
				msg.includes("doesn't exist") ||
				msg.includes("NamespaceNotFound")
			) {
				continue
			}
			failures.push(`${collName}: ${msg}`)
			log.warn(`schema validation for ${collName} failed: ${msg}`)
		}
	}
	// Fleet audit P2-1: per-collection warns scroll past — a deployment can
	// otherwise run with ZERO $jsonSchema validation and no distinguishable
	// signal. One error-level summary makes the degraded state visible without
	// bricking least-privilege operators who cannot run collMod.
	if (failures.length > 0) {
		log.error(
			`schema validation NOT active on ${failures.length} collection(s) — documents are not validated: ${failures.join("; ")}`,
		)
	}
}
