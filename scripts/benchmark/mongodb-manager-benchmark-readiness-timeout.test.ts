import { createOperationRunContext } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { setImmediate } from "node:timers/promises"
import type { Collection, Document } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"

function fixture(lane: "text" | "vector", status = "FAILED") {
	let release = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const statusRead = vi.fn(() => ({
		toArray: async () => {
			await gate
			return [{ name: "required_index", status, queryable: status === "READY" }]
		},
	}))
	const countRead = vi.fn(() => ({ toArray: async () => [{ count: 1 }] }))
	const collection = {
		find: () => ({
			toArray: async () => [{ body: "offline searchable document" }],
		}),
		aggregate: countRead,
	} as unknown as Collection<Document>
	const ops = new MongoDBManagerBenchmarkScenarioOps({
		config: { mongodb: { embeddingMode: "automated" } },
		capabilities: { textSearch: true, vectorSearch: true },
		db: { collection: () => ({ aggregate: statusRead }) },
	} as unknown as MongoDBManagerHost)
	const params = {
		agentId: "offline",
		label: "events",
		collection,
		collectionName: "events",
		indexName: "required_index",
		textPath: "body",
		requireSearchableDocuments: true,
	}
	return {
		release,
		statusRead,
		countRead,
		run: () =>
			lane === "text"
				? ops.waitForBenchmarkSearchCollectionConvergence(params)
				: ops.waitForBenchmarkVectorSearchCollectionConvergence(params),
	}
}
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe.each([
	"text",
	"vector",
] as const)("%s required benchmark readiness", (lane) => {
	it.each([
		["1", " "],
		["1", "0"],
		["1", "NaN"],
		["true", " "],
		["true", "0"],
		["true", "NaN"],
	])("strict=%s timeout=%s rejects FAILED", async (strict, value) => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", strict)
		vi.stubEnv("MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS", value)
		vi.stubEnv("MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS", value)
		const probe = fixture(lane)
		const pending = probe.run()
		let settled = false
		void pending.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		try {
			await setImmediate()
			expect(probe.statusRead).toHaveBeenCalledWith([
				{ $listSearchIndexes: {} },
			])
			expect(settled).toBe(false)
		} finally {
			probe.release()
		}
		await expect(pending).rejects.toThrow(/index-not-ready:.*FAILED/)
		expect(probe.countRead).not.toHaveBeenCalled()
	})
})

describe.each([
	"text",
	"vector",
] as const)("%s optional compatibility", (lane) => {
	it("preserves non-strict explicit zero opt-out", async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "0")
		vi.stubEnv("MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS", "0")
		vi.stubEnv("MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS", "0")
		expect(
			snapshot().settings[
				lane === "text"
					? "effectiveTextSearchSettleTimeoutMs"
					: "effectiveVectorSearchSettleTimeoutMs"
			],
		).toBe(0)
		const probe = fixture(lane)
		try {
			await probe.run()
			expect(probe.statusRead).not.toHaveBeenCalled()
			expect(probe.countRead).not.toHaveBeenCalled()
		} finally {
			probe.release()
		}
	})
	it.each([
		"",
		" ",
		"NaN",
	])("does not treat %s as an optional opt-out", async (value) => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "0")
		vi.stubEnv("MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS", value)
		vi.stubEnv("MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS", value)
		const probe = fixture(lane)
		probe.release()
		await expect(probe.run()).rejects.toThrow(/FAILED/)
		expect(probe.statusRead).toHaveBeenCalledTimes(1)
	})
})

const timingCases = [
	["text", undefined, undefined, 60000],
	["vector", undefined, undefined, 300000],
	["text", " ", undefined, 60000],
	["vector", "17", " ", 300000],
	["vector", "17", undefined, 17],
	["vector", "17", "29.5", 29.5],
	["text", "17", "29.5", 17],
	["vector", "17", "NaN", 300000],
	["vector", "17", "0", 300000],
	["text", "0", undefined, 60000],
	["vector", "0", undefined, 300000],
	["text", "NaN", undefined, 60000],
	["text", "-1", undefined, 60000],
	["vector", "17", "Infinity", 300000],
] as const

describe.each([0, 1])("actual convergence deadline +%sms", (beyond) => {
	it.each(
		timingCases,
	)("%s EVENT=%s VECTOR=%s uses %s milliseconds", async (lane, event, vector, expected) => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
		vi.stubEnv("MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS", event)
		vi.stubEnv("MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS", vector)
		expect(
			snapshot().settings[
				lane === "text"
					? "effectiveTextSearchSettleTimeoutMs"
					: "effectiveVectorSearchSettleTimeoutMs"
			],
		).toBe(expected)
		const probe = fixture(lane, "READY")
		probe.release()
		// At the exact deadline the real loop still admits convergence probes; one
		// millisecond later it refuses. This observes both bounds, not a parser.
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(1000)
			.mockReturnValue(1000 + expected + beyond)
		if (beyond) {
			await expect(probe.run()).rejects.toThrow(/convergence timed out/)
			expect(probe.countRead).not.toHaveBeenCalled()
		} else {
			await probe.run()
			expect(probe.countRead).toHaveBeenCalledTimes(lane === "text" ? 2 : 1)
		}
		expect(probe.statusRead).toHaveBeenCalledTimes(1)
	})
})

function snapshot() {
	const host = {
		config: {
			mongodb: {
				uri: "mongodb://offline.invalid",
				database: "benchmark_db",
				collectionPrefix: "benchmark_",
				deploymentProfile: "atlas-managed",
				numCandidates: 500,
				fusionMethod: "rankFusion",
				embeddingMode: "automated",
				queryEmbeddingModel: "voyage-4-lite",
				conversationEvidenceMode: "parallel",
				numDimensions: 1024,
				quantization: "none",
				cache: {
					enabled: false,
					conversationTtlSec: 300,
					kbTtlSec: 600,
					similarityThreshold: 0.92,
				},
				reranking: {
					enabled: false,
					model: "rerank-2.5",
					topN: 20,
					minScore: 0.01,
				},
				queryRewriting: {
					enabled: false,
					method: "rules",
					maxTokens: 128,
				},
				sources: {
					conversation: { enabled: true },
					reference: { enabled: true },
					structured: { enabled: true },
				},
				kb: { enabled: true },
				graph: {
					enabled: false,
					maxGraphDepth: 2,
					entityExtraction: {
						method: "regex",
						timeoutMs: 1_000,
					},
				},
				episodes: { enabled: true, minEventsForEpisode: 6 },
			},
		},
		capabilities: {
			vectorSearch: true,
			textSearch: true,
			scoreFusion: false,
			rankFusion: true,
		},
	} as unknown as MongoDBManagerHost
	return new MongoDBManagerBenchmarkScenarioOps(
		host,
	).snapshotBenchmarkRunConfiguration({
		executionProfile: "shipped",
		retrievalLane: "native",
		maxResults: 50,
		minScore: 0.01,
	})
}

it("separates blank-vector and unset-vector actual configuration hashes", () => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
	vi.stubEnv("MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS", "17")
	vi.stubEnv("MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS", " ")
	const blank = snapshot()
	vi.stubEnv("MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS", undefined)
	const unset = snapshot()
	expect(
		blank.settings["env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS"],
	).toBeNull()
	expect(
		unset.settings["env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS"],
	).toBeNull()
	expect(hashOperationRunConfiguration(blank)).not.toBe(
		hashOperationRunConfiguration(unset),
	)
	const legacy = structuredClone(blank)
	delete legacy.settings.effectiveTextSearchSettleTimeoutMs
	delete legacy.settings.effectiveVectorSearchSettleTimeoutMs
	expect(hashOperationRunConfiguration(blank)).not.toBe(
		hashOperationRunConfiguration(legacy),
	)
})

function hashOperationRunConfiguration(
	configuration: ReturnType<typeof snapshot>,
) {
	return createOperationRunContext({ runId: "offline", configuration })
		.configurationHash
}
