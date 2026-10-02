// Real-database regression for result-cache removal. A legacy cache row owned
// by a reader can survive shared-source invalidation, but public search must
// ignore it, and tenant erasure must still clean it up.

import { createHash, randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { MemongoConfig } from "@memongo/lib"
import {
	type ResolvedMongoDBConfig,
	resolveMemoryBackendConfig,
} from "./backend-config.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { type KBDocument, ingestToKB, removeKBDocument } from "./mongodb-kb.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	type DetectedCapabilities,
	ensureCollections,
	ensureStandardIndexes,
	kbChunksCollection,
	kbCollection,
	queryCacheCollection,
} from "./mongodb-schema.js"

const URI =
	process.env.MEMONGO_TEST_MONGODB_URI ??
	"mongodb://127.0.0.1:27017/?directConnection=true"
const DB_NAME = `memongo_cache_removal_${randomUUID().replaceAll("-", "")}`
const PREFIX = "cache_removal_"
const OWNER_ID = `owner-${randomUUID().slice(0, 8)}`
const READER_ID = `reader-${randomUUID().slice(0, 8)}`
const QUERY = "quokkaberry release handbook"
const SOURCE_TEXT = `The ${QUERY} belongs to the shared knowledge base.`
const TIMEOUT = 60_000

const NO_ATLAS_SEARCH: DetectedCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

let client: MongoClient
let db: Db

function readerManager(): {
	reader: MongoDBMemoryManager
	mongo: ResolvedMongoDBConfig
} {
	const cfg: MemongoConfig = {
		memory: {
			backend: "mongodb",
			sources: {
				conversation: { enabled: false },
				reference: { enabled: true },
				structured: { enabled: false },
			},
			mongodb: {
				uri: URI,
				database: DB_NAME,
				collectionPrefix: PREFIX,
				deploymentProfile: "atlas-local-preview",
				embeddingMode: "automated",
				kb: { enabled: true },
				episodes: { enabled: false },
				graph: { enabled: false },
				queryRewriting: { enabled: false },
				reranking: { enabled: false },
				// Keep the initial search cache-disabled even on pre-removal
				// code (HEAD resolves cache.enabled to true unless told
				// otherwise), so no old read/write path can add or refresh a
				// row before the legacy row below is pinned and asserted.
				// Legacy serving is re-enabled explicitly just before the
				// post-removal lookup.
				cache: { enabled: false },
				relevance: {
					enabled: false,
					telemetry: { enabled: false },
				},
			},
		},
	}
	const config = resolveMemoryBackendConfig({ cfg, agentId: READER_ID })
	if (!config.mongodb) {
		throw new Error("expected resolved MongoDB configuration")
	}
	// The environment can override reranking. Keep this database-only proof
	// independent of external providers.
	config.mongodb.reranking.enabled = false

	const reader = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		client,
		db,
		prefix: PREFIX,
		agentId: READER_ID,
		workspaceDir: process.cwd(),
		agentScopeRef: `agent:${READER_ID}`,
		workspaceScopeRef: `workspace:${process.cwd()}`,
		capabilities: NO_ATLAS_SEARCH,
		nativeBitemporalVectorPrefilter: false,
		config,
		relevance: null,
		accessTracker: null,
		lastSearchMode: "legacy",
		dirty: true,
	}) as MongoDBMemoryManager
	return { reader, mongo: config.mongodb }
}

beforeAll(async () => {
	client = new MongoClient(URI, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
	})
	await client.connect()
	db = client.db(DB_NAME)
	await ensureCollections(db, PREFIX)
	await ensureStandardIndexes(db, PREFIX)
}, TIMEOUT)

afterAll(async () => {
	try {
		if (db) {
			await db.dropDatabase()
			const listed = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true, filter: { name: DB_NAME } })
			expect(
				listed.databases.length,
				"disposable database must be absent after teardown",
			).toBe(0)
		}
	} finally {
		await client?.close()
	}
}, TIMEOUT)

describe("result-cache removal (live MongoDB, disposable database)", () => {
	it(
		"ignores a surviving shared-reader cache row and erases it as legacy data",
		async () => {
			const document: KBDocument = {
				title: "Shared release handbook",
				content: SOURCE_TEXT,
				source: {
					type: "manual",
					importedBy: "api",
				},
				hash: createHash("sha256").update(SOURCE_TEXT).digest("hex"),
			}
			const ownerScope = {
				agentId: OWNER_ID,
				scope: "global" as const,
				scopeRef: "global",
			}
			const ingest = await ingestToKB({
				db,
				prefix: PREFIX,
				scope: ownerScope,
				documents: [document],
				embeddingMode: "automated",
				client,
			})
			expect(ingest).toMatchObject({
				documentsProcessed: 1,
				skipped: 0,
				errors: [],
			})

			const source = await kbCollection(db, PREFIX).findOne({
				agentId: OWNER_ID,
				scopeRef: "global",
				title: document.title,
			})
			expect(source).not.toBeNull()
			const sourceId = String(source?._id)

			const { reader, mongo } = readerManager()
			// Pin control: the legacy row below is keyed to HEAD's exact
			// serving identity for this manager, so assert every resolved
			// value the key folds in. A default drift must fail here
			// (setup), not silently change what the regression pins.
			expect(mongo.cache.enabled).toBe(false)
			expect(mongo.queryEmbeddingModel).toBe("voyage-4-large")
			expect(mongo.conversationEvidenceMode).toBe("parallel")
			expect(mongo.fusionMethod).toBe("scoreFusion")
			expect(mongo.embeddingMode).toBe("automated")
			expect(mongo.numCandidates).toBe(500)
			expect(mongo.kb.enabled).toBe(true)
			expect(mongo.graph).toMatchObject({ enabled: false, maxGraphDepth: 2 })
			expect(mongo.episodes.enabled).toBe(false)
			expect(mongo.queryRewriting).toMatchObject({
				enabled: false,
				method: "synonym-expansion",
				maxTokens: 128,
			})
			expect(mongo.reranking).toMatchObject({
				enabled: false,
				model: "rerank-2.5",
				topN: 20,
				minScore: 0.01,
				recencyBoost: 0.2,
				accessBoost: 0.2,
				temporalProximityBoost: 0.1,
			})
			expect(mongo.reranking.instruction).toBeUndefined()
			expect(mongo.sources.conversation.enabled).toBe(false)
			expect(mongo.sources.reference.enabled).toBe(true)
			expect(mongo.sources.structured.enabled).toBe(false)

			const beforeRemoval = await reader.search(QUERY, {
				scope: "global",
				scopeRef: "global",
				minScore: 0,
			})
			expect(
				beforeRemoval.some((result) => result.snippet === SOURCE_TEXT),
			).toBe(true)

			const now = new Date()
			const legacyCache = queryCacheCollection(db, PREFIX)
			// The row must be one the removed cache WOULD have served for this
			// exact search — otherwise "search ignores it" proves nothing.
			// queryHash/keySuffix are pinned literals equal to HEAD's
			// hashQuery(normalizeQuery(QUERY), keyParams) (HEAD
			// mongodb-query-cache.ts, search() seam) for this manager's
			// resolved config: maxResults 10 (default), minScore 0,
			// voyage-4-large, parallel evidence, scoreFusion, reranker
			// disabled (rerank-2.5/20/0.01/0.2/0.2/0.1), reference-only
			// sources, automated embedding, numCandidates 500, graph
			// 0|depth 2, episodes off, rewrite 0|synonym-expansion|128.
			await legacyCache.insertOne({
				queryHash:
					"03105e40186b4b25ca0ca5e06e6a5adf17e7c47e9f335413aaacf78b2ed1a3a0",
				keySuffix:
					'k=10;s=0;q=voyage-4-large;e=parallel;f=scoreFusion;r=0|rerank-2.5|20|0.01||0.2|0.2|0.1;a={"conversation":false,"reference":true,"structured":false};b=automated;n=500;g=0|2;i=0;w=0|synonym-expansion|128',
				queryNorm: QUERY,
				agentId: READER_ID,
				scope: "global",
				scopeRef: "global",
				results: [
					{
						path: "kb:shared-release-handbook",
						score: 1,
						snippet: SOURCE_TEXT,
						source: "reference",
					},
				],
				pathUsed: "kb",
				sourceScope: "kb",
				createdAt: now,
				expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
				hitCount: 0,
				lastHitAt: now,
			})

			expect(
				await removeKBDocument(db, PREFIX, sourceId, ownerScope, client),
			).toBe(true)
			expect(
				await kbCollection(db, PREFIX).countDocuments({ _id: sourceId }),
			).toBe(0)
			expect(
				await kbChunksCollection(db, PREFIX).countDocuments({
					docId: sourceId,
				}),
			).toBe(0)
			expect(
				await legacyCache.countDocuments({
					agentId: READER_ID,
					scopeRef: "global",
				}),
			).toBe(1)

			// Re-enable legacy serving only now, immediately before the
			// post-removal lookup: on pre-removal code this re-arms the
			// serving seam so the surviving row is eligible for exactly this
			// search; on removed code the deprecated field is inert because
			// no seam reads it. The initial search above stayed
			// cache-disabled, so an old write path could not add or refresh
			// a row ahead of this proof.
			mongo.cache.enabled = true

			const afterRemoval = await reader.search(QUERY, {
				scope: "global",
				scopeRef: "global",
				minScore: 0,
			})
			expect(afterRemoval).toEqual([])
			expect(
				await legacyCache.countDocuments({
					agentId: READER_ID,
					scopeRef: "global",
				}),
			).toBe(1)
			// Both searches ran while the row survived, yet it was never
			// adopted: no hit recorded, no write path refreshed it, and its
			// sentinel payload was never served (afterRemoval === []).
			expect(
				await legacyCache.findOne({
					agentId: READER_ID,
					scopeRef: "global",
				}),
			).toMatchObject({ hitCount: 0, lastHitAt: now })

			const erasure = await deleteAllForAgent({
				db,
				prefix: PREFIX,
				agentId: READER_ID,
			})
			expect(
				erasure.receipts.find(
					(receipt) => receipt.collection === "query_cache",
				),
			).toMatchObject({ deleted: 1 })
			expect(await legacyCache.countDocuments({ agentId: READER_ID })).toBe(0)
		},
		TIMEOUT,
	)
})
