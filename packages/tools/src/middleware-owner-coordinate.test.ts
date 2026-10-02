import { createHash } from "node:crypto"
import type {
	LanguageModelV2,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemongoMiddlewareCore } from "./middleware-core.js"
import { withMemongo } from "./vercel/index.js"
import { createOpenAIMiddleware } from "./openai/index.js"

const options = {
	apiUrl: "http://localhost:3847",
	apiKey: "fixture-key",
	agentId: "shared-agent",
}
const originalFetch = globalThis.fetch
const requests: Array<{ path: string; body: Record<string, unknown> }> = []

function owner(body: Record<string, unknown>) {
	return {
		agentId: body.agentId,
		scope: body.scope,
		scopeRef: body.scopeRef,
		sessionId: body.sessionId,
	}
}

describe("middleware owner-coordinate serialization", () => {
	beforeEach(() => {
		requests.length = 0
		globalThis.fetch = vi.fn(async (input, init) => {
			requests.push({
				path: String(input),
				body: JSON.parse(String(init?.body)),
			})
			return new Response(
				JSON.stringify({ rendered: "memory", ok: true, eventId: "event1" }),
				{ headers: { "content-type": "application/json" } },
			)
		})
	})
	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})
	it("forwards explicit per-request ref over constructor ref on read and both writes", async () => {
		const core = createMemongoMiddlewareCore({
			...options,
			scope: "user",
			scopeRef: "constructor-user",
		})
		const identity = { scopeRef: "requested-user", sessionId: "session1" }
		await core.getContextBundle(identity, "question")
		await core.captureTurn(identity, { user: "question", assistant: "answer" })
		expect(requests).toHaveLength(3)
		for (const request of requests)
			expect(owner(request.body)).toEqual({
				agentId: "shared-agent",
				scope: "user",
				scopeRef: "requested-user",
				sessionId: "session1",
			})
	})
	it("derives the engine's user ref only for explicit user scope", async () => {
		const core = createMemongoMiddlewareCore(options)
		for (const userId of [" user-a ", "user-b"]) {
			const identity = { userId, scope: "user" as const }
			await core.getContextBundle(identity, "same question")
			await core.captureTurn(identity, { user: "same question" })
		}
		expect(requests.map((request) => owner(request.body))).toEqual(
			["user:user-a", "user:user-a", "user:user-b", "user:user-b"].map(
				(scopeRef) => ({
					agentId: "shared-agent",
					scope: "user",
					scopeRef,
					sessionId: undefined,
				}),
			),
		)
	})
	it("qualifies turn identity by ref while retaining legacy tuples' exact keys", async () => {
		const core = createMemongoMiddlewareCore(options)
		await core.captureTurn({}, { user: "same question" })
		const legacyHash = createHash("sha256")
			.update(
				JSON.stringify([
					options.apiUrl,
					options.agentId,
					"",
					"",
					"",
					"same question",
				]),
			)
			.digest("hex")
		expect(requests[0]?.body.customId).toBe(`memongo-turn:${legacyHash}:user`)
		for (const scopeRef of ["tenant-a", "tenant-b"]) {
			const identity = { scope: "tenant" as const, scopeRef }
			await core.captureTurn(identity, { user: "same question" })
		}
		expect(requests[1]?.body.customId).not.toBe(requests[2]?.body.customId)
	})
	it("preserves legacy agent and session hints without deriving user scope", async () => {
		const core = createMemongoMiddlewareCore({ ...options, userId: "user-a" })
		await core.getContextBundle({}, "question")
		await core.captureTurn({}, { user: "question" })
		await core.getContextBundle({ sessionId: "session1" }, "question")
		await core.captureTurn({ sessionId: "session1" }, { user: "question" })
		for (const request of requests) {
			expect(request.body.agentId).toBe("shared-agent")
			expect(request.body).not.toHaveProperty("scopeRef")
			expect(request.body).not.toHaveProperty("scope")
		}
		expect(requests.slice(2).map((request) => request.body.sessionId)).toEqual([
			"session1",
			"session1",
		])
	})
	it("carries concurrent Vercel request refs through the actual v5 wrapper", async () => {
		const model: LanguageModelV2 = {
			specificationVersion: "v2",
			provider: "test",
			modelId: "test",
			supportedUrls: {},
			doGenerate: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "answer" }],
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
			}),
			doStream: vi.fn(),
		}
		const wrapped = withMemongo(model, options)
		await Promise.all(
			["tenant-a", "tenant-b"].map((scopeRef) =>
				wrapped.doGenerate({
					prompt: [
						{
							role: "user",
							content: [{ type: "text", text: "same question" }],
						},
					],
					providerOptions: { memongo: { scope: "tenant", scopeRef } },
				}),
			),
		)
		for (const scopeRef of ["tenant-a", "tenant-b"]) {
			const scoped = requests.filter(
				(request) => request.body.scopeRef === scopeRef,
			)
			expect(scoped).toHaveLength(3)
			expect(
				scoped.filter((request) => request.path.endsWith("/v1/context-bundle")),
			).toHaveLength(1)
			expect(
				scoped.filter((request) => request.path.endsWith("/v1/write-event")),
			).toHaveLength(2)
		}
	})
	it("binds constructor refs to inherited scope and trims explicit refs", async () => {
		const defaults = { ...options, scope: "tenant" as const, scopeRef: " t1 " }
		const core = createMemongoMiddlewareCore(defaults)
		for (const identity of [
			{},
			{ scope: "user" as const, userId: " u " },
			{ scope: "user" as const, userId: " u ", scopeRef: "  " },
			{ scope: "user" as const, scopeRef: " explicit " },
		]) {
			await core.getContextBundle(identity)
			await core.captureTurn(identity, { user: "question" })
		}
		expect(requests.map((request) => owner(request.body))).toEqual(
			[
				{ scope: "tenant", scopeRef: "t1" },
				{ scope: "user", scopeRef: "user:u" },
				{ scope: "user", scopeRef: "user:u" },
				{ scope: "user", scopeRef: "explicit" },
			].flatMap((coordinate) =>
				[0, 1].map(() => ({
					agentId: "shared-agent",
					sessionId: undefined,
					...coordinate,
				})),
			),
		)
	})
	it.each([
		undefined,
		"  ",
	])("keeps missing or blank user identity fail-closed (%s)", async (userId) => {
		const errors = vi.fn()
		const core = createMemongoMiddlewareCore({
			...options,
			scope: "user",
			userId,
			onError: errors,
		})
		globalThis.fetch = vi.fn(async (input, init) => {
			const body = JSON.parse(String(init?.body))
			requests.push({ path: String(input), body })
			if (body.scope === "user" && !body.scopeRef)
				return new Response(
					JSON.stringify({
						error: "INVALID_REQUEST",
						message: "requires scopeRef",
					}),
					{ status: 400 },
				)
			return new Response(JSON.stringify({ rendered: "unexpected" }))
		})
		expect(await core.getContextBundle({})).toBe("")
		await core.captureTurn({}, { user: "question" })
		expect(requests).toHaveLength(2)
		for (const request of requests)
			expect(request.body).not.toHaveProperty("scopeRef")
		expect(errors.mock.calls.map((call) => call[1])).toEqual([
			"inject",
			"capture",
		])
	})
	it("keeps blank refs absent for legacy keys", async () => {
		const defaults = { ...options, scopeRef: " " }
		const core = createMemongoMiddlewareCore(defaults)
		await core.captureTurn({}, { user: "question" })
		const reference = createMemongoMiddlewareCore(options)
		await reference.captureTurn({}, { user: "question" })
		expect(requests[0]?.body).not.toHaveProperty("scopeRef")
		expect(requests[0]?.body.customId).toBe(requests[1]?.body.customId)
	})
	it("preserves the ref and shared turn hash through actual v5 streaming", async () => {
		const stream = new ReadableStream<LanguageModelV2StreamPart>({
			start(controller) {
				controller.enqueue({ type: "text-start", id: "text1" })
				controller.enqueue({
					type: "text-delta",
					id: "text1",
					delta: "stream answer",
				})
				controller.enqueue({ type: "text-end", id: "text1" })
				controller.enqueue({
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				})
				controller.close()
			},
		})
		const model: LanguageModelV2 = {
			specificationVersion: "v2",
			provider: "test",
			modelId: "test",
			supportedUrls: {},
			doGenerate: vi.fn(),
			doStream: vi.fn().mockResolvedValue({ stream }),
		}
		const wrapped = withMemongo(model, options)
		const result = await wrapped.doStream({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "stream question" }] },
			],
			providerOptions: {
				memongo: {
					scope: "tenant",
					scopeRef: "tenant-stream",
					sessionId: "session1",
				},
			},
		})
		const reader = result.stream.getReader()
		while (!(await reader.read()).done) {}
		expect(requests).toHaveLength(3)
		for (const request of requests)
			expect(owner(request.body)).toEqual({
				agentId: "shared-agent",
				scope: "tenant",
				scopeRef: "tenant-stream",
				sessionId: "session1",
			})
		const writes = requests.filter((request) =>
			request.path.endsWith("/v1/write-event"),
		)
		expect(writes.map((request) => request.body.body)).toEqual([
			"stream question",
			"stream answer",
		])
		expect(String(writes[0]?.body.customId).replace(/:user$/, "")).toBe(
			String(writes[1]?.body.customId).replace(/:assistant$/, ""),
		)
	})

	it("rebinds inherited user refs when a request overrides the user", async () => {
		const core = createMemongoMiddlewareCore({
			...options,
			userId: "alice",
			scope: "user",
			scopeRef: "user:alice",
		})
		await core.getContextBundle({ userId: " bob " })
		await core.captureTurn(
			{ userId: " bob " },
			{ user: "question", assistant: "answer" },
		)
		expect(requests).toHaveLength(3)
		for (const request of requests)
			expect(owner(request.body)).toEqual({
				agentId: "shared-agent",
				scope: "user",
				scopeRef: "user:bob",
				sessionId: undefined,
			})
	})
	it("does not hide a blank user override behind the constructor user ref", async () => {
		const errors = vi.fn()
		globalThis.fetch = vi.fn(async (input, init) => {
			const body = JSON.parse(String(init?.body))
			requests.push({ path: String(input), body })
			return body.scopeRef
				? new Response(JSON.stringify({ rendered: "wrong user", ok: true }))
				: new Response(JSON.stringify({ error: "requires scopeRef" }), {
						status: 400,
					})
		})
		const core = createMemongoMiddlewareCore({
			...options,
			userId: "alice",
			scope: "user",
			scopeRef: "user:alice",
			onError: errors,
		})
		expect(await core.getContextBundle({ userId: " " })).toBe("")
		await core.captureTurn({ userId: " " }, { user: "question" })
		for (const request of requests)
			expect(request.body).not.toHaveProperty("scopeRef")
		expect(errors.mock.calls.map((call) => call[1])).toEqual([
			"inject",
			"capture",
		])
	})
	it("retains constructor tenant refs when user hints change and explicit refs always win", async () => {
		const core = createMemongoMiddlewareCore({
			...options,
			scope: "tenant",
			scopeRef: "tenant-a",
		})
		await core.getContextBundle({ userId: "bob" })
		await core.captureTurn({ userId: "bob" }, { user: "question" })
		const user = createMemongoMiddlewareCore({
			...options,
			userId: "alice",
			scope: "user",
			scopeRef: "user:alice",
		})
		await user.getContextBundle({ userId: "bob", scopeRef: "external-bob" })
		await user.captureTurn(
			{ userId: "bob", scopeRef: "external-bob" },
			{ user: "question" },
		)
		expect(requests.map((request) => request.body.scopeRef)).toEqual([
			"tenant-a",
			"tenant-a",
			"external-bob",
			"external-bob",
		])
	})

	it("inherits the constructor user ref when the request leaves the user unchanged", async () => {
		const core = createMemongoMiddlewareCore({
			...options,
			scope: "user",
			userId: "alice",
			scopeRef: "user:alice",
		})
		await core.getContextBundle({})
		await core.captureTurn({}, { user: "question" })
		expect(requests.map((request) => request.body.scopeRef)).toEqual([
			"user:alice",
			"user:alice",
		])
	})

	it("uses the OpenAI constructor ref for injection and capture", async () => {
		const client = {
			chat: {
				completions: {
					create: vi.fn(
						async (_params: {
							messages: Array<{ role: string; content: string }>
						}) => ({
							choices: [{ message: { role: "assistant", content: "answer" } }],
						}),
					),
				},
			},
		}
		const identity = {
			...options,
			scope: "tenant" as const,
			scopeRef: "tenant-a",
		}
		const wrapped = createOpenAIMiddleware(client, identity)
		await wrapped.chat.completions.create({
			messages: [{ role: "user", content: "question" }],
		})
		expect(requests).toHaveLength(3)
		for (const request of requests)
			expect(request.body.scopeRef).toBe("tenant-a")
	})
})
