import { afterEach, describe, expect, it, vi } from "vitest"
import { MemongoClient, MemongoClientError } from "./client.js"
import type { MemongoStatusResponse } from "./types.js"

// M2 T5 (#114): there is no reranker. A rerank demand reaches the server as
// searchConfig.rerank and a 400 RERANK_UNSUPPORTED surfaces as a typed error.

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown) {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	)
	vi.stubGlobal("fetch", fetchMock)
	return fetchMock
}

const client = () =>
	new MemongoClient({ baseUrl: "http://127.0.0.1:3100", maxRetries: 0 })

describe("client rerank demand", () => {
	it("sends searchConfig.rerank and raises the typed 400", async () => {
		const fetchMock = stubFetch(400, {
			error: {
				code: "RERANK_UNSUPPORTED",
				message: "rerank is not supported",
			},
		})

		const failure = await client()
			.searchDetailed({ query: "q", searchConfig: { rerank: true } })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(MemongoClientError)
		expect(failure).toMatchObject({ status: 400, code: "RERANK_UNSUPPORTED" })
		const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
		expect(sent.searchConfig).toEqual({ rerank: true })
	})

	it("keeps the typed code in silent mode instead of an unmarked empty", async () => {
		stubFetch(400, {
			error: { code: "RERANK_UNSUPPORTED", message: "rerank is not supported" },
		})

		const response = await new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 0,
			silent: true,
		}).searchDetailed({ query: "q", searchConfig: { rerank: true } })

		expect(response.results).toEqual([])
		expect(response.degradation).toMatchObject({
			status: 400,
			code: "RERANK_UNSUPPORTED",
		})
	})

	it("types the status rerank block as unsupported by the engine and unknown on the server", async () => {
		const status: MemongoStatusResponse = {
			backend: "mongodb",
			provider: "mongodb-automated",
			custom: {
				rerank: {
					nativeRerank: { engineSupport: false, serverSupport: "unknown" },
					lane: { outcome: "not-applicable", reason: "capability-absent" },
				},
			},
		}
		stubFetch(200, status)

		const result = await client().status()

		expect(result.custom?.rerank?.nativeRerank).toEqual({
			engineSupport: false,
			serverSupport: "unknown",
		})
		expect(result.custom?.rerank?.lane).toEqual({
			outcome: "not-applicable",
			reason: "capability-absent",
		})
	})
})
