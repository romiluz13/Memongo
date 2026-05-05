import type { Collection } from "mongodb"
import type { MemoryScope } from "@memongo/lib"
import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkTurn,
} from "./types.js"

export type UserfactEvidenceMode = "enabled" | "none"

export type UserfactEvidenceDocument = {
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
		extractedFacts: number
		turnCount: number
		docType: "userfact"
	}
}

type UserfactPattern = {
	regex: RegExp
	buildFact: (match: string) => string
}

const USERFACT_CHUNK_PREFIX = "userfact-chunk/"
const USERFACT_EVIDENCE_MAX_FACTS = 10
const USERFACT_EVIDENCE_MAX_DOC_CHARS = 700
const USERFACT_EVIDENCE_MAX_FACT_CHARS = 120
const USERFACT_EVIDENCE_PREFIX = "User has mentioned: "

const USERFACT_PATTERNS: UserfactPattern[] = [
	{
		regex: /\bi prefer ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `prefers ${match}`,
	},
	{
		regex: /\bi usually ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `usually ${match}`,
	},
	{
		regex: /\bi(?:'m| am) (?:a fan of|into|fond of) ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `likes ${match}`,
	},
	{
		regex:
			/\bi(?:'ve| have) (?:always |really )?(?:liked|loved|enjoyed) ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `likes ${match}`,
	},
	{
		regex: /\bi want to ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `wants to ${match}`,
	},
	{
		regex: /\bi(?:'m| am) thinking (?:about|of) ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `thinking about ${match}`,
	},
	{
		regex:
			/\bi(?:'ve been| have been) having (?:trouble|issues?|problems?) with ([^,.!?;\n]{5,100})/gi,
		buildFact: (match) => `having trouble with ${match}`,
	},
	{
		regex:
			/\bi (?:just )?(?:bought|got|purchased|ordered|picked up) (?:a |an |the )?([^,.!?;\n]{5,100})/gi,
		buildFact: (match) => `bought ${match}`,
	},
	{
		regex:
			/\bi(?:'m| am) (?:currently |now )?(?:using|working with|driving|wearing) (?:a |an |the )?([^,.!?;\n]{5,100})/gi,
		buildFact: (match) => `using ${match}`,
	},
	{
		regex: /\bmy (?:favorite|favourite) ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `favorite ${match}`,
	},
	{
		regex:
			/\bi(?:'m| am) (?:looking for|searching for|trying to find) ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `looking for ${match}`,
	},
	{
		regex: /\bi(?:'m| am) (?:planning|going) to ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `planning to ${match}`,
	},
	{
		regex:
			/\bi(?:'ve| have) been (?!having (?:trouble|issues?|problems?) with )([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `has been ${match}`,
	},
	{
		regex:
			/\blately[, ]+(?:i(?:'ve| have) been|i(?:'m| am)) ([^,.!?;\n]{5,100})/gi,
		buildFact: (match) => `lately ${match}`,
	},
	{
		regex: /\bi (?:really )?(?:need|could use) ([^,.!?;\n]{5,80})/gi,
		buildFact: (match) => `needs ${match}`,
	},
	{
		regex:
			/\bi(?:'ve| have) (?:recently )?(?:moved|switched|changed|upgraded) (?:to )?([^,.!?;\n]{5,100})/gi,
		buildFact: (match) => `changed to ${match}`,
	},
]

function normalizeModeValue(
	envValue: string | undefined,
): UserfactEvidenceMode | null {
	if (typeof envValue !== "string") return null
	const normalized = envValue.trim().toLowerCase()
	if (
		normalized === "enabled" ||
		normalized === "true" ||
		normalized === "1" ||
		normalized === "on" ||
		normalized === "yes"
	) {
		return "enabled"
	}
	if (
		normalized === "none" ||
		normalized === "disabled" ||
		normalized === "false" ||
		normalized === "0" ||
		normalized === "off" ||
		normalized === "no"
	) {
		return "none"
	}
	return "none"
}

export function resolveUserfactEvidenceMode(
	envValue: string | undefined,
	legacyPreferenceEnvValue?: string | undefined,
): UserfactEvidenceMode {
	const explicitMode = normalizeModeValue(envValue)
	if (explicitMode) {
		return explicitMode
	}
	const legacyMode = normalizeModeValue(legacyPreferenceEnvValue)
	return legacyMode ?? "none"
}

function sanitizeFactText(value: string): string | null {
	const cleaned = value
		.replace(/\s+/g, " ")
		.replace(/^[\s"'`([{]+|[\s"'`)\]}]+$/g, "")
		.replace(/\b(?:and|but|because|so|while|which|who|where|when)\b.*$/i, "")
		.trim()

	if (cleaned.length < 4) return null
	if (!/[a-z0-9]/i.test(cleaned)) return null

	const generic = cleaned.toLowerCase()
	if (
		generic === "it" ||
		generic === "this" ||
		generic === "that" ||
		generic === "something" ||
		generic === "anything"
	) {
		return null
	}

	if (cleaned.length <= USERFACT_EVIDENCE_MAX_FACT_CHARS) {
		return cleaned
	}
	return cleaned.slice(0, USERFACT_EVIDENCE_MAX_FACT_CHARS).trimEnd()
}

export function extractUserfactFacts(text: string): string[] {
	const facts: string[] = []
	const seen = new Set<string>()

	for (const pattern of USERFACT_PATTERNS) {
		for (const match of text.matchAll(pattern.regex)) {
			const captured = match[1]
			if (typeof captured !== "string") continue
			const fact = sanitizeFactText(pattern.buildFact(captured))
			if (!fact) continue
			const dedupeKey = fact.toLowerCase()
			if (seen.has(dedupeKey)) continue
			seen.add(dedupeKey)
			facts.push(fact)
			if (facts.length >= USERFACT_EVIDENCE_MAX_FACTS) {
				return facts
			}
		}
	}

	return facts
}

function getSessionTimestamp(turns: MemoryBenchmarkTurn[]): Date {
	const timestamp = turns[0]?.timestamp
		? new Date(turns[0].timestamp)
		: new Date()
	return !Number.isNaN(timestamp.getTime()) ? timestamp : new Date()
}

function buildUserfactEvidenceText(facts: string[]): string | null {
	if (facts.length === 0) return null

	const selected: string[] = []
	for (const fact of facts.slice(0, USERFACT_EVIDENCE_MAX_FACTS)) {
		const candidate =
			selected.length === 0
				? `${USERFACT_EVIDENCE_PREFIX}${fact}.`
				: `${USERFACT_EVIDENCE_PREFIX}${selected.join("; ")}; ${fact}.`
		if (candidate.length > USERFACT_EVIDENCE_MAX_DOC_CHARS) {
			break
		}
		selected.push(fact)
	}

	if (selected.length === 0) return null
	return `${USERFACT_EVIDENCE_PREFIX}${selected.join("; ")}.`
}

export function buildUserfactEvidenceDocuments(params: {
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]>
}): UserfactEvidenceDocument[] {
	const { conversations, agentId, scope, scopeRef, eventIds } = params
	const documents: UserfactEvidenceDocument[] = []

	for (const conversation of conversations) {
		const sessionId = conversation.sessionId
		if (!sessionId) continue

		const userTurns = conversation.turns.filter((turn) => turn.role === "user")
		if (userTurns.length === 0) continue

		const userText = userTurns.map((turn) => turn.body).join("\n")
		const extractedFacts = extractUserfactFacts(userText)
		const text = buildUserfactEvidenceText(extractedFacts)
		if (!text) continue

		const timestamp = getSessionTimestamp(userTurns)

		documents.push({
			source: "userfact-evidence",
			text,
			agentId,
			scope,
			scopeRef,
			sessionId,
			canonicalId: `${USERFACT_CHUNK_PREFIX}${sessionId}`,
			status: "active",
			timestamp,
			updatedAt: timestamp,
			metadata: {
				sourceEventIds: eventIds.get(sessionId) ?? [],
				extractedFacts: extractedFacts.length,
				turnCount: userTurns.length,
				docType: "userfact",
			},
		})
	}

	return documents
}

export function extractSessionIdFromUserfactCanonicalId(
	canonicalId: string | undefined,
): string | null {
	if (!canonicalId || typeof canonicalId !== "string") return null
	if (!canonicalId.startsWith(USERFACT_CHUNK_PREFIX)) return null
	const sessionId = canonicalId.slice(USERFACT_CHUNK_PREFIX.length).trim()
	return sessionId.length > 0 ? sessionId : null
}

export async function writeUserfactEvidence(params: {
	chunksCollection: Collection
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]>
}): Promise<number> {
	const docs = buildUserfactEvidenceDocuments({
		conversations: params.conversations,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		eventIds: params.eventIds,
	})
	if (docs.length === 0) return 0
	await params.chunksCollection.insertMany(docs)
	return docs.length
}
