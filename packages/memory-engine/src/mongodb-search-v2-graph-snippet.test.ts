import { describe, expect, it } from "vitest"
import { renderGraphRelationSnippet } from "./mongodb-search-v2.js"
import type { Entity, Relation } from "./mongodb-graph.js"

const root: Entity = {
	entityId: "entity-root",
	name: "Phoenix",
	type: "project",
	agentId: "agent-1",
	scope: "agent",
	updatedAt: new Date("2026-04-05T00:00:00.000Z"),
}

const neighbor: Entity = {
	entityId: "entity-neighbor",
	name: "Atlas Local",
	type: "system",
	agentId: "agent-1",
	scope: "agent",
	updatedAt: new Date("2026-04-05T00:00:00.000Z"),
}

const hop2: Entity = {
	entityId: "entity-hop2",
	name: "Preview Validation",
	type: "feature",
	agentId: "agent-1",
	scope: "agent",
	updatedAt: new Date("2026-04-05T00:00:00.000Z"),
}

function relation(
	fromEntityId: string,
	toEntityId: string,
	type: Relation["type"],
): Relation {
	return {
		fromEntityId,
		toEntityId,
		type,
		agentId: "agent-1",
		scope: "agent",
		updatedAt: new Date("2026-04-05T00:00:00.000Z"),
	}
}

describe("renderGraphRelationSnippet (RET-05)", () => {
	it("renders outgoing root edges as root TYPE neighbor", () => {
		const snippet = renderGraphRelationSnippet(
			{
				entity: neighbor,
				relation: relation("entity-root", "entity-neighbor", "blocked_by"),
				depth: 1,
				fromEntity: root,
				toEntity: neighbor,
			},
			{ entityId: root.entityId, name: root.name },
		)
		expect(snippet).toBe("Phoenix blocked_by Atlas Local")
	})

	it("renders incoming edges with the neighbor as the subject", () => {
		// The RET-05 defect: the old template rendered
		// "Phoenix blocked_by Atlas Local" for this edge too, asserting the
		// reverse of the stored relation.
		const snippet = renderGraphRelationSnippet(
			{
				entity: neighbor,
				relation: relation("entity-neighbor", "entity-root", "blocked_by"),
				depth: 1,
				fromEntity: neighbor,
				toEntity: root,
			},
			{ entityId: root.entityId, name: root.name },
		)
		expect(snippet).toBe("Atlas Local blocked_by Phoenix")
	})

	it("renders multi-hop edges between non-root endpoints with traversal context", () => {
		const snippet = renderGraphRelationSnippet(
			{
				entity: hop2,
				relation: relation("entity-neighbor", "entity-hop2", "depends_on"),
				depth: 2,
				fromEntity: neighbor,
				toEntity: hop2,
			},
			{ entityId: root.entityId, name: root.name },
		)
		// Neither endpoint is the root: assert the actual edge plus an
		// "observed near" note instead of a false root assertion.
		expect(snippet).toBe(
			"Atlas Local depends_on Preview Validation (observed near Phoenix, 2-hop)",
		)
	})

	it("asserts nothing directional when an endpoint is dangling", () => {
		const snippet = renderGraphRelationSnippet(
			{
				entity: neighbor,
				relation: relation("entity-dangling", "entity-neighbor", "blocked_by"),
				depth: 1,
				// fromEntity unresolved (dangling), toEntity resolved.
				toEntity: neighbor,
			},
			{ entityId: root.entityId, name: root.name },
		)
		expect(snippet).toBe("Atlas Local (blocked_by)")
	})
})
