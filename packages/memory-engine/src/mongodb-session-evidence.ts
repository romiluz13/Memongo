/**
 * Session-evidence creation for LongMemEval retrieval experiments.
 *
 * During benchmark ingestion, each session's user turns are concatenated into
 * a single session-level document so that queries about ANY topic mentioned
 * in that session can match it.
 *
 * Note: Including assistant turns was tested but REGRESSED multi-session by
 * -16.7 pp (100% → 83.3%) due to embedding dilution from verbose AI responses.
 * User-only concatenation produces tighter, more focused embeddings.
 *
 * Two architecture options are supported behind `MEMONGO_SESSION_EVIDENCE_MODE`:
 *   - "A": session docs go into the canonical `chunks` collection
 *   - "B": session docs go into a dedicated `session_chunks` collection
 *   - "none" (default): no session-level evidence is created
 */

import type { Collection } from "mongodb"
import type { MemoryScope } from "@memongo/lib"
import type { MemoryBenchmarkConversation } from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionEvidenceMode = "A" | "B" | "none"

export type SessionEvidenceDocument = {
	source: "session-evidence"
	path: string
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
		turnCount: number
		docType: "session"
	}
	provenance: {
		lane: "session_chunks"
		unit: "session"
		source: "session-evidence"
	}
}

// ---------------------------------------------------------------------------
// Env var resolution
// ---------------------------------------------------------------------------

export function resolveSessionEvidenceMode(
	envValue: string | undefined,
): SessionEvidenceMode {
	if (!envValue || typeof envValue !== "string") return "none"
	const normalized = envValue.trim().toUpperCase()
	if (normalized === "A") return "A"
	if (normalized === "B") return "B"
	return "none"
}

// ---------------------------------------------------------------------------
// Text truncation at sentence boundary (for embedding model limits)
// ---------------------------------------------------------------------------

const SESSION_EVIDENCE_MAX_CHARS = 8000

export function truncateAtSentenceBoundary(
	text: string,
	maxChars: number = SESSION_EVIDENCE_MAX_CHARS,
): string {
	if (text.length <= maxChars) return text

	// Find the last sentence-ending punctuation before the limit
	const sliced = text.slice(0, maxChars)
	const lastSentenceEnd = Math.max(
		sliced.lastIndexOf(". "),
		sliced.lastIndexOf(".\n"),
		sliced.lastIndexOf("! "),
		sliced.lastIndexOf("!\n"),
		sliced.lastIndexOf("? "),
		sliced.lastIndexOf("?\n"),
	)

	if (lastSentenceEnd > 0) {
		// Include the punctuation character but not the trailing space/newline
		return sliced.slice(0, lastSentenceEnd + 1).trimEnd()
	}

	// No sentence boundary found — hard truncate
	return sliced.trimEnd()
}

// ---------------------------------------------------------------------------
// Build session-evidence documents from benchmark conversations
// ---------------------------------------------------------------------------

export function buildSessionEvidenceDocuments(params: {
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]> // sessionId → array of event IDs
}): SessionEvidenceDocument[] {
	const { conversations, agentId, scope, scopeRef, eventIds } = params
	const documents: SessionEvidenceDocument[] = []
	const sessions = new Map<
		string,
		{
			userTurns: Array<MemoryBenchmarkConversation["turns"][number]>
		}
	>()

	for (const conversation of conversations) {
		const sessionId = conversation.sessionId
		if (!sessionId) continue

		const userTurns = conversation.turns.filter((t) => t.role === "user")
		if (userTurns.length === 0) continue
		const existing = sessions.get(sessionId)
		if (existing) {
			existing.userTurns.push(...userTurns)
		} else {
			sessions.set(sessionId, { userTurns: [...userTurns] })
		}
	}

	for (const [sessionId, session] of sessions) {
		const userTurns = session.userTurns
		const rawText = userTurns.map((t) => t.body).join("\n\n")
		const text = truncateAtSentenceBoundary(rawText)

		const sourceEventIds = eventIds.get(sessionId) ?? []

		// Use the first turn's timestamp as the session date (from LongMemEval haystack_dates),
		// falling back to current time only if no turn timestamp exists
		const sessionTimestamp = userTurns[0]?.timestamp
			? new Date(userTurns[0].timestamp)
			: new Date()
		const validTimestamp = !Number.isNaN(sessionTimestamp.getTime())
			? sessionTimestamp
			: new Date()

		documents.push({
			source: "session-evidence",
			path: `session_chunks/${sessionId}`,
			text,
			agentId,
			scope,
			scopeRef,
			sessionId,
			canonicalId: `session-chunk/${sessionId}`,
			status: "active",
			timestamp: validTimestamp,
			updatedAt: validTimestamp,
			metadata: {
				sourceEventIds,
				turnCount: userTurns.length,
				docType: "session",
			},
			provenance: {
				lane: "session_chunks",
				unit: "session",
				source: "session-evidence",
			},
		})
	}

	return documents
}

// ---------------------------------------------------------------------------
// Canonical ID helpers
// ---------------------------------------------------------------------------

const SESSION_CHUNK_PREFIX = "session-chunk/"

export function extractSessionIdFromCanonicalId(
	canonicalId: string | undefined,
): string | null {
	if (!canonicalId || typeof canonicalId !== "string") return null
	if (!canonicalId.startsWith(SESSION_CHUNK_PREFIX)) return null
	const sessionId = canonicalId.slice(SESSION_CHUNK_PREFIX.length).trim()
	return sessionId.length > 0 ? sessionId : null
}

// ---------------------------------------------------------------------------
// Option A: write session evidence into the canonical chunks collection
// ---------------------------------------------------------------------------

export async function writeSessionEvidenceOptionA(params: {
	chunksCollection: Collection
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]>
}): Promise<number> {
	const docs = buildSessionEvidenceDocuments({
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

// ---------------------------------------------------------------------------
// Option B: write session evidence into the dedicated session_chunks collection
// ---------------------------------------------------------------------------

export async function writeSessionEvidenceOptionB(params: {
	sessionChunksCollection: Collection
	conversations: MemoryBenchmarkConversation[]
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventIds: Map<string, string[]>
}): Promise<number> {
	const docs = buildSessionEvidenceDocuments({
		conversations: params.conversations,
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		eventIds: params.eventIds,
	})
	if (docs.length === 0) return 0
	await params.sessionChunksCollection.insertMany(docs)
	return docs.length
}
