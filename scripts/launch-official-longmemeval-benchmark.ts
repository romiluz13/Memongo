import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

type LaunchMode = "launcher" | "supervisor"

type LaunchRecord = {
	runId: string
	updatedAt: string
	mode: LaunchMode
	startedAt: string
	runtime: {
		command: string
		launcherScript: string
		workerScript: string
	}
	pids: {
		currentPid: number
		parentPid: number
		supervisorPid?: number
		workerPid?: number
	}
	session: {
		stdinTTY: boolean
		stdoutTTY: boolean
		stderrTTY: boolean
		detached: boolean
		workerDetached?: boolean
	}
	watchdog: {
		pollMs: number
		staleMs: number
	}
	mongodb: {
		collectionPrefix: string
		collectionPrefixSource: "explicit" | "derived"
	}
	paths: {
		runDir: string
		launch: string
		supervisorLog: string
		supervisorEvents: string
		workerLog: string
		status: string
		response: string
		error: string
		telemetry: string
		events: string
		apiLog: string
	}
}

const repoRoot = process.cwd()
const startedAt = new Date()
const runId =
	process.env.MEMONGO_BENCHMARK_RUN_ID?.trim() ||
	`${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
const collectionPrefixResolution = resolveBenchmarkCollectionPrefix({
	runId,
	explicitPrefix: process.env.MEMONGO_MONGODB_COLLECTION_PREFIX,
})
process.env.MEMONGO_MONGODB_COLLECTION_PREFIX =
	collectionPrefixResolution.collectionPrefix
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.homedir(), ".memongo", "workspace")
const artifactRoot =
	process.env.MEMONGO_BENCHMARK_RUN_DIR?.trim() ||
	path.join(
		repoRoot,
		".claude",
		"cc10x",
		"v10",
		"workflows",
		"memongo-memory-hardening",
		"artifacts",
		"benchmark-runs",
	)
const launcherScriptPath =
	process.argv[1] && path.isAbsolute(process.argv[1])
		? process.argv[1]
		: path.join(repoRoot, "scripts", "launch-official-longmemeval-benchmark.ts")
const workerScriptPath = path.join(
	repoRoot,
	"scripts",
	"run-official-longmemeval-benchmark.ts",
)
const runDir = path.join(artifactRoot, runId)
const launchPath = path.join(runDir, "launch.json")
const supervisorLogPath = path.join(runDir, "supervisor.log")
const supervisorEventsPath = path.join(runDir, "supervisor-events.jsonl")
const workerLogPath = path.join(runDir, "runner.log")
const statusPath = path.join(runDir, "status.json")
const responsePath = path.join(runDir, "benchmark-response.json")
const errorPath = path.join(runDir, "benchmark-error.json")
const telemetryPath = path.join(runDir, "telemetry.json")
const eventsPath = path.join(runDir, "run-events.jsonl")
const apiLogPath = path.join(runDir, "api.log")
const pollMs = Number(process.env.MEMONGO_BENCHMARK_WATCHDOG_POLL_MS ?? 5_000)
const staleMs = Number(
	process.env.MEMONGO_BENCHMARK_WATCHDOG_STALE_MS ?? 180_000,
)

function resolveMode(): LaunchMode {
	return process.env.MEMONGO_BENCHMARK_LAUNCH_MODE === "supervisor"
		? "supervisor"
		: "launcher"
}

function resolveBunCommand(): string {
	const explicit = process.env.MEMONGO_BUN_BIN?.trim()
	if (explicit) {
		return explicit
	}
	if (process.versions.bun) {
		return process.execPath
	}
	const pathCandidates = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.map((entry) => path.join(entry, "bun"))
	const fallbackCandidates = [
		path.join(os.homedir(), ".bun", "bin", "bun"),
		"/opt/homebrew/bin/bun",
		"/usr/local/bin/bun",
	]
	for (const candidate of [...pathCandidates, ...fallbackCandidates]) {
		if (existsSync(candidate)) {
			return candidate
		}
	}
	return "bun"
}

async function writeJsonAtomic(
	filePath: string,
	payload: unknown,
): Promise<void> {
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`
	try {
		await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
		await rename(tmpPath, filePath)
	} catch (err) {
		await rm(tmpPath, { force: true }).catch(() => {})
		throw err
	}
}

function writeJsonAtomicSync(filePath: string, payload: unknown): void {
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`
	try {
		writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
		renameSync(tmpPath, filePath)
	} catch (err) {
		rmSync(tmpPath, { force: true })
		throw err
	}
}

function createLaunchRecord(params: {
	mode: LaunchMode
	runtimeCommand: string
	supervisorPid?: number
	workerPid?: number
	detached: boolean
	workerDetached?: boolean
}): LaunchRecord {
	return {
		runId,
		updatedAt: new Date().toISOString(),
		mode: params.mode,
		startedAt: startedAt.toISOString(),
		runtime: {
			command: params.runtimeCommand,
			launcherScript: launcherScriptPath,
			workerScript: workerScriptPath,
		},
		pids: {
			currentPid: process.pid,
			parentPid: process.ppid,
			...(params.supervisorPid ? { supervisorPid: params.supervisorPid } : {}),
			...(params.workerPid ? { workerPid: params.workerPid } : {}),
		},
		session: {
			stdinTTY: Boolean(process.stdin.isTTY),
			stdoutTTY: Boolean(process.stdout.isTTY),
			stderrTTY: Boolean(process.stderr.isTTY),
			detached: params.detached,
			...(params.workerDetached !== undefined
				? { workerDetached: params.workerDetached }
				: {}),
		},
		watchdog: {
			pollMs,
			staleMs,
		},
		mongodb: {
			collectionPrefix: collectionPrefixResolution.collectionPrefix,
			collectionPrefixSource: collectionPrefixResolution.source,
		},
		paths: {
			runDir,
			launch: launchPath,
			supervisorLog: supervisorLogPath,
			supervisorEvents: supervisorEventsPath,
			workerLog: workerLogPath,
			status: statusPath,
			response: responsePath,
			error: errorPath,
			telemetry: telemetryPath,
			events: eventsPath,
			apiLog: apiLogPath,
		},
	}
}

function spawnLoggedProcess(params: {
	command: string
	args: string[]
	env: NodeJS.ProcessEnv
	logPath: string
	detached?: boolean
}): ChildProcess {
	const fd = openSync(params.logPath, "a")
	try {
		return spawn(params.command, params.args, {
			cwd: repoRoot,
			env: params.env,
			detached: params.detached ?? false,
			stdio: ["ignore", fd, fd],
		})
	} finally {
		closeSync(fd)
	}
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) {
		return false
	}
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function readUpdatedAt(filePath: string): Promise<number | null> {
	if (!existsSync(filePath)) {
		return null
	}
	try {
		const raw = await readFile(filePath, "utf8")
		const parsed = JSON.parse(raw) as { updatedAt?: unknown }
		if (typeof parsed.updatedAt === "string") {
			const ts = Date.parse(parsed.updatedAt)
			if (Number.isFinite(ts)) {
				return ts
			}
		}
	} catch {
		// Fall back to mtime when JSON is unreadable mid-write.
	}
	try {
		return (await stat(filePath)).mtimeMs
	} catch {
		return null
	}
}

async function readFileActivity(
	filePath: string,
): Promise<{ exists: boolean; size: number; mtimeMs: number }> {
	try {
		const fileStats = await stat(filePath)
		return { exists: true, size: fileStats.size, mtimeMs: fileStats.mtimeMs }
	} catch {
		return { exists: false, size: 0, mtimeMs: 0 }
	}
}

function recordSupervisorEventSync(
	type: string,
	message: string,
	details?: Record<string, unknown>,
): void {
	appendFileSync(
		supervisorEventsPath,
		`${JSON.stringify({
			at: new Date().toISOString(),
			type,
			message,
			...(details ? { details } : {}),
		})}\n`,
		"utf8",
	)
}

function readApiPidFromStatus(): number | undefined {
	if (!existsSync(statusPath)) {
		return undefined
	}
	try {
		const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as {
			apiPid?: unknown
		}
		return typeof parsed.apiPid === "number" ? parsed.apiPid : undefined
	} catch {
		return undefined
	}
}

function writeSupervisorFailureArtifact(params: {
	failureType: string
	error: string
	details?: Record<string, unknown>
}): void {
	if (existsSync(responsePath) || existsSync(errorPath)) {
		return
	}
	recordSupervisorEventSync(params.failureType, params.error, params.details)
	writeJsonAtomicSync(errorPath, {
		runId,
		failedAt: new Date().toISOString(),
		failureType: params.failureType,
		error: params.error,
		statusPath,
		apiLogPath,
		telemetryPath,
		eventsPath,
		...(params.details ? { details: params.details } : {}),
	})
}

function terminatePid(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid == null || !isProcessAlive(pid)) {
		return
	}
	try {
		process.kill(pid, signal)
	} catch {
		// Best effort only.
	}
}

async function runLauncher(): Promise<void> {
	await mkdir(runDir, { recursive: true })
	const runtimeCommand = resolveBunCommand()
	const supervisor = spawnLoggedProcess({
		command: runtimeCommand,
		args: [launcherScriptPath],
		env: {
			...process.env,
			MEMONGO_BENCHMARK_RUN_ID: runId,
			MEMONGO_BENCHMARK_RUN_DIR: artifactRoot,
			MEMONGO_BENCHMARK_LAUNCH_MODE: "supervisor",
			MEMONGO_MONGODB_COLLECTION_PREFIX:
				collectionPrefixResolution.collectionPrefix,
			MEMONGO_STRICT_SEARCH_INDEX_READY:
				process.env.MEMONGO_STRICT_SEARCH_INDEX_READY?.trim() || "1",
		},
		logPath: supervisorLogPath,
		detached: true,
	})
	supervisor.unref()
	await writeJsonAtomic(
		launchPath,
		createLaunchRecord({
			mode: "launcher",
			runtimeCommand,
			supervisorPid: supervisor.pid,
			detached: true,
		}),
	)
	const summary = {
		ok: true,
		runId,
		runDir,
		launchPath,
		supervisorPid: supervisor.pid,
		statusPath,
		responsePath,
		errorPath,
		workspaceDir,
		collectionPrefix: collectionPrefixResolution.collectionPrefix,
	}
	console.log(JSON.stringify(summary, null, 2))
	console.log("")
	console.log("=".repeat(72))
	console.log("  BENCHMARK LAUNCHED — safe to close this terminal")
	console.log("=".repeat(72))
	console.log("")
	console.log("  The benchmark is running in a fully detached process.")
	console.log(
		"  macOS sleep is prevented by caffeinate while the worker is alive.",
	)
	console.log("")
	console.log("  MONITOR:")
	console.log(`    Status     cat ${statusPath}`)
	console.log(`    Telemetry  cat ${telemetryPath}`)
	console.log(`    API log    tail -f ${apiLogPath}`)
	console.log(`    Events     tail -f ${eventsPath}`)
	console.log(`    Supervisor tail -f ${supervisorLogPath}`)
	console.log("")
	console.log("  CHECK IF RUNNING:")
	console.log(`    ps -p ${supervisor.pid} -o pid,ppid,state,etime,command`)
	console.log(`    cat ${statusPath} | grep phase`)
	console.log("")
	console.log("  COMPLETION:")
	console.log(`    Success -> ${responsePath}`)
	console.log(`    Failure -> ${errorPath}`)
	console.log("")
	console.log(`  Run ID:        ${runId}`)
	console.log(`  Mongo prefix:  ${collectionPrefixResolution.collectionPrefix}`)
	console.log(`  Supervisor PID: ${supervisor.pid}`)
	console.log("=".repeat(72))
}

async function runSupervisor(): Promise<void> {
	await mkdir(runDir, { recursive: true })
	const runtimeCommand = resolveBunCommand()
	const worker = spawnLoggedProcess({
		command: runtimeCommand,
		args: [workerScriptPath],
		env: {
			...process.env,
			MEMONGO_BENCHMARK_RUN_ID: runId,
			MEMONGO_BENCHMARK_RUN_DIR: artifactRoot,
			MEMONGO_BENCHMARK_SUPERVISED: "1",
			MEMONGO_MONGODB_COLLECTION_PREFIX:
				collectionPrefixResolution.collectionPrefix,
			MEMONGO_STRICT_SEARCH_INDEX_READY:
				process.env.MEMONGO_STRICT_SEARCH_INDEX_READY?.trim() || "1",
		},
		logPath: workerLogPath,
		detached: true,
	})
	await writeJsonAtomic(
		launchPath,
		createLaunchRecord({
			mode: "supervisor",
			runtimeCommand,
			supervisorPid: process.pid,
			workerPid: worker.pid,
			detached: true,
			workerDetached: true,
		}),
	)
	recordSupervisorEventSync(
		"supervisor-start",
		"Benchmark supervisor started",
		{
			supervisorPid: process.pid,
			workerPid: worker.pid,
		},
	)

	let shuttingDown = false
	let workerExitCode: number | null = null
	let workerSignal: NodeJS.Signals | null = null
	let workerExited = false
	let lastApiLogSize = 0

	worker.unref()

	worker.on("exit", (code, signal) => {
		workerExitCode = code
		workerSignal = signal
		workerExited = true
	})

	const shutdown = (failureType: string, message: string): never => {
		if (!shuttingDown) {
			shuttingDown = true
			writeSupervisorFailureArtifact({
				failureType,
				error: message,
				details: {
					supervisorPid: process.pid,
					workerPid: worker.pid,
					workerExitCode,
					workerSignal,
				},
			})
			recordSupervisorEventSync("supervisor-terminate-worker", message, {
				supervisorPid: process.pid,
				workerPid: worker.pid,
				failureType,
			})
			terminatePid(worker.pid, "SIGTERM")
			const apiPid = readApiPidFromStatus()
			terminatePid(apiPid, "SIGTERM")
		}
		process.exit(1)
	}

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			shutdown("supervisor-signal", `Supervisor received ${signal}`)
		})
	}

	while (true) {
		if (existsSync(responsePath) || existsSync(errorPath)) {
			break
		}
		if (workerExited || !isProcessAlive(worker.pid)) {
			writeSupervisorFailureArtifact({
				failureType: "supervisor-worker-exit",
				error: "Benchmark worker exited before writing a terminal artifact",
				details: {
					supervisorPid: process.pid,
					workerPid: worker.pid,
					workerExitCode,
					workerSignal,
				},
			})
			break
		}

		const [statusUpdatedAt, telemetryUpdatedAt] = await Promise.all([
			readUpdatedAt(statusPath),
			readUpdatedAt(telemetryPath),
		])
		const apiLogActivity = await readFileActivity(apiLogPath)
		const apiLogAdvanced = apiLogActivity.size > lastApiLogSize
		const apiLogRecentlyUpdated =
			apiLogActivity.exists && Date.now() - apiLogActivity.mtimeMs <= staleMs
		lastApiLogSize = apiLogActivity.size
		const freshestHeartbeat = Math.max(
			statusUpdatedAt ?? 0,
			telemetryUpdatedAt ?? 0,
		)
		const noHeartbeatYet =
			statusUpdatedAt === null &&
			telemetryUpdatedAt === null &&
			Date.now() - startedAt.getTime() > staleMs
		if (noHeartbeatYet) {
			if (apiLogAdvanced || apiLogRecentlyUpdated) {
				recordSupervisorEventSync(
					"supervisor-heartbeat-missing-api-active",
					"Benchmark heartbeat is missing, but API log is still active; continuing",
					{
						supervisorPid: process.pid,
						workerPid: worker.pid,
						staleMs,
						apiLogBytes: apiLogActivity.size,
						apiLogMtimeMs: apiLogActivity.mtimeMs,
						apiLogAdvanced,
					},
				)
				await sleep(pollMs)
				continue
			}
			writeSupervisorFailureArtifact({
				failureType: "supervisor-missing-heartbeat",
				error:
					"Benchmark worker never wrote a heartbeat before the watchdog deadline",
				details: {
					supervisorPid: process.pid,
					workerPid: worker.pid,
					staleMs,
				},
			})
			recordSupervisorEventSync(
				"supervisor-terminate-worker",
				"Terminating worker after missing heartbeat",
				{
					supervisorPid: process.pid,
					workerPid: worker.pid,
					apiLogBytes: apiLogActivity.size,
				},
			)
			terminatePid(worker.pid, "SIGTERM")
			const apiPid = readApiPidFromStatus()
			terminatePid(apiPid, "SIGTERM")
			break
		}
		if (freshestHeartbeat > 0 && Date.now() - freshestHeartbeat > staleMs) {
			if (apiLogAdvanced || apiLogRecentlyUpdated) {
				recordSupervisorEventSync(
					"supervisor-heartbeat-stale-api-active",
					"Benchmark heartbeat is stale, but API log is still active; continuing",
					{
						supervisorPid: process.pid,
						workerPid: worker.pid,
						staleMs,
						statusUpdatedAt,
						telemetryUpdatedAt,
						apiLogBytes: apiLogActivity.size,
						apiLogMtimeMs: apiLogActivity.mtimeMs,
						apiLogAdvanced,
					},
				)
				await sleep(pollMs)
				continue
			}
			writeSupervisorFailureArtifact({
				failureType: "supervisor-stale-heartbeat",
				error:
					"Benchmark worker heartbeat went stale before writing a terminal artifact",
				details: {
					supervisorPid: process.pid,
					workerPid: worker.pid,
					staleMs,
					statusUpdatedAt,
					telemetryUpdatedAt,
					apiLogBytes: apiLogActivity.size,
					apiLogMtimeMs: apiLogActivity.mtimeMs,
				},
			})
			recordSupervisorEventSync(
				"supervisor-terminate-worker",
				"Terminating worker after stale heartbeat",
				{
					supervisorPid: process.pid,
					workerPid: worker.pid,
					apiLogBytes: apiLogActivity.size,
				},
			)
			terminatePid(worker.pid, "SIGTERM")
			const apiPid = readApiPidFromStatus()
			terminatePid(apiPid, "SIGTERM")
			break
		}
		await sleep(pollMs)
	}

	if (existsSync(errorPath)) {
		recordSupervisorEventSync(
			"supervisor-terminal-error-cleanup",
			"Terminal error artifact exists; cleaning up child processes",
			{
				supervisorPid: process.pid,
				workerPid: worker.pid,
				apiPid: readApiPidFromStatus(),
			},
		)
		terminatePid(worker.pid, "SIGTERM")
		const apiPid = readApiPidFromStatus()
		terminatePid(apiPid, "SIGTERM")
		await sleep(1_000)
		terminatePid(worker.pid, "SIGKILL")
		terminatePid(apiPid, "SIGKILL")
	}
}

async function main(): Promise<void> {
	if (resolveMode() === "supervisor") {
		await runSupervisor()
		return
	}
	await runLauncher()
}

main().catch((err) => {
	writeSupervisorFailureArtifact({
		failureType: "launcher-catch",
		error: err instanceof Error ? err.stack || err.message : String(err),
		details: {
			launcherPid: process.pid,
		},
	})
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exitCode = 1
})
