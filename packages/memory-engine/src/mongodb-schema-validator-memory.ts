import type { Document } from "mongodb"

export const SCOPE_ENUM = [
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
]

export const EVENTS_SCHEMA: Document = {
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
			expiresAt: {
				bsonType: "date",
				description:
					"Optional absolute expiry for TTL and serving-time filtering",
			},
		},
	},
}

export const ENTITIES_SCHEMA: Document = {
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

export const RELATIONS_SCHEMA: Document = {
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

export const ENTITY_LINKS_SCHEMA: Document = {
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

export const EPISODES_SCHEMA: Document = {
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
