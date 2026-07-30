/**
 * $rankFusion score-space regression (S2).
 *
 * MongoDB's fused score is, quoting the `scoreDetails.description` the server
 * returns: "value output by reciprocal rank fusion algorithm, computed as sum
 * of (weight * (1 / (60 + rank))) across input pipelines from which this
 * document is output". So a document ranked #1 in every pipeline scores
 * `Σweights / 61` — with the 0.7/0.3 weights the engine uses, 1/61 ≈ 0.0164.
 *
 * The shipped default minScore is 0.1. Comparing that against a raw RRF score
 * meant hybridSearchRankFusion returned [] for every query on every corpus,
 * and every hybrid search silently fell through to the JS-merge path.
 *
 * This test pins the server-side half of that fact: the ceiling really is
 * sum(weights)/61, and it really is below the shipped threshold. If a future
 * release changes the rank constant, this fails here rather than as a quiet
 * recall regression. The rescaling the engine applies on top is arithmetic and
 * is covered in mongodb-search.test.ts.
 *
 * Explicit vectors are used so no embedding provider is involved, which keeps
 * this in the secretless tier-A gate.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e:tier-a
 */
import { randomUUID } from "node:crypto"
import { type Collection, type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_rrf_score_${randomUUID().slice(0, 8)}`
const TEXT_INDEX = "rrf_probe_text"
const VECTOR_INDEX = "rrf_probe_vector"
const DIM = 4
const VECTOR_WEIGHT = 0.7
const TEXT_WEIGHT = 0.3
const QUERY = "quokkaberry autumn harvest"
const QUERY_VECTOR = [1, 0.85, 0.15, 0]

const DOCS = [
	{
		text: "the quokkaberry harvest was excellent this autumn",
		v: [1, 0.9, 0.1, 0],
	},
	{
		text: "quokkaberry jam is made from the autumn harvest",
		v: [1, 0.8, 0.2, 0],
	},
	{
		text: "pineapple cultivation requires tropical humidity",
		v: [0, 0.1, 1, 0.9],
	},
	{
		text: "the autumn festival celebrates the local harvest",
		v: [0.4, 0.9, 0.2, 0.1],
	},
	{
		text: "quokkaberry plants need well drained soil",
		v: [0.9, 0.3, 0.3, 0.1],
	},
	{ text: "nothing at all to do with fruit or farming", v: [0, 0, 0.2, 1] },
]

let client: MongoClient
let db: Db
let col: Collection

beforeAll(async () => {
	client = new MongoClient(TEST_URI)
	await client.connect()
	db = client.db(TEST_DB)
	col = db.collection("chunks")
	await col.insertMany(
		DOCS.map((d, i) => ({
			_id: i as never,
			path: `chunk/${i}`,
			text: d.text,
			embedding: d.v,
			source: "conversation",
		})),
	)

	await col.createSearchIndex({
		name: TEXT_INDEX,
		type: "search",
		definition: { mappings: { dynamic: true } },
	})
	await col.createSearchIndex({
		name: VECTOR_INDEX,
		type: "vectorSearch",
		definition: {
			fields: [
				{
					type: "vector",
					path: "embedding",
					numDimensions: DIM,
					similarity: "dotProduct",
				},
			],
		},
	})

	for (let i = 0; i < 90; i++) {
		const idx = await col.listSearchIndexes().toArray()
		if (idx.length === 2 && idx.every((x) => x.queryable === true)) {
			return
		}
		await new Promise((r) => setTimeout(r, 2000))
	}
	throw new Error("search indexes never became queryable")
})

afterAll(async () => {
	await db?.dropDatabase().catch(() => undefined)
	await client?.close()
})

describe("$rankFusion score space", () => {
	it("caps raw server-side RRF scores at sum(weights)/61", async () => {
		// Runs the pipeline directly, so this asserts MongoDB's behavior rather
		// than the engine's — if a future server release changes the rank
		// constant, this is what tells us before the thresholds go wrong again.
		const docs = await col
			.aggregate([
				{
					$rankFusion: {
						input: {
							pipelines: {
								vector: [
									{
										$vectorSearch: {
											index: VECTOR_INDEX,
											path: "embedding",
											queryVector: QUERY_VECTOR,
											numCandidates: 100,
											limit: 20,
										},
									},
								],
								text: [
									{
										$search: {
											index: TEXT_INDEX,
											compound: {
												should: [{ text: { query: QUERY, path: "text" } }],
											},
										},
									},
									{ $limit: 20 },
								],
							},
						},
						combination: {
							weights: { vector: VECTOR_WEIGHT, text: TEXT_WEIGHT },
						},
						scoreDetails: true,
					},
				},
				{ $addFields: { scoreDetails: { $meta: "scoreDetails" } } },
				{ $project: { _id: 0, score: "$scoreDetails.value" } },
			])
			.toArray()

		expect(docs.length).toBeGreaterThan(0)
		const ceiling = (VECTOR_WEIGHT + TEXT_WEIGHT) / 61
		const maxScore = Math.max(...docs.map((d) => d.score as number))
		expect(maxScore).toBeLessThanOrEqual(ceiling + 1e-9)
		// The best document is ranked #1 in both pipelines, so it sits exactly on
		// the ceiling — which is what makes a 0.1 threshold unsatisfiable.
		expect(maxScore).toBeCloseTo(ceiling, 8)
		expect(ceiling).toBeLessThan(0.1)
	})

	it("projects the fused score via $meta:'score' without requesting scoreDetails", async () => {
		// The engine's hot path now reads the score from the documented
		// $meta:"score" and never asks for scoreDetails. This pins the
		// server-side contract: the guaranteed metadata field carries the same
		// value scoreDetails.value used to, with scoreDetails absent entirely.
		const docs = await col
			.aggregate([
				{
					$rankFusion: {
						input: {
							pipelines: {
								vector: [
									{
										$vectorSearch: {
											index: VECTOR_INDEX,
											path: "embedding",
											queryVector: QUERY_VECTOR,
											numCandidates: 100,
											limit: 20,
										},
									},
								],
								text: [
									{
										$search: {
											index: TEXT_INDEX,
											compound: {
												should: [{ text: { query: QUERY, path: "text" } }],
											},
										},
									},
									{ $limit: 20 },
								],
							},
						},
						combination: {
							weights: { vector: VECTOR_WEIGHT, text: TEXT_WEIGHT },
						},
					},
				},
				{ $project: { _id: 0, score: { $meta: "score" } } },
			])
			.toArray()

		expect(docs.length).toBeGreaterThan(0)
		const ceiling = (VECTOR_WEIGHT + TEXT_WEIGHT) / 61
		const maxScore = Math.max(...docs.map((d) => d.score as number))
		expect(maxScore).toBeGreaterThan(0)
		expect(maxScore).toBeCloseTo(ceiling, 8)
	})

	it("keeps $scoreFusion sigmoid+avg output under the engine's rescale ceiling", async () => {
		// normalizeAndFilterScoreFusionResults divides by
		// max(maxWeight, Σweights/2) because the docs don't pin down the avg
		// denominator. This asserts on a live cluster that the raw fused score
		// (read via the guaranteed $meta:"score", no scoreDetails requested)
		// actually stays under that ceiling, so the rescale can never inflate a
		// score past 1.
		const docs = await col
			.aggregate([
				{
					$scoreFusion: {
						input: {
							pipelines: {
								vector: [
									{
										$vectorSearch: {
											index: VECTOR_INDEX,
											path: "embedding",
											queryVector: QUERY_VECTOR,
											numCandidates: 100,
											limit: 20,
										},
									},
								],
								text: [
									{
										$search: {
											index: TEXT_INDEX,
											compound: {
												should: [{ text: { query: QUERY, path: "text" } }],
											},
										},
									},
									{ $limit: 20 },
								],
							},
							normalization: "sigmoid",
						},
						combination: {
							weights: { vector: VECTOR_WEIGHT, text: TEXT_WEIGHT },
							method: "avg",
						},
					},
				},
				{ $project: { _id: 0, score: { $meta: "score" } } },
			])
			.toArray()

		expect(docs.length).toBeGreaterThan(0)
		const rescaleCeiling = Math.max(
			VECTOR_WEIGHT,
			TEXT_WEIGHT,
			(VECTOR_WEIGHT + TEXT_WEIGHT) / 2,
		)
		for (const doc of docs) {
			expect(doc.score).toBeGreaterThan(0)
			expect(doc.score).toBeLessThanOrEqual(rescaleCeiling + 1e-9)
		}
	})
})
