import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import {
	ModuleSyntaxError,
	moduleRequests,
} from "./benchmark-module-requests.js"

// The benchmark process entry point. Its relative source graph is walked to
// find every file that imports a workspace package by name: those packages
// load from ignored dist output (exports -> ./dist), which git never sees, and
// each import resolves from its own file's directory.
const BENCHMARK_ENTRY = "scripts/run-benchmark.ts"

/** Unsupported or ambiguous build topology; messages carry no absolute paths. */
export class BuildTopologyError extends Error {}

export type WorkspaceImport = { importer: string; specifier: string }

export type BenchmarkSourceGraph = {
	/** Every source file the walk reached, whatever Git knows about it. */
	files: Array<{
		path: string
		sha256: string
		/** Against HEAD; anything but "clean" makes the run unpublishable. */
		status: "clean" | "modified" | "untracked"
	}>
}

export function requestsOf(
	file: string,
	text: string,
	label: string,
): string[] {
	try {
		return moduleRequests(file, text)
	} catch (error) {
		if (error instanceof ModuleSyntaxError)
			throw new BuildTopologyError(`${label} ${error.message}`)
		throw error
	}
}

export function repoRelative(repoReal: string, file: string): string {
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
	return (await walkSourceGraph(repoReal)).imports.map((entry) => ({
		importer: repoRelative(repoReal, entry.importer),
		specifier: entry.specifier,
	}))
}

export async function walkSourceGraph(
	repoReal: string,
): Promise<{ files: string[]; imports: WorkspaceImport[] }> {
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
		// A linked directory would put bytes from elsewhere under this path.
		if ((await realpath(file)) !== file)
			throw new BuildTopologyError(`${label} is reached through a link`)
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
	return { files: [...seen].toSorted(), imports }
}

/**
 * Bytes and Git status of every reached file. The tracked pathspec digest
 * misses untracked, ignored and out-of-pathspec source the benchmark still
 * loads, so each reached file is bound here by its own content.
 */
export async function inventorySourceGraph(
	repoReal: string,
	files: string[],
	git: (args: string[]) => Promise<string>,
): Promise<BenchmarkSourceGraph> {
	const relative = files.map((file) => repoRelative(repoReal, file))
	const pathspecs = relative.map((file) => `:(literal)${file}`)
	const tracked = new Set(
		(await git(["ls-files", "-z", "--", ...pathspecs])).split("\0"),
	)
	const changed = new Set(
		(await git(["status", "--porcelain=v1", "-z", "--", ...pathspecs]))
			.split("\0")
			.map((entry) => entry.slice(3)),
	)
	return {
		files: await Promise.all(
			relative.map(async (file) => ({
				path: file,
				sha256: createHash("sha256")
					.update(await readFile(path.join(repoReal, file)))
					.digest("hex"),
				status: !tracked.has(file)
					? ("untracked" as const)
					: changed.has(file)
						? ("modified" as const)
						: ("clean" as const),
			})),
		),
	}
}
