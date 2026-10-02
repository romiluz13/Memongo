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
import { resolveMemoryBackendConfig } from "../packages/memory-engine/src/backend-config.ts"
import { buildMemongoConfig } from "../packages/memory-bridge/src/memory-config.ts"
import type {
	MemoryMongoDBDeploymentProfile,
	MemoryMongoDBEmbeddingMode,
} from "@memongo/lib"

export type PrepareOptions = {
	uri: string
	database: string
	prefix: string
	profile: MemoryMongoDBDeploymentProfile
	embeddingMode: MemoryMongoDBEmbeddingMode
	quantization: "none" | "scalar" | "binary"
	numDimensions: number
	memoryTtlDays: number
	episodesRetentionDays: number
	relevanceRetentionDays: number
	waitMs: number
	pollMs: number
}

// Legacy script-only aliases that used to select the preparation target. They
// are no longer consulted: the target resolves exactly the way the
// application's does (MEMONGO_FORCE_MONGODB_URI > MEMONGO_MONGODB_URI >
// memory.mongodb.* in the Memongo config file), so `mongodb:prepare` always
// prepares the configured application's database.
const LEGACY_TARGET_ENV_VARS = [
	"MEMONGO_CLOUD_MONGODB_URI",
	"MEMONGO_DB_NAME",
	"MDB_MCP_CONNECTION_STRING",
] as const

export function ignoredLegacyTargetEnvVars(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return LEGACY_TARGET_ENV_VARS.filter(
		(name) => (env[name]?.trim()?.length ?? 0) > 0,
	)
}

function readPositiveInt(
	name: string,
	fallback: number,
	env: NodeJS.ProcessEnv,
): number {
	const raw = env[name]?.trim()
	if (!raw) return fallback
	const parsed = Number(raw)
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer`)
	}
	return parsed
}

/**
 * Resolve the preparation target and schema options through the same
 * configuration path the application bootstrap uses (bridge buildMemongoConfig
 * -> engine resolveMemoryBackendConfig). An invalid explicitly selected or
 * malformed config file throws here, before any connection or mutation.
 */
export function resolvePrepareOptions(
	env: NodeJS.ProcessEnv = process.env,
): PrepareOptions {
	const cfg = buildMemongoConfig(env)
	// Preparation is not agent-scoped (P2.1 shared physical collections); the
	// resolver only requires the parameter.
	const mongo = resolveMemoryBackendConfig({
		cfg,
		agentId: "mongodb-prepare",
	}).mongodb
	if (!mongo) {
		throw new Error("MongoDB backend resolution returned no mongodb config")
	}
	return {
		uri: mongo.uri,
		database: mongo.database,
		prefix: mongo.collectionPrefix,
		profile: mongo.deploymentProfile,
		embeddingMode: mongo.embeddingMode,
		quantization: mongo.quantization,
		numDimensions: mongo.numDimensions,
		memoryTtlDays: mongo.memoryTtlDays,
		episodesRetentionDays: mongo.episodesRetentionDays,
		relevanceRetentionDays: mongo.relevance.retention.days,
		waitMs: readPositiveInt("MEMONGO_PREPARE_WAIT_MS", 120_000, env),
		pollMs: readPositiveInt("MEMONGO_PREPARE_POLL_MS", 5_000, env),
	}
}

/**
 * True when argv (default: process arguments after the interpreter and
 * script path) contains the exact `--schema-only` token, selecting the
 * collection + standard-index-only preparation mode.
 */
export function resolveSchemaOnlyFlag(
	argv: string[] = process.argv.slice(2),
): boolean {
	return argv.includes("--schema-only")
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

export async function prepareRuntime(options: PrepareOptions) {
	const client = new MongoClient(options.uri, {
		appName: "memongo-runtime-prepare",
		serverSelectionTimeoutMS: 10_000,
	})
	await client.connect()
	try {
		const db = client.db(options.database)
		await ensureCollections(db, options.prefix)
		// Configured retention is passed through so preparation preserves the
		// application's TTL policies; textFallbackIndexes stays at its default
		// (true) — preparation targets a standalone runtime where the BSON
		// $text fallback is the safe choice, unlike the manager's
		// capability-derived skip (mongodb-manager.ts:788-796).
		const standardIndexes = await ensureStandardIndexes(db, options.prefix, {
			memoryTtlDays: options.memoryTtlDays,
			episodesRetentionDays: options.episodesRetentionDays,
			relevanceRetentionDays: options.relevanceRetentionDays,
		})
		const searchCreateResult = await ensureSearchIndexes(
			db,
			options.prefix,
			options.profile,
			options.embeddingMode,
			options.quantization,
			options.numDimensions,
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

export type SchemaOnlyReport = {
	database: string
	prefix: string
	standardIndexes: number
	retention: {
		memoryTtlDays: number
		episodesRetentionDays: number
		relevanceRetentionDays: number
	}
}

/**
 * Schema-only preparation on an open db handle: collections + standard
 * indexes with the configured retention, nothing else. No Search index
 * creation, capability detection, or readiness polling anywhere in the
 * path — those remain exclusive to full preparation.
 */
export async function runSchemaOnly(
	db: Db,
	options: PrepareOptions,
): Promise<SchemaOnlyReport> {
	await ensureCollections(db, options.prefix)
	// Identical retention pass-through to full mode (prepareRuntime): the
	// same three configured fields, so retention converges the same way in
	// both modes. textFallbackIndexes stays at its default (true) for the
	// same reason as full mode.
	const standardIndexes = await ensureStandardIndexes(db, options.prefix, {
		memoryTtlDays: options.memoryTtlDays,
		episodesRetentionDays: options.episodesRetentionDays,
		relevanceRetentionDays: options.relevanceRetentionDays,
	})
	return {
		database: options.database,
		prefix: options.prefix,
		standardIndexes,
		retention: {
			memoryTtlDays: options.memoryTtlDays,
			episodesRetentionDays: options.episodesRetentionDays,
			relevanceRetentionDays: options.relevanceRetentionDays,
		},
	}
}

/**
 * Connect with the same client options as prepareRuntime, run the
 * schema-only pass, and always close the client. Errors propagate
 * (nonzero exit) exactly like full mode.
 */
export async function prepareSchemaOnly(
	options: PrepareOptions,
): Promise<SchemaOnlyReport> {
	const client = new MongoClient(options.uri, {
		appName: "memongo-runtime-prepare",
		serverSelectionTimeoutMS: 10_000,
	})
	await client.connect()
	try {
		return await runSchemaOnly(client.db(options.database), options)
	} finally {
		await client.close()
	}
}

/**
 * Receipt for schema-only preparation: PASS plus the resolved target,
 * retention, and applied standard-index count. Never includes the URI.
 */
export function schemaOnlyReceiptLines(report: SchemaOnlyReport): string[] {
	return [
		"mongodb:prepare-schema PASS",
		`db=${report.database}`,
		`prefix=${report.prefix}`,
		`retention: memory=${report.retention.memoryTtlDays}d episodes=${report.retention.episodesRetentionDays}d relevance=${report.retention.relevanceRetentionDays}d`,
		`standardIndexes=${report.standardIndexes}`,
	]
}

if (import.meta.main) {
	const ignored = ignoredLegacyTargetEnvVars()
	if (ignored.length > 0) {
		console.warn(
			`mongodb:prepare note: ${ignored.join(", ")} no longer select the preparation target; ` +
				"uri/database/prefix and retention resolve via application configuration " +
				"(MEMONGO_FORCE_MONGODB_URI > MEMONGO_MONGODB_URI > memory.mongodb.* in the Memongo config file).",
		)
	}
	const options = resolvePrepareOptions()
	if (resolveSchemaOnlyFlag()) {
		// Schema-only mode: collections + standard indexes with the
		// configured retention; no Search creation, capability detection,
		// or readiness polling. Errors propagate (nonzero exit) exactly
		// like full mode; success always prints the PASS receipt.
		const report = await prepareSchemaOnly(options)
		console.log(schemaOnlyReceiptLines(report).join("\n"))
	} else {
		const report = await prepareRuntime(options)
		console.log(
			[
				`mongodb:prepare ${report.ok ? "PASS" : "FAIL"}`,
				`db=${report.database}`,
				`prefix=${report.prefix}`,
				`profile=${report.profile}`,
				`retention: memory=${options.memoryTtlDays}d episodes=${options.episodesRetentionDays}d relevance=${options.relevanceRetentionDays}d`,
				`capabilities: vector=${report.capabilities.vectorSearch} search=${report.capabilities.textSearch} rankFusion=${report.capabilities.rankFusion} scoreFusion=${report.capabilities.scoreFusion}`,
				`standardIndexes=${report.standardIndexes}`,
				`searchCreateResult=${JSON.stringify(report.searchCreateResult)}`,
				`searchIndexes=${report.searchIndexes.ready}/${report.searchIndexes.expected} ready waitedMs=${report.searchIndexes.waitedMs}`,
			].join("\n"),
		)
		if (!report.ok) {
			console.log(
				`pending=${report.searchIndexes.pending.slice(0, 20).join(", ")}`,
			)
			process.exitCode = 1
		}
	}
}
