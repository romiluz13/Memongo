import { MongoClient } from "mongodb"

type PrefixSummary = {
	prefix: string
	collections: number
	classicIndexes: number
	nonIdClassicIndexes: number
	searchIndexes: number | null
}

type MongotScan = {
	ns?: string
	op?: string
	secs_running?: number
	planSummary?: string
	appName?: string
	collection?: string
}

const MEMONGO_COLLECTION_SUFFIXES = [
	"structured_mem_revisions",
	"relevance_regressions",
	"conversation_summaries",
	"consolidation_runs",
	"relevance_artifacts",
	"memory_quarantine",
	"schema_migrations",
	"projection_runs",
	"relevance_runs",
	"memory_telemetry",
	"memory_mutations",
	"knowledge_base",
	"graph_relations",
	"session_chunks",
	"embedding_cache",
	"procedure_revisions",
	"reasoning_chains",
	"memory_snapshots",
	"structured_mem",
	"access_events",
	"query_cache",
	"recall_traces",
	"memory_jobs",
	"lane_coverage",
	"ingest_runs",
	"entity_links",
	"kb_chunks",
	"procedures",
	"relations",
	"entities",
	"episodes",
	"chunks",
	"events",
	"files",
	"locks",
	"jobs",
	"meta",
]

MEMONGO_COLLECTION_SUFFIXES.sort((a, b) => b.length - a.length)

function readUri(): string {
	const uri =
		process.env.MEMONGO_MONGODB_URI?.trim() ||
		process.env.MEMONGO_CLOUD_MONGODB_URI?.trim() ||
		process.env.MDB_MCP_CONNECTION_STRING?.trim()
	if (!uri) {
		throw new Error(
			"set MEMONGO_MONGODB_URI or MEMONGO_CLOUD_MONGODB_URI before running mongodb:prefix-inventory",
		)
	}
	return uri
}

function readDatabaseName(): string {
	return (
		process.env.MEMONGO_DB_NAME?.trim() ||
		process.env.MEMONGO_PARITY_DATABASE?.trim() ||
		"memongo"
	)
}

function shouldIncludeSearchIndexes(): boolean {
	return (
		process.argv.includes("--include-search-indexes") ||
		process.env.MEMONGO_PREFIX_INVENTORY_INCLUDE_SEARCH_INDEXES === "1"
	)
}

function detectPrefix(collectionName: string): string | null {
	for (const suffix of MEMONGO_COLLECTION_SUFFIXES) {
		if (collectionName === suffix) return ""
		if (collectionName.endsWith(suffix)) {
			return collectionName.slice(0, -suffix.length)
		}
	}
	return null
}

async function listSearchIndexCount(
	client: MongoClient,
	database: string,
	collectionName: string,
): Promise<number> {
	try {
		const docs = await client
			.db(database)
			.collection(collectionName)
			.listSearchIndexes()
			.toArray()
		return docs.length
	} catch {
		return 0
	}
}

async function listMongotCollscans(
	client: MongoClient,
	database: string,
): Promise<MongotScan[]> {
	try {
		return (await client
			.db("admin")
			.aggregate([
				{ $currentOp: { allUsers: true, idleConnections: false } },
				{
					$project: {
						ns: 1,
						op: 1,
						secs_running: 1,
						planSummary: 1,
						appName: "$clientMetadata.application.name",
						collection: "$command.collection",
					},
				},
				{
					$match: {
						ns: { $regex: `^${database.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.` },
						planSummary: "COLLSCAN",
					},
				},
				{ $limit: 50 },
			])
			.toArray()) as MongotScan[]
	} catch {
		return []
	}
}

function renderText(report: {
	database: string
	collections: number
	prefixes: PrefixSummary[]
	totalClassicIndexes: number
	totalNonIdClassicIndexes: number
	totalSearchIndexes: number | null
	mongotCollscans: MongotScan[]
}): string {
	const lines = [
		`mongodb:prefix-inventory db=${report.database}`,
		`collections: ${report.collections}`,
		`prefix groups: ${report.prefixes.length}`,
		`classic indexes: ${report.totalClassicIndexes} (${report.totalNonIdClassicIndexes} non-_id)`,
		`search/vector indexes: ${report.totalSearchIndexes === null ? "skipped" : report.totalSearchIndexes}`,
		"",
		"top prefixes:",
	]
	for (const prefix of report.prefixes.slice(0, 20)) {
		lines.push(
			`- ${prefix.prefix || "<empty>"} collections=${prefix.collections} classic=${prefix.classicIndexes} nonId=${prefix.nonIdClassicIndexes} search=${prefix.searchIndexes === null ? "skipped" : prefix.searchIndexes}`,
		)
	}
	if (report.mongotCollscans.length > 0) {
		lines.push("", "active COLLSCAN operations:")
		for (const op of report.mongotCollscans.slice(0, 20)) {
			lines.push(
				`- app=${op.appName ?? "unknown"} ns=${op.ns ?? "unknown"} collection=${op.collection ?? "-"} secs=${op.secs_running ?? 0}`,
			)
		}
	}
	return lines.join("\n")
}

const client = new MongoClient(readUri(), {
	appName: "memongo-prefix-inventory-readonly",
	serverSelectionTimeoutMS: 10_000,
})
await client.connect()
try {
	const database = readDatabaseName()
	const db = client.db(database)
	const collections = await db.listCollections({}, { nameOnly: true }).toArray()
	const prefixMap = new Map<string, PrefixSummary>()
	const includeSearchIndexes = shouldIncludeSearchIndexes()

	for (const collection of collections) {
		const name = collection.name
		const prefix = detectPrefix(name)
		if (prefix === null || !prefix.startsWith("memongo_")) continue
		const summary =
			prefixMap.get(prefix) ??
			{
				prefix,
				collections: 0,
				classicIndexes: 0,
				nonIdClassicIndexes: 0,
				searchIndexes: includeSearchIndexes ? 0 : null,
			}
		summary.collections += 1
		const indexes = await db.collection(name).indexes()
		summary.classicIndexes += indexes.length
		summary.nonIdClassicIndexes += indexes.filter(
			(index) => index.name !== "_id_",
		).length
		if (includeSearchIndexes) {
			summary.searchIndexes =
				(summary.searchIndexes ?? 0) +
				(await listSearchIndexCount(client, database, name))
		}
		prefixMap.set(prefix, summary)
	}

	const prefixes = [...prefixMap.values()].sort((a, b) => {
		const searchDiff = (b.searchIndexes ?? 0) - (a.searchIndexes ?? 0)
		return (
			b.collections - a.collections ||
			searchDiff ||
			a.prefix.localeCompare(b.prefix)
		)
	})
	const report = {
		database,
		collections: collections.length,
		prefixes,
		totalClassicIndexes: prefixes.reduce(
			(total, prefix) => total + prefix.classicIndexes,
			0,
		),
		totalNonIdClassicIndexes: prefixes.reduce(
			(total, prefix) => total + prefix.nonIdClassicIndexes,
			0,
		),
		totalSearchIndexes: includeSearchIndexes
			? prefixes.reduce((total, prefix) => total + (prefix.searchIndexes ?? 0), 0)
			: null,
		mongotCollscans: await listMongotCollscans(client, database),
	}
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2))
	} else {
		console.log(renderText(report))
	}
} finally {
	await client.close()
}
