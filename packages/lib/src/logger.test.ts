import { afterEach, describe, expect, it, vi } from "vitest"
import { createSubsystemLogger } from "./logger.js"

afterEach(() => {
	vi.restoreAllMocks()
})

function capturedCalls(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.map((args) => args.join(" ")).join("\n")
}

describe("createSubsystemLogger (C-002: redaction at the logging boundary)", () => {
	it("redacts credential-bearing messages", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const log = createSubsystemLogger("test:redact")

		log.warn(
			[
				"connect failed: ",
				"mongodb://svc:",
				"dummy-cred-000@",
				"host.example.net:27017",
			].join(""),
		)

		const out = capturedCalls(warn)
		expect(out).toContain("test:redact")
		expect(out).toContain("connect failed")
		expect(out).not.toContain("dummy-cred-000")
		expect(out).toContain("***")
	})

	it("redacts secrets inside serialized meta while keeping plain fields", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const log = createSubsystemLogger("test:redact")

		log.error("request failed", {
			url: [
				"mongodb://svc:d",
				"ummy-cred-00000@",
				"host.example.net:27017",
			].join(""),
			note: "plain text survives",
		})

		const out = capturedCalls(error)
		expect(out).toContain("plain text survives")
		expect(out).not.toContain("dummy-cred-00000")
	})

	it("redacts raw() lines", () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {})
		const log = createSubsystemLogger("test:redact")

		log.raw(
			[
				"dump: ",
				"Authorization: ",
				"Bearer",
				" dummy-token-aaaaaaaaaaaaaaaaaaaa",
			].join(""),
		)

		const out = capturedCalls(info)
		expect(out).toContain("dump")
		expect(out).not.toContain("dummy-token-aaaaaaaaaaaaaaaaaaaa")
	})

	it("redacts escaped-quoted credential values riding inside a meta value", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const log = createSubsystemLogger("test:redact")

		log.error("write failed", {
			detail: ['password="du', "mmy-pass-001", ' dummy-pass-002"'].join(""),
		})

		const out = capturedCalls(error)
		expect(out).toContain("write failed")
		expect(out).not.toContain("dummy-pass-001")
		expect(out).not.toContain("dummy-pass-002")
		expect(out).toContain("***")
	})

	it("passes ordinary messages through unchanged", () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {})
		const log = createSubsystemLogger("test:plain")

		log.info("hello world")

		expect(info).toHaveBeenCalledWith(expect.stringContaining("hello world"))
	})
})
