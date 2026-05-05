/* eslint-disable @typescript-eslint/unbound-method */
import type { Db, Collection } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import {
	recordMutation,
	getMutationHistory,
	type MutationRecord,
} from "./mongodb-mutations.js"

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		insertOne: vi.fn().mockResolvedValue({ insertedId: "mock-id" }),
		find: vi.fn().mockReturnValue({
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			}),
		}),
		...overrides,
	} as unknown as Collection
}

function createMockDb(collections: Record<string, Collection>): Db {
	return {
		collection: vi.fn((name: string) => {
			return collections[name] ?? createMockCollection()
		}),
	} as unknown as Db
}

const PREFIX = "test_"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-mutations", () => {
	describe("recordMutation", () => {
		it("inserts a document into memory_mutations with generated mutationId and timestamp", async () => {
			const mutCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			const result = await recordMutation({
				db,
				prefix: PREFIX,
				mutation: {
					collectionName: "structured_mem",
					documentId: "doc-1",
					operation: "create",
					agentId: "agent-1",
					oldValue: null,
					newValue: { key: "pref", value: "dark mode" },
				},
			})

			expect(typeof result.mutationId).toBe("string")
			expect(result.mutationId.length).toBeGreaterThan(0)
			expect(mutCol.insertOne).toHaveBeenCalledOnce()
			const [doc] = (mutCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(doc.mutationId).toBe(result.mutationId)
			expect(doc.collectionName).toBe("structured_mem")
			expect(doc.documentId).toBe("doc-1")
			expect(doc.operation).toBe("create")
			expect(doc.agentId).toBe("agent-1")
			expect(doc.timestamp).toBeInstanceOf(Date)
		})

		it("stores oldValue as null for create operations", async () => {
			const mutCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await recordMutation({
				db,
				prefix: PREFIX,
				mutation: {
					collectionName: "entities",
					documentId: "entity-1",
					operation: "create",
					agentId: "agent-1",
					oldValue: null,
					newValue: { name: "Alice", type: "person" },
				},
			})

			const [doc] = (mutCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(doc.oldValue).toBeNull()
			expect(doc.newValue).toEqual({ name: "Alice", type: "person" })
		})

		it("stores newValue as null for delete operations", async () => {
			const mutCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await recordMutation({
				db,
				prefix: PREFIX,
				mutation: {
					collectionName: "relations",
					documentId: "rel-1",
					operation: "delete",
					agentId: "agent-1",
					oldValue: { fromEntityId: "e1", toEntityId: "e2" },
					newValue: null,
				},
			})

			const [doc] = (mutCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(doc.newValue).toBeNull()
			expect(doc.oldValue).toEqual({ fromEntityId: "e1", toEntityId: "e2" })
			expect(doc.operation).toBe("delete")
		})

		it("supports invalidate operations for lifecycle deletes", async () => {
			const mutCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await recordMutation({
				db,
				prefix: PREFIX,
				mutation: {
					collectionName: "structured_mem",
					documentId: "structured:fact:launch",
					operation: "invalidate",
					agentId: "agent-1",
					oldValue: { state: "active" },
					newValue: { state: "invalidated" },
					changedFields: ["state", "validTo"],
				},
			})

			const [doc] = (mutCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(doc.operation).toBe("invalidate")
			expect(doc.changedFields).toEqual(["state", "validTo"])
		})

		it("stores optional mutation meta for feedback and outcome provenance", async () => {
			const mutCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await recordMutation({
				db,
				prefix: PREFIX,
				mutation: {
					collectionName: "structured_mem",
					documentId: "structured:fact:launch",
					operation: "update",
					agentId: "agent-1",
					oldValue: { value: "Launch Monday" },
					newValue: { value: "Launch Tuesday" },
					meta: {
						source: "memory-feedback",
						signal: "correct",
						note: "User corrected launch day",
					},
				},
			})

			const [doc] = (mutCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(doc.meta).toEqual({
				source: "memory-feedback",
				signal: "correct",
				note: "User corrected launch day",
			})
		})
	})

	describe("getMutationHistory", () => {
		it("returns records filtered by agentId", async () => {
			const docs: MutationRecord[] = [
				{
					mutationId: "mut-1",
					collectionName: "structured_mem",
					documentId: "doc-1",
					operation: "create",
					agentId: "agent-1",
					oldValue: null,
					newValue: { key: "test" },
					timestamp: new Date(),
				},
			]

			const findResult = {
				// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue(docs),
					}),
				}),
			}
			const mutCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			const results = await getMutationHistory({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
			})

			expect(results).toHaveLength(1)
			expect(results[0].agentId).toBe("agent-1")
			const [filter] = (mutCol.find as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(filter.agentId).toBe("agent-1")
		})

		it("filters by collectionName when provided", async () => {
			const findResult = {
				// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const mutCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await getMutationHistory({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				collectionName: "entities",
			})

			const [filter] = (mutCol.find as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(filter.agentId).toBe("agent-1")
			expect(filter.collectionName).toBe("entities")
		})

		it("filters by documentId when provided", async () => {
			const findResult = {
				// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const mutCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await getMutationHistory({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				documentId: "doc-42",
			})

			const [filter] = (mutCol.find as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(filter.agentId).toBe("agent-1")
			expect(filter.documentId).toBe("doc-42")
		})

		it("respects limit parameter", async () => {
			const findResult = {
				// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const mutCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await getMutationHistory({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				limit: 5,
			})

			// Verify limit was called with 5
			const sortReturn = vi.mocked(findResult.sort).mock.results[0].value
			expect(sortReturn.limit).toHaveBeenCalledWith(5)
		})

		it("respects since date filter", async () => {
			const sinceDate = new Date("2026-01-01T00:00:00Z")
			const findResult = {
				// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const mutCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}memory_mutations`]: mutCol })

			await getMutationHistory({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				since: sinceDate,
			})

			const [filter] = (mutCol.find as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(filter.agentId).toBe("agent-1")
			expect(filter.timestamp).toEqual({ $gte: sinceDate })
		})
	})
})
