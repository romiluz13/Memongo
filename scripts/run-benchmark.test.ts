import { existsSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Slice C: the flow tests drive the real CLI control flow (parseArgs →
// publishable → pre-ingest gate → manager) with every external seam mocked:
// bridge manager acquisition, the benchmark ops class, the answer provider
// resolver, the quality contract, the dataset digest, the recall subprocess,
// and sample file writes. No live dataset, DB, or provider is touched.
const getManagerMock = vi.fn()
const shutdownMock = vi.fn()
vi.mock("@memongo/memory-bridge", () => ({
	memongoBridgeGetManager: (...args: unknown[]) => getManagerMock(...args),
	memongoBridgeShutdown: (...args: unknown[]) => shutdownMock(...args),
}))

const relevanceBenchmarkMock = vi.fn()
const opsConstructorMock = vi.fn()
vi.mock("./benchmark/mongodb-manager-benchmark.js", () => ({
	MongoDBManagerBenchmarkOps: class {
		constructor(...args: unknown[]) {
			opsConstructorMock(...args)
		}
		relevanceBenchmark(...args: unknown[]) {
			return relevanceBenchmarkMock(...args)
		}
	},
}))

const resolveEnrichmentProviderMock = vi.fn()
// Partial mock: resolveEnrichmentProvider is the observed answer-provider
// seam, but the module's other exports (createHttpProvider, used by the
// official judge resolver) stay real — the mock must not change which
// provider code paths exist.
vi.mock(
	"../packages/memory-engine/src/mongodb-llm-enrichment.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../packages/memory-engine/src/mongodb-llm-enrichment.js")
			>()
		return {
			...actual,
			resolveEnrichmentProvider: (
				...args: Parameters<typeof actual.resolveEnrichmentProvider>
			) => resolveEnrichmentProviderMock(...args),
		}
	},
)

const PINNED_DIGEST = "0".repeat(64)
vi.mock("./benchmark/benchmark-quality-contracts.js", () => ({
	LONGMEMEVAL_RELEASE_V2: {
		// "0".repeat(64): inline literal so the hoisted factory has no
		// outer-variable reference (vitest hoisting rule).
		datasetSha256: "0".repeat(64),
		thresholds: { contractId: "longmemeval-v2", version: "v2" },
	},
}))

import {
	assertQuestionsSubsetOfDataset,
	benchmarkJudgeConfigError,
	benchmarkOfficialFullRunError,
	customJudgeDifferenceDisclosure,
	includeBenchmarkAllowedRoot,
	main,
	officialModelDifferenceDisclosure,
	questionsCheckpointStem,
	runRecallRegressionSuite,
} from "./run-benchmark.js"

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
)
const DATASET = path.join(REPO_ROOT, "benchmarks", "data")

/** Offline deps: no dataset read, no recall subprocess, no sample file write. */
const offlineDeps = {
	readDatasetDigest: async () => PINNED_DIGEST,
	runRecallRegression: async () => ({
		status: "passed" as const,
		evidence: "stubbed recall gate (offline)",
	}),
	writeSample: async (count: number) =>
		path.join(DATASET, `longmemeval_sample_${count}.json`),
	assertQuestionsSubset: async () => {},
}

const officialJudgeEnv = {
	MEMONGO_BENCHMARK_JUDGE_API_KEY: "judge-key",
	MEMONGO_BENCHMARK_JUDGE_BASE_URL: "http://judge.local",
	MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-4o-2024-08-06",
}

/**
 * Full-run env: official protocol, pinned judge, distinct answer model, and a
 * MongoDB URI (only its presence is checked; the manager is mocked).
 */
function stubFullRunEnv(overrides: Record<string, string | undefined> = {}) {
	vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://offline-test")
	vi.stubEnv("MEMONGO_BENCHMARK_QA_PROTOCOL", "official")
	for (const [key, value] of Object.entries(officialJudgeEnv)) {
		vi.stubEnv(key, value)
	}
	vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "answer-key")
	vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "http://answer.local")
	vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "answer-model-x")
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete process.env[key]
		} else {
			vi.stubEnv(key, value)
		}
	}
}

const officialAnswerQuality = {
	answerModel: "answer-model-x",
	judge: "openai-compatible",
	judgeVersion: "gpt-4o-2024-08-06",
	accuracy: 0.5,
	judgeFalsePositiveRate: 0,
	eligibleCases: 2,
	completedCases: 2,
	official: {
		protocol: "official-anscheck",
		coverage: "full",
		overallAccuracy: 0.5,
		taskAveragedAccuracy: 0.5,
		abstentionAccuracy: null,
		abstentionCount: 0,
		perType: [],
		missingQuestionIds: [],
		lostPreCheckpointQuestionIds: [],
		accountingCompleteness: "complete",
	},
}

function officialRunResult() {
	return {
		cases: 2,
		scoredCases: 2,
		hitRate: 0.5,
		emptyRate: 0,
		p95LatencyMs: 10,
		officialMetrics: {
			longMemEval: { answerQuality: officialAnswerQuality },
		},
		benchmarkReport: {
			publicationDecision: { publishable: true },
			releaseGates: [],
			warnings: [],
		},
	}
}

describe("includeBenchmarkAllowedRoot", () => {
	it("authorizes the CLI dataset directory without replacing operator roots", () => {
		const operatorRoot = path.resolve("/operator/datasets")
		const cliRoot = path.resolve("/repo/benchmarks/data")

		const result = includeBenchmarkAllowedRoot(operatorRoot, cliRoot)

		expect(result.split(path.delimiter)).toEqual([operatorRoot, cliRoot])
		expect(includeBenchmarkAllowedRoot(result, cliRoot)).toBe(result)
	})
})

describe("benchmarkJudgeConfigError", () => {
	it("rejects a publishable run whose judge model is not configured", () => {
		const error = benchmarkJudgeConfigError({
			MEMONGO_ENRICHMENT_MODEL: "answer-model",
		})
		// The refusal message must name the missing variable so the operator
		// knows exactly what to set.
		expect(error).toContain("MEMONGO_BENCHMARK_JUDGE_MODEL")
	})

	it("rejects a judge model equal to the answer model (self-judging)", () => {
		const error = benchmarkJudgeConfigError({
			MEMONGO_ENRICHMENT_MODEL: "same-model",
			MEMONGO_BENCHMARK_JUDGE_MODEL: "same-model",
		})
		expect(error).toContain("must differ from")
	})

	it("accepts a judge model distinct from the answer model", () => {
		expect(
			benchmarkJudgeConfigError({
				MEMONGO_ENRICHMENT_MODEL: "answer-model",
				MEMONGO_BENCHMARK_JUDGE_MODEL: "judge-model",
			}),
		).toBeNull()
	})
})

describe("benchmarkOfficialFullRunError (pure pre-ingest gate)", () => {
	const base = {
		...officialJudgeEnv,
		MEMONGO_ENRICHMENT_MODEL: "answer-model-x",
	}

	it("refuses a full500 run with the protocol env unset", () => {
		const error = benchmarkOfficialFullRunError(
			{ ...base, MEMONGO_BENCHMARK_QA_PROTOCOL: undefined },
			{ checkpointDisabled: false },
		)
		expect(error).toContain(
			"full500 publishable runs require MEMONGO_BENCHMARK_QA_PROTOCOL=official",
		)
		expect(error).toContain(
			"custom-v1 judged answers are not the official protocol",
		)
	})

	it("refuses an explicit custom-v1 full500 run", () => {
		const error = benchmarkOfficialFullRunError(
			{ ...base, MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v1" },
			{ checkpointDisabled: false },
		)
		expect(error).toContain("require MEMONGO_BENCHMARK_QA_PROTOCOL=official")
	})

	it("refuses an unknown protocol value with the resolver's message", () => {
		const error = benchmarkOfficialFullRunError(
			{ ...base, MEMONGO_BENCHMARK_QA_PROTOCOL: "turbo" },
			{ checkpointDisabled: false },
		)
		expect(error).toContain('must be "official" or "custom-v1", got "turbo"')
	})

	it("refuses --no-checkpoint with the official preflight wording", () => {
		const error = benchmarkOfficialFullRunError(
			{ ...base, MEMONGO_BENCHMARK_QA_PROTOCOL: "official" },
			{ checkpointDisabled: true },
		)
		expect(error).toContain(
			"MEMONGO_BENCHMARK_QA_PROTOCOL=official requires checkpointPath",
		)
		expect(error).toContain("crash-safe resume")
	})

	it.each([
		[
			"MEMONGO_BENCHMARK_JUDGE_API_KEY",
			"official QA judge requires MEMONGO_BENCHMARK_JUDGE_API_KEY",
		],
		[
			"MEMONGO_BENCHMARK_JUDGE_BASE_URL",
			"official QA judge requires MEMONGO_BENCHMARK_JUDGE_BASE_URL",
		],
		[
			"MEMONGO_BENCHMARK_JUDGE_MODEL",
			"official QA judge requires MEMONGO_BENCHMARK_JUDGE_MODEL",
		],
	])("refuses official full500 with %s missing", (key, message) => {
		const error = benchmarkOfficialFullRunError(
			{
				...base,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "official",
				[key]: undefined,
			},
			{ checkpointDisabled: false },
		)
		expect(error).toContain(message)
	})

	it("refuses a judge model other than the pinned gpt-4o-2024-08-06", () => {
		const error = benchmarkOfficialFullRunError(
			{
				...base,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "official",
				MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-4o-mini",
			},
			{ checkpointDisabled: false },
		)
		expect(error).toContain(
			"official QA judge requires model gpt-4o-2024-08-06, got gpt-4o-mini",
		)
	})

	it("refuses a judge model equal to the answer model before ingest", () => {
		const error = benchmarkOfficialFullRunError(
			{
				...base,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "official",
				MEMONGO_BENCHMARK_JUDGE_MODEL: "answer-model-x",
			},
			{ checkpointDisabled: false },
		)
		expect(error).toContain(
			"official QA mode requires a judge model distinct from the answer model",
		)
		expect(error).toContain("both are answer-model-x")
	})

	it("accepts a complete official full500 configuration", () => {
		expect(
			benchmarkOfficialFullRunError(
				{ ...base, MEMONGO_BENCHMARK_QA_PROTOCOL: "official" },
				{ checkpointDisabled: false },
			),
		).toBeNull()
	})

	it("accepts a complete custom-judge full500 configuration with a non-pinned judge model", () => {
		expect(
			benchmarkOfficialFullRunError(
				{
					...base,
					MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
					MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-5.6-luna",
				},
				{ checkpointDisabled: false },
			),
		).toBeNull()
	})

	it("refuses a custom-judge full500 run without checkpointPath with protocol-labeled wording", () => {
		const error = benchmarkOfficialFullRunError(
			{
				...base,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
				MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-5.6-luna",
			},
			{ checkpointDisabled: true },
		)
		expect(error).toContain(
			"MEMONGO_BENCHMARK_QA_PROTOCOL=custom-judge requires checkpointPath",
		)
		expect(error).toContain("crash-safe resume")
	})

	it.each([
		[
			"MEMONGO_BENCHMARK_JUDGE_API_KEY",
			"custom-judge QA judge requires MEMONGO_BENCHMARK_JUDGE_API_KEY",
		],
		[
			"MEMONGO_BENCHMARK_JUDGE_BASE_URL",
			"custom-judge QA judge requires MEMONGO_BENCHMARK_JUDGE_BASE_URL",
		],
		[
			"MEMONGO_BENCHMARK_JUDGE_MODEL",
			"custom-judge QA judge requires MEMONGO_BENCHMARK_JUDGE_MODEL",
		],
	])("refuses custom-judge full500 with %s missing", (key, message) => {
		const error = benchmarkOfficialFullRunError(
			{
				...base,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
				MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-5.6-luna",
				[key]: undefined,
			},
			{ checkpointDisabled: false },
		)
		expect(error).toContain(message)
	})

	it("refuses custom-judge self-judging (judge model equal to the answer model)", () => {
		const error = benchmarkOfficialFullRunError(
			{
				...base,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
				MEMONGO_BENCHMARK_JUDGE_MODEL: "answer-model-x",
			},
			{ checkpointDisabled: false },
		)
		expect(error).toContain(
			"custom-judge QA mode requires a judge model distinct from the answer model",
		)
		expect(error).toContain("both are answer-model-x")
	})
})

describe("officialModelDifferenceDisclosure (C3)", () => {
	it("returns null when the run has no official QA summary", () => {
		expect(
			officialModelDifferenceDisclosure({
				answerModel: "answer-model-x",
			}),
		).toBeNull()
	})

	it("names both models and the not-identical-model caveat exactly", () => {
		const disclosure = officialModelDifferenceDisclosure(officialAnswerQuality)
		expect(disclosure).toContain("answer-model-x")
		expect(disclosure).toContain("gpt-4o-2024-08-06")
		expect(disclosure).toContain(
			"not an identical-model head-to-head against GPT-4o-answer competitors",
		)
		expect(disclosure).toContain("judged by the pinned official judge")
	})
})

describe("customJudgeDifferenceDisclosure (custom-judge integration)", () => {
	it("returns null when the run has no customJudge QA summary", () => {
		expect(
			customJudgeDifferenceDisclosure({
				answerModel: "answer-model-x",
				official: { protocol: "official-anscheck" },
			}),
		).toBeNull()
	})

	it("names both models and never claims official provenance", () => {
		const disclosure = customJudgeDifferenceDisclosure({
			answerModel: "answer-model-x",
			customJudge: {
				protocol: "custom-judge-anscheck",
				judgeModel: "gpt-5.6-luna",
			},
		})
		expect(disclosure).toContain("answer-model-x")
		expect(disclosure).toContain("gpt-5.6-luna")
		expect(disclosure).toContain("custom-judge (non-official) run")
		expect(disclosure).toContain("NOT the official LongMemEval protocol number")
	})
})

describe("CLI control flow (parseArgs → publishable → pre-ingest gate)", () => {
	beforeEach(() => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called")
		}) as never)
		getManagerMock.mockReset()
		shutdownMock.mockReset()
		opsConstructorMock.mockReset()
		relevanceBenchmarkMock.mockReset()
		resolveEnrichmentProviderMock.mockReset()
		resolveEnrichmentProviderMock.mockReturnValue({
			name: "openai-compatible",
			model: "answer-model-x",
		})
		// main() closes the manager it acquires; the offline default needs a
		// no-op close.
		getManagerMock.mockResolvedValue({
			manager: "offline",
			close: async () => {},
		})
		relevanceBenchmarkMock.mockResolvedValue(officialRunResult())
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it("refuses a full run without the protocol env before any manager, provider, or ingest work", async () => {
		stubFullRunEnv({ MEMONGO_BENCHMARK_QA_PROTOCOL: undefined })
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})

		await expect(main([], offlineDeps)).rejects.toThrow("process.exit called")
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining(
				"full500 publishable runs require MEMONGO_BENCHMARK_QA_PROTOCOL=official",
			),
		)
		expect(getManagerMock).not.toHaveBeenCalled()
		expect(opsConstructorMock).not.toHaveBeenCalled()
		expect(relevanceBenchmarkMock).not.toHaveBeenCalled()
		expect(resolveEnrichmentProviderMock).not.toHaveBeenCalled()
	})

	it("refuses an explicit custom-v1 full run before any external work", async () => {
		stubFullRunEnv({ MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v1" })
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})

		await expect(main([], offlineDeps)).rejects.toThrow("process.exit called")
		expect(getManagerMock).not.toHaveBeenCalled()
		expect(relevanceBenchmarkMock).not.toHaveBeenCalled()
		expect(resolveEnrichmentProviderMock).not.toHaveBeenCalled()
	})

	it("refuses --no-checkpoint for a full official run before any external work", async () => {
		stubFullRunEnv()
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})

		await expect(main(["--no-checkpoint"], offlineDeps)).rejects.toThrow(
			"process.exit called",
		)
		expect(getManagerMock).not.toHaveBeenCalled()
		expect(relevanceBenchmarkMock).not.toHaveBeenCalled()
	})

	it("refuses an invalid judge model before any external work", async () => {
		stubFullRunEnv({ MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-4o-mini" })
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})

		await expect(main([], offlineDeps)).rejects.toThrow("process.exit called")
		expect(getManagerMock).not.toHaveBeenCalled()
		expect(relevanceBenchmarkMock).not.toHaveBeenCalled()
		expect(resolveEnrichmentProviderMock).not.toHaveBeenCalled()
	})

	it("a valid official full run reaches the manager with the unchanged checkpoint/resume/profile contract", async () => {
		stubFullRunEnv()
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		await main([], offlineDeps)

		expect(getManagerMock).toHaveBeenCalledTimes(1)
		expect(opsConstructorMock).toHaveBeenCalledTimes(1)
		expect(relevanceBenchmarkMock).toHaveBeenCalledTimes(1)
		const request = relevanceBenchmarkMock.mock.calls[0][0] as Record<
			string,
			unknown
		>
		expect(request.datasetPath).toBe(
			path.join(DATASET, "longmemeval_s_cleaned.json"),
		)
		expect(request.qualityThresholds).toEqual({
			contractId: "longmemeval-v2",
			version: "v2",
		})
		expect(request.checkpointPath).toBe(
			path.join(
				REPO_ROOT,
				"benchmarks",
				"results",
				"checkpoints",
				"longmemeval-full.json",
			),
		)
		expect(request.resume).toBe(false)
		expect(request.conversationRecallRegression).toEqual({
			status: "passed",
			evidence: "stubbed recall gate (offline)",
		})
		expect(process.exit).not.toHaveBeenCalled()
		// C3: human disclosure with exact model names and caveat on stdout.
		expect(consoleLog).toHaveBeenCalledWith(
			expect.stringContaining(
				"official answer model answer-model-x is judged by the pinned official judge gpt-4o-2024-08-06",
			),
		)
		expect(consoleLog).toHaveBeenCalledWith(
			expect.stringContaining(
				"not an identical-model head-to-head against GPT-4o-answer competitors",
			),
		)
	})

	it("--no-rerank disables reranking before the manager is acquired (B7)", async () => {
		stubFullRunEnv()
		// Explicit env enable: the flag must win, not just default.
		vi.stubEnv("MEMONGO_RERANKING_ENABLED", "true")
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		await main(["--no-rerank"], offlineDeps)

		// Set before the bridge resolves the manager config, so the resolved
		// config disables reranking and the manifest records the deviation.
		expect(process.env.MEMONGO_RERANKING_ENABLED).toBe("false")
		expect(getManagerMock).toHaveBeenCalledTimes(1)
		expect(relevanceBenchmarkMock).toHaveBeenCalledTimes(1)
	})

	it("leaves reranking configuration untouched without --no-rerank", async () => {
		stubFullRunEnv()
		vi.stubEnv("MEMONGO_RERANKING_ENABLED", "true")
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		await main([], offlineDeps)

		expect(process.env.MEMONGO_RERANKING_ENABLED).toBe("true")
		expect(relevanceBenchmarkMock).toHaveBeenCalledTimes(1)
	})

	it("acquires a caller-owned manager and closes it after a successful run", async () => {
		stubFullRunEnv()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		const closeSpy = vi.fn(async () => {})
		getManagerMock.mockResolvedValue({ close: closeSpy })

		await main([], offlineDeps)

		expect(getManagerMock).toHaveBeenCalledWith(undefined, {
			ownership: "owned",
		})
		expect(closeSpy).toHaveBeenCalledTimes(1)
	})

	it("closes the owned manager when the benchmark run fails", async () => {
		stubFullRunEnv()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		const closeSpy = vi.fn(async () => {})
		getManagerMock.mockResolvedValue({ close: closeSpy })
		relevanceBenchmarkMock.mockRejectedValue(new Error("benchmark failed"))

		await expect(main([], offlineDeps)).rejects.toThrow("benchmark failed")
		expect(closeSpy).toHaveBeenCalledTimes(1)
	})

	it("--json keeps stdout to the envelope and sends the disclosure to stderr", async () => {
		stubFullRunEnv()
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await main(["--json"], offlineDeps)

		const stdoutPayload = consoleLog.mock.calls
			.map((call) => call.join(" "))
			.join("\n")
		expect(stdoutPayload).toContain('"officialMetrics"')
		expect(stdoutPayload).not.toContain("identical-model head-to-head")
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining(
				"not an identical-model head-to-head against GPT-4o-answer competitors",
			),
		)
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining("gpt-4o-2024-08-06"),
		)
	})

	it("sample runs stay provider-optional and never hit the official gate", async () => {
		// Protocol unset, no judge env, no answer provider: a sample run must
		// still proceed to the (mocked) manager exactly as before Slice C.
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://offline-test")
		delete process.env.MEMONGO_BENCHMARK_QA_PROTOCOL
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		await main(["--sample", "5"], offlineDeps)

		expect(resolveEnrichmentProviderMock).not.toHaveBeenCalled()
		expect(process.exit).not.toHaveBeenCalled()
		expect(relevanceBenchmarkMock).toHaveBeenCalledTimes(1)
		const request = relevanceBenchmarkMock.mock.calls[0][0] as Record<
			string,
			unknown
		>
		expect(request.qualityThresholds).toBeUndefined()
		expect(request.checkpointPath).toBe(
			path.join(
				REPO_ROOT,
				"benchmarks",
				"results",
				"checkpoints",
				"longmemeval-sample-5.json",
			),
		)
		expect(request.resume).toBe(false)
	})

	it("--questions runs a frozen subset: no contract, maxResults 50, dedicated checkpoint", async () => {
		// B2: the frozen-subset loop. Provider-optional like sample runs (the
		// official QA path is opt-in via env and handled by the driver), but
		// the dataset is the questions file itself and maxResults must be 50
		// or recall@50 silently degenerates to recall@10.
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://offline-test")
		delete process.env.MEMONGO_BENCHMARK_QA_PROTOCOL
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		const questionsFile = path.join(
			DATASET,
			"longmemeval_b2_frozen50_dataset.json",
		)

		await main(["--questions", questionsFile], offlineDeps)

		expect(resolveEnrichmentProviderMock).not.toHaveBeenCalled()
		expect(process.exit).not.toHaveBeenCalled()
		expect(relevanceBenchmarkMock).toHaveBeenCalledTimes(1)
		const request = relevanceBenchmarkMock.mock.calls[0][0] as Record<
			string,
			unknown
		>
		expect(request.datasetPath).toBe(questionsFile)
		expect(request.qualityThresholds).toBeUndefined()
		expect(request.maxResults).toBe(50)
		expect(request.checkpointPath).toBe(
			path.join(
				REPO_ROOT,
				"benchmarks",
				"results",
				"checkpoints",
				"longmemeval-questions-b2_frozen50_dataset.json",
			),
		)
	})

	it("refuses --questions together with --sample before any external work", async () => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://offline-test")
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(
			main(["--questions", "some.json", "--sample", "5"], offlineDeps),
		).rejects.toThrow("process.exit called")
		expect(getManagerMock).not.toHaveBeenCalled()
		expect(relevanceBenchmarkMock).not.toHaveBeenCalled()
	})

	it("refuses --questions without a file path", async () => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://offline-test")
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(main(["--questions"], offlineDeps)).rejects.toThrow(
			"process.exit called",
		)
		expect(getManagerMock).not.toHaveBeenCalled()
	})

	it("questionsCheckpointStem strips the extension and the longmemeval prefix", () => {
		expect(
			questionsCheckpointStem(
				"benchmarks/data/longmemeval_b2_frozen50_dataset.json",
			),
		).toBe("b2_frozen50_dataset")
		expect(questionsCheckpointStem("benchmarks/data/frozen.json")).toBe(
			"frozen",
		)
		expect(questionsCheckpointStem("benchmarks/data/longmemeval-x.json")).toBe(
			"x",
		)
	})
})

describe("assertQuestionsSubsetOfDataset (real, against the fetched dataset)", () => {
	// The real integrity assertion reads the gitignored parent dataset; it
	// only runs where that dataset has been fetched (CI skips it).
	const datasetExists = existsSync(
		path.join(
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
			"benchmarks",
			"data",
			"longmemeval_s_cleaned.json",
		),
	)
	it.skipIf(!datasetExists)(
		"accepts the materialized frozen-50 artifact as a subset of the parent",
		async () => {
			await expect(
				assertQuestionsSubsetOfDataset(
					path.join(
						path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
						"benchmarks",
						"data",
						"longmemeval_b2_frozen50_dataset.json",
					),
				),
			).resolves.toBeUndefined()
		},
	)

	it.skipIf(!datasetExists)(
		"rejects a hand-edited subset record that keeps a valid id",
		async () => {
			const materializedPath = path.join(
				path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
				"benchmarks",
				"data",
				"longmemeval_b2_frozen50_dataset.json",
			)
			const entries = JSON.parse(
				await readFile(materializedPath, "utf8"),
			) as Array<Record<string, unknown>>
			const tampered = entries.map((entry, index) =>
				index === 0 ? { ...entry, question_type: "hand-edited" } : entry,
			)
			const dir = await mkdtemp(path.join(os.tmpdir(), "questions-integrity-"))
			const tamperedPath = path.join(dir, "hand_edited_subset.json")
			await writeFile(tamperedPath, JSON.stringify(tampered))
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit called")
			}) as never)
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {})
			try {
				await expect(
					assertQuestionsSubsetOfDataset(tamperedPath),
				).rejects.toThrow("process.exit called")
				expect(consoleError).toHaveBeenCalledWith(
					expect.stringContaining("differs from its parent dataset record"),
				)
			} finally {
				exitSpy.mockRestore()
				consoleError.mockRestore()
			}
		},
	)

	it.skipIf(!datasetExists)(
		"rejects a reordered frozen-50 file against the committed identity pin",
		async () => {
			const materializedPath = path.join(
				path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
				"benchmarks",
				"data",
				"longmemeval_b2_frozen50_dataset.json",
			)
			const entries = JSON.parse(
				await readFile(materializedPath, "utf8"),
			) as unknown[]
			// Every record is still byte-identical to its parent (the
			// deep-compare passes), but the file order — and therefore its
			// digest — no longer matches the committed pin.
			const reordered = [...entries].reverse()
			const dir = await mkdtemp(path.join(os.tmpdir(), "questions-integrity-"))
			const reorderedPath = path.join(
				dir,
				"longmemeval_b2_frozen50_dataset.json",
			)
			await writeFile(reorderedPath, JSON.stringify(reordered))
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit called")
			}) as never)
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {})
			try {
				await expect(
					assertQuestionsSubsetOfDataset(reorderedPath),
				).rejects.toThrow("process.exit called")
				expect(consoleError).toHaveBeenCalledWith(
					expect.stringContaining("does not match the committed identity pin"),
				)
			} finally {
				exitSpy.mockRestore()
				consoleError.mockRestore()
			}
		},
	)
})

describe("recall regression subprocess (real, .orchestrator exclusion)", () => {
	// Lead-reproduced blocker: the real `bunx vitest run` on the recall suite
	// also discovered broken platform-baseline copies under .orchestrator/
	// worktrees (unresolvable @memongo/lib) and exited 1 even though the live
	// 6 tests passed. The subprocess must exclude **/.orchestrator/** so the
	// LIVE suite alone decides the gate. This test runs the real subprocess —
	// no stub — against the actual repo, which still contains those copies.
	it("excludes .orchestrator copies so the live suite decides the gate", async () => {
		const result = await runRecallRegressionSuite()
		expect(result.status).toBe("passed")
		// The exclusion is contractual: the recorded evidence must show the
		// excluded invocation shape, not a bare file filter.
		expect(result.evidence).toContain("--exclude **/.orchestrator/**")
	}, 240_000)
})
