import { execFileSync } from "node:child_process"
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	BENCHMARK_BUILD_ROOTS,
	computeExecutableDigest,
} from "./benchmark-executable-identity.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"
import {
	readBenchmarkCheckpoint,
	writeBenchmarkCheckpointAtomic,
} from "./mongodb-benchmark-checkpoint.js"

let repo: string

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: repo, stdio: "ignore" })
}

async function put(relative: string, content: string): Promise<void> {
	await mkdir(path.dirname(path.join(repo, relative)), { recursive: true })
	await writeFile(path.join(repo, relative), content)
}

beforeEach(async () => {
	repo = await mkdtemp(path.join(os.tmpdir(), "memongo-executable-"))
	git("init", "-q")
	git("config", "user.email", "fixture@example.invalid")
	git("config", "user.name", "fixture")
	await put("package.json", "{}\n")
	await put("bun.lock", "lock\n")
	await put("scripts/benchmark/run.ts", "export const a = 1\n")
	await put("packages/engine/src/index.ts", "export const b = 2\n")
	await put("docs/readme.md", "docs\n")
	await workspace()
	git("add", ".")
	git("commit", "-q", "-m", "fixture")
})

// Workspace packages as the benchmark resolves them: ignored dist trees and
// node_modules/@memongo symlinks, bridge -> engine -> lib, plus web outside
// the closure.
const PACKAGES: Array<[dir: string, name: string, deps: string[]]> = [
	["lib", "@memongo/lib", []],
	["memory-engine", "@memongo/memory-engine", ["@memongo/lib"]],
	[
		"memory-bridge",
		"@memongo/memory-bridge",
		["@memongo/memory-engine", "@memongo/lib"],
	],
	["web", "@memongo/web", ["@memongo/lib"]],
]

function manifest(name: string, deps: string[], exports?: unknown): string {
	return `${JSON.stringify({
		name,
		exports: exports ?? {
			".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
		},
		dependencies: Object.fromEntries(deps.map((dep) => [dep, "workspace:*"])),
	})}\n`
}

async function workspace(): Promise<void> {
	await put(".gitignore", "dist\nnode_modules\n")
	for (const [dir, name, deps] of PACKAGES) {
		await put(`packages/${dir}/package.json`, manifest(name, deps))
		await put(`packages/${dir}/dist/index.js`, `export const id = "${dir}"\n`)
		await put(`packages/${dir}/dist/index.d.ts`, "export {}\n")
		await put(
			`packages/${dir}/dist/internal/ranking.js`,
			"export const r = 1\n",
		)
		await mkdir(path.join(repo, "node_modules/@memongo"), { recursive: true })
		await symlink(
			`../../packages/${dir}`,
			path.join(repo, `node_modules/${name}`),
		)
	}
}

async function available(root = repo) {
	const identity = await computeExecutableDigest(root)
	if (identity.status !== "available")
		throw new Error(`expected available: ${identity.reason}`)
	return identity
}

afterEach(async () => {
	await rm(repo, { recursive: true, force: true })
})

describe("computeExecutableDigest", () => {
	it("binds HEAD and is stable for an unchanged tree", async () => {
		const first = await computeExecutableDigest(repo)
		const second = await computeExecutableDigest(repo)
		if (first.status !== "available") throw new Error("expected available")
		expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
		expect(first.headCommit).toMatch(/^[a-f0-9]{40}$/)
		expect(second.digest).toBe(first.digest)
	})

	it("changes when a tracked benchmark source file is edited without committing", async () => {
		const before = await computeExecutableDigest(repo)
		await put("scripts/benchmark/run.ts", "export const a = 2\n")
		const after = await computeExecutableDigest(repo)
		expect(after.digest).not.toBe(before.digest)
	})

	it("ignores checkpoints, results, tmp, untracked output and non-executable docs", async () => {
		const before = await computeExecutableDigest(repo)
		await put("benchmarks/results/checkpoint.json", "{}\n")
		await put("benchmarks/results/run.predictions.jsonl", "{}\n")
		await put("tmp/scratch.txt", "x\n")
		await put("scripts/benchmark/untracked-output.json", "{}\n")
		await put("docs/readme.md", "edited docs\n")
		const after = await computeExecutableDigest(repo)
		expect(after.digest).toBe(before.digest)
	})

	it("changes with the lockfile and runtime versions", async () => {
		const before = await computeExecutableDigest(repo)
		await put("bun.lock", "lock changed\n")
		expect((await computeExecutableDigest(repo)).digest).not.toBe(before.digest)
		const otherRuntime = await computeExecutableDigest(repo, {
			node: "v0.0.0",
			bun: null,
		})
		expect(otherRuntime.digest).not.toBe(before.digest)
	})

	it("treats a deleted tracked file as a change, not as unavailable", async () => {
		const before = await computeExecutableDigest(repo)
		await rm(path.join(repo, "scripts/benchmark/run.ts"))
		const deleted = await computeExecutableDigest(repo)
		expect(deleted.status).toBe("available")
		expect(deleted.digest).not.toBe(before.digest)
		expect((await computeExecutableDigest(repo)).digest).toBe(deleted.digest)
	})

	it("reports unavailable when a tracked file cannot be read", async () => {
		const file = path.join(repo, "scripts/benchmark/run.ts")
		try {
			await chmod(file, 0o000)
			const first = await computeExecutableDigest(repo)
			await chmod(file, 0o600)
			await writeFile(file, "export const a = 99\n")
			await chmod(file, 0o000)
			const second = await computeExecutableDigest(repo)
			expect(first).toMatchObject({ status: "unavailable" })
			expect(second).toMatchObject({ status: "unavailable" })
			expect(first.digest).toBeUndefined()
		} finally {
			await chmod(file, 0o600)
		}
	})

	it("reports whether executable source differs from HEAD", async () => {
		expect(await computeExecutableDigest(repo)).toMatchObject({ dirty: false })
		await put("docs/readme.md", "edited docs\n")
		await put("benchmarks/results/run.json", "{}\n")
		expect(await computeExecutableDigest(repo)).toMatchObject({ dirty: false })
		await put("scripts/benchmark/new-module.ts", "export const c = 3\n")
		expect(await computeExecutableDigest(repo)).toMatchObject({ dirty: true })
		await rm(path.join(repo, "scripts/benchmark/new-module.ts"))
		await put("packages/engine/src/index.ts", "export const b = 3\n")
		expect(await computeExecutableDigest(repo)).toMatchObject({ dirty: true })
	})

	it("ignores inherited Git repository and index overrides", async () => {
		const clean = await computeExecutableDigest(repo)
		if (clean.status !== "available") throw new Error("expected available")
		const foreign = await mkdtemp(path.join(os.tmpdir(), "memongo-foreign-"))
		const saved = { ...process.env }
		try {
			execFileSync("git", ["init", "-q"], { cwd: foreign })
			execFileSync(
				"git",
				[
					"-c",
					"user.email=f@example.invalid",
					"-c",
					"user.name=f",
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					"foreign",
				],
				{ cwd: foreign },
			)
			const alternateIndex = path.join(foreign, "alternate-index")
			execFileSync("git", ["read-tree", "--empty"], {
				cwd: repo,
				env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
			})
			process.env.GIT_DIR = path.join(foreign, ".git")
			process.env.GIT_WORK_TREE = repo
			expect(await computeExecutableDigest(repo)).toMatchObject({
				status: "available",
				digest: clean.digest,
				headCommit: clean.headCommit,
			})
			delete process.env.GIT_DIR
			delete process.env.GIT_WORK_TREE
			process.env.GIT_INDEX_FILE = alternateIndex
			expect(await computeExecutableDigest(repo)).toMatchObject({
				digest: clean.digest,
				trackedFiles: clean.trackedFiles,
				dirty: false,
			})
		} finally {
			for (const key of Object.keys(process.env))
				if (!(key in saved)) delete process.env[key]
			Object.assign(process.env, saved)
			await rm(foreign, { recursive: true, force: true })
		}
	})

	it("observes a linked worktree as its own checkout", async () => {
		const linked = path.join(
			await mkdtemp(path.join(os.tmpdir(), "memongo-linked-")),
			"wt",
		)
		try {
			git("worktree", "add", "-q", "--detach", linked)
			// Ignored build output is not checked out; identity needs those bytes.
			expect(await computeExecutableDigest(linked)).toMatchObject({
				status: "unavailable",
			})
			await cp(
				path.join(repo, "node_modules"),
				path.join(linked, "node_modules"),
				{ recursive: true, verbatimSymlinks: true },
			)
			for (const [dir] of PACKAGES)
				await cp(
					path.join(repo, `packages/${dir}/dist`),
					path.join(linked, `packages/${dir}/dist`),
					{ recursive: true },
				)
			const main = await computeExecutableDigest(repo)
			const identity = await computeExecutableDigest(linked)
			expect(identity).toMatchObject({
				status: "available",
				headCommit: main.status === "available" ? main.headCommit : "",
				digest: main.digest,
				dirty: false,
			})
		} finally {
			await rm(path.dirname(linked), { recursive: true, force: true })
		}
	})

	it("refuses a directory that is not the top of its work tree", async () => {
		expect(
			await computeExecutableDigest(path.join(repo, "scripts")),
		).toMatchObject({ status: "unavailable" })
	})

	it("reports unavailable outside a git work tree", async () => {
		const plain = await mkdtemp(path.join(os.tmpdir(), "memongo-plain-"))
		try {
			const identity = await computeExecutableDigest(plain)
			expect(identity).toMatchObject({ status: "unavailable" })
			expect(identity.digest).toBeUndefined()
		} finally {
			await rm(plain, { recursive: true, force: true })
		}
	})

	it("binds the workspace build closure the benchmark resolves", async () => {
		const identity = await available()
		expect(identity.build).toEqual({
			relation: "not-verified",
			packages: [
				expect.objectContaining({
					name: "@memongo/lib",
					path: "packages/lib",
					files: 3,
				}),
				expect.objectContaining({
					name: "@memongo/memory-bridge",
					path: "packages/memory-bridge",
					files: 3,
				}),
				expect.objectContaining({
					name: "@memongo/memory-engine",
					path: "packages/memory-engine",
					files: 3,
				}),
			],
		})
		expect((await available()).digest).toBe(identity.digest)
	})

	it.each([
		[
			"a non-entry file of a root package",
			"packages/memory-bridge/dist/internal/ranking.js",
		],
		[
			"a transitive dependency's dist",
			"packages/memory-engine/dist/internal/ranking.js",
		],
		["a shared dependency's entry", "packages/lib/dist/index.js"],
	])("changes when ignored build output changes in %s", async (_name, file) => {
		const before = await available()
		await put(file, "export const r = 2 // stale build\n")
		const after = await available()
		expect(after.digest).not.toBe(before.digest)
		expect(after.dirty).toBe(before.dirty)
	})

	it("ignores build output of workspace packages the benchmark does not load", async () => {
		const before = await available()
		await put("packages/web/dist/internal/ranking.js", "export const r = 9\n")
		expect((await available()).digest).toBe(before.digest)
	})

	it("covers the nested package copy the runtime actually resolves", async () => {
		const nested = "packages/memory-engine/node_modules/@memongo/lib"
		await put(`${nested}/package.json`, manifest("@memongo/lib", []))
		await put(`${nested}/dist/index.js`, "export const id = 'nested'\n")
		const before = await available()
		expect(before.build.packages.map((entry) => entry.path)).toContain(nested)
		await put(`${nested}/dist/index.js`, "export const id = 'nested-stale'\n")
		expect((await available()).digest).not.toBe(before.digest)
	})

	it.each([
		[
			"a missing dist tree",
			() =>
				rm(path.join(repo, "packages/memory-engine/dist"), { recursive: true }),
		],
		[
			"an unresolvable dependency",
			() => rm(path.join(repo, "node_modules/@memongo/memory-engine")),
		],
		[
			"a package link resolving outside the repository",
			async () => {
				const outside = await mkdtemp(
					path.join(os.tmpdir(), "memongo-outside-"),
				)
				await writeFile(
					path.join(outside, "package.json"),
					manifest("@memongo/lib", []),
				)
				await mkdir(path.join(outside, "dist"))
				await writeFile(path.join(outside, "dist/index.js"), "export {}\n")
				await rm(path.join(repo, "node_modules/@memongo/lib"))
				await symlink(outside, path.join(repo, "node_modules/@memongo/lib"))
			},
		],
		[
			"a symlink inside dist",
			() =>
				symlink(
					"../../lib/dist/index.js",
					path.join(repo, "packages/memory-engine/dist/linked.js"),
				),
		],
		[
			"a symlinked dist directory",
			async () => {
				await rm(path.join(repo, "packages/lib/dist"), { recursive: true })
				await symlink("../web/dist", path.join(repo, "packages/lib/dist"))
			},
		],
		[
			"node_modules inside dist",
			() => put("packages/lib/dist/node_modules/x/index.js", "export {}\n"),
		],
		[
			"export conditions the resolver check does not model",
			() =>
				put(
					"packages/lib/package.json",
					manifest("@memongo/lib", [], {
						".": { import: "./dist/index.js", default: "./dist/index.js" },
					}),
				),
		],
		[
			"an entry outside dist",
			() =>
				put(
					"packages/lib/package.json",
					manifest("@memongo/lib", [], { ".": { default: "./src/index.js" } }),
				).then(() => put("packages/lib/src/index.js", "export {}\n")),
		],
	])("refuses identity for %s", async (_name, change) => {
		await change()
		const identity = await computeExecutableDigest(repo)
		expect(identity).toMatchObject({ status: "unavailable" })
		expect(identity.digest).toBeUndefined()
		if (identity.status === "unavailable")
			expect(identity.reason).not.toContain(repo)
	})

	it("refuses identity when a build file cannot be read", async () => {
		const file = path.join(repo, "packages/lib/dist/internal/ranking.js")
		try {
			await chmod(file, 0o000)
			expect(await computeExecutableDigest(repo)).toMatchObject({
				status: "unavailable",
			})
		} finally {
			await chmod(file, 0o600)
		}
	})

	it("refuses to resume a checkpoint after the build output changed", async () => {
		const { configuration, configurationHash } = producedRunConfiguration()
		const scenarioIds = ["scenario-1"]
		const admitted = await available()
		const checkpointPath = path.join(repo, "benchmarks/results/run.json")
		await writeBenchmarkCheckpointAtomic(checkpointPath, {
			version: 2,
			runId: "run-1",
			datasetSha256: "a".repeat(64),
			configurationHash,
			configuration,
			executableDigest: admitted.digest,
			totalScenarios: 1,
			scenarioIds,
			completedScenarios: [],
			accounting: {
				currency: null,
				totalCost: null,
				unavailableReason: "prices unavailable",
				operations: [],
			},
			updatedAt: "2026-10-14T00:00:00.000Z",
		})
		const expected = async () => ({
			datasetSha256: "a".repeat(64),
			configurationHash,
			executableDigest: (await available()).digest,
			scenarioIds,
		})
		await expect(
			readBenchmarkCheckpoint(checkpointPath, await expected()),
		).resolves.toMatchObject({ runId: "run-1" })
		await put(
			"packages/memory-engine/dist/internal/ranking.js",
			"export const r = 3\n",
		)
		await expect(
			readBenchmarkCheckpoint(checkpointPath, await expected()),
		).rejects.toThrow("executable digest does not match")
	})
})

describe("benchmark build roots", () => {
	it("cover every workspace package the benchmark entry points import", async () => {
		const root = path.resolve(import.meta.dirname, "../..")
		const files = [
			"scripts/run-benchmark.ts",
			...(await readdir(path.join(root, "scripts/benchmark")))
				.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
				.map((name) => `scripts/benchmark/${name}`),
		]
		const imported = new Set<string>()
		for (const file of files) {
			const text = await readFile(path.join(root, file), "utf8")
			for (const match of text.matchAll(/from\s+"(@memongo\/[a-z-]+)/g))
				imported.add(match[1])
			for (const match of text.matchAll(/import\(\s*["'`](@memongo\/[a-z-]+)/g))
				imported.add(match[1])
		}
		const roots = new Set<string>(BENCHMARK_BUILD_ROOTS)
		expect([...imported].filter((name) => !roots.has(name))).toEqual([])
		expect(imported.size).toBeGreaterThan(0)
	})
})
