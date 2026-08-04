import type { Document } from "mongodb"
import { SCOPE_ENUM } from "./mongodb-schema-validator-memory.js"

export const INGEST_RUNS_SCHEMA: Document = {
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

export const PROJECTION_RUNS_SCHEMA: Document = {
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

export const QUERY_CACHE_SCHEMA: Document = {
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

export const MEMORY_MUTATIONS_SCHEMA: Document = {
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

export const RECALL_TRACES_SCHEMA: Document = {
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

export const MEMORY_JOBS_SCHEMA: Document = {
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

export const MEMORY_QUARANTINE_SCHEMA: Document = {
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

export const MEMORY_EVIDENCE_SCHEMA: Document = {
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
