import { describe, it, expect, vi } from "vitest"
import {
	resolveSessionEvidenceMode,
	buildSessionEvidenceDocuments,
	truncateAtSentenceBoundary,
	writeSessionEvidenceOptionA,
	writeSessionEvidenceOptionB,
	extractSessionIdFromCanonicalId,
	type SessionEvidenceMode,
	type SessionEvidenceDocument,
} from "./mongodb-session-evidence.js"
import type { MemoryBenchmarkConversation } from "./types.js"
import type { Collection } from "mongodb"

// ---------------------------------------------------------------------------
// resolveSessionEvidenceMode
// ---------------------------------------------------------------------------

describe("resolveSessionEvidenceMode", () => {
	it("returns 'none' by default when env var is absent", () => {
		const mode = resolveSessionEvidenceMode(undefined)
		expect(mode).toBe("none")
	})

	it("returns 'A' when env var is 'A'", () => {
		const mode = resolveSessionEvidenceMode("A")
		expect(mode).toBe("A")
	})

	it("returns 'B' when env var is 'B'", () => {
		const mode = resolveSessionEvidenceMode("B")
		expect(mode).toBe("B")
	})

	it("returns 'none' for unrecognized values", () => {
		const mode = resolveSessionEvidenceMode("C")
		expect(mode).toBe("none")
	})

	it("normalizes lowercase input", () => {
		expect(resolveSessionEvidenceMode("a")).toBe("A")
		expect(resolveSessionEvidenceMode("b")).toBe("B")
	})
})

// ---------------------------------------------------------------------------
// truncateAtSentenceBoundary
// ---------------------------------------------------------------------------

describe("truncateAtSentenceBoundary", () => {
	it("returns text unchanged when under the limit", () => {
		const text = "Hello world."
		expect(truncateAtSentenceBoundary(text, 8000)).toBe(text)
	})

	it("truncates at the last sentence boundary before the limit", () => {
		const sentence1 = "First sentence. "
		const sentence2 = "Second sentence. "
		const sentence3 = "Third sentence."
		const text = sentence1 + sentence2 + sentence3
		// Limit just past the second sentence
		const result = truncateAtSentenceBoundary(
			text,
			sentence1.length + sentence2.length + 2,
		)
		expect(result).toBe("First sentence. Second sentence.")
	})

	it("returns full text if only one sentence and under limit", () => {
		expect(truncateAtSentenceBoundary("Only one sentence.", 100)).toBe(
			"Only one sentence.",
		)
	})
})

// ---------------------------------------------------------------------------
// buildSessionEvidenceDocuments
// ---------------------------------------------------------------------------

describe("buildSessionEvidenceDocuments", () => {
	const conversations: MemoryBenchmarkConversation[] = [
		{
			conversationId: "q1",
			sessionId: "q1::session_1",
			turns: [
				{ role: "user", body: "I like pizza." },
				{ role: "assistant", body: "That's great!" },
				{ role: "user", body: "I also like pasta." },
			],
		},
		{
			conversationId: "q1",
			sessionId: "q1::session_2",
			turns: [
				{ role: "user", body: "My favorite color is blue." },
				{ role: "assistant", body: "Blue is nice." },
			],
		},
	]

	it("creates one document per session", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([
				["q1::session_1", ["evt1", "evt2", "evt3"]],
				["q1::session_2", ["evt4", "evt5"]],
			]),
		})
		expect(docs).toHaveLength(2)
	})

	it("merges repeated conversation records for the same session", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations: [
				{
					conversationId: "q1-a",
					sessionId: "q1::session_repeat",
					turns: [{ role: "user", body: "First user detail." }],
				},
				{
					conversationId: "q1-b",
					sessionId: "q1::session_repeat",
					turns: [
						{ role: "assistant", body: "Assistant detail." },
						{ role: "user", body: "Second user detail." },
					],
				},
			],
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([["q1::session_repeat", ["evt1", "evt2"]]]),
		})

		expect(docs).toHaveLength(1)
		expect(docs[0].sessionId).toBe("q1::session_repeat")
		expect(docs[0].text).toContain("First user detail.")
		expect(docs[0].text).toContain("Second user detail.")
		expect(docs[0].text).not.toContain("Assistant detail.")
		expect(docs[0].metadata.turnCount).toBe(2)
		expect(docs[0].metadata.sourceEventIds).toEqual(["evt1", "evt2"])
	})

	it("concatenates only user turns into the text field", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([
				["q1::session_1", ["evt1", "evt2", "evt3"]],
				["q1::session_2", ["evt4", "evt5"]],
			]),
		})
		// Session 1: user turns only
		expect(docs[0].text).toContain("I like pizza.")
		expect(docs[0].text).toContain("I also like pasta.")
		expect(docs[0].text).not.toContain("That's great!")
		// Session 2: user turns only
		expect(docs[1].text).toContain("My favorite color is blue.")
		expect(docs[1].text).not.toContain("Blue is nice.")
	})

	it("sets source to 'session-evidence' for all documents", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		for (const doc of docs) {
			expect(doc.source).toBe("session-evidence")
		}
	})

	it("sets stable path and provenance for benchmark traces", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		expect(docs[0].path).toBe("session_chunks/q1::session_1")
		expect(docs[0].provenance).toEqual({
			lane: "session_chunks",
			unit: "session",
			source: "session-evidence",
		})
	})

	it("preserves sourceEventIds from the event map", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([
				["q1::session_1", ["evt1", "evt2", "evt3"]],
				["q1::session_2", ["evt4", "evt5"]],
			]),
		})
		expect(docs[0].metadata.sourceEventIds).toEqual(["evt1", "evt2", "evt3"])
		expect(docs[1].metadata.sourceEventIds).toEqual(["evt4", "evt5"])
	})

	it("includes turnCount in metadata", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		// Session 1 has 2 user turns (assistant turns not counted)
		expect(docs[0].metadata.turnCount).toBe(2)
		// Session 2 has 1 user turn
		expect(docs[1].metadata.turnCount).toBe(1)
	})

	it("includes docType 'session' in metadata", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		for (const doc of docs) {
			expect(doc.metadata.docType).toBe("session")
		}
	})

	it("carries agentId, scope, scopeRef, and sessionId on each doc", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		expect(docs[0].agentId).toBe("bench-agent")
		expect(docs[0].scope).toBe("agent")
		expect(docs[0].scopeRef).toBe("agent:bench-agent")
		expect(docs[0].sessionId).toBe("q1::session_1")
		expect(docs[1].sessionId).toBe("q1::session_2")
	})

	it("truncates concatenated text to 8000 chars at sentence boundary", () => {
		// Build a conversation with enough text to exceed 8000 chars
		const longBody = "A".repeat(4000) + ". "
		const longConversations: MemoryBenchmarkConversation[] = [
			{
				conversationId: "q1",
				sessionId: "q1::session_long",
				turns: [
					{ role: "user", body: longBody },
					{ role: "user", body: longBody },
					{ role: "user", body: longBody }, // 3 * ~4002 = ~12006 chars
				],
			},
		]
		const docs = buildSessionEvidenceDocuments({
			conversations: longConversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		expect(docs[0].text.length).toBeLessThanOrEqual(8000)
	})

	it("sets canonicalId to session-chunk/{sessionId}", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		expect(docs[0].canonicalId).toBe("session-chunk/q1::session_1")
		expect(docs[1].canonicalId).toBe("session-chunk/q1::session_2")
	})
})

// ---------------------------------------------------------------------------
// writeSessionEvidenceOptionA — writes to chunks collection
// ---------------------------------------------------------------------------

describe("writeSessionEvidenceOptionA", () => {
	function mockCollection(): Collection {
		return {
			insertMany: vi.fn(async () => ({ insertedCount: 2 })),
		} as unknown as Collection
	}

	const conversations: MemoryBenchmarkConversation[] = [
		{
			conversationId: "q1",
			sessionId: "q1::session_1",
			turns: [
				{ role: "user", body: "I like pizza." },
				{ role: "assistant", body: "Great!" },
			],
		},
	]

	it("writes session docs to the provided chunks collection", async () => {
		const col = mockCollection()
		const count = await writeSessionEvidenceOptionA({
			chunksCollection: col,
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([["q1::session_1", ["evt1"]]]),
		})
		expect(count).toBe(1)
		expect(col.insertMany).toHaveBeenCalledTimes(1)
		const insertedDocs = (col.insertMany as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(insertedDocs[0].source).toBe("session-evidence")
	})

	it("returns 0 when no conversations have user turns", async () => {
		const col = mockCollection()
		const count = await writeSessionEvidenceOptionA({
			chunksCollection: col,
			conversations: [
				{
					conversationId: "q1",
					sessionId: "q1::s1",
					turns: [{ role: "assistant", body: "Just me." }],
				},
			],
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		expect(count).toBe(0)
		expect(col.insertMany).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// writeSessionEvidenceOptionB — writes to session_chunks collection
// ---------------------------------------------------------------------------

describe("writeSessionEvidenceOptionB", () => {
	function mockCollection(): Collection {
		return {
			insertMany: vi.fn(async () => ({ insertedCount: 2 })),
		} as unknown as Collection
	}

	const conversations: MemoryBenchmarkConversation[] = [
		{
			conversationId: "q1",
			sessionId: "q1::session_1",
			turns: [
				{ role: "user", body: "I like pizza." },
				{ role: "assistant", body: "Great!" },
			],
		},
	]

	it("writes session docs to the provided session_chunks collection", async () => {
		const col = mockCollection()
		const count = await writeSessionEvidenceOptionB({
			sessionChunksCollection: col,
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([["q1::session_1", ["evt1"]]]),
		})
		expect(count).toBe(1)
		expect(col.insertMany).toHaveBeenCalledTimes(1)
	})

	it("returns 0 when no session docs are generated", async () => {
		const col = mockCollection()
		const count = await writeSessionEvidenceOptionB({
			sessionChunksCollection: col,
			conversations: [],
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})
		expect(count).toBe(0)
		expect(col.insertMany).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// extractSessionIdFromCanonicalId
// ---------------------------------------------------------------------------

describe("extractSessionIdFromCanonicalId", () => {
	it("extracts session ID from session-chunk canonical ID", () => {
		expect(extractSessionIdFromCanonicalId("session-chunk/q1::session_1")).toBe(
			"q1::session_1",
		)
	})

	it("returns null for non-session-chunk canonical IDs", () => {
		expect(extractSessionIdFromCanonicalId("event:abc123")).toBeNull()
		expect(extractSessionIdFromCanonicalId("structured:xyz")).toBeNull()
	})

	it("returns null for undefined or empty", () => {
		expect(extractSessionIdFromCanonicalId(undefined)).toBeNull()
		expect(extractSessionIdFromCanonicalId("")).toBeNull()
	})

	it("returns null for session-chunk/ with empty session ID", () => {
		expect(extractSessionIdFromCanonicalId("session-chunk/")).toBeNull()
		expect(extractSessionIdFromCanonicalId("session-chunk/  ")).toBeNull()
	})
})
