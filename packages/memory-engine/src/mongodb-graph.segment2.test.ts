/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import {
	expandGraph,
	deleteEntityConservative,
	extractAndUpsertEntities,
	extractAndUpsertTypedRelations,
	searchEntitiesAutocomplete,
	findRelationByLocatorId,
	type Entity,
	type Relation,
} from "./mongodb-graph.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn().mockResolvedValue(null),
		updateOne: vi.fn().mockResolvedValue({
			upsertedCount: 1,
			matchedCount: 0,
			modifiedCount: 0,
		}),
		updateMany: vi.fn().mockResolvedValue({
			matchedCount: 0,
			modifiedCount: 0,
		}),
		bulkWrite: vi.fn().mockResolvedValue({
			insertedCount: 0,
			matchedCount: 0,
			modifiedCount: 0,
			deletedCount: 0,
			upsertedCount: 1,
		}),
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			}),
			toArray: vi.fn().mockResolvedValue([]),
		}),
		aggregate: vi.fn().mockReturnValue({
			toArray: vi.fn().mockResolvedValue([]),
		}),
		deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
		deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
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

function _makeRelation(overrides: Partial<Relation> = {}): Relation {
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

describe("typed relation lease fencing", () => {
	it("checks ownership after provider extraction before writing relations", async () => {
		const collection = createMockCollection()
		const db = createMockDb({ test_relations: collection })
		const leaseFence = vi.fn(async () => true)
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({
					relations: [
						{
							from: "entity-a",
							to: "entity-b",
							type: "depends_on",
							confidence: 0.9,
						},
					],
				}),
			})),
		}

		const created = await extractAndUpsertTypedRelations({
			db,
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			eventContent: "A depends on B",
			entities: [
				{ entityId: "entity-a", name: "A" },
				{ entityId: "entity-b", name: "B" },
			],
			provider,
			model: "test-model",
			leaseFence,
		})

		expect(created).toBe(0)
		expect(leaseFence).toHaveBeenCalledOnce()
		expect(collection.updateOne).not.toHaveBeenCalled()
	})
})

const PREFIX = "test_"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-graph", () => {
	describe("extractAndUpsertEntities", () => {
		it("extracts @mentions as person entities", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "Talked to @alice about the project",
				scope: "agent",
			})

			expect(result.entities).toContainEqual(
				expect.objectContaining({ name: "alice", type: "person" }),
			)
		})

		it("extracts #tags as topic entities", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "Working on #frontend #refactor today",
				scope: "agent",
			})

			expect(result.entities).toHaveLength(2)
			expect(result.entities[0].type).toBe("topic")
			expect(result.entities[1].type).toBe("topic")
		})

		it("extracts URLs as document entities", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "See https://example.com/docs for details",
				scope: "agent",
			})

			expect(result.entities).toContainEqual(
				expect.objectContaining({
					name: "https://example.com/docs",
					type: "document",
				}),
			)
		})

		it("extracts file paths as document entities", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "Modified src/memory/mongodb-graph.ts",
				scope: "agent",
			})

			expect(result.entities).toContainEqual(
				expect.objectContaining({
					name: "src/memory/mongodb-graph.ts",
					type: "document",
				}),
			)
		})

		it("extracts 'quoted names' as person entities (min 3 chars)", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: 'Meeting with "John Smith" about the design',
				scope: "agent",
			})

			expect(result.entities).toContainEqual(
				expect.objectContaining({ name: "John Smith", type: "person" }),
			)
		})

		it("filters out stop words and short names", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: '"the" and "is" are not names. @me is too short',
				scope: "agent",
			})

			expect(result.entities).toHaveLength(0)
		})

		it("generates deterministic entityIds via hash", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result1 = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "Talked to @alice",
				scope: "agent",
			})
			const result2 = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "Met @alice again",
				scope: "agent",
			})

			// Same @alice -> same entityId
			const id1 = result1.entities.find((e) => e.name === "alice")?.entityId
			const id2 = result2.entities.find((e) => e.name === "alice")?.entityId
			expect(id1).toBe(id2)
		})

		it("returns empty result for content with no extractable entities", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "Just a plain message with no entities",
				scope: "agent",
			})

			expect(result.entities).toHaveLength(0)
		})

		it("creates candidate_same links for ambiguous person mentions via bulkWrite", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: 'Pair @sarah with "Sarah Chen" on the design review.',
				scope: "agent",
				sourceEventId: "evt-1",
			})

			// H1 audit fix: entity links now use bulkWrite instead of sequential updateOne
			const bulkCalls = (entityLinksCol.bulkWrite as ReturnType<typeof vi.fn>)
				.mock.calls
			expect(bulkCalls.length).toBeGreaterThan(0)
			const ops = bulkCalls[0][0] as Array<{
				updateOne: {
					filter: Record<string, unknown>
					update: Record<string, unknown>
				}
			}>
			expect(ops.length).toBeGreaterThan(0)
			const candidateOp = ops.find(
				(op) => op.updateOne.filter.linkType === "candidate_same",
			)
			expect(candidateOp).toBeDefined()
			expect(
				(
					candidateOp?.updateOne.update as Record<
						string,
						Record<string, unknown>
					>
				).$set.status,
			).toBe("active")
			expect(
				(
					candidateOp?.updateOne.update as Record<
						string,
						Record<string, unknown>
					>
				).$set.provenance,
			).toBeDefined()
		})

		// H1 audit fix: verify bulkWrite is used instead of sequential upsertEntity
		it("uses bulkWrite for entity upserts (H1 audit fix)", async () => {
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "@alice mentioned @bob working on #projectX",
				scope: "agent",
				sourceEventId: "ev1",
			})

			// Should call bulkWrite once instead of N sequential upsertEntity calls
			const bulkCalls = (entitiesCol.bulkWrite as ReturnType<typeof vi.fn>).mock
				.calls
			expect(bulkCalls.length).toBe(1)
			const ops = bulkCalls[0][0]
			expect(ops.length).toBeGreaterThanOrEqual(2) // at least alice + bob
			// Each op should be updateOne with upsert: true
			for (const op of ops) {
				expect(op).toHaveProperty("updateOne")
				expect(op.updateOne.upsert).toBe(true)
			}
		})

		// H6 audit fix: verify entity-extraction telemetry is emitted
		it("emits entity-extraction telemetry (H6 audit fix)", async () => {
			vi.clearAllMocks()
			const entitiesCol = createMockCollection()
			const relationsCol = createMockCollection()
			const entityLinksCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}entity_links`]: entityLinksCol,
			})

			await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				eventContent: "@alice",
				scope: "agent",
			})

			expect(emitTelemetry).toHaveBeenCalledWith(
				db,
				PREFIX,
				expect.objectContaining({
					meta: { agentId: "agent-1", operation: "entity-extraction" },
					ok: true,
					extractionMethod: "regex",
					entitiesExtracted: 1,
				}),
			)
		})
	})

	describe("expandGraph telemetry emission", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("emits graph-expansion telemetry after successful expansion", async () => {
			const rootEntity = makeEntity({ entityId: "root-1", name: "Root" })
			const entCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue(rootEntity),
				find: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
					sort: vi.fn().mockReturnValue({
						limit: vi
							.fn()
							.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
					}),
				}),
			})
			const relCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entCol,
				[`${PREFIX}relations`]: relCol,
			})

			await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "root-1",
				agentId: "agent-1",
			})

			expect(emitTelemetry).toHaveBeenCalledWith(
				db,
				PREFIX,
				expect.objectContaining({
					meta: { agentId: "agent-1", operation: "graph-expansion" },
					ok: true,
					resultCount: expect.any(Number),
					durationMs: expect.any(Number),
				}),
			)
		})
	})

	describe("deleteEntityConservative", () => {
		it("returns conflict when entity has relations and force is not set", async () => {
			const entitiesCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue(makeEntity()),
				deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
			})
			const relationsCol = createMockCollection({
				countDocuments: vi.fn().mockResolvedValue(3),
				deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await deleteEntityConservative({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
			})

			expect(result.deletedEntity).toBe(false)
			expect(result.conflictDetected).toBe(true)
			expect(result.conflictingRelationCount).toBe(3)
			expect(result.deletedRelations).toBe(0)
			// Should NOT have called deleteOne
			expect(entitiesCol.deleteOne).not.toHaveBeenCalled()
		})

		it("deletes entity with no relations and records audit", async () => {
			const entityDoc = makeEntity()
			const entitiesCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue(entityDoc),
				deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
			})
			const relationsCol = createMockCollection({
				countDocuments: vi.fn().mockResolvedValue(0),
				deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
			})
			const mutationsCol = createMockCollection({
				insertOne: vi.fn().mockResolvedValue({ insertedId: "mut-1" }),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}memory_mutations`]: mutationsCol,
			})

			const result = await deleteEntityConservative({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
			})

			expect(result.deletedEntity).toBe(true)
			expect(result.conflictDetected).toBe(false)
			expect(result.deletedRelations).toBe(0)
			expect(result.auditRecorded).toBe(true)
		})

		it("deletes entity with relations when force=true and records audit", async () => {
			const entityDoc = makeEntity()
			const entitiesCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue(entityDoc),
				deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
			})
			const relationsCol = createMockCollection({
				countDocuments: vi.fn().mockResolvedValue(5),
				deleteMany: vi.fn().mockResolvedValue({ deletedCount: 5 }),
			})
			const mutationsCol = createMockCollection({
				insertOne: vi.fn().mockResolvedValue({ insertedId: "mut-1" }),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}memory_mutations`]: mutationsCol,
			})

			const result = await deleteEntityConservative({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
				force: true,
			})

			expect(result.deletedEntity).toBe(true)
			expect(result.conflictDetected).toBe(false)
			expect(result.deletedRelations).toBe(5)
			expect(result.auditRecorded).toBe(true)
		})

		it("returns not-found when entity does not exist", async () => {
			const entitiesCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue(null),
				deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
			})
			const relationsCol = createMockCollection({
				countDocuments: vi.fn().mockResolvedValue(0),
				deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await deleteEntityConservative({
				db,
				prefix: PREFIX,
				entityId: "ent-nonexistent",
				agentId: "agent-1",
			})

			expect(result.deletedEntity).toBe(false)
			expect(result.conflictDetected).toBe(false)
			expect(result.deletedRelations).toBe(0)
			expect(result.auditRecorded).toBe(false)
		})

		it("still deletes when audit recording fails (fire-and-forget)", async () => {
			const entityDoc = makeEntity()
			const entitiesCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue(entityDoc),
				deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
			})
			const relationsCol = createMockCollection({
				countDocuments: vi.fn().mockResolvedValue(0),
				deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
			})
			// Mutations collection throws on insertOne (audit failure)
			const mutationsCol = createMockCollection({
				insertOne: vi.fn().mockRejectedValue(new Error("audit write failed")),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
				[`${PREFIX}memory_mutations`]: mutationsCol,
			})

			const result = await deleteEntityConservative({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
			})

			// Deletion still succeeded despite audit failure
			expect(result.deletedEntity).toBe(true)
			expect(result.conflictDetected).toBe(false)
			expect(result.auditRecorded).toBe(false)
		})
	})

	describe("Entity Registry Phase 3.4", () => {
		describe("mentionCount $inc on entity upsert", () => {
			it("uses $inc when no source event idempotency key is available", async () => {
				const entitiesCol = createMockCollection()
				const relationsCol = createMockCollection()
				const entityLinksCol = createMockCollection()
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: relationsCol,
					[`${PREFIX}entity_links`]: entityLinksCol,
				})

				await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "@alice works on the project",
					scope: "agent",
				})

				const bulkCalls = (entitiesCol.bulkWrite as ReturnType<typeof vi.fn>)
					.mock.calls
				expect(bulkCalls.length).toBe(1)
				const ops = bulkCalls[0][0] as Array<{
					updateOne: {
						update: Record<string, unknown>
					}
				}>
				// Check first op has $inc mentionCount
				const update = ops[0].updateOne.update
				expect(update).toHaveProperty("$inc")
				expect((update.$inc as Record<string, number>).mentionCount).toBe(1)
			})

			it("does NOT put mentionCount in $set (avoid $inc/$set conflict)", async () => {
				const entitiesCol = createMockCollection()
				const relationsCol = createMockCollection()
				const entityLinksCol = createMockCollection()
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: relationsCol,
					[`${PREFIX}entity_links`]: entityLinksCol,
				})

				await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "@bob is here",
					scope: "agent",
				})

				const bulkCalls = (entitiesCol.bulkWrite as ReturnType<typeof vi.fn>)
					.mock.calls
				const ops = bulkCalls[0][0] as Array<{
					updateOne: {
						update: Record<string, unknown>
					}
				}>
				const setDoc = ops[0].updateOne.update.$set as Record<string, unknown>
				expect(setDoc).not.toHaveProperty("mentionCount")
			})
		})

		describe("confidenceSource assignment", () => {
			it("sets confidenceSource to inferred for regex-extracted entities", async () => {
				const entitiesCol = createMockCollection()
				const relationsCol = createMockCollection()
				const entityLinksCol = createMockCollection()
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: relationsCol,
					[`${PREFIX}entity_links`]: entityLinksCol,
				})

				await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "@alice mentioned #design",
					scope: "agent",
				})

				const bulkCalls = (entitiesCol.bulkWrite as ReturnType<typeof vi.fn>)
					.mock.calls
				const ops = bulkCalls[0][0] as Array<{
					updateOne: {
						update: Record<string, unknown>
					}
				}>
				const setOnInsert = ops[0].updateOne.update.$setOnInsert as Record<
					string,
					unknown
				>
				expect(setOnInsert.confidenceSource).toBe("inferred")
			})

			it("sets confidenceSource to learned for high-confidence LLM entities", async () => {
				const llmFn = vi
					.fn()
					.mockResolvedValue(
						JSON.stringify([
							{ name: "MongoDB", type: "system", confidence: 0.9 },
						]),
					)
				const { LLMEntityExtractor } = await import(
					"./mongodb-entity-extractor.js"
				)
				const llmExtractor = new LLMEntityExtractor(llmFn, 5000)

				const entitiesCol = createMockCollection()
				const relationsCol = createMockCollection()
				const entityLinksCol = createMockCollection()
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: relationsCol,
					[`${PREFIX}entity_links`]: entityLinksCol,
				})

				await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "MongoDB is the best database",
					scope: "agent",
					extractor: llmExtractor,
				})

				const bulkCalls = (entitiesCol.bulkWrite as ReturnType<typeof vi.fn>)
					.mock.calls
				const ops = bulkCalls[0][0] as Array<{
					updateOne: {
						update: Record<string, unknown>
					}
				}>
				const setOnInsert = ops[0].updateOne.update.$setOnInsert as Record<
					string,
					unknown
				>
				expect(setOnInsert.confidenceSource).toBe("learned")
			})
		})

		describe("ambiguousFlags on entity upsert", () => {
			it("adds ambiguousFlags for person entity with ambiguous name", async () => {
				const entitiesCol = createMockCollection()
				const relationsCol = createMockCollection()
				const entityLinksCol = createMockCollection()
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: relationsCol,
					[`${PREFIX}entity_links`]: entityLinksCol,
				})

				// @grace is @mention so passes 2-signal gate as person
				await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "@grace is working on the project",
					scope: "agent",
				})

				const bulkCalls = (entitiesCol.bulkWrite as ReturnType<typeof vi.fn>)
					.mock.calls
				const ops = bulkCalls[0][0] as Array<{
					updateOne: {
						update: Record<string, unknown>
					}
				}>
				const graceOp = ops.find(
					(op) =>
						(op.updateOne.update.$set as Record<string, unknown>).name ===
						"grace",
				)
				expect(graceOp).toBeDefined()
				const addToSet = graceOp?.updateOne.update.$addToSet as Record<
					string,
					unknown
				>
				expect(addToSet.ambiguousFlags).toBe("grace")
			})

			it("does not add ambiguousFlags for non-ambiguous person name", async () => {
				const entitiesCol = createMockCollection()
				const relationsCol = createMockCollection()
				const entityLinksCol = createMockCollection()
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: relationsCol,
					[`${PREFIX}entity_links`]: entityLinksCol,
				})

				await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "@alice is working on the project",
					scope: "agent",
				})

				const bulkCalls = (entitiesCol.bulkWrite as ReturnType<typeof vi.fn>)
					.mock.calls
				const ops = bulkCalls[0][0] as Array<{
					updateOne: {
						update: Record<string, unknown>
					}
				}>
				const aliceOp = ops.find(
					(op) =>
						(op.updateOne.update.$set as Record<string, unknown>).name ===
						"alice",
				)
				expect(aliceOp).toBeDefined()
				const addToSet = aliceOp?.updateOne.update.$addToSet as
					| Record<string, unknown>
					| undefined
				expect(addToSet?.ambiguousFlags).toBeUndefined()
			})
		})

		describe("searchEntitiesAutocomplete", () => {
			it("calls $search with autocomplete operator on entities collection", async () => {
				const entCol = createMockCollection({
					aggregate: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([
							{
								entityId: "ent-1",
								name: "New York City",
								type: "location",
								aliases: ["NYC"],
								agentId: "agent-1",
								scope: "agent",
								scopeRef: "agent:agent-1",
								updatedAt: new Date(),
							},
						]),
					}),
				})
				const db = createMockDb({
					[`${PREFIX}entities`]: entCol,
				})

				const results = await searchEntitiesAutocomplete({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					query: "New York",
					textSearchAvailable: true,
				})

				expect(results).toHaveLength(1)
				expect(results[0].name).toBe("New York City")

				// Verify aggregate was called with $search autocomplete
				const aggCalls = (entCol.aggregate as ReturnType<typeof vi.fn>).mock
					.calls
				expect(aggCalls.length).toBe(1)
				const pipeline = aggCalls[0][0] as Document[]
				expect(pipeline[0]).toHaveProperty("$search")
				const searchStage = pipeline[0].$search as Record<string, unknown>
				expect(searchStage).toHaveProperty("compound")
				const compound = searchStage.compound as Record<string, unknown>
				const shouldClauses = compound.should as Array<Record<string, unknown>>
				expect(shouldClauses[0]).toHaveProperty("autocomplete")

				// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling
				const options = aggCalls[0][1] as { maxTimeMS?: number } | undefined
				expect(typeof options?.maxTimeMS).toBe("number")
			})

			it("defaults limit to 10", async () => {
				const entCol = createMockCollection({
					aggregate: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				})
				const db = createMockDb({
					[`${PREFIX}entities`]: entCol,
				})

				await searchEntitiesAutocomplete({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					query: "test",
					textSearchAvailable: true,
				})

				const pipeline = (entCol.aggregate as ReturnType<typeof vi.fn>).mock
					.calls[0][0] as Document[]
				const limitStage = pipeline.find((s: Document) => "$limit" in s)
				expect(limitStage).toBeDefined()
				expect(limitStage?.$limit).toBe(10)
			})

			it("uses the escaped $regex path without attempting $search when textSearch capability is off (P3.8)", async () => {
				const findResult = {
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([
								{
									entityId: "ent-1",
									name: "C++ (beta) notes",
									type: "concept",
									agentId: "agent-1",
									scope: "agent",
									updatedAt: new Date(),
								},
							]),
						}),
					}),
				}
				const entCol = createMockCollection({
					find: vi.fn().mockReturnValue(findResult),
				})
				const db = createMockDb({
					[`${PREFIX}entities`]: entCol,
				})

				const results = await searchEntitiesAutocomplete({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					query: "C++ (beta)",
					textSearchAvailable: false,
				})

				// No wasted $search round trip when mongot is known-absent
				expect(entCol.aggregate).not.toHaveBeenCalled()
				expect(results).toHaveLength(1)

				// The regex fallback must stay escaped — metacharacters in the query
				// cannot become regex operators.
				const [filter] = (entCol.find as ReturnType<typeof vi.fn>).mock.calls[0]
				const nameClause = filter.$or?.[0]?.name?.$regex as RegExp
				expect(nameClause).toBeInstanceOf(RegExp)
				expect(nameClause.source).toBe("C\\+\\+ \\(beta\\)")
			})

			it("falls back to the escaped $regex path when $search fails at runtime", async () => {
				const findResult = {
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}
				const entCol = createMockCollection({
					aggregate: vi.fn().mockReturnValue({
						toArray: vi.fn().mockRejectedValue(new Error("mongot unavailable")),
					}),
					find: vi.fn().mockReturnValue(findResult),
				})
				const db = createMockDb({
					[`${PREFIX}entities`]: entCol,
				})

				await searchEntitiesAutocomplete({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					query: "fallback",
					textSearchAvailable: true,
				})

				expect(entCol.aggregate).toHaveBeenCalledOnce()
				expect(entCol.find).toHaveBeenCalledOnce()
			})
		})

		describe("findRelationByLocatorId (P3.8)", () => {
			it("resolves a relation with one findOne on the relationId index — no full-scan JS matching", async () => {
				const relationDoc = {
					fromEntityId: "ent-1",
					toEntityId: "ent-2",
					type: "works_on",
					relationId: "ent-1-ent-2",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					updatedAt: new Date(),
				}
				const relationsCol = createMockCollection({
					findOne: vi.fn().mockResolvedValue(relationDoc),
				})
				const db = createMockDb({
					[`${PREFIX}relations`]: relationsCol,
				})

				const result = await findRelationByLocatorId({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					relationId: "ent-1-ent-2",
				})

				expect(result).toEqual(relationDoc)
				expect(relationsCol.findOne).toHaveBeenCalledWith(
					{
						agentId: "agent-1",
						scope: "agent",
						scopeRef: "agent:agent-1",
						relationId: "ent-1-ent-2",
					},
					{ sort: { updatedAt: -1, _id: 1 } },
				)
				// The old path fetched up to 50 relations and matched in JS.
				expect(relationsCol.find).not.toHaveBeenCalled()
			})

			it("falls back to the legacy scan for relations written before relationId existed", async () => {
				const legacyDoc = {
					fromEntityId: "ent-3",
					toEntityId: "ent-4",
					type: "owns",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					updatedAt: new Date(),
				}
				const relationsCol = createMockCollection({
					findOne: vi.fn().mockResolvedValue(null),
					find: vi.fn().mockReturnValue({
						toArray: vi
							.fn()
							.mockResolvedValue([
								{ fromEntityId: "ent-9", toEntityId: "ent-8" },
								legacyDoc,
							]),
					}),
				})
				const db = createMockDb({
					[`${PREFIX}relations`]: relationsCol,
				})

				const result = await findRelationByLocatorId({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					relationId: "ent-3-ent-4",
				})

				expect(result).toEqual(legacyDoc)
				expect(relationsCol.findOne).toHaveBeenCalledOnce()
				expect(relationsCol.find).toHaveBeenCalledOnce()
			})

			it("returns null when no relation matches the locator id", async () => {
				const relationsCol = createMockCollection({
					findOne: vi.fn().mockResolvedValue(null),
				})
				const db = createMockDb({
					[`${PREFIX}relations`]: relationsCol,
				})

				const result = await findRelationByLocatorId({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					relationId: "nope-nada",
				})

				expect(result).toBeNull()
			})
		})

		describe("bulkWrite duplicate-key recovery (P2.5 c)", () => {
			it("retries a losing entity upsert as a plain update so its side effects land on the winner", async () => {
				// The winner's document: a concurrent extractor already committed
				// the insert for the same unique identity.
				const winnerDoc: Document = {
					entityId: "ent-winner",
					name: "alice",
					type: "person",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					mentionCount: 1,
					createdAt: new Date("2026-04-09T10:00:00.000Z"),
					extractedAt: new Date("2026-04-09T10:00:00.000Z"),
					confidenceSource: "inferred",
					updatedAt: new Date("2026-04-09T10:00:00.000Z"),
				}
				const updateOne = vi.fn(
					async (
						_filter: Document,
						update: Document,
						options?: { upsert?: boolean },
					) => {
						expect(options?.upsert).toBe(false)
						if (update.$set) {
							Object.assign(winnerDoc, update.$set)
						}
						if (update.$inc) {
							for (const [key, amount] of Object.entries(update.$inc)) {
								winnerDoc[key] = Number(winnerDoc[key] ?? 0) + Number(amount)
							}
						}
						return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
					},
				)
				const entitiesCol = createMockCollection({
					// Single-op batch: the driver surfaces the loser's E11000 as a
					// plain duplicate-key server error.
					bulkWrite: vi.fn().mockRejectedValue(
						Object.assign(new Error("E11000 duplicate key error"), {
							code: 11000,
						}),
					),
					updateOne,
				})
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: createMockCollection(),
					[`${PREFIX}entity_links`]: createMockCollection(),
				})

				const result = await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "Talked to @alice about the project",
					scope: "agent",
				})

				expect(result.entities).toHaveLength(1)
				expect(updateOne).toHaveBeenCalledOnce()
				const [filter] = updateOne.mock.calls[0] as [Document]
				expect(filter).toEqual({
					entityId: result.entities[0].entityId,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
				})
				// The losing op's $inc was not silently dropped: the final state
				// reflects BOTH the winner's insert and the loser's mention.
				expect(winnerDoc.mentionCount).toBe(2)
			})

			it("retries only the duplicate-key writeErrors of a multi-op batch", async () => {
				const updateOne = vi.fn().mockResolvedValue({
					matchedCount: 1,
					modifiedCount: 1,
					upsertedCount: 0,
				})
				const entitiesCol = createMockCollection({
					bulkWrite: vi.fn().mockRejectedValue(
						Object.assign(new Error("batch failed"), {
							writeErrors: [
								{ index: 1, code: 11000, errmsg: "E11000 duplicate key" },
							],
						}),
					),
					updateOne,
				})
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: createMockCollection(),
					[`${PREFIX}entity_links`]: createMockCollection(),
				})

				const result = await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: "agent-1",
					eventContent: "Working on #frontend #refactor today",
					scope: "agent",
				})

				expect(result.entities).toHaveLength(2)
				// Only the losing op (index 1) is replayed, as a plain update.
				expect(updateOne).toHaveBeenCalledOnce()
				const [filter, , options] = updateOne.mock.calls[0] as [
					Document,
					Document,
					{ upsert?: boolean },
				]
				expect(filter.entityId).toBe(result.entities[1].entityId)
				expect(options?.upsert).toBe(false)
			})

			it("keeps warn-and-continue for non-duplicate bulk failures (no retry)", async () => {
				const updateOne = vi.fn()
				const entitiesCol = createMockCollection({
					bulkWrite: vi.fn().mockRejectedValue(
						Object.assign(new Error("batch failed"), {
							writeErrors: [{ index: 0, code: 42, errmsg: "some other error" }],
						}),
					),
					updateOne,
				})
				const db = createMockDb({
					[`${PREFIX}entities`]: entitiesCol,
					[`${PREFIX}relations`]: createMockCollection(),
					[`${PREFIX}entity_links`]: createMockCollection(),
				})

				await expect(
					extractAndUpsertEntities({
						db,
						prefix: PREFIX,
						agentId: "agent-1",
						eventContent: "Talked to @alice about the project",
						scope: "agent",
					}),
				).resolves.toBeDefined()
				expect(updateOne).not.toHaveBeenCalled()
			})
		})
	})
})
