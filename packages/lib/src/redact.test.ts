import { describe, expect, it } from "vitest"
import {
	getDefaultRedactPatterns,
	redactSecrets,
	redactSensitiveText,
} from "./redact.js"

// Connection strings are assembled at runtime so no literal credential-bearing
// URI ever appears in the repo (and to keep secret scanners out of the diff).
const mongoUri = (password: string, srv = false) =>
	["mongodb", srv ? "+srv" : "", "://user:", password, "@host:27017/db"].join(
		"",
	)

describe("redact: passthrough behavior", () => {
	it("returns falsy input unchanged", () => {
		expect(redactSensitiveText("")).toBe("")
	})

	it("leaves ordinary text untouched", () => {
		const samples = [
			"hello world",
			"héllo wörld ✨ unicode is fine",
			"a log line with numbers 123456 and symbols !@#$%",
			"KEY without assignment stays",
			"Bearer short",
		]
		for (const sample of samples) {
			expect(redactSensitiveText(sample), sample).toBe(sample)
		}
	})

	it("exposes redactSecrets as an alias with identical behavior", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----"
		expect(redactSecrets(pem)).toBe(redactSensitiveText(pem))
		expect(redactSecrets("plain")).toBe("plain")
	})
})

describe("redact: PEM private key blocks", () => {
	it("replaces the key body but keeps the BEGIN/END markers", () => {
		const pem =
			"-----BEGIN PRIVATE KEY-----\nMIIabc123def456\nMIIghi789jkl000\n-----END PRIVATE KEY-----"
		expect(redactSensitiveText(pem)).toBe(
			"-----BEGIN PRIVATE KEY-----\n***redacted***\n-----END PRIVATE KEY-----",
		)
	})

	it("redacts PEM blocks embedded in surrounding text", () => {
		const text =
			"cert dump:\n-----BEGIN RSA PRIVATE KEY-----\nABC123\n-----END RSA PRIVATE KEY-----\nend of dump"
		expect(redactSensitiveText(text)).toBe(
			"cert dump:\n-----BEGIN RSA PRIVATE KEY-----\n***redacted***\n-----END RSA PRIVATE KEY-----\nend of dump",
		)
	})

	it("is idempotent on PEM blocks", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----"
		const once = redactSensitiveText(pem)
		expect(redactSensitiveText(once)).toBe(once)
	})

	it("redacts every PEM block when several appear", () => {
		const text =
			"-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\nmiddle\n-----BEGIN EC PRIVATE KEY-----\nBBB\n-----END EC PRIVATE KEY-----"
		const result = redactSensitiveText(text)
		expect(result).not.toContain("AAA")
		expect(result).not.toContain("BBB")
		expect(result).toContain("middle")
		expect(result.match(/\*\*\*redacted\*\*\*/g)).toHaveLength(2)
	})
})

describe("redact: MongoDB connection strings", () => {
	it("masks only the password in a standard connection string", () => {
		expect(redactSensitiveText(mongoUri("hunter2hunter2"))).toBe(
			mongoUri("***"),
		)
	})

	it("masks the password in a +srv connection string", () => {
		expect(redactSensitiveText(mongoUri("s3cr3ts3cr3t", true))).toBe(
			mongoUri("***", true),
		)
	})

	it("redacts connection strings embedded in log text", () => {
		const result = redactSensitiveText(
			`connect failed for ${mongoUri("hunter2hunter2")} retrying`,
		)
		expect(result).toBe(`connect failed for ${mongoUri("***")} retrying`)
		expect(result).not.toContain("hunter2hunter2")
	})

	it("is idempotent on connection strings", () => {
		const once = redactSensitiveText(mongoUri("hunter2hunter2"))
		expect(redactSensitiveText(once)).toBe(once)
	})
})

describe("redact: getDefaultRedactPatterns", () => {
	it("returns a non-empty list of compilable regex sources", () => {
		const patterns = getDefaultRedactPatterns()
		expect(patterns.length).toBeGreaterThanOrEqual(10)
		for (const source of patterns) {
			expect(typeof source).toBe("string")
			expect(source.length).toBeGreaterThan(0)
			expect(() => new RegExp(source)).not.toThrow()
		}
	})

	it("returns copies that do not mutate module state", () => {
		const first = getDefaultRedactPatterns()
		first.push("tampered")
		expect(getDefaultRedactPatterns()).not.toContain("tampered")
	})
})

// Regression guard: the generic token-masking replacer in redact.ts used to
// select the replace-callback's trailing `string` vararg (the whole input) as
// `token` via `.at(-1)`, so `match.replace(token, masked)` was a no-op when a
// secret was embedded in surrounding text — and over-masked the entire line
// when the input equaled the match. Fixed by slicing capture groups at the
// numeric offset arg; these tests pin the correct contract.
describe("redact: generic token path (regression guard for the fixed varargs bug)", () => {
	it("redacts KEY=value secrets embedded in surrounding text", () => {
		expect(redactSensitiveText("log API_KEY=abcdefghijklmnopqrst end")).toBe(
			"log API_KEY=abcdef***qrst end",
		)
	})

	it("redacts Bearer tokens embedded in surrounding text", () => {
		expect(
			redactSensitiveText("log Bearer abcdefghijklmnopqrstuvwxyz end"),
		).toBe("log Bearer abcdef***wxyz end")
	})

	it("redacts sk- tokens embedded in surrounding text", () => {
		expect(redactSensitiveText("key sk-abcdefghijklmnopqrstuvwxyz ok")).toBe(
			"key sk-abc***wxyz ok",
		)
	})

	it("redacts JSON apiKey values", () => {
		expect(
			redactSensitiveText('{"apiKey": "abcdefghijklmnopqrstuvwxyz"}'),
		).toBe('{"apiKey": "abcdef***wxyz"}')
	})

	it("masks only the secret, not the surrounding line", () => {
		expect(
			redactSensitiveText(
				"Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
			),
		).toBe("Authorization: Bearer abcdef***6789")
	})
})
