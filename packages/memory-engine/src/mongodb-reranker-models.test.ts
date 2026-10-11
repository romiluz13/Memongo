import type { Db } from "mongodb"
import type { MemongoConfig } from "@memongo/lib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import { crossEncoderRerank, type RerankConfig } from "./mongodb-reranker.js"
import type { MemorySearchResult } from "./types.js"

vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}))

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))

afterEach(() => vi.unstubAllEnvs())

const models = [
	"rerank-3",
	"rerank-3-lite",
	"rerank-2.5",
	"rerank-2.5-lite",
] as const
const db = {} as Db
function resolveConfig(model?: (typeof models)[number], topN?: number) {
	const cfg: MemongoConfig = {
		memory: {
			backend: "mongodb",
			mongodb: {
				uri: "mongodb://offline-fixture:27017/unit",
				reranking: { model, topN, voyageApiKey: "al-offline-fixture" },
			},
		},
	}
	const resolved = resolveMemoryBackendConfig({ cfg, agentId: "unit" }).mongodb
	if (!resolved) throw new Error("expected MongoDB config")
	return resolved.reranking
}
function results(count: number): MemorySearchResult[] {
	return Array.from({ length: count }, (_, i) => ({
		path: `fixture/${i}`,
		snippet: `preview ${i}`,
		text: `full passage ${i}`,
		score: 0.001,
		source: "conversation",
		startLine: 0,
		endLine: 1,
	}))
}
function successfulFetch() {
	return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { documents: string[] }
		return new Response(
			JSON.stringify({
				data: body.documents.map((_, index) => ({
					index,
					relevance_score: index === 0 ? 0.02 : 0.8,
				})),
			}),
			{ status: 200 },
		)
	})
}
function rerank(
	input: MemorySearchResult[],
	config: RerankConfig,
	fetchFn: typeof fetch,
) {
	return crossEncoderRerank({
		db,
		prefix: "unit_",
		agentId: "unit",
		query: "question",
		results: input,
		config,
		fetchFn,
	})
}

describe("HTTP rerank model and request contract", () => {
	it("defaults to rerank-3 through the real resolver and outgoing request", async () => {
		const config = resolveConfig()
		expect(config.model).toBe("rerank-3")
		const fetchFn = successfulFetch()
		await rerank(results(2), config, fetchFn)
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).model).toBe(
			"rerank-3",
		)
	})

	it.each(
		models,
	)("sends exactly the explicitly selected %s with no downgrade", async (model) => {
		const config = resolveConfig(model)
		expect(config.model).toBe(model)
		const fetchFn = successfulFetch()
		const out = await rerank(results(2), config, fetchFn)
		expect(out.reranked).toBe(true)
		expect(fetchFn).toHaveBeenCalledOnce()
		expect(fetchFn.mock.calls[0]?.[0]).toBe("https://ai.mongodb.com/v1/rerank")
		expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer al-offline-fixture",
		})
		expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).model).toBe(
			model,
		)
	})

	it.each([
		[1_001, 1_000],
		[1_500.9, 1_000],
		[1_000, 1_000],
		[3.9, 3],
		[0.5, 0],
		[0, 20],
		[-1, 20],
		[Number.NaN, 20],
		[Number.POSITIVE_INFINITY, 20],
	])("resolves topN %s to %s", (topN, expected) => {
		expect(resolveConfig(undefined, topN).topN).toBe(expected)
	})

	it.each([
		"resolved fractional",
		"direct zero",
	])("preserves an empty %s rank window without provider work", async (kind) => {
		const config =
			kind === "resolved fractional"
				? resolveConfig(undefined, 0.5)
				: { ...resolveConfig(), topN: 0 }
		expect(config.topN).toBe(0)
		const input = results(25)
		const fetchFn = successfulFetch()
		const out = await rerank(input, config, fetchFn)
		expect(fetchFn).not.toHaveBeenCalled()
		expect(out.reranked).toBe(false)
		expect(out.results).toBe(input)
	})

	it.each([
		1_001, 100_000,
	])("bounds direct topN=%s and preserves every result and partition", async (topN) => {
		const input = results(1_005)
		input[2].text = " "
		input[3].text = ""
		const config: RerankConfig = {
			...resolveConfig("rerank-3"),
			topN,
			minScore: 0.1,
			instruction: "Prefer grounded passages",
		}
		const fetchFn = successfulFetch()
		const out = await rerank(input, config, fetchFn)
		const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
		expect(body.model).toBe("rerank-3")
		expect(body.query).toBe("Prefer grounded passages\nquestion")
		expect(body.documents).toEqual(
			input
				.slice(0, 1_000)
				.filter((r) => r.text?.trim())
				.map((r) => r.text),
		)
		expect(body.documents).toHaveLength(998)
		expect(body.top_k).toBe(998)
		expect(out.reranked).toBe(true)
		if (!out.reranked) throw new Error("expected CE partitions")
		expect(out.partitions.emptySnippet).toEqual(input.slice(2, 4))
		expect(out.partitions.overflow).toEqual(input.slice(1_000))
		expect(out.partitions.below.map((r) => r.path)).toEqual([input[0].path])
		expect(out.results.map((r) => r.path).toSorted()).toEqual(
			input.map((r) => r.path).toSorted(),
		)
		expect(new Set(out.results.map((r) => r.path)).size).toBe(input.length)
		expect(out.results).toEqual([
			...out.partitions.reranked,
			...out.partitions.emptySnippet,
			...out.partitions.overflow,
			...out.partitions.below,
		])
	})

	it("sends at most 1000 documents when every direct-runtime candidate is nonempty", async () => {
		const input = results(1_005)
		const fetchFn = successfulFetch()
		const out = await rerank(
			input,
			{ ...resolveConfig(), topN: 5_000 },
			fetchFn,
		)
		const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
		expect(body.documents).toHaveLength(1_000)
		expect(body.top_k).toBe(1_000)
		expect(out.results).toHaveLength(1_005)
	})

	it.each([
		false,
		true,
	])("keeps oversized invalid-shape failure semantics (strict=%s)", async (strict) => {
		vi.stubEnv("MEMONGO_RERANK_STRICT", strict ? "1" : "0")
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "0")
		const input = results(1_005)
		const fetchFn = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ invalid: true })),
		)
		const run = rerank(input, { ...resolveConfig(), topN: 5_000 }, fetchFn)
		if (strict) await expect(run).rejects.toThrow("unexpected response shape")
		else {
			const out = await run
			expect(out.results).toBe(input)
			expect(out.reranked).toBe(false)
		}
		expect(
			JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).documents,
		).toHaveLength(1_000)
		expect(fetchFn).toHaveBeenCalledOnce()
	})
})
