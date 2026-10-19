// M2 T13 (#120): the graph reads and deletes confine themselves to the full
// tenant (agentId, scope, scopeRef). A document of another scopeRef that shares
// the agent and the entity id is never read, counted, changed or deleted, and a
// call without the full identity fails typed before any collection is touched.
import type { Db, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	deleteEntity,
	deleteEntityConservative,
	expandGraph,
	findEntitiesByName,
	getEntitiesByType,
	getEntityLinks,
	setEntityLinkStatus,
} from "./mongodb-graph.js"
import { TenantIdentityRequiredError } from "./mongodb-tenant-identity.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const MINE = { scope: "workspace", scopeRef: "workspace:mine" } as const
const THEIRS = { scope: "workspace", scopeRef: "workspace:theirs" } as const

function entity(tenant: Document, entityId = "ent-1"): Document {
	return {
		agentId: AGENT_ID,
		...tenant,
		entityId,
		name: `name of ${entityId}`,
		type: "person",
		aliases: [],
		updatedAt: new Date(),
	}
}

function relation(tenant: Document): Document {
	return {
		agentId: AGENT_ID,
		...tenant,
		fromEntityId: "ent-1",
		toEntityId: "ent-2",
		type: "knows",
		state: "active",
		updatedAt: new Date(),
	}
}

function link(tenant: Document): Document {
	return {
		agentId: AGENT_ID,
		...tenant,
		fromEntityId: "ent-1",
		toEntityId: "ent-2",
		linkType: "same_as",
		status: "suggested",
		confidence: 0.9,
		updatedAt: new Date(),
	}
}

async function seeded() {
	const fake = createStatefulMongoFake({ prefix: PREFIX })
	await fake.collection("entities").insertMany([entity(MINE), entity(THEIRS)])
	await fake
		.collection("relations")
		.insertMany([relation(MINE), relation(THEIRS)])
	await fake.collection("entity_links").insertMany([link(MINE), link(THEIRS)])
	return { fake, db: fake.db as unknown as Db }
}

const idOf = (tenant: { scopeRef: string }) => tenant.scopeRef

describe("graph reads stay inside the tenant", () => {
	it("getEntitiesByType returns only the tenant's entities", async () => {
		const { db } = await seeded()

		const found = await getEntitiesByType({
			db,
			prefix: PREFIX,
			type: "person",
			agentId: AGENT_ID,
			...MINE,
		})

		expect(found.map((doc) => doc.scopeRef)).toEqual([idOf(MINE)])
	})

	it("getEntityLinks returns only the tenant's links", async () => {
		const { db } = await seeded()

		const found = await getEntityLinks({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			entityId: "ent-1",
			...MINE,
		})

		expect(found.map((doc) => doc.scopeRef)).toEqual([idOf(MINE)])
	})

	it("expandGraph finds no root entity that lives in another scopeRef", async () => {
		const { fake, db } = await seeded()
		await fake.collection("entities").deleteMany({ scopeRef: MINE.scopeRef })

		const expanded = await expandGraph({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			entityId: "ent-1",
			...MINE,
		})

		expect(expanded).toBeNull()
	})
})

describe("graph writes stay inside the tenant", () => {
	it("setEntityLinkStatus changes only the tenant's link", async () => {
		const { fake, db } = await seeded()

		const changed = await setEntityLinkStatus({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			fromEntityId: "ent-1",
			toEntityId: "ent-2",
			linkType: "same_as",
			status: "rejected",
			...MINE,
		})

		expect(changed).toBe(true)
		const statuses = Object.fromEntries(
			fake
				.collection("entity_links")
				.docs.map((doc) => [doc.scopeRef, doc.status]),
		)
		expect(statuses).toEqual({
			[MINE.scopeRef]: "rejected",
			[THEIRS.scopeRef]: "suggested",
		})
	})

	it("deleteEntity removes the entity, its relations and its links in the tenant only", async () => {
		const { fake, db } = await seeded()

		const result = await deleteEntity({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			entityId: "ent-1",
			...MINE,
		})

		expect(result).toEqual({
			deletedEntity: true,
			deletedRelations: 1,
			deletedEntityLinks: 1,
		})
		for (const collection of ["entities", "relations", "entity_links"]) {
			expect(
				fake.collection(collection).docs.map((doc) => doc.scopeRef),
			).toEqual([idOf(THEIRS)])
		}
	})

	it("deleteEntity of an entity that exists only in another scopeRef deletes nothing", async () => {
		const { fake, db } = await seeded()
		await fake.collection("entities").deleteMany({ scopeRef: MINE.scopeRef })

		const result = await deleteEntity({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			entityId: "ent-1",
			scope: "workspace",
			scopeRef: "workspace:nobody",
		})

		expect(result.deletedEntity).toBe(false)
		expect(fake.collection("entities").docs).toHaveLength(1)
		expect(fake.collection("relations").docs).toHaveLength(2)
	})

	it("deleteEntityConservative counts and removes only the tenant's relations", async () => {
		const { fake, db } = await seeded()

		const blocked = await deleteEntityConservative({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			entityId: "ent-1",
			...MINE,
		})
		expect(blocked).toMatchObject({
			conflictDetected: true,
			conflictingRelationCount: 1,
			deletedEntity: false,
		})

		const forced = await deleteEntityConservative({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			entityId: "ent-1",
			force: true,
			...MINE,
		})
		expect(forced).toMatchObject({ deletedEntity: true, deletedRelations: 1 })
		expect(fake.collection("entities").docs.map((doc) => doc.scopeRef)).toEqual(
			[idOf(THEIRS)],
		)
	})
})

describe("a call without the full tenant identity fails typed before any read", () => {
	const untouched = {
		collection: () => {
			throw new Error("a collection was touched")
		},
	} as unknown as Db

	const calls: Array<[string, (identity: Document) => Promise<unknown>]> = [
		[
			"getEntitiesByType",
			(identity) =>
				getEntitiesByType({
					db: untouched,
					prefix: PREFIX,
					type: "person",
					...identity,
				} as never),
		],
		[
			"getEntityLinks",
			(identity) =>
				getEntityLinks({
					db: untouched,
					prefix: PREFIX,
					entityId: "ent-1",
					...identity,
				} as never),
		],
		[
			"findEntitiesByName",
			(identity) =>
				findEntitiesByName({
					db: untouched,
					prefix: PREFIX,
					query: "alice",
					...identity,
				} as never),
		],
		[
			"expandGraph",
			(identity) =>
				expandGraph({
					db: untouched,
					prefix: PREFIX,
					entityId: "ent-1",
					...identity,
				} as never),
		],
		[
			"setEntityLinkStatus",
			(identity) =>
				setEntityLinkStatus({
					db: untouched,
					prefix: PREFIX,
					fromEntityId: "ent-1",
					toEntityId: "ent-2",
					linkType: "same_as",
					status: "rejected",
					...identity,
				} as never),
		],
		[
			"deleteEntity",
			(identity) =>
				deleteEntity({
					db: untouched,
					prefix: PREFIX,
					entityId: "ent-1",
					...identity,
				} as never),
		],
		[
			"deleteEntityConservative",
			(identity) =>
				deleteEntityConservative({
					db: untouched,
					prefix: PREFIX,
					entityId: "ent-1",
					...identity,
				} as never),
		],
	]

	const identities: Array<[string, Document, string[]]> = [
		["no scope", { agentId: AGENT_ID, scopeRef: "workspace:mine" }, ["scope"]],
		["no scopeRef", { agentId: AGENT_ID, scope: "workspace" }, ["scopeRef"]],
		[
			"an empty scopeRef",
			{ agentId: AGENT_ID, scope: "workspace", scopeRef: " " },
			["scopeRef"],
		],
		[
			"an unknown scope",
			{ agentId: AGENT_ID, scope: "galaxy", scopeRef: "x" },
			["scope"],
		],
		[
			"no agentId",
			{ scope: "workspace", scopeRef: "workspace:mine" },
			["agentId"],
		],
	]

	it.each(
		calls.flatMap(([name, call]) =>
			identities.map(([label, identity, missing]) => ({
				name,
				call,
				label,
				identity,
				missing,
			})),
		),
	)("$name with $label", async ({ name, call, identity, missing }) => {
		const failure = await call(identity).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(TenantIdentityRequiredError)
		expect(failure).toMatchObject({ operation: name, missing })
	})
})
