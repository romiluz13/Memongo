import type { Collection, Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { ensureSearchIndexes } from "./mongodb-schema.js"
import { assertSearchBarrierTargets } from "./mongodb-search-barrier.js"

type CreatedIndex = { name: string; type: string; definition: Document }

function recordingDb(existing: Record<string, CreatedIndex[]> = {}) {
	const created = new Map<string, CreatedIndex[]>()
	const updated: Array<{ name: string; definition: Document }> = []
	const collections = new Map<string, Collection>()
	const db = {
		admin: () => ({ command: async () => ({ versionArray: [8, 3, 0, 0] }) }),
		collection: vi.fn((name: string) => {
			let collection = collections.get(name)
			if (!collection) {
				collection = {
					collectionName: name,
					createSearchIndex: vi.fn(async (index: CreatedIndex) => {
						created.set(name, [...(created.get(name) ?? []), index])
						return index.name
					}),
					updateSearchIndex: vi.fn(
						async (index: string, definition: Document) => {
							updated.push({ name: index, definition })
						},
					),
					aggregate: vi.fn(() => ({
						toArray: async () =>
							(existing[name] ?? []).map((index) => ({
								...index,
								latestDefinition: index.definition,
							})),
					})),
				} as unknown as Collection
				collections.set(name, collection)
			}
			return collection
		}),
	} as unknown as Db
	return { db, created, updated }
}

const BARRIER_INDEXES = [
	["test_events", "test_events_text"],
	["test_events", "test_events_vector"],
	["test_chunks", "test_chunks_text"],
	["test_chunks", "test_chunks_vector"],
	["test_structured_mem", "test_structured_mem_text"],
	["test_structured_mem", "test_structured_mem_vector"],
	["test_procedures", "test_procedures_text"],
	["test_procedures", "test_procedures_vector"],
] as const

describe("search barrier index definitions", () => {
	it("maps searchWriteToken as token in text indexes and as filter in vector indexes", async () => {
		const { db, created } = recordingDb()
		await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")
		for (const [collectionName, indexName] of BARRIER_INDEXES) {
			const index = created
				.get(collectionName)
				?.find((candidate) => candidate.name === indexName)
			expect(index, indexName).toBeDefined()
			if (index?.type === "search") {
				expect(
					index.definition.mappings.fields.searchWriteToken,
					indexName,
				).toEqual({ type: "token" })
			} else {
				expect(index?.definition.fields, indexName).toContainEqual({
					type: "filter",
					path: "searchWriteToken",
				})
			}
		}
	})

	it("produces definitions the barrier's static check accepts for every write family", async () => {
		const { db, created } = recordingDb()
		await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")
		const listIndexes = async (collectionName: string) =>
			(created.get(collectionName) ?? []).map((index) => ({
				name: index.name,
				type: index.type,
				status: "READY",
				queryable: true,
				latestDefinition: index.definition,
			}))
		for (const family of ["event", "structured", "procedure"]) {
			await expect(
				assertSearchBarrierTargets({
					db,
					prefix: "test_",
					family,
					listIndexes,
				}),
			).resolves.toBeUndefined()
		}
	})

	it("rebuilds an existing index whose definition predates the token", async () => {
		const legacyEventsText: CreatedIndex = {
			name: "test_events_text",
			type: "search",
			definition: {
				mappings: { dynamic: false, fields: { body: { type: "string" } } },
			},
		}
		const { db, updated } = recordingDb({ test_events: [legacyEventsText] })
		await ensureSearchIndexes(db, "test_", "atlas-managed", "automated")
		const update = updated.find((entry) => entry.name === "test_events_text")
		expect(update?.definition.mappings.fields.searchWriteToken).toEqual({
			type: "token",
		})
	})
})
