import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { MemongoClient } from "@memongo/client"
import { pathToFileURL } from "node:url"

const memongo = new MemongoClient({
	baseUrl: process.env.MEMONGO_API_URL,
	apiKey: process.env.MEMONGO_API_KEY,
})

type MemongoMcpClient = typeof memongo

const RECALL_TOOL_NAMES = new Set([
	"memongo_recall_conversation",
	"memongo_recall_messages",
])
const LIFECYCLE_GET_TOOL_NAMES = new Set([
	"memongo_lifecycle_get",
	"memongo_memory_get",
])
const LIFECYCLE_UPDATE_TOOL_NAMES = new Set([
	"memongo_lifecycle_update",
	"memongo_memory_update",
])
const LIFECYCLE_DELETE_TOOL_NAMES = new Set([
	"memongo_lifecycle_delete",
	"memongo_memory_delete",
])
const LIFECYCLE_HISTORY_TOOL_NAMES = new Set([
	"memongo_lifecycle_history",
	"memongo_memory_history",
])
const IMPORT_TOOL_NAMES = new Set([
	"memongo_import_conversations",
	"memongo_import_conversation_history",
])

function jsonResult(payload: unknown, isError = false) {
	const structuredContent =
		payload !== null && typeof payload === "object"
			? Array.isArray(payload)
				? { items: payload }
				: (payload as Record<string, unknown>)
			: { value: payload }
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		structuredContent,
		...(isError ? { isError: true } : {}),
	}
}

export const toolList = [
	{
		name: "memongo_search",
		description: "Search Memongo memory",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				limit: { type: "number" },
				minScore: { type: "number" },
			},
			required: ["query"],
		},
	},
	{
		name: "memongo_search_kb",
		description: "Search Memongo knowledge base",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				limit: { type: "number" },
			},
			required: ["query"],
		},
	},
	{
		name: "memongo_read_file",
		description: "Read memory file by path (memory_get parity)",
		inputSchema: {
			type: "object",
			properties: {
				relPath: { type: "string" },
				agentId: { type: "string" },
				from: { type: "number" },
				lines: { type: "number" },
			},
			required: ["relPath"],
		},
	},
	{
		name: "memongo_add",
		description: "Add user message to memory",
		inputSchema: {
			type: "object",
			properties: {
				content: { type: "string" },
				agentId: { type: "string" },
				sessionId: { type: "string" },
			},
			required: ["content"],
		},
	},
	{
		name: "memongo_write_event",
		description: "Write conversation event (any role)",
		inputSchema: {
			type: "object",
			properties: {
				role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
				body: { type: "string" },
				agentId: { type: "string" },
				sessionId: { type: "string" },
			},
			required: ["role", "body"],
		},
	},
	{
		name: "memongo_profile",
		description: "Synthesize profile from Memongo memory",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				scopeRef: { type: "string" },
			},
		},
	},
	{
		name: "memongo_build_context_bundle",
		description: "Build a prompt-ready context bundle from Memongo memory",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: ["session", "user", "agent", "workspace", "tenant", "global"],
				},
				scopeRef: { type: "string" },
				sessionId: { type: "string" },
				tokenBudget: { type: "number" },
				maxActiveItems: { type: "number" },
				maxEvidenceItems: { type: "number" },
				maxRecentEvents: { type: "number" },
				includeDiscoveryProjection: { type: "boolean" },
				discoveryKind: {
					type: "string",
					enum: [
						"entity-brief",
						"topic-brief",
						"what-changed",
						"contradiction-report",
					],
				},
				includeProfile: { type: "boolean" },
				mode: {
					type: "string",
					enum: ["full", "wake-up"],
					description:
						"wake-up returns a compact 250-token projection for session start",
				},
				timeRange: {
					type: "object",
					properties: {
						preset: { type: "string" },
						start: { type: "string" },
						end: { type: "string" },
					},
				},
			},
		},
	},
	{
		name: "memongo_recall_conversation",
		description:
			"Search and retrieve past conversation messages with canonical citations. Use exact ISO 8601 timestamps (for example `2026-04-08T14:30:00Z`); for date-only input (`2026-04-08`), include timezone to resolve local day boundaries correctly. Tool messages are excluded by default unless includeToolMessages is true.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Semantic search query for conversation content. Omit for filter-only recall.",
				},
				agentId: { type: "string" },
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
		},
	},
	{
		name: "memongo_recall_messages",
		description:
			"Semantic alias for memongo_recall_conversation. Recall past messages with exact time/session/role filters and canonical citations from the same runtime truth.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Semantic search query for conversation content. Omit for filter-only recall.",
				},
				agentId: { type: "string" },
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
		},
	},
	{
		name: "memongo_lifecycle_get",
		description:
			"Get the current structured memory or procedure referenced by a stable lifecycle handle.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable lifecycle handle. Include family, id, agentId, scope, scopeRef, revision, state, and either structured.{type,key} or procedure.{procedureId}.",
				},
			},
			required: ["handle"],
		},
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
	},
	{
		name: "memongo_lifecycle_update",
		description:
			"Update a structured memory or procedure via its stable lifecycle handle. Creates a new current revision and preserves history.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable lifecycle handle. Use the handle returned by lifecycle get/history responses.",
				},
				patch: {
					type: "object",
					description:
						"Family-specific patch. Structured supports value/context/confidence/source/sessionId/tags/salience/temporalScope/provenance/sourceEventIds/validTo/reviewAt/lastConfirmedAt/sourceReliability/sourceAgent/artifact. Procedures support name/intentTags/triggerQueries/steps/successSignals/confidence/provenance/sourceEventIds/sourceAgent.",
				},
			},
			required: ["handle", "patch"],
		},
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
	},
	{
		name: "memongo_lifecycle_delete",
		description:
			"Delete a memory item using Memongo lifecycle semantics. This invalidates the current version and preserves history instead of hard-deleting it.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable lifecycle handle. Use the handle returned by lifecycle get/history responses.",
				},
				invalidatedBy: {
					type: "object",
					description:
						"Optional metadata about why the current version was invalidated.",
				},
			},
			required: ["handle"],
		},
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
	},
	{
		name: "memongo_lifecycle_history",
		description:
			"Fetch ordered revision history for a structured memory or procedure from its stable lifecycle handle.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable lifecycle handle. Use the handle returned by lifecycle get/history responses.",
				},
				limit: {
					type: "number",
					description:
						"Maximum history entries to return. Default 50, max 200.",
				},
			},
			required: ["handle"],
		},
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
	},
	{
		name: "memongo_procedure_outcome",
		description:
			"Record whether a procedure succeeded or failed using its stable handle. Updates outcome counters without bypassing the canonical procedure record.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable procedure handle. Use the handle returned by lifecycle get/history responses.",
				},
				success: {
					type: "boolean",
					description: "True for success, false for failure.",
				},
				note: {
					type: "string",
					description: "Optional free-text note explaining the outcome.",
				},
				actorRole: {
					type: "string",
					enum: ["user", "assistant", "system"],
					description:
						"Optional role for the actor providing the outcome signal.",
				},
			},
			required: ["handle", "success"],
		},
	},
	{
		name: "memongo_memory_feedback",
		description:
			"Apply confirm/correct/irrelevant feedback to a structured memory using its stable handle. Confirm reinforces, correct routes through revision-aware updates, and irrelevant invalidates with history.",
		inputSchema: {
			type: "object",
			properties: {
				handle: {
					type: "object",
					description:
						"Stable structured memory handle. Use the handle returned by lifecycle get/history responses.",
				},
				signal: {
					type: "string",
					enum: ["confirm", "correct", "irrelevant"],
					description:
						"Feedback signal. confirm reinforces; correct requires patch; irrelevant invalidates the current memory.",
				},
				patch: {
					type: "object",
					description:
						"Structured lifecycle patch required for signal=correct. Supports the same fields as lifecycle update for structured memories.",
				},
				invalidatedBy: {
					type: "object",
					description: "Optional provenance metadata when signal=irrelevant.",
				},
				note: {
					type: "string",
					description: "Optional free-text note explaining the feedback.",
				},
				actorRole: {
					type: "string",
					enum: ["user", "assistant", "system"],
					description:
						"Optional role for the actor providing the feedback signal.",
				},
			},
			required: ["handle", "signal"],
		},
	},
	{
		name: "memongo_status",
		description: "Memory provider status",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
			},
		},
	},
	{
		name: "memongo_chain_trace",
		description:
			"Trace the provenance chain of a derived fact back to its source events",
		inputSchema: {
			type: "object",
			properties: {
				factId: { type: "string" },
				collection: {
					type: "string",
					enum: [
						"structured_mem",
						"entities",
						"relations",
						"procedures",
						"entity_links",
					],
				},
				agentId: { type: "string" },
				maxDepth: { type: "number" },
			},
			required: ["factId", "collection"],
		},
	},
	{
		name: "memongo_novelty_scan",
		description:
			"Scan for the most novel/surprising events using vector distance scoring",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				limit: { type: "number" },
				scope: { type: "string" },
			},
		},
	},
	{
		name: "memongo_consolidate",
		description:
			"Run the consolidation pipeline to promote high-value events to structured facts",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				maxEvents: { type: "number" },
				minCombinedScore: { type: "number" },
				scope: { type: "string" },
			},
		},
	},
	{
		name: "memongo_self_edit",
		description:
			"Edit your own core memory blocks directly. Use 'user' for user preferences/profile, 'persona' for your identity/behavior, 'instructions' for task instructions. Changes persist across sessions.",
		inputSchema: {
			type: "object",
			required: ["block", "action", "content"],
			properties: {
				block: {
					type: "string",
					enum: ["user", "persona", "instructions"],
					description: "Which core memory block to edit",
				},
				action: {
					type: "string",
					enum: ["append", "replace", "prepend"],
					description: "How to modify the block",
				},
				content: {
					type: "string",
					description: "The content to write",
				},
				agentId: { type: "string" },
			},
		},
	},
	{
		name: "memongo_state_unified",
		description:
			"Get all three state surfaces (profile, blocks, bundle) in one call",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				scope: { type: "string" },
				scopeRef: { type: "string" },
			},
		},
	},
	{
		name: "memongo_benchmark_ingest",
		description:
			"Replay a benchmark conversation dataset through the canonical writeConversationEvent() pipeline",
		inputSchema: {
			type: "object",
			properties: {
				datasetPath: { type: "string", minLength: 1 },
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: ["session", "user", "agent", "workspace", "tenant", "global"],
				},
				limitConversations: { type: "integer", minimum: 1 },
				limitTurnsPerConversation: { type: "integer", minimum: 1 },
			},
			required: ["datasetPath"],
		},
	},
	{
		name: "memongo_import_conversations",
		description:
			"Import conversation history through the canonical writeConversationEvent() pipeline",
		inputSchema: {
			type: "object",
			properties: {
				datasetPath: { type: "string", minLength: 1 },
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: ["session", "user", "agent", "workspace", "tenant", "global"],
				},
				limitConversations: { type: "integer", minimum: 1 },
				limitTurnsPerConversation: { type: "integer", minimum: 1 },
			},
			required: ["datasetPath"],
		},
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
					enum: ["session", "user", "agent", "workspace", "tenant", "global"],
				},
				limitConversations: { type: "integer", minimum: 1 },
				limitTurnsPerConversation: { type: "integer", minimum: 1 },
			},
			required: ["datasetPath"],
		},
	},
	{
		name: "memongo_admin_access_trends",
		description:
			"Inspect rolling 7-day access trends from the access_events time series collection",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				collection: {
					type: "string",
					enum: [
						"events",
						"structured_mem",
						"procedures",
						"episodes",
						"entities",
						"relations",
					],
				},
				memoryIds: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				windowDays: { type: "integer", minimum: 1 },
				limit: { type: "integer", minimum: 1, maximum: 100 },
			},
		},
	},
	{
		name: "memongo_admin_access_summaries",
		description:
			"Inspect aggregate access counts and last-access timestamps from the access_events time series collection",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				collection: {
					type: "string",
					enum: [
						"events",
						"structured_mem",
						"procedures",
						"episodes",
						"entities",
						"relations",
					],
				},
				memoryIds: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				windowDays: { type: "integer", minimum: 1 },
			},
			required: ["collection", "memoryIds"],
		},
	},
	{
		name: "memongo_admin_list_traces",
		description: "List recent recall traces for operator debugging",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 100 },
			},
		},
	},
	{
		name: "memongo_admin_get_trace",
		description: "Fetch one recall trace by traceId",
		inputSchema: {
			type: "object",
			properties: {
				traceId: { type: "string", minLength: 1 },
				agentId: { type: "string" },
			},
			required: ["traceId"],
		},
	},
	{
		name: "memongo_list_jobs",
		description: "List memory jobs for an agent",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				status: {
					type: "string",
					enum: ["pending", "running", "completed", "failed", "cancelled"],
				},
				limit: { type: "integer", minimum: 1, maximum: 100 },
				jobType: {
					type: "string",
					enum: [
						"consolidation",
						"extraction",
						"import",
						"materialization",
						"enrichment",
					],
				},
			},
		},
	},
	{
		name: "memongo_get_job",
		description: "Fetch one memory job by jobId",
		inputSchema: {
			type: "object",
			properties: {
				jobId: { type: "string", minLength: 1 },
				agentId: { type: "string" },
			},
			required: ["jobId"],
		},
	},
	{
		name: "memongo_search_detailed",
		description:
			"Full CRAG search pipeline with scored results, trust annotations, and source provenance",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				limit: { type: "number" },
				maxResults: { type: "number" },
				minScore: { type: "number" },
				searchMode: { type: "string", enum: ["auto", "direct", "agentic"] },
				maxPasses: { type: "number" },
				returnPlan: { type: "boolean" },
				searchConfig: {
					type: "object",
					properties: {
						recipe: {
							type: "string",
							enum: ["fast", "hybrid", "deep", "temporal", "chain-of-thought"],
						},
						maxResults: { type: "number" },
						searchMode: {
							type: "string",
							enum: ["auto", "direct", "agentic"],
						},
						maxPasses: { type: "number" },
						sourcePreference: {
							type: "array",
							items: { type: "string" },
						},
						timeRange: {
							type: "object",
							properties: {
								preset: { type: "string" },
								start: { type: "string" },
								end: { type: "string" },
							},
						},
						needExactEvidence: { type: "boolean" },
						recallProfile: {
							type: "string",
							enum: ["latency", "balanced", "proof"],
						},
						numCandidates: { type: "number" },
						fusionMethod: {
							type: "string",
							enum: ["scoreFusion", "rankFusion", "js-merge"],
						},
						hybridMode: {
							type: "string",
							enum: ["hybrid", "vector-only"],
						},
						allowHybridBackstop: { type: "boolean" },
						lexicalPrefilter: {
							type: "string",
							enum: ["disabled", "experimental"],
						},
					},
				},
			},
			required: ["query"],
		},
	},
	{
		name: "memongo_hydrate_active_slate",
		description:
			"Load the highest-salience active memories (hot context for current session)",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				scope: { type: "string" },
				scopeRef: { type: "string" },
				maxItems: { type: "number" },
			},
		},
	},
	{
		name: "memongo_discovery_projection",
		description:
			"Build a discovery projection (entity-brief, topic-brief, what-changed, contradiction-report)",
		inputSchema: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: [
						"entity-brief",
						"topic-brief",
						"what-changed",
						"contradiction-report",
					],
				},
				query: { type: "string" },
				agentId: { type: "string" },
				scope: { type: "string" },
				scopeRef: { type: "string" },
				maxItems: { type: "number" },
			},
			required: ["kind"],
		},
	},
	{
		name: "memongo_write_structured",
		description: "Write a structured memory entry directly",
		inputSchema: {
			type: "object",
			properties: {
				entry: { type: "object" },
				agentId: { type: "string" },
			},
			required: ["entry"],
		},
	},
	{
		name: "memongo_write_procedure",
		description: "Write a step-by-step procedure",
		inputSchema: {
			type: "object",
			properties: {
				entry: { type: "object" },
				agentId: { type: "string" },
			},
			required: ["entry"],
		},
	},
	{
		name: "memongo_status_detailed",
		description:
			"Detailed health status: events, entities, projection lag, lane coverage, diagnostics",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
	},
	{
		name: "memongo_stats",
		description:
			"Memory statistics: source counts, embedding coverage, index stats",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
	},
	{
		name: "memongo_sync",
		description: "Trigger a memory sync operation",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				reason: { type: "string" },
				force: { type: "boolean" },
			},
		},
	},
	{
		name: "memongo_probe_embedding",
		description: "Probe embedding model availability",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
	},
	{
		name: "memongo_probe_vector",
		description: "Probe vector search availability",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
	},
	{
		name: "memongo_relevance_explain",
		description:
			"Detailed relevance diagnostics for a query: artifacts, health, scores",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				sourceScope: {
					type: "string",
					enum: ["all", "memory", "kb", "structured"],
				},
				maxResults: { type: "number" },
				minScore: { type: "number" },
				deep: { type: "boolean" },
			},
			required: ["query"],
		},
	},
	{
		name: "memongo_relevance_benchmark",
		description: "Run relevance benchmark suite",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				datasetPath: { type: "string" },
				maxResults: { type: "number" },
				minScore: { type: "number" },
			},
		},
	},
	{
		name: "memongo_relevance_report",
		description: "Relevance health report: hit rate, empty rate, fallback rate",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				windowMs: { type: "number" },
			},
		},
	},
	{
		name: "memongo_relevance_sample_rate",
		description: "Current relevance sampling rate and degraded signal count",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
	},
] as const

const server = new Server(
	{
		name: "memongo",
		version: "0.1.0",
	},
	{
		capabilities: { tools: {} },
	},
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [...toolList],
}))

export async function handleToolCall(
	name: string,
	args: Record<string, unknown>,
	client: MemongoMcpClient = memongo,
) {
	try {
		const memongo = client
		if (name === "memongo_search") {
			const out = await memongo.search({
				query: typeof args.query === "string" ? args.query : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
				minScore: typeof args.minScore === "number" ? args.minScore : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_search_kb") {
			const out = await memongo.searchKB({
				query: typeof args.query === "string" ? args.query : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_read_file") {
			const out = await memongo.readFile({
				relPath: typeof args.relPath === "string" ? args.relPath : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				from: typeof args.from === "number" ? args.from : undefined,
				lines: typeof args.lines === "number" ? args.lines : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_add") {
			const out = await memongo.add({
				content: typeof args.content === "string" ? args.content : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				sessionId:
					typeof args.sessionId === "string" ? args.sessionId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_write_event") {
			const role = args.role
			if (
				role !== "user" &&
				role !== "assistant" &&
				role !== "system" &&
				role !== "tool"
			) {
				throw new Error("invalid role")
			}
			const out = await memongo.writeEvent({
				role,
				body: typeof args.body === "string" ? args.body : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				sessionId:
					typeof args.sessionId === "string" ? args.sessionId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_profile") {
			const out = await memongo.profile({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_build_context_bundle") {
			const scope = args.scope
			if (
				scope !== undefined &&
				scope !== "session" &&
				scope !== "user" &&
				scope !== "agent" &&
				scope !== "workspace" &&
				scope !== "tenant" &&
				scope !== "global"
			) {
				throw new Error("invalid scope")
			}
			const discoveryKind = args.discoveryKind
			if (
				discoveryKind !== undefined &&
				discoveryKind !== "entity-brief" &&
				discoveryKind !== "topic-brief" &&
				discoveryKind !== "what-changed" &&
				discoveryKind !== "contradiction-report"
			) {
				throw new Error("invalid discoveryKind")
			}
			const validatedScope =
				scope === "session" ||
				scope === "user" ||
				scope === "agent" ||
				scope === "workspace" ||
				scope === "tenant" ||
				scope === "global"
					? scope
					: undefined
			const validatedDiscoveryKind =
				discoveryKind === "entity-brief" ||
				discoveryKind === "topic-brief" ||
				discoveryKind === "what-changed" ||
				discoveryKind === "contradiction-report"
					? discoveryKind
					: undefined
			const timeRange =
				typeof args.timeRange === "object" &&
				args.timeRange !== null &&
				!Array.isArray(args.timeRange)
					? (args.timeRange as Record<string, unknown>)
					: undefined
			const out = await memongo.buildContextBundle({
				query: typeof args.query === "string" ? args.query : undefined,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope: validatedScope,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
				sessionId:
					typeof args.sessionId === "string" ? args.sessionId : undefined,
				tokenBudget:
					typeof args.tokenBudget === "number" ? args.tokenBudget : undefined,
				maxActiveItems:
					typeof args.maxActiveItems === "number"
						? args.maxActiveItems
						: undefined,
				maxEvidenceItems:
					typeof args.maxEvidenceItems === "number"
						? args.maxEvidenceItems
						: undefined,
				maxRecentEvents:
					typeof args.maxRecentEvents === "number"
						? args.maxRecentEvents
						: undefined,
				includeDiscoveryProjection:
					typeof args.includeDiscoveryProjection === "boolean"
						? args.includeDiscoveryProjection
						: undefined,
				discoveryKind: validatedDiscoveryKind,
				includeProfile:
					typeof args.includeProfile === "boolean"
						? args.includeProfile
						: undefined,
				timeRange: timeRange
					? {
							preset:
								typeof timeRange.preset === "string"
									? timeRange.preset
									: undefined,
							start:
								typeof timeRange.start === "string"
									? timeRange.start
									: undefined,
							end:
								typeof timeRange.end === "string" ? timeRange.end : undefined,
						}
					: undefined,
				mode:
					args.mode === "wake-up" || args.mode === "full"
						? args.mode
						: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_status") {
			const out = await memongo.status(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			const guidance = {
				quickStart:
					"Call memongo_profile first. Then memongo_search_detailed for queries. Use memongo_write_event to save insights.",
				bestPractices: [
					"Call memongo_profile or memongo_state_unified at session start",
					"Save decisions with memongo_write_structured",
					"Use memongo_search_detailed before answering knowledge questions",
					"Use memongo_build_context_bundle with mode: wake-up for fast session start",
				],
				capabilities: [
					"semantic search",
					"knowledge base search",
					"graph traversal",
					"memory consolidation",
					"profile loading",
					"novelty detection",
					"reasoning chain tracing",
					"active slate hydration",
					"discovery projections",
					"context bundle assembly",
				],
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ ...out, guidance }) }],
			}
		}
		if (RECALL_TOOL_NAMES.has(name)) {
			const roles = Array.isArray(args.roles)
				? args.roles.filter(
						(role): role is "user" | "assistant" | "system" | "tool" =>
							role === "user" ||
							role === "assistant" ||
							role === "system" ||
							role === "tool",
					)
				: undefined
			if (Array.isArray(args.roles) && roles?.length !== args.roles.length) {
				throw new Error("roles must contain only user|assistant|system|tool")
			}
			const out = await memongo.recallConversation({
				query: typeof args.query === "string" ? args.query : undefined,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				sessionId:
					typeof args.sessionId === "string" ? args.sessionId : undefined,
				roles,
				startTime:
					typeof args.startTime === "string" ? args.startTime : undefined,
				endTime: typeof args.endTime === "string" ? args.endTime : undefined,
				timezone: typeof args.timezone === "string" ? args.timezone : undefined,
				includeToolMessages:
					typeof args.includeToolMessages === "boolean"
						? args.includeToolMessages
						: undefined,
				limit:
					typeof args.limit === "number"
						? Math.max(1, Math.min(200, Math.floor(args.limit)))
						: undefined,
			})
			return jsonResult(out)
		}
		if (LIFECYCLE_GET_TOOL_NAMES.has(name)) {
			const out = await memongo.getLifecycleItem({
				handle:
					typeof args.handle === "object" && args.handle !== null
						? (args.handle as any)
						: ({} as any),
			})
			return jsonResult(out)
		}
		if (LIFECYCLE_UPDATE_TOOL_NAMES.has(name)) {
			const out = await memongo.updateLifecycleItem({
				handle:
					typeof args.handle === "object" && args.handle !== null
						? (args.handle as any)
						: ({} as any),
				patch:
					typeof args.patch === "object" && args.patch !== null
						? (args.patch as any)
						: ({} as any),
			})
			return jsonResult(out)
		}
		if (LIFECYCLE_DELETE_TOOL_NAMES.has(name)) {
			const out = await memongo.deleteLifecycleItem({
				handle:
					typeof args.handle === "object" && args.handle !== null
						? (args.handle as any)
						: ({} as any),
				...(typeof args.invalidatedBy === "object" &&
				args.invalidatedBy !== null
					? { invalidatedBy: args.invalidatedBy as Record<string, unknown> }
					: {}),
			})
			return jsonResult(out)
		}
		if (LIFECYCLE_HISTORY_TOOL_NAMES.has(name)) {
			const out = await memongo.getLifecycleHistory({
				handle:
					typeof args.handle === "object" && args.handle !== null
						? (args.handle as any)
						: ({} as any),
				limit:
					typeof args.limit === "number"
						? Math.max(1, Math.min(200, Math.floor(args.limit)))
						: undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_procedure_outcome") {
			if (typeof args.success !== "boolean") {
				throw new Error("success must be a boolean")
			}
			if (
				args.actorRole !== undefined &&
				args.actorRole !== "user" &&
				args.actorRole !== "assistant" &&
				args.actorRole !== "system"
			) {
				throw new Error("actorRole must be user|assistant|system")
			}
			const actorRole: "user" | "assistant" | "system" | undefined =
				args.actorRole === "user" ||
				args.actorRole === "assistant" ||
				args.actorRole === "system"
					? args.actorRole
					: undefined
			const out = await memongo.reportProcedureOutcome({
				handle:
					typeof args.handle === "object" && args.handle !== null
						? (args.handle as any)
						: ({} as any),
				success: args.success,
				...(typeof args.note === "string" ? { note: args.note } : {}),
				...(actorRole ? { actorRole } : {}),
			})
			return jsonResult(out)
		}
		if (name === "memongo_memory_feedback") {
			const signal =
				args.signal === "confirm" ||
				args.signal === "correct" ||
				args.signal === "irrelevant"
					? args.signal
					: null
			if (!signal) {
				throw new Error("signal must be confirm|correct|irrelevant")
			}
			if (
				args.actorRole !== undefined &&
				args.actorRole !== "user" &&
				args.actorRole !== "assistant" &&
				args.actorRole !== "system"
			) {
				throw new Error("actorRole must be user|assistant|system")
			}
			const actorRole: "user" | "assistant" | "system" | undefined =
				args.actorRole === "user" ||
				args.actorRole === "assistant" ||
				args.actorRole === "system"
					? args.actorRole
					: undefined
			const handle =
				typeof args.handle === "object" && args.handle !== null
					? (args.handle as any)
					: ({} as any)
			const common = {
				handle,
				...(typeof args.note === "string" ? { note: args.note } : {}),
				...(actorRole ? { actorRole } : {}),
			}
			const out =
				signal === "correct"
					? await memongo.applyMemoryFeedback({
							...common,
							signal,
							patch:
								typeof args.patch === "object" && args.patch !== null
									? (args.patch as any)
									: ({} as any),
						})
					: signal === "irrelevant"
						? await memongo.applyMemoryFeedback({
								...common,
								signal,
								...(typeof args.invalidatedBy === "object" &&
								args.invalidatedBy !== null
									? {
											invalidatedBy: args.invalidatedBy as Record<
												string,
												unknown
											>,
										}
									: {}),
							})
						: await memongo.applyMemoryFeedback({
								...common,
								signal,
							})
			return jsonResult(out)
		}
		if (name === "memongo_chain_trace") {
			const out = await memongo.traceChain({
				factId: typeof args.factId === "string" ? args.factId : "",
				collection: typeof args.collection === "string" ? args.collection : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_novelty_scan") {
			const out = await memongo.scanNovelty({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
				scope: typeof args.scope === "string" ? args.scope : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_consolidate") {
			const out = await memongo.consolidate({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				maxEvents:
					typeof args.maxEvents === "number" ? args.maxEvents : undefined,
				minCombinedScore:
					typeof args.minCombinedScore === "number"
						? args.minCombinedScore
						: undefined,
				scope: typeof args.scope === "string" ? args.scope : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_self_edit") {
			const block = typeof args.block === "string" ? args.block : ""
			const action = typeof args.action === "string" ? args.action : "replace"
			const validBlocks = ["user", "persona", "instructions"]
			const validActions = ["append", "replace", "prepend"]
			if (!validBlocks.includes(block)) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "block must be user|persona|instructions",
							}),
						},
					],
					isError: true,
				}
			}
			if (!validActions.includes(action)) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "action must be append|replace|prepend",
							}),
						},
					],
					isError: true,
				}
			}
			const out = await memongo.selfEdit({
				block: block as "user" | "persona" | "instructions",
				action: action as "append" | "replace" | "prepend",
				content: typeof args.content === "string" ? args.content : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_search_detailed") {
			const searchConfig =
				typeof args.searchConfig === "object" &&
				args.searchConfig !== null &&
				!Array.isArray(args.searchConfig)
					? (args.searchConfig as Record<string, unknown>)
					: undefined
			const searchConfigTimeRange =
				typeof searchConfig?.timeRange === "object" &&
				searchConfig.timeRange !== null &&
				!Array.isArray(searchConfig.timeRange)
					? (searchConfig.timeRange as Record<string, unknown>)
					: undefined
			const searchConfigSourcePreference = Array.isArray(
				searchConfig?.sourcePreference,
			)
				? searchConfig.sourcePreference.filter(
						(
							value,
						): value is
							| "reference"
							| "conversation"
							| "structured"
							| "procedural"
							| "episodic"
							| "graph" =>
							value === "reference" ||
							value === "conversation" ||
							value === "structured" ||
							value === "procedural" ||
							value === "episodic" ||
							value === "graph",
					)
				: undefined
			const out = await memongo.searchDetailed({
				query: typeof args.query === "string" ? args.query : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
				maxResults:
					typeof args.maxResults === "number" ? args.maxResults : undefined,
				minScore: typeof args.minScore === "number" ? args.minScore : undefined,
				searchMode:
					args.searchMode === "auto" ||
					args.searchMode === "direct" ||
					args.searchMode === "agentic"
						? args.searchMode
						: undefined,
				maxPasses:
					typeof args.maxPasses === "number" ? args.maxPasses : undefined,
				returnPlan:
					typeof args.returnPlan === "boolean" ? args.returnPlan : undefined,
				searchConfig: searchConfig
					? {
							recipe:
								searchConfig.recipe === "fast" ||
								searchConfig.recipe === "hybrid" ||
								searchConfig.recipe === "deep" ||
								searchConfig.recipe === "temporal" ||
								searchConfig.recipe === "chain-of-thought"
									? searchConfig.recipe
									: undefined,
							maxResults:
								typeof searchConfig.maxResults === "number"
									? searchConfig.maxResults
									: undefined,
							searchMode:
								searchConfig.searchMode === "auto" ||
								searchConfig.searchMode === "direct" ||
								searchConfig.searchMode === "agentic"
									? searchConfig.searchMode
									: undefined,
							maxPasses:
								typeof searchConfig.maxPasses === "number"
									? searchConfig.maxPasses
									: undefined,
							sourcePreference: searchConfigSourcePreference,
							timeRange: searchConfigTimeRange
								? {
										preset:
											typeof searchConfigTimeRange.preset === "string"
												? searchConfigTimeRange.preset
												: undefined,
										start:
											typeof searchConfigTimeRange.start === "string"
												? searchConfigTimeRange.start
												: undefined,
										end:
											typeof searchConfigTimeRange.end === "string"
												? searchConfigTimeRange.end
												: undefined,
									}
								: undefined,
							needExactEvidence:
								typeof searchConfig.needExactEvidence === "boolean"
									? searchConfig.needExactEvidence
									: undefined,
							recallProfile:
								searchConfig.recallProfile === "latency" ||
								searchConfig.recallProfile === "balanced" ||
								searchConfig.recallProfile === "proof"
									? searchConfig.recallProfile
									: undefined,
							numCandidates:
								typeof searchConfig.numCandidates === "number"
									? searchConfig.numCandidates
									: undefined,
							fusionMethod:
								searchConfig.fusionMethod === "scoreFusion" ||
								searchConfig.fusionMethod === "rankFusion" ||
								searchConfig.fusionMethod === "js-merge"
									? searchConfig.fusionMethod
									: undefined,
							hybridMode:
								searchConfig.hybridMode === "hybrid" ||
								searchConfig.hybridMode === "vector-only"
									? searchConfig.hybridMode
									: undefined,
							allowHybridBackstop:
								typeof searchConfig.allowHybridBackstop === "boolean"
									? searchConfig.allowHybridBackstop
									: undefined,
							lexicalPrefilter:
								searchConfig.lexicalPrefilter === "disabled" ||
								searchConfig.lexicalPrefilter === "experimental"
									? searchConfig.lexicalPrefilter
									: undefined,
						}
					: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_hydrate_active_slate") {
			const out = await memongo.hydrateActiveSlate({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope:
					typeof args.scope === "string" ? (args.scope as "user") : undefined,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
				maxItems: typeof args.maxItems === "number" ? args.maxItems : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_discovery_projection") {
			const kind = args.kind
			if (
				kind !== "entity-brief" &&
				kind !== "topic-brief" &&
				kind !== "what-changed" &&
				kind !== "contradiction-report"
			) {
				throw new Error(
					"kind is required and must be entity-brief|topic-brief|what-changed|contradiction-report",
				)
			}
			const out = await memongo.buildDiscoveryProjection({
				kind,
				query: typeof args.query === "string" ? args.query : undefined,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope:
					typeof args.scope === "string" ? (args.scope as "user") : undefined,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
				maxItems: typeof args.maxItems === "number" ? args.maxItems : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_write_structured") {
			const entry =
				typeof args.entry === "object" && args.entry !== null
					? (args.entry as Record<string, unknown>)
					: {}
			const out = await memongo.writeStructured({
				entry,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_write_procedure") {
			const entry =
				typeof args.entry === "object" && args.entry !== null
					? (args.entry as Record<string, unknown>)
					: {}
			const out = await memongo.writeProcedure({
				entry,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_status_detailed") {
			const out = await memongo.getDetailedStatus(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_stats") {
			const out = await memongo.stats(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_sync") {
			const out = await memongo.sync({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				reason: typeof args.reason === "string" ? args.reason : undefined,
				force: typeof args.force === "boolean" ? args.force : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_probe_embedding") {
			const out = await memongo.probeEmbedding(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_probe_vector") {
			const out = await memongo.probeVector(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_relevance_explain") {
			const out = await memongo.relevanceExplain({
				query: typeof args.query === "string" ? args.query : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				sourceScope:
					args.sourceScope === "all" ||
					args.sourceScope === "memory" ||
					args.sourceScope === "kb" ||
					args.sourceScope === "structured"
						? args.sourceScope
						: undefined,
				maxResults:
					typeof args.maxResults === "number" ? args.maxResults : undefined,
				minScore: typeof args.minScore === "number" ? args.minScore : undefined,
				deep: typeof args.deep === "boolean" ? args.deep : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_relevance_benchmark") {
			const out = await memongo.relevanceBenchmark({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				datasetPath:
					typeof args.datasetPath === "string" ? args.datasetPath : undefined,
				maxResults:
					typeof args.maxResults === "number" ? args.maxResults : undefined,
				minScore: typeof args.minScore === "number" ? args.minScore : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_relevance_report") {
			const out = await memongo.relevanceReport(
				typeof args.agentId === "string" ? args.agentId : undefined,
				typeof args.windowMs === "number" ? args.windowMs : undefined,
			)
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_relevance_sample_rate") {
			const out = await memongo.relevanceSampleRate(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_state_unified") {
			const out = await memongo.state({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope:
					typeof args.scope === "string"
						? (args.scope as
								| "session"
								| "user"
								| "agent"
								| "workspace"
								| "tenant"
								| "global")
						: undefined,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(out),
					},
				],
			}
		}
		if (name === "memongo_benchmark_ingest") {
			if (
				typeof args.datasetPath !== "string" ||
				args.datasetPath.length === 0
			) {
				throw new Error("datasetPath is required")
			}
			const out = await memongo.benchmarkIngest({
				datasetPath: args.datasetPath,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope:
					args.scope === "session" ||
					args.scope === "user" ||
					args.scope === "agent" ||
					args.scope === "workspace" ||
					args.scope === "tenant" ||
					args.scope === "global"
						? args.scope
						: undefined,
				limitConversations:
					typeof args.limitConversations === "number"
						? args.limitConversations
						: undefined,
				limitTurnsPerConversation:
					typeof args.limitTurnsPerConversation === "number"
						? args.limitTurnsPerConversation
						: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (IMPORT_TOOL_NAMES.has(name)) {
			if (
				typeof args.datasetPath !== "string" ||
				args.datasetPath.length === 0
			) {
				throw new Error("datasetPath is required")
			}
			const out = await memongo.importConversations({
				datasetPath: args.datasetPath,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope:
					args.scope === "session" ||
					args.scope === "user" ||
					args.scope === "agent" ||
					args.scope === "workspace" ||
					args.scope === "tenant" ||
					args.scope === "global"
						? args.scope
						: undefined,
				limitConversations:
					typeof args.limitConversations === "number"
						? args.limitConversations
						: undefined,
				limitTurnsPerConversation:
					typeof args.limitTurnsPerConversation === "number"
						? args.limitTurnsPerConversation
						: undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_admin_access_trends") {
			const out = await memongo.accessTrends({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				collection:
					args.collection === "events" ||
					args.collection === "structured_mem" ||
					args.collection === "procedures" ||
					args.collection === "episodes" ||
					args.collection === "entities" ||
					args.collection === "relations"
						? args.collection
						: undefined,
				memoryIds: Array.isArray(args.memoryIds)
					? args.memoryIds.filter(
							(memoryId): memoryId is string =>
								typeof memoryId === "string" && memoryId.trim().length > 0,
						)
					: undefined,
				windowDays:
					typeof args.windowDays === "number" ? args.windowDays : undefined,
				limit:
					typeof args.limit === "number"
						? Math.max(1, Math.min(100, Math.floor(args.limit)))
						: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_admin_access_summaries") {
			const memoryIds = Array.isArray(args.memoryIds)
				? args.memoryIds.filter(
						(memoryId): memoryId is string =>
							typeof memoryId === "string" && memoryId.trim().length > 0,
					)
				: []
			if (memoryIds.length === 0) {
				throw new Error("memoryIds is required")
			}
			if (
				args.collection !== "events" &&
				args.collection !== "structured_mem" &&
				args.collection !== "procedures" &&
				args.collection !== "episodes" &&
				args.collection !== "entities" &&
				args.collection !== "relations"
			) {
				throw new Error("collection is required")
			}
			const out = await memongo.accessSummaries({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				collection: args.collection,
				memoryIds,
				windowDays:
					typeof args.windowDays === "number" ? args.windowDays : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_admin_list_traces") {
			const out = await memongo.listRecallTraces({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit:
					typeof args.limit === "number"
						? Math.max(1, Math.min(100, Math.floor(args.limit)))
						: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_admin_get_trace") {
			if (typeof args.traceId !== "string" || !args.traceId.trim()) {
				throw new Error("traceId is required")
			}
			const out = await memongo.getRecallTrace({
				traceId: args.traceId,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_list_jobs") {
			const out = await memongo.listJobs({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				status:
					args.status === "pending" ||
					args.status === "running" ||
					args.status === "completed" ||
					args.status === "failed" ||
					args.status === "cancelled"
						? args.status
						: undefined,
				limit:
					typeof args.limit === "number"
						? Math.max(1, Math.min(100, Math.floor(args.limit)))
						: undefined,
				jobType:
					args.jobType === "consolidation" ||
					args.jobType === "extraction" ||
					args.jobType === "import" ||
					args.jobType === "materialization" ||
					args.jobType === "enrichment"
						? args.jobType
						: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "memongo_get_job") {
			if (typeof args.jobId !== "string" || !args.jobId.trim()) {
				throw new Error("jobId is required")
			}
			const out = await memongo.getJob({
				jobId: args.jobId,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		throw new Error(`unknown tool: ${name}`)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return jsonResult({ error: message }, true)
	}
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	return handleToolCall(
		request.params.name,
		(request.params.arguments ?? {}) as Record<string, unknown>,
	)
})

async function main(): Promise<void> {
	const transport = new StdioServerTransport()
	await server.connect(transport)
}

const entrypointHref = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: undefined

if (import.meta.url === entrypointHref) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
