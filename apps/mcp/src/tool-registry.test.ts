import { describe, expect, it } from "vitest"
import {
	parseMcpToolFlags,
	selectEnabledTools,
	toolCatalog,
} from "./tool-registry.js"

// P1.2 surface diet: the catalog is partitioned into core (always on),
// admin (MEMONGO_MCP_ADMIN=1), and semantic aliases
// (MEMONGO_MCP_ALIASES=1). These counts are regression anchors — update them
// deliberately when tools are added, removed, or recategorized.
const CORE_COUNT = 12
// C-003 tenant erasure added memongo_erase_agent (admin category).
// C-004 quarantine review added list/promote/reject (admin category).
const ADMIN_COUNT = 33
const ALIAS_COUNT = 6

const CORE_TOOL_NAMES = [
	"memongo_search",
	"memongo_search_detailed",
	"memongo_add",
	"memongo_write_event",
	"memongo_write_structured",
	"memongo_recall_conversation",
	"memongo_build_context_bundle",
	"memongo_profile",
	"memongo_state_unified",
	"memongo_self_edit",
	"memongo_memory_feedback",
	"memongo_extract",
] as const

describe("parseMcpToolFlags", () => {
	it("treats 1/true/yes (case-insensitive) as enabled", () => {
		for (const raw of ["1", "true", "TRUE", "True", "yes", "YES", " true "]) {
			expect(parseMcpToolFlags({ MEMONGO_MCP_ADMIN: raw }).admin).toBe(true)
			expect(parseMcpToolFlags({ MEMONGO_MCP_ALIASES: raw }).aliases).toBe(true)
		}
	})

	it("treats missing, empty, and other values as disabled", () => {
		for (const raw of [undefined, "", "0", "false", "no", "2"]) {
			expect(parseMcpToolFlags({ MEMONGO_MCP_ADMIN: raw }).admin).toBe(false)
			expect(parseMcpToolFlags({ MEMONGO_MCP_ALIASES: raw }).aliases).toBe(
				false,
			)
		}
	})
})

describe("selectEnabledTools", () => {
	it("defaults to the core tool set only", () => {
		const tools = selectEnabledTools({})
		expect(tools).toHaveLength(CORE_COUNT)
		const names = new Set(tools.map((tool) => tool.name))
		for (const name of CORE_TOOL_NAMES) {
			expect(names.has(name)).toBe(true)
		}
		expect(names.has("memongo_status")).toBe(false)
		expect(names.has("memongo_recall_messages")).toBe(false)
	})

	it("MEMONGO_MCP_ADMIN=1 adds admin tools but not aliases", () => {
		const tools = selectEnabledTools({ MEMONGO_MCP_ADMIN: "1" })
		expect(tools).toHaveLength(CORE_COUNT + ADMIN_COUNT)
		const names = new Set(tools.map((tool) => tool.name))
		expect(names.has("memongo_status")).toBe(true)
		expect(names.has("memongo_relevance_benchmark")).toBe(false)
		expect(names.has("memongo_benchmark_ingest")).toBe(false)
		expect(names.has("memongo_admin_list_traces")).toBe(true)
		expect(names.has("memongo_recall_messages")).toBe(false)
	})

	it("MEMONGO_MCP_ALIASES=1 adds semantic alias tools but not admin tools", () => {
		const tools = selectEnabledTools({ MEMONGO_MCP_ALIASES: "1" })
		expect(tools).toHaveLength(CORE_COUNT + ALIAS_COUNT)
		const names = new Set(tools.map((tool) => tool.name))
		expect(names.has("memongo_recall_messages")).toBe(true)
		expect(names.has("memongo_memory_get")).toBe(true)
		expect(names.has("memongo_memory_history")).toBe(true)
		expect(names.has("memongo_import_conversation_history")).toBe(true)
		expect(names.has("memongo_status")).toBe(false)
	})

	it("both flags expose the full catalog", () => {
		const tools = selectEnabledTools({
			MEMONGO_MCP_ADMIN: "1",
			MEMONGO_MCP_ALIASES: "1",
		})
		expect(toolCatalog).toHaveLength(CORE_COUNT + ADMIN_COUNT + ALIAS_COUNT)
		expect(tools).toHaveLength(toolCatalog.length)
	})
})

describe("input schema guidance (P1.2)", () => {
	const byName = (name: string) => toolCatalog.find((t) => t.name === name)

	const propertyDescriptions = (name: string) => {
		const properties = byName(name)?.inputSchema.properties ?? {}
		return Object.entries(properties).map(([key, value]) => ({
			key,
			description: (value as { description?: unknown }).description,
		}))
	}

	it("memongo_search documents every input field", () => {
		const descriptions = propertyDescriptions("memongo_search")
		expect(descriptions.map((d) => d.key).sort()).toEqual([
			"agentId",
			"limit",
			"minScore",
			"query",
			"scope",
			"scopeRef",
		])
		for (const { description } of descriptions) {
			expect(typeof description).toBe("string")
			expect((description as string).length).toBeGreaterThan(0)
		}
	})

	it("memongo_add documents every input field", () => {
		const descriptions = propertyDescriptions("memongo_add")
		expect(descriptions.map((d) => d.key).sort()).toEqual([
			"agentId",
			"content",
			"customId",
			"expiresAt",
			"metadata",
			"scope",
			"scopeRef",
			"sessionId",
		])
		for (const { description } of descriptions) {
			expect(typeof description).toBe("string")
			expect((description as string).length).toBeGreaterThan(0)
		}
	})

	it("memongo_write_structured spells out the structured entry shape", () => {
		const entry = byName("memongo_write_structured")?.inputSchema.properties
			?.entry as {
			description?: string
			required?: string[]
			properties?: Record<
				string,
				{
					description?: string
					enum?: string[]
					type?: string
				}
			>
		}
		expect(typeof entry.description).toBe("string")
		expect(entry.required).toEqual(["type", "key", "value"])
		// B6 (WS-08): entry.type is an open string matching the API's own
		// structuredEntrySchema — the server validates the supported set, so
		// a closed MCP-side enum would block future entry types.
		expect(entry.properties?.type?.enum).toBeUndefined()
		expect(entry.properties?.type?.type).toBe("string")
		for (const field of ["type", "key", "value"]) {
			expect(typeof entry.properties?.[field]?.description).toBe("string")
		}
	})

	it("memongo_extract requires eventId and documents the write->extract flow", () => {
		const tool = byName("memongo_extract")
		expect(tool).toBeDefined()
		expect(tool?.category).toBe("core")
		expect(tool?.inputSchema.required).toEqual(["eventId"])
		const descriptions = propertyDescriptions("memongo_extract")
		for (const { description } of descriptions) {
			expect(typeof description).toBe("string")
		}
	})
})
