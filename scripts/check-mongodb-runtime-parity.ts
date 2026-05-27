import { MongoClient, type Db } from "mongodb"
import {
	detectCapabilities,
	getExpectedSearchIndexTargets,
	isSearchIndexQueryable,
	type SearchIndexDescription,
} from "../packages/memory-engine/src/mongodb-schema.ts"
import type { MemoryMongoDBDeploymentProfile } from "@memongo/lib"

type RuntimeInput = {
	name: string
	uri: string
	profile: MemoryMongoDBDeploymentProfile
}

type RuntimeReport = {
	name: string
	profile: MemoryMongoDBDeploymentProfile
	kind: "atlas-managed" | "atlas-local-preview" | "custom"
	database: string
	serverVersion: string | null
	capabilities: {
		vectorSearch: boolean
		textSearch: boolean
		scoreFusion: boolean
		rankFusion: boolean
	}
	expectedSearchTargets: number
	readySearchTargets: number
	missingSearchTargets: string[]
	notQueryableSearchTargets: string[]
	ok: boolean
	waitedMs?: number
	error?: string
}

type RuntimeParityWaitOptions = {
	waitMs: number
	pollMs: number
}

function classifyProfile(uri: string): MemoryMongoDBDeploymentProfile {
	if (uri.includes(".mongodb.net")) return "atlas-managed"
	return "atlas-local-preview"
}

function runtimeKind(
	profile: MemoryMongoDBDeploymentProfile,
): RuntimeReport["kind"] {
	if (profile === "atlas-managed") return "atlas-managed"
	if (profile === "atlas-local-preview") return "atlas-local-preview"
	return "custom"
}

function readRuntimeInputs(): RuntimeInput[] {
	const inputs: RuntimeInput[] = []
	const cloudUri = process.env.MEMONGO_CLOUD_MONGODB_URI?.trim()
	const localUri = process.env.MEMONGO_LOCAL_MONGODB_URI?.trim()
	const activeUri = process.env.MEMONGO_MONGODB_URI?.trim()

	if (cloudUri) {
		inputs.push({
			name: "cloud",
			uri: cloudUri,
			profile: "atlas-managed",
		})
	}
	if (localUri) {
		inputs.push({
			name: "local",
			uri: localUri,
			profile: "atlas-local-preview",
		})
	}
	if (inputs.length === 0 && activeUri) {
		inputs.push({
			name: "active",
			uri: activeUri,
			profile: classifyProfile(activeUri),
		})
	}
	return inputs
}

function readArgValue(name: string): string | undefined {
	const exactIndex = process.argv.indexOf(name)
	if (exactIndex >= 0) {
		return process.argv[exactIndex + 1]
	}
	const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`))
	return prefixed?.slice(name.length + 1)
}

function parseNonNegativeInteger(
	value: string | undefined,
	fallback: number,
	label: string,
): number {
	if (value === undefined || value.trim() === "") return fallback
	const parsed = Number(value.trim())
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${label} must be a non-negative integer, got ${value}`)
	}
	return parsed
}

function readWaitOptions(): RuntimeParityWaitOptions {
	return {
		waitMs: parseNonNegativeInteger(
			readArgValue("--wait-ms") ?? process.env.MEMONGO_PARITY_WAIT_MS,
			0,
			"--wait-ms/MEMONGO_PARITY_WAIT_MS",
		),
		pollMs: parseNonNegativeInteger(
			readArgValue("--poll-ms") ?? process.env.MEMONGO_PARITY_POLL_MS,
			5000,
			"--poll-ms/MEMONGO_PARITY_POLL_MS",
		),
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readServerVersion(db: Db): Promise<string | null> {
	try {
		const buildInfo = await db.admin().command({ buildInfo: 1 })
		const version = (buildInfo as { version?: unknown }).version
		return typeof version === "string" ? version : null
	} catch {
		return null
	}
}

async function listSearchIndexes(
	db: Db,
	collectionName: string,
): Promise<SearchIndexDescription[]> {
	try {
		const cursor = db.collection(collectionName).listSearchIndexes()
		const indexes = (await cursor.toArray()) as SearchIndexDescription[]
		return indexes
	} catch {
		return []
	}
}

async function inspectRuntime(input: RuntimeInput): Promise<RuntimeReport> {
	const database = process.env.MEMONGO_PARITY_DATABASE?.trim() || "memongo"
	const prefix =
		process.env.MEMONGO_PARITY_COLLECTION_PREFIX?.trim() || "memongo_default_"
	const client = new MongoClient(input.uri, {
		appName: "memongo-runtime-parity-check",
		serverSelectionTimeoutMS: 10_000,
	})
	try {
		await client.connect()
		const db = client.db(database)
		const serverVersion = await readServerVersion(db)
		const targets = getExpectedSearchIndexTargets(prefix, input.profile)
		const capabilities = await detectCapabilities(
			db,
			targets[0]?.collectionName,
		)
		const missingSearchTargets: string[] = []
		const notQueryableSearchTargets: string[] = []
		let readySearchTargets = 0

		for (const target of targets) {
			const indexes = await listSearchIndexes(db, target.collectionName)
			const byName = new Map(indexes.map((index) => [index.name, index]))
			for (const indexName of target.indexNames) {
				const index = byName.get(indexName)
				const label = `${target.collectionName}.${indexName}`
				if (!index) {
					missingSearchTargets.push(label)
					continue
				}
				if (!isSearchIndexQueryable(index)) {
					notQueryableSearchTargets.push(label)
					continue
				}
				readySearchTargets += 1
			}
		}

		const ok =
			capabilities.vectorSearch &&
			capabilities.textSearch &&
			targets.length > 0 &&
			missingSearchTargets.length === 0 &&
			notQueryableSearchTargets.length === 0

		return {
			name: input.name,
			profile: input.profile,
			kind: runtimeKind(input.profile),
			database,
			serverVersion,
			capabilities,
			expectedSearchTargets: targets.reduce(
				(total, target) => total + target.indexNames.length,
				0,
			),
			readySearchTargets,
			missingSearchTargets,
			notQueryableSearchTargets,
			ok,
		}
	} catch (err) {
		return {
			name: input.name,
			profile: input.profile,
			kind: runtimeKind(input.profile),
			database,
			serverVersion: null,
			capabilities: {
				vectorSearch: false,
				textSearch: false,
				scoreFusion: false,
				rankFusion: false,
			},
			expectedSearchTargets: 0,
			readySearchTargets: 0,
			missingSearchTargets: [],
			notQueryableSearchTargets: [],
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		}
	} finally {
		await client.close().catch(() => undefined)
	}
}

async function inspectRuntimeWithWait(
	input: RuntimeInput,
	options: RuntimeParityWaitOptions,
): Promise<RuntimeReport> {
	const startedAtMs = Date.now()
	let report = await inspectRuntime(input)
	while (!report.ok && Date.now() - startedAtMs < options.waitMs) {
		const waitedMs = Date.now() - startedAtMs
		const pending = [
			...report.missingSearchTargets,
			...report.notQueryableSearchTargets,
		]
		console.warn(
			`mongodb:parity waiting profile=${input.profile} waitedMs=${waitedMs} pending=${pending.length}`,
		)
		await sleep(Math.min(options.pollMs, options.waitMs - waitedMs))
		report = await inspectRuntime(input)
	}
	return {
		...report,
		...(options.waitMs > 0 ? { waitedMs: Date.now() - startedAtMs } : {}),
	}
}

function renderText(reports: RuntimeReport[]): string {
	if (reports.length === 0) {
		return [
			"mongodb:parity FAIL",
			"no runtimes configured",
			"set MEMONGO_CLOUD_MONGODB_URI, MEMONGO_LOCAL_MONGODB_URI, or MEMONGO_MONGODB_URI",
		].join("\n")
	}

	const lines = [
		`mongodb:parity ${reports.every((report) => report.ok) ? "PASS" : "FAIL"}`,
	]
	for (const report of reports) {
		lines.push(
			`- ${report.name} profile=${report.profile} db=${report.database} version=${report.serverVersion ?? "unknown"} ok=${report.ok}`,
		)
		if (typeof report.waitedMs === "number") {
			lines.push(`  waitedMs: ${report.waitedMs}`)
		}
		if (report.error) lines.push(`  error: ${report.error}`)
		lines.push(
			`  capabilities: vector=${report.capabilities.vectorSearch} search=${report.capabilities.textSearch} rankFusion=${report.capabilities.rankFusion} scoreFusion=${report.capabilities.scoreFusion}`,
		)
		lines.push(
			`  search indexes: ${report.readySearchTargets}/${report.expectedSearchTargets} ready`,
		)
		if (report.missingSearchTargets.length > 0) {
			lines.push(
				`  missing: ${report.missingSearchTargets.slice(0, 10).join(", ")}`,
			)
		}
		if (report.notQueryableSearchTargets.length > 0) {
			lines.push(
				`  not queryable: ${report.notQueryableSearchTargets.slice(0, 10).join(", ")}`,
			)
		}
	}
	return lines.join("\n")
}

const waitOptions = readWaitOptions()
const reports = await Promise.all(
	readRuntimeInputs().map((input) =>
		inspectRuntimeWithWait(input, waitOptions),
	),
)

if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ reports }, null, 2))
} else {
	console.log(renderText(reports))
}

process.exitCode =
	reports.length > 0 && reports.every((report) => report.ok) ? 0 : 1
