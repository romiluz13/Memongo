import { MongoClient } from "mongodb"
import { validateBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

function readUri(): string {
	const uri =
		process.env.MEMONGO_MONGODB_URI?.trim() ||
		process.env.MEMONGO_CLOUD_MONGODB_URI?.trim() ||
		process.env.MDB_MCP_CONNECTION_STRING?.trim()
	if (!uri) {
		throw new Error(
			"set MEMONGO_MONGODB_URI or MEMONGO_CLOUD_MONGODB_URI before dropping a benchmark prefix",
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

function readPrefix(): string {
	const argPrefix = process.argv
		.find((arg) => arg.startsWith("--prefix="))
		?.slice("--prefix=".length)
		.trim()
	const prefix =
		argPrefix || process.env.MEMONGO_MONGODB_COLLECTION_PREFIX?.trim()
	if (!prefix) {
		throw new Error(
			"pass --prefix=memongo_bench_<run-id>_ or set MEMONGO_MONGODB_COLLECTION_PREFIX",
		)
	}
	validateBenchmarkCollectionPrefix(prefix)
	return prefix
}

const prefix = readPrefix()
const yes = process.argv.includes("--yes")
const database = readDatabaseName()
const client = new MongoClient(readUri(), {
	appName: yes
		? "memongo-benchmark-prefix-drop"
		: "memongo-benchmark-prefix-drop-dry-run",
	serverSelectionTimeoutMS: 10_000,
})

await client.connect()
try {
	const db = client.db(database)
	const collections = await db
		.listCollections({ name: { $regex: `^${prefix}` } }, { nameOnly: true })
		.toArray()
	const names = collections.map((collection) => collection.name).sort()
	const report = {
		database,
		prefix,
		mode: yes ? "drop" : "dry-run",
		collections: names.length,
		names,
	}
	console.log(JSON.stringify(report, null, 2))
	if (!yes) {
		console.log("dry-run only; pass --yes to drop these collections")
		process.exit(0)
	}
	for (const name of names) {
		await db.collection(name).drop()
	}
	console.log(
		JSON.stringify(
			{
				ok: true,
				database,
				prefix,
				droppedCollections: names.length,
			},
			null,
			2,
		),
	)
} finally {
	await client.close()
}
