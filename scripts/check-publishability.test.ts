import { describe, expect, it } from "vitest"
import {
	assertAlignedInternalDependencies,
	findForbiddenPackageArtifact,
	findMissingLegalFile,
} from "./check-publishability.js"

describe("publishability release policy", () => {
	it.each([
		"dist/client.test.js",
		"dist/client.e2e.test.js",
		"dist/helpers.test-mocks.js",
		"dist/benchmark-parity-envelope.js",
		"dist/mongodb-manager-benchmark.js",
		"dist/fact-extraction-eval.js",
	])("rejects non-production artifact %s", (artifactPath) => {
		expect(findForbiddenPackageArtifact([artifactPath])).toBe(artifactPath)
	})

	it("accepts production package output", () => {
		expect(
			findForbiddenPackageArtifact([
				"dist/index.js",
				"dist/index.d.ts",
				"README.md",
			]),
		).toBeUndefined()
	})

	it("rejects a tarball inventory missing LICENSE", () => {
		expect(findMissingLegalFile(["dist/index.js", "README.md", "NOTICE"])).toBe(
			"LICENSE",
		)
	})

	it("rejects a tarball inventory missing NOTICE", () => {
		expect(
			findMissingLegalFile(["dist/index.js", "README.md", "LICENSE"]),
		).toBe("NOTICE")
	})

	it("accepts a tarball inventory with both legal files", () => {
		expect(
			findMissingLegalFile(["dist/index.js", "README.md", "LICENSE", "NOTICE"]),
		).toBeUndefined()
	})

	it("rejects stale internal dependency ranges", () => {
		expect(() =>
			assertAlignedInternalDependencies(
				{
					name: "@memongo/tools",
					dependencies: {
						"@memongo/client": "2.0.0",
					},
				},
				new Map([["@memongo/client", "2.0.1"]]),
			),
		).toThrow(
			'@memongo/tools must depend on @memongo/client using "^2.0.1", found "2.0.0"',
		)
	})

	it("accepts aligned internal dependency ranges", () => {
		expect(() =>
			assertAlignedInternalDependencies(
				{
					name: "@memongo/tools",
					dependencies: {
						"@memongo/client": "^2.0.1",
					},
				},
				new Map([["@memongo/client", "2.0.1"]]),
			),
		).not.toThrow()
	})
})
