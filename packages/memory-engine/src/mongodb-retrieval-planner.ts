import { createSubsystemLogger } from "@memongo/lib"
import type {
	MemoryConversationScope,
	MemoryProceduralScope,
	MemoryReferenceScope,
	MemorySearchClassification,
	MemorySearchSourcePreference,
	MemoryStructuredScope,
	MemorySearchTimeRange,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:planner")

export type RetrievalPath =
	| "active-critical"
	| "structured"
	| "raw-window"
	| "graph"
	| "hybrid"
	| "kb"
	| "episodic"
	| "procedural"

export type RetrievalTimeRangePreset =
	| "today"
	| "yesterday"
	| "last-24h"
	| "last-7d"
	| "this-week"
	| "last-30d"
	| "this-month"

export type RetrievalConstraints = {
	activeCritical?: {
		salience: Array<"critical" | "high">
		requireCurrent: boolean
		hard: boolean
		reason: string
	}
	timeRange?: {
		preset: RetrievalTimeRangePreset
		hard: boolean
		reason: string
	}
	structured?: {
		type?: string
		hard: boolean
		reason: string
	}
	kb?: {
		source?: "api" | "manual" | "file" | "url"
		category?: string
		hard: boolean
		reason: string
	}
	entities?: {
		names: string[]
		hard: boolean
		reason: string
	}
}

export type RetrievalPlan = {
	paths: RetrievalPath[]
	confidence: "high" | "medium" | "low"
	reasoning: string
	constraints?: RetrievalConstraints
	skippedLanes?: string[]
}

export type RetrievalContext = {
	/** Available sources based on config */
	availablePaths: Set<RetrievalPath>
	/** Known entity names for graph matching */
	knownEntityNames?: string[]
	/** Whether episodes exist */
	hasEpisodes?: boolean
	/** Whether graph has entities */
	hasGraphData?: boolean
	/** Lane coverage data for skipping empty lanes */
	laneCoverage?: Record<
		string,
		{ hasData: boolean; count: number; lastUpdated: Date | null }
	>
	intent?: {
		needExactEvidence?: boolean
		sourcePreference?: MemorySearchSourcePreference[]
		timeRange?: MemorySearchTimeRange
		conversationScope?: MemoryConversationScope
		structuredScope?: MemoryStructuredScope
		referenceScope?: MemoryReferenceScope
		proceduralScope?: MemoryProceduralScope
	}
}

// ---------------------------------------------------------------------------
// Keyword lists and pre-compiled word-boundary regexes
// ---------------------------------------------------------------------------

function buildKeywordRegexes(keywords: string[]): RegExp[] {
	return keywords.map(
		(kw) =>
			new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
	)
}

// Structured memory keywords
const STRUCTURED_KEYWORDS = [
	"prefer",
	"preference",
	"decision",
	"decided",
	"rule",
	"convention",
	"remember that",
	"my name",
	"i like",
	"i don't like",
	"always",
	"never",
	"todo",
	"task",
	"remind me",
]
const STRUCTURED_REGEXES = buildKeywordRegexes(STRUCTURED_KEYWORDS)

// Time-related keywords for raw-window detection
const TIME_KEYWORDS = [
	"today",
	"yesterday",
	"this morning",
	"this afternoon",
	"this evening",
	"last hour",
	"last week",
	"this week",
	"last month",
	"this month",
	"recent",
	"recently",
	"earlier today",
	"just now",
	"latest",
]
const TIME_REGEXES = buildKeywordRegexes(TIME_KEYWORDS)

// KB keywords
const KB_KEYWORDS = [
	"docs",
	"documentation",
	"reference",
	"manual",
	"guide",
	"how to",
	"instructions",
	"spec",
	"specification",
]
const KB_REGEXES = buildKeywordRegexes(KB_KEYWORDS)

// Episodic / summary keywords
const EPISODIC_KEYWORDS = [
	"summarize",
	"summary",
	"overview",
	"recap",
	"what happened",
	"highlights",
	"review",
	"report on",
	"digest",
]
const EPISODIC_REGEXES = buildKeywordRegexes(EPISODIC_KEYWORDS)

const ACTIVE_CRITICAL_KEYWORDS = [
	"what matters now",
	"what should you know right now",
	"what's the situation",
	"current situation",
	"going on with",
	"right now",
	"currently",
	"active blocker",
	"blocker",
	"constraint",
	"crisis",
	"war",
	"status",
]
const ACTIVE_CRITICAL_REGEXES = buildKeywordRegexes(ACTIVE_CRITICAL_KEYWORDS)

const PROCEDURAL_KEYWORDS = [
	"how do we",
	"workflow",
	"runbook",
	"process",
	"procedure",
	"playbook",
	"steps",
	"checklist",
]
const PROCEDURAL_REGEXES = buildKeywordRegexes(PROCEDURAL_KEYWORDS)

// Deterministic tie-breaking priority (lower = higher priority)
const PATH_PRIORITY: Record<RetrievalPath, number> = {
	"active-critical": 0,
	procedural: 1,
	structured: 2,
	"raw-window": 3,
	graph: 4,
	episodic: 5,
	kb: 6,
	hybrid: 7,
}

const STRUCTURED_TYPE_MATCHERS: Array<{ type: string; regexes: RegExp[] }> = [
	{
		type: "decision",
		regexes: buildKeywordRegexes(["decision", "decided", "choose", "chose"]),
	},
	{
		type: "preference",
		regexes: buildKeywordRegexes([
			"prefer",
			"preference",
			"i like",
			"i don't like",
		]),
	},
	{
		type: "todo",
		regexes: buildKeywordRegexes(["todo", "task", "remind me", "follow up"]),
	},
	{
		type: "person",
		regexes: buildKeywordRegexes(["who is", "person", "contact"]),
	},
	{
		type: "project",
		regexes: buildKeywordRegexes([
			"project plan",
			"project status",
			"project decision",
			"roadmap",
		]),
	},
	{
		type: "architecture",
		regexes: buildKeywordRegexes(["architecture", "design", "system design"]),
	},
	{
		type: "fact",
		regexes: buildKeywordRegexes(["fact", "remember that", "note that"]),
	},
]

const KB_SOURCE_MATCHERS: Array<{
	source?: "api" | "manual" | "file" | "url"
	category?: string
	regexes: RegExp[]
}> = [
	{
		category: "api",
		regexes: buildKeywordRegexes(["api", "endpoint", "rest api"]),
	},
	{ source: "manual", regexes: buildKeywordRegexes(["manual"]) },
	{ source: "file", regexes: buildKeywordRegexes(["file", "files"]) },
	{ source: "url", regexes: buildKeywordRegexes(["url", "link", "website"]) },
]

function startOfUtcDay(input: Date): Date {
	return new Date(
		Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()),
	)
}

function startOfUtcMonth(input: Date): Date {
	return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), 1))
}

function startOfUtcWeek(input: Date): Date {
	const day = input.getUTCDay()
	const diff = day === 0 ? 6 : day - 1
	const start = startOfUtcDay(input)
	start.setUTCDate(start.getUTCDate() - diff)
	return start
}

export function resolveTimeRangePreset(
	preset: RetrievalTimeRangePreset,
	now: Date = new Date(),
): { start: Date; end: Date } {
	const end = new Date(now)
	switch (preset) {
		case "today":
			return { start: startOfUtcDay(now), end }
		case "yesterday": {
			const todayStart = startOfUtcDay(now)
			const start = new Date(todayStart)
			start.setUTCDate(start.getUTCDate() - 1)
			const yesterdayEnd = new Date(todayStart.getTime() - 1)
			return { start, end: yesterdayEnd }
		}
		case "last-24h":
			return { start: new Date(end.getTime() - 24 * 60 * 60 * 1000), end }
		case "last-7d":
			return { start: new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000), end }
		case "this-week":
			return { start: startOfUtcWeek(now), end }
		case "last-30d":
			return { start: new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000), end }
		case "this-month":
			return { start: startOfUtcMonth(now), end }
	}
}

function extractTimeConstraint(
	query: string,
): RetrievalConstraints["timeRange"] | undefined {
	const lower = query.toLowerCase()
	if (/\byesterday\b/.test(lower)) {
		return {
			preset: "yesterday",
			hard: true,
			reason: "explicit yesterday constraint",
		}
	}
	if (
		/\b(today|this morning|this afternoon|this evening|earlier today)\b/.test(
			lower,
		)
	) {
		return {
			preset: "today",
			hard: true,
			reason: "explicit same-day constraint",
		}
	}
	if (/\b(last hour|recent|recently|just now|latest)\b/.test(lower)) {
		return {
			preset: "last-24h",
			hard: true,
			reason: "explicit recentness constraint",
		}
	}
	if (/\blast week\b/.test(lower)) {
		return {
			preset: "last-7d",
			hard: true,
			reason: "explicit last-week constraint",
		}
	}
	if (/\bthis week\b/.test(lower)) {
		return {
			preset: "this-week",
			hard: true,
			reason: "explicit this-week constraint",
		}
	}
	if (/\blast month\b/.test(lower)) {
		return {
			preset: "last-30d",
			hard: true,
			reason: "explicit last-month constraint",
		}
	}
	if (/\bthis month\b/.test(lower)) {
		return {
			preset: "this-month",
			hard: true,
			reason: "explicit this-month constraint",
		}
	}
	return undefined
}

function extractStructuredConstraint(
	query: string,
): RetrievalConstraints["structured"] | undefined {
	for (const matcher of STRUCTURED_TYPE_MATCHERS) {
		if (matcher.regexes.some((re) => re.test(query))) {
			return {
				type: matcher.type,
				hard: true,
				reason: `structured ${matcher.type} constraint detected`,
			}
		}
	}
	if (STRUCTURED_REGEXES.some((re) => re.test(query))) {
		return {
			hard: false,
			reason: "generic structured-memory signal detected",
		}
	}
	return undefined
}

function extractKBConstraint(
	query: string,
): RetrievalConstraints["kb"] | undefined {
	for (const matcher of KB_SOURCE_MATCHERS) {
		if (matcher.regexes.some((re) => re.test(query))) {
			return {
				...(matcher.source ? { source: matcher.source } : {}),
				...(matcher.category ? { category: matcher.category } : {}),
				hard: true,
				reason: matcher.category
					? `KB category constraint detected (${matcher.category})`
					: `KB source constraint detected (${matcher.source})`,
			}
		}
	}
	if (KB_REGEXES.some((re) => re.test(query))) {
		return {
			hard: false,
			reason: "generic KB/documentation signal detected",
		}
	}
	return undefined
}

function extractActiveCriticalConstraint(
	query: string,
): RetrievalConstraints["activeCritical"] | undefined {
	if (ACTIVE_CRITICAL_REGEXES.some((re) => re.test(query))) {
		return {
			salience: ["critical", "high"],
			requireCurrent: true,
			hard: false,
			reason: "current-state or active-context signal detected",
		}
	}
	return undefined
}

function extractEntityConstraint(
	query: string,
	knownEntityNames?: string[],
): RetrievalConstraints["entities"] | undefined {
	const lower = query.toLowerCase()
	const names =
		knownEntityNames
			?.map((name) => name.trim())
			.filter(
				(name) => name.length > 0 && lower.includes(name.toLowerCase()),
			) ?? []
	if (names.length === 0) {
		return undefined
	}
	return {
		names: Array.from(new Set(names)),
		hard: true,
		reason: "matched known entity names in query",
	}
}

function applyLaneFreshnessAdjustment(params: {
	scores: Record<RetrievalPath, number>
	laneCoverage?: RetrievalContext["laneCoverage"]
	freshnessSensitive: boolean
	reasons: string[]
	now?: Date
}) {
	if (!params.laneCoverage || !params.freshnessSensitive) {
		return
	}
	const now = params.now ?? new Date()
	for (const path of [
		"active-critical",
		"structured",
		"procedural",
		"episodic",
		"graph",
	] as const) {
		const coverage = params.laneCoverage[path]
		if (!coverage?.lastUpdated) {
			continue
		}
		const ageHours =
			(now.getTime() - coverage.lastUpdated.getTime()) / (60 * 60 * 1000)
		if (ageHours <= 24) {
			params.scores[path] += 1
		} else if (ageHours > 24 * 7) {
			params.scores[path] -= 1
			params.reasons.push(`deprioritized stale lane: ${path}`)
		}
	}
}

/**
 * Plan retrieval paths based on keyword heuristics and available sources.
 * Returns paths sorted by score descending, filtered by availability.
 */
export function planRetrieval(
	query: string,
	context: RetrievalContext,
): RetrievalPlan {
	try {
		// Guard: empty or whitespace-only query
		if (!query.trim()) {
			return {
				paths: context.availablePaths.has("hybrid") ? ["hybrid"] : [],
				confidence: "low" as const,
				reasoning: "empty query",
			}
		}

		const reasons: string[] = []
		const constraints: RetrievalConstraints = {}
		const classification = classifyRetrievalQuery({
			query,
			hasTimeRange: Boolean(context.intent?.timeRange),
			hasScopes: Boolean(
				context.intent?.conversationScope ||
					context.intent?.structuredScope ||
					context.intent?.referenceScope ||
					context.intent?.proceduralScope,
			),
		})

		// Score each path
		const scores: Record<RetrievalPath, number> = {
			"active-critical": 0,
			structured: 0,
			"raw-window": 0,
			graph: 0,
			hybrid: 0,
			kb: 0,
			episodic: 0,
			procedural: 0,
		}

		const activeCriticalConstraint = extractActiveCriticalConstraint(query)
		if (activeCriticalConstraint) {
			scores["active-critical"] += 4
			constraints.activeCritical = activeCriticalConstraint
			reasons.push(activeCriticalConstraint.reason)
		}

		// Check structured signals (word-boundary regex)
		const structuredConstraint = extractStructuredConstraint(query)
		if (structuredConstraint) {
			scores.structured += 3
			constraints.structured = structuredConstraint
			reasons.push(structuredConstraint.reason)
		}

		// Check time signals (word-boundary regex)
		const timeConstraint = extractTimeConstraint(query)
		if (timeConstraint ?? TIME_REGEXES.some((re) => re.test(query))) {
			scores["raw-window"] += 3
			if (timeConstraint) {
				constraints.timeRange = timeConstraint
				reasons.push(timeConstraint.reason)
			} else {
				reasons.push("time-related keywords detected")
			}
		}

		// Check entity/graph signals (filter empty names)
		const lower = query.toLowerCase()
		const entityConstraint = extractEntityConstraint(
			query,
			context.knownEntityNames,
		)
		if (entityConstraint) {
			scores.graph += 3
			constraints.entities = entityConstraint
			reasons.push(entityConstraint.reason)
		}
		if (
			lower.includes("who") ||
			lower.includes("relationship") ||
			lower.includes("connected")
		) {
			scores.graph += 2
			reasons.push("relationship query detected")
		}

		// Check KB signals (word-boundary regex)
		const kbConstraint = extractKBConstraint(query)
		if (kbConstraint) {
			scores.kb += 3
			constraints.kb = kbConstraint
			reasons.push(kbConstraint.reason)
		}

		// Check episodic signals (word-boundary regex)
		if (EPISODIC_REGEXES.some((re) => re.test(query))) {
			scores.episodic += 3
			reasons.push("episodic/summary keywords detected")
		}

		if (PROCEDURAL_REGEXES.some((re) => re.test(query))) {
			scores.procedural += 3
			reasons.push("procedural/workflow keywords detected")
		}

		if (context.intent?.structuredScope) {
			scores.structured += 4
			reasons.push("structured scope requested")
			if (
				context.intent.structuredScope.salience?.some(
					(value) => value === "critical" || value === "high",
				) ||
				context.intent.structuredScope.state === "active"
			) {
				scores["active-critical"] += 2
			}
		}

		if (context.intent?.proceduralScope) {
			scores.procedural += 4
			reasons.push("procedural scope requested")
		}

		if (context.intent?.referenceScope) {
			scores.kb += 4
			reasons.push("reference scope requested")
		}

		if (context.intent?.conversationScope?.sessionKey) {
			scores["raw-window"] += 2
			scores.hybrid += 1
			reasons.push("conversation scope requested")
		}

		if (context.intent?.needExactEvidence) {
			scores["raw-window"] += 1
			scores.structured += 1
			scores.procedural += 1
			scores.graph += 1
			reasons.push("exact evidence requested")
		}

		switch (classification) {
			case "family":
				scores.hybrid += 2
				scores.kb += 1
				scores.structured += 1
				scores.procedural += 1
				reasons.push("family-style breadth query detected")
				break
			case "comparison":
				scores.hybrid += 2
				scores.kb += 1
				scores.structured += 1
				scores.procedural += 1
				reasons.push("comparison query detected")
				break
			case "multi-hop":
				scores.graph += 2
				scores.episodic += 1
				scores.hybrid += 1
				reasons.push("multi-hop reasoning query detected")
				break
			case "temporal":
				scores["raw-window"] += 2
				scores.episodic += 1
				reasons.push("freshness-sensitive query detected")
				break
			case "scoped":
			case "direct":
				break
		}

		// Hybrid is always baseline
		scores.hybrid += 1

		applyLaneFreshnessAdjustment({
			scores,
			laneCoverage: context.laneCoverage,
			freshnessSensitive: Boolean(
				activeCriticalConstraint ||
					timeConstraint ||
					classification === "temporal",
			),
			reasons,
		})

		// Coverage-aware lane filtering:
		// hybrid/raw-window are backstop lanes (always have data after any event write).
		// kb is populated by a separate ingestion path, not writeEventAndProject,
		// so lane coverage has no signal for it.
		const NEVER_SKIP_LANES = new Set<RetrievalPath>([
			"hybrid",
			"raw-window",
			"kb",
		])
		const skippedLanes: string[] = []
		if (context.laneCoverage) {
			for (const [path] of Object.entries(scores) as [
				RetrievalPath,
				number,
			][]) {
				if (NEVER_SKIP_LANES.has(path)) {
					continue
				}
				const coverage = context.laneCoverage[path]
				if (coverage && !coverage.hasData) {
					scores[path] = -1 // Mark for exclusion
					skippedLanes.push(path)
				}
			}
			if (skippedLanes.length > 0) {
				reasons.push(`skipped empty lanes: ${skippedLanes.join(", ")}`)
			}
		}

		// Sort by score descending, then by priority for deterministic tie-breaking
		const sorted = (Object.entries(scores) as [RetrievalPath, number][])
			.filter(([path, score]) => context.availablePaths.has(path) && score >= 0)
			.toSorted(
				(a, b) => b[1] - a[1] || PATH_PRIORITY[a[0]] - PATH_PRIORITY[b[0]],
			)
			.map(([path]) => path)

		// Return empty paths if nothing available (do not inject unavailable hybrid)
		const finalPaths = sorted

		// Confidence based on signal strength
		const topScore = scores[finalPaths[0]] ?? 0
		const confidence = topScore >= 3 ? "high" : topScore >= 2 ? "medium" : "low"

		return {
			paths: finalPaths,
			confidence,
			reasoning:
				reasons.length > 0
					? reasons.join("; ")
					: "no strong signals, defaulting to hybrid",
			...(Object.keys(constraints).length > 0 ? { constraints } : {}),
			...(skippedLanes.length > 0 ? { skippedLanes } : {}),
		}
	} catch (err) {
		log.error("planRetrieval failed", { query, error: err })
		throw err
	}
}

/**
 * Classify a search query into one of the known search classifications.
 * Used by the search executor to determine pass strategy and MMR lambda.
 */
export function classifyRetrievalQuery(params: {
	query: string
	hasTimeRange?: boolean
	hasScopes?: boolean
}): MemorySearchClassification {
	const query = params.query.trim().toLowerCase()
	if (!query) {
		return "direct"
	}
	if (params.hasTimeRange || TIME_REGEXES.some((re) => re.test(query))) {
		return "temporal"
	}
	if (params.hasScopes) {
		return "scoped"
	}
	if (
		/\b(compare|comparison|difference|different|vs|versus|better than)\b/i.test(
			query,
		)
	) {
		return "comparison"
	}
	if (
		/\b(family|alternatives?|similar|related tools|ecosystem|what else|options|which tools|all the tools|all tools)\b/i.test(
			query,
		)
	) {
		return "family"
	}
	if (
		/\b(because|why did|how did|lead to|after that|before that|then what)\b/i.test(
			query,
		)
	) {
		return "multi-hop"
	}
	return "direct"
}
