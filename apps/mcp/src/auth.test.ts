import { describe, expect, it } from "vitest"
import {
	allowedHostNames,
	authenticateBearer,
	isMcpAuthActive,
	resolveMcpAuthConfig,
	validateHostAndOrigin,
	type McpAuthConfig,
} from "./auth.js"

function config(overrides: Partial<McpAuthConfig> = {}): McpAuthConfig {
	return {
		authToken: undefined,
		adminToken: undefined,
		allowedHosts: [],
		...overrides,
	}
}

describe("resolveMcpAuthConfig", () => {
	it("falls back to env when no option is given", () => {
		const resolved = resolveMcpAuthConfig(
			{},
			{
				MEMONGO_MCP_AUTH_TOKEN: "env-standard",
				MEMONGO_MCP_ADMIN_TOKEN: "env-admin",
				MEMONGO_MCP_ALLOWED_HOSTS: "mcp.example.com",
			},
		)
		expect(resolved.authToken).toBe("env-standard")
		expect(resolved.adminToken).toBe("env-admin")
		expect(resolved.allowedHosts).toEqual(["mcp.example.com"])
	})

	it("lets an explicit option win over env, even when empty", () => {
		const resolved = resolveMcpAuthConfig(
			{ authToken: "", adminToken: "option-admin" },
			{
				MEMONGO_MCP_AUTH_TOKEN: "env-standard",
				MEMONGO_MCP_ADMIN_TOKEN: "env-admin",
			},
		)
		expect(resolved.authToken).toBeUndefined()
		expect(resolved.adminToken).toBe("option-admin")
	})

	it("trims tokens and treats blank values as unset", () => {
		const resolved = resolveMcpAuthConfig(
			{},
			{ MEMONGO_MCP_AUTH_TOKEN: "   ", MEMONGO_MCP_ADMIN_TOKEN: "  token  " },
		)
		expect(resolved.authToken).toBeUndefined()
		expect(resolved.adminToken).toBe("token")
	})

	it("parses MEMONGO_MCP_ALLOWED_HOSTS as a normalized CSV", () => {
		const resolved = resolveMcpAuthConfig(
			{},
			{
				MEMONGO_MCP_ALLOWED_HOSTS:
					" One.example.com , [::1]:443 , ,two.example.com ",
			},
		)
		expect(resolved.allowedHosts).toEqual([
			"one.example.com",
			"::1",
			"two.example.com",
		])
	})
})

describe("isMcpAuthActive", () => {
	it("is inactive with no credentials configured", () => {
		expect(isMcpAuthActive(config())).toBe(false)
	})

	it("is active when either credential is configured", () => {
		expect(isMcpAuthActive(config({ authToken: "t" }))).toBe(true)
		expect(isMcpAuthActive(config({ adminToken: "t" }))).toBe(true)
	})
})

describe("authenticateBearer", () => {
	it("rejects a missing Authorization header as not presented", () => {
		const result = authenticateBearer(undefined, config({ authToken: "t" }))
		expect(result).toEqual({ ok: false, presented: false })
	})

	it("rejects non-bearer schemes as not presented", () => {
		const result = authenticateBearer(
			"Basic dXNlcjpwYXNz",
			config({ authToken: "t" }),
		)
		expect(result).toEqual({ ok: false, presented: false })
	})

	it("rejects an empty bearer as presented but invalid", () => {
		const result = authenticateBearer("Bearer   ", config({ authToken: "t" }))
		expect(result).toEqual({ ok: false, presented: true })
	})

	it("matches the standard token with standard scope", () => {
		const result = authenticateBearer(
			"Bearer standard-token",
			config({ authToken: "standard-token" }),
		)
		expect(result).toEqual({ ok: true, scope: "standard" })
	})

	it("matches the admin token with admin scope", () => {
		const result = authenticateBearer(
			"Bearer admin-token",
			config({ authToken: "standard-token", adminToken: "admin-token" }),
		)
		expect(result).toEqual({ ok: true, scope: "admin" })
	})

	it("prefers admin scope when one secret serves both tokens", () => {
		const result = authenticateBearer(
			"Bearer shared",
			config({ authToken: "shared", adminToken: "shared" }),
		)
		expect(result).toEqual({ ok: true, scope: "admin" })
	})

	it("rejects a wrong token as presented but invalid", () => {
		const result = authenticateBearer(
			"Bearer wrong-token",
			config({ authToken: "standard-token", adminToken: "admin-token" }),
		)
		expect(result).toEqual({ ok: false, presented: true })
	})

	it("rejects every bearer when no token is configured", () => {
		const result = authenticateBearer("Bearer anything", config())
		expect(result).toEqual({ ok: false, presented: true })
	})
})

describe("allowedHostNames", () => {
	it("derives the loopback family for a loopback bind", () => {
		expect(allowedHostNames("127.0.0.1", [])).toEqual(
			new Set(["localhost", "127.0.0.1", "::1"]),
		)
	})

	it("allows the bind host itself for a specific non-loopback bind", () => {
		expect(allowedHostNames("10.0.0.5", [])).toEqual(new Set(["10.0.0.5"]))
		expect(allowedHostNames("mcp.internal", [])).toEqual(
			new Set(["mcp.internal"]),
		)
	})

	it("allows nothing implicitly for wildcard binds", () => {
		expect(allowedHostNames("0.0.0.0", [])).toEqual(new Set())
		expect(allowedHostNames("::", [])).toEqual(new Set())
	})

	it("normalizes extra hosts (case, port, brackets)", () => {
		expect(
			allowedHostNames("0.0.0.0", ["Proxy.Example.COM:443", "[::1]:8443", ""]),
		).toEqual(new Set(["proxy.example.com", "::1"]))
	})
})

describe("validateHostAndOrigin", () => {
	const allowed = new Set(["localhost", "127.0.0.1", "::1", "mcp.example.com"])

	it("accepts an allowed host with no Origin header", () => {
		expect(validateHostAndOrigin("127.0.0.1", undefined, allowed)).toEqual({
			ok: true,
		})
	})

	it("strips ports from the Host header before comparing", () => {
		expect(validateHostAndOrigin("localhost:3110", undefined, allowed)).toEqual(
			{
				ok: true,
			},
		)
		expect(validateHostAndOrigin("[::1]:3110", undefined, allowed)).toEqual({
			ok: true,
		})
	})

	it("keeps bare IPv6 hosts intact", () => {
		expect(validateHostAndOrigin("::1", undefined, allowed)).toEqual({
			ok: true,
		})
	})

	it("rejects a missing Host header", () => {
		expect(validateHostAndOrigin(undefined, undefined, allowed)).toEqual({
			ok: false,
			reason: "missing host",
		})
	})

	it("rejects a disallowed host", () => {
		expect(validateHostAndOrigin("evil.example", undefined, allowed)).toEqual({
			ok: false,
			reason: "host not allowed",
		})
	})

	it("accepts an Origin that names an allowed host", () => {
		expect(
			validateHostAndOrigin("127.0.0.1", "http://localhost:3000", allowed),
		).toEqual({ ok: true })
	})

	it("rejects a foreign Origin even when the Host is allowed", () => {
		expect(
			validateHostAndOrigin("127.0.0.1", "http://evil.example", allowed),
		).toEqual({ ok: false, reason: "origin not allowed" })
	})

	it("rejects a malformed Origin", () => {
		expect(validateHostAndOrigin("127.0.0.1", "not a url", allowed)).toEqual({
			ok: false,
			reason: "invalid origin",
		})
	})
})
