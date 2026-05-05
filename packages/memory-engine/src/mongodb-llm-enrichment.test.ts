import { describe, expect, it, vi } from "vitest"
import {
	resolveEnrichmentMode,
	resolveEnrichmentProvider,
	createHttpProvider,
	extractSessionEnrichment,
	buildEnrichedUserfactDocument,
	buildQaEvidenceDocument,
	enrichSessionsWithLLM,
	EnrichmentHttpError,
	ENRICHMENT_SYSTEM_PROMPT,
	type EnrichmentMode,
	type EnrichmentProvider,
	type EnrichmentResult,
} from "./mongodb-llm-enrichment.js"

describe("resolveEnrichmentMode", () => {
	it("returns 'none' by default", () => {
		expect(resolveEnrichmentMode(undefined)).toBe("none")
	})

	it("returns 'enabled' for explicit enabled value", () => {
		expect(resolveEnrichmentMode("enabled")).toBe("enabled")
	})

	it("returns 'facts-only' for facts-only value", () => {
		expect(resolveEnrichmentMode("facts-only")).toBe("facts-only")
	})

	it("returns 'none' for none value", () => {
		expect(resolveEnrichmentMode("none")).toBe("none")
	})

	it("returns 'none' for unrecognized values", () => {
		expect(resolveEnrichmentMode("bogus")).toBe("none")
	})

	it("handles case-insensitive input", () => {
		expect(resolveEnrichmentMode("ENABLED")).toBe("enabled")
		expect(resolveEnrichmentMode("Facts-Only")).toBe("facts-only")
	})
})

describe("resolveEnrichmentProvider", () => {
	it("returns null when no API key is available", () => {
		const provider = resolveEnrichmentProvider({})
		expect(provider).toBeNull()
	})

	it("creates provider from explicit config", () => {
		const provider = resolveEnrichmentProvider({
			MEMONGO_ENRICHMENT_API_KEY: "test-key-123",
			MEMONGO_ENRICHMENT_BASE_URL: "https://example.com/v1",
			MEMONGO_ENRICHMENT_MODEL: "gpt-4o-mini",
		})
		expect(provider).not.toBeNull()
		expect(provider!.name).toBe("http")
	})

	it("falls back to GROVE_API_KEY", () => {
		const provider = resolveEnrichmentProvider({
			GROVE_API_KEY: "grove-key-123",
		})
		expect(provider).not.toBeNull()
		expect(provider!.name).toBe("http")
	})

	it("uses default Grove base URL when not specified", () => {
		const provider = resolveEnrichmentProvider({
			MEMONGO_ENRICHMENT_API_KEY: "test-key",
		})
		expect(provider).not.toBeNull()
	})
})

describe("createHttpProvider", () => {
	it("sends request with api-key header and returns parsed content", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [
					{
						message: {
							content:
								'{"facts":[],"qa_pairs":[],"has_personal_content":false}',
						},
					},
				],
			}),
		})

		const provider = createHttpProvider(
			{
				baseUrl: "https://example.com/v1",
				apiKey: "test-key",
				model: "gpt-4o-mini",
			},
			mockFetch as unknown as typeof globalThis.fetch,
		)

		const result = await provider.chatCompletion({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: "test" }],
			responseFormat: { type: "json_object" },
		})

		expect(result.content).toBe(
			'{"facts":[],"qa_pairs":[],"has_personal_content":false}',
		)
		expect(mockFetch).toHaveBeenCalledTimes(1)

		const [url, options] = mockFetch.mock.calls[0]
		expect(url).toBe("https://example.com/v1/chat/completions")
		expect(options.headers["api-key"]).toBe("test-key")
		// Must NOT use Authorization: Bearer
		expect(options.headers.Authorization).toBeUndefined()
	})

	it("throws on non-ok response", async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "Internal Server Error",
		})

		const provider = createHttpProvider(
			{
				baseUrl: "https://example.com/v1",
				apiKey: "test-key",
				model: "gpt-4o-mini",
			},
			mockFetch as unknown as typeof globalThis.fetch,
		)

		await expect(
			provider.chatCompletion({
				model: "gpt-4o-mini",
				messages: [{ role: "user", content: "test" }],
			}),
		).rejects.toThrow("500")
	})
})

describe("extractSessionEnrichment", () => {
	function mockProvider(content: string): EnrichmentProvider {
		return {
			name: "mock",
			chatCompletion: vi.fn().mockResolvedValue({ content }),
		}
	}

	it("parses valid LLM JSON response with facts and QA pairs", async () => {
		const provider = mockProvider(
			JSON.stringify({
				facts: ["The user grows cherry tomatoes", "The user uses fresh basil"],
				qa_pairs: [
					{
						q: "What ingredients does the user have?",
						a: "Cherry tomatoes and basil",
					},
				],
				has_personal_content: true,
			}),
		)

		const result = await extractSessionEnrichment(
			provider,
			"I've been growing cherry tomatoes and basil in my garden",
			"gpt-4o-mini",
		)

		expect(result.facts).toEqual([
			"The user grows cherry tomatoes",
			"The user uses fresh basil",
		])
		expect(result.qaPairs).toEqual([
			{
				q: "What ingredients does the user have?",
				a: "Cherry tomatoes and basil",
			},
		])
		expect(result.hasPersonalContent).toBe(true)
	})

	it("returns empty result for invalid JSON", async () => {
		const provider = mockProvider("not valid json at all")

		const result = await extractSessionEnrichment(
			provider,
			"hello world",
			"gpt-4o-mini",
		)

		expect(result.facts).toEqual([])
		expect(result.qaPairs).toEqual([])
		expect(result.hasPersonalContent).toBe(false)
	})

	it("returns empty result when LLM returns empty arrays", async () => {
		const provider = mockProvider(
			JSON.stringify({
				facts: [],
				qa_pairs: [],
				has_personal_content: false,
			}),
		)

		const result = await extractSessionEnrichment(
			provider,
			"just chatting about nothing",
			"gpt-4o-mini",
		)

		expect(result.facts).toEqual([])
		expect(result.qaPairs).toEqual([])
		expect(result.hasPersonalContent).toBe(false)
	})

	it("filters out non-string facts and invalid QA pairs", async () => {
		const provider = mockProvider(
			JSON.stringify({
				facts: ["Valid fact", 123, null, "Another valid fact"],
				qa_pairs: [
					{ q: "Good question?", a: "Good answer" },
					{ q: "", a: "Missing question" },
					{ q: "No answer" },
					"not an object",
				],
				has_personal_content: true,
			}),
		)

		const result = await extractSessionEnrichment(
			provider,
			"test input",
			"gpt-4o-mini",
		)

		expect(result.facts).toEqual(["Valid fact", "Another valid fact"])
		expect(result.qaPairs).toEqual([{ q: "Good question?", a: "Good answer" }])
	})

	it("strips markdown code fences before parsing JSON", async () => {
		const inner = JSON.stringify({
			facts: ["The user likes hiking"],
			qa_pairs: [],
			has_personal_content: true,
		})
		const fenced = "```json\n" + inner + "\n```"
		const provider = mockProvider(fenced)

		const result = await extractSessionEnrichment(
			provider,
			"I like hiking",
			"gpt-4o-mini",
		)

		expect(result.facts).toEqual(["The user likes hiking"])
		expect(result.hasPersonalContent).toBe(true)
	})

	it("logs warning on JSON parse failure with first 200 chars of content", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const provider = mockProvider("<html>Error page from gateway</html>")

		const result = await extractSessionEnrichment(
			provider,
			"hello",
			"gpt-4o-mini",
		)

		expect(result.facts).toEqual([])
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const warnMsg = warnSpy.mock.calls[0][0] as string
		expect(warnMsg).toContain("LLM enrichment JSON parse failed")
		expect(warnMsg).toContain("<html>Error page")
		warnSpy.mockRestore()
	})

	it("passes system prompt and session text to provider", async () => {
		const chatCompletion = vi.fn().mockResolvedValue({
			content: JSON.stringify({
				facts: [],
				qa_pairs: [],
				has_personal_content: false,
			}),
		})
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion,
		}

		await extractSessionEnrichment(
			provider,
			"My session text here",
			"gpt-4o-mini",
		)

		expect(chatCompletion).toHaveBeenCalledWith({
			model: "gpt-4o-mini",
			messages: [
				{ role: "system", content: ENRICHMENT_SYSTEM_PROMPT },
				{ role: "user", content: "My session text here" },
			],
			responseFormat: { type: "json_object" },
			maxTokens: 1024,
		})
	})
})

describe("buildEnrichedUserfactDocument", () => {
	it("creates userfact-evidence doc with LLM metadata", () => {
		const now = new Date("2026-01-15T10:00:00Z")
		const doc = buildEnrichedUserfactDocument({
			facts: ["The user grows cherry tomatoes", "The user uses fresh basil"],
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			sessionId: "session-abc",
			sourceEventIds: ["ev1", "ev2"],
			turnCount: 5,
			timestamp: now,
		})

		expect(doc.source).toBe("userfact-evidence")
		expect(doc.agentId).toBe("agent-1")
		expect(doc.sessionId).toBe("session-abc")
		expect(doc.canonicalId).toBe("userfact-chunk/session-abc")
		expect(doc.status).toBe("active")
		expect(doc.metadata.docType).toBe("userfact")
		expect(doc.metadata.extractionMethod).toBe("llm")
		expect(doc.metadata.extractedFacts).toBe(2)
		expect(doc.metadata.turnCount).toBe(5)
		expect(doc.metadata.sourceEventIds).toEqual(["ev1", "ev2"])
		expect(doc.text).toContain("cherry tomatoes")
		expect(doc.text).toContain("fresh basil")
	})

	it("caps facts at MAX_ENRICHED_FACTS (10) and truncates long fact text at MAX_ENRICHED_DOC_CHARS (700)", () => {
		const now = new Date("2026-01-15T10:00:00Z")
		const longFacts = Array.from(
			{ length: 15 },
			(_, i) => `Fact number ${i + 1}`,
		)
		const doc = buildEnrichedUserfactDocument({
			facts: longFacts,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			sessionId: "session-abc",
			sourceEventIds: ["ev1"],
			turnCount: 5,
			timestamp: now,
		})

		expect(doc).not.toBeNull()
		// Only first 10 facts are kept
		expect(doc!.metadata.extractedFacts).toBe(10)
		// Text must not exceed 700 chars
		expect(doc!.text.length).toBeLessThanOrEqual(700)
	})

	it("truncates individual fact text to 700 chars max in the combined text", () => {
		const now = new Date("2026-01-15T10:00:00Z")
		const longFact = "A".repeat(800)
		const doc = buildEnrichedUserfactDocument({
			facts: [longFact],
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			sessionId: "session-abc",
			sourceEventIds: ["ev1"],
			turnCount: 1,
			timestamp: now,
		})

		expect(doc).not.toBeNull()
		expect(doc!.text.length).toBeLessThanOrEqual(700)
	})

	it("returns null when no facts provided", () => {
		const doc = buildEnrichedUserfactDocument({
			facts: [],
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			sessionId: "session-abc",
			sourceEventIds: [],
			turnCount: 0,
			timestamp: new Date(),
		})

		expect(doc).toBeNull()
	})
})

describe("buildQaEvidenceDocument", () => {
	it("creates qa-evidence doc with QA pair text", () => {
		const now = new Date("2026-01-15T10:00:00Z")
		const doc = buildQaEvidenceDocument({
			qaPairs: [
				{
					q: "What ingredients does the user have?",
					a: "Cherry tomatoes and basil",
				},
				{
					q: "What should the user serve?",
					a: "Dishes with fresh produce",
				},
			],
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			sessionId: "session-abc",
			sourceEventIds: ["ev1"],
			turnCount: 3,
			timestamp: now,
		})

		expect(doc).not.toBeNull()
		expect(doc!.source).toBe("qa-evidence")
		expect(doc!.canonicalId).toBe("qa-chunk/session-abc")
		expect(doc!.metadata.docType).toBe("qa")
		expect(doc!.metadata.extractionMethod).toBe("llm")
		expect(doc!.metadata.qaPairs).toBe(2)
		expect(doc!.text).toContain("Q: What ingredients does the user have?")
		expect(doc!.text).toContain("A: Cherry tomatoes and basil")
		expect(doc!.text).toContain("Q: What should the user serve?")
	})

	it("caps QA pairs at 10 and truncates text to 700 chars", () => {
		const now = new Date("2026-01-15T10:00:00Z")
		const manyPairs = Array.from({ length: 15 }, (_, i) => ({
			q: `Question ${i + 1}?`,
			a: `Answer ${i + 1}`,
		}))
		const doc = buildQaEvidenceDocument({
			qaPairs: manyPairs,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			sessionId: "session-abc",
			sourceEventIds: ["ev1"],
			turnCount: 3,
			timestamp: now,
		})

		expect(doc).not.toBeNull()
		expect(doc!.metadata.qaPairs).toBeLessThanOrEqual(10)
		expect(doc!.text.length).toBeLessThanOrEqual(700)
	})

	it("returns null when no QA pairs provided", () => {
		const doc = buildQaEvidenceDocument({
			qaPairs: [],
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			sessionId: "session-abc",
			sourceEventIds: [],
			turnCount: 0,
			timestamp: new Date(),
		})

		expect(doc).toBeNull()
	})
})

describe("enrichSessionsWithLLM", () => {
	function buildConversation(
		sessionId: string,
		turns: Array<{ role: "user" | "assistant"; body: string }>,
	) {
		return {
			conversationId: "conv-1",
			sessionId,
			turns: turns.map((t) => ({
				role: t.role,
				body: t.body,
				timestamp: "2026-01-15T10:00:00Z",
			})),
		}
	}

	it("produces userfact and qa-evidence docs for enriched sessions", async () => {
		const enrichmentResponse: EnrichmentResult = {
			facts: ["The user grows tomatoes"],
			qaPairs: [{ q: "What does the user grow?", a: "Tomatoes" }],
			hasPersonalContent: true,
		}
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					facts: enrichmentResponse.facts,
					qa_pairs: enrichmentResponse.qaPairs,
					has_personal_content: true,
				}),
			}),
		}

		const conversations = [
			buildConversation("s1", [
				{ role: "user", body: "I grow tomatoes" },
				{ role: "assistant", body: "Nice!" },
			]),
		]
		const eventIds = new Map([["s1", ["ev1", "ev2"]]])

		const result = await enrichSessionsWithLLM({
			provider,
			model: "gpt-4o-mini",
			mode: "enabled",
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			eventIds,
		})

		expect(result.userfactDocs.length).toBe(1)
		expect(result.qaDocs.length).toBe(1)
		expect(result.sessionsEnriched).toBe(1)
		expect(result.sessionsFailed).toBe(0)
		expect(result.userfactDocs[0].metadata.extractionMethod).toBe("llm")
		expect(result.qaDocs[0].source).toBe("qa-evidence")
	})

	it("produces only userfact docs in facts-only mode", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					facts: ["The user likes running"],
					qa_pairs: [{ q: "Hobby?", a: "Running" }],
					has_personal_content: true,
				}),
			}),
		}

		const conversations = [
			buildConversation("s1", [{ role: "user", body: "I like running" }]),
		]
		const eventIds = new Map([["s1", ["ev1"]]])

		const result = await enrichSessionsWithLLM({
			provider,
			model: "gpt-4o-mini",
			mode: "facts-only",
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			eventIds,
		})

		expect(result.userfactDocs.length).toBe(1)
		expect(result.qaDocs.length).toBe(0)
	})

	it("returns failedSessionIds for sessions where LLM failed", async () => {
		let callCount = 0
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn().mockImplementation(async () => {
				callCount++
				if (callCount <= 2) {
					// First two calls (s1, s2) fail
					throw new Error("LLM down")
				}
				// Third call (s3) succeeds
				return {
					content: JSON.stringify({
						facts: ["The user likes tea"],
						qa_pairs: [],
						has_personal_content: true,
					}),
				}
			}),
		}

		const conversations = [
			buildConversation("s1", [{ role: "user", body: "hello" }]),
			buildConversation("s2", [{ role: "user", body: "hi" }]),
			buildConversation("s3", [{ role: "user", body: "I like tea" }]),
		]
		const eventIds = new Map([
			["s1", ["ev1"]],
			["s2", ["ev2"]],
			["s3", ["ev3"]],
		])

		const result = await enrichSessionsWithLLM({
			provider,
			model: "gpt-4o-mini",
			mode: "enabled",
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			eventIds,
			concurrency: 1,
		})

		expect(result.sessionsFailed).toBe(2)
		expect(result.sessionsEnriched).toBe(1)
		expect(result.failedSessionIds).toEqual(["s1", "s2"])
		expect(result.userfactDocs.length).toBe(1)
	})

	it("counts failed sessions when LLM throws", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn().mockRejectedValue(new Error("LLM down")),
		}

		const conversations = [
			buildConversation("s1", [{ role: "user", body: "hello" }]),
		]
		const eventIds = new Map([["s1", ["ev1"]]])

		const result = await enrichSessionsWithLLM({
			provider,
			model: "gpt-4o-mini",
			mode: "enabled",
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			eventIds,
		})

		expect(result.userfactDocs.length).toBe(0)
		expect(result.qaDocs.length).toBe(0)
		expect(result.sessionsEnriched).toBe(0)
		expect(result.sessionsFailed).toBe(1)
	})

	it("retries on AbortError (timeout) by wrapping as 408", async () => {
		let callCount = 0
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn().mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					const err = new DOMException(
						"The operation was aborted",
						"AbortError",
					)
					throw err
				}
				return {
					content: JSON.stringify({
						facts: ["The user likes tea"],
						qa_pairs: [],
						has_personal_content: true,
					}),
				}
			}),
		}

		const conversations = [
			buildConversation("s1", [{ role: "user", body: "I like tea" }]),
		]
		const eventIds = new Map([["s1", ["ev1"]]])

		const result = await enrichSessionsWithLLM({
			provider,
			model: "gpt-4o-mini",
			mode: "enabled",
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			eventIds,
		})

		expect(result.userfactDocs.length).toBe(1)
		expect(result.sessionsEnriched).toBe(1)
		expect(callCount).toBe(2)
	})

	it("retries on 429 status and succeeds", async () => {
		let callCount = 0
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn().mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					throw new EnrichmentHttpError("Rate limited", 429)
				}
				return {
					content: JSON.stringify({
						facts: ["The user drinks coffee"],
						qa_pairs: [],
						has_personal_content: true,
					}),
				}
			}),
		}

		const conversations = [
			buildConversation("s1", [{ role: "user", body: "I drink coffee" }]),
		]
		const eventIds = new Map([["s1", ["ev1"]]])

		const result = await enrichSessionsWithLLM({
			provider,
			model: "gpt-4o-mini",
			mode: "enabled",
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			eventIds,
		})

		expect(result.userfactDocs.length).toBe(1)
		expect(result.sessionsEnriched).toBe(1)
		expect(callCount).toBe(2)
	})

	it("skips sessions with no user turns", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn().mockResolvedValue({
				content: JSON.stringify({
					facts: [],
					qa_pairs: [],
					has_personal_content: false,
				}),
			}),
		}

		const conversations = [
			buildConversation("s1", [{ role: "assistant", body: "Hello there!" }]),
		]
		const eventIds = new Map([["s1", ["ev1"]]])

		const result = await enrichSessionsWithLLM({
			provider,
			model: "gpt-4o-mini",
			mode: "enabled",
			conversations,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "ref-1",
			eventIds,
		})

		expect(result.userfactDocs.length).toBe(0)
		expect(result.qaDocs.length).toBe(0)
		expect(result.sessionsEnriched).toBe(0)
		// Not a failure — just skipped
		expect(result.sessionsFailed).toBe(0)
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})
})
