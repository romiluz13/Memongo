import { MEMORY_SCOPE_VALUES } from "@memongo/lib"
import type { McpToolDefinition } from "../tool-registry.js"

// Canonical scope enum from the single contract source (@memongo/lib, P2.2).
const memoryScopeEnum = [...MEMORY_SCOPE_VALUES]

// Core tools: the default MCP surface (P1.2). These cover the write -> extract
// -> recall loop plus profile/state/self-edit/feedback and are always
// registered, regardless of env flags.
export const coreTools: readonly McpToolDefinition[] = [
	{
		name: "memongo_search",
		description:
			"Semantic search across Memongo memory; returns the most relevant stored memories for a natural-language query. Use when answering questions about prior work, user preferences, or earlier decisions — search BEFORE saying you don't know. Use memongo_search_detailed when you need scores, trust annotations, and source provenance.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Natural-language search query.",
				},
				agentId: {
					type: "string",
					description:
						"Restrict results to this agent's memories. Defaults to the server-configured agent.",
				},
				limit: {
					type: "number",
					description: "Maximum results to return.",
				},
				minScore: {
					type: "number",
					description:
						"Minimum relevance score (0-1) for a result to be included.",
				},
				scope: {
					type: "string",
					enum: memoryScopeEnum,
					description: "Optional memory isolation scope for retrieval.",
				},
				scopeRef: {
					type: "string",
					description:
						"Optional scope reference, for example a workspace path.",
				},
			},
			required: ["query"],
		},
		category: "core",
	},
	{
		name: "memongo_search_detailed",
		description:
			"Full CRAG search pipeline with scored results, trust annotations, and source provenance. Use when you must audit why memories matched, tune retrieval (recipe, fusion, time range, passes), or cite evidence for an answer; prefer memongo_search for quick lookups.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: memoryScopeEnum,
				},
				scopeRef: { type: "string" },
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
		category: "core",
	},
	{
		name: "memongo_add",
		description:
			"Add a user message to memory. Use when ingesting user-authored content verbatim; use memongo_write_event for assistant/system/tool messages or explicit timestamps, and follow up with memongo_extract to derive structured memories.",
		inputSchema: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "The user message text to store in memory.",
				},
				agentId: {
					type: "string",
					description:
						"Agent whose memory stores the message. Defaults to the server-configured agent.",
				},
				sessionId: {
					type: "string",
					description:
						"Conversation session this message belongs to; groups related messages for recall.",
				},
				metadata: {
					type: "object",
					description:
						"Optional metadata stored verbatim with the event (query-operator keys are rejected).",
				},
				scope: {
					type: "string",
					enum: memoryScopeEnum,
					description: "Visibility scope for the memory.",
				},
				scopeRef: {
					type: "string",
					description:
						"Scope reference (user id, workspace path, ...) when scope is set.",
				},
				customId: {
					type: "string",
					description:
						"Idempotency key for this write: a replay returns the original receipt, a key reused with a different payload is rejected.",
				},
				expiresAt: {
					type: "string",
					format: "date-time",
					description:
						"Instant after which this memory expires (TTL). Must be in the future.",
				},
			},
			required: ["content"],
		},
		category: "core",
	},
	{
		name: "memongo_write_event",
		description:
			"Write a conversation event (any role: user, assistant, system, tool) to memory. Use when saving durable facts, decisions, preferences, or project context worth remembering in later sessions — not ephemeral chatter or transient task state. Follow up with memongo_extract for important events.",
		inputSchema: {
			type: "object",
			properties: {
				role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
				body: { type: "string" },
				agentId: { type: "string" },
				sessionId: { type: "string" },
				timestamp: { type: "string", format: "date-time" },
				validAt: { type: "string", format: "date-time" },
				invalidAt: { type: "string", format: "date-time" },
				scope: {
					type: "string",
					enum: memoryScopeEnum,
				},
				scopeRef: { type: "string" },
				metadata: {
					type: "object",
					description:
						"Optional metadata stored verbatim with the event (query-operator keys are rejected).",
				},
				customId: {
					type: "string",
					description:
						"Idempotency key for this write: a replay returns the original receipt, a key reused with a different payload is rejected.",
				},
				expiresAt: {
					type: "string",
					format: "date-time",
					description:
						"Instant after which this event expires (TTL). Must be in the future.",
				},
			},
			required: ["role", "body"],
		},
		category: "core",
	},
	{
		name: "memongo_write_structured",
		description:
			"Write a structured memory entry directly (decision, preference, fact, todo, ...). Use when a durable fact should persist across sessions and be retrievable by type+key; writing the same type+key again updates the existing memory.",
		inputSchema: {
			type: "object",
			properties: {
				entry: {
					type: "object",
					description: "Structured memory entry to write.",
					properties: {
						type: {
							type: "string",
							enum: [
								"decision",
								"preference",
								"person",
								"todo",
								"fact",
								"project",
								"architecture",
								"contact",
								"milestone",
								"problem",
								"emotional",
								"identity",
								"instruction",
								"custom",
							],
							description: "Category of the memory.",
						},
						key: {
							type: "string",
							description:
								"Stable identifier within the type (for example `preferred-editor`). Writing the same type+key again updates the existing memory.",
						},
						value: {
							type: "string",
							description: "The fact content (for example `Neovim`).",
						},
						context: {
							type: "string",
							description: "Optional rationale or surrounding context.",
						},
						confidence: {
							type: "number",
							minimum: 0,
							maximum: 1,
							description: "Confidence in the fact, 0-1.",
						},
						source: {
							type: "string",
							enum: ["agent", "user", "session", "ingestion"],
							description: "Where the fact came from.",
						},
						sessionId: {
							type: "string",
							description: "Originating conversation session, if any.",
						},
						tags: {
							type: "array",
							items: { type: "string" },
							description: "Free-form tags for grouping.",
						},
						salience: {
							type: "string",
							enum: ["critical", "high", "normal", "low"],
							description: "Importance used for active-context hydration.",
						},
						temporalScope: {
							type: "string",
							enum: ["ongoing", "bounded", "permanent", "transient"],
							description: "Expected lifetime of the fact.",
						},
						scope: {
							type: "string",
							enum: memoryScopeEnum,
							description: "Visibility scope for the entry.",
						},
						scopeRef: {
							type: "string",
							description:
								"Scope reference (user id, workspace path, ...) when scope is set.",
						},
						expiresAt: {
							type: "string",
							format: "date-time",
							description:
								"Instant after which this entry expires (TTL). Must be in the future.",
						},
					},
					required: ["type", "key", "value"],
				},
				agentId: {
					type: "string",
					description:
						"Agent whose memory stores the entry. Defaults to the server-configured agent.",
				},
			},
			required: ["entry"],
		},
		category: "core",
	},
	{
		name: "memongo_recall_conversation",
		description:
			"Search and retrieve past conversation messages with canonical citations. Use when you need the exact wording of what was said, or messages from a specific session or time range; use memongo_search for conceptual lookups. Use exact ISO 8601 timestamps (for example `2026-04-08T14:30:00Z`); for date-only input (`2026-04-08`), include timezone to resolve local day boundaries correctly. Tool messages are excluded by default unless includeToolMessages is true.",
		inputSchema: {
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
					enum: memoryScopeEnum,
					description: "Optional memory isolation scope for recall.",
				},
				scopeRef: {
					type: "string",
					description: "Optional reference for the selected memory scope.",
				},
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
		},
		category: "core",
	},
	{
		name: "memongo_build_context_bundle",
		description:
			"Build a prompt-ready context bundle from Memongo memory. Use when starting a session (mode wake-up returns a compact 250-token projection) or before a complex task to load profile, active items, and relevant evidence in one call.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: memoryScopeEnum,
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
		category: "core",
	},
	{
		name: "memongo_profile",
		description:
			"Synthesize the user/agent profile from Memongo memory. Use when you need stable preferences, identity facts, and behavioral traits rather than raw events — typically at session start.",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: memoryScopeEnum,
				},
				scopeRef: { type: "string" },
			},
		},
		category: "core",
	},
	{
		name: "memongo_state_unified",
		description:
			"Get all three state surfaces (profile, blocks, bundle) in one call. Use when you want the full memory state at session start without multiple round trips.",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				scope: {
					type: "string",
					enum: memoryScopeEnum,
				},
				scopeRef: { type: "string" },
			},
		},
		category: "core",
	},
	{
		name: "memongo_self_edit",
		description:
			"Edit your own core memory blocks directly. Use when the user asks you to remember a lasting preference or change your behavior: 'user' for user preferences/profile, 'persona' for your identity/behavior, 'instructions' for task instructions. Changes persist across sessions.",
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
		category: "core",
	},
	{
		name: "memongo_memory_feedback",
		description:
			"Apply confirm/correct/irrelevant feedback to a structured memory using its stable handle. Use when the user confirms a memory is right, corrects it, or says it no longer applies. Confirm reinforces, correct routes through revision-aware updates, and irrelevant invalidates with history.",
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
		category: "core",
	},
	{
		name: "memongo_extract",
		description:
			"Extract structured memories, entities, and relations from a previously written event. Use after memongo_write_event (or memongo_add) with the returned eventId to complete the write -> extract pipeline. Extraction runs asynchronously and returns a job id.",
		inputSchema: {
			type: "object",
			properties: {
				eventId: {
					type: "string",
					description:
						"ID of the event to extract from (the eventId returned by memongo_write_event).",
				},
				agentId: {
					type: "string",
					description:
						"Agent whose memory contains the event. Defaults to the server-configured agent.",
				},
				scope: {
					type: "string",
					enum: memoryScopeEnum,
					description: "Scope the event belongs to.",
				},
				scopeRef: {
					type: "string",
					description: "Scope reference for the event's scope.",
				},
			},
			required: ["eventId"],
		},
		category: "core",
	},
]
