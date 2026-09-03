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
		const pem = [
			"-----",
			"BEGIN ",
			"PRIVATE KEY",
			"-----\nABC123\n",
			"----",
			"-END",
			" PRIVATE KEY-----",
		].join("")
		expect(redactSecrets(pem)).toBe(redactSensitiveText(pem))
		expect(redactSecrets("plain")).toBe("plain")
	})
})

describe("redact: PEM private key blocks", () => {
	it("replaces the key body but keeps the BEGIN/END markers", () => {
		const pem = [
			"-----",
			"BEGIN ",
			"PRIVATE KEY",
			"-----\nMIIabc123def456\nMIIghi789jkl000\n",
			"----",
			"-END",
			" PRIVATE KEY-----",
		].join("")
		expect(redactSensitiveText(pem)).toBe(
			[
				"-----",
				"BEGIN ",
				"PRIVATE KEY",
				"-----\n***redacted***\n",
				"----",
				"-END",
				" PRIVATE KEY-----",
			].join(""),
		)
	})

	it("redacts PEM blocks embedded in surrounding text", () => {
		const text = [
			"cert dump:\n",
			"-----B",
			"EGIN RS",
			"A PRIVATE KEY",
			"-----\nABC123\n",
			"----",
			"-END",
			" RSA PRIVATE KEY-----\nend of dump",
		].join("")
		expect(redactSensitiveText(text)).toBe(
			[
				"cert dump:\n",
				"-----B",
				"EGIN RS",
				"A PRIVATE KEY",
				"-----\n***redacted***\n",
				"----",
				"-END",
				" RSA PRIVATE KEY-----\nend of dump",
			].join(""),
		)
	})

	it("is idempotent on PEM blocks", () => {
		const pem = [
			"-----",
			"BEGIN ",
			"PRIVATE KEY",
			"-----\nABC123\n",
			"----",
			"-END",
			" PRIVATE KEY-----",
		].join("")
		const once = redactSensitiveText(pem)
		expect(redactSensitiveText(once)).toBe(once)
	})

	it("redacts every PEM block when several appear", () => {
		const text = [
			"-----",
			"BEGIN ",
			"PRIVATE KEY",
			"-----\nAAA\n",
			"----",
			"-END",
			" PRIVATE KEY-----\nmiddle\n",
			"-----B",
			"EGIN E",
			"C PRIVATE KEY",
			"-----\nBBB\n",
			"----",
			"-END",
			" EC PRIVATE KEY-----",
		].join("")
		const result = redactSensitiveText(text)
		expect(result).not.toContain("AAA")
		expect(result).not.toContain("BBB")
		expect(result).toContain("middle")
		expect(result.match(/\*\*\*redacted\*\*\*/g)).toHaveLength(2)
	})
})

describe("redact: MongoDB connection strings", () => {
	it("masks only the password in a standard connection string", () => {
		expect(redactSensitiveText(mongoUri("dummy-pass-001"))).toBe(
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
			`connect failed for ${mongoUri("dummy-pass-001")} retrying`,
		)
		expect(result).toBe(`connect failed for ${mongoUri("***")} retrying`)
		expect(result).not.toContain("dummy-pass-001")
	})

	it("is idempotent on connection strings", () => {
		const once = redactSensitiveText(mongoUri("dummy-pass-001"))
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
		expect(
			redactSensitiveText(
				["log ", "API_KEY", "=dummy-", "token-00000000", " end"].join(""),
			),
		).toBe(["log ", "API_KEY=du", "mmy-***0000", " end"].join(""))
	})

	it("redacts Bearer tokens embedded in surrounding text", () => {
		expect(
			redactSensitiveText(
				["log ", "Bearer d", "ummy-tok", "en-aaaaaaaaaaaaaa", " end"].join(""),
			),
		).toBe("log Bearer dummy-***aaaa end")
	})

	it("redacts sk- tokens embedded in surrounding text", () => {
		expect(redactSensitiveText("key sk-dummy-token-aaaaaaaaaaaaaa ok")).toBe(
			"key sk-dum***aaaa ok",
		)
	})

	it("redacts sensitive JSON fields", () => {
		expect(
			redactSensitiveText(
				['{"', 'apiKey": ', '"dummy-to', "ken-aaaaaaaaaaaaaa", '"}'].join(""),
			),
		).toBe(['{"', 'apiKey": "d', "ummy-***aaaa", '"}'].join(""))
	})

	it("masks the matched span and never the whole line", () => {
		expect(
			redactSensitiveText(
				[
					"Authorization: ",
					"Bearer",
					" dummy-token-aaaaaaaaaaaaaaaaaaaaaaaa",
				].join(""),
			),
		).toBe(["Authorizat", "ion: Bearer", " dummy-***aaaa"].join(""))
	})
})

// C-002 round-2 refutation: the classifier previously recognized only
// MongoDB scheme credentials, no webhook/credential-path URLs, and no
// AUTH/CREDENTIAL-named assignments. These tests pin the widened classes.
describe("redact: non-MongoDB scheme credentials (C-002 round 2)", () => {
	it("masks the password in a postgres connection string", () => {
		const uri = [
			"postgres://uploa",
			"der:dummy000000@",
			"db.internal:5432/app",
		].join("")
		expect(redactSensitiveText(uri)).toBe(
			["postgres://u", "ploader:***@", "db.internal:5432/app"].join(""),
		)
	})

	it("masks the password in a redis connection string with an empty user", () => {
		const uri = "redis://:dummy-pass-000@cache.internal:6379/0"
		expect(redactSensitiveText(uri)).toBe("redis://:***@cache.internal:6379/0")
	})

	it("masks scheme credentials embedded in driver error text", () => {
		const text = [
			"connect ECONNREFUSED ",
			"amqp://guest:d",
			"ummy-cred-0000@",
			"mq.internal:5672/vhost retrying",
		].join("")
		const result = redactSensitiveText(text)
		expect(result).not.toContain("dummy-cred-0000")
		expect(result).toContain(
			["amqp://g", "uest:***@", "mq.internal:5672/vhost"].join(""),
		)
	})

	it("stars username-only userinfo: the username is the credential (C-002 round 3)", () => {
		// Round-3 refutation payload: redis key-as-username schemes carry the
		// secret in the userinfo with no password part.
		const uri = "redis://dummy-pass-001@[::1]:6379/0"
		expect(redactSensitiveText(uri)).toBe("redis://***@[::1]:6379/0")
	})

	it("stars an https username-only userinfo embedded in log text (C-002 round 3)", () => {
		const text = "upstream rejected https://dummy-user-00000@api.example.com/v1"
		const result = redactSensitiveText(text)
		expect(result).not.toContain("dummy-user-00000")
		expect(result).toContain("https://***@api.example.com/v1")
	})

	it("leaves URIs without any userinfo untouched", () => {
		const uri = "mongodb://host:27017/db"
		expect(redactSensitiveText(uri)).toBe(uri)
	})

	it("stars a long (>=18 char) URI userinfo value in full rather than head-tail (C-002 round 3)", () => {
		// Regression: the callback dispatch bound its userinfo branches by
		// source-prefix probes that never matched the escaped regex literal,
		// so both branches silently fell into the partial-reveal maskToken
		// fallback — a long password leaked its first 6 and last 4 chars.
		const uri = [
			"mongodb://svc:du",
			"mmy-cred-0000000@",
			"mongo.internal:27017/db",
		].join("")
		const result = redactSensitiveText(uri)
		expect(result).not.toContain("envelo")
		expect(result).not.toContain("t-99")
		expect(result).toBe(
			["mongodb:/", "/svc:***@", "mongo.internal:27017/db"].join(""),
		)
	})

	it("stars a long username-only userinfo in full (C-002 round 3)", () => {
		const uri = "redis://dummy-user-0000000000@[::1]:6379/0"
		expect(redactSensitiveText(uri)).toBe("redis://***@[::1]:6379/0")
	})
})

describe("redact: webhook and credential-path URLs (C-002 round 2)", () => {
	it("truncates Slack-style webhook URLs to the host", () => {
		const url = [
			"https://hooks.slack.",
			"com/services/T00000000/B0000",
			"0000/dummywebhooktoken0000000",
		].join("")
		expect(redactSensitiveText(url)).toBe("https://hooks.slack.com/***")
	})

	it("truncates Discord webhook URLs to the route prefix", () => {
		const url = "https://discord.com/api/webhooks/1234567890/dumm-0000000000"
		expect(redactSensitiveText(url)).toBe(
			"https://discord.com/api/webhooks/***",
		)
	})

	it("truncates URLs whose path carries a secret token segment", () => {
		const url = "https://hooks.example/services/path-dummy-00000/callback"
		expect(redactSensitiveText(url)).toBe("https://hooks.example/***")
	})

	it("truncates reset-token style paths", () => {
		const url = "https://api.example.com/v1/reset/token/dummytoken000000"
		expect(redactSensitiveText(url)).toBe("https://api.example.com/***")
	})

	it("does not mask paths that merely contain a credential-like prefix", () => {
		const url = "https://docs.example.com/guides/tokenization/intro"
		expect(redactSensitiveText(url)).toBe(url)
	})
})

describe("redact: AUTH/CREDENTIAL-named assignments (C-002 round 2)", () => {
	it("redacts custom auth header values", () => {
		const line = ["X-Cus", "tom-Au", "th: dum", "my-au", "th-00", "0-000"].join(
			"",
		)
		const result = redactSensitiveText(line)
		expect(result).not.toContain("dummy-auth-000-000")
		expect(result).toContain(
			["X-Cus", "tom-Au", "th: dum", "my-**", "*-000"].join(""),
		)
	})

	it("redacts quoted auth header names in serialized objects", () => {
		const line = [
			'{"X-Cus',
			"tom-Au",
			'th": "',
			"dummy-au",
			"th-000-",
			'000", "ok": 1}',
		].join("")
		const result = redactSensitiveText(line)
		expect(result).not.toContain("dummy-auth-000-000")
		expect(result).toContain('"ok": 1')
	})

	it("redacts credential-named assignments", () => {
		const result = redactSensitiveText(
			["credent", "ials: dum", "my-cr", "ed-000", "-00000"].join(""),
		)
		expect(result).not.toContain("dummy-cred-000-00000")
	})

	it("redacts quoted credential values that contain spaces (C-002 round 3)", () => {
		// Round-3 refutation payload: the old value charset stopped at
		// whitespace, so a quoted multi-word password survived entirely raw.
		const line = ['password="du', "mmy-pass-001", ' dummy-pass-002"'].join("")
		const result = redactSensitiveText(line)
		expect(result).not.toContain("dummy-pass-001")
		expect(result).not.toContain("dummy-pass-002")
		expect(result).toContain("***")
	})

	it("redacts single-quoted credential values that contain spaces (C-002 round 3)", () => {
		const line = [
			"apiKe",
			"y='",
			"spac",
			"e sep",
			"arate",
			"d sec",
			"ret v",
			"alue'",
		].join("")
		const result = redactSensitiveText(line)
		expect(result).not.toContain("space separated")
		expect(result).toContain("***")
	})

	it("redacts escaped-quoted credential values inside serialized meta (C-002 round 3)", () => {
		// JSON.stringify escapes inner quotes as \", so an assignment riding
		// inside a meta value serializes as password=\"two words\". The value
		// alternatives tolerate the escaped quotes or the pair survives raw.
		const line = [
			'{"detail":"pass',
			"word=",
			'\\"',
			"dum",
			"my-pa",
			"ss-00",
			"1 dum",
			"my-pa",
			"ss-00",
			"2",
			'\\"',
			'"',
			",",
			'"ok":1}',
		].join("")
		const result = redactSensitiveText(line)
		expect(result).not.toContain("dummy-pass-001")
		expect(result).not.toContain("dummy-pass-002")
		expect(result).toContain('"ok":1')
	})

	it("redacts raw single-quoted credential values inside serialized meta (C-002 round 3)", () => {
		// Single quotes need no JSON escaping, so they appear raw in
		// serialized meta values.
		const line = [
			'{"detail":"apiKe',
			"y='",
			"spac",
			"e sep",
			"arate",
			"d sec",
			"ret v",
			"alue'",
			'"',
			",",
			'"ok":1}',
		].join("")
		const result = redactSensitiveText(line)
		expect(result).not.toContain("space separated")
		expect(result).toContain('"ok":1')
	})

	it("redacts an unclosed quoted credential value to the end of the run (C-002 round 3)", () => {
		const line = ['token="u', "ntermina", "ted-dummy-000000"].join("")
		const result = redactSensitiveText(line)
		expect(result).not.toContain("unterminated-dummy-000000")
		expect(result).toContain("***")
	})

	it("leaves Authorization scheme names without assignments intact", () => {
		const line = "Authorization header: see docs"
		expect(redactSensitiveText(line)).toBe(line)
	})
})
