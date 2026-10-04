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
	installSmoke,
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

describe("installed MCP executable startup", () => {
	it.each([
		{
			name: "healthy",
			rejects: false,
			body: `import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => { const request = JSON.parse(line); if (process.env.MEMONGO_MCP_TRANSPORT !== "stdio") process.exit(74); console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: "fixture", version: "1.2.3" } } })); });`,
		},
		{ name: "nonzero exit", rejects: true, body: "process.exit(73);" },
		{ name: "silent success", rejects: true, body: "process.exit(0);" },
		{
			name: "wrong version",
			rejects: true,
			body: 'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "0.0.0" } } }));',
		},
		{
			name: "protocol error",
			rejects: true,
			body: 'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "fixture" } }));',
		},
		{
			name: "malformed response",
			rejects: true,
			body: 'console.log("fixture malformed response");',
		},
		{
			name: "hang ignores SIGTERM",
			rejects: true,
			body: 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
		},
	])("$name", ({ body, rejects }) => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-bin-test-"))
		const originalEnv = { ...process.env }
		try {
			for (const key of Object.keys(process.env)) delete process.env[key]
			Object.assign(process.env, {
				PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
				HOME: path.join(fixture, "home"),
				npm_config_cache: path.join(fixture, "cache"),
				npm_config_userconfig: path.join(fixture, "user.npmrc"),
				npm_config_globalconfig: path.join(fixture, "global.npmrc"),
				npm_config_offline: "true",
				npm_config_audit: "false",
				npm_config_fund: "false",
				npm_config_update_notifier: "false",
				MEMONGO_MCP_TRANSPORT: "http",
			})
			fs.mkdirSync(process.env.HOME ?? "", { recursive: true })
			fs.writeFileSync(path.join(fixture, "user.npmrc"), "")
			fs.writeFileSync(path.join(fixture, "global.npmrc"), "")
			fs.writeFileSync(
				path.join(fixture, "package.json"),
				JSON.stringify({
					name: "@memongo/mcp",
					version: "1.2.3",
					type: "module",
					exports: "./index.js",
					bin: { "memongo-mcp": "./cli.js" },
					files: ["index.js", "cli.js"],
				}),
			)
			fs.writeFileSync(
				path.join(fixture, "index.js"),
				"export const fixture = true;\n",
			)
			fs.writeFileSync(
				path.join(fixture, "cli.js"),
				`#!/usr/bin/env node\n${body}\n`,
				{ mode: 0o755 },
			)
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
					cwd: fixture,
					encoding: "utf8",
					timeout: 10_000,
				}),
			) as { filename: string }[]
			const first = packed[0]
			if (!first) throw new Error("fixture npm pack returned no package")
			const run = () =>
				installSmoke(
					{ name: "@memongo/mcp", dir: "apps/mcp", supportedSurface: true },
					new Map([["@memongo/mcp", path.join(fixture, first.filename)]]),
				)
			if (rejects) expect(run).toThrow()
			else expect(run).not.toThrow()
		} finally {
			for (const key of Object.keys(process.env)) delete process.env[key]
			Object.assign(process.env, originalEnv)
			fs.rmSync(fixture, { recursive: true, force: true })
		}
	}, 25_000)
})
