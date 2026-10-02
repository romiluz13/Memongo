import type { Collection, Db, Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	assertQueryModelDimensionsMatch,
	EmbeddingModelMigrationError,
	EmbeddingModelMismatchError,
	findStrandingModelChanges,
	isEmbeddingModelMigrationError,
	isEmbeddingModelMismatchError,
	refuseToStrandExistingDocuments,
} from "./embedding-validation.js"
import {
	getExpectedSearchIndexTargets,
	INDEX_AUTOEMBED_MODEL,
} from "./mongodb-schema-search-definitions.js"
import {
	ensureNamedSearchIndex,
	type SearchIndexDescription,
} from "./mongodb-schema-search-readiness.js"

// Partial mock: keep the REAL ensureNamedSearchIndex so the recovering-ensure
// oracle exercises it against driver-surface fakes; only the module-level
// list helper is controlled (per startup-safety review F2).
vi.mock("./mongodb-schema-search-readiness.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("./mongodb-schema-search-readiness.js")
		>()
	return {
		...actual,
		listSearchIndexes: vi.fn(),
	}
})

vi.mock("./mongodb-schema-search-definitions.js", () => ({
	INDEX_AUTOEMBED_MODEL: "voyage-4-large",
	getExpectedSearchIndexTargets: vi.fn(() => [
		{
			collectionName: "test_chunks",
			indexNames: ["test_chunks_vector"],
		},
	]),
}))

vi.mock("@memongo/lib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@memongo/lib")>()
	return {
		...actual,
		createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
	}
})

const { listSearchIndexes } = await import(
	"./mongodb-schema-search-readiness.js"
)

function makeCollection(
	collectionName: string,
	countDocumentsResult: number = 0,
): Collection {
	return {
		collectionName,
		countDocuments: vi.fn().mockResolvedValue(countDocumentsResult),
	} as unknown as Collection
}

function makeDb(collections: Record<string, Collection>): Db {
	return {
		collection: (name: string) => collections[name] ?? makeCollection(name),
	} as unknown as Db
}

function makeIndex(name: string, model?: string): SearchIndexDescription {
	return {
		name,
		latestDefinition: model
			? { fields: [{ type: "autoEmbed", model }] }
			: { fields: [{ type: "filter" }] },
	}
}

describe("Guardrail 1: assertQueryModelDimensionsMatch", () => {
	it("passes when query model matches index model", () => {
		expect(() =>
			assertQueryModelDimensionsMatch("voyage-4-large"),
		).not.toThrow()
	})

	it("passes when query model has same dimensions as index model", () => {
		expect(() => assertQueryModelDimensionsMatch("voyage-4-lite")).not.toThrow()
	})

	it("passes silently for unknown models (tolerant)", () => {
		expect(() => assertQueryModelDimensionsMatch("unknown-model")).not.toThrow()
	})

	it("throws EmbeddingModelMismatchError when dimensions differ", () => {
		expect(() => assertQueryModelDimensionsMatch("voyage-3-lite")).toThrow(
			EmbeddingModelMismatchError,
		)
	})

	it("error contains actionable remediation", () => {
		try {
			assertQueryModelDimensionsMatch("voyage-3-lite")
			expect.fail("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(EmbeddingModelMismatchError)
			const e = err as EmbeddingModelMismatchError
			expect(e.queryModel).toBe("voyage-3-lite")
			expect(e.indexModel).toBe(INDEX_AUTOEMBED_MODEL)
			expect(e.queryDimension).toBe(512)
			expect(e.indexDimension).toBe(1024)
			expect(e.message).toContain("MEMONGO_QUERY_EMBEDDING_MODEL")
			expect(e.message).toContain("silently return nothing")
		}
	})
})

describe("isEmbeddingModelMismatchError", () => {
	it("returns true for the error", () => {
		try {
			assertQueryModelDimensionsMatch("voyage-3-lite")
			expect.fail("should have thrown")
		} catch (err) {
			expect(isEmbeddingModelMismatchError(err)).toBe(true)
		}
	})

	it("returns false for generic Error", () => {
		expect(isEmbeddingModelMismatchError(new Error("nope"))).toBe(false)
	})

	it("returns false for non-Error values", () => {
		expect(isEmbeddingModelMismatchError(null)).toBe(false)
		expect(isEmbeddingModelMismatchError("nope")).toBe(false)
	})
})

describe("Guardrail 2: findStrandingModelChanges", () => {
	const mockedListSearchIndexes = vi.mocked(listSearchIndexes)

	beforeEach(() => {
		mockedListSearchIndexes.mockReset()
	})

	it("returns empty findings when no indexes exist", async () => {
		mockedListSearchIndexes.mockResolvedValue([])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 100) })
		const findings = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		expect(findings).toEqual([])
	})

	it("returns empty findings when model matches", async () => {
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-4-large"),
		])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 100) })
		const findings = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		expect(findings).toEqual([])
	})

	it("returns finding when model differs and documents exist", async () => {
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-3-lite"),
		])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 42) })
		const findings = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		expect(findings).toHaveLength(1)
		expect(findings[0].collectionName).toBe("test_chunks")
		expect(findings[0].indexName).toBe("test_chunks_vector")
		expect(findings[0].existingModel).toBe("voyage-3-lite")
		expect(findings[0].wantedModel).toBe("voyage-4-large")
		expect(findings[0].documentCount).toBe(42)
	})

	it("returns empty findings when collection is empty", async () => {
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-3-lite"),
		])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 0) })
		const findings = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		expect(findings).toEqual([])
	})

	it("returns empty findings for non-autoEmbed index", async () => {
		mockedListSearchIndexes.mockResolvedValue([makeIndex("test_chunks_vector")])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 100) })
		const findings = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		expect(findings).toEqual([])
	})

	it("refuses with redacted detail on both the warn and throw paths when listSearchIndexes throws (C-002)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		mockedListSearchIndexes.mockRejectedValue(
			new Error(
				[
					"not Atlas: ",
					"mongodb://svc:du",
					"mmy-cred-000000@",
					"host.example.net:27017",
				].join(""),
			),
		)
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 100) })
		const outcome = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		).then(
			() => "resolved" as const,
			(err: unknown) => err,
		)
		expect(warnSpy).toHaveBeenCalled()
		const out = warnSpy.mock.calls.map((args) => args.join(" ")).join("\n")
		expect(out).toContain("test_chunks")
		expect(out).toContain("[guardrail] Could not inspect search indexes")
		expect(out).not.toContain("dummy-cred-000000")
		warnSpy.mockRestore()
		expect(
			outcome,
			"incomplete inspection must refuse instead of returning []",
		).toBeInstanceOf(Error)
		if (!(outcome instanceof Error)) return
		expect(isEmbeddingModelMigrationError(outcome)).toBe(false)
		expect(outcome.message).toMatch(/incomplete/i)
		expect(outcome.message).toContain("test_chunks")
		// C-002 redaction must hold on the throw path, not just the log path.
		expect(outcome.message).not.toContain("dummy-cred-000000")
	})

	it("returns finding with documentCount=-1 when countDocuments throws", async () => {
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-3-lite"),
		])
		const db = makeDb({
			test_chunks: {
				collectionName: "test_chunks",
				countDocuments: vi.fn().mockRejectedValue(new Error("connection lost")),
			} as unknown as Collection,
		})
		const findings = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		expect(findings).toHaveLength(1)
		expect(findings[0].documentCount).toBe(-1)
	})
})

describe("Guardrail 2: refuseToStrandExistingDocuments", () => {
	const mockedListSearchIndexes = vi.mocked(listSearchIndexes)

	beforeEach(() => {
		mockedListSearchIndexes.mockReset()
		vi.unstubAllEnvs()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("passes silently with MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE=true", async () => {
		vi.stubEnv("MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE", "true")
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-3-lite"),
		])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 100) })
		await expect(
			refuseToStrandExistingDocuments(
				db,
				"test_",
				"atlas-managed",
				"voyage-4-large",
			),
		).resolves.toBeUndefined()
	})

	it("throws EmbeddingModelMigrationError when findings exist", async () => {
		delete process.env.MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-3-lite"),
		])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 50) })
		await expect(
			refuseToStrandExistingDocuments(
				db,
				"test_",
				"atlas-managed",
				"voyage-4-large",
			),
		).rejects.toThrow(EmbeddingModelMigrationError)
	})

	it("error message contains document count and escape hatch", async () => {
		delete process.env.MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-3-lite"),
		])
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 77) })
		try {
			await refuseToStrandExistingDocuments(
				db,
				"test_",
				"atlas-managed",
				"voyage-4-large",
			)
			expect.fail("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(EmbeddingModelMigrationError)
			const e = err as EmbeddingModelMigrationError
			expect(e.message).toContain("77")
			expect(e.message).toContain("voyage-3-lite")
			expect(e.message).toContain("voyage-4-large")
			expect(e.message).toContain("MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE=true")
		}
	})
})

describe("isEmbeddingModelMigrationError", () => {
	it("returns true for the error", () => {
		const err = new EmbeddingModelMigrationError([
			{
				collectionName: "c",
				indexName: "i",
				existingModel: "old",
				wantedModel: "new",
				documentCount: 1,
			},
		])
		expect(isEmbeddingModelMigrationError(err)).toBe(true)
	})

	it("returns false for generic Error", () => {
		expect(isEmbeddingModelMigrationError(new Error("nope"))).toBe(false)
	})

	it("returns false for non-Error values", () => {
		expect(isEmbeddingModelMigrationError(null)).toBe(false)
	})
})

describe("Guardrail 2 startup composition: refusal vs recovering ensure (Stage 1 G2)", () => {
	const mockedListSearchIndexes = vi.mocked(listSearchIndexes)
	const mockedTargets = vi.mocked(getExpectedSearchIndexTargets)

	const INDEX_NAME = "test_chunks_vector"
	const WANTED_DEFINITION: Document = {
		fields: [{ type: "autoEmbed", model: "voyage-4-large" }],
	}
	const SINGLE_TARGET = [
		{ collectionName: "test_chunks", indexNames: [INDEX_NAME] },
	]
	const TWO_TARGETS = [
		{ collectionName: "test_chunks", indexNames: [INDEX_NAME] },
		{
			collectionName: "test_kb_chunks",
			indexNames: ["test_kb_chunks_vector"],
		},
	]

	function autoEmbedIndexRow(name: string, model: string) {
		return {
			name,
			type: "vectorSearch",
			queryable: true,
			latestDefinition: { fields: [{ type: "autoEmbed", model }] },
		}
	}

	function makeDriverCollection(
		collectionName: string,
		opts: {
			indexes?: Array<ReturnType<typeof autoEmbedIndexRow>>
			documentCount?: number
		} = {},
	) {
		const driverList = vi.fn().mockImplementation(() => ({
			toArray: vi.fn().mockResolvedValue(opts.indexes ?? []),
		}))
		const updateSearchIndex = vi.fn().mockResolvedValue(undefined)
		const createSearchIndex = vi.fn().mockResolvedValue(undefined)
		const collection = {
			collectionName,
			countDocuments: vi.fn().mockResolvedValue(opts.documentCount ?? 50),
			listSearchIndexes: driverList,
			updateSearchIndex,
			createSearchIndex,
		} as unknown as Collection
		return { collection, driverList, updateSearchIndex, createSearchIndex }
	}

	async function runRealEnsure(collection: Collection) {
		await ensureNamedSearchIndex({
			collection,
			name: INDEX_NAME,
			type: "vectorSearch",
			definition: WANTED_DEFINITION,
			label: "chunks vector",
		})
	}

	// Granted chain (R1): a startup whose inspection failed must refuse so
	// the manager never reaches the recovering ensure. The composition
	// awaits the real refusal, then — only when startup did not refuse —
	// the real recovering ensure, mirroring manager ordering.
	async function startupRefusalThenRecoveringEnsure(
		db: Db,
		recoveryCollection: Collection,
	) {
		const refusal = await refuseToStrandExistingDocuments(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		).then(
			() => "resolved" as const,
			(err: unknown) => err,
		)
		if (refusal === "resolved") {
			await runRealEnsure(recoveryCollection)
		}
		return refusal
	}

	beforeEach(() => {
		delete process.env.MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE
		vi.unstubAllEnvs()
		mockedListSearchIndexes.mockReset()
		mockedTargets.mockReset()
		mockedTargets.mockImplementation(() => SINGLE_TARGET)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		// Restore the file-level single-target default for other suites.
		mockedTargets.mockImplementation(() => SINGLE_TARGET)
	})

	it("rejects startup on real drift and the recovering ensure performs no writes", async () => {
		mockedListSearchIndexes.mockResolvedValue([
			autoEmbedIndexRow(INDEX_NAME, "voyage-3-lite"),
		])
		const fake = makeDriverCollection("test_chunks", {
			indexes: [autoEmbedIndexRow(INDEX_NAME, "voyage-3-lite")],
			documentCount: 50,
		})
		const db = makeDb({ test_chunks: fake.collection })
		await expect(
			refuseToStrandExistingDocuments(
				db,
				"test_",
				"atlas-managed",
				"voyage-4-large",
			),
		).rejects.toThrow(EmbeddingModelMigrationError)
		// Manager ordering (mongodb-manager.ts:665-691) never reaches
		// ensureNamedSearchIndex after a refused startup; pin that the driver
		// surface saw no writes on the same fake.
		expect(fake.updateSearchIndex).not.toHaveBeenCalled()
		expect(fake.createSearchIndex).not.toHaveBeenCalled()
	})

	it("override routes the only sanctioned re-embed through real ensureNamedSearchIndex", async () => {
		vi.stubEnv("MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE", "true")
		mockedListSearchIndexes.mockResolvedValue([
			autoEmbedIndexRow(INDEX_NAME, "voyage-3-lite"),
		])
		const fake = makeDriverCollection("test_chunks", {
			indexes: [autoEmbedIndexRow(INDEX_NAME, "voyage-3-lite")],
			documentCount: 50,
		})
		const db = makeDb({ test_chunks: fake.collection })
		await refuseToStrandExistingDocuments(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		await runRealEnsure(fake.collection)
		expect(fake.driverList).toHaveBeenCalledWith(INDEX_NAME)
		expect(fake.updateSearchIndex).toHaveBeenCalledTimes(1)
		expect(fake.updateSearchIndex).toHaveBeenCalledWith(
			INDEX_NAME,
			WANTED_DEFINITION,
		)
		expect(fake.createSearchIndex).not.toHaveBeenCalled()
	})

	it("matching model passes startup and ensure performs no writes", async () => {
		mockedListSearchIndexes.mockResolvedValue([
			autoEmbedIndexRow(INDEX_NAME, "voyage-4-large"),
		])
		const fake = makeDriverCollection("test_chunks", {
			indexes: [autoEmbedIndexRow(INDEX_NAME, "voyage-4-large")],
			documentCount: 50,
		})
		const db = makeDb({ test_chunks: fake.collection })
		await refuseToStrandExistingDocuments(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		await runRealEnsure(fake.collection)
		expect(fake.updateSearchIndex).not.toHaveBeenCalled()
		expect(fake.createSearchIndex).not.toHaveBeenCalled()
	})

	it("composition fails closed when the very first target's inspection throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		mockedListSearchIndexes.mockRejectedValue(
			new Error("list failed on test_chunks"),
		)
		const fake = makeDriverCollection("test_chunks", {
			indexes: [autoEmbedIndexRow(INDEX_NAME, "voyage-3-lite")],
			documentCount: 50,
		})
		const db = makeDb({ test_chunks: fake.collection })
		const outcome = await startupRefusalThenRecoveringEnsure(
			db,
			fake.collection,
		)
		warnSpy.mockRestore()
		// No-write anchors first: a refused startup must never reach the
		// recovering ensure, so no driver write may occur.
		expect(
			fake.updateSearchIndex,
			"failed inspection must refuse startup before any driver write",
		).not.toHaveBeenCalled()
		expect(fake.createSearchIndex).not.toHaveBeenCalled()
		expect(
			outcome,
			"guardrail must fail closed when inspection is incomplete",
		).toBeInstanceOf(Error)
		if (!(outcome instanceof Error)) return
		// Distinct from drift-confirmed: operators must tell an incomplete
		// inspection from a real EmbeddingModelMigrationError refusal.
		expect(isEmbeddingModelMigrationError(outcome)).toBe(false)
		expect(outcome.message).toMatch(/incomplete/i)
		expect(outcome.message).toContain(
			"MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE=true",
		)
	})

	it("fails closed when a later target's inspection throws after an earlier drift finding", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		mockedTargets.mockImplementation(() => TWO_TARGETS)
		mockedListSearchIndexes.mockImplementation(async (collection) => {
			if (collection.collectionName === "test_kb_chunks") {
				throw new Error(
					[
						"list failed on kb_chunks: ",
						"mongodb://svc:dummy-cred-000000@host.example.net:27017",
					].join(""),
				)
			}
			return [autoEmbedIndexRow(INDEX_NAME, "voyage-3-lite")]
		})
		const chunks = makeDriverCollection("test_chunks", {
			indexes: [autoEmbedIndexRow(INDEX_NAME, "voyage-3-lite")],
			documentCount: 50,
		})
		const kbChunks = makeDriverCollection("test_kb_chunks", {
			indexes: [],
			documentCount: 0,
		})
		const db = makeDb({
			test_chunks: chunks.collection,
			test_kb_chunks: kbChunks.collection,
		})
		const outcome = await startupRefusalThenRecoveringEnsure(
			db,
			chunks.collection,
		)
		warnSpy.mockRestore()
		// Prove the earlier target's drift was counted before the kb_chunks
		// inspection threw: chunks documents were counted and the kb target
		// list was actually reached.
		expect(chunks.collection.countDocuments).toHaveBeenCalledWith({})
		expect(
			mockedListSearchIndexes.mock.calls.some(
				([collection]) => collection.collectionName === "test_kb_chunks",
			),
		).toBe(true)
		// No-write anchors next: a refused startup must never reach the
		// recovering ensure, so no driver write may occur.
		expect(
			chunks.updateSearchIndex,
			"guardrail must fail closed instead of discarding the accumulated chunks finding and letting the recovering ensure re-embed",
		).not.toHaveBeenCalled()
		expect(chunks.createSearchIndex).not.toHaveBeenCalled()
		expect(kbChunks.updateSearchIndex).not.toHaveBeenCalled()
		expect(kbChunks.createSearchIndex).not.toHaveBeenCalled()
		expect(
			outcome,
			"guardrail must fail closed instead of discarding the accumulated chunks finding",
		).toBeInstanceOf(Error)
		if (!(outcome instanceof Error)) return
		expect(isEmbeddingModelMigrationError(outcome)).toBe(false)
		expect(outcome.message).toMatch(/incomplete/i)
		// The incomplete error names the failing target; the earlier
		// finding is protected by refusing ALL reconciliation, not by
		// printing it.
		expect(outcome.message).toContain("test_kb_chunks")
		expect(outcome.message).toContain(
			"MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE=true",
		)
		// C-002 redaction must hold on the throw path, not just the log path.
		expect(outcome.message).not.toContain("dummy-cred-000000")
	})
})
