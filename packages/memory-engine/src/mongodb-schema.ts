import type { Db, Collection, Document } from "mongodb"
import {
	type MemoryMongoDBDeploymentProfile,
	type MemoryMongoDBEmbeddingMode,
	createSubsystemLogger,
} from "@memongo/lib"
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import { sortObject } from "./search-utils.js"

const log = createSubsystemLogger("memory:mongodb:schema")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectedCapabilities = {
	vectorSearch: boolean
	textSearch: boolean
	scoreFusion: boolean
	rankFusion: boolean
}

export type MongoIndexBudgetCheck = {
	profile: MemoryMongoDBDeploymentProfile
	plannedSearchIndexes: number
	budget: number | "unbounded"
	withinBudget: boolean
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function col(db: Db, prefix: string, name: string): Collection {
	return db.collection(`${prefix}${name}`)
}

export function chunksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "chunks")
}

export function filesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "files")
}

export function embeddingCacheCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "embedding_cache")
}

export function metaCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "meta")
}

export function kbCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "knowledge_base")
}

export function kbChunksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "kb_chunks")
}

export function structuredMemCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "structured_mem")
}

export function structuredMemRevisionsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "structured_mem_revisions")
}

export function proceduresCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "procedures")
}

export function procedureRevisionsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "procedure_revisions")
}

export function relevanceRunsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "relevance_runs")
}

export function relevanceArtifactsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "relevance_artifacts")
}

export function relevanceRegressionsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "relevance_regressions")
}

// v2 collection accessors

export function eventsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "events")
}

export function entitiesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "entities")
}

export function relationsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "relations")
}

export function entityLinksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "entity_links")
}

export function episodesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "episodes")
}

export function ingestRunsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "ingest_runs")
}

export function projectionRunsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "projection_runs")
}

export function queryCacheCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "query_cache")
}

export function telemetryCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_telemetry")
}

export function accessEventsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "access_events")
}

export function mutationsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_mutations")
}

/**
 * Injection-safety: quarantine collection for injection-shaped candidates
 * detected by the consolidator pre-write hook. Rows live here until a human
 * (or a future review gate) promotes or rejects them; they are
 * NEVER written to canonical events/structured_mem directly.
 */
export function memoryQuarantineCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_quarantine")
}

export function laneCoverageCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "lane_coverage")
}

export function consolidationRunsCollection(
	db: Db,
	prefix: string,
): Collection {
	return col(db, prefix, "consolidation_runs")
}

export function recallTracesCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "recall_traces")
}

export function memoryJobsCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_jobs")
}

export function sessionChunksCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "session_chunks")
}

export function memoryEvidenceCollection(db: Db, prefix: string): Collection {
	return col(db, prefix, "memory_evidence")
}

// ---------------------------------------------------------------------------
// Ensure collections exist (idempotent)
// ---------------------------------------------------------------------------

// JSON Schema validators for MongoDB-native collections.
// Uses $jsonSchema with validationAction: "error" so invalid docs are rejected
// at write time, keeping persisted memory collections structurally consistent.

const KB_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["hash", "title", "source", "updatedAt"],
		properties: {
			hash: { bsonType: "string", description: "Content hash for dedup" },
			title: { bsonType: "string", description: "Document title" },
			source: {
				bsonType: "object",
				required: ["type"],
				properties: {
					type: {
						enum: ["file", "url", "manual", "api"],
						description: "Source type",
					},
					path: { bsonType: "string" },
				},
			},
			category: { bsonType: "string" },
			tags: { bsonType: "array", items: { bsonType: "string" } },
			chunkCount: { bsonType: "number" },
			importedBy: { bsonType: "string" },
			wikiSource: {
				bsonType: "string",
				description:
					"Wiki source identifier (e.g., obsidian, notion, confluence)",
			},
			vault: {
				bsonType: "string",
				description: "Vault or workspace name",
			},
			section: {
				bsonType: "string",
				description: "Section or page path within vault",
			},
			updatedAt: { bsonType: "date" },
		},
	},
}

const KB_CHUNKS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["docId", "path", "text", "startLine", "endLine", "updatedAt"],
		properties: {
			docId: {
				bsonType: "string",
				description: "Reference to knowledge_base _id",
			},
			path: { bsonType: "string" },
			text: { bsonType: "string", description: "Chunk text content" },
			startLine: { bsonType: "number" },
			endLine: { bsonType: "number" },
			source: {
				bsonType: "string",
				description: "Source identifier (e.g., 'kb')",
			},
			wikiSource: {
				bsonType: "string",
				description: "Wiki source identifier",
			},
			vault: {
				bsonType: "string",
				description: "Vault or workspace name",
			},
			section: {
				bsonType: "string",
				description: "Section within vault",
			},
			embedding: {
				bsonType: "array",
				description: "Vector embedding (legacy field)",
			},
			updatedAt: { bsonType: "date" },
		},
	},
}

const STRUCTURED_MEM_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["type", "key", "value", "updatedAt"],
		properties: {
			type: {
				bsonType: "string",
				description:
					"Memory type (decision, preference, fact, person, todo, project, architecture, custom)",
			},
			key: { bsonType: "string", description: "Unique key within type" },
			value: { bsonType: "string", description: "The observation/fact text" },
			context: { bsonType: "string" },
			confidence: { bsonType: "number", minimum: 0, maximum: 1 },
			tags: { bsonType: "array", items: { bsonType: "string" } },
			agentId: { bsonType: "string" },
			scope: {
				enum: ["session", "user", "agent", "workspace", "tenant", "global"],
				description: "Memory scope (v2)",
			},
			scopeRef: {
				bsonType: "string",
				description: "Resolved concrete namespace for the scope",
			},
			revision: { bsonType: "number", minimum: 1 },
			state: {
				enum: ["active", "invalidated", "conflicted"],
				description: "Current truth state for this structured memory record",
			},
			salience: {
				enum: ["critical", "high", "normal", "low"],
				description: "Current runtime importance of this memory record",
			},
			temporalScope: {
				enum: ["ongoing", "bounded", "permanent", "transient"],
				description: "Expected lifetime semantics for this memory record",
			},
			provenance: { bsonType: "object" },
			sourceEventIds: { bsonType: "array", items: { bsonType: "string" } },
			sourceReliability: { bsonType: "number", minimum: 0, maximum: 1 },
			reinforcementCount: { bsonType: "number", minimum: 0 },
			openedCount: { bsonType: "number", minimum: 0 },
			validFrom: { bsonType: "date" },
			validTo: { bsonType: "date" },
			reviewAt: { bsonType: "date" },
			lastConfirmedAt: { bsonType: "date" },
			openedAt: { bsonType: "date" },
			lastUsedAt: { bsonType: "date" },
			supersedes: { bsonType: "object" },
			invalidatedBy: { bsonType: "object" },
			conflictsWith: { bsonType: "array", items: { bsonType: "object" } },
			sourceAgent: {
				bsonType: "object",
				required: ["id", "name"],
				properties: {
					id: { bsonType: "string" },
					name: { bsonType: "string" },
					runId: { bsonType: "string" },
				},
				description:
					"Agent attribution: { id, name, runId? } tracking which agent created this memory",
			},
			artifact: {
				bsonType: "object",
				properties: {
					type: {
						enum: ["solution", "formula", "command", "config", "snippet"],
					},
					title: { bsonType: "string" },
					content: { bsonType: "string" },
				},
				description: "Code/config stored as first-class memory (Phase 3.6)",
			},
			factLineage: {
				bsonType: "string",
				description:
					"Points to the superseding fact key (for temporal invalidation chain)",
			},
			sourceRef: {
				bsonType: "string",
				description: "Caller-owned idempotency key for external sync/dedup",
			},
			createdAt: { bsonType: "date" },
			embedding: {
				bsonType: "array",
				description: "Vector embedding (legacy field)",
			},
			updatedAt: { bsonType: "date" },
		},
	},
}

const STRUCTURED_MEM_REVISIONS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"type",
			"key",
			"value",
			"agentId",
			"scope",
			"scopeRef",
			"revision",
			"validFrom",
			"validTo",
			"supersededAt",
			"updatedAt",
		],
		properties: {
			type: { bsonType: "string" },
			key: { bsonType: "string" },
			value: { bsonType: "string" },
			context: { bsonType: "string" },
			confidence: { bsonType: "number", minimum: 0, maximum: 1 },
			tags: { bsonType: "array", items: { bsonType: "string" } },
			source: { bsonType: "string" },
			sessionId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			scope: {
				enum: ["session", "user", "agent", "workspace", "tenant", "global"],
				description: "Memory scope (v2)",
			},
			scopeRef: { bsonType: "string" },
			revision: { bsonType: "number", minimum: 1 },
			state: {
				enum: ["active", "invalidated", "conflicted"],
				description:
					"Historical truth state for this structured memory revision",
			},
			salience: {
				enum: ["critical", "high", "normal", "low"],
			},
			temporalScope: {
				enum: ["ongoing", "bounded", "permanent", "transient"],
			},
			provenance: { bsonType: "object" },
			sourceEventIds: { bsonType: "array", items: { bsonType: "string" } },
			sourceReliability: { bsonType: "number", minimum: 0, maximum: 1 },
			reinforcementCount: { bsonType: "number", minimum: 0 },
			validFrom: { bsonType: "date" },
			validTo: { bsonType: "date" },
			supersededAt: { bsonType: "date" },
			reviewAt: { bsonType: "date" },
			lastConfirmedAt: { bsonType: "date" },
			supersedes: { bsonType: "object" },
			invalidatedBy: { bsonType: "object" },
			conflictsWith: { bsonType: "array", items: { bsonType: "object" } },
			createdAt: { bsonType: "date" },
			updatedAt: { bsonType: "date" },
		},
	},
}

const PROCEDURES_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"procedureId",
			"agentId",
			"scope",
			"scopeRef",
			"name",
			"steps",
			"searchText",
			"state",
			"updatedAt",
		],
		properties: {
			procedureId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			scope: {
				enum: ["session", "user", "agent", "workspace", "tenant", "global"],
			},
			scopeRef: { bsonType: "string" },
			name: { bsonType: "string" },
			intentTags: { bsonType: "array", items: { bsonType: "string" } },
			triggerQueries: { bsonType: "array", items: { bsonType: "string" } },
			steps: { bsonType: "array", items: { bsonType: "string" } },
			successSignals: { bsonType: "array", items: { bsonType: "string" } },
			confidence: { bsonType: "number", minimum: 0, maximum: 1 },
			state: {
				enum: ["active", "invalidated", "conflicted"],
			},
			provenance: { bsonType: "object" },
			sourceEventIds: { bsonType: "array", items: { bsonType: "string" } },
			searchText: { bsonType: "string" },
			openedAt: { bsonType: "date" },
			openedCount: { bsonType: "number", minimum: 0 },
			lastUsedAt: { bsonType: "date" },
			version: {
				bsonType: "number",
				minimum: 1,
				description: "Current version number",
			},
			successCount: { bsonType: "number", minimum: 0 },
			failCount: { bsonType: "number", minimum: 0 },
			lastSuccessAt: { bsonType: "date" },
			lastFailureAt: { bsonType: "date" },
			evolutionHistory: {
				bsonType: "array",
				items: {
					bsonType: "object",
					properties: {
						version: { bsonType: "number" },
						changeType: { bsonType: "string" },
						changeDescription: { bsonType: "string" },
						timestamp: { bsonType: "date" },
					},
				},
				description: "Capped at 20 entries via $push + $slice: -20",
			},
			sourceAgent: {
				bsonType: "object",
				required: ["id", "name"],
				properties: {
					id: { bsonType: "string" },
					name: { bsonType: "string" },
					runId: { bsonType: "string" },
				},
				description:
					"Agent attribution: { id, name, runId? } tracking which agent created this procedure",
			},
			validFrom: {
				bsonType: "date",
				description: "When this procedure became valid",
			},
			validTo: {
				bsonType: "date",
				description:
					"When this procedure was invalidated (absent = still valid)",
			},
			sourceRef: {
				bsonType: "string",
				description: "Caller-owned idempotency key for external sync/dedup",
			},
			createdAt: { bsonType: "date" },
			updatedAt: { bsonType: "date" },
		},
	},
}

const PROCEDURE_REVISIONS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"procedureId",
			"agentId",
			"scope",
			"scopeRef",
			"name",
			"steps",
			"searchText",
			"state",
			"revision",
			"validFrom",
			"validTo",
			"supersededAt",
			"updatedAt",
		],
		properties: {
			procedureId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			scope: {
				enum: ["session", "user", "agent", "workspace", "tenant", "global"],
			},
			scopeRef: { bsonType: "string" },
			name: { bsonType: "string" },
			intentTags: { bsonType: "array", items: { bsonType: "string" } },
			triggerQueries: { bsonType: "array", items: { bsonType: "string" } },
			steps: { bsonType: "array", items: { bsonType: "string" } },
			successSignals: { bsonType: "array", items: { bsonType: "string" } },
			confidence: { bsonType: "number", minimum: 0, maximum: 1 },
			state: {
				enum: ["active", "invalidated", "conflicted"],
			},
			provenance: { bsonType: "object" },
			sourceEventIds: { bsonType: "array", items: { bsonType: "string" } },
			searchText: { bsonType: "string" },
			revision: { bsonType: "number", minimum: 1 },
			validFrom: { bsonType: "date" },
			validTo: { bsonType: "date" },
			supersededAt: { bsonType: "date" },
			createdAt: { bsonType: "date" },
			updatedAt: { bsonType: "date" },
		},
	},
}

// Polymorphic validator: chunks collection stores both traditional conversation
// chunks (with path+hash) and evidence docs (session, userfact, qa) that use
// source+sessionId instead. Uses $jsonSchema oneOf per the official MongoDB
// polymorphic collection pattern.
const CHUNKS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		oneOf: [
			{
				// Traditional conversation chunks (projected from events)
				required: ["path", "text", "hash", "updatedAt"],
				properties: {
					path: { bsonType: "string" },
					text: { bsonType: "string" },
					hash: { bsonType: "string" },
					source: { bsonType: "string" },
					startLine: { bsonType: "number" },
					endLine: { bsonType: "number" },
					embedding: { bsonType: "array" },
					model: { bsonType: "string" },
					updatedAt: { bsonType: "date" },
					status: {
						enum: ["active", "archived", "deleted"],
						description: "Lifecycle status (default: active)",
					},
				},
			},
			{
				// Evidence docs (session-evidence, userfact-evidence, qa-evidence)
				required: ["source", "text", "updatedAt"],
				properties: {
					source: {
						enum: [
							"session-evidence",
							"userfact-evidence",
							"preference-evidence",
							"qa-evidence",
						],
					},
					text: { bsonType: "string" },
					agentId: { bsonType: "string" },
					scope: { bsonType: "string" },
					scopeRef: { bsonType: "string" },
					sessionId: { bsonType: "string" },
					canonicalId: { bsonType: "string" },
					status: { bsonType: "string" },
					timestamp: { bsonType: "date" },
					updatedAt: { bsonType: "date" },
					metadata: { bsonType: "object" },
				},
			},
		],
	},
}

const RELEVANCE_RUNS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["runId", "agentId", "ts", "sourceScope", "latencyMs", "status"],
		properties: {
			runId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			ts: { bsonType: "date" },
			queryHash: { bsonType: "string" },
			queryRedacted: { bsonType: "string" },
			sourceScope: { enum: ["all", "memory", "kb", "structured"] },
			profile: { bsonType: "string" },
			capabilities: { bsonType: "object" },
			latencyMs: { bsonType: "number" },
			topK: { bsonType: "number" },
			hitSources: { bsonType: "array", items: { bsonType: "string" } },
			fallbackPath: { bsonType: "string" },
			status: { enum: ["ok", "degraded", "insufficient-data"] },
			sampleRate: { bsonType: "number" },
			sampled: { bsonType: "bool" },
		},
	},
}

const RELEVANCE_ARTIFACTS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["runId", "artifactType", "summary", "ts"],
		properties: {
			runId: { bsonType: "string" },
			artifactType: {
				enum: [
					"searchExplain",
					"vectorExplain",
					"fusionExplain",
					"scoreDetails",
					"trace",
				],
			},
			summary: { bsonType: "object" },
			rawExplain: {},
			rawSizeBytes: { bsonType: "number" },
			compression: { bsonType: "string" },
			ts: { bsonType: "date" },
		},
	},
}

const RELEVANCE_REGRESSIONS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"regressionId",
			"agentId",
			"ts",
			"metricName",
			"current",
			"severity",
		],
		properties: {
			regressionId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			ts: { bsonType: "date" },
			datasetVersion: { bsonType: "string" },
			metricName: { bsonType: "string" },
			baseline: { bsonType: "number" },
			current: { bsonType: "number" },
			delta: { bsonType: "number" },
			severity: { enum: ["low", "medium", "high"] },
			failingCases: { bsonType: "array", items: { bsonType: "object" } },
		},
	},
}

// v2 schema constants

const SCOPE_ENUM = ["session", "user", "agent", "workspace", "tenant", "global"]

const EVENTS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"eventId",
			"agentId",
			"role",
			"body",
			"scope",
			"scopeRef",
			"timestamp",
		],
		properties: {
			eventId: { bsonType: "string", description: "Unique event identifier" },
			agentId: {
				bsonType: "string",
				description: "Agent that generated this event",
			},
			role: {
				enum: ["user", "assistant", "system", "tool"],
				description: "Message role",
			},
			body: { bsonType: "string", description: "Event body text" },
			scope: { enum: SCOPE_ENUM, description: "Memory scope" },
			scopeRef: {
				bsonType: "string",
				description: "Resolved concrete namespace for the scope",
			},
			timestamp: { bsonType: "date", description: "Event timestamp" },
			sessionId: { bsonType: "string" },
			channel: { bsonType: "string" },
			metadata: { bsonType: "object" },
			projectedAt: {
				bsonType: "date",
				description: "When this event was projected to chunks",
			},
			consolidatedAt: {
				bsonType: "date",
				description: "When this event was consolidated into an episode",
			},
			consolidatedIntoEpisodeId: {
				bsonType: "string",
				description: "Episode ID this event was consolidated into",
			},
			sourceRef: {
				bsonType: "string",
				description: "Caller-owned idempotency key for external sync/dedup",
			},
			// Bi-temporal validity: bi-temporal validity. `validAt` marks when
			// the assertion became true; `invalidAt` marks when it stopped being
			// true (null = still valid). Retrieval filter:
			//   validAt <= queryTime AND (invalidAt IS NULL OR invalidAt > queryTime)
			// Cite: MongoDB MCP knowledge-base — bi-temporal compound index
			// mongodb.com/docs/manual/core/indexes/index-types/index-compound/
			validAt: {
				bsonType: "date",
				description: "Bi-temporal: when the assertion became true",
			},
			invalidAt: {
				bsonType: ["date", "null"],
				description:
					"Bi-temporal: when the assertion stopped being true; null = still valid",
			},
		},
	},
}

const ENTITIES_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"entityId",
			"name",
			"type",
			"agentId",
			"scope",
			"scopeRef",
			"updatedAt",
		],
		properties: {
			entityId: { bsonType: "string", description: "Unique entity identifier" },
			name: { bsonType: "string", description: "Entity name" },
			type: {
				bsonType: "string",
				description: "Entity type (person, project, concept, etc.)",
			},
			agentId: { bsonType: "string" },
			scope: { enum: SCOPE_ENUM },
			scopeRef: { bsonType: "string" },
			updatedAt: { bsonType: "date" },
			aliases: {
				bsonType: "array",
				items: { bsonType: "string" },
				description: "Alternative names",
			},
			attributes: {
				bsonType: "object",
				description: "Arbitrary key-value attributes",
			},
			confidence: { bsonType: "number", minimum: 0, maximum: 1 },
			confidenceSource: {
				enum: ["onboarding", "learned", "inferred"],
				description: "How this entity was learned",
			},
			ambiguousFlags: {
				bsonType: "array",
				items: { bsonType: "string" },
				description: "Ambiguity markers for common-word names",
			},
			mentionCount: {
				bsonType: "number",
				minimum: 0,
				description: "Total mention count, atomically incremented",
			},
			wikiUrl: {
				bsonType: "string",
				description: "Optional Wikipedia/reference URL",
			},
			extractedAt: {
				bsonType: "date",
				description: "When this entity was extracted",
			},
			sourceRole: {
				enum: ["user", "assistant"],
				description: "Role of the event that produced this entity",
			},
		},
	},
}

const RELATIONS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"fromEntityId",
			"toEntityId",
			"type",
			"agentId",
			"scope",
			"scopeRef",
			"updatedAt",
		],
		properties: {
			fromEntityId: { bsonType: "string" },
			toEntityId: { bsonType: "string" },
			type: {
				bsonType: "string",
				description: "Relation type (works_on, knows, etc.)",
			},
			agentId: { bsonType: "string" },
			scope: { enum: SCOPE_ENUM },
			scopeRef: { bsonType: "string" },
			state: { enum: ["active", "invalidated", "conflicted"] },
			updatedAt: { bsonType: "date" },
			weight: { bsonType: "number", minimum: 0, maximum: 1 },
			metadata: { bsonType: "object" },
			confidence: { bsonType: "number", minimum: 0, maximum: 1 },
			provenance: { bsonType: "object" },
			sourceEventIds: { bsonType: "array", items: { bsonType: "string" } },
			sourceReliability: { bsonType: "number", minimum: 0, maximum: 1 },
			reinforcementCount: { bsonType: "number", minimum: 0 },
			validFrom: { bsonType: "date" },
			validTo: { bsonType: "date" },
			reviewAt: { bsonType: "date" },
			lastConfirmedAt: { bsonType: "date" },
			supersedes: { bsonType: "object" },
			invalidatedBy: { bsonType: "object" },
			createdAt: { bsonType: "date" },
		},
	},
}

const ENTITY_LINKS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"linkId",
			"fromEntityId",
			"toEntityId",
			"linkType",
			"status",
			"agentId",
			"scope",
			"scopeRef",
			"confidence",
			"updatedAt",
		],
		properties: {
			linkId: { bsonType: "string" },
			fromEntityId: { bsonType: "string" },
			toEntityId: { bsonType: "string" },
			linkType: {
				enum: ["confirmed_same", "candidate_same", "related_mention"],
			},
			status: { enum: ["active", "rejected"] },
			agentId: { bsonType: "string" },
			scope: { enum: SCOPE_ENUM },
			scopeRef: { bsonType: "string" },
			confidence: { bsonType: "number", minimum: 0, maximum: 1 },
			sourceEventIds: { bsonType: "array", items: { bsonType: "string" } },
			provenance: { bsonType: "object" },
			updatedAt: { bsonType: "date" },
			createdAt: { bsonType: "date" },
		},
	},
}

const EPISODES_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"episodeId",
			"type",
			"title",
			"summary",
			"agentId",
			"scope",
			"scopeRef",
			"timeRange",
			"sourceEventCount",
			"updatedAt",
		],
		properties: {
			episodeId: {
				bsonType: "string",
				description: "Unique episode identifier",
			},
			type: {
				enum: ["daily", "weekly", "thread", "topic", "decision"],
				description: "Episode type",
			},
			title: { bsonType: "string" },
			summary: { bsonType: "string" },
			agentId: { bsonType: "string" },
			scope: { enum: SCOPE_ENUM },
			scopeRef: { bsonType: "string" },
			timeRange: {
				bsonType: "object",
				required: ["start", "end"],
				properties: {
					start: { bsonType: "date" },
					end: { bsonType: "date" },
				},
			},
			sourceEventCount: { bsonType: "number" },
			updatedAt: { bsonType: "date" },
			eventIds: { bsonType: "array", items: { bsonType: "string" } },
			tags: { bsonType: "array", items: { bsonType: "string" } },
			status: {
				enum: ["active", "archived", "deleted"],
				description: "Lifecycle status (default: active)",
			},
		},
	},
}

const INGEST_RUNS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"runId",
			"agentId",
			"source",
			"status",
			"itemsProcessed",
			"itemsFailed",
			"durationMs",
			"ts",
		],
		properties: {
			runId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			source: { bsonType: "string", description: "Ingest source identifier" },
			status: { enum: ["ok", "partial", "failed"] },
			itemsProcessed: { bsonType: "number" },
			itemsFailed: { bsonType: "number" },
			durationMs: { bsonType: "number" },
			ts: { bsonType: "date" },
		},
	},
}

const PROJECTION_RUNS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"runId",
			"agentId",
			"projectionType",
			"status",
			"itemsProjected",
			"durationMs",
			"ts",
		],
		properties: {
			runId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			projectionType: {
				enum: [
					"chunks",
					"entities",
					"relations",
					"episodes",
					"structured-promotion",
					"procedures",
					"entity-brief",
					"topic-brief",
					"what-changed",
					"contradiction-report",
				],
			},
			status: { enum: ["ok", "partial", "failed"] },
			itemsProjected: { bsonType: "number" },
			durationMs: { bsonType: "number" },
			ts: { bsonType: "date" },
		},
	},
}

const QUERY_CACHE_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"queryHash",
			"queryNorm",
			"agentId",
			"scope",
			"scopeRef",
			"results",
			"pathUsed",
			"sourceScope",
			"createdAt",
			"expiresAt",
			"hitCount",
			"lastHitAt",
		],
		properties: {
			queryHash: {
				bsonType: "string",
				description: "SHA-256 of normalized query",
			},
			queryNorm: {
				bsonType: "string",
				description: "Normalized query text (autoEmbed source)",
			},
			agentId: {
				bsonType: "string",
				description: "Agent that generated this cache entry",
			},
			scope: { enum: SCOPE_ENUM, description: "Memory scope" },
			scopeRef: { bsonType: "string", description: "Resolved scope namespace" },
			results: {
				bsonType: "array",
				description: "Cached MemorySearchResult[]",
			},
			pathUsed: {
				bsonType: "string",
				description: "Retrieval path that produced results",
			},
			sourceScope: {
				bsonType: "string",
				description: "Source scope for cache partitioning",
			},
			createdAt: { bsonType: "date" },
			expiresAt: { bsonType: "date", description: "Per-document TTL expiry" },
			hitCount: { bsonType: "number", minimum: 0 },
			lastHitAt: { bsonType: "date" },
		},
	},
}

const MEMORY_MUTATIONS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"mutationId",
			"collectionName",
			"documentId",
			"operation",
			"agentId",
			"timestamp",
		],
		properties: {
			mutationId: {
				bsonType: "string",
				description: "Unique mutation identifier",
			},
			collectionName: {
				bsonType: "string",
				description:
					"Target collection (structured_mem, entities, relations, procedures)",
			},
			documentId: {
				bsonType: "string",
				description: "_id or entityId of the modified document",
			},
			operation: {
				enum: ["create", "update", "delete", "invalidate"],
				description: "Mutation operation type",
			},
			agentId: {
				bsonType: "string",
				description: "Agent that performed the mutation",
			},
			oldValue: {
				description: "Document state before mutation (null for creates)",
			},
			newValue: {
				description: "Document state after mutation (null for deletes)",
			},
			changedFields: {
				bsonType: "array",
				items: { bsonType: "string" },
				description: "Field names that changed (for updates)",
			},
			timestamp: {
				bsonType: "date",
				description: "When the mutation occurred",
			},
			actorRole: {
				enum: ["user", "assistant", "system"],
				description: "Role of the actor that triggered the mutation",
			},
			meta: {
				bsonType: "object",
				description:
					"Optional provenance metadata for the mutation source (for example feedback or outcome context)",
			},
		},
	},
}

const RECALL_TRACES_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["traceId", "agentId", "query", "timestamp"],
		properties: {
			traceId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			query: { bsonType: "string" },
			timestamp: { bsonType: "date" },
			lanesUsed: {
				bsonType: "array",
				items: { bsonType: "string" },
			},
			lanesSkipped: {
				bsonType: "array",
				items: { bsonType: "string" },
			},
			totalHits: { bsonType: "number" },
			latencyMs: { bsonType: "number" },
			hitsByLane: { bsonType: "object" },
			topHitIds: {
				bsonType: "array",
				items: { bsonType: "string" },
			},
			tokenBudgetUsed: { bsonType: "number" },
			bundleMode: { enum: ["full", "wake-up", null] },
		},
	},
}

const MEMORY_JOBS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["jobId", "jobType", "agentId", "status", "createdAt"],
		properties: {
			jobId: { bsonType: "string" },
			jobType: {
				enum: [
					"consolidation",
					"extraction",
					"import",
					"materialization",
					"enrichment",
				],
			},
			agentId: { bsonType: "string" },
			status: {
				enum: ["pending", "running", "completed", "failed", "cancelled"],
			},
			createdAt: { bsonType: "date" },
			startedAt: { bsonType: "date" },
			completedAt: { bsonType: "date" },
			error: { bsonType: "string" },
			inputCount: { bsonType: "number", minimum: 0 },
			outputCount: { bsonType: "number", minimum: 0 },
			durationMs: { bsonType: "number", minimum: 0 },
			metadata: { bsonType: "object" },
		},
	},
}

const MEMORY_QUARANTINE_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"quarantineId",
			"agentId",
			"content",
			"classification",
			"matchedPatterns",
			"status",
			"createdAt",
		],
		properties: {
			quarantineId: {
				bsonType: "string",
				description: "Unique id for this quarantined candidate",
			},
			agentId: { bsonType: "string" },
			scope: { bsonType: "string" },
			scopeRef: { bsonType: "string" },
			// Raw candidate body that tripped the classifier. Quarantined content
			// is visible to reviewers only; never returned by search.
			content: { bsonType: "string" },
			classification: {
				enum: ["injection-likely"],
				description:
					"SE-2 classification; only 'injection-likely' is persisted here",
			},
			tier: {
				enum: ["pattern", "llm"],
				description: "Which classifier tier produced the verdict",
			},
			matchedPatterns: {
				bsonType: "array",
				items: { bsonType: "string" },
				description: "Every INJECTION_PATTERNS id that matched the content",
			},
			status: {
				enum: ["pending-review", "rejected", "promoted"],
				description: "Lifecycle status; canonical write requires 'promoted'",
			},
			createdAt: { bsonType: "date" },
			reviewedAt: { bsonType: "date" },
			reviewerId: { bsonType: "string" },
			reviewNotes: { bsonType: "string" },
			sourceEventIds: {
				bsonType: "array",
				items: { bsonType: "string" },
				description:
					"Source event ids if the candidate came from consolidation",
			},
		},
	},
}

const MEMORY_EVIDENCE_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"source",
			"path",
			"text",
			"agentId",
			"scope",
			"scopeRef",
			"sessionId",
			"sourceIds",
			"unit",
			"canonicalId",
			"status",
			"timestamp",
			"updatedAt",
			"provenance",
		],
		properties: {
			source: { enum: ["conversation"] },
			path: { bsonType: "string" },
			text: { bsonType: "string" },
			agentId: { bsonType: "string" },
			scope: { bsonType: "string" },
			scopeRef: { bsonType: "string" },
			sessionId: { bsonType: "string" },
			sourceIds: { bsonType: "array", items: { bsonType: "string" } },
			sourceEventIds: { bsonType: "array", items: { bsonType: "string" } },
			unit: {
				enum: [
					"turn",
					"session",
					"preference",
					"userfact",
					"assistant",
					"temporal_anchor",
					"graph",
				],
			},
			canonicalId: { bsonType: "string" },
			status: { enum: ["active", "deleted", "stale"] },
			timestamp: { bsonType: "date" },
			updatedAt: { bsonType: "date" },
			provenance: { bsonType: "object" },
			metadata: { bsonType: "object" },
		},
	},
}

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
		"embedding_cache",
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
	for (const name of needed) {
		if (!existing.has(name)) {
			// Strip prefix to look up validator
			const baseName = name.slice(prefix.length)
			const validator = VALIDATED_COLLECTIONS[baseName]
			if (validator) {
				await db.createCollection(name, {
					validator,
					validationLevel: "moderate",
					validationAction: "error",
				})
			} else {
				await db.createCollection(name)
			}
			log.info(`created collection ${name}`)
		}
	}
	// Time series collection — created separately (no $jsonSchema support)
	const telemetryName = `${prefix}memory_telemetry`
	if (!existing.has(telemetryName)) {
		try {
			await db.createCollection(telemetryName, {
				timeseries: {
					timeField: "ts",
					metaField: "meta",
					granularity: "seconds",
				},
				expireAfterSeconds: 604800, // 7 days
			})
			log.info(`created time series collection ${telemetryName}`)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			// Collection may already exist or time series not supported
			if (
				!msg.includes("already exists") &&
				!msg.includes("Collection already exists")
			) {
				log.warn(`time series collection creation failed: ${msg}`)
			}
		}
	}
	const accessEventsName = `${prefix}access_events`
	if (!existing.has(accessEventsName)) {
		try {
			await db.createCollection(accessEventsName, {
				timeseries: {
					timeField: "ts",
					metaField: "meta",
					granularity: "minutes",
				},
				expireAfterSeconds: 30 * 24 * 3600,
			})
			log.info(`created time series collection ${accessEventsName}`)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (
				!msg.includes("already exists") &&
				!msg.includes("Collection already exists")
			) {
				log.warn(`access events collection creation failed: ${msg}`)
				throw err
			}
		}
	}

	await ensureSchemaValidation(db, prefix)
}

/**
 * Apply JSON Schema validation to existing collections that were created
 * before validation was added. Idempotent — safe to call on every startup.
 * Uses validationAction: "error" so invalid writes fail fast.
 */
export async function ensureSchemaValidation(
	db: Db,
	prefix: string,
): Promise<void> {
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
				validationAction: "error",
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
			log.warn(`schema validation for ${collName} failed: ${msg}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Standard indexes (work on all MongoDB editions)
// ---------------------------------------------------------------------------

export async function ensureStandardIndexes(
	db: Db,
	prefix: string,
	ttlOpts?: {
		embeddingCacheTtlDays?: number
		memoryTtlDays?: number
		relevanceRetentionDays?: number
	},
): Promise<number> {
	let applied = 0

	const chunks = chunksCollection(db, prefix)
	await chunks.createIndex({ path: 1 }, { name: "idx_chunks_path" })
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
	await chunks.createIndex({ text: "text" }, { name: "idx_chunks_text" })
	applied++

	const cache = embeddingCacheCollection(db, prefix)
	try {
		await cache.createIndex(
			{ provider: 1, model: 1, providerKey: 1, hash: 1 },
			{ name: "uq_embedding_cache_composite", unique: true },
		)
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_embedding_cache_composite: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}

	// TTL index on embedding_cache for auto-expiry (per `index-ttl` rule).
	// When TTL is enabled, use TTL index instead of regular idx_cache_updated
	// because MongoDB cannot have two indexes on the same field with different options.
	// F18: Drop opposite-named index before creating to avoid IndexOptionsConflict.
	if (ttlOpts?.embeddingCacheTtlDays && ttlOpts.embeddingCacheTtlDays > 0) {
		try {
			await cache.dropIndex("idx_cache_updated")
		} catch {
			// Index may not exist — safe to ignore
		}
		const seconds = ttlOpts.embeddingCacheTtlDays * 24 * 60 * 60
		await cache.createIndex(
			{ updatedAt: 1 },
			{ name: "idx_cache_ttl", expireAfterSeconds: seconds },
		)
		applied++
		log.info(
			`created TTL index on embedding_cache: ${ttlOpts.embeddingCacheTtlDays} days`,
		)
	} else {
		try {
			await cache.dropIndex("idx_cache_ttl")
		} catch {
			// Index may not exist — safe to ignore
		}
		await cache.createIndex({ updatedAt: 1 }, { name: "idx_cache_updated" })
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
	try {
		await kb.createIndex({ hash: 1 }, { name: "uq_kb_hash", unique: true })
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_kb_hash: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
	try {
		await kbChunks.createIndex(
			{ path: 1, startLine: 1, endLine: 1 },
			{ name: "uq_kbchunks_path_lines", unique: true },
		)
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_kbchunks_path_lines: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}
	// $text index on kb_chunks text field for text search fallback
	await kbChunks.createIndex({ text: "text" }, { name: "idx_kbchunks_text" })
	applied++

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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_structured_agent_scope_scoperef_type_key: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}
	await structured.createIndex(
		{ type: 1, updatedAt: -1 },
		{ name: "idx_structured_type_updated" },
	)
	applied++
	await structured.createIndex(
		{ agentId: 1 },
		{ name: "idx_structured_agentid" },
	)
	applied++
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
	await structured.createIndex(
		{ value: "text", context: "text" },
		{ name: "idx_structured_text" },
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_events_eventid: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_entities_entityid_agent_scope_scoperef: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}
	await entities.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, type: 1, name: 1 },
		{ name: "idx_entities_agent_scope_scoperef_type_name" },
	)
	applied++
	await entities.createIndex(
		{ name: "text", aliases: "text" },
		{ name: "idx_entities_text" },
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
		{ agentId: 1, scope: 1, scopeRef: 1, fromEntityId: 1, type: 1 },
		{ name: "idx_relations_agent_scope_scoperef_from_type" },
	)
	applied++
	await relations.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, toEntityId: 1 },
		{ name: "idx_relations_agent_scope_scoperef_to" },
	)
	applied++
	await relations.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_relations_agent_scope_scoperef" },
	)
	applied++
	// C2/M3 audit fix: toEntityId-prefixed index for correlated $lookup in profile synthesis.
	// $expr $eq in $lookup can only use indexes when the foreign field is a prefix key.
	await relations.createIndex(
		{ toEntityId: 1, agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_relations_to_entity_scope" },
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_entity_links_pair_type: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_episodes_episodeid: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}
	await episodes.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, type: 1, "timeRange.start": -1 },
		{ name: "idx_episodes_agent_scope_scoperef_type_start" },
	)
	applied++
	await episodes.createIndex(
		{ summary: "text", title: "text" },
		{ name: "idx_episodes_text" },
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_structured_agent_scope_scoperef_type_key_v2: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}

	const structuredRevisions = structuredMemRevisionsCollection(db, prefix)
	await structuredRevisions.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1, revision: -1 },
		{ name: "idx_structured_revisions_identity_revision" },
	)
	applied++

	const procedures = proceduresCollection(db, prefix)
	try {
		await procedures.createIndex(
			{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_procedures_identity", unique: true },
		)
		applied++
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_procedures_identity: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
	await procedures.createIndex(
		{ searchText: "text", name: "text" },
		{ name: "idx_procedures_text" },
	)
	applied++

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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_query_cache_hash_agent_scope_scoperef: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
			{ "meta.agentId": 1, "meta.collection": 1, "meta.memoryId": 1, ts: -1 },
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_lane_coverage_agentid: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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

	// KB chunks wiki source filter
	const kbChunksForWiki = kbChunksCollection(db, prefix)
	await kbChunksForWiki.createIndex(
		{ docId: 1, wikiSource: 1 },
		{ name: "idx_kb_chunks_wiki", sparse: true },
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_events_sourceref: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_structured_sourceref: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_procedures_sourceref: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_recall_traces_traceid: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_memory_jobs_jobid: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
	}
	// ESR: agentId + status equality, createdAt descending sort
	await memoryJobs.createIndex(
		{ agentId: 1, status: 1, createdAt: -1 },
		{ name: "idx_memory_jobs_agent_status_created" },
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
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("duplicate") || msg.includes("already exists")) {
			log.warn(
				"unique index uq_session_chunks_agent_session: index exists or duplicates detected; skipping",
			)
			applied++
		} else {
			throw err
		}
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

// ---------------------------------------------------------------------------
// Search / Vector Search index creation
// ---------------------------------------------------------------------------

function isSearchIndexManagementUnavailable(message: string): boolean {
	return (
		message.includes("Search Index Management service") ||
		message.includes("Error connecting to Search Index Management service")
	)
}

function hasServerVersionAtLeast(
	versionArray: unknown,
	minimumMajor: number,
	minimumMinor: number,
): boolean {
	if (!Array.isArray(versionArray) || versionArray.length < 2) {
		return false
	}
	const major = Number(versionArray[0])
	const minor = Number(versionArray[1])
	if (!Number.isFinite(major) || !Number.isFinite(minor)) {
		return false
	}
	return (
		major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)
	)
}

export type SearchIndexDescription = {
	name?: string
	status?: string
	type?: string
	queryable?: boolean
	definition?: Document
	statusDetail?: Array<{
		mainIndex?: { queryable?: boolean; status?: string }
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

const SEARCH_INDEX_READY_STATUSES = new Set(["READY", "ACTIVE"])
const SEARCH_INDEX_FAILED_STATUSES = new Set(["FAILED"])

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractNestedQueryableStates(
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

function extractNestedStatuses(index: SearchIndexDescription): string[] {
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

function isSearchIndexFailed(index: SearchIndexDescription): boolean {
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

async function listSearchIndexes(
	collection: Collection,
): Promise<SearchIndexDescription[]> {
	try {
		return (await collection
			.aggregate([{ $listSearchIndexes: {} }])
			.toArray()) as SearchIndexDescription[]
	} catch {
		return (await collection
			.listSearchIndexes()
			.toArray()) as SearchIndexDescription[]
	}
}

function searchIndexDefinitionSignature(definition: Document): string {
	return JSON.stringify(sortObject(definition))
}

export function isSearchIndexTypeCompatible(
	actual: string | undefined,
	expected: "search" | "vectorSearch",
): boolean {
	if (!actual) return true
	if (actual === expected) return true
	// Atlas Local reports vectorSearch indexes backed by autoEmbed as
	// `autoEmbed`. Treat that as compatible with the vectorSearch create API.
	return expected === "vectorSearch" && actual === "autoEmbed"
}

async function ensureNamedSearchIndex(params: {
	collection: Collection
	name: string
	type: "search" | "vectorSearch"
	definition: Document
	label: string
}): Promise<boolean> {
	const searchCollection = params.collection as Collection & {
		updateSearchIndex?: (name: string, definition: Document) => Promise<void>
		listSearchIndexes: (name?: string) => {
			toArray: () => Promise<
				Array<{
					name?: string
					type?: string
					definition?: Document
					latestDefinition?: Document
					queryable?: boolean
				}>
			>
		}
	}

	try {
		const existing = (await searchCollection
			.listSearchIndexes(params.name)
			.toArray()) as Array<{
			name?: string
			type?: string
			definition?: Document
			latestDefinition?: Document
			queryable?: boolean
		}>
		const current = existing[0]
		if (current) {
			if (!isSearchIndexTypeCompatible(current.type, params.type)) {
				log.warn(
					`${params.label} search index exists with incompatible type (${current.type}); expected ${params.type}`,
				)
				return false
			}
			const currentDefinition = current.latestDefinition ?? current.definition
			if (
				currentDefinition &&
				searchIndexDefinitionSignature(currentDefinition) !==
					searchIndexDefinitionSignature(params.definition)
			) {
				if (typeof searchCollection.updateSearchIndex === "function") {
					await searchCollection.updateSearchIndex(
						params.name,
						params.definition,
					)
					log.info(`updated ${params.label} search index`)
				} else {
					log.warn(
						`${params.label} search index definition drift detected but updateSearchIndex() is unavailable`,
					)
				}
			}
			if (current.queryable === false) {
				log.warn(`${params.label} search index exists but is not yet queryable`)
			}
			return true
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (isSearchIndexManagementUnavailable(msg)) {
			throw err
		}
		log.warn(
			`${params.label} search index inspection failed; attempting create: ${msg}`,
		)
	}

	await searchCollection.createSearchIndex({
		name: params.name,
		type: params.type,
		definition: params.definition,
	})
	log.info(`created ${params.label} search index`)
	return true
}

/**
 * Ensure Atlas Search autocomplete index on entities collection for fuzzy
 * entity lookup. Uses the existing ensureNamedSearchIndex pattern.
 */
export async function ensureEntityAutocompleteIndex(
	db: Db,
	prefix: string,
): Promise<void> {
	const entities = entitiesCollection(db, prefix)
	try {
		await ensureNamedSearchIndex({
			collection: entities,
			name: "entity_autocomplete",
			type: "search",
			definition: {
				mappings: {
					dynamic: false,
					fields: {
						name: { type: "autocomplete" },
						aliases: { type: "autocomplete" },
						agentId: { type: "token" },
						scope: { type: "token" },
						scopeRef: { type: "token" },
					},
				},
			},
			label: "entity autocomplete",
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!msg.includes("already exists") && !msg.includes("duplicate")) {
			log.warn(`entity autocomplete index creation failed: ${msg}`)
		}
	}
}

export function getExpectedSearchIndexTargets(
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
): SearchIndexTarget[] {
	const evidenceMirrorEnabled = isEvidenceMirrorEnabled()
	const rawSessionIndexProfile = isRawSessionSearchIndexProfile()
	const plannedSearchIndexCount = rawSessionIndexProfile
		? 1
		: evidenceMirrorEnabled
			? 16
			: 14
	const budget = assertIndexBudget(profile, plannedSearchIndexCount)
	const reducedBudget =
		!budget.withinBudget &&
		typeof budget.budget === "number" &&
		budget.budget >= 2
	if (!budget.withinBudget && !reducedBudget) {
		return []
	}
	if (rawSessionIndexProfile) {
		return [
			{
				collectionName: `${prefix}session_chunks`,
				indexNames: [`${prefix}session_chunks_vector`],
			},
		]
	}
	const targets: SearchIndexTarget[] = [
		{
			collectionName: `${prefix}chunks`,
			indexNames: [`${prefix}chunks_text`, `${prefix}chunks_vector`],
		},
	]
	if (reducedBudget) {
		return targets
	}
	const evidenceTargets: SearchIndexTarget[] = evidenceMirrorEnabled
		? [
				{
					collectionName: `${prefix}memory_evidence`,
					indexNames: [
						`${prefix}memory_evidence_text`,
						`${prefix}memory_evidence_vector`,
					],
				},
			]
		: []
	if (isLongMemEvalSearchIndexProfile()) {
		return [
			...targets,
			{
				collectionName: `${prefix}structured_mem`,
				indexNames: [
					`${prefix}structured_mem_text`,
					`${prefix}structured_mem_vector`,
				],
			},
			{
				collectionName: `${prefix}procedures`,
				indexNames: [`${prefix}procedures_text`, `${prefix}procedures_vector`],
			},
			{
				collectionName: `${prefix}events`,
				indexNames: [`${prefix}events_text`, `${prefix}events_vector`],
			},
			...evidenceTargets,
		]
	}
	return [
		...targets,
		{
			collectionName: `${prefix}kb_chunks`,
			indexNames: [`${prefix}kb_chunks_text`, `${prefix}kb_chunks_vector`],
		},
		{
			collectionName: `${prefix}structured_mem`,
			indexNames: [
				`${prefix}structured_mem_text`,
				`${prefix}structured_mem_vector`,
			],
		},
		{
			collectionName: `${prefix}procedures`,
			indexNames: [`${prefix}procedures_text`, `${prefix}procedures_vector`],
		},
		{
			collectionName: `${prefix}events`,
			indexNames: [`${prefix}events_text`, `${prefix}events_vector`],
		},
		{
			collectionName: `${prefix}session_chunks`,
			indexNames: [
				`${prefix}session_chunks_text`,
				`${prefix}session_chunks_vector`,
			],
		},
		...evidenceTargets,
		{
			collectionName: `${prefix}query_cache`,
			indexNames: [`${prefix}query_cache_vector`],
		},
		{
			collectionName: `${prefix}entities`,
			indexNames: ["entity_autocomplete"],
		},
	]
}

function isLongMemEvalSearchIndexProfile(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE === "longmemeval" ||
		env.MEMONGO_SKIP_OPTIONAL_SEARCH_INDEXES === "1"
	)
}

function isRawSessionSearchIndexProfile(
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

function autoEmbedVectorField(path: string): Document {
	return {
		type: "autoEmbed",
		modality: "text",
		path,
		model: "voyage-4-large",
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

export function resolveSearchIndexReadinessTiming(
	env: NodeJS.ProcessEnv = process.env,
): {
	timeoutMs: number
	pollMs: number
} {
	const benchmarkStrict = env.MEMONGO_BENCHMARK_STRICT
	const searchReadyStrict = env.MEMONGO_STRICT_SEARCH_INDEX_READY
	const strictDefaultTimeoutMs =
		benchmarkStrict === "1" ||
		benchmarkStrict?.toLowerCase() === "true" ||
		searchReadyStrict === "1" ||
		searchReadyStrict?.toLowerCase() === "true"
			? 180_000
			: 60_000
	const timeoutMs = parsePositiveIntegerEnv(
		env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS,
		strictDefaultTimeoutMs,
	)
	const pollMs = parsePositiveIntegerEnv(
		env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS,
		1_000,
	)
	return { timeoutMs, pollMs }
}

function parsePositiveIntegerEnv(
	value: string | undefined,
	fallback: number,
): number {
	if (!value) {
		return fallback
	}
	const parsed = Number(value.trim())
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback
	}
	return Math.floor(parsed)
}

export async function ensureSearchIndexes(
	db: Db,
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
	embeddingMode: MemoryMongoDBEmbeddingMode,
	quantization: "none" | "scalar" | "binary" = "none",
	numDimensions: number = 1024,
): Promise<{ text: boolean; vector: boolean }> {
	void embeddingMode
	void quantization
	void numDimensions

	// 14 search indexes total: chunks, kb_chunks, structured_mem, procedures,
	// events, and session_chunks each get text + vector indexes, plus query_cache
	// gets 1 vector index, plus entities gets 1 autocomplete index. The optional
	// evidence mirror adds two more indexes only when explicitly enabled.
	// Keep the budget helper explicit so future constrained/free-tier profiles
	// can safely reduce index count without changing index definitions.
	const evidenceMirrorEnabled = isEvidenceMirrorEnabled()
	const rawSessionIndexProfile = isRawSessionSearchIndexProfile()
	const plannedSearchIndexCount = rawSessionIndexProfile
		? 1
		: evidenceMirrorEnabled
			? 16
			: 14
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
	if (rawSessionIndexProfile) {
		const sessionChunks = sessionChunksCollection(db, prefix)
		try {
			const sessionVectorDef: Document = {
				fields: [
					autoEmbedVectorField("text"),
					{ type: "filter", path: "agentId" },
					{ type: "filter", path: "scope" },
					{ type: "filter", path: "scopeRef" },
					{ type: "filter", path: "sessionId" },
				],
			}
			const vectorCreated = await ensureNamedSearchIndex({
				collection: sessionChunks,
				name: `${prefix}session_chunks_vector`,
				type: "vectorSearch",
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
		const filterFields: Document[] = [
			{ type: "filter", path: "source" },
			{ type: "filter", path: "path" },
			{ type: "filter", path: "agentId" },
			{ type: "filter", path: "scope" },
			{ type: "filter", path: "scopeRef" },
			{ type: "filter", path: "sessionId" },
			{ type: "filter", path: "status" },
		]

		const vectorDef: Document = {
			fields: [autoEmbedVectorField("text"), ...filterFields],
		}

		vectorCreated = await ensureNamedSearchIndex({
			collection: chunks,
			name: `${prefix}chunks_vector`,
			type: "vectorSearch",
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
			]

			const kbVectorDef: Document = {
				fields: [autoEmbedVectorField("text"), ...kbFilterFields],
			}

			vectorCreated = await ensureNamedSearchIndex({
				collection: kbChunks,
				name: `${prefix}kb_chunks_vector`,
				type: "vectorSearch",
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

		const structVectorDef: Document = {
			fields: [autoEmbedVectorField("value"), ...structFilterFields],
		}

		vectorCreated = await ensureNamedSearchIndex({
			collection: structured,
			name: `${prefix}structured_mem_vector`,
			type: "vectorSearch",
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
		const procedureVectorDef: Document = {
			fields: [
				autoEmbedVectorField("searchText"),
				{ type: "filter", path: "intentTags" },
				{ type: "filter", path: "agentId" },
				{ type: "filter", path: "scope" },
				{ type: "filter", path: "scopeRef" },
				{ type: "filter", path: "state" },
				{ type: "filter", path: "validFrom" },
				{ type: "filter", path: "validTo" },
			],
		}

		vectorCreated = await ensureNamedSearchIndex({
			collection: procedures,
			name: `${prefix}procedures_vector`,
			type: "vectorSearch",
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
		]
		const eventsVectorDef: Document = {
			fields: [autoEmbedVectorField("body"), ...eventsFilterFields],
		}
		vectorCreated = await ensureNamedSearchIndex({
			collection: events,
			name: `${prefix}events_vector`,
			type: "vectorSearch",
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
					autoEmbedVectorField("queryNorm"),
					{ type: "filter", path: "agentId" },
					{ type: "filter", path: "scope" },
					{ type: "filter", path: "scopeRef" },
					{ type: "filter", path: "expiresAt" },
				],
			}
			vectorCreated = await ensureNamedSearchIndex({
				collection: queryCache,
				name: `${prefix}query_cache_vector`,
				type: "vectorSearch",
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
			]
			const sessionVectorDef: Document = {
				fields: [autoEmbedVectorField("text"), ...sessionFilterFields],
			}
			vectorCreated = await ensureNamedSearchIndex({
				collection: sessionChunks,
				name: `${prefix}session_chunks_vector`,
				type: "vectorSearch",
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
				fields: [autoEmbedVectorField("text"), ...evidenceFilterFields],
			}
			vectorCreated = await ensureNamedSearchIndex({
				collection: memoryEvidence,
				name: `${prefix}memory_evidence_vector`,
				type: "vectorSearch",
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

	// Entity autocomplete search index (separate from standard indexes)
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
	}

	return { text: textCreated, vector: vectorCreated }
}

// ---------------------------------------------------------------------------
// Index budget
// ---------------------------------------------------------------------------

const PROFILE_BUDGETS: Record<MemoryMongoDBDeploymentProfile, "unbounded"> = {
	"atlas-local-preview": "unbounded",
	"atlas-managed": "unbounded",
	"community-mongot": "unbounded",
}

export function assertIndexBudget(
	profile: MemoryMongoDBDeploymentProfile,
	plannedCount: number,
): MongoIndexBudgetCheck {
	const budget = PROFILE_BUDGETS[profile]
	if (typeof budget === "number") {
		return {
			profile,
			plannedSearchIndexes: plannedCount,
			budget,
			withinBudget: plannedCount <= budget,
		}
	}
	return {
		profile,
		plannedSearchIndexes: plannedCount,
		budget,
		withinBudget: true,
	}
}

// ---------------------------------------------------------------------------
// KB orphan detection (startup integrity check)
// ---------------------------------------------------------------------------

/**
 * Check for orphaned kb_chunks — chunks whose docId references a knowledge_base
 * document that no longer exists. This can happen if a crash occurs between
 * chunk deletion and document deletion (or vice versa) without a transaction.
 *
 * Returns the list of orphaned docIds and total orphaned chunk count.
 * Does NOT auto-delete — the user decides.
 */
export async function checkKBOrphans(
	kbChunksCol: Collection,
	kbCol: Collection,
): Promise<{ orphanedChunkCount: number; orphanedDocIds: string[] }> {
	// Step 1: Get all distinct docIds + their chunk counts from kb_chunks
	const chunksByDoc = await kbChunksCol
		.aggregate([{ $group: { _id: "$docId", count: { $sum: 1 } } }])
		.toArray()

	if (chunksByDoc.length === 0) {
		return { orphanedChunkCount: 0, orphanedDocIds: [] }
	}

	// Step 2: Get all existing KB document IDs
	const allDocIds = chunksByDoc.map((d) => d._id)
	const existingDocs = await kbCol
		.find({ _id: { $in: allDocIds } })
		.project({ _id: 1 })
		.toArray()
	const existingIds = new Set(existingDocs.map((d) => String(d._id)))

	// Step 3: Find orphans (docId in chunks that doesn't exist in knowledge_base)
	const orphanedDocIds: string[] = []
	let orphanedChunkCount = 0
	for (const entry of chunksByDoc) {
		const docId = String(entry._id)
		if (!existingIds.has(docId)) {
			orphanedDocIds.push(docId)
			orphanedChunkCount += entry.count as number
		}
	}

	if (orphanedChunkCount > 0) {
		log.warn(
			`KB integrity: found ${orphanedChunkCount} orphaned kb_chunks across ${orphanedDocIds.length} missing document(s). ` +
				`Orphaned docIds: ${orphanedDocIds.join(", ")}. ` +
				`These chunks reference knowledge_base documents that no longer exist. ` +
				`Consider manual cleanup.`,
		)
	}

	return { orphanedChunkCount, orphanedDocIds }
}

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

export async function detectCapabilities(
	db: Db,
	probeCollectionName?: string,
): Promise<DetectedCapabilities> {
	const result: DetectedCapabilities = {
		vectorSearch: false,
		textSearch: false,
		scoreFusion: false,
		rankFusion: false,
	}

	// Prefer server-version gating for fusion stages because the MongoDB docs
	// define availability by server version. Fall back to stage probes only when
	// buildInfo is unavailable.
	try {
		const buildInfo = await db.admin().command({ buildInfo: 1 })
		const versionArray = (buildInfo as { versionArray?: unknown }).versionArray
		result.rankFusion = hasServerVersionAtLeast(versionArray, 8, 0)
		result.scoreFusion = hasServerVersionAtLeast(versionArray, 8, 2)
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

	// Probe mongot against the current search collection first so capability
	// detection does not depend on arbitrary legacy collections in a dirty DB.
	try {
		const probeNames = [probeCollectionName ?? "__probe__"]

		for (const name of probeNames) {
			try {
				await listSearchIndexes(db.collection(name))
				// listSearchIndexes succeeded → mongot is available
				result.textSearch = true
				result.vectorSearch = true
				break
			} catch {
				// This collection doesn't support search indexes
			}
		}
	} catch {
		// listSearchIndexes not available
	}

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
	}: {
		timeoutMs?: number
		pollMs?: number
		requireVector?: boolean
		requireText?: boolean
	} = {},
): Promise<DetectedCapabilities> {
	const deadline = Date.now() + timeoutMs
	let latest: DetectedCapabilities = {
		vectorSearch: false,
		textSearch: false,
		scoreFusion: false,
		rankFusion: false,
	}

	while (Date.now() < deadline) {
		latest = await detectCapabilities(db, probeCollectionName)
		const vectorReady = !requireVector || latest.vectorSearch
		const textReady = !requireText || latest.textSearch
		if (vectorReady && textReady) {
			return latest
		}
		await sleep(pollMs)
	}

	return latest
}
