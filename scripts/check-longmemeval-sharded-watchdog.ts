import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"

type ShardSummary = {
	shardId: string
	status: "passed" | "failed"
	completedAt: string
	validation?: {
		predictionFiles: number
		ingestionLedgers: number
		emptyRetrievalIds: string[]
		failedIngestionIds: string[]
	}
	error?: string
}

type CampaignSummary = {
	status: "passed" | "failed"
	completedAt: string
	shards: ShardSummary[]
}

type WatchdogStatus = {
	status: "on_track" | "complete" | "lost_track"
	reason: string
	tmuxSession: string
	outRoot: string
	expectedShards: number
	passedShards: number
	failedShards: string[]
	activeShard?: string
	activePredictionFiles?: number
	activeIngestionLedgers?: number
	latestActivityAt?: string
	latestActivityAgeMinutes?: number
	tmuxAlive: boolean
	docker: {
		available: boolean
		status?: string
		health?: string
		exitCode?: number
		oomKilled?: boolean
	}
}

function readArg(name: string): string | undefined {
	return process.argv
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3)
}

function readIntegerArg(name: string, fallback: number): number {
	const raw = readArg(name)
	if (!raw) return fallback
	const parsed = Number(raw)
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`--${name} must be a non-negative integer`)
	}
	return parsed
}

async function runText(command: string[]): Promise<{
	exitCode: number
	stdout: string
	stderr: string
}> {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { exitCode, stdout, stderr }
}

function readSummary(outRoot: string): CampaignSummary | undefined {
	const path = join(outRoot, "sharded-run-summary.json")
	if (!existsSync(path)) return undefined
	return JSON.parse(readFileSync(path, "utf8")) as CampaignSummary
}

function listFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return []
	const entries = readdirSync(dir, { withFileTypes: true })
	return entries.flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return listFilesRecursive(path)
		if (entry.isFile()) return [path]
		return []
	})
}

function latestMtime(paths: string[]): Date | undefined {
	let latest: Date | undefined
	for (const path of paths) {
		const mtime = statSync(path).mtime
		if (!latest || mtime > latest) latest = mtime
	}
	return latest
}

function countActiveFiles(
	outRoot: string,
	shardId: string,
): {
	predictions: number
	ledgers: number
	latest?: Date
} {
	const shardDir = join(outRoot, shardId)
	const files = listFilesRecursive(shardDir)
	const predictedDir = files.find((path) =>
		basename(path).startsWith("_ingestion_"),
	)
		? undefined
		: undefined
	const predictionFiles = files.filter(
		(path) =>
			path.includes("/predicted_") &&
			path.endsWith(".json") &&
			!basename(path).startsWith("_ingestion_"),
	)
	const ledgerFiles = files.filter(
		(path) =>
			path.includes("/predicted_") &&
			path.endsWith(".json") &&
			basename(path).startsWith("_ingestion_"),
	)
	void predictedDir
	return {
		predictions: predictionFiles.length,
		ledgers: ledgerFiles.length,
		latest: latestMtime(files),
	}
}

function nextShardId(
	summary: CampaignSummary | undefined,
	expectedShards: number,
) {
	const passed = new Set(
		summary?.shards
			.filter((shard) => shard.status === "passed")
			.map((shard) => shard.shardId) || [],
	)
	for (let index = 0; index < expectedShards; index += 1) {
		const shardId = `shard-${String(index).padStart(2, "0")}`
		if (!passed.has(shardId)) return shardId
	}
	return undefined
}

async function readDockerStatus(): Promise<WatchdogStatus["docker"]> {
	const result = await runText([
		"docker",
		"inspect",
		"memongo-benchmark-preview",
		"--format",
		"{{json .State}}",
	])
	if (result.exitCode !== 0) return { available: false }
	const state = JSON.parse(result.stdout.trim()) as {
		Status?: string
		ExitCode?: number
		OOMKilled?: boolean
		Health?: { Status?: string }
	}
	return {
		available: true,
		status: state.Status,
		health: state.Health?.Status,
		exitCode: state.ExitCode,
		oomKilled: state.OOMKilled,
	}
}

async function tmuxAlive(session: string): Promise<boolean> {
	const result = await runText(["tmux", "has-session", "-t", session])
	return result.exitCode === 0
}

function writeStatus(outRoot: string, status: WatchdogStatus) {
	writeFileSync(
		join(outRoot, "sharded-watchdog-status.json"),
		`${JSON.stringify(status, null, 2)}\n`,
	)
}

if (import.meta.main) {
	const outRoot = resolve(
		readArg("out-root") ||
			"artifacts/ecosystem-runs/mem0-memory-benchmarks-longmemeval-full500-predict-sharded-local-lmeprofile-countfix-20260611c",
	)
	const tmuxSession = readArg("tmux-session") || "memongo-lme-shards-20260611c"
	const expectedShards = readIntegerArg("expected-shards", 20)
	const staleMinutes = readIntegerArg("stale-minutes", 60)

	const summary = readSummary(outRoot)
	const passedShards =
		summary?.shards.filter((shard) => shard.status === "passed").length || 0
	const failedShards =
		summary?.shards
			.filter((shard) => shard.status === "failed")
			.map((shard) => shard.shardId) || []
	const activeShard = nextShardId(summary, expectedShards)
	const activeCounts = activeShard
		? countActiveFiles(outRoot, activeShard)
		: undefined
	const latestActivity =
		activeCounts?.latest ||
		(summary ? new Date(summary.completedAt) : undefined)
	const latestActivityAgeMinutes = latestActivity
		? Math.round((Date.now() - latestActivity.getTime()) / 60_000)
		: undefined
	const [tmuxIsAlive, docker] = await Promise.all([
		tmuxAlive(tmuxSession),
		readDockerStatus(),
	])

	let status: WatchdogStatus["status"] = "on_track"
	let reason = "campaign is running and recent activity is visible"
	if (passedShards >= expectedShards) {
		status = "complete"
		reason = "all expected shards passed"
	} else if (summary?.status === "failed" || failedShards.length > 0) {
		status = "lost_track"
		reason = `campaign summary reports failed shard(s): ${failedShards.join(", ")}`
	} else if (!tmuxIsAlive) {
		status = "lost_track"
		reason = "tmux campaign session is not alive before all shards passed"
	} else if (
		docker.available &&
		(docker.oomKilled ||
			docker.status !== "running" ||
			(docker.health && docker.health !== "healthy"))
	) {
		status = "lost_track"
		reason = `Atlas Local Preview container is unhealthy: status=${docker.status} health=${docker.health} oom=${docker.oomKilled}`
	} else if (
		latestActivityAgeMinutes !== undefined &&
		latestActivityAgeMinutes > staleMinutes
	) {
		status = "lost_track"
		reason = `no shard artifact activity for ${latestActivityAgeMinutes} minutes`
	}

	const watchdogStatus: WatchdogStatus = {
		status,
		reason,
		tmuxSession,
		outRoot,
		expectedShards,
		passedShards,
		failedShards,
		activeShard,
		activePredictionFiles: activeCounts?.predictions,
		activeIngestionLedgers: activeCounts?.ledgers,
		latestActivityAt: latestActivity?.toISOString(),
		latestActivityAgeMinutes,
		tmuxAlive: tmuxIsAlive,
		docker,
	}
	writeStatus(outRoot, watchdogStatus)
	console.log(JSON.stringify(watchdogStatus, null, 2))
	process.exit(status === "lost_track" ? 2 : 0)
}
