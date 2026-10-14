import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
	type BenchmarkSourceGraph,
	BuildTopologyError,
	inventorySourceGraph,
	repoRelative,
	requestsOf,
	type WorkspaceImport,
	walkSourceGraph,
} from "./benchmark-source-graph.js"

export {
	type BenchmarkSourceGraph,
	benchmarkWorkspaceImports,
} from "./benchmark-source-graph.js"

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
			/** Executable files or reached source differ from HEAD, or are untracked. */
			dirty: boolean
			runtime: BenchmarkRuntimeVersions
			build: BenchmarkWorkspaceBuild
			sourceGraph: BenchmarkSourceGraph
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
	let sourceGraph: BenchmarkSourceGraph
	try {
		const repoReal = await realpath(repoRoot)
		const graph = await walkSourceGraph(repoReal)
		build = await observeWorkspaceBuild(repoReal, graph.imports)
		sourceGraph = await inventorySourceGraph(repoReal, graph.files, (args) =>
			git(repoRoot, args),
		)
	} catch (error) {
		return {
			status: "unavailable",
			reason:
				error instanceof BuildTopologyError
					? error.message
					: "workspace build output or source graph is unreadable",
			runtime,
		}
	}
	for (const entry of build.packages)
		hash.update(`\0build\0${entry.path}\0${entry.name}\0${entry.digest}`)
	for (const entry of sourceGraph.files)
		hash.update(`\0source\0${entry.path}\0${entry.sha256}`)
	return {
		status: "available",
		digest: hash.digest("hex"),
		headCommit,
		trackedFiles: files.length,
		dirty: dirty || sourceGraph.files.some((entry) => entry.status !== "clean"),
		runtime,
		build,
		sourceGraph,
	}
}

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

function packageName(specifier: string): string {
	return specifier.split("/").slice(0, 2).join("/")
}

async function observeWorkspaceBuild(
	repoReal: string,
	imports: WorkspaceImport[],
): Promise<BenchmarkWorkspaceBuild> {
	const pending = [...imports]
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
