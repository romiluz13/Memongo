import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, expect } from "vitest"
import {
	BENCHMARK_STRICT_FATAL_CLASSES,
	buildCanaryRuntimeSnapshot,
	buildCanaryArtifactCaseLimits,
	computeCanaryAggregateSummary,
	computeRunShapeHash,
	deriveCanaryRunCollectionPrefix,
	deriveCanaryRunDir,
	isCanaryFatalFailureClass,
	listCompletedScenarioIndices,
	listResumableProgress,
	resolveCanaryArtifactDir,
	resolveCanaryFullMode,
	resolveCanaryHeartbeatIntervalMs,
	resolveCanaryHttpTimeoutMs,
	resolveCanaryLogLevel,
	resolveCanaryModelPreflightMode,
	resolveCanaryModelPreflightTimeoutMs,
	resolveCanaryQuestionIdFilter,
	resolveCanaryRerankEnabled,
	resolveCanaryRequireAtlasModelKey,
	resolveCanaryResumeMode,
	resolveCanaryRunIntervalMs,
	resolveCanaryRunsPerCommit,
	resolveVoyageRerankEndpoint,
	postJson,
	runVoyageRerankPreflight,
	selectStratifiedSubset,
	shouldCanaryAbort,
	writeCanaryArtifactFile,
	writeCanaryHeartbeatFile,
	writeScenarioProgress,
	type CanaryPerRunSummary,
	type RawLongMemEvalEntry,
} from "./run-longmemeval-canary.js"

function makeEntry(id: string, questionType: string): RawLongMemEvalEntry {
	return {
		question_id: id,
		question_type: questionType,
		question: `Question ${id}`,
		answer: `Answer ${id}`,
		answer_session_ids: [`session-${id}`],
	}
}

describe("selectStratifiedSubset", () => {
	it("selects up to N cases per question type with stable ordering", () => {
		const entries = [
			makeEntry("q001", "multi-session-synthesis"),
			makeEntry("q002", "multi-session-synthesis"),
			makeEntry("q003", "single-session-preference"),
		]

		const { selected, selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
		)

		// 2 per type: 2 multi-session-synthesis + 1 single-session-preference
		expect(selectedQuestionIds).toHaveLength(3)
		expect(breakdown["multi-session-synthesis"]).toBe(2)
		expect(breakdown["single-session-preference"]).toBe(1)
		// Stable order: q001 before q002
		expect(selectedQuestionIds[0]).toBe("q001")
		expect(selectedQuestionIds[1]).toBe("q002")
		expect(selected).toHaveLength(3)
	})

	it("caps at casesPerType even when more are available", () => {
		const entries = Array.from({ length: 20 }, (_, i) =>
			makeEntry(`q${String(i).padStart(3, "0")}`, "knowledge-update"),
		)

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			8,
		)

		expect(selectedQuestionIds).toHaveLength(8)
		expect(breakdown["knowledge-update"]).toBe(8)
		// First 8 by stable sort
		expect(selectedQuestionIds[0]).toBe("q000")
		expect(selectedQuestionIds[7]).toBe("q007")
	})

	it("returns empty when no entries", () => {
		const { selected, selectedQuestionIds, breakdown } = selectStratifiedSubset(
			[],
			8,
		)
		expect(selected).toHaveLength(0)
		expect(selectedQuestionIds).toHaveLength(0)
		expect(Object.keys(breakdown)).toHaveLength(0)
	})

	it("limits the total selected cases after stratified selection", () => {
		const entries = [
			makeEntry("a-001", "alpha"),
			makeEntry("a-002", "alpha"),
			makeEntry("b-001", "beta"),
		]

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
			{ totalCaseLimit: 1 },
		)

		expect(selectedQuestionIds).toEqual(["a-001"])
		expect(breakdown).toEqual({ alpha: 1 })
	})

	it("applies totalCaseLimit round-robin across question types", () => {
		const entries = [
			makeEntry("a-001", "alpha"),
			makeEntry("a-002", "alpha"),
			makeEntry("b-001", "beta"),
			makeEntry("b-002", "beta"),
			makeEntry("c-001", "gamma"),
		]

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
			{ totalCaseLimit: 3 },
		)

		expect(selectedQuestionIds).toEqual(["a-001", "b-001", "c-001"])
		expect(breakdown).toEqual({ alpha: 1, beta: 1, gamma: 1 })
	})

	it("selects exact question IDs for targeted replay", () => {
		const entries = [
			makeEntry("q001", "alpha"),
			makeEntry("q002", "beta"),
			makeEntry("q003", "beta"),
		]

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
			{ questionIds: ["q003", "q001"] },
		)

		expect(selectedQuestionIds).toEqual(["q001", "q003"])
		expect(breakdown).toEqual({ alpha: 1, beta: 1 })
	})

	it("applies totalCaseLimit to targeted replay selections", () => {
		const entries = [
			makeEntry("q001", "alpha"),
			makeEntry("q002", "beta"),
			makeEntry("q003", "beta"),
		]

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
			{ questionIds: ["q001", "q002", "q003"], totalCaseLimit: 2 },
		)

		expect(selectedQuestionIds).toEqual(["q001", "q002"])
		expect(breakdown).toEqual({ alpha: 1, beta: 1 })
	})

	it("fails targeted replay when a question ID is missing", () => {
		expect(() =>
			selectStratifiedSubset([makeEntry("q001", "alpha")], 2, {
				questionIds: ["q002"],
			}),
		).toThrow("Requested question_id")
	})

	it("groups entries with missing question_type under unknown", () => {
		const entries = [
			{
				question_id: "q001",
				question_type: "",
				question: "q?",
			} as RawLongMemEvalEntry,
		]

		const { breakdown } = selectStratifiedSubset(entries, 8)
		expect(breakdown.unknown).toBe(1)
	})

	it("produces deterministic selection across 6 question types", () => {
		const types = [
			"single-session-user",
			"single-session-preference",
			"multi-session-synthesis",
			"knowledge-update",
			"temporal-reasoning",
			"multi-session-user",
		]
		const entries: RawLongMemEvalEntry[] = []
		for (const qt of types) {
			for (let i = 0; i < 15; i++) {
				entries.push(makeEntry(`${qt}-${String(i).padStart(3, "0")}`, qt))
			}
		}

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			8,
		)

		// 8 per type * 6 types = 48
		expect(selectedQuestionIds).toHaveLength(48)
		for (const qt of types) {
			expect(breakdown[qt]).toBe(8)
		}

		// Same input always produces same output
		const { selectedQuestionIds: second } = selectStratifiedSubset(entries, 8)
		expect(second).toEqual(selectedQuestionIds)
	})
})

describe("resolveCanaryQuestionIdFilter", () => {
	it("parses inline comma-separated question IDs", () => {
		expect(
			resolveCanaryQuestionIdFilter({
				inlineQuestionIds: " q001, q002 ,, q001 ",
			}),
		).toEqual({
			questionIds: ["q001", "q002"],
			selection: { source: "env" },
		})
	})

	it("parses a JSON questionIds file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-question-ids-"))
		try {
			const file = path.join(dir, "ids.json")
			writeFileSync(file, JSON.stringify({ questionIds: ["q003", "q004"] }))

			expect(resolveCanaryQuestionIdFilter({ questionIdsFile: file })).toEqual({
				questionIds: ["q003", "q004"],
				selection: { source: "file", questionIdsFile: file },
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("parses a MemPalace-style split file with an explicit key", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "memongo-split-"))
		try {
			const file = path.join(dir, "split.json")
			writeFileSync(
				file,
				JSON.stringify({
					dev: ["dev-1"],
					held_out: ["held-1", "held-2"],
				}),
			)

			expect(
				resolveCanaryQuestionIdFilter({
					splitFile: file,
					splitKey: "held_out",
				}),
			).toEqual({
				questionIds: ["held-1", "held-2"],
				selection: { source: "split", splitFile: file, splitKey: "held_out" },
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects ambiguous question-id sources", () => {
		expect(() =>
			resolveCanaryQuestionIdFilter({
				inlineQuestionIds: "q001",
				splitFile: "/tmp/split.json",
			}),
		).toThrow("Set only one canary question-id source")
	})
})

describe("resolveCanaryHttpTimeoutMs", () => {
	it("defaults to a bounded benchmark request timeout", () => {
		expect(resolveCanaryHttpTimeoutMs(undefined)).toBe(20 * 60 * 1000)
	})

	it("accepts an explicit non-negative timeout", () => {
		expect(resolveCanaryHttpTimeoutMs("30000")).toBe(30_000)
		expect(resolveCanaryHttpTimeoutMs("0")).toBe(0)
	})

	it("rejects invalid timeout values", () => {
		expect(() => resolveCanaryHttpTimeoutMs("-1")).toThrow(
			"MEMONGO_CANARY_HTTP_TIMEOUT_MS",
		)
		expect(() => resolveCanaryHttpTimeoutMs("forever")).toThrow(
			"MEMONGO_CANARY_HTTP_TIMEOUT_MS",
		)
	})
})

describe("canary request heartbeat", () => {
	it("defaults to a 30s heartbeat and accepts zero to disable it", () => {
		expect(resolveCanaryHeartbeatIntervalMs(undefined)).toBe(30_000)
		expect(resolveCanaryHeartbeatIntervalMs("")).toBe(30_000)
		expect(resolveCanaryHeartbeatIntervalMs("0")).toBe(0)
		expect(resolveCanaryHeartbeatIntervalMs("250")).toBe(250)
	})

	it("rejects invalid heartbeat values", () => {
		expect(() => resolveCanaryHeartbeatIntervalMs("-1")).toThrow(
			"MEMONGO_CANARY_HEARTBEAT_INTERVAL_MS",
		)
		expect(() => resolveCanaryHeartbeatIntervalMs("soon")).toThrow(
			"MEMONGO_CANARY_HEARTBEAT_INTERVAL_MS",
		)
	})

	it("writes heartbeat state beside the canary artifact", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-heartbeat-"))
		try {
			const heartbeatPath = writeCanaryHeartbeatFile({
				runDir: dir,
				runId: "run-1",
				elapsedMs: 1234,
				heartbeatCount: 2,
				message: "waiting for benchmark API response",
			})
			const doc = JSON.parse(readFileSync(heartbeatPath, "utf8"))
			expect(doc).toMatchObject({
				runId: "run-1",
				elapsedMs: 1234,
				heartbeatCount: 2,
				message: "waiting for benchmark API response",
			})
			expect(typeof doc.heartbeatAt).toBe("string")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects HTTP timeouts instead of leaving the promise pending", async () => {
		const server = createServer((_req, _res) => {
			// Intentionally never respond; the client timeout must reject.
		})
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve)
		})
		const address = server.address() as AddressInfo
		let heartbeatCount = 0
		try {
			await expect(
				postJson({
					url: `http://127.0.0.1:${address.port}/benchmark`,
					payload: { ok: true },
					timeoutMs: 50,
					heartbeatIntervalMs: 10,
					onHeartbeat: () => {
						heartbeatCount += 1
					},
				}),
			).rejects.toThrow("timed out after 50ms")
			expect(heartbeatCount).toBeGreaterThan(0)
		} finally {
			await new Promise<void>((resolve) => {
				server.close(() => resolve())
			})
		}
	})
})

describe("canary model preflight", () => {
	it("defaults to enabled only in strict benchmark mode", () => {
		expect(
			resolveCanaryModelPreflightMode({
				modelPreflightEnv: undefined,
				strictEnv: "1",
			}),
		).toBe(true)
		expect(
			resolveCanaryModelPreflightMode({
				modelPreflightEnv: undefined,
				strictEnv: undefined,
			}),
		).toBe(false)
		expect(
			resolveCanaryModelPreflightMode({
				modelPreflightEnv: "0",
				strictEnv: "1",
			}),
		).toBe(false)
		expect(
			resolveCanaryModelPreflightMode({
				modelPreflightEnv: "1",
				strictEnv: undefined,
			}),
		).toBe(true)
	})

	it("skips implicit model preflight when reranking is disabled", () => {
		expect(
			resolveCanaryModelPreflightMode({
				modelPreflightEnv: undefined,
				strictEnv: "1",
				rerankEnabled: false,
			}),
		).toBe(false)
		expect(
			resolveCanaryModelPreflightMode({
				modelPreflightEnv: "1",
				strictEnv: "1",
				rerankEnabled: false,
			}),
		).toBe(true)
	})

	it("resolves rerank-off canary ablation envs", () => {
		expect(
			resolveCanaryRerankEnabled({
				rerankingEnabledEnv: "false",
				benchmarkRerankModeEnv: undefined,
			}),
		).toBe(false)
		expect(
			resolveCanaryRerankEnabled({
				rerankingEnabledEnv: "true",
				benchmarkRerankModeEnv: "raw",
			}),
		).toBe(false)
		expect(
			resolveCanaryRerankEnabled({
				rerankingEnabledEnv: "false",
				benchmarkRerankModeEnv: "rerank",
			}),
		).toBe(true)
	})

	it("routes Atlas model keys to MongoDB's rerank endpoint", () => {
		expect(resolveVoyageRerankEndpoint("al-test").url).toBe(
			"https://ai.mongodb.com/v1/rerank",
		)
		expect(resolveVoyageRerankEndpoint("al-test").keyKind).toBe("atlas-model")
		expect(resolveVoyageRerankEndpoint("pa-test").keyKind).toBe("direct-voyage")
	})

	it("requires Atlas model keys by default for MongoDB-only benchmark lanes", async () => {
		await expect(
			runVoyageRerankPreflight({
				apiKey: "pa-direct-key",
				fetchImpl: async () => new Response("{}", { status: 200 }),
			}),
		).rejects.toThrow("expected a MongoDB Atlas model API key")
		expect(resolveCanaryRequireAtlasModelKey(undefined)).toBe(true)
		expect(resolveCanaryRequireAtlasModelKey("0")).toBe(false)
	})

	it("fails without leaking credentials when rerank rejects the key", async () => {
		await expect(
			runVoyageRerankPreflight({
				apiKey: "al-secret-test-key",
				fetchImpl: async () => new Response("unauthorized", { status: 401 }),
			}),
		).rejects.toThrow("HTTP 401")
		await expect(
			runVoyageRerankPreflight({
				apiKey: "al-secret-test-key",
				fetchImpl: async () => new Response("unauthorized", { status: 401 }),
			}),
		).rejects.not.toThrow("al-secret-test-key")
	})

	it("accepts a successful rerank probe", async () => {
		const result = await runVoyageRerankPreflight({
			apiKey: "al-test-key",
			fetchImpl: async () => new Response("{}", { status: 200 }),
		})

		expect(result.status).toBe(200)
		expect(result.keyKind).toBe("atlas-model")
	})

	it("validates model preflight timeout", () => {
		expect(resolveCanaryModelPreflightTimeoutMs(undefined)).toBe(5000)
		expect(resolveCanaryModelPreflightTimeoutMs("100")).toBe(100)
		expect(() => resolveCanaryModelPreflightTimeoutMs("-1")).toThrow(
			"MEMONGO_CANARY_MODEL_PREFLIGHT_TIMEOUT_MS",
		)
	})
})

describe("MEMONGO_CANARY_* env var contract (Task 1.0)", () => {
	it("MEMONGO_CANARY_ARTIFACT_DIR overrides the default artifact root exactly", () => {
		expect(resolveCanaryArtifactDir({ runId: "abc", envDir: "/tmp/foo" })).toBe(
			"/tmp/foo",
		)
	})

	it("MEMONGO_CANARY_ARTIFACT_DIR absent falls back to default root + runId", () => {
		const out = resolveCanaryArtifactDir({
			runId: "abc",
			envDir: undefined,
			repoRoot: "/repo",
		})
		expect(out).toMatch(
			/\.claude\/cc10x\/v10\/workflows\/memongo-memory-hardening\/artifacts\/canary-runs\/abc$/,
		)
	})

	it("MEMONGO_CANARY_ARTIFACT_DIR blank string falls back to default root + runId", () => {
		const out = resolveCanaryArtifactDir({
			runId: "abc",
			envDir: "  ",
			repoRoot: "/repo",
		})
		expect(out).toMatch(/canary-runs\/abc$/)
	})

	it("MEMONGO_CANARY_FULL=1 enables full mode; anything else is false", () => {
		expect(resolveCanaryFullMode("1")).toBe(true)
		expect(resolveCanaryFullMode("0")).toBe(false)
		expect(resolveCanaryFullMode(undefined)).toBe(false)
		expect(resolveCanaryFullMode("true")).toBe(false)
		expect(resolveCanaryFullMode("")).toBe(false)
	})

	it("MEMONGO_CANARY_RESUME=1 enables resume mode; anything else is false", () => {
		expect(resolveCanaryResumeMode("1")).toBe(true)
		expect(resolveCanaryResumeMode("0")).toBe(false)
		expect(resolveCanaryResumeMode(undefined)).toBe(false)
		expect(resolveCanaryResumeMode("true")).toBe(false)
		expect(resolveCanaryResumeMode("")).toBe(false)
	})

	it("captures only safe runtime metadata for started artifacts", () => {
		const previous = {
			MEMONGO_MONGODB_COLLECTION_PREFIX:
				process.env.MEMONGO_MONGODB_COLLECTION_PREFIX,
			MEMONGO_BUILD_ID: process.env.MEMONGO_BUILD_ID,
			MEMONGO_BENCHMARK_STRICT: process.env.MEMONGO_BENCHMARK_STRICT,
			MEMONGO_STRICT_MODE: process.env.MEMONGO_STRICT_MODE,
			MEMONGO_BENCHMARK_DERIVED_WORK_MODE:
				process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE,
			MEMONGO_SESSION_EVIDENCE_MODE: process.env.MEMONGO_SESSION_EVIDENCE_MODE,
			MEMONGO_MONGODB_FUSION_METHOD: process.env.MEMONGO_MONGODB_FUSION_METHOD,
			MEMONGO_RERANKING_ENABLED: process.env.MEMONGO_RERANKING_ENABLED,
			MEMONGO_BENCHMARK_RERANK_MODE: process.env.MEMONGO_BENCHMARK_RERANK_MODE,
			MEMONGO_VOYAGE_RERANK_URL: process.env.MEMONGO_VOYAGE_RERANK_URL,
			MEMONGO_MONGODB_URI: process.env.MEMONGO_MONGODB_URI,
			VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
		}
		try {
			process.env.MEMONGO_MONGODB_COLLECTION_PREFIX = "bench_"
			process.env.MEMONGO_BUILD_ID = "build-1"
			process.env.MEMONGO_BENCHMARK_STRICT = "1"
			process.env.MEMONGO_STRICT_MODE = "1"
			process.env.MEMONGO_BENCHMARK_DERIVED_WORK_MODE = "disabled"
			process.env.MEMONGO_SESSION_EVIDENCE_MODE = "B"
			process.env.MEMONGO_MONGODB_FUSION_METHOD = "js-merge"
			process.env.MEMONGO_RERANKING_ENABLED = "false"
			process.env.MEMONGO_BENCHMARK_RERANK_MODE = "raw"
			process.env.MEMONGO_VOYAGE_RERANK_URL = "https://ai.mongodb.com/v1/rerank"
			process.env.MEMONGO_MONGODB_URI = "mongodb+srv://secret"
			process.env.VOYAGE_API_KEY = "al-secret"

			const snapshot = buildCanaryRuntimeSnapshot()
			expect(snapshot).toMatchObject({
				collectionPrefix: "bench_",
				buildId: "build-1",
				benchmarkStrict: "1",
				strictMode: "1",
				derivedWorkMode: "disabled",
				sessionEvidenceMode: "B",
				fusionMethod: "js-merge",
				rerankingEnabled: "false",
				benchmarkRerankMode: "raw",
				rerankEndpointFamily: "mongodb-atlas",
			})
			expect(JSON.stringify(snapshot)).not.toContain("secret")
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		}
	})
})

describe("writeScenarioProgress (Task 1.2)", () => {
	it("writes canary-artifact.json before the benchmark response exists", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-artifact-"))
		try {
			const artifact = {
				artifactVersion: 2,
				runId: "run-1",
				status: "started" as const,
				startedAt: "2026-05-17T00:00:00.000Z",
				datasetPath: "/tmp/dataset.json",
				datasetHash: "a".repeat(64),
				casesPerType: 1,
				totalCaseLimit: 6,
				fullMode: false,
				runShapeHash: "shape",
				totalEvaluations: 6,
				selectedQuestionIds: ["q1"],
				questionTypeBreakdown: { alpha: 1 },
			}
			const artifactPath = writeCanaryArtifactFile({
				runDir: dir,
				artifact,
			})
			const doc = JSON.parse(readFileSync(artifactPath, "utf8"))
			expect(doc.status).toBe("started")
			expect(doc.benchmarkResponse).toBeUndefined()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("writes progress/{idx}.json synchronously with the required shape", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-progress-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q-001",
				questionType: "multi-session",
				passStatus: "pass",
				failureClass: null,
				metrics: { rAt5: 1, rAt10: 1 },
				completed: true,
				runShapeHash: "deadbeef",
			})
			const p = path.join(dir, "progress", "0.json")
			expect(existsSync(p)).toBe(true)
			const doc = JSON.parse(readFileSync(p, "utf8"))
			expect(doc).toMatchObject({
				index: 0,
				questionId: "q-001",
				questionType: "multi-session",
				passStatus: "pass",
				failureClass: null,
				metrics: { rAt5: 1, rAt10: 1 },
				completed: true,
				runShapeHash: "deadbeef",
			})
			expect(typeof doc.completedAt).toBe("string")
			// ISO-8601
			expect(new Date(doc.completedAt).toISOString()).toBe(doc.completedAt)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("creates the progress directory when absent", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-progress-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 7,
				questionId: "q-007",
				questionType: "knowledge-update",
				passStatus: "fail",
				failureClass: "retrieval-miss",
				metrics: {},
				completed: true,
				runShapeHash: "h",
			})
			expect(existsSync(path.join(dir, "progress", "7.json"))).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("records failureClass when the scenario fails", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-progress-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 3,
				questionId: "q-003",
				questionType: "temporal-reasoning",
				passStatus: "fail",
				failureClass: "model-failure",
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			const doc = JSON.parse(
				readFileSync(path.join(dir, "progress", "3.json"), "utf8"),
			)
			expect(doc.passStatus).toBe("fail")
			expect(doc.failureClass).toBe("model-failure")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("persists completed=false when the bulk API exposes no per-case stream (remfix C1)", () => {
		// C1 fallback: the benchmark endpoint returns aggregates only, so the
		// bulk fan-out MUST NOT fabricate passStatus:"pass" for each scenario.
		// Writing completed:false + reason preserves honest state so resume
		// mode re-runs all scenarios until per-case streaming exists.
		const dir = mkdtempSync(path.join(tmpdir(), "canary-progress-c1-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q-000",
				questionType: "multi-session",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: false,
				reason: "bulk-api-no-per-case-stream-yet",
				runShapeHash: "h",
			})
			const doc = JSON.parse(
				readFileSync(path.join(dir, "progress", "0.json"), "utf8"),
			)
			expect(doc.completed).toBe(false)
			expect(doc.reason).toBe("bulk-api-no-per-case-stream-yet")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("resume semantics (Task 1.7)", () => {
	it("returns empty when progress/ directory is missing", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-empty-"))
		try {
			expect(listCompletedScenarioIndices(dir)).toEqual(new Set())
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("returns empty when progress/ is present but has no progress files", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-blank-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q0",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			// Then clear out the file to simulate an empty dir
			rmSync(path.join(dir, "progress", "0.json"))
			expect(listCompletedScenarioIndices(dir)).toEqual(new Set())
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("enumerates integer indices from progress/{idx}.json files", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-enum-"))
		try {
			for (const idx of [0, 1, 3, 7]) {
				writeScenarioProgress({
					runDir: dir,
					index: idx,
					questionId: `q${idx}`,
					questionType: "t",
					passStatus: "pass",
					failureClass: null,
					metrics: null,
					completed: true,
					runShapeHash: "h",
				})
			}
			expect(listCompletedScenarioIndices(dir)).toEqual(new Set([0, 1, 3, 7]))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("ignores non-matching files and non-integer names", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-mixed-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 2,
				questionId: "q2",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			// Plant a garbage file in progress/
			const progressDir = path.join(dir, "progress")
			writeScenarioProgress({
				runDir: dir,
				index: 4,
				questionId: "q4",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			// Extra noise files
			require("node:fs").writeFileSync(
				path.join(progressDir, "notes.txt"),
				"ignore me",
			)
			require("node:fs").writeFileSync(
				path.join(progressDir, "q-weird.json"),
				"{}",
			)
			expect(listCompletedScenarioIndices(dir)).toEqual(new Set([2, 4]))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("only counts progress files where completed===true (remfix C1/H2)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-completed-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q0",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			writeScenarioProgress({
				runDir: dir,
				index: 1,
				questionId: "q1",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: false,
				reason: "bulk-api-no-per-case-stream-yet",
				runShapeHash: "h",
			})
			// listCompletedScenarioIndices is kept for Task 1.7 back-compat, but
			// MUST NOT count completed:false as complete.
			expect(listCompletedScenarioIndices(dir)).toEqual(new Set([0]))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("remfix H1/H2: listResumableProgress + runShapeHash", () => {
	it("computeRunShapeHash is stable across canonical input ordering (H1)", () => {
		const a = computeRunShapeHash({
			casesPerType: 8,
			totalCaseLimit: null,
			questionIds: ["q-003", "q-001", "q-002"],
			fullMode: false,
		})
		const b = computeRunShapeHash({
			casesPerType: 8,
			totalCaseLimit: null,
			questionIds: ["q-001", "q-002", "q-003"],
			fullMode: false,
		})
		// Different question ordering must still produce the same hash (the
		// shape is the same; the order is an accident of stratified sort).
		expect(a).toBe(b)
		expect(a).toMatch(/^[0-9a-f]{64}$/)
	})

	it("computeRunShapeHash changes when any shape input changes (H1)", () => {
		const base = computeRunShapeHash({
			casesPerType: 8,
			totalCaseLimit: null,
			questionIds: ["q1"],
			fullMode: false,
		})
		expect(
			computeRunShapeHash({
				casesPerType: 1,
				totalCaseLimit: null,
				questionIds: ["q1"],
				fullMode: false,
			}),
		).not.toBe(base)
		expect(
			computeRunShapeHash({
				casesPerType: 8,
				totalCaseLimit: 48,
				questionIds: ["q1"],
				fullMode: false,
			}),
		).not.toBe(base)
		expect(
			computeRunShapeHash({
				casesPerType: 8,
				totalCaseLimit: null,
				questionIds: ["q2"],
				fullMode: false,
			}),
		).not.toBe(base)
		expect(
			computeRunShapeHash({
				casesPerType: 8,
				totalCaseLimit: null,
				questionIds: ["q1"],
				fullMode: true,
			}),
		).not.toBe(base)
	})

	it("listResumableProgress skips entries whose questionId does not match current scenarios (H1)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-h1-"))
		try {
			// progress recorded for questionId=q-old at index 0
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q-old",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "h1",
			})
			// Current scenario at index 0 is a different questionId
			const result = listResumableProgress({
				runDir: dir,
				scenarioQuestionIds: ["q-new"],
				expectedRunShapeHash: "h1",
			})
			expect(result.aborted).toBe(false)
			expect(result.skipQuestionIds).toEqual(new Set())
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("listResumableProgress aborts when runShapeHash mismatches the existing progress (H1)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-h1-hash-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q1",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "stale-hash",
			})
			const result = listResumableProgress({
				runDir: dir,
				scenarioQuestionIds: ["q1"],
				expectedRunShapeHash: "fresh-hash",
			})
			expect(result.aborted).toBe(true)
			expect(result.abortReason).toMatch(/run shape changed/i)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("listResumableProgress re-runs scenarios whose JSON is corrupt (H2)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-h2-corrupt-"))
		try {
			const progressDir = path.join(dir, "progress")
			// Build progressDir via a legit write then scribble corrupt JSON on it.
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q0",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			writeFileSync(path.join(progressDir, "0.json"), "{not-json")
			const result = listResumableProgress({
				runDir: dir,
				scenarioQuestionIds: ["q0"],
				expectedRunShapeHash: "h",
			})
			expect(result.aborted).toBe(false)
			expect(result.skipQuestionIds).toEqual(new Set())
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("listResumableProgress re-runs scenarios whose progress file is empty (H2)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-h2-empty-"))
		try {
			const progressDir = path.join(dir, "progress")
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q0",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			writeFileSync(path.join(progressDir, "0.json"), "")
			const result = listResumableProgress({
				runDir: dir,
				scenarioQuestionIds: ["q0"],
				expectedRunShapeHash: "h",
			})
			expect(result.aborted).toBe(false)
			expect(result.skipQuestionIds).toEqual(new Set())
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("listResumableProgress re-runs scenarios whose passStatus!=pass (H2)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-h2-fail-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q0",
				questionType: "t",
				passStatus: "fail",
				failureClass: "model-failure",
				metrics: null,
				completed: true,
				runShapeHash: "h",
			})
			const result = listResumableProgress({
				runDir: dir,
				scenarioQuestionIds: ["q0"],
				expectedRunShapeHash: "h",
			})
			expect(result.aborted).toBe(false)
			expect(result.skipQuestionIds).toEqual(new Set())
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("listResumableProgress re-runs scenarios where completed:false (H2 + remfix C1 fallback)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-c1-"))
		try {
			writeScenarioProgress({
				runDir: dir,
				index: 0,
				questionId: "q0",
				questionType: "t",
				passStatus: "pass",
				failureClass: null,
				metrics: null,
				completed: false,
				reason: "bulk-api-no-per-case-stream-yet",
				runShapeHash: "h",
			})
			const result = listResumableProgress({
				runDir: dir,
				scenarioQuestionIds: ["q0"],
				expectedRunShapeHash: "h",
			})
			expect(result.aborted).toBe(false)
			expect(result.skipQuestionIds).toEqual(new Set())
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("listResumableProgress reports skip set keyed by questionId when all invariants hold (H1)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "canary-resume-h1-ok-"))
		try {
			for (const [idx, qid] of [
				[0, "q0"],
				[1, "q1"],
			] as const) {
				writeScenarioProgress({
					runDir: dir,
					index: idx,
					questionId: qid,
					questionType: "t",
					passStatus: "pass",
					failureClass: null,
					metrics: null,
					completed: true,
					runShapeHash: "h",
				})
			}
			const result = listResumableProgress({
				runDir: dir,
				scenarioQuestionIds: ["q0", "q1", "q2"],
				expectedRunShapeHash: "h",
			})
			expect(result.aborted).toBe(false)
			expect(result.skipQuestionIds).toEqual(new Set(["q0", "q1"]))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("strict-mode fail-fast (Task 1.6)", () => {
	it("7 fatal classes are all strictly inside the 9-class taxonomy", () => {
		expect(BENCHMARK_STRICT_FATAL_CLASSES).toEqual([
			"harness-timeout",
			"model-failure",
			"json-parse",
			"queue-settle-timeout",
			"probe-timeout",
			"index-not-ready",
			"scope-leak",
		])
	})

	it("retrieval-miss and unknown are NOT fatal under strict", () => {
		expect(isCanaryFatalFailureClass("retrieval-miss")).toBe(false)
		expect(isCanaryFatalFailureClass("unknown")).toBe(false)
	})

	it("all 7 classes above are fatal under strict", () => {
		for (const cls of BENCHMARK_STRICT_FATAL_CLASSES) {
			expect(isCanaryFatalFailureClass(cls)).toBe(true)
		}
	})

	it("shouldCanaryAbort returns true only when strict=1 AND class is fatal", () => {
		expect(
			shouldCanaryAbort({ strictEnv: "1", failureClass: "model-failure" }),
		).toBe(true)
		expect(
			shouldCanaryAbort({ strictEnv: "1", failureClass: "retrieval-miss" }),
		).toBe(false)
		expect(
			shouldCanaryAbort({
				strictEnv: undefined,
				failureClass: "model-failure",
			}),
		).toBe(false)
		expect(
			shouldCanaryAbort({ strictEnv: "0", failureClass: "harness-timeout" }),
		).toBe(false)
	})

	it("shouldCanaryAbort accepts strictEnv=true (case-insensitive) per convention", () => {
		expect(
			shouldCanaryAbort({ strictEnv: "true", failureClass: "model-failure" }),
		).toBe(true)
		expect(
			shouldCanaryAbort({ strictEnv: "TRUE", failureClass: "model-failure" }),
		).toBe(true)
	})
})

describe("resolveCanaryLogLevel (Task 1.1)", () => {
	it("defaults MEMONGO_LOG_LEVEL to warn unless MEMONGO_CANARY_DEBUG=1", () => {
		expect(
			resolveCanaryLogLevel({ logLevel: undefined, debug: undefined }),
		).toBe("warn")
	})

	it("MEMONGO_CANARY_DEBUG=1 upgrades log level to info", () => {
		expect(resolveCanaryLogLevel({ logLevel: undefined, debug: "1" })).toBe(
			"info",
		)
	})

	it("honors an explicit MEMONGO_LOG_LEVEL override regardless of debug", () => {
		expect(resolveCanaryLogLevel({ logLevel: "debug", debug: undefined })).toBe(
			"debug",
		)
		expect(resolveCanaryLogLevel({ logLevel: "error", debug: "1" })).toBe(
			"error",
		)
	})

	it("blank MEMONGO_LOG_LEVEL falls back to the default", () => {
		expect(resolveCanaryLogLevel({ logLevel: "  ", debug: undefined })).toBe(
			"warn",
		)
	})
})

describe("remfix H3: canary-artifact case-limit honesty in FULL mode", () => {
	it("FULL mode nulls casesPerType and totalCaseLimit (H3)", () => {
		expect(
			buildCanaryArtifactCaseLimits({
				fullMode: true,
				casesPerType: 8,
				totalCaseLimit: 48,
			}),
		).toEqual({ casesPerType: null, totalCaseLimit: null })
	})

	it("non-FULL mode preserves casesPerType and totalCaseLimit (H3)", () => {
		expect(
			buildCanaryArtifactCaseLimits({
				fullMode: false,
				casesPerType: 8,
				totalCaseLimit: 48,
			}),
		).toEqual({ casesPerType: 8, totalCaseLimit: 48 })
	})

	it("non-FULL mode preserves casesPerType with null totalCaseLimit when absent (H3)", () => {
		expect(
			buildCanaryArtifactCaseLimits({
				fullMode: false,
				casesPerType: 8,
				totalCaseLimit: undefined,
			}),
		).toEqual({ casesPerType: 8, totalCaseLimit: null })
	})
})

describe("resolveCanaryRunsPerCommit (n≥3 canary sampling discipline)", () => {
	it("defaults to 1 when MEMONGO_CANARY_RUNS_PER_COMMIT is undefined (back-compat)", () => {
		expect(resolveCanaryRunsPerCommit(undefined)).toBe(1)
	})

	it("accepts a valid positive integer", () => {
		expect(resolveCanaryRunsPerCommit("1")).toBe(1)
		expect(resolveCanaryRunsPerCommit("3")).toBe(3)
		expect(resolveCanaryRunsPerCommit("10")).toBe(10)
	})

	it("trims surrounding whitespace before parsing", () => {
		expect(resolveCanaryRunsPerCommit("  3  ")).toBe(3)
	})

	it("throws on zero — no silent fallback", () => {
		expect(() => resolveCanaryRunsPerCommit("0")).toThrow(
			/MEMONGO_CANARY_RUNS_PER_COMMIT/,
		)
	})

	it("throws on negative integers", () => {
		expect(() => resolveCanaryRunsPerCommit("-1")).toThrow(
			/MEMONGO_CANARY_RUNS_PER_COMMIT/,
		)
	})

	it("throws on NaN / non-numeric strings", () => {
		expect(() => resolveCanaryRunsPerCommit("NaN")).toThrow(
			/MEMONGO_CANARY_RUNS_PER_COMMIT/,
		)
		expect(() => resolveCanaryRunsPerCommit("three")).toThrow(
			/MEMONGO_CANARY_RUNS_PER_COMMIT/,
		)
	})

	it("throws on empty string — explicit-but-blank is not a default signal", () => {
		expect(() => resolveCanaryRunsPerCommit("")).toThrow(
			/MEMONGO_CANARY_RUNS_PER_COMMIT/,
		)
		expect(() => resolveCanaryRunsPerCommit("   ")).toThrow(
			/MEMONGO_CANARY_RUNS_PER_COMMIT/,
		)
	})

	it("throws on non-integer positives (e.g. 1.5) — integer contract is strict", () => {
		expect(() => resolveCanaryRunsPerCommit("1.5")).toThrow(
			/MEMONGO_CANARY_RUNS_PER_COMMIT/,
		)
	})
})

describe("resolveCanaryRunIntervalMs (n≥3 canary sampling discipline)", () => {
	it("defaults to 2000 when MEMONGO_CANARY_RUN_INTERVAL_MS is undefined", () => {
		expect(resolveCanaryRunIntervalMs(undefined)).toBe(2000)
	})

	it("accepts a valid non-negative integer", () => {
		expect(resolveCanaryRunIntervalMs("0")).toBe(0)
		expect(resolveCanaryRunIntervalMs("1500")).toBe(1500)
	})

	it("throws on negative values", () => {
		expect(() => resolveCanaryRunIntervalMs("-1")).toThrow(
			/MEMONGO_CANARY_RUN_INTERVAL_MS/,
		)
	})

	it("throws on NaN", () => {
		expect(() => resolveCanaryRunIntervalMs("nope")).toThrow(
			/MEMONGO_CANARY_RUN_INTERVAL_MS/,
		)
	})
})

describe("deriveCanaryRunDir / deriveCanaryRunCollectionPrefix (per-run isolation)", () => {
	it("produces a distinct run-N subdirectory for each run index", () => {
		const root = "/tmp/foo-artifacts"
		expect(deriveCanaryRunDir({ baseDir: root, runIndex: 1 })).toBe(
			"/tmp/foo-artifacts/run-1",
		)
		expect(deriveCanaryRunDir({ baseDir: root, runIndex: 2 })).toBe(
			"/tmp/foo-artifacts/run-2",
		)
		expect(deriveCanaryRunDir({ baseDir: root, runIndex: 3 })).toBe(
			"/tmp/foo-artifacts/run-3",
		)
	})

	it("never produces duplicate collection prefixes within one invocation (same basePrefix + invocation timestamp + different runIndex)", () => {
		const basePrefix = "memongo_bench_"
		const invocationTimestampMs = 1778600000000
		const prefixes = [1, 2, 3].map((runIndex) =>
			deriveCanaryRunCollectionPrefix({
				basePrefix,
				runIndex,
				invocationTimestampMs,
			}),
		)
		expect(new Set(prefixes).size).toBe(3)
		// Follow the contract: basePrefix + run${N}_${timestampMs}_
		expect(prefixes[0]).toBe(`memongo_bench_run1_${invocationTimestampMs}_`)
		expect(prefixes[1]).toBe(`memongo_bench_run2_${invocationTimestampMs}_`)
		expect(prefixes[2]).toBe(`memongo_bench_run3_${invocationTimestampMs}_`)
	})

	it("produces distinct prefixes across two different invocations (different invocation timestamps)", () => {
		const basePrefix = "memongo_bench_"
		const a = deriveCanaryRunCollectionPrefix({
			basePrefix,
			runIndex: 1,
			invocationTimestampMs: 1778600000000,
		})
		const b = deriveCanaryRunCollectionPrefix({
			basePrefix,
			runIndex: 1,
			invocationTimestampMs: 1778600005000,
		})
		expect(a).not.toBe(b)
	})

	it("rejects unsafe base prefixes", () => {
		expect(() =>
			deriveCanaryRunCollectionPrefix({
				basePrefix: "",
				runIndex: 1,
				invocationTimestampMs: 100,
			}),
		).toThrow("must start with memongo_bench_")
	})
})

describe("computeCanaryAggregateSummary (n≥3 aggregate synthesis)", () => {
	function mockRun(
		runIndex: number,
		hitRate: number,
		rAt5: number,
		rAt10: number,
		ndcgAt10: number,
		sessionAny1: number,
		turnAny1: number,
		missLedger: string[],
		caseDiagnosticsLength: number,
		artifactPath: string,
	): CanaryPerRunSummary {
		return {
			runIndex,
			hitRate,
			rAt5,
			rAt10,
			ndcgAt10,
			sessionAny1,
			turnAny1,
			missLedger,
			caseDiagnosticsLength,
			artifactPath,
		}
	}

	it("classifies verdict=DETERMINISTIC_PASS when min(hitRate)=1 and 0 deterministic misses", () => {
		const runs = [
			mockRun(1, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-1"),
			mockRun(2, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-2"),
			mockRun(3, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-3"),
		]
		const summary = computeCanaryAggregateSummary({ runs })

		expect(summary.verdict).toBe("DETERMINISTIC_PASS")
		expect(summary.gate3ExitCriteria.deterministicPass).toBe(true)
		expect(summary.gate3ExitCriteria.partialPass).toBe(false)
		expect(summary.gate3ExitCriteria.fail).toBe(false)
		expect(summary.deterministicMisses).toEqual([])
		expect(summary.varianceMisses).toEqual([])
		expect(summary.aggregate.hitRate.mean).toBe(1)
		expect(summary.aggregate.hitRate.min).toBe(1)
		expect(summary.aggregate.hitRate.max).toBe(1)
		expect(summary.aggregate.hitRate.stddev).toBe(0)
	})

	it("classifies verdict=PARTIAL_PASS when min=0.666, mean≥0.833 and ≤2 deterministic misses", () => {
		// Per contract: min(hitRate) >= 0.666 AND mean(hitRate) >= 0.833 AND |deterministicMisses| <= 2
		// 3 runs with hitRates 0.666, 1.0, 1.0 → mean=0.888 (>=0.833)
		// Miss distribution: runA has Q1, runB has [] , runC has [] → Q1 is variance-only (not deterministic)
		const runs = [
			mockRun(1, 0.666, 0.666, 0.666, 0.6, 0.666, 0.666, ["qA"], 1, "/a/run-1"),
			mockRun(2, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-2"),
			mockRun(3, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-3"),
		]
		const summary = computeCanaryAggregateSummary({ runs })

		expect(summary.verdict).toBe("PARTIAL_PASS")
		expect(summary.gate3ExitCriteria.deterministicPass).toBe(false)
		expect(summary.gate3ExitCriteria.partialPass).toBe(true)
		expect(summary.gate3ExitCriteria.fail).toBe(false)
		expect(summary.deterministicMisses).toEqual([])
		expect(summary.varianceMisses).toEqual(["qA"])
		expect(summary.aggregate.hitRate.min).toBeCloseTo(0.666, 3)
	})

	it("classifies verdict=FAIL when min(hitRate)<0.666 or deterministic misses exceed threshold", () => {
		// 3 runs all hitRate=0.5 AND all 3 misses on same qID → deterministic miss
		const runs = [
			mockRun(1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, ["qX", "qY"], 2, "/a/run-1"),
			mockRun(2, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, ["qX", "qY"], 2, "/a/run-2"),
			mockRun(3, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, ["qX", "qY"], 2, "/a/run-3"),
		]
		const summary = computeCanaryAggregateSummary({ runs })

		expect(summary.verdict).toBe("FAIL")
		expect(summary.gate3ExitCriteria.deterministicPass).toBe(false)
		expect(summary.gate3ExitCriteria.partialPass).toBe(false)
		expect(summary.gate3ExitCriteria.fail).toBe(true)
		// qX + qY present in all 3 runs → deterministic misses
		expect(summary.deterministicMisses.sort()).toEqual(["qX", "qY"])
		expect(summary.varianceMisses).toEqual([])
	})

	it("computes mean/min/max/stddev correctly across 3 runs", () => {
		const runs = [
			mockRun(1, 0.666, 0.666, 0.666, 0.6, 0.666, 0.666, [], 0, "/a/run-1"),
			mockRun(2, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-2"),
			mockRun(3, 0.833, 0.833, 0.833, 0.83, 0.833, 0.833, [], 0, "/a/run-3"),
		]
		const summary = computeCanaryAggregateSummary({ runs })

		// mean = (0.666 + 1 + 0.833)/3 = 0.833
		expect(summary.aggregate.hitRate.mean).toBeCloseTo(0.833, 3)
		expect(summary.aggregate.hitRate.min).toBe(0.666)
		expect(summary.aggregate.hitRate.max).toBe(1)
		// stddev non-zero when values vary
		expect(summary.aggregate.hitRate.stddev).toBeGreaterThan(0)
	})

	it("partitions misses into deterministic (in every run) vs variance (in some but not all)", () => {
		const runs = [
			mockRun(
				1,
				0.5,
				0.5,
				0.5,
				0.5,
				0.5,
				0.5,
				["qDET", "qVAR1"],
				2,
				"/a/run-1",
			),
			mockRun(
				2,
				0.666,
				0.666,
				0.666,
				0.6,
				0.666,
				0.666,
				["qDET"],
				1,
				"/a/run-2",
			),
			mockRun(
				3,
				0.5,
				0.5,
				0.5,
				0.5,
				0.5,
				0.5,
				["qDET", "qVAR2"],
				2,
				"/a/run-3",
			),
		]
		const summary = computeCanaryAggregateSummary({ runs })

		expect(summary.deterministicMisses).toEqual(["qDET"])
		expect(summary.varianceMisses.sort()).toEqual(["qVAR1", "qVAR2"])
	})

	it("aggregates sessionAny1 and turnAny1 with same shape as hitRate", () => {
		const runs = [
			mockRun(1, 1, 1, 1, 1, 0.8, 0.7, [], 0, "/a/run-1"),
			mockRun(2, 1, 1, 1, 1, 1, 0.9, [], 0, "/a/run-2"),
			mockRun(3, 1, 1, 1, 1, 0.9, 0.8, [], 0, "/a/run-3"),
		]
		const summary = computeCanaryAggregateSummary({ runs })

		expect(summary.aggregate.sessionAny1.mean).toBeCloseTo(0.9, 3)
		expect(summary.aggregate.sessionAny1.min).toBe(0.8)
		expect(summary.aggregate.sessionAny1.max).toBe(1)
		expect(summary.aggregate.turnAny1.mean).toBeCloseTo(0.8, 3)
		expect(summary.aggregate.turnAny1.min).toBe(0.7)
		expect(summary.aggregate.turnAny1.max).toBe(0.9)
	})

	it("throws when runs array is empty — contract requires N≥1", () => {
		expect(() => computeCanaryAggregateSummary({ runs: [] })).toThrow(
			/at least one run/i,
		)
	})

	it("classifies PARTIAL_PASS boundary: hitRate min=0.666 exactly", () => {
		const runs = [
			mockRun(1, 0.666, 0.666, 0.666, 0.6, 0.666, 0.666, ["qA"], 1, "/a/run-1"),
			mockRun(2, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-2"),
			mockRun(3, 1, 1, 1, 1, 1, 1, [], 0, "/a/run-3"),
		]
		const summary = computeCanaryAggregateSummary({ runs })
		expect(summary.verdict).toBe("PARTIAL_PASS")
	})
})
