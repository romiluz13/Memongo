import { afterEach, describe, expect, it, vi } from "vitest"
import { hasAtlasModelKey, resolvePreviewVoyageApiKey } from "./preview-env.js"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
	process.env = { ...ORIGINAL_ENV }
	vi.restoreAllMocks()
})

describe("preview-env helpers", () => {
	it("detects Atlas Model API keys by al- prefix", () => {
		expect(hasAtlasModelKey("al-example")).toBe(true)
		expect(hasAtlasModelKey("pa-example")).toBe(false)
		expect(hasAtlasModelKey("")).toBe(false)
		expect(hasAtlasModelKey(undefined)).toBe(false)
	})

	it("prefers an Atlas VOYAGE_API_KEY over rerank-only keys", () => {
		process.env.VOYAGE_API_KEY = "al-atlas-model-key"
		process.env.VOYAGE_RERANK_API_KEY = "pa-direct-rerank-key"

		expect(resolvePreviewVoyageApiKey()).toBe("al-atlas-model-key")
	})

	it("falls back to rerank or query keys when no Atlas model key is present", () => {
		process.env.VOYAGE_API_KEY = "pa-direct-provider-key"
		process.env.VOYAGE_RERANK_API_KEY = "pa-direct-rerank-key"

		expect(resolvePreviewVoyageApiKey()).toBe("pa-direct-rerank-key")

		delete process.env.VOYAGE_RERANK_API_KEY
		expect(resolvePreviewVoyageApiKey()).toBe("pa-direct-provider-key")

		delete process.env.VOYAGE_API_KEY
		process.env.VOYAGE_API_QUERY_KEY = "query-key"
		expect(resolvePreviewVoyageApiKey()).toBe("query-key")
	})
})
