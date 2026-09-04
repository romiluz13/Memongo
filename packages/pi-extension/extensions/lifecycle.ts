/**
 * Memongo lifecycle hooks for the Pi coding agent (P1.4).
 *
 * The LLM almost never calls memongo_save/memongo_search on its own, so the
 * extension nudges at the prompt layer instead:
 *
 *   - Session-start injection: on `session_start` prefetch the agent profile
 *     plus a bounded recent-memories search at the configured scope, then
 *     inject the rendered context once per session via `before_agent_start`
 *     (a persistent `customType: "memongo-context"` message).
 *   - Turn-end auto-capture: buffer user + assistant turn text and write it
 *     to Memongo as conversation events (`writeEvent`, /v1/write-event) with
 *     idempotency keys derived from turn identity (P0.1), batched/debounced
 *     so a long session doesn't fire per-turn HTTP.
 *
 * Everything fails SILENTLY with a single warn log — a down Memongo API must
 * never break the Pi session.
 *
 * Config (env):
 *   MEMONGO_PI_AUTO_CAPTURE=0      — disable turn-end capture (default ON)
 *   MEMONGO_PI_SESSION_INJECTION=0 — disable session-start injection (default ON)
 *   MEMONGO_PI_MEMORY_SCOPE        — Memongo scope for both (default "agent";
 *                                   "global" is available but no longer the
 *                                   default — a global default let one project
 *                                   poison every project's recall, C-008)
 */

import type {
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type {
	MemongoClient,
	MemongoProfileResponse,
	MemongoScope,
	MemongoSearchDetailedResponse,
} from "@memongo/client"
import { renderMemoryContextBlock } from "@memongo/tools/memory-context"
import { sanitizeDiagnostic } from "./diagnostics.js"

const SCOPES: readonly MemongoScope[] = [
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
]

const DEFAULT_FLUSH_EVERY = 4
const DEFAULT_FLUSH_MS = 5_000
const DEFAULT_INJECTION_TIMEOUT_MS = 3_000
// B15.5: the per-session dedup set must not grow without bound in a
// long-running Pi session. 10k keys ≈ months of turns; FIFO eviction only
// re-admits ancient turns, and the server idempotency key no-ops those.
const MAX_SEEN_KEYS = 10_000
const RECENT_MEMORIES_MAX = 5
const PROFILE_ITEMS_PER_TYPE = 3
const SNIPPET_MAX = 200
const INJECTION_CUSTOM_TYPE = "memongo-context"
/**
 * Generic recall query for the session-start prefetch — at session start there
 * is no user prompt yet, so we pull broadly relevant durable context.
 */
const RECENT_CONTEXT_QUERY =
	"recent project context, decisions, preferences, and open problems"

/** Parse a bool env var: 1/true (case-insensitive) enable, 0/false disable. */
export function parseBoolEnv(
	value: string | undefined,
	fallback: boolean,
): boolean {
	if (value == null) return fallback
	const normalized = value.trim().toLowerCase()
	if (normalized === "1" || normalized === "true") return true
	if (normalized === "0" || normalized === "false") return false
	return fallback
}

export interface MemongoLifecycleConfig {
	captureEnabled: boolean
	injectionEnabled: boolean
	scope: MemongoScope
}

export function resolveLifecycleConfig(
	env: NodeJS.ProcessEnv = process.env,
): MemongoLifecycleConfig {
	const rawScope = env.MEMONGO_PI_MEMORY_SCOPE
	// C-008: the default scope is "agent", not "global" — a global default
	// let one project's writes surface in every project's recall. Agent scope
	// still spans projects for the same agent (the extension's cross-project
	// value prop) while isolating other agents/surfaces; "global" remains an
	// explicit opt-in.
	return {
		captureEnabled: parseBoolEnv(env.MEMONGO_PI_AUTO_CAPTURE, true),
		injectionEnabled: parseBoolEnv(env.MEMONGO_PI_SESSION_INJECTION, true),
		scope: (SCOPES as readonly string[]).includes(rawScope ?? "")
			? (rawScope as MemongoScope)
			: "agent",
	}
}

/**
 * Idempotency key for a captured turn (P0.1). Pi resets `turnIndex` to 0 on
 * every `agent_start` (one agent run per user prompt), so the stable turn
 * identity is (sessionId, agentRunIndex, turnIndex, role). A retried capture
 * of the same turn regenerates the same key and is deduped by the server.
 */
export function captureIdempotencyKey(
	sessionId: string,
	agentRunIndex: number,
	turnIndex: number,
	role: "user" | "assistant",
): string {
	return `pi-${sessionId}-r${agentRunIndex}-t${turnIndex}-${role}`
}

/**
 * Extract plain text from a Pi message. User content is a string or
 * (TextContent|ImageContent)[]; assistant content is
 * (TextContent|ThinkingContent|ToolCall)[]. Only text parts are kept, so
 * tool-only assistant turns return "" and are skipped.
 */
export function extractMessageText(message: {
	role: string
	content?: unknown
}): string {
	const content = message.content
	if (typeof content === "string") return content.trim()
	if (!Array.isArray(content)) return ""
	const texts: string[] = []
	for (const part of content) {
		if (!part || typeof part !== "object") continue
		const typed = part as { type?: unknown; text?: unknown }
		if (typed.type === "text" && typeof typed.text === "string") {
			const trimmed = typed.text.trim()
			if (trimmed) texts.push(trimmed)
		}
	}
	return texts.join("\n")
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text
	return `${text.slice(0, max)}…`
}

/**
 * C-002: all lifecycle warn lines flow through errMessage, which routes
 * through the shared local classifier in ./diagnostics.ts (the published
 * package cannot depend on @memongo/lib).
 */
function errMessage(err: unknown): string {
	return sanitizeDiagnostic(err instanceof Error ? err.message : String(err))
}

type SearchResults = MemongoSearchDetailedResponse["results"]

/**
 * Render the injected session context. Returns null when there is nothing
 * worth injecting (empty profile AND no memories) so we never inject noise.
 * C-008: the rendered content is wrapped in the #29 quarantine envelope
 * (untrusted-data preamble + forgery-proof delimiters) before it reaches
 * the session context.
 */
export function renderSessionContext(
	profile: MemongoProfileResponse | null,
	results: SearchResults,
): string | null {
	const sections: string[] = []
	if (profile) {
		const lines: string[] = []
		const add = (
			label: string,
			items: Array<{ key: string; value: string }>,
		) => {
			for (const item of items.slice(0, PROFILE_ITEMS_PER_TYPE)) {
				lines.push(
					`- ${label}: ${item.key} — ${truncate(item.value, SNIPPET_MAX)}`,
				)
			}
		}
		add("preference", profile.preferences)
		add("decision", profile.decisions)
		add("fact", profile.facts)
		add("todo", profile.todos)
		if (lines.length > 0) {
			sections.push(`Profile (scope: ${profile.scope}):\n${lines.join("\n")}`)
		}
	}
	if (results.length > 0) {
		const lines = results
			.slice(0, RECENT_MEMORIES_MAX)
			.map(
				(r, i) =>
					`${i + 1}. [${r.source}] ${r.path} — ${truncate(r.snippet, SNIPPET_MAX)}`,
			)
		sections.push(`Recent memories:\n${lines.join("\n")}`)
	}
	if (sections.length === 0) return null
	const rendered = [
		"## Memongo long-term memory (auto-injected at session start)",
		"",
		...sections,
	].join("\n")
	// C-008: profile entries and stored memories are content other processes
	// wrote — UNTRUSTED input. Wrap the whole block in the same quarantine
	// envelope the Vercel/OpenAI SDK tools use (#29), so stored text that
	// looks like instructions is read as reference data, not obeyed.
	return renderMemoryContextBlock(rendered)
}

interface BufferedCapture {
	role: "user" | "assistant"
	body: string
	key: string
	sessionId: string
	turnIndex: number
}

export interface MemongoLifecycleDeps {
	client: MemongoClient
	agentId: string
	isAvailable: () => boolean
	config?: MemongoLifecycleConfig
	/** Flush the capture buffer every N events (default 4). */
	flushEvery?: number
	/** Flush the capture buffer T ms after the first buffered event (default 5000). */
	flushMs?: number
	/** Max turn-dedup keys retained per session (default 10_000, FIFO eviction). */
	maxSeenKeys?: number
	/** Max time before_agent_start waits for the prefetch (default 3000). */
	injectionTimeoutMs?: number
	warn?: (message: string) => void
}

export interface MemongoLifecycleHandle {
	/** Flush buffered capture events (also wired to session_shutdown). */
	flushCaptures(): Promise<void>
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/**
 * Register Memongo's session_start / before_agent_start / agent_start /
 * message_start / turn_end / session_shutdown hooks. Never throws — all
 * failures degrade to one warn log.
 */
export function registerMemongoLifecycle(
	pi: ExtensionAPI,
	deps: MemongoLifecycleDeps,
): MemongoLifecycleHandle {
	const config = deps.config ?? resolveLifecycleConfig()
	const warn = deps.warn ?? ((message: string) => console.warn(message))
	const flushEvery = deps.flushEvery ?? DEFAULT_FLUSH_EVERY
	const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS
	const maxSeenKeys =
		typeof deps.maxSeenKeys === "number" &&
		Number.isInteger(deps.maxSeenKeys) &&
		deps.maxSeenKeys > 0
			? deps.maxSeenKeys
			: MAX_SEEN_KEYS
	const injectionTimeoutMs =
		deps.injectionTimeoutMs ?? DEFAULT_INJECTION_TIMEOUT_MS

	// ─── Session-start injection state ─────────────────────────────────
	let injectionPromise: Promise<string | null> | null = null
	let injectionAttempted = false

	// ─── Turn-end capture state ────────────────────────────────────────
	let agentRunIndex = -1
	let pendingUserText: string | null = null
	const seenKeys = new Set<string>()
	const buffer: BufferedCapture[] = []
	let flushTimer: ReturnType<typeof setTimeout> | null = null
	let flushChain: Promise<void> = Promise.resolve()

	async function fetchSessionContext(): Promise<string | null> {
		// Partial failure is fine: inject whichever half succeeded.
		const [profileRes, searchRes] = await Promise.allSettled([
			deps.client.profile({
				agentId: deps.agentId,
				scope: config.scope,
				maxEntities: 5,
				maxEpisodes: 3,
			}),
			deps.client.searchDetailed({
				query: RECENT_CONTEXT_QUERY,
				agentId: deps.agentId,
				scope: config.scope,
				limit: RECENT_MEMORIES_MAX,
				maxResults: RECENT_MEMORIES_MAX,
				searchMode: "direct",
			}),
		])
		const failures: string[] = []
		if (profileRes.status === "rejected") {
			failures.push(`profile: ${errMessage(profileRes.reason)}`)
		}
		if (searchRes.status === "rejected") {
			failures.push(`search: ${errMessage(searchRes.reason)}`)
		}
		if (failures.length > 0) {
			warn(`[memongo] session context fetch failed (${failures.join("; ")})`)
		}
		const profile = profileRes.status === "fulfilled" ? profileRes.value : null
		const results =
			searchRes.status === "fulfilled" ? searchRes.value.results : []
		return renderSessionContext(profile, results)
	}

	function safeSessionId(ctx: ExtensionContext): string {
		try {
			return ctx.sessionManager.getSessionId() || "ephemeral"
		} catch {
			return "ephemeral"
		}
	}

	async function drainBuffer(): Promise<void> {
		if (flushTimer) {
			clearTimeout(flushTimer)
			flushTimer = null
		}
		const items = buffer.splice(0, buffer.length)
		for (const item of items) {
			try {
				// Writes are intentionally NOT silent-mode: silent only covers
				// search/read calls, so we catch per event and keep draining.
				await deps.client.writeEvent({
					role: item.role,
					body: item.body,
					agentId: deps.agentId,
					sessionId: item.sessionId,
					scope: config.scope,
					customId: item.key,
					metadata: { source: "pi-extension", turnIndex: item.turnIndex },
				})
			} catch (err) {
				warn(
					`[memongo] auto-capture write failed (${item.key}): ${errMessage(err)}`,
				)
			}
		}
	}

	function flushCaptures(): Promise<void> {
		// Serialize flushes so a threshold flush and a timer/session_shutdown
		// flush never interleave writes.
		flushChain = flushChain.then(drainBuffer)
		return flushChain
	}

	function enqueueCaptures(items: BufferedCapture[]): Promise<void> | null {
		let added = false
		for (const item of items) {
			if (seenKeys.has(item.key)) continue
			if (seenKeys.size >= maxSeenKeys) {
				// B15.5: FIFO-evict the oldest key (Set preserves insertion
				// order) so the dedup set stays bounded. An ancient turn that
				// re-arrives after eviction re-buffers once; the server-side
				// idempotency key makes that duplicate write a no-op.
				const oldest = seenKeys.values().next().value
				if (oldest !== undefined) seenKeys.delete(oldest)
			}
			seenKeys.add(item.key)
			buffer.push(item)
			added = true
		}
		if (!added) return null
		if (buffer.length >= flushEvery) return flushCaptures()
		if (!flushTimer) {
			flushTimer = setTimeout(() => {
				void flushCaptures()
			}, flushMs)
			// Never keep a Pi (or test) process alive just for the debounce.
			flushTimer.unref?.()
		}
		return null
	}

	// ─── Hook: session_start — prefetch injection context ──────────────
	pi.on("session_start", async (_event, _ctx) => {
		if (!config.injectionEnabled || !deps.isAvailable()) return
		injectionPromise = fetchSessionContext().catch((err: unknown) => {
			// Defensive: fetchSessionContext uses allSettled internally, but a
			// synchronous/render failure must still never break the session.
			warn(`[memongo] session context fetch failed: ${errMessage(err)}`)
			return null
		})
	})

	// ─── Hook: before_agent_start — inject once per session ────────────
	pi.on(
		"before_agent_start",
		async (_event, _ctx): Promise<BeforeAgentStartEventResult | undefined> => {
			if (!config.injectionEnabled || injectionAttempted) return undefined
			injectionAttempted = true
			if (!injectionPromise) return undefined
			const content = await withTimeout(injectionPromise, injectionTimeoutMs)
			if (!content) return undefined
			return {
				message: {
					customType: INJECTION_CUSTOM_TYPE,
					content,
					display: false,
				},
			}
		},
	)

	// ─── Hook: agent_start — a new run resets Pi's turnIndex ───────────
	pi.on("agent_start", async (_event, _ctx) => {
		agentRunIndex += 1
	})

	// ─── Hook: message_start — remember the pending user turn ──────────
	pi.on("message_start", async (event, _ctx) => {
		if (!config.captureEnabled) return
		if (event.message.role === "user") {
			const text = extractMessageText(event.message)
			if (text) pendingUserText = text
		}
	})

	// ─── Hook: turn_end — buffer user + assistant captures ─────────────
	pi.on("turn_end", async (event, ctx) => {
		if (!config.captureEnabled || !deps.isAvailable()) return
		const sessionId = safeSessionId(ctx)
		const run = Math.max(agentRunIndex, 0)
		const items: BufferedCapture[] = []
		if (pendingUserText) {
			items.push({
				role: "user",
				body: pendingUserText,
				key: captureIdempotencyKey(sessionId, run, event.turnIndex, "user"),
				sessionId,
				turnIndex: event.turnIndex,
			})
			pendingUserText = null
		}
		if (event.message.role === "assistant") {
			const text = extractMessageText(event.message)
			if (text) {
				items.push({
					role: "assistant",
					body: text,
					key: captureIdempotencyKey(
						sessionId,
						run,
						event.turnIndex,
						"assistant",
					),
					sessionId,
					turnIndex: event.turnIndex,
				})
			}
		}
		await enqueueCaptures(items)
	})

	// ─── Hook: session_shutdown — best-effort final flush ──────────────
	pi.on("session_shutdown", async (_event, _ctx) => {
		await flushCaptures()
	})

	return { flushCaptures }
}
