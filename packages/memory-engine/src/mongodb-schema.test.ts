/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import {
	ensureCollections,
	ensureSchemaValidation,
	ensureSearchIndexes,
	ensureStandardIndexes,
	shouldEnsureTextFallbackIndexes,
	chunksCollection,
	filesCollection,
	metaCollection,
	getExpectedSearchIndexTargets,
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

function mockDb(
	existingCollections: string[] = [],
	versionArray?: unknown,
): Db {
	const collections = new Map<string, Collection>()

	const db = {
		collection: vi.fn((name: string) => {
			if (!collections.has(name)) {
				collections.set(name, mockCollection(name))
			}
			return collections.get(name)!
		}),
		command: vi.fn(async () => ({ ok: 1 })),
		...(versionArray !== undefined
			? {
					admin: vi.fn(() => ({
						command: vi.fn(async () => ({ versionArray })),
					})),
				}
			: {}),
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
		const validator = kbChunksCall?.[1]?.validator
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
		const validator = kbChunksCall?.[1]?.validator
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
		const validator = kbCall?.[1]?.validator
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
				call?.[1]?.validator,
				`expected test_${name} to have a validator`,
			).toBeDefined()
			expect(call?.[1]?.validator.$jsonSchema).toBeDefined()
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
		const schema = eventsCall?.[1]?.validator.$jsonSchema
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
		const schema = qCall?.[1]?.validator.$jsonSchema
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
		const schema = eventsCall?.[1]?.validator.$jsonSchema
		// Bi-temporal  fields: validAt records when the assertion became
		// true; invalidAt (nullable) records when it stopped being true.
		expect(schema.properties.validAt).toBeDefined()
		expect(schema.properties.validAt.bsonType).toBe("date")
		expect(schema.properties.invalidAt).toBeDefined()
		// invalidAt accepts `date` OR null per the retrieval filter
		// `invalidAt IS NULL OR invalidAt > queryTime`.
		expect(schema.properties.invalidAt.bsonType).toEqual(["date", "null"])
		expect(schema.properties.expiresAt.bsonType).toBe("date")
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
		const schema = chunksCall?.[1]?.validator.$jsonSchema
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
		// 30 = 28 baseline + 1 memory_quarantine (embedding_cache removed, #13)
		// + 1 memory_cost_ledger (C-017)
		expect(db.createCollection).toHaveBeenCalledTimes(30)
		// Non-validated collections: called with name only
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_files",
			expect.objectContaining({ validator: expect.any(Object) }),
		)
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
		// 28 = 30 new total - 2 skipped (embedding_cache removed, #13).
		expect(db.createCollection).toHaveBeenCalledTimes(28)
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
			"oc_memory_cost_ledger",
		])
		await ensureCollections(db, "oc_")
		expect(db.createCollection).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// ensureStandardIndexes
// ---------------------------------------------------------------------------

describe("ensureStandardIndexes", () => {
	it("creates all standard indexes on chunks, KB, and structured_mem", async () => {
		const db = mockDb()
		const count = await ensureStandardIndexes(db, "test_")

		const chunks = db.collection("test_chunks") as unknown as {
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

		// 4 chunks (path+hash, updated, text, P3.8 agent+path+startLine ESR) + 5 KB + 4 KB chunks (3 + 1 wiki) + 8 structured (6 + 1 v2 scope + 1 sourceEvent) +
		// 1 structured revisions + 3 relevance_runs + 2 relevance_artifacts +
		// 2 relevance_regressions + 9 events (6 + 1 dreamerProcessedAt + 1 bi-temporal SE-1 + 1 idempotency) + 6 entities (3 + 2 Phase 3.4 + 1 P3.8 agent/updatedAt ESR) + 4 relations +
		// 2 entity links + 7 episodes (6 base + 1 promotion) + 1 ingest_runs + 1 projection_runs +
		// 4 procedures + 1 procedure_revisions + 3 query_cache + 2 telemetry + 2 access_events
		// + 3 memory_mutations (compound + TTL + per-document)
		// + 1 lane_coverage (unique agentId)
		// + 2 consolidation_runs (agent_time + gate lease)
		// + 1 events idempotency key (unique partial)
		// + 3 sourceRef dedup (events, structured, procedures)
		// + 1 partial index (structured active facts) + 2 sourceEvent dedup indexes
		// + 3 session_chunks + 1 bi-temporal valid-time (#32)
		// + 1 durable memory-job claim index + 1 extraction outbox partial index
		// + 1 unique relation identity index
		// P3.8: −3 retired redundant indexes (idx_chunks_path, idx_structured_agentid,
		// idx_relations_agent_scope_scoperef), +1 chunk ESR, +1 episode ESR,
		// +1 entity ESR, +1 relationId locator
		// P4.4.1: +2 partial TTL indexes (events, structured_mem)
		// C-005: +2 partial TTL indexes (chunks + session_chunks expiresAt)
		// C-004: +3 memory_quarantine (unique id, queue listing, pending TTL)
		// C-017 (WS-10): +2 cost ledger (unique agent/day/kind + TTL)
		// Total = 102
		expect(count).toBe(102)
		expect(chunks.createIndex).toHaveBeenCalledTimes(5)
		// C-005: per-document chunk TTL, mirroring idx_events_ttl_expires_at.
		expect(chunks.createIndex).toHaveBeenCalledWith(
			{ expiresAt: 1 },
			{
				name: "idx_chunks_ttl_expires_at",
				expireAfterSeconds: 0,
				partialFilterExpression: { expiresAt: { $exists: true } },
			},
		)
		expect(kb.createIndex).toHaveBeenCalledTimes(5)
		expect(kbChunks.createIndex).toHaveBeenCalledTimes(4)
		expect(structured.createIndex).toHaveBeenCalledTimes(11)
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
		const ingestRuns = db.collection("test_ingest_runs") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const projectionRuns = db.collection("test_projection_runs") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(events.createIndex).toHaveBeenCalledTimes(12)
		expect(events.createIndex).toHaveBeenCalledWith(
			{ agentId: 1, extractionJobPendingAt: 1 },
			{
				name: "idx_events_agent_extraction_pending",
				partialFilterExpression: {
					extractionJobPendingAt: { $type: "date" },
				},
			},
		)
		expect(events.createIndex).toHaveBeenCalledWith(
			{ agentId: 1, idempotencyKey: 1 },
			{
				name: "uq_events_agent_idempotency_key",
				unique: true,
				partialFilterExpression: {
					idempotencyKey: { $type: "string" },
				},
			},
		)
		expect(entities.createIndex).toHaveBeenCalledTimes(6)
		expect(relations.createIndex).toHaveBeenCalledTimes(6)
		expect(relations.createIndex).toHaveBeenCalledWith(
			{
				agentId: 1,
				scope: 1,
				scopeRef: 1,
				fromEntityId: 1,
				toEntityId: 1,
				type: 1,
			},
			{ name: "uq_relations_identity", unique: true },
		)
		expect(entityLinks.createIndex).toHaveBeenCalledTimes(2)
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
		expect(sessionChunks.createIndex).toHaveBeenCalledTimes(4)
		// C-005: session-evidence docs inherit source-event expiry, so the
		// collection gets the same partial TTL index as chunks.
		expect(sessionChunks.createIndex).toHaveBeenCalledWith(
			{ expiresAt: 1 },
			{
				name: "idx_session_chunks_ttl_expires_at",
				expireAfterSeconds: 0,
				partialFilterExpression: { expiresAt: { $exists: true } },
			},
		)
		const memoryJobs = db.collection("test_memory_jobs") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(memoryJobs.createIndex).toHaveBeenCalledWith(
			{
				agentId: 1,
				jobType: 1,
				status: 1,
				leaseExpiresAt: 1,
				createdAt: 1,
				jobId: 1,
			},
			{ name: "idx_memory_jobs_claim_v2" },
		)
		expect(memoryJobs.dropIndex).toHaveBeenCalledWith("idx_memory_jobs_claim")
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
			// 102 base (incl. 2 consolidation_runs + events idempotency key,
			// 2 P4.4.1 partial TTL indexes, the 2 C-005 chunks/session_chunks
			// TTL indexes, the 3 C-004 memory_quarantine indexes, and the
			// 2 C-017 cost-ledger indexes)
			// + 4 evidence mirror indexes
			expect(count).toBe(106)
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
		expect(bitemporal?.[0]).toEqual({
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
		expect(textIndexCall?.[1]).toEqual({ name: "idx_chunks_text" })
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
		expect(ttlCall?.[1]).toMatchObject({
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

	it("index count includes relevance telemetry indexes and v2 collection indexes", async () => {
		const db = mockDb()
		const count = await ensureStandardIndexes(db, "test_")
		// 25 (v1 base, embedding_cache removed #13) + 9 events (6 + 1 dreamerProcessedAt + 1 bi-temporal SE-1 + 1 idempotency) + 3 entities + 4 relations +
		// 2 entity links + 7 episodes (6 base + 1 promotion) + 1 ingest_runs + 1 projection_runs +
		// 1 structured scope + 1 structured revisions + 4 procedures + 1 procedure_revisions +
		// 3 query_cache + 2 telemetry + 2 access_events + 3 memory_mutations
		// + 1 lane_coverage + 2 consolidation_runs + 3 session_chunks
		// + 1 bi-temporal valid-time (#32) + 2 durable job claim/TTL indexes
		// + 1 extraction outbox partial index + 1 unique relation identity
		// P3.8: −3 retired redundant indexes + 3 ESR compounds + 1 relationId locator
		// P4.4.1: +2 partial TTL indexes (events, structured_mem)
		// C-005: +2 partial TTL indexes (chunks + session_chunks expiresAt)
		// C-004: +3 memory_quarantine (unique id, queue listing, pending TTL)
		// C-017 (WS-10): +2 cost ledger (unique agent/day/kind + TTL)
		// Total = 102
		expect(count).toBe(102)
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

	it("creates a structured-revisions TTL index only when revisionRetentionDays is set (#32)", async () => {
		const withoutTtl = mockDb()
		await ensureStandardIndexes(withoutTtl, "test_")
		const revsOff = withoutTtl.collection(
			"test_structured_mem_revisions",
		) as unknown as { createIndex: ReturnType<typeof vi.fn> }
		expect(
			revsOff.createIndex.mock.calls.find(
				(c: unknown[]) =>
					(c[1] as Record<string, unknown>)?.name ===
					"idx_structured_revisions_ttl",
			),
		).toBeUndefined()

		const withTtl = mockDb()
		await ensureStandardIndexes(withTtl, "test_", { revisionRetentionDays: 30 })
		const revsOn = withTtl.collection(
			"test_structured_mem_revisions",
		) as unknown as { createIndex: ReturnType<typeof vi.fn> }
		const ttlCall = revsOn.createIndex.mock.calls.find(
			(c: unknown[]) =>
				(c[1] as Record<string, unknown>)?.name ===
				"idx_structured_revisions_ttl",
		)
		expect(ttlCall).toBeDefined()
		expect((ttlCall?.[1] as Record<string, unknown>).expireAfterSeconds).toBe(
			30 * 24 * 60 * 60,
		)
	})

	it("creates the memory_quarantine review-lifecycle indexes (C-004)", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const quarantine = db.collection("test_memory_quarantine") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(quarantine.createIndex).toHaveBeenCalledTimes(3)
		// Unique id for promote/reject point lookups.
		expect(quarantine.createIndex).toHaveBeenCalledWith(
			{ quarantineId: 1 },
			{ name: "uq_memory_quarantine_quarantineid", unique: true },
		)
		// Review-queue listing: equality agentId+status, ascending createdAt.
		expect(quarantine.createIndex).toHaveBeenCalledWith(
			{ agentId: 1, status: 1, createdAt: 1 },
			{ name: "idx_memory_quarantine_agent_status_created" },
		)
		// Retention cap on UNREVIEWED entries only, 30-day default. Partial on
		// status so promote/reject decisions (the audit trail) never expire.
		expect(quarantine.createIndex).toHaveBeenCalledWith(
			{ createdAt: 1 },
			{
				name: "idx_memory_quarantine_ttl_pending",
				expireAfterSeconds: 30 * 24 * 60 * 60,
				partialFilterExpression: { status: "pending-review" },
			},
		)
	})

	it("honors quarantineRetentionDays override and explicit 0 disables the TTL (C-004)", async () => {
		const withOverride = mockDb()
		await ensureStandardIndexes(withOverride, "test_", {
			quarantineRetentionDays: 7,
		})
		const overridden = withOverride.collection(
			"test_memory_quarantine",
		) as unknown as { createIndex: ReturnType<typeof vi.fn> }
		const ttlCall = overridden.createIndex.mock.calls.find(
			(c: unknown[]) =>
				(c[1] as Record<string, unknown>)?.name ===
				"idx_memory_quarantine_ttl_pending",
		)
		expect(ttlCall).toBeDefined()
		expect((ttlCall?.[1] as Record<string, unknown>).expireAfterSeconds).toBe(
			7 * 24 * 60 * 60,
		)

		const disabled = mockDb()
		await ensureStandardIndexes(disabled, "test_", {
			quarantineRetentionDays: 0,
		})
		const quarantineOff = disabled.collection(
			"test_memory_quarantine",
		) as unknown as { createIndex: ReturnType<typeof vi.fn> }
		expect(
			quarantineOff.createIndex.mock.calls.find(
				(c: unknown[]) =>
					(c[1] as Record<string, unknown>)?.name ===
					"idx_memory_quarantine_ttl_pending",
			),
		).toBeUndefined()
		// The non-TTL review indexes are still created.
		expect(quarantineOff.createIndex).toHaveBeenCalledTimes(2)
	})
})

// ---------------------------------------------------------------------------
// P3.8: index hygiene — redundant index retirement, ESR compounds,
// conditional $text fallback indexes, relationId locator index
// ---------------------------------------------------------------------------

describe("P3.8 index hygiene", () => {
	it("decides BSON text fallbacks from serving readiness, not management API availability", () => {
		expect(
			shouldEnsureTextFallbackIndexes({
				textSearch: false,
			}),
		).toBe(true)
		expect(
			shouldEnsureTextFallbackIndexes({
				textSearch: true,
			}),
		).toBe(false)
	})

	it("drops the three strict-prefix-redundant indexes and never recreates them", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")

		const chunks = db.collection("test_chunks") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
			dropIndex: ReturnType<typeof vi.fn>
		}
		const structured = db.collection("test_structured_mem") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
			dropIndex: ReturnType<typeof vi.fn>
		}
		const relations = db.collection("test_relations") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
			dropIndex: ReturnType<typeof vi.fn>
		}

		// Existing deployments keep a retired index unless bootstrap drops it —
		// the structured_mem unique-index create/drop dance is the precedent.
		expect(chunks.dropIndex).toHaveBeenCalledWith("idx_chunks_path")
		expect(structured.dropIndex).toHaveBeenCalledWith("idx_structured_agentid")
		expect(relations.dropIndex).toHaveBeenCalledWith(
			"idx_relations_agent_scope_scoperef",
		)

		const createdNames = (col: {
			createIndex: ReturnType<typeof vi.fn>
		}): string[] =>
			col.createIndex.mock.calls.map(
				(c: unknown[]) => (c[1] as { name?: string })?.name ?? "",
			)
		expect(createdNames(chunks)).not.toContain("idx_chunks_path")
		expect(createdNames(structured)).not.toContain("idx_structured_agentid")
		expect(createdNames(relations)).not.toContain(
			"idx_relations_agent_scope_scoperef",
		)
	})

	it("creates the chunk ESR compound {agentId, path, startLine}", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const chunks = db.collection("test_chunks") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(chunks.createIndex).toHaveBeenCalledWith(
			{ agentId: 1, path: 1, startLine: 1 },
			{ name: "idx_chunks_agent_path_startline" },
		)
	})

	it("creates the episode ESR compound {agentId, type, updatedAt desc}", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const episodes = db.collection("test_episodes") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(episodes.createIndex).toHaveBeenCalledWith(
			{ agentId: 1, type: 1, updatedAt: -1 },
			{ name: "idx_episodes_agent_type_updated" },
		)
	})

	it("creates the entity ESR compound {agentId, updatedAt desc}", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const entities = db.collection("test_entities") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(entities.createIndex).toHaveBeenCalledWith(
			{ agentId: 1, updatedAt: -1 },
			{ name: "idx_entities_agent_updated" },
		)
	})

	it("creates the relationId locator index on relations", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const relations = db.collection("test_relations") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(relations.createIndex).toHaveBeenCalledWith(
			{ agentId: 1, scope: 1, scopeRef: 1, relationId: 1 },
			{ name: "idx_relations_agent_scope_scoperef_relationid" },
		)
	})

	it("creates all six $text fallback indexes by default", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const textIndexNames = [
			["test_chunks", "idx_chunks_text"],
			["test_kb_chunks", "idx_kbchunks_text"],
			["test_structured_mem", "idx_structured_text"],
			["test_entities", "idx_entities_text"],
			["test_episodes", "idx_episodes_text"],
			["test_procedures", "idx_procedures_text"],
		] as const
		for (const [collectionName, indexName] of textIndexNames) {
			const col = db.collection(collectionName) as unknown as {
				createIndex: ReturnType<typeof vi.fn>
			}
			const found = col.createIndex.mock.calls.some(
				(c: unknown[]) => (c[1] as { name?: string })?.name === indexName,
			)
			expect(found, `${indexName} on ${collectionName}`).toBe(true)
		}
	})

	it("skips all six $text fallback indexes when textFallbackIndexes is false", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_", { textFallbackIndexes: false })
		const textIndexNames = [
			["test_chunks", "idx_chunks_text"],
			["test_kb_chunks", "idx_kbchunks_text"],
			["test_structured_mem", "idx_structured_text"],
			["test_entities", "idx_entities_text"],
			["test_episodes", "idx_episodes_text"],
			["test_procedures", "idx_procedures_text"],
		] as const
		for (const [collectionName, indexName] of textIndexNames) {
			const col = db.collection(collectionName) as unknown as {
				createIndex: ReturnType<typeof vi.fn>
			}
			const found = col.createIndex.mock.calls.some(
				(c: unknown[]) => (c[1] as { name?: string })?.name === indexName,
			)
			expect(found, `${indexName} on ${collectionName}`).toBe(false)
		}
	})

	it("creates the episode_autocomplete search index alongside entity_autocomplete", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
		const episodes = db.collection("test_episodes") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const episodeCall = episodes.createSearchIndex.mock.calls.find(
			(c: unknown[]) =>
				(c[0] as { name?: string })?.name === "episode_autocomplete",
		) as unknown[] | undefined
		expect(episodeCall).toBeDefined()
		const spec = episodeCall?.[0] as Document
		expect(spec.type).toBe("search")
		const fields = spec.definition?.mappings?.fields ?? {}
		expect(fields.title?.type).toBe("autocomplete")
		expect(fields.summary?.type).toBe("autocomplete")
		expect(fields.agentId?.type).toBe("token")
		expect(fields.scope?.type).toBe("token")
		expect(fields.scopeRef?.type).toBe("token")
	})

	it("plans the episode_autocomplete target in the default search index list", () => {
		const targets = getExpectedSearchIndexTargets(
			"test_",
			"atlas-local-preview",
		)
		expect(targets).toContainEqual({
			collectionName: "test_episodes",
			indexNames: ["episode_autocomplete"],
		})
	})
})

// ---------------------------------------------------------------------------
// P4.4.1: TTL expiration — partial TTL indexes on events + structured_mem
// ---------------------------------------------------------------------------

describe("P4.4.1 TTL expiration indexes", () => {
	it("creates the partial TTL index on events with expireAfterSeconds 0", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const events = db.collection("test_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(events.createIndex).toHaveBeenCalledWith(
			{ expiresAt: 1 },
			{
				name: "idx_events_ttl_expires_at",
				expireAfterSeconds: 0,
				partialFilterExpression: { expiresAt: { $exists: true } },
			},
		)
	})

	it("creates the partial TTL index on structured_mem with expireAfterSeconds 0", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const structured = db.collection("test_structured_mem") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(structured.createIndex).toHaveBeenCalledWith(
			{ expiresAt: 1 },
			{
				name: "idx_structured_ttl_expires_at",
				expireAfterSeconds: 0,
				partialFilterExpression: { expiresAt: { $exists: true } },
			},
		)
	})
})

// ---------------------------------------------------------------------------
// ensureSearchIndexes
// ---------------------------------------------------------------------------

describe("validationAction version gate (P3.5)", () => {
	it("uses errorAndLog on MongoDB 8.1+ when creating collections", async () => {
		const db = mockDb([], [8, 1, 0, 0])
		await ensureCollections(db, "test_")
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_chunks",
			expect.objectContaining({ validationAction: "errorAndLog" }),
		)
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_knowledge_base",
			expect.objectContaining({ validationAction: "errorAndLog" }),
		)
	})

	it("keeps error below MongoDB 8.1 when creating collections", async () => {
		const db = mockDb([], [8, 0, 13, 0])
		await ensureCollections(db, "test_")
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_chunks",
			expect.objectContaining({ validationAction: "error" }),
		)
	})

	it("keeps error when the server version is unknown", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		expect(db.createCollection).toHaveBeenCalledWith(
			"test_chunks",
			expect.objectContaining({ validationAction: "error" }),
		)
	})

	it("uses errorAndLog on MongoDB 8.1+ for collMod schema validation", async () => {
		const db = mockDb([], [8, 2, 6, 0])
		await ensureSchemaValidation(db, "test_")
		expect(db.command).toHaveBeenCalledWith(
			expect.objectContaining({
				collMod: "test_chunks",
				validationAction: "errorAndLog",
			}),
		)
	})

	it("keeps error below MongoDB 8.1 for collMod schema validation", async () => {
		const db = mockDb([], [8, 0, 13, 0])
		await ensureSchemaValidation(db, "test_")
		expect(db.command).toHaveBeenCalledWith(
			expect.objectContaining({
				collMod: "test_chunks",
				validationAction: "error",
			}),
		)
	})
})
