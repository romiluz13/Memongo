/**
 * Search lane executors extracted from `mongodb-manager.ts` (P4.3):
 * conversation/event lane queries, temporal-coverage expansion, graph query
 * candidates, and raw-window scoring used by searchV2.
 */

import type { Db, Document } from "mongodb"
import type { MemoryScope } from "@memongo/lib"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import type { Entity, RelationType } from "./mongodb-graph.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { eventsCollection } from "./mongodb-schema.js"
import {
	resolveUserSearchMaxTimeMs,
	tryConsumeSearchAggregation,
	tryConsumeSearchEmbed,
} from "./mongodb-search-budget.js"
import type { MemorySearchResult } from "./types.js"
import {
	buildSearchFilterEquals,
	deduplicateSearchResults,
	isBenchmarkStrictMode,
	mapEventSearchDocToResult,
	mergeTurnPrecisionResults,
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
	scoreTemporalCoverageSessionEvent,
} from "./mongodb-search-temporal.js"

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
}): Promise<MemorySearchResult[]> {
	const sessionIds = [...new Set(params.sessionIds)].filter(Boolean)
	if (sessionIds.length === 0) return []
	const docs = await eventsCollection(params.db, params.prefix)
		.find(
			{
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId: { $in: sessionIds },
				role: "user",
				timestamp: { $lte: params.questionDate },
			},
			{
				projection: {
					_id: 0,
					eventId: 1,
					body: 1,
					role: 1,
					sessionId: 1,
					timestamp: 1,
					scope: 1,
					scopeRef: 1,
					accessCount: 1,
				},
				sort: { timestamp: 1 },
				limit: Math.max(params.maxEvents * 4, sessionIds.length * 6),
			},
		)
		.toArray()
	const bySession = new Map<string, Document[]>()
	for (const doc of docs) {
		if (
			typeof doc.sessionId !== "string" ||
			!sessionIds.includes(doc.sessionId)
		) {
			continue
		}
		const bucket = bySession.get(doc.sessionId)
		if (bucket) {
			bucket.push(doc)
		} else {
			bySession.set(doc.sessionId, [doc])
		}
	}

	const selected: MemorySearchResult[] = []
	for (const sessionId of sessionIds) {
		const sessionDocs = bySession.get(sessionId) ?? []
		if (sessionDocs.length === 0) continue
		const scored = sessionDocs
			.map((doc, index) => ({
				doc,
				index,
				score: scoreTemporalCoverageSessionEvent(
					typeof doc.body === "string" ? doc.body : "",
					params.terms,
					doc.timestamp instanceof Date ? doc.timestamp : undefined,
					params.questionDate,
				),
			}))
			.toSorted((left, right) => {
				const scoreDelta = right.score - left.score
				return Math.abs(scoreDelta) > 0.000001
					? scoreDelta
					: left.index - right.index
			})
		const picked = new Map<Document, number>()
		picked.set(
			sessionDocs[0],
			scoreTemporalCoverageSessionEvent(
				typeof sessionDocs[0].body === "string" ? sessionDocs[0].body : "",
				params.terms,
				sessionDocs[0].timestamp instanceof Date
					? sessionDocs[0].timestamp
					: undefined,
				params.questionDate,
			),
		)
		for (const entry of scored) {
			picked.set(entry.doc, entry.score)
			if (picked.size >= params.maxPerSession) break
		}
		for (const [doc, score] of picked) {
			const result = mapEventSearchDocToResult({ ...doc, score }, "turn-text")
			if (!result) continue
			selected.push({
				...result,
				provenance: {
					...(result.provenance ?? {}),
					lane: "temporal-session-expansion",
					temporalCoverage: true,
					temporalSessionExpansion: true,
				},
			})
		}
	}

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
}): Promise<MemorySearchResult[]> {
	const temporalQuery = isTemporalCoverageQuery(
		params.query,
		params.questionDate,
	)
	if (!temporalQuery) {
		return []
	}
	if (!params.capabilities.textSearch) {
		if (isBenchmarkStrictMode()) {
			throw new Error(
				"temporal coverage search requires MongoDB Search text capability in strict mode",
			)
		}
		return []
	}

	const terms = extractTemporalCoverageTerms(params.query)
	if (terms.length === 0 || !params.questionDate) return []
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
	// consumes the per-request budget here.
	if (!tryConsumeSearchAggregation()) {
		return []
	}
	const docs = await eventsCollection(params.db, params.prefix)
		// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
		.aggregate(pipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
		.toArray()
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
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionIds: string[]
	maxResults: number
	numCandidates: number
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
}): Promise<MemorySearchResult[]> {
	const sessionIds = Array.from(new Set(params.sessionIds)).filter(
		(value) => value.trim().length > 0,
	)
	if (sessionIds.length === 0) return []

	const events = eventsCollection(params.db, params.prefix)
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

	const searches: Array<Promise<MemorySearchResult[]>> = []
	if (
		params.capabilities.vectorSearch &&
		params.embeddingMode === "automated" &&
		// P3.2: these inline $vectorSearch pipelines bypass
		// buildVectorSearchStage, so they consume the per-request aggregation +
		// server-side embed budget here.
		tryConsumeSearchAggregation() &&
		tryConsumeSearchEmbed()
	) {
		const vectorPipeline: Document[] = [
			{
				$vectorSearch: {
					index: `${params.prefix}events_vector`,
					path: "body",
					query: { text: params.query },
					model: "voyage-4-large",
					filter: vectorFilter,
					numCandidates: params.numCandidates,
					limit: params.maxResults,
				},
			},
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
					score: { $meta: "vectorSearchScore" },
				},
			},
		]
		searches.push(
			events
				// P3.8: user-driven $vectorSearch pipelines carry a maxTimeMS ceiling.
				.aggregate(vectorPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-vector"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}
	// P3.2: direct aggregates consume the per-request budget here.
	if (params.capabilities.textSearch && tryConsumeSearchAggregation()) {
		const textPipeline: Document[] = [
			{
				$search: {
					index: `${params.prefix}events_text`,
					compound: {
						must: [{ text: { query: params.query, path: "body" } }],
						filter: textFilters,
					},
				},
			},
			{ $limit: params.maxResults },
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
		searches.push(
			events
				// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
				.aggregate(textPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-text"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}

	if (searches.length === 0) return []
	const results = await Promise.all(searches)
	return mergeTurnPrecisionResults(results)
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
}): Promise<MemorySearchResult[]> {
	if (!isConversationEvidenceQuery(params.query, params.questionDate)) {
		return []
	}
	if (!params.capabilities.textSearch && !params.capabilities.vectorSearch) {
		if (isBenchmarkStrictMode()) {
			throw new Error(
				"conversation evidence search requires MongoDB Search or Vector Search capability in strict mode",
			)
		}
		return []
	}

	const events = eventsCollection(params.db, params.prefix)
	const vectorFilter: Document = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
	}
	if (params.questionDate && !Number.isNaN(params.questionDate.getTime())) {
		vectorFilter.timestamp = { $lte: params.questionDate }
	}

	const searchFilters = [
		buildSearchFilterEquals("agentId", params.agentId),
		buildSearchFilterEquals("scope", params.scope),
		buildSearchFilterEquals("scopeRef", params.scopeRef),
		params.questionDate && !Number.isNaN(params.questionDate.getTime())
			? {
					range: {
						path: "timestamp",
						lte: params.questionDate,
					},
				}
			: null,
	].filter((value): value is Document => Boolean(value))

	const searches: Array<Promise<MemorySearchResult[]>> = []
	if (
		params.capabilities.vectorSearch &&
		params.embeddingMode === "automated" &&
		// P3.2: these inline $vectorSearch pipelines bypass
		// buildVectorSearchStage, so they consume the per-request aggregation +
		// server-side embed budget here.
		tryConsumeSearchAggregation() &&
		tryConsumeSearchEmbed()
	) {
		const vectorPipeline: Document[] = [
			{
				$vectorSearch: {
					index: `${params.prefix}events_vector`,
					path: "body",
					query: { text: params.query },
					model: "voyage-4-large",
					filter: vectorFilter,
					numCandidates: params.numCandidates,
					limit: params.maxResults,
				},
			},
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
					score: { $meta: "vectorSearchScore" },
				},
			},
		]
		searches.push(
			events
				// P3.8: user-driven $vectorSearch pipelines carry a maxTimeMS ceiling.
				.aggregate(vectorPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-vector"))
						.filter((result): result is MemorySearchResult => Boolean(result)),
				),
		)
	}

	// P3.2: direct aggregates consume the per-request budget here.
	if (params.capabilities.textSearch && tryConsumeSearchAggregation()) {
		const should: Document[] = []
		if (params.questionDate && !Number.isNaN(params.questionDate.getTime())) {
			should.push({
				near: {
					path: "timestamp",
					origin: params.questionDate,
					pivot: 180 * 24 * 60 * 60 * 1000,
					score: { boost: { value: 2 } },
				},
			})
		}
		const textPipeline: Document[] = [
			{
				$search: {
					index: `${params.prefix}events_text`,
					compound: {
						filter: searchFilters,
						must: [{ text: { query: params.query, path: "body" } }],
						...(should.length > 0 ? { should } : {}),
					},
				},
			},
			{ $limit: params.maxResults },
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
		searches.push(
			events
				// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
				.aggregate(textPipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
				.then((docs) =>
					docs
						.map((doc) => mapEventSearchDocToResult(doc, "turn-text"))
						.filter((result): result is MemorySearchResult => Boolean(result))
						.map((result) => ({
							...result,
							provenance: {
								...(result.provenance ?? {}),
								conversationEvidence: true,
							},
						})),
				),
		)
	}

	if (searches.length === 0) return []
	const results = await Promise.all(searches)
	return mergeTurnPrecisionResults(results)
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
