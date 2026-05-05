/* eslint-disable @typescript-eslint/unbound-method */
import type { Collection, Db } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock recordMutation from mongodb-mutations.js
vi.mock("./mongodb-mutations.js", () => ({
	recordMutation: vi.fn().mockResolvedValue({ mutationId: "mock-mut-id" }),
}))

// Mock telemetry (imported by mongodb-graph.ts)
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import {
	upsertEntity,
	upsertRelation,
	type Entity,
	type Relation,
} from "./mongodb-graph.js"
import { recordMutation } from "./mongodb-mutations.js"
import {
	writeStructuredMemory,
	type StructuredMemoryEntry,
} from "./mongodb-structured-memory.js"

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn(async () => null),
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "new-id",
			modifiedCount: 0,
		})),
		insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: "rev-1" })),
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		find: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
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

function makeEntity(overrides: Partial<Entity> = {}): Entity {
	return {
		entityId: "ent-1",
		name: "Alice",
		type: "person",
		agentId: "agent-1",
		scope: "agent",
		updatedAt: new Date("2026-01-01"),
		...overrides,
	}
}

function makeRelation(overrides: Partial<Relation> = {}): Relation {
	return {
		fromEntityId: "ent-1",
		toEntityId: "ent-2",
		type: "works_on",
		agentId: "agent-1",
		scope: "agent",
		updatedAt: new Date("2026-01-01"),
		...overrides,
	}
}

const PREFIX = "test_"

// ---------------------------------------------------------------------------
// Tests: P4 — Mutation Audit Integration
// ---------------------------------------------------------------------------

describe("P4: audit integration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("writeStructuredMemory records mutation", () => {
		it("fires recordMutation after creating a new structured memory entry", async () => {
			const col = createMockCollection()
			const revisionsCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}structured_mem`]: col,
				[`${PREFIX}structured_mem_revisions`]: revisionsCol,
			})

			const entry: StructuredMemoryEntry = {
				type: "decision",
				key: "framework-choice",
				value: "Using React",
				agentId: "main",
			}

			await writeStructuredMemory({
				db,
				prefix: PREFIX,
				entry,
				embeddingMode: "automated",
			})

			// recordMutation should have been called via fire-and-forget
			expect(recordMutation).toHaveBeenCalledOnce()
			const call = vi.mocked(recordMutation).mock.calls[0][0]
			expect(call.mutation.collectionName).toBe("structured_mem")
			expect(call.mutation.operation).toBe("create")
			expect(call.mutation.agentId).toBe("main")
			expect(call.mutation.oldValue).toBeNull()
			expect(call.mutation.newValue).toBeDefined()
			expect(call.mutation.actorRole).toBe("system")
		})

		it("records 'update' operation with changedFields when value changes", async () => {
			const col = createMockCollection({
				findOne: vi.fn().mockResolvedValue({
					type: "preference",
					key: "editor",
					value: "VSCode",
					agentId: "main",
					scope: "agent",
					scopeRef: "agent:main",
					revision: 1,
					createdAt: new Date("2026-01-01"),
					updatedAt: new Date("2026-01-01"),
				}),
				updateOne: vi.fn(async () => ({
					upsertedCount: 0,
					matchedCount: 1,
					modifiedCount: 1,
				})),
			})
			const revisionsCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}structured_mem`]: col,
				[`${PREFIX}structured_mem_revisions`]: revisionsCol,
			})

			const entry: StructuredMemoryEntry = {
				type: "preference",
				key: "editor",
				value: "Neovim",
				agentId: "main",
			}

			await writeStructuredMemory({
				db,
				prefix: PREFIX,
				entry,
				embeddingMode: "automated",
			})

			expect(recordMutation).toHaveBeenCalledOnce()
			const call = vi.mocked(recordMutation).mock.calls[0][0]
			expect(call.mutation.operation).toBe("update")
			expect(call.mutation.changedFields).toContain("value")
		})
	})

	describe("upsertEntity records mutation", () => {
		it("fires recordMutation after creating a new entity", async () => {
			const entitiesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })
			const entity = makeEntity()

			await upsertEntity({ db, prefix: PREFIX, entity })

			expect(recordMutation).toHaveBeenCalledOnce()
			const call = vi.mocked(recordMutation).mock.calls[0][0]
			expect(call.mutation.collectionName).toBe("entities")
			expect(call.mutation.operation).toBe("create")
			expect(call.mutation.documentId).toBe("ent-1")
			expect(call.mutation.agentId).toBe("agent-1")
			expect(call.mutation.oldValue).toBeNull()
			expect(call.mutation.actorRole).toBe("system")
		})

		it("fires recordMutation with 'update' when entity already exists", async () => {
			const entitiesCol = createMockCollection({
				updateOne: vi.fn().mockResolvedValue({
					upsertedCount: 0,
					matchedCount: 1,
					modifiedCount: 1,
				}),
			})
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })
			const entity = makeEntity({ name: "Alice Updated" })

			await upsertEntity({ db, prefix: PREFIX, entity })

			expect(recordMutation).toHaveBeenCalledOnce()
			const call = vi.mocked(recordMutation).mock.calls[0][0]
			expect(call.mutation.operation).toBe("update")
		})
	})

	describe("upsertRelation records mutation", () => {
		it("fires recordMutation after creating a new relation", async () => {
			const relationsCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })
			const relation = makeRelation()

			await upsertRelation({ db, prefix: PREFIX, relation })

			expect(recordMutation).toHaveBeenCalledOnce()
			const call = vi.mocked(recordMutation).mock.calls[0][0]
			expect(call.mutation.collectionName).toBe("relations")
			expect(call.mutation.operation).toBe("create")
			expect(call.mutation.documentId).toContain("ent-1")
			expect(call.mutation.agentId).toBe("agent-1")
			expect(call.mutation.oldValue).toBeNull()
			expect(call.mutation.actorRole).toBe("system")
		})
	})

	describe("audit failure does not break primary write", () => {
		it("writeStructuredMemory succeeds even when recordMutation throws", async () => {
			vi.mocked(recordMutation).mockRejectedValueOnce(
				new Error("audit db down"),
			)

			const col = createMockCollection()
			const revisionsCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}structured_mem`]: col,
				[`${PREFIX}structured_mem_revisions`]: revisionsCol,
			})

			const entry: StructuredMemoryEntry = {
				type: "fact",
				key: "test",
				value: "Still works",
				agentId: "main",
			}

			const result = await writeStructuredMemory({
				db,
				prefix: PREFIX,
				entry,
				embeddingMode: "automated",
			})

			// Primary write still succeeds
			expect(result.upserted).toBe(true)
			expect(result.id).toBeDefined()
		})

		it("upsertEntity succeeds even when recordMutation throws", async () => {
			vi.mocked(recordMutation).mockRejectedValueOnce(
				new Error("audit db down"),
			)

			const entitiesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })
			const entity = makeEntity()

			const result = await upsertEntity({ db, prefix: PREFIX, entity })

			// Primary write still succeeds
			expect(result.upserted).toBe(true)
		})

		it("upsertRelation succeeds even when recordMutation throws", async () => {
			vi.mocked(recordMutation).mockRejectedValueOnce(
				new Error("audit db down"),
			)

			const relationsCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })
			const relation = makeRelation()

			const result = await upsertRelation({ db, prefix: PREFIX, relation })

			// Primary write still succeeds
			expect(result.upserted).toBe(true)
		})
	})
})
