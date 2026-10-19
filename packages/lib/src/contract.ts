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
/*  Context-bundle mode enum — THE canonical mode set (C-013)               */
/* ------------------------------------------------------------------------ */

/**
 * Canonical context-bundle mode values (WS-08 / C-013). Before this constant
 * the set was re-declared at four surfaces (API ternary, client types, MCP
 * JSON schema, tools zod schema) and the API silently swallowed every value
 * outside "wake-up" — callers could request a mode and receive the default
 * with a 200. The API now validates against this set and returns 400 on
 * invalid values; client/MCP/tools schemas derive from it (the zero-dep
 * client mirrors it locally, pinned by a cross-package type test in
 * packages/tools).
 */
export const CONTEXT_BUNDLE_MODE_VALUES = ["full", "wake-up"] as const

export type ContextBundleModeValue = (typeof CONTEXT_BUNDLE_MODE_VALUES)[number]

export function isContextBundleModeValue(
	value: string,
): value is ContextBundleModeValue {
	return (CONTEXT_BUNDLE_MODE_VALUES as readonly string[]).includes(value)
}

/**
 * Mutable tuple copy of CONTEXT_BUNDLE_MODE_VALUES for `z.enum` consumers.
 * Derived by spread so it can never drift from the canonical array.
 */
export const CONTEXT_BUNDLE_MODE_VALUES_TUPLE: [
	ContextBundleModeValue,
	...ContextBundleModeValue[],
] = [...CONTEXT_BUNDLE_MODE_VALUES]

/* ------------------------------------------------------------------------ */
/*  Chain-trace collection enum — the engine traversal allowlist (C-015)    */
/* ------------------------------------------------------------------------ */

/**
 * Collections the reasoning-chain tracer can traverse (those carrying
 * `sourceEventIds` with a known primary id field — see
 * COLLECTION_ID_FIELDS in
 * packages/memory-engine/src/mongodb-reasoning-chain.ts, which is keyed by
 * this type so the two can never drift). WS-08 / C-015: the chain-trace
 * route validates `collection` against this set and returns 400 for
 * anything else — the engine's previous fallback fabricated an empty
 * `chainComplete: true` response for unknown collection names, hiding
 * caller mistakes (a plausible-but-wrong name was indistinguishable from
 * "no premises exist").
 */
export const CHAIN_TRACE_COLLECTION_VALUES = [
	"structured_mem",
	"entities",
	"relations",
	"procedures",
	"entity_links",
] as const

export type ChainTraceCollectionValue =
	(typeof CHAIN_TRACE_COLLECTION_VALUES)[number]

export function isChainTraceCollectionValue(
	value: string,
): value is ChainTraceCollectionValue {
	return (CHAIN_TRACE_COLLECTION_VALUES as readonly string[]).includes(value)
}

/**
 * Mutable tuple copy of CHAIN_TRACE_COLLECTION_VALUES for `z.enum`
 * consumers. Derived by spread so it can never drift from the canonical
 * array.
 */
export const CHAIN_TRACE_COLLECTION_VALUES_TUPLE: [
	ChainTraceCollectionValue,
	...ChainTraceCollectionValue[],
] = [...CHAIN_TRACE_COLLECTION_VALUES]

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

/**
 * M2 review D3: what a failed operation had already committed, on the error
 * body. `commitState` is `none` (the operation knows none of its writes
 * committed), `committed` (known committed effects, listed in `commit`) or
 * `unknown` (an uncertain commit outcome: `commit` lists only what is known to
 * be committed and the truth may be more). A body without `commitState` makes
 * no claim, and is not a statement that nothing committed.
 */
const COMMIT_STATE_VALUES = ["none", "committed", "unknown"] as const

const COMMIT_COUNT_SCHEMA = { type: "integer", minimum: 0 } as const

const COMMIT_DETAIL_OPENAPI_SCHEMA = {
	description:
		"Bounded, value-free detail of the work the failed operation is known to have committed. `sync`: the file-sync phase ran to the end (`fileSync.filesFailed` and `enumerationComplete` say what it left undone) and `kbImport` holds the KB import's acknowledged counts, present only when the import produced them (absent means not known, never zero; a document that failed may have written part of itself). `consolidate`: the run's identity and the work the run acknowledged before it failed; `committed` can hold with every count zero when only other rows (quarantine entries, graph projection, spend records) committed.",
	oneOf: [
		{
			type: "object",
			required: ["operation", "fileSync"],
			properties: {
				operation: { type: "string", enum: ["sync"] },
				fileSync: {
					type: "object",
					required: ["filesFailed", "enumerationComplete"],
					properties: {
						filesFailed: COMMIT_COUNT_SCHEMA,
						enumerationComplete: { type: "boolean" },
					},
				},
				kbImport: {
					type: "object",
					required: ["documentsProcessed", "chunksCreated", "skipped"],
					properties: {
						documentsProcessed: COMMIT_COUNT_SCHEMA,
						chunksCreated: COMMIT_COUNT_SCHEMA,
						skipped: COMMIT_COUNT_SCHEMA,
					},
				},
			},
		},
		{
			type: "object",
			required: [
				"operation",
				"runId",
				"eventsProcessed",
				"factsPromoted",
				"factsInferred",
				"factsMerged",
				"factsPruned",
			],
			properties: {
				operation: { type: "string", enum: ["consolidate"] },
				runId: { type: "string", format: "uuid" },
				eventsProcessed: COMMIT_COUNT_SCHEMA,
				factsPromoted: COMMIT_COUNT_SCHEMA,
				factsInferred: COMMIT_COUNT_SCHEMA,
				factsMerged: COMMIT_COUNT_SCHEMA,
				factsPruned: COMMIT_COUNT_SCHEMA,
			},
		},
	],
} as const

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
				commitState: {
					type: "string",
					enum: COMMIT_STATE_VALUES,
					description:
						"What the failed operation had already committed: none (known, nothing), committed (known effects, see commit) or unknown (an uncertain commit outcome, neither committed nor rolled back). Absent when the operation makes no claim.",
				},
				commit: COMMIT_DETAIL_OPENAPI_SCHEMA,
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
