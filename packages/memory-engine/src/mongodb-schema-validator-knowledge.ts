import type { Document } from "mongodb"

export const KB_SCHEMA: Document = {
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

export const KB_CHUNKS_SCHEMA: Document = {
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

export const STRUCTURED_MEM_SCHEMA: Document = {
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

export const STRUCTURED_MEM_REVISIONS_SCHEMA: Document = {
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

export const PROCEDURES_SCHEMA: Document = {
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

export const PROCEDURE_REVISIONS_SCHEMA: Document = {
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
export const CHUNKS_SCHEMA: Document = {
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
