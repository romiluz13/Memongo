/**
 * @memongo/pi-extension — Memongo durable memory for the Pi coding agent.
 *
 * Additive: sits alongside pi-hermes-memory (local FTS5) and exposes
 * Memongo's hybrid vector + full-text + graph retrieval as NEW tools.
 * Does NOT replace any existing Pi memory tool.
 *
 * Tools:
 *   - memongo_search  — semantic/cross-project search over durable memory
 *   - memongo_save    — persist a durable structured fact/decision/preference
 *   - memongo_status  — probe Memongo API + vector search availability
 *
 * Config (env):
 *   MEMONGO_API_URL   — HTTP API base (default http://127.0.0.1:3847)
 *   MEMONGO_API_KEY   — bearer token (optional for local dev)
 *   MEMONGO_AGENT_ID  — agent identity (default "pi-agent")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { StringEnum } from "@earendil-works/pi-ai"
import { MemongoClient, MemongoClientError } from "@memongo/client"
import type { MemongoSearchDetailedResult } from "@memongo/client"

// Defaults are baked in so the extension works even when Pi doesn't inherit
// shell env vars (~/.zshrc). Env vars still override if present.
const API_URL = process.env.MEMONGO_API_URL ?? "http://127.0.0.1:3847"
const API_KEY = process.env.MEMONGO_API_KEY ?? "local-dev-secret"
const AGENT_ID = process.env.MEMONGO_AGENT_ID ?? "pi"

const SNIPPET_MAX = 400
const DEFAULT_LIMIT = 5

/**
 * Detect the project name from cwd — mirrors pi-hermes-memory's detectProject:
 * git repo root basename (so linked worktrees share one identity), or cwd
 * basename outside Git. Returns null for home/root (no project).
 */
function detectProject(cwd: string): string | null {
	const resolved = path.resolve(cwd)
	const home = path.resolve(os.homedir())
	if (resolved === home || resolved === "/" || !resolved) return null

	// Walk up looking for a .git dir or file (worktree-aware at the top level).
	let current = resolved
	while (true) {
		const dotGit = path.join(current, ".git")
		let stat: fs.Stats | undefined
		try {
			stat = fs.statSync(dotGit)
		} catch {
			stat = undefined
		}
		if (stat) return path.basename(current)
		const parent = path.dirname(current)
		if (parent === current) break
		current = parent
	}

	const name = path.basename(resolved)
	if (!name || name === "." || name === "..") return null
	return name
}

interface MemongoState {
	client: MemongoClient
	available: boolean
	lastError?: string
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text
	return `${text.slice(0, max)}…`
}

function errMsg(err: unknown): string {
	if (err instanceof MemongoClientError) {
		return `HTTP ${err.status}: ${truncate(err.body || err.message, 200)}`
	}
	return err instanceof Error ? err.message : String(err)
}

function formatResult(r: {
	path: string
	snippet: string
	score: number
	source: string
	scope?: string
	scopeRef?: string
	timestamp?: string
	state?: string
}): string {
	const meta = [
		`score=${r.score.toFixed(3)}`,
		r.scope ? `scope=${r.scope}${r.scopeRef ? `/${r.scopeRef}` : ""}` : null,
		r.state ? `state=${r.state}` : null,
		r.timestamp ? `ts=${r.timestamp}` : null,
	]
		.filter(Boolean)
		.join(" ")
	return `[${r.source}] ${r.path}\n  ${meta}\n  ${truncate(r.snippet, SNIPPET_MAX)}`
}

async function probeClient(client: MemongoClient): Promise<MemongoState> {
	try {
		await client.status(AGENT_ID)
		return { client, available: true }
	} catch (err) {
		return { client, available: false, lastError: errMsg(err) }
	}
}

export default async function memongoExtension(
	pi: ExtensionAPI,
): Promise<void> {
	const state = await probeClient(
		new MemongoClient({ baseUrl: API_URL, apiKey: API_KEY }),
	)

	// ─── Tool: memongo_search ──────────────────────────────────────────
	pi.registerTool({
		name: "memongo_search",
		label: "Memongo Search",
		description:
			"Search Memongo — the durable, cross-project, MongoDB-backed long-term memory — via hybrid vector + full-text + graph retrieval. Use for semantic or cross-session/cross-project recall that memory_search (local SQLite FTS5 keyword search) cannot find.",
		promptSnippet:
			"Search durable cross-project memory (Memongo) for semantic recall",
		promptGuidelines: [
			"Use memongo_search when you need semantic or cross-project recall that memory_search (local keyword FTS5) cannot find.",
			"Use concrete terms from the request — Memongo does hybrid vector + text + graph matching.",
			"If memongo_status shows unavailable, fall back to memory_search — do not retry Memongo repeatedly.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Natural-language search query",
			}),
			limit: Type.Optional(
				Type.Number({
					description: `Max results (default ${DEFAULT_LIMIT}, max 20)`,
					minimum: 1,
					maximum: 20,
				}),
			),
			project: Type.Optional(
				Type.String({
					description:
						"Narrow to a specific project (repo basename). Omit for cross-project search (default — the main value of Memongo).",
				}),
			),
			searchMode: Type.Optional(
				StringEnum(["auto", "direct", "agentic"] as const, {
					description:
						"auto = balanced (default), direct = fast single-pass, agentic = deep multi-pass",
				}),
			),
			minScore: Type.Optional(
				Type.Number({
					description: "Minimum relevance score 0-1",
					minimum: 0,
					maximum: 1,
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.available) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Memongo is not available: ${state.lastError ?? "unknown error"}. Use memory_search (local FTS5) instead.`,
						},
					],
					details: { error: true, available: false },
				}
			}
			try {
				const limit = params.limit ?? DEFAULT_LIMIT
				// If a project filter is given, fetch more candidates then post-filter by
				// scopeRef (repo basename) — Memongo's search API doesn't expose a
				// direct scopeRef filter, so we over-fetch and narrow in the adapter.
				const fetchLimit = params.project ? Math.min(limit * 4, 20) : limit
				// Search at `global` scope — Pi is single-user dogfood, so there's no
				// tenant to isolate from. The API defaults to `agent` scope which
				// returns 0 results for global-scoped memories. The client SDK's
				// searchDetailed doesn't accept scope, so call the API directly.
				const searchRes = await fetch(`${API_URL}/v1/search-detailed`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
					},
					body: JSON.stringify({
						query: params.query,
						agentId: AGENT_ID,
						scope: "global",
						limit: fetchLimit,
						maxResults: fetchLimit,
						searchMode: params.searchMode,
						minScore: params.minScore,
					}),
					signal,
				})
				if (!searchRes.ok) {
					const errBody = await searchRes.text().catch(() => "")
					return {
						content: [
							{
								type: "text" as const,
								text: `memongo_search failed: HTTP ${searchRes.status} ${truncate(errBody, 200)}`,
							},
						],
						details: { error: true, status: searchRes.status },
					}
				}
				const res = (await searchRes.json()) as {
					results?: Array<MemongoSearchDetailedResult>
				}
				let results = res.results ?? []
				if (params.project) {
					results = results.filter((r) => r.scopeRef === params.project)
				}
				results = results.slice(0, limit)
				if (results.length === 0) {
					const scopeNote = params.project
						? ` (filtered to project "${params.project}")`
						: ""
					return {
						content: [
							{
								type: "text" as const,
								text: `No Memongo results for "${params.query}"${scopeNote}.`,
							},
						],
						details: { count: 0, project: params.project ?? null },
					}
				}
				const lines = results.map((r, i) => `${i + 1}. ${formatResult(r)}`)
				return {
					content: [{ type: "text" as const, text: lines.join("\n\n") }],
					details: { count: results.length },
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `memongo_search failed: ${errMsg(err)}`,
						},
					],
					details: { error: true },
				}
			}
		},
	})

	// ─── Tool: memongo_save ────────────────────────────────────────────
	pi.registerTool({
		name: "memongo_save",
		label: "Memongo Save",
		description:
			"Save a durable structured memory (fact, decision, preference, instruction, problem) to Memongo — the cross-project long-term store. Survives across sessions and projects. Use for durable knowledge worth recalling semantically later, not for temporary task state.",
		promptSnippet: "Save durable structured memory to Memongo (cross-project)",
		promptGuidelines: [
			"Use memongo_save for durable facts, decisions, preferences, or instructions worth recalling across sessions/projects.",
			"Do NOT use for temporary task state — use the local memory tool for that.",
			"Provide a concise `key` (slug) and the full observation as `value`.",
			"Use scope='global' for knowledge that applies everywhere, 'user' for personal preferences, 'workspace' (default) for project-specific.",
			"The current project (git repo basename) is auto-detected and set as scopeRef for workspace scope — you only need to pass scopeRef to override.",
		],
		parameters: Type.Object({
			type: StringEnum(
				[
					"fact",
					"decision",
					"preference",
					"instruction",
					"problem",
					"person",
					"project",
					"architecture",
				] as const,
				{ description: "Memory type" },
			),
			key: Type.String({
				description:
					"Short unique identifier / slug (e.g. 'auth-token-rotation-policy')",
			}),
			value: Type.String({
				description: "The observation, fact, or decision text",
			}),
			context: Type.Optional(
				Type.String({ description: "Additional context or reasoning" }),
			),
			scope: Type.Optional(
				StringEnum(
					["user", "agent", "workspace", "tenant", "global"] as const,
					{ description: "Memongo scope (default: workspace)" },
				),
			),
			scopeRef: Type.Optional(
				Type.String({
					description: "Concrete namespace (e.g. repo path or project name)",
				}),
			),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Tags for filtering (e.g. ['failure', 'tool-quirk'])",
				}),
			),
			salience: Type.Optional(
				StringEnum(["critical", "high", "normal", "low"] as const, {
					description: "Importance level (default: normal)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.available) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Memongo is not available: ${state.lastError ?? "unknown error"}. Memory not saved — use the local memory tool instead.`,
						},
					],
					details: { error: true, available: false },
				}
			}
			try {
				const scope = params.scope ?? "workspace"
				// Auto-detect project from cwd (mirrors pi-hermes-memory). For
				// workspace scope, default scopeRef to the current git repo basename
				// unless the agent explicitly overrides it.
				let scopeRef = params.scopeRef
				if (!scopeRef && scope === "workspace") {
					const detected = ctx?.cwd ? detectProject(ctx.cwd) : undefined
					scopeRef = detected ?? undefined
				}
				const entry: Record<string, unknown> = {
					type: params.type,
					key: params.key,
					value: params.value,
					scope,
					salience: params.salience ?? "normal",
				}
				if (params.context) entry.context = params.context
				if (scopeRef) entry.scopeRef = scopeRef
				if (params.tags) entry.tags = params.tags

				const res = await state.client.writeStructured({
					entry,
					agentId: AGENT_ID,
				})
				const scopeSummary = scopeRef
					? ` [${scope}/${scopeRef}]`
					: ` [${scope}]`
				return {
					content: [
						{
							type: "text" as const,
							text: `Saved to Memongo: ${params.type}/${params.key}${scopeSummary} (id: ${res.id})`,
						},
					],
					details: {
						upserted: res.upserted,
						id: res.id,
						scope,
						scopeRef: scopeRef ?? null,
					},
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `memongo_save failed: ${errMsg(err)}`,
						},
					],
					details: { error: true },
				}
			}
		},
	})

	// ─── Tool: memongo_status ──────────────────────────────────────────
	pi.registerTool({
		name: "memongo_status",
		label: "Memongo Status",
		description:
			"Check Memongo API health, vector search availability, and document/chunk counts. Use before relying on memongo_search to confirm semantic search is operational.",
		promptSnippet: "Check Memongo availability and vector search status",
		promptGuidelines: [
			"Use memongo_status if unsure whether Memongo or vector search is available.",
		],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			try {
				const status = await state.client.status(AGENT_ID)
				let vectorOk = false
				try {
					const probe = await state.client.probeVector(AGENT_ID)
					vectorOk = probe.ok
				} catch {
					vectorOk = false
				}
				state.available = true
				state.lastError = undefined
				const parts = [
					`backend: ${status.backend}`,
					`provider: ${status.provider}`,
					status.files != null ? `files: ${status.files}` : null,
					status.chunks != null ? `chunks: ${status.chunks}` : null,
					status.vector
						? `vector: ${status.vector.enabled ? "enabled" : "disabled"}${status.vector.available != null ? ` (available: ${status.vector.available})` : ""}${status.vector.dims != null ? ` dims=${status.vector.dims}` : ""}`
						: null,
					`vector probe: ${vectorOk ? "ok" : "unavailable"}`,
					status.fts
						? `fts: ${status.fts.enabled ? "enabled" : "disabled"} (available: ${status.fts.available})`
						: null,
				].filter(Boolean)
				return {
					content: [{ type: "text" as const, text: parts.join(" | ") }],
					details: { available: true, vectorProbe: vectorOk },
				}
			} catch (err) {
				state.available = false
				state.lastError = errMsg(err)
				return {
					content: [
						{
							type: "text" as const,
							text: `Memongo unavailable: ${errMsg(err)}`,
						},
					],
					details: { error: true, available: false },
				}
			}
		},
	})

	// ─── Command: /memongo ─────────────────────────────────────────────
	pi.registerCommand("memongo", {
		description: "Show Memongo memory status and availability",
		async handler(_args, ctx) {
			try {
				const status = await state.client.status(AGENT_ID)
				let vectorOk = false
				try {
					vectorOk = (await state.client.probeVector(AGENT_ID)).ok
				} catch {
					vectorOk = false
				}
				state.available = true
				const lines = [
					`Memongo @ ${API_URL}`,
					`agent: ${AGENT_ID}`,
					`backend: ${status.backend}`,
					`provider: ${status.provider}`,
					status.files != null ? `files: ${status.files}` : null,
					status.chunks != null ? `chunks: ${status.chunks}` : null,
					`vector: ${vectorOk ? "ok" : "unavailable"}`,
					status.fts
						? `fts: ${status.fts.available ? "available" : "unavailable"}`
						: null,
				].filter(Boolean)
				ctx.ui.notify(lines.join("\n"), "info")
			} catch (err) {
				state.available = false
				state.lastError = errMsg(err)
				ctx.ui.notify(`Memongo unavailable: ${errMsg(err)}`, "error")
			}
		},
	})
}
