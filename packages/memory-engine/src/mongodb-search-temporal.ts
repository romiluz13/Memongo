/**
 * Temporal-coverage search helpers extracted from `mongodb-manager.ts`
 * (P4.3): temporal query detection, coverage term extraction, and
 * session/timeline ordering used by the searchV2 temporal lanes.
 */

import { createHash } from "node:crypto"
import type { MemorySearchResult } from "./types.js"
import { RECOMMENDATION_MEMORY_QUERY_RE } from "./mongodb-search-ranking.js"

const TEMPORAL_COVERAGE_QUERY_RE =
	/\b(?:last|latest|recent|recently|since|before|after|when|months?|years?|weeks?|days?|passed|ago|january|february|march|april|may|june|july|august|september|october|november|december)\b/i

const CONVERSATION_EVIDENCE_QUERY_RE =
	/\b(?:previous conversation|earlier conversation|past conversation|last conversation|we discussed|we talked|i said|i told you|did i|did we|have i|have we|how many|remind me|appointments?)\b/i

const TEMPORAL_COVERAGE_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"been",
	"being",
	"but",
	"by",
	"could",
	"did",
	"do",
	"does",
	"for",
	"had",
	"has",
	"many",
	"much",
	"passed",
	"since",
	"last",
	"latest",
	"recent",
	"recently",
	"before",
	"after",
	"when",
	"month",
	"months",
	"year",
	"years",
	"week",
	"weeks",
	"day",
	"days",
	"ago",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"its",
	"may",
	"me",
	"might",
	"my",
	"not",
	"of",
	"on",
	"or",
	"our",
	"should",
	"so",
	"that",
	"the",
	"their",
	"these",
	"they",
	"this",
	"those",
	"to",
	"user",
	"was",
	"we",
	"were",
	"what",
	"where",
	"which",
	"who",
	"whom",
	"why",
	"will",
	"would",
	"with",
	"from",
	"you",
	"your",
])

const TEMPORAL_COVERAGE_WEAK_TERMS = new Set([
	"go",
	"goes",
	"going",
	"gone",
	"visit",
	"visited",
	"visiting",
	"visits",
])

const TEMPORAL_COVERAGE_TIMELINE_EVENT_LIMIT = 12

export function isTemporalCoverageQuery(
	query: string,
	questionDate: Date | undefined,
): boolean {
	return Boolean(
		questionDate &&
			!Number.isNaN(questionDate.getTime()) &&
			TEMPORAL_COVERAGE_QUERY_RE.test(query),
	)
}

export function isConversationEvidenceQuery(
	query: string,
	questionDate: Date | undefined,
): boolean {
	return (
		CONVERSATION_EVIDENCE_QUERY_RE.test(query) ||
		RECOMMENDATION_MEMORY_QUERY_RE.test(query) ||
		isTemporalCoverageQuery(query, questionDate)
	)
}

function expandTemporalCoverageTerm(term: string): string[] {
	const terms = new Set([term])
	if (term.endsWith("ies") && term.length > 4) {
		terms.add(`${term.slice(0, -3)}y`)
	}
	if (term.endsWith("s") && term.length > 4) {
		terms.add(term.slice(0, -1))
	}
	if (term.endsWith("ed") && term.length > 4) {
		terms.add(term.slice(0, -2))
	}
	if (term.endsWith("ing") && term.length > 5) {
		terms.add(term.slice(0, -3))
	}
	return Array.from(terms)
}

export function extractTemporalCoverageTerms(query: string): string[] {
	const rawTerms = query
		.toLowerCase()
		.split(/\s+/)
		.map((word) => word.replace(/[^a-z0-9]/g, ""))
		.filter((word) => word.length >= 3)
		.filter((word) => !TEMPORAL_COVERAGE_STOP_WORDS.has(word))
	const expanded = new Set<string>()
	for (const term of rawTerms) {
		for (const expandedTerm of expandTemporalCoverageTerm(term)) {
			if (expandedTerm.length >= 3) expanded.add(expandedTerm)
		}
	}
	return Array.from(expanded).slice(0, 12)
}

export function extractTemporalCoverageAnchorTerms(terms: string[]): string[] {
	const anchors = terms.filter(
		(term) => !TEMPORAL_COVERAGE_WEAK_TERMS.has(term),
	)
	return anchors.length > 0 ? anchors : terms
}

export function scoreTemporalCoverageSessionEvent(
	body: string,
	terms: string[],
	timestamp: Date | undefined,
	questionDate: Date | undefined,
): number {
	const bodyLower = body.toLowerCase()
	const matches = terms.filter((term) => bodyLower.includes(term)).length
	const overlap = terms.length > 0 ? matches / terms.length : 0
	const temporalScore =
		timestamp && questionDate
			? Math.max(
					0,
					1 -
						Math.abs(questionDate.getTime() - timestamp.getTime()) /
							(365 * 24 * 60 * 60 * 1000),
				)
			: 0
	return 0.04 + overlap * 0.08 + temporalScore * 0.02
}

export function orderTemporalCoverageBySession(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const bySession = new Map<string, MemorySearchResult[]>()
	const withoutSession: MemorySearchResult[] = []
	for (const result of results) {
		if (!result.sessionId) {
			withoutSession.push(result)
			continue
		}
		const sessionResults = bySession.get(result.sessionId)
		if (sessionResults) {
			sessionResults.push(result)
		} else {
			bySession.set(result.sessionId, [result])
		}
	}
	for (const sessionResults of bySession.values()) {
		sessionResults.sort((left, right) => right.score - left.score)
	}

	const output: MemorySearchResult[] = []
	let depth = 0
	while (output.length < results.length) {
		let added = false
		for (const sessionResults of bySession.values()) {
			const result = sessionResults[depth]
			if (result) {
				output.push(result)
				added = true
			}
		}
		if (!added) break
		depth++
	}
	return [...output, ...withoutSession]
}

function temporalCoverageBucketKey(result: MemorySearchResult): string {
	if (!result.timestamp) return "unknown"
	return result.timestamp.toISOString().slice(0, 7)
}

export function orderTemporalCoverageByTimeBucket(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const byBucket = new Map<string, MemorySearchResult[]>()
	for (const result of results) {
		const key = temporalCoverageBucketKey(result)
		const bucket = byBucket.get(key)
		if (bucket) {
			bucket.push(result)
		} else {
			byBucket.set(key, [result])
		}
	}

	for (const bucket of byBucket.values()) {
		bucket.sort((left, right) => right.score - left.score)
	}

	const bucketEntries = [...byBucket.entries()].sort(([left], [right]) => {
		if (left === "unknown") return 1
		if (right === "unknown") return -1
		return right.localeCompare(left)
	})
	const output: MemorySearchResult[] = []
	const seenPaths = new Set<string>()
	for (let depth = 0; depth < 2; depth++) {
		for (const [, bucket] of bucketEntries) {
			const result = bucket[depth]
			if (!result || seenPaths.has(result.path)) continue
			output.push(result)
			seenPaths.add(result.path)
		}
	}

	for (const result of results) {
		if (seenPaths.has(result.path)) continue
		output.push(result)
		seenPaths.add(result.path)
	}
	return output
}

function isUserAuthoredTemporalResult(result: MemorySearchResult): boolean {
	return result.provenance?.eventRole === "user"
}

function chooseTemporalTimelinePrimary(
	results: MemorySearchResult[],
): MemorySearchResult {
	return results.toSorted((left, right) => {
		const roleDelta =
			(isUserAuthoredTemporalResult(right) ? 1 : 0) -
			(isUserAuthoredTemporalResult(left) ? 1 : 0)
		if (roleDelta !== 0) return roleDelta
		return right.score - left.score
	})[0]
}

function orderTemporalTimelineSourceEvidence(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const bySession = new Map<string, MemorySearchResult[]>()
	const withoutSession: MemorySearchResult[] = []
	for (const result of results) {
		if (!result.sessionId) {
			withoutSession.push(result)
			continue
		}
		const sessionResults = bySession.get(result.sessionId)
		if (sessionResults) {
			sessionResults.push(result)
		} else {
			bySession.set(result.sessionId, [result])
		}
	}
	const primaries = new Set<string>()
	const primaryResults = Array.from(bySession.values()).map(
		(sessionResults) => {
			const primary = chooseTemporalTimelinePrimary(sessionResults)
			primaries.add(primary.path)
			return primary
		},
	)
	return [
		...primaryResults,
		...withoutSession,
		...results.filter((result) => !primaries.has(result.path)),
	]
}

export function buildTemporalCoverageTimelineResult(
	query: string,
	results: MemorySearchResult[],
): MemorySearchResult | null {
	const timelineResults = orderTemporalTimelineSourceEvidence(results)
	const visibleTimelineResults = timelineResults.slice(
		0,
		TEMPORAL_COVERAGE_TIMELINE_EVENT_LIMIT,
	)
	const sourceEventIds = [
		...new Set(
			visibleTimelineResults.flatMap((result) =>
				Array.isArray(result.sourceEventIds) ? result.sourceEventIds : [],
			),
		),
	]
	const sessionIds = [
		...new Set(
			results
				.map((result) => result.sessionId)
				.filter((sessionId): sessionId is string => Boolean(sessionId)),
		),
	]
	if (sourceEventIds.length === 0 || sessionIds.length < 2) return null

	const timeline = timelineResults
		.slice(0, TEMPORAL_COVERAGE_TIMELINE_EVENT_LIMIT)
		.map((result) => {
			const timestamp = result.timestamp
				? result.timestamp.toISOString().slice(0, 10)
				: "unknown-date"
			const session = result.sessionId ? ` session=${result.sessionId}` : ""
			return `- ${timestamp}${session}: ${result.snippet.replace(/\s+/g, " ").slice(0, 220)}`
		})
		.join("\n")
	const hash = createHash("sha256")
		.update(`${query}\n${sourceEventIds.join("\n")}`)
		.digest("hex")
		.slice(0, 16)
	const topScore =
		results.length > 0 ? Math.max(...results.map((result) => result.score)) : 0

	return {
		path: `temporal-coverage/${hash}`,
		filePath: `temporal-coverage/${hash}`,
		startLine: 0,
		endLine: 0,
		score: Math.max(0, topScore - 0.05),
		snippet: `Temporal event timeline for: ${query}\n${timeline}`,
		source: "conversation",
		sourceType: "conversation",
		canonicalId: `temporal-coverage/${hash}`,
		sourceEventIds,
		provenance: {
			lane: "temporal-coverage-timeline",
			temporalCoverage: true,
			temporalTimeline: true,
			sessionIds,
		},
	}
}

export function orderTimelineAfterSourceEvidence(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	const timelineResults = results.filter(
		(result) => result.provenance?.temporalTimeline === true,
	)
	if (timelineResults.length === 0) return results
	const sourceResults = results.filter(
		(result) => result.provenance?.temporalTimeline !== true,
	)
	if (sourceResults.length === 0) return results
	return [...sourceResults, ...timelineResults]
}
