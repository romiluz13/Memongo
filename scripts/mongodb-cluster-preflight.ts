import { MongoClient, type MongoClientOptions } from "mongodb"
import {
	MongoTargetRefusal,
	resolveConfiguredMongoDB,
} from "./mongodb-target.ts"

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
	verifyAtlasModelKey: boolean
	requiredEnv: string[]
	missingEnv: string[]
	keyFailures: string[]
	atlasModelKeyProbe?: {
		ok: boolean
		status?: number
		error?: string
	}
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
	"MEMONGO_LLM_BASE_URL",
	"MEMONGO_LLM_API_KEY",
	"MEMONGO_LLM_MODEL",
] as const

type PreflightClient = Pick<MongoClient, "connect" | "db" | "close">

export type PreflightDeps = {
	argv: string[]
	createClient: (uri: string, options: MongoClientOptions) => PreflightClient
	fetchFn: typeof fetch
	stdout: (text: string) => void
	stderr: (text: string) => void
}

function readArg(argv: string[], name: string): string | undefined {
	return argv
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3)
		.trim()
}

/**
 * The runner's database and prefix (resolveConfiguredMongoDB), refusing
 * operator inputs that would make preflight inspect a different namespace than
 * the run uses. Refusals name settings, never values.
 */
function resolveTarget(argv: string[]): {
	uri: string
	database: string
	prefix: string
} {
	const target = resolveConfiguredMongoDB()
	const prefixArg = readArg(argv, "prefix")
	if (prefixArg && prefixArg !== target.collectionPrefix) {
		throw new MongoTargetRefusal(
			"--prefix differs from the configured collection prefix (MEMONGO_MONGODB_COLLECTION_PREFIX or memory.mongodb.collectionPrefix). Remove --prefix or set MEMONGO_MONGODB_COLLECTION_PREFIX to that value, then rerun.",
		)
	}
	const legacyDatabase = process.env.MEMONGO_DB_NAME?.trim()
	if (legacyDatabase && legacyDatabase !== target.database) {
		throw new MongoTargetRefusal(
			"MEMONGO_DB_NAME is a legacy setting the benchmark runner ignores and differs from the configured database (MEMONGO_MONGODB_DATABASE or memory.mongodb.database). Unset MEMONGO_DB_NAME or set MEMONGO_MONGODB_DATABASE to the intended database, then rerun.",
		)
	}
	validateCollectionPrefix(target.collectionPrefix)
	return {
		uri: target.uri,
		database: target.database,
		prefix: target.collectionPrefix,
	}
}

function validateCollectionPrefix(prefix: string): void {
	if (!/^memongo_bench_[a-z0-9][a-z0-9_-]*_$/.test(prefix)) {
		throw new MongoTargetRefusal(
			"collection prefix must start with memongo_bench_, contain only lowercase letters, numbers, underscores, and hyphens, and end with _; set MEMONGO_MONGODB_COLLECTION_PREFIX (or memory.mongodb.collectionPrefix) to memongo_bench_<lane>_<date>_<suffix>_, then rerun.",
		)
	}
}

function hasArg(argv: string[], name: string): boolean {
	return argv.includes(`--${name}`)
}

function readBooleanEnv(name: string): boolean {
	return ["1", "true", "yes", "on"].includes(
		process.env[name]?.trim().toLowerCase() ?? "",
	)
}

function readRequiredEnvNames(argv: string[]): string[] {
	const raw =
		readArg(argv, "required-env") ||
		process.env.MEMONGO_CLUSTER_PREFLIGHT_REQUIRED_ENV?.trim() ||
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

async function verifyAtlasModelKey(fetchFn: typeof fetch): Promise<{
	ok: boolean
	status?: number
	error?: string
}> {
	const voyageKey = process.env.VOYAGE_API_KEY?.trim()
	if (!voyageKey) {
		return { ok: false, error: "VOYAGE_API_KEY is missing" }
	}

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 15_000)
	try {
		const response = await fetchFn("https://ai.mongodb.com/v1/embeddings", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${voyageKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				input: "Memongo MongoDB preflight probe",
				model: "voyage-4-lite",
				input_type: "document",
			}),
			signal: controller.signal,
		})
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				error: "MongoDB Atlas Embedding API rejected VOYAGE_API_KEY",
			}
		}
		return { ok: true, status: response.status }
	} catch (error) {
		return {
			ok: false,
			error: `MongoDB Atlas Embedding API probe failed: ${error instanceof Error ? error.message : String(error)}`,
		}
	} finally {
		clearTimeout(timeout)
	}
}

async function listActiveOperations(
	client: PreflightClient,
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
		`mongodb:cluster-preflight ${report.ok ? "PASS" : "FAIL"}`,
		`db=${report.database}`,
		`prefix=${report.prefix}`,
		`verifyAtlasModelKey=${report.verifyAtlasModelKey}`,
		`requiredEnv=${report.requiredEnv.join(",")}`,
		`collections=${report.collections.total} nonSystem=${report.collections.nonSystem} benchmark=${report.collections.benchmark} matchingPrefix=${report.collections.matchingPrefix}`,
		`activeOperations=${report.activeOperations.length}`,
	]
	if (report.atlasModelKeyProbe) {
		lines.push(
			`atlasModelKeyProbe=${report.atlasModelKeyProbe.ok ? "PASS" : "FAIL"}${
				report.atlasModelKeyProbe.status
					? ` status=${report.atlasModelKeyProbe.status}`
					: ""
			}`,
		)
		if (report.atlasModelKeyProbe.error) {
			lines.push(`atlasModelKeyProbeError=${report.atlasModelKeyProbe.error}`)
		}
	}
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

/**
 * Read-only inspection of the runner's configured target. Returns the exit
 * code; target refusals print to stderr and return 1 before any client or
 * fetch call.
 */
export async function main(deps: PreflightDeps): Promise<number> {
	let target: ReturnType<typeof resolveTarget>
	try {
		target = resolveTarget(deps.argv)
	} catch (error) {
		if (!(error instanceof MongoTargetRefusal)) throw error
		deps.stderr(`mongodb:cluster-preflight REFUSED\n${error.message}`)
		return 1
	}
	const { database, prefix } = target
	const requiredEnv = readRequiredEnvNames(deps.argv)
	const missingEnv = listMissingEnv(requiredEnv)
	const keyFailures = listKeyFailures()
	const warnings: string[] = []
	const requireEmptyDb = hasArg(deps.argv, "require-empty-db")
	const shouldVerifyAtlasModelKey =
		hasArg(deps.argv, "verify-atlas-model-key") ||
		readBooleanEnv("MEMONGO_CLUSTER_PREFLIGHT_VERIFY_ATLAS_MODEL_KEY") ||
		readBooleanEnv("MEMONGO_BENCHMARK_VERIFY_ATLAS_MODEL_KEY")

	const atlasModelKeyProbe = shouldVerifyAtlasModelKey
		? await verifyAtlasModelKey(deps.fetchFn)
		: undefined
	if (atlasModelKeyProbe && !atlasModelKeyProbe.ok) {
		keyFailures.push(
			`VOYAGE_API_KEY failed MongoDB Atlas Embedding API probe${
				atlasModelKeyProbe.status ? ` (HTTP ${atlasModelKeyProbe.status})` : ""
			}`,
		)
	}

	let report: PreflightReport = {
		ok: false,
		database,
		prefix,
		requireEmptyDb,
		verifyAtlasModelKey: shouldVerifyAtlasModelKey,
		requiredEnv,
		missingEnv,
		keyFailures,
		atlasModelKeyProbe,
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

	const client = deps.createClient(target.uri, {
		appName: "memongo-mongodb-cluster-preflight-readonly",
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

	report.ok =
		report.missingEnv.length === 0 &&
		report.keyFailures.length === 0 &&
		report.collections.matchingPrefix === 0 &&
		report.collections.benchmark === 0 &&
		(!report.requireEmptyDb || report.collections.nonSystem === 0)

	if (deps.argv.includes("--json")) {
		deps.stdout(JSON.stringify(report, null, 2))
	} else {
		deps.stdout(renderText(report))
	}

	return report.ok ? 0 : 1
}

if (import.meta.main) {
	process.exitCode = await main({
		argv: process.argv,
		createClient: (uri, options) => new MongoClient(uri, options),
		fetchFn: fetch,
		stdout: (text) => console.log(text),
		stderr: (text) => console.error(text),
	})
}
