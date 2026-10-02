import { describe, expect, it } from "vitest"
import {
	derivationFromRole,
	isExactCapableDerivation,
	isUserDerivation,
	parseResultRole,
	recoverRoleFromTextPrefix,
	resolveChunkProvenance,
} from "./memory-derivation.js"

describe("parseResultRole", () => {
	it("accepts the four canonical roles", () => {
		expect(parseResultRole("user")).toBe("user")
		expect(parseResultRole("assistant")).toBe("assistant")
		expect(parseResultRole("system")).toBe("system")
		expect(parseResultRole("tool")).toBe("tool")
	})

	it("rejects non-roles and non-strings", () => {
		expect(parseResultRole("USER")).toBeUndefined()
		expect(parseResultRole("agent")).toBeUndefined()
		expect(parseResultRole(42)).toBeUndefined()
		expect(parseResultRole(undefined)).toBeUndefined()
	})
})

describe("recoverRoleFromTextPrefix", () => {
	it("recovers the role from renderEventChunkText prefixes", () => {
		expect(recoverRoleFromTextPrefix("User: deploy on Monday")).toBe("user")
		expect(recoverRoleFromTextPrefix("Assistant: noted")).toBe("assistant")
		expect(recoverRoleFromTextPrefix("System: policy")).toBe("system")
		expect(recoverRoleFromTextPrefix("Tool: output")).toBe("tool")
	})

	it("returns undefined for unprefixed or non-string text", () => {
		expect(recoverRoleFromTextPrefix("deploy on Monday")).toBeUndefined()
		expect(recoverRoleFromTextPrefix("User said: deploy")).toBeUndefined()
		expect(recoverRoleFromTextPrefix(undefined)).toBeUndefined()
		expect(recoverRoleFromTextPrefix(123)).toBeUndefined()
	})
})

describe("derivationFromRole", () => {
	it("maps user turns to user and everything else to agent", () => {
		expect(derivationFromRole("user")).toBe("user")
		expect(derivationFromRole("assistant")).toBe("agent")
		expect(derivationFromRole("system")).toBe("agent")
		expect(derivationFromRole("tool")).toBe("agent")
	})
})

describe("isUserDerivation", () => {
	it("accepts user and user-extracted only", () => {
		expect(isUserDerivation("user")).toBe(true)
		expect(isUserDerivation("user-extracted")).toBe(true)
		expect(isUserDerivation("agent")).toBe(false)
		expect(isUserDerivation("derived")).toBe(false)
		expect(isUserDerivation("inferred")).toBe(false)
		expect(isUserDerivation("reference")).toBe(false)
		expect(isUserDerivation(undefined)).toBe(false)
	})
})

describe("isExactCapableDerivation", () => {
	it("accepts verbatim-by-construction derivations only", () => {
		expect(isExactCapableDerivation("user")).toBe(true)
		expect(isExactCapableDerivation("user-extracted")).toBe(true)
		expect(isExactCapableDerivation("reference")).toBe(true)
		expect(isExactCapableDerivation("agent")).toBe(false)
		expect(isExactCapableDerivation("derived")).toBe(false)
		expect(isExactCapableDerivation("inferred")).toBe(false)
		expect(isExactCapableDerivation(undefined)).toBe(false)
	})
})

describe("resolveChunkProvenance", () => {
	it("prefers the authoritative role field", () => {
		expect(
			resolveChunkProvenance({
				source: "session-evidence",
				role: "assistant",
				text: "User: verbatim user text",
			}),
		).toEqual({ role: "assistant", derivation: "agent" })
	})

	it("resolves evidence chunk discriminators", () => {
		expect(resolveChunkProvenance({ source: "session-evidence" })).toEqual({
			role: undefined,
			derivation: "user",
		})
		expect(resolveChunkProvenance({ source: "userfact-evidence" })).toEqual({
			role: undefined,
			derivation: "user-extracted",
		})
		expect(resolveChunkProvenance({ source: "preference-evidence" })).toEqual({
			role: undefined,
			derivation: "user-extracted",
		})
		expect(resolveChunkProvenance({ source: "qa-evidence" })).toEqual({
			role: undefined,
			derivation: "derived",
		})
	})

	it("resolves transcript and KB discriminators", () => {
		expect(resolveChunkProvenance({ source: "sessions" })).toEqual({
			role: undefined,
			derivation: "derived",
		})
		expect(resolveChunkProvenance({ source: "kb" })).toEqual({
			role: undefined,
			derivation: "reference",
		})
		expect(resolveChunkProvenance({ source: "memory" })).toEqual({
			role: undefined,
			derivation: "reference",
		})
	})

	it("recovers legacy conversation roles from the text prefix", () => {
		expect(
			resolveChunkProvenance({ source: "conversation", text: "User: ship it" }),
		).toEqual({ role: "user", derivation: "user" })
		expect(
			resolveChunkProvenance({
				source: "conversation",
				text: "Assistant: acknowledged",
			}),
		).toEqual({ role: "assistant", derivation: "agent" })
	})

	it("defaults unknown rows to derived — absent provenance is never user-authored", () => {
		expect(resolveChunkProvenance({ source: "conversation" })).toEqual({
			role: undefined,
			derivation: "derived",
		})
		expect(resolveChunkProvenance({})).toEqual({
			role: undefined,
			derivation: "derived",
		})
	})
})
