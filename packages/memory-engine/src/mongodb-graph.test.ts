/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"

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
	type Entity,
	type Relation,
} from "./mongodb-graph.js"

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
		it("uses one majority transaction for relation identity and exclusivity", async () => {
			const relationsCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })
			const withTransaction = vi.fn(async (fn: () => Promise<void>) => fn())
			const session = { withTransaction, endSession: vi.fn(async () => {}) }
			const client = { startSession: vi.fn(() => session) }

			await upsertRelation({
				db,
				prefix: PREFIX,
				relation: makeRelation(),
				client: client as unknown as import("mongodb").MongoClient,
			})

			expect(withTransaction).toHaveBeenCalledWith(expect.any(Function), {
				writeConcern: { w: "majority", wtimeoutMS: 5000 },
			})
			expect(relationsCol.findOne).toHaveBeenCalledWith(expect.any(Object), {
				session,
			})
			expect(relationsCol.updateOne).toHaveBeenCalledWith(
				expect.any(Object),
				expect.any(Object),
				{ upsert: true, session },
			)
			expect(session.endSession).toHaveBeenCalledOnce()
		})

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

		it("persists a relationId locator field as fromEntityId-toEntityId (P3.8)", async () => {
			const relationsCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })

			await upsertRelation({
				db,
				prefix: PREFIX,
				relation: makeRelation(),
			})

			const [, update] = (relationsCol.updateOne as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(update.$set.relationId).toBe("ent-1-ent-2")
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
				eventReceiptIds: ["evt-replayed"],
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

		it("does not replay the destructive owns-invalidation side effect for the same source event, but still applies field updates", async () => {
			const relationsCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue({
					fromEntityId: "ent-bob",
					toEntityId: "ent-phoenix",
					type: "owns",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					state: "active",
					sourceEventIds: ["evt-replayed"],
				}),
				updateOne: vi.fn().mockResolvedValue({
					upsertedCount: 0,
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
					sourceEventIds: ["evt-replayed"],
					weight: 0.9,
				}),
			})

			// The destructive owns-invalidation (updateMany) is NOT replayed.
			expect(relationsCol.updateMany).not.toHaveBeenCalled()
			// But the field update (updateOne) IS applied — the same sourceEventIds
			// with a changed weight must not be silently dropped.
			expect(relationsCol.updateOne).toHaveBeenCalled()
			const [, update] = (relationsCol.updateOne as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(update.$set.weight).toBe(0.9)
			// ...and reinforcement is NOT bumped: reinforcementCount counts the
			// distinct events that confirmed the relation, and this event was
			// already counted. It feeds retrieval scoring, so incrementing on a
			// replay would inflate the ranking of duplicated evidence.
			expect(update.$inc).toBeUndefined()
		})

		it("accumulates source-event evidence when a new event confirms a relation", async () => {
			const relationsCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue({
					fromEntityId: "ent-1",
					toEntityId: "ent-2",
					type: "works_on",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					state: "active",
					sourceEventIds: ["evt-first"],
				}),
			})
			const db = createMockDb({ [`${PREFIX}relations`]: relationsCol })

			await upsertRelation({
				db,
				prefix: PREFIX,
				relation: makeRelation({ sourceEventIds: ["evt-second"] }),
			})

			const update = vi.mocked(relationsCol.updateOne).mock.calls[0]?.[1]
			expect(update?.$set.sourceEventIds).toEqual(["evt-first", "evt-second"])
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

		it("bidirectional=true uses two separate aggregations for forward + reverse", async () => {
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
				bidirectional: true,
			})

			// Bidirectional should issue two separate aggregate calls (forward +
			// reverse), NOT a $facet — $facet has a 100MB per-branch limit with
			// no spill to disk, which a large graph can exceed.
			const aggregateCalls = (
				relationsCol.aggregate as ReturnType<typeof vi.fn>
			).mock.calls
			expect(aggregateCalls).toHaveLength(2)
			// Each pipeline should contain a $graphLookup (not $facet)
			for (const [pipeline] of aggregateCalls) {
				const hasGraphLookup = pipeline.some((s: Document) => s.$graphLookup)
				expect(hasGraphLookup).toBe(true)
				const hasFacet = pipeline.some((s: Document) => s.$facet)
				expect(hasFacet).toBe(false)
			}
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

			// Same relation appears in both forward and reverse. With two separate
			// aggregations (no $facet), the first call returns forward, the second
			// returns reverse.
			const forwardRel = {
				fromEntityId: "ent-1",
				toEntityId: "ent-2",
				type: "works_on",
				agentId: "agent-1",
				scope: "agent",
				updatedAt: new Date("2026-01-01"),
				transitiveRelations: [],
			}
			const reverseRel = { ...forwardRel }

			let aggregateCallCount = 0
			const relationsCol = createMockCollection({
				aggregate: vi.fn().mockImplementation(() => {
					aggregateCallCount++
					return {
						toArray: vi
							.fn()
							.mockResolvedValue(
								aggregateCallCount === 1 ? [forwardRel] : [reverseRel],
							),
					}
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
})
