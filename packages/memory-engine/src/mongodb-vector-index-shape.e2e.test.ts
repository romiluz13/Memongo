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
 * A mocked test cannot catch this. It was tried first and passed against the
 * broken code: mockDb() has no working buildInfo, so the version gate never
 * fires. Only a real server rejects the definition.
 *
 * Both halves are checked here without an embedding provider, so this stays in
 * the secretless tier-A gate:
 *
 *   - what we send: buildAutoEmbedVectorDefinition carries none of the
 *     options the server refuses;
 *   - why that matters: the server really does refuse `storedSource: true` on
 *     a vector index, pinned against a live cluster using an explicit vector
 *     field, which needs no embeddings.
 *
 * Creating an actual auto-embedding index cannot be done here — with no key on
 * the container mongot reports "CanonicalModel: voyage-4-large not registered
 * yet, supported models are: []" — so that proof lives in the nightly suite,
 * which has one.
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
})

afterAll(async () => {
	await db?.dropDatabase().catch(() => undefined)
	await client?.close()
})

describe("vector index definition", () => {
	it("carries no option the server rejects", () => {
		// Live 8.3.4 rejects each of these on an autoEmbed field — the embedding
		// model determines all of them: quantization ("Omit quantization to use
		// the default (float)"), similarity ("...the default (dotProduct)"),
		// numDimensions ("The embedding model determines dimensions
		// automatically") and field-level indexingMethod ("Omit indexingMethod
		// to use default HNSW"). So there is nothing here to pin.
		const definition = buildAutoEmbedVectorDefinition("text", [
			"agentId",
			"scope",
			"scopeRef",
		])
		expect(definition.storedSource).toBeUndefined()
		expect(definition.indexingMethod).toBeUndefined()

		const fields = definition.fields as Array<Record<string, unknown>>
		const autoEmbed = fields.find((field) => field.type === "autoEmbed")
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

		// The filter fields the search prefilters depend on must survive.
		expect(fields.filter((field) => field.type === "filter")).toEqual([
			{ type: "filter", path: "agentId" },
			{ type: "filter", path: "scope" },
			{ type: "filter", path: "scopeRef" },
		])
	})

	it("would be rejected by the server if storedSource: true came back", async () => {
		// This is the assertion that gives the one above its teeth, and it is
		// the exact error that silently disabled every vector index on 8.3+.
		// An explicit vector field is used so no embedding provider is needed.
		const collection = db.collection("stored_source_probe")
		await collection.insertOne({ embedding: [0.1, 0.2, 0.3, 0.4] })

		await expect(
			collection.createSearchIndex({
				name: "rejected_vector",
				type: "vectorSearch",
				definition: {
					fields: [
						{
							type: "vector",
							path: "embedding",
							numDimensions: 4,
							similarity: "dotProduct",
						},
					],
					storedSource: true,
				},
			}),
		).rejects.toThrow(/storedSource/i)
	})

	it("accepts the same definition shape once storedSource is gone", async () => {
		// Control for the test above: proves the rejection is specifically about
		// storedSource: true and not about the rest of the definition.
		const collection = db.collection("accepted_probe")
		await collection.insertOne({ embedding: [0.1, 0.2, 0.3, 0.4] })

		await collection.createSearchIndex({
			name: "accepted_vector",
			type: "vectorSearch",
			definition: {
				fields: [
					{
						type: "vector",
						path: "embedding",
						numDimensions: 4,
						similarity: "dotProduct",
					},
					{ type: "filter", path: "agentId" },
				],
			},
		})

		const indexes = await collection.listSearchIndexes().toArray()
		expect(indexes.map((index) => index.name)).toContain("accepted_vector")
	})
})
