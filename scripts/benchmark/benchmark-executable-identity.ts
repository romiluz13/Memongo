import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const BENCHMARK_REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
)

// Tracked executable inputs only: results, checkpoints, sidecars, tmp/ and
// untracked output can never move the digest. Working-tree bytes are read, so
// uncommitted edits to tracked files do.
const EXECUTABLE_PATHSPECS = [
	"packages",
	"apps",
	"scripts",
	"bun.lock",
	"package.json",
]

export type BenchmarkRuntimeVersions = { node: string; bun: string | null }

export type BenchmarkExecutableIdentity =
	| {
			status: "available"
			digest: string
			headCommit: string
			trackedFiles: number
			runtime: BenchmarkRuntimeVersions
	  }
	| {
			status: "unavailable"
			digest?: undefined
			reason: string
			runtime: BenchmarkRuntimeVersions
	  }

export function currentRuntimeVersions(): BenchmarkRuntimeVersions {
	return { node: process.version, bun: process.versions.bun ?? null }
}

async function git(repoRoot: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
		maxBuffer: 64 * 1024 * 1024,
	})
	return stdout
}

export async function computeExecutableDigest(
	repoRoot: string,
	runtime: BenchmarkRuntimeVersions = currentRuntimeVersions(),
): Promise<BenchmarkExecutableIdentity> {
	let headCommit: string
	let files: string[]
	try {
		headCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).trim()
		files = (
			await git(repoRoot, ["ls-files", "-z", "--", ...EXECUTABLE_PATHSPECS])
		)
			.split("\0")
			.filter((file) => file.length > 0)
			.toSorted()
	} catch {
		return {
			status: "unavailable",
			reason: "not a readable git work tree",
			runtime,
		}
	}
	const hash = createHash("sha256")
	hash.update(JSON.stringify({ headCommit, runtime }))
	for (const file of files) {
		let bytes: Buffer | null
		try {
			bytes = await readFile(path.join(repoRoot, file))
		} catch (error) {
			// A tracked file deleted from the working tree is itself a change;
			// any other read failure leaves executable bytes unknown.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return {
					status: "unavailable",
					reason: `tracked file ${file} is unreadable`,
					runtime,
				}
			}
			bytes = null
		}
		hash.update(`\0${file}\0`)
		hash.update(
			bytes === null
				? "deleted"
				: createHash("sha256").update(bytes).digest("hex"),
		)
	}
	return {
		status: "available",
		digest: hash.digest("hex"),
		headCommit,
		trackedFiles: files.length,
		runtime,
	}
}
