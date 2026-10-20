import { MemongoClientError } from "@memongo/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { observeCall } from "./observe.ts"
import { createProbeApi, type LifecycleAsInput } from "./probe-api.ts"

const BASE = "http://127.0.0.1:51234"
const KEY = "probe-key-SENTINEL-0001"

const INPUT: LifecycleAsInput = {
	handle: {
		family: "structured",
		id: "st-1",
		agentId: "agent-a",
		scope: "workspace",
		scopeRef: "ref-a",
		revision: 1,
		state: "active",
		structured: { type: "fact", key: "k" },
	},
	agentId: "agent-b",
	scope: "workspace",
	scopeRef: "ref-b",
}

type Call = { url: string; init: RequestInit }

function stubFetch(reply: (call: Call) => Response): Call[] {
	const calls: Call[] = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const call = { url, init }
			calls.push(call)
			return reply(call)
		}),
	)
	return calls
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status })

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("createProbeApi lifecycle reads as another tenant", () => {
	it("posts the handle and the reader coordinates with the bearer key and returns the parsed body", async () => {
		const calls = stubFetch(() => json({ handle: { revision: 4 } }))
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		const body = await api.lifecycleGetAs(INPUT)
		expect(body).toEqual({ handle: { revision: 4 } })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toBe(`${BASE}/v1/lifecycle/get`)
		expect(calls[0]?.init.method).toBe("POST")
		const headers = calls[0]?.init.headers as Record<string, string>
		expect(headers.Authorization).toBe(`Bearer ${KEY}`)
		expect(headers["Content-Type"]).toBe("application/json")
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			handle: INPUT.handle,
			agentId: "agent-b",
			scope: "workspace",
			scopeRef: "ref-b",
		})
		expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
	})

	it("sends history reads to the history route and forwards nothing beyond the four fields", async () => {
		const calls = stubFetch(() => json([]))
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		await api.lifecycleHistoryAs({
			...INPUT,
			extra: "must not be forwarded",
		} as LifecycleAsInput)
		expect(calls[0]?.url).toBe(`${BASE}/v1/lifecycle/history`)
		expect(Object.keys(JSON.parse(String(calls[0]?.init.body))).sort()).toEqual(
			["agentId", "handle", "scope", "scopeRef"],
		)
	})

	it("types the body as unvalidated, so a caller cannot read it as a lifecycle item", async () => {
		stubFetch(() => json({ whatever: true }))
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		const body = await api.lifecycleGetAs(INPUT)
		// @ts-expect-error an unvalidated body has no handle property
		expect(body.handle).toBeUndefined()
	})

	it("rejects with the client error for a non-success status, which observeCall turns into an http-error", async () => {
		stubFetch(() =>
			json({ error: { code: "NOT_FOUND", message: "no such record" } }, 404),
		)
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		await expect(api.lifecycleGetAs(INPUT)).rejects.toBeInstanceOf(
			MemongoClientError,
		)
		const observation = await observeCall("lifecycleGet", () =>
			api.lifecycleGetAs(INPUT),
		)
		expect(observation).toMatchObject({
			kind: "http-error",
			status: 404,
			code: "NOT_FOUND",
		})
	})

	it("rejects when a success status carries a body that is not JSON", async () => {
		stubFetch(() => new Response("<html>proxy</html>", { status: 200 }))
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		const observation = await observeCall("lifecycleGet", () =>
			api.lifecycleGetAs(INPUT),
		)
		expect(observation.kind).toBe("transport-error")
	})
})

describe("createProbeApi client methods", () => {
	it("authenticates with the generated key", async () => {
		const calls = stubFetch(() => json({ ok: true }))
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		await api.status()
		expect(calls[0]?.url).toBe(`${BASE}/v1/status`)
		expect(JSON.stringify(calls[0]?.init.headers)).toContain(KEY)
	})

	it("never retries a failing call, even one the client would normally retry", async () => {
		const calls = stubFetch(() =>
			json({ error: { code: "UNAVAILABLE", message: "down" } }, 503),
		)
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		await expect(api.status()).rejects.toBeInstanceOf(MemongoClientError)
		expect(calls).toHaveLength(1)
	})

	it("does not swallow a failing search into an empty result", async () => {
		stubFetch(() => json({ error: { code: "BOOM", message: "boom" } }, 500))
		const api = createProbeApi({ baseUrl: BASE, apiKey: KEY })
		const observation = await observeCall("search", () =>
			api.search({
				query: "q",
				agentId: "a",
				scope: "workspace",
				scopeRef: "r",
			}),
		)
		expect(observation.kind).toBe("http-error")
	})
})
