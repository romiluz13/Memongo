/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import {
	assertIndexBudget,
	detectCapabilities,
	ensureCollections,
	ensureSearchIndexes,
	ensureStandardIndexes,
	chunksCollection,
	filesCollection,
	embeddingCacheCollection,
	metaCollection,
	getExpectedSearchIndexTargets,
	isSearchIndexTypeCompatible,
	isSearchIndexQueryable,
	waitForSearchCapabilities,
	kbCollection,
	kbChunksCollection,
	structuredMemCollection,
	relevanceRunsCollection,
	relevanceArtifactsCollection,
	relevanceRegressionsCollection,
	eventsCollection,
	entitiesCollection,
	entityLinksCollection,
	relationsCollection,
	episodesCollection,
	ingestRunsCollection,
	projectionRunsCollection,
	queryCacheCollection,
	resolveSearchIndexReadinessTiming,
	telemetryCollection,
	accessEventsCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
	waitForSearchIndexesQueryable,
} from "./mongodb-schema.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockCollection(name: string): Collection {
	return {
		collectionName: name,
		createIndex: vi.fn(async () => name),
		createSearchIndex: vi.fn(async () => name),
		updateSearchIndex: vi.fn(async () => undefined),
		dropIndex: vi.fn(async () => ({ ok: 1 })),
		listSearchIndexes: vi.fn(() => ({ toArray: async () => [] })),
		aggregate: vi.fn(() => ({ toArray: async () => [] })),
	} as unknown as Collection
}

function mockDb(existingCollections: string[] = []): Db {
	const collections = new Map<string, Collection>()

	const db = {
		collection: vi.fn((name: string) => {
			if (!collections.has(name)) {
				collections.set(name, mockCollection(name))
			}
			return collections.get(name)!
		}),
		command: vi.fn(async () => ({ ok: 1 })),
		createCollection: vi.fn(async (name: string) => {
			collections.set(name, mockCollection(name))
			return collections.get(name)!
		}),
		listCollections: vi.fn(() => ({
			map: vi.fn(() => ({
				toArray: async () => existingCollections,
			})),
		})),
	} as unknown as Db

	return db
}

// ---------------------------------------------------------------------------
// Collection helper tests
// ---------------------------------------------------------------------------

describe("collection helpers", () => {
	it("chunksCollection returns prefixed collection", () => {
		const db = mockDb()
		chunksCollection(db, "test_")
		expect(db.collection).toHaveBeenCalledWith("test_chunks")
	})

	it("filesCollection returns prefixed collection", () => {
		const db = mockDb()
		filesCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_files")
	})

	it("embeddingCacheCollection returns prefixed collection", () => {
		const db = mockDb()
		embeddingCacheCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_embedding_cache")
	})

	it("metaCollection returns prefixed collection", () => {
		const db = mockDb()
		metaCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_meta")
	})

	it("kbCollection returns prefixed collection", () => {
		const db = mockDb()
		kbCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_knowledge_base")
	})

	it("kbChunksCollection returns prefixed collection", () => {
		const db = mockDb()
		kbChunksCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_kb_chunks")
	})

	it("structuredMemCollection returns prefixed collection", () => {
		const db = mockDb()
		structuredMemCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_structured_mem")
	})

	it("relevanceRunsCollection returns prefixed collection", () => {
		const db = mockDb()
		relevanceRunsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_relevance_runs")
	})

	it("relevanceArtifactsCollection returns prefixed collection", () => {
		const db = mockDb()
		relevanceArtifactsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_relevance_artifacts")
	})

	it("relevanceRegressionsCollection returns prefixed collection", () => {
		const db = mockDb()
		relevanceRegressionsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_relevance_regressions")
	})

	// v2 collection accessors (Phase 1)
	it("eventsCollection returns prefixed collection", () => {
		const db = mockDb()
		eventsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_events")
	})

	it("entitiesCollection returns prefixed collection", () => {
		const db = mockDb()
		entitiesCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_entities")
	})

	it("relationsCollection returns prefixed collection", () => {
		const db = mockDb()
		relationsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_relations")
	})

	it("entityLinksCollection returns prefixed collection", () => {
		const db = mockDb()
		entityLinksCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_entity_links")
	})

	it("episodesCollection returns prefixed collection", () => {
		const db = mockDb()
		episodesCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_episodes")
	})

	it("ingestRunsCollection returns prefixed collection", () => {
		const db = mockDb()
		ingestRunsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_ingest_runs")
	})

	it("projectionRunsCollection returns prefixed collection", () => {
		const db = mockDb()
		projectionRunsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_projection_runs")
	})
})

// ---------------------------------------------------------------------------
// Schema validation constants
// ---------------------------------------------------------------------------

describe("schema constants", () => {
	it("kb_chunks schema uses string docId, not objectId (F9)", async () => {
		// Verify by creating a collection with the schema and checking the validator
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbChunksCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_kb_chunks",
		)
		expect(kbChunksCall).toBeDefined()
		const validator = kbChunksCall![1]?.validator
		expect(validator.$jsonSchema.properties.docId.bsonType).toBe("string")
	})

	it("kb_chunks schema includes source field (F14)", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbChunksCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_kb_chunks",
		)
		expect(kbChunksCall).toBeDefined()
		const validator = kbChunksCall![1]?.validator
		expect(validator.$jsonSchema.properties.source).toBeDefined()
		expect(validator.$jsonSchema.properties.source.bsonType).toBe("string")
	})

	it("KB source.type enum uses 'manual' not 'text' (F16)", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_knowledge_base",
		)
		expect(kbCall).toBeDefined()
		const validator = kbCall![1]?.validator
		const sourceTypeEnum =
			validator.$jsonSchema.properties.source.properties.type.enum
		expect(sourceTypeEnum).toContain("manual")
		expect(sourceTypeEnum).not.toContain("text")
	})

	it("VALIDATED_COLLECTIONS includes all 7 new v2 collection schemas", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		// All v2 collections should be created with validators.
		for (const name of [
			"events",
			"entities",
			"relations",
			"entity_links",
			"episodes",
			"ingest_runs",
			"projection_runs",
		]) {
			const call = createCalls.find((c: unknown[]) => c[0] === `test_${name}`)
			expect(call, `expected test_${name} to be created`).toBeDefined()
			expect(
				call![1]?.validator,
				`expected test_${name} to have a validator`,
			).toBeDefined()
			expect(call![1]?.validator.$jsonSchema).toBeDefined()
		}
	})

	it("events schema has required scope enum field", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const eventsCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_events",
		)
		expect(eventsCall).toBeDefined()
		const schema = eventsCall![1]?.validator.$jsonSchema
		expect(schema.required).toContain("scope")
		expect(schema.properties.scope.enum).toEqual([
			"session",
			"user",
			"agent",
			"workspace",
			"tenant",
			"global",
		])
	})

	it("memory_quarantine collection is created with validator ()", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const qCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_memory_quarantine",
		)
		expect(qCall).toBeDefined()
		const schema = qCall![1]?.validator.$jsonSchema
		expect(schema.required).toContain("quarantineId")
		expect(schema.required).toContain("classification")
		expect(schema.required).toContain("matchedPatterns")
		expect(schema.required).toContain("status")
		// `classification` is tightly scoped — only injection-likely rows land here.
		expect(schema.properties.classification.enum).toEqual(["injection-likely"])
		// Lifecycle statuses for the pending → promoted / rejected flow.
		expect(schema.properties.status.enum).toEqual([
			"pending-review",
			"rejected",
			"promoted",
		])
	})

	it("events schema includes bi-temporal validAt + invalidAt ()", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const eventsCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_events",
		)
		expect(eventsCall).toBeDefined()
		const schema = eventsCall![1]?.validator.$jsonSchema
		// Bi-temporal  fields: validAt records when the assertion became
		// true; invalidAt (nullable) records when it stopped being true.
		expect(schema.properties.validAt).toBeDefined()
		expect(schema.properties.validAt.bsonType).toBe("date")
		expect(schema.properties.invalidAt).toBeDefined()
		// invalidAt accepts `date` OR null per the retrieval filter
		// `invalidAt IS NULL OR invalidAt > queryTime`.
		expect(schema.properties.invalidAt.bsonType).toEqual(["date", "null"])
	})

	it("chunks collection has polymorphic schema validation (F15)", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const chunksCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_chunks",
		)
		expect(chunksCall).toBeDefined()
		// F15: chunks uses oneOf for polymorphic validation (chunks + evidence)
		const schema = chunksCall![1]?.validator.$jsonSchema
		expect(schema).toBeDefined()
		expect(schema.oneOf).toHaveLength(2)
		// Branch 1: traditional chunks require path+hash
		expect(schema.oneOf[0].required).toContain("path")
		expect(schema.oneOf[0].required).toContain("text")
		expect(schema.oneOf[0].required).toContain("hash")
		// Branch 2: evidence docs require source
		expect(schema.oneOf[1].required).toContain("source")
		expect(schema.oneOf[1].required).toContain("text")
	})
})

// ---------------------------------------------------------------------------
// ensureCollections
// ---------------------------------------------------------------------------

describe("ensureCollections", () => {
	it("creates all collections when none exist, including both time series collections", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		// 30 = 29 baseline + 1 memory_quarantine (, )
		expect(db.createCollection).toHaveBeenCalledTimes(30)
		// Non-validated collections: called with name only
		expect(db.createCollection).toHaveBeenCalledWith("test_files")
		expect(db.createCollection).toHaveBeenCalledWith("test_embedding_cache")
		expect(db.createCollection).toHaveBeenCalledWith("test_meta")
		expect(db.createCollection).toHaveBeenCalledWith("test_session_chunks")
		// Validated collections: called with name + validator options (F15: chunks now validated)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_chunks",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_knowledge_base",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_kb_chunks",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_structured_mem",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_relevance_runs",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_relevance_artifacts",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_relevance_regressions",
			expect.objectContaining({ validationAction: "error" }),
		)
	})

	it("creates memory_evidence only when the evidence mirror is enabled", async () => {
		const previous = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		try {
			const db = mockDb([])
			await ensureCollections(db, "test_")
			expect(db.createCollection).toHaveBeenCalledWith(
				"test_memory_evidence",
				expect.objectContaining({ validationAction: "error" }),
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previous
			}
		}
	})

	it("does not refresh memory_evidence validation when the evidence mirror is disabled", async () => {
		const previous = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		try {
			const db = mockDb([])
			await ensureCollections(db, "test_")
			expect(db.command).not.toHaveBeenCalledWith(
				expect.objectContaining({ collMod: "test_memory_evidence" }),
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previous
			}
		}
	})

	it("skips already-existing collections", async () => {
		const db = mockDb(["test_chunks", "test_files"])
		await ensureCollections(db, "test_")
		// 28 = 30 new total - 2 skipped. 29 baseline + 1 memory_quarantine.
		expect(db.createCollection).toHaveBeenCalledTimes(28)
		expect(db.createCollection).toHaveBeenCalledWith("test_embedding_cache")
		expect(db.createCollection).toHaveBeenCalledWith("test_meta")
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_knowledge_base",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_kb_chunks",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_relevance_runs",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_relevance_artifacts",
			expect.objectContaining({ validationAction: "error" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_relevance_regressions",
			expect.objectContaining({ validationAction: "error" }),
		)
		// Note: test_chunks is already existing in this test case
	})

	it("does nothing when all collections exist", async () => {
		const db = mockDb([
			"oc_chunks",
			"oc_files",
			"oc_embedding_cache",
			"oc_meta",
			"oc_knowledge_base",
			"oc_kb_chunks",
			"oc_structured_mem",
			"oc_structured_mem_revisions",
			"oc_procedures",
			"oc_procedure_revisions",
			"oc_relevance_runs",
			"oc_relevance_artifacts",
			"oc_relevance_regressions",
			"oc_events",
			"oc_entities",
			"oc_relations",
			"oc_entity_links",
			"oc_episodes",
			"oc_ingest_runs",
			"oc_projection_runs",
			"oc_query_cache",
			"oc_memory_mutations",
			"oc_memory_telemetry",
			"oc_access_events",
			"oc_lane_coverage",
			"oc_consolidation_runs",
			"oc_recall_traces",
			"oc_memory_jobs",
			"oc_session_chunks",
			"oc_memory_quarantine",
		])
		await ensureCollections(db, "oc_")
		expect(db.createCollection).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// ensureStandardIndexes
// ---------------------------------------------------------------------------

describe("ensureStandardIndexes", () => {
	it("creates all standard indexes on chunks, embedding_cache, KB, and structured_mem", async () => {
		const db = mockDb()
		const count = await ensureStandardIndexes(db, "test_")

		const chunks = db.collection("test_chunks") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const cache = db.collection("test_embedding_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const kb = db.collection("test_knowledge_base") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const kbChunks = db.collection("test_kb_chunks") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const structured = db.collection("test_structured_mem") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const structuredRevisions = db.collection(
			"test_structured_mem_revisions",
		) as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const relevanceRuns = db.collection("test_relevance_runs") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const relevanceArtifacts = db.collection(
			"test_relevance_artifacts",
		) as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const relevanceRegressions = db.collection(
			"test_relevance_regressions",
		) as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}

		// 4 chunks + 2 cache + 5 KB + 4 KB chunks (3 + 1 wiki) + 8 structured (6 + 1 v2 scope + 1 sourceEvent) +
		// 1 structured revisions + 3 relevance_runs + 2 relevance_artifacts +
		// 2 relevance_regressions + 8 events (6 + 1 dreamerProcessedAt + 1 bi-temporal SE-1) + 5 entities (3 + 2 Phase 3.4) + 4 relations +
		// 2 entity links + 4 episodes (3 + 1 promotion) + 1 ingest_runs + 1 projection_runs +
		// 4 procedures + 1 procedure_revisions + 3 query_cache + 2 telemetry + 2 access_events
		// + 3 memory_mutations (compound + TTL + per-document)
		// + 1 lane_coverage (unique agentId)
		// + 1 consolidation_runs (agent_time)
		// + 3 sourceRef dedup (events, structured, procedures)
		// + 1 partial index (structured active facts) + 2 sourceEvent dedup indexes
		// + 3 session_chunks = 85 (was 84; +1 for bi-temporal SE-1)
		expect(count).toBe(85)
		expect(chunks.createIndex).toHaveBeenCalledTimes(4)
		expect(cache.createIndex).toHaveBeenCalledTimes(2)
		expect(kb.createIndex).toHaveBeenCalledTimes(5)
		expect(kbChunks.createIndex).toHaveBeenCalledTimes(4)
		expect(structured.createIndex).toHaveBeenCalledTimes(10)
		expect(structuredRevisions.createIndex).toHaveBeenCalledTimes(1)
		expect(relevanceRuns.createIndex).toHaveBeenCalledTimes(3)
		expect(relevanceArtifacts.createIndex).toHaveBeenCalledTimes(2)
		expect(relevanceRegressions.createIndex).toHaveBeenCalledTimes(2)

		// v2 collection indexes
		const events = db.collection("test_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const entities = db.collection("test_entities") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const relations = db.collection("test_relations") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const entityLinks = db.collection("test_entity_links") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const episodes = db.collection("test_episodes") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const ingestRuns = db.collection("test_ingest_runs") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const projectionRuns = db.collection("test_projection_runs") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(events.createIndex).toHaveBeenCalledTimes(9)
		expect(entities.createIndex).toHaveBeenCalledTimes(5)
		expect(relations.createIndex).toHaveBeenCalledTimes(4)
		expect(entityLinks.createIndex).toHaveBeenCalledTimes(2)
		expect(episodes.createIndex).toHaveBeenCalledTimes(4)
		expect(ingestRuns.createIndex).toHaveBeenCalledTimes(1)
		expect(projectionRuns.createIndex).toHaveBeenCalledTimes(1)

		// Procedures and procedure revisions
		const procedures = db.collection("test_procedures") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const procedureRevisions = db.collection(
			"test_procedure_revisions",
		) as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(procedures.createIndex).toHaveBeenCalledTimes(6)
		expect(procedureRevisions.createIndex).toHaveBeenCalledTimes(1)

		// Query cache and telemetry
		const queryCache = db.collection("test_query_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const telemetry = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const accessEvents = db.collection("test_access_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(queryCache.createIndex).toHaveBeenCalledTimes(3)
		expect(telemetry.createIndex).toHaveBeenCalledTimes(2)
		expect(accessEvents.createIndex).toHaveBeenCalledTimes(2)

		// Session chunks (Option B)
		const sessionChunks = db.collection("test_session_chunks") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(sessionChunks.createIndex).toHaveBeenCalledTimes(3)
	})

	it("creates memory_evidence indexes only when the evidence mirror is enabled", async () => {
		const previous = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		try {
			const db = mockDb()
			const count = await ensureStandardIndexes(db, "test_")
			const memoryEvidence = db.collection(
				"test_memory_evidence",
			) as unknown as {
				createIndex: ReturnType<typeof vi.fn>
			}
			expect(count).toBe(89)
			expect(memoryEvidence.createIndex).toHaveBeenCalledTimes(4)
			expect(memoryEvidence.createIndex).toHaveBeenCalledWith(
				{ canonicalId: 1 },
				{ name: "uq_memory_evidence_canonical", unique: true },
			)
			expect(memoryEvidence.createIndex).toHaveBeenCalledWith(
				{ agentId: 1, scope: 1, scopeRef: 1, unit: 1, status: 1 },
				{ name: "idx_memory_evidence_scope_unit_status" },
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previous
			}
		}
	})

	it("creates bi-temporal compound index on events ()", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const events = db.collection("test_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		// Compound index: { agentId: 1, scope: 1, scopeRef: 1, validAt: 1, invalidAt: 1 }
		// supports the retrieval filter
		//   validAt <= queryTime AND (invalidAt IS NULL OR invalidAt > queryTime)
		// and is scoped by (agentId, scope, scopeRef).
		const calls = events.createIndex.mock.calls as Array<[unknown, unknown]>
		const bitemporal = calls.find(
			([, opts]) =>
				(opts as { name?: string })?.name ===
				"idx_events_agent_scope_scoperef_validAt_invalidAt",
		)
		expect(bitemporal).toBeDefined()
		expect(bitemporal![0]).toEqual({
			agentId: 1,
			scope: 1,
			scopeRef: 1,
			validAt: 1,
			invalidAt: 1,
		})
	})

	it("creates a defensive $text index on text field", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")

		const chunks = db.collection("test_chunks") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = chunks.createIndex.mock.calls
		const textIndexCall = calls.find(
			(c: unknown[]) =>
				c[0] &&
				typeof c[0] === "object" &&
				"text" in (c[0] as Record<string, unknown>) &&
				(c[0] as Record<string, unknown>).text === "text",
		)
		expect(textIndexCall).toBeDefined()
		expect(textIndexCall![1]).toEqual({ name: "idx_chunks_text" })
	})

	it("creates TTL index on embedding_cache when ttlDays is set", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_", { embeddingCacheTtlDays: 30 })

		const cache = db.collection("test_embedding_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = cache.createIndex.mock.calls
		const ttlCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).expireAfterSeconds !== undefined,
		)
		expect(ttlCall).toBeDefined()
		expect(ttlCall![1]).toMatchObject({
			expireAfterSeconds: 30 * 24 * 60 * 60,
			name: "idx_cache_ttl",
		})
	})

	it("skips regular idx_cache_updated when TTL is enabled (TTL index serves same purpose)", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_", { embeddingCacheTtlDays: 7 })

		const cache = db.collection("test_embedding_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = cache.createIndex.mock.calls
		const regularUpdatedCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_cache_updated",
		)
		// Regular idx_cache_updated should NOT be created when TTL is active
		expect(regularUpdatedCall).toBeUndefined()
	})

	it("creates regular idx_cache_updated when no TTL is configured", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")

		const cache = db.collection("test_embedding_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = cache.createIndex.mock.calls
		const regularCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_cache_updated",
		)
		expect(regularCall).toBeDefined()
	})

	it("creates TTL index on files collection when memoryTtlDays is set", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_", { memoryTtlDays: 90 })

		const files = db.collection("test_files") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = files.createIndex.mock.calls
		const ttlCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_files_ttl",
		)
		expect(ttlCall).toBeDefined()
		expect(ttlCall![1]).toMatchObject({
			expireAfterSeconds: 90 * 24 * 60 * 60,
			name: "idx_files_ttl",
		})
	})

	it("skips files TTL index when memoryTtlDays is 0", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_", { memoryTtlDays: 0 })

		const files = db.collection("test_files") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = files.createIndex.mock.calls
		const ttlCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_files_ttl",
		)
		expect(ttlCall).toBeUndefined()
	})

	it("drops idx_cache_updated before creating idx_cache_ttl (F18)", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_", { embeddingCacheTtlDays: 30 })

		const cache = db.collection("test_embedding_cache") as unknown as {
			dropIndex: ReturnType<typeof vi.fn>
		}
		expect(cache.dropIndex).toHaveBeenCalledWith("idx_cache_updated")
	})

	it("drops idx_cache_ttl before creating idx_cache_updated when no TTL (F18)", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")

		const cache = db.collection("test_embedding_cache") as unknown as {
			dropIndex: ReturnType<typeof vi.fn>
		}
		expect(cache.dropIndex).toHaveBeenCalledWith("idx_cache_ttl")
	})

	it("index count includes relevance telemetry indexes and v2 collection indexes", async () => {
		const db = mockDb()
		const count = await ensureStandardIndexes(db, "test_")
		// 27 (v1 base) + 8 events (6 + 1 dreamerProcessedAt + 1 bi-temporal SE-1) + 3 entities + 4 relations +
		// 2 entity links + 4 episodes (3 + 1 promotion) + 1 ingest_runs + 1 projection_runs +
		// 1 structured scope + 1 structured revisions + 4 procedures + 1 procedure_revisions +
		// 3 query_cache + 2 telemetry + 2 access_events + 3 memory_mutations
		// + 1 lane_coverage + 1 consolidation_runs + 3 session_chunks = 85
		expect(count).toBe(85)
	})

	it("creates relevance TTL indexes when relevanceRetentionDays is set", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_", { relevanceRetentionDays: 14 })

		const relevanceRuns = db.collection("test_relevance_runs") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const relevanceArtifacts = db.collection(
			"test_relevance_artifacts",
		) as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}

		const relRunsTtl = relevanceRuns.createIndex.mock.calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_relruns_ttl",
		)
		const relArtifactsTtl = relevanceArtifacts.createIndex.mock.calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_relart_ttl",
		)
		expect(relRunsTtl).toBeDefined()
		expect(relArtifactsTtl).toBeDefined()
	})

	it("creates unique composite index on embedding_cache", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")

		const cache = db.collection("test_embedding_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = cache.createIndex.mock.calls
		const uniqueCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).unique === true,
		)
		expect(uniqueCall).toBeDefined()
		expect(uniqueCall![0]).toEqual({
			provider: 1,
			model: 1,
			providerKey: 1,
			hash: 1,
		})
	})
})

// ---------------------------------------------------------------------------
// ensureSearchIndexes
// ---------------------------------------------------------------------------

describe("ensureSearchIndexes", () => {
	it("treats autoEmbed listSearchIndexes type as vectorSearch-compatible", () => {
		expect(isSearchIndexTypeCompatible("autoEmbed", "vectorSearch")).toBe(true)
		expect(isSearchIndexTypeCompatible("vectorSearch", "vectorSearch")).toBe(
			true,
		)
		expect(isSearchIndexTypeCompatible("search", "vectorSearch")).toBe(false)
		expect(isSearchIndexTypeCompatible("vectorSearch", "search")).toBe(false)
	})

	it("creates text + vector search indexes for the Memongo community profile", async () => {
		const db = mockDb()
		const result = await ensureSearchIndexes(
			db,
			"test_",
			"atlas-local-preview",
			"automated",
		)
		expect(result).toEqual({ text: true, vector: true })

		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		// 2 search indexes on chunks collection (text + vector)
		expect(chunks.createSearchIndex).toHaveBeenCalledTimes(2)

		// Check text index
		const textCall = chunks.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "search",
		)
		expect(textCall).toBeDefined()
		expect((textCall![0] as Document).name).toBe("test_chunks_text")

		// Check vector index uses MongoDB autoEmbed on the text field.
		const vectorCall = chunks.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		expect((vectorCall![0] as Document).name).toBe("test_chunks_vector")
		const vectorFields = (vectorCall![0] as Document).definition.fields
		const autoEmbedField = vectorFields.find(
			(f: Document) => f.type === "autoEmbed",
		)
		expect(autoEmbedField).toBeDefined()
		expect(autoEmbedField.path).toBe("text")
		expect(autoEmbedField.model).toBe("voyage-4-large")

		// Also verify KB chunks and structured mem search indexes
		const kbChunksCol = db.collection("test_kb_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		expect(kbChunksCol.createSearchIndex).toHaveBeenCalledTimes(2)

		const structuredCol = db.collection("test_structured_mem") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		expect(structuredCol.createSearchIndex).toHaveBeenCalledTimes(2)
	})

	it("creates autoEmbed vector index for automated mode", async () => {
		const db = mockDb()
		const result = await ensureSearchIndexes(
			db,
			"test_",
			"atlas-local-preview",
			"automated",
		)
		expect(result).toEqual({ text: true, vector: true })

		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = chunks.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()

		const vectorFields = (vectorCall![0] as Document).definition.fields
		const autoEmbedField = vectorFields.find(
			(f: Document) => f.type === "autoEmbed",
		)
		expect(autoEmbedField).toBeDefined()
		expect(autoEmbedField.modality).toBe("text")
		expect(autoEmbedField.path).toBe("text")
		expect(autoEmbedField.model).toBe("voyage-4-large")
	})

	it("creates only the session_chunks vector index for raw-session benchmark profile", async () => {
		const previousProfile = process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
		const previousLane = process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE
		process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE = "raw-session"
		try {
			const db = mockDb()
			const result = await ensureSearchIndexes(
				db,
				"test_",
				"atlas-managed",
				"automated",
			)
			expect(result).toEqual({ text: false, vector: true })

			const sessionChunks = db.collection("test_session_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			expect(sessionChunks.createSearchIndex).toHaveBeenCalledTimes(1)
			const [call] = sessionChunks.createSearchIndex.mock.calls
			expect((call[0] as Document).name).toBe("test_session_chunks_vector")
			expect((call[0] as Document).type).toBe("vectorSearch")
			const fields = (call[0] as Document).definition.fields as Document[]
			expect(fields.find((field) => field.type === "autoEmbed")).toMatchObject({
				path: "text",
				model: "voyage-4-large",
			})

			const chunks = db.collection("test_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			expect(chunks.createSearchIndex).not.toHaveBeenCalled()
		} finally {
			if (previousProfile === undefined) {
				delete process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
			} else {
				process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE = previousProfile
			}
			if (previousLane === undefined) {
				delete process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE
			} else {
				process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE = previousLane
			}
		}
	})

	it("does not set unsupported indexingMethod on autoEmbed vector indexes", async () => {
		const previousProfile = process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
		process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE = "longmemeval"
		try {
			const db = mockDb()
			await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

			const chunks = db.collection("test_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			const vectorCall = chunks.createSearchIndex.mock.calls.find(
				(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
			)
			expect(vectorCall).toBeDefined()
			const fields = (vectorCall![0] as Document).definition
				.fields as Document[]
			expect(fields.find((field) => field.type === "autoEmbed")).toMatchObject({
				path: "text",
				model: "voyage-4-large",
			})
			expect(
				fields.find((field) => field.type === "autoEmbed"),
			).not.toHaveProperty("indexingMethod")
		} finally {
			if (previousProfile === undefined) {
				delete process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
			} else {
				process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE = previousProfile
			}
		}
	})

	it("includes filter fields (source, path, status) in vector index", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = chunks.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		const vectorFields = (vectorCall![0] as Document).definition.fields
		const filterFields = vectorFields.filter(
			(f: Document) => f.type === "filter",
		)
		const filterPaths = filterFields.map((f: Document) => f.path)
		expect(filterPaths).toContain("path")
		expect(filterPaths).toContain("source")
		expect(filterPaths).toContain("sessionId")
		expect(filterPaths).toContain("status")
	})

	it("includes session-aware token mappings in the chunks text index", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const textCall = chunks.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "search",
		)
		expect(textCall).toBeDefined()
		const textFields = (textCall?.[0] as Document).definition.mappings.fields
		expect(textFields.sessionId).toEqual({ type: "token" })
	})

	it("updates stale chunk search indexes when definitions drift", async () => {
		const db = mockDb()
		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
			updateSearchIndex: ReturnType<typeof vi.fn>
			listSearchIndexes: ReturnType<typeof vi.fn>
		}
		chunks.listSearchIndexes.mockImplementation((name?: string) => ({
			toArray: async () =>
				name === "test_chunks_vector"
					? [
							{
								name,
								type: "vectorSearch",
								definition: {
									fields: [{ type: "filter", path: "agentId" }],
								},
							},
						]
					: name === "test_chunks_text"
						? [
								{
									name,
									type: "search",
									definition: {
										mappings: {
											dynamic: false,
											fields: {
												text: {
													type: "string",
													analyzer: "lucene.standard",
												},
												source: { type: "token" },
												path: { type: "token" },
												agentId: { type: "token" },
												scope: { type: "token" },
												scopeRef: { type: "token" },
												status: { type: "token" },
												updatedAt: { type: "date" },
											},
										},
									},
								},
							]
						: [],
		}))

		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		expect(chunks.updateSearchIndex).toHaveBeenCalledWith(
			"test_chunks_text",
			expect.objectContaining({
				mappings: expect.objectContaining({
					fields: expect.objectContaining({
						sessionId: { type: "token" },
					}),
				}),
			}),
		)
		expect(chunks.updateSearchIndex).toHaveBeenCalledWith(
			"test_chunks_vector",
			expect.objectContaining({
				fields: expect.arrayContaining([
					expect.objectContaining({ type: "filter", path: "sessionId" }),
				]),
			}),
		)
		expect(chunks.createSearchIndex).not.toHaveBeenCalled()
	})

	it("handles 'already exists' errors gracefully", async () => {
		const db = mockDb()
		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		chunks.createSearchIndex.mockRejectedValue(
			new Error("index already exists"),
		)

		const result = await ensureSearchIndexes(
			db,
			"test_",
			"atlas-local-preview",
			"automated",
		)
		// Both should be true because "already exists" means the index is there
		expect(result).toEqual({ text: true, vector: true })
	})

	it("fails fast when Search Index Management is unavailable", async () => {
		const db = mockDb()
		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const kbChunks = db.collection("test_kb_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const structured = db.collection("test_structured_mem") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		chunks.createSearchIndex.mockRejectedValue(
			new Error("Error connecting to Search Index Management service."),
		)

		const result = await ensureSearchIndexes(
			db,
			"test_",
			"atlas-local-preview",
			"automated",
		)

		expect(result).toEqual({ text: false, vector: false })
		expect(chunks.createSearchIndex).toHaveBeenCalledTimes(1)
		expect(kbChunks.createSearchIndex).not.toHaveBeenCalled()
		expect(structured.createSearchIndex).not.toHaveBeenCalled()
	})
})

describe("search index readiness helpers", () => {
	it("marks an index queryable when status is READY", () => {
		expect(
			isSearchIndexQueryable({
				name: "test_chunks_vector",
				status: "READY",
			}),
		).toBe(true)
	})

	it("does not mark STALE indexes queryable even when MongoDB reports queryable=true", () => {
		expect(
			isSearchIndexQueryable({
				name: "test_chunks_vector",
				status: "STALE",
				queryable: true,
			}),
		).toBe(false)
	})

	it("requires status and queryable evidence to agree when both are present", () => {
		expect(
			isSearchIndexQueryable({
				name: "test_chunks_vector",
				status: "READY",
				queryable: false,
			}),
		).toBe(false)
		expect(
			isSearchIndexQueryable({
				name: "test_chunks_vector",
				status: "READY",
				queryable: true,
			}),
		).toBe(true)
	})

	it("requires nested statusDetail entries to be ready and queryable", () => {
		expect(
			isSearchIndexQueryable({
				name: "test_chunks_vector",
				statusDetail: [
					{
						mainIndex: { status: "READY", queryable: true },
						definitions: [{ status: "STALE", queryable: true }],
					},
				],
			}),
		).toBe(false)
		expect(
			isSearchIndexQueryable({
				name: "test_chunks_vector",
				statusDetail: [
					{
						mainIndex: { status: "READY", queryable: true },
						definitions: [{ status: "READY", queryable: true }],
					},
				],
			}),
		).toBe(true)
	})

	it("waits until all requested indexes are queryable", async () => {
		const db = mockDb()
		const chunks = db.collection("test_chunks") as unknown as {
			aggregate: ReturnType<typeof vi.fn>
		}
		let calls = 0
		chunks.aggregate.mockImplementation(() => ({
			toArray: async () => {
				calls++
				if (calls === 1) {
					return [
						{
							name: "test_chunks_text",
							status: "READY",
							queryable: true,
						},
						{
							name: "test_chunks_vector",
							status: "BUILDING",
							queryable: false,
						},
					]
				}
				return [
					{
						name: "test_chunks_text",
						status: "READY",
						queryable: true,
					},
					{
						name: "test_chunks_vector",
						status: "READY",
						queryable: true,
					},
				]
			},
		}))

		const result = await waitForSearchIndexesQueryable(
			db.collection("test_chunks"),
			{
				indexNames: ["test_chunks_text", "test_chunks_vector"],
				timeoutMs: 50,
				pollMs: 0,
			},
		)
		expect(result.ready).toBe(true)
		expect(result.pending).toEqual([])
		expect(calls).toBe(2)
	})

	it("reports failed indexes without waiting for the full timeout", async () => {
		const db = mockDb()
		const chunks = db.collection("test_chunks") as unknown as {
			aggregate: ReturnType<typeof vi.fn>
		}
		chunks.aggregate.mockImplementation(() => ({
			toArray: async () => [
				{
					name: "test_chunks_vector",
					status: "FAILED",
					queryable: false,
				},
			],
		}))

		const result = await waitForSearchIndexesQueryable(
			db.collection("test_chunks"),
			{
				indexNames: ["test_chunks_vector"],
				timeoutMs: 50,
				pollMs: 0,
			},
		)
		expect(result.ready).toBe(false)
		expect(result.failed).toEqual(["test_chunks_vector"])
	})

	it("treats non-queryable building indexes as pending, not failed", async () => {
		const db = mockDb()
		const chunks = db.collection("test_chunks") as unknown as {
			aggregate: ReturnType<typeof vi.fn>
		}
		chunks.aggregate.mockImplementation(() => ({
			toArray: async () => [
				{
					name: "test_chunks_vector",
					status: "BUILDING",
					queryable: false,
					statusDetail: [
						{
							mainIndex: { status: "BUILDING", queryable: false },
							definitions: [{ status: "BUILDING", queryable: false }],
						},
					],
				},
			],
		}))

		const result = await waitForSearchIndexesQueryable(
			db.collection("test_chunks"),
			{
				indexNames: ["test_chunks_vector"],
				timeoutMs: 1,
				pollMs: 0,
			},
		)
		expect(result.ready).toBe(false)
		expect(result.pending).toEqual(["test_chunks_vector"])
		expect(result.failed).toEqual([])
	})

	it("returns the benchmark-required target list for atlas-local-preview", () => {
		expect(
			getExpectedSearchIndexTargets("test_", "atlas-local-preview"),
		).toEqual([
			{
				collectionName: "test_chunks",
				indexNames: ["test_chunks_text", "test_chunks_vector"],
			},
			{
				collectionName: "test_kb_chunks",
				indexNames: ["test_kb_chunks_text", "test_kb_chunks_vector"],
			},
			{
				collectionName: "test_structured_mem",
				indexNames: ["test_structured_mem_text", "test_structured_mem_vector"],
			},
			{
				collectionName: "test_procedures",
				indexNames: ["test_procedures_text", "test_procedures_vector"],
			},
			{
				collectionName: "test_events",
				indexNames: ["test_events_text", "test_events_vector"],
			},
			{
				collectionName: "test_session_chunks",
				indexNames: ["test_session_chunks_text", "test_session_chunks_vector"],
			},
			{
				collectionName: "test_query_cache",
				indexNames: ["test_query_cache_vector"],
			},
			{
				collectionName: "test_entities",
				indexNames: ["entity_autocomplete"],
			},
		])
	})

	it("includes memory_evidence search targets when the evidence mirror is enabled", () => {
		const previous = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		try {
			expect(
				getExpectedSearchIndexTargets("test_", "atlas-local-preview"),
			).toContainEqual({
				collectionName: "test_memory_evidence",
				indexNames: [
					"test_memory_evidence_text",
					"test_memory_evidence_vector",
				],
			})
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previous
			}
		}
	})

	it("uses a smaller LongMemEval search-index target list when requested", () => {
		const previous = process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
		process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE = "longmemeval"
		try {
			expect(
				getExpectedSearchIndexTargets("test_", "atlas-local-preview"),
			).toEqual([
				{
					collectionName: "test_chunks",
					indexNames: ["test_chunks_text", "test_chunks_vector"],
				},
				{
					collectionName: "test_structured_mem",
					indexNames: [
						"test_structured_mem_text",
						"test_structured_mem_vector",
					],
				},
				{
					collectionName: "test_procedures",
					indexNames: ["test_procedures_text", "test_procedures_vector"],
				},
				{
					collectionName: "test_events",
					indexNames: ["test_events_text", "test_events_vector"],
				},
			])
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
			} else {
				process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE = previous
			}
		}
	})

	it("uses only session_chunks vector readiness for raw-session benchmark profile", () => {
		const previousProfile = process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
		const previousLane = process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE
		process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE = "raw-session"
		try {
			expect(getExpectedSearchIndexTargets("test_", "atlas-managed")).toEqual([
				{
					collectionName: "test_session_chunks",
					indexNames: ["test_session_chunks_vector"],
				},
			])
		} finally {
			if (previousProfile === undefined) {
				delete process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE
			} else {
				process.env.MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE = previousProfile
			}
			if (previousLane === undefined) {
				delete process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE
			} else {
				process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE = previousLane
			}
		}
	})

	it("resolves search index readiness timing from env with safe defaults", () => {
		expect(resolveSearchIndexReadinessTiming({})).toEqual({
			timeoutMs: 60_000,
			pollMs: 1_000,
		})
		expect(
			resolveSearchIndexReadinessTiming({
				MEMONGO_BENCHMARK_STRICT: "1",
			}),
		).toEqual({ timeoutMs: 180_000, pollMs: 1_000 })
		expect(
			resolveSearchIndexReadinessTiming({
				MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS: "180000",
				MEMONGO_SEARCH_INDEX_READINESS_POLL_MS: "250",
			}),
		).toEqual({ timeoutMs: 180_000, pollMs: 250 })
		expect(
			resolveSearchIndexReadinessTiming({
				MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS: "0",
				MEMONGO_SEARCH_INDEX_READINESS_POLL_MS: "nope",
			}),
		).toEqual({ timeoutMs: 60_000, pollMs: 1_000 })
	})
})

// ---------------------------------------------------------------------------
// assertIndexBudget
// ---------------------------------------------------------------------------

describe("assertIndexBudget", () => {
	it("atlas-local-preview has an unbounded search index budget", () => {
		const result = assertIndexBudget("atlas-local-preview", 50)
		expect(result.budget).toBe("unbounded")
		expect(result.withinBudget).toBe(true)
	})

	it("atlas-managed has the same unbounded search index budget", () => {
		const result = assertIndexBudget("atlas-managed", 50)
		expect(result.budget).toBe("unbounded")
		expect(result.withinBudget).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// detectCapabilities
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 3: KB startup integrity check — orphan detection
// ---------------------------------------------------------------------------

describe("checkKBOrphans", () => {
	it("detects orphaned kb_chunks (docId references non-existent knowledge_base doc)", async () => {
		// Import dynamically since the function doesn't exist yet
		const { checkKBOrphans } = await import("./mongodb-schema.js")

		// Create mocks: kb_chunks has a docId that doesn't exist in knowledge_base
		const kbChunksCol = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{ _id: "orphan-doc-1", count: 3 },
					{ _id: "orphan-doc-2", count: 1 },
				]),
			})),
		} as unknown as Collection

		const kbCol = {
			find: vi.fn(() => ({
				project: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		} as unknown as Collection

		const result = await checkKBOrphans(kbChunksCol, kbCol)
		expect(result.orphanedChunkCount).toBe(4)
		expect(result.orphanedDocIds).toEqual(["orphan-doc-1", "orphan-doc-2"])
	})

	it("returns zero when no orphans exist", async () => {
		const { checkKBOrphans } = await import("./mongodb-schema.js")

		const kbChunksCol = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => [{ _id: "doc-1", count: 5 }]),
			})),
		} as unknown as Collection

		const kbCol = {
			find: vi.fn(() => ({
				project: vi.fn(() => ({
					toArray: vi.fn(async () => [{ _id: "doc-1" }]),
				})),
			})),
		} as unknown as Collection

		const result = await checkKBOrphans(kbChunksCol, kbCol)
		expect(result.orphanedChunkCount).toBe(0)
		expect(result.orphanedDocIds).toEqual([])
	})

	it("handles empty kb_chunks collection", async () => {
		const { checkKBOrphans } = await import("./mongodb-schema.js")

		const kbChunksCol = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		} as unknown as Collection

		const kbCol = {
			find: vi.fn(() => ({
				project: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		} as unknown as Collection

		const result = await checkKBOrphans(kbChunksCol, kbCol)
		expect(result.orphanedChunkCount).toBe(0)
		expect(result.orphanedDocIds).toEqual([])
	})
})

describe("wiki source categorization fields", () => {
	it("KB_SCHEMA includes optional wikiSource field", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_knowledge_base",
		)
		expect(kbCall).toBeDefined()
		const schema = kbCall![1]?.validator.$jsonSchema
		expect(schema.properties.wikiSource).toBeDefined()
		expect(schema.properties.wikiSource.bsonType).toBe("string")
		// Must NOT be in required
		expect(schema.required).not.toContain("wikiSource")
	})

	it("KB_SCHEMA includes optional vault and section fields", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_knowledge_base",
		)
		expect(kbCall).toBeDefined()
		const schema = kbCall![1]?.validator.$jsonSchema
		expect(schema.properties.vault).toBeDefined()
		expect(schema.properties.vault.bsonType).toBe("string")
		expect(schema.properties.section).toBeDefined()
		expect(schema.properties.section.bsonType).toBe("string")
		expect(schema.required).not.toContain("vault")
		expect(schema.required).not.toContain("section")
	})

	it("KB_CHUNKS_SCHEMA includes optional wikiSource field", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbChunksCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_kb_chunks",
		)
		expect(kbChunksCall).toBeDefined()
		const schema = kbChunksCall![1]?.validator.$jsonSchema
		expect(schema.properties.wikiSource).toBeDefined()
		expect(schema.properties.wikiSource.bsonType).toBe("string")
		expect(schema.required).not.toContain("wikiSource")
	})

	it("KB_CHUNKS_SCHEMA includes optional vault and section fields", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbChunksCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_kb_chunks",
		)
		expect(kbChunksCall).toBeDefined()
		const schema = kbChunksCall![1]?.validator.$jsonSchema
		expect(schema.properties.vault).toBeDefined()
		expect(schema.properties.vault.bsonType).toBe("string")
		expect(schema.properties.section).toBeDefined()
		expect(schema.properties.section.bsonType).toBe("string")
		expect(schema.required).not.toContain("vault")
		expect(schema.required).not.toContain("section")
	})
})

describe("EPISODES_SCHEMA enum completeness", () => {
	it("EPISODES_SCHEMA enum includes all 5 EpisodeType values", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const episodesCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_episodes",
		)
		expect(episodesCall).toBeDefined()
		const schema = episodesCall![1]?.validator.$jsonSchema
		const typeEnum = schema.properties.type.enum
		// EpisodeType = "daily" | "weekly" | "thread" | "topic" | "decision"
		expect(typeEnum).toContain("daily")
		expect(typeEnum).toContain("weekly")
		expect(typeEnum).toContain("thread")
		expect(typeEnum).toContain("topic")
		expect(typeEnum).toContain("decision")
		expect(typeEnum).toHaveLength(5)
	})
})

describe("detectCapabilities", () => {
	it("detects fusion stages from buildInfo version when available", async () => {
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 2, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.rankFusion).toBe(true)
		expect(caps.scoreFusion).toBe(true)
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
	})

	it("detects no capabilities when everything fails", async () => {
		const db = {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("unrecognized pipeline stage")
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("not supported")
					}),
				})),
			})),
			listCollections: vi.fn(() => ({
				toArray: async () => [],
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db)
		expect(caps.vectorSearch).toBe(false)
		expect(caps.textSearch).toBe(false)
		expect(caps.scoreFusion).toBe(false)
		expect(caps.rankFusion).toBe(false)
	})

	it("detects rankFusion when stage is recognized but fails on empty data", async () => {
		const db = {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						// Recognized but fails with a runtime error (not "unrecognized")
						throw new Error("Cannot run $rankFusion on empty pipelines")
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("not supported")
					}),
				})),
			})),
			listCollections: vi.fn(() => ({
				toArray: async () => [],
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db)
		// Stage recognized (error isn't "unrecognized") → capability = true
		expect(caps.rankFusion).toBe(true)
		expect(caps.scoreFusion).toBe(true)
	})

	it("detects vectorSearch and textSearch when listSearchIndexes succeeds", async () => {
		const db = {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("unrecognized pipeline stage")
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
			listCollections: vi.fn(() => ({
				toArray: async () => [{ name: "test_chunks" }],
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db)
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
		// automatedEmbedding removed (F2: dead code)
	})

	it("detects search capabilities through $listSearchIndexes aggregation", async () => {
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 2, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("driver helper should not be required")
					}),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
	})

	it("waits for search capabilities to become available", async () => {
		let attempts = 0
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 2, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						attempts += 1
						if (attempts < 2) {
							throw new Error("mongot warming up")
						}
						return []
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						if (attempts < 2) {
							throw new Error("mongot still warming up")
						}
						return []
					}),
				})),
			})),
		} as unknown as Db

		const caps = await waitForSearchCapabilities(db, "test_chunks", {
			timeoutMs: 30,
			pollMs: 1,
		})
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
		expect(attempts).toBe(2)
	})
})

describe("waitForSearchIndexesQueryable", () => {
	it("retries transient search index management errors", async () => {
		let attempts = 0
		const collection = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					attempts += 1
					if (attempts === 1) {
						throw new Error(
							"Error connecting to Search Index Management service",
						)
					}
					return [
						{
							name: "events_text",
							status: "READY",
							queryable: true,
						},
					]
				}),
			})),
			listSearchIndexes: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		} as unknown as Collection

		const result = await waitForSearchIndexesQueryable(collection, {
			indexNames: ["events_text"],
			timeoutMs: 30,
			pollMs: 1,
		})

		expect(result.ready).toBe(true)
		expect(result.lastError).toBeUndefined()
		expect(attempts).toBe(2)
	})
})

// ---------------------------------------------------------------------------
// Query Cache collection and schema (Phase 1)
// ---------------------------------------------------------------------------

describe("queryCacheCollection", () => {
	it("queryCacheCollection returns prefixed collection", () => {
		const db = mockDb()
		queryCacheCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_query_cache")
	})
})

describe("telemetryCollection", () => {
	it("telemetryCollection returns prefixed collection", () => {
		const db = mockDb()
		telemetryCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_memory_telemetry")
	})
})

describe("accessEventsCollection", () => {
	it("accessEventsCollection returns prefixed collection", () => {
		const db = mockDb()
		accessEventsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_access_events")
	})
})

describe("sessionChunksCollection", () => {
	it("sessionChunksCollection returns prefixed collection", () => {
		const db = mockDb()
		sessionChunksCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_session_chunks")
	})
})

describe("memoryEvidenceCollection", () => {
	it("memoryEvidenceCollection returns prefixed collection", () => {
		const db = mockDb()
		memoryEvidenceCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_memory_evidence")
	})
})

describe("query_cache schema", () => {
	it("QUERY_CACHE_SCHEMA validates all required fields via ensureCollections", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const cacheCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_query_cache",
		)
		expect(cacheCall).toBeDefined()
		const schema = cacheCall![1]?.validator.$jsonSchema
		expect(schema).toBeDefined()
		expect(schema.required).toEqual(
			expect.arrayContaining([
				"queryHash",
				"queryNorm",
				"agentId",
				"scope",
				"scopeRef",
				"results",
				"pathUsed",
				"sourceScope",
				"createdAt",
				"expiresAt",
				"hitCount",
				"lastHitAt",
			]),
		)
	})

	it("query_cache scope field uses SCOPE_ENUM", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const cacheCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_query_cache",
		)
		expect(cacheCall).toBeDefined()
		const schema = cacheCall![1]?.validator.$jsonSchema
		expect(schema.properties.scope.enum).toEqual([
			"session",
			"user",
			"agent",
			"workspace",
			"tenant",
			"global",
		])
	})

	it("query_cache hitCount has minimum 0", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const cacheCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_query_cache",
		)
		expect(cacheCall).toBeDefined()
		const schema = cacheCall![1]?.validator.$jsonSchema
		expect(schema.properties.hitCount.minimum).toBe(0)
	})
})

describe("query_cache standard indexes", () => {
	it("creates unique compound index on (queryHash, agentId, scope, scopeRef)", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const qc = db.collection("test_query_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = qc.createIndex.mock.calls
		const uniqueCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name ===
					"uq_query_cache_hash_agent_scope_scoperef",
		)
		expect(uniqueCall).toBeDefined()
		expect(uniqueCall![0]).toEqual({
			queryHash: 1,
			agentId: 1,
			scope: 1,
			scopeRef: 1,
		})
		expect((uniqueCall![1] as Record<string, unknown>).unique).toBe(true)
	})

	it("creates TTL index on expiresAt with expireAfterSeconds: 0", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const qc = db.collection("test_query_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = qc.createIndex.mock.calls
		const ttlCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_query_cache_ttl",
		)
		expect(ttlCall).toBeDefined()
		expect(ttlCall![0]).toEqual({ expiresAt: 1 })
		expect((ttlCall![1] as Record<string, unknown>).expireAfterSeconds).toBe(0)
	})

	it("creates hitCount compound index on (agentId, hitCount desc)", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const qc = db.collection("test_query_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = qc.createIndex.mock.calls
		const hitCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name ===
					"idx_query_cache_agent_hitcount",
		)
		expect(hitCall).toBeDefined()
		expect(hitCall![0]).toEqual({ agentId: 1, hitCount: -1 })
	})
})

describe("query_cache vector search index", () => {
	it("creates autoEmbed vector search index on queryNorm field", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
		const qc = db.collection("test_query_cache") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		expect(qc.createSearchIndex).toHaveBeenCalledTimes(1)
		const call = qc.createSearchIndex.mock.calls[0]
		expect((call[0] as Document).name).toBe("test_query_cache_vector")
		expect((call[0] as Document).type).toBe("vectorSearch")
		const fields = (call[0] as Document).definition.fields
		const autoEmbed = fields.find((f: Document) => f.type === "autoEmbed")
		expect(autoEmbed).toBeDefined()
		expect(autoEmbed.path).toBe("queryNorm")
		expect(autoEmbed.model).toBe("voyage-4-large")
	})

	it("includes filter paths for agentId, scope, scopeRef", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
		const qc = db.collection("test_query_cache") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const call = qc.createSearchIndex.mock.calls[0]
		const fields = (call[0] as Document).definition.fields
		const filterPaths = fields
			.filter((f: Document) => f.type === "filter")
			.map((f: Document) => f.path)
		expect(filterPaths).toContain("agentId")
		expect(filterPaths).toContain("scope")
		expect(filterPaths).toContain("scopeRef")
	})

	it("assertIndexBudget uses 13 for total search index count", async () => {
		const db = mockDb()
		// This should NOT fail for unbounded Atlas profiles.
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
		// The budget check is internal, but we verify that the total search index call count
		// includes events, query_cache, and session_chunks
		const qc = db.collection("test_query_cache") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		expect(qc.createSearchIndex).toHaveBeenCalledTimes(1)
		const sc = db.collection("test_session_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		expect(sc.createSearchIndex).toHaveBeenCalledTimes(2)
	})

	it("creates memory_evidence Search and Vector Search indexes when enabled", async () => {
		const previous = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		try {
			const db = mockDb()
			await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
			const memoryEvidence = db.collection(
				"test_memory_evidence",
			) as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			expect(memoryEvidence.createSearchIndex).toHaveBeenCalledTimes(2)
			const vectorCall = memoryEvidence.createSearchIndex.mock.calls.find(
				(call) =>
					(call[0] as { name?: string }).name === "test_memory_evidence_vector",
			)
			const fields = (vectorCall?.[0] as Document).definition.fields
			const filterPaths = fields
				.filter((field: Document) => field.type === "filter")
				.map((field: Document) => field.path)
			expect(filterPaths).toEqual(
				expect.arrayContaining([
					"agentId",
					"scope",
					"scopeRef",
					"sessionId",
					"unit",
					"status",
					"timestamp",
				]),
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previous
			}
		}
	})
})

describe("telemetry time series collection", () => {
	it("ensureCollections creates memory_telemetry time series collection", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const telemetryCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_memory_telemetry",
		)
		expect(telemetryCall).toBeDefined()
		// Time series options
		expect(telemetryCall![1]?.timeseries).toBeDefined()
		expect(telemetryCall![1]?.timeseries.timeField).toBe("ts")
		expect(telemetryCall![1]?.timeseries.metaField).toBe("meta")
		expect(telemetryCall![1]?.timeseries.granularity).toBe("seconds")
		expect(telemetryCall![1]?.expireAfterSeconds).toBe(604800)
	})

	it("ensureCollections skips memory_telemetry when it already exists", async () => {
		const db = mockDb(["test_memory_telemetry"])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const telemetryCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_memory_telemetry",
		)
		expect(telemetryCall).toBeUndefined()
	})
})

describe("access events time series collection", () => {
	it("ensureCollections creates access_events time series collection", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const accessEventsCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_access_events",
		)
		expect(accessEventsCall).toBeDefined()
		expect(accessEventsCall![1]?.timeseries).toBeDefined()
		expect(accessEventsCall![1]?.timeseries.timeField).toBe("ts")
		expect(accessEventsCall![1]?.timeseries.metaField).toBe("meta")
		expect(accessEventsCall![1]?.timeseries.granularity).toBe("minutes")
		expect(accessEventsCall![1]?.expireAfterSeconds).toBe(30 * 24 * 3600)
	})

	it("ensureCollections skips access_events when it already exists", async () => {
		const db = mockDb(["test_access_events"])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const accessEventsCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_access_events",
		)
		expect(accessEventsCall).toBeUndefined()
	})

	it("fails closed when access_events time series creation fails unexpectedly", async () => {
		const db = mockDb([])
		;(db.createCollection as ReturnType<typeof vi.fn>).mockImplementation(
			async (name: string) => {
				if (name === "test_access_events") {
					throw new Error("timeseries unsupported")
				}
				return mockCollection(name)
			},
		)

		await expect(ensureCollections(db, "test_")).rejects.toThrow(
			"timeseries unsupported",
		)
	})
})

describe("telemetry standard indexes", () => {
	it("creates meta.agentId + ts index on telemetry collection", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const tel = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = tel.createIndex.mock.calls
		const agentCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_telemetry_agent_ts",
		)
		expect(agentCall).toBeDefined()
		expect(agentCall![0]).toEqual({ "meta.agentId": 1, ts: -1 })
	})

	it("creates meta.operation + ts index on telemetry collection", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const tel = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = tel.createIndex.mock.calls
		const opCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_telemetry_op_ts",
		)
		expect(opCall).toBeDefined()
		expect(opCall![0]).toEqual({ "meta.operation": 1, ts: -1 })
	})
})

describe("access events standard indexes", () => {
	it("creates agent/collection/memory/time index on access events", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const accessEvents = db.collection("test_access_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = accessEvents.createIndex.mock.calls
		const indexCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name ===
					"idx_access_events_agent_collection_memory_ts",
		)
		expect(indexCall).toBeDefined()
		expect(indexCall![0]).toEqual({
			"meta.agentId": 1,
			"meta.collection": 1,
			"meta.memoryId": 1,
			ts: -1,
		})
	})

	it("creates agent/collection/time index on access events", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const accessEvents = db.collection("test_access_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = accessEvents.createIndex.mock.calls
		const indexCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name ===
					"idx_access_events_agent_collection_ts",
		)
		expect(indexCall).toBeDefined()
		expect(indexCall![0]).toEqual({
			"meta.agentId": 1,
			"meta.collection": 1,
			ts: -1,
		})
	})
})

describe("ensureCollections total count with query_cache and time series", () => {
	it("creates all regular collections plus telemetry and access-events time series collections", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		// 30 = 29 baseline + 1 memory_quarantine (, )
		expect(db.createCollection).toHaveBeenCalledTimes(30)
	})
})

describe("ensureStandardIndexes total count with query_cache and time series indexes", () => {
	it("returns updated total index count including query_cache, telemetry, access event, and session_chunks indexes", async () => {
		const db = mockDb()
		const count = await ensureStandardIndexes(db, "test_")
		// 27 (v1 base) + 8 events (6 + 1 dreamerProcessedAt + 1 bi-temporal SE-1) + 3 entities + 4 relations +
		// 2 entity links + 4 episodes (3 + 1 promotion) + 1 ingest_runs + 1 projection_runs +
		// 1 structured scope + 1 structured revisions + 4 procedures + 1 procedure_revisions +
		// 3 query_cache + 2 telemetry + 2 access_events + 3 memory_mutations
		// + 1 lane_coverage + 1 consolidation_runs + 3 session_chunks = 85
		expect(count).toBe(85)
	})
})

// ---------------------------------------------------------------------------
// Phase 0.1: Events search indexes (CRITICAL BUG FIX)
// ---------------------------------------------------------------------------

describe("events search indexes", () => {
	it("creates text + vector search indexes on events collection", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const eventsCol = db.collection("test_events") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		// Events should get 2 search indexes: text + vector
		expect(eventsCol.createSearchIndex).toHaveBeenCalledTimes(2)

		// Check text index
		const textCall = eventsCol.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "search",
		)
		expect(textCall).toBeDefined()
		expect((textCall![0] as Document).name).toBe("test_events_text")

		// Check vector index
		const vectorCall = eventsCol.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		expect((vectorCall![0] as Document).name).toBe("test_events_vector")
	})

	it("events vector index uses autoEmbed on body field", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const eventsCol = db.collection("test_events") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = eventsCol.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		const fields = (vectorCall![0] as Document).definition.fields
		const autoEmbed = fields.find((f: Document) => f.type === "autoEmbed")
		expect(autoEmbed).toBeDefined()
		expect(autoEmbed.path).toBe("body")
		expect(autoEmbed.model).toBe("voyage-4-large")
		expect(autoEmbed.modality).toBe("text")
	})

	it("events vector index includes agentId, scope, scopeRef, sessionId, role, channel, timestamp filters", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const eventsCol = db.collection("test_events") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = eventsCol.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		const fields = (vectorCall![0] as Document).definition.fields
		const filterPaths = fields
			.filter((f: Document) => f.type === "filter")
			.map((f: Document) => f.path)
		expect(filterPaths).toContain("agentId")
		expect(filterPaths).toContain("scope")
		expect(filterPaths).toContain("scopeRef")
		expect(filterPaths).toContain("sessionId")
		expect(filterPaths).toContain("role")
		expect(filterPaths).toContain("channel")
		expect(filterPaths).toContain("timestamp")
	})

	it("events text index maps body, agentId, scope, scopeRef, sessionId, role, channel, timestamp", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const eventsCol = db.collection("test_events") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const textCall = eventsCol.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "search",
		)
		expect(textCall).toBeDefined()
		const textFields = (textCall![0] as Document).definition.mappings.fields
		expect(textFields.body).toEqual({
			type: "string",
			analyzer: "lucene.standard",
		})
		expect(textFields.agentId).toEqual({ type: "token" })
		expect(textFields.scope).toEqual({ type: "token" })
		expect(textFields.scopeRef).toEqual({ type: "token" })
		expect(textFields.sessionId).toEqual({ type: "token" })
		expect(textFields.role).toEqual({ type: "token" })
		expect(textFields.channel).toEqual({ type: "token" })
		expect(textFields.timestamp).toEqual({ type: "date" })
	})
})

// ---------------------------------------------------------------------------
// Fix 1+2: structured_mem_vector filter fields (temporalScope, validFrom, validTo)
// ---------------------------------------------------------------------------

describe("structured_mem_vector filter fields", () => {
	it("includes temporalScope as a filter field", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const structured = db.collection("test_structured_mem") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = structured.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		const fields = (vectorCall![0] as Document).definition.fields
		const filterPaths = fields
			.filter((f: Document) => f.type === "filter")
			.map((f: Document) => f.path)
		expect(filterPaths).toContain("temporalScope")
	})

	it("includes validFrom and validTo as filter fields for currentOnly pre-filtering", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const structured = db.collection("test_structured_mem") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = structured.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		const fields = (vectorCall![0] as Document).definition.fields
		const filterPaths = fields
			.filter((f: Document) => f.type === "filter")
			.map((f: Document) => f.path)
		expect(filterPaths).toContain("validFrom")
		expect(filterPaths).toContain("validTo")
	})
})

describe("procedures_vector filter fields", () => {
	it("includes validFrom and validTo as filter fields for currentOnly pre-filtering", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const procedures = db.collection("test_procedures") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = procedures.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		const fields = (vectorCall![0] as Document).definition.fields
		const filterPaths = fields
			.filter((f: Document) => f.type === "filter")
			.map((f: Document) => f.path)
		expect(filterPaths).toContain("validFrom")
		expect(filterPaths).toContain("validTo")
	})
})

// ---------------------------------------------------------------------------
// Fix 3: ensureNamedSearchIndex used for all remaining collections
// ---------------------------------------------------------------------------

describe("ensureNamedSearchIndex used for all collections", () => {
	it("uses ensureNamedSearchIndex for kb_chunks (checks listSearchIndexes is called)", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const kbChunks = db.collection("test_kb_chunks") as unknown as {
			listSearchIndexes: ReturnType<typeof vi.fn>
		}
		// ensureNamedSearchIndex calls listSearchIndexes to check for existing indexes
		expect(kbChunks.listSearchIndexes).toHaveBeenCalled()
	})

	it("uses ensureNamedSearchIndex for structured_mem (checks listSearchIndexes is called)", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const structured = db.collection("test_structured_mem") as unknown as {
			listSearchIndexes: ReturnType<typeof vi.fn>
		}
		expect(structured.listSearchIndexes).toHaveBeenCalled()
	})

	it("uses ensureNamedSearchIndex for procedures (checks listSearchIndexes is called)", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const procedures = db.collection("test_procedures") as unknown as {
			listSearchIndexes: ReturnType<typeof vi.fn>
		}
		expect(procedures.listSearchIndexes).toHaveBeenCalled()
	})

	it("uses ensureNamedSearchIndex for query_cache (checks listSearchIndexes is called)", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const queryCache = db.collection("test_query_cache") as unknown as {
			listSearchIndexes: ReturnType<typeof vi.fn>
		}
		expect(queryCache.listSearchIndexes).toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Fix 4: query_cache_vector includes expiresAt filter field
// ---------------------------------------------------------------------------

describe("query_cache_vector expiresAt filter", () => {
	it("includes expiresAt as a filter field in query_cache_vector index", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const qc = db.collection("test_query_cache") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const call = qc.createSearchIndex.mock.calls[0]
		const fields = (call[0] as Document).definition.fields
		const filterPaths = fields
			.filter((f: Document) => f.type === "filter")
			.map((f: Document) => f.path)
		expect(filterPaths).toContain("expiresAt")
	})
})

// ---------------------------------------------------------------------------
// Fix 5: unique index creation wrapped in try/catch
// ---------------------------------------------------------------------------

describe("unique index creation resilience", () => {
	it("continues when uq_kb_hash unique index throws duplicate error", async () => {
		const db = mockDb()
		const kb = db.collection("test_knowledge_base") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		// Override first createIndex call on KB to throw duplicate error
		kb.createIndex.mockRejectedValueOnce(new Error("duplicate key error"))

		const count = await ensureStandardIndexes(db, "test_")
		// Should still return a count (not throw), with the index counted as existing
		expect(count).toBeGreaterThan(0)
	})

	it("continues when uq_kbchunks_path_lines unique index throws already exists error", async () => {
		const db = mockDb()
		const kbChunks = db.collection("test_kb_chunks") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		// First call succeeds (docId index), second call fails (unique path_lines index)
		kbChunks.createIndex
			.mockResolvedValueOnce("test_kb_chunks")
			.mockRejectedValueOnce(new Error("index already exists"))

		const count = await ensureStandardIndexes(db, "test_")
		expect(count).toBeGreaterThan(0)
	})

	it("continues when uq_structured unique index throws already exists error", async () => {
		const db = mockDb()
		const structured = db.collection("test_structured_mem") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
			dropIndex: ReturnType<typeof vi.fn>
		}
		// dropIndex calls succeed (migration), then createIndex for unique index fails
		structured.createIndex.mockRejectedValueOnce(
			new Error("index already exists with duplicate keys"),
		)

		const count = await ensureStandardIndexes(db, "test_")
		expect(count).toBeGreaterThan(0)
	})

	it("re-throws when unique index creation fails with non-duplicate error", async () => {
		const db = mockDb()
		const kb = db.collection("test_knowledge_base") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		kb.createIndex.mockRejectedValueOnce(new Error("connection timeout"))

		await expect(ensureStandardIndexes(db, "test_")).rejects.toThrow(
			"connection timeout",
		)
	})
})
