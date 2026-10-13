import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { computeExecutableDigest } from "./benchmark-executable-identity.js"

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
	git("add", ".")
	git("commit", "-q", "-m", "fixture")
})

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
})
