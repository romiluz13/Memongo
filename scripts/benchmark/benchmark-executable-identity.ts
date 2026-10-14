import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
	ModuleSyntaxError,
	moduleRequests,
} from "./benchmark-module-requests.js"

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

// The benchmark process entry point. Its relative source graph is walked to
// find every file that imports a workspace package by name: those packages
// load from ignored dist output (exports -> ./dist), which git never sees, and
// each import resolves from its own file's directory.
const BENCHMARK_ENTRY = "scripts/run-benchmark.ts"

export type BenchmarkWorkspaceBuild = {
	/** Bytes observed on disk at admission; whether tracked source produced them is not checked. */
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

// Only these export conditions are modeled; the runtime's ESM resolution
// (import/bun/default) selects default for them, while any other condition
// could select a different target.
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

function exportedTarget(
	manifest: ResolvedPackage["manifest"],
	subpath: string,
	specifier: string,
): unknown {
	const exports = manifest.exports
	if (exports === undefined)
		return subpath === "." ? (manifest.main ?? "index.js") : undefined
	const map =
		typeof exports === "string" ||
		!Object.keys(exports as object).some((key) => key.startsWith("."))
			? { ".": exports }
			: (exports as Record<string, unknown>)
	exportTargets(map, specifier)
	let target = map[subpath]
	while (target !== null && typeof target === "object")
		target = (target as Record<string, unknown>).default
	return target
}

// Resolution is modeled from fresh filesystem reads: a runtime's resolver
// caches lookups for the life of the process, so its answer alone could
// describe a node_modules layout that is no longer on disk.
async function resolveWorkspacePackage(
	repoReal: string,
	importer: string,
	specifier: string,
): Promise<ResolvedPackage> {
	const name = packageName(specifier)
	let linked: string | null = null
	for (let dir = path.dirname(importer); !linked; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name)
		if (await lstat(candidate).catch(() => null)) linked = candidate
		else if (dir === path.dirname(dir))
			throw new BuildTopologyError(
				`workspace package ${specifier} does not resolve`,
			)
	}
	const dir = await realpath(linked).catch(() => null)
	const relative = dir ? path.relative(repoReal, dir) : ".."
	if (!dir || relative.startsWith("..") || path.isAbsolute(relative))
		throw new BuildTopologyError(
			`workspace package ${specifier} resolves outside the repository`,
		)
	const manifestBytes = await readFile(path.join(dir, "package.json"))
	const manifest = JSON.parse(manifestBytes.toString("utf8"))
	if (manifest?.name !== name)
		throw new BuildTopologyError(
			`workspace package ${specifier} resolves to a differently named package`,
		)
	const target = exportedTarget(
		manifest,
		specifier === name ? "." : `.${specifier.slice(name.length)}`,
		specifier,
	)
	const dist = path.join(dir, "dist")
	const entry =
		typeof target === "string"
			? await realpath(path.resolve(dir, target)).catch(() => null)
			: null
	if (!entry)
		throw new BuildTopologyError(
			`workspace package ${specifier} does not resolve`,
		)
	const declared =
		manifest.exports === undefined
			? [manifest.main ?? "index.js"]
			: exportTargets(manifest.exports, specifier)
	if (
		!entry.startsWith(`${dist}${path.sep}`) ||
		!declared.every((declaredTarget) =>
			path
				.resolve(dir, String(declaredTarget))
				.startsWith(`${dist}${path.sep}`),
		)
	)
		throw new BuildTopologyError(`${specifier} has an entry outside dist`)
	// The modeled resolver ignores tsconfig paths and other Bun-only lookup, and
	// Bun may answer from its cache; under Bun the two must agree or the loaded
	// bytes are unknown.
	const bun = (
		globalThis as {
			Bun?: { resolveSync(specifier: string, from: string): string }
		}
	).Bun
	if (bun) {
		let runtimeEntry: string | null = null
		try {
			runtimeEntry = await realpath(
				bun.resolveSync(specifier, path.dirname(importer)),
			)
		} catch {}
		if (runtimeEntry !== entry)
			throw new BuildTopologyError(
				`workspace package ${specifier} resolves differently under the running runtime`,
			)
	}
	return { dir, entry, manifest, manifestBytes }
}

// Every regular file under dist; links, special files and nested node_modules
// would load bytes or resolve packages this listing cannot vouch for.
async function hashBuildTree(
	dist: string,
	label: string,
	hash: ReturnType<typeof createHash>,
	imports: WorkspaceImport[],
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
				const bytes = await readFile(full)
				hash.update(
					`\0${relative}\0${createHash("sha256").update(bytes).digest("hex")}`,
				)
				if (/\.[cm]?js$/.test(entry.name))
					for (const specifier of requestsOf(
						full,
						bytes.toString("utf8"),
						`${label} dist/${relative}`,
					))
						if (specifier.startsWith("@memongo/"))
							imports.push({ importer: full, specifier })
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

type WorkspaceImport = { importer: string; specifier: string }

function packageName(specifier: string): string {
	return specifier.split("/").slice(0, 2).join("/")
}

function requestsOf(file: string, text: string, label: string): string[] {
	try {
		return moduleRequests(file, text)
	} catch (error) {
		if (error instanceof ModuleSyntaxError)
			throw new BuildTopologyError(`${label} ${error.message}`)
		throw error
	}
}

function repoRelative(repoReal: string, file: string): string {
	return path.relative(repoReal, file).split(path.sep).join("/")
}

async function isFile(file: string): Promise<boolean> {
	return (await lstat(file).catch(() => null))?.isFile() ?? false
}

// TypeScript ESM style: "./x.js" names x.ts on disk.
async function resolveRelativeSource(
	from: string,
	specifier: string,
): Promise<string | null> {
	const base = path.resolve(path.dirname(from), specifier)
	for (const candidate of [
		base,
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.mjs$/, ".mts"),
		`${base}.ts`,
		path.join(base, "index.ts"),
	])
		if (await isFile(candidate)) return candidate
	return null
}

/**
 * Every workspace package import in the benchmark's source graph, from the
 * entry point through relative static and literal dynamic imports. An import
 * the walk cannot follow refuses identity rather than leave a gap.
 */
export async function benchmarkWorkspaceImports(
	repoRoot: string,
): Promise<WorkspaceImport[]> {
	const repoReal = await realpath(repoRoot)
	return (await walkSourceGraph(repoReal)).map((entry) => ({
		importer: repoRelative(repoReal, entry.importer),
		specifier: entry.specifier,
	}))
}

async function walkSourceGraph(repoReal: string): Promise<WorkspaceImport[]> {
	const entry = path.join(repoReal, BENCHMARK_ENTRY)
	if (!(await isFile(entry)))
		throw new BuildTopologyError(
			`benchmark entry ${BENCHMARK_ENTRY} is missing`,
		)
	const seen = new Set<string>()
	const queue = [entry]
	const imports: WorkspaceImport[] = []
	for (let file = queue.pop(); file; file = queue.pop()) {
		if (seen.has(file)) continue
		seen.add(file)
		const label = repoRelative(repoReal, file)
		const text = await readFile(file, "utf8")
		for (const specifier of requestsOf(file, text, label)) {
			if (specifier.startsWith("@memongo/")) {
				imports.push({ importer: file, specifier })
				continue
			}
			if (!specifier.startsWith(".")) continue
			const target = await resolveRelativeSource(file, specifier)
			const relative = target ? repoRelative(repoReal, target) : ".."
			if (
				!target ||
				relative.startsWith("..") ||
				relative
					.split("/")
					.some((part) => part === "node_modules" || part === "dist")
			)
				throw new BuildTopologyError(
					`${label} imports ${specifier}, which is not tracked-style source in the repository`,
				)
			queue.push(target)
		}
	}
	return imports
}

async function observeWorkspaceBuild(
	repoRoot: string,
): Promise<BenchmarkWorkspaceBuild> {
	const repoReal = await realpath(repoRoot)
	const pending = await walkSourceGraph(repoReal)
	const resolvedFrom = new Set<string>()
	const packages = new Map<
		string,
		BenchmarkWorkspaceBuild["packages"][number]
	>()
	for (let next = pending.pop(); next; next = pending.pop()) {
		// Resolution depends only on the importing directory.
		const key = `${path.dirname(next.importer)}\0${next.specifier}`
		if (resolvedFrom.has(key)) continue
		resolvedFrom.add(key)
		const resolved = await resolveWorkspacePackage(
			repoReal,
			next.importer,
			next.specifier,
		)
		const relativeDir = repoRelative(repoReal, resolved.dir)
		if (packages.has(relativeDir)) continue
		const hash = createHash("sha256").update(resolved.manifestBytes)
		const name = packageName(next.specifier)
		const files = await hashBuildTree(
			path.join(resolved.dir, "dist"),
			name,
			hash,
			pending,
		)
		packages.set(relativeDir, {
			name,
			path: relativeDir,
			files,
			digest: hash.digest("hex"),
		})
	}
	return {
		relation: "not-verified",
		packages: [...packages.values()].toSorted((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		),
	}
}
