import { describe, expect, it } from "vitest"
import {
	benchmarkAnswerModelName,
	resolveBenchmarkAnswerProvider,
} from "./benchmark-answer-provider.js"

const FALLBACK_ENV = {
	MEMONGO_ENRICHMENT_API_KEY: "fallback-key",
	MEMONGO_ENRICHMENT_BASE_URL: "https://fallback.example.com/v1",
	MEMONGO_ENRICHMENT_MODEL: "fallback-model",
}

describe("benchmarkAnswerModelName", () => {
	it("prefers MEMONGO_BENCHMARK_ANSWER_MODEL over the enrichment model", () => {
		expect(
			benchmarkAnswerModelName({
				MEMONGO_BENCHMARK_ANSWER_MODEL: "answerer",
				MEMONGO_ENRICHMENT_MODEL: "extractor",
			}),
		).toBe("answerer")
	})

	it("falls back to MEMONGO_ENRICHMENT_MODEL when the answer model is unset", () => {
		expect(
			benchmarkAnswerModelName({
				MEMONGO_ENRICHMENT_MODEL: "extractor",
			}),
		).toBe("extractor")
	})

	it("ignores whitespace-only values and returns empty when neither is set", () => {
		expect(
			benchmarkAnswerModelName({
				MEMONGO_BENCHMARK_ANSWER_MODEL: "   ",
				MEMONGO_ENRICHMENT_MODEL: "extractor",
			}),
		).toBe("extractor")
		expect(benchmarkAnswerModelName({})).toBe("")
	})
})

describe("resolveBenchmarkAnswerProvider", () => {
	it("falls back to the enrichment provider when no dedicated answerer is configured", () => {
		const provider = resolveBenchmarkAnswerProvider(FALLBACK_ENV)
		expect(provider).not.toBeNull()
		expect(provider?.name).toBe("http")
	})

	it("maps the dedicated answer env onto the provider config", () => {
		// The enrichment side is deliberately unusable (API key but no base
		// URL), so a resolved provider proves the dedicated answer env was
		// mapped over it rather than inherited.
		const provider = resolveBenchmarkAnswerProvider({
			MEMONGO_ENRICHMENT_API_KEY: "fallback-key",
			MEMONGO_BENCHMARK_ANSWER_API_KEY: "answer-key",
			MEMONGO_BENCHMARK_ANSWER_BASE_URL: "https://answerer.example.com/v1",
			MEMONGO_BENCHMARK_ANSWER_MODEL: "answerer",
		})
		expect(provider).not.toBeNull()
		expect(provider?.name).toBe("http")
	})

	it("requires BASE_URL and MODEL when a dedicated answer API key is set", () => {
		// FALLBACK_ENV has a usable enrichment base URL, but the mapping
		// overrides it with the unset answer BASE_URL, so resolution must
		// fail loudly instead of silently answering from the fallback.
		expect(() =>
			resolveBenchmarkAnswerProvider({
				...FALLBACK_ENV,
				MEMONGO_BENCHMARK_ANSWER_API_KEY: "answer-key",
			}),
		).toThrow(/MEMONGO_ENRICHMENT_BASE_URL is required/)
	})

	it("returns null when neither answerer nor enrichment provider is configured", () => {
		expect(resolveBenchmarkAnswerProvider({})).toBeNull()
	})
})
