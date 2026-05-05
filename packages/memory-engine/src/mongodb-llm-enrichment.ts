/**
 * LLM-powered session enrichment for benchmark ingest.
 *
 * Extracts atomic user facts and synthetic QA pairs per session using a
 * provider-agnostic LLM interface (OpenAI-compatible chat completions).
 * Produces two doc types in the canonical chunks collection:
 *   - "userfact-evidence" with extractionMethod "llm" (replaces regex when available)
 *   - "qa-evidence" (new synthetic QA pairs for EnrichIndex-style retrieval)
 *
 * Behind MEMONGO_LLM_ENRICHMENT_MODE flag:
 *   - "enabled": extract facts + QA pairs
 *   - "facts-only": extract facts only (no QA pairs)
 *   - "none" (default): fall back to regex-only userfact extraction
 */

import type { MemoryScope } from "@memongo/lib"
import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkTurn,
} from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnrichmentMode = "enabled" | "facts-only" | "none"

export type EnrichmentProviderConfig = {
	baseUrl: string
	apiKey: string
	model: string
}

export type EnrichmentProvider = {
	name: string
	chatCompletion(params: {
		model: string
		messages: Array<{ role: string; content: string }>
		responseFormat?: { type: "json_object" }
		maxTokens?: number
	}): Promise<{ content: string }>
}

export type EnrichmentResult = {
	facts: string[]
	qaPairs: Array<{ q: string; a: string }>
	hasPersonalContent: boolean
}

export type UserfactEvidenceEnrichedDocument = {
	source: "userfact-evidence"
	text: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionId: string
	canonicalId: string
	status: "active"
	timestamp: Date
	updatedAt: Date
	metadata: {
		sourceEventIds: string[]
		docType: "userfact"
		extractedFacts: number
		extractionMethod: "llm"
		turnCount: number
	}
}

export type QaEvidenceDocument = {
	source: "qa-evidence"
	text: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionId: string
	canonicalId: string
	status: "active"
	timestamp: Date
	updatedAt: Date
	metadata: {
		sourceEventIds: string[]
		docType: "qa"
		qaPairs: number
		extractionMethod: "llm"
		turnCount: number
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USERFACT_CHUNK_PREFIX = "userfact-chunk/"
const QA_CHUNK_PREFIX = "qa-chunk/"
const MAX_CONCURRENT = 5
const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 1000
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 503])
const LLM_TIMEOUT_MS = 30_000
const MAX_ENRICHED_DOC_CHARS = 700
const MAX_ENRICHED_FACTS = 10
const MAX_ENRICHED_QA_PAIRS = 10

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

export const ENRICHMENT_SYSTEM_PROMPT = `You are a personal fact extractor for an AI memory system.

Given a conversation session (user turns only), extract two things:

1. FACTS: Atomic personal facts about the user. Rules:
   - Each fact must be a single, self-contained claim
   - Write in third person: "The user grows cherry tomatoes in their garden"
   - Add contextual prefix from the conversation topic: "From a conversation about gardening: The user grows cherry tomatoes"
   - Include temporal anchoring when dates are mentioned: "As of March 2024, the user..."
   - Include facts explicitly stated OR strongly implied
   - Categories: preference, ownership, activity, plan, biographical, relationship
   - If no personal facts exist, return an empty array

2. QA_PAIRS: Questions someone might ask that this session could answer. Rules:
   - Questions should use DIFFERENT vocabulary than the session text
   - Focus on recommendation/advice questions: "What should I...", "Can you suggest..."
   - Maximum 5 pairs
   - If the session has no actionable content, return an empty array

Respond with valid JSON only:
{
  "facts": ["From a conversation about gardening: The user grows cherry tomatoes in their garden", "The user uses fresh basil and mint from their garden"],
  "qa_pairs": [
    {"q": "What fresh ingredients does the user have available for cooking?", "a": "Cherry tomatoes, basil, and mint from their garden"},
    {"q": "What should the user serve for dinner using homegrown produce?", "a": "Dishes featuring cherry tomatoes, basil, and mint"}
  ],
  "has_personal_content": true
}`

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export function resolveEnrichmentMode(
	envValue: string | undefined,
): EnrichmentMode {
	if (typeof envValue !== "string") return "none"
	const normalized = envValue.trim().toLowerCase()
	if (normalized === "enabled") return "enabled"
	if (normalized === "facts-only") return "facts-only"
	return "none"
}

// ---------------------------------------------------------------------------
// HTTP provider (OpenAI-compatible, Grove gateway compatible)
// ---------------------------------------------------------------------------

const DEFAULT_GROVE_BASE_URL =
	"https://grove-gateway-prod.azure-api.net/grove-foundry-prod/openai/v1"
const DEFAULT_MODEL = "gpt-4o-mini"

export function createHttpProvider(
	config: EnrichmentProviderConfig,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
): EnrichmentProvider {
	return {
		name: "http",
		async chatCompletion(params) {
			const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`
			const body: Record<string, unknown> = {
				model: params.model,
				messages: params.messages,
			}
			if (params.responseFormat) {
				body.response_format = params.responseFormat
			}
			if (params.maxTokens !== undefined) {
				// Use max_completion_tokens (required by gpt-5+ via Grove gateway)
				// with max_tokens as fallback for older model endpoints
				body.max_completion_tokens = params.maxTokens
			}

			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

			try {
				const response = await fetchFn(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"api-key": config.apiKey,
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				})

				if (!response.ok) {
					const text = await response.text().catch(() => "")
					throw new EnrichmentHttpError(
						`LLM enrichment request failed: ${response.status} ${text}`,
						response.status,
					)
				}

				const json = (await response.json()) as {
					choices?: Array<{
						message?: { content?: string }
					}>
				}
				const content = json.choices?.[0]?.message?.content ?? ""
				return { content }
			} catch (err) {
				// Wrap AbortError (timeout) as retryable 408
				if (err instanceof DOMException && err.name === "AbortError") {
					throw new EnrichmentHttpError(
						`LLM enrichment request timed out after ${LLM_TIMEOUT_MS}ms`,
						408,
					)
				}
				throw err
			} finally {
				clearTimeout(timer)
			}
		},
	}
}

export class EnrichmentHttpError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message)
		this.name = "EnrichmentHttpError"
	}
}

// ---------------------------------------------------------------------------
// Provider resolution from env vars
// ---------------------------------------------------------------------------

export function resolveEnrichmentProvider(
	env: Record<string, string | undefined>,
): EnrichmentProvider | null {
	const apiKey = env.MEMONGO_ENRICHMENT_API_KEY ?? env.GROVE_API_KEY
	if (!apiKey) return null

	const baseUrl = env.MEMONGO_ENRICHMENT_BASE_URL ?? DEFAULT_GROVE_BASE_URL
	const model = env.MEMONGO_ENRICHMENT_MODEL ?? DEFAULT_MODEL

	return createHttpProvider({ baseUrl, apiKey, model })
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

export async function extractSessionEnrichment(
	provider: EnrichmentProvider,
	sessionText: string,
	model: string,
): Promise<EnrichmentResult> {
	const empty: EnrichmentResult = {
		facts: [],
		qaPairs: [],
		hasPersonalContent: false,
	}

	const response = await provider.chatCompletion({
		model,
		messages: [
			{ role: "system", content: ENRICHMENT_SYSTEM_PROMPT },
			{ role: "user", content: sessionText },
		],
		responseFormat: { type: "json_object" },
		maxTokens: 1024,
	})

	let parsed: unknown
	try {
		// Strip markdown code fences (```json ... ```) that some LLMs wrap
		const stripped = response.content
			.replace(/^```(?:json)?\s*\n?/i, "")
			.replace(/\n?```\s*$/i, "")
		parsed = JSON.parse(stripped)
	} catch {
		console.warn(
			`LLM enrichment JSON parse failed: ${response.content.slice(0, 200)}`,
		)
		return empty
	}

	if (!parsed || typeof parsed !== "object") return empty
	const record = parsed as Record<string, unknown>

	const rawFacts = Array.isArray(record.facts) ? record.facts : []
	const facts = rawFacts.filter(
		(f): f is string => typeof f === "string" && f.trim().length > 0,
	)

	const rawPairs = Array.isArray(record.qa_pairs) ? record.qa_pairs : []
	const qaPairs = rawPairs
		.filter(
			(p): p is { q: string; a: string } =>
				!!p &&
				typeof p === "object" &&
				typeof (p as Record<string, unknown>).q === "string" &&
				(p as Record<string, unknown>).q !== "" &&
				typeof (p as Record<string, unknown>).a === "string" &&
				(p as Record<string, unknown>).a !== "",
		)
		.map((p) => ({ q: p.q, a: p.a }))

	const hasPersonalContent =
		typeof record.has_personal_content === "boolean"
			? record.has_personal_content
			: facts.length > 0

	return { facts, qaPairs, hasPersonalContent }
}

// ---------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------

export function buildEnrichedUserfactDocument(params: {
	facts: string[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionId: string
	sourceEventIds: string[]
	turnCount: number
	timestamp: Date
}): UserfactEvidenceEnrichedDocument | null {
	if (params.facts.length === 0) return null

	const cappedFacts = params.facts.slice(0, MAX_ENRICHED_FACTS)
	let text = `User facts: ${cappedFacts.join("; ")}.`
	if (text.length > MAX_ENRICHED_DOC_CHARS) {
		text = text.slice(0, MAX_ENRICHED_DOC_CHARS - 3) + "..."
	}

	return {
		source: "userfact-evidence",
		text,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: params.sessionId,
		canonicalId: `${USERFACT_CHUNK_PREFIX}${params.sessionId}`,
		status: "active",
		timestamp: params.timestamp,
		updatedAt: params.timestamp,
		metadata: {
			sourceEventIds: params.sourceEventIds,
			docType: "userfact",
			extractedFacts: cappedFacts.length,
			extractionMethod: "llm",
			turnCount: params.turnCount,
		},
	}
}

export function buildQaEvidenceDocument(params: {
	qaPairs: Array<{ q: string; a: string }>
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionId: string
	sourceEventIds: string[]
	turnCount: number
	timestamp: Date
}): QaEvidenceDocument | null {
	if (params.qaPairs.length === 0) return null

	const cappedPairs = params.qaPairs.slice(0, MAX_ENRICHED_QA_PAIRS)
	let text = cappedPairs.map((pair) => `Q: ${pair.q} A: ${pair.a}`).join(" ")
	if (text.length > MAX_ENRICHED_DOC_CHARS) {
		text = text.slice(0, MAX_ENRICHED_DOC_CHARS - 3) + "..."
	}

	return {
		source: "qa-evidence",
		text,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: params.sessionId,
		canonicalId: `${QA_CHUNK_PREFIX}${params.sessionId}`,
		status: "active",
		timestamp: params.timestamp,
		updatedAt: params.timestamp,
		metadata: {
			sourceEventIds: params.sourceEventIds,
			docType: "qa",
			qaPairs: cappedPairs.length,
			extractionMethod: "llm",
			turnCount: params.turnCount,
		},
	}
}

// ---------------------------------------------------------------------------
// Batch enrichment with concurrency + retry
// ---------------------------------------------------------------------------

export type EnrichSessionsResult = {
	userfactDocs: UserfactEvidenceEnrichedDocument[]
	qaDocs: QaEvidenceDocument[]
	sessionsEnriched: number
	sessionsFailed: number
	failedSessionIds: string[]
}

function getSessionTimestamp(turns: MemoryBenchmarkTurn[]): Date {
	const ts = turns[0]?.timestamp ? new Date(turns[0].timestamp) : new Date()
	return !Number.isNaN(ts.getTime()) ? ts : new Date()
}

async function enrichSingleSession(params: {
	provider: EnrichmentProvider
	model: string
	mode: EnrichmentMode
	sessionText: string
	sessionId: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sourceEventIds: string[]
	turnCount: number
	timestamp: Date
}): Promise<{
	userfactDoc: UserfactEvidenceEnrichedDocument | null
	qaDoc: QaEvidenceDocument | null
}> {
	const result = await extractSessionEnrichment(
		params.provider,
		params.sessionText,
		params.model,
	)

	const userfactDoc = buildEnrichedUserfactDocument({
		facts: result.facts,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: params.sessionId,
		sourceEventIds: params.sourceEventIds,
		turnCount: params.turnCount,
		timestamp: params.timestamp,
	})

	const qaDoc =
		params.mode === "enabled"
			? buildQaEvidenceDocument({
					qaPairs: result.qaPairs,
					agentId: params.agentId,
					scope: params.scope,
					scopeRef: params.scopeRef,
					sessionId: params.sessionId,
					sourceEventIds: params.sourceEventIds,
					turnCount: params.turnCount,
					timestamp: params.timestamp,
				})
			: null

	return { userfactDoc, qaDoc }
}

async function withRetry<T>(
	fn: () => Promise<T>,
	maxRetries: number = MAX_RETRIES,
): Promise<T> {
	let lastError: unknown
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastError = err
			const isRetryable =
				(err instanceof EnrichmentHttpError &&
					RETRYABLE_STATUS_CODES.has(err.statusCode)) ||
				(err instanceof DOMException && err.name === "AbortError")
			if (attempt < maxRetries && isRetryable) {
				const baseDelay = INITIAL_BACKOFF_MS * 2 ** attempt
				const delay = Math.round(baseDelay * (0.5 + Math.random()))
				await new Promise((resolve) => setTimeout(resolve, delay))
				continue
			}
			throw err
		}
	}
	throw lastError
}

export async function enrichSessionsWithLLM(params: {
	provider: EnrichmentProvider
	model: string
	mode: EnrichmentMode
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]>
	concurrency?: number
}): Promise<EnrichSessionsResult> {
	const concurrency = params.concurrency ?? MAX_CONCURRENT
	const userfactDocs: UserfactEvidenceEnrichedDocument[] = []
	const qaDocs: QaEvidenceDocument[] = []
	const failedSessionIds: string[] = []
	let sessionsEnriched = 0
	let sessionsFailed = 0

	// Build session work items
	type SessionWork = {
		sessionId: string
		sessionText: string
		turnCount: number
		sourceEventIds: string[]
		timestamp: Date
	}
	const workItems: SessionWork[] = []

	for (const conversation of params.conversations) {
		const sessionId = conversation.sessionId
		if (!sessionId) continue

		const userTurns = conversation.turns.filter((turn) => turn.role === "user")
		if (userTurns.length === 0) continue

		const sessionText = userTurns.map((turn) => turn.body).join("\n")
		const sourceEventIds = params.eventIds.get(sessionId) ?? []
		const timestamp = getSessionTimestamp(userTurns)

		workItems.push({
			sessionId,
			sessionText,
			turnCount: userTurns.length,
			sourceEventIds,
			timestamp,
		})
	}

	// Process with concurrency control
	let index = 0
	const processNext = async (): Promise<void> => {
		while (index < workItems.length) {
			const currentIndex = index++
			const work = workItems[currentIndex]
			try {
				const result = await withRetry(() =>
					enrichSingleSession({
						provider: params.provider,
						model: params.model,
						mode: params.mode,
						sessionText: work.sessionText,
						sessionId: work.sessionId,
						agentId: params.agentId,
						scope: params.scope,
						scopeRef: params.scopeRef,
						sourceEventIds: work.sourceEventIds,
						turnCount: work.turnCount,
						timestamp: work.timestamp,
					}),
				)
				if (result.userfactDoc) {
					userfactDocs.push(result.userfactDoc)
				}
				if (result.qaDoc) {
					qaDocs.push(result.qaDoc)
				}
				if (result.userfactDoc || result.qaDoc) {
					sessionsEnriched++
				}
			} catch {
				sessionsFailed++
				failedSessionIds.push(work.sessionId)
			}
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, workItems.length) },
		() => processNext(),
	)
	await Promise.all(workers)

	return {
		userfactDocs,
		qaDocs,
		sessionsEnriched,
		sessionsFailed,
		failedSessionIds,
	}
}
