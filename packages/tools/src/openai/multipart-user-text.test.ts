import { MemongoClient } from "@memongo/client"
import type {
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionUserMessageParam,
} from "openai/resources/chat/completions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOpenAIMiddleware } from "./index.js"

const options = {
	apiUrl: "http://127.0.0.1:3100",
	apiKey: "fixture",
	agentId: "agent",
	sessionId: "session",
}
const result = {
	choices: [{ message: { role: "assistant", content: "answer" } }],
}
function prepare(rendered = "") {
	const context = vi
		.spyOn(MemongoClient.prototype, "buildContextBundle")
		.mockResolvedValue({
			agentId: "agent",
			scope: "agent",
			scopeRef: "agent",
			rendered,
			sections: [],
			metadata: {
				tokenBudget: 0,
				estimatedTokensUsed: 0,
				partial: false,
				truncated: false,
				pathsExecuted: [],
				sectionsIncluded: [],
			},
			builtAt: "2026-10-02T00:00:00.000Z",
		})
	const write = vi
		.spyOn(MemongoClient.prototype, "writeEvent")
		.mockResolvedValue({ ok: true, eventId: "event", chunkCreated: false })
	const create = vi.fn(
		async (
			_params:
				| ChatCompletionCreateParamsNonStreaming
				| ChatCompletionCreateParamsStreaming,
			..._rest: unknown[]
		) => result,
	)
	const client = createOpenAIMiddleware(
		{ chat: { completions: { create } } },
		options,
	)
	return { client, create, context, write }
}
const image = {
	type: "image_url",
	image_url: { url: "https://example.test/image.png" },
} as const
const cases: Array<{
	name: string
	content: ChatCompletionUserMessageParam["content"]
	text?: string
}> = [
	{
		name: "mixed text and image",
		content: [
			{ type: "text", text: "first" },
			image,
			{ type: "text", text: "second" },
		],
		text: "first\nsecond",
	},
	{
		name: "text only",
		content: [{ type: "text", text: "query" }],
		text: "query",
	},
	{ name: "image only", content: [image] },
	{ name: "empty array", content: [] },
	{
		name: "empty parts",
		content: [
			{ type: "text", text: "" },
			{ type: "text", text: "" },
		],
	},
	{
		name: "empty then text",
		content: [
			{ type: "text", text: "" },
			{ type: "text", text: "query" },
		],
		text: "query",
	},
	{
		name: "whitespace text",
		content: [{ type: "text", text: "  " }],
		text: "  ",
	},
	{ name: "plain string", content: "query", text: "query" },
	{ name: "whitespace string", content: "  ", text: "  " },
	{
		name: "audio only",
		content: [
			{ type: "input_audio", input_audio: { data: "fixture", format: "wav" } },
		],
	},
	{
		name: "file only",
		content: [{ type: "file", file: { file_id: "fixture" } }],
	},
]

describe("OpenAI multipart user memory text", () => {
	beforeEach(() =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Unexpected fetch")
			}),
		),
	)
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})
	it.each(cases)("extracts $name without changing provider messages", async ({
		content,
		text,
	}) => {
		const { client, create, context, write } = prepare()
		const params: ChatCompletionCreateParamsNonStreaming = {
			model: "fixture",
			messages: [{ role: "user", content }],
			temperature: 0.2,
		}
		const extra = { signal: new AbortController().signal }
		const output = await client.chat.completions.create(params, extra)
		expect(output).toBe(result)
		expect(create.mock.calls[0]?.[0]).toEqual(params)
		expect(create.mock.calls[0]?.[0]?.messages).toBe(params.messages)
		expect(create.mock.calls[0]?.[1]).toBe(extra)
		expect(context.mock.calls[0]?.[0]?.query).toBe(text)
		expect(context.mock.calls[0]?.[0]?.mode).toBe(text ? "full" : "wake-up")
		const user = write.mock.calls.filter(([input]) => input.role === "user")
		expect(user.map(([input]) => input.body)).toEqual(text ? [text] : [])
		expect(
			write.mock.calls
				.filter(([input]) => input.role === "assistant")
				.map(([input]) => input.body),
		).toEqual(["answer"])
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})
	it("keeps image-only latest user content from borrowing an older query", async () => {
		const { client, context, write } = prepare()
		await client.chat.completions.create({
			model: "fixture",
			messages: [
				{ role: "user", content: "older" },
				{ role: "assistant", content: "prior" },
				{ role: "user", content: [image] },
			],
		})
		expect(context.mock.calls[0]?.[0]?.query).toBeUndefined()
		expect(
			write.mock.calls.filter(([input]) => input.role === "user"),
		).toHaveLength(0)
	})
	it("retains legacy empty-string fallback to the older user text", async () => {
		const { client, context } = prepare()
		await client.chat.completions.create({
			model: "fixture",
			messages: [
				{ role: "user", content: "older" },
				{ role: "user", content: "" },
			],
		})
		expect(context.mock.calls[0]?.[0]?.query).toBe("older")
	})
	it("preserves image parts when adding a memory system message", async () => {
		const { client, create } = prepare("stored memory")
		const messages: ChatCompletionCreateParamsNonStreaming["messages"] = [
			{ role: "user", content: [{ type: "text", text: "question" }, image] },
		]
		await client.chat.completions.create({ model: "fixture", messages })
		const forwarded = create.mock.calls[0]?.[0]?.messages
		expect(forwarded).toHaveLength(2)
		expect(forwarded?.[0]).toMatchObject({
			role: "system",
			content: expect.stringContaining("UNTRUSTED"),
		})
		expect(forwarded?.[1]).toBe(messages[0])
		expect(messages).toHaveLength(1)
	})
	it("captures multipart user text only on streaming calls and preserves the result", async () => {
		const { client, create, write } = prepare()
		const params: ChatCompletionCreateParamsStreaming = {
			model: "fixture",
			stream: true,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "first" },
						image,
						{ type: "text", text: "second" },
					],
				},
			],
		}
		expect(await client.chat.completions.create(params)).toBe(result)
		expect(create.mock.calls[0]?.[0]).toEqual(params)
		expect(write.mock.calls.map(([input]) => [input.role, input.body])).toEqual(
			[["user", "first\nsecond"]],
		)
	})
	it("does not coerce nontext fields or Responses parts into chat text", async () => {
		const { context, write } = prepare()
		const create = vi.fn(
			async (_params: {
				messages: Array<{ role: string; content: unknown }>
			}) => result,
		)
		const client = createOpenAIMiddleware(
			{ chat: { completions: { create } } },
			options,
		)
		await client.chat.completions.create({
			messages: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "responses" },
						{ type: "image_url", text: "metadata" },
						{ type: "text", text: 10 },
					],
				},
			],
		})
		expect(context.mock.calls[0]?.[0]?.query).toBeUndefined()
		expect(
			write.mock.calls.filter(([input]) => input.role === "user"),
		).toHaveLength(0)
	})
	it("sends only extracted text through the actual client JSON wire", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				new Request(url, init)
				requests.push({ url, body: JSON.parse(String(init?.body)) })
				return new Response(
					JSON.stringify(
						url.endsWith("/v1/context-bundle")
							? { rendered: "" }
							: { ok: true, eventId: "event", chunkCreated: false },
					),
					{
						headers: { "Content-Type": "application/json" },
					},
				)
			}),
		)
		const create = vi.fn(
			async (_params: ChatCompletionCreateParamsNonStreaming) => result,
		)
		const client = createOpenAIMiddleware(
			{ chat: { completions: { create } } },
			options,
		)
		const params: ChatCompletionCreateParamsNonStreaming = {
			model: "fixture",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "first" },
						image,
						{ type: "text", text: "second" },
					],
				},
			],
		}
		await client.chat.completions.create(params)
		expect(requests).toHaveLength(3)
		expect(requests[0]?.body.query).toBe("first\nsecond")
		expect(requests[0]?.body.mode).toBe("full")
		expect(requests.slice(1).map(({ body }) => [body.role, body.body])).toEqual(
			[
				["user", "first\nsecond"],
				["assistant", "answer"],
			],
		)
		for (const { body } of requests) {
			expect(body.agentId).toBe("agent")
			expect(body.sessionId).toBe("session")
		}
		expect(create.mock.calls[0]?.[0].messages).toBe(params.messages)
	})
})
