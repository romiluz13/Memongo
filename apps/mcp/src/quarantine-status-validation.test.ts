import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MemongoClient } from "@memongo/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createMemongoServer, handleToolCall } from "./server.js"

const error = "status must be pending-review|promoting|promoted|rejected"
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})
describe("MCP quarantine-list status validation", () => {
	it.each([
		{ value: null },
		{ value: 42 },
		{ value: false },
		{ value: [] },
		{ value: {} },
		{ value: "" },
		{ value: "archived" },
		{ value: " pending-review" },
		{ value: "Pending-Review" },
	])("rejects explicit invalid status before the client call (%#)", async ({
		value,
	}) => {
		const client = new MemongoClient({
			baseUrl: "https://fixture.invalid",
			apiKey: "fixture",
		})
		const list = vi.spyOn(client, "listQuarantined").mockResolvedValue([])
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("unexpected fetch"))
		const result = await handleToolCall(
			"memongo_quarantine_list",
			{ status: value },
			client,
		)
		expect(result.isError).toBe(true)
		expect(result.structuredContent).toEqual({ error })
		expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({ error })
		expect(list).not.toHaveBeenCalled()
		expect(fetch).not.toHaveBeenCalled()
	})
	it.each([
		"pending-review",
		"promoting",
		"promoted",
		"rejected",
	] as const)("forwards valid %s unchanged", async (status) => {
		const client = new MemongoClient({
			baseUrl: "https://fixture.invalid",
			apiKey: "fixture",
		})
		const list = vi.spyOn(client, "listQuarantined").mockResolvedValue([])
		const result = await handleToolCall(
			"memongo_quarantine_list",
			{ status, agentId: "agent", limit: 5 },
			client,
		)
		expect(result.isError).not.toBe(true)
		expect(list).toHaveBeenCalledExactlyOnceWith({
			status,
			agentId: "agent",
			limit: 5,
		})
	})
	it("preserves omitted status as an all-stage request", async () => {
		const client = new MemongoClient({
			baseUrl: "https://fixture.invalid",
			apiKey: "fixture",
		})
		const list = vi.spyOn(client, "listQuarantined").mockResolvedValue([])
		const result = await handleToolCall("memongo_quarantine_list", {}, client)
		expect(result.isError).not.toBe(true)
		expect(list).toHaveBeenCalledExactlyOnceWith({
			status: undefined,
			agentId: undefined,
			limit: undefined,
		})
	})
	it("validates status through the installed SDK in-memory call path", async () => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "1")
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response("[]", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		)
		const server = createMemongoServer("admin")
		const client = new Client({
			name: "quarantine-status-fixture",
			version: "0",
		})
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair()
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		])
		try {
			const tools = await client.listTools()
			expect(
				tools.tools.find((tool) => tool.name === "memongo_quarantine_list")
					?.inputSchema.properties,
			).toEqual(
				expect.objectContaining({
					status: {
						type: "string",
						enum: ["pending-review", "promoting", "promoted", "rejected"],
					},
				}),
			)
			for (const status of [42, "archived"]) {
				const result = await client.callTool({
					name: "memongo_quarantine_list",
					arguments: { status },
				})
				expect(result.isError).toBe(true)
				expect(result.structuredContent).toEqual({ error })
			}
			expect(fetch).not.toHaveBeenCalled()
			const valid = await client.callTool({
				name: "memongo_quarantine_list",
				arguments: { status: "promoting", agentId: "agent" },
			})
			expect(valid.isError).not.toBe(true)
			expect(fetch).toHaveBeenCalledTimes(1)
			const [url, options] = fetch.mock.calls[0] ?? []
			expect(new URL(String(url)).searchParams.get("status")).toBe("promoting")
			expect(new URL(String(url)).searchParams.get("agentId")).toBe("agent")
			expect(options?.method).toBe("GET")
			fetch.mockClear()
			const omitted = await client.callTool({
				name: "memongo_quarantine_list",
				arguments: {},
			})
			expect(omitted.isError).not.toBe(true)
			expect(fetch).toHaveBeenCalledTimes(1)
			expect(
				new URL(String(fetch.mock.calls[0]?.[0])).searchParams.has("status"),
			).toBe(false)
		} finally {
			await client.close()
			await server.close()
		}
	})
})
