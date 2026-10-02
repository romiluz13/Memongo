import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSubsystemLogger } from "./logger.js"

const privateText = "PRIVATE183 credential password=private-secret "
beforeEach(() => {
	vi.stubEnv("MEMONGO_LOG_LEVEL", "trace")
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})
describe("logger input bounds", () => {
	it.each([
		"warn",
		"error",
		"info",
		"debug",
		"trace",
		"fatal",
		"raw",
	] as const)("omits oversized %s messages before redaction", (level) => {
		const lines: string[] = []
		for (const method of ["warn", "error", "log", "debug"] as const)
			vi.spyOn(console, method).mockImplementation((...args) => {
				lines.push(args.join(" "))
			})
		const message = privateText + "x".repeat(4097 - privateText.length)
		createSubsystemLogger("bound")[level](message)
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("log message omitted (length=4097)")
		expect(lines[0]).not.toContain("PRIVATE183")
		expect(lines[0].length).toBeLessThan(150)
	})
	it("keeps the exact 4096 code-unit boundary", () => {
		const message = "x".repeat(4096)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		createSubsystemLogger("bound").warn(message)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(message))
	})
	it.each([
		"cyclic",
		"bigint",
		"undefined",
		"keys",
	])("omits %s metadata without recursive logging", (kind) => {
		let meta: Record<string, unknown> = {}
		if (kind === "cyclic") meta.self = meta
		if (kind === "bigint") meta.value = 1n
		if (kind === "undefined") meta.toJSON = () => undefined
		if (kind === "keys")
			meta = new Proxy(
				{},
				{
					ownKeys() {
						throw new Error(privateText)
					},
				},
			)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(() =>
			createSubsystemLogger("bound").warn("ordinary warning", meta),
		).not.toThrow()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain("meta omitted (serialize failed)")
		expect(warn.mock.calls[0][0]).not.toContain("PRIVATE183")
	})
	it("omits oversized serialized metadata before redaction", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		createSubsystemLogger("bound").warn("ordinary warning", {
			detail: privateText + "x".repeat(4096),
		})
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain("meta omitted (oversize)")
		expect(warn.mock.calls[0][0]).not.toContain("PRIVATE183")
	})
	it("does not inspect disabled metadata", () => {
		vi.stubEnv("MEMONGO_LOG_LEVEL", "silent")
		const toJSON = vi.fn(() => {
			throw new Error("must not execute")
		})
		createSubsystemLogger("bound").warn("ordinary warning", { toJSON })
		expect(toJSON).not.toHaveBeenCalled()
	})
})
