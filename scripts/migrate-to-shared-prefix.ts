import { MongoClient, type Db } from "mongodb"

/**
 * P2.1 migration: consolidate per-agent `memongo_<agent>_*` collection sets
 * into the shared `memongo_*` collection set (MongoDB's collection-per-tenant
 * -> shared-collection multitenancy pattern). Documents already carry agentId,
 * so the tenant field travels with the data and no rewriting is needed.
 *
 * Defaults to a dry run. Usage:
 *
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-to-shared-prefix.ts
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-to-shared-prefix.ts --apply
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-to-shared-prefix.ts --apply --drop
 *
 * Flags:
 *   --apply            execute the copy (default: dry-run report only)
 *   --drop             drop each source collection after its copy verifies
 *                      (requires --apply)
 *   --agent <id>       migrate only this agent prefix (repeatable)
 *   --batch <n>        docs per insert batch (default 500)
 *
 * Env:
 *   MEMONGO_MONGODB_URI             (required)
 *   MEMONGO_MONGODB_DATABASE        (default "memongo")
 *   MEMONGO_MONGODB_TARGET_PREFIX   (default "memongo_")
 *
 * The copy is idempotent: batched unordered inserts tolerate duplicate-key
 * errors, so re-running after an interruption skips already-migrated docs.
 */

const BASE_COLLECTIONS = [
	"structured_mem_revisions",
	"relevance_regressions",
	"procedure_revisions",
	"consolidation_runs",
	"relevance_artifacts",
	"memory_quarantine",
	"projection_runs",
	"memory_mutations",
	"relevance_runs",
	"memory_telemetry",
	"session_chunks",
	"knowledge_base",
	"lane_coverage",
	"recall_traces",
	"access_events",
	"entity_links",
	"memory_jobs",
	"structured_mem",
	"kb_chunks",
	"procedures",
	"query_cache",
	"episodes",
	"relations",
	"entities",
	"chunks",
	"events",
	"files",
	"meta",
	"memory_evidence",
	"ingest_runs",
]

const AGENT_SEGMENT = /^[a-z0-9-]+$/

type SourceCollection = {
	agentId: string
	base: string
	sourceName: string
	targetName: string
}

type CopyReport = {
	sourceName: string
	targetName: string
	scanned: number
	inserted: number
	duplicates: number
	verified: boolean
	dropped: boolean
}

function readArgValues(flag: string): string[] {
	const values: string[] = []
	for (let i = 0; i < process.argv.length - 1; i++) {
		if (process.argv[i] === flag) {
			values.push(process.argv[i + 1] as string)
		}
	}
	return values
}

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag)
}

function discoverSources(
	collectionNames: string[],
	targetPrefix: string,
	agents: Set<string> | null,
): SourceCollection[] {
	const sources: SourceCollection[] = []
	for (const name of collectionNames) {
		if (!name.startsWith(targetPrefix)) {
			continue
		}
		const rest = name.slice(targetPrefix.length)
		if ((BASE_COLLECTIONS as string[]).includes(rest)) {
			// Already a shared target collection.
			continue
		}
		const base = BASE_COLLECTIONS.find((candidate) =>
			rest.endsWith(`_${candidate}`),
		)
		if (!base) {
			continue
		}
		const agentId = rest.slice(0, rest.length - base.length - 1)
		if (!AGENT_SEGMENT.test(agentId)) {
			continue
		}
		if (agents && !agents.has(agentId)) {
			continue
		}
		sources.push({
			agentId,
			base,
			sourceName: name,
			targetName: `${targetPrefix}${base}`,
		})
	}
	return sources.toSorted((a, b) => a.sourceName.localeCompare(b.sourceName))
}

function isDuplicateOnlyBulkError(
	err: unknown,
): err is { result: { insertedCount: number } } {
	if (typeof err !== "object" || err === null) {
		return false
	}
	const candidate = err as {
		name?: string
		writeErrors?: Array<{ code?: number }>
		result?: { insertedCount?: number }
	}
	if (candidate.name !== "MongoBulkWriteError") {
		return false
	}
	const writeErrors = candidate.writeErrors ?? []
	return writeErrors.every((writeError) => writeError.code === 11000)
}

async function copyCollection(
	db: Db,
	source: SourceCollection,
	batchSize: number,
): Promise<CopyReport> {
	const sourceColl = db.collection(source.sourceName)
	const targetColl = db.collection(source.targetName)
	const report: CopyReport = {
		sourceName: source.sourceName,
		targetName: source.targetName,
		scanned: 0,
		inserted: 0,
		duplicates: 0,
		verified: false,
		dropped: false,
	}
	const cursor = sourceColl.find({}).batchSize(batchSize)
	let batch: Record<string, unknown>[] = []
	const flush = async () => {
		if (batch.length === 0) {
			return
		}
		try {
			const result = await targetColl.insertMany(batch, { ordered: false })
			report.inserted += result.insertedCount
		} catch (err) {
			if (!isDuplicateOnlyBulkError(err)) {
				throw err
			}
			const inserted = err.result.insertedCount ?? 0
			report.inserted += inserted
			report.duplicates += batch.length - inserted
		}
		batch = []
	}
	for await (const doc of cursor) {
		batch.push(doc as Record<string, unknown>)
		report.scanned += 1
		if (batch.length >= batchSize) {
			await flush()
		}
	}
	await flush()
	report.verified = report.scanned === report.inserted + report.duplicates
	return report
}

async function main() {
	const uri = process.env.MEMONGO_MONGODB_URI?.trim()
	if (!uri) {
		throw new Error("MEMONGO_MONGODB_URI is required")
	}
	const database = process.env.MEMONGO_MONGODB_DATABASE?.trim() || "memongo"
	const targetPrefix =
		process.env.MEMONGO_MONGODB_TARGET_PREFIX?.trim() || "memongo_"
	const apply = hasFlag("--apply")
	const drop = hasFlag("--drop")
	const agentFilter = readArgValues("--agent")
	const batchArg = readArgValues("--batch")[0]
	const batchSize = batchArg ? Number(batchArg) : 500
	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new Error("--batch must be a positive integer")
	}
	if (drop && !apply) {
		throw new Error("--drop requires --apply")
	}

	const client = new MongoClient(uri, {
		appName: "memongo-migrate-shared-prefix",
		serverSelectionTimeoutMS: 10_000,
	})
	await client.connect()
	try {
		const db = client.db(database)
		const collectionNames = await db
			.listCollections()
			.map((c) => c.name)
			.toArray()
		const sources = discoverSources(
			collectionNames,
			targetPrefix,
			agentFilter.length > 0 ? new Set(agentFilter) : null,
		)
		if (sources.length === 0) {
			console.log(
				`migrate-shared-prefix: no per-agent ${targetPrefix}<agent>_* collections found in db=${database}`,
			)
			return
		}
		const agents = [...new Set(sources.map((s) => s.agentId))].toSorted()
		console.log(
			`migrate-shared-prefix: mode=${apply ? "apply" : "dry-run"} db=${database} target=${targetPrefix}* agents=${agents.join(",")} collections=${sources.length}`,
		)

		const reports: CopyReport[] = []
		for (const source of sources) {
			const sourceCount = await db
				.collection(source.sourceName)
				.estimatedDocumentCount()
			if (!apply) {
				console.log(
					`dry-run ${source.sourceName} -> ${source.targetName} docs=${sourceCount}`,
				)
				continue
			}
			const report = await copyCollection(db, source, batchSize)
			if (drop && report.verified) {
				await db.dropCollection(source.sourceName)
				report.dropped = true
			}
			reports.push(report)
			console.log(
				`copy ${report.sourceName} -> ${report.targetName} scanned=${report.scanned} inserted=${report.inserted} duplicates=${report.duplicates} verified=${report.verified}${report.dropped ? " dropped" : ""}`,
			)
		}

		if (apply) {
			const failed = reports.filter((report) => !report.verified)
			const totals = reports.reduce(
				(acc, report) => ({
					scanned: acc.scanned + report.scanned,
					inserted: acc.inserted + report.inserted,
					duplicates: acc.duplicates + report.duplicates,
				}),
				{ scanned: 0, inserted: 0, duplicates: 0 },
			)
			console.log(
				`migrate-shared-prefix: total scanned=${totals.scanned} inserted=${totals.inserted} duplicates=${totals.duplicates} collections=${reports.length} dropped=${reports.filter((r) => r.dropped).length}`,
			)
			if (failed.length > 0) {
				console.error(
					`migrate-shared-prefix: FAILED verification for: ${failed.map((r) => r.sourceName).join(",")}`,
				)
				process.exitCode = 1
			}
		} else {
			console.log(
				"migrate-shared-prefix: dry-run only — re-run with --apply to copy, --apply --drop to also remove source collections",
			)
		}
	} finally {
		await client.close()
	}
}

await main()
