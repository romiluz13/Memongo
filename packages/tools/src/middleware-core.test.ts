import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemongoCoreOptions } from "./middleware-core.js"
import { createMemongoMiddlewareCore } from "./middleware-core.js"

const originalFetch = globalThis.fetch

const BASE_OPTIONS: MemongoCoreOptions = {
	apiUrl: "http://127.0.0.1:3847",
	apiKey: ["test", "-key"].join(""),
	userId: "user-1",
	agentId: "agent-1",
}

function dummy000000000000000000000000() {
	globalThis.fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					error: {
						code: "INTERNAL",
						message: [
							"upstream ",
							"mongodb://svc:",
							"dummy-cred-000@",
							"cluster.example.net:27017 unreachable",
						].join(""),
					},
				}),
				{ status: 500, headers: { "content-type": "application/json" } },
			),
	) as unknown as typeof fetch
}

describe("createMemongoMiddlewareCore default error reporting (C-002)", () => {
	beforeEach(() => {
		dummy000000000000000000000000()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it("redacts credential-bearing client errors in the one-time default warn", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const core = createMemongoMiddlewareCore(BASE_OPTIONS)

		const rendered = await core.getContextBundle({ userId: "user-1" }, "hello")

		expect(rendered).toBe("")
		await vi.waitFor(() => {
			expect(warn).toHaveBeenCalledTimes(1)
		})
		const out = warn.mock.calls.map((args) => args.join(" ")).join("\n")
		expect(out).toContain("[memongo] inject failed")
		expect(out).not.toContain("dummy-cred-000")
	})

	it("emits the default warn at most once per middleware instance", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const core = createMemongoMiddlewareCore(BASE_OPTIONS)

		await core.getContextBundle({ userId: "user-1" }, "one")
		await core.getContextBundle({ userId: "user-1" }, "two")

		await vi.waitFor(() => {
			expect(warn).toHaveBeenCalledTimes(1)
		})
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("passes the raw error to onError (programmatic callback, not a log)", async () => {
		const onError = vi.fn()
		const core = createMemongoMiddlewareCore({ ...BASE_OPTIONS, onError })

		await core.getContextBundle({ userId: "user-1" }, "hello")

		expect(onError).toHaveBeenCalledTimes(1)
		const [err, phase] = onError.mock.calls[0] as [Error, string]
		expect(phase).toBe("inject")
		// onError is a callback, not a diagnostic path — it sees the raw chain.
		expect(err.message).toContain("dummy-cred-000")
	})
})

describe("createMemongoMiddlewareCore fresh per-call retrieval (W7)", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	/**
	 * Controlled fetch stub in the shape of Root's W6 probe: mutable server
	 * state the test flips between calls. A FRESH Response is built per call
	 * so repeated requests never hit an already-consumed body.
	 */
	function stubMutableServer(initial: { rendered: string; status?: number }) {
		const state = {
			rendered: initial.rendered,
			status: initial.status ?? 200,
		}
		const mockFetch = vi.fn(async () => {
			if (state.status === 401) {
				return new Response(
					JSON.stringify({
						error: {
							code: "UNAUTHORIZED",
							message: "synthetic revocation",
						},
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				)
			}
			return new Response(JSON.stringify({ rendered: state.rendered }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		})
		globalThis.fetch = mockFetch as unknown as typeof fetch
		return { state, mockFetch }
	}

	function bundleBodies(mockFetch: ReturnType<typeof vi.fn>) {
		return mockFetch.mock.calls
			.filter((call: unknown[]) =>
				String(call[0]).includes("/v1/context-bundle"),
			)
			.map((call: unknown[]) => JSON.parse(String(call[1]?.body ?? "{}")))
	}

	it("repeat identical query reflects changed server memory (erasure)", async () => {
		const { state, mockFetch } = stubMutableServer({
			rendered: "MEMORY_ALPHA",
		})
		const core = createMemongoMiddlewareCore(BASE_OPTIONS)

		const first = await core.getContextBundle(
			{ userId: "user-1" },
			"same question",
		)
		expect(first).toBe("MEMORY_ALPHA")

		// Server-side erasure: the next bundle renders empty.
		state.rendered = ""
		const second = await core.getContextBundle(
			{ userId: "user-1" },
			"same question",
		)
		expect(second).toBe("")
		expect(bundleBodies(mockFetch)).toHaveLength(2)
	})

	it("401 after a prior positive never serves the old string", async () => {
		const { state, mockFetch } = stubMutableServer({
			rendered: "MEMORY_BETA",
		})
		const onError = vi.fn()
		const core = createMemongoMiddlewareCore({ ...BASE_OPTIONS, onError })

		const first = await core.getContextBundle(
			{ userId: "user-1" },
			"same question",
		)
		expect(first).toBe("MEMORY_BETA")

		// Credential revoked server-side: the next request gets a 401 envelope.
		state.status = 401
		const second = await core.getContextBundle(
			{ userId: "user-1" },
			"same question",
		)
		expect(second).toBe("")
		expect(second).not.toBe("MEMORY_BETA")

		const injectCalls = onError.mock.calls.filter(
			(call: unknown[]) => call[1] === "inject",
		)
		expect(injectCalls).toHaveLength(1)
		expect(String(injectCalls[0]?.[0])).toContain("401")
		expect(bundleBodies(mockFetch)).toHaveLength(2)
	})

	it("a new middleware instance with the same credentials never reuses a prior result", async () => {
		const { state, mockFetch } = stubMutableServer({
			rendered: "MEMORY_GAMMA",
		})
		const coreOne = createMemongoMiddlewareCore(BASE_OPTIONS)
		const first = await coreOne.getContextBundle(
			{ userId: "user-1" },
			"same question",
		)
		expect(first).toBe("MEMORY_GAMMA")

		// Erased between instances; SAME credentials, brand-new instance.
		state.rendered = ""
		const coreTwo = createMemongoMiddlewareCore({ ...BASE_OPTIONS })
		const second = await coreTwo.getContextBundle(
			{ userId: "user-1" },
			"same question",
		)
		expect(second).toBe("")
		expect(bundleBodies(mockFetch)).toHaveLength(2)
	})

	it("forwards per-request identity and parameters unchanged", async () => {
		const { mockFetch } = stubMutableServer({ rendered: "ctx" })
		const core = createMemongoMiddlewareCore({
			...BASE_OPTIONS,
			agentId: "default-agent",
			scope: "global",
			sessionId: "default-session",
		})

		await core.getContextBundle(
			{ agentId: "req-agent", scope: "session", sessionId: "req-session" },
			"what did we discuss?",
		)
		await core.getContextBundle({}, "what did we discuss?")

		const bodies = bundleBodies(mockFetch)
		// Per-request overrides win...
		expect(bodies[0]).toEqual({
			agentId: "req-agent",
			mode: "full",
			query: "what did we discuss?",
			scope: "session",
			sessionId: "req-session",
		})
		// ...and constructor defaults apply when the request carries none.
		expect(bodies[1]).toEqual({
			agentId: "default-agent",
			mode: "full",
			query: "what did we discuss?",
			scope: "global",
			sessionId: "default-session",
		})
	})

	it("capture fingerprints are unchanged (stable per logical turn, unique across turns)", async () => {
		const { mockFetch } = stubMutableServer({ rendered: "ctx" })
		const core = createMemongoMiddlewareCore(BASE_OPTIONS)

		await core.captureTurn(
			{ userId: "user-1" },
			{ user: "dogs?", assistant: "woof" },
		)
		// Retry of the same logical turn: identical keys.
		await core.captureTurn(
			{ userId: "user-1" },
			{ user: "dogs?", assistant: "woof" },
		)
		// A different turn: different keys.
		await core.captureTurn(
			{ userId: "user-1" },
			{ user: "cats?", assistant: "meow" },
		)

		const writes = mockFetch.mock.calls
			.filter((call: unknown[]) => String(call[0]).includes("/v1/write-event"))
			.map((call: unknown[]) => {
				const body = JSON.parse(String(call[1]?.body ?? "{}")) as {
					role: string
					customId: string
				}
				const headers = (call[1]?.headers ?? {}) as Record<string, string>
				return {
					role: body.role,
					customId: body.customId,
					header: headers["Idempotency-Key"],
				}
			})
		expect(writes).toHaveLength(6)
		for (const write of writes) {
			expect(write.customId).toBe(write.header)
			expect(write.customId).toMatch(
				/^memongo-turn:[0-9a-f]{64}:(user|assistant)$/,
			)
		}
		const userKeys = writes
			.filter((write) => write.role === "user")
			.map((write) => write.customId)
		expect(userKeys[0]).toBe(userKeys[1])
		expect(userKeys[2]).not.toBe(userKeys[0])
	})
})
