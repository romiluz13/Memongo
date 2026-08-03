/**
 * Memongo wire contract — the single source the HTTP API, OpenAPI document,
 * MCP tools, and zod tool schemas all derive from (P2.2).
 *
 * Before this module the contract was hand-maintained in four places
 * (routes, openapi-spec, MCP tool schemas, zod tools) and had already
 * diverged: `/v1/self-edit` was missing from the spec, scope enums were
 * re-typed at nine sites, `ApiError` was never `$ref`'d, and no bearer
 * security scheme existed. This module is DATA, not code-gen machinery:
 * consumers import the canonical values and a conformance test
 * (apps/api/src/contract-conformance.test.ts) fails on any drift.
 */

/* ------------------------------------------------------------------------ */
/*  Scope enum — THE canonical set of scope values                          */
/* ------------------------------------------------------------------------ */

/**
 * Canonical scope values. The ONLY definition; every other scope enum
 * (OpenAPI, MCP tool schemas, zod schemas, scoped-API-key policy validation)
 * derives from this array (issue #57 divergence class).
 */
export const MEMORY_SCOPE_VALUES = [
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
] as const

export type MemoryScopeValue = (typeof MEMORY_SCOPE_VALUES)[number]

export function isMemoryScopeValue(value: string): value is MemoryScopeValue {
	return (MEMORY_SCOPE_VALUES as readonly string[]).includes(value)
}

/**
 * Mutable tuple copy of MEMORY_SCOPE_VALUES for APIs that require a mutable
 * `[string, ...string[]]` (e.g. `z.enum`). Derived by spread so it can never
 * drift from the canonical readonly array.
 */
export const MEMORY_SCOPE_VALUES_TUPLE: [
	MemoryScopeValue,
	...MemoryScopeValue[],
] = [...MEMORY_SCOPE_VALUES]

/* ------------------------------------------------------------------------ */
/*  Shared field descriptions                                               */
/* ------------------------------------------------------------------------ */

export const SCOPE_FIELD_DESCRIPTION =
	"Optional memory isolation scope for retrieval."
export const SCOPE_REF_FIELD_DESCRIPTION =
	"Optional scope reference, for example a workspace path."
export const AGENT_ID_FIELD_DESCRIPTION =
	"Target agent id; defaults to the server-configured agent."

/* ------------------------------------------------------------------------ */
/*  ApiError envelope — the one error body shape every route returns        */
/* ------------------------------------------------------------------------ */

export type ApiErrorBody = {
	error: {
		code: string
		message: string
	}
}

/** OpenAPI schema for the ApiError envelope (components.schemas.ApiError). */
export const API_ERROR_OPENAPI_SCHEMA = {
	type: "object",
	required: ["error"],
	properties: {
		error: {
			type: "object",
			required: ["code", "message"],
			properties: {
				code: { type: "string" },
				message: { type: "string" },
			},
		},
	},
} as const

export const API_ERROR_OPENAPI_REF = "#/components/schemas/ApiError"

/**
 * OpenAPI response fragment for an error status, referencing the shared
 * ApiError schema. Used by the OpenAPI document builder so no route can
 * invent its own error body shape.
 */
export function apiErrorOpenApiResponse(description: string) {
	return {
		description,
		content: {
			"application/json": {
				schema: { $ref: API_ERROR_OPENAPI_REF },
			},
		},
	}
}

/** Bearer security scheme declared once for the whole API. */
export const BEARER_SECURITY_SCHEME_NAME = "bearerAuth"
export const BEARER_SECURITY_SCHEME = {
	type: "http",
	scheme: "bearer",
} as const

/* ------------------------------------------------------------------------ */
/*  Route table — every /v1 operation as data                               */
/* ------------------------------------------------------------------------ */

export type ApiRouteMethod = "get" | "post"

export type ApiRouteContract = {
	/** OpenAPI-style path, e.g. "/v1/admin/traces/{traceId}". */
	path: string
	method: ApiRouteMethod
	operationId: string
	summary: string
	/**
	 * Request fields the route REQUIRES (spot-shape level): body fields for
	 * POST routes, query fields for GET routes. The conformance test asserts
	 * the OpenAPI document marks each of these as required.
	 */
	requiredFields: readonly string[]
	/**
	 * HTTP error statuses the route can deliberately return (excluding the
	 * middleware-level 401/403/413/429 shared by every route). The OpenAPI
	 * document must document each with the ApiError envelope.
	 */
	errorStatuses: readonly number[]
	/** MCP tool names that serve this route (canonical + aliases). */
	tools: readonly string[]
}

/**
 * The /v1 route table. Keep aligned with apps/api/src/routes/v1.ts — the
 * conformance test walks the live router and fails when this table and the
 * registered routes disagree in either direction.
 */
export const MEMONGO_API_ROUTES: readonly ApiRouteContract[] = [
	{
		path: "/v1/search",
		method: "post",
		operationId: "searchMemory",
		summary: "Search memory",
		requiredFields: ["query"],
		errorStatuses: [400, 500],
		tools: ["memongo_search"],
	},
	{
		path: "/v1/search-kb",
		method: "post",
		operationId: "searchKnowledgeBase",
		summary: "Search the knowledge base",
		requiredFields: ["query"],
		errorStatuses: [400, 500],
		tools: ["memongo_search_kb"],
	},
	{
		path: "/v1/search-detailed",
		method: "post",
		operationId: "searchMemoryDetailed",
		summary:
			"Advanced search with CRAG corrective retrieval, MMR diversity, constraint relaxation, and multi-source fusion",
		requiredFields: ["query"],
		errorStatuses: [400, 500],
		tools: ["memongo_search_detailed"],
	},
	{
		path: "/v1/recall-conversation",
		method: "post",
		operationId: "recallConversation",
		summary:
			"Recall prior conversation events by content, session, role, and exact time range",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_recall_conversation", "memongo_recall_messages"],
	},
	{
		path: "/v1/import/conversations",
		method: "post",
		operationId: "importConversations",
		summary: "Import conversation history from a dataset file",
		requiredFields: ["datasetPath"],
		errorStatuses: [400, 500],
		tools: [
			"memongo_import_conversations",
			"memongo_import_conversation_history",
		],
	},
	{
		path: "/v1/lifecycle/get",
		method: "post",
		operationId: "getLifecycleItem",
		summary: "Get a structured/procedure memory by stable handle",
		requiredFields: ["handle"],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_lifecycle_get", "memongo_memory_get"],
	},
	{
		path: "/v1/lifecycle/update",
		method: "post",
		operationId: "updateLifecycleItem",
		summary: "Update a structured/procedure memory by stable handle",
		requiredFields: ["handle", "patch"],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_lifecycle_update", "memongo_memory_update"],
	},
	{
		path: "/v1/lifecycle/delete",
		method: "post",
		operationId: "deleteLifecycleItem",
		summary: "Invalidate a structured/procedure memory by stable handle",
		requiredFields: ["handle"],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_lifecycle_delete", "memongo_memory_delete"],
	},
	{
		path: "/v1/lifecycle/history",
		method: "post",
		operationId: "getLifecycleHistory",
		summary: "Get lifecycle history for a stable handle",
		requiredFields: ["handle"],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_lifecycle_history", "memongo_memory_history"],
	},
	{
		path: "/v1/procedures/outcome",
		method: "post",
		operationId: "reportProcedureOutcome",
		summary: "Report a procedure execution outcome",
		requiredFields: ["handle", "success"],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_procedure_outcome"],
	},
	{
		path: "/v1/memory/feedback",
		method: "post",
		operationId: "applyMemoryFeedback",
		summary: "Apply confirm/correct/irrelevant feedback to a memory",
		requiredFields: ["handle", "signal"],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_memory_feedback"],
	},
	{
		path: "/v1/hydrate-active-slate",
		method: "post",
		operationId: "hydrateActiveSlate",
		summary: "Hydrate the active slate for a scope",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_hydrate_active_slate"],
	},
	{
		path: "/v1/discovery-projection",
		method: "post",
		operationId: "buildDiscoveryProjection",
		summary:
			"Build a discovery projection (entity/topic brief, changes, contradictions)",
		requiredFields: ["kind"],
		errorStatuses: [400, 500],
		tools: ["memongo_discovery_projection"],
	},
	{
		path: "/v1/context-bundle",
		method: "post",
		operationId: "buildContextBundle",
		summary: "Build a token-budgeted context bundle",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_build_context_bundle"],
	},
	{
		path: "/v1/state",
		method: "get",
		operationId: "getUnifiedState",
		summary: "Get the unified state family (profile, blocks, bundle)",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_state_unified"],
	},
	{
		path: "/v1/read-file",
		method: "post",
		operationId: "readMemoryFile",
		summary: "Read a memory file by relative path",
		requiredFields: ["relPath"],
		errorStatuses: [400, 500],
		tools: ["memongo_read_file"],
	},
	{
		path: "/v1/add",
		method: "post",
		operationId: "addMemory",
		summary: "Append a user message (legacy alias of /v1/write-event)",
		requiredFields: ["content"],
		errorStatuses: [400, 500],
		tools: ["memongo_add"],
	},
	{
		path: "/v1/write-event",
		method: "post",
		operationId: "writeConversationEvent",
		summary: "Write a conversation event",
		requiredFields: ["role", "body"],
		errorStatuses: [400, 500],
		tools: ["memongo_write_event"],
	},
	{
		path: "/v1/extract",
		method: "post",
		operationId: "extractEvent",
		summary: "Schedule extraction for a conversation event",
		requiredFields: ["eventId"],
		errorStatuses: [400, 500],
		tools: ["memongo_extract"],
	},
	{
		path: "/v1/write-structured",
		method: "post",
		operationId: "writeStructuredMemory",
		summary: "Write a structured memory entry",
		requiredFields: ["entry"],
		errorStatuses: [400, 500],
		tools: ["memongo_write_structured"],
	},
	{
		path: "/v1/write-procedure",
		method: "post",
		operationId: "writeProcedure",
		summary: "Write a procedure memory entry",
		requiredFields: ["entry"],
		errorStatuses: [400, 500],
		tools: ["memongo_write_procedure"],
	},
	{
		path: "/v1/profile",
		method: "post",
		operationId: "getProfile",
		summary: "Synthesize the agent profile",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_profile"],
	},
	{
		path: "/v1/status",
		method: "get",
		operationId: "getStatus",
		summary: "Get memory provider status",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_status"],
	},
	{
		path: "/v1/status/detailed",
		method: "get",
		operationId: "getDetailedStatus",
		summary: "Get detailed v2 status",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_status_detailed"],
	},
	{
		path: "/v1/stats",
		method: "get",
		operationId: "getStats",
		summary: "Get memory statistics",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_stats"],
	},
	{
		path: "/v1/sync",
		method: "post",
		operationId: "syncMemory",
		summary: "Sync memory sources",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_sync"],
	},
	{
		path: "/v1/probes/embedding",
		method: "get",
		operationId: "probeEmbedding",
		summary: "Probe embedding availability",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_probe_embedding"],
	},
	{
		path: "/v1/probes/vector",
		method: "get",
		operationId: "probeVector",
		summary: "Probe vector search availability",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_probe_vector"],
	},
	{
		path: "/v1/admin/relevance/explain",
		method: "post",
		operationId: "relevanceExplain",
		summary: "Explain relevance scoring for a query",
		requiredFields: ["query"],
		errorStatuses: [400, 500],
		tools: ["memongo_relevance_explain"],
	},
	{
		path: "/v1/admin/relevance/benchmark",
		method: "post",
		operationId: "relevanceBenchmark",
		summary: "Run the relevance benchmark harness",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_relevance_benchmark"],
	},
	{
		path: "/v1/admin/benchmarks/ingest",
		method: "post",
		operationId: "ingestBenchmark",
		summary: "Ingest a benchmark dataset",
		requiredFields: ["datasetPath"],
		errorStatuses: [400, 500],
		tools: ["memongo_benchmark_ingest"],
	},
	{
		path: "/v1/admin/relevance/report",
		method: "get",
		operationId: "relevanceReport",
		summary: "Get the relevance telemetry report",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_relevance_report"],
	},
	{
		path: "/v1/admin/relevance/sample-rate",
		method: "get",
		operationId: "relevanceSampleRate",
		summary: "Get the current relevance sample rate state",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_relevance_sample_rate"],
	},
	{
		path: "/v1/admin/access-trends",
		method: "get",
		operationId: "getAccessTrends",
		summary: "Get memory access trends",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_admin_access_trends"],
	},
	{
		path: "/v1/admin/access-summaries",
		method: "get",
		operationId: "getAccessSummaries",
		summary: "Get memory access summaries",
		requiredFields: ["collection", "memoryIds"],
		errorStatuses: [400, 500],
		tools: ["memongo_admin_access_summaries"],
	},
	{
		path: "/v1/admin/traces",
		method: "get",
		operationId: "listRecallTraces",
		summary: "List recall traces",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_admin_list_traces"],
	},
	{
		path: "/v1/admin/traces/{traceId}",
		method: "get",
		operationId: "getRecallTrace",
		summary: "Get a recall trace by id",
		requiredFields: [],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_admin_get_trace"],
	},
	{
		path: "/v1/jobs",
		method: "get",
		operationId: "listMemoryJobs",
		summary: "List memory jobs",
		requiredFields: [],
		errorStatuses: [500],
		tools: ["memongo_list_jobs"],
	},
	{
		path: "/v1/jobs/{jobId}",
		method: "get",
		operationId: "getMemoryJob",
		summary: "Get a memory job by id",
		requiredFields: [],
		errorStatuses: [400, 404, 500],
		tools: ["memongo_get_job"],
	},
	{
		path: "/v1/chain-trace",
		method: "post",
		operationId: "traceReasoningChain",
		summary: "Trace a reasoning chain from a fact",
		requiredFields: ["factId", "collection"],
		errorStatuses: [400, 500],
		tools: ["memongo_chain_trace"],
	},
	{
		path: "/v1/novelty-scan",
		method: "post",
		operationId: "scanNovelty",
		summary: "Scan for novel memories",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_novelty_scan"],
	},
	{
		path: "/v1/consolidate",
		method: "post",
		operationId: "consolidateMemory",
		summary: "Run Dreamer consolidation — extract facts from events",
		requiredFields: [],
		errorStatuses: [400, 500],
		tools: ["memongo_consolidate"],
	},
	{
		path: "/v1/self-edit",
		method: "post",
		operationId: "selfEditMemory",
		summary: "Directly edit a core memory block (user/persona/instructions)",
		requiredFields: ["block", "content"],
		errorStatuses: [400, 422, 500],
		tools: ["memongo_self_edit"],
	},
]
