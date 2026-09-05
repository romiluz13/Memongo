import { createHash, randomUUID } from "node:crypto"
import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { isDuplicateKeyError } from "./internal.js"
import {
	getEventsByTimeRange,
	getUnconsolidatedEvents,
	markEventsConsolidated,
} from "./mongodb-events.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import { episodesCollection } from "./mongodb-schema.js"
import { resolveUserSearchMaxTimeMs } from "./mongodb-search-budget.js"
import { resolveScopeRef } from "./mongodb-scope.js"

const log = createSubsystemLogger("memory:mongodb:episodes")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpisodeType = "daily" | "weekly" | "thread" | "topic" | "decision"

export type EpisodeStatus = "active" | "archived" | "deleted"

export type Episode = {
	episodeId: string
	type: EpisodeType
	title: string
	summary: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	timeRange: { start: Date; end: Date }
	sourceEventCount: number
	sourceEventIds?: string[]
	tags?: string[]
	shortTermSummary?: string
	mediumTermSummary?: string
	longTermSummary?: string
	topics?: string[]
	status?: EpisodeStatus
	updatedAt: Date
}

/**
 * Summarizer function type -- allows injection of LLM or mock summarizer.
 * In tests, use a mock that returns a fixed {title, summary, tags}.
 * In production, wire to the agent's LLM call.
 */
export type EpisodeSummarizerResult = {
	title: string
	summary: string
	tags?: string[]
	shortTermSummary?: string
	mediumTermSummary?: string
	longTermSummary?: string
	topics?: string[]
}

/**
 * The episode `type` is passed so a summarizer can say something different
 * about the same events depending on the lens being applied. Without it, a
 * "daily", a "topic" and a "decision" episode over one window are guaranteed to
 * be byte-identical clones that all surface together in a single search and
 * crowd out genuinely distinct evidence.
 *
 * Optional so existing summarizers keep type-checking; they simply ignore it.
 */
export type EpisodeSummarizer = (
	events: Array<{ role: string; body: string; timestamp: Date }>,
	type?: EpisodeType,
) => Promise<EpisodeSummarizerResult>

const EPISODE_QUERY_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"for",
	"happened",
	"how",
	"in",
	"is",
	"of",
	"on",
	"or",
	"summarize",
	"the",
	"to",
	"what",
])

function buildEpisodeSearchRegex(query: string): RegExp {
	const normalized = query.trim()
	const terms = normalized
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter((token) => token.length >= 3 && !EPISODE_QUERY_STOPWORDS.has(token))
	const escapedTerms = Array.from(new Set(terms))
		.slice(0, 8)
		.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	if (escapedTerms.length === 0) {
		return new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
	}
	return new RegExp(escapedTerms.join("|"), "i")
}

function buildEpisodeSummarizerInput(
	events: Array<{ role: string; body: string; timestamp: Date }>,
) {
	const conversational = events.filter((event) => {
		const body = event.body.trim()
		return (
			body.length > 0 && (event.role === "user" || event.role === "assistant")
		)
	})
	if (conversational.length >= 2) {
		return conversational
	}
	return events.filter((event) => {
		const body = event.body.trim()
		return body.length > 0 && event.role !== "system"
	})
}

function resolveTriggeredEpisodeWindow(params: {
	events: Array<{
		eventId: string
		role: string
		body: string
		timestamp: Date
	}>
	triggerReason: "session_gap" | "event_count" | "explicit"
	sessionGapMinutes: number
	maxEventsWithoutEpisode: number
}) {
	const { events, triggerReason, sessionGapMinutes, maxEventsWithoutEpisode } =
		params
	if (events.length <= 1) {
		return events
	}
	if (triggerReason === "session_gap") {
		const gapMs = sessionGapMinutes * 60 * 1000
		for (let i = 1; i < events.length; i++) {
			const gap =
				events[i].timestamp.getTime() - events[i - 1].timestamp.getTime()
			if (gap > gapMs) {
				return events.slice(0, i)
			}
		}
		return events
	}
	if (
		triggerReason === "event_count" &&
		events.length > maxEventsWithoutEpisode
	) {
		// The trigger fires when we exceed the backlog threshold, so the episode
		// window needs to include the event that crossed the threshold as well.
		return events.slice(0, Math.max(2, maxEventsWithoutEpisode + 1))
	}
	return events
}

/**
 * Stable content address for the set of events an episode summarizes.
 *
 * Sorted so that a different retrieval order over the same events yields the
 * same address, and hashed so the identity stays a fixed-width scalar however
 * many events an episode covers (they run to hundreds).
 */
export function hashSourceEventIds(sourceEventIds: string[]): string {
	return createHash("sha256")
		.update(
			sourceEventIds
				.map((id) => id.trim())
				.toSorted()
				.join("\u0000"),
		)
		.digest("hex")
}

// ---------------------------------------------------------------------------
// Per-scope episode cap
// ---------------------------------------------------------------------------

const EPISODES_MAX_PER_SCOPE_DEFAULT = 200

/**
 * Upper bound on episodes kept per (agentId, scope, scopeRef)
 * (MEMONGO_EPISODES_MAX_PER_SCOPE, default 200; an explicit 0 or negative
 * value disables the cap). Episodes are derived summaries — the events they
 * compress stay retained and marked consolidatedAt — so pruning the oldest
 * beyond the cap bounds storage without losing source data.
 */
export function resolveEpisodesMaxPerScope(): number {
	const raw = process.env.MEMONGO_EPISODES_MAX_PER_SCOPE?.trim()
	if (raw) {
		const parsed = Number(raw)
		if (Number.isFinite(parsed)) {
			return parsed <= 0 ? 0 : Math.floor(parsed)
		}
	}
	return EPISODES_MAX_PER_SCOPE_DEFAULT
}

/**
 * Enforce the per-scope cap by deleting the OLDEST episodes beyond it.
 * Sorting on createdAt asc means episodes written before the field existed
 * (BSON null sorts first) are treated as the oldest — they are. A failure
 * here never fails materialization: an over-cap scope is a storage concern,
 * not a correctness one, and the next inserted episode retries the prune.
 */
async function enforceEpisodesScopeCap(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
}): Promise<void> {
	const cap = resolveEpisodesMaxPerScope()
	if (cap <= 0) {
		return
	}
	const col = episodesCollection(params.db, params.prefix)
	const filter = {
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
	}
	const count = await col.countDocuments(filter)
	if (count <= cap) {
		return
	}
	const overflowIds = (
		await col
			.find(filter, {
				sort: { createdAt: 1 },
				limit: count - cap,
				projection: { episodeId: 1 },
			})
			.toArray()
	)
		.map((doc) => doc.episodeId)
		.filter((id): id is string => typeof id === "string")
	if (overflowIds.length === 0) {
		return
	}
	await col.deleteMany({
		agentId: params.agentId,
		episodeId: { $in: overflowIds },
	})
	log.info(
		`pruned ${overflowIds.length} oldest episode(s) to enforce cap=${cap} scope=${params.scope} scopeRef=${params.scopeRef}`,
	)
}

// ---------------------------------------------------------------------------
// Materialize episode from raw events
// ---------------------------------------------------------------------------

export async function materializeEpisode(params: {
	db: Db
	prefix: string
	agentId: string
	type: EpisodeType
	timeRange: { start: Date; end: Date }
	scope?: MemoryScope
	scopeRef?: string
	summarizer: EpisodeSummarizer
	/**
	 * Pre-selected events for this episode. When provided, the time-range
	 * re-query is skipped so the episode identity (sourceEventIds/hash) covers
	 * exactly this set — events written between selection and materialization
	 * are not absorbed. Callers without a pre-selected set (manual
	 * materialization) omit this and keep the time-range query behavior.
	 */
	events?: Array<{
		eventId: string
		role: string
		body: string
		timestamp: Date
	}>
}): Promise<Episode | null> {
	const { db, prefix, agentId, type, timeRange, scope, summarizer } = params
	const startMs = Date.now()
	try {
		const resolvedScope = scope ?? "agent"
		const scopeRef = resolveScopeRef({
			scope: resolvedScope,
			scopeRef: params.scopeRef,
			agentId,
		})
		// 1. Read raw events for the time range — unless the caller already
		//    selected the exact event set (auto-trigger path).
		const events =
			params.events ??
			(await getEventsByTimeRange({
				db,
				prefix,
				agentId,
				start: timeRange.start,
				end: timeRange.end,
				scope: resolvedScope,
				scopeRef,
			}))

		// 2. If fewer than 2 events, return null (not enough content for an episode)
		if (events.length < 2) {
			log.info(
				`skipping episode materialization: only ${events.length} events in range for agent=${agentId}`,
			)
			await recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "episodes",
					status: "partial",
					itemsProjected: 0,
					durationMs: Date.now() - startMs,
				},
			}).catch(() => {})
			return null
		}

		// 3. Call summarizer with ordered events
		const summarizerInput = buildEpisodeSummarizerInput(
			events.map((e) => ({
				role: e.role,
				body: e.body,
				timestamp: e.timestamp,
			})),
		)
		if (summarizerInput.length < 2) {
			log.info(
				`skipping episode materialization: only ${summarizerInput.length} conversational events in range for agent=${agentId}`,
			)
			await recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "episodes",
					status: "partial",
					itemsProjected: 0,
					durationMs: Date.now() - startMs,
				},
			}).catch(() => {})
			return null
		}
		const {
			title,
			summary,
			tags,
			shortTermSummary,
			mediumTermSummary,
			longTermSummary,
			topics,
		} = await summarizer(summarizerInput, type)

		// 3b. Validate summarizer output
		if (!title || typeof title !== "string" || !title.trim()) {
			throw new Error("Summarizer returned empty or invalid title")
		}
		if (!summary || typeof summary !== "string" || !summary.trim()) {
			throw new Error("Summarizer returned empty or invalid summary")
		}

		// 4. Build episode document
		const episodeId = randomUUID()
		const now = new Date()
		const sourceEventIds = events.map((e) => e.eventId)

		const sourceEventsHash = hashSourceEventIds(sourceEventIds)

		const setDoc: Document = {
			type,
			title,
			summary,
			agentId,
			scope: resolvedScope,
			scopeRef,
			timeRange: { start: timeRange.start, end: timeRange.end },
			sourceEventCount: events.length,
			sourceEventIds,
			sourceEventsHash,
			updatedAt: now,
		}
		if (tags !== undefined) {
			setDoc.tags = tags
		}
		if (shortTermSummary) {
			setDoc.shortTermSummary = shortTermSummary
		}
		if (mediumTermSummary) {
			setDoc.mediumTermSummary = mediumTermSummary
		}
		if (longTermSummary) {
			setDoc.longTermSummary = longTermSummary
		}
		if (topics && topics.length > 0) {
			setDoc.topics = topics
		}

		// 5. Idempotent upsert keyed on the CONTENT — the set of events summarized —
		//    rather than on the query window that happened to select them.
		//
		//    The window is not a stable identity. checkAutoEpisodeTriggers derives
		//    timeRange from resolveTriggeredEpisodeWindow, whose boundaries are the
		//    first and last timestamps of whichever slice it picked, so two passes
		//    over the same events can differ by a fraction of a second. That jitter
		//    used to mint a whole new episode over identical content: observed on a
		//    live cluster as three episode documents with byte-identical summaries
		//    and the same 18 sourceEventIds, all surfacing together in one search.
		//
		//    timeRange remains on the document as derived data ($set above).
		//    episodeId stays in $setOnInsert so it is stable across re-materializations.
		const col = episodesCollection(db, prefix)
		const identityFilter = {
			agentId,
			type,
			scope: resolvedScope,
			scopeRef,
			sourceEventsHash,
		}
		// P1-2: two concurrent materializations of the same window can both
		// take the insert path of this upsert; uq_episodes_source_events makes
		// the loser fail with E11000. Re-running once matches the winner's
		// document and applies this write as a plain update.
		const runEpisodeUpsert = async () =>
			col.updateOne(
				identityFilter,
				{
					$set: setDoc,
					$setOnInsert: {
						episodeId,
						createdAt: now,
						status: "active" as EpisodeStatus,
					},
				},
				{ upsert: true },
			)
		let updateResult: Awaited<ReturnType<typeof runEpisodeUpsert>>
		try {
			updateResult = await runEpisodeUpsert()
		} catch (err) {
			if (!isDuplicateKeyError(err)) {
				throw err
			}
			updateResult = await runEpisodeUpsert()
		}

		let persistedEpisodeId: string = episodeId
		if (updateResult.upsertedCount === 0) {
			const existing = await col.findOne(identityFilter, {
				projection: { episodeId: 1 },
			})
			if (
				typeof existing?.episodeId === "string" &&
				existing.episodeId.trim()
			) {
				persistedEpisodeId = existing.episodeId
			}
		}

		// The cap only needs attention when this call INSERTED an episode — a
		// re-materialization of an existing window leaves the count unchanged.
		if (updateResult.upsertedCount === 1) {
			try {
				await enforceEpisodesScopeCap({
					db,
					prefix,
					agentId,
					scope: resolvedScope,
					scopeRef,
				})
			} catch (err) {
				log.warn(
					`episodes cap enforcement failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		const episode: Episode = {
			episodeId: persistedEpisodeId,
			type,
			title,
			summary,
			agentId,
			scope: resolvedScope,
			scopeRef,
			timeRange: { start: timeRange.start, end: timeRange.end },
			sourceEventCount: events.length,
			sourceEventIds,
			updatedAt: now,
			...(tags !== undefined && { tags }),
		}

		log.info(
			`episode materialized: ${episodeId} type=${type} events=${events.length} agent=${agentId}`,
		)
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId,
				projectionType: "episodes",
				status: "ok",
				itemsProjected: 1,
				durationMs: Date.now() - startMs,
			},
		}).catch(() => {})
		return episode
	} catch (err) {
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId,
				projectionType: "episodes",
				status: "failed",
				itemsProjected: 0,
				durationMs: Date.now() - startMs,
			},
		}).catch(() => {})
		log.error(
			`materializeEpisode failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Get episodes by time range (overlap query)
// ---------------------------------------------------------------------------

export async function getEpisodesByTimeRange(params: {
	db: Db
	prefix: string
	agentId: string
	start: Date
	end: Date
	type?: EpisodeType
	scope?: MemoryScope
	scopeRef?: string
}): Promise<Episode[]> {
	const { db, prefix, agentId, start, end, type, scope, scopeRef } = params
	try {
		const col = episodesCollection(db, prefix)

		// Overlap condition: episode.timeRange.start <= query.end AND episode.timeRange.end >= query.start
		// Status filter: $ne "deleted" matches docs where field is absent OR any value other than "deleted"
		const filter: Document = {
			agentId,
			"timeRange.start": { $lte: end },
			"timeRange.end": { $gte: start },
			status: { $ne: "deleted" },
		}
		if (type) {
			filter.type = type
		}
		if (scope) {
			filter.scope = scope
		}
		if (scopeRef) {
			filter.scopeRef = scopeRef
		}

		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		const docs = await col
			.find(filter)
			.sort({ "timeRange.start": -1 })
			.limit(100)
			.toArray()

		return docs as unknown as Episode[]
	} catch (err) {
		log.error(
			`getEpisodesByTimeRange failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Get episodes by type
// ---------------------------------------------------------------------------

export async function getEpisodesByType(params: {
	db: Db
	prefix: string
	agentId: string
	type: EpisodeType
	scope?: MemoryScope
	scopeRef?: string
	limit?: number
}): Promise<Episode[]> {
	const { db, prefix, agentId, type, scope, scopeRef, limit } = params
	try {
		const col = episodesCollection(db, prefix)

		const docs = await col
			.find({
				agentId,
				type,
				status: { $ne: "deleted" },
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ updatedAt: -1 })
			.limit(limit ?? 50)
			.toArray()

		return docs as unknown as Episode[]
	} catch (err) {
		log.error(
			`getEpisodesByType failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Search episodes by regex on summary/title
// ---------------------------------------------------------------------------

export async function searchEpisodes(params: {
	db: Db
	prefix: string
	query: string
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	timeRange?: { start: Date; end: Date }
	limit?: number
	/**
	 * P3.8: detected textSearch capability. When true, lookup routes through
	 * the episode_autocomplete $search index; when false/omitted (no mongot),
	 * the escaped $regex fallback runs directly instead of paying a failed
	 * $search round trip per lookup.
	 */
	textSearchAvailable?: boolean
}): Promise<Episode[]> {
	const { db, prefix, query, agentId, scope, scopeRef, timeRange, limit } =
		params

	// Guard: empty/whitespace-only query would produce a match-all regex
	if (!query.trim()) {
		return []
	}

	const col = episodesCollection(db, prefix)

	// P3.8: serve episode lookup from the purpose-built episode_autocomplete
	// search index when mongot is present; the unanchored case-insensitive
	// $regex below remains the no-textSearch fallback.
	if (params.textSearchAvailable === true) {
		try {
			const searchFilters: Document[] = [
				{ equals: { path: "agentId", value: agentId } },
			]
			if (scope) {
				searchFilters.push({ equals: { path: "scope", value: scope } })
			}
			if (scopeRef) {
				searchFilters.push({ equals: { path: "scopeRef", value: scopeRef } })
			}
			const postMatch: Document = { status: { $ne: "deleted" } }
			if (timeRange) {
				postMatch["timeRange.start"] = { $lte: timeRange.end }
				postMatch["timeRange.end"] = { $gte: timeRange.start }
			}
			const pipeline: Document[] = [
				{
					$search: {
						index: "episode_autocomplete",
						compound: {
							should: [
								{ autocomplete: { query, path: "title" } },
								{ autocomplete: { query, path: "summary" } },
							],
							filter: searchFilters,
						},
					},
				},
				{ $match: postMatch },
				{ $limit: limit ?? 50 },
			]
			const docs = await col
				// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
				.aggregate(pipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
				.toArray()
			return docs as unknown as Episode[]
		} catch (err) {
			log.warn(
				`searchEpisodes $search failed, falling back to regex: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	try {
		// Use a keyword-aware regex so summary-style queries can reopen episodes
		// without requiring the full prompt to appear verbatim.
		const regex = buildEpisodeSearchRegex(query)

		const filter: Document = {
			agentId,
			status: { $ne: "deleted" },
			$or: [{ title: { $regex: regex } }, { summary: { $regex: regex } }],
		}
		if (scope) {
			filter.scope = scope
		}
		if (scopeRef) {
			filter.scopeRef = scopeRef
		}
		if (timeRange) {
			filter["timeRange.start"] = { $lte: timeRange.end }
			filter["timeRange.end"] = { $gte: timeRange.start }
		}

		const docs = await col
			.find(filter)
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ updatedAt: -1 })
			.limit(limit ?? 50)
			.toArray()

		return docs as unknown as Episode[]
	} catch (err) {
		log.error(
			`searchEpisodes failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Update episode status (active/archived/deleted)
// ---------------------------------------------------------------------------

export async function updateEpisodeStatus(params: {
	db: Db
	prefix: string
	episodeId: string
	agentId: string
	status: EpisodeStatus
}): Promise<boolean> {
	const { db, prefix, episodeId, agentId, status } = params
	try {
		const col = episodesCollection(db, prefix)
		const result = await col.updateOne(
			{ episodeId, agentId },
			{ $set: { status, updatedAt: new Date() } },
		)
		return result.matchedCount > 0
	} catch (err) {
		log.error(
			`updateEpisodeStatus failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Get episodes by ID list (Phase 9: tiered retrieval)
// ---------------------------------------------------------------------------

export async function getEpisodesByIds(params: {
	db: Db
	prefix: string
	episodeIds: string[]
	agentId: string
	/** @deprecated searchV2 owns ids-only projection; this reopen helper always returns full episodes. */
	projection?: "full" | "ids-only"
}): Promise<Episode[]> {
	const { db, prefix, episodeIds, agentId } = params
	if (episodeIds.length === 0) {
		return []
	}
	try {
		const col = episodesCollection(db, prefix)
		const docs = await col
			.find({
				episodeId: { $in: episodeIds },
				agentId,
				status: { $ne: "deleted" },
			})
			.toArray()
		return docs as unknown as Episode[]
	} catch (err) {
		log.error(
			`getEpisodesByIds failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Auto episode trigger result type
// ---------------------------------------------------------------------------

export type AutoEpisodeTriggerResult = {
	triggered: boolean
	reason?:
		| "session_gap"
		| "event_count"
		| "explicit"
		| "rate_limited"
		| "insufficient_events"
		| "memoized_negative"
	episode?: Episode
}

async function hasRecentEpisodeWrite(params: {
	db: Db
	prefix: string
	agentId: string
	since: Date
	scope?: MemoryScope
	scopeRef?: string
}): Promise<boolean> {
	const recent = await episodesCollection(params.db, params.prefix)
		.find({
			agentId: params.agentId,
			status: { $ne: "deleted" },
			...(params.scope ? { scope: params.scope } : {}),
			...(params.scopeRef ? { scopeRef: params.scopeRef } : {}),
			// updatedAt is set on both insert and re-materialization, so this
			// measures episode write recency rather than source-event recency.
			updatedAt: { $gte: params.since },
		})
		// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
		.sort({ updatedAt: -1 })
		.limit(1)
		.toArray()
	return recent.length > 0
}

// ---------------------------------------------------------------------------
// WS-16 (C-034): negative-result memoization for the auto-trigger cooldown
// ---------------------------------------------------------------------------

/**
 * How long a NEGATIVE auto-trigger check is remembered per agent+scope, so
 * the cold window (no recent episode write, not enough events) pays the
 * 500-event unconsolidated scan once per TTL instead of once per write.
 */
export const AUTO_EPISODE_NEGATIVE_MEMO_MS = 60_000

const autoEpisodeNegativeMemo = new Map<string, number>()

function autoEpisodeNegativeMemoKey(params: {
	prefix: string
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
}): string {
	return [
		params.prefix,
		params.agentId,
		params.scope ?? "",
		params.scopeRef ?? "",
	].join("|")
}

function hasFreshNegativeMemo(params: {
	prefix: string
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	now?: number
}): boolean {
	const memoizedAt = autoEpisodeNegativeMemo.get(
		autoEpisodeNegativeMemoKey(params),
	)
	if (memoizedAt === undefined) return false
	const now = params.now ?? Date.now()
	return now - memoizedAt < AUTO_EPISODE_NEGATIVE_MEMO_MS
}

function rememberNegativeMemo(params: {
	prefix: string
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	now?: number
}): void {
	autoEpisodeNegativeMemo.set(
		autoEpisodeNegativeMemoKey(params),
		params.now ?? Date.now(),
	)
}

/** Test seam: clears the negative-result memo between test cases. */
export function resetAutoEpisodeNegativeMemoForTests(): void {
	autoEpisodeNegativeMemo.clear()
}

// ---------------------------------------------------------------------------
// Check if auto episode materialization should trigger
// ---------------------------------------------------------------------------

/**
 * Check if auto episode materialization should trigger.
 * Three triggers:
 * (a) Session gap: >sessionGapMinutes between consecutive events
 * (b) Event count: >maxEventsWithoutEpisode unconsolidated events
 * (c) Explicit: force=true (user-triggered)
 *
 * MUST be async (not blocking write path) -- the summarizer is an LLM call.
 * The recent-write cooldown is best-effort: it suppresses work observed after
 * a completed episode write, but it is not a distributed scheduling claim.
 * A recent NEGATIVE result is memoized in-memory per agent+scope for
 * AUTO_EPISODE_NEGATIVE_MEMO_MS, so cold-window writes pay one cooldown
 * query instead of a cooldown query plus the 500-event scan.
 */
export async function checkAutoEpisodeTriggers(params: {
	db: Db
	prefix: string
	agentId: string
	summarizer: EpisodeSummarizer
	scope?: MemoryScope
	scopeRef?: string
	sessionGapMinutes?: number
	maxEventsWithoutEpisode?: number
	rateLimitMinutes?: number
	force?: boolean
}): Promise<AutoEpisodeTriggerResult> {
	const {
		db,
		prefix,
		agentId,
		summarizer,
		scope,
		scopeRef,
		sessionGapMinutes = 30,
		maxEventsWithoutEpisode = 50,
		rateLimitMinutes = 60,
		force = false,
	} = params

	try {
		// 1. Best-effort cooldown check (unless forced). Run it before loading
		// up to 500 unconsolidated event documents.
		if (!force) {
			const now = new Date()
			const rateLimitWindow = new Date(
				now.getTime() - rateLimitMinutes * 60 * 1000,
			)
			const rateLimited = await hasRecentEpisodeWrite({
				db,
				prefix,
				agentId,
				since: rateLimitWindow,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			if (rateLimited) {
				return { triggered: false, reason: "rate_limited" }
			}

			// 1b. WS-16 (C-034): a recent NEGATIVE answer is memoized per
			// agent+scope for ~60s, so the cold window pays ONE cooldown
			// query per write — not the cooldown query plus the 500-event
			// unconsolidated scan every single time. The TTL bounds how long
			// a fresh trigger condition can be deferred.
			if (hasFreshNegativeMemo({ prefix, agentId, scope, scopeRef })) {
				return { triggered: false, reason: "memoized_negative" }
			}
		}

		// 2. Get unconsolidated events only when an episode may be created.
		const events = await getUnconsolidatedEvents({
			db,
			prefix,
			agentId,
			scope,
			scopeRef,
			limit: 500,
		})

		// Need at least 2 events for any episode
		if (events.length < 2) {
			rememberNegativeMemo({ prefix, agentId, scope, scopeRef })
			return { triggered: false, reason: "insufficient_events" }
		}

		// 3. Determine trigger reason
		let triggerReason: "session_gap" | "event_count" | "explicit" | undefined

		if (force) {
			triggerReason = "explicit"
		} else {
			// Check session gap
			const gapMs = sessionGapMinutes * 60 * 1000
			for (let i = 1; i < events.length; i++) {
				const gap =
					events[i].timestamp.getTime() - events[i - 1].timestamp.getTime()
				if (gap > gapMs) {
					triggerReason = "session_gap"
					break
				}
			}

			// Check event count
			if (!triggerReason && events.length > maxEventsWithoutEpisode) {
				triggerReason = "event_count"
			}
		}

		if (!triggerReason) {
			rememberNegativeMemo({ prefix, agentId, scope, scopeRef })
			return { triggered: false }
		}

		// 4. Determine time range from unconsolidated events
		const episodeEvents = resolveTriggeredEpisodeWindow({
			events,
			triggerReason,
			sessionGapMinutes,
			maxEventsWithoutEpisode,
		})
		if (episodeEvents.length < 2) {
			rememberNegativeMemo({ prefix, agentId, scope, scopeRef })
			return { triggered: false, reason: "insufficient_events" }
		}
		const timeRange = {
			start: episodeEvents[0].timestamp,
			end: episodeEvents[episodeEvents.length - 1].timestamp,
		}

		// 5. Materialize episode
		const episode = await materializeEpisode({
			db,
			prefix,
			agentId,
			type: "thread", // auto-triggered episodes are "thread" type
			timeRange,
			scope,
			scopeRef,
			summarizer,
			// Materialize exactly the selected window — no re-query that could
			// absorb events written mid-flight (P0.4 set divergence).
			events: episodeEvents,
		})

		if (!episode) {
			rememberNegativeMemo({ prefix, agentId, scope, scopeRef })
			return { triggered: false, reason: "insufficient_events" }
		}

		// 6. Mark events as consolidated
		const eventIds = episodeEvents.map((e) => e.eventId)
		await markEventsConsolidated({
			db,
			prefix,
			eventIds,
			episodeId: episode.episodeId,
		})

		log.info(
			`auto episode triggered: reason=${triggerReason} episode=${episode.episodeId} events=${eventIds.length} agent=${agentId}`,
		)
		return { triggered: true, reason: triggerReason, episode }
	} catch (err) {
		log.error(
			`checkAutoEpisodeTriggers failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}
