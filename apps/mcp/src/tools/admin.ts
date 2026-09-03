import { MEMORY_SCOPE_VALUES } from "@memongo/lib"
import type { McpToolDefinition } from "../tool-registry.js"

// Admin tools (P1.2): operator diagnostics, lifecycle handle management,
// jobs/traces, sync, and probes. Registered only when MEMONGO_MCP_ADMIN=1.
export const adminTools: readonly McpToolDefinition[] = [
	{
		name: "memongo_search_kb",
		description: "Search Memongo knowledge base",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				limit: { type: "number" },
				scope: {
					type: "string",
					enum: [...MEMORY_SCOPE_VALUES],
					description: "Restrict results to this memory isolation scope.",
				},
				scopeRef: {
					type: "string",
					description:
						"Restrict results to this KB scope reference (for example a workspace path). Defaults to the agent KB scope.",
				},
				minScore: {
					type: "number",
					description:
						"Minimum relevance score (0-1) for a result to be included.",
				},
				filter: {
					type: "object",
					description:
						"Optional KB metadata filter (typed fields only; query-operator keys are rejected).",
					properties: {
						tags: {
							type: "array",
							items: { type: "string" },
						},
						category: { type: "string" },
						source: { type: "string" },
					},
				},
				fusionMethod: {
					type: "string",
					enum: ["scoreFusion", "rankFusion", "js-merge"],
					description: "Server-side fusion preference for the KB lane.",
				},
			},
			required: ["query"],
		},
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
				scope: {
					type: "string",
					enum: [...MEMORY_SCOPE_VALUES],
				},
				scopeRef: { type: "string" },
			},
		},
		category: "admin",
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
				resolveContradictions: { type: "boolean" },
				llmDedup: { type: "boolean" },
				scope: {
					type: "string",
					enum: [...MEMORY_SCOPE_VALUES],
				},
				scopeRef: { type: "string" },
			},
		},
		category: "admin",
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
					// Canonical scope enum from the single contract source (P2.2).
					enum: [...MEMORY_SCOPE_VALUES],
				},
				scopeRef: { type: "string" },
				limitConversations: { type: "integer", minimum: 1 },
				limitTurnsPerConversation: { type: "integer", minimum: 1 },
			},
			required: ["datasetPath"],
		},
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
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
		category: "admin",
	},
	{
		name: "memongo_hydrate_active_slate",
		description:
			"Load the highest-salience active memories (hot context for current session)",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: [...MEMORY_SCOPE_VALUES],
				},
				scopeRef: { type: "string" },
				maxItems: { type: "number" },
			},
		},
		category: "admin",
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
				scope: {
					type: "string",
					enum: [...MEMORY_SCOPE_VALUES],
				},
				scopeRef: { type: "string" },
				maxItems: { type: "number" },
			},
			required: ["kind"],
		},
		category: "admin",
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
		category: "admin",
	},
	{
		name: "memongo_status_detailed",
		description:
			"Detailed health status: events, entities, projection lag, lane coverage, diagnostics",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
		category: "admin",
	},
	{
		name: "memongo_stats",
		description:
			"Memory statistics: source counts, embedding coverage, index stats",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
		category: "admin",
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
		category: "admin",
	},
	{
		name: "memongo_erase_agent",
		description:
			"Irreversibly erase every collection entry for one agent (tenant erasure); returns a per-collection receipt. Requires confirm='erase'",
		inputSchema: {
			type: "object",
			properties: {
				confirm: {
					type: "string",
					enum: ["erase"],
					description: "Typed confirmation; the call is a no-op 400 without it",
				},
				agentId: { type: "string" },
			},
			required: ["confirm"],
		},
		category: "admin",
	},
	{
		name: "memongo_quarantine_list",
		description:
			"List quarantined memories awaiting review (oldest first); unset status lists every stage including decided history",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				status: {
					type: "string",
					enum: ["pending-review", "promoted", "rejected"],
				},
				limit: { type: "integer", minimum: 1, maximum: 100 },
			},
		},
		category: "admin",
	},
	{
		name: "memongo_quarantine_promote",
		description:
			"Overrule the injection classifier and write a quarantined memory as structured memory; irreversible for the entry",
		inputSchema: {
			type: "object",
			properties: {
				quarantineId: {
					type: "string",
					minLength: 1,
					description: "Id from memongo_quarantine_list",
				},
				agentId: { type: "string" },
				reviewerId: { type: "string" },
				reviewNotes: { type: "string" },
			},
			required: ["quarantineId"],
		},
		category: "admin",
	},
	{
		name: "memongo_quarantine_reject",
		description:
			"Discard a quarantined memory (kept as audit trail; only unreviewed entries expire)",
		inputSchema: {
			type: "object",
			properties: {
				quarantineId: {
					type: "string",
					minLength: 1,
					description: "Id from memongo_quarantine_list",
				},
				agentId: { type: "string" },
				reviewerId: { type: "string" },
				reviewNotes: { type: "string" },
			},
			required: ["quarantineId"],
		},
		category: "admin",
	},
	{
		name: "memongo_probe_embedding",
		description: "Probe embedding model availability",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
		category: "admin",
	},
	{
		name: "memongo_probe_vector",
		description: "Probe vector search availability",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
		category: "admin",
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
		category: "admin",
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
		category: "admin",
	},
	{
		name: "memongo_relevance_sample_rate",
		description: "Current relevance sampling rate and degraded signal count",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
		category: "admin",
	},
]
