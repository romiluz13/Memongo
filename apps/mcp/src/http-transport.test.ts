import { request as httpRequest } from "node:http"
import type { Server as NodeHttpServer } from "node:http"
import { connect as netConnect } from "node:net"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_MCP_HTTP_PORT,
	MCP_HTTP_PATH,
	startHttpTransport,
	type HttpTransportOptions,
} from "./http-transport.js"
import { createMemongoServer } from "./server.js"

const MCP_PROTOCOL_VERSION = "2025-03-26"

let runningServer: NodeHttpServer | undefined

async function startOnEphemeralPort(
	overrides: Partial<HttpTransportOptions> = {},
): Promise<number> {
	runningServer = await startHttpTransport({
		createMcpServer: createMemongoServer,
		host: "127.0.0.1",
		port: 0,
		...overrides,
	})
	const address = runningServer.address() as AddressInfo
	return address.port
}

async function postMcp(
	port: number,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${MCP_HTTP_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify(body),
	})
}

// node:http (not fetch) for header spoofing: fetch/undici reserves Host.
function rawMcpRequest(
	port: number,
	headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path: MCP_HTTP_PATH,
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
			},
			(res) => {
				let body = ""
				res.on("data", (chunk) => {
					body += chunk
				})
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
			},
		)
		req.on("error", reject)
		req.end("{}")
	})
}

// Raw socket: node:http normalizes empty header values away, so the
// empty-Host regression case needs literal wire bytes.
function rawSocketRequest(
	port: number,
	rawHeaders: string,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const socket = netConnect(port, "127.0.0.1")
		let raw = ""
		socket.on("error", reject)
		socket.on("data", (chunk) => {
			raw += chunk
		})
		socket.on("end", () => {
			const status = Number.parseInt(raw.split(" ")[1] ?? "0", 10)
			resolve({ status, body: raw })
		})
		socket.write(
			`POST ${MCP_HTTP_PATH} HTTP/1.1\r\n${rawHeaders}\r\n` +
				"content-type: application/json\r\ncontent-length: 2\r\n" +
				"connection: close\r\n\r\n{}",
		)
	})
}

afterEach(async () => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
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

describe("HTTP transport authentication (WS-01)", () => {
	const STANDARD_TOKEN = "test-standard-token"
	const ADMIN_TOKEN = "test-admin-token"

	function initializeBody(label: string): Record<string, unknown> {
		return {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: label, version: "0.0.0" },
			},
		}
	}

	function toolsListBody(): Record<string, unknown> {
		return { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
	}

	async function listToolNames(port: number, token: string): Promise<string[]> {
		const init = await postMcp(port, initializeBody("scope-probe"), {
			authorization: `Bearer ${token}`,
		})
		expect(init.status).toBe(200)
		await init.arrayBuffer()
		const list = await postMcp(port, toolsListBody(), {
			authorization: `Bearer ${token}`,
		})
		expect(list.status).toBe(200)
		const payload = (await list.json()) as {
			result: { tools: Array<{ name: string }> }
		}
		return payload.result.tools.map((tool) => tool.name)
	}

	it("rejects unauthenticated requests with 401 + WWW-Authenticate: Bearer", async () => {
		const port = await startOnEphemeralPort({ authToken: STANDARD_TOKEN })

		const response = await postMcp(port, initializeBody("ws01-noauth"))

		expect(response.status).toBe(401)
		expect(response.headers.get("www-authenticate")).toBe("Bearer")
		const body = (await response.json()) as { error: string }
		expect(body.error).toBe("unauthorized")
	})

	it("rejects an invalid token with 401 + invalid_token challenge", async () => {
		const port = await startOnEphemeralPort({ authToken: STANDARD_TOKEN })

		const response = await postMcp(port, initializeBody("ws01-badtoken"), {
			authorization: "Bearer not-the-token",
		})

		expect(response.status).toBe(401)
		expect(response.headers.get("www-authenticate")).toBe(
			'Bearer error="invalid_token"',
		)
	})

	it("serves the handshake to a valid standard token", async () => {
		const port = await startOnEphemeralPort({ authToken: STANDARD_TOKEN })

		const response = await postMcp(port, initializeBody("ws01-standard"), {
			authorization: `Bearer ${STANDARD_TOKEN}`,
		})

		expect(response.status).toBe(200)
		const payload = (await response.json()) as { jsonrpc: string; id: number }
		expect(payload.jsonrpc).toBe("2.0")
		expect(payload.id).toBe(1)
	})

	it("hides admin tools from the standard scope even when MEMONGO_MCP_ADMIN=1", async () => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "1")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "")
		const port = await startOnEphemeralPort({
			authToken: STANDARD_TOKEN,
			adminToken: ADMIN_TOKEN,
		})

		const names = await listToolNames(port, STANDARD_TOKEN)

		expect(names).toContain("memongo_extract")
		expect(names).not.toContain("memongo_status")
	})

	it("exposes admin tools to the admin credential scope", async () => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "1")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "")
		const port = await startOnEphemeralPort({
			authToken: STANDARD_TOKEN,
			adminToken: ADMIN_TOKEN,
		})

		const names = await listToolNames(port, ADMIN_TOKEN)

		expect(names).toContain("memongo_status")
	})

	it("leaves admin tools unreachable when MEMONGO_MCP_ADMIN=1 but no admin token is set (fail closed)", async () => {
		vi.stubEnv("MEMONGO_MCP_ADMIN", "1")
		vi.stubEnv("MEMONGO_MCP_ALIASES", "")
		const port = await startOnEphemeralPort({ authToken: STANDARD_TOKEN })

		const names = await listToolNames(port, STANDARD_TOKEN)
		expect(names).not.toContain("memongo_status")

		const call = await postMcp(
			port,
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "memongo_status", arguments: {} },
			},
			{ authorization: `Bearer ${STANDARD_TOKEN}` },
		)
		expect(call.status).toBe(200)
		const callPayload = (await call.json()) as { result: { isError?: boolean } }
		expect(callPayload.result.isError).toBe(true)
	})

	it("returns 403 for a disallowed Host header", async () => {
		const port = await startOnEphemeralPort({ authToken: STANDARD_TOKEN })

		const response = await rawMcpRequest(port, { host: "evil.example" })

		expect(response.status).toBe(403)
		expect(response.body).toContain("host not allowed")
	})

	it("returns 403 for a foreign Origin header", async () => {
		const port = await startOnEphemeralPort({ authToken: STANDARD_TOKEN })

		const response = await postMcp(port, initializeBody("ws01-origin"), {
			origin: "http://evil.example",
		})

		expect(response.status).toBe(403)
		const body = (await response.json()) as { error: string }
		expect(body.error).toContain("origin not allowed")
	})

	it("returns 403 (not a crash) for an empty Host header", async () => {
		const port = await startOnEphemeralPort({ authToken: STANDARD_TOKEN })

		const response = await rawSocketRequest(port, "Host:\r\n")

		expect(response.status).toBe(403)
		expect(response.body).toContain("missing host")
	})

	it("sanitizes the 500 error envelope", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const throwingCreate: HttpTransportOptions["createMcpServer"] = () => {
			throw new Error("internal detail: upstream mongod unreachable")
		}
		runningServer = await startHttpTransport({
			createMcpServer: throwingCreate,
			host: "127.0.0.1",
			port: 0,
			authToken: STANDARD_TOKEN,
		})
		const port = (runningServer.address() as AddressInfo).port

		const response = await postMcp(port, initializeBody("ws01-500"), {
			authorization: `Bearer ${STANDARD_TOKEN}`,
		})

		expect(response.status).toBe(500)
		const body = (await response.json()) as { error: string }
		expect(body.error).toBe("internal server error")
		expect(body.error).not.toContain("internal detail")
		expect(consoleError).toHaveBeenCalled()
	})

	it("refuses a non-loopback bind without a transport token", async () => {
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_NO_AUTH", "")
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_REMOTE", "")

		await expect(
			startHttpTransport({
				createMcpServer: createMemongoServer,
				host: "0.0.0.0",
				port: 0,
			}),
		).rejects.toThrow(/Refusing to bind 0\.0\.0\.0/)
	})

	it("requires authentication on a non-loopback bind once a token is configured", async () => {
		const port = await startOnEphemeralPort({
			host: "0.0.0.0",
			authToken: STANDARD_TOKEN,
			allowedHosts: ["127.0.0.1"],
		})

		const response = await postMcp(port, initializeBody("ws01-public"))

		expect(response.status).toBe(401)
		expect(response.headers.get("www-authenticate")).toBe("Bearer")
	})
})
