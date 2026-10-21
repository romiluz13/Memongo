import { describe, expect, it, vi } from "vitest"
import { createHttpProvider } from "./mongodb-llm-enrichment.js"

// Synthetic, fictional OpenAI-compatible envelopes only.
const TEST_TRANSPORT = { verifyPublicHostname: vi.fn(async () => {}) }

async function complete(body: unknown) {
	const fetchFn = vi
		.fn()
		.mockResolvedValue({ ok: true, json: async () => body })
	const provider = createHttpProvider(
		{
			baseUrl: "https://example.invalid/v1",
			apiKey: "test-key",
			model: "fixture-model",
		},
		fetchFn as unknown as typeof globalThis.fetch,
		TEST_TRANSPORT,
	)
	return provider.chatCompletion({
		model: "fixture-model",
		messages: [{ role: "user", content: "test" }],
	})
}

const CHOICES = [
	{ message: { content: '{"answer":"Lisbon"}' }, finish_reason: "stop" },
]

describe("provider envelope identity (B6)", () => {
	it("captures the response id and model into responseMeta", async () => {
		const result = await complete({
			id: "chatcmpl-Fixture_01.a:b/c@d+e",
			model: "models/gemini-fixture-2.5",
			choices: CHOICES,
		})
		expect(result.responseMeta).toEqual({
			shape: "ok",
			finishReason: "stop",
			responseId: "chatcmpl-Fixture_01.a:b/c@d+e",
			responseModel: "models/gemini-fixture-2.5",
		})
	})

	it("keeps the identity on an envelope that fails classification", async () => {
		const result = await complete({ id: "resp-1", model: "m-1", choices: [] })
		expect(result.responseMeta).toEqual({
			shape: "missing-choices",
			responseId: "resp-1",
			responseModel: "m-1",
		})
	})

	it.each([
		["text outside the charset", "id with spaces <script>"],
		["an over-long value", "a".repeat(129)],
		["an empty string", ""],
		["a non-string", 42],
	])("drops %s and records the drop", async (_label, badId) => {
		const result = await complete({
			id: badId,
			model: "m-1",
			choices: CHOICES,
		})
		expect(result.responseMeta).toEqual({
			shape: "ok",
			finishReason: "stop",
			responseModel: "m-1",
			droppedEnvelopeFields: ["id"],
		})
	})

	it("records both fields dropped when neither passes the check", async () => {
		const result = await complete({
			id: "line\nbreak",
			model: { name: "nested" },
			choices: CHOICES,
		})
		expect(result.responseMeta).toEqual({
			shape: "ok",
			finishReason: "stop",
			droppedEnvelopeFields: ["id", "model"],
		})
	})

	it("adds nothing when the envelope reports no id or model", async () => {
		const result = await complete({ id: null, choices: CHOICES })
		expect(result.responseMeta).toEqual({ shape: "ok", finishReason: "stop" })
	})
})
