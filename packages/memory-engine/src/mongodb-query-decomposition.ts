/**
 * LLM-powered query decomposition for preference retrieval.
 *
 * Query-time counterpart to the document-time LLM enrichment in
 * mongodb-llm-enrichment.ts. Breaks a user query into 2-4 specific
 * sub-queries that match stored evidence better, then merges results
 * using Reciprocal Rank Fusion (RRF).
 *
 * Behind MEMONGO_QUERY_DECOMPOSITION_MODE flag:
 *   - "enabled": decompose queries via LLM before search
 *   - "none" (default): pass query through unchanged
 *
 * @module memory:mongodb:query-decomposition
 */

import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { rrfScore } from "./mongodb-hybrid.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecompositionMode = "enabled" | "none"

export type DecompositionResult = {
	subQueries: string[]
	original: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SUB_QUERIES = 4

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export function resolveDecompositionMode(
	envValue: string | undefined,
): DecompositionMode {
	if (typeof envValue !== "string") return "none"
	const normalized = envValue.trim().toLowerCase()
	if (normalized === "enabled") return "enabled"
	return "none"
}

// ---------------------------------------------------------------------------
// Decomposition prompt
// ---------------------------------------------------------------------------

const DECOMPOSITION_SYSTEM_PROMPT = `You are a query decomposition engine for an AI memory retrieval system.

Given a user query, break it into 2-4 specific sub-queries that would match stored personal facts and evidence about the user.

Rules:
- Each sub-query should target a different aspect of the original query
- Sub-queries should use specific vocabulary that would match user facts (e.g., possessions, activities, preferences)
- For recommendation queries, generate sub-queries about what the user owns, does, or prefers
- For advice queries, generate sub-queries about the user's situation and constraints
- Keep sub-queries concise (under 20 words each)

Respond with valid JSON only:
{
  "sub_queries": ["What does the user grow in their garden?", "What cooking ingredients does the user have at home?"]
}`

// ---------------------------------------------------------------------------
// Query decomposition
// ---------------------------------------------------------------------------

export async function decomposeQuery(params: {
	provider: EnrichmentProvider
	model: string
	query: string
	questionType?: string
}): Promise<DecompositionResult> {
	const fallback: DecompositionResult = {
		subQueries: [params.query],
		original: params.query,
	}

	let userContent = `Query: ${params.query}`
	if (params.questionType) {
		userContent += `\nQuestion type: ${params.questionType}`
	}

	let response: { content: string }
	try {
		response = await params.provider.chatCompletion({
			model: params.model,
			messages: [
				{ role: "system", content: DECOMPOSITION_SYSTEM_PROMPT },
				{ role: "user", content: userContent },
			],
			responseFormat: { type: "json_object" },
			maxTokens: 512,
		})
	} catch {
		return fallback
	}

	let parsed: unknown
	try {
		const stripped = response.content
			.replace(/^```(?:json)?\s*\n?/i, "")
			.replace(/\n?```\s*$/i, "")
		parsed = JSON.parse(stripped)
	} catch {
		return fallback
	}

	if (!parsed || typeof parsed !== "object") return fallback
	const record = parsed as Record<string, unknown>

	const rawQueries = Array.isArray(record.sub_queries) ? record.sub_queries : []
	const subQueries = rawQueries
		.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
		.slice(0, MAX_SUB_QUERIES)

	if (subQueries.length === 0) return fallback

	return { subQueries, original: params.query }
}

// ---------------------------------------------------------------------------
// Multi-query result merge using RRF
// ---------------------------------------------------------------------------

type MergeableResult = {
	path: string
	score: number
	snippet: string
	[key: string]: unknown
}

function isProtectedAggregateResult(result: MergeableResult): boolean {
	const provenance = result.provenance
	return (
		Boolean(provenance) &&
		typeof provenance === "object" &&
		(provenance as { temporalTimeline?: unknown }).temporalTimeline === true
	)
}

function protectedAggregateKey(result: MergeableResult): string {
	if (isProtectedAggregateResult(result)) return "temporalTimeline"
	return resultIdentityKey(result)
}

function resultIdentityKey(result: MergeableResult): string {
	if (typeof result.path === "string" && result.path.trim().length > 0) {
		return `path:${result.path.trim()}`
	}
	if (
		typeof result.canonicalId === "string" &&
		result.canonicalId.trim().length > 0
	) {
		return `canonical:${result.canonicalId.trim()}`
	}
	if (
		typeof result.filePath === "string" &&
		result.filePath.trim().length > 0
	) {
		return `file:${result.filePath.trim()}`
	}
	return `snippet:${result.snippet}`
}

function collectStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: []
}

function mergeOrderedStrings(
	primary: string[],
	secondary: Set<string>,
): Set<string> {
	const merged = new Set<string>()
	for (const value of primary) merged.add(value)
	for (const value of secondary) merged.add(value)
	return merged
}

/**
 * Merge results from multiple sub-query searches using Reciprocal Rank Fusion.
 *
 * Each result set is treated as a ranked list. Results appearing in multiple
 * lists accumulate RRF scores. Deduplication uses a stable result identity.
 */
export function mergeMultiQueryResults(
	resultSets: MergeableResult[][],
	topK: number,
): MergeableResult[] {
	if (resultSets.length === 0) return []

	const scoreMap = new Map<
		string,
		{ totalRrf: number; bestResult: MergeableResult }
	>()
	const protectedMap = new Map<
		string,
		{
			result: MergeableResult
			sourceEventIds: Set<string>
			sessionIds: Set<string>
		}
	>()

	for (const results of resultSets) {
		for (let rank = 0; rank < results.length; rank++) {
			const result = results[rank]
			if (isProtectedAggregateResult(result)) {
				const key = protectedAggregateKey(result)
				const existing = protectedMap.get(key)
				const provenance =
					result.provenance && typeof result.provenance === "object"
						? (result.provenance as Record<string, unknown>)
						: {}
				if (!existing) {
					protectedMap.set(key, {
						result,
						sourceEventIds: new Set(collectStringArray(result.sourceEventIds)),
						sessionIds: new Set(collectStringArray(provenance.sessionIds)),
					})
				} else {
					const sourceEventIds = collectStringArray(result.sourceEventIds)
					const sessionIds = collectStringArray(provenance.sessionIds)
					for (const eventId of sourceEventIds) {
						existing.sourceEventIds.add(eventId)
					}
					for (const sessionId of sessionIds) {
						existing.sessionIds.add(sessionId)
					}
					if (result.score > existing.result.score) {
						existing.result = result
						existing.sourceEventIds = mergeOrderedStrings(
							sourceEventIds,
							existing.sourceEventIds,
						)
						existing.sessionIds = mergeOrderedStrings(
							sessionIds,
							existing.sessionIds,
						)
					}
				}
			}
			const rrf = rrfScore(rank + 1) // 1-based rank
			const key = resultIdentityKey(result)
			const existing = scoreMap.get(key)
			if (existing) {
				existing.totalRrf += rrf
				if (result.score > existing.bestResult.score) {
					existing.bestResult = result
				}
			} else {
				scoreMap.set(key, {
					totalRrf: rrf,
					bestResult: result,
				})
			}
		}
	}

	const protectedResults = Array.from(protectedMap.values())
		.map((entry) => ({
			...entry.result,
			sourceEventIds: Array.from(entry.sourceEventIds),
			provenance: {
				...((entry.result.provenance &&
				typeof entry.result.provenance === "object"
					? entry.result.provenance
					: {}) as Record<string, unknown>),
				sessionIds: Array.from(entry.sessionIds),
			},
		}))
		.toSorted((left, right) => right.score - left.score)
		.slice(0, 1)
	const protectedKeys = new Set(protectedResults.map(resultIdentityKey))
	const fusedResults = Array.from(scoreMap.values())
		.sort((a, b) => b.totalRrf - a.totalRrf)
		.map((entry) => ({
			...entry.bestResult,
			score: entry.totalRrf,
		}))
		.filter((result) => !protectedKeys.has(resultIdentityKey(result)))

	return [...protectedResults, ...fusedResults].slice(0, topK)
}
