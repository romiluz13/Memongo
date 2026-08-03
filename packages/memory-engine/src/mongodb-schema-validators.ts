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

const KB_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["hash", "title", "source", "updatedAt"],
		properties: {
			agentId: { bsonType: "string", description: "Owning agent (tenant)" },
			scope: { bsonType: "string", description: "Memory scope" },
			scopeRef: {
				bsonType: "string",
				description: "Resolved tenant isolation namespace",
			},
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
			agentId: { bsonType: "string", description: "Owning agent (tenant)" },
			scope: { bsonType: "string", description: "Memory scope" },
			scopeRef: {
				bsonType: "string",
				description: "Resolved tenant isolation namespace",
			},
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
			extractionJobPendingAt: {
				bsonType: "date",
				description:
					"Durable outbox marker for an extraction job not yet made claimable",
			},
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
			recordedAt: {
				bsonType: "date",
				description: "Transaction time when Memongo first persisted the event",
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
			latencyByLane: { bsonType: "object" },
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
			payload: {
				bsonType: "object",
				properties: {
					eventId: { bsonType: "string" },
					scope: { bsonType: "string" },
					scopeRef: { bsonType: "string" },
				},
			},
			attempts: { bsonType: "number", minimum: 0 },
			retryAt: { bsonType: "date" },
			stagedAt: { bsonType: "date" },
			leaseOwner: { bsonType: "string" },
			leaseToken: { bsonType: "string" },
			leaseExpiresAt: { bsonType: "date" },
			heartbeatAt: { bsonType: "date" },
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
