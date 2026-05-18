import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

type WorktreeInfo = {
	path: string
	head: string | null
	branch: string | null
	dirtyFiles: number
}

type BranchInfo = {
	name: string
	classification: string
	mergeBase: string | null
	ahead: number | null
	behind: number | null
	diffStat: string | null
	worktreePath: string | null
	dirtyFiles: number | null
}

type ArtifactInfo = {
	path: string
	sizeBytes: number
	modifiedAt: string
}

function runGit(args: string[], cwd = process.cwd()): string | null {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
	if (result.status !== 0) return null
	return result.stdout.trim()
}

function parseWorktrees(raw: string): WorktreeInfo[] {
	const worktrees: WorktreeInfo[] = []
	let current: Partial<WorktreeInfo> = {}
	for (const line of raw.split("\n")) {
		if (!line.trim()) {
			if (current.path) {
				worktrees.push({
					path: current.path,
					head: current.head ?? null,
					branch: current.branch ?? null,
					dirtyFiles: 0,
				})
			}
			current = {}
			continue
		}
		const [key, ...rest] = line.split(" ")
		const value = rest.join(" ").trim()
		if (key === "worktree") current.path = value
		if (key === "HEAD") current.head = value
		if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "")
	}
	if (current.path) {
		worktrees.push({
			path: current.path,
			head: current.head ?? null,
			branch: current.branch ?? null,
			dirtyFiles: 0,
		})
	}
	return worktrees
}

function classifyBranch(name: string, truthBranch: string): string {
	if (name === truthBranch) return "truth"
	if (name === "codex/memory-world-class-replay") return "active-replay"
	if (name === "codex/mongodb-auto-embed-dogfood") return "source-only"
	if (name === "reproduce-98pct-april") return "forensic"
	if (name.startsWith("scope-")) return "reference-scope"
	if (name.startsWith("backup/")) return "archive"
	return "review"
}

function countDirtyFiles(worktreePath: string): number {
	const status = runGit(["status", "--short"], worktreePath)
	if (!status) return 0
	return status.split("\n").filter((line) => line.trim()).length
}

function collectArtifacts(root: string): ArtifactInfo[] {
	const names = new Set([
		"benchmark-response.json",
		"canary-artifact.json",
		"failure.json",
	])
	const roots = [
		path.join(root, "artifacts"),
		path.join(root, ".claude", "cc10x"),
	]
	const artifacts: ArtifactInfo[] = []
	const visit = (dir: string, depth: number) => {
		if (depth > 8 || !existsSync(dir)) return
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const filePath = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue
				visit(filePath, depth + 1)
				continue
			}
			if (!entry.isFile() || !names.has(entry.name)) continue
			const stat = statSync(filePath)
			artifacts.push({
				path: path.relative(root, filePath),
				sizeBytes: stat.size,
				modifiedAt: stat.mtime.toISOString(),
			})
		}
	}
	for (const artifactRoot of roots) visit(artifactRoot, 0)
	return artifacts.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

function collectBranches(root: string, truthBranch: string): BranchInfo[] {
	const branchRaw = runGit(
		["for-each-ref", "--format=%(refname:short)", "refs/heads"],
		root,
	)
	const branchNames = branchRaw
		? branchRaw
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
		: []
	const worktrees = parseWorktrees(
		runGit(["worktree", "list", "--porcelain"], root) ?? "",
	).map((worktree) => ({
		...worktree,
		dirtyFiles: countDirtyFiles(worktree.path),
	}))
	const worktreeByBranch = new Map(
		worktrees
			.filter((worktree) => worktree.branch)
			.map((worktree) => [worktree.branch as string, worktree]),
	)
	return branchNames.map((name) => {
		const mergeBase = runGit(["merge-base", truthBranch, name], root)
		const aheadBehind = mergeBase
			? runGit(
					["rev-list", "--left-right", "--count", `${truthBranch}...${name}`],
					root,
				)
			: null
		const [behind, ahead] = aheadBehind
			? aheadBehind.split(/\s+/).map((part) => Number.parseInt(part, 10))
			: [null, null]
		const worktree = worktreeByBranch.get(name)
		return {
			name,
			classification: classifyBranch(name, truthBranch),
			mergeBase,
			ahead: Number.isFinite(ahead) ? ahead : null,
			behind: Number.isFinite(behind) ? behind : null,
			diffStat: mergeBase
				? runGit(["diff", "--shortstat", `${truthBranch}...${name}`], root)
				: null,
			worktreePath: worktree?.path ?? null,
			dirtyFiles: worktree?.dirtyFiles ?? null,
		}
	})
}

function renderText(data: {
	root: string
	truthBranch: string
	branches: BranchInfo[]
	artifacts: ArtifactInfo[]
}): string {
	const lines = [
		`root: ${data.root}`,
		`truthBranch: ${data.truthBranch}`,
		"",
		"branches:",
	]
	for (const branch of data.branches) {
		const relation =
			branch.mergeBase === null
				? "no-merge-base"
				: `ahead=${branch.ahead ?? "?"} behind=${branch.behind ?? "?"}`
		lines.push(
			`- ${branch.name} [${branch.classification}] ${relation} dirty=${branch.dirtyFiles ?? "-"}${branch.worktreePath ? ` worktree=${branch.worktreePath}` : ""}`,
		)
		if (branch.diffStat) lines.push(`  diff: ${branch.diffStat}`)
	}
	lines.push("", "artifacts:")
	for (const artifact of data.artifacts.slice(0, 20)) {
		lines.push(
			`- ${artifact.path} ${artifact.sizeBytes} bytes ${artifact.modifiedAt}`,
		)
	}
	if (data.artifacts.length === 0) lines.push("- none found")
	return lines.join("\n")
}

const root = runGit(["rev-parse", "--show-toplevel"]) ?? process.cwd()
const truthBranch = process.env.MEMONGO_TRUTH_BRANCH?.trim() || "main"
const data = {
	root,
	truthBranch,
	branches: collectBranches(root, truthBranch),
	artifacts: collectArtifacts(root),
}

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(data, null, 2))
} else {
	console.log(renderText(data))
}
