import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemongoMiddlewareCore } from "./middleware-core.js"
import { createOpenAIMiddleware } from "./openai/index.js"
import { withMemongo } from "./vercel/index.js"

const options = {
	apiUrl: "http://127.0.0.1:3847",
	apiKey: "synthetic-test-key",
	agentId: "agent",
	userId: "user",
	sessionId: "session",
}
const identity = { scope: "user" as const, scopeRef: "user:user" }
const parts = { user: "repeat", assistant: "answer" }
type Write = { customId: string; role: string; body: string }
let writes: Write[]

beforeEach(() => {
	writes = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/v1/write-event")) {
				const write = JSON.parse(String(init?.body)) as Write
				expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
					write.customId,
				)
				writes.push(write)
				return Response.json({
					ok: true,
					eventId: "synthetic",
					chunkCreated: false,
				})
			}
			return Response.json({ rendered: "" })
		}),
	)
})
afterEach(() => vi.unstubAllGlobals())

function userKeys() {
	return writes.filter((w) => w.role === "user").map((w) => w.customId)
}
function params(requestId?: string): LanguageModelV2CallOptions {
	return {
		prompt: [{ role: "user", content: [{ type: "text", text: "repeat" }] }],
		providerOptions: {
			memongo: {
				...identity,
				...(requestId === undefined ? {} : { requestId }),
			},
		},
	}
}
function model(
	content: Awaited<ReturnType<LanguageModelV2["doGenerate"]>>["content"] = [
		{ type: "text", text: "answer" },
	],
	streamOverride?: LanguageModelV2StreamPart[],
): LanguageModelV2 {
	const streamParts: LanguageModelV2StreamPart[] = [
		{ type: "text-start", id: "text" },
		{ type: "text-delta", id: "text", delta: "answer" },
		{ type: "text-end", id: "text" },
		{
			type: "finish",
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		},
	]
	return {
		specificationVersion: "v2",
		provider: "synthetic",
		modelId: "synthetic",
		supportedUrls: {},
		doGenerate: async () => ({
			content,
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
		}),
		doStream: async () => ({
			stream: new ReadableStream({
				start(c) {
					for (const p of streamOverride ?? streamParts) c.enqueue(p)
					c.close()
				},
			}),
		}),
	}
}

describe("caller stable logical request identity", () => {
	it("distinguishes identical prompts with distinct logical IDs", async () => {
		const core = createMemongoMiddlewareCore(options)
		await core.captureTurn({ ...identity, requestId: "one" }, parts)
		await core.captureTurn(
			{ ...identity, requestId: "two" },
			{ ...parts, assistant: "new answer" },
		)
		expect(writes).toHaveLength(4)
		expect(userKeys()[0]).not.toBe(userKeys()[1])
		expect(writes[1].customId).not.toBe(writes[3].customId)
	})
	it("stable ID retry and split streaming capture reuse both role keys", async () => {
		const core = createMemongoMiddlewareCore(options)
		const owner = { ...identity, requestId: "logical" }
		await core.captureTurn(owner, parts)
		await core.captureTurn(owner, { user: parts.user })
		await core.captureTurn(owner, { assistant: parts.assistant }, parts.user)
		expect(writes).toHaveLength(4)
		expect(writes[0].customId).toBe(writes[2].customId)
		expect(writes[1].customId).toBe(writes[3].customId)
		expect(writes[0].customId).not.toBe(writes[1].customId)
	})
	it("does not derive an explicit ID's key from changed prompt or answer", async () => {
		const core = createMemongoMiddlewareCore(options)
		await core.captureTurn({ ...identity, requestId: "logical" }, parts)
		await core.captureTurn(
			{ ...identity, requestId: "logical" },
			{ user: "changed", assistant: "changed" },
		)
		expect(writes).toHaveLength(4)
		expect(writes[0].customId).toBe(writes[2].customId)
		expect(writes[1].customId).toBe(writes[3].customId)
	})
	it("isolates owner coordinates and opaque ID whitespace", async () => {
		const core = createMemongoMiddlewareCore(options)
		await core.captureTurn({ ...identity, requestId: "logical" }, parts)
		await core.captureTurn(
			{ ...identity, requestId: "logical", userId: "other" },
			parts,
		)
		await core.captureTurn(
			{ ...identity, requestId: "logical", scopeRef: "user:other" },
			parts,
		)
		await core.captureTurn({ ...identity, requestId: " logical " }, parts)
		expect(writes).toHaveLength(8)
		expect(new Set(userKeys()).size).toBe(4)
	})
	it("uses constructor ID unless a nonblank request override is supplied", async () => {
		const core = createMemongoMiddlewareCore({
			...options,
			requestId: "default",
		})
		await core.captureTurn(identity, parts)
		await core.captureTurn({ ...identity, requestId: "default" }, parts)
		await core.captureTurn({ ...identity, requestId: "override" }, parts)
		await core.captureTurn({ ...identity, requestId: " " }, parts)
		expect(writes).toHaveLength(8)
		expect(userKeys()[0]).toBe(userKeys()[1])
		expect(userKeys()[3]).toBe(userKeys()[0])
		expect(new Set(userKeys()).size).toBe(2)
	})
	it("preserves exact legacy no-ID hash and blank fallback", async () => {
		const core = createMemongoMiddlewareCore(options)
		await core.captureTurn({}, parts)
		await core.captureTurn({ requestId: "\t " }, parts)
		const expected = createHash("sha256")
			.update(
				JSON.stringify([
					options.apiUrl,
					"agent",
					"user",
					"session",
					"",
					"repeat",
				]),
			)
			.digest("hex")
		expect(writes).toHaveLength(4)
		expect(userKeys()).toEqual([
			`memongo-turn:${expected}:user`,
			`memongo-turn:${expected}:user`,
		])
	})
	it("preserves exact legacy scopeRef hash", async () => {
		const core = createMemongoMiddlewareCore(options)
		await core.captureTurn(identity, parts)
		const hash = createHash("sha256")
			.update(
				JSON.stringify([
					options.apiUrl,
					"agent",
					"user",
					"session",
					"user",
					"repeat",
					"user:user",
				]),
			)
			.digest("hex")
		expect(writes).toHaveLength(2)
		expect(userKeys()).toEqual([`memongo-turn:${hash}:user`])
	})
	it("a fixed constructor ID deliberately reuses keys for changed turns", async () => {
		const core = createMemongoMiddlewareCore({ ...options, requestId: "fixed" })
		await core.captureTurn(identity, parts)
		await core.captureTurn(identity, {
			user: "changed prompt",
			assistant: "changed answer",
		})
		expect(writes).toHaveLength(4)
		expect(writes[0].customId).toBe(writes[2].customId)
		expect(writes[1].customId).toBe(writes[3].customId)
	})
	it("Vercel per-call IDs distinguish repeated prompts on a reused wrapper", async () => {
		const wrapped = withMemongo(model(), options)
		await wrapped.doGenerate(params("one"))
		await wrapped.doGenerate(params("two"))
		expect(writes).toHaveLength(4)
		expect(userKeys()[0]).not.toBe(userKeys()[1])
	})
	it("Vercel streamed text and nonstream retry retain the same role keys", async () => {
		const wrapped = withMemongo(model(), options)
		await wrapped.doGenerate(params("logical"))
		const result = await wrapped.doStream(params("logical"))
		const reader = result.stream.getReader()
		while (!(await reader.read()).done) {}
		expect(writes).toHaveLength(4)
		expect(writes[0].customId).toBe(writes[2].customId)
		expect(writes[1].customId).toBe(writes[3].customId)
		expect(writes[3].body).toBe("answer")
	})
	it.each([
		{ content: [{ type: "reasoning" as const, text: "private reasoning" }] },
		{
			content: [
				{
					type: "tool-call" as const,
					toolCallId: "call",
					toolName: "synthetic",
					input: "{}",
				},
			],
		},
	])("does not capture reasoning or tool-only outputs as assistant text", async ({
		content,
	}) => {
		await withMemongo(model(content), options).doGenerate(params("logical"))
		expect(writes).toHaveLength(1)
		expect(writes[0]).toMatchObject({ role: "user", body: "repeat" })
	})
	it.each([
		{
			stream: [
				{ type: "reasoning-start" as const, id: "reason" },
				{
					type: "reasoning-delta" as const,
					id: "reason",
					delta: "private reasoning",
				},
				{ type: "reasoning-end" as const, id: "reason" },
			],
		},
		{
			stream: [
				{
					type: "tool-call" as const,
					toolCallId: "call",
					toolName: "synthetic",
					input: "{}",
				},
			],
		},
	])("does not capture reasoning or tool-only streams as assistant text", async ({
		stream,
	}) => {
		const result = await withMemongo(model([], stream), options).doStream(
			params("logical"),
		)
		const reader = result.stream.getReader()
		const received: LanguageModelV2StreamPart[] = []
		for (;;) {
			const next = await reader.read()
			if (next.done) break
			received.push(next.value)
		}
		expect(received).toEqual(stream)
		expect(writes).toHaveLength(1)
		expect(writes[0]).toMatchObject({ role: "user", body: "repeat" })
	})
	it("Vercel ignores nonstring IDs and leaves context coordinates unchanged", async () => {
		const wrapped = withMemongo(model(), { ...options, requestId: "default" })
		const input = params()
		input.providerOptions = { memongo: { ...identity, requestId: 42 } }
		await wrapped.doGenerate(input)
		await wrapped.doGenerate(params("default"))
		expect(writes).toHaveLength(4)
		expect(userKeys()[0]).toBe(userKeys()[1])
		const calls = vi
			.mocked(fetch)
			.mock.calls.filter((call) =>
				String(call[0]).includes("/v1/context-bundle"),
			)
		expect(calls).toHaveLength(2)
		expect(calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
			{
				agentId: "agent",
				mode: "full",
				query: "repeat",
				scope: "user",
				scopeRef: "user:user",
				sessionId: "session",
			},
			{
				agentId: "agent",
				mode: "full",
				query: "repeat",
				scope: "user",
				scopeRef: "user:user",
				sessionId: "session",
			},
		])
	})
	it("OpenAI constructor IDs distinguish logical turns and remain on Memongo side", async () => {
		const create = vi.fn(async (_params: unknown) => ({
			choices: [{ message: { role: "assistant", content: "answer" } }],
		}))
		const client = { chat: { completions: { create } } }
		const input = { messages: [{ role: "user", content: "repeat" }] }
		await createOpenAIMiddleware(client, {
			...options,
			requestId: "one",
		}).chat.completions.create(input)
		await createOpenAIMiddleware(client, {
			...options,
			requestId: "two",
		}).chat.completions.create(input)
		expect(writes).toHaveLength(4)
		expect(userKeys()[0]).not.toBe(userKeys()[1])
		expect(create).toHaveBeenCalledTimes(2)
		expect(create.mock.calls.map((call) => call[0])).toEqual([input, input])
	})
})
