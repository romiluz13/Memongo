#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { MemongoClient } from "@memongo/client"
import { isMemoryScopeValue, type MemoryScopeValue } from "@memongo/lib"
import { pathToFileURL } from "node:url"
import { startHttpTransport } from "./http-transport.js"
import { selectEnabledTools, toWireTool, toolCatalog } from "./tool-registry.js"
import { MEMONGO_SERVER_VERSION } from "./version.js"

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

// P1.2: toolList remains the FULL catalog (all categories) for schema
// inspection and tests. What a host actually sees over the wire is governed
// by selectEnabledTools(process.env) in createMemongoServer below.
export const toolList = toolCatalog.map(toWireTool)

/**
 * P1.4: memory-policy block shipped in the MCP `initialize` response (the
 * spec's server `instructions` field). Works on any MCP host — no prompt
 * primitive support required. Tells the agent WHEN to save, WHEN to search,
 * and which tool to reach for.
 */
export const MEMONGO_SERVER_INSTRUCTIONS = `Memongo memory policy — when to SAVE and when to SEARCH:
- SAVE durable facts, user preferences, decisions, and project context with memongo_write_event (or memongo_write_structured for typed type+key facts). Do NOT save ephemeral chatter or transient task state.
- After saving an important event, call memongo_extract with its eventId to derive structured memories.
- SEARCH before answering questions about prior work, user preferences, or earlier decisions — and at every session start.
- Tool choice: memongo_search for quick semantic lookup; memongo_search_detailed when you need scores/provenance; memongo_recall_conversation for exact past messages with citations; memongo_build_context_bundle (mode wake-up) or memongo_profile at session start.`

/**
 * P2.8: validate a raw `scope` argument against the canonical 6-value enum
 * (single contract source, @memongo/lib) BEFORE it reaches a typed position.
 * Several tools previously cast arbitrary strings to scope literals
 * (`args.scope as "user"`), letting an invalid scope flow through to the API
 * instead of failing here with a clear tool error.
 */
function readScopeArg(
	args: Record<string, unknown>,
): MemoryScopeValue | undefined {
	const scope = args.scope
	if (scope === undefined) {
		return undefined
	}
	if (typeof scope === "string" && isMemoryScopeValue(scope)) {
		return scope
	}
	throw new Error("scope must be session|user|agent|workspace|tenant|global")
}

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

export function createMemongoServer(): Server {
	// P1.2 surface diet: default = core tools only; MEMONGO_MCP_ADMIN=1 adds
	// admin/benchmark tools; MEMONGO_MCP_ALIASES=1 adds semantic aliases.
	const enabledTools = selectEnabledTools(process.env)
	const enabledNames = new Set(enabledTools.map((tool) => tool.name))

	const server = new Server(
		{
			name: "memongo",
			version: MEMONGO_SERVER_VERSION,
		},
		{
			capabilities: { tools: {} },
			instructions: MEMONGO_SERVER_INSTRUCTIONS,
		},
	)

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: enabledTools.map(toWireTool),
	}))

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (!enabledNames.has(request.params.name)) {
			return jsonResult(
				{
					error: `tool "${request.params.name}" is not enabled by this server (admin/benchmark tools require MEMONGO_MCP_ADMIN=1, semantic aliases require MEMONGO_MCP_ALIASES=1)`,
				},
				true,
			)
		}
		return handleToolCall(
			request.params.name,
			(request.params.arguments ?? {}) as Record<string, unknown>,
		)
	})

	return server
}

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
			return jsonResult(out)
		}
		if (name === "memongo_search_kb") {
			const out = await memongo.searchKB({
				query: typeof args.query === "string" ? args.query : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_read_file") {
			const out = await memongo.readFile({
				relPath: typeof args.relPath === "string" ? args.relPath : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				from: typeof args.from === "number" ? args.from : undefined,
				lines: typeof args.lines === "number" ? args.lines : undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_add") {
			const out = await memongo.add({
				content: typeof args.content === "string" ? args.content : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				sessionId:
					typeof args.sessionId === "string" ? args.sessionId : undefined,
			})
			return jsonResult(out)
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
				timestamp:
					typeof args.timestamp === "string" ? args.timestamp : undefined,
				validAt: typeof args.validAt === "string" ? args.validAt : undefined,
				invalidAt:
					typeof args.invalidAt === "string" ? args.invalidAt : undefined,
				scope: readScopeArg(args),
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_extract") {
			if (typeof args.eventId !== "string" || !args.eventId.trim()) {
				throw new Error("eventId is required")
			}
			const scope = readScopeArg(args)
			const out = await memongo.extract({
				eventId: args.eventId,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_profile") {
			const out = await memongo.profile({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_build_context_bundle") {
			const scope = readScopeArg(args)
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
				scope,
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
			return jsonResult(out)
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
			return jsonResult({ ...out, guidance })
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
				asOf: typeof args.asOf === "string" ? args.asOf : undefined,
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
			return jsonResult(out)
		}
		if (name === "memongo_novelty_scan") {
			const out = await memongo.scanNovelty({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
				scope: readScopeArg(args),
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return jsonResult(out)
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
				scope: readScopeArg(args),
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_self_edit") {
			const block = typeof args.block === "string" ? args.block : ""
			const action = typeof args.action === "string" ? args.action : "replace"
			const validBlocks = ["user", "persona", "instructions"]
			const validActions = ["append", "replace", "prepend"]
			if (!validBlocks.includes(block)) {
				return jsonResult(
					{ error: "block must be user|persona|instructions" },
					true,
				)
			}
			if (!validActions.includes(action)) {
				return jsonResult(
					{ error: "action must be append|replace|prepend" },
					true,
				)
			}
			const out = await memongo.selfEdit({
				block: block as "user" | "persona" | "instructions",
				action: action as "append" | "replace" | "prepend",
				content: typeof args.content === "string" ? args.content : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return jsonResult(out)
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
			return jsonResult(out)
		}
		if (name === "memongo_hydrate_active_slate") {
			const out = await memongo.hydrateActiveSlate({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope: readScopeArg(args),
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
				maxItems: typeof args.maxItems === "number" ? args.maxItems : undefined,
			})
			return jsonResult(out)
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
				scope: readScopeArg(args),
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
				maxItems: typeof args.maxItems === "number" ? args.maxItems : undefined,
			})
			return jsonResult(out)
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
			return jsonResult(out)
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
			return jsonResult(out)
		}
		if (name === "memongo_status_detailed") {
			const out = await memongo.getDetailedStatus(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return jsonResult(out)
		}
		if (name === "memongo_stats") {
			const out = await memongo.stats(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return jsonResult(out)
		}
		if (name === "memongo_sync") {
			const out = await memongo.sync({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				reason: typeof args.reason === "string" ? args.reason : undefined,
				force: typeof args.force === "boolean" ? args.force : undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_probe_embedding") {
			const out = await memongo.probeEmbedding(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return jsonResult(out)
		}
		if (name === "memongo_probe_vector") {
			const out = await memongo.probeVector(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return jsonResult(out)
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
			return jsonResult(out)
		}
		if (name === "memongo_relevance_benchmark") {
			type BenchmarkInput = NonNullable<
				Parameters<typeof memongo.relevanceBenchmark>[0]
			>
			const out = await memongo.relevanceBenchmark({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				datasetPath:
					typeof args.datasetPath === "string" ? args.datasetPath : undefined,
				maxResults:
					typeof args.maxResults === "number" ? args.maxResults : undefined,
				minScore: typeof args.minScore === "number" ? args.minScore : undefined,
				retrievalLane:
					args.retrievalLane === "native" ||
					args.retrievalLane === "raw-session"
						? args.retrievalLane
						: undefined,
				datasetSha256:
					typeof args.datasetSha256 === "string"
						? args.datasetSha256
						: undefined,
				embeddingConfig:
					typeof args.embeddingConfig === "object" &&
					args.embeddingConfig !== null
						? (args.embeddingConfig as BenchmarkInput["embeddingConfig"])
						: undefined,
				rerankerConfig:
					typeof args.rerankerConfig === "object" &&
					args.rerankerConfig !== null
						? (args.rerankerConfig as BenchmarkInput["rerankerConfig"])
						: undefined,
				qualityThresholds:
					typeof args.qualityThresholds === "object" &&
					args.qualityThresholds !== null
						? (args.qualityThresholds as BenchmarkInput["qualityThresholds"])
						: undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_relevance_report") {
			const out = await memongo.relevanceReport(
				typeof args.agentId === "string" ? args.agentId : undefined,
				typeof args.windowMs === "number" ? args.windowMs : undefined,
			)
			return jsonResult(out)
		}
		if (name === "memongo_relevance_sample_rate") {
			const out = await memongo.relevanceSampleRate(
				typeof args.agentId === "string" ? args.agentId : undefined,
			)
			return jsonResult(out)
		}
		if (name === "memongo_state_unified") {
			const out = await memongo.state({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				scope: readScopeArg(args),
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
			})
			return jsonResult(out)
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
			return jsonResult(out)
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
			return jsonResult(out)
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
			return jsonResult(out)
		}
		if (name === "memongo_admin_list_traces") {
			const out = await memongo.listRecallTraces({
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				limit:
					typeof args.limit === "number"
						? Math.max(1, Math.min(100, Math.floor(args.limit)))
						: undefined,
			})
			return jsonResult(out)
		}
		if (name === "memongo_admin_get_trace") {
			if (typeof args.traceId !== "string" || !args.traceId.trim()) {
				throw new Error("traceId is required")
			}
			const out = await memongo.getRecallTrace({
				traceId: args.traceId,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return jsonResult(out)
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
			return jsonResult(out)
		}
		if (name === "memongo_get_job") {
			if (typeof args.jobId !== "string" || !args.jobId.trim()) {
				throw new Error("jobId is required")
			}
			const out = await memongo.getJob({
				jobId: args.jobId,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return jsonResult(out)
		}
		throw new Error(`unknown tool: ${name}`)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return jsonResult({ error: message }, true)
	}
}

async function main(): Promise<void> {
	const transportKind = process.env.MEMONGO_MCP_TRANSPORT ?? "stdio"
	if (transportKind === "http") {
		await startHttpTransport({ createMcpServer: createMemongoServer })
		return
	}
	if (transportKind !== "stdio") {
		throw new Error(
			`unknown MEMONGO_MCP_TRANSPORT "${transportKind}" (expected "stdio" or "http")`,
		)
	}
	await createMemongoServer().connect(new StdioServerTransport())
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
