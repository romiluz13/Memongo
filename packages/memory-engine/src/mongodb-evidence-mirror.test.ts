import { describe, expect, it, vi } from "vitest"
import {
	buildMemoryEvidenceDocuments,
	isEvidenceMirrorEnabled,
	resolveEvidenceMirrorMode,
	writeMemoryEvidenceDocuments,
} from "./mongodb-evidence-mirror.js"
import type { MemoryBenchmarkConversation } from "./types.js"

const conversations: MemoryBenchmarkConversation[] = [
	{
		conversationId: "conv-1",
		sessionId: "session-1",
		turns: [
			{
				role: "user",
				body: "I prefer spicy Thai food when we order dinner. My camera is a Fuji X-T5.",
				timestamp: "2026-05-01T10:00:00.000Z",
			},
			{
				role: "assistant",
				body: "Noted. I will suggest spicy Thai options and Fuji accessories.",
				timestamp: "2026-05-01T10:01:00.000Z",
			},
		],
	},
]

describe("evidence mirror mode", () => {
	it("is opt-in only", () => {
		expect(resolveEvidenceMirrorMode(undefined)).toBe("disabled")
		expect(resolveEvidenceMirrorMode("disabled")).toBe("disabled")
		expect(resolveEvidenceMirrorMode("enabled")).toBe("enabled")
		expect(resolveEvidenceMirrorMode("1")).toBe("enabled")
		expect(
			isEvidenceMirrorEnabled({ MEMONGO_EVIDENCE_MIRROR_MODE: "true" }),
		).toBe(true)
	})
})

describe("buildMemoryEvidenceDocuments", () => {
	it("creates session, temporal, assistant, preference, and userfact units", () => {
		const docs = buildMemoryEvidenceDocuments({
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
			eventIds: new Map([["session-1", ["event-1", "event-2"]]]),
		})

		expect(docs.map((doc) => doc.unit)).toEqual(
			expect.arrayContaining([
				"session",
				"temporal_anchor",
				"assistant",
				"preference",
			]),
		)
		expect(docs.every((doc) => doc.source === "conversation")).toBe(true)
		expect(docs.every((doc) => doc.status === "active")).toBe(true)
		expect(docs.every((doc) => doc.sourceEventIds.length === 2)).toBe(true)
		expect(docs[0]?.provenance).toMatchObject({
			lane: "memory-evidence",
			builder: "benchmark-fast-ingest",
		})
	})

	it("uses stable canonical ids and deduplicates repeated evidence", () => {
		const docs = buildMemoryEvidenceDocuments({
			conversations: [
				{
					sessionId: "session-1",
					turns: [
						{
							role: "user",
							body: "I prefer spicy Thai food. I prefer spicy Thai food.",
						},
					],
				},
			],
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
			eventIds: new Map([["session-1", ["event-1"]]]),
		})
		const preferenceDocs = docs.filter((doc) => doc.unit === "preference")
		expect(preferenceDocs).toHaveLength(1)
		expect(preferenceDocs[0]?.canonicalId).toMatch(
			/^memory-evidence\/preference:session-1:/,
		)
	})
})

describe("writeMemoryEvidenceDocuments", () => {
	it("bulk inserts generated docs and returns the inserted count", async () => {
		const insertMany = vi.fn(async () => ({ acknowledged: true }))
		const count = await writeMemoryEvidenceDocuments({
			collection: { insertMany } as never,
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
			eventIds: new Map([["session-1", ["event-1", "event-2"]]]),
		})

		expect(count).toBeGreaterThan(0)
		expect(insertMany).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ unit: "session", sessionId: "session-1" }),
			]),
			{ ordered: false },
		)
	})
})
