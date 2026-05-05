import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { synthesizeProfile, type ProfileSynthesis } from "./mongodb-profile.js"
import { resolveTimeRangePreset } from "./mongodb-retrieval-planner.js"
import { episodesCollection, eventsCollection } from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import type {
	MemoryContextBundle,
	MemoryContextBundleRequest,
	MemoryContextBundleSection,
	MemoryContextBundleSectionItem,
	MemoryDiscoveryProjection,
	MemoryDiscoveryProjectionKind,
	MemorySearchResult,
	MemorySearchTimeRange,
	MemorySearchTrustSummary,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:context-bundle")

const DEFAULT_TOKEN_BUDGET = 450
const MIN_TOKEN_BUDGET = 128
const MAX_TOKEN_BUDGET = 4000
const DEFAULT_MAX_EVIDENCE_ITEMS = 4
const MAX_EVIDENCE_ITEMS = 8
const DEFAULT_MAX_RECENT_EVENTS = 4
const MAX_RECENT_EVENTS = 8
const DEFAULT_MAX_ACTIVE_ITEMS = 4
const MAX_PROFILE_ITEMS = 6

type SearchBundleResult = {
	results: MemorySearchResult[]
	pathsExecuted: string[]
	trustSummary?: MemorySearchTrustSummary
}

type CandidateSection = {
	kind: MemoryContextBundleSection["kind"]
	title: string
	summary?: string
	items: MemoryContextBundleSectionItem[]
	partial?: boolean
}

type EpisodeSummaryDoc = {
	episodeId?: string
	title?: string
	summary?: string
	shortTermSummary?: string
	mediumTermSummary?: string
	longTermSummary?: string
	topics?: string[]
	timeRange?: {
		start?: Date
		end?: Date
	}
	scope?: MemoryScope
	scopeRef?: string
	sourceEventIds?: string[]
}

function estimateTokens(text: string): number {
	if (!text.trim()) {
		return 0
	}
	return Math.max(1, Math.ceil(text.length / 4))
}

function clampTokenBudget(tokenBudget?: number): number {
	if (!Number.isFinite(tokenBudget)) {
		return DEFAULT_TOKEN_BUDGET
	}
	return Math.max(
		MIN_TOKEN_BUDGET,
		Math.min(MAX_TOKEN_BUDGET, Math.floor(tokenBudget ?? 0)),
	)
}

function clampCount(
	value: number | undefined,
	defaultValue: number,
	maxValue: number,
): number {
	if (!Number.isFinite(value)) {
		return defaultValue
	}
	return Math.max(1, Math.min(maxValue, Math.floor(value ?? 0)))
}

function buildQueryRegex(query?: string): RegExp | undefined {
	const normalized = query?.trim()
	if (!normalized) {
		return undefined
	}
	const parts = Array.from(
		new Set(
			normalized
				.split(/\s+/)
				.map((part) => part.trim())
				.filter(Boolean)
				.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		),
	).slice(0, 8)
	if (parts.length === 0) {
		return undefined
	}
	return new RegExp(parts.join("|"), "i")
}

function getSourceEventIds(doc: {
	sourceEventIds?: unknown
}): string[] | undefined {
	if (!Array.isArray(doc.sourceEventIds)) {
		return undefined
	}
	const ids = doc.sourceEventIds.filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	)
	return ids.length > 0 ? ids : undefined
}

function resolveTimeRange(
	timeRange?: MemorySearchTimeRange,
): { start: Date; end: Date } | undefined {
	if (!timeRange) {
		return undefined
	}
	if (timeRange.start || timeRange.end) {
		const end = timeRange.end ? new Date(timeRange.end) : new Date()
		const start = timeRange.start
			? new Date(timeRange.start)
			: resolveTimeRangePreset("last-7d", end).start
		return { start, end }
	}
	if (timeRange.preset) {
		return resolveTimeRangePreset(timeRange.preset, new Date())
	}
	return undefined
}

function inferSessionId(
	scope: MemoryScope,
	scopeRef: string,
	sessionId?: string,
): string | undefined {
	if (sessionId?.trim()) {
		return sessionId.trim()
	}
	if (scope === "session" && scopeRef.startsWith("session:")) {
		return scopeRef.slice("session:".length)
	}
	return undefined
}

function summarizeSources(items: Array<{ source?: string }>): string {
	const unique = Array.from(
		new Set(
			items
				.map((item) => item.source?.trim())
				.filter((value): value is string => Boolean(value)),
		),
	)
	return unique.length > 0 ? unique.join(", ") : "memory"
}

function searchResultTitle(result: MemorySearchResult): string {
	if (result.citation?.trim()) {
		return result.citation
	}
	if (result.canonicalId?.trim()) {
		return result.canonicalId
	}
	return result.path
}

function formatTimestamp(value?: Date): string | undefined {
	if (!(value instanceof Date)) {
		return undefined
	}
	return value.toISOString().replace(".000Z", "Z")
}

function renderItem(item: MemoryContextBundleSectionItem): string {
	const summary = item.summary.trim()
	const timeLabel = formatTimestamp(item.timestamp)
	const pathLabel = item.path?.trim()
	const trustLabel = item.trust?.confidence

	let line = `- ${item.title.trim() || "Untitled"}`
	if (timeLabel) {
		line += ` [${timeLabel}]`
	}
	if (summary) {
		line += `: ${summary}`
	}
	if (trustLabel) {
		line += ` {trust:${trustLabel}}`
	}
	if (pathLabel) {
		line += ` (${pathLabel})`
	}
	return line
}

function renderSectionText(section: {
	title: string
	summary?: string
	items: MemoryContextBundleSectionItem[]
}): string {
	const lines = [`## ${section.title}`]
	if (section.summary?.trim()) {
		lines.push(section.summary.trim())
	}
	for (const item of section.items) {
		lines.push(renderItem(item))
	}
	return lines.join("\n")
}

function materializeSection(
	candidate: CandidateSection,
	remainingBudget: number,
): MemoryContextBundleSection | null {
	if (candidate.items.length === 0 && !candidate.summary?.trim()) {
		return null
	}
	const keptItems: MemoryContextBundleSectionItem[] = []
	let truncated = false

	const baseText = renderSectionText({
		title: candidate.title,
		summary: candidate.summary,
		items: [],
	})
	if (estimateTokens(baseText) > remainingBudget) {
		return null
	}

	for (const item of candidate.items) {
		const nextItems = [...keptItems, item]
		const nextText = renderSectionText({
			title: candidate.title,
			summary: candidate.summary,
			items: nextItems,
		})
		if (estimateTokens(nextText) <= remainingBudget) {
			keptItems.push(item)
			continue
		}
		truncated = true
		break
	}

	const rendered = renderSectionText({
		title: candidate.title,
		summary: candidate.summary,
		items: keptItems,
	})
	return {
		kind: candidate.kind,
		title: candidate.title,
		...(candidate.summary?.trim() ? { summary: candidate.summary.trim() } : {}),
		items: keptItems,
		estimatedTokens: estimateTokens(rendered),
		truncated,
		partial: candidate.partial ?? false,
	}
}

async function settled<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<{ value: T | null; failed: boolean }> {
	try {
		return { value: await fn(), failed: false }
	} catch (error) {
		log.warn(`buildContextBundle: ${label} query failed`, { error })
		return { value: null, failed: true }
	}
}

async function loadEpisodeSummary(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	query?: string
	timeRange?: MemorySearchTimeRange
}): Promise<EpisodeSummaryDoc | null> {
	const { db, prefix, agentId, scope, scopeRef, query, timeRange } = params
	const regex = buildQueryRegex(query)
	const filter: Document = {
		agentId,
		scope,
		scopeRef,
		status: { $ne: "deleted" },
	}
	if (regex) {
		filter.$or = [
			{ title: regex },
			{ summary: regex },
			{ shortTermSummary: regex },
			{ mediumTermSummary: regex },
			{ longTermSummary: regex },
			{ topics: regex },
		]
	}
	const resolvedTimeRange = resolveTimeRange(timeRange)
	if (resolvedTimeRange) {
		filter["timeRange.end"] = { $gte: resolvedTimeRange.start }
		filter["timeRange.start"] = { $lte: resolvedTimeRange.end }
	}
	return episodesCollection(db, prefix)
		.find(filter)
		.sort({ "timeRange.end": -1, updatedAt: -1 })
		.limit(1)
		.project({
			episodeId: 1,
			title: 1,
			summary: 1,
			shortTermSummary: 1,
			mediumTermSummary: 1,
			longTermSummary: 1,
			topics: 1,
			timeRange: 1,
			scope: 1,
			scopeRef: 1,
			sourceEventIds: 1,
		})
		.next() as Promise<EpisodeSummaryDoc | null>
}

/** Classify a search result as explicit (user-stated) or derived (agent-inferred). */
function isExplicitEvidence(result: MemorySearchResult): boolean {
	// High confidence (>=0.9) or no confidence (pre-existing data) = explicit
	if (typeof result.confidence === "number") {
		return result.confidence >= 0.9
	}
	// No confidence field = pre-existing data, treat as explicit
	return true
}

function toEvidenceItem(result: MemorySearchResult) {
	return {
		title: searchResultTitle(result),
		summary: result.snippet.slice(0, 700),
		path: result.path,
		source: result.source,
		canonicalId: result.canonicalId,
		timestamp: result.timestamp,
		scope: result.scope,
		scopeRef: result.scopeRef,
		sourceEventIds: result.sourceEventIds,
		trust: result.trust,
	}
}

/**
 * Split search results into explicit evidence (user-stated facts) and
 * derived insights (agent-extracted, inferred). Prevents retrieval dilution
 * where derived insights crowd out explicit facts in a single result set.
 * (Phase 3.2 — Multi-Level Prefetching, from Honcho two-pass pattern)
 */
function buildQueryEvidenceSections(
	searchResult: SearchBundleResult,
): CandidateSection[] {
	if (searchResult.results.length === 0) {
		return []
	}

	const explicit: MemorySearchResult[] = []
	const derived: MemorySearchResult[] = []
	for (const result of searchResult.results) {
		if (isExplicitEvidence(result)) {
			explicit.push(result)
		} else {
			derived.push(result)
		}
	}

	const sections: CandidateSection[] = []

	if (explicit.length > 0) {
		const items = explicit.map(toEvidenceItem)
		const sourceSummary = summarizeSources(items)
		sections.push({
			kind: "query-evidence",
			title: "Direct Evidence",
			summary: `${items.length} user-stated fact${items.length === 1 ? "" : "s"} across ${sourceSummary}.`,
			items,
		})
	}

	if (derived.length > 0) {
		const items = derived.map(toEvidenceItem)
		const sourceSummary = summarizeSources(items)
		sections.push({
			kind: "query-evidence",
			title: "Derived Insights",
			summary: `${items.length} agent-inferred insight${items.length === 1 ? "" : "s"} across ${sourceSummary}.`,
			items,
		})
	}

	return sections
}

function buildSummarySection(
	summaryDoc: EpisodeSummaryDoc,
): CandidateSection | null {
	const chosenSummary =
		summaryDoc.shortTermSummary ??
		summaryDoc.mediumTermSummary ??
		summaryDoc.longTermSummary ??
		summaryDoc.summary
	if (!chosenSummary?.trim()) {
		return null
	}
	return {
		kind: "summary",
		title: "Episode Summary",
		items: [
			{
				title: summaryDoc.title?.trim() || "Recent episode",
				summary: chosenSummary.trim().slice(0, 900),
				path: summaryDoc.episodeId
					? `episode:${summaryDoc.episodeId}`
					: undefined,
				source: "episodic",
				timestamp: summaryDoc.timeRange?.end,
				scope: summaryDoc.scope,
				scopeRef: summaryDoc.scopeRef,
				sourceEventIds: getSourceEventIds(summaryDoc),
				metadata:
					Array.isArray(summaryDoc.topics) && summaryDoc.topics.length > 0
						? { topics: summaryDoc.topics.slice(0, 8) }
						: undefined,
			},
		],
	}
}

function buildRecentEventsSection(
	sessionId: string | undefined,
	eventDocs: Document[],
): CandidateSection | null {
	if (eventDocs.length === 0) {
		return null
	}
	return {
		kind: "recent-events",
		title: sessionId ? "Recent Session Events" : "Recent Events",
		summary: sessionId
			? `Most recent conversation anchors from session ${sessionId}.`
			: "Most recent conversation anchors in the requested scope.",
		items: eventDocs.map((doc) => ({
			title:
				typeof doc.role === "string" && doc.role.trim()
					? `${doc.role} event`
					: "conversation event",
			summary: typeof doc.body === "string" ? doc.body.slice(0, 700) : "",
			path:
				typeof doc.eventId === "string" ? `events/${doc.eventId}` : undefined,
			source: "conversation",
			canonicalId:
				typeof doc.eventId === "string" ? `event:${doc.eventId}` : undefined,
			timestamp: doc.timestamp instanceof Date ? doc.timestamp : undefined,
			scope:
				typeof doc.scope === "string" ? (doc.scope as MemoryScope) : undefined,
			scopeRef: typeof doc.scopeRef === "string" ? doc.scopeRef : undefined,
			sourceEventIds:
				typeof doc.eventId === "string" ? [doc.eventId] : undefined,
			metadata: typeof doc.role === "string" ? { role: doc.role } : undefined,
		})),
	}
}

function buildDiscoverySection(
	projection: MemoryDiscoveryProjection,
): CandidateSection | null {
	const items = projection.sections.flatMap((section) =>
		section.evidence.map((entry) => ({
			title: `${section.title}: ${entry.title}`,
			summary: entry.summary,
			path: entry.path,
			source: entry.source,
			canonicalId: entry.canonicalId,
			timestamp: entry.timestamp,
			scope: entry.scope,
			scopeRef: entry.scopeRef,
			sourceEventIds: entry.sourceEventIds,
		})),
	)
	if (items.length === 0 && !projection.summary.trim()) {
		return null
	}
	return {
		kind: "discovery-projection",
		title: "Discovery Projection",
		summary: projection.summary,
		items,
		partial: projection.metadata.partial,
	}
}

function buildProfileSection(
	profile: ProfileSynthesis,
): CandidateSection | null {
	const items: MemoryContextBundleSectionItem[] = [
		...profile.decisions.slice(0, 2).map((item) => ({
			title: `Decision: ${item.key}`,
			summary: item.value.slice(0, 500),
			source: "structured",
			timestamp: item.updatedAt,
			metadata: { salience: item.salience },
		})),
		...profile.facts.slice(0, 2).map((item) => ({
			title: `Fact: ${item.key}`,
			summary: item.value.slice(0, 500),
			source: "structured",
			timestamp: item.updatedAt,
			metadata: { salience: item.salience },
		})),
		...profile.todos.slice(0, 1).map((item) => ({
			title: `Todo: ${item.key}`,
			summary: item.value.slice(0, 500),
			source: "structured",
			timestamp: item.updatedAt,
			metadata: { salience: item.salience },
		})),
		...profile.topEntities.slice(0, 1).map((item) => ({
			title: `Entity: ${item.name}`,
			summary: `${item.type} with ${item.relationCount} linked relation${item.relationCount === 1 ? "" : "s"}.`,
			source: "graph",
		})),
	].slice(0, MAX_PROFILE_ITEMS)

	if (items.length === 0) {
		return null
	}
	const lastActive = profile.activityPatterns.lastActive
	return {
		kind: "profile",
		title: "Profile Synthesis",
		summary: lastActive
			? `Profile synthesis across structured memory, entities, episodes, and events. Last active at ${lastActive.toISOString().replace(".000Z", "Z")}.`
			: "Profile synthesis across structured memory, entities, episodes, and events.",
		items,
	}
}

export async function buildContextBundle(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	request?: MemoryContextBundleRequest
	search?: (params: {
		query: string
		scope: MemoryScope
		scopeRef: string
		maxResults: number
		sessionId?: string
	}) => Promise<SearchBundleResult>
}): Promise<MemoryContextBundle> {
	const startedAt = Date.now()
	const { db, prefix, agentId, scope, scopeRef } = params
	const request = params.request ?? {}
	const isWakeUp = request.mode === "wake-up"
	const query = isWakeUp ? undefined : request.query?.trim() || undefined
	const sessionId = inferSessionId(
		scope,
		scopeRef,
		typeof request.sessionId === "string" ? request.sessionId : undefined,
	)
	const tokenBudget = isWakeUp ? 250 : clampTokenBudget(request.tokenBudget)
	const maxActiveItems = isWakeUp
		? 5
		: clampCount(request.maxActiveItems, DEFAULT_MAX_ACTIVE_ITEMS, 6)
	const maxEvidenceItems = isWakeUp
		? 0
		: clampCount(
				request.maxEvidenceItems,
				DEFAULT_MAX_EVIDENCE_ITEMS,
				MAX_EVIDENCE_ITEMS,
			)
	const maxRecentEvents = isWakeUp
		? 1
		: clampCount(
				request.maxRecentEvents,
				DEFAULT_MAX_RECENT_EVENTS,
				MAX_RECENT_EVENTS,
			)
	const recentEventScope = sessionId ? "session" : scope
	const recentEventScopeRef = sessionId
		? resolveScopeRef({ scope: "session", agentId, sessionId })
		: scopeRef

	const pathsExecuted = new Set<string>()
	let partial = false

	const [activeSlateResult, searchResult, summaryResult, recentEventsResult] =
		await Promise.all([
			settled("active-slate", () =>
				hydrateActiveSlate({
					db,
					prefix,
					agentId,
					scope,
					scopeRef,
					maxItems: maxActiveItems,
				}),
			),
			query && params.search
				? settled(
						"query-evidence",
						() =>
							params.search?.({
								query,
								scope,
								scopeRef,
								maxResults: maxEvidenceItems,
								sessionId,
							}) ?? Promise.resolve({ results: [], pathsExecuted: [] }),
					)
				: Promise.resolve({ value: null, failed: false }),
			settled("episode-summary", () =>
				loadEpisodeSummary({
					db,
					prefix,
					agentId,
					scope,
					scopeRef,
					query,
					timeRange: request.timeRange,
				}),
			),
			settled("recent-events", () =>
				eventsCollection(db, prefix)
					.find({
						agentId,
						scope: recentEventScope,
						scopeRef: recentEventScopeRef,
					})
					.sort({ timestamp: -1 })
					.limit(maxRecentEvents)
					.project({
						eventId: 1,
						role: 1,
						body: 1,
						timestamp: 1,
						scope: 1,
						scopeRef: 1,
					})
					.toArray(),
			),
		])

	partial ||= activeSlateResult.failed
	partial ||= searchResult.failed
	partial ||= summaryResult.failed
	partial ||= recentEventsResult.failed

	const candidates: CandidateSection[] = []

	if (activeSlateResult.value) {
		pathsExecuted.add("active-slate")
		candidates.push({
			kind: "active-slate",
			title: "Active Slate",
			summary:
				"Highest-salience durable state assembled from structured memory, procedures, and recent anchors.",
			items: activeSlateResult.value.items.map((item) => ({
				title: item.title,
				summary: item.summary,
				path: item.path,
				source: item.source,
				canonicalId: item.canonicalId,
				timestamp: item.timestamp,
				scope: item.scope,
				scopeRef: item.scopeRef,
				sourceEventIds: item.sourceEventIds,
				metadata: {
					kind: item.kind,
					...(item.state ? { state: item.state } : {}),
					...(item.salience ? { salience: item.salience } : {}),
				},
			})),
			partial: activeSlateResult.value.metadata.partial,
		})
		partial ||= activeSlateResult.value.metadata.partial
	}

	if (searchResult.value) {
		for (const path of searchResult.value.pathsExecuted) {
			pathsExecuted.add(path)
		}
		if (searchResult.value.results.length > 0) {
			const evidenceSections = buildQueryEvidenceSections(searchResult.value)
			candidates.push(...evidenceSections)
		}
	}

	if (summaryResult.value) {
		pathsExecuted.add("episode-summary")
		const section = buildSummarySection(summaryResult.value)
		if (section) {
			candidates.push(section)
		}
	}

	if (recentEventsResult.value) {
		pathsExecuted.add("recent-events")
		const section = buildRecentEventsSection(
			sessionId,
			recentEventsResult.value,
		)
		if (section) {
			candidates.push(section)
		}
	}

	if (request.includeDiscoveryProjection && !isWakeUp) {
		const inferredKind: MemoryDiscoveryProjectionKind = request.discoveryKind
			? request.discoveryKind
			: query
				? "topic-brief"
				: "what-changed"
		const projectionResult = await settled("discovery-projection", () =>
			buildDiscoveryProjection({
				db,
				prefix,
				agentId,
				kind: inferredKind,
				query,
				scope,
				scopeRef,
				maxItems: maxEvidenceItems,
				timeRange: request.timeRange,
			}),
		)
		partial ||= projectionResult.failed
		if (projectionResult.value) {
			pathsExecuted.add("discovery-projection")
			const section = buildDiscoverySection(projectionResult.value)
			if (section) {
				candidates.push(section)
			}
		}
	}

	if (request.includeProfile || isWakeUp) {
		const profileResult = await settled("profile", () =>
			synthesizeProfile({
				db,
				prefix,
				agentId,
				scope,
				scopeRef,
				maxPerType: isWakeUp ? 3 : 4,
				maxEntities: isWakeUp ? 0 : 2,
				maxEpisodes: isWakeUp ? 0 : 2,
			}),
		)
		partial ||= profileResult.failed
		if (profileResult.value) {
			pathsExecuted.add("profile")
			const section = buildProfileSection(profileResult.value)
			if (section) {
				candidates.push(section)
			}
		}
	}

	const sections: MemoryContextBundleSection[] = []
	let estimatedTokensUsed = 0
	let truncated = false

	for (const candidate of candidates) {
		const section = materializeSection(
			candidate,
			Math.max(0, tokenBudget - estimatedTokensUsed),
		)
		if (!section) {
			truncated = true
			continue
		}
		sections.push(section)
		estimatedTokensUsed += section.estimatedTokens
		truncated ||= section.truncated
		partial ||= section.partial
	}

	const rendered = sections
		.map((section) =>
			renderSectionText({
				title: section.title,
				summary: section.summary,
				items: section.items,
			}),
		)
		.join("\n\n")

	emitTelemetry(db, prefix, {
		meta: { agentId, operation: "context-bundle" },
		durationMs: Date.now() - startedAt,
		ok: sections.length > 0,
		pathUsed: Array.from(pathsExecuted).join(","),
		itemCount: sections.reduce(
			(total, section) => total + section.items.length,
			0,
		),
		resultCount: sections.length,
	})

	return {
		agentId,
		...(query ? { query } : {}),
		scope,
		scopeRef,
		...(sessionId ? { sessionId } : {}),
		rendered,
		sections,
		metadata: {
			tokenBudget,
			estimatedTokensUsed,
			partial,
			truncated,
			pathsExecuted: Array.from(pathsExecuted),
			...(searchResult.value?.trustSummary
				? { trustSummary: searchResult.value.trustSummary }
				: {}),
			sectionsIncluded: sections.map((section) => section.kind),
		},
		builtAt: new Date(),
	}
}
