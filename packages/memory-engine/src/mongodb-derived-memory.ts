import { createHash } from "node:crypto"
import type { Db, MongoClient } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import { recordProjectionRun } from "./mongodb-ops.js"
import { isDerivableFromContext } from "./mongodb-consolidator.js"
import { type ProcedureEntry, writeProcedure } from "./mongodb-procedures.js"
import {
	eventsCollection,
	proceduresCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import {
	type StructuredMemoryEntry,
	writeStructuredMemory,
} from "./mongodb-structured-memory.js"

const log = createSubsystemLogger("memory:mongodb:derived")

async function recordProjectionRunBestEffort(params: {
	db: Db
	prefix: string
	run: {
		agentId: string
		projectionType: "structured-promotion" | "procedures"
		status: "ok" | "failed"
		itemsProjected: number
		durationMs: number
	}
	context: string
}): Promise<void> {
	try {
		await recordProjectionRun({
			db: params.db,
			prefix: params.prefix,
			run: params.run,
		})
	} catch (err) {
		log.warn(
			`${params.context} projection run recording failed: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"for",
	"from",
	"has",
	"have",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"of",
	"on",
	"or",
	"that",
	"the",
	"their",
	"there",
	"this",
	"to",
	"we",
	"with",
	"you",
	"your",
])

const CRITICAL_CONTEXT_TERMS = [
	"war",
	"crisis",
	"emergency",
	"evacuation",
	"attack",
	"shelter",
	"danger",
	"outage",
	"incident",
	"blocker",
]

type ConversationEvent = {
	eventId: string
	agentId: string
	role: "user" | "assistant" | "system" | "tool"
	body: string
	timestamp: Date
	sessionId?: string
	scope: MemoryScope
	scopeRef: string
	workspaceDir?: string
}

export type StructuredPromotionPolicy = "immediate" | "requires-reinforcement"

export type DerivedStructuredCandidate = StructuredMemoryEntry & {
	promotionPolicy: StructuredPromotionPolicy
	promotionReason: string
}

function shortHash(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 12)
}

function normalizeWhitespace(input: string): string {
	return input.replace(/\s+/g, " ").trim()
}

function pickTopTerms(input: string, maxTerms = 4): string[] {
	const counts = new Map<string, number>()
	for (const token of input.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ??
		[]) {
		if (STOPWORDS.has(token)) {
			continue
		}
		counts.set(token, (counts.get(token) ?? 0) + 1)
	}
	return [...counts.entries()]
		.toSorted(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		)
		.slice(0, maxTerms)
		.map(([term]) => term)
}

function extractRelevantSentence(body: string, matcher: RegExp): string | null {
	const sentences = body
		.split(/(?<=[.!?])\s+/)
		.map((part) => normalizeWhitespace(part))
		.filter(Boolean)
	for (const sentence of sentences) {
		if (matcher.test(sentence)) {
			return sentence
		}
	}
	return normalizeWhitespace(body) || null
}

function buildStructuredProvenance(
	event: ConversationEvent,
): Record<string, unknown> {
	return {
		origin:
			event.role === "user"
				? "user_event"
				: event.role === "assistant"
					? "assistant_event"
					: "ingestion",
		sessionId: event.sessionId,
		extractorVersion: "structured-promoter-v1",
		writtenAt: event.timestamp.toISOString(),
	}
}

function buildProcedureProvenance(
	event: ConversationEvent,
): Record<string, unknown> {
	return {
		origin: event.role === "assistant" ? "assistant_event" : "agent_tool",
		sessionId: event.sessionId,
		extractorVersion: "procedure-promoter-v1",
		writtenAt: event.timestamp.toISOString(),
	}
}

function buildEpisodeTitleTerms(
	events: Array<{ role: string; body: string; timestamp: Date }>,
): string[] {
	return pickTopTerms(events.map((event) => event.body).join(" "), 3)
}

export async function heuristicEpisodeSummarizer(
	events: Array<{ role: string; body: string; timestamp: Date }>,
): Promise<{ title: string; summary: string; tags?: string[] }> {
	const terms = buildEpisodeTitleTerms(events)
	const title =
		terms.length > 0 ? `Thread: ${terms.join(", ")}` : "Thread: conversation"
	const first = normalizeWhitespace(events[0]?.body ?? "")
	const last = normalizeWhitespace(events[events.length - 1]?.body ?? "")
	const summary = [
		`${events.length} messages captured in this conversation thread.`,
		first ? `Started with: ${first.slice(0, 160)}` : null,
		last && last !== first ? `Ended with: ${last.slice(0, 160)}` : null,
	]
		.filter(Boolean)
		.join(" ")
	return { title, summary, ...(terms.length > 0 ? { tags: terms } : {}) }
}

export function extractStructuredCandidatesFromEvent(
	event: ConversationEvent,
): DerivedStructuredCandidate[] {
	const body = normalizeWhitespace(event.body)
	if (!body) {
		return []
	}

	const candidates = new Map<string, DerivedStructuredCandidate>()
	const addCandidate = (entry: DerivedStructuredCandidate) => {
		candidates.set(`${entry.type}:${entry.key}`, entry)
	}
	const base = {
		agentId: event.agentId,
		scope: event.scope,
		scopeRef: event.scopeRef,
		workspaceDir: event.workspaceDir,
		sessionId: event.sessionId,
		sourceEventIds: [event.eventId],
		provenance: buildStructuredProvenance(event),
		confidence: 0.7, // agent_extracted
		sourceAgent: {
			id: event.agentId,
			name: "extractor" as const,
			runId: event.eventId,
		},
	} satisfies Partial<StructuredMemoryEntry>

	const rememberMatch = body.match(
		/\b(?:remember|note|keep in mind|important(?:ly)?)\b[:\s-]*(.+)$/i,
	)
	if (rememberMatch?.[1]) {
		const value = normalizeWhitespace(rememberMatch[1])
		if (value) {
			addCandidate({
				...base,
				type: "fact",
				key: `fact-${shortHash(value.toLowerCase())}`,
				value,
				context:
					"Promoted from an explicit remember/note instruction in a canonical event.",
				confidence: 0.94,
				source: event.role === "user" ? "user" : "session",
				tags: pickTopTerms(value, 4),
				promotionPolicy: "immediate",
				promotionReason: "explicit-remember-instruction",
			})
		}
	}

	const preferenceMatch = body.match(
		/\b(?:i|we)\s+(?:prefer|prefers|like|likes|love|loves|dislike|dislikes|hate|hates)\s+(.+)$/i,
	)
	if (preferenceMatch?.[1]) {
		const value = normalizeWhitespace(preferenceMatch[1])
		if (value) {
			addCandidate({
				...base,
				type: "preference",
				key: `preference-${shortHash(value.toLowerCase())}`,
				value,
				context:
					"Promoted from an explicit preference statement in a canonical event.",
				confidence: 0.9,
				source: event.role === "user" ? "user" : "session",
				tags: ["preference", ...pickTopTerms(value, 3)],
				promotionPolicy: "requires-reinforcement",
				promotionReason: "implicit-preference-statement",
			})
		}
	}

	const projectMatch = body.match(
		/\b(?:i am building|i'm building|we are building|we're building|project(?: is| called)?|repo is at)\b[:\s-]*(.+)$/i,
	)
	if (projectMatch?.[1]) {
		const value = normalizeWhitespace(projectMatch[1])
		if (value) {
			addCandidate({
				...base,
				type: "project",
				key: `project-${shortHash(value.toLowerCase())}`,
				value,
				context: "Promoted from a project-identifying canonical event.",
				confidence: 0.88,
				source: event.role === "user" ? "user" : "session",
				tags: ["project", ...pickTopTerms(value, 3)],
				promotionPolicy: "requires-reinforcement",
				promotionReason: "implicit-project-statement",
			})
		}
	}

	const decisionMatch = body.match(
		/\b(?:we decided|decision(?:s)?(?: so far)?|key decision(?:s)? so far)\b[:\s-]*(.+)$/i,
	)
	if (decisionMatch?.[1]) {
		const value = normalizeWhitespace(decisionMatch[1])
		if (value) {
			addCandidate({
				...base,
				type: "decision",
				key: `decision-${shortHash(value.toLowerCase())}`,
				value,
				context: "Promoted from a decision-oriented canonical event.",
				confidence: 0.86,
				source: event.role === "assistant" ? "agent" : "session",
				tags: ["decision", ...pickTopTerms(value, 3)],
				promotionPolicy: "requires-reinforcement",
				promotionReason: "decision-statement",
			})
		}
	}

	const criticalMatcher = new RegExp(
		`\\b(?:${CRITICAL_CONTEXT_TERMS.join("|")})\\b`,
		"i",
	)
	if (
		criticalMatcher.test(body) &&
		!(event.role === "assistant" && isProcedureStyleBody(event.body))
	) {
		const sentence = extractRelevantSentence(body, criticalMatcher)
		if (sentence) {
			addCandidate({
				...base,
				type: "fact",
				key: `active-context-${shortHash(sentence.toLowerCase())}`,
				value: sentence,
				context: "Promoted from an active critical-context canonical event.",
				confidence: 0.97,
				source: event.role === "user" ? "user" : "session",
				salience: "critical",
				temporalScope: "ongoing",
				tags: ["active-context", ...pickTopTerms(sentence, 4)],
				promotionPolicy: "immediate",
				promotionReason: "active-critical-context",
			})
		}
	}

	return [...candidates.values()]
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripPromotionMetadata(
	candidate: DerivedStructuredCandidate,
): StructuredMemoryEntry {
	const { promotionPolicy, promotionReason, ...entry } = candidate
	return entry
}

async function findSupportingEventIds(params: {
	db: Db
	prefix: string
	event: ConversationEvent
	candidate: DerivedStructuredCandidate
}): Promise<string[]> {
	const { db, prefix, event, candidate } = params
	if (!candidate.value.trim()) {
		return []
	}

	const docs = await eventsCollection(db, prefix)
		.find({
			agentId: event.agentId,
			scope: event.scope,
			scopeRef: event.scopeRef,
			eventId: { $ne: event.eventId },
			body: {
				$regex: new RegExp(escapeRegex(candidate.value.trim()), "i"),
			},
		})
		.sort({ timestamp: -1, _id: -1 })
		.limit(3)
		.toArray()

	return docs
		.map((doc) => String(doc.eventId ?? ""))
		.filter((eventId) => eventId.length > 0)
}

export async function resolveStructuredCandidatesForPromotion(params: {
	db: Db
	prefix: string
	event: ConversationEvent
}): Promise<StructuredMemoryEntry[]> {
	const { db, prefix, event } = params
	const candidates = extractStructuredCandidatesFromEvent(event)
	if (candidates.length === 0) {
		return []
	}

	const structured = structuredMemCollection(db, prefix)
	const promotable: StructuredMemoryEntry[] = []

	for (const candidate of candidates) {
		if (candidate.promotionPolicy === "immediate") {
			promotable.push(stripPromotionMetadata(candidate))
			continue
		}

		const identityFilter = {
			agentId: candidate.agentId,
			scope: candidate.scope ?? event.scope,
			scopeRef: candidate.scopeRef ?? event.scopeRef,
			type: candidate.type,
			key: candidate.key,
		}
		const existing = await structured.findOne(identityFilter)
		if (existing) {
			promotable.push(
				stripPromotionMetadata({
					...candidate,
					provenance: {
						...(candidate.provenance ?? {}),
						promotionTrigger: "existing-durable-memory",
					},
				}),
			)
			continue
		}

		const supportingEventIds = await findSupportingEventIds({
			db,
			prefix,
			event,
			candidate,
		})
		if (supportingEventIds.length === 0) {
			continue
		}

		promotable.push(
			stripPromotionMetadata({
				...candidate,
				sourceEventIds: [
					...new Set([
						...(candidate.sourceEventIds ?? []),
						...supportingEventIds,
					]),
				].toSorted(),
				reinforcementCount: supportingEventIds.length + 1,
				provenance: {
					...(candidate.provenance ?? {}),
					promotionTrigger: "repeated-evidence",
					supportingEventCount: supportingEventIds.length,
					supportingEventIds,
				},
			}),
		)
	}

	return promotable
}

function extractStepsFromProcedureBody(body: string): string[] {
	const numbered = [
		...body.matchAll(
			/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+(.+?)(?=(?:\n\s*(?:\d+[.)]|[-*])\s+)|$)/g,
		),
	]
		.map((match) => normalizeWhitespace(match[1] ?? ""))
		.filter(Boolean)
	if (numbered.length >= 2) {
		return numbered
	}

	const inlineNumbered = [
		...body.matchAll(
			/(?:^|:\s*|\s+)(?:\d+[.)])\s+(.+?)(?=(?:\s+\d+[.)]\s+)|$)/g,
		),
	]
		.map((match) => normalizeWhitespace(match[1] ?? ""))
		.filter(Boolean)
	if (inlineNumbered.length >= 2) {
		return inlineNumbered
	}

	const colonIndex = body.indexOf(":")
	if (colonIndex === -1) {
		return []
	}
	const tail = body.slice(colonIndex + 1)
	const inline = tail
		.split(/(?:->|>| then )/i)
		.map((part) => normalizeWhitespace(part))
		.filter(Boolean)
	return inline.length >= 2 ? inline.slice(0, 6) : []
}

function isProcedureStyleBody(body: string): boolean {
	if (extractStepsFromProcedureBody(body).length < 2) {
		return false
	}
	return /\b(?:for|when handling|workflow for|process for)\s+([^:\n]{6,120}):/i.test(
		body,
	)
}

export function extractProcedureCandidatesFromEvent(
	event: ConversationEvent,
): ProcedureEntry[] {
	if (event.role !== "assistant") {
		return []
	}

	const body = normalizeWhitespace(event.body)
	if (!body) {
		return []
	}

	const introMatch =
		event.body.match(
			/\b(?:for|when handling|workflow for|process for)\s+([^:\n]{6,120}):/i,
		) ?? event.body.match(/^([^:\n]{6,120}):/i)
	const steps = extractStepsFromProcedureBody(event.body)
	if (!introMatch?.[1] || steps.length < 2) {
		return []
	}

	const intent = normalizeWhitespace(introMatch[1])
	if (!intent) {
		return []
	}

	return [
		{
			procedureId: `procedure-${shortHash(intent.toLowerCase())}`,
			name: intent,
			intentTags: pickTopTerms(intent, 4),
			triggerQueries: [intent],
			steps,
			confidence: 0.76,
			state: "active",
			provenance: buildProcedureProvenance(event),
			sourceEventIds: [event.eventId],
			agentId: event.agentId,
			scope: event.scope,
			scopeRef: event.scopeRef,
			workspaceDir: event.workspaceDir,
			sessionId: event.sessionId,
			sourceAgent: {
				id: event.agentId,
				name: "extractor",
				runId: event.eventId,
			},
		},
	]
}

export async function promoteDerivedMemoryFromEvent(params: {
	db: Db
	prefix: string
	client?: MongoClient
	embeddingMode: MemoryMongoDBEmbeddingMode
	event: ConversationEvent
}): Promise<{
	structuredCreated: number
	proceduresCreated: number
	skipped: boolean
	skipReason?: string
}> {
	const { db, prefix, client, embeddingMode, event } = params

	let structuredCreated = 0
	let proceduresCreated = 0
	const [existingStructured, existingProcedure] = await Promise.all([
		structuredMemCollection(db, prefix).findOne({
			agentId: event.agentId,
			sourceEventIds: event.eventId,
		}),
		proceduresCollection(db, prefix).findOne({
			agentId: event.agentId,
			sourceEventIds: event.eventId,
		}),
	])
	if (existingStructured && existingProcedure) {
		return {
			structuredCreated,
			proceduresCreated,
			skipped: true,
			skipReason: "already-promoted",
		}
	}

	if (!existingStructured) {
		try {
			const promotable = (
				await resolveStructuredCandidatesForPromotion({
					db,
					prefix,
					event,
				})
			).filter((candidate) => !isDerivableFromContext(candidate.value))
			for (const candidate of promotable) {
				const result = await writeStructuredMemory({
					db,
					prefix,
					entry: candidate,
					embeddingMode,
					client,
				})
				if (result.upserted) {
					structuredCreated += 1
				}
			}
			if (structuredCreated > 0) {
				await recordProjectionRunBestEffort({
					db,
					prefix,
					run: {
						agentId: event.agentId,
						projectionType: "structured-promotion",
						status: "ok",
						itemsProjected: structuredCreated,
						durationMs: 0,
					},
					context: "structured promotion",
				})
			}
		} catch (err) {
			await recordProjectionRunBestEffort({
				db,
				prefix,
				run: {
					agentId: event.agentId,
					projectionType: "structured-promotion",
					status: "failed",
					itemsProjected: structuredCreated,
					durationMs: 0,
				},
				context: "structured promotion",
			})
			log.warn(
				`structured promotion failed for ${event.eventId}: ${String(err)}`,
			)
		}
	}

	if (!existingProcedure) {
		try {
			for (const candidate of extractProcedureCandidatesFromEvent(event)) {
				const result = await writeProcedure({
					db,
					prefix,
					entry: candidate,
					embeddingMode,
					client,
				})
				if (result.upserted) {
					proceduresCreated += 1
				}
			}
			if (proceduresCreated > 0) {
				await recordProjectionRunBestEffort({
					db,
					prefix,
					run: {
						agentId: event.agentId,
						projectionType: "procedures",
						status: "ok",
						itemsProjected: proceduresCreated,
						durationMs: 0,
					},
					context: "procedure promotion",
				})
			}
		} catch (err) {
			await recordProjectionRunBestEffort({
				db,
				prefix,
				run: {
					agentId: event.agentId,
					projectionType: "procedures",
					status: "failed",
					itemsProjected: proceduresCreated,
					durationMs: 0,
				},
				context: "procedure promotion",
			})
			log.warn(
				`procedure promotion failed for ${event.eventId}: ${String(err)}`,
			)
		}
	}

	return { structuredCreated, proceduresCreated, skipped: false }
}
