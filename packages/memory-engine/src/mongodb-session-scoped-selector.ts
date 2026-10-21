/**
 * The session-scoped turn selector: given a namespace and a list of sessions,
 * it returns a bounded, deterministic pick of turns from inside those
 * sessions, in session-list order. Two callers share it:
 *
 * - the temporal-coverage lane ("temporal-terms"): one `$search` over the
 *   sessions' user turns, terms as an optional `should`, each session's
 *   earliest turn (its opener) always kept;
 * - session turn recall ("fused"): one count of the sessions' turns in
 *   reach, then one native `$rankFusion` aggregate whose `$vectorSearch` and
 *   `$search` inputs are both filtered to the sessions and sized to that
 *   count, so each session's top turns come from all of its own turns.
 *
 * The namespace (agentId, scope, scopeRef) is mandatory on every query sent,
 * in the Search filter and in the post-stage revalidation. Neither policy
 * substitutes for the other: a missing capability is reported, not replaced.
 */

import type { Db, Document } from "mongodb"
import type { MemoryScope } from "@memongo/lib"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import {
	EVENT_RESULT_PROJECTION,
	runEventRankFusion,
} from "./mongodb-event-rank-fusion.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { eventsCollection } from "./mongodb-schema.js"
import {
	resolveUserSearchMaxTimeMs,
	searchWorkDenialReason,
	tryConsumeSearchWork,
} from "./mongodb-search-budget.js"
import {
	buildSearchFilterEquals,
	mapEventSearchDocToResult,
} from "./mongodb-search-ranking.js"
import { scoreTemporalCoverageSessionEvent } from "./mongodb-search-temporal.js"
import {
	freshnessRevalidationStages,
	MONGODB_MAX_NUM_CANDIDATES,
	runSearchAggregateWithRetry,
} from "./mongodb-search.js"
import { buildEventLifecycleClause } from "./mongodb-temporal.js"
import {
	SearchLaneError,
	type SearchTierOutcomeSink,
	toTypedSearchError,
} from "./search-outcomes.js"
import type { MemorySearchResult } from "./types.js"

export type SessionNamespace = {
	agentId: string
	scope: MemoryScope
	scopeRef: string
}

export type SessionScopedPolicy =
	| {
			kind: "temporal-terms"
			terms: string[]
			/** The question clock: turns after it are out of reach. */
			questionDate: Date
			/** Lower bound of the Search candidate limit. */
			candidateLimit: number
	  }
	| {
			kind: "fused"
			query: string
			/** The question clock, when the search has one. */
			asOf: Date | undefined
			capabilities: DetectedCapabilities
			embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
			queryEmbeddingModel: ResolvedMongoDBConfig["queryEmbeddingModel"]
	  }

export type SessionScopedTurn = {
	result: MemorySearchResult
	sessionId: string
	/** 1-based position of the turn in its session's pick. */
	inSessionRank: number
}

export async function selectSessionScopedTurns(params: {
	db: Db
	prefix: string
	namespace: SessionNamespace
	sessionIds: string[]
	perSession: number
	policy: SessionScopedPolicy
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<SessionScopedTurn[]> {
	const sessionIds = [...new Set(params.sessionIds)].filter(Boolean)
	if (sessionIds.length === 0) {
		params.onTierOutcome?.({
			stage: "plan",
			outcome: "not-applicable",
			reason: "no-candidates",
		})
		return []
	}
	const scoped = { ...params, sessionIds }
	return params.policy.kind === "temporal-terms"
		? selectByTemporalTerms(scoped, params.policy)
		: selectByFusedRank(scoped, params.policy)
}

type ScopedParams = Parameters<typeof selectSessionScopedTurns>[0]

/**
 * The Search `compound.filter` clauses and the matching post-stage filter
 * for turns of these sessions in this namespace. A blank namespace field is
 * refused, never dropped from the filter.
 */
export function sessionScopedEventFilters(params: {
	namespace: SessionNamespace
	sessionIds: string[]
	role?: "user"
	asOf?: Date
}): { searchFilters: Document[]; canonicalFilter: Document } {
	const { agentId, scope, scopeRef } = params.namespace
	if (![agentId, scope, scopeRef].every((value) => value?.trim())) {
		throw new SearchLaneError({ stage: "filter", reason: "query-error" })
	}
	const searchFilters = [
		buildSearchFilterEquals("agentId", agentId),
		buildSearchFilterEquals("scope", scope),
		buildSearchFilterEquals("scopeRef", scopeRef),
		buildSearchFilterEquals("sessionId", params.sessionIds),
		...(params.role ? [buildSearchFilterEquals("role", params.role)] : []),
		...(params.asOf
			? [{ range: { path: "timestamp", lte: params.asOf } }]
			: []),
	].filter((value): value is Document => Boolean(value))
	const canonicalFilter: Document = {
		agentId,
		scope,
		scopeRef,
		sessionId: { $in: params.sessionIds },
		...(params.role ? { role: params.role } : {}),
		...(params.asOf ? { timestamp: { $lte: params.asOf } } : {}),
	}
	return { searchFilters, canonicalFilter }
}

function groupBySession<T>(
	sessionIds: string[],
	items: T[],
	sessionIdOf: (item: T) => unknown,
): Map<string, T[]> {
	const bySession = new Map<string, T[]>()
	for (const item of items) {
		const sessionId = sessionIdOf(item)
		if (typeof sessionId !== "string" || !sessionIds.includes(sessionId)) {
			continue
		}
		const bucket = bySession.get(sessionId)
		if (bucket) {
			bucket.push(item)
		} else {
			bySession.set(sessionId, [item])
		}
	}
	return bySession
}

function timeOf(value: unknown): number {
	return value instanceof Date ? value.getTime() : 0
}

async function selectByTemporalTerms(
	params: ScopedParams,
	policy: Extract<SessionScopedPolicy, { kind: "temporal-terms" }>,
): Promise<SessionScopedTurn[]> {
	const { sessionIds } = params
	const { questionDate } = policy
	// M2 (G1-28): the hit sessions' user turns are selected through $search
	// with the session ids in compound.filter. The lane's terms are an
	// optional `should`, so a session opener without a term match stays a
	// candidate while term-bearing turns rank first under the bound. The
	// indexed copy can lag an owner/scope/session mutation, a retraction or
	// an expiry, so the hydrated document is re-checked post-stage.
	const { searchFilters, canonicalFilter } = sessionScopedEventFilters({
		namespace: params.namespace,
		sessionIds,
		role: "user",
		asOf: questionDate,
	})
	const pipeline: Document[] = [
		{
			$search: {
				index: `${params.prefix}events_text`,
				compound: {
					filter: searchFilters,
					should: [{ text: { query: policy.terms, path: "body" } }],
				},
			},
		},
		...freshnessRevalidationStages(canonicalFilter),
		{ $match: buildEventLifecycleClause({ asOf: questionDate }) },
		{ $limit: Math.max(policy.candidateLimit, sessionIds.length * 6) },
		{ $project: EVENT_RESULT_PROJECTION },
	]
	let searched: Document[]
	try {
		searched = await runSearchAggregateWithRetry(
			eventsCollection(params.db, params.prefix),
			pipeline,
			{ stage: "atlas-search" },
		)
	} catch (err) {
		throw toTypedSearchError(err, "atlas-search")
	}
	params.onTierOutcome?.({
		stage: "atlas-search",
		outcome: searched.length > 0 ? "ok" : "ok-empty",
		...(searched.length > 0 ? {} : { reason: "zero-hits" as const }),
		resultCount: searched.length,
	})
	// The per-session pick below reads each session's turns in time order,
	// whatever order Search returned them in.
	const docs = searched.toSorted((left, right) => {
		const byTime = timeOf(left.timestamp) - timeOf(right.timestamp)
		return byTime !== 0
			? byTime
			: String(left.eventId).localeCompare(String(right.eventId))
	})
	const bySession = groupBySession(sessionIds, docs, (doc) => doc.sessionId)
	const score = (doc: Document) =>
		scoreTemporalCoverageSessionEvent(
			typeof doc.body === "string" ? doc.body : "",
			policy.terms,
			doc.timestamp instanceof Date ? doc.timestamp : undefined,
			questionDate,
		)

	const selected: SessionScopedTurn[] = []
	for (const sessionId of sessionIds) {
		const sessionDocs = bySession.get(sessionId) ?? []
		if (sessionDocs.length === 0) continue
		const scored = sessionDocs
			.map((doc, index) => ({ doc, index, score: score(doc) }))
			.toSorted((left, right) => {
				const scoreDelta = right.score - left.score
				return Math.abs(scoreDelta) > 0.000001
					? scoreDelta
					: left.index - right.index
			})
		const picked = new Map<Document, number>()
		picked.set(sessionDocs[0], score(sessionDocs[0]))
		for (const entry of scored) {
			picked.set(entry.doc, entry.score)
			if (picked.size >= params.perSession) break
		}
		let inSessionRank = 0
		for (const [doc, docScore] of picked) {
			const result = mapEventSearchDocToResult(
				{ ...doc, score: docScore },
				"turn-text",
			)
			if (!result) continue
			inSessionRank += 1
			selected.push({ result, sessionId, inSessionRank })
		}
	}
	return selected
}

async function selectByFusedRank(
	params: ScopedParams,
	policy: Extract<SessionScopedPolicy, { kind: "fused" }>,
): Promise<SessionScopedTurn[]> {
	const { sessionIds } = params
	const { capabilities } = policy
	// One aggregate, one outcome (M2 decision 5): a missing input is named
	// and the selector runs nothing; neither input runs alone.
	const absent =
		!capabilities.vectorSearch || policy.embeddingMode !== "automated"
			? "turn-vector"
			: !capabilities.textSearch
				? "turn-text"
				: !capabilities.rankFusion
					? "rank-fusion"
					: null
	if (absent) {
		params.onTierOutcome?.({
			stage: absent,
			outcome: "not-applicable",
			reason: "capability-absent",
		})
		return []
	}
	const { searchFilters, canonicalFilter } = sessionScopedEventFilters({
		namespace: params.namespace,
		sessionIds,
		asOf: policy.asOf,
	})
	const lifecycleMatch = buildEventLifecycleClause({ asOf: policy.asOf })
	// Each input returns every turn in reach, so a session's top turns never
	// depend on how its turns rank against the other sessions' turns.
	let turnsInReach: number
	try {
		turnsInReach = await eventsCollection(
			params.db,
			params.prefix,
		).countDocuments(
			{ $and: [canonicalFilter, lifecycleMatch] },
			{ maxTimeMS: resolveUserSearchMaxTimeMs() },
		)
	} catch (err) {
		throw toTypedSearchError(err, "plan")
	}
	if (turnsInReach === 0 || turnsInReach > MONGODB_MAX_NUM_CANDIDATES) {
		params.onTierOutcome?.({
			stage: "plan",
			outcome: "not-applicable",
			reason: turnsInReach === 0 ? "no-candidates" : "query-shape",
		})
		return []
	}
	// ENN over the prefiltered turns: the $vectorSearch docs recommend exact
	// search below 10000 documents, and an ANN queue could still miss a turn.
	const fused = await runEventRankFusion({
		db: params.db,
		prefix: params.prefix,
		query: policy.query,
		maxResults: turnsInReach,
		numCandidates: "exact",
		capabilities,
		embeddingMode: policy.embeddingMode,
		queryEmbeddingModel: policy.queryEmbeddingModel,
		canonicalFilter,
		textFilters: searchFilters,
		lifecycleMatch,
		consumeWork: tryConsumeSearchWork,
		denialReason: searchWorkDenialReason,
		onTierOutcome: params.onTierOutcome,
	})
	const bySession = groupBySession(sessionIds, fused, (r) => r.sessionId)
	const selected: SessionScopedTurn[] = []
	for (const sessionId of sessionIds) {
		const ranked = (bySession.get(sessionId) ?? []).toSorted(
			(left, right) =>
				right.score - left.score ||
				timeOf(left.timestamp) - timeOf(right.timestamp) ||
				String(left.canonicalId).localeCompare(String(right.canonicalId)),
		)
		ranked.slice(0, params.perSession).forEach((result, index) => {
			selected.push({ result, sessionId, inSessionRank: index + 1 })
		})
	}
	return selected
}
