import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	getDefaultProofArtifactDir,
	resolveProofArtifactDir,
	writeProofArtifact,
} from "./proof-artifacts.js"

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-proof-artifacts-"))
	tempDirs.push(dir)
	return dir
}

afterEach(async () => {
	await Promise.all(
		tempDirs
			.splice(0)
			.map((dir) =>
				rm(dir, { recursive: true, force: true }).catch(() => undefined),
			),
	)
})

describe("proof-artifacts", () => {
	it("returns null when no artifact directory is configured or present", async () => {
		const cwd = await createTempDir()

		expect(resolveProofArtifactDir({ cwd, env: {} })).toBeNull()
	})

	it("prefers MEMONGO_PROOF_ARTIFACT_DIR when provided", async () => {
		const cwd = await createTempDir()
		const artifactDir = path.join(cwd, "custom-artifacts")

		expect(
			resolveProofArtifactDir({
				cwd,
				env: { MEMONGO_PROOF_ARTIFACT_DIR: artifactDir },
			}),
		).toBe(artifactDir)
	})

	it("uses the local workflow artifact directory when it exists", async () => {
		const cwd = await createTempDir()
		const defaultDir = getDefaultProofArtifactDir(cwd)
		await mkdir(defaultDir, { recursive: true })

		expect(resolveProofArtifactDir({ cwd, env: {} })).toBe(defaultDir)
	})

	it("writes a suite artifact as formatted json", async () => {
		const cwd = await createTempDir()
		const defaultDir = getDefaultProofArtifactDir(cwd)
		await mkdir(defaultDir, { recursive: true })

		const filePath = await writeProofArtifact({
			cwd,
			env: {},
			suite: "proof-pack",
			payload: {
				ok: true,
				summary: { passed: 4, failed: 0 },
			},
			now: new Date("2026-04-05T12:00:00.000Z"),
		})

		expect(filePath).toBe(
			path.join(defaultDir, "proof-pack", "2026-04-05T12-00-00-000Z.json"),
		)

		const saved = JSON.parse(await readFile(filePath!, "utf8")) as {
			ok?: boolean
			summary?: { passed?: number }
		}
		expect(saved.ok).toBe(true)
		expect(saved.summary?.passed).toBe(4)
	})
})
