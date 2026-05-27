/**
 * Post-retrieval scoring module — ranking-only boosts applied between
 * heuristic reranking and Voyage cross-encoder reranking.
 *
 * These helpers never retrieve new documents. They only adjust scores
 * on the existing candidate set and re-sort.
 *
 * Weights are MemPalace-informed benchmark defaults, configurable for
 * ablation.
 */

import type { MemorySearchResult } from "./types.js"

// ---------------------------------------------------------------------------
// Stop words (common English words that are not useful for keyword matching)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"again",
	"further",
	"then",
	"once",
	"and",
	"but",
	"or",
	"nor",
	"not",
	"so",
	"yet",
	"both",
	"either",
	"neither",
	"each",
	"every",
	"all",
	"any",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"only",
	"own",
	"same",
	"than",
	"too",
	"very",
	"just",
	"about",
	"also",
	"how",
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"why",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"mine",
	"we",
	"us",
	"our",
	"ours",
	"you",
	"your",
	"yours",
	"he",
	"him",
	"his",
	"she",
	"her",
	"hers",
	"it",
	"its",
	"they",
	"them",
	"their",
	"theirs",
	"if",
	"up",
	"out",
	"off",
	"over",
	"down",
])

const KEYWORD_EXPANSIONS: Record<string, string[]> = {
	accessories: [
		"accessory",
		"case",
		"cases",
		"pouch",
		"pouches",
		"battery",
		"batteries",
		"charger",
		"strap",
		"tripod",
		"bag",
	],
	accessory: [
		"accessories",
		"case",
		"pouch",
		"battery",
		"charger",
		"strap",
		"tripod",
		"bag",
	],
	photography: ["photo", "camera", "lens", "flash", "lighting"],
	photo: ["photography", "camera", "lens", "flash"],
	setup: ["gear", "equipment", "kit", "camera", "device", "devices"],
	gear: ["setup", "equipment", "kit"],
}

// ---------------------------------------------------------------------------
// Temporal pattern definitions
// ---------------------------------------------------------------------------

interface TemporalPattern {
	regex: RegExp
	windowDays: number
}

const TEMPORAL_PATTERNS: TemporalPattern[] = [
	{ regex: /\byesterday\b/i, windowDays: 2 },
	{ regex: /\ba\s+(?:few\s+)?days?\s+ago\b/i, windowDays: 5 },
	{ regex: /\ba\s+week\s+ago\b/i, windowDays: 7 },
	{ regex: /\blast\s+week\b/i, windowDays: 10 },
	{ regex: /\brecently\b/i, windowDays: 14 },
	{ regex: /\blast\s+month\b/i, windowDays: 30 },
	{ regex: /\ba\s+month\s+ago\b/i, windowDays: 30 },
	{ regex: /\blast\s+year\b/i, windowDays: 365 },
	{ regex: /\ba\s+year\s+ago\b/i, windowDays: 365 },
]

/** Default window when no temporal pattern is detected but questionDate exists */
const DEFAULT_TEMPORAL_WINDOW_DAYS = 30

// ---------------------------------------------------------------------------
// keywordOverlapBoost
// ---------------------------------------------------------------------------

/**
 * Extract non-stop-word keywords from the query, compute overlap ratio
 * against the snippet, and boost the score proportionally.
 */
export function keywordOverlapBoost(
	query: string,
	snippet: string,
	originalScore: number,
	weight = 0.3,
): number {
	if (!query || !snippet) return originalScore

	const keywords = extractKeywords(query)
	if (keywords.length === 0) return originalScore

	const snippetLower = snippet.toLowerCase()
	let matches = 0
	for (const kw of keywords) {
		const alternatives = [kw, ...(KEYWORD_EXPANSIONS[kw] ?? [])]
		if (alternatives.some((candidate) => snippetLower.includes(candidate))) {
			matches++
		}
	}

	const overlapRatio = matches / keywords.length
	return originalScore + originalScore * weight * overlapRatio
}

// ---------------------------------------------------------------------------
// temporalProximityBoost
// ---------------------------------------------------------------------------

/**
 * Parse relative time expressions ("a week ago", "last month", "recently"),
 * compute the distance between questionDate and result timestamp, and apply
 * a graduated linear falloff boost.
 */
export function temporalProximityBoost(
	query: string,
	questionDate: Date | undefined,
	resultTimestamp: Date | undefined,
	originalScore: number,
	maxBoost = 0.4,
): number {
	if (!questionDate || !resultTimestamp) return originalScore

	const windowDays = detectTemporalWindow(query)
	const windowMs = windowDays * 24 * 60 * 60 * 1000
	const distanceMs = Math.abs(
		questionDate.getTime() - resultTimestamp.getTime(),
	)

	if (distanceMs > windowMs) return originalScore

	// Linear falloff: full boost at distance 0, zero boost at window edge
	const proximity = 1 - distanceMs / windowMs
	return originalScore + originalScore * maxBoost * proximity
}

// ---------------------------------------------------------------------------
// entityNameBoost
// ---------------------------------------------------------------------------

/**
 * Extract capitalized proper nouns from the query and boost the score
 * when they appear in the snippet.
 */
export function entityNameBoost(
	query: string,
	snippet: string,
	originalScore: number,
	weight = 0.4,
): number {
	if (!query || !snippet) return originalScore

	const properNouns = extractProperNouns(query)
	if (properNouns.length === 0) return originalScore

	const snippetLower = snippet.toLowerCase()
	let matches = 0
	for (const noun of properNouns) {
		if (snippetLower.includes(noun.toLowerCase())) {
			matches++
		}
	}

	if (matches === 0) return originalScore
	const matchRatio = matches / properNouns.length
	return originalScore + originalScore * weight * matchRatio
}

// ---------------------------------------------------------------------------
// quotedPhraseBoost
// ---------------------------------------------------------------------------

/**
 * Extract double-quoted phrases from the query and boost when exact phrases
 * appear in the snippet (case-insensitive).
 */
export function quotedPhraseBoost(
	query: string,
	snippet: string,
	originalScore: number,
	weight = 0.6,
): number {
	if (!query || !snippet) return originalScore

	const phrases = extractQuotedPhrases(query)
	if (phrases.length === 0) return originalScore

	const snippetLower = snippet.toLowerCase()
	let matches = 0
	for (const phrase of phrases) {
		if (snippetLower.includes(phrase.toLowerCase())) {
			matches++
		}
	}

	if (matches === 0) return originalScore
	const matchRatio = matches / phrases.length
	return originalScore + originalScore * weight * matchRatio
}

// ---------------------------------------------------------------------------
// Composite scorer
// ---------------------------------------------------------------------------

export interface PostRetrievalScoringConfig {
	questionDate?: Date
	keywordWeight?: number
	temporalMaxBoost?: number
	entityWeight?: number
	quotedPhraseWeight?: number
}

/**
 * Apply all post-retrieval scoring boosts and re-sort by final score.
 * Ranking-only: never adds or removes results.
 */
export function applyPostRetrievalScoring(
	query: string,
	results: MemorySearchResult[],
	config?: PostRetrievalScoringConfig,
): MemorySearchResult[] {
	if (results.length === 0) return results

	const questionDate = config?.questionDate
	const kwWeight = config?.keywordWeight ?? 0.3
	const tempMaxBoost = config?.temporalMaxBoost ?? 0.4
	const entityW = config?.entityWeight ?? 0.4
	const quotedW = config?.quotedPhraseWeight ?? 0.6

	const scored = results.map((r) => {
		let score = r.score
		score = keywordOverlapBoost(query, r.snippet, score, kwWeight)
		score = temporalProximityBoost(
			query,
			questionDate,
			r.timestamp,
			score,
			tempMaxBoost,
		)
		score = entityNameBoost(query, r.snippet, score, entityW)
		score = quotedPhraseBoost(query, r.snippet, score, quotedW)
		return { ...r, score }
	})

	scored.sort((a, b) => b.score - a.score)
	return scored
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractKeywords(text: string): string[] {
	const words = text
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.replace(/[^a-z0-9]/g, ""))
		.filter(Boolean)
	return words.filter((w) => !STOP_WORDS.has(w) && w.length > 1)
}

function detectTemporalWindow(query: string): number {
	for (const pattern of TEMPORAL_PATTERNS) {
		if (pattern.regex.test(query)) {
			return pattern.windowDays
		}
	}
	return DEFAULT_TEMPORAL_WINDOW_DAYS
}

function extractProperNouns(text: string): string[] {
	// Match capitalized words that are NOT at the start of a sentence
	// and are NOT common sentence starters or stop words
	const words = text.split(/\s+/).filter(Boolean)
	const properNouns: string[] = []

	for (let i = 0; i < words.length; i++) {
		const word = words[i].replace(/[^a-zA-Z]/g, "")
		if (!word) continue

		// Must start with uppercase
		if (word[0] !== word[0].toUpperCase() || word[0] === word[0].toLowerCase())
			continue

		// Skip common sentence-start words
		if (i === 0 && SENTENCE_STARTERS.has(word.toLowerCase())) continue

		// Skip stop words that happen to be capitalized
		if (STOP_WORDS.has(word.toLowerCase())) continue

		// Skip very short words (likely abbreviations in queries)
		if (word.length < 2) continue

		properNouns.push(word)
	}
	return properNouns
}

const SENTENCE_STARTERS = new Set([
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"why",
	"how",
	"do",
	"does",
	"did",
	"can",
	"could",
	"would",
	"should",
	"is",
	"are",
	"was",
	"were",
	"find",
	"tell",
	"show",
	"get",
	"give",
	"search",
	"list",
])

function extractQuotedPhrases(text: string): string[] {
	const matches = text.match(/"([^"]+)"/g)
	if (!matches) return []
	return matches.map((m) => m.slice(1, -1)).filter((p) => p.length > 0)
}
