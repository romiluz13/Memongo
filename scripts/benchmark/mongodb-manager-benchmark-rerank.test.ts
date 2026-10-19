import { fileURLToPath } from "node:url"
import type { MemongoConfig } from "@memongo/lib"
import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveMemoryBackendConfig } from "../../packages/memory-engine/src/backend-config.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
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

function setup() {
	const cfg: MemongoConfig = {
		memory: {
			backend: "mongodb",
			mongodb: { uri: "mongodb://offline-fixture:27017/unit" },
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
		requiredManifest: [
			{ name: "unit_chunks_vector" },
			{ name: "unit_chunks_text" },
		],
		deploymentFacts: { scoreFusion: false, rankFusion: true },
	} as unknown as MongoDBManagerHost
	return { ops: new MongoDBManagerBenchmarkOps(host) }
}

async function project(lane: BenchmarkRetrievalLane) {
	const { ops } = setup()
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

describe("benchmark parity records that no reranker exists (M2)", () => {
	it.each([
		"native",
		"raw-session",
	] as const)("reports a disabled reranker with no model for the %s lane", async (lane) => {
		const parity = await project(lane)
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
				rerankerApiKeyHmac: null,
			}),
		)
	})
})
