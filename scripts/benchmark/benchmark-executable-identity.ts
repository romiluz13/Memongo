import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
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

/**
 * Workspace packages the benchmark imports by name. They load from ignored
 * dist output (exports -> ./dist), which git never sees, so their build trees
 * and dependency closure are bound separately. A test keeps this list equal
 * to the specifiers the benchmark entry points import.
 */
export const BENCHMARK_BUILD_ROOTS = [
	"@memongo/memory-bridge",
	"@memongo/lib",
] as const

// Files whose imports resolve the roots; resolution walks node_modules up from
// the importer, so each importing directory is resolved separately.
const BENCHMARK_BUILD_IMPORTERS = [
	"scripts/run-benchmark.ts",
	"scripts/benchmark/mongodb-manager-benchmark.ts",
]

export type BenchmarkWorkspaceBuild = {
	/** Bytes present at admission; whether tracked source produced them is not checked. */
	relation: "not-verified"
	packages: Array<{
		name: string
		/** Repository-relative package directory actually resolved. */
		path: string
		files: number
		digest: string
	}>
}

export type BenchmarkExecutableIdentity =
	| {
			status: "available"
			digest: string
			headCommit: string
			trackedFiles: number
			/** Tracked executable files differ from HEAD or untracked ones exist. */
			dirty: boolean
			runtime: BenchmarkRuntimeVersions
			build: BenchmarkWorkspaceBuild
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

// Inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_* and similar
// variables redirect git away from repoRoot even with -C, so none reach it.
function isolatedGitEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	)
}

async function git(repoRoot: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
		env: isolatedGitEnv(),
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
	let dirty: boolean
	try {
		const topLevel = (
			await git(repoRoot, ["rev-parse", "--show-toplevel"])
		).trim()
		if ((await realpath(topLevel)) !== (await realpath(repoRoot))) {
			return {
				status: "unavailable",
				reason: "repository root is not the top of its git work tree",
				runtime,
			}
		}
		headCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).trim()
		files = (
			await git(repoRoot, ["ls-files", "-z", "--", ...EXECUTABLE_PATHSPECS])
		)
			.split("\0")
			.filter((file) => file.length > 0)
			.toSorted()
		dirty =
			(
				await git(repoRoot, [
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=all",
					"--",
					...EXECUTABLE_PATHSPECS,
				])
			).length > 0
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
	let build: BenchmarkWorkspaceBuild
	try {
		build = await observeWorkspaceBuild(repoRoot)
	} catch (error) {
		return {
			status: "unavailable",
			reason:
				error instanceof BuildTopologyError
					? error.message
					: "workspace build output is unreadable",
			runtime,
		}
	}
	for (const entry of build.packages)
		hash.update(`\0build\0${entry.path}\0${entry.name}\0${entry.digest}`)
	return {
		status: "available",
		digest: hash.digest("hex"),
		headCommit,
		trackedFiles: files.length,
		dirty,
		runtime,
		build,
	}
}

/** Unsupported or ambiguous build topology; messages carry no absolute paths. */
class BuildTopologyError extends Error {}

// Only these export conditions are modeled: resolving through createRequire
// (require/node/default) then matches the runtime's ESM resolution
// (import/bun/default) exactly. Anything else may resolve differently.
const MODELED_CONDITIONS = new Set(["types", "default"])

function exportTargets(value: unknown, specifier: string): string[] {
	if (typeof value === "string") return [value]
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new BuildTopologyError(`${specifier} has unsupported exports`)
	return Object.entries(value).flatMap(([key, target]) => {
		if (!key.startsWith(".") && !MODELED_CONDITIONS.has(key))
			throw new BuildTopologyError(
				`${specifier} uses export condition ${key}, which identity does not model`,
			)
		return key === "types" ? [] : exportTargets(target, specifier)
	})
}

type ResolvedPackage = {
	dir: string
	entry: string
	manifest: { name?: unknown; [key: string]: unknown }
	manifestBytes: Buffer
}

async function resolveWorkspacePackage(
	repoReal: string,
	importer: string,
	specifier: string,
): Promise<ResolvedPackage> {
	let entry: string
	try {
		entry = await realpath(createRequire(importer).resolve(specifier))
	} catch {
		throw new BuildTopologyError(
			`workspace package ${specifier} does not resolve`,
		)
	}
	for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
		const relative = path.relative(repoReal, dir)
		if (relative.startsWith("..") || path.isAbsolute(relative))
			throw new BuildTopologyError(
				`workspace package ${specifier} resolves outside the repository`,
			)
		let manifestBytes: Buffer
		try {
			manifestBytes = await readFile(path.join(dir, "package.json"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
		const manifest = JSON.parse(manifestBytes.toString("utf8"))
		if (manifest?.name !== specifier) continue
		const targets = manifest.exports
			? exportTargets(manifest.exports, specifier)
			: [manifest.main ?? "index.js"]
		const dist = path.join(dir, "dist")
		if (
			!targets.every((target) =>
				path.resolve(dir, String(target)).startsWith(`${dist}${path.sep}`),
			) ||
			!entry.startsWith(`${dist}${path.sep}`)
		)
			throw new BuildTopologyError(`${specifier} has an entry outside dist`)
		return { dir, entry, manifest, manifestBytes }
	}
}

// Every regular file under dist; links, special files and nested node_modules
// would load bytes or resolve packages this listing cannot vouch for.
async function hashBuildTree(
	dist: string,
	label: string,
	hash: ReturnType<typeof createHash>,
): Promise<number> {
	const stat = await lstat(dist).catch(() => null)
	if (!stat?.isDirectory())
		throw new BuildTopologyError(`${label} has no dist directory`)
	let files = 0
	const walk = async (dir: string): Promise<void> => {
		const entries = (await readdir(dir, { withFileTypes: true })).toSorted(
			(left, right) =>
				left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		)
		for (const entry of entries) {
			const full = path.join(dir, entry.name)
			const relative = path.relative(dist, full).split(path.sep).join("/")
			if (entry.isDirectory()) {
				if (entry.name === "node_modules")
					throw new BuildTopologyError(`${label} dist contains node_modules`)
				await walk(full)
			} else if (entry.isFile()) {
				hash.update(
					`\0${relative}\0${createHash("sha256")
						.update(await readFile(full))
						.digest("hex")}`,
				)
				files += 1
			} else {
				throw new BuildTopologyError(
					`${label} dist contains a link or special file`,
				)
			}
		}
	}
	await walk(dist)
	return files
}

async function observeWorkspaceBuild(
	repoRoot: string,
): Promise<BenchmarkWorkspaceBuild> {
	const repoReal = await realpath(repoRoot)
	const pending: Array<{ importer: string; specifier: string }> =
		BENCHMARK_BUILD_IMPORTERS.flatMap((importer) =>
			BENCHMARK_BUILD_ROOTS.map((specifier) => ({
				importer: path.join(repoReal, importer),
				specifier,
			})),
		)
	const packages = new Map<
		string,
		BenchmarkWorkspaceBuild["packages"][number]
	>()
	while (pending.length > 0) {
		const next = pending.shift()
		if (!next) break
		const resolved = await resolveWorkspacePackage(
			repoReal,
			next.importer,
			next.specifier,
		)
		const relativeDir = path
			.relative(repoReal, resolved.dir)
			.split(path.sep)
			.join("/")
		if (packages.has(relativeDir)) continue
		const hash = createHash("sha256").update(resolved.manifestBytes)
		const files = await hashBuildTree(
			path.join(resolved.dir, "dist"),
			next.specifier,
			hash,
		)
		packages.set(relativeDir, {
			name: next.specifier,
			path: relativeDir,
			files,
			digest: hash.digest("hex"),
		})
		for (const field of [
			"dependencies",
			"peerDependencies",
			"optionalDependencies",
		]) {
			const deps = resolved.manifest[field]
			if (deps === null || typeof deps !== "object") continue
			for (const dependency of Object.keys(deps))
				if (dependency.startsWith("@memongo/"))
					pending.push({ importer: resolved.entry, specifier: dependency })
		}
	}
	return {
		relation: "not-verified",
		packages: [...packages.values()].toSorted((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		),
	}
}
