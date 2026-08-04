/**
 * MongoDB E2E tests — requires a running MongoDB 8.2+ instance.
 *
 * Run manually:
 *   MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true" \
 *     pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts --reporter=verbose
 *
 * These tests exercise the real MongoDB driver and server operations.
 * They are useful both for the supported atlas-local-preview path and for
 * degraded behavior when Search is unavailable on the test server.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MongoClient, type Db } from "mongodb"
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { materializeEpisode, searchEpisodes } from "./mongodb-episodes.js"
import { writeEvent } from "./mongodb-events.js"
import {
	upsertEntity,
	upsertRelation,
	upsertEntityLink,
	setEntityLinkStatus,
	getEntityLinks,
	expandGraph,
} from "./mongodb-graph.js"
import { getV2Status } from "./mongodb-manager.js"
import { backfillEventsFromChunks } from "./mongodb-migration.js"
import {
	planRetrieval,
	type RetrievalPath,
} from "./mongodb-retrieval-planner.js"
import {
	chunksCollection,
	eventsCollection,
	entitiesCollection,
	entityLinksCollection,
	relationsCollection,
	episodesCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
} from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true",
)
const TEST_DB = "memongo_e2e_test"
const TEST_PREFIX = "e2e_"
const _EXPECTED_COLLECTION_SUFFIXES = [
	"chunks",
	"files",
	"meta",
	"knowledge_base",
	"kb_chunks",
	"structured_mem",
	"structured_mem_revisions",
	"procedures",
	"procedure_revisions",
	"relevance_runs",
	"relevance_artifacts",
	"relevance_regressions",
	"events",
	"entities",
	"relations",
	"entity_links",
	"episodes",
	"ingest_runs",
	"projection_runs",
	"query_cache",
	"memory_telemetry",
	"memory_mutations",
	"lane_coverage",
	"consolidation_runs",
	// Added after this file was last able to run. The nightly job that would
	// have caught the drift was passing a glob vitest treats as a substring
	// filter, so it matched no files and never executed a single e2e test.
	"access_events",
	"memory_jobs",
	"memory_quarantine",
	"recall_traces",
	"session_chunks",
] as const
// P3.8: −3 retired redundant indexes (idx_chunks_path, idx_structured_agentid,
// idx_relations_agent_scope_scoperef), +3 ESR compounds, +1 relationId locator.
const _EXPECTED_STANDARD_INDEX_COUNT = 91

let client: MongoClient
let db: Db
let tmpDir: string

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
	client = new MongoClient(TEST_URI, {
		serverSelectionTimeoutMS: 5_000,
		connectTimeoutMS: 5_000,
	})
	await client.connect()
	await client.db("admin").command({ ping: 1 })
	db = client.db(TEST_DB)
	// Clean slate
	await db.dropDatabase()
})

afterAll(async () => {
	if (db) {
		await db.dropDatabase()
	}
	if (client) {
		await client.close()
	}
})

beforeEach(async () => {
	// Drop and recreate for each test group that needs fresh state
})

// ---------------------------------------------------------------------------
// Helper: create workspace with memory files
// ---------------------------------------------------------------------------

async function _setupWorkspace(files: Record<string, string>): Promise<string> {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-e2e-"))
	const memDir = path.join(tmpDir, "memory")
	await fs.mkdir(memDir, { recursive: true })
	for (const [name, content] of Object.entries(files)) {
		await fs.writeFile(path.join(memDir, name), content, "utf-8")
	}
	return tmpDir
}

async function _cleanupWorkspace(): Promise<void> {
	if (tmpDir) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	}
}

// ===========================================================================
// v2: Structured Memory with Scope
// ===========================================================================

describe("E2E v2: structured memory with scope", () => {
	const agentId = `e2e-struct-${randomUUID()}`

	beforeAll(async () => {
		await structuredMemCollection(db, TEST_PREFIX).deleteMany({})
		await structuredMemRevisionsCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("writes structured entries with different scopes", async () => {
		// 1. Write entry with scope "user"
		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "preference",
				key: "theme",
				value: "dark mode preferred",
				agentId,
				scope: "user",
				userId: `user-${agentId}`,
			},
			embeddingMode: "automated",
		})

		// 2. Write entry with scope "session"
		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "preference",
				key: "language",
				value: "TypeScript is the default",
				agentId,
				scope: "session",
				sessionId: `session-${agentId}`,
			},
			embeddingMode: "automated",
		})

		// 3. Query with scope "user" -> only user-scoped result
		const col = structuredMemCollection(db, TEST_PREFIX)
		const userScoped = await col.find({ agentId, scope: "user" }).toArray()
		expect(userScoped.length).toBe(1)
		expect(userScoped[0].key).toBe("theme")

		// 4. Query without scope filter -> both results
		const allScoped = await col.find({ agentId }).toArray()
		expect(allScoped.length).toBe(2)
	})

	it("preserves superseded structured values in the revisions collection", async () => {
		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "decision",
				key: "database",
				value: "Use Postgres",
				agentId,
				scope: "agent",
			},
			embeddingMode: "automated",
			client,
		})

		await writeStructuredMemory({
			db,
			prefix: TEST_PREFIX,
			entry: {
				type: "decision",
				key: "database",
				value: "Use MongoDB",
				agentId,
				scope: "agent",
			},
			embeddingMode: "automated",
			client,
		})

		const current = await structuredMemCollection(db, TEST_PREFIX).findOne({
			agentId,
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			type: "decision",
			key: "database",
		})
		const revisions = await structuredMemRevisionsCollection(db, TEST_PREFIX)
			.find({
				agentId,
				scope: "agent",
				scopeRef: `agent:${agentId}`,
				type: "decision",
				key: "database",
			})
			.toArray()

		expect(current?.value).toBe("Use MongoDB")
		expect(current?.revision).toBe(2)
		expect(revisions).toHaveLength(1)
		expect(revisions[0]?.value).toBe("Use Postgres")
		expect(revisions[0]?.revision).toBe(1)
		expect(revisions[0]?.supersededAt).toBeInstanceOf(Date)
	})
})

// ===========================================================================
// v2: Graph Expansion
// ===========================================================================

describe("E2E v2: graph expansion", () => {
	const agentId = `e2e-graph-${randomUUID()}`
	const romEntityId = randomUUID()
	const projectEntityId = randomUUID()

	beforeAll(async () => {
		await entitiesCollection(db, TEST_PREFIX).deleteMany({})
		await entityLinksCollection(db, TEST_PREFIX).deleteMany({})
		await relationsCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("creates entities and relations, expands graph via $graphLookup", async () => {
		// 1. upsertEntity("Rom", person)
		const romResult = await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: romEntityId,
				name: "Rom",
				type: "person",
				agentId,
				scope: "agent",
				updatedAt: new Date(),
			},
		})
		expect(romResult.upserted).toBe(true)

		// 2. upsertEntity("Memongo", project)
		const projectResult = await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: projectEntityId,
				name: "Memongo",
				type: "project",
				agentId,
				scope: "agent",
				updatedAt: new Date(),
			},
		})
		expect(projectResult.upserted).toBe(true)

		// 3. upsertRelation(Rom -> works_on -> Memongo)
		const relResult = await upsertRelation({
			db,
			prefix: TEST_PREFIX,
			relation: {
				fromEntityId: romEntityId,
				toEntityId: projectEntityId,
				type: "works_on",
				agentId,
				scope: "agent",
				updatedAt: new Date(),
			},
		})
		expect(relResult.upserted).toBe(true)

		// 4. expandGraph from Rom entityId -> finds Memongo
		const expansion = await expandGraph({
			db,
			prefix: TEST_PREFIX,
			entityId: romEntityId,
			agentId,
			maxDepth: 2,
		})

		expect(expansion).not.toBeNull()
		expect(expansion?.rootEntity.name).toBe("Rom")
		expect(expansion?.connections.length).toBe(1)
		expect(expansion?.connections[0].entity.name).toBe("Memongo")
		expect(expansion?.connections[0].relation.type).toBe("works_on")
		expect(expansion?.connections[0].depth).toBe(0)
	})

	it("stores candidate links as reversible records and keeps same-name entities isolated by scope", async () => {
		const agentSessionA = `session-a-${randomUUID().slice(0, 8)}`
		const agentSessionB = `session-b-${randomUUID().slice(0, 8)}`
		const alexA = randomUUID()
		const alexB = randomUUID()

		await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: alexA,
				name: "Alex",
				type: "person",
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionA}`,
				updatedAt: new Date(),
			},
		})
		await upsertEntity({
			db,
			prefix: TEST_PREFIX,
			entity: {
				entityId: alexB,
				name: "Alex",
				type: "person",
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionB}`,
				updatedAt: new Date(),
			},
		})

		const link = await upsertEntityLink({
			db,
			prefix: TEST_PREFIX,
			link: {
				fromEntityId: romEntityId,
				toEntityId: projectEntityId,
				linkType: "candidate_same",
				status: "active",
				confidence: 0.55,
				agentId,
				scope: "agent",
				provenance: { heuristic: "manual-test" },
			},
		})
		expect(link.linkId).toBeTruthy()

		const links = await getEntityLinks({
			db,
			prefix: TEST_PREFIX,
			agentId,
			entityId: romEntityId,
			status: "active",
		})
		expect(links.some((entry) => entry.linkType === "candidate_same")).toBe(
			true,
		)

		const changed = await setEntityLinkStatus({
			db,
			prefix: TEST_PREFIX,
			agentId,
			scope: "agent",
			fromEntityId: romEntityId,
			toEntityId: projectEntityId,
			linkType: "candidate_same",
			status: "rejected",
		})
		expect(changed).toBe(true)

		const activeLinks = await getEntityLinks({
			db,
			prefix: TEST_PREFIX,
			agentId,
			entityId: romEntityId,
			status: "active",
		})
		expect(
			activeLinks.some((entry) => entry.linkType === "candidate_same"),
		).toBe(false)

		const sessionAEntities = await entitiesCollection(db, TEST_PREFIX)
			.find({
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionA}`,
				name: "Alex",
			})
			.toArray()
		const sessionBEntities = await entitiesCollection(db, TEST_PREFIX)
			.find({
				agentId,
				scope: "session",
				scopeRef: `session:${agentSessionB}`,
				name: "Alex",
			})
			.toArray()
		expect(sessionAEntities).toHaveLength(1)
		expect(sessionBEntities).toHaveLength(1)
		expect(sessionAEntities[0]?.entityId).not.toBe(
			sessionBEntities[0]?.entityId,
		)
	})
})

// ===========================================================================
// v2: Episode Materialization
// ===========================================================================

describe("E2E v2: episode materialization", () => {
	const agentId = `e2e-episode-${randomUUID()}`
	const dayStart = new Date("2026-03-15T00:00:00Z")
	const dayEnd = new Date("2026-03-15T23:59:59Z")

	beforeAll(async () => {
		await eventsCollection(db, TEST_PREFIX).deleteMany({})
		await episodesCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("writes events, materializes episode, searches episode", async () => {
		// 1. Write 5 events over a day
		for (let i = 0; i < 5; i++) {
			await writeEvent({
				db,
				prefix: TEST_PREFIX,
				event: {
					agentId,
					role: i % 2 === 0 ? "user" : "assistant",
					body: `Message number ${i + 1} about Memongo memory architecture`,
					scope: "agent",
					timestamp: new Date(
						`2026-03-15T${String(8 + i).padStart(2, "0")}:00:00Z`,
					),
				},
			})
		}

		// Verify events were written
		const eventCount = await eventsCollection(db, TEST_PREFIX).countDocuments({
			agentId,
		})
		expect(eventCount).toBe(5)

		// 2. Materialize episode with mock summarizer
		const episode = await materializeEpisode({
			db,
			prefix: TEST_PREFIX,
			agentId,
			type: "daily",
			timeRange: { start: dayStart, end: dayEnd },
			summarizer: async (events) => ({
				title: "Daily Memongo Discussion",
				summary: `Discussion about Memongo memory architecture with ${events.length} messages`,
				tags: ["memongo", "memory"],
			}),
		})

		// 3. Verify episode created with correct sourceEventCount
		expect(episode).not.toBeNull()
		expect(episode?.sourceEventCount).toBe(5)
		expect(episode?.title).toBe("Daily Memongo Discussion")
		expect(episode?.type).toBe("daily")
		expect(episode?.tags).toEqual(["memongo", "memory"])

		// 4. searchEpisodes finds the episode
		const searchResults = await searchEpisodes({
			db,
			prefix: TEST_PREFIX,
			query: "Memongo",
			agentId,
		})

		expect(searchResults.length).toBe(1)
		expect(searchResults[0].title).toBe("Daily Memongo Discussion")
	})
})

// ===========================================================================
// v2: Migration Backfill
// ===========================================================================

describe("E2E v2: migration backfill", () => {
	const agentId = `e2e-migrate-${randomUUID()}`

	beforeAll(async () => {
		await eventsCollection(db, TEST_PREFIX).deleteMany({})
		await chunksCollection(db, TEST_PREFIX).deleteMany({})
	})

	it("backfills events from existing v1 chunks", async () => {
		// 1. Insert chunks directly (simulating v1 state) with source "memory"
		const chunksCol = chunksCollection(db, TEST_PREFIX)
		await chunksCol.insertMany([
			{
				_id: "memory/notes.md:1:5" as unknown as import("mongodb").InferIdType<
					import("mongodb").Document
				>,
				path: "memory/notes.md",
				text: "Project notes about Memongo v1 architecture",
				hash: "abc123hash",
				source: "conversation",
				startLine: 1,
				endLine: 5,
				model: "none",
				updatedAt: new Date("2026-03-14T10:00:00Z"),
			},
			{
				_id: "memory/decisions.md:1:3" as unknown as import("mongodb").InferIdType<
					import("mongodb").Document
				>,
				path: "memory/decisions.md",
				text: "Decision to use MongoDB-only backend",
				hash: "def456hash",
				source: "conversation",
				startLine: 1,
				endLine: 3,
				model: "none",
				updatedAt: new Date("2026-03-14T11:00:00Z"),
			},
		])

		// 2. Run backfillEventsFromChunks
		const result = await backfillEventsFromChunks({
			db,
			prefix: TEST_PREFIX,
			agentId,
		})

		expect(result.chunksProcessed).toBe(2)
		expect(result.eventsCreated).toBe(2)
		expect(result.skipped).toBe(0)

		// 3. Verify events created with correct body/timestamp
		const eventsCol = eventsCollection(db, TEST_PREFIX)
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		const events = await eventsCol
			.find({ agentId })
			.sort({ timestamp: 1 })
			.toArray()
		expect(events.length).toBe(2)
		expect(events[0].body).toBe("Project notes about Memongo v1 architecture")
		expect(events[1].body).toBe("Decision to use MongoDB-only backend")

		// 4. Run backfill again -> verify idempotent (no duplicates)
		const result2 = await backfillEventsFromChunks({
			db,
			prefix: TEST_PREFIX,
			agentId,
		})

		expect(result2.chunksProcessed).toBe(2)
		expect(result2.eventsCreated).toBe(0) // idempotent: no new events
		expect(result2.skipped).toBe(0)

		// Verify still only 2 events
		const eventCount = await eventsCol.countDocuments({ agentId })
		expect(eventCount).toBe(2)
	})
})

// ===========================================================================
// v2: Retrieval Planner
// ===========================================================================

describe("E2E v2: retrieval planner", () => {
	it("plans retrieval paths based on query and config", () => {
		const allPaths: Set<RetrievalPath> = new Set([
			"structured",
			"raw-window",
			"graph",
			"hybrid",
			"kb",
			"episodic",
		])

		// 1. Query mentioning entities + keywords
		const plan = planRetrieval("what does Rom work on today in the docs", {
			availablePaths: allPaths,
			knownEntityNames: ["Rom"],
			hasGraphData: true,
			hasEpisodes: true,
		})

		// 2. Verify paths include expected retrieval types
		// "Rom" triggers graph, "today" triggers raw-window, "docs" triggers kb
		expect(plan.paths).toContain("graph")
		expect(plan.paths).toContain("raw-window")
		expect(plan.paths).toContain("kb")

		// 3. Verify confidence is high (multiple strong signals)
		expect(plan.confidence).toBe("high")
		expect(plan.reasoning.length).toBeGreaterThan(0)
	})
})

// ===========================================================================
// v2: Health Semantics
// ===========================================================================

describe("E2E v2: health semantics", () => {
	const agentId = `e2e-health-${randomUUID()}`

	beforeAll(async () => {
		for (const suffix of [
			"events",
			"episodes",
			"entities",
			"relations",
			"ingest_runs",
			"projection_runs",
			"relevance_runs",
		]) {
			await db.collection(`${TEST_PREFIX}${suffix}`).deleteMany({ agentId })
		}
	})

	it("distinguishes healthy, degraded, and unavailable states in v2 status", async () => {
		await eventsCollection(db, TEST_PREFIX).insertOne({
			eventId: `evt-${randomUUID()}`,
			agentId,
			role: "user",
			body: "Health status probe",
			scope: "agent",
			scopeRef: `agent:${agentId}`,
			timestamp: new Date(),
		})

		await db.collection(`${TEST_PREFIX}ingest_runs`).insertOne({
			runId: `ingest-${randomUUID()}`,
			agentId,
			source: "event-write",
			status: "failed",
			itemsProcessed: 0,
			itemsFailed: 1,
			durationMs: 12,
			ts: new Date(),
		})

		await db.collection(`${TEST_PREFIX}projection_runs`).insertMany([
			{
				runId: `proj-${randomUUID()}`,
				agentId,
				projectionType: "chunks",
				status: "ok",
				itemsProjected: 1,
				durationMs: 10,
				ts: new Date(Date.now() - 10 * 60 * 1000),
			},
			{
				runId: `proj-${randomUUID()}`,
				agentId,
				projectionType: "entities",
				status: "failed",
				itemsProjected: 0,
				durationMs: 10,
				ts: new Date(),
			},
			{
				runId: `proj-${randomUUID()}`,
				agentId,
				projectionType: "relations",
				status: "ok",
				itemsProjected: 0,
				durationMs: 10,
				ts: new Date(),
			},
		])

		await db.collection(`${TEST_PREFIX}relevance_runs`).insertOne({
			runId: `relevance-${randomUUID()}`,
			agentId,
			ts: new Date(),
			sourceScope: "memory",
			latencyMs: 22,
			status: "degraded",
			queryHash: "hash",
			queryRedacted: "xxxx",
			profile: "test",
			capabilities: {},
			topK: 5,
			hitSources: [],
			sampleRate: 0.5,
			sampled: true,
		})

		const status = await getV2Status(db, TEST_PREFIX, agentId)

		expect(status.health.canonicalIngest).toBe("canonical-ingest-failed")
		expect(status.health.retrieval).toBe("retrieval-degraded")
		expect(status.health.recentNoRelevantResults).toBe(true)
		expect(status.health.derivedProducts.chunks).toBe("projection-behind")
		expect(status.health.derivedProducts.entities).toBe(
			"derived-product-unavailable",
		)
		expect(status.health.derivedProducts.episodes).toBe("health-uncertain")
		expect(status.health.overall).toBe("degraded")
		expect(status.health.diagnostics).toEqual(
			expect.arrayContaining([
				"retrieval-degraded",
				"no-relevant-results",
				"canonical-ingest-failed",
				"projection-behind:chunks",
				"derived-product-unavailable:entities",
				"health-uncertain:episodes",
			]),
		)
	})
})

// Supermemory-inspired feature tests live in real-e2e-v2.e2e.test.ts (Phases 14-17)
// which uses the realistic multi-session conversation dataset for proper integration testing.
