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
