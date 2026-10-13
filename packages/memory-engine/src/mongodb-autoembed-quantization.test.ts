import type { Db, Document } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ensureSearchIndexes } from "./mongodb-schema-search-indexes.js"
import { autoEmbedVectorField } from "./mongodb-schema-search-definitions.js"

afterEach(() => vi.unstubAllEnvs())

function storage(rejectName?: string, existing = false) {
	const rejection = new Error("server rejected autoEmbed quantization")
	const attempts: Array<{ name: string; definition: Document }> = []
	let updates = 0
	const db = {
		admin: () => ({ command: async () => ({ versionArray: [9, 0, 4] }) }),
		collection: () => ({
			listSearchIndexes: (name: string) => ({
				toArray: async () =>
					existing && name === rejectName
						? [
								{
									name,
									type: "vectorSearch",
									latestDefinition: { fields: [autoEmbedVectorField("text")] },
								},
							]
						: [],
			}),
			updateSearchIndex: async () => {
				updates++
				throw rejection
			},
			createSearchIndex: async (index: {
				name: string
				definition: Document
			}) => {
				attempts.push(index)
				if (existing && index.name === rejectName)
					throw new Error("already exists")
				if (
					index.name === rejectName &&
					index.definition.fields.some((field: Document) => field.quantization)
				)
					throw rejection
				return index.name
			},
		}),
	} as unknown as Db
	return { db, rejection, attempts, updates: () => updates }
}

describe("explicit autoEmbed quantization at the real index ensure seam", () => {
	it.each([
		"scalar",
		"binary",
	] as const)("propagates %s rejection without an omitted-option retry", async (mode) => {
		vi.stubEnv("MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE", "raw-session")
		const f = storage("test_session_chunks_vector")
		await expect(
			ensureSearchIndexes(f.db, "test_", "atlas-managed", "automated", mode),
		).rejects.toBe(f.rejection)
		expect(f.attempts).toHaveLength(1)
		expect(f.attempts[0].definition.fields[0].quantization).toBe(mode)
	})
	it("does not turn a rejected explicit update into already-exists success", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE", "raw-session")
		const f = storage("test_session_chunks_vector", true)
		await expect(
			ensureSearchIndexes(
				f.db,
				"test_",
				"atlas-managed",
				"automated",
				"scalar",
			),
		).rejects.toBe(f.rejection)
		expect(f.updates()).toBe(1)
		expect(f.attempts).toEqual([])
	})
	it.each([
		"chunks",
		"kb_chunks",
		"structured_mem",
		"procedures",
		"events",
		"session_chunks",
		"memory_evidence",
	])("propagates rejection from the %s lane", async (lane) => {
		vi.stubEnv("MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE", "")
		vi.stubEnv("MEMONGO_SKIP_OPTIONAL_SEARCH_INDEXES", "0")
		vi.stubEnv("MEMONGO_EVIDENCE_MIRROR_MODE", "enabled")
		const f = storage(`test_${lane}_vector`)
		await expect(
			ensureSearchIndexes(
				f.db,
				"test_",
				"atlas-managed",
				"automated",
				"scalar",
			),
		).rejects.toBe(f.rejection)
		const rejected = f.attempts.filter(
			(index) => index.name === `test_${lane}_vector`,
		)
		expect(rejected).toHaveLength(1)
		expect(rejected[0].definition.fields[0].quantization).toBe("scalar")
	})
	it.each([
		undefined,
		"none",
		"scalar",
		"binary",
	] as const)("preserves accepted %s definition", async (mode) => {
		vi.stubEnv("MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE", "raw-session")
		const f = storage()
		await expect(
			ensureSearchIndexes(f.db, "test_", "atlas-managed", "automated", mode),
		).resolves.toEqual({ text: false, vector: true })
		const field = f.attempts[0].definition.fields[0]
		if (!mode || mode === "none")
			expect(field).not.toHaveProperty("quantization")
		else expect(field.quantization).toBe(mode)
	})
})
