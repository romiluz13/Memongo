import type { Context } from "hono"

/**
 * The canonical set of scope values. This is the SINGLE source of truth shared
 * by request resolution (pickScope) and scoped-API-key policy validation, so the
 * authorization layer and the execution layer cannot disagree about which scope
 * strings are valid (issue #57 divergence class). A policy that authorizes a
 * non-canonical scope would let execution silently drop it and a nested
 * entry.scope smuggle survive — so policies are validated against this set at
 * config load and fail closed.
 */
export const VALID_SCOPE_VALUES = [
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
] as const

export type ApiScope = (typeof VALID_SCOPE_VALUES)[number]

export function isValidScope(value: string): value is ApiScope {
	return (VALID_SCOPE_VALUES as readonly string[]).includes(value)
}

/**
 * Single source of truth for resolving tenant-scope fields (agentId, scope,
 * scopeRef) from a request. Issue #57: authorization and manager/partition
 * selection MUST resolve identity from the identical input, or a request can
 * pass auth under one identity while writing under another (e.g. a nested-only
 * agentId that auth reads but the route ignores, landing in the default
 * partition). Both the auth layer and the route layer call these helpers.
 */

/**
 * The merged request scope input: query params overlaid by JSON body (body
 * wins). Mirrors what the auth layer inspects so downstream identity resolution
 * cannot diverge. Uses `raw.clone()` so the handler can still read the body.
 */
export async function resolveScopeInput(
	c: Context,
): Promise<Record<string, unknown>> {
	const query = c.req.query() as Record<string, unknown>
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		return query
	}
	const contentType = c.req.header("Content-Type") ?? ""
	if (!contentType.toLowerCase().includes("application/json")) {
		return query
	}
	// Use Hono's cached body parse (c.req.json()) rather than cloning the raw
	// stream: this helper runs both in auth middleware AND from route handlers
	// that have already consumed the body, and re-cloning a disturbed request
	// throws. c.req.json() caches, so repeated calls across layers are safe.
	const body = (await c.req.json().catch(() => ({}))) as unknown
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return query
	}
	return { ...query, ...(body as Record<string, unknown>) }
}

/**
 * Resolve a scope field from the merged input, searching the top-level object
 * and the common nested containers the API accepts. First non-empty string
 * wins, with top-level taking precedence over nested containers.
 */
export function resolveScopeField(
	input: Record<string, unknown>,
	field: string,
): string | undefined {
	const containers = [
		input,
		input.handle,
		input.entry,
		input.memory,
		input.params,
	].filter(
		(item): item is Record<string, unknown> =>
			!!item && typeof item === "object" && !Array.isArray(item),
	)
	for (const container of containers) {
		const value = container[field]
		if (typeof value === "string" && value.trim()) {
			return value.trim()
		}
	}
	return undefined
}

/**
 * The authoritative agentId for a request — the SAME value the auth layer
 * validates. Manager/partition selection must use this, never a narrower read.
 */
export async function resolveRequestAgentId(
	c: Context,
): Promise<string | undefined> {
	return resolveScopeField(await resolveScopeInput(c), "agentId")
}
