import { describe, expect, it } from "vitest"
import { EnvRefusal } from "./env.ts"
import { buildAnswerPort } from "./harness-live.ts"

const ANSWER_ENV = {
	MEMONGO_BENCHMARK_ANSWER_API_KEY: "answer-key-SENTINEL-0001",
	MEMONGO_BENCHMARK_ANSWER_BASE_URL: "https://answer.sentinel.example/v1",
	MEMONGO_BENCHMARK_ANSWER_MODEL: "answer-model",
}

describe("answer provider port", () => {
	it("builds the provider and model from the dedicated answer variables", () => {
		const port = buildAnswerPort(ANSWER_ENV)
		expect(port.model).toBe("answer-model")
		expect(typeof port.provider.chatCompletion).toBe("function")
	})

	it("never falls back to the enrichment configuration", () => {
		expect(() =>
			buildAnswerPort({
				MEMONGO_ENRICHMENT_API_KEY: "enrich-key-SENTINEL-0001",
				MEMONGO_ENRICHMENT_BASE_URL: "https://enrich.sentinel.example/v1",
				MEMONGO_ENRICHMENT_MODEL: "enrich-model",
			}),
		).toThrow(EnvRefusal)
	})

	it("refuses a half-configured answerer instead of sending its model name to the enrichment endpoint", () => {
		expect(() =>
			buildAnswerPort({
				MEMONGO_BENCHMARK_ANSWER_BASE_URL:
					ANSWER_ENV.MEMONGO_BENCHMARK_ANSWER_BASE_URL,
				MEMONGO_BENCHMARK_ANSWER_MODEL:
					ANSWER_ENV.MEMONGO_BENCHMARK_ANSWER_MODEL,
				MEMONGO_ENRICHMENT_API_KEY: "enrich-key-SENTINEL-0001",
				MEMONGO_ENRICHMENT_BASE_URL: "https://enrich.sentinel.example/v1",
				MEMONGO_ENRICHMENT_MODEL: "enrich-model",
			}),
		).toThrow(EnvRefusal)
	})

	it("ignores enrichment variables even when answer variables are present", () => {
		const port = buildAnswerPort({
			...ANSWER_ENV,
			MEMONGO_ENRICHMENT_MODEL: "enrich-model",
		})
		expect(port.model).toBe("answer-model")
	})
})
