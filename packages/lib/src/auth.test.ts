import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	ApiKeyRotation,
	parseGeminiAuth,
	requireApiKey,
	resolveApiKeyForProvider,
	resolveApiKeyRotation,
	resolveEnvApiKey,
} from "./auth.js"

describe("auth: resolveApiKeyForProvider", () => {
	it("resolves canonical env vars for known providers", () => {
		expect(
			resolveApiKeyForProvider("openai", { OPENAI_API_KEY: "sk-test" }),
		).toBe("sk-test")
		expect(
			resolveApiKeyForProvider("anthropic", { ANTHROPIC_API_KEY: "ant" }),
		).toBe("ant")
		expect(resolveApiKeyForProvider("voyage", { VOYAGE_API_KEY: "vo" })).toBe(
			"vo",
		)
	})

	it("is case-insensitive and strips dashes from provider names", () => {
		expect(
			resolveApiKeyForProvider("OpenAI", { OPENAI_API_KEY: "sk-test" }),
		).toBe("sk-test")
		expect(
			resolveApiKeyForProvider("deep-seek", { DEEPSEEK_API_KEY: "ds" }),
		).toBe("ds")
	})

	it("walks multi-candidate mappings in declared order", () => {
		expect(
			resolveApiKeyForProvider("google", {
				GOOGLE_GENERATIVE_AI_API_KEY: "gen",
				GEMINI_API_KEY: "gem",
			}),
		).toBe("gen")
		expect(resolveApiKeyForProvider("google", { GEMINI_API_KEY: "gem" })).toBe(
			"gem",
		)
		expect(resolveApiKeyForProvider("gemini", { GOOGLE_API_KEY: "goog" })).toBe(
			"goog",
		)
		expect(
			resolveApiKeyForProvider("perplexity", { PPLX_API_KEY: "pplx" }),
		).toBe("pplx")
	})

	it("falls back to generic <PROVIDER>_API_KEY then MEMONGO_ prefixed vars", () => {
		expect(resolveApiKeyForProvider("acme", { ACME_API_KEY: "a" })).toBe("a")
		expect(
			resolveApiKeyForProvider("acme", { MEMONGO_ACME_API_KEY: "m" }),
		).toBe("m")
		expect(
			resolveApiKeyForProvider("acme", {
				ACME_API_KEY: "a",
				MEMONGO_ACME_API_KEY: "m",
			}),
		).toBe("a")
	})

	it("falls back to generic vars even for mapped providers", () => {
		expect(
			resolveApiKeyForProvider("openai", { MEMONGO_OPENAI_API_KEY: "m" }),
		).toBe("m")
	})

	it("trims whitespace and skips blank values", () => {
		expect(
			resolveApiKeyForProvider("openai", { OPENAI_API_KEY: "  sk-padded  " }),
		).toBe("sk-padded")
		expect(
			resolveApiKeyForProvider("openai", {
				OPENAI_API_KEY: "   ",
				MEMONGO_OPENAI_API_KEY: "fallback",
			}),
		).toBe("fallback")
	})

	it("returns undefined when nothing is set", () => {
		expect(resolveApiKeyForProvider("openai", {})).toBeUndefined()
		expect(resolveApiKeyForProvider("unknown-llm", {})).toBeUndefined()
	})

	it("ignores inherited provider mapping keys", () => {
		expect(resolveApiKeyForProvider("__proto__", {})).toBeUndefined()
	})

	it("never returns a blank or untrimmed key (property)", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (provider, value) => {
				const resolved = resolveApiKeyForProvider(provider, {
					ACME_API_KEY: value,
				})
				if (resolved !== undefined) {
					expect(resolved.length).toBeGreaterThan(0)
					expect(resolved).toBe(resolved.trim())
				}
			}),
		)
	})
})

describe("auth: requireApiKey", () => {
	it("returns the resolved key", () => {
		expect(requireApiKey("openai", { OPENAI_API_KEY: "sk-test" })).toBe(
			"sk-test",
		)
	})

	it("throws a descriptive error naming both generic env vars", () => {
		expect(() => requireApiKey("acme", {})).toThrow(
			/Missing API key for provider "acme"/,
		)
		expect(() => requireApiKey("acme", {})).toThrow(
			/ACME_API_KEY or MEMONGO_ACME_API_KEY/,
		)
	})

	it("normalizes dashes to underscores in the error message", () => {
		expect(() => requireApiKey("my-llm", {})).toThrow(/MY_LLM_API_KEY/)
	})
})

describe("auth: resolveEnvApiKey", () => {
	it("returns the trimmed value or undefined for missing/blank", () => {
		expect(resolveEnvApiKey("X_KEY", { X_KEY: "  abc  " })).toBe("abc")
		expect(resolveEnvApiKey("X_KEY", { X_KEY: "   " })).toBeUndefined()
		expect(resolveEnvApiKey("X_KEY", {})).toBeUndefined()
	})
})

describe("auth: parseGeminiAuth", () => {
	it("prefers GOOGLE_API_KEY, then GOOGLE_GENERATIVE_AI_API_KEY, then GEMINI_API_KEY", () => {
		expect(
			parseGeminiAuth({
				GOOGLE_API_KEY: "g",
				GOOGLE_GENERATIVE_AI_API_KEY: "gen",
				GEMINI_API_KEY: "gem",
			}).apiKey,
		).toBe("g")
		expect(
			parseGeminiAuth({
				GOOGLE_GENERATIVE_AI_API_KEY: "gen",
				GEMINI_API_KEY: "gem",
			}).apiKey,
		).toBe("gen")
		expect(parseGeminiAuth({ GEMINI_API_KEY: "gem" }).apiKey).toBe("gem")
	})

	it("resolves project and location with their own precedence", () => {
		const parsed = parseGeminiAuth({
			GOOGLE_CLOUD_PROJECT: "proj",
			GCLOUD_PROJECT: "legacy",
			GOOGLE_CLOUD_LOCATION: "us-central1",
		})
		expect(parsed.projectId).toBe("proj")
		expect(parsed.location).toBe("us-central1")
		expect(parseGeminiAuth({ GCLOUD_PROJECT: "legacy" }).projectId).toBe(
			"legacy",
		)
	})

	it("returns undefined fields for missing or blank env", () => {
		expect(parseGeminiAuth({})).toEqual({
			apiKey: undefined,
			projectId: undefined,
			location: undefined,
		})
		expect(
			parseGeminiAuth({ GOOGLE_API_KEY: "  ", GOOGLE_CLOUD_PROJECT: "" }),
		).toEqual({
			apiKey: undefined,
			projectId: undefined,
			location: undefined,
		})
	})
})

describe("auth: ApiKeyRotation", () => {
	it("rotates through keys in order and wraps around", () => {
		const rotation = new ApiKeyRotation(["k1", "k2", "k3"])
		expect(rotation.count).toBe(3)
		expect(rotation.next()).toBe("k1")
		expect(rotation.next()).toBe("k2")
		expect(rotation.next()).toBe("k3")
		expect(rotation.next()).toBe("k1")
	})

	it("drops blank keys at construction", () => {
		const rotation = new ApiKeyRotation(["k1", "  ", "", "k2"])
		expect(rotation.count).toBe(2)
		expect(rotation.next()).toBe("k1")
		expect(rotation.next()).toBe("k2")
	})

	it("throws when no usable key is provided", () => {
		expect(() => new ApiKeyRotation([])).toThrow(/at least one key/)
		expect(() => new ApiKeyRotation(["", "   "])).toThrow(/at least one key/)
	})

	it("cycles in order for any key list (property)", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
					{ minLength: 1, maxLength: 8 },
				),
				fc.integer({ min: 1, max: 20 }),
				(keys, draws) => {
					const rotation = new ApiKeyRotation(keys)
					expect(rotation.count).toBe(keys.length)
					for (let i = 0; i < draws; i += 1) {
						expect(rotation.next()).toBe(keys[i % keys.length])
					}
				},
			),
		)
	})
})

describe("auth: resolveApiKeyRotation", () => {
	it("builds a rotation from a comma-separated multi-key env var", () => {
		const rotation = resolveApiKeyRotation("acme", {
			ACME_API_KEYS: "k1, k2,,k3",
		})
		expect(rotation?.count).toBe(3)
		expect(rotation?.next()).toBe("k1")
		expect(rotation?.next()).toBe("k2")
		expect(rotation?.next()).toBe("k3")
	})

	it("prefers the multi-key var over single-key resolution", () => {
		const rotation = resolveApiKeyRotation("openai", {
			OPENAI_API_KEYS: "multi1,multi2",
			OPENAI_API_KEY: "single",
		})
		expect(rotation?.count).toBe(2)
		expect(rotation?.next()).toBe("multi1")
	})

	it("falls back to a single-key rotation when no multi-key var exists", () => {
		const rotation = resolveApiKeyRotation("openai", {
			OPENAI_API_KEY: "single",
		})
		expect(rotation?.count).toBe(1)
		expect(rotation?.next()).toBe("single")
	})

	it("falls through to single-key resolution when the multi-key var is blank", () => {
		const rotation = resolveApiKeyRotation("acme", {
			ACME_API_KEYS: " , , ",
			ACME_API_KEY: "single",
		})
		expect(rotation?.count).toBe(1)
		expect(rotation?.next()).toBe("single")
	})

	it("returns undefined when no keys are configured", () => {
		expect(resolveApiKeyRotation("acme", {})).toBeUndefined()
	})
})
