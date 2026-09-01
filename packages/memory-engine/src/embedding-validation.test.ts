import type { Db, Collection } from "mongodb"
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
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import type { SearchIndexDescription } from "./mongodb-schema-search-readiness.js"

vi.mock("./mongodb-schema-search-readiness.js", () => ({
	listSearchIndexes: vi.fn(),
}))

vi.mock("./mongodb-schema-search-definitions.js", () => ({
	INDEX_AUTOEMBED_MODEL: "voyage-4-large",
	getExpectedSearchIndexTargets: vi.fn(() => [
		{
			collectionName: "test_chunks",
			indexNames: ["test_chunks_vector"],
		},
	]),
}))

vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}))

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

	it("returns empty findings and warns when listSearchIndexes throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		mockedListSearchIndexes.mockRejectedValue(new Error("not Atlas"))
		const db = makeDb({ test_chunks: makeCollection("test_chunks", 100) })
		const findings = await findStrandingModelChanges(
			db,
			"test_",
			"atlas-managed",
			"voyage-4-large",
		)
		expect(findings).toEqual([])
		expect(warnSpy).toHaveBeenCalled()
		warnSpy.mockRestore()
	})

	it("returns finding with documentCount=-1 when countDocuments throws", async () => {
		mockedListSearchIndexes.mockResolvedValue([
			makeIndex("test_chunks_vector", "voyage-3-lite"),
		])
		const db = makeDb({
			test_chunks: {
				collectionName: "test_chunks",
				countDocuments: vi
					.fn()
					.mockRejectedValue(new Error("connection lost")),
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
