import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
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

describe("publishability CLI modes", () => {
	const rootDir = fileURLToPath(new URL("..", import.meta.url))
	const bun = execFileSync("bun", ["-e", "console.log(process.execPath)"], {
		encoding: "utf8",
	}).trim()

	function runGate(args: string[], npmStatus = 0) {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-gate-"))
		try {
			fs.writeFileSync(
				path.join(fixture, "npm"),
				`#!/bin/sh\nprintf 'registry-probed' > "$GATE_REGISTRY_MARKER"\nprintf '${npmStatus === 1 ? "E404" : '"2.2.0"'}\\n'\nexit ${npmStatus}\n`,
				{ mode: 0o755 },
			)
			fs.writeFileSync(
				path.join(fixture, "bun"),
				"#!/bin/sh\nprintf 'artifact-build-reached\\n' >&2\nexit 73\n",
				{ mode: 0o755 },
			)
			const marker = path.join(fixture, "registry-marker")
			const result = spawnSync(
				bun,
				["scripts/check-publishability.ts", ...args],
				{
					cwd: rootDir,
					encoding: "utf8",
					timeout: 10_000,
					env: {
						...process.env,
						PATH: `${fixture}${path.delimiter}${process.env.PATH}`,
						GATE_REGISTRY_MARKER: marker,
					},
				},
			)
			return {
				status: result.status,
				output: `${result.stdout}\n${result.stderr}`,
				registryProbed: fs.existsSync(marker),
			}
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true })
		}
	}

	it("keeps the default release gate strict for published versions", () => {
		const result = runGate([])
		expect(result.status).toBe(1)
		expect(result.registryProbed).toBe(true)
		expect(result.output).toContain("release version already exists on npm")
		expect(result.output).not.toContain("artifact-build-reached")
	})

	it("keeps the default release gate closed on registry errors", () => {
		const result = runGate([], 2)
		expect(result.status).toBe(1)
		expect(result.output).toContain("could not verify npm version availability")
		expect(result.output).not.toContain("artifact-build-reached")
	})

	it("unpublished release versions continue to artifact validation", () => {
		const result = runGate([], 1)
		expect(result.status).toBe(1)
		expect(result.registryProbed).toBe(true)
		expect(result.output).toContain("artifact-build-reached")
	})

	it.each([
		0, 2,
	])("artifact mode reaches build validation without registry lookup (npm status %s)", (npmStatus) => {
		const result = runGate(["--artifacts-only"], npmStatus)
		expect(result.status).toBe(1)
		expect(result.registryProbed).toBe(false)
		expect(result.output).toContain("artifact-build-reached")
	})

	it("rejects unknown options before running either gate", () => {
		const result = runGate(["--artifact-only"])
		expect(result.status).toBe(1)
		expect(result.registryProbed).toBe(false)
		expect(result.output).toContain("unknown publishability arguments")
	})

	it("uses artifact mode only in ordinary CI", () => {
		const ci = fs.readFileSync(
			path.join(rootDir, ".github/workflows/ci.yml"),
			"utf8",
		)
		const publish = fs.readFileSync(
			path.join(rootDir, ".github/workflows/publish.yml"),
			"utf8",
		)
		expect(ci).toContain("run: bun run check-publishability --artifacts-only")
		expect(publish).toContain("run: bun run check-publishability\n")
		expect(publish).not.toContain("--artifacts-only")
	})
})
