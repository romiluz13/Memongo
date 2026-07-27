/**
 * Vector index definition acceptance (V1).
 *
 * ensureSearchIndexes used to add `storedSource: true` and
 * `indexingMethod: "flat"` to every vector index whenever buildInfo reported
 * MongoDB 8.3+. The server rejects the first outright, and each creation is
 * wrapped in a catch that only logs, so on 8.3 and newer all seven vector
 * indexes silently failed to create: no semantic retrieval at all, on exactly
 * the versions the version gate was written to light up.
 *
 * A mocked test cannot catch this. It was tried: mockDb() has no working
 * buildInfo, so the version gate never fires and the assertion passes against
 * the broken code. Only a real server rejects the definition, which is the
 * whole reason this suite exists.
 *
 * This creates ONE index from buildAutoEmbedVectorDefinition — the same
 * builder every collection ships — rather than running ensureSearchIndexes,
 * which would queue fourteen auto-embedding indexes. Those cannot finish their
 * initial sync without a working embedding provider, and mongot syncs
 * embedding indexes one at a time, so they starve every other e2e file's
 * search indexes. Creation is validated synchronously by the server, so one
 * index proves exactly as much as fourteen.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e:tier-a
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildAutoEmbedVectorDefinition } from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_vector_shape_${randomUUID().slice(0, 8)}`

let client: MongoClient
let db: Db

beforeAll(async () => {
	client = new MongoClient(TEST_URI)
	await client.connect()
	db = client.db(TEST_DB)
}, 120_000)

afterAll(async () => {
	await db?.dropDatabase().catch(() => undefined)
	await client?.close()
})

describe("vector index definition", () => {
	it("is accepted by the server exactly as shipped", async () => {
		const collection = db.collection("chunks")
		await collection.insertOne({ text: "hello", agentId: "a1" })

		// Throws if the server rejects any option in the definition. That is the
		// regression: ensureSearchIndexes swallows this same error into a
		// log.warn, so nothing downstream could tell the difference between "no
		// vector index" and "no data".
		await collection.createSearchIndex({
			name: "chunks_vector",
			type: "vectorSearch",
			definition: buildAutoEmbedVectorDefinition("text", [
				"source",
				"path",
				"agentId",
				"scope",
				"scopeRef",
				"sessionId",
				"status",
			]),
		})

		const indexes = await collection.listSearchIndexes().toArray()
		expect(indexes.map((index) => index.name)).toContain("chunks_vector")

		// Drop it again so its initial sync does not hold mongot's
		// one-at-a-time embedding queue for the rest of the run.
		await collection.dropSearchIndex("chunks_vector").catch(() => undefined)
	})

	it("carries no option the server rejects on an autoEmbed field", () => {
		// Asserted separately from creation so the reason a future "let's pin the
		// index options" change fails is legible. Live 8.3.4 rejects each of
		// these on an autoEmbed field: the embedding model determines them.
		const definition = buildAutoEmbedVectorDefinition("text", ["agentId"])
		expect(definition.storedSource).toBeUndefined()
		expect(definition.indexingMethod).toBeUndefined()

		const autoEmbed = (
			definition.fields as Array<Record<string, unknown>>
		).find((field) => field.type === "autoEmbed")
		expect(autoEmbed).toMatchObject({
			type: "autoEmbed",
			modality: "text",
			path: "text",
		})
		for (const rejected of [
			"quantization",
			"similarity",
			"numDimensions",
			"indexingMethod",
		]) {
			expect(autoEmbed?.[rejected]).toBeUndefined()
		}
	})
})
