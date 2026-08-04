import { describe, expect, it, vi } from "vitest"
import type { MemongoConfig } from "@memongo/lib"
import {
	resolveMemoryBackendConfig,
	resolveDefaultScope,
	resolveSearchDefaultScope,
} from "./backend-config.js"

describe("resolveSearchDefaultScope (P1.4: MEMONGO_SEARCH_DEFAULT_SCOPE)", () => {
	it("defaults to agent when the env is unset, empty, or whitespace", () => {
		expect(resolveSearchDefaultScope(undefined)).toBe("agent")
		expect(resolveSearchDefaultScope("")).toBe("agent")
		expect(resolveSearchDefaultScope("   ")).toBe("agent")
	})

	it("honors every canonical scope", () => {
		for (const scope of [
			"session",
			"user",
			"agent",
			"workspace",
			"tenant",
			"global",
		] as const) {
			expect(resolveSearchDefaultScope(scope)).toBe(scope)
		}
		// Surrounding whitespace is tolerated.
		expect(resolveSearchDefaultScope("  global  ")).toBe("global")
	})

	it("throws on invalid values like other enum envs", () => {
		expect(() => resolveSearchDefaultScope("everything")).toThrow(
			/MEMONGO_SEARCH_DEFAULT_SCOPE "everything" is not a valid memory scope/,
		)
		expect(() => resolveSearchDefaultScope("GLOBAL")).toThrow(
			/not a valid memory scope/,
		)
	})
})

describe("resolveDefaultScope (D1/B3: MEMONGO_DEFAULT_SCOPE)", () => {
	it("defaults to agent when neither name is set", () => {
		expect(resolveDefaultScope({ applyTo: "read" })).toBe("agent")
		expect(resolveDefaultScope({ applyTo: "write" })).toBe("agent")
		expect(
			resolveDefaultScope({ value: "  ", legacyValue: "", applyTo: "read" }),
		).toBe("agent")
	})

	it("MEMONGO_DEFAULT_SCOPE applies to BOTH reads and writes", () => {
		for (const applyTo of ["read", "write"] as const) {
			expect(resolveDefaultScope({ value: "global", applyTo })).toBe("global")
			expect(resolveDefaultScope({ value: " tenant ", applyTo })).toBe("tenant")
		}
	})

	it("throws on an invalid MEMONGO_DEFAULT_SCOPE like other enum envs", () => {
		expect(() =>
			resolveDefaultScope({ value: "everything", applyTo: "read" }),
		).toThrow(/MEMONGO_DEFAULT_SCOPE "everything" is not a valid memory scope/)
	})

	it("the legacy name alone remains a read alias but does not move writes", () => {
		expect(
			resolveDefaultScope({ legacyValue: "global", applyTo: "read" }),
		).toBe("global")
		expect(
			resolveDefaultScope({ legacyValue: "global", applyTo: "write" }),
		).toBe("agent")
	})

	it("MEMONGO_DEFAULT_SCOPE wins over a conflicting legacy value and warns once", () => {
		const warn = vi.fn()
		expect(
			resolveDefaultScope({
				value: "global",
				legacyValue: "user",
				applyTo: "read",
				warn,
			}),
		).toBe("global")
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toContain("MEMONGO_DEFAULT_SCOPE")
		// Same conflict pair does not warn again (per-operation resolvers
		// would otherwise spam every search/write).
		resolveDefaultScope({
			value: "global",
			legacyValue: "user",
			applyTo: "write",
			warn,
		})
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("a matching legacy value does not warn", () => {
		const warn = vi.fn()
		expect(
			resolveDefaultScope({
				value: "global",
				legacyValue: "global",
				applyTo: "write",
				warn,
			}),
		).toBe("global")
		expect(warn).not.toHaveBeenCalled()
	})
})

describe("memory.mongodb.ttl resolution (P4.4.1)", () => {
	function resolveWithTtl(ttl: unknown) {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", ttl },
			},
		} as unknown as MemongoConfig
		return resolveMemoryBackendConfig({ cfg, agentId: "main" }).mongodb?.ttl
	}

	it("is off by default when no ttl config is present", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb?.ttl).toEqual({ enabled: false, sessionDays: 30 })
	})

	it("stays off when only sessionDays is set (enabled is the explicit opt-in)", () => {
		expect(resolveWithTtl({ sessionDays: 7 })).toEqual({
			enabled: false,
			sessionDays: 7,
		})
	})

	it("resolves enabled with the configured sessionDays", () => {
		expect(resolveWithTtl({ enabled: true, sessionDays: 14 })).toEqual({
			enabled: true,
			sessionDays: 14,
		})
	})

	it("falls back to the 30-day default when enabled without sessionDays", () => {
		expect(resolveWithTtl({ enabled: true })).toEqual({
			enabled: true,
			sessionDays: 30,
		})
	})

	it("falls back to the default on invalid sessionDays values", () => {
		for (const bad of [0, -5, Number.NaN, "abc", null]) {
			expect(resolveWithTtl({ enabled: true, sessionDays: bad })).toEqual({
				enabled: true,
				sessionDays: 30,
			})
		}
	})

	it("accepts fractional sessionDays", () => {
		expect(resolveWithTtl({ enabled: true, sessionDays: 0.5 })).toEqual({
			enabled: true,
			sessionDays: 0.5,
		})
	})
})
