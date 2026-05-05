import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { withMemongo, _clearCache, type MemongoCoreOptions } from "./index.js"
import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
} from "@ai-sdk/provider"

const BASE_OPTIONS: MemongoCoreOptions = {
	apiUrl: "http://localhost:3847",
	apiKey: "test-key",
	userId: "user-1",
	agentId: "agent-1",
}

function createMockModel(): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		defaultObjectGenerationMode: "json",
		provider: "test-provider",
		modelId: "test-model",
		doGenerate: vi.fn().mockResolvedValue({
			content: [{ type: "text" as const, text: "Hello from LLM" }],
			finishReason: "stop" as const,
			usage: { inputTokens: 10, outputTokens: 5 },
			warnings: [],
		}),
		doStream: vi.fn(),
	}
}

describe("withMemongo (Vercel AI SDK middleware)", () => {
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		globalThis.fetch = vi.fn()
		_clearCache()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	function mockFetchForContextBundle(
		rendered = "You are a helpful AI with memory.",
	) {
		const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ rendered }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		return mockFetch
	}

	it("injects memory context into the system prompt", async () => {
		mockFetchForContextBundle()

		const model = createMockModel()
		const wrapped = withMemongo(model, BASE_OPTIONS)

		const params: LanguageModelV2CallOptions = {
			prompt: [
				{
					role: "user",
					content: [{ type: "text", text: "What did we discuss?" }],
				},
			],
			inputFormat: "prompt",
			mode: { type: "regular" },
		}

		await wrapped.doGenerate(params)

		// The middleware should have called the underlying model's doGenerate
		const innerDoGenerate = model.doGenerate as ReturnType<typeof vi.fn>
		expect(innerDoGenerate).toHaveBeenCalledTimes(1)

		// Check that system prompt was prepended
		const calledParams = innerDoGenerate.mock
			.calls[0][0] as LanguageModelV2CallOptions
		const firstMessage = calledParams.prompt[0]
		expect(firstMessage.role).toBe("system")
		expect(
			(firstMessage as { role: "system"; content: string }).content,
		).toContain("[Memory Context]")
		expect(
			(firstMessage as { role: "system"; content: string }).content,
		).toContain("You are a helpful AI with memory.")
	})

	it("saves user and assistant messages as events after generate", async () => {
		const mockFetch = mockFetchForContextBundle()

		const model = createMockModel()
		const wrapped = withMemongo(model, BASE_OPTIONS)

		const params: LanguageModelV2CallOptions = {
			prompt: [
				{
					role: "user",
					content: [{ type: "text", text: "Tell me about dogs" }],
				},
			],
			inputFormat: "prompt",
			mode: { type: "regular" },
		}

		await wrapped.doGenerate(params)

		// Wait for fire-and-forget to flush
		await new Promise((r) => setTimeout(r, 50))

		// Should have called fetch 3 times: context-bundle + write-event (user) + write-event (assistant)
		expect(mockFetch).toHaveBeenCalledTimes(3)

		// Check user write-event
		const userCall = mockFetch.mock.calls.find(
			(call: unknown[]) =>
				String(call[0]).includes("/v1/write-event") &&
				String(call[1]?.body ?? "").includes('"user"'),
		)
		expect(userCall).toBeDefined()
		const userBody = JSON.parse(userCall![1].body)
		expect(userBody.role).toBe("user")
		expect(userBody.body).toBe("Tell me about dogs")

		// Check assistant write-event
		const assistantCall = mockFetch.mock.calls.find(
			(call: unknown[]) =>
				String(call[0]).includes("/v1/write-event") &&
				String(call[1]?.body ?? "").includes('"assistant"'),
		)
		expect(assistantCall).toBeDefined()
		const assistantBody = JSON.parse(assistantCall![1].body)
		expect(assistantBody.role).toBe("assistant")
		expect(assistantBody.body).toBe("Hello from LLM")
	})

	it("uses LRU cache on second identical call", async () => {
		const mockFetch = mockFetchForContextBundle()

		const model = createMockModel()
		const wrapped = withMemongo(model, BASE_OPTIONS)

		const params: LanguageModelV2CallOptions = {
			prompt: [
				{
					role: "user",
					content: [{ type: "text", text: "Same question" }],
				},
			],
			inputFormat: "prompt",
			mode: { type: "regular" },
		}

		// First call — should hit the API
		await wrapped.doGenerate(params)
		await new Promise((r) => setTimeout(r, 50))

		const callsAfterFirst = mockFetch.mock.calls.filter((call: unknown[]) =>
			String(call[0]).includes("/v1/context-bundle"),
		).length
		expect(callsAfterFirst).toBe(1)

		// Reset mock to track new calls
		mockFetch.mockClear()
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({}), { status: 200 }),
		)

		// Second call with same query — should use cache, no new context-bundle fetch
		await wrapped.doGenerate(params)
		await new Promise((r) => setTimeout(r, 50))

		const contextBundleCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
			String(call[0]).includes("/v1/context-bundle"),
		).length
		expect(contextBundleCalls).toBe(0)
	})

	it("uses wake-up mode by default when no user query is present", async () => {
		const mockFetch = mockFetchForContextBundle()

		const model = createMockModel()
		// No explicit mode in options => should default to "wake-up"
		const wrapped = withMemongo(model, {
			...BASE_OPTIONS,
			mode: undefined,
		})

		// Prompt with no user message (only system) — no query to trigger "full"
		const params: LanguageModelV2CallOptions = {
			prompt: [
				{
					role: "system",
					content: "You are a test assistant.",
				},
			],
			inputFormat: "prompt",
			mode: { type: "regular" },
		}

		await wrapped.doGenerate(params)

		// The context-bundle call should use mode: "wake-up" since no user query
		const bundleCall = mockFetch.mock.calls.find((call: unknown[]) =>
			String(call[0]).includes("/v1/context-bundle"),
		)
		expect(bundleCall).toBeDefined()
		const body = JSON.parse(bundleCall![1].body)
		expect(body.mode).toBe("wake-up")
	})

	it("gracefully degrades when API returns 500", async () => {
		const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
		mockFetch.mockResolvedValue(
			new Response("Internal Server Error", { status: 500 }),
		)

		const model = createMockModel()
		const wrapped = withMemongo(model, BASE_OPTIONS)

		const params: LanguageModelV2CallOptions = {
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
			inputFormat: "prompt",
			mode: { type: "regular" },
		}

		// LLM call should succeed even when Memongo API is down
		const result = await wrapped.doGenerate(params)
		expect(result.content).toEqual([{ type: "text", text: "Hello from LLM" }])

		// No memory context injected — prompt should NOT have system message
		const innerDoGenerate = model.doGenerate as ReturnType<typeof vi.fn>
		const calledParams = innerDoGenerate.mock
			.calls[0][0] as LanguageModelV2CallOptions
		expect(calledParams.prompt[0].role).toBe("user")
	})

	it("gracefully degrades when fetch throws (network error)", async () => {
		const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"))

		const model = createMockModel()
		const wrapped = withMemongo(model, BASE_OPTIONS)

		const params: LanguageModelV2CallOptions = {
			prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
			inputFormat: "prompt",
			mode: { type: "regular" },
		}

		// LLM call should succeed despite network error
		const result = await wrapped.doGenerate(params)
		expect(result.content).toEqual([{ type: "text", text: "Hello from LLM" }])
	})

	it("upgrades to full mode when user query is present", async () => {
		const mockFetch = mockFetchForContextBundle()

		const model = createMockModel()
		const wrapped = withMemongo(model, {
			...BASE_OPTIONS,
			mode: undefined,
		})

		const params: LanguageModelV2CallOptions = {
			prompt: [
				{
					role: "user",
					content: [{ type: "text", text: "What happened yesterday?" }],
				},
			],
			inputFormat: "prompt",
			mode: { type: "regular" },
		}

		await wrapped.doGenerate(params)

		const bundleCall = mockFetch.mock.calls.find((call: unknown[]) =>
			String(call[0]).includes("/v1/context-bundle"),
		)
		expect(bundleCall).toBeDefined()
		const body = JSON.parse(bundleCall![1].body)
		expect(body.mode).toBe("full")
		expect(body.query).toBe("What happened yesterday?")
	})
})
