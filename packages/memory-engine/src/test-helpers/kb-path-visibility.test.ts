import { describe, expect, it } from "vitest"
import { kbLaneEnvironmentAvailable } from "./kb-path-visibility.js"

describe("kbLaneEnvironmentAvailable (P1.9)", () => {
	const required = ["test_kb_chunks_vector", "test_kb_chunks_text"]

	it("is available when any required KB search index exists", () => {
		expect(
			kbLaneEnvironmentAvailable({
				availableSearchIndexes: ["test_kb_chunks_text"],
				requiredIndexNames: required,
			}),
		).toBe(true)
		expect(
			kbLaneEnvironmentAvailable({
				availableSearchIndexes: [
					"test_kb_chunks_vector",
					"test_kb_chunks_text",
				],
				requiredIndexNames: required,
			}),
		).toBe(true)
	})

	it("is unavailable when no required KB search index exists", () => {
		expect(
			kbLaneEnvironmentAvailable({
				availableSearchIndexes: [],
				requiredIndexNames: required,
			}),
		).toBe(false)
		expect(
			kbLaneEnvironmentAvailable({
				availableSearchIndexes: ["test_mem_text"],
				requiredIndexNames: required,
			}),
		).toBe(false)
	})

	it("PROVES RED: the strict e2e assertion fails when the lane is available but never executed", () => {
		// The old test wrapped this assertion in
		// `if (pathsExecuted.includes("kb"))` — green by omission. The repaired
		// test asserts unconditionally once the environment gate passes; this
		// pins that the assertion itself is red-capable (it must throw here).
		const environmentAvailable = kbLaneEnvironmentAvailable({
			availableSearchIndexes: ["test_kb_chunks_text"],
			requiredIndexNames: required,
		})
		const pathsExecuted = ["raw-window"]
		expect(environmentAvailable).toBe(true)
		expect(() => {
			expect(pathsExecuted).toContain("kb")
		}).toThrow()
	})
})
