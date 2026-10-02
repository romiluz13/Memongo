import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createMemongoServer } from "./server.js"
import type { McpAuthScope } from "./auth.js"

const aliases = [
	"memongo_memory_get",
	"memongo_memory_update",
	"memongo_memory_delete",
	"memongo_memory_history",
	"memongo_import_conversation_history",
]
afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

async function withClient(
	scope: McpAuthScope,
	run: (client: Client) => Promise<void>,
) {
	const server = createMemongoServer(scope)
	const client = new Client({ name: "alias-authority-test", version: "0" })
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair()
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	])
	try {
		await run(client)
	} finally {
		await client.close()
		await server.close()
	}
}

describe("canonical alias authority", () => {
	it.each([
		"standard",
		"admin",
		"local",
	] as const)("requires the admin flag for admin aliases in %s scope", async (scope) => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "1")
		const network = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => {
				throw new Error("Unexpected network")
			})
		await withClient(scope, async (client) => {
			const { tools } = await client.listTools()
			for (const name of aliases) {
				expect(tools.map((tool) => tool.name)).not.toContain(name)
				const result = await client.callTool({ name, arguments: {} })
				expect(result.isError).toBe(true)
				expect(JSON.stringify(result)).toContain("not enabled")
			}
			expect(tools.map((tool) => tool.name)).toContain("memongo_search")
			expect(tools.map((tool) => tool.name)).toContain(
				"memongo_recall_messages",
			)
		})
		expect(network).not.toHaveBeenCalled()
	})
	it("standard scope cannot list or call admin aliases when both flags are on", async () => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "1")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "1")
		const network = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => {
				throw new Error("Unexpected network")
			})
		await withClient("standard", async (client) => {
			const { tools } = await client.listTools()
			expect(tools.map((tool) => tool.name)).toContain(
				"memongo_recall_messages",
			)
			for (const name of aliases) {
				expect(tools.map((tool) => tool.name)).not.toContain(name)
				const result = await client.callTool({ name, arguments: {} })
				expect(result.isError).toBe(true)
				expect(JSON.stringify(result)).toContain("not enabled")
			}
		})
		expect(network).not.toHaveBeenCalled()
	})
	it.each([
		"admin",
		"local",
	] as const)("retains aliases for %s with both flags", async (scope) => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "1")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "1")
		await withClient(scope, async (client) => {
			const { tools } = await client.listTools()
			for (const name of aliases)
				expect(tools.map((tool) => tool.name)).toContain(name)
			expect(tools.map((tool) => tool.name)).toContain(
				"memongo_recall_messages",
			)
			for (const tool of tools) {
				expect(tool).not.toHaveProperty("canonical")
				expect(tool).not.toHaveProperty("category")
			}
		})
	})
})
