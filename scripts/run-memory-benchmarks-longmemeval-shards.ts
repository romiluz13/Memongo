import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"

type RunOptions = {
	datasetsDir: string
	outRoot: string
	competitorRepo: string
	startShard: number
	endShardExclusive?: number
	shardSize: number
	port: number
	dateSuffix: string
	localUri: string
	restartBetweenShards: boolean
}

type CommandResult = {
	label: string
	command: string[]
	cwd: string
	exitCode: number
	stdout: string
	stderr: string
	startedAt: string
	completedAt: string
}

type ShardValidation = {
	ok: boolean
	shardId: string
	runId: string
	prefix: string
	expectedCount: number
	predictionFiles: number
	ingestionLedgers: number
	emptyRetrievalIds: string[]
	failedIngestionIds: string[]
}

type ShardSummary = {
	shardId: string
	status: "passed" | "failed"
	runId: string
	prefix: string
	outDir: string
	datasetPath: string
	validation?: ShardValidation
	error?: string
	startedAt: string
	completedAt: string
}

type CampaignSummary = {
	label: string
	status: "passed" | "failed"
	startedAt: string
	completedAt: string
	options: RunOptions
	shards: ShardSummary[]
	disclosure: string
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

function parseArgs(): RunOptions {
	const datasetsDir = readArg("datasets-dir")
	const outRoot = readArg("out-root")
	if (!datasetsDir || !outRoot) {
		throw new Error(
			"usage: bun scripts/run-memory-benchmarks-longmemeval-shards.ts --datasets-dir=DIR --out-root=DIR [--start-shard=0] [--end-shard=20]",
		)
	}
	const restartRaw = readArg("restart-between-shards")
	return {
		datasetsDir: resolve(datasetsDir),
		outRoot: resolve(outRoot),
		competitorRepo: resolve(
			readArg("competitor-repo") ||
				"/Users/rom.iluz/Dev/memongo-competitors/memory-benchmarks",
		),
		startShard: readIntegerArg("start-shard", 0),
		endShardExclusive: readArg("end-shard")
			? readIntegerArg("end-shard", 0)
			: undefined,
		shardSize: readIntegerArg("shard-size", 25),
		port: readIntegerArg("port", 8898),
		dateSuffix: readArg("date-suffix") || "20260611a",
		localUri:
			readArg("local-uri") ||
			"mongodb://127.0.0.1:27018/?directConnection=true",
		restartBetweenShards: restartRaw !== "false" && restartRaw !== "0",
	}
}

function shardNumber(path: string): number {
	const match = basename(path).match(/shard-(\d+)\.json$/)
	if (!match) throw new Error(`cannot parse shard number from ${path}`)
	return Number(match[1])
}

function listShardDatasets(options: RunOptions): string[] {
	const all = readdirSync(options.datasetsDir)
		.filter((name) => /shard-\d+\.json$/.test(name))
		.map((name) => join(options.datasetsDir, name))
		.sort((left, right) => shardNumber(left) - shardNumber(right))
	const end = options.endShardExclusive ?? all.length
	return all.filter((path) => {
		const number = shardNumber(path)
		return number >= options.startShard && number < end
	})
}

async function runCommand(
	label: string,
	command: string[],
	options: {
		cwd: string
		env?: Record<string, string>
		logPath: string
		allowFailure?: boolean
	},
): Promise<CommandResult> {
	const startedAt = new Date().toISOString()
	const proc = Bun.spawn(command, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	const completedAt = new Date().toISOString()
	const result = {
		label,
		command,
		cwd: options.cwd,
		exitCode,
		stdout,
		stderr,
		startedAt,
		completedAt,
	}
	writeFileSync(options.logPath, renderCommandResult(result))
	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(`${label} failed with exit code ${exitCode}`)
	}
	return result
}

function renderCommandResult(result: CommandResult): string {
	return [
		`label=${result.label}`,
		`cwd=${result.cwd}`,
		`startedAt=${result.startedAt}`,
		`completedAt=${result.completedAt}`,
		`exitCode=${result.exitCode}`,
		`command=${result.command.join(" ")}`,
		"",
		"stdout:",
		result.stdout,
		"",
		"stderr:",
		result.stderr,
		"",
	].join("\n")
}

async function waitForContainerHealthy(): Promise<void> {
	for (let attempt = 0; attempt < 90; attempt += 1) {
		const proc = Bun.spawn(
			[
				"docker",
				"inspect",
				"memongo-benchmark-preview",
				"--format",
				"{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
			],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		])
		if (exitCode === 0 && stdout.includes("running healthy")) return
		await Bun.sleep(2_000)
	}
	throw new Error("memongo-benchmark-preview did not become healthy")
}

async function waitForCompatReady(port: number): Promise<void> {
	for (let attempt = 0; attempt < 90; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`)
			if (response.ok) return
		} catch {
			// Keep polling until the server is listening.
		}
		await Bun.sleep(1_000)
	}
	throw new Error(`mem0 compat server did not become ready on port ${port}`)
}

async function pipeToFile(stream: ReadableStream<Uint8Array>, path: string) {
	const text = await new Response(stream).text()
	writeFileSync(path, text)
}

function expectedCount(datasetPath: string): number {
	const parsed = JSON.parse(readFileSync(datasetPath, "utf8")) as unknown[]
	return parsed.length
}

function validateShard(
	shardId: string,
	runId: string,
	prefix: string,
	outDir: string,
	expected: number,
): ShardValidation {
	const predictedDir = join(outDir, `predicted_${runId}`)
	const names = readdirSync(predictedDir)
	const predictionNames = names.filter(
		(name) => name.endsWith(".json") && !name.startsWith("_ingestion_"),
	)
	const ledgerNames = names.filter(
		(name) => name.startsWith("_ingestion_") && name.endsWith(".json"),
	)
	const emptyRetrievalIds: string[] = []
	for (const name of predictionNames) {
		const data = JSON.parse(readFileSync(join(predictedDir, name), "utf8")) as {
			question_id?: string
			retrieval?: { search_results?: unknown[] }
		}
		if ((data.retrieval?.search_results?.length ?? 0) === 0) {
			emptyRetrievalIds.push(data.question_id || name.replace(/\.json$/, ""))
		}
	}
	const failedIngestionIds: string[] = []
	for (const name of ledgerNames) {
		const data = JSON.parse(readFileSync(join(predictedDir, name), "utf8")) as {
			question_id?: string
			total_pairs_failed?: number
		}
		if ((data.total_pairs_failed ?? 0) > 0) {
			failedIngestionIds.push(
				data.question_id ||
					name.replace(/^_ingestion_/, "").replace(/\.json$/, ""),
			)
		}
	}
	return {
		ok:
			predictionNames.length === expected &&
			ledgerNames.length === expected &&
			emptyRetrievalIds.length === 0 &&
			failedIngestionIds.length === 0,
		shardId,
		runId,
		prefix,
		expectedCount: expected,
		predictionFiles: predictionNames.length,
		ingestionLedgers: ledgerNames.length,
		emptyRetrievalIds,
		failedIngestionIds,
	}
}

function renderCampaignSummary(summary: CampaignSummary): string {
	const lines = [
		"# Sharded LongMemEval Local Preview Run",
		"",
		`Status: ${summary.status}`,
		`Started: ${summary.startedAt}`,
		`Completed: ${summary.completedAt}`,
		"",
		`Disclosure: ${summary.disclosure}`,
		"",
		"| Shard | Status | Predictions | Ledgers | Empty retrievals | Prefix |",
		"| --- | --- | ---: | ---: | ---: | --- |",
	]
	for (const shard of summary.shards) {
		lines.push(
			`| ${shard.shardId} | ${shard.status} | ${shard.validation?.predictionFiles ?? 0} | ${shard.validation?.ingestionLedgers ?? 0} | ${shard.validation?.emptyRetrievalIds.length ?? 0} | \`${shard.prefix}\` |`,
		)
	}
	return `${lines.join("\n")}\n`
}

async function runShard(
	options: RunOptions,
	datasetPath: string,
	index: number,
): Promise<ShardSummary> {
	const shardId = `shard-${String(index).padStart(2, "0")}`
	const startedAt = new Date().toISOString()
	const prefix = `memongo_bench_mem0_memorybenchmarks_lme500_${shardId.replace("-", "")}_${options.dateSuffix}_`
	const runId = `memongo-compat-lme500-${shardId}-local-preview-countfix-${options.dateSuffix}`
	const outDir = join(options.outRoot, shardId)
	const logsDir = join(outDir, "logs")
	mkdirSync(logsDir, { recursive: true })
	const env = {
		MEMONGO_MONGODB_URI: options.localUri,
		MEMONGO_MONGODB_COLLECTION_PREFIX: prefix,
		MEMONGO_MONGODB_DEPLOYMENT_PROFILE: "atlas-local-preview",
		MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE: "longmemeval",
		MEMONGO_MEM0_COMPAT_PORT: String(options.port),
		MEMONGO_MEM0_COMPAT_RERANKING_ENABLED: "false",
		MEMONGO_BENCHMARK_DERIVED_WORK_MODE: "disabled",
		MEMONGO_PREPARE_WAIT_MS: "180000",
		OPENAI_API_KEY:
			process.env.OPENAI_API_KEY?.trim() ||
			process.env.GROVE_API_KEY?.trim() ||
			"",
		OPENAI_BASE_URL:
			process.env.OPENAI_BASE_URL?.trim() ||
			process.env.GROVE_BASE_URL?.trim() ||
			"",
	}
	let server: Subprocess<"pipe", "pipe", "inherit"> | undefined
	try {
		if (options.restartBetweenShards) {
			await runCommand(
				"docker-start",
				["docker", "start", "memongo-benchmark-preview"],
				{
					cwd: process.cwd(),
					logPath: join(logsDir, "00-docker-start.log"),
					allowFailure: true,
				},
			)
			await waitForContainerHealthy()
		}
		await runCommand(
			"cluster-preflight",
			["bun", "run", "benchmark:cluster-preflight", "--", `--prefix=${prefix}`],
			{
				cwd: process.cwd(),
				env,
				logPath: join(logsDir, "01-cluster-preflight.log"),
			},
		)
		await runCommand("mongodb-prepare", ["bun", "run", "mongodb:prepare"], {
			cwd: process.cwd(),
			env,
			logPath: join(logsDir, "02-mongodb-prepare.log"),
		})

		server = Bun.spawn(["bun", "run", "benchmark:mem0-compat"], {
			cwd: process.cwd(),
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		})
		void pipeToFile(server.stdout, join(logsDir, "03-mem0-compat.stdout.log"))
		void pipeToFile(server.stderr, join(logsDir, "03-mem0-compat.stderr.log"))
		await waitForCompatReady(options.port)

		await runCommand(
			"memory-benchmarks-longmemeval",
			[
				".venv/bin/python",
				"-m",
				"benchmarks.longmemeval.run",
				"--project-name",
				runId,
				"--all-questions",
				"--dataset-path",
				datasetPath,
				"--top-k",
				"200",
				"--top-k-cutoffs",
				"10,50,200",
				"--predict-only",
				"--mem0-host",
				`http://127.0.0.1:${options.port}`,
				"--max-workers",
				"1",
				"--output-dir",
				outDir,
			],
			{
				cwd: options.competitorRepo,
				env,
				logPath: join(logsDir, "04-memory-benchmarks-longmemeval.log"),
			},
		)

		const validation = validateShard(
			shardId,
			runId,
			prefix,
			outDir,
			expectedCount(datasetPath),
		)
		writeFileSync(
			join(outDir, "shard-validation.json"),
			`${JSON.stringify(validation, null, 2)}\n`,
		)
		if (!validation.ok) {
			throw new Error(
				`validation failed: predictions=${validation.predictionFiles}/${validation.expectedCount} ledgers=${validation.ingestionLedgers}/${validation.expectedCount} empty=${validation.emptyRetrievalIds.join(",")}`,
			)
		}

		return {
			shardId,
			status: "passed",
			runId,
			prefix,
			outDir,
			datasetPath,
			validation,
			startedAt,
			completedAt: new Date().toISOString(),
		}
	} catch (error) {
		return {
			shardId,
			status: "failed",
			runId,
			prefix,
			outDir,
			datasetPath,
			error: error instanceof Error ? error.message : String(error),
			startedAt,
			completedAt: new Date().toISOString(),
		}
	} finally {
		if (server) {
			server.kill("SIGTERM")
			await Promise.race([server.exited, Bun.sleep(5_000)])
		}
		await runCommand(
			"drop-prefix-dry-run",
			[
				"bun",
				"run",
				"mongodb:drop-benchmark-prefix",
				"--",
				`--prefix=${prefix}`,
			],
			{
				cwd: process.cwd(),
				env,
				logPath: join(logsDir, "90-drop-prefix-dry-run.log"),
				allowFailure: true,
			},
		)
		await runCommand(
			"drop-prefix",
			[
				"bun",
				"run",
				"mongodb:drop-benchmark-prefix",
				"--",
				`--prefix=${prefix}`,
				"--yes",
			],
			{
				cwd: process.cwd(),
				env,
				logPath: join(logsDir, "91-drop-prefix.log"),
				allowFailure: true,
			},
		)
		await runCommand(
			"prefix-inventory",
			[
				"bun",
				"run",
				"mongodb:prefix-inventory",
				"--",
				"--include-search-indexes",
			],
			{
				cwd: process.cwd(),
				env,
				logPath: join(logsDir, "92-prefix-inventory.log"),
				allowFailure: true,
			},
		)
		if (options.restartBetweenShards) {
			await runCommand(
				"docker-stop",
				["docker", "stop", "memongo-benchmark-preview"],
				{
					cwd: process.cwd(),
					logPath: join(logsDir, "99-docker-stop.log"),
					allowFailure: true,
				},
			)
		}
	}
}

if (import.meta.main) {
	const options = parseArgs()
	mkdirSync(options.outRoot, { recursive: true })
	const startedAt = new Date().toISOString()
	const datasetPaths = listShardDatasets(options)
	const summaryPath = join(options.outRoot, "sharded-run-summary.json")
	const summary: CampaignSummary = existsSync(summaryPath)
		? (JSON.parse(readFileSync(summaryPath, "utf8")) as CampaignSummary)
		: {
				label: "mem0-longmemeval-full500-sharded-local-preview",
				status: "passed",
				startedAt,
				completedAt: startedAt,
				options,
				disclosure:
					"Atlas Local Preview sharded rehearsal. This is not a publication-grade single full-500 benchmark result; use it for local miss discovery and saved-artifact experiments with explicit infrastructure disclosure.",
				shards: [],
			}
	summary.status = "passed"
	summary.options = options
	const passedShardIds = new Set(
		summary.shards
			.filter((shard) => shard.status === "passed")
			.map((shard) => shard.shardId),
	)
	try {
		for (const datasetPath of datasetPaths) {
			const index = shardNumber(datasetPath)
			const shardId = `shard-${String(index).padStart(2, "0")}`
			if (passedShardIds.has(shardId)) {
				continue
			}
			const shard = await runShard(options, datasetPath, index)
			summary.shards = summary.shards.filter(
				(existing) => existing.shardId !== shard.shardId,
			)
			summary.shards.push(shard)
			summary.shards.sort((left, right) =>
				left.shardId.localeCompare(right.shardId),
			)
			summary.completedAt = new Date().toISOString()
			writeFileSync(
				join(options.outRoot, "sharded-run-summary.json"),
				`${JSON.stringify(summary, null, 2)}\n`,
			)
			writeFileSync(
				join(options.outRoot, "sharded-run-summary.md"),
				renderCampaignSummary(summary),
			)
			if (shard.status !== "passed") {
				summary.status = "failed"
				throw new Error(`${shard.shardId} failed: ${shard.error}`)
			}
		}
	} catch (error) {
		summary.status = "failed"
		summary.completedAt = new Date().toISOString()
		writeFileSync(
			join(options.outRoot, "sharded-run-summary.json"),
			`${JSON.stringify(summary, null, 2)}\n`,
		)
		writeFileSync(
			join(options.outRoot, "sharded-run-summary.md"),
			renderCampaignSummary(summary),
		)
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
	summary.completedAt = new Date().toISOString()
	writeFileSync(
		join(options.outRoot, "sharded-run-summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	)
	writeFileSync(
		join(options.outRoot, "sharded-run-summary.md"),
		renderCampaignSummary(summary),
	)
	console.log(renderCampaignSummary(summary))
}
