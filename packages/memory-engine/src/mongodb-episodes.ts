import { randomUUID } from "node:crypto"
import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import {
	getEventsByTimeRange,
	getUnconsolidatedEvents,
	markEventsConsolidated,
} from "./mongodb-events.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import { episodesCollection } from "./mongodb-schema.js"
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

export type EpisodeSummarizer = (
	events: Array<{ role: string; body: string; timestamp: Date }>,
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
		// 1. Read raw events for the time range
		const events = await getEventsByTimeRange({
			db,
			prefix,
			agentId,
			start: timeRange.start,
			end: timeRange.end,
			scope: resolvedScope,
			scopeRef,
		})

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
		} = await summarizer(summarizerInput)

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

		// 5. Idempotent upsert: filter on {agentId, type, timeRange.start, timeRange.end}
		//    episodeId goes in $setOnInsert so it is stable across re-materializations
		const col = episodesCollection(db, prefix)
		const identityFilter = {
			agentId,
			type,
			scope: resolvedScope,
			scopeRef,
			"timeRange.start": timeRange.start,
			"timeRange.end": timeRange.end,
		}
		const updateResult = await col.updateOne(
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
}): Promise<Episode[]> {
	const { db, prefix, query, agentId, scope, scopeRef, timeRange, limit } =
		params

	// Guard: empty/whitespace-only query would produce a match-all regex
	if (!query.trim()) {
		return []
	}

	try {
		const col = episodesCollection(db, prefix)

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
	episode?: Episode
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
 * Rate limited: max 1 episode per rateLimitMinutes per agent.
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
		// 1. Get unconsolidated events
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
			return { triggered: false, reason: "insufficient_events" }
		}

		// 2. Rate limit check (unless forced)
		if (!force) {
			const now = new Date()
			const rateLimitWindow = new Date(
				now.getTime() - rateLimitMinutes * 60 * 1000,
			)
			const recentEpisodes = await getEpisodesByTimeRange({
				db,
				prefix,
				agentId,
				start: rateLimitWindow,
				end: now,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			if (recentEpisodes.length > 0) {
				return { triggered: false, reason: "rate_limited" }
			}
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
		})

		if (!episode) {
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
