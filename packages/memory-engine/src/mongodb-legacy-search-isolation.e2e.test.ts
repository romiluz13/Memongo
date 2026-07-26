/**
 * legacySearch tenant isolation (issue #62 / L3).
 *
 * legacySearch is the fallback searchV2 drops into whenever the planner returns
 * no results — an everyday condition, not an error path. Three of its four
 * lanes used to drop the caller's scope entirely, so the fallback read wider
 * than the search it was standing in for.
 *
 * This runs against a real MongoDB with every Atlas Search capability off, so
 * mongoSearch/searchKB/searchStructuredMemory take their $text-or-regex
 * fallback paths — reachable on a plain replica set without mongot. Those paths
 * carry the same in-document filter as the vector/keyword paths, so proving
 * isolation here proves the filter, which is the thing that was broken.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e:tier-a
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { hashText } from "./internal.js"
import { ingestToKB, type KBDocument } from "./mongodb-kb.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	chunksCollection,
	type DetectedCapabilities,
	ensureCollections,
	ensureStandardIndexes,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"
import type { MemorySearchResult } from "./types.js"

const NO_ATLAS_SEARCH: DetectedCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_legacy_iso_${randomUUID().slice(0, 8)}`
// SHARED prefix: both tenants land in the same physical collections, so the
// only thing that can isolate them is the in-document scope filter.
const PREFIX = "shared_"

const AGENT = `agent-${randomUUID().slice(0, 8)}`
const ALICE_REF = "user:alice"
const BOB_REF = "user:bob"
// The needle both tenants' documents match, so a dropped filter is visible as
// an extra result rather than as a scoring difference.
const QUERY = "quokkaberry"

let client: MongoClient
let db: Db

function harness(workspaceDir = process.cwd()): MongoDBMemoryManager {
	return {
		db,
		client,
		agentId: AGENT,
		prefix: PREFIX,
		workspaceDir,
		agentScopeRef: `agent:${AGENT}`,
		workspaceScopeRef: `workspace:${workspaceDir}`,
		capabilities: NO_ATLAS_SEARCH,
		config: {
			mongodb: {
				embeddingMode: "automated",
				numCandidates: 50,
				fusionMethod: "application",
				kb: { enabled: true },
				sources: {
					conversation: { enabled: true },
					reference: { enabled: true },
					structured: { enabled: true },
				},
				graph: { enabled: false },
				episodes: { enabled: false },
				reranking: {},
			},
		},
		resolveSearchIdentity:
			MongoDBMemoryManager.prototype["resolveSearchIdentity"],
		buildConversationChunkFilter:
			MongoDBMemoryManager.prototype["buildConversationChunkFilter"],
		buildBridgeChunkFilter:
			MongoDBMemoryManager.prototype["buildBridgeChunkFilter"],
		buildBridgeChunkFilterForIdentity:
			MongoDBMemoryManager.prototype["buildBridgeChunkFilterForIdentity"],
		getBridgeChunkBudget:
			MongoDBMemoryManager.prototype["getBridgeChunkBudget"],
		detectSearchMethod: MongoDBMemoryManager.prototype["detectSearchMethod"],
		setLastSearchMode: () => undefined,
		recordSearchAccess: () => undefined,
	} as unknown as MongoDBMemoryManager
}

function chunkDoc(scopeRef: string, body: string) {
	return {
		agentId: AGENT,
		scope: "user",
		scopeRef,
		source: "conversation",
		status: "active",
		path: `events/${randomUUID()}`,
		hash: hashText(body + scopeRef),
		text: body,
		startLine: 0,
		endLine: 0,
		updatedAt: new Date(),
	}
}

function structuredDoc(scopeRef: string, body: string) {
	return {
		agentId: AGENT,
		scope: "user",
		scopeRef,
		type: "fact",
		key: `key-${randomUUID().slice(0, 8)}`,
		value: body,
		text: body,
		content: body,
		state: "active",
		salience: "high",
		revision: 1,
		currentFrom: new Date("2020-01-01T00:00:00Z"),
		updatedAt: new Date(),
	}
}

function kbDoc(title: string, content: string): KBDocument {
	return {
		title,
		content,
		source: { type: "manual", importedBy: "api" },
		hash: hashText(content),
	}
}

beforeAll(async () => {
	client = new MongoClient(TEST_URI)
	await client.connect()
	db = client.db(TEST_DB)
	await ensureCollections(db, PREFIX)
	await ensureStandardIndexes(db, PREFIX)

	await chunksCollection(db, PREFIX).insertMany([
		chunkDoc(ALICE_REF, `alice owns a ${QUERY} plantation`),
		chunkDoc(BOB_REF, `bob owns a ${QUERY} plantation`),
	] as never)
	await structuredMemCollection(db, PREFIX).insertMany([
		structuredDoc(ALICE_REF, `alice prefers ${QUERY} jam`),
		structuredDoc(BOB_REF, `bob prefers ${QUERY} jam`),
	] as never)
	for (const who of ["alice", "bob"] as const) {
		await ingestToKB({
			db,
			prefix: PREFIX,
			embeddingMode: "automated",
			scope: { agentId: AGENT, scope: "user", userId: who },
			documents: [
				kbDoc(`${who} notes`, `${who} researched the ${QUERY} harvest`),
			],
		})
	}
}, 120_000)

afterAll(async () => {
	await db?.dropDatabase().catch(() => undefined)
	await client?.close()
})

async function legacySearchAs(scopeRef: string): Promise<MemorySearchResult[]> {
	return (await MongoDBMemoryManager.prototype["legacySearch"].call(
		harness(),
		QUERY,
		{ maxResults: 20, minScore: 0, scope: "user", scopeRef },
	)) as MemorySearchResult[]
}

describe("legacySearch tenant isolation", () => {
	it("does not return another tenant's conversation, KB, or structured hits", async () => {
		const results = await legacySearchAs(ALICE_REF)

		// The fallback must still find alice's own evidence — otherwise this test
		// would pass trivially on a search that returns nothing at all.
		expect(results.length).toBeGreaterThan(0)

		const leaked = results.filter((r) =>
			(r.snippet ?? "").toLowerCase().includes("bob"),
		)
		expect(leaked.map((r) => r.snippet)).toEqual([])
	})

	it("returns each tenant only its own evidence", async () => {
		const alice = await legacySearchAs(ALICE_REF)
		const bob = await legacySearchAs(BOB_REF)

		expect(
			alice.every((r) => !(r.snippet ?? "").toLowerCase().includes("bob")),
		).toBe(true)
		expect(
			bob.every((r) => !(r.snippet ?? "").toLowerCase().includes("alice")),
		).toBe(true)
	})
})
