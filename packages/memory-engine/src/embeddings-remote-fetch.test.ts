import { beforeEach, describe, expect, it, vi } from "vitest"

const postJsonMock = vi.hoisted(() => vi.fn())

type EmbeddingsRemoteFetchModule = typeof import("./embeddings-remote-fetch.js")

let fetchRemoteEmbeddingVectors: EmbeddingsRemoteFetchModule["fetchRemoteEmbeddingVectors"]

describe("fetchRemoteEmbeddingVectors", () => {
	beforeEach(async () => {
		vi.resetModules()
		vi.doMock("./post-json.js", () => ({
			postJson: postJsonMock,
		}))
		;({ fetchRemoteEmbeddingVectors } = await import(
			"./embeddings-remote-fetch.js"
		))
		postJsonMock.mockReset()
	})

	it("maps remote embedding response data to sanitized unit vectors", async () => {
		postJsonMock.mockImplementationOnce(async (params) => {
			return await params.parse({
				data: [{ embedding: [3, 4] }, {}, { embedding: [0.3] }],
			})
		})

		const vectors = await fetchRemoteEmbeddingVectors({
			url: "https://memory.example/v1/embeddings",
			headers: { Authorization: "Bearer test" },
			body: { input: ["one", "two", "three"] },
			errorPrefix: "embedding fetch failed",
		})

		// P1-6 (fleet audit): the default production providers must run the
		// same sanitize+normalize path Gemini/Ollama/local already use.
		expect(vectors).toEqual([[0.6, 0.8], [], [1]])
		expect(postJsonMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://memory.example/v1/embeddings",
				headers: { Authorization: "Bearer test" },
				body: { input: ["one", "two", "three"] },
				errorPrefix: "embedding fetch failed",
				attachStatus: true,
				// P1-4: bounded by an explicit timeout, not undici's ~300 s default.
				timeoutMs: 30_000,
			}),
		)
	})

	it("zeroes non-finite provider values instead of storing them", async () => {
		postJsonMock.mockImplementationOnce(async (params) => {
			return await params.parse({
				data: [{ embedding: [Number.NaN, Number.POSITIVE_INFINITY, 2] }],
			})
		})

		const vectors = await fetchRemoteEmbeddingVectors({
			url: "https://memory.example/v1/embeddings",
			headers: {},
			body: { input: ["one"] },
			errorPrefix: "embedding fetch failed",
		})

		expect(vectors).toEqual([[0, 0, 1]])
	})

	it("retries transient provider failures", async () => {
		const rateLimited = Object.assign(
			new Error("embedding fetch failed: 429 slow down"),
			{ status: 429 },
		)
		postJsonMock
			.mockRejectedValueOnce(rateLimited)
			.mockImplementationOnce(async (params) => {
				return await params.parse({ data: [{ embedding: [1] }] })
			})

		const vectors = await fetchRemoteEmbeddingVectors({
			url: "https://memory.example/v1/embeddings",
			headers: {},
			body: { input: ["one"] },
			errorPrefix: "embedding fetch failed",
		})

		expect(vectors).toEqual([[1]])
		expect(postJsonMock).toHaveBeenCalledTimes(2)
	})

	it("throws a status-rich error on non-retryable responses without retrying", async () => {
		const forbidden = Object.assign(
			new Error("embedding fetch failed: 403 forbidden"),
			{ status: 403 },
		)
		postJsonMock.mockRejectedValue(forbidden)

		await expect(
			fetchRemoteEmbeddingVectors({
				url: "https://memory.example/v1/embeddings",
				headers: {},
				body: { input: ["one"] },
				errorPrefix: "embedding fetch failed",
			}),
		).rejects.toThrow("embedding fetch failed: 403 forbidden")
		expect(postJsonMock).toHaveBeenCalledTimes(1)
	})
})
