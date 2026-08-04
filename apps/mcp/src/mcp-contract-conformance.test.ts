/**
 * MCP contract conformance (B2a): the MCP tool surface must match the single
 * contract source (@memongo/lib) exactly. Every tool named in the /v1 route
 * table has a declared field set, every live tool's inputSchema properties
 * equal that declared set (no missing fields, no invented fields), and no
 * live tool is undeclared. Deleting any optional field from a tool schema —
 * or adding an undocumented one — fails this test.
 */
import { MEMONGO_API_ROUTES, MEMONGO_MCP_TOOL_FIELDS } from "@memongo/lib"
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
