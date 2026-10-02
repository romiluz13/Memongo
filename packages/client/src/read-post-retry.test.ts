import { afterEach, describe, expect, it, vi } from "vitest"
import { MemongoClient } from "./client.js"
const methods = ["profile", "hydrateActiveSlate", "recallConversation"] as const
const routes = {
	profile: "profile",
	hydrateActiveSlate: "hydrate-active-slate",
	recallConversation: "recall-conversation",
}
afterEach(() => vi.unstubAllGlobals())
function prepare(statuses: number[], maxRetries = 2, silent = false) {
	let attempt = 0
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		new Request(url, init)
		const status = statuses[Math.min(attempt++, statuses.length - 1)]
		return new Response(JSON.stringify({ marker: "response" }), {
			status,
			headers: { "Content-Type": "application/json", "Retry-After": "0" },
		})
	})
	vi.stubGlobal("fetch", fetchMock)
	return {
		fetchMock,
		client: new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries,
			silent,
		}),
	}
}
describe("additional read POST retries", () => {
	it.each(
		methods,
	)("retries %s on 503 with the same unkeyed body", async (method) => {
		const { client, fetchMock } = prepare([503, 200], 1)
		expect(
			await client[method]({
				agentId: "owner",
				scope: "user",
				scopeRef: "user:rom",
			}),
		).toEqual({ marker: "response" })
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [first, second] = fetchMock.mock.calls
		expect(first[0]).toBe(`http://127.0.0.1:3100/v1/${routes[method]}`)
		expect(second[0]).toBe(first[0])
		expect(second[1]?.body).toBe(first[1]?.body)
		expect(JSON.parse(String(first[1]?.body))).toEqual({
			agentId: "owner",
			scope: "user",
			scopeRef: "user:rom",
		})
		expect(
			(first[1]?.headers as Record<string, string>)["Idempotency-Key"],
		).toBeUndefined()
	})
	it.each(methods)("caps %s 429 retries", async (method) => {
		const { client, fetchMock } = prepare([429], 2)
		await expect(client[method]({})).rejects.toMatchObject({ status: 429 })
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})
	it.each(methods)("honors zero retries for %s", async (method) => {
		const { client, fetchMock } = prepare([503, 200], 0)
		await expect(client[method]({})).rejects.toMatchObject({ status: 503 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
	it.each([
		400, 403, 404, 409, 500,
	])("does not retry HTTP %s", async (status) => {
		for (const method of methods) {
			const { client, fetchMock } = prepare([status, 200])
			await expect(client[method]({})).rejects.toMatchObject({ status })
			expect(fetchMock).toHaveBeenCalledTimes(1)
		}
	})
	it("retries silent recall before returning a successful response", async () => {
		const { client, fetchMock } = prepare([503, 200], 1, true)
		expect(await client.recallConversation({})).toEqual({ marker: "response" })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
	it("returns silent recall degradation only after retry exhaustion", async () => {
		const { client, fetchMock } = prepare([429], 1, true)
		expect(await client.recallConversation({})).toMatchObject({
			results: [],
			degradation: { kind: "throttled", status: 429 },
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
	it("does not retry opened-count reads or semantic mutations", async () => {
		const read = prepare([503, 200])
		await expect(
			read.client.readFile({ relPath: "structured:fact:key" }),
		).rejects.toMatchObject({ status: 503 })
		expect(read.fetchMock).toHaveBeenCalledTimes(1)
		const write = prepare([503, 200])
		await expect(
			write.client.writeStructured({
				entry: { type: "fact", key: "key", value: "value" },
			}),
		).rejects.toMatchObject({ status: 503 })
		expect(write.fetchMock).toHaveBeenCalledTimes(1)
	})
})
