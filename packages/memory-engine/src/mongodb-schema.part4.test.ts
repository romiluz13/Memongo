/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import {
	ensureSearchIndexes,
	ensureStandardIndexes,
	ensureTimeseriesOrPlain,
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
		expect((textCall?.[0] as Document).name).toBe("test_events_text")

		// Check vector index
		const vectorCall = eventsCol.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		expect((vectorCall?.[0] as Document).name).toBe("test_events_vector")
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
		const fields = (vectorCall?.[0] as Document).definition.fields
		const autoEmbed = fields.find((f: Document) => f.type === "autoEmbed")
		expect(autoEmbed).toBeDefined()
		expect(autoEmbed.path).toBe("body")
		expect(autoEmbed.model).toBe("voyage-4-large")
		expect(autoEmbed.modality).toBe("text")
	})

	it("events vector index declares canonical validity fields as prefilters", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		const eventsCol = db.collection("test_events") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = eventsCol.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		const fields = (vectorCall?.[0] as Document).definition.fields as Document[]
		expect(fields).toEqual(
			expect.arrayContaining([
				{ type: "filter", path: "validAt" },
				{ type: "filter", path: "invalidAt" },
			]),
		)
	})

	it("updates an existing events vector index that lacks validity prefilters", async () => {
		const db = mockDb()
		const events = db.collection("test_events") as unknown as {
			updateSearchIndex: ReturnType<typeof vi.fn>
			listSearchIndexes: ReturnType<typeof vi.fn>
		}
		events.listSearchIndexes.mockImplementation((name?: string) => ({
			toArray: async () =>
				name === "test_events_vector"
					? [
							{
								name,
								type: "vectorSearch",
								definition: {
									fields: [
										{ type: "autoEmbed", path: "body" },
										{ type: "filter", path: "agentId" },
									],
								},
							},
						]
					: [],
		}))

		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		expect(events.updateSearchIndex).toHaveBeenCalledWith(
			"test_events_vector",
			expect.objectContaining({
				fields: expect.arrayContaining([
					{ type: "filter", path: "validAt" },
					{ type: "filter", path: "invalidAt" },
				]),
			}),
		)
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
		const fields = (vectorCall?.[0] as Document).definition.fields
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
		const textFields = (textCall?.[0] as Document).definition.mappings.fields
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
		const fields = (vectorCall?.[0] as Document).definition.fields
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
		const fields = (vectorCall?.[0] as Document).definition.fields
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
		const fields = (vectorCall?.[0] as Document).definition.fields
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

describe("unique index creation strictness", () => {
	// P1-1 (fleet audit): E11000 while building a unique index means the
	// collection already violates the uniqueness the index enforces (the
	// tenant/scope floors). MongoDB builds no partial index, so continuing
	// would leave the constraint permanently unenforced behind a log line.
	it("fails bootstrap when a unique index hits E11000 duplicates", async () => {
		const db = mockDb()
		const kb = db.collection("test_knowledge_base") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const dup = Object.assign(
			new Error(
				"E11000 duplicate key error collection: test_knowledge_base index: uq_kb_scope_hash",
			),
			{ code: 11000 },
		)
		kb.createIndex.mockRejectedValueOnce(dup)

		await expect(ensureStandardIndexes(db, "test_")).rejects.toThrow(
			/uq_kb_scope_hash.*cannot be enforced/,
		)
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
			new Error("index with that name already exists"),
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

// ---------------------------------------------------------------------------
// Time series fallback (ensureTimeseriesOrPlain)
// ---------------------------------------------------------------------------

describe("ensureTimeseriesOrPlain", () => {
	it("creates a time series collection when supported", async () => {
		const db = mockDb()
		await ensureTimeseriesOrPlain(db, "test_telemetry", {
			timeField: "ts",
			metaField: "meta",
			granularity: "seconds",
			expireAfterSeconds: 604800,
		})

		expect(db.createCollection).toHaveBeenCalledWith(
			"test_telemetry",
			expect.objectContaining({
				timeseries: expect.objectContaining({
					timeField: "ts",
					granularity: "seconds",
				}),
				expireAfterSeconds: 604800,
			}),
		)
	})

	it("falls back to a plain collection with a TTL index when time series is unsupported", async () => {
		const collections = new Map<string, Collection>()
		const db = {
			createCollection: vi.fn(
				async (name: string, options?: Record<string, unknown>) => {
					if (options?.timeseries) {
						throw new Error("time series collections are not supported")
					}
					const col = mockCollection(name)
					collections.set(name, col)
					return col
				},
			),
			collection: vi.fn((name: string) => {
				if (!collections.has(name)) {
					collections.set(name, mockCollection(name))
				}
				return collections.get(name)!
			}),
		} as unknown as Db

		await ensureTimeseriesOrPlain(db, "test_telemetry", {
			timeField: "ts",
			metaField: "meta",
			granularity: "seconds",
			expireAfterSeconds: 604800,
		})

		// Plain collection created (no timeseries option)
		expect(db.createCollection).toHaveBeenCalledWith("test_telemetry")
		// TTL index created on the timeField
		const col = collections.get("test_telemetry")!
		expect(col.createIndex).toHaveBeenCalledWith(
			{ ts: 1 },
			expect.objectContaining({ expireAfterSeconds: 604800 }),
		)
	})

	it("is idempotent when the collection already exists", async () => {
		let createCallCount = 0
		const db = {
			createCollection: vi.fn(async () => {
				createCallCount++
				throw new Error("collection already exists")
			}),
		} as unknown as Db

		await ensureTimeseriesOrPlain(db, "test_telemetry", {
			timeField: "ts",
			metaField: "meta",
			granularity: "seconds",
			expireAfterSeconds: 604800,
		})

		// "already exists" means the timeseries is already there — no fallback.
		expect(createCallCount).toBe(1)
	})
})
