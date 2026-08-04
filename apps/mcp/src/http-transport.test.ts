import type { Server as NodeHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_MCP_HTTP_PORT,
	MCP_HTTP_PATH,
	startHttpTransport,
} from "./http-transport.js"
import { createMemongoServer } from "./server.js"

const MCP_PROTOCOL_VERSION = "2025-03-26"

let runningServer: NodeHttpServer | undefined

async function startOnEphemeralPort(): Promise<number> {
	runningServer = await startHttpTransport({
		createMcpServer: createMemongoServer,
		host: "127.0.0.1",
		port: 0,
	})
	const address = runningServer.address() as AddressInfo
	return address.port
}

async function postMcp(
	port: number,
	body: Record<string, unknown>,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${MCP_HTTP_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	})
}

afterEach(async () => {
	vi.unstubAllEnvs()
	if (runningServer) {
		await new Promise<void>((resolve) => {
			runningServer?.close(() => resolve())
		})
		runningServer = undefined
	}
})

describe("streamable HTTP transport", () => {
	it("answers the MCP initialize handshake over HTTP", async () => {
		const port = await startOnEphemeralPort()

		const response = await postMcp(port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "vitest-handshake", version: "0.0.0" },
			},
		})

		expect(response.status).toBe(200)
		const payload = (await response.json()) as {
			jsonrpc: string
			id: number
			result: {
				protocolVersion: string
				serverInfo: { name: string; version: string }
				capabilities: Record<string, unknown>
			}
		}
		expect(payload.jsonrpc).toBe("2.0")
		expect(payload.id).toBe(1)
		expect(typeof payload.result.protocolVersion).toBe("string")
		expect(payload.result.serverInfo.name).toBe("memongo")
		expect(payload.result.capabilities).toHaveProperty("tools")
	})

	it("serves tools/list over HTTP after initialize", async () => {
		const port = await startOnEphemeralPort()

		const initResponse = await postMcp(port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "vitest-tools", version: "0.0.0" },
			},
		})
		expect(initResponse.status).toBe(200)
		await initResponse.arrayBuffer()

		const listResponse = await postMcp(port, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		})

		expect(listResponse.status).toBe(200)
		const payload = (await listResponse.json()) as {
			result: { tools: Array<{ name: string }> }
		}
		const names = payload.result.tools.map((tool) => tool.name)
		expect(names).toContain("memongo_recall_conversation")
		expect(names).toContain("memongo_write_event")
	})

	it("gates admin and alias tools behind env flags (P1.2)", async () => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "")
		const port = await startOnEphemeralPort()

		const initResponse = await postMcp(port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "vitest-flags", version: "0.0.0" },
			},
		})
		expect(initResponse.status).toBe(200)
		await initResponse.arrayBuffer()

		const listResponse = await postMcp(port, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		})
		const listPayload = (await listResponse.json()) as {
			result: { tools: Array<{ name: string }> }
		}
		const names = listPayload.result.tools.map((tool) => tool.name)
		expect(names).toContain("memongo_extract")
		expect(names).not.toContain("memongo_status")
		expect(names).not.toContain("memongo_recall_messages")

		// Gated tools are rejected before the API client is ever called.
		const callResponse = await postMcp(port, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "memongo_status", arguments: {} },
		})
		expect(callResponse.status).toBe(200)
		const callPayload = (await callResponse.json()) as {
			result: { isError?: boolean }
		}
		expect(callPayload.result.isError).toBe(true)
	})

	it("exposes admin tools when MEMONGO_MCP_ADMIN=1 (P1.2)", async () => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "1")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "")
		const port = await startOnEphemeralPort()

		const initResponse = await postMcp(port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "vitest-flags-admin", version: "0.0.0" },
			},
		})
		expect(initResponse.status).toBe(200)
		await initResponse.arrayBuffer()

		const listResponse = await postMcp(port, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		})
		const listPayload = (await listResponse.json()) as {
			result: { tools: Array<{ name: string }> }
		}
		const names = listPayload.result.tools.map((tool) => tool.name)
		expect(names).toContain("memongo_status")
		expect(names).not.toContain("memongo_relevance_benchmark")
		expect(names).not.toContain("memongo_benchmark_ingest")
		expect(names).not.toContain("memongo_recall_messages")
	})

	it("returns 404 for non-MCP paths", async () => {
		const port = await startOnEphemeralPort()

		const response = await fetch(`http://127.0.0.1:${port}/nope`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		})

		expect(response.status).toBe(404)
	})

	it("exposes a default HTTP port that does not collide with api/web", () => {
		expect(DEFAULT_MCP_HTTP_PORT).toBe(3110)
	})
})
