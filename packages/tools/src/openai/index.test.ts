import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { createOpenAIMiddleware } from "./index.js"
import type { MemongoCoreOptions } from "../vercel/index.js"

const BASE_OPTIONS: MemongoCoreOptions = {
	apiUrl: "http://localhost:3847",
	apiKey: "test-key",
	userId: "user-1",
	agentId: "agent-1",
}

function createMockOpenAIClient() {
	const mockCreate = vi.fn().mockResolvedValue({
		id: "chatcmpl-123",
		choices: [
			{
				message: {
					role: "assistant",
					content: "Hello from OpenAI",
				},
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	})

	return {
		chat: {
			completions: {
				create: mockCreate,
			},
		},
		models: {
			list: vi.fn().mockResolvedValue({ data: [] }),
		},
	}
}

describe("createOpenAIMiddleware (OpenAI SDK middleware)", () => {
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		globalThis.fetch = vi.fn()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	function mockFetchForContextBundle(rendered = "Memory context here.") {
		const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ rendered }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		return mockFetch
	}

	it("injects system message before create call", async () => {
		mockFetchForContextBundle()

		const client = createMockOpenAIClient()
		const proxied = createOpenAIMiddleware(client as any, BASE_OPTIONS)

		await proxied.chat.completions.create({
			model: "gpt-4",
			messages: [{ role: "user", content: "What do you remember?" }],
		})

		const mockCreate = client.chat.completions.create
		expect(mockCreate).toHaveBeenCalledTimes(1)

		const callArgs = mockCreate.mock.calls[0][0]
		// First message should be the injected system message
		expect(callArgs.messages[0].role).toBe("system")
		expect(callArgs.messages[0].content).toContain("[Memory Context]")
		expect(callArgs.messages[0].content).toContain("Memory context here.")
		// Original user message should follow
		expect(callArgs.messages[1].role).toBe("user")
		expect(callArgs.messages[1].content).toBe("What do you remember?")
	})

	it("saves assistant response as event after create", async () => {
		const mockFetch = mockFetchForContextBundle()

		const client = createMockOpenAIClient()
		const proxied = createOpenAIMiddleware(client as any, BASE_OPTIONS)

		await proxied.chat.completions.create({
			model: "gpt-4",
			messages: [{ role: "user", content: "Greet me" }],
		})

		// Wait for fire-and-forget
		await new Promise((r) => setTimeout(r, 50))

		// Should have 3 fetch calls: context-bundle + user write-event + assistant write-event
		expect(mockFetch).toHaveBeenCalledTimes(3)

		const assistantCall = mockFetch.mock.calls.find(
			(call: unknown[]) =>
				String(call[0]).includes("/v1/write-event") &&
				String(call[1]?.body ?? "").includes('"assistant"'),
		)
		expect(assistantCall).toBeDefined()
		const body = JSON.parse(assistantCall![1].body)
		expect(body.role).toBe("assistant")
		expect(body.body).toBe("Hello from OpenAI")
	})

	it("preserves original client methods outside chat.completions.create", async () => {
		mockFetchForContextBundle()

		const client = createMockOpenAIClient()
		const proxied = createOpenAIMiddleware(client as any, BASE_OPTIONS)

		// models.list should still work through the proxy
		const result = await proxied.models.list()
		expect(result).toEqual({ data: [] })
		expect(client.models.list).toHaveBeenCalledTimes(1)
	})
})
