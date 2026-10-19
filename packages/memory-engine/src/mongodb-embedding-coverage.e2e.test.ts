import { randomUUID } from "node:crypto"
import { MongoClient, type Db } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getMemoryStats } from "./mongodb-analytics.js"
import { waitForSearchIndexesQueryable } from "./mongodb-schema.js"
import {
	hasAtlasModelKey,
	resolvePreviewMongoTestUri,
	resolvePreviewVoyageApiKey,
} from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_embedding_coverage_${randomUUID().slice(0, 8)}`
const INDEX = "chunks_vector"
const AUTO_EMBED_ENABLED = hasAtlasModelKey(resolvePreviewVoyageApiKey())
const describeAutoEmbed = AUTO_EMBED_ENABLED ? describe : describe.skip

let client: MongoClient
let db: Db

describeAutoEmbed("automated embedding coverage (live MongoDB)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI, {
			serverSelectionTimeoutMS: 10_000,
			connectTimeoutMS: 10_000,
		})
		await client.connect()
		db = client.db(TEST_DB)
		const chunks = db.collection("chunks")
		await chunks.insertMany(
			Array.from({ length: 3 }, (_, index) => ({
				text: `Seeded automated embedding coverage document ${index}`,
				source: "memory",
				path: `seed/${index}.md`,
				// W13: coverage is tenant-scoped — seeded rows must carry the
				// agent identity the stats call below filters on.
				agentId: "coverage-agent",
				updatedAt: new Date(),
				embeddingStatus: "pending",
			})),
		)
		await chunks.createSearchIndex({
			name: INDEX,
			type: "vectorSearch",
			definition: {
				fields: [
					{
						type: "autoEmbed",
						modality: "text",
						path: "text",
						model: "voyage-4-large",
					},
				],
			},
		})
	})

	afterAll(async () => {
		await db?.dropDatabase().catch(() => {})
		await client?.close()
	})

	it("reports tenant coverage as unknown, never a probe-derived number or an invented pending state", async () => {
		// M2 T10 (G3-75): /stats no longer runs a $vectorSearch probe (its text
		// query was embedded on every call, outside the cost ledger). Whether the
		// index is queryable yet or not, the per-tenant answer is unknown.
		await waitForSearchIndexesQueryable(db.collection("chunks"), {
			indexNames: [INDEX],
			timeoutMs: 180_000,
			pollMs: 2_000,
		})

		const stats = await getMemoryStats(db, "", "coverage-agent", undefined, {
			embeddingMode: "automated",
		})

		expect(stats.embeddingCoverage).toEqual({
			withEmbedding: 0,
			withoutEmbedding: 0,
			unknown: 3,
			total: 3,
			coveragePercent: null,
			basis: "search-index",
		})
		expect(stats.embeddingStatusCoverage).toEqual({
			total: 3,
			success: 0,
			failed: 0,
			pending: 0,
			unknown: 3,
			basis: "search-index",
		})
	})
})
