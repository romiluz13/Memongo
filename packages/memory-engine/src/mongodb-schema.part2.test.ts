/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import {
	isCapabilityEnabled,
	resetCapabilityProbes,
} from "./mongodb-capability-registry.js"
import {
	assertIndexBudget,
	ensureSearchIndexes,
	getExpectedSearchIndexTargets,
	isSearchIndexTypeCompatible,
	isSearchIndexQueryable,
	resolveSearchIndexReadinessTiming,
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
		expect((textCall?.[0] as Document).name).toBe("test_chunks_text")

		// Check vector index uses MongoDB autoEmbed on the text field.
		const vectorCall = chunks.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		expect(vectorCall).toBeDefined()
		expect((vectorCall?.[0] as Document).name).toBe("test_chunks_vector")
		const vectorFields = (vectorCall?.[0] as Document).definition.fields
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

	it("ships vector definitions with no option the server rejects (V1)", async () => {
		// Regression. ensureSearchIndexes used to add `storedSource: true` and
		// `indexingMethod: "flat"` to every vector index whenever buildInfo
		// reported MongoDB 8.3+. Verified against a live 8.3.4 cluster, the
		// server rejects the first outright — "storedSource: true is not
		// supported for vector indexes. Accepted values are include, exclude, or
		// false" — and each creation is wrapped in a catch that only logs. On
		// 8.3 and newer every vector index therefore failed to create and
		// ensureSearchIndexes returned {text: true, vector: false}: no semantic
		// retrieval at all, silently, on exactly the versions the gate was
		// written to light up.
		//
		// The per-field options are not ours to choose either. The same cluster
		// rejects quantization ("Omit quantization to use the default (float)"),
		// similarity ("...the default (dotProduct)"), numDimensions ("The
		// embedding model determines dimensions automatically") and field-level
		// indexingMethod ("Omit indexingMethod to use default HNSW") on an
		// autoEmbed field. The embedding model determines all of them.
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")

		// Collect every vectorSearch definition this run produced.
		const vectorCalls: Document[] = []
		for (const collectionName of [
			"test_chunks",
			"test_kb_chunks",
			"test_structured_mem",
			"test_procedures",
			"test_events",
			"test_query_cache",
			"test_session_chunks",
		]) {
			const col = db.collection(collectionName) as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			for (const call of col.createSearchIndex.mock.calls) {
				const spec = call[0] as Document
				if (spec.type === "vectorSearch") {
					vectorCalls.push(spec)
				}
			}
		}

		// If this is ever 0 the assertions below become vacuous.
		expect(vectorCalls.length).toBeGreaterThan(0)

		for (const spec of vectorCalls) {
			expect(spec.definition.storedSource).toBeUndefined()
			expect(spec.definition.indexingMethod).toBeUndefined()
			for (const field of spec.definition.fields as Document[]) {
				if (field.type !== "autoEmbed") {
					continue
				}
				for (const rejected of [
					"quantization",
					"similarity",
					"numDimensions",
					"indexingMethod",
				]) {
					expect(field[rejected]).toBeUndefined()
				}
			}
		}
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

		const vectorFields = (vectorCall?.[0] as Document).definition.fields
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
			const fields = (vectorCall?.[0] as Document).definition
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

	it("sets indexingMethod on every autoEmbed field when MEMONGO_VECTOR_INDEXING_METHOD=flat", async () => {
		// Re-probed live on Atlas 8.3.7 (2026-07-30): field-level
		// indexingMethod:"flat" on an autoEmbed field is now ACCEPTED and the
		// index builds to READY/queryable — the 8.3.4 rejection ("Omit
		// indexingMethod to use default HNSW") no longer holds. Flat indexes
		// are the documented fit for selective-prefilter multitenant queries,
		// which is exactly the scope/scopeRef pattern every lane uses. The
		// default stays omit (server default HNSW); flat is a deliberate
		// opt-in via env so the choice is recorded in benchmark run identity.
		const previous = process.env.MEMONGO_VECTOR_INDEXING_METHOD
		process.env.MEMONGO_VECTOR_INDEXING_METHOD = "flat"
		try {
			const db = mockDb()
			await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")

			const vectorCalls: Document[] = []
			for (const collectionName of [
				"test_chunks",
				"test_kb_chunks",
				"test_structured_mem",
				"test_procedures",
				"test_events",
				"test_query_cache",
				"test_session_chunks",
			]) {
				const col = db.collection(collectionName) as unknown as {
					createSearchIndex: ReturnType<typeof vi.fn>
				}
				for (const call of col.createSearchIndex.mock.calls) {
					const spec = call[0] as Document
					if (spec.type === "vectorSearch") {
						vectorCalls.push(spec)
					}
				}
			}
			expect(vectorCalls.length).toBeGreaterThan(0)
			for (const spec of vectorCalls) {
				for (const field of spec.definition.fields as Document[]) {
					if (field.type === "autoEmbed") {
						expect(field.indexingMethod).toBe("flat")
					}
				}
			}
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_VECTOR_INDEXING_METHOD
			} else {
				process.env.MEMONGO_VECTOR_INDEXING_METHOD = previous
			}
		}
	})

	it("omits indexingMethod for hnsw, empty, and invalid MEMONGO_VECTOR_INDEXING_METHOD", async () => {
		const previous = process.env.MEMONGO_VECTOR_INDEXING_METHOD
		try {
			for (const value of ["hnsw", "", "diskann"]) {
				process.env.MEMONGO_VECTOR_INDEXING_METHOD = value
				const db = mockDb()
				await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")
				const chunks = db.collection("test_chunks") as unknown as {
					createSearchIndex: ReturnType<typeof vi.fn>
				}
				const vectorCall = chunks.createSearchIndex.mock.calls.find(
					(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
				)
				expect(vectorCall).toBeDefined()
				const fields = (vectorCall?.[0] as Document).definition
					.fields as Document[]
				expect(
					fields.find((field) => field.type === "autoEmbed"),
				).not.toHaveProperty("indexingMethod")
			}
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_VECTOR_INDEXING_METHOD
			} else {
				process.env.MEMONGO_VECTOR_INDEXING_METHOD = previous
			}
		}
	})

	it("adds storedSource include-lists to search-lane vector indexes when MEMONGO_VECTOR_STORED_SOURCE=1", async () => {
		// Include lists come from the 2026-07-31 field-usage map of every
		// consumer of $vectorSearch results (issue #66). Scope is deliberate:
		// events is excluded because its recall pipelines $match on
		// validAt/invalidAt AFTER $vectorSearch — with returnStoredSource and
		// those fields missing, $exists:false branches pass everything and
		// bi-temporal enforcement silently dies; query_cache is excluded
		// because its results blob is unbounded; memory_evidence keeps full
		// lookup. Consolidator/novelty paths never pass returnStoredSource, so
		// they keep reading full documents regardless.
		const previous = process.env.MEMONGO_VECTOR_STORED_SOURCE
		process.env.MEMONGO_VECTOR_STORED_SOURCE = "1"
		try {
			const db = mockDb()
			await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")

			const vectorDefFor = (collectionName: string): Document => {
				const col = db.collection(collectionName) as unknown as {
					createSearchIndex: ReturnType<typeof vi.fn>
				}
				const call = col.createSearchIndex.mock.calls.find(
					(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
				)
				expect(call, collectionName).toBeDefined()
				return (call?.[0] as Document).definition
			}

			expect(vectorDefFor("test_chunks").storedSource).toEqual({
				include: [
					"path",
					"startLine",
					"endLine",
					"text",
					"source",
					"sessionId",
					"sourceEventIds",
					"updatedAt",
					"timestamp",
					"scope",
					"scopeRef",
					"canonicalId",
					"unit",
					"provenance",
					"metadata.sourceEventIds",
				],
			})
			expect(vectorDefFor("test_session_chunks").storedSource).toEqual({
				include: [
					"path",
					"startLine",
					"endLine",
					"text",
					"source",
					"sessionId",
					"sourceEventIds",
					"updatedAt",
					"timestamp",
					"scope",
					"scopeRef",
					"canonicalId",
					"unit",
					"provenance",
					"metadata.sourceEventIds",
				],
			})
			expect(vectorDefFor("test_kb_chunks").storedSource).toEqual({
				include: ["path", "startLine", "endLine", "text", "docId", "updatedAt"],
			})
			expect(vectorDefFor("test_structured_mem").storedSource).toEqual({
				include: [
					"type",
					"key",
					"value",
					"context",
					"confidence",
					"tags",
					"scope",
					"scopeRef",
					"state",
					"salience",
					"temporalScope",
					"sessionId",
					"updatedAt",
					"provenance",
					"sourceEventIds",
					"sourceReliability",
					"reinforcementCount",
					"validFrom",
					"validTo",
					"reviewAt",
					"lastConfirmedAt",
					"artifact",
				],
			})
			expect(vectorDefFor("test_procedures").storedSource).toEqual({
				include: [
					"procedureId",
					"searchText",
					"sessionId",
					"updatedAt",
					"state",
					"scope",
					"scopeRef",
					"provenance",
					"sourceEventIds",
					"validFrom",
					"validTo",
					"confidence",
				],
			})

			// Excluded collections must never carry storedSource, whichever of
			// them created a vector index in this mode.
			for (const excluded of [
				"test_events",
				"test_query_cache",
				"test_memory_evidence",
			]) {
				const col = db.collection(excluded) as unknown as {
					createSearchIndex: ReturnType<typeof vi.fn>
				}
				for (const call of col.createSearchIndex.mock.calls) {
					const spec = call[0] as Document
					if (spec.type === "vectorSearch") {
						expect(spec.definition.storedSource, excluded).toBeUndefined()
					}
				}
			}
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_VECTOR_STORED_SOURCE
			} else {
				process.env.MEMONGO_VECTOR_STORED_SOURCE = previous
			}
		}
	})

	it("omits storedSource from all vector indexes when MEMONGO_VECTOR_STORED_SOURCE is unset", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")
		for (const collectionName of [
			"test_chunks",
			"test_kb_chunks",
			"test_structured_mem",
			"test_procedures",
			"test_events",
			"test_query_cache",
			"test_session_chunks",
			"test_memory_evidence",
		]) {
			const col = db.collection(collectionName) as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			for (const call of col.createSearchIndex.mock.calls) {
				const spec = call[0] as Document
				if (spec.type === "vectorSearch") {
					expect(spec.definition.storedSource, collectionName).toBeUndefined()
				}
			}
		}
	})

	it("enables storedSource include-lists by default on MongoDB 8.3.7+ (P3.3)", async () => {
		const previous = process.env.MEMONGO_VECTOR_STORED_SOURCE
		delete process.env.MEMONGO_VECTOR_STORED_SOURCE
		try {
			const db = mockDb([], [8, 3, 7, 0])
			await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")

			const chunks = db.collection("test_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			const vectorCall = chunks.createSearchIndex.mock.calls.find(
				(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
			)
			expect(vectorCall).toBeDefined()
			expect((vectorCall?.[0] as Document).definition.storedSource).toEqual({
				include: expect.arrayContaining(["text", "path", "provenance"]),
			})

			// Events stays excluded: its recall pipelines $match on
			// validAt/invalidAt AFTER $vectorSearch.
			const events = db.collection("test_events") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			for (const call of events.createSearchIndex.mock.calls) {
				const spec = call[0] as Document
				if (spec.type === "vectorSearch") {
					expect(spec.definition.storedSource).toBeUndefined()
				}
			}
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_VECTOR_STORED_SOURCE
			} else {
				process.env.MEMONGO_VECTOR_STORED_SOURCE = previous
			}
		}
	})

	it("keeps storedSource off below MongoDB 8.3.7 when the env var is unset (P3.3)", async () => {
		const previous = process.env.MEMONGO_VECTOR_STORED_SOURCE
		delete process.env.MEMONGO_VECTOR_STORED_SOURCE
		try {
			const db = mockDb([], [8, 3, 0, 0])
			await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")
			const chunks = db.collection("test_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			const vectorCall = chunks.createSearchIndex.mock.calls.find(
				(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
			)
			expect(vectorCall).toBeDefined()
			expect(
				(vectorCall?.[0] as Document).definition.storedSource,
			).toBeUndefined()
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_VECTOR_STORED_SOURCE
			} else {
				process.env.MEMONGO_VECTOR_STORED_SOURCE = previous
			}
		}
	})

	it("MEMONGO_VECTOR_STORED_SOURCE=0 forces storedSource off even on 8.3.7+ (P3.3)", async () => {
		const previous = process.env.MEMONGO_VECTOR_STORED_SOURCE
		process.env.MEMONGO_VECTOR_STORED_SOURCE = "0"
		try {
			const db = mockDb([], [8, 3, 7, 0])
			await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")
			const chunks = db.collection("test_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			const vectorCall = chunks.createSearchIndex.mock.calls.find(
				(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
			)
			expect(vectorCall).toBeDefined()
			expect(
				(vectorCall?.[0] as Document).definition.storedSource,
			).toBeUndefined()
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_VECTOR_STORED_SOURCE
			} else {
				process.env.MEMONGO_VECTOR_STORED_SOURCE = previous
			}
		}
	})

	it("passes the configured quantization into autoEmbed vector fields (P3.4)", async () => {
		resetCapabilityProbes()
		try {
			const db = mockDb()
			await ensureSearchIndexes(
				db,
				"test_",
				"atlas-local-preview",
				"automated",
				"scalar",
			)
			const chunks = db.collection("test_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			const vectorCall = chunks.createSearchIndex.mock.calls.find(
				(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
			)
			expect(vectorCall).toBeDefined()
			const fields = (vectorCall?.[0] as Document).definition
				.fields as Document[]
			const autoEmbedField = fields.find((f) => f.type === "autoEmbed")
			expect(autoEmbedField?.quantization).toBe("scalar")
			// Accepting fake: the probe-adopt capability stays on.
			expect(isCapabilityEnabled("autoembed-quantization", {})).toBe(true)
		} finally {
			resetCapabilityProbes()
		}
	})

	it("defaults to no quantization on autoEmbed vector fields (P3.4)", async () => {
		const db = mockDb()
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
		const chunks = db.collection("test_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		const vectorCall = chunks.createSearchIndex.mock.calls.find(
			(c: unknown[]) => (c[0] as Document).type === "vectorSearch",
		)
		const fields = (vectorCall?.[0] as Document).definition.fields as Document[]
		const autoEmbedField = fields.find((f) => f.type === "autoEmbed")
		expect(autoEmbedField).toBeDefined()
		expect(autoEmbedField && "quantization" in autoEmbedField).toBe(false)
	})

	it("records the capability off and retries without quantization when the server rejects it (P3.4)", async () => {
		resetCapabilityProbes()
		try {
			const db = mockDb()
			const chunks = db.collection("test_chunks") as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			// Rejecting fake mirrors the live 8.3.4 server message on any
			// autoEmbed definition that carries quantization.
			chunks.createSearchIndex.mockImplementation(async (spec: Document) => {
				const fields = (spec.definition?.fields ?? []) as Document[]
				const autoEmbed = fields.find((f) => f.type === "autoEmbed")
				if (autoEmbed && "quantization" in autoEmbed) {
					throw new Error("Omit quantization to use the default (float)")
				}
				return spec.name
			})

			const result = await ensureSearchIndexes(
				db,
				"test_",
				"atlas-local-preview",
				"automated",
				"scalar",
			)
			// Index creation still succeeds — the retry ships the server default.
			expect(result.vector).toBe(true)
			expect(isCapabilityEnabled("autoembed-quantization", {})).toBe(false)

			const vectorSpecs = chunks.createSearchIndex.mock.calls
				.map((c: unknown[]) => c[0] as Document)
				.filter((spec) => spec.type === "vectorSearch")
			const retried = vectorSpecs.at(-1)
			expect(retried).toBeDefined()
			const fields = retried?.definition.fields as Document[]
			const autoEmbedField = fields.find((f) => f.type === "autoEmbed")
			expect(autoEmbedField).toBeDefined()
			expect(autoEmbedField && "quantization" in autoEmbedField).toBe(false)
		} finally {
			resetCapabilityProbes()
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
		const vectorFields = (vectorCall?.[0] as Document).definition.fields
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
			{
				collectionName: "test_episodes",
				indexNames: ["episode_autocomplete"],
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

	it("community-mongot has a real numeric budget sized to the fullest planned profile", () => {
		// P3.8: budget enforcement was dead code while every profile was
		// "unbounded". The community mongot profile gets a numeric ceiling so
		// adding a search index becomes a deliberate act.
		const within = assertIndexBudget("community-mongot", 17)
		expect(typeof within.budget).toBe("number")
		expect(within.withinBudget).toBe(true)
		const beyond = assertIndexBudget(
			"community-mongot",
			(within.budget as number) + 1,
		)
		expect(beyond.withinBudget).toBe(false)
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
