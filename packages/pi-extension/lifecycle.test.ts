import type {
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { MemongoClient } from "@memongo/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	captureIdempotencyKey,
	extractMessageText,
	parseBoolEnv,
	registerMemongoLifecycle,
	resolveLifecycleConfig,
} from "./extensions/lifecycle.js"

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

function createFakePi() {
	const handlers = new Map<string, Handler>()
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler)
		},
		registerTool: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI
	return { pi, handlers }
}

const fakeCtx = {
	cwd: "/tmp/project",
	hasUI: false,
	mode: "rpc",
	sessionManager: { getSessionId: () => "sess-1" },
	ui: { notify: () => {} },
} as unknown as ExtensionContext

function createMockClient() {
	const profile = vi.fn()
	const searchDetailed = vi.fn()
	const writeEvent = vi.fn()
	writeEvent.mockResolvedValue({ ok: true, eventId: "e-1", chunkCreated: true })
	const client = {
		profile,
		searchDetailed,
		writeEvent,
	} as unknown as MemongoClient
	return { client, profile, searchDetailed, writeEvent }
}

const PROFILE = {
	agentId: "pi",
	scope: "global",
	scopeRef: "",
	preferences: [
		{
			key: "pref-dark-mode",
			value: "user prefers dark mode in all tools",
			salience: "high",
			updatedAt: "2026-01-01",
		},
	],
	decisions: [
		{
			key: "dec-bun",
			value: "use bun as the package manager",
			salience: "normal",
			updatedAt: "2026-01-01",
		},
	],
	facts: [],
	todos: [],
	topEntities: [],
	recentEpisodes: [],
	activityPatterns: { roleDistribution: {}, totalEvents: 0, lastActive: null },
	synthesizedAt: "2026-01-01",
}

const SEARCH = {
	results: [
		{
			path: "memory://fact/1",
			startLine: 0,
			endLine: 0,
			score: 0.9,
			snippet: "memongo api runs on port 3847",
			source: "memory",
			scope: "global",
		},
	],
}

const sessionStartEvent = { type: "session_start", reason: "startup" }
const beforeAgentStartEvent = {
	type: "before_agent_start",
	prompt: "hello",
	systemPrompt: "sys",
	systemPromptOptions: {},
}
const agentStartEvent = { type: "agent_start" }

function userMessageStart(text: string) {
	return {
		type: "message_start",
		message: { role: "user", content: text, timestamp: 1 },
	}
}

function turnEnd(turnIndex: number, text: string | null) {
	const content =
		text == null
			? [{ type: "toolCall", id: "tc-1", name: "bash", arguments: {} }]
			: [{ type: "text", text }]
	return {
		type: "turn_end",
		turnIndex,
		message: { role: "assistant", content, timestamp: turnIndex + 1 },
		toolResults: [],
	}
}

function register(
	client: MemongoClient,
	env: Record<string, string | undefined>,
	extra: { flushEvery?: number; flushMs?: number; maxSeenKeys?: number } = {},
) {
	const { pi, handlers } = createFakePi()
	const warn = vi.fn()
	const handle = registerMemongoLifecycle(pi, {
		client,
		agentId: "pi",
		isAvailable: () => true,
		config: resolveLifecycleConfig(env),
		warn,
		// Keep the debounce timer out of the way unless a test opts into it.
		flushMs: 60_000,
		...extra,
	})
	return { handlers, handle, warn }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("parseBoolEnv", () => {
	it("returns the fallback when unset", () => {
		expect(parseBoolEnv(undefined, true)).toBe(true)
		expect(parseBoolEnv(undefined, false)).toBe(false)
	})
	it("parses 1/true (case-insensitive) as true", () => {
		expect(parseBoolEnv("1", false)).toBe(true)
		expect(parseBoolEnv("true", false)).toBe(true)
		expect(parseBoolEnv("TRUE", false)).toBe(true)
	})
	it("parses 0/false (case-insensitive) as false", () => {
		expect(parseBoolEnv("0", true)).toBe(false)
		expect(parseBoolEnv("false", true)).toBe(false)
		expect(parseBoolEnv("False", true)).toBe(false)
	})
	it("returns the fallback for unrecognized values", () => {
		expect(parseBoolEnv("yes", true)).toBe(true)
		expect(parseBoolEnv("yes", false)).toBe(false)
	})
})

describe("resolveLifecycleConfig", () => {
	it("defaults to capture on, injection on, global scope", () => {
		expect(resolveLifecycleConfig({})).toEqual({
			captureEnabled: true,
			injectionEnabled: true,
			scope: "global",
		})
	})
	it("honors opt-out env vars", () => {
		const config = resolveLifecycleConfig({
			MEMONGO_PI_AUTO_CAPTURE: "0",
			MEMONGO_PI_SESSION_INJECTION: "false",
		})
		expect(config.captureEnabled).toBe(false)
		expect(config.injectionEnabled).toBe(false)
	})
	it("parses MEMONGO_PI_MEMORY_SCOPE and rejects invalid scopes", () => {
		expect(
			resolveLifecycleConfig({ MEMONGO_PI_MEMORY_SCOPE: "workspace" }).scope,
		).toBe("workspace")
		expect(
			resolveLifecycleConfig({ MEMONGO_PI_MEMORY_SCOPE: "bogus" }).scope,
		).toBe("global")
	})
})

describe("captureIdempotencyKey", () => {
	it("derives stable keys from session/run/turn identity", () => {
		expect(captureIdempotencyKey("sess-1", 0, 3, "user")).toBe(
			"pi-sess-1-r0-t3-user",
		)
		expect(captureIdempotencyKey("sess-1", 2, 0, "assistant")).toBe(
			"pi-sess-1-r2-t0-assistant",
		)
	})
})

describe("extractMessageText", () => {
	it("extracts string user content", () => {
		expect(extractMessageText({ role: "user", content: " hello " })).toBe(
			"hello",
		)
	})
	it("extracts text parts from assistant content arrays", () => {
		expect(
			extractMessageText({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "first" },
					{ type: "toolCall", id: "x", name: "bash", arguments: {} },
					{ type: "text", text: "second" },
				],
			}),
		).toBe("first\nsecond")
	})
	it("returns empty for tool-only assistant content", () => {
		expect(
			extractMessageText({
				role: "assistant",
				content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }],
			}),
		).toBe("")
	})
})

describe("session-start injection", () => {
	it("fetches profile + recent memories and injects them on first agent start", async () => {
		const { client, profile, searchDetailed } = createMockClient()
		profile.mockResolvedValue(PROFILE)
		searchDetailed.mockResolvedValue(SEARCH)
		const { handlers } = register(client, {})

		await handlers.get("session_start")?.(sessionStartEvent, fakeCtx)
		const result = (await handlers.get("before_agent_start")?.(
			beforeAgentStartEvent,
			fakeCtx,
		)) as BeforeAgentStartEventResult | undefined

		expect(profile).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "pi", scope: "global" }),
		)
		expect(searchDetailed).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "global", maxResults: 5 }),
		)
		expect(result?.message?.customType).toBe("memongo-context")
		expect(result?.message?.display).toBe(false)
		const content = result?.message?.content as string
		expect(content).toContain("user prefers dark mode")
		expect(content).toContain("use bun as the package manager")
		expect(content).toContain("memongo api runs on port 3847")
	})

	it("injects only once per session", async () => {
		const { client, profile, searchDetailed } = createMockClient()
		profile.mockResolvedValue(PROFILE)
		searchDetailed.mockResolvedValue(SEARCH)
		const { handlers } = register(client, {})

		await handlers.get("session_start")?.(sessionStartEvent, fakeCtx)
		const first = await handlers.get("before_agent_start")?.(
			beforeAgentStartEvent,
			fakeCtx,
		)
		const second = await handlers.get("before_agent_start")?.(
			beforeAgentStartEvent,
			fakeCtx,
		)
		expect(first).toBeDefined()
		expect(second).toBeUndefined()
	})

	it("skips injection entirely when MEMONGO_PI_SESSION_INJECTION=0", async () => {
		const { client, profile, searchDetailed } = createMockClient()
		const { handlers } = register(client, { MEMONGO_PI_SESSION_INJECTION: "0" })

		await handlers.get("session_start")?.(sessionStartEvent, fakeCtx)
		const result = await handlers.get("before_agent_start")?.(
			beforeAgentStartEvent,
			fakeCtx,
		)
		expect(profile).not.toHaveBeenCalled()
		expect(searchDetailed).not.toHaveBeenCalled()
		expect(result).toBeUndefined()
	})

	it("fails silently with one warn when the API is down", async () => {
		const { client, profile, searchDetailed } = createMockClient()
		profile.mockRejectedValue(new Error("connection refused"))
		searchDetailed.mockRejectedValue(new Error("connection refused"))
		const { handlers, warn } = register(client, {})

		await handlers.get("session_start")?.(sessionStartEvent, fakeCtx)
		const result = await handlers.get("before_agent_start")?.(
			beforeAgentStartEvent,
			fakeCtx,
		)
		expect(result).toBeUndefined()
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("still injects the profile when only the memory search fails", async () => {
		const { client, profile, searchDetailed } = createMockClient()
		profile.mockResolvedValue(PROFILE)
		searchDetailed.mockRejectedValue(new Error("vector search down"))
		const { handlers } = register(client, {})

		await handlers.get("session_start")?.(sessionStartEvent, fakeCtx)
		const result = (await handlers.get("before_agent_start")?.(
			beforeAgentStartEvent,
			fakeCtx,
		)) as BeforeAgentStartEventResult | undefined
		expect(result?.message?.content as string).toContain(
			"user prefers dark mode",
		)
	})
})

describe("turn-end auto-capture", () => {
	it("captures user + assistant turns with derived idempotency keys", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers, handle } = register(client, {})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("message_start")?.(
			userMessageStart("how is the api wired?"),
			fakeCtx,
		)
		await handlers.get("turn_end")?.(
			turnEnd(0, "it uses Hono on 3847"),
			fakeCtx,
		)
		await handle.flushCaptures()

		expect(writeEvent).toHaveBeenCalledTimes(2)
		expect(writeEvent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				role: "user",
				body: "how is the api wired?",
				agentId: "pi",
				sessionId: "sess-1",
				scope: "global",
				customId: "pi-sess-1-r0-t0-user",
			}),
		)
		expect(writeEvent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				role: "assistant",
				body: "it uses Hono on 3847",
				customId: "pi-sess-1-r0-t0-assistant",
			}),
		)
	})

	it("dedupes a retried turn (same key, written once)", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers, handle } = register(client, {})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("message_start")?.(userMessageStart("hi"), fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "answer"), fakeCtx)
		// Retry: the same turn_end payload is delivered again.
		await handlers.get("turn_end")?.(turnEnd(0, "answer"), fakeCtx)
		await handle.flushCaptures()

		expect(writeEvent).toHaveBeenCalledTimes(2)
	})

	it("bounds seenKeys: an evicted ancient turn may re-capture, recent ones still dedupe (B15.5)", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers, handle } = register(client, {}, { maxSeenKeys: 2 })

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "answer 0"), fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(1, "answer 1"), fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(2, "answer 2"), fakeCtx)
		await handle.flushCaptures()
		expect(writeEvent).toHaveBeenCalledTimes(3)

		// Turn 1 is still inside the dedup window (retry first: re-capturing
		// the evicted turn 0 would cascade-evict turn 1). Turn 0's key was
		// FIFO-evicted once the cap was exceeded, so its ancient retry
		// re-buffers — the server idempotency key makes that duplicate a no-op.
		await handlers.get("turn_end")?.(turnEnd(1, "answer 1"), fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "answer 0"), fakeCtx)
		await handle.flushCaptures()
		expect(writeEvent).toHaveBeenCalledTimes(4)
	})

	it("batches captures: no write before the flush threshold", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers } = register(client, {})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		for (let i = 0; i < 3; i++) {
			await handlers.get("turn_end")?.(turnEnd(i, `assistant ${i}`), fakeCtx)
		}
		expect(writeEvent).not.toHaveBeenCalled()

		// 4th buffered event hits the default flushEvery=4 threshold.
		await handlers.get("turn_end")?.(turnEnd(3, "assistant 3"), fakeCtx)
		expect(writeEvent).toHaveBeenCalledTimes(4)
	})

	it("flushes on the debounce timer before the threshold", async () => {
		vi.useFakeTimers()
		const { client, writeEvent } = createMockClient()
		const { handlers, handle } = register(client, {}, { flushMs: 5_000 })

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "assistant 0"), fakeCtx)
		expect(writeEvent).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(5_000)
		await handle.flushCaptures()
		expect(writeEvent).toHaveBeenCalledTimes(1)
	})

	it("skips capture entirely when MEMONGO_PI_AUTO_CAPTURE=0", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers, handle } = register(client, {
			MEMONGO_PI_AUTO_CAPTURE: "0",
		})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("message_start")?.(userMessageStart("hi"), fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "answer"), fakeCtx)
		await handle.flushCaptures()
		expect(writeEvent).not.toHaveBeenCalled()
	})

	it("skips tool-only assistant turns", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers, handle } = register(client, {})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, null), fakeCtx)
		await handle.flushCaptures()
		expect(writeEvent).not.toHaveBeenCalled()
	})

	it("flushes pending captures on session_shutdown", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers } = register(client, {})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "assistant 0"), fakeCtx)
		expect(writeEvent).not.toHaveBeenCalled()

		await handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			fakeCtx,
		)
		expect(writeEvent).toHaveBeenCalledTimes(1)
	})

	it("starts a new run on agent_start so later prompts get distinct keys", async () => {
		const { client, writeEvent } = createMockClient()
		const { handlers, handle } = register(client, {})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "first"), fakeCtx)
		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "second"), fakeCtx)
		await handle.flushCaptures()

		expect(writeEvent).toHaveBeenCalledTimes(2)
		expect(writeEvent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ customId: "pi-sess-1-r0-t0-assistant" }),
		)
		expect(writeEvent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ customId: "pi-sess-1-r1-t0-assistant" }),
		)
	})

	it("fails silently with a warn when writeEvent rejects", async () => {
		const { client, writeEvent } = createMockClient()
		writeEvent.mockRejectedValue(new Error("api down"))
		const { handlers, handle, warn } = register(client, {})

		await handlers.get("agent_start")?.(agentStartEvent, fakeCtx)
		await handlers.get("turn_end")?.(turnEnd(0, "assistant 0"), fakeCtx)
		await expect(handle.flushCaptures()).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalled()
	})
})
