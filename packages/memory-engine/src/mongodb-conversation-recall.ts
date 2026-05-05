import type { Collection, Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { type CanonicalEvent, renderEventChunkText } from "./mongodb-events.js"
import {
	buildVectorSearchStage,
	runSearchAggregateWithRetry,
	splitAtlasSearchFilter,
} from "./mongodb-search.js"
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

function eventToRecallResult(
	doc: Document,
	matchType: ConversationRecallResult["matchType"],
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

	return {
		citation,
		matchType,
		...(typeof doc.score === "number" ? { score: doc.score } : {}),
	}
}

async function standardRecall(params: {
	collection: Collection
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
	queryText?: string
}): Promise<ConversationRecallResult[]> {
	const filter = buildStandardFilter({
		request: params.request,
		startDate: params.startDate,
		endDate: params.endDate,
		queryText: params.queryText,
	})
	const docs = await params.collection
		.find(filter)
		.sort({ timestamp: -1, _id: -1 })
		.limit(params.effectiveLimit)
		.toArray()

	return docs.map((doc) => eventToRecallResult(doc, "filter"))
}

function buildEventProjection(
	scoreMeta: "vectorSearchScore" | "searchScore",
): Document {
	return {
		_id: 0,
		eventId: 1,
		sessionId: 1,
		role: 1,
		body: 1,
		timestamp: 1,
		sourceRef: 1,
		score: { $meta: scoreMeta },
	}
}

async function semanticRecall(params: {
	collection: Collection
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
	vectorIndexName: string
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
		numCandidates: Math.min(Math.max(params.effectiveLimit * 4, 100), 400),
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

	const pipeline: Document[] = [
		{ $vectorSearch: stage },
		{ $limit: params.effectiveLimit },
		{ $project: buildEventProjection("vectorSearchScore") },
	]
	const docs = await runSearchAggregateWithRetry(params.collection, pipeline)
	return docs.map((doc) => eventToRecallResult(doc, "semantic"))
}

async function hybridRecall(params: {
	collection: Collection
	request: ConversationRecallRequest
	effectiveLimit: number
	startDate?: Date
	endDate?: Date
	vectorIndexName: string
	textIndexName: string
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
		numCandidates: Math.min(Math.max(params.effectiveLimit * 4, 100), 400),
		limit: params.effectiveLimit,
		filter: vectorFilter,
		textFieldPath: "body",
	})
	if (!vectorStage) {
		return []
	}

	const { compoundFilter, postMatch } = splitAtlasSearchFilter(vectorFilter)
	const pipeline: Document[] = [
		{
			$rankFusion: {
				input: {
					pipelines: {
						vector: [{ $vectorSearch: vectorStage }],
						text: [
							{
								$search: {
									index: params.textIndexName,
									compound: {
										must: [{ text: { query: queryText, path: "body" } }],
										...(compoundFilter ? { filter: compoundFilter } : {}),
									},
								},
							},
							...(postMatch ? [{ $match: postMatch }] : []),
							{ $limit: params.effectiveLimit * 4 },
						],
					},
				},
			},
		},
		{ $limit: params.effectiveLimit },
		{ $project: buildEventProjection("searchScore") },
	]
	const docs = await runSearchAggregateWithRetry(params.collection, pipeline)
	return docs.map((doc) => eventToRecallResult(doc, "hybrid"))
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

	if (!queryText) {
		results = await standardRecall({
			collection,
			request: params.request,
			effectiveLimit,
			startDate,
			endDate,
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
		})
		searchMethod = "standard"
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
