import { createHash } from "node:crypto"
import type { Collection, Document } from "mongodb"
import type { MemoryScope } from "@memongo/lib"
import { truncateAtSentenceBoundary } from "./mongodb-session-evidence.js"
import type { MemoryBenchmarkConversation } from "./types.js"

export type EvidenceMirrorMode = "enabled" | "disabled"

export type MemoryEvidenceUnit =
	| "turn"
	| "session"
	| "preference"
	| "userfact"
	| "assistant"
	| "temporal_anchor"
	| "graph"

export type MemoryEvidenceDocument = {
	source: "conversation"
	path: string
	text: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionId: string
	sourceIds: string[]
	sourceEventIds: string[]
	unit: MemoryEvidenceUnit
	canonicalId: string
	status: "active"
	timestamp: Date
	updatedAt: Date
	provenance: {
		lane: "memory-evidence"
		evidenceUnit: MemoryEvidenceUnit
		sourceCollection: "events" | "relations"
		sourceEventIds: string[]
		builder: "benchmark-fast-ingest"
	}
	metadata: {
		sourceEventIds: string[]
		turnCount?: number
		extractedFromRole?: "user" | "assistant"
	}
}

export function resolveEvidenceMirrorMode(
	envValue: string | undefined,
): EvidenceMirrorMode {
	if (!envValue || typeof envValue !== "string") return "disabled"
	const normalized = envValue.trim().toLowerCase()
	return normalized === "enabled" || normalized === "1" || normalized === "true"
		? "enabled"
		: "disabled"
}

export function isEvidenceMirrorEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		resolveEvidenceMirrorMode(env.MEMONGO_EVIDENCE_MIRROR_MODE) === "enabled"
	)
}

function stableHash(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

function validDate(value: string | undefined, fallback: Date): Date {
	if (!value) return fallback
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? fallback : date
}

function normalizeEvidenceText(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

const PREFERENCE_RE =
	/\b(i|we)\s+(prefer|like|love|dislike|hate|avoid|want|need|care about|usually|always|never|rather|enjoy|am into|tend to)\b|\b(my|our)\s+(favorite|preference|style|taste|habit)\b/i

const USERFACT_RE =
	/\b(i|we)\s+(am|work|live|have|use|own|play|study|manage|build|run|created|started|need|want|care|keep|track)\b|\bmy\s+[\w-]+\b/i

function splitEvidenceStatements(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map(normalizeEvidenceText)
		.filter((statement) => statement.length >= 12)
}

function pushEvidenceDoc(params: {
	documents: MemoryEvidenceDocument[]
	seen: Set<string>
	unit: MemoryEvidenceUnit
	text: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	sessionId: string
	sourceEventIds: string[]
	timestamp: Date
	turnCount?: number
	extractedFromRole?: "user" | "assistant"
}): void {
	const text = truncateAtSentenceBoundary(
		normalizeEvidenceText(params.text),
		8000,
	)
	if (!text) return
	const identity = `${params.unit}:${params.sessionId}:${stableHash(text)}`
	if (params.seen.has(identity)) return
	params.seen.add(identity)
	const canonicalId = `memory-evidence/${identity}`
	params.documents.push({
		source: "conversation",
		path: canonicalId,
		text,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		sessionId: params.sessionId,
		sourceIds: params.sourceEventIds,
		sourceEventIds: params.sourceEventIds,
		unit: params.unit,
		canonicalId,
		status: "active",
		timestamp: params.timestamp,
		updatedAt: params.timestamp,
		provenance: {
			lane: "memory-evidence",
			evidenceUnit: params.unit,
			sourceCollection: "events",
			sourceEventIds: params.sourceEventIds,
			builder: "benchmark-fast-ingest",
		},
		metadata: {
			sourceEventIds: params.sourceEventIds,
			...(params.turnCount !== undefined
				? { turnCount: params.turnCount }
				: {}),
			...(params.extractedFromRole
				? { extractedFromRole: params.extractedFromRole }
				: {}),
		},
	})
}

export function buildMemoryEvidenceDocuments(params: {
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]>
}): MemoryEvidenceDocument[] {
	const documents: MemoryEvidenceDocument[] = []
	const seen = new Set<string>()
	const sessions = new Map<
		string,
		{
			userTurns: Array<MemoryBenchmarkConversation["turns"][number]>
			assistantTurns: Array<MemoryBenchmarkConversation["turns"][number]>
		}
	>()

	for (const [index, conversation] of params.conversations.entries()) {
		const sessionId =
			conversation.sessionId ??
			conversation.conversationId ??
			`conversation-${index + 1}`
		if (!sessionId) continue
		const existing = sessions.get(sessionId) ?? {
			userTurns: [],
			assistantTurns: [],
		}
		for (const turn of conversation.turns) {
			if (turn.role === "user") {
				existing.userTurns.push(turn)
			} else if (turn.role === "assistant") {
				existing.assistantTurns.push(turn)
			}
		}
		sessions.set(sessionId, existing)
	}

	for (const [sessionId, session] of sessions) {
		const sourceEventIds = params.eventIds.get(sessionId) ?? []
		const timestamp = validDate(
			session.userTurns[0]?.timestamp ?? session.assistantTurns[0]?.timestamp,
			new Date(),
		)
		const userText = session.userTurns.map((turn) => turn.body).join("\n\n")
		const assistantText = session.assistantTurns
			.map((turn) => turn.body)
			.join("\n\n")

		if (userText.trim().length > 0) {
			pushEvidenceDoc({
				documents,
				seen,
				unit: "session",
				text: userText,
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId,
				sourceEventIds,
				timestamp,
				turnCount: session.userTurns.length,
				extractedFromRole: "user",
			})
			pushEvidenceDoc({
				documents,
				seen,
				unit: "temporal_anchor",
				text: `Session date: ${timestamp.toISOString().slice(0, 10)}\n${userText}`,
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId,
				sourceEventIds,
				timestamp,
				turnCount: session.userTurns.length,
				extractedFromRole: "user",
			})
		}

		if (assistantText.trim().length > 0) {
			pushEvidenceDoc({
				documents,
				seen,
				unit: "assistant",
				text: assistantText,
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId,
				sourceEventIds,
				timestamp,
				turnCount: session.assistantTurns.length,
				extractedFromRole: "assistant",
			})
		}

		let extracted = 0
		for (const turn of session.userTurns) {
			for (const statement of splitEvidenceStatements(turn.body)) {
				const unit: MemoryEvidenceUnit | null = PREFERENCE_RE.test(statement)
					? "preference"
					: USERFACT_RE.test(statement)
						? "userfact"
						: null
				if (!unit) continue
				pushEvidenceDoc({
					documents,
					seen,
					unit,
					text: statement,
					agentId: params.agentId,
					scope: params.scope,
					scopeRef: params.scopeRef,
					sessionId,
					sourceEventIds,
					timestamp: validDate(turn.timestamp, timestamp),
					extractedFromRole: "user",
				})
				extracted++
				if (extracted >= 12) break
			}
			if (extracted >= 12) break
		}
	}

	return documents
}

export async function writeMemoryEvidenceDocuments(params: {
	collection: Collection<Document>
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]>
}): Promise<number> {
	const docs = buildMemoryEvidenceDocuments({
		conversations: params.conversations,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		eventIds: params.eventIds,
	})
	if (docs.length === 0) return 0
	await params.collection.insertMany(docs, { ordered: false })
	return docs.length
}
