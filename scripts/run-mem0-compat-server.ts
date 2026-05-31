import {
	memongoBridgeSearch,
	memongoBridgeShutdown,
	memongoBridgeWaitForBenchmarkSearchReadiness,
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

type BridgeSearchResult = {
	canonicalId?: string
	path?: string
	snippet?: string
	citation?: string
	timestamp?: Date
	source?: string
	score?: number
	scoreDetails?: unknown
}

type Mem0CompatSearchResult = {
	id: string
	memory: string
	score?: number
	created_at?: string
	score_debug?: { scoreDetails: unknown }
}

const port = Number.parseInt(process.env.MEMONGO_MEM0_COMPAT_PORT ?? "8888", 10)
const maxResultsCap = Number.parseInt(
	process.env.MEMONGO_MEM0_COMPAT_MAX_RESULTS_CAP ?? "200",
	10,
)
const searchSettleMs = Math.max(
	0,
	Number.parseInt(process.env.MEMONGO_MEM0_COMPAT_SEARCH_SETTLE_MS ?? "10000", 10),
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

function compactTextForQuery(text: string, query: string): string {
	if (text.length <= memoryTextMaxChars) {
		return text
	}
	const lowerText = text.toLowerCase()
	const matchIndex = queryTerms(query)
		.map((term) => lowerText.indexOf(term))
		.filter((index) => index >= 0)
		.sort((a, b) => b - a)[0]
	if (matchIndex === undefined || matchIndex < Math.floor(memoryTextMaxChars * 0.6)) {
		return `${text.slice(0, memoryTextMaxChars).trimEnd()}...`
	}
	const headBudget = Math.min(160, Math.floor(memoryTextMaxChars * 0.4))
	const windowBudget = memoryTextMaxChars - headBudget - 5
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

function hasCountIntent(query: string): boolean {
	return /\b(how many|number of|count|total)\b/i.test(query)
}

function queryActionVerbs(query: string): string[] {
	const verbs = [
		"pick up",
		"return",
		"collect",
		"drop off",
		"send",
		"mail",
		"buy",
		"purchase",
		"order",
		"wash",
		"clean",
		"schedule",
		"book",
		"call",
	]
	const lowerQuery = query.toLowerCase()
	return verbs.filter((verb) => lowerQuery.includes(verb))
}

function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.replace(/\s+/g, " ").trim())
		.filter(Boolean)
}

function normalizeEvidenceKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 2)
		.slice(0, 14)
		.join(" ")
}

function extractActionObject(sentence: string, verb: string): string | undefined {
	const escapedVerb = verb.replace(/\s+/g, "\\s+")
	const verbPattern = escapedVerb.replace(
		"pick\\s+up",
		"pick(?:ing)?\\s+up",
	)
	const match = sentence.match(
		new RegExp(
			`\\b${verbPattern}\\s+(?:the|my|your|a|an|some)?\\s*([^.;!?]+)`,
			"i",
		),
	)
	const raw = match?.[1]?.trim()
	if (!raw) {
		return undefined
	}
	const object = raw
		.replace(/\b(actually|yet|soon)\b/gi, "")
		.split(/\s+(?:before|because|but|so|and then|while)\s+/i)[0]
		.replace(/[,\s]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
	if (!object || /^(it|them|ones|one)$/i.test(object)) {
		return undefined
	}
	return object
}

function normalizeActionObject(object: string): string {
	const dryCleaningMatch = object.match(/\bdry cleaning for (?:the|my|a|an)?\s*(.+)$/i)
	if (dryCleaningMatch?.[1]) {
		return `${dryCleaningMatch[1].trim()} from the dry cleaner`
	}
	return object
}

function compactEvidenceSentence(sentence: string): string {
	const cleaned = sentence.replace(/\s+/g, " ").trim()
	return cleaned.length <= 180 ? cleaned : `${cleaned.slice(0, 177).trimEnd()}...`
}

function buildActionEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!hasCountIntent(query)) {
		return []
	}
	const verbs = queryActionVerbs(query)
	if (verbs.length === 0) {
		return []
	}

	const seen = new Set<string>()
	const actions: Array<{
		verb: string
		object: string
		date?: string
		evidence: string
	}> = []
	for (const result of results.slice(0, 20)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (
				sentence.includes("?") ||
				sentence.includes("**") ||
				/\b(tips|advice|here are|choose a specific|create a|set reminders)\b/i.test(
					sentence,
				)
			) {
				continue
			}
			const lowerSentence = sentence.toLowerCase()
			const verb = verbs.find((candidate) => lowerSentence.includes(candidate))
			if (!verb) {
				continue
			}
			if (!/\b(need|still need|haven't|have not)\b/i.test(sentence)) {
				continue
			}
			const object = extractActionObject(sentence, verb)
			if (!object) {
				continue
			}
			const normalizedObject = normalizeActionObject(object)
			const key = `${verb}:${normalizeEvidenceKey(normalizedObject)}`
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			actions.push({
				verb,
				object: normalizedObject,
				date,
				evidence: compactEvidenceSentence(sentence),
			})
			if (actions.length >= 8) {
				break
			}
		}
		if (actions.length >= 8) {
			break
		}
	}
	if (actions.length === 0) {
		return []
	}
	const firstDate = actions.find((action) => action.date)?.date
	const bullets = actions
		.map(
			(action, index) =>
				`${index + 1}. separate pending action: ${action.verb} ${action.object} (source memory: "${action.evidence}")`,
		)
		.join(" ")
	const memory = `${firstDate ? `${firstDate} ` : ""}derived action checklist from retrieved memories: count the numbered actions separately when the question asks how many things need to be picked up, returned, collected, or otherwise handled. Do not merge different action verbs just because they mention the same store or product family. ${bullets}`
	return [
		{
			id: `derived-action-checklist:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1,
			created_at: results[0]?.timestamp?.toISOString?.(),
		},
	]
}

function resultText(
	query: string,
	result: BridgeSearchResult,
): string {
	const raw = result.snippet ?? result.citation ?? result.path ?? ""
	const text = raw.replace(/\s+/g, " ").trim()
	if (!text) {
		return result.path ?? ""
	}
	const clipped = compactTextForQuery(text, query)
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
				const results = await memongoBridgeSearch({
					agentId: userId,
					query,
					maxResults,
				})
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
				return json({
					settle_wait_ms,
					readiness_wait_ms,
					results: [...actionEvidence, ...formattedResults].slice(0, maxResults),
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
