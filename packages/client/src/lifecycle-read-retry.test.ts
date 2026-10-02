import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemongoClient } from "./client.js"
import type { MemongoStructuredStableHandle } from "./types.js"

const handle: MemongoStructuredStableHandle = {
	family: "structured",
	id: "memory",
	agentId: "agent",
	scope: "agent",
	scopeRef: "agent",
	state: "active",
	revision: 2,
	structured: { type: "fact", key: "key" },
}
const methods = ["getLifecycleItem", "getLifecycleHistory"] as const

describe("lifecycle read retries", () => {
	beforeEach(() => vi.unstubAllGlobals())

	function prepare(statuses: number[], maxRetries = 2) {
		let attempt = 0
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			new Request(url, init)
			const status = statuses[Math.min(attempt++, statuses.length - 1)]
			return new Response(JSON.stringify({ marker: "returned" }), {
				status,
				headers: { "Content-Type": "application/json", "Retry-After": "0" },
			})
		})
		vi.stubGlobal("fetch", fetchMock)
		return {
			client: new MemongoClient({
				baseUrl: "http://127.0.0.1:3100",
				maxRetries,
			}),
			fetchMock,
		}
	}

	it.each(
		methods,
	)("retries %s on 503 with the identical unkeyed request", async (method) => {
		const { client, fetchMock } = prepare([503, 200], 1)
		const result = await client[method]({ handle })
		expect(result).toEqual({ marker: "returned" })
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const first = fetchMock.mock.calls[0]
		const second = fetchMock.mock.calls[1]
		expect(first?.[0]).toBe(
			"http://127.0.0.1:3100/v1/lifecycle/" +
				(method === "getLifecycleItem" ? "get" : "history"),
		)
		expect(second?.[0]).toBe(first?.[0])
		expect(second?.[1]?.body).toBe(first?.[1]?.body)
		expect(JSON.parse(String(first?.[1]?.body))).toEqual({ handle })
		expect(
			(first?.[1]?.headers as Record<string, string>)["Idempotency-Key"],
		).toBeUndefined()
	})

	it.each(
		methods,
	)("caps %s repeated 429 responses at maxRetries", async (method) => {
		const { client, fetchMock } = prepare([429], 2)
		await expect(client[method]({ handle })).rejects.toMatchObject({
			status: 429,
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	it.each(methods)("honors zero retries for %s", async (method) => {
		const { client, fetchMock } = prepare([503, 200], 0)
		await expect(client[method]({ handle })).rejects.toMatchObject({
			status: 503,
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it.each([
		400, 403, 404, 409, 500,
	])("does not retry unrelated HTTP %s failures", async (status) => {
		for (const method of methods) {
			const { client, fetchMock } = prepare([status, 200])
			await expect(client[method]({ handle })).rejects.toMatchObject({ status })
			expect(fetchMock).toHaveBeenCalledTimes(1)
		}
	})

	it("keeps lifecycle mutation and search POST failures unretried", async () => {
		const mutation = prepare([503, 200])
		await expect(
			mutation.client.updateLifecycleItem({
				handle,
				patch: { value: "updated" },
			}),
		).rejects.toMatchObject({ status: 503 })
		expect(mutation.fetchMock).toHaveBeenCalledTimes(1)
		const search = prepare([503, 200])
		await expect(
			search.client.search({ query: "query" }),
		).rejects.toMatchObject({ status: 503 })
		expect(search.fetchMock).toHaveBeenCalledTimes(1)
	})
})
