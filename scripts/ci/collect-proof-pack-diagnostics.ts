// Usage: bun scripts/ci/collect-proof-pack-diagnostics.ts \
//   <raw-service-log> <out-dir> <database-file>
// Reads MEMONGO_MONGODB_URI, and VOYAGE_API_KEY only to scrub it.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { MongoClient } from "mongodb"

import {
	boundTail,
	type SearchIndexStatus,
	scrubLogText,
	summarizeSearchIndexes,
} from "./proof-pack-diagnostics.js"

const MAX_FILE_BYTES = 1_048_576
const MAX_INDEXES = 100
const MAX_ERRORS = 50
const NOTE =
	"Diagnostic only. Search-index status is not a visibility signal; the proof-pack's search barrier is."

const [rawServiceLog, outDir, databaseFile] = process.argv.slice(2)
if (!rawServiceLog || !outDir || !databaseFile) {
	console.error(
		"usage: collect-proof-pack-diagnostics.ts <raw-service-log> <out-dir> <database-file>",
	)
	process.exit(2)
}
const uri = process.env.MEMONGO_MONGODB_URI
const secrets = [process.env.VOYAGE_API_KEY ?? "", uri ?? ""]
const scrubbedMessage = (error: unknown) =>
	scrubLogText(error instanceof Error ? error.message : String(error), secrets)
		.slice(0, 300)
		.replace(/\s+/g, " ")

await mkdir(outDir, { recursive: true })
let failed = false

try {
	const header = `# ${NOTE}\n`
	const raw = await readFile(rawServiceLog, "utf8")
	await writeFile(
		path.join(outDir, "service.log"),
		header +
			boundTail(
				scrubLogText(raw, secrets),
				MAX_FILE_BYTES - Buffer.byteLength(header),
			),
	)
	console.log(`service log scrubbed into ${path.join(outDir, "service.log")}`)
} catch (error) {
	failed = true
	console.log(`::warning::service log not captured: ${scrubbedMessage(error)}`)
}

try {
	if (!uri) {
		throw new Error("MEMONGO_MONGODB_URI is not set")
	}
	const database = (await readFile(databaseFile, "utf8")).trim()
	const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })
	try {
		const db = client.db(database)
		const collections = await db
			.listCollections({}, { nameOnly: true })
			.toArray()
		const indexes: SearchIndexStatus[] = []
		const errors: Array<{ collection: string; error: string }> = []
		for (const { name } of collections) {
			try {
				const listed = await db.collection(name).listSearchIndexes().toArray()
				indexes.push(...summarizeSearchIndexes(name, listed))
			} catch (error) {
				errors.push({ collection: name, error: scrubbedMessage(error) })
			}
		}
		const report = JSON.stringify(
			{
				note: NOTE,
				database,
				collections: collections.length,
				indexCount: indexes.length,
				indexes: indexes.slice(0, MAX_INDEXES),
				errors: errors.slice(0, MAX_ERRORS),
			},
			null,
			2,
		)
		if (Buffer.byteLength(report) > MAX_FILE_BYTES) {
			throw new Error(`search-index report exceeds ${MAX_FILE_BYTES} bytes`)
		}
		await writeFile(path.join(outDir, "search-indexes.json"), report)
		console.log(
			`search-index status: ${indexes.length} indexes across ${collections.length} collections`,
		)
	} finally {
		await client.close()
	}
} catch (error) {
	failed = true
	console.log(
		`::warning::search-index status not captured: ${scrubbedMessage(error)}`,
	)
}

process.exitCode = failed ? 1 : 0
