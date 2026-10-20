import { describe, expect, it } from "vitest"
import { createEvidenceWriter, reportFatal } from "./output.ts"
import { collectSecretValues, createSanitizer } from "./sanitize.ts"

const SECRET = "sk-SENTINEL-writer-key-7777"
const ENV = {
	MEMONGO_API_KEY: SECRET,
	MEMONGO_MONGODB_URI: "mongodb://u:%E0%A4%A@db.sentinel-host.example/x",
}

function sinks() {
	const out: string[] = []
	const err: string[] = []
	return {
		out,
		err,
		stdout: { write: (c: string) => out.push(c) },
		stderr: { write: (c: string) => err.push(c) },
	}
}

describe("evidence writer", () => {
	it("writes one sanitized JSON line per record", () => {
		const s = sinks()
		const writer = createEvidenceWriter({
			stdout: s.stdout,
			stderr: s.stderr,
			sanitizer: createSanitizer({ secretValues: collectSecretValues(ENV) }),
		})
		writer.record("probe-result", {
			case: "A/search",
			request: { headers: { authorization: `Bearer ${SECRET}` } },
			error: new Error(`bad ${SECRET}`),
			[`k-${SECRET}`]: 1,
		})
		writer.note(`warning ${SECRET}`)
		const joined = s.out.join("") + s.err.join("")
		expect(joined).not.toContain(SECRET)
		expect(s.out).toHaveLength(1)
		expect(s.out[0]?.endsWith("\n")).toBe(true)
		const parsed = JSON.parse(s.out[0] ?? "")
		expect(parsed.kind).toBe("probe-result")
		expect(parsed.redactions).toBeGreaterThan(0)
	})

	it("does not throw on unserializable payloads and still redacts", () => {
		const s = sinks()
		const writer = createEvidenceWriter({
			stdout: s.stdout,
			stderr: s.stderr,
			sanitizer: createSanitizer({ secretValues: [SECRET] }),
		})
		const cyclic: Record<string, unknown> = { v: SECRET }
		cyclic.self = cyclic
		writer.record("x", cyclic)
		expect(s.out.join("")).not.toContain(SECRET)
	})
})

describe("sanitizer construction tolerates hostile env", () => {
	it("survives a malformed percent escape inside a URI value", () => {
		expect(() => collectSecretValues(ENV)).not.toThrow()
		expect(collectSecretValues(ENV)).toContain(ENV.MEMONGO_MONGODB_URI)
	})
})

describe("reportFatal", () => {
	it("prints a sanitized message for a failure before any writer exists", () => {
		const s = sinks()
		reportFatal(new Error(`parse failed near ${SECRET}`), ENV, s)
		const text = s.err.join("")
		expect(text).not.toContain(SECRET)
		expect(text).toContain("fatal")
		expect(s.out.join("")).toBe("")
	})

	it("falls back to a constant message when the env cannot be read at all", () => {
		const s = sinks()
		const hostile = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error(`env exploded ${SECRET}`)
				},
			},
		) as Record<string, string | undefined>
		reportFatal(new Error(`x ${SECRET}`), hostile, s)
		const text = s.err.join("")
		expect(text).not.toContain(SECRET)
		expect(text).toContain("fatal")
	})
})
