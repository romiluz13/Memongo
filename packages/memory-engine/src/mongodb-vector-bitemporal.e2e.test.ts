import { randomUUID } from "node:crypto"
import { MongoClient, type Db, type Document } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	buildBitemporalFilter,
	buildVectorBitemporalFilter,
} from "./mongodb-bitemporal.js"
import {
	isEventsVectorBitemporalPrefilterReady,
	waitForSearchIndexesQueryable,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_vector_bitemporal_${randomUUID().slice(0, 8)}`
const COLLECTION = "events"
const INDEX = "events_vector"
const AGENT = `agent-${randomUUID().slice(0, 8)}`
const STARVATION_AGENT = `starvation-${randomUUID().slice(0, 8)}`
const AS_OF = new Date("2026-01-10T12:00:00.000Z")
const QUERY_VECTOR = [1, 0, 0]

let client: MongoClient
let db: Db

async function nativeIds(filter: Document, limit = 20): Promise<string[]> {
	const rows = await db
		.collection(COLLECTION)
		.aggregate([
			{
				$vectorSearch: {
					index: INDEX,
					path: "embedding",
					queryVector: QUERY_VECTOR,
					numCandidates: 200,
					limit,
					filter,
				},
			},
			{ $project: { _id: 0, eventId: 1 } },
		])
		.toArray()
	return rows.map((row) => String(row.eventId)).sort()
}

describe("native Vector Search bitemporal prefilter (live MongoDB)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI, {
			serverSelectionTimeoutMS: 10_000,
			connectTimeoutMS: 10_000,
		})
		await client.connect()
		db = client.db(TEST_DB)
		await db.createCollection(COLLECTION)
		await db.collection(COLLECTION).insertMany([
			{
				eventId: "legacy-missing",
				agentId: AGENT,
				body: "temporal canary memory legacy",
				embedding: QUERY_VECTOR,
			},
			{
				eventId: "open-before",
				agentId: AGENT,
				body: "temporal canary memory open",
				embedding: QUERY_VECTOR,
				validAt: new Date("2026-01-01T00:00:00.000Z"),
			},
			{
				eventId: "starts-equal",
				agentId: AGENT,
				body: "temporal canary memory equal start",
				embedding: QUERY_VECTOR,
				validAt: AS_OF,
			},
			{
				eventId: "starts-after",
				agentId: AGENT,
				body: "temporal canary memory future",
				embedding: QUERY_VECTOR,
				validAt: new Date("2026-01-11T00:00:00.000Z"),
			},
			{
				eventId: "invalid-before",
				agentId: AGENT,
				body: "temporal canary memory invalid before",
				embedding: QUERY_VECTOR,
				invalidAt: new Date("2026-01-09T00:00:00.000Z"),
			},
			{
				eventId: "invalid-equal",
				agentId: AGENT,
				body: "temporal canary memory invalid equal",
				embedding: QUERY_VECTOR,
				invalidAt: AS_OF,
			},
			{
				eventId: "invalid-after",
				agentId: AGENT,
				body: "temporal canary memory invalid after",
				embedding: QUERY_VECTOR,
				invalidAt: new Date("2026-01-11T00:00:00.000Z"),
			},
		])
		await db.collection(COLLECTION).createSearchIndex({
			name: INDEX,
			type: "vectorSearch",
			definition: {
				fields: [
					{
						type: "vector",
						path: "embedding",
						numDimensions: 3,
						similarity: "cosine",
					},
					{ type: "filter", path: "agentId" },
					{ type: "filter", path: "validAt" },
					{ type: "filter", path: "invalidAt" },
				],
			},
		})
		const readiness = await waitForSearchIndexesQueryable(
			db.collection(COLLECTION),
			{ indexNames: [INDEX], timeoutMs: 180_000, pollMs: 2_000 },
		)
		if (!readiness.ready) {
			throw new Error(
				`events_vector did not become ready: ${JSON.stringify(readiness)}`,
			)
		}
	}, 210_000)

	afterAll(async () => {
		await db?.dropDatabase().catch(() => {})
		await client?.close()
	})

	it("blocks activation for explicit null, then matches ordinary bitemporal IDs after normalization", async () => {
		const collection = db.collection(COLLECTION)
		await collection.insertOne({
			eventId: "explicit-null",
			agentId: AGENT,
			body: "temporal canary memory explicit null",
			embedding: QUERY_VECTOR,
			invalidAt: null,
		})
		await expect(
			isEventsVectorBitemporalPrefilterReady(collection, INDEX),
		).resolves.toBe(false)

		await collection.updateOne(
			{ eventId: "explicit-null" },
			{ $unset: { invalidAt: "" } },
		)
		const readiness = await waitForSearchIndexesQueryable(collection, {
			indexNames: [INDEX],
			timeoutMs: 180_000,
			pollMs: 2_000,
		})
		expect(readiness.ready).toBe(true)
		await expect(
			isEventsVectorBitemporalPrefilterReady(collection, INDEX),
		).resolves.toBe(true)

		const ordinary = await collection
			.find(
				{ agentId: AGENT, ...buildBitemporalFilter(AS_OF) },
				{ projection: { _id: 0, eventId: 1 } },
			)
			.toArray()
		const expected = ordinary.map((row) => String(row.eventId)).sort()
		const filter = {
			agentId: { $eq: AGENT },
			...buildVectorBitemporalFilter(AS_OF),
		}

		const deadline = Date.now() + 180_000
		let actual: string[] = []
		while (Date.now() < deadline) {
			actual = await nativeIds(filter)
			if (actual.length === expected.length) break
			await new Promise((resolve) => setTimeout(resolve, 2_000))
		}

		expect(actual).toEqual(expected)
		expect(actual).toEqual([
			"explicit-null",
			"invalid-after",
			"legacy-missing",
			"open-before",
			"starts-equal",
		])
	}, 210_000)

	it("returns lower-ranked valid memories after more than four limits of invalid neighbors", async () => {
		const collection = db.collection(COLLECTION)
		await collection.insertMany([
			...Array.from({ length: 21 }, (_, index) => ({
				eventId: `invalid-neighbor-${index}`,
				agentId: STARVATION_AGENT,
				body: `invalid nearest neighbor ${index}`,
				embedding: QUERY_VECTOR,
				validAt: new Date("2026-01-01T00:00:00.000Z"),
				invalidAt: new Date("2026-01-09T00:00:00.000Z"),
			})),
			...Array.from({ length: 5 }, (_, index) => ({
				eventId: `valid-lower-ranked-${index}`,
				agentId: STARVATION_AGENT,
				body: `valid lower ranked memory ${index}`,
				embedding: [0.9, 0.1 + index * 0.001, 0],
				validAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
		])

		const deadline = Date.now() + 180_000
		let indexedCount = 0
		while (Date.now() < deadline) {
			indexedCount = (
				await nativeIds({ agentId: { $eq: STARVATION_AGENT } }, 100)
			).length
			if (indexedCount === 26) break
			await new Promise((resolve) => setTimeout(resolve, 2_000))
		}
		expect(indexedCount).toBe(26)

		const oldPostFilterRows = await collection
			.aggregate([
				{
					$vectorSearch: {
						index: INDEX,
						path: "embedding",
						queryVector: QUERY_VECTOR,
						numCandidates: 200,
						limit: 20,
						filter: { agentId: { $eq: STARVATION_AGENT } },
					},
				},
				{ $match: buildBitemporalFilter(AS_OF) },
				{ $project: { _id: 0, eventId: 1 } },
			])
			.toArray()
		expect(oldPostFilterRows).toHaveLength(0)

		const actual = await nativeIds(
			{
				agentId: { $eq: STARVATION_AGENT },
				...buildVectorBitemporalFilter(AS_OF),
			},
			5,
		)
		expect(actual).toEqual(
			Array.from({ length: 5 }, (_, index) => `valid-lower-ranked-${index}`),
		)
	}, 210_000)
})
