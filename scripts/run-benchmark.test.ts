import path from "node:path"
import { describe, expect, it } from "vitest"
import { includeBenchmarkAllowedRoot } from "./run-benchmark.js"

describe("includeBenchmarkAllowedRoot", () => {
	it("authorizes the CLI dataset directory without replacing operator roots", () => {
		const operatorRoot = path.resolve("/operator/datasets")
		const cliRoot = path.resolve("/repo/benchmarks/data")

		const result = includeBenchmarkAllowedRoot(operatorRoot, cliRoot)

		expect(result.split(path.delimiter)).toEqual([operatorRoot, cliRoot])
		expect(includeBenchmarkAllowedRoot(result, cliRoot)).toBe(result)
	})
})
