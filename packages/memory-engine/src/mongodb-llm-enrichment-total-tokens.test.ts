import { describe, expect, it, vi } from "vitest"
import { createHttpProvider } from "./mongodb-llm-enrichment.js"

// Synthetic OpenAI-compatible envelopes only. A thinking model can bill
// thought tokens that appear in total_tokens but not in completion_tokens.
const TEST_TRANSPORT = { verifyPublicHostname: vi.fn(async () => {}) }

async function usageOf(usage: unknown) {
	const fetchFn = vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({
			choices: [{ message: { role: "assistant" }, finish_reason: "length" }],
			usage,
		}),
	})
	const provider = createHttpProvider(
		{
			baseUrl: "https://example.invalid/v1",
			apiKey: "test-key",
			model: "fixture-model",
		},
		fetchFn as unknown as typeof globalThis.fetch,
		TEST_TRANSPORT,
	)
	const result = await provider.chatCompletion({
		model: "fixture-model",
		messages: [{ role: "user", content: "test" }],
	})
	return result.usage
}

describe("provider total_tokens", () => {
	it("keeps total_tokens next to prompt and completion tokens", async () => {
		expect(
			await usageOf({
				prompt_tokens: 6,
				completion_tokens: 0,
				total_tokens: 18,
			}),
		).toEqual({ inputTokens: 6, outputTokens: 0, totalTokens: 18 })
	})

	it("leaves totalTokens absent when total_tokens is missing or not finite", async () => {
		expect(await usageOf({ prompt_tokens: 6, completion_tokens: 0 })).toEqual({
			inputTokens: 6,
			outputTokens: 0,
		})
		expect(
			await usageOf({
				prompt_tokens: 6,
				completion_tokens: 0,
				total_tokens: "18",
			}),
		).toEqual({ inputTokens: 6, outputTokens: 0 })
	})
})
