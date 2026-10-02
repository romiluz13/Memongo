import { describe, expect, it, vi } from "vitest"
import { redactSensitiveText } from "./redact.js"
import { formatErrorMessage } from "./errors.js"
import { createSubsystemLogger } from "./logger.js"

const uri = (scheme: string, user: string, password?: string) =>
	[
		scheme,
		"://",
		user,
		password === undefined ? "" : ":" + password,
		"@host",
	].join("")
const rows = [
	[uri("mongodb", "admin", "admin"), uri("mongodb", "admin", "***")],
	[uri("mongodb", "svc", "mongo"), uri("mongodb", "svc", "***")],
	[uri("redis", "redis"), uri("redis", "***")],
	["password=pass", "password=***"],
	["token=token", "token=***"],
	['{"token":"token"}', '{"token":"***"}'],
	['password="password"', 'password="***"'],
	["password='password'", "password='***'"],
	['password=\\"password\\"', 'password=\\"***\\"'],
	["--password password", "--password ***"],
	['--token "token"', '--token "***"'],
	["Authorization: Bearer Bearer", "Authorization: Bearer ***"],
	[
		"ABCDEFGHIJKLMNOPQRST_SECRET=ABCDEFGHIJKLMNOPQRST_SECRET",
		"ABCDEFGHIJKLMNOPQRST_SECRET=ABCDEF***CRET",
	],
	[
		"😀é " + uri("mongodb", "admin", "admin"),
		"😀é " + uri("mongodb", "admin", "***"),
	],
	["😀é token=token", "😀é token=***"],
	[uri("mongodb", "u", "***"), uri("mongodb", "u", "***")],
	["sk-abc***wxyz", "sk-abc***wxyz"],
] as const

describe("redact exact captured credential spans (F319)", () => {
	it.each(rows)("masks the credential span in %s", (input, expected) => {
		expect(redactSensitiveText(input)).toBe(expected)
		expect(redactSensitiveText(expected)).toBe(expected)
	})
	it("preserves offsets across multiple matches and passes", () => {
		const input = [
			uri("mongodb", "admin", "admin"),
			uri("redis", "redis"),
			"password=pass",
			"token=token",
		].join(" | ")
		const expected = [
			uri("mongodb", "admin", "***"),
			uri("redis", "***"),
			"password=***",
			"token=***",
		].join(" | ")
		expect(redactSensitiveText(input)).toBe(expected)
		expect(redactSensitiveText(expected)).toBe(expected)
	})
	it("retains ordinary noncolliding masks across varied surrounding text", () => {
		for (let n = 0; n < 2000; n++) {
			const secret = "z" + n.toString(36).padStart(8, "0")
			const input =
				`prefix ${n} ` + uri("mongodb", "svc", secret) + ` token=${secret} end`
			expect(redactSensitiveText(input)).toBe(
				`prefix ${n} ` + uri("mongodb", "svc", "***") + " token=*** end",
			)
		}
	})
	it("redacts the exact value at error formatting and logger boundaries", () => {
		const input = uri("mongodb", "admin", "admin") + " token=token"
		const expected = uri("mongodb", "admin", "***") + " token=***"
		expect(formatErrorMessage(new Error(input))).toBe(expected)
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.stubEnv("MEMONGO_LOG_LEVEL", "warn")
		try {
			createSubsystemLogger("test").warn(input, { detail: input })
			expect(spy).toHaveBeenCalledTimes(1)
			expect(spy.mock.calls[0][0]).toContain(expected)
			expect(spy.mock.calls[0][0]).not.toContain(":admin@")
			expect(spy.mock.calls[0][0]).not.toContain("token=token")
		} finally {
			spy.mockRestore()
			vi.unstubAllEnvs()
		}
	})
})
