/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import {
	upsertEntity,
	upsertRelation,
	upsertEntityLink,
	setEntityLinkStatus,
	getEntityLinks,
	findEntitiesByName,
	getEntitiesByType,
	expandGraph,
	deleteEntity,
	deleteEntityConservative,
	extractAndUpsertEntities,
	searchEntitiesAutocomplete,
	type Entity,
	type Relation,
} from "./mongodb-graph.js"
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
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-graph", () => {
	describe("upsertEntity", () => {
		it("creates a new entity", async () => {
			const entitiesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })
			const entity = makeEntity()

			const result = await upsertEntity({ db, prefix: PREFIX, entity })

			expect(result.upserted).toBe(true)
			expect(entitiesCol.updateOne).toHaveBeenCalledOnce()
			const [filter, update, opts] = (
				entitiesCol.updateOne as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(filter).toEqual({
				entityId: "ent-1",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
			})
			expect(update.$set).toBeDefined()
			expect(update.$set.name).toBe("Alice")
			expect(update.$set.type).toBe("person")
			expect(update.$set.agentId).toBe("agent-1")
			expect(update.$set.scope).toBe("agent")
			expect(update.$setOnInsert).toBeDefined()
			expect(opts).toEqual({ upsert: true })
		})

		it("updates existing entity (same entityId)", async () => {
			const entitiesCol = createMockCollection({
				updateOne: vi.fn().mockResolvedValue({
					upsertedCount: 0,
					matchedCount: 1,
					modifiedCount: 1,
				}),
			})
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })
			const entity = makeEntity({ name: "Alice Updated" })

			const result = await upsertEntity({ db, prefix: PREFIX, entity })

			expect(result.upserted).toBe(false)
			const [, update] = (entitiesCol.updateOne as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(update.$set.name).toBe("Alice Updated")
		})
	})

	describe("upsertRelation", () => {
		it("creates a relation between two entities", async () => {
			const relationsCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })
			const relation = makeRelation()

			const result = await upsertRelation({ db, prefix: PREFIX, relation })

			expect(result.upserted).toBe(true)
			expect(relationsCol.updateOne).toHaveBeenCalledOnce()
			const [filter, update, opts] = (
				relationsCol.updateOne as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(filter).toEqual({
				fromEntityId: "ent-1",
				toEntityId: "ent-2",
				type: "works_on",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
			})
			expect(update.$set.agentId).toBe("agent-1")
			expect(update.$set.scope).toBe("agent")
			expect(opts).toEqual({ upsert: true })
		})

		it("tracks lifecycle metadata on a new relation", async () => {
			const relationsCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })

			await upsertRelation({
				db,
				prefix: PREFIX,
				relation: makeRelation({
					sourceEventIds: ["evt-1"],
				}),
			})

			const [, update] = (relationsCol.updateOne as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(update.$set.state).toBe("active")
			expect(update.$set.validFrom).toBeInstanceOf(Date)
			expect(update.$set.lastConfirmedAt).toBeInstanceOf(Date)
			expect(update.$set.reinforcementCount).toBe(1)
			expect(update.$set.sourceReliability).toBeGreaterThan(0)
		})

		it("reinforces an unchanged relation instead of replacing it", async () => {
			const relationsCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue({
					fromEntityId: "ent-1",
					toEntityId: "ent-2",
					type: "works_on",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					state: "active",
					reinforcementCount: 2,
					validFrom: new Date("2026-03-01T00:00:00.000Z"),
					updatedAt: new Date("2026-03-01T00:00:00.000Z"),
				}),
				updateOne: vi.fn().mockResolvedValue({
					upsertedCount: 0,
					matchedCount: 1,
					modifiedCount: 1,
				}),
			})
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })

			const result = await upsertRelation({
				db,
				prefix: PREFIX,
				relation: makeRelation(),
			})

			expect(result.upserted).toBe(false)
			const [, update] = (relationsCol.updateOne as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(update.$inc.reinforcementCount).toBe(1)
			expect(update.$set.lastConfirmedAt).toBeInstanceOf(Date)
		})

		it("invalidates stale active owns relations when ownership changes", async () => {
			const relationsCol = createMockCollection({
				updateMany: vi.fn().mockResolvedValue({
					matchedCount: 1,
					modifiedCount: 1,
				}),
			})
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })

			await upsertRelation({
				db,
				prefix: PREFIX,
				relation: makeRelation({
					fromEntityId: "ent-bob",
					toEntityId: "ent-phoenix",
					type: "owns",
				}),
			})

			expect(relationsCol.updateMany).toHaveBeenCalledOnce()
			const [filter, update] = (
				relationsCol.updateMany as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(filter).toEqual({
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				type: "owns",
				toEntityId: "ent-phoenix",
				fromEntityId: { $ne: "ent-bob" },
				state: { $ne: "invalidated" },
			})
			expect(update.$set.state).toBe("invalidated")

			const [, createUpdate] = (
				relationsCol.updateOne as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(createUpdate.$set.supersedes).toMatchObject({
				type: "owns",
				toEntityId: "ent-phoenix",
				invalidatedRelationCount: 1,
			})
		})
	})

	describe("upsertEntityLink", () => {
		it("stores candidate links with a canonicalized entity pair", async () => {
			const entityLinksCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}entity_links`]: entityLinksCol })

			const result = await upsertEntityLink({
				db,
				prefix: PREFIX,
				link: {
					fromEntityId: "ent-z",
					toEntityId: "ent-a",
					linkType: "candidate_same",
					status: "active",
					confidence: 0.65,
					agentId: "agent-1",
					scope: "agent",
				},
			})

			expect(result.linkId).toBeTruthy()
			const [filter, update, opts] = (
				entityLinksCol.updateOne as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(filter).toEqual({
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				fromEntityId: "ent-a",
				toEntityId: "ent-z",
				linkType: "candidate_same",
			})
			expect(update.$set.status).toBe("active")
			expect(update.$set.confidence).toBe(0.65)
			expect(opts).toEqual({ upsert: true })
		})
	})

	describe("setEntityLinkStatus", () => {
		it("marks an existing link as rejected without changing the pair identity", async () => {
			const entityLinksCol = createMockCollection({
				updateOne: vi
					.fn()
					.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
			})
			const db = createMockDb({ [`${PREFIX}entity_links`]: entityLinksCol })

			const changed = await setEntityLinkStatus({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				scope: "agent",
				fromEntityId: "ent-b",
				toEntityId: "ent-a",
				linkType: "candidate_same",
				status: "rejected",
			})

			expect(changed).toBe(true)
			const [filter, update] = (
				entityLinksCol.updateOne as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(filter.fromEntityId).toBe("ent-a")
			expect(filter.toEntityId).toBe("ent-b")
			expect(update.$set.status).toBe("rejected")
		})
	})

	describe("getEntityLinks", () => {
		it("returns links touching the requested entity", async () => {
			const docs = [
				{
					linkId: "link-1",
					fromEntityId: "ent-1",
					toEntityId: "ent-2",
					linkType: "candidate_same",
					status: "active",
					confidence: 0.65,
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					updatedAt: new Date(),
				},
			]
			const entityLinksCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue(docs),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}entity_links`]: entityLinksCol })

			const results = await getEntityLinks({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				entityId: "ent-1",
				status: "active",
			})

			expect(results).toHaveLength(1)
			const [filter] = (entityLinksCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter.agentId).toBe("agent-1")
			expect(filter.status).toBe("active")
			expect(filter.$or).toEqual([
				{ fromEntityId: "ent-1" },
				{ toEntityId: "ent-1" },
			])
		})
	})

	describe("findEntitiesByName", () => {
		it("returns matching entities", async () => {
			const entityDoc = {
				entityId: "ent-1",
				name: "Alice",
				type: "person",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date("2026-01-01"),
			}
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([entityDoc]),
					}),
				}),
			}
			const entitiesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })

			const results = await findEntitiesByName({
				db,
				prefix: PREFIX,
				query: "Alice",
				agentId: "agent-1",
			})

			expect(results).toHaveLength(1)
			expect(results[0].entityId).toBe("ent-1")
			expect(results[0].name).toBe("Alice")
			// Verify regex search on name/aliases
			const [filter] = (entitiesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter.agentId).toBe("agent-1")
			expect(filter.$or).toBeDefined()
		})
	})

	describe("getEntitiesByType", () => {
		it("returns all entities of a given type", async () => {
			const docs = [
				{
					entityId: "ent-1",
					name: "Alice",
					type: "person",
					agentId: "agent-1",
					scope: "agent",
					updatedAt: new Date(),
				},
				{
					entityId: "ent-2",
					name: "Bob",
					type: "person",
					agentId: "agent-1",
					scope: "agent",
					updatedAt: new Date(),
				},
			]
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue(docs),
					}),
				}),
			}
			const entitiesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })

			const results = await getEntitiesByType({
				db,
				prefix: PREFIX,
				type: "person",
				agentId: "agent-1",
			})

			expect(results).toHaveLength(2)
			const [filter] = (entitiesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter).toEqual({ agentId: "agent-1", type: "person" })
		})
	})

	describe("expandGraph", () => {
		it("uses $graphLookup to find connected entities within maxDepth", async () => {
			const rootEntity = makeEntity()
			const connectedRelation = {
				fromEntityId: "ent-1",
				toEntityId: "ent-2",
				type: "works_on",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date("2026-01-01"),
				depth: 0,
			}
			const connectedEntity = makeEntity({
				entityId: "ent-2",
				name: "ProjectX",
				type: "project",
			})

			// entities collection: findOne for root, find for connected entity lookup
			const entitiesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([connectedEntity]),
				}),
			})
			// Override aggregate on entities for the root lookup, and relations for $graphLookup
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(rootEntity)

			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([connectedRelation]),
				}),
			})

			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
				maxDepth: 2,
			})

			expect(result).not.toBeNull()
			expect(result?.rootEntity.entityId).toBe("ent-1")
			expect(result?.connections).toHaveLength(1)
			expect(result?.connections[0]?.entity.entityId).toBe("ent-2")
			expect(result?.connections[0]?.relation.type).toBe("works_on")
			expect(result?.connections[0]?.depth).toBe(0)

			// Verify $graphLookup was used on relations collection
			expect(relationsCol.aggregate).toHaveBeenCalledOnce()
			const [pipeline] = (relationsCol.aggregate as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			// Find the $graphLookup stage
			const graphLookupStage = pipeline.find((s: Document) => s.$graphLookup)
			expect(graphLookupStage).toBeDefined()
			// maxDepth is (requested - 1) because the initial $match already captures direct edges
			expect(graphLookupStage.$graphLookup.maxDepth).toBe(1)
			expect(graphLookupStage.$graphLookup.restrictSearchWithMatch).toEqual({
				$and: expect.arrayContaining([
					expect.objectContaining({ agentId: "agent-1" }),
					{
						$or: [
							{ state: { $exists: false } },
							{ state: { $in: ["active", "conflicted"] } },
						],
					},
					{
						$or: [
							{ validFrom: { $exists: false } },
							{ validFrom: { $lte: expect.any(Date) } },
						],
					},
					{
						$or: [
							{ validTo: { $exists: false } },
							{ validTo: { $gt: expect.any(Date) } },
						],
					},
				]),
			})
			expect(pipeline[0].$match).toEqual({
				$and: expect.arrayContaining([
					expect.objectContaining({
						fromEntityId: "ent-1",
						agentId: "agent-1",
					}),
					{
						$or: [
							{ state: { $exists: false } },
							{ state: { $in: ["active", "conflicted"] } },
						],
					},
					{
						$or: [
							{ validFrom: { $exists: false } },
							{ validFrom: { $lte: expect.any(Date) } },
						],
					},
					{
						$or: [
							{ validTo: { $exists: false } },
							{ validTo: { $gt: expect.any(Date) } },
						],
					},
				]),
			})
		})

		it("uses explicit asOf boundaries in relation traversal filters", async () => {
			const rootEntity = makeEntity()
			const entitiesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			})
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(rootEntity)
			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})
			const asOf = new Date("2026-04-11T10:30:00.000Z")

			await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
				asOf,
			})

			const [pipeline] = (relationsCol.aggregate as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(pipeline[0].$match).toEqual({
				$and: expect.arrayContaining([
					expect.objectContaining({
						fromEntityId: "ent-1",
						agentId: "agent-1",
					}),
					{
						$or: [
							{ validFrom: { $exists: false } },
							{ validFrom: { $lte: asOf } },
						],
					},
					{
						$or: [{ validTo: { $exists: false } }, { validTo: { $gt: asOf } }],
					},
				]),
			})
		})

		it("respects agentId filter", async () => {
			// Root entity not found for different agent
			const entitiesCol = createMockCollection()
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(null)
			const relationsCol = createMockCollection()

			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-other",
				maxDepth: 2,
			})

			// Should return null when root entity not found for agent
			expect(result).toBeNull()
		})
	})

	describe("deleteEntity", () => {
		it("removes entity and its relations scoped by agentId", async () => {
			const entitiesCol = createMockCollection({
				deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
			})
			const relationsCol = createMockCollection({
				deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
			})
			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await deleteEntity({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
			})

			expect(result.deletedEntity).toBe(true)
			expect(result.deletedRelations).toBe(3)
			// Verify entity deletion includes agentId
			expect(entitiesCol.deleteOne).toHaveBeenCalledWith({
				entityId: "ent-1",
				agentId: "agent-1",
			})
			// Verify cascade deletion of relations includes agentId
			const [relFilter] = (relationsCol.deleteMany as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(relFilter.$or).toEqual([
				{ fromEntityId: "ent-1" },
				{ toEntityId: "ent-1" },
			])
			expect(relFilter.agentId).toBe("agent-1")
		})
	})

	describe("expandGraph bidirectional", () => {
		it("backward compatible: bidirectional defaults to false (no $facet)", async () => {
			const rootEntity = makeEntity()
			const entitiesCol = createMockCollection()
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(rootEntity)

			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			})

			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
			})

			// Should NOT use $facet when bidirectional is not set
			const [pipeline] = (relationsCol.aggregate as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			const facetStage = pipeline.find((s: Document) => s.$facet)
			expect(facetStage).toBeUndefined()
		})

		it("bidirectional=true uses $facet for parallel traversal", async () => {
			const rootEntity = makeEntity()
			const entitiesCol = createMockCollection()
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(rootEntity)

			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([{ forward: [], reverse: [] }]),
				}),
			})

			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
				bidirectional: true,
			})

			// Should use $facet when bidirectional=true
			const [pipeline] = (relationsCol.aggregate as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			const facetStage = pipeline.find((s: Document) => s.$facet)
			expect(facetStage).toBeDefined()
			expect(facetStage.$facet.forward).toBeDefined()
			expect(facetStage.$facet.reverse).toBeDefined()
		})

		it("maxConnections limits total connections returned", async () => {
			const rootEntity = makeEntity()
			const entities = Array.from({ length: 10 }, (_, i) =>
				makeEntity({
					entityId: `ent-${i + 2}`,
					name: `Entity${i + 2}`,
					type: "project",
				}),
			)

			const entitiesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue(entities),
				}),
			})
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(rootEntity)

			// Create 10 forward relations
			const forwardRels = entities.map((e) => ({
				fromEntityId: "ent-1",
				toEntityId: e.entityId,
				type: "works_on",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date("2026-01-01"),
				transitiveRelations: [],
			}))

			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue(forwardRels),
				}),
			})

			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
				maxConnections: 5,
			})

			expect(result).not.toBeNull()
			expect(result?.connections.length).toBeLessThanOrEqual(5)
		})

		it("orders connections by depth and relation quality before truncation", async () => {
			const rootEntity = makeEntity()
			const entities = [
				makeEntity({ entityId: "ent-2", name: "RelatedDoc", type: "document" }),
				makeEntity({ entityId: "ent-3", name: "ProjectX", type: "project" }),
				makeEntity({ entityId: "ent-4", name: "DependencyY", type: "project" }),
			]

			const entitiesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue(entities),
				}),
			})
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(rootEntity)

			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([
						{
							fromEntityId: "ent-1",
							toEntityId: "ent-2",
							type: "mentioned_with",
							weight: 0.2,
							agentId: "agent-1",
							scope: "agent",
							updatedAt: new Date("2026-01-03"),
							transitiveRelations: [],
						},
						{
							fromEntityId: "ent-1",
							toEntityId: "ent-3",
							type: "works_on",
							weight: 0.1,
							agentId: "agent-1",
							scope: "agent",
							updatedAt: new Date("2026-01-02"),
							transitiveRelations: [],
						},
						{
							fromEntityId: "ent-1",
							toEntityId: "ent-4",
							type: "depends_on",
							weight: 0.1,
							agentId: "agent-1",
							scope: "agent",
							updatedAt: new Date("2026-01-01"),
							transitiveRelations: [
								{
									fromEntityId: "ent-3",
									toEntityId: "ent-4",
									type: "depends_on",
									depth: 0,
								},
							],
						},
					]),
				}),
			})

			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
				maxConnections: 2,
			})

			expect(result).not.toBeNull()
			expect(result?.connections).toHaveLength(2)
			expect(result?.connections[0]?.entity.name).toBe("ProjectX")
			expect(result?.connections[1]?.entity.name).toBe("DependencyY")
		})

		it("deduplicates connections from forward and reverse traversal", async () => {
			const rootEntity = makeEntity()
			const connectedEntity = makeEntity({
				entityId: "ent-2",
				name: "ProjectX",
				type: "project",
			})

			const entitiesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([connectedEntity]),
				}),
			})
			;(entitiesCol as unknown as Record<string, unknown>).findOne = vi
				.fn()
				.mockResolvedValue(rootEntity)

			// Same relation appears in both forward and reverse
			const facetResult = {
				forward: [
					{
						fromEntityId: "ent-1",
						toEntityId: "ent-2",
						type: "works_on",
						agentId: "agent-1",
						scope: "agent",
						updatedAt: new Date("2026-01-01"),
						transitiveRelations: [],
					},
				],
				reverse: [
					{
						fromEntityId: "ent-1",
						toEntityId: "ent-2",
						type: "works_on",
						agentId: "agent-1",
						scope: "agent",
						updatedAt: new Date("2026-01-01"),
						transitiveRelations: [],
					},
				],
			}

			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([facetResult]),
				}),
			})

			const db = createMockDb({
				[`${PREFIX}entities`]: entitiesCol,
				[`${PREFIX}relations`]: relationsCol,
			})

			const result = await expandGraph({
				db,
				prefix: PREFIX,
				entityId: "ent-1",
				agentId: "agent-1",
				bidirectional: true,
			})

			expect(result).not.toBeNull()
			// Same relation in forward and reverse should be deduped
			expect(result?.connections).toHaveLength(1)
			expect(result?.connections[0]?.entity.entityId).toBe("ent-2")
		})
	})

	describe("error handling", () => {
		it("upsertEntity wraps and re-throws errors", async () => {
			const entitiesCol = createMockCollection({
				updateOne: vi.fn().mockRejectedValue(new Error("db write failed")),
			})
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })

			await expect(
				upsertEntity({ db, prefix: PREFIX, entity: makeEntity() }),
			).rejects.toThrow("db write failed")
		})

		it("deleteEntity wraps and re-throws errors", async () => {
			const entitiesCol = createMockCollection({
				deleteOne: vi.fn().mockRejectedValue(new Error("db delete failed")),
			})
			const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol })

			await expect(
				deleteEntity({
					db,
					prefix: PREFIX,
					entityId: "ent-1",
					agentId: "agent-1",
				}),
			).rejects.toThrow("db delete failed")
		})
	})

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
					candidateOp!.updateOne.update as Record<
						string,
						Record<string, unknown>
					>
				).$set.status,
			).toBe("active")
			expect(
				(
					candidateOp!.updateOne.update as Record<
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
			it("uses $inc mentionCount:1 in bulkWrite entity upserts", async () => {
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
					sourceEventId: "ev1",
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
				const addToSet = graceOp!.updateOne.update.$addToSet as Record<
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
				const addToSet = aliceOp!.updateOne.update.$addToSet as
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
				})

				const pipeline = (entCol.aggregate as ReturnType<typeof vi.fn>).mock
					.calls[0][0] as Document[]
				const limitStage = pipeline.find((s: Document) => "$limit" in s)
				expect(limitStage).toBeDefined()
				expect(limitStage!.$limit).toBe(10)
			})
		})
	})
})
