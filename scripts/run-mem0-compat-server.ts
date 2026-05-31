import {
	memongoBridgeSearch,
	memongoBridgeShutdown,
	memongoBridgeWriteConversationEvent,
} from "@memongo/memory-bridge"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Mem0Message = {
	role?: string
	content?: string
}

type Mem0AddRequest = {
	messages?: Mem0Message[]
	user_id?: string
	timestamp?: number
}

type Mem0SearchRequest = {
	query?: string
	user_id?: string
	limit?: number
	top_k?: number
}

const port = Number.parseInt(process.env.MEMONGO_MEM0_COMPAT_PORT ?? "8888", 10)
const maxResultsCap = Number.parseInt(
	process.env.MEMONGO_MEM0_COMPAT_MAX_RESULTS_CAP ?? "200",
	10,
)

if (!process.env.MEMONGO_MONGODB_URI) {
	throw new Error("MEMONGO_MONGODB_URI is required")
}

if (!process.env.MEMONGO_WORKSPACE_DIR) {
	const workspaceDir = join(tmpdir(), `memongo-mem0-compat-${process.pid}`)
	mkdirSync(join(workspaceDir, "memory"), { recursive: true })
	process.env.MEMONGO_WORKSPACE_DIR = workspaceDir
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	})
}

async function readJson<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T
	} catch {
		throw new Error("invalid JSON body")
	}
}

function normalizeRole(role?: string): "user" | "assistant" | "system" | "tool" {
	if (role === "assistant" || role === "system" || role === "tool") {
		return role
	}
	return "user"
}

function toTimestamp(timestamp?: number): string | undefined {
	if (!Number.isFinite(timestamp)) {
		return undefined
	}
	return new Date((timestamp as number) * 1000).toISOString()
}

function resultText(result: {
	snippet?: string
	citation?: string
	path?: string
}): string {
	return result.snippet ?? result.citation ?? result.path ?? ""
}

const server = Bun.serve({
	port,
	async fetch(request) {
		const url = new URL(request.url)
		try {
			if (request.method === "GET" && url.pathname === "/health") {
				return json({ ok: true, service: "memongo-mem0-compat" })
			}

			if (request.method === "POST" && url.pathname === "/memories") {
				const body = await readJson<Mem0AddRequest>(request)
				const userId = body.user_id?.trim()
				if (!userId) {
					return json({ error: "user_id is required" }, 400)
				}
				const messages = body.messages ?? []
				const timestamp = toTimestamp(body.timestamp)
				const results: Array<{ id: string; event: string; memory: string }> = []
				for (const message of messages) {
					const content = message.content?.trim()
					if (!content) {
						continue
					}
					const written = await memongoBridgeWriteConversationEvent({
						agentId: userId,
						role: normalizeRole(message.role),
						body: content,
						sessionId: userId,
						timestamp,
						metadata: {
							benchmarkAdapter: "mem0-oss-compat",
							sourceUserId: userId,
						},
					})
					results.push({
						id: written.eventId,
						event: "ADD",
						memory: content,
					})
				}
				return json({ results })
			}

			if (request.method === "POST" && url.pathname === "/search") {
				const body = await readJson<Mem0SearchRequest>(request)
				const userId = body.user_id?.trim()
				const query = body.query?.trim()
				if (!userId || !query) {
					return json({ error: "query and user_id are required" }, 400)
				}
				const requestedLimit = body.limit ?? body.top_k ?? 10
				const maxResults = Math.max(1, Math.min(requestedLimit, maxResultsCap))
				const results = await memongoBridgeSearch({
					agentId: userId,
					query,
					maxResults,
					sessionKey: userId,
				})
				return json({
					results: results.map((result) => ({
						id: result.canonicalId ?? result.path,
						memory: resultText(result),
						score: result.score,
						created_at: result.timestamp?.toISOString?.(),
						score_debug: result.scoreDetails
							? { scoreDetails: result.scoreDetails }
							: undefined,
					})),
				})
			}

			if (request.method === "DELETE" && url.pathname === "/memories") {
				return json({
					ok: true,
					warning:
						"Memongo benchmark cleanup is prefix-based; use a unique collection prefix per run.",
				})
			}

			return json({ error: "not found" }, 404)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return json({ error: message }, 500)
		}
	},
})

console.log(`mem0-compat: listening on http://localhost:${server.port}`)

const shutdown = async () => {
	server.stop(true)
	await memongoBridgeShutdown()
	process.exit(0)
}

process.on("SIGINT", () => {
	void shutdown()
})
process.on("SIGTERM", () => {
	void shutdown()
})
