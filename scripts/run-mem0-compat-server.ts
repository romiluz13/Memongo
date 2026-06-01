import {
	memongoBridgeSearchDetailed,
	memongoBridgeShutdown,
	memongoBridgeWaitForBenchmarkSearchReadiness,
	memongoBridgeWriteConversationEvent,
} from "@memongo/memory-bridge"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	buildActionEvidenceResults,
	buildCountEvidenceResults,
	buildPreferenceEvidenceResults,
	hasCountIntent,
	type BridgeSearchResult,
	type Mem0CompatSearchResult,
} from "./mem0-compat-count-policy.js"

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
const searchSettleMs = Math.max(
	0,
	Number.parseInt(
		process.env.MEMONGO_MEM0_COMPAT_SEARCH_SETTLE_MS ?? "10000",
		10,
	),
)
const memoryTextMaxChars = Math.max(
	120,
	Number.parseInt(
		process.env.MEMONGO_MEM0_COMPAT_MEMORY_TEXT_MAX_CHARS ?? "420",
		10,
	),
)
const strictCompat =
	process.env.MEMONGO_MEM0_COMPAT_STRICT?.trim().toLowerCase() !== "0" &&
	process.env.MEMONGO_MEM0_COMPAT_STRICT?.trim().toLowerCase() !== "false"
const lastWriteAtByUser = new Map<string, number>()
const queryStopwords = new Set([
	"about",
	"after",
	"again",
	"also",
	"can",
	"could",
	"from",
	"have",
	"many",
	"need",
	"previous",
	"remind",
	"some",
	"that",
	"their",
	"there",
	"this",
	"what",
	"when",
	"where",
	"which",
	"with",
	"would",
	"your",
])

const queryFocusVariants: Array<{ trigger: RegExp; variants: string[] }> = [
	{
		trigger: /\bwear(?:ing|s)?\b/i,
		variants: ["wearing", "wears", "wear", "wore", "worn", "outfit", "shirt"],
	},
	{
		trigger: /\bbak(?:e|ed|ing)\b/i,
		variants: ["baked", "bake", "baking", "made"],
	},
	{
		trigger: /\b(acquir(?:e|ed|ing)?|got|bought|purchased|received)\b/i,
		variants: ["acquired", "got", "bought", "purchased", "received", "new"],
	},
]

if (!process.env.MEMONGO_MONGODB_URI) {
	throw new Error("MEMONGO_MONGODB_URI is required")
}

process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE ??=
	process.env.MEMONGO_MEM0_COMPAT_DERIVED_WORK_MODE ?? "disabled"
if (strictCompat) {
	process.env.MEMONGO_BENCHMARK_STRICT ??= "1"
	process.env.MEMONGO_STRICT_SEARCH_INDEX_READY ??= "1"
	process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS ??= "300000"
	process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS ??= "300000"
	process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS ??= "30000"
	process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS ??= "300000"
	process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS ??= "30000"
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

function normalizeRole(
	role?: string,
): "user" | "assistant" | "system" | "tool" {
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSearchSettle(userId: string): Promise<number> {
	const lastWriteAt = lastWriteAtByUser.get(userId)
	if (!lastWriteAt || searchSettleMs <= 0) {
		return 0
	}
	const remainingMs = searchSettleMs - (Date.now() - lastWriteAt)
	if (remainingMs <= 0) {
		return 0
	}
	await sleep(remainingMs)
	return remainingMs
}

async function waitForSearchReadiness(userId: string): Promise<number> {
	const startedAt = Date.now()
	await memongoBridgeWaitForBenchmarkSearchReadiness({
		agentId: userId,
		retrievalLane: "native",
	})
	return Date.now() - startedAt
}

function queryTerms(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9']+/)
				.filter((term) => term.length >= 4 && !queryStopwords.has(term)),
		),
	].sort((a, b) => b.length - a.length)
}

function queryTermVariants(term: string): string[] {
	const variants = new Set([term])
	if (term.endsWith("ing") && term.length > 5) {
		const base = term.slice(0, -3)
		variants.add(base)
		variants.add(`${base}e`)
		variants.add(`${base}s`)
		variants.add(`${base}ed`)
	}
	if (term.endsWith("ed") && term.length > 4) {
		const base = term.slice(0, -2)
		variants.add(base)
		variants.add(`${base}e`)
		variants.add(`${base}ing`)
		variants.add(`${base}s`)
	}
	if (term.endsWith("s") && term.length > 4) {
		variants.add(term.slice(0, -1))
	}
	return [...variants].filter((variant) => variant.length >= 3)
}

function focusMatchIndex(textLower: string, query: string): number | undefined {
	const focus = queryFocusVariants.find((entry) => entry.trigger.test(query))
	if (!focus) {
		return undefined
	}
	const indices = focus.variants
		.map((variant) => textLower.indexOf(variant))
		.filter((index) => index >= 0)
		.sort((a, b) => a - b)
	return indices[0]
}

function scoreWindow(windowLower: string, query: string): number {
	let score = 0
	for (const term of queryTerms(query)) {
		const variants = queryTermVariants(term)
		if (variants.some((variant) => windowLower.includes(variant))) {
			score += 1
		}
	}
	return score
}

function bestQueryWindowStart(
	text: string,
	query: string,
	maxChars = memoryTextMaxChars,
): number | undefined {
	const lowerText = text.toLowerCase()
	const focusIndex = focusMatchIndex(lowerText, query)
	if (focusIndex !== undefined) {
		return focusIndex
	}
	const candidates = queryTerms(query).flatMap((term) =>
		queryTermVariants(term)
			.map((variant) => lowerText.indexOf(variant))
			.filter((index) => index >= 0),
	)
	if (candidates.length === 0) {
		return undefined
	}
	return candidates
		.map((index) => {
			const start = Math.max(0, index - Math.floor(maxChars * 0.35))
			const window = lowerText.slice(start, start + maxChars)
			return { index, score: scoreWindow(window, query) }
		})
		.sort((a, b) => b.score - a.score || a.index - b.index)[0]?.index
}

function compactTextForQuery(
	text: string,
	query: string,
	maxChars = memoryTextMaxChars,
): string {
	if (text.length <= maxChars) {
		return text
	}
	const matchIndex = bestQueryWindowStart(text, query, maxChars)
	if (matchIndex === undefined || matchIndex < Math.floor(maxChars * 0.6)) {
		return `${text.slice(0, maxChars).trimEnd()}...`
	}
	const headBudget = Math.min(160, Math.floor(maxChars * 0.4))
	const windowBudget = maxChars - headBudget - 5
	const windowStart = Math.max(
		0,
		Math.min(
			matchIndex - Math.floor(windowBudget * 0.35),
			text.length - windowBudget,
		),
	)
	const head = text.slice(0, headBudget).trimEnd()
	const window = text.slice(windowStart, windowStart + windowBudget).trim()
	const suffix = windowStart + windowBudget < text.length ? "..." : ""
	return `${head} ... ${window}${suffix}`
}

function resultText(query: string, result: BridgeSearchResult): string {
	const raw = result.snippet ?? result.citation ?? result.path ?? ""
	const text = raw.replace(/\s+/g, " ").trim()
	if (!text) {
		return result.path ?? ""
	}
	const maxChars = hasCountIntent(query)
		? Math.min(memoryTextMaxChars, 260)
		: memoryTextMaxChars
	const clipped = compactTextForQuery(text, query, maxChars)
	const date = result.timestamp?.toISOString?.().slice(0, 10)
	const source = result.source ? `${result.source} memory` : "memory"
	return date ? `${date} ${source}: ${clipped}` : `${source}: ${clipped}`
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
				if (results.length > 0) {
					lastWriteAtByUser.set(userId, Date.now())
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
				const settle_wait_ms = await waitForSearchSettle(userId)
				const readiness_wait_ms = await waitForSearchReadiness(userId)
				const detailed = await memongoBridgeSearchDetailed({
					agentId: userId,
					query,
					maxResults,
					searchMode: "direct",
					sourcePreference: ["conversation"],
					needExactEvidence: true,
					searchConfig: {
						maxResults,
						searchMode: "direct",
						sourcePreference: ["conversation"],
						needExactEvidence: true,
					},
				})
				const results = detailed.results as BridgeSearchResult[]
				const formattedResults: Mem0CompatSearchResult[] = results.map(
					(result) => ({
						id: result.canonicalId ?? result.path,
						memory: resultText(query, result),
						score: result.score,
						created_at: result.timestamp?.toISOString?.(),
						score_debug: result.scoreDetails
							? { scoreDetails: result.scoreDetails }
							: undefined,
					}),
				)
				const actionEvidence = buildActionEvidenceResults(query, results)
				const countEvidence = buildCountEvidenceResults(query, results)
				const preferenceEvidence = buildPreferenceEvidenceResults(
					query,
					results,
				)
				return json({
					settle_wait_ms,
					readiness_wait_ms,
					results: [
						...actionEvidence,
						...countEvidence,
						...preferenceEvidence,
						...formattedResults,
					].slice(0, maxResults),
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
			console.error(`mem0-compat: request failed ${url.pathname}: ${message}`)
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
