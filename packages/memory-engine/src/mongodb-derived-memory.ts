import { createHash } from "node:crypto"
import type { ClientSession, Db, MongoClient } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import { recordProjectionRun } from "./mongodb-ops.js"
import { isDerivableFromContext } from "./mongodb-consolidator.js"
import {
	type EnrichmentProvider,
	extractSessionEnrichment,
} from "./mongodb-llm-enrichment.js"
import { type ProcedureEntry, writeProcedure } from "./mongodb-procedures.js"
import {
	eventsCollection,
	proceduresCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { invalidateContradictedFacts } from "./mongodb-contradiction.js"
import {
	buildCurrentValidityClause,
	buildEventLifecycleClause,
	buildUnexpiredClause,
	mergeQueryClauses,
} from "./mongodb-temporal.js"
import { refineCandidatesValidTime } from "./mongodb-temporal-extraction.js"
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

/**
 * `type` labels the lens the episode is being written under. Two episodes over
 * the same events but under different lenses must not read identically —
 * otherwise both surface in one search as apparent duplicates. Defaults to
 * "thread" so callers that omit it keep the previous wording.
 */
export async function heuristicEpisodeSummarizer(
	events: Array<{ role: string; body: string; timestamp: Date }>,
	type = "thread",
): Promise<{ title: string; summary: string; tags?: string[] }> {
	const terms = buildEpisodeTitleTerms(events)
	const lens = type.charAt(0).toUpperCase() + type.slice(1)
	const title =
		terms.length > 0 ? `${lens}: ${terms.join(", ")}` : `${lens}: conversation`
	const first = normalizeWhitespace(events[0]?.body ?? "")
	const last = normalizeWhitespace(events[events.length - 1]?.body ?? "")
	const summary = [
		`${events.length} messages captured in this ${type} episode.`,
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
		// Valid-time baseline (#32): the assertion is valid as of the event, not
		// the write clock. LLM refinement may later upgrade this to an extracted
		// date; until then validTimeSource is "event".
		validFrom: event.timestamp,
		provenance: {
			...buildStructuredProvenance(event),
			validTimeSource: "event",
		},
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
			...buildEventLifecycleClause(),
		})
		.sort({ timestamp: -1, _id: -1 })
		.limit(3)
		.toArray()

	return docs
		.map((doc) => String(doc.eventId ?? ""))
		.filter((eventId) => eventId.length > 0)
}

/**
 * Combine deterministic regex candidates with LLM-extracted candidates (issue
 * #30). Regex candidates are trusted on identity collisions. Degrades to
 * regex-only when no provider is configured or the LLM call fails, so the write
 * path never breaks on a missing key or an upstream outage.
 */
async function mergeStructuredCandidates(
	event: ConversationEvent,
	provider?: EnrichmentProvider | null,
	temporalProvider?: EnrichmentProvider | null,
	model?: string,
	prefetchedLlmFacts?: string[],
): Promise<DerivedStructuredCandidate[]> {
	const regexCandidates = extractStructuredCandidatesFromEvent(event)
	if (!provider && prefetchedLlmFacts === undefined) {
		return regexCandidates
	}

	let llmCandidates: DerivedStructuredCandidate[] = []
	if (prefetchedLlmFacts !== undefined) {
		// P3.9: session-batched extraction — the worker already made the LLM
		// call for this event's session; build candidates from the shared
		// facts instead of a per-event provider call.
		llmCandidates = buildLlmStructuredCandidatesFromFacts(
			event,
			prefetchedLlmFacts,
		)
	} else if (provider) {
		try {
			llmCandidates = await extractLlmStructuredCandidates({
				event,
				provider,
				model: model ?? "",
			})
		} catch (err) {
			log.warn(
				`LLM structured extraction failed for ${event.eventId}, using regex only: ${String(err)}`,
			)
			return regexCandidates
		}
	}

	const merged = new Map<string, DerivedStructuredCandidate>()
	for (const candidate of [...regexCandidates, ...llmCandidates]) {
		const identity = `${candidate.type}::${candidate.key}`
		if (!merged.has(identity)) {
			merged.set(identity, candidate)
		}
	}

	// Refine each candidate's valid-time from its own text (#32). Anchored to the
	// event timestamp, which is also the explicit fallback. Never throws. When no
	// provider exists at all (prefetched facts only), candidates already carry
	// the event-timestamp baseline, so refinement is simply skipped.
	const refineProvider = temporalProvider ?? provider
	if (!refineProvider) {
		return [...merged.values()]
	}
	return refineCandidatesValidTime({
		candidates: [...merged.values()],
		provider: refineProvider,
		model: model ?? "",
		referenceTime: event.timestamp,
	})
}

export async function resolveStructuredCandidatesForPromotion(params: {
	db: Db
	prefix: string
	event: ConversationEvent
	provider?: EnrichmentProvider | null
	temporalProvider?: EnrichmentProvider | null
	model?: string
	/**
	 * P3.9: facts from a session-batched LLM extraction made by the worker.
	 * When provided, the per-event provider call is skipped entirely.
	 */
	prefetchedLlmFacts?: string[]
}): Promise<StructuredMemoryEntry[]> {
	const {
		db,
		prefix,
		event,
		provider,
		temporalProvider,
		model,
		prefetchedLlmFacts,
	} = params
	const candidates = await mergeStructuredCandidates(
		event,
		provider,
		temporalProvider,
		model,
		prefetchedLlmFacts,
	)
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
		// P4.4.1 (B1): an expired durable memory reads as gone, so it must not
		// satisfy the identity lookup ahead of the TTL sweep.
		const existing = await structured.findOne({
			...identityFilter,
			...buildUnexpiredClause(),
		})
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

export type PreparedDerivedMemoryPromotion = {
	structuredCandidates: StructuredMemoryEntry[]
	procedureCandidates: ProcedureEntry[]
	promotionGuards: Record<
		string,
		| { kind: "immediate" }
		| { kind: "existing"; revision: number; value: string }
		| {
				kind: "evidence"
				events: Array<{ eventId: string; body: string; timestamp: Date }>
		  }
	>
}

function structuredCandidateIdentity(candidate: StructuredMemoryEntry): string {
	return `${candidate.type}\0${candidate.key}`
}

/**
 * Resolve every provider/read-dependent promotion decision before entering a
 * retryable worker transaction. Persistence revalidates event receipts and
 * current document revisions inside the transaction.
 */
export async function prepareDerivedMemoryPromotion(params: {
	db: Db
	prefix: string
	event: ConversationEvent
	provider?: EnrichmentProvider | null
	temporalProvider?: EnrichmentProvider | null
	model?: string
	prefetchedLlmFacts?: string[]
}): Promise<PreparedDerivedMemoryPromotion> {
	const structuredCandidates = (
		await resolveStructuredCandidatesForPromotion(params)
	).filter((candidate) => !isDerivableFromContext(candidate.value))
	const promotionGuards: PreparedDerivedMemoryPromotion["promotionGuards"] = {}
	const currentClause = mergeQueryClauses(
		{ state: "active" },
		buildCurrentValidityClause(),
		buildUnexpiredClause(),
	)
	for (const candidate of structuredCandidates) {
		const identity = structuredCandidateIdentity(candidate)
		const trigger = candidate.provenance?.promotionTrigger
		if (trigger === "existing-durable-memory") {
			const existing = await structuredMemCollection(
				params.db,
				params.prefix,
			).findOne(
				{
					agentId: candidate.agentId,
					scope: candidate.scope ?? params.event.scope,
					scopeRef: candidate.scopeRef ?? params.event.scopeRef,
					type: candidate.type,
					key: candidate.key,
					...currentClause,
				},
				{ projection: { value: 1, revision: 1 } },
			)
			const revision = Number(existing?.revision)
			if (
				!existing ||
				!Number.isInteger(revision) ||
				revision < 1 ||
				typeof existing.value !== "string"
			) {
				continue
			}
			promotionGuards[identity] = {
				kind: "existing",
				revision,
				value: existing.value,
			}
			continue
		}
		if (trigger === "repeated-evidence") {
			const supportingIds = (candidate.sourceEventIds ?? []).filter(
				(eventId) => eventId !== params.event.eventId,
			)
			const docs = await eventsCollection(params.db, params.prefix)
				.find(
					{
						agentId: params.event.agentId,
						scope: params.event.scope,
						scopeRef: params.event.scopeRef,
						eventId: { $in: supportingIds },
						...buildEventLifecycleClause(),
					},
					{ projection: { eventId: 1, body: 1, timestamp: 1 } },
				)
				.toArray()
			if (docs.length !== supportingIds.length) {
				continue
			}
			promotionGuards[identity] = {
				kind: "evidence",
				events: docs.map((doc) => ({
					eventId: String(doc.eventId),
					body: String(doc.body ?? ""),
					timestamp:
						doc.timestamp instanceof Date ? doc.timestamp : new Date(0),
				})),
			}
			continue
		}
		promotionGuards[identity] = { kind: "immediate" }
	}
	return {
		structuredCandidates: structuredCandidates.filter(
			(candidate) =>
				promotionGuards[structuredCandidateIdentity(candidate)] !== undefined,
		),
		procedureCandidates: extractProcedureCandidatesFromEvent(params.event),
		promotionGuards,
	}
}

async function promotionGuardStillValid(params: {
	db: Db
	prefix: string
	session?: ClientSession
	event: ConversationEvent
	candidate: StructuredMemoryEntry
	guard: PreparedDerivedMemoryPromotion["promotionGuards"][string] | undefined
}): Promise<boolean> {
	if (!params.guard || params.guard.kind === "immediate") return !!params.guard
	if (params.guard.kind === "existing") {
		const currentClause = mergeQueryClauses(
			{ state: "active" },
			buildCurrentValidityClause(),
			buildUnexpiredClause(),
		)
		return Boolean(
			await structuredMemCollection(params.db, params.prefix).findOne(
				{
					agentId: params.candidate.agentId,
					scope: params.candidate.scope ?? params.event.scope,
					scopeRef: params.candidate.scopeRef ?? params.event.scopeRef,
					type: params.candidate.type,
					key: params.candidate.key,
					value: params.guard.value,
					revision: params.guard.revision,
					...currentClause,
				},
				params.session ? { session: params.session } : undefined,
			),
		)
	}
	for (const evidence of params.guard.events) {
		const found = await eventsCollection(params.db, params.prefix).findOne(
			{
				agentId: params.event.agentId,
				scope: params.event.scope,
				scopeRef: params.event.scopeRef,
				eventId: evidence.eventId,
				body: evidence.body,
				timestamp: evidence.timestamp,
				...buildEventLifecycleClause(),
			},
			params.session ? { session: params.session } : undefined,
		)
		if (!found) return false
	}
	return true
}

export async function persistPreparedDerivedMemoryPromotion(params: {
	db: Db
	prefix: string
	client?: MongoClient
	session?: ClientSession
	embeddingMode: MemoryMongoDBEmbeddingMode
	event: ConversationEvent
	prepared: PreparedDerivedMemoryPromotion
}): Promise<{
	structuredCreated: number
	proceduresCreated: number
	skipped: boolean
	skipReason?: string
}> {
	const { db, prefix, client, session, embeddingMode, event, prepared } = params
	let structuredCreated = 0
	let proceduresCreated = 0
	let existingCandidateCount = 0
	let firstError: unknown
	const structuredCollection = structuredMemCollection(db, prefix)
	const procedureCollection = proceduresCollection(db, prefix)

	let structuredFailed = false
	for (const candidate of prepared.structuredCandidates) {
		if (
			!(await promotionGuardStillValid({
				db,
				prefix,
				session,
				event,
				candidate,
				guard: prepared.promotionGuards[structuredCandidateIdentity(candidate)],
			}))
		) {
			continue
		}
		const receipt = await structuredCollection.findOne(
			{
				agentId: candidate.agentId,
				scope: candidate.scope,
				scopeRef: candidate.scopeRef,
				type: candidate.type,
				key: candidate.key,
				sourceEventIds: event.eventId,
			},
			{
				projection: { _id: 1 },
				...(session ? { session } : {}),
			},
		)
		if (receipt) {
			existingCandidateCount += 1
			continue
		}
		try {
			const result = await writeStructuredMemory({
				db,
				prefix,
				entry: candidate,
				embeddingMode,
				...(session ? { session, transactionalSideEffects: "inline" } : {}),
				...(!session && client ? { client } : {}),
				eventReceiptIds: [event.eventId],
			})
			if (result.upserted) {
				structuredCreated += 1
			}
		} catch (err) {
			if (session) throw err
			structuredFailed = true
			firstError ??= err
			log.warn(
				`structured candidate promotion failed for ${event.eventId} key=${candidate.key}: ${String(err)}`,
			)
		}
	}
	if (prepared.structuredCandidates.length > 0) {
		const run = {
			agentId: event.agentId,
			projectionType: "structured-promotion" as const,
			status: structuredFailed ? ("failed" as const) : ("ok" as const),
			itemsProjected: structuredCreated,
			durationMs: 0,
		}
		if (session) {
			await recordProjectionRun({ db, prefix, run, session })
		} else {
			await recordProjectionRunBestEffort({
				db,
				prefix,
				run,
				context: "structured promotion",
			})
		}
	}

	let procedureFailed = false
	for (const candidate of prepared.procedureCandidates) {
		const receipt = await procedureCollection.findOne(
			{
				agentId: candidate.agentId,
				scope: candidate.scope,
				scopeRef: candidate.scopeRef,
				procedureId: candidate.procedureId,
				sourceEventIds: event.eventId,
			},
			{
				projection: { _id: 1 },
				...(session ? { session } : {}),
			},
		)
		if (receipt) {
			existingCandidateCount += 1
			continue
		}
		try {
			const result = await writeProcedure({
				db,
				prefix,
				entry: candidate,
				embeddingMode,
				...(session ? { session, transactionalSideEffects: "inline" } : {}),
				...(!session && client ? { client } : {}),
				eventReceiptIds: [event.eventId],
			})
			if (result.upserted) {
				proceduresCreated += 1
			}
		} catch (err) {
			if (session) throw err
			procedureFailed = true
			firstError ??= err
			log.warn(
				`procedure candidate promotion failed for ${event.eventId} id=${candidate.procedureId}: ${String(err)}`,
			)
		}
	}
	if (prepared.procedureCandidates.length > 0) {
		const run = {
			agentId: event.agentId,
			projectionType: "procedures" as const,
			status: procedureFailed ? ("failed" as const) : ("ok" as const),
			itemsProjected: proceduresCreated,
			durationMs: 0,
		}
		if (session) {
			await recordProjectionRun({ db, prefix, run, session })
		} else {
			await recordProjectionRunBestEffort({
				db,
				prefix,
				run,
				context: "procedure promotion",
			})
		}
	}

	if (firstError !== undefined) {
		throw firstError
	}
	const totalCandidateCount =
		prepared.structuredCandidates.length + prepared.procedureCandidates.length
	if (
		totalCandidateCount > 0 &&
		existingCandidateCount === totalCandidateCount
	) {
		return {
			structuredCreated,
			proceduresCreated,
			skipped: true,
			skipReason: "already-promoted",
		}
	}
	return { structuredCreated, proceduresCreated, skipped: false }
}

export async function promoteDerivedMemoryFromEvent(params: {
	db: Db
	prefix: string
	client?: MongoClient
	session?: ClientSession
	embeddingMode: MemoryMongoDBEmbeddingMode
	event: ConversationEvent
	provider?: EnrichmentProvider | null
	temporalProvider?: EnrichmentProvider | null
	contradictionProvider?: EnrichmentProvider | null
	model?: string
	/**
	 * P3.9: facts from a session-batched LLM extraction made by the worker.
	 * When provided, the per-event provider call is skipped entirely.
	 */
	prefetchedLlmFacts?: string[]
	prepared?: PreparedDerivedMemoryPromotion
	skipContradictions?: boolean
}): Promise<{
	structuredCreated: number
	proceduresCreated: number
	skipped: boolean
	skipReason?: string
}> {
	const {
		db,
		prefix,
		client,
		embeddingMode,
		event,
		provider,
		temporalProvider,
		contradictionProvider,
		model,
		prefetchedLlmFacts,
	} = params

	const prepared =
		params.prepared ??
		(await prepareDerivedMemoryPromotion({
			db,
			prefix,
			event,
			provider,
			temporalProvider,
			model,
			prefetchedLlmFacts,
		}))
	const result = await persistPreparedDerivedMemoryPromotion({
		db,
		prefix,
		client,
		session: params.session,
		embeddingMode,
		event,
		prepared,
	})

	// Contradiction-driven invalidation (#33): expire existing active facts the
	// new facts make false. Run only after every candidate write succeeded, so a
	// retry cannot acknowledge an incomplete promotion set.
	const resolvedContradictionProvider = contradictionProvider ?? provider
	if (!params.skipContradictions && resolvedContradictionProvider) {
		await invalidateContradictedFacts({
			db,
			prefix,
			client,
			provider: resolvedContradictionProvider,
			model: model ?? "",
			requirePersistedSource: true,
			agentId: event.agentId,
			scope: event.scope,
			scopeRef: event.scopeRef,
			newFacts: prepared.structuredCandidates
				.filter((candidate) => candidate.type === "fact")
				.map((candidate) => ({
					key: candidate.key,
					value: candidate.value,
				})),
			runId: event.eventId,
		})
	}

	return result
}

/**
 * LLM-driven structured fact extraction (issue #30).
 *
 * Turns a canonical event into structured `fact` candidates using the
 * configured OpenAI-compatible / Anthropic enrichment provider, mirroring the
 * shape produced by the regex `extractStructuredCandidatesFromEvent` so the
 * downstream promotion/consolidation pipeline treats both identically.
 *
 * LLM facts are promoted only with reinforcement — the model can be wrong, so a
 * single extraction is never durably promoted on its own.
 */
export async function extractLlmStructuredCandidates(params: {
	event: ConversationEvent
	provider: EnrichmentProvider
	model: string
}): Promise<DerivedStructuredCandidate[]> {
	const { event, provider, model } = params
	const body = normalizeWhitespace(event.body)
	if (!body) {
		return []
	}

	const enrichment = await extractSessionEnrichment(provider, body, model)
	return buildLlmStructuredCandidatesFromFacts(event, enrichment.facts)
}

/**
 * Build LLM fact candidates from an ALREADY-EXTRACTED fact list. P3.9: the
 * extraction worker batches the LLM call per session and hands each event the
 * shared facts, so no per-event provider call happens here.
 */
function buildLlmStructuredCandidatesFromFacts(
	event: ConversationEvent,
	facts: string[],
): DerivedStructuredCandidate[] {
	if (facts.length === 0) {
		return []
	}

	const base = {
		agentId: event.agentId,
		scope: event.scope,
		scopeRef: event.scopeRef,
		workspaceDir: event.workspaceDir,
		sessionId: event.sessionId,
		sourceEventIds: [event.eventId],
		// Valid-time baseline (#32); refined per-candidate in mergeStructuredCandidates.
		validFrom: event.timestamp,
		provenance: {
			...buildStructuredProvenance(event),
			validTimeSource: "event",
		},
		confidence: 0.8, // llm_extracted
		sourceAgent: {
			id: event.agentId,
			name: "extractor" as const,
			runId: event.eventId,
		},
	} satisfies Partial<StructuredMemoryEntry>

	const candidates = new Map<string, DerivedStructuredCandidate>()
	for (const factText of facts) {
		const value = normalizeWhitespace(factText)
		if (!value) {
			continue
		}
		const key = `fact-${shortHash(value.toLowerCase())}`
		candidates.set(key, {
			...base,
			type: "fact",
			key,
			value,
			context: "Extracted by the LLM fact extractor from a canonical event.",
			source: event.role === "user" ? "user" : "session",
			tags: pickTopTerms(value, 4),
			promotionPolicy: "requires-reinforcement",
			promotionReason: "llm-extraction",
		})
	}
	return [...candidates.values()]
}
