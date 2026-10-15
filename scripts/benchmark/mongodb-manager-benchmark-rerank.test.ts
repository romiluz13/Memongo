import { fileURLToPath } from "node:url"
import type { MemongoConfig } from "@memongo/lib"
import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveMemoryBackendConfig } from "../../packages/memory-engine/src/backend-config.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { crossEncoderRerank } from "../../packages/memory-engine/src/mongodb-reranker.js"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import {
	createBenchmarkRunContext,
	type BenchmarkRetrievalLane,
} from "./benchmark-parity-envelope.js"
import { SYNTHETIC_FINGERPRINT_KEY } from "./benchmark-run-configuration.fixture.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"

beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_FINGERPRINT_KEY", SYNTHETIC_FINGERPRINT_KEY)
})
afterEach(() => {
	vi.unstubAllEnvs()
})

vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}))
vi.mock("../../packages/memory-engine/src/mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))

const models = [
	"rerank-3",
	"rerank-3-lite",
	"rerank-2.5",
	"rerank-2.5-lite",
] as const
function setup(model?: (typeof models)[number], topN?: number) {
	const cfg: MemongoConfig = {
		memory: {
			backend: "mongodb",
			mongodb: {
				uri: "mongodb://offline-fixture:27017/unit",
				reranking: {
					enabled: true,
					model,
					topN,
					voyageApiKey: "al-offline-fixture",
				},
			},
		},
	}
	const resolved = resolveMemoryBackendConfig({ cfg, agentId: "unit" })
	if (!resolved.mongodb) throw new Error("expected MongoDB config")
	const db = {
		command: vi.fn(async () => ({ size: 0, totalIndexSize: 0 })),
	} as unknown as Db
	const host = {
		config: resolved,
		db,
		prefix: "unit_",
		capabilities: {
			vectorSearch: true,
			textSearch: true,
			scoreFusion: false,
			rankFusion: true,
		},
	} as unknown as MongoDBManagerHost
	const ops = new MongoDBManagerBenchmarkOps(host)
	return { resolved, reranking: resolved.mongodb.reranking, db, ops }
}
async function project(
	ops: MongoDBManagerBenchmarkOps,
	lane: BenchmarkRetrievalLane = "native",
) {
	const configuration = ops.snapshotBenchmarkRunConfiguration({
		executionProfile: "shipped",
		retrievalLane: lane,
		maxResults: 50,
		minScore: 0.01,
	})
	const runContext = createBenchmarkRunContext({
		runId: "offline-parity",
		configuration,
	})
	return ops.buildBenchmarkParityBundle({
		datasetPath: fileURLToPath(import.meta.url),
		datasetKind: "longmemeval",
		retrievalLane: lane,
		latencySamples: [],
		runContext,
	})
}
async function request(fixture: ReturnType<typeof setup>) {
	const input: MemorySearchResult[] = Array.from({ length: 1_005 }, (_, i) => ({
		path: `fixture/${i}`,
		snippet: `passage ${i}`,
		score: 0.8,
		source: "conversation",
		startLine: 0,
		endLine: 1,
	}))
	const fetchFn = vi.fn(
		async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { documents: string[] }
			return new Response(
				JSON.stringify({
					data: body.documents.map((_, index) => ({
						index,
						relevance_score: 0.8,
					})),
				}),
			)
		},
	)
	const result = await crossEncoderRerank({
		db: fixture.db,
		prefix: "unit_",
		agentId: "unit",
		query: "question",
		results: input,
		config: fixture.reranking,
		fetchFn,
	})
	return { fetchFn, result, input }
}

describe("benchmark parity matches effective HTTP reranking", () => {
	it.each([
		undefined,
		...models,
	])("reports resolved model %s exactly as sent", async (model) => {
		const fixture = setup(model)
		const parity = await project(fixture.ops)
		const { fetchFn } = await request(fixture)
		const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
		expect(body.model).toBe(model ?? "rerank-3")
		expect(parity.reranker.model).toBe(body.model)
		expect(parity.runIdentity.settings.rerankerModel).toBe(body.model)
		expect(parity.runIdentity.settings.rerankerTopN).toBe(body.documents.length)
	})
	it("reports the bounded window for a typed direct resolved-config bypass", async () => {
		const fixture = setup()
		fixture.reranking.topN = 5_000
		const parity = await project(fixture.ops)
		const { fetchFn, result, input } = await request(fixture)
		const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
		expect(body.documents).toHaveLength(1_000)
		expect(body.top_k).toBe(1_000)
		expect(parity.runIdentity.settings.rerankerTopN).toBe(1_000)
		expect(result.results).toHaveLength(input.length)
		expect(fixture.reranking.topN).toBe(5_000)
	})
	it.each([
		"fractional",
		"direct zero",
	])("preserves the %s empty window", async (kind) => {
		const fixture = setup(undefined, 0.5)
		if (kind === "direct zero") fixture.reranking.topN = 0
		const parity = await project(fixture.ops)
		const { fetchFn, result, input } = await request(fixture)
		expect(parity.runIdentity.settings.rerankerTopN).toBe(0)
		expect(fetchFn).not.toHaveBeenCalled()
		expect(result.results).toBe(input)
	})
	it("retains the raw configuration zero default", async () => {
		const fixture = setup(undefined, 0)
		const parity = await project(fixture.ops)
		const { fetchFn } = await request(fixture)
		expect(parity.runIdentity.settings.rerankerTopN).toBe(20)
		expect(
			JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).documents,
		).toHaveLength(20)
	})
	it("rejects an effective configuration change before projection I/O", async () => {
		const fixture = setup()
		const configuration = fixture.ops.snapshotBenchmarkRunConfiguration({
			executionProfile: "shipped",
			retrievalLane: "native",
			maxResults: 50,
			minScore: 0.01,
		})
		const runContext = createBenchmarkRunContext({
			runId: "offline-drift",
			configuration,
		})
		fixture.reranking.topN = 30
		await expect(
			fixture.ops.buildBenchmarkParityBundle({
				datasetPath: fileURLToPath(import.meta.url),
				latencySamples: [],
				runContext,
			}),
		).rejects.toThrow("configuration changed during execution")
		expect(fixture.db.command).not.toHaveBeenCalled()
	})
	it("reports raw-session disabled/none/zero independently of host settings", async () => {
		const fixture = setup()
		fixture.reranking.topN = 5_000
		const parity = await project(fixture.ops, "raw-session")
		expect(parity.reranker).toEqual({
			model: "none",
			stage: "none",
			version: null,
		})
		expect(parity.runIdentity.settings).toEqual(
			expect.objectContaining({
				rerankerEnabled: false,
				rerankerModel: "none",
				rerankerTopN: 0,
			}),
		)
	})
})
