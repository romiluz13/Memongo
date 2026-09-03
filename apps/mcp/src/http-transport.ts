import {
	createServer as createNodeHttpServer,
	type IncomingMessage,
	type Server as NodeHttpServer,
	type ServerResponse,
} from "node:http"
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { formatUncaughtError, refuseToServeOpen } from "@memongo/lib"
import {
	type McpAuthOptions,
	type McpAuthScope,
	allowedHostNames,
	authenticateBearer,
	isMcpAuthActive,
	resolveMcpAuthConfig,
	validateHostAndOrigin,
} from "./auth.js"
import { parseMcpToolFlags } from "./tool-registry.js"

export const MCP_HTTP_PATH = "/mcp"
export const DEFAULT_MCP_HTTP_PORT = 3110
const DEFAULT_MCP_HTTP_HOST = "127.0.0.1"

export type HttpTransportOptions = McpAuthOptions & {
	createMcpServer: (scope: McpAuthScope) => McpServer
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
// The authenticated scope picks which server surface the request may see.
async function handleMcpRequest(
	createMcpServer: (scope: McpAuthScope) => McpServer,
	scope: McpAuthScope,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const mcpServer = createMcpServer(scope)
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
	const auth = resolveMcpAuthConfig(options)
	const authActive = isMcpAuthActive(auth)

	// Guardrail 3 (WS-01 remediation): the auth signal for the bind guard is
	// this transport's own client credential — never the upstream
	// MEMONGO_API_KEY, whose presence proves nothing about who may call this
	// endpoint. A non-loopback bind without MEMONGO_MCP_AUTH_TOKEN refuses
	// to start; loopback without a token keeps the local-trust dev posture.
	try {
		refuseToServeOpen(host, authActive)
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n` +
				`  • MCP HTTP transport: set MEMONGO_MCP_AUTH_TOKEN (a client ` +
				`credential for this endpoint — distinct from MEMONGO_API_KEY, ` +
				`which authenticates this server to the upstream API).`,
		)
	}

	const allowedHosts = allowedHostNames(host, auth.allowedHosts)
	if (!authActive) {
		console.error(
			"memongo-mcp: no MEMONGO_MCP_AUTH_TOKEN set — local trust mode; keep the bind on loopback",
		)
	}
	if (authActive && parseMcpToolFlags(process.env).admin && !auth.adminToken) {
		console.error(
			"WARNING: MEMONGO_MCP_ADMIN=1 without MEMONGO_MCP_ADMIN_TOKEN — admin " +
				"tools are unreachable over HTTP (fail closed). Set " +
				"MEMONGO_MCP_ADMIN_TOKEN to expose them to an admin credential.",
		)
	}

	const httpServer = createNodeHttpServer((req, res) => {
		// DNS-rebinding / cross-origin defense comes first: every path on
		// this server sits behind the Host/Origin check, not just /mcp.
		// It must also run before the URL parse: an empty or malformed Host
		// is a 403, never a parser crash (refutation round 1 finding).
		const hostOrigin = validateHostAndOrigin(
			req.headers.host,
			req.headers.origin,
			allowedHosts,
		)
		if (!hostOrigin.ok) {
			res.writeHead(403, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: `forbidden: ${hostOrigin.reason}` }))
			return
		}
		let url: URL
		try {
			url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
		} catch {
			res.writeHead(400, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: "bad request" }))
			return
		}
		if (url.pathname !== MCP_HTTP_PATH) {
			res.writeHead(404, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: "not found" }))
			return
		}
		// WS-01: authenticate before any MCP handling. Unauthenticated or
		// invalid bearers get 401 + WWW-Authenticate (the MCP authorization
		// spec's minimum); the matched token carries the tool scope.
		let scope: McpAuthScope
		if (authActive) {
			const bearer = authenticateBearer(req.headers.authorization, auth)
			if (!bearer.ok) {
				const challenge = bearer.presented
					? 'Bearer error="invalid_token"'
					: "Bearer"
				res.writeHead(401, {
					"content-type": "application/json",
					"www-authenticate": challenge,
				})
				res.end(JSON.stringify({ error: "unauthorized" }))
				return
			}
			scope = bearer.scope
		} else {
			scope = "local"
		}
		handleMcpRequest(options.createMcpServer, scope, req, res).catch((err) => {
			// WS-01: full error detail goes to the server log only — the
			// response envelope stays generic so internals never reach callers.
			// C-002: the logged detail is redacted — error chains can carry
			// credentials or connection strings into diagnostics.
			console.error(
				"memongo-mcp: MCP request handling failed:",
				formatUncaughtError(err),
			)
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" })
			}
			res.end(JSON.stringify({ error: "internal server error" }))
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
		`memongo-mcp: streamable HTTP transport listening on http://${host}:${boundPort}${MCP_HTTP_PATH}` +
			(authActive
				? " (bearer authentication required)"
				: " (local trust, no authentication)"),
	)
	return httpServer
}
