import type { Collection, Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { buildBitemporalFilter } from "./mongodb-bitemporal.js"
import { type CanonicalEvent, renderEventChunkText } from "./mongodb-events.js"
import {
	buildVectorSearchStage,
	runSearchAggregateWithRetry,
	splitAtlasSearchFilter,
} from "./mongodb-search.js"
import {
	extractTemporalWindow,
	resolveNumCandidates,
	type TemporalWindow,
} from "./mongodb-retrieval-planner.js"
import {
	type DetectedCapabilities,
	eventsCollection,
} from "./mongodb-schema.js"
import type {
	ConversationRecallCitation,
	ConversationRecallRequest,
	ConversationRecallResponse,
	ConversationRecallResult,
	ConversationRecallRole,
	ConversationRecallScoreDetailEntry,
	ConversationRecallScoreDetails,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:conversation-recall")

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_PREVIEW_LENGTH = 500

function clampLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIMIT
	}
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? DEFAULT_LIMIT)))
}

function escapeRegex(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function assertValidDate(value: Date, label: string): Date {
	if (Number.isNaN(value.getTime())) {
		throw new Error(`invalid ${label}`)
	}
	return value
}

function parseDateOnlyParts(value: string): {
	year: number
	month: number
	day: number
} | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
	if (!match) {
		return null
	}
	return {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
	}
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	})
	const parts = formatter.formatToParts(date)
	const values = Object.fromEntries(
		parts
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	) as Record<string, string>
	const utcMillis = Date.UTC(
		Number(values.year),
		Number(values.month) - 1,
		Number(values.day),
		Number(values.hour),
		Number(values.minute),
		Number(values.second),
	)
	return utcMillis - date.getTime()
}

function zonedTimeToUtc(params: {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	second: number
	millisecond: number
	timeZone: string
}): Date {
	const guess = new Date(
		Date.UTC(
			params.year,
			params.month - 1,
			params.day,
			params.hour,
			params.minute,
			params.second,
			params.millisecond,
		),
	)
	const initialOffset = getTimeZoneOffsetMs(guess, params.timeZone)
	let resolved = new Date(guess.getTime() - initialOffset)
	const correctedOffset = getTimeZoneOffsetMs(resolved, params.timeZone)
	if (correctedOffset !== initialOffset) {
		resolved = new Date(guess.getTime() - correctedOffset)
	}
	return resolved
}

function addUtcDays(
	date: { year: number; month: number; day: number },
	days: number,
): { year: number; month: number; day: number } {
	const next = new Date(
		Date.UTC(date.year, date.month - 1, date.day + days, 0, 0, 0, 0),
	)
	return {
		year: next.getUTCFullYear(),
		month: next.getUTCMonth() + 1,
		day: next.getUTCDate(),
	}
}

function normalizeTimeZone(timeZone?: string): string | undefined {
	const normalized = timeZone?.trim()
	if (!normalized) {
		return undefined
	}

	try {
		new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(
			new Date(),
		)
		return normalized
	} catch {
		log.warn(
			`invalid conversation recall timezone '${normalized}', falling back to UTC`,
		)
		return undefined
	}
}

function resolveTimeBoundary(
	input: string,
	edge: "start" | "end",
	timeZone?: string,
): Date {
	const normalized = input.trim()
	if (normalized.includes("T")) {
		return assertValidDate(new Date(normalized), `timestamp: ${input}`)
	}

	const dateParts = parseDateOnlyParts(normalized)
	if (!dateParts) {
		throw new Error(`invalid date boundary: ${input}`)
	}

	if (!timeZone) {
		return assertValidDate(
			new Date(
				`${normalized}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`,
			),
			`timestamp: ${input}`,
		)
	}

	if (edge === "end") {
		const nextDay = addUtcDays(dateParts, 1)
		return new Date(
			zonedTimeToUtc({
				...nextDay,
				hour: 0,
				minute: 0,
				second: 0,
				millisecond: 0,
				timeZone,
			}).getTime() - 1,
		)
	}
	return zonedTimeToUtc({
		...dateParts,
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0,
		timeZone,
	})
}

function buildTimestampFilter(startDate?: Date, endDate?: Date): Document {
	const filter: Document = {}
	if (startDate) {
		filter.$gte = startDate
	}
	if (endDate) {
		filter.$lte = endDate
	}
	return filter
}

function buildStandardRoleFilter(
	request: ConversationRecallRequest,
): Document | undefined {
	if (Array.isArray(request.roles) && request.roles.length > 0) {
		return { $in: request.roles }
	}
	if (request.includeToolMessages) {
		return undefined
	}
	return { $ne: "tool" }
}

function buildStandardFilter(params: {
	request: ConversationRecallRequest
	startDate?: Date
	endDate?: Date
	queryText?: string
	asOf?: Date
}): Document {
	const filter: Document = { agentId: params.request.agentId }
	if (params.request.sessionId) {
		filter.sessionId = params.request.sessionId
	}

	const roleFilter = buildStandardRoleFilter(params.request)
	if (roleFilter) {
		filter.role = roleFilter
	}

	const timestampFilter = buildTimestampFilter(params.startDate, params.endDate)
	if (Object.keys(timestampFilter).length > 0) {
		filter.timestamp = timestampFilter
	}

	if (params.queryText) {
		filter.body = { $regex: new RegExp(escapeRegex(params.queryText), "i") }
	}

	// Bi-temporal recall safety: merge bi-temporal validity clause
	// via `$and` so any memory invalidated at or before `asOf` is excluded.
	// Legacy rows without `validAt`/`invalidAt` are treated as valid.
	if (params.asOf instanceof Date) {
		filter.$and = [buildBitemporalFilter(params.asOf)]
	}

	return filter
}

function buildVectorFilter(params: {
	request: ConversationRecallRequest
	startDate?: Date
	endDate?: Date
}): Document {
	const filter: Document = {
		agentId: { $eq: params.request.agentId },
	}
	if (params.request.sessionId) {
		filter.sessionId = { $eq: params.request.sessionId }
	}

	const roleFilter = buildStandardRoleFilter(params.request)
	if (roleFilter) {
		filter.role = roleFilter
	}

	const timestampFilter = buildTimestampFilter(params.startDate, params.endDate)
	if (Object.keys(timestampFilter).length > 0) {
		filter.timestamp = timestampFilter
	}

	return filter
}

function normalizeRole(value: unknown): ConversationRecallRole {
	switch (value) {
		case "user":
		case "assistant":
		case "system":
		case "tool":
			return value
		default:
			return "assistant"
	}
}

/**
 * Malformed scoreDetails handling: track malformed scoreDetails payloads so the
 * recall path can emit a single `log.warn` per recall call (not per doc)
 * when MongoDB returned a `scoreDetails` field that is shaped wrong.
 * "Absent" still returns undefined silently — only truly malformed data
 * is flagged.
 */
type ScoreDetailsWarningState = {
	warned: boolean
	sample?: { docId: string; raw: string }
}

function normalizeScoreDetails(
	raw: unknown,
	opts?: {
		docId?: string
		warnings?: ScoreDetailsWarningState
	},
): ConversationRecallScoreDetails | undefined {
	if (raw === undefined) {
		return undefined
	}
	// Explicitly malformed: present but not an object (or null).
	if (raw === null || typeof raw !== "object") {
		if (opts?.warnings && !opts.warnings.warned) {
			opts.warnings.warned = true
			opts.warnings.sample = {
				docId: opts.docId ?? "unknown",
				raw: (() => {
					try {
						return JSON.stringify(raw)
					} catch {
						return String(raw)
					}
				})(),
			}
		}
		return undefined
	}
	const source = raw as Record<string, unknown>
	const details: ConversationRecallScoreDetailEntry[] = []
	const rawDetails = source.details
	if (Array.isArray(rawDetails)) {
		for (const entry of rawDetails) {
			if (!entry || typeof entry !== "object") {
				continue
			}
			const e = entry as Record<string, unknown>
			const name =
				typeof e.inputPipelineName === "string"
					? e.inputPipelineName
					: typeof e.pipelineName === "string"
						? e.pipelineName
						: undefined
			if (name === undefined) {
				continue
			}
			details.push({
				inputPipelineName: name,
				rank: typeof e.rank === "number" ? e.rank : Number.NaN,
				weight: typeof e.weight === "number" ? e.weight : Number.NaN,
				value: typeof e.value === "number" ? e.value : Number.NaN,
			})
		}
	}
	const out: ConversationRecallScoreDetails = {}
	if (typeof source.value === "number") {
		out.value = source.value
	}
	if (typeof source.description === "string") {
		out.description = source.description
	}
	if (details.length > 0) {
		out.details = details
	}
	if (
		out.value === undefined &&
		out.description === undefined &&
		out.details === undefined
	) {
		// Present object but empty of recognized fields — malformed.
		if (opts?.warnings && !opts.warnings.warned) {
			opts.warnings.warned = true
			opts.warnings.sample = {
				docId: opts.docId ?? "unknown",
				raw: (() => {
					try {
						return JSON.stringify(raw)
					} catch {
						return "[unserializable]"
					}
				})(),
			}
		}
		return undefined
	}
	return out
}

function eventToRecallResult(
	doc: Document,
	matchType: ConversationRecallResult["matchType"],
	warnings?: ScoreDetailsWarningState,
): ConversationRecallResult {
	const event = doc as unknown as CanonicalEvent
	const citation: ConversationRecallCitation = {
		eventId: typeof event.eventId === "string" ? event.eventId : "",
		role: normalizeRole(event.role),
		timestamp: event.timestamp instanceof Date ? event.timestamp : new Date(0),
		preview: renderEventChunkText({
			role: normalizeRole(event.role),
			body: typeof event.body === "string" ? event.body : "",
		}).slice(0, MAX_PREVIEW_LENGTH),
		...(typeof event.sessionId === "string"
			? { sessionId: event.sessionId }
			: {}),
		...(typeof doc.sourceRef === "string" ? { sourceRef: doc.sourceRef } : {}),
	}

	const scoreDetails = normalizeScoreDetails(doc.scoreDetails, {
		docId: citation.eventId,
		warnings,
	})

	return {
		citation,
		matchType,
		...(typeof doc.score === "number" ? { score: doc.score } : {}),
		...(scoreDetails ? { scoreDetails } : {}),
	}
}

async function standardRecall(params: {
	collection: Collection
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
	queryText?: string
	asOf: Date
	scoreDetailsWarnings?: ScoreDetailsWarningState
}): Promise<ConversationRecallResult[]> {
	const filter = buildStandardFilter({
		request: params.request,
		startDate: params.startDate,
		endDate: params.endDate,
		queryText: params.queryText,
		asOf: params.asOf,
	})
	const docs = await params.collection
		.find(filter)
		.sort({ timestamp: -1, _id: -1 })
		.limit(params.effectiveLimit)
		.toArray()

	return docs.map((doc) =>
		eventToRecallResult(doc, "filter", params.scoreDetailsWarnings),
	)
}

function buildEventProjection(
	scoreMeta: "vectorSearchScore" | "searchScore",
	options?: { includeScoreDetails?: boolean },
): Document {
	const base: Document = {
		_id: 0,
		eventId: 1,
		sessionId: 1,
		role: 1,
		body: 1,
		timestamp: 1,
		sourceRef: 1,
		score: { $meta: scoreMeta },
	}
	if (options?.includeScoreDetails) {
		base.scoreDetails = 1
	}
	return base
}

async function semanticRecall(params: {
	collection: Collection
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
	vectorIndexName: string
	asOf: Date
	scoreDetailsWarnings?: ScoreDetailsWarningState
}): Promise<ConversationRecallResult[]> {
	const queryText = params.request.query?.trim()
	if (!queryText) {
		return []
	}

	const stage = buildVectorSearchStage({
		queryVector: null,
		queryText,
		embeddingMode: "automated",
		indexName: params.vectorIndexName,
		// Task 2.R2 Sub-path A: use approved numCandidates table
		// (5→200, 10→200, 20→400, 30→600; 20× otherwise with 200 floor).
		numCandidates: resolveNumCandidates(params.effectiveLimit),
		limit: params.effectiveLimit,
		filter: buildVectorFilter({
			request: params.request,
			startDate: params.startDate,
			endDate: params.endDate,
		}),
		textFieldPath: "body",
	})
	if (!stage) {
		return []
	}

	// Bi-temporal recall safety: the bi-temporal clause rides on a post-stage
	// `$match`. `$vectorSearch.filter` supports a narrow subset of MQL
	// ($eq / $and / $in) and range operators on dates are not documented,
	// so we enforce validity outside the vector stage. The vector stage
	// over-fetches `limit + buffer` candidates and the $match trims those
	// invalidated at `asOf`.
	const pipeline: Document[] = [
		{ $vectorSearch: stage },
		{ $match: buildBitemporalFilter(params.asOf) },
		{ $limit: params.effectiveLimit },
		{ $project: buildEventProjection("vectorSearchScore") },
	]
	const docs = await runSearchAggregateWithRetry(params.collection, pipeline)
	return docs.map((doc) =>
		eventToRecallResult(doc, "semantic", params.scoreDetailsWarnings),
	)
}

async function hybridRecall(params: {
	collection: Collection
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
	vectorIndexName: string
	textIndexName: string
	asOf: Date
	scoreDetailsWarnings?: ScoreDetailsWarningState
	/** Task 35 root fix: when set, inject Atlas Search `near` on
	 *  `timestamp` into the text-lane `compound.should` so in-window
	 *  events are boosted relative to out-of-window events. Leaves
	 *  $rankFusion default 0.5/0.5 weights untouched — the boost is
	 *  entirely inside the text lane's own relevance score.
	 *  Cited: https://www.mongodb.com/docs/atlas/atlas-search/near/
	 */
	temporalWindow?: TemporalWindow | null
}): Promise<ConversationRecallResult[]> {
	const queryText = params.request.query?.trim()
	if (!queryText) {
		return []
	}

	const vectorFilter = buildVectorFilter({
		request: params.request,
		startDate: params.startDate,
		endDate: params.endDate,
	})
	const vectorStage = buildVectorSearchStage({
		queryVector: null,
		queryText,
		embeddingMode: "automated",
		indexName: params.vectorIndexName,
		// Task 2.R2 Sub-path A: use approved numCandidates table
		// (5→200, 10→200, 20→400, 30→600; 20× otherwise with 200 floor).
		numCandidates: resolveNumCandidates(params.effectiveLimit),
		limit: params.effectiveLimit,
		filter: vectorFilter,
		textFieldPath: "body",
	})
	if (!vectorStage) {
		return []
	}

	// Bi-temporal recall safety: the bi-temporal predicate is applied as a
	// post-stage `$match` inside EACH inner `$rankFusion` pipeline so
	// invalidated-at-asOf documents cannot reach the fusion stage.
	// `$search.compound.filter` could use native `range` operators on
	// dates, but a post-$match keeps the predicate expressed once (via
	// buildBitemporalFilter) and avoids drift between the two paths.
	const bitemporalFilter = buildBitemporalFilter(params.asOf)

	const { compoundFilter, postMatch } = splitAtlasSearchFilter(vectorFilter)

	// Task 35 root fix: when the query carries a temporal token, add an
	// Atlas Search `near` clause on `timestamp` into the text-lane
	// `compound.should`. `pivot` is scaleDays converted to milliseconds;
	// a document at `origin` scores 1 from this clause, a document
	// `scaleDays` away scores 0.5, and distant documents asymptote to
	// 0. This is additive within the text lane (does NOT cross into
	// vector lane, does NOT change $rankFusion weights). Out-of-window
	// docs still appear if they match `must` (soft boost, not filter).
	//
	// Cited canonical MongoDB docs (MCP substitution disclosed):
	//   https://www.mongodb.com/docs/atlas/atlas-search/near/
	//   https://www.mongodb.com/docs/atlas/atlas-search/compound/
	//   https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/
	const temporalWindow = params.temporalWindow ?? null
	const nearShould =
		temporalWindow !== null
			? [
					{
						near: {
							path: "timestamp",
							origin: temporalWindow.origin,
							pivot: temporalWindow.scaleDays * 86_400_000,
						},
					},
				]
			: []

	const pipeline: Document[] = [
		{
			$rankFusion: {
				input: {
					pipelines: {
						vector: [
							{ $vectorSearch: vectorStage },
							{ $match: bitemporalFilter },
						],
						text: [
							{
								$search: {
									index: params.textIndexName,
									compound: {
										must: [{ text: { query: queryText, path: "body" } }],
										...(compoundFilter ? { filter: compoundFilter } : {}),
										...(nearShould.length > 0 ? { should: nearShould } : {}),
									},
								},
							},
							...(postMatch ? [{ $match: postMatch }] : []),
							{ $match: bitemporalFilter },
							{ $limit: params.effectiveLimit * 4 },
						],
					},
				},
				// Task 2.R1: request per-pipeline rank-fusion breakdown so we can
				// audit sum(weight * (1 / (60 + rank))) contributions in the
				// benchmark artifact writer. Cites MongoDB MCP Finding #1:
				// mongodb.com/docs/atlas/atlas-search/tutorial/hybrid-search.
				scoreDetails: true,
			},
		},
		{ $limit: params.effectiveLimit },
		{ $addFields: { scoreDetails: { $meta: "scoreDetails" } } },
		{
			$project: buildEventProjection("searchScore", {
				includeScoreDetails: true,
			}),
		},
	]
	const docs = await runSearchAggregateWithRetry(params.collection, pipeline)
	return docs.map((doc) =>
		eventToRecallResult(doc, "hybrid", params.scoreDetailsWarnings),
	)
}

export async function recallConversation(params: {
	db: Db
	prefix: string
	request: ConversationRecallRequest
	vectorIndexName?: string
	textIndexName?: string
	capabilities?: DetectedCapabilities
}): Promise<ConversationRecallResponse> {
	const startedAt = Date.now()
	const effectiveLimit = clampLimit(params.request.limit)
	const asOf = params.request.asOf
		? assertValidDate(params.request.asOf, "asOf")
		: new Date()
	const resolvedTimeZone = normalizeTimeZone(params.request.timezone)
	const queryText = params.request.query?.trim()
	const startDate = params.request.startTime
		? resolveTimeBoundary(params.request.startTime, "start", resolvedTimeZone)
		: undefined
	let endDate = params.request.endTime
		? resolveTimeBoundary(params.request.endTime, "end", resolvedTimeZone)
		: asOf
	if (endDate.getTime() > asOf.getTime()) {
		endDate = asOf
	}

	const filtersApplied: string[] = []
	if (params.request.sessionId) {
		filtersApplied.push(`sessionId:${params.request.sessionId}`)
	}
	if (params.request.roles?.length) {
		filtersApplied.push(`roles:${params.request.roles.join(",")}`)
	}
	if (startDate) {
		filtersApplied.push(`startTime:${startDate.toISOString()}`)
	}
	if (endDate) {
		filtersApplied.push(`endTime:${endDate.toISOString()}`)
	}
	if (!params.request.includeToolMessages && !params.request.roles?.length) {
		filtersApplied.push("excludeToolMessages")
	}

	if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
		return {
			results: [],
			metadata: {
				totalMatched: 0,
				...(queryText ? { queryUsed: queryText } : {}),
				filtersApplied,
				searchMethod: "standard",
				durationMs: Date.now() - startedAt,
			},
		}
	}

	const collection = eventsCollection(params.db, params.prefix)
	const capabilities = params.capabilities ?? {
		vectorSearch: false,
		textSearch: false,
		rankFusion: false,
		scoreFusion: false,
	}

	let results: ConversationRecallResult[] = []
	let searchMethod: ConversationRecallResponse["metadata"]["searchMethod"] =
		"standard"

	// Malformed scoreDetails handling: accumulate malformed-scoreDetails warnings
	// across all inner recall paths so we emit a single log.warn per
	// `recallConversation` call (not per doc). Absent scoreDetails still
	// returns `undefined` silently.
	const scoreDetailsWarnings: ScoreDetailsWarningState = { warned: false }

	// Task 35 root fix: run the temporal-window extractor once at the
	// recall boundary and pass the result down to the hybrid pipeline
	// builder. null here means no temporal token was found, in which
	// case the text lane runs unchanged. `asOf` is passed so the
	// extractor resolves 'today'/'yesterday'/'this month' relative to
	// the caller-stamped clock (benchmarks fix asOf for determinism).
	const temporalWindow = queryText
		? extractTemporalWindow(queryText, asOf)
		: null

	if (!queryText) {
		results = await standardRecall({
			collection,
			request: params.request,
			effectiveLimit,
			startDate,
			endDate,
			asOf,
			scoreDetailsWarnings,
		})
	} else if (
		capabilities.vectorSearch &&
		capabilities.textSearch &&
		capabilities.rankFusion
	) {
		try {
			results = await hybridRecall({
				collection,
				request: params.request,
				effectiveLimit,
				startDate,
				endDate,
				vectorIndexName:
					params.vectorIndexName ?? `${params.prefix}events_vector`,
				textIndexName: params.textIndexName ?? `${params.prefix}events_text`,
				asOf,
				scoreDetailsWarnings,
				temporalWindow,
			})
			searchMethod = "hybrid"
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log.warn(`hybrid conversation recall failed, falling back: ${message}`)
			results = []
		}
	}

	if (queryText && results.length === 0 && capabilities.vectorSearch) {
		try {
			results = await semanticRecall({
				collection,
				request: params.request,
				effectiveLimit,
				startDate,
				endDate,
				vectorIndexName:
					params.vectorIndexName ?? `${params.prefix}events_vector`,
				asOf,
				scoreDetailsWarnings,
			})
			searchMethod = "semantic"
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log.warn(`semantic conversation recall failed, falling back: ${message}`)
			results = []
		}
	}

	if (queryText && results.length === 0) {
		results = await standardRecall({
			collection,
			request: params.request,
			effectiveLimit,
			startDate,
			endDate,
			queryText,
			asOf,
			scoreDetailsWarnings,
		})
		searchMethod = "standard"
	}

	if (scoreDetailsWarnings.warned && scoreDetailsWarnings.sample) {
		log.warn(
			`rankFusion scoreDetails missing expected shape: docId=${scoreDetailsWarnings.sample.docId} raw=${scoreDetailsWarnings.sample.raw}`,
		)
	}

	return {
		results,
		metadata: {
			totalMatched: results.length,
			...(queryText ? { queryUsed: queryText } : {}),
			filtersApplied,
			searchMethod,
			durationMs: Date.now() - startedAt,
		},
	}
}
