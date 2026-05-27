import { describe, expect, it } from "vitest"
import {
	normalizeBenchmarkRunIdForPrefix,
	resolveBenchmarkCollectionPrefix,
	validateBenchmarkCollectionPrefix,
} from "./benchmark-run-isolation.js"

describe("benchmark MongoDB run isolation", () => {
	it("derives a safe collection prefix from a benchmark run id", () => {
		expect(
			resolveBenchmarkCollectionPrefix({
				runId: "Memongo-Raw-Session-Full500-20260520-Atlas-A",
			}),
		).toEqual({
			collectionPrefix:
				"memongo_bench_memongo_raw_session_full500_20260520_atlas_a_",
			source: "derived",
		})
	})

	it("keeps explicit safe benchmark prefixes", () => {
		expect(
			resolveBenchmarkCollectionPrefix({
				runId: "ignored",
				explicitPrefix: "memongo_bench_manual_20260520a_",
			}),
		).toEqual({
			collectionPrefix: "memongo_bench_manual_20260520a_",
			source: "explicit",
		})
	})

	it("rejects prefixes that could collide with product or dogfood data", () => {
		expect(() => validateBenchmarkCollectionPrefix("")).toThrow(
			"must not be empty",
		)
		expect(() => validateBenchmarkCollectionPrefix("memongo_")).toThrow(
			"must start with memongo_bench_",
		)
		expect(() =>
			validateBenchmarkCollectionPrefix("memongo_bench_manual"),
		).toThrow("must end with _")
		expect(() =>
			validateBenchmarkCollectionPrefix("memongo_bench_has-hyphen_"),
		).toThrow("only lowercase letters")
	})

	it("normalizes hostile or messy run ids", () => {
		expect(normalizeBenchmarkRunIdForPrefix("  ../RUN 123 !! ")).toBe("run_123")
	})
})
