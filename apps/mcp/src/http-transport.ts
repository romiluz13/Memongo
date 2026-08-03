import {
	createServer as createNodeHttpServer,
	type IncomingMessage,
	type Server as NodeHttpServer,
	type ServerResponse,
} from "node:http"
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

export const MCP_HTTP_PATH = "/mcp"
export const DEFAULT_MCP_HTTP_PORT = 3110
const DEFAULT_MCP_HTTP_HOST = "127.0.0.1"

export type HttpTransportOptions = {
	createMcpServer: () => McpServer
	port?: number
	host?: string
}

function resolvePort(explicitPort: number | undefined): number {
	if (explicitPort !== undefined) {
		return explicitPort
	}
	const raw = process.env.MEMONGO_MCP_HTTP_PORT
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_MCP_HTTP_PORT
	}
	const port = Number(raw)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`invalid MEMONGO_MCP_HTTP_PORT: ${raw}`)
	}
	return port
}

function resolveHost(explicitHost: string | undefined): string {
	if (explicitHost !== undefined) {
		return explicitHost
	}
	return process.env.MEMONGO_MCP_HTTP_HOST ?? DEFAULT_MCP_HTTP_HOST
}

// Stateless Streamable HTTP (MCP spec 2025-03-26+): each request gets a fresh
// MCP server + transport pair, so no session state is held between requests.
async function handleMcpRequest(
	createMcpServer: () => McpServer,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const mcpServer = createMcpServer()
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	res.on("close", () => {
		void transport.close().catch(() => {})
		void mcpServer.close().catch(() => {})
	})
	await mcpServer.connect(transport)
	await transport.handleRequest(req, res)
}

export async function startHttpTransport(
	options: HttpTransportOptions,
): Promise<NodeHttpServer> {
	const port = resolvePort(options.port)
	const host = resolveHost(options.host)

	const httpServer = createNodeHttpServer((req, res) => {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		)
		if (url.pathname !== MCP_HTTP_PATH) {
			res.writeHead(404, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: "not found" }))
			return
		}
		handleMcpRequest(options.createMcpServer, req, res).catch((err) => {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" })
			}
			res.end(
				JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
				}),
			)
		})
	})

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject)
		httpServer.listen(port, host, () => {
			httpServer.removeListener("error", reject)
			resolve()
		})
	})

	const address = httpServer.address()
	const boundPort =
		typeof address === "object" && address !== null ? address.port : port
	console.error(
		`memongo-mcp: streamable HTTP transport listening on http://${host}:${boundPort}${MCP_HTTP_PATH}`,
	)
	return httpServer
}
