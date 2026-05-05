import { describe, expect, it, vi } from "vitest"
import type { Collection } from "mongodb"
import type { MemoryBenchmarkConversation } from "./types.js"
import {
	buildUserfactEvidenceDocuments,
	extractSessionIdFromUserfactCanonicalId,
	extractUserfactFacts,
	resolveUserfactEvidenceMode,
	writeUserfactEvidence,
} from "./mongodb-userfact-evidence.js"

describe("resolveUserfactEvidenceMode", () => {
	it("returns none by default", () => {
		expect(resolveUserfactEvidenceMode(undefined)).toBe("none")
	})

	it("accepts enabled values from the new env var", () => {
		expect(resolveUserfactEvidenceMode("enabled")).toBe("enabled")
		expect(resolveUserfactEvidenceMode("TRUE")).toBe("enabled")
		expect(resolveUserfactEvidenceMode("1")).toBe("enabled")
	})

	it("falls back to the legacy preference env var", () => {
		expect(resolveUserfactEvidenceMode(undefined, "enabled")).toBe("enabled")
	})

	it("lets the new env var override the legacy alias", () => {
		expect(resolveUserfactEvidenceMode("none", "enabled")).toBe("none")
	})
})

describe("extractUserfactFacts", () => {
	it("extracts concise preference and userfact phrases from user text", () => {
		const facts = extractUserfactFacts(
			[
				"I just bought a Sony A7R IV camera.",
				"I'm looking for compatible flash units.",
				"I prefer Sony lenses.",
			].join(" "),
		)

		expect(facts).toContain("bought Sony A7R IV camera")
		expect(facts).toContain("looking for compatible flash units")
		expect(facts).toContain("prefers Sony lenses")
	})

	it("deduplicates repeated matches and caps the fact count", () => {
		const repeated = Array.from(
			{ length: 12 },
			(_, index) => `I want to plan trip number ${index}.`,
		).join(" ")
		const facts = extractUserfactFacts(repeated)
		expect(new Set(facts.map((fact) => fact.toLowerCase())).size).toBe(
			facts.length,
		)
		expect(facts.length).toBeLessThanOrEqual(10)
	})
})

describe("buildUserfactEvidenceDocuments", () => {
	const conversations: MemoryBenchmarkConversation[] = [
		{
			conversationId: "q1",
			sessionId: "q1::session_1",
			turns: [
				{
					role: "user",
					body: "I just bought a Sony A7R IV camera.",
					timestamp: "2025-01-10T10:00:00.000Z",
				},
				{ role: "assistant", body: "Nice camera." },
				{
					role: "user",
					body: "I'm looking for compatible flash units and I prefer Sony lenses.",
					timestamp: "2025-01-10T10:05:00.000Z",
				},
			],
		},
		{
			conversationId: "q1",
			sessionId: "q1::session_2",
			turns: [{ role: "assistant", body: "No user facts here." }],
		},
	]

	it("creates one userfact evidence document per matching session", () => {
		const docs = buildUserfactEvidenceDocuments({
			conversations,
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([["q1::session_1", ["evt-1", "evt-2"]]]),
		})

		expect(docs).toHaveLength(1)
		expect(docs[0]?.source).toBe("userfact-evidence")
		expect(docs[0]?.canonicalId).toBe("userfact-chunk/q1::session_1")
		expect(docs[0]?.sessionId).toBe("q1::session_1")
		expect(docs[0]?.metadata.docType).toBe("userfact")
		expect(docs[0]?.metadata.extractedFacts).toBeGreaterThanOrEqual(3)
		expect(docs[0]?.metadata.turnCount).toBe(2)
		expect(docs[0]?.metadata.sourceEventIds).toEqual(["evt-1", "evt-2"])
		expect(docs[0]?.text).toContain("User has mentioned:")
		expect(docs[0]?.text).toContain("bought Sony A7R IV camera")
		expect(docs[0]?.text).not.toContain("Nice camera.")
		expect(docs[0]?.timestamp.toISOString()).toBe("2025-01-10T10:00:00.000Z")
	})
})

describe("writeUserfactEvidence", () => {
	function mockCollection(): Collection {
		return {
			insertMany: vi.fn(async () => ({ insertedCount: 1 })),
		} as unknown as Collection
	}

	it("writes userfact evidence docs into the chunks collection", async () => {
		const chunksCollection = mockCollection()
		const count = await writeUserfactEvidence({
			chunksCollection,
			conversations: [
				{
					conversationId: "q1",
					sessionId: "q1::session_1",
					turns: [
						{
							role: "user",
							body: "I need battery life tips for my iPhone 13 Pro.",
						},
					],
				},
			],
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map([["q1::session_1", ["evt-1"]]]),
		})

		expect(count).toBe(1)
		expect(chunksCollection.insertMany).toHaveBeenCalledTimes(1)
	})

	it("returns 0 when no userfact evidence is produced", async () => {
		const chunksCollection = mockCollection()
		const count = await writeUserfactEvidence({
			chunksCollection,
			conversations: [
				{
					conversationId: "q1",
					sessionId: "q1::session_1",
					turns: [{ role: "assistant", body: "Nothing extractable." }],
				},
			],
			agentId: "bench-agent",
			scope: "agent",
			scopeRef: "agent:bench-agent",
			eventIds: new Map(),
		})

		expect(count).toBe(0)
		expect(chunksCollection.insertMany).not.toHaveBeenCalled()
	})
})

describe("extractSessionIdFromUserfactCanonicalId", () => {
	it("extracts the session id from userfact-chunk canonical ids", () => {
		expect(
			extractSessionIdFromUserfactCanonicalId("userfact-chunk/q1::session_1"),
		).toBe("q1::session_1")
	})

	it("returns null for non-userfact canonical ids", () => {
		expect(
			extractSessionIdFromUserfactCanonicalId("session-chunk/q1"),
		).toBeNull()
		expect(extractSessionIdFromUserfactCanonicalId(undefined)).toBeNull()
	})
})
