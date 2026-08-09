import { MEMORY_SCOPE_VALUES } from "@memongo/lib"
import type { McpToolDefinition } from "../tool-registry.js"

const recallMessagesInputSchema = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description:
				"Semantic search query for conversation content. Omit for filter-only recall.",
		},
		agentId: { type: "string" },
		scope: {
			type: "string",
			enum: [...MEMORY_SCOPE_VALUES],
		},
		scopeRef: { type: "string" },
		sessionId: {
			type: "string",
			description: "Filter to a specific conversation session.",
		},
		roles: {
			type: "array",
			items: {
				type: "string",
				enum: ["user", "assistant", "system", "tool"],
			},
			description: "Filter to specific message roles.",
		},
		startTime: {
			type: "string",
			description:
				"Inclusive start of time range. ISO 8601: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`.",
		},
		endTime: {
			type: "string",
			description:
				"Inclusive end of time range. ISO 8601: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`.",
		},
		asOf: {
			type: "string",
			format: "date-time",
			description:
				"Evaluate event validity at this historical instant. Defaults to now.",
		},
		timezone: {
			type: "string",
			description:
				"IANA timezone such as `America/New_York` for date-only boundaries.",
		},
		includeToolMessages: {
			type: "boolean",
			description: "Include tool messages in results. Default false.",
		},
		limit: {
			type: "number",
			description: "Maximum results to return. Default 50, max 200.",
		},
	},
} as const

// Semantic alias tools (P1.2): pure duplicates of canonical tools kept for
// backwards compatibility with hosts configured against the alias names.
// Registered only when MEMONGO_MCP_ALIASES=1.
export const aliasTools: readonly McpToolDefinition[] = [
	{
		name: "memongo_recall_messages",
		description:
			"Semantic alias for memongo_recall_conversation. Recall past messages with exact time/session/role filters and canonical citations from the same runtime truth.",
		inputSchema: recallMessagesInputSchema,
		category: "alias",
	},
	{
		name: "memongo_memory_get",
		description:
			"Semantic alias for memongo_lifecycle_get. Fetch the current structured memory or procedure for a stable memory handle.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable memory handle. Include family, id, agentId, scope, scopeRef, revision, state, and either structured.{type,key} or procedure.{procedureId}.",
				},
			},
			required: ["handle"],
		},
		category: "alias",
	},
	{
		name: "memongo_memory_update",
		description:
			"Semantic alias for memongo_lifecycle_update. Update a memory item by stable handle while preserving revision history.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable memory handle. Use the handle returned by memory get/history responses.",
				},
				patch: {
					type: "object",
					description:
						"Family-specific patch. Structured supports value/context/confidence/source/sessionId/tags/salience/temporalScope/provenance/sourceEventIds/validTo/reviewAt/lastConfirmedAt/sourceReliability/sourceAgent/artifact. Procedures support name/intentTags/triggerQueries/steps/successSignals/confidence/provenance/sourceEventIds/sourceAgent.",
				},
			},
			required: ["handle", "patch"],
		},
		category: "alias",
	},
	{
		name: "memongo_memory_delete",
		description:
			"Semantic alias for memongo_lifecycle_delete. Delete a memory item using invalidate-with-history semantics rather than hard delete.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable memory handle. Use the handle returned by memory get/history responses.",
				},
				invalidatedBy: {
					type: "object",
					description:
						"Optional metadata about why the current version was invalidated.",
				},
			},
			required: ["handle"],
		},
		category: "alias",
	},
	{
		name: "memongo_memory_history",
		description:
			"Semantic alias for memongo_lifecycle_history. Fetch ordered memory revision history from a stable handle.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable memory handle. Use the handle returned by memory get/history responses.",
				},
				limit: {
					type: "number",
					description:
						"Maximum history entries to return. Default 50, max 200.",
				},
			},
			required: ["handle"],
		},
		category: "alias",
	},
	{
		name: "memongo_import_conversation_history",
		description:
			"Semantic alias for memongo_import_conversations. Import conversation history through the same canonical writeConversationEvent() runtime path.",
		inputSchema: {
			type: "object",
			properties: {
				datasetPath: { type: "string", minLength: 1 },
				agentId: { type: "string" },
				scope: {
					type: "string",
					// Canonical scope enum from the single contract source (P2.2).
					enum: [...MEMORY_SCOPE_VALUES],
				},
				scopeRef: { type: "string" },
				limitConversations: { type: "integer", minimum: 1 },
				limitTurnsPerConversation: { type: "integer", minimum: 1 },
			},
			required: ["datasetPath"],
		},
		category: "alias",
	},
]
