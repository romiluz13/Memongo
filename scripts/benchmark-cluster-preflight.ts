import { MongoClient } from "mongodb"
import { validateBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

type ActiveOperation = {
	appName?: string
	collection?: string
	ns?: string
	op?: string
	secs_running?: number
}

type PreflightReport = {
	ok: boolean
	database: string
	prefix: string
	requireEmptyDb: boolean
	requiredEnv: string[]
	missingEnv: string[]
	keyFailures: string[]
	collections: {
		total: number
		nonSystem: number
		benchmark: number
		matchingPrefix: number
		names: string[]
		benchmarkNames: string[]
		matchingPrefixNames: string[]
	}
	activeOperations: ActiveOperation[]
	warnings: string[]
}

const DEFAULT_REQUIRED_ENV = [
	"MEMONGO_MONGODB_URI",
	"VOYAGE_API_KEY",
	"GROVE_API_KEY",
] as const

function readArg(name: string): string | undefined {
	return process.argv
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3)
		.trim()
}

function readDatabaseName(): string {
	return process.env.MEMONGO_DB_NAME?.trim() || "memongo"
}

function readPrefix(): string {
	const prefix =
		readArg("prefix") || process.env.MEMONGO_MONGODB_COLLECTION_PREFIX?.trim()
	if (!prefix) {
		throw new Error(
			"pass --prefix=memongo_bench_<lane>_<date>_<suffix>_ or set MEMONGO_MONGODB_COLLECTION_PREFIX",
		)
	}
	validateBenchmarkCollectionPrefix(prefix)
	return prefix
}

function readRequiredEnvNames(): string[] {
	const raw =
		readArg("required-env") ||
		process.env.MEMONGO_BENCHMARK_PREFLIGHT_REQUIRED_ENV?.trim()
	if (!raw) return [...DEFAULT_REQUIRED_ENV]
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean)
}

function isSystemCollection(name: string): boolean {
	return name.startsWith("system.")
}

function listMissingEnv(requiredEnv: string[]): string[] {
	return requiredEnv.filter((name) => !process.env[name]?.trim())
}

function listKeyFailures(): string[] {
	const failures: string[] = []
	const voyageKey = process.env.VOYAGE_API_KEY?.trim()
	if (voyageKey && !voyageKey.startsWith("al-")) {
		failures.push("VOYAGE_API_KEY must be a MongoDB Atlas model key (al-...)")
	}
	return failures
}

async function listActiveOperations(
	client: MongoClient,
	database: string,
): Promise<{ operations: ActiveOperation[]; warning?: string }> {
	try {
		const escapedDatabase = database.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const operations = (await client
			.db("admin")
			.aggregate([
				{ $currentOp: { allUsers: true, idleConnections: false } },
				{
					$project: {
						appName: "$clientMetadata.application.name",
						collection: "$command.collection",
						ns: 1,
						op: 1,
						secs_running: 1,
					},
				},
				{
					$match: {
						$or: [
							{ ns: { $regex: `^${escapedDatabase}\\.` } },
							{ appName: { $regex: "memongo|benchmark", $options: "i" } },
						],
					},
				},
				{ $limit: 50 },
			])
			.toArray()) as ActiveOperation[]
		return { operations }
	} catch (error) {
		return {
			operations: [],
			warning: `could not inspect active operations: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

function renderText(report: PreflightReport): string {
	const lines = [
		`benchmark:cluster-preflight ${report.ok ? "PASS" : "FAIL"}`,
		`db=${report.database}`,
		`prefix=${report.prefix}`,
		`requiredEnv=${report.requiredEnv.join(",")}`,
		`collections=${report.collections.total} nonSystem=${report.collections.nonSystem} benchmark=${report.collections.benchmark} matchingPrefix=${report.collections.matchingPrefix}`,
		`activeOperations=${report.activeOperations.length}`,
	]
	if (report.missingEnv.length > 0) {
		lines.push(`missingEnv=${report.missingEnv.join(",")}`)
	}
	for (const failure of report.keyFailures) {
		lines.push(`keyFailure=${failure}`)
	}
	if (report.collections.matchingPrefixNames.length > 0) {
		lines.push(
			`matchingPrefixNames=${report.collections.matchingPrefixNames.join(",")}`,
		)
	}
	if (report.collections.benchmarkNames.length > 0) {
		lines.push(
			`benchmarkNames=${report.collections.benchmarkNames.slice(0, 20).join(",")}`,
		)
	}
	for (const warning of report.warnings) {
		lines.push(`warning=${warning}`)
	}
	return lines.join("\n")
}

const database = readDatabaseName()
const prefix = readPrefix()
const requiredEnv = readRequiredEnvNames()
const missingEnv = listMissingEnv(requiredEnv)
const keyFailures = listKeyFailures()
const warnings: string[] = []
const requireEmptyDb = process.argv.includes("--require-empty-db")

let report: PreflightReport = {
	ok: false,
	database,
	prefix,
	requireEmptyDb,
	requiredEnv,
	missingEnv,
	keyFailures,
	collections: {
		total: 0,
		nonSystem: 0,
		benchmark: 0,
		matchingPrefix: 0,
		names: [],
		benchmarkNames: [],
		matchingPrefixNames: [],
	},
	activeOperations: [],
	warnings,
}

if (!process.env.MEMONGO_MONGODB_URI?.trim()) {
	report.warnings.push("MEMONGO_MONGODB_URI is required for publication runs")
} else {
	const client = new MongoClient(process.env.MEMONGO_MONGODB_URI.trim(), {
		appName: "memongo-benchmark-cluster-preflight-readonly",
		serverSelectionTimeoutMS: 10_000,
	})
	await client.connect()
	try {
		const db = client.db(database)
		const collections = await db
			.listCollections({}, { nameOnly: true })
			.toArray()
		const names = collections.map((collection) => collection.name).sort()
		const nonSystem = names.filter((name) => !isSystemCollection(name))
		const benchmarkNames = names.filter((name) =>
			name.startsWith("memongo_bench_"),
		)
		const matchingPrefixNames = names.filter((name) => name.startsWith(prefix))
		const active = await listActiveOperations(client, database)
		if (active.warning) warnings.push(active.warning)

		report = {
			...report,
			collections: {
				total: names.length,
				nonSystem: nonSystem.length,
				benchmark: benchmarkNames.length,
				matchingPrefix: matchingPrefixNames.length,
				names,
				benchmarkNames,
				matchingPrefixNames,
			},
			activeOperations: active.operations,
			warnings,
		}
	} finally {
		await client.close()
	}
}

report.ok =
	report.missingEnv.length === 0 &&
	report.keyFailures.length === 0 &&
	report.collections.matchingPrefix === 0 &&
	report.collections.benchmark === 0 &&
	(!report.requireEmptyDb || report.collections.nonSystem === 0)

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2))
} else {
	console.log(renderText(report))
}

if (!report.ok) {
	process.exitCode = 1
}
