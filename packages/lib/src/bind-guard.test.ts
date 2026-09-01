import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isLoopbackBindHost, refuseToServeOpen } from "./bind-guard.js"

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("isLoopbackBindHost", () => {
	it("returns true for 127.0.0.1", () => {
		expect(isLoopbackBindHost("127.0.0.1")).toBe(true)
	})

	it("returns true for localhost", () => {
		expect(isLoopbackBindHost("localhost")).toBe(true)
	})

	it("returns true for ::1", () => {
		expect(isLoopbackBindHost("::1")).toBe(true)
	})

	it("returns true for [::1]", () => {
		expect(isLoopbackBindHost("[::1]")).toBe(true)
	})

	it("returns true for ::ffff:127.0.0.1", () => {
		expect(isLoopbackBindHost("::ffff:127.0.0.1")).toBe(true)
	})

	it("returns true for 127.0.0.2 (full 127.0.0.0/8 range)", () => {
		expect(isLoopbackBindHost("127.0.0.2")).toBe(true)
	})

	it("returns true for 127.255.255.255 (edge of 127.0.0.0/8)", () => {
		expect(isLoopbackBindHost("127.255.255.255")).toBe(true)
	})

	it("returns false for 0.0.0.0", () => {
		expect(isLoopbackBindHost("0.0.0.0")).toBe(false)
	})

	it("returns false for 10.0.0.1", () => {
		expect(isLoopbackBindHost("10.0.0.1")).toBe(false)
	})

	it("returns false for empty string", () => {
		expect(isLoopbackBindHost("")).toBe(false)
	})

	it("is case-insensitive", () => {
		expect(isLoopbackBindHost("LOCALHOST")).toBe(true)
		expect(isLoopbackBindHost("Localhost")).toBe(true)
	})
})

describe("refuseToServeOpen", () => {
	beforeEach(() => {
		vi.unstubAllEnvs()
	})

	it("passes on loopback without auth", () => {
		expect(() => refuseToServeOpen("127.0.0.1", false)).not.toThrow()
	})

	it("passes on loopback (localhost) without auth", () => {
		expect(() => refuseToServeOpen("localhost", false)).not.toThrow()
	})

	it("passes on IPv6 loopback ::1 without auth", () => {
		expect(() => refuseToServeOpen("::1", false)).not.toThrow()
	})

	it("passes on IPv4-mapped loopback ::ffff:127.0.0.1 without auth", () => {
		expect(() => refuseToServeOpen("::ffff:127.0.0.1", false)).not.toThrow()
	})

	it("passes on 0.0.0.0 with auth configured", () => {
		expect(() => refuseToServeOpen("0.0.0.0", true)).not.toThrow()
	})

	it("throws on 0.0.0.0 without auth", () => {
		expect(() => refuseToServeOpen("0.0.0.0", false)).toThrow()
	})

	it("throws on 10.0.0.1 without auth", () => {
		expect(() => refuseToServeOpen("10.0.0.1", false)).toThrow()
	})

	it("throws with only MEMONGO_ALLOW_INSECURE_NO_AUTH (needs REMOTE too)", () => {
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_NO_AUTH", "true")
		expect(() => refuseToServeOpen("0.0.0.0", false)).toThrow()
	})

	it("throws with only MEMONGO_ALLOW_INSECURE_REMOTE (needs NO_AUTH too)", () => {
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_REMOTE", "true")
		expect(() => refuseToServeOpen("0.0.0.0", false)).toThrow()
	})

	it("passes with both flags set (logs warning)", () => {
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_NO_AUTH", "true")
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_REMOTE", "true")
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(() => refuseToServeOpen("0.0.0.0", false)).not.toThrow()
		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(warnSpy.mock.calls[0][0]).toContain("UNAUTHENTICATED")
		expect(warnSpy.mock.calls[0][0]).toContain("MEMONGO_ALLOW_INSECURE_REMOTE")
		warnSpy.mockRestore()
	})

	it("error message contains actionable remediation", () => {
		try {
			refuseToServeOpen("0.0.0.0", false)
			expect.fail("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(Error)
			const msg = (err as Error).message
			expect(msg).toContain("MEMONGO_API_KEY")
			expect(msg).toContain("127.0.0.1")
			expect(msg).toContain("MEMONGO_ALLOW_INSECURE_REMOTE")
			expect(msg).toContain("0.0.0.0")
		}
	})

	it("accepts truthy variants (1, yes) for env flags", () => {
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_NO_AUTH", "1")
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_REMOTE", "yes")
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(() => refuseToServeOpen("0.0.0.0", false)).not.toThrow()
		warnSpy.mockRestore()
	})
})
