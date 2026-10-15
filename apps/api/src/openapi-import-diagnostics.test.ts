import { describe, expect, it } from "vitest"
import { searchPaths } from "./openapi-paths-search.js"

// The engine importer returns these three diagnostics on every import.
describe("POST /v1/import/conversations response schema", () => {
	it("documents the engine's rejection diagnostics", () => {
		const schema =
			searchPaths["/v1/import/conversations"].post.responses["200"].content[
				"application/json"
			].schema
		expect(schema.properties.rejectedTurns).toEqual({ type: "integer" })
		expect(schema.properties.rejectedConversations).toEqual({ type: "integer" })
		const item = schema.properties.rejections.items
		expect(item.required).toEqual([
			"line",
			"conversationIndex",
			"turnIndex",
			"reason",
		])
		expect(item.properties.line).toEqual({ type: "integer", nullable: true })
		expect(item.properties.turnIndex).toEqual({
			type: "integer",
			nullable: true,
		})
		expect(item.properties.reason.enum).toEqual([
			"conversation-not-object",
			"turns-not-array",
			"no-valid-turns",
			"turn-not-object",
			"invalid-role",
			"empty-body",
			"invalid-timestamp",
		])
	})
})
