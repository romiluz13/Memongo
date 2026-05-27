import { MongoClient, type Db } from "mongodb"
import {
	detectCapabilities,
	ensureCollections,
	ensureSearchIndexes,
	ensureStandardIndexes,
	getExpectedSearchIndexTargets,
	isSearchIndexQueryable,
	type SearchIndexDescription,
} from "../packages/memory-engine/src/mongodb-schema.ts"
import type { MemoryMongoDBDeploymentProfile } from "@memongo/lib"

type PrepareOptions = {
	uri: string
	database: string
	prefix: string
	profile: MemoryMongoDBDeploymentProfile
	waitMs: number
	pollMs: number
}

function readRequiredEnv(name: string): string {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`${name} is required`)
	return value
}

function readProfile(uri: string): MemoryMongoDBDeploymentProfile {
	const explicit = process.env.MEMONGO_MONGODB_DEPLOYMENT_PROFILE?.trim()
	if (explicit === "atlas-managed" || explicit === "atlas-local-preview") {
		return explicit
	}
	return uri.includes(".mongodb.net") ? "atlas-managed" : "atlas-local-preview"
}

function readPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name]?.trim()
	if (!raw) return fallback
	const parsed = Number(raw)
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer`)
	}
	return parsed
}

async function listSearchIndexes(
	db: Db,
	collectionName: string,
): Promise<SearchIndexDescription[]> {
	try {
		return (await db
			.collection(collectionName)
			.listSearchIndexes()
			.toArray()) as SearchIndexDescription[]
	} catch {
		return []
	}
}

async function countReadySearchIndexes(
	db: Db,
	prefix: string,
	profile: MemoryMongoDBDeploymentProfile,
): Promise<{ ready: number; expected: number; pending: string[] }> {
	const pending: string[] = []
	let ready = 0
	let expected = 0
	for (const target of getExpectedSearchIndexTargets(prefix, profile)) {
		const indexes = await listSearchIndexes(db, target.collectionName)
		const byName = new Map(indexes.map((index) => [index.name, index]))
		for (const indexName of target.indexNames) {
			expected += 1
			const index = byName.get(indexName)
			const label = `${target.collectionName}.${indexName}`
			if (!index || !isSearchIndexQueryable(index)) {
				pending.push(label)
				continue
			}
			ready += 1
		}
	}
	return { ready, expected, pending }
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSearchIndexes(db: Db, options: PrepareOptions) {
	const startedAt = Date.now()
	let status = await countReadySearchIndexes(
		db,
		options.prefix,
		options.profile,
	)
	while (status.pending.length > 0 && Date.now() - startedAt < options.waitMs) {
		const waitedMs = Date.now() - startedAt
		console.warn(
			`mongodb:prepare waiting waitedMs=${waitedMs} ready=${status.ready}/${status.expected} pending=${status.pending.length}`,
		)
		await sleep(Math.min(options.pollMs, options.waitMs - waitedMs))
		status = await countReadySearchIndexes(db, options.prefix, options.profile)
	}
	return {
		...status,
		waitedMs: Date.now() - startedAt,
	}
}

async function prepareRuntime(options: PrepareOptions) {
	const client = new MongoClient(options.uri, {
		appName: "memongo-runtime-prepare",
		serverSelectionTimeoutMS: 10_000,
	})
	await client.connect()
	try {
		const db = client.db(options.database)
		await ensureCollections(db, options.prefix)
		const standardIndexes = await ensureStandardIndexes(db, options.prefix)
		const searchCreateResult = await ensureSearchIndexes(
			db,
			options.prefix,
			options.profile,
			"automated",
			"none",
			1024,
		)
		const capabilities = await detectCapabilities(db, `${options.prefix}chunks`)
		const searchStatus = await waitForSearchIndexes(db, options)
		const ok =
			capabilities.vectorSearch &&
			capabilities.textSearch &&
			searchStatus.ready === searchStatus.expected &&
			searchStatus.expected > 0

		return {
			ok,
			database: options.database,
			prefix: options.prefix,
			profile: options.profile,
			capabilities,
			standardIndexes,
			searchCreateResult,
			searchIndexes: searchStatus,
		}
	} finally {
		await client.close()
	}
}

const uri =
	process.env.MEMONGO_MONGODB_URI?.trim() ||
	process.env.MEMONGO_CLOUD_MONGODB_URI?.trim() ||
	readRequiredEnv("MDB_MCP_CONNECTION_STRING")
const options: PrepareOptions = {
	uri,
	database: process.env.MEMONGO_DB_NAME?.trim() || "memongo",
	prefix: readRequiredEnv("MEMONGO_MONGODB_COLLECTION_PREFIX"),
	profile: readProfile(uri),
	waitMs: readPositiveInt("MEMONGO_PREPARE_WAIT_MS", 120_000),
	pollMs: readPositiveInt("MEMONGO_PREPARE_POLL_MS", 5_000),
}

const report = await prepareRuntime(options)
console.log(
	[
		`mongodb:prepare ${report.ok ? "PASS" : "FAIL"}`,
		`db=${report.database}`,
		`prefix=${report.prefix}`,
		`profile=${report.profile}`,
		`capabilities: vector=${report.capabilities.vectorSearch} search=${report.capabilities.textSearch} rankFusion=${report.capabilities.rankFusion} scoreFusion=${report.capabilities.scoreFusion}`,
		`standardIndexes=${report.standardIndexes}`,
		`searchCreateResult=${JSON.stringify(report.searchCreateResult)}`,
		`searchIndexes=${report.searchIndexes.ready}/${report.searchIndexes.expected} ready waitedMs=${report.searchIndexes.waitedMs}`,
	].join("\n"),
)
if (!report.ok) {
	console.log(`pending=${report.searchIndexes.pending.slice(0, 20).join(", ")}`)
	process.exitCode = 1
}
