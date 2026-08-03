import { describe, expect, it } from "vitest"
import { resolveScopeIdentity, resolveScopeRef } from "./mongodb-scope.js"

describe("resolveScopeRef", () => {
	it("prefers an explicit scopeRef over every other input", () => {
		expect(
			resolveScopeRef({ scopeRef: " custom ", scope: "agent", agentId: "a" }),
		).toBe("custom")
	})

	it("resolves each scope to its canonical ref", () => {
		expect(resolveScopeRef({ scope: "agent", agentId: "a" })).toBe("agent:a")
		expect(resolveScopeRef({ scope: "global", agentId: "a" })).toBe("global")
		expect(
			resolveScopeRef({ scope: "session", agentId: "a", sessionId: "s1" }),
		).toBe("session:s1")
	})
})

// P2.3: one canonical identity rule applied identically on write and read:
// explicit scope wins; a session id implies "session"; otherwise the
// caller-provided default ("agent" for writes, env-resolved for reads).
describe("resolveScopeIdentity (P2.3 scope identity unification)", () => {
	it("explicit scope wins over a session id", () => {
		const identity = resolveScopeIdentity({
			scope: "agent",
			agentId: "agent-1",
			sessionId: "s1",
		})
		expect(identity).toEqual({ scope: "agent", scopeRef: "agent:agent-1" })
	})

	it("explicit scope wins over the caller default", () => {
		const identity = resolveScopeIdentity({
			scope: "global",
			agentId: "agent-1",
			defaultScope: "workspace",
		})
		expect(identity).toEqual({ scope: "global", scopeRef: "global" })
	})

	it("a session id with no explicit scope implies the session scope", () => {
		const identity = resolveScopeIdentity({
			agentId: "agent-1",
			sessionId: "s1",
		})
		expect(identity).toEqual({ scope: "session", scopeRef: "session:s1" })
	})

	it("session implication beats the caller default (read parity with writes)", () => {
		const identity = resolveScopeIdentity({
			agentId: "agent-1",
			sessionId: "s1",
			defaultScope: "global",
		})
		expect(identity).toEqual({ scope: "session", scopeRef: "session:s1" })
	})

	it("bare input falls back to the caller-provided default", () => {
		expect(
			resolveScopeIdentity({ agentId: "agent-1", defaultScope: "global" }),
		).toEqual({ scope: "global", scopeRef: "global" })
	})

	it("bare input with no caller default falls back to agent (write rule)", () => {
		expect(resolveScopeIdentity({ agentId: "agent-1" })).toEqual({
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
	})

	it("an explicit scopeRef passes through untouched", () => {
		const identity = resolveScopeIdentity({
			agentId: "agent-1",
			scopeRef: "tenant:acme",
		})
		expect(identity.scopeRef).toBe("tenant:acme")
	})

	it("write and read resolve the SAME identity for the same session", () => {
		// Write side: no defaultScope (writes default to "agent").
		const write = resolveScopeIdentity({ agentId: "agent-1", sessionId: "s1" })
		// Read side: env-resolved defaultScope (P1.4), sessionKey -> sessionId.
		const read = resolveScopeIdentity({
			agentId: "agent-1",
			sessionId: "s1",
			defaultScope: "global",
		})
		expect(read).toEqual(write)
	})
})
