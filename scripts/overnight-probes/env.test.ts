import { describe, expect, it } from "vitest"
import { EnvRefusal, resolveEnvironment } from "./env.ts"

function refusal(fn: () => unknown): EnvRefusal {
	try {
		fn()
	} catch (error) {
		if (error instanceof EnvRefusal) return error
		throw error
	}
	throw new Error("expected a refusal")
}

const BASE_ENV = {
	MEMONGO_MONGODB_URI: "mongodb://u:p-SENTINEL@h.example/",
	VOYAGE_API_KEY: "al-SENTINEL-voyage-0000000000",
}
const B_ENV = {
	...BASE_ENV,
	MEMONGO_BENCHMARK_ANSWER_API_KEY: "ans-SENTINEL-0000000",
	MEMONGO_BENCHMARK_ANSWER_BASE_URL: "https://llm.example/v1",
	MEMONGO_BENCHMARK_ANSWER_MODEL: "m1",
	MEMONGO_PROBE_ANSWER_PRICE_INPUT_USD_PER_MTOK: "1",
	MEMONGO_PROBE_ANSWER_PRICE_OUTPUT_USD_PER_MTOK: "4",
}

describe("resolveEnvironment", () => {
	it("accepts a plain run and resolves the Mongo URI without exposing it in refusals", () => {
		const resolved = resolveEnvironment(BASE_ENV, ["A", "G"])
		expect(resolved.mongoUri).toBe(BASE_ENV.MEMONGO_MONGODB_URI)
		expect(resolved.answer).toBeUndefined()
	})

	it("carries the trimmed Voyage key so no caller needs a default", () => {
		expect(resolveEnvironment(BASE_ENV, ["A"]).voyageKey).toBe(
			BASE_ENV.VOYAGE_API_KEY,
		)
		const padded = resolveEnvironment(
			{ ...BASE_ENV, VOYAGE_API_KEY: `  ${BASE_ENV.VOYAGE_API_KEY}\n` },
			["A"],
		)
		expect(padded.voyageKey).toBe(BASE_ENV.VOYAGE_API_KEY)
	})

	it("prefers the forced URI exactly as the engine does", () => {
		const forced = "mongodb://f:f-SENTINEL@forced.example/"
		const resolved = resolveEnvironment(
			{ ...BASE_ENV, MEMONGO_FORCE_MONGODB_URI: forced },
			["A"],
		)
		expect(resolved.mongoUri).toBe(forced)
	})

	it("names missing variables, never their values", () => {
		const error = refusal(() =>
			resolveEnvironment(
				{ MEMONGO_MONGODB_URI: BASE_ENV.MEMONGO_MONGODB_URI },
				["A"],
			),
		)
		expect(error.missing).toEqual(["VOYAGE_API_KEY"])
		expect(error.message).not.toContain("SENTINEL")
	})

	it("reports a missing Mongo URI as one alternative group", () => {
		const error = refusal(() =>
			resolveEnvironment({ VOYAGE_API_KEY: BASE_ENV.VOYAGE_API_KEY }, ["A"]),
		)
		expect(error.missing).toEqual([
			"MEMONGO_MONGODB_URI|MEMONGO_FORCE_MONGODB_URI",
		])
	})

	it("treats blank values as missing", () => {
		const error = refusal(() =>
			resolveEnvironment({ ...BASE_ENV, VOYAGE_API_KEY: "   " }, ["A"]),
		)
		expect(error.missing).toContain("VOYAGE_API_KEY")
	})

	it("requires the answer provider and unit prices only when probe B is selected", () => {
		expect(() => resolveEnvironment(BASE_ENV, ["B"])).toThrow(EnvRefusal)
		const error = refusal(() => resolveEnvironment(BASE_ENV, ["B"]))
		expect(error.missing).toEqual([
			"MEMONGO_BENCHMARK_ANSWER_API_KEY",
			"MEMONGO_BENCHMARK_ANSWER_BASE_URL",
			"MEMONGO_BENCHMARK_ANSWER_MODEL",
			"MEMONGO_PROBE_ANSWER_PRICE_INPUT_USD_PER_MTOK",
			"MEMONGO_PROBE_ANSWER_PRICE_OUTPUT_USD_PER_MTOK",
		])
		const resolved = resolveEnvironment(B_ENV, ["B"])
		expect(resolved.answer?.model).toBe("m1")
		expect(resolved.answer?.price).toEqual({
			inputUsdPerMTok: 1,
			outputUsdPerMTok: 4,
			source: "operator-env",
		})
	})

	it("refuses unusable price values as invalid, not as secrets", () => {
		for (const bad of ["abc", "-1", "0", "Infinity", "NaN", ""]) {
			const error = refusal(() =>
				resolveEnvironment(
					{ ...B_ENV, MEMONGO_PROBE_ANSWER_PRICE_INPUT_USD_PER_MTOK: bad },
					["B"],
				),
			)
			expect(error.missing.length + error.invalid.length).toBeGreaterThan(0)
		}
	})

	it("refuses an external API base URL and a database override", () => {
		for (const [name, value] of [
			["MEMONGO_API_URL", "http://127.0.0.1:3847"],
			["MEMONGO_API_URL", "https://prod.example"],
			["MEMONGO_MONGODB_DATABASE", "memongo"],
		] as const) {
			const error = refusal(() =>
				resolveEnvironment({ ...BASE_ENV, [name]: value }, ["A"]),
			)
			expect(error.overrides).toEqual([name])
			expect(error.message).not.toContain(value)
		}
	})

	it("ignores an empty override variable", () => {
		expect(() =>
			resolveEnvironment({ ...BASE_ENV, MEMONGO_API_URL: "" }, ["A"]),
		).not.toThrow()
	})
})
