import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type FetchMock,
	withFetchPreconnect,
} from "./test-helpers/fetch-mock.js"
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js"

// The SSRF guard resolves the target hostname for real (assertPublicHostname ->
// dnsLookup in @memongo/lib). A unit test must not depend on DNS: these specs
// failed with getaddrinfo ENOTFOUND example.com whenever the network or
// resolver was unavailable, which looked like a product regression and was not.
// The address below is public, so the guard's private-IP check still runs for
// real against a deterministic answer.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}))

vi.mock("@memongo/lib", async (importOriginal) => {
	const original = await importOriginal<typeof import("@memongo/lib")>()
	const { createModelAuthMockModule } = await import(
		"./test-helpers/model-auth-mock.js"
	)
	return { ...original, ...createModelAuthMockModule() }
})

const createFetchMock = () => {
	const fetchMock = vi.fn<FetchMock>(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	)
	return withFetchPreconnect(fetchMock)
}

let authModule: typeof import("@memongo/lib")
let createVoyageEmbeddingProvider: typeof import("./embeddings-voyage.js").createVoyageEmbeddingProvider
let normalizeVoyageModel: typeof import("./embeddings-voyage.js").normalizeVoyageModel

beforeEach(async () => {
	vi.useRealTimers()
	vi.doUnmock("undici")
	vi.resetModules()
	authModule = await import("@memongo/lib")
	;({ createVoyageEmbeddingProvider, normalizeVoyageModel } = await import(
		"./embeddings-voyage.js"
	))
})

function mockVoyageApiKey() {
	vi.mocked(authModule.resolveApiKeyForProvider).mockReturnValue(
		"voyage-key-123",
	)
}

async function createDefaultVoyageProvider(
	model: string,
	fetchMock: ReturnType<typeof createFetchMock>,
) {
	vi.stubGlobal("fetch", fetchMock)
	mockPublicPinnedHostname()
	mockVoyageApiKey()
	return createVoyageEmbeddingProvider({
		config: {} as never,
		provider: "voyage",
		model,
		fallback: "none",
	})
}

describe("voyage embedding provider", () => {
	afterEach(() => {
		vi.doUnmock("undici")
		vi.resetAllMocks()
		vi.unstubAllGlobals()
	})

	it("configures client with correct defaults and headers", async () => {
		const fetchMock = createFetchMock()
		const result = await createDefaultVoyageProvider(
			"voyage-4-large",
			fetchMock,
		)

		await result.provider.embedQuery("test query")

		expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith("voyage")

		const call = fetchMock.mock.calls[0]
		expect(call).toBeDefined()
		const [url, init] = call as [RequestInfo | URL, RequestInit | undefined]
		expect(url).toBe("https://api.voyageai.com/v1/embeddings")

		const headers = (init?.headers ?? {}) as Record<string, string>
		expect(headers.Authorization).toBe("Bearer voyage-key-123")
		expect(headers["Content-Type"]).toBe("application/json")

		const body = JSON.parse(init?.body as string)
		expect(body).toEqual({
			model: "voyage-4-large",
			input: ["test query"],
			input_type: "query",
		})
	})

	it("respects remote overrides for baseUrl and apiKey", async () => {
		const fetchMock = createFetchMock()
		vi.stubGlobal("fetch", fetchMock)
		mockPublicPinnedHostname()

		const result = await createVoyageEmbeddingProvider({
			config: {} as never,
			provider: "voyage",
			model: "voyage-4-lite",
			fallback: "none",
			remote: {
				baseUrl: "https://example.com",
				apiKey: "remote-override-key",
				headers: { "X-Custom": "123" },
			},
		})

		await result.provider.embedQuery("test")

		const call = fetchMock.mock.calls[0]
		expect(call).toBeDefined()
		const [url, init] = call as [RequestInfo | URL, RequestInit | undefined]
		expect(url).toBe("https://example.com/embeddings")

		const headers = (init?.headers ?? {}) as Record<string, string>
		expect(headers.Authorization).toBe("Bearer remote-override-key")
		expect(headers["X-Custom"]).toBe("123")
	})

	it("passes input_type=document for embedBatch", async () => {
		const fetchMock = withFetchPreconnect(
			vi.fn<FetchMock>(
				async (_input: RequestInfo | URL, _init?: RequestInit) =>
					new Response(
						JSON.stringify({
							data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		)
		const result = await createDefaultVoyageProvider(
			"voyage-4-large",
			fetchMock,
		)

		await result.provider.embedBatch(["doc1", "doc2"])

		const call = fetchMock.mock.calls[0]
		expect(call).toBeDefined()
		const [, init] = call as [RequestInfo | URL, RequestInit | undefined]
		const body = JSON.parse(init?.body as string)
		expect(body).toEqual({
			model: "voyage-4-large",
			input: ["doc1", "doc2"],
			input_type: "document",
		})
	})

	it("normalizes model names", async () => {
		expect(normalizeVoyageModel("voyage/voyage-large-2")).toBe("voyage-large-2")
		expect(normalizeVoyageModel("voyage-4-large")).toBe("voyage-4-large")
		expect(normalizeVoyageModel("  voyage-lite  ")).toBe("voyage-lite")
		expect(normalizeVoyageModel("")).toBe("voyage-4-large") // Default
	})
})

describe("resolveVoyageBaseUrlForKey", () => {
	it("routes Atlas Model keys to MongoDB and direct keys to Voyage", async () => {
		// Atlas Model keys (al-...) are issued by MongoDB and only valid against
		// ai.mongodb.com; sending one to Voyage's own API returns 403 — verified
		// live. The docker preview setup mandates an al- key because mongot
		// routes embeddings through ai.mongodb.com, so a deployment following
		// the shipped docs could not use this provider at all. mongodb-reranker
		// already routed on this prefix; embeddings did not.
		const { resolveVoyageBaseUrlForKey } = await import(
			"./embeddings-voyage.js"
		)
		expect(resolveVoyageBaseUrlForKey("al-example")).toBe(
			"https://ai.mongodb.com/v1",
		)
		expect(resolveVoyageBaseUrlForKey("pa-example")).toBe(
			"https://api.voyageai.com/v1",
		)
		expect(resolveVoyageBaseUrlForKey("")).toBe("https://api.voyageai.com/v1")
	})
})
