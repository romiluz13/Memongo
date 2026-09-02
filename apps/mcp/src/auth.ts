import { isLoopbackBindHost, timingSafeBearerEquals } from "@memongo/lib"

/**
 * WS-01 (C-001): per-request credential model for the MCP HTTP transport.
 *
 * The transport used to treat upstream `MEMONGO_API_KEY` *presence* as its
 * auth signal — but that key authenticates the MCP server to the API, not
 * callers to the MCP server. The remediated model:
 *
 * - `MEMONGO_MCP_AUTH_TOKEN`: dedicated client credential. When set, every
 *   request must present it as `Authorization: Bearer <token>` (401 +
 *   `WWW-Authenticate: Bearer` otherwise, the MCP authorization spec's
 *   minimum). A non-loopback bind refuses to start without it.
 * - `MEMONGO_MCP_ADMIN_TOKEN`: optional admin credential. Requests bearing
 *   it get the admin tool scope; the standard token never does.
 * - No token + loopback bind: local-trust mode (the bind-guard loopback
 *   allowance and the stdio transport's local trust, unchanged dev posture).
 *
 * Scope semantics for tool selection (see createMemongoServer in server.ts):
 * - "local": env flags decide (stdio, or loopback HTTP without a token).
 * - "standard": env flags minus admin tools, always.
 * - "admin": env flags decide (admin tools still require MEMONGO_MCP_ADMIN=1).
 */
export type McpAuthScope = "local" | "standard" | "admin"

export type McpAuthConfig = {
	authToken: string | undefined
	adminToken: string | undefined
	allowedHosts: string[]
}

export type McpAuthOptions = {
	authToken?: string | undefined
	adminToken?: string | undefined
	allowedHosts?: string[] | undefined
}

type McpAuthEnv = {
	MEMONGO_MCP_AUTH_TOKEN?: string | undefined
	MEMONGO_MCP_ADMIN_TOKEN?: string | undefined
	MEMONGO_MCP_ALLOWED_HOSTS?: string | undefined
}

function nonEmpty(raw: string | undefined): string | undefined {
	const value = raw?.trim()
	return value ? value : undefined
}

function normalizeHostList(entries: readonly string[]): string[] {
	return entries
		.map((entry) => normalizeHostName(entry))
		.filter((entry) => entry !== "")
}

function parseHostListEnv(raw: string | undefined): string[] {
	if (!raw) {
		return []
	}
	return normalizeHostList(raw.split(","))
}

/**
 * Resolve the transport auth config: an explicitly-passed option always
 * wins (even when empty), then the environment. Explicit-override-first
 * keeps tests deterministic when the surrounding env carries real values.
 */
export function resolveMcpAuthConfig(
	options: McpAuthOptions = {},
	env: McpAuthEnv = process.env,
): McpAuthConfig {
	return {
		authToken:
			options.authToken !== undefined
				? nonEmpty(options.authToken)
				: nonEmpty(env.MEMONGO_MCP_AUTH_TOKEN),
		adminToken:
			options.adminToken !== undefined
				? nonEmpty(options.adminToken)
				: nonEmpty(env.MEMONGO_MCP_ADMIN_TOKEN),
		allowedHosts:
			options.allowedHosts !== undefined
				? normalizeHostList(options.allowedHosts)
				: parseHostListEnv(env.MEMONGO_MCP_ALLOWED_HOSTS),
	}
}

/** Whether any client credential is configured (auth is enforced per request). */
export function isMcpAuthActive(config: McpAuthConfig): boolean {
	return Boolean(config.authToken || config.adminToken)
}

export type BearerAuthResult =
	| { ok: true; scope: "standard" | "admin" }
	| { ok: false; presented: boolean }

/**
 * Authenticate one request's Authorization header against the configured
 * tokens. The admin token wins when both match (an operator may reuse one
 * secret for both scopes). Comparison is constant-time so a mismatched
 * bearer cannot leak the token prefix via response timing.
 */
export function authenticateBearer(
	authorization: string | undefined,
	config: McpAuthConfig,
): BearerAuthResult {
	const raw = authorization?.trim() ?? ""
	// "Bearer <token>" (case-insensitive); a bare "Bearer" with no token
	// still counts as presented credentials, just unusable ones.
	const scheme = /^bearer(?:\s+|$)/i.exec(raw)
	if (!scheme) {
		return { ok: false, presented: false }
	}
	const bearer = raw.slice(scheme[0].length).trim()
	if (!bearer) {
		return { ok: false, presented: true }
	}
	if (config.adminToken && timingSafeBearerEquals(bearer, config.adminToken)) {
		return { ok: true, scope: "admin" }
	}
	if (config.authToken && timingSafeBearerEquals(bearer, config.authToken)) {
		return { ok: true, scope: "standard" }
	}
	return { ok: false, presented: true }
}

/**
 * Strip an optional `:port` suffix from a Host-style value.
 *
 * A hostname:port pair has exactly one colon; anything with more colons is a
 * bare IPv6 literal (which has no port to strip), and bracketed IPv6 keeps
 * its brackets so callers can normalize them off uniformly.
 */
function stripPort(raw: string): string {
	const value = raw.trim()
	if (value.startsWith("[")) {
		const close = value.indexOf("]")
		return close === -1 ? value : value.slice(0, close + 1)
	}
	const colon = value.indexOf(":")
	if (colon === -1 || value.indexOf(":", colon + 1) !== -1) {
		return value
	}
	return value.slice(0, colon)
}

/** Comparable hostname: lowercase, port-stripped, bracket-stripped. */
function normalizeHostName(raw: string): string {
	return stripPort(raw)
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
}

/**
 * Hostnames a request's Host header (and browser Origin, when present) may
 * carry. Loopback binds accept the loopback family; a specific non-loopback
 * bind accepts its own literal; wildcard binds (`0.0.0.0`, `::`) accept
 * nothing implicitly — a public bind must declare its names. Operators
 * extend the set with `MEMONGO_MCP_ALLOWED_HOSTS` (reverse proxies rewrite
 * Host to the public name).
 */
export function allowedHostNames(
	bindHost: string,
	extraHosts: readonly string[],
): Set<string> {
	const names = new Set<string>()
	if (isLoopbackBindHost(bindHost)) {
		names.add("localhost")
		names.add("127.0.0.1")
		names.add("::1")
	} else {
		const bindName = normalizeHostName(bindHost)
		if (bindName !== "" && bindName !== "0.0.0.0" && bindName !== "::") {
			names.add(bindName)
		}
	}
	for (const extra of extraHosts) {
		const name = normalizeHostName(extra)
		if (name !== "") {
			names.add(name)
		}
	}
	return names
}

export type HostOriginCheck =
	| { ok: true }
	| {
			ok: false
			reason:
				| "missing host"
				| "host not allowed"
				| "invalid origin"
				| "origin not allowed"
	  }

/**
 * DNS-rebinding and cross-origin defense (MCP transport security guidance):
 * the Host header must name this transport (or an operator-declared name),
 * and any browser Origin must resolve to an allowed name as well.
 * Non-browser MCP clients send no Origin and skip that half of the check.
 */
export function validateHostAndOrigin(
	hostHeader: string | undefined,
	originHeader: string | undefined,
	allowed: Set<string>,
): HostOriginCheck {
	const host = hostHeader ? normalizeHostName(hostHeader) : ""
	if (!host) {
		return { ok: false, reason: "missing host" }
	}
	if (!allowed.has(host)) {
		return { ok: false, reason: "host not allowed" }
	}
	const origin = originHeader?.trim()
	if (origin) {
		let originHost: string
		try {
			originHost = new URL(origin).hostname
		} catch {
			return { ok: false, reason: "invalid origin" }
		}
		const normalized = originHost.toLowerCase().replace(/^\[|\]$/g, "")
		if (!allowed.has(normalized)) {
			return { ok: false, reason: "origin not allowed" }
		}
	}
	return { ok: true }
}
