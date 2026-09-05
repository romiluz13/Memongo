/**
 * Search ranking helpers extracted from `mongodb-manager.ts` (P4.3 god-file
 * split): lane fusion and merge utilities, preference/recency/access boosts,
 * result identity/dedupe, reranking, source resolution, and search-request
 * normalization. Internal seam module — the manager re-exports the public
 * contract; nothing here is added to the package barrels.
 */

import type { Document } from "mongodb"
import type { MemoryScope } from "@memongo/lib"
import { createSubsystemLogger } from "@memongo/lib"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import { rrfScore } from "./mongodb-hybrid.js"
import type { ProcedureState } from "./mongodb-procedures.js"
import type {
	RelevanceArtifact,
	RelevanceHealth,
	RelevanceSourceScope,
} from "./mongodb-relevance.js"
import { MONGODB_MAX_NUM_CANDIDATES } from "./mongodb-search.js"
import type {
	StructuredMemorySalience,
	StructuredMemoryState,
} from "./mongodb-structured-memory.js"
import {
	applySearchConfig,
	resolveProfileNumCandidates,
	resolveSearchConfig,
} from "./mongodb-search-executor.js"
import type {
	MemorySearchManager,
	MemorySearchRequest,
	MemorySearchResult,
	MemorySearchMetadata,
	MemorySearchMode,
	MemorySource,
	ResolvedSearchConfig,
} from "./types.js"

export const VALID_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
])
export const VALID_ROLES: ReadonlySet<string> = new Set([
	"user",
	"assistant",
	"system",
	"tool",
])
const VALID_STRUCTURED_STATES: ReadonlySet<StructuredMemoryState> = new Set([
	"active",
	"invalidated",
	"conflicted",
])
const VALID_STRUCTURED_SALIENCE: ReadonlySet<StructuredMemorySalience> =
	new Set(["critical", "high", "normal", "low"])

const VALID_PROCEDURE_STATES: ReadonlySet<ProcedureState> = new Set([
	"active",
	"invalidated",
	"conflicted",
])

export function isBenchmarkStrictMode(): boolean {
	const v = process.env.MEMONGO_BENCHMARK_STRICT
	return v === "1" || v?.toLowerCase() === "true"
}

export type RelevanceExplainResult = {
	runId?: string
	latencyMs: number
	sourceScope: RelevanceSourceScope
	health: RelevanceHealth
	fallbackPath?: string
	sampleRate: number
	artifacts: RelevanceArtifact[]
	results: MemorySearchResult[]
}

export function isBenchmarkTurnPrecisionMode(): boolean {
	return process.env.MEMONGO_BENCHMARK_TURN_PRECISION_MODE === "enabled"
}

/**
 * #66: how many times the measurement (evaluation) loop runs over one
 * already-ingested scenario corpus. Ingest costs ~48 minutes and dominates a
 * run, so extra passes are the cheap way to get n>1 samples of the same
 * condition. Default 1 reproduces single-sample behavior exactly.
 */

export function isTemporalCoverageMode(): boolean {
	return (
		process.env.MEMONGO_TEMPORAL_COVERAGE_MODE === "enabled" ||
		process.env.MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE === "enabled"
	)
}

export function buildSearchFilterEquals(
	path: string,
	value: unknown,
): Document | null {
	if (Array.isArray(value)) {
		return value.length > 0 ? { in: { path, value } } : null
	}
	if (typeof value === "string" && value.trim().length > 0) {
		return { equals: { path, value } }
	}
	return null
}

export function mapEventSearchDocToResult(
	doc: Document,
	lane: "turn-vector" | "turn-text",
): MemorySearchResult | null {
	const eventId = typeof doc.eventId === "string" ? doc.eventId.trim() : ""
	const body = typeof doc.body === "string" ? doc.body : ""
	if (!eventId || !body) return null
	const score = typeof doc.score === "number" ? doc.score : 0
	return {
		path: `events/${eventId}`,
		filePath: `events/${eventId}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: body.slice(0, 700),
		source: "conversation",
		sourceType: "conversation",
		canonicalId: `event:${eventId}`,
		...(typeof doc.sessionId === "string" ? { sessionId: doc.sessionId } : {}),
		...(doc.timestamp instanceof Date ? { timestamp: doc.timestamp } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		// P3.7 wiring: project the reinforcement counter where the lane has it
		// (events) so the post-CE access boost reads a real value.
		...(typeof doc.accessCount === "number" && Number.isFinite(doc.accessCount)
			? { accessCount: doc.accessCount }
			: {}),
		sourceEventIds: [eventId],
		provenance: {
			lane,
			turnPrecisionRerank: true,
			...(typeof doc.role === "string" ? { eventRole: doc.role } : {}),
		},
	}
}

export function mergeRankedResultSets(
	resultSets: MemorySearchResult[][],
): MemorySearchResult[] {
	const activeSets = resultSets.filter((results) => results.length > 0)
	if (activeSets.length <= 1) {
		return activeSets[0]?.map((result) => ({ ...result })) ?? []
	}
	const byIdentity = new Map<
		string,
		MemorySearchResult & { originalScore: number; rrfScore: number }
	>()
	for (const results of resultSets) {
		for (let index = 0; index < results.length; index++) {
			const result = results[index]
			const key = searchResultIdentityKey(result)
			const score = rrfScore(index + 1)
			const existing = byIdentity.get(key)
			if (existing) {
				existing.rrfScore += score
				existing.score = existing.rrfScore
				if (result.score > existing.originalScore) {
					Object.assign(existing, {
						...result,
						originalScore: result.score,
						rrfScore: existing.rrfScore,
						score: existing.rrfScore,
					})
				}
			} else {
				byIdentity.set(key, {
					...result,
					originalScore: result.score,
					rrfScore: score,
					score,
				})
			}
		}
	}
	return Array.from(byIdentity.values())
		.toSorted((left, right) => right.rrfScore - left.rrfScore)
		.map(
			({ originalScore: _originalScore, rrfScore: _rrfScore, ...result }) =>
				result,
		)
}

export function mergeTurnPrecisionResults(
	resultSets: MemorySearchResult[][],
): MemorySearchResult[] {
	return mergeRankedResultSets(resultSets)
}

export const RECOMMENDATION_MEMORY_QUERY_RE =
	/\b(?:advice|tips?|suggest(?:ion)?s?|recommend(?:ation)?s?|accessor(?:y|ies)|complement|setup|prefer|preference)\b|(?:\bwhat\s+should\s+i\b|\bany\s+(?:tips?|suggestions?|recommendations?)\b)/i

const FIRST_PERSON_MEMORY_SIGNAL_RE =
	/\b(?:i(?:'m| am|'ve| have|'d| would)?|my|we(?:'re| are|'ve| have|'d| would)?|our)\b/i
const PREFERENCE_CONTEXT_SIGNAL_RE =
	/\b(?:like|love|prefer|favorite|enjoy|use|using|used|have|own|bought|purchased|consider(?:ing)?|try(?:ing)?|attend(?:ed|ing)?|learn(?:ed|ing)?|made|make|harvest(?:ed|ing)?|grew|grow(?:n|ing)?|garden(?:ing)?|class|course|travel|accessor(?:y|ies)|ingredient(?:s)?|setup|routine|habit)\b/i
const FIRST_PERSON_ACTIVITY_SIGNAL_RE =
	/\b(?:i(?:'ve| have| am|'m)?|we(?:'ve| have| are|'re)?|my|our)\b.{0,96}\b(?:like|love|prefer|enjoy|use|using|used|have|own|bought|purchased|consider(?:ing)?|try(?:ing)?|attend(?:ed|ing)?|learn(?:ed|ing)?|made|make|harvest(?:ed|ing)?|grew|grow(?:n|ing)?|garden(?:ing)?|class|course|travel|setup|routine|habit)\b/i

export function scorePreferenceGroundingSignalBoost(
	query: string,
	result: MemorySearchResult,
): number {
	if (!RECOMMENDATION_MEMORY_QUERY_RE.test(query)) {
		return 0
	}
	if (result.provenance?.eventRole !== "user") {
		return 0
	}
	const snippet = result.snippet.toLowerCase()
	let boost = 0.04
	if (
		FIRST_PERSON_MEMORY_SIGNAL_RE.test(snippet) &&
		PREFERENCE_CONTEXT_SIGNAL_RE.test(snippet)
	) {
		boost += 0.16
	}
	if (FIRST_PERSON_ACTIVITY_SIGNAL_RE.test(snippet)) {
		boost += 0.08
	}
	if (
		/\b(?:compatible|specifically designed|designed for|as a .* user)\b/i.test(
			snippet,
		)
	) {
		boost += 0.08
	}
	return Math.min(boost, 0.32)
}

export function applyPreferenceEvidenceBoostAfterRerank(
	query: string,
	results: MemorySearchResult[],
): MemorySearchResult[] {
	if (!RECOMMENDATION_MEMORY_QUERY_RE.test(query)) {
		return results
	}
	return results
		.map((result, index) => ({
			result: {
				...result,
				score:
					result.score + scorePreferenceGroundingSignalBoost(query, result),
			},
			index,
		}))
		.toSorted(
			(left, right) =>
				right.result.score - left.result.score || left.index - right.index,
		)
		.map(({ result }) => result)
}

// P3.7: post-cross-encoder recency/access boost. The CE rerank overwrites
// `score`, erasing every pre-CE boost; this hook reintroduces recency and
// reinforcement as multiplicative factors on the CE score:
//   score *= (1 + alpha * (recencyNorm - 0.5)) * (1 + beta * (accessNorm - 0.5))
// Both norms are min-max normalized to [0,1] across the result set, so the
// factors are relative to the set and calibration-free. Degenerate sets
// (single value, missing fields) normalize to 0.5, i.e. a neutral factor.
const DEFAULT_RECENCY_ACCESS_BOOST_WEIGHT = 0.2

function normalizeRecencyAccessValues(
	values: (number | undefined)[],
): (number | undefined)[] {
	const present = values.filter(
		(value): value is number => typeof value === "number",
	)
	if (present.length <= 1) {
		// Degenerate set: every present value is neutral.
		return values.map((value) => (typeof value === "number" ? 0.5 : undefined))
	}
	const min = Math.min(...present)
	const max = Math.max(...present)
	if (max === min) {
		return values.map((value) => (typeof value === "number" ? 0.5 : undefined))
	}
	return values.map((value) =>
		typeof value === "number" ? (value - min) / (max - min) : undefined,
	)
}

export function applyRecencyAccessBoostAfterRerank(
	results: MemorySearchResult[],
	options?: { recencyBoost?: number; accessBoost?: number },
): MemorySearchResult[] {
	const recencyBoost =
		options?.recencyBoost ?? DEFAULT_RECENCY_ACCESS_BOOST_WEIGHT
	const accessBoost =
		options?.accessBoost ?? DEFAULT_RECENCY_ACCESS_BOOST_WEIGHT
	// Zero weights are the off-switch: skip the pass so scores stay
	// bit-identical to the CE output.
	if (recencyBoost === 0 && accessBoost === 0) {
		return results
	}
	const recencyNorms = normalizeRecencyAccessValues(
		results.map((result) =>
			result.timestamp instanceof Date ? result.timestamp.getTime() : undefined,
		),
	)
	const accessNorms = normalizeRecencyAccessValues(
		results.map((result) =>
			typeof result.accessCount === "number" &&
			Number.isFinite(result.accessCount)
				? result.accessCount
				: undefined,
		),
	)
	return results
		.map((result, index) => {
			// Missing fields degrade to a neutral factor, never a penalty.
			const recencyNorm = recencyNorms[index] ?? 0.5
			const accessNorm = accessNorms[index] ?? 0.5
			return {
				result: {
					...result,
					score:
						result.score *
						(1 + recencyBoost * (recencyNorm - 0.5)) *
						(1 + accessBoost * (accessNorm - 0.5)),
				},
				index,
			}
		})
		.toSorted(
			(left, right) =>
				right.result.score - left.result.score || left.index - right.index,
		)
		.map(({ result }) => result)
}

export function stripSessionSummaryTurnProvenance(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	return results.map((result) => {
		if (!result.canonicalId?.startsWith("session-chunk/")) {
			return result
		}
		const { sourceEventIds: _sourceEventIds, ...rest } = result
		return {
			...rest,
			provenance: {
				...(result.provenance ?? {}),
				turnPrecisionSourceEventIdsSuppressed: true,
			},
		}
	})
}

// Result dedup utility — exported for testing and reuse
// ---------------------------------------------------------------------------

export function searchResultIdentityKey(result: MemorySearchResult): string {
	const canonicalId = result.canonicalId?.trim()
	if (canonicalId) return `canonical:${canonicalId}`
	const sourceEventIds = (result.sourceEventIds ?? [])
		.map((id) => id.trim())
		.filter(Boolean)
		.toSorted()
	if (sourceEventIds.length > 0) {
		return `events:${sourceEventIds.join("|")}`
	}
	const locator = [
		result.path || result.filePath || "",
		result.startLine ?? "",
		result.endLine ?? "",
		result.sessionId ?? "",
	]
		.map(String)
		.join(":")
	if (locator.replaceAll(":", "").trim().length > 0) {
		return `loc:${locator}`
	}
	return `snippet:${result.snippet}`
}

/**
 * Deduplicate search results by stable evidence identity.
 * Falls back to snippet text only when the result has no canonical id,
 * source event id, or locator.
 */
export function deduplicateSearchResults(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	if (results.length === 0) {
		return []
	}

	const seen = new Map<string, MemorySearchResult>()
	for (const result of results) {
		const key = searchResultIdentityKey(result)
		const existing = seen.get(key)
		if (!existing || result.score > existing.score) {
			seen.set(key, result)
		}
	}

	return Array.from(seen.values())
}

// ---------------------------------------------------------------------------
// Heuristic reranker
// ---------------------------------------------------------------------------

/**
 * Configurable weights for the heuristic reranker.
 */
export type RerankWeights = {
	/** Penalty per excess result from same source (default 0.15) */
	diversityWeight?: number
	/** Bonus for episode results (default 0.12) */
	episodeBoost?: number
}

/**
 * Heuristic reranker for v2 search results.
 * - Source diversity penalty: no more than 2 results from the same source at the top
 * - Episode priority boost: episode results get a score boost
 *
 * Does not mutate the original array.
 * Recency boost deferred (needs timestamp in MemorySearchResult interface).
 */
export function rerankResults(
	results: MemorySearchResult[],
	_query: string,
	weights?: RerankWeights,
): MemorySearchResult[] {
	if (results.length === 0) {
		return []
	}

	const diversityWeight = weights?.diversityWeight ?? 0.15
	const episodeBoost = weights?.episodeBoost ?? 0.12

	// Score each result (copy, don't mutate)
	const scored = results.map((r) => ({
		result: r,
		adjustedScore: r.score,
	}))

	// 1. Episode priority boost
	for (const entry of scored) {
		if (entry.result.path.startsWith("episode:")) {
			entry.adjustedScore += episodeBoost
		}
	}

	// 2. Sort by adjusted score descending
	scored.sort((a, b) => b.adjustedScore - a.adjustedScore)

	// 3. Source diversity penalty: penalize 3rd+ result from same source
	const sourceCounts = new Map<string, number>()
	for (const entry of scored) {
		const source = entry.result.source
		const count = (sourceCounts.get(source) ?? 0) + 1
		sourceCounts.set(source, count)
		if (count > 2) {
			entry.adjustedScore -= diversityWeight * (count - 2)
		}
	}

	// 4. Re-sort after diversity penalty
	scored.sort((a, b) => b.adjustedScore - a.adjustedScore)

	return scored.map((s) => s.result)
}

// ---------------------------------------------------------------------------
// Source policy helpers — exported for testing and reuse
// ---------------------------------------------------------------------------

type SourceConfig = {
	reference: { enabled: boolean }
	conversation: { enabled: boolean }
	structured: { enabled: boolean }
}

/**
 * Determine which search sources are active based on source policy config.
 * Reference (KB) search additionally requires KB to be enabled.
 */
export function getActiveSources(
	sources: SourceConfig | undefined,
	kbEnabled: boolean,
): { conversation: boolean; reference: boolean; structured: boolean } {
	if (!sources) {
		// Default: all sources enabled when no source config is present (backward compat)
		return { conversation: true, reference: kbEnabled, structured: true }
	}
	return {
		conversation: sources.conversation.enabled,
		reference: sources.reference.enabled && kbEnabled,
		structured: sources.structured.enabled,
	}
}

// ---------------------------------------------------------------------------
// searchDetailed helpers
// ---------------------------------------------------------------------------

/**
 * P2.8 defense-in-depth: the HTTP API clamps search limits at the route
 * layer, but non-API callers (MCP stdio, direct engine embedding, internal
 * fallbacks) can pass any maxResults. An unbounded result set blows up
 * fusion/rerank memory, so every public search entry point clamps to this
 * ceiling regardless of caller.
 */
export const MAX_SEARCH_MAX_RESULTS = 100

export function clampSearchMaxResults(value: number): number {
	if (!Number.isFinite(value)) {
		return MAX_SEARCH_MAX_RESULTS
	}
	return Math.max(1, Math.min(MAX_SEARCH_MAX_RESULTS, Math.floor(value)))
}

/**
 * WS-16 (C-030): conversation queries are clamped to this ceiling before the
 * hot path consumes them — ahead of autoEmbed (a 2k+ char query still pays a
 * full embedding call), BM25 (megabyte-scale $search terms), the query-cache
 * probe (unbounded cache keys), and rerank (providers meter input tokens).
 * The HTTP API never enforced a query-length limit, so any caller could push
 * arbitrarily large payloads into every lane. ~2,000 characters is the
 * established conversation-query budget: enough for long multi-sentence
 * questions with context, small enough to bound every downstream consumer.
 */
export const MAX_SEARCH_QUERY_LENGTH = 2000

/**
 * Clamp a trimmed query to {@link MAX_SEARCH_QUERY_LENGTH}. Callers compare
 * the pre-clamp length against the constant to decide whether to emit the
 * `search-query-clamped` telemetry event.
 */
export function clampSearchQuery(query: string): string {
	return query.length > MAX_SEARCH_QUERY_LENGTH
		? query.slice(0, MAX_SEARCH_QUERY_LENGTH)
		: query
}

export function normalizeDetailedSearchRequest(
	request: MemorySearchRequest,
): MemorySearchRequest {
	const query = clampSearchQuery(request.query.trim())
	const configuredRequest = applySearchConfig({
		...request,
		query,
	})
	return {
		...configuredRequest,
		query,
		searchMode: configuredRequest.searchMode ?? "auto",
		maxResults: clampSearchMaxResults(configuredRequest.maxResults ?? 10),
		minScore: configuredRequest.minScore ?? 0.1,
		needExactEvidence: configuredRequest.needExactEvidence === true,
		returnPlan: configuredRequest.returnPlan === true,
		...(configuredRequest.maxPasses != null
			? {
					maxPasses: Math.max(1, Math.min(4, configuredRequest.maxPasses)),
				}
			: {}),
	}
}

export function resolveRuntimeSearchConfig(
	request: MemorySearchRequest,
	mongoCfg: ResolvedMongoDBConfig,
): ResolvedSearchConfig {
	const resolved = resolveSearchConfig(request)
	const recallProfile =
		request.searchConfig?.recallProfile ??
		mongoCfg.recallProfile ??
		resolved.recallProfile
	const recommendedNumCandidates = Math.min(
		Math.max(mongoCfg.numCandidates, resolved.maxResults * 20),
		MONGODB_MAX_NUM_CANDIDATES,
	)
	const requestedNumCandidates =
		resolved.numCandidates ??
		request.searchConfig?.numCandidates ??
		recommendedNumCandidates
	return {
		recipe: resolved.recipe,
		recallProfile,
		maxResults: resolved.maxResults,
		searchMode: resolved.searchMode,
		maxPasses: resolved.maxPasses,
		sourcePreference: resolved.sourcePreference,
		timeRange: resolved.timeRange,
		needExactEvidence: resolved.needExactEvidence,
		numCandidates:
			resolveProfileNumCandidates({
				maxResults: resolved.maxResults,
				recallProfile,
				requested: requestedNumCandidates,
			}) ?? recommendedNumCandidates,
		fusionMethod: resolved.fusionMethod ?? mongoCfg.fusionMethod,
		hybridMode: resolved.hybridMode,
		allowHybridBackstop: resolved.allowHybridBackstop,
		lexicalPrefilter: resolved.lexicalPrefilter,
	}
}

export function shouldUseDetailedSearchCache(
	request: MemorySearchRequest,
): boolean {
	const config = request.searchConfig
	if (!config) {
		return true
	}
	return (
		config.recipe === undefined &&
		(config.recallProfile === undefined ||
			config.recallProfile === "balanced") &&
		config.numCandidates === undefined &&
		config.fusionMethod === undefined &&
		config.hybridMode === undefined &&
		config.allowHybridBackstop === undefined &&
		config.lexicalPrefilter === undefined
	)
}

export function emptySearchMetadata(
	request: MemorySearchRequest,
): MemorySearchMetadata {
	const resolvedSearchConfig = request.searchConfig
	return {
		mode: (request.searchMode ?? "auto") as MemorySearchMode,
		classification: "direct",
		sourceOrder: request.sourcePreference ?? [
			"conversation",
			"structured",
			"reference",
		],
		...(resolvedSearchConfig
			? {
					resolvedSearchConfig:
						resolvedSearchConfig as unknown as ResolvedSearchConfig,
				}
			: {}),
		passes: [],
		queriesTried: [],
		constraintsApplied: [],
		resultsRejected: [],
		evidenceCoverage: "none",
		pathsExecuted: [],
		resultsByPath: {},
		queryRewritten: false,
		reranked: false,
	}
}

export function normalizeStructuredState(
	value: string | string[] | undefined,
): StructuredMemoryState | StructuredMemoryState[] | undefined {
	if (Array.isArray(value)) {
		const states = value.filter((state): state is StructuredMemoryState =>
			VALID_STRUCTURED_STATES.has(state as StructuredMemoryState),
		)
		return states.length > 0 ? states : undefined
	}
	if (
		typeof value === "string" &&
		VALID_STRUCTURED_STATES.has(value as StructuredMemoryState)
	) {
		return value as StructuredMemoryState
	}
	return undefined
}

export function normalizeStructuredSalience(
	value: string[] | undefined,
): StructuredMemorySalience[] | undefined {
	if (!Array.isArray(value)) {
		return undefined
	}
	const salience = value.filter((entry): entry is StructuredMemorySalience =>
		VALID_STRUCTURED_SALIENCE.has(entry as StructuredMemorySalience),
	)
	return salience.length > 0 ? salience : undefined
}

export function normalizeProcedureState(
	value: string | undefined,
): ProcedureState | undefined {
	if (
		typeof value === "string" &&
		VALID_PROCEDURE_STATES.has(value as ProcedureState)
	) {
		return value as ProcedureState
	}
	return undefined
}

/**
 * Return the list of active source names for status reporting.
 * Only sources that are actually enabled are included.
 */
export function getActiveSourcesForStatus(
	sources: SourceConfig | undefined,
	kbEnabled: boolean,
): MemorySource[] {
	const active = getActiveSources(sources, kbEnabled)
	const names: MemorySource[] = []
	if (active.conversation) {
		names.push("conversation")
	}
	if (active.reference) {
		names.push("reference")
	}
	if (active.structured) {
		names.push("structured")
	}
	return names
}

export type ActiveSources = {
	conversation: boolean
	reference: boolean
	structured: boolean
}

/**
 * Resolve which sources to query in relevanceExplain based on the requested
 * sourceScope AND the active source policy. Disabled sources always return
 * false even when explicitly requested via sourceScope.
 */
export function resolveExplainSources(
	sourceScope: RelevanceSourceScope,
	activeSources: ActiveSources,
): ActiveSources {
	switch (sourceScope) {
		case "memory":
			return {
				conversation: activeSources.conversation,
				reference: false,
				structured: false,
			}
		case "kb":
			return {
				conversation: false,
				reference: activeSources.reference,
				structured: false,
			}
		case "structured":
			return {
				conversation: false,
				reference: false,
				structured: activeSources.structured,
			}
		default:
			return { ...activeSources }
	}
}

import type { MongoDBMemoryManager } from "./mongodb-manager.js"

const log = createSubsystemLogger("memory:mongodb:search")

// ---------------------------------------------------------------------------
// WS-16 (C-029): BM25 text-analyzer strategy
// ---------------------------------------------------------------------------

/**
 * Env knob selecting the analyzer strategy for natural-language fields in
 * every Atlas Search text index definition. The default (`standard`)
 * reproduces the historical `lucene.standard` pinning bit-for-bit; existing
 * deployments see no index drift until they opt in. The default flips to
 * `folding` only after the retrieval eval gate (benchmark harness,
 * before/after on the sample corpus) passes — see
 * `mongodb-schema-search-indexes.ts` for the rebuild/migration path.
 */
export const SEARCH_TEXT_ANALYZER_ENV = "MEMONGO_SEARCH_TEXT_ANALYZER"

export type SearchTextAnalyzerStrategy =
	| { kind: "standard" }
	| { kind: "folding" }
	| { kind: "language"; analyzer: string }

const LANGUAGE_ANALYZER_RE = /^lucene\.[a-z][a-z0-9]*$/i

/**
 * Resolve the configured analyzer strategy. Accepted values: unset or
 * `standard` (historical behavior), `folding` (`lucene.folding` — diacritic
 * folding), or a full language analyzer name such as `lucene.french`
 * (validated by name only; the server rejects unknown analyzers at index
 * build time). Unknown values fall back to `standard` with a warning so a
 * typo can never mint a broken index definition.
 */
export function resolveSearchTextAnalyzer(
	raw: string | undefined = process.env[SEARCH_TEXT_ANALYZER_ENV],
): SearchTextAnalyzerStrategy {
	const value = raw?.trim().toLowerCase()
	if (!value || value === "standard") {
		return { kind: "standard" }
	}
	if (value === "folding") {
		return { kind: "folding" }
	}
	if (LANGUAGE_ANALYZER_RE.test(value)) {
		return { kind: "language", analyzer: value }
	}
	log.warn(
		`unknown ${SEARCH_TEXT_ANALYZER_ENV} value "${raw}" (expected "standard", "folding", or a lucene.<language> analyzer name); falling back to lucene.standard`,
	)
	return { kind: "standard" }
}

/** The concrete analyzer name to pin in index definitions. */
export function searchTextAnalyzerName(
	strategy: SearchTextAnalyzerStrategy,
): string {
	switch (strategy.kind) {
		case "standard":
			return "lucene.standard"
		case "folding":
			return "lucene.folding"
		case "language":
			return strategy.analyzer
	}
}

/**
 * Whether identifier-heavy fields get the dual keyword+folding mapping
 * (`string` with `lucene.keyword` plus a `.folded` sub-field) instead of the
 * historical `token` type. Only the improved strategies need it; `standard`
 * keeps bit-identical definitions so no drift is detected on existing
 * deployments.
 */
export function isIdentifierDualMappingEnabled(
	strategy: SearchTextAnalyzerStrategy,
): boolean {
	return strategy.kind !== "standard"
}

/** Type guard: checks if a MemorySearchManager supports structured memory writes (MongoDB backend). */
export function hasWriteCapability(
	manager: MemorySearchManager,
): manager is MongoDBMemoryManager {
	return "writeStructuredMemory" in manager
}

/** Type guard: checks if a MemorySearchManager supports relevance diagnostics. */
export function hasRelevanceCapability(
	manager: MemorySearchManager,
): manager is MongoDBMemoryManager {
	return "relevanceExplain" in manager
}

/** Redact credentials from a MongoDB connection string for safe logging. */
