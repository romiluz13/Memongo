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
 *
 * The data tables live in sibling modules (B2a kept this file under the
 * size guideline): the /v1 route table in ./contract-routes.ts (full
 * request field sets) and the MCP tool field sets in ./contract-mcp.ts.
 * Both are re-exported here so the import surface is unchanged.
 */

export {
	type ApiRouteContract,
	type ApiRouteMethod,
	MEMONGO_API_ROUTES,
} from "./contract-routes.js"
export { MEMONGO_MCP_TOOL_FIELDS } from "./contract-mcp.js"

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
