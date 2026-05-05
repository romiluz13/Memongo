import type { Db } from "mongodb"
import { emitTelemetry } from "./mongodb-telemetry.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryRewriteConfig = {
	enabled: boolean
	method: "synonym-expansion" | "llm" | "hyde"
	maxTokens: number
}

export type QueryRewriteResult = {
	originalQuery: string
	rewrittenQuery: string
	rewritten: boolean
	method: string
}

// ---------------------------------------------------------------------------
// Synonym and abbreviation maps
// ---------------------------------------------------------------------------

/**
 * Domain-specific synonym map for agent memory queries.
 * Bidirectional: each key expands to its values.
 */
const SYNONYM_MAP: Record<string, string[]> = {
	auth: ["authentication", "login", "oauth"],
	db: ["database", "mongodb", "collection"],
	// H7 audit fix: removed cross-domain expansions for "api" and "ui"
	// "api" is not a synonym of "route"/"rest"; "ui" is not a synonym of "frontend"/"component"
	bug: ["issue", "error", "defect"],
	perf: ["performance", "latency", "speed"],
	config: ["configuration", "settings", "options"],
	deps: ["dependencies", "packages", "modules"],
	deploy: ["deployment", "release", "publish"],
	docs: ["documentation", "readme", "guide"],
	test: ["testing", "tests", "spec"],
	refactor: ["restructure", "reorganize", "cleanup"],
}

/** Abbreviation expansions (unidirectional: abbreviation -> full form) */
const ABBREVIATION_MAP: Record<string, string> = {
	ts: "typescript",
	js: "javascript",
	py: "python",
	env: "environment",
	var: "variable",
	fn: "function",
	cb: "callback",
	req: "request",
	res: "response",
	err: "error",
	msg: "message",
	ctx: "context",
	impl: "implementation",
	repo: "repository",
}

// ---------------------------------------------------------------------------
// Synonym expansion (deterministic, zero latency)
// ---------------------------------------------------------------------------

/**
 * Deterministic synonym expansion.
 * For each word in the query:
 *   1. Check if it is an abbreviation -- add full form
 *   2. Check if it matches a synonym group -- add all synonyms
 * Original words are always preserved.
 */
export function expandSynonyms(query: string): string {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	const expanded = new Set(words)
	// H7 audit fix: cap total expanded words at 3x the original word count.
	// Original words always survive; the cap limits new additions.
	const maxTotal = words.length * 3

	for (const word of words) {
		// Abbreviation expansion
		const abbr = ABBREVIATION_MAP[word]
		if (abbr && expanded.size < maxTotal) {
			expanded.add(abbr)
		}
		// Synonym expansion
		const syns = SYNONYM_MAP[word]
		if (syns) {
			for (const syn of syns) {
				if (expanded.size >= maxTotal) {
					break
				}
				expanded.add(syn)
			}
		}
	}

	return [...expanded].join(" ")
}

// ---------------------------------------------------------------------------
// Query rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite a query for improved vector search recall.
 *
 * CRITICAL: The retrieval planner must ALWAYS see the ORIGINAL query.
 * This function is called AFTER planRetrieval() and BEFORE search execution.
 * The cache key must also use the ORIGINAL query.
 *
 * Tier 1 (synonym-expansion): Deterministic, zero latency.
 *   - Expand known abbreviations
 *   - Add synonyms for recognized terms
 *   - Preserve original terms (expansion, not replacement)
 */
export async function rewriteQuery(params: {
	db: Db
	prefix: string
	agentId: string
	query: string
	config: QueryRewriteConfig
}): Promise<QueryRewriteResult> {
	const { db, prefix, agentId, query, config } = params
	const rewriteStart = Date.now()

	if (!config.enabled || !query.trim()) {
		return {
			originalQuery: query,
			rewrittenQuery: query,
			rewritten: false,
			method: "none",
		}
	}

	let rewritten: string
	let method: string

	switch (config.method) {
		case "synonym-expansion":
			rewritten = expandSynonyms(query)
			method = "synonym-expansion"
			break
		case "llm":
		case "hyde":
			// H3 audit fix: throw instead of silent fallback — make config errors explicit
			throw new Error(
				`Query rewrite method "${config.method}" is not yet implemented. ` +
					`Use "synonym-expansion" or disable query rewriting (queryRewriting.enabled: false).`,
			)
		default:
			rewritten = query
			method = "none"
	}

	const wasRewritten = rewritten !== query
	if (wasRewritten) {
		// Truncate to maxTokens (rough approximation: 1 token ~ 4 chars)
		const maxChars = config.maxTokens * 4
		if (rewritten.length > maxChars) {
			rewritten = rewritten.slice(0, maxChars).trimEnd()
		}
	}

	emitTelemetry(db, prefix, {
		meta: { agentId, operation: "query-rewrite" },
		durationMs: Date.now() - rewriteStart,
		ok: true,
		queryRewritten: wasRewritten,
		rewriteMethod: method,
	})

	return {
		originalQuery: query,
		rewrittenQuery: rewritten,
		rewritten: wasRewritten,
		method,
	}
}
