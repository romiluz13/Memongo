import { adminTools } from "./tools/admin.js"
import { aliasTools } from "./tools/aliases.js"
import { coreTools } from "./tools/core.js"

// P1.2: the MCP surface is partitioned into three categories so hosts only pay
// prompt tokens for the core write/recall loop by default.
// - core: always registered.
// - admin: operator tooling, requires MEMONGO_MCP_ADMIN=1.
// - alias: semantic duplicates of canonical tools, requires MEMONGO_MCP_ALIASES=1.
export type McpToolCategory = "core" | "admin" | "alias"

export type McpToolInputSchema = {
	type: string
	properties?: Record<string, unknown>
	required?: readonly string[]
}

export type McpToolDefinition = {
	name: string
	description: string
	inputSchema: McpToolInputSchema
	category: McpToolCategory
}

/** Tool shape served over the wire (category is server-internal metadata). */
export type McpWireTool = {
	name: string
	description: string
	inputSchema: McpToolInputSchema
}

export const toolCatalog: readonly McpToolDefinition[] = [
	...coreTools,
	...adminTools,
	...aliasTools,
]

// Mirrors apps/api parseBoolEnv: "1" | "true" | "yes" (case-insensitive).
function parseBoolEnv(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase()
	return value === "1" || value === "true" || value === "yes"
}

export type McpToolFlags = {
	admin: boolean
	aliases: boolean
}

export type McpToolEnv = {
	MEMONGO_MCP_ADMIN?: string | undefined
	MEMONGO_MCP_ALIASES?: string | undefined
}

export function parseMcpToolFlags(env: McpToolEnv): McpToolFlags {
	return {
		admin: parseBoolEnv(env.MEMONGO_MCP_ADMIN),
		aliases: parseBoolEnv(env.MEMONGO_MCP_ALIASES),
	}
}

export function selectEnabledTools(env: McpToolEnv): McpToolDefinition[] {
	const flags = parseMcpToolFlags(env)
	return toolCatalog.filter(
		(tool) =>
			tool.category === "core" ||
			(tool.category === "admin" && flags.admin) ||
			(tool.category === "alias" && flags.aliases),
	)
}

export function toWireTool(definition: McpToolDefinition): McpWireTool {
	return {
		name: definition.name,
		description: definition.description,
		inputSchema: definition.inputSchema,
	}
}
