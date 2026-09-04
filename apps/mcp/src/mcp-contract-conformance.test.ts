/**
 * MCP contract conformance (B2a): the MCP tool surface must match the single
 * contract source (@memongo/lib) exactly. Every tool named in the /v1 route
 * table has a declared field set, every live tool's inputSchema properties
 * equal that declared set (no missing fields, no invented fields), and no
 * live tool is undeclared. Deleting any optional field from a tool schema —
 * or adding an undocumented one — fails this test.
 */
import {
	CHAIN_TRACE_COLLECTION_VALUES,
	CONTEXT_BUNDLE_MODE_VALUES,
	MEMORY_SCOPE_VALUES,
	MEMONGO_API_ROUTES,
	MEMONGO_MCP_TOOL_FIELDS,
} from "@memongo/lib"
import { describe, expect, it } from "vitest"
import { toolCatalog } from "./tool-registry.js"

function declaredToolNames(): Set<string> {
	return new Set(Object.keys(MEMONGO_MCP_TOOL_FIELDS))
}

describe("MCP contract conformance: tool schemas vs contract field sets", () => {
	it("declares a field set for every tool the route table serves", () => {
		const declared = declaredToolNames()
		const missing: string[] = []
		for (const route of MEMONGO_API_ROUTES) {
			for (const tool of route.tools) {
				if (!declared.has(tool)) {
					missing.push(
						`${route.path}: tool "${tool}" has no declared field set`,
					)
				}
			}
		}
		expect(missing).toEqual([])
	})

	it("every declared tool exists in the live catalog (no phantom entries)", () => {
		const live = new Set(toolCatalog.map((tool) => tool.name))
		const phantom = [...declaredToolNames()].filter((name) => !live.has(name))
		expect(phantom).toEqual([])
	})

	it("every live tool is declared in the contract (no orphan tools)", () => {
		const declared = declaredToolNames()
		const orphans = toolCatalog
			.map((tool) => tool.name)
			.filter((name) => !declared.has(name))
		expect(orphans).toEqual([])
	})

	it("live tool input schemas match the declared field sets exactly", () => {
		const failures: string[] = []
		for (const tool of toolCatalog) {
			const declared = MEMONGO_MCP_TOOL_FIELDS[tool.name]
			if (!declared) {
				continue
			}
			const actual = Object.keys(tool.inputSchema.properties ?? {})
			const missing = declared.filter((field) => !actual.includes(field))
			const invented = actual.filter(
				(field) => !(declared as readonly string[]).includes(field),
			)
			if (missing.length > 0) {
				failures.push(`${tool.name}: missing fields ${JSON.stringify(missing)}`)
			}
			if (invented.length > 0) {
				failures.push(
					`${tool.name}: undeclared fields ${JSON.stringify(invented)}`,
				)
			}
		}
		expect(failures).toEqual([])
	})
})

describe("MCP contract conformance: enum single-sourcing (WS-08)", () => {
	/** Minimal structural view of an MCP JSON-schema inputSchema. */
	type SchemaProperty = {
		type?: string
		enum?: unknown[]
		properties?: Record<string, SchemaProperty>
	}
	type ToolSchema = { properties?: Record<string, SchemaProperty> }

	function toolSchema(name: string): ToolSchema | undefined {
		const tool = toolCatalog.find((candidate) => candidate.name === name)
		return tool ? (tool.inputSchema as ToolSchema) : undefined
	}

	it("build_context_bundle mode enum equals the lib contract set (C-013)", () => {
		const mode = toolSchema("memongo_build_context_bundle")?.properties?.mode
		expect(mode?.enum).toEqual([...CONTEXT_BUNDLE_MODE_VALUES])
	})

	it("chain_trace collection enum equals the lib contract set (C-015)", () => {
		const collection = toolSchema("memongo_chain_trace")?.properties?.collection
		expect(collection?.enum).toEqual([...CHAIN_TRACE_COLLECTION_VALUES])
	})

	it("scope enums still equal the lib contract set (P2.2 regression guard)", () => {
		const failures: string[] = []
		for (const tool of toolCatalog) {
			const scope = (tool.inputSchema as ToolSchema)?.properties?.scope
			if (scope?.enum) {
				const expected = [...MEMORY_SCOPE_VALUES]
				if (JSON.stringify(scope.enum) !== JSON.stringify(expected)) {
					failures.push(tool.name)
				}
			}
		}
		expect(failures).toEqual([])
	})

	it("write_structured entry.type is an open string, not a closed enum (B6)", () => {
		const entry = toolSchema("memongo_write_structured")?.properties?.entry
		const type = entry?.properties?.type
		// The API validates the full supported set server-side
		// (structuredEntrySchema); a closed MCP-side enum would silently
		// block every future entry type the API already accepts.
		expect(type?.enum).toBeUndefined()
		expect(type?.type).toBe("string")
	})
})
