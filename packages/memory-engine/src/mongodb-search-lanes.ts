/**
 * Search lane executors extracted from `mongodb-manager.ts` (P4.3):
 * conversation/event lane queries, temporal-coverage expansion, graph query
 * candidates, and raw-window scoring used by searchV2.
 */

import type { Db, Document } from "mongodb"
import type { MemoryScope } from "@memongo/lib"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import type { Entity, RelationType } from "./mongodb-graph.js"
import type { MemorySearchExecutorTimeRange } from "./mongodb-search-executor.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { eventsCollection } from "./mongodb-schema.js"
import {
	consumeSearchAggregationOrThrow,
	resolveUserSearchMaxTimeMs,
	type SearchBudgetReservation,
	searchWorkDenialReason,
	tryConsumeSearchWork,
} from "./mongodb-search-budget.js"
import type { MemorySearchResult } from "./types.js"
import {
	EVENT_RESULT_PROJECTION,
	runEventRankFusion,
} from "./mongodb-event-rank-fusion.js"
import { selectSessionScopedTurns } from "./mongodb-session-scoped-selector.js"
import {
	buildSearchFilterEquals,
	deduplicateSearchResults,
	mapEventSearchDocToResult,
	scorePreferenceGroundingSignalBoost,
} from "./mongodb-search-ranking.js"
import {
	buildTemporalCoverageTimelineResult,
	extractTemporalCoverageAnchorTerms,
	extractTemporalCoverageTerms,
	isConversationEvidenceQuery,
	isTemporalCoverageQuery,
	orderTemporalCoverageBySession,
	orderTemporalCoverageByTimeBucket,
} from "./mongodb-search-temporal.js"
import type { CanonicalEvent } from "./mongodb-events.js"
import {
	freshnessRevalidationStages,
	runSearchAggregateWithRetry,
} from "./mongodb-search.js"
import { buildEventLifecycleClause } from "./mongodb-temporal.js"
import {
	type SearchTierOutcomeSink,
	toTypedSearchError,
} from "./search-outcomes.js"

async function expandTemporalCoverageSessionEvents(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionIds: string[]
	terms: string[]
	questionDate: Date
	maxPerSession: number
	maxEvents: number
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<MemorySearchResult[]> {
	const picked = await selectSessionScopedTurns({
		db: params.db,
		prefix: params.prefix,
		namespace: {
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
		},
		sessionIds: params.sessionIds,
		asOf: params.questionDate,
		perSession: params.maxPerSession,
		policy: {
			kind: "temporal-terms",
			terms: params.terms,
			candidateLimit: params.maxEvents * 4,
		},
		onTierOutcome: params.onTierOutcome,
	})
	const selected = picked.map(({ result }) => ({
		...result,
		provenance: {
			...(result.provenance ?? {}),
			lane: "temporal-session-expansion",
			temporalCoverage: true,
			temporalSessionExpansion: true,
		},
	}))
	return orderTemporalCoverageByTimeBucket(
		orderTemporalCoverageBySession(selected),
	).slice(0, params.maxEvents)
}

export async function searchTemporalCoverageEvents(params: {
	db: Db
	prefix: string
	query: string
	questionDate: Date | undefined
	agentId: string
	scope: MemoryScope
	scopeRef: string
	maxResults: number
	capabilities: DetectedCapabilities
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<MemorySearchResult[]> {
	const notApplicable = (
		stage: "plan" | "turn-text",
		reason: "query-shape" | "capability-absent",
	): MemorySearchResult[] => {
		params.onTierOutcome?.({ stage, outcome: "not-applicable", reason })
		return []
	}
	const temporalQuery = isTemporalCoverageQuery(
		params.query,
		params.questionDate,
	)
	if (!temporalQuery) {
		return notApplicable("plan", "query-shape")
	}
	// R1: an optional phase this deployment cannot serve is capability-absent.
	if (!params.capabilities.textSearch) {
		return notApplicable("turn-text", "capability-absent")
	}

	const terms = extractTemporalCoverageTerms(params.query)
	if (terms.length === 0 || !params.questionDate) {
		return notApplicable("plan", "query-shape")
	}
	const anchorTerms = extractTemporalCoverageAnchorTerms(terms)

	const filters = [
		buildSearchFilterEquals("agentId", params.agentId),
		buildSearchFilterEquals("scope", params.scope),
		buildSearchFilterEquals("scopeRef", params.scopeRef),
		{
			range: {
				path: "timestamp",
				lte: params.questionDate,
			},
		},
	].filter((value): value is Document => Boolean(value))

	const temporalPivotMs = 180 * 24 * 60 * 60 * 1000
	// $search candidates can be stale index admissions, so the current
	// owner/scope, timestamp, and lifecycle window are revalidated
	// post-stage against the hydrated document before limit/projection.
	const canonicalFilter: Document = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		timestamp: { $lte: params.questionDate },
	}
	const lifecycleMatch = buildEventLifecycleClause({
		asOf: params.questionDate,
	})
	const pipeline: Document[] = [
		{
			$search: {
				index: `${params.prefix}events_text`,
				compound: {
					filter: filters,
					must: [
						{
							text: {
								query: anchorTerms,
								path: "body",
							},
						},
					],
					should: [
						{
							text: {
								query: terms,
								path: "body",
							},
						},
						{
							near: {
								path: "timestamp",
								origin: params.questionDate,
								pivot: temporalPivotMs,
								score: { boost: { value: 2 } },
							},
						},
					],
				},
			},
		},
		...freshnessRevalidationStages(canonicalFilter),
		{ $match: lifecycleMatch },
		{ $limit: Math.max(params.maxResults * 3, 30) },
		{
			$project: {
				_id: 0,
				eventId: 1,
				body: 1,
				role: 1,
				sessionId: 1,
				timestamp: 1,
				scope: 1,
				scopeRef: 1,
				accessCount: 1,
				score: { $meta: "searchScore" },
			},
		},
	]

	// P3.2: this direct aggregate bypasses runSearchAggregateWithRetry, so it
	// consumes the per-request budget here; a refusal is a typed denial (L5).
	consumeSearchAggregationOrThrow("turn-text")
	let docs: Document[]
	try {
		docs = await eventsCollection(params.db, params.prefix)
			// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
			.aggregate(pipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
			.toArray()
	} catch (err) {
		throw toTypedSearchError(err, "turn-text")
	}
	params.onTierOutcome?.({
		stage: "turn-text",
		outcome: docs.length > 0 ? "ok" : "ok-empty",
		...(docs.length > 0 ? {} : { reason: "zero-hits" as const }),
		resultCount: docs.length,
	})
	const mapped = docs
		.map((doc) => mapEventSearchDocToResult(doc, "turn-text"))
		.filter((result): result is MemorySearchResult => Boolean(result))
		.map((result) => ({
			...result,
			score: result.score + 0.02,
			provenance: {
				...(result.provenance ?? {}),
				lane: "temporal-coverage",
				temporalCoverage: true,
			},
		}))

	const ordered = orderTemporalCoverageByTimeBucket(
		orderTemporalCoverageBySession(mapped),
	)
	const sessionIds = [
		...new Set(
			ordered
				.map((result) => result.sessionId)
				.filter((sessionId): sessionId is string => Boolean(sessionId)),
		),
	].slice(0, 5)
	const expandedSessionEvents = await expandTemporalCoverageSessionEvents({
		db: params.db,
		prefix: params.prefix,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionIds,
		terms,
		questionDate: params.questionDate,
		maxPerSession: 3,
		maxEvents: Math.max(params.maxResults, 30),
		onTierOutcome: params.onTierOutcome,
	})
	const timelineEvidence = orderTemporalCoverageByTimeBucket(
		orderTemporalCoverageBySession(
			deduplicateSearchResults([...expandedSessionEvents, ...ordered]),
		),
	)
	const timeline = buildTemporalCoverageTimelineResult(
		params.query,
		timelineEvidence.slice(0, Math.max(params.maxResults, 30)),
	)
	const eventResults = timelineEvidence.slice(0, params.maxResults)
	return timeline ? [timeline, ...eventResults] : eventResults
}

export async function searchTurnEventsWithinSessions(params: {
	db: Db
	prefix: string
	query: string
	/** Optional caller question clock for the validity window
	 * (validAt/invalidAt); defaults to wall-now. expiresAt retention always
	 * uses wall-now. Benchmark evaluations carry a fixed historical date. */
	questionDate?: Date
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionIds: string[]
	maxResults: number
	numCandidates: number
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
	queryEmbeddingModel: ResolvedMongoDBConfig["queryEmbeddingModel"]
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<MemorySearchResult[]> {
	const sessionIds = Array.from(new Set(params.sessionIds)).filter(
		(value) => value.trim().length > 0,
	)
	if (sessionIds.length === 0) {
		params.onTierOutcome?.({
			stage: "plan",
			outcome: "not-applicable",
			reason: "no-candidates",
		})
		return []
	}

	// The Search stages run against the indexed copy, which can lag a
	// retraction (invalidAt), an expiry (expiresAt), or an owner/scope/
	// session mutation. Post-stage, the full request filter AND the
	// lifecycle window are re-checked against the hydrated document so a
	// stale index admission cannot reach authoritative results.
	// Historical validity (validAt/invalidAt) uses the caller's question
	// clock when supplied; expiresAt is RETENTION and is always evaluated
	// at wall-now so a historical question cannot revive a turn awaiting
	// physical TTL deletion.
	const validityTime =
		params.questionDate && !Number.isNaN(params.questionDate.getTime())
			? params.questionDate
			: new Date()
	const lifecycleMatch: Document = {
		$and: [
			{
				$or: [
					{ validAt: { $exists: false } },
					{ validAt: { $lte: validityTime } },
				],
			},
			{ $or: [{ invalidAt: null }, { invalidAt: { $gt: validityTime } }] },
			{
				$or: [
					{ expiresAt: { $exists: false } },
					{ expiresAt: { $gt: new Date() } },
				],
			},
		],
	}
	const vectorFilter: Document = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: { $in: sessionIds },
	}
	const textFilters = [
		buildSearchFilterEquals("agentId", params.agentId),
		buildSearchFilterEquals("scope", params.scope),
		buildSearchFilterEquals("scopeRef", params.scopeRef),
		buildSearchFilterEquals("sessionId", sessionIds),
	].filter((value): value is Document => Boolean(value))

	const fused = await runEventRankFusion({
		db: params.db,
		prefix: params.prefix,
		query: params.query,
		maxResults: params.maxResults,
		numCandidates: params.numCandidates,
		capabilities: params.capabilities,
		embeddingMode: params.embeddingMode,
		queryEmbeddingModel: params.queryEmbeddingModel,
		canonicalFilter: vectorFilter,
		textFilters,
		lifecycleMatch,
		consumeWork: tryConsumeSearchWork,
		denialReason: searchWorkDenialReason,
		onTierOutcome: params.onTierOutcome,
	})
	return fused
		.map((result, index) => ({
			...result,
			score:
				Math.max(result.score, 1 - index * 0.01) +
				scorePreferenceGroundingSignalBoost(params.query, result),
		}))
		.toSorted((left, right) => right.score - left.score)
		.slice(0, params.maxResults)
}

export async function searchConversationEvidenceEvents(params: {
	db: Db
	prefix: string
	query: string
	questionDate: Date | undefined
	agentId: string
	scope: MemoryScope
	scopeRef: string
	maxResults: number
	numCandidates: number
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
	queryEmbeddingModel: ResolvedMongoDBConfig["queryEmbeddingModel"]
	onTierOutcome?: SearchTierOutcomeSink
	budgetReservation?: SearchBudgetReservation
	/** RET-02: explicit caller-resolved occurrence-time bounds. */
	timeRange?: MemorySearchExecutorTimeRange
}): Promise<MemorySearchResult[]> {
	if (!isConversationEvidenceQuery(params.query, params.questionDate)) {
		params.onTierOutcome?.({
			stage: "plan",
			outcome: "not-applicable",
			reason: "query-shape",
		})
		return []
	}
	const queryTime =
		params.questionDate && !Number.isNaN(params.questionDate.getTime())
			? params.questionDate
			: new Date()
	// Post-stage, the full request filter AND the lifecycle window are
	// re-checked against the hydrated document: the Search-stage filters run
	// against the indexed copy, which can lag an owner/scope mutation, a
	// timestamp drift, a retraction, or an expiry.
	const lifecycleMatch: Document = {
		$and: [
			{
				$or: [
					{ validAt: { $exists: false } },
					{ validAt: { $lte: queryTime } },
				],
			},
			{
				$or: [{ invalidAt: null }, { invalidAt: { $gt: queryTime } }],
			},
			{
				$or: [
					{ expiresAt: { $exists: false } },
					{ expiresAt: { $gt: new Date() } },
				],
			},
		],
	}
	const vectorFilter: Document = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
	}
	// RET-02: an explicit caller range narrows the evidence window, while
	// questionDate stays an upper bound (no future leakage past what the
	// user had seen when asking). Without an explicit range, today's
	// questionDate-only bound applies unchanged.
	const questionBound =
		params.questionDate && !Number.isNaN(params.questionDate.getTime())
			? params.questionDate
			: undefined
	const rangeEnd = params.timeRange
		? questionBound && questionBound < params.timeRange.end
			? questionBound
			: params.timeRange.end
		: questionBound
	if (params.timeRange?.start && rangeEnd) {
		vectorFilter.timestamp = {
			$gte: params.timeRange.start,
			$lte: rangeEnd,
		}
	} else if (rangeEnd) {
		vectorFilter.timestamp = { $lte: rangeEnd }
	}

	const searchFilters = [
		buildSearchFilterEquals("agentId", params.agentId),
		buildSearchFilterEquals("scope", params.scope),
		buildSearchFilterEquals("scopeRef", params.scopeRef),
		params.timeRange?.start && rangeEnd
			? {
					range: {
						path: "timestamp",
						gte: params.timeRange.start,
						lte: rangeEnd,
					},
				}
			: rangeEnd
				? {
						range: {
							path: "timestamp",
							lte: rangeEnd,
						},
					}
				: null,
	].filter((value): value is Document => Boolean(value))

	const reservation = params.budgetReservation
	const textShould: Document[] = []
	if (params.questionDate && !Number.isNaN(params.questionDate.getTime())) {
		textShould.push({
			near: {
				path: "timestamp",
				origin: params.questionDate,
				pivot: 180 * 24 * 60 * 60 * 1000,
				score: { boost: { value: 2 } },
			},
		})
	}
	const fused = await runEventRankFusion({
		db: params.db,
		prefix: params.prefix,
		query: params.query,
		maxResults: params.maxResults,
		numCandidates: params.numCandidates,
		capabilities: params.capabilities,
		embeddingMode: params.embeddingMode,
		queryEmbeddingModel: params.queryEmbeddingModel,
		canonicalFilter: vectorFilter,
		textFilters: searchFilters,
		textShould,
		lifecycleMatch,
		consumeWork: (cost) =>
			reservation
				? reservation.tryConsumeWork(cost)
				: tryConsumeSearchWork(cost),
		denialReason: (cost) =>
			reservation ? "budget-reservation" : searchWorkDenialReason(cost),
		onTierOutcome: params.onTierOutcome,
	})
	return fused
		.map((result, index) => ({
			...result,
			score: Math.max(result.score, 1.1 - index * 0.01),
			sourceReliability: Math.max(result.sourceReliability ?? 0, 0.98),
			provenance: {
				...(result.provenance ?? {}),
				conversationEvidence: true,
			},
		}))
		.slice(0, params.maxResults)
}

// ---------------------------------------------------------------------------

const GRAPH_QUERY_STOPWORDS = new Set([
	"a",
	"about",
	"and",
	"for",
	"how",
	"in",
	"is",
	"of",
	"on",
	"or",
	"the",
	"to",
	"what",
	"who",
])

export function graphRelationPriority(type: RelationType): number {
	switch (type) {
		case "works_on":
		case "owns":
		case "depends_on":
		case "blocked_by":
		case "decided":
		case "reported_by":
			return 4
		case "related_to":
			return 3
		default:
			return 1
	}
}

function entityMatchScore(entity: Entity, query: string): number {
	const normalizedQuery = query.trim().toLowerCase()
	const normalizedName = entity.name.trim().toLowerCase()
	if (!normalizedQuery || !normalizedName) {
		return 0
	}
	if (normalizedQuery === normalizedName) {
		return 10
	}
	if (normalizedQuery.includes(normalizedName)) {
		return 8
	}
	if (normalizedName.includes(normalizedQuery)) {
		return 6
	}
	const aliasMatch = entity.aliases?.some((alias) => {
		const normalizedAlias = alias.trim().toLowerCase()
		return (
			normalizedAlias === normalizedQuery ||
			normalizedQuery.includes(normalizedAlias)
		)
	})
	if (aliasMatch) {
		return 7
	}
	return 1
}

export function pickBestEntityMatch(
	candidates: Entity[],
	query: string,
): Entity | null {
	if (candidates.length === 0) {
		return null
	}
	return (
		[...candidates].toSorted((a, b) => {
			const scoreDiff = entityMatchScore(b, query) - entityMatchScore(a, query)
			if (scoreDiff !== 0) {
				return scoreDiff
			}
			const recencyDiff =
				(b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0) -
				(a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0)
			if (recencyDiff !== 0) {
				return recencyDiff
			}
			return a.name.localeCompare(b.name)
		})[0] ?? null
	)
}

export function buildGraphQueryCandidates(query: string): string[] {
	const candidates = new Set<string>()
	const add = (value: string | undefined) => {
		const trimmed = value?.trim()
		if (
			trimmed &&
			trimmed.length >= 2 &&
			!GRAPH_QUERY_STOPWORDS.has(trimmed.toLowerCase())
		) {
			candidates.add(trimmed)
		}
	}

	for (const match of query.matchAll(/"([^"]+)"/g)) {
		add(match[1])
	}
	for (const match of query.matchAll(/[@#]([A-Za-z0-9_./-]+)/g)) {
		add(match[1])
	}
	for (const match of query.matchAll(
		/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g,
	)) {
		add(match[0])
	}

	if (candidates.size < 2) {
		const words = query
			.split(/\s+/)
			.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
			.filter(
				(word) =>
					word.length >= 3 && !GRAPH_QUERY_STOPWORDS.has(word.toLowerCase()),
			)
		for (const word of words.slice(0, 6)) {
			add(word)
		}
	}

	return Array.from(candidates).slice(0, 6)
}

export function isTrustedPlannerEntityCandidate(
	candidate: string,
	query: string,
): boolean {
	const trimmed = candidate.trim()
	if (!trimmed) {
		return false
	}
	if (/\s/.test(trimmed) || /[./_-]/.test(trimmed)) {
		return true
	}
	if (/^\p{Lu}/u.test(trimmed)) {
		return true
	}
	const lowerQuery = query.toLowerCase()
	const lowerCandidate = trimmed.toLowerCase()
	return (
		lowerQuery.includes(`"${lowerCandidate}"`) ||
		lowerQuery.includes(`@${lowerCandidate}`) ||
		lowerQuery.includes(`#${lowerCandidate}`)
	)
}

const RAW_WINDOW_QUERY_STOPWORDS = new Set([
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"whose",
	"why",
	"how",
	"is",
	"are",
	"was",
	"were",
	"do",
	"does",
	"did",
	"the",
	"a",
	"an",
	"this",
	"that",
	"these",
	"those",
	"in",
	"on",
	"for",
	"with",
	"to",
	"from",
	"of",
	"my",
	"our",
	"your",
	"current",
	"exactly",
	"please",
	"thread",
])

export function extractRawWindowQueryTerms(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9-]+/i)
				.map((part) => part.trim())
				.filter(
					(part) => part.length >= 3 && !RAW_WINDOW_QUERY_STOPWORDS.has(part),
				),
		),
	)
}

/**
 * M2 (G1-28): raw-window candidates come from one `$search` on events:
 * `text` on the body over the query's content terms, with the tenant
 * identity and the [start, end] window (`range` on the `date`-mapped
 * timestamp) in `compound.filter`. The caller's term scoring,
 * temporal-proximity boost and ordering stay composition over these
 * candidates. Search hits are candidates, not proof: identity, window and
 * lifecycle (validity at the reference clock, retention at wall-now) are
 * re-checked against the hydrated document before the bound. A query with
 * no content terms selects nothing; no chronological listing stands in.
 */
export async function searchRawWindowEvents(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	start: Date
	end: Date
	referenceDate: Date
	queryTerms: string[]
	limit: number
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<CanonicalEvent[]> {
	if (params.queryTerms.length === 0) {
		params.onTierOutcome?.({
			stage: "atlas-search",
			outcome: "not-applicable",
			reason: "query-shape",
		})
		return []
	}
	const canonicalFilter: Document = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		timestamp: { $gte: params.start, $lte: params.end },
	}
	const pipeline: Document[] = [
		{
			$search: {
				index: `${params.prefix}events_text`,
				compound: {
					filter: [
						{ equals: { path: "agentId", value: params.agentId } },
						{ equals: { path: "scope", value: params.scope } },
						{ equals: { path: "scopeRef", value: params.scopeRef } },
						{
							range: {
								path: "timestamp",
								gte: params.start,
								lte: params.end,
							},
						},
					],
					must: [{ text: { query: params.queryTerms, path: "body" } }],
				},
			},
		},
		...freshnessRevalidationStages(canonicalFilter),
		{ $match: buildEventLifecycleClause({ asOf: params.referenceDate }) },
		{ $limit: params.limit },
		{ $project: EVENT_RESULT_PROJECTION },
	]
	let docs: Document[]
	try {
		// One aggregation charged to the request ledger; maxTimeMS and the
		// typed warmup retry come from the shared runner.
		docs = await runSearchAggregateWithRetry(
			eventsCollection(params.db, params.prefix),
			pipeline,
			{ stage: "atlas-search" },
		)
	} catch (err) {
		throw toTypedSearchError(err, "atlas-search")
	}
	params.onTierOutcome?.({
		stage: "atlas-search",
		outcome: docs.length > 0 ? "ok" : "ok-empty",
		...(docs.length > 0 ? {} : { reason: "zero-hits" as const }),
		resultCount: docs.length,
	})
	return docs as unknown as CanonicalEvent[]
}

export function computeRawWindowEventQueryScore(
	body: string,
	queryTerms: string[],
): number {
	if (queryTerms.length === 0) {
		return 0
	}
	const haystack = body.toLowerCase()
	let score = 0
	for (const term of queryTerms) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		if (new RegExp(`\\b${escaped}\\b`, "i").test(haystack)) {
			score += term.includes("-") || /\d/.test(term) ? 5 : 1
		}
	}
	return score
}

/**
 * Execute a v2 retrieval plan: call planRetrieval, execute top 3 paths, deduplicate results.
 * Each path has its own try/catch so one failure doesn't kill the whole search.
 */
/**
 * P3.1: the conversation and bridge chunk lanes read the SAME collection
 * with the SAME query text, and under autoEmbed each $vectorSearch re-embeds
 * that text server-side — two lanes cost two paid embeddings per request.
 * When both filters pin the same identity fields they differ only in the
 * `source` set, so they fuse into ONE lane with the union of sources: one
 * aggregation, one embedding. Structurally incompatible filters (different
 * identity, non-$in source sets) keep the split lanes — a fusion must never
 * widen or narrow either read. Returns undefined when fusion is unsafe.
 */
export function fuseChunkLaneFilters(
	conversation: Document,
	bridge: Document | undefined,
): Document | undefined {
	if (!bridge) {
		return conversation
	}
	for (const key of ["agentId", "scope", "scopeRef", "status"] as const) {
		if (JSON.stringify(conversation[key]) !== JSON.stringify(bridge[key])) {
			return undefined
		}
	}
	const conversationSources = (conversation.source as { $in?: unknown[] })?.$in
	const bridgeSources = (bridge.source as { $in?: unknown[] })?.$in
	if (!Array.isArray(conversationSources) || !Array.isArray(bridgeSources)) {
		return undefined
	}
	return {
		...conversation,
		source: { $in: [...new Set([...conversationSources, ...bridgeSources])] },
	}
}
