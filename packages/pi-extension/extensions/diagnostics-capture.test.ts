import { describe, expect, it } from "vitest"
import { sanitizeDiagnostic, errMessage } from "./diagnostics.js"

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
	["--password password", "--password password"],
	['--token "token"', '--token "token"'],
	["Authorization: Bearer Bearer", "Authorization: Bearer ***"],
	[
		"ABCDEFGHIJKLMNOPQRST_SECRET=ABCDEFGHIJKLMNOPQRST_SECRET",
		"ABCDEFGHIJKLMNOPQRST_SECRET=***",
	],
	[
		"😀é " + uri("mongodb", "admin", "admin"),
		"😀é " + uri("mongodb", "admin", "***"),
	],
	["😀é token=token", "😀é token=***"],
	[uri("mongodb", "u", "***"), uri("mongodb", "u", "***")],
	["sk-abc***wxyz", "sk-abc***wxyz"],
] as const

describe("redact exact captured credential spans (F284)", () => {
	it.each(rows)("masks the credential span in %s", (input, expected) => {
		expect(sanitizeDiagnostic(input)).toBe(expected)
		expect(sanitizeDiagnostic(expected)).toBe(expected)
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
		expect(sanitizeDiagnostic(input)).toBe(expected)
		expect(sanitizeDiagnostic(expected)).toBe(expected)
	})
	it("keeps the extension error boundary sanitized", () => {
		expect(errMessage(new Error("password=pass"))).toBe("password=***")
		expect(errMessage("token=token")).toBe("token=***")
	})
	it("preserves Pi's short Bearer and password-with-slash rules", () => {
		expect(sanitizeDiagnostic("Bearer Bearer")).toBe("Bearer ***")
		expect(sanitizeDiagnostic(uri("mongodb", "u", "a/b"))).toBe(
			uri("mongodb", "u", "***"),
		)
	})
})
