import { describe, expect, it } from "vitest"
import { collectSecretValues, createSanitizer } from "./sanitize.ts"

const S = {
	api: "sk-SENTINEL-api-key-0001",
	voyage: "al-SENTINEL-voyage-0002",
	answer: "ans-SENTINEL-answer-0003",
	password: "SENTINEL/p@ss:w0rd",
	user: "sentineluser",
	host: "cluster0.sentinelhost.mongodb.net",
}
const URI = `mongodb+srv://${S.user}:${encodeURIComponent(S.password)}@${S.host}/?appName=probe`
const ENV = {
	MEMONGO_API_KEY: S.api,
	VOYAGE_API_KEY: S.voyage,
	MEMONGO_BENCHMARK_ANSWER_API_KEY: S.answer,
	MEMONGO_MONGODB_URI: URI,
	MEMONGO_BENCHMARK_ANSWER_MODEL: "model-x",
	PATH: "/usr/bin",
}

function sanitizer() {
	return createSanitizer({ secretValues: collectSecretValues(ENV) })
}

function leaks(output: string): string[] {
	const needles = [
		S.api,
		S.voyage,
		S.answer,
		S.password,
		encodeURIComponent(S.password),
		S.user,
		S.host,
		btoa(`user:${S.api}`),
	]
	return needles.filter((needle) => output.includes(needle))
}

describe("collectSecretValues", () => {
	it("takes credential-named env values and URI parts, never plain settings", () => {
		const values = collectSecretValues(ENV)
		expect(values).toContain(S.api)
		expect(values).toContain(S.voyage)
		expect(values).toContain(URI)
		expect(values).toContain(S.password)
		expect(values).toContain(encodeURIComponent(S.password))
		expect(values).toContain(S.host)
		expect(values).not.toContain("model-x")
		expect(values).not.toContain("/usr/bin")
	})

	it("ignores blank and very short values so ordinary text is not eaten", () => {
		const values = collectSecretValues({ MEMONGO_API_KEY: "", X_TOKEN: "ab" })
		expect(values).toEqual([])
	})
})

describe("sanitizer text", () => {
	it("redacts raw, percent-encoded, base64 and JSON-escaped secret values", () => {
		const s = sanitizer()
		const input = [
			`key=${S.api}`,
			`enc=${encodeURIComponent(S.password)}`,
			`uri=${URI}`,
			`basic=${btoa(`user:${S.api}`)}`,
			`json=${JSON.stringify({ k: S.password })}`,
			`host lookup failed ${S.host}`,
		].join("\n")
		const out = s.text(input)
		expect(leaks(out)).toEqual([])
		expect(out).toContain("[REDACTED")
	})

	it("redacts URI userinfo and secret query parameters of unknown URIs", () => {
		const s = createSanitizer({ secretValues: [] })
		const out = s.text(
			"fetch https://alice:hunter2xyz@example.test/path?api_key=abc123def&x=1&token=tok999 failed",
		)
		expect(out).not.toContain("hunter2xyz")
		expect(out).not.toContain("abc123def")
		expect(out).not.toContain("tok999")
		expect(out).toContain("x=1")
	})

	it("redacts auth headers in any case, including inside JSON text", () => {
		const s = createSanitizer({ secretValues: [] })
		const out = s.text(
			[
				"AUTHORIZATION: Bearer zzzTopSecretToken123",
				"x-Api-Key: keyvalue-987654",
				'{"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}',
				"Proxy-Authorization=Bearer proxytoken55555",
				"Cookie: session=abcdef123456",
			].join("\n"),
		)
		for (const secret of [
			"zzzTopSecretToken123",
			"keyvalue-987654",
			"dXNlcjpwYXNzd29yZA==",
			"proxytoken55555",
			"abcdef123456",
		]) {
			expect(out).not.toContain(secret)
		}
	})

	it("redacts provider key shapes even when unregistered", () => {
		const s = createSanitizer({ secretValues: [] })
		const out = s.text(
			"saw sk-abcdefghijklmnopqrstuvwx and AIzaSyA1234567890abcdefghij",
		)
		expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwx")
		expect(out).not.toContain("AIzaSyA1234567890abcdefghij")
	})

	it("counts and labels what it redacted", () => {
		const s = sanitizer()
		expect(s.redactionCount()).toBe(0)
		const out = s.text(`a ${S.api} b`)
		expect(out).toBe("a [REDACTED:secret] b")
		expect(s.redactionCount()).toBe(1)
	})
})

describe("sanitizer register", () => {
	it("redacts a secret registered after construction in every variant", () => {
		const s = sanitizer()
		const late = "late-SENTINEL-generated-key-0099"
		expect(s.text(`key ${late}`)).toContain(late)
		s.register(late)
		const out = s.text(
			[
				`raw ${late}`,
				`base64 ${Buffer.from(late).toString("base64url")}`,
				`json ${JSON.stringify({ k: late })}`,
			].join("\n"),
		)
		expect(out).not.toContain(late)
		expect(out).not.toContain(Buffer.from(late).toString("base64url"))
		expect(s.text(`still ${S.api}`)).not.toContain(S.api)
	})

	it("ignores a blank or very short registration so ordinary text survives", () => {
		const s = sanitizer()
		s.register("")
		s.register("ab")
		expect(s.text("ab cd")).toBe("ab cd")
	})
})

describe("sanitizer value", () => {
	it("redacts nested values, credential-named fields and error chains", () => {
		const s = sanitizer()
		const err = new Error(`connect failed ${URI}`, {
			cause: new Error(`inner ${S.api}`),
		})
		const input = {
			ok: 1,
			headers: { AUTHORIZATION: `Bearer ${S.api}`, "X-Api-Key": S.voyage },
			nested: [
				{ deep: { token: "freeform-secret-value", note: `has ${S.answer}` } },
			],
			error: err,
			[`key-${S.api}`]: "v",
			apiKey: "plain-but-credential-field",
			headersObj: new Headers({ Authorization: `Bearer ${S.api}` }),
			pairs: [["authorization", `Bearer ${S.api}`]],
			map: new Map([["password", "mapsecret123"]]),
		}
		const out = JSON.stringify(s.value(input))
		expect(leaks(out)).toEqual([])
		expect(out).not.toContain("freeform-secret-value")
		expect(out).not.toContain("plain-but-credential-field")
		expect(out).not.toContain("mapsecret123")
		expect(out).toContain('"ok":1')
	})

	it("survives cycles, bigint, buffers and getters that throw", () => {
		const s = sanitizer()
		const cyclic: Record<string, unknown> = { a: 1 }
		cyclic.self = cyclic
		const out = JSON.stringify(
			s.value({
				cyclic,
				big: 10n,
				buf: Buffer.from(S.api),
				get bad(): string {
					throw new Error(`getter ${S.api}`)
				},
			}),
		)
		expect(leaks(out)).toEqual([])
	})

	it("never emits error stacks", () => {
		const s = sanitizer()
		const out = JSON.stringify(s.value(new Error("boom")))
		expect(out).not.toContain("    at ")
	})
})
