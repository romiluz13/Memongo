import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
	appendFileSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import {
	appendFile,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { resolveBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

type RunWarningCounters = {
	scoreFusionNoHits: number
	rankFusionNoHits: number
	rankFusionFailed: number
	hybridJsNoHits: number
	vectorNoHits: number
	keywordNoHits: number
	benchmarkEvaluationQueryFailed: number
	structuredMemoryTextFallbackFailed: number
	monitorTimeout: number
	invalidStringLength: number
	structuredPromotionFailed: number
	apiExitedUnexpectedly: number
}

type RunTelemetry = {
	runId: string
	updatedAt: string
	reason: string
	phase: string
	elapsedMs: number
	pids: {
		runnerPid: number
		parentPid: number
		apiPid?: number
		caffeinatePid?: number
	}
	artifacts: {
		hasResponse: boolean
		hasError: boolean
		apiLogBytes: number
	}
	lastError?: string
	apiLog: {
		offset: number
		lastLine?: string
		lastLineAt?: string
	}
	warnings: RunWarningCounters
	mongodb: {
		collectionPrefix: string
		collectionPrefixSource: "explicit" | "derived"
	}
}

type RunEvent = {
	at: string
	type: string
	phase: string
	message: string
	details?: Record<string, unknown>
}

type RunStatus = {
	runId: string
	phase: string
	startedAt: string
	updatedAt: string
	elapsedMs: number
	apiPid?: number
	caffeinatePid?: number
	dataset: {
		path: string
		name: string
		sha256: string
		kind?: string
		scenarios: number
		sessions: number
		turns: number
		abstentionCases: number
	}
	build: {
		commit: string
		id: string
		label: string
	}
	mongodb: {
		collectionPrefix: string
		collectionPrefixSource: "explicit" | "derived"
	}
	paths: {
		runDir: string
		apiLog: string
		status: string
		response: string
		error: string
		telemetry: string
		events: string
	}
	lastError?: string
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
const port = Number(process.env.MEMONGO_API_PORT?.trim() || "3847")
const baseUrl = `http://127.0.0.1:${port}`
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.homedir(), ".memongo", "workspace")
const datasetPathInput =
	process.env.MEMONGO_BENCHMARK_DATASET_PATH?.trim() ||
	path.join(workspaceDir, "benchmarks", "longmemeval_s_cleaned.json")
const datasetPath = path.isAbsolute(datasetPathInput)
	? datasetPathInput
	: path.resolve(repoRoot, datasetPathInput)
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
const runDir = path.join(artifactRoot, runId)
const apiLogPath = path.join(runDir, "api.log")
const statusPath = path.join(runDir, "status.json")
const responsePath = path.join(runDir, "benchmark-response.json")
const errorPath = path.join(runDir, "benchmark-error.json")
const telemetryPath = path.join(runDir, "telemetry.json")
const eventsPath = path.join(runDir, "run-events.jsonl")

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGTERM: 143,
}

const LOG_PATTERNS: Array<{
	key: keyof RunWarningCounters
	pattern: RegExp
}> = [
	{ key: "scoreFusionNoHits", pattern: /\$scoreFusion returned no hits/ },
	{ key: "rankFusionNoHits", pattern: /\$rankFusion returned no hits/ },
	{
		key: "rankFusionFailed",
		pattern: /\$rankFusion failed, trying separate queries \+ JS merge/,
	},
	{ key: "hybridJsNoHits", pattern: /hybrid JS merge returned no hits/ },
	{ key: "vectorNoHits", pattern: /vector search returned no hits/ },
	{
		key: "keywordNoHits",
		pattern: /keyword search returned no hits, trying \$text fallback/,
	},
	{
		key: "benchmarkEvaluationQueryFailed",
		pattern: /benchmark evaluation query failed/,
	},
	{
		key: "structuredMemoryTextFallbackFailed",
		pattern:
			/structured memory \$text search fallback failed; returning empty results/,
	},
	{
		key: "monitorTimeout",
		pattern: /connection <monitor> .* timed out/,
	},
	{ key: "invalidStringLength", pattern: /Invalid string length/ },
	{ key: "structuredPromotionFailed", pattern: /structured promotion failed/ },
	{ key: "apiExitedUnexpectedly", pattern: /API exited unexpectedly/ },
]

function createWarningCounters(): RunWarningCounters {
	return {
		scoreFusionNoHits: 0,
		rankFusionNoHits: 0,
		rankFusionFailed: 0,
		hybridJsNoHits: 0,
		vectorNoHits: 0,
		keywordNoHits: 0,
		benchmarkEvaluationQueryFailed: 0,
		structuredMemoryTextFallbackFailed: 0,
		monitorTimeout: 0,
		invalidStringLength: 0,
		structuredPromotionFailed: 0,
		apiExitedUnexpectedly: 0,
	}
}

function execText(command: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "ignore"],
		})
		let out = ""
		child.stdout?.setEncoding("utf8")
		child.stdout?.on("data", (chunk) => {
			out += chunk
		})
		child.on("error", () => resolve(""))
		child.on("close", (code) => resolve(code === 0 ? out.trim() : ""))
	})
}

function summarizeLongMemEvalDataset(raw: unknown): RunStatus["dataset"] {
	if (!Array.isArray(raw)) {
		throw new Error("LongMemEval dataset must be a JSON array")
	}
	let sessions = 0
	let turns = 0
	let abstentionCases = 0
	for (const entry of raw) {
		const record =
			entry && typeof entry === "object"
				? (entry as Record<string, unknown>)
				: {}
		const questionId =
			typeof record.question_id === "string" ? record.question_id : ""
		if (questionId.endsWith("_abs")) {
			abstentionCases++
		}
		const haystackSessions = Array.isArray(record.haystack_sessions)
			? record.haystack_sessions
			: []
		sessions += haystackSessions.length
		for (const session of haystackSessions) {
			if (Array.isArray(session)) {
				turns += session.length
			}
		}
	}
	return {
		path: datasetPath,
		name: path.basename(datasetPath),
		sha256: "",
		kind: "longmemeval",
		scenarios: raw.length,
		sessions,
		turns,
		abstentionCases,
	}
}

function summarizeLoCoMoDataset(raw: unknown): RunStatus["dataset"] | null {
	if (!Array.isArray(raw)) {
		return null
	}
	let sessions = 0
	let turns = 0
	let abstentionCases = 0
	for (const entry of raw) {
		const record =
			entry && typeof entry === "object"
				? (entry as Record<string, unknown>)
				: {}
		const sampleId =
			typeof record.sample_id === "string" ? record.sample_id.trim() : ""
		const conversation =
			record.conversation && typeof record.conversation === "object"
				? (record.conversation as Record<string, unknown>)
				: null
		const qa = Array.isArray(record.qa) ? record.qa : null
		if (!sampleId || !conversation || !qa) {
			return null
		}
		abstentionCases += qa.filter((item) => {
			const category =
				item && typeof item === "object"
					? (item as Record<string, unknown>).category
					: undefined
			return String(category) === "5"
		}).length
		for (let index = 1; ; index++) {
			const session = conversation[`session_${index}`]
			if (!Array.isArray(session)) {
				break
			}
			sessions++
			turns += session.length
		}
	}
	return {
		path: datasetPath,
		name: path.basename(datasetPath),
		sha256: "",
		kind: "locomo",
		scenarios: raw.length,
		sessions,
		turns,
		abstentionCases,
	}
}

function summarizeBenchmarkDataset(raw: unknown): RunStatus["dataset"] {
	const loCoMo = summarizeLoCoMoDataset(raw)
	if (loCoMo) {
		return loCoMo
	}
	return summarizeLongMemEvalDataset(raw)
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForApi(timeoutMs = 60_000): Promise<void> {
	const started = Date.now()
	let lastError = ""
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${baseUrl}/health`)
			if (res.ok) {
				return
			}
			lastError = `HTTP ${res.status}`
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
		}
		await sleep(1_000)
	}
	throw new Error(
		`API did not become healthy within ${timeoutMs}ms: ${lastError}`,
	)
}

function spawnCaffeinate(): ChildProcess | undefined {
	if (process.env.MEMONGO_BENCHMARK_DISABLE_CAFFEINATE === "1") {
		return undefined
	}
	const child = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], {
		stdio: "ignore",
	})
	child.on("error", (err) => {
		console.warn(`caffeinate unavailable: ${err.message}`)
	})
	return child
}

function resolveNodeCommand(): string {
	const explicit = process.env.MEMONGO_NODE_BIN?.trim()
	if (explicit) {
		return explicit
	}
	const pathCandidates = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.map((entry) => path.join(entry, "node"))
	const fallbackCandidates = [
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/usr/bin/node",
	]
	for (const candidate of [...pathCandidates, ...fallbackCandidates]) {
		if (existsSync(candidate)) {
			return candidate
		}
	}
	return "node"
}

function spawnApi(env: NodeJS.ProcessEnv, apiLogFd: number): ChildProcess {
	return spawn(
		resolveNodeCommand(),
		["--max-old-space-size=8192", "--import", "tsx", "apps/api/src/server.ts"],
		{
			cwd: repoRoot,
			env,
			stdio: ["ignore", apiLogFd, apiLogFd],
		},
	)
}

function safeJsonStringify(payload: unknown, pretty: boolean): string {
	if (pretty) {
		try {
			return JSON.stringify(payload, null, 2)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (!msg.includes("Invalid string length")) {
				throw err
			}
			// Pretty-printed JSON exceeded V8's ~512 MB limit; fall back to
			// minified output which is typically 2-3x smaller.
			console.warn(
				"writeJsonAtomic: pretty-print exceeded V8 string limit, falling back to minified JSON",
			)
		}
	}
	return JSON.stringify(payload)
}

async function writeJsonAtomic(
	filePath: string,
	payload: unknown,
): Promise<void> {
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`
	try {
		await writeFile(tmpPath, `${safeJsonStringify(payload, true)}\n`, "utf8")
		await rename(tmpPath, filePath)
	} catch (err) {
		await rm(tmpPath, { force: true }).catch(() => {})
		throw err
	}
}

function writeJsonAtomicSync(filePath: string, payload: unknown): void {
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`
	try {
		writeFileSync(tmpPath, `${safeJsonStringify(payload, true)}\n`, "utf8")
		renameSync(tmpPath, filePath)
	} catch (err) {
		rmSync(tmpPath, { force: true })
		throw err
	}
}

function postJsonNoTimeout(params: {
	url: string
	payload: unknown
}): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const target = new URL(params.url)
		const body = JSON.stringify(params.payload)
		const req = http.request(
			{
				hostname: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
				},
				timeout: 0,
			},
			(res) => {
				res.setEncoding("utf8")
				let responseBody = ""
				res.on("data", (chunk) => {
					responseBody += chunk
				})
				res.on("end", () => {
					resolve({ statusCode: res.statusCode ?? 0, body: responseBody })
				})
			},
		)
		req.setTimeout(0)
		req.on("error", reject)
		req.end(body)
	})
}

async function main(): Promise<void> {
	if (
		process.env.MEMONGO_BENCHMARK_SUPERVISED !== "1" &&
		process.env.MEMONGO_BENCHMARK_FOREGROUND !== "1"
	) {
		throw new Error(
			"run-official-longmemeval-benchmark.ts is now a worker entrypoint; use `bun run benchmark:longmemeval:s` or set MEMONGO_BENCHMARK_FOREGROUND=1 for intentional foreground runs",
		)
	}
	await mkdir(runDir, { recursive: true })
	if (!existsSync(datasetPath)) {
		throw new Error(`dataset not found: ${datasetPath}`)
	}

	const datasetText = await readFile(datasetPath, "utf8")
	const datasetSha = createHash("sha256").update(datasetText).digest("hex")
	const dataset = summarizeBenchmarkDataset(JSON.parse(datasetText))
	dataset.sha256 = datasetSha

	const commit =
		process.env.MEMONGO_BUILD_COMMIT?.trim() ||
		(await execText("git", ["rev-parse", "HEAD"])) ||
		"unknown"
	const buildId =
		process.env.MEMONGO_BUILD_ID?.trim() ||
		`local-${startedAt.toISOString().replace(/[:.]/g, "-")}`
	const buildLabel =
		process.env.MEMONGO_BUILD_LABEL?.trim() || "r5.1-longmemeval-s-durable"
	const agentId =
		process.env.MEMONGO_BENCHMARK_AGENT_ID?.trim() ||
		`benchmark-raw-longmemeval-s-${commit.slice(0, 8)}-${runId.slice(-8)}`

	let phase = "starting"
	let lastError: string | undefined
	let api: ChildProcess | undefined
	let apiLogOffset = 0
	let apiLogRemainder = ""
	let lastApiLine: string | undefined
	let lastApiLineAt: string | undefined
	let finalArtifactWritten = false
	let shutdownStarted = false
	let artifactWriteQueue: Promise<void> = Promise.resolve()
	const caffeinate = spawnCaffeinate()
	const warningCounts = createWarningCounters()
	const statusBase = {
		runId,
		startedAt: startedAt.toISOString(),
		dataset,
		build: { commit, id: buildId, label: buildLabel },
		mongodb: {
			collectionPrefix: collectionPrefixResolution.collectionPrefix,
			collectionPrefixSource: collectionPrefixResolution.source,
		},
		paths: {
			runDir,
			apiLog: apiLogPath,
			status: statusPath,
			response: responsePath,
			error: errorPath,
			telemetry: telemetryPath,
			events: eventsPath,
		},
	}
	const buildTelemetry = async (reason: string): Promise<RunTelemetry> => {
		const apiLogStats = existsSync(apiLogPath)
			? await stat(apiLogPath)
			: { size: 0 }
		return {
			runId,
			updatedAt: new Date().toISOString(),
			reason,
			phase,
			elapsedMs: Date.now() - startedAt.getTime(),
			pids: {
				runnerPid: process.pid,
				parentPid: process.ppid,
				...(api?.pid ? { apiPid: api.pid } : {}),
				...(caffeinate?.pid ? { caffeinatePid: caffeinate.pid } : {}),
			},
			artifacts: {
				hasResponse: existsSync(responsePath),
				hasError: existsSync(errorPath),
				apiLogBytes: apiLogStats.size,
			},
			...(lastError ? { lastError } : {}),
			apiLog: {
				offset: apiLogOffset,
				...(lastApiLine ? { lastLine: lastApiLine } : {}),
				...(lastApiLineAt ? { lastLineAt: lastApiLineAt } : {}),
			},
			warnings: { ...warningCounts },
			mongodb: {
				collectionPrefix: collectionPrefixResolution.collectionPrefix,
				collectionPrefixSource: collectionPrefixResolution.source,
			},
		}
	}
	const enqueueArtifactWrite = (task: () => Promise<void>): Promise<void> => {
		const next = artifactWriteQueue.then(task, task)
		artifactWriteQueue = next.catch(() => {})
		return next
	}
	const writeStatus = async () => {
		await enqueueArtifactWrite(async () => {
			const payload: RunStatus = {
				...statusBase,
				phase,
				updatedAt: new Date().toISOString(),
				elapsedMs: Date.now() - startedAt.getTime(),
				...(api?.pid ? { apiPid: api.pid } : {}),
				...(caffeinate?.pid ? { caffeinatePid: caffeinate.pid } : {}),
				...(lastError ? { lastError } : {}),
			}
			await writeJsonAtomic(statusPath, payload)
		})
	}
	const writeStatusSync = () => {
		const payload: RunStatus = {
			...statusBase,
			phase,
			updatedAt: new Date().toISOString(),
			elapsedMs: Date.now() - startedAt.getTime(),
			...(api?.pid ? { apiPid: api.pid } : {}),
			...(caffeinate?.pid ? { caffeinatePid: caffeinate.pid } : {}),
			...(lastError ? { lastError } : {}),
		}
		writeJsonAtomicSync(statusPath, payload)
	}
	const appendEventEntry = async (event: RunEvent) => {
		await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8")
	}
	const appendEventEntrySync = (event: RunEvent) => {
		appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8")
	}
	const recordEvent = async (
		type: string,
		message: string,
		details?: Record<string, unknown>,
	) => {
		await appendEventEntry({
			at: new Date().toISOString(),
			type,
			phase,
			message,
			...(details ? { details } : {}),
		})
	}
	const recordEventSync = (
		type: string,
		message: string,
		details?: Record<string, unknown>,
	) => {
		appendEventEntrySync({
			at: new Date().toISOString(),
			type,
			phase,
			message,
			...(details ? { details } : {}),
		})
	}
	const processLogLine = (line: string) => {
		if (!line) {
			return
		}
		lastApiLine = line
		const lineTime = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})/)
		if (lineTime?.[1]) {
			lastApiLineAt = lineTime[1]
		}
		for (const entry of LOG_PATTERNS) {
			if (entry.pattern.test(line)) {
				warningCounts[entry.key] += 1
			}
		}
	}
	const pollApiLog = async () => {
		if (!existsSync(apiLogPath)) {
			return
		}
		const apiLogStats = await stat(apiLogPath)
		if (apiLogStats.size <= apiLogOffset) {
			return
		}
		const chunkSize = apiLogStats.size - apiLogOffset
		const fd = await open(apiLogPath, "r")
		try {
			const buffer = Buffer.alloc(chunkSize)
			const { bytesRead } = await fd.read(buffer, 0, chunkSize, apiLogOffset)
			apiLogOffset = apiLogStats.size
			const chunk = `${apiLogRemainder}${buffer.toString("utf8", 0, bytesRead)}`
			const lines = chunk.split(/\r?\n/)
			apiLogRemainder = lines.pop() ?? ""
			for (const line of lines) {
				processLogLine(line)
			}
		} finally {
			await fd.close()
		}
	}
	const writeTelemetry = async (reason: string) => {
		await enqueueArtifactWrite(async () => {
			await pollApiLog()
			await writeJsonAtomic(telemetryPath, await buildTelemetry(reason))
		})
	}
	const writeTelemetrySync = (reason: string) => {
		try {
			if (existsSync(apiLogPath)) {
				const raw = readFileSync(apiLogPath, "utf8")
				const lines = raw.split(/\r?\n/)
				for (const line of lines) {
					processLogLine(line)
				}
				apiLogOffset = Buffer.byteLength(raw)
				apiLogRemainder = ""
			}
			writeJsonAtomicSync(telemetryPath, {
				runId,
				updatedAt: new Date().toISOString(),
				reason,
				phase,
				elapsedMs: Date.now() - startedAt.getTime(),
				pids: {
					runnerPid: process.pid,
					parentPid: process.ppid,
					...(api?.pid ? { apiPid: api.pid } : {}),
					...(caffeinate?.pid ? { caffeinatePid: caffeinate.pid } : {}),
				},
				artifacts: {
					hasResponse: existsSync(responsePath),
					hasError: existsSync(errorPath),
					apiLogBytes: existsSync(apiLogPath)
						? readFileSync(apiLogPath).byteLength
						: 0,
				},
				...(lastError ? { lastError } : {}),
				apiLog: {
					offset: apiLogOffset,
					...(lastApiLine ? { lastLine: lastApiLine } : {}),
					...(lastApiLineAt ? { lastLineAt: lastApiLineAt } : {}),
				},
				warnings: { ...warningCounts },
				mongodb: {
					collectionPrefix: collectionPrefixResolution.collectionPrefix,
					collectionPrefixSource: collectionPrefixResolution.source,
				},
			})
		} catch {
			// Best effort only during process teardown.
		}
	}
	const writeFailureArtifact = async (
		failureType: string,
		message: string,
		details?: Record<string, unknown>,
	) => {
		if (finalArtifactWritten) {
			return
		}
		finalArtifactWritten = true
		await enqueueArtifactWrite(async () => {
			await writeJsonAtomic(errorPath, {
				runId,
				failedAt: new Date().toISOString(),
				failureType,
				error: message,
				statusPath,
				apiLogPath,
				telemetryPath,
				eventsPath,
				...(details ? { details } : {}),
			})
		})
	}
	const writeFailureArtifactSync = (
		failureType: string,
		message: string,
		details?: Record<string, unknown>,
	) => {
		if (finalArtifactWritten) {
			return
		}
		finalArtifactWritten = true
		writeJsonAtomicSync(errorPath, {
			runId,
			failedAt: new Date().toISOString(),
			failureType,
			error: message,
			statusPath,
			apiLogPath,
			telemetryPath,
			eventsPath,
			...(details ? { details } : {}),
		})
	}
	const shutdown = async (params: {
		failureType: string
		reason: string
		exitCode: number
		signal?: NodeJS.Signals
	}) => {
		if (shutdownStarted) {
			return
		}
		shutdownStarted = true
		clearInterval(heartbeat)
		lastError = params.signal
			? `Runner received ${params.signal}`
			: params.reason
		phase = "failed"
		await recordEvent(params.failureType, params.reason, {
			exitCode: params.exitCode,
			...(params.signal ? { signal: params.signal } : {}),
		})
		await writeFailureArtifact(params.failureType, lastError, {
			exitCode: params.exitCode,
			...(params.signal ? { signal: params.signal } : {}),
		})
		await writeTelemetry("signal")
		await writeStatus()
		if (api && !api.killed) {
			api.kill("SIGTERM")
			await sleep(500)
			if (api.exitCode == null && api.signalCode == null) {
				api.kill("SIGKILL")
			}
		}
		caffeinate?.kill("SIGTERM")
		process.exit(params.exitCode)
	}
	const handleSignal = (signal: NodeJS.Signals) => {
		void shutdown({
			failureType: "runner-signal",
			reason: `Runner received ${signal}`,
			exitCode: SIGNAL_EXIT_CODES[signal] ?? 1,
			signal,
		})
	}
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, handleSignal)
	}
	process.on("unhandledRejection", (reason) => {
		lastError =
			reason instanceof Error ? reason.stack || reason.message : String(reason)
		void shutdown({
			failureType: "runner-unhandled-rejection",
			reason: `Unhandled rejection: ${lastError}`,
			exitCode: 1,
		})
	})
	process.on("uncaughtException", (err) => {
		lastError = err.stack || err.message
		void shutdown({
			failureType: "runner-uncaught-exception",
			reason: `Uncaught exception: ${lastError}`,
			exitCode: 1,
		})
	})
	process.on("exit", (code) => {
		if (
			phase !== "complete" &&
			phase !== "dry-run-complete" &&
			!existsSync(errorPath) &&
			!existsSync(responsePath)
		) {
			writeFailureArtifactSync(
				"process-exit",
				`Runner exited with code=${code}`,
				{
					exitCode: code,
				},
			)
		}
		recordEventSync("process-exit", `Runner exiting with code=${code}`, {
			exitCode: code,
		})
		writeTelemetrySync("process-exit")
		writeStatusSync()
	})
	const heartbeat = setInterval(() => {
		void (async () => {
			await writeTelemetry("heartbeat")
			await writeStatus()
		})().catch((err) => {
			console.warn(
				`status heartbeat failed: ${err instanceof Error ? err.message : err}`,
			)
		})
	}, 15_000)

	try {
		await recordEvent("runner-start", "Benchmark runner initialized", {
			runnerPid: process.pid,
			parentPid: process.ppid,
		})
		await writeTelemetry("initial")
		await writeStatus()
		if (process.env.MEMONGO_BENCHMARK_DRY_RUN === "1") {
			phase = "dry-run-complete"
			await writeJsonAtomic(responsePath, {
				ok: true,
				dryRun: true,
				runId,
				statusPath,
			})
			finalArtifactWritten = true
			await recordEvent("dry-run", "Dry run completed without starting API")
			await writeTelemetry("dry-run")
			await writeStatus()
			console.log(
				JSON.stringify(
					{
						ok: true,
						dryRun: true,
						runId,
						statusPath,
						responsePath,
					},
					null,
					2,
				),
			)
			return
		}
		const apiLog = openSync(apiLogPath, "a")
		const env = {
			...process.env,
			MEMONGO_MONGODB_URI:
				process.env.MEMONGO_MONGODB_URI?.trim() ||
				"mongodb://127.0.0.1:27017/memongo_benchmark_r51?directConnection=true",
			MEMONGO_API_HOST: "127.0.0.1",
			MEMONGO_API_PORT: String(port),
			MEMONGO_WORKSPACE_DIR: workspaceDir,
			MEMONGO_MONGODB_COLLECTION_PREFIX:
				collectionPrefixResolution.collectionPrefix,
			MEMONGO_BUILD_COMMIT: commit,
			MEMONGO_BUILD_ID: buildId,
			MEMONGO_BUILD_LABEL: buildLabel,
		}
		phase = "api-starting"
		await recordEvent("api-starting", "Launching benchmark API process")
		api = spawnApi(env, apiLog)
		api.on("exit", (code, signal) => {
			if (phase !== "stopping-api" && phase !== "complete") {
				lastError = `API exited unexpectedly: code=${code} signal=${signal}`
				void recordEvent("api-exit", lastError, { code, signal })
				void writeFailureArtifact("api-exit", lastError, { code, signal })
				void writeTelemetry("api-exit").catch((err) => {
					console.warn(
						`api-exit telemetry failed: ${
							err instanceof Error ? err.message : err
						}`,
					)
				})
			}
		})
		await writeTelemetry("api-starting")
		await writeStatus()
		await waitForApi()
		await recordEvent("api-ready", "Benchmark API reported healthy", {
			apiPid: api.pid,
		})

		phase = "benchmark-running"
		await recordEvent("benchmark-running", "Starting benchmark request", {
			agentId,
			maxResults: Number(process.env.MEMONGO_BENCHMARK_MAX_RESULTS ?? 50),
			collectionPrefix: collectionPrefixResolution.collectionPrefix,
		})
		await writeTelemetry("benchmark-start")
		await writeStatus()
		const response = await postJsonNoTimeout({
			url: `${baseUrl}/v1/admin/relevance/benchmark`,
			payload: {
				agentId,
				datasetPath,
				maxResults: Number(process.env.MEMONGO_BENCHMARK_MAX_RESULTS ?? 50),
				retrievalLane:
					process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE?.trim() || undefined,
			},
		})
		const text = response.body
		if (response.statusCode < 200 || response.statusCode >= 300) {
			throw new Error(`benchmark failed: HTTP ${response.statusCode} ${text}`)
		}
		const payload = JSON.parse(text) as unknown
		await writeJsonAtomic(responsePath, payload)
		finalArtifactWritten = true
		phase = "complete"
		await recordEvent("benchmark-complete", "Benchmark response captured")
		await writeTelemetry("complete")
		await writeStatus()
		console.log(
			JSON.stringify({ ok: true, runId, responsePath, statusPath }, null, 2),
		)
	} catch (err) {
		phase = "failed"
		lastError = err instanceof Error ? err.stack || err.message : String(err)
		await recordEvent("benchmark-failed", lastError)
		await writeFailureArtifact("runner-catch", lastError)
		await writeTelemetry("failed")
		await writeStatus()
		throw err
	} finally {
		clearInterval(heartbeat)
		if (api && process.env.MEMONGO_BENCHMARK_KEEP_API !== "1") {
			if (phase !== "complete" && phase !== "failed") {
				phase = "stopping-api"
			}
			await recordEvent("api-stopping", "Stopping benchmark API process", {
				apiPid: api.pid,
			})
			api.kill("SIGTERM")
			await sleep(1_000)
			if (api.exitCode == null && api.signalCode == null) {
				api.kill("SIGKILL")
			}
		}
		caffeinate?.kill("SIGTERM")
		await writeTelemetry("finally").catch(() => {})
		await writeStatus().catch(() => {})
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exitCode = 1
})
